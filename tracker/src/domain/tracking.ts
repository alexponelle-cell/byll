import type { Platform } from './links.js';

/**
 * Contrôle du relevé de la nuit : pour chaque compte de fan, les vues ont-elles bien été relues ?
 *  - ok       : relu cette nuit, sans erreur
 *  - waiting  : compte payant (Apify) relu plus tôt, pas encore à son tour (toutes les 2 nuits, 1 fois / semaine si inactif…)
 *  - error    : le dernier relevé a échoué (compte introuvable, quota Apify, connexion expirée…)
 *  - late     : aurait dû être relu et ne l'a pas été (relevé bloqué, service redémarré…)
 *  - never    : jamais relu depuis son ajout
 */
export type TrackStatus = 'ok' | 'waiting' | 'error' | 'late' | 'never';

export interface TrackedAccount {
  id: number;
  platform: Platform;
  handle: string;
  url: string;
  lastCheckedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Âge maximal normal du dernier relevé d'un compte payant (même rythme que fanAccountDue). */
export function paidMaxAge(account: Pick<TrackedAccount, 'createdAt'>, lastPublished: number | null | undefined, now: number): number {
  if (lastPublished == null) return (now - account.createdAt < 30 * DAY ? 2 : 14) * DAY;
  if (now - lastPublished > 14 * DAY) return 7 * DAY;
  return 2 * DAY;
}

/**
 * `since` = minuit (Paris) de la nuit contrôlée. Un compte gratuit doit être relu chaque nuit (on laisse 3 h au relevé) ;
 * un compte payant a 1 jour de marge sur son rythme normal.
 */
export function trackStatus(account: TrackedAccount, lastPublished: number | null | undefined, since: number, now: number, free: boolean): TrackStatus {
  if (account.lastCheckedAt === null) return now - account.createdAt > 3 * HOUR ? 'never' : 'waiting';
  if (account.lastError) return 'error';
  if (account.lastCheckedAt >= since) return 'ok';
  if (free || account.platform === 'youtube') return now - since > 3 * HOUR ? 'late' : 'waiting';
  return now - account.lastCheckedAt > paidMaxAge(account, lastPublished, now) + DAY ? 'late' : 'waiting';
}

export interface TrackingProblem {
  id: number;
  platform: Platform;
  handle: string;
  url: string;
  username: string;
  status: Exclude<TrackStatus, 'ok' | 'waiting'>;
  error: string | null;
  lastCheckedAt: number | null;
}

export interface TrackingReport {
  since: number;
  platforms: Record<Platform, { total: number; ok: number; waiting: number; error: number; late: number; never: number }>;
  problems: TrackingProblem[];
}

export function trackingReport(
  accounts: Array<TrackedAccount & { username: string }>,
  lastPublished: Map<number, number | null>,
  connected: Set<number>,
  since: number,
  now: number,
): TrackingReport {
  const empty = () => ({ total: 0, ok: 0, waiting: 0, error: 0, late: 0, never: 0 });
  const platforms = { youtube: empty(), tiktok: empty(), instagram: empty() } as TrackingReport['platforms'];
  const problems: TrackingProblem[] = [];
  for (const a of accounts) {
    const s = trackStatus(a, lastPublished.get(a.id), since, now, connected.has(a.id));
    const p = (platforms[a.platform] ??= empty());
    p.total++;
    p[s]++;
    if (s === 'error' || s === 'late' || s === 'never') problems.push({ id: a.id, platform: a.platform, handle: a.handle, url: a.url, username: a.username, status: s, error: a.lastError, lastCheckedAt: a.lastCheckedAt });
  }
  const order = { error: 0, late: 1, never: 2 };
  problems.sort((a, b) => order[a.status] - order[b.status] || a.platform.localeCompare(b.platform));
  return { since, platforms, problems };
}

/** Le relevé est-il complet ? (rien en erreur, en retard ou jamais relu) */
export const trackingHealthy = (r: TrackingReport) => r.problems.length === 0;

const NAME: Record<Platform, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
const WHY = { late: 'pas relu à temps', never: 'jamais relu' } as const;

/** Rapport du matin pour le staff (salon log du serveur) : un résumé par réseau, puis les comptes à régler. */
export function trackingMessage(r: TrackingReport, max = 15): string {
  const lines = (Object.keys(r.platforms) as Platform[])
    .filter((p) => r.platforms[p].total)
    .map((p) => {
      const s = r.platforms[p];
      const bad = s.error + s.late + s.never;
      return `${bad ? '⚠️' : '✅'} **${NAME[p]}** : ${s.ok} relu(s) cette nuit${s.waiting ? `, ${s.waiting} à leur tour plus tard` : ''}${bad ? `, **${bad} à régler**` : ''}`;
    });
  if (!lines.length) return '📡 **Relevé de la nuit** : aucun compte suivi.';
  const head = `📡 **Relevé de la nuit**${r.problems.length ? '' : ' : tout est relu ✅'}\n${lines.join('\n')}`;
  if (!r.problems.length) return head;
  const list = r.problems
    .slice(0, max)
    .map((p) => `• ${NAME[p.platform]} @${p.handle} (${p.username}) : ${p.status === 'error' ? p.error ?? 'erreur' : WHY[p.status]}`);
  return `${head}\n\n${list.join('\n')}${r.problems.length > max ? `\n… et ${r.problems.length - max} autre(s)` : ''}\nDétail dans Mars → Boutique fans → Relevé de la nuit.`;
}
