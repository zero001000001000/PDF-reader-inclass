/**
 * Toolbar v2 — 工具栏交互，支持滚动模式
 */

const Toolbar = (function() {
  let callbacks = {};

  const el = {
    btnOpen:     document.getElementById('btn-open'),
    btnCloseFile: document.getElementById('btn-close-file'),
    btnPen:      document.getElementById('btn-pen'),
    btnEraser:   document.getElementById('btn-eraser'),
    btnScroll:   document.getElementById('btn-scroll'),
    colorBtns:   document.querySelectorAll('.color-btn'),
    widthBtns:   document.querySelectorAll('.width-btn'),
    btnUndo:     document.getElementById('btn-undo'),
    btnRedo:     document.getElementById('btn-redo'),
    btnClear:    document.getElementById('btn-clear'),
    btnZoomOut:  document.getElementById('btn-zoom-out'),
    btnZoomIn:   document.getElementById('btn-zoom-in'),
    btnZoomFit:  document.getElementById('btn-zoom-fit'),
    zoomLevel:   document.getElementById('zoom-level'),
    btnPrev:     document.getElementById('btn-prev'),
    btnNext:     document.getElementById('btn-next'),
    pageIndicator: document.getElementById('page-indicator'),
    clearDialog:   document.getElementById('clear-dialog'),
    clearConfirm:  document.getElementById('clear-confirm'),
    clearCancel:   document.getElementById('clear-cancel'),
    welcomeOverlay: document.getElementById('welcome-overlay')
  };

  function init(cbs) {
    callbacks = cbs;
    bindEvents();
  }

  function bindEvents() {
    el.btnOpen.addEventListener('click', () => callbacks.onOpenFile && callbacks.onOpenFile());
    el.btnCloseFile.addEventListener('click', () => callbacks.onCloseFile && callbacks.onCloseFile());

    el.btnPen.addEventListener('click', () => setActiveTool('pen'));
    el.btnEraser.addEventListener('click', () => setActiveTool('eraser'));
    el.btnScroll.addEventListener('click', () => setActiveTool('scroll'));

    el.colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        setActiveColor(btn.dataset.color);
        setActiveTool('pen');
      });
    });

    el.widthBtns.forEach(btn => {
      btn.addEventListener('click', () => setActiveWidth(parseInt(btn.dataset.width)));
    });

    el.btnUndo.addEventListener('click', () => callbacks.onUndo && callbacks.onUndo());
    el.btnRedo.addEventListener('click', () => callbacks.onRedo && callbacks.onRedo());

    el.btnClear.addEventListener('click', () => el.clearDialog.classList.remove('hidden'));
    el.clearConfirm.addEventListener('click', () => {
      el.clearDialog.classList.add('hidden');
      callbacks.onClearPage && callbacks.onClearPage();
    });
    el.clearCancel.addEventListener('click', () => el.clearDialog.classList.add('hidden'));
    el.clearDialog.addEventListener('click', e => { if (e.target === el.clearDialog) el.clearDialog.classList.add('hidden'); });

    el.btnZoomOut.addEventListener('click', () => {
      if (!callbacks.onZoomOut) return;
      const r = callbacks.onZoomOut();
      if (r && typeof r.then === 'function') r.then(s => updateZoomLevel(s));
      else if (r != null) updateZoomLevel(r);
    });
    el.btnZoomIn.addEventListener('click', () => {
      if (!callbacks.onZoomIn) return;
      const r = callbacks.onZoomIn();
      if (r && typeof r.then === 'function') r.then(s => updateZoomLevel(s));
      else if (r != null) updateZoomLevel(r);
    });
    el.btnZoomFit.addEventListener('click', () => {
      if (!callbacks.onZoomFit) return;
      const r = callbacks.onZoomFit();
      if (r && typeof r.then === 'function') r.then(s => updateZoomLevel(s));
      else if (r != null) updateZoomLevel(r);
    });

    el.btnPrev.addEventListener('click', () => callbacks.onPrevPage && callbacks.onPrevPage());
    el.btnNext.addEventListener('click', () => callbacks.onNextPage && callbacks.onNextPage());
  }

  /* ====== 状态更新 ====== */

  function setActiveTool(tool) {
    el.btnPen.classList.toggle('active', tool === 'pen');
    el.btnEraser.classList.toggle('active', tool === 'eraser');
    el.btnScroll.classList.toggle('active', tool === 'scroll');
    const inactive = tool !== 'pen';
    el.colorBtns.forEach(b => b.style.opacity = inactive ? '0.4' : '1');
    el.widthBtns.forEach(b => b.style.opacity = inactive ? '0.4' : '1');
    callbacks.onToolChange && callbacks.onToolChange(tool);
  }

  function setActiveColor(color) {
    el.colorBtns.forEach(b => b.classList.toggle('active', b.dataset.color === color));
    callbacks.onColorChange && callbacks.onColorChange(color);
  }

  function setActiveWidth(width) {
    el.widthBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.width) === width));
    callbacks.onWidthChange && callbacks.onWidthChange(width);
  }

  function updateZoomLevel(scale) {
    el.zoomLevel.textContent = Math.round(scale * 100) + '%';
  }

  function updatePageIndicator(page, total) {
    el.pageIndicator.textContent = total > 0 ? page + ' / ' + total : '— / —';
  }

  function hideWelcome() { el.welcomeOverlay.style.display = 'none'; }
  function showWelcome() { el.welcomeOverlay.style.display = 'flex'; }

  return {
    init, setActiveTool, setActiveColor, setActiveWidth,
    updateZoomLevel, updatePageIndicator, hideWelcome, showWelcome
  };
})();
