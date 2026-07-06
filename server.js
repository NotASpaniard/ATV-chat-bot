// AVT Chat Bot - server (Bước 2: + database + nhập liệu + RAG)
// Gọi model local qua Ollama (streaming). Lưu chat/tài liệu/bản ghi vào Postgres nội bộ.
require('./env'); // nạp .env vào process.env TRƯỚC khi các module dưới đọc cấu hình
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const ExcelJS = require('exceljs');
const { fileKind, parseSpreadsheet, rowsToRecords, extractText } = require('./parse');

const PORT = process.env.PORT || 3007;
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024; // giới hạn file tải lên

// ---- công việc nền (index tài liệu/bản ghi) + theo dõi tiến độ ----
const jobs = new Map();
function startJob(runFn) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { status: 'running', done: 0, total: 0, error: null, result: null };
  jobs.set(id, job);
  Promise.resolve()
    .then(() => runFn((done, total) => { job.done = done; job.total = total; }))
    .then((result) => { job.status = 'done'; job.result = result; })
    .catch((e) => { job.status = 'error'; job.error = e.message; });
  const t = setTimeout(() => jobs.delete(id), 15 * 60 * 1000); // dọn sau 15 phút
  if (t.unref) t.unref();
  return id;
}
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'qwen2.5:3b';

const SYSTEM_PROMPT =
  'Bạn là AVT Chat Bot — trợ lý AI nội bộ của doanh nghiệp, chạy hoàn toàn trên máy chủ nội bộ. ' +
  'Trả lời bằng tiếng Việt, rõ ràng, chính xác và lịch sự. ' +
  'Nếu không chắc chắn hoặc thiếu dữ liệu, hãy nói rõ thay vì bịa.';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// ---- tiện ích ----
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 80 * 1024 * 1024) reject(new Error('Dữ liệu quá lớn (>80MB)'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

// Ghi luồng request thẳng ra file tạm trên đĩa (không giữ toàn bộ trong RAM), có chặn quá cỡ.
function streamToTemp(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'avt-up-' + crypto.randomBytes(8).toString('hex'));
    const ws = fs.createWriteStream(tmp);
    let size = 0, done = false;
    const fail = (e) => { if (done) return; done = true; ws.destroy(); fs.unlink(tmp, () => {}); reject(e); };
    ws.on('error', fail);
    req.on('error', fail);
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        fail(new Error('File vượt giới hạn ' + Math.round(maxBytes / 1048576) + 'MB'));
        try { req.destroy(); } catch {}
        return;
      }
      if (!ws.write(c)) { req.pause(); ws.once('drain', () => req.resume()); }
    });
    req.on('end', () => { if (done) return; done = true; ws.end(() => resolve({ path: tmp, size })); });
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Cache model đang dùng trong RAM (chỉ tiến trình này thay đổi qua /api/models/active
// nên luôn khớp) — tránh truy vấn DB lặp lại ở mỗi request config/status/chat/...
let modelCache = null;
async function activeModel() {
  if (modelCache == null) modelCache = await db.getSetting('model', MODEL);
  return modelCache;
}

// Model ĐÁM MÂY (dữ liệu rời máy) -> bị cấm đọc dữ liệu nhạy cảm.
function isCloudModel(name) { return /^(gemini|gpt-|o[0-9]|claude)/i.test(String(name || '')); }

// ---- Gemini (đám mây, tùy chọn qua GEMINI_API_KEY trong .env) ----
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; // free tier còn quota

function toGeminiContents(chatMessages) {
  return chatMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

// Stream Gemini về client dạng text/plain (giống streamOllama). Trả về toàn bộ text.
async function streamGemini(res, model, systemContent, chatMessages, prefix = '') {
  const upstream = await fetch(`${GEMINI_URL}/${model}:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemContent }] },
      contents: toGeminiContents(chatMessages),
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không gọi được Gemini (' + upstream.status + '). ' +
      (upstream.status === 429 ? 'Hết hạn mức miễn phí — thử lại sau hoặc đổi về model local.' : detail.slice(0, 300)));
    return null;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  let buf = '', full = '';
  if (prefix) { res.write(prefix); full += prefix; }
  const flush = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    try {
      const o = JSON.parse(line.slice(5));
      const t = o.candidates && o.candidates[0] && o.candidates[0].content &&
        o.candidates[0].content.parts && o.candidates[0].content.parts.map((p) => p.text || '').join('');
      if (t) { res.write(t); full += t; }
    } catch {}
  };
  for await (const chunk of upstream.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) { flush(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
  }
  flush(buf);
  res.end();
  return full;
}

// Gọi Gemini trả JSON (cho tư vấn tối ưu).
async function geminiJson(model, system, user) {
  const r = await fetch(`${GEMINI_URL}/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!r.ok) throw new Error('Gemini ' + r.status);
  const j = await r.json();
  const c = j.candidates && j.candidates[0];
  return (c && c.content && c.content.parts && c.content.parts.map((p) => p.text || '').join('')) || '';
}

// Gọi Ollama chat (stream) tới client. Trả về toàn bộ text đã sinh.
async function streamOllama(res, model, systemContent, chatMessages, prefix = '') {
  const payload = {
    model: model || MODEL,
    messages: [{ role: 'system', content: systemContent }, ...chatMessages],
    stream: true,
    keep_alive: '30m',
  };
  const upstream = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!upstream.ok) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không gọi được Ollama: ' + upstream.status);
    return null;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  let buf = '', full = '';
  if (prefix) { res.write(prefix); full += prefix; }
  const flush = (line) => {
    if (!line.trim()) return;
    try { const o = JSON.parse(line); if (o.message && o.message.content) { res.write(o.message.content); full += o.message.content; } } catch {}
  };
  for await (const chunk of upstream.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) { flush(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
  }
  flush(buf);
  res.end();
  return full;
}

// ---- Tiện ích cho tư vấn tối ưu (server tự tính tiền, không tin phép tính của model) ----
const COMBINING_MARKS = new RegExp('[\u0300-\u036f]', 'g');
function noAccent(s) { return String(s || '').normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase(); }
function parseNum(v) {
  if (v == null) return NaN;
  const d = String(v).replace(/[^\d]/g, '');
  return d ? Number(d) : NaN;
}
// Đơn giá: ưu tiên trường tên có 'gia'/'price'; nếu không, lấy số lớn nhất trông giống tiền.
function pickPrice(data) {
  for (const [key, val] of Object.entries(data || {})) {
    const k = noAccent(key);
    if (k.includes('gia') || k.includes('price')) {
      const n = parseNum(val);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  let best = NaN;
  for (const val of Object.values(data || {})) {
    const n = parseNum(val);
    if (!isNaN(n) && n >= 1000 && (isNaN(best) || n > best)) best = n;
  }
  return best;
}
// Tên thiết bị: ưu tiên trường 'ten'/'name'/'thiet bi'/'san pham'; fallback ghép collection + giá trị đầu.
function pickName(data, collection) {
  for (const [key, val] of Object.entries(data || {})) {
    const k = noAccent(key);
    if ((k.includes('ten') || k.includes('name') || k.includes('thiet bi') || k.includes('san pham')) && val)
      return String(val).trim();
  }
  const vals = Object.values(data || {});
  return ((collection ? collection + ' - ' : '') + (vals[0] != null ? String(vals[0]) : 'Thiết bị')).trim();
}
function fmtVnd(n) { return Number(n).toLocaleString('vi-VN'); }

// Gọi Ollama ở chế độ trả JSON (không stream) để lấy lựa chọn của model.
async function ollamaJson(model, system, user) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.2 },
    }),
  });
  if (!r.ok) throw new Error('Ollama ' + r.status);
  const j = await r.json();
  return (j.message && j.message.content) || '';
}

// ---- chat có RAG + bộ luật + lưu DB ----
async function handleChat(req, res) {
  const { messages, sessionId, memory } = await readJson(req);
  if (!Array.isArray(messages) || !messages.length) {
    return sendJson(res, 400, { error: 'Thiếu messages' });
  }
  const sid = sessionId || 'default';
  const useMemory = !!memory;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  try {
    await db.ensureSession(sid, lastUser ? lastUser.content.slice(0, 60) : null);
    if (lastUser) await db.saveMessage(sid, 'user', lastUser.content);
  } catch (e) { console.error('Lưu câu hỏi lỗi:', e.message); }

  const model = await activeModel();
  const allowSensitive = !isCloudModel(model); // model đám mây không được đọc dữ liệu nhạy cảm
  let ragContext = '';
  let warnPrefix = '';
  if (lastUser) {
    try {
      // Lấy nhiều ứng viên rồi chỉ giữ các đoạn liên quan nhất (giúp tài liệu lớn bớt nhiễu)
      const hits = await db.retrieve(lastUser.content, 12, useMemory, allowSensitive);
      const good = hits.filter((h) => h.score > 0.35).slice(0, 6);
      if (good.length) {
        ragContext =
          '\n\n===== TRÍCH ĐOẠN LIÊN QUAN TỪ TÀI LIỆU NỘI BỘ =====\n' +
          good.map((h, i) => `[${i + 1}] ${h.content}`).join('\n---\n') +
          '\n===== HẾT TRÍCH ĐOẠN =====\n' +
          'QUY TẮC TRẢ LỜI: Chỉ dựa vào các trích đoạn trên. Trả lời ĐÚNG TRỌNG TÂM câu hỏi, ' +
          'ngắn gọn, không lan man, không thêm thông tin ngoài trích đoạn. ' +
          'Nếu các trích đoạn KHÔNG chứa câu trả lời, hãy nói rõ: "Tôi không tìm thấy thông tin này trong tài liệu."';
      } else if (!(await db.embedOk())) {
        // Không tra được vì embedding lỗi -> cảnh báo rõ, tránh bịa trong im lặng
        warnPrefix = '> ⚠ Hệ thống tra cứu dữ liệu nội bộ (bge-m3) đang lỗi — câu trả lời dưới đây KHÔNG dựa trên tài liệu/bảng giá của bạn. Kiểm tra Ollama đã tải bge-m3 chưa (ollama pull bge-m3).\n\n';
      }
    } catch (e) { console.error('RAG lỗi:', e.message); }
  }

  const rules = await db.getRules().catch(() => '');
  const system = SYSTEM_PROMPT + '\n\nBỘ LUẬT (phải tuân thủ):\n' + rules + ragContext;

  let full;
  if (isCloudModel(model)) {
    if (!GEMINI_KEY) { return sendText(res, 'Chưa cấu hình GEMINI_API_KEY trong .env — hãy đổi về model local.'); }
    full = await streamGemini(res, model, system, messages, warnPrefix);
  } else {
    full = await streamOllama(res, model, system, messages, warnPrefix);
  }
  if (full && full.trim()) {
    try { await db.saveMessage(sid, 'assistant', full); } catch (e) { console.error('Lưu trả lời lỗi:', e.message); }
    if (useMemory && lastUser) db.saveMemory(sid, `Hỏi: ${lastUser.content}\nĐáp: ${full}`).catch(() => {});
  }
}

// ---- Tư vấn tối ưu: model CHỌN thiết bị (JSON), SERVER tự tính tiền cho chính xác ----
function sendText(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(text);
}

async function handleAdvise(req, res) {
  const { requirement, sessionId } = await readJson(req);
  if (!requirement || !requirement.trim()) return sendJson(res, 400, { error: 'Thiếu yêu cầu' });
  const sid = sessionId || 'default';

  try {
    await db.ensureSession(sid, ('Tư vấn: ' + requirement).slice(0, 60));
    await db.saveMessage(sid, 'user', '[Tư vấn tối ưu] ' + requirement);
  } catch {}

  const adviseModel = await activeModel();
  const allowSensitive = !isCloudModel(adviseModel); // model đám mây không được đọc bảng giá nhạy cảm
  let rows = [];
  try { rows = await db.retrieveDevices(requirement, 25, allowSensitive); } catch (e) { console.error('retrieveDevices lỗi:', e.message); }

  // Không có dữ liệu: phân biệt "chưa nhập bảng giá" vs "embedding lỗi"
  if (!rows.length) {
    const ok = await db.embedOk();
    return sendText(res, ok
      ? 'Chưa tìm thấy thiết bị phù hợp trong bảng giá nội bộ. Hãy vào Quản trị dữ liệu để nhập bảng giá trước khi dùng tư vấn.'
      : '⚠ Hệ thống tra cứu (embedding bge-m3) đang lỗi nên không đọc được bảng giá. Kiểm tra Ollama đã tải bge-m3 chưa (ollama pull bge-m3), rồi thử lại.');
  }

  // Lập danh mục có đơn giá thật (bỏ dòng không đọc được giá)
  const catalog = [];
  for (const r of rows) {
    const price = pickPrice(r.data);
    if (isNaN(price)) continue;
    catalog.push({ name: pickName(r.data, r.collection), price, note: r.content });
  }
  if (!catalog.length) {
    return sendText(res, 'Tìm thấy thiết bị liên quan nhưng không đọc được ĐƠN GIÁ (thiếu cột giá). Hãy kiểm tra lại bảng giá đã nhập.');
  }

  // Model chỉ CHỌN (index + số lượng), không tính tiền
  const catText = catalog.map((c, i) => `${i + 1}. ${c.name} — đơn giá ${fmtVnd(c.price)} đ — ${c.note}`).join('\n');
  const selSystem =
    'Bạn là chuyên gia tư vấn thiết bị. Dưới đây là DANH MỤC (mỗi dòng có số thứ tự, tên, đơn giá):\n' + catText +
    '\n\nChọn PHƯƠNG ÁN TỐI ƯU đáp ứng yêu cầu của khách. CHỈ được chọn thiết bị trong danh mục theo SỐ THỨ TỰ.' +
    ' Đọc KỸ yêu cầu: nếu khách mô tả một HỆ THỐNG gồm nhiều phần (ví dụ camera + đầu ghi + ổ cứng), phải chọn ĐỦ tất cả các phần đó nếu danh mục có; chọn đúng SỐ LƯỢNG khách nêu.' +
    ' KHÔNG tự tính tiền. Trả về DUY NHẤT một JSON đúng định dạng:' +
    ' {"items":[{"index":<số thứ tự>,"qty":<số lượng nguyên>}],"reason":"lý do ngắn gọn tiếng Việt","missing":"thứ khách cần nhưng danh mục không có (nếu có)"}';

  let sel = null;
  for (let attempt = 0; attempt < 2 && !sel; attempt++) {
    try {
      const raw = isCloudModel(adviseModel)
        ? await geminiJson(adviseModel, selSystem, 'Yêu cầu của khách: ' + requirement)
        : await ollamaJson(adviseModel, selSystem, 'Yêu cầu của khách: ' + requirement);
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) sel = parsed;
    } catch (e) { console.error('Chọn phương án lỗi (lần ' + (attempt + 1) + '):', e.message); }
  }

  // Model không trả JSON hợp lệ -> vẫn giúp ích: liệt kê thiết bị liên quan kèm giá đúng
  if (!sel) {
    const list = catalog.map((c) => `- ${c.name}: ${fmtVnd(c.price)} đ`).join('\n');
    const msg = 'Chưa tự chọn được phương án. Các thiết bị liên quan trong bảng giá:\n' + list +
      '\n\nVui lòng nêu rõ số lượng từng loại để được báo giá chi tiết.';
    try { await db.saveMessage(sid, 'assistant', msg); } catch {}
    return sendText(res, msg);
  }

  // SERVER tính tiền (gộp trùng theo index, chặn số lượng vô lý)
  const merged = new Map();
  for (const it of sel.items) {
    const idx = Number(it.index) - 1;
    let qty = Math.floor(Number(it.qty));
    if (!(idx >= 0 && idx < catalog.length)) continue;
    if (!(qty >= 1)) qty = 1;
    if (qty > 100000) qty = 100000;
    merged.set(idx, (merged.get(idx) || 0) + qty);
  }

  if (!merged.size) {
    const msg = 'Không xác định được thiết bị phù hợp trong bảng giá cho yêu cầu này.' +
      (sel.missing ? ' Thiếu: ' + sel.missing : '');
    try { await db.saveMessage(sid, 'assistant', msg); } catch {}
    return sendText(res, msg);
  }

  let total = 0;
  const lines = [];
  for (const [idx, qty] of merged) {
    const c = catalog[idx];
    const lineTotal = c.price * qty;
    total += lineTotal;
    lines.push(`| ${c.name} | ${qty} | ${fmtVnd(c.price)} đ | ${fmtVnd(lineTotal)} đ |`);
  }

  let out = '## Phương án tối ưu\n\n' +
    '| Thiết bị | Số lượng | Đơn giá | Thành tiền |\n|---|---:|---:|---:|\n' +
    lines.join('\n') +
    `\n| **Tổng cộng** | | | **${fmtVnd(total)} đ** |\n`;
  if (sel.reason) out += `\n**Lý do chọn:** ${sel.reason}\n`;
  if (sel.missing) out += `\n**Chưa có trong bảng giá:** ${sel.missing}\n`;
  out += '\n*Số liệu do hệ thống tự tính từ bảng giá nội bộ; vui lòng rà soát trước khi gửi khách.*';

  try { await db.saveMessage(sid, 'assistant', out); } catch {}
  sendText(res, out);
}

// ---- Xuất câu trả lời ra Excel (tách bảng markdown thành các cột) ----
async function handleExportXlsx(req, res) {
  const { content, title } = await readJson(req);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('KetQua');
  const lines = (content || '').split('\n');
  const tableRows = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue; // bỏ dòng gạch ngăn
      tableRows.push(cells);
    }
  }
  if (tableRows.length) {
    tableRows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    const nc = Math.max(...tableRows.map((r) => r.length));
    for (let i = 1; i <= nc; i++) ws.getColumn(i).width = 24;
  } else {
    lines.forEach((l) => ws.addRow([l]));
    ws.getColumn(1).width = 90;
  }
  const buf = await wb.xlsx.writeBuffer();
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': "attachment; filename=\"" + encodeURIComponent(title || 'ket-qua') + ".xlsx\"",
  });
  res.end(Buffer.from(buf));
}

// Dò tên GPU 1 lần rồi cache (phần cứng không đổi) — tránh spawn PowerShell mỗi lần refresh.
let gpuCache = null;
function detectGpu() {
  return new Promise((resolve) => {
    if (gpuCache) return resolve(gpuCache);
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe',
        ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join ";"'],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          gpuCache = err ? [] : String(stdout).trim().split(';').map((s) => s.trim()).filter(Boolean);
          resolve(gpuCache);
        });
    } catch { gpuCache = []; resolve(gpuCache); }
  });
}

// ---- Trạng thái hệ thống (RAM, ổ đĩa, model đang nạp) ----
async function handleStatus(res) {
  const total = os.totalmem(), free = os.freemem();
  let disk = null;
  try {
    const s = await fs.promises.statfs(path.parse(__dirname).root);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {}
  let loaded = [];
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    loaded = (d.models || []).map((m) => ({
      name: m.name, size: m.size, size_vram: m.size_vram || 0,
      processor: (m.size_vram > 0) ? (m.size > m.size_vram ? 'GPU+CPU' : 'GPU') : 'CPU',
    }));
  } catch {}
  // ---- Tương thích CPU / GPU ----
  const cpus = os.cpus() || [];
  const cpuModel = (cpus[0] && cpus[0].model || 'Không rõ').replace(/\s+/g, ' ').trim();
  const threads = cpus.length;
  const totalGB = total / 1073741824;
  const gpuNames = await detectGpu();
  const hasNvidia = gpuNames.some((n) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(n));
  const gpuInUse = loaded.some((m) => m.processor && m.processor !== 'CPU');

  const cpuLevel = threads >= 12 ? 'good' : threads >= 8 ? 'ok' : 'warn';
  let gpuLevel, gpuNote;
  if (hasNvidia) {
    gpuLevel = 'good';
    gpuNote = gpuInUse ? 'GPU NVIDIA — đang tăng tốc AI' : 'Có GPU NVIDIA — AI chạy nhanh (nếu Ollama nhận CUDA)';
  } else {
    gpuLevel = 'warn';
    gpuNote = 'Không có GPU NVIDIA — AI chạy bằng CPU (chậm). Gắn card NVIDIA để nhanh hơn nhiều.';
  }
  let ramLevel = totalGB >= 30 ? 'good' : totalGB >= 15 ? 'ok' : 'warn';
  const cpuNote = threads >= 12 ? 'Đủ mạnh cho model 7B (chạy CPU vẫn chậm nếu không GPU).'
    : threads >= 8 ? 'Ổn cho model nhỏ (3B).' : 'Yếu — nên dùng model nhỏ (1.5B–3B).';

  return sendJson(res, 200, {
    model: await activeModel(),
    ram: { total, free, used: total - free, usedPct: Math.round((total - free) / total * 100) },
    disk: disk ? { ...disk, freePct: Math.round(disk.free / disk.total * 100) } : null,
    ollama: loaded,
    compat: {
      cpu: cpuModel, threads, cpuLevel, cpuNote,
      gpu: gpuNames.length ? gpuNames.join(', ') : 'Không phát hiện',
      hasNvidia, gpuInUse, gpuLevel, gpuNote,
      ramGB: Math.round(totalGB), ramLevel,
    },
  });
}

// ---- router ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // API
    if (req.method === 'POST' && p === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && p === '/api/advise') return await handleAdvise(req, res);
    if (req.method === 'POST' && p === '/api/export/xlsx') return await handleExportXlsx(req, res);

    if (req.method === 'GET' && p === '/api/config')
      return sendJson(res, 200, { model: await activeModel() });

    // ---- Quản lý model ----
    if (req.method === 'GET' && p === '/api/models') {
      let models = [];
      let ollamaErr = null;
      try {
        const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        models = (d.models || []).map((m) => ({ name: m.name, size: m.size }));
      } catch (e) { ollamaErr = 'Không gọi được Ollama'; }
      // Model đám mây (nếu đã cấu hình key) — luôn "có sẵn", không cần tải
      if (GEMINI_KEY) for (const g of GEMINI_MODELS) models.push({ name: g, size: 0, cloud: true });
      return sendJson(res, 200, { models, active: await activeModel(), ...(ollamaErr && !models.length ? { error: ollamaErr } : {}) });
    }
    if (req.method === 'POST' && p === '/api/models/active') {
      const { name } = await readJson(req);
      if (!name) return sendJson(res, 400, { error: 'Thiếu tên model' });
      if (isCloudModel(name) && !GEMINI_KEY) return sendJson(res, 400, { error: 'Chưa cấu hình GEMINI_API_KEY trong .env' });
      await db.setSetting('model', name);
      modelCache = name; // làm mới cache ngay
      return sendJson(res, 200, { ok: true, active: name });
    }
    if (req.method === 'POST' && p === '/api/models/delete') {
      const { name } = await readJson(req);
      if (!name) return sendJson(res, 400, { error: 'Thiếu tên model' });
      if (isCloudModel(name)) return sendJson(res, 400, { error: 'Model đám mây không cần xóa (tắt bằng cách bỏ GEMINI_API_KEY trong .env)' });
      const r = await fetch(`${OLLAMA}/api/delete`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      return sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: 'Xóa lỗi: ' + r.status });
    }
    if (req.method === 'POST' && p === '/api/models/pull') {
      const { name } = await readJson(req);
      if (!name) return sendJson(res, 400, { error: 'Thiếu tên model' });
      if (isCloudModel(name)) return sendJson(res, 400, { error: 'Model đám mây không cần tải' });
      const upstream = await fetch(`${OLLAMA}/api/pull`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, stream: true }),
      });
      if (!upstream.ok) { res.writeHead(502); return res.end('pull loi'); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      // chuyển tiếp NDJSON tiến độ về client
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
      return res.end();
    }

    // Bộ luật / cấu hình
    if (req.method === 'GET' && p === '/api/settings')
      return sendJson(res, 200, { rules: await db.getRules() });
    if (req.method === 'POST' && p === '/api/settings') {
      const { rules } = await readJson(req);
      if (typeof rules !== 'string') return sendJson(res, 400, { error: 'Thiếu rules' });
      await db.setSetting('rules', rules);
      return sendJson(res, 200, { ok: true });
    }

    // Danh sách TÊN TRƯỜNG nhạy cảm (tự ẩn khỏi model đám mây khi nhập/tải lên)
    if (req.method === 'GET' && p === '/api/sensitive-fields')
      return sendJson(res, 200, { fields: await db.getSensitiveFields() });
    if (req.method === 'POST' && p === '/api/sensitive-fields') {
      const { fields } = await readJson(req);
      if (!Array.isArray(fields)) return sendJson(res, 400, { error: 'Thiếu danh sách trường' });
      await db.setSensitiveFields(fields);
      return sendJson(res, 200, { ok: true });
    }
    // Áp dụng danh sách trường nhạy cảm cho dữ liệu ĐÃ CÓ (tách cột nhạy cảm ra) — chạy nền
    if (req.method === 'POST' && p === '/api/records/reapply-sensitive') {
      const jobId = startJob((onProgress) => db.reapplySensitive(onProgress));
      return sendJson(res, 200, { jobId });
    }

    // Mẫu câu lệnh
    if (req.method === 'GET' && p === '/api/templates')
      return sendJson(res, 200, { templates: await db.getTemplates() });
    if (req.method === 'POST' && p === '/api/templates') {
      const { templates } = await readJson(req);
      await db.setTemplates(templates);
      return sendJson(res, 200, { ok: true });
    }

    // Tìm kiếm
    if (req.method === 'GET' && p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { chats: [], docs: [], recs: [] });
      return sendJson(res, 200, await db.search(q));
    }

    // Trạng thái hệ thống
    if (req.method === 'GET' && p === '/api/status') return await handleStatus(res);

    if (req.method === 'GET' && p === '/api/sessions')
      return sendJson(res, 200, await db.listSessions());

    if (req.method === 'GET' && p.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(p.split('/')[3] || '');
      return sendJson(res, 200, await db.getMessages(id));
    }
    if (req.method === 'DELETE' && p.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(p.split('/')[3] || '');
      await db.deleteSession(id);
      return sendJson(res, 200, { ok: true });
    }

    // Tài liệu
    if (req.method === 'GET' && p === '/api/documents')
      return sendJson(res, 200, await db.listDocuments());
    if (req.method === 'POST' && p === '/api/documents') {
      const { title, source, content } = await readJson(req);
      if (!title || !content) return sendJson(res, 400, { error: 'Thiếu tiêu đề hoặc nội dung' });
      const jobId = startJob((onProgress) => db.addDocument({ title, source, content }, onProgress));
      return sendJson(res, 200, { jobId });
    }
    if (req.method === 'GET' && p.startsWith('/api/documents/')) {
      const doc = await db.getDocument(Number(p.split('/')[3]));
      return doc ? sendJson(res, 200, doc) : sendJson(res, 404, { error: 'Không tìm thấy tài liệu' });
    }
    if (req.method === 'PUT' && p.startsWith('/api/documents/')) {
      const id = Number(p.split('/')[3]);
      const { title, content } = await readJson(req);
      if (content != null) {
        if (!String(content).trim()) return sendJson(res, 400, { error: 'Nội dung trống' });
        if (title != null && title.trim()) await db.renameDocument(id, title.trim());
        const jobId = startJob((onProgress) => db.updateDocumentContent(id, content, onProgress));
        return sendJson(res, 200, { jobId });
      }
      if (!title || !title.trim()) return sendJson(res, 400, { error: 'Thiếu tên mới' });
      await db.renameDocument(id, title.trim());
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/documents/')) {
      await db.deleteDocument(Number(p.split('/')[3]));
      return sendJson(res, 200, { ok: true });
    }

    // Bản ghi có cấu trúc
    if (req.method === 'GET' && p === '/api/records')
      return sendJson(res, 200, await db.listRecords());
    // Thêm 1 bản ghi linh hoạt: { collection, data:{trường:giá trị,...}, sensitive? }
    if (req.method === 'POST' && p === '/api/records') {
      const r = await readJson(req);
      if (!r.data || typeof r.data !== 'object' || !Object.keys(r.data).length)
        return sendJson(res, 400, { error: 'Cần ít nhất một trường có dữ liệu' });
      return sendJson(res, 200, await db.addRecord({ ...r, sensitive: !!r.sensitive }));
    }
    // Embedding lại các bản ghi cũ đang thiếu trong knowledge (vd nạp lúc thiếu model)
    if (req.method === 'POST' && p === '/api/records/reindex') {
      const jobId = startJob((onProgress) => db.reindexRecords(onProgress));
      return sendJson(res, 200, { jobId });
    }
    // Nhập hàng loạt: { records:[{collection,data}] } (từ bước xem trước file bảng)
    if (req.method === 'POST' && p === '/api/records/import') {
      const { records } = await readJson(req);
      if (!Array.isArray(records) || !records.length)
        return sendJson(res, 400, { error: 'Không có bản ghi để nhập' });
      const jobId = startJob((onProgress) => db.addRecordsBulk(records, onProgress));
      return sendJson(res, 200, { jobId });
    }
    // Sửa 1 bản ghi (đổi nhóm và/hoặc các trường) — id ở cuối path
    if (req.method === 'PUT' && p.startsWith('/api/records/')) {
      const { collection, data } = await readJson(req);
      if (collection == null && data == null) return sendJson(res, 400, { error: 'Không có gì để cập nhật' });
      if (data != null && (typeof data !== 'object' || !Object.keys(data).length))
        return sendJson(res, 400, { error: 'Cần ít nhất một trường có dữ liệu' });
      await db.updateRecord(Number(p.split('/')[3]), { collection, data });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/records/')) {
      await db.deleteRecord(Number(p.split('/')[3]));
      return sendJson(res, 200, { ok: true });
    }

    // theo dõi tiến độ job nền
    if (req.method === 'GET' && p.startsWith('/api/jobs/')) {
      const id = p.split('/')[3] || '';
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { error: 'Không tìm thấy công việc' });
      return sendJson(res, 200, {
        status: job.status, done: job.done, total: job.total, error: job.error, result: job.result,
      });
    }

    // Kiểm tra file tải lên và tự định tuyến theo loại: { filename, dataBase64 }
    //  - bảng (excel/csv) -> trả bản ghi để xem trước rồi nhập
    //  - văn bản (pdf/word/txt) -> trả text đã trích để lưu vào tri thức
    if (req.method === 'POST' && p === '/api/files/inspect') {
      // File gửi thẳng ở body (stream), tên file ở header X-Filename.
      const filename = decodeURIComponent(req.headers['x-filename'] || '');
      if (!filename) return sendJson(res, 400, { error: 'Thiếu tên file' });
      const kind = fileKind(filename);
      if (!kind) { req.resume(); return sendJson(res, 400, { error: 'Chỉ hỗ trợ: .xlsx, .csv, .pdf, .docx, .txt, .md' }); }
      const up = await streamToTemp(req, MAX_UPLOAD);
      try {
        const buf = fs.readFileSync(up.path);
        if (kind === 'spreadsheet') {
          const { sheetName, headers, rows } = await parseSpreadsheet(filename, buf);
          const collection = (sheetName && sheetName !== 'Sheet1') ? sheetName
            : filename.replace(/\.[^.]+$/, '');
          const records = rowsToRecords(headers, rows, collection);
          return sendJson(res, 200, { kind, collection, headers, total: records.length, records });
        }
        const content = (await extractText(filename, buf) || '').trim();
        if (!content) return sendJson(res, 400, { error: 'Không trích được nội dung văn bản từ file.' });
        return sendJson(res, 200, {
          kind, title: filename.replace(/\.[^.]+$/, ''), content, chars: content.length,
        });
      } finally {
        fs.unlink(up.path, () => {});
      }
    }

    // file tĩnh
    if (req.method === 'GET') {
      let fp = p === '/' ? '/index.html' : p;
      fp = path.join(__dirname, 'public', decodeURIComponent(fp.split('?')[0]));
      if (!fp.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403); return res.end('Forbidden');
      }
      return fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
          'Cache-Control': 'no-store', // luôn lấy bản mới, tránh kẹt file cũ trong cache
        });
        res.end(data);
      });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error('Lỗi xử lý:', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

db.init()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`AVT Chat Bot đang chạy: http://0.0.0.0:${PORT}  (model: ${MODEL})`);
      console.log('Database: PGlite (Postgres nhúng) + pgvector — không cần Docker.');
    });
  })
  .catch((e) => {
    console.error('KHÔNG khởi tạo được database (PGlite).');
    console.error(e.message);
    process.exit(1);
  });
