// tasks.js — ежедневные задания, бонус за вход и монеты. День считается по Москве: задания обновляются в 00:00 МСК
const DAY = 24 * 3600e3, MSK = 3 * 3600e3;
const dayKey = (t = Date.now()) => new Date(t + MSK).toISOString().slice(0, 10);
const nextReset = (t = Date.now()) => { const d = new Date(t + MSK); d.setUTCHours(24, 0, 0, 0); return d.getTime() - MSK; };
// каждый день — по одному заданию из каждой группы (выбор зависит только от даты, у всех одинаковый)
const POOL = [
  [{ id: 'play1', key: 'play', goal: 1, reward: 20, title: 'Сыграйте 1 матч', ic: '🎮' }, { id: 'play3', key: 'play', goal: 3, reward: 50, title: 'Сыграйте 3 матча', ic: '🎮' }],
  [{ id: 'win1', key: 'win', goal: 1, reward: 30, title: 'Выиграйте матч', ic: '🏆' }, { id: 'win2', key: 'win', goal: 2, reward: 60, title: 'Выиграйте 2 матча', ic: '🏆' }],
  [{ id: 'party', key: 'party', goal: 1, reward: 40, title: 'Сыграйте матч в пати с другом', ic: '👥' }, { id: 'commend', key: 'commend', goal: 1, reward: 15, title: 'Скажите «Спасибо» тиммейту после матча', ic: '👍' },
   { id: 'm5v5', key: 'm5v5', goal: 1, reward: 30, title: 'Сыграйте матч 5 на 5', ic: '⚔️' }, { id: 'm2v2', key: 'm2v2', goal: 1, reward: 30, title: 'Сыграйте матч 2 на 2', ic: '⚔️' }],
];
// Premium-задание дня: одно в день, награда побольше (без множителя). Видят все, забрать может только Premium
const PREM_POOL = [
  { id: 'pwin3', key: 'win', goal: 3, reward: 150, title: 'Выиграйте 3 матча', ic: '💎' }, { id: 'pplay5', key: 'play', goal: 5, reward: 120, title: 'Сыграйте 5 матчей', ic: '💎' },
  { id: 'pparty2', key: 'party', goal: 2, reward: 120, title: 'Сыграйте 2 матча в пати с друзьями', ic: '💎' },
];
const PREM_MULT = 1.5; // Premium: +50% монет за задания, сундук и бонус за вход
const ALL_BONUS = 50;
const hashStr = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
const tasksFor = day => POOL.map((g, i) => g[hashStr(day + ':' + i) % g.length]);
const premFor = day => PREM_POOL[hashStr(day + ':prem') % PREM_POOL.length];
const bonusFor = streak => 10 + 5 * (Math.min(Math.max(streak, 1), 7) - 1); // 10, 15 … 40 монет за 7+ дней подряд

module.exports = function ({ db, save, sendTo, isPrem = () => false }) {
  const user = id => db.users.find(u => u.id === id && u.verified);
  function cur(u) { const day = dayKey(); if (!u.daily || u.daily.day !== day) u.daily = { day, prog: {}, got: [] }; return u.daily; }
  // серия бонусов: если вчера забрали — сегодня на день больше, иначе начинается заново
  function streakNow(u) { const s = u.streak || {}, d = dayKey(); return s.day === d ? s.n : s.day === dayKey(Date.now() - DAY) ? s.n + 1 : 1; }
  function state(uid) {
    const u = user(uid); if (!u) return { type: 'tasks', coins: 0, ready: 0 };
    const d = cur(u), st = streakNow(u), prem = isPrem(u), k = prem ? PREM_MULT : 1, pt = premFor(d.day);
    const list = tasksFor(d.day).map(t => ({ id: t.id, title: t.title, ic: t.ic, goal: t.goal, prog: Math.min(t.goal, d.prog[t.key] || 0), reward: Math.round(t.reward * k), got: d.got.includes(t.id) }));
    const bonus = { got: d.got.includes('bonus'), amount: Math.round(bonusFor(st) * k), streak: st };
    const all = { reward: Math.round(ALL_BONUS * k), done: list.every(t => t.prog >= t.goal), got: d.got.includes('all') };
    const ptask = { id: pt.id, title: pt.title, ic: pt.ic, goal: pt.goal, prog: Math.min(pt.goal, d.prog[pt.key] || 0), reward: pt.reward, got: d.got.includes(pt.id), locked: !prem };
    const ready = (bonus.got ? 0 : 1) + list.filter(t => t.prog >= t.goal && !t.got).length + (all.done && !all.got ? 1 : 0) + (prem && ptask.prog >= ptask.goal && !ptask.got ? 1 : 0);
    return { type: 'tasks', day: d.day, coins: u.coins || 0, resetAt: nextReset(), bonus, list, all, ptask, prem, mult: k, ready };
  }
  const push = (uid, note) => sendTo(uid, note ? { ...state(uid), note } : state(uid));
  // прогресс: add = { play: 1, win: 1, ... }. Если задание только что выполнено — сообщаем игроку
  function bump(uid, add) {
    const u = user(uid); if (!u) return;
    const d = cur(u), mine = tasksFor(d.day).concat(isPrem(u) ? [premFor(d.day)] : []), was = mine.filter(t => (d.prog[t.key] || 0) >= t.goal).map(t => t.id);
    for (const k in add) d.prog[k] = (d.prog[k] || 0) + add[k];
    const nw = mine.filter(t => (d.prog[t.key] || 0) >= t.goal && !was.includes(t.id));
    save(); push(uid, nw.length ? `✅ Задание выполнено: «${nw[0].title}» — заберите награду в «Заданиях»` : null);
  }
  // матч завершён (не тестовый): сыграл, победил, в пати, режим
  function onFinish(m) {
    const groups = m.groups || [];
    for (const p of m.players) {
      if (p.bot) continue;
      const add = { play: 1, ['m' + m.mode]: 1 };
      if (m.winner === p.team) add.win = 1;
      if (groups.some(g => g.length > 1 && g.includes(p.id))) add.party = 1;
      bump(p.id, add);
    }
  }
  function claim(u, id) {
    const d = cur(u), prem = isPrem(u), k = prem ? PREM_MULT : 1, pt = premFor(d.day); let amount;
    if (d.got.includes(id)) return { error: 'Эта награда уже получена' };
    if (id === 'bonus') { const st = streakNow(u); amount = Math.round(bonusFor(st) * k); u.streak = { day: d.day, n: st }; }
    else if (id === 'all') { if (!tasksFor(d.day).every(t => (d.prog[t.key] || 0) >= t.goal)) return { error: 'Сначала выполните все задания дня' }; amount = Math.round(ALL_BONUS * k); }
    else if (id === pt.id) {
      if (!prem) return { error: 'Premium-задание доступно только с StandHub Premium', code: 'premium' };
      if ((d.prog[pt.key] || 0) < pt.goal) return { error: 'Задание ещё не выполнено' };
      amount = pt.reward;
    } else {
      const t = tasksFor(d.day).find(x => x.id === id); if (!t) return { error: 'Задание не найдено — возможно, наступил новый день' };
      if ((d.prog[t.key] || 0) < t.goal) return { error: 'Задание ещё не выполнено' };
      amount = Math.round(t.reward * k);
    }
    d.got.push(id); u.coins = (u.coins || 0) + amount; save(); push(u.id);
    return { ok: true, amount, coins: u.coins, boost: prem && id !== pt.id };
  }
  return { state, bump, onFinish, claim, dayKey, tasksFor };
};
