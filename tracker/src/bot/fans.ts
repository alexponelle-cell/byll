import {
  ChannelType,
  type TextChannel,
  ActionRowBuilder,
  ActivityType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  Client as DiscordClient,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { log } from '../log.js';
import { FAQ_MENU, faqAnswer, type FaqIntent, looksLikeQuestion, matchFaq, PERSONAL_INTENTS } from '../domain/faq.js';
import { PRIVATE_CATEGORY, VIDEOS_CHANNEL, bare, onFanRegistered, setupCommand, handleSetup, handleAlertsButton, handleStepButtons, handleTraining, onTrainingCompleted, VERIFY_BUTTON, verifyRow } from './fanServer.js';
import { announceNewVideos, reportAccountsToReview, reportOrdersToApprove, reportSuspicious, snapshotOnboarding, syncGradeRoles, syncTierRoles, unlockFirstClips, weeklyRanking, monthlyPodium, relanceFans, motivationFans, cleanupQuests, weeklyRecap, overtakeAlerts, clipOfWeek, dailyBestClips, weekendChallenge, clipFeedbackMessages, trackingDigest, warnBrokenAccounts, connectReminders } from './fanAutomation.js';
import type { FanService } from '../services/fans.js';
import { status } from '../status.js';

/** Commandes du programme fans : sur le bot Neptune (serveur du créateur), ou sur le bot principal s'il n'y a pas de Neptune. */
export const fanCommandDefinitions = [
  new SlashCommandBuilder().setName('site').setDescription('Reçois ton lien de connexion à ton espace (vues, coins, boutique)').toJSON(),
  new SlashCommandBuilder().setName('coins').setDescription('Tes vues et tes coins').toJSON(),
  new SlashCommandBuilder().setName('aide').setDescription('Questions fréquentes : clique, le bot te répond (avec tes chiffres)').toJSON(),
];
/** /moments (staff) : les passages à clipper d'une vidéo, postés dans #nouvelles-vidéos. */
const momentsCommand = new SlashCommandBuilder()
  .setName('moments')
  .setDescription('Staff : poste les passages à clipper d’une vidéo dans #nouvelles-vidéos')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addStringOption((o) => o.setName('passages').setDescription('Séparés par « ; » ex. 4:12 la crise de rire ; 7:30 le clash').setRequired(true))
  .addStringOption((o) => o.setName('video').setDescription('Lien de la vidéo (facultatif)').setRequired(false))
  .toJSON();

/** Passages « 4:12 la crise de rire ; 7:30 le clash » → lignes « ⏱️ 4:12 · la crise de rire ». */
export function momentLines(raw: string): string[] {
  return raw
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 15)
    .map((x) => {
      const m = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–:]?\s*(.*)$/.exec(x);
      return m ? `⏱️ **${m[1]}**${m[2] ? ` · ${m[2]}` : ''}` : `⏱️ ${x}`;
    });
}

function attachMoments(discord: DiscordClient): void {
  discord.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'moments' || !interaction.inCachedGuild()) return;
    try {
      const lines = momentLines(interaction.options.getString('passages', true));
      const video = interaction.options.getString('video')?.trim();
      const ch = interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildText && bare(c.name) === bare(VIDEOS_CHANNEL)) as TextChannel | undefined;
      if (!ch) return void (await interaction.reply({ content: `Salon ${VIDEOS_CHANNEL} introuvable : refais /setup.`, flags: MessageFlags.Ephemeral }));
      await ch.send({ content: ['🎯 **Les moments à clipper**' + (video ? ` : ${video}` : ''), ...lines, '', 'Choisis-en un, monte-le à ta façon et poste-le 🔥 (évitez tous de prendre le même !)'].join('\n'), allowedMentions: { parse: [] } });
      await interaction.reply({ content: `✅ Posté dans ${ch}.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      log.error('/moments', err);
      if (!interaction.replied) await interaction.reply({ content: 'Oups, réessaie dans un instant.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
}

export const FAQ_SELECT = 'fans:faq';
/** Menu déroulant des questions fréquentes (/aide et message épinglé de ❓│aide). */
export const faqMenuRow = () =>
  new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(FAQ_SELECT)
      .setPlaceholder('❓ Choisis ta question…')
      .addOptions(FAQ_MENU.map((q) => ({ label: q.label, value: q.intent, emoji: q.emoji }))),
  );
export const FAN_COMMANDS = new Set(fanCommandDefinitions.map((c) => c.name));
/** /inscription n'existe que sur le bot des fans (le bot de l'agence a déjà son /inscription). */
const inscriptionCommand = (fans: FanService) =>
  new SlashCommandBuilder()
    .setName('inscription')
    .setDescription(`Relie tes comptes TikTok, YouTube, Instagram (et ton ${fans.creator.rewardAccount.kind === 'email' ? 'e-mail' : 'pseudo Roblox'})`)
    .toJSON();
const INSCRIPTION_MODAL = 'fans:inscription';
/** /inscription2 : un 2e compte par réseau (facultatif), compté pour le même profil. */
const inscription2Command = () =>
  new SlashCommandBuilder().setName('inscription2').setDescription('Ajoute un 2e compte TikTok, YouTube ou Instagram (compté sur ton profil)').toJSON();
const INSCRIPTION2_MODAL = 'fans:inscription2';
/** Bouton « S'inscrire » posté par /setup (ouvre le même formulaire que /inscription). */
export const SIGNUP_BUTTON = 'fans:signup';

const fmt = (n: number) => n.toLocaleString('fr-FR');
const PF: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };

const PLATFORM_FIELDS = [
  { id: 'tiktok', label: 'TikTok', placeholder: '@tonpseudo ou lien du profil' },
  { id: 'youtube', label: 'YouTube', placeholder: '@tachaine ou lien de la chaîne' },
  { id: 'instagram', label: 'Instagram', placeholder: '@tonpseudo ou lien du profil' },
] as const;

/**
 * /inscription seulement dans les tickets (Ticket Tool : « ticket-0001 », catégorie « Tickets »…).
 * Salon invisible pour le bot (ticket privé) : autorisé ; salon visible sans « ticket » dans le nom : refusé.
 */
export function isTicketChannel(channel: { name?: string | null; parent?: { name?: string | null } | null } | null | undefined): boolean {
  if (!channel || !channel.name) return true;
  return /ticket/i.test(channel.name) || /ticket/i.test(channel.parent?.name ?? '');
}

/** /inscription : formulaire avec un champ par réseau + compte de livraison (pseudo Roblox ou e-mail). */
export function attachInscription(discord: DiscordClient, fans: FanService): void {
  discord.on(Events.InteractionCreate, async (interaction) => {
    try {
      const signupButton = interaction.isButton() && interaction.customId === SIGNUP_BUTTON;
      if ((interaction.isChatInputCommand() && interaction.commandName === 'inscription') || signupButton) {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
        const ch = interaction.channel as { name?: string | null; parent?: { name?: string | null } | null } | null;
        // Serveur monté par /setup : salon #inscription ; serveur avec Ticket Tool : dans un ticket
        if (!signupButton && interaction.inGuild() && !isTicketChannel(ch) && !/inscription/i.test(ch?.name ?? '')) {
          await interaction.reply({
            content: '🎫 Ouvre d’abord un **ticket** (bouton **Create ticket**), puis fais **/inscription** dedans.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
        const fan = fans.ensureFan(interaction.user.id, name);
        // L'inscription se fait sur le site : connexion TikTok officielle (preuve que le compte est à lui), @ Insta / YouTube, compte de livraison
        const missing = fans.missingPlatforms(fan.id);
        await interaction.reply({
          content: missing.length
            ? `📝 **Inscris-toi sur le site** (tu es déjà connecté avec ce lien, il marche 10 min) : relie ton TikTok en 1 clic, mets ton Instagram et ton YouTube, et ton ${fans.creator.rewardAccount.label.replace(/^(ton|ta|tes)\s+/i, '').replace(/^./, (x) => x.toLowerCase())}.\nDès que tes 3 comptes sont reliés, tu reçois ton salon privé ici.`
            : '✅ Tu es déjà inscrit. Pour modifier tes comptes, ouvre le site :',
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(fans.signupUrl(fan.id)).setLabel(missing.length ? 'S’inscrire sur le site' : 'Ouvrir le site').setEmoji('📝'))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if ((interaction.isChatInputCommand() && interaction.commandName === 'inscription2') || (interaction.isButton() && interaction.customId === 'fans:signup2')) {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
        const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
        const fan = fans.ensureFan(interaction.user.id, name);
        const second = fans.accountsOf(fan.id).filter((a) => a.slot === 2);
        const modal = new ModalBuilder().setCustomId(INSCRIPTION2_MODAL).setTitle('2e compte (facultatif)');
        for (const f of PLATFORM_FIELDS) {
          const input = new TextInputBuilder().setCustomId(f.id).setLabel(`2e compte ${f.label}`).setPlaceholder(`${f.placeholder} (vide = aucun)`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200);
          const a = second.find((x) => x.platform === f.id);
          if (a) input.setValue(`@${a.handle}`);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        }
        await interaction.showModal(modal);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === INSCRIPTION2_MODAL) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
        const fan = fans.ensureFan(interaction.user.id, name);
        const get = (id: string) => interaction.fields.getTextInputValue(id) ?? '';
        const res = fans.setAccounts(fan, { tiktok: get('tiktok'), youtube: get('youtube'), instagram: get('instagram') }, 2);
        const lines: string[] = [];
        if (res.linked.length) lines.push(`✅ 2es comptes suivis : ${res.linked.map((a) => `**${PF[a.platform]}** @${a.handle}`).join(', ')}. Leurs vues s'ajoutent à ton profil.`);
        if (res.removed.length) lines.push(`🗑️ Retiré : ${res.removed.map((p) => PF[p]).join(', ')}`);
        if (res.conflicts.length) lines.push(`⛔ Déjà relié à quelqu'un d'autre : ${res.conflicts.map((a) => `@${a.handle}`).join(', ')}. Si c'est ton compte, préviens le staff.`);
        if (res.invalid.length) lines.push(`🤔 Pas compris : ${res.invalid.map((p) => PF[p]).join(', ')}. Mets ton @pseudo ou le lien de ton profil.`);
        if (fans.unverifiedAccounts(fan.id).length) lines.push('🔎 Tes nouveaux comptes vont être vérifiés (sous 24 h) : leurs vues compteront dès la validation.');
        await interaction.editReply(lines.join('\n') || 'Rien à changer 👍');
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === INSCRIPTION_MODAL) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
        const fan = fans.ensureFan(interaction.user.id, name);
        const get = (id: string) => interaction.fields.getTextInputValue(id) ?? '';
        const res = fans.setAccounts(fan, { tiktok: get('tiktok'), youtube: get('youtube'), instagram: get('instagram') });
        const lines: string[] = [];
        if (res.linked.length) lines.push(`✅ Comptes suivis : ${res.linked.map((a) => `**${PF[a.platform]}** @${a.handle}`).join(', ')}`);
        if (res.removed.length) lines.push(`🗑️ Retiré : ${res.removed.map((p) => PF[p]).join(', ')}`);
        if (res.conflicts.length) lines.push(`⛔ Déjà relié à quelqu'un d'autre : ${res.conflicts.map((a) => `@${a.handle}`).join(', ')}. Si c'est ton compte, préviens le staff.`);
        if (res.invalid.length) lines.push(`🤔 Pas compris : ${res.invalid.map((p) => PF[p]).join(', ')}. Mets ton @pseudo ou le lien de ton profil.`);
        const roblox = get('roblox').trim();
        if (fans.creator.rewardAccount.kind === 'email') {
          if (roblox && roblox.toLowerCase() !== (fans.fans.email(fan.id) ?? '')) {
            try {
              lines.push(`📧 E-mail enregistré : **${fans.linkEmail(fan, roblox)}**`);
            } catch (err) {
              lines.push(`📧 E-mail : ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (roblox && roblox.toLowerCase() !== (fans.fans.roblox(fan.id).username ?? '').toLowerCase()) {
          try {
            const r = await fans.linkRoblox(fan, roblox);
            lines.push(`🎮 Roblox relié : **${r.username}**`);
          } catch (err) {
            lines.push(`🎮 Roblox : ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Compte de livraison toujours rappelé (même inchangé), pour que le clippeur voie ce qui est enregistré
        if (!lines.some((l) => l.startsWith('📧') || l.startsWith('🎮'))) {
          const current = fans.rewardAccount(fan.id).value;
          if (current) lines.push(`${fans.creator.rewardAccount.kind === 'email' ? '📧 E-mail' : '🎮 Roblox'} : **${current}**`);
        }
        if (!lines.length) lines.push('Rien à changer 👍');
        // Les 3 réseaux sont obligatoires pour entrer (TikTok, YouTube, Instagram)
        const missing = PLATFORM_FIELDS.filter((f) => !fans.accountsOf(fan.id).some((a) => a.platform === f.id)).map((f) => f.label);
        if (missing.length) lines.push(`\n⚠️ **Il manque : ${missing.join(', ')}.** Les 3 comptes sont obligatoires : reclique sur **S’inscrire** pour compléter.`);
        if (res.linked.length && !missing.length && interaction.inCachedGuild()) {
          await onFanRegistered(interaction.guild, interaction.member, res.linked.map((a) => `${PF[a.platform]} @${a.handle}`), fans.publicSiteUrl(), [
            ...(fans.unverifiedAccounts(fan.id).length ? ['🔎 Tes comptes sont vérifiés sous 24 h : tes vues comptent dès la validation, rien n’est perdu.'] : []),
            ...(fans.settings().clipRule ? [`🏷️ **Mets #${fans.clipKeywords()[0] ?? 'createur'} dans la légende de chaque clip**, sinon il ne compte pas.`] : []),
            ...(fans.officialLogin ? [`📱 **Connecte ton ${fans.officialLogin.platforms.map((p) => PF[p]).join(' et ton ')} sur le site** (\`/site\` → onglet Clipper) : ça prouve que les comptes sont à toi et c’est ce qui compte tes vues.`] : []),
          ]);
        }
        const toConnect = fans.toConnect(fan.id);
        if (toConnect.length)
          lines.push(`\n📱 **Connecte ton ${toConnect.map((p) => PF[p]).join(' et ton ')}** (1 clic, on ne publie rien) : ça prouve que c’est à toi et c’est ce qui compte tes vues → ${fans.connectUrl(fan.id)}`);
        if (res.linked.length && !missing.length) lines.push('\n🎬 **Dernière étape : poste ton 1er clip.** Dès qu’il est détecté (1 relevé par jour), toute la communauté se débloque · `/site` pour la boutique');
        if (fans.unverifiedAccounts(fan.id).length) lines.push('\n🔎 **Tes nouveaux comptes vont être vérifiés** (sous 24 h) : tes vues compteront dès la validation, rien n’est perdu.');
        await interaction.editReply({ content: lines.join('\n').slice(0, 2000), components: [] });
      }
      if (interaction.isButton() && interaction.customId === VERIFY_BUTTON) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
        const fan = fans.ensureFan(interaction.user.id, name);
        if (!fans.unverifiedAccounts(fan.id).length) return void (await interaction.editReply('✅ Tous tes comptes sont vérifiés : tes vues comptent. Tu peux retirer le code de ta bio.'));
        let results;
        try {
          results = await fans.verifyAccounts(fan);
        } catch (err) {
          return void (await interaction.editReply(`⏳ ${err instanceof Error ? err.message : String(err)}`));
        }
        const left = results.filter((r) => !r.ok);
        await interaction.editReply({
          content: [
            ...results.map((r) => (r.ok ? `✅ **${PF[r.platform as keyof typeof PF]}** @${r.handle} : vérifié` : `❌ **${PF[r.platform as keyof typeof PF]}** @${r.handle} : ${r.error}`)),
            '',
            left.length
              ? `Mets **${fans.verifyCode(fan.id)}** dans la bio des comptes en ❌ (ça peut prendre 1 à 2 min à apparaître), puis reclique.`
              : '🎉 Tous tes comptes sont vérifiés : tes vues comptent. Tu peux retirer le code de ta bio.',
          ].join('\n'),
          components: left.length ? [verifyRow()] : [],
        });
      }
    } catch (err) {
      log.error('/inscription (fans)', err);
      const msg = { content: `Oups : ${String(err)}`.slice(0, 300), flags: MessageFlags.Ephemeral } as const;
      if (interaction.isRepliable()) await (interaction.deferred ? interaction.editReply(msg.content) : interaction.replied ? Promise.resolve() : interaction.reply(msg)).catch(() => {});
    }
  });
}

export function attachFanCommands(discord: DiscordClient, fans: FanService, siteUrl = ''): void {
  // Question choisie dans le menu de /aide ou du salon ❓│aide : réponse visible par le fan seulement
  discord.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== FAQ_SELECT) return;
    try {
      const intent = interaction.values[0] as FaqIntent;
      const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
      const diagnosis = PERSONAL_INTENTS.has(intent) ? fans.faqPersonal(intent, fans.ensureFan(interaction.user.id, name), '') : [];
      await interaction.reply({ content: faqAnswer(intent, fans.faqInfo(siteUrl || fans.publicSiteUrl()), diagnosis), flags: MessageFlags.Ephemeral });
    } catch (err) {
      log.error('menu aide', err);
      if (!interaction.replied) await interaction.reply({ content: 'Oups, réessaie dans un instant.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  discord.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !FAN_COMMANDS.has(interaction.commandName)) return;
    try {
      const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
      const fan = fans.ensureFan(interaction.user.id, name);
      if (interaction.commandName === 'aide') {
        await interaction.reply({
          content: '❓ **Choisis ta question**, je te réponds tout de suite (avec tes chiffres).\nPour un clip précis, colle son lien dans ❓│aide.',
          components: [faqMenuRow()],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.commandName === 'site') {
        const url = fans.loginUrl(fan.id);
        await interaction.reply({
          content: `🔐 **Ton lien de connexion perso** (valable 10 min, ne le partage pas) :\n${url}\n\nTu y suis tes clips, tes vues et tes coins, et tu les échanges dans la boutique.\n📱 Pas encore de compte relié ? Fais **/inscription**.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const b = fans.balance(fan.id);
        const s = fans.settings();
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(parseInt(fans.creator.colors.accent.slice(1), 16))
              .setTitle(`🪙 ${name}`)
              .addFields(
                { name: '🪙 Coins', value: `**${fmt(b.balance)}**`, inline: true },
                { name: '👀 Vues', value: fmt(b.views), inline: true },
                { name: '🛒 Dépensés', value: fmt(b.spent), inline: true },
              )
              .setFooter({ text: `${s.pointsPer1000} coins pour 1 000 vues · /site pour la boutique` }),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      log.error(`commande /${interaction.commandName} (fans)`, err);
      if (!interaction.replied) await interaction.reply({ content: `Oups : ${String(err)}`.slice(0, 300), flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
}

/** « 👤│comptes », « mes-comptes »… mais pas « tuto-comptes ». */
export function isAccountsChannel(name: string): boolean {
  const n = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z-]/g, '').replace(/^-+|-+$/g, '');
  return n === 'comptes' || n === 'mes-comptes' || n === 'mescomptes';
}

/** Salon #mes-comptes : le fan y colle ses liens TikTok / Insta / YouTube, ils sont reliés automatiquement. */
export function attachAccountsChannel(discord: DiscordClient, fans: FanService): void {
  discord.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) return;
    const channel = message.channel;
    if (!('name' in channel) || !isAccountsChannel(channel.name)) return;
    try {
      const fan = fans.ensureFan(message.author.id, message.member?.displayName ?? message.author.username);
      let result;
      try {
        result = fans.addAccounts(fan, message.content);
      } catch {
        const help = '🤔 Je ne trouve pas de lien de compte. Colle le lien de ton **profil**, par exemple `https://www.tiktok.com/@tonpseudo`';
        await message
          .reply({ content: help, allowedMentions: { repliedUser: false } })
          .catch(() => message.channel.send({ content: `<@${message.author.id}> ${help}`, allowedMentions: { users: [message.author.id] } }));
        return;
      }
      const lines: string[] = [];
      if (result.added.length) lines.push(`✅ C'est relié : ${result.added.map((a) => `**${PF[a.platform]}** @${a.handle}`).join(', ')}\nTes prochaines vues te rapportent des coins 🪙 (mise à jour toutes les 1 à 2 nuits)`);
      if (result.conflicts.length) lines.push(`⛔ Déjà relié à quelqu'un d'autre : ${result.conflicts.map((a) => `@${a.handle}`).join(', ')}. Si c'est ton compte, préviens le staff.`);
      await message.react(result.conflicts.length && !result.added.length ? '⛔' : '✅').catch(() => {});
      // Répondre au message demande « Lire l'historique » : sinon simple message qui mentionne le fan
      await message
        .reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } })
        .catch(() => message.channel.send({ content: `<@${message.author.id}> ${lines.join('\n')}`, allowedMentions: { users: [message.author.id] } }));
    } catch (err) {
      log.error('salon mes-comptes', err);
    }
  });
}

/** « ❓│aide », « aide », « help », « questions ». */
export function isHelpChannel(name: string): boolean {
  const n = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z-]/g, '').replace(/^-+|-+$/g, '');
  return n === 'aide' || n === 'help' || n === 'questions' || n === 'question';
}

/**
 * Salon ❓│aide et salons privés : le bot répond tout seul aux questions fréquentes (gratuit, par mots-clés),
 * avec le diagnostic du compte pour « pourquoi j'ai 0 coins ». Sinon il se tait et le staff répond.
 */
export function attachHelpChannel(discord: DiscordClient, fans: FanService, siteUrl: string): void {
  const lastAnswer = new Map<string, number>();
  discord.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) return;
    const channel = message.channel;
    if (!('name' in channel)) return;
    // Salon ❓│aide, ou salon privé du clippeur (catégorie 🔒 ESPACES PRIVÉS)
    const inPrivate = !!channel.parent?.name.startsWith(PRIVATE_CATEGORY);
    if (!isHelpChannel(channel.name) && !inPrivate) return;
    // Le staff discute librement ; une réponse auto par personne et par minute au plus
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    const intent = matchFaq(message.content);
    if (!intent) {
      // Question que la FAQ ne connaît pas : notée dans Mars pour ajouter la réponse
      if (looksLikeQuestion(message.content)) {
        try { fans.logFaqMiss(message.author.id, message.member?.displayName ?? message.author.username, message.content); } catch (err) { log.error('questions sans réponse', err); }
      }
      return;
    }
    const last = lastAnswer.get(message.author.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    lastAnswer.set(message.author.id, Date.now());
    try {
      const info = fans.faqInfo(siteUrl);
      const personal = ['coins', 'balance', 'missing', 'rank', 'clip'].includes(intent);
      const fan = personal ? fans.ensureFan(message.author.id, message.member?.displayName ?? message.author.username) : null;
      const diagnosis = !fan ? [] : intent === 'clip' ? await fans.faqClip(fan, message.content) : fans.faqPersonal(intent, fan, message.content);
      const content = `${faqAnswer(intent, info, diagnosis)}\n-# 🤖 Réponse automatique. Pas la bonne réponse ? Le staff passe bientôt.`;
      await message
        .reply({ content, allowedMentions: { repliedUser: false } })
        .catch(() => message.channel.send({ content: `<@${message.author.id}> ${content}`, allowedMentions: { users: [message.author.id] } }));
    } catch (err) {
      log.error('salon aide', err);
    }
  });
}

/**
 * Bot des fans (ex. « BeOne Rewards ») : bot séparé, installé sur le serveur du créateur.
 * /site, /coins, et envoi des messages privés préparés par le tracker (coins, niveau, livraison…).
 */
export async function startFansBot(opts: { token: string; clientId?: string; guildIds: string[]; fans: FanService; siteUrl: string; youtubeApiKey?: string }): Promise<() => Promise<void>> {
  if (opts.clientId) {
    const rest = new REST().setToken(opts.token);
    const routes = opts.guildIds.length
      ? opts.guildIds.map((g) => Routes.applicationGuildCommands(opts.clientId!, g))
      : [Routes.applicationCommands(opts.clientId)];
    for (const route of routes) {
      await rest.put(route, { body: [...fanCommandDefinitions, inscriptionCommand(opts.fans), inscription2Command(), setupCommand, momentsCommand] }).catch((err) => log.error('bot fans : enregistrement des commandes', err));
    }
  }
  // Lire le salon #mes-comptes demande « Message Content Intent » (portail Discord, onglet Bot).
  // « Server Members Intent » (portail Discord) : liste complète des membres pour le funnel de Mars ; facultatif
  const make = (withMessages: boolean, withMembers = false) =>
    new DiscordClient({
      intents: [GatewayIntentBits.Guilds, ...(withMessages ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []), ...(withMembers ? [GatewayIntentBits.GuildMembers] : [])],
    });
  let discord = make(true, true);
  let readsMessages = true;
  let timer: NodeJS.Timeout | undefined;
  let autoTimer: NodeJS.Timeout | undefined;
  // Commandes enregistrées sur chaque serveur où est le bot (au démarrage et dès qu'on l'invite)
  const commandBody = () => [...fanCommandDefinitions, inscriptionCommand(opts.fans), inscription2Command(), setupCommand, momentsCommand];
  const registerIn = (appId: string, guildId: string) =>
    new REST()
      .setToken(opts.token)
      .put(Routes.applicationGuildCommands(appId, guildId), { body: commandBody() })
      .catch((err) => log.error(`bot fans : commandes sur le serveur ${guildId}`, err));
  function onReady(c: DiscordClient<true>) {
    for (const g of c.guilds.cache.values()) void registerIn(c.application.id, g.id);
    status.neptune = {
      state: 'ready',
      tag: c.user.tag,
      guilds: c.guilds.cache.size,
      error: readsMessages ? undefined : 'Active « Message Content Intent » (portail Discord > Bot) pour le salon #mes-comptes',
    };
    c.user.setActivity('🪙 /site pour la boutique', { type: ActivityType.Custom });
    log.info(`bot fans connecté en tant que ${c.user.tag}`);
    opts.fans.onTrainingDone = (discordId) => onTrainingCompleted(c, opts.fans, discordId);
    // Inscription terminée sur le site : rôles, salon privé et log, comme l'ancien formulaire Discord
    opts.fans.onRegistered = async (discordId, accounts) => {
      const ids = new Set(opts.fans.botState<string[]>('setup-guilds', []));
      for (const guild of c.guilds.cache.filter((g) => ids.has(g.id)).values()) {
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue;
        await onFanRegistered(guild, member, accounts, opts.fans.publicSiteUrl(), [
          ...(opts.fans.unverifiedAccounts(opts.fans.ensureFan(discordId, member.displayName).id).length ? ['🔎 Tes comptes sont vérifiés sous 24 h : tes vues comptent dès la validation, rien n’est perdu.'] : []),
          ...(opts.fans.settings().clipRule ? [`🏷️ **Mets #${opts.fans.clipKeywords()[0] ?? 'createur'} dans la légende de chaque clip**, sinon il ne compte pas.`] : []),
        ]);
      }
    };
    timer = setInterval(() => void sendNotifications().catch((err) => log.error('messages privés fans', err)), 2 * 60_000);
    void sendNotifications().catch(() => {});
    // Serveur monté par /setup (toutes les 15 min) : rôles de palier, classement du lundi, nouvelles vidéos
    const automations = async () => {
      await cleanupQuests(c, opts.fans).catch((err) => log.error('nettoyage quêtes', err));
      await reportSuspicious(c, opts.fans).catch((err) => log.error('fans à vérifier', err));
      await reportOrdersToApprove(c, opts.fans).catch((err) => log.error('achats à valider', err));
      await reportAccountsToReview(c, opts.fans).catch((err) => log.error('comptes à vérifier', err));
      await unlockFirstClips(c, opts.fans).catch((err) => log.error('1er clip', err));
      await syncTierRoles(c, opts.fans).catch((err) => log.error('rôles de palier', err));
      await syncGradeRoles(c, opts.fans).catch((err) => log.error('grades du mois', err));
      await snapshotOnboarding(c, opts.fans).catch((err) => log.error('funnel onboarding', err));
      await weeklyRanking(c, opts.fans).catch((err) => log.error('classement de la semaine', err));
      await monthlyPodium(c, opts.fans).catch((err) => log.error('podium du mois', err));
      await relanceFans(c, opts.fans).catch((err) => log.error('relances fans', err));
      // Motivation : récap du lundi, dépassements, clip de la semaine, meilleurs clips du jour, défi du week-end, feedback des clips
      await clipOfWeek(c, opts.fans).catch((err) => log.error('clip de la semaine', err));
      await weeklyRecap(c, opts.fans).catch((err) => log.error('récap de la semaine', err));
      await overtakeAlerts(c, opts.fans).catch((err) => log.error('dépassements', err));
      await dailyBestClips(c, opts.fans).catch((err) => log.error('meilleurs clips', err));
      await weekendChallenge(c, opts.fans).catch((err) => log.error('défi du week-end', err));
      await clipFeedbackMessages(c, opts.fans).catch((err) => log.error('feedback des clips', err));
      await motivationFans(c, opts.fans).catch((err) => log.error('motivation', err));
      await trackingDigest(c, opts.fans).catch((err) => log.error('relevé de la nuit', err));
      await warnBrokenAccounts(c, opts.fans).catch((err) => log.error('comptes introuvables', err));
      await connectReminders(c, opts.fans).catch((err) => log.error('rappels connexion', err));
      if (opts.youtubeApiKey) await announceNewVideos(c, opts.fans, opts.youtubeApiKey).catch((err) => log.error('nouvelles vidéos', err));
    };
    autoTimer = setInterval(() => void automations(), 15 * 60_000);
    setTimeout(() => void automations(), 60_000);
  }
  const wire = (d: DiscordClient) => {
    d.once(Events.ClientReady, onReady);
    d.on(Events.Error, (err) => log.error('bot fans', err));
    attachFanCommands(d, opts.fans, opts.siteUrl);
    attachInscription(d, opts.fans);
    attachMoments(d);
    d.on(Events.GuildCreate, (g) => {
      log.info(`bot fans invité sur ${g.name}`);
      if (d.application) void registerIn(d.application.id, g.id);
    });
    d.on(Events.InteractionCreate, (i) => void handleSetup(i, opts.fans, opts.siteUrl));
    d.on(Events.InteractionCreate, (i) => void handleAlertsButton(i));
    d.on(Events.InteractionCreate, (i) => void handleStepButtons(i));
    d.on(Events.InteractionCreate, (i) => void handleTraining(i, opts.fans));
    if (readsMessages) {
      attachAccountsChannel(d, opts.fans);
      attachHelpChannel(d, opts.fans, opts.siteUrl);
    }
  };

  const shopButton = () =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Voir la boutique').setEmoji('🪙').setURL(opts.siteUrl),
    );
  let sending = false;
  async function sendNotifications() {
    if (sending) return;
    sending = true;
    try {
      for (const n of opts.fans.fans.pendingNotifications()) {
        try {
          const user = await discord.users.fetch(n.discordId);
          await user.send({
            embeds: [new EmbedBuilder().setColor(parseInt(opts.fans.creator.colors.accent.slice(1), 16)).setDescription(n.text).setFooter({ text: opts.fans.creator.texts.dmFooter })],
            components: [shopButton()],
          });
          opts.fans.fans.ackNotification(n.id, null);
        } catch (err) {
          const code = (err as { code?: number }).code;
          opts.fans.fans.ackNotification(n.id, code === 50007 ? 'DM fermés' : String(err).slice(0, 200));
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    } finally {
      sending = false;
    }
  }

  // Essais du plus complet au plus simple : messages + membres, puis messages seuls, puis rien
  const attempts: Array<[boolean, boolean]> = [[true, true], [true, false], [false, false]];
  for (let i = 0; ; i++) {
    const [withMessages, withMembers] = attempts[i]!;
    if (i > 0) {
      discord = make(withMessages, withMembers);
      readsMessages = withMessages;
    }
    wire(discord);
    try {
      await discord.login(opts.token);
      if (!withMembers) log.warn('bot fans : « Server Members Intent » non activé, le funnel de Mars est estimé');
      if (!withMessages) log.warn('bot fans : « Message Content Intent » non activé, le salon #mes-comptes ne marche pas');
      break;
    } catch (err) {
      if (!(err instanceof Error && /disallowed intents/i.test(err.message)) || i === attempts.length - 1) throw err;
      await discord.destroy();
    }
  }
  return async () => {
    if (timer) clearInterval(timer);
    if (autoTimer) clearInterval(autoTimer);
    await discord.destroy();
  };
}
