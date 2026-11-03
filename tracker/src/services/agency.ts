import type { Account, Client, Clipper, Repo, VideoRow } from '../db/repo.js';
import type { Platform } from '../domain/links.js';
import {
  computeReward,
  normalizeRewardConfig,
  type RewardBreakdown,
  type RewardConfig,
  type RewardScope,
} from '../domain/remuneration.js';
import { coaching } from '../domain/coaching.js';
import { computeScore, type ScoreBreakdown } from '../domain/score.js';
import { DAY, type Snapshot, viewsGained } from '../domain/stats.js';
import { dayKey, dayStarts, startOfDay, startOfWeek } from '../domain/time.js';

export interface AgencySettings {
  /** Objectif de posts par jour et par clipper. */
  postsPerDay: number;
  /** Vues/jour visées pour avoir la note maximale en Performance. */
  viewsPerDay: number;
  inactivityDays: number;
  dropThresholdPercent: number;
  dropMinPreviousViews: number;
}

export const DEFAULT_SETTINGS: AgencySettings = {
  postsPerDay: 2,
  viewsPerDay: 5_000,
  inactivityDays: 3,
  dropThresholdPercent: 30,
  dropMinPreviousViews: 1_000,
};

export type Preset = 'today' | '7d' | '30d' | '90d' | '180d' | '365d' | 'all' | 'custom';

export interface Range {
  from: number;
  to: number;
  preset: Preset;
  /** Période précédente de même durée (null en all-time). */
  prev: { from: number; to: number } | null;
  days: number;
}

export interface ClipperStats {
  clipper: Clipper;
  platforms: Platform[];
  views: number;
  prevViews: number | null;
  posts: number;
  prevPosts: number | null;
  activeDays: number;
  strikes: number;
  score: ScoreBreakdown;
  lastPostAt: number | null;
  inactiveDays: number;
}

export interface RankedClipper extends ClipperStats {
  rank: number;
  reward: RewardBreakdown;
  rewardSource: RewardScope | 'default';
}

const pct = (current: number, previous: number | null) =>
  previous === null || previous <= 0 ? null : Math.round(((current - previous) / previous) * 100);

/** Contexte de calcul d'une requête : met en cache les relevés et vidéos lus. */
class Ctx {
  private snaps = new Map<number, Snapshot[]>();
  constructor(
    readonly repo: Repo,
    readonly since: number,
  ) {}
  snapshots(accountId: number): Snapshot[] {
    let s = this.snaps.get(accountId);
    if (!s) {
      s = this.repo.getAccountSnapshots(accountId, this.since);
      this.snaps.set(accountId, s);
    }
    return s;
  }
}

export class AgencyService {
  constructor(
    private readonly repo: Repo,
    private readonly defaults: Partial<AgencySettings> = {},
  ) {}

  // --- Réglages ----------------------------------------------------------------

  settings(): AgencySettings {
    return { ...DEFAULT_SETTINGS, ...this.defaults, ...this.repo.getSetting<Partial<AgencySettings>>('agency', {}) };
  }

  saveSettings(patch: Partial<AgencySettings>): AgencySettings {
    const clean: Partial<AgencySettings> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AgencySettings>) {
      const v = Number(patch[key]);
      if (patch[key] !== undefined && Number.isFinite(v) && v >= 0) clean[key] = v;
    }
    this.repo.setSetting('agency', { ...this.repo.getSetting('agency', {}), ...clean });
    return this.settings();
  }

  // --- Périodes ----------------------------------------------------------------

  range(q: { preset?: string; from?: string | number; to?: string | number }, now = Date.now()): Range {
    const make = (from: number, to: number, preset: Preset, withPrev = true): Range => ({
      from,
      to,
      preset,
      prev: withPrev ? { from: from - (to - from), to: from } : null,
      days: Math.max(1, Math.round((to - from) / DAY)),
    });
    const from = Number(q.from);
    const to = Number(q.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) return make(from, to, 'custom');
    switch (q.preset) {
      case 'today':
        return make(startOfDay(now), now, 'today');
      case '30d':
      case '90d':
      case '180d':
      case '365d':
        return make(now - Number.parseInt(q.preset, 10) * DAY, now, q.preset);
      case 'all': {
        const first = this.repo.firstSnapshotAt() ?? now - DAY;
        return make(Math.min(first, now - DAY), now, 'all', false);
      }
      default:
        return make(now - 7 * DAY, now, '7d');
    }
  }

  // --- Calculs par clipper -------------------------------------------------------

  private statsFor(clipper: Clipper, range: Range, ctx: Ctx, videos: VideoRow[], now: number): ClipperStats {
    const accounts = this.repo.listAccountsForClipper(clipper.id);
    const gained = (from: number, to: number) =>
      accounts.reduce((sum, a) => sum + viewsGained(ctx.snapshots(a.id), from, to), 0);
    const mine = videos.filter((v) => v.clipperId === clipper.id);
    const inRange = mine.filter((v) => v.publishedAt! >= range.from && v.publishedAt! < range.to);
    const prevPosts = range.prev
      ? mine.filter((v) => v.publishedAt! >= range.prev!.from && v.publishedAt! < range.prev!.to).length
      : null;
    const activeDays = new Set(inRange.map((v) => dayKey(v.publishedAt!))).size;
    const strikes = this.repo.strikes(clipper.id, range.from, range.to).length;
    const views = gained(range.from, range.to);
    const settings = this.settings();
    const lastPostAt = this.repo.lastPostAt(clipper.id);
    const reference = lastPostAt ?? Math.min(clipper.createdAt, ...accounts.map((a) => a.createdAt));
    return {
      clipper,
      platforms: [...new Set(accounts.map((a) => a.platform))].sort() as Platform[],
      views,
      prevViews: range.prev ? gained(range.prev.from, range.prev.to) : null,
      posts: inRange.length,
      prevPosts,
      activeDays,
      strikes,
      score: computeScore({ days: range.days, posts: inRange.length, views, activeDays, strikes }, settings),
      lastPostAt,
      inactiveDays: Math.max(0, Math.floor((now - reference) / DAY)),
    };
  }

  rewardConfigFor(clipper: Clipper): { config: RewardConfig; source: RewardScope | 'default' } {
    const own = this.repo.getRewardRule('clipper', clipper.id);
    if (own) return { config: normalizeRewardConfig(own), source: 'clipper' };
    const agency = clipper.clientId ? this.repo.getRewardRule('client', clipper.clientId) : undefined;
    if (agency) return { config: normalizeRewardConfig(agency), source: 'client' };
    const universal = this.repo.getRewardRule('universal', 0);
    if (universal) return { config: normalizeRewardConfig(universal), source: 'universal' };
    return { config: normalizeRewardConfig({}), source: 'default' };
  }

  /** Stats + rang + rémunération de chaque clipper actif (du filtre), triés par vues. */
  ranked(range: Range, clientId?: number, now = Date.now()): RankedClipper[] {
    const clippers = this.repo.listClippers({ clientId });
    const ctx = new Ctx(this.repo, range.prev?.from ?? range.from);
    const videos = this.repo.videosPublished(range.prev?.from ?? range.from, range.to, clippers.map((c) => c.id));
    const stats = clippers.map((c) => this.statsFor(c, range, ctx, videos, now));
    stats.sort((a, b) => b.views - a.views || b.posts - a.posts);
    return stats.map((s, i) => {
      const { config, source } = this.rewardConfigFor(s.clipper);
      const reward = computeReward(
        { views: s.views, posts: s.posts, strikes: s.strikes, rank: s.views > 0 ? i + 1 : null, periodMs: range.to - range.from },
        config,
      );
      return { ...s, rank: i + 1, reward, rewardSource: source };
    });
  }

  // --- Vue Agence ----------------------------------------------------------------

  overview(range: Range, clientId?: number, now = Date.now()) {
    const rows = this.ranked(range, clientId, now);
    const settings = this.settings();
    const sum = (f: (r: RankedClipper) => number) => rows.reduce((a, r) => a + f(r), 0);
    const views = sum((r) => r.views);
    const prevViews = range.prev ? sum((r) => r.prevViews ?? 0) : null;
    const posts = sum((r) => r.posts);
    const prevPosts = range.prev ? sum((r) => r.prevPosts ?? 0) : null;
    const clients = this.repo.listClients().filter((c) => clientId === undefined || c.id === clientId);
    const revenue = Math.round(clients.reduce((a, c) => a + c.monthlyFeeCents, 0) * (range.days / 30)) / 100;
    const payout = Math.round(sum((r) => r.reward.total) * 100) / 100;

    return {
      range,
      kpis: {
        views: { value: views, deltaPercent: pct(views, prevViews), clippers: rows.length },
        posts: {
          value: posts,
          deltaPercent: pct(posts, prevPosts),
          objectivePerDay: settings.postsPerDay * rows.length,
        },
        revenue: { value: revenue, payout, margin: Math.round((revenue - payout) * 100) / 100 },
        payout: { value: payout },
      },
      series: this.series(range, rows.map((r) => r.clipper.id)),
      alerts: this.alerts(rows, range),
      leaderboard: rows.map((r) => this.rowJson(r)),
    };
  }

  rowJson(r: RankedClipper) {
    return {
      id: r.clipper.id,
      username: r.clipper.username,
      status: r.clipper.status,
      clientId: r.clipper.clientId,
      platforms: r.platforms,
      views: r.views,
      prevViews: r.prevViews,
      viewsDeltaPercent: pct(r.views, r.prevViews),
      posts: r.posts,
      prevPosts: r.prevPosts,
      activeDays: r.activeDays,
      strikes: r.strikes,
      score: r.score,
      rank: r.rank,
      reward: r.reward,
      rewardSource: r.rewardSource,
      lastPostAt: r.lastPostAt,
      inactiveDays: r.inactiveDays,
    };
  }

  alerts(rows: readonly ClipperStats[], range: Range) {
    const s = this.settings();
    const out: Array<{ clipperId: number; username: string; inactiveDays: number | null; dropPercent: number | null }> = [];
    for (const r of rows) {
      const inactive = r.inactiveDays >= s.inactivityDays ? r.inactiveDays : null;
      let drop: number | null = null;
      if (range.prev && r.prevViews !== null && r.prevViews >= s.dropMinPreviousViews) {
        const d = Math.round(((r.prevViews - r.views) / r.prevViews) * 100);
        if (d >= s.dropThresholdPercent) drop = d;
      }
      if (inactive !== null || drop !== null) {
        out.push({ clipperId: r.clipper.id, username: r.clipper.username, inactiveDays: inactive, dropPercent: drop });
      }
    }
    return out.sort((a, b) => (b.inactiveDays ?? 0) - (a.inactiveDays ?? 0) || (b.dropPercent ?? 0) - (a.dropPercent ?? 0));
  }

  /** Vues gagnées et posts publiés par jour (heure de Paris). */
  series(range: Range, clipperIds: readonly number[]) {
    const starts = dayStarts(range.from, range.to);
    if (starts.length === 0) return [];
    const ctx = new Ctx(this.repo, starts[0]!);
    const accounts: Account[] = clipperIds.flatMap((id) => this.repo.listAccountsForClipper(id));
    const videos = this.repo.videosPublished(starts[0]!, range.to, clipperIds);
    const postsByDay = new Map<string, number>();
    for (const v of videos) postsByDay.set(dayKey(v.publishedAt!), (postsByDay.get(dayKey(v.publishedAt!)) ?? 0) + 1);
    return starts.map((start, i) => {
      const end = Math.min(starts[i + 1] ?? range.to, range.to);
      return {
        day: dayKey(start + 12 * 3_600_000),
        start,
        views: accounts.reduce((sum, a) => sum + viewsGained(ctx.snapshots(a.id), Math.max(start, range.from), end), 0),
        posts: postsByDay.get(dayKey(start + 12 * 3_600_000)) ?? 0,
      };
    });
  }

  // --- Profil clipper -------------------------------------------------------------

  profile(clipperId: number, range: Range, now = Date.now()) {
    const clipper = this.repo.getClipper(clipperId);
    if (!clipper) return undefined;
    const settings = this.settings();
    // Rang + rémunération calculés dans son agence, comme sur le classement.
    const row = this.ranked(range, clipper.clientId ?? undefined, now).find((r) => r.clipper.id === clipperId);
    const ctx = new Ctx(this.repo, range.prev?.from ?? range.from);
    const stats =
      row ?? this.statsFor(clipper, range, ctx, this.repo.videosPublished(range.prev?.from ?? range.from, range.to, [clipperId]), now);
    const reward = row?.reward ?? computeReward(
      { views: stats.views, posts: stats.posts, strikes: stats.strikes, rank: null, periodMs: range.to - range.from },
      this.rewardConfigFor(clipper).config,
    );

    const videos = this.repo.videosPublished(range.from, range.to, [clipperId]);
    const feedback = this.repo.feedbackCounts(videos.map((v) => v.id));
    const series = this.series(range, [clipperId]);
    const best = series.reduce<(typeof series)[number] | null>((b, d) => (!b || d.views > b.views ? d : b), null);
    const allTime = this.range({ preset: 'all' }, now);
    const allStats = this.statsFor(
      clipper,
      allTime,
      new Ctx(this.repo, allTime.from),
      this.repo.videosPublished(allTime.from, now, [clipperId]),
      now,
    );
    const todayPosts = videos.filter((v) => v.publishedAt! >= startOfDay(now)).length;
    const accounts = this.repo.listAccountsForClipper(clipperId);

    return {
      clipper: { ...clipper, agency: clipper.clientId ? this.repo.getClient(clipper.clientId)?.name ?? null : null },
      accounts: accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        url: a.url,
        lastCheckedAt: a.lastCheckedAt,
        lastError: a.lastError,
      })),
      range,
      kpis: {
        views: stats.views,
        viewsDeltaPercent: pct(stats.views, stats.prevViews),
        posts: stats.posts,
        postsDelta: stats.prevPosts === null ? null : stats.posts - stats.prevPosts,
        postsObjectivePerDay: settings.postsPerDay,
        avgPerVideo: videos.length ? Math.round(videos.reduce((a, v) => a + v.views, 0) / videos.length) : 0,
        strikes: stats.strikes,
        due: reward.total,
      },
      reward,
      videos: videos.map((v) => ({ ...v, feedbackCount: feedback.get(v.id) ?? 0 })),
      series,
      bestDay: best && best.views > 0 ? best : null,
      activeDays: stats.activeDays,
      days: range.days,
      score: stats.score,
      insights: this.insights(stats, todayPosts, settings, range),
      coaching: this.coachingFor(clipper, accounts, now),
      strikes: this.repo.strikes(clipperId),
      summary: { score: allStats.score.total, posts: allStats.posts, views: allStats.views, strikes: allStats.strikes },
    };
  }

  /** Points forts / à travailler sur 30 jours (comparé aux clippeurs du même client). */
  private coachingFor(clipper: Clipper, accounts: Account[], now: number) {
    const from = now - 30 * DAY;
    const teamIds = clipper.clientId ? this.repo.listClippers({ clientId: clipper.clientId, includeInactive: true }).map((c) => c.id) : undefined;
    return coaching(this.repo.videosPublished(from, now, [clipper.id]), this.repo.videosPublished(from, now, teamIds), {
      postsPerDay: this.settings().postsPerDay,
      now,
      refusedClips: this.repo.refusedClipCount(clipper.id, from),
      accountErrors: accounts.filter((a) => a.active && a.lastError).map((a) => `@${a.handle} (${a.platform}) : ${readableError(a.lastError!)}`),
    });
  }

  private insights(s: ClipperStats, todayPosts: number, settings: AgencySettings, range: Range) {
    const out: Array<{ level: 'alert' | 'warn' | 'good'; title: string; text: string }> = [];
    if (todayPosts < settings.postsPerDay) {
      const missing = settings.postsPerDay - todayPosts;
      out.push({
        level: 'alert',
        title: 'Objectif posts non atteint',
        text: `${todayPosts} / ${settings.postsPerDay} aujourd'hui. Il manque ${missing} post(s) pour valider la production du jour.`,
      });
    }
    if (s.inactiveDays >= settings.inactivityDays) {
      out.push({ level: 'alert', title: 'Inactif', text: `Aucun post depuis ${s.inactiveDays} jours.` });
    }
    const delta = pct(s.views, s.prevViews);
    if (range.prev && delta !== null && delta <= -settings.dropThresholdPercent) {
      out.push({ level: 'warn', title: 'Vues en baisse', text: `${delta} % de vues par rapport à la période précédente.` });
    } else if (delta !== null && delta >= 20) {
      out.push({ level: 'good', title: 'En progression', text: `+${delta} % de vues par rapport à la période précédente.` });
    }
    if (s.score.total >= 80) out.push({ level: 'good', title: 'Excellent score', text: `Score de ${s.score.total}/100 sur la période.` });
    return out;
  }

  // --- Inspiration ----------------------------------------------------------------

  inspiration(weekOf: number, clientId?: number) {
    const from = startOfWeek(weekOf);
    const to = startOfWeek(from + 8 * DAY);
    const clipperIds = clientId === undefined ? undefined : this.repo.listClippers({ clientId, includeInactive: true }).map((c) => c.id);
    const names = new Map(this.repo.listClippers({ includeInactive: true }).map((c) => [c.id, c.username]));
    const top = (platform: Platform, f: number, t: number) =>
      this.repo.bestVideos(platform, f, t, 10, clipperIds).map((v) => ({ ...v, username: names.get(v.clipperId) ?? '?' }));
    const platforms: Platform[] = ['tiktok', 'instagram', 'youtube'];
    return {
      week: { from, to },
      isCurrentWeek: Date.now() >= from && Date.now() < to,
      weekly: Object.fromEntries(platforms.map((p) => [p, top(p, from, to)])),
      allTime: Object.fromEntries(platforms.map((p) => [p, top(p, 0, Number.MAX_SAFE_INTEGER)])),
    };
  }

  /** Meilleurs clips publiés sur la période, toutes plateformes (Vision Client). */
  topClips(range: Range, clientId?: number, limit = 12) {
    const clipperIds = clientId === undefined ? undefined : this.repo.listClippers({ clientId, includeInactive: true }).map((c) => c.id);
    const names = new Map(this.repo.listClippers({ includeInactive: true }).map((c) => [c.id, c.username]));
    const platforms: Platform[] = ['tiktok', 'instagram', 'youtube'];
    return platforms
      .flatMap((p) => this.repo.bestVideos(p, range.from, range.to, limit, clipperIds))
      .sort((a, b) => b.views - a.views)
      .slice(0, limit)
      .map((v) => ({ ...v, username: names.get(v.clipperId) ?? '?' }));
  }

  // --- Rémunération ---------------------------------------------------------------

  payoutSummary(range: Range, clientId?: number) {
    const rows = this.ranked(range, clientId);
    const total = (f: (r: RankedClipper) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;
    return {
      range,
      base: total((r) => r.reward.base),
      primes: total((r) => r.reward.primes),
      malus: total((r) => r.reward.malus),
      total: total((r) => r.reward.total),
      rows: rows.map((r) => ({ id: r.clipper.id, username: r.clipper.username, views: r.views, posts: r.posts, reward: r.reward, source: r.rewardSource })),
    };
  }

  clientName(clientId: number | null): string | null {
    return clientId ? (this.repo.getClient(clientId) as Client | undefined)?.name ?? null : null;
  }
}

/** Erreur de relevé lisible par le staff (au lieu du message brut d'Apify / de l'API). */
export function readableError(err: string): string {
  if (/usage hard limit|platform-feature-disabled|402|403/i.test(err) && /apify/i.test(err)) return 'quota Apify atteint : en pause jusqu’à la remise à zéro du compte Apify (ou monter le plafond)';
  if (/quotaExceeded|exceeded your\s*(<[^>]*>)?\s*quota/i.test(err)) return 'quota YouTube du jour atteint (clé partagée par les sites) : relu après 9 h, à la remise à zéro';
  if (/YouTube .*(keyInvalid|API key not valid|accessNotConfigured|has not been used|disabled)/i.test(err)) return 'clé YouTube refusée : vérifier YOUTUBE_API_KEY sur Railway';
  if (/pas connecté/i.test(err)) return 'le clippeur doit connecter ce compte sur le site';
  if (/introuvable|not found|404/i.test(err)) return 'compte introuvable (pseudo faux, privé ou supprimé)';
  if (/expirée/i.test(err)) return 'connexion expirée : le clippeur doit la refaire sur le site';
  return err.length > 140 ? `${err.slice(0, 140)}…` : err;
}
