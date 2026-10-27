// 位图五线谱的**像素形状判据**：八分 / 四分休止、全音符与二分空心头的形、整小节休止、升号横笔、开口内腔。
import type { Binary } from "../omrkit/types";
import type { Rect } from "../omrkit/types";
import { type SmuflName } from "../staffomr/glyphs";
import { type LineSeg } from "./prims";
import { lineYAt, type LineRef, type RasterUnit } from "./staffline";

/** 开口内腔（`openCavities`）：射线窗外扩多少格、内腔至少多少格²、中心离谱表上下至多几格。 */
const OPEN_CAVITY_PAD = 0.3;

const OPEN_CAVITY_AREA = 0.06;

/** 盒落在某行谱的**行首那一段**里吗（谱号 + 调号的地盘）。见 `bootstrapQuarterRest` 那一段。 */
export function nearStaffStart(
  box: { x: number; y: number; h: number },
  groups: { lines: LineRef[] }[],
  lefts: number[],
  unit: RasterUnit,
): boolean {
  const cy = box.y + box.h / 2;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (cy < lineYAt(g.lines[0], box.x) - unit.space || cy > lineYAt(g.lines[4], box.x) + unit.space) continue;
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
/** 斜笔收尾的小钩：盒最下这么多（占高）的行，跨度放到这么多格（见 `isEighthRest`）。 */
const EIGHTH_REST_FOOT = [0.35, 0.9] as const;

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

export function isEighthRest(
  bin: Binary,
  b: Rect,
  area: number,
  unit: RasterUnit,
  minH: number = EIGHTH_REST_H[0],
  minFill: number = EIGHTH_REST_FILL[0],
  /** 斜笔收尾带钩的备选判据（见下）：只给整块认的那一路（`stages/heads.ts`），回填、拼块那几路的块本就是拼出来的，开了会多收谱号碎块 */
  hook = false,
): boolean {
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
  /** 那几行中心的斜率（最小二乘，x 对 y）：往下每行左移一成以上像素。实测斜笔 −0.2，符干 0 上下 */
  const slanted = (rs: typeof rows) => {
    const my = rs.reduce((a, r) => a + r.y, 0) / rs.length;
    const mx = rs.reduce((a, r) => a + (r.x0 + r.x1) / 2, 0) / rs.length;
    let sxy = 0, syy = 0;
    for (const r of rs) { sxy += (r.y - my) * ((r.x0 + r.x1) / 2 - mx); syy += (r.y - my) ** 2; }
    return syy > 0 && sxy / syy <= -EIGHTH_REST_SLANT;
  };
  // 按**跨度**量，不按墨量：符干旁蹭着一截圆滑线的，墨不多、跨度宽（齐来称颂的 G3 −1.3）
  if (!low.some((r) => r.x1 - r.x0 + 1 > sp * 0.4)) return slanted(low);
  if (!hook) return false;
  // 手写的斜笔收尾带个小钩、坐在谱线上（是爱 p5 m67 低音谱表上方，钩宽 0.45 格，压线那一行连着线沿 0.85 格）：
  // 最下 `EIGHTH_REST_FOOT[0]` 那几行跨度放到 `EIGHTH_REST_FOOT[1]` 格（盒本身不过 `EIGHTH_REST_W` 上限，挡得住一格多宽的符头），
  // 斜率只用脚以上的细笔，要够 0.2 个盒高
  // 宽度只量斜笔那一条：逐行取与上一行笔画最近的那段连续墨，旁边分开的噪点不算（是爱 p4 m57 斜笔左边几粒扫描噪点）。
  // 旁边另有一道逐行连着的笔、连了三成行以上的，是字不是休止（赞美三一真神 P2 m9 歌词里两道平行竖笔的字）
  const runsAt = (y: number) => {
    const out: [number, number][] = [];
    for (let x = b.x; x < b.x + b.w; x++) {
      if (!bin.data[y * bin.w + x]) continue;
      if (out.length && x === out[out.length - 1][1] + 1) out[out.length - 1][1] = x;
      else out.push([x, x]);
    }
    return out;
  };
  const traced: typeof rows = [];
  let prev = Infinity, twin = 0, chain = 0;
  let others: [number, number][] = [];
  for (const r of rows.filter((q) => q.y >= b.y + b.h * 0.4)) {
    const rs = runsAt(r.y);
    if (!rs.length) continue;
    const pick = prev === Infinity ? rs[rs.length - 1] : rs.reduce((p, q) => (Math.abs((q[0] + q[1]) / 2 - prev) < Math.abs((p[0] + p[1]) / 2 - prev) ? q : p));
    prev = (pick[0] + pick[1]) / 2;
    const rest = rs.filter((q) => q !== pick);
    chain = rest.some((q) => others.some((o) => q[0] <= o[1] && o[0] <= q[1])) ? chain + 1 : rest.length ? 1 : 0;
    twin = Math.max(twin, chain);
    others = rest;
    traced.push({ y: r.y, x0: pick[0], x1: pick[1], ink: pick[1] - pick[0] + 1 });
  }
  if (twin > traced.length * 0.3) return false;
  const footY = b.y + b.h * (1 - EIGHTH_REST_FOOT[0]);
  if (traced.some((r) => r.y >= b.y + b.h * 0.55 && r.x1 - r.x0 + 1 > sp * (r.y >= footY ? EIGHTH_REST_FOOT[1] : 0.4))) return false;
  const thin = traced.filter((r) => r.y < footY);
  if (thin.length < b.h * 0.2 || thin.some((r) => r.x1 - r.x0 + 1 > sp * 0.4)) return false;
  // 斜笔下半截也得是斜的：印刷歌词里的字（望十架「光」「千」「子」）上头一笔斜撇、下头一根直竖，整体斜率也过得去
  return slanted(thin) && slanted(thin.slice(Math.floor(thin.length / 2)));
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
export function wholesByShape(bin: Binary, nl: Binary, box0: Rect, unit: RasterUnit, grid: (y: number, x?: number) => number | null, stems: LineSeg[] = []): Rect[] {
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
    const cy = grid(box.y + (k + 0.5) * hh, box.x + box.w / 2);
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

/** 横杠的竖向厚度（格）、两道中心相距（格）、平行（斜率差）、横向交叠与长度比的门槛，竖笔伸出横杠多少（格）算伸出。 */
const XBAR_THICK = [0.2, 0.8] as const;
const XBAR_GAP = [0.6, 1.4] as const;
const XBAR_SLOPE_DIFF = 0.3;
const XBAR_OVERLAP = 0.6;
const XBAR_LEN_RATIO = 0.6;
const XBAR_REACH = 0.3;
const XBAR_LEN_MAX = 1.3;

/**
 * **先找两道平行粗斜横，再按竖笔与横杠的关系分 ♯ / ♮**。临时记号与邻音粘连时竖笔最不可靠：与邻音的干共用一列、被邻头盖住半截、
 * 被谱线切断；两道横杠反而稳——厚 0.2~0.8 格、同向斜、平行、长短相近、上下相隔一格上下。邻头的残墨凑不齐这几条。
 *
 * 逐列取厚度落在横杠那一档的竖游程（通高的竖笔列跳过），相邻列（隔开不过三列，跨过竖笔）中心接得上的连成一道，
 * 取满足上面几条的一对。再看每根通高竖笔在两道横杠处伸出多少：
 * - 有一根上下都伸出（过上横杠以上、下横杠以下各 `XBAR_REACH` 格）→ 升号；
 * - 左竖只往上伸、右竖只往下伸（两根都要见到）→ 还原号。
 * 只剩一根竖笔且只往一头伸的不判（分不出是还原号的哪一竖）。
 */
export function crossbarAccidental(bin: Binary, b: Rect, unit: RasterUnit, win = false): "accidentalSharp" | "accidentalNatural" | null {
  return crossbarAccidentalBox(bin, b, unit, win)?.code ?? null;
}

/**
 * 同上，另交出记号的外框（两道横杠与夹着它们的竖笔）。`win` 为真时 `b` 是头左边的整个窗、图是**带谱线的原图**：
 * 升号、还原号常压在谱线上，去线时横笔跟着抹掉；原图上谱线只有两三像素厚，过不了横杠的厚度下限，压线的横杠反而更厚。
 * 窗里竖笔按一格半以上算通高，先找竖笔对、只在这对竖笔附近找横杠，横杠不长过 `XBAR_LEN_MAX` 格（符杠）。
 */
export function crossbarAccidentalBox(bin: Binary, b: Rect, unit: RasterUnit, win = false): { code: "accidentalSharp" | "accidentalNatural"; box: Rect } | null {
  if (!win) return crossbarIn(bin, b, unit, false);
  // 整窗：先找竖笔对（相隔 0.3~0.8 格的两根一格半以上的竖笔），只在这一对左右各让 0.3 格的范围里找横杠——
  // 窗里别的墨（前一个音的笔画）与横杠同高时连成一段、碰到窗边，整窗找就被剔掉（赞美三一真神 m12 低音 ♯）
  const sp = unit.space;
  const cols: { x: number; xr: number }[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let run = 0, best = 0;
    for (let y = b.y; y < b.y + b.h; y++) (run = bin.data[y * bin.w + x] ? run + 1 : 0), (best = Math.max(best, run));
    if (best < sp * 1.5) continue;
    const g = cols[cols.length - 1];
    if (g && x - g.xr <= 2) g.xr = x;
    else cols.push({ x, xr: x });
  }
  for (let i = 0; i + 1 < cols.length; i++) {
    const gap = cols[i + 1].x - cols[i].xr;
    if (gap < sp * 0.3 || gap > sp * 0.8) continue;
    const x0 = Math.max(b.x, Math.round(cols[i].x - sp * 0.3)), x1 = Math.min(b.x + b.w, Math.round(cols[i + 1].xr + 1 + sp * 0.3));
    const r = crossbarIn(bin, { x: x0, y: b.y, w: x1 - x0, h: b.h }, unit, true);
    if (r) return r;
  }
  return null;
}

function crossbarIn(bin: Binary, b: Rect, unit: RasterUnit, win: boolean): { code: "accidentalSharp" | "accidentalNatural"; box: Rect } | null {
  const sp = unit.space;
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && !!bin.data[y * bin.w + x];
  // 通高竖笔：列里最长竖游程过盒高 55%
  const tall: { x: number; top: number; bot: number }[] = [];
  const runs: { x: number; y0: number; y1: number }[][] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    const col: { x: number; y0: number; y1: number }[] = [];
    let best = { top: 0, bot: -1 };
    for (let y = b.y; y < b.y + b.h; y++) {
      if (!ink(x, y)) continue;
      let z = y;
      while (z + 1 < b.y + b.h && ink(x, z + 1)) z++;
      if (z - y > best.bot - best.top) best = { top: y, bot: z };
      const t = (z - y + 1) / sp;
      if (t >= XBAR_THICK[0] && t <= XBAR_THICK[1]) col.push({ x, y0: y, y1: z });
      y = z;
    }
    if (best.bot - best.top + 1 >= (win ? sp * 1.5 : b.h * 0.55)) {
      tall.push({ x, top: best.top, bot: best.bot });
      runs.push([]);
    } else runs.push(col);
  }
  // 连成横杠
  type Bar = { pts: { x: number; y: number; t: number }[] };
  const bars: Bar[] = [];
  const open: { bar: Bar; lastX: number; lastY: number }[] = [];
  for (const col of runs)
    for (const r of col) {
      const cy = (r.y0 + r.y1) / 2;
      const hit = open.find((o) => r.x - o.lastX <= 4 && Math.abs(o.lastY - cy) <= sp * 0.3);
      const pt = { x: r.x, y: cy, t: r.y1 - r.y0 + 1 };
      if (hit) {
        hit.bar.pts.push(pt);
        hit.lastX = r.x;
        hit.lastY = cy;
      } else {
        const bar = { pts: [pt] };
        bars.push(bar);
        open.push({ bar, lastX: r.x, lastY: cy });
      }
    }
  const fit = (bar: Bar) => {
    const n = bar.pts.length;
    const mx = bar.pts.reduce((a, p) => a + p.x, 0) / n;
    const my = bar.pts.reduce((a, p) => a + p.y, 0) / n;
    let sxy = 0, sxx = 0;
    for (const p of bar.pts) (sxy += (p.x - mx) * (p.y - my)), (sxx += (p.x - mx) ** 2);
    const k = sxx ? sxy / sxx : 0;
    const ts = bar.pts.map((p) => p.t).sort((p, q) => p - q);
    return { x0: bar.pts[0].x, x1: bar.pts[n - 1].x, k, yAt: (x: number) => my + k * (x - mx), t: ts[ts.length >> 1] };
  };
  const cand = bars
    .filter((q) => q.pts.length >= Math.max(3, sp * 0.3))
    .map(fit)
    .filter((c) => !win || c.x1 - c.x0 <= sp * XBAR_LEN_MAX);
  let pair: [ReturnType<typeof fit>, ReturnType<typeof fit>] | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < cand.length; i++)
    for (let j = 0; j < cand.length; j++) {
      const u = cand[i], l = cand[j];
      if (i === j) continue;
      const ov = Math.min(u.x1, l.x1) - Math.max(u.x0, l.x0);
      const lu = u.x1 - u.x0, ll = l.x1 - l.x0;
      if (ov < Math.min(lu, ll) * XBAR_OVERLAP || Math.min(lu, ll) < Math.max(lu, ll) * XBAR_LEN_RATIO) continue;
      if (Math.abs(u.k - l.k) > XBAR_SLOPE_DIFF) continue;
      const mx = (Math.max(u.x0, l.x0) + Math.min(u.x1, l.x1)) / 2;
      const gap = (l.yAt(mx) - u.yAt(mx)) / sp;
      if (gap < XBAR_GAP[0] || gap > XBAR_GAP[1]) continue;
      // 两道里取最贴近一格的那对
      if (Math.abs(gap - 1) < bestGap) (bestGap = Math.abs(gap - 1)), (pair = [u, l]);
    }
  if (!pair) return null;
  const [u, l] = pair;
  // 竖笔按列成组
  const groups: { x: number; xr: number; top: number; bot: number }[] = [];
  for (const t of tall) {
    const g = groups[groups.length - 1];
    if (g && t.x - g.xr <= 2) (g.top = Math.min(g.top, t.top)), (g.bot = Math.max(g.bot, t.bot)), (g.xr = t.x);
    else groups.push({ x: t.x, xr: t.x, top: t.top, bot: t.bot });
  }
  const reach = sp * XBAR_REACH;
  // 窗里只看夹在两道横杠横向范围里（左右各让三像素）的竖笔
  const xa = Math.min(u.x0, l.x0) - 3, xz = Math.max(u.x1, l.x1) + 3;
  const near = win ? groups.filter((g) => g.xr >= xa && g.x <= xz) : groups;
  // 整窗里要见到两根竖笔、相隔 0.35 格以上：琶音的竖波浪只有一根，鼓包也凑得出两道横（恩友歌伴奏 m13）
  if (win && (near.length < 2 || near[near.length - 1].x - near[0].xr < sp * 0.35)) return null;
  const ext = near.map((g) => ({
    x: g.x,
    up: g.top <= u.yAt(g.x) - u.t / 2 - reach,
    down: g.bot >= l.yAt(g.x) + l.t / 2 + reach,
  }));
  const top = Math.min(u.yAt(xa + 3), u.yAt(xz - 3)) - u.t / 2;
  const bot = Math.max(l.yAt(xa + 3), l.yAt(xz - 3)) + l.t / 2;
  const box = {
    x: Math.min(xa + 3, ...near.map((g) => g.x)),
    y: Math.round(Math.min(top, ...near.map((g) => g.top))),
    w: 0,
    h: 0,
  };
  box.w = Math.max(xz - 3, ...near.map((g) => g.xr)) - box.x + 1;
  box.h = Math.round(Math.max(bot, ...near.map((g) => g.bot))) - box.y + 1;
  if (ext.some((e) => e.up && e.down)) return { code: "accidentalSharp", box };
  if (ext.length >= 2 && ext[0].up && !ext[0].down && ext[ext.length - 1].down && !ext[ext.length - 1].up) return { code: "accidentalNatural", box };
  return null;
}

/** 降号：竖笔高（格）、整个字形宽（格）、肚子往竖笔右边伸出至少多少（格）、闭合白腔至少多大（格²）、竖笔上段右边至多多少墨（占比）。 */
const FLAT_STEM_H = [1.5, 3.0] as const;
const FLAT_W = [0.45, 1.0] as const;
const FLAT_BELLY = 0.35;
const FLAT_HOLE = 0.04;
const FLAT_TOP_INK = 0.15;

/**
 * **降号按结构认**：一根通高竖笔，右边只在下半挂一个闭合的肚子。字典按块查不出它的时候用——
 * 竖笔被谱线切成几截、上端又粘着前一个音的头（破碎 p8 m80 钢琴右手和弦前外列的 ♭）。
 * 图要用修补图（谱线抹掉、切口补回），原图上谱线连通一切、去线图上竖笔断开。
 *
 * 逐列找最长竖游程落在 `FLAT_STEM_H` 的竖笔，从它起灌连通块：块不往竖笔左边伸、宽在 `FLAT_W`、
 * 往右伸出 `FLAT_BELLY` 格以上；竖笔上面四成高的右边几乎没墨（升号、还原号、带干的头上下都有）；块里有闭合白腔。
 */
export function flatAccidentalBox(bin: Binary, b: Rect, unit: RasterUnit): Rect | null {
  const sp = unit.space;
  const ink = (x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h && !!bin.data[y * bin.w + x];
  const stems: { x: number; xr: number; top: number; bot: number }[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let best = { top: 0, bot: -1 };
    for (let y = b.y; y < b.y + b.h; y++) {
      if (!ink(x, y)) continue;
      let z = y;
      while (ink(x, z + 1)) z++;
      if (z - y > best.bot - best.top) best = { top: y, bot: z };
      y = z;
    }
    const len = best.bot - best.top + 1;
    if (len < sp * FLAT_STEM_H[0] || len > sp * FLAT_STEM_H[1]) continue;
    const g = stems[stems.length - 1];
    if (g && x - g.xr <= 1) (g.xr = x), (g.top = Math.min(g.top, best.top)), (g.bot = Math.max(g.bot, best.bot));
    else stems.push({ x, xr: x, top: best.top, bot: best.bot });
  }
  for (const st of stems) {
    if (st.xr - st.x + 1 > sp * 0.3) continue;
    // 从竖笔灌连通块
    const seen = new Set<number>();
    const stack: number[] = [];
    for (let y = st.top; y <= st.bot; y++) if (ink(st.x, y)) stack.push(y * bin.w + st.x);
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const x = i % bin.w, y = (i - x) / bin.w;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      // 只灌到竖笔右边一个降号宽：肚子贴着右边的头时，头圈的残墨灌进来就宽出 `FLAT_W`（爱是从神而来 p5 m60 右手 ♭）
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) if (nx <= st.x + sp * FLAT_W[1] - 2 && ink(nx, ny) && !seen.has(ny * bin.w + nx)) stack.push(ny * bin.w + nx);
    }
    const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (x0 < st.x - 1 || box.w < sp * FLAT_W[0] || box.w > sp * FLAT_W[1] || x1 - st.xr < sp * FLAT_BELLY) continue;
    if (box.h > sp * FLAT_STEM_H[1] + 2) continue;
    // 竖笔上面四成高：右边几乎没墨
    let top = 0, all = 0;
    for (let y = st.top; y < st.top + (st.bot - st.top) * 0.4; y++)
      for (let x = st.xr + 2; x <= x1; x++) (all++, seen.has(y * bin.w + x) && top++);
    if (all && top / all > FLAT_TOP_INK) continue;
    // 闭合白腔：只看这一块的墨
    const local = { w: box.w + 2, h: box.h + 2, data: new Uint8Array((box.w + 2) * (box.h + 2)) } as Binary;
    for (const i of seen) {
      const x = i % bin.w, y = (i - x) / bin.w;
      local.data[(y - y0 + 1) * local.w + (x - x0 + 1)] = 1;
    }
    if (enclosedWhite(local, { left: 1, top: 1, right: box.w, bottom: box.h }, sp, 1) < sp * sp * FLAT_HOLE) continue;
    return box;
  }
  return null;
}

/** 各线在 x 处的 y（弯、斜的谱线按曲线取），按名义线位排、五条一组。 */
function linesAt(lines: LineRef[], x: number): number[] {
  return [...lines].sort((a, b) => a.y - b.y).map((l) => lineYAt(l, x));
}

export function offStaffRest(box: Rect, lines: LineRef[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = linesAt(lines, box.x + box.w / 2);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] && ys[i] - cy <= unit.space * QREST_OFF) return true;
    if (cy > ys[i + 4] && cy - ys[i + 4] <= unit.space * QREST_OFF) return true;
  }
  return false;
}

export function midOfStaff(box: Rect, lines: LineRef[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = linesAt(lines, box.x + box.w / 2);
  for (let i = 0; i + 4 < ys.length; i += 5) if (Math.abs(cy - ys[i + 2]) <= unit.space * 0.9) return true;
  return false;
}

/** 扁矩形的休止（全休止、二分休止、整小节休止）：形状都是一个贴着谱线的小实心矩形。 */
export const isBarRest = (code: string) => code === "restHalf" || code === "restWhole" || code === "restHBar";

/**
 * 扁矩形休止分全、半：**全休止吊在线下，二分休止坐在线上**（标准位置是吊在第二线下、坐在中线上）。
 * 两者形状一样，只差贴着哪条线，按中心落在上方那条线与下方那条线之间的哪一半判（谱表外照线距往外推）。
 * 只认标准位置不够：两声部时上声部的休止抬高一两格（生之颂钢琴 m13 左手二分休止坐在第二线上，中心比中线高一格，读成整小节休止）。
 * 全休止仍记 `restHBar`（整小节休止，时值随拍号），二分休止记 `restHalf`
 * ——原先一律记成整小节休止，《是谁》首小节「二分休止 + 四分休止 + 两个八分」因此多出三拍。
 */
export function restKind(box: Rect, lines: LineRef[], unit: RasterUnit): SmuflName {
  const cy = box.y + box.h / 2;
  const ys = linesAt(lines, box.x + box.w / 2);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] - unit.space || cy > ys[i + 4] + unit.space) continue;
    const five = ys.slice(i, i + 5);
    const k = five.filter((y) => y <= cy).length - 1;
    const above = k >= 0 ? five[k] : five[0] - unit.space;
    const below = k < 0 ? five[0] : k < 4 ? five[k + 1] : five[4] + unit.space;
    return (cy - above) / (below - above) >= 0.5 ? "restHalf" : "restHBar";
  }
  return "restHBar";
}

export function nearRestLine(box: Rect, lines: LineRef[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = linesAt(lines, box.x + box.w / 2);
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
