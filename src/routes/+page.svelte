<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import { clamp, distance, resampleStroke, softenStroke } from '$lib/ink/geometry';
  import {
    correctStroke,
    findCorrectionCandidate,
    guideIncomingStroke,
    type CorrectionCandidate
  } from '$lib/ink/correction';
  import type { Camera, InkPoint, InkSettings, InkStroke } from '$lib/ink/types';

  const STORAGE_KEY = 'b-line-prototype-v1';
  const MAX_HISTORY = 60;

  let canvas: HTMLCanvasElement;
  let strokes: InkStroke[] = [];
  let activeStroke: InkPoint[] = [];
  let previewStroke: InkPoint[] = [];
  let previewCandidate: CorrectionCandidate | null = null;
  let drawingPointerId: number | null = null;
  let bypassMagnetism = false;
  let isPanning = false;
  let panPointerId: number | null = null;
  let panOrigin = { x: 0, y: 0 };
  let cameraOrigin = { x: 0, y: 0 };
  let spaceDown = false;
  let tuningOpen = true;
  let pointerType = 'mouse';
  let livePressure = 0;
  let raf = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;

  let camera: Camera = { x: 0, y: 0, zoom: 1 };
  let settings: InkSettings = {
    attractionRadiusPx: 18,
    correctionStrength: 0.72,
    newStrokePull: 0.08,
    directionTolerance: 0.48,
    baseWidth: 2.2
  };

  let history: InkStroke[][] = [[]];
  let historyIndex = 0;

  const activeTouches = new Map<number, { x: number; y: number }>();
  let touchGesture: { centroid: { x: number; y: number }; distance: number } | null = null;

  function cloneStrokes(value: InkStroke[]): InkStroke[] {
    return value.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point }))
    }));
  }

  function requestRender(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }

  function canvasPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function screenToWorld(point: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (point.x - camera.x) / camera.zoom,
      y: (point.y - camera.y) / camera.zoom
    };
  }

  function pressureFor(event: PointerEvent): number {
    if (event.pointerType === 'pen') {
      return clamp(event.pressure || 0.35, 0.04, 1);
    }
    return 0.5;
  }

  function appendPointerSample(event: PointerEvent): void {
    const screen = canvasPoint(event);
    const world = screenToWorld(screen);
    const point: InkPoint = {
      ...world,
      pressure: pressureFor(event),
      time: event.timeStamp
    };

    livePressure = point.pressure;
    const previous = activeStroke[activeStroke.length - 1];
    if (previous && distance(previous, point) * camera.zoom < 0.65) return;
    activeStroke = [...activeStroke, point];
  }

  function updatePreview(): void {
    if (bypassMagnetism || activeStroke.length < 2) {
      previewCandidate = null;
      previewStroke = activeStroke;
      requestRender();
      return;
    }

    previewCandidate = findCorrectionCandidate(activeStroke, strokes, settings, camera.zoom);
    previewStroke = previewCandidate
      ? guideIncomingStroke(activeStroke, strokes[previewCandidate.strokeIndex].points, settings, camera.zoom)
      : activeStroke;
    requestRender();
  }

  function beginDrawing(event: PointerEvent): void {
    drawingPointerId = event.pointerId;
    pointerType = event.pointerType;
    bypassMagnetism = event.altKey || (event.buttons & 2) !== 0;
    activeStroke = [];
    previewStroke = [];
    previewCandidate = null;
    canvas.setPointerCapture(event.pointerId);
    appendPointerSample(event);
    updatePreview();
  }

  function finishDrawing(event: PointerEvent): void {
    if (drawingPointerId !== event.pointerId) return;

    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    const spacing = 1.8 / camera.zoom;
    const incoming = softenStroke(resampleStroke(activeStroke, spacing), 0.08, 1);
    let next = cloneStrokes(strokes);

    if (incoming.length >= 2) {
      const candidate = bypassMagnetism
        ? null
        : findCorrectionCandidate(incoming, next, settings, camera.zoom);

      if (candidate) {
        next[candidate.strokeIndex] = correctStroke(
          next[candidate.strokeIndex],
          incoming,
          settings,
          camera.zoom
        );
      } else {
        next.push({
          id: crypto.randomUUID(),
          points: incoming,
          createdAt: Date.now(),
          revisions: 0
        });
      }

      commit(next);
    }

    drawingPointerId = null;
    activeStroke = [];
    previewStroke = [];
    previewCandidate = null;
    livePressure = 0;
    bypassMagnetism = false;
    requestRender();
  }

  function handlePointerDown(event: PointerEvent): void {
    event.preventDefault();
    pointerType = event.pointerType;

    if (event.pointerType === 'touch') {
      activeTouches.set(event.pointerId, canvasPoint(event));
      resetTouchGesture();
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button === 1 || spaceDown) {
      isPanning = true;
      panPointerId = event.pointerId;
      panOrigin = canvasPoint(event);
      cameraOrigin = { x: camera.x, y: camera.y };
      canvas.setPointerCapture(event.pointerId);
      requestRender();
      return;
    }

    if (event.pointerType === 'pen' || event.button === 0 || event.button === 2) {
      beginDrawing(event);
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch' && activeTouches.has(event.pointerId)) {
      activeTouches.set(event.pointerId, canvasPoint(event));
      updateTouchGesture();
      return;
    }

    if (isPanning && panPointerId === event.pointerId) {
      const current = canvasPoint(event);
      camera = {
        ...camera,
        x: cameraOrigin.x + current.x - panOrigin.x,
        y: cameraOrigin.y + current.y - panOrigin.y
      };
      requestRender();
      return;
    }

    if (drawingPointerId !== event.pointerId) return;

    const samples = event.getCoalescedEvents?.() ?? [event];
    for (const sample of samples) appendPointerSample(sample);
    bypassMagnetism = bypassMagnetism || event.altKey || (event.buttons & 2) !== 0;
    updatePreview();
  }

  function handlePointerUp(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      activeTouches.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      resetTouchGesture();
      return;
    }

    if (isPanning && panPointerId === event.pointerId) {
      isPanning = false;
      panPointerId = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      requestRender();
      return;
    }

    finishDrawing(event);
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      activeTouches.delete(event.pointerId);
      resetTouchGesture();
      return;
    }

    if (drawingPointerId === event.pointerId) {
      drawingPointerId = null;
      activeStroke = [];
      previewStroke = [];
      previewCandidate = null;
      requestRender();
    }

    if (panPointerId === event.pointerId) {
      isPanning = false;
      panPointerId = null;
    }
  }

  function touchMetrics(): { centroid: { x: number; y: number }; distance: number } | null {
    const points = [...activeTouches.values()];
    if (points.length === 0) return null;

    const centroid = points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 }
    );

    const touchDistance = points.length >= 2 ? distance(points[0] as InkPoint, points[1] as InkPoint) : 0;
    return { centroid, distance: touchDistance };
  }

  function resetTouchGesture(): void {
    touchGesture = touchMetrics();
  }

  function updateTouchGesture(): void {
    const current = touchMetrics();
    if (!current) {
      touchGesture = null;
      return;
    }

    if (!touchGesture) {
      touchGesture = current;
      return;
    }

    if (activeTouches.size === 1 || touchGesture.distance === 0 || current.distance === 0) {
      camera = {
        ...camera,
        x: camera.x + current.centroid.x - touchGesture.centroid.x,
        y: camera.y + current.centroid.y - touchGesture.centroid.y
      };
    } else {
      const worldAtPreviousCentroid = screenToWorld(touchGesture.centroid);
      const nextZoom = clamp(camera.zoom * (current.distance / touchGesture.distance), 0.12, 24);
      camera = {
        zoom: nextZoom,
        x: current.centroid.x - worldAtPreviousCentroid.x * nextZoom,
        y: current.centroid.y - worldAtPreviousCentroid.y * nextZoom
      };
    }

    touchGesture = current;
    requestRender();
  }

  function zoomAt(screen: { x: number; y: number }, targetZoom: number): void {
    const nextZoom = clamp(targetZoom, 0.12, 24);
    const world = screenToWorld(screen);
    camera = {
      zoom: nextZoom,
      x: screen.x - world.x * nextZoom,
      y: screen.y - world.y * nextZoom
    };
    updatePreview();
    requestRender();
  }

  function handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const point = canvasPoint(event);
    const factor = Math.exp(-event.deltaY * 0.0016);
    zoomAt(point, camera.zoom * factor);
  }

  function zoomBy(factor: number): void {
    zoomAt({ x: canvasWidth / 2, y: canvasHeight / 2 }, camera.zoom * factor);
  }

  function resetView(): void {
    camera = { x: 0, y: 0, zoom: 1 };
    requestRender();
  }

  function commit(next: InkStroke[]): void {
    let nextHistory = history.slice(0, historyIndex + 1);
    nextHistory.push(cloneStrokes(next));

    if (nextHistory.length > MAX_HISTORY) nextHistory = nextHistory.slice(-MAX_HISTORY);

    history = nextHistory;
    historyIndex = history.length - 1;
    strokes = next;
    persist();
    requestRender();
  }

  function undo(): void {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    strokes = cloneStrokes(history[historyIndex]);
    persist();
    requestRender();
  }

  function redo(): void {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    strokes = cloneStrokes(history[historyIndex]);
    persist();
    requestRender();
  }

  function clearCanvas(): void {
    if (strokes.length === 0) return;
    commit([]);
  }

  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ strokes, settings }));
  }

  function restore(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as { strokes?: InkStroke[]; settings?: Partial<InkSettings> };
      strokes = parsed.strokes ?? [];
      settings = { ...settings, ...parsed.settings };
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function exportPng(): void {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `b-line-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  function drawStroke(
    context: CanvasRenderingContext2D,
    points: InkPoint[],
    color: string,
    alpha = 1,
    widthScale = 1
  ): void {
    if (points.length === 0) return;

    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.globalAlpha = alpha;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (points.length === 1) {
      const radius = settings.baseWidth * (0.35 + points[0].pressure * 1.45) * widthScale * 0.5;
      context.beginPath();
      context.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
      return;
    }

    for (let index = 1; index < points.length; index += 1) {
      const before = points[index - 1];
      const point = points[index];
      const pressure = (before.pressure + point.pressure) / 2;
      context.lineWidth = settings.baseWidth * (0.38 + pressure * 1.55) * widthScale;
      context.beginPath();
      context.moveTo(before.x, before.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }

    context.restore();
  }

  function render(): void {
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvasWidth, canvasHeight);
    context.fillStyle = '#f7f7f5';
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    context.save();
    context.translate(camera.x, camera.y);
    context.scale(camera.zoom, camera.zoom);

    for (const stroke of strokes) {
      drawStroke(context, stroke.points, '#111111');
    }

    if (previewCandidate) {
      const target = strokes[previewCandidate.strokeIndex];
      context.save();
      context.shadowColor = 'rgba(119, 92, 190, 0.28)';
      context.shadowBlur = 18 / camera.zoom;
      drawStroke(context, target.points, '#111111', 0.42, 1.12);
      context.restore();
    }

    if (activeStroke.length > 0) {
      if (previewCandidate) {
        drawStroke(context, activeStroke, '#5f5f62', 0.18, 0.9);
        drawStroke(context, previewStroke, '#171717', 0.82);
      } else {
        drawStroke(context, activeStroke, '#171717', bypassMagnetism ? 0.72 : 0.9);
      }
    }

    context.restore();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const command = event.metaKey || event.ctrlKey;

    if (event.code === 'Space') {
      spaceDown = true;
      event.preventDefault();
    }

    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }

    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }

    if (event.key === '0') resetView();
    if (event.key === '+' || event.key === '=') zoomBy(1.2);
    if (event.key === '-') zoomBy(1 / 1.2);
  }

  function handleKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') spaceDown = false;
  }

  onMount(() => {
    restore();
    history = [cloneStrokes(strokes)];
    historyIndex = 0;

    const resizeObserver = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvasWidth = rect.width;
      canvasHeight = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      requestRender();
    });

    resizeObserver.observe(canvas);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    requestRender();

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener('wheel', handleWheel);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<svelte:head>
  <title>B-Line</title>
  <meta name="description" content="Never erase. Always create." />
</svelte:head>

<div class="app" class:is-panning={isPanning || spaceDown}>
  <canvas
    bind:this={canvas}
    aria-label="B-Line drawing canvas"
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerCancel}
  ></canvas>

  <header class="topbar">
    <div class="brand">
      <strong>B-Line</strong>
      <span class="brand-dot">•</span>
      <span class="tagline">Never erase. Always create.</span>
    </div>

    <div class="actions">
      <button class="icon-button" onclick={undo} disabled={historyIndex <= 0} aria-label="Undo" title="Undo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M5 12h9a6 6 0 0 1 6 6" /></svg>
      </button>
      <button class="icon-button" onclick={redo} disabled={historyIndex >= history.length - 1} aria-label="Redo" title="Redo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 7 5 5-5 5M19 12h-9a6 6 0 0 0-6 6" /></svg>
      </button>

      <span class="separator"></span>

      <div class="zoom-control">
        <button onclick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
        <button class="zoom-value" onclick={resetView} title="Reset view">{Math.round(camera.zoom * 100)}%</button>
        <button onclick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
      </div>

      <button class="icon-button" onclick={exportPng} aria-label="Export PNG" title="Export PNG">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0L8 7m4-4 4 4M5 12v8h14v-8" /></svg>
      </button>
    </div>
  </header>

  <div class="field-wrap">
    {#if tuningOpen}
      <section class="field-panel" aria-label="Magnetic field controls">
        <div class="panel-heading">
          <div>
            <span>Magnetic field</span>
            <strong>{Math.round(settings.attractionRadiusPx)} px</strong>
          </div>
          <button class="close-button" onclick={() => (tuningOpen = false)} aria-label="Close controls">×</button>
        </div>

        <label>
          <span>Reach</span>
          <input
            type="range"
            min="6"
            max="42"
            step="1"
            bind:value={settings.attractionRadiusPx}
            oninput={() => { persist(); updatePreview(); }}
          />
        </label>

        <label>
          <span>Yield</span>
          <input
            type="range"
            min="0.1"
            max="0.95"
            step="0.01"
            bind:value={settings.correctionStrength}
            oninput={() => { persist(); updatePreview(); }}
          />
        </label>

        <label>
          <span>Guidance</span>
          <input
            type="range"
            min="0"
            max="0.28"
            step="0.01"
            bind:value={settings.newStrokePull}
            oninput={() => { persist(); updatePreview(); }}
          />
        </label>

        <div class="panel-footer">
          <span>{pointerType}{livePressure > 0 ? ` · ${Math.round(livePressure * 100)}%` : ''}</span>
          <button onclick={clearCanvas} disabled={strokes.length === 0}>Clear</button>
        </div>
      </section>
    {:else}
      <button class="field-button" onclick={() => (tuningOpen = true)} aria-label="Open magnetic field controls" title="Magnetic field">
        <span></span>
      </button>
    {/if}
  </div>

  {#if strokes.length === 0 && activeStroke.length === 0}
    <div class="instruction">
      <strong>Draw a line.</strong>
      <span>Draw it again.</span>
      <small>Pinch or scroll to zoom · One finger or Space to pan · Alt or pen button keeps lines independent</small>
    </div>
  {/if}

  <div class="zoom-note" class:visible={camera.zoom > 1.02}>
    Attraction remains {Math.round(settings.attractionRadiusPx)} screen pixels at every zoom.
  </div>
</div>

<style>
  .app {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: #f7f7f5;
    user-select: none;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    cursor: crosshair;
  }

  .is-panning canvas {
    cursor: grabbing;
  }

  .topbar {
    position: absolute;
    top: max(12px, env(safe-area-inset-top));
    left: max(16px, env(safe-area-inset-left));
    right: max(16px, env(safe-area-inset-right));
    height: 54px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 0 12px 0 18px;
    border: 1px solid rgba(20, 20, 20, 0.055);
    border-radius: 18px;
    background: rgba(250, 250, 248, 0.76);
    box-shadow: 0 14px 40px rgba(20, 20, 20, 0.045);
    backdrop-filter: blur(22px) saturate(1.1);
    -webkit-backdrop-filter: blur(22px) saturate(1.1);
  }

  .brand,
  .actions,
  .zoom-control {
    display: flex;
    align-items: center;
  }

  .brand {
    gap: 14px;
    min-width: 0;
  }

  .brand strong {
    font-size: 17px;
    letter-spacing: 0.03em;
  }

  .brand-dot,
  .tagline {
    color: #9a9a96;
  }

  .tagline {
    font-size: 12px;
    white-space: nowrap;
  }

  .actions {
    gap: 4px;
  }

  button {
    border: 0;
    background: none;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.22;
    cursor: default;
  }

  .icon-button {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: 12px;
  }

  .icon-button:not(:disabled):hover,
  .zoom-control button:hover,
  .close-button:hover {
    background: rgba(10, 10, 10, 0.055);
  }

  .icon-button svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.55;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .separator {
    width: 1px;
    height: 22px;
    margin: 0 8px;
    background: rgba(20, 20, 20, 0.09);
  }

  .zoom-control {
    height: 38px;
    padding: 0 4px;
    border: 1px solid rgba(20, 20, 20, 0.07);
    border-radius: 13px;
    background: rgba(255, 255, 255, 0.54);
  }

  .zoom-control button {
    height: 30px;
    min-width: 30px;
    border-radius: 9px;
    font-size: 17px;
  }

  .zoom-control .zoom-value {
    min-width: 56px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .field-wrap {
    position: absolute;
    right: max(26px, env(safe-area-inset-right));
    top: 96px;
  }

  .field-panel {
    width: 218px;
    padding: 18px;
    border: 1px solid rgba(20, 20, 20, 0.06);
    border-radius: 22px;
    background: rgba(250, 250, 248, 0.82);
    box-shadow: 0 22px 60px rgba(30, 24, 45, 0.08);
    backdrop-filter: blur(24px) saturate(1.15);
    -webkit-backdrop-filter: blur(24px) saturate(1.15);
  }

  .panel-heading,
  .panel-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-heading {
    margin-bottom: 18px;
  }

  .panel-heading div {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .panel-heading span,
  label span,
  .panel-footer {
    color: #868681;
    font-size: 10px;
    letter-spacing: 0.025em;
  }

  .panel-heading strong {
    font-size: 14px;
    font-weight: 520;
  }

  .close-button {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    color: #8c8c87;
    font-size: 18px;
  }

  label {
    display: grid;
    grid-template-columns: 58px 1fr;
    align-items: center;
    gap: 8px;
    margin: 13px 0;
  }

  input[type='range'] {
    width: 100%;
    height: 2px;
    margin: 0;
    appearance: none;
    border-radius: 99px;
    background: linear-gradient(90deg, #222, #a78ee0);
    outline: none;
  }

  input[type='range']::-webkit-slider-thumb {
    width: 13px;
    height: 13px;
    appearance: none;
    border: 3px solid #f7f7f5;
    border-radius: 50%;
    background: #171717;
    box-shadow: 0 2px 8px rgba(20, 20, 20, 0.25);
  }

  input[type='range']::-moz-range-thumb {
    width: 8px;
    height: 8px;
    border: 3px solid #f7f7f5;
    border-radius: 50%;
    background: #171717;
    box-shadow: 0 2px 8px rgba(20, 20, 20, 0.25);
  }

  .panel-footer {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid rgba(20, 20, 20, 0.07);
  }

  .panel-footer button {
    padding: 6px 9px;
    border-radius: 8px;
    color: #555550;
    font-size: 10px;
  }

  .panel-footer button:hover:not(:disabled) {
    background: rgba(10, 10, 10, 0.055);
  }

  .field-button {
    width: 46px;
    height: 46px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(20, 20, 20, 0.06);
    border-radius: 16px;
    background: rgba(250, 250, 248, 0.82);
    box-shadow: 0 16px 44px rgba(30, 24, 45, 0.08);
    backdrop-filter: blur(20px);
  }

  .field-button span {
    width: 19px;
    height: 19px;
    border: 1.5px solid #89828f;
    border-radius: 50%;
    box-shadow: inset 4px 0 5px rgba(160, 128, 219, 0.42), 4px 0 8px rgba(160, 128, 219, 0.2);
  }

  .instruction {
    position: absolute;
    left: 50%;
    top: 52%;
    display: flex;
    flex-direction: column;
    align-items: center;
    transform: translate(-50%, -50%);
    color: #a0a09b;
    pointer-events: none;
  }

  .instruction strong {
    color: #292927;
    font-size: clamp(24px, 4vw, 48px);
    font-weight: 440;
    letter-spacing: -0.035em;
  }

  .instruction span {
    margin-top: 4px;
    font-size: clamp(16px, 2vw, 24px);
    font-weight: 360;
  }

  .instruction small {
    max-width: 520px;
    margin-top: 24px;
    font-size: 10px;
    line-height: 1.5;
    text-align: center;
  }

  .zoom-note {
    position: absolute;
    left: 50%;
    bottom: max(18px, env(safe-area-inset-bottom));
    padding: 8px 12px;
    transform: translate(-50%, 10px);
    border: 1px solid rgba(20, 20, 20, 0.05);
    border-radius: 99px;
    background: rgba(250, 250, 248, 0.75);
    color: #8f8f8a;
    font-size: 9px;
    opacity: 0;
    transition: 180ms ease;
    pointer-events: none;
    backdrop-filter: blur(18px);
  }

  .zoom-note.visible {
    transform: translate(-50%, 0);
    opacity: 1;
  }

  @media (max-width: 720px) {
    .topbar {
      height: 48px;
      padding-left: 14px;
    }

    .tagline,
    .brand-dot,
    .separator,
    .actions > .icon-button:nth-child(2) {
      display: none;
    }

    .brand strong {
      font-size: 15px;
    }

    .icon-button {
      width: 34px;
      height: 34px;
    }

    .zoom-control {
      height: 34px;
    }

    .zoom-control button {
      height: 28px;
      min-width: 26px;
    }

    .zoom-control .zoom-value {
      min-width: 46px;
    }

    .field-wrap {
      top: auto;
      right: max(16px, env(safe-area-inset-right));
      bottom: max(18px, env(safe-area-inset-bottom));
    }

    .field-panel {
      width: min(218px, calc(100vw - 32px));
    }

    .zoom-note {
      display: none;
    }

    .instruction small {
      max-width: 300px;
    }
  }
</style>
