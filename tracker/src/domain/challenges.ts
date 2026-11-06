/**
 * Défis du week-end tournants (demande des clippeurs : « 3 clips, tout le monde réussit »).
 * Un défi différent chaque semaine, et un objectif calculé sur les vrais chiffres du serveur
 * (les 4 week-ends d'avant) : seuls les ~15 % les plus forts réussissent. Les clippeurs de Loann,
 * très forts, ont donc des objectifs bien plus hauts qu'ailleurs, sans rien régler.
 */
export type ChallengeId = 'marathon' | 'perce' | 'cagnotte' | 'partout' | 'podium' | 'regulier';

/** Ce qu'un clippeur a fait pendant un week-end (clips qui comptent, publiés du vendredi 18 h au lundi 0 h). */
export interface WeekendStat {
  clipperId: number;
  discordId: string;
  clips: number;
  /** Vues totales de ses clips du week-end. */
  views: number;
  /** Vues de son meilleur clip du week-end. */
  best: number;
  perPlatform: Record<'tiktok' | 'instagram' | 'youtube', number>;
  /** Clips vendredi soir, samedi, dimanche. */
  perDay: [number, number, number];
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');

interface Challenge {
  name: string;
  /** Objectif minimum, même si le serveur est encore petit. */
  floor: number;
  metric(s: WeekendStat): number;
  goal(t: number): string;
}

export const CHALLENGES: Record<ChallengeId, Challenge> = {
  marathon: { name: 'Marathon', floor: 6, metric: (s) => s.clips, goal: (t) => `poste **${t} clips** qui comptent d’ici dimanche minuit` },
  perce: { name: 'Le clip qui perce', floor: 10_000, metric: (s) => s.best, goal: (t) => `fais **un clip à ${fmt(t)} vues** (publié ce week-end, vues comptées lundi matin)` },
  cagnotte: { name: 'Grosse cagnotte', floor: 30_000, metric: (s) => s.views, goal: (t) => `cumule **${fmt(t)} vues** sur tes clips du week-end (comptées lundi matin)` },
  partout: { name: 'Partout', floor: 2, metric: (s) => Math.min(s.perPlatform.tiktok, s.perPlatform.instagram, s.perPlatform.youtube), goal: (t) => `poste au moins **${t} clips sur TikTok, ${t} sur Insta ET ${t} sur YouTube Shorts**` },
  podium: { name: 'Le podium', floor: 0, metric: (s) => s.views, goal: () => `finis dans le **top 5 des vues du week-end** (seuls les 5 meilleurs gagnent)` },
  regulier: { name: 'Régulier', floor: 2, metric: (s) => Math.min(...s.perDay), goal: (t) => `poste **${t} clips chaque jour** : vendredi soir, samedi ET dimanche` },
};

/** Ordre de rotation : jamais deux fois le même d'affilée. */
const ORDER: ChallengeId[] = ['cagnotte', 'marathon', 'perce', 'regulier', 'podium', 'partout'];

/** Défi de la semaine (numéro de semaine depuis 1970, stable pour tout le week-end). */
export function pickChallenge(weekIndex: number): ChallengeId {
  return ORDER[((weekIndex % ORDER.length) + ORDER.length) % ORDER.length]!;
}

/** Arrondi lisible : 37 412 → 40 000, 21 → 21, 8 400 → 8 500. */
export function roundNice(n: number): number {
  if (n < 100) return Math.ceil(n);
  const step = n < 1000 ? 10 : n < 10_000 ? 500 : n < 100_000 ? 5000 : 50_000;
  return Math.ceil(n / step) * step;
}

/**
 * Objectif = ce que seuls les ~15 % les plus forts ont fait sur les 4 week-ends d'avant
 * (parmi ceux qui ont posté), jamais sous le minimum du défi.
 */
export function challengeTarget(id: ChallengeId, history: WeekendStat[]): number {
  const c = CHALLENGES[id];
  if (id === 'podium') return 5;
  const values = history.filter((s) => s.clips > 0).map(c.metric).sort((a, b) => a - b);
  if (values.length < 5) return c.floor;
  const p85 = values[Math.min(values.length - 1, Math.floor(values.length * 0.85))]!;
  return Math.max(c.floor, roundNice(p85));
}

export function challengeWinners(id: ChallengeId, target: number, stats: WeekendStat[]): WeekendStat[] {
  if (id === 'podium') return stats.filter((s) => s.views > 0).sort((a, b) => b.views - a.views).slice(0, target);
  const c = CHALLENGES[id];
  return stats.filter((s) => s.clips > 0 && c.metric(s) >= target);
}

export function challengeAnnounce(id: ChallengeId, target: number, role: string): string {
  const c = CHALLENGES[id];
  return `🔥 **Défi du week-end : ${c.name}**\n👉 ${c.goal(target)}.\nÀ gagner : le rôle **${role}** toute la semaine prochaine. Résultats lundi 10 h. Let’s go ! 💪`;
}
