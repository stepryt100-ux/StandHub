// StandHub server — без зависимостей. Запуск: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');

// ---------- хранилище ----------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let db = { users: [], matches: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const sessions = new Map(); // token -> userId

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, stored) => { const [salt] = stored.split(':'); return hash(pw, salt) === stored; };
const pub = u => u && ({ nick: u.nick, region: u.region, elo: u.elo, matches: u.matches, wins: u.wins,
  kills: u.kills, deaths: u.deaths, assists: u.assists, hsKills: u.hsKills, created: u.created });

// ---------- онлайн (реальные подключения) ----------
const clients = new Map(); // res -> {visitorId, userId}
const queue = new Set();   // userId в поиске
function stats() {
  const visitors = new Set([...clients.values()].map(c => c.visitorId));
  return { online: visitors.size, searching: queue.size, live: db.matches.filter(m => m.live).length };
}
function broadcast() {
  const data = `data: ${JSON.stringify(stats())}\n\n`;
  for (const res of clients.keys()) res.write(data);
}
setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 25000);

// ---------- http ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const authUser = req => { const t = (req.headers.authorization || '').replace('Bearer ', ''); const id = sessions.get(t); return db.users.find(u => u.id === id); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;

  if (p === '/api/events') { // SSE: каждая открытая вкладка = подключение, считаем уникальных посетителей
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const t = url.searchParams.get('token'); const userId = sessions.get(t) || null;
    clients.set(res, { visitorId: url.searchParams.get('vid') || crypto.randomUUID(), userId });
    broadcast();
    req.on('close', () => {
      clients.delete(res);
      if (userId && ![...clients.values()].some(c => c.userId === userId)) queue.delete(userId); // ушёл с сайта — вышел из очереди
      broadcast();
    });
    return;
  }
  if (p === '/api/stats') return send(res, 200, stats());

  if (p === '/api/register' && req.method === 'POST') {
    const b = await body(req); const nick = String(b.nick || '').trim(), email = String(b.email || '').trim().toLowerCase();
    if (nick.length < 3 || nick.length > 20 || !/^[\w.\-]+$/.test(nick)) return send(res, 400, { field: 'nick', error: 'Ник: 3–20 символов, латиница, цифры, _ . -' });
    if (!/^\d{5,12}$/.test(String(b.soid || ''))) return send(res, 400, { field: 'soid', error: 'ID — от 5 до 12 цифр' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { field: 'email', error: 'Введите корректный email' });
    if (String(b.pw || '').length < 6) return send(res, 400, { field: 'pw', error: 'Минимум 6 символов' });
    if (db.users.some(u => u.nick.toLowerCase() === nick.toLowerCase())) return send(res, 409, { field: 'nick', error: 'Этот ник уже занят' });
    if (db.users.some(u => u.email === email)) return send(res, 409, { field: 'email', error: 'Этот email уже зарегистрирован' });
    if (db.users.some(u => u.soid === String(b.soid))) return send(res, 409, { field: 'soid', error: 'Этот игровой ID уже привязан' });
    const u = { id: crypto.randomUUID(), nick, email, soid: String(b.soid), region: ['Европа','СНГ'].includes(b.region) ? b.region : 'Европа', pw: hash(String(b.pw)),
      elo: 1000, matches: 0, wins: 0, kills: 0, deaths: 0, assists: 0, hsKills: 0, created: new Date().toISOString() };
    db.users.push(u); save();
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, u.id);
    return send(res, 200, { token, user: pub(u) });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const b = await body(req); const u = db.users.find(x => x.email === String(b.email || '').trim().toLowerCase());
    if (!u || !check(String(b.pw || ''), u.pw)) return send(res, 401, { field: 'pw', error: 'Неверный email или пароль' });
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, u.id);
    return send(res, 200, { token, user: pub(u) });
  }
  if (p === '/api/me') { const u = authUser(req); return u ? send(res, 200, pub(u)) : send(res, 401, { error: 'Не авторизован' }); }
  if (p === '/api/logout' && req.method === 'POST') { const t = (req.headers.authorization || '').replace('Bearer ', ''); const id = sessions.get(t); sessions.delete(t); queue.delete(id); broadcast(); return send(res, 200, { ok: true }); }

  // рейтинг — только игроки, сыгравшие хотя бы один матч
  if (p === '/api/leaderboard') return send(res, 200, db.users.filter(u => u.matches > 0).sort((a, b) => b.elo - a.elo).map(pub));
  if (p.startsWith('/api/player/')) { const n = decodeURIComponent(p.slice(12)).toLowerCase(); const u = db.users.find(x => x.nick.toLowerCase() === n); return u ? send(res, 200, pub(u)) : send(res, 404, { error: 'Игрок не найден' }); }
  if (p === '/api/search') { const q = (url.searchParams.get('q') || '').toLowerCase(); return send(res, 200, db.users.filter(u => u.nick.toLowerCase().includes(q)).slice(0, 10).map(pub)); }
  if (p === '/api/matches') { const n = (url.searchParams.get('player') || '').toLowerCase(); return send(res, 200, db.matches.filter(m => !n || m.players.some(x => x.nick.toLowerCase() === n))); }
  if (p.startsWith('/api/match/')) { const m = db.matches.find(x => x.id === p.slice(11)); return m ? send(res, 200, m) : send(res, 404, { error: 'Матч не найден' }); }

  // очередь (сам подбор добавим на следующем шаге)
  if (p === '/api/queue/join' && req.method === 'POST') { const u = authUser(req); if (!u) return send(res, 401, {}); queue.add(u.id); broadcast(); return send(res, 200, stats()); }
  if (p === '/api/queue/leave' && req.method === 'POST') { const u = authUser(req); if (u) queue.delete(u.id); broadcast(); return send(res, 200, stats()); }

  // статика
  let f = path.join(PUB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`StandHub запущен: http://localhost:${PORT}`));
