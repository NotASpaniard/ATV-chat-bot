// Nạp biến từ file .env vào process.env (không cần thư viện ngoài).
// Require file này TRƯỚC mọi module đọc process.env (vd ./db).
// Quy tắc: mỗi dòng KEY=VALUE; bỏ qua dòng trống và dòng bắt đầu bằng #.
// Biến đã có sẵn trong môi trường (vd set khi chạy) sẽ KHÔNG bị .env ghi đè.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '.env');
try {
  const text = fs.readFileSync(file, 'utf8');
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // bỏ dấu nháy bao ngoài nếu có
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[env] Không đọc được .env:', e.message);
  // Không có .env thì dùng mặc định trong code — bình thường.
}
