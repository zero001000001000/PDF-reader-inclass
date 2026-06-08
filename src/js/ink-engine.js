/**
 * Ink-engine — 笔迹引擎（归一化坐标，缩放后笔迹正确对齐）
 */

const InkEngine = (function() {
  let currentTool = 'pen';
  let currentColor = '#FF0000';
  let currentWidth = 5;
  let pressureEnabled = true;
  /** 橡皮擦半径 = 页面宽度的比例 */
  const ERASER_RADIUS_NORM = 0.025;

  let currentStroke = null;
  let isDrawing = false;
  let currentPage = 1;
  let eraserSnapshot = null;

  const pageStrokes = {};
  let unsavedChanges = false;
  let _idCounter = 0;

  function isDirty() { return unsavedChanges; }
  function markDirty() { unsavedChanges = true; }
  function clearDirty() { unsavedChanges = false; }
  function nextId() { return 's_' + (++_idCounter) + '_' + Date.now().toString(36); }

  function cloneStrokes(strokes) {
    return JSON.parse(JSON.stringify(strokes));
  }

  function init() {
    const indicator = document.getElementById('eraser-indicator');
    if (indicator) indicator.classList.add('hidden');
  }

  function getPageStore(pageNum) {
    const p = pageNum || currentPage;
    if (!pageStrokes[p]) {
      pageStrokes[p] = { strokes: [], undoActions: [], redoActions: [] };
    }
    return pageStrokes[p];
  }

  function getPdfSize(pageNum) {
    const pad = PDFViewer.getInkPad(pageNum);
    if (pad) return { width: pad.pdfW, height: pad.pdfH };
    return PDFViewer.getInkCanvasSize(pageNum);
  }

  function getEraserRadiusCanvas(pageNum) {
    const s = getPdfSize(pageNum);
    return s ? ERASER_RADIUS_NORM * s.width : 20;
  }

  /** 画布坐标 → PDF 归一化坐标（可超出 0~1，表示写在页边外） */
  function toNorm(pageNum, x, y) {
    const pad = PDFViewer.getInkPad(pageNum);
    if (!pad) return { x: 0, y: 0 };
    return {
      x: (x - pad.padX) / pad.pdfW,
      y: (y - pad.padY) / pad.pdfH
    };
  }

  function fromNorm(pageNum, nx, ny) {
    const pad = PDFViewer.getInkPad(pageNum);
    if (!pad) return { x: nx, y: ny };
    return {
      x: pad.padX + nx * pad.pdfW,
      y: pad.padY + ny * pad.pdfH
    };
  }

  function widthToNorm(pageNum, w) {
    const s = getPdfSize(pageNum);
    return s ? w / s.width : w;
  }

  function widthFromNorm(pageNum, nw) {
    const s = getPdfSize(pageNum);
    return s ? nw * s.width : nw;
  }

  function getOutputScale() {
    return PDFViewer.getOutputScale ? PDFViewer.getOutputScale() : (window.devicePixelRatio || 1);
  }

  function resetInkCtx(ctx, canvas) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx;
  }

  function applyInkCtxTransform(ctx) {
    const dpr = getOutputScale();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function getCurrentInkCtx() {
    const canvas = PDFViewer.getInkCanvas(currentPage);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    applyInkCtxTransform(ctx);
    return ctx;
  }

  function getActualWidth(pressure, baseWidthNorm, pageNum) {
    const px = widthFromNorm(pageNum, baseWidthNorm);
    return px * (0.6 + pressure * 0.8);
  }

  function strokesChanged(before, after) {
    return JSON.stringify(before) !== JSON.stringify(after);
  }

  function migrateStroke(stroke, pageNum) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return stroke;
    if (stroke.coordNorm) return stroke;
    const pad = PDFViewer.getInkPad(pageNum);
    const s = pad ? { width: pad.pdfW, height: pad.pdfH } : getPdfSize(pageNum);
    if (!s) return stroke;
    const maxX = Math.max(...stroke.points.map(p => p.x));
    if (maxX <= 1.05 && Math.min(...stroke.points.map(p => p.x)) >= -0.05) {
      return { ...stroke, coordNorm: true };
    }
    return {
      ...stroke,
      coordNorm: true,
      width: stroke.width / s.width,
      points: stroke.points.map(p => ({
        ...p,
        x: p.x / s.width,
        y: p.y / s.height
      }))
    };
  }

  function migrateStrokesList(strokes, pageNum) {
    return strokes.map(s => migrateStroke(s, pageNum));
  }

  // ========== 橡皮擦范围指示 ==========

  function showEraserIndicator(clientX, clientY) {
    const el = document.getElementById('eraser-indicator');
    if (!el || currentTool !== 'eraser') return;
    const pageInfo = getPageAtClient(clientX, clientY);
    if (!pageInfo) {
      el.classList.add('hidden');
      return;
    }
    const r = getEraserRadiusCanvas(pageInfo.pageNum);
    const rect = pageInfo.canvas.getBoundingClientRect();
    const pad = PDFViewer.getInkPad(pageInfo.pageNum);
    const inkCssW = pad ? pad.inkW : rect.width;
    const diameter = r * 2 * (rect.width / inkCssW);
    el.style.width = diameter + 'px';
    el.style.height = diameter + 'px';
    el.style.left = (clientX - diameter / 2) + 'px';
    el.style.top = (clientY - diameter / 2) + 'px';
    el.classList.remove('hidden');
  }

  function hideEraserIndicator() {
    const el = document.getElementById('eraser-indicator');
    if (el) el.classList.add('hidden');
  }

  function drawEraserPreview(pageNum, cx, cy) {
    const canvas = PDFViewer.getInkCanvas(pageNum);
    if (!canvas) return;
    const c = canvas.getContext('2d');
    applyInkCtxTransform(c);
    const r = getEraserRadiusCanvas(pageNum);
    c.save();
    c.strokeStyle = 'rgba(255, 80, 80, 0.85)';
    c.lineWidth = 2;
    c.setLineDash([6, 4]);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  // ========== 绘图事件 ==========

  function startStroke(x, y, pressure) {
    if (currentTool === 'scroll') return;
    const ctx = getCurrentInkCtx();
    if (!ctx) return;
    const pageNum = currentPage;
    const norm = toNorm(pageNum, x, y);

    if (currentTool === 'pen') {
      isDrawing = true;
      const p = (pressureEnabled && pressure > 0) ? pressure : 0.5;
      const wNorm = widthToNorm(pageNum, currentWidth);
      currentStroke = {
        id: nextId(),
        coordNorm: true,
        color: currentColor,
        width: wNorm,
        points: [{ x: norm.x, y: norm.y, pressure: p, time: Date.now() }],
        pageNumber: pageNum
      };
      const px = widthFromNorm(pageNum, wNorm);
      ctx.beginPath();
      ctx.arc(x, y, getActualWidth(0.1, wNorm, pageNum), 0, Math.PI * 2);
      ctx.fillStyle = currentColor;
      ctx.fill();
    } else if (currentTool === 'eraser') {
      isDrawing = true;
      const store = getPageStore(pageNum);
      eraserSnapshot = cloneStrokes(store.strokes);
      currentStroke = { type: 'erase', points: [{ x, y }], pageNumber: pageNum };
      eraseArea(x, y, false);
    }
  }

  function continueStroke(x, y, pressure) {
    if (!isDrawing || !currentStroke || currentTool === 'scroll') return;
    const pageNum = currentPage;

    if (currentTool === 'pen') {
      const ctx = getCurrentInkCtx();
      if (!ctx) return;
      const norm = toNorm(pageNum, x, y);
      const lastPoint = currentStroke.points[currentStroke.points.length - 1];
      const p = (pressureEnabled && pressure > 0) ? pressure : 0.5;
      currentStroke.points.push({ x: norm.x, y: norm.y, pressure: p, time: Date.now() });

      const lastPx = fromNorm(pageNum, lastPoint.x, lastPoint.y);
      const w = getActualWidth((lastPoint.pressure + p) / 2, currentStroke.width, pageNum);
      ctx.beginPath();
      ctx.moveTo(lastPx.x, lastPx.y);
      ctx.lineTo(x, y);
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (currentTool === 'eraser') {
      currentStroke.points.push({ x, y });
      eraseArea(x, y, false);
    }
  }

  function endStroke() {
    hideEraserIndicator();
    if (isDrawing && currentStroke) {
      if (currentTool === 'pen') {
        if (currentStroke.points.length >= 1) {
          const store = getPageStore(currentPage);
          store.strokes.push(currentStroke);
          store.undoActions.push({ type: 'add', stroke: cloneStrokes([currentStroke])[0] });
          store.redoActions = [];
          markDirty();
        }
      } else if (currentTool === 'eraser' && eraserSnapshot) {
        const store = getPageStore(currentPage);
        if (strokesChanged(eraserSnapshot, store.strokes)) {
          store.undoActions.push({
            type: 'erase',
            before: eraserSnapshot,
            after: cloneStrokes(store.strokes)
          });
          store.redoActions = [];
          markDirty();
        }
        eraserSnapshot = null;
      }
      currentStroke = null;
    }
    isDrawing = false;
  }

  function eraseArea(cx, cy, recordAction) {
    const store = getPageStore(currentPage);
    const pageNum = currentPage;
    if (recordAction !== false && eraserSnapshot === null) {
      eraserSnapshot = cloneStrokes(store.strokes);
    }

    const cn = toNorm(pageNum, cx, cy);
    const radiusNorm = ERASER_RADIUS_NORM;

    const toRemove = [];
    const newStrokes = [];

    for (let i = 0; i < store.strokes.length; i++) {
      const stroke = store.strokes[i];
      const result = clipStrokeByCircle(stroke, cn.x, cn.y, radiusNorm, pageNum);
      if (result === null) {
        toRemove.push(i);
      } else if (result.length > 1 || (result.length === 1 && result[0].id !== stroke.id)) {
        toRemove.push(i);
        for (const seg of result) newStrokes.push(seg);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      store.strokes.splice(toRemove[i], 1);
    }
    for (const seg of newStrokes) store.strokes.push(seg);

    redrawPage(currentPage);
    drawEraserPreview(pageNum, cx, cy);
  }

  function clipStrokeByCircle(stroke, cnx, cny, radiusNorm, pageNum) {
    const halfW = stroke.width / 2;
    const hitDist = radiusNorm + halfW;

    if (stroke.points.length < 2) {
      const p = stroke.points[0];
      const d = Math.hypot(p.x - cnx, p.y - cny);
      return d <= hitDist ? null : [stroke];
    }

    const result = [];
    let currentSeg = null;

    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      const inside = Math.hypot(p.x - cnx, p.y - cny) <= hitDist;

      if (!inside) {
        if (!currentSeg) {
          currentSeg = {
            id: nextId(),
            coordNorm: true,
            color: stroke.color,
            width: stroke.width,
            points: [],
            pageNumber: stroke.pageNumber
          };
        }
        currentSeg.points.push({ ...p });
      } else if (currentSeg && currentSeg.points.length >= 1) {
        result.push(currentSeg);
        currentSeg = null;
      }
    }

    if (currentSeg && currentSeg.points.length >= 1) result.push(currentSeg);
    if (result.length === 0) return null;
    if (result.length === 1 && result[0].points.length === stroke.points.length) return [stroke];
    return result;
  }

  // ========== 渲染 ==========

  function redrawPage(pageNum) {
    const canvas = PDFViewer.getInkCanvas(pageNum);
    if (!canvas || canvas.width < 1) return;
    const ctx = canvas.getContext('2d');
    resetInkCtx(ctx, canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyInkCtxTransform(ctx);

    const store = getPageStore(pageNum);
    for (let i = 0; i < store.strokes.length; i++) {
      store.strokes[i] = migrateStroke(store.strokes[i], pageNum);
      drawStroke(ctx, store.strokes[i], pageNum);
    }
  }

  function drawStroke(ctx, stroke, pageNum) {
    if (!stroke || !stroke.points || !stroke.points.length) return;
    const lineW = widthFromNorm(pageNum, stroke.width);

    if (stroke.points.length < 2) {
      const p = fromNorm(pageNum, stroke.points[0].x, stroke.points[0].y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, lineW / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
      return;
    }

    const p0 = fromNorm(pageNum, stroke.points[0].x, stroke.points[0].y);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < stroke.points.length; i++) {
      const p = fromNorm(pageNum, stroke.points[i].x, stroke.points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function redrawAll() {
    for (const entry of PDFViewer.getAllPages()) {
      if (entry.rendered) redrawPage(entry.pageNum);
    }
  }

  function setCurrentPage(pageNum) {
    currentPage = pageNum;
  }

  function getPageAtClient(clientX, clientY) {
    let best = null;
    let bestArea = Infinity;
    for (const entry of PDFViewer.getAllPages()) {
      const inkRect = entry.inkCanvas.getBoundingClientRect();
      if (inkRect.width <= 0 || inkRect.height <= 0) continue;
      if (clientX >= inkRect.left && clientX <= inkRect.right &&
          clientY >= inkRect.top && clientY <= inkRect.bottom) {
        const area = inkRect.width * inkRect.height;
        if (area < bestArea) {
          bestArea = area;
          best = {
            pageNum: entry.pageNum,
            canvas: entry.inkCanvas,
            offsetX: inkRect.left,
            offsetY: inkRect.top
          };
        }
      }
    }
    return best;
  }

  function getPageAtY(clientY) {
    for (const entry of PDFViewer.getAllPages()) {
      const wrapRect = entry.wrapper.getBoundingClientRect();
      if (clientY < wrapRect.top || clientY > wrapRect.bottom) continue;
      const inkRect = entry.inkCanvas.getBoundingClientRect();
      if (inkRect.width <= 0 || inkRect.height <= 0) continue;
      if (clientY >= inkRect.top && clientY <= inkRect.bottom) {
        return {
          pageNum: entry.pageNum,
          canvas: entry.inkCanvas,
          offsetX: inkRect.left,
          offsetY: inkRect.top
        };
      }
    }
    return null;
  }

  function clientToCanvas(clientX, clientY) {
    const info = getPageAtClient(clientX, clientY);
    if (!info) return null;
    const rect = info.canvas.getBoundingClientRect();
    return {
      pageNum: info.pageNum,
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function applyAction(action, direction) {
    const store = getPageStore(currentPage);
    const pageNum = currentPage;
    if (action.type === 'add') {
      if (direction === 'undo') {
        store.strokes = store.strokes.filter(s => s.id !== action.stroke.id);
      } else {
        store.strokes.push(migrateStroke(cloneStrokes([action.stroke])[0], pageNum));
      }
    } else if (action.type === 'erase' || action.type === 'clear') {
      const raw = direction === 'undo' ? action.before : action.after;
      store.strokes = migrateStrokesList(cloneStrokes(raw), pageNum);
    }
    redrawPage(currentPage);
  }

  function undo() {
    const store = getPageStore(currentPage);
    if (store.undoActions.length === 0) return false;
    const action = store.undoActions.pop();
    store.redoActions.push(action);
    applyAction(action, 'undo');
    markDirty();
    return true;
  }

  function redo() {
    const store = getPageStore(currentPage);
    if (store.redoActions.length === 0) return false;
    const action = store.redoActions.pop();
    store.undoActions.push(action);
    applyAction(action, 'redo');
    markDirty();
    return true;
  }

  function clearPage(pageNum) {
    const p = pageNum || currentPage;
    const store = getPageStore(p);
    if (store.strokes.length === 0) return;
    const before = cloneStrokes(store.strokes);
    store.strokes = [];
    store.undoActions.push({ type: 'clear', before, after: [] });
    store.redoActions = [];
    redrawPage(p);
    markDirty();
  }

  function resetAll() {
    Object.keys(pageStrokes).forEach(k => delete pageStrokes[k]);
    currentPage = 1;
    eraserSnapshot = null;
    currentStroke = null;
    isDrawing = false;
    clearDirty();
  }

  function setTool(t) {
    currentTool = t;
    hideEraserIndicator();
    const container = document.getElementById('canvas-container');
    if (container) {
      container.classList.remove('tool-pen', 'tool-eraser', 'tool-scroll');
      if (t === 'pen' || t === 'eraser' || t === 'scroll') {
        container.classList.add('tool-' + t);
      }
    }
  }
  function getTool() { return currentTool; }
  function setColor(c) { currentColor = c; }
  function setWidth(w) { currentWidth = w; }

  function normalizePageStore(raw, pageNum) {
    let strokes = raw.strokes || raw.undoStack || [];
    strokes = migrateStrokesList(strokes, pageNum);
    return {
      strokes,
      undoActions: raw.undoActions || [],
      redoActions: raw.redoActions || []
    };
  }

  function exportData() {
    const out = {};
    Object.keys(pageStrokes).forEach(key => {
      const s = pageStrokes[key];
      out[key] = {
        strokes: cloneStrokes(s.strokes),
        undoActions: cloneStrokes(s.undoActions),
        redoActions: cloneStrokes(s.redoActions)
      };
    });
    return { version: 3, coordNorm: true, pageStrokes: out };
  }

  function importData(data) {
    if (!data || !data.pageStrokes) return;
    Object.keys(pageStrokes).forEach(k => delete pageStrokes[k]);
    Object.keys(data.pageStrokes).forEach(key => {
      const pageNum = parseInt(key, 10);
      pageStrokes[key] = normalizePageStore(data.pageStrokes[key], pageNum);
    });
    redrawAll();
    clearDirty();
  }

  return {
    init, startStroke, continueStroke, endStroke, eraseArea,
    setCurrentPage, getPageAtY, getPageAtClient, clientToCanvas,
    redrawPage, redrawAll, undo, redo, clearPage,
    setTool, getTool, setColor, setWidth,
    showEraserIndicator, hideEraserIndicator, getEraserRadiusCanvas,
    exportData, importData, resetAll, isDirty, clearDirty, markDirty
  };
})();
