# Neptune / « lune » : tout le contexte

Ce document est la mémoire complète du projet, pour qu'une nouvelle session Claude puisse reprendre exactement là où
on en est, avec la même façon de penser. Il complète `CLAUDE.md`, qui le charge automatiquement.
**À tenir à jour** à chaque étape importante (section 12).

---

## 1. Les personnes et la façon de travailler

### Alex
- Francophone, **non technique**, **mineur**. Il dirige l'agence avec **Lucas** et un 3ᵉ associé.
- Il écrit vite, en abrégé, avec des fautes (« c bn », « jsp », « ya », « tt », « pr », « mtn », « frerot », « GO »).
  Comprendre l'intention, ne pas corriger.
- Il veut des **réponses très courtes**. « + conscis » ou « +++ conscis » = beaucoup trop long, il faut diviser par 3.
  Format idéal : 3 à 6 lignes, ou une liste d'étapes numérotées.
- « GO » = fais-le tout de suite, sans redemander. « c » ou « c bon » = étape faite, donne la suivante.
- « step by step » = **une seule action à la fois**, avec le nom exact du bouton où cliquer.
  « ts les steps d'un coup » = la liste complète d'un coup.
- Il envoie beaucoup de **captures d'écran**. Les lire attentivement : souvent la réponse y est
  (mauvais champ rempli, bouton pas sauvegardé, mauvais compte connecté…).
- Il teste lui-même sur Railway, Discord, TikTok Developers, Meta, Apify. On le guide clic par clic.
- Il pousse pour aller vite (« on peut rien faire mtn ? vraiment productif mtn GO »).
  Quand quelque chose bloque côté externe (validation TikTok, Meta…), proposer ce qu'on peut avancer en parallèle.
- Il remet parfois en question (« tu sais ce que tu fais hein ? », « pk on supp ? »).
  Expliquer le pourquoi en une phrase, calmement.

### Lucas
- Associé. Il envoie des listes d'idées et des priorités (via Alex, souvent en capture WhatsApp).
- Sa ligne : « limite au max les dépenses quitte à ce que ça s'actualise moins ou que ça prenne du temps ».
- Sa dernière liste :
  - sites v1 pour les prospects (Cubi Game, Croshoot, Josplay, Nighting) ;
  - « Apify maison » ou une solution gratuite (réponse : les connexions officielles TikTok / Instagram) ;
  - améliorer le système avec sa data ;
  - une IA qui répond aux clippeurs à partir des tutos, conférences et ateliers.

### Autres noms
- **Laro** : membre de l'équipe ou d'un ancien système. L'ancien site « Neptune Academy » venait de lui (« le truc de laro »).
  Il signale aussi des erreurs (Apify, par exemple).
- **Elie**, **Science**, **Sabr** : noms vus dans la structure du serveur des monteurs.
  La structure d'Elie a servi de modèle.
- **Adrien / 2spi** : un funnel de serveur avait été fait pour lui. Mis de côté (« oublie le 2spi »).
- Comptes de test :
  - **kzom4** : TikTok de test, en Sandbox. Il était relié au clippeur « Paul.clipping », hors agence.
  - **alexponelle** : compte Instagram pro d'Alex, qui a servi au test Instagram.

### Règles de sécurité (non négociables)
- Ne **jamais** demander, afficher, répéter ni committer un token, une clé API, un mot de passe ou un secret.
  Alex les colle lui-même dans **Railway → service → Variables**. Lui dire : « Ne m'envoie aucune valeur ».
  S'il en colle une par erreur dans le chat : lui dire de la régénérer.
- Ne jamais committer `token.txt` ni de fichier `.bat` contenant des secrets (`discord-setup/start-bot.bat` existe, attention).
- Ne jamais mettre de nom de modèle d'IA dans les commits ou les PR.
- Pas de PR sauf si Alex la demande explicitement.
- Alex est mineur. Pour les démarches administratives (entreprise, Meta, paiements), passer par ses parents.
  Ne jamais suggérer de contourner une vérification d'âge ou d'identité.

### Ma façon de penser (à reproduire)
1. **Comprendre le vrai problème** derrière la demande. Exemples :
   - « la file est ingérable » → automatiser le tri, pas juste expliquer la file ;
   - « Apify coûte cher » → espacer les relevés, puis passer aux API officielles gratuites.
2. **Gratuit d'abord.** Chaque fonctionnalité doit coûter 0 € si possible. Sinon, le dire clairement avec le prix max.
3. **Réutiliser l'existant** : les gabarits du site, les configs créateurs, les fonctions déjà testées.
   Exemple : les maquettes prospects ont été refaites sur le vrai site, parce qu'Alex trouvait les premières « pas au niveau ».
4. **Livrer vérifié** : `npx tsc --noEmit`, `npx vitest run`, et une capture d'écran Playwright pour tout ce qui est visuel.
   Ensuite seulement : commit, push, et une explication courte.
5. **Toujours dire ce qu'Alex doit faire ensuite**, de façon concrète : où cliquer, quelle variable ajouter, quand redéployer.
6. **Honnêteté** : dire ce qui n'est pas possible, par exemple « je ne peux pas ouvrir croshop.fr d'ici » ou « je ne génère pas d'images ».
   Proposer l'alternative : envoyer une capture, découper l'image dans ses captures, etc.
7. **Messages Discord** : ton chaleureux, emojis, phrases courtes, vocabulaire de jeunes. Les exemples sont dans `tracker/src/creators/*.ts`, champ `discord`.

---

## 2. Le business

- **Neptune** est une agence de clipping. Des clippeurs postent des extraits (« clips ») des vidéos d'un créateur YouTube
  sur TikTok, Instagram Reels et YouTube Shorts. Ça fait connaître le créateur.
- **Deux modèles** coexistent :
  1. **Agence** : des clippeurs « pros » sont payés en € pour 1 000 vues, avec un barème par client
     (minimum de vues, plafond). Suivis dans Mars.
  2. **Programme fans** : des fans clippent gratuitement et gagnent des **coins** (10 coins pour 1 000 vues par défaut).
     Ils les échangent contre une **récompense** dans la boutique du site. C'est le cœur actuel.
- Pour chaque créateur, il y a **un site fans** (vues → coins → boutique), **un serveur Discord** monté par `/setup`,
  et **un bot** (une application Discord par créateur).

### Créateurs actifs

| Créateur | Programme | Gabarit du site | Récompense | Livraison |
| --- | --- | --- | --- | --- |
| **BeOne** (@BeOnePourcent) | BEONE REWARDS | `playful` (clair, jaune), `fan.html` | objets / gamepass dans son jeu Roblox | automatique via l'API du jeu (`GAME_API_URL` / `GAME_API_TOKEN`), pseudo Roblox |
| **SQUIDUU** | SQUIDUU | `sober` (noir #0B0A0C, jaune #FCD005, Montserrat) | 1 mois de Squiduuverse = 10 000 coins | automatique via l'API Squiduuverse (`SQUIDUU_API_URL` / `TOKEN`), e-mail Google, orderId anti-doublon |
| **Cubi Game** (signé, oct. 2026) | CUBI GAME CLIPPING | mise en page Loann, skin `cubi` (noir et blanc, Bungee, blocs, paliers en cubes) | 1 mois de Roblox Academy = 1 000 coins (100 k vues) | à la main pour l'instant |
| **Loann** (@LoannLV + 2ᵉ chaîne) | LOANN CLIPPING | style `ms` = charte de Merguez Superstar (ms-creators.com) : crème étoilé #FFF7E6, contours noirs #212121, jaune #FFD36E, vagues pêche/orange/corail, Passion One + Cal Sans + Inter | 1 mois de Merguez Superstar (ms-creators.com) = 10 000 coins | e-mail |

### Historique et état
- **SQUIDUU** : campagne officiellement lancée. Le parcours complet a été testé de bout en bout. Les clippeurs sont arrivés.
- **Loann** : « on met les bouchées doubles ». Test d'inscription à faire.
- **DEBO** : ne répond plus, abandonné. Son service Railway et son bot ont été **recyclés pour Cubi**.
- **Loann** (règles spéciales, voir `creators/loann.ts`) : pas de #tag obligatoire (`clipRule: false`) ; tous les clips depuis le **1er août 2026** comptent (`countViewsFrom`) ; comptes de confiance (`trustAccounts` : pas de vérif staff, achats sans validation) ; **podium du mois** (`monthlyPrize: 3` : le 1er du mois, le top 3 reçoit 1 mois de MS offert) ; `/inscription2` + bouton « ➕ 2e compte » (2ᵉ compte par réseau, `accounts.slot`, v19). Livraison MS **manuelle** tant que MS n'a pas fourni l'API (spec envoyée au dev de Loann : `POST /grant {email, months, orderId}` + Bearer ; variables `GRANT_API_URL` / `GRANT_API_TOKEN`).
- **Josplay** : un call a eu lieu. Il reste à trouver comment rémunérer ses clippeurs (récompense non définie).

### Prospects
- **Cubi Game** : **signé** → créateur actif (voir plus haut).
- **Croshoot** (boutique croshop.fr, peluche Bob à 29,99 €).
- **Josplay** (Mii, bleu #7BC7EA). Ses chaînes : @josplay012 (573 k), @JosplayGaming, @Josplay2.
- **Nighting** : maquette pas encore faite. Attendre son prompt de DA et ses captures.

### Autres outils
- **Mars** : le dashboard staff (DA rouge martien, « Developed by Neptune »).
- **Serveur des monteurs** : « Agence PersonalBrand360 ».

---

## 3. Architecture technique (`tracker/`)

- **Stack** : Node ≥ 22, TypeScript ESM, discord.js v14, better-sqlite3, Hono (`@hono/node-server`), zod, vitest, tsx.
- **Scripts** :
  - `npm run dev` : tsx watch ;
  - `npm run build` : tsc et copie de `src/web/app` vers `dist/web/` ;
  - `npm start` ;
  - `npm test` ;
  - `npm run register-commands`.
- **Vérifier avant chaque push** : `cd tracker && npx tsc --noEmit && npx vitest run` (94 tests, 8 fichiers dans `test/`).

### Dossiers

| Chemin | Rôle |
| --- | --- |
| `src/index.ts` | Démarrage : config, DB, fetchers (YouTube / TikTok / Instagram / Apify), bots, serveur web, tâches planifiées |
| `src/config.ts` | Variables d'environnement validées par zod (liste en section 5) |
| `src/creators/` | **Config de chaque créateur** (`beone.ts`, `squiduu.ts`, `debo.ts`, `loann.ts`), le type dans `types.ts` et `index.ts` (`CREATORS`). `prospects.ts` = les maquettes |
| `src/db/schema.ts` | Migrations SQLite numérotées (**v18** actuellement). Toujours ajouter une nouvelle version, ne jamais modifier une ancienne |
| `src/db/repo.ts`, `src/db/fans.ts` | Accès aux données (agence, fans) |
| `src/domain/` | Logique pure testable : `coaching.ts`, `links.ts` (parse des liens de profils), `remuneration.ts`, `time.ts`… |
| `src/services/` | `agency.ts` (stats, coaching, erreurs lisibles), `fans.ts` (programme fans : coins, boutique, classement, tri des comptes, connexions officielles), `game.ts` (API du jeu Roblox), `emailGrant.ts` (livraison par e-mail / API), `clipCheck.ts` (vérif des légendes), `training.ts` (formation), `recruitment.ts`, `analytics.ts` |
| `src/platforms/` | Fetchers de vues : YouTube (API officielle), Apify (TikTok / Insta), `tiktokOfficial.ts`, `instagramOfficial.ts`, `oauthTokens.ts` |
| `src/jobs/` | `collect.ts` (relevés : quels comptes, quand), `relance.ts` (relance des clippeurs inactifs), `scheduler.ts` (`every()`) |
| `src/bot/` | Bots Discord : `commands.ts` / `register.ts` (commandes), `fanServer.ts` (/setup du serveur créateur), `fans.ts` (inscription, /site, /coins), `fanAutomation.ts` (rôles de niveau, top 3, nouvelles vidéos, level-up), `community.ts`, `comptes.ts` (salon de liens), `montage.ts` (serveur des monteurs), `recruitment.ts` |
| `src/web/server.ts` | Toutes les routes HTTP (section 6) |
| `src/web/sober.ts` | Rendu du site fans `sober` / `pop` (`soberPage`) et des maquettes (`demoPage`) |
| `src/web/legal.ts` | Pages de confidentialité et de conditions (exigées par TikTok et Meta) |
| `src/web/app/` | Le front : `fan-sober.html` (site fans `sober` / `pop` / `sticker`), `fan.html` (BeOne `playful`), `index.html` + `app.js` + `app.css` (Mars), `formation.html` (Neptune Academy), `login.html`, `fan/` (visuels des créateurs), `demo/` (visuels des prospects) |
| `roblox/NeptuneRewards.server.lua` | Script côté jeu Roblox (livraison BeOne) |
| `scripts/` | `register-commands.ts`, `seed.ts` |
| `DEPLOY.md` | Guide de mise en ligne pas à pas (Discord, YouTube, Apify, Railway) |
| `../discord-setup/` | Ancien script Python de setup Discord (historique) |

### Tables SQLite
`clients`, `clippers`, `accounts`, `videos`, `video_snapshots`, `account_snapshots`, `settings`, `reward_rules`,
`shop_items`, `shop_orders`, `fan_tokens`, `fan_notifications`, `fan_notified`, `fan_notify_state`, `strikes`,
`feedbacks`, `relances`, `requests`, `candidatures`, `tests`, `recruiters`, `departures`, `channel_messages`,
`voice_sessions`, `tiktok_tokens`, `instagram_tokens`.
- v15 : `tiktok_tokens`.
- v16 : `instagram_tokens`.
- v17 : ces deux tables recréées avec `ON DELETE CASCADE`, pour qu'on puisse supprimer un clippeur.
- v18 : `faq_misses` (questions du salon aide non reconnues par la FAQ automatique).

---

## 4. Fonctionnement détaillé

### Inscription d'un fan (serveur créateur)
Le parcours du serveur monté par `/setup` (`fanServer.ts`) :
1. **👋 bienvenue**, puis **📜 règles** et **🧭 déroulement**. Le fan accepte les règles et reçoit le rôle `✅ Règles acceptées`.
2. **🎓 tutos** : la formation **Neptune Academy** sur `/formation`. Ce sont des modules à cocher (6 vidéos YouTube par défaut, ou des .mp4).
   Quand tout est coché, il reçoit le rôle `🎓 Formation validée`.
3. **📝 inscription** : bouton « S'inscrire ». Il remplit un formulaire avec ses comptes TikTok / Insta / YouTube
   (3 obligatoires) et son compte de livraison (e-mail ou pseudo Roblox selon le créateur).
   Il reçoit le rôle `🎬 1er clip à poster`, puis `🎬 Clippeur` quand son 1er clip est détecté, ce qui débloque la communauté.
4. Communauté : 📣 annonces, 💬 général, 🎥 mes-clips, ❓ aide.
   Plus : classement du lundi (top 10, rôle `🏆 Top 3 de la semaine`), level-up (paliers = objets de la boutique),
   **grades du mois glissant** si `gradeWindowDays` dans la config (Loann : 30 j) : rôles 🌱 Débutant / ⚡ Confirmé (10 k) / 🔥 Pro (100 k) / 💎 Élite (1 M) selon les vues des 30 derniers jours, montent et redescendent tout seuls (`syncGradeRoles`, toutes les 15 min), montée annoncée dans #level-up,
   nouvelles vidéos (vidéos longues seulement, rôle `🔔 Alerte vidéos`).
5. Côté staff : log des inscriptions, 💬 staff, rôles `🛡️ Staff` et `👑 Head of Clipping 👑`
   (il voit tous les salons staff et privés), plus un salon privé par clippeur.

Autres détails :
- Les membres ne peuvent pas faire @everyone / @here.
- Le **#tag** (mot-clé du créateur, ex. #squiduu) est rappelé seulement aux moments clés : les règles et le salon privé.
- `/site` envoie au fan son lien de connexion au site. `/coins` affiche ses vues et ses coins.

### Anti-triche
Un clip rapporte des coins seulement si les 3 conditions sont réunies :
1. le compte est **vérifié** ;
2. le clip est **publié après l'ajout du compte** (les vieilles vidéos qui montent ne rapportent rien) ;
3. `clip_check = 'ok'` : la **légende cite le créateur** (mots-clés `clipKeywords`, son nom, ses chaînes ; règle activable dans Mars).
   Les clips d'avant cette règle sont acceptés.

Le reste :
- **Tri automatique des comptes** (`autoReviewAccounts`, après le 1er relevé) :
  - moins de 10 000 abonnés et aucune vidéo à 100 000 vues ou plus → validé automatiquement ;
  - sinon → file **« Comptes à vérifier »** dans Mars (lien du profil et derniers clips, Valider / Refuser).
- Un compte **connecté officiellement** (TikTok ou Instagram OAuth) est vérifié d'office : la connexion prouve qu'il appartient au fan.
- Un compte ne peut être suivi qu'une seule fois (doublons détectés par l'ID réel de la plateforme).
- Les **achats sont validés par le staff** avant livraison : Mars montre les clips qui ont rapporté les coins.
- Anti-force brute sur le mot de passe de Mars.
- Il a existé une vérification par code dans la bio, et une IA qui comparait les clips au créateur.
  Elles ont été remplacées par le mot-clé et les connexions officielles, qui sont gratuits.

### Relevés de vues (`jobs/collect.ts`, `index.ts`)
- **Fans** : chaque nuit juste après minuit, heure de Paris (`parisMidnight`).
  - Comptes **gratuits** (YouTube, TikTok ou Insta connectés) : chaque nuit.
  - Comptes **payants** (Apify) : toutes les 2 nuits ; 1 fois par semaine si aucune nouvelle vidéo depuis 14 jours ;
    toutes les 2 semaines si le compte est vide (`fanAccountDue`, `paidAccount`).
  - On lit 5 vidéos par compte fan et 10 par compte agence.
- **Agence** : comptes Apify relevés 1 fois par jour.
- **Relevé manuel** depuis Mars (« Relever les vues maintenant », 1 fois par heure max) : seulement les comptes gratuits et les comptes jamais relevés.
  Il inclut aussi les comptes connectés hors agence.
- **Calcul des vues** : le 1er relevé sert de référence. Le total du compte = la somme des dernières vues connues de toutes ses vidéos.
  Les vues gagnées = la différence sur des fenêtres glissantes.
- Les erreurs sont rendues lisibles (`readableError`) : quota Apify dépassé (« hard limit »), compte introuvable, connexion expirée.

### Connexions officielles (gratuites, remplacent Apify)

**TikTok** (`tiktokOfficial.ts`), via Login Kit et Display API :
- scopes `user.info.basic,user.info.profile,user.info.stats,video.list`, `disable_auto_auth=1` (la page d'autorisation s'affiche toujours) ;
- jetons renouvelés automatiquement ;
- routes `/fan/tiktok/connect` et `/fan/tiktok/callback`.
- **Vérification du site** par URL prefix : le fichier `tiktok<code>.txt` est servi à la racine.
  Il suffit de mettre le contenu `tiktok-developers-site-verification=…` dans `TIKTOK_VERIFY_FILE` ou `TIKTOK_VERIFY_CONTENT` : le nom du fichier s'en déduit.
  L'URL Web dans TikTok doit finir par `/`.

**Instagram** (`instagramOfficial.ts`), via API with Instagram Login :
- scopes `instagram_business_basic,instagram_business_manage_insights` ;
- jeton court échangé contre un jeton long de 60 jours, renouvelé automatiquement ;
- le compte doit être **pro ou créateur** : le site explique comment passer en créateur, gratuitement ;
- seuls les reels sont lus. Métrique : `views`, sinon `plays`.

Commun aux deux :
- Si les clés sont présentes, le fetcher officiel enveloppe Apify : compte connecté → API officielle, sinon → Apify,
  sauf si `*_APIFY_FALLBACK=0` (dans ce cas, erreur « pas connecté »).
- Après une connexion réussie, le fan est renvoyé sur `/fan?connected=<plateforme>#clipper` avec un toast.
- Le site affiche « ✅ connecté » et un lien « Reconnecter », ou le bouton « Connecter mon TikTok / Instagram ».

### Site fans
- Pages : Accueil (hero, comment ça marche, top de la semaine, FAQ), Récompenses, Clipper (comptes suivis, connexions officielles, mes clips),
  Classement, Profil (niveau, badges, compte de livraison, notifications Discord, échanges).
- Les coins s'affichent seulement sur les clips qui rapportent. Les autres portent la mention « ne rapporte pas ».
- Le gabarit lit la config du créateur (`/api/fan/public`) : couleurs, police, textes avec `**…**` mis en accent, FAQ, ticker.
  Les visuels sont dans `src/web/app/fan/` (`images.banner`, `images.reward`). La photo HD du créateur vient de YouTube.
- Couleur de mise en avant configurable via `colors.highlight` (violet par défaut).
  Les polices à graisse unique (Lilita One…) sont gérées dans `sober.ts`.

### Mars (dashboard staff, `index.html` + `app.js`)
- **Retirées du menu (demande d'Alex)** : Rémunération, Inspiration, Suivi. Alex trouve Mars surchargé : rework en cours, page par page.
- **Funnel** = parcours des fans (`pageOnboarding`, `/api/fans/onboarding`) : arrivés sur le serveur → lu la bienvenue → règles → formation → inscrits → 1er clip → gagnent des coins → ont échangé. Étapes Discord = photo du bot créateur (`snapshotOnboarding`, 1 fois / heure, exacte si « Server Members Intent » activé, sinon estimation). Plus grosse perte mise en évidence. L'ancien funnel de recrutement agence n'est plus dans le menu.
- Pages : Vue Agence (KPI, dont « Clippeurs actifs » ; « CA généré » a été retiré), clippeurs, classement, inspiration, management,
  rémunération, paramètres, suivi du recrutement, et le programme fans (boutique, commandes, comptes à vérifier, réglages, ± coins).
- **Classement** : colonne « Vues qui comptent », à côté des vues brutes.
  ⚠️ si plus de 1 000 vues et moins de 20 % qui comptent.
- **Fiche coaching** par clippeur, sur 30 jours (`domain/coaching.ts`) :
  - comparaison à l'équipe, flops, meilleure plateforme, plateforme absente ;
  - meilleur créneau, régularité, clips sans #tag, comptes en erreur ;
  - meilleur et pire clip.

  Ça sert de base aux feedbacks vocaux.
- **Un Mars par créateur** (un service Railway chacun). Le menu « Programme » bascule de l'un à l'autre sans se reconnecter, avec un lien signé.
  La variable `MARS_SITES` les liste.
- Pour supprimer quelqu'un : page clippeurs, puis supprimer.
- **« Déjà relié à quelqu'un d'autre »** : Mars → Fans → **🔎 Chercher un compte** (@ du compte ou pseudo Discord) → **Libérer**. Un compte libéré (inactif) est repris par le fan qui le relie ensuite (`registerAccount`), ses anciens clips ne comptent pas pour lui. « - » ou « . » ne sont plus acceptés comme comptes.
- **Compte Discord perdu** : Mars → Fans → bouton 🔁 « Transférer » (ID Discord du nouveau compte) : comptes, vues, coins et achats passent sur le nouveau compte (`transferClipper`). Ensuite redonner ses rôles à la main. Ses jetons TikTok / Insta sont supprimés aussi (CASCADE).

### Serveur des monteurs (`bot/montage.ts`, commande `/setup-montage`)
- Structure validée par l'équipe :
  - **📦 ressources** : communes, en lecture seule ;
  - puis **une section par créateur** : 📣 annonces, 👱 ressource, 💬 général ;
  - et le **salon privé**.
- Pas de salon de feedback ni « à publier » (« c'est le centre de pilotage qui gère »).
- Les head of / staff postent, les monteurs lisent.
- Option `nettoyer`, ou bouton 🧹 « Supprimer tous les autres salons » : supprime tout ce qui n'est pas dans la structure (les salons d'abord, puis les catégories).
- Les salons existants sont reconnus même s'ils ont été renommés, et sont alors renommés proprement.

### Maquettes prospects (pour chauffer le prospect en call)
- `src/creators/prospects.ts` (`PROSPECTS`) : une config créateur complète par prospect, plus ses visuels dans `src/web/app/demo/`.
- `/demo/<slug>` sert **le vrai site fans** à la charte du prospect (`demoPage` dans `sober.ts`) :
  données d'exemple (classement avec des pseudos inventés), connexion désactivée, badge « Maquette ».
- Versions autonomes envoyées à Alex : `maquette-<slug>.html` à la racine (images intégrées en base64).
  Ce sont celles qu'il ouvre et montre en call. Le script de génération est décrit en section 9.
- Prospects faits :
  - **cubi-game** : noir et blanc, Space Grotesk, PDP du cube, carte Roblox Academy ;
  - **croshoot** : pop + sticker, rouge #B51E32 / #C72B41, brun #201820, jaune #FFB800, Lilita One, bannière désert, peluche Bob ;
  - **josplay** : bleu #7BC7EA et blanc, Fredoka, Mii.
- Procédure pour un nouveau prospect (Nighting) :
  1. Alex envoie un prompt de DA et des captures.
  2. Donner un avis très court sur le prompt (ce qui manque : visuels HD, récompense, mot-clé).
  3. Découper les visuels dans ses captures avec PIL. Les captures sont dans le dossier d'images de la session.
  4. Ajouter l'entrée dans `PROSPECTS`.
  5. Générer le HTML autonome, faire une capture Playwright et vérifier.
  6. Commit, push, et envoyer le fichier.
- Le prompt de DA d'Alex demande souvent : aucun slogan, des zones de contenu vides, la mascotte non modifiée,
  et une énergie de jeu « sans copier » (Brawl Stars pour Croshoot).

---

## 5. Variables d'environnement (Railway → Variables, valeurs jamais dans le chat)

| Variable | Rôle |
| --- | --- |
| `CREATOR` | beone / squiduu / debo / loann : quel créateur ce service sert |
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` | Bot de l'agence (Mars, monteurs, recrutement) |
| `FANS_BOT_TOKEN`, `FANS_BOT_CLIENT_ID`, `FANS_BOT_GUILD_ID` | Bot du créateur (serveur des fans) |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | Connexion Discord au site fans |
| `PUBLIC_URL` | URL publique du service (pour les liens et les redirect URIs) |
| `DASHBOARD_PASSWORD` | Mot de passe de Mars |
| `MARS_SITES` | Liste des autres Mars, pour le menu Programme |
| `NEPTUNE_API_KEY` | API Neptune (liaisons et points) |
| `FETCHER_MODE` | `live` en prod (`mock` = faux relevés) |
| `YOUTUBE_API_KEY` | API YouTube (gratuite) |
| `APIFY_TOKEN` | Apify (payant), pour TikTok et Insta non connectés |
| `VIDEOS_PER_ACCOUNT` | Plafond de vidéos lues |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_APIFY_FALLBACK` | TikTok officiel (**retirées pour l'instant**) |
| `TIKTOK_VERIFY_FILE` / `TIKTOK_VERIFY_CONTENT` | Fichier de vérification du site TikTok |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_APIFY_FALLBACK` | Instagram officiel (**retirées pour l'instant**) |
| `GAME_API_URL`, `GAME_API_TOKEN`, `ROBLOX_API_KEY` | Jeu Roblox de BeOne (livraison) |
| `SQUIDUU_API_URL`, `SQUIDUU_API_TOKEN` | Livraison automatique Squiduuverse |
| `DATABASE_PATH` | Base SQLite (sur un volume Railway) |
| `WEB_PORT` | Port du serveur web |
| `COLLECT_INTERVAL_MINUTES`, `RELANCE_*`, `INACTIVITY_DAYS`, `DROP_*` | Fréquences et seuils de relance |

---

## 6. Routes HTTP principales (`src/web/server.ts`)

- **Public / fans** :
  - `/fan` (site), `/fan/assets/:name`, `/fan/login`, `/fan/auth/discord` + `/callback`, `/fan/logout` ;
  - `/fan/{tiktok,instagram}/{connect,callback}` ;
  - `/api/fan/public`, `/api/fan/me`, `/api/fan/account`, `/api/fan/orders`, `/api/fan/notify`, `/api/fan/roblox` ;
  - `/formation`, `/api/formation`.
- **Divers publics** : `/legal/privacy`, `/legal/terms`, `/demo/:slug`, `/demo/assets/:name`, `/healthz`, fichier de vérification TikTok.
- **Jeu et Neptune** : `/api/roblox/pending`, `/api/roblox/delivered`, `/api/neptune/*`.
- **Mars** (protégé par mot de passe) :
  - `/`, `/login`, `/sso`, `/api/mars/*` ;
  - `/api/overview`, `/api/leaderboard`, `/api/clippers/:id`, `/api/fans`, `/api/fans/refresh`, `/api/shop/*`, `/api/rewards/*` ;
  - `/api/recruitment/*`, `/api/suivi`, `/api/discord/*`, `/api/export.csv`, etc.

## 7. Commandes Discord

- **Bot agence** : `/stats`, `/classement`, `/client`, `/retirer-compte`, `/avis`, `/inscription` (agence), `/setup-montage [nettoyer]`.
- **Bot créateur** : `/setup` (monte ou met à jour le serveur), `/site`, `/coins`, `/inscription`, `/aide` (menu de questions fréquentes, réponses perso).
- Les commandes sont enregistrées sur chaque serveur, y compris quand le bot est invité après son démarrage.
  `/setup` affiche le service et la version qui répondent, pratique pour diagnostiquer.

## 8. Déploiement (Railway)

- Un **service par créateur**, tous depuis ce repo et cette branche :
  - `lune` : BeOne, l'agence et Mars, https://lune-production-dbd1.up.railway.app ;
  - `squiduu` (https://squiduu-production.up.railway.app), `loann` (https://loann-production.up.railway.app), `Cubi` (https://cubi-production.up.railway.app, ancien service Debo), plus `micka` (https://micka-production.up.railway.app, créé le 14 oct) et `lune-dev` (**ne pas toucher** : autre repo `alexponelle-cell/lune-dev`, sûrement le bot Neptune relié à lune).
- `MARS_SITES` (sur chaque service) = `BeOne=…lune…,SQUIDUU=…,Loann=…,Cubi=…` : le menu Programme de Mars. Le sélecteur « Client affiché » liste aussi les **agences locales** de la base (une vieille agence « Loann » vide sur lune a été supprimée le 10 oct).
- L'accueil de lune (`/`) affiche la **vitrine publique « Neptune Clipping »** (`src/web/neptune.ts`) aux visiteurs non connectés ; le staff connecté voit Mars, lien « Staff login ».
- Chaque service a sa variable `CREATOR` et ses propres secrets.
- Un push sur la branche déclenche le redéploiement. Sinon, bouton **Deploy** sur Railway.
- Pour lire les logs : Railway, service, Deployments, View logs. Demander une capture à Alex, puisque l'agent n'a pas accès à Railway.
- Plan Railway : **Hobby** depuis le 14 oct (5 $/mois consommation incluse, carte de la mère ; plafond compute 10 $, alerte 7 $). Le Trial bloquait la création de services.
- Le guide complet de la première mise en ligne est dans `tracker/DEPLOY.md`.

## 9. Outils de l'agent (environnement cloud)

- Le réseau sortant bloque souvent Apify, Railway, croshop.fr, HuggingFace et Whisper.
  Impossible donc de transcrire un vocal WhatsApp : demander à Alex de l'écrire.
- Captures de pages : Playwright, avec `NODE_PATH=$(npm root -g)` et `executablePath: '/opt/pw-browsers/chromium'`.
  Ne pas lancer `playwright install`.
- Les images envoyées par Alex arrivent dans le dossier `images/` de la session.
  On les découpe avec PIL (python3) pour en faire des visuels (mascotte, bannière, produit).
- Générer les maquettes autonomes : petit script `tsx` qui importe `demoPage` depuis `tracker/src/web/sober.ts`,
  lit `fan-sober.html`, remplace les visuels par des data URIs et écrit `maquette-<slug>.html`.
- Un « localhost » ne sert à rien : il tournerait dans le conteneur cloud, pas chez Alex.
  Il faut envoyer le fichier HTML (il s'ouvre comme un site) ou passer par l'URL Railway.

---

## 10. Problèmes déjà rencontrés (et leur solution)

- **« File staff ingérable »** : tri automatique des comptes. Seuls les gros comptes vont au staff.
- **Crédit Apify gratuit (5 $) épuisé** :
  - économies sur les relevés (nuit, toutes les 2 nuits, comptes vides espacés) ;
  - puis connexions officielles ;
  - en attendant : Apify Starter à 19 $, avec un plafond (Limits) de 19 $.
- **`/setup-montage nettoyer` « n'a rien supprimé »** : l'option n'était pas prise. Ajout du bouton 🧹.
- **Comptes de test « disparus »** : kzom4 était relié à un autre clippeur (Paul.clipping, hors agence).
  Le relevé manuel inclut maintenant les comptes connectés hors agence.
- **« Reconnecter » TikTok sans page d'autorisation** : ajout de `disable_auto_auth=1`.
- **Production TikTok vide** : le formulaire n'avait jamais été sauvegardé. Il a fallu le remplir à nouveau.
- **Vérification du site TikTok** : Alex avait mis le contenu dans la mauvaise variable. Le nom du fichier se déduit maintenant du contenu.
  Autre erreur : l'URL sans `/` final.
- **Pastilles des comptes invisibles** (blanc sur blanc, site BeOne) : couleur `var(--ink)`.
- **Badges « +coins » trompeurs** : affichés seulement si le clip compte.
- **Premières maquettes trop simples** (« pas au niveau de SQUIDUU / BeOne ») : refaites sur le vrai gabarit du site.
- **Erreur dans developers.tiktok** : provoquée par un point final dans un champ.
- **Short YouTube « ne rapporte pas » alors que #squiduu est dans la description** : le relevé YouTube ne gardait que le titre. Corrigé : titre + début de la description + tags (`withDescription`, `platforms/youtube.ts`). Repris au relevé suivant.
- **Compteur « clips sans #tag » toujours à 0** : la requête cherchait `clip_check = 'refused'` au lieu de `'no'`. Corrigé.
- **Plafond Apify atteint le 9 oct** (« Monthly usage hard limit exceeded » alors que le compteur affichait 16,46 / 19 $) : le **rattrapage Loann** (relire tous les clips depuis le 1er août, jusqu'à 500 par compte) avait vidé le budget. Corrigé : le rattrapage ne tourne plus que sur les comptes gratuits ; un compte bloqué par le quota est relu dès la nuit suivante (`fanAccountDue`) ; la FAQ ne dit « relevé en pause » que pour une vraie erreur de quota. Alex a créé un **nouveau compte Apify** (plafond 15 $) et changé `APIFY_TOKEN` (fait sur lune, à faire / vérifier sur squiduu, loann, Cubi). Je l'ai déconseillé (contraire aux règles d'Apify, risque de ban) ; ne pas aider à contourner leurs contrôles.
- **Jauge Apify** dans Mars → Fans (dépensé / plafond / remise à zéro, orange à 80 %) via `apifyUsage()` (`/v2/users/me/limits`).
- **Funnel Mars : % au-dessus de 100** : plafonné à 100, étape « Ont assez de coins » ajoutée avant l'échange.
- **Doublon Loann dans Mars** : agence locale vide sur lune → supprimée ; Paramètres affiche maintenant le nombre de clippeurs par agence ; `MARS_SITES` dédoublonné dans le code.
- **Membres qui créent des fils / événements** : `/setup` et `/setup-montage` retirent `CreateEvents`, `ManageEvents`, `Create*Threads`, `ManageThreads` et `MentionEveryone` à @everyone et aux rôles des membres (`MEMBER_FORBIDDEN`). Fait sur les 5 serveurs.

---

## 11. Les comptes développeurs (état)

- **TikTok for Developers** :
  - app créée (catégorie, URL du site, pages légales, site vérifié) ;
  - testée en Sandbox avec kzom4 : vidéos et vues remontent ;
  - 1re demande **refusée le 10 oct** : le nom de l'app doit être affiché sur le site et le Website URL ne doit pas être une page de connexion. Corrigé (vitrine Neptune Clipping) et **renvoyée le 10 oct** : Website `https://lune-production-dbd1.up.railway.app/`, Privacy `/legal/privacy`, Terms `/legal/terms`, même domaine ; vidéo de démo filmée sur lune `/fan` (sandbox, compte kzom4). Si nouveau refus à cause du domaine : acheter un domaine (ex. neptuneclipping.fr, quelques €/an) ;
  - quand c'est validé : clés Production sur les 4 services, Redirect URIs des 3 autres sites, puis `TIKTOK_APIFY_FALLBACK=0`.
- **Meta (Instagram)** :
  - app créée, testée avec alexponelle (reels et vues remontent), démo filmée ;
  - **bloqué par la vérification d'entreprise** ;
  - il manque aussi l'icône de l'app ;
  - ensuite : demande de validation, clés sur les 4 services, Redirect URIs, `INSTAGRAM_APIFY_FALLBACK=0`.
- Les clés TikTok et Instagram ont été **retirées de Railway** en attendant (les tests sont finis).

## 12. Administratif et argent

- Alex a **15 ans** : impossible d'avoir sa propre micro avant 16 ans. Solution retenue : **sa mère crée la micro à son nom**
  (entrepreneur individuel, statut micro-entrepreneur, gratuit). Elle est titulaire légale et sera titulaire du compte Meta. SAS à 3 associés plus tard (coûte ~200-300 € + comptable).
- **12 oct 2026** : dossier déposé sur le guichet unique (formalité de création d'entreprise individuelle), nom commercial **System Agency**, activité « agence de publicité et marketing digital » (commerciale), micro BIC, franchise de TVA, versement libératoire Non, salariée à côté. Signé et payé (7,63 €) le 14 oct, formalité J00290585918 : reste INSEE (SIREN) puis greffe.
- **10 oct 2026** : compte **INPI Connect** créé (pas FranceConnect+, qui exige la nouvelle carte d'identité / France Identité ; le passeport suffit en pièce jointe), démarche « Créer une entreprise » lancée, brouillon « Neptune Clipping », étape Identité / volet social. Pièces prêtes en PDF : pièce d'identité + facture de box internet < 3 mois. Activité à déclarer : agence de marketing digital / gestion de créateurs de contenu (clipping vidéo). Ensuite : SIRET (1 à 4 semaines) → vérification d'entreprise Meta → App Review Instagram.
- **15 oct 2026** : ce 1er dossier (micro **BIC**, activité commerciale) a été **rejeté par le greffe** (« activité non commerciale »).
- **18 oct 2026** : **nouveau dossier** sur le guichet unique INPI (formalité J00292416518) : entrepreneur individuel, nom commercial **System Agency**, activité **libérale** (« Activités spécialisées, scientifiques et techniques diverses » : conseil en communication / marketing digital pour créateurs de contenu), **micro-BNC**, franchise de TVA, versement libératoire **non**, envoyé à l'**URSSAF** (pas au greffe).
- ✅ **19 oct 2026 : entreprise VALIDÉE** (INSEE + URSSAF Bretagne), immatriculée au RNE, **SIREN obtenu**, code APE **70.21Z** (conseil en relations publiques et communication), siège à Paris. (Le SIREN et l'adresse sont sur les documents d'Alex : ne pas les recopier ici.)
- **Justificatifs** : l'**avis de situation INSEE** est **bloqué** (une EI a le droit d'opposition par défaut : seule la titulaire peut le télécharger via **FranceConnect** sur avis-situation-sirene.insee.fr). Alex a téléchargé à la place l'**attestation d'immatriculation RNE** en PDF sur **data.inpi.fr** (public, sans compte) : c'est le justificatif à donner à Meta.
- **Vérification d'entreprise Meta (en cours, 22 oct)** : doit être faite par **la mère, avec SON compte Facebook** (elle en a un). Alex (15 ans) ne peut pas : l'entreprise est à son nom à elle, et les outils business de Meta demandent d'être majeur. Étapes :
  1. business.facebook.com avec le Facebook de la mère → **créer un portefeuille business** « System Agency » (son nom, son e-mail) ← **prochaine étape** ;
  2. Paramètres → **Centre de sécurité** → **Vérification de l'entreprise** → nom légal / adresse / téléphone **exactement** comme sur l'attestation RNE, + le PDF ; site web = https://lune-production-dbd1.up.railway.app (peut-être y ajouter « System Agency » dans les pages légales si Meta le demande) ;
  3. la mère **ajoute Alex comme administrateur** du portefeuille ;
  4. relier l'**app Meta** (créée sur le compte d'Alex, celle de l'API Instagram) au portefeuille (developers.facebook.com → app → Paramètres → Général / Vérification) ;
  5. **App Review** Instagram (démo filmée prête, icône 1024 px prête) → clés `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` sur Railway (relais comme TikTok) → `INSTAGRAM_APIFY_FALLBACK=0`.
- **Admin à venir** : facturer les clients (mentions obligatoires micro-BNC, « TVA non applicable, art. 293 B du CGI », numérotation, outil gratuit) ; compte bancaire dédié au nom de la mère (obligatoire si CA > 10 000 € deux années de suite, conseillé avant) ; déclarations URSSAF du CA (mensuelles ou trimestrielles) ; répartition entre associés (la micro est à la mère seule : contrat écrit / plus tard **SAS** à 3).
- **Clients payants** : Noah Panchaud 500 €/mois (1er mois 250 € payé) ; Mickaël Wu : 1 000 € à 10 M de vues (en dessous : non défini). Les autres créateurs : gratuits / test.
- ⚠️ Ne jamais demander ni répéter les données perso de la mère (adresse, téléphone, n° de sécu…) ; si Alex en envoie, lui dire de les masquer.
- Lucas a une micro-entreprise, mais elle est peut-être inutilisable (« s'est fait bz »). Alex préfère créer la sienne.
- **Coûts actuels** :
  - Apify Starter : 19 $/mois, plafonné à 19 $ (+ nouveau compte plafonné à 15 $, voir section 10) ;
  - Railway : **Hobby** 5 $/mois (depuis le 14 oct) ;
  - YouTube API : gratuit.
- **Objectif** : 0 € de relevés grâce aux connexions officielles, puis couper Apify.

## 12 bis. Offre et vente (call avec Lilo, coach, 10 oct 2026)

- Détail complet et scripts : **`vente/kit-vente.md`** (message de prospection, Loom, trame du R1, checklist).
- Problème : prospects qui disent « trop cher » (300-500 €/mois), annonces sans réponse, R2 où le prospect ne vient plus. Diagnostic : manque de clarté, on parle de l'outil au lieu du résultat du créateur.
- Décisions proposées par Lilo :
  - **2 formules** : A = mise en place 1 000-1 500 € + maintien 200 €/mois ; B = 350 €/mois tout compris.
  - **Garantie** de résultat (ex. 200 k vues en 30 jours ou remboursement du mois), à valider par Alex et Lucas.
  - **Acompte remboursable dès le R1**, ne jamais commencer sans (leçon DEBO). Le R2 devient l'onboarding.
  - **Maquette prête avant le R1** (site à la charte du prospect, emplacements de récompenses vides acceptés).
  - Prospection : message humain axé résultat + **vidéo Loom**, témoignages BeOne (250 k vues en 6 j) et Loann avec le lien de leur site, captures de Mars.
  - Si le client part : le serveur Discord et ses clippeurs lui restent ; le tracker / Mars restent à nous.
- Lilo doit récupérer les tarifs des concurrents (Gabriel / Ismaël).

## 13. À faire (priorités)

1. **Meta** : micro validée le 19 oct ✅ → la mère crée le portefeuille business « System Agency » avec son Facebook → vérification d'entreprise (attestation RNE) → Alex admin → app reliée → App Review Instagram (détail en section 12). Puis facturation / banque / URSSAF.
2. **TikTok officiel** : validé et branché sur les 6 sites (relais par lune). Faire connecter leur TikTok à tous les clippeurs (annonce « Connecte ton TikTok » : un TikTok non connecté passe par Apify = 5 derniers clips toutes les 2 nuits, les vues des clips plus anciens ne bougent plus ; connecté = 200 derniers clips chaque nuit, gratuit, depuis le 1er nov ; avant : 40).
3. **Apify** : sur squiduu (et sûrement loann / Cubi) les relevés TikTok / Insta sont **en erreur** (22 oct, cas d'Antoine sur SQUIDUU) → mettre `APIFY_TOKEN=${{lune.APIFY_TOKEN}}` puis Deploy (Alex). Micka a son propre compte Apify (payé par Micka, token sur le service micka le 18 oct). Antoine : YouTube `@nexusantoinetv` introuvable → corriger dans Mars (✏️ Comptes).
4. **Loann** : API MS pour livrer les mois automatiquement (attendre le dev de Loann) ; afficher le classement du mois sur le site (`monthLeaderboard`, côté Claude Design).
5. **Micka** : finir le lancement (/setup, test, Apify de Micka, MARS_SITES, annonce).
6. **Rework de Mars** page par page (Rémunération, Inspiration, Suivi déjà retirés) : attendre ce qu'Alex veut retirer / fusionner.
7. **IA « clipper »** : ajouter les tutos / conférences / ateliers de Lucas aux réponses du bot (`domain/faq.ts`).
8. **Josplay** : maquette mise à jour le 21 oct (demande de xegini) : **cagnotte de 500 €/mois partagée selon les vues** (1 M sur 5 M = 100 €), JosplayMax en **bonus** (500 k vues = 1 mois), section **« Ta série 🔥 »** (flammes de série de xegini, `FLAMES` dans `fan-sober.html`, `ms.streak`, démo « Poster un clip ») ; xegini prépare le script du call. **Nighting** en pause.
9. **Nouveau business (22 oct, idée de xegini)** : vendre « le système » à d'autres. 10 déclinaisons possibles des mêmes briques (clipping, UGC marques, campagnes musique, ambassadeurs, rétention de formation, serveur Discord clé en main, fidélité streamer, concours, tracker d'agence, recrutement). Conseil donné : en choisir 2, les vendre à 3 clients chacune avant d'en faire plus.
10. **Prospect Adrien** : Head of Content (3-4 clients, dont **Elie Attia**, finance), entourage de Micka, section « Adrien » du serveur des monteurs. Tout son process est dans **Notion** (+ automatisations + Slack) : Idée → Scripting → À filmer → Filmé → En montage → Monté à valider → Validé → Planifié → Publié, tags TOFU / MOFU, tournages « T5 #n », vue monteurs « Contenu Short Form ». **Ses douleurs** (vocaux du 22 oct) : clips éparpillés, **validation** client en bazar (9 « monté à valider » pour 1 validé), **facturation** en bazar, **SAV** (répondre aux clients, relancer les monteurs, feedbacks : rôle de **Romain**, débordé). **Offre proposée** (on complète Notion, on ne le remplace pas) : page de validation client en 1 clic (statut Notion mis à jour), vues auto des reels publiés dans Notion + rapport du lundi, factures auto + dû aux monteurs, relances / SAV dans **Slack**. **Démo complète** (23 oct, refaite dans le style des « AI dashboards » qu Alex adore : clair, bento, animations, assistant « P360 AI » qui répond avec les chiffres ; menu déroulant client global ; pipeline complet idée → publication, page Planning (tournages, rendus, relances, publications), spot réservé = dépense en compta + planning, vidéo validée = paie du monteur, rapport mensuel client avec coût / 1 000 vues) : `maquette-p360.html` (logo P360, jaune #FCCA09 : Accueil, Vidéos, Espace client avec validation 1 clic, Perfs, SAV + feedback 1 clic, Compta (import CSV qui marche, factures, monteurs, URSSAF estimée), Spots podcast 30-50 €/h (exemples inventés), Connexions). Autres demandes : compta auto (Google Sheet aujourd hui ; pas de connexion bancaire maison : relevé CSV ou clé Qonto en lecture seule collée par lui dans l outil, jamais par WhatsApp ; il va ouvrir un **Qonto** pro). Veut voir sa **marge par client** et globale (il donnera accès à son Google Sheet ; ajouté à la démo, onglet Compta). Spots : il cherche aujourd hui sur **Peerspace** (tournage avec Bobby). Prix évoqué : 500 € de mise en place + 150 €/mois par client (ou 300 €/mois forfait). Alex est **invité** sur son Notion (le connecteur Notion MCP et l'export sont bloqués pour les invités : il a demandé à être membre). **Vraie appli commencée le 23 oct : dossier `hub/`** (app à part du tracker, son propre service Railway à créer, root `/hub`, volume `/data`, voir `hub/README.md`) : Hono + SQLite, connexion par mot de passe (`ADMIN_PASSWORD`), lien client `/c/<token>` (validation / modif), relances auto (client 48 h, monteur en retard), Slack (`SLACK_WEBHOOK_URL`), import CSV, compta, planning, paie monteur = vidéos validées × tarif ; interface = la démo premium branchée sur l'API (`hub/public/app.html`). **23 oct (suite)** : synchro Notion (clé collée par Adrien dans Connexions, toutes les 10 min, « Validé » / modif / date renvoyés), relances e-mail (`SMTP_URL`), lecteur vidéo client, annuler 15 min, « À planifier », page Clients & monteurs, spots = recherche Peerspace/Google + « j'ai réservé ». **24 oct : retour d'Adrien** (Loom) : il adore, mais a déjà son process vidéos / validation / SAV ; il veut **son espace perso : compta (priorité), planning relié à Google Agenda, spots**. Fait : `HUB_MODE=perso` (seulement Compta, Planning, Spots, Clients & monteurs, Connexions), **Qonto** (API officielle lecture seule, identifiant + clé collés par lui), **Google Agenda** (adresse secrète iCal). **Spots** : liste de 9 vrais studios podcast à Paris (prix relevés le 24 oct : 35 à 125 €/h, rien de fiable à 30-50 €/h avec caméras + opérateur), favoris d'Adrien (`my_spots`), « J'ai réservé » → planning + compta. **Spots (26 oct)** : 42 studios et lieux Paris + Île-de-France (92, 93, 78) dans `STUDIOS` (`hub/public/app.html`, prix d'appel relevés le 26 oct), filtres décor / budget / opérateur / Paris-banlieue, la recherche du haut reconnaît les styles dans la description (`SYN`) et classe par % de ressemblance, prix total, message « Demander dispo ». **Spots « boostés »** : photo de référence → Claude (claude-opus-5-5 + recherche web, `ANTHROPIC_API_KEY`, ≈ 10-25 cts / recherche, 30 / jour) trouve de vrais lieux qui ressemblent, % de ressemblance, message pour le studio, favoris. Pas encore testé avec une vraie clé. Ses clients : **Elie Attia, Sabrina Nabet** ; monteurs ~**10 €/vidéo** ; Paris. **Reste** : prix + acompte, mise en ligne (service Railway `HUB_MODE=perso`), rapport par e-mail.
11. **Conflit / associés** : xegini (associé, 51 % de son projet, Alex 49 %) se sent enfermé et dépendant du système d'Alex (20 oct). Piste conseillée si besoin : séparer « l'outil » (à Alex, fourni sous abonnement) de « l'agence / les clients » (à xegini), par écrit, validé par les parents.

## 14. Démarrer une nouvelle session Claude (2 sessions en parallèle)

- Toute session sur ce repo lit `CLAUDE.md` (qui importe ce fichier) : elle a tout le contexte. **Mettre ces deux fichiers à jour** après chaque étape importante.
- Répartition habituelle :
  - **« Moteur et bots »** : `src/bot/`, `src/jobs/`, `src/services/`, `src/platforms/`, `src/db/`, Mars (`src/web/app/app.js`, `server.ts`), administratif / comptes développeurs.
  - **« Design et prospects »** : `src/web/app/fan-sober.html`, `fan.html`, `src/web/sober.ts`, `src/creators/*.ts` (textes, couleurs), maquettes prospects, sites Loann / Cubi.
  - **« Administratif »** (depuis le 22 oct) : Meta / vérif d'entreprise, factures, URSSAF, banque, contrats entre associés. Ne touche pas au code (sauf pages légales `src/web/legal.ts` si Meta l'exige). État détaillé : section 12. Mêmes règles : réponses très courtes, une étape à la fois, jamais les données perso de la mère, tout passe par elle (Alex est mineur). Elle met à jour la section 12 à chaque étape.
- Les deux poussent sur la même branche : `git pull --no-rebase` avant de commencer et avant chaque push, éviter de toucher les mêmes fichiers en même temps.
