import type { FetchedAccount, FetchedProfile, PlatformFetcher } from './types.js';

/**
 * TikTok et Instagram n'ont pas d'API publique pour lire les stats d'un compte tiers
 * (leurs APIs officielles demandent que chaque clipper connecte son compte en OAuth).
 * On passe donc par des scrapers hébergés sur Apify (payants à l'usage).
 *
 * ⚠️ Les noms d'actors et les champs de sortie ci-dessous sont à vérifier sur la page
 * de chaque actor avant la mise en prod : ils évoluent de temps en temps.
 */
async function runActor<T>(token: string, actorId: string, input: unknown): Promise<T[]> {
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Apify ${actorId} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

/** « 2026-08-01 » (format de date des actors Apify). */
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Gros posteur (ex. 10 clips par jour) : si les N clips lus sont TOUS plus récents que la dernière lecture,
 * d'autres ont sûrement été postés entre-temps et ne seraient jamais vus. On relit alors tout depuis la
 * dernière lecture (jusqu'à 30). Ne coûte un peu plus que pour ceux qui postent beaucoup.
 */
export function needsCatchUp(publishedAts: Array<number | undefined>, limit: number, lastCheckedAt: number | null | undefined): boolean {
  if (!lastCheckedAt || publishedAts.length < limit) return false;
  return publishedAts.every((t) => t !== undefined && t > lastCheckedAt);
}
const CATCH_UP = 30;
const mergeVideos = <T extends { platformVideoId: string }>(a: T[], b: T[]) => [...new Map([...a, ...b].map((v) => [v.platformVideoId, v])).values()];

/**
 * Légende + hashtags rangés à part par l'actor (certains reels n'ont pas les #tags dans « caption »).
 * Sans ça, un clip avec #micka bien mis était refusé (« #micka manquant »).
 */
export function withHashtags(text: unknown, tags: unknown): string | undefined {
  const base = typeof text === 'string' ? text : '';
  const list = (Array.isArray(tags) ? tags : [])
    .map((t) => (typeof t === 'string' ? t : t && typeof t === 'object' && 'name' in t ? String((t as { name: unknown }).name) : ''))
    .map((t) => t.replace(/^#/, '').trim())
    .filter((t) => t && !base.toLowerCase().includes(`#${t.toLowerCase()}`));
  const out = [base, list.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' ').trim();
  return out || undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export class TikTokApifyFetcher implements PlatformFetcher {
  readonly platform = 'tiktok' as const;

  constructor(
    private readonly token: string,
    private readonly maxVideos: number,
    /** Rattrapage : toutes les vidéos publiées depuis cette date (dans la limite de maxVideos). */
    private readonly since?: number,
    private readonly actorId = 'clockworks~tiktok-scraper',
    private readonly profileActorId = 'clockworks~tiktok-profile-scraper',
  ) {}

  async fetchAccount(account: { handle: string; lastCheckedAt?: number | null }): Promise<FetchedAccount> {
    const run = (limit: number, since?: number) =>
      runActor<Record<string, any>>(this.token, this.actorId, {
        profiles: [account.handle],
        resultsPerPage: limit,
        ...(since ? { oldestPostDateUnified: isoDay(since) } : {}),
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      });
    let items = await run(this.maxVideos, this.since);
    if (!this.since && needsCatchUp(items.filter((i) => i.id).map((i) => (i.createTimeISO ? Date.parse(i.createTimeISO) : undefined)), this.maxVideos, account.lastCheckedAt))
      items = mergeVideos(items.filter((i) => i.id).map((i) => ({ ...i, platformVideoId: String(i.id) })), (await run(CATCH_UP, account.lastCheckedAt! - 86_400_000)).filter((i) => i.id).map((i) => ({ ...i, platformVideoId: String(i.id) })));
    return {
      displayName: items[0]?.authorMeta?.nickName,
      externalId: items[0]?.authorMeta?.id,
      bio: items[0]?.authorMeta?.signature,
      followers: num(items[0]?.authorMeta?.fans),
      videos: items
        .filter((i) => i.id)
        .map((i) => ({
          platformVideoId: String(i.id),
          url: i.webVideoUrl,
          thumbnailUrl: i.videoMeta?.coverUrl ?? i.covers?.[0],
          title: withHashtags(i.text, i.hashtags),
          publishedAt: i.createTimeISO ? Date.parse(i.createTimeISO) : undefined,
          views: num(i.playCount) ?? 0,
          likes: num(i.diggCount),
          comments: num(i.commentCount),
        })),
    };
  }

  async fetchVideo(url: string) {
    const items = await runActor<Record<string, any>>(this.token, this.actorId, { postURLs: [url], shouldDownloadVideos: false, shouldDownloadCovers: false });
    const i = items.find((x) => x.id);
    if (!i) return null;
    return {
      owner: i.authorMeta?.name ? String(i.authorMeta.name).toLowerCase() : null,
      ownerId: i.authorMeta?.id ? String(i.authorMeta.id) : null,
      video: {
        platformVideoId: String(i.id),
        url: i.webVideoUrl ?? url,
        thumbnailUrl: i.videoMeta?.coverUrl ?? i.covers?.[0],
        title: withHashtags(i.text, i.hashtags),
        publishedAt: i.createTimeISO ? Date.parse(i.createTimeISO) : undefined,
        views: num(i.playCount) ?? 0,
        likes: num(i.diggCount),
        comments: num(i.commentCount),
      },
    };
  }

  async fetchProfile(account: { handle: string }): Promise<FetchedProfile> {
    const items = await runActor<Record<string, any>>(this.token, this.profileActorId, { profiles: [account.handle], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false });
    const a = items.find((i) => i.authorMeta)?.authorMeta;
    if (!a) throw new Error(`Profil TikTok introuvable : @${account.handle}`);
    return { externalId: a.id, bio: a.signature ?? '', followers: num(a.fans) };
  }
}

export class InstagramApifyFetcher implements PlatformFetcher {
  readonly platform = 'instagram' as const;

  constructor(
    private readonly token: string,
    private readonly maxVideos: number,
    /** Rattrapage : tous les reels publiés depuis cette date (dans la limite de maxVideos). */
    private readonly since?: number,
    private readonly actorId = 'apify~instagram-reel-scraper',
    private readonly profileActorId = 'apify~instagram-profile-scraper',
  ) {}

  fetchVideo(url: string) {
    return fetchInstagramPost(this.token, url);
  }

  async fetchProfile(account: { handle: string }): Promise<FetchedProfile> {
    const items = await runActor<Record<string, any>>(this.token, this.profileActorId, { usernames: [account.handle] });
    const p = items[0];
    if (!p || p.error) throw new Error(`Profil Instagram introuvable : @${account.handle}`);
    return { externalId: p.id ? String(p.id) : undefined, bio: p.biography ?? '', followers: num(p.followersCount) };
  }

  async fetchAccount(account: { handle: string; lastCheckedAt?: number | null }): Promise<FetchedAccount> {
    const run = (limit: number, since?: number) =>
      runActor<Record<string, any>>(this.token, this.actorId, {
        username: [account.handle],
        resultsLimit: limit,
        ...(since ? { onlyPostsNewerThan: isoDay(since) } : {}),
      });
    const key = (i: Record<string, any>) => String(i.shortCode ?? i.id);
    let items = await run(this.maxVideos, this.since);
    if (!this.since && needsCatchUp(items.filter((i) => i.shortCode || i.id).map((i) => (i.timestamp ? Date.parse(i.timestamp) : undefined)), this.maxVideos, account.lastCheckedAt))
      items = mergeVideos(items.filter((i) => i.shortCode || i.id).map((i) => ({ ...i, platformVideoId: key(i) })), (await run(CATCH_UP, account.lastCheckedAt! - 86_400_000)).filter((i) => i.shortCode || i.id).map((i) => ({ ...i, platformVideoId: key(i) })));
    return {
      displayName: items[0]?.ownerFullName,
      externalId: items[0]?.ownerId,
      videos: items
        .filter((i) => i.shortCode || i.id)
        .map((i) => ({
          platformVideoId: String(i.shortCode ?? i.id),
          url: i.url,
          thumbnailUrl: i.displayUrl ?? i.thumbnailUrl,
          title: withHashtags(i.caption, i.hashtags),
          publishedAt: i.timestamp ? Date.parse(i.timestamp) : undefined,
          views: num(i.videoPlayCount) ?? num(i.videoViewCount) ?? 0,
          likes: num(i.likesCount),
          comments: num(i.commentsCount),
        })),
    };
  }
}

/** Un reel / post Instagram précis à partir de son lien (scraper généraliste, 1 seul résultat). */
export async function fetchInstagramPost(token: string, url: string) {
  const items = await runActor<Record<string, any>>(token, 'apify~instagram-scraper', { directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false });
  const i = items.find((x) => x.shortCode || x.id);
  if (!i || i.error) return null;
  return {
    owner: i.ownerUsername ? String(i.ownerUsername).toLowerCase() : null,
    ownerId: i.ownerId ? String(i.ownerId) : null,
    video: {
      platformVideoId: String(i.shortCode ?? i.id),
      url: i.url ?? url,
      thumbnailUrl: i.displayUrl ?? i.thumbnailUrl,
      title: withHashtags(i.caption, i.hashtags),
      publishedAt: i.timestamp ? Date.parse(i.timestamp) : undefined,
      views: num(i.videoPlayCount) ?? num(i.videoViewCount) ?? 0,
      likes: num(i.likesCount),
      comments: num(i.commentsCount),
    },
  };
}

/** Conso Apify du mois (gratuit à lire) : dépensé, plafond et date de remise à zéro. Mise en cache 30 min. */
export interface ApifyUsage { used: number; limit: number | null; resetAt: number | null }
let usageCache: { at: number; value: ApifyUsage } | null = null;
export async function apifyUsage(token: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<ApifyUsage> {
  if (usageCache && now - usageCache.at < 30 * 60_000) return usageCache.value;
  const res = await fetchFn(`https://api.apify.com/v2/users/me/limits?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Apify ${res.status}`);
  const d = ((await res.json()) as { data?: Record<string, any> }).data ?? {};
  const value: ApifyUsage = {
    used: num(d.current?.monthlyUsageUsd) ?? 0,
    limit: num(d.limits?.maxMonthlyUsageUsd) ?? null,
    resetAt: d.monthlyUsageCycle?.endAt ? Date.parse(d.monthlyUsageCycle.endAt) : null,
  };
  usageCache = { at: now, value };
  return value;
}
