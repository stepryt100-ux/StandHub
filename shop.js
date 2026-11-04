// shop.js — магазин: монеты за задания меняются на награды.
// Промокод выдаёт администратор вручную: после покупки игрок пишет ему в Telegram и присылает скриншот заказа,
// админ сверяет номер заказа в «Админ» → «Магазин», выдаёт код и отмечает заказ «Выдан».
const DAY = 24 * 3600e3, WEEK = 7 * DAY;
// товары. Цена, лимит, количество и «продаётся/нет» меняются в админке (db.shop.cfg)
const ITEMS = [{ id: 'gold1000', title: '1000 голды', full: 'Промокод на 1000 голды', price: 150 }];
const CONTACT = 'swupliq';              // кому писать за промокодом (меняется в админке)
const QTY_MAX = 100000;
const TG_NICK = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const cleanTg = s => String(s || '').trim().replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
const whenMsk = t => new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' МСК';

module.exports = function ({ db, save, sendTo, sendAll, tell, alertAdmins, go, escH, onCoins, tgName, onPending = () => {} }) {
  const S = db.shop = db.shop || {};
  S.cfg = S.cfg || {}; S.wait = S.wait || {}; S.orders = S.orders || [];
  if (!S.contact) S.contact = CONTACT;
  delete S.codes;                       // раньше коды выдавались автоматически из запаса — больше не используется
  S.seq = Math.max(S.seq || 1000, ...S.orders.map(o => o.n || 0));
  for (const o of S.orders) { if (!o.n) o.n = ++S.seq; if (!o.st) o.st = o.code ? 'done' : 'wait'; }
  for (const it of ITEMS) { S.cfg[it.id] = { price: it.price, on: true, limit: 0, qty: null, ...S.cfg[it.id] }; S.wait[it.id] = S.wait[it.id] || []; }
  const item = id => ITEMS.find(x => x.id === id);
  const user = uid => db.users.find(u => u.id === uid);
  const live = o => o.st !== 'refund';  // отменённые заказы не считаются в лимит и «продано»
  const canBuy = id => S.cfg[id].on && S.cfg[id].qty !== 0;
  const pending = () => S.orders.filter(o => o.st === 'wait').length;
  // лимит «N в неделю»: когда снова можно купить (0 — можно сейчас)
  function nextAt(uid, id) {
    const c = S.cfg[id]; if (!c.limit) return 0;
    const recent = S.orders.filter(o => o.uid === uid && o.item === id && live(o) && o.at > Date.now() - WEEK).sort((a, b) => a.at - b.at);
    return recent.length >= c.limit ? recent[recent.length - c.limit].at + WEEK : 0;
  }
  // stock: null — без ограничения, число — сколько осталось
  const pub = (it, uid) => { const c = S.cfg[it.id]; return { id: it.id, title: it.title, full: it.full, price: c.price, on: c.on, limit: c.limit || 0, stock: c.qty, ...(uid ? { wait: S.wait[it.id].includes(uid), next: nextAt(uid, it.id) } : {}) }; };
  const ord = o => ({ n: o.n, item: o.item, title: (item(o.item) || { full: o.item }).full, price: o.price, at: o.at, st: o.st, ...(o.doneAt ? { doneAt: o.doneAt } : {}), ...(o.code ? { code: o.code } : {}) });
  const mine = uid => S.orders.filter(o => o.uid === uid).sort((a, b) => b.at - a.at).slice(0, 50).map(ord);
  const state = uid => ({ type: 'shop', contact: S.contact, items: ITEMS.map(it => pub(it, uid)), orders: uid ? mine(uid) : [] });
  // цена, количество или контакт изменились — обновляем у всех, у кого открыт сайт (личные поля клиент сохраняет у себя)
  const pushAll = () => sendAll({ type: 'shopItems', contact: S.contact, items: ITEMS.map(it => pub(it)) });

  function buy(u, id) {
    const it = item(id); if (!it) return { error: 'Товар не найден' };
    const c = S.cfg[id];
    if (!c.on) return { error: 'Этот товар сейчас не продаётся' };
    if (c.qty === 0) return { error: 'Товар закончился. Нажмите «Сообщить о поступлении» — напишем, когда появится' };
    const n = nextAt(u.id, id); if (n) return { error: `Можно купить не больше ${c.limit} в неделю. Следующая покупка — ${whenMsk(n)}` };
    if ((u.coins || 0) < c.price) return { error: `Не хватает ${c.price - (u.coins || 0)} монет` };
    u.coins = (u.coins || 0) - c.price;
    if (c.qty != null) c.qty--;
    const o = { n: ++S.seq, uid: u.id, item: id, price: c.price, at: Date.now(), st: 'wait' };
    S.orders.push(o); save();
    onCoins(u.id); pushAll(); onPending();
    const who = '@' + escH(S.contact), left = c.qty;
    tell(u.id, `🛒 <b>Покупка в магазине StandHub</b>\n${escH(it.full)} — ${c.price} монет\nЗаказ <b>№${o.n}</b>\n\n<b>Как получить промокод:</b>\n1. Напишите в Telegram ${who}\n2. Пришлите скриншот покупки с сайта — или просто перешлите это сообщение\n\nКогда получите код, введите его в StandLeo: главный экран → «События» → «Секретный код».\n\nВаши покупки: ${go('/#/shop')}`);
    // ник покупателя в Telegram — чтобы админ сверил, что за промокодом пишет сам покупатель
    Promise.resolve().then(() => tgName ? tgName(u) : null).catch(() => null).then(tgu => {
      if (tgu && !o.tg) { o.tg = tgu; save(); }
      const q = left == null ? '' : left === 0 ? '\n⚠️ Это была последняя штука — покупки на паузе, пока не добавите количество в админке.' : `\nОсталось: <b>${left}</b>${left <= 3 ? ' — скоро закончится' : ''}`;
      alertAdmins(`🛒 <b>${escH(u.nick)}</b> купил(а) «${escH(it.full)}» за ${c.price} монет\nЗаказ <b>№${o.n}</b>${tgu ? `\nTelegram покупателя: @${escH(tgu)}` : ''}${q}\n\nИгрок напишет ${who} и пришлёт скриншот. Выдайте промокод и отметьте заказ «Выдан»:\n${go('/#/admin/shop')}`);
    });
    return { ok: true, order: ord(o), coins: u.coins };
  }
  // «Сообщить о поступлении»: напишем в Telegram и на сайте, когда товар снова появится
  function notify(u, id, on) {
    if (!item(id)) return { error: 'Товар не найден' };
    const w = S.wait[id], i = w.indexOf(u.id);
    if (on && i < 0) w.push(u.id); else if (!on && i >= 0) w.splice(i, 1);
    save(); return { ok: true, wait: w.includes(u.id) };
  }

  // ---------- админка ----------
  const adminOrder = o => { const u = user(o.uid); return { ...ord(o), nick: u ? u.nick : 'Игрок', tg: o.tg || (u && u.tgUser) || null, by: o.by || null }; };
  const adminState = () => ({
    contact: S.contact, pending: pending(),
    items: ITEMS.map(it => ({ ...pub(it), sold: S.orders.filter(o => o.item === it.id && live(o)).length, pending: S.orders.filter(o => o.item === it.id && o.st === 'wait').length, waiting: S.wait[it.id].length })),
    // сначала ждущие выдачи (старые сверху), потом остальные — новые сверху
    orders: [...S.orders.filter(o => o.st === 'wait').sort((a, b) => a.at - b.at), ...S.orders.filter(o => o.st !== 'wait').sort((a, b) => b.at - a.at).slice(0, 100)].map(adminOrder),
  });
  // товар снова можно купить — сообщаем тем, кто просил
  function restocked(it) {
    const ws = S.wait[it.id].splice(0);
    for (const uid of ws) {
      tell(uid, `🛒 В магазине StandHub снова есть «${escH(it.full)}» — успейте купить:\n${go('/#/shop')}`);
      sendTo(uid, { type: 'toast', text: `🛒 В магазине снова есть «${it.full}»` });
    }
    return ws.length;
  }
  function setCfg(id, b) {
    const it = item(id); if (!it) return { error: 'Товар не найден' };
    const c = S.cfg[id], could = canBuy(id), noQty = b.qty === null || b.qty === '';
    if (b.price != null) { const p = Number(b.price); if (!Number.isInteger(p) || p < 1 || p > 1e6) return { error: 'Цена — целое число от 1 до 1 000 000 монет' }; }
    if (b.limit != null) { const l = Number(b.limit); if (!Number.isInteger(l) || l < 0 || l > 100) return { error: 'Лимит — от 0 до 100 покупок в неделю (0 — без лимита)' }; }
    if (b.qty !== undefined && !noQty) { const q = Number(b.qty); if (!Number.isInteger(q) || q < 0 || q > QTY_MAX) return { error: 'Количество — целое число от 0 до 100 000 (пусто — без ограничения)' }; }
    if (b.price != null) c.price = Number(b.price);
    if (b.limit != null) c.limit = Number(b.limit);
    if (b.qty !== undefined) c.qty = noQty ? null : Number(b.qty);
    if (b.on != null) c.on = !!b.on;
    const told = !could && canBuy(id) ? restocked(it) : 0;
    save(); pushAll(); return { ok: true, told };
  }
  function setContact(v) {
    const t = cleanTg(v);
    if (!TG_NICK.test(t)) return { error: 'Укажите ник в Telegram, например @swupliq — от 5 до 32 символов: латиница, цифры и _' };
    S.contact = t; save(); pushAll(); return { ok: true, contact: t };
  }
  // заказ: «Выдан», снять отметку или отменить с возвратом монет
  function setOrder(admin, n, act) {
    const o = S.orders.find(x => x.n === Number(n)); if (!o) return { error: 'Заказ не найден' };
    const it = item(o.item) || { full: o.item }, u = user(o.uid);
    if (act === 'done' || act === 'refund') {
      if (o.st === 'done') return { error: `Заказ №${o.n} уже отмечен «Выдан»` };
      if (o.st === 'refund') return { error: `Заказ №${o.n} отменён — монеты уже вернули` };
    }
    if (act === 'done') { o.st = 'done'; o.doneAt = Date.now(); o.by = admin.nick; }
    else if (act === 'undo') { if (o.st !== 'done') return { error: 'Снять отметку можно только у выданного заказа' }; o.st = 'wait'; delete o.doneAt; delete o.by; }
    else if (act === 'refund') { o.st = 'refund'; o.doneAt = Date.now(); o.by = admin.nick; if (u) u.coins = (u.coins || 0) + o.price; }
    else return { error: 'Неизвестное действие' };
    save(); onPending();
    if (u) {
      sendTo(u.id, state(u.id));
      if (act === 'done') sendTo(u.id, { type: 'toast', text: `✅ Заказ №${o.n}: промокод выдан` });
      if (act === 'refund') {
        onCoins(u.id);
        sendTo(u.id, { type: 'toast', text: `↩️ Заказ №${o.n} отменён — ${o.price} монет вернулись на баланс` });
        tell(u.id, `↩️ Заказ <b>№${o.n}</b> («${escH(it.full)}») отменён — ${o.price} монет вернулись на баланс.\n${go('/#/shop')}`);
      }
    }
    return { ok: true, st: o.st };
  }
  return { state, buy, notify, adminState, setCfg, setContact, setOrder, pending, ITEMS };
};
