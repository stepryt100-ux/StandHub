// proofs.js — доказательства по матчу. Игрок присылает боту запись экрана, скриншоты или комментарий,
// бот пересылает их администраторам в Telegram. На сайте файлы не хранятся — только отметка, кто сколько прислал.
const SESSION = 30 * 60e3; // после кнопки «Отправить доказательства» бот ждёт файлы 30 минут (каждый файл продлевает)
const plural = (n, a, b, c) => { const k = n % 100, j = n % 10; return n + ' ' + (k >= 11 && k <= 14 ? c : j === 1 ? a : j >= 2 && j <= 4 ? b : c); };

module.exports = function ({ db, tg, say, escH, go, match, isCmd, adminChats }) {
  const sess = new Map();  // chatId -> { mid, uid, until }
  const acks = new Map();  // chatId -> { files, notes, m, t } — ответ «Передал…» один на пачку файлов
  const fullAt = new Map(); // chatId -> когда сказали «хватит», чтобы не повторять на каждый файл
  const HINT = 'Если это доказательство по матчу — откройте матч на сайте и нажмите «Отправить доказательства».';
  const usersOf = chatId => db.users.filter(u => u.verified && u.tgChat === chatId);
  const kindOf = msg => (msg.photo ? 'photo' : msg.video || msg.animation ? 'video' : msg.video_note ? 'video_note'
    : msg.document ? (/^video\//.test(msg.document.mime_type || '') ? 'video' : /^image\//.test(msg.document.mime_type || '') ? 'photo' : 'file') : null);
  const titleOf = m => `матч #${m.id} (${match.MODE_NAME[m.mode]}, ${m.map})`;
  const capNick = (m, t) => { const c = match.P(m, m.captains[t]); return c ? c.nick : t; };

  // /start proof_<id> — кнопка «Отправить доказательства» на странице матча
  function start(chatId, mid) {
    const us = usersOf(chatId);
    if (!us.length) return say(chatId, 'Сначала подтвердите аккаунт StandHub — после этого сюда можно присылать доказательства по матчам.\n' + go('/#/register'));
    let best = null;
    for (const u of us) { const r = match.proofCheck(mid, u.id); if (r.ok) { best = { u, r }; break; } if (!best || r.error === 'old') best = { u, r }; }
    const { u, r } = best;
    if (!r.ok) return say(chatId, r.error === 'old'
      ? '⌛ Этот матч закончился больше суток назад — доказательства по нему уже не принимаются. Если что-то случилось, напишите в поддержку:\n' + go('/#/support')
      : '❌ Матч не найден или вы в нём не играли.');
    if (r.left <= 0) return say(chatId, `По этому матчу вы уже прислали ${match.PROOF_MAX} файлов — этого достаточно, администратор всё посмотрит.`);
    sess.set(chatId, { mid: r.m.id, uid: u.id, until: Date.now() + SESSION });
    return say(chatId, `📎 <b>Доказательства · ${titleOf(r.m)}</b>\n\nПришлите сюда запись экрана или скриншоты итогового счёта — я передам их администратору. Можно добавить подпись или написать комментарий отдельным сообщением.\nДо ${match.PROOF_MAX} файлов по матчу.`);
  }

  // куда отнести сообщение: матч из кнопки «Отправить доказательства» или спорный матч игрока
  function targetOf(chatId, us) {
    let s = sess.get(chatId);
    if (s && s.until < Date.now()) { sess.delete(chatId); s = null; }
    if (s) { const r = match.proofCheck(s.mid, s.uid); if (r.ok) return { m: r.m, uid: s.uid, left: r.left, s }; sess.delete(chatId); }
    for (const u of us) { const m = match.disputedOf(u.id); const r = m && match.proofCheck(m.id, u.id); if (r && r.ok) return { m, uid: u.id, left: r.left }; }
    return null;
  }

  function ack(chatId, m, kind) {
    const a = acks.get(chatId) || { files: 0, notes: 0 };
    clearTimeout(a.t); if (kind) a.files++; else a.notes++; a.m = m;
    a.t = setTimeout(() => {
      acks.delete(chatId);
      const parts = [a.files && plural(a.files, 'файл', 'файла', 'файлов'), a.notes && (a.notes === 1 ? 'комментарий' : plural(a.notes, 'комментарий', 'комментария', 'комментариев'))].filter(Boolean).join(' и ');
      say(chatId, `✅ Передал администратору: ${parts} · ${titleOf(a.m)}.\nМожно прислать ещё — администратор посмотрит всё и выставит итог.`).catch(() => {});
    }, 1500);
    acks.set(chatId, a);
  }

  // файл или комментарий из чата с ботом: true — сообщение обработано здесь
  async function handle(msg) {
    const chatId = msg.chat.id, kind = kindOf(msg), text = (msg.text || '').trim();
    if (db.users.some(x => !x.verified && x.tgChat === chatId)) return false; // идёт подтверждение аккаунта — скриншоты нужны для него
    if (!kind && (!text || text.startsWith('/') || /^\d{6}$/.test(text) || isCmd(text))) return false;
    const us = usersOf(chatId); if (!us.length) return false;
    const t = targetOf(chatId, us);
    if (!t) {
      if (!kind || kind === 'photo') return false; // текст и фото без матча — обычные ответы бота
      await say(chatId, `✅ Аккаунт <b>${escH(us[0].nick)}</b> уже подтверждён.\n\n${HINT}`); return true;
    }
    if (t.left <= 0) {
      if (Date.now() - (fullAt.get(chatId) || 0) > 60e3) { fullAt.set(chatId, Date.now()); await say(chatId, `По этому матчу вы уже прислали ${match.PROOF_MAX} файлов — этого достаточно, администратор всё посмотрит.`); }
      return true;
    }
    const all = adminChats(), to = all.filter(c => c !== chatId);
    if (!all.length) { await say(chatId, 'Сейчас некому передать: администратор ещё не подключил Telegram. Опишите ситуацию в поддержке на сайте:\n' + go('/#/support')); return true; }
    if (t.s) t.s.until = Date.now() + SESSION;
    const m = t.m, u = db.users.find(x => x.id === t.uid), me = match.P(m, t.uid);
    match.addProof(m.id, t.uid, kind || 'text'); // сразу занимаем место — файлы альбома приходят почти одновременно
    const head = `📎 <b>Доказательства</b> · ${titleOf(m)}\nОт: <b>${escH(u.nick)}</b> (команда ${escH(capNick(m, me.team))})`;
    for (const c of to) {
      try {
        if (!kind) await say(c, `${head}\n💬 ${escH(text.slice(0, 1500))}`);
        else if (kind === 'video_note') { await say(c, head); await tg('copyMessage', { chat_id: c, from_chat_id: chatId, message_id: msg.message_id }); }
        else {
          const mk = cap => head + (cap ? '\n💬 ' + escH(cap) : '');
          let cap = (msg.caption || '').slice(0, 700), body = mk(cap);
          while (body.length > 1024 && cap) { cap = cap.slice(0, -100); body = mk(cap); }
          await tg('copyMessage', { chat_id: c, from_chat_id: chatId, message_id: msg.message_id, caption: body, parse_mode: 'HTML' });
        }
      } catch (e) { console.error('Доказательство не переслано:', e.message); }
    }
    ack(chatId, m, kind);
    return true;
  }

  return { start, handle, HINT };
};
