// AVT Chat Bot — giao diện chat.
// Nhiều cuộc hội thoại (chọn/tạo/xóa) ở sidebar, lưu theo phiên trong DB.
// Cờ "ghi nhớ xuyên hội thoại" (localStorage 'avt-memory') gửi kèm mỗi request.

const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const clearBtn = document.getElementById('clear-btn');
const modelTag = document.getElementById('model-tag');
const convoListEl = document.getElementById('convo-list');

const SESSION_KEY = 'avt-session-id';
let sessionId = getSessionId();
let history = [];
let busy = false;

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || 's-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}
function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) { id = newId(); localStorage.setItem(SESSION_KEY, id); }
  return id;
}
function memoryOn() { return localStorage.getItem('avt-memory') === '1'; }

// chế độ tư vấn báo giá tối ưu
let adviseMode = false;
const adviseToggle = document.getElementById('advise-toggle');
adviseToggle.addEventListener('click', () => {
  adviseMode = !adviseMode;
  adviseToggle.classList.toggle('active', adviseMode);
  input.placeholder = adviseMode
    ? 'Mô tả yêu cầu + số lượng (VD: cần 50 camera cho kho, ưu tiên giá rẻ, có nhìn đêm)…'
    : 'Nhập câu hỏi… (Enter để gửi, Shift+Enter xuống dòng)';
  input.focus();
});

// --- tìm kiếm lịch sử & tài liệu ---
const convoSearch = document.getElementById('convo-search');
let searchTimer;
convoSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = convoSearch.value.trim();
  if (!q) { loadConvos(); return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
      renderSearch(r, q);
    } catch {}
  }, 300);
});
function renderSearch(r, q) {
  let html = '';
  const seen = new Set();
  const chats = (r.chats || []).filter((c) => { if (seen.has(c.session_id)) return false; seen.add(c.session_id); return true; });
  if (chats.length) {
    html += '<div class="convo-head">Hội thoại</div>';
    html += chats.map((c) => `<div class="convo-item" data-sid="${esc(c.session_id)}"><svg class="convo-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="convo-title">${esc(c.title || 'Cuộc trò chuyện')}</span></div>`).join('');
  }
  const dr = [...(r.docs || []).map((d) => 'Tài liệu: ' + d.title), ...(r.recs || []).map((x) => 'Bản ghi: ' + (x.collection || ''))];
  if (dr.length) {
    html += '<div class="convo-head">Tài liệu / Dữ liệu</div>';
    html += dr.map((t) => `<div class="search-doc">${esc(t)}</div>`).join('');
  }
  if (!html) html = `<div class="convo-empty">Không thấy kết quả cho "${esc(q)}"</div>`;
  convoListEl.innerHTML = html;
}

// --- menu mẫu câu lệnh ---
const tplBtn = document.getElementById('tpl-btn');
tplBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const existing = document.getElementById('tpl-menu');
  if (existing) { existing.remove(); return; }
  let tpls = [];
  try { tpls = (await (await fetch('/api/templates')).json()).templates || []; } catch {}
  const menu = document.createElement('div');
  menu.id = 'tpl-menu'; menu.className = 'tpl-menu';
  menu.innerHTML = tpls.length
    ? tpls.map((t, i) => `<button type="button" data-i="${i}">${esc(t.name)}</button>`).join('')
    : '<div class="tpl-empty">Chưa có mẫu. Thêm ở Quản trị → Mẫu.</div>';
  document.body.appendChild(menu);
  const rect = tplBtn.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    input.value = tpls[+b.dataset.i].content;
    input.dispatchEvent(new Event('input')); input.focus();
    menu.remove();
  });
  setTimeout(() => document.addEventListener('click', function h() { const m = document.getElementById('tpl-menu'); if (m) m.remove(); document.removeEventListener('click', h); }, { once: true }), 0);
});

// --- popup cài đặt model (chọn / tải / xóa) gắn vào nút model ---
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
modelTag.addEventListener('click', (e) => { e.stopPropagation(); toggleModelPanel(); });
function toggleModelPanel() {
  const ex = document.getElementById('model-panel'); if (ex) { ex.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'model-panel'; panel.className = 'model-panel';
  panel.innerHTML = `
    <div class="mp-title">Model AI</div>
    <div class="mp-sub">Đang có trên máy</div>
    <div id="mp-list" class="mp-list">Đang tải…</div>
    <div class="mp-sub">Tải thêm (bấm để tải)</div>
    <div id="mp-catalog" class="mp-list"></div>
    <div id="mp-progress" class="mp-progress"></div>`;
  document.body.appendChild(panel);
  const r = modelTag.getBoundingClientRect();
  panel.style.left = Math.max(10, r.left) + 'px';
  panel.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.querySelector('#mp-list').addEventListener('click', onMpListClick);
  panel.querySelector('#mp-catalog').addEventListener('click', (e) => { const g = e.target.closest('.mp-get'); if (g) mpGet(g.dataset.m); });
  loadMpList();
  setTimeout(() => document.addEventListener('click', closeMp), 0);
}
// Danh sách model gợi ý để tải (cho người không rành gõ tên)
const MODEL_CATALOG = [
  { name: 'qwen2.5:3b', note: 'Nhẹ, nhanh — hợp máy yếu / chạy CPU', size: '~1.9GB' },
  { name: 'qwen2.5:7b', note: 'Cân bằng, thông minh hơn', size: '~4.7GB' },
  { name: 'qwen2.5:14b', note: 'Rất thông minh — cần máy mạnh / GPU', size: '~9GB' },
  { name: 'llama3.1:8b', note: 'Đa năng, tiếng Việt khá', size: '~4.9GB' },
  { name: 'gemma2:9b', note: 'Google, chất lượng tốt', size: '~5.4GB' },
  { name: 'bge-m3', note: 'Embedding tiếng Việt (cho RAG)', size: '~1.2GB' },
];
const DL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
function closeMp() { const p = document.getElementById('model-panel'); if (p) p.remove(); document.removeEventListener('click', closeMp); }
async function loadMpList() {
  const listEl = document.getElementById('mp-list');
  const catEl = document.getElementById('mp-catalog');
  if (!listEl) return;
  let installed = [], active = '', failed = false;
  try {
    const d = await (await fetch('/api/models')).json();
    if (d.error) failed = true; else { installed = d.models || []; active = d.active; }
  } catch { failed = true; }

  if (failed) listEl.innerHTML = '<div class="mp-empty">Không gọi được Ollama</div>';
  else if (!installed.length) listEl.innerHTML = '<div class="mp-empty">Chưa có model nào.</div>';
  else listEl.innerHTML = installed.map((m) => `
    <div class="mp-item${m.name === active ? ' active' : ''}" data-m="${esc(m.name)}">
      <span class="mp-dot"></span>
      <span class="mp-name">${esc(m.name)}</span>
      <span class="mp-size">${(m.size / 1073741824).toFixed(1)}GB</span>
      <button class="mp-del" type="button" data-m="${esc(m.name)}" title="Xóa model">${TRASH_SVG}</button>
    </div>`).join('');

  if (catEl) {
    const has = new Set(installed.map((m) => m.name));
    const avail = MODEL_CATALOG.filter((c) => !has.has(c.name) && !has.has(c.name + ':latest'));
    catEl.innerHTML = avail.length ? avail.map((c) => `
      <div class="mp-cat">
        <div class="mp-cat-info">
          <div class="mp-cat-name">${esc(c.name)}</div>
          <div class="mp-cat-note">${esc(c.note)} · ${c.size}</div>
        </div>
        <button class="mp-get" type="button" data-m="${esc(c.name)}" title="Tải về">${DL_SVG}</button>
      </div>`).join('') : '<div class="mp-empty">Đã có đủ model gợi ý.</div>';
  }
}
async function onMpListClick(e) {
  const del = e.target.closest('.mp-del');
  const item = e.target.closest('.mp-item');
  if (del) {
    e.stopPropagation();
    if (!confirm('Xóa model ' + del.dataset.m + '? (giải phóng ổ đĩa)')) return;
    try { await fetch('/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: del.dataset.m }) }); loadMpList(); } catch {}
    return;
  }
  if (item) {
    try {
      await fetch('/api/models/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.dataset.m }) });
      modelTag.textContent = item.dataset.m;
      loadMpList();
    } catch {}
  }
}
async function mpGet(name) {
  if (!name) return;
  const prog = document.getElementById('mp-progress');
  const btn = document.querySelector(`.mp-get[data-m="${name}"]`);
  if (btn) btn.disabled = true;
  prog.textContent = 'Đang tải ' + name + '… (lần đầu có thể vài phút)';
  try {
    const res = await fetch('/api/models/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { const o = JSON.parse(ln); if (o.error) prog.textContent = 'Lỗi: ' + o.error; else if (o.status) { let s = o.status; if (o.total && o.completed) s += ' — ' + Math.round(o.completed / o.total * 100) + '%'; prog.textContent = s; } } catch {}
      }
    }
    prog.textContent = 'Đã tải xong: ' + name;
    loadMpList();
  } catch (err) { prog.textContent = 'Lỗi: ' + err.message; if (btn) btn.disabled = false; }
}

// --- cảnh báo tài nguyên ---
async function checkResources() {
  try {
    const s = await (await fetch('/api/status')).json();
    const w = document.getElementById('res-warning');
    const msgs = [];
    if (s.ram && s.ram.usedPct >= 90) msgs.push('RAM gần đầy (' + s.ram.usedPct + '%)');
    if (s.disk && s.disk.freePct <= 8) msgs.push('Ổ đĩa còn ít (' + s.disk.freePct + '% trống)');
    if (msgs.length) { w.textContent = 'Cảnh báo: ' + msgs.join(' · '); w.classList.remove('hidden'); }
    else w.classList.add('hidden');
  } catch {}
}

// --- khởi tạo ---
init();
async function init() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.model) modelTag.textContent = cfg.model;
  } catch { modelTag.textContent = 'offline?'; }

  await loadConversation(sessionId);
  loadConvos();
  checkResources();
  setInterval(checkResources, 60000);
}

// --- danh sách cuộc hội thoại (sidebar) ---
async function loadConvos() {
  try {
    const sessions = await (await fetch('/api/sessions')).json();
    renderConvos(sessions);
  } catch { convoListEl.innerHTML = '<div class="convo-empty">Chưa có cuộc nào</div>'; }
}
function renderConvos(sessions) {
  if (!sessions.length) { convoListEl.innerHTML = '<div class="convo-empty">Chưa có cuộc nào</div>'; return; }
  convoListEl.innerHTML = sessions.map((s) => `
    <div class="convo-item${s.id === sessionId ? ' active' : ''}" data-sid="${esc(s.id)}">
      <svg class="convo-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="convo-title">${esc(s.title || 'Cuộc trò chuyện')}</span>
      <button class="convo-del" data-sid="${esc(s.id)}" title="Xóa cuộc này">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>`).join('');
}

convoListEl.addEventListener('click', async (e) => {
  const del = e.target.closest('.convo-del');
  if (del) {
    e.stopPropagation();
    if (!confirm('Xóa cuộc hội thoại này?')) return;
    const id = del.dataset.sid;
    try { await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }); } catch {}
    if (id === sessionId) startNewConversation();
    loadConvos();
    return;
  }
  const item = e.target.closest('.convo-item');
  if (item && !busy) {
    sessionId = item.dataset.sid;
    localStorage.setItem(SESSION_KEY, sessionId);
    loadConversation(sessionId);
    document.querySelectorAll('.convo-item').forEach((x) => x.classList.toggle('active', x.dataset.sid === sessionId));
  }
});

async function loadConversation(id) {
  history = [];
  messagesEl.innerHTML = '';
  try {
    const msgs = await (await fetch('/api/sessions/' + encodeURIComponent(id))).json();
    if (Array.isArray(msgs) && msgs.length) {
      history = msgs.map((m) => ({ role: m.role, content: m.content }));
      for (const m of history) {
        const b = addBubble(m.role === 'user' ? 'user' : 'bot', m.content);
        if (m.role !== 'user' && m.content.trim()) { b.innerHTML = renderMd(m.content); b.appendChild(botActions(m.content)); }
      }
      scrollToBottom();
      return;
    }
  } catch {}
  showWelcome();
}

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="w-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>
      </div>
      <h1>Xin chào</h1>
      <p>Trợ lý AI nội bộ, chạy hoàn toàn trên máy chủ của doanh nghiệp. Hãy đặt câu hỏi bên dưới.</p>
    </div>`;
}

function startNewConversation() {
  sessionId = newId();
  localStorage.setItem(SESSION_KEY, sessionId);
  history = [];
  showWelcome();
  document.querySelectorAll('.convo-item').forEach((x) => x.classList.remove('active'));
}

clearBtn.addEventListener('click', () => { if (!busy) startNewConversation(); });

// --- gửi tin ---
form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

async function send() {
  if (busy) return;
  const text = input.value.trim();
  if (!text) return;

  const wasEmpty = history.length === 0;
  clearWelcome();
  input.value = '';
  input.style.height = 'auto';

  addBubble('user', text);
  history.push({ role: 'user', content: text });

  const botBubble = addBubble('bot', '', { thinking: true });
  setBusy(true);
  scrollToBottom();

  try {
    const res = adviseMode
      ? await fetch('/api/advise', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requirement: text, sessionId }),
        })
      : await fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, sessionId, memory: memoryOn() }),
        });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      showError(botBubble, `Lỗi máy chủ (${res.status}). ${errText}`);
      history.pop();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      botBubble.textContent = acc;
      scrollToBottom();
    }
    if (acc.trim()) {
      history.push({ role: 'assistant', content: acc });
      botBubble.innerHTML = renderMd(acc); // đổi từ text thô sang bảng/định dạng thật
      botBubble.appendChild(botActions(acc));
      if (wasEmpty) loadConvos(); // cuộc mới -> cập nhật danh sách + tiêu đề
    } else {
      showError(botBubble, 'Model không trả về nội dung.');
    }
  } catch (err) {
    showError(botBubble, 'Không kết nối được máy chủ: ' + err.message);
  } finally {
    setBusy(false);
    input.focus();
  }
}

// --- tiện ích UI ---
const AVATAR_SVG = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z"/></svg>',
};
function addBubble(who, text, opts = {}) {
  const row = document.createElement('div');
  row.className = 'msg ' + who;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  // Avatar bot = icon con vật theo theme (hổ/bạch tuộc/vẹt); user giữ icon người.
  avatar.innerHTML = who === 'bot'
    ? ((window.AVTTheme && window.AVTTheme.animal) ? window.AVTTheme.animal() : AVATAR_SVG.bot)
    : (AVATAR_SVG[who] || AVATAR_SVG.bot);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (opts.thinking) bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  else bubble.textContent = text;
  row.appendChild(avatar);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  return bubble;
}
// ---- Xuất file (Word / Excel / PDF) ----
function esc2(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function mdToHtml(md) {
  const lines = (md || '').split('\n');
  let html = '', i = 0;
  const inline = (s) => esc2(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      html += '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse">';
      rows.forEach((r, ri) => {
        html += '<tr>' + r.map((c) => (ri === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('') + '</tr>';
      });
      html += '</table>';
    } else {
      if (t) html += `<p>${inline(t)}</p>`;
      i++;
    }
  }
  return html;
}
// Render markdown để HIỂN THỊ trên màn hình (bảng thật + tiêu đề + danh sách), style theo theme qua CSS.
function mdInline(s) {
  return esc2(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
}
function renderMd(md) {
  const lines = (md || '').split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    // Bảng
    if (t.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        html += '<div class="md-tablewrap"><table class="md-table"><thead><tr>' +
          rows[0].map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>';
        for (let r = 1; r < rows.length; r++)
          html += '<tr>' + rows[r].map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>';
        html += '</tbody></table></div>';
      }
      continue;
    }
    // Tiêu đề (# -> h3)
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      const lvl = Math.min(m[1].length + 2, 6);
      html += `<h${lvl} class="md-h">${mdInline(m[2])}</h${lvl}>`;
      i++; continue;
    }
    // Trích dẫn / cảnh báo
    if (t.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      html += `<blockquote class="md-quote">${buf.map(mdInline).join('<br>')}</blockquote>`;
      continue;
    }
    // Danh sách
    if (/^[-*]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*]\s+/, '')); i++; }
      html += '<ul class="md-ul">' + items.map((x) => `<li>${mdInline(x)}</li>`).join('') + '</ul>';
      continue;
    }
    // Đoạn văn (gộp các dòng liền nhau)
    const buf = [];
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s || s.startsWith('|') || s.startsWith('>') || /^[-*]\s+/.test(s) || /^#{1,4}\s+/.test(s)) break;
      buf.push(s); i++;
    }
    html += `<p>${buf.map(mdInline).join('<br>')}</p>`;
  }
  return html;
}
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportDoc(text) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>${mdToHtml(text)}</body></html>`;
  download(new Blob(['﻿' + html], { type: 'application/msword' }), 'ket-qua.doc');
}
function exportPdf(text) {
  const w = window.open('', '_blank');
  if (!w) { alert('Trình duyệt chặn cửa sổ in. Cho phép popup rồi thử lại.'); return; }
  w.document.write(`<html><head><meta charset="utf-8"><title>ket-qua</title><style>body{font-family:system-ui,Arial;padding:24px;line-height:1.6}table{border-collapse:collapse}th,td{border:1px solid #999;padding:6px}</style></head><body>${mdToHtml(text)}</body></html>`);
  w.document.close(); w.focus();
  setTimeout(() => w.print(), 300);
}
async function exportXlsx(text) {
  const res = await fetch('/api/export/xlsx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, title: 'ket-qua' }),
  });
  download(await res.blob(), 'ket-qua.xlsx');
}
const ACT_ICONS = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  xls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l8 8M16 8l-8 8"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 21h16"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};
function botActions(text) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  bar.innerHTML =
    `<button data-a="copy" title="Sao chép">${ACT_ICONS.copy}<span>Copy</span></button>` +
    `<button data-a="doc" title="Xuất Word">${ACT_ICONS.doc}<span>Word</span></button>` +
    `<button data-a="xls" title="Xuất Excel">${ACT_ICONS.xls}<span>Excel</span></button>` +
    `<button data-a="pdf" title="Xuất PDF">${ACT_ICONS.pdf}<span>PDF</span></button>`;
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'copy') { navigator.clipboard.writeText(text).then(() => { b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200); }); }
    else if (a === 'doc') exportDoc(text);
    else if (a === 'xls') exportXlsx(text);
    else if (a === 'pdf') exportPdf(text);
  });
  return bar;
}

function showError(bubble, msg) { bubble.classList.add('error-note'); bubble.textContent = msg; }
function clearWelcome() { const w = messagesEl.querySelector('.welcome'); if (w) w.remove(); }
function setBusy(v) { busy = v; sendBtn.disabled = v; input.disabled = v; }
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ===== HƯỚNG DẪN LẦN ĐẦU (tour) =====
const TOUR_STEPS = [
  { sel: '#input', title: 'Ô nhập câu hỏi', text: 'Gõ câu hỏi ở đây rồi nhấn Enter để gửi (Shift+Enter để xuống dòng).' },
  { sel: '#advise-toggle', title: 'Tư vấn tối ưu', text: 'Bật lên rồi nhập yêu cầu + số lượng — bot tự chọn phương án tối ưu từ bảng giá và tính tiền chính xác.' },
  { sel: '#tpl-btn', title: 'Mẫu câu lệnh', text: 'Chèn nhanh các mẫu soạn sẵn (báo giá, email chào hàng…).' },
  { sel: '#clear-btn', title: 'Cuộc trò chuyện mới', text: 'Tạo một cuộc trò chuyện mới, tách biệt với các cuộc trước.' },
  { sel: '#convo-search', title: 'Tìm kiếm', text: 'Tìm nhanh trong lịch sử chat và tài liệu đã lưu.' },
  { sel: '.side-tools', title: 'Bảng công cụ', text: 'Quản trị dữ liệu (nhập bảng giá, tài liệu), đổi giao diện, bật/tắt ghi nhớ, và xem trạng thái máy.' },
  { sel: '#model-tag', title: 'Model AI', text: 'Chọn, tải hoặc xóa model. Máy mạnh chọn model lớn để trả lời thông minh hơn.' },
];
let tourIdx = 0;
const tourEl = document.getElementById('tour');
function showTourStep(i) {
  const step = TOUR_STEPS[i];
  const el = step && document.querySelector(step.sel);
  if (!el) { // phần tử không có -> bỏ qua
    if (i + 1 < TOUR_STEPS.length) return showTourStep(i + 1);
    return endTour();
  }
  const r = el.getBoundingClientRect();
  const pad = 6;
  const hole = document.getElementById('tour-hole');
  hole.style.left = (r.left - pad) + 'px';
  hole.style.top = (r.top - pad) + 'px';
  hole.style.width = (r.width + pad * 2) + 'px';
  hole.style.height = (r.height + pad * 2) + 'px';
  document.getElementById('tour-step').textContent = `Bước ${i + 1}/${TOUR_STEPS.length}`;
  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-text').textContent = step.text;
  const box = document.getElementById('tour-box');
  const arrow = document.getElementById('tour-arrow');
  box.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const bw = box.offsetWidth, bh = box.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 14;
    let top, dir;
    if (r.bottom + gap + bh <= vh) { top = r.bottom + gap; dir = 'up'; }
    else { top = Math.max(12, r.top - gap - bh); dir = 'down'; }
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(12, Math.min(left, vw - bw - 12));
    box.style.top = top + 'px';
    box.style.left = left + 'px';
    arrow.className = 'tour-arrow ' + dir;
    arrow.style.left = Math.max(18, Math.min(r.left + r.width / 2 - left, bw - 18)) + 'px';
    box.style.visibility = 'visible';
  });
}
function endTour() {
  if (document.getElementById('tour-noshow').checked) localStorage.setItem('avt-tour-done', '1');
  tourEl.classList.add('hidden');
  window.removeEventListener('resize', tourResize);
}
function tourResize() { showTourStep(tourIdx); }
function startTour() {
  tourIdx = 0;
  tourEl.classList.remove('hidden');
  showTourStep(0);
  window.addEventListener('resize', tourResize);
}
if (tourEl) {
  tourEl.addEventListener('click', (e) => {
    if (e.target.closest('.tour-foot')) return; // bấm nút đóng / ô tích thì không chuyển bước
    tourIdx++;
    if (tourIdx >= TOUR_STEPS.length) endTour();
    else showTourStep(tourIdx);
  });
  document.getElementById('tour-close').addEventListener('click', (e) => { e.stopPropagation(); endTour(); });
  if (!localStorage.getItem('avt-tour-done')) setTimeout(startTour, 400);
}

// ===== TRẠNG THÁI HỆ THỐNG (popup) =====
const statusBtn = document.getElementById('status-btn');
const statusModal = document.getElementById('status-modal');
let statusTimer = null;
async function loadStatusPopup() {
  const el = document.getElementById('status-modal-body');
  const gb = (b) => (b ? (b / 1073741824).toFixed(1) + ' GB' : '—');
  const badge = (level, text) => {
    const col = level === 'good' ? 'var(--dot-online)' : level === 'ok' ? '#d9a441' : 'var(--danger)';
    return `<span class="lvl" style="color:${col};border-color:${col}">${esc(text)}</span>`;
  };
  try {
    const s = await (await fetch('/api/status')).json();
    const oll = (s.ollama && s.ollama.length)
      ? s.ollama.map((m) => `${esc(m.name)} <span class="tag">${esc(m.processor)}</span>`).join('<br>')
      : '<span class="meta">Chưa nạp model nào</span>';
    const c = s.compat || {};
    el.innerHTML = `
      <h4 class="stat-h">Tương thích phần cứng</h4>
      <div class="stat-row"><span>CPU</span><div class="stat-val"><b>${esc(c.cpu || '?')}</b> · ${c.threads || '?'} luồng ${badge(c.cpuLevel, c.cpuLevel === 'good' ? 'Tốt' : c.cpuLevel === 'ok' ? 'Ổn' : 'Yếu')}<div class="meta">${esc(c.cpuNote || '')}</div></div></div>
      <div class="stat-row"><span>GPU</span><div class="stat-val"><b>${esc(c.gpu || '?')}</b> ${badge(c.gpuLevel, c.hasNvidia ? 'Tăng tốc được' : 'Chỉ CPU')}<div class="meta">${esc(c.gpuNote || '')}</div></div></div>
      <div class="stat-row"><span>RAM tổng</span><div class="stat-val"><b>${c.ramGB || '?'} GB</b> ${badge(c.ramLevel, c.ramLevel === 'good' ? 'Tốt' : c.ramLevel === 'ok' ? 'Ổn' : 'Ít')}</div></div>

      <h4 class="stat-h mt">Đang chạy</h4>
      <div class="stat-row"><span>Model đang dùng</span><b>${esc(s.model)}</b></div>
      <div class="stat-row"><span>Model đang nạp</span><div class="stat-val">${oll}</div></div>
      <div class="stat-row"><span>RAM sử dụng</span><b>${gb(s.ram.used)} / ${gb(s.ram.total)} · ${s.ram.usedPct}%</b></div>
      <div class="bar"><div class="bar-fill" style="width:${s.ram.usedPct}%"></div></div>
      ${s.disk ? `<div class="stat-row" style="margin-top:14px"><span>Ổ đĩa (còn trống)</span><b>${gb(s.disk.free)} / ${gb(s.disk.total)} · ${s.disk.freePct}%</b></div>
      <div class="bar"><div class="bar-fill" style="width:${100 - s.disk.freePct}%"></div></div>` : ''}`;
  } catch (err) { el.innerHTML = '<div class="empty">Lỗi: ' + esc(err.message) + '</div>'; }
}
function closeStatus() { statusModal.classList.add('hidden'); clearInterval(statusTimer); }
if (statusBtn) {
  statusBtn.addEventListener('click', () => {
    statusModal.classList.remove('hidden');
    document.getElementById('status-modal-body').innerHTML = 'Đang tải…';
    loadStatusPopup();
    clearInterval(statusTimer);
    statusTimer = setInterval(loadStatusPopup, 5000);
  });
  document.getElementById('status-close').addEventListener('click', closeStatus);
  statusModal.addEventListener('click', (e) => { if (e.target === statusModal) closeStatus(); });
}
