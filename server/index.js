// 清大圖書館座位 — 個人推播後端
// 只存「推播訂閱」與「提醒時間」，不碰任何學校帳密或預約系統。
// 前端把每筆提醒的觸發時間算好送來，這裡在時間到時發 Web Push。

import express from 'express';
import webpush from 'web-push';
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = process.env.PORT || 3000;
const PUBLIC = process.env.VAPID_PUBLIC || '';
const PRIVATE = process.env.VAPID_PRIVATE || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
const TICK_TOKEN = process.env.TICK_TOKEN || '';          // 保護 /tick，避免被亂打
const DATA_FILE = process.env.DATA_FILE || './data.json';

if (!PUBLIC || !PRIVATE) {
  console.error('缺少 VAPID_PUBLIC / VAPID_PRIVATE 環境變數，請先用 npm run genkeys 產生並設定。');
  process.exit(1);
}
webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

// ---- 儲存（檔案 best-effort；Render 免費方案重新部署會清空，前端每次開啟會重新同步，所以沒關係）----
let devices = {};   // { [endpoint]: { subscription, reminders:[{id, fireAt, title, body, sent}] } }
try { devices = JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(DATA_FILE, JSON.stringify(devices)); } catch (e) { console.error('save failed', e.message); }
  }, 500);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS：允許你的 GitHub Pages 與本機測試
const ALLOW = [/\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOW.some(re => re.test(o))) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.type('text').send('nthu-lib push backend OK'));
app.get('/health', (_req, res) => {
  const offs = Object.values(devices).map(d => d.official).filter(Boolean);
  res.json({ ok: true, devices: Object.keys(devices).length,
    official: { active: offs.filter(o => !o.expired).length, expired: offs.filter(o => o.expired).length } });
});
app.get('/vapid', (_req, res) => res.json({ key: PUBLIC }));

// 新進來的提醒：沿用舊的 sent 狀態；第一次看到、而且時間早就過了的，直接當作已發（避免重啟後補發一堆舊通知）
function mergeReminders(prevList, incoming) {
  const prevSent = new Map((prevList || []).map(r => [r.id, r.sent]));
  const now = Date.now();
  return incoming.map(r => ({
    ...r,
    sent: prevSent.has(r.id) ? prevSent.get(r.id) : Date.parse(r.fireAt) < now - 60000,
  }));
}

// 前端把這台裝置的訂閱 + 所有提醒（已算好觸發時間）整包送來，覆蓋舊的
app.post('/sync', (req, res) => {
  const { subscription, reminders, official } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'no subscription' });
  const prev = devices[subscription.endpoint];
  const clean = (Array.isArray(reminders) ? reminders : [])
    .filter(r => r && r.id && r.fireAt && !isNaN(Date.parse(r.fireAt)))
    .slice(0, 200)
    .map(r => ({
      id: String(r.id), fireAt: new Date(r.fireAt).toISOString(),
      title: String(r.title || '圖書館提醒').slice(0, 80),
      body: String(r.body || '').slice(0, 200),
    }));
  // 官方預約的登入代碼：前端有送就更新，沒送就沿用舊的
  let off = prev?.official || null;
  if (official && typeof official.sid === 'string' && typeof official.authid === 'string') {
    const same = off && off.sid === official.sid && off.authid === official.authid;
    off = {
      sid: official.sid.slice(0, 200), authid: official.authid.slice(0, 200),
      before: clampMin(official.before), after: clampMin(official.after),
      expired: same ? off.expired : false, lastPoll: same ? off.lastPoll : 0,
      since: same ? off.since : Date.now(),
    };
  }
  devices[subscription.endpoint] = { subscription, reminders: mergeReminders(prev?.reminders, clean), official: off };
  save();
  res.json({ ok: true, count: clean.length, official: off ? (off.expired ? 'expired' : 'active') : 'none' });
});

// ---- 官方預約：用書籤帶來的 sid / authid 定期查「我的預約」，自動排提醒 ----
const OFFICIAL_API = 'https://libsms.lib.nthu.edu.tw/RWDAPI_New';
const POLL_MS = 5 * 60 * 1000;
const clampMin = v => Math.max(0, Math.min(720, parseInt(v, 10) || 0));
const hmTW = d => d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

// bookedatetime 例：「20261119 14:00:00~16:00:00」，伺服器在 UTC，所以明確當作台灣時間 (+08:00)
function parseOfficialTime(s) {
  const m = String(s || '').match(/(\d{4})\D?(\d{2})\D?(\d{2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*~\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const p = n => String(n).padStart(2, '0');
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const start = new Date(`${day}T${p(m[4])}:${m[5]}:00+08:00`);
  let end = new Date(`${day}T${p(m[6])}:${m[7]}:00+08:00`);
  if (isNaN(start) || isNaN(end)) return null;
  if (end <= start) end = new Date(end.getTime() + 864e5);
  return { start, end };
}

// 跟前端 remindersFromBookings 用一樣的 id（official:<bookid>-b / -a），兩邊同步才不會重複
function officialReminders(rows, before, after) {
  const out = [];
  for (const r of rows || []) {
    const t = parseOfficialTime(r.bookedatetime);
    if (!t || !r.bookid || t.end.getTime() < Date.now()) continue;
    const space = [r.zonename || r.spacetypename, r.devname].filter(Boolean).join(' ') || '圖書館預約';
    const id = `official:${r.bookid}`;
    if (before) out.push({ id: id + '-b', fireAt: new Date(t.start.getTime() - before * 60000).toISOString(),
      title: '圖書館預約即將開始', body: `${space}　${before} 分鐘後（${hmTW(t.start)}）開始` });
    if (after) out.push({ id: id + '-a', fireAt: new Date(t.start.getTime() + after * 60000).toISOString(),
      title: '記得刷卡啟用', body: `${space} 預約已開始 ${after} 分鐘，請於時段內刷卡啟用` });
  }
  return out;
}

async function pollOfficial(endpoint, dev) {
  const off = dev.official;
  off.lastPoll = Date.now();
  try {
    const q = new URLSearchParams({ sid: off.sid, authid: off.authid, restype: 'json' });
    const r = await fetch(`${OFFICIAL_API}/GetBookInfo.aspx?${q}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const res = (await r.json())[0] || {};
    if (res.rescode === '3' || res.rescode === '4') {
      off.expired = true;
      const mins = Math.round((Date.now() - off.since) / 60000);
      console.log(`official session expired after ${mins} min`);
      // 主動通知，不用靠自己記得：下次預約完再點一次書籤
      try {
        await webpush.sendNotification(dev.subscription, JSON.stringify({
          title: '自動抓預約已斷線',
          body: `官方登入在 ${mins >= 120 ? Math.round(mins / 60) + ' 小時' : mins + ' 分鐘'}後過期。下次登入預約系統時，點一下「抓預約」書籤就會恢復。`,
        }));
      } catch (e) { console.error('expiry notice failed', e.statusCode || e.message); }
      return;
    }
    if (res.rescode !== '1') return;
    // 換掉舊的官方提醒（被取消的預約會自然消失），手動新增的保留
    const fresh = officialReminders(res.resdata, off.before, off.after);
    const manual = dev.reminders.filter(x => !x.id.startsWith('official:'));
    const prevOfficial = dev.reminders.filter(x => x.id.startsWith('official:'));
    dev.reminders = [...manual, ...mergeReminders(prevOfficial, fresh)];
  } catch (e) {
    console.error('official poll failed', e.message);   // 網路問題：保留原本的提醒，下次再試
  }
}

// 立即送一則測試推播
app.post('/test', async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'no subscription' });
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title: '測試推播', body: '收到這則就代表推播設定成功 🎉' }));
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.statusCode || e.message }); }
});

// 診斷用：直接對所有已訂閱裝置送一則測試推播，並把每台的結果回報
app.all('/testall', async (req, res) => {
  if (TICK_TOKEN && req.query.token !== TICK_TOKEN) return res.status(403).json({ error: 'bad token' });
  const results = [];
  for (const [endpoint, dev] of Object.entries(devices)) {
    try {
      await webpush.sendNotification(dev.subscription, JSON.stringify({ title: '診斷測試', body: '這則是後端直接送出的 ✅' }));
      results.push({ endpoint: endpoint.slice(0, 40) + '…', ok: true });
    } catch (e) {
      results.push({ endpoint: endpoint.slice(0, 40) + '…', ok: false, status: e.statusCode || null, error: String(e.body || e.message).slice(0, 200) });
      if (e.statusCode === 404 || e.statusCode === 410) delete devices[endpoint];
    }
  }
  res.json({ devices: results.length, results });
});

// 外部 cron 每分鐘打一次：發送到點的提醒
// 外部 cron 和內建 setInterval 可能同時呼叫 tick；同一時間只跑一個，避免同一則提醒被發兩次
let ticking = null;
function tick() {
  if (!ticking) ticking = runTick().finally(() => { ticking = null; });
  return ticking;
}
async function runTick() {
  let polled = false;
  for (const [endpoint, dev] of Object.entries(devices)) {
    const off = dev.official;
    if (off && !off.expired && Date.now() - (off.lastPoll || 0) >= POLL_MS) { await pollOfficial(endpoint, dev); polled = true; }
  }
  if (polled) save();
  const now = Date.now();
  let sent = 0;
  for (const [endpoint, dev] of Object.entries(devices)) {
    for (const r of dev.reminders) {
      if (r.sent) continue;
      const t = Date.parse(r.fireAt);
      if (t > now) continue;
      if (now - t > 2 * 3600 * 1000) { r.sent = true; continue; }  // 超過 2 小時沒發到就放棄，不補發
      try {
        await webpush.sendNotification(dev.subscription, JSON.stringify({ title: r.title, body: r.body }));
        r.sent = true; sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { delete devices[endpoint]; break; }  // 訂閱已失效
      }
    }
  }
  if (sent) save();
  return sent;
}

app.all('/tick', async (req, res) => {
  if (TICK_TOKEN && req.query.token !== TICK_TOKEN) return res.status(403).json({ error: 'bad token' });
  const sent = await tick();
  res.json({ ok: true, sent });
});

// 保險：伺服器自己也每 60 秒跑一次（沒睡著時有效；睡著時靠外部 cron 戳醒）
setInterval(() => tick().catch(() => {}), 60000);

app.listen(PORT, () => console.log(`push backend on :${PORT}`));
