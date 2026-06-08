/**
 * App — 入口；批注仅在退出文件时询问保存，默认不保存
 */
(function() {
  'use strict';
  let currentFilePath = null;
  let currentFileName = '';
  let _scrollPage = 1;
  let getExportData = null;
  let isClosingApp = false;

  function showError(msg) {
    const o = document.getElementById('welcome-overlay');
    if (o) { o.innerHTML = `<h2 style="color:#e53935">错误</h2><p>${msg}</p>`; o.style.display = 'flex'; }
    console.error(msg);
  }

  function syncPageIndicator(pageNum) {
    _scrollPage = pageNum;
    InkEngine.setCurrentPage(pageNum);
    Toolbar.updatePageIndicator(pageNum, PDFViewer.getTotalPages());
  }

  function updateTitle() {
    document.title = currentFileName
      ? 'PDF-reader-inclass — ' + currentFileName + (InkEngine.isDirty() ? ' *' : '')
      : 'PDF-reader-inclass';
  }

  async function saveCurrentAnnotations() {
    if (!currentFilePath || !getExportData) return false;
    const result = await Storage.save(getExportData());
    if (result && result.success) {
      InkEngine.clearDirty();
      updateTitle();
      return true;
    }
    showError('保存批注失败');
    return false;
  }

  /**
   * 有未保存修改时弹窗；无修改直接 discard
   * @returns {Promise<'save'|'discard'|'cancel'>}
   */
  async function promptSaveIfDirty() {
    if (!currentFilePath || !InkEngine.isDirty()) return 'discard';
    return SavePrompt.show({ message: '批注尚未保存，是否保存？' });
  }

  function unloadCurrentFile() {
    PDFViewer.unload();
    InkEngine.resetAll();
    Storage.setPdfPath(null);
    currentFilePath = null;
    currentFileName = '';
    _scrollPage = 1;
    document.title = 'PDF-reader-inclass';
    Toolbar.showWelcome();
    Toolbar.updatePageIndicator(0, 0);
  }

  async function loadFile(filePath, fileName) {
    currentFilePath = filePath;
    currentFileName = fileName || filePath.split(/[/\\]/).pop();

    const ok = await PDFViewer.loadPDF(currentFilePath);
    if (!ok) {
      showError('加载 PDF 失败');
      unloadCurrentFile();
      return false;
    }

    Toolbar.hideWelcome();
    Toolbar.updateZoomLevel(PDFViewer.getScale());
    syncPageIndicator(PDFViewer.getVisiblePageNumber());

    Storage.setPdfPath(currentFilePath);
    const saved = await Storage.load();
    if (saved) InkEngine.importData(saved);
    else InkEngine.clearDirty();

    updateTitle();
    return true;
  }

  async function handleCloseFile() {
    if (!currentFilePath) return;
    const decision = await promptSaveIfDirty();
    if (decision === 'cancel') return;
    if (decision === 'save') {
      const ok = await saveCurrentAnnotations();
      if (!ok) return;
    }
    unloadCurrentFile();
  }

  async function handleOpenFile() {
    try {
      if (currentFilePath) {
        const decision = await promptSaveIfDirty();
        if (decision === 'cancel') return;
        if (decision === 'save') {
          const ok = await saveCurrentAnnotations();
          if (!ok) return;
        }
      }

      const r = await window.pdfReaderAPI.openFileDialog();
      if (!r) return;

      if (currentFilePath) unloadCurrentFile();
      await loadFile(r.path, r.name);
    } catch (e) { showError(e.message); }
  }

  async function handleAppBeforeClose() {
    if (isClosingApp) return;
    if (!currentFilePath) {
      window.pdfReaderAPI.allowClose();
      return;
    }
    const decision = await promptSaveIfDirty();
    if (decision === 'cancel') return;
    if (decision === 'save') {
      const ok = await saveCurrentAnnotations();
      if (!ok) return;
    }
    isClosingApp = true;
    window.pdfReaderAPI.allowClose();
  }

  function init() {
    try {
      window.__pdfjsReady && window.__pdfjsReady.catch(e => showError('pdf.js 加载失败: ' + e.message));

      SavePrompt.init();
      PDFViewer.init();
      InkEngine.init();
      Storage.init();

      PDFViewer.onPageRendered((pageNum) => {
        InkEngine.redrawPage(pageNum);
      });

      PDFViewer.onVisiblePageChange((pageNum) => {
        syncPageIndicator(pageNum);
      });

      PDFViewer.onViewChange((s) => Toolbar.updateZoomLevel(s));
      PDFViewer.onRescaleComplete(() => {
        InkEngine.redrawAll();
        Toolbar.updateZoomLevel(PDFViewer.getScale());
      });

      GestureManager.init();
      GestureManager.setCallbacks({
        onStartStroke: (x, y, p) => {
          const t = InkEngine.getTool();
          if (t === 'pen' || t === 'eraser') InkEngine.startStroke(x, y, p);
        },
        onContinueStroke: (x, y, p) => {
          const t = InkEngine.getTool();
          if (t === 'pen' || t === 'eraser') InkEngine.continueStroke(x, y, p);
        },
        onEndStroke: () => {
          InkEngine.endStroke();
          updateTitle();
        },
        onPinchZoom: (s) => Toolbar.updateZoomLevel(s),
        onZoomEnd: () => PDFViewer.flushRescale()
      });

      Toolbar.init({
        onOpenFile: handleOpenFile,
        onCloseFile: handleCloseFile,
        onToolChange: (t) => InkEngine.setTool(t),
        onColorChange: (c) => InkEngine.setColor(c),
        onWidthChange: (w) => InkEngine.setWidth(w),
        onUndo: () => { InkEngine.undo(); updateTitle(); },
        onRedo: () => { InkEngine.redo(); updateTitle(); },
        onClearPage: () => {
          InkEngine.clearPage(_scrollPage);
          updateTitle();
        },
        onZoomOut: () => PDFViewer.zoomOut(),
        onZoomIn:  () => PDFViewer.zoomIn(),
        onZoomFit: () => PDFViewer.zoomFit(),
        onPrevPage: () => {
          const page = Math.max(1, _scrollPage - 1);
          PDFViewer.scrollToPage(page);
          syncPageIndicator(page);
        },
        onNextPage: () => {
          const total = PDFViewer.getTotalPages();
          const page = Math.min(total, _scrollPage + 1);
          PDFViewer.scrollToPage(page);
          syncPageIndicator(page);
        }
      });

      getExportData = () => InkEngine.exportData();

      window.pdfReaderAPI.onBeforeClose(handleAppBeforeClose);

      Toolbar.showWelcome();
      console.log('PDF-reader-inclass 已启动（手动保存模式）');
    } catch (e) {
      showError(e.stack || e.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
