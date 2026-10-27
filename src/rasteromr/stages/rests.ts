// 认一页里的休止（`recognizeRasterPage` 按顺序调）：整小节 / 二分休止先摘出来，别让符头那一路吃掉；四分与八分休止按位置 + 形状自举。

import { type RasterPrims, type LineSeg, groupByLeftInk } from "../prims";
import { type RasterUnit, type StaffLineRun, LineGrid, type StaffGroup, lineYAt } from "../staffline";
import type { Component, Binary, Rect } from "../../omrkit/types";
import type { RasterPage } from "../rasterpage";
import { type ContourMap, type RepairedLayer, candidateMap, findHoles, cavityLike } from "../contour";
import { ContourLedger } from "../ledger";
import type { SmuflName } from "../../staffomr/glyphs";
import type { RasterSym } from "../adapt";
import { type RasterHead, findRasterHeads } from "../notehead";
import { nearRestLine, restKind, nearStaffStart, fillAround, isEighthRest, symbolInk, midOfStaff, offStaffRest, STAFF_START, sharpCrossbars, tallStrokes, longestVRun } from "../restshape";
import { overlapFrac } from "../../omrkit/geom";
import { EIGHTH_REST_FILL_PIECES, QREST_W, QREST_H, QREST_FILL, QREST_SPINE_W } from "./shared";

/** 整小节休止的形状闸（见 `restSyms` 那一段）。放松到 1.6/0.8/0.9 与 1.5/0.75/0.95
 *  都**一个都不多认**——剩下的那些不在纸上（破碎三个女高合印一行，
 *  GT 里 P1/P2 中段的全休止根本没印出来）。
 *  这三个数量的是**休止本身**，量块之前要把粘着的谱线截扣掉，见那里的说明。
 *  填充 0.85 → 0.75：网纹印的休止块里散着白点，《向主唱新歌》第 14 小节那个只有 0.79，被收成 C5。 */
const REST_W = [0.9, 1.8] as const;
const REST_H = 0.8;
const REST_RATIO = 1.8;
const REST_FILL = 0.75;
/** 从符杠表里捡休止时的宽度上限（格）：这套字形的整小节休止宽 2.1 格。 */
const REST_BEAM_W = 2.4;
/** 坐在线上的扁块宽过这么多格，也按整小节休止（二分休止没这么宽）。 */
const REST_WIDE = 1.7;
/** 八分休止候选左边 0.8 格、上六成高里墨够这么多（格，按像素数折算）就当左边挨着字母（和弦记号「C7」的 7）。 */
const SEVEN_LEFT_INK = 1;
/** 从符杠表里捡的休止，不压线的部分至少这么高（格）：手写本的全休止只是线下一道 0.3 格的粗横（是爱 p1 m6、p5 m70）。 */
const REST_BEAM_H = 0.2;
/** 几何闸收下的实心头，矮于这个数（线距的倍数）又压在符杠中线上的，是杠头。 */
const BEAM_STUMP_H = 0.65;
/** 杠端假头的高度上限（格）：主使我喜乐 m16 杠起头连着干尖 0.69 格，有一位神 m10 连着第五线 0.95 格，倚靠主永远膀臂 m11 主杠尾连着下层短杠 1.13 格。 */
const BEAM_END_STUMP_H = 1.2;

/** 整小节休止：**先摘出来，别让符头那一路吃掉** */
export function findWholeRests(c: {
  prims: RasterPrims;
  unit: RasterUnit;
  blobs: Component[];
  staffLines: StaffLineRun[];
  grid: LineGrid;
  groups: StaffGroup[];
  staffLefts: number[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  raster: RasterPage;
  inBand: (y: number, x?: number) => boolean;
  nl: Binary;
  cmap: ContourMap;
  rlayer: RepairedLayer;
  ledger: ContourLedger;
  repaired: Binary;
  harmonyIds: Set<number>;
  titleIds: Set<number>;
  onGrid: (y: number, x?: number) => boolean;
  matchHollow: ((box: Rect) => { smufl: SmuflName; dist: number; } | null) | null;
  offStaff: (y: number) => boolean;
}): {
  besideStem: (b: Rect) => boolean;
  restIds: Set<number>;
  restSyms: RasterSym[];
  restStrokes: Set<LineSeg>;
  onBeamLine: (b: Rect, ext?: number) => boolean;
  beamsThrough: (b: Rect, ext?: number) => number;
  inBeamBody: (b: Rect) => boolean;
  beamStump: (b: Rect, others: Rect[]) => boolean;
  notHollow: Map<number, Rect>;
  allHoles: Rect[];
  heads: RasterHead[];
  claimed: Set<number>;
} {
  const { prims, unit, blobs, staffLines, grid, groups, staffLefts, yAt, raster, inBand, nl, cmap, rlayer, ledger, repaired, harmonyIds, titleIds, onGrid, matchHollow, offStaff } = c;
  // ── 整小节休止：**先摘出来，别让符头那一路吃掉** ─────────────────────
  //
  // 全休止是个 1.34×0.64 格、填充 0.92 的实心小矩形——**正好落在实心符头那一档里**
  //（宽 0.85~1.85、高 ≥0.55、填充 ≥0.62），于是整批被判成 `noteheadBlack`：
  // 实测破碎 GT 中段有 129 个全休止，我们只出 33 个休止，多出来的音符正是它们。
  // 字典也指望不上（那三页 25 个休止大小的块只认出 11 个）。
  //
  // 判据是**形状 + 位置**：矩形（填充 ≥0.85）、扁（宽高比 ≥1.8，符头是 1.3 的椭圆）、
  // 高不过 0.8 格，再过一道 `nearRestLine`（全休止吊在二线下、半休止坐在三线上）。
  // 全/半由 `notedata.ts` 按几何再分。
  // **一头贴着竖笔的是符杠，不是休止**：两个八分音符的短符杠斜着穿过谱线，
  // 去谱线后夹在两线之间的那一截正是个扁实心矩形——整小节休止这一路与字典那一路
  // 都会收它（《是谁》每行一两处，认成全休止/二分休止，那一小节随之作废）。
  // 斜着切的，那一截只挨得着一头的符干；休止两头都不挨符干（后面紧跟的音符，符干离它至少一格）。
  const besideStem = (b: Rect) => {
    const stemAt = (x: number) =>
      prims.vSegs.some((v) => {
        const vx = (v.x0 + v.x1) / 2;
        return Math.abs(vx - x) <= unit.space * 0.4 && Math.min(v.y0, v.y1) <= b.y + b.h + unit.space * 0.5 && Math.max(v.y0, v.y1) >= b.y - unit.space * 0.5;
      });
    return stemAt(b.x) || stemAt(b.x + b.w);
  };
  const restIds = new Set<number>();
  const restSyms: RasterSym[] = [];
  for (const c of blobs) {
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    // **高度要把粘着的那截谱线扣掉**。全/半休止是贴着谱线画的（全休止吊在第二线下、
    // 半休止坐在第三线上），去谱线时它底下/头上那一截「上方有墨」，照判据留了下来，
    // 并进同一个块——块高于是多出一个线宽，宽高比也跟着掉。线细时还挤得进闸门，
    // 线一粗就整批卡死：破碎扫描件线宽 4.4px、线距 18.8px，1.34×0.64 格的全休止
    // 量出来是 **0.87 格高、宽高比 1.54**，`REST_H` 与 `REST_RATIO` 两道全过不去
    // ——实测 GT 475 个休止只出 178 个，漏的那 300 个正是全休止（GT 里有 306 个）。
    // 干净版也只是勉强擦边（0.79 格），所以两档一起受益。
    const hRest = Math.max(0.1, h - unit.lineThick / unit.space);
    if (w < REST_W[0] || w > REST_W[1] || hRest < 0.3 || hRest > REST_H) continue;
    if (w < hRest * REST_RATIO) continue;
    if (c.area / Math.max(1, b.w * b.h) < REST_FILL) continue;
    if (!nearRestLine(b, staffLines, unit)) continue;
    if (besideStem(b)) continue;
    restIds.add(c.id);
    restSyms.push({ box: b, code: restKind(b, staffLines, unit) });
  }
  // **被当成符杠的休止**：下声部的整小节休止挪到了第四线下、第五线上，这套字形又宽（2.1 格），
  // 原语那一步先当一截符杠拿走，块图里根本没有它（齐来崇拜低音谱表 m15–17）。
  // 从符杠表里捡：两头都不挨干、扁实心、上沿吊在或下沿坐在第四、五线上。
  // 吊着的、或宽过 `REST_WIDE` 格的记整小节休止；坐着的窄块记二分休止
  for (const q of prims.beams) {
    const b = q.box;
    const w = b.w / unit.space;
    // 高度只数不压线的行：杠盒常只罩进半条线，再整扣一个线宽就扣多了（是爱 p1 m6 手写全休止线下只有 0.39 格高）
    let offRows = 0;
    for (let y = b.y; y < b.y + b.h; y++) if (!grid.onLine(y, unit.lineThick / 2 + 0.5, b.x + b.w / 2)) offRows++;
    const hRest = Math.max(0.1, offRows / unit.space);
    if (w < REST_W[0] || w > REST_BEAM_W || hRest < REST_BEAM_H || hRest > REST_H) continue;
    if (Math.abs(q.y1 - q.y0) > unit.lineThick) continue; // 斜的是真符杠
    if (besideStem(b)) continue;
    if (nearStaffStart(b, groups, staffLefts, unit)) continue;
    if (restSyms.some((r) => overlapFrac(r.box, b) > 0.3)) continue;
    const tol = unit.lineThick + 2;
    const bx = b.x + b.w / 2;
    const grp = groups.find((g) => b.y + b.h / 2 > yAt(g, 0, bx) && b.y + b.h / 2 < yAt(g, 4, bx));
    if (!grp) continue;
    // 只收挪到下声部的位置（第四、五线）：第二、三线上的归块图那一路；这里放开的话，
    // 宁静的伯利恒吊在第二、三线下的一批扁块也进来，合唱谱干净档音符 −0.3
    const low = grp.lines.slice(3);
    // 例外是**吊在第二线下**——全休止的标准位置：扫描件里它与第二线粘成一片，原语那一步同样当一截杠拿走
    //（是爱 p4 男声行 m59–62 四个全休止全漏）。宁静那批假块是十六分的上层杠（两头的干短、没抽成竖段，
    // `besideStem` 拦不住），正下方一格内贴着平行的第二层杠——全休止上下没有别的杠。
    const stacked = () =>
      prims.beams.some((o) => o !== q && Math.min(o.box.x + o.box.w, b.x + b.w) - Math.max(o.box.x, b.x) > b.w * 0.5 && Math.abs(o.box.y - b.y) < unit.space * 1.2);
    const hang = low.some((l) => Math.abs(b.y - lineYAt(l, bx)) <= tol) || (Math.abs(b.y - yAt(grp, 1, bx)) <= tol && !stacked());
    const sit = low.some((l) => Math.abs(b.y + b.h - lineYAt(l, bx)) <= tol);
    if (!hang && !sit) continue;
    // 薄的只收吊着的（全休止）：坐在线上的薄块多是杠的碎截（新编 031 P2 m6）
    if (hRest < 0.3 && !hang) continue;
    let fill = 0;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) fill += raster.bin.data[y * raster.bin.w + x];
    if (fill / Math.max(1, b.w * b.h) < REST_FILL) continue;
    restSyms.push({ box: b, code: hang || w >= REST_WIDE ? "restHBar" : "restHalf" });
  }
  // **斜笔被抽成竖段的八分休止**：斜笔陡，原语那一步当竖段提走，块图里只剩上头的球
  //（《向主唱新歌》高音谱表下声部一排八分休止，球被歌词行收走）。拿球在去线图上把整个连通域
  // 回填出来，再按八分休止的形状判（`isEighthRest`）。
  for (const c of blobs) {
    if (restIds.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space * 0.8 || b.h > unit.space * 1.0 || b.h < unit.space * 0.4) continue;
    if (!inBand(b.y + b.h / 2)) continue;
    const full = fillAround(nl, b, unit);
    if (!full || full.box.h < b.h * 1.8) continue;
    // 斜笔下端压着谱线时去线后短一截（破碎 p7 m73 附点八分休止 1.69 格）：球连着往下的斜笔已是一道证据，高度下限按拼块那一档
    if (!isEighthRest(nl, full.box, full.area, unit, EIGHTH_REST_H_PIECES)) continue;
    restIds.add(c.id);
    restSyms.push({ box: full.box, code: "rest8th" });
  }
  /** 被认成八分休止斜笔的竖段：不当干（是爱 p1 m16 低音 F3 全音符顶上的休止，斜笔一直伸到头顶，头读成二分） */
  const restStrokes = new Set<LineSeg>();
  // **球也跟着斜笔一起被抽走的八分休止**：手写体的斜笔陡、球又贴着斜笔上端，整枚被当成一根竖段提走（最宽那行把 `maxLw` 撑到 0.8 格），
  // 块图里一点不剩，上面那一路没有球可回填（是爱 p1 m16 低音谱表）。从斜得不像干的短竖段上端在去线图上回填整个连通域，按八分休止的形状判
  for (const v of prims.vSegs) {
    const len = Math.abs(v.y1 - v.y0);
    if (len < unit.space * SLANT_REST_LEN[0] || len > unit.space * SLANT_REST_LEN[1]) continue;
    if (Math.abs(v.x1 - v.x0) / len < SLANT_REST_SLANT) continue;
    const top = v.y0 < v.y1 ? { x: v.x0, y: v.y0 } : { x: v.x1, y: v.y1 };
    if (!inBand(top.y + len / 2)) continue;
    const full = fillAround(nl, { x: Math.round(top.x) - 1, y: Math.round(top.y), w: 3, h: 3 }, unit);
    if (!full || !isEighthRest(nl, full.box, full.area, unit, EIGHTH_REST_H_PIECES)) continue;
    // 和弦记号里的「7」也是上头一团、下面一道斜笔（是爱 p5 m63「C7」，和弦带 OCR 没读出来、认领不到）：
    // 它的顶是一道横笔，顶上几行就有将近一格宽；休止的球顶是圆的，顶上 0.15 格内不过 0.6 格
    let topW = 0;
    for (let y = full.box.y; y < full.box.y + Math.max(2, Math.round(unit.space * 0.15)); y++) {
      let x0 = -1, x1 = -1;
      for (let x = full.box.x; x < full.box.x + full.box.w; x++) if (nl.data[y * nl.w + x]) (x0 < 0 && (x0 = x)), (x1 = x);
      if (x0 >= 0) topW = Math.max(topW, x1 - x0 + 1);
    }
    // 只在像「7」时才这么剔（用户定）：和弦记号的 7 左边挨着字母、离开谱线；休止挨着谱线。
    // 顶上宽的也可能是休止：手写的球顶与斜笔起头同在顶行（是爱 p2 m19 低音谱表上方），底端坐在第五线上、左边是白的
    const bx = full.box;
    let onStaffLine = false;
    for (let y = bx.y - 1; y <= bx.y + bx.h && !onStaffLine; y++) onStaffLine = grid.onLine(y, unit.lineThick / 2 + 0.5, bx.x + bx.w / 2);
    let leftInk = 0;
    for (let y = bx.y; y < bx.y + bx.h * 0.6; y++)
      for (let x = Math.max(0, Math.round(bx.x - unit.space * 0.8)); x < bx.x - 1; x++) leftInk += nl.data[y * nl.w + x];
    const letterLeft = leftInk >= unit.space * SEVEN_LEFT_INK;
    if (topW > unit.space * 0.6 && (letterLeft || !onStaffLine)) continue;
    restStrokes.add(v);
    if (restSyms.some((r) => overlapFrac(r.box, full.box) > 0.3)) continue;
    restSyms.push({ box: full.box, code: "rest8th" });
    for (const b of blobs) if (overlapFrac(b.bbox, full.box) > 0.5) restIds.add(b.id);
  }
  // **被谱线切成两截的八分休止**：球在线上、斜笔在线下（破碎扫描版 p8 女低 m?），去线后是两块，
  // 上面那一路回填不过谱线。先在**修补图**上取：碎块全无主、修补后连成一块的，整块按八分休止的形状判（墨也在修补图上数）
  {
    const rv = candidateMap(cmap, rlayer, (id) => ledger.claimsOf(id).every((q) => q.by === "seg:Staff"));
    for (const c of rv.merged) {
      if (rv.parts.get(c.id)!.length < 2) continue;
      const box = c.bbox;
      if (!inBand(box.y + box.h / 2)) continue;
      if (!isEighthRest(repaired, box, c.area, unit, EIGHTH_REST_H_PIECES, EIGHTH_REST_FILL_PIECES)) continue;
      if (restSyms.some((r) => overlapFrac(r.box, box) > 0.3)) continue;
      restSyms.push({ box, code: "rest8th" });
      // 盒里的符号块记到休止名下：不然字典那一路按块再认一个，同一个休止出两个
      for (const b of blobs) if (overlapFrac(b.bbox, box) > 0.5) restIds.add(b.id);
    }
  }
  // 修补图没连上的（线上那截与谱线完全重合、补不回来）：没人认领的小球，正下方隔着一条谱线（间隙不过一个线宽加 3 像素）、横向重叠的另一块，
  // 合起来按八分休止的形状判
  for (const c of cmap.contours) {
    if (ledger.claimsOf(c.id).length) continue;
    const b = c.bbox;
    if (b.w < unit.space * 0.5 || b.w > unit.space * 1.2 || b.h < unit.space * 0.3 || b.h > unit.space * 1.4) continue;
    if (!inBand(b.y + b.h / 2)) continue;
    const gapMax = unit.lineThick + 3;
    const d = cmap.contours.find((o) => o !== c && !ledger.claimsOf(o.id).length && o.bbox.y >= b.y + b.h * 0.5 && o.bbox.y - (b.y + b.h) <= gapMax &&
      o.bbox.y + o.bbox.h > b.y + b.h + unit.lineThick && o.bbox.x < b.x + b.w && b.x < o.bbox.x + o.bbox.w && o.bbox.w <= unit.space * 1.2);
    if (!d) continue;
    const x0 = Math.min(b.x, d.bbox.x);
    const box = { x: x0, y: b.y, w: Math.max(b.x + b.w, d.bbox.x + d.bbox.w) - x0, h: d.bbox.y + d.bbox.h - b.y };
    // 墨按**不去线**的量：去线把符号压在线上的那几行也抹了（望十架 p5 低音谱表一排八分休止，两块合起来墨占 0.25，过不了 0.3）
    // 两块各自过了尺寸闸、又上球下笔隔着一条线，比整块认的那一路多一道证据，墨占比下限放到 `EIGHTH_REST_FILL_PIECES`
    if (!isEighthRest(nl, box, symbolInk(nl, raster.bin, box, unit.lineThick), unit, EIGHTH_REST_H_PIECES, EIGHTH_REST_FILL_PIECES)) continue;
    if (restSyms.some((r) => overlapFrac(r.box, box) > 0.3)) continue;
    restSyms.push({ box, code: "rest8th" });
  }

  // **球与斜笔左右断开的八分休止**：小号字体的八分休止（新编赞美诗 033 m18 低音谱表，高 1.55 格），球与斜笔之间那一丝连接在去线后断开，
  // 成了左右并排的两块，上面几路都接不上。没人认领的小球，右边紧挨着（隙不过 3 像素）一根没人认领、窄而高的斜笔、两块顶端齐平，
  // 合起来按八分休止的形状判
  for (const c of cmap.contours) {
    if (ledger.claimsOf(c.id).length) continue;
    const b = c.bbox;
    if (b.w < unit.space * 0.35 || b.w > unit.space * 0.8 || b.h < unit.space * 0.3 || b.h > unit.space * 0.7) continue;
    if (!inBand(b.y + b.h / 2)) continue;
    const d = cmap.contours.find((o) => o !== c && !ledger.claimsOf(o.id).length && o.bbox.x >= b.x + b.w * 0.3 && o.bbox.x - (b.x + b.w) <= 3 &&
      Math.abs(o.bbox.y - b.y) <= unit.space * 0.3 && o.bbox.w <= unit.space * 0.8 && o.bbox.h >= unit.space * 1.1 && o.bbox.h <= unit.space * 2.4);
    if (!d) continue;
    const x0 = Math.min(b.x, d.bbox.x), y0 = Math.min(b.y, d.bbox.y);
    const box = { x: x0, y: y0, w: Math.max(b.x + b.w, d.bbox.x + d.bbox.w) - x0, h: Math.max(b.y + b.h, d.bbox.y + d.bbox.h) - y0 };
    // 墨按不去线的量（同上一路）：骑线的那枚两块合起来按去线图数只有 0.29（信心使我得胜 m18 男低谱表）。
    // 墨占比下限同上一路放到 `EIGHTH_REST_FILL_PIECES`：细笔的、球只靠压着的谱线连上斜笔，按不去线数也只有 0.29（一婴孩为我们降生 男声 m6）
    if (!isEighthRest(nl, box, symbolInk(nl, raster.bin, box, unit.lineThick), unit, EIGHTH_REST_H_PIECES, EIGHTH_REST_FILL_PIECES)) continue;
    if (restSyms.some((r) => overlapFrac(r.box, box) > 0.3)) continue;
    restSyms.push({ box, code: "rest8th" });
  }

  /** 块的中心压在某条符杠的中线上（半个杠厚以内）：那是提走符杠之后剩下的杠头，不是符头。 */
  const onBeamLine = (b: Rect, ext = 0) => beamsThrough(b, ext) > 0;
  /** 块的中心压在几条符杠的中线上（`onBeamLine` 的计数版）。 */
  const beamsThrough = (b: Rect, ext = 0) => {
    const cxb = b.x + b.w / 2;
    const cyb = b.y + b.h / 2;
    // `ext`：两端各外推多远。杠的拟合常收不到最末一截（有一位神 m4，杠拟合到 757、剩下 759~773 一截连着干尖被收成 F♯5）；
    // 只给几何闸那一路外推，判别器那一路外推了会剔掉真头（当我们回到天家 −0.4）
    return prims.beams.filter((q) => {
      if (cxb < Math.min(q.x0, q.x1) - ext || cxb > Math.max(q.x0, q.x1) + ext) return false;
      const t = q.x1 === q.x0 ? 0 : (cxb - q.x0) / (q.x1 - q.x0);
      return Math.abs(cyb - (q.y0 + (q.y1 - q.y0) * t)) <= Math.max(q.lw, unit.space * 0.25);
    }).length;
  };
  /**
   * 块**正接在一条够厚的符杠的端头上**：杠端的 x 落在块的横向范围内（±2px）、上下与杠盒交叠，杠厚 0.35 格以上。
   * 杠起头那一截常连着干尖、压着谱线，比杠厚一截，拟合也常收不到它（主使我喜乐 m16、有一位神 m4）。
   * 谱线、加线误检出的薄「杠」不算：它们穿过真头时两端恰好落在头上（合唱谱破碎五处真头）；
   * 另一端也压着一个头的不算：扫描件上同高的几个头被谱线连成一条厚「杠」。真杠的另一端是干尖
   */
  const atBeamEnd = (b: Rect, others: Rect[]) =>
    prims.beams.some((q) => {
      if (q.lw < unit.space * 0.35 || b.y >= q.box.y + q.box.h || b.y + b.h <= q.box.y) return false;
      const hit = (x: number) => x >= b.x - 2 && x <= b.x + b.w + 2;
      const far = hit(q.x0) ? { x: q.x1, y: q.y1 } : hit(q.x1) ? { x: q.x0, y: q.y0 } : null;
      if (!far) return false;
      // 另一端那个也得够一个头高：杠两头都剩一截的（主使我喜乐 m16）不算
      return !others.some((o) => o !== b && o.h >= unit.space * 0.8 && far.x >= o.x - 2 && far.x <= o.x + o.w + 2 && far.y >= o.y - q.lw && far.y <= o.y + o.h + q.lw);
    });
  /**
   * 块有六成高度落在一条够厚（0.35 格以上）符杠的**杠身**里：网纹粗杠的中段被收成头（耶和华是我的牧者 m11，
   * 杠拟合厚 0.51 格，头 1.33×0.9 格的 0.68 在杠带里）。真头不会埋在杠身里
   */
  const inBeamBody = (b: Rect) => {
    const cxb = b.x + b.w / 2;
    return prims.beams.some((q) => {
      if (q.lw < unit.space * 0.35 || cxb < Math.min(q.x0, q.x1) || cxb > Math.max(q.x0, q.x1)) return false;
      const t = q.x1 === q.x0 ? 0 : (cxb - q.x0) / (q.x1 - q.x0);
      const yc = q.y0 + (q.y1 - q.y0) * t;
      const ov = Math.min(b.y + b.h, yc + q.lw / 2 + 1) - Math.max(b.y, yc - q.lw / 2 - 1);
      return ov >= b.h * 0.6;
    });
  };
  /** 黑头正接在杠端又压着杠的中线（两端外推一格）：杠起头那一截；或埋在杠身里。各路出的黑头都查 */
  const beamStump = (b: Rect, others: Rect[]) => inBeamBody(b) || (b.h <= unit.space * BEAM_END_STUMP_H && atBeamEnd(b, others) && onBeamLine(b, unit.space));
  // 几何闸那一路同样要剔杠头：善牧恩慈歌放大后，符杠左端提剩的一截 0.86×0.6 格，
  // 刚好卡过实心头的尺寸下限，出了个 F5。只剔**矮**的（不到 0.65 格）：贴着符杠、又被去线
  // 削扁的真头中心也会落在杠的中线上（宁静的伯利恒三个 1.1×0.72 格的，门槛 0.75 时被剔掉）。
  const notHollow = new Map<number, Rect>();
  const allHoles = findHoles(raster.bin, Math.max(4, Math.round(unit.space * unit.space * 0.06)));
  const rawHeads = findRasterHeads(nl, blobs.filter((c) => !restIds.has(c.id) && !harmonyIds.has(c.id) && !titleIds.has(c.id)), prims.vSegs, unit, onGrid, inBand, matchHollow, offStaff, notHollow, allHoles.filter((h) => cavityLike(raster.bin, h, unit.space)));
  const heads = rawHeads.filter((hd) => {
    if (hd.code !== "noteheadBlack") return true;
    if (beamStump(hd.box, rawHeads.map((o) => o.box))) return false;
    return hd.box.h >= unit.space * BEAM_STUMP_H || !onBeamLine(hd.box);
  });
  const claimed = new Set([...heads.map((h) => h.comp.id), ...restIds, ...harmonyIds, ...titleIds]);
  return { besideStem, restIds, restSyms, restStrokes, onBeamLine, beamsThrough, inBeamBody, beamStump, notHollow, allHoles, heads, claimed };
}

/** 四分休止：**位置 + 形状自举**，字典兜不住 */
export function findQuarterRests(c: {
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  unit: RasterUnit;
  syms: RasterSym[];
  raster: RasterPage;
  leftEdges: { top: number; bottom: number; left: number; }[];
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  merged: Set<number>;
  staffLines: StaffLineRun[];
  staffLefts: number[];
  nl: Binary;
  prims: RasterPrims;
  ledger: ContourLedger;
  cmap: ContourMap;
  usedSegs: Set<LineSeg>;
  rlayer: RepairedLayer;
  repaired: Binary;
}): void {
  const { groups, yAt, unit, syms, raster, leftEdges, blobs, claimed, dictClaimed, merged, staffLines, staffLefts, nl, prims, ledger, cmap, usedSegs, rlayer, repaired } = c;
  // ── 四分休止：**位置 + 形状自举**，字典兜不住 ──────────────────────────
  //
  // 四分休止在位图上被切得五花八门（它压着三条谱线，去谱线之后每一段的断法
  // 都不一样），签名于是散进一堆没定名的类里——实测全份只认出 90 个，
  // 而它是序列里最常见的休止（逐音比下来「漏掉」里 P6.1 有 27 个、P6.2 有 20 个是休止）。
  // 谱号与拍号走的是同一条路：**字典靠不住的那几类，改按位置 + 形状认**。
  //
  // 判据（都从认出来的那批量出来）：0.75~1.10 格宽、2.2~3.1 格高、填充 0.33~0.62，
  // 再要求**盒的中心落在谱表中线附近**（四分休止是竖着写在谱表正中的）。
  // 这三条合起来在谱面上几乎没有别的东西能同时满足：符干太窄、符头太矮、
  // 连音线太空、升降号在 0.6 格上下。
  /** 块左沿到本行「谱号 + 调号」右沿的距离；这一行没认出谱号、或块不在行首段右边的返回 Infinity。 */
  const afterKey = (b: Rect) => {
    const cy = b.y + b.h / 2;
    const bx = b.x + b.w / 2;
    const g = groups.find((g0) => cy > yAt(g0, 0, bx) - unit.space && cy < yAt(g0, 4, bx) + unit.space);
    if (!g) return Infinity;
    const inRow = (r: Rect) => r.y + r.h / 2 > yAt(g, 0, r.x + r.w / 2) - unit.space * 2 && r.y + r.h / 2 < yAt(g, 4, r.x + r.w / 2) + unit.space * 2;
    const clef = syms.filter((s0) => s0.code.endsWith("Clef") && inRow(s0.box) && s0.box.x < b.x).sort((p, q) => q.box.x - p.box.x)[0];
    if (!clef) return Infinity;
    let right = clef.box.x + clef.box.w;
    const accs = syms.filter((s0) => /^accidental(Flat|Sharp)$/.test(s0.code) && inRow(s0.box) && s0.box.x > clef.box.x).sort((p, q) => p.box.x - q.box.x);
    // 谱号到第一个升降号隔得开些（低音谱号右边还有两个点）
    for (const [i, a] of accs.entries()) {
      if (a.box.x - right > unit.space * (i ? 1.2 : 2)) break;
      right = Math.max(right, a.box.x + a.box.w);
    }
    return b.x - right < 0 ? Infinity : b.x - right;
  };
  // 让位到谱表外的休止只在**两行的大谱表**里收：合唱谱一个声部一行，休止不出谱表，谱表外那一带是歌词与表情记号
  //（不分的话合唱谱扫描档音符 80.59 → 80.42、歌词 65.81 → 65.46）。系统按左端的墨分（与建页时同一个函数）。
  const sysBoxes = groupByLeftInk(raster.bin, leftEdges, unit);
  /** 块所在的系统是两行的大谱表；`many` 时三行以上的系统也算。 */
  const inGrandStaff = (b: Rect, many = false) => {
    const cy = b.y + b.h / 2;
    const g = groups.slice().sort((p, q) => Math.min(Math.abs(cy - p.lines[0].y), Math.abs(cy - p.lines[4].y)) - Math.min(Math.abs(cy - q.lines[0].y), Math.abs(cy - q.lines[4].y)))[0];
    if (!g) return false;
    const box = sysBoxes.find((q) => g.lines[0].y < q.y + q.h && g.lines[4].y > q.y);
    if (!box) return false;
    const rows = groups.filter((o) => o.lines[0].y < box.y + box.h && o.lines[4].y > box.y).length;
    return many ? rows >= 2 : rows === 2;
  };
  /** 两声部让位、仍在谱表里的四分休止：心离中线 0.9~`QREST_SHIFT` 格（中线那条判据之外）、在大谱表里、
   *  中线另一侧同一竖列有符头（另一声部的音）。一婴孩为我们降生 p3 m22 左手上声部的休止抬高 1.3 格，下面是下声部的全音符 */
  const shiftedRest = (b: Rect) => {
    const cy = b.y + b.h / 2;
    const bx = b.x + b.w / 2;
    const g = groups.find((q) => cy > yAt(q, 0, bx) && cy < yAt(q, 4, bx));
    if (!g || !inGrandStaff(b, true)) return false;
    const d = cy - yAt(g, 2, bx);
    if (Math.abs(d) <= unit.space * 0.9 || Math.abs(d) > unit.space * QREST_SHIFT) return false;
    return syms.some((s0) => s0.code.startsWith("notehead") && s0.box.x < b.x + b.w && s0.box.x + s0.box.w > b.x && (s0.box.y + s0.box.h / 2 - cy) * d < 0 && Math.abs(s0.box.y + s0.box.h / 2 - cy) > b.h / 2);
  };
  const thinRests: typeof blobs = [];
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    if (w < QREST_W[0] || w > QREST_W[1] || h < QREST_H[0] || h > QREST_H[1]) continue;
    const fill = c.area / Math.max(1, b.w * b.h);
    // 偏细的（`QREST_FILL_THIN` ~ 下限）先过完别的闸记下，等本页按正常闸认出的四分休止里有同尺寸的再收
    const thin = fill >= QREST_FILL_THIN && fill < QREST_FILL[0];
    if ((fill < QREST_FILL[0] && !thin) || fill > QREST_FILL[1]) continue;
    // 位置：谱表中线上下，或**让位到谱表外**（闭合谱一行两个声部，女低的休止压到第一线下方、男高的抬到第五线上方，
    // 新编赞美诗 215 奇妙能力歌的四分休止心在第一线下 1.7 格）——头心离外线 `QREST_OFF` 格以内都收
    // 按分好组的谱线判：`lines` 里混着没成组的横线，五条一组会错位（一婴孩为我们降生 p2 男声 m17）
    const mid = midOfStaff(b, staffLines, unit) || shiftedRest(b);
    if (!mid && !(offStaffRest(b, staffLines, unit) && inGrandStaff(b))) continue;
    // 谱表外的：右边 2.4 格内挨着一个符头（头心落在这一块的高度里，上下各容半格）的是那个音的**升降号**，不是休止
    //（归回父家歌下加一线 C♯4 的升号，尺寸正落在四分休止这一档，`sharpCrossbars` 在淡印上验不出横杠）
    // 谱表外的：行首「谱号 + 调号 + 拍号」那一段不收——下面那两道行首闸按「块心在谱表里」找行，谱表外的块找不到行就放过去了
    //（今要主自己歌调号头一个升号探出第五线，每行行首多一个四分休止）
    if (!mid) {
      const cy = b.y + b.h / 2;
      const g = groups.slice().sort((p, q) => Math.min(Math.abs(cy - p.lines[0].y), Math.abs(cy - p.lines[4].y)) - Math.min(Math.abs(cy - q.lines[0].y), Math.abs(cy - q.lines[4].y)))[0];
      if (g && b.x - Math.max(...g.lines.map((l) => l.left)) < unit.space * (STAFF_START + 4)) continue;
    }
    if (
      !mid &&
      syms.some((s0) => {
        if (!s0.code.startsWith("notehead")) return false;
        const dx = s0.box.x - (b.x + b.w);
        const hy = s0.box.y + s0.box.h / 2;
        return dx >= -unit.space * 0.3 && dx <= unit.space * 2.4 && hy >= b.y - unit.space * 0.5 && hy <= b.y + b.h + unit.space * 0.5;
      })
    )
      continue;
    // **行首的谱号 + 调号那一段里没有四分休止。**
    //
    // 降号是「一根竖笔 + 一个小肚子」，在这套底本上与四分休止太像；
    // 而降调的调号降号**正好落在中线上**，`midOfStaff` 这条位置判据非但拦不住它，
    // 反而给它放行。升降号自举那一路认不出的（字典没中、模板也没过）就漏到这里，
    // 被当成四分休止收走——实测破碎的 `restQuarter` 误检里裁图核对的三处**全是调号降号**
    // （`chorus-diff --errors` 出的清单：多出休止 36/50、音→休 31/53 都是 `restQuarter`）。
    //
    // 谱面上行首那一段是死的：谱号 + 调号最多占几格，真正的休止在它右边。
    if (nearStaffStart(b, groups, staffLefts, unit)) continue;
    // 谱线左端离谱号远（大括号、缩进）或调号很长时，按谱线左端起算的那一段罩不到头。
    // 改从本行认出的谱号起，往右串起紧挨着的升降号，得到行首段的右沿；候选在右沿往右 `KEY_TAIL` 格以内的也不收：
    // 那里是还没认出的调号（倚靠主永远膀臂低音第四个降号）或拍号（向主唱新歌 6/8，拍号自举在这一路之后才跑）
    if (afterKey(b) < unit.space * KEY_TAIL) continue;
    if (sharpCrossbars(nl, b, unit)) continue;
    // 原图上有两根通高直竖笔的是升号（当我们回到天家 p2 m6，两道横笔糊住、`sharpCrossbars` 验不出）
    if (tallStrokes(raster.bin, b) >= 2) continue;
    // 已认的符头盖住大半的块不是休止：按内腔找的空心头不认领块，斜腔的「8」字叠头
    // 去线后正是这副个头（《你的信实广大》末小节）
    if (syms.reduce((a, s0) => a + (s0.code.startsWith("notehead") ? overlapFrac(b, s0.box) : 0), 0) > 0.6) continue;
    // **贴着一根长干的不是休止**：头 + 尾（干已抽成竖段）剩下的一块，尺寸正落在四分休止这一档
    //（你的信实广大 m6、万古磐石歌 m12 低音的八分，尾弯回来贴着干）。四分休止不挨着干
    const stemBeside = prims.vSegs.some((v) => {
      const x = (v.x0 + v.x1) / 2;
      const y0 = Math.min(v.y0, v.y1);
      const y1 = Math.max(v.y0, v.y1);
      if (y1 - y0 < unit.space * 2.5) return false;
      if (Math.abs(x - b.x) > unit.space * 0.5 && Math.abs(x - (b.x + b.w)) > unit.space * 0.5) return false;
      return Math.min(y1, b.y + b.h) - Math.max(y0, b.y) >= b.h * 0.5;
    });
    if (stemBeside) continue;
    if (thin) {
      thinRests.push(c);
      continue;
    }
    merged.add(c.id);
    const code = isEighthRest(nl, b, c.area, unit) ? "rest8th" : "restQuarter";
    syms.push({ box: b, code });
    ledger.claim(b, `qrest:${code}`);
  }
  // **中段被抽成竖段的四分休止**：扫描件上休止笔画粗、中段笔直（破碎扫描版 p4 m? 1.1×3 格），原语那一步当竖段提走，
  // 块图里只剩碎块，上面那一路见不到它；那根竖段又被「贴着长干」那条当成了干。改在**没抹过的连通块**上认：
  // 尺寸、填充、位置各闸同上（宽度放到 `QREST_SPINE_W`：扫描笔画粗），块里有根竖段**整根包在块内**（休止自己的脊），
  // 就收成休止，那根竖段摘掉（不然当成干或小节线）
  for (const c of cmap.contours) {
    if (ledger.claimsOf(c.id).length) continue;
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    if (w < QREST_W[0] || w > QREST_SPINE_W || h < QREST_H[0] || h > QREST_H[1]) continue;
    const fill = c.area / Math.max(1, b.w * b.h);
    if (fill < QREST_FILL[0] || fill > QREST_FILL[1]) continue;
    // 让位到谱表外的也收（钢琴右手自己分两声部，上声部的四分休止抬到第五线上方，是爱 p4）
    if (!midOfStaff(b, staffLines, unit) && !(offStaffRest(b, staffLines, unit) && inGrandStaff(b, true))) continue;
    if (nearStaffStart(b, groups, staffLefts, unit) || afterKey(b) < unit.space * KEY_TAIL || sharpCrossbars(nl, b, unit)) continue;
    if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
    const inside = (v: LineSeg) => {
      const x = (v.x0 + v.x1) / 2;
      // 竖段是在带谱线的图上抽的，两端会伸进压着的谱线：上下各容半格
      return x >= b.x + 1 && x <= b.x + b.w - 1 && Math.min(v.y0, v.y1) >= b.y - unit.space * 0.5 && Math.max(v.y0, v.y1) <= b.y + b.h + unit.space * 0.5;
    };
    const spine = prims.vSegs.filter(inside);
    if (!spine.length) continue;
    // 块外还有贴着的长竖段（真干）就不是
    const stemOut = prims.vSegs.some((v) => {
      if (spine.includes(v)) return false;
      const x = (v.x0 + v.x1) / 2;
      if (Math.max(v.y0, v.y1) - Math.min(v.y0, v.y1) < unit.space * 2.5) return false;
      if (Math.abs(x - b.x) > unit.space * 0.5 && Math.abs(x - (b.x + b.w)) > unit.space * 0.5) return false;
      return Math.min(Math.max(v.y0, v.y1), b.y + b.h) - Math.max(Math.min(v.y0, v.y1), b.y) >= b.h * 0.5;
    });
    if (stemOut) continue;
    for (const v of spine) usedSegs.add(v);
    const code = isEighthRest(nl, b, c.area, unit) ? "rest8th" : "restQuarter";
    syms.push({ box: b, code });
    ledger.claim(b, `qrest:${code}`);
  }
  // **被谱线劈成两截的四分休止**：细笔的休止中段正压着一条谱线，去线后上下两块各只有一格多高，按块认的那一路高度不够；
  // 中段又不直、抽不出脊，上面那一路也不收（伯利恒之星钢琴右手每小节开头的附点四分休止，十处，每处少一拍半）。
  // 在修补图上取：碎块全无主、修补后连成一块的，尺寸、填充、位置各闸同按块那一路
  {
    const free = (id: number) => ledger.claimsOf(id).every((q) => q.by === "seg:Staff");
    const rv = candidateMap(cmap, rlayer, free);
    const cands: { bbox: (typeof rv.merged)[number]["bbox"]; area: number; pair: boolean }[] = rv.merged.map((c) => ({
      bbox: c.bbox,
      area: c.area,
      // 修补前是几块，或块图里没有哪块占到它八成高（碎的那截太小、进不了块图：一婴孩为我们降生 男声 m10）
      pair: rv.parts.get(c.id)!.length >= 2 || !blobs.some((q) => overlapFrac(q.bbox, c.bbox) > 0.5 && q.bbox.h >= c.bbox.h * 0.8),
    }));
    // 去线图上本就是一整块、块图里却碎成几截的（抽横段时把折弯那几行当横笔抹了：是爱 p1 m3 手写四分休止），也交给这一路；
    // 下面「一整块的归按块认那一路」那条要它在块图里碎成两块以上
    for (const c of cmap.contours) if (!rv.parts.has(c.id) && free(c.id) && c.bbox.h >= unit.space * QREST_H[0] && c.bbox.h <= unit.space * QREST_H[1]) cands.push({ bbox: c.bbox, area: c.area, pair: false });
    // 修补没连上的：上下两截只隔一道去掉的谱线（≤ 线粗 + 1）、左右大半叠着，拼成一块再认（一婴孩为我们降生 女声 m5/m8：
    // 劈口落在休止中段的折弯上，修补按竖向接续接不上斜笔）
    {
      const pool = rv.map.contours.filter((c) => (rv.parts.has(c.id) || free(c.id)) && c.bbox.h < unit.space * QREST_H[1]);
      for (const a of pool) {
        for (const d of pool) {
          const gap = d.bbox.y - (a.bbox.y + a.bbox.h);
          if (a === d || gap < -1 || gap > unit.lineThick + 1) continue;
          const ov = Math.min(a.bbox.x + a.bbox.w, d.bbox.x + d.bbox.w) - Math.max(a.bbox.x, d.bbox.x);
          if (ov < Math.min(a.bbox.w, d.bbox.w) * 0.5) continue;
          const x = Math.min(a.bbox.x, d.bbox.x);
          const bbox = { x, y: a.bbox.y, w: Math.max(a.bbox.x + a.bbox.w, d.bbox.x + d.bbox.w) - x, h: d.bbox.y + d.bbox.h - a.bbox.y };
          cands.push({ bbox, area: a.area + d.area, pair: true });
        }
      }
    }
    for (const c of cands) {
      const b = c.bbox;
      // 去线图上是两块以上（被谱线劈开的）；一整块的归按块认那一路
      if (!c.pair && blobs.filter((q) => overlapFrac(q.bbox, b) > 0.5).length < 2) continue;
      const w = b.w / unit.space;
      const h = b.h / unit.space;
      if (w < QREST_W[0] || w > QREST_W[1] || h < QREST_H[0] || h > QREST_H[1]) continue;
      const fill = c.area / Math.max(1, b.w * b.h);
      if (fill < QREST_FILL_PIECES || fill > QREST_FILL[1]) continue;
      // 按分好组的谱线判（`lines` 混着没成组的横线，五条一组会错位：伯利恒之星 p5 那几行）
      if (!midOfStaff(b, staffLines, unit) && !shiftedRest(b)) continue;
      if (nearStaffStart(b, groups, staffLefts, unit) || afterKey(b) < unit.space * KEY_TAIL || sharpCrossbars(nl, b, unit)) continue;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
      if (isEighthRest(repaired, b, c.area, unit, EIGHTH_REST_H_PIECES, EIGHTH_REST_FILL_PIECES)) continue;
      // 有一根几乎贯穿全高的直竖笔的是降号（爱是从神而来 p2 行末双纵线后换调的降号，竖杆被谱线劈开，最长竖墨占盒高 0.89~0.98）；
      // 四分休止是折线，直的那段至多六成（伯利恒之星的附点四分休止过 `tallStrokes` 的 55%，不能拿它判）
      // 两根通高竖笔的是还原号、升号（是爱 p2 的还原号，两笔错开、各只占七成高）
      if (longestVRun(raster.bin, b) > b.h * QREST_FLAT_RUN || tallStrokes(raster.bin, b) >= 2) continue;
      syms.push({ box: b, code: "restQuarter" });
      ledger.claim(b, "qrest:restQuarter");
      for (const q of blobs) if (overlapFrac(q.bbox, b) > 0.5) merged.add(q.id);
    }
  }

  // 偏细的那批：同一份谱里四分休止是同一个字形，本页已认出的里有宽高都差不过 `QREST_SAME` 格的，才收
  //（一婴孩为我们降生 男声 m8 细笔一整块，填充 0.30；同页别处的四分休止 0.33 上下）
  for (const c of thinRests) {
    const b = c.bbox;
    if (isEighthRest(nl, b, c.area, unit)) continue;
    // 细笔的降号个头与四分休止相近（烛光颂曲行首调号第五个降号，`afterKey` 找不到谱号时罩不住）：竖墨贯穿八成以上的不收
    if (longestVRun(raster.bin, b) > b.h * QREST_FLAT_RUN) continue;
    const twin = syms.some((s0) => s0.code === "restQuarter" && Math.abs(s0.box.w - b.w) <= unit.space * QREST_SAME && Math.abs(s0.box.h - b.h) <= unit.space * QREST_SAME);
    if (!twin || syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
    merged.add(c.id);
    syms.push({ box: b, code: "restQuarter" });
    ledger.claim(b, "qrest:restQuarter");
  }
}
/** 劈成几截再拼的四分休止填充下限：劈口那道谱线去掉后修补只补回一部分墨（一婴孩为我们降生 女声 m8 细笔，0.31） */
const QREST_FILL_PIECES = 0.28;
/** 偏细的四分休止填充下限，与「本页已认出的同尺寸四分休止」互证才收；尺寸差上限（格） */
const QREST_FILL_THIN = 0.27;
const QREST_SAME = 0.15;
/** 两声部让位的四分休止：心离中线至多几格（见 `shiftedRest`） */
const QREST_SHIFT = 1.8;
/** 劈开的、偏细的四分休止那两路：最长竖墨占盒高过这么多的是降号 */
const QREST_FLAT_RUN = 0.8;
/** 行首「谱号 + 调号」右沿往右这么多格里不收四分休止（没认出的调号、拍号在那里）。 */
const KEY_TAIL = 2;
/** 两截拼起来判的那两路（被谱线上下切开、球与斜笔左右断开）的高度下限：新编赞美诗那套小号字体的八分休止只有 1.55 格
 *（033、038 系统末那一排）。全局放到 1.4 时合唱谱是爱2 多出二十来个假八分休止（73.7 → 70.6）、独唱谱 −0.03，只给这两路 */
const EIGHTH_REST_H_PIECES = 1.4;
/** 斜笔连球一起被抽成竖段的八分休止：竖段长度（格）与斜率（横移 / 竖长）下限。是爱这类竖段斜 0.12~0.22。 */
const SLANT_REST_LEN = [1.3, 2.6] as const;
const SLANT_REST_SLANT = 0.1;
