// MyNTHU — 個人後端
// - 圖書館預約：Google Apps Script 讀到「預約通知函」後送進來（/mail-bookings），時間到發 Web Push
// - 待辦事項：各科／自訂類別的待辦，有截止時間的可以提醒
// - 課程：代抓清大公開課程資料（/courses），讓 app 加入這學期的課
// 資料存在 Upstash Redis（設定 UPSTASH_REDIS_REST_URL / TOKEN）；沒設定就存本機檔案（Render 重啟會清空）。

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
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = process.env.KV_KEY || 'mynthu:db';
const USE_KV = !!(KV_URL && KV_TOKEN);
const COURSE_URL = 'https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/OPENDATA/open_course_data.json';

if (!PUBLIC || !PRIVATE) {
  console.error('缺少 VAPID_PUBLIC / VAPID_PRIVATE 環境變數，請先用 npm run genkeys 產生並設定。');
  process.exit(1);
}
webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

const STARTED_AT = Date.now();
// 開始後還沒按「已報到」：每 NAG_EVERY 分鐘再響一次，最多到開始後 NAG_MAX 分鐘（或預約結束）
const NAG_EVERY = 5, NAG_MAX = 30;
let lastCron = 0;   // 只放記憶體：cron 每分鐘都會更新，不值得每分鐘寫資料庫

// ===================================================================
// 儲存
// ===================================================================
const emptyDb = () => ({ subs: {}, bookings: {}, sent: {}, snoozes: {}, cats: {}, todos: {},
  settings: { before: 10, after: 5, updatedAt: 0 } });
let db = emptyDb();

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `KV ${r.status}`);
  return j.result;
}

async function loadDb() {
  let raw = null;
  if (USE_KV) {
    // 讀不到雲端資料就不要啟動，免得用空資料把雲端的蓋掉
    for (let i = 1; ; i++) {
      try { raw = await kv(['GET', KV_KEY]); break; }
      catch (e) {
        console.error(`讀取雲端資料失敗（第 ${i} 次）：${e.message}`);
        if (i >= 5) process.exit(1);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } else {
    try { raw = readFileSync(DATA_FILE, 'utf8'); } catch (e) { /* 第一次啟動 */ }
  }
  try {
    const d = raw ? JSON.parse(raw) : null;
    if (d && d.bookings) db = { ...emptyDb(), ...d };
  } catch (e) { console.error('資料格式錯誤，從空白開始', e.message); }
  delete db.lastCron;
  // 舊資料（before/after 兩個數字）轉成新的提醒清單
  for (const [id, b] of Object.entries(db.bookings)) { const c = cleanBooking(b); if (c) db.bookings[id] = c; else delete db.bookings[id]; }
  lastSaved = JSON.stringify(db);
  console.log(`資料載入完成（${USE_KV ? 'Upstash 雲端' : '本機檔案'}）：預約 ${Object.keys(db.bookings).length}、類別 ${Object.keys(db.cats).length}、待辦 ${Object.keys(db.todos).length}`);
}

let saveTimer = null, lastSaved = '';
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 800);
}
async function persist() {
  const s = JSON.stringify(db);
  if (s === lastSaved) return;   // 沒變就不寫，省 Upstash 的免費額度
  try {
    if (USE_KV) await kv(['SET', KV_KEY, s]); else writeFileSync(DATA_FILE, s);
    lastSaved = s;
  } catch (e) {
    console.error('儲存失敗，10 秒後再試', e.message);
    clearTimeout(saveTimer); saveTimer = setTimeout(persist, 10000);
  }
}

// ===================================================================
// 工具
// ===================================================================
const clampMin = v => Math.max(0, Math.min(1440, parseInt(v, 10) || 0));
const hmTW = d => new Date(d).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
const dayTW = d => new Date(d).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
const str = (v, n) => String(v ?? '').slice(0, n);
const isoOrNull = v => { const t = Date.parse(v); return v && !isNaN(t) ? new Date(t).toISOString() : null; };
const idOk = v => typeof v === 'string' && v.length > 0 && v.length <= 120;

// 以 updatedAt 較新的為準（刪除也是一種更新，用 deleted:true 記住，其他裝置才知道被刪了）
function mergeInto(store, list, clean, max, after) {
  let changed = 0;
  for (const raw of Array.isArray(list) ? list.slice(0, max) : []) {
    const x = clean(raw); if (!x) continue;
    const cur = store[x.id];
    if (!cur || x.updatedAt > cur.updatedAt) { store[x.id] = x; after && after(x); changed++; }
  }
  return changed;
}

// ===================================================================
// 圖書館預約
// ===================================================================
// 提醒清單：{kind:'before', min} 開始前 / {kind:'after', min} 開始後 / {kind:'at', at} 指定日期時間
function cleanReminders(b) {
  const list = Array.isArray(b.reminders) ? b.reminders : [
    ...(clampMin(b.before) ? [{ kind: 'before', min: b.before }] : []),
    ...(clampMin(b.after) ? [{ kind: 'after', min: b.after }] : []),
  ];
  const out = [], seen = new Set();
  for (const r of list.slice(0, 10)) {
    let c = null;
    if (r && (r.kind === 'before' || r.kind === 'after')) c = { kind: r.kind, min: clampMin(r.min) };
    else if (r && r.kind === 'at' && isoOrNull(r.at)) c = { kind: 'at', at: isoOrNull(r.at) };
    if (!c) continue;
    const key = JSON.stringify(c);
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

function cleanBooking(b) {
  if (!b || !idOk(b.id)) return null;
  const start = Date.parse(b.start), end = Date.parse(b.end);
  if (isNaN(start) || isNaN(end) || end <= start) return null;
  return {
    id: b.id, source: b.source === 'mail' ? 'mail' : 'app',
    space: str(b.space || '圖書館預約', 60),
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    reminders: cleanReminders(b),
    checkedIn: Number(b.checkedIn) || 0,   // 按「已報到」的時間，0 = 還沒
    deleted: !!b.deleted, updatedAt: Number(b.updatedAt) || 0,
  };
}

function bookingReminders(b) {
  if (b.deleted) return [];
  const start = Date.parse(b.start);
  const when = `${dayTW(start)} ${hmTW(start)}`;
  const out = (b.reminders || []).map(r => {
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
  const list = b.checkedIn ? out.filter(r => r.kind === 'at' || r.fireAt <= b.checkedIn) : out;
  return list.map(r => ({ ...r,
    tag: r.kind === 'after' || r.kind === 'nag' ? `${b.id}|checkin` : r.id,   // 報到催促共用 tag，通知欄不會堆滿
    alert: { title: r.title, body: r.body, space: b.space, start: b.start, end: b.end, bookingId: b.id, kind: r.kind } }));
}

const visibleBookings = () => Object.values(db.bookings)
  .filter(b => Date.parse(b.end) > Date.now() - 12 * 3600e3)
  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

// ===================================================================
// 待辦：類別（課程或自訂）與待辦事項
// ===================================================================
function cleanCat(c) {
  if (!c || !idOk(c.id)) return null;
  const name = str(c.name, 40).trim();
  if (!name) return null;
  return {
    id: c.id, name, kind: c.kind === 'course' ? 'course' : 'custom',
    code: str(c.code, 20), teacher: str(c.teacher, 60), schedule: str(c.schedule, 120), sem: str(c.sem, 5),
    color: Math.max(0, Math.min(7, parseInt(c.color, 10) || 0)), order: Number(c.order) || 0,
    deleted: !!c.deleted, updatedAt: Number(c.updatedAt) || 0,
  };
}

function cleanTodo(t) {
  if (!t || !idOk(t.id) || !idOk(t.catId)) return null;
  const title = str(t.title, 200).trim();
  if (!title) return null;
  const remind = parseInt(t.remind, 10);
  return {
    id: t.id, catId: t.catId, title, note: str(t.note, 1000),
    due: isoOrNull(t.due),
    remind: Number.isFinite(remind) && remind >= 0 ? Math.min(remind, 20160) : -1,   // 截止前幾分鐘提醒，-1 = 不提醒
    done: !!t.done, doneAt: Number(t.doneAt) || 0, createdAt: Number(t.createdAt) || 0,
    deleted: !!t.deleted, updatedAt: Number(t.updatedAt) || 0,
  };
}

function todoReminders(t) {
  if (t.deleted || t.done || !t.due || t.remind < 0) return [];
  const cat = db.cats[t.catId];
  if (!cat || cat.deleted) return [];
  const due = Date.parse(t.due), fireAt = due - t.remind * 60000;
  const title = t.remind ? '📝 待辦快到期' : '📝 待辦現在截止';
  const body = `${cat.name}・${t.title}　${dayTW(due)} ${hmTW(due)} 截止`;
  const id = `todo:${t.id}|${fireAt}`;
  return [{ id, fireAt, kind: 'todo', title, body, tag: id,
    alert: { title, body, space: `${cat.name}・${t.title}`, start: t.due, end: t.due, todoId: t.id, kind: 'todo' } }];
}

// ===================================================================
// 所有提醒
// ===================================================================
const allReminders = () => [
  ...Object.values(db.bookings).flatMap(bookingReminders),
  ...Object.values(db.todos).flatMap(todoReminders),
];

// 剛加入或剛改過的東西：已經過去的提醒不要補發
function skipPast(list) {
  const now = Date.now();
  for (const r of list) if (r.fireAt < now - 60000 && !db.sent[r.id]) db.sent[r.id] = now;
}

function prune() {
  const now = Date.now(), day = 864e5;
  for (const [id, b] of Object.entries(db.bookings)) if (Date.parse(b.end) < now - 2 * day) delete db.bookings[id];
  for (const [id, t] of Object.entries(db.sent)) if (t < now - 30 * day) delete db.sent[id];
  for (const [id, s] of Object.entries(db.snoozes)) if (s.fireAt < now - day) delete db.snoozes[id];
  for (const store of [db.cats, db.todos])
    for (const [id, x] of Object.entries(store)) if (x.deleted && x.updatedAt < now - 30 * day) delete store[id];
}

function applySync(body) {
  const { bookings, settings, cats, todos } = body || {};
  mergeInto(db.bookings, bookings, cleanBooking, 300, b => skipPast(bookingReminders(b)));
  mergeInto(db.cats, cats, cleanCat, 200);
  mergeInto(db.todos, todos, cleanTodo, 3000, t => skipPast(todoReminders(t)));
  if (settings && Number(settings.updatedAt) > db.settings.updatedAt) {
    db.settings = { before: clampMin(settings.before), after: clampMin(settings.after), updatedAt: Number(settings.updatedAt) };
  }
  prune(); save();
}
const snapshot = () => ({ bookings: visibleBookings(), settings: db.settings,
  cats: Object.values(db.cats), todos: Object.values(db.todos) });

// ===================================================================
// 清大公開課程資料（全校這學期的課），快取 6 小時
// ===================================================================
let courseCache = null;
async function getCourses() {
  if (courseCache && Date.now() - courseCache.at < 6 * 3600e3) return courseCache.data;
  const r = await fetch(COURSE_URL, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`課程資料 ${r.status}`);
  const list = JSON.parse(await r.text());
  const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
  const courses = list.filter(c => !String(c['停開註記'] || '').trim()).map(c => {
    const raw = String(c['科號'] || '');
    const m = raw.match(/^(\d{5})([A-Z]+)\s*(\d+)$/);
    return {
      sem: m ? m[1] : '', code: m ? `${m[2]} ${m[3]}` : raw.trim(),
      name: String(c['課程中文名稱'] || '').trim(), en: String(c['課程英文名稱'] || '').trim(),
      teacher: lines(c['授課教師']).map(l => l.split('\t')[0]).join('、'),
      schedule: lines(c['教室與上課時間']).map(l => l.split('\t').filter(Boolean).join(' ')).join('；'),
      credits: String(c['學分數'] || ''),
    };
  });
  courseCache = { at: Date.now(), data: { sem: courses[0]?.sem || '', courses } };
  return courseCache.data;
}

// ===================================================================
// HTTP
// ===================================================================
const app = express();
app.use(express.json({ limit: '1mb' }));

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

app.get('/', (_req, res) => res.type('text').send('MyNTHU backend OK'));
// 首頁的「服務狀態」用：lastCron = 外部 cron 最後一次戳 /tick 的時間
app.get('/health', (_req, res) => res.json({
  ok: true, devices: Object.keys(db.subs).length,
  bookings: visibleBookings().filter(b => !b.deleted).length,
  now: Date.now(), startedAt: STARTED_AT, lastCron, storage: USE_KV ? 'cloud' : 'file',
}));
app.get('/vapid', (_req, res) => res.json({ key: PUBLIC }));

// webapp：同步全部資料（送出這支手機的修改，拿回合併後的完整資料）
app.get('/sync', auth, (_req, res) => res.json(snapshot()));
app.post('/sync', auth, (req, res) => { applySync(req.body); res.json({ ok: true, ...snapshot() }); });
// 舊版 app 用的路徑
app.get('/bookings', auth, (_req, res) => res.json(snapshot()));
app.post('/bookings', auth, (req, res) => { applySync(req.body); res.json({ ok: true, ...snapshot() }); });

// Apps Script：從預約通知信解析出的預約。已經有的不覆蓋（保留你的編輯和刪除）
app.post('/mail-bookings', auth, (req, res) => {
  const list = Array.isArray(req.body?.bookings) ? req.body.bookings.slice(0, 100) : [];
  let added = 0;
  for (const raw of list) {
    const b = cleanBooking({ ...raw, source: 'mail', before: db.settings.before, after: db.settings.after, updatedAt: 0 });
    if (!b || db.bookings[b.id] || Date.parse(b.end) < Date.now()) continue;
    db.bookings[b.id] = b; skipPast(bookingReminders(b)); added++;
    console.log(`mail booking added: ${b.space} ${b.start}`);
  }
  if (added) save();
  res.json({ ok: true, added });
});

// 「已報到」：之後的開始後提醒、每 5 分鐘的催促都停掉。on:false 可取消
app.post('/checkin', auth, (req, res) => {
  const b = db.bookings[req.body?.id];
  if (!b || b.deleted) return res.status(404).json({ error: 'no booking' });
  b.checkedIn = req.body.on === false ? 0 : Date.now();
  b.updatedAt = Date.now();
  save();
  res.json({ ok: true, booking: b });
});

// 通知上的「完成」：把待辦標成完成
app.post('/todo-done', auth, (req, res) => {
  const t = db.todos[req.body?.id];
  if (!t || t.deleted) return res.status(404).json({ error: 'no todo' });
  t.done = req.body.done !== false; t.doneAt = t.done ? Date.now() : 0; t.updatedAt = Date.now();
  save();
  res.json({ ok: true, todo: t });
});

// 「5 分鐘後再提醒」：一次性的提醒，不會出現在提醒清單裡
app.post('/snooze', auth, (req, res) => {
  const a = req.body?.alert;
  if (!a || typeof a !== 'object') return res.status(400).json({ error: 'no alert' });
  const min = Math.max(1, Math.min(60, parseInt(req.body.minutes, 10) || 5));
  const fireAt = Date.now() + min * 60000;
  const alert = {
    title: str(a.title || '提醒', 80), body: str(a.body, 200), space: str(a.space, 120), start: a.start, end: a.end,
    bookingId: idOk(a.bookingId) ? a.bookingId : '', todoId: idOk(a.todoId) ? a.todoId : '',
    kind: ['before', 'after', 'nag', 'at', 'todo'].includes(a.kind) ? a.kind : 'at',   // 保留原本的種類，報到／完成後就不再響
  };
  db.snoozes[`snooze|${fireAt}|${Math.random().toString(36).slice(2, 8)}`] = { fireAt, alert };
  save();
  res.json({ ok: true, fireAt });
});

// 這學期全校課程（給 app 搜尋、貼上選課結果時比對）
app.get('/courses', auth, async (_req, res) => {
  try { res.json(await getCourses()); }
  catch (e) { res.status(502).json({ error: '清大課程資料暫時抓不到：' + e.message }); }
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

// ===================================================================
// 發送到點的提醒
// ===================================================================
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
  for (const r of allReminders()) {
    if (db.sent[r.id] || r.fireAt > now) continue;
    db.sent[r.id] = now;
    if (now - r.fireAt > 15 * 60000) continue;   // 晚超過 15 分鐘就不補發了
    await pushAll(JSON.stringify({ title: r.title, body: r.body, tag: r.tag, alert: r.alert }));
    sent++;
  }
  for (const [id, s] of Object.entries(db.snoozes)) {
    if (s.fireAt > now) continue;
    delete db.snoozes[id];
    const b = db.bookings[s.alert.bookingId], t = db.todos[s.alert.todoId];
    if (b && (b.deleted || (b.checkedIn && s.alert.kind !== 'at'))) continue;   // 已刪除或已報到就算了
    if (t && (t.deleted || t.done)) continue;                                    // 待辦已完成就算了
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
  lastCron = Date.now();
  res.json({ ok: true, sent: await tick() });
});

await loadDb();
// 保險：伺服器自己也每 60 秒跑一次（沒睡著時有效；睡著時靠外部 cron 戳醒）
setInterval(() => tick().catch(() => {}), 60000);
app.listen(PORT, () => console.log(`MyNTHU backend on :${PORT}`));
