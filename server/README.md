# 圖書館提醒 — 推播後端

這個小後端只做一件事：在你設定的提醒時間，發一則 Web Push 通知到你的手機。
它**只儲存推播訂閱和提醒時間**，不碰任何學校帳號、密碼或圖書館預約系統。

## 一、產生 VAPID 金鑰

```bash
cd server
npm install
npm run genkeys
```

會印出 `publicKey` 和 `privateKey` 各一組。公鑰和私鑰等一下填進 Render 的環境變數，
**私鑰不要放進前端或公開出去**。

## 二、部署到 Render

1. 到 <https://render.com> 登入，**New → Web Service**，連到你的 `nthulibreserve` repo。
2. 設定：
   - **Root Directory**：`server`
   - **Build Command**：`npm install`
   - **Start Command**：`node index.js`
   - **Instance Type**：Free
3. **Environment** 加入這幾個變數：
   | Key | Value |
   |---|---|
   | `VAPID_PUBLIC` | 剛才的 publicKey |
   | `VAPID_PRIVATE` | 剛才的 privateKey |
   | `VAPID_SUBJECT` | `mailto:你的信箱` |
   | `TICK_TOKEN` | 自己取一組密碼，例如 `nthu-abc123`（用來保護 /tick）|
4. Create，等它跑完。拿到網址，例如 `https://nthu-lib-push.onrender.com`。

## 三、把網址填回前端

1. 編輯專案根目錄的 `index.html`，找到 `const PUSH_API = '';`，改成你的 Render 網址（結尾不要加斜線）：
   ```js
   const PUSH_API = 'https://nthu-lib-push.onrender.com';
   ```
2. commit + push，GitHub Pages 幾分鐘後更新。

## 四、設一個每分鐘的喚醒 cron（免費）

Render 免費方案沒人用時會休眠，所以用一個免費外部排程每分鐘戳一次，順便把到點的提醒送出。

1. 到 <https://cron-job.org> 註冊，建立一個 Cronjob。
2. URL 填：`https://你的網址/tick?token=你設定的TICK_TOKEN`
3. 間隔設 **每 1 分鐘**。存檔。

## 五、手機上啟用（Android）

1. 用 **Chrome** 開 `https://pch1102.github.io/nthulibreserve/`，選單 →「加到主畫面」。
2. 打開 app → 預約提醒 → **開啟推播**，允許通知。
3. 按 **發送測試**，幾秒內手機應該跳出一則通知。
4. 之後每次預約完，在「預約提醒」填入時間按「新增提醒」即可。

## 說明

- 提醒清單同時存在你手機裡；app 每次開啟會把清單重新同步到後端，所以就算 Render 重新部署清掉資料，下次開 app 就會補回。
- 後端本身不知道你有沒有預約、預約了什麼空間在哪個時段——那些是你在 app 裡自己填的。
