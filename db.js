// Lớp cơ sở dữ liệu cho AVT Chat Bot.
// PGlite (Postgres nhúng, chạy trong tiến trình Node — KHÔNG cần Docker) + pgvector.
// Toàn bộ dữ liệu lưu tại thư mục cục bộ. Embedding chạy local qua Ollama.

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'pgdata');
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const EMBED_DIM = Number(process.env.EMBED_DIM || 1024); // bge-m3 = 1024 chiều (đa ngôn ngữ, tốt cho tiếng Việt)

let pg = null; // instance PGlite (khởi tạo trong init)

// Bộ luật mặc định cho bot (người dùng sửa được ở trang Quản trị)
const DEFAULT_RULES = [
  '- Trả lời NGẮN GỌN, đi thẳng vào vấn đề, không lan man, không lặp lại câu hỏi.',
  '- Dùng tiếng Việt, lịch sự, chuyên nghiệp.',
  '- Chỉ dựa trên dữ liệu nội bộ được cung cấp; nếu không có thông tin thì nói rõ, KHÔNG bịa.',
  '- Khi nói về giá/thiết bị, nêu con số cụ thể và đơn vị nếu có.',
  '- Trình bày rõ ràng, dùng gạch đầu dòng hoặc bảng khi phù hợp.',
].join('\n');

// ---- Khởi tạo DB + schema ----
async function init() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  pg = new PGlite({ dataDir: DATA_DIR, extensions: { vector } });

  await pg.query('CREATE EXTENSION IF NOT EXISTS vector');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id         BIGSERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      source     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  // Bản ghi LINH HOẠT: không cố định cột. collection = nhóm; data = JSONB các trường tùy ý.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS records (
      id         BIGSERIAL PRIMARY KEY,
      collection TEXT NOT NULL DEFAULT 'chung',
      data       JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection)');

  // Cấu hình (bộ luật cho bot, ...) dạng key-value
  await pg.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);
  await pg.query(`INSERT INTO settings (key, value) VALUES ('rules', $1) ON CONFLICT (key) DO NOTHING`, [DEFAULT_RULES]);

  // Kho tri thức cho RAG (chứa cả đoạn tài liệu, bản ghi, và bộ nhớ hội thoại).
  await pg.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id          BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id   BIGINT NOT NULL,
      chunk_index INT NOT NULL DEFAULT 0,
      content     TEXT NOT NULL,
      embedding   vector(${EMBED_DIM}),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_knowledge_src ON knowledge(source_type, source_id)');
  try {
    await pg.query('CREATE INDEX IF NOT EXISTS idx_knowledge_hnsw ON knowledge USING hnsw (embedding vector_cosine_ops)');
  } catch (e) {
    console.warn('Bỏ qua index HNSW (vẫn tìm chính xác bằng quét tuần tự):', e.message);
  }
}

// ---- Embedding qua Ollama (local) ----
async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error('Embedding lỗi: ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('Embedding trả về không hợp lệ');
  return data.embedding;
}

// pgvector nhận vector dạng chuỗi '[1,2,3]'
function toVectorLiteral(arr) {
  return '[' + arr.join(',') + ']';
}

// Postgres không lưu được ký tự NULL (0x00) trong text/jsonb -> lọc bỏ.
const NULL_RE = new RegExp(String.fromCharCode(0), 'g');
function clean(s) {
  return typeof s === 'string' ? s.replace(NULL_RE, '') : s;
}
function cleanObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) out[clean(k)] = clean(v);
  return out;
}

// Chạy tác vụ song song có giới hạn (tăng tốc embedding trên CPU nhiều nhân).
// Gọi onProgress(done, total) sau mỗi mục xong.
const EMBED_CONCURRENCY = Number(process.env.EMBED_CONCURRENCY || 4);
async function runPool(total, task, onProgress, concurrency = EMBED_CONCURRENCY) {
  let idx = 0, done = 0;
  async function worker() {
    while (idx < total) {
      const i = idx++;
      await task(i);
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) || 1 }, worker));
}

// ---- Phiên & tin nhắn ----
async function ensureSession(id, title) {
  await pg.query(
    `INSERT INTO sessions (id, title) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [id, title || null]
  );
}

async function saveMessage(sessionId, role, content) {
  await pg.query(
    'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
    [sessionId, role, content]
  );
}

async function getMessages(sessionId, limit = 200) {
  const { rows } = await pg.query(
    'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id ASC LIMIT $2',
    [sessionId, limit]
  );
  return rows;
}

async function deleteSession(id) {
  await pg.query('DELETE FROM sessions WHERE id = $1', [id]); // messages xóa theo (cascade)
  await pg.query(`DELETE FROM knowledge WHERE source_type='memory' AND source_id=$1`, [hashId(id)]);
}

// bộ nhớ xuyên hội thoại: lưu 1 lượt hỏi-đáp vào kho tri thức (source_type='memory')
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
async function saveMemory(sessionId, text) {
  try {
    const vec = await embed('search_document: ' + text);
    await pg.query(
      `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding)
       VALUES ('memory', $1, 0, $2, $3::vector)`,
      [hashId(sessionId), text, toVectorLiteral(vec)]
    );
  } catch (e) { console.error('Lưu bộ nhớ lỗi:', e.message); }
}

async function listSessions() {
  const { rows } = await pg.query(`
    SELECT s.id, s.title, s.created_at,
           (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
           (SELECT max(created_at) FROM messages m WHERE m.session_id = s.id) AS last_at
    FROM sessions s
    ORDER BY COALESCE((SELECT max(created_at) FROM messages m WHERE m.session_id = s.id), s.created_at) DESC
    LIMIT 100`);
  return rows;
}

// ---- Cắt đoạn văn bản ----
function chunkText(text, maxLen = 2000, overlap = 200) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > maxLen && cur) {
      chunks.push(cur);
      cur = cur.slice(Math.max(0, cur.length - overlap)) + '\n\n' + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  // đoạn quá dài (không có ngắt đoạn) thì cắt cứng theo maxLen
  const out = [];
  for (const ch of chunks) {
    if (ch.length <= maxLen) out.push(ch);
    else for (let i = 0; i < ch.length; i += maxLen - overlap) out.push(ch.slice(i, i + maxLen));
  }
  return out.length ? out : [clean];
}

// ---- Tài liệu ----
async function addDocument({ title, source, content }, onProgress) {
  const { rows } = await pg.query(
    'INSERT INTO documents (title, source) VALUES ($1, $2) RETURNING id',
    [clean(title), clean(source) || null]
  );
  const docId = rows[0].id;
  const chunks = chunkText(clean(content));
  await runPool(chunks.length, async (i) => {
    const vec = await embed('search_document: ' + chunks[i]);
    await pg.query(
      `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding)
       VALUES ('document', $1, $2, $3, $4::vector)`,
      [docId, i, chunks[i], toVectorLiteral(vec)]
    );
  }, onProgress);
  return { id: docId, chunks: chunks.length };
}

async function listDocuments() {
  const { rows } = await pg.query(`
    SELECT d.id, d.title, d.source, d.created_at,
           (SELECT count(*) FROM knowledge k WHERE k.source_type='document' AND k.source_id=d.id) AS chunks
    FROM documents d ORDER BY d.id DESC`);
  return rows;
}

async function deleteDocument(id) {
  await pg.query(`DELETE FROM knowledge WHERE source_type='document' AND source_id=$1`, [id]);
  await pg.query('DELETE FROM documents WHERE id=$1', [id]);
}

// ---- Bản ghi LINH HOẠT ----
// Ghép collection + tất cả trường trong data thành văn bản để tạo embedding (tìm kiếm được).
function recordToText(collection, data) {
  const parts = [];
  if (collection && collection !== 'chung') parts.push(`Nhóm: ${collection}`);
  for (const [k, v] of Object.entries(data || {})) {
    if (v == null || v === '') continue;
    parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.join(' | ') || collection || '(trống)';
}

// r = { collection, data: {trường: giá trị, ...} }
async function addRecord(r) {
  const collection = clean((r.collection || 'chung').trim()) || 'chung';
  const data = cleanObj(r.data && typeof r.data === 'object' ? r.data : {});
  const { rows } = await pg.query(
    `INSERT INTO records (collection, data) VALUES ($1, $2) RETURNING id`,
    [collection, data]
  );
  const id = rows[0].id;
  const text = recordToText(collection, data);
  const vec = await embed('search_document: ' + text);
  await pg.query(
    `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding)
     VALUES ('record', $1, 0, $2, $3::vector)`,
    [id, text, toVectorLiteral(vec)]
  );
  return { id };
}

// Nhập nhiều bản ghi (từ file Excel/CSV). Trả về số dòng đã nhập + lỗi (nếu có).
async function addRecordsBulk(records, onProgress) {
  let ok = 0;
  const errors = [];
  await runPool(records.length, async (i) => {
    try { await addRecord(records[i]); ok++; }
    catch (e) { errors.push({ row: i + 1, error: e.message }); }
  }, onProgress);
  return { imported: ok, failed: errors.length, errors: errors.slice(0, 10) };
}

async function listRecords() {
  const { rows } = await pg.query('SELECT * FROM records ORDER BY id DESC LIMIT 500');
  return rows;
}

async function deleteRecord(id) {
  await pg.query(`DELETE FROM knowledge WHERE source_type='record' AND source_id=$1`, [id]);
  await pg.query('DELETE FROM records WHERE id=$1', [id]);
}

// ---- Tìm kiếm ngữ nghĩa (RAG) ----
// ---- Cấu hình / bộ luật ----
async function getSetting(key, fallback = '') {
  const { rows } = await pg.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}
async function setSetting(key, value) {
  await pg.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, clean(value)]
  );
}
async function getRules() { return getSetting('rules', DEFAULT_RULES); }

// ---- Mẫu câu lệnh (prompt template) ----
const DEFAULT_TEMPLATES = JSON.stringify([
  { name: 'Báo giá thiết bị', content: 'Soạn báo giá cho khách hàng {{tên khách hàng}}.\nHạng mục: {{hạng mục}}\nSố lượng: {{số lượng}}\nYêu cầu: {{yêu cầu}}\nTrình bày bảng: Thiết bị | Số lượng | Đơn giá | Thành tiền, kèm TỔNG chi phí.' },
  { name: 'Email chào hàng', content: 'Viết email chào hàng gửi {{khách hàng}}, giới thiệu {{sản phẩm/dịch vụ}}. Giọng chuyên nghiệp, ngắn gọn, có lời mời liên hệ.' },
  { name: 'Soạn hợp đồng mẫu', content: 'Soạn khung hợp đồng {{loại hợp đồng}} giữa công ty và {{đối tác}}. Các điều khoản chính: {{điều khoản}}. Ghi rõ chỗ cần điền.' },
]);
async function getTemplates() {
  const v = await getSetting('templates', DEFAULT_TEMPLATES);
  try { return JSON.parse(v); } catch { return []; }
}
async function setTemplates(arr) { await setSetting('templates', JSON.stringify(Array.isArray(arr) ? arr : [])); }

// ---- Tìm kiếm lịch sử chat + tài liệu ----
async function search(q, limit = 30) {
  const like = '%' + q + '%';
  const chats = (await pg.query(
    `SELECT m.session_id, s.title, m.role, m.content
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.content ILIKE $1 ORDER BY m.id DESC LIMIT $2`, [like, limit])).rows;
  const docs = (await pg.query(
    `SELECT id, title FROM documents WHERE title ILIKE $1 ORDER BY id DESC LIMIT 15`, [like])).rows;
  const recs = (await pg.query(
    `SELECT id, collection, data FROM records WHERE data::text ILIKE $1 ORDER BY id DESC LIMIT 15`, [like])).rows;
  return { chats, docs, recs };
}

// ---- Truy hồi riêng bảng giá/thiết bị (cho tính năng tư vấn tối ưu) ----
async function retrieveRecords(queryText, k = 20) {
  let vec;
  try { vec = await embed('search_query: ' + queryText); } catch { return []; }
  const { rows } = await pg.query(
    `SELECT content, 1 - (embedding <=> $1::vector) AS score
     FROM knowledge WHERE source_type = 'record'
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    [toVectorLiteral(vec), k]
  );
  return rows;
}

async function retrieve(queryText, k = 5, includeMemory = false) {
  let vec;
  try {
    vec = await embed('search_query: ' + queryText);
  } catch {
    return []; // không có embedding thì bỏ qua RAG, chat vẫn chạy
  }
  // Mặc định KHÔNG lấy bộ nhớ hội thoại (chỉ tài liệu/bản ghi nghiệp vụ).
  // Chỉ khi bật "ghi nhớ xuyên hội thoại" mới gộp cả source_type='memory'.
  const filter = includeMemory ? '' : "WHERE source_type <> 'memory'";
  const { rows } = await pg.query(
    `SELECT content, source_type, 1 - (embedding <=> $1::vector) AS score
     FROM knowledge
     ${filter}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(vec), k]
  );
  return rows;
}

module.exports = {
  init,
  ensureSession, saveMessage, getMessages, listSessions, deleteSession, saveMemory,
  addDocument, listDocuments, deleteDocument,
  addRecord, addRecordsBulk, listRecords, deleteRecord,
  retrieve, retrieveRecords,
  getSetting, setSetting, getRules,
  getTemplates, setTemplates, search,
};
