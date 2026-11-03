import type { Platform } from '../domain/links.js';
import type { VideoInput } from '../db/repo.js';

export interface FetchedAccount {
  /** ID stable côté plateforme (ex. ID de chaîne YouTube), mis en cache pour les appels suivants. */
  externalId?: string;
  displayName?: string;
  /** Vidéos récentes du compte avec leurs compteurs actuels. */
  videos: VideoInput[];
  /** Bio / description du compte (vérification par code) et nombre d'abonnés, si la source les donne. */
  bio?: string;
  followers?: number;
}

export interface FetchedProfile {
  externalId?: string;
  bio?: string;
  followers?: number;
}

export interface PlatformFetcher {
  readonly platform: Platform;
  fetchAccount(account: { handle: string; externalId: string | null }): Promise<FetchedAccount>;
  /** Profil seul (bio + abonnés), à la demande : vérification du code dans la bio. */
  fetchProfile?(account: { handle: string; externalId: string | null }): Promise<FetchedProfile>;
  /** Un clip précis à partir de son lien (clip jamais vu par les relevés) : son compte (pseudo ou ID) + ses compteurs. */
  fetchVideo?(url: string): Promise<{ owner: string | null; ownerId: string | null; video: VideoInput } | null>;
}

export type FetcherRegistry = Record<Platform, PlatformFetcher>;
