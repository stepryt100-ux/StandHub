// StandHub server. Запуск: npm start
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), 'db.json');
const PUB = path.join(__dirname, 'public');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SITE_URL = process.env.SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT);
const PENDING_TTL = 24 * 3600e3; // неподтверждённые аккаунты живут 24 часа

// ---------- хранилище ----------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let db = { users: [], matches: [], sessions: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
console.log('База:', DB_FILE, '· пользователей:', db.users.length);
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
// сессии хранятся в базе, чтобы не разлогинивало после обновления сайта
const sessions = { get: t => (t ? db.sessions[t] : undefined), set: (t, id) => { db.sessions[t] = id; save(); }, delete: t => { if (db.sessions[t]) { delete db.sessions[t]; save(); } } };

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, stored) => { const [salt] = stored.split(':'); return hash(pw, salt) === stored; };
const pub = u => u && ({ nick: u.nick, region: u.region, elo: u.elo, matches: u.matches, wins: u.wins,
  kills: u.kills, deaths: u.deaths, assists: u.assists, hsKills: u.hsKills, created: u.created, commends: u.commends || 0,
  avatar: u.avatar ? `/api/avatar/${encodeURIComponent(u.nick)}?v=${u.avatarV}` : null });
const verified = () => db.users.filter(u => u.verified);
function cleanup() { const n = db.users.length; db.users = db.users.filter(u => u.verified || Date.now() - new Date(u.created) < PENDING_TTL); if (db.users.length !== n) save(); }
const newCode = () => { let c; do { c = String(crypto.randomInt(100000, 999999)); } while (db.users.some(u => u.vcode === c)); return c; };
let botUsername = null;
const pendingInfo = u => ({ pending: true, code: u.vcode, bot: botUsername, nick: u.nick, soid: u.soid });
// администраторы: ники через запятую в переменной ADMIN_NICKS (в Railway → Variables). По умолчанию — владелец сайта Kartez.
const ADMINS = (process.env.ADMIN_NICKS || 'Kartez').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = u => !!u && ADMINS.includes(u.nick.toLowerCase());
const meOf = u => ({ ...pub(u), email: u.email, admin: isAdmin(u) });

// ---------- онлайн (реальные подключения) ----------
const clients = new Map(); // res -> {visitorId, userId}
let match = null; // модуль матчей (подключается ниже)
const sse = (r, obj) => r.write(`data: ${JSON.stringify(obj)}\n\n`);
const newSession = u => { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, u.id); return t; };
// пароль сменили — выходим из аккаунта на всех устройствах, кроме текущего (keep); открытые вкладки узнают об этом сразу
function dropSessions(uid, keep) {
  for (const [t, id] of Object.entries(db.sessions)) if (id === uid && t !== keep) delete db.sessions[t];
  save();
  for (const [r, c] of clients) if (c.userId === uid && c.token !== keep) { sse(r, { type: 'loggedout', text: 'Пароль от аккаунта изменён — войдите заново' }); c.userId = null; }
}
function stats() { const v = new Set([...clients.values()].map(c => c.visitorId)); return { type: 'stats', online: v.size, searching: match ? match.searching() : 0, modes: match ? match.searchingBy() : {}, live: match ? match.liveCount() : 0 }; }
let bTimer = null; // рассылаем счётчики не чаще раза в 150 мс
function broadcast() { if (bTimer) return; bTimer = setTimeout(() => { bTimer = null; const d = `data: ${JSON.stringify(stats())}\n\n`; for (const r of clients.keys()) r.write(d); }, 150); }
function sendTo(uid, obj) { const d = `data: ${JSON.stringify(obj)}\n\n`; for (const [r, c] of clients) if (c.userId === uid) r.write(d); }
const isOnline = uid => [...clients.values()].some(c => c.userId === uid);
// состояние игрока: поиск, активный матч, запрет поиска (за непринятые матчи или от админа)
const stateOf = uid => { const am = match.matchOf(uid); return { type: 'state', queue: match.queueEntry(uid), match: am ? match.view(am, uid) : null, ban: match.banOf(db.users.find(u => u.id === uid)), misses: match.missCount(uid), now: Date.now() }; };
setInterval(() => { for (const r of clients.keys()) r.write(': ping\n\n'); }, 25000);

// ---------- Telegram-бот: проверка ID по скриншоту ----------
// распознавание текста (eng+rus): скриншот профиля в боте и итоговый экран матча.
// Обработчик создаётся при первой картинке и выгружается после 10 минут простоя, чтобы не занимать память.
const workers = {};
async function ocr(buf, langs = 'eng') {
  let w = workers[langs];
  if (!w) { const { createWorker } = require('tesseract.js'); w = workers[langs] = { p: createWorker(langs).catch(e => { delete workers[langs]; throw e; }) }; }
  clearTimeout(w.t); w.busy = (w.busy || 0) + 1;
  try { const { data } = await (await w.p).recognize(buf); return data.text || ''; }
  finally { w.busy--; w.t = setTimeout(async () => { if (w.busy || workers[langs] !== w) return; delete workers[langs]; try { (await w.p).terminate(); } catch {} }, 10 * 60e3); }
}
// ищем ID на скриншоте: путаница O/0 и I/1; цифры, разбитые пробелами, склеиваем,
// а части проверяем и по отдельности (значок «копировать» рядом с ID иногда читается как лишняя цифра)
function findIds(text) {
  const all = new Set(), shown = new Set();
  for (const line of text.split('\n')) {
    const norm = line.replace(/[OoОо]/g, '0').replace(/[Il|І]/g, '1');
    for (const m of norm.match(/\d[\d\s]*\d|\d/g) || []) {
      const t = m.trim().split(/\s+/), whole = t.join('');
      if (whole.length >= 5 && whole.length <= 12) shown.add(whole);
      for (let i = 0; i < t.length; i++) for (let j = i; j < Math.min(t.length, i + 6); j++) { const d = t.slice(i, j + 1).join(''); if (d.length >= 5 && d.length <= 12) all.add(d); }
    }
  }
  return { all: [...all], shown: [...shown] };
}
// экран «Мой профиль» из StandLeo: ищем надписи, которые есть только на нём (русская и английская версия игры).
// Нужна хотя бы одна надпись «своего» профиля и ещё минимум две с этого экрана — иначе скриншот не подходит.
const PROFILE_OWN = ['МОЙПРОФИЛЬ', 'НАСТРОЙКАПЕРСОНАЖА', 'MYPROFILE', 'CHARACTERSETTINGS', 'CHARACTERCUSTOMIZATION'];
// чужой профиль в игре подписан «Профиль друга» или «Профиль игрока» — такой скриншот не принимаем
const PROFILE_FOREIGN = ['ПРОФИЛЬДРУГА', 'ПРОФИЛЬИГРОКА', 'FRIENDPROFILE', 'FRIENDSPROFILE', 'PLAYERPROFILE'];
const PROFILE_MARKS = ['ПОДРОБНАЯ', 'СТАТИСТИКА', 'ТЕКУЩИЕРАНГИ', 'КАЛИБРОВКА', 'СОЮЗНИКИ', 'СЕЗОН', 'ПРОЦЕНТПОБЕД', 'ПОРАЖЕНИЙ', 'УБИЙСТВ', 'СМЕРТЕЙ', 'ОБЩЕЕВРЕМЯВИГРЕ', 'СЫГРАНОМАТЧЕЙ',
  'DETAILED', 'STATISTICS', 'CURRENTRANKS', 'CALIBRATION', 'SEASON', 'WINRATE', 'LOSSES', 'DEFEATS', 'KILLS', 'DEATHS', 'TIMEINGAME', 'MATCHESPLAYED'];
const LOOK_CYR = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const LOOK_LAT = Object.fromEntries(Object.entries(LOOK_CYR).map(([l, c]) => [c, l]));
const lettersCyr = t => t.toUpperCase().replace(/Ё/g, 'Е').replace(/[ABCEHKMOPTXY]/g, c => LOOK_CYR[c]).replace(/[^А-Я]/g, '');
const lettersLat = t => t.toUpperCase().replace(/[АВСЕНКМОРТХУ]/g, c => LOOK_LAT[c]).replace(/[^A-Z]/g, '');
// есть ли надпись в тексте с учётом ошибок распознавания (1 ошибка на 6+ букв, 2 — на 12+)
function fuzzyHas(s, p, maxK = 2) {
  const k = Math.min(maxK, p.length >= 12 ? 2 : p.length >= 6 ? 1 : 0);
  if (!k) return s.includes(p);
  let prev = Array.from({ length: p.length + 1 }, (_, i) => i);
  for (let j = 0; j < s.length; j++) {
    const cur = [0];
    for (let i = 1; i <= p.length; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (p[i - 1] === s[j] ? 0 : 1));
    if (cur[p.length] <= k) return true;
    prev = cur;
  }
  return false;
}
function profileCheck(text) {
  const c = lettersCyr(text), l = lettersLat(text), has = (p, k) => fuzzyHas(/[А-Я]/.test(p) ? c : l, p, k);
  const foreign = PROFILE_FOREIGN.some(p => has(p, 1)), own = !foreign && PROFILE_OWN.some(p => has(p)), marks = PROFILE_MARKS.filter(p => has(p)).length;
  return { own, foreign, marks, ok: own && marks >= 2 };
}
// подготовка скриншота: верх экрана (там ID) увеличиваем — Telegram сжимает фото, и мелкий ID иначе не читается
let sharp = null;
try { sharp = require('sharp'); sharp.cache(false); sharp.concurrency(1); } catch (e) { console.error('sharp не загрузился — скриншоты распознаются без обработки:', e.message); }
async function profileImages(buf) {
  if (!sharp) return [buf];
  try {
    const { width: W, height: H } = await sharp(buf).metadata();
    if (!W || !H) return [buf];
    const ft = Math.min(3, Math.max(1, 2300 / H)), th = Math.max(1, Math.round(H * 0.4));
    const top = await sharp(buf).extract({ left: 0, top: 0, width: W, height: th }).resize(Math.min(6000, Math.round(W * ft))).grayscale().normalize().png().toBuffer();
    const full = H < 650 ? await sharp(buf).resize(Math.round(W * Math.min(2.5, 1300 / H))).grayscale().normalize().png().toBuffer()
      : H > 1440 ? await sharp(buf).resize({ height: 1440 }).png().toBuffer() : buf;
    return [top, full];
  } catch (e) { console.error('Обработка скриншота:', e.message); return [buf]; }
}
const botBusy = new Set(); // один скриншот за раз от каждого чата
const HOWTO = 'Как сделать правильный:\n1. Откройте в игре свой профиль (вкладка «Общее»)\n2. Сделайте скриншот всего экрана, без обрезки\n3. Пришлите его сюда\n\nНа скриншоте должны быть видны надпись «Мой профиль» и ваш ID.';
const NOT_PROFILE = '❌ Этот скриншот не подходит — это не экран «Мой профиль» из StandLeo.\n\n' + HOWTO;
const FOREIGN_PROFILE = '❌ Это чужой профиль («Профиль друга» или «Профиль игрока»). Подтвердить аккаунт можно только скриншотом своего профиля — экрана «Мой профиль».\n\n' + HOWTO;
const tg = (method, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const escH = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// вместо длинного адреса в сообщениях — слово «StandHub», нажатие открывает сайт
const siteA = (path = '') => `<a href="${SITE_URL}${path}">StandHub</a>`;
const go = path => '👉 ' + siteA(path);

function linkChat(chatId, code) {
  cleanup();
  const u = db.users.find(x => x.vcode === code);
  if (!u) return say(chatId, '❌ Код не найден или устарел. Зарегистрируйтесь на сайте заново:\n' + go('/#/register'));
  if (u.verified) return say(chatId, `✅ Аккаунт <b>${escH(u.nick)}</b> уже подтверждён. Можно входить на сайт:\n${go('/#/login')}`);
  u.tgChat = chatId; save();
  return say(chatId, `👋 Аккаунт <b>${escH(u.nick)}</b> найден.\n\nТеперь пришлите <b>скриншот экрана «Мой профиль» из StandLeo</b> — весь экран, без обрезки, чтобы был виден ваш ID.\nНа сайте вы указали ID: <code>${escH(u.soid)}</code>`);
}
async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const u = db.users.find(x => x.tgChat === chatId && !x.verified);
  const done = !u && verified().find(x => x.tgChat === chatId);
  if (done) return say(chatId, `✅ Аккаунт <b>${escH(done.nick)}</b> уже подтверждён — скриншоты профиля больше не нужны.\n\n${proofs.HINT}\nЗабыли пароль? Отправьте /password`);
  if (!u) return say(chatId, 'Сначала зарегистрируйтесь на сайте и нажмите кнопку «Открыть бота» на странице подтверждения, или пришлите сюда 6-значный код с сайта.\n' + go('/#/register'));
  if (botBusy.has(chatId)) return say(chatId, '⏳ Ещё проверяю предыдущий скриншот — подождите несколько секунд.');
  botBusy.add(chatId);
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  await say(chatId, '🔍 Проверяю скриншот…');
  try {
    const f = await tg('getFile', { file_id: fileId });
    const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`)).arrayBuffer());
    // сначала верх экрана (ID и заголовок), если не хватило — весь экран
    let text = '';
    for (const img of await profileImages(buf)) {
      text += '\n' + await ocr(img, 'eng+rus');
      if (profileCheck(text).ok && findIds(text).all.includes(u.soid)) break;
    }
    const pc = profileCheck(text), ids = findIds(text);
    console.log(`Проверка скриншота ${u.nick}: профиль=${pc.ok} (свой=${pc.own}, чужой=${pc.foreign}, надписей=${pc.marks}), ID найден=${ids.all.includes(u.soid)}`);
    if (pc.foreign) return say(chatId, FOREIGN_PROFILE);
    if (!pc.ok) return say(chatId, NOT_PROFILE);
    if (ids.all.includes(u.soid)) {
      const taken = verified().find(x => x.soid === u.soid);
      if (taken) return say(chatId, '❌ Этот игровой ID уже подтверждён другим аккаунтом StandHub. Если это ошибка — напишите в поддержку.');
      u.verified = true; u.tgId = msg.from.id; u.vcode = null;
      db.users = db.users.filter(x => x === u || x.verified || (x.soid !== u.soid && x.nick.toLowerCase() !== u.nick.toLowerCase() && x.email !== u.email));
      save();
      return say(chatId, `✅ <b>Всё верно!</b> ID <code>${escH(u.soid)}</code> совпадает.\n\nАккаунт <b>${escH(u.nick)}</b> подтверждён — теперь можно войти на сайт:\n${go('/#/login')}`);
    }
    const shown = ids.shown.filter(x => x.length >= 6 && x.length <= 10).slice(0, 3);
    return say(chatId, shown.length
      ? `❌ ID не совпадает.\nНа скриншоте найдено: <code>${shown.map(escH).join(', ')}</code>\nНа сайте указано: <code>${escH(u.soid)}</code>\n\nПроверьте ID или пришлите другой скриншот.`
      : '❌ Экран профиля вижу, но не получилось прочитать ID. Пришлите скриншот в лучшем качестве — например, отправьте его как файл, без сжатия.');
  } catch (e) { console.error('OCR error', e); return say(chatId, '⚠️ Не удалось обработать картинку, попробуйте ещё раз.'); }
  finally { botBusy.delete(chatId); }
}
async function onUpdate(upd) {
  const msg = upd.message; if (!msg || msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();
  // доказательства по матчу: кнопка «Отправить доказательства» на сайте открывает бота с /start proof_<id>
  const pf = text.match(/^\/start\s+proof_([a-f0-9]{4,20})$/i);
  if (pf) return proofs.start(msg.chat.id, pf[1].toLowerCase());
  if (account.isCmd(text)) return account.botReset(msg.chat.id);
  if (await proofs.handle(msg)) return;
  if (msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || ''))) return handlePhoto(msg);
  const m = text.match(/^\/start\s+(\d{6})$/) || text.match(/^(\d{6})$/);
  if (m) return linkChat(msg.chat.id, m[1]);
  const mine = verified().filter(x => x.tgChat === msg.chat.id);
  if (mine.length && !db.users.some(x => !x.verified && x.tgChat === msg.chat.id))
    return say(msg.chat.id, `👋 Это бот <b>StandHub</b>. Аккаунт ${mine.map(x => `<b>${escH(x.nick)}</b>`).join(', ')} подтверждён — сюда приходят уведомления о матчах, друзьях и ответы поддержки.\n\n🔑 Забыли пароль или email? Отправьте /password\n${go('/#/lobby')}`);
  return say(msg.chat.id, `Привет! Это бот подтверждения аккаунтов <b>StandHub</b>.\n\n1. Зарегистрируйтесь на сайте ${siteA('/#/register')}\n2. Нажмите «Открыть бота» или пришлите сюда 6-значный код с сайта\n3. Пришлите скриншот экрана «Мой профиль» из StandLeo — весь экран, чтобы был виден ваш ID`);
}
async function startBot() {
  if (!TG_TOKEN) return console.log('TELEGRAM_BOT_TOKEN не задан — бот выключен');
  const me = await tg('getMe', {}); if (!me.ok) return console.error('Бот: неверный токен', me);
  botUsername = me.result.username; console.log('Бот запущен: @' + botUsername);
  tg('setMyCommands', { commands: [{ command: 'password', description: 'Забыли пароль? Ссылка для нового пароля' }] }).catch(() => {});
  await tg('deleteWebhook', {});
  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50 });
      for (const u of r.result || []) { offset = u.update_id + 1; onUpdate(u).catch(e => console.error(e)); }
    } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  }
}
startBot();
const tgUser = (uid, text) => { const u = db.users.find(x => x.id === uid); if (TG_TOKEN && u && u.tgChat) say(u.tgChat, text).catch(() => {}); };
const adminUsers = () => db.users.filter(u => u.verified && isAdmin(u));
const alertAdmins = text => adminUsers().forEach(u => tgUser(u.id, text));

// ---------- пароль: восстановление через Telegram и смена в профиле ----------
const account = require('./account')({ db, save, hash, check, say, escH, siteUrl: SITE_URL, bot: () => botUsername, newSession, dropSessions, meOf });
// ---------- ежедневные задания и монеты ----------
const tasks = require('./tasks')({ db, save, sendTo });
// ---------- матчи ----------
let party = null; // модуль пати (подключается ниже)
match = require('./match')({ db, save, sendTo, broadcast, siteUrl: SITE_URL, avatarOf: u => pub(u).avatar, tell: tgUser, alertAdmins,
  partyOf: uid => (party ? party.partyOf(uid) : null), isOnline,
  pushState: (uid, extra) => sendTo(uid, { ...stateOf(uid), ...extra }), onPartyChange: pt => party && party.pushParty(pt),
  isAdminId: uid => isAdmin(db.users.find(u => u.id === uid)), adminIds: () => adminUsers().map(u => u.id), onFinish: m => tasks.onFinish(m) });
// ---------- доказательства по матчам: файлы из бота пересылаются администраторам ----------
const proofs = require('./proofs')({ db, tg, say, escH, go, match, isCmd: account.isCmd, adminChats: () => [...new Set(adminUsers().map(u => u.tgChat).filter(Boolean))] });
// ---------- друзья ----------
const friends = require('./friends')({ db, save, sendTo, tell: tgUser, go, pub, isOnline, matchOf: uid => match.matchOf(uid) });
// ---------- пати ----------
party = require('./party')({ db, save, sendTo, tell: tgUser, go, pub, isOnline, match });
// ---------- значки в меню: ответы поддержки, у админа — новые жалобы и обращения ----------
let support = null, feedback = null;
const badges = uid => { const u = db.users.find(x => x.id === uid); return { type: 'badges', sup: support.unread(uid), ...(isAdmin(u) ? { admR: feedback.openCount(), admT: support.waiting() } : {}) }; };
const pushBadges = uid => { for (const id of new Set([uid, ...adminUsers().map(u => u.id)])) if (id && isOnline(id)) sendTo(id, badges(id)); };
// ---------- «Спасибо» и жалобы после матча, поддержка ----------
feedback = require('./feedback')({ db, save, sendTo, tell: tgUser, go, escH, alertAdmins, match, tasks, onChange: () => pushBadges(null) });
support = require('./support')({ db, save, sendTo, tell: tgUser, go, escH, alertAdmins, onChange: uid => pushBadges(uid) });

// ---------- http ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
// тело запроса; слишком большое не читаем дальше и возвращаем { tooBig: true }
const body = (req, max = 8e5) => new Promise(r => { let b = '', big = false; req.on('data', c => { if (big) return; b += c; if (b.length > max) { big = true; b = ''; } }); req.on('end', () => { if (big) return r({ tooBig: true }); try { r(JSON.parse(b || '{}')); } catch { r({}); } }); req.on('error', () => r({})); });
const authUser = req => { const t = (req.headers.authorization || '').replace('Bearer ', ''); const id = sessions.get(t); return db.users.find(u => u.id === id && u.verified); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const userId = sessions.get(url.searchParams.get('token')) || null;
    clients.set(res, { visitorId: url.searchParams.get('vid') || crypto.randomUUID(), userId, token: userId ? url.searchParams.get('token') : null });
    if (userId) { sse(res, party.state(userId)); sse(res, stateOf(userId)); sse(res, friends.state(userId)); sse(res, tasks.state(userId)); sse(res, badges(userId)); party.touch(userId); }
    sse(res, stats()); broadcast();
    // закрыл сайт — через 20 секунд убираем из поиска (если не вернулся); если искало пати — поиск останавливается у всех
    req.on('close', () => {
      clients.delete(res); broadcast(); if (!userId) return;
      party.touch(userId);
      setTimeout(() => { if (isOnline(userId)) return; const u = db.users.find(x => x.id === userId); match.leave(userId, false, `Поиск остановлен: ${u ? u.nick : 'игрок'} ушёл(ла) с сайта`); }, 20000);
    });
    return;
  }
  if (p === '/api/stats') return send(res, 200, stats());
  if (p === '/api/health') return send(res, 200, { ok: true, bot: botUsername, tokenSet: !!TG_TOKEN, disk: !!process.env.RAILWAY_VOLUME_MOUNT_PATH, users: db.users.filter(u => u.verified).length, img: !!sharp });

  if (p === '/api/register' && req.method === 'POST') {
    cleanup();
    const b = await body(req); const nick = String(b.nick || '').trim(), email = String(b.email || '').trim().toLowerCase(), soid = String(b.soid || '').trim();
    if (nick.length < 3 || nick.length > 20 || !/^[\w.\-]+$/.test(nick)) return send(res, 400, { field: 'nick', error: 'Ник: 3–20 символов, латиница, цифры, _ . -' });
    if (!/^\d{5,12}$/.test(soid)) return send(res, 400, { field: 'soid', error: 'ID — от 5 до 12 цифр' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { field: 'email', error: 'Введите корректный email' });
    if (String(b.pw || '').length < 6) return send(res, 400, { field: 'pw', error: 'Минимум 6 символов' });
    if (verified().some(u => u.nick.toLowerCase() === nick.toLowerCase())) return send(res, 409, { field: 'nick', error: 'Этот ник уже занят' });
    if (verified().some(u => u.email === email)) return send(res, 409, { field: 'email', error: 'Этот email уже зарегистрирован' });
    if (verified().some(u => u.soid === soid)) return send(res, 409, { field: 'soid', error: 'Этот игровой ID уже привязан к другому аккаунту' });
    // повторная регистрация того же email до подтверждения — заменяем старую заявку
    db.users = db.users.filter(u => u.verified || u.email !== email);
    const u = { id: crypto.randomUUID(), nick, email, soid, region: ['Европа', 'СНГ'].includes(b.region) ? b.region : 'Европа', pw: hash(String(b.pw)),
      verified: false, vcode: newCode(), tgChat: null, elo: 1000, matches: 0, wins: 0, kills: 0, deaths: 0, assists: 0, hsKills: 0, created: new Date().toISOString() };
    db.users.push(u); save();
    return send(res, 200, pendingInfo(u));
  }
  if (p === '/api/verify-status') {
    const u = db.users.find(x => x.vcode === url.searchParams.get('code'));
    return send(res, 200, u ? { verified: false, bot: botUsername, linked: !!u.tgChat } : { verified: true });
  }
  if (p === '/api/login' && req.method === 'POST') {
    cleanup();
    const b = await body(req); const email = String(b.email || '').trim().toLowerCase();
    const u = db.users.find(x => x.email === email && x.verified) || db.users.find(x => x.email === email);
    if (!u || !check(String(b.pw || ''), u.pw)) return send(res, 401, { field: 'pw', error: 'Неверный email или пароль' });
    if (!u.verified) return send(res, 403, { ...pendingInfo(u), error: 'Аккаунт ещё не подтверждён' });
    return send(res, 200, { token: newSession(u), user: meOf(u) });
  }
  // ---------- восстановление и смена пароля ----------
  if (p === '/api/forgot' && req.method === 'POST') { const { status, ...r } = await account.forgot((await body(req, 2e3)).login); return send(res, status || 200, r); }
  if (p === '/api/reset/check') { const r = account.checkToken(url.searchParams.get('token')); return send(res, r.error ? 400 : 200, r); }
  if (p === '/api/reset' && req.method === 'POST') { const r = account.reset(await body(req, 2e3)); return send(res, r.error ? 400 : 200, r); }
  if (p === '/api/password' && req.method === 'POST') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    const r = account.change(u, await body(req, 2e3), (req.headers.authorization || '').replace('Bearer ', '')); return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/admin/reset-link' && req.method === 'POST') {
    const u = authUser(req); if (!isAdmin(u)) return send(res, 403, { error: 'Только для администратора' });
    const r = account.adminLink((await body(req, 2e3)).nick); return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/me') { const u = authUser(req); return u ? send(res, 200, meOf(u)) : send(res, 401, { error: 'Не авторизован' }); }
  if (p === '/api/me/state') { const u = authUser(req); return u ? send(res, 200, stateOf(u.id)) : send(res, 401, { error: 'Не авторизован' }); }
  if (p === '/api/logout' && req.method === 'POST') { const t = (req.headers.authorization || '').replace('Bearer ', ''); const id = sessions.get(t); if (id) match.leave(id); sessions.delete(t); return send(res, 200, { ok: true }); }

  if (p === '/api/avatar' && req.method === 'POST') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String((await body(req)).image || ''));
    if (!m) return send(res, 400, { error: 'Неверный формат картинки' });
    if (m[2].length > 700000) return send(res, 400, { error: 'Картинка слишком большая' });
    u.avatar = m[2]; u.avatarType = 'image/' + m[1]; u.avatarV = Date.now(); save();
    return send(res, 200, meOf(u));
  }
  if (p.startsWith('/api/avatar/')) {
    const n = decodeURIComponent(p.slice(12)).toLowerCase(); const u = verified().find(x => x.nick.toLowerCase() === n);
    if (!u || !u.avatar) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.avatarType, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(Buffer.from(u.avatar, 'base64'));
  }
  if (p === '/api/leaderboard') return send(res, 200, verified().filter(u => u.matches > 0).sort((a, b) => b.elo - a.elo).map(pub));
  if (p.startsWith('/api/player/')) { const n = decodeURIComponent(p.slice(12)).toLowerCase(); const u = verified().find(x => x.nick.toLowerCase() === n); return u ? send(res, 200, pub(u)) : send(res, 404, { error: 'Игрок не найден' }); }
  if (p === '/api/search') { const q = (url.searchParams.get('q') || '').toLowerCase(); return send(res, 200, verified().filter(u => u.nick.toLowerCase().includes(q)).slice(0, 10).map(pub)); }
  // ---------- матчи ----------
  if (p === '/api/matches') { const n = (url.searchParams.get('player') || '').toLowerCase(); return send(res, 200, match.history(n || null, isAdmin(authUser(req)))); }
  const mm = p.match(/^\/api\/match\/([a-f0-9]+)(?:\/(accept|decline|ban|claim|confirm|agree|dispute|cancel|chat|commend|flag))?$/);
  if (mm) {
    const m = match.find(mm[1]); if (!m) return send(res, 404, { error: 'Матч не найден' });
    const u = authUser(req);
    if (!mm[2]) return send(res, 200, match.view(m, u && u.id));
    // чат матча: GET — сообщения, POST — отправить
    if (mm[2] === 'chat') {
      if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
      if (req.method !== 'POST') { const r = match.chatList(m.id, u.id); return send(res, r.error ? 403 : 200, r); }
      const b = await body(req, 4e3); const r = match.chatSend(m.id, u, b.text, String(b.ch || 'all'));
      return send(res, r.error ? 400 : 200, r);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Нужен POST' });
    if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    const b = await body(req, 2e4);
    let r = { ok: true };
    if (mm[2] === 'accept') match.accept(m.id, u.id);
    else if (mm[2] === 'decline') match.decline(m.id, u.id);
    else if (mm[2] === 'ban') r = match.ban(m.id, u.id, String(b.map || ''));
    else if (mm[2] === 'claim' || mm[2] === 'confirm') r = match.claim(m.id, u.id, String(b.result || '')); // confirm — старое название
    else if (mm[2] === 'agree') r = match.agree(m.id, u.id);
    else if (mm[2] === 'dispute') r = match.dispute(m.id, u.id, String(b.says || ''), b.text);
    else if (mm[2] === 'cancel') r = match.voteCancel(m.id, u.id);
    else if (mm[2] === 'commend') r = feedback.commend(u, m.id, b.nick);
    else if (mm[2] === 'flag') r = feedback.flag(u, m.id, b.nick, String(b.reason || ''), b.text);
    return send(res, r.error ? 400 : 200, { ...r, match: match.view(match.find(m.id), u.id) });
  }
  if (p === '/api/friends' || p.startsWith('/api/friends/')) {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    if (p === '/api/friends') return send(res, 200, friends.state(u.id));
    if (req.method !== 'POST') return send(res, 405, { error: 'Неверный запрос' });
    const b = await body(req, 2e3), act = p.slice(13), id = String(b.id || '');
    const r = act === 'request' ? friends.request(u, b.nick || b.q) : act === 'accept' ? friends.accept(u, id) : act === 'decline' ? friends.decline(u, id)
      : act === 'cancel' ? friends.cancel(u, id) : act === 'remove' ? friends.remove(u, b.nick) : { error: 'Неизвестное действие' };
    return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/party' || p.startsWith('/api/party/')) {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    if (p === '/api/party') return send(res, 200, party.state(u.id));
    if (req.method !== 'POST') return send(res, 405, { error: 'Неверный запрос' });
    const b = await body(req, 2e3), act = p.slice(11), id = String(b.id || '');
    const r = act === 'invite' ? party.invite(u, b.nick, String(b.mode || '')) : act === 'accept' ? party.accept(u, id) : act === 'decline' ? party.decline(u, id)
      : act === 'cancel' ? party.cancel(u, id) : act === 'leave' ? party.leave(u) : act === 'kick' ? party.kick(u, b.nick)
      : act === 'mode' ? party.setMode(u, String(b.mode || '')) : { error: 'Неизвестное действие' };
    return send(res, r.error ? 400 : 200, { ...r, state: party.state(u.id) });
  }
  // ---------- задания ----------
  if (p === '/api/tasks' || p === '/api/tasks/claim') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    if (p === '/api/tasks') return send(res, 200, tasks.state(u.id));
    if (req.method !== 'POST') return send(res, 405, { error: 'Нужен POST' });
    const r = tasks.claim(u, String((await body(req, 2e3)).id || ''));
    return send(res, r.error ? 400 : 200, { ...r, state: tasks.state(u.id) });
  }
  // ---------- поддержка ----------
  if (p === '/api/support' || p.startsWith('/api/support/')) {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    if (p === '/api/support') return send(res, 200, { list: support.mine(u.id) });
    if (req.method !== 'POST') return send(res, 405, { error: 'Нужен POST' });
    const b = await body(req, 2e4), act = p.slice(13), id = String(b.id || '');
    const r = act === 'new' ? support.create(u, String(b.topic || ''), b.text, b.mid) : act === 'reply' ? support.reply(u, id, b.text)
      : act === 'close' ? support.closeMine(u, id) : act === 'seen' ? support.seen(u) : { error: 'Неизвестное действие' };
    return send(res, r.error ? 400 : 200, { ...r, list: support.mine(u.id) });
  }
  // ---------- админка: жалобы и обращения ----------
  if (p === '/api/admin/reports' || p === '/api/admin/tickets') {
    const u = authUser(req); if (!isAdmin(u)) return send(res, 403, { error: 'Только для администратора' });
    return send(res, 200, p === '/api/admin/reports' ? feedback.adminList() : support.adminList());
  }
  const ar = p.match(/^\/api\/admin\/(report|ticket)\/([a-f0-9]+)$/);
  if (ar && req.method === 'POST') {
    const u = authUser(req); if (!isAdmin(u)) return send(res, 403, { error: 'Только для администратора' });
    const b = await body(req, 2e4), act = String(b.act || '');
    const r = ar[1] === 'report' ? feedback.adminAct(ar[2], act) : act === 'reply' ? support.adminReply(ar[2], b.text) : act === 'close' ? support.adminClose(ar[2]) : { error: 'Неизвестное действие' };
    return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/queue/join' && req.method === 'POST') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Войдите в аккаунт' });
    const r = match.join(u, String((await body(req)).mode || '5v5'));
    return send(res, r.error ? 409 : 200, { ...r, ...stateOf(u.id) });
  }
  if (p === '/api/queue/leave' && req.method === 'POST') { const u = authUser(req); if (u) match.leave(u.id); return send(res, 200, { ok: true }); }
  if (p === '/api/test-match' && req.method === 'POST') {
    const u = authUser(req); if (!isAdmin(u)) return send(res, 403, { error: 'Только для администратора' });
    const r = match.testMatch(u, String((await body(req)).mode || '5v5'));
    return send(res, r.error ? 409 : 200, { ...r, ...stateOf(u.id) });
  }
  if (p === '/api/admin/matches') { const u = authUser(req); if (!isAdmin(u)) return send(res, 403, { error: 'Только для администратора' }); return send(res, 200, match.adminList()); }
  const am = p.match(/^\/api\/admin\/match\/([a-f0-9]+)\/resolve$/);
  if (am && req.method === 'POST') {
    const u = authUser(req); if (!isAdmin(u)) return send(res, 403, { error: 'Только для администратора' });
    const b = await body(req, 2e3), r = match.adminResolve(am[1], String(b.winner || ''), !!b.punish); return send(res, r.error ? 400 : 200, r);
  }

  let f = path.join(PUB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`StandHub запущен: ${SITE_URL}`));
