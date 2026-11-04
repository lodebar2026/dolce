// **像素内核的可注入后端**（同排版量字的注入做法，见 docs/架构.md A2）：连通域、形态学这类纯像素计算，
// 缺省走 TS 实现；Node 侧（回归、命令行）装上 Rust 原生模块（`native/omrkernels`，`src/cli/omrkernels.node.ts` 加载）就改走它。
// 两边结果逐项相同（`dev/tests/omrkit/kernels.test.ts` 比对），改一边必须改另一边。
// 只放纯像素、无回调的函数；识别判据一律留在 TS（A3）。

/** 原生后端提供的内核（缺哪个就那个走 TS）。缓冲区都是调用方的：就地写的直接写进去。 */
export interface PixelKernels {
  /** `ccl.ts::connectedComponents`：写 `labels`，返回扁平块表 `[id, x, y, w, h, area, cx, cy] * n`。 */
  connectedComponents?(data: Uint8Array, w: number, h: number, minArea: number, labels: Int32Array): Float64Array;
  /** `morph.ts::ellipseOpen`：返回新图。 */
  ellipseOpen?(data: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array;
  /** `morph.ts::boxMorph`：就地膨胀 / 腐蚀。 */
  boxMorph?(data: Uint8Array, w: number, h: number, r: number, dilate: boolean): void;
  /** `rasteromr/prims.ts::runLengths`：逐像素所在墨游程的长度。 */
  runLengths?(data: Uint8Array, w: number, h: number, vertical: boolean): Uint16Array;
  /** `rasteromr/contour.ts` 逐块特征：`boxes` 为 `[id, x, y, w, h] * n`，返回 `[孔数, 最大孔面积, 周长] * n`。 */
  contourFeatures?(labels: Int32Array, w: number, h: number, boxes: Int32Array): Int32Array;
  /** `rasteromr/contour.ts::findHoles`：返回 `[x, y, w, h] * n`。 */
  findHoles?(data: Uint8Array, w: number, h: number, minArea: number): Int32Array;
  /** `rasteromr/contour.ts::holeSolidity`。 */
  holeSolidity?(data: Uint8Array, w: number, x: number, y: number, bw: number, bh: number): number;
  /** `preprocess.ts::toGray`（`px` 是逐字节像素）。 */
  toGray?(px: Uint8Array, w: number, h: number, step: number): Uint8Array;
  /** `preprocess.ts::sauvolaMulti`：`out` 长 `ks.length * w * h`，第 j 档写第 j 段。 */
  sauvolaMulti?(gray: Uint8Array, w: number, h: number, r: number, ks: Float64Array, out: Uint8Array): void;
  /** `rasteromr/rasterpage.ts::upsample`。 */
  upsample?(gray: Uint8Array, w: number, h: number, up: number): Uint8Array;
  /** `rasteromr/headmask.ts::scoreAt`（模板 `p` 为 `mw×mh`）。 */
  scoreAt?(data: Uint8Array, w: number, h: number, p: Float32Array, mw: number, mh: number, cx: number, cy: number): number;
  /** `rasteromr/headmask.ts::scoreAtMasked`（没给干传 NaN）。 */
  scoreAtMasked?(data: Uint8Array, w: number, h: number, p: Float32Array, mw: number, mh: number, cx: number, cy: number, stemX: number, stemHalf: number): number;
  /** `rasteromr/descreen.ts::halftoneRatio` 的计数：返回 `[墨点数, 孤立点数]`；`rows`（长 h）、`onLine`（长 w×h）传空数组 = 不限。 */
  halftoneCounts?(data: Uint8Array, w: number, h: number, rows: Uint8Array, onLine: Uint8Array): Float64Array;
  /** `rasteromr/descreen.ts::pinholeRatio` 的计数：返回 `[墨点数, 针孔数]`。 */
  pinholeCounts?(data: Uint8Array, w: number, h: number, rows: Uint8Array): Float64Array;
  /** `rasteromr/descreen.ts::dropSpecks`：就地抹，返回孤点过密的块数。 */
  dropSpecks?(data: Uint8Array, w: number, h: number, min: number, tile: number): number;
  /** `rasteromr/rasterpage.ts::mergeHorizontal`：就地补 `bin`。 */
  mergeHorizontal?(bin: Uint8Array, soft: Uint8Array, w: number, h: number, minRun: number, maxThick: number, gapTol: number): void;
}

let kernels: PixelKernels | null = null;

/** 装上（或 `null` 卸下）原生后端。每个线程各装各的（worker_threads、Web Worker 里模块状态不共享）。 */
export function setPixelKernels(k: PixelKernels | null): void {
  kernels = k;
}

/** 当前的原生后端；没装为 null。 */
export function pixelKernels(): PixelKernels | null {
  return kernels;
}
