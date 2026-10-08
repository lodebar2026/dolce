// 位图五线谱的**像素形状判据**：八分 / 四分休止、全音符与二分空心头的形、整小节休止、升号横笔、开口内腔。
import type { Binary } from "../omrkit/types";
import type { Rect } from "../omrkit/types";
import { type SmuflName } from "../staffomr/glyphs";
import { type LineSeg } from "./prims";
import { type RasterUnit } from "./staffline";

/** 开口内腔（`openCavities`）：射线窗外扩多少格、内腔至少多少格²、中心离谱表上下至多几格。 */
const OPEN_CAVITY_PAD = 0.3;

const OPEN_CAVITY_AREA = 0.06;

/** 盒落在某行谱的**行首那一段**里吗（谱号 + 调号的地盘）。见 `bootstrapQuarterRest` 那一段。 */
export function nearStaffStart(
  box: { x: number; y: number; h: number },
  groups: { lines: { y: number }[] }[],
  lefts: number[],
  unit: RasterUnit,
): boolean {
  const cy = box.y + box.h / 2;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (cy < g.lines[0].y - unit.space || cy > g.lines[4].y + unit.space) continue;
    if (box.x < lefts[i] + unit.space * STAFF_START) return true;
  }
  return false;
}

/** 盒的中心落在某行谱的**中线**附近吗——四分休止是竖着写在谱表正中的。 */
/** 八分休止的尺寸（格）与填充：顶上一个球、下面一根斜笔。 */
const EIGHTH_REST_W = [0.85, 1.3] as const;

const EIGHTH_REST_H = [1.7, 2.4] as const;

const EIGHTH_REST_FILL = [0.3, 0.5] as const;

const EIGHTH_REST_SLANT = 0.1;

/**
 * **八分休止按形状认**：顶上三成有一个够宽的球，下半截每行只有一笔细墨，而且这一笔
 * **越往下越往左**。「头 + 干」块（符干朝下）下半截也是一笔细墨，可那是竖的，不往左斜。
 * 《向主唱新歌》伴奏满页八分休止（约 1.1×2.0 格），与模板的距离 97~138，过不了门槛，
 * 于是被当成「头 + 干」摘出假头、或被当成四分休止收走。
 */
/**
 * **按不去线的图数符号的墨**：去线图上的墨，加上原图里被当谱线抹掉、**上下（`reach` 像素内）都紧挨着去线图上的墨**的那些像素
 * ——符号压在谱线上的那一截。去线只认「这几行是线」，把压在线上的笔画一起抹了，按去线图数墨、量墨占比，
 * 骑线的符号都偏空（望十架 p5 被谱线切成两截的八分休止）。
 */
export function symbolInk(nl: Binary, bin: Binary, box: Rect, reach: number): number {
  const r = Math.max(1, Math.round(reach) + 1);
  const at = (b: Binary, x: number, y: number) => x >= 0 && y >= 0 && x < b.w && y < b.h && b.data[y * b.w + x] === 1;
  let n = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      if (at(nl, x, y)) n++;
      else if (at(bin, x, y)) {
        let up = false, dn = false;
        for (let k = 1; k <= r && !(up && dn); k++) {
          up ||= at(nl, x, y - k);
          dn ||= at(nl, x, y + k);
        }
        if (up && dn) n++;
      }
    }
  return n;
}

export function isEighthRest(bin: Binary, b: Rect, area: number, unit: RasterUnit, minH: number = EIGHTH_REST_H[0], minFill: number = EIGHTH_REST_FILL[0]): boolean {
  const sp = unit.space;
  const w = b.w / sp;
  const h = b.h / sp;
  if (w < EIGHTH_REST_W[0] || w > EIGHTH_REST_W[1] || h < minH || h > EIGHTH_REST_H[1]) return false;
  const fill = area / Math.max(1, b.w * b.h);
  if (fill < minFill || fill > EIGHTH_REST_FILL[1]) return false;
  const rows: { y: number; x0: number; x1: number; ink: number }[] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    let x0 = -1, x1 = -1, ink = 0;
    for (let x = b.x; x < b.x + b.w; x++) {
      if (!bin.data[y * bin.w + x]) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
      ink++;
    }
    if (ink) rows.push({ y, x0, x1, ink });
  }
  const topRows = rows.filter((r) => r.y < b.y + b.h * 0.35);
  if (!topRows.length || Math.max(...topRows.map((r) => r.ink)) < sp * 0.55) return false;
  const low = rows.filter((r) => r.y >= b.y + b.h * 0.55);
  if (low.length < b.h * 0.3) return false;
  // 按**跨度**量，不按墨量：符干旁蹭着一截圆滑线的，墨不多、跨度宽（齐来称颂的 G3 −1.3）
  if (low.some((r) => r.x1 - r.x0 + 1 > sp * 0.4)) return false;
  // 下半截那一笔中心的斜率（最小二乘，x 对 y）：往下每行左移一成以上像素。实测斜笔 −0.2，符干 0 上下
  const my = low.reduce((a, r) => a + r.y, 0) / low.length;
  const mx = low.reduce((a, r) => a + (r.x0 + r.x1) / 2, 0) / low.length;
  let sxy = 0, syy = 0;
  for (const r of low) { sxy += (r.y - my) * ((r.x0 + r.x1) / 2 - mx); syy += (r.y - my) ** 2; }
  return syy > 0 && sxy / syy <= -EIGHTH_REST_SLANT;
}

/** 从块里的墨出发，在去线图上 8 连通回填整个连通域；出了窗口（左右各 1 格、上 0.5 格、下 2.6 格）就不算。 */
export function fillAround(bin: Binary, b: Rect, unit: RasterUnit): { box: Rect; area: number } | null {
  const sp = unit.space;
  const x0 = Math.max(0, Math.floor(b.x - sp));
  const y0 = Math.max(0, Math.floor(b.y - sp * 0.5));
  const x1 = Math.min(bin.w - 1, Math.ceil(b.x + b.w + sp));
  const y1 = Math.min(bin.h - 1, Math.ceil(b.y + sp * 2.6));
  const seen = new Set<number>();
  const stack: number[] = [];
  for (let y = b.y; y < b.y + b.h && !stack.length; y++)
    for (let x = b.x; x < b.x + b.w; x++)
      if (bin.data[y * bin.w + x]) { stack.push(y * bin.w + x); seen.add(y * bin.w + x); break; }
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % bin.w;
    const y = (i - x) / bin.w;
    if (x <= x0 || x >= x1 || y <= y0 || y >= y1) return null;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy * bin.w + dx;
        if (!seen.has(j) && bin.data[j]) { seen.add(j); stack.push(j); }
      }
  }
  if (maxX < 0) return null;
  return { box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, area: seen.size };
}

/**
 * 头盒四周外扩半格的窗口里，从窗口边上往里灌不到的白（封闭内腔），返回**最大一块**的像素数。
 * 外扩半格：小字号头的盒常只罩住头的上半截（以马内利来临歌 m11），内腔伸到盒外。
 * 只取最大一块：网点印刷的实心头里散着一两像素的白点，加起来也不小（万口欢唱）。
 */
export function enclosedWhite(bin: Binary, b: { left: number; right: number; top: number; bottom: number }, sp: number, pad = Math.round(sp * 0.5)): number {
  const x0 = Math.max(0, Math.floor(b.left) - pad);
  const x1 = Math.min(bin.w - 1, Math.ceil(b.right) + pad);
  const y0 = Math.max(0, Math.floor(b.top) - pad);
  const y1 = Math.min(bin.h - 1, Math.ceil(b.bottom) + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const seen = new Uint8Array(w * h);
  const fill = (sx: number, sy: number) => {
    const s0 = (sy - y0) * w + (sx - x0);
    if (seen[s0] || bin.data[sy * bin.w + sx]) return 0;
    seen[s0] = 1;
    const stack = [s0];
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = (i % w) + x0;
      const y = Math.floor(i / w) + y0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const j = (ny - y0) * w + (nx - x0);
        if (seen[j] || bin.data[ny * bin.w + nx]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    return n;
  };
  for (let x = x0; x <= x1; x++) fill(x, y0), fill(x, y1);
  for (let y = y0; y <= y1; y++) fill(x0, y), fill(x1, y);
  let best = 0;
  for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) best = Math.max(best, fill(x, y));
  return best;
}

/** `[x0,x1]` 整段都是墨的那些行，连成段返回（`[起行, 止行]`）。 */
export function crossRuns(bin: Binary, x0: number, x1: number, y0: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = Math.max(0, y0); y <= Math.min(bin.h - 1, y1); y++) {
    let full = true;
    for (let x = x0; x <= x1 && full; x++) if (!bin.data[y * bin.w + x]) full = false;
    if (!full) continue;
    const last = out[out.length - 1];
    if (last && last[1] === y - 1) last[1] = y;
    else out.push([y, y]);
  }
  return out;
}

/** 列 `x` 上过 `(x,y)` 的竖墨段（允许左右各偏一像素续上）。 */
/**
 * 去谱线后劈成**左右两半**的全音符（单个或三度叠成「8」字的一对）：按全音符自己的形状判——
 * 左右镜像对称、每个头上下对称、两侧笔画粗而中间（内腔 + 上下细边）墨少。头数按高度（约一格一个）。
 * 不只左右两半并成的块，整块的也按这套判（附点全音符叠头、「阿们」叠头，内腔被谱线切碎、模板配不上）。
 * 我灵镇静 m8 的 A4/F4、m25 的 A3/F3：内腔是两道竖缝（宽高比 0.5），内腔那一路与模板都认不出。
 */
export function wholesByShape(bin: Binary, nl: Binary, box0: Rect, unit: RasterUnit, grid: (y: number) => number | null, stems: LineSeg[] = []): Rect[] {
  const sp = unit.space;
  // **盒收到头上**：加线比头宽，块里带着整条加线时盒宽出一截（以马内利来临歌 m24 加一线上的 C4，43 像素的盒里头只有 30）。
  // 墨横满盒宽九成的行是线，不算；按其余行的墨定左右边
  let box = box0;
  {
    const lineRow = (y: number, frac = 0.9) => {
      let c = 0;
      for (let x = box0.x; x < box0.x + box0.w; x++) c += bin.data[y * bin.w + x];
      return c >= box0.w * frac;
    };
    // 顶、底边上的线行先去掉：挂在加线下的头，块顶带着那条加线，上下对称被拉低（以马内利来临歌 m25 的 B3）。
    // 线的边缘行常缺几个像素（这一处顶行 36/43），边上放到八成
    let t = box0.y;
    let b = box0.y + box0.h - 1;
    while (t < b && lineRow(t, 0.8)) t++;
    while (b > t && lineRow(b, 0.8)) b--;
    let l = Infinity;
    let r = -Infinity;
    for (let y = t; y <= b; y++) {
      if (lineRow(y)) continue;
      for (let x = box0.x; x < box0.x + box0.w; x++)
        if (bin.data[y * bin.w + x]) {
          l = Math.min(l, x);
          r = Math.max(r, x);
        }
    }
    if (r >= l && (box0.w - (r - l + 1) > sp * 0.15 || t > box0.y || b < box0.y + box0.h - 1)) box = { x: l, y: t, w: r - l + 1, h: b - t + 1 };
  }
  const w = box.w / sp;
  const h = box.h / sp;
  // 收盒之后细圈的头量得窄些（以马内利来临歌 m25 加线下的 B3 只有 1.27 格）：1.2~1.3 格的要旁边没有干（二分头那么宽）
  if (w < 1.2 || w > 2.2) return [];
  const n = h >= 0.75 && h <= 1.35 ? 1 : h >= 1.6 && h <= 2.6 ? 2 : 0;
  if (!n) return [];
  const ink = (b: Binary, x: number, y: number) => x >= 0 && x < b.w && y >= 0 && y < b.h && b.data[y * b.w + x] === 1;
  // 左右镜像
  let both = 0;
  let any = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const a = ink(bin, x, y);
      const m = ink(bin, box.x + box.w - 1 - (x - box.x), y);
      if (a || m) any++;
      if (a && m) both++;
    }
  const lr = any ? both / any : 0;
  // 每个头上下对称
  let ud = 1;
  const hh = box.h / n;
  for (let k = 0; k < n; k++) {
    const y0 = box.y + Math.round(k * hh);
    const y1 = box.y + Math.round((k + 1) * hh);
    let b2 = 0;
    let a2 = 0;
    for (let y = y0; y < y1; y++)
      for (let x = box.x; x < box.x + box.w; x++) {
        const a = ink(bin, x, y);
        const m = ink(bin, x, y1 - 1 - (y - y0));
        if (a || m) a2++;
        if (a && m) b2++;
      }
    ud = Math.min(ud, a2 ? b2 / a2 : 0);
  }
  // 两侧粗、中间空（去谱线的图上量，谱线不算墨）
  const colFrac = (x0: number, x1: number) => {
    let c = 0;
    let t = 0;
    for (let x = Math.round(x0); x < Math.round(x1); x++)
      for (let y = box.y; y < box.y + box.h; y++) {
        t++;
        if (ink(nl, x, y)) c++;
      }
    return t ? c / t : 0;
  };
  const side = (colFrac(box.x, box.x + box.w * 0.3) + colFrac(box.x + box.w * 0.7, box.x + box.w)) / 2;
  const mid = colFrac(box.x + box.w * 0.4, box.x + box.w * 0.6);
  // **转 180° 对称**：内腔斜着的全音符（右上、左下粗）左右镜像只有 0.46，中间两成又正压着上下粗边，
  // 上面两道都过不去（齐来崇拜低音 m9 复纵线后的 F#3/D3「8」字叠头）；它转半圈与自己重合。
  // 另要每个头中心那一小块是空的（内腔），实心的字块转半圈也可能对称
  let rb = 0;
  let ra = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const a = ink(bin, x, y);
      const m = ink(bin, box.x + box.w - 1 - (x - box.x), box.y + box.h - 1 - (y - box.y));
      if (a || m) ra++;
      if (a && m) rb++;
    }
  const rot = ra ? rb / ra : 0;
  const hollowMid = () => {
    for (let k = 0; k < n; k++) {
      const y0 = Math.round(box.y + (k + 0.35) * hh);
      const y1 = Math.round(box.y + (k + 0.65) * hh);
      let wht = 0;
      let tot = 0;
      for (let y = y0; y <= y1; y++) {
        // 头骑在线上时谱线穿过内腔（去线图在头里保留了线）：两侧伸出盒外的横贯行不算
        if (ink(bin, box.x - 2, y) && ink(bin, box.x + box.w + 1, y)) continue;
        for (let x = Math.round(box.x + box.w * 0.35); x <= Math.round(box.x + box.w * 0.65); x++) {
          tot++;
          if (!ink(bin, x, y)) wht++;
        }
      }
      if (!tot || wht / tot < WHOLE_HOLE) return false;
    }
    return true;
  };
  // 带干的二分叠头转半圈也对称（齐来崇拜 m6 低音 G3/E3）：头左右沿 0.3 格内有伸出盒外一格以上的竖段的不算
  const stemmed = stems.some((v) => {
    const vx = (v.x0 + v.x1) / 2;
    if (Math.abs(vx - box.x) > sp * 0.3 && Math.abs(vx - (box.x + box.w)) > sp * 0.3) return false;
    const vy0 = Math.min(v.y0, v.y1);
    const vy1 = Math.max(v.y0, v.y1);
    if (vy1 < box.y - sp * 0.3 || vy0 > box.y + box.h + sp * 0.3) return false; // 得挨着头
    return vy0 < box.y - sp || vy1 > box.y + box.h + sp;
  });
  if (w < 1.3 && stemmed) return [];
  const byRot = !stemmed && rot >= WHOLE_ROT && side >= WHOLE_SIDE && hollowMid();
  // **细圈**：圈细的全音符两侧不到 0.58（以马内利来临歌 m24 加一线上的 C4 叠 E4，0.57），
  // 可它左右、上下都对称得很（与二分头一样），内腔也空：两侧放到 `WHOLE_SIDE_THIN`
  const thin = lr >= WHOLE_LR_THIN && ud >= WHOLE_UD_THIN && side >= WHOLE_SIDE_THIN && mid <= side * WHOLE_MID && hollowMid();
  if (!byRot && !thin && (lr < WHOLE_LR || ud < WHOLE_UD || side < WHOLE_SIDE || mid > side * WHOLE_MID)) return [];
  const out: Rect[] = [];
  for (let k = 0; k < n; k++) {
    const cy = grid(box.y + (k + 0.5) * hh);
    if (cy === null) return [];
    out.push({ x: box.x, y: Math.round(cy - hh / 2), w: box.w, h: Math.round(hh) });
  }
  if (n === 2 && Math.abs(out[1].y - out[0].y - sp) > sp * 0.25) return [];
  return out;
}

/** 左右镜像的墨交并比：真全音符 0.69~0.88，被并成一对的歌词字 ≤0.60。 */
const WHOLE_LR = 0.65;

/** 每个头上下镜像：真全音符 0.50~0.88（附点叠头按高度等分，切分线不正落在两头之间）。 */
const WHOLE_UD = 0.45;

/** 两侧三成宽的墨占比下限：全音符圈粗，真头 0.61~0.77；被收进来的字与杂块 ≤0.55。 */
const WHOLE_SIDE = 0.58;

/** 中间两成宽的墨不超过两侧的这么多倍：内腔竖直的 0~0.1，斜着的（万口欢唱末尾）细边斜穿中线到 0.52；字 0.6 以上。 */
const WHOLE_MID = 0.55;

/** 转 180° 的墨交并比下限（内腔斜着的全音符）：齐来崇拜 m9 叠头 0.81，已认出的全音符叠头 0.72~0.86。 */
const WHOLE_ROT = 0.75;

/** 转 180° 那一路：每个头中心三成见方里白的占比下限。 */
const WHOLE_HOLE = 0.6;

/** 细圈那一路：左右、上下镜像下限与两侧墨占比下限。 */
const WHOLE_LR_THIN = 0.72;

const WHOLE_UD_THIN = 0.6;

const WHOLE_SIDE_THIN = 0.5;

/**
 * 盒里有**两道横贯的粗横笔**：升号的两道斜横。四分休止是折线，横不满盒宽。
 * 齐来谢主歌、我灵镇静、信心使我得胜（低分辨率或细笔本）的 ♯ 只有 0.8×2.3~2.9 格，落进了四分休止的形状闸。
 *
 * 横满盒宽四分之三的行按间隔 0.3 格分道：♯ 恰好两道、各厚 0.23~0.41 格、中心相距 1.0 格上下。
 * 休止也有横得满的：粗体本（主我敬拜你）是四道细线，以马内利来临歌是两道 0.6 格厚、相距 1.4 格，
 * 向主唱新歌是两道 1~2 像素——按道数、厚度、间距都挡得住。竖笔判不稳：去谱线后常被切断。
 */
export function sharpCrossbars(bin: Binary, b: Rect, unit: RasterUnit): boolean {
  const sp = unit.space;
  const bars: [number, number][] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    let best = 0;
    let run = 0;
    for (let x = b.x; x < b.x + b.w; x++) {
      run = x >= 0 && x < bin.w && y >= 0 && y < bin.h && bin.data[y * bin.w + x] ? run + 1 : 0;
      if (run > best) best = run;
    }
    if (best < b.w * 0.75) continue;
    const last = bars[bars.length - 1];
    if (last && y - last[1] <= sp * 0.3) last[1] = y;
    else bars.push([y, y]);
  }
  if (bars.length !== 2) return false;
  const thick = bars.map(([a, z]) => (z - a + 1) / sp);
  if (thick.some((t) => t < 0.2 || t > 0.45)) return false;
  const gap = ((bars[1][0] + bars[1][1]) - (bars[0][0] + bars[0][1])) / 2 / sp;
  return gap >= 0.7 && gap <= 1.3;
}

export function offStaffRest(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] && ys[i] - cy <= unit.space * QREST_OFF) return true;
    if (cy > ys[i + 4] && cy - ys[i + 4] <= unit.space * QREST_OFF) return true;
  }
  return false;
}

export function midOfStaff(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) if (Math.abs(cy - ys[i + 2]) <= unit.space * 0.9) return true;
  return false;
}

/** 扁矩形的休止（全休止、二分休止、整小节休止）：形状都是一个贴着谱线的小实心矩形。 */
export const isBarRest = (code: string) => code === "restHalf" || code === "restWhole" || code === "restHBar";

/**
 * 扁矩形休止分全、半：**全休止吊在第二线下，二分休止坐在中线上**。
 * 两者形状一样，只差位置（中心差半格），按中心在第二线与中线的哪一半判。
 * 全休止仍记 `restHBar`（整小节休止，时值随拍号），二分休止记 `restHalf`
 * ——原先一律记成整小节休止，《是谁》首小节「二分休止 + 四分休止 + 两个八分」因此多出三拍。
 */
export function restKind(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): SmuflName {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] - unit.space || cy > ys[i + 4] + unit.space) continue;
    return cy > (ys[i + 1] + ys[i + 2]) / 2 ? "restHalf" : "restHBar";
  }
  return "restHBar";
}

export function nearRestLine(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    for (const k of [1, 2]) if (Math.abs(cy - ys[i + k]) <= unit.space * 0.6) return true;
  }
  return false;
}

/**
 * 把一块**横向粘连的两个记号**在中段（30%~70%）墨最少的那一列切开，两半各按墨收紧外框。
 * 切不出两块像样的（任一半没墨、或切口那列墨不比两侧少）返回 null。
 */
export function splitAt(bin: Binary, box: Rect): [Rect, Rect] | null {
  const ink = (x: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (bin.data[y * bin.w + x]) n++;
    return n;
  };
  const colInk = (x: number) => ink(x, box.y, box.y + box.h);
  let cut = -1;
  let best = Infinity;
  for (let x = box.x + Math.round(box.w * 0.3); x <= box.x + Math.round(box.w * 0.7); x++) {
    const n = colInk(x);
    if (n < best) {
      best = n;
      cut = x;
    }
  }
  if (cut < 0) return null;
  const peak = (x0: number, x1: number) => {
    let m = 0;
    for (let x = x0; x < x1; x++) m = Math.max(m, colInk(x));
    return m;
  };
  if (best * 2 > Math.min(peak(box.x, cut), peak(cut + 1, box.x + box.w))) return null;
  const a = inkBox(bin, box.x, cut, box.y, box.y + box.h);
  const c = inkBox(bin, cut + 1, box.x + box.w, box.y, box.y + box.h);
  return a && c ? [a, c] : null;
}

/** 盒里最长的一段竖直连续墨（像素）。 */
export function longestVRun(bin: Binary, box: Rect): number {
  let best = 0;
  for (let x = Math.max(0, box.x); x < Math.min(bin.w, box.x + box.w); x++) {
    let run = 0;
    for (let y = Math.max(0, box.y); y < Math.min(bin.h, box.y + box.h); y++) {
      run = bin.data[y * bin.w + x] ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  return best;
}

/** `[x0,x1) × [y0,y1)` 里墨的外框；没墨返回 null。 */
function inkBox(bin: Binary, x0: number, x1: number, y0: number, y1: number): Rect | null {
  let l = Infinity, r = -1, t = Infinity, b = -1;
  for (let y = Math.max(0, y0); y < Math.min(bin.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(bin.w, x1); x++)
      if (bin.data[y * bin.w + x]) {
        l = Math.min(l, x);
        r = Math.max(r, x);
        t = Math.min(t, y);
        b = Math.max(b, y);
      }
  return r < 0 ? null : { x: l, y: t, w: r - l + 1, h: b - t + 1 };
}

/** 块像不像升号：恰两根通高竖笔（`tallStrokes`），两根在块的上、下各 15% 高度带里都有墨；另有两道横贯（≥0.8 块宽）的横笔带。 */
export function sharpShape(bin: Binary, box: Rect): boolean {
  if (tallStrokes(bin, box) !== 2) return false;
  const x0 = Math.max(0, Math.floor(box.x)), x1 = Math.min(bin.w, Math.ceil(box.x + box.w));
  const y0 = Math.max(0, Math.floor(box.y)), y1 = Math.min(bin.h, Math.ceil(box.y + box.h));
  // 两根竖笔所在的列组
  const groups: number[][] = [];
  let prev = -2;
  for (let x = x0; x < x1; x++) {
    let run = 0, best = 0;
    for (let y = y0; y < y1; y++) { if (bin.data[y * bin.w + x]) best = Math.max(best, ++run); else run = 0; }
    if (best < box.h * 0.55) continue;
    if (x - prev > 1) groups.push([]);
    groups[groups.length - 1]!.push(x);
    prev = x;
  }
  const band = Math.max(2, Math.round(box.h * 0.15));
  const inkIn = (xs: number[], ya: number, yb: number) => { for (let y = ya; y < yb; y++) for (const x of xs) for (const dx of [-1, 0, 1]) if (x + dx >= x0 && x + dx < x1 && bin.data[y * bin.w + x + dx]) return true; return false; };
  // 左竖比右竖低半拍（升号是斜的）：左竖看下端、右竖看上端各放宽到 30%
  if (!groups.every((g) => inkIn(g, y0, y0 + band * 2) && inkIn(g, y1 - band * 2, y1))) return false;
  let bars = 0, inBar = false;
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (bin.data[y * bin.w + x]) n++;
    const full = n >= (x1 - x0) * 0.8;
    if (full && !inBar) bars++;
    inBar = full;
  }
  return bars === 2;
}

/** 块里**通高的竖笔**有几根：连续墨长过块高 55% 的列，按相邻成组数组数（隔一列以上算两根）。 */
export function tallStrokes(bin: Binary, box: Rect): number {
  let groups = 0;
  let prev = -2;
  for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(bin.w, Math.ceil(box.x + box.w)); x++) {
    let run = 0;
    let best = 0;
    for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(bin.h, Math.ceil(box.y + box.h)); y++) {
      if (bin.data[y * bin.w + x]) best = Math.max(best, ++run);
      else run = 0;
    }
    if (best < box.h * 0.55) continue;
    if (x - prev > 1) groups++;
    prev = x;
  }
  return groups;
}

/** 两个头上下贴着的块：宽 0.9~1.7 格（一个头）、高 1.7~2.4 格（两个头）、填充率 ≥ 0.7。 */
export function isStackedPair(box: Rect, area: number, unit: { space: number }): boolean {
  const w = box.w / unit.space;
  const h = box.h / unit.space;
  return w >= 0.9 && w <= 1.7 && h >= 1.7 && h <= 2.4 && area / Math.max(1, box.w * box.h) >= 0.7;
}

/**
 * 块里**开口的内腔**：四向射线（在块外扩 `OPEN_CAVITY_PAD` 格的窗里）都碰得到墨的白像素，按四连通拼块，
 * 返回够 `OPEN_CAVITY_AREA` 格² 的那些块的外框。
 */
export function openCavities(bin: Binary, box: Rect, unit: RasterUnit): Rect[] {
  const pad = Math.round(unit.space * OPEN_CAVITY_PAD);
  const x0 = Math.max(0, box.x - pad);
  const x1 = Math.min(bin.w - 1, box.x + box.w - 1 + pad);
  const y0 = Math.max(0, box.y - pad);
  const y1 = Math.min(bin.h - 1, box.y + box.h - 1 + pad);
  const ink = (x: number, y: number) => bin.data[y * bin.w + x] !== 0;
  const hits = (x: number, y: number, dx: number, dy: number) => {
    for (let cx = x + dx, cy = y + dy; cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1; cx += dx, cy += dy) if (ink(cx, cy)) return true;
    return false;
  };
  const bw = box.w;
  const inside = new Uint8Array(bw * box.h);
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < bw; x++) {
      const px = box.x + x;
      const py = box.y + y;
      if (px < 0 || py < 0 || px >= bin.w || py >= bin.h || ink(px, py)) continue;
      if (hits(px, py, -1, 0) && hits(px, py, 1, 0) && hits(px, py, 0, -1) && hits(px, py, 0, 1)) inside[y * bw + x] = 1;
    }
  const out: Rect[] = [];
  const minArea = unit.space * unit.space * OPEN_CAVITY_AREA;
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] !== 1) continue;
    const stack = [i];
    inside[i] = 2;
    let n = 0;
    let [ax, ay, bx, by] = [bw, box.h, 0, 0];
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % bw;
      const y = (k / bw) | 0;
      n++;
      ax = Math.min(ax, x), ay = Math.min(ay, y), bx = Math.max(bx, x), by = Math.max(by, y);
      for (const q of [x > 0 ? k - 1 : -1, x + 1 < bw ? k + 1 : -1, y > 0 ? k - bw : -1, y + 1 < box.h ? k + bw : -1])
        if (q >= 0 && inside[q] === 1) (inside[q] = 2), stack.push(q);
    }
    if (n >= minArea) out.push({ x: box.x + ax, y: box.y + ay, w: bx - ax + 1, h: by - ay + 1 });
  }
  return out;
}

/** 行首「谱号 + 调号」那一段占几格（线距的倍数）。谱号约 2 格宽，
 *  七个降号排开也就再占 4 格，留一点余量。 */
export const STAFF_START = 6;

/** 让位到谱表外的休止：中心在第五线上方或第一线下方 `QREST_OFF` 格以内。 */
export const QREST_OFF = 2.2;
