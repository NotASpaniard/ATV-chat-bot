// Trang quản trị: nhập dữ liệu (tay + tải file), xem/sửa dữ liệu đã lưu, bộ luật & mẫu.

// --- chuyển tab ---
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'config') { loadRules(); refreshTplCount(); }
  });
});

function api(url, opts) {
  return fetch(url, opts).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  });
}
function setStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
// ===== NHẬP TAY LINH HOẠT (dùng chung cho form thường và form nhạy cảm) =====
function makeFieldRow(container, key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <input class="f-key" placeholder="Tên trường (VD: Đơn giá)" value="${esc(key)}" />
    <input class="f-val" placeholder="Giá trị" value="${esc(val)}" />
    <button type="button" class="f-del" title="Xóa trường">✕</button>`;
  row.querySelector('.f-del').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// ===== NHẬP TAY: 2 chế độ — "Dán nhanh" (mặc định) và "Gõ từng trường" =====

// Tách văn bản dán vào thành danh sách bản ghi. Nhận 2 kiểu:
//  A. Bảng dán từ Excel: dòng đầu là tên cột, các dòng sau là dữ liệu, ngăn bằng Tab -> nhiều bản ghi.
//  B. Mỗi dòng "Tên trường: giá trị" -> gộp thành MỘT bản ghi (cho phép ngăn bằng "|" trên cùng dòng).
function parsePasted(text) {
  const raw = String(text || '').split(/\r?\n/);
  const lines = [];
  for (const r of raw) {
    const t = r.trim();
    if (!t) continue;
    // "Tên: X | Đơn giá: Y" -> tách thành nhiều dòng cho dễ đọc
    if (!t.includes('\t') && t.includes('|') && t.includes(':')) {
      t.split('|').map((s) => s.trim()).filter(Boolean).forEach((s) => lines.push(s));
    } else lines.push(t);
  }
  if (!lines.length) return [];

  if (lines.some((l) => l.includes('\t'))) {           // kiểu A: bảng
    const headers = lines[0].split('\t').map((s) => s.trim());
    const out = [];
    for (const line of lines.slice(1)) {
      const cells = line.split('\t');
      const data = {};
      headers.forEach((h, i) => { const v = (cells[i] || '').trim(); if (h && v) data[h] = v; });
      if (Object.keys(data).length) out.push(data);
    }
    return out;
  }

  const data = {};                                      // kiểu B: từng dòng khóa: giá trị
  for (const line of lines) {
    const m = line.match(/^(.{1,60}?)\s*[:=]\s*(.+)$/);
    if (m) { const k = m[1].trim(); const v = m[2].trim(); if (k && v) data[k] = v; }
  }
  return Object.keys(data).length ? [data] : [];
}

function wireManualEntry() {
  const form = document.getElementById('man-form');
  const statusEl = document.getElementById('man-status');
  const fields = document.getElementById('man-fields');
  const pasteEl = document.getElementById('man-paste');
  const previewEl = document.getElementById('man-preview');
  const pasteWrap = document.getElementById('man-paste-wrap');
  const fieldsWrap = document.getElementById('man-fields-wrap');
  const submitBtn = document.getElementById('man-submit');
  let mode = 'paste';

  const seedRows = () => { fields.innerHTML = ''; ['Tên', 'Đơn giá'].forEach((k) => makeFieldRow(fields, k, '')); };
  seedRows();
  document.getElementById('man-add').addEventListener('click', () => makeFieldRow(fields));

  // Xem trước ngay khi gõ/dán: người dùng thấy hệ thống hiểu đúng chưa trước khi lưu
  function renderPreview() {
    const recs = parsePasted(pasteEl.value);
    if (!recs.length) { previewEl.innerHTML = ''; submitBtn.textContent = 'Lưu bản ghi'; return; }
    const keys = [...new Set(recs.flatMap((r) => Object.keys(r)))];
    const head = keys.map((k) => `<th>${esc(k)}</th>`).join('');
    const body = recs.slice(0, 5).map((r) =>
      `<tr>${keys.map((k) => `<td>${esc(r[k] || '')}</td>`).join('')}</tr>`).join('');
    previewEl.innerHTML =
      `<div class="pp-head">Nhận ra <b>${recs.length}</b> bản ghi, <b>${keys.length}</b> trường` +
      (recs.length > 5 ? ' (xem trước 5 dòng đầu)' : '') + '</div>' +
      `<div class="pp-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    submitBtn.textContent = recs.length > 1 ? `Lưu ${recs.length} bản ghi` : 'Lưu bản ghi';
  }
  pasteEl.addEventListener('input', renderPreview);

  document.getElementById('man-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    mode = btn.dataset.mode;
    document.querySelectorAll('#man-mode .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    pasteWrap.classList.toggle('hidden', mode !== 'paste');
    fieldsWrap.classList.toggle('hidden', mode !== 'fields');
    submitBtn.textContent = 'Lưu bản ghi';
    if (mode === 'paste') renderPreview();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const collection = document.getElementById('man-collection').value.trim();
    let records;
    if (mode === 'paste') {
      records = parsePasted(pasteEl.value);
      if (!records.length) {
        setStatus(statusEl, 'Chưa tách được trường nào. Dán bảng từ Excel hoặc gõ "Tên trường: giá trị".', false);
        return;
      }
    } else {
      const data = {};
      fields.querySelectorAll('.field-row').forEach((r) => {
        const k = r.querySelector('.f-key').value.trim();
        const v = r.querySelector('.f-val').value.trim();
        if (k && v) data[k] = v;
      });
      if (!Object.keys(data).length) { setStatus(statusEl, 'Nhập ít nhất một trường có giá trị.', false); return; }
      records = [data];
    }

    submitBtn.disabled = true;
    setStatus(statusEl, 'Đang lưu…', true);
    try {
      if (records.length === 1) {
        await api('/api/records', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection, data: records[0], sensitive: false }),
        });
      } else {
        // Nhiều bản ghi -> chạy nền qua job (embedding từng bản ghi mất thời gian)
        const { jobId } = await api('/api/records/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: records.map((data) => ({ collection, data })) }),
        });
        await pollJob(jobId, (done, total) => setStatus(statusEl, `Đang lưu ${done}/${total}…`, true));
      }
      setStatus(statusEl, `Đã lưu ${records.length} bản ghi.`, true);
      if (mode === 'paste') { pasteEl.value = ''; renderPreview(); } else seedRows();
      refreshSavedCount();
    } catch (err) {
      setStatus(statusEl, 'Lỗi: ' + err.message, false);
    } finally { submitBtn.disabled = false; }
  });
}
wireManualEntry();

// ===== TRƯỜNG NHẠY CẢM: bấm khóa/mở ngay trên các cột đang có trong dữ liệu =====
let senfList = [];       // danh sách đã LƯU trên máy chủ
let senfDraft = [];      // danh sách đang chỉnh (chưa lưu)
let senfCols = [];       // các cột có thật trong dữ liệu: { name, count, inSensitive }
const senfColsEl = document.getElementById('senf-cols');
const senfInput = document.getElementById('senf-input');
const senfStatus = document.getElementById('senf-status');
const senfSaveBtn = document.getElementById('senf-save');

// Chuẩn hóa để so trùng: bỏ dấu + hoa thường + gộp khoảng trắng (khớp với backend)
const normField = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const inDraft = (name) => senfDraft.some((x) => normField(x) === normField(name));
const senfChanged = () => senfDraft.length !== senfList.length
  || senfDraft.some((d) => !senfList.some((s) => normField(s) === normField(d)));

const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></svg>';

// Nhãn dưới tên cột: cho biết cột nằm ở bao nhiêu bản ghi và bao nhiêu bản đã khóa xong
function sfCountLabel(c) {
  if (c.notFound) return 'chưa có trong dữ liệu';
  if (c.hidden >= c.count) return `${c.count} bản ghi · đã khóa`;
  if (c.hidden > 0) return `${c.count} bản ghi · ${c.count - c.hidden} chưa khóa`;
  return `${c.count} bản ghi`;
}

function renderSenf() {
  // Cột có thật trong dữ liệu + cột chỉ mới khai báo (chưa xuất hiện ở đâu)
  const extra = senfDraft
    .filter((d) => !senfCols.some((c) => normField(c.name) === normField(d)))
    .map((name) => ({ name, count: 0, notFound: true }));
  const all = [...senfCols, ...extra];

  senfColsEl.innerHTML = all.length
    ? all.map((c) => {
        const on = inDraft(c.name);
        return `<button type="button" class="sf-col${on ? ' on' : ''}${c.notFound ? ' ghost' : ''}" data-name="${esc(c.name)}"
          title="${on ? 'Đang khóa — bấm để mở cho đám mây đọc' : 'Bấm để khóa, đám mây sẽ không đọc cột này'}">
          <span class="sf-ico">${on ? LOCK_SVG : UNLOCK_SVG}</span>
          <span class="sf-nm">${esc(c.name)}</span>
          <span class="sf-ct">${esc(sfCountLabel(c))}</span>
        </button>`;
      }).join('')
    : '<span class="empty" style="padding:0">Chưa có dữ liệu nào để chọn. Tải file hoặc nhập tay trước, hoặc gõ thêm cột ở dưới.</span>';

  const changed = senfChanged();
  senfSaveBtn.disabled = !changed;
  senfSaveBtn.textContent = changed ? `Lưu & khóa dữ liệu (${senfDraft.length} cột)` : 'Đã lưu';

  const cnt = document.getElementById('senf-count');
  if (cnt) { cnt.textContent = senfDraft.length || ''; cnt.classList.toggle('hidden', !senfDraft.length); }
}

function toggleSenf(name) {
  senfDraft = inDraft(name)
    ? senfDraft.filter((x) => normField(x) !== normField(name))
    : [...senfDraft, name];
  setStatus(senfStatus, '', true);
  renderSenf();
}

senfColsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.sf-col');
  if (btn) toggleSenf(btn.dataset.name);
});
const addTyped = () => {
  const v = senfInput.value.trim();
  if (!v) return;
  if (!inDraft(v)) senfDraft.push(v);
  senfInput.value = '';
  renderSenf();
};
senfInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });
document.getElementById('senf-add').addEventListener('click', () => { addTyped(); senfInput.focus(); });

// Lưu danh sách VÀ lọc dữ liệu cũ trong một lần bấm — trước đây là 2 nút, dễ quên bước 2
senfSaveBtn.addEventListener('click', async () => {
  senfSaveBtn.disabled = true;
  setStatus(senfStatus, 'Đang lưu danh sách…', true);
  try {
    await api('/api/sensitive-fields', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: senfDraft }),
    });
    senfList = [...senfDraft];
    setStatus(senfStatus, 'Đang rà lại dữ liệu đã có…', true);
    const { jobId } = await api('/api/records/reapply-sensitive', { method: 'POST' });
    const r = await pollJob(jobId, (done, total) => setStatus(senfStatus, `Đang rà ${done}/${total}…`, true));
    // r.scanned chỉ đếm bản ghi CHƯA khóa — các bản khóa từ trước không cần rà lại
    setStatus(senfStatus, r.fields
      ? `Xong. Đã tách ${r.fields} trường trong ${r.records}/${r.scanned} bản ghi — đám mây không còn đọc được các cột này.`
      : `Xong. Đã lưu danh sách. Rà ${r.scanned} bản ghi chưa khóa, không bản ghi nào chứa cột trong danh sách (bản ghi đã khóa từ trước không cần rà lại).`, true);
    await loadSenfCols();
    refreshSavedCount();
  } catch (err) {
    setStatus(senfStatus, 'Lỗi: ' + err.message, false);
  } finally { renderSenf(); }
});

async function loadSenfCols() {
  try { senfCols = (await api('/api/fields')).fields || []; } catch { senfCols = []; }
  renderSenf();
}
(async () => {
  try { senfList = (await api('/api/sensitive-fields')).fields || []; } catch {}
  senfDraft = [...senfList];
  await loadSenfCols();
})();
// ===== TẢI FILE LÊN (thanh -> popup: kéo thả -> danh sách -> trang sửa nội dung) =====
const MAX_UPLOAD_MB = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Việc chạy nền (embedding) — hỏi tiến độ tới khi xong
async function pollJob(jobId, onProgress) {
  while (true) {
    const j = await api('/api/jobs/' + jobId);
    if (j.status === 'running') { if (onProgress) onProgress(j.done, j.total); await sleep(700); continue; }
    if (j.status === 'error') throw new Error(j.error || 'Lỗi xử lý');
    return j.result;
  }
}

const upModal = document.getElementById('upload-modal');
const upListView = document.getElementById('up-list-view');
const upEditView = document.getElementById('up-edit-view');
const upItemsEl = document.getElementById('up-items');
const dropZone = document.getElementById('drop-zone');
const dropInput = document.getElementById('drop-input');

// Mỗi file là một mục trong danh sách; giữ luôn kết quả phân tích để mở ra sửa lại được.
// state: 'reading' | 'ready' | 'saving' | 'done' | 'error'
let upItems = [];
let upSeq = 0;

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const UP_ICONS = {
  sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  spin: '<svg class="up-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
};

function upIconFor(it) {
  if (it.state === 'reading' || it.state === 'saving') return UP_ICONS.spin;
  if (it.state === 'done') return UP_ICONS.check;
  if (it.state === 'error') return UP_ICONS.warn;
  return it.kind === 'spreadsheet' ? UP_ICONS.sheet : UP_ICONS.text;
}

// Dòng mô tả dưới tên file — cho biết đang ở bước nào và bấm vào thì được gì
function upSubFor(it) {
  if (it.state === 'reading') return 'Đang đọc file…';
  if (it.state === 'saving') return it.progress || 'Đang lưu…';
  if (it.state === 'error') return it.error || 'Lỗi';
  if (it.state === 'done') return it.doneMsg || 'Đã lưu';
  if (it.kind === 'spreadsheet') return `${it.res.total} dòng · bấm để xem trước rồi nhập`;
  // đếm trên nội dung hiện tại để số cập nhật ngay sau khi người dùng sửa
  return `${it.res.content.length.toLocaleString('vi-VN')} ký tự · bấm để sửa nội dung rồi lưu`;
}

function renderUpItems() {
  upItemsEl.innerHTML = upItems.map((it) => `
    <div class="up-item ${it.state}" data-id="${it.id}">
      <span class="up-ico">${upIconFor(it)}</span>
      <button type="button" class="up-open" ${it.state === 'ready' ? '' : 'disabled'}>
        <span class="up-name">${esc(it.name)}</span>
        <span class="up-sub">${esc(upSubFor(it))}</span>
      </button>
      <span class="up-size">${esc(it.size)}</span>
      <button type="button" class="up-x" title="Bỏ khỏi danh sách">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join('');
  const n = upItems.filter((i) => i.state === 'done').length;
  const badge = document.getElementById('upload-count');
  if (badge) { badge.textContent = n || ''; badge.classList.toggle('hidden', !n); }
}

const findItem = (id) => upItems.find((i) => String(i.id) === String(id));

// --- Trang 2: xem trước bảng / sửa nội dung văn bản ---
function openUpEdit(id) {
  const it = findItem(id);
  if (!it || it.state !== 'ready') return;
  upListView.classList.add('hidden');
  upEditView.classList.remove('hidden');
  document.getElementById('upload-modal-title').textContent = it.name;

  const backBar = `<div class="detail-bar">
      <button class="detail-back" type="button" title="Quay lại">${BACK_SVG}<span>Quay lại</span></button>
      <span class="type-tag">${it.kind === 'spreadsheet' ? 'Bảng dữ liệu' : 'Văn bản'}</span>
    </div>`;

  if (it.kind === 'spreadsheet') {
    const cols = it.res.headers;
    const rows = it.res.records.slice(0, 20).map((r) =>
      `<tr>${cols.map((c) => `<td>${esc(r.data[(c || '').trim()] || '')}</td>`).join('')}</tr>`).join('');
    upEditView.innerHTML = backBar + `
      <p class="sub">Nhóm <b>${esc(it.res.collection)}</b> · ${it.res.total} dòng · ${cols.length} cột${it.res.total > 20 ? ' (xem trước 20 dòng đầu)' : ''}</p>
      <div class="paste-preview"><div class="pp-scroll"><table>
        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>
      </table></div></div>
      <div class="form-actions">
        <button type="button" class="btn-primary up-save">Nhập ${it.res.total} bản ghi</button>
        <span class="status up-edit-status"></span>
      </div>`;
  } else {
    upEditView.innerHTML = backBar + `
      <label>Tiêu đề</label>
      <input class="up-title" value="${esc(it.res.title)}" />
      <label>Nội dung — sửa thoải mái trước khi lưu</label>
      <textarea class="up-content" rows="16" spellcheck="false"></textarea>
      <div class="up-chars"></div>
      <div class="form-actions">
        <button type="button" class="btn-primary up-save">Lưu vào tri thức</button>
        <span class="status up-edit-status"></span>
      </div>`;
    const ta = upEditView.querySelector('.up-content');
    ta.value = it.res.content;
    const chars = upEditView.querySelector('.up-chars');
    const showChars = () => { chars.textContent = ta.value.length.toLocaleString('vi-VN') + ' ký tự'; };
    showChars();
    ta.addEventListener('input', () => {
      showChars();
      it.res.content = ta.value;                                   // nhớ bản đã sửa nếu quay ra rồi vào lại
      it.res.title = upEditView.querySelector('.up-title').value;
    });
    upEditView.querySelector('.up-title').addEventListener('input', (e) => { it.res.title = e.target.value; });
  }

  upEditView.querySelector('.detail-back').addEventListener('click', closeUpEdit);
  upEditView.querySelector('.up-save').addEventListener('click', () => saveUpItem(it));
}

function closeUpEdit() {
  upEditView.classList.add('hidden');
  upEditView.innerHTML = '';
  upListView.classList.remove('hidden');
  document.getElementById('upload-modal-title').textContent = 'Tải file lên';
}

// --- Đọc file: hỏi server xem là bảng hay văn bản ---
async function inspectItem(it) {
  it.state = 'reading'; renderUpItems();
  try {
    const res = await api('/api/files/inspect', {
      method: 'POST', headers: { 'X-Filename': encodeURIComponent(it.name) }, body: it.file,
    });
    if (res.kind === 'spreadsheet' && !(res.records || []).length) throw new Error('Không tìm thấy dòng dữ liệu nào');
    it.res = res; it.kind = res.kind; it.state = 'ready';
  } catch (err) {
    it.state = 'error'; it.error = err.message;
  }
  renderUpItems();
}

// --- Lưu: bảng -> bản ghi, văn bản -> kho tri thức ---
async function saveUpItem(it) {
  const statusEl = upEditView.querySelector('.up-edit-status');
  const btn = upEditView.querySelector('.up-save');
  const isSheet = it.kind === 'spreadsheet';
  if (!isSheet) {
    const title = (it.res.title || '').trim();
    if (!title || !it.res.content.trim()) { setStatus(statusEl, 'Thiếu tiêu đề hoặc nội dung.', false); return; }
  }
  btn.disabled = true;
  it.state = 'saving'; it.progress = 'Đang lưu…'; renderUpItems();
  const onProg = (done, total) => {
    it.progress = total ? `Đang lưu ${done}/${total}…` : 'Đang lưu…';
    renderUpItems();
    setStatus(statusEl, it.progress, true);
  };
  try {
    let msg;
    if (isSheet) {
      const { jobId } = await api('/api/records/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: it.res.records }),
      });
      const r = await pollJob(jobId, onProg);
      msg = `Đã nhập ${r.imported} bản ghi` + (r.failed ? ` (${r.failed} lỗi)` : '');
    } else {
      const { jobId } = await api('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: it.res.title.trim(), content: it.res.content }),
      });
      const r = await pollJob(jobId, onProg);
      msg = `Đã lưu vào tri thức · ${(r && r.chunks) || 0} đoạn`;
    }
    it.state = 'done'; it.doneMsg = msg;
    renderUpItems(); refreshSavedCount(); closeUpEdit();
  } catch (err) {
    it.state = 'ready'; it.error = err.message;
    renderUpItems();
    setStatus(statusEl, 'Lỗi: ' + err.message, false);
    btn.disabled = false;
  }
}

// --- Nhận file từ hộp thoại chọn hoặc kéo thả ---
function addFiles(files) {
  for (const f of files) {
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) {
      upItems.push({ id: ++upSeq, name: f.name, size: fmtSize(f.size), state: 'error',
        error: `File quá lớn (${(f.size / 1048576).toFixed(0)}MB) — tối đa ${MAX_UPLOAD_MB}MB` });
      continue;
    }
    const it = { id: ++upSeq, file: f, name: f.name, size: fmtSize(f.size), state: 'reading' };
    upItems.push(it);
    inspectItem(it);
  }
  renderUpItems();
}

if (dropInput) {
  dropInput.addEventListener('change', () => { addFiles([...dropInput.files]); dropInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); dropZone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); dropZone.classList.remove('over');
  }));
  dropZone.addEventListener('drop', (e) => { if (e.dataTransfer) addFiles([...e.dataTransfer.files]); });

  upItemsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.up-item');
    if (!row) return;
    if (e.target.closest('.up-x')) {
      upItems = upItems.filter((i) => String(i.id) !== row.dataset.id);
      renderUpItems();
      return;
    }
    if (e.target.closest('.up-open')) openUpEdit(row.dataset.id);
  });

  document.getElementById('upload-bar').addEventListener('click', () => {
    upModal.classList.remove('hidden');
    closeUpEdit();
    renderUpItems();
  });
  const hideUp = () => { upModal.classList.add('hidden'); closeUpEdit(); };
  document.getElementById('upload-close').addEventListener('click', hideUp);
  upModal.addEventListener('click', (e) => { if (e.target === upModal) hideUp(); });
}

// ===== DỮ LIỆU ĐÃ LƯU (popup: danh sách + trang chi tiết) =====
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';

let savedRecs = [], savedDocs = [];
let listMode = 'normal'; // 'normal' = dữ liệu thường | 'sensitive' = dữ liệu nhạy cảm

// --- Danh sách gọn: Tên | Loại (giữa) | Xóa. Lọc theo chế độ thường/nhạy cảm ---
async function loadSavedData(mode) {
  if (mode) listMode = mode;
  const body = document.getElementById('data-modal-body');
  document.getElementById('data-modal-title').textContent =
    listMode === 'sensitive' ? 'Dữ liệu nhạy cảm đã lưu' : 'Dữ liệu đã lưu';
  body.innerHTML = 'Đang tải…';
  try {
    const [recs, docs] = await Promise.all([api('/api/records'), api('/api/documents')]);
    savedRecs = recs; savedDocs = docs;
    updateCounts(recs, docs);
    const showRecs = recs.filter((r) => !!r.sensitive === (listMode === 'sensitive'));
    const showDocs = listMode === 'sensitive' ? [] : docs; // tài liệu hiện chỉ ở danh sách thường
    if (!showRecs.length && !showDocs.length) {
      body.innerHTML = '<div class="empty">' + (listMode === 'sensitive' ? 'Chưa có dữ liệu nhạy cảm nào.' : 'Chưa có dữ liệu nào.') + '</div>';
      return;
    }
    const rows = [];
    for (const d of showDocs) rows.push(`<tr>
      <td><button class="name-link" data-kind="doc" data-id="${d.id}">${esc(d.title)}</button></td>
      <td class="col-type"><span class="type-tag">Tài liệu</span></td>
      <td class="row-acts"><button class="row-del" title="Xóa" data-kind="doc" data-id="${d.id}">${TRASH_SVG}</button></td></tr>`);
    for (const r of showRecs) rows.push(`<tr>
      <td><button class="name-link" data-kind="rec" data-id="${r.id}">${esc(r.collection || 'chung')}</button></td>
      <td class="col-type"><span class="type-tag ${r.sensitive ? 'sen' : 'rec'}">${r.sensitive ? 'Nhạy cảm' : 'Bản ghi'}</span></td>
      <td class="row-acts"><button class="row-del" title="Xóa" data-kind="rec" data-id="${r.id}">${TRASH_SVG}</button></td></tr>`);
    body.innerHTML = `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Tên</th><th class="col-type">Loại</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  } catch (err) { body.innerHTML = '<div class="empty">Lỗi tải: ' + esc(err.message) + '</div>'; }
}

function updateCounts(recs, docs) {
  const sen = recs.filter((r) => r.sensitive).length;
  document.getElementById('saved-count').textContent = (docs.length + recs.length - sen) || '';
  document.getElementById('sen-count').textContent = sen || '';
}

const detailBarHtml = (typeLabel, typeClass) => `
  <div class="detail-bar">
    <button class="detail-back" type="button" title="Quay lại">${BACK_SVG}<span>Quay lại</span></button>
    <span class="type-tag${typeClass}">${typeLabel}</span>
  </div>`;

// --- Chi tiết TÀI LIỆU: xem nội dung đầy đủ + sửa tên ---
async function openDocDetail(id) {
  const body = document.getElementById('data-modal-body');
  body.innerHTML = 'Đang tải…';
  let doc;
  try { doc = await api('/api/documents/' + id); }
  catch (err) { body.innerHTML = '<div class="empty">Lỗi tải: ' + esc(err.message) + '</div>'; return; }
  let name = doc.title || '';
  body.innerHTML = detailBarHtml('Tài liệu', '') + `
    <label class="detail-lbl">Tên tài liệu (sửa rồi Enter để lưu)</label>
    <input class="detail-title-input doc-title" value="${esc(name)}" />
    <label class="detail-lbl" style="margin-top:14px">Nội dung (sửa xong bấm Lưu — hệ thống sẽ tạo lại chỉ mục tìm kiếm)</label>
    <textarea class="doc-content-edit" rows="14">${esc(doc.content || '')}</textarea>
    <div class="form-actions">
      <button type="button" class="btn-primary doc-save">Lưu nội dung</button>
      <span class="detail-saved" id="detail-saved"></span>
    </div>`;
  const titleInput = body.querySelector('.doc-title');
  const saved = () => document.getElementById('detail-saved');
  const saveTitle = async () => {
    const nv = titleInput.value.trim();
    if (!nv || nv === name) return;
    try {
      await api('/api/documents/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: nv }) });
      name = nv; saved().textContent = 'Đã lưu tên'; refreshSavedCount();
    } catch (err) { saved().textContent = 'Lỗi: ' + err.message; }
  };
  titleInput.addEventListener('change', saveTitle);
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); } });
  body.querySelector('.doc-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const content = body.querySelector('.doc-content-edit').value;
    if (!content.trim()) { saved().textContent = 'Nội dung trống.'; return; }
    btn.disabled = true; saved().textContent = 'Đang lưu & tạo lại chỉ mục…';
    try {
      const { jobId } = await api('/api/documents/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titleInput.value.trim() || name, content }),
      });
      const result = await pollJob(jobId, (done, total) => { saved().textContent = `Đang xử lý ${done}/${total}…`; });
      name = titleInput.value.trim() || name;
      saved().textContent = `Đã lưu nội dung (${(result && result.chunks) || 0} đoạn)`;
      refreshSavedCount();
    } catch (err) { saved().textContent = 'Lỗi: ' + err.message; }
    finally { btn.disabled = false; }
  });
}

// --- Chi tiết BẢN GHI: sửa nhóm + các trường (thêm/xóa) rồi lưu ---
function fieldRowHtml(k, v) {
  return `<div class="field-row">
    <input class="f-key" placeholder="Tên trường" value="${esc(k)}" />
    <input class="f-val" placeholder="Giá trị" value="${esc(v)}" />
    <button type="button" class="f-del" title="Xóa trường">×</button>
  </div>`;
}
function openRecDetail(id) {
  const body = document.getElementById('data-modal-body');
  const r = savedRecs.find((x) => x.id == id);
  if (!r) { body.innerHTML = '<div class="empty">Không tìm thấy bản ghi.</div>'; return; }
  const entries = Object.entries(r.data || {});
  body.innerHTML = detailBarHtml('Bản ghi', ' rec') + `
    <label class="detail-lbl">Tên nhóm</label>
    <input class="detail-title-input rec-coll" value="${esc(r.collection || 'chung')}" />
    <label class="detail-lbl" style="margin-top:16px">Các trường (sửa trực tiếp)</label>
    <div class="rec-fields">${(entries.length ? entries : [['', '']]).map(([k, v]) => fieldRowHtml(k, v)).join('')}</div>
    <button type="button" class="btn-ghost rec-add" style="margin-top:4px">+ Thêm trường</button>
    <div class="form-actions">
      <button type="button" class="btn-primary rec-save">Lưu thay đổi</button>
      <span class="detail-saved" id="detail-saved"></span>
    </div>`;
  const fieldsEl = body.querySelector('.rec-fields');
  body.querySelector('.rec-add').addEventListener('click', () => fieldsEl.insertAdjacentHTML('beforeend', fieldRowHtml('', '')));
  fieldsEl.addEventListener('click', (e) => { const d = e.target.closest('.f-del'); if (d) d.closest('.field-row').remove(); });
  body.querySelector('.rec-save').addEventListener('click', async () => {
    const collection = body.querySelector('.rec-coll').value.trim();
    const data = {};
    body.querySelectorAll('.field-row').forEach((row) => {
      const k = row.querySelector('.f-key').value.trim();
      if (k) data[k] = row.querySelector('.f-val').value.trim();
    });
    const saved = document.getElementById('detail-saved');
    if (!Object.keys(data).length) { saved.textContent = 'Cần ít nhất một trường có tên.'; return; }
    try {
      await api('/api/records/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection, data }) });
      r.collection = collection || 'chung'; r.data = data;
      saved.textContent = 'Đã lưu thay đổi';
      refreshSavedCount();
    } catch (err) { saved.textContent = 'Lỗi: ' + err.message; }
  });
}

function openDetail(kind, id) { return kind === 'doc' ? openDocDetail(id) : openRecDetail(id); }

// Cập nhật số đếm trên 2 thanh (không mở popup)
async function refreshSavedCount() {
  try {
    const [recs, docs] = await Promise.all([api('/api/records'), api('/api/documents')]);
    updateCounts(recs, docs);
  } catch {}
}

// Mở/đóng popup + điều hướng
const dataModal = document.getElementById('data-modal');
document.getElementById('saved-bar').addEventListener('click', () => { dataModal.classList.remove('hidden'); loadSavedData('normal'); });
document.getElementById('sen-bar').addEventListener('click', () => { dataModal.classList.remove('hidden'); loadSavedData('sensitive'); });
document.getElementById('data-close').addEventListener('click', () => dataModal.classList.add('hidden'));
dataModal.addEventListener('click', (e) => { if (e.target === dataModal) dataModal.classList.add('hidden'); });
document.getElementById('data-modal-body').addEventListener('click', async (e) => {
  const nameLink = e.target.closest('.name-link');
  const del = e.target.closest('.row-del');
  const back = e.target.closest('.detail-back');
  if (back) { loadSavedData(); return; }
  if (nameLink) { openDetail(nameLink.dataset.kind, nameLink.dataset.id); return; }
  if (del) {
    if (!(await avtConfirm('Xóa mục này?'))) return;
    const url = (del.dataset.kind === 'doc' ? '/api/documents/' : '/api/records/') + del.dataset.id;
    try { await api(url, { method: 'DELETE' }); loadSavedData(); }
    catch (err) { avtAlert('Lỗi xóa: ' + err.message); }
  }
});
refreshSavedCount();

// ===== BỘ LUẬT =====
const rulesText = document.getElementById('rules-text');
const rulesStatus = document.getElementById('rules-status');
let rulesLoaded = false;
async function loadRules() {
  if (rulesLoaded) return;
  try {
    const r = await api('/api/settings');
    rulesText.value = r.rules || '';
    rulesLoaded = true;
  } catch (err) { setStatus(rulesStatus, 'Lỗi tải: ' + err.message, false); }
}
document.getElementById('rules-save').addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true;
  setStatus(rulesStatus, 'Đang lưu…', true);
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: rulesText.value }),
    });
    setStatus(rulesStatus, 'Đã lưu. Áp dụng ngay cho câu trả lời tiếp theo.', true);
  } catch (err) { setStatus(rulesStatus, 'Lỗi: ' + err.message, false); }
  finally { btn.disabled = false; }
});

// ===== MẪU CÂU LỆNH (popup: danh sách + chi tiết) =====
let tplData = [];
async function saveTplArray() {
  await api('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templates: tplData }) });
  document.getElementById('tpl-count').textContent = tplData.length || '';
}
async function refreshTplCount() {
  try { tplData = (await api('/api/templates')).templates || []; document.getElementById('tpl-count').textContent = tplData.length || ''; }
  catch {}
}
function renderTplList() {
  const body = document.getElementById('tpl-modal-body');
  document.getElementById('tpl-count').textContent = tplData.length || '';
  const rows = tplData.map((t, i) => `<tr>
    <td><button class="name-link" data-i="${i}">${esc(t.name || '(chưa đặt tên)')}</button></td>
    <td class="row-acts"><button class="row-del" data-i="${i}" title="Xóa">${TRASH_SVG}</button></td></tr>`).join('');
  body.innerHTML = `<button type="button" class="btn-ghost tpl-add-btn" style="margin-bottom:12px">+ Thêm mẫu</button>`
    + (tplData.length
      ? `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Tên mẫu</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty">Chưa có mẫu nào.</div>');
}
function openTplDetail(i) {
  const body = document.getElementById('tpl-modal-body');
  const t = tplData[i]; if (!t) return;
  body.innerHTML = detailBarHtml('Mẫu', '') + `
    <label class="detail-lbl">Tên mẫu</label>
    <input class="detail-title-input tpl-d-name" value="${esc(t.name || '')}" />
    <label class="detail-lbl" style="margin-top:14px">Nội dung (dùng {{...}} cho chỗ cần điền)</label>
    <textarea class="tpl-d-content" rows="10">${esc(t.content || '')}</textarea>
    <div class="form-actions">
      <button type="button" class="btn-primary tpl-d-save">Lưu mẫu</button>
      <span class="detail-saved" id="detail-saved"></span>
    </div>`;
  body.querySelector('.tpl-d-save').addEventListener('click', async () => {
    t.name = body.querySelector('.tpl-d-name').value.trim();
    t.content = body.querySelector('.tpl-d-content').value;
    const saved = document.getElementById('detail-saved');
    try { await saveTplArray(); saved.textContent = 'Đã lưu'; }
    catch (err) { saved.textContent = 'Lỗi: ' + err.message; }
  });
}

const tplModal = document.getElementById('tpl-modal');
document.getElementById('tpl-bar').addEventListener('click', async () => {
  tplModal.classList.remove('hidden');
  document.getElementById('tpl-modal-body').innerHTML = 'Đang tải…';
  try { tplData = (await api('/api/templates')).templates || []; renderTplList(); }
  catch (err) { document.getElementById('tpl-modal-body').innerHTML = '<div class="empty">Lỗi: ' + esc(err.message) + '</div>'; }
});
document.getElementById('tpl-close').addEventListener('click', () => tplModal.classList.add('hidden'));
tplModal.addEventListener('click', (e) => { if (e.target === tplModal) tplModal.classList.add('hidden'); });
document.getElementById('tpl-modal-body').addEventListener('click', async (e) => {
  const add = e.target.closest('.tpl-add-btn');
  const nameLink = e.target.closest('.name-link');
  const del = e.target.closest('.row-del');
  const back = e.target.closest('.detail-back');
  if (back) { renderTplList(); return; }
  if (add) { tplData.push({ name: '', content: '' }); try { await saveTplArray(); } catch {} openTplDetail(tplData.length - 1); return; }
  if (nameLink) { openTplDetail(+nameLink.dataset.i); return; }
  if (del) {
    if (!(await avtConfirm('Xóa mẫu này?'))) return;
    tplData.splice(+del.dataset.i, 1);
    try { await saveTplArray(); renderTplList(); } catch (err) { avtAlert('Lỗi: ' + err.message); }
  }
});
refreshTplCount();

// ===== Hướng dẫn lần đầu (tour) — engine dùng chung ở /tour.js =====
window.TOUR_KEY = 'avt-tour-admin-done';
window.TOUR_STEPS = [
  { sel: '.tabs', title: 'Các mục quản trị', text: 'Chuyển giữa "Nhập dữ liệu" và "Bộ luật & Mẫu".' },
  { sel: '#upload-bar', title: 'Tải file', text: 'Cách nhanh nhất. Bấm để mở, kéo thả Excel/CSV (mỗi dòng thành 1 bản ghi) hoặc PDF/Word/TXT (vào kho tri thức). Bấm vào tên file để xem trước và sửa nội dung trước khi lưu.', tab: 'manual' },
  { sel: '#fold-manual', title: 'Nhập tay', text: 'Khi không có sẵn file. Bấm mở, dán thẳng bảng từ Excel hoặc gõ "Tên trường: giá trị" — hệ thống tự tách trường, không phải điền từng ô.', tab: 'manual' },
  { sel: '#saved-bar', title: 'Dữ liệu đã lưu', text: 'Bấm để mở bảng: xem chi tiết, sửa tên/nội dung, hoặc xóa từng mục.', tab: 'manual' },
  { sel: '#fold-sensitive', title: 'Trường nhạy cảm', text: 'Khai báo một lần các cột cần giữ kín (VD: Giá vốn). Từ đó mọi file tải lên đều tự tách cột đó khỏi model đám mây.', tab: 'manual' },
  { sel: '#rules-text', title: 'Bộ luật', text: 'Đặt quy tắc áp cho MỌI câu trả lời của bot (trả lời ngắn gọn, không bịa…). Mỗi dòng một quy tắc, sửa xong bấm Lưu.', tab: 'config' },
  { sel: '#tpl-bar', title: 'Mẫu câu lệnh', text: 'Tạo/sửa các mẫu soạn sẵn để chèn nhanh khi chat. Bấm mở danh sách mẫu.', tab: 'config' },
  { sel: '.side-nav', title: 'Điều hướng', text: 'Quay lại trang trò chuyện với bot.' },
];
