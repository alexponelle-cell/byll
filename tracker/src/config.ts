import { existsSync } from 'node:fs';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  /** Créateur du programme fans (fichier src/creators/<id>.ts) : beone (défaut), squiduu… */
  CREATOR: optionalString,
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,

  /**
   * Bot « BeOne Rewards » (programme fans) : /site, /coins et messages privés aux fans.
   * FANS_BOT_GUILD_ID : serveur(s) où enregistrer les commandes, séparés par des virgules (sinon global, ~1 h).
   */
  FANS_BOT_TOKEN: optionalString,
  FANS_BOT_CLIENT_ID: optionalString,
  FANS_BOT_GUILD_ID: optionalString,
  /** Clé partagée avec le bot Neptune (Python) : il demande les liens /site et les points. */
  NEPTUNE_API_KEY: optionalString,
  /**
   * Connexion « Se connecter avec Discord » de la boutique fans (OAuth2).
   * App Discord utilisée (ex. celle de Neptune) : son Client ID + Client Secret,
   * et l'URL de redirection <PUBLIC_URL>/fan/auth/callback ajoutée dans le portail (OAuth2 > Redirects).
   */
  OAUTH_CLIENT_ID: optionalString,
  OAUTH_CLIENT_SECRET: optionalString,
  /** Clé partagée avec le jeu Roblox pour livrer les achats de la boutique. */
  ROBLOX_API_KEY: optionalString,
  /** API du jeu (serveur du dev) : adresse + token, pour importer le catalogue et livrer les achats. */
  GAME_API_URL: optionalString,
  GAME_API_TOKEN: optionalString,
  /** API de livraison par e-mail (ex. Squiduuverse : +1 mois au compte de cet e-mail). */
  SQUIDUU_API_URL: optionalString,
  SQUIDUU_API_TOKEN: optionalString,
  /** API de livraison par e-mail du service offert (même format que Squiduuverse), ex. Merguez Superstar pour Loann. */
  GRANT_API_URL: optionalString,
  GRANT_API_TOKEN: optionalString,

  DATABASE_PATH: z.string().default('./data/tracker.db'),

  WEB_PORT: z.coerce.number().int().positive().default(3000),
  /** URL publique du dashboard (affichée dans les messages du bot). */
  PUBLIC_URL: optionalString,
  DASHBOARD_PASSWORD: optionalString,
  /**
   * Menu « Programme » de Mars : les autres Mars (un par créateur) entre lesquels basculer sans se reconnecter.
   * Format : « Nom=https://adresse,Nom=https://adresse » (même valeur et même DASHBOARD_PASSWORD sur chaque service).
   */
  MARS_SITES: optionalString,

  FETCHER_MODE: z.enum(['mock', 'live']).default('mock'),
  YOUTUBE_API_KEY: optionalString,
  APIFY_TOKEN: optionalString,
  VIDEOS_PER_ACCOUNT: z.coerce.number().int().positive().default(30),
  /**
   * API officielle TikTok (gratuite) : le clippeur connecte son TikTok sur le site (« Connecter mon TikTok »).
   * App créée sur developers.tiktok.com (Login Kit, scopes user.info.basic, user.info.profile, user.info.stats, video.list),
   * redirection <PUBLIC_URL>/fan/tiktok/callback.
   */
  TIKTOK_CLIENT_KEY: optionalString,
  TIKTOK_CLIENT_SECRET: optionalString,
  /**
   * Adresse de retour TikTok / Instagram (et YOUTUBE_REDIRECT_URI) enregistrée chez eux, si ce n'est pas ce service (ex. celle de lune) :
   * ce service-là renvoie le clippeur ici avec son code (relais), sans redemander de validation à TikTok / Meta.
   */
  TIKTOK_REDIRECT_URI: optionalString,
  INSTAGRAM_REDIRECT_URI: optionalString,
  /** Comptes TikTok pas encore connectés : relus via Apify (payant) tant que c'est « 1 », ignorés sinon. */
  TIKTOK_APIFY_FALLBACK: z.enum(['0', '1']).default('1'),
  /**
   * Vérification du site par TikTok (« Verify URL properties » → URL prefix) : TikTok donne un fichier
   * (ex. tiktokAbC123.txt) et son contenu ; le site le sert à la racine. Pas secret.
   */
  TIKTOK_VERIFY_FILE: optionalString,
  TIKTOK_VERIFY_CONTENT: optionalString, // le contenu suffit : le nom du fichier s'en déduit
  /**
   * API Instagram officielle (gratuite) : app Meta (developers.facebook.com), produit « Instagram » →
   * « API setup with Instagram login », redirection <PUBLIC_URL>/fan/instagram/callback.
   */
  INSTAGRAM_APP_ID: optionalString,
  INSTAGRAM_APP_SECRET: optionalString,
  /** Comptes Instagram pas encore connectés : relus via Apify (payant) tant que c'est « 1 », ignorés sinon. */
  INSTAGRAM_APIFY_FALLBACK: z.enum(['0', '1']).default('1'),
  /**
   * « Connecter mon YouTube » (connexion Google, gratuite) : client OAuth « Application Web » créé sur
   * console.cloud.google.com (scope youtube.readonly), redirection <PUBLIC_URL>/fan/youtube/callback.
   * Les vues restent lues avec YOUTUBE_API_KEY. Tant que l'app Google est en « Test », seuls les utilisateurs test
   * peuvent se connecter : ne mettre ces variables qu'une fois l'app validée par Google.
   */
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  YOUTUBE_REDIRECT_URI: optionalString,

  COLLECT_INTERVAL_MINUTES: z.coerce.number().positive().default(60),
  /** Comptes de fans lus par Apify (payant) et actifs : relus toutes les N nuits (1 = chaque nuit, 2 = une sur deux, moitié prix). */
  FAN_APIFY_EVERY_DAYS: z.coerce.number().int().min(1).max(7).default(1),
  RELANCE_CHECK_INTERVAL_MINUTES: z.coerce.number().positive().default(180),

  INACTIVITY_DAYS: z.coerce.number().positive().default(3),
  DROP_WINDOW_DAYS: z.coerce.number().positive().default(7),
  DROP_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).default(30),
  DROP_MIN_PREVIOUS_VIEWS: z.coerce.number().min(0).default(1000),
  RELANCE_COOLDOWN_HOURS: z.coerce.number().min(0).default(24),
});

export type Config = z.infer<typeof schema>;

// Les hébergeurs (Railway, Render, Fly…) imposent le port via PORT.
export const config: Config = schema.parse({ ...process.env, WEB_PORT: process.env.PORT ?? process.env.WEB_PORT });
