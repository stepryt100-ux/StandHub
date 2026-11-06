// Оформление профиля и промокоды на монеты StandHub.
const CATALOG = [
  { id:'frame_flame', kind:'frame', title:'Пламя', desc:'Тёплое огненное свечение' },
  { id:'frame_frost', kind:'frame', title:'Лёд', desc:'Холодный голубой контур' },
  { id:'frame_neon', kind:'frame', title:'Неон', desc:'Яркий фиолетовый акцент' },
  { id:'banner_sunset', kind:'banner', title:'Закат', desc:'Оранжевый свет над тёмным профилем' },
  { id:'banner_arctic', kind:'banner', title:'Арктика', desc:'Синие блики и ледяные оттенки' },
  { id:'banner_cosmos', kind:'banner', title:'Космос', desc:'Фиолетовое сияние и звёздные точки' },
  { id:'banner_custom', kind:'banner', title:'Свой фон', desc:'Загрузите свою фотографию и меняйте её в любое время' },
];
const getItem = id => CATALOG.find(x => x.id === id);
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
module.exports = function ({ db, save, onCoins }) {
  const A = db.appearance = db.appearance || {};
  A.cfg = A.cfg || {}; A.promos = A.promos || [];
  if (!A.cfg.banner_custom) A.cfg.banner_custom = {price:500, on:true};
  const attempts = new Map();
  const owned = u => Array.isArray(u.cosmetics) ? u.cosmetics : [];
  const active = u => {
    const result = { frame:null, banner:null };
    for (const k of ['frame','banner']) { const id = u && u.appearance && u.appearance[k], it = getItem(id); if (it && it.kind === k && owned(u).includes(id) && (id !== 'banner_custom' || !!u.bannerImage)) result[k] = id; }
    return result;
  };
  const state = u => ({ items: CATALOG.map(it => ({ ...it, price: A.cfg[it.id]?.price ?? null, on: A.cfg[it.id]?.on === true, owned: !!u && owned(u).includes(it.id), ...(it.id === 'banner_custom' && u ? {hasImage: !!u.bannerImage} : {}) })), active: u ? active(u) : {frame:null,banner:null} });
  function configure(id, price, on) {
    const it=getItem(id); if(!it) return {error:'Товар не найден'};
    if (price !== null && !integer(price,1,1000000)) return {error:'Цена — целое число от 1 до 1 000 000 монет'};
    if (on && price === null) return {error:'Укажите цену перед включением продажи'};
    A.cfg[id]={price,on:!!on}; save(); return {ok:true};
  }
  function buy(u,id) {
    const it=getItem(id), cfg=A.cfg[id]; if(!it) return {error:'Товар не найден'};
    if(owned(u).includes(id)) return {error:'Этот предмет уже куплен'};
    if(!cfg || !cfg.on || !integer(cfg.price,1,1000000)) return {error:'Товар пока не продаётся'};
    if((u.coins||0)<cfg.price) return {error:'Недостаточно монет'};
    u.coins=(u.coins||0)-cfg.price; u.cosmetics=[...owned(u),id];
    A.purchases=A.purchases||[]; A.purchases.push({uid:u.id,item:id,price:cfg.price,at:Date.now()});
    save(); onCoins(u.id); return {ok:true,coins:u.coins};
  }
  function equip(u,kind,id) {
    if(!['frame','banner'].includes(kind)) return {error:'Неизвестный тип оформления'};
    if(id) { const it=getItem(id); if(!it || it.kind!==kind || !owned(u).includes(id)) return {error:'Сначала купите этот предмет'}; if(id==='banner_custom' && !u.bannerImage) return {error:'Сначала загрузите фотографию'}; }
    u.appearance={...(u.appearance||{}),[kind]:id||null}; save(); return {ok:true,active:active(u)};
  }
  function setBanner(u, bytes) {
    if(!owned(u).includes('banner_custom')) return {error:'Сначала купите свой фон в магазине'};
    u.bannerImage=bytes.toString('base64'); u.bannerV=Date.now(); u.appearance={...(u.appearance||{}),banner:'banner_custom'};
    save(); return {ok:true};
  }
  function removeBanner(u) {
    if(!owned(u).includes('banner_custom')) return {error:'Сначала купите свой фон в магазине'};
    delete u.bannerImage; delete u.bannerV;
    if(u.appearance && u.appearance.banner==='banner_custom') u.appearance.banner=null;
    save(); return {ok:true};
  }
  const validCode = code => /^[A-Z0-9_-]{3,32}$/.test(code);
  const norm = code => String(code||'').trim().toUpperCase();
  const promoView = x => ({code:x.code, coins:x.coins, max:x.max, used:x.used.length, on:x.on, created:x.created});
  function adminPromos() { return A.promos.map(promoView).reverse(); }
  function createPromo(b) {
    const code=norm(b.code), coins=Number(b.coins), max=Number(b.max);
    if(!validCode(code)) return {error:'Код: 3–32 символа, латинские буквы, цифры, - или _'};
    if(A.promos.some(p=>p.code===code)) return {error:'Такой промокод уже существует'};
    if(!integer(coins,1,1000000)) return {error:'Награда — целое число от 1 до 1 000 000 монет'};
    if(!integer(max,1,1000000)) return {error:'Число активаций — от 1 до 1 000 000'};
    A.promos.push({code,coins,max,on:true,used:[],created:Date.now()}); save(); return {ok:true};
  }
  function updatePromo(b) {
    const p=A.promos.find(x=>x.code===norm(b.code)); if(!p) return {error:'Промокод не найден'};
    const max=Number(b.max); if(!integer(max,1,1000000)||max<p.used.length) return {error:`Лимит — не меньше числа активаций (${p.used.length}) и не больше 1 000 000`};
    p.max=max; p.on=b.on===true; save(); return {ok:true};
  }
  function redeem(u,code) {
    const now=Date.now(), prior=(attempts.get(u.id)||[]).filter(t=>t>now-60000);
    if(prior.length>=10) return {error:'Слишком много попыток. Попробуйте через минуту'};
    prior.push(now); attempts.set(u.id,prior);
    const p=A.promos.find(x=>x.code===norm(code)); if(!p || !p.on) return {error:'Промокод не найден или отключён'};
    if(p.used.some(x=>x.uid===u.id)) return {error:'Вы уже активировали этот промокод'};
    if(p.used.length>=p.max) return {error:'Лимит активаций промокода исчерпан'};
    p.used.push({uid:u.id,at:now}); u.coins=(u.coins||0)+p.coins; save(); onCoins(u.id);
    return {ok:true,added:p.coins,coins:u.coins};
  }
  return { state, active, configure, buy, equip, setBanner, removeBanner, adminPromos, createPromo, updatePromo, redeem };
};
