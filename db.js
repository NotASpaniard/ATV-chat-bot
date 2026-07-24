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

  // Cờ NHẠY CẢM: dữ liệu gắn cờ này chỉ model chạy TRÊN MÁY được đọc;
  // model đám mây (gemini...) bị lọc ngay ở tầng SQL nên không bao giờ thấy.
  await pg.query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT false`);
  await pg.query(`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT false`);
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

// Kiểm tra nhanh embedding có hoạt động không (dùng để cảnh báo khi bge-m3 lỗi/thiếu)
async function embedOk() {
  try { const v = await embed('kiểm tra'); return Array.isArray(v) && v.length > 0; }
  catch { return false; }
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
  if (onProgress) onProgress(0, total); // báo tổng ngay, nếu không giao diện hiện "0/0" cho tới khi xong việc đầu
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
    // Bộ nhớ hội thoại LUÔN gắn nhạy cảm=true: nội dung hỏi-đáp có thể chứa
    // thông tin nội bộ, nên chỉ model chạy trên máy được đọc, cloud không bao giờ thấy.
    await pg.query(
      `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding, sensitive)
       VALUES ('memory', $1, 0, $2, $3::vector, true)`,
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
// Gắn TÊN TÀI LIỆU vào đầu mỗi đoạn: nhiều tài liệu có mã model chỉ nằm ở tên file
// (VD "i-PRO A4 R1") mà không có trong nội dung -> nếu không gắn thì hỏi theo mã sẽ không tìm ra.
function chunkWithTitle(title, chunk) {
  const t = clean(String(title || '')).trim();
  return t ? `[${t}]\n${chunk}` : chunk;
}

async function addDocument({ title, source, content }, onProgress) {
  const { rows } = await pg.query(
    'INSERT INTO documents (title, source) VALUES ($1, $2) RETURNING id',
    [clean(title), clean(source) || null]
  );
  const docId = rows[0].id;
  const chunks = chunkText(clean(content));
  await runPool(chunks.length, async (i) => {
    const text = chunkWithTitle(title, chunks[i]);
    const vec = await embed('search_document: ' + text);
    await pg.query(
      `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding)
       VALUES ('document', $1, $2, $3, $4::vector)`,
      [docId, i, text, toVectorLiteral(vec)]
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

async function renameDocument(id, title) {
  await pg.query('UPDATE documents SET title=$1 WHERE id=$2', [clean(title), id]);
}

// Sửa nội dung tài liệu: chunk + embed TOÀN BỘ trước, thành công hết mới thay các đoạn cũ.
// Quan trọng: nếu xóa trước mà embed lỗi giữa chừng (Ollama tắt/mất model) thì tài liệu mất trắng.
async function updateDocumentContent(id, content, onProgress) {
  const exists = (await pg.query('SELECT id, title FROM documents WHERE id=$1', [id])).rows[0];
  if (!exists) throw new Error('Không tìm thấy tài liệu');
  const chunks = chunkText(clean(content));
  const texts = chunks.map((c) => chunkWithTitle(exists.title, c));
  const vecs = new Array(texts.length);
  await runPool(texts.length, async (i) => {
    vecs[i] = toVectorLiteral(await embed('search_document: ' + texts[i]));
  }, onProgress);
  // Tới đây mọi embedding đã sẵn sàng -> thay thế an toàn
  await pg.query(`DELETE FROM knowledge WHERE source_type='document' AND source_id=$1`, [id]);
  for (let i = 0; i < texts.length; i++) {
    await pg.query(
      `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding)
       VALUES ('document', $1, $2, $3, $4::vector)`,
      [id, i, texts[i], vecs[i]]
    );
  }
  return { id, chunks: texts.length };
}

// Lấy 1 tài liệu kèm nội dung đầy đủ (ghép các đoạn đã tách).
async function getDocument(id) {
  const meta = (await pg.query('SELECT id, title, source, created_at FROM documents WHERE id=$1', [id])).rows[0];
  if (!meta) return null;
  const chunks = (await pg.query(
    `SELECT content FROM knowledge WHERE source_type='document' AND source_id=$1 ORDER BY chunk_index`, [id]
  )).rows;
  // Bỏ tiền tố "[tên tài liệu]" đã gắn lúc lập chỉ mục để người dùng chỉ thấy nội dung gốc
  const prefix = chunkWithTitle(meta.title, '');
  const strip = (s) => (prefix && String(s).startsWith(prefix) ? String(s).slice(prefix.length) : s);
  return { ...meta, content: chunks.map((c) => strip(c.content)).join('\n\n') };
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

// ---- Danh sách TÊN TRƯỜNG nhạy cảm (do người dùng khai báo) ----
// Bất kỳ trường nào trùng tên (đã chuẩn hóa) sẽ tự tách ra bản ghi nhạy cảm khi nhập/tải lên.
function normKey(s) {
  // Chuẩn hóa để so khớp tên trường: bỏ dấu (p{Diacritic}), "đ"->"d" (NFD không tự chuyển),
  // hoa->thường, gộp khoảng trắng. Nhờ vậy "Đơn Giá" == "don gia" == "ĐƠN GIÁ".
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}
let _senFieldsCache = null;
async function getSensitiveFields() {
  try { return JSON.parse(await getSetting('sensitive_fields', '[]')) || []; } catch { return []; }
}
async function getSensitiveFieldSet() {
  if (_senFieldsCache) return _senFieldsCache;
  _senFieldsCache = new Set((await getSensitiveFields()).map(normKey).filter(Boolean));
  return _senFieldsCache;
}
async function setSensitiveFields(arr) {
  const list = (Array.isArray(arr) ? arr : []).map((x) => String(x || '').trim()).filter(Boolean);
  await setSetting('sensitive_fields', JSON.stringify(list));
  _senFieldsCache = null; // làm mới cache
}
// Chọn 1 trường định danh (Tên/Mã/...) để kèm vào phần nhạy cảm cho có ngữ cảnh khi tra cứu.
function findIdentifierKey(obj) {
  const keys = Object.keys(obj);
  for (const k of keys) { const n = normKey(k); if (n.includes('ten') || n.includes('name') || n.includes('thiet bi') || n.includes('san pham') || n.startsWith('ma')) return k; }
  return keys.length ? keys[0] : null;
}
// Tách data thành phần thường + phần nhạy cảm theo danh sách tên trường.
function splitBySensitive(data, senSet) {
  const normal = {}, sens = {};
  for (const [k, v] of Object.entries(data)) {
    if (senSet.has(normKey(k))) sens[k] = v; else normal[k] = v;
  }
  if (Object.keys(sens).length) {
    const idKey = findIdentifierKey(normal);
    if (idKey != null) sens[idKey] = normal[idKey]; // kèm định danh (không xóa khỏi phần thường)
  }
  return { normal, sens };
}

// Chèn 1 bản ghi + embedding (không tách). Dùng nội bộ.
async function insertRecordRow(collection, data, sensitive) {
  const text = recordToText(collection, data);
  const vec = await embed('search_document: ' + text); // embed TRƯỚC: lỗi thì văng, không tạo bản ghi mồ côi
  const { rows } = await pg.query(
    `INSERT INTO records (collection, data, sensitive) VALUES ($1, $2, $3) RETURNING id`,
    [collection, data, sensitive]
  );
  const id = rows[0].id;
  await pg.query(
    `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding, sensitive)
     VALUES ('record', $1, 0, $2, $3::vector, $4)`,
    [id, text, toVectorLiteral(vec), sensitive]
  );
  return { id };
}

// r = { collection, data: {trường: giá trị, ...}, sensitive? }
async function addRecord(r) {
  const collection = clean((r.collection || 'chung').trim()) || 'chung';
  const data = cleanObj(r.data && typeof r.data === 'object' ? r.data : {});
  // Form "nhạy cảm": cả bản ghi nhạy cảm, không cần tách.
  if (r.sensitive) return insertRecordRow(collection, data, true);
  // Ngược lại: TỰ TÁCH theo danh sách trường nhạy cảm (nếu có khai báo).
  const senSet = await getSensitiveFieldSet();
  if (senSet.size) {
    const { normal, sens } = splitBySensitive(data, senSet);
    if (Object.keys(sens).length) {
      const normId = Object.keys(normal).length ? (await insertRecordRow(collection, normal, false)).id : null;
      const sensId = (await insertRecordRow(collection, sens, true)).id;
      return { id: normId || sensId };
    }
  }
  return insertRecordRow(collection, data, false);
}

// Áp dụng lại danh sách trường nhạy cảm cho DỮ LIỆU ĐÃ CÓ: tách cột nhạy cảm khỏi các bản ghi thường.
// Trả về: scanned (tổng bản ghi thường đã quét), records (số bản ghi có cột nhạy cảm),
//          fields (tổng số ô/trường nhạy cảm đã tách ra).
async function reapplySensitive(onProgress) {
  const senSet = await getSensitiveFieldSet();
  if (!senSet.size) return { scanned: 0, records: 0, fields: 0 };
  const { rows } = await pg.query('SELECT id, collection, data FROM records WHERE sensitive = false ORDER BY id');
  let records = 0, fields = 0;
  await runPool(rows.length, async (i) => {
    const row = rows[i];
    // đếm số TRƯỜNG nhạy cảm thật trong bản ghi (không tính trường định danh kèm thêm)
    const senCount = Object.keys(row.data).filter((k) => senSet.has(normKey(k))).length;
    if (!senCount) return; // không có trường nhạy cảm -> bỏ qua
    const { normal, sens } = splitBySensitive(row.data, senSet);
    if (Object.keys(normal).length) {
      await updateRecordData(row.id, row.collection, normal, false); // giữ phần thường (re-embed)
      await insertRecordRow(row.collection, sens, true);             // tách phần nhạy cảm ra bản ghi mới
    } else {
      await updateRecordData(row.id, row.collection, row.data, true); // cả bản ghi -> nhạy cảm
    }
    records++; fields += senCount;
  }, onProgress);
  return { scanned: rows.length, records, fields };
}

// Thống kê tên cột đang dùng trong toàn bộ bản ghi, kèm số bản ghi có cột đó.
// Dùng để GỢI Ý khi khai báo trường nhạy cảm — người dùng bấm chọn thay vì gõ đúng từ trí nhớ.
// Gộp theo tên đã chuẩn hóa (bỏ dấu, không phân biệt hoa thường) như lúc so khớp thật.
async function listFieldNames() {
  const { rows } = await pg.query(
    `SELECT k AS name, count(*)::int AS cnt,
            count(*) FILTER (WHERE r.sensitive)::int AS hidden
     FROM records r, jsonb_object_keys(r.data) AS k
     GROUP BY k`
  );
  const byNorm = new Map();
  for (const r of rows) {
    const key = normKey(r.name);
    const cur = byNorm.get(key);
    if (cur) {
      cur.count += r.cnt;
      cur.hidden += r.hidden;
      if (r.cnt > cur.topCount) { cur.name = r.name; cur.topCount = r.cnt; } // lấy cách viết phổ biến nhất
    } else {
      byNorm.set(key, { name: r.name, count: r.cnt, hidden: r.hidden, topCount: r.cnt });
    }
  }
  return [...byNorm.values()]
    .map(({ name, count, hidden }) => ({ name, count, hidden }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
}

// Cập nhật data + cờ nhạy cảm của 1 bản ghi và re-embed dòng knowledge tương ứng.
async function updateRecordData(id, collection, data, sensitive) {
  await pg.query('UPDATE records SET data=$1, sensitive=$2 WHERE id=$3', [data, sensitive, id]);
  const text = recordToText(collection, data);
  const vec = await embed('search_document: ' + text);
  await pg.query(
    `UPDATE knowledge SET content=$1, embedding=$2::vector, sensitive=$3 WHERE source_type='record' AND source_id=$4`,
    [text, toVectorLiteral(vec), sensitive, id]
  );
}

// Embedding lại các bản ghi CŨ đang thiếu trong knowledge (vd nạp lúc thiếu model).
async function reindexRecords(onProgress) {
  const { rows } = await pg.query(
    `SELECT r.id, r.collection, r.data FROM records r
     WHERE NOT EXISTS (
       SELECT 1 FROM knowledge k WHERE k.source_type='record' AND k.source_id = r.id
     ) ORDER BY r.id`
  );
  let ok = 0;
  const errors = [];
  await runPool(rows.length, async (i) => {
    const row = rows[i];
    try {
      const text = recordToText(row.collection, row.data);
      const vec = await embed('search_document: ' + text);
      await pg.query(
        `INSERT INTO knowledge (source_type, source_id, chunk_index, content, embedding)
         VALUES ('record', $1, 0, $2, $3::vector)`,
        [row.id, text, toVectorLiteral(vec)]
      );
      ok++;
    } catch (e) { errors.push({ id: row.id, error: e.message }); }
  }, onProgress);
  return { missing: rows.length, reindexed: ok, failed: errors.length, errors: errors.slice(0, 10) };
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

// Cập nhật bản ghi (đổi nhóm và/hoặc các trường) + re-embed cho RAG khớp.
async function updateRecord(id, { collection, data }) {
  const cur = (await pg.query('SELECT collection, data FROM records WHERE id=$1', [id])).rows[0];
  if (!cur) return;
  const coll = collection != null ? (clean(String(collection).trim()) || 'chung') : cur.collection;
  const newData = data != null && typeof data === 'object' ? cleanObj(data) : cur.data;
  await pg.query('UPDATE records SET collection=$1, data=$2 WHERE id=$3', [coll, newData, id]);
  const text = recordToText(coll, newData);
  try {
    const vec = await embed('search_document: ' + text);
    await pg.query(
      `UPDATE knowledge SET content=$1, embedding=$2::vector WHERE source_type='record' AND source_id=$3`,
      [text, toVectorLiteral(vec), id]
    );
  } catch (e) { console.error('updateRecord re-embed lỗi:', e.message); }
}

// ---- Cấu hình / bộ luật (bảng settings dạng key-value) ----
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
// allowSensitive=false (model đám mây): loại bỏ dữ liệu nhạy cảm ngay trong SQL.
async function retrieveRecords(queryText, k = 20, allowSensitive = true) {
  let vec;
  try { vec = await embed('search_query: ' + queryText); } catch { return []; }
  const senFilter = allowSensitive ? '' : 'AND sensitive = false';
  const { rows } = await pg.query(
    `SELECT content, 1 - (embedding <=> $1::vector) AS score
     FROM knowledge WHERE source_type = 'record' ${senFilter}
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    [toVectorLiteral(vec), k]
  );
  return rows;
}

// Như retrieveRecords nhưng lấy kèm DATA gốc (để server tự tính tiền chính xác).
async function retrieveDevices(queryText, k = 25, allowSensitive = true) {
  let vec;
  try { vec = await embed('search_query: ' + queryText); } catch { return []; }
  const senFilter = allowSensitive ? '' : 'AND k.sensitive = false';
  const { rows } = await pg.query(
    `SELECT r.id, r.collection, r.data, k.content,
            1 - (k.embedding <=> $1::vector) AS score
     FROM knowledge k JOIN records r ON r.id = k.source_id
     WHERE k.source_type = 'record' ${senFilter}
     ORDER BY k.embedding <=> $1::vector LIMIT $2`,
    [toVectorLiteral(vec), k]
  );
  return rows;
}

// Tìm theo TỪ KHÓA (mã sản phẩm: i-PRO, A4, R1...). Bổ trợ cho tìm ngữ nghĩa:
// tài liệu tiếng Anh dài thường thua bản ghi ngắn khi so vector, nhưng khớp mã thì chuẩn.
async function retrieveKeyword(tokens, k = 4, includeMemory = false, allowSensitive = true) {
  if (!Array.isArray(tokens) || !tokens.length) return [];
  const conds = [];
  if (!includeMemory) conds.push("source_type <> 'memory'");
  if (!allowSensitive) conds.push('sensitive = false');
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const params = tokens.map((t) => '%' + t + '%');
  const scoreExpr = tokens.map((_, i) => `(content ILIKE $${i + 1})::int`).join(' + ');
  const { rows } = await pg.query(
    `SELECT content, source_type, (${scoreExpr}) AS kw
     FROM knowledge ${where}
     ORDER BY kw DESC, length(content) ASC
     LIMIT ${Math.max(1, Math.min(20, Number(k) || 4))}`,
    params
  );
  return rows.filter((r) => Number(r.kw) > 0);
}

async function retrieve(queryText, k = 5, includeMemory = false, allowSensitive = true) {
  let vec;
  try {
    vec = await embed('search_query: ' + queryText);
  } catch {
    return []; // không có embedding thì bỏ qua RAG, chat vẫn chạy
  }
  // Mặc định KHÔNG lấy bộ nhớ hội thoại (chỉ tài liệu/bản ghi nghiệp vụ).
  // Chỉ khi bật "ghi nhớ xuyên hội thoại" mới gộp cả source_type='memory'.
  const conds = [];
  if (!includeMemory) conds.push("source_type <> 'memory'");
  if (!allowSensitive) conds.push('sensitive = false'); // model đám mây: cấm dữ liệu nhạy cảm
  const filter = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
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

// Đóng database an toàn (gọi trước khi thoát tiến trình) — tránh hỏng WAL do bị cắt ngang.
async function close() {
  if (pg) { try { await pg.close(); } catch {} pg = null; }
}

module.exports = {
  init, close,
  ensureSession, saveMessage, getMessages, listSessions, deleteSession, saveMemory,
  addDocument, listDocuments, deleteDocument, renameDocument, getDocument, updateDocumentContent,
  addRecord, addRecordsBulk, listRecords, deleteRecord, updateRecord, reindexRecords, listFieldNames,
  retrieve, retrieveKeyword, retrieveRecords, retrieveDevices, embedOk,
  getSensitiveFields, setSensitiveFields, reapplySensitive,
  getSetting, setSetting, getRules,
  getTemplates, setTemplates, search,
};
