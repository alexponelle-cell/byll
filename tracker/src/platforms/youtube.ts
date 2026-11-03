import type { FetchedAccount, FetchedProfile, PlatformFetcher } from './types.js';

const API = 'https://www.googleapis.com/youtube/v3';

/**
 * YouTube Data API v3 (clé API gratuite, quota 10 000 unités/jour).
 * Coût par compte : ~3 unités (channels + playlistItems + videos).
 */
export class YouTubeFetcher implements PlatformFetcher {
  readonly platform = 'youtube' as const;

  constructor(
    private readonly apiKey: string,
    private readonly maxVideos: number,
    /** Rattrapage : toutes les vidéos publiées depuis cette date (pages de 50), au lieu des N dernières. */
    private readonly since?: number,
  ) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries({ ...params, key: this.apiKey })) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  private lookup(account: { handle: string; externalId: string | null }): Record<string, string> {
    return account.externalId ? { id: account.externalId } : account.handle.startsWith('UC') ? { id: account.handle } : { forHandle: `@${account.handle}` };
  }

  private async channel(account: { handle: string; externalId: string | null }, part: string) {
    const channels = await this.get<{
      items?: Array<{
        id: string;
        snippet: { title: string; description?: string };
        contentDetails?: { relatedPlaylists: { uploads: string } };
        statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
      }>;
    }>('channels', { part, ...this.lookup(account) });
    const channel = channels.items?.[0];
    if (!channel) throw new Error(`Chaîne YouTube introuvable : ${account.handle}`);
    return channel;
  }

  async fetchProfile(account: { handle: string; externalId: string | null }): Promise<FetchedProfile> {
    const c = await this.channel(account, 'snippet,statistics');
    return { externalId: c.id, bio: c.snippet.description ?? '', followers: c.statistics?.hiddenSubscriberCount ? undefined : Number(c.statistics?.subscriberCount ?? 0) };
  }

  /** Un Short / une vidéo précise (gratuit : 1 unité de quota) ; ownerId = ID de la chaîne. */
  async fetchVideo(url: string) {
    const id = url.match(/(?:shorts\/|[?&]v=|youtu\.be\/|live\/)([\w-]{11})/)?.[1];
    if (!id) return null;
    const r = await this.get<{ items?: Array<{ id: string; snippet: { channelId: string; title: string; publishedAt: string; description?: string; tags?: string[] }; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>('videos', { part: 'snippet,statistics', id });
    const v = r.items?.[0];
    if (!v) return null;
    return {
      owner: null,
      ownerId: v.snippet.channelId,
      video: {
        platformVideoId: v.id,
        url: `https://www.youtube.com/shorts/${v.id}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        title: withDescription(v.snippet.title, v.snippet.description, v.snippet.tags),
        publishedAt: Date.parse(v.snippet.publishedAt),
        views: Number(v.statistics.viewCount ?? 0),
        likes: v.statistics.likeCount ? Number(v.statistics.likeCount) : undefined,
        comments: v.statistics.commentCount ? Number(v.statistics.commentCount) : undefined,
      },
    };
  }

  async fetchAccount(account: { handle: string; externalId: string | null }): Promise<FetchedAccount> {
    const channel = await this.channel(account, 'snippet,contentDetails,statistics');
    const profile = { bio: channel.snippet.description ?? '', followers: channel.statistics?.hiddenSubscriberCount ? undefined : Number(channel.statistics?.subscriberCount ?? 0) };

    const ids: string[] = [];
    let pageToken: string | undefined;
    // Rattrapage : jusqu'à 20 pages de 50 (1 unité de quota chacune), on s'arrête dès qu'on passe avant la date
    for (let page = 0; page < (this.since ? 20 : 1); page++) {
      const playlist = await this.get<{ items?: Array<{ contentDetails: { videoId: string; videoPublishedAt?: string } }>; nextPageToken?: string }>('playlistItems', {
        part: 'contentDetails',
        playlistId: channel.contentDetails!.relatedPlaylists.uploads,
        maxResults: String(this.since ? 50 : Math.min(this.maxVideos, 50)),
        ...(pageToken ? { pageToken } : {}),
      });
      const items = playlist.items ?? [];
      const recent = this.since ? items.filter((i) => !i.contentDetails.videoPublishedAt || Date.parse(i.contentDetails.videoPublishedAt) >= this.since!) : items;
      ids.push(...recent.map((i) => i.contentDetails.videoId));
      pageToken = playlist.nextPageToken;
      if (!pageToken || recent.length < items.length) break;
    }
    if (ids.length === 0) return { externalId: channel.id, displayName: channel.snippet.title, videos: [], ...profile };

    type Video = {
      id: string;
      snippet: { title: string; publishedAt: string; description?: string; tags?: string[] };
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
    };
    const videos: { items: Video[] } = { items: [] };
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.get<{ items?: Video[] }>('videos', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(',') });
      videos.items.push(...(r.items ?? []));
    }

    return {
      externalId: channel.id,
      displayName: channel.snippet.title,
      ...profile,
      videos: (videos.items ?? []).map((v) => ({
        platformVideoId: v.id,
        url: `https://www.youtube.com/shorts/${v.id}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        // Le #tag est souvent dans la description d'un Short : on la garde avec le titre (vérif de la légende)
        title: withDescription(v.snippet.title, v.snippet.description, v.snippet.tags),
        publishedAt: Date.parse(v.snippet.publishedAt),
        views: Number(v.statistics.viewCount ?? 0),
        likes: v.statistics.likeCount ? Number(v.statistics.likeCount) : undefined,
        comments: v.statistics.commentCount ? Number(v.statistics.commentCount) : undefined,
      })),
    };
  }
}

/**
 * Titre + début de la description + tous les #hashtags de la description (même tout en bas) + tags :
 * c'est souvent là que le clippeur met le #tag du créateur.
 */
export function withDescription(title: string, description?: string, tags?: string[]): string {
  const desc = description?.replace(/\s+/g, ' ').trim() ?? '';
  const head = desc.slice(0, 200);
  const lateTags = [...new Set(desc.slice(200).match(/#[\p{L}\p{N}_]+/gu) ?? [])].filter((h) => !head.includes(h)).join(' ');
  const extra = [head, lateTags, tags?.length ? tags.map((t) => `#${t.replace(/\s+/g, '')}`).join(' ') : '']
    .filter(Boolean)
    .join(' ');
  return extra ? `${title} · ${extra}` : title;
}
