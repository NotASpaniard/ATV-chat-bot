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

const PORT = process.env.PORT || 3000;
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

async function activeModel() { return db.getSetting('model', MODEL); }

// Gọi Ollama chat (stream) tới client. Trả về toàn bộ text đã sinh.
async function streamOllama(res, model, systemContent, chatMessages) {
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

  let ragContext = '';
  if (lastUser) {
    try {
      const hits = await db.retrieve(lastUser.content, 5, useMemory);
      const good = hits.filter((h) => h.score > 0.3);
      if (good.length) {
        ragContext = '\n\nDữ liệu nội bộ liên quan (ưu tiên dùng, thiếu thì nói rõ):\n' +
          good.map((h, i) => `[${i + 1}] ${h.content}`).join('\n---\n');
      }
    } catch (e) { console.error('RAG lỗi:', e.message); }
  }

  const rules = await db.getRules().catch(() => '');
  const system = SYSTEM_PROMPT + '\n\nBỘ LUẬT (phải tuân thủ):\n' + rules + ragContext;

  const full = await streamOllama(res, await activeModel(), system, messages);
  if (full && full.trim()) {
    try { await db.saveMessage(sid, 'assistant', full); } catch (e) { console.error('Lưu trả lời lỗi:', e.message); }
    if (useMemory && lastUser) db.saveMemory(sid, `Hỏi: ${lastUser.content}\nĐáp: ${full}`).catch(() => {});
  }
}

// ---- Tư vấn tối ưu: chọn phương án tốt nhất từ bảng giá theo yêu cầu khách ----
async function handleAdvise(req, res) {
  const { requirement, sessionId } = await readJson(req);
  if (!requirement || !requirement.trim()) return sendJson(res, 400, { error: 'Thiếu yêu cầu' });
  const sid = sessionId || 'default';

  let devices = [];
  try { devices = await db.retrieveRecords(requirement, 25); } catch (e) { console.error('retrieveRecords lỗi:', e.message); }

  try {
    await db.ensureSession(sid, ('Tư vấn: ' + requirement).slice(0, 60));
    await db.saveMessage(sid, 'user', '[Tư vấn tối ưu] ' + requirement);
  } catch {}

  const rules = await db.getRules().catch(() => '');
  let dataBlock = devices.length
    ? devices.map((d, i) => `[${i + 1}] ${d.content}`).join('\n')
    : '(Không tìm thấy thiết bị phù hợp trong bảng giá nội bộ.)';

  const system =
    SYSTEM_PROMPT + '\n\nBỘ LUẬT:\n' + rules +
    '\n\nBẠN LÀ CHUYÊN GIA TƯ VẤN THIẾT BỊ. Dưới đây là DANH SÁCH THIẾT BỊ nội bộ (tên, thông số, đơn giá):\n' +
    dataBlock +
    '\n\nHãy chọn PHƯƠNG ÁN TỐI ƯU NHẤT đáp ứng yêu cầu của khách. Trình bày:\n' +
    '1) Bảng: Thiết bị | Số lượng | Đơn giá | Thành tiền\n' +
    '2) TỔNG CHI PHÍ\n' +
    '3) Lý do chọn (ngắn gọn, bám sát yêu cầu)\n' +
    'CHỈ dùng thiết bị có trong danh sách trên. Nếu danh sách thiếu thứ khách cần, nói rõ thiếu gì.';

  const userMsg = [{ role: 'user', content: 'Yêu cầu của khách: ' + requirement }];
  const full = await streamOllama(res, await activeModel(), system, userMsg);
  if (full && full.trim()) {
    try { await db.saveMessage(sid, 'assistant', full); } catch {}
  }
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
      try {
        const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        models = (d.models || []).map((m) => ({ name: m.name, size: m.size }));
      } catch (e) { return sendJson(res, 200, { models: [], active: await activeModel(), error: 'Không gọi được Ollama' }); }
      return sendJson(res, 200, { models, active: await activeModel() });
    }
    if (req.method === 'POST' && p === '/api/models/active') {
      const { name } = await readJson(req);
      if (!name) return sendJson(res, 400, { error: 'Thiếu tên model' });
      await db.setSetting('model', name);
      return sendJson(res, 200, { ok: true, active: name });
    }
    if (req.method === 'POST' && p === '/api/models/delete') {
      const { name } = await readJson(req);
      if (!name) return sendJson(res, 400, { error: 'Thiếu tên model' });
      const r = await fetch(`${OLLAMA}/api/delete`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      return sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: 'Xóa lỗi: ' + r.status });
    }
    if (req.method === 'POST' && p === '/api/models/pull') {
      const { name } = await readJson(req);
      if (!name) return sendJson(res, 400, { error: 'Thiếu tên model' });
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
    if (req.method === 'DELETE' && p.startsWith('/api/documents/')) {
      await db.deleteDocument(Number(p.split('/')[3]));
      return sendJson(res, 200, { ok: true });
    }

    // Bản ghi có cấu trúc
    if (req.method === 'GET' && p === '/api/records')
      return sendJson(res, 200, await db.listRecords());
    // Thêm 1 bản ghi linh hoạt: { collection, data:{trường:giá trị,...} }
    if (req.method === 'POST' && p === '/api/records') {
      const r = await readJson(req);
      if (!r.data || typeof r.data !== 'object' || !Object.keys(r.data).length)
        return sendJson(res, 400, { error: 'Cần ít nhất một trường có dữ liệu' });
      return sendJson(res, 200, await db.addRecord(r));
    }
    // Nhập hàng loạt: { records:[{collection,data}] } (từ bước xem trước file bảng)
    if (req.method === 'POST' && p === '/api/records/import') {
      const { records } = await readJson(req);
      if (!Array.isArray(records) || !records.length)
        return sendJson(res, 400, { error: 'Không có bản ghi để nhập' });
      const jobId = startJob((onProgress) => db.addRecordsBulk(records, onProgress));
      return sendJson(res, 200, { jobId });
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
    if (req.method === 'DELETE' && p.startsWith('/api/records/')) {
      await db.deleteRecord(Number(p.split('/')[3]));
      return sendJson(res, 200, { ok: true });
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
