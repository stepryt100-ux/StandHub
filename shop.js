// shop.js — магазин: монеты за задания меняются на награды. Промокоды выдаются автоматически из запаса, который пополняет администратор
const crypto = require('crypto');
const DAY = 24 * 3600e3, WEEK = 7 * DAY;
// товары. Цена, лимит покупок и «продаётся/нет» меняются в админке (db.shop.cfg)
const ITEMS = [{ id: 'gold1000', title: '1000 голды', full: 'Промокод на 1000 голды', price: 150 }];
const MAX_ADD = 1000, CODE_MAX = 64;
const whenMsk = t => new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' МСК';

module.exports = function ({ db, save, sendTo, sendAll, tell, alertAdmins, go, escH, onCoins }) {
  const S = db.shop = db.shop || {};
  S.codes = S.codes || {}; S.cfg = S.cfg || {}; S.wait = S.wait || {}; S.orders = S.orders || [];
  for (const it of ITEMS) { S.codes[it.id] = S.codes[it.id] || []; S.cfg[it.id] = { price: it.price, on: true, limit: 0, ...S.cfg[it.id] }; S.wait[it.id] = S.wait[it.id] || []; }
  const item = id => ITEMS.find(x => x.id === id);
  const stock = id => S.codes[id].length;
  const nickOf = uid => (db.users.find(u => u.id === uid) || {}).nick || 'Игрок';
  // лимит «N в неделю»: когда снова можно купить (0 — можно сейчас)
  function nextAt(uid, id) {
    const c = S.cfg[id]; if (!c.limit) return 0;
    const recent = S.orders.filter(o => o.uid === uid && o.item === id && o.at > Date.now() - WEEK).sort((a, b) => a.at - b.at);
    return recent.length >= c.limit ? recent[recent.length - c.limit].at + WEEK : 0;
  }
  const pub = (it, uid) => { const c = S.cfg[it.id]; return { id: it.id, title: it.title, full: it.full, price: c.price, on: c.on, limit: c.limit || 0, stock: stock(it.id), ...(uid ? { wait: S.wait[it.id].includes(uid), next: nextAt(uid, it.id) } : {}) }; };
  const ord = o => ({ id: o.id, item: o.item, title: (item(o.item) || { full: o.item }).full, code: o.code, price: o.price, at: o.at });
  const mine = uid => S.orders.filter(o => o.uid === uid).sort((a, b) => b.at - a.at).slice(0, 50).map(ord);
  const state = uid => ({ type: 'shop', items: ITEMS.map(it => pub(it, uid)), orders: uid ? mine(uid) : [] });
  // остаток, цена или лимит изменились — обновляем у всех, у кого открыт сайт (личные поля клиент сохраняет у себя)
  const pushAll = () => sendAll({ type: 'shopItems', items: ITEMS.map(it => pub(it)) });

  function buy(u, id) {
    const it = item(id); if (!it) return { error: 'Товар не найден' };
    const c = S.cfg[id];
    if (!c.on) return { error: 'Этот товар сейчас не продаётся' };
    if (!stock(id)) return { error: 'Промокоды закончились. Нажмите «Сообщить о поступлении» — напишем, когда появятся' };
    const n = nextAt(u.id, id); if (n) return { error: `Можно купить не больше ${c.limit} в неделю. Следующая покупка — ${whenMsk(n)}` };
    if ((u.coins || 0) < c.price) return { error: `Не хватает ${c.price - (u.coins || 0)} монет` };
    const code = S.codes[id].shift();
    u.coins = (u.coins || 0) - c.price;
    const o = { id: crypto.randomBytes(6).toString('hex'), uid: u.id, item: id, code, price: c.price, at: Date.now() };
    S.orders.push(o); save();
    onCoins(u.id); pushAll();
    tell(u.id, `🛒 <b>Покупка в магазине StandHub</b>\n${escH(it.full)} — ${c.price} монет\n\nВаш промокод:\n<code>${escH(code)}</code>\n(нажмите на код — он скопируется)\n\n<b>Как активировать:</b>\n1. Зайдите в StandLeo\n2. На главном экране нажмите «События»\n3. Откройте «Секретный код» и вставьте промокод\n\nКод всегда есть на сайте в «Мои покупки»:\n${go('/#/shop')}`);
    const left = stock(id), more = left === 0 ? `\n\n⚠️ Промокоды закончились — добавьте новые:\n${go('/#/admin/shop')}` : left <= 3 ? `\n\nСкоро закончатся — добавьте новые:\n${go('/#/admin/shop')}` : '';
    alertAdmins(`🛒 <b>${escH(u.nick)}</b> купил(а) «${escH(it.full)}» за ${c.price} монет\nОсталось кодов: <b>${left}</b>${more}`);
    return { ok: true, order: ord(o), coins: u.coins };
  }
  // «Сообщить о поступлении»: напишем в Telegram и на сайте, когда админ добавит коды
  function notify(u, id, on) {
    if (!item(id)) return { error: 'Товар не найден' };
    const w = S.wait[id], i = w.indexOf(u.id);
    if (on && i < 0) w.push(u.id); else if (!on && i >= 0) w.splice(i, 1);
    save(); return { ok: true, wait: w.includes(u.id) };
  }

  // ---------- админка ----------
  const adminState = () => ({
    items: ITEMS.map(it => ({ ...pub(it), codes: S.codes[it.id].slice(), sold: S.orders.filter(o => o.item === it.id).length, waiting: S.wait[it.id].length })),
    orders: S.orders.slice(-100).reverse().map(o => ({ ...ord(o), nick: nickOf(o.uid) })),
  });
  function addCodes(id, text) {
    const it = item(id); if (!it) return { error: 'Товар не найден' };
    const list = String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (!list.length) return { error: 'Вставьте промокоды — каждый с новой строки' };
    if (list.length > MAX_ADD) return { error: `За раз можно добавить не больше ${MAX_ADD} кодов` };
    const long = list.find(s => s.length > CODE_MAX); if (long) return { error: `Слишком длинный код: ${long.slice(0, 24)}…` };
    const have = new Set([...S.codes[id], ...S.orders.filter(o => o.item === id).map(o => o.code)]);
    const was = stock(id); let added = 0, dup = 0;
    for (const s of list) { if (have.has(s)) { dup++; continue; } have.add(s); S.codes[id].push(s); added++; }
    let told = 0;
    if (added && was === 0 && S.cfg[id].on) told = restocked(it);
    save(); pushAll();
    return { ok: true, added, dup, told, stock: stock(id) };
  }
  // товар снова появился — сообщаем тем, кто просил
  function restocked(it) {
    const ws = S.wait[it.id].splice(0);
    for (const uid of ws) {
      tell(uid, `🛒 В магазине StandHub снова есть «${escH(it.full)}» — успейте купить:\n${go('/#/shop')}`);
      sendTo(uid, { type: 'toast', text: `🛒 В магазине снова есть «${it.full}»` });
    }
    return ws.length;
  }
  function removeCode(id, code) {
    if (!item(id)) return { error: 'Товар не найден' };
    const i = S.codes[id].indexOf(code); if (i < 0) return { error: 'Такого кода нет в наличии — возможно, его уже купили' };
    S.codes[id].splice(i, 1); save(); pushAll(); return { ok: true, stock: stock(id) };
  }
  function setCfg(id, b) {
    const it = item(id); if (!it) return { error: 'Товар не найден' };
    const c = S.cfg[id], wasOn = c.on;
    if (b.price != null) { const p = Number(b.price); if (!Number.isInteger(p) || p < 1 || p > 1e6) return { error: 'Цена — целое число от 1 до 1 000 000 монет' }; }
    if (b.limit != null) { const l = Number(b.limit); if (!Number.isInteger(l) || l < 0 || l > 100) return { error: 'Лимит — от 0 до 100 покупок в неделю (0 — без лимита)' }; }
    if (b.price != null) c.price = Number(b.price);
    if (b.limit != null) c.limit = Number(b.limit);
    if (b.on != null) c.on = !!b.on;
    const told = !wasOn && c.on && stock(id) ? restocked(it) : 0;
    save(); pushAll(); return { ok: true, told };
  }
  return { state, buy, notify, adminState, addCodes, removeCode, setCfg, ITEMS };
};
