/**
 * Storage — 批注持久化（仅手动保存，无自动保存）
 */

const Storage = (function() {
  let currentPdfPath = null;

  function init() {}

  function setPdfPath(path) {
    currentPdfPath = path;
  }

  function getPdfPath() {
    return currentPdfPath;
  }

  async function save(data) {
    if (!currentPdfPath) return { success: false };
    try {
      return await window.pdfReaderAPI.saveAnnotations(currentPdfPath, data);
    } catch (err) {
      console.error('保存批注失败:', err);
      return { success: false, error: err.message };
    }
  }

  async function load() {
    if (!currentPdfPath) return null;
    try {
      return await window.pdfReaderAPI.loadAnnotations(currentPdfPath);
    } catch (err) {
      console.error('加载批注失败:', err);
      return null;
    }
  }

  return {
    init,
    setPdfPath,
    getPdfPath,
    save,
    load
  };
})();
