// Quản lý theme: light / dark / coffee. Lưu localStorage, mỗi theme có icon + nhãn riêng.
(function () {
  const THEMES = ['light', 'dark', 'coffee'];
  const KEY = 'avt-theme';

  // Icon riêng cho từng theme (SVG line, dùng currentColor)
  const ICONS = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    coffee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/><path d="M6 2v2M10 2v2M14 2v2"/></svg>',
  };
  const LABEL = { light: 'Sáng', dark: 'Tối', coffee: 'Cà phê' };

  // Logo (icon con vật) của chatbot theo từng theme:
  //  trắng/sáng -> hổ, đen/tối -> bạch tuộc, cà phê -> vẹt
  const ANIMALS = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6.5 4 4M18 6.5 20 4"/><path d="M6.5 6C5 7.4 4 9.6 4 12c0 4.4 3.6 8 8 8s8-3.6 8-8c0-2.4-1-4.6-2.5-6"/><circle cx="9.5" cy="11" r="0.7" fill="currentColor" stroke="none"/><circle cx="14.5" cy="11" r="0.7" fill="currentColor" stroke="none"/><path d="M12 13v1.6M10.6 15.4c.4.5 2.4.5 2.8 0"/><path d="M4.2 10 7 10.4M19.8 10 17 10.4M4.6 13.4 7 13M19.4 13.4 17 13"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.6 0 6.5 2.7 6.5 6v2.4c0 .9-.7 1.6-1.6 1.6H7.1c-.9 0-1.6-.7-1.6-1.6V9.5c0-3.3 2.9-6 6.5-6z"/><circle cx="9.7" cy="9.6" r="0.75" fill="currentColor" stroke="none"/><circle cx="14.3" cy="9.6" r="0.75" fill="currentColor" stroke="none"/><path d="M6 13.6c-1.2.3-2 1.3-2 2.7M9 13.6c-.6 1.2-.7 2.7-.2 4M12 13.6v4.3M15 13.6c.6 1.2.7 2.7.2 4M18 13.6c1.2.3 2 1.3 2 2.7"/></svg>',
    coffee: '<span class="animal-img"></span>', // vẹt (ảnh parrot.png qua CSS mask, ăn theo màu)
  };
  function renderLogos(t) {
    const svg = ANIMALS[t] || ANIMALS.light;
    document.querySelectorAll('.logo, .w-logo, .msg.bot .avatar').forEach((el) => { el.innerHTML = svg; });
  }

  function current() {
    const t = localStorage.getItem(KEY);
    return THEMES.includes(t) ? t : 'light';
  }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(KEY, t);
    render(t);
    renderLogos(t);
    applyBg(t);
  }

  // ----- Ảnh nền + độ mờ RIÊNG cho từng theme (lưu localStorage) -----
  function bgKey(t) { return 'avt-bg-' + (t || current()); }        // ảnh (dataURL)
  function bgOpKey(t) { return 'avt-bgop-' + (t || current()); }    // độ mờ 0..100
  function applyBg(t) {
    t = t || current();
    let layer = document.getElementById('app-bg');
    if (!layer) { layer = document.createElement('div'); layer.id = 'app-bg'; document.body.appendChild(layer); }
    const url = localStorage.getItem(bgKey(t)) || '';
    const op = localStorage.getItem(bgOpKey(t));
    if (url) {
      layer.style.backgroundImage = 'url("' + url + '")';
      layer.style.opacity = (op != null ? Number(op) : 35) / 100;
      document.documentElement.classList.add('has-bg');
    } else {
      layer.style.backgroundImage = 'none';
      layer.style.opacity = 0;
      document.documentElement.classList.remove('has-bg');
    }
  }
  function render(t) {
    const btn = document.getElementById('theme-btn');
    if (!btn) return;
    btn.innerHTML = ICONS[t];
    btn.title = 'Giao diện: ' + LABEL[t] + ' (bấm để đổi)';
    btn.setAttribute('aria-label', 'Đổi giao diện, hiện tại ' + LABEL[t]);
  }
  function next() {
    const i = THEMES.indexOf(current());
    apply(THEMES[(i + 1) % THEMES.length]);
  }

  // ----- Nút ghi nhớ xuyên hội thoại -----
  const MEM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3A3 3 0 0 0 7 8a3 3 0 0 0-1 5.5A3 3 0 0 0 9.5 19a2.5 2.5 0 0 0 2.5-2.5V5.5A2.5 2.5 0 0 0 9.5 3z"/><path d="M14.5 3A3 3 0 0 1 17 8a3 3 0 0 1 1 5.5A3 3 0 0 1 14.5 19a2.5 2.5 0 0 1-2.5-2.5V5.5A2.5 2.5 0 0 1 14.5 3z"/></svg>';
  function memOn() { return localStorage.getItem('avt-memory') === '1'; }
  function renderMem() {
    const b = document.getElementById('mem-btn');
    if (!b) return;
    const on = memOn();
    b.innerHTML = MEM_ICON;
    b.classList.toggle('active', on);
    b.title = 'Ghi nhớ giữa các cuộc hội thoại: ' + (on ? 'BẬT' : 'TẮT') + ' (bấm để đổi)';
  }
  function toggleMem() {
    localStorage.setItem('avt-memory', memOn() ? '0' : '1');
    renderMem();
  }

  document.addEventListener('DOMContentLoaded', () => {
    render(current());
    renderLogos(current());
    applyBg(current());
    const btn = document.getElementById('theme-btn');
    if (btn) btn.addEventListener('click', next);
    renderMem();
    const mb = document.getElementById('mem-btn');
    if (mb) mb.addEventListener('click', toggleMem);
  });

  window.AVTTheme = {
    current, apply, next, applyBg,
    animal: () => ANIMALS[current()] || ANIMALS.light,
    // nền theo theme hiện tại (dùng cho popup bánh răng)
    getBg: () => localStorage.getItem(bgKey()) || '',
    getBgOpacity: () => { const v = localStorage.getItem(bgOpKey()); return v != null ? Number(v) : 35; },
    setBg: (dataUrl) => { if (dataUrl) localStorage.setItem(bgKey(), dataUrl); else localStorage.removeItem(bgKey()); applyBg(); },
    setBgOpacity: (v) => { localStorage.setItem(bgOpKey(), String(v)); applyBg(); },
  };
})();
