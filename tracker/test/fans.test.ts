import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FanRepo } from '../src/db/fans.js';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { HOUR } from '../src/domain/stats.js';
import { AgencyService } from '../src/services/agency.js';
import { FanService } from '../src/services/fans.js';
import { RecruitmentRepo } from '../src/db/recruitment.js';
import { RecruitmentService } from '../src/services/recruitment.js';
import { createApp } from '../src/web/server.js';
import { collectAll } from '../src/jobs/collect.js';
import { isAccountsChannel, isTicketChannel } from '../src/bot/fans.js';
import { deliverPendingOrders, GameClient } from '../src/services/game.js';
import { creatorConfig } from '../src/creators/index.js';
import { deliverEmailOrders, EmailGrantClient, monthsOf } from '../src/services/emailGrant.js';

/** Compte relié avant les clips du test (seuls les clips publiés après l'ajout du compte rapportent). */
const DAY = 24 * HOUR;
const backdate = (repo: Repo, at: number) => repo.db.prepare('UPDATE accounts SET created_at = ?, verified_at = ?').run(at, at);
/** Simule le premier relevé des comptes (la file du staff n'affiche que les comptes déjà relevés). */
const releve = (repo: Repo, followers?: number) =>
  repo.db.prepare('UPDATE accounts SET last_checked_at = COALESCE(last_checked_at, ?), followers = COALESCE(?, followers)').run(Date.now(), followers ?? null);

describe('programme fans (Neptune)', () => {
  let repo: Repo;
  let agency: AgencyService;
  let fans: FanService;
  const now = Date.now();

  beforeEach(() => {
    repo = new Repo(openDatabase(':memory:'));
    agency = new AgencyService(repo);
    fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async (name) =>
      name.toLowerCase() === 'paulrbx' ? { id: 42, name: 'PaulRbx' } : null,
    );
    const client = repo.upsertClient({ name: 'BeOne', rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
    fans.saveSettings({ clientId: client.id, pointsPer1000: 10, orderReview: false, accountReview: false });
  });

  /** Le fan poste un compte ; 1re collecte = référence, puis +5 000 vues → 50 points. */
  function fanWithViews() {
    const fan = fans.ensureFan('d1', 'Paul', now - 3 * HOUR);
    expect(fans.addAccounts(fan, 'https://www.tiktok.com/@paul.clips').added).toHaveLength(1);
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    backdate(repo, now - 3 * HOUR);
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 0, publishedAt: now - 2 * HOUR }], now - 2 * HOUR);
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 5000, publishedAt: now - 2 * HOUR }], now - HOUR);
    return fan;
  }

  it('connexion TikTok d’un autre pseudo : ses clips comptent depuis son inscription, pas depuis la connexion', () => {
    const fan = fans.ensureFan('d8', 'Antoine', now - 5 * DAY);
    fans.addAccounts(fan, 'https://www.tiktok.com/@antoine.mal.tape');
    const old = repo.listAccountsForClipper(fan.id)[0]!;
    repo.db.prepare('UPDATE accounts SET created_at = ? WHERE id = ?').run(now - 5 * DAY, old.id);
    const id = fans.connectOfficial(fan, 'tiktok', 'antoine.clips', now);
    const acc = repo.listAccountsForClipper(fan.id).find((a) => a.id === id)!;
    expect(acc.createdAt).toBe(now - 5 * DAY);
    expect(repo.listAccountsForClipper(fan.id).map((a) => a.id)).toEqual([id]);
    repo.recordCollection(id, [{ platformVideoId: 't1', views: 20_000, publishedAt: now - 2 * DAY }], now);
    expect(fans.balance(fan.id, now).earned).toBe(200);
  });

  it('funnel d’onboarding : étapes Discord (photo du bot) puis inscription, 1er clip, coins', () => {
    fanWithViews();
    fans.ensureFan('d7', 'Curieux'); // venu sur le site, rien relié
    fans.setBotState('onboarding', { at: now, exact: true, members: 50, reader: 30, rules: 20, trained: 10 });
    const f = fans.onboardingFunnel(now);
    expect(f.steps.map((x) => x.count)).toEqual([50, 30, 20, 10, 1, 1, 1, 0, 0]);
    expect(f.exact).toBe(true);
  });

  it('Loann : pas de #tag, et tous les clips depuis le 1er août comptent (toutes leurs vues, même postés avant l’inscription)', () => {
    const loann = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('loann'));
    expect(loann.settings().clipRule).toBe(false);
    expect(loann.countFromLabel()).toBe('1er août');
    const fan = loann.ensureFan('d9', 'Lou', now);
    loann.addAccounts(fan, 'https://www.tiktok.com/@lou.clips');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    repo.setAccountVerified(account.id, now);
    const aug = Date.parse('2026-08-10T12:00:00+02:00');
    const july = Date.parse('2026-07-10T12:00:00+02:00');
    // 1er relevé (référence), puis un 2e relevé qui découvre de vieux clips : ceux d'août comptent en entier
    repo.recordCollection(account.id, [{ platformVideoId: 'a', views: 1000, publishedAt: aug, title: 'sans tag' }], now);
    repo.recordCollection(account.id, [{ platformVideoId: 'b', views: 3000, publishedAt: aug, title: 'x' }, { platformVideoId: 'c', views: 9000, publishedAt: july, title: 'x' }], now + 1);
    expect(loann.balance(fan.id, now + 2).views).toBe(4000);
    expect(loann.coinsState(fan, now + 2).tag).toBeNull();
    // Comptes de confiance : même un gros compte est validé d'office
    expect(loann.settings().accountReview).toBe(false);
    repo.setAccountVerified(account.id, null, 500_000);
    releve(repo);
    expect(loann.autoReviewAccounts(now)).toBe(1);
    expect(loann.flagSuspicious()).toEqual([]);
  });

  it('classement du mois : le top 3 du mois écoulé reçoit la récompense offerte, une seule fois', () => {
    const loann = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('loann'));
    loann.fans.createItem({ name: '1 mois de MS', kind: 'item' as never, ref: 'ms-1m', price: 10000 });
    const sept = FanService.monthStart(Date.parse('2026-09-15T12:00:00Z'));
    const oct = FanService.monthStart(Date.parse('2026-10-15T12:00:00Z'));
    expect(new Date(oct).toISOString()).toBe('2026-09-30T22:00:00.000Z');
    const mk = (id: string, views: number) => {
      const fan = loann.ensureFan(id, id);
      loann.addAccounts(fan, `https://www.tiktok.com/@${id}.clips`);
      const acc = repo.listAccountsForClipper(fan.id)[0]!;
      repo.db.prepare('UPDATE accounts SET created_at = ?, verified_at = ? WHERE id = ?').run(sept - 1, sept - 1, acc.id);
      repo.recordCollection(acc.id, [{ platformVideoId: `${id}v`, views: 0, publishedAt: sept + 1000 }], sept + 2000);
      repo.recordCollection(acc.id, [{ platformVideoId: `${id}v`, views, publishedAt: sept + 1000 }], sept + 86_400_000);
      return fan;
    };
    mk('a', 500); mk('b', 3000); mk('c', 2000); mk('d', 1000);
    const r = loann.awardMonthlyPrize(oct + 11 * 3_600_000)!;
    expect(r.winners.map((w) => w.name)).toEqual(['b', 'c', 'd']);
    expect(loann.fans.orders({}).filter((o) => o.price === 0)).toHaveLength(3);
    expect(loann.awardMonthlyPrize(oct + 12 * 3_600_000)).toBeNull();
  });

  it('podium du mois de Micka : lot hors boutique (event IRL), aucune commande créée', () => {
    const micka = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('micka'));
    const r = micka.awardMonthlyPrize(Date.parse('2026-11-01T10:00:00Z'))!;
    expect(r).toMatchObject({ manual: true, reward: expect.stringContaining('IRL') });
    expect(micka.fans.orders({})).toHaveLength(0);
  });

  it('inscription sur le site : 3 réseaux + e-mail, rôles Discord déclenchés une seule fois, rien de retiré par un champ vide', async () => {
    const squiduu = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('squiduu'));
    const calls: Array<[string, string[]]> = [];
    squiduu.onRegistered = (id, accounts) => void calls.push([id, accounts]);
    const fan = squiduu.ensureFan('s1', 'Sam');
    const a = await squiduu.siteRegister(fan, { tiktok: '@sam.tt', youtube: '@samyt' });
    expect(a).toMatchObject({ missing: ['instagram'], registered: false });
    expect(calls).toHaveLength(0);
    const b = await squiduu.siteRegister(fan, { instagram: 'https://www.instagram.com/sam.ig/', reward: 'sam@mail.fr' });
    expect(b).toMatchObject({ missing: [], registered: true });
    expect(calls).toEqual([['s1', expect.arrayContaining(['TikTok @sam.tt', 'YouTube @samyt', 'Instagram @sam.ig'])]]);
    expect(squiduu.rewardAccount(fan.id).value).toBe('sam@mail.fr');
    // Modifier un compte après coup : pas de 2e déclenchement, champ vide = inchangé
    await squiduu.siteRegister(fan, { youtube: '@samyt2', tiktok: '' });
    expect(calls).toHaveLength(1);
    expect(squiduu.missingPlatforms(fan.id)).toEqual([]);
    expect(squiduu.signupUrl(fan.id)).toContain('next=inscription');
  });

  it('inscription sur le site : chaîne YouTube introuvable refusée tout de suite, le reste est gardé', async () => {
    const squiduu = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('squiduu'));
    squiduu.fetchers = { youtube: { platform: 'youtube', fetchAccount: async () => ({ videos: [] }), fetchProfile: async (a: { handle: string }) => {
      if (a.handle === 'pseudotiktok') throw new Error('Chaîne YouTube introuvable : pseudotiktok');
      return { bio: '' };
    } } } as never;
    const fan = squiduu.ensureFan('yt1', 'Yan');
    const r = await squiduu.siteRegister(fan, { tiktok: '@yan.tt', youtube: '@pseudotiktok' });
    expect(r.notFound).toEqual(['youtube']);
    expect(r.missing).toContain('youtube');
    expect(squiduu.accountsOf(fan.id).map((a) => a.platform)).toEqual(['tiktok']);
    expect((await squiduu.siteRegister(fan, { youtube: '@vraiechaine' })).notFound).toEqual([]);
  });

  it('rappel « connecte ton TikTok » : fans pas connectés, ceux en pause repérés', async () => {
    const svc = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('squiduu'));
    const fan = svc.ensureFan('ct1', 'Cleo');
    await svc.siteRegister(fan, { tiktok: '@cleo.tt' });
    const tt = svc.accountsOf(fan.id).find((a) => a.platform === 'tiktok')!;
    const connected = new Set<number>();
    svc.officialLogin = { platforms: ['tiktok'], connected: () => connected };
    const mine = () => svc.fansToConnect().find((f) => f.clipperId === fan.id);
    expect(mine()).toMatchObject({ platforms: ['tiktok'], paused: false });
    repo.markAccountChecked(tt.id, Date.now(), { error: 'Apify: Monthly usage hard limit exceeded' });
    expect(mine()?.paused).toBe(true);
    connected.add(tt.id);
    expect(mine()).toBeUndefined();
  });

  it('relances perso des fans : 1 jour sans clip, seulement après un relevé, 1 par jour, 1re / 2e / 3e+, avec leurs chiffres et la citation de leur message', async () => {
    const { RELANCE_1, RELANCE_2, RELANCE_3, personalRelance } = await import('../src/domain/relance.js');
    const fan = fans.ensureFan('r1', 'Rel');
    fans.setAccounts(fan, { tiktok: '@rel.tt' });
    const t0 = Date.now();
    const day = 86_400_000;
    const checked = (t: number) => repo.db.prepare('UPDATE accounts SET last_checked_at = ?').run(t);
    const due = (t: number) => fans.relancesDue(t).filter((r) => r.discordId === 'r1');
    checked(t0);
    expect(due(t0 + 2 * day)).toHaveLength(0); // pas relevé depuis : on ne sait pas s'il a posté
    const heads: string[] = [];
    for (const d of [2, 3, 4, 5]) {
      checked(t0 + d * day - 60_000);
      const [r] = due(t0 + d * day);
      expect(r).toBeDefined();
      const msg = personalRelance(r!.ctx, r!.previous, d, String);
      expect(msg).toContain('sans nouveau clip');
      fans.logRelance(r!.clipperId, msg, t0 + d * day);
      heads.push(msg.split('\n')[0]!);
      expect(due(t0 + d * day + 60_000)).toHaveLength(0); // une seule par jour
    }
    expect(RELANCE_1).toContain(heads[0]);
    expect(RELANCE_2).toContain(heads[1]);
    expect(RELANCE_3).toContain(heads[2]);
    expect(heads[3]).not.toBe(heads[2]);
    const quoted = personalRelance({ level: 1, daysIdle: 1, quote: { text: 'je bosse sur un montage', ago: 'hier' } }, null, 0, String);
    expect(quoted).toContain('« je bosse sur un montage »');
  });

  it('quêtes : 3 comptes = +5 coins une seule fois, série de 7 jours = +100 coins', async () => {
    const { currentStreak, buildQuests } = await import('../src/domain/quests.js');
    const now = Date.parse('2026-10-17T12:00:00Z');
    const day = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    expect(currentStreak([0, 1, 2].map(day), now).length).toBe(3);
    expect(currentStreak([1, 2].map(day), now).length).toBe(2);
    expect(currentStreak([2, 3].map(day), now).length).toBe(0);
    expect(buildQuests({ platforms: 3, views: 12_000, streak: 7 }).every((q) => q.done)).toBe(true);
    const fan = fans.ensureFan('q1', 'Quest');
    fans.setAccounts(fan, { tiktok: '@q.tt', youtube: '@qyt', instagram: '@q.ig' });
    const before = fans.balance(fan.id).earned;
    const got = fans.awardQuests().filter((r) => r.discordId === 'q1');
    expect(got.map((r) => r.coins)).toEqual([5]);
    expect(fans.balance(fan.id).earned).toBe(before + 5);
    expect(fans.awardQuests().filter((r) => r.discordId === 'q1')).toHaveLength(0);
    // Quêtes arrêtées : coins retirés
    fans.undoQuests();
    expect(fans.balance(fan.id).earned).toBe(before);
  });

  it('/inscription2 : un 2e compte du même réseau, compté sur le même profil', () => {
    const fan = fans.ensureFan('d5', 'Duo');
    fans.setAccounts(fan, { tiktok: '@duo.main' });
    fans.setAccounts(fan, { tiktok: '@duo.second' }, 2);
    expect(fans.accountsOf(fan.id).map((a) => `${a.handle}:${a.slot}`).sort()).toEqual(['duo.main:1', 'duo.second:2']);
    // Changer le 2e ne touche pas au 1er, et le vider le retire
    fans.setAccounts(fan, { tiktok: '' }, 2);
    expect(fans.accountsOf(fan.id).map((a) => a.handle)).toEqual(['duo.main']);
  });

  it('grades du mois glissant : seules les vues de la période comptent', () => {
    const fan = fanWithViews();
    expect(fans.fanLevels(now, 30).find((f) => f.clipperId === fan.id)?.views).toBe(5000);
    // Fenêtre qui commence après le dernier relevé : aucune vue gagnée dans la période → Débutant
    expect(fans.fanLevels(now, 0.00001).find((f) => f.clipperId === fan.id)).toMatchObject({ views: 0, level: 0 });
  });

  it('FAQ perso : solde, classement, clip qui compte et questions sans réponse', () => {
    const fan = fanWithViews();
    expect(fans.faqPersonal('balance', fan, '').join(' ')).toContain('50 coins');
    expect(fans.faqPersonal('rank', fan, '').join(' ')).toMatch(/1er/);
    expect(fans.faqPersonal('clip', fan, 'https://www.tiktok.com/@paul.clips/video/v1').join(' ')).toBe('🔎 Je ne trouve pas ce clip dans nos relevés. Raisons possibles : • il a été posté **après le dernier relevé** (les vues sont relevées chaque nuit 🌙) ; • il est sur un compte **pas relié** à ton inscription (vérifie dans 📝│inscription).');
    repo.db.prepare("UPDATE videos SET platform_video_id = '7412345678901234567'").run();
    expect(fans.faqPersonal('clip', fan, 'https://www.tiktok.com/@paul.clips/video/7412345678901234567').join(' ')).toContain('✅ Ce clip compte');
    const other = fans.ensureFan('d2', 'Autre');
    expect(fans.faqPersonal('clip', other, 'https://www.tiktok.com/@x/video/7412345678901234567')[0]).toContain('un autre membre');
    fans.logFaqMiss('d1', 'Paul', 'c’est quand le prochain live ?');
    expect(fans.fans.faqMisses()).toMatchObject([{ username: 'Paul', text: 'c’est quand le prochain live ?' }]);
  });

  it('formation : liens réglés dans Mars, tout coché → débloqué une seule fois', async () => {
    fans.saveSettings({ training: '206 | https://youtu.be/abcdefghijk\n201 https://frame.io/x\n203 | https://cdn.test/203.mp4?v=1\nligne sans lien' });
    const fan = fans.ensureFan('d9', 'Clip');
    const t = fans.training(fan.id);
    expect(t.modules.find((m) => m.num === '206')).toMatchObject({ url: 'https://youtu.be/abcdefghijk', embed: 'https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0', done: false });
    expect(t.modules.find((m) => m.num === '201')).toMatchObject({ url: 'https://frame.io/x', embed: null, video: null });
    expect(t.modules.find((m) => m.num === '203')).toMatchObject({ video: 'https://cdn.test/203.mp4?v=1' });
    const done: string[] = [];
    fans.onTrainingDone = (id) => void done.push(id);
    for (const m of t.modules) fans.setTrainingStep(fan, m.num, true);
    expect(fans.trainingDone(fan.id)).toBe(true);
    fans.setTrainingStep(fan, '206', false);
    fans.setTrainingStep(fan, '206', true);
    expect(done).toEqual(['d9', 'd9']);
    expect(() => fans.setTrainingStep(fan, '999', true)).toThrow();
    expect(fans.trainingUrl(fan.id)).toMatch(/\/fan\/login\?t=.+&next=formation$/);
    const { SERVER_PLAN, ROLE_TRAINED, ROLE_CLIPPER, ROLE_PENDING } = await import('../src/bot/fanServer.js');
    const inscription = SERVER_PLAN.flatMap((g) => g.channels).find((c) => c.name.includes('inscription'))!;
    expect(inscription.access).toMatchObject({ who: 'role', role: ROLE_TRAINED, also: [ROLE_CLIPPER, ROLE_PENDING] });
  });

  it('anti-triche : compte vérifié par le code dans la bio, gros compte « à vérifier » et achats bloqués', async () => {
    const fan = fans.ensureFan('d5', 'Tricheur', now - 3 * HOUR);
    fans.addAccounts(fan, 'https://www.youtube.com/@unchained');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    expect(account.verifiedAt).not.toBeNull(); // plus de code exigé par défaut (l'IA vérifie les clips)
    repo.setAccountVerified(account.id, null); // vérification par code (gardée pour plus tard)
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 900_000, publishedAt: Date.now() + 1000 }], Date.now() + 2000);
    expect(fans.balance(fan.id).earned).toBe(0); // compte pas vérifié : rien ne compte
    const code = fans.verifyCode(fan.id);
    expect(code).toMatch(/^NEP-[A-Z0-9]{4}$/);
    expect(fans.verifyCode(fan.id)).toBe(code);
    let bio = 'pas de code';
    fans.fetchers = { youtube: { platform: 'youtube', fetchAccount: async () => ({ videos: [] }), fetchProfile: async () => ({ bio, followers: 2_000_000 }) } } as never;
    expect((await fans.verifyAccounts(fan, 0))[0]).toMatchObject({ ok: false, error: 'code introuvable dans la bio' });
    await expect(fans.verifyAccounts(fan, 30_000)).rejects.toThrow(/Patiente/);
    bio = `Clippeur officiel ${code.toLowerCase()}`;
    expect((await fans.verifyAccounts(fan, 61_000))[0]).toMatchObject({ ok: true });
    expect(repo.listAccountsForClipper(fan.id)[0]).toMatchObject({ followers: 2_000_000 });
    expect(fans.balance(fan.id).earned).toBe(9000);
    // Gros compte → à vérifier, achat bloqué, puis validé par le staff
    expect(fans.flagSuspicious().map((f) => f.id)).toEqual([fan.id]);
    expect(fans.review(fan.id)).toMatchObject({ status: 'pending', reason: expect.stringContaining('abonnés') });
    const item = fans.saveItem(null, { name: 'VIP', price: 100, kind: 'item', ref: 'vip' });
    await fans.linkRoblox(fan, 'paulrbx');
    expect(() => fans.buy(fan, item.id)).toThrow(/vérification/);
    fans.setReview(fan.id, true);
    expect(fans.flagSuspicious()).toEqual([]);
    expect(fans.buy(fan, item.id).status).toBe('pending');
  });

  it('règle gratuite : seuls les clips qui citent le créateur dans la légende rapportent des coins', () => {
    fans.saveSettings({ clipRule: false });
    const fan = fans.ensureFan('d6', 'Clippeur', now - 3 * HOUR);
    fans.addAccounts(fan, 'https://www.tiktok.com/@clips.beone');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    const later = Date.now() + 5000;
    const collect = (title: string) =>
      repo.recordCollection(account.id, [
        { platformVideoId: 'ok', views: 3000, publishedAt: later, title: 'Le rage de Be One 😂 #beone' },
        { platformVideoId: 'vol', views: 900_000, publishedAt: later, title },
      ], later + 1000);
    collect('Mon meilleur short de la semaine');
    expect(fans.balance(fan.id).views).toBe(903_000); // règle coupée : tout compte
    fans.saveSettings({ clipRule: true }); // activée maintenant : s'applique aux clips publiés à partir de là
    expect(fans.balance(fan.id).views).toBe(0); // pas encore vérifiés
    expect(fans.clipKeywords()).toEqual(['beone', 'beonepourcent']);
    expect(fans.checkClips()).toEqual({ validés: 1, refusés: 1 });
    expect(fans.balance(fan.id).views).toBe(3000);
    expect(fans.overview().fans.find((f) => f.id === fan.id)!.refused[0]!.reason).toContain('ne cite pas');
    expect(fans.checkClips()).toEqual({ validés: 0, refusés: 0 }); // rien n'a changé
    collect('Mon meilleur short #BeOnePourcent'); // le clippeur corrige sa légende
    expect(fans.checkClips()).toEqual({ validés: 1, refusés: 0 });
    expect(fans.balance(fan.id).views).toBe(903_000);
    fans.saveSettings({ clipKeywords: 'squiduu, #sqd' });
    expect(fans.clipKeywords()).toEqual(['squiduu', 'sqd']);
  });

  it('Micka : un clip publié avant l’ajout du compte (mais après le 27 août) est bien contrôlé et compte s’il cite #micka', () => {
    const micka = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('micka'));
    micka.saveSettings({ clipRule: true, accountReview: false });
    repo.setSetting('fans', { ...repo.getSetting('fans', {}), clipRuleSince: Date.parse('2026-08-01T00:00:00Z') });
    const fan = micka.ensureFan('oc1', 'Océania');
    micka.addAccounts(fan, 'https://www.instagram.com/micka_quoii_micka_wuu/');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    const before = account.createdAt - 2 * DAY; // posté 2 jours avant de relier son Insta
    repo.recordCollection(account.id, [
      { platformVideoId: 'r1', views: 205, publishedAt: before, title: "Tu sais si c'est la bonne ? #micka #relationship" },
      { platformVideoId: 'r2', views: 100, publishedAt: before, title: 'sans le tag' },
    ], Date.now());
    expect(micka.checkClips()).toEqual({ validés: 1, refusés: 1 });
    const clips = micka.fans.clips(fan.id, 40, Date.parse('2026-08-01T00:00:00Z'), micka.countFrom());
    expect(clips.find((c) => c.title?.includes('#micka'))).toMatchObject({ counted: true, why: [] });
    expect(clips.find((c) => c.title === 'sans le tag')?.why).toEqual(['notag']);
  });

  it('clip jamais vu par les relevés : retrouvé à partir de son lien et ajouté au bon compte (staff et FAQ du fan)', async () => {
    const micka = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('micka'));
    micka.saveSettings({ clipRule: true, accountReview: false });
    const fan = micka.ensureFan('mi1', 'Miattack');
    micka.addAccounts(fan, 'https://www.instagram.com/mickaelwuclip6/');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    repo.recordCollection(account.id, [{ platformVideoId: 'old1', views: 900, publishedAt: Date.now() - DAY, title: 'vieux #micka' }], Date.now() - HOUR);
    let calls = 0;
    micka.clipFetchers = { instagram: { fetchVideo: async (url: string) => {
      calls++;
      const code = url.match(/reel\/([\w-]+)/)![1]!;
      return { owner: code === 'Autre1x' ? 'quelquun' : 'mickaelwuclip6', ownerId: null, video: { platformVideoId: code, url, views: 40_000, publishedAt: Date.now(), title: 'Et vous combien vous dépensez #mickaelwu #business #micka' } };
    } } };
    // Le fan colle le lien dans son salon : retrouvé, ajouté, il compte
    const lines = await micka.faqClip(fan, 'ce clip est pas compté ? https://www.instagram.com/reel/De9TBcEMFpj/?hl=fr');
    expect(lines[0]).toContain('clip ajouté');
    expect(lines.join(' ')).toContain('Ce clip compte');
    expect(micka.balance(fan.id).views).toBeGreaterThanOrEqual(40_000);
    // Déjà suivi : pas de nouvelle lecture payante
    expect(await micka.recoverClip('https://www.instagram.com/reel/De9TBcEMFpj/')).toEqual({ status: 'exists' });
    // Posté sur un compte que personne n'a relié
    expect(await micka.recoverClip('https://www.instagram.com/reel/Autre1x/')).toEqual({ status: 'not-linked', owner: 'quelquun' });
    // 3 recherches par jour pour un fan
    await micka.recoverClip('https://www.instagram.com/reel/Xabc2/', fan.id);
    await micka.recoverClip('https://www.instagram.com/reel/Xabc3/', fan.id);
    expect(await micka.recoverClip('https://www.instagram.com/reel/Xabc4/', fan.id)).toEqual({ status: 'quota' });
    expect(calls).toBe(4);
  });

  it('nouveaux comptes : file « à vérifier » du staff, vues comptées dès la validation (rétroactif), refus = plus suivi', () => {
    fans.saveSettings({ accountReview: true });
    const fan = fans.ensureFan('d8', 'Nouveau', now - 3 * HOUR);
    fans.setAccounts(fan, { tiktok: '@nouveau.clips', youtube: '@nouveauyt' });
    const [tt, yt] = repo.listAccountsForClipper(fan.id);
    const later = Date.now() + 1000;
    repo.recordCollection(tt!.id, [{ platformVideoId: 'c1', views: 4000, publishedAt: later, title: 'clip beone', url: 'https://tiktok.test/c1' }], later + 1);
    expect(fans.balance(fan.id).views).toBe(0);
    expect(fans.accountsToReview()).toEqual([]); // pas encore relevés : rien à regarder
    releve(repo);
    const queue = fans.accountsToReview();
    expect(queue.map((a) => a.handle)).toEqual(['nouveau.clips', 'nouveauyt']);
    expect(queue[0]!.clips[0]).toMatchObject({ title: 'clip beone', views: 4000 });
    fans.reviewAccount(tt!.id, true);
    fans.reviewAccount(yt!.id, false);
    expect(fans.balance(fan.id).views).toBe(4000); // rétroactif
    expect(fans.accountsToReview()).toEqual([]);
    expect(repo.listAccountsForClipper(fan.id).some((a) => a.id === yt!.id && a.active)).toBe(false); // refusé : plus suivi
  });

  it('tri automatique : petits comptes validés seuls, gros comptes (abonnés ou vues) laissés au staff', () => {
    fans.saveSettings({ accountReview: true });
    const small = fans.ensureFan('d9', 'Petit', now - 3 * HOUR);
    fans.setAccounts(small, { tiktok: '@petit.clips', youtube: '@petityt' });
    const big = fans.ensureFan('d10', 'Gros', now - 3 * HOUR);
    fans.setAccounts(big, { tiktok: '@unchained', youtube: '@viral' });
    expect(fans.autoReviewAccounts()).toBe(0); // pas encore relevés
    const [, bigTt, bigYt] = [null, ...repo.listAccountsForClipper(big.id)];
    releve(repo, 300);
    repo.db.prepare('UPDATE accounts SET followers = 6360000 WHERE id = ?').run(bigTt!.id);
    repo.recordCollection(bigYt!.id, [{ platformVideoId: 'v1', views: 250_000, publishedAt: now - HOUR, title: 'vidéo' }], now);
    expect(fans.autoReviewAccounts()).toBe(2);
    expect(fans.unverifiedAccounts(small.id)).toEqual([]);
    expect(fans.accountsToReview().map((a) => a.handle).sort()).toEqual(['unchained', 'viral']);
  });

  it('rattrapage : les anciens comptes qui ont rapporté repassent une fois par la vérification du staff', () => {
    const fan = fanWithViews(); // 5 000 vues
    const big = fans.ensureFan('d7', 'Gros', now - 3 * HOUR);
    fans.addAccounts(big, 'https://www.youtube.com/@unchained');
    const acc = repo.listAccountsForClipper(big.id)[0]!;
    backdate(repo, now - 3 * HOUR);
    repo.recordCollection(acc.id, [{ platformVideoId: 'u1', views: 500_000, publishedAt: now - 2 * HOUR }], now - HOUR);
    fans.saveSettings({ accountReview: true });
    expect(fans.requeueOldEarners()).toBe(1); // seul le compte à 500 000 vues (≥ 20 000)
    releve(repo);
    expect(fans.accountsToReview().map((a) => a.handle)).toEqual(['unchained']);
    expect(fans.balance(big.id).views).toBe(0);
    expect(fans.balance(fan.id).views).toBe(5000);
    expect(fans.requeueOldEarners()).toBe(0); // une seule fois
  });

  it('validation du staff : l’achat attend « Valider » avant d’être livré (jeu, e-mail), livraison manuelle = validé', async () => {
    fans.saveSettings({ orderReview: true });
    const fan = fanWithViews();
    await fans.linkRoblox(fan, 'paulrbx');
    const item = fans.saveItem(null, { name: 'VIP', price: 10, kind: 'gamepass', ref: '123' });
    const order = fans.buy(fan, item.id);
    expect(order.approvedAt).toBeNull();
    expect(fans.fans.pendingForGame()).toEqual([]);
    expect(fans.fans.pendingForRoblox(42)).toEqual([]);
    expect(fans.fans.toApprove().map((o) => o.id)).toEqual([order.id]);
    expect(fans.overview().orders[0]!.topClips[0]).toMatchObject({ views: 5000 });
    expect(fans.fans.approve(order.id)).toBe(true);
    expect(fans.fans.pendingForGame().map((o) => o.id)).toEqual([order.id]);
    expect(fans.fans.toApprove()).toEqual([]);
    // Livré à la main (DEBO, Loann) sans clic « Valider » : vaut validation
    const other = fans.saveItem(null, { name: 'Robux', price: 10, kind: 'item', ref: 'rbx' });
    const o2 = fans.buy(fan, other.id);
    expect(fans.fans.markDelivered([o2.id], null)).toBe(1);
    expect(fans.fans.order(o2.id)).toMatchObject({ status: 'delivered', approvedAt: expect.any(Number) });
  });

  it('1er clip : seul un clip posté après avoir relié le compte débloque la communauté', () => {
    const fan = fans.ensureFan('d1', 'Paul', now - 3 * HOUR);
    fans.addAccounts(fan, 'https://www.tiktok.com/@paul.clips');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    repo.setAccountVerified(account.id, now);
    // Vieille vidéo (publiée avant l'ajout du compte) qui continue de monter : ni 1er clip, ni coins
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 100, publishedAt: now - 2 * HOUR }], now);
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 900_000, publishedAt: now - 2 * HOUR }], now + 1000);
    expect(fans.firstClipDone().size).toBe(0);
    expect(fans.balance(fan.id).earned).toBe(0);
    const later = Date.now() + 60_000;
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 900_000, publishedAt: now - 2 * HOUR }, { platformVideoId: 'v2', views: 10_000, publishedAt: later }], later);
    expect([...fans.firstClipDone()]).toEqual(['d1']);
    expect(fans.balance(fan.id).views).toBe(10_000);
  });

  it('livre les achats via l\'API du jeu (200, 429, rejeu, référence invalide)', async () => {
    const fan = fanWithViews();
    await fans.linkRoblox(fan, 'paulrbx');
    const vip = fans.saveItem(null, { name: 'VIP', price: 10, kind: 'gamepass', ref: '111' });
    const pet = fans.saveItem(null, { name: 'Pet', price: 10, kind: 'item', ref: '222' });
    const bad = fans.saveItem(null, { name: 'Épée', price: 10, kind: 'item', ref: 'epee' });
    const o1 = fans.buy(fan, vip.id);
    const o2 = fans.buy(fan, pet.id);
    const o3 = fans.buy(fan, bad.id);
    const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    const answers: Array<[number, unknown]> = [[200, { ok: true, replayed: false }], [429, { error: 'rate_limited', message: 'Quota', retryAfter: 60 }]];
    const game = new GameClient('https://jeu.test/', 'tok', (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
      const [status, body] = answers.shift() ?? [200, { ok: true, replayed: true }];
      return Response.json(body, { status });
    }) as typeof fetch);
    const t = Date.now();
    expect(await deliverPendingOrders(game, fans.fans, t)).toEqual({ livrées: 1, échecs: 1 });
    expect(calls[0]).toEqual({ url: 'https://jeu.test/grant', auth: 'Bearer tok', body: { userId: 42, productId: 111, orderId: `order-${o1.id}-${o1.createdAt}`, type: 'gamepass' } });
    expect(calls[1]!.body.type).toBe('devproduct');
    expect(fans.fans.order(o1.id)!.status).toBe('delivered');
    expect(fans.fans.order(o2.id)!.deliveryError).toMatch(/Limite/);
    expect(fans.fans.order(o3.id)!.deliveryError).toBeNull(); // on s'arrête au rate limit
    expect(await deliverPendingOrders(game, fans.fans, t + 1000)).toEqual({ livrées: 0, échecs: 1 });
    expect(fans.fans.order(o3.id)!.deliveryError).toMatch(/numérique/);
    // Nouvel essai après retryAfter : même orderId, réponse « replayed » = livré
    expect(await deliverPendingOrders(game, fans.fans, t + 61_000)).toEqual({ livrées: 1, échecs: 0 });
    expect(calls.at(-1)!.body.orderId).toBe(calls[1]!.body.orderId);
    expect(fans.fans.order(o2.id)!.status).toBe('delivered');
  });

  it('gamepass déjà possédé : pas de 2e achat, remboursement automatique si le jeu refuse', async () => {
    const fan = fanWithViews();
    await fans.linkRoblox(fan, 'paulrbx');
    const vip = fans.saveItem(null, { name: 'VIP', price: 10, kind: 'gamepass', ref: '111' });
    const o = fans.buy(fan, vip.id);
    let n = 0;
    const game = new GameClient('https://jeu.test', 'tok', (async () => { n++; return Response.json({ error: 'already_owned', message: 'Déjà donné' }, { status: 409 }); }) as unknown as typeof fetch);
    expect(() => fans.buy(fan, vip.id)).toThrow(/déjà ce gamepass/);
    await deliverPendingOrders(game, fans.fans);
    await deliverPendingOrders(game, fans.fans);
    expect(fans.fans.order(o.id)).toMatchObject({ status: 'refunded' });
    expect(fans.fans.order(o.id)!.deliveryError).toMatch(/remboursé automatiquement/);
    expect(fans.balance(fan.id).spent).toBe(0);
    await deliverPendingOrders(game, fans.fans, Date.now() + 86_400_000);
    expect(n).toBe(1);
  });

  it('lit le catalogue du jeu', async () => {
    const game = new GameClient('https://jeu.test', 'tok', (async () =>
      Response.json({ products: [{ id: 5, type: 'devproduct', name: 'Boost', description: 'x2', imageUrl: 'https://img', priceRobux: 49, remaining: null }, { name: 'sans id' }] })) as unknown as typeof fetch);
    expect(await game.products()).toEqual([{ id: 5, type: 'devproduct', name: 'Boost', description: 'x2', imageUrl: 'https://img', priceRobux: 49, remaining: null }]);
  });

  it('lien de connexion à usage unique puis session', () => {
    const fan = fans.ensureFan('d1', 'Paul');
    expect(fan.clientId).toBe(fans.settings().clientId);
    const url = fans.loginUrl(fan.id);
    expect(url.startsWith('https://site.test/fan/login?t=')).toBe(true);
    const token = new URL(url).searchParams.get('t')!;
    const session = fans.login(token);
    expect(session).toBeTruthy();
    expect(fans.login(token)).toBeNull();
    expect(fans.clipperFromSession(session!)?.id).toBe(fan.id);
    expect(fans.clipperFromSession('faux')).toBeNull();
  });

  it('points, achat, stock, remboursement et livraison en jeu', async () => {
    const fan = fanWithViews();
    expect(fans.balance(fan.id)).toMatchObject({ views: 5000, earned: 50, balance: 50 });

    const item = fans.saveItem(null, { name: 'VIP', price: 30, kind: 'gamepass', ref: '123456', stock: 1 });
    expect(() => fans.buy(fan, item.id)).toThrow(/Roblox/);
    await expect(fans.linkRoblox(fan, 'inconnu')).rejects.toThrow(/introuvable/);
    await fans.linkRoblox(fan, 'paulrbx');

    const order = fans.buy(fan, item.id);
    expect(fans.balance(fan.id).balance).toBe(20);
    expect(() => fans.buy(fan, item.id)).toThrow(/déjà ce gamepass/);

    // Un autre fan ne peut pas prendre le même compte Roblox
    const other = fans.ensureFan('d2', 'Léa');
    await expect(fans.linkRoblox(other, 'paulrbx')).rejects.toThrow(/déjà relié/);

    expect(fans.fans.pendingForRoblox(42).map((o) => o.id)).toEqual([order.id]);
    expect(fans.fans.markDelivered([order.id], 999)).toBe(0);
    expect(fans.fans.refund(order.id)).toBe(true);
    expect(fans.balance(fan.id).balance).toBe(50);

    // Coins ajoutés à la main par le staff
    fans.fans.addBonus(fan.id, 1000);
    expect(fans.balance(fan.id)).toMatchObject({ earned: 1050, balance: 1050 });
    fans.fans.addBonus(fan.id, -1000);
    expect(fans.balance(fan.id).balance).toBe(50);
    expect(fans.fans.item(item.id)?.stock).toBe(1);

    const again = fans.buy(fan, item.id);
    expect(fans.fans.markDelivered([again.id], 42)).toBe(1);
    expect(fans.fans.refund(again.id)).toBe(false);
    expect(fans.balance(fan.id).balance).toBe(20);
  });

  it('HTTP : espace fan sans mot de passe staff, API du jeu protégée par clé', async () => {
    const fan = fanWithViews();
    await fans.linkRoblox(fan, 'paulrbx');
    const item = fans.saveItem(null, { name: 'Épée', price: 10, kind: 'item', ref: 'sword' });
    const recruitment = new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency);
    const app = createApp({ repo, agency, recruitment, fans, password: 'secret', robloxApiKey: 'k3y', neptuneApiKey: 'n3p', bot: {} });
    const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    // Dashboard staff : mot de passe ; espace fan : non
    expect((await app.request('/api/fans')).status).toBe(401);
    expect((await app.request('/fan')).status).toBe(200);
    expect((await app.request('/api/fan/me')).status).toBe(401);

    const token = new URL(fans.loginUrl(fan.id)).searchParams.get('t')!;
    const login = await app.request(`/fan/login?t=${token}`);
    expect(login.status).toBe(302);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request(`/fan/login?t=${token}`)).headers.get('location')).toContain('/fan?error=');

    const me = (await (await app.request('/api/fan/me', { headers: { cookie } })).json()) as { balance: number; roblox: { username: string } };
    expect(me).toMatchObject({ balance: 50, roblox: { username: 'PaulRbx' } });
    const bought = await app.request('/api/fan/orders', json('POST', { itemId: item.id }, { cookie }));
    expect(bought.status).toBe(200);

    // Bot Neptune (Python) : lien /site et points
    expect((await app.request('/api/neptune/link', json('POST', { discordId: '123456', username: 'Zoé' }))).status).toBe(401);
    const link = (await (await app.request('/api/neptune/link', json('POST', { discordId: '123456', username: 'Zoé' }, { 'x-api-key': 'n3p' }))).json()) as { url: string };
    expect(link.url).toContain('/fan/login?t=');
    const pts = (await (await app.request('/api/neptune/points', json('POST', { discordId: '999999', username: 'X' }, { 'x-api-key': 'n3p' }))).json()) as { balance: number };
    expect(pts.balance).toBe(0);

    // Jeu Roblox
    expect((await app.request('/api/roblox/pending?userId=42')).status).toBe(401);
    const pending = (await (await app.request('/api/roblox/pending?userId=42', { headers: { 'x-api-key': 'k3y' } })).json()) as {
      orders: Array<{ id: number; ref: string }>;
    };
    expect(pending.orders).toMatchObject([{ ref: 'sword' }]);
    const done = await app.request('/api/roblox/delivered', json('POST', { userId: 42, orderIds: [pending.orders[0]!.id] }, { 'x-api-key': 'k3y' }));
    expect(((await done.json()) as { updated: number }).updated).toBe(1);

    // Staff avec mot de passe
    const auth = { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
    const overview = (await (await app.request('/api/fans', { headers: auth })).json()) as { fans: Array<{ balance: number }>; orders: Array<{ status: string }> };
    expect(overview.fans[0]?.balance).toBe(40);
    expect(overview.orders[0]?.status).toBe('delivered');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('« Se connecter avec Discord » : state vérifié, fan créé, session ouverte', async () => {
    const app = createApp({
      repo,
      agency,
      recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency),
      fans,
      discordOAuth: { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://site.test/fan/auth/callback' },
      bot: {},
    });
    const start = await app.request('/fan/auth/discord');
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.hostname).toBe('discord.com');
    expect(authorize.searchParams.get('scope')).toBe('identify');
    const state = authorize.searchParams.get('state')!;
    const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;

    // Mauvais state : refusé
    expect((await app.request(`/fan/auth/callback?code=x&state=faux`, { headers: { cookie: stateCookie } })).headers.get('location')).toContain('error=');

    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/oauth2/token')
        ? Response.json({ access_token: 'at' })
        : Response.json({ id: '777777', username: 'zoe', global_name: 'Zoé' }),
    );
    const cb = await app.request(`/fan/auth/callback?code=ok&state=${state}`, { headers: { cookie: stateCookie } });
    expect(cb.headers.get('location')).toBe('/fan');
    const session = cb.headers.get('set-cookie')!.match(/fan_session=([^;]+)/)![1]!;
    const me = (await (await app.request('/api/fan/me', { headers: { cookie: `fan_session=${session}` } })).json()) as { username: string };
    expect(me.username).toBe('Zoé');
    expect(repo.getClipperByDiscordId('777777')?.clientId).toBe(fans.settings().clientId);
  });

  it('notifications : état initial silencieux, 1 message par jour, priorités, livraison, désactivation', async () => {
    // Un mardi : les 3 jours du test restent dans la même semaine (le top 3 n'est annoncé qu'une fois par semaine)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const now = Date.now();
    const fan = fans.ensureFan('d1', 'Paul', now - 3 * HOUR);
    fans.addAccounts(fan, 'https://www.tiktok.com/@paul.clips');
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    backdate(repo, now - 4 * HOUR);
    const collect = (views: number, at: number) => repo.recordCollection(account.id, [{ platformVideoId: 'v1', views, publishedAt: now - 3 * HOUR }], at);
    collect(0, now - 2 * HOUR);
    collect(5000, now - HOUR); // 5 000 vues = 50 coins
    const item = fans.saveItem(null, { name: 'VIP', price: 80, kind: 'gamepass', ref: '1' });

    const T0 = now;
    expect(fans.generateNotifications(T0)).toBe(0); // premier passage : on mémorise l'état
    collect(9000, T0 + HOUR); // +4 000 vues → 90 coins
    expect(fans.generateNotifications(T0 + 2 * HOUR)).toBe(1);
    let q = fans.fans.pendingNotifications();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ discordId: 'd1', kind: 'afford' }); // objet abordable avant les coins
    expect(q[0]!.text).toContain('VIP');
    fans.fans.ackNotification(q[0]!.id, null);

    // Même jour : rien d'autre
    expect(fans.generateNotifications(T0 + 3 * HOUR)).toBe(0);

    // Lendemain : passage Clippeur (≥ 10 000 vues) prioritaire sur les coins
    collect(12_000, T0 + 20 * HOUR);
    expect(fans.generateNotifications(T0 + 24 * HOUR)).toBe(1);
    q = fans.fans.pendingNotifications();
    expect(q[0]!.kind).toBe('level');
    fans.fans.ackNotification(q[0]!.id, 'Cannot send messages to this user');

    // Jour suivant : top 3 de la semaine (une fois par semaine)
    expect(fans.generateNotifications(T0 + 48 * HOUR)).toBe(1);
    q = fans.fans.pendingNotifications();
    expect(q[0]).toMatchObject({ kind: 'rank' });
    expect(q[0]!.text).toContain('#1');
    fans.fans.ackNotification(q[0]!.id, null);

    // Puis les coins gagnés depuis le dernier message sur les coins
    expect(fans.generateNotifications(T0 + 72 * HOUR)).toBe(1);
    q = fans.fans.pendingNotifications();
    expect(q[0]).toMatchObject({ kind: 'coins' });
    expect(q[0]!.text).toContain('+70 coins');
    fans.fans.ackNotification(q[0]!.id, null);

    // Livraison : toujours annoncée, même le même jour
    await fans.linkRoblox(fan, 'paulrbx');
    const order = fans.buy(fan, item.id, T0 + 73 * HOUR);
    fans.fans.markDelivered([order.id], 42, T0 + 73 * HOUR);
    expect(fans.generateNotifications(T0 + 74 * HOUR)).toBe(1);
    expect(fans.fans.pendingNotifications()[0]).toMatchObject({ kind: 'delivered' });
    expect(fans.generateNotifications(T0 + 75 * HOUR)).toBe(0);

    // Désactivées : plus rien
    fans.fans.setNotify(fan.id, false);
    collect(50_000, T0 + 90 * HOUR);
    expect(fans.generateNotifications(T0 + 100 * HOUR)).toBe(0);
    expect(fans.fans.notificationStats(0)).toMatchObject({ sent: 3, failed: 1, pending: 1 });
  });

  it('collecte : les comptes des fans ne sont relevés qu’une fois par jour', async () => {
    const fan = fans.ensureFan('d1', 'Paul');
    fans.addAccounts(fan, 'https://www.tiktok.com/@paul.clips');
    let calls = 0;
    const fetcher = { platform: 'tiktok' as const, fetchAccount: async () => (calls++, { videos: [] }) };
    const fetchers = { tiktok: fetcher, instagram: { ...fetcher, platform: 'instagram' as const }, youtube: { ...fetcher, platform: 'youtube' as const } };
    const fanClient = fans.settings().clientId;
    const skip = (a: { clientId: number | null; lastCheckedAt: number | null }, t: number) =>
      a.clientId === fanClient && a.lastCheckedAt !== null && t - a.lastCheckedAt < 23.5 * HOUR;
    let t = now;
    await collectAll(repo, fetchers, () => t, skip);
    t += 2 * HOUR;
    await collectAll(repo, fetchers, () => t, skip);
    expect(calls).toBe(1);
    t += 24 * HOUR;
    await collectAll(repo, fetchers, () => t, skip);
    expect(calls).toBe(2);
  });

  it('reconnaît le salon des comptes', () => {
    for (const n of ['👤│comptes', 'mes-comptes', '📱・mes-comptes', 'comptes']) expect(isAccountsChannel(n)).toBe(true);
    for (const n of ['tuto-comptes', '📊│comptes-staff', 'général']) expect(isAccountsChannel(n)).toBe(false);
  });

  it('un même compte ne peut pas être suivi deux fois (même ID réel sous deux adresses)', async () => {
    const a = fans.ensureFan('d1', 'Paul');
    const b = fans.ensureFan('d2', 'Léa');
    fans.addAccounts(a, 'https://www.youtube.com/@paulclips');
    // Même pseudo : refusé tout de suite
    expect(fans.addAccounts(b, 'https://www.youtube.com/@paulclips').conflicts).toHaveLength(1);
    // Même chaîne via son identifiant : acceptée à l'ajout, désactivée à la collecte
    expect(fans.addAccounts(b, 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa').added).toHaveLength(1);
    const fetcher = { platform: 'youtube' as const, fetchAccount: async () => ({ externalId: 'UCaaaaaaaaaaaaaaaaaaaaaa', videos: [{ platformVideoId: 'v', views: 10 }] }) };
    await collectAll(repo, { tiktok: fetcher as never, instagram: fetcher as never, youtube: fetcher });
    expect(repo.listAccountsForClipper(a.id)).toHaveLength(1);
    expect(repo.listAccountsForClipper(b.id)).toHaveLength(0);
  });

  it('/inscription : un champ par réseau, vide = retiré, compte d’un autre refusé', () => {
    const a = fans.ensureFan('d1', 'Paul');
    const b = fans.ensureFan('d2', 'Léa');
    let r = fans.setAccounts(a, { tiktok: '@Paul.Clips', youtube: 'https://www.youtube.com/@paulyt', instagram: '' });
    expect(r.linked.map((l) => `${l.platform}:${l.handle}`)).toEqual(['tiktok:paul.clips', 'youtube:paulyt']);
    r = fans.setAccounts(b, { tiktok: 'paul.clips', youtube: 'pas un lien !!', instagram: '@lea' });
    expect(r.conflicts.map((l) => l.handle)).toEqual(['paul.clips']);
    expect(r.invalid).toEqual(['youtube']);
    expect(fans.accountsOf(b.id).map((x) => x.handle)).toEqual(['lea']);
    r = fans.setAccounts(a, { tiktok: '@paul.clips', youtube: '', instagram: '' });
    expect(r.removed).toEqual(['youtube']);
    expect(fans.accountsOf(a.id).map((x) => x.handle)).toEqual(['paul.clips']);
  });

  it('/inscription seulement dans les tickets', () => {
    expect(isTicketChannel({ name: 'ticket-0042' })).toBe(true);
    expect(isTicketChannel({ name: 'paul', parent: { name: '🎫 Tickets' } })).toBe(true);
    expect(isTicketChannel(null)).toBe(true); // ticket privé invisible pour le bot
    expect(isTicketChannel({ name: 'général', parent: { name: 'général clipper' } })).toBe(false);
  });
});

describe('créateur configurable (SQUIDUU)', () => {
  it('crée l\'agence et la récompense, e-mail obligatoire, textes de la config', async () => {
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('squiduu'));
    fans.bootstrap();
    fans.bootstrap(); // idempotent
    fans.saveSettings({ orderReview: false });
    const s = fans.settings();
    expect(repo.getClient(s.clientId!)?.name).toBe('SQUIDUU');
    expect(s.programName).toBe('SQUIDUU');
    const items = fans.fans.items();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: '1 mois de Squiduuverse', price: 10_000, stock: null });

    const now = Date.now();
    const fan = fans.ensureFan('d9', 'Léa', now - 3 * HOUR);
    fans.setAccounts(fan, { tiktok: '@lea.clips' });
    const account = repo.listAccountsForClipper(fan.id)[0]!;
    backdate(repo, now - 3 * HOUR);
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 0, publishedAt: now - 2 * HOUR }], now - 2 * HOUR);
    repo.recordCollection(account.id, [{ platformVideoId: 'v1', views: 2_500_000, publishedAt: now - 2 * HOUR }], now - HOUR);
    expect(fans.balance(fan.id).balance).toBe(25_000);

    expect(() => fans.buy(fan, items[0]!.id)).toThrow(/e-mail/);
    expect(() => fans.linkEmail(fan, 'pas-un-mail')).toThrow(/invalide/);
    expect(fans.linkEmail(fan, ' Lea@Mail.com ')).toBe('lea@mail.com');
    const other = fans.ensureFan('d10', 'Tom', now);
    expect(() => fans.linkEmail(other, 'lea@mail.com')).toThrow(/déjà/);

    // Achetable plusieurs fois (stock illimité)
    const o1 = fans.buy(fan, items[0]!.id);
    fans.buy(fan, items[0]!.id);
    expect(() => fans.buy(fan, items[0]!.id)).toThrow();
    expect(fans.me(fan).rewardAccount).toEqual({ kind: 'email', value: 'lea@mail.com' });
    expect(fans.publicPage().creator.id).toBe('squiduu');

    fans.fans.markDelivered([o1.id], null);
    fans.generateNotifications();
    expect(fans.fans.pendingNotifications().map((n) => n.text)).toContain('✅ Ton échange **1 mois de Squiduuverse** a été livré.');

    // Livraison automatique par l'API Squiduuverse (+1 mois au compte de cet e-mail)
    const calls: Array<{ auth: string; body: Record<string, unknown> }> = [];
    const answers: Array<[number, unknown]> = [[404, { error: 'user_not_found' }], [200, { ok: true }]];
    const api = new EmailGrantClient('https://squiduuverse.test/', ' Bearer cle ', (async (_url: string, init: RequestInit) => {
      calls.push({ auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
      const [status, body] = answers.shift()!;
      return Response.json(body, { status });
    }) as typeof fetch);
    const pending = fans.fans.orders({ status: 'pending' })[0]!;
    expect(await deliverEmailOrders(api, fans.fans, now)).toEqual({ livrées: 0, échecs: 1 });
    expect(calls[0]).toEqual({ auth: 'Bearer cle', body: { email: 'lea@mail.com', months: 1, orderId: `order-${pending.id}-${pending.createdAt}` } });
    expect(fans.fans.order(pending.id)!.deliveryError).toMatch(/Aucun compte/);
    expect(await deliverEmailOrders(api, fans.fans, now + 1000)).toEqual({ livrées: 0, échecs: 0 }); // attend 6 h
    expect(await deliverEmailOrders(api, fans.fans, now + 7 * HOUR)).toEqual({ livrées: 1, échecs: 0 });
    expect(calls[1]!.body.orderId).toBe(calls[0]!.body.orderId);
    expect(fans.fans.order(pending.id)!.status).toBe('delivered');
    expect(monthsOf('squiduuverse-3m')).toBe(3);

    const app = createApp({ repo, agency, recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency), fans, bot: {} });
    const html = await (await app.request('/fan')).text();
    expect(html).toContain('<title>SQUIDUU</title>');
    expect(html).toContain('--accent:#FCD005');
    expect(html).toContain('Montserrat');
    expect(html).not.toMatch(/roblox|gamepass|beone/i);
  });

  it('refuse un créateur inconnu', () => {
    expect(() => creatorConfig('inconnu')).toThrow(/inconnu/);
    expect(creatorConfig(undefined).id).toBe('beone');
  });

  it('Mickaël Wu : vrai site = la maquette, avec sa chaîne, le mot-clé #micka et son Discord', async () => {
    const { soberPage } = await import('../src/web/sober.js');
    const { readFileSync } = await import('node:fs');
    const cr = creatorConfig('micka');
    expect(cr.youtube.split(',')).toEqual(['mickaelwu', 'mickaelwubusiness', 'MickaëlWuAccompagnement']);
    expect(cr.clipKeywords).toContain('micka');
    expect(cr.reward?.price).toBe(100_000);
    expect(cr.discord?.welcome).toContain('{creator}');
    const html = soberPage(readFileSync('src/web/app/fan-sober.html', 'utf8'), cr, cr.programName);
    expect(html).toContain('class="rich micka"');
  });
});


describe('serveur fans monté par /setup', () => {
  it('plan : noms uniques, salons de bienvenue / règles / inscription / log présents', async () => {
    const { SERVER_PLAN, LOG_CHANNEL, setupCommand } = await import('../src/bot/fanServer.js');
    const names = SERVER_PLAN.flatMap((g) => g.channels.map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
    for (const key of ['bienvenue', 'règles', 'inscription']) expect(names.some((n) => n.includes(key))).toBe(true);
    expect(names).toContain(LOG_CHANNEL);
    expect(SERVER_PLAN.find((g) => g.channels.some((c) => c.name === LOG_CHANNEL))!.access).toEqual({ who: 'staff' });
    // Parcours : seul #bienvenue est visible à l'arrivée
    const visible = SERVER_PLAN.flatMap((g) => g.channels).filter((c) => c.access.who === 'everyone').map((c) => c.name);
    expect(visible).toEqual(['👋│bienvenue']);
    expect(setupCommand.default_member_permissions).toBe('8');
  });
});

describe('automatisations du serveur', () => {
  it('heure de Paris et classement du lundi', async () => {
    const { parisClock } = await import('../src/bot/fanAutomation.js');
    // Lundi 5 octobre 2026, 10 h 30 à Paris (UTC+2)
    expect(parisClock(Date.UTC(2026, 9, 5, 8, 30))).toEqual({ weekday: 1, hour: 10, day: '2026-10-05' });
    expect(parisClock(Date.UTC(2026, 9, 5, 7, 30)).hour).toBe(9);
  });

  it('niveaux et top de la semaine des fans', () => {
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('squiduu'));
    fans.bootstrap();
    const now = Date.now();
    const fan = fans.ensureFan('777', 'Léa', now - 3 * HOUR);
    fans.setAccounts(fan, { tiktok: '@lea.clips' });
    const a = repo.listAccountsForClipper(fan.id)[0]!;
    backdate(repo, now - 3 * HOUR);
    repo.recordCollection(a.id, [{ platformVideoId: 'v1', views: 0, publishedAt: now - 2 * HOUR }], now - 2 * HOUR);
    repo.recordCollection(a.id, [{ platformVideoId: 'v1', views: 150_000, publishedAt: now - 2 * HOUR }], now - HOUR);
    expect(fans.fanLevels()).toEqual([{ clipperId: fan.id, discordId: '777', username: 'Léa', views: 150_000, level: 2 }]);
    expect(fans.weeklyTop()[0]).toMatchObject({ rank: 1, discordId: '777', views: 150_000 });
    // Paliers Discord = objets de la boutique (coins gagnés, un achat ne fait pas redescendre)
    expect(fans.fanTiers()[0]!.tier).toBe(-1);
    fans.saveItem(null, { name: 'Gros', price: 5000, kind: 'item', ref: 'b' });
    fans.saveItem(null, { name: 'Petit', price: 1000, kind: 'item', ref: 'a' });
    expect(fans.shopTiers().map((t) => t.name).slice(0, 2)).toEqual(['Petit', 'Gros']);
    expect(fans.fanTiers()[0]).toMatchObject({ discordId: '777', earned: 1500, tier: 0 });
    fans.fans.addBonus(fan.id, 4000);
    expect(fans.fanTiers()[0]!.tier).toBe(1);
    fans.setBotState('x', [1, 2]);
    expect(fans.botState('x', [])).toEqual([1, 2]);
  });
});

describe('serveur des monteurs (/setup-montage)', () => {
  it('4 créateurs, 3 salons par section (annonces et ressource en lecture seule), ressources communes, commande réservée aux admins', async () => {
    const m = await import('../src/bot/montage.js');
    expect(m.MONTAGE_CREATORS).toEqual(['Elie', 'Science', 'Sabrina', 'Adrien']);
    expect(m.CREATOR_CHANNELS.map((c) => [c.name, c.write])).toEqual([
      ['📣annonces', false],
      ['👱ressource', false],
      ['💬général', true],
    ]);
    expect([m.SHARED_CATEGORY, ...m.SHARED_CHANNELS.map((c) => c.name)]).toEqual(['📦 ressources', '📈sop-notion', '🎬sop-monteur', '🎧musiques-sfx']);
    expect(m.creatorRole('Elie')).toBe('✂️ Team Elie');
    expect(m.setupMontageCommand.name).toBe('setup-montage');
    expect(m.setupMontageCommand.default_member_permissions).toBe('8');
    expect(m.setupMontageCommand.options?.map((o) => o.name)).toEqual(['nettoyer']);
  });

  it('nettoyer : supprime les anciens salons et catégories, garde accueil, sections, salons privés et staff', async () => {
    const m = await import('../src/bot/montage.js');
    const { ChannelType, Collection } = await import('discord.js');
    const deleted: string[] = [];
    const ch = (id: string, name: string, type: number, parentId: string | null = null, topic: string | null = null, refuse = false) =>
      [id, { id, name, type, parentId, topic, delete: async () => { if (refuse) throw new Error('refusé'); deleted.push(name); } }] as const;
    const T = ChannelType.GuildText, C = ChannelType.GuildCategory;
    const channels = new Collection<string, any>([
      ch('1', '📌 ACCUEIL', C), ch('2', '👋│bienvenue', T, '1'),
      ch('3', '👱Elie', C), ch('4', '📣annonces', T, '3'), ch('5', '💬général', T, '3'), ch('6', 'random', T, '3'),
      ch('15', '📦 ressources', C), ch('16', '📈sop-notion', T, '15'), ch('17', '🎧musiques-sfx', T, '15'),
      ch('7', '🔒 SALONS PRIVÉS', C), ch('8', '🔒│paul', T, '7', 'Salon privé de Paul [123]'),
      ch('9', '🛡️ STAFF', C), ch('10', '🧾│logs', T, '9'),
      ch('11', 'Salons textuels', C), ch('12', 'général', T, '11'), ch('13', 'Général', ChannelType.GuildVoice, '11'),
      ch('14', 'règles', T, null, null, true),
    ]);
    const guild = { channels: { cache: channels, fetch: async () => channels } } as any;
    const r = await m.cleanMontageServer(guild);
    expect([...deleted].sort()).toEqual(['Général', 'Salons textuels', 'général', 'random'].sort());
    expect(deleted.indexOf('Salons textuels')).toBe(deleted.length - 1); // la catégorie après ses salons
    expect(r).toEqual({ deleted: 4, failed: ['règles'] });
  });
});

describe('parcours complet d’un nouveau clippeur SQUIDUU (réglages par défaut)', () => {
  it('formation → 3 comptes → vérif staff → clip #squiduu → 1er clip → coins → achat validé → livré par e-mail', async () => {
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/', async () => null, creatorConfig('squiduu'));
    const t0 = Date.now();
    fans.bootstrap(t0); // comme au démarrage : agence SQUIDUU, récompense, règle « légende » active
    const s = fans.settings();
    expect(s).toMatchObject({ accountReview: true, orderReview: true, clipRule: true });
    expect(fans.clipKeywords()).toEqual(['squiduu']);

    // 1. Formation : 6 modules à cocher, tout coché → rôle Discord
    const fan = fans.ensureFan('111', 'Paul');
    const trained: string[] = [];
    fans.onTrainingDone = (id) => void trained.push(id);
    const t = fans.training(fan.id);
    expect(t.modules).toHaveLength(6);
    expect(t.modules.every((m) => m.embed?.startsWith('https://www.youtube-nocookie.com/embed/'))).toBe(true);
    for (const m of t.modules) fans.setTrainingStep(fan, m.num, true);
    expect(trained).toEqual(['111']);

    // 2. Inscription : 3 comptes + e-mail → comptes à vérifier, rien ne compte encore
    const res = fans.setAccounts(fan, { tiktok: '@paul.sqd', youtube: '@paulsqd', instagram: '@paul.sqd' });
    expect(res.linked).toHaveLength(3);
    expect(fans.linkEmail(fan, 'paul@mail.com')).toBe('paul@mail.com');
    expect(fans.unverifiedAccounts(fan.id)).toHaveLength(3);
    releve(repo);
    expect(fans.accountsToReview()).toHaveLength(3);

    // 3. Clips : un sans #squiduu, un avec ; relevé après l'inscription
    const tt = repo.listAccountsForClipper(fan.id).find((a) => a.platform === 'tiktok')!;
    const later = Date.now() + 60_000;
    repo.recordCollection(tt.id, [
      { platformVideoId: 'a', views: 2_000_000, publishedAt: later, title: 'Mon clip #squiduu 😂' },
      { platformVideoId: 'b', views: 500_000, publishedAt: later, title: 'clip sans le tag' },
    ], later + 1000);
    fans.checkClips();
    expect(fans.firstClipDone().size).toBe(0); // compte pas encore validé par le staff
    expect(fans.balance(fan.id).earned).toBe(0);

    // 4. Le staff valide les comptes → 1er clip débloqué, seules les vues du clip #squiduu comptent
    for (const a of fans.accountsToReview()) fans.reviewAccount(a.id, true);
    expect([...fans.firstClipDone()]).toEqual(['111']);
    expect(fans.balance(fan.id)).toMatchObject({ views: 2_000_000, earned: 20_000 });
    expect(fans.overview().fans[0]!.refused).toHaveLength(1);
    // Le staff vérifie le clip refusé à la main : il compte, et la revérification ne l'annule pas
    const clipId = fans.overview().fans[0]!.refused[0]!.videoId;
    expect(fans.fans.approveClip(clipId, fans.settings().clientId!)).toBe(true);
    fans.checkClips();
    expect(fans.overview().fans[0]!.refused).toHaveLength(0);
    expect(fans.balance(fan.id).views).toBe(2_500_000);
    expect(fans.fans.approveClip(clipId, 999_999)).toBe(false); // pas un clip de ce créateur

    // 5. Achat → à valider (pas livré) → validé → part à l'API e-mail
    const item = fans.fans.items()[0]!;
    expect(item).toMatchObject({ name: '1 mois de Squiduuverse', price: 10_000 });
    const order = fans.buy(fan, item.id);
    expect(fans.fans.pendingForEmail()).toEqual([]);
    expect(fans.overview().orders[0]!.topClips[0]).toMatchObject({ title: 'Mon clip #squiduu 😂' });
    fans.fans.approve(order.id);
    expect(fans.fans.pendingForEmail().map((o) => o.email)).toEqual(['paul@mail.com']);
    const grant = new EmailGrantClient('https://api.test', 'k', (async () => new Response('{}', { status: 200 })) as never);
    expect(await deliverEmailOrders(grant, fans.fans)).toEqual({ livrées: 1, échecs: 0 });
    expect(fans.balance(fan.id).balance).toBe(15_000); // 25 000 gagnés (dont le clip validé à la main) − 10 000
  });
});

describe('relevé des fans à minuit (heure de Paris)', () => {
  it('parisMidnight : minuit du jour à Paris, été comme hiver', async () => {
    const { parisMidnight } = await import('../src/jobs/collect.js');
    expect(new Date(parisMidnight(Date.parse('2026-10-05T14:30:00Z'))).toISOString()).toBe('2026-10-04T22:00:00.000Z'); // UTC+2
    expect(new Date(parisMidnight(Date.parse('2026-12-05T23:30:00Z'))).toISOString()).toBe('2026-12-05T23:00:00.000Z'); // 00:30 à Paris, UTC+1
    expect(new Date(parisMidnight(Date.parse('2026-12-05T22:59:00Z'))).toISOString()).toBe('2026-12-04T23:00:00.000Z');
  });
});

describe('économie Apify : rythme de relevé des comptes de fans', () => {
  it('jamais relu → tout de suite ; payant : toutes les 2 nuits, inactif 1 fois/semaine, vide toutes les 2 semaines ; gratuit chaque nuit', async () => {
    const { fanAccountDue } = await import('../src/jobs/collect.js');
    const D = 86_400_000;
    const now = Date.parse('2026-10-10T01:00:00Z');
    const since = now - 2 * 3_600_000; // minuit
    const tt = (checkedDaysAgo: number | null) => ({ platform: 'tiktok', lastCheckedAt: checkedDaysAgo === null ? null : now - checkedDaysAgo * D });
    expect(fanAccountDue(tt(null), null, since, now)).toBe(true);
    expect(fanAccountDue(tt(0.01), now - D, since, now)).toBe(false); // déjà relu cette nuit
    expect(fanAccountDue(tt(1), now - D, since, now)).toBe(false); // actif, relu hier : une nuit sur deux
    expect(fanAccountDue(tt(2), now - D, since, now)).toBe(true);
    expect(fanAccountDue(tt(7), null, since, now)).toBe(false); // vide
    expect(fanAccountDue(tt(14), null, since, now)).toBe(true);
    expect(fanAccountDue({ ...tt(5), createdAt: now - 6 * D }, null, since, now)).toBe(true); // vide mais ajouté il y a 6 j : 2 nuits
    expect(fanAccountDue({ ...tt(5), createdAt: now - 60 * D }, null, since, now)).toBe(false); // vide depuis longtemps : 2 semaines
    expect(fanAccountDue(tt(3), now - 20 * D, since, now)).toBe(false); // inactif
    expect(fanAccountDue(tt(7), now - 20 * D, since, now)).toBe(true);
    expect(fanAccountDue(tt(1), null, since, now, true)).toBe(true); // TikTok connecté : gratuit
    expect(fanAccountDue({ platform: 'youtube', lastCheckedAt: now - D }, null, since, now)).toBe(true);
  });
});

describe('TikTok connecté (API officielle gratuite)', () => {
  /** Faux serveur TikTok : jetons, profil, vidéos (2 pages). */
  function fakeTikTok(log: string[]) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      log.push(url.replace('https://open.tiktokapis.com/v2', ''));
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/oauth/token/')) {
        const p = new URLSearchParams(String(init?.body));
        return ok({ open_id: 'op1', access_token: p.get('grant_type') === 'refresh_token' ? 'acc2' : 'acc1', refresh_token: 'ref1', expires_in: 86400, refresh_expires_in: 31536000 });
      }
      if (url.includes('/user/info/')) return ok({ data: { user: { open_id: 'op1', username: 'Paul.SQD', display_name: 'Paul', follower_count: 120 } }, error: { code: 'ok' } });
      if (url.includes('/video/list/')) {
        const cursor = JSON.parse(String(init?.body)).cursor;
        return cursor
          ? ok({ data: { videos: [{ id: 'v2', video_description: 'clip #squiduu', create_time: 1_700_000_100, view_count: 300, share_url: 'https://tiktok.test/v2' }], has_more: false }, error: { code: 'ok' } })
          : ok({ data: { videos: [{ id: 'v1', video_description: 'clip #squiduu', create_time: 1_700_000_000, view_count: 5000, like_count: 10 }], cursor: 99, has_more: true }, error: { code: 'ok' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  }

  it('relais : lune renvoie la connexion TikTok vers le site qui l’a lancée (seulement nos sites)', async () => {
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://lune.test/');
    const app = createApp({ repo, agency, recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency), fans, password: 'secret', bot: {},
      selfUrl: 'https://lune.test', marsSites: [{ name: 'BeOne', url: 'https://lune.test' }, { name: 'Micka', url: 'https://micka.test' }] });
    const b64 = (u: string) => Buffer.from(u).toString('base64url');
    const relay = await app.request(`/fan/tiktok/callback?code=abc&state=xyz.${b64('https://micka.test')}`);
    expect(relay.headers.get('location')).toBe(`https://micka.test/fan/tiktok/callback?code=abc&state=xyz.${b64('https://micka.test')}`);
    // Site inconnu : pas de relais (pas de redirection ouverte)
    expect((await app.request(`/fan/tiktok/callback?code=abc&state=xyz.${b64('https://pirate.test')}`)).headers.get('location')).not.toContain('pirate');
  });

  it('connexion sur le site → compte relié et vérifié, vues lues sans Apify, jeton renouvelé', async () => {
    const { TikTokOfficialFetcher, TikTokTokenStore } = await import('../src/platforms/tiktokOfficial.js');
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/');
    const client = repo.upsertClient({ name: 'SQUIDUU', rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
    fans.saveSettings({ clientId: client.id, accountReview: true });
    const store = new TikTokTokenStore(repo.db);
    fans.officialLogin = { platforms: ['tiktok'], connected: () => store.connected() };
    const fan = fans.ensureFan('d1', 'Paul');
    fans.setAccounts(fan, { tiktok: '@ancien.compte' });

    const log: string[] = [];
    const f = fakeTikTok(log);
    const app = createApp({ repo, agency, recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency), fans, password: 'secret', bot: {},
      tiktokOAuth: { creds: { clientKey: 'ck', clientSecret: 'cs' }, redirectUri: 'https://site.test/fan/tiktok/callback', store, fetchFn: f } });

    // Lien perso depuis Discord → connexion → page d'autorisation TikTok
    expect(fans.toConnect(fan.id)).toEqual(['tiktok']);
    const link = new URL(fans.connectUrl(fan.id));
    const login = await app.request(link.pathname + link.search);
    expect(login.headers.get('location')).toBe('/fan#clipper');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const go = await app.request('/fan/tiktok/connect', { headers: { cookie } });
    const auth = new URL(go.headers.get('location')!);
    expect(auth.origin + auth.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(auth.searchParams.get('scope')).toContain('video.list');
    const state = auth.searchParams.get('state')!;
    const stateCookie = go.headers.get('set-cookie')!.split(';')[0]!;

    // Mauvais state → refusé
    expect((await app.request(`/fan/tiktok/callback?code=c&state=x`, { headers: { cookie: `${cookie}; ${stateCookie}` } })).headers.get('location')).toContain('error=');
    const back = await app.request(`/fan/tiktok/callback?code=c&state=${state}`, { headers: { cookie: `${cookie}; ${stateCookie}` } });
    expect(back.headers.get('location')).toBe('/fan?connected=tiktok#clipper');
    expect(fans.toConnect(fan.id)).toEqual([]);

    const [tt] = repo.listAccountsForClipper(fan.id).filter((a) => a.platform === 'tiktok' && a.active);
    expect(tt).toMatchObject({ handle: 'paul.sqd' });
    expect(tt!.verifiedAt).not.toBeNull(); // la connexion prouve que le compte est à lui
    expect(fans.me(fan).accounts.find((a) => a.platform === 'tiktok')).toMatchObject({ handle: 'paul.sqd', connected: true });

    // Relevé : vidéos lues avec son jeton (2 pages), pas d'Apify
    let now = Date.now();
    const apify = { platform: 'tiktok' as const, fetchAccount: async () => { throw new Error('Apify ne doit pas être appelé'); } };
    const fetcher = new TikTokOfficialFetcher(store, { clientKey: 'ck', clientSecret: 'cs' }, 40, apify, f, () => now);
    const got = await fetcher.fetchAccount({ id: tt!.id, handle: tt!.handle, externalId: null });
    expect(got.videos.map((v) => [v.platformVideoId, v.views, v.title])).toEqual([['v1', 5000, 'clip #squiduu'], ['v2', 300, 'clip #squiduu']]);
    expect(got.followers).toBe(120);

    // Jeton expiré → renouvelé automatiquement
    now += 2 * 86_400_000;
    log.length = 0;
    await fetcher.fetchAccount({ id: tt!.id, handle: tt!.handle, externalId: null });
    expect(log[0]).toBe('/oauth/token/');
    expect(store.get(tt!.id)?.accessToken).toBe('acc2');

    // Compte jamais connecté : Apify en secours, ou erreur claire sans secours
    await expect(fetcher.fetchAccount({ id: 999, handle: 'x', externalId: null })).rejects.toThrow('Apify ne doit pas');
    // Supprimer le clippeur dans Management supprime aussi ses jetons
    repo.deleteClipper(fan.id);
    expect(store.get(tt!.id)).toBeUndefined();
    await expect(new TikTokOfficialFetcher(store, { clientKey: 'ck', clientSecret: 'cs' }, 40, undefined, f).fetchAccount({ id: 999, handle: 'x', externalId: null })).rejects.toThrow('Connecter mon TikTok');

    // Fichier de vérification du site (TikTok), public
    const verified = createApp({ repo, agency, recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency), fans, password: 'secret', bot: {}, siteVerification: { file: 'tiktokAbC123.txt', content: 'tiktok-developers-site-verification=XYZ' } });
    expect(await (await verified.request('/tiktokAbC123.txt')).text()).toBe('tiktok-developers-site-verification=XYZ');

    const { tiktokSiteVerification } = await import('../src/platforms/tiktokOfficial.js');
    expect(tiktokSiteVerification(undefined, 'tiktok-developers-site-verification=gtRi1Z')).toEqual({ file: 'tiktokgtRi1Z.txt', content: 'tiktok-developers-site-verification=gtRi1Z' });
    expect(tiktokSiteVerification(undefined, undefined)).toBeUndefined();

    // Maquette prospect publique
    expect((await app.request('/demo/cubi-game')).status).toBe(200);
    expect((await app.request('/demo/assets/cubi-pdp.png')).headers.get('content-type')).toBe('image/png');
    expect((await app.request('/demo/inconnu')).status).toBe(404);

    // Pages légales publiques (exigées par TikTok)
    expect((await app.request('/legal/privacy')).status).toBe(200);
    expect((await app.request('/legal/terms')).status).toBe(200);
  });
});

describe('Instagram connecté (API officielle gratuite)', () => {
  it('connexion → compte vérifié, reels lus avec leurs vues (photos ignorées), jeton prolongé, compte perso = message clair', async () => {
    const { InstagramOfficialFetcher, InstagramTokenStore } = await import('../src/platforms/instagramOfficial.js');
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/');
    const client = repo.upsertClient({ name: 'Loann', rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
    fans.saveSettings({ clientId: client.id, accountReview: true });
    const store = new InstagramTokenStore(repo.db);
    fans.officialLogin = { platforms: ['instagram'], connected: () => store.connected() };
    const fan = fans.ensureFan('d2', 'Zoé');
    fans.setAccounts(fan, { instagram: '@zoe.clips' });

    let personal = false;
    const log: string[] = [];
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      log.push(url.split('?')[0]!);
      if (url.startsWith('https://api.instagram.com/oauth/access_token')) return ok({ data: [{ access_token: 'short', user_id: 77, permissions: 'instagram_business_basic' }] });
      if (url.startsWith('https://graph.instagram.com/access_token')) return ok({ access_token: 'long1', expires_in: 5_184_000 });
      if (url.startsWith('https://graph.instagram.com/refresh_access_token')) return ok({ access_token: 'long2', expires_in: 5_184_000 });
      if (url.includes('/me?')) return personal ? new Response(JSON.stringify({ error: { message: 'Not a business or creator account' } }), { status: 400 }) : ok({ user_id: '77', username: 'zoe.clips', followers_count: 900 });
      if (url.includes('/me/media')) return ok({ data: [
        { id: 'r1', media_type: 'VIDEO', media_product_type: 'REELS', caption: 'clip #loann', permalink: 'https://instagram.test/r1', timestamp: '2026-10-05T10:00:00+0000', like_count: 12 },
        { id: 'p1', media_type: 'IMAGE', caption: 'photo' },
      ] });
      if (url.includes('/r1/insights')) return url.includes('metric=views') ? ok({ data: [{ name: 'views', values: [{ value: 8200 }] }] }) : ok({ data: [] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const app = createApp({ repo, agency, recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency), fans, password: 'secret', bot: {},
      instagramOAuth: { creds: { appId: 'app', appSecret: 'sec' }, redirectUri: 'https://site.test/fan/instagram/callback', store, fetchFn: f } });
    const link = new URL(fans.connectUrl(fan.id));
    const cookie = (await app.request(link.pathname + link.search)).headers.get('set-cookie')!.split(';')[0]!;
    const connect = async () => {
      const go = await app.request('/fan/instagram/connect', { headers: { cookie } });
      const auth = new URL(go.headers.get('location')!);
      expect(auth.origin + auth.pathname).toBe('https://www.instagram.com/oauth/authorize');
      const st = go.headers.get('set-cookie')!.split(';')[0]!;
      return app.request(`/fan/instagram/callback?code=c&state=${auth.searchParams.get('state')}`, { headers: { cookie: `${cookie}; ${st}` } });
    };

    // Compte perso : message pour passer en créateur
    personal = true;
    expect(decodeURIComponent((await connect()).headers.get('location')!)).toContain('compte créateur');
    personal = false;
    expect((await connect()).headers.get('location')).toBe('/fan?connected=instagram#clipper');

    const ig = repo.listAccountsForClipper(fan.id).find((a) => a.platform === 'instagram' && a.active)!;
    expect(ig.handle).toBe('zoe.clips');
    expect(ig.verifiedAt).not.toBeNull();
    expect(store.get(ig.id)).toMatchObject({ openId: '77', accessToken: 'long1' });

    let now = Date.now();
    const fetcher = new InstagramOfficialFetcher(store, 15, undefined, f, () => now);
    const got = await fetcher.fetchAccount({ id: ig.id, handle: ig.handle, externalId: null });
    expect(got.videos).toEqual([expect.objectContaining({ platformVideoId: 'r1', views: 8200, title: 'clip #loann', likes: 12 })]);
    expect(got.followers).toBe(900);

    // 55 jours plus tard : jeton prolongé tout seul
    now += 55 * 86_400_000;
    await fetcher.fetchAccount({ id: ig.id, handle: ig.handle, externalId: null });
    expect(store.get(ig.id)?.accessToken).toBe('long2');
    await expect(fetcher.fetchAccount({ id: 999, handle: 'x', externalId: null })).rejects.toThrow('Connecter mon Instagram');
  });
});

describe('YouTube connecté (connexion Google gratuite)', () => {
  it('connexion → chaîne vérifiée, jeton révoqué et pas gardé, chaîne sans @ = message clair', async () => {
    const { YouTubeTokenStore } = await import('../src/platforms/youtubeOfficial.js');
    const repo = new Repo(openDatabase(':memory:'));
    const agency = new AgencyService(repo);
    const fans = new FanService(repo, new FanRepo(repo.db), agency, 'https://site.test/');
    const client = repo.upsertClient({ name: 'Loann', rule: { ratePer1kCents: 0, minViews: 0, capCents: null } });
    fans.saveSettings({ clientId: client.id, accountReview: true });
    const store = new YouTubeTokenStore(repo.db);
    fans.officialLogin = { platforms: ['youtube'], connected: () => store.connected() };
    const fan = fans.ensureFan('d3', 'Léo');
    fans.setAccounts(fan, { youtube: '@leo_mal_tape' });
    expect(fans.toConnect(fan.id)).toEqual(['youtube']);

    let customUrl: string | undefined = '@LeoClips';
    const log: string[] = [];
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      log.push(url.split('?')[0]!);
      if (url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'g1', expires_in: 3599 });
      if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) return ok({ items: [{ id: 'UCleo', snippet: customUrl ? { customUrl } : {} }] });
      if (url.startsWith('https://oauth2.googleapis.com/revoke')) return ok({});
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const app = createApp({ repo, agency, recruitment: new RecruitmentService(repo, new RecruitmentRepo(repo.db), agency), fans, password: 'secret', bot: {},
      youtubeOAuth: { creds: { clientId: 'gid', clientSecret: 'gsec' }, redirectUri: 'https://site.test/fan/youtube/callback', store, fetchFn: f } });
    const link = new URL(fans.connectUrl(fan.id));
    const cookie = (await app.request(link.pathname + link.search)).headers.get('set-cookie')!.split(';')[0]!;
    const connect = async () => {
      const go = await app.request('/fan/youtube/connect', { headers: { cookie } });
      const auth = new URL(go.headers.get('location')!);
      expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly');
      const st = go.headers.get('set-cookie')!.split(';')[0]!;
      return app.request(`/fan/youtube/callback?code=c&state=${auth.searchParams.get('state')}`, { headers: { cookie: `${cookie}; ${st}` } });
    };

    // Chaîne sans pseudo @ : message pour en créer un
    customUrl = undefined;
    expect(decodeURIComponent((await connect()).headers.get('location')!)).toContain('pseudo @');
    expect(log).toContain('https://oauth2.googleapis.com/revoke');
    customUrl = '@LeoClips';
    expect((await connect()).headers.get('location')).toBe('/fan?connected=youtube#clipper');

    const yt = repo.listAccountsForClipper(fan.id).find((a) => a.platform === 'youtube' && a.active)!;
    expect(yt.handle).toBe('leoclips');
    expect(yt.verifiedAt).not.toBeNull();
    expect(store.get(yt.id)).toMatchObject({ openId: 'UCleo', accessToken: '', refreshToken: '' });
    expect(fans.toConnect(fan.id)).toEqual([]);
    expect(log.filter((u) => u === 'https://oauth2.googleapis.com/revoke')).toHaveLength(2);
  });
});

describe('coaching des clippeurs (points forts / à travailler)', () => {
  it('compare à l’équipe, repère la meilleure plateforme, la régularité, les clips refusés et les comptes en erreur', async () => {
    const { coaching, median } = await import('../src/domain/coaching.js');
    const now = Date.parse('2026-10-06T20:00:00Z');
    const H = 3_600_000;
    const v = (id: number, platform: 'tiktok' | 'youtube' | 'instagram', views: number, hoursAgo: number) => ({
      id, accountId: 1, clipperId: 1, platform, platformVideoId: String(id), url: `https://x.test/${id}`, title: `clip ${id}`, thumbnailUrl: null, publishedAt: now - hoursAgo * H, views, likes: null, comments: null,
    });
    const mine = [v(1, 'tiktok', 5000, 2), v(2, 'tiktok', 4000, 26), v(3, 'youtube', 300, 50), v(4, 'youtube', 200, 74)];
    const team = [...mine, ...Array.from({ length: 10 }, (_, i) => v(100 + i, 'tiktok', 1000, 10 + i))];
    expect(median([1, 3, 2])).toBe(2);
    const c = coaching(mine, team, { postsPerDay: 2, now, refusedClips: 2, tag: '#beone', accountErrors: ['@x (instagram) : introuvable'] });
    const titles = c.points.map((p) => p.title);
    expect(titles).toContain('TikTok marche le mieux');
    expect(titles).toContain('Pas assez régulier');
    expect(titles).toContain('Clips sans le #tag');
    expect(titles).toContain('Compte non relevé');
    expect(titles).toContain('Plateforme pas exploitée'); // pas d'Insta
    expect(c.points[0]!.level).toBe('warn'); // à travailler d'abord
    expect(c.best).toMatchObject({ views: 5000 });
    expect(c.worst).toMatchObject({ views: 200 });
    expect(coaching([], team, { postsPerDay: 2, now }).points[0]!.title).toBe('Aucun clip sur 30 jours');
  });
});
