// OddsPapi egress proxy — chạy trên IP của Google.
// Lý do: OddsPapi đứng sau Cloudflare + bật bot-protection, nên chặn request đến từ IP/Worker
// của Cloudflare (trả 403). GAS UrlFetchApp gọi từ IP Google -> OddsPapi cho qua bình thường
// (giống hồi backend còn chạy trên Apps Script). Worker gọi proxy này thay vì gọi OddsPapi trực tiếp.
//
// Bảo mật: chỉ ghép API_BASE + path (path phải bắt đầu bằng "/"), KHÔNG fetch URL tuỳ ý -> không SSRF.
// apiKey do Worker truyền trong path (nằm ở phía bạn, không lộ ra ngoài). Nên đặt TOKEN để tránh
// người lạ dùng proxy làm relay ẩn danh tới OddsPapi.
//
// TRIỂN KHAI:
//   1. script.google.com -> New project -> dán file này.
//   2. Đổi TOKEN thành 1 chuỗi bí mật của bạn (hoặc để '' nếu không cần).
//   3. Deploy -> New deployment -> loại "Web app":
//        - Execute as: Me
//        - Who has access: Anyone
//      Copy URL dạng .../exec.
//   4. Set vào Worker:
//        wrangler secret put ODDSPAPI_PROXY         # dán URL /exec
//        wrangler secret put ODDSPAPI_PROXY_TOKEN   # dán đúng TOKEN ở dưới (nếu có đặt)
//      rồi: wrangler deploy

var API_BASE = 'https://api.oddspapi.io/v4';
var TOKEN = 'CHANGE_ME';   // đặt trùng với secret ODDSPAPI_PROXY_TOKEN; để '' để tắt kiểm tra

// Cổng cho TRÌNH DUYỆT: browser -> GAS (domain script.google.com được bộ lọc công ty cho qua)
// -> Worker. Dùng khi mạng công ty chặn *.workers.dev. Frontend đặt WORKER_URL = URL /exec này.
// Chỉ forward tới đúng WORKER_URL cố định -> không SSRF. Auth vẫn do Worker kiểm (token trong body).
var WORKER_URL = 'https://the-prophet.lishace.workers.dev';

function doPost(e){
  var body = (e && e.postData && e.postData.contents) || '{}';
  var resp = UrlFetchApp.fetch(WORKER_URL, {
    method: 'post', contentType: 'application/json',
    payload: body, muteHttpExceptions: true
  });
  // Trả NGUYÊN body của Worker ({ok,data}|{ok,error}) -> srun đọc j.ok, không cần HTTP status.
  return ContentService.createTextOutput(resp.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e){
  var p = (e && e.parameter) || {};
  if (TOKEN && p.t !== TOKEN) return json_({ status: 403, body: '{"error":"proxy: bad token"}' });
  var path = p.path || '';
  if (path.charAt(0) !== '/') return json_({ status: 400, body: '{"error":"proxy: bad path"}' });
  var resp = UrlFetchApp.fetch(API_BASE + path, { muteHttpExceptions: true });
  return json_({ status: resp.getResponseCode(), body: resp.getContentText() });
}

function json_(o){
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
