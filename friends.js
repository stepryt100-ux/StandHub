// friends.js — друзья: заявки по ID в игре или нику, принять / отклонить, список друзей
const crypto = require('crypto'), gameId = require('./game-id');
const DAY = 24 * 3600e3;
const MAX_FRIENDS = 300, MAX_OUT = 30; // защита от спама заявками
const escH = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

module.exports = function ({ db, save, sendTo, tell, go, pub, isOnline, matchOf }) {
  db.freqs = db.freqs || []; // заявки, которые ждут ответа: { id, from, to, at }
  db.frNo = db.frNo || [];   // отклонённые: тому же игроку снова можно отправить через сутки
  const user = id => db.users.find(u => u.id === id && u.verified);
  const friendsOf = u => (u.friends || []).map(user).filter(Boolean);
  const card = u => ({ ...pub(u), online: isOnline(u.id), inMatch: !!matchOf(u.id) });
  const isFriend = (a, b) => (a.friends || []).includes(b.id);

  function state(uid) {
    const u = user(uid);
    if (!u) return { type: 'friends', friends: [], incoming: [], outgoing: [] };
    const rq = (r, other) => ({ id: r.id, at: r.at, user: card(other) });
    return {
      type: 'friends',
      friends: friendsOf(u).map(card).sort((a, b) => (b.inMatch || b.online) - (a.inMatch || a.online) || a.nick.localeCompare(b.nick)),
      incoming: db.freqs.filter(r => r.to === uid && user(r.from)).sort((a, b) => b.at - a.at).map(r => rq(r, user(r.from))),
      outgoing: db.freqs.filter(r => r.from === uid && user(r.to)).sort((a, b) => b.at - a.at).map(r => rq(r, user(r.to))),
    };
  }
  const push = (...ids) => ids.forEach(id => sendTo(id, state(id)));
  function link(a, b) {
    a.friends = [...new Set([...(a.friends || []), b.id])];
    b.friends = [...new Set([...(b.friends || []), a.id])];
    db.freqs = db.freqs.filter(r => !((r.from === a.id && r.to === b.id) || (r.from === b.id && r.to === a.id)));
  }
  // Ищем по игровому ID или нику; неоднозначное совпадение не выбираем молча.
  function find(q, nickOnly = false) {
    q = String(q || '').trim().replace(/^@/, '');
    if (!q) return null;
    const ver = db.users.filter(u => u.verified);
    const byId = nickOnly ? null : ver.find(x => gameId.same(x.soid,q));
    const byNick = ver.find(x => x.nick.toLowerCase() === q.toLowerCase());
    if(byId && byNick && byId.id !== byNick.id) return {ambiguous:true};
    return byId || byNick || null;
  }
  const accepted = (who, to) => tell(to.id, `🤝 <b>${escH(who.nick)}</b> принял(а) вашу заявку — теперь вы друзья на StandHub.\n${go('/#/friends')}`);

  function request(me, q, nickOnly = false) {
    const to = find(q, nickOnly);
    if (!to) return { error: /^\d+$/.test(String(q || '').trim()) ? 'Игрок с таким ID не найден на StandHub' : 'Игрок с таким ником не найден на StandHub (проверьте ник или игровой ID)' };
    if (to.ambiguous) return { error: 'Этому запросу соответствуют ID и ник разных игроков. Найдите нужного игрока через поиск сайта и отправьте заявку из его профиля.' };
    if (to.id === me.id) return { error: 'Это ваш аккаунт 🙂' };
    if (isFriend(me, to)) return { error: `${to.nick} уже у вас в друзьях` };
    if (db.freqs.some(r => r.from === me.id && r.to === to.id)) return { error: `Заявка для ${to.nick} уже отправлена — ждём ответа` };
    // встречная заявка — сразу дружим
    if (db.freqs.some(r => r.from === to.id && r.to === me.id)) { link(me, to); save(); push(me.id, to.id); accepted(me, to); return { ok: true, accepted: true, nick: to.nick }; }
    if ((me.friends || []).length >= MAX_FRIENDS) return { error: `В друзьях может быть не больше ${MAX_FRIENDS} игроков` };
    if (db.freqs.filter(r => r.from === me.id).length >= MAX_OUT) return { error: 'Слишком много заявок ждут ответа — подождите, пока на них ответят' };
    if (db.frNo.some(x => x.from === me.id && x.to === to.id && Date.now() - x.at < DAY)) return { error: `${to.nick} недавно отклонил(а) заявку — отправить снова можно будет завтра` };
    db.freqs.push({ id: crypto.randomBytes(6).toString('hex'), from: me.id, to: to.id, at: Date.now() });
    save(); push(me.id, to.id);
    tell(to.id, `👋 <b>${escH(me.nick)}</b> хочет добавить вас в друзья на StandHub.\nПримите или отклоните заявку на сайте:\n${go('/#/friends')}`);
    return { ok: true, nick: to.nick };
  }
  function answer(me, id, yes) {
    const r = db.freqs.find(x => x.id === id && x.to === me.id);
    if (!r) return { error: 'Заявка не найдена — возможно, её уже отменили' };
    const from = user(r.from);
    db.freqs = db.freqs.filter(x => x !== r);
    if (yes && from) { link(me, from); accepted(me, from); }
    if (!yes) { db.frNo = db.frNo.filter(x => Date.now() - x.at < DAY && !(x.from === r.from && x.to === me.id)); db.frNo.push({ from: r.from, to: me.id, at: Date.now() }); }
    save(); push(me.id, r.from);
    return { ok: true, nick: from ? from.nick : null };
  }
  function cancel(me, id) {
    const r = db.freqs.find(x => x.id === id && x.from === me.id);
    if (!r) return { error: 'Заявка не найдена' };
    db.freqs = db.freqs.filter(x => x !== r); save(); push(me.id, r.to);
    return { ok: true };
  }
  function remove(me, nick) {
    const f = friendsOf(me).find(x => x.nick.toLowerCase() === String(nick || '').toLowerCase());
    if (!f) return { error: 'Этого игрока нет у вас в друзьях' };
    me.friends = (me.friends || []).filter(id => id !== f.id);
    f.friends = (f.friends || []).filter(id => id !== me.id);
    save(); push(me.id, f.id);
    return { ok: true, nick: f.nick };
  }
  return { state, request, accept: (me, id) => answer(me, id, true), decline: (me, id) => answer(me, id, false), cancel, remove };
};
