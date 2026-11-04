// cup.js — турнир «Кубок открытия»: плашка на сайте, регистрация команд в отдельном Telegram-боте,
// анонс в Telegram-канал и напоминание за час до старта. Всё настраивается в «Админ» → «Турнир».
// Как регистрируется команда: капитан собирает на сайте пати из 5 человек (друзья сами принимают приглашение —
// значит, все согласны), пишет боту «Зарегистрировать команду» и название. Бот находит аккаунт капитана
// по Telegram (тот же, что при подтверждении аккаунта) и записывает состав пати.
// Токен бота админ вставляет в админке (или переменная CUP_BOT_TOKEN в Railway) — перезапуск не нужен.
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR, MSK = 3 * HOUR;
const TEAM = 5;                 // игроков в команде
const SHOW_AFTER = 6 * HOUR;    // сколько после старта плашка показывает «Турнир идёт»
const REMIND = HOUR;            // напоминание командам — за час до старта
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const B_REG = '📝 Зарегистрировать команду', B_TEAM = '👥 Моя команда', B_INFO = 'ℹ️ О турнире';
const KB = { keyboard: [[{ text: B_REG }], [{ text: B_TEAM }, { text: B_INFO }]], resize_keyboard: true, is_persistent: true };
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N} _.!-]*$/u;
const pad = n => String(n).padStart(2, '0');
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lc = s => (/^[А-ЯЁA-Z][а-яёa-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s); // «Промокоды…» → «промокоды…» посреди фразы
const dot = s => (/[.!?…]$/.test(s) ? s : s + '.');
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
// ближайшая суббота, 19:00 по Москве
function nextSat(now = Date.now()) {
  const d = new Date(now + MSK);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (6 - d.getUTCDay() + 7) % 7, 19) - MSK;
  if (t <= now) t += 7 * DAY;
  return t;
}
// «Суббота, 7 ноября · 19:00 МСК»
const when = t => { const d = new Date(t + MSK), w = DAYS[d.getUTCDay()]; return `${w[0].toUpperCase() + w.slice(1)}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} МСК`; };
const hhmm = t => { const d = new Date(t + MSK); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
// @канал или числовой id; '' — не задан; null — неверный формат
const cleanCh = s => {
  s = String(s || '').trim().replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, '').replace(/[/?#].*$/, '');
  if (!s) return '';
  if (/^-100\d{5,15}$/.test(s)) return s;
  s = s.replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? '@' + s : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs'), path = require('path');
// картинка анонса по умолчанию — «Кубок открытия» 1280×720; админ может загрузить свою
const DEF_IMG = path.join(__dirname, 'assets', 'cup-open.jpg'), DEF_V = 'd1';
let defBuf = null;
const defImg = () => { if (!defBuf) { try { defBuf = fs.readFileSync(DEF_IMG); } catch { defBuf = Buffer.alloc(0); } } return defBuf; };
// ошибки доступа к каналу — с ними картинку не обойти, публиковать текстом бесполезно
const ACCESS_ERR = /chat not found|rights|not a member|forbidden|administrator|admin_required|kicked|not enough/i;

module.exports = function ({ db, save, sendTo, sendAll, tell, alertAdmins, escH, siteUrl, partyOf, mainBot = () => null, envToken = '', mainToken = '' }) {
  const C = db.cup = db.cup || {};
  C.cfg = { on: true, reg: true, title: 'Кубок открытия', start: nextSat(), prize: 'Промокоды на голду', desc: 'Собери пати из пяти человек, регистрация в нашем Telegram', max: 16, channel: '', chNew: false, pic: true, ...(C.cfg || {}) };
  C.teams = C.teams || [];
  C.seq = Math.max(C.seq || 0, ...C.teams.map(t => t.n || 0));
  const cfg = C.cfg;
  const user = id => db.users.find(u => u.id === id);
  const nick = id => (user(id) || { nick: '?' }).nick;
  const teamOf = uid => C.teams.find(t => t.members.includes(uid)) || null;
  // аккаунты StandHub этого человека в Telegram (подтверждённые через основного бота)
  const accts = from => db.users.filter(u => u.verified && from && (u.tgId === from.id || u.tgChat === from.id));
  const siteA = (p = '') => `<a href="${siteUrl}${p}">StandHub</a>`;
  const vb = () => (mainBot() ? '@' + mainBot() : 'боте StandHub');
  const phase = (now = Date.now()) => !cfg.on ? 'off' : now >= cfg.start ? (now < cfg.start + SHOW_AFTER ? 'live' : 'off')
    : C.teams.length >= cfg.max ? 'full' : cfg.reg ? 'open' : 'closed';
  const wait = new Map(); // чат → { uid, at }: ждём название команды

  // ---------- Telegram: свой бот, отдельный от бота подтверждения ----------
  let bot = null, botErr = null, gen = 0, ctl = null;
  const token = () => C.token || envToken || '';
  const call = (tok, method, body = {}, signal) => fetch(`https://api.telegram.org/bot${tok}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }).then(r => r.json());
  const tg = (method, body) => (bot ? call(token(), method, body).catch(() => ({ ok: false })) : Promise.resolve({ ok: false, description: 'бот не подключён' }));
  const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  // текущая картинка анонса: своя (из админки) или стандартная
  let cImg = null; // раскодированная своя картинка (кэш)
  const img = () => {
    if (!(C.img && C.img.data)) return { buf: defImg(), type: 'image/jpeg', v: DEF_V, custom: false };
    const v = 'c' + C.img.v; if (!cImg || cImg.v !== v) cImg = { buf: Buffer.from(C.img.data, 'base64'), type: C.img.type, v, custom: true };
    return cImg;
  };
  // пост с картинкой: первый раз загружаем файл, дальше Telegram помнит его по file_id
  async function sayPic(chat_id, caption, extra = {}) {
    if (!bot) return { ok: false, description: 'бот не подключён' };
    const im = img(); if (!im.buf.length) return { ok: false, description: 'нет картинки' };
    const base = { chat_id: String(chat_id), caption, parse_mode: 'HTML', ...extra };
    let r = null;
    if (C.fid && C.fid.v === im.v) { r = await tg('sendPhoto', { ...base, photo: C.fid.id }); if (r.ok || ACCESS_ERR.test(r.description || '')) return keepFid(r, im); }
    const fd = new FormData();
    for (const [k, v] of Object.entries(base)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    fd.append('photo', new Blob([im.buf], { type: im.type }), im.type === 'image/png' ? 'cup.png' : 'cup.jpg');
    r = await fetch(`https://api.telegram.org/bot${token()}/sendPhoto`, { method: 'POST', body: fd }).then(x => x.json()).catch(() => ({ ok: false }));
    return keepFid(r, im);
  }
  function keepFid(r, im) {
    const ph = r && r.ok && r.result && r.result.photo;
    if (ph && ph.length) { const id = ph[ph.length - 1].file_id; if (!C.fid || C.fid.id !== id || C.fid.v !== im.v) { C.fid = { v: im.v, id }; save(); } }
    return r;
  }
  async function connect(known) {
    const my = ++gen; if (ctl) ctl.abort(); ctl = null; bot = null; botErr = null;
    const tok = token(); if (!tok) return;
    if (mainToken && tok === mainToken) { botErr = 'Это токен основного бота — для турнира нужен отдельный бот'; return; }
    let name = known;
    if (!name) {
      const me = await call(tok, 'getMe').catch(() => null);
      if (my !== gen) return;
      if (!me || !me.ok) { botErr = 'Telegram не принял токен — скопируйте его из @BotFather полностью'; console.error('Бот турнира: неверный токен'); return; }
      name = me.result.username;
    }
    bot = name; console.log('Бот турнира запущен: @' + bot); push();
    call(tok, 'setMyCommands', { commands: [{ command: 'start', description: 'О турнире' }, { command: 'reg', description: 'Зарегистрировать команду' }, { command: 'team', description: 'Моя команда' }] }).catch(() => {});
    // описание «Что умеет бот» — только если его ещё не задали в @BotFather
    call(tok, 'getMyDescription').then(r => { if (r && r.ok && !(r.result && r.result.description)) call(tok, 'setMyDescription', { description: 'Регистрация команд на турниры StandHub — 5 на 5 в StandLeo. Нажмите «Старт», чтобы узнать о ближайшем турнире.' }); }).catch(() => {});
    await call(tok, 'deleteWebhook', {}).catch(() => {});
    let offset = 0;
    while (my === gen) {
      ctl = new AbortController();
      try {
        const r = await call(tok, 'getUpdates', { offset, timeout: 50 }, ctl.signal);
        if (my !== gen) return;
        if (r && r.error_code === 401) { bot = null; botErr = 'Токен больше не действует — создайте новый в @BotFather'; push(); return; }
        if (!r || !r.ok) { await sleep(3000); continue; }
        for (const u of r.result || []) { offset = u.update_id + 1; onUpdate(u).catch(e => console.error('Бот турнира:', e)); }
      } catch (e) { if (my !== gen) return; await sleep(3000); }
    }
  }

  // ---------- состояние для сайта ----------
  const pubState = () => {
    const ph = phase(), left = cfg.max - C.teams.length;
    return { type: 'cup', phase: ph, title: cfg.title, start: cfg.start, until: cfg.start + SHOW_AFTER, prize: cfg.prize, desc: cfg.desc, max: cfg.max,
      left: ph === 'open' && left <= 3 ? left : null, bot, channel: cfg.channel && cfg.channel[0] === '@' ? cfg.channel.slice(1) : null };
  };
  const state = uid => { const t = uid ? teamOf(uid) : null; return { ...pubState(), my: t ? { name: t.name, cap: nick(t.cap), isCap: t.cap === uid, members: t.members.map(nick) } : null }; };
  // всем — общие данные (личное «моя команда» клиент хранит у себя), участникам — вместе с их командой
  function push(uids = []) { sendAll(pubState()); for (const id of new Set(uids)) sendTo(id, state(id)); }

  // ---------- бот: регистрация ----------
  const roster = (ids, cap) => [cap, ...ids.filter(x => x !== cap)].map(id => { const u = user(id); return `${id === cap ? '👑' : '•'} <b>${escH(u ? u.nick : '?')}</b>${u && u.soid ? ` — ID <code>${escH(u.soid)}</code>` : ''}`; }).join('\n');
  const infoText = () => {
    const ph = phase(), left = cfg.max - C.teams.length;
    const st = ph === 'open' ? `✅ Регистрация открыта${left <= 3 ? ` — осталось ${left} ${plural(left, 'место', 'места', 'мест')}` : ''}`
      : ph === 'full' ? '⛔ Все места уже заняты' : ph === 'closed' ? '⛔ Регистрация закрыта' : ph === 'live' ? '🔥 Турнир уже идёт' : '⛔ Сейчас турниров нет — следите за новостями';
    return `🏆 <b>${escH(cfg.title)}</b> — турнир 5 на 5 в StandLeo\n\n📅 ${when(cfg.start)}\n🎁 Призы: ${escH(lc(cfg.prize))}\n👥 Мест: ${cfg.max} ${plural(cfg.max, 'команда', 'команды', 'команд')}\n\n${escH(dot(cfg.desc))}\n\n`
      + `<b>Как зарегистрироваться</b>\n1. У каждого из пятерых — аккаунт на ${siteA('/#/register')}, подтверждённый в ${vb()}\n2. Капитан собирает на сайте пати из 5 человек: «Играть» → «Пригласить» (звать можно друзей с сайта)\n3. Капитан нажимает здесь «${B_REG}» и пишет название команды\n\n${st}`;
  };
  const info = chat => say(chat, infoText(), { reply_markup: KB });
  // можно ли этому человеку сейчас регистрировать команду → { error } или { u, pt }
  function check(from) {
    const ph = phase();
    if (ph !== 'open') return { error: ph === 'full' ? `⛔ Все ${cfg.max} ${plural(cfg.max, 'место', 'места', 'мест')} уже заняты.` : ph === 'closed' ? '⛔ Регистрация на турнир закрыта.' : ph === 'live' ? '⛔ Турнир уже начался — регистрация закрыта.' : '⛔ Сейчас нет турнира, на который можно зарегистрироваться.' };
    const us = accts(from);
    if (!us.length) return { error: `🔎 Не нашли ваш аккаунт StandHub.\n\nЗарегистрируйтесь на сайте ${siteA('/#/register')} и подтвердите аккаунт в ${vb()} — с этого же Telegram. Потом возвращайтесь сюда.` };
    const inT = us.map(u => teamOf(u.id)).find(Boolean);
    if (inT) return { error: `✅ Вы уже в команде <b>«${escH(inT.name)}»</b>. Состав — в «${B_TEAM}».` };
    const u = us.find(x => { const p = partyOf(x.id); return p && p.leader === x.id && p.members.length >= TEAM; }) || us[0];
    const pt = partyOf(u.id);
    if (!pt || pt.members.length < 2) return { error: `👥 Сначала соберите пати из ${TEAM} человек на сайте ${siteA('/#/lobby')}: «Играть» → «Пригласить». Позвать в пати можно друзей с сайта.\n\nСейчас в пати: 1 из ${TEAM}.` };
    if (pt.leader !== u.id) return { error: `👑 Команду регистрирует лидер пати — <b>${escH(nick(pt.leader))}</b>. Попросите его написать этому боту.` };
    if (pt.members.length !== TEAM) return { error: `👥 В пати ${pt.members.length} из ${TEAM} — пригласите ещё ${TEAM - pt.members.length} на сайте ${siteA('/#/lobby')}: «Играть» → «Пригласить».` };
    const busy = pt.members.map(id => [id, teamOf(id)]).filter(x => x[1]);
    if (busy.length) return { error: `⛔ ${busy.map(([id, t]) => `<b>${escH(nick(id))}</b> уже в команде «${escH(t.name)}»`).join(', ')}. Один игрок — одна команда.` };
    return { u, pt };
  }
  async function askName(chat, from) {
    const c = check(from); if (c.error) { wait.delete(chat); return say(chat, c.error, { reply_markup: KB }); }
    wait.set(chat, { uid: c.u.id, at: Date.now() });
    return say(chat, `Пати в сборе:\n${roster(c.pt.members, c.u.id)}\n\n✏️ <b>Как будет называться команда?</b> Напишите название одним сообщением — от 2 до 20 символов.`, { reply_markup: KB });
  }
  async function setName(chat, from, text) {
    const c = check(from); if (c.error) { wait.delete(chat); return say(chat, c.error, { reply_markup: KB }); }
    const name = clean(text);
    if (name.length < 2 || name.length > 20) return say(chat, '✏️ Название — от 2 до 20 символов. Напишите другое:');
    if (!NAME_OK.test(name)) return say(chat, '✏️ В названии можно использовать буквы, цифры, пробел и знаки _ - . ! Напишите другое:');
    if (C.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) return say(chat, `✏️ Команда «${escH(name)}» уже есть. Придумайте другое название:`);
    wait.delete(chat);
    if (from.username && c.u.tgUser !== from.username) c.u.tgUser = from.username;
    const t = { id: require('crypto').randomBytes(5).toString('hex'), n: ++C.seq, name, cap: c.u.id, members: [c.u.id, ...c.pt.members.filter(x => x !== c.u.id)], at: Date.now(), chat };
    C.teams.push(t); save();
    await say(chat, `✅ <b>Команда «${escH(name)}» зарегистрирована</b> на ${escH(cfg.title)}!\n\n${roster(t.members, t.cap)}\n\n📅 Старт: ${when(cfg.start)}\nЗа час до начала пришлём напоминание. Если состав изменится — отмените регистрацию в «${B_TEAM}» и зарегистрируйтесь заново.`, { reply_markup: KB });
    for (const id of t.members) if (id !== t.cap) tell(id, `🏆 <b>${escH(c.u.nick)}</b> записал(а) вас в команду <b>«${escH(name)}»</b> на ${escH(cfg.title)} — турнир 5 на 5.\n📅 ${when(cfg.start)}`);
    alertAdmins(`🏆 Новая команда на ${escH(cfg.title)}: <b>«${escH(name)}»</b> (${C.teams.length} из ${cfg.max})\nКапитан: <b>${escH(c.u.nick)}</b>${c.u.tgUser ? ` (@${escH(c.u.tgUser)})` : ''}\nСостав: ${t.members.map(id => escH(nick(id))).join(', ')}`);
    if (cfg.chNew && cfg.channel) postNew(t);
    push(t.members);
  }
  function showTeam(chat, from) {
    const us = accts(from), t = us.map(u => teamOf(u.id)).find(Boolean);
    if (!t) return say(chat, `Вы пока не в команде.\n\nЧтобы участвовать, капитан собирает на сайте пати из ${TEAM} человек и нажимает здесь «${B_REG}».`, { reply_markup: KB });
    const isCap = us.some(u => u.id === t.cap), canCancel = isCap && Date.now() < cfg.start;
    return say(chat, `👥 <b>Команда «${escH(t.name)}»</b> · ${escH(cfg.title)}\n\n${roster(t.members, t.cap)}\n\n📅 ${when(cfg.start)}${isCap ? '' : `\n\nКапитан — <b>${escH(nick(t.cap))}</b>. Отменить регистрацию может только он.`}`,
      { reply_markup: canCancel ? { inline_keyboard: [[{ text: '❌ Отменить регистрацию', callback_data: 'cup:cancel' }]] } : KB });
  }
  function drop(t) { C.teams = C.teams.filter(x => x !== t); save(); push(t.members); }
  async function onCb(q) {
    tg('answerCallbackQuery', { callback_query_id: q.id });
    const chat = q.message && q.message.chat && q.message.chat.id; if (!chat) return;
    const us = accts(q.from), t = us.map(u => teamOf(u.id)).find(Boolean), cap = t && us.some(u => u.id === t.cap);
    if (q.data === 'cup:cancel') {
      if (!cap) return say(chat, 'Отменить регистрацию может только капитан команды.', { reply_markup: KB });
      return say(chat, `Точно отменить регистрацию команды <b>«${escH(t.name)}»</b>? Место освободится для других команд.`, { reply_markup: { inline_keyboard: [[{ text: 'Да, отменить', callback_data: 'cup:cancel:yes' }, { text: 'Нет', callback_data: 'cup:no' }]] } });
    }
    if (q.data === 'cup:cancel:yes') {
      if (!t) return say(chat, 'Команда не найдена — возможно, регистрацию уже отменили.', { reply_markup: KB });
      if (!cap) return say(chat, 'Отменить регистрацию может только капитан команды.', { reply_markup: KB });
      if (Date.now() >= cfg.start) return say(chat, 'Турнир уже начался — отменить регистрацию нельзя. Напишите организатору.', { reply_markup: KB });
      drop(t);
      await say(chat, `Регистрация команды <b>«${escH(t.name)}»</b> отменена.`, { reply_markup: KB });
      for (const id of t.members) if (id !== t.cap) tell(id, `ℹ️ Капитан <b>${escH(nick(t.cap))}</b> отменил(а) регистрацию команды «${escH(t.name)}» на ${escH(cfg.title)}.`);
      return alertAdmins(`ℹ️ ${escH(cfg.title)}: капитан ${escH(nick(t.cap))} отменил(а) регистрацию команды «${escH(t.name)}». Осталось команд: ${C.teams.length} из ${cfg.max}`);
    }
    if (q.data === 'cup:no') return say(chat, 'Хорошо, регистрация остаётся в силе 👍', { reply_markup: KB });
  }
  // бота добавили в канал (или убрали) — сразу сообщаем админам, первый канал сохраняем сами
  function onMember(u) {
    const ch = u.chat || {}, st = u.new_chat_member || {}; if (ch.type !== 'channel' || !bot) return;
    const id = ch.username ? '@' + ch.username : String(ch.id), title = escH(ch.title || id), where = `«Админ» → «Турнир»`;
    if (st.status === 'administrator') {
      if (!st.can_post_messages) return alertAdmins(`⚠️ Бот турнира @${bot} добавлен в канал «${title}», но без права «Публикация сообщений». Откройте канал → «Администраторы» → @${bot} и включите это право.`);
      let note = '';
      if (!cfg.channel) { cfg.channel = id; save(); note = `\nКанал ${escH(id)} сохранён в ${where}.`; }
      else if (cfg.channel.toLowerCase() !== id.toLowerCase()) note = `\nСейчас для анонсов указан другой канал — ${escH(cfg.channel)}. Чтобы публиковать сюда, впишите ${escH(id)} в ${where}.`;
      return alertAdmins(`✅ Бот турнира @${bot} — администратор канала «${title}». Анонс публикуется кнопкой «Опубликовать анонс в канал» в ${where}.${note}`);
    }
    if (['left', 'kicked', 'member', 'restricted'].includes(st.status) && ['administrator', 'creator'].includes((u.old_chat_member || {}).status)) return alertAdmins(`ℹ️ Бот турнира @${bot} больше не администратор канала «${title}» — анонсы туда не уйдут.`);
  }
  async function onUpdate(upd) {
    if (upd.my_chat_member) return onMember(upd.my_chat_member);
    if (upd.callback_query) return onCb(upd.callback_query);
    const msg = upd.message; if (!msg || !msg.chat || msg.chat.type !== 'private') return;
    const chat = msg.chat.id, from = msg.from || { id: chat }, text = clean(msg.text);
    if (/^\/start\b/i.test(text) || text === B_INFO || /^\/(info|help)\b/i.test(text)) { wait.delete(chat); return info(chat); }
    if (text === B_REG || /^\/reg\b/i.test(text)) return askName(chat, from);
    if (text === B_TEAM || /^\/team\b/i.test(text)) { wait.delete(chat); return showTeam(chat, from); }
    const w = wait.get(chat);
    if (w && Date.now() - w.at < 15 * MIN && text && !text.startsWith('/')) return setName(chat, from, text);
    return say(chat, 'Выберите действие на клавиатуре ниже 👇', { reply_markup: KB });
  }

  // ---------- канал: анонс и новые команды ----------
  const regKb = () => ({ inline_keyboard: [[{ text: '📝 Зарегистрировать команду', url: `https://t.me/${bot}?start=cup` }], [{ text: '🌐 Сайт StandHub', url: siteUrl }]] });
  const annText = () => `🏆 <b>${escH(cfg.title.toUpperCase())}</b>\nТурнир 5 на 5 в StandLeo\n\n📅 ${when(cfg.start)}\n🎁 Призы: ${escH(lc(cfg.prize))}\n👥 Мест: ${cfg.max} ${plural(cfg.max, 'команда', 'команды', 'команд')}\n\n${escH(dot(cfg.desc))}\n\n👇 Регистрация — по кнопке ниже`;
  const tgErr = r => {
    const d = String((r && r.description) || '');
    if (/chat not found/i.test(d)) return 'Канал не найден. Проверьте адрес — например, @standhub';
    if (/rights|not a member|forbidden|administrator|admin_required|kicked/i.test(d)) return `Бот не может публиковать в канале. Добавьте @${bot} в администраторы канала с правом «Публикация сообщений»`;
    return 'Telegram не принял сообщение' + (d ? ': ' + d : '');
  };
  function postNew(t) {
    const left = Math.max(0, cfg.max - C.teams.length);
    say(cfg.channel, `✅ Команда <b>«${escH(t.name)}»</b> зарегистрировалась на ${escH(cfg.title)}!\n📅 ${when(cfg.start)}\n${left ? `👥 Свободно мест: ${left}` : '⛔ Все места заняты'}`, left ? { reply_markup: regKb() } : {})
      .then(r => { if (!r || !r.ok) console.error('Бот турнира: пост в канал не ушёл —', r && r.description); });
  }

  // ---------- напоминание за час до старта ----------
  setInterval(() => {
    const now = Date.now();
    if (!cfg.on || !C.teams.length || C.reminded === cfg.start || now < cfg.start - REMIND || now >= cfg.start) return;
    C.reminded = cfg.start; save();
    const mins = Math.round((cfg.start - now) / MIN), inT = mins >= 50 ? 'Через час' : `Через ${mins} мин`;
    for (const t of C.teams) {
      for (const id of t.members) tell(id, `⏰ ${inT} — старт <b>${escH(cfg.title)}</b>!\nВаша команда: <b>«${escH(t.name)}»</b>. Будьте в игре к ${hhmm(cfg.start)} МСК.`);
      if (t.chat) say(t.chat, `⏰ ${inT} — старт! Капитан, соберите команду «${escH(t.name)}» к ${hhmm(cfg.start)} МСК.`);
    }
  }, 30e3);

  // ---------- админка ----------
  const adminState = () => ({
    cfg: { ...cfg }, phase: phase(), bot, botErr, env: !C.token && !!envToken, main: mainBot(), img: (({ v, custom }) => ({ v, custom }))(img()),
    teams: C.teams.slice().sort((a, b) => a.n - b.n).map(t => ({ id: t.id, n: t.n, name: t.name, at: t.at, cap: nick(t.cap),
      members: t.members.map(id => { const u = user(id) || {}; return { nick: u.nick || '?', soid: u.soid || '', elo: u.elo || 0, tg: u.tgUser || null, cap: id === t.cap }; }) })),
  });
  function setCfg(b) {
    const title = clean(b.title), prize = clean(b.prize), desc = clean(b.desc), start = Number(b.start), max = Number(b.max), ch = cleanCh(b.channel);
    if (title.length < 2 || title.length > 40) return { error: 'Название — от 2 до 40 символов' };
    if (!Number.isFinite(start) || start < Date.now() - 30 * DAY || start > Date.now() + 365 * DAY) return { error: 'Укажите дату и время старта' };
    if (!prize || prize.length > 80) return { error: 'Призы — от 1 до 80 символов' };
    if (!desc || desc.length > 200) return { error: 'Описание — от 1 до 200 символов' };
    if (!Number.isInteger(max) || max < 2 || max > 256) return { error: 'Мест — от 2 до 256 команд' };
    if (ch === null) return { error: 'Канал — в виде @название или ссылка t.me/название' };
    if (start !== cfg.start) C.reminded = 0;
    Object.assign(cfg, { title, start, prize, desc, max, on: !!b.on, reg: !!b.reg, channel: ch, chNew: !!b.chNew, pic: b.pic === undefined ? cfg.pic : !!b.pic });
    save(); push(); return { ok: true };
  }
  async function setBot(raw) {
    const tok = String(raw || '').trim();
    if (!TOKEN_RE.test(tok)) return { error: 'Это не похоже на токен. Он выглядит так: 1234567890:AAH… — скопируйте его из @BotFather' };
    if (mainToken && tok === mainToken) return { error: 'Это токен основного бота. Для турнира создайте отдельного бота в @BotFather' };
    const me = await call(tok, 'getMe').catch(() => null);
    if (!me || !me.ok) return { error: 'Telegram не принял токен — скопируйте его из @BotFather полностью' };
    C.token = tok; save(); connect(me.result.username);
    return { ok: true, bot: me.result.username };
  }
  async function post(chIn) {
    if (chIn !== undefined) { const ch = cleanCh(chIn); if (ch === null) return { error: 'Канал — в виде @название или ссылка t.me/название' }; if (ch !== cfg.channel) { cfg.channel = ch; save(); } }
    if (!bot) return { error: 'Сначала подключите бота турнира' };
    if (!cfg.channel) return { error: 'Укажите канал, например @standhub' };
    let r = cfg.pic ? await sayPic(cfg.channel, annText(), { reply_markup: regKb() }) : null, noPic = false;
    // картинку Telegram не принял (не из-за прав) — всё равно публикуем анонс, только текстом
    if (r && !r.ok && !ACCESS_ERR.test(r.description || '')) { console.error('Бот турнира: картинка не ушла —', r.description); noPic = true; r = null; }
    if (!r) r = await say(cfg.channel, annText(), { reply_markup: regKb() });
    return r && r.ok ? { ok: true, channel: cfg.channel, pic: cfg.pic && !noPic, noPic } : { error: tgErr(r) };
  }
  // своя картинка анонса: JPG или PNG до 1,5 МБ (сайт сам сжимает до 1280 px)
  function setImg(data) {
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) return { error: 'Нужна картинка JPG или PNG' };
    if (m[2].length > 2e6) return { error: 'Картинка слишком большая — до 1,5 МБ' };
    const buf = Buffer.from(m[2], 'base64');
    const real = m[1] === 'jpeg' ? buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff : buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG';
    if (!real || buf.length < 60) return { error: 'Файл повреждён или это не картинка' };
    C.img = { data: m[2], type: 'image/' + m[1], v: Date.now() }; C.fid = null; save();
    return { ok: true };
  }
  async function admin(by, act, b) {
    if (act === 'cfg') return setCfg(b);
    if (act === 'bot') return setBot(b.token);
    if (act === 'botOff') { C.token = null; save(); await connect(); push(); return { ok: true }; }
    if (act === 'post') return post(b.channel);
    if (act === 'img') return setImg(b.data);
    if (act === 'imgReset') { C.img = null; C.fid = null; save(); return { ok: true }; }
    if (act === 'del') {
      const t = C.teams.find(x => x.id === String(b.id || '')); if (!t) return { error: 'Команда не найдена — обновите страницу' };
      drop(t);
      if (t.chat) say(t.chat, `ℹ️ Администратор снял команду «${escH(t.name)}» с турнира ${escH(cfg.title)}. Вопросы — в поддержку на сайте.`, { reply_markup: KB });
      for (const id of t.members) if (id !== t.cap) tell(id, `ℹ️ Команду «${escH(t.name)}» сняли с турнира ${escH(cfg.title)}. Вопросы — в поддержку на сайте.`);
      return { ok: true, name: t.name };
    }
    if (act === 'clear') { const ids = C.teams.flatMap(t => t.members), n = C.teams.length; C.teams = []; C.reminded = 0; save(); push(ids); return { ok: true, n }; }
    return { error: 'Неизвестное действие' };
  }

  connect();
  return { state, adminState, admin, phase, when, nextSat, botName: () => bot, img: () => { const { buf, type, v } = img(); return { buf, type, v }; } };
};
