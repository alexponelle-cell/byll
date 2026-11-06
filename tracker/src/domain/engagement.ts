import { dayKey } from './time.js';

/** Outils purs pour motiver les clippeurs : meilleur créneau, feedback des clips, défi du week-end. */

export interface ClipStat {
  publishedAt: number;
  views: number;
}

const parisHour = (t: number) => Number(new Date(t).toLocaleString('en-US', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }));

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Meilleur créneau de publication (tranche de 3 h, heure de Paris) : vues médianes du créneau comparées à celles de tous ses clips.
 * null si moins de 6 clips, ou si aucun créneau ne fait au moins 1,5× mieux (avec au moins 2 clips dedans).
 */
export function bestSlot(clips: ClipStat[]): { from: number; to: number; ratio: number } | null {
  if (clips.length < 6) return null;
  const all = median(clips.map((c) => c.views));
  if (all <= 0) return null;
  let best: { from: number; to: number; ratio: number } | null = null;
  for (let h = 0; h < 24; h += 3) {
    const inSlot = clips.filter((c) => {
      const x = parisHour(c.publishedAt);
      return x >= h && x < h + 3;
    });
    if (inSlot.length < 2) continue;
    const ratio = median(inSlot.map((c) => c.views)) / all;
    if (ratio >= 1.5 && (!best || ratio > best.ratio)) best = { from: h, to: h + 3, ratio };
  }
  return best;
}

/** Feedback d'un clip comparé aux autres clips du clippeur (médiane) : « hot » si ≥ 2×, « low » si ≤ 1/3. */
export function clipVerdict(views: number, others: number[]): 'hot' | 'low' | null {
  if (others.length < 5) return null;
  const m = median(others);
  if (m < 300) return null;
  if (views >= 2 * m) return 'hot';
  if (views <= m / 3) return 'low';
  return null;
}

const HOT = [
  '🔥 Ton clip **{title}** cartonne : **{views} vues**, {ratio}× ta moyenne ! Refais ce format, c’est ce qui marche pour toi.',
  '🚀 **{title}** décolle : **{views} vues** ({ratio}× ta moyenne). Garde le même type de hook et de passage !',
];
const LOW = [
  '💡 **{title}** a moins pris ({views} vues, ta moyenne est à {avg}). Essaie un hook plus fort dans la 1re seconde et des sous-titres bien lisibles.',
  '💡 **{title}** est en dessous de ta moyenne ({views} vues contre {avg}). Teste un passage plus court et plus punchy, ou un autre créneau de publication.',
];

export function verdictMessage(kind: 'hot' | 'low', clip: { title: string | null; views: number }, others: number[], seed: number, fmt: (n: number) => string): string {
  const m = median(others);
  const list = kind === 'hot' ? HOT : LOW;
  return list[Math.abs(seed) % list.length]!
    .replace('{title}', (clip.title ?? 'ton clip').slice(0, 60))
    .replace('{views}', fmt(clip.views))
    .replace('{ratio}', String(Math.round((clip.views / Math.max(m, 1)) * 10) / 10))
    .replace('{avg}', fmt(Math.round(m)));
}

/** Défi du week-end : du vendredi 18 h au lundi 0 h (Paris) précédant le lundi `mondayMidnight`. */
export function weekendWindow(mondayMidnight: number): { from: number; to: number } {
  return { from: mondayMidnight - 54 * 3_600_000, to: mondayMidnight };
}


export { dayKey };
