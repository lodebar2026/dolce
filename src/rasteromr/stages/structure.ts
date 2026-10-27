// 建页之后（`recognizeRasterPage` 按顺序调）：谱面结构（符头、符干、符尾、小节线，谱号调号拍号，系统与小节）、
// 符杠与符头的修正、拼好音符后的修正、跨谱表补漏的几个探针。

import type { Tag, SPage, Staff, Sym } from "../../staffomr/model";
import type { LineFrame } from "../pitchgrid";
import { type RasterUnit, LineGrid, pitchPos, pitchY } from "../staffline";
import type { RasterPage } from "../rasterpage";
import type { Binary, Rect } from "../../omrkit/types";
import { type RasterPrims, type BeamQuad, binSig } from "../prims";
import { ContourLedger } from "../ledger";
import { type TimeColumn, shareSystemClefs, shareOctaveClefs, shareTimeSignature } from "../clefmeter";
import type { HarmonyToken } from "../harmony";
import type { ContourMap } from "../contour";
import type { JianpuBand } from "../jianpuband";
import { type StaffContext, findClefKeyTime, type BeamShape, type StemInfo, type StaffNote } from "../../staffomr/notedata";
import { findNoteheads, tagSystemBarlines, findStems, findTails, findBarlines, makeSystems, makeBars } from "../../staffomr/page";
import { inkSystemBarlines, bridgeFaintSysLines, dropLoneBarlines, voteSystemBarlines } from "../barvote";
import { tagLooseStems, mergeSplitStems, splitUnisons, doubleUnisonWholes, markCrossStaff } from "../stems";
import { bootstrapFlags, toBeamShapes, snapBeamEnds } from "../flags";
import { makeSymObj, type RasterSym } from "../adapt";
import { dropCourtesyKeys, demoteMidKeys, extendKeyChains, dropHeadsInKey, pruneMidKeys, fixKeyNaturals, keySections, extendKeyByStrokes, shareSystemKeys, shareKeySignature, carrySystemKeys, extendKeyByCarry, findMidKeysByTemplate, shareMidKeys, dropBarsInKey, keyFromChords, fixFlatReadAsSix, attachAccidentalsByPitch, naturalsByStrokes } from "../keysig";
import { markRepeatsAndVoltas } from "../repeats";
import type { PageCarry, ClefTally } from "../recognize";
import { RasterGlyphLookup, matchTemplate } from "../rasterglyphs";
import { enclosedWhite, longestVRun, tallStrokes } from "../restshape";
import { stemWalledCavity } from "../notehead";
import { fixDottedPairs, fixQuartersByBarSum, dropBorrowedBeams, tupletsByBarSum } from "../rhythmfix";
import { findTuplets } from "../../staffomr/notations";
import { QREST_SPINE_W, QREST_W, QREST_H, QREST_FILL } from "./shared";
import { type HeadMask, scoreAtMasked } from "../headmask";
import { type HeadSearch, type DotProbe, type GapProbe, fixByCrossStaff } from "../crossalign";
import type { SmuflName } from "../../staffomr/glyphs";

/** 记账时算「这条段有主」的标记。见 `makeBars` 之后那一段。 */
const SEG_TAGS: Tag[] = ["Staff", "Leger", "Stem", "BarLine", "SysLine", "Tail", "Beam", "Bracket"];
/** 细杠起头那截扁墨的高度上限（格，`beamRoot`）：望十架 p3 两处 0.6、0.68，正常实心头 0.9 起。 */
const BEAM_ROOT_H = 0.75;
/** 头盒落在符尾盒里的比例过这个数就不算头（见建音符前那一段）。 */
const FLAG_HEAD_OVERLAP = 0.5;
/** 量头落不落在符尾里时，符尾盒往尾梢那头延长的格数（见用处）。 */
const FLAG_TAIL_EXT = 1.5;
/** 实心头中心椭圆里白占这么多以上、又没有杠和尾的，时值按空心头算（见 `hollowish`）。 */
const HOLLOW_FILL = 0.3;
/** 封闭内腔面积占头盒的下限（`hollowish` 的另一路）。 */
const HOLLOW_CAVITY = 0.1;
/** 封闭内腔那一路只看盒高不过这么多格的小头。 */
const HOLLOW_SMALL_H = 0.8;
/** 谱表外的头按墨定高时，墨高（格）要在这个范围里才算一个头。 */
const HEAD_INK_H = [0.8, 1.3] as const;
/** 谱线、加线上的「杠」厚不过这么多格、又挨着符头的不算层数（见 `thinOnLine`）。 */
const THIN_BEAM_H = 0.3;

/** 谱面结构：符头、符干、符尾、小节线，谱号调号拍号（从这里起等上一页的沿用），系统与小节 */
export async function buildPageStructure(c: {
  pg: SPage;
  frames: LineFrame[];
  unit: RasterUnit;
  raster: RasterPage;
  nl: Binary;
  prims: RasterPrims;
  harmonyMasks: Rect[];
  ledger: ContourLedger;
  carryOf: () => Promise<PageCarry>;
  timeCols: TimeColumn[];
  harmonies: HarmonyToken[];
  cmap: ContourMap;
  jianpuBands: JianpuBand[];
}): Promise<{
  ctx: Map<Staff, StaffContext>;
  carry: PageCarry;
  clefTally: ClefTally;
}> {
  const { pg, frames, unit, raster, nl, prims, harmonyMasks, ledger, carryOf, timeCols, harmonies, cmap, jianpuBands } = c;
  // ── 谱面结构：符头、符干、符尾、小节线，谱号调号拍号（从这里起等上一页的沿用），系统与小节
  // 读音高按该处实测的五线、相邻两线间的相对位置（`Staff.middleStep`）
  for (const stf of pg.staves) {
    if (stf.lineYs.length !== 5) continue;
    const f = frames.find((q) => Math.abs(q.top - stf.lineYs[0]) < unit.space);
    if (f) stf.lineYsAt = f.at;
  }

  findNoteheads(pg);
  inkSystemBarlines(pg, raster.bin, unit.space);
  tagSystemBarlines(pg);
  findStems(pg);
  tagLooseStems(pg);
  mergeSplitStems(pg);
  // 符尾**按位置自举**，不查字典（见 `bootstrapFlags`）
  for (const f of bootstrapFlags(nl, pg, prims.beams, unit, harmonyMasks)) {
    ledger.claim(f.box, `flag:${f.code}`);
    const { obj, sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, f, unit.height);
    pg.objs.push(obj);
    pg.symbols.push(sym);
  }
  findTails(pg);
  findBarlines(pg);
  bridgeFaintSysLines(pg, raster.bin, unit.space);
  dropLoneBarlines(pg, raster.bin, unit.space);
  voteSystemBarlines(pg, raster.bin, unit.space);
  const ctx = findClefKeyTime(pg);
  // 小节线的 x 先交给调号（`keyChanges` 分行首与行中转调要用，这时还没切小节）
  for (const [st, c] of ctx) c.barXs = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && l.bottom > st.box.top && l.top < st.box.bottom).map((l) => l.cx);
  shareSystemClefs(pg, ctx, unit);
  // 从这里起要用上一页的沿用（并行时这里才等上一页交出来）
  const carry = await carryOf();
  const clefTally = shareOctaveClefs(pg, ctx, carry.carryKey?.clefs);
  dropCourtesyKeys(pg, ctx, unit.space);
  demoteMidKeys(pg, ctx);
  extendKeyChains(pg, ctx);
  dropHeadsInKey(pg, ctx);
  pruneMidKeys(pg, ctx, raster.bin, unit.space);
  fixKeyNaturals(ctx, raster.bin, unit.space);
  // 调号的几道全页共享**按段**做（见 `keySections`：一页印几首、各自重印拍号的，各段调号不同）
  for (const sec of keySections(pg, ctx, raster.bin)) {
    extendKeyByStrokes(pg, sec, raster.bin, unit);
    const settled = shareSystemKeys(pg, sec);
    shareKeySignature(sec, settled);
    carrySystemKeys(pg, sec, settled);
  }
  extendKeyByCarry(ctx, carry.carryKey, raster.bin, unit.space);
  findMidKeysByTemplate(pg, ctx, raster.bin, unit);
  shareMidKeys(pg, ctx, unit.space);
  dropHeadsInKey(pg, ctx, true);
  shareTimeSignature(pg, ctx, timeCols, unit, raster.bin, !!carry.carryTime);
  dropBarsInKey(pg, ctx, unit.space);
  keyFromChords(pg, ctx, harmonies.map((h) => h.text), unit);
  fixFlatReadAsSix(harmonies, ctx);
  makeSystems(pg);
  makeBars(pg);
  // 反复记号、房子、同系统的小节线样式（`repeats.ts`）：下游按线宽与圆点符号认，位图路两样常缺，回到图上量
  for (const b of markRepeatsAndVoltas(pg, raster.bin, cmap, unit.space, jianpuBands.map((b) => b.box))) ledger.claim(b, "repeat:dot");
  // 段的认领：**只记挂上标记的**（谱线/加线/符干/小节线/系统线/符尾）。
  // 没挂上标记的段是「抽出来了却没人要」的，留着当无主，那才是线索。
  for (const sg of pg.segs) {
    const tag = SEG_TAGS.find((t) => sg.hasTag(t));
    if (tag) ledger.claim({ x: sg.box.left, y: sg.box.top, w: sg.box.right - sg.box.left, h: sg.box.bottom - sg.box.top }, `seg:${tag}`);
  }
  return { ctx, carry, clefTally };
}

/** 符杠与符头：杠的层数、实心其实空心、细杠起头、贴头的四分休止、符尾盒里的头、谱表外的头按加线定音高 */
export function fixBeamsAndHeads(c: {
  pg: SPage;
  unit: RasterUnit;
  onGrid: (y: number, x?: number) => boolean;
  grid: LineGrid;
  nl: Binary;
  prims: RasterPrims;
  raster: RasterPage;
  look: RasterGlyphLookup;
}): {
  beams: BeamShape[];
  stems: StemInfo[];
  hollowish: (s0: Sym) => boolean;
} {
  const { pg, unit, onGrid, grid, nl, prims, raster, look } = c;
  // ── 符杠与符头：杠的层数、实心其实空心、细杠起头、贴头的四分休止、符尾盒里的头、谱表外的头按加线定音高
  // **谱线、加线上挨着符头的薄条不算杠的层数**：线压着符头、被头的墨撑厚成三四像素，过了符杠那道闸
  //（我一生要赞美你 m5–6 第五线上的 D4，八分读成十六分）。照旧留在 `prims.beams` 里抹墨（过检的杠是承重的，
  // 直接丢掉该曲音符 −5.2），只是不交给下游数层数。真杠约半格厚、离头两三格
  //（斜的网点杠只检出靠线的一片时也薄，所以要「挨着头」：大地风光 m1）
  const noteHeads = pg.symbols.filter((s0) => s0.hasTag("Note") && /^notehead/.test(s0.code));
  const thinOnLine = (b: BeamQuad) => {
    if (b.box.h > unit.space * THIN_BEAM_H) return false;
    const cy = b.box.y + b.box.h / 2;
    const bx = b.box.x + b.box.w / 2;
    if (!onGrid(cy, bx) && !grid.onLine(cy, unit.lineThick + 1, bx)) return false;
    return noteHeads.some((h) => h.box.left < b.box.x + b.box.w && h.box.right > b.box.x && Math.abs((h.box.top + h.box.bottom) / 2 - cy) <= unit.space * 0.6);
  };
  // **歌词字的一横不是杠**：朝上的短干顶到上方歌词行，字里一道粗横笔过了符杠的闸（来敬拜荣耀王 m16 A3 读成八分）。
  // 杠所在那团墨（去线图上局部灌）碰不到任何符干与符头、又是一个字的大小，就不交给下游
  const stemSegs0 = pg.segsWithTag("Stem");
  const textStroke = (b: BeamQuad) => {
    const sp = unit.space;
    const wx0 = Math.max(0, Math.round(b.box.x - sp * 3));
    const wy0 = Math.max(0, Math.round(b.box.y - sp * 3));
    const wx1 = Math.min(nl.w - 1, Math.round(b.box.x + b.box.w + sp * 3));
    const wy1 = Math.min(nl.h - 1, Math.round(b.box.y + b.box.h + sp * 3));
    const W = wx1 - wx0 + 1;
    const seen = new Uint8Array(W * (wy1 - wy0 + 1));
    const st: number[] = [];
    for (let y = Math.round(b.box.y); y < b.box.y + b.box.h; y++)
      for (let x = Math.round(b.box.x); x < b.box.x + b.box.w; x++)
        if (x >= wx0 && x <= wx1 && y >= wy0 && y <= wy1 && nl.data[y * nl.w + x] && !seen[(y - wy0) * W + x - wx0]) {
          seen[(y - wy0) * W + x - wx0] = 1;
          st.push(x, y);
        }
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    while (st.length) {
      const y = st.pop()!;
      const x = st.pop()!;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      // 出窗口的就不是一个字大小
      if (x === wx0 || x === wx1 || y === wy0 || y === wy1) return false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx;
        const Y = y + dy;
        if (X < wx0 || X > wx1 || Y < wy0 || Y > wy1 || !nl.data[Y * nl.w + X] || seen[(Y - wy0) * W + X - wx0]) continue;
        seen[(Y - wy0) * W + X - wx0] = 1;
        st.push(X, Y);
      }
    }
    if (!isFinite(x0)) return false;
    const w = (x1 - x0 + 1) / sp;
    const h = (y1 - y0 + 1) / sp;
    if (h < 1.5 || h > 3 || w > 3) return false;
    const inside = (x: number, y: number) => x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1;
    if (noteHeads.some((s0) => inside((s0.box.left + s0.box.right) / 2, (s0.box.top + s0.box.bottom) / 2))) return false;
    return !stemSegs0.some((s0) => inside(s0.cx, s0.top) || inside(s0.cx, s0.bottom));
  };
  const beams = toBeamShapes(prims.beams.filter((b) => !thinOnLine(b) && !textStroke(b)));
  snapBeamEnds(beams, pg.segs.filter((sg) => sg.isV && sg.hasTag("Stem")), raster.bin, unit.space, unit.lineThick, noteHeads.map((s0) => s0.box));
  const stems: StemInfo[] = [];
  // **认成实心、其实中间是空的头**：圈细、内腔被没抹掉的谱线切成几小块的空心头（耶和华、高举主大能、你的信实广大），
  // 过不了空心头的形状闸，被收成实心。头的中心椭圆（半径取盒的三成，跳过谱线那几行）里白占 HOLLOW_FILL 以上、
  // 又没有杠和尾的，时值按空心头算。不在收头那一步改种类：改成空心头会走另一套收头规则，全音符大小的头反倒丢了（主使我喜乐）。
  // 小一号的头（盒高不过 `HOLLOW_SMALL_H` 格）还可以看**封闭的内腔**：最大一块够头盒的 `HOLLOW_CAVITY` 就算空心。
  // 小字号的空心头（以马内利来临歌，头盒 10×7）内腔是一道斜窄缝，头盒又常只罩住头的上半截，按盒中心的椭圆量不出白来
  const hollowish = (s0: Sym): boolean => {
    const b = s0.box;
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    const rx = (b.right - b.left) * 0.3;
    const ry = (b.bottom - b.top) * 0.3;
    let wht = 0;
    let tot = 0;
    for (let y = Math.ceil(cy - ry); y <= cy + ry; y++) {
      if (grid.onLine(y, unit.lineThick / 2 + 1, cx)) continue;
      for (let x = Math.ceil(cx - rx); x <= cx + rx; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        tot++;
        if (!raster.bin.data[y * raster.bin.w + x]) wht++;
      }
    }
    if (tot > 0 && wht / tot >= HOLLOW_FILL) return true;
    // 只看小一号的头：正常大小的头旁边，头、干、谱线三面也围得出一块白（父恩广大、称谢歌伴奏的四分读成二分）
    if (b.bottom - b.top > unit.space * HOLLOW_SMALL_H) return false;
    return enclosedWhite(nl, b, unit.space) >= (b.right - b.left) * (b.bottom - b.top) * HOLLOW_CAVITY;
  };
  // **细杠的起头那一截**：杠细（不到 0.35 格，原语里常收不出杠来），杠与干尖、谱线糊成一块扁墨，收头时的 `atBeamEnd` 够不着。
  // 扁（不过 `BEAM_ROOT_H` 格）的实心头、一侧边上贴着一根干的端头、这根干往外伸两格以上另一端落在一个正常大小的头上，
  // 扁块另一侧还有横墨接着伸出去一格（杠身）——干的两端不会都是头（望十架 p3 m26、m27 八分 C4、F4 的杠起头读成 D5、F5）。
  // 放在各路头都收齐之后：干那端的真头多半是后面几路补出来的
  {
    const sp = unit.space;
    const heads = pg.symbols.filter((s0) => s0.hasTag("Note") && /^notehead/.test(s0.code));
    const beamRoot = (h: Sym) => {
      const b = h.box;
      if (h.code !== "noteheadBlack" || b.bottom - b.top > sp * BEAM_ROOT_H) return false;
      return prims.vSegs.some((v) => {
        const x = (v.x0 + v.x1) / 2;
        const atLeft = Math.abs(x - b.left) <= 2;
        const atRight = Math.abs(x - b.right) <= 2;
        if (!atLeft && !atRight) return false;
        const t = Math.min(v.y0, v.y1);
        const d = Math.max(v.y0, v.y1);
        const far = t >= b.top - 3 && t <= b.bottom + 3 && d >= b.bottom + sp * 2 ? d : d >= b.top - 3 && d <= b.bottom + 3 && t <= b.top - sp * 2 ? t : null;
        if (far === null) return false;
        if (!heads.some((o) => o !== h && o.box.bottom - o.box.top >= sp * 0.8 && x >= o.box.left - 3 && x <= o.box.right + 3 && far >= o.box.top - 3 && far <= o.box.bottom + 3)) return false;
        // 杠身：扁块外侧（干的对面）往外一格，每列在扁块上下半格内都有墨。细杠常压着谱线、去线时一起抹掉了，
        // 所以在原图上量，谱线那几行不算
        const B = raster.bin;
        const dir = atLeft ? 1 : -1;
        const xs = Math.round(atLeft ? b.right + 1 : b.left - 1);
        const n = Math.round(sp);
        let hit = 0;
        for (let k = 0; k < n; k++) {
          const cx = xs + dir * k;
          if (cx < 0 || cx >= B.w) break;
          for (let y = Math.max(0, Math.round(b.top - sp * 0.5)); y <= Math.min(B.h - 1, Math.round(b.bottom + sp * 0.5)); y++)
            if (B.data[y * B.w + cx] && !grid.onLine(y, unit.lineThick / 2 + 1, cx)) {
              hit++;
              break;
            }
        }
        return hit >= n * 0.9;
      });
    };
    const drop = new Set(heads.filter(beamRoot));
    if (drop.size) pg.symbols = pg.symbols.filter((s0) => !drop.has(s0));
  }
  // **顶端细细连在头上的四分休止**：两声部时另一声部的休止紧贴着这个头的上下（扫描件上休止顶端那一笔细、连上了头），
  // 整块被收头那一路认领，休止没人认（望十架 p3 m26 女高女低：上声部 C4 八分、下声部四分休止挂在 C4 底下）。
  // 头正下（正上）方从贴着头的那两行起灌墨（窗口横向出头缘半格、纵向 3.5 格），灌出来的一块够休止的高宽、
  // 没有通高的直竖笔（那是干）、碰不到窗口远端，单独裁出来按形状字典是四分休止，就补一个
  {
    const sp = unit.space;
    const B = raster.bin;
    const restTpl = (look.templates ?? []).filter((t) => t.smufl === "restQuarter" || t.smufl === "rest8th");
    const heads = pg.symbols.filter((s0) => s0.hasTag("Note") && /^notehead/.test(s0.code) && s0.ownerStaff);
    const taken = pg.symbols.filter((s0) => s0.hasTag("Note")).map((s0) => s0.box);
    const added: Sym[] = [];
    for (const h of restTpl.length ? heads : []) {
      for (const dir of [1, -1]) {
        const x0 = Math.max(0, Math.round(h.box.left - sp * 0.5));
        const x1 = Math.min(B.w - 1, Math.round(h.box.right + sp * 0.5));
        const y0 = Math.max(0, Math.round(dir > 0 ? h.box.bottom + 1 : h.box.top - sp * 3.5));
        const y1 = Math.min(B.h - 1, Math.round(dir > 0 ? h.box.bottom + sp * 3.5 : h.box.top - 1));
        if (y1 - y0 < sp * 2) continue;
        const W = x1 - x0 + 1;
        const seen = new Uint8Array(W * (y1 - y0 + 1));
        const stack: number[] = [];
        const near = dir > 0 ? [y0, y0 + 1] : [y1, y1 - 1];
        for (const y of near) for (let x = Math.round(h.box.left); x <= Math.round(h.box.right); x++) if (B.data[y * B.w + x] && !seen[(y - y0) * W + x - x0]) (seen[(y - y0) * W + x - x0] = 1), stack.push(x, y);
        let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, edge = false;
        while (stack.length) {
          const y = stack.pop()!;
          const x = stack.pop()!;
          if (x === x0 || x === x1 || y === (dir > 0 ? y1 : y0)) edge = true;
          bx0 = Math.min(bx0, x), bx1 = Math.max(bx1, x), by0 = Math.min(by0, y), by1 = Math.max(by1, y);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || !B.data[ny * B.w + nx]) continue;
              const k = (ny - y0) * W + nx - x0;
              if (seen[k]) continue;
              seen[k] = 1;
              stack.push(nx, ny);
            }
        }
        if (edge || !isFinite(bx0)) continue;
        const box = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
        if (box.h < sp * 1.8 || box.h > sp * 3.3 || box.w < sp * 0.5 || box.w > sp * 1.2) continue;
        if (longestVRun(B, box) >= box.h * 0.85) continue;
        if (taken.some((t) => t !== h.box && t.left < box.x + box.w && t.right > box.x && t.top < box.y + box.h && t.bottom > box.y)) continue;
        if (matchTemplate(binSig(nl, box), box.w / sp, box.h / sp, restTpl)?.smufl !== "restQuarter") continue;
        const { obj, sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, { box, code: "restQuarter" } as RasterSym, unit.height);
        sym.addTag("Note");
        sym.ownerStaff = h.ownerStaff;
        pg.objs.push(obj);
        added.push(sym);
        taken.push(sym.box);
      }
    }
    pg.symbols.push(...added);
  }
  // **大半落在符尾盒里的头不要**：同一块墨先被收成头、后又被符尾自举认成符尾（《所信有根基》八分的尾读成一个 A4 二分）
  {
    const flags = pg.symbols.filter((s0) => s0.hasTag("Tail"));
    // 符尾盒往尾梢那头延 `FLAG_TAIL_EXT` 格：扫描件上尾卷的下半截常被抽成一根竖段、围出的白收成头，符尾盒只罩住了上半
    //（望十架 p8 m63 低音 D3 八分的尾读成 A3/F3 两个二分）
    const inFlag = (h: Sym) => flags.some((f) => {
      const reach = unit.space * FLAG_TAIL_EXT;
      const top = /Down$/.test(f.code) ? f.box.top - reach : f.box.top;
      const bottom = /Up$/.test(f.code) ? f.box.bottom + reach : f.box.bottom;
      const w = Math.min(h.box.right, f.box.right) - Math.max(h.box.left, f.box.left);
      const hh = Math.min(h.box.bottom, bottom) - Math.max(h.box.top, top);
      return w > 0 && hh > 0 && w * hh >= (h.box.right - h.box.left) * (h.box.bottom - h.box.top) * FLAG_HEAD_OVERLAP;
    });
    // 只剔**空心**的、且左边紧挨着另有一个头（这根朝上的干的头，右缘贴着干）：真的空心头也会被误认出符尾
    //（《救主降生》干两端都是空心头，符尾自举只看实心头，把上端当成自由端），它左边没有别的头
    const sp0 = unit.space;
    const heads = pg.symbols.filter((s0) => s0.hasTag("Note") && /^notehead/.test(s0.code));
    const besideHead = (h: Sym) =>
      heads.some((o) => o !== h && Math.abs(o.box.right - h.box.left) <= sp0 * 0.6 && Math.abs(o.py - h.py) <= sp0 * 2.5 && o.box.left < h.box.left);
    // 或者**同一根干的另一端是实心头**：尾是那个实心头的，真二分头不带尾（所信有根基 m4、m12，我一生要赞美你 m36，
    // 尾弯回来围出的白被收成空心头或全音符）。救主降生那种两端都是空心头的不受影响
    const stemSegs0 = pg.segs.filter((sg) => sg.isV && sg.hasTag("Stem"));
    const blacks = heads.filter((o) => o.code === "noteheadBlack");
    const otherEndBlack = (h: Sym) =>
      stemSegs0.some((st) => {
        if (st.box.left > h.box.right + sp0 * 0.3 || st.box.right < h.box.left - sp0 * 0.3) return false;
        if (st.box.bottom < h.box.top - sp0 * 0.3 || st.box.top > h.box.bottom + sp0 * 0.3) return false;
        const hcy = (h.box.top + h.box.bottom) / 2;
        const far = Math.abs(hcy - st.box.top) < Math.abs(hcy - st.box.bottom) ? st.box.bottom : st.box.top;
        if (Math.abs(far - hcy) < sp0 * 1.5) return false;
        return blacks.some((o) => o.box.left <= st.box.right + sp0 * 0.3 && o.box.right >= st.box.left - sp0 * 0.3 && far >= o.box.top - sp0 * 0.5 && far <= o.box.bottom + sp0 * 0.5);
      });
    // 再要内腔有一侧直接就是干（`notehead.ts::stemWalledCavity`）：两声部共干、另一端是实心头的真二分头，
    // 上面偶尔也会误认出一个尾（耶和华是我的牧者 m17 加一线上的 A5）
    const walled = (h: Sym) => {
      const b = { x: Math.round(h.box.left), y: Math.round(h.box.top), w: Math.round(h.box.right - h.box.left), h: Math.round(h.box.bottom - h.box.top) };
      return stemWalledCavity(raster.bin, b, sp0) || stemWalledCavity(raster.bin, b, sp0, true);
    };
    pg.symbols = pg.symbols.filter(
      (s0) => !(s0.hasTag("Note") && inFlag(s0) && ((s0.code === "noteheadHalf" && besideHead(s0)) || ((s0.code === "noteheadHalf" || s0.code === "noteheadWhole") && otherEndBlack(s0) && walled(s0)))),
    );
  }
  // **谱表外的头按实际加线定音高**：加线上下一格就是一级，按整行线距外推，头心偏出小半格就读错一级。
  // 两种偏法：头盒偏了（当我们回到天家 m14 加一线上的 C4，头盒比墨低 4 像素，读成 B3；你的信实广大 m10、耶和华是我的牧者 m4 同），
  // 加线画得不按线距（晨曦破晓一页的加一线比外推的位置高 3 像素）。
  // 头心：在头中段那几列里，从头盒中心往上下走到墨断，墨高像一个头（0.8~1.3 格）、没碰到五线的，取这段墨的中心；
  // 和弦叠头连成两格高、空心头的内腔把墨断开、「8」字叠头顺着谱线连到里面那个头（万古磐石歌），仍用头盒中心。
  // 格子：谱表边线加上头左右那一段的加线，从边线往外逐条排；头心落在哪条线上（离线不到格距的 0.25）、哪个间里，就是哪一级。
  // 超出最外一条加线 0.75 格的不管（照旧按线距外推）
  {
    const B = raster.bin;
    const legers = pg.segsWithTag("Leger").filter((sg) => sg.isH);
    for (const h of pg.symbols) {
      if (!h.hasTag("Note") || !/^notehead/.test(h.code) || !h.ownerStaff || h.ownerStaff.lineYs.length !== 5) continue;
      const stf = h.ownerStaff;
      const hx = (h.box.left + h.box.right) / 2;
      const ys = stf.lineYsAt ? stf.lineYsAt(hx) : stf.lineYs;
      // 格距一律按本行谱自己的线距：一页上常有小一号的谱行（望十架每个系统的长笛行线距 21px、整页 23.4px），
      // 按整页的量，小谱上第二加线上的 C6 落在「最外加线外 0.9 格以内」读成 B5
      const sp0 = (ys[4] - ys[0]) / 4;
      if (h.py > ys[0] - sp0 * 0.3 && h.py < ys[4] + sp0 * 0.3) continue;
      const above = h.py < ys[0];
      const lineRow = (y: number) => ys.some((ly) => Math.abs(ly - y) <= unit.lineThick);
      let yc = h.py;
      {
        const w = h.box.right - h.box.left;
        const x0 = Math.max(0, Math.round(h.box.left + w * 0.2));
        const x1 = Math.min(B.w - 1, Math.round(h.box.right - w * 0.2));
        const rowInk = (y: number) => {
          if (y < 0 || y >= B.h) return false;
          for (let x = x0; x <= x1; x++) if (B.data[y * B.w + x]) return true;
          return false;
        };
        const cy = Math.round(h.py);
        if (rowInk(cy)) {
          let t = cy;
          let b = cy;
          while (rowInk(t - 1) && cy - t < sp0 * 1.5) t--;
          while (rowInk(b + 1) && b - cy < sp0 * 1.5) b++;
          const hh = (b - t + 1) / sp0;
          let crosses = false;
          for (let y = t; y <= b && !crosses; y++) crosses = lineRow(y);
          if (hh >= HEAD_INK_H[0] && hh <= HEAD_INK_H[1] && !crosses) yc = (t + b) / 2;
        }
      }
      // 边线往外的格子：边线、加线（同一条加线常拆成几段，按 y 并起来）
      const edge = above ? ys[0] : ys[4];
      const out = above ? -1 : 1;
      const spL = sp0;
      const grid = [edge];
      const ly = legers
        // 加线比头宽，至少一侧伸出头外：只在头里面的横墨是粗体头自己的笔画（我一生要赞美你）
        .filter((sg) => sg.left < h.box.right + sp0 * 0.3 && sg.right > h.box.left - sp0 * 0.3)
        .filter((sg) => sg.left <= h.box.left - sp0 * 0.15 || sg.right >= h.box.right + sp0 * 0.15)
        .map((sg) => (sg.y0 + sg.y1) / 2)
        .filter((y) => (y - edge) * out > sp0 * 0.5 && (y - yc) * out < sp0 * 0.5)
        .sort((p, q) => (p - q) * out);
      // 手写谱的加一线常画远了（是爱 p3 m33 高音 A5：加线离顶线 1.5 格、头心正骑在上面，外推读成 B5；这条线也不在加线段表里）：
      // 一条加线都没认着时，在二值图上找头心上下 0.25 格内、头左右两侧都伸出去的横墨；它离边线 1.25~1.75 格、
      // 该在加一线的那一带头两侧又都没有横墨的，就是加一线本身，不是缺了加一线的加二线
      const sideInk = (yy: number) => {
        if (yy < 0 || yy >= B.h) return false;
        const m = Math.max(3, Math.round(sp0 * 0.3));
        const side = (xa: number, xb: number) => {
          let n = 0;
          for (let x = Math.max(0, xa); x <= Math.min(B.w - 1, xb); x++) if (B.data[yy * B.w + x]) n++;
          return n >= (xb - xa + 1) * 0.6;
        };
        return side(Math.round(h.box.left) - m, Math.round(h.box.left) - 2) && side(Math.round(h.box.right) + 2, Math.round(h.box.right) + m);
      };
      const farFirstLeger = (): number | undefined => {
        const rows: number[] = [];
        for (let y = Math.round(yc - sp0 * 0.25); y <= Math.round(yc + sp0 * 0.25); y++) if (sideInk(y)) rows.push(y);
        if (!rows.length) return undefined;
        const y = (rows[0] + rows[rows.length - 1]) / 2;
        const d = (y - edge) * out;
        if (d <= spL * 1.25 || d > spL * 1.75) return undefined;
        for (let k = Math.round(sp0 * 0.7); k <= Math.round(sp0 * 1.3); k++) if (sideInk(Math.round(edge + out * k))) return undefined;
        return y;
      };
      for (const y of ly) {
        const last = grid[grid.length - 1];
        const d = (y - last) * out;
        if (d < sp0 * 0.5) continue; // 同一条加线拆成的几段
        // 间距要像一格：近了是别的横墨（跳过它接着找：按头盒补的加线常与真加线差两三像素，是爱 p1 m15 低音 F4），
        // 远了是中间缺了一条，往外的都不可靠
        if (d < spL * 0.8) continue;
        if (d > spL * 1.25) break;
        grid.push(y);
      }
      if (grid.length === 1) {
        const y = farFirstLeger();
        if (y !== undefined) grid.push(y);
      }
      let pos = -1; // 从边线往外的半格数
      const gapAt = (i: number) => (i + 1 < grid.length ? (grid[i + 1] - grid[i]) * out : i > 0 ? (grid[i] - grid[i - 1]) * out : sp0);
      let j = 0;
      for (let i = 1; i < grid.length; i++) if (Math.abs(yc - grid[i]) < Math.abs(yc - grid[j])) j = i;
      const dj = (yc - grid[j]) * out;
      if (Math.abs(dj) <= gapAt(j) * 0.25) pos = j * 2;
      // 最外那条线以外：间里的头心离线半格、加线上的一格，过 0.75 格的是没认出加线的那一级，交给 `middleStep` 外推
      else if (dj > 0) pos = j + 1 < grid.length || dj < sp0 * 0.75 ? j * 2 + 1 : -1;
      else pos = j > 0 ? j * 2 - 1 : -1;
      if (pos < 0) continue;
      // 换成这一级的理想 y，交给 `middleStep` 读；级数没变的不动（临时记号按 py 配对，挪了会配岔：信心使我得胜）
      const py = edge + (out * (pos * spL)) / 2;
      if (stf.middleStep(py, hx) !== stf.middleStep(h.py, hx)) h.py = py;
    }
  }
  return { beams, stems, hollowish };
}

/** 音符修正：被认成音的升降号与休止、按音高配临时记号、同音、跨谱表、附点对、连音 */
export function fixNotes(c: {
  notes: StaffNote[];
  unit: RasterUnit;
  raster: RasterPage;
  pg: SPage;
  nl: Binary;
  ctx: Map<Staff, StaffContext>;
  stems: StemInfo[];
  beams: BeamShape[];
  carry: PageCarry;
}): void {
  const { notes, unit, raster, pg, nl, ctx, stems, beams, carry } = c;
  // ── 音符修正：被认成音的升降号与休止、按音高配临时记号、同音、跨谱表、附点对、连音
  // 谱表外的四分休止再验一遍「是不是升降号」：收休止那时谱表外带加线的头还没认出来，贴着头的升降号拦不住
  //（主爱说不尽歌低音谱表上方 C4 前的还原号）。右边 2.4 格内有个头、头心落在这一块的高度里（上下各容半格）的，删掉。
  for (let i = notes.length - 1; i >= 0; i--) {
    const r = notes[i];
    if (!r.rest || r.sym.code !== "restQuarter") continue;
    const rb = r.sym.box;
    const cy = (rb.top + rb.bottom) / 2;
    if (cy >= r.staff.box.top && cy <= r.staff.box.bottom) continue;
    const beside = notes.some((n) => {
      if (n.rest) return false;
      const dx = n.sym.box.left - rb.right;
      const hy = (n.sym.box.top + n.sym.box.bottom) / 2;
      return dx >= -unit.space * 0.3 && dx <= unit.space * 2.4 && hy >= rb.top - unit.space * 0.5 && hy <= rb.bottom + unit.space * 0.5;
    });
    if (beside) notes.splice(i, 1);
  }
  // **谱表里读成四分休止的降号**：扫描件上降号的肚子与竖笔连得细，字典常认成四分休止（望十架 p7 m55 B♭5 前的降号，
  // 那一小节的升降全按调号读）。四分休止是折线，没有一根贯通的直竖笔；降号有一根、肚子在下面。
  // 右边一格半以内有个头、头心落在这一块的下半截（肚子那里），块里只数出一根通高竖笔的，改成降号交给临时记号那一路。
  for (let i = notes.length - 1; i >= 0; i--) {
    const r = notes[i];
    if (!r.rest || r.sym.code !== "restQuarter") continue;
    const rb = r.sym.box;
    const hgt = rb.bottom - rb.top;
    const owner = notes.some((n) => {
      if (n.rest || n.staff !== r.staff) return false;
      const dx = n.sym.box.left - rb.right;
      const hy = (n.sym.box.top + n.sym.box.bottom) / 2;
      return dx >= -unit.space * 0.3 && dx <= unit.space * 1.5 && hy >= rb.top + hgt * 0.45 && hy <= rb.bottom + unit.space * 0.25;
    });
    if (!owner) continue;
    const pad = Math.round(unit.space * 0.3);
    if (tallStrokes(raster.bin, { x: rb.left - pad, y: rb.top, w: rb.right - rb.left + pad * 2, h: hgt }) !== 1) continue;
    r.sym.code = "accidentalFlat";
    // 盒收到肚子上（`py` 跟着落到肚子中心），同字典认出的降号
    r.sym.box = { ...rb, top: rb.top + hgt * 0.45 };
    r.sym.py = (r.sym.box.top + r.sym.box.bottom) / 2;
    notes.splice(i, 1);
  }
  // **被认成无干头的升号**：升号的两道粗横笔去掉竖笔后正是上下叠着的两个实心头（一婴孩为我们降生 男声 m28
  // ♯F3 二分和弦前的升号，两个假头并进和弦、整枚成了四分），或者整个当成一个空心头（主差遣我 p1 m14 女声 G♯4 前，
  // 成了全音符）。没干的一个头、或上下隔 0.7~1.6 格（头吸到谱位上，两道横笔常被拉开到三级）、x 差不到 0.3 格的两个，
  // 右边 1.5 格内有带干的头、头心落在框里，原图上框（上下各放半格）里只数出两根通高竖笔的，改成升号交给临时记号那一路
  for (let i = notes.length - 1; i >= 0; i--) {
    const a = notes[i];
    if (a.rest || a.stemUp !== null || a.sym.code === "noteheadDoubleWhole") continue;
    const b = notes.find((m) => m !== a && !m.rest && m.staff === a.staff && m.stemUp === null && m.sym.code === "noteheadBlack" && a.sym.code === "noteheadBlack" &&
      Math.abs(m.sym.box.left - a.sym.box.left) <= unit.space * 0.3 && m.sym.py - a.sym.py >= unit.space * 0.7 && m.sym.py - a.sym.py <= unit.space * 1.6);
    const pair = b ? [a, b] : [a];
    const box = { left: Math.min(...pair.map((n) => n.sym.box.left)), right: Math.max(...pair.map((n) => n.sym.box.right)), top: a.sym.box.top, bottom: (b ?? a).sym.box.bottom };
    const pad = Math.round(unit.space * 0.5);
    const owner = notes.some((n) => {
      if (n.rest || n.staff !== a.staff || pair.includes(n) || n.stemUp === null) return false;
      const dx = n.sym.box.left - box.right;
      return dx >= -2 && dx <= unit.space * 1.5 && n.sym.py > box.top - (b ? 0 : pad) && n.sym.py < box.bottom + (b ? 0 : pad);
    });
    if (!owner) continue;
    if (tallStrokes(raster.bin, { x: box.left, y: box.top - pad, w: box.right - box.left, h: box.bottom - box.top + pad * 2 }) !== 2) continue;
    a.sym.code = "accidentalSharp";
    a.sym.box = { ...a.sym.box, ...box };
    a.sym.py = (box.top + box.bottom) / 2;
    if (b) pg.symbols = pg.symbols.filter((s0) => s0 !== b.sym);
    for (const n of pair) {
      if (n.group) n.group.notes = n.group.notes.filter((m) => m !== n);
      notes.splice(notes.indexOf(n), 1);
    }
    i = Math.min(i, notes.length);
  }
  // **无干的小黑头不是音**：单个、没干、宽高都小于本页带干黑头中位数（`TINY_HEAD` / `TINY_HEAD_H` 倍）的黑头，是弧端、符尾尖之类的碎块
  //（圣哉颂 p3 m25 女声，圆滑线落点那一截 0.85 格宽，读成 F5 全音符）。黑头没干按缺省给全音符，一个就多出一整小节
  {
    const stemmed = notes.filter((n) => !n.rest && n.stemUp !== null && n.sym.code === "noteheadBlack");
    const ws = stemmed.map((n) => n.sym.box.right - n.sym.box.left).sort((p, q) => p - q);
    const hs = stemmed.map((n) => n.sym.box.bottom - n.sym.box.top).sort((p, q) => p - q);
    const med = ws.length >= 5 ? ws[ws.length >> 1] : 0;
    const medH = hs.length >= 5 ? hs[hs.length >> 1] : 0;
    for (let i = notes.length - 1; i >= 0 && med; i--) {
      const n = notes[i];
      if (n.rest || n.stemUp !== null || n.sym.code !== "noteheadBlack" || (n.group && n.group.notes.length > 1)) continue;
      // 高也要矮：窄而高的是干没挂上的空心头（是爱 p2 m25 B♭3 二分，17×23）
      if (n.sym.box.right - n.sym.box.left >= med * TINY_HEAD || n.sym.box.bottom - n.sym.box.top >= medH * TINY_HEAD_H) continue;
      if (n.group) n.group.notes = [];
      notes.splice(i, 1);
    }
  }
  // **被认成「黑头 + 朝上的干」的四分休止**：粗笔的四分休止让位到谱表上方（圣哉颂 p3 钢琴左手上声部，宽 1.13 格，
  // 比按块认的那一路的宽上限宽一点），下半截当成头、上半截当成干。头连干整块的尺寸、填充像四分休止，
  // 「干」那一段**不是细竖笔**（逐行墨宽的中位数过 0.35 格），就改回四分休止。头盒按头的个头摆、比墨多出一两像素，高放 0.15 格
  for (const n of notes) {
    if (n.rest || n.stemUp !== true || n.stemTip === undefined || n.beams || n.dots || (n.group && n.group.notes.length !== 1)) continue;
    if (n.sym.code !== "noteheadBlack") continue;
    const sb = n.sym.box;
    const box = { x: Math.round(sb.left), y: Math.round(n.stemTip), w: Math.round(sb.right - sb.left), h: Math.round(sb.bottom - n.stemTip) };
    if (box.w > unit.space * QREST_SPINE_W || box.w < unit.space * QREST_W[0] || box.h < unit.space * QREST_H[0] || box.h > unit.space * (QREST_H[1] + 0.15)) continue;
    let ink = 0;
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) ink += nl.data[y * nl.w + x];
    const fill = ink / Math.max(1, box.w * box.h);
    if (fill < QREST_FILL[0] || fill > QREST_FILL[1]) continue;
    // 「干」那一段逐行的墨宽取中位数：真干一两个线宽，休止的上半截是斜着的粗笔
    const widths: number[] = [];
    for (let y = box.y; y < Math.round(sb.top); y++) {
      let n0 = 0;
      for (let x = box.x; x < box.x + box.w; x++) n0 += nl.data[y * nl.w + x];
      widths.push(n0);
    }
    widths.sort((p, q) => p - q);
    if (!widths.length || widths[widths.length >> 1] <= unit.space * 0.35) continue;
    n.rest = true;
    n.sym.code = "restQuarter";
    n.sym.box = { ...sb, top: n.stemTip };
    n.base = n.duration = 1 / 4;
    n.stemUp = null;
    n.stemTip = undefined;
    if (n.group) n.group.stem = null;
  }
  // **被认成短干头的降号**：降号的肚子像个窄头、竖笔像根朝上的短干（虽主差遣我 p1 m3 左手 A♭2 前的降号读成二分）。
  // 朝上的干不到 `FLAT_STEM` 格、右边 1.5 格内有同高（半格内）的头的，改成降号；真音符的干至少两格半
  for (let i = notes.length - 1; i >= 0; i--) {
    const a = notes[i];
    if (a.rest || a.stemUp !== true || a.stemTip === undefined || a.beams || a.group?.notes.length !== 1) continue;
    if (a.sym.box.top - a.stemTip >= unit.space * FLAT_STEM || a.sym.box.right - a.sym.box.left > unit.space * 1.1) continue;
    const owner = notes.some((n) => {
      if (n === a || n.rest || n.staff !== a.staff) return false;
      const dx = n.sym.box.left - a.sym.box.right;
      return dx >= -2 && dx <= unit.space * 1.5 && Math.abs(n.sym.py - a.sym.py) <= unit.space * 0.5;
    });
    if (!owner) continue;
    a.sym.code = "accidentalFlat";
    a.sym.box = { ...a.sym.box, top: a.stemTip };
    notes.splice(i, 1);
  }
  attachAccidentalsByPitch(pg, ctx, notes);
  naturalsByStrokes(pg, ctx, notes, raster.bin, unit.space);
  splitUnisons(notes, stems, beams, raster.bin, unit.space);
  doubleUnisonWholes(pg, notes);
  markCrossStaff(pg, notes, stems, unit.space);
  fixDottedPairs(notes, unit.space);
  fixQuartersByBarSum(pg, ctx, notes, carry.carryTime, unit.space);
  dropBorrowedBeams(pg, ctx, notes, stems, carry.carryTime, unit.space);
  findTuplets(pg, beams, stems, notes);
  tupletsByBarSum(pg, ctx, stems, notes, carry.carryTime, unit.space);
}

/** 跨谱表补漏：补漏音的探针、补附点的验点、不验点补附点的验空 */
export function crossStaffProbes(c: {
  masks: HeadMask[];
  unit: RasterUnit;
  frames: LineFrame[];
  hollowMasks: HeadMask[];
  notes: StaffNote[];
  raster: RasterPage;
  cmap: ContourMap;
  look: RasterGlyphLookup;
  nl: Binary;
  pg: SPage;
  ctx: Map<Staff, StaffContext>;
  carry: PageCarry;
}): void {
  const { masks, unit, frames, hollowMasks, notes, raster, cmap, look, nl, pg, ctx, carry } = c;
  // ── 跨谱表补漏：补漏音的探针、补附点的验点、不验点补附点的验空
  // 补漏音的探针：同系统别的行在这一拍有音、本行这里空着时，回原图在那个 x 上拿本页自举的模板找头（见 `crossalign.ts`）。
  // 阈值取本页已认出的头在自己位置上的得分（下 10% 分位）：扫描件淡印、糊团各页差得多，不设常数；
  // 样本少、糊的页下 10% 分位跌到零下（085 扬声赞美歌空心头 −0.02），再垫一道中位数的 `PROBE_MED_FRAC`
  const headSearch = ((): HeadSearch | undefined => {
    if (!masks.length) return undefined;
    const sp = unit.space;
    const pick = (ms: typeof masks, p: number) => ms.find((k) => k.onLine === (((p % 2) + 2) % 2 === 0)) ?? ms[0];
    const frameOf = (stf: Staff) => frames.find((q) => Math.abs(q.top - stf.lineYs[0]) < sp);
    const floorOf = (hollow: boolean): number => {
      const ms = hollow ? hollowMasks : masks;
      const sc: number[] = [];
      for (const n of notes) {
        if (n.rest || (n.sym.code === "noteheadBlack") === hollow) continue;
        const f = frameOf(n.staff);
        if (!f) continue;
        const cx = (n.sym.box.left + n.sym.box.right) / 2;
        const ys = f.at(cx);
        const p = Math.round(pitchPos(ys, n.sym.py));
        sc.push(scoreAtMasked(raster.bin, pick(ms, p), cx, pitchY(ys, p)));
      }
      sc.sort((a, b) => a - b);
      return sc.length >= 10 ? Math.max(sc[Math.floor(sc.length * 0.1)], sc[sc.length >> 1] * PROBE_MED_FRAC) : Infinity;
    };
    const floors = new Map<boolean, number>();
    const restCode = (dur: number): SmuflName => (dur >= 1 ? "restWhole" : dur >= 1 / 2 ? "restHalf" : dur >= 1 / 4 ? "restQuarter" : dur >= 1 / 8 ? "rest8th" : "rest16th");
    return (stf, x, hollow, dur, near, yLim) => {
      const ms = hollow ? hollowMasks : masks;
      const f = frameOf(stf);
      if (!ms.length || !f) return null;
      // **先看那里是不是印着个漏认的休止**：横向一格内、谱表上下一格内的墨块按形状字典认，认成休止就补休止
      //（扫描档补出来的头有一半落在 GT 记休止的地方：破碎扫描 p3 m42、是爱 p3 m38）
      for (const c of cmap.contours) {
        const b = c.bbox;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        if (Math.abs(cx - x) > sp || cy < f.top - sp || cy > f.bottom + sp || b.h > sp * 4) continue;
        // 二分/全休止的方块：扁、实，贴着谱线，形状字典常认不出（是爱 p3 m38 低音，38×10 像素贴第三线）
        const block = b.w >= sp * REST_BLOCK_W[0] && b.w <= sp * REST_BLOCK_W[1] && b.h >= sp * REST_BLOCK_H[0] && b.h <= sp * REST_BLOCK_H[1] && c.area >= b.w * b.h * REST_BLOCK_FILL && cy > f.top && cy < f.bottom;
        const m = block || !look.templates ? null : matchTemplate(binSig(nl, b), b.w / sp, b.h / sp, look.templates);
        if (!block && !m?.smufl.startsWith("rest")) continue;
        if (block && dur < 1 / 2) continue;
        const { sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, { box: b, code: restCode(dur) } as RasterSym, unit.height);
        sym.addTag("Note");
        sym.ownerStaff = stf;
        return sym;
      }
      if (!floors.has(hollow)) floors.set(hollow, floorOf(hollow));
      const ys = f.at(x);
      let best: { x: number; y: number; s: number } | null = null;
      // 上下各两条加线以内（人声难得写到更外；三条加线那么远的多是谱表外的字与记号：085 扬声赞美歌 m17 补成了 E6）、横向半格以内；
      // 本行左右有音时只在离它们一个八度以内找
      const nearP = near.map((y) => pitchPos(ys, y));
      for (let p = -4; p <= 12; p++) {
        if (nearP.length && nearP.every((q) => Math.abs(q - p) > 7)) continue;
        const py = pitchY(ys, p);
        if (yLim && (py <= yLim[0] || py >= yLim[1])) continue;
        for (let dx = -Math.round(sp * 0.5); dx <= Math.round(sp * 0.5); dx++) {
          const y = pitchY(ys, p);
          const sc = scoreAtMasked(raster.bin, pick(ms, p), x + dx, y);
          if (!best || sc > best.s) best = { x: x + dx, y, s: sc };
        }
      }
      if (!best || best.s < floors.get(hollow)!) return null;
      if ((globalThis as any).process?.env?.XADBG) console.error("XA probe", hollow ? "空" : "实", "p", Math.round(pitchPos(ys, best.y)), "score", best.s.toFixed(3), "floor", floors.get(hollow)!.toFixed(3), "near", nearP.map((q) => q.toFixed(1)).join(","));
      const w = Math.round(sp * 1.25);
      const h = Math.round(sp);
      const box = { x: Math.round(best.x - w / 2), y: Math.round(best.y - h / 2), w, h };
      const { sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, { box, code: hollow ? "noteheadHalf" : "noteheadBlack" } as RasterSym, unit.height);
      sym.addTag("Note");
      sym.ownerStaff = stf;
      return sym;
    };
  })();
  // 补附点的验点：头右边（同 `findDots` 的窗口）有个点状小墨团，去线图上不连着别的符号。比认附点那一步松——
  // 那一步要点够圆、够孤立、不比本页附点小太多，扫描件糊开的点、贴着符尾的点没收；这里只给跨谱表已经说缺这么点时值的音用
  const dotProbe: DotProbe = (n) => {
    const sp = unit.space;
    const others = pg.symbols.filter((q) => q.code !== "augmentationDot");
    return (n.group?.notes ?? [n]).some((m) => {
      const b = m.sym.box;
      const x0 = Math.round(b.right + sp * 0.05), x1 = Math.round(b.right + sp * 1.3);
      const y0 = Math.round(m.sym.py - sp * 0.85), y1 = Math.round(m.sym.py + sp * 0.75);
      return blobsIn(nl, x0, y0, x1, y1).some((d) => {
        if (d.w < Math.max(2, sp * DOTP_MIN) || d.h < Math.max(2, sp * DOTP_MIN) || d.w > sp * DOTP_MAX || d.h > sp * DOTP_MAX) return false;
        if (d.w / d.h < 0.5 || d.w / d.h > 2 || d.area < d.w * d.h * 0.4) return false;
        return !others.some((q) => q.box.left < d.x + d.w && q.box.right > d.x && q.box.top < d.y + d.h && q.box.bottom > d.y);
      });
    });
  };
  // 不验点补附点的验空：拍位左右各 `GAP_HALF_W` 格、谱表上下各伸半格的窗口里，没有整个落在里面、够大的墨块
  //（去线图；穿出窗口的干、杠不算）。已被认成别的东西的也算墨：漏认的休止常被认成临时记号（新编 396 m6、m10 四分休止读成 ♭）
  const gapProbe: GapProbe = (stf, x) => {
    const sp = unit.space;
    const b = stf.box;
    return blobsIn(nl, Math.round(x - sp * GAP_HALF_W), Math.round(b.top - sp / 2), Math.round(x + sp * GAP_HALF_W), Math.round(b.bottom + sp / 2)).some((d) => Math.max(d.w, d.h) >= sp * GAP_INK_MIN);
  };
  fixByCrossStaff(pg, ctx, notes, carry.carryTime, unit.space, headSearch, dotProbe, gapProbe);
}

/** 补漏音找头的得分下限至少是本页已认出的头中位得分的这么多（见 `headSearch`）。0.5 会挡掉扫描档一个补对的低分头（0.11，中位约 0.27）。 */
const PROBE_MED_FRAC = 0.25;
/** 补附点验点：点的长宽（格）上下限（见 `dotProbe`）。 */
const DOTP_MIN = 0.15;
const DOTP_MAX = 0.75;
/** 不验点补附点验空：拍位窗口半宽、算数的墨块长边下限（格，见 `gapProbe`）。 */
const GAP_HALF_W = 0.9;
const GAP_INK_MIN = 0.5;
/** 窗口里整个落在里面的墨块（八连通），带面积。 */
function blobsIn(bin: Binary, x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number; area: number }[] {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(bin.w, x1);
  y1 = Math.min(bin.h, y1);
  const W = x1 - x0;
  if (W <= 0 || y1 <= y0) return [];
  const seen = new Uint8Array(W * (y1 - y0));
  const out: { x: number; y: number; w: number; h: number; area: number }[] = [];
  const stack: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (seen[(y - y0) * W + (x - x0)] || !bin.data[y * bin.w + x]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0, edge = false;
      seen[(y - y0) * W + (x - x0)] = 1;
      stack.push(x, y);
      while (stack.length) {
        const py = stack.pop()!;
        const px = stack.pop()!;
        area++;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= bin.w || ny >= bin.h || !bin.data[ny * bin.w + nx]) continue;
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) {
              edge = true;
              continue;
            }
            const j = (ny - y0) * W + (nx - x0);
            if (seen[j]) continue;
            seen[j] = 1;
            stack.push(nx, ny);
          }
      }
      if (!edge) out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
    }
  return out;
}
/** 补漏音认方块休止（二分/全休止）：宽、高（格）与填充下限（见 `headSearch`）。 */
const REST_BLOCK_W: [number, number] = [0.9, 2.2];
const REST_BLOCK_H: [number, number] = [0.3, 0.8];
const REST_BLOCK_FILL = 0.8;
/** 降号被认成头 + 朝上短干：干短于几格（见上） */
const FLAT_STEM = 1.5;
/** 无干单个黑头：宽不到本页带干黑头中位宽的这么多倍的剔掉 */
const TINY_HEAD = 0.75;
const TINY_HEAD_H = 0.85;
