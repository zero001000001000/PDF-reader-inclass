/**
 * Gesture-manager — 触摸屏优化 + 鼠标滚轮缩放
 */

const GestureManager = (function() {
  let activePointers = new Map();
  let isDrawing = false;
  let isPanning = false;
  let isPinching = false;
  let strokePageNum = null;

  let panVelocityX = 0;
  let panVelocityY = 0;
  let inertiaFrame = null;

  let canvasContainer = null;

  let onStartStroke = null;
  let onContinueStroke = null;
  let onEndStroke = null;
  let onPinchZoom = null;
  let onZoomEnd = null;

  const INERTIA_FRICTION = 0.92;
  const INERTIA_MIN = 0.4;
  const PALM_TOUCH_SIZE = 48;
  const WHEEL_ZOOM_SENSITIVITY = 0.002;

  function init() {
    canvasContainer = document.getElementById('canvas-container');
    if (!canvasContainer) return;

    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      document.documentElement.classList.add('touch-device');
    }

    const bind = (el, type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      if (el.style && type.startsWith('pointer')) el.style.touchAction = 'none';
    };

    bind(canvasContainer, 'pointerdown', onPointerDown);
    bind(canvasContainer, 'pointermove', onPointerMove);
    bind(canvasContainer, 'pointerup', onPointerUp);
    bind(canvasContainer, 'pointercancel', onPointerUp);
    bind(canvasContainer, 'wheel', onWheel, { passive: false });
    bind(canvasContainer, 'lostpointercapture', onLostCapture);
  }

  function inCanvasArea(e) {
    return e.target.closest('#canvas-container');
  }

  function isTouchLikePointer(e) {
    return e.pointerType === 'touch' || e.pointerType === 'pen';
  }

  function isPalmTouch(e) {
    return e.pointerType === 'touch' &&
      (e.width > PALM_TOUCH_SIZE || e.height > PALM_TOUCH_SIZE);
  }

  function tryCapturePointer(e) {
    try { canvasContainer.setPointerCapture(e.pointerId); } catch (_) {}
  }

  function stopInertia() {
    if (inertiaFrame) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    }
    panVelocityX = 0;
    panVelocityY = 0;
  }

  function onWheel(e) {
    if (!inCanvasArea(e)) return;
    e.preventDefault();
    stopInertia();

    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 20;
    else if (e.deltaMode === 2) delta *= canvasContainer.clientHeight;

    const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
    PDFViewer.zoomBy(factor, e.clientX, e.clientY);
    if (onPinchZoom) onPinchZoom(PDFViewer.getScale());
  }

  function startInertia() {
    stopInertia();
    function tick() {
      panVelocityX *= INERTIA_FRICTION;
      panVelocityY *= INERTIA_FRICTION;
      if (Math.abs(panVelocityX) < INERTIA_MIN && Math.abs(panVelocityY) < INERTIA_MIN) {
        inertiaFrame = null;
        return;
      }
      PDFViewer.panBy(panVelocityX, panVelocityY);
      inertiaFrame = requestAnimationFrame(tick);
    }
    inertiaFrame = requestAnimationFrame(tick);
  }

  function beginStrokeAt(clientX, clientY, pressure) {
    const pt = InkEngine.clientToCanvas(clientX, clientY);
    if (!pt) return false;
    strokePageNum = pt.pageNum;
    InkEngine.setCurrentPage(pt.pageNum);
    const p = pressure > 0 ? pressure : 0.5;
    if (onStartStroke) onStartStroke(pt.x, pt.y, p);
    if (InkEngine.getTool() === 'eraser') InkEngine.showEraserIndicator(clientX, clientY);
    return true;
  }

  function continueStrokeAt(clientX, clientY, pressure) {
    const pt = InkEngine.clientToCanvas(clientX, clientY);
    if (!pt) return;
    const p = pressure > 0 ? pressure : 0.5;
    if (strokePageNum !== null && pt.pageNum !== strokePageNum) {
      if (onEndStroke) onEndStroke();
      strokePageNum = pt.pageNum;
      InkEngine.setCurrentPage(pt.pageNum);
      if (onStartStroke) onStartStroke(pt.x, pt.y, p);
    } else {
      InkEngine.setCurrentPage(pt.pageNum);
      if (onContinueStroke) onContinueStroke(pt.x, pt.y, p);
    }
    if (InkEngine.getTool() === 'eraser') InkEngine.showEraserIndicator(clientX, clientY);
  }

  async function onPointerDown(e) {
    if (!inCanvasArea(e)) return;
    if (isPalmTouch(e)) return;

    if (isTouchLikePointer(e)) e.preventDefault();
    stopInertia();

    activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType
    });

    if (activePointers.size === 1) {
      const tool = InkEngine.getTool();

      if (tool === 'scroll') {
        isPanning = true;
        isDrawing = false;
        isPinching = false;
        strokePageNum = null;
        InkEngine.hideEraserIndicator();
        tryCapturePointer(e);
      } else {
        await PDFViewer.ensureVisibleAtY(e.clientY);
        isPanning = false;
        isPinching = false;
        isDrawing = beginStrokeAt(e.clientX, e.clientY, e.pressure);
        if (!isDrawing) {
          strokePageNum = null;
        } else if (isTouchLikePointer(e)) {
          tryCapturePointer(e);
        }
      }
    } else if (activePointers.size === 2) {
      isDrawing = false;
      isPanning = false;
      strokePageNum = null;
      if (onEndStroke) onEndStroke();
      InkEngine.hideEraserIndicator();
      isPinching = true;
      activePointers._lastDist = getPinchDistance();
      activePointers._pinchCx = getPinchCenter().x;
      activePointers._pinchCy = getPinchCenter().y;
    }
  }

  function onPointerMove(e) {
    if (!inCanvasArea(e)) return;

    if (!activePointers.has(e.pointerId)) {
      if (InkEngine.getTool() === 'eraser' && e.pointerType === 'mouse') {
        InkEngine.showEraserIndicator(e.clientX, e.clientY);
      }
      return;
    }

    if (isTouchLikePointer(e)) e.preventDefault();

    const prev = activePointers.get(e.pointerId);
    const oldX = prev ? prev.x : e.clientX;
    const oldY = prev ? prev.y : e.clientY;
    activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType
    });

    const tool = InkEngine.getTool();
    const dx = e.clientX - oldX;
    const dy = e.clientY - oldY;

    if (activePointers.size === 1) {
      if (tool === 'scroll' && isPanning) {
        PDFViewer.panBy(dx, dy);
        panVelocityX = dx;
        panVelocityY = dy;
      } else if (isDrawing && (tool === 'pen' || tool === 'eraser')) {
        continueStrokeAt(e.clientX, e.clientY, e.pressure);
      } else if (tool === 'eraser') {
        InkEngine.showEraserIndicator(e.clientX, e.clientY);
      }
    } else if (activePointers.size === 2 && isPinching) {
      const center = getPinchCenter();
      const dist = getPinchDistance();
      const lastDist = activePointers._lastDist || dist;
      if (lastDist > 10 && Math.abs(dist - lastDist) > 0.5) {
        PDFViewer.zoomBy(dist / lastDist, center.x, center.y);
        if (onPinchZoom) onPinchZoom(PDFViewer.getScale());
      }
      activePointers._lastDist = dist;
      activePointers._pinchCx = center.x;
      activePointers._pinchCy = center.y;
    }
  }

  async function onPointerUp(e) {
    if (!activePointers.has(e.pointerId)) return;
    if (isTouchLikePointer(e)) e.preventDefault();
    activePointers.delete(e.pointerId);
    const wasPinching = isPinching && activePointers.size < 2;

    try { canvasContainer.releasePointerCapture(e.pointerId); } catch (_) {}

    if (activePointers.size === 0) {
      if (isDrawing && onEndStroke) onEndStroke();
      isDrawing = false;
      strokePageNum = null;

      if (wasPinching && onZoomEnd) await onZoomEnd();

      if (isPanning && InkEngine.getTool() === 'scroll') startInertia();

      isPanning = false;
      isPinching = false;
      activePointers._lastDist = null;

      if (InkEngine.getTool() !== 'eraser') InkEngine.hideEraserIndicator();
    } else if (activePointers.size === 1 && isPinching) {
      isPinching = false;
      if (onZoomEnd) await onZoomEnd();
      activePointers._lastDist = null;
    }
  }

  function onLostCapture(e) {
    if (activePointers.has(e.pointerId)) {
      onPointerUp(e);
    }
  }

  function getDistance(p1, p2) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
  }

  function getPinchDistance() {
    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return 0;
    return getDistance(pts[0], pts[1]);
  }

  function getPinchCenter() {
    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return { x: 0, y: 0 };
    return {
      x: (pts[0].x + pts[1].x) / 2,
      y: (pts[0].y + pts[1].y) / 2
    };
  }

  function setCallbacks(cbs) {
    if (cbs.onStartStroke) onStartStroke = cbs.onStartStroke;
    if (cbs.onContinueStroke) onContinueStroke = cbs.onContinueStroke;
    if (cbs.onEndStroke) onEndStroke = cbs.onEndStroke;
    if (cbs.onPinchZoom) onPinchZoom = cbs.onPinchZoom;
    if (cbs.onZoomEnd) onZoomEnd = cbs.onZoomEnd;
    if (cbs.onPinchEnd) onZoomEnd = cbs.onPinchEnd;
  }

  return { init, setCallbacks };
})();
