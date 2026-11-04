// Пароль: восстановление через Telegram-бота и смена пароля в профиле.
// Telegram привязан к каждому подтверждённому аккаунту (через бота проходит проверка ID), поэтому код приходит туда — почта не нужна.
const crypto = require('crypto');
const TTL = 30 * 60e3;         // код и ссылка из Telegram действуют 30 минут
const ADMIN_TTL = 24 * 3600e3; // ссылка, которую выдал администратор, — сутки
const GAP = 60e3;              // повторно отправить код — не раньше чем через минуту
const PER_HOUR = 5;            // и не больше 5 раз в час (чтобы никто не засыпал чужой Telegram кодами)
const TRIES = 5;               // попыток ввести код

module.exports = ({ db, save, hash, check, say, escH, siteUrl, bot, newSession, dropSessions, meOf }) => {
  const verified = () => db.users.filter(u => u.verified);
  const byLogin = s => {
    s = String(s || '').trim().toLowerCase(); if (!s) return null;
    return verified().find(u => (s.includes('@') ? u.email === s : u.nick.toLowerCase() === s)) || null;
  };
  const plural = (n, a, b, c) => n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c;
  const mins = ms => { const n = Math.max(1, Math.round(ms / 60e3)); return n + ' ' + plural(n, 'минуту', 'минуты', 'минут'); };
  const wait = ms => { const s = Math.max(1, Math.ceil(ms / 1000)); return s < 60 ? s + ' сек' : mins(ms); };
  const link = u => `${siteUrl}/#/reset/${u.rs.token}`;
  const valid = u => !!(u.rs && u.rs.exp > Date.now());
  // код и ссылка: пока действующий код не истекает (больше 10 минут), повторно присылаем тот же — старые сообщения не «ломаются»
  function ensure(u, ttl = TTL) {
    const now = Date.now();
    if (!valid(u) || u.rs.exp - now < 10 * 60e3 || ttl > TTL)
      u.rs = { code: String(crypto.randomInt(100000, 1000000)), token: crypto.randomBytes(20).toString('hex'), exp: now + ttl, tries: 0 };
    return u.rs;
  }
  const info = u => ({ wait: Math.max(0, Math.ceil((GAP - (Date.now() - (u.rsSent || 0))) / 1000)), ttl: Math.ceil((u.rs.exp - Date.now()) / 1000) });

  // «Забыли пароль?» на сайте: код и ссылка приходят в Telegram
  async function forgot(login) {
    if (!String(login || '').trim()) return { status: 400, field: 'login', error: 'Введите email или ник' };
    const u = byLogin(login);
    if (!u) {
      const s = String(login).trim().toLowerCase();
      if (db.users.some(x => !x.verified && (x.email === s || x.nick.toLowerCase() === s))) return { status: 400, field: 'login', error: 'Этот аккаунт ещё не подтверждён — просто зарегистрируйтесь заново с тем же email' };
      return { status: 404, field: 'login', error: 'Аккаунт не найден. Проверьте email или ник' };
    }
    if (!bot()) return { status: 503, error: 'Восстановление через Telegram сейчас не работает — попробуйте чуть позже' };
    if (!u.tgChat) return { status: 400, error: 'К аккаунту не привязан Telegram — напишите администратору StandHub' };
    const now = Date.now(); u.rsLog = (u.rsLog || []).filter(t => now - t < 3600e3);
    if (valid(u) && now - (u.rsSent || 0) < GAP) return { status: 429, sent: true, ...info(u), error: `Код уже отправлен — проверьте Telegram. Ещё раз можно через ${wait(GAP - (now - u.rsSent))}` };
    if (u.rsLog.length >= PER_HOUR) return { status: 429, error: `Слишком много запросов. Попробуйте через ${wait(3600e3 - (now - u.rsLog[0]))}` };
    const rs = ensure(u);
    let r = null;
    try {
      r = await say(u.tgChat, `🔑 <b>Восстановление пароля StandHub</b>\n\nКод: <code>${rs.code}</code>\nВведите его на сайте — код действует ${mins(rs.exp - now)}.\n\nИли сразу задайте новый пароль:\n👉 <a href="${link(u)}">Сменить пароль</a>\n\nЕсли вы не запрашивали восстановление — ничего не делайте, пароль останется прежним. Никому не сообщайте этот код.`);
    } catch {}
    if (!r || !r.ok) { save(); return { status: 502, error: `Не получилось отправить код в Telegram. Откройте бота @${bot()}, нажмите «Запустить» (Start) и попробуйте ещё раз` }; }
    u.rsSent = now; u.rsLog.push(now); save();
    return { ok: true, bot: bot(), ...info(u) };
  }

  // в боте: /password — показываем email для входа и присылаем ссылку (без ввода email на сайте)
  async function botReset(chatId) {
    const list = verified().filter(u => u.tgChat === chatId);
    if (!list.length) return say(chatId, `Этот Telegram не привязан ни к одному аккаунту StandHub.\n\nВосстановить пароль можно только из того Telegram, через который вы подтверждали аккаунт. Нет к нему доступа — напишите администратору StandHub.`);
    for (const u of list) {
      const now = Date.now();
      if (valid(u) && now - (u.rsSent || 0) < GAP) { await say(chatId, `☝️ Ссылка для аккаунта <b>${escH(u.nick)}</b> уже отправлена выше — она действует ещё ${mins(u.rs.exp - now)}.`); continue; }
      const rs = ensure(u); u.rsSent = now; save();
      await say(chatId, `🔑 <b>Восстановление пароля StandHub</b>\n\nАккаунт: <b>${escH(u.nick)}</b>\nEmail для входа: <code>${escH(u.email)}</code>\n\n👉 <a href="${link(u)}">Задать новый пароль</a>\n\nСсылка действует ${mins(rs.exp - now)}. Код для сайта: <code>${rs.code}</code>`);
    }
  }
  const isCmd = t => /^\/(password|reset)(@\w+)?$/i.test(t) || /^\/start\s+reset$/i.test(t) || /^(забыл[аи]?\s+)?парол[ьяи]?[.!?]*$/i.test(t) || /(забыл|восстанов|сброс|сменить|поменять)\S*\s+(мой\s+)?парол/i.test(t);

  function setPw(u, pw, keep, why) {
    u.pw = hash(pw); delete u.rs; u.rsLog = []; u.pwAt = new Date().toISOString();
    dropSessions(u.id, keep);
    const token = keep || newSession(u);
    save();
    if (u.tgChat) say(u.tgChat, `🔐 <b>Пароль от StandHub изменён</b> (аккаунт <b>${escH(u.nick)}</b>, ${why}).\nНа других устройствах нужно будет войти заново.\n\nЕсли это сделали не вы — отправьте сюда /password и задайте новый пароль.`).catch(() => {});
    return { ok: true, token, user: meOf(u) };
  }
  // новый пароль: по коду (email/ник + код) или по ссылке из Telegram
  function reset(b) {
    const pw = String(b.pw || '');
    let u;
    if (b.token) {
      u = verified().find(x => valid(x) && x.rs.token === String(b.token));
      if (!u) return { error: 'Ссылка устарела или уже использована — запросите новую', expired: true };
      if (pw.length < 6) return { field: 'pw', error: 'Минимум 6 символов' };
      return setPw(u, pw, null, 'по ссылке из Telegram');
    }
    u = byLogin(b.login); if (!u) return { field: 'login', error: 'Аккаунт не найден' };
    if (!valid(u)) return { field: 'code', error: 'Код устарел — запросите новый', expired: true };
    if (pw.length < 6) return { field: 'pw', error: 'Минимум 6 символов' };
    if (String(b.code || '').replace(/\D/g, '') !== u.rs.code) {
      u.rs.tries++;
      if (u.rs.tries >= TRIES) { delete u.rs; save(); return { field: 'code', error: 'Слишком много неверных попыток — запросите новый код', expired: true }; }
      save(); return { field: 'code', error: `Неверный код. Осталось попыток: ${TRIES - u.rs.tries}` };
    }
    return setPw(u, pw, null, 'по коду из Telegram');
  }
  const checkToken = t => { const u = t && verified().find(x => valid(x) && x.rs.token === String(t)); return u ? { ok: true, nick: u.nick, email: u.email } : { error: 'Ссылка устарела или уже использована', expired: true }; };
  // смена пароля в профиле: нужен текущий пароль; текущий вход остаётся, остальные устройства выходят
  function change(u, b, keep) {
    if (!check(String(b.old || ''), u.pw)) return { field: 'old', error: 'Неверный текущий пароль' };
    const pw = String(b.pw || ''); if (pw.length < 6) return { field: 'pw', error: 'Минимум 6 символов' };
    return setPw(u, pw, keep, 'в профиле на сайте');
  }
  // администратор: ссылка для игрока, у которого нет доступа к Telegram (действует сутки)
  function adminLink(nick) {
    const n = String(nick || '').toLowerCase(), u = verified().find(x => x.nick.toLowerCase() === n);
    if (!u) return { error: 'Игрок не найден' };
    ensure(u, ADMIN_TTL); save();
    console.log(`Ссылка для смены пароля выдана администратором: ${u.nick}`);
    return { ok: true, nick: u.nick, link: link(u) };
  }
  return { forgot, botReset, isCmd, reset, checkToken, change, adminLink };
};
