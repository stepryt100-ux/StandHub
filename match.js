// match.js — очередь, «матч найден», команды, вето карт, хост, результаты по скриншотам, ELO
const crypto = require('crypto');
const MODES = { '5v5': 10, '2v2': 4, '1v1': 2 };
const MODE_NAME = { '5v5': '5 на 5', '2v2': '2 на 2', '1v1': '1 на 1' };
const MAPS = ['Sandstone', 'Rust', 'Province', 'Zone 7', 'Hanami', 'Breeze', 'Dune', 'Sakura'];
const ACCEPT_SEC = 15, BAN_SEC = 20;
const SINGLE_REPORT_WAIT = 30 * 60e3; // если загрузил только один капитан — ждём второго 30 минут
const MATCH_TTL = 3 * 3600e3;          // матч без результата отменяется через 3 часа
const K = 50;                          // равные команды: +25 / −25
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const other = t => (t === 'A' ? 'B' : 'A');

module.exports = function (ctx) {
  const { db, save, sendTo, broadcast, ocr, avatarOf } = ctx;
  const tell = ctx.tell || (() => {}), alertAdmins = ctx.alertAdmins || (() => {}), site = ctx.siteUrl || '';
  const queues = { '5v5': [], '2v2': [], '1v1': [] };
  const userById = id => db.users.find(u => u.id === id);
  const OPEN = ['accept', 'veto', 'live', 'dispute'];   // ещё не закрытые матчи
  const BUSY = ['accept', 'veto', 'live'];              // игрок занят и не может искать новый матч
  const open = () => db.matches.filter(m => OPEN.includes(m.state));
  const matchOf = uid => db.matches.find(m => BUSY.includes(m.state) && m.players.some(p => p.id === uid));
  const queueEntry = uid => { for (const k in queues) { const q = queues[k].find(x => x.uid === uid); if (q) return { mode: k, waited: Date.now() - q.joined }; } return null; };
  const inQueue = uid => (queueEntry(uid) || {}).mode || null;
  const searching = () => Object.values(queues).reduce((a, q) => a + q.length, 0);
  const searchingBy = () => Object.fromEntries(Object.keys(queues).map(k => [k, queues[k].length])); // сколько ищут в каждом режиме
  const liveCount = () => db.matches.filter(m => !m.test && ['veto', 'live'].includes(m.state)).length;
  const find = id => db.matches.find(m => m.id === id);
  const P = (m, id) => m.players.find(p => p.id === id);
  const cap = (m, t) => P(m, m.captains[t]);
  const real = m => m.players.filter(p => !p.bot);
  // ссылка словом «StandHub» вместо длинного адреса
  const go = path => `👉 <a href="${site}${path}">StandHub</a>`;
  const link = m => go('/#/match/' + m.id);

  // ---------- очередь ----------
  function join(u, mode) {
    if (!MODES[mode]) return { error: 'Неизвестный режим' };
    const am = matchOf(u.id); if (am) return { error: 'У вас уже есть активный матч', match: am.id };
    leave(u.id, true);
    queues[mode].push({ uid: u.id, joined: Date.now(), prio: Date.now() });
    broadcast(); tick(); return { ok: true, mode };
  }
  function leave(uid, silent) { for (const k in queues) queues[k] = queues[k].filter(q => q.uid !== uid); if (!silent) broadcast(); }

  // подбор: самый долго ждущий + ближайшие по ELO; допуск по ELO растёт со временем ожидания. Регион не учитывается.
  function tick() {
    for (const mode in queues) {
      const N = MODES[mode];
      for (;;) {
        const q = queues[mode].filter(x => userById(x.uid) && !matchOf(x.uid)).sort((a, b) => a.prio - b.prio);
        queues[mode] = q;
        if (q.length < N) break;
        const first = q[0], fu = userById(first.uid);
        const range = Math.min(1500, 150 + ((Date.now() - first.prio) / 1000) * 10);
        const cands = q.slice(1).map(x => ({ x, u: userById(x.uid) })).filter(c => Math.abs(c.u.elo - fu.elo) <= range)
          .sort((a, b) => Math.abs(a.u.elo - fu.elo) - Math.abs(b.u.elo - fu.elo)).slice(0, N - 1);
        if (cands.length < N - 1) break;
        const picked = [first, ...cands.map(c => c.x)];
        queues[mode] = q.filter(x => !picked.includes(x));
        createMatch(mode, picked.map(x => userById(x.uid)), false);
      }
    }
  }

  // ---------- матч ----------
  function createMatch(mode, users, test) {
    const m = {
      id: crypto.randomBytes(5).toString('hex'), mode, test: !!test, state: 'accept', created: Date.now(),
      acceptDeadline: Date.now() + ACCEPT_SEC * 1000, accepted: [],
      players: users.map(u => ({ id: u.id, nick: u.nick, elo: u.elo, soid: u.soid, avatar: u.bot ? null : avatarOf(u), bot: !!u.bot, team: null })),
      captains: {}, host: null, maps: MAPS.slice(), bans: [], turn: null, turnDeadline: null, map: null,
      reports: {}, pending: {}, cancelVotes: [], scoreA: null, scoreB: null, winner: null, deltas: null,
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
    m.state = 'cancelled'; m.cancelReason = 'Не все игроки приняли матч'; m.requeued = [];
    if (!m.test) for (const p of real(m)) if (!bad.includes(p.id)) { // принявшие — снова в поиск, впереди очереди
      leave(p.id, true); queues[m.mode].push({ uid: p.id, joined: Date.now(), prio: Date.now() - 120e3 }); m.requeued.push(p.id);
    }
    save(); notify(m); broadcast(); setTimeout(tick, 500);
  }
  // делим поровну по ELO (перебор всех вариантов)
  function balance(players) {
    const n = players.length, h = n / 2, total = players.reduce((a, p) => a + p.elo, 0);
    let best = null, bestDiff = Infinity;
    const rec = (start, pick) => {
      if (pick.length === h) { const s = pick.reduce((a, i) => a + players[i].elo, 0); const d = Math.abs(total - 2 * s); if (d < bestDiff) { bestDiff = d; best = pick.slice(); } return; }
      for (let i = start; i < n; i++) { pick.push(i); rec(i + 1, pick); pick.pop(); }
    };
    rec(0, []);
    return best;
  }
  function startVeto(m) {
    const idx = balance(m.players);
    m.players.forEach((p, i) => (p.team = idx.includes(i) ? 'X' : 'Y'));
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

  // ---------- результат по скриншоту ----------
  function parseResult(text) {
    const T = text.toUpperCase().replace(/Ё/g, 'Е');
    const win = /(ПОБЕД|VICTORY|\bWIN\b|\bWON\b|\bWINNER)/.test(T), loss = /(ПОРАЖЕН|ПРОИГР|DEFEAT|\bLOSE\b|\bLOST\b)/.test(T), draw = /(НИЧЬЯ|\bDRAW\b)/.test(T);
    let result = draw ? 'draw' : win && !loss ? 'win' : loss && !win ? 'loss' : null;
    const ok = (a, b) => (a === 13 && b <= 12) || (b === 13 && a <= 12) || (a === 12 && b === 12);
    let score = null;
    const N = s => s.replace(/[OОoо]/g, '0').replace(/[IlІ|]/g, '1');
    for (const line of T.split('\n')) { const x = N(line).match(/(\d{1,2})\s*[:\-–—]\s*(\d{1,2})/); if (x && ok(+x[1], +x[2])) { score = [+x[1], +x[2]]; break; } }
    if (!score) { const nums = (N(T).match(/\b\d{1,2}\b/g) || []).map(Number); for (let i = 0; i < nums.length - 1; i++) if (ok(nums[i], nums[i + 1])) { score = [nums[i], nums[i + 1]]; break; } }
    if (!result && score && score[0] === 12 && score[1] === 12) result = 'draw';
    return { result, score };
  }
  async function report(mid, uid, bufs) {
    let m = find(mid); if (!m || m.state !== 'live') return { error: 'Сейчас нельзя загрузить результат' };
    const team = ['A', 'B'].find(t => m.captains[t] === uid); if (!team) return { error: 'Скриншот загружают только капитаны' };
    const parsed = { result: null, score: null };
    try {
      for (const b of bufs) { const r = parseResult(await ocr(b)); parsed.result = parsed.result || r.result; parsed.score = parsed.score || r.score; if (parsed.result && parsed.score) break; }
    } catch (e) { console.error(e); return { error: 'Не удалось обработать картинку, попробуйте ещё раз' }; }
    // сам скриншот нигде не сохраняется — дальше работаем только с распознанным результатом
    m = find(mid); if (!m || m.state !== 'live') return { error: 'Матч уже завершён' };
    if (!parsed.result && !parsed.score) return { error: 'Не получилось распознать счёт. Загрузите чёткий скриншот итогового экрана матча целиком.' };
    if (!parsed.result) { m.pending[team] = { score: parsed.score }; save(); notify(m); return { needResult: true, score: parsed.score }; }
    return submit(m, team, parsed.result, parsed.score);
  }
  function confirm(mid, uid, result) {
    const m = find(mid); if (!m || m.state !== 'live') return { error: 'Сейчас нельзя отправить результат' };
    const team = ['A', 'B'].find(t => m.captains[t] === uid); if (!team) return { error: 'Результат отправляют только капитаны' };
    if (!['win', 'loss'].includes(result)) return { error: 'Неверный ответ' };
    if (m.pending[team]) { const sc = m.pending[team].score; return submit(m, team, result, sc); }
    if (m.test) return submit(m, team, result, [13, rnd(3, 11)]); // тестовый матч: можно без скриншота
    return { error: 'Сначала загрузите скриншот' };
  }
  function submit(m, team, result, score) {
    m.reports[team] = { result, score, at: Date.now() }; delete m.pending[team];
    const oc = cap(m, other(team));
    if (m.test && oc.bot) m.reports[other(team)] = { result: result === 'draw' ? 'draw' : result === 'win' ? 'loss' : 'win', score, at: Date.now() };
    resolve(m, false); return { ok: true };
  }
  const winnerOf = (team, r) => (r.result === 'draw' ? 'draw' : r.result === 'win' ? team : other(team));
  function resolve(m, force) {
    const A = m.reports.A, B = m.reports.B;
    if (A && B) {
      const wa = winnerOf('A', A), wb = winnerOf('B', B);
      if (wa === wb) return finish(m, wa, A.score || B.score);
      m.state = 'dispute'; m.disputeReason = 'Результаты капитанов не совпадают'; save(); notify(m); broadcast();
      alertAdmins(`⚠️ Спорный матч ${m.id} (${MODE_NAME[m.mode]}, ${m.map}): капитаны прислали разные результаты.\n${go('/#/admin')}`);
      return;
    }
    if (force && (A || B)) { const t = A ? 'A' : 'B'; return finish(m, winnerOf(t, m.reports[t]), m.reports[t].score); }
    save(); notify(m);
  }
  function finish(m, winner, score) {
    m.winner = winner;
    if (score) { const hi = Math.max(...score), lo = Math.min(...score); [m.scoreA, m.scoreB] = winner === 'A' ? [hi, lo] : winner === 'B' ? [lo, hi] : [score[0], score[1]]; }
    const avg = t => { const ps = m.players.filter(p => p.team === t); return ps.reduce((a, p) => a + p.elo, 0) / ps.length; };
    const expA = 1 / (1 + Math.pow(10, (avg('B') - avg('A')) / 400));
    const dA = Math.round(K * ((winner === 'A' ? 1 : winner === 'draw' ? 0.5 : 0) - expA));
    m.deltas = {}; for (const p of m.players) m.deltas[p.id] = p.team === 'A' ? dA : -dA;
    if (!m.test) for (const p of m.players) {
      const u = userById(p.id); if (!u) continue;
      u.elo = Math.max(100, u.elo + m.deltas[p.id]); u.matches += 1; if (winner === p.team) u.wins += 1;
    }
    m.state = 'finished'; m.finishedAt = Date.now(); save(); notify(m); broadcast();
    for (const p of real(m)) {
      const d = m.deltas[p.id], res = winner === 'draw' ? 'Ничья' : winner === p.team ? '🏆 Победа' : 'Поражение';
      tell(p.id, `${res}${m.scoreA != null ? ` ${p.team === 'A' ? m.scoreA + ':' + m.scoreB : m.scoreB + ':' + m.scoreA}` : ''} · ${m.map}\nELO: ${d >= 0 ? '+' : ''}${d}${m.test ? ' (тестовый матч — рейтинг не меняется)' : ''}\n${link(m)}`);
    }
  }
  function cancel(m, reason) { m.state = 'cancelled'; m.cancelReason = reason; save(); notify(m); broadcast(); }
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
  function adminResolve(mid, winner) {
    const m = find(mid); if (!m || !['live', 'dispute', 'veto', 'accept'].includes(m.state)) return { error: 'Матч уже завершён' };
    if (winner === 'cancel') { cancel(m, 'Матч отменён администратором'); return { ok: true }; }
    if (!['A', 'B', 'draw'].includes(winner) || !m.map) return { error: 'Неверный победитель' };
    const r = m.reports.A || m.reports.B; finish(m, winner, r && r.score); return { ok: true };
  }

  // таймеры: принятие, ход в вето, ожидание результата
  setInterval(() => {
    const now = Date.now();
    for (const m of open()) {
      if (m.state === 'accept' && now > m.acceptDeadline) cancelAccept(m, m.players.filter(p => !m.accepted.includes(p.id)).map(p => p.id));
      else if (m.state === 'veto' && now > m.turnDeadline) { const r = remaining(m); ban(m.id, null, r[rnd(0, r.length - 1)], true); }
      else if (m.state === 'live') {
        const reps = Object.values(m.reports);
        if (reps.length === 1 && now - reps[0].at > SINGLE_REPORT_WAIT) resolve(m, true);
        else if (!reps.length && now - m.liveAt > MATCH_TTL) cancel(m, 'Капитаны не загрузили результат');
      }
    }
  }, 1000);
  setInterval(tick, 2000);

  // ---------- что видит игрок ----------
  function view(m, vid) {
    const me = P(m, vid), host = P(m, m.host), myTeam = me && me.team;
    const rep = r => r && { result: r.result, score: r.score };
    const votes = m.cancelVotes || [];
    return {
      id: m.id, mode: m.mode, test: m.test, state: m.state, now: Date.now(), created: m.created,
      acceptDeadline: m.acceptDeadline, accepted: m.accepted.length, total: m.players.length, iAccepted: m.accepted.includes(vid), requeuedMe: !!(m.requeued && m.requeued.includes(vid)),
      players: m.players.map(p => ({ nick: p.nick, elo: p.elo, avatar: p.avatar, bot: p.bot, team: m.state === 'accept' ? null : p.team,
        captain: m.captains.A === p.id ? 'A' : m.captains.B === p.id ? 'B' : null, host: p.id === m.host, me: p.id === vid,
        accepted: m.accepted.includes(p.id), delta: m.deltas ? m.deltas[p.id] : null })),
      maps: m.maps, bans: m.bans, turn: m.turn, turnDeadline: m.turnDeadline, map: m.map, liveAt: m.liveAt || null,
      host: host ? { nick: host.nick, soid: me ? host.soid : null } : null,
      me: me ? { team: myTeam, captain: !!myTeam && m.captains[myTeam] === vid, host: m.host === vid, votedCancel: votes.includes(vid) } : null,
      reports: { A: !!m.reports.A, B: !!m.reports.B }, myReport: me && myTeam ? rep(m.reports[myTeam]) : null,
      pendingScore: me && myTeam && m.pending[myTeam] ? m.pending[myTeam].score : null,
      cancelVotes: votes.length, cancelNeed: Math.floor(m.players.length / 2) + 1,
      scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, cancelReason: m.cancelReason || null, disputeReason: m.disputeReason || null, finishedAt: m.finishedAt || null,
    };
  }
  function notify(m) { for (const p of real(m)) sendTo(p.id, { type: 'match', match: view(m, p.id) }); }
  const summary = m => ({ id: m.id, mode: m.mode, map: m.map, test: m.test, scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, date: m.finishedAt,
    players: m.players.map(p => ({ nick: p.nick, team: p.team, captain: m.captains.A === p.id ? 'A' : m.captains.B === p.id ? 'B' : null, delta: m.deltas ? m.deltas[p.id] : null, win: m.winner === p.team, draw: m.winner === 'draw' })) });
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
    .map(m => ({ ...summary(m), state: m.state, created: m.created, reports: m.reports, disputeReason: m.disputeReason || null }));

  return { join, leave, inQueue, queueEntry, searching, searchingBy, liveCount, matchOf, find, view, accept, decline, ban, report, confirm, voteCancel, adminResolve, history, testMatch, adminList, MAPS };
};
