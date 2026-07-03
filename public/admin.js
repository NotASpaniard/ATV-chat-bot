// Trang quản trị: nhập tay linh hoạt + tải file (Excel/CSV/PDF/Word/TXT) + xem dữ liệu & lịch sử.

// --- chuyển tab ---
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'chat') loadSessions();
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
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ===== THANH 1: NHẬP TAY LINH HOẠT =====
const manFields = document.getElementById('man-fields');
const manStatus = document.getElementById('man-status');

function addFieldRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <input class="f-key" placeholder="Tên trường (VD: Đơn giá)" value="${esc(key)}" />
    <input class="f-val" placeholder="Giá trị" value="${esc(val)}" />
    <button type="button" class="f-del" title="Xóa trường">✕</button>`;
  row.querySelector('.f-del').addEventListener('click', () => row.remove());
  manFields.appendChild(row);
}
// vài trường gợi ý sẵn
addFieldRow('Tên', '');
addFieldRow('Đơn giá', '');

document.getElementById('man-add').addEventListener('click', () => addFieldRow());

document.getElementById('man-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {};
  manFields.querySelectorAll('.field-row').forEach((r) => {
    const k = r.querySelector('.f-key').value.trim();
    const v = r.querySelector('.f-val').value.trim();
    if (k && v) data[k] = v;
  });
  if (!Object.keys(data).length) { setStatus(manStatus, 'Nhập ít nhất một trường có giá trị.', false); return; }
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  setStatus(manStatus, 'Đang lưu…', true);
  try {
    await api('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: document.getElementById('man-collection').value.trim(), data }),
    });
    setStatus(manStatus, 'Đã lưu bản ghi.', true);
    manFields.innerHTML = '';
    addFieldRow('Tên', ''); addFieldRow('Đơn giá', '');
    refreshSavedCount();
  } catch (err) {
    setStatus(manStatus, 'Lỗi: ' + err.message, false);
  } finally { btn.disabled = false; }
});

// ===== THANH 2: TẢI FILE (nhiều ô độc lập) =====
const MAX_UPLOAD_MB = 200;
const uploadCards = document.getElementById('upload-cards');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// luôn giữ đúng 1 ô trống ở cuối để thêm file mới
function ensureTrailingEmpty() {
  const hasEmpty = [...uploadCards.children].some((c) => c.dataset.hasFile !== '1');
  if (!hasEmpty) uploadCards.appendChild(makeUploadCard());
}

async function pollJob(jobId, onProgress) {
  while (true) {
    const j = await api('/api/jobs/' + jobId);
    if (j.status === 'running') { if (onProgress) onProgress(j.done, j.total); await sleep(700); continue; }
    if (j.status === 'error') throw new Error(j.error || 'Lỗi xử lý');
    return j.result;
  }
}

// Tạo 1 ô upload độc lập (có preview + nút lưu + tiến độ riêng)
function makeUploadCard() {
  const card = document.createElement('div');
  card.className = 'up-card';
  card.innerHTML = `
    <div class="up-head">
      <input type="file" class="up-file" accept=".xlsx,.xlsm,.csv,.pdf,.docx,.txt,.md" />
      <span class="up-status status"></span>
      <button class="up-remove icon-btn hidden" type="button" title="Xóa ô này">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>
    <div class="up-body"></div>
    <div class="up-progress progress hidden"><div class="bar"><div class="bar-fill"></div></div><span class="ptext"></span></div>`;

  const fileEl = card.querySelector('.up-file');
  const removeEl = card.querySelector('.up-remove');
  const statusEl = card.querySelector('.up-status');
  const bodyEl = card.querySelector('.up-body');
  const progEl = card.querySelector('.up-progress');
  const barEl = card.querySelector('.bar-fill');
  const ptextEl = card.querySelector('.ptext');
  let records = null;

  removeEl.addEventListener('click', () => { card.remove(); ensureTrailingEmpty(); });

  const prog = (done, total) => {
    progEl.classList.remove('hidden');
    const pct = total ? Math.round((done / total) * 100) : 0;
    barEl.style.width = pct + '%';
    ptextEl.textContent = total ? `Đang xử lý: ${done}/${total} (${pct}%)` : 'Đang chuẩn bị…';
  };
  const progHide = () => progEl.classList.add('hidden');
  // Tải xong -> thu gọn ô thành 1 dòng: tên file + đã tải lên thành công
  const finish = (okMsg) => {
    const fname = (fileEl.files && fileEl.files[0] && fileEl.files[0].name) || 'File';
    card.classList.add('done');
    card.innerHTML = `<div class="up-done-row">
      <svg class="up-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      <div class="up-done-info">
        <div class="up-done-name">${esc(fname)}</div>
        <div class="up-done-msg">${esc(okMsg || 'Đã tải lên thành công')}</div>
      </div>
      <button class="up-remove icon-btn" type="button" title="Xóa khỏi danh sách">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button></div>`;
    card.querySelector('.up-remove').addEventListener('click', () => { card.remove(); ensureTrailingEmpty(); });
    refreshSavedCount();
  };

  fileEl.addEventListener('change', async () => {
    const f = fileEl.files[0];
    if (!f) return;
    bodyEl.innerHTML = ''; records = null; progHide();
    // ô này bắt đầu có file -> hiện nút xóa + đảm bảo còn 1 ô trống bên dưới
    card.dataset.hasFile = '1';
    removeEl.classList.remove('hidden');
    ensureTrailingEmpty();
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setStatus(statusEl, `File quá lớn (${(f.size / 1048576).toFixed(0)}MB) — tối đa ${MAX_UPLOAD_MB}MB.`, false);
      return;
    }
    setStatus(statusEl, 'Đang tải lên & phân tích…', true);
    fileEl.disabled = true;
    try {
      const res = await api('/api/files/inspect', {
        method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f,
      });
      if (res.kind === 'spreadsheet') {
        records = res.records;
        if (!records.length) { setStatus(statusEl, 'Không tìm thấy dòng dữ liệu.', false); return; }
        renderSheet(res);
        setStatus(statusEl, `Đọc được ${res.total} dòng.`, true);
      } else {
        renderText(res);
        setStatus(statusEl, `Đã trích ${res.chars.toLocaleString('vi-VN')} ký tự.`, true);
      }
    } catch (err) {
      setStatus(statusEl, 'Lỗi: ' + err.message, false);
      fileEl.disabled = false;
    }
  });

  function renderSheet(res) {
    const cols = res.headers;
    let html = `<div class="chips">Nhóm: <span class="tag">${esc(res.collection)}</span> · `
      + cols.map((h) => `<span class="tag">${esc(h)}</span>`).join(' ') + `</div>`;
    html += `<div class="table-wrap"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
    for (const r of records.slice(0, 6)) {
      html += `<tr>${cols.map((c) => `<td>${esc(r.data[(c || '').trim()] || '')}</td>`).join('')}</tr>`;
    }
    html += `</table></div><button class="btn-primary up-save" type="button">Nhập ${res.total} bản ghi</button>`;
    bodyEl.innerHTML = html;
    bodyEl.querySelector('.up-save').addEventListener('click', saveSheet);
  }
  function renderText(res) {
    bodyEl.innerHTML = `
      <label>Tiêu đề</label>
      <input class="up-title" value="${esc(res.title)}" />
      <label>Nội dung trích được (có thể sửa trước khi lưu)</label>
      <textarea class="up-content" rows="8"></textarea>
      <button class="btn-primary up-save" type="button">Lưu vào tri thức</button>`;
    bodyEl.querySelector('.up-content').value = res.content;
    bodyEl.querySelector('.up-save').addEventListener('click', saveText);
  }

  async function saveSheet() {
    const btn = bodyEl.querySelector('.up-save'); btn.disabled = true;
    setStatus(statusEl, `Đang nhập ${records.length} bản ghi…`, true);
    try {
      const { jobId } = await api('/api/records/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }),
      });
      const result = await pollJob(jobId, prog); progHide();
      let msg = `Đã tải lên thành công · ${result.imported} bản ghi`;
      if (result.failed) msg += ` (${result.failed} lỗi)`;
      finish(msg);
    } catch (err) { progHide(); setStatus(statusEl, 'Lỗi: ' + err.message, false); btn.disabled = false; }
  }
  async function saveText() {
    const title = bodyEl.querySelector('.up-title').value.trim();
    const content = bodyEl.querySelector('.up-content').value;
    if (!title || !content.trim()) { setStatus(statusEl, 'Thiếu tiêu đề hoặc nội dung.', false); return; }
    const btn = bodyEl.querySelector('.up-save'); btn.disabled = true;
    setStatus(statusEl, 'Đang lưu & tạo embedding…', true);
    try {
      const { jobId } = await api('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }),
      });
      const result = await pollJob(jobId, prog); progHide();
      finish(`Đã tải lên thành công · ${(result && result.chunks) || 0} đoạn`);
    } catch (err) { progHide(); setStatus(statusEl, 'Lỗi: ' + err.message, false); btn.disabled = false; }
  }

  return card;
}

if (uploadCards) uploadCards.appendChild(makeUploadCard());

// ===== DỮ LIỆU ĐÃ LƯU (popup: danh sách + trang chi tiết) =====
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';

let savedRecs = [], savedDocs = [];

// --- Danh sách gọn: Tên | Loại (giữa) | Xóa ---
async function loadSavedData() {
  const body = document.getElementById('data-modal-body');
  body.innerHTML = 'Đang tải…';
  try {
    const [recs, docs] = await Promise.all([api('/api/records'), api('/api/documents')]);
    savedRecs = recs; savedDocs = docs;
    document.getElementById('saved-count').textContent = (recs.length + docs.length) || '';
    if (!recs.length && !docs.length) { body.innerHTML = '<div class="empty">Chưa có dữ liệu nào.</div>'; return; }
    const rows = [];
    for (const d of docs) rows.push(`<tr>
      <td><button class="name-link" data-kind="doc" data-id="${d.id}">${esc(d.title)}</button></td>
      <td class="col-type"><span class="type-tag">Tài liệu</span></td>
      <td class="row-acts"><button class="row-del" title="Xóa" data-kind="doc" data-id="${d.id}">${TRASH_SVG}</button></td></tr>`);
    for (const r of recs) rows.push(`<tr>
      <td><button class="name-link" data-kind="rec" data-id="${r.id}">${esc(r.collection || 'chung')}</button></td>
      <td class="col-type"><span class="type-tag rec">Bản ghi</span></td>
      <td class="row-acts"><button class="row-del" title="Xóa" data-kind="rec" data-id="${r.id}">${TRASH_SVG}</button></td></tr>`);
    body.innerHTML = `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Tên</th><th class="col-type">Loại</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  } catch (err) { body.innerHTML = '<div class="empty">Lỗi tải: ' + esc(err.message) + '</div>'; }
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
    <input class="detail-title-input" value="${esc(name)}" />
    <span class="detail-saved" id="detail-saved"></span>
    <div class="detail-content"><pre class="detail-text">${esc(doc.content || '(trống)')}</pre></div>`;
  const input = body.querySelector('.detail-title-input');
  const save = async () => {
    const nv = input.value.trim();
    if (!nv || nv === name) return;
    try {
      await api('/api/documents/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: nv }) });
      name = nv; document.getElementById('detail-saved').textContent = 'Đã lưu tên'; refreshSavedCount();
    } catch (err) { document.getElementById('detail-saved').textContent = 'Lỗi: ' + err.message; }
  };
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
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

// Cập nhật số đếm trên thanh (không mở popup)
async function refreshSavedCount() {
  try {
    const [recs, docs] = await Promise.all([api('/api/records'), api('/api/documents')]);
    document.getElementById('saved-count').textContent = (recs.length + docs.length) || '';
  } catch {}
}

// Mở/đóng popup + điều hướng
const dataModal = document.getElementById('data-modal');
document.getElementById('saved-bar').addEventListener('click', () => { dataModal.classList.remove('hidden'); loadSavedData(); });
document.getElementById('data-close').addEventListener('click', () => dataModal.classList.add('hidden'));
dataModal.addEventListener('click', (e) => { if (e.target === dataModal) dataModal.classList.add('hidden'); });
document.getElementById('data-modal-body').addEventListener('click', async (e) => {
  const nameLink = e.target.closest('.name-link');
  const del = e.target.closest('.row-del');
  const back = e.target.closest('.detail-back');
  if (back) { loadSavedData(); return; }
  if (nameLink) { openDetail(nameLink.dataset.kind, nameLink.dataset.id); return; }
  if (del) {
    if (!confirm('Xóa mục này?')) return;
    const url = (del.dataset.kind === 'doc' ? '/api/documents/' : '/api/records/') + del.dataset.id;
    try { await api(url, { method: 'DELETE' }); loadSavedData(); }
    catch (err) { alert('Lỗi xóa: ' + err.message); }
  }
});
refreshSavedCount();

// ===== LỊCH SỬ CHAT =====
async function loadSessions() {
  const el = document.getElementById('sess-list');
  try {
    const sessions = await api('/api/sessions');
    if (!sessions.length) { el.innerHTML = '<div class="empty">Chưa có phiên chat.</div>'; return; }
    el.innerHTML = sessions.map((s) => `
      <div class="data-item" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div>${esc(s.title || '(không tiêu đề)')}</div>
            <div class="meta">${s.msg_count} tin nhắn${s.last_at ? ' · ' + new Date(s.last_at).toLocaleString('vi-VN') : ''}</div>
          </div>
          <button class="del" style="color:var(--accent)" data-sid="${esc(s.id)}">Xem</button>
        </div>
        <div class="chat-log hidden" id="log-${esc(s.id)}"></div>
      </div>`).join('');
  } catch (err) { el.innerHTML = '<div class="empty">Lỗi tải: ' + esc(err.message) + '</div>'; }
}

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
    if (!confirm('Xóa mẫu này?')) return;
    tplData.splice(+del.dataset.i, 1);
    try { await saveTplArray(); renderTplList(); } catch (err) { alert('Lỗi: ' + err.message); }
  }
});
refreshTplCount();

// ===== xử lý chung: xem / xóa =====
document.addEventListener('click', async (e) => {
  const del = e.target.closest('.del');
  if (!del) return;

  if (del.dataset.sid) {
    const log = document.getElementById('log-' + del.dataset.sid);
    if (!log.classList.contains('hidden')) { log.classList.add('hidden'); return; }
    log.classList.remove('hidden'); log.textContent = 'Đang tải…';
    try {
      const msgs = await api('/api/sessions/' + encodeURIComponent(del.dataset.sid));
      log.innerHTML = msgs.map((m) =>
        `<div class="${m.role === 'user' ? 'u' : 'a'}"><b>${m.role === 'user' ? 'Người dùng' : 'Bot'}:</b> ${esc(m.content)}</div>`
      ).join('<br>');
    } catch (err) { log.textContent = 'Lỗi: ' + err.message; }
  }
});
