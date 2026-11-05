// match.js — очередь, «матч найден», команды, вето карт, хост, результат (капитан отмечает — соперники подтверждают или оспаривают), ELO
const crypto = require('crypto');
const MODES = { '5v5': 10, '2v2': 4, '1v1': 2 };
const MODE_NAME = { '5v5': '5 на 5', '2v2': '2 на 2', '1v1': '1 на 1' };
const MAPS = ['Sandstone', 'Rust', 'Province', 'Zone 7', 'Hanami', 'Breeze', 'Dune']; // Sakura убрана (v1.10.1) — её нет в StandLeo
const ACCEPT_SEC = 15, BAN_SEC = 20;
const CLAIM_MIN = 10 * 60e3;           // отметить результат можно через 10 минут после начала игры (тестовые матчи — сразу)
const CLAIM_WAIT = 30 * 60e3;          // соперники могут оспорить результат 30 минут, потом он засчитывается
const REMIND_LEFT = 10 * 60e3;         // за 10 минут до конца — напоминание соперникам
const CAP_REMIND = 60 * 60e3;          // через час игры без результата — напоминание капитанам
const MATCH_TTL = 3 * 3600e3;          // матч без результата отменяется через 3 часа
const FALSE_BAN = 7 * 24 * 3600e3;     // ложный результат или ложный спор — запрет поиска на 7 дней
const CHANGES = 3;                     // капитан может отметить результат максимум 3 раза (2 изменения)
const PROOF_MAX = 10;                  // доказательств от одного игрока по одному матчу
const K = 50;                          // равные команды: +25 / −25
const PREM_HEAD = 120e3;               // Premium: в очереди впереди всех, кто ждёт меньше 2 минут
const RANGE0 = 150, RANGE_K = 10;      // допуск по ELO при поиске: 150 сразу, потом +10 в секунду (до 1500)
const PREM_RANGE0 = 300, PREM_RANGE_K = 30; // Premium: допуск сразу 300 и растёт втрое быстрее — матч находится намного быстрее
const DAY = 24 * 3600e3;
// штраф за непринятый матч (считаем пропуски за последние сутки): 1-й — предупреждение, 2-й — 5 минут, 3-й — 30 минут, дальше — 2 часа
const MISS_BAN = [0, 5, 30, 120];
const CHAT_MAX = 300, CHAT_LEN = 300, CHAT_USER = 80; // сообщений в матче, символов в сообщении, сообщений от одного игрока
const AFTER = 30 * 60e3;               // в чат можно писать ещё 30 минут после конца матча
const FB_TTL = DAY;                    // «Спасибо» и жалобы — сутки после матча
const minStr = n => (n >= 60 ? Math.floor(n / 60) + ' ч' + (n % 60 ? ' ' + (n % 60) + ' мин' : '') : n + ' мин');
// сколько осталось до конца запрета: «4 мин», «1 ч 20 мин», «6 дн. 23 ч»
const plural = (n, a, b, c) => { const k = n % 100, j = n % 10; return n + ' ' + (k >= 11 && k <= 14 ? c : j === 1 ? a : j >= 2 && j <= 4 ? b : c); };
const leftStr = ts => { const m = Math.max(1, Math.ceil((ts - Date.now()) / 60e3)); if (m < 24 * 60) return minStr(m); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return plural(d, 'день', 'дня', 'дней') + (h ? ' ' + h + ' ч' : ''); };
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const other = t => (t === 'A' ? 'B' : 'A');
const players = n => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'игрок' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'игрока' : 'игроков');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);

module.exports = function (ctx) {
  const { db, save, sendTo, broadcast, avatarOf } = ctx;
  const tell = ctx.tell || (() => {}), alertAdmins = ctx.alertAdmins || (() => {}), site = ctx.siteUrl || '';
  // пати: кто с кем в одной группе (модуль party.js подключается позже), кто на сайте, отправка состояния игроку
  const partyOf = uid => (ctx.partyOf ? ctx.partyOf(uid) : null);
  const isOnline = ctx.isOnline || (() => true), pushState = ctx.pushState || (() => {}), onParty = ctx.onPartyChange || (() => {});
  const isAdminId = ctx.isAdminId || (() => false), adminIds = ctx.adminIds || (() => []), onFinish = ctx.onFinish || (() => {});
  const isPrem = ctx.isPrem || (() => false); // подписка StandHub Premium (premium.js)
  // чат пишем на диск не на каждое сообщение, а раз в пару секунд
  let saveT = null; const saveSoon = () => { if (!saveT) saveT = setTimeout(() => { saveT = null; save(); }, 2000); };
  // в очереди стоят группы: один игрок или пати целиком — { uids, pid, joined, prio, prem } (prem — в группе есть игрок с Premium)
  const queues = { '5v5': [], '2v2': [], '1v1': [] };
  const userById = id => db.users.find(u => u.id === id);
  const nickOf = id => (userById(id) || {}).nick || 'Игрок';
  const OPEN = ['accept', 'veto', 'live', 'dispute'];   // ещё не закрытые матчи
  const BUSY = ['accept', 'veto', 'live'];              // игрок занят и не может искать новый матч
  const open = () => db.matches.filter(m => OPEN.includes(m.state));
  const matchOf = uid => db.matches.find(m => BUSY.includes(m.state) && m.players.some(p => p.id === uid));
  const entryOf = uid => { for (const k in queues) { const q = queues[k].find(x => x.uids.includes(uid)); if (q) return { mode: k, q }; } return null; };
  const queueEntry = uid => { const e = entryOf(uid); return e ? { mode: e.mode, waited: Date.now() - e.q.joined, party: e.q.uids.length > 1, prem: !!e.q.prem } : null; };
  const inQueue = uid => (queueEntry(uid) || {}).mode || null;
  const people = q => q.reduce((a, x) => a + x.uids.length, 0);
  const searching = () => Object.values(queues).reduce((a, q) => a + people(q), 0);
  const searchingBy = () => Object.fromEntries(Object.keys(queues).map(k => [k, people(queues[k])])); // сколько игроков ищут в каждом режиме
  const liveCount = () => db.matches.filter(m => !m.test && ['veto', 'live'].includes(m.state)).length;
  const find = id => db.matches.find(m => m.id === id);
  const P = (m, id) => m.players.find(p => p.id === id);
  const cap = (m, t) => P(m, m.captains[t]);
  const real = m => m.players.filter(p => !p.bot);
  // ссылка словом «StandHub» вместо длинного адреса
  const go = path => `👉 <a href="${site}${path}">StandHub</a>`;
  const link = m => go('/#/match/' + m.id);

  // ---------- штрафы: запрет поиска ----------
  const missesOf = u => (u.misses || []).filter(t => Date.now() - t < DAY);
  const missCount = uid => { const u = userById(uid); return u ? missesOf(u).length : 0; };
  const banOf = u => (u && u.banUntil > Date.now() ? { until: u.banUntil, why: u.banWhy || '', kind: u.banKind || 'miss' } : null);
  function penalize(uid, m) {
    const u = userById(uid); if (!u) return null;
    const ms = missesOf(u); ms.push(Date.now()); u.misses = ms;
    const n = ms.length, min = MISS_BAN[Math.min(n, MISS_BAN.length) - 1], next = MISS_BAN[Math.min(n + 1, MISS_BAN.length) - 1];
    if (min) { const until = Date.now() + min * 60e3; if (!(u.banUntil > until)) Object.assign(u, { banUntil: until, banWhy: 'не принят матч', banKind: 'miss' }); }
    tell(uid, min ? `⛔ Вы не приняли матч (${MODE_NAME[m.mode]}) — поиск на StandHub закрыт на <b>${minStr(min)}</b>.\nЭто ${n}-й пропуск за сутки, следующий — ${minStr(next)}.\nПравила: ${go('/#/rules')}`
      : `⚠️ Вы не приняли матч (${MODE_NAME[m.mode]}). Это предупреждение: если за сутки пропустить ещё один, поиск закроется на 5 минут.\nПравила: ${go('/#/rules')}`);
    return min;
  }
  // запрет от администратора (или снятие: until = 0)
  function setBan(uid, until, why) {
    const u = userById(uid); if (!u) return;
    if (until > Date.now()) { Object.assign(u, { banUntil: until, banWhy: why, banKind: 'admin' }); stopFor([uid], `Поиск остановлен: ${u.nick} не может искать матч`); }
    else { u.banUntil = 0; u.banWhy = ''; u.misses = []; }
    save(); pushState(uid);
  }

  // ---------- очередь ----------
  const drop = uids => { for (const k in queues) queues[k] = queues[k].filter(x => !x.uids.some(id => uids.includes(id))); };
  function join(u, mode) {
    if (!MODES[mode]) return { error: 'Неизвестный режим' };
    const am = matchOf(u.id); if (am) return { error: 'У вас уже есть активный матч', match: am.id };
    const bn = banOf(u); if (bn) return { error: `Поиск закрыт ещё ${leftStr(bn.until)}: ${bn.why}`, code: 'ban' };
    // пати ищет матч целиком: запускает лидер, все должны быть на сайте и не в матче
    const pt = partyOf(u.id), uids = pt ? pt.members.slice() : [u.id], half = MODES[mode] / 2;
    if (pt) {
      if (pt.leader !== u.id) return { error: `Поиск запускает лидер пати — ${nickOf(pt.leader)}` };
      if (uids.length > half) return { error: half === 1 ? 'В режиме «1 на 1» играют без пати — выберите «2 на 2» или «5 на 5»' : `В пати ${players(uids.length)} — в режиме «${MODE_NAME[mode]}» можно максимум ${half}` };
      for (const id of uids) if (id !== u.id) {
        if (matchOf(id)) return { error: `${nickOf(id)} ещё в матче — подождите, пока он закончится` };
        const b2 = banOf(userById(id)); if (b2) return { error: `${nickOf(id)} не может искать матч ещё ${leftStr(b2.until)}: ${b2.why}`, code: 'ban' };
        if (!isOnline(id)) return { error: `${nickOf(id)} сейчас не на сайте — подождите его или исключите из пати`, code: 'offline' };
      }
    }
    drop(uids);
    queues[mode].push({ uids, pid: pt ? pt.id : null, joined: Date.now(), prio: Date.now(), prem: uids.some(id => isPrem(id)) });
    if (pt) {
      if (pt.mode !== mode) { pt.mode = mode; save(); onParty(pt); }
      for (const id of uids) if (id !== u.id) pushState(id, { note: `${u.nick} запустил(а) поиск матча · ${MODE_NAME[mode]}` });
    }
    broadcast(); tick(); return { ok: true, mode };
  }
  // выход из поиска. Если искало пати — поиск останавливается у всех, остальным показываем причину
  function leave(uid, silent, why) {
    const e = entryOf(uid); if (!e) return;
    queues[e.mode] = queues[e.mode].filter(x => x !== e.q);
    for (const id of e.q.uids) if (id !== uid) pushState(id, { stop: why || `${nickOf(uid)} отменил(а) поиск` });
    if (!silent) broadcast();
  }
  // остановить поиск у всех групп, где есть эти игроки (состав пати изменился и т.п.)
  function stopFor(uids, why) {
    const hit = [];
    for (const k in queues) queues[k] = queues[k].filter(x => { if (!x.uids.some(id => uids.includes(id))) return true; hit.push(...x.uids); return false; });
    for (const id of hit) pushState(id, { stop: why || 1 }); // stop: 1 — тихо, без сообщения
    if (hit.length) broadcast();
    return hit.length > 0;
  }

  // подбор: самая долго ждущая группа + ближайшие по ELO; допуск по ELO растёт со временем ожидания. Регион не учитывается.
  // Пати не разбиваются: группы должны делиться на две равные команды целиком.
  // Premium-группы стоят в очереди так, будто ждут на 2 минуты дольше, а допуск по ELO у них шире и растёт втрое быстрее.
  const avgElo = x => x.uids.reduce((a, id) => a + (userById(id) || { elo: 1000 }).elo, 0) / x.uids.length;
  function canSplit(sizes, half) { let r = new Set([0]); for (const s of sizes) { const n = new Set(r); for (const v of r) if (v + s <= half) n.add(v + s); r = n; } return r.has(half); }
  function pick(q, N) {
    const first = q[0], half = N / 2, fe = avgElo(first);
    if (first.uids.length > half) return null;
    const range = Math.min(1500, (first.prem ? PREM_RANGE0 : RANGE0) + ((Date.now() - first.prio) / 1000) * (first.prem ? PREM_RANGE_K : RANGE_K));
    const cands = q.slice(1).filter(x => x.uids.length <= half && Math.abs(avgElo(x) - fe) <= range)
      .sort((a, b) => Math.abs(avgElo(a) - fe) - Math.abs(avgElo(b) - fe)).slice(0, 14);
    const chosen = [first];
    const dfs = (i, total) => {
      if (total === N) return canSplit(chosen.map(x => x.uids.length), half);
      for (let j = i; j < cands.length; j++) {
        if (total + cands[j].uids.length > N) continue;
        chosen.push(cands[j]); if (dfs(j + 1, total + cands[j].uids.length)) return true; chosen.pop();
      }
      return false;
    };
    return dfs(0, first.uids.length) ? chosen : null;
  }
  const rank = x => x.prio - (x.prem ? PREM_HEAD : 0);
  function tick() {
    for (const mode in queues) {
      const N = MODES[mode];
      for (;;) {
        const q = queues[mode].filter(x => x.uids.every(id => userById(id) && !matchOf(id))).sort((a, b) => rank(a) - rank(b));
        queues[mode] = q;
        if (people(q) < N) break;
        // ведущая — первая группа в очереди; если ей пока некого подобрать по ELO, пробуем следующие — остальные не ждут зря
        let picked = null;
        for (let i = 0; i < q.length && !picked; i++) picked = pick(i ? [q[i], ...q.slice(0, i), ...q.slice(i + 1)] : q, N);
        if (!picked) break;
        queues[mode] = q.filter(x => !picked.includes(x));
        createMatch(mode, picked.flatMap(x => x.uids.map(userById)), false, picked.map(x => x.uids));
      }
    }
  }

  // ---------- матч ----------
  const groupsOf = m => m.groups || m.players.map(p => [p.id]);
  function createMatch(mode, users, test, groups) {
    const m = {
      id: crypto.randomBytes(5).toString('hex'), mode, test: !!test, state: 'accept', created: Date.now(),
      acceptDeadline: Date.now() + ACCEPT_SEC * 1000, accepted: [],
      players: users.map(u => ({ id: u.id, nick: u.nick, elo: u.elo, soid: u.soid, avatar: u.bot ? null : avatarOf(u), bot: !!u.bot, team: null })),
      groups: groups && groups.some(g => g.length > 1) ? groups : null, // пати в этом матче (играют в одной команде)
      captains: {}, host: null, maps: MAPS.slice(), bans: [], turn: null, turnDeadline: null, map: null,
      reports: {}, cancelVotes: [], scoreA: null, scoreB: null, winner: null, deltas: null,
    };
    db.matches.push(m); save(); notify(m); broadcast();
    for (const p of real(m)) tell(p.id, `🎮 <b>Матч найден!</b> (${MODE_NAME[mode]})\nПримите его на сайте за ${ACCEPT_SEC} секунд:\n${link(m)}`);
    for (const p of m.players) if (p.bot) setTimeout(() => accept(m.id, p.id), rnd(500, 3000));
    return m;
  }
  function accept(mid, uid) {
    const m = find(mid); if (!m || m.state !== 'accept' || !P(m, uid) || m.accepted.includes(uid)) return;
    m.accepted.push(uid);
    if (m.accepted.length === m.players.length) startVeto(m); else { save(); notify(m); }
  }
  function decline(mid, uid) { const m = find(mid); if (m && m.state === 'accept' && P(m, uid)) cancelAccept(m, [uid]); }
  function cancelAccept(m, bad) {
    m.state = 'cancelled'; m.cancelReason = 'Не все игроки приняли матч'; m.requeued = []; m.missed = {};
    // кто не принял — штраф (кроме тестовых матчей и матчей, которые прервал перезапуск сайта)
    if (!m.test && !m.noPenalty) for (const id of bad) { const p = P(m, id); if (p && !p.bot) m.missed[id] = penalize(id, m); }
    // принявшие — снова в поиск, впереди очереди. Пати возвращается, только если приняли все её игроки и состав не менялся
    if (!m.test) for (const g of groupsOf(m)) {
      const ids = g.filter(id => P(m, id) && !P(m, id).bot);
      if (!ids.length || ids.some(id => bad.includes(id))) continue;
      const pt = partyOf(ids[0]);
      if (ids.length > 1 ? !pt || pt.members.length !== ids.length || !ids.every(id => pt.members.includes(id)) : pt && pt.members.length > 1) continue;
      drop(ids); queues[m.mode].push({ uids: ids, pid: ids.length > 1 ? pt.id : null, joined: Date.now(), prio: Date.now() - 120e3, prem: ids.some(id => isPrem(id)) }); m.requeued.push(...ids);
    }
    save(); notify(m); broadcast(); setTimeout(tick, 500);
    for (const id in m.missed) pushState(id); // показать запрет поиска
  }
  // делим поровну по ELO (перебор всех вариантов); игроки одного пати всегда в одной команде
  function balance(m) {
    const groups = groupsOf(m).map(g => g.map(id => P(m, id)).filter(Boolean)).filter(g => g.length);
    const seen = new Set(groups.flat()); for (const p of m.players) if (!seen.has(p)) groups.push([p]);
    const h = m.players.length / 2, total = m.players.reduce((a, p) => a + p.elo, 0);
    let best = null, bestDiff = Infinity;
    const rec = (i, cnt, sum, pk) => {
      if (cnt === h) { const d = Math.abs(total - 2 * sum); if (d < bestDiff) { bestDiff = d; best = pk.slice(); } return; }
      if (i >= groups.length) return;
      const g = groups[i];
      if (cnt + g.length <= h) { pk.push(i); rec(i + 1, cnt + g.length, sum + g.reduce((a, p) => a + p.elo, 0), pk); pk.pop(); }
      rec(i + 1, cnt, sum, pk);
    };
    rec(0, 0, 0, []);
    return new Set(best ? best.flatMap(i => groups[i]) : m.players.slice(0, h));
  }
  function startVeto(m) {
    const X = balance(m);
    m.players.forEach(p => (p.team = X.has(p) ? 'X' : 'Y'));
    const top = m.players.reduce((a, b) => (b.elo > a.elo ? b : a));         // хост — самый высокий ELO в матче
    const hostTeam = top.team; m.players.forEach(p => (p.team = p.team === hostTeam ? 'A' : 'B'));
    for (const t of ['A', 'B']) m.captains[t] = m.players.filter(p => p.team === t).reduce((a, b) => (b.elo > a.elo ? b : a)).id; // капитан — самый высокий ELO в команде
    m.host = top.id; m.state = 'veto'; m.turn = 'B'; m.turnDeadline = Date.now() + BAN_SEC * 1000; // команда без хоста убирает первой
    save(); notify(m); broadcast(); botStep(m);
  }
  const remaining = m => m.maps.filter(x => !m.bans.some(b => b.map === x));
  function ban(mid, uid, map, auto) {
    const m = find(mid); if (!m || m.state !== 'veto') return { error: 'Сейчас нельзя убирать карты' };
    if (!auto && m.captains[m.turn] !== uid) return { error: 'Сейчас ход другого капитана' };
    if (!remaining(m).includes(map)) return { error: 'Эта карта уже убрана' };
    m.bans.push({ map, team: m.turn, auto: !!auto });
    const left = remaining(m);
    if (left.length === 1) { m.map = left[0]; m.state = 'live'; m.liveAt = Date.now(); m.turn = null; m.turnDeadline = null; goLive(m); }
    else { m.turn = other(m.turn); m.turnDeadline = Date.now() + BAN_SEC * 1000; }
    save(); notify(m); broadcast(); botStep(m); return { ok: true };
  }
  function goLive(m) {
    const host = P(m, m.host);
    for (const p of real(m)) tell(p.id, p.id === m.host
      ? `🗺 Карта: <b>${m.map}</b>\n👑 <b>Вы — хост.</b> Создайте лобби в StandLeo (13 раундов до победы). Игроки напишут вам «.» в личку — пригласите их.\n${link(m)}`
      : `🗺 Карта: <b>${m.map}</b>\nХост: <b>${host.nick}</b>, ID в игре: <code>${host.soid}</code>\nНайдите его в StandLeo и напишите «.» в личку — он пригласит вас в лобби.\n${link(m)}`);
  }
  function botStep(m) {
    if (m.state !== 'veto') return; const c = cap(m, m.turn); if (!c || !c.bot) return;
    const t = m.turn, n = m.bans.length;
    setTimeout(() => { const x = find(m.id); if (x && x.state === 'veto' && x.turn === t && x.bans.length === n) { const r = remaining(x); ban(x.id, c.id, r[rnd(0, r.length - 1)]); } }, rnd(1500, 3000));
  }

  // ---------- результат: капитан отмечает, соперники подтверждают или оспаривают ----------
  // m.reports[team] = { result: 'win'|'loss'|'draw', score, at, by, n } — что отметил капитан команды (n — сколько раз отмечал)
  const winnerOf = (team, r) => (r.result === 'draw' ? 'draw' : r.result === 'win' ? team : other(team));
  const claimOf = m => { const ts = ['A', 'B'].filter(t => m.reports[t]); return ts.length === 1 ? { team: ts[0], ...m.reports[ts[0]] } : null; };
  const teamName = (m, t) => 'команда ' + ((cap(m, t) || {}).nick || t);
  // исход словами: для игрока команды t — «победа вашей команды», без t — «победа: команда Fl4mus»
  const outWord = (m, w, t) => (w === 'draw' ? 'ничья 12 : 12' : w === 'cancel' ? 'матч не состоялся' : t ? (w === t ? 'победа вашей команды' : 'поражение вашей команды') : 'победа: ' + teamName(m, w));
  const PROOF_HINT = '📎 Есть запись экрана или скриншот итогового счёта? Пришлите прямо сюда, в этот чат, — я передам администратору.';
  function claim(mid, uid, result) {
    const m = find(mid); if (!m || m.state !== 'live') return { error: 'Сейчас нельзя отметить результат' };
    const team = ['A', 'B'].find(t => m.captains[t] === uid); if (!team) return { error: 'Результат отмечает капитан команды' };
    if (!['win', 'loss', 'draw'].includes(result)) return { error: 'Неверный ответ' };
    const wait = (m.liveAt || 0) + CLAIM_MIN - Date.now();
    if (!m.test && wait > 0) return { error: `Результат можно отметить через ${minStr(Math.ceil(wait / 60e3))} — сначала сыграйте матч. Если лобби не собралось, нажмите «Матч не состоялся».` };
    const was = m.reports[team];
    if (was && was.result === result) return { error: 'Вы уже отметили этот результат' };
    if (was && (was.n || 1) >= CHANGES) return { error: 'Результат уже менялся два раза. Если ошиблись — напишите в чат матча, соперники смогут его оспорить.' };
    m.reports[team] = { result, score: result === 'draw' ? [12, 12] : null, at: Date.now(), by: uid, n: (was ? was.n || 1 : 0) + 1 };
    m.remindLeft = false;
    if (m.reports[other(team)]) { resolve(m); return { ok: true }; } // оба капитана отметили сами
    save(); notify(m);
    const c = cap(m, team), w = winnerOf(team, m.reports[team]);
    if (m.test) { // тестовый матч: боты-соперники подтверждают через пару секунд
      const at = m.reports[team].at;
      setTimeout(() => { const x = find(m.id), cl = x && x.state === 'live' && claimOf(x); if (cl && cl.at === at) finish(x, w, cl.score, 'agree'); }, rnd(1200, 2500));
    } else for (const p of real(m)) if (p.team !== team) tell(p.id, `${was ? '🔁 Капитан соперников <b>' + esc(c.nick) + '</b> изменил результат' : '🏁 Капитан соперников <b>' + esc(c.nick) + '</b> отметил результат'} матча (${m.map}): <b>${outWord(m, w, p.team)}</b>.\n\nЕсли всё верно — нажмите на сайте «Всё верно». Если нет — «Оспорить» в течение 30 минут, иначе результат засчитается.\n${link(m)}`);
    return { ok: true };
  }
  // соперник подтверждает отмеченный результат — матч сразу завершается
  function agree(mid, uid) {
    const m = find(mid); if (!m || m.state !== 'live') return { error: 'Сейчас нельзя подтвердить результат' };
    const p = P(m, uid), c = claimOf(m);
    if (!c) return { error: 'Капитан ещё не отметил результат' };
    if (!p || p.bot || p.team === c.team) return { error: 'Результат подтверждают игроки команды соперников' };
    m.agreedBy = uid; finish(m, winnerOf(c.team, c), c.score, 'agree'); return { ok: true };
  }
  // любой игрок матча (кроме того, кто отметил) может оспорить результат: says — 'us' | 'them' | 'draw' | 'none' (матч не состоялся)
  function dispute(mid, uid, says, text) {
    const m = find(mid); if (!m || m.state !== 'live') return { error: 'Сейчас нельзя оспорить результат' };
    const p = P(m, uid), c = claimOf(m);
    if (!p || p.bot) return { error: 'Оспорить результат могут только игроки матча' };
    if (!c) return { error: 'Результат ещё не отмечен' };
    if (c.by === uid) return { error: 'Это ваш результат — его можно изменить' };
    const w = { us: p.team, them: other(p.team), draw: 'draw', none: 'cancel' }[says];
    if (!w) return { error: 'Выберите, чем закончился матч' };
    if (w === winnerOf(c.team, c)) return { error: 'Капитан отметил то же самое' + (p.team !== c.team ? ' — нажмите «Всё верно»' : '') };
    const t = clean(text, 300);
    m.state = 'dispute'; m.disputeReason = `${p.nick} оспорил(а) результат`; m.disputedAt = Date.now();
    m.disputedBy = { uid, nick: p.nick, team: p.team, says: w, text: t, at: Date.now() };
    save(); notify(m); broadcast();
    alertAdmins(`⚠️ <b>Результат оспорен</b> · матч #${m.id} (${MODE_NAME[m.mode]}, ${m.map})\nКапитан ${esc(cap(m, c.team).nick)} отметил: <b>${outWord(m, winnerOf(c.team, c))}</b>\n${esc(p.nick)} говорит: <b>${outWord(m, w)}</b>${t ? `\nКомментарий: «${esc(t)}»` : ''}\nДоказательства от игроков придут сюда, в этот чат.\n${go('/#/admin')}`);
    for (const x of real(m)) tell(x.id, `⚠️ Результат матча (${m.map}) оспорен — ${x.id === uid ? 'вы не согласились с капитаном' : esc(p.nick) + ' не согласен(на) с ним'}. Администратор проверит матч и выставит итог, ELO пока не меняется.\n\n${PROOF_HINT}\n${link(m)}`);
    return { ok: true };
  }
  // оба капитана отметили результат сами: совпало — матч завершён, нет — спор
  function resolve(m) {
    const A = m.reports.A, B = m.reports.B, wa = winnerOf('A', A), wb = winnerOf('B', B);
    if (wa === wb) return finish(m, wa, A.score || B.score, 'both');
    m.state = 'dispute'; m.disputeReason = 'Капитаны отметили разные результаты'; m.disputedAt = Date.now(); save(); notify(m); broadcast();
    alertAdmins(`⚠️ <b>Спорный матч</b> #${m.id} (${MODE_NAME[m.mode]}, ${m.map}): капитаны отметили разные результаты.\n${esc(cap(m, 'A').nick)}: <b>${outWord(m, wa)}</b>\n${esc(cap(m, 'B').nick)}: <b>${outWord(m, wb)}</b>\nДоказательства от игроков придут сюда, в этот чат.\n${go('/#/admin')}`);
    for (const x of real(m)) tell(x.id, `⚠️ Капитаны отметили разные результаты матча (${m.map}). Администратор проверит матч и выставит итог, ELO пока не меняется.\n\n${PROOF_HINT}\n${link(m)}`);
  }
  const HOW = { timeout: 'Соперники не оспорили результат за 30 минут.', admin: 'Итог выставил администратор после проверки.' };
  function finish(m, winner, score, how) {
    m.winner = winner; m.how = how || null;
    if (score) { const hi = Math.max(...score), lo = Math.min(...score); [m.scoreA, m.scoreB] = winner === 'A' ? [hi, lo] : winner === 'B' ? [lo, hi] : [score[0], score[1]]; }
    const avg = t => { const ps = m.players.filter(p => p.team === t); return ps.reduce((a, p) => a + p.elo, 0) / ps.length; };
    const expA = 1 / (1 + Math.pow(10, (avg('B') - avg('A')) / 400));
    const dA = Math.round(K * ((winner === 'A' ? 1 : winner === 'draw' ? 0.5 : 0) - expA));
    m.deltas = {}; for (const p of m.players) m.deltas[p.id] = p.team === 'A' ? dA : -dA;
    if (!m.test) for (const p of m.players) {
      const u = userById(p.id); if (!u) continue;
      u.elo = Math.max(100, u.elo + m.deltas[p.id]); u.matches += 1; if (winner === p.team) u.wins += 1;
    }
    m.state = 'finished'; m.finishedAt = m.endedAt = Date.now(); save(); notify(m); broadcast();
    if (!m.test) try { onFinish(m); } catch (e) { console.error('onFinish', e); }
    for (const p of real(m)) {
      const d = m.deltas[p.id], res = winner === 'draw' ? 'Ничья' : winner === p.team ? '🏆 Победа' : 'Поражение';
      tell(p.id, `${res}${m.scoreA != null ? ` ${p.team === 'A' ? m.scoreA + ':' + m.scoreB : m.scoreB + ':' + m.scoreA}` : ''} · ${m.map}\nELO: ${d >= 0 ? '+' : ''}${d}${m.test ? ' (тестовый матч — рейтинг не меняется)' : ''}${HOW[how] ? '\n' + HOW[how] : ''}\n${link(m)}`);
    }
  }
  function cancel(m, reason) { m.state = 'cancelled'; m.cancelReason = reason; m.endedAt = Date.now(); save(); notify(m); broadcast(); }
  // «Матч не состоялся»: если больше половины игроков согласны — отмена без изменения ELO
  function voteCancel(mid, uid) {
    const m = find(mid); if (!m || m.state !== 'live' || !P(m, uid)) return { error: 'Сейчас нельзя отменить матч' };
    m.cancelVotes = m.cancelVotes || [];
    if (m.cancelVotes.includes(uid)) m.cancelVotes = m.cancelVotes.filter(x => x !== uid); else m.cancelVotes.push(uid);
    if (m.test) for (const p of m.players) if (p.bot && m.cancelVotes.length && !m.cancelVotes.includes(p.id)) m.cancelVotes.push(p.id);
    if (m.cancelVotes.length > m.players.length / 2) cancel(m, 'Игроки отметили, что матч не состоялся');
    else { save(); notify(m); }
    return { ok: true };
  }
  // решение администратора: 'A' | 'B' | 'draw' | 'cancel'. punish — запрет поиска на 7 дней тем, кто указал другой итог
  function adminResolve(mid, winner, punish) {
    const m = find(mid); if (!m || !['live', 'dispute', 'veto', 'accept'].includes(m.state)) return { error: 'Матч уже завершён' };
    if (!['A', 'B', 'draw', 'cancel'].includes(winner) || (winner !== 'cancel' && !m.map)) return { error: 'Неверный победитель' };
    const liars = new Set();
    if (punish && !m.test) {
      for (const t of ['A', 'B']) { const r = m.reports[t]; if (r && winnerOf(t, r) !== winner) liars.add(r.by || m.captains[t]); }
      const d = m.disputedBy; if (d && d.says !== winner) liars.add(d.uid);
    }
    if (winner === 'cancel') cancel(m, 'Матч отменён администратором');
    else finish(m, winner, winner === 'draw' ? [12, 12] : null, 'admin');
    const punished = [], until = Date.now() + FALSE_BAN;
    for (const id of liars) {
      const u = userById(id), p = P(m, id); if (!u || !p || p.bot) continue;
      if (!(u.banUntil > until)) setBan(id, until, 'ложный результат матча');
      punished.push(u.nick);
      tell(id, `⛔ Администратор проверил матч (${m.map}): итог — <b>${outWord(m, winner, p.team)}</b>, а вы указали другой. Поиск матчей на StandHub закрыт на <b>7 дней</b>.\nЕсли это ошибка — напишите в поддержку: ${go('/#/support')}`);
    }
    if (punished.length) { m.punished = punished; save(); }
    return { ok: true, punished };
  }

  // ---------- доказательства: игроки присылают видео и скриншоты боту, бот пересылает их администраторам ----------
  const proofsBy = m => { const c = {}; for (const x of m.proofs || []) c[x.uid] = (c[x.uid] || 0) + 1; return Object.entries(c).map(([id, n]) => ({ id, nick: nickOf(id), n })); };
  // можно ли прислать доказательства по матчу: игрок матча, матч идёт / оспорен или закончился меньше суток назад
  function proofCheck(mid, uid) {
    const m = find(mid), p = m && P(m, uid);
    if (!m || !p || p.bot || !hasTeams(m)) return { error: 'not_player' };
    if (!['live', 'dispute'].includes(m.state) && !(endedAt(m) && Date.now() - endedAt(m) < DAY)) return { error: 'old' };
    return { ok: true, m, left: PROOF_MAX - (m.proofs || []).filter(x => x.uid === uid).length };
  }
  // спорный матч игрока (самый свежий) — туда идут файлы, присланные боту без ссылки
  const disputedOf = uid => db.matches.filter(m => m.state === 'dispute' && m.players.some(p => p.id === uid)).sort((a, b) => (b.disputedAt || 0) - (a.disputedAt || 0))[0] || null;
  function addProof(mid, uid, kind) {
    const m = find(mid); if (!m) return 0;
    m.proofs = (m.proofs || []).concat({ uid, kind, at: Date.now() }).slice(-100); saveSoon(); notify(m);
    return m.proofs.filter(x => x.uid === uid).length;
  }

  // таймеры: принятие, ход в вето, ожидание результата
  setInterval(() => {
    const now = Date.now();
    for (const m of open()) {
      if (m.state === 'accept' && now > m.acceptDeadline) cancelAccept(m, m.players.filter(p => !m.accepted.includes(p.id)).map(p => p.id));
      else if (m.state === 'veto' && now > m.turnDeadline) { const r = remaining(m); ban(m.id, null, r[rnd(0, r.length - 1)], true); }
      else if (m.state === 'live') {
        const c = claimOf(m);
        if (c) {
          const left = c.at + CLAIM_WAIT - now, w = winnerOf(c.team, c);
          if (left <= 0) finish(m, w, c.score, 'timeout');
          else if (left <= REMIND_LEFT && !m.remindLeft && !m.test) {
            m.remindLeft = true; save();
            for (const p of real(m)) if (p.team !== c.team) tell(p.id, `⏰ Осталось 10 минут, чтобы оспорить результат матча (${m.map}): <b>${outWord(m, w, p.team)}</b>.\nЕсли всё верно — ничего делать не нужно, результат засчитается сам.\n${link(m)}`);
          }
        } else if (now - m.liveAt > MATCH_TTL) cancel(m, 'Капитаны не отметили результат');
        else if (now - m.liveAt > CAP_REMIND && !m.capRemind && !m.test) {
          m.capRemind = true; save();
          for (const t of ['A', 'B']) { const c2 = cap(m, t); if (c2 && !c2.bot) tell(c2.id, `⏰ Матч на карте ${m.map} идёт уже час. Если он закончился — отметьте результат на сайте: «Мы победили» или «Мы проиграли». Если лобби не собралось — нажмите «Матч не состоялся».\nБез результата матч отменится через 2 часа.\n${link(m)}`); }
        }
      }
    }
  }, 1000);
  setInterval(tick, 2000);
  // матч, который ждал принятия во время перезапуска сайта, отменится без штрафа
  for (const m of db.matches) if (m.state === 'accept') m.noPenalty = true;
  // переписку старых матчей (старше 14 дней) удаляем
  const pruneChat = () => { let n = 0; for (const m of db.matches) if (m.chat && endedAt(m) && Date.now() - endedAt(m) > 14 * DAY) { delete m.chat; n++; } if (n) save(); };
  setInterval(pruneChat, 3600e3); setTimeout(pruneChat, 5000);

  // ---------- чат матча ----------
  const endedAt = m => m.endedAt || m.finishedAt || null;
  const hasTeams = m => m.players.some(p => p.team);
  const chatOpen = m => hasTeams(m) && (['veto', 'live', 'dispute'].includes(m.state) || (['finished', 'cancelled'].includes(m.state) && !!endedAt(m) && Date.now() - endedAt(m) < AFTER));
  const chatSees = (m, uid, x) => x.ch === 'all' || isAdminId(uid) || (P(m, uid) || {}).team === x.ch;
  const chatView = (m, x, uid) => ({ id: x.id, nick: x.nick, t: x.t, ch: x.ch, at: x.at, tm: x.tm || null, me: x.uid === uid, adm: !!x.adm, pr: isPrem(x.uid) });
  const chatAt = new Map();
  function chatList(mid, uid) {
    const m = find(mid); if (!m) return { error: 'Матч не найден' };
    if (!P(m, uid) && !isAdminId(uid)) return { error: 'Чат матча видят только его игроки' };
    return { open: chatOpen(m), msgs: (m.chat || []).filter(x => chatSees(m, uid, x)).map(x => chatView(m, x, uid)) };
  }
  function chatSend(mid, u, text, ch) {
    const m = find(mid); if (!m) return { error: 'Матч не найден' };
    const me = P(m, u.id), adm = isAdminId(u.id);
    if (!me && !adm) return { error: 'Писать в чат могут только игроки матча' };
    if (!chatOpen(m)) return { error: 'Чат этого матча уже закрыт', closed: true };
    const t = String(text || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_LEN);
    if (!t) return { error: 'Напишите сообщение' };
    const now = Date.now();
    if (now - (chatAt.get(u.id) || 0) < 1000) return { error: 'Не так быстро — подождите секунду' };
    if ((m.chat || []).filter(x => x.uid === u.id).length >= CHAT_USER) return { error: 'Слишком много сообщений в этом матче' };
    chatAt.set(u.id, now);
    const x = { id: (m.chatSeq = (m.chatSeq || 0) + 1), uid: u.id, nick: u.nick, t, ch: ch === 'team' && me && me.team ? me.team : 'all', tm: me ? me.team : null, at: now, adm: !me ? 1 : 0 };
    m.chat = (m.chat || []).concat(x).slice(-CHAT_MAX); saveSoon();
    for (const id of new Set([...real(m).map(p => p.id), ...adminIds()])) if (chatSees(m, id, x)) sendTo(id, { type: 'chat', mid: m.id, msg: chatView(m, x, id) });
    return { ok: true, msg: chatView(m, x, u.id) };
  }
  // «Спасибо» и жалобы доступны сутки после матча, который дошёл хотя бы до выбора карты (не тестовый)
  const fbOpen = m => !m.test && hasTeams(m) && ['finished', 'cancelled'].includes(m.state) && !!endedAt(m) && Date.now() - endedAt(m) < FB_TTL;

  // прогноз ELO для игрока с Premium: сколько получит за победу, поражение и ничью (так же, как считает finish)
  function forecast(m, team) {
    const avg = t => { const ps = m.players.filter(p => p.team === t); return ps.reduce((a, p) => a + p.elo, 0) / ps.length; };
    const expA = 1 / (1 + Math.pow(10, (avg('B') - avg('A')) / 400)), dA = s => Math.round(K * (s - expA));
    return team === 'A' ? { win: dA(1), loss: dA(0), draw: dA(0.5) } : { win: -dA(0), loss: -dA(1), draw: -dA(0.5) };
  }
  // ---------- что видит игрок ----------
  function view(m, vid) {
    const me = P(m, vid), host = P(m, m.host), myTeam = me && me.team;
    const votes = m.cancelVotes || [], c = m.state === 'live' ? claimOf(m) : null, d = m.disputedBy;
    // что сказали игроки, когда результат оспорен: капитаны (отметили) и тот, кто оспорил
    const said = m.state === 'dispute' ? ['A', 'B'].filter(t => m.reports[t]).map(t => ({ nick: nickOf(m.reports[t].by || m.captains[t]), w: winnerOf(t, m.reports[t]), cap: true }))
      .concat(d ? [{ nick: d.nick, w: d.says, cap: false }] : []) : null;
    // кто пришёл в матч пати: «Пати» (или «Пати 1», «Пати 2», если их несколько)
    const gl = {}; let gn = 0; for (const g of groupsOf(m)) if (g.length > 1) { gn++; for (const id of g) gl[id] = gn; }
    return {
      id: m.id, mode: m.mode, test: m.test, state: m.state, now: Date.now(), created: m.created,
      acceptDeadline: m.acceptDeadline, accepted: m.accepted.length, total: m.players.length, iAccepted: m.accepted.includes(vid), requeuedMe: !!(m.requeued && m.requeued.includes(vid)),
      players: m.players.map(p => ({ nick: p.nick, elo: p.elo, avatar: p.avatar, bot: p.bot, team: m.state === 'accept' ? null : p.team, prem: !p.bot && isPrem(p.id),
        captain: m.captains.A === p.id ? 'A' : m.captains.B === p.id ? 'B' : null, host: p.id === m.host, me: p.id === vid,
        accepted: m.accepted.includes(p.id), delta: m.deltas ? m.deltas[p.id] : null, party: gl[p.id] ? (gn > 1 ? 'Пати ' + gl[p.id] : 'Пати') : null })),
      maps: m.maps, bans: m.bans, turn: m.turn, turnDeadline: m.turnDeadline, map: m.map, liveAt: m.liveAt || null,
      host: host ? { nick: host.nick, soid: me ? host.soid : null } : null,
      me: me ? { team: myTeam, captain: !!myTeam && m.captains[myTeam] === vid, host: m.host === vid, votedCancel: votes.includes(vid) } : null,
      fc: me && myTeam && ['veto', 'live'].includes(m.state) && isPrem(vid) ? forecast(m, myTeam) : null,
      reports: { A: !!m.reports.A, B: !!m.reports.B },
      claim: c ? { team: c.team, result: c.result, nick: nickOf(c.by || m.captains[c.team]), at: c.at, until: c.at + CLAIM_WAIT, mine: c.by === vid, n: c.n || 1, left: CHANGES - (c.n || 1) } : null,
      claimFrom: m.state === 'live' && !m.test && m.liveAt ? m.liveAt + CLAIM_MIN : null,
      said, disputedMe: !!(d && d.uid === vid), how: m.how || null,
      proofs: hasTeams(m) && (me || isAdminId(vid)) ? proofsBy(m).map(x => ({ nick: x.nick, n: x.n, me: x.id === vid })) : [],
      cancelVotes: votes.length, cancelNeed: Math.floor(m.players.length / 2) + 1,
      scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, cancelReason: m.cancelReason || null, disputeReason: m.disputeReason || null, finishedAt: m.finishedAt || null,
      missedMe: m.missed && vid && vid in m.missed ? m.missed[vid] : null,
      chat: chatOpen(m) ? 'open' : m.chat && m.chat.length ? 'read' : null,
      fb: me && fbOpen(m) ? { until: endedAt(m) + FB_TTL, c: ((m.fb || {}).c || []).filter(x => x[0] === vid).map(x => nickOf(x[1])), r: ((m.fb || {}).r || []).filter(x => x[0] === vid).map(x => nickOf(x[1])) } : null,
    };
  }
  function notify(m) { for (const p of real(m)) sendTo(p.id, { type: 'match', match: view(m, p.id) }); }
  const summary = m => ({ id: m.id, mode: m.mode, map: m.map, test: m.test, scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, date: m.finishedAt,
    players: m.players.map(p => ({ nick: p.nick, team: p.team, elo: p.elo, captain: m.captains.A === p.id ? 'A' : m.captains.B === p.id ? 'B' : null, delta: m.deltas ? m.deltas[p.id] : null, win: m.winner === p.team, draw: m.winner === 'draw' })) });
  const history = (nick, withTest) => db.matches.filter(m => m.state === 'finished' && (withTest || !m.test) && (!nick || m.players.some(p => p.nick.toLowerCase() === nick)))
    .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 100).map(summary);

  function testMatch(admin, mode) {
    if (!MODES[mode]) return { error: 'Неизвестный режим' };
    const am = matchOf(admin.id); if (am) return { error: 'У вас уже есть активный матч', match: am.id };
    leave(admin.id, true);
    const bots = Array.from({ length: MODES[mode] - 1 }, (_, i) => ({ id: 'bot-' + crypto.randomBytes(3).toString('hex'), nick: 'Бот_' + (i + 1), elo: Math.max(100, admin.elo - rnd(10, 220)), soid: '000000', bot: true }));
    return { ok: true, match: createMatch(mode, [admin, ...bots], true) };
  }
  // для админки: идущие и спорные матчи
  const adminList = () => open().filter(m => m.state !== 'accept').sort((a, b) => (a.state === 'dispute' ? -1 : 0) - (b.state === 'dispute' ? -1 : 0) || b.created - a.created)
    .map(m => { const c = m.state === 'live' ? claimOf(m) : null, d = m.disputedBy;
      return { ...summary(m), state: m.state, created: m.created, liveAt: m.liveAt || null, disputeReason: m.disputeReason || null,
        reports: Object.fromEntries(['A', 'B'].filter(t => m.reports[t]).map(t => [t, { result: m.reports[t].result, at: m.reports[t].at, nick: nickOf(m.reports[t].by || m.captains[t]), n: m.reports[t].n || 1 }])),
        until: c ? c.at + CLAIM_WAIT : null, disputedBy: d ? { nick: d.nick, team: d.team, says: d.says, text: d.text, at: d.at } : null,
        proofs: proofsBy(m).map(x => ({ nick: x.nick, n: x.n })) }; });

  return { join, leave, stopFor, inQueue, queueEntry, searching, searchingBy, liveCount, matchOf, find, view, accept, decline, ban, claim, agree, dispute, voteCancel, adminResolve, history, testMatch, adminList,
    proofCheck, disputedOf, addProof, banOf, missCount, setBan, chatList, chatSend, fbOpen, P, MAPS, MODES, MODE_NAME, PROOF_MAX };
};
