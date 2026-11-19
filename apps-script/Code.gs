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
// 只有日期、沒有時間的預約（例如研究小間）用這個時段，想改可以直接改這兩行
const DAY_START = '08:00';
const DAY_END = '22:00';
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
      const b = parseBooking(msg.getPlainBody(), msg.getSubject());
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
function parseBooking(text, subject) {
  text = String(text || '');
  const field = re => ((text.match(re) || [])[1] || '').trim();
  // 空間種類：信裡有就用，沒有就從主旨「清大圖書館○○預約通知函」取
  const type = field(/空間種類\s*(?:TYPE)?\s*[：:]\s*(.+)/i) ||
    ((String(subject || '').match(/清大圖書館\s*(.+?)\s*預約通知函/) || [])[1] || '').trim();
  const name = field(/(?:空間名稱|座位名稱|座位編號|座位|房間名稱|房間|研究小間|名稱)\s*(?:NAME|Seat|Room)?\s*[：:]\s*(.+)/i);

  // 在全文找第一個「日期 時間 ~ (日期) 時間」，日期可用 / 或 -，中間可夾 (星期)
  const D = '(\\d{4})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{1,2})\\s*(?:[（(][^）)]*[）)])?\\s*';
  const T = '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?';
  const TO = '\\s*(?:~|～|-|–|－|至|到)\\s*';
  const m = text.match(new RegExp(D + T + TO + '(?:' + D + ')?' + T));
  if (!m) {
    // 研究小間這類「只有日期」的預約：2026/11/11~2026/11/12 → 起日 08:00 到迄日 22:00（閉館）
    const d = text.match(new RegExp(D + TO + '(?:' + D + ')?'));
    if (!d) return null;
    const p2 = n => String(n).padStart(2, '0');
    const at = (y, mo, dd, hm) => new Date(`${y}-${p2(mo)}-${p2(dd)}T${hm}:00+08:00`);
    const start = at(d[1], d[2], d[3], DAY_START);
    const end = d[4] ? at(d[4], d[5], d[6], DAY_END) : at(d[1], d[2], d[3], DAY_END);
    if (isNaN(start) || isNaN(end) || end <= start) return null;
    return { space: [type, name].filter(Boolean).join(' ') || '圖書館預約', start, end };
  }
  // m: 1-3 起日, 4-6 起時分秒, 7-9 迄日(可無), 10-12 迄時分秒

  const p = n => String(n).padStart(2, '0');
  const tw = (y, mo, d, h, mi) => new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+08:00`);   // 一律台灣時間
  const start = tw(m[1], m[2], m[3], m[4], m[5]);
  let end = m[7] ? tw(m[7], m[8], m[9], m[10], m[11]) : tw(m[1], m[2], m[3], m[10], m[11]);
  if (m[12] === '59') end = new Date(end.getTime() + 60000);   // 21:59:59 → 22:00
  if (end <= start) end = new Date(end.getTime() + 864e5);     // 跨夜
  if (isNaN(start) || isNaN(end)) return null;

  const space = [type, name].filter(Boolean).join(' ') || '圖書館預約';
  return { space, start, end };
}

/** 除錯用：把每一種看不懂的信各印一封原文出來（不會送出任何東西） */
function dumpUnparsed() {
  const seen = {};
  for (const thread of GmailApp.search(`from:${SENDER} subject:預約通知函`, 0, 50)) {
    for (const msg of thread.getMessages()) {
      const subj = msg.getSubject();
      if (seen[subj] || parseBooking(msg.getPlainBody(), subj)) continue;
      seen[subj] = true;
      Logger.log('===== ' + subj + ' =====\n' + msg.getPlainBody().slice(0, 1500));
    }
  }
  if (!Object.keys(seen).length) Logger.log('全部都看得懂 👍');
}

/** 測試用：只解析最近一封預約信、把結果印出來，不會送出任何東西 */
function testParse() {
  const threads = GmailApp.search(`from:${SENDER} subject:預約通知函`, 0, 1);
  if (!threads.length) { Logger.log('找不到圖書館的預約通知信。'); return; }
  const msg = threads[0].getMessages().pop();
  Logger.log(msg.getSubject());
  Logger.log(JSON.stringify(parseBooking(msg.getPlainBody(), msg.getSubject()), null, 2));
}
