import type { Account, Repo } from '../db/repo.js';
import type { FetcherRegistry } from '../platforms/types.js';
import { log } from '../log.js';

/** Gros clips relus à part à chaque lecture Apify : au moins 5 000 vues, les 3 plus vus des 30 derniers jours. */
export const BIG_CLIP_VIEWS = 5000;
export const BIG_CLIPS_PER_READ = 3;

export interface CollectResult {
  ok: number;
  failed: number;
}

/**
 * Récupère les stats de tous les comptes actifs et enregistre une capture pour chacun.
 * `skip` permet d'espacer certains comptes (ex. les fans : 1 fois par nuit, après minuit, pour limiter le coût d'Apify).
 */
export async function collectAll(
  repo: Repo,
  fetchers: FetcherRegistry,
  now: () => number = Date.now,
  skip: (account: Account, now: number) => boolean = () => false,
): Promise<CollectResult> {
  const result: CollectResult = { ok: 0, failed: 0 };
  for (const account of repo.listActiveAccounts()) {
    if (skip(account, now())) continue;
    try {
      const fetched = await fetchers[account.platform].fetchAccount(account);
      // Un même compte ne peut être suivi qu'une fois (ex. @pseudo et /channel/UC… sur YouTube, ou pseudo changé) :
      // le plus récent est désactivé, pour ne jamais compter les vues deux fois.
      const dup = fetched.externalId ? repo.findDuplicateAccount(account.platform, fetched.externalId, account.id) : undefined;
      if (dup && dup.id < account.id) {
        const owner = repo.getClipper(dup.clipperId)?.username ?? '?';
        repo.deactivateAccount(account.id);
        repo.markAccountChecked(account.id, now(), { externalId: fetched.externalId, error: `Doublon : ce compte est déjà suivi (@${dup.handle}, ${owner})` });
        log.warn(`collect ${account.platform}/${account.handle} : doublon de @${dup.handle} (${owner}), désactivé`);
        result.failed++;
        continue;
      }
      // Gros clips récents sortis des derniers lus (Apify) : relus à part, sinon leurs vues restent figées
      const fetcher = fetchers[account.platform];
      if (fetcher.fetchVideos) {
        const seen = new Set(fetched.videos.map((v) => v.platformVideoId));
        const urls = repo.bigClipsToRefresh(account.id, seen, now() - 30 * 86_400_000, BIG_CLIP_VIEWS, BIG_CLIPS_PER_READ);
        if (urls.length) fetched.videos.push(...(await fetcher.fetchVideos(urls).catch(() => [])).filter((v) => !seen.has(v.platformVideoId)));
      }
      const at = now();
      const snap = repo.recordCollection(account.id, fetched.videos, at);
      repo.markAccountChecked(account.id, at, { externalId: fetched.externalId, displayName: fetched.displayName, followers: fetched.followers });
      log.debug(`collect ${account.platform}/${account.handle}: ${snap.totalViews} vues`);
      result.ok++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repo.markAccountChecked(account.id, now(), { error: message });
      log.warn(`collect ${account.platform}/${account.handle} a échoué: ${message}`);
      result.failed++;
    }
  }
  return result;
}

/** Minuit (heure de Paris) du jour de `now` : les comptes des fans sont relevés une fois par nuit, juste après. */
export const parisMidnight = (now: number) => zoneMidnight(now, 'Europe/Paris');
/** Minuit heure du Pacifique : remise à zéro du quota de l'API YouTube (9 h à Paris). */
export const pacificMidnight = (now: number) => zoneMidnight(now, 'America/Los_Angeles');

function zoneMidnight(now: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  const offset = wall - Math.floor(now / 1000) * 1000;
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!) - offset;
}

const DAY = 86_400_000;

/**
 * Économie Apify (TikTok pas connecté et Instagram sont payants à l'usage ; YouTube et TikTok connecté sont gratuits).
 * Compte de fan payant : relu toutes les `activeEveryDays` nuits (variable FAN_APIFY_EVERY_DAYS, 1 = chaque nuit) ; sans nouvelle vidéo depuis 14 jours, 1 fois par semaine ;
 * sans aucune vidéo, toutes les 2 semaines. Gratuit : chaque nuit. Jamais relu : tout de suite.
 */
export function fanAccountDue(account: { platform: string; lastCheckedAt: number | null; lastError?: string | null; createdAt?: number }, lastPublished: number | null | undefined, since: number, now: number, free = false, activeEveryDays = 2): boolean {
  if (account.lastCheckedAt === null) return true;
  // Quota YouTube du jour épuisé : il revient à minuit heure du Pacifique (9 h à Paris), on relit dès qu'il est remis à zéro
  if (account.lastError && /quotaExceeded|exceeded your/i.test(account.lastError)) return account.lastCheckedAt < pacificMidnight(now);
  if (account.lastCheckedAt >= since) return false;
  // Relevé raté à cause du quota Apify : on réessaie dès la nuit suivante (sinon il attendrait 2 nuits de plus)
  if (account.lastError && /hard limit|usage limit|platform-feature-disabled/i.test(account.lastError)) return true;
  if (free || account.platform === 'youtube') return true;
  const age = now - account.lastCheckedAt + 3_600_000; // 1 h de marge (le relevé ne tombe pas pile à la même heure)
  // Compte vide : toutes les 2 semaines, sauf s'il vient d'être ajouté (le clippeur poste ses 1ers clips : toutes les 2 nuits pendant 30 jours)
  if (lastPublished == null) return age >= (account.createdAt !== undefined && now - account.createdAt < 30 * DAY ? 2 : 14) * DAY;
  if (now - lastPublished > 14 * DAY) return age >= 7 * DAY;
  return age >= activeEveryDays * DAY;
}

/** Compte relu via Apify (payant) ? YouTube et les comptes TikTok / Instagram connectés sont gratuits. */
export const paidAccount = (account: { id: number; platform: string }, connected: Set<number>) =>
  (account.platform === 'instagram' || account.platform === 'tiktok') && !connected.has(account.id);
