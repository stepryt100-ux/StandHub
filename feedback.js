// feedback.js — после матча: «Спасибо» игрокам и жалобы. Админ разбирает жалобы и может закрыть игроку поиск матчей
const crypto = require('crypto');
const DAY = 24 * 3600e3;
const REASONS = { cheat: 'Читы', left: 'Ушёл / не зашёл в лобби', toxic: 'Оскорбления', result: 'Неверный результат', other: 'Другое' };

module.exports = function ({ db, save, sendTo, tell, go, escH, alertAdmins, match, tasks, onChange }) {
  db.reports = db.reports || []; // { id, mid, from, to, reason, text, at, status: 'open'|'closed', res, closedAt }
  const user = id => db.users.find(u => u.id === id && u.verified);
  const nick = id => (user(id) || {}).nick || 'Игрок';
  // общие проверки: матч есть, я в нём играл, сутки не прошли, второй игрок — живой человек из этого матча
  function pick(u, mid, toNick) {
    const m = match.find(String(mid || '')); if (!m) return { error: 'Матч не найден' };
    const me = match.P(m, u.id); if (!me) return { error: 'Вы не играли в этом матче' };
    if (!match.fbOpen(m)) return { error: 'Оценить игроков можно только в течение суток после матча' };
    const p = m.players.find(x => !x.bot && x.nick.toLowerCase() === String(toNick || '').trim().toLowerCase());
    if (!p) return { error: 'Игрок не найден в этом матче' };
    if (p.id === u.id) return { error: 'Себя оценить нельзя 🙂' };
    m.fb = m.fb || {}; m.fb.c = m.fb.c || []; m.fb.r = m.fb.r || [];
    return { m, me, p };
  }
  function commend(u, mid, toNick) {
    const x = pick(u, mid, toNick); if (x.error) return x;
    const { m, me, p } = x;
    if (m.fb.c.some(c => c[0] === u.id && c[1] === p.id)) return { error: `Вы уже сказали «Спасибо» игроку ${p.nick}` };
    m.fb.c.push([u.id, p.id]);
    const t = user(p.id); if (t) t.commends = (t.commends || 0) + 1;
    save();
    sendTo(p.id, { type: 'toast', text: `👍 ${u.nick} говорит вам «Спасибо» за матч` });
    if (me.team && me.team === p.team) tasks.bump(u.id, { commend: 1 });
    return { ok: true, nick: p.nick };
  }
  function flag(u, mid, toNick, reason, text) {
    const x = pick(u, mid, toNick); if (x.error) return x;
    const { m, p } = x;
    if (!REASONS[reason]) return { error: 'Выберите причину жалобы' };
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (reason === 'other' && text.length < 5) return { error: 'Опишите, что произошло' };
    if (m.fb.r.some(r => r[0] === u.id && r[1] === p.id)) return { error: `Вы уже отправили жалобу на ${p.nick} за этот матч` };
    if (db.reports.filter(r => r.from === u.id && Date.now() - r.at < DAY).length >= 10) return { error: 'Слишком много жалоб за сутки — попробуйте завтра' };
    const r = { id: crypto.randomBytes(6).toString('hex'), mid: m.id, from: u.id, to: p.id, reason, text, at: Date.now(), status: 'open' };
    db.reports.push(r); m.fb.r.push([u.id, p.id]); save();
    alertAdmins(`🚩 <b>Жалоба</b>: ${escH(u.nick)} → <b>${escH(p.nick)}</b>\nПричина: ${REASONS[reason]}${text ? `\n«${escH(text)}»` : ''}\nМатч #${m.id} · ${match.MODE_NAME[m.mode]}${m.map ? ' · ' + escH(m.map) : ''}\n${go('/#/admin/reports')}`);
    onChange();
    return { ok: true, nick: p.nick };
  }
  // ---------- админка ----------
  const openCount = () => db.reports.filter(r => r.status === 'open').length;
  function adminList() {
    const view = r => {
      const m = match.find(r.mid) || {}, t = user(r.to);
      return { id: r.id, mid: r.mid, map: m.map || null, mode: m.mode || null, matchAt: m.endedAt || m.finishedAt || m.created || null, from: nick(r.from), to: nick(r.to), reason: REASONS[r.reason] || r.reason, text: r.text,
        at: r.at, status: r.status, res: r.res || null, against: db.reports.filter(x => x.to === r.to && Date.now() - x.at < 30 * DAY).length,
        commends: t ? t.commends || 0 : 0, ban: t ? match.banOf(t) : null };
    };
    const open = db.reports.filter(r => r.status === 'open').sort((a, b) => a.at - b.at);
    const closed = db.reports.filter(r => r.status !== 'open').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 30);
    return { open: open.map(view), closed: closed.map(view) };
  }
  const RES = { close: 'Закрыта без наказания', ban1: 'Запрет поиска на 1 день', ban7: 'Запрет поиска на 7 дней', unban: 'Запрет снят' };
  function adminAct(rid, act) {
    const r = db.reports.find(x => x.id === rid); if (!r) return { error: 'Жалоба не найдена' };
    if (!RES[act]) return { error: 'Неизвестное действие' };
    const t = user(r.to); if (!t && act !== 'close') return { error: 'Игрок не найден' };
    const close = x => { x.status = 'closed'; x.res = RES[act]; x.closedAt = Date.now(); };
    if (act === 'ban1' || act === 'ban7') {
      const days = act === 'ban1' ? 1 : 7, why = `решение администратора (жалоба: ${REASONS[r.reason] || 'нарушение'})`;
      match.setBan(t.id, Date.now() + days * DAY, why);
      // все открытые жалобы на этого игрока закрываем этим же решением
      for (const x of db.reports) if (x.to === r.to && x.status === 'open') close(x);
      tell(t.id, `⛔ Поиск матчей на StandHub закрыт на <b>${days === 1 ? '1 день' : '7 дней'}</b> по решению администратора.\nПричина: жалоба игроков (${REASONS[r.reason] || 'нарушение'}).\nЕсли это ошибка — напишите в поддержку:\n${go('/#/support')}`);
    } else if (act === 'unban') {
      match.setBan(t.id, 0); if (r.status === 'open') close(r);
      tell(t.id, `✅ Запрет на поиск матчей снят — можно снова играть:\n${go('/#/lobby')}`);
    } else close(r);
    save(); onChange();
    return { ok: true, res: RES[act] };
  }
  return { commend, flag, adminList, adminAct, openCount, REASONS };
};
