/**
 * PDF-viewer — 按需渲染 + 视口平滑平移/缩放
 */

const PDFViewer = (function() {
  const INK_PAD_RATIO = 0.25;
  const RENDER_MARGIN_PX = 400;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8.0;
  const ZOOM_STEP = 1.2;
  const MAX_OUTPUT_SCALE = 3;
  const RESCALE_DEBOUNCE_MS = 60;

  let pdfDoc = null;
  let totalPages = 0;
  let scale = 1.0;
  let pageCanvases = [];

  let canvasContainer = null;
  let viewStage = null;
  let scrollContainer = null;
  let rendering = false;
  let placeholderHeight = 800;
  let placeholderWidth = 600;

  let panX = 0;
  let panY = 0;
  /** 上次 PDF 重绘时的 scale；交互期用 CSS scale 补偿差值 */
  let renderedScale = 1;
  /** 缩放锚点：重绘后按页内归一化坐标二次对齐 */
  let zoomAnchor = null;

  let zoomAnimFrame = null;
  let panAnimFrame = null;
  let rescaleDebounceTimer = null;
  let rescalePromise = null;

  let onReadyCallback = null;
  let onPageRenderedCallback = null;
  let onVisiblePageChangeCallback = null;
  let onViewChangeCallback = null;
  let onRescaleCompleteCallback = null;

  let scrollRaf = null;
  let lastReportedPage = 0;

  function init() {
    canvasContainer = document.getElementById('canvas-container');
    viewStage = document.getElementById('view-stage');
    scrollContainer = document.getElementById('scroll-container');
    if (!scrollContainer || !viewStage) return;
    applyViewTransform();
    window.addEventListener('resize', scheduleVisibleUpdate);
  }

  function getEffectiveScale() {
    return scale;
  }

  /** 高清渲染倍率：随缩放略增，保证放大后清晰 */
  function getOutputScale() {
    const dpr = window.devicePixelRatio || 1;
    const boost = scale > 1.5 ? Math.min(scale / 1.5, 1.5) : 1;
    return Math.min(Math.max(dpr * boost, 1), MAX_OUTPUT_SCALE);
  }

  function getCssScale() {
    return renderedScale > 0 ? scale / renderedScale : 1;
  }

  /** 容器内坐标 */
  function clientToContainer(clientX, clientY) {
    const box = canvasContainer.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  }

  /** 记录锚点：页内归一化坐标（PDF 重绘后仍有效） */
  function captureZoomAnchor(clientX, clientY) {
    const c = clientToContainer(clientX, clientY);
    const anchor = { clientX, clientY, cx: c.x, cy: c.y, hasPage: false };

    const info = typeof InkEngine !== 'undefined' ? InkEngine.getPageAtClient(clientX, clientY) : null;
    if (info) {
      const entry = getPageEntry(info.pageNum);
      if (entry && entry.pageContent) {
        const r = entry.pageContent.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          anchor.pageNum = info.pageNum;
          anchor.normX = (clientX - r.left) / r.width;
          anchor.normY = (clientY - r.top) / r.height;
          anchor.hasPage = true;
        }
      }
    }
    return anchor;
  }

  /** 重绘且 CSS scale=1 后，将锚点拉回鼠标/双指位置 */
  function alignPanToAnchor(anchor) {
    if (!anchor || !anchor.hasPage) return;
    const entry = getPageEntry(anchor.pageNum);
    if (!entry || !entry.pageContent) return;
    const r = entry.pageContent.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const px = r.left + anchor.normX * r.width;
    const py = r.top + anchor.normY * r.height;
    panX += anchor.clientX - px;
    panY += anchor.clientY - py;
  }

  function applyViewTransform() {
    if (!viewStage) return;
    const cssScale = getCssScale();
    viewStage.style.transformOrigin = '0 0';
    viewStage.style.transform = Math.abs(cssScale - 1) < 0.0001
      ? `translate3d(${panX}px, ${panY}px, 0)`
      : `translate3d(${panX}px, ${panY}px, 0) scale(${cssScale})`;
    scheduleVisibleUpdate();
    if (onViewChangeCallback) onViewChangeCallback(scale);
  }

  function clampScale(s) {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
  }

  /**
   * 以鼠标/双指中点为中心缩放
   * 公式：screen = pan + layout * cssScale；缩放时保持 layout 点不动
   */
  function zoomBy(factor, anchorClientX, anchorClientY) {
    if (!canvasContainer || !factor || Math.abs(factor - 1) < 1e-6) return scale;

    const { x: sx, y: sy } = clientToContainer(anchorClientX, anchorClientY);
    const oldScale = scale;
    const newScale = clampScale(oldScale * factor);
    if (Math.abs(newScale - oldScale) < 1e-6) return scale;

    zoomAnchor = captureZoomAnchor(anchorClientX, anchorClientY);

    const ratio = newScale / oldScale;
    panX = sx - ratio * (sx - panX);
    panY = sy - ratio * (sy - panY);
    scale = newScale;

    applyViewTransform();
    scheduleRescale();
    return scale;
  }

  function scheduleRescale() {
    if (rescaleDebounceTimer) clearTimeout(rescaleDebounceTimer);
    rescaleDebounceTimer = setTimeout(() => {
      rescaleDebounceTimer = null;
      flushRescale();
    }, RESCALE_DEBOUNCE_MS);
  }

  function flushRescale() {
    if (rescaleDebounceTimer) {
      clearTimeout(rescaleDebounceTimer);
      rescaleDebounceTimer = null;
    }
    if (rescalePromise) return rescalePromise;
    rescalePromise = rescaleRenderedPages()
      .then(() => {
        if (onRescaleCompleteCallback) onRescaleCompleteCallback();
        return scale;
      })
      .finally(() => { rescalePromise = null; });
    return rescalePromise;
  }

  function scheduleVisibleUpdate() {
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      updateVisiblePages();
      reportVisiblePage();
    });
  }

  function reportVisiblePage() {
    const page = getVisiblePageNumber();
    if (page > 0 && page !== lastReportedPage) {
      lastReportedPage = page;
      if (onVisiblePageChangeCallback) onVisiblePageChangeCallback(page);
    }
  }

  function resetViewport() {
    panX = 0;
    panY = 0;
    renderedScale = scale;
    if (zoomAnimFrame) cancelAnimationFrame(zoomAnimFrame);
    if (panAnimFrame) cancelAnimationFrame(panAnimFrame);
    if (rescaleDebounceTimer) clearTimeout(rescaleDebounceTimer);
    applyViewTransform();
  }

  /** 平滑平移（手型拖动） */
  function panBy(dx, dy) {
    panX += dx;
    panY += dy;
    applyViewTransform();
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /** 缩放后仅重绘已渲染页，不隐藏页面，避免位置跳动 */
  async function rescaleRenderedPages() {
    if (!pdfDoc || rendering) return;
    rendering = true;

    const anchorSnapshot = zoomAnchor ? { ...zoomAnchor } : null;

    const page1 = await pdfDoc.getPage(1);
    const vp1 = page1.getViewport({ scale });
    placeholderHeight = vp1.height;
    placeholderWidth = vp1.width;

    const containerWidth = scrollContainer ? scrollContainer.clientWidth - 20 : 800;
    const tasks = [];

    for (const entry of pageCanvases) {
      if (entry.rendered) {
        tasks.push(
          renderOnePage(entry, containerWidth).then(() => {
            if (onPageRenderedCallback) onPageRenderedCallback(entry.pageNum);
          })
        );
      } else {
        entry.placeholder.style.height = placeholderHeight + 'px';
        entry.placeholder.style.width = placeholderWidth + 'px';
        entry.wrapper.style.minHeight = placeholderHeight + 'px';
      }
    }

    await Promise.all(tasks);
    renderedScale = scale;
    applyViewTransform();
    if (anchorSnapshot) alignPanToAnchor(anchorSnapshot);
    applyViewTransform();
    rendering = false;
  }

  /** 平滑滚动到某页 */
  function animatePanTo(targetX, targetY) {
    if (panAnimFrame) cancelAnimationFrame(panAnimFrame);
    const sx = panX;
    const sy = panY;
    const t0 = performance.now();
    const duration = 320;

    return new Promise(resolve => {
      function frame(now) {
        const p = Math.min(1, (now - t0) / duration);
        const e = easeOutCubic(p);
        panX = sx + (targetX - sx) * e;
        panY = sy + (targetY - sy) * e;
        applyViewTransform();
        if (p < 1) panAnimFrame = requestAnimationFrame(frame);
        else { panAnimFrame = null; resolve(); }
      }
      panAnimFrame = requestAnimationFrame(frame);
    });
  }

  async function loadPDF(filePath) {
    if (window.__pdfjsReady) await window.__pdfjsReady;

    const result = await window.pdfReaderAPI.readPdfFile(filePath);
    if (result.error) { console.error(result.error); return false; }

    const workerPath = await window.pdfReaderAPI.getPdfjsWorkerPath();
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;

    const loadingTask = window.pdfjsLib.getDocument({ data: result.data, useSystemFonts: true });
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    lastReportedPage = 0;
    resetViewport();

    const page1 = await pdfDoc.getPage(1);
    const vp1 = page1.getViewport({ scale });
    placeholderHeight = vp1.height;
    placeholderWidth = vp1.width;

    scrollContainer.innerHTML = '';
    pageCanvases = [];

    for (let i = 1; i <= totalPages; i++) createPageDOM(i);

    await updateVisiblePages();
    renderedScale = scale;
    applyViewTransform();
    reportVisiblePage();
    if (onReadyCallback) onReadyCallback(totalPages);
    return true;
  }

  function createPageDOM(pageNum) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = pageNum;

    const pageContent = document.createElement('div');
    pageContent.className = 'page-content';

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.className = 'pdf-page';
    pdfCanvas.style.touchAction = 'none';

    const inkCanvas = document.createElement('canvas');
    inkCanvas.className = 'ink-page';
    inkCanvas.style.touchAction = 'none';
    inkCanvas.dataset.page = pageNum;

    const placeholder = document.createElement('div');
    placeholder.className = 'page-placeholder';
    placeholder.style.height = placeholderHeight + 'px';
    placeholder.style.width = placeholderWidth + 'px';
    placeholder.textContent = '加载中…';

    pageContent.appendChild(pdfCanvas);
    pageContent.appendChild(inkCanvas);
    wrapper.appendChild(placeholder);
    wrapper.appendChild(pageContent);
    pageContent.style.display = 'none';
    scrollContainer.appendChild(wrapper);

    pageCanvases.push({
      wrapper, pageContent, placeholder, pdfCanvas, inkCanvas, pageNum,
      rendered: false, rendering: false, inkPad: null
    });
  }

  function isEntryInView(entry) {
    if (!canvasContainer) return false;
    const containerRect = canvasContainer.getBoundingClientRect();
    const rect = entry.wrapper.getBoundingClientRect();
    return rect.bottom > containerRect.top - RENDER_MARGIN_PX &&
           rect.top < containerRect.bottom + RENDER_MARGIN_PX;
  }

  async function ensurePageRendered(entry) {
    if (!pdfDoc || entry.rendered || entry.rendering) return;
    entry.rendering = true;
    try {
      await renderOnePage(entry, scrollContainer.clientWidth - 20);
      entry.rendered = true;
      entry.placeholder.style.display = 'none';
      entry.pageContent.style.display = 'block';
      entry.wrapper.style.minHeight = '';
      if (onPageRenderedCallback) onPageRenderedCallback(entry.pageNum);
    } catch (e) {
      console.error('render page', entry.pageNum, e);
    } finally {
      entry.rendering = false;
    }
  }

  async function updateVisiblePages() {
    if (!pdfDoc) return;
    await Promise.all(pageCanvases.filter(isEntryInView).map(ensurePageRendered));
  }

  async function renderAllPages() {
    if (!pdfDoc || rendering) return;
    rendering = true;

    const page1 = await pdfDoc.getPage(1);
    const vp1 = page1.getViewport({ scale });
    placeholderHeight = vp1.height;
    placeholderWidth = vp1.width;

    for (const entry of pageCanvases) {
      entry.rendered = false;
      entry.rendering = false;
      entry.pageContent.style.display = 'none';
      entry.placeholder.style.display = 'block';
      entry.placeholder.style.height = placeholderHeight + 'px';
      entry.placeholder.style.width = placeholderWidth + 'px';
      entry.wrapper.style.minHeight = placeholderHeight + 'px';
      entry.inkPad = null;
      const ctx = entry.pdfCanvas.getContext('2d');
      ctx.clearRect(0, 0, entry.pdfCanvas.width, entry.pdfCanvas.height);
    }

    await updateVisiblePages();
    renderedScale = scale;
    applyViewTransform();
    rendering = false;
  }

  async function renderOnePage(entry, containerWidth) {
    const page = await pdfDoc.getPage(entry.pageNum);
    const outputScale = getOutputScale();
    const viewport = page.getViewport({ scale });
    const w = viewport.width;
    const h = viewport.height;
    const padX = w * INK_PAD_RATIO;
    const padY = h * INK_PAD_RATIO;
    const inkW = w + padX * 2;
    const inkH = h + padY * 2;

    entry.outputScale = outputScale;
    entry.inkPad = { padX, padY, pdfW: w, pdfH: h, inkW, inkH, outputScale };

    entry.pageContent.style.width = w + 'px';
    entry.pageContent.style.height = h + 'px';

    entry.pdfCanvas.width = Math.floor(w * outputScale);
    entry.pdfCanvas.height = Math.floor(h * outputScale);
    entry.pdfCanvas.style.width = w + 'px';
    entry.pdfCanvas.style.height = h + 'px';

    entry.inkCanvas.width = Math.floor(inkW * outputScale);
    entry.inkCanvas.height = Math.floor(inkH * outputScale);
    entry.inkCanvas.style.width = inkW + 'px';
    entry.inkCanvas.style.height = inkH + 'px';
    entry.inkCanvas.style.left = (-padX) + 'px';
    entry.inkCanvas.style.top = (-padY) + 'px';

    const ctx = entry.pdfCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const renderViewport = page.getViewport({ scale: scale * outputScale });
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

    entry.pageContent.style.marginLeft = '0';
    entry.pageContent.style.marginRight = '0';

    entry.wrapper.style.paddingTop = '0';
    entry.wrapper.style.paddingBottom = '0';
    entry.wrapper.style.marginBottom = '0';
  }

  function getZoomAnchorClient(anchorClientX, anchorClientY) {
    const box = canvasContainer.getBoundingClientRect();
    return {
      x: anchorClientX != null ? anchorClientX : box.left + box.width / 2,
      y: anchorClientY != null ? anchorClientY : box.top + box.height / 2
    };
  }

  function zoomIn() {
    const a = getZoomAnchorClient();
    zoomBy(ZOOM_STEP, a.x, a.y);
    return flushRescale();
  }

  function zoomOut() {
    const a = getZoomAnchorClient();
    zoomBy(1 / ZOOM_STEP, a.x, a.y);
    return flushRescale();
  }

  function zoomFit() {
    if (!pdfDoc || !canvasContainer) return Promise.resolve(scale);
    return pdfDoc.getPage(1).then(page => {
      const w = canvasContainer.clientWidth - 40;
      const vp = page.getViewport({ scale: 1 });
      const fit = clampScale(Math.min(w / vp.width, 1.5));
      const a = getZoomAnchorClient();
      const factor = fit / scale;
      zoomBy(factor, a.x, a.y);
      return flushRescale();
    });
  }

  function setZoom(targetScale, anchorClientX, anchorClientY) {
    const a = getZoomAnchorClient(anchorClientX, anchorClientY);
    const factor = clampScale(targetScale) / scale;
    zoomBy(factor, a.x, a.y);
    return flushRescale();
  }

  function getScale() { return scale; }
  function getRenderScale() { return scale; }

  function getTotalPages() { return totalPages; }

  function getInkCanvas(pageNum) {
    const entry = pageCanvases.find(e => e.pageNum === pageNum);
    return entry ? entry.inkCanvas : null;
  }

  function getInkPad(pageNum) {
    const entry = pageCanvases.find(e => e.pageNum === pageNum);
    return entry ? entry.inkPad : null;
  }

  function getInkCanvasSize(pageNum) {
    const pad = getInkPad(pageNum);
    if (pad) return { width: pad.inkW, height: pad.inkH };
    const canvas = getInkCanvas(pageNum);
    if (!canvas || canvas.width < 1) return null;
    return { width: canvas.width, height: canvas.height };
  }

  function getPageEntry(pageNum) {
    return pageCanvases.find(e => e.pageNum === pageNum) || null;
  }

  function getAllPages() { return pageCanvases; }
  function getScrollContainer() { return scrollContainer; }
  function getCanvasContainer() { return canvasContainer; }

  function getVisiblePageNumber() {
    if (!canvasContainer || pageCanvases.length === 0) return 1;
    const containerRect = canvasContainer.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    let best = 1;
    let bestDist = Infinity;
    for (const entry of pageCanvases) {
      const rect = entry.wrapper.getBoundingClientRect();
      const mid = (rect.top + rect.bottom) / 2;
      const dist = Math.abs(mid - centerY);
      if (dist < bestDist) { bestDist = dist; best = entry.pageNum; }
    }
    return best;
  }

  async function ensureVisibleAtY(clientY) {
    if (!pdfDoc) return;
    await Promise.all(pageCanvases.filter(entry => {
      const rect = entry.wrapper.getBoundingClientRect();
      return clientY >= rect.top - RENDER_MARGIN_PX && clientY <= rect.bottom + RENDER_MARGIN_PX;
    }).map(ensurePageRendered));
  }

  async function scrollToPage(pageNum) {
    const entry = pageCanvases.find(e => e.pageNum === pageNum);
    if (!entry || !canvasContainer) return;
    await ensurePageRendered(entry);
    const containerRect = canvasContainer.getBoundingClientRect();
    const pageRect = entry.wrapper.getBoundingClientRect();
    const offsetTop = pageRect.top - containerRect.top;
    const targetY = panY - offsetTop;
    await animatePanTo(panX, targetY);
    reportVisiblePage();
  }

  function onReady(cb) { onReadyCallback = cb; }
  function onPageRendered(cb) { onPageRenderedCallback = cb; }
  function onVisiblePageChange(cb) { onVisiblePageChangeCallback = cb; }
  function onViewChange(cb) { onViewChangeCallback = cb; }

  function onRescaleComplete(cb) { onRescaleCompleteCallback = cb; }

  function unload() {
    pdfDoc = null;
    totalPages = 0;
    pageCanvases = [];
    lastReportedPage = 0;
    resetViewport();
    if (scrollContainer) scrollContainer.innerHTML = '';
  }

  return {
    init, loadPDF, zoomIn, zoomOut, zoomFit, setZoom, getScale, getRenderScale,
    getTotalPages, getInkCanvas, getInkPad, getInkCanvasSize, getPageEntry,
    getAllPages, getScrollContainer, getCanvasContainer,
    scrollToPage, getVisiblePageNumber, ensureVisibleAtY,
    panBy, zoomBy, scheduleRescale, flushRescale,
    onReady, onPageRendered, onVisiblePageChange, onViewChange, onRescaleComplete, unload,
    getOutputScale, INK_PAD_RATIO
  };
})();
