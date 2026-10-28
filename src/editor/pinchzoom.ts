/** 指针锚定的滚轮 / 捏合缩放：排版区（`main.ts::wireZoomControls`）与并排原图栏共用。
 *  以触点为中心，缩放后让触点下的内容点保持在原屏幕位置。连续的滚轮/捏合事件累积到 pending，
 *  按 rAF 每帧只应用一次——避免每个事件都触发一次「改 CSS 变量 → 强制同步布局」的抖动。 */
export interface PinchZoomOptions {
  /** 当前缩放（绝对值） */
  get(): number;
  /** 设缩放（夹取由调用方做）；调完要同步生效，锚定紧接着读包围盒 */
  set(z: number): void;
  /** 锚点按页找：页内内容等比缩放，基于页自身的包围盒锚定，天然规避容器的居中/内边距偏移 */
  pages(): Iterable<Element>;
  /** 每帧应用完调（排版区刷百分比标签） */
  onChange?(): void;
  /** 触屏双指捏合（没有 WebKit gesture* 的浏览器）也接：两指距离比 × 起手时的缩放 */
  touch?: boolean;
}

export function attachPinchZoom(pane: HTMLElement, opts: PinchZoomOptions): void {
  let pendingZoom: number | null = null; // 目标 zoom（绝对值），null 表示无待处理
  let anchorX = 0, anchorY = 0;
  let rafId = 0;
  // 找触点落在哪一页（缩放前），间隙/页外则取最接近的页
  const anchorPage = (y: number): Element | null => {
    let best: Element | null = null;
    let bestDist = Infinity;
    for (const w of opts.pages()) {
      const rc = w.getBoundingClientRect();
      if (y >= rc.top && y <= rc.bottom) return w;
      const d = y < rc.top ? rc.top - y : y - rc.bottom;
      if (d < bestDist) { bestDist = d; best = w; }
    }
    return best;
  };
  // 内容锚点：一段手势内固定的「页面上的点」（锚定页 + 页内归一化坐标）。
  // 在手势开始时算一次并保持，避免低 zoom 居中阶段页位置变化污染归一化坐标；
  // 当前手指屏幕坐标 (anchorX/anchorY) 每个事件更新，故捏合平移时内容随手指走。
  let gAnchor: { page: Element; fx: number; fy: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const beginOrKeepAnchor = (clientX: number, clientY: number) => {
    if (!gAnchor) {
      const page = anchorPage(clientY);
      if (page) {
        const rc = page.getBoundingClientRect();
        gAnchor = { page, fx: (clientX - rc.left) / rc.width, fy: (clientY - rc.top) / rc.height };
      }
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { gAnchor = null; }, 250); // 手势空闲即结束
  };
  const flushZoom = () => {
    rafId = 0;
    if (pendingZoom === null) return;
    opts.set(pendingZoom);
    pendingZoom = null;
    if (gAnchor) {
      // 同步读取缩放后的包围盒，调整滚动让固定的内容点回到当前手指屏幕坐标
      const post = gAnchor.page.getBoundingClientRect();
      const wantLeft = anchorX - gAnchor.fx * post.width;
      const wantTop = anchorY - gAnchor.fy * post.height;
      pane.scrollLeft += post.left - wantLeft;
      pane.scrollTop += post.top - wantTop;
    }
    opts.onChange?.();
  };
  const scheduleZoom = (target: number, clientX: number, clientY: number) => {
    pendingZoom = target;
    anchorX = clientX;
    anchorY = clientY;
    beginOrKeepAnchor(clientX, clientY);
    if (!rafId) rafId = requestAnimationFrame(flushZoom);
  };

  // Chromium/Edge：捏合与 Ctrl+滚轮都表现为 ctrlKey 的 wheel 事件。
  pane.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const base = pendingZoom ?? opts.get();
    scheduleZoom(base * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });

  // WebKit/WKWebView（Tauri macOS）：触控板双指捏合走 gesture* 事件，带绝对 scale。
  let gestureBase = 1;
  type GEvt = Event & { scale: number; clientX: number; clientY: number };
  pane.addEventListener("gesturestart", (ev) => {
    const e = ev as GEvt;
    e.preventDefault();
    gestureBase = opts.get();
    gAnchor = null; // 新捏合以新的双指中心为锚
  });
  pane.addEventListener("gesturechange", (ev) => {
    const e = ev as GEvt;
    e.preventDefault();
    scheduleZoom(gestureBase * e.scale, e.clientX, e.clientY);
  });
  pane.addEventListener("gestureend", (ev) => ev.preventDefault());

  // 触屏双指（没有 gesture* 的浏览器，如 Android Chrome；iOS 走上面的 gesture*）：
  // 用 touch 事件而不是 pointer——单指平移交给浏览器原生滚动，pointer 会在浏览器接手时被 pointercancel 掉。
  // 两指时 touchmove 取消默认，免得整页跟着缩放
  if (!opts.touch || "ongesturestart" in window) return;
  let touchBase: { zoom: number; dist: number } | null = null;
  const spread = (t: TouchList) => {
    const a = t[0]!, b = t[1]!;
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
  };
  pane.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2) return;
    touchBase = { zoom: opts.get(), dist: spread(e.touches).dist };
    gAnchor = null;
  }, { passive: true });
  pane.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 2) return;
    // 三指抬成两指不会再来 touchstart：第一次两指的 move 起基准
    if (!touchBase) {
      touchBase = { zoom: opts.get(), dist: spread(e.touches).dist };
      gAnchor = null;
    }
    if (touchBase.dist < 1) return;
    e.preventDefault();
    const s = spread(e.touches);
    scheduleZoom(touchBase.zoom * (s.dist / touchBase.dist), s.cx, s.cy);
  }, { passive: false });
  pane.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) touchBase = null;
  }, { passive: true });
}
