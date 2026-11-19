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

1. 用瀏覽器（Chrome 或三星瀏覽器）開 `https://pch1102.github.io/nthulibreserve/`，選單 →「加到主畫面」。
2. 打開 app → 右上角 🔔 → 輸入通行碼（TICK_TOKEN）→ **開啟推播**，允許通知。
3. 按 **發送測試**，幾秒內手機應該跳出一則通知。
4. 照 `../apps-script/README.md` 裝好 Apps Script。之後預約完什麼都不用做，收到預約信就會自動排好通知。

## 說明

- 預約來源是 Google Apps Script 讀圖書館的預約通知信（見 `../apps-script/README.md`），送到 `/mail-bookings`。
- app 的🔔通知總覽可以查看、編輯（日期、時間、開始前／開始後幾分鐘）、刪除每筆通知，以及設定自動加入時的預設值。
- webapp 與 Apps Script 都要帶通行碼才能讀寫，通行碼就是 `TICK_TOKEN`（想分開可另設 `APP_TOKEN`，但 cron 網址也要改用它）。
- Render 重新部署清掉資料時：Apps Script 下一輪會補回預約，app 開啟時會補回你的編輯和推播訂閱。
