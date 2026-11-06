import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type CategoryChannel,
  type Client,
  ChannelType,
  GuildFeature,
  type StageChannel,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  GuildSystemChannelFlags,
  type Interaction,
  MessageFlags,
  MessageType,
  type OverwriteResolvable,
  type Role,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import { log } from '../log.js';
import type { FanService } from '../services/fans.js';
import { faqMenuRow } from './fans.js';

const HELP_CHANNEL = '❓│aide';
const HELP_TITLE = '❓ Questions fréquentes';

/**
 * Serveur Discord d'un programme fans, monté par le bot du créateur avec /setup (admins).
 * Tout vient de la config du créateur (nom, couleur, étapes). Relancer /setup ne crée jamais de doublons.
 */
/** Retiré à @everyone et aux rôles des membres : ping @everyone, événements, fils. */
export const MEMBER_FORBIDDEN = [
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.CreateEvents,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
];

export const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Construit ou répare le serveur des clippeurs (salons, rôles, messages)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .toJSON();

/** Rôle du créateur : « 👑 SQUIDUU » (ancien nom « 👑 Créateur », renommé automatiquement). */
export const creatorRoleName = (creatorName: string) => `👑 ${creatorName}`;
const LEGACY_CREATOR_ROLE = '👑 Créateur';
export const ROLE_STAFF = '🛡️ Staff';
/** Au-dessus du staff : mêmes accès + modération. */
export const ROLE_HEAD = '👑 Head of Clipping 👑';
export const ROLE_CLIPPER = '🎬 Clippeur';
export const ROLE_TOP = '🏆 Top 3 de la semaine';
export const ROLE_ALERTS = '🔔 Alerte vidéos';
export const LOG_CHANNEL = '🧾│inscriptions-log';
export const VIDEOS_CHANNEL = '📰│nouvelles-vidéos';
export const RANKING_CHANNEL = '🏆│classement';
export const LEVELUP_CHANNEL = '🎉│level-up';
export const BEST_CLIPS_CHANNEL = '🔥│meilleurs-clips';
export const ANNOUNCE_CHANNEL = '📣│annonces';
export const ROLE_CLIP_WEEK = '🎬 Clip de la semaine';
export const ROLE_WEEKEND = '🔥 Défi du week-end';
/** Bouton « 🔔 Alerte vidéos » (ajoute / retire le rôle). */
export const ALERTS_BUTTON = 'fans:alerts';
/** SOP de l’agence (tutos clips), mises en avant dans 🎓│tutos */
/** Nom du rôle d'un niveau (ex. « 🔥 Pro »). */
export const levelRoleName = (l: { emoji: string; name: string }) => `${l.emoji} ${l.name}`;
/** Rôles de palier : un par objet de la boutique (ex. « 🎁 1 mois de Squiduuverse »). */
export const TIER_PREFIX = '🎁 ';
export const tierRoleName = (itemName: string) => `${TIER_PREFIX}${itemName}`.slice(0, 100);

/**
 * Crée les rôles de palier manquants, supprime ceux des objets retirés de la boutique
 * et les anciens rôles de niveau (Débutant, Confirmé…). Renvoie les rôles dans l'ordre des paliers.
 */
export async function ensureTierRoles(guild: Guild, fans: FanService): Promise<Role[]> {
  const tiers = fans.shopTiers();
  const wanted = tiers.map((t) => tierRoleName(t.name));
  // Comparaison souple (emoji, espaces, majuscules) : un rôle légèrement différent n'est jamais supprimé puis recréé
  const same = (a: string, b: string) => bare(a) === bare(b);
  for (const r of guild.roles.cache.values()) {
    // Anciens rôles de niveau supprimés, sauf si le créateur utilise les grades du mois (mêmes noms)
    const oldLevel = !fans.creator.gradeWindowDays && fans.creator.levels.some((l) => sameName(r.name, levelRoleName(l)));
    const oldTier = r.name.startsWith(TIER_PREFIX) && !wanted.some((w) => same(w, r.name));
    if ((oldLevel || oldTier) && r.editable) await r.delete('Paliers = objets de la boutique').catch(() => {});
  }
  const roles: Role[] = [];
  // Du plus cher au moins cher : Discord place chaque nouveau rôle en bas, le plus gros palier reste au-dessus
  for (let i = wanted.length - 1; i >= 0; i--) {
    const name = wanted[i]!;
    const found = guild.roles.cache.find((r) => same(r.name, name));
    if (found) roles[i] = found;
    else {
      log.info(`rôle de palier créé sur ${guild.name} : ${name}`);
      roles[i] = await guild.roles.create({ name, colors: { primaryColor: color(fans) }, hoist: true, reason: 'Palier de la boutique' });
    }
  }
  return roles;
}

/**
 * Accès d'un salon. Parcours : @everyone → 📖 Lecteur (a lu la bienvenue) → ✅ Règles acceptées → 🎬 Clippeur (inscrit).
 * Les rôles s'additionnent : un clippeur garde l'accès aux étapes précédentes.
 */
type Access =
  | { who: 'everyone'; write: boolean }
  | { who: 'role'; role: string; write: boolean; /** Rôles qui voient aussi le salon (ex. clippeurs déjà inscrits) */ also?: string[] }
  | { who: 'staff' };
interface ChannelPlan {
  name: string;
  access: Access;
  topic?: string;
  /** Salon vocal (ex. conférences en direct) : en lecture seule, les membres écoutent sans parler. */
  voice?: true;
  /** Retrouve aussi un salon existant dont le nom commence pareil (ex. « conférence-rediffusions » déjà créé à la main). */
  prefix?: true;
  /** Anciens salons remplacés par celui-ci : supprimés au /setup (ex. #mes-clips → #feedbacks). */
  replaces?: string[];
}
export const ROLE_READER = '📖 Lecteur';
export const ROLE_RULES = '✅ Règles acceptées';
/** Inscrit mais 1er clip pas encore détecté : seul son salon privé est visible, la communauté est fermée. */
export const ROLE_PENDING = '🎬 1er clip à poster';
/** Toutes les vidéos de la formation cochées : débloque 📝│inscription. */
export const ROLE_TRAINED = '🎓 Formation validée';
export const TRAINING_BUTTON = 'fans:training';
/** « ✅ Vérifier mes comptes » : lit la bio de chaque compte et cherche le code du fan. */
export const VERIFY_BUTTON = 'fans:verify';
export const verifyRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(VERIFY_BUTTON).setStyle(ButtonStyle.Success).setLabel('Vérifier mes comptes').setEmoji('✅'));
export const verifyText = (code: string) =>
  `🔐 **Prouve que ces comptes sont à toi** : mets le code **${code}** dans la **bio** de chacun (TikTok, YouTube, Instagram), puis clique sur **✅ Vérifier mes comptes**. Tant que ce n’est pas fait, tes vues ne comptent pas. Tu pourras retirer le code ensuite.`;
export const STEP_READ_BUTTON = 'fans:step:read';
export const STEP_RULES_BUTTON = 'fans:step:rules';
export const PRIVATE_CATEGORY = '🔒 ESPACES PRIVÉS';
/** Anciennes catégories (premières versions de /setup), supprimées si elles sont vides. */
const LEGACY_CATEGORIES = ['🎬 CLIPPER'];

const readonly = (role?: string): Access => (role ? { who: 'role', role, write: false } : { who: 'everyone', write: false });
const writable = (role: string): Access => ({ who: 'role', role, write: true });

/** Plan du serveur : catégorie → salons (l'accès de la catégorie vaut pour ses salons). */
export const SERVER_PLAN: Array<{ category: string; access: Access; channels: ChannelPlan[] }> = [
  {
    category: '📌 BIENVENUE',
    access: readonly(),
    channels: [{ name: '👋│bienvenue', access: readonly(), topic: 'Lis le message puis clique sur « Continuer »' }],
  },
  {
    category: '📖 AVANT DE COMMENCER',
    access: readonly(ROLE_READER),
    channels: [
      { name: '📜│règles', access: readonly(ROLE_READER), topic: 'Lis et accepte les règles pour continuer' },
      { name: '🧭│déroulement', access: readonly(ROLE_READER), topic: 'Comment on gagne des coins, étape par étape' },
    ],
  },
  {
    category: '🎓 FORMATION',
    access: readonly(ROLE_RULES),
    channels: [
      { name: '🎓│tutos', access: readonly(ROLE_RULES), topic: 'Apprends à faire des clips qui marchent' },
      { name: '📝│inscription', access: { who: 'role', role: ROLE_TRAINED, write: false, also: [ROLE_CLIPPER, ROLE_PENDING] }, topic: 'Clique sur « S’inscrire » pour relier tes comptes' },
    ],
  },
  {
    category: '💬 COMMUNAUTÉ',
    access: writable(ROLE_CLIPPER),
    channels: [
      { name: '📣│annonces', access: readonly(ROLE_CLIPPER) },
      { name: '💬│général', access: writable(ROLE_CLIPPER) },
      { name: '🔄│feedbacks', access: writable(ROLE_CLIPPER), topic: 'Poste ton clip et reçois des retours du staff et de la commu', replaces: ['🎥│mes-clips'] },
      { name: HELP_CHANNEL, access: writable(ROLE_CLIPPER), topic: 'Une question ? Le bot répond tout de suite (/aide), sinon le staff' },
      { name: '📝│conférence-rediff', access: readonly(ROLE_CLIPPER), topic: 'Les rediffusions et les supports des conférences', prefix: true },
      { name: '💪│entraide', access: writable(ROLE_CLIPPER), topic: 'Aidez-vous entre clippeurs : montage, idées, retours' },
      { name: '🧠│conférence', access: readonly(ROLE_CLIPPER), voice: true },
    ],
  },
  {
    category: '📈 ACTIVITÉ',
    access: readonly(ROLE_CLIPPER),
    channels: [
      { name: VIDEOS_CHANNEL, access: readonly(ROLE_CLIPPER), topic: 'Chaque nouvelle vidéo, dès sa sortie : clippe-la en premier' },
      { name: RANKING_CHANNEL, access: readonly(ROLE_CLIPPER), topic: 'Le top 10 de la semaine, chaque lundi' },
      { name: BEST_CLIPS_CHANNEL, access: readonly(ROLE_CLIPPER), topic: 'Chaque jour, les 3 clips qui ont le plus percé : inspire-toi des formats qui marchent' },
      { name: LEVELUP_CHANNEL, access: readonly(ROLE_CLIPPER), topic: 'Les paliers de la boutique débloqués' },
    ],
  },
  {
    category: '🛡️ STAFF',
    access: { who: 'staff' },
    channels: [
      { name: LOG_CHANNEL, access: { who: 'staff' }, topic: 'Chaque inscription est notée ici' },
      { name: '💬│staff', access: { who: 'staff' } },
    ],
  },
];

const color = (fans: FanService) => parseInt(fans.creator.colors.accent.slice(1), 16);
const V = PermissionFlagsBits;

function overwrites(guild: Guild, access: Access, staffRoleId: string): OverwriteResolvable[] {
  const bot = { id: guild.members.me!.id, allow: [V.ViewChannel, V.SendMessages, V.EmbedLinks, V.ManageMessages, V.ManageChannels] };
  const head = guild.roles.cache.find((r) => sameName(r.name, ROLE_HEAD));
  const staff = [
    { id: staffRoleId, allow: [V.ViewChannel, V.SendMessages, V.MentionEveryone] },
    ...(head ? [{ id: head.id, allow: [V.ViewChannel, V.SendMessages, V.ManageMessages, V.MentionEveryone] }] : []),
  ];
  const everyone = guild.roles.everyone.id;
  // @everyone / @here : refusé à tous dans chaque salon (même si un rôle l'a), sauf staff et admins
  if (access.who === 'staff') return [{ id: everyone, deny: [V.ViewChannel, V.MentionEveryone] }, ...staff, bot];
  if (access.who === 'everyone') return [{ id: everyone, allow: [V.ViewChannel], deny: access.write ? [V.MentionEveryone] : [V.SendMessages, V.CreatePublicThreads, V.AddReactions, V.MentionEveryone] }, ...staff, bot];
  const role = guild.roles.cache.find((r) => sameName(r.name, access.role));
  return [
    { id: everyone, deny: [V.ViewChannel, V.MentionEveryone] },
    ...[role, ...(access.also ?? []).map((n) => guild.roles.cache.find((r) => sameName(r.name, n)))]
      .filter((r) => !!r)
      .map((r) => ({ id: r!.id, allow: access.write ? [V.ViewChannel, V.SendMessages] : [V.ViewChannel], deny: access.write ? [] : [V.SendMessages, V.CreatePublicThreads] })),
    ...staff,
    bot,
  ];
}

/** Noms de rôles comparés sans tenir compte des majuscules (un admin peut écrire « Squiduu » au lieu de « SQUIDUU »). */
const sameName = (a: string, b: string) => a.toLocaleLowerCase('fr') === b.toLocaleLowerCase('fr');

export const bare = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}-]/gu, '').toLowerCase();

export async function scaffoldFanServer(guild: Guild, fans: FanService, siteUrl: string) {
  const c = fans.creator;
  const created: string[] = [];
  const role = async (name: string, colour: number, hoist: boolean) => {
    const found = guild.roles.cache.find((r) => sameName(r.name, name));
    if (found) return found;
    created.push(`rôle ${name}`);
    return guild.roles.create({ name, colors: { primaryColor: colour }, hoist, reason: 'Serveur clippeurs' });
  };
  // Créés du plus haut au plus bas (Discord place chaque nouveau rôle en bas de la liste)
  const creatorName = creatorRoleName(c.creatorName);
  const legacy = guild.roles.cache.find((r) => sameName(r.name, LEGACY_CREATOR_ROLE));
  if (legacy && !guild.roles.cache.some((r) => sameName(r.name, creatorName))) await legacy.setName(creatorName).catch(() => {});
  await role(creatorName, color(fans), true);
  if (!guild.roles.cache.some((r) => sameName(r.name, ROLE_HEAD))) {
    await guild.roles.create({ name: ROLE_HEAD, colors: { primaryColor: 0x3ba7ff }, hoist: true, permissions: [V.ManageMessages, V.ModerateMembers, V.KickMembers, V.ManageNicknames], reason: 'Serveur clippeurs' });
    created.push(`rôle ${ROLE_HEAD}`);
  }
  const staff = await role(ROLE_STAFF, 0xf5f5f7, true);
  // Staff et Head of Clipping : administrateurs du serveur (rôles donnés à la main par les admins, jamais en libre-service)
  for (const r of [staff, guild.roles.cache.find((x) => sameName(x.name, ROLE_HEAD))]) {
    if (r && !r.permissions.has(V.Administrator)) await r.setPermissions([...r.permissions.toArray(), 'Administrator'], 'Staff = administrateur').catch((err) => log.warn(`${r.name} : droit administrateur impossible (${err instanceof Error ? err.message : String(err)})`));
  }
  await role(ROLE_TOP, 0xffd24a, true);
  await ensureTierRoles(guild, fans);
  await role(ROLE_CLIPPER, color(fans), false);
  await role(ROLE_PENDING, 0xb07cff, false);
  await role(ROLE_TRAINED, 0x9b9aa3, false);
  await role(ROLE_RULES, 0x9b9aa3, false);
  await role(ROLE_READER, 0x6b6a73, false);
  await role(ROLE_ALERTS, 0x5ab0e0, false);

  await guild.channels.fetch();
  const channels = new Map<string, TextChannel>();
  const cats: string[] = [];
  for (const group of SERVER_PLAN) {
    let cat = guild.channels.cache.find((ch): ch is CategoryChannel => ch.type === ChannelType.GuildCategory && ch.name === group.category);
    if (!cat) {
      cat = await guild.channels.create({ name: group.category, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(guild, group.access, staff.id) });
      created.push(`catégorie ${group.category}`);
    } else await cat.permissionOverwrites.set(overwrites(guild, group.access, staff.id)).catch(() => {});
    for (const plan of group.channels) {
      if (plan.voice) {
        // Vocal : les membres écoutent, seul le staff parle
        const perms = overwrites(guild, plan.access, staff.id).map((o) =>
          'deny' in o && o.id !== guild.roles.everyone.id && o.id !== staff.id && o.id !== guild.members.me!.id ? { ...o, allow: [V.ViewChannel, V.Connect], deny: [V.Speak, V.Stream] } : o,
        );
        // Vraie conférence (salon « Scène ») si le serveur est en mode Communauté, sinon vocal classique
        const stage = guild.features.includes(GuildFeature.Community);
        const type = stage ? ChannelType.GuildStageVoice : ChannelType.GuildVoice;
        const stagePerms = perms.map((o) => ('allow' in o && Array.isArray(o.allow) && o.allow.includes(V.Connect) && 'deny' in o ? { ...o, allow: [V.ViewChannel, V.Connect, V.RequestToSpeak] } : o));
        const same = (x: { name: string }) => x.name === plan.name || bare(x.name) === bare(plan.name);
        let vc = guild.channels.cache.find((x) => x.type === type && same(x)) as VoiceChannel | StageChannel | undefined;
        if (!vc) {
          vc = (await guild.channels.create({ name: plan.name, type, parent: cat.id, permissionOverwrites: stage ? stagePerms : perms })) as VoiceChannel | StageChannel;
          created.push(`${stage ? '🎙️' : '🔊'}${plan.name}`);
          // Ancien vocal remplacé par la scène
          if (stage) for (const old of guild.channels.cache.filter((x) => x.type === ChannelType.GuildVoice && same(x)).values()) await old.delete('Remplacé par une scène de conférence').catch(() => {});
        } else {
          if (vc.parentId !== cat.id) await vc.setParent(cat.id, { lockPermissions: false }).catch(() => {});
          await vc.permissionOverwrites.set(stage ? stagePerms : perms).catch(() => {});
        }
        if (!stage) created.push(`ℹ️ ${plan.name} : active « Communauté » (Paramètres du serveur) puis refais /setup pour une vraie scène de conférence`);
        await vc.setPosition(group.channels.indexOf(plan)).catch(() => {});
        continue;
      }
      // Retrouvé même si l'emoji du nom a changé (ex. « bienvenue »)
      let ch = guild.channels.cache.find((x) => x.type === ChannelType.GuildText && (x.name === plan.name || bare(x.name) === bare(plan.name) || (!!plan.prefix && bare(x.name).startsWith(bare(plan.name))))) as TextChannel | undefined;
      if (!ch) {
        ch = await guild.channels.create({ name: plan.name, type: ChannelType.GuildText, parent: cat.id, topic: plan.topic, permissionOverwrites: overwrites(guild, plan.access, staff.id) });
        created.push(`#${plan.name}`);
      }
      // Salon retrouvé sous un autre nom (ex. #général créé par Discord) : renommé comme le plan
      if (ch.name !== plan.name && !plan.prefix) await ch.setName(plan.name).catch(() => {});
      // Salon existant ailleurs (ex. #général par défaut) : rangé dans sa catégorie, accès mis à jour
      if (ch.parentId !== cat.id) await ch.setParent(cat.id, { lockPermissions: false }).catch(() => {});
      await ch.permissionOverwrites.set(overwrites(guild, plan.access, staff.id)).catch(() => {});
      // Ordre du plan dans la catégorie (ex. #tutos avant #inscription)
      await ch.setPosition(group.channels.indexOf(plan)).catch(() => {});
      channels.set(bare(plan.name), ch);
      // Anciens salons remplacés (ex. #mes-clips → #feedbacks) : supprimés
      for (const old of plan.replaces ?? []) {
        for (const x of guild.channels.cache.filter((c) => c.type === ChannelType.GuildText && c.id !== ch!.id && bare(c.name) === bare(old)).values()) {
          await x.delete(`Remplacé par ${plan.name}`).catch(() => {});
          created.push(`🗑️ #${old} supprimé`);
        }
      }
    }
    cats.push(cat.id);
  }
  // Catégorie des salons privés (un par clippeur inscrit)
  if (!guild.channels.cache.some((ch) => ch.type === ChannelType.GuildCategory && ch.name.startsWith(PRIVATE_CATEGORY))) {
    const priv = await guild.channels.create({ name: PRIVATE_CATEGORY, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(guild, { who: 'staff' }, staff.id) });
    created.push(`catégorie ${PRIVATE_CATEGORY}`);
    cats.push(priv.id);
  }
  // Salons privés déjà créés : le Head of Clipping y a accès aussi
  const headRole = guild.roles.cache.find((r) => sameName(r.name, ROLE_HEAD));
  if (headRole) {
    for (const ch of guild.channels.cache.values()) {
      if (ch.type !== ChannelType.GuildText || !(ch as TextChannel).topic?.match(/\[\d+\]/) || ch.permissionOverwrites.cache.has(headRole.id)) continue;
      await ch.permissionOverwrites.edit(headRole.id, { ViewChannel: true, SendMessages: true, ManageMessages: true }).catch(() => {});
    }
  }
  // Les membres ne peuvent ni mentionner @everyone / @here, ni créer d'événements, ni créer de fils (seuls staff et admins)
  for (const r of [guild.roles.everyone, ...guild.roles.cache.filter((x) => [ROLE_CLIPPER, ROLE_PENDING, ROLE_TRAINED, ROLE_RULES, ROLE_READER, ROLE_ALERTS, ROLE_TOP].some((n) => sameName(x.name, n)) || x.name.startsWith(TIER_PREFIX)).values()]) {
    if (r.permissions.any(MEMBER_FORBIDDEN)) await r.setPermissions(r.permissions.remove(MEMBER_FORBIDDEN), 'Membres : pas de @everyone, d’événements ni de fils').catch(() => {});
  }
  // Messages d'arrivée de Discord (« X a bondi dans le serveur ») : envoyés dans le log staff, plus dans #général
  const logCh = channels.get(bare(LOG_CHANNEL));
  if (logCh && guild.systemChannelId !== logCh.id) {
    await guild
      .edit({ systemChannel: logCh.id, systemChannelFlags: [GuildSystemChannelFlags.SuppressJoinNotificationReplies, GuildSystemChannelFlags.SuppressGuildReminderNotifications] })
      .catch((err) => log.warn(`/setup : salon des messages système (${err instanceof Error ? err.message : String(err)})`));
  }
  // Et les anciens messages d'arrivée déjà postés dans #général sont effacés
  const general = channels.get(bare('💬│général'));
  const joins = await general?.messages.fetch({ limit: 100 }).catch(() => null);
  const oldJoins = joins?.filter((m) => m.type === MessageType.UserJoin);
  if (general && oldJoins?.size) await general.bulkDelete(oldJoins, true).catch(() => {});
  // Anciennes catégories devenues vides
  for (const name of LEGACY_CATEGORIES) {
    const old = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name === name);
    if (old && !guild.channels.cache.some((ch) => 'parentId' in ch && ch.parentId === old.id)) await old.delete('Remplacée par le nouveau parcours').catch(() => {});
  }
  // Catégories dans l'ordre du plan, sous les éventuelles catégories par défaut de Discord
  await guild.channels
    .setPositions(cats.map((id, i) => ({ channel: id, position: 100 + i })))
    .catch((err) => log.warn(`/setup : ordre des catégories (${err instanceof Error ? err.message : String(err)})`));

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('fans:signup').setStyle(ButtonStyle.Primary).setLabel('S’inscrire').setEmoji('📝'),
    new ButtonBuilder().setCustomId('fans:signup2').setStyle(ButtonStyle.Secondary).setLabel('2e compte').setEmoji('➕'),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ouvrir le site').setURL(siteUrl),
  );
  const row = (id: string, label: string, emoji: string) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(id).setStyle(ButtonStyle.Success).setLabel(label).setEmoji(emoji));
  const rate = fans.settings().pointsPer1000;
  const creatorRole = guild.roles.cache.find((r) => sameName(r.name, creatorName));
  const fill = (t: string) => t.replaceAll('{creator}', creatorRole ? `${creatorRole}` : `**${c.creatorName}**`).replaceAll('{rate}', String(rate));
  const tag = `#${fans.clipKeywords()[0] ?? 'createur'}`;
  /** Rappel obligatoire du tag dans les règles personnalisées (l'autre rappel est dans le salon privé). */
  const tagRule = !fans.settings().clipRule ? '' : `\n\n🏷️ **OBLIGATOIRE : mets ${tag} dans la légende de CHAQUE clip.** Sans ${tag}, le clip ne rapporte **aucun coin**.`;
  const steps = c.texts.steps.map((s, i) => `**${String(i + 1).padStart(2, '0')} · ${s.title}**\n${s.text}`).join('\n\n');
  const posts: Array<[string, () => { embeds: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] }]> = [
    [
      'bienvenue',
      () => ({
        embeds: [
          new EmbedBuilder()
            .setColor(color(fans))
            .setTitle(`Bienvenue sur le serveur clipping de ${c.creatorName}`)
            .setDescription(
              c.discord
                ? fill(c.discord.welcome)
                : `${c.texts.heroText.replace(/\*\*/g, '')}\n\n${steps}\n\n🪙 **${rate} coins pour 1 000 vues**, tous comptes confondus. Les vues sont comptées chaque nuit.`,
            )
            .setThumbnail(`${siteUrl.replace(/\/fan$/, '')}/fan/assets/creator.png`),
        ],
        components: [row(STEP_READ_BUTTON, 'Continuer', '➡️')],
      }),
    ],
    [
      'règles',
      () => ({
        embeds: [
          new EmbedBuilder()
            .setColor(color(fans))
            .setTitle('📜・Règlement du serveur')
            .setDescription(
              c.discord ? fill(c.discord.rules) + tagRule : [
                `1. Tes clips doivent venir des contenus de ${c.creatorName}.`,
                '2. Un compte TikTok, YouTube ou Instagram ne peut être relié qu’à une seule personne.',
                ...(fans.settings().clipRule ? [`3. **Chaque clip doit citer ${c.creatorName} dans sa légende** (ex. ${tag}) : sinon il ne rapporte rien.`] : []),
                '4. Pas de faux comptes, pas de vidéos d’un autre créateur, pas de vues achetées : les coins gagnés ainsi sont retirés.',
                '5. Respect de tout le monde, dans les salons comme en message privé.',
                '6. Le staff peut retirer un compte ou des coins en cas d’abus.',
              ].join('\n'),
            ),
        ],
        components: [row(STEP_RULES_BUTTON, 'J’accepte les règles', '✅')],
      }),
    ],
    [
      'déroulement',
      () => ({
        embeds: [
          new EmbedBuilder()
            .setColor(color(fans))
            .setTitle('🧭・Comment ça se déroule')
            .setDescription(
              [
                steps,
                '',
                `🪙 **${rate} coins pour 1 000 vues**, tous comptes confondus (YouTube + TikTok + Instagram). Les vues sont comptées chaque nuit, à partir de ton inscription.`,
                c.reward ? `🎁 **${c.reward.name}** : ${c.reward.price.toLocaleString('fr-FR')} coins.` : '🎁 Les récompenses sont dans la boutique du site.',
                '',
                '**Ton parcours ici**',
                '1️⃣ Accepte les règles (bouton dans 📜│règles)',
                '2️⃣ Fais **la formation** : bouton 📚 Ma formation dans 🎓│tutos, regarde et coche chaque vidéo',
                '3️⃣ Inscris-toi dans 📝│inscription avec **tes 3 comptes** (TikTok, YouTube, Instagram)',
                '4️⃣ Poste **ton 1er clip** : dès qu’il est détecté, tu débloques les annonces et toute la communauté 🎉',
              ].join('\n'),
            ),
        ],
      }),
    ],
    [
      'tutos',
      () => ({
        embeds: [
          new EmbedBuilder()
            .setColor(color(fans))
            .setTitle('🎓・Tutos')
            .setDescription(
              `Toutes les méthodes pour faire des clips de ${c.creatorName} qui font des vues sont dans la formation **Neptune Academy** (6 vidéos courtes) : créer ton compte, CapCut, faire un clip, exporter.\n\n👉 **Clique sur 📚 Ma formation** : ta page perso s'ouvre. Regarde chaque vidéo et coche-la. Quand tout est coché, 📝│inscription se débloque.`,
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(TRAINING_BUTTON).setStyle(ButtonStyle.Success).setLabel('Ma formation').setEmoji('📚'),
          ),
        ],
      }),
    ],
    [
      'inscription',
      () => ({
        embeds: [
          new EmbedBuilder()
            .setColor(color(fans))
            .setTitle('Inscris-toi')
            .setDescription(
              `Clique sur **S’inscrire** : le bot t’envoie ton lien perso vers le site. Là, tu relies **tes 3 comptes** (TikTok en 1 clic, YouTube et Instagram) et ton ${c.rewardAccount.label.replace(/^(ton|ta|tes)\s+/i, '').replace(/^./, (x) => x.toLowerCase())}.\n\nEnsuite, **poste ton 1er clip** de ${c.creatorName} : dès qu’il est détecté, toute la communauté se débloque.\n\nTu peux recliquer à tout moment pour modifier tes comptes. ${fans.countFromLabel() ? `Tous tes clips postés depuis le ${fans.countFromLabel()} comptent.` : 'Seules les vues faites après ton inscription comptent.'}\n➕ Tu as **un 2e compte** TikTok, YouTube ou Instagram ? Clique sur **2e compte** (ou fais \`/inscription2\`) : ses vues s’ajoutent à ton profil.`,
            ),
        ],
        components: [buttons],
      }),
    ],
  ];
  posts.push([
    bare(VIDEOS_CHANNEL),
    () => ({
      embeds: [
        new EmbedBuilder()
          .setColor(color(fans))
          .setTitle('Nouvelles vidéos')
          .setDescription(`Chaque nouvelle vidéo de ${c.creatorName} est postée ici dès sa sortie. Les premiers clips sont ceux qui font le plus de vues.\n\nClique sur **🔔 Alerte vidéos** pour être mentionné à chaque sortie.`),
      ],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(ALERTS_BUTTON).setStyle(ButtonStyle.Secondary).setLabel('Alerte vidéos').setEmoji('🔔'))],
    }),
  ]);
  const me = guild.members.me!.id;
  for (const [key, build] of posts) {
    const ch = channels.get(key);
    if (!ch) continue;
    const recent = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    const mine = recent?.filter((m) => m.author.id === me).last(); // le plus ancien message du bot = le message épinglé du salon
    if (mine) {
      // Déjà posté : mis à jour avec les textes actuels de la config
      await mine.edit(build()).catch(() => {});
      continue;
    }
    await ch.send(build());
    created.push(`message #${key}`);
  }
  // ❓│aide : menu des questions fréquentes (retrouvé par son titre : le salon contient aussi les réponses du bot)
  const help = channels.get(bare(HELP_CHANNEL));
  if (help) {
    const msg = () => ({
      embeds: [new EmbedBuilder().setColor(color(fans)).setTitle(HELP_TITLE).setDescription('Choisis ta question dans le menu : le bot te répond tout de suite, avec **tes** chiffres (visible par toi seul).\n\nTu peux aussi écrire ta question ici, ou coller le lien d’un clip pour savoir s’il compte.')],
      components: [faqMenuRow()],
    });
    const recent = await help.messages.fetch({ limit: 50 }).catch(() => null);
    const pinned = recent?.find((m) => m.author.id === me && m.embeds[0]?.title === HELP_TITLE);
    if (pinned) await pinned.edit(msg()).catch(() => {});
    else {
      const sent = await help.send(msg());
      await sent.pin().catch(() => {});
      created.push(`message #${bare(HELP_CHANNEL)}`);
    }
  }
  return created;
}

/** Boutons du parcours : « Continuer » (→ 📖 Lecteur) et « J'accepte les règles » (→ ✅ Règles acceptées). */
export async function handleStepButtons(interaction: Interaction) {
  if (!interaction.isButton() || !interaction.inCachedGuild()) return;
  const step = interaction.customId === STEP_READ_BUTTON ? 'read' : interaction.customId === STEP_RULES_BUTTON ? 'rules' : null;
  if (!step) return;
  // Répondu tout de suite : sous l'afflux (des centaines d'arrivées), l'ajout de rôle est mis en file
  // par Discord et dépasse souvent les 3 s, d'où « L'application n'a pas répondu à temps ».
  if (!(await interaction.deferReply({ flags: MessageFlags.Ephemeral }).then(() => true, () => false))) return;
  try {
    const names = step === 'read' ? [ROLE_READER] : [ROLE_READER, ROLE_RULES];
    const roles = names.map((n) => interaction.guild.roles.cache.find((r) => sameName(r.name, n))).filter((r) => !!r);
    if (roles.length !== names.length) return void (await interaction.editReply({ content: 'Rôle introuvable : un admin doit refaire /setup.' }));
    const missing = roles.filter((r) => !interaction.member.roles.cache.has(r!.id));
    if (missing.length) await interaction.member.roles.add(missing.map((r) => r!.id), 'Parcours d’accueil');
    const ch = (name: string) => interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildText && bare(c.name) === bare(name));
    await interaction.editReply({
      content:
        step === 'read'
          ? `✅ C’est débloqué ! Lis ${ch('📜│règles') ?? '#règles'} et ${ch('🧭│déroulement') ?? '#déroulement'}, puis accepte les règles.`
          : `🎉 Règles acceptées ! Va dans ${ch('🎓│tutos') ?? '#tutos'} et clique sur **📚 Ma formation** : regarde et coche chaque vidéo, ça débloque l’inscription.`,
    });
  } catch (err) {
    log.warn(`parcours d’accueil : ${err instanceof Error ? err.message : String(err)}`);
    await interaction.editReply({ content: 'Impossible de te donner l’accès pour l’instant, réessaie dans une minute. Si ça continue, préviens le staff.' }).catch(() => {});
  }
}

/** 📚 Ma formation : lien perso vers /formation (connecté d'office). Formation déjà finie → rôle donné tout de suite. */
export async function handleTraining(interaction: Interaction, fans: FanService) {
  if (!interaction.isButton() || interaction.customId !== TRAINING_BUTTON || !interaction.inCachedGuild()) return;
  const ch = (name: string) => interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildText && bare(c.name) === bare(name));
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const fan = fans.ensureFan(interaction.user.id, interaction.member.displayName);
    if (fans.trainingDone(fan.id)) {
      await grantTrained(interaction.member);
      return void (await interaction.editReply(`🎉 **Formation validée !** ${ch('📝│inscription') ?? '#inscription'} est débloqué : clique sur **S’inscrire** et relie tes 3 comptes.`));
    }
    const url = fans.trainingUrl(fan.id);
    await interaction.editReply({
      content: `📚 **Ta formation** : regarde chaque vidéo et coche-la. Quand tout est coché, 📝│inscription se débloque tout seul.\n-# Lien perso valable 10 min, ne le partage pas.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Ouvrir ma formation').setEmoji('🎓'))],
    });
  } catch (err) {
    log.warn(`formation : ${err instanceof Error ? err.message : String(err)}`);
    await interaction.editReply('Impossible pour l’instant, réessaie dans une minute.').catch(() => {});
  }
}

async function grantTrained(member: GuildMember) {
  const role = member.guild.roles.cache.find((r) => sameName(r.name, ROLE_TRAINED));
  if (role && !member.roles.cache.has(role.id)) await member.roles.add(role, 'Formation validée');
}

/** Formation terminée sur le site : rôle 🎓 Formation validée sur les serveurs montés par /setup. */
export async function onTrainingCompleted(client: Client<true>, fans: FanService, discordId: string) {
  const ids = new Set(fans.botState<string[]>('setup-guilds', []));
  for (const guild of client.guilds.cache.values()) {
    if (!ids.has(guild.id)) continue;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member) await grantTrained(member).catch((err) => log.warn(`formation (${guild.name}) : ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Salon privé d'un clippeur (créé à l'inscription) : lui + le staff. Renvoie le salon existant s'il y en a déjà un. */
async function privateChannelFor(guild: Guild, member: GuildMember): Promise<TextChannel | null> {
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && (c as TextChannel).topic?.includes(`[${member.id}]`)) as TextChannel | undefined;
  if (existing) return existing;
  const staff = guild.roles.cache.find((r) => sameName(r.name, ROLE_STAFF));
  const head = guild.roles.cache.find((r) => sameName(r.name, ROLE_HEAD));
  // Discord : 50 salons maximum par catégorie → « 🔒 ESPACES PRIVÉS 2 », etc.
  const cats = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory && c.name.startsWith(PRIVATE_CATEGORY)).sort((a, b) => a.name.localeCompare(b.name));
  let cat = cats.find((c) => guild.channels.cache.filter((x) => 'parentId' in x && x.parentId === c.id).size < 50);
  if (!cat) {
    if (!staff) return null;
    cat = await guild.channels.create({ name: `${PRIVATE_CATEGORY} ${cats.size + 1}`, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(guild, { who: 'staff' }, staff.id) });
  }
  const slug = member.displayName.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'clippeur';
  return guild.channels.create({
    name: `🔒│${slug}`,
    type: ChannelType.GuildText,
    parent: cat.id,
    topic: `Espace privé de ${member.displayName} [${member.id}]`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [V.ViewChannel] },
      { id: member.id, allow: [V.ViewChannel, V.SendMessages, V.AttachFiles, V.ReadMessageHistory] },
      ...(staff ? [{ id: staff.id, allow: [V.ViewChannel, V.SendMessages] }] : []),
      ...(head ? [{ id: head.id, allow: [V.ViewChannel, V.SendMessages, V.ManageMessages] }] : []),
      { id: guild.members.me!.id, allow: [V.ViewChannel, V.SendMessages, V.EmbedLinks, V.ManageChannels] },
    ],
  });
}

/** Bouton « 🔔 Alerte vidéos » : ajoute ou retire le rôle. */
export async function handleAlertsButton(interaction: Interaction) {
  if (!interaction.isButton() || interaction.customId !== ALERTS_BUTTON || !interaction.inCachedGuild()) return;
  if (!(await interaction.deferReply({ flags: MessageFlags.Ephemeral }).then(() => true, () => false))) return;
  try {
    const role = interaction.guild.roles.cache.find((r) => sameName(r.name, ROLE_ALERTS));
    if (!role) return void (await interaction.editReply({ content: 'Rôle introuvable : un admin doit refaire /setup.' }));
    const has = interaction.member.roles.cache.has(role.id);
    if (has) await interaction.member.roles.remove(role);
    else await interaction.member.roles.add(role);
    await interaction.editReply({ content: has ? '🔕 Alertes vidéos désactivées.' : '🔔 Alertes activées : tu seras mentionné à chaque nouvelle vidéo.' });
  } catch (err) {
    log.warn(`alerte vidéos : ${err instanceof Error ? err.message : String(err)}`);
    await interaction.editReply({ content: 'Impossible de changer ton rôle pour l’instant, réessaie dans une minute.' }).catch(() => {});
  }
}

/** /setup : réservé aux admins du serveur. */
export async function handleSetup(interaction: Interaction, fans: FanService, siteUrl: string) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'setup' || !interaction.inCachedGuild()) return;
  try {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Réservé aux admins du serveur.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const created = await scaffoldFanServer(interaction.guild, fans, siteUrl);
    // Les automatisations (niveaux, classement, vidéos) ne tournent que sur les serveurs montés par /setup
    const set = new Set(fans.botState<string[]>('setup-guilds', []));
    set.add(interaction.guild.id);
    fans.setBotState('setup-guilds', [...set]);
    const who = `\n-# ${process.env.RAILWAY_SERVICE_NAME ?? 'local'} · ${(process.env.RAILWAY_GIT_COMMIT_SHA ?? 'dev').slice(0, 7)} · ${fans.creator.id}`;
    log.info(`/setup sur ${interaction.guild.name} : ${created.length} élément(s) créé(s)`);
    await interaction.editReply(
      (created.length
        ? `✅ Serveur prêt. Créé : ${created.join(', ')}.\nPense à mettre le rôle du bot tout en haut (Paramètres → Rôles) pour qu’il puisse donner le rôle Clippeur.`
        : '✅ Tout est déjà en place, rien à créer.') + who,
    );
  } catch (err) {
    log.error('/setup (serveur fans)', err);
    const msg = `Oups : ${err instanceof Error ? err.message : String(err)}. Le bot a-t-il la permission Administrateur ?`.slice(0, 300);
    await (interaction.deferred ? interaction.editReply(msg) : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => {});
  }
}

/** Après une inscription réussie : rôles, salon privé et trace dans le salon staff (si le serveur a été monté par /setup). */
export async function onFanRegistered(guild: Guild, member: GuildMember, accounts: string[], siteUrl?: string, extraLines: string[] = []) {
  try {
    // Accès à la communauté seulement après le 1er clip (rôle Clippeur donné par l'automatisation) ; déjà clippeur = inchangé
    const clipper = guild.roles.cache.find((r) => sameName(r.name, ROLE_CLIPPER));
    const already = !!clipper && member.roles.cache.has(clipper.id);
    const roles = [ROLE_READER, ROLE_RULES, ROLE_TRAINED, ...(already ? [] : [ROLE_PENDING])].map((n) => guild.roles.cache.find((r) => sameName(r.name, n))).filter((r) => r && !member.roles.cache.has(r.id));
    if (roles.length) await member.roles.add(roles.map((r) => r!.id), 'Inscription clippeur');
    if (guild.roles.cache.some((r) => sameName(r.name, ROLE_CLIPPER)) && guild.channels.cache.some((c) => c.type === ChannelType.GuildCategory && c.name.startsWith(PRIVATE_CATEGORY))) {
      const priv = await privateChannelFor(guild, member);
      // Clippeur parti puis revenu : son ancien salon existe mais il n'y a plus accès → accès rendu + message
      const back = !!priv && !priv.permissionOverwrites.cache.has(member.id);
      if (priv && back) await priv.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, AttachFiles: true, ReadMessageHistory: true });
      const fresh = priv && (back || !(await priv.messages.fetch({ limit: 1 }).catch(() => null))?.size);
      if (priv && fresh) {
        await priv.send({
          content: `${member}`,
          embeds: [
            new EmbedBuilder()
              .setTitle('🔒 Ton espace privé')
              .setDescription(
                [
                  'Bienvenue dans ton salon perso : seuls toi et le staff le voient.',
                  '',
                  `✅ Comptes suivis : ${accounts.join(', ')}`,
                  '📈 Tes vues sont comptées chaque nuit, à partir de maintenant.',
                  ...(extraLines.length ? ['', ...extraLines] : []),
                  ...(already ? [] : ['', `🎬 **Dernière étape : poste ton 1er clip** sur un de ces comptes. Dès qu’il est détecté (relevé chaque nuit), tu débloques les annonces, #général et toute la communauté.`]),
                  siteUrl ? `🪙 Suis tes coins et échange-les sur le site : ${siteUrl}` : '🪙 Tape `/coins` pour voir tes coins.',
                  '',
                  'Une question sur tes clips ou ton montage ? Écris ici, le staff te répond.',
                ].join('\n'),
              ),
          ],
          components: [],
        });
      }
    }
    const logCh = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL) as TextChannel | undefined;
    await logCh?.send({ content: `📝 ${member} s’est inscrit : ${accounts.join(', ')}`, allowedMentions: { parse: [] } });
  } catch (err) {
    log.warn(`inscription : rôle ou log impossible (${err instanceof Error ? err.message : String(err)})`);
  }
}
