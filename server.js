// StandHub server. Запуск: npm start
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SITE_URL = process.env.SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT);
const PENDING_TTL = 24 * 3600e3; // неподтверждённые аккаунты живут 24 часа

// ---------- хранилище ----------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let db = { users: [], matches: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const sessions = new Map(); // token -> userId

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, stored) => { const [salt] = stored.split(':'); return hash(pw, salt) === stored; };
const pub = u => u && ({ nick: u.nick, region: u.region, elo: u.elo, matches: u.matches, wins: u.wins,
  kills: u.kills, deaths: u.deaths, assists: u.assists, hsKills: u.hsKills, created: u.created });
const verified = () => db.users.filter(u => u.verified);
function cleanup() { const n = db.users.length; db.users = db.users.filter(u => u.verified || Date.now() - new Date(u.created) < PENDING_TTL); if (db.users.length !== n) save(); }
const newCode = () => { let c; do { c = String(crypto.randomInt(100000, 999999)); } while (db.users.some(u => u.vcode === c)); return c; };
let botUsername = null;
const pendingInfo = u => ({ pending: true, code: u.vcode, bot: botUsername, nick: u.nick, soid: u.soid });

// ---------- онлайн (реальные подключения) ----------
const clients = new Map(); // res -> {visitorId, userId}
const queue = new Set();
function stats() { const v = new Set([...clients.values()].map(c => c.visitorId)); return { online: v.size, searching: queue.size, live: db.matches.filter(m => m.live).length }; }
function broadcast() { const d = `data: ${JSON.stringify(stats())}\n\n`; for (const r of clients.keys()) r.write(d); }
setInterval(() => { for (const r of clients.keys()) r.write(': ping\n\n'); }, 25000);

// ---------- Telegram-бот: проверка ID по скриншоту ----------
let ocrWorker = null;
async function ocr(buf) {
  if (!ocrWorker) { const { createWorker } = require('tesseract.js'); ocrWorker = await createWorker('eng'); }
  const { data } = await ocrWorker.recognize(buf);
  return data.text || '';
}
// ищем ID на скриншоте: убираем пробелы, путаницу O/0 и I/1
function findIds(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    const norm = line.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
    for (const m of norm.match(/\d[\d\s]{3,}\d/g) || []) { const d = m.replace(/\s/g, ''); if (d.length >= 5 && d.length <= 12) ids.add(d); }
  }
  return [...ids];
}
const tg = (method, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const escH = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function linkChat(chatId, code) {
  cleanup();
  const u = db.users.find(x => x.vcode === code);
  if (!u) return say(chatId, '❌ Код не найден или устарел. Зарегистрируйтесь на сайте заново:\n' + SITE_URL + '/#/register');
  if (u.verified) return say(chatId, `✅ Аккаунт <b>${escH(u.nick)}</b> уже подтверждён. Можно входить на сайт:\n${SITE_URL}/#/login`);
  u.tgChat = chatId; save();
  return say(chatId, `👋 Аккаунт <b>${escH(u.nick)}</b> найден.\n\nТеперь пришлите <b>скриншот своего профиля в StandLeo</b>, где виден ваш ID.\nНа сайте вы указали ID: <code>${escH(u.soid)}</code>`);
}
async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const u = db.users.find(x => x.tgChat === chatId && !x.verified);
  if (!u) return say(chatId, 'Сначала зарегистрируйтесь на сайте и нажмите кнопку «Открыть бота» на странице подтверждения, или пришлите сюда 6-значный код с сайта.\n' + SITE_URL + '/#/register');
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  await say(chatId, '🔍 Проверяю скриншот…');
  try {
    const f = await tg('getFile', { file_id: fileId });
    const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`)).arrayBuffer());
    const ids = findIds(await ocr(buf));
    if (ids.includes(u.soid)) {
      const taken = verified().find(x => x.soid === u.soid);
      if (taken) return say(chatId, '❌ Этот игровой ID уже подтверждён другим аккаунтом StandHub. Если это ошибка — напишите в поддержку.');
      u.verified = true; u.tgId = msg.from.id; u.vcode = null;
      db.users = db.users.filter(x => x === u || x.verified || (x.soid !== u.soid && x.nick.toLowerCase() !== u.nick.toLowerCase() && x.email !== u.email));
      save();
      return say(chatId, `✅ <b>Всё верно!</b> ID <code>${escH(u.soid)}</code> совпадает.\n\nАккаунт <b>${escH(u.nick)}</b> подтверждён — теперь можно войти на сайт:\n${SITE_URL}/#/login`);
    }
    return say(chatId, ids.length
      ? `❌ ID не совпадает.\nНа скриншоте найдено: <code>${ids.map(escH).join(', ')}</code>\nНа сайте указано: <code>${escH(u.soid)}</code>\n\nПроверьте ID или пришлите другой скриншот.`
      : '❌ Не получилось найти ID на скриншоте. Пришлите чёткий скриншот профиля целиком, без обрезки, чтобы ID было хорошо видно.');
  } catch (e) { console.error('OCR error', e); return say(chatId, '⚠️ Не удалось обработать картинку, попробуйте ещё раз.'); }
}
async function onUpdate(upd) {
  const msg = upd.message; if (!msg || msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();
  if (msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || ''))) return handlePhoto(msg);
  const m = text.match(/^\/start\s+(\d{6})$/) || text.match(/^(\d{6})$/);
  if (m) return linkChat(msg.chat.id, m[1]);
  return say(msg.chat.id, `Привет! Это бот подтверждения аккаунтов <b>StandHub</b>.\n\n1. Зарегистрируйтесь на сайте: ${SITE_URL}/#/register\n2. Нажмите «Открыть бота» или пришлите сюда 6-значный код с сайта\n3. Пришлите скриншот профиля StandLeo с вашим ID`);
}
async function startBot() {
  if (!TG_TOKEN) return console.log('TELEGRAM_BOT_TOKEN не задан — бот выключен');
  const me = await tg('getMe', {}); if (!me.ok) return console.error('Бот: неверный токен', me);
  botUsername = me.result.username; console.log('Бот запущен: @' + botUsername);
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

// ---------- http ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const authUser = req => { const t = (req.headers.authorization || '').replace('Bearer ', ''); const id = sessions.get(t); return db.users.find(u => u.id === id && u.verified); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const userId = sessions.get(url.searchParams.get('token')) || null;
    clients.set(res, { visitorId: url.searchParams.get('vid') || crypto.randomUUID(), userId }); broadcast();
    req.on('close', () => { clients.delete(res); if (userId && ![...clients.values()].some(c => c.userId === userId)) queue.delete(userId); broadcast(); });
    return;
  }
  if (p === '/api/stats') return send(res, 200, stats());

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
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, u.id);
    return send(res, 200, { token, user: pub(u) });
  }
  if (p === '/api/me') { const u = authUser(req); return u ? send(res, 200, pub(u)) : send(res, 401, { error: 'Не авторизован' }); }
  if (p === '/api/logout' && req.method === 'POST') { const t = (req.headers.authorization || '').replace('Bearer ', ''); queue.delete(sessions.get(t)); sessions.delete(t); broadcast(); return send(res, 200, { ok: true }); }

  if (p === '/api/leaderboard') return send(res, 200, verified().filter(u => u.matches > 0).sort((a, b) => b.elo - a.elo).map(pub));
  if (p.startsWith('/api/player/')) { const n = decodeURIComponent(p.slice(12)).toLowerCase(); const u = verified().find(x => x.nick.toLowerCase() === n); return u ? send(res, 200, pub(u)) : send(res, 404, { error: 'Игрок не найден' }); }
  if (p === '/api/search') { const q = (url.searchParams.get('q') || '').toLowerCase(); return send(res, 200, verified().filter(u => u.nick.toLowerCase().includes(q)).slice(0, 10).map(pub)); }
  if (p === '/api/matches') { const n = (url.searchParams.get('player') || '').toLowerCase(); return send(res, 200, db.matches.filter(m => !n || m.players.some(x => x.nick.toLowerCase() === n))); }
  if (p.startsWith('/api/match/')) { const m = db.matches.find(x => x.id === p.slice(11)); return m ? send(res, 200, m) : send(res, 404, { error: 'Матч не найден' }); }

  if (p === '/api/queue/join' && req.method === 'POST') { const u = authUser(req); if (!u) return send(res, 401, {}); queue.add(u.id); broadcast(); return send(res, 200, stats()); }
  if (p === '/api/queue/leave' && req.method === 'POST') { const u = authUser(req); if (u) queue.delete(u.id); broadcast(); return send(res, 200, stats()); }

  let f = path.join(PUB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`StandHub запущен: ${SITE_URL}`));
