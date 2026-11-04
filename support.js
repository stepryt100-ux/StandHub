// support.js — обращения в поддержку: игрок пишет на сайте, админ отвечает в админке, ответ приходит игроку в Telegram
const crypto = require('crypto');
const TOPICS = { question: 'Вопрос', match: 'Проблема с матчем', account: 'Аккаунт и подтверждение', player: 'Жалоба на игрока', idea: 'Предложение', other: 'Другое' };
const clean = (t, max) => String(t || '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

module.exports = function ({ db, save, sendTo, tell, go, escH, alertAdmins, onChange }) {
  db.tickets = db.tickets || []; // { id, uid, topic, mid, status: 'open'|'closed', at, upd, unread, msgs: [{ by: 'user'|'admin', t, at }] }
  const user = id => db.users.find(u => u.id === id && u.verified);
  const lastAt = new Map();
  const view = (x, admin) => ({ id: x.id, topic: TOPICS[x.topic] || x.topic, mid: x.mid || null, status: x.status, at: x.at, upd: x.upd, unread: !!x.unread,
    msgs: x.msgs.map(m => ({ by: m.by, t: m.t, at: m.at })), ...(admin ? { nick: (user(x.uid) || {}).nick || 'Игрок', soid: (user(x.uid) || {}).soid || '' } : {}) });
  const mine = uid => db.tickets.filter(x => x.uid === uid).sort((a, b) => b.upd - a.upd).slice(0, 20).map(x => view(x));
  const unread = uid => db.tickets.filter(x => x.uid === uid && x.unread).length;
  // ждут ответа: открытые, где последнее сообщение от игрока
  const waiting = () => db.tickets.filter(x => x.status === 'open' && x.msgs[x.msgs.length - 1].by === 'user').length;
  const short = t => escH(t.length > 300 ? t.slice(0, 300) + '…' : t);

  function create(u, topic, text, mid) {
    if (!TOPICS[topic]) return { error: 'Выберите тему обращения' };
    text = clean(text, 1500); mid = String(mid || '').trim().replace(/^#/, '').toLowerCase().slice(0, 20);
    if (text.length < 10) return { error: 'Опишите вопрос подробнее — хотя бы пару предложений' };
    if (mid && !/^[a-f0-9]{6,12}$/.test(mid)) return { error: 'Номер матча — это код из адреса комнаты матча, например 3fa9c01b2d' };
    if (db.tickets.filter(x => x.uid === u.id && x.status === 'open').length >= 3) return { error: 'У вас уже 3 открытых обращения — дождитесь ответа' };
    if (Date.now() - (lastAt.get(u.id) || 0) < 60e3) return { error: 'Подождите минуту перед новым обращением' };
    lastAt.set(u.id, Date.now());
    const now = Date.now(), x = { id: crypto.randomBytes(6).toString('hex'), uid: u.id, topic, mid: mid || null, status: 'open', at: now, upd: now, unread: false, msgs: [{ by: 'user', t: text, at: now }] };
    db.tickets.push(x); save();
    alertAdmins(`🆘 <b>Обращение в поддержку</b> от <b>${escH(u.nick)}</b>\nТема: ${TOPICS[topic]}${mid ? ' · матч #' + escH(mid) : ''}\n\n«${short(text)}»\n\n${go('/#/admin/support')}`);
    onChange(u.id);
    return { ok: true, id: x.id };
  }
  function reply(u, id, text) {
    const x = db.tickets.find(t => t.id === id && t.uid === u.id); if (!x) return { error: 'Обращение не найдено' };
    if (x.status !== 'open') return { error: 'Обращение закрыто — создайте новое' };
    text = clean(text, 1500); if (text.length < 2) return { error: 'Напишите сообщение' };
    if (x.msgs.length >= 40) return { error: 'Слишком длинная переписка — создайте новое обращение' };
    if (Date.now() - (lastAt.get(u.id) || 0) < 5e3) return { error: 'Не так быстро — подождите пару секунд' };
    lastAt.set(u.id, Date.now());
    x.msgs.push({ by: 'user', t: text, at: Date.now() }); x.upd = Date.now(); save();
    alertAdmins(`💬 <b>${escH(u.nick)}</b> ответил(а) в обращении «${TOPICS[x.topic]}»:\n\n«${short(text)}»\n\n${go('/#/admin/support')}`);
    onChange(u.id);
    return { ok: true };
  }
  function closeMine(u, id) {
    const x = db.tickets.find(t => t.id === id && t.uid === u.id); if (!x) return { error: 'Обращение не найдено' };
    x.status = 'closed'; x.unread = false; x.upd = Date.now(); save(); onChange(u.id); return { ok: true };
  }
  function seen(u) { let n = 0; for (const x of db.tickets) if (x.uid === u.id && x.unread) { x.unread = false; n++; } if (n) { save(); onChange(u.id); } return { ok: true }; }
  // ---------- админка ----------
  function adminList() {
    const open = db.tickets.filter(x => x.status === 'open').sort((a, b) => a.upd - b.upd);
    const closed = db.tickets.filter(x => x.status !== 'open').sort((a, b) => b.upd - a.upd).slice(0, 20);
    return { open: open.map(x => view(x, true)), closed: closed.map(x => view(x, true)) };
  }
  function adminReply(id, text) {
    const x = db.tickets.find(t => t.id === id); if (!x) return { error: 'Обращение не найдено' };
    text = clean(text, 1500); if (text.length < 2) return { error: 'Напишите ответ' };
    x.msgs.push({ by: 'admin', t: text, at: Date.now() }); x.upd = Date.now(); x.unread = true; x.status = 'open'; save();
    tell(x.uid, `💬 <b>Ответ поддержки StandHub</b> · ${TOPICS[x.topic]}\n\n«${short(text)}»\n\nОтветить: ${go('/#/support')}`);
    sendTo(x.uid, { type: 'toast', text: '💬 Поддержка ответила на ваше обращение' });
    onChange(x.uid);
    return { ok: true };
  }
  function adminClose(id) {
    const x = db.tickets.find(t => t.id === id); if (!x) return { error: 'Обращение не найдено' };
    x.status = 'closed'; x.upd = Date.now(); save(); onChange(x.uid); return { ok: true };
  }
  return { mine, unread, waiting, create, reply, closeMine, seen, adminList, adminReply, adminClose, TOPICS };
};
