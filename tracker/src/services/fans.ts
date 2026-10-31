import type { FanRepo, ItemInput, ShopOrder } from '../db/fans.js';
import { isVideoFile, parseTrainingLinks, TRAINING_MODULES, youtubeEmbed } from './training.js';
import type { Account, Clipper, Repo } from '../db/repo.js';
import type { FetcherRegistry } from '../platforms/types.js';
import { citesCreator, clipKeywords } from './clipCheck.js';
import { parseAccountInput, parseAccountLinks, type AccountLink, type Platform } from '../domain/links.js';
import { type AgencyService, readableError } from './agency.js';
import { trackingReport, type TrackingReport } from '../domain/tracking.js';
import { type CoinsState, coinsDiagnosis, type FaqInfo, type FaqIntent, fanAccountError, videoKey } from '../domain/faq.js';
import { beone } from '../creators/beone.js';
import { parisMidnight } from '../jobs/collect.js';
import type { CreatorConfig } from '../creators/types.js';
import type { RelanceContext } from '../domain/relance.js';
import { buildQuests, currentStreak, QUEST_COINS, type Quest } from '../domain/quests.js';
import { dayKey } from '../domain/time.js';
import { bestSlot, clipVerdict, verdictMessage, WEEKEND_GOAL } from '../domain/engagement.js';

/** Programme fans (bot Neptune) : les fans clippent, gagnent des points avec leurs vues et les échangent en boutique. */
export interface FanSettings {
  /** Agence (client) à laquelle appartiennent les fans (ex. BeOne). */
  clientId: number | null;
  /** Points gagnés pour 1 000 vues. */
  pointsPer1000: number;
  /** Nom affiché sur l'espace fan. */
  programName: string;
  /** Accroche sous le titre de la page d'accueil. */
  tagline: string;
  /** Image ou vidéo (.mp4) de fond de la page d'accueil. */
  heroMediaUrl: string;
  /** Invitation au serveur Discord (bouton « Rejoindre la communauté »). */
  discordInviteUrl: string;
  /** Contenus mis en avant, une ligne par contenu : « type | titre | lien » (type : video, podcast, best). */
  featured: string;
  /** Chaîne YouTube du créateur (@pseudo) : sa photo HD est utilisée sur le site. */
  creatorYoutube: string;
  /** Pseudo Roblox du créateur : son avatar Roblox est utilisé sur le site. */
  creatorRoblox: string;
  /** Vidéos de la formation à cocher avant l'inscription, une par ligne : « Titre | lien ». */
  training: string;
  /** Règle anti-triche : un clip doit citer le créateur dans sa légende pour rapporter des coins. */
  clipRule: boolean;
  /** Date d'activation de la règle (les clips publiés avant ne sont pas concernés). */
  clipRuleSince: number;
  /** Mots-clés acceptés, séparés par des virgules ('' = nom + chaînes YouTube du créateur). */
  clipKeywords: string;
  /** Chaque achat attend la validation du staff avant d'être livré. */
  orderReview: boolean;
  /** Chaque nouveau compte inscrit attend la validation du staff (contenu du bon créateur) avant de rapporter. */
  accountReview: boolean;
}

export const DEFAULT_FANS: FanSettings = {
  clientId: null,
  pointsPer1000: 10,
  programName: 'BEONE REWARDS',
  tagline: 'Fais des vues. Gagne des Coins.',
  heroMediaUrl: '',
  discordInviteUrl: '',
  featured: '',
  creatorYoutube: 'BeOnePourcent',
  creatorRoblox: 'BeOnePourcentt',
  training: '',
  clipRule: true,
  clipRuleSince: 0,
  clipKeywords: '',
  orderReview: true,
  accountReview: true,
};

const FEATURED_KINDS = ['video', 'podcast', 'best'] as const;
type FeaturedKind = (typeof FEATURED_KINDS)[number];

/** « type | titre | lien » → contenu (miniature YouTube déduite du lien). */
export function parseFeatured(text: string): Array<{ kind: FeaturedKind; title: string; url: string; thumbnail: string | null }> {
  return text
    .split('\n')
    .map((line) => line.split('|').map((p) => p.trim()))
    .map((parts) => {
      const url = parts.find((p) => /^https?:\/\//i.test(p));
      if (!url) return null;
      const kind = (FEATURED_KINDS as readonly string[]).includes(parts[0]!.toLowerCase()) ? (parts[0]!.toLowerCase() as FeaturedKind) : 'video';
      const title = parts.find((p) => p !== url && !(FEATURED_KINDS as readonly string[]).includes(p.toLowerCase())) ?? '';
      const yt = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
      return { kind, title, url, thumbnail: yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : null };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 24);
}

const LOGIN_TTL = 10 * 60_000;

/** Niveau atteint (index dans les niveaux du créateur). */
export const levelOf = (views: number, levels: CreatorConfig['levels'] = beone.levels) => levels.reduce((acc, l, i) => (views >= l.min ? i : acc), 0);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DAY_MS = 86_400_000;
const nf = (n: number) => n.toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');
const SESSION_TTL = 30 * 86_400_000;

export interface FanBalance {
  views: number;
  earned: number;
  spent: number;
  balance: number;
}

export class FanService {
  constructor(
    private readonly repo: Repo,
    readonly fans: FanRepo,
    private readonly agency: AgencyService,
    private readonly publicUrl: string,
    /** Résolution pseudo Roblox → ID (API Roblox), remplaçable en test. */
    private readonly resolveRoblox: (username: string) => Promise<{ id: number; name: string } | null> = robloxLookup,
    /** Créateur du programme (marque, textes, récompense, taux). */
    readonly creator: CreatorConfig = beone,
  ) {}

  settings(): FanSettings {
    const c = this.creator;
    const defaults = { ...DEFAULT_FANS, programName: c.programName, pointsPer1000: c.pointsPer1000, creatorYoutube: c.youtube, creatorRoblox: c.robloxUsername ?? '' };
    const stored = { ...defaults, ...this.repo.getSetting<Partial<FanSettings>>('fans', {}) };
    // Les chaînes de la config sont toujours suivies, même si Mars a enregistré une liste plus ancienne
    const handles = new Set([...stored.creatorYoutube.split(','), ...c.youtube.split(',')].map((h) => h.trim().replace(/^@/, '')).filter(Boolean));
    stored.creatorYoutube = [...handles].join(',');
    if (c.clipRule === false) stored.clipRule = false;
    if (c.trustAccounts) Object.assign(stored, { accountReview: false, orderReview: false });
    return stored;
  }

  /** Date à partir de laquelle tous les clips comptent (config du créateur), sinon null. */
  countFrom(): number | null {
    const d = this.creator.countViewsFrom;
    return d ? Date.parse(`${d}T00:00:00+02:00`) : null;
  }

  /** « 1er août » : la date ci-dessus en toutes lettres, pour les messages aux fans. */
  countFromLabel(): string | null {
    const t = this.countFrom();
    if (t === null) return null;
    const label = new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
    return label.replace(/^1 /, '1er ');
  }

  /** Mot-clé à mettre dans la légende (« #squiduu »), null si la règle est coupée. */
  private tagLabel(): string | null {
    return this.settings().clipRule ? `#${this.clipKeywords()[0] ?? 'createur'}` : null;
  }

  /**
   * Au démarrage : agence des fans créée au nom du créateur si aucune n'est choisie,
   * et récompense du créateur ajoutée à la boutique si elle n'y est pas.
   */
  bootstrap(now = Date.now()): void {
    const c = this.creator;
    // Règle « le clip cite le créateur » : s'applique aux clips publiés à partir de sa mise en place
    if (!this.repo.getSetting<Partial<FanSettings>>('fans', {}).clipRuleSince) this.repo.setSetting('fans', { ...this.repo.getSetting('fans', {}), clipRuleSince: now });
    if (c.id !== 'beone' && !this.settings().clientId) {
      const existing = this.repo.listClients().find((x) => x.name.toLowerCase() === c.creatorName.toLowerCase());
      const client = existing ?? this.repo.upsertClient({ name: c.creatorName, rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
      this.saveSettings({ clientId: client.id });
    }
    if (c.reward && !this.fans.items().some((i) => i.ref === c.reward!.ref)) {
      this.fans.createItem({ name: c.reward.name, description: c.reward.description, price: c.reward.price, kind: 'item', ref: c.reward.ref, stock: null, imageUrl: c.images?.reward ? '/fan/assets/reward' : null, active: true }, now);
    }
    for (const r of c.extraRewards ?? []) {
      if (!this.fans.items().some((i) => i.ref === r.ref)) this.fans.createItem({ name: r.name, description: r.description, price: r.price, kind: 'item', ref: r.ref, stock: null, imageUrl: null, active: true }, now);
    }
  }

  /** Compte de livraison du fan (pseudo Roblox ou e-mail selon le créateur). */
  rewardAccount(clipperId: number): { kind: 'roblox' | 'email'; value: string | null } {
    if (this.creator.rewardAccount.kind === 'email') return { kind: 'email', value: this.fans.email(clipperId) };
    return { kind: 'roblox', value: this.fans.roblox(clipperId).username };
  }

  linkEmail(clipper: Clipper, email: string): string {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) throw new Error('Adresse e-mail invalide');
    const owner = this.fans.clipperByEmail(e);
    if (owner !== null && owner !== clipper.id) throw new Error('Cet e-mail est déjà relié à un autre fan');
    this.fans.setEmail(clipper.id, e);
    return e;
  }

  saveSettings(patch: Partial<FanSettings>): FanSettings {
    const next = { ...this.settings() };
    if (patch.clientId !== undefined) next.clientId = patch.clientId && this.repo.getClient(patch.clientId) ? patch.clientId : null;
    if (patch.pointsPer1000 !== undefined && Number.isFinite(patch.pointsPer1000) && patch.pointsPer1000 >= 0) next.pointsPer1000 = patch.pointsPer1000;
    if (patch.programName !== undefined && patch.programName.trim()) next.programName = patch.programName.trim().slice(0, 60);
    if (patch.tagline !== undefined) next.tagline = patch.tagline.trim().slice(0, 160);
    const url = (v: string) => (v.trim() === '' || /^https:\/\//i.test(v.trim()) ? v.trim().slice(0, 500) : null);
    if (patch.heroMediaUrl !== undefined && url(patch.heroMediaUrl) !== null) next.heroMediaUrl = url(patch.heroMediaUrl)!;
    if (patch.discordInviteUrl !== undefined && url(patch.discordInviteUrl) !== null) next.discordInviteUrl = url(patch.discordInviteUrl)!;
    if (patch.featured !== undefined) next.featured = patch.featured.slice(0, 5000);
    if (patch.creatorYoutube !== undefined)
      next.creatorYoutube = patch.creatorYoutube.split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean).join(',').slice(0, 120);
    if (patch.creatorRoblox !== undefined) next.creatorRoblox = patch.creatorRoblox.trim().replace(/^@/, '').slice(0, 20);
    if (patch.training !== undefined) next.training = patch.training.slice(0, 5000);
    if (patch.clipKeywords !== undefined) next.clipKeywords = patch.clipKeywords.slice(0, 300);
    if (patch.orderReview !== undefined) next.orderReview = patch.orderReview;
    if (patch.accountReview !== undefined) next.accountReview = patch.accountReview;
    if (patch.clipRule !== undefined) {
      if (patch.clipRule && !next.clipRule) next.clipRuleSince = Date.now(); // réactivée : pas de rétroactif
      next.clipRule = patch.clipRule;
    }
    this.repo.setSetting('fans', next);
    return next;
  }

  /** Appelé quand un fan termine la formation (le bot lui donne le rôle 🎓 Formation validée). */
  onTrainingDone?: (discordId: string) => void | Promise<void>;

  /** Modules de la formation avec leur lien (réglé dans Mars) et l'état coché du fan. */
  training(clipperId: number) {
    const links = parseTrainingLinks(this.settings().training);
    const seen = new Set(this.repo.getSetting<string[]>(`training:${clipperId}`, []));
    const modules = TRAINING_MODULES.map((m) => {
      const url = links.get(m.num) ?? m.url ?? null;
      return { ...m, url, embed: url ? youtubeEmbed(url) : null, video: url && isVideoFile(url) ? url : null, done: seen.has(m.num) };
    });
    return { modules, completed: modules.every((m) => m.done) };
  }

  /** Coche / décoche un module. Tout coché pour la 1re fois → onTrainingDone. */
  setTrainingStep(clipper: Clipper, num: string, done: boolean) {
    if (!TRAINING_MODULES.some((m) => m.num === num)) throw new Error('Module inconnu');
    const before = this.training(clipper.id).completed;
    const seen = new Set(this.repo.getSetting<string[]>(`training:${clipper.id}`, []));
    if (done) seen.add(num);
    else seen.delete(num);
    this.repo.setSetting(`training:${clipper.id}`, [...seen]);
    const after = this.training(clipper.id);
    if (after.completed && !before && !clipper.discordId.startsWith('manual:')) void Promise.resolve(this.onTrainingDone?.(clipper.discordId)).catch(() => {});
    return after;
  }

  trainingDone(clipperId: number): boolean {
    return this.training(clipperId).completed;
  }

  /** Lien perso (connexion 10 min) qui ouvre directement la formation. */
  /** Lien perso (10 min) qui connecte le fan puis l'envoie sur ses boutons « Connecter mon TikTok / Instagram ». */
  /** Lien perso (connecté d'office) vers l'inscription sur le site. */
  /**
   * Relances des fans sans nouveau clip depuis `days` jour(s), une par jour : 1re, 2e, puis 3e relance et suivantes (sans fin).
   * Seulement quand ses comptes ont été relevés après la période (sinon un clip pas encore relevé déclencherait une fausse relance).
   * Renvoie de quoi écrire un message perso (le bot ajoute la citation de son dernier message dans son salon).
   */
  relancesDue(now = Date.now(), days = 1): Array<{ clipperId: number; discordId: string; name: string; ctx: RelanceContext; previous: string | null }> {
    const clientId = this.settings().clientId;
    if (!clientId) return [];
    const DAY = 86_400_000;
    const last = this.repo.lastPublishedByAccount();
    const byFan = new Map<number, { since: number; lastPost: number | null; checked: number | null }>();
    for (const a of this.repo.listActiveAccounts()) {
      if (a.clientId !== clientId) continue;
      const cur = byFan.get(a.clipperId) ?? { since: a.createdAt, lastPost: null, checked: Infinity };
      cur.since = Math.min(cur.since, a.createdAt);
      const p = last.get(a.id) ?? null;
      // Seuls les clips publiés après l'inscription montrent qu'il est actif
      if (p !== null && p >= a.createdAt) cur.lastPost = Math.max(cur.lastPost ?? 0, p);
      // Relevé le plus ancien de ses comptes : on ne sait rien de plus récent
      // Relevé en erreur (quota Apify, compte introuvable…) = on ne sait pas s'il a posté : pas de relance
      cur.checked = a.lastCheckedAt === null || a.lastError || cur.checked === null ? null : Math.min(cur.checked, a.lastCheckedAt);
      byFan.set(a.clipperId, cur);
    }
    const today = dayKey(now);
    const clips = this.clipGains(0);
    const ranks = this.weekRanks(now, 1000);
    const shop = this.fans.items({ activeOnly: true });
    const main = (this.creator.reward && shop.find((i) => i.ref === this.creator.reward!.ref)) ?? shop[0];
    const out: Array<{ clipperId: number; discordId: string; name: string; ctx: RelanceContext; previous: string | null }> = [];
    for (const [clipperId, f] of byFan) {
      const clipper = this.repo.getClipper(clipperId);
      if (!clipper || clipper.discordId.startsWith('manual:')) continue;
      const reference = f.lastPost ?? f.since;
      if (now - reference < days * DAY) continue;
      // Comptes pas encore relevés après la période : on attend le prochain relevé
      if (f.checked === null || !Number.isFinite(f.checked) || f.checked < reference + days * DAY) continue;
      const prev = this.repo.lastRelanceAt(clipperId, 'inactive');
      if (prev !== null && dayKey(prev) === today) continue;
      const mine = clips.filter((c) => c.clipperId === clipperId);
      const latest = [...mine].sort((a, b) => b.publishedAt - a.publishedAt)[0];
      const left = main ? main.price - this.balance(clipperId, now).balance : 0;
      const slot = bestSlot(mine.filter((c) => c.publishedAt > now - 60 * DAY).map((c) => ({ publishedAt: c.publishedAt, views: c.views })));
      out.push({
        clipperId,
        discordId: clipper.discordId,
        name: clipper.username,
        previous: this.repo.lastRelanceMessage(clipperId),
        ctx: {
          level: this.repo.countRelancesSince(clipperId, 'inactive', reference) + 1,
          daysIdle: Math.max(1, Math.floor((now - reference) / DAY)),
          ...(latest ? { lastClip: { views: latest.views, title: latest.title } } : {}),
          ...(main && left > 0 ? { rewardLeft: { coins: left, views: Math.round((left / Math.max(this.settings().pointsPer1000, 1)) * 1000), name: main.name } } : {}),
          ...(ranks.get(clipperId) ? { rank: ranks.get(clipperId)!.rank } : {}),
          ...(slot ? { slot: { from: slot.from, to: slot.to } } : {}),
        },
      });
    }
    return out;
  }

  logRelance(clipperId: number, message: string, now = Date.now()): void {
    this.repo.logRelance(clipperId, 'inactive', message, now);
  }

  signupUrl(clipperId: number, now = Date.now()): string {
    return `${this.loginUrl(clipperId, now)}&next=inscription`;
  }
  connectUrl(clipperId: number, now = Date.now()): string {
    return `${this.loginUrl(clipperId, now)}&next=connect`;
  }

  /** Plateformes que le fan doit encore connecter (comptes reliés, connexion officielle disponible, pas encore faite). */
  toConnect(clipperId: number): Platform[] {
    if (!this.officialLogin) return [];
    const connected = this.officialLogin.connected();
    const accounts = this.repo.listAccountsForClipper(clipperId);
    return this.officialLogin.platforms.filter((p) => accounts.some((a) => a.platform === p) && !accounts.some((a) => a.platform === p && connected.has(a.id)));
  }

  trainingUrl(clipperId: number, now = Date.now()): string {
    return `${this.loginUrl(clipperId, now)}&next=formation`;
  }

  /** Crée le fan au premier /site (rattaché à l'agence du programme). */
  ensureFan(discordId: string, username: string, now = Date.now()): Clipper {
    return this.repo.getClipperByDiscordId(discordId) ?? this.repo.upsertClipper(discordId, username, now, this.settings().clientId);
  }

  /** Adresse publique de l'espace fan. */
  publicSiteUrl(): string {
    return `${this.publicUrl.replace(/\/$/, '')}/fan`;
  }

  loginUrl(clipperId: number, now = Date.now()): string {
    const token = this.fans.createToken(clipperId, 'login', LOGIN_TTL, now);
    return `${this.publicUrl.replace(/\/$/, '')}/fan/login?t=${token}`;
  }

  /** Lien de connexion → session (30 jours). */
  login(token: string, now = Date.now()): string | null {
    const clipperId = this.fans.consumeLogin(token, now);
    return clipperId === null ? null : this.fans.createToken(clipperId, 'session', SESSION_TTL, now);
  }

  /** Connexion « Se connecter avec Discord » : crée le fan au besoin et ouvre une session. */
  loginDiscordUser(discordId: string, username: string, now = Date.now(), avatarUrl: string | null = null): string {
    const fan = this.ensureFan(discordId, username, now);
    if (avatarUrl) this.fans.setAvatar(fan.id, avatarUrl);
    return this.fans.createToken(fan.id, 'session', SESSION_TTL, now);
  }

  clipperFromSession(token: string | undefined, now = Date.now()): Clipper | null {
    if (!token) return null;
    const id = this.fans.sessionClipper(token, now);
    return id === null ? null : (this.repo.getClipper(id) ?? null);
  }

  // --- Points ------------------------------------------------------------------------

  private points(views: number): number {
    return Math.floor((views * this.settings().pointsPer1000) / 1000);
  }

  /** Vues depuis l'inscription (les vues déjà faites avant l'ajout d'un compte ne comptent pas). */
  /** Vues qui rapportent des coins : clips publiés après l'inscription uniquement. */
  private viewsByClipper(_now = Date.now()): Map<number, number> {
    const clientId = this.settings().clientId;
    return clientId ? this.fans.freshClipViews(clientId, 0, this.clipRuleSince(), this.countFrom()) : new Map();
  }

  /** Vues qui rapportent des coins (règles du programme) gagnées depuis `from`, par clippeur ; null si pas de programme. */
  countedViewsSince(from: number): { clientId: number; views: Map<number, number> } | null {
    const clientId = this.settings().clientId;
    return clientId ? { clientId, views: this.fans.freshClipViews(clientId, from, this.clipRuleSince(), this.countFrom()) } : null;
  }

  balance(clipperId: number, now = Date.now()): FanBalance {
    const views = this.viewsByClipper(now).get(clipperId) ?? 0;
    const earned = this.points(views) + this.fans.bonus(clipperId);
    const spent = this.fans.spent(clipperId);
    return { views, earned, spent, balance: earned - spent };
  }

  // --- Motivation des clippeurs (récap du lundi, dépassements, clip de la semaine, défi du week-end, feedback) ---

  /** Clips qui comptent, avec les vues gagnées depuis `from`, et le Discord / pseudo du clippeur. */
  clipGains(from: number) {
    const clientId = this.settings().clientId;
    if (!clientId) return [];
    return this.fans.clipGains(clientId, from, this.clipRuleSince(), this.countFrom()).map((c) => {
      const clipper = this.repo.getClipper(c.clipperId);
      return { ...c, discordId: clipper?.discordId ?? null, username: clipper?.username ?? '?' };
    });
  }

  discordOf(clipperId: number): string | null {
    return this.repo.getClipper(clipperId)?.discordId ?? null;
  }

  /** Fans inscrits (au moins un compte suivi dans le programme). */
  private programFans(): Clipper[] {
    const clientId = this.settings().clientId;
    if (!clientId) return [];
    const ids = new Set(this.repo.listActiveAccounts().filter((a) => a.clientId === clientId).map((a) => a.clipperId));
    return [...ids].map((id) => this.repo.getClipper(id)).filter((c): c is Clipper => !!c && !c.discordId.startsWith('manual:'));
  }

  /** Place de chaque fan au classement de la semaine (top `limit`). */
  weekRanks(now = Date.now(), limit = 30): Map<number, { rank: number; views: number; name: string }> {
    return new Map(this.leaderboard(now, limit).map((r) => [r.id, { rank: r.rank, views: r.views, name: r.name }]));
  }

  /** Récap perso du lundi (envoyé dans le salon privé) : vues de la semaine, place, solde, ce qu'il manque, meilleur créneau. */
  weeklyRecaps(now = Date.now()): Array<{ clipperId: number; discordId: string; text: string }> {
    const ranks = this.weekRanks(now, 1000);
    const shop = this.fans.items({ activeOnly: true });
    const main = (this.creator.reward && shop.find((i) => i.ref === this.creator.reward!.ref)) ?? shop[0];
    const all = this.clipGains(0);
    const nf = (n: number) => Math.round(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');
    return this.programFans().map((c) => {
      const r = ranks.get(c.id);
      const b = this.balance(c.id, now);
      const lines = ['📊 **Ton récap de la semaine**'];
      if (r) lines.push(`• **${nf(r.views)} vues** qui comptent cette semaine (+${nf(this.points(r.views))} coins)`, `• Classement de la semaine : **${r.rank}${r.rank === 1 ? 'er' : 'e'}**`);
      else lines.push('• Aucune vue qui compte cette semaine : un clip aujourd’hui et tu repars 💪');
      if (main) {
        const left = main.price - b.balance;
        lines.push(left > 0 ? `• Solde : **${nf(b.balance)} coins**, encore ${nf(left)} coins (≈ ${nf((left / Math.max(this.settings().pointsPer1000, 1)) * 1000)} vues) pour **${main.name}**` : `• Solde : **${nf(b.balance)} coins** : tu peux échanger **${main.name}** sur le site 🎁`);
      }
      const slot = bestSlot(all.filter((x) => x.clipperId === c.id && x.publishedAt > now - 60 * 86_400_000).map((x) => ({ publishedAt: x.publishedAt, views: x.views })));
      if (slot) lines.push(`• ⏰ Ton meilleur créneau : **${slot.from} h - ${slot.to} h** (tes clips y font ${Math.round(slot.ratio * 10) / 10}× plus de vues)`);
      return { clipperId: c.id, discordId: c.discordId, text: lines.join('\n') };
    });
  }

  /** Feedback auto des clips publiés il y a 1 à 4 jours, comparés aux autres clips du fan (2 par fan et par jour au plus, une fois par clip). */
  clipFeedback(now = Date.now()): Array<{ clipperId: number; discordId: string; text: string }> {
    const all = this.clipGains(0);
    const nf = (n: number) => Math.round(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');
    const out: Array<{ clipperId: number; discordId: string; text: string }> = [];
    const byFan = new Map<number, typeof all>();
    for (const c of all) if (c.discordId) byFan.set(c.clipperId, [...(byFan.get(c.clipperId) ?? []), c]);
    const day = dayKey(now);
    for (const [id, clips] of byFan) {
      // Une seule fournée de conseils par jour et par fan (2 au plus)
      if (this.fans.wasNotified(id, `feedback-day:${day}`)) continue;
      let sent = 0;
      const fresh = clips.filter((c) => c.publishedAt <= now - 86_400_000 && c.publishedAt >= now - 4 * 86_400_000).sort((a, b) => b.publishedAt - a.publishedAt);
      for (const clip of fresh) {
        if (sent >= 2) break;
        const key = `feedback:${clip.videoId}`;
        if (this.fans.wasNotified(id, key)) continue;
        const others = clips.filter((c) => c.videoId !== clip.videoId && c.publishedAt > now - 60 * 86_400_000 && c.publishedAt < now - 86_400_000).map((c) => c.views);
        const v = clipVerdict(clip.views, others);
        if (!v) continue;
        this.fans.markNotified(id, key, now);
        if (!sent) this.fans.markNotified(id, `feedback-day:${day}`, now);
        out.push({ clipperId: id, discordId: clip.discordId!, text: verdictMessage(v, clip, others, clip.videoId, nf) });
        sent++;
      }
    }
    return out;
  }

  /** Défi du week-end : fans qui ont publié au moins WEEKEND_GOAL clips (qui comptent) dans la fenêtre. */
  weekendWinners(from: number, to: number): Array<{ clipperId: number; discordId: string; clips: number }> {
    const counts = new Map<number, { discordId: string; clips: number }>();
    for (const c of this.clipGains(0)) {
      if (!c.discordId || c.publishedAt < from || c.publishedAt >= to) continue;
      const cur = counts.get(c.clipperId) ?? { discordId: c.discordId, clips: 0 };
      cur.clips++;
      counts.set(c.clipperId, cur);
    }
    return [...counts].filter(([, v]) => v.clips >= WEEKEND_GOAL).map(([clipperId, v]) => ({ clipperId, ...v }));
  }

  /** Quêtes arrêtées : coins donnés retirés (une seule fois au démarrage). */
  undoQuests(): number {
    return this.fans.undoQuests((key) => (key === 'quest:accounts' ? QUEST_COINS.accounts : QUEST_COINS.streak7));
  }

  /** Badge « Fondateur » : inscrit dans les 14 premiers jours du programme. */
  private isFounder(clipper: Clipper): boolean {
    const clientId = this.settings().clientId;
    if (!clientId) return false;
    const first = this.repo.listActiveAccounts().filter((a) => a.clientId === clientId).reduce((m, a) => Math.min(m, a.createdAt), Infinity);
    const mine = this.repo.listAccountsForClipper(clipper.id).reduce((m, a) => Math.min(m, a.createdAt), Infinity);
    return Number.isFinite(first) && mine <= first + 14 * 86_400_000;
  }

  // --- Quêtes (site + coins donnés par le bot) ---------------------------------------

  quests(clipperId: number, now = Date.now()): Quest[] {
    const platforms = new Set(this.repo.listAccountsForClipper(clipperId).filter((a) => a.active).map((a) => a.platform)).size;
    const days = this.fans.clipDays(clipperId, now - 120 * 86_400_000).map((t) => dayKey(t));
    return buildQuests({ platforms, views: this.balance(clipperId, now).views, streak: currentStreak(days, now).length });
  }

  /**
   * Donne les coins des quêtes réussies, une seule fois chacune (série de 7 jours : à chaque tranche de 7 jours d'une même série).
   * Renvoie les récompenses données, pour que le bot les annonce dans le salon privé.
   */
  awardQuests(now = Date.now()): Array<{ clipperId: number; discordId: string; title: string; coins: number }> {
    const clientId = this.settings().clientId;
    if (!clientId) return [];
    const out: Array<{ clipperId: number; discordId: string; title: string; coins: number }> = [];
    const fans = new Set(this.repo.listActiveAccounts().filter((a) => a.clientId === clientId).map((a) => a.clipperId));
    for (const id of fans) {
      const clipper = this.repo.getClipper(id);
      if (!clipper || clipper.discordId.startsWith('manual:')) continue;
      const give = (key: string, title: string, coins: number) => {
        if (this.fans.wasNotified(id, key)) return;
        this.fans.markNotified(id, key, now);
        this.fans.addBonus(id, coins);
        out.push({ clipperId: id, discordId: clipper.discordId, title, coins });
      };
      const platforms = new Set(this.repo.listAccountsForClipper(id).filter((a) => a.active).map((a) => a.platform)).size;
      if (platforms >= 3) give('quest:accounts', 'Inscris tes 3 comptes', QUEST_COINS.accounts);
      const days = this.fans.clipDays(id, now - 120 * 86_400_000).map((t) => dayKey(t));
      const streak = currentStreak(days, now);
      for (let k = 1; k <= Math.floor(streak.length / 7); k++) give(`quest:streak:${streak.start}:${k}`, `1 clip par jour pendant ${7 * k} jours`, QUEST_COINS.streak7);
    }
    return out;
  }

  // --- Espace fan --------------------------------------------------------------------

  /** Fans (Discord) dont le 1er clip a été détecté : ils débloquent la communauté. */
  firstClipDone(): Set<string> {
    const s = this.settings();
    return s.clientId ? this.fans.firstClipDiscordIds(s.clientId, this.clipRuleSince(), this.countFrom()) : new Set();
  }

  /** Classement de la semaine (7 derniers jours) : pseudo, avatar, vues, coins gagnés. */
  leaderboard(now = Date.now(), limit = 10) {
    const s = this.settings();
    if (!s.clientId) return [];
    // Vues des 7 derniers jours, sur les clips publiés après l'inscription (comme les coins)
    const rows = [...this.fans.freshClipViews(s.clientId, now - 7 * 86_400_000, this.clipRuleSince(), this.countFrom())]
      .filter(([, views]) => views > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, views]) => ({ clipper: this.repo.getClipper(id), views }))
      .filter((r) => !!r.clipper);
    const avatars = this.fans.avatars(rows.map((r) => r.clipper!.id));
    return rows.map((r, i) => ({ rank: i + 1, id: r.clipper!.id, name: r.clipper!.username, avatar: avatars.get(r.clipper!.id) ?? null, views: r.views, coins: this.points(r.views) }));
  }

  /** Classement sur une période [from, to[ : vues gagnées entre les deux dates (clips qui comptent). */
  periodLeaderboard(from: number, to: number, limit = 10) {
    const s = this.settings();
    if (!s.clientId) return [];
    const since = this.fans.freshClipViews(s.clientId, from, this.clipRuleSince(), this.countFrom());
    const after = this.fans.freshClipViews(s.clientId, to, this.clipRuleSince(), this.countFrom());
    const rows = [...since]
      .map(([id, v]) => [id, v - (after.get(id) ?? 0)] as const)
      .filter(([, views]) => views > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, views]) => ({ clipper: this.repo.getClipper(id), views }))
      .filter((r) => !!r.clipper);
    const avatars = this.fans.avatars(rows.map((r) => r.clipper!.id));
    return rows.map((r, i) => ({ rank: i + 1, id: r.clipper!.id, discordId: r.clipper!.discordId, name: r.clipper!.username, avatar: avatars.get(r.clipper!.id) ?? null, views: r.views }));
  }

  /** Début (minuit, heure de Paris) du mois de `now`, et du mois précédent. */
  static monthStart(now: number, offset = 0): number {
    const [y, m] = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).split('-').map(Number) as [number, number];
    return parisMidnight(Date.UTC(y, m - 1 + offset, 1, 12));
  }

  /** Classement du mois en cours (si le créateur a un classement du mois). */
  monthLeaderboard(now = Date.now(), limit = 10) {
    return this.creator.monthlyPrize ? this.periodLeaderboard(FanService.monthStart(now), now + 1, limit) : [];
  }

  /**
   * 1er du mois : les N premiers du mois écoulé reçoivent la récompense principale (commande offerte, livrée
   * automatiquement si l'API de livraison est branchée). Une seule fois par mois. Renvoie les gagnants.
   */
  awardMonthlyPrize(now = Date.now()): { month: string; winners: Array<{ rank: number; discordId: string; name: string; views: number }>; reward: string; manual?: true } | null {
    const n = this.creator.monthlyPrize;
    if (!n) return null;
    const start = FanService.monthStart(now, -1);
    const end = FanService.monthStart(now);
    const key = new Date(start + 12 * 3_600_000).toISOString().slice(0, 7);
    if (this.botState<string>('monthly-prize', '') === key) return null;
    this.setBotState('monthly-prize', key);
    const month = new Date(start + 12 * 3_600_000).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
    const label = this.creator.monthlyPrizeLabel;
    if (label) {
      const winners = this.periodLeaderboard(start, end, n);
      return { month, reward: label, manual: true, winners: winners.map(({ rank, discordId, name, views }) => ({ rank, discordId, name, views })) };
    }
    const shop = this.fans.items({ activeOnly: true });
    const item = (this.creator.reward && shop.find((i) => i.ref === this.creator.reward!.ref)) ?? shop[0];
    if (!item) return null;
    const winners = this.periodLeaderboard(start, end, n);
    for (const w of winners) this.fans.giftOrder(w.id, item.id, `top ${w.rank} de ${month}`, now);
    return { month, reward: item.name, winners: winners.map(({ rank, discordId, name, views }) => ({ rank, discordId, name, views })) };
  }

  // --- Automatisations du serveur Discord (rôles de niveau, classement, vidéos) ---------

  /** Niveau actuel de chaque fan relié à Discord. */
  fanLevels(now = Date.now(), windowDays?: number): Array<{ clipperId: number; discordId: string; username: string; views: number; level: number }> {
    const s = this.settings();
    if (!s.clientId) return [];
    // windowDays : vues qui comptent des N derniers jours (grades du mois glissant), sinon depuis toujours
    const views = windowDays ? this.fans.freshClipViews(s.clientId, now - windowDays * 86_400_000, this.clipRuleSince(), this.countFrom()) : this.viewsByClipper(now);
    return this.repo
      .listClippers({ clientId: s.clientId })
      .filter((c) => !c.discordId.startsWith('manual:'))
      .map((c) => {
        const v = views.get(c.id) ?? 0;
        return { clipperId: c.id, discordId: c.discordId, username: c.username, views: v, level: levelOf(v, this.creator.levels) };
      });
  }

  /**
   * Funnel d'onboarding : où les fans s'arrêtent, du serveur Discord jusqu'à l'échange d'une récompense.
   * Étapes Discord = photo prise par le bot (au plus 1 fois par heure) ; étapes suivantes = base de données.
   */
  onboardingFunnel(now = Date.now()) {
    const s = this.settings();
    const discord = this.botState<{ at?: number; exact?: boolean; members?: number; reader?: number; rules?: number; trained?: number }>('onboarding', {});
    const fans = s.clientId ? this.repo.listClippers({ clientId: s.clientId }).filter((c) => !c.discordId.startsWith('manual:')) : [];
    const registered = fans.filter((c) => this.repo.listAccountsForClipper(c.id).some((a) => a.active));
    const firstClip = this.firstClipDone();
    const views = this.viewsByClipper(now);
    const buyers = new Set(this.fans.orders({ limit: 100_000 }).filter((o) => o.status !== 'refunded').map((o) => o.clipperId));
    const steps = [
      { key: 'members', label: 'Arrivés sur le serveur', count: discord.members ?? null },
      { key: 'reader', label: 'Ont lu la bienvenue', count: discord.reader ?? null },
      { key: 'rules', label: 'Ont accepté les règles', count: discord.rules ?? null },
      { key: 'trained', label: 'Ont validé la formation', count: discord.trained ?? null },
      { key: 'registered', label: 'Inscrits (comptes reliés)', count: registered.length },
      { key: 'firstClip', label: '1er clip détecté', count: fans.filter((c) => firstClip.has(c.discordId)).length },
      { key: 'earning', label: 'Gagnent des coins', count: fans.filter((c) => (views.get(c.id) ?? 0) > 0).length },
      { key: 'canBuy', label: 'Ont assez de coins pour une récompense', count: this.fanTiers(now).filter((t) => t.tier >= 0 || buyers.has(t.clipperId)).length },
      { key: 'bought', label: 'Ont échangé une récompense', count: fans.filter((c) => buyers.has(c.id)).length },
    ];
    return { steps, discordAt: discord.at ?? null, exact: discord.exact ?? false };
  }

  /** Paliers Discord = les objets en vente, du moins cher au plus cher. */
  shopTiers(): Array<{ itemId: number; name: string; price: number }> {
    return this.fans
      .items({ activeOnly: true })
      .map((i) => ({ itemId: i.id, name: i.name, price: i.price }))
      .sort((x, y) => x.price - y.price);
  }

  /** Palier atteint par chaque fan (coins gagnés au total, achats non déduits : un achat ne fait pas perdre le palier). -1 = aucun. */
  fanTiers(now = Date.now()): Array<{ clipperId: number; discordId: string; earned: number; tier: number }> {
    const s = this.settings();
    if (!s.clientId) return [];
    const tiers = this.shopTiers();
    const views = this.viewsByClipper(now);
    return this.repo
      .listClippers({ clientId: s.clientId })
      .filter((c) => !c.discordId.startsWith('manual:'))
      .map((c) => {
        const earned = this.points(views.get(c.id) ?? 0) + this.fans.bonus(c.id);
        return { clipperId: c.id, discordId: c.discordId, earned, tier: tiers.reduce((acc, t, i) => (earned >= t.price ? i : acc), -1) };
      });
  }

  /** Classement de la semaine avec l'ID Discord (pour mentionner et donner le rôle Top 3). */
  weeklyTop(now = Date.now(), limit = 10) {
    return this.leaderboard(now, limit).map((r) => ({ ...r, discordId: this.repo.getClipper(r.id)?.discordId ?? null }));
  }

  /** Petit état persistant des automatisations (dernière vidéo vue, semaine postée…). */
  botState<T>(key: string, fallback: T): T {
    return this.repo.getSetting<T>(`bot:${key}`, fallback);
  }

  setBotState(key: string, value: unknown): void {
    this.repo.setSetting(`bot:${key}`, value);
  }

  /** Chaînes YouTube du créateur (« Chaine1,Chaine2 » : la 1re sert pour la photo). */
  youtubeHandles(): string[] {
    return this.settings().creatorYoutube.split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean);
  }

  /** Dernières vidéos longues des chaînes du créateur (les Shorts ne sont pas annoncés). */
  async latestVideos(apiKey: string, limit = 5): Promise<Array<{ id: string; title: string; url: string; thumbnail: string | null; publishedAt: string }>> {
    const handles = this.youtubeHandles();
    if (!handles.length) return [];
    const key = handles.join(',');
    let uploads = this.botState<{ handle: string; playlist?: string; playlists?: string[] } | null>('yt-uploads', null);
    // Playlists « UULF… » = vidéos longues uniquement (sans les Shorts) ; recalculées si les chaînes changent
    if (!uploads || uploads.handle !== key || !uploads.playlists?.every((p) => p.startsWith('UULF'))) {
      const playlists: string[] = [];
      for (const handle of handles) {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent('@' + handle)}&key=${apiKey}`, { signal: AbortSignal.timeout(8000) });
        const r = (await res.json()) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
        const playlist = r.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!playlist) throw new Error(`chaîne @${handle} introuvable`);
        playlists.push(`UULF${playlist.slice(2)}`);
      }
      uploads = { handle: key, playlists };
      this.setBotState('yt-uploads', uploads);
      // Nouvelle liste : on repart de zéro (1er passage = mémorise l'existant sans rien poster)
      this.setBotState('yt-seen', null);
    }
    const all = [];
    for (const playlist of uploads.playlists!) {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${limit}&playlistId=${playlist}&key=${apiKey}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
      const r = (await res.json()) as { items?: Array<{ snippet: { title: string; publishedAt: string; resourceId: { videoId: string }; thumbnails?: Record<string, { url: string }> } }> };
      all.push(
        ...(r.items ?? []).map((i) => ({
          id: i.snippet.resourceId.videoId,
          title: i.snippet.title,
          url: `https://www.youtube.com/watch?v=${i.snippet.resourceId.videoId}`,
          thumbnail: i.snippet.thumbnails?.maxres?.url ?? i.snippet.thumbnails?.high?.url ?? null,
          publishedAt: i.snippet.publishedAt,
        })),
      );
    }
    // Plus récentes d'abord, toutes chaînes confondues
    return all.sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)).slice(0, limit * handles.length);
  }

  me(clipper: Clipper, now = Date.now()) {
    const s = this.settings();
    // Coins affichés seulement sur les clips qui comptent (sinon 0 : vieux clip, compte pas vérifié, légende sans le créateur)
    const clips = this.fans.clips(clipper.id, 40, this.clipRuleSince(), this.countFrom()).map((c) => ({ ...c, coins: c.counted ? this.points(c.gained) : 0 }));
    return {
      id: clipper.id,
      avatar: this.fans.avatar(clipper.id),
      clips,
      clipCount: this.fans.clipCount(clipper.id),
      weekRank: this.leaderboard(now, 100).find((r) => r.id === clipper.id)?.rank ?? null,
      notify: this.fans.notifyEnabled(clipper.id),
      programName: s.programName,
      pointsPer1000: s.pointsPer1000,
      username: clipper.username,
      roblox: this.fans.roblox(clipper.id),
      rewardAccount: this.rewardAccount(clipper.id),
      accounts: (() => {
        const connected = this.officialLogin?.connected() ?? new Set<number>();
        return this.repo.listAccountsForClipper(clipper.id).map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, url: a.url, connected: connected.has(a.id) }));
      })(),
      officialLogin: this.officialLogin?.platforms ?? [],
      ...this.balance(clipper.id, now),
      items: this.fans.items({ activeOnly: true }),
      orders: this.fans.orders({ clipperId: clipper.id, limit: 50 }),
      // Quêtes arrêtées (17 oct, demande d'Alex) : plus affichées ni récompensées
      quests: [] as Quest[],
      maxClipViews: this.fans.clips(clipper.id, 500).reduce((m, c) => Math.max(m, c.views), 0),
      clipDays: [...new Set(this.fans.clipDays(clipper.id, now - 120 * 86_400_000).map((t) => dayKey(t)))],
      founder: this.isFounder(clipper),
    };
  }

  /** Infos du programme pour la FAQ automatique du salon ❓│aide. */
  faqInfo(siteUrl: string): FaqInfo {
    const s = this.settings();
    const shop = this.fans.items({ activeOnly: true });
    const main = (this.creator.reward && shop.find((i) => i.ref === this.creator.reward!.ref)) ?? shop[0];
    return {
      creatorName: this.creator.creatorName,
      tag: this.tagLabel(),
      countFrom: this.countFromLabel(),
      pointsPer1000: s.pointsPer1000,
      reward: main ? { name: main.name, price: main.price } : null,
      siteUrl,
      officialLogin: this.officialLogin?.platforms ?? [],
    };
  }

  /** « Pourquoi j'ai 0 coins ? » : état des comptes et des clips du fan. */
  coinsState(clipper: Clipper, now = Date.now()): CoinsState {
    const ruleSince = this.clipRuleSince();
    const connected = this.officialLogin?.connected() ?? new Set<number>();
    const clips = this.fans.clips(clipper.id, 200, ruleSince, this.countFrom());
    const b = this.balance(clipper.id, now);
    return {
      accounts: this.repo.listAccountsForClipper(clipper.id).filter((a) => a.active).map((a) => ({
        platform: a.platform,
        handle: a.handle,
        verified: a.verifiedAt !== null || connected.has(a.id),
        checked: a.lastCheckedAt !== null,
        error: a.lastError ? fanAccountError(a.lastError) : null,
      })),
      clips: clips.length,
      counted: clips.filter((c) => c.counted).length,
      refusedTag: this.settings().clipRule && ruleSince ? this.repo.refusedClipCount(clipper.id, ruleSince) : 0,
      balance: b.balance,
      views: b.views,
      tag: this.tagLabel(),
      countFrom: this.countFromLabel(),
      pointsPer1000: this.settings().pointsPer1000,
    };
  }

  /** Réponse perso de la FAQ automatique (solde, ce qu'il manque, classement, un clip précis). */
  faqPersonal(intent: FaqIntent, clipper: Clipper, text: string, now = Date.now()): string[] {
    const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
    const s = this.settings();
    if (intent === 'coins') return coinsDiagnosis(this.coinsState(clipper, now));
    const b = this.balance(clipper.id, now);
    const info = this.faqInfo('');
    if (intent === 'balance') {
      const lines = [`🪙 Tu as **${fmt(b.balance)} coins** (${fmt(b.views)} vues qui comptent).`];
      if (info.reward) lines.push(b.balance >= info.reward.price ? `✅ Assez pour **${info.reward.name}** : échange-le sur le site !` : `Il t'en manque **${fmt(info.reward.price - b.balance)}** pour **${info.reward.name}**.`);
      if (!b.balance) lines.push(...coinsDiagnosis(this.coinsState(clipper, now)).map((l) => `• ${l}`));
      return lines;
    }
    if (intent === 'missing') {
      if (!info.reward) return [`🪙 Tu as **${fmt(b.balance)} coins**. Les récompenses sont dans la boutique du site.`];
      if (b.balance >= info.reward.price) return [`✅ Tu as **${fmt(b.balance)} coins** : c'est assez pour **${info.reward.name}** ! Échange-le sur le site, onglet **Récompenses** 🎁`];
      const left = info.reward.price - b.balance;
      return [`🎯 Il te manque **${fmt(left)} coins** pour **${info.reward.name}** (tu en as ${fmt(b.balance)} / ${fmt(info.reward.price)}).`, `Ça fait environ **${fmt((left / Math.max(s.pointsPer1000, 1)) * 1000)} vues** en plus sur des clips qui comptent 💪`];
    }
    if (intent === 'rank') {
      const row = this.leaderboard(now, 1000).find((r) => r.id === clipper.id);
      return row
        ? [`🏆 Tu es **${row.rank}${row.rank === 1 ? 'er' : 'e'}** du classement de la semaine avec **${fmt(row.views)} vues** qui comptent.`, row.rank > 3 ? 'Le top 3 du lundi gagne un rôle spécial, accroche-toi ! 🔥' : 'Tu es dans le top 3, garde le rythme ! 🔥']
        : ['Tu n\'es pas encore dans le classement de cette semaine : il faut des vues sur des clips qui comptent (postés depuis l\'inscription) 💪'];
    }
    if (intent === 'clip') {
      const key = videoKey(text);
      const clip = key ? this.fans.findClip(key) : undefined;
      const tag = info.tag;
      if (!clip) {
        return [
          '🔎 Je ne trouve pas ce clip dans nos relevés. Raisons possibles :',
          '• il a été posté **après le dernier relevé** (les vues sont relevées chaque nuit 🌙) ;',
          '• il est sur un compte **pas relié** à ton inscription (vérifie dans 📝│inscription).',
        ];
      }
      if (clip.clipperId !== clipper.id) return ['⚠️ Ce clip est sur un compte relié à **un autre membre**. Si c\'est ton compte, préviens le staff.'];
      const ruleSince = this.clipRuleSince();
      const reasons: string[] = [];
      if (!clip.verified) reasons.push(`le compte @${clip.handle} est **en vérification par le staff** (gros compte)`);
      const from = this.countFrom();
      if (clip.publishedAt !== null && clip.publishedAt < clip.accountCreatedAt && (from === null || clip.publishedAt < from))
        reasons.push(from === null ? 'il a été publié **avant ton inscription** (seuls les nouveaux clips rapportent)' : `il a été publié **avant le ${this.countFromLabel()}**`);
      if (ruleSince && clip.publishedAt !== null && clip.publishedAt >= ruleSince && clip.clipCheck !== 'ok') reasons.push(`sa légende ne contient pas **${tag}** (ajoute-le : relu au prochain relevé, ou demande au staff)`);
      const gained = from !== null && clip.publishedAt !== null && clip.publishedAt >= from ? clip.views : clip.gained;
      if (!reasons.length) return [`✅ Ce clip compte ! **${fmt(clip.views)} vues**${gained === clip.views ? '' : ` dont ${fmt(gained)} depuis le suivi`} → **+${fmt(this.points(gained))} coins** 🪙`];
      return [`❌ Ce clip (${fmt(clip.views)} vues) ne rapporte pas de coins parce que :`, ...reasons.map((r) => `• ${r}`)];
    }
    return [];
  }

  logFaqMiss(discordId: string, username: string, text: string): void {
    this.fans.addFaqMiss(discordId, username, text);
  }

  addAccounts(clipper: Clipper, text: string) {
    const links = parseAccountLinks(text);
    if (!links.length) throw new Error('Colle un lien de profil TikTok, Instagram ou YouTube');
    const result = { added: [] as AccountLink[], conflicts: [] as AccountLink[] };
    for (const link of links) {
      const r = this.repo.registerAccount({ clipperId: clipper.id, clientId: clipper.clientId, ...link });
      if (r.created && this.settings().accountReview) this.repo.setAccountVerified(r.account.id, null);
      if (r.conflict) result.conflicts.push(link);
      else result.added.push(link);
    }
    return result;
  }

  /**
   * Formulaire /inscription : un champ par plateforme (@pseudo ou lien). Champ vide = plateforme retirée.
   * Un compte déjà relié à quelqu'un d'autre est refusé.
   */
  setAccounts(clipper: Clipper, input: Partial<Record<Platform, string>>, slot = 1) {
    const out = { linked: [] as AccountLink[], removed: [] as Platform[], conflicts: [] as AccountLink[], invalid: [] as Platform[] };
    for (const platform of ['tiktok', 'youtube', 'instagram'] as const) {
      const raw = input[platform];
      if (raw === undefined) continue;
      const current = this.repo.listAccountsForClipper(clipper.id).filter((a) => a.platform === platform && a.slot === slot);
      const value = raw.trim();
      if (!value) {
        for (const a of current) this.repo.deactivateAccount(a.id);
        if (current.length) out.removed.push(platform);
        continue;
      }
      const link = parseAccountInput(platform, value);
      if (!link) {
        out.invalid.push(platform);
        continue;
      }
      if (current.some((a) => a.handle === link.handle)) {
        out.linked.push(link);
        continue;
      }
      // Déjà relié par ce fan dans l'autre emplacement (/inscription ↔ /inscription2) : on ne le déplace pas
      if (this.repo.listAccountsForClipper(clipper.id).some((a) => a.active && a.platform === platform && a.handle === link.handle && a.slot !== slot)) {
        out.linked.push(link);
        continue;
      }
      const r = this.repo.registerAccount({ clipperId: clipper.id, clientId: clipper.clientId, ...link, slot });
      if (r.conflict) {
        out.conflicts.push(link);
        continue;
      }
      // Nouveau compte : file « à vérifier » du staff (ses vues comptent dès la validation, rétroactivement)
      if (r.created && this.settings().accountReview) this.repo.setAccountVerified(r.account.id, null);
      for (const a of current) this.repo.deactivateAccount(a.id);
      out.linked.push(link);
    }
    return out;
  }

  accountsOf(clipperId: number) {
    return this.repo.listAccountsForClipper(clipperId);
  }

  removeAccount(clipper: Clipper, accountId: number): void {
    const account = this.repo.listAccountsForClipper(clipper.id).find((a) => a.id === accountId);
    if (!account) throw new Error('Compte introuvable');
    this.repo.deactivateAccount(account.id);
  }

  async linkRoblox(clipper: Clipper, username: string): Promise<{ username: string; userId: number }> {
    const found = await this.resolveRoblox(username.trim());
    if (!found) throw new Error('Pseudo Roblox introuvable');
    const owner = this.fans.clipperByRoblox(found.id);
    if (owner !== null && owner !== clipper.id) throw new Error('Ce compte Roblox est déjà relié à un autre fan');
    this.fans.setRoblox(clipper.id, found.name, found.id);
    return { username: found.name, userId: found.id };
  }

  // --- Règle gratuite : un clip doit citer le créateur dans sa légende (sinon il ne rapporte rien) ---

  /** Règle active (réglage Mars, activée par défaut) : date à partir de laquelle elle s'applique, sinon null. */
  private clipRuleSince(): number | null {
    const s = this.settings();
    return s.clipRule && s.clipRuleSince ? s.clipRuleSince : null;
  }

  /** Mots-clés obligatoires dans la légende (réglés dans Mars, sinon nom + chaînes YouTube du créateur). */
  clipKeywords(): string[] {
    return clipKeywords(this.settings().clipKeywords, this.creator.creatorName, this.youtubeHandles(), this.creator.clipKeywords);
  }

  /** Revérifie les clips publiés depuis l'activation de la règle (gratuit : simple lecture du titre). */
  checkClips(): { validés: number; refusés: number } {
    const clientId = this.settings().clientId;
    const since = this.clipRuleSince();
    const done = { validés: 0, refusés: 0 };
    if (!clientId || since === null) return done;
    const keywords = this.clipKeywords();
    const shown = this.settings().clipKeywords.trim() || keywords.join(', ');
    for (const clip of this.fans.clipsToCheck(clientId, since)) {
      const ok = citesCreator(clip.title, keywords);
      if ((clip.check === 'ok') === ok && clip.check !== null) continue;
      this.fans.setClipCheck(clip.id, ok, ok ? 'cite le créateur' : `la légende ne cite pas le créateur (${shown})`);
      if (ok) done.validés++;
      else done.refusés++;
    }
    return done;
  }

  // --- Anti-triche : comptes vérifiés par un code dans la bio, gros comptes contrôlés par le staff ---

  /** Collecteurs (YouTube API, Apify) pour lire la bio à la demande ; branchés au démarrage. */
  fetchers?: FetcherRegistry;

  /** Connexions officielles gratuites (TikTok, Instagram), branchées au démarrage si les apps sont configurées. */
  officialLogin?: { platforms: Platform[]; connected(): Set<number> };

  /** Inscription terminée depuis le site (3 réseaux reliés) : le bot donne les rôles Discord et ouvre le salon privé. */
  onRegistered?: (discordId: string, accounts: string[]) => Promise<void> | void;

  /** Réseaux encore manquants pour l'inscription (TikTok, YouTube et Instagram sont obligatoires). */
  missingPlatforms(clipperId: number): Platform[] {
    const active = this.repo.listAccountsForClipper(clipperId).filter((a) => a.active);
    return (['tiktok', 'youtube', 'instagram'] as const).filter((p) => !active.some((a) => a.platform === p));
  }

  /** Les 3 réseaux viennent d'être complétés (ils manquaient avant) : prévient le bot. */
  async finishRegistration(clipper: Clipper, missingBefore: Platform[]): Promise<boolean> {
    if (!missingBefore.length || this.missingPlatforms(clipper.id).length || clipper.discordId.startsWith('manual:')) return false;
    const names = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' } as const;
    const accounts = this.repo.listAccountsForClipper(clipper.id).filter((a) => a.active).map((a) => `${names[a.platform as Platform]} @${a.handle}`);
    await Promise.resolve(this.onRegistered?.(clipper.discordId, accounts)).catch(() => {});
    return true;
  }

  /**
   * Inscription depuis le site : comptes tapés (@ ou lien) + compte de livraison. Un champ vide ne retire rien
   * (un compte connecté officiellement n'a pas de champ). Renvoie ce qui a été relié et ce qu'il manque encore.
   */
  /** La chaîne YouTube existe-t-elle ? En cas de doute (quota, réseau, pas de clé), on laisse passer. */
  async youtubeExists(value: string): Promise<boolean> {
    const link = parseAccountInput('youtube', value);
    const yt = this.fetchers?.youtube;
    if (!link || !yt?.fetchProfile) return true;
    try {
      await yt.fetchProfile({ handle: link.handle, externalId: null });
      return true;
    } catch (err) {
      return !/introuvable|not found/i.test(err instanceof Error ? err.message : String(err));
    }
  }

  /** Comptes introuvables (pseudo faux, nom de chaîne au lieu du @, compte supprimé) : à faire corriger par le fan. */
  brokenAccounts(): Array<{ accountId: number; clipperId: number; discordId: string; platform: Platform; handle: string }> {
    const clientId = this.settings().clientId;
    if (clientId === null) return [];
    return this.repo
      .listActiveAccounts()
      .filter((a) => a.clientId === clientId && a.lastError && /introuvable|not found|404/i.test(a.lastError))
      .flatMap((a) => {
        const discordId = this.fans.discordIdOf(a.clipperId);
        return discordId ? [{ accountId: a.id, clipperId: a.clipperId, discordId, platform: a.platform, handle: a.handle }] : [];
      });
  }

  async siteRegister(clipper: Clipper, input: Partial<Record<Platform, string>> & { reward?: string }) {
    const before = this.missingPlatforms(clipper.id);
    const typed: Partial<Record<Platform, string>> = Object.fromEntries((['tiktok', 'youtube', 'instagram'] as const).filter((p) => input[p]?.trim()).map((p) => [p, input[p]!]));
    // Chaîne YouTube vérifiée tout de suite (gratuit) : un pseudo TikTok ou le nom de la chaîne à la place du @ = jamais relue
    const notFound: Platform[] = [];
    if (typed.youtube && !(await this.youtubeExists(typed.youtube))) {
      delete typed.youtube;
      notFound.push('youtube');
    }
    const res = { ...this.setAccounts(clipper, typed), notFound };
    let rewardError: string | undefined;
    const reward = input.reward?.trim();
    if (reward && reward.toLowerCase() !== (this.rewardAccount(clipper.id).value ?? '').toLowerCase()) {
      try {
        if (this.creator.rewardAccount.kind === 'email') this.linkEmail(clipper, reward);
        else await this.linkRoblox(clipper, reward);
      } catch (err) {
        rewardError = err instanceof Error ? err.message : String(err);
      }
    }
    const registered = await this.finishRegistration(clipper, before);
    return { ...res, rewardError, missing: this.missingPlatforms(clipper.id), registered };
  }

  /**
   * Le clippeur vient de connecter son compte (OAuth TikTok / Instagram / YouTube) : ce compte devient celui suivi pour
   * cette plateforme, déjà vérifié (la connexion prouve qu'il est à lui). Renvoie l'ID du compte (jetons).
   */
  connectOfficial(clipper: Clipper, platform: Platform, username: string, now = Date.now()): number {
    const link = parseAccountInput(platform, username);
    if (!link) throw new Error(`Pseudo ${{ tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' }[platform]} invalide : ${username}`);
    const current = this.repo.listAccountsForClipper(clipper.id).filter((a) => a.platform === platform);
    const r = this.repo.registerAccount({ clipperId: clipper.id, clientId: clipper.clientId, ...link, now });
    if (r.conflict) throw new Error(`Le compte @${link.handle} est déjà relié à un autre clippeur : contacte le staff.`);
    this.repo.setAccountVerified(r.account.id, now);
    const replaced = current.filter((a) => a.id !== r.account.id && a.slot === r.account.slot);
    // Nouveau compte qui remplace celui donné à l'inscription (pseudo mal tapé, autre compte à lui : la connexion le prouve) :
    // ses clips comptent depuis la date de l'ancien, pas seulement à partir de la connexion
    const since = Math.min(...replaced.map((a) => a.createdAt));
    if (r.created && Number.isFinite(since) && since < r.account.createdAt) this.repo.setAccountCreatedAt(r.account.id, since);
    for (const a of replaced) this.repo.deactivateAccount(a.id);
    return r.account.id;
  }
  private lastVerify = new Map<number, number>();

  /** Code perso du fan (ex. NEP-4K7Q), créé au premier besoin. */
  verifyCode(clipperId: number): string {
    const existing = this.fans.verifyCode(clipperId);
    if (existing) return existing;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = `NEP-${Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
    this.fans.setVerifyCode(clipperId, code);
    return code;
  }

  /** Comptes actifs du fan pas encore vérifiés. */
  unverifiedAccounts(clipperId: number): Account[] {
    return this.repo.listAccountsForClipper(clipperId).filter((a) => a.active && a.verifiedAt === null);
  }

  /**
   * Lit la bio de chaque compte non vérifié et cherche le code du fan. Trouvé → compte vérifié (ses vues comptent).
   * 1 essai par minute et par fan (chaque lecture TikTok / Instagram coûte un appel Apify).
   */
  async verifyAccounts(clipper: Clipper, now = Date.now()): Promise<Array<{ platform: string; handle: string; ok: boolean; error?: string }>> {
    const last = this.lastVerify.get(clipper.id);
    if (last !== undefined && now - last < 60_000) throw new Error(`Patiente ${Math.ceil((60_000 - (now - last)) / 1000)} s avant de revérifier.`);
    this.lastVerify.set(clipper.id, now);
    const code = this.verifyCode(clipper.id).toLowerCase();
    const results = [];
    for (const a of this.unverifiedAccounts(clipper.id)) {
      const fetcher = this.fetchers?.[a.platform];
      try {
        if (!fetcher) throw new Error('vérification indisponible');
        const p = fetcher.fetchProfile ? await fetcher.fetchProfile(a) : await fetcher.fetchAccount(a);
        const ok = (p.bio ?? '').toLowerCase().includes(code);
        if (ok) this.repo.setAccountVerified(a.id, now, p.followers);
        results.push({ platform: a.platform, handle: a.handle, ok, error: ok ? undefined : 'code introuvable dans la bio' });
      } catch (err) {
        results.push({ platform: a.platform, handle: a.handle, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  /**
   * Rattrapage (une fois) : les comptes inscrits avant la vérification par le staff et qui ont déjà rapporté
   * (≥ 20 000 vues) repassent « à vérifier ». Leurs vues comptent à nouveau dès la validation.
   */
  requeueOldEarners(): number {
    const clientId = this.settings().clientId;
    if (!clientId || !this.settings().accountReview || this.repo.getSetting('requeue-earners-done', false)) return 0;
    const n = this.fans.requeueEarners(clientId, 20_000);
    this.repo.setSetting('requeue-earners-done', true);
    return n;
  }

  /** Seuils du tri automatique : en dessous, le compte est validé tout seul (la règle de la légende reste le filet). */
  static readonly AUTO_MAX_FOLLOWERS = 10_000;
  static readonly AUTO_MAX_VIEWS = 100_000;

  /** File du staff : seulement les comptes déjà relevés que le tri automatique n'a pas validés (gros comptes). */
  accountsToReview() {
    const clientId = this.settings().clientId;
    return clientId ? this.fans.accountsToReview(clientId).filter((a) => a.checkedAt !== null) : [];
  }

  /**
   * Tri automatique (gratuit) après le relevé : petit compte (< 10 000 abonnés, aucune vidéo à 100 000 vues)
   * → validé sans le staff. Ses clips ne rapportent de toute façon que s'ils citent le créateur.
   * Les gros comptes (compte volé, autre YouTubeur) restent dans la file du staff.
   */
  autoReviewAccounts(now = Date.now()): number {
    let n = 0;
    for (const a of this.accountsToReview()) {
      if (!this.creator.trustAccounts && ((a.followers ?? 0) >= FanService.AUTO_MAX_FOLLOWERS || a.topViews >= FanService.AUTO_MAX_VIEWS)) continue;
      this.repo.setAccountVerified(a.id, now);
      n++;
    }
    return n;
  }

  /** Décision du staff sur un compte : validé (ses vues comptent) ou refusé (retiré du suivi). */
  reviewAccount(accountId: number, ok: boolean, now = Date.now()): void {
    if (ok) this.repo.setAccountVerified(accountId, now);
    else this.repo.deactivateAccount(accountId);
  }

  /** Seuils du contrôle : au-delà, le fan passe « à vérifier » (achats bloqués jusqu'à validation du staff). */
  static readonly REVIEW_FOLLOWERS = 50_000;
  static readonly REVIEW_EARLY_VIEWS = 200_000;

  /** Repère les fans suspects (gros compte, clip qui explose d'emblée) et les met « à vérifier ». Renvoie les nouveaux. */
  flagSuspicious(): Array<{ id: number; reason: string; discordId: string; username: string }> {
    const clientId = this.settings().clientId;
    if (!clientId || this.creator.trustAccounts) return [];
    const found = this.fans.suspiciousClippers(clientId, FanService.REVIEW_FOLLOWERS, FanService.REVIEW_EARLY_VIEWS);
    for (const f of found) {
      this.fans.setReviewStatus(f.id, 'pending');
      this.repo.setSetting(`review-reason:${f.id}`, f.reason);
    }
    return found.map((f) => {
      const c = this.repo.getClipper(f.id);
      return { ...f, discordId: c?.discordId ?? '', username: c?.username ?? '?' };
    });
  }

  review(clipperId: number): { status: 'pending' | 'approved' | null; reason: string | null } {
    return { status: this.fans.reviewStatus(clipperId), reason: this.repo.getSetting<string | null>(`review-reason:${clipperId}`, null) };
  }

  /** Décision du staff : validé (plus jamais signalé) ou remis à zéro. */
  setReview(clipperId: number, approved: boolean): void {
    this.fans.setReviewStatus(clipperId, approved ? 'approved' : null);
  }

  buy(clipper: Clipper, itemId: number, now = Date.now()): ShopOrder {
    if (this.fans.reviewStatus(clipper.id) === 'pending') throw new Error('Ton compte est en cours de vérification par le staff : tes achats seront débloqués dès qu’il sera validé.');
    if (this.creator.rewardAccount.kind === 'email') {
      if (!this.fans.email(clipper.id)) throw new Error(`Renseigne d'abord ton ${this.creator.rewardAccount.label.charAt(0).toLowerCase()}${this.creator.rewardAccount.label.slice(1)}`);
    } else if (!this.fans.roblox(clipper.id).userId) throw new Error("Relie d'abord ton compte Roblox pour recevoir l'objet en jeu");
    // Un gamepass est permanent : impossible de l'acheter une 2e fois (le jeu le refuserait)
    const item = this.fans.item(itemId);
    if (item?.kind === 'gamepass' && this.fans.orders({ clipperId: clipper.id }).some((o) => o.ref === item.ref && o.status !== 'refunded')) {
      throw new Error('Tu as déjà ce gamepass');
    }
    // Validation du staff avant livraison (il regarde les clips qui ont rapporté les coins)
    return this.fans.placeOrder(clipper.id, itemId, this.balance(clipper.id, now).earned, now, !this.settings().orderReview);
  }

  // --- Notifications Discord (envoyées par Neptune) -----------------------------------

  /**
   * Prépare les messages privés : au plus 1 par fan et par jour (commande livrée : toujours),
   * par ordre d'importance : niveau supérieur > objet abordable > top 3 de la semaine > coins gagnés.
   */
  generateNotifications(now = Date.now()): number {
    const s = this.settings();
    if (!s.clientId) return 0;
    let queued = 0;
    const fans = this.repo.listClippers({ clientId: s.clientId }).filter((c) => !c.discordId.startsWith('manual:'));
    const views = this.viewsByClipper(now);
    const top3 = new Map(this.leaderboard(now, 3).map((r) => [r.id, r.rank]));
    const week = new Date(now - ((new Date(now).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    const items = this.fans.items({ activeOnly: true }).sort((a, b) => b.price - a.price);

    // Commandes livrées (toujours annoncées, même si un autre message est parti aujourd'hui)
    for (const o of this.fans.deliveredOrders(now - 7 * DAY_MS)) {
      const fan = this.repo.getClipper(o.clipperId);
      if (!fan || fan.discordId.startsWith('manual:') || this.fans.wasNotified(fan.id, `order:${o.id}`)) continue;
      this.fans.markNotified(fan.id, `order:${o.id}`, now);
      if (!this.fans.notifyEnabled(fan.id)) continue;
      this.fans.queueNotification(fan.id, fan.discordId, 'delivered', this.creator.texts.deliveredDm.replace('{item}', o.itemName), now);
      queued++;
    }

    for (const fan of fans) {
      const v = views.get(fan.id) ?? 0;
      const earned = this.points(v) + this.fans.bonus(fan.id);
      const balance = earned - this.fans.spent(fan.id);
      const level = levelOf(v, this.creator.levels);
      const st = this.fans.notifyState(fan.id);
      if (!st) {
        // Premier passage : on part de l'état actuel, sans message (pas de « +176 000 coins » d'un coup)
        this.fans.saveNotifyState(fan.id, { earnedBase: earned, level, lastSentAt: null });
        for (const i of items) if (balance >= i.price) this.fans.markNotified(fan.id, `afford:${i.id}`, now);
        continue;
      }
      if (!this.fans.notifyEnabled(fan.id)) continue;
      if (st.lastSentAt !== null && now - st.lastSentAt < 20 * 3_600_000) continue;

      let msg: { kind: string; text: string; key?: string } | null = null;
      if (level > st.level) {
        const l = this.creator.levels[level]!;
        msg = { kind: 'level', text: `⚡ **Niveau supérieur !** Tu passes **${l.emoji} ${l.name}**.` };
      }
      const affordable = items.find((i) => balance >= i.price && (i.stock === null || i.stock > 0) && !this.fans.wasNotified(fan.id, `afford:${i.id}`));
      if (!msg && affordable) {
        msg = { kind: 'afford', text: `🎁 Tu as assez de coins pour **${affordable.name}** ! (${nf(affordable.price)} coins)`, key: `afford:${affordable.id}` };
      }
      const rank = top3.get(fan.id);
      if (!msg && rank && !this.fans.wasNotified(fan.id, `rank:${week}`)) {
        msg = { kind: 'rank', text: `🏆 Tu es **#${rank}** du classement cette semaine !`, key: `rank:${week}` };
      }
      if (!msg && earned > st.earnedBase) {
        msg = { kind: 'coins', text: `🪙 **+${nf(earned - st.earnedBase)} coins** gagnés ! Tu as maintenant **${nf(balance)} coins**.` };
      }
      if (!msg) continue;
      this.fans.queueNotification(fan.id, fan.discordId, msg.kind, msg.text, now);
      if (msg.key) this.fans.markNotified(fan.id, msg.key, now);
      this.fans.saveNotifyState(fan.id, {
        earnedBase: msg.kind === 'coins' ? earned : st.earnedBase,
        level: msg.kind === 'level' ? level : st.level,
        lastSentAt: now,
      });
      queued++;
    }
    return queued;
  }

  // --- Photos HD du créateur (YouTube + Roblox), mises en cache 12 h -----------------

  private avatarCache: { key: string; at: number; urls: { youtube: string | null; roblox: string | null; banner: string | null } } | null = null;
  /** Dernière erreur de récupération des photos (affichée dans le dashboard). */
  avatarErrors: { youtube: string | null; roblox: string | null } = { youtube: null, roblox: null };

  async creatorAvatars(youtubeApiKey: string | undefined, now = Date.now()) {
    const s = this.settings();
    const key = `${s.creatorYoutube}|${s.creatorRoblox}`;
    if (this.avatarCache && this.avatarCache.key === key && now - this.avatarCache.at < 12 * 3_600_000) return this.avatarCache.urls;
    const safe = async <T>(which: 'youtube' | 'roblox', fn: () => Promise<T>) => {
      try {
        const v = await fn();
        this.avatarErrors[which] = v ? null : this.avatarErrors[which] ?? 'introuvable';
        return v;
      } catch (err) {
        this.avatarErrors[which] = err instanceof Error ? err.message : String(err);
        return null;
      }
    };
    this.avatarErrors = { youtube: null, roblox: null };
    if (!youtubeApiKey) this.avatarErrors.youtube = 'YOUTUBE_API_KEY absente';
    let banner: string | null = null;
    const youtube = s.creatorYoutube && youtubeApiKey
      ? await safe('youtube', async () => {
          const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings&forHandle=${encodeURIComponent('@' + this.youtubeHandles()[0])}&key=${youtubeApiKey}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const r = (await res.json()) as { items?: Array<{ snippet: { thumbnails: Record<string, { url: string }> }; brandingSettings?: { image?: { bannerExternalUrl?: string } } }>; error?: { message?: string } };
          if (!res.ok) throw new Error(`YouTube HTTP ${res.status} : ${r.error?.message ?? ''}`);
          if (!r.items?.length) throw new Error(`chaîne @${this.youtubeHandles()[0]} introuvable`);
          // Bannière de la chaîne en HD (bande centrale 2560×423, même cadrage que la bannière intégrée)
          const b = r.items?.[0]?.brandingSettings?.image?.bannerExternalUrl;
          if (b) banner = `${b}=w2560-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj`;
          const t = r.items?.[0]?.snippet.thumbnails;
          const best = t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
          return best ? best.replace(/=s\d+/, '=s800') : null;
        })
      : null;
    const roblox = s.creatorRoblox
      ? await safe('roblox', async () => {
          const user = await this.resolveRoblox(s.creatorRoblox);
          if (!user) throw new Error(`pseudo Roblox ${s.creatorRoblox} introuvable`);
          const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=420x420&format=Png&isCircular=false`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) throw new Error(`Roblox miniatures HTTP ${res.status}`);
          const r = (await res.json()) as { data?: Array<{ imageUrl?: string; state?: string }> };
          const d = r.data?.[0];
          if (!(d?.state === 'Completed' && d.imageUrl)) throw new Error(`miniature Roblox pas prête (${d?.state ?? 'vide'})`);
          return d.imageUrl;
        })
      : null;
    // Échec (réseau, API) : on réessaie dans 10 min au lieu de 12 h
    this.avatarCache = { key, at: youtube || roblox ? now : now - 12 * 3_600_000 + 10 * 60_000, urls: { youtube, roblox, banner } };
    return this.avatarCache.urls;
  }

  // --- Page publique (accueil de la communauté) --------------------------------------

  /** Données visibles sans connexion : chiffres de la communauté, contenus, clips, boutique. */
  publicPage(now = Date.now()) {
    const s = this.settings();
    const fans = s.clientId ? this.repo.listClippers({ clientId: s.clientId }) : [];
    const ids = fans.map((f) => f.id);
    const views = this.viewsByClipper(now);
    const week = this.repo.videosPublished(now - 7 * 86_400_000, now, ids);
    const clips = this.repo
      .videosPublished(now - 30 * 86_400_000, now, ids)
      .filter((v) => v.url)
      .sort((a, b) => b.views - a.views)
      .slice(0, 8)
      .map((v) => ({ platform: v.platform, url: v.url, title: v.title, thumbnail: v.thumbnailUrl, views: v.views }));
    const allClips = this.repo.videosPublished(0, now, ids).length;
    return {
      creator: this.creator,
      programName: s.programName,
      tagline: s.tagline,
      heroMediaUrl: s.heroMediaUrl,
      discordInviteUrl: s.discordInviteUrl,
      pointsPer1000: s.pointsPer1000,
      clipTag: this.tagLabel(),
      stats: {
        members: fans.length,
        active: new Set(week.map((v) => v.clipperId)).size,
        clips: allClips,
        rewards: this.fans.orders({ status: 'delivered', limit: 100_000 }).length,
        views: ids.reduce((sum, id) => sum + (views.get(id) ?? 0), 0),
      },
      featured: parseFeatured(s.featured),
      clips,
      items: this.fans.items({ activeOnly: true }),
      leaderboard: this.leaderboard(now).map(({ id: _id, ...r }) => r),
      // Classement du mois (créateurs avec récompense du mois, ex. Loann : top 3 = 1 mois offert)
      ...(this.creator.monthlyPrize
        ? { monthPrize: this.creator.monthlyPrize, ...(this.creator.monthlyPrizeLabel ? { monthPrizeLabel: this.creator.monthlyPrizeLabel, monthPrizeShort: this.creator.monthlyPrizeShort ?? this.creator.monthlyPrizeLabel } : {}), monthLeaderboard: this.monthLeaderboard(now).map(({ id: _id, discordId: _d, ...r }) => r) }
        : {}),
    };
  }

  // --- Staff -------------------------------------------------------------------------

  overview(now = Date.now()) {
    const s = this.settings();
    const views = this.viewsByClipper(now);
    const spent = this.fans.spentByClipper();
    const refused = s.clientId ? this.fans.refusedClips(s.clientId) : new Map();
    const officialConnected = this.officialLogin?.connected() ?? new Set<number>();
    const clippers = s.clientId ? this.repo.listClippers({ clientId: s.clientId, includeInactive: true }) : [];
    const fans = clippers
      .map((c) => {
        const v = views.get(c.id) ?? 0;
        const earned = this.points(v) + this.fans.bonus(c.id);
        const sp = spent.get(c.id) ?? 0;
        const accounts = this.repo
          .listAccountsForClipper(c.id)
          .filter((a) => a.active)
          .map((a) => ({ platform: a.platform, handle: a.handle, verified: a.verifiedAt !== null, followers: a.followers, connected: officialConnected.has(a.id) }));
        return { id: c.id, username: c.username, joinedAt: c.createdAt, avatar: this.fans.avatar(c.id), roblox: this.rewardAccount(c.id).value, accounts, views: v, earned, spent: sp, balance: earned - sp, review: this.review(c.id), refused: refused.get(c.id) ?? [] };
      })
      // Fans « à vérifier » en premier, puis par vues
      .sort((a, b) => Number(b.review.status === 'pending') - Number(a.review.status === 'pending') || b.views - a.views);
    const names = new Map(clippers.map((c) => [c.id, c.username]));
    const orders = this.fans.orders({ limit: 200 }).map((o) => ({
      ...o,
      // À valider : les clips qui ont rapporté le plus, pour vérifier en 30 s que ce sont de vrais clips
      topClips: o.status === 'pending' && o.approvedAt === null ? this.fans.clips(o.clipperId, 50).sort((a, b) => b.gained - a.gained).slice(0, 3) : [],
      username: names.get(o.clipperId) ?? this.repo.getClipper(o.clipperId)?.username ?? '?',
      roblox: this.rewardAccount(o.clipperId).value,
    }));
    return { creatorName: this.creator.creatorName, accountsToReview: this.accountsToReview(), clipRule: this.clipRuleSince() !== null, clipKeywords: this.clipKeywords(), accountLabel: this.creator.rewardAccount.kind === 'email' ? 'E-mail' : 'Roblox', creator: { id: this.creator.id, theme: this.creator.theme }, settings: s, clients: this.repo.listClients().map((c) => ({ id: c.id, name: c.name })), fans, items: this.fans.items(), orders };
  }

  /** Contrôle du relevé de la nuit (YouTube, TikTok, Instagram) : comptes relus, en erreur, en retard. */
  trackingReport(now = Date.now()): TrackingReport | null {
    const clientId = this.settings().clientId;
    if (clientId === null) return null;
    const names = new Map(this.repo.listClippers({ clientId, includeInactive: true }).map((c) => [c.id, c.username]));
    const accounts = this.repo
      .listActiveAccounts()
      .filter((a) => a.clientId === clientId)
      .map((a) => ({ ...a, username: names.get(a.clipperId) ?? '?' }));
    const report = trackingReport(accounts, this.repo.lastPublishedByAccount(), this.officialLogin?.connected() ?? new Set(), parisMidnight(now), now);
    for (const p of report.problems) if (p.error) p.error = readableError(p.error);
    return report;
  }

  saveItem(id: number | null, input: ItemInput) {
    if (id === null) return this.fans.createItem(input);
    const item = this.fans.updateItem(id, input);
    if (!item) throw new Error('Objet introuvable');
    return item;
  }
}

/** Pseudo Roblox → ID via l'API publique Roblox. */
async function robloxLookup(username: string): Promise<{ id: number; name: string } | null> {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return null;
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Roblox ne répond pas (HTTP ${res.status}), réessaie dans un instant`);
  const body = (await res.json()) as { data?: Array<{ id: number; name: string }> };
  const u = body.data?.[0];
  return u ? { id: u.id, name: u.name } : null;
}
