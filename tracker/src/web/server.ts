import { NEPTUNE_HOME } from './neptune.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { BotBridge } from '../bot/index.js';
import type { Repo } from '../db/repo.js';
import { parseAccountInput, PLATFORMS } from '../domain/links.js';
import { normalizeRewardConfig } from '../domain/remuneration.js';
import { dayKey } from '../domain/time.js';
import type { AgencyService } from '../services/agency.js';
import { FanRepo } from '../db/fans.js';
import { FanService } from '../services/fans.js';
import { type InstagramCredentials, type InstagramTokenStore, instagramAuthorizeUrl, instagramExchangeCode, instagramUser } from '../platforms/instagramOfficial.js';
import { type TikTokCredentials, type TikTokTokenStore, tiktokAuthorizeUrl, tiktokExchangeCode, tiktokUser } from '../platforms/tiktokOfficial.js';
import { type GoogleCredentials, type YouTubeTokenStore, youtubeAuthorizeUrl, youtubeConnectChannel } from '../platforms/youtubeOfficial.js';
import { legalPage, PRIVACY_HTML, TERMS_HTML } from './legal.js';
import { demoPage, soberPage } from './sober.js';
import type { GameClient } from '../services/game.js';
import type { RecruitmentService } from '../services/recruitment.js';
import { status } from '../status.js';

// Application web (HTML + CSS + JS sans build), copiée dans dist/ par `npm run build`.
const asset = (name: string) => readFileSync(new URL(`./app/${name}`, import.meta.url), 'utf8');
const ASSETS = {
  html: asset('index.html'),
  css: asset('app.css'),
  neo: asset('neo.css'),
  js: asset('app.js'),
  fan: asset('fan.html'),
  fanSober: asset('fan-sober.html'),
  login: asset('login.html'),
};
const NEPTUNE_LOGO = new Uint8Array(readFileSync(new URL('./app/neptune-logo.png', import.meta.url)));
const MARS_LOGO = new Uint8Array(readFileSync(new URL('./app/mars-logo.png', import.meta.url)));
const fanFile = (name: string, type: string) => ({ data: new Uint8Array(readFileSync(new URL(`./app/fan/${name}`, import.meta.url))), type });
const FAN_FILES: Record<string, { data: Uint8Array<ArrayBuffer>; type: string }> = {
  'beone.png': fanFile('beone.png', 'image/png'),
  'beone-roblox.png': fanFile('beone-roblox.png', 'image/png'),
  'banner.jpg': fanFile('banner.jpg', 'image/jpeg'),
};

/** Photo du créateur livrée avec le code (repli si YouTube ne répond pas). */
function localCreatorPhoto(id: string): Uint8Array<ArrayBuffer> | null {
  try {
    return new Uint8Array(readFileSync(new URL(`./app/fan/${id}.png`, import.meta.url)));
  } catch {
    return null;
  }
}

export interface WebDeps {
  repo: Repo;
  agency: AgencyService;
  recruitment: RecruitmentService;
  /** Programme fans (créé par défaut si absent, ex. dans les tests). */
  fans?: FanService;
  password?: string;
  /** Menu « Programme » : les Mars de chaque créateur (bascule sans se reconnecter). */
  marsSites?: Array<{ name: string; url: string }>;
  /** Adresse publique de ce Mars. */
  selfUrl?: string;
  /** Appels vers les autres Mars (remplaçable en test). */
  fetchFn?: typeof fetch;
  /** API du jeu (catalogue + livraison des achats), si configurée. */
  game?: GameClient;
  /** Livraison automatique par e-mail configurée (API Squiduuverse) */
  emailApi?: boolean;
  /** Conso Apify du mois (jauge dans Mars). */
  apifyUsage?: () => Promise<{ used: number; limit: number | null; resetAt: number | null }>;
  /** Clé partagée avec le jeu Roblox (livraison des achats). */
  robloxApiKey?: string;
  /** Clé partagée avec le bot Neptune (Python). */
  neptuneApiKey?: string;
  /** Relève tout de suite les comptes des fans (bouton « Relever les vues maintenant » de Mars). */
  refreshFans?: () => { started: boolean; message: string };
  /** Le bot des fans (BeOne Rewards) envoie lui-même les messages privés : Neptune n'en reçoit plus. */
  fansBotSends?: boolean;
  /** Clé YouTube Data API (photo HD du créateur). */
  youtubeApiKey?: string;
  /** « Se connecter avec Discord » sur la boutique fans. */
  discordOAuth?: { clientId: string; clientSecret: string; redirectUri: string };
  /** « Connecter mon TikTok » (API officielle gratuite) : app TikTok + stockage des jetons. */
  /** Fichier de vérification du site demandé par TikTok (nom + contenu), servi à la racine. */
  siteVerification?: { file: string; content: string };
  tiktokOAuth?: { creds: TikTokCredentials; redirectUri: string; store: TikTokTokenStore; fetchFn?: typeof fetch };
  /** « Connecter mon Instagram » (API Instagram officielle gratuite, compte pro / créateur). */
  instagramOAuth?: { creds: InstagramCredentials; redirectUri: string; store: InstagramTokenStore; fetchFn?: typeof fetch };
  /** « Connecter mon YouTube » (connexion Google gratuite) : prouve que la chaîne est au fan. */
  youtubeOAuth?: { creds: GoogleCredentials; redirectUri: string; store: YouTubeTokenStore; fetchFn?: typeof fetch };
  /** Rempli quand le bot est connecté (sinon les actions Discord sont indisponibles). */
  bot: { current?: BotBridge };
}

const clientIdParam = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

const ClipperBody = z.object({
  username: z.string().trim().min(1).max(80).optional(),
  clientId: z.number().int().positive().nullable().optional(),
  status: z.enum(['actif', 'inactif']).optional(),
  accounts: z
    .object({ tiktok: z.string().optional(), instagram: z.string().optional(), youtube: z.string().optional() })
    .optional(),
});

const ItemBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  imageUrl: z.string().trim().max(500).refine((v) => /^https?:\/\//.test(v) || /^\/[\w/.-]+$/.test(v), 'Lien d’image invalide').nullable().optional(),
  price: z.number().int().min(1).max(100_000_000),
  kind: z.enum(['gamepass', 'item']),
  ref: z.string().trim().min(1).max(100),
  stock: z.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
});

const FAN_COOKIE = 'fan_session';
const OAUTH_STATE_COOKIE = 'fan_oauth_state';

/** Échange le code OAuth2 Discord contre l'identité du membre. */
async function discordIdentity(code: string, o: { clientId: string; clientSecret: string; redirectUri: string }) {
  const token = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: o.redirectUri, client_id: o.clientId, client_secret: o.clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!token.ok) throw new Error(`Discord a refusé la connexion (HTTP ${token.status})`);
  const { access_token } = (await token.json()) as { access_token: string };
  const me = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!me.ok) throw new Error(`Profil Discord illisible (HTTP ${me.status})`);
  const u = (await me.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  const avatar = u.avatar && /^(a_)?[0-9a-f]{32}$/.test(u.avatar) ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null;
  return { id: u.id, name: u.global_name || u.username, avatar };
}

const ClientBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  discordChannelId: z.string().regex(/^\d*$/).nullable().optional(),
  monthlyFee: z.number().min(0).optional(),
});

export function createApp(deps: WebDeps): Hono {
  const { repo, agency } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    // Les réponses HTTP prévues (ex. 401 + demande de mot de passe) passent telles quelles.
    if (err instanceof HTTPException) return err.getResponse();
    return c.json({ error: err instanceof z.ZodError ? 'Données invalides' : err.message }, 400);
  });

  app.get('/healthz', (c) => c.json({ ok: true, bot: status.bot.state }));

  // --- Espace fan (public, connexion par lien /site) + API du jeu Roblox ---------------
  // Déclaré avant le mot de passe du dashboard : les fans n'y ont pas accès.

  const fans = deps.fans ?? new FanService(repo, new FanRepo(repo.db), agency, '');
  const fanOf = (c: Context) => fans.clipperFromSession(getCookie(c, FAN_COOKIE));
  const requireFan = (c: Context) => {
    const fan = fanOf(c);
    if (!fan) throw new HTTPException(401, { res: Response.json({ error: 'Session expirée : refais /site sur Discord' }, { status: 401 }) });
    return fan;
  };

  app.get('/fan', (c) => {
    const cr = fans.creator;
    if (cr.theme === 'playful') return c.html(ASSETS.fan);
    return c.html(soberPage(ASSETS.fanSober, cr, fans.settings().programName));
  });
  // Visuels de la boutique (avatars, bannière du créateur)
  app.get('/fan/assets/:name', async (c) => {
    const name = c.req.param('name');
    // Photos HD du créateur si disponibles (YouTube / Roblox), sinon les visuels intégrés
    if (name === 'creator.png') {
      const hd = await fans.creatorAvatars(deps.youtubeApiKey);
      if (hd.youtube) {
        c.header('cache-control', 'public, max-age=3600');
        return c.redirect(hd.youtube, 302);
      }
      // Repli : photo fournie dans src/web/app/fan/<créateur>.png
      const local = localCreatorPhoto(fans.creator.id);
      if (local) return c.body(local, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' });
      return c.notFound();
    }
    if (name === 'beone.png' || name === 'beone-roblox.png' || name === 'banner.jpg') {
      const hd = await fans.creatorAvatars(deps.youtubeApiKey);
      const url = name === 'beone.png' ? hd.youtube : name === 'banner.jpg' ? hd.banner : hd.roblox;
      if (url) {
        c.header('cache-control', 'public, max-age=3600');
        return c.redirect(url, 302);
      }
    }
    // Visuels propres au créateur (bannière, image de la récompense) livrés dans src/web/app/fan/
    if (name === 'hero-banner' || name === 'reward') {
      const f = name === 'reward' ? fans.creator.images?.reward : fans.creator.images?.banner;
      if (!f || !/^[\w.-]+$/.test(f)) return c.notFound();
      try {
        const data = new Uint8Array(readFileSync(new URL(`./app/fan/${f}`, import.meta.url)));
        const type = f.endsWith('.webp') ? 'image/webp' : f.endsWith('.png') ? 'image/png' : 'image/jpeg';
        return c.body(data, 200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
      } catch {
        return c.notFound();
      }
    }
    // Visuels du style « ms » (conférenciers, paliers) livrés dans src/web/app/fan/
    if (/^ms-[\w-]+\.webp$/.test(name)) {
      try {
        const data = new Uint8Array(readFileSync(new URL(`./app/fan/${name}`, import.meta.url)));
        return c.body(data, 200, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400' });
      } catch {
        return c.notFound();
      }
    }
    const file = FAN_FILES[name];
    if (!file) return c.notFound();
    return c.body(file.data, 200, { 'content-type': file.type, 'cache-control': 'public, max-age=600' });
  });
  const isHttps = (c: Context) => c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:');
  const startSession = (c: Context, session: string, next?: string) => {
    setCookie(c, FAN_COOKIE, session, { httpOnly: true, sameSite: 'Lax', secure: isHttps(c), path: '/', maxAge: 30 * 86_400 });
    return c.redirect(next === 'formation' ? '/formation' : next === 'connect' || next === 'inscription' ? '/fan#clipper' : '/fan');
  };
  const fanError = (c: Context, message: string) => c.redirect(`/fan?error=${encodeURIComponent(message)}`);

  // Lien /site (Discord) : usage unique, 10 min
  app.get('/fan/login', (c) => {
    const session = fans.login(c.req.query('t') ?? '');
    const next = c.req.query('next');
    if (!session && next === 'formation') return c.redirect('/formation?error=expired');
    return session ? startSession(c, session, next) : fanError(c, 'Ce lien a expiré, reconnecte-toi.');
  });

  // « Se connecter avec Discord » (OAuth2, scope identify)
  app.get('/fan/auth/discord', (c) => {
    const o = deps.discordOAuth;
    if (!o) return fanError(c, 'Connexion Discord pas encore configurée : utilise /site sur Discord.');
    const state = randomBytes(16).toString('base64url');
    if (c.req.query('next') === 'formation') setCookie(c, 'fan_next', 'formation', { httpOnly: true, sameSite: 'Lax', secure: isHttps(c), path: '/fan', maxAge: 600 });
    setCookie(c, OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'Lax', secure: isHttps(c), path: '/fan', maxAge: 600 });
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: o.clientId, response_type: 'code', redirect_uri: o.redirectUri, scope: 'identify', state, prompt: 'none' }).toString();
    return c.redirect(url.toString());
  });
  app.get('/fan/auth/callback', async (c) => {
    const o = deps.discordOAuth;
    const state = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/fan' });
    const code = c.req.query('code');
    if (!o || !code || !state || c.req.query('state') !== state) return fanError(c, 'Connexion annulée ou expirée, réessaie.');
    try {
      const user = await discordIdentity(code, o);
      const next = getCookie(c, 'fan_next');
      deleteCookie(c, 'fan_next', { path: '/fan' });
      return startSession(c, fans.loginDiscordUser(user.id, user.name, Date.now(), user.avatar), next);
    } catch (err) {
      return fanError(c, err instanceof Error ? err.message : String(err));
    }
  });
  // « Connecter mon TikTok / Instagram / YouTube » : le fan autorise la lecture de ses vidéos (gratuit, prouve que le compte est à lui)
  const officialLogins = {
    tiktok: deps.tiktokOAuth && {
      authorize: (state: string) => tiktokAuthorizeUrl(deps.tiktokOAuth!.creds, deps.tiktokOAuth!.redirectUri, state),
      finish: async (code: string) => {
        const t = deps.tiktokOAuth!;
        const tokens = await tiktokExchangeCode(t.creds, code, t.redirectUri, t.fetchFn);
        return { tokens, username: (await tiktokUser(tokens.accessToken, t.fetchFn)).username, store: t.store };
      },
    },
    instagram: deps.instagramOAuth && {
      authorize: (state: string) => instagramAuthorizeUrl(deps.instagramOAuth!.creds, deps.instagramOAuth!.redirectUri, state),
      finish: async (code: string) => {
        const t = deps.instagramOAuth!;
        const tokens = await instagramExchangeCode(t.creds, code, t.redirectUri, t.fetchFn);
        return { tokens, username: (await instagramUser(tokens.accessToken, t.fetchFn)).username, store: t.store };
      },
    },
    youtube: deps.youtubeOAuth && {
      authorize: (state: string) => youtubeAuthorizeUrl(deps.youtubeOAuth!.creds, deps.youtubeOAuth!.redirectUri, state),
      finish: async (code: string) => {
        const t = deps.youtubeOAuth!;
        const channel = await youtubeConnectChannel(t.creds, code, t.redirectUri, t.fetchFn);
        // Aucun jeton gardé (révoqué) : la ligne sert de preuve, valable sans limite
        const tokens = { openId: channel.id, accessToken: '', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER, refreshExpiresAt: Number.MAX_SAFE_INTEGER };
        return { tokens, username: channel.handle, store: t.store };
      },
    },
  };
  /** Site d'origine d'une connexion TikTok / Instagram (dans le state), s'il fait partie de nos sites et que ce n'est pas celui-ci. */
  const relayOrigin = (state: string | undefined) => {
    const raw = state?.split('.')[1];
    if (!raw) return undefined;
    const target = Buffer.from(raw, 'base64url').toString().replace(/\/+$/, '');
    if (!target || target === deps.selfUrl) return undefined;
    return (deps.marsSites ?? []).some((s) => s.url.replace(/\/+$/, '') === target) ? target : undefined;
  };
  for (const platform of ['tiktok', 'instagram', 'youtube'] as const) {
    const name = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' }[platform];
    app.get(`/fan/${platform}/connect`, (c) => {
      const o = officialLogins[platform];
      if (!o) return fanError(c, `Connexion ${name} pas encore disponible.`);
      if (!fanOf(c)) return fanError(c, `Connecte-toi d’abord (bouton du site ou /site sur Discord), puis reclique sur « Connecter mon ${name} ».`);
      // L'adresse de ce site voyage dans le state : si TikTok / Meta renvoie sur un autre de nos sites (relais), il sait où nous renvoyer
      const state = `${randomBytes(16).toString('base64url')}.${Buffer.from(deps.selfUrl ?? '').toString('base64url')}`;
      setCookie(c, `${platform}_state`, state, { httpOnly: true, sameSite: 'Lax', secure: isHttps(c), path: '/fan', maxAge: 600 });
      return c.redirect(o.authorize(state));
    });
    app.get(`/fan/${platform}/callback`, async (c) => {
      // Relais : la connexion a été lancée depuis un autre de nos sites (seule cette adresse est enregistrée chez TikTok / Meta)
      const origin = relayOrigin(c.req.query('state'));
      if (origin) return c.redirect(`${origin}/fan/${platform}/callback?${new URL(c.req.url).searchParams.toString()}`);
      const o = officialLogins[platform];
      const state = getCookie(c, `${platform}_state`);
      deleteCookie(c, `${platform}_state`, { path: '/fan' });
      const code = c.req.query('code');
      const fan = fanOf(c);
      if (!o || !code || !state || c.req.query('state') !== state) return fanError(c, `Connexion ${name} annulée ou expirée, réessaie.`);
      if (!fan) return fanError(c, `Session expirée : reconnecte-toi puis reclique sur « Connecter mon ${name} ».`);
      try {
        const { tokens, username, store } = await o.finish(code);
        const before = fans.missingPlatforms(fan.id);
        store.save(fans.connectOfficial(fan, platform, username), tokens);
        await fans.finishRegistration(fan, before);
        return c.redirect(`/fan?connected=${platform}#clipper`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Compte Instagram perso : l'API ne marche qu'avec un compte pro / créateur
        return fanError(c, platform === 'instagram' && /business|professional|creator|pro\b/i.test(message) ? 'Passe ton Instagram en compte créateur (Paramètres → Type de compte → Passer à un compte professionnel → Créateur, gratuit), puis réessaie.' : message);
      }
    });
  }

  // Vérification du site par TikTok : fichier servi à la racine (ex. /tiktokAbC123.txt)
  if (deps.siteVerification) {
    const v = deps.siteVerification;
    app.get(`/${v.file.replace(/^\/+/, '')}`, (c) => c.text(v.content));
  }

  // Vérification du site par Google (Search Console, exigée pour valider « Connecter mon YouTube ») : pas secret
  app.get('/googleb4c9e6a13d5b1d3b.html', (c) => c.text('google-site-verification: googleb4c9e6a13d5b1d3b.html'));

  // Maquettes pour les calls prospects : le vrai site fans à la charte du prospect, données d'exemple, sans connexion
  app.get('/demo/:slug', (c) => {
    const html = demoPage(ASSETS.fanSober, c.req.param('slug'), (f) => `/demo/assets/${f}`);
    return html ? c.html(html) : c.notFound();
  });
  app.get('/demo/assets/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[\w-]+\.(png|webp|jpg)$/.test(name)) return c.notFound();
    try {
      const data = readFileSync(new URL(`./app/demo/${name}`, import.meta.url));
      return c.body(data, 200, { 'content-type': name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'cache-control': 'public, max-age=3600' });
    } catch {
      return c.notFound();
    }
  });

  // Pages légales (exigées par TikTok pour valider l'app)
  app.get('/neptune', (c) => c.html(NEPTUNE_HOME));
  app.get('/legal/privacy', (c) => c.html(legalPage('Politique de confidentialité', PRIVACY_HTML)));
  app.get('/legal/terms', (c) => c.html(legalPage('Conditions d’utilisation', TERMS_HTML)));

  app.post('/fan/logout', (c) => {
    const token = getCookie(c, FAN_COOKIE);
    if (token) fans.fans.deleteSession(token);
    deleteCookie(c, FAN_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/fan/public', (c) => c.json(fans.publicPage()));

  // Formation (Neptune Academy) : modules à cocher ; tout coché → rôle Discord 🎓 Formation validée
  app.get('/formation', (c) => c.html(asset('formation.html')));
  app.get('/api/formation', (c) => {
    const fan = fanOf(c);
    const s = fans.settings();
    if (!fan) return c.json({ loggedIn: false, oauth: !!deps.discordOAuth, programName: s.programName, discordInviteUrl: s.discordInviteUrl });
    return c.json({ loggedIn: true, username: fan.username, programName: s.programName, discordInviteUrl: s.discordInviteUrl, ...fans.training(fan.id) });
  });
  app.post('/api/formation/:num', async (c) => {
    const fan = requireFan(c);
    const body = z.object({ done: z.boolean() }).parse(await c.req.json());
    return c.json(fans.setTrainingStep(fan, c.req.param('num'), body.done));
  });
  app.get('/api/fan/me', (c) => {
    const fan = fanOf(c);
    return fan ? c.json(fans.me(fan)) : c.json({ error: 'not_logged_in' }, 401);
  });
  // Les comptes TikTok / Insta / YouTube des fans sont reliés par le staff (Management), pas par les fans.
  app.put('/api/fan/notify', async (c) => {
    const fan = requireFan(c);
    const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
    fans.fans.setNotify(fan.id, on);
    return c.json({ ok: true });
  });
  app.put('/api/fan/roblox', async (c) => {
    const fan = requireFan(c);
    const { username } = z.object({ username: z.string().trim().min(3).max(20) }).parse(await c.req.json());
    return c.json(await fans.linkRoblox(fan, username));
  });
  /** Inscription depuis le site : TikTok / YouTube / Instagram (@ ou lien) + compte de livraison. */
  app.post('/api/fan/register', async (c) => {
    const fan = requireFan(c);
    const field = z.string().trim().max(200).optional();
    const body = z.object({ tiktok: field, youtube: field, instagram: field, reward: z.string().trim().max(254).optional() }).parse(await c.req.json());
    return c.json(await fans.siteRegister(fan, body));
  });
  /** Compte de livraison des récompenses (e-mail ou pseudo Roblox selon le créateur). */
  app.put('/api/fan/account', async (c) => {
    const fan = requireFan(c);
    const { value } = z.object({ value: z.string().trim().min(3).max(254) }).parse(await c.req.json());
    if (fans.creator.rewardAccount.kind === 'email') return c.json({ value: fans.linkEmail(fan, value) });
    return c.json({ value: (await fans.linkRoblox(fan, value)).username });
  });
  app.post('/api/fan/orders', async (c) => {
    const fan = requireFan(c);
    const { itemId } = z.object({ itemId: z.number().int().positive() }).parse(await c.req.json());
    return c.json(fans.buy(fan, itemId));
  });

  // Le bot Neptune (Python, service séparé) demande un lien /site ou les points d'un membre.
  const NeptuneBody = z.object({ discordId: z.string().regex(/^\d{5,25}$/), username: z.string().trim().min(1).max(80) });
  const requireNeptune = (c: Context) => {
    if (!deps.neptuneApiKey) throw new HTTPException(503, { res: Response.json({ error: 'NEPTUNE_API_KEY non configurée' }, { status: 503 }) });
    if (c.req.header('x-api-key') !== deps.neptuneApiKey) throw new HTTPException(401, { res: Response.json({ error: 'Clé invalide' }, { status: 401 }) });
  };
  app.post('/api/neptune/link', async (c) => {
    requireNeptune(c);
    const body = NeptuneBody.parse(await c.req.json());
    const fan = fans.ensureFan(body.discordId, body.username);
    return c.json({ url: fans.loginUrl(fan.id) });
  });
  // Messages privés à envoyer par Neptune, puis accusé de réception
  app.get('/api/neptune/notifications', (c) => {
    requireNeptune(c);
    return c.json({ notifications: deps.fansBotSends ? [] : fans.fans.pendingNotifications(), siteUrl: '/fan' });
  });
  app.post('/api/neptune/notifications/ack', async (c) => {
    requireNeptune(c);
    const body = z
      .object({ sent: z.array(z.number().int()).max(200).default([]), failed: z.array(z.object({ id: z.number().int(), error: z.string().max(300) })).max(200).default([]) })
      .parse(await c.req.json());
    for (const id of body.sent) fans.fans.ackNotification(id, null);
    for (const f of body.failed) fans.fans.ackNotification(f.id, f.error);
    return c.json({ ok: true });
  });

  app.post('/api/neptune/points', async (c) => {
    requireNeptune(c);
    const body = NeptuneBody.parse(await c.req.json());
    const fan = fans.ensureFan(body.discordId, body.username);
    return c.json({ ...fans.balance(fan.id), pointsPer1000: fans.settings().pointsPer1000 });
  });

  // Le jeu Roblox demande les achats à livrer puis confirme la livraison (clé partagée).
  const requireGame = (c: Context) => {
    if (!deps.robloxApiKey) throw new HTTPException(503, { res: Response.json({ error: 'ROBLOX_API_KEY non configurée' }, { status: 503 }) });
    if (c.req.header('x-api-key') !== deps.robloxApiKey) throw new HTTPException(401, { res: Response.json({ error: 'Clé invalide' }, { status: 401 }) });
  };
  app.get('/api/roblox/pending', (c) => {
    requireGame(c);
    const userId = Number(c.req.query('userId'));
    if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ error: 'userId invalide' }, 400);
    return c.json({ orders: fans.fans.pendingForRoblox(userId).map((o) => ({ id: o.id, kind: o.kind, ref: o.ref, name: o.itemName })) });
  });
  app.post('/api/roblox/delivered', async (c) => {
    requireGame(c);
    const body = z.object({ userId: z.number().int().positive(), orderIds: z.array(z.number().int().positive()).max(100) }).parse(await c.req.json());
    return c.json({ ok: true, updated: fans.fans.markDelivered(body.orderIds, body.userId) });
  });

  // --- Accès staff : page de connexion + cookie de session (30 jours) ------------------
  app.get('/mars-logo.png', (c) => c.body(MARS_LOGO, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }));
  app.get('/neptune-logo.png', (c) => c.body(NEPTUNE_LOGO, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }));
  let ssoLink = (to: string) => to;
  if (deps.password) {
    const password = deps.password;
    // Jeton dérivé du mot de passe : changer DASHBOARD_PASSWORD déconnecte tout le monde
    const staffToken = createHash('sha256').update(`lune-staff:${password}`).digest('hex');
    const same = (a: string, b: string) => {
      const x = createHash('sha256').update(a).digest();
      const y = createHash('sha256').update(b).digest();
      return timingSafeEqual(x, y);
    };
    app.get('/login', (c) => c.html(ASSETS.login));
    // Bascule entre les Mars des créateurs : lien signé (valable 2 min) avec la clé dérivée du mot de passe commun
    const ssoKey = createHash('sha256').update(`lune-sso:${password}`).digest();
    const ssoSign = (exp: number) => createHmac('sha256', ssoKey).update(String(exp)).digest('hex');
    ssoLink = (to: string) => {
      const exp = Date.now() + 2 * 60_000;
      return `${to}/sso?t=${exp}.${ssoSign(exp)}`;
    };
    app.get('/sso', (c) => {
      const [exp, sig] = (c.req.query('t') ?? '').split('.');
      const e = Number(exp);
      if (!Number.isFinite(e) || e < Date.now() || e > Date.now() + 5 * 60_000 || !sig || !same(sig, ssoSign(e))) return c.redirect('/login', 302);
      setCookie(c, 'staff', staffToken, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86_400 });
      return c.redirect('/', 302);
    });
    // Anti-force brute : 10 mauvais mots de passe par IP en 15 min → bloqué 15 min (page de connexion et en-tête)
    const fails = new Map<string, { n: number; at: number }>();
    const ipOf = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';
    const blocked = (c: Context) => {
      const f = fails.get(ipOf(c));
      return !!f && f.n >= 10 && Date.now() - f.at < 15 * 60_000;
    };
    const failed = (c: Context) => {
      const ip = ipOf(c);
      const f = fails.get(ip);
      fails.set(ip, f && Date.now() - f.at < 15 * 60_000 ? { n: f.n + 1, at: f.at } : { n: 1, at: Date.now() });
    };
    app.post('/login', async (c) => {
      if (blocked(c)) return c.text('Trop d’essais : réessaie dans 15 minutes.', 429);
      const form = await c.req.parseBody();
      if (typeof form.password === 'string' && same(form.password, password)) {
        setCookie(c, 'staff', staffToken, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86_400 });
        return c.redirect('/', 303);
      }
      failed(c);
      await new Promise((r) => setTimeout(r, 600));
      return c.redirect('/login?e=1', 303);
    });
    app.get('/logout', (c) => {
      deleteCookie(c, 'staff', { path: '/' });
      return c.redirect('/login', 303);
    });
    app.use('*', async (c, next) => {
      const cookie = getCookie(c, 'staff');
      if (cookie && same(cookie, staffToken)) return next();
      // Accès par en-tête (scripts, anciens favoris) toujours accepté
      const basic = c.req.header('authorization')?.match(/^Basic (.+)$/)?.[1];
      if (basic) {
        if (blocked(c)) return c.json({ error: 'Trop d’essais : réessaie dans 15 minutes' }, 429);
        if (same(Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':'), password)) return next();
        failed(c);
        await new Promise((r) => setTimeout(r, 600));
      }
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'Non connecté' }, 401);
      // Visiteur non connecté sur l'accueil : vitrine publique Neptune Clipping (exigée par TikTok), le staff passe par /login
      if (c.req.path === '/') return c.html(NEPTUNE_HOME);
      return c.redirect('/login', 302);
    });
  }

  app.get('/', (c) => c.html(ASSETS.html));
  app.get('/app.css', (c) => c.body(ASSETS.css, 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/neo.css', (c) => c.body(ASSETS.neo, 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/app.js', (c) => c.body(ASSETS.js, 200, { 'content-type': 'text/javascript; charset=utf-8' }));

  // --- Mars unique : ce Mars affiche aussi les autres créateurs --------------------------
  // Le programme choisi est gardé dans un cookie ; ses appels /api/* sont relayés vers son
  // service Railway (même DASHBOARD_PASSWORD partout). /api/mars/* reste toujours local.
  const selfName = deps.marsSites?.find((x) => x.url === deps.selfUrl)?.name ?? fans.creator.creatorName;
  const remotes = (deps.marsSites ?? []).filter((x) => x.url !== deps.selfUrl && x.name.toLowerCase() !== selfName.toLowerCase());
  const remoteOf = (c: Context) => remotes.find((x) => x.name === getCookie(c, 'mars_site'));
  const remoteFetch = (site: { url: string }, path: string, init: RequestInit = {}) =>
    (deps.fetchFn ?? fetch)(site.url + path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...(deps.password ? { authorization: `Basic ${Buffer.from(`mars:${deps.password}`).toString('base64')}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
  app.use('/api/*', async (c, next) => {
    const site = c.req.path.startsWith('/api/mars/') ? undefined : remoteOf(c);
    if (!site) return next();
    const url = new URL(c.req.url);
    const method = c.req.method;
    const type = c.req.header('content-type');
    try {
      const res = await remoteFetch(site, url.pathname + url.search, {
        method,
        headers: type ? { 'content-type': type } : {},
        body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
      });
      if (res.status === 401) return c.json({ error: `${site.name} : mot de passe différent (DASHBOARD_PASSWORD doit être identique sur chaque service)` }, 502);
      return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
    } catch {
      return c.json({ error: `${site.name} injoignable` }, 502);
    }
  });
  // Un client = une ligne (un Mars peut porter plusieurs clients, ex. BeOne + Loann)
  // preset : période des vues / posts (7d par défaut) ; series : vues et posts par jour, pour la courbe de « Tous les clients »
  const marsClients = (preset = '7d') => {
    const o = fans.overview();
    const week = agency.range({ preset });
    return repo.listClients().map((cl) => {
      const w = agency.overview(week, cl.id);
      const isFans = cl.id === o.settings.clientId;
      return {
        clientId: cl.id,
        name: cl.name,
        fans: isFans,
        program: isFans ? o.settings.programName : null,
        accent: isFans ? fans.creator.colors.accent : null,
        siteUrl: isFans ? fans.publicSiteUrl() : null,
        fanCount: isFans ? o.fans.length : null,
        coins: isFans ? o.fans.reduce((sum, f) => sum + Math.max(0, f.balance), 0) : null,
        pendingOrders: isFans ? o.orders.filter((x) => x.status === 'pending').length : null,
        views7d: w.kpis.views.value,
        posts7d: w.kpis.posts.value,
        clippers: w.kpis.views.clippers,
        alerts: w.alerts.length,
        series: w.series.map((d) => ({ day: d.day, views: d.views, posts: d.posts })),
      };
    });
  };
  const fansClientId = () => fans.settings().clientId;
  app.get('/api/mars/summary', (c) => c.json(marsClients(c.req.query('preset'))));
  app.get('/api/mars/local-clients', (c) => c.json(repo.listClients().map((cl) => ({ id: cl.id, name: cl.name, fans: cl.id === fansClientId() }))));
  const remoteJson = async (site: { name: string; url: string }, path: string) => {
    try {
      const res = await remoteFetch(site, path);
      if (!res.ok) return { error: res.status === 401 ? 'mot de passe différent' : `erreur ${res.status}` };
      return { data: (await res.json()) as unknown[] };
    } catch {
      return { error: 'injoignable' };
    }
  };
  app.get('/api/mars/sites', async (c) => {
    const cur = remoteOf(c)?.name ?? selfName;
    const self = { name: selfName, current: cur === selfName, clients: repo.listClients().map((cl) => ({ id: cl.id, name: cl.name, fans: cl.id === fansClientId() })) };
    const others = await Promise.all(
      remotes.map(async (x) => {
        const r = await remoteJson(x, '/api/mars/local-clients');
        return { name: x.name, current: cur === x.name, clients: r.data ?? [], error: r.error };
      }),
    );
    return c.json([self, ...others]);
  });
  app.post('/api/mars/site', async (c) => {
    const { name } = z.object({ name: z.string() }).parse(await c.req.json());
    const site = remotes.find((x) => x.name === name);
    if (!site && name !== selfName) return c.json({ error: 'Programme inconnu' }, 404);
    if (site) setCookie(c, 'mars_site', site.name, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86_400 });
    else deleteCookie(c, 'mars_site', { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/api/mars/overview', async (c) => {
    const preset = c.req.query('preset') ?? '7d';
    const others = await Promise.all(
      remotes.map(async (x) => {
        const r = await remoteJson(x, `/api/mars/summary?preset=${encodeURIComponent(preset)}`);
        return r.data ? r.data.map((row) => ({ ...(row as object), site: x.name })) : [{ site: x.name, name: x.name, error: r.error }];
      }),
    );
    return c.json([...marsClients(preset).map((row) => ({ ...row, site: selfName })), ...others.flat()]);
  });

  const rangeOf = (c: { req: { query: (k: string) => string | undefined } }) =>
    agency.range({ preset: c.req.query('preset'), from: c.req.query('from'), to: c.req.query('to') });

  // --- Méta ------------------------------------------------------------------------

  app.get('/api/status', (c) => c.json(status));

  app.get('/api/meta', (c) =>
    c.json({
      status,
      settings: agency.settings(),
      clients: repo.listClients().map((cl) => ({
        id: cl.id,
        name: cl.name,
        slug: cl.slug,
        discordChannelId: cl.discordChannelId,
        monthlyFee: cl.monthlyFeeCents / 100,
        clippers: repo.listClippers({ clientId: cl.id, includeInactive: true }).length,
      })),
      sites: (deps.marsSites ?? []).map((s) => ({ ...s, current: s.url === deps.selfUrl })),
    }),
  );
  app.get('/api/sso-link', (c) => {
    const to = (deps.marsSites ?? []).find((s) => s.url === c.req.query('to'));
    if (!to) return c.json({ error: 'Mars inconnu' }, 404);
    return c.json({ url: ssoLink(to.url) });
  });

  // --- Tableaux de bord ------------------------------------------------------------

  app.get('/api/overview', (c) => c.json(agency.overview(rangeOf(c), clientIdParam(c.req.query('client')))));

  app.get('/api/leaderboard', (c) => {
    const range = rangeOf(c);
    // Programme fans : vues qui rapportent des coins (mêmes règles que le site fans), à côté des vues brutes
    const counted = fans.countedViewsSince(range.from);
    return c.json({
      range,
      rows: agency.ranked(range, clientIdParam(c.req.query('client'))).map((r) => ({
        ...agency.rowJson(r),
        ...(counted && r.clipper.clientId === counted.clientId ? { counted: counted.views.get(r.clipper.id) ?? 0 } : {}),
      })),
    });
  });

  app.get('/api/clippers/:id', (c) => {
    const profile = agency.profile(Number(c.req.param('id')), rangeOf(c));
    return profile ? c.json(profile) : c.json({ error: 'Clipper introuvable' }, 404);
  });

  app.get('/api/top-clips', (c) => c.json({ clips: agency.topClips(rangeOf(c), clientIdParam(c.req.query('client'))) }));

  app.get('/api/inspiration', (c) => {
    const week = Number(c.req.query('week'));
    return c.json(agency.inspiration(Number.isFinite(week) && week > 0 ? week : Date.now(), clientIdParam(c.req.query('client'))));
  });

  app.get('/api/export.csv', (c) => {
    const range = rangeOf(c);
    const rows = agency.ranked(range, clientIdParam(c.req.query('client')));
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['rang', 'clipper', 'agence', 'vues', 'posts', 'jours_actifs', 'strikes', 'score', 'a_verser_eur'].join(';'),
      ...rows.map((r) =>
        [r.rank, esc(r.clipper.username), esc(agency.clientName(r.clipper.clientId)), r.views, r.posts, r.activeDays, r.strikes, r.score.total, r.reward.total.toFixed(2).replace('.', ',')].join(';'),
      ),
    ];
    const name = `clippers_${dayKey(range.from)}_${dayKey(range.to - 1)}.csv`;
    return c.body(`﻿${lines.join('\n')}`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
    });
  });

  // --- Management : clippers --------------------------------------------------------

  app.get('/api/management', (c) =>
    c.json(
      repo.listClippers({ includeInactive: true, clientId: clientIdParam(c.req.query('client')) }).map((cl) => ({
        ...cl,
        hasDiscord: !cl.discordId.startsWith('manual:'),
        agency: agency.clientName(cl.clientId),
        accounts: repo.listAccountsForClipper(cl.id).map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, url: a.url })),
      })),
    ),
  );

  /** Remplace le compte principal de chaque plateforme indiquée (vide = retire). */
  function applyAccounts(clipperId: number, accounts: z.infer<typeof ClipperBody>['accounts'], clientId: number | null) {
    if (!accounts) return [] as string[];
    const errors: string[] = [];
    for (const platform of PLATFORMS) {
      const raw = accounts[platform];
      if (raw === undefined) continue;
      const existing = repo.listAccountsForClipper(clipperId).filter((a) => a.platform === platform);
      const value = raw.trim();
      if (!value) {
        for (const a of existing) repo.deactivateAccount(a.id);
        continue;
      }
      const parsed = parseAccountInput(platform, value);
      if (!parsed || parsed.platform !== platform) {
        errors.push(`Lien ${platform} invalide`);
        continue;
      }
      if (existing.some((a) => a.handle === parsed.handle)) continue;
      const r = repo.registerAccount({ clipperId, clientId, platform, handle: parsed.handle, url: parsed.url });
      if (r.conflict) {
        errors.push(`@${parsed.handle} (${platform}) appartient déjà à ${r.conflict.username}`);
        continue;
      }
      for (const a of existing) repo.deactivateAccount(a.id);
    }
    return errors;
  }

  app.post('/api/clippers', async (c) => {
    const body = ClipperBody.parse(await c.req.json());
    if (!body.username) return c.json({ error: 'Nom requis' }, 400);
    const clipper = repo.createManualClipper(body.username, body.clientId ?? null);
    if (body.status) repo.updateClipper(clipper.id, { status: body.status });
    const warnings = applyAccounts(clipper.id, body.accounts, clipper.clientId);
    return c.json({ clipper: repo.getClipper(clipper.id), warnings });
  });

  app.patch('/api/clippers/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = ClipperBody.parse(await c.req.json());
    const clipper = repo.updateClipper(id, { username: body.username, clientId: body.clientId, status: body.status });
    if (!clipper) return c.json({ error: 'Clipper introuvable' }, 404);
    const warnings = applyAccounts(id, body.accounts, clipper.clientId);
    return c.json({ clipper: repo.getClipper(id), warnings });
  });

  // Compte Discord perdu : tout l'historique passe sur le nouveau compte (ID Discord, ou mention <@id>)
  app.post('/api/clippers/:id/transfer', async (c) => {
    const body = z.object({ discordId: z.string().trim(), username: z.string().trim().max(64).optional() }).parse(await c.req.json());
    const discordId = body.discordId.match(/\d{15,22}/)?.[0];
    if (!discordId) return c.json({ error: 'ID Discord invalide (clic droit sur le membre → Copier l’identifiant)' }, 400);
    return c.json({ clipper: repo.transferClipper(Number(c.req.param('id')), discordId, body.username) });
  });

  app.delete('/api/clippers/:id', (c) => {
    repo.deleteClipper(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.get('/api/discord/roles', async (c) => {
    if (!deps.bot.current) return c.json({ error: 'Bot Discord non connecté' }, 503);
    return c.json(await deps.bot.current.roles());
  });

  app.post('/api/discord/import', async (c) => {
    const bot = deps.bot.current;
    if (!bot) return c.json({ error: 'Bot Discord non connecté' }, 503);
    const body = z.object({ roleId: z.string().regex(/^\d+$/), clientId: z.number().int().positive().nullable() }).parse(await c.req.json());
    const members = await bot.membersWithRole(body.roleId);
    let created = 0;
    for (const m of members) {
      const existed = repo.getClipperByDiscordId(m.id);
      repo.upsertClipper(m.id, m.name, Date.now(), body.clientId);
      if (!existed) created++;
    }
    return c.json({ found: members.length, created });
  });

  // --- Strikes & retours --------------------------------------------------------------

  app.post('/api/clippers/:id/strikes', async (c) => {
    const clipper = repo.getClipper(Number(c.req.param('id')));
    if (!clipper) return c.json({ error: 'Clipper introuvable' }, 404);
    const { reason, notify } = z
      .object({ reason: z.string().trim().min(1).max(500), notify: z.boolean().default(true) })
      .parse(await c.req.json());
    const strike = repo.addStrike(clipper.id, reason);
    const sent = notify && deps.bot.current
      ? await deps.bot.current.send(clipper, `⚠️ Tu as reçu un **strike** : ${reason}`)
      : false;
    return c.json({ strike, sent });
  });

  app.delete('/api/strikes/:id', (c) => {
    repo.deleteStrike(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.post('/api/videos/:id/feedback', async (c) => {
    const video = repo.getVideo(Number(c.req.param('id')));
    if (!video) return c.json({ error: 'Vidéo introuvable' }, 404);
    const clipper = repo.getClipper(video.clipperId)!;
    const { message } = z.object({ message: z.string().trim().min(1).max(1500) }).parse(await c.req.json());
    const id = repo.addFeedback(clipper.id, video.id, message);
    const link = video.url ? `\n${video.url}` : '';
    const sent = deps.bot.current ? await deps.bot.current.send(clipper, `📝 **Retour sur ta vidéo** :${link}\n\n${message}`) : false;
    if (sent) repo.markFeedbackDelivered(id);
    return c.json({ ok: true, sent });
  });

  // --- Rémunération -------------------------------------------------------------------

  app.get('/api/remuneration', (c) => c.json(agency.payoutSummary(rangeOf(c), clientIdParam(c.req.query('client')))));

  app.get('/api/rewards', (c) =>
    c.json({
      universal: normalizeRewardConfig(repo.getRewardRule('universal', 0) ?? {}),
      overrides: repo.listRewardRuleScopes().filter((s) => s.scope !== 'universal'),
    }),
  );

  app.get('/api/rewards/:scope/:id', (c) => {
    const scope = c.req.param('scope');
    const id = Number(c.req.param('id'));
    const raw = repo.getRewardRule(scope, scope === 'universal' ? 0 : id);
    return c.json({ exists: raw !== undefined, config: normalizeRewardConfig(raw ?? repo.getRewardRule('universal', 0) ?? {}) });
  });

  app.put('/api/rewards/:scope/:id', async (c) => {
    const scope = z.enum(['universal', 'client', 'clipper']).parse(c.req.param('scope'));
    const config = normalizeRewardConfig(await c.req.json());
    repo.setRewardRule(scope, scope === 'universal' ? 0 : Number(c.req.param('id')), config);
    return c.json({ ok: true, config });
  });

  app.delete('/api/rewards/:scope/:id', (c) => {
    const scope = z.enum(['client', 'clipper']).parse(c.req.param('scope'));
    repo.deleteRewardRule(scope, Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // --- Paramètres & agences -------------------------------------------------------------

  app.put('/api/settings', async (c) => c.json(agency.saveSettings(await c.req.json())));

  app.post('/api/clients', async (c) => {
    const body = ClientBody.parse(await c.req.json());
    if (!body.name) return c.json({ error: 'Nom requis' }, 400);
    const created = repo.upsertClient({
      name: body.name,
      discordChannelId: body.discordChannelId || null,
      rule: { ratePer1kCents: 0, minViews: 0, capCents: null },
    });
    repo.updateClient(created.id, { monthlyFeeCents: Math.round((body.monthlyFee ?? 0) * 100) });
    return c.json(repo.getClient(created.id));
  });

  app.patch('/api/clients/:id', async (c) => {
    const body = ClientBody.parse(await c.req.json());
    const updated = repo.updateClient(Number(c.req.param('id')), {
      name: body.name,
      discordChannelId: body.discordChannelId === undefined ? undefined : body.discordChannelId || null,
      monthlyFeeCents: body.monthlyFee === undefined ? undefined : Math.round(body.monthlyFee * 100),
    });
    return updated ? c.json(updated) : c.json({ error: 'Agence introuvable' }, 404);
  });

  app.delete('/api/clients/:id', (c) => {
    repo.deleteClient(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // --- Recrutement (phase 2) --------------------------------------------------------------

  const { recruitment } = deps;
  const rec = recruitment.rec;
  const ticket = (channelId: string | null) => (channelId ? deps.bot.current?.ticketUrl(channelId) ?? null : null);

  app.get('/api/recruitment/settings', (c) => c.json(recruitment.settings()));
  app.put('/api/recruitment/settings', async (c) => c.json(recruitment.saveSettings(await c.req.json())));

  app.get('/api/funnel', (c) => {
    const recruiter = clientIdParam(c.req.query('recruiter'));
    const f = recruitment.funnel(rangeOf(c), { recruiterId: recruiter });
    return c.json({ ...f, people: f.people.map((p) => ({ ...p, ticketUrl: ticket(p.channelId) })) });
  });

  app.get('/api/agency-cards', (c) => c.json(recruitment.agencyCards(rangeOf(c))));

  app.get('/api/recruiters', (c) => c.json({ settings: recruitment.settings(), rows: recruitment.recruitersReport(rangeOf(c)) }));

  app.patch('/api/recruiters/:id', async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() }).parse(await c.req.json());
    rec.updateRecruiter(Number(c.req.param('id')), body);
    return c.json({ ok: true });
  });

  app.delete('/api/recruiters/:id', (c) => {
    rec.deleteRecruiter(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.get('/api/suivi', (c) => {
    const s = recruitment.suivi(rangeOf(c));
    const withTicket = <T extends { channelId: string | null }>(list: T[]) => list.map((x) => ({ ...x, ticketUrl: ticket(x.channelId) }));
    return c.json({
      ...s,
      toTreat: {
        ...s.toTreat,
        tests: withTicket(s.toTreat.tests),
        messages: withTicket(s.toTreat.messages),
        candidatures: withTicket(s.toTreat.candidatures),
      },
      rows: withTicket(s.rows),
    });
  });

  app.post('/api/candidatures/:id/decide', async (c) => {
    const id = Number(c.req.param('id'));
    const { accept } = z.object({ accept: z.boolean() }).parse(await c.req.json());
    const cand = rec.candidature(id);
    if (!cand) return c.json({ error: 'Candidature introuvable' }, 404);
    if (cand.status !== 'submitted' && cand.status !== 'open') return c.json({ error: 'Candidature déjà traitée' }, 400);
    if (deps.bot.current) return c.json({ ok: true, warnings: await deps.bot.current.decideCandidature(id, accept, 'dashboard') });
    rec.decideCandidature(id, accept, 'dashboard');
    if (accept) rec.setStage(cand.clipperId, 'test');
    return c.json({ ok: true, warnings: ['Bot hors ligne : message et rôle Discord non envoyés'] });
  });

  app.post('/api/tests/:clipperId/validate', async (c) => {
    const clipperId = Number(c.req.param('clipperId'));
    if (!rec.candidate(clipperId)) return c.json({ error: 'Candidat introuvable' }, 404);
    if (deps.bot.current) return c.json({ ok: true, warnings: await deps.bot.current.validateTest(clipperId) });
    const test = rec.currentTest(clipperId);
    if (test) rec.reviewTest(test.id, 'validated', null);
    rec.setStage(clipperId, 'clipper');
    return c.json({ ok: true, warnings: ['Bot hors ligne : message et rôle Discord non envoyés'] });
  });

  app.post('/api/tests/:clipperId/review', async (c) => {
    const clipperId = Number(c.req.param('clipperId'));
    const { note, final } = z.object({ note: z.string().trim().max(1500).default(''), final: z.boolean().default(false) }).parse(await c.req.json());
    if (!final && !note) return c.json({ error: 'Explique ce qu’il faut corriger' }, 400);
    if (!rec.candidate(clipperId)) return c.json({ error: 'Candidat introuvable' }, 404);
    if (deps.bot.current) return c.json({ ok: true, warnings: await deps.bot.current.reviewTest(clipperId, note, final) });
    const test = rec.currentTest(clipperId);
    if (test) rec.reviewTest(test.id, final ? 'refused' : 'changes', note);
    if (final) rec.setStage(clipperId, 'refuse');
    return c.json({ ok: true, warnings: ['Bot hors ligne : message Discord non envoyé'] });
  });

  app.post('/api/requests/:id/done', (c) => {
    rec.closeRequest(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  /** Réponse à une demande d'avis : enregistrée comme analyse + envoyée sur Discord. */
  app.post('/api/requests/:id/feedback', async (c) => {
    const request = rec.request(Number(c.req.param('id')));
    if (!request) return c.json({ error: 'Demande introuvable' }, 404);
    const clipper = repo.getClipper(request.clipperId);
    if (!clipper) return c.json({ error: 'Clipper introuvable' }, 404);
    const { message } = z.object({ message: z.string().trim().min(1).max(1500) }).parse(await c.req.json());
    const id = repo.addFeedback(clipper.id, null, message);
    const link = request.payload.url ? `\n${request.payload.url}` : '';
    const sent = deps.bot.current ? await deps.bot.current.send(clipper, `📝 **Retour sur ta vidéo** :${link}\n\n${message}`) : false;
    if (sent) repo.markFeedbackDelivered(id);
    rec.closeRequest(request.id);
    return c.json({ ok: true, sent });
  });

  app.get('/api/discord/channels', async (c) => {
    if (!deps.bot.current) return c.json({ error: 'Bot Discord non connecté' }, 503);
    return c.json(await deps.bot.current.channels());
  });

  app.post('/api/discord/test-message', async (c) => {
    if (!deps.bot.current) return c.json({ error: 'Bot Discord non connecté' }, 503);
    const { channelId } = z.object({ channelId: z.string().regex(/^\d+$/) }).parse(await c.req.json());
    await deps.bot.current.publishTestMessage(channelId);
    recruitment.saveSettings({ testChannelId: channelId });
    return c.json({ ok: true });
  });

  app.post('/api/discord/start-message', async (c) => {
    if (!deps.bot.current) return c.json({ error: 'Bot Discord non connecté' }, 503);
    const { channelId } = z.object({ channelId: z.string().regex(/^\d+$/) }).parse(await c.req.json());
    await deps.bot.current.publishStartMessage(channelId);
    recruitment.saveSettings({ welcomeChannelId: channelId });
    return c.json({ ok: true });
  });

  app.post('/api/discord/candidature-message', async (c) => {
    if (!deps.bot.current) return c.json({ error: 'Bot Discord non connecté' }, 503);
    const { channelId } = z.object({ channelId: z.string().regex(/^\d+$/) }).parse(await c.req.json());
    await deps.bot.current.publishCandidatureMessage(channelId);
    recruitment.saveSettings({ candidatureChannelId: channelId });
    return c.json({ ok: true });
  });

  // --- Programme fans : boutique (staff) ----------------------------------------------

  app.get('/api/fans', async (c) => c.json({ ...fans.overview(), tracking: fans.trackingReport(), notifications: fans.fans.notificationStats(Date.now() - 7 * 86_400_000), avatars: { urls: await fans.creatorAvatars(deps.youtubeApiKey), errors: fans.avatarErrors }, neptune: status.neptune, fansBot: !!deps.fansBotSends, neptuneKey: !!deps.neptuneApiKey, robloxKey: !!deps.robloxApiKey, gameApi: !!deps.game, emailApi: !!deps.emailApi, apify: deps.apifyUsage ? await deps.apifyUsage().catch(() => null) : null, gameCheck: deps.game ? await deps.game.rateLimit().then((r) => ({ ok: true as const, remaining: r.remaining, limit: r.limit, windowSeconds: r.windowSeconds })).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })) : null }));
  // Funnel d'onboarding des fans (où ils s'arrêtent : serveur → règles → formation → inscription → 1er clip → coins → échange)
  app.get('/api/fans/onboarding', (c) => c.json(fans.onboardingFunnel()));
  // Recherche d'un compte (TikTok / Insta / YouTube) ou d'un pseudo, tous clippeurs confondus ; « Libérer » = le retirer de son propriétaire
  app.get('/api/accounts/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    return c.json({ results: q.length >= 2 ? repo.searchAccounts(q) : [] });
  });
  app.post('/api/accounts/:id/release', (c) => {
    repo.deactivateAccount(Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  // Questions du salon ❓│aide que la FAQ automatique n'a pas reconnues
  app.get('/api/fans/faq-misses', (c) => c.json({ misses: fans.fans.faqMisses() }));
  app.delete('/api/fans/faq-misses/:id', (c) => {
    fans.fans.deleteFaqMiss(Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.put('/api/fans/settings', async (c) => {
    const body = z
      .object({
        clientId: z.number().int().positive().nullable().optional(),
        pointsPer1000: z.number().min(0).max(1_000_000).optional(),
        programName: z.string().max(60).optional(),
        tagline: z.string().max(160).optional(),
        heroMediaUrl: z.string().max(500).optional(),
        discordInviteUrl: z.string().max(500).optional(),
        featured: z.string().max(5000).optional(),
        creatorYoutube: z.string().max(60).optional(),
        creatorRoblox: z.string().max(20).optional(),
        training: z.string().max(5000).optional(),
        clipRule: z.boolean().optional(),
        clipKeywords: z.string().max(300).optional(),
        orderReview: z.boolean().optional(),
        accountReview: z.boolean().optional(),
      })
      .parse(await c.req.json());
    return c.json(fans.saveSettings(body));
  });
  app.post('/api/shop/items', async (c) => c.json(fans.saveItem(null, ItemBody.parse(await c.req.json()))));
  app.put('/api/shop/items/:id', async (c) => c.json(fans.saveItem(Number(c.req.param('id')), ItemBody.parse(await c.req.json()))));
  app.delete('/api/shop/items/:id', (c) => {
    fans.fans.deleteItem(Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.get('/api/shop/game-products', async (c) => {
    if (!deps.game) return c.json({ error: 'API du jeu non configurée (GAME_API_URL + GAME_API_TOKEN sur Railway)' }, 503);
    try {
      const inShop = new Set(fans.fans.items().map((i) => i.ref));
      return c.json({ products: (await deps.game.products()).map((p) => ({ ...p, inShop: inShop.has(String(p.id)) })) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
  // Relevé manuel des vues des fans (en plus du relevé de minuit)
  app.post('/api/fans/refresh', (c) => {
    if (!deps.refreshFans) return c.json({ error: 'Relevé indisponible' }, 400);
    return c.json(deps.refreshFans());
  });
  // Fan « à vérifier » : validé par le staff (achats débloqués, plus jamais signalé)
  app.post('/api/fans/:id/review', async (c) => {
    const { approved } = z.object({ approved: z.boolean() }).parse(await c.req.json());
    fans.setReview(Number(c.req.param('id')), approved);
    return c.json({ ok: true });
  });
  app.post('/api/fans/:id/bonus', async (c) => {
    const { amount } = z.object({ amount: z.number().int().min(-1_000_000).max(1_000_000) }).parse(await c.req.json());
    fans.fans.addBonus(Number(c.req.param('id')), amount);
    return c.json({ ok: true });
  });
  // Clip refusé (pas de #tag lu) vérifié à la main par le staff : il compte
  app.post('/api/fans/clips/:id/approve', (c) => {
    const clientId = fans.settings().clientId;
    return clientId && fans.fans.approveClip(Number(c.req.param('id')), clientId) ? c.json({ ok: true }) : c.json({ error: 'Clip introuvable' }, 404);
  });
  // Nouveau compte d'un fan : validé (ses vues comptent) ou refusé (retiré du suivi)
  app.post('/api/fans/accounts/:id/review', async (c) => {
    const { ok } = z.object({ ok: z.boolean() }).parse(await c.req.json());
    fans.reviewAccount(Number(c.req.param('id')), ok);
    return c.json({ ok: true });
  });
  app.post('/api/shop/orders/:id/approve', (c) => c.json({ ok: fans.fans.approve(Number(c.req.param('id'))) }));
  app.post('/api/shop/orders/:id/refund', (c) => c.json({ ok: fans.fans.refund(Number(c.req.param('id'))) }));
  app.post('/api/shop/orders/:id/delivered', (c) => {
    const ok = fans.fans.markDelivered([Number(c.req.param('id'))], null) > 0;
    // Message privé « livré » préparé tout de suite (sinon au prochain passage, jusqu'à 30 min)
    if (ok && (deps.fansBotSends || deps.neptuneApiKey)) fans.generateNotifications();
    return c.json({ ok });
  });

  // Toute autre route GET renvoie l'application (navigation côté navigateur).
  app.get('*', (c) => c.html(ASSETS.html));

  return app;
}

export function startWeb(app: Hono, port: number): () => void {
  const server = serve({ fetch: app.fetch, port });
  return () => server.close();
}
