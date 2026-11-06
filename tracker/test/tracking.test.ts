import { describe, expect, it } from 'vitest';
import { trackingMessage, trackingReport, trackStatus, type TrackedAccount } from '../src/domain/tracking.js';

const H = 3_600_000;
const D = 24 * H;
const since = Date.UTC(2026, 9, 31, 23); // minuit à Paris
const now = since + 9 * H; // 9 h du matin
const acc = (o: Partial<TrackedAccount>): TrackedAccount => ({ id: 1, platform: 'tiktok', handle: 'x', url: 'https://x', lastCheckedAt: since + H, lastError: null, createdAt: since - 60 * D, ...o });

describe('relevé de la nuit', () => {
  it('relu cette nuit sans erreur = ok, avec erreur = error', () => {
    expect(trackStatus(acc({}), now - D, since, now, false)).toBe('ok');
    expect(trackStatus(acc({ lastError: 'Apify: hard limit' }), now - D, since, now, false)).toBe('error');
  });
  it('compte gratuit (YouTube, connecté) pas relu cette nuit = en retard', () => {
    expect(trackStatus(acc({ platform: 'youtube', lastCheckedAt: since - 5 * H }), now - D, since, now, false)).toBe('late');
    expect(trackStatus(acc({ lastCheckedAt: since - 5 * H }), now - D, since, now, true)).toBe('late');
    // à 1 h du matin, le relevé a encore le temps
    expect(trackStatus(acc({ platform: 'youtube', lastCheckedAt: since - 5 * H }), now - D, since, since + H, false)).toBe('waiting');
  });
  it('compte payant : attend son tour, en retard seulement au-delà de son rythme + 1 jour', () => {
    expect(trackStatus(acc({ lastCheckedAt: since - 20 * H }), now - D, since, now, false)).toBe('waiting');
    expect(trackStatus(acc({ lastCheckedAt: now - 4 * D }), now - D, since, now, false)).toBe('late');
    // inactif depuis 20 jours : 1 fois par semaine
    expect(trackStatus(acc({ lastCheckedAt: now - 6 * D }), now - 20 * D, since, now, false)).toBe('waiting');
    expect(trackStatus(acc({ lastCheckedAt: now - 9 * D }), now - 20 * D, since, now, false)).toBe('late');
  });
  it('jamais relu après 3 h = never', () => {
    expect(trackStatus(acc({ lastCheckedAt: null, createdAt: now - 4 * H }), null, since, now, false)).toBe('never');
    expect(trackStatus(acc({ lastCheckedAt: null, createdAt: now - H }), null, since, now, false)).toBe('waiting');
  });
  it('rapport par réseau + message staff', () => {
    const r = trackingReport(
      [
        { ...acc({ id: 1, platform: 'youtube' }), username: 'Nono' },
        { ...acc({ id: 2, lastError: 'compte introuvable', handle: 'bad' }), username: 'Théo' },
        { ...acc({ id: 3, platform: 'instagram', lastCheckedAt: since - 20 * H }), username: 'Lina' },
      ],
      new Map([[1, now - D], [2, now - D], [3, now - D]]),
      new Set(),
      since,
      now,
    );
    expect(r.platforms.youtube).toMatchObject({ total: 1, ok: 1 });
    expect(r.platforms.tiktok).toMatchObject({ total: 1, error: 1 });
    expect(r.platforms.instagram).toMatchObject({ total: 1, waiting: 1 });
    expect(r.problems.map((p) => p.handle)).toEqual(['bad']);
    const msg = trackingMessage(r);
    expect(msg).toContain('✅ **YouTube** : 1 relu(s)');
    expect(msg).toContain('⚠️ **TikTok**');
    expect(msg).toContain('@bad (Théo) : compte introuvable');
  });
});

import { fanAccountDue, pacificMidnight, parisMidnight } from '../src/jobs/collect.js';

describe('quota YouTube épuisé', () => {
  const night = Date.UTC(2026, 10, 2, 0, 30); // 1 h 30 à Paris
  const acc = { platform: 'youtube', lastCheckedAt: night, lastError: 'YouTube channels 403: quotaExceeded', createdAt: night - 90 * D };
  it('remise à zéro à minuit heure du Pacifique = 9 h à Paris', () => {
    expect(pacificMidnight(Date.UTC(2026, 10, 2, 12))).toBe(Date.UTC(2026, 10, 2, 8));
    expect(parisMidnight(Date.UTC(2026, 10, 2, 12))).toBe(Date.UTC(2026, 10, 1, 23));
  });
  it('relu dès que le quota revient, pas avant', () => {
    expect(fanAccountDue(acc, null, parisMidnight(night + 4 * H), night + 4 * H)).toBe(false); // 5 h 30 Paris
    expect(fanAccountDue(acc, null, parisMidnight(night + 8 * H), night + 8 * H)).toBe(true); // 9 h 30 Paris
  });
});

import { needsCatchUp } from '../src/platforms/apify.js';

describe('gros posteurs (Apify)', () => {
  const last = Date.UTC(2026, 9, 30);
  it('relit tout depuis la dernière lecture si les 5 clips lus sont tous nouveaux', () => {
    expect(needsCatchUp([1, 2, 3, 4, 5].map((h) => last + h * H), 5, last)).toBe(true);
  });
  it('pas de 2e lecture sinon (un clip déjà vu, moins de 5 clips, 1re lecture)', () => {
    expect(needsCatchUp([last + H, last + 2 * H, last + 3 * H, last + 4 * H, last - H], 5, last)).toBe(false);
    expect(needsCatchUp([last + H, last + 2 * H], 5, last)).toBe(false);
    expect(needsCatchUp([1, 2, 3, 4, 5].map((h) => last + h * H), 5, null)).toBe(false);
  });
});

import { withHashtags } from '../src/platforms/apify.js';

describe('légendes Apify', () => {
  it('ajoute les hashtags rangés à part, sans doublon', () => {
    expect(withHashtags('Un hater le traite de fils de riche', ['micka', 'argent'])).toBe('Un hater le traite de fils de riche #micka #argent');
    expect(withHashtags('Tu sais si c’est la bonne ? #micka', ['micka'])).toBe('Tu sais si c’est la bonne ? #micka');
    expect(withHashtags('clip', [{ name: 'squiduu' }])).toBe('clip #squiduu');
    expect(withHashtags(undefined, [])).toBeUndefined();
  });
});

import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { collectAll } from '../src/jobs/collect.js';

describe('gros clips sortis des 5 derniers (Apify)', () => {
  it('sont relus à part et leurs vues continuent de monter', async () => {
    const repo = new Repo(openDatabase(':memory:'));
    const client = repo.upsertClient({ name: 'Micka', rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
    const clipper = repo.upsertClipper('a1', 'Arthur', Date.now(), client.id);
    repo.registerAccount({ clipperId: clipper.id, clientId: client.id, platform: 'instagram', handle: 'micka.elwu', url: 'https://www.instagram.com/micka.elwu/' });
    const now = Date.now();
    const vid = (id: string, views: number, ageDays: number) => ({ platformVideoId: id, url: `https://www.instagram.com/reel/${id}/`, views, publishedAt: now - ageDays * 86_400_000, title: '#micka' });
    let batch = [vid('big', 563_000, 6), vid('n1', 100, 1)];
    const asked: string[][] = [];
    const ig = {
      platform: 'instagram' as const,
      fetchAccount: async () => ({ videos: batch }),
      fetchVideos: async (urls: string[]) => { asked.push(urls); return urls.map((u) => vid(u.match(/reel\/(\w+)/)![1]!, 657_000, 6)); },
    };
    const fetchers = { instagram: ig, tiktok: ig, youtube: ig } as never;
    await collectAll(repo, fetchers);
    expect(asked).toEqual([]); // le gros clip est dans le lot lu : pas de 2e lecture
    batch = [vid('n2', 50, 0), vid('n1', 300, 1)]; // il est sorti des derniers lus
    await collectAll(repo, fetchers);
    expect(asked).toEqual([['https://www.instagram.com/reel/big/']]);
    const views = repo.db.prepare("SELECT views FROM videos WHERE platform_video_id = 'big'").get() as { views: number };
    expect(views.views).toBe(657_000);
  });
});
