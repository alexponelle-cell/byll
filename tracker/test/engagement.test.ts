import { describe, expect, it } from 'vitest';
import { FanRepo } from '../src/db/fans.js';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { bestSlot, clipVerdict, median, verdictMessage, weekendWindow } from '../src/domain/engagement.js';
import { AgencyService } from '../src/services/agency.js';
import { FanService } from '../src/services/fans.js';
import { momentLines } from '../src/bot/fans.js';

const DAY = 86_400_000;

describe('motivation des clippeurs : outils purs', () => {
  it('médiane, verdict des clips, meilleur créneau, fenêtre du week-end, /moments', () => {
    expect(median([1, 5, 3])).toBe(3);
    const others = [1000, 1200, 900, 1100, 1000];
    expect(clipVerdict(2500, others)).toBe('hot');
    expect(clipVerdict(200, others)).toBe('low');
    expect(clipVerdict(1000, others)).toBeNull();
    expect(clipVerdict(5000, [1000, 1000])).toBeNull(); // trop peu de clips pour comparer
    expect(verdictMessage('hot', { title: 'Mon clip', views: 2500 }, others, 0, String)).toContain('2.5×');
    // 18 h (Paris = 16 h UTC en octobre) : beaucoup plus de vues
    const at = (h: number, d: number) => Date.UTC(2026, 9, 10 + d, h - 2);
    const clips = [
      { publishedAt: at(18, 0), views: 9000 }, { publishedAt: at(19, 1), views: 8000 },
      { publishedAt: at(9, 2), views: 1000 }, { publishedAt: at(10, 3), views: 1200 },
      { publishedAt: at(12, 4), views: 900 }, { publishedAt: at(13, 5), views: 1100 },
    ];
    expect(bestSlot(clips)).toMatchObject({ from: 18, to: 21 });
    const monday = Date.UTC(2026, 9, 19, -2);
    expect(weekendWindow(monday)).toEqual({ from: monday - 54 * 3_600_000, to: monday });
    expect(momentLines('4:12 la crise de rire ; 7:30 - le clash ; un passage')).toEqual(['⏱️ **4:12** · la crise de rire', '⏱️ **7:30** · le clash', '⏱️ un passage']);
  });
});

describe('motivation des clippeurs : service', () => {
  it('récap du lundi, feedback des clips (1 fournée par jour), gagnants du défi du week-end', () => {
    const repo = new Repo(openDatabase(':memory:'));
    const fans = new FanService(repo, new FanRepo(repo.db), new AgencyService(repo), 'https://site.test/', async () => null);
    const client = repo.upsertClient({ name: 'X', rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
    fans.saveSettings({ clientId: client.id, pointsPer1000: 10, orderReview: false, accountReview: false, clipRule: false });
    const now = Date.now();
    const fan = fans.ensureFan('m1', 'Mo', now - 30 * DAY);
    fans.setAccounts(fan, { tiktok: '@mo.tt' });
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    repo.db.prepare('UPDATE accounts SET created_at = ?, verified_at = ?').run(now - 30 * DAY, now - 30 * DAY);
    const vids = Array.from({ length: 6 }, (_, i) => ({ platformVideoId: `v${i}`, views: 1000, publishedAt: now - (10 + i) * DAY }));
    repo.recordCollection(account.id, [...vids, { platformVideoId: 'hot', views: 5000, publishedAt: now - 2 * DAY }, { platformVideoId: 'w1', views: 10, publishedAt: now - 3 * DAY }], now - HOUR);
    const recap = fans.weeklyRecaps(now).find((r) => r.discordId === 'm1');
    expect(recap?.text).toContain('Ton récap de la semaine');
    const fb = fans.clipFeedback(now);
    expect(fb).toHaveLength(2);
    expect(fb.some((f) => f.text.includes('5 000'))).toBe(true);
    expect(fans.clipFeedback(now)).toHaveLength(0);
    expect(fans.weekendStats(now - 1 * DAY, now)).toHaveLength(0);
    const st = fans.weekendStats(now - 20 * DAY, now).find((w) => w.discordId === 'm1')!;
    expect(st).toMatchObject({ clips: 8, best: 5000, views: 11_010, perPlatform: { tiktok: 8, instagram: 0, youtube: 0 } });
  });
});
const HOUR = 3_600_000;

import { challengeAnnounce, challengeTarget, challengeWinners, pickChallenge, roundNice, type WeekendStat } from '../src/domain/challenges.js';

describe('défis du week-end tournants', () => {
  const st = (id: number, o: Partial<WeekendStat>): WeekendStat => ({ clipperId: id, discordId: `d${id}`, clips: 3, views: 1000, best: 500, perPlatform: { tiktok: 1, instagram: 1, youtube: 1 }, perDay: [1, 1, 1], ...o });
  it('un défi différent chaque semaine, jamais deux fois de suite', () => {
    const ids = Array.from({ length: 12 }, (_, w) => pickChallenge(w));
    expect(new Set(ids.slice(0, 6)).size).toBe(6);
    ids.slice(1).forEach((id, i) => expect(id).not.toBe(ids[i]));
  });
  it('objectif calé sur les meilleurs du serveur (Loann : bien plus haut), jamais sous le minimum', () => {
    const petit = Array.from({ length: 20 }, (_, i) => st(i, { views: 1000 * i }));
    expect(challengeTarget('cagnotte', petit)).toBe(30_000); // serveur calme : minimum
    const loann = Array.from({ length: 20 }, (_, i) => st(i, { views: 50_000 * i, clips: 4 + i }));
    expect(challengeTarget('cagnotte', loann)).toBe(850_000);
    expect(challengeTarget('marathon', loann)).toBe(21);
    expect(challengeTarget('marathon', [])).toBe(6);
    expect(roundNice(37_412)).toBe(40_000);
  });
  it('gagnants : objectif atteint, ou top 5 pour le podium ; annonce claire', () => {
    const stats = [st(1, { perDay: [2, 2, 2] }), st(2, { perDay: [3, 0, 4] }), ...Array.from({ length: 6 }, (_, i) => st(10 + i, { views: 100 * i }))];
    expect(challengeWinners('regulier', 2, stats).map((s) => s.clipperId)).toEqual([1]);
    expect(challengeWinners('podium', 5, stats)).toHaveLength(5);
    expect(challengeAnnounce('perce', 40_000, '🔥 Défi du week-end')).toContain('un clip à 40');
  });
});
