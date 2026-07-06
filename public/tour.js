// Engine "Hướng dẫn lần đầu" (tour) DÙNG CHUNG cho trang chat và trang quản trị.
// Mỗi trang chỉ cần khai báo TRƯỚC khi nạp file này:
//   window.TOUR_STEPS = [{ sel, title, text, tab? }, ...]   // tab? = tên tab cần mở (trang quản trị)
//   window.TOUR_KEY   = 'avt-tour-...'                       // khóa localStorage nhớ "đã xem"
(function () {
  const STEPS = window.TOUR_STEPS || [];
  const KEY = window.TOUR_KEY || 'avt-tour-done';
  const tourEl = document.getElementById('tour');
  if (!tourEl || !STEPS.length) return;
  let idx = 0;

  function showStep(i) {
    const step = STEPS[i];
    if (!step) return end();
    // Bước thuộc tab khác (trang quản trị) thì mở tab đó trước; trang không có tab thì bỏ qua vô hại
    if (step.tab) {
      const tabBtn = document.querySelector('.tab[data-tab="' + step.tab + '"]');
      if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
    }
    const el = document.querySelector(step.sel);
    if (!el) { // phần tử không có -> bỏ qua bước
      if (i + 1 < STEPS.length) return showStep(i + 1);
      return end();
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    const hole = document.getElementById('tour-hole');
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';
    document.getElementById('tour-step').textContent = `Bước ${i + 1}/${STEPS.length}`;
    document.getElementById('tour-title').textContent = step.title;
    document.getElementById('tour-text').textContent = step.text;
    const box = document.getElementById('tour-box');
    const arrow = document.getElementById('tour-arrow');
    box.style.visibility = 'hidden';
    // Đợi 1 khung hình để đo kích thước hộp rồi mới đặt trên/dưới mục được trỏ
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
  function end() {
    if (document.getElementById('tour-noshow').checked) localStorage.setItem(KEY, '1');
    tourEl.classList.add('hidden');
    window.removeEventListener('resize', onResize);
  }
  function onResize() { showStep(idx); }
  function start() {
    idx = 0;
    tourEl.classList.remove('hidden');
    showStep(0);
    window.addEventListener('resize', onResize);
  }

  // Bấm vào màn hình -> bước kế (trừ vùng nút đóng / ô tích)
  tourEl.addEventListener('click', (e) => {
    if (e.target.closest('.tour-foot')) return;
    idx++;
    if (idx >= STEPS.length) end();
    else showStep(idx);
  });
  document.getElementById('tour-close').addEventListener('click', (e) => { e.stopPropagation(); end(); });
  const helpBtn = document.getElementById('help-btn'); // nút HDSD -> xem lại
  if (helpBtn) helpBtn.addEventListener('click', start);
  if (!localStorage.getItem(KEY)) setTimeout(start, 400);
})();
