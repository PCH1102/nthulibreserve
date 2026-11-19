// 清大圖書館座位 — 個人推播後端
// 預約來源：Google Apps Script 讀到圖書館「預約通知函」後送進來（/mail-bookings）
// webapp 可以查看、編輯、刪除每筆預約的通知（/bookings）
// 每筆預約可以有多則提醒（開始前 / 開始後幾分鐘 / 指定日期時間），時間到發 Web Push。

import express from 'express';
import webpush from 'web-push';
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = process.env.PORT || 3000;
const PUBLIC = process.env.VAPID_PUBLIC || '';
const PRIVATE = process.env.VAPID_PRIVATE || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
// 通行碼：webapp 與 Apps Script 都要帶這個才能讀寫。沒另外設 APP_TOKEN 就沿用 TICK_TOKEN。
const TOKEN = process.env.APP_TOKEN || process.env.TICK_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || './data.json';

if (!PUBLIC || !PRIVATE) {
  console.error('缺少 VAPID_PUBLIC / VAPID_PRIVATE 環境變數，請先用 npm run genkeys 產生並設定。');
  process.exit(1);
}
webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

// ---- 儲存 ----
// Render 免費方案重啟會清空檔案；Apps Script 每 5 分鐘會重送預約、webapp 開啟時會重送你的編輯，所以會自己補回來。
const emptyDb = () => ({ subs: {}, bookings: {}, sent: {}, snoozes: {}, lastCron: 0, settings: { before: 10, after: 5, updatedAt: 0 } });
const STARTED_AT = Date.now();
// 開始後還沒按「已報到」：每 NAG_EVERY 分鐘再響一次，最多到開始後 NAG_MAX 分鐘（或預約結束）
const NAG_EVERY = 5, NAG_MAX = 30;
let db = emptyDb();
try {
  const d = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  if (d && d.bookings) db = { ...emptyDb(), ...d };   // 舊版格式就直接重來
} catch (e) { /* 第一次啟動 */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save failed', e.message); }
  }, 500);
}

// ---- 工具 ----
const clampMin = v => Math.max(0, Math.min(1440, parseInt(v, 10) || 0));
const hmTW = d => new Date(d).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
const dayTW = d => new Date(d).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });

// 提醒清單：{kind:'before', min} 開始前 / {kind:'after', min} 開始後 / {kind:'at', at} 指定日期時間
// 舊格式（before / after 兩個數字）會自動轉換
function cleanReminders(b) {
  const list = Array.isArray(b.reminders) ? b.reminders : [
    ...(clampMin(b.before) ? [{ kind: 'before', min: b.before }] : []),
    ...(clampMin(b.after) ? [{ kind: 'after', min: b.after }] : []),
  ];
  const out = [], seen = new Set();
  for (const r of list.slice(0, 10)) {
    let c = null;
    if (r && (r.kind === 'before' || r.kind === 'after')) c = { kind: r.kind, min: clampMin(r.min) };
    else if (r && r.kind === 'at' && !isNaN(Date.parse(r.at))) c = { kind: 'at', at: new Date(Date.parse(r.at)).toISOString() };
    if (!c) continue;
    const key = JSON.stringify(c);
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

function cleanBooking(b) {
  if (!b || typeof b.id !== 'string' || !b.id) return null;
  const start = Date.parse(b.start), end = Date.parse(b.end);
  if (isNaN(start) || isNaN(end) || end <= start) return null;
  return {
    id: b.id.slice(0, 120),
    source: b.source === 'mail' ? 'mail' : 'app',
    space: String(b.space || '圖書館預約').slice(0, 60),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    reminders: cleanReminders(b),
    checkedIn: Number(b.checkedIn) || 0,   // 按「已報到」的時間，0 = 還沒
    deleted: !!b.deleted,
    updatedAt: Number(b.updatedAt) || 0,
  };
}

// 每筆預約的提醒。id 含觸發時間，所以改了時間就是一則新的提醒，會重新發送。
function remindersOf(b) {
  if (b.deleted) return [];
  const start = Date.parse(b.start);
  const out = baseReminders(b);
  // 有「開始後」提醒、又還沒報到：之後每 5 分鐘再催一次
  const afters = (b.reminders || []).filter(r => r.kind === 'after');
  if (afters.length) {
    const first = start + Math.min(...afters.map(r => r.min)) * 60000;
    const stop = Math.min(Date.parse(b.end), start + NAG_MAX * 60000);
    for (let t = first + NAG_EVERY * 60000; t <= stop; t += NAG_EVERY * 60000) {
      out.push({ id: `${b.id}|n|${t}`, fireAt: t, kind: 'nag', title: '⚠️ 還沒報到嗎？',
        body: `${b.space} 已開始 ${Math.round((t - start) / 60000)} 分鐘。報到了就按「已報到」，就不會再提醒` });
    }
  }
  // 已報到：之後和開始時間有關的提醒都不用響了（指定時間的照響）
  return b.checkedIn ? out.filter(r => r.kind === 'at' || r.fireAt <= b.checkedIn) : out;
}

function baseReminders(b) {
  const start = Date.parse(b.start);
  const when = `${dayTW(start)} ${hmTW(start)}`;
  return (b.reminders || []).map(r => {
    if (r.kind === 'before') {
      const t = start - r.min * 60000;
      return { id: `${b.id}|b|${t}`, fireAt: t, kind: 'before', title: r.min ? '圖書館預約即將開始' : '圖書館預約現在開始',
        body: r.min ? `${b.space}　${r.min} 分鐘後（${hmTW(start)}）開始` : `${b.space}　${hmTW(start)} 開始，記得刷卡報到` };
    }
    if (r.kind === 'after') {
      const t = start + r.min * 60000;
      return { id: `${b.id}|a|${t}`, fireAt: t, kind: 'after', title: '⚠️ 記得刷卡報到',
        body: `${b.space} 已開始 ${r.min} 分鐘，還沒刷卡請立刻去報到` };
    }
    const t = Date.parse(r.at);
    return { id: `${b.id}|t|${t}`, fireAt: t, kind: 'at', title: '圖書館預約提醒', body: `${b.space}　${when} 開始` };
  });
}

// 剛加入或剛改過的預約：已經過去的提醒不要補發
function skipPast(b) {
  const now = Date.now();
  for (const r of remindersOf(b)) if (r.fireAt < now - 60000 && !db.sent[r.id]) db.sent[r.id] = now;
}

// 以 updatedAt 較新的為準（刪除也是一種更新，用 deleted:true 記住，避免被信件重新加回來）
function mergeBookings(list) {
  let changed = 0;
  for (const raw of Array.isArray(list) ? list.slice(0, 300) : []) {
    const b = cleanBooking(raw); if (!b) continue;
    const cur = db.bookings[b.id];
    if (!cur || b.updatedAt > cur.updatedAt) { db.bookings[b.id] = b; skipPast(b); changed++; }
  }
  return changed;
}

function prune() {
  const cutoff = Date.now() - 2 * 864e5;
  for (const [id, b] of Object.entries(db.bookings)) if (Date.parse(b.end) < cutoff) delete db.bookings[id];
  for (const [id, t] of Object.entries(db.sent)) if (t < cutoff) delete db.sent[id];
}

const visibleBookings = () => Object.values(db.bookings)
  .filter(b => Date.parse(b.end) > Date.now() - 12 * 3600e3)
  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

// 舊資料（before/after 兩個數字）轉成新的提醒清單
for (const [id, b] of Object.entries(db.bookings)) { const c = cleanBooking(b); if (c) db.bookings[id] = c; else delete db.bookings[id]; }

// ---- HTTP ----
const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS：允許你的 GitHub Pages 與本機測試
const ALLOW = [/\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOW.some(re => re.test(o))) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Token');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const auth = (req, res, next) =>
  (!TOKEN || req.get('X-Token') === TOKEN || req.query.token === TOKEN) ? next() : res.status(401).json({ error: 'bad token' });

app.get('/', (_req, res) => res.type('text').send('nthu-lib push backend OK'));
// 首頁的「提醒服務狀態」用：lastCron = 外部 cron 最後一次戳 /tick 的時間
app.get('/health', (_req, res) => res.json({
  ok: true, devices: Object.keys(db.subs).length,
  bookings: visibleBookings().filter(b => !b.deleted).length,
  now: Date.now(), startedAt: STARTED_AT, lastCron: db.lastCron || 0,
}));

// 「已報到」：之後的開始後提醒、每 5 分鐘的催促都停掉。on:false 可取消
app.post('/checkin', auth, (req, res) => {
  const b = db.bookings[req.body?.id];
  if (!b || b.deleted) return res.status(404).json({ error: 'no booking' });
  b.checkedIn = req.body.on === false ? 0 : Date.now();
  b.updatedAt = Date.now();
  save();
  res.json({ ok: true, booking: b });
});

// 「5 分鐘後再提醒」：一次性的提醒，不會出現在預約的提醒清單裡
app.post('/snooze', auth, (req, res) => {
  const a = req.body?.alert;
  if (!a || typeof a !== 'object') return res.status(400).json({ error: 'no alert' });
  const min = Math.max(1, Math.min(60, parseInt(req.body.minutes, 10) || 5));
  const fireAt = Date.now() + min * 60000;
  const alert = {
    title: String(a.title || '圖書館預約提醒').slice(0, 80), body: String(a.body || '').slice(0, 200),
    space: String(a.space || '').slice(0, 60), start: a.start, end: a.end,
    bookingId: typeof a.bookingId === 'string' ? a.bookingId.slice(0, 120) : '',
    kind: ['before', 'after', 'nag', 'at'].includes(a.kind) ? a.kind : 'at',   // 保留原本的種類，報到後就不再響
  };
  db.snoozes[`snooze|${fireAt}|${Math.random().toString(36).slice(2, 8)}`] = { fireAt, alert };
  save();
  res.json({ ok: true, fireAt });
});
app.get('/vapid', (_req, res) => res.json({ key: PUBLIC }));

// webapp：讀取所有預約（含已刪除的標記，讓手機端也知道被刪了）
app.get('/bookings', auth, (_req, res) => res.json({ bookings: visibleBookings(), settings: db.settings }));

// webapp：送出編輯／刪除／預設值，回傳合併後的完整清單
app.post('/bookings', auth, (req, res) => {
  const { bookings, settings } = req.body || {};
  const changed = mergeBookings(bookings);
  if (settings && Number(settings.updatedAt) > db.settings.updatedAt) {
    db.settings = { before: clampMin(settings.before), after: clampMin(settings.after), updatedAt: Number(settings.updatedAt) };
  }
  prune(); save();
  res.json({ ok: true, changed, bookings: visibleBookings(), settings: db.settings });
});

// Apps Script：從預約通知信解析出的預約。已經有的不覆蓋（保留你的編輯和刪除）
app.post('/mail-bookings', auth, (req, res) => {
  const list = Array.isArray(req.body?.bookings) ? req.body.bookings.slice(0, 100) : [];
  let added = 0;
  for (const raw of list) {
    const b = cleanBooking({ ...raw, source: 'mail', before: db.settings.before, after: db.settings.after, updatedAt: 0 });
    if (!b || db.bookings[b.id] || Date.parse(b.end) < Date.now()) continue;
    db.bookings[b.id] = b; skipPast(b); added++;
    console.log(`mail booking added: ${b.space} ${b.start}`);
  }
  if (added) save();
  res.json({ ok: true, added });
});

// 手機訂閱推播（每次開 app 都會重送，後端重啟後自動補回）
app.post('/subscribe', auth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'no subscription' });
  db.subs[sub.endpoint] = sub; save();
  res.json({ ok: true });
});

app.post('/test', auth, async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'no subscription' });
  try {
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const end = new Date(Date.now() + 130 * 60000).toISOString();
    await webpush.sendNotification(sub, JSON.stringify({ title: '測試推播', body: '收到這則就代表推播設定成功 🎉 點我看全螢幕提醒',
      tag: 'test', alert: { title: '測試：圖書館預約即將開始', body: '', space: '享時小間 605（測試）', start, end, bookingId: '', kind: 'before' } }));
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.statusCode || e.message }); }
});

// 診斷用：對所有已訂閱裝置送一則測試推播
app.all('/testall', auth, async (_req, res) => {
  const results = [];
  for (const [endpoint, sub] of Object.entries(db.subs)) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title: '診斷測試', body: '這則是後端直接送出的 ✅' }));
      results.push({ endpoint: endpoint.slice(0, 40) + '…', ok: true });
    } catch (e) {
      results.push({ endpoint: endpoint.slice(0, 40) + '…', ok: false, status: e.statusCode || null });
      if (e.statusCode === 404 || e.statusCode === 410) delete db.subs[endpoint];
    }
  }
  save();
  res.json({ devices: results.length, results });
});

// ---- 發送到點的提醒 ----
async function pushAll(payload) {
  for (const [endpoint, sub] of Object.entries(db.subs)) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) delete db.subs[endpoint]; }   // 訂閱已失效
  }
}

// 外部 cron 和內建 setInterval 可能同時呼叫；同一時間只跑一個，避免重複發送
let ticking = null;
function tick() {
  if (!ticking) ticking = runTick().finally(() => { ticking = null; });
  return ticking;
}
async function runTick() {
  const now = Date.now();
  let sent = 0;
  for (const b of Object.values(db.bookings)) {
    for (const r of remindersOf(b)) {
      if (db.sent[r.id] || r.fireAt > now) continue;
      db.sent[r.id] = now;
      if (now - r.fireAt > 15 * 60000) continue;   // 晚超過 15 分鐘就不補發了
      // 報到催促用同一個 tag：新的一則會取代舊的，通知欄不會堆滿
      const tag = r.kind === 'after' || r.kind === 'nag' ? `${b.id}|checkin` : r.id;
      await pushAll(JSON.stringify({ title: r.title, body: r.body, tag,
        alert: { title: r.title, body: r.body, space: b.space, start: b.start, end: b.end, bookingId: b.id, kind: r.kind } }));
      sent++;
    }
  }
  for (const [id, s] of Object.entries(db.snoozes)) {
    if (s.fireAt > now) continue;
    delete db.snoozes[id];
    const b = db.bookings[s.alert.bookingId];
    if (b && (b.deleted || (b.checkedIn && s.alert.kind !== 'at'))) continue;   // 已刪除或已報到就算了
    if (now - s.fireAt > 15 * 60000) continue;
    const title = s.alert.title.startsWith('⏰') ? s.alert.title : '⏰ ' + s.alert.title;
    await pushAll(JSON.stringify({ title, body: s.alert.body || s.alert.space, tag: id, alert: { ...s.alert, title } }));
    sent++;
  }
  prune(); save();
  return sent;
}

// 外部 cron（cron-job.org）每分鐘戳這裡；記下時間讓首頁能顯示服務是否正常
app.all('/tick', auth, async (_req, res) => {
  db.lastCron = Date.now();
  res.json({ ok: true, sent: await tick() });
});

// 保險：伺服器自己也每 60 秒跑一次（沒睡著時有效；睡著時靠外部 cron 戳醒）
setInterval(() => tick().catch(() => {}), 60000);

app.listen(PORT, () => console.log(`push backend on :${PORT}`));
