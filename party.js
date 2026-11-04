// party.js — пати: приглашения друзей, общий поиск матча (запускает лидер), лидер выбирает режим
const crypto = require('crypto');
const INV_TTL = 10 * 60e3; // приглашение действует 10 минут
const OFF_TTL = 10 * 60e3; // кто 10 минут не на сайте (и не в матче) — выходит из пати
const MAX = 5;
const MODE_MAX = { '5v5': 5, '2v2': 2, '1v1': 1 };
const MODE_NAME = { '5v5': '5 на 5', '2v2': '2 на 2', '1v1': '1 на 1' };
const escH = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const players = n => n + ' ' + (n === 1 ? 'игрок' : n < 5 ? 'игрока' : 'игроков');
// режим, в который помещается пати такого размера
const fit = (mode, n) => (MODE_MAX[mode] >= n ? mode : n <= 2 ? '2v2' : '5v5');

module.exports = function ({ db, save, sendTo, tell, go, pub, isOnline, match }) {
  db.parties = (db.parties || []).filter(p => p.members && p.members.length >= 2); // { id, leader, members: [uid], mode, created }
  db.pinv = db.pinv || [];                                                         // приглашения: { id, from, to, mode, at }
  const noUntil = new Map(), tgAt = new Map(), offSince = new Map();
  const user = id => db.users.find(u => u.id === id && u.verified);
  const nick = id => (user(id) || {}).nick || 'Игрок';
  const partyOf = uid => db.parties.find(p => p.members.includes(uid)) || null;
  const alive = r => Date.now() - r.at < INV_TTL && !!user(r.from) && !!user(r.to);
  const card = u => ({ ...pub(u), online: isOnline(u.id), inMatch: !!match.matchOf(u.id) });
  const groupOf = uid => { const pt = partyOf(uid); return pt ? pt.members.slice() : [uid]; };
  // приглашения «от пати» — от любого её игрока (или от самого игрока, если он без пати)
  const sentFrom = ids => db.pinv.filter(r => ids.includes(r.from) && alive(r));
  const invitedBy = ids => db.pinv.filter(r => ids.includes(r.from)).map(r => r.to);

  function state(uid) {
    const pt = partyOf(uid);
    return {
      type: 'party',
      party: pt && { id: pt.id, mode: pt.mode, leader: nick(pt.leader), members: pt.members.map(user).filter(Boolean).map(u => ({ ...card(u), leader: u.id === pt.leader })) },
      sent: sentFrom(groupOf(uid)).map(r => ({ id: r.id, by: nick(r.from), user: card(user(r.to)) })),
      invites: db.pinv.filter(r => r.to === uid && alive(r)).sort((a, b) => b.at - a.at).map(r => {
        const p2 = partyOf(r.from);
        return { id: r.id, from: card(user(r.from)), mode: p2 ? p2.mode : fit(r.mode, 2), size: p2 ? p2.members.length : 1 };
      }),
    };
  }
  // разослать новое состояние; note — всплывающее сообщение (тому, кто сам это сделал, не показываем)
  function push(ids, note, except) { for (const id of new Set(ids.filter(Boolean))) sendTo(id, note && id !== except ? { ...state(id), note } : state(id)); }
  const pushParty = pt => pt && push([...pt.members, ...invitedBy(pt.members)]);
  // игрокам пати — с сообщением, приглашённым — просто новое состояние
  const tellParty = (ids, note, except) => { push(ids, note, except); push(invitedBy(ids).filter(id => !ids.includes(id))); };

  function invite(me, toNick, mode) {
    const to = db.users.find(u => u.verified && u.nick.toLowerCase() === String(toNick || '').trim().toLowerCase());
    if (!to) return { error: 'Игрок не найден' };
    if (to.id === me.id) return { error: 'Это ваш аккаунт 🙂' };
    if (!(me.friends || []).includes(to.id)) return { error: `Позвать в пати можно только друга — сначала добавьте ${to.nick} в друзья` };
    const pt = partyOf(me.id), ids = groupOf(me.id), sent = sentFrom(ids);
    if (ids.includes(to.id)) return { error: `${to.nick} уже в вашем пати` };
    if (sent.some(r => r.to === to.id)) return { error: `${to.nick} уже приглашён(а) — ждём ответа` };
    if (ids.length + sent.length >= MAX) return { error: `В пати может быть не больше ${MAX} игроков` };
    const k = me.id + '>' + to.id;
    if ((noUntil.get(k) || 0) > Date.now()) return { error: `${to.nick} только что отклонил(а) приглашение — попробуйте через минуту` };
    db.pinv = db.pinv.filter(r => alive(r) && !(r.from === me.id && r.to === to.id));
    const r = { id: crypto.randomBytes(6).toString('hex'), from: me.id, to: to.id, mode: MODE_MAX[mode] ? mode : '5v5', at: Date.now() };
    db.pinv.push(r); save();
    push([...ids, to.id]);
    // в Телеграм — не чаще раза в 3 минуты от одного игрока одному другу
    if (Date.now() - (tgAt.get(k) || 0) > 3 * 60e3) {
      tgAt.set(k, Date.now());
      tell(to.id, `🎮 <b>${escH(me.nick)}</b> зовёт вас в пати на StandHub (${MODE_NAME[pt ? pt.mode : fit(r.mode, 2)]}).\nПримите приглашение на сайте — оно действует 10 минут:\n${go('/#/lobby')}`);
    }
    return { ok: true, nick: to.nick };
  }

  // выйти из пати (сам, исключили или давно не на сайте). Если остался один игрок — пати распускается
  function leaveParty(u, note, selfNote, except) {
    const pt = partyOf(u.id); if (!pt) return false;
    if (match.stopFor(pt.members)) note += ' · поиск остановлен';
    const gone = db.pinv.filter(r => r.from === u.id).map(r => r.to);
    db.pinv = db.pinv.filter(r => r.from !== u.id); // его приглашения больше не действуют
    pt.members = pt.members.filter(id => id !== u.id);
    let lead = '';
    if (pt.leader === u.id && pt.members.length) { pt.leader = pt.members[0]; if (pt.members.length >= 2) lead = `. Теперь лидер пати — ${nick(pt.leader)}`; }
    const rest = pt.members.slice();
    if (rest.length < 2) db.parties = db.parties.filter(x => x !== pt);
    offSince.delete(u.id); save();
    tellParty(rest, note + lead, except); push(gone.filter(id => !rest.includes(id)));
    sendTo(u.id, selfNote ? { ...state(u.id), note: selfNote } : state(u.id));
    return true;
  }

  function accept(me, id) {
    const r = db.pinv.find(x => x.id === id && x.to === me.id);
    if (!r || !alive(r)) { if (r) { db.pinv = db.pinv.filter(x => x !== r); save(); } push([me.id]); return { error: 'Приглашение уже не действует' }; }
    const from = user(r.from);
    db.pinv = db.pinv.filter(x => x !== r);
    let pt = partyOf(from.id);
    if (pt && pt.members.includes(me.id)) { save(); push([me.id]); return { ok: true, leader: nick(pt.leader) }; }
    if (pt && pt.members.length >= MAX) { save(); push([me.id, ...pt.members]); return { error: 'В этом пати уже нет свободных мест' }; }
    if (partyOf(me.id)) leaveParty(me, `${me.nick} перешёл(ла) в другое пати`);
    match.stopFor([me.id]);
    let note = `${me.nick} вступил(а) в пати`;
    if (pt) {
      if (match.stopFor(pt.members)) note += ' · поиск остановлен';
      pt.members.push(me.id);
      const m2 = fit(pt.mode, pt.members.length);
      if (m2 !== pt.mode) { pt.mode = m2; note += ` · режим теперь «${MODE_NAME[m2]}»`; }
    } else {
      if (match.stopFor([from.id])) note += ' · поиск остановлен';
      pt = { id: crypto.randomBytes(5).toString('hex'), leader: from.id, members: [from.id, me.id], mode: fit(r.mode, 2), created: Date.now() };
      db.parties.push(pt);
    }
    const ids = pt.members;
    db.pinv = db.pinv.filter(x => !(x.to === me.id && ids.includes(x.from))); // другие приглашения в это же пати больше не нужны
    offSince.delete(me.id); save();
    tellParty(pt.members, note, me.id);
    return { ok: true, leader: nick(pt.leader) };
  }
  function decline(me, id) {
    const r = db.pinv.find(x => x.id === id && x.to === me.id);
    if (!r) { push([me.id]); return { error: 'Приглашение уже не действует' }; }
    db.pinv = db.pinv.filter(x => x !== r); noUntil.set(r.from + '>' + me.id, Date.now() + 60e3); save();
    push([me.id]); push(groupOf(r.from), `${me.nick} отклонил(а) приглашение в пати`);
    return { ok: true };
  }
  // отменить приглашение может тот, кто позвал, или лидер пати
  function cancel(me, id) {
    const pt = partyOf(me.id);
    const r = db.pinv.find(x => x.id === id && (x.from === me.id || (pt && pt.leader === me.id && pt.members.includes(x.from))));
    if (!r) return { error: 'Приглашение не найдено' };
    db.pinv = db.pinv.filter(x => x !== r); save();
    push([...groupOf(me.id), r.to]);
    return { ok: true };
  }
  function kick(me, who) {
    const pt = partyOf(me.id); if (!pt) return { error: 'Вы не в пати' };
    if (pt.leader !== me.id) return { error: 'Исключать из пати может только лидер' };
    const t = pt.members.map(user).find(u => u && u.id !== me.id && u.nick.toLowerCase() === String(who || '').toLowerCase());
    if (!t) return { error: 'Этого игрока нет в пати' };
    leaveParty(t, `${t.nick} исключён(а) из пати`, `${me.nick} исключил(а) вас из пати`, me.id);
    return { ok: true, nick: t.nick };
  }
  function setMode(me, mode) {
    const pt = partyOf(me.id); if (!pt) return { error: 'Вы не в пати' };
    if (pt.leader !== me.id) return { error: `Режим выбирает лидер пати — ${nick(pt.leader)}` };
    if (!MODE_MAX[mode]) return { error: 'Неизвестный режим' };
    if (MODE_MAX[mode] < pt.members.length) return { error: mode === '1v1' ? 'В режиме «1 на 1» играют без пати' : `В пати ${players(pt.members.length)} — в режиме «${MODE_NAME[mode]}» можно максимум ${MODE_MAX[mode]}` };
    if (match.inQueue(me.id)) return { error: 'Сначала отмените поиск' };
    if (pt.mode !== mode) { pt.mode = mode; save(); tellParty(pt.members, `Лидер выбрал режим «${MODE_NAME[mode]}»`, me.id); }
    return { ok: true };
  }
  // кто-то зашёл на сайт или ушёл — обновляем пати (видно, кто на сайте)
  const touchT = new Map();
  function touch(uid) {
    const pt = partyOf(uid); if (!pt) return;
    if (isOnline(uid)) offSince.delete(uid);
    clearTimeout(touchT.get(pt.id)); touchT.set(pt.id, setTimeout(() => { touchT.delete(pt.id); pushParty(partyOf(uid)); }, 800));
  }
  // раз в 30 секунд: убираем устаревшие приглашения и тех, кто давно не на сайте
  setInterval(() => {
    const now = Date.now(), old = db.pinv.filter(r => !alive(r));
    if (old.length) { db.pinv = db.pinv.filter(alive); save(); for (const r of old) push([r.to, ...groupOf(r.from)]); }
    for (const pt of db.parties.slice()) for (const id of pt.members.slice()) {
      if (isOnline(id) || match.matchOf(id)) { offSince.delete(id); continue; }
      if (!offSince.has(id)) { offSince.set(id, now); continue; }
      if (now - offSince.get(id) < OFF_TTL || !partyOf(id)) continue;
      const u = db.users.find(x => x.id === id);
      if (u) leaveParty(u, `${u.nick} давно не на сайте и вышел(ла) из пати`);
      else { pt.members = pt.members.filter(x => x !== id); if (pt.members.length < 2) db.parties = db.parties.filter(x => x !== pt); save(); pushParty(pt); }
    }
  }, 30e3);

  return {
    state, partyOf, pushParty, touch, invite, accept, decline, cancel, kick, setMode,
    leave: me => (leaveParty(me, `${me.nick} вышел(ла) из пати`, null, me.id) ? { ok: true } : { error: 'Вы не в пати' }),
  };
};
