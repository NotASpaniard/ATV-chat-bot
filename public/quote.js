// Trang BÁO GIÁ: gõ yêu cầu -> soát ứng viên -> chọn form -> dựng bảng.
// Mọi phép tính tiền do server làm; cột nhạy cảm server đọc thẳng DB, không qua model đám mây.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtVnd = (n) => Number(n).toLocaleString('vi-VN');

async function api(url, opts) {
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const t = ct.includes('json') ? (await r.json().catch(() => ({}))).error : await r.text().catch(() => '');
    throw new Error(t || `Lỗi ${r.status}`);
  }
  return ct.includes('json') ? r.json() : r.text();
}
function setStatus(el, msg, ok = true) {
  el.textContent = msg || '';
  el.style.color = ok ? 'var(--text-muted)' : 'var(--danger)';
}

// ===== Trạng thái của một phiếu báo giá đang dựng =====
let candidates = [];   // kết quả tìm được, chờ người dùng soát
let picked = new Map(); // key "kind:id" -> số lượng
let forms = [];
let built = null;      // bảng đã dựng

// ---------- BƯỚC 1: tìm ----------
$('q-find').addEventListener('click', async () => {
  const requirement = $('q-req').value.trim();
  const st = $('q-find-status');
  if (!requirement) { setStatus(st, 'Hãy mô tả thứ cần báo giá.', false); return; }
  $('q-find').disabled = true;
  setStatus(st, 'Đang tìm trong dữ liệu nội bộ…');
  try {
    const r = await api('/api/quote/find', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement }),
    });
    candidates = r.items || [];
    if (r.warning) { setStatus(st, r.warning, false); }
    else if (!candidates.length) {
      setStatus(st, 'Không tìm thấy gì khớp. Kiểm tra lại tên sản phẩm, hoặc nạp dữ liệu ở Quản trị dữ liệu.', false);
    } else setStatus(st, `Tìm được ${candidates.length} mục — soát lại ở bước 2.`);

    // Chỉ tick sẵn thứ khớp CHẮC CHẮN (khớp mã/từ khóa, điểm >= 0.85). Thứ chỉ gần giống
    // để người dùng tự tick — tránh lặng lẽ đưa nhầm sản phẩm vào báo giá.
    picked = new Map();
    candidates.forEach((c) => {
      if (c.kind === 'record' && Number(c.score) >= 0.85) picked.set(key(c), guessQty(requirement, c.title));
    });
    renderCandidates();
    $('step-check').classList.toggle('hidden', !candidates.length);
    if (candidates.length) $('step-check').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus(st, 'Lỗi: ' + e.message, false);
  } finally { $('q-find').disabled = false; }
});

const key = (c) => c.kind + ':' + c.id;

// Tìm số đứng ngay trước tên sản phẩm trong câu mô tả để điền sẵn số lượng.
// Chỉ là gợi ý — người dùng sửa được ở bước soát.
function guessQty(text, title) {
  const words = String(title || '').split(/\s+/).filter((w) => w.length > 2).slice(0, 3);
  for (const w of words) {
    const re = new RegExp('(\\d{1,4})\\s*(?:[a-zA-ZÀ-ỹ]*\\s+){0,3}' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const m = String(text).match(re);
    if (m) { const n = Number(m[1]); if (n >= 1 && n <= 10000) return n; }
  }
  return 1;
}

function renderCandidates() {
  $('q-cands').innerHTML = candidates.map((c) => {
    const k = key(c);
    const on = picked.has(k);
    const detail = c.kind === 'record'
      ? Object.entries(c.fields || {}).slice(0, 4).map(([a, b]) => `${esc(a)}: ${esc(b)}`).join(' · ')
      : esc(String(c.snippet || '').replace(/\s+/g, ' ').slice(0, 120)) + '…';
    return `<div class="q-cand${on ? ' on' : ''}" data-k="${esc(k)}">
      <label class="q-tick"><input type="checkbox" ${on ? 'checked' : ''} /></label>
      <div class="q-cand-main">
        <div class="q-cand-name">${esc(c.title)}
          <span class="q-tag${c.kind === 'document' ? ' doc' : ''}">${c.kind === 'document' ? 'Tài liệu' : esc(c.group || 'Bản ghi')}</span>
        </div>
        <div class="q-cand-sub">${detail}</div>
      </div>
      <div class="q-qty"><span>SL</span><input type="number" min="1" max="10000" value="${on ? picked.get(k) : 1}" ${on ? '' : 'disabled'} /></div>
    </div>`;
  }).join('');
}

$('q-cands').addEventListener('change', (e) => {
  const row = e.target.closest('.q-cand');
  if (!row) return;
  const k = row.dataset.k;
  if (e.target.type === 'checkbox') {
    if (e.target.checked) picked.set(k, Number(row.querySelector('.q-qty input').value) || 1);
    else picked.delete(k);
    row.classList.toggle('on', e.target.checked);
    row.querySelector('.q-qty input').disabled = !e.target.checked;
  } else if (e.target.type === 'number' && picked.has(k)) {
    picked.set(k, Math.max(1, Number(e.target.value) || 1));
  }
});

// ---------- Form trình bày ----------
async function loadForms() {
  try { forms = (await api('/api/quote/forms')).forms || []; } catch { forms = []; }
  $('q-form').innerHTML = forms.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
}
const currentForm = () => forms.find((f) => f.id === $('q-form').value) || forms[0];

$('q-form-edit').addEventListener('click', () => {
  const f = currentForm();
  if (!f) return;
  $('form-name').value = f.name;
  $('form-cols').value = f.columns.join('\n');
  setStatus($('form-status'), '');
  $('form-modal').classList.remove('hidden');
});
const hideForm = () => $('form-modal').classList.add('hidden');
$('form-close').addEventListener('click', hideForm);
$('form-modal').addEventListener('click', (e) => { if (e.target === $('form-modal')) hideForm(); });
$('form-save').addEventListener('click', async () => {
  const f = currentForm();
  if (!f) return;
  const cols = $('form-cols').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!cols.length) { setStatus($('form-status'), 'Cần ít nhất một cột.', false); return; }
  f.name = $('form-name').value.trim() || f.name;
  f.columns = cols;
  setStatus($('form-status'), 'Đang lưu…');
  try {
    await api('/api/quote/forms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forms }),
    });
    await loadForms();
    $('q-form').value = f.id;
    hideForm();
  } catch (e) { setStatus($('form-status'), 'Lỗi: ' + e.message, false); }
});

// ---------- BƯỚC 2 -> 3: dựng bảng ----------
$('q-build').addEventListener('click', async () => {
  const st = $('q-build-status');
  if (!picked.size) { setStatus(st, 'Hãy tick ít nhất một mục.', false); return; }
  const f = currentForm();
  const items = [...picked.entries()].map(([k, qty]) => {
    const c = candidates.find((x) => key(x) === k);
    return { kind: c.kind, id: c.id, title: c.title, qty };
  });
  $('q-build').disabled = true;
  setStatus(st, 'Đang dựng bảng…');
  try {
    built = await api('/api/quote/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, columns: f ? f.columns : null, customer: $('q-customer').value.trim() }),
    });
    renderTable();
    setStatus(st, '');
    $('step-table').classList.remove('hidden');
    $('step-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus(st, 'Lỗi: ' + e.message, false);
  } finally { $('q-build').disabled = false; }
});

// Chuẩn hóa tên cột để so khớp: hạ chữ thường TRƯỚC rồi mới thay đ->d,
// nếu không thì "Đơn giá" (Đ hoa) không khớp được với "don gia".
const normCol = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

// Cột tiền thì canh phải + định dạng nghìn
const isMoney = (col) => /(don gia|thanh tien|gia|tong)/.test(normCol(col));

function renderTable() {
  const b = built;
  const sen = new Set(b.sensitiveColumns || []);
  const head = b.columns.map((c) =>
    `<th class="${isMoney(c) ? 'num' : ''}${sen.has(c) ? ' sen' : ''}">${esc(c)}${sen.has(c) ? ' <span class="lock" title="Cột nhạy cảm — không gửi cho model đám mây">&#128274;</span>' : ''}</th>`).join('');
  const body = b.rows.map((r, ri) => '<tr>' + b.columns.map((c) => {
    const v = r.cells[c];
    const cls = (isMoney(c) ? 'num ' : '') + (sen.has(c) ? 'sen ' : '') + (v == null || v === '' ? 'blank' : '');
    const txt = v == null || v === '' ? '—' : (isMoney(c) && !isNaN(Number(v)) ? fmtVnd(v) : v);
    return `<td class="${cls.trim()}" contenteditable="true" data-r="${ri}" data-c="${esc(c)}">${esc(txt)}</td>`;
  }).join('') + '</tr>').join('');

  const totalRow = Object.keys(b.totals || {}).length
    ? '<tr class="q-total">' + b.columns.map((c, i) => {
        if (b.totals[c] != null) return `<td class="num" data-total="${esc(c)}">${fmtVnd(b.totals[c])}</td>`;
        return i === 0 ? '<td><b>Tổng cộng</b></td>' : '<td></td>';
      }).join('') + '</tr>'
    : '';

  $('q-table').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}${totalRow}</tbody>`;
  const warn = $('q-warn');
  if ((b.notes || []).length) { warn.innerHTML = b.notes.map(esc).join('<br>'); warn.classList.remove('hidden'); }
  else warn.classList.add('hidden');
}

// Sửa tay ngay trên bảng. Tính lại NGAY lúc gõ, nhưng chỉ ghi đè ô thành tiền + ô tổng
// chứ không vẽ lại cả bảng — vẽ lại sẽ làm mất con trỏ đang gõ.
const num = (v) => Number(String(v == null ? '' : v).replace(/[^\d]/g, '')) || 0;
const findCol = (re) => built && built.columns.find((c) => re.test(normCol(c)));

$('q-table').addEventListener('input', (e) => {
  const td = e.target.closest('td[contenteditable]');
  if (!td || !built) return;
  built.rows[Number(td.dataset.r)].cells[td.dataset.c] = td.textContent.trim();
  recalc(td);
});

function recalc(editing) {
  if (!built) return;
  const priceCol = findCol(/don gia|gia ban/);
  const qtyCol = findCol(/so luong/);
  const totalCol = findCol(/thanh tien/);
  if (!totalCol) return;

  built.rows.forEach((r, ri) => {
    if (priceCol && qtyCol) r.cells[totalCol] = num(r.cells[priceCol]) * num(r.cells[qtyCol]);
    const cell = $('q-table').querySelector(`td[data-r="${ri}"][data-c="${CSS.escape(totalCol)}"]`);
    if (cell && cell !== editing) cell.textContent = fmtVnd(r.cells[totalCol]);
  });
  built.totals[totalCol] = built.rows.reduce((s, r) => s + num(r.cells[totalCol]), 0);
  const trow = $('q-table').querySelector(`tr.q-total td[data-total="${CSS.escape(totalCol)}"]`);
  if (trow) trow.textContent = fmtVnd(built.totals[totalCol]);
}

// ---------- Xuất ----------
function tableToMarkdown() {
  const b = built;
  let out = '';
  if (b.customer) out += `**Khách hàng:** ${b.customer}\n\n`;
  out += '| ' + b.columns.join(' | ') + ' |\n';
  out += '|' + b.columns.map(() => '---').join('|') + '|\n';
  for (const r of b.rows) {
    out += '| ' + b.columns.map((c) => {
      const v = r.cells[c];
      return v == null || v === '' ? '' : (isMoney(c) && !isNaN(Number(v)) ? fmtVnd(v) : v);
    }).join(' | ') + ' |\n';
  }
  for (const [c, v] of Object.entries(b.totals || {})) {
    out += '| **Tổng cộng** ' + b.columns.slice(1).map((x) => (x === c ? `| **${fmtVnd(v)}**` : '| ')).join('') + ' |\n';
  }
  return out;
}
$('q-copy').addEventListener('click', async () => {
  if (!built) return;
  try { await navigator.clipboard.writeText(tableToMarkdown()); setStatus($('q-out-status'), 'Đã sao chép.'); }
  catch { setStatus($('q-out-status'), 'Trình duyệt chặn sao chép.', false); }
});
$('q-xlsx').addEventListener('click', async () => {
  if (!built) return;
  setStatus($('q-out-status'), 'Đang tạo file…');
  try {
    const r = await fetch('/api/export/xlsx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: tableToMarkdown(), title: 'BaoGia' }),
    });
    if (!r.ok) throw new Error('Lỗi ' + r.status);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'BaoGia.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus($('q-out-status'), 'Đã tải file.');
  } catch (e) { setStatus($('q-out-status'), 'Lỗi: ' + e.message, false); }
});

// ---------- Báo giá mới ----------
$('new-quote').addEventListener('click', () => {
  candidates = []; picked = new Map(); built = null;
  $('q-req').value = ''; $('q-customer').value = '';
  $('step-check').classList.add('hidden');
  $('step-table').classList.add('hidden');
  setStatus($('q-find-status'), '');
  $('q-req').focus();
});

// ---------- Ô hỏi nhanh (chat gọn) ----------
$('q-chat-toggle').addEventListener('click', () => {
  const body = $('q-chat-body');
  body.classList.toggle('hidden');
  $('q-chat-toggle').classList.toggle('open', !body.classList.contains('hidden'));
  if (!body.classList.contains('hidden')) $('q-chat-input').focus();
});
$('q-chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q-chat-input').value.trim();
  if (!q) return;
  $('q-chat-input').value = '';
  const log = $('q-chat-log');
  log.insertAdjacentHTML('beforeend', `<div class="qa-me">${esc(q)}</div>`);
  const bot = document.createElement('div');
  bot.className = 'qa-bot';
  bot.textContent = 'Đang tra…';
  log.appendChild(bot);
  log.scrollTop = log.scrollHeight;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: q }], sessionId: 'quote-ask' }),
    });
    if (!r.ok) { bot.textContent = await r.text().catch(() => 'Lỗi ' + r.status); return; }
    bot.textContent = '';
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bot.textContent += dec.decode(value, { stream: true });
      log.scrollTop = log.scrollHeight;
    }
  } catch (err) { bot.textContent = 'Lỗi: ' + err.message; }
});

// ---------- Model đang dùng + trạng thái ----------
(async () => {
  try {
    const c = await api('/api/config');
    $('model-tag').textContent = c.model;
    $('model-tag').title = /^gemini/i.test(c.model)
      ? 'Đang dùng model đám mây — cột nhạy cảm vẫn chỉ lấy từ dữ liệu nội bộ'
      : 'Đang dùng model chạy trên máy';
  } catch { $('model-tag').textContent = '—'; }
})();
$('status-btn').addEventListener('click', async () => {
  $('status-modal').classList.remove('hidden');
  const body = $('status-modal-body');
  body.textContent = 'Đang tải…';
  try {
    const s = await api('/api/status');
    body.innerHTML = Object.entries(s).map(([k, v]) =>
      `<div class="stat-row"><span>${esc(k)}</span><b>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</b></div>`).join('');
  } catch (e) { body.textContent = 'Lỗi: ' + e.message; }
});
$('status-close').addEventListener('click', () => $('status-modal').classList.add('hidden'));
$('status-modal').addEventListener('click', (e) => { if (e.target === $('status-modal')) $('status-modal').classList.add('hidden'); });

loadForms();

// ---------- Hướng dẫn lần đầu ----------
window.TOUR_KEY = 'avt-tour-quote-done';
window.TOUR_STEPS = [
  { sel: '#step-ask', title: 'Mô tả cần báo giá gì', text: 'Gõ bằng lời thường: số lượng, loại thiết bị, yêu cầu kỹ thuật. Hoặc gọi thẳng tên model nếu đã biết.' },
  { sel: '#step-check', title: 'Soát lại trước khi dựng', text: 'Hệ thống hiện những gì nó tìm được trong dữ liệu của bạn. Bỏ tick thứ không đúng, sửa số lượng. Bước này chặn việc lấy nhầm sản phẩm.' },
  { sel: '#q-form', title: 'Form trình bày', text: 'Chọn bộ cột cho bảng. Bấm "Sửa cột" để tự đặt cột theo ý bạn — thêm Bảo hành, Xuất xứ, Ghi chú…' },
  { sel: '#step-chat', title: 'Hỏi nhanh', text: 'Cần tra thêm chi tiết trong tài liệu (thông số, chuẩn nén…) thì hỏi ở đây, không phải rời trang.' },
  { sel: '#model-tag', title: 'Model đang dùng', text: 'Model đám mây chạy nhanh nhưng không bao giờ thấy các cột bạn đánh dấu nhạy cảm — những cột đó server đọc thẳng từ dữ liệu nội bộ.' },
];
