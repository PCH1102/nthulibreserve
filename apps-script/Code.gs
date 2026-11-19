/**
 * 清大圖書館預約通知信 → 自動送到你的推播後端（webapp 的通知總覽）
 *
 * 每 5 分鐘檢查 Gmail 裡圖書館寄來的「預約通知函」，
 * 把還沒結束的預約送到 Render 後端。後端會用你在 webapp 設定的預設值
 * （開始前 / 開始後幾分鐘）排好推播；之後可以在 webapp 裡編輯或刪除。
 *
 * 重複送同一封信沒關係：後端已經有的預約不會被覆蓋，你的編輯和刪除都會保留。
 * 安裝方式：見同資料夾 README.md。
 */

const PUSH_API = 'https://nthu-lib-push.onrender.com';
const SENDER = 'cir@my.nthu.edu.tw';
// 通行碼放在「專案設定 → 指令碼屬性」的 TOKEN，不要寫在程式碼裡
const TOKEN = PropertiesService.getScriptProperties().getProperty('TOKEN') || '';

/** 第一次執行這個：建立每 5 分鐘自動檢查的排程，並立刻跑一次 */
function setup() {
  if (!TOKEN) throw new Error('請先在「專案設定 → 指令碼屬性」新增 TOKEN（值就是 Render 的 TICK_TOKEN）。');
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkBookingMail')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkBookingMail').timeBased().everyMinutes(5).create();
  checkBookingMail();
  Logger.log('設定完成：之後每 5 分鐘會自動檢查一次。');
}

/** 主程式：找出近 30 天的預約通知信，把還沒結束的預約送到後端 */
function checkBookingMail() {
  const threads = GmailApp.search(`from:${SENDER} subject:預約通知函 newer_than:30d`, 0, 50);
  const bookings = [];
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const b = parseBooking(msg.getPlainBody());
      if (!b) { Logger.log('看不懂這封信的格式：' + msg.getSubject()); continue; }
      if (b.end.getTime() < Date.now()) continue;   // 已經結束的就不用了
      bookings.push({ id: 'mail:' + msg.getId(), space: b.space, start: b.start.toISOString(), end: b.end.toISOString() });
    }
  }
  if (!bookings.length) return;

  const res = UrlFetchApp.fetch(PUSH_API + '/mail-bookings', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Token': TOKEN },
    payload: JSON.stringify({ bookings }),
  });
  Logger.log(`送出 ${bookings.length} 筆，後端回應 ${res.getResponseCode()}：${res.getContentText()}`);
  if (res.getResponseCode() === 401) throw new Error('通行碼（TOKEN）不正確');
}

/**
 * 解析信件內文，例如：
 *   空間種類TYPE：享時小間
 *   空間名稱NAME：605
 *   預約日期DATE：2026/11/17 20:00:00~21:59:59
 */
function parseBooking(text) {
  const type = (text.match(/空間種類\s*TYPE\s*[：:]\s*(.+)/) || [])[1];
  const name = (text.match(/空間名稱\s*NAME\s*[：:]\s*(.+)/) || [])[1];
  const m = text.match(
    /預約日期\s*DATE\s*[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*~\s*(?:(\d{4})\/(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) return null;

  const p = n => String(n).padStart(2, '0');
  const tw = (y, mo, d, h, mi) => new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+08:00`);   // 一律台灣時間
  const start = tw(m[1], m[2], m[3], m[4], m[5]);
  let end = m[6] ? tw(m[6], m[7], m[8], m[9], m[10]) : tw(m[1], m[2], m[3], m[9], m[10]);
  if (m[11] === '59') end = new Date(end.getTime() + 60000);   // 21:59:59 → 22:00
  if (end <= start) end = new Date(end.getTime() + 864e5);     // 跨夜

  const space = [type, name].filter(Boolean).map(s => s.trim()).join(' ');
  return { space, start, end };
}

/** 測試用：只解析最近一封預約信、把結果印出來，不會送出任何東西 */
function testParse() {
  const threads = GmailApp.search(`from:${SENDER} subject:預約通知函`, 0, 1);
  if (!threads.length) { Logger.log('找不到圖書館的預約通知信。'); return; }
  const msg = threads[0].getMessages().pop();
  Logger.log(msg.getSubject());
  Logger.log(JSON.stringify(parseBooking(msg.getPlainBody()), null, 2));
}
