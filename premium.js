// premium.js — подписка «StandHub Premium».
// Оплата звёздами Telegram через основного бота: сайт создаёт ссылку на счёт (createInvoiceLink, валюта XTR),
// игрок платит в Telegram, бот получает successful_payment — Premium включается сам, без участия админа.
// Можно купить и за монеты сайта. Цены, выдача вручную, подписчики, платежи и возврат звёзд — «Админ» → «Premium».
const DAY = 24 * 3600e3;
// тарифы. Звёзды меняются в админке; «≈ ₽» на сайте считается сам: 1 ⭐ ≈ 2 ₽ (50 ⭐ ≈ 99 ₽)
const PLANS = [
  { id: 'm1', months: 1, days: 30, stars: 50 },
  { id: 'm3', months: 3, days: 90, stars: 100 },
  { id: 'm6', months: 6, days: 180, stars: 150 },
  { id: 'm12', months: 12, days: 365, stars: 250 },
];
const COINS = { price: 30000, days: 30, on: true };  // за монеты сайта: по умолчанию 30 000 монет — 1 месяц
const REMIND = 3 * DAY;                               // за 3 дня до конца — напоминание в Telegram
const rubOf = stars => Math.max(1, Math.round(stars * 2) - 1); // 50 → 99, 100 → 199, 150 → 299, 250 → 499
const plural = (n, a, b, c) => { const k = n % 100, j = n % 10; return n + ' ' + (k >= 11 && k <= 14 ? c : j === 1 ? a : j >= 2 && j <= 4 ? b : c); };
const monthsStr = n => plural(n, 'месяц', 'месяца', 'месяцев');
const daysStr = n => plural(n, 'день', 'дня', 'дней');
const dateMsk = t => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, ''); // «12 ноября 2026» — без «г.», иначе «г..» в конце фразы
const fmt = n => Number(n).toLocaleString('ru-RU');
const PERKS = '👑 золотая рамка и значок PREMIUM у ника\n⚡ быстрый поиск матча\n📈 прогноз ELO в комнате матча\n📊 расширенная статистика в профиле\n🪙 +50% монет за задания и бонус за вход\n🎯 Premium-задание каждый день\n🛟 приоритет в поддержке';
const CMD = /^\/(premium|paysupport)(?:@\w+)?$|^\/start\s+(premium)$/i;

module.exports = function ({ db, save, sendTo, tell, say, tg, alertAdmins, go, escH, siteUrl = '', onCoins = () => {}, onChange = () => {}, botOn = () => false }) {
  const P = db.premium = db.premium || {};
  P.cfg = P.cfg || {}; P.pays = P.pays || [];
  P.cfg.plans = P.cfg.plans || {};
  for (const p of PLANS) P.cfg.plans[p.id] = { stars: p.stars, on: true, ...P.cfg.plans[p.id] };
  P.cfg.coins = { ...COINS, ...P.cfg.coins };
  P.seq = Math.max(P.seq || 0, ...P.pays.map(x => x.n || 0));
  const user = id => db.users.find(u => u.id === id && u.verified);
  const byNick = n => { const k = String(n || '').trim().replace(/^@/, '').toLowerCase(); return k ? db.users.find(u => u.verified && u.nick.toLowerCase() === k) : null; };
  const untilOf = u => (u && u.premUntil > Date.now() ? u.premUntil : 0);
  const isPrem = x => !!untilOf(typeof x === 'string' ? user(x) : x);
  const plan = id => PLANS.find(p => p.id === id);
  const planPub = p => { const c = P.cfg.plans[p.id]; return { id: p.id, months: p.months, days: p.days, stars: c.stars, rub: rubOf(c.stars), on: !!c.on }; };
  const payPub = x => ({ n: x.n, kind: x.kind, plan: x.plan || null, days: x.days || 0, amount: x.amount || 0, at: x.at, refunded: x.refunded || null });
  const activeUsers = () => db.users.filter(u => u.verified && isPrem(u));
  function state(uid) {
    const u = uid && user(uid);
    return { type: 'premium', on: isPrem(u), until: untilOf(u), plans: PLANS.map(planPub), coins: { ...P.cfg.coins }, stars: !!botOn(),
      pays: u ? P.pays.filter(x => x.uid === u.id && ['stars', 'coins', 'admin'].includes(x.kind)).sort((a, b) => b.at - a.at).slice(0, 10).map(payPub) : [] };
  }
  // Premium изменился — обновляем сайт игрока (значок, награды заданий) и показываем уведомление
  const push = (uid, toast) => { sendTo(uid, state(uid)); onChange(uid); if (toast) sendTo(uid, { type: 'toast', text: toast }); };
  // продлить: дни добавляются к текущему сроку (или от сегодня, если Premium нет)
  function extend(u, days, rec) {
    const now = Date.now();
    u.premUntil = Math.max(now, u.premUntil || 0) + days * DAY; u.premAt = now;
    const x = { n: ++P.seq, uid: u.id, at: now, days, ...rec };
    P.pays.push(x); save(); return x;
  }

  // ---------- оплата звёздами Telegram ----------
  const links = new Map(); // `${uid}:${тариф}:${звёзды}` → ссылка на счёт (одна на игрока и тариф, пока цена не изменилась)
  async function linkFor(u, p) {
    const c = P.cfg.plans[p.id], key = `${u.id}:${p.id}:${c.stars}`;
    if (links.has(key)) return links.get(key);
    const body = { title: `StandHub Premium · ${monthsStr(p.months)}`,
      description: `Premium для аккаунта ${u.nick} на ${daysStr(p.days)}: золотая рамка у ника, быстрый поиск матча, прогноз ELO, расширенная статистика и +50% монет.`,
      payload: `prem:${u.id}:${p.id}`, provider_token: '', currency: 'XTR', prices: [{ label: `Premium на ${monthsStr(p.months)}`, amount: c.stars }] };
    if (/^https:\/\//.test(siteUrl)) Object.assign(body, { photo_url: siteUrl + '/icons/icon-512.png', photo_width: 512, photo_height: 512 });
    const r = await tg('createInvoiceLink', body).catch(e => ({ ok: false, description: e.message }));
    if (!r || !r.ok || typeof r.result !== 'string') { console.error('Premium: не удалось создать счёт —', (r && r.description) || 'нет ответа'); return null; }
    links.set(key, r.result); return r.result;
  }
  // ссылки на оплату всех тарифов для игрока (кнопки «Оплатить» на сайте и в боте)
  async function payLinks(u) {
    if (!u || !botOn()) return null;
    const out = {};
    // не ждём Telegram дольше 6 секунд: что не успело — создастся к следующему открытию страницы
    await Promise.race([Promise.all(PLANS.filter(p => P.cfg.plans[p.id].on).map(async p => { out[p.id] = await linkFor(u, p); })), new Promise(r => setTimeout(r, 6000))]);
    return { ...out };
  }
  const parse = s => { const m = /^prem:([\w-]{6,64}):(m\d{1,2})$/.exec(String(s || '')); return m ? { uid: m[1], plan: m[2] } : null; };
  // Telegram спрашивает перед списанием звёзд: всё ли в порядке (ответить нужно за 10 секунд)
  function preCheckout(q) {
    const x = parse(q.invoice_payload), u = x && user(x.uid), p = x && plan(x.plan);
    const err = !u || !p ? 'Аккаунт StandHub не найден. Откройте оплату заново на сайте.' : q.currency !== 'XTR' ? 'Оплата принимается только звёздами Telegram' : null;
    return tg('answerPreCheckoutQuery', err ? { pre_checkout_query_id: q.id, ok: false, error_message: err } : { pre_checkout_query_id: q.id, ok: true });
  }
  // оплата прошла — включаем Premium
  async function paid(msg) {
    const sp = msg.successful_payment, chat = msg.chat.id;
    if (!sp || P.pays.some(x => x.charge && x.charge === sp.telegram_payment_charge_id)) return; // повтор того же платежа
    const x = parse(sp.invoice_payload), u = x && user(x.uid), p = x && plan(x.plan);
    if (!u || !p) {
      P.pays.push({ n: ++P.seq, uid: null, kind: 'stars', plan: x ? x.plan : null, days: 0, amount: sp.total_amount, at: Date.now(), charge: sp.telegram_payment_charge_id, tgId: msg.from && msg.from.id, chat, orphan: true }); save();
      alertAdmins(`⚠️ <b>Оплата Premium без аккаунта</b>: ${sp.total_amount} ⭐ от Telegram ID <code>${escH((msg.from && msg.from.id) || '?')}</code>.\nВерните звёзды или выдайте Premium вручную:\n${go('/#/admin/premium')}`);
      return say(chat, `⚠️ Оплата получена, но аккаунт StandHub не найден. Напишите в поддержку (тема «Premium и оплата») — администратор выдаст Premium вручную или вернёт звёзды.\n${go('/#/support')}`);
    }
    extend(u, p.days, { kind: 'stars', plan: p.id, amount: sp.total_amount, charge: sp.telegram_payment_charge_id, tgId: msg.from && msg.from.id });
    const txt = `💎 <b>Оплата прошла — StandHub Premium активен!</b>\nАккаунт: <b>${escH(u.nick)}</b>\nСрок: до <b>${dateMsk(u.premUntil)}</b> (+${daysStr(p.days)})\n\nЧто теперь доступно:\n${PERKS}\n\nСпасибо, что поддерживаете StandHub ❤️\n${go('/#/premium')}`;
    await say(chat, txt).catch(() => {});
    if (u.tgChat && u.tgChat !== chat) tell(u.id, txt); // платили с другого Telegram — сообщаем и владельцу аккаунта
    push(u.id, '💎 Premium активирован — спасибо за поддержку!');
    alertAdmins(`💎 <b>${escH(u.nick)}</b> оформил(а) Premium на ${monthsStr(p.months)} — <b>${sp.total_amount} ⭐</b>\nДо ${dateMsk(u.premUntil)} · подписчиков сейчас: ${activeUsers().length}\n${go('/#/admin/premium')}`);
  }

  // ---------- покупка за монеты сайта ----------
  function buyCoins(u) {
    const c = P.cfg.coins;
    if (!c.on) return { error: 'Premium за монеты сейчас не продаётся — оплатите звёздами Telegram' };
    if ((u.coins || 0) < c.price) return { error: `Не хватает ${fmt(c.price - (u.coins || 0))} монет` };
    u.coins = (u.coins || 0) - c.price;
    extend(u, c.days, { kind: 'coins', amount: c.price });
    onCoins(u.id);
    tell(u.id, `💎 <b>StandHub Premium активен!</b>\nКуплен за ${fmt(c.price)} монет — до <b>${dateMsk(u.premUntil)}</b> (+${daysStr(c.days)}).\n\nЧто теперь доступно:\n${PERKS}\n${go('/#/premium')}`);
    push(u.id);
    alertAdmins(`💎 <b>${escH(u.nick)}</b> купил(а) Premium за ${fmt(c.price)} монет (${daysStr(c.days)})`);
    return { ok: true, until: u.premUntil, coins: u.coins };
  }

  // ---------- бот: /premium и /paysupport ----------
  const isCmd = t => CMD.test(String(t || '').trim());
  async function botCmd(chatId, text) {
    const m = CMD.exec(String(text || '').trim()), cmd = m ? (m[1] || m[2]).toLowerCase() : 'premium';
    if (cmd === 'paysupport') return say(chatId, `🛟 <b>Помощь с оплатой StandHub Premium</b>\n\nОплата проходит звёздами Telegram, Premium включается сразу после оплаты — это видно на сайте в разделе «Premium», а бот присылает подтверждение.\n\nЕсли Premium не включился, звёзды списались дважды или нужен возврат — напишите в поддержку на сайте, тема «Premium и оплата». Укажите ник на сайте и дату оплаты.\n${go('/#/support')}`);
    const mine = db.users.filter(u => u.verified && u.tgChat === chatId);
    if (!mine.length) return say(chatId, `💎 <b>StandHub Premium</b>\n\n${PERKS}\n\nСначала зарегистрируйтесь и подтвердите аккаунт на сайте — потом оформите Premium здесь командой /premium или на сайте.\n${go('/#/premium')}`);
    const u = mine[0], ls = (await payLinks(u)) || {};
    const rows = PLANS.filter(p => ls[p.id]).map(p => [{ text: `${monthsStr(p.months)} — ${P.cfg.plans[p.id].stars} ⭐`, url: ls[p.id] }]);
    const st = isPrem(u) ? `✅ Premium активен до <b>${dateMsk(u.premUntil)}</b>. Можно продлить заранее — дни добавятся к сроку.` : 'Premium пока не подключён.';
    const how = rows.length ? 'Выберите срок ниже — оплата звёздами Telegram, Premium включится сразу. Без автопродления.' : 'Оплата звёздами сейчас недоступна — попробуйте позже.';
    const coins = P.cfg.coins.on ? `\nИли на сайте за ${fmt(P.cfg.coins.price)} монет (${daysStr(P.cfg.coins.days)}).` : '';
    return say(chatId, `💎 <b>StandHub Premium</b> · аккаунт <b>${escH(u.nick)}</b>\n${st}\n\n${PERKS}\n\n${how}${coins}\n${go('/#/premium')}`, rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
  }

  // ---------- админка ----------
  function adminState() {
    const now = Date.now(), stars = P.pays.filter(x => x.kind === 'stars' && !x.refunded);
    return {
      bot: !!botOn(), plans: PLANS.map(planPub), coins: { ...P.cfg.coins },
      active: activeUsers().length, starsAll: stars.reduce((a, x) => a + (x.amount || 0), 0), stars30: stars.filter(x => now - x.at < 30 * DAY).reduce((a, x) => a + (x.amount || 0), 0),
      subs: activeUsers().sort((a, b) => a.premUntil - b.premUntil).map(u => ({ nick: u.nick, until: u.premUntil })),
      pays: P.pays.slice().sort((a, b) => b.at - a.at).slice(0, 100).map(x => ({ ...payPub(x), nick: x.uid ? (user(x.uid) || {}).nick || 'Игрок' : null, by: x.by || null, refBy: x.refBy || null, orphan: !!x.orphan })),
    };
  }
  function setCfg(b) {
    const plans = b.plans || {}, c = b.coins || {}, int = (v, a, z) => Number.isInteger(Number(v)) && Number(v) >= a && Number(v) <= z;
    for (const p of PLANS) { const x = plans[p.id]; if (x && x.stars != null && !int(x.stars, 1, 10000)) return { error: `Цена «${monthsStr(p.months)}» — целое число звёзд от 1 до 10 000` }; }
    if (c.price != null && !int(c.price, 1, 1e7)) return { error: 'Цена за монеты — целое число от 1 до 10 000 000' };
    if (c.days != null && !int(c.days, 1, 365)) return { error: 'Срок за монеты — от 1 до 365 дней' };
    for (const p of PLANS) { const x = plans[p.id]; if (!x) continue; const cur = P.cfg.plans[p.id]; if (x.stars != null) cur.stars = Number(x.stars); if (x.on != null) cur.on = !!x.on; }
    if (c.price != null) P.cfg.coins.price = Number(c.price);
    if (c.days != null) P.cfg.coins.days = Number(c.days);
    if (c.on != null) P.cfg.coins.on = !!c.on;
    save(); return { ok: true };
  }
  function grant(admin, nick, days) {
    const u = byNick(nick); if (!u) return { error: 'Игрок не найден — проверьте ник' };
    const d = Number(days); if (!Number.isInteger(d) || d < 1 || d > 3650) return { error: 'Срок — целое число дней от 1 до 3650' };
    extend(u, d, { kind: 'admin', by: admin.nick });
    tell(u.id, `🎁 Администратор выдал вам <b>StandHub Premium</b> на ${daysStr(d)} — до <b>${dateMsk(u.premUntil)}</b>.\n\nЧто теперь доступно:\n${PERKS}\n${go('/#/premium')}`);
    push(u.id, `🎁 Вам выдали Premium на ${daysStr(d)}`);
    return { ok: true, nick: u.nick, until: u.premUntil };
  }
  function revoke(admin, nick) {
    const u = byNick(nick); if (!u) return { error: 'Игрок не найден — проверьте ник' };
    if (!isPrem(u)) return { error: `У ${u.nick} нет Premium` };
    u.premUntil = 0; P.pays.push({ n: ++P.seq, uid: u.id, kind: 'revoke', days: 0, at: Date.now(), by: admin.nick }); save();
    tell(u.id, `StandHub Premium отключён администратором. Если это ошибка — напишите в поддержку:\n${go('/#/support')}`);
    push(u.id); return { ok: true, nick: u.nick };
  }
  // возврат: звёзды — через Telegram (refundStarPayment), монеты — на баланс. Срок Premium уменьшается на оплаченные дни
  async function refund(admin, n) {
    const x = P.pays.find(p => p.n === Number(n)); if (!x) return { error: 'Платёж не найден' };
    if (x.refunded) return { error: 'Этот платёж уже возвращён' };
    if (!['stars', 'coins'].includes(x.kind)) return { error: 'Вернуть можно только оплату звёздами или монетами' };
    const u = x.uid && user(x.uid);
    if (x.kind === 'stars') {
      if (!x.tgId || !x.charge) return { error: 'Нет данных платежа Telegram — вернуть звёзды нельзя' };
      const r = await tg('refundStarPayment', { user_id: x.tgId, telegram_payment_charge_id: x.charge }).catch(e => ({ ok: false, description: e.message }));
      if (!r || !r.ok) return { error: 'Telegram не вернул звёзды: ' + ((r && r.description) || 'нет ответа') };
    } else if (u) { u.coins = (u.coins || 0) + (x.amount || 0); onCoins(u.id); }
    x.refunded = Date.now(); x.refBy = admin.nick;
    if (u && x.days) { u.premUntil = Math.max(0, (u.premUntil || 0) - x.days * DAY); if (u.premUntil <= Date.now()) u.premUntil = 0; }
    save();
    if (u) {
      const left = isPrem(u) ? `Premium активен до ${dateMsk(u.premUntil)}.` : 'Premium отключён.';
      tell(u.id, `↩️ Оплата Premium возвращена: ${x.kind === 'stars' ? `${x.amount} ⭐ вернулись на ваш счёт в Telegram` : `${fmt(x.amount)} монет вернулись на баланс`}. ${left}\n${go('/#/premium')}`);
      push(u.id, x.kind === 'stars' ? `↩️ Оплата Premium возвращена — ${x.amount} ⭐` : `↩️ ${fmt(x.amount)} монет вернулись на баланс`);
    } else if (x.chat) say(x.chat, `↩️ Звёзды за Premium возвращены: ${x.amount} ⭐.`).catch(() => {});
    return { ok: true };
  }

  // ---------- напоминания: за 3 дня до конца и когда срок закончился ----------
  function sweep() {
    const now = Date.now(); let ch = false;
    for (const u of db.users) {
      if (!u.verified || !u.premUntil) continue;
      const left = u.premUntil - now;
      if (left > 0 && left <= REMIND && u.premRem !== u.premUntil && now - (u.premAt || 0) > DAY) {
        u.premRem = u.premUntil; ch = true;
        tell(u.id, `⏳ <b>StandHub Premium</b> закончится ${dateMsk(u.premUntil)} — осталось ${daysStr(Math.max(1, Math.ceil(left / DAY)))}.\nПродлить можно командой /premium здесь или на сайте — дни добавятся к сроку.\n${go('/#/premium')}`);
      } else if (left <= 0 && u.premEnd !== u.premUntil) {
        u.premEnd = u.premUntil; ch = true;
        tell(u.id, `Срок StandHub Premium закончился. Спасибо, что были с нами! Вернуть Premium: /premium или на сайте\n${go('/#/premium')}`);
        push(u.id);
      }
    }
    if (ch) save();
  }
  setInterval(sweep, 10 * 60e3); setTimeout(sweep, 20e3);

  return { isPrem, untilOf, state, payLinks, preCheckout, paid, buyCoins, isCmd, botCmd, adminState, setCfg, grant, revoke, refund, sweep, PLANS };
};
