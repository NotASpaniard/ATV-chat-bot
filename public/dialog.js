// Hộp thoại của RIÊNG app — thay confirm()/alert() mặc định của trình duyệt ("localhost says").
// Ăn theo theme (dùng biến CSS). Dùng chung cho trang chat và quản trị.
//   await avtConfirm('Xóa?')  -> true/false
//   await avtAlert('Xong!')   -> resolve khi đóng
(function () {
  function ensureRoot() {
    let el = document.getElementById('avt-dialog');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'avt-dialog';
    el.className = 'avt-dialog-overlay hidden';
    el.innerHTML = `
      <div class="avt-dialog-box" role="dialog" aria-modal="true">
        <div class="avt-dialog-msg"></div>
        <div class="avt-dialog-foot">
          <button type="button" class="avt-dialog-cancel">Hủy</button>
          <button type="button" class="avt-dialog-ok">Đồng ý</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }
  function show(message, isConfirm, danger) {
    return new Promise((resolve) => {
      const el = ensureRoot();
      el.querySelector('.avt-dialog-msg').textContent = message;
      const ok = el.querySelector('.avt-dialog-ok');
      const cancel = el.querySelector('.avt-dialog-cancel');
      cancel.style.display = isConfirm ? '' : 'none';
      ok.textContent = isConfirm ? 'Đồng ý' : 'OK';
      ok.classList.toggle('danger', !!danger);
      el.classList.remove('hidden');
      const done = (val) => {
        el.classList.add('hidden');
        ok.onclick = cancel.onclick = el.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') done(false);
        else if (e.key === 'Enter') done(true);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      el.onclick = (e) => { if (e.target === el) done(false); }; // bấm nền = hủy/đóng
      document.addEventListener('keydown', onKey);
      setTimeout(() => ok.focus(), 0);
    });
  }
  // danger=true -> nút chính màu đỏ (mặc định cho confirm vì đa số là xóa)
  window.avtConfirm = (message, danger) => show(message, true, danger !== false);
  window.avtAlert = (message) => show(message, false, false);
})();
