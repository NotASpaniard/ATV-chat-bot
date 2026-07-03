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

  function current() {
    const t = localStorage.getItem(KEY);
    return THEMES.includes(t) ? t : 'light';
  }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(KEY, t);
    render(t);
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
    const btn = document.getElementById('theme-btn');
    if (btn) btn.addEventListener('click', next);
    renderMem();
    const mb = document.getElementById('mem-btn');
    if (mb) mb.addEventListener('click', toggleMem);
  });

  window.AVTTheme = { current, apply, next };
})();
