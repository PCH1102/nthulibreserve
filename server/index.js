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
app.get('/health', (_req, res) => res.json({ ok: true, devices: Object.keys(devices).length }));
app.get('/vapid', (_req, res) => res.json({ key: PUBLIC }));

// 前端把這台裝置的訂閱 + 所有提醒（已算好觸發時間）整包送來，覆蓋舊的
app.post('/sync', (req, res) => {
  const { subscription, reminders } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'no subscription' });
  const prev = devices[subscription.endpoint];
  const prevSent = new Map((prev?.reminders || []).map(r => [r.id, r.sent]));
  const clean = (Array.isArray(reminders) ? reminders : [])
    .filter(r => r && r.id && r.fireAt && !isNaN(Date.parse(r.fireAt)))
    .slice(0, 200)
    .map(r => ({
      id: String(r.id), fireAt: new Date(r.fireAt).toISOString(),
      title: String(r.title || '圖書館提醒').slice(0, 80),
      body: String(r.body || '').slice(0, 200),
      sent: prevSent.get(String(r.id)) || false,   // 已發過的不要重發
    }));
  devices[subscription.endpoint] = { subscription, reminders: clean };
  save();
  res.json({ ok: true, count: clean.length });
});

// 立即送一則測試推播
app.post('/test', async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'no subscription' });
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title: '測試推播', body: '收到這則就代表推播設定成功 🎉' }));
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.statusCode || e.message }); }
});

// 外部 cron 每分鐘打一次：發送到點的提醒
async function tick() {
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
