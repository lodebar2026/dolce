// contour 层：把去谱线图上的**每一团墨**当作一个对象单位，连同它的形状特征记下来。
//
// 与 `prims.ts::findBlobs` 的分工——那一路是**减掉笔画之后**的连通块（符头、谱号、
// 字），是识别的输入；这一路在**减笔画之前**取轮廓，一团墨就是一个 contour
// （符头 + 符干 + 符尾连在一起是**一个** contour，松叶的一条臂也是一个）。
//
// 为什么要它：现有的每一个数量的都是「认出来的对不对」（音符 68.1%、符头认领率
// 97.4%），**没有一个数量得出「印在纸上而我们从没看见的那些」**——松叶、力度、
// 表情文字至今一个不认，报表上不留任何痕迹。给每团墨编上号、记下谁认领了它，
// 剩下的那些就是「无主 contour」，那才是往后取舍的证据。
//
// **本文件不参与任何识别判据**：只描述，不裁决。
import type { Binary, Component, Rect } from "../omrkit/types";
import { connectedComponents } from "../omrkit/ccl";
import { pixelKernels } from "../omrkit/kernels";
import type { RasterUnit } from "./staffline";

/** 一团墨的描述。尺寸一律**归一到线距**（同一页可能有两种谱表大小）。 */
export interface Contour {
  /** 与 `comp.id` 同一个号（`connectedComponents` 给的）。 */
  id: number;
  bbox: Rect;
  /** 前景像素数。 */
  area: number;
  /** 墨心（像素坐标）。 */
  cx: number;
  cy: number;
  /** 归一到线距的宽高。 */
  w: number;
  h: number;
  /** 填充率：墨 / 包围盒。 */
  fill: number;
  /** 孔洞数（盒内够不着边界的背景团）。空心符头 1、实心 0、降号 1、字母 a/b/e/o 1。 */
  holes: number;
  /** 最大孔洞的面积占盒的比例。 */
  holeFill: number;
  /** 边界像素数（八邻域里有背景或出界的前景像素）。 */
  perim: number;
  /** 团状度 `4π·area / perim²`：圆是 1、细长条趋近 0。松叶的臂、连音线极小。 */
  compact: number;
  /** 相对谱表的位置。 */
  place: ContourPlace;
}

/** 一团墨落在哪儿。判位置用的档，不是判身份。 */
export interface ContourPlace {
  /** 最近的那行谱（`staves` 的下标）；一行谱都没有时 -1。 */
  staff: number;
  /** 与那行谱的关系：带内 / 上方 / 下方。 */
  zone: "in" | "above" | "below";
  /** 离那行谱的带（第一线~第五线）有几个线距；带内为 0。 */
  gap: number;
}

/** 谱行的纵向范围（定位置用）。 */
export interface ContourStaff {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 弯、斜谱行在 x 处的谱线相对 `top` / `bottom` 的偏移（`staffline.ts::liftOf`）；平直的没有。 */
  lift?: (x: number) => number;
}

/** 一页的 contour 层：轮廓表 + 像素→id 查表。 */
export interface ContourMap {
  contours: Contour[];
  /** 逐像素的 contour id（0 = 背景）。认领时按盒查这张表。 */
  labels: Int32Array;
  w: number;
  h: number;
  /** 全页墨迹像素数（覆盖率的分母）。 */
  ink: number;
  byId: Map<number, Contour>;
}

/**
 * 抽出一页的 contour 层。
 *
 * @param bin **去谱线之后**的图（`removeStaffLines` 的产物）。不能拿原图：
 *            五条谱线把整行谱的符头符干小节线全连成一团，一页就剩十几个 contour。
 * @param staves 谱行的纵向范围，用来给每团墨定位置；没有也能跑（`place.staff = -1`）。
 */
export function traceContours(bin: Binary, unit: RasterUnit, staves: ContourStaff[] = []): ContourMap {
  const { w, h, data } = bin;
  let ink = 0;
  for (let i = 0; i < data.length; i++) if (data[i]) ink++;
  // 面积下限取得很低（4 px）：无主统计要的是**全部**没被解释的墨，
  // 识别那边的尺寸闸不该在这里预先滤掉——滤掉就看不见了。
  const labels = new Int32Array(w * h);
  // 标号图由 `connectedComponents` 顺手落下来（`out` 参数）。**不能自己再 flood 一遍**：
  // 面积不到下限的小块在那边被丢掉、却仍占着像素，照「盒里第一个没标号的前景像素」
  // 找种子会种到那种小块上，整团墨的标号就空了（实测有 35 个块的周长因此掉到个位数、
  // 团状度算出 480）。
  const comps = connectedComponents(bin, 4, labels);
  // 逐块的孔数、周长：有原生内核就整页一次算完（逐块过边界太碎），没有就逐块现量
  const nk = pixelKernels()?.contourFeatures;
  let feats: Int32Array | null = null;
  if (nk) {
    const boxes = new Int32Array(comps.length * 5);
    comps.forEach((c, i) => boxes.set([c.id, c.bbox.x, c.bbox.y, c.bbox.w, c.bbox.h], i * 5));
    feats = nk(labels, w, h, boxes);
  }
  const contours = comps.map((c, i) => describe(bin, labels, c, unit, staves, feats && { holes: feats[i * 3], biggest: feats[i * 3 + 1], perim: feats[i * 3 + 2] }));
  const byId = new Map(contours.map((c) => [c.id, c]));
  return { contours, labels, w, h, ink, byId };
}

/**
 * 修补图（`prims.ts::repairLineCuts`）上的 contour 层，连同每块由去线图上哪几块碎块组成（按像素对：修补块里落着的 `cmap` 标号）。
 * 一页只取一次，各路按自己那一刻的候选集合从里面挑整块（`candidateMap`）。
 */
export interface RepairedLayer {
  rmap: ContourMap;
  /** 修补块 id → 组成它的去线图碎块 id。 */
  parts: Map<number, number[]>;
}

export function repairedLayer(cmap: ContourMap, repaired: Binary, unit: RasterUnit, staves: ContourStaff[] = []): RepairedLayer {
  const rmap = traceContours(repaired, unit, staves);
  const sets = new Map<number, Set<number>>();
  for (let i = 0; i < rmap.labels.length; i++) {
    const r = rmap.labels[i];
    if (!r) continue;
    let set = sets.get(r);
    if (!set) sets.set(r, (set = new Set()));
    const c = cmap.labels[i];
    if (c) set.add(c);
  }
  return { rmap, parts: new Map([...sets].map(([r, s]) => [r, [...s]])) };
}

/** 标号图里每个标号的包围盒 [x0, y0, x1, y1]（含面积不到下限、没进 `contours` 的小块）；同一张标号图只扫一次。
 *  标号图建好后不再改（`wedge.ts` 临时挪了也当场还原）。 */
const labelBoxCache = new WeakMap<Int32Array, Map<number, [number, number, number, number]>>();
function labelBoxes(labels: Int32Array, w: number): Map<number, [number, number, number, number]> {
  let m = labelBoxCache.get(labels);
  if (m) return m;
  m = new Map();
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (!id) continue;
    const x = i % w, y = (i / w) | 0;
    const q = m.get(id);
    if (!q) m.set(id, [x, y, x, y]);
    else {
      if (x < q[0]) q[0] = x;
      if (x > q[2]) q[2] = x;
      if (y > q[3]) q[3] = y;
    }
  }
  labelBoxCache.set(labels, m);
  return m;
}

/** 候选 contour 图：整块换进来的修补块（`merged`）与它们各自的碎块（`parts`，按新 id）。 */
export interface CandidateMap {
  map: ContourMap;
  merged: Contour[];
  parts: Map<number, number[]>;
}

/**
 * **候选 contour 图**：被谱线切开的对象不必先切成碎块再拼。修补图上的一块，组成它的去线图碎块**全是候选**（`isCand`）的，
 * 整块换成修补块（新 id 接在 `cmap` 最大 id 之后，标号按修补图的像素写，去线图上有、修补图清掉的谱线残段不归任何块）；
 * 连上了别的东西（符头、干）的修补块不换，碎块照 `cmap` 原样留着。
 * `accept`：修补块本身再过一道（按位置挡掉某类对象不会出现的地方）。
 * `minParts`：至少由几块碎块并成才换（2 = 只换真被谱线切开、修补后连上的；1 = 一块的也换成修补图上的样子，谱线残段清掉）。
 * 认领照旧按盒子查 `cmap` 的标号（`ContourLedger`），合并块的账是它那几块碎块的账。
 */
export function candidateMap(cmap: ContourMap, layer: RepairedLayer, isCand: (id: number) => boolean, minParts = 1, accept: (rc: Contour) => boolean = () => true): CandidateMap {
  const { rmap } = layer;
  let offset = 0;
  for (const c of cmap.contours) offset = Math.max(offset, c.id);
  const whole = new Set<number>();
  const covered = new Set<number>();
  for (const [r, ps] of layer.parts) {
    // 标号图里有、`contours` 里没有的块（`traceContours` 滤掉的小块）不换
    const rc = rmap.byId.get(r);
    if (!rc || ps.length < Math.max(1, minParts) || !ps.every(isCand) || !accept(rc)) continue;
    whole.add(r);
    for (const id of ps) covered.add(id);
  }
  // 只碰相关的盒：先把换掉的碎块清掉，再写修补块（修补块的像素不管原先归谁都写新号）。整页逐像素扫曾占识别耗时 3%
  const labels = new Int32Array(cmap.labels);
  const boxes = labelBoxes(cmap.labels, cmap.w);
  for (const id of covered) {
    const q = boxes.get(id);
    if (!q) continue;
    for (let y = q[1]; y <= q[3]; y++)
      for (let i = y * cmap.w + q[0], e = y * cmap.w + q[2]; i <= e; i++) if (cmap.labels[i] === id) labels[i] = 0;
  }
  for (const r of whole) {
    const q = rmap.byId.get(r)!.bbox;
    for (let y = q.y; y < q.y + q.h; y++)
      for (let i = y * cmap.w + q.x, e = y * cmap.w + q.x + q.w; i < e; i++) if (rmap.labels[i] === r) labels[i] = r + offset;
  }
  const merged = rmap.contours.filter((rc) => whole.has(rc.id)).map((rc) => ({ ...rc, id: rc.id + offset }));
  const contours = [...cmap.contours.filter((c) => !covered.has(c.id)), ...merged];
  const map: ContourMap = { contours, labels, w: cmap.w, h: cmap.h, ink: cmap.ink, byId: new Map(contours.map((c) => [c.id, c])) };
  return { map, merged, parts: new Map(merged.map((m) => [m.id, layer.parts.get(m.id - offset)!])) };
}

/** 逐块量特征。 */
function describe(bin: Binary, labels: Int32Array, c: Component, unit: RasterUnit, staves: ContourStaff[], pre?: { holes: number; biggest: number; perim: number } | null): Contour {
  const b = c.bbox;
  const { holes, holeFill } = pre ? { holes: pre.holes, holeFill: pre.biggest / Math.max(1, b.w * b.h) } : countHoles(labels, bin.w, c);
  const perim = pre ? pre.perim : countPerim(labels, bin.w, bin.h, c);
  return {
    id: c.id,
    bbox: b,
    area: c.area,
    cx: c.cx,
    cy: c.cy,
    w: b.w / unit.space,
    h: b.h / unit.space,
    fill: c.area / Math.max(1, b.w * b.h),
    holes,
    holeFill,
    perim,
    compact: perim > 0 ? (4 * Math.PI * c.area) / (perim * perim) : 0,
    place: placeOf(c, staves, unit),
  };
}

/**
 * 孔洞：在块的**包围盒 + 一圈留白**里对背景做一次 CCL，从盒边界够不着的背景团就是孔。
 *
 * 只数本块自己的孔：盒里可能还压着别的块的像素（相邻符号的盒互相重叠），
 * 那些在这里当**背景**处理——它们连着盒外，够得着边界，不会被误当成孔。
 */
function countHoles(labels: Int32Array, w: number, c: Component): { holes: number; holeFill: number } {
  const b = c.bbox;
  const bw = b.w + 2;
  const bh = b.h + 2;
  // 盒 + 一圈留白里的本块墨；留白那一圈恒为背景。洪泛按 TypedArray 栈、四邻展开（逐块都要算，常数要小）
  const blocked = new Uint8Array(bw * bh);
  for (let y = 1; y < bh - 1; y++) {
    const row = (b.y + y - 1) * w + b.x - 1;
    for (let x = 1; x < bw - 1; x++) if (labels[row + x] === c.id) blocked[y * bw + x] = 1;
  }
  const stack = new Int32Array(bw * bh);
  /** 从 i 起洪泛背景（已看过、墨都算挡住），返回这一团的像素数 */
  const flood = (i: number): number => {
    let n = 0;
    let size = 0;
    blocked[i] = 1;
    stack[n++] = i;
    while (n) {
      const cur = stack[--n];
      size++;
      const y = (cur / bw) | 0;
      const x = cur - y * bw;
      if (x + 1 < bw && !blocked[cur + 1]) (blocked[cur + 1] = 1), (stack[n++] = cur + 1);
      if (x > 0 && !blocked[cur - 1]) (blocked[cur - 1] = 1), (stack[n++] = cur - 1);
      if (y + 1 < bh && !blocked[cur + bw]) (blocked[cur + bw] = 1), (stack[n++] = cur + bw);
      if (y > 0 && !blocked[cur - bw]) (blocked[cur - bw] = 1), (stack[n++] = cur - bw);
    }
    return size;
  };
  // 从盒外那一圈把够得着边界的背景全标掉
  flood(0);
  // 剩下的背景团就是孔（小于 3 像素的是噪点）
  let holes = 0;
  let biggest = 0;
  for (let y = 1; y < bh - 1; y++)
    for (let x = 1; x < bw - 1; x++) {
      const i = y * bw + x;
      if (blocked[i]) continue;
      const size = flood(i);
      if (size < 3) continue;
      holes++;
      if (size > biggest) biggest = size;
    }
  return { holes, holeFill: biggest / Math.max(1, b.w * b.h) };
}

/** 边界像素数：八邻域里有一个不是本块的，就算边界。 */
function countPerim(labels: Int32Array, w: number, h: number, c: Component): number {
  const b = c.bbox;
  let n = 0;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (labels[y * w + x] !== c.id) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || labels[ny * w + nx] !== c.id) {
            edge = true;
            break;
          }
        }
      if (edge) n++;
    }
  return n;
}

/** 这团墨落在哪行谱的哪一侧。 */
function placeOf(c: Component, staves: ContourStaff[], unit: RasterUnit): ContourPlace {
  if (!staves.length) return { staff: -1, zone: "below", gap: 0 };
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < staves.length; i++) {
    const st = staves[i];
    const dl = st.lift ? st.lift(c.cx) : 0;
    const d = c.cy < st.top + dl ? st.top + dl - c.cy : c.cy > st.bottom + dl ? c.cy - st.bottom - dl : 0;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const st = staves[best];
  const dl = st.lift ? st.lift(c.cx) : 0;
  const zone = c.cy < st.top + dl ? "above" : c.cy > st.bottom + dl ? "below" : "in";
  return { staff: best, zone, gap: bd / unit.space };
}


/**
 * **全页的孔**：背景里够不着页边的连通团。空心符头的内腔就是它。
 *
 * 为什么值得单独跑一趟：空心符头在位图上最不稳——去谱线会把它的圈切断、
 * 符干残根粘在旁边、叠置的和弦还会碎成四五片（实测宁静 p2 钢琴右手那个二分和弦
 * 碎成 0.66×0.50 / 0.77×1.10 / 0.99×0.39 / 0.83×0.33 四块，一块都判不成符头）。
 * 但**内腔一直在**：外圈再破，只要没破到透，中间那团白就还是围着的。
 * 拿洞去找符头，比拿破碎的外圈去找稳得多。
 *
 * 在**去谱线之前**的图上跑：去谱线会把骑线符头的内腔豁开一道口子，洞就漏了。
 */
export function findHoles(bin: Binary, minArea = 4): Rect[] {
  const { w, h, data } = bin;
  const nk = pixelKernels()?.findHoles;
  if (nk) {
    const f = nk(data, w, h, minArea);
    const out: Rect[] = [];
    for (let i = 0; i < f.length; i += 4) out.push({ x: f[i], y: f[i + 1], w: f[i + 2], h: f[i + 3] });
    return out;
  }
  // 墨与已看过的背景都算挡住；洪泛按 TypedArray 栈、四邻展开（整页洪泛，常数要小）
  const blocked = new Uint8Array(w * h);
  for (let i = 0; i < blocked.length; i++) if (data[i]) blocked[i] = 1;
  const stack = new Int32Array(w * h);
  let n = 0;
  const push = (i: number) => {
    if (!blocked[i]) (blocked[i] = 1), (stack[n++] = i);
  };
  // 先从四边把「通到页外」的背景全标掉
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (n) {
    const cur = stack[--n];
    const y = (cur / w) | 0;
    const x = cur - y * w;
    if (x > 0 && !blocked[cur - 1]) (blocked[cur - 1] = 1), (stack[n++] = cur - 1);
    if (x + 1 < w && !blocked[cur + 1]) (blocked[cur + 1] = 1), (stack[n++] = cur + 1);
    if (y > 0 && !blocked[cur - w]) (blocked[cur - w] = 1), (stack[n++] = cur - w);
    if (y + 1 < h && !blocked[cur + w]) (blocked[cur + w] = 1), (stack[n++] = cur + w);
  }
  // 剩下的背景团就是孔
  const out: Rect[] = [];
  for (let y0 = 0; y0 < h; y0++)
    for (let x0 = 0; x0 < w; x0++) {
      const i = y0 * w + x0;
      if (blocked[i]) continue;
      let minX = x0;
      let maxX = x0;
      let minY = y0;
      let maxY = y0;
      let area = 0;
      blocked[i] = 1;
      stack[n++] = i;
      while (n) {
        const cur = stack[--n];
        const y = (cur / w) | 0;
        const x = cur - y * w;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && !blocked[cur - 1]) (blocked[cur - 1] = 1), (stack[n++] = cur - 1);
        if (x + 1 < w && !blocked[cur + 1]) (blocked[cur + 1] = 1), (stack[n++] = cur + 1);
        if (y > 0 && !blocked[cur - w]) (blocked[cur - w] = 1), (stack[n++] = cur - w);
        if (y + 1 < h && !blocked[cur + w]) (blocked[cur + w] = 1), (stack[n++] = cur + w);
      }
      if (area >= minArea) out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  return out;
}

/**
 * 孔**像不像一个符头的内腔**：有一个内腔大（宽 0.72~1.25 格、高 0.55~1 格），凸（`holeSolidity` ≥ 0.8），
 * 又是椭圆或斜缝、不占满外框（≤ 0.8；符尾、干与谱线围出的空框是方的，占满外框）。真内腔实测凸度 0.88、占外框 0.54~0.58。
 */
export function cavityLike(bin: Binary, r: Rect, sp: number): boolean {
  if (r.w < sp * 0.72 || r.w > sp * 1.25 || r.h < sp * 0.55 || r.h > sp) return false;
  let k = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!bin.data[y * bin.w + x]) k++;
  return k / (r.w * r.h) <= 0.8 && holeSolidity(bin, r) >= 0.8;
}

/**
 * 孔的**凸度**：孔的面积 / 它的凸包面积（凸包按逐行白段的两端算）。孔从盒里离盒心最近的白洪泛，盒角里圈外的白不算。
 * 符头内腔是椭圆或斜缝，都是凸的（合唱谱各份 0.8~0.9）；两侧墙往里鼓的白（降号肚子与全音符左弧之间）是凹的（0.59）。
 * 小孔逐像素量凸包天然偏低（低分辨率页 5~13px 的内腔 0.5~0.7），用的地方要自己卡尺寸。
 */
export function holeSolidity(bin: Binary, b: Rect): number {
  const nk = pixelKernels()?.holeSolidity;
  // 原生版按整数盒取像素：盒有小数的（理论上没有）照旧走下面
  if (nk && Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.w) && Number.isInteger(b.h)) return nk(bin.data, bin.w, b.x, b.y, b.w, b.h);
  const inn = new Uint8Array(b.w * b.h);
  let seed = -1;
  let bd = Infinity;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (bin.data[y * bin.w + x]) continue;
      const d = (x - b.x - b.w / 2) ** 2 + (y - b.y - b.h / 2) ** 2;
      if (d < bd) (bd = d), (seed = (y - b.y) * b.w + x - b.x);
    }
  if (seed < 0) return 0;
  // 洪泛按 TypedArray 栈、四邻展开
  const stack = new Int32Array(b.w * b.h);
  let n = 0;
  stack[n++] = seed;
  inn[seed] = 1;
  let area = 0;
  const open = (q: number, X: number, Y: number) => !inn[q] && !bin.data[(Y + b.y) * bin.w + X + b.x];
  while (n) {
    const k = stack[--n];
    area++;
    const x = k % b.w;
    const y = (k / b.w) | 0;
    if (x + 1 < b.w && open(k + 1, x + 1, y)) (inn[k + 1] = 1), (stack[n++] = k + 1);
    if (x > 0 && open(k - 1, x - 1, y)) (inn[k - 1] = 1), (stack[n++] = k - 1);
    if (y + 1 < b.h && open(k + b.w, x, y + 1)) (inn[k + b.w] = 1), (stack[n++] = k + b.w);
    if (y > 0 && open(k - b.w, x, y - 1)) (inn[k - b.w] = 1), (stack[n++] = k - b.w);
  }
  const pts: [number, number][] = [];
  for (let y = 0; y < b.h; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < b.w; x++) if (inn[y * b.w + x]) (l < 0 ? (l = x) : 0), (r = x);
    if (l >= 0) pts.push([l, y], [r + 1, y], [l, y + 1], [r + 1, y + 1]);
  }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], c: number[]) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lo: [number, number][] = [];
  const up: [number, number][] = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  const hull = [...lo.slice(0, -1), ...up.slice(0, -1)];
  let a2 = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return area / Math.max(1, Math.abs(a2) / 2);
}
