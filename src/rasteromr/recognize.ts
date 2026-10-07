// 位图五线谱的单页识别：位图 → `StaffPageResult`（与矢量路同一个返回类型）。
//
// **下游全部复用 `src/staffomr/`**，那边一行不改。本文件只做两件事：
//   1. 把位图变成 `Staff` / `Seg` / `Sym`（`adapt.ts`）；
//   2. 按矢量路 `staffomr/index.ts::recognizeStaffPage` 的**同一个次序**往下调。
//
// 与矢量路的差别只有三处，都是「那边从路径对象里取、这边从像素里取」：
//   - 符杠：矢量路 `findBeams` 读 `pg.objs` 的填充路径；位图路自己找（`prims.ts`）。
//   - 符头：矢量路查字形字典；位图路按性质判（`notehead.ts`）。
//   - 文本层：矢量路读文字对象；位图路要 OCR（尚未接，故歌词/力度/速度暂缺）。
import type { Binary } from "../omr/types";
import { timeDigit, timeKey, timeStripOf, type TimeStrip } from "./timesig";
import type { Box } from "../staffomr/model";
import type { Component, Rect } from "../omr/types";
import { findBarlines, findNoteheads, findStaves, findStems, findTails, isLeadNoteBarline, makeBars, makeSystems, systemGroups, tagSystemBarlines, unknownObjs } from "../staffomr/page";
import { accidentalAlter, isAccidental, isClef, timeSigDigit, type SmuflName } from "../staffomr/glyphs";
import { buildNotes, calcAlters, checkBars, fifthsAt, findClefKeyTime, headKey, keyChanges, keyFifths, lastTimeSignature, timeSignatures, type BeamShape, type StaffContext, type StaffNote, type StemInfo, type BarCheck } from "../staffomr/notedata";
import { findRasterArticulations } from "./artic";
import { markRepeatsAndVoltas } from "./repeats";
import { findRasterTuplets } from "./tuplet";
import { attachWordLines, findHeaderStrip, findWordStrips, headerCredits, wordKey, type HeaderCredit, type WordLine, type WordStrip } from "./words";
import { applyTuplet, attachDynamicTexts, attachNotations, attachWedges, findNotations, findTuplets, markLyricExtends } from "../staffomr/notations";
import type { PObj, Seg, SPage, Staff, Sym, Tag } from "../staffomr/model";
import { overlapY } from "../staffomr/model";
import { buildRasterPage, makeSymObj, makeSysBracketObj, makeTextObj, pushSeg, type RasterSym } from "./adapt";
import { binSig, blobImage, extendVSegs, findBlobs, findBraces, findPrimitives, groupByLeftInk, ledgerGrid, joinVSegs, removeStaffLines, verticalStrokes, type BeamQuad, type LineSeg, type RasterPrims } from "./prims";
import { archCavity, stemWalledCavity, findRasterHeads, hollowHeadsByPitch, headsOnBareStems, headsBetweenStemPairs, probeBareStems, hollowHeadsFromCavities, hollowHeadsAlongStems, hollowHeadsFromHoles, hollowHeadsOnLedgers, hollowSlit, inkColumn, judgeHeadBox, mergeHoles, type PitchStep } from "./notehead";
import { bootstrapClefs, matchTemplate, RasterGlyphLookup, type BootStaff } from "./rasterglyphs";
import { sigDistance } from "../omr/glyphdict";
import { completeStaffBars, cutJianpuStrip, eraseInBand, findJianpuBands, jianpuKey, type JianpuStrip } from "./jianpuband";
import { fuseJianpu, type FuseStats, type JianpuRow } from "./jianpufuse";
import { CHAR_MAX as LYRIC_CHAR_MAX, findLyricRows, foldLyricChars, isLatinRow, LATIN_MIN_CHAINED, latinCells, mapCharsToCells, splitMixedChars, stripKey, stripOf, stripWithout, type LyricRow, type LyricStrip, type OcrChar } from "./lyric";
import { findHoles, traceContours, type ContourMap } from "./contour";
import { buildHeadMasks, buildHollowMasks, headFromStemBlock, scoreAt, solidHeadsAlongStems, splitHeadCluster } from "./headmask";
import { headProb, trainHeadClassifier } from "./headclass";
import { findStaffLabels, labelKey, normalizeLabel, type LabelStrip } from "./stafflabel";
import { findHarmonyStrips, harmonyKey, harmonyLine, readHarmonyStrip, type HarmonyStrip, type HarmonyToken } from "./harmony";
import { findRasterWedges, type RasterWedge } from "./wedge";
import { groupDynamics, type RasterDynamic } from "./dynamics";
import { extendArcEnds, findFusedSlurs, findRasterDashedSlurs, findRasterSlurs, findSplitArcs } from "./slur";
import { ContourLedger } from "./ledger";
import { attachHarmonies, attachLyrics, buildLyricLines, type LyricLine, type LyricRowInfo } from "../staffomr/textanalyze";
import { attachSlurs, markSlurNotes, reconnectSlurs, validateSlurNote, type SlurArc } from "../staffomr/slur";
import { estimateUnit, findStaffLines, groupStaves, localLineModel, pitchPos, pitchY, traceLeft, type RasterUnit, type StaffLineRun } from "./staffline";
import { completeStaffLines } from "./dewarp";
import { rasterizePage, type RasterPage } from "./rasterpage";

export interface RasterPageResult {
  page: SPage;
  hasStaff: boolean;
  unknown: number;
  unit: RasterUnit | null;
  /** 取到的位图（排查、裁图用）。 */
  raster: RasterPage | null;
  ctx: Map<Staff, StaffContext>;
  beams: BeamShape[];
  notes: StaffNote[];
  bars: BarCheck[];
  /** 认出来的歌词行（没接 OCR 字典时为空）。 */
  lyricLines: LyricLine[];
  /**
   * contour 层与**认领账本**（`contour.ts` / `ledger.ts`）：这一页的每一团墨、
   * 以及谁认走了它。识别本身不看这两样，它们只回答「还有什么是我们从没看见的」
   * ——`ledger.unclaimed()` 就是无主的那些，`scripts/raster-unclaimed.mjs` 拿它出表。
   */
  contours: ContourMap | null;
  ledger: ContourLedger | null;
  /** 认出来的松叶（渐强/渐弱），见 `wedge.ts`。 */
  wedges: RasterWedge[];
  /** 认出来的力度记号（拼好的文本），见 `dynamics.ts`。 */
  dynamics: RasterDynamic[];
  /** 认出来的弧（圆滑线 / 连音线），见 `slur.ts`。 */
  slurs: SlurArc[];
  /**
   * 这一页切出来的**歌词条**（`gen-rasterlyrics.mjs` 拿它送 OCR）。
   *
   * **生成器必须与识别走同一条路**：它原来自己复制了一份流程
   *（另一套 `findStaffLines`/`findBlobs`/`findLyricRows`），识别这边一改判据就对不上，
   * 指纹全变、缓存整份落空——实测歌词从 85.0% 掉到 42.7%，还查了半天。
   * 现在条子从这里出，两边不可能再走样。
   */
  lyricStrips: LyricStrip[];
  /**
   * 这一页各谱行的**声部标签条**（`gen-rasterlabels.mjs` 拿它送 OCR）。
   * 与歌词条同一套架构：这里只切条，认字靠离线缓存。见 `stafflabel.ts`。
   */
  labelStrips: LabelStrip[];
  /** 行首拍号候选列的上下半条（`gen-rastertime.mjs` 拿它送 OCR）。见 `timesig.ts`。 */
  timeStrips: TimeStrip[];
  /** 文字指示带（`words.ts`）。**只在 `opts.wantWordStrips` 时带出来**（生成缓存的脚本、在线识别送 OCR 的那一趟）：
   *  各条合起来近乎整页的像素，整曲结果又留着每一页，平时带着等于每页多存一份位图。 */
  wordStrips: WordStrip[];
  /** 页眉带（`words.ts::findHeaderStrip`）：只在 `opts.wantHeader` 时切（曲首页），送 OCR 用。 */
  headerStrips: WordStrip[];
  /** 页眉各条（`opts.headerOcr` 命中时）：标题、副标题、词曲作者。 */
  header: HeaderCredit[];
  /**
   * 这一页各谱行上方的**和弦带**（`gen-rasterharmony.mjs` 拿它送 OCR）。
   * 与歌词条、标签条同一套架构：这里只切条，认字靠离线缓存。见 `harmony.ts`。
   */
  harmonyStrips: HarmonyStrip[];
  /** 谱表正上方的简谱行（混排谱；`gen-rasterjianpu.mjs` 拿它离线认简谱）。见 `jianpuband.ts`。 */
  jianpuStrips: JianpuStrip[];
  /** 简谱互证改了几处（没有简谱行或缓存没命中为 null）。 */
  jianpuFix?: FuseStats | null;
  /** 切出来的和弦记号（缓存里查得到才有）。已挂到音符的 `chord` 上。 */
  harmonies: HarmonyToken[];
  /** 和弦带里认出的文本（不是和弦的字母串，见 `readHarmonyStrip`）。 */
  harmonyTexts: HarmonyToken[];
  /** 谱行下标 → 规范化的声部名（`S1`/`A`/`P`…）。缓存里查得到才有。 */
  staffLabels: Map<number, string>;
  /**
   * 歌词切格的**结构指标**：切出几条、缓存命中几条、其中**字格数与 OCR 字数相等**的几条。
   * 最后那个数是切格好坏的直接尺子——相等才走得上「按序号一一对应」那条准路
   * （不等就得按 `xFrac` 摊，而那是 CTC 估的位置，误差常有半个字）。
   */
  lyricStats: { rows: number; hit: number; parity: number };
  /** 排查用（`opts.debug`）：连通块与「谁被认领了」。识别本身不看。 */
  debugBlobs?: { id: number; box: Rect; area: number; claimed: boolean }[];
  /** 排查用（`opts.debug`）：去谱线图、以及抹掉原语之后送去找块的那张图。 */
  debugNl?: Binary;
  debugPrims?: RasterPrims;
  /** 排查用（`opts.debug`）：分好组的谱行（`findStaves` 之前）。 */
  debugGroups?: { top: number; bottom: number; space: number }[];
  debugRest?: Binary;
  carryTime?: { beats: number; beatType: number };
  /** 这一页最后生效的调号（记号种类与个数）——下一页拿它当 `opts.carryKey`（见 `extendKeyByCarry`）。 */
  carryKey?: CarryKey;
}

/** 跨页沿用的调号：记号种类与个数。 */
export interface CarryKey {
  code: string;
  n: number;
  /** 多行系统各位置上低八度谱号的见证（见 `shareOctaveClefs`），随调号一起往下一页带。 */
  clefs?: ClefTally;
}

/** 键是「行数:各行高低音谱号的排法」（如 `7:gggffgf`）；`seen` 是见过几个这样的系统，`g8[i]` 是第 i 行读成低八度谱号的次数。 */
export type ClefTally = Record<string, { seen: number; g8: number[] }>;

const empty = (page: SPage, raster: RasterPage | null, unit: RasterUnit | null, carryTime?: { beats: number; beatType: number }, carryKey?: CarryKey): RasterPageResult => ({
  page,
  hasStaff: false,
  unknown: 0,
  unit,
  raster,
  ctx: new Map(),
  beams: [],
  notes: [],
  bars: [],
  lyricLines: [],
  contours: null,
  ledger: null,
  wedges: [],
  dynamics: [],
  slurs: [],
  lyricStrips: [],
  labelStrips: [],
  timeStrips: [],
  wordStrips: [],
  headerStrips: [],
  header: [],
  harmonyStrips: [],
  jianpuStrips: [],
  harmonies: [],
  harmonyTexts: [],
  staffLabels: new Map(),
  lyricStats: { rows: 0, hit: 0, parity: 0 },
  carryTime,
  carryKey,
});

/**
 * **符尾按位置自举**（不查字典）。
 *
 * 字典对符尾几乎没用：`rasterglyphs.json` 里 4144 个类**没定名**，符尾只有 8 个类有名字
 * ——实测全书只认出 1 个 `flag8thUp`。更要命的是符尾在位图上**根本不成为独立的块**：
 * 它上半截是根粗竖笔，横向游程短，`findPrimitives` 把它当竖笔画抽走了；
 * 剩下的钩尾细而弯，落在窗口里的残块高度中位数只有 0.53 格（真符尾有一格半）。
 *
 * 所以改从**原始像素**上量，绕开原语划分：符尾一定长在符干**远离符头的那一端**、
 * 一定在符干**右侧**（刻谱通例，朝上朝下都在右）。量那个窗口里的墨占比，
 * 实测分得很开——没有符杠的音符里，占比要么是 0（真四分），要么在 0.35 以上
 *（破碎前三页 121 个里 27 个），中间几乎没有。
 *
 * **有符杠的符干不看**：符杠也横在这个窗口里，一量必中；而符杠那一路
 * 已经把层数算进时值了（`calcBeamLevels`），再补个符尾反而把十六分压回八分
 *（`buildStems` 里「有符尾的符干不接符杠」）。
 */
function bootstrapFlags(bin: Binary, pg: SPage, beams: BeamQuad[], unit: RasterUnit, avoid: Rect[] = []): RasterSym[] {
  const sp = unit.space;
  const out: RasterSym[] = [];
  // **只看实心符头**：空心符头（二分/全音符）本来就不带符尾，
  // 给它安一个会把二分读成八分。
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && s.code === "noteheadBlack");
  const lineYs = pg.staves.flatMap((stf) => stf.lineYs);
  /** 干尖右边没长出符尾的干（下面看它是不是接着左邻那道符尾）。 */
  const bare: { cx: number; far: number; up: boolean }[] = [];
  for (const st of pg.segsWithTag("Stem")) {
    const on = heads.filter(
      (s) => (Math.abs(s.box.left - st.cx) < sp / 3 || Math.abs(s.box.right - st.cx) < sp / 3) && s.box.top < st.bottom && st.top < s.box.bottom,
    );
    if (!on.length) continue;
    // **远端按符干上所有的头定**：和弦的符干串着好几个头，只拿其中一个量，
    // 挂在中间的那个会把另一头的符头当成「远端」（《赞美一神》D4/D3 共干，
    // 拿 D3 量出远端在 D4 那头，D4 符头连着加线把窗口填满，整批读成八分）。
    const ys = on.map((s) => (s.box.top + s.box.bottom) / 2);
    const dTop = Math.min(...ys.map((y) => Math.abs(st.top - y)));
    const dBot = Math.min(...ys.map((y) => Math.abs(st.bottom - y)));
    // 两端都贴着符头：这是两个头之间被切出来的一截符干（加线、谱线把符干切断），没有自由端
    if (Math.max(dTop, dBot) < sp * FLAG_BOTH_ENDS) continue;
    let far = dTop > dBot ? st.top : st.bottom;
    const hy = far === st.top ? Math.min(...ys) : Math.max(...ys);
    // 符杠横在这个窗口里的，不看（理由见上）
    // 符杠斜着搭在符干中段的也算（不只远端那一小截）
    if (beams.some((b) => b.x0 - sp * 0.5 <= st.cx && st.cx <= b.x1 + sp * 0.5 && st.top - sp * 0.5 < (b.y0 + b.y1) / 2 && (b.y0 + b.y1) / 2 < st.bottom + sp * 0.5)) continue;
    const toward = Math.sign(hy - far) || 1;
    const frac = (d0: number, d1: number, side = 1) => {
      const x0 = Math.round(side > 0 ? st.cx + sp * FLAG_X[0] : st.cx - sp * FLAG_X[1]);
      const x1 = Math.round(side > 0 ? st.cx + sp * FLAG_X[1] : st.cx - sp * FLAG_X[0]);
      let ink = 0;
      let tot = 0;
      for (let dy = sp * d0; dy < sp * d1; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h) continue;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= bin.w) continue;
          tot++;
          ink += bin.data[y * bin.w + x];
        }
      }
      return tot ? ink / tot : 0;
    };
    // **符尾从符干尖端长出来**：贴着远端那一小截、紧挨符干右侧必须有墨。
    // 没这一条，从符干旁边路过的连音线、下一个音的符头都会把窗口填满
    // （实测只看整窗占比，小节自检 33.2% → 31.9%）。
    // 粗线扫描中符干可能伸出连接点几像素；在半格、两倍线宽以内找连接处。
    // 细线页仍用原尖端，避免把附近的弧线误认成符尾。门槛 0.2 → 0.15 格（`FLAG_REACH_LW`）、reach 两倍 → 三倍线宽：
    // 万古磐石歌线宽 4/22 = 0.18，符干冒出符尾连接点 10px，整页单尾八分读成四分。
    // 整窗墨占比也按连接点量，不在这之前按尖端先筛一道：干伸出符尾半格的，按尖端量窗口只罩到钩尾一角
    //（《向主唱新歌》下声部的八分 B3 读成四分，后面的休止整排错拍）。
    let offset = 0;
    // 干尖**落在谱线上**的也往里找（最多半格）：干冒过钩的起点、顶到线上（万福泉源歌低分辨率本，
    // 钩从干尖下半格才长出来，尖端窗口只罩到一角，八分和弦整批读成四分）
    const onLineTip = lineYs.some((ly) => Math.abs(ly - far) <= unit.lineThick * 1.5 + 1);
    // 细线页干尖没顶在线上的，也往里找半格（干冒过钩的起点 7 像素：颂赞与尊贵整页单尾八分读成四分），
    // 但窗口不能碰到头（离头心留 0.6 格）：短干上往里挪，窗口罩到干旁边的头本身（晨曦破晓 m6）
    const reach = unit.lineThick > sp * FLAG_REACH_LW
      ? Math.min(sp * 0.5, unit.lineThick * 3)
      : onLineTip ? sp * 0.5 : Math.max(0, Math.min(sp * 0.5, Math.abs(hy - far) - sp * (0.6 + FLAG_TIP_Y)));
    while (frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP && offset * sp < reach) offset += 1 / sp;
    /** 干尖顺着干那一列往外延到墨断（上限 `FLAG_TIP_EXT` 格）。 */
    const tipOf = (from: number) => {
      const cx = Math.round(st.cx);
      const inkAt = (y: number) => y >= 0 && y < bin.h && [cx - 1, cx, cx + 1].some((x) => x >= 0 && x < bin.w && bin.data[y * bin.w + x]);
      let tip = from;
      while (Math.abs(tip - toward - from) <= sp * FLAG_TIP_EXT && inkAt(Math.round(tip - toward))) tip -= toward;
      return tip;
    };
    const noFlag = () => frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP || frac(offset, offset + FLAG_Y) < FLAG_INK;
    let bareHere = noFlag();
    // **钩整个长在认出的干尖外边**：钩和干尖粘成一团、横游程太宽，干只认到钩团之前，
    // 干尖处的窗口是空的（万古磐石歌低音 m3、m9 的八分读成四分）——从延出的真干尖再看一次
    if (bareHere) {
      const tip = tipOf(far);
      if (Math.abs(tip - far) >= sp * FLAG_GLUED) {
        const keep = far;
        far = tip;
        offset = 0;
        while (frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP && offset < 0.5) offset += 1 / sp;
        bareHere = noFlag();
        if (bareHere) far = keep;
      }
    }
    if (bareHere) {
      bare.push({ cx: st.cx, far, up: far < hy });
      continue;
    }
    if (frac(offset, offset + FLAG_TIP_Y, -1) >= FLAG_LEFT) continue;
    const up = far < hy;
    // **第二个钩**：十六分的两道钩沿符干错开约一格。只认出第一道的话
    // 十六分整批读成八分（实测补上第一道之后 `16th→eighth` 一下涨到 171 处）。
    // 窗口截在最近的符头边缘之前：朝下的短符干上，符头就在符干右边，离尖端一格多就罩到它
    //（《主我敬拜你》朝下的八分整批读成十六分）。截下来不到 0.6 格的就不看第二道钩。
    const room = Math.abs(hy - far) / sp - 0.6;
    const twoEnd = Math.min(offset + 2.2, room);
    // 还要**右缘轮廓有两个峰**：从尖端往符头走，逐行量钩的最右缘，先涨后落（第一道钩）再涨起来（第二道）
    // 才是两道钩。一道长钩（《主我敬拜你》的八分符尾有 2.3 格长）外沿也会填满第二道钩的窗口，但右缘只有一个峰。
    // 低分辨率放大的万古磐石歌两道钩在干边粘成一段，靠这一条。谱线那几行不算。
    // 或者**贴着干的那一窄条里墨分成两段**（两道钩各自连在干上，右缘对齐的字体靠这一条：来敬拜荣耀王）。
    const hookRuns = () => {
      const x0 = Math.round(st.cx + unit.lineThick);
      const x1 = Math.round(st.cx + sp * 0.35);
      let runs = 0;
      let gap = 2;
      for (let dy = offset * sp; dy < Math.min(offset + 2.4, room) * sp; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h || lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
        let ink = false;
        for (let x = Math.max(0, x0); x <= Math.min(x1, bin.w - 1) && !ink; x++) if (bin.data[y * bin.w + x]) ink = true;
        if (ink) {
          if (gap >= 2) runs++;
          gap = 0;
        } else gap++;
      }
      return runs;
    };
    const twoPeaks = () => {
      const x0 = Math.round(st.cx + unit.lineThick);
      const x1 = Math.round(st.cx + sp * 1.2);
      const prom = sp * HOOK_PROM;
      let max = -1;
      let dip = Infinity;
      for (let dy = offset * sp; dy < Math.min(offset + 2.4, room) * sp; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h || lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
        let r = -1;
        for (let x = Math.min(x1, bin.w - 1); x >= Math.max(0, x0); x--) if (bin.data[y * bin.w + x]) { r = x; break; }
        if (r < 0) continue;
        if (dip < Infinity && r - dip >= prom) return true;
        if (r > max) max = r;
        if (max - r >= prom) dip = Math.min(dip, r);
      }
      return false;
    };
    /**
     * **沿干右侧逐列竖扫黑白游程**：从干尖往头走，数黑段数（谱线行不算、隔不到 0.15 格的空白不断开、
     * 薄于 0.15 格的去线残渣不算一段），返回数出两段以上的列占比。两道钩在干边粘成一段、右缘又对齐的，
     * 离干 0.2–0.6 格的竖线上还是穿过两道钩（万古磐石歌低分辨率本、来敬拜荣耀王朝下的粗体钩）；
     * 八分在这一带全是一段。
     */
    const colRuns = (tip: number, end: number) => {
      const gapMin = Math.max(2, sp * 0.15);
      const runMin = Math.max(2, sp * 0.15);
      const lineRow = (y: number) => lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick);
      let cols = 0;
      let twos = 0;
      for (let x = Math.round(st.cx + unit.lineThick + sp * 0.1); x <= st.cx + sp * FLAG_COLS_X; x++) {
        if (x < 0 || x >= bin.w) continue;
        let runs = 0;
        let len = 0;
        let gap = gapMin;
        for (let dy = 0; dy < end * sp; dy++) {
          const y = Math.round(tip + toward * dy);
          if (y < 0 || y >= bin.h) continue;
          if (lineRow(y)) {
            if (gap === 0) len++;
            continue;
          }
          if (bin.data[y * bin.w + x]) {
            if (gap >= gapMin) {
              if (len >= runMin) runs++;
              len = 0;
            }
            len++;
            gap = 0;
          } else gap++;
        }
        if (len >= runMin) runs++;
        cols++;
        if (runs >= 2) twos++;
      }
      return cols ? twos / cols : 0;
    };
    // **两道钩粘着干尖**：干只认到钩团之前（万古磐石歌低音 m1 十六分，干尖少了 1.7 格，钩窗口朝头那边只剩 0.7 格），
    // 从延出的真干尖再竖扫一次。延出的尖只拿来补判第二道钩，不挪出块和一道钩的判断：
    // 普通八分的干尖本来就埋在钩里 0.6 格上下，全按延出的尖量，整批错位（信心使我得胜音符 97.8 → 96.7）
    const glued = () => {
      const tip = tipOf(far);
      if (Math.abs(tip - far) < sp * FLAG_GLUED) return false;
      const end = Math.min(2.4, Math.abs(hy - tip) / sp - 0.6);
      return end >= 1.6 && colRuns(tip, end) >= FLAG_COLS2;
    };
    const two = twoEnd - (offset + 1.0) >= 0.6 && frac(offset + 1.0, twoEnd) >= FLAG_INK2 && (twoPeaks() || hookRuns() >= 2 || colRuns(far + toward * offset * sp, Math.min(2.4, room - offset)) >= FLAG_COLS2) || glued();
    const code = two ? (up ? "flag16thUp" : "flag16thDown") : up ? "flag8thUp" : "flag8thDown";
    const h = sp * (two ? 2.2 : 1.5);
    // 出块也从**连接点**起算：`offset` 找到的才是符尾真正长出来的地方，
    // 还按符干末端 `far` 出块的话，粗线扫描件上整块会偏出半格。
    const anchor = far + toward * offset * sp;
    const y0 = toward > 0 ? anchor : anchor - h;
    const fbox = { x: Math.round(st.cx), y: Math.round(y0), w: Math.round(sp * 1.5), h: Math.round(h) };
    // **和弦字母不是符尾**：符干朝上顶到和弦行时，窗口里那点墨是「C/E」的 E、「Csus4」的 sus
    //（《主我敬拜你》三处，八分附点、附点二分都读成了带尾的八分）
    if (avoid.some((m) => overlapFrac(fbox, m) > FLAG_AVOID)) continue;
    out.push({ box: fbox, code });
  }
  // **两个八分的「符尾」连到一起**：左边那根干的符尾弯下来正落在右邻同朝向那根干的尖上（我一生要赞美你 m14 F4–D4），
  // 右边那根尖上自己的窗口是空的——照抄左邻那道。干尖要落在那道符尾盒里、离盒右缘不过 0.3 格
  const flagged = out.slice();
  /** 干尖往头那边一格内，有一行在干左边 0.25 格内就有墨（谱线行不算）。 */
  const touchesLeft = (b: { cx: number; far: number; up: boolean }) => {
    const x = Math.round(b.cx);
    const y0 = Math.round(b.up ? b.far : b.far - sp * 1.2), y1 = Math.round(b.up ? b.far + sp * 1.2 : b.far);
    for (let y = Math.max(0, y0); y <= Math.min(bin.h - 1, y1); y++) {
      if (lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
      let xx = x;
      while (xx > x - sp * 0.3 && xx >= 0 && bin.data[y * bin.w + xx]) xx--; // 干自己
      const edge = xx;
      while (xx >= 0 && edge - xx <= sp * 0.25 && !bin.data[y * bin.w + xx]) xx--;
      if (xx >= 0 && edge - xx <= sp * 0.25) return true;
    }
    return false;
  };
  for (const b of bare) {
    const f = flagged.find((q) => {
      const qUp = q.code.endsWith("Up");
      if (!(qUp === b.up && b.cx > q.box.x + sp * 0.5 && b.cx <= q.box.x + q.box.w + sp * 0.3 && b.far >= q.box.y - 2 && b.far <= q.box.y + q.box.h + 2)) return false;
      // 还得真连上：干尖落在那道尾的末端一侧（万古磐石 m2 弯下来接在谱线上），或尾墨贴着这根干（我一生 m14）。
      // 只看盒子的话，左邻八分的符尾盒伸到了右边那个四分的干上也照抄（有一位神 m3 A4 读成八分：干尖与左邻齐平、空着 0.8 格）
      const fromStart = (qUp ? b.far - q.box.y : q.box.y + q.box.h - b.far) / q.box.h;
      return fromStart >= 0.3 || touchesLeft(b);
    });
    if (f) out.push({ box: { ...f.box, x: Math.round(b.cx) }, code: f.code });
  }
  return out;
}

/**
 * 加线候选（`hollowHeadsOnLedgers` 用）：每行谱上下第 1~4 条加线的位置上，**直接在原图上**找横向墨段
 *（上下各放一像素，断口 ≤ 1 像素）。不用 `prims.hSegs`：骑在加线上的空心头，那几列的纵向墨是
 * 圈 + 加线一整条，过不了横笔画「细」的那道闸，加线抽不出来（赞美三一真神 m16 的 C4）。
 * 真假交给模板得分与内腔佐证。
 */
function ledgerCandidates(bin: Binary, groups: { lines: StaffLineRun[]; space: number }[]): { x0: number; x1: number; y: number }[] {
  const out: { x0: number; x1: number; y: number }[] = [];
  for (const g of groups) {
    const left = Math.max(...g.lines.map((l) => l.left));
    const right = Math.min(...g.lines.map((l) => l.right));
    const ys: number[] = [];
    for (let k = 1; k <= 4; k++) ys.push(g.lines[0].y - k * g.space, g.lines[4].y + k * g.space);
    for (const fy of ys) {
      const y = Math.round(fy);
      if (y < 1 || y >= bin.h - 1) continue;
      const ink = (x: number) => !!(bin.data[(y - 1) * bin.w + x] || bin.data[y * bin.w + x] || bin.data[(y + 1) * bin.w + x]);
      let start = -1;
      let miss = 0;
      for (let x = Math.max(0, Math.round(left)); x <= Math.min(bin.w - 1, Math.round(right)) + 1; x++) {
        const on = x <= Math.min(bin.w - 1, Math.round(right)) && ink(x);
        if (on) {
          if (start < 0) start = x;
          miss = 0;
          continue;
        }
        if (start >= 0 && ++miss > 1) {
          out.push({ x0: start, x1: x - miss, y: fy });
          start = -1;
          miss = 0;
        }
      }
    }
  }
  return out;
}

/** 一行谱的几何与**随 x 变化的五线**（`staffline.ts::localLineModel`）。 */
interface LineFrame {
  top: number;
  bottom: number;
  at: (x: number) => number[];
}

/** 区间 [y0, y1] 里的全部音高位置（与 `makePitchGrid` 同一张表：每行谱顶线上下各五条加线的线位与间位）。 */
function makePitchSteps(groups: { lines: { y: number }[]; space: number }[]): (y0: number, y1: number) => PitchStep[] {
  const steps: PitchStep[] = [];
  for (const g of groups) {
    const top = g.lines[0].y;
    const half = g.space / 2;
    for (let k = -10; k <= 18; k++) steps.push({ y: top + k * half, line: k % 2 === 0 });
  }
  return (y0, y1) => steps.filter((s) => s.y >= y0 && s.y <= y1);
}

/**
 * 音高格：把一个 y 吸到最近的**线/间中心**（差半格音高就错一级）。
 * 谱表之外也给（加线那一带），上下各放几格；离得太远返回 null。
 */
function makePitchGrid(groups: { lines: { y: number }[]; space: number }[], unit: RasterUnit): (y: number) => number | null {
  const steps: number[] = [];
  for (const g of groups) {
    const top = g.lines[0].y;
    const half = g.space / 2;
    for (let k = -10; k <= 18; k++) steps.push(top + k * half);
  }
  steps.sort((a, b) => a - b);
  return (y: number) => {
    let best: number | null = null;
    let bd = unit.space * 0.3;
    for (const s of steps) {
      const d = Math.abs(s - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };
}

/** 记账时算「这条段有主」的标记。见 `makeBars` 之后那一段。 */
const SEG_TAGS: Tag[] = ["Staff", "Leger", "Stem", "BarLine", "SysLine", "Tail", "Beam", "Bracket"];

/** 判别器只看这个尺寸包络内的块（线距的倍数）——比 `findRasterHeads` 的闸宽一圈，
 *  正是要捞被啃窄、被粘宽的那一批；再宽就成了「拿模板去空地里找东西」。 */
const CLF_W = [0.5, 2.2] as const;
const CLF_H = [0.4, 1.6] as const;
/** 判别器收下的概率门槛。扫过 0.6 / 0.7 / **0.8** / 0.9 / 0.95：
 *  扫描件音符 65.45 / 65.16 / **65.46** / 65.06 / 64.95%，
 *  干净档音符 84.89 / 84.94 / **84.94** / 84.94 / 84.94%——0.8 是扫描档见顶
 *  且干净档一分不动的那一点（0.6 扫描相当但干净档掉 0.05）。 */
const CLF_P = 0.8;
/** 第二遍拆块的尺寸上限（线距的倍数）。取的正是 `findBlobs` 自己的上限
 *  （宽 6 格、高 9 格）——**等于不再设限**，拆出来的头全交给判别器把关。
 *  写成 9×5.5 / 12×7 / 16×9 实测结果完全相同，因为再大的块 `findBlobs` 根本不出。 */
const BIG_W = 6;
const BIG_H = 9;

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

/** 降号的肚子从盒顶往下第几成开始。取 0.45：盒高 2.36 格时中心正好下移 0.53 格，
 *  与实测的 0.55 格偏差吻合。 */
const FLAT_BOWL_TOP = 0.45;

/** 升降号「并回竖笔」之后与模板的签名距离上限。比通用的 90 松一点：
 *  并回来的盒是块的包围盒 + 竖段的中心线拼出来的，边界不如原块齐整。 */
const ACCID_TEMPLATE_DIST = 90;
/** 紧跟谱号的**调号位置**上再放宽到这一档：颂赞与尊贵的调号降号是细网点印的，并回竖笔后
 *  距离 95。全页一律放宽的话合唱谱干净档多认假降号（小节自检 59.5 → 59.02）。 */
const KEY_ACCID_TEMPLATE_DIST = 100;

/** 空心头按模板再搜的得分门槛。见「空心头按模板再搜」那一段。 */
const HOLLOW_MASK_SCORE = 0.38;
/** 叠成「8」字的两个空心头（一块一个半头宽以内、两个头高）只拆出一个时，按成对再拆的门槛与形状（格）。
 *  万口欢唱低音 G3/E♭3 全音符：先认的下头 0.384，减掉它的墨后上头只剩 0.326。扫 0.3 / 0.25 / 0.2 读数相同。 */
const HOLLOW_PAIR_SCORE = 0.3;
/** 一个头大（1.1~1.7 × 0.85~1.3 格）或「8」字一对（高 1.6~2.2 格）的有腔块的门槛。扫 0.32 / 0.28 / 0.25 / **0.22** / 0.18 / 0.12：
 *  独唱谱音符 93.73 / 93.75 / 93.75 / **93.79** / 93.76 / 93.78%，0.18 起你的信实广大、善牧恩慈歌、大地风光开始掉。 */
const HOLLOW_SHAPED_SCORE = 0.22;
const HOLLOW_PAIR_H = [1.6, 2.5] as const;
const HOLLOW_PAIR_W = 2.2;
/** 整格谱间白（见 `cellLike`）的外框里白至少占多少。 */
const CELL_WHITE = 0.9;
/** 开口内腔（`openCavities`）：射线窗外扩多少格、内腔至少多少格²、中心离谱表上下至多几格。 */
const OPEN_CAVITY_PAD = 0.3;
const OPEN_CAVITY_AREA = 0.06;
const OPEN_CAVITY_BAND = 2;
/** 演奏记号离谱表最远几格（线距）：带加线的低音再往下一格，四格半够了。 */
const ARTIC_REACH = 4.5;

/** 调号兜底：相邻两个升降号（或谱号与第一个升降号）之间最多隔几个线距。 */
const KEY_GAP = 1.5;
/** 歌词条字高不到本页中位数的这个比例就不是歌词（页脚版权小字）。 */
const LYRIC_MIN_H = 0.4;
/** 调号**第一个**记号离谱号右缘的上限（线距）：低音谱号的两点在谱号盒外（齐来称颂 1.77 格）。 */
const KEY_GAP_FIRST = 2.0;
/** 调号串里后一个记号的左缘可以伸进前一个右缘多少格。 */
const KEY_OVERLAP = 0.5;
/** 不带连字符的拉丁行离带连字符的那行多近（字高的倍数）算同一块歌词。
 *  2.5 → 3：拉丁行的字高常只量到小写字母高（更亲近恩主 12px、行距 34px），末段后半「heights of joy…」链不进来。 */
const LATIN_CHAIN = 3;
/** 拉丁行靠中文歌词行作保时，那行中文至少这么多个汉字。 */
const CJK_SEED_MIN = 4;
/** 不管「下方那行谱下面已有词」那道互斥的证据：只对得上下方的至少这么多个（上方一个没有）。 */
const LYRIC_ONLY_DECISIVE = 6;
/** 表情文字的术语、页脚注的字样（OCR 不出空格，按连写匹配，**别收会落在连写词缝里的短串**：「For all gen-」连写含 rall、「Spirit.」含 rit.）：带这些的拉丁行不是歌词（望十架 p1 页脚「Words: … Tune: …」「Flute part is on page 43」）。 */
const DIRECTION_TERM_RE = /tempo|cresc|poco|molto|unis\.|dim\.|rall\.|stagger|section|words:|tune:|music:|page\d|copyright|©/i;
/** 上下贴着的两个头（`isStackedPair`）拆分时每个头的得分门槛。 */
const PAIR_SCORE_MIN = 0.4;
/** 同音两声部只挂上一根干时，头另一侧的竖墨至少这么多格才算另一根干（`splitUnisons`）。 */
const UNISON_REACH = 2.0;
/** 另一根干够不上 `UNISON_REACH` 时，贴着头缘、反方向（放到头外）也没墨的，这么多格就算（我灵镇静 m26 F4，歌词挤得干只伸出头外 1.1 格）。 */
const UNISON_SHORT = 1.0;
/** 两个头盒中心上下差不到这么多格、左右差不到 `DUP_HEAD_DX` 格，就是同一个头被两路各认了一次。
 *  0.3 → 0.6：左右不错开的两个头上下不会只差一级（二度必定左右错开一个头宽）；万福泉源歌末小节「8」字叠头上面那个 E4
 *  被两路各认一次、盒差 0.5 格，多出一个 D4。 */
const DUP_HEAD_DY = 0.6;
const DUP_HEAD_DX = 0.5;
/** 上下贴着的两个实心头填满外框的九成以上（所信有根基 F4/D♭4 0.904），拆块的「太实是黑块」上限 0.9 对它放到这个数。 */
const PAIR_FILL_MAX = 0.96;
/** 空心头正上/正下一格、头宽×头高七成的窗里墨占这么多，算贴着一个实心头。 */
const SOLID_NEIGHBOR_FILL = 0.7;
/** 歌词账上来的弧，两端离头外缘的上限（格）。 */
const LYRIC_ARC_REACH = 1.5;
/** 实心头盒宽到这么多格、盒里又有干的，按带着加线截盒（全音符不论宽窄都查）。 */
const WIDE_BLACK = 1.45;

/** 拍号数字与模板的签名距离上限。见 `bootstrapTimeSig` 那段的说明。 */
const TIME_TEMPLATE_DIST = 180;
/** 压着一个全音符的 C 拍号列用的距离上限（见拍号那一段）。 */
const TIME_C_WHOLE_DIST = 240;
/** 调号串里按「前一个记号」认下一个的签名距离上限（同一本同一种记号，比模板近得多）。 */
const KEY_SELF_DIST = 120;
/** 几何闸收下的实心头，矮于这个数（线距的倍数）又压在符杠中线上的，是杠头。 */
const BEAM_STUMP_H = 0.65;
/** 杠端假头的高度上限（格）：主使我喜乐 m16 杠起头连着干尖 0.69 格，有一位神 m10 连着第五线 0.95 格，倚靠主永远膀臂 m11 主杠尾连着下层短杠 1.13 格。 */
const BEAM_END_STUMP_H = 1.2;
/** 结构还原号：两根竖笔的间距（格）。 */
const NAT_GAP = [0.35, 0.8] as const;
/** 按角色限定认拍号数字（见拍号那一段）：分子只在 2~9 里挑，分母只在 2、4、8 里挑。
 *  距离上限：万古磐石歌的铅字「3」到 `timeSig3` 186/214，齐来谢主歌分母「4」181/230，
 *  万古磐石歌分母「4」246/275（去线切得最狠）。 */
const NUM_DIGITS = [2, 3, 4, 5, 6, 7, 8, 9] as const;
const DEN_DIGITS = [2, 4, 8] as const;
const TIME_NUM_DIST = 230;
const TIME_DEN_DIST = 300;
/** 头盒落在符尾盒里的比例过这个数就不算头（见建音符前那一段）。 */
const FLAG_HEAD_OVERLAP = 0.5;
/** 实心头中心椭圆里白占这么多以上、又没有杠和尾的，时值按空心头算（见 `hollowish`）。 */
const HOLLOW_FILL = 0.3;
/** 封闭内腔面积占头盒的下限（`hollowish` 的另一路）。 */
const HOLLOW_CAVITY = 0.1;
/** 封闭内腔那一路只看盒高不过这么多格的小头。 */
const HOLLOW_SMALL_H = 0.8;
/** 碎块并回判出的空心头，封闭内腔（最大一块）占盒的下限。 */
const MERGE_HOLLOW_CAVITY = 0.05;
/** 被符头隔断的竖段接回一根（`joinVSegs`）：中心差（px）、断口上限（格）。 */
const VSEG_JOIN_DX = 2;
const VSEG_JOIN_GAP = 1.2;
/** 按竖笔数升号（`sharpsByStrokes`）的起点：谱号左缘往右多少格。 */
const KEY_FROM = 2.4;
/** 谱线算「粗」的线宽/线距比（数降号竖笔时抬高度闸，见 `flatsByStrokes`）。 */
const KEY_THICK_LINE = 0.22;
/** 粗线页那套降号判据只用于线距小于这么多像素的低分辨率页。 */
const KEY_COARSE_SPACE = 13;
/** 降号竖笔顶端到肚子中心的距离（格）。新编赞美诗 11 各行量得 1.5~1.6。 */
const FLAT_STEM = 1.55;
/** 粘连升号串（见谱号兜底那段）：盒高上限、竖笔高度范围（格）。 */
const KEY_RUN_MAX_H = 5.2;
const KEY_STROKE_H = [2.5, 3.4] as const;
/** 分子读成 4 时的复核（见拍号那一段）：分子到分母 4 的签名距离过这个数，
 *  且别的数字在 `TIME_ALT_DIST` 以内，就改认那个数字。 */
const TIME_SELF_DIST = 215;
const TIME_ALT_DIST = 265;
/** 派生的「9」要比别的数字近出这么多才采信（见 `digitOf`）。 */
const NINE_MARGIN = 30;

/** 空心符头允许离谱表多远（线距的倍数）。见 `inBand` 那段的说明。 */
const HOLLOW_BAND = 3.0;

/**
 * 符尾窗口的墨占比门槛。
 *
 * 原来 0.25，收窄窗口之前是对的；收窄之后真符尾落在 **0.17~0.21**、
 * 真四分仍是 0.00（中间还是没人，只是整条尺子往下挪了）。
 * 扫过 0.10 / 0.14 / **0.16~0.18** / 0.20 / 0.22 / 0.25：
 * 时值 91.9 / 92.0 / **92.1** / 92.0 / 91.0 / 89.4%。
 * 0.18 → 0.15：低分辨率放大的万古磐石歌符尾只有三五像素粗，窗口占比 0.13~0.16。独唱谱时值 84.44 → 84.50%
 *（主使我喜乐 87.4 → 88.5、万古磐石歌 38.5 → 39.1%），合唱谱各档不退；0.12 时合唱谱干净档满拍自检 66.02 → 65.69%。
 */
const FLAG_INK = 0.15;
/**
 * 符尾那个窗口的**横向范围**（线距的倍数，从符干中心往右算）。
 *
 * 原来放到 1.5 格，太宽：这套底本的八分符尾是**一条细弧**，
 * 从符干尖端斜挂下来、横跨也只有 0.9 格（实测破碎 p2 x453 那个八分，
 * 符尾占 x453~468、纵跨 2.7 格，每行只有两三个像素）。
 * 窗口比符尾宽出一半，占比就被空白摊薄。
 * 扫过 0.8 / **1.0** / 1.3：时值 92.1 / 92.1 / 90.9%。
 */
const FLAG_X = [0.15, 1.0] as const;
const FLAG_LEFT = 0.25;
/** 符尾窗口的**纵向长度**（线距的倍数，从符干尖端往符头方向）。
 *  放到 2.5 格（罩住整条符尾）实测更差：符尾下半截是根细线，多罩进来的全是白的。 */
const FLAG_Y = 1.5;
/**
 * 贴着符干尖端那一小截要的墨（`FLAG_INK` 的伙伴）。
 *
 * 这一档**比整窗那一档松得多**：符尾在尖端是**贴着符干**走的（实测破碎 p2 x453
 * 那个八分，尖端往下 0.35 格里符尾只占符干右侧一两列，而窗口从 0.15 格外才开始数），
 * 拿整窗的门槛卡这一截，真符尾一个都过不去。这条闸要的只是「符尾确实从尖端长出来」，
 * 不是「这里墨很多」。
 */
const FLAG_TIP = 0.05;
/**
 * 那一小截的**纵向长度**（线距的倍数）。原来 0.35：合唱谱那套符尾在尖端就贴着符干。
 * 万古磐石歌那种老铅字的符尾从尖端**细细地**长出来，往下 0.3 格才变粗（放大后线距 22px，
 * 尖端 8 行里符干右侧只有一两个像素），八分整批读成四分。
 * 扫过 0.35 / 0.5 / **0.6**：万古磐石歌时值 22.4 / 23.0 / **31.6**%，别的曲子与合唱谱不动。
 */
const FLAG_TIP_Y = 0.6;
/** 第二道钩（十六分）的门槛。比第一道**严**：那一段窗口里还可能扫到下一个音的符干或符头。
 *  0.3 → 0.25：有了右缘双峰 / 贴干两段的形状判据兜底，万古磐石歌的细钩（0.28~0.29）才过得去，时值 64.9 → 67.2%；
 *  0.2 与 0.25 一样，合唱谱扫描件满拍自检略退。 */
const FLAG_INK2 = 0.25;
/** 线宽过了这么多格才往里找符尾的连接点（细线页只看尖端，防弧线）。 */
const FLAG_REACH_LW = 0.15;
/** 两道钩的右缘轮廓中间要凹下去这么多格。 */
const HOOK_PROM = 0.15;
/** 符尾窗口与和弦字母条交叠超过这一成就不认。 */
const FLAG_AVOID = 0.2;
/** 干尖顺着干往外延的上限（格）。 */
const FLAG_TIP_EXT = 2.0;
/** 谱表外的头按墨定高时，墨高（格）要在这个范围里才算一个头。 */
const HEAD_INK_H = [0.8, 1.3] as const;
/** 干尖顺着干要延出这么多（格），才从延出的真干尖重找符尾、补判第二道钩。 */
const FLAG_GLUED = 0.5;
/** 第二道钩：干右侧竖扫能数出两段黑的列至少占这么多。 */
const FLAG_COLS2 = 0.25;
/** 竖扫只扫到干右侧这么远（格）：再往外，八分长尾回弯的尖也会被数成第二段。 */
const FLAG_COLS_X = 0.6;
/** 符干两端离干上的头心都不过这么多格：是两个头之间被切出来的一截干，没有自由端，不找符尾。
 *  0.75 → 1.0：我灵镇静低音谱表 C4/A3 和弦的干被加线切成两截，上一截下端离 A3 头心 0.94 格，
 *  A3 头的右半边被当成了八分符尾。 */
const FLAG_BOTH_ENDS = 0.95;

/**
 * **几个音共用的那条长加线，要按符头切成短段补进去。**
 *
 * 相邻几个音落在同一条加线上时，谱面上画的是**一条通长的横线**
 *（实测破碎 p4 两个音共用的那条 x[616,723]、长 **6.25 格**）。
 * 而下游有两道长度闸都是按「一个符头的加线」定的：
 * `findNoteheads` 只收 ≤ 6 格的横段、`findLegers` 还要求不超过符头宽的三倍。
 * 通长的那条两道都过不了，于是这些音**一条加线都找不到**
 *（实测未认领的符头里「需要 1 条、找到 0 条」占 155/259，这是头号成因）。
 *
 * 不去动那两道闸——它们防的是「和弦图的格线被当成加线」，是拿具体页换来的。
 * 改成在位图这边**按符头把长线切成短段**补进去：加线本来就是给符头垫的，
 * 一个符头配一小段，长度取符头宽的一倍半，语义与「剪出来的加线」那一路一致。
 *
 * 只切**落在谱线网格延长线上**的横段（`ledgerGrid`），那是加线的硬判据。
 */
function sharedLegers(hSegs: LineSeg[], heads: { box: Rect }[], onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
  const out: LineSeg[] = [];
  for (const seg of hSegs) {
    const y = (seg.y0 + seg.y1) / 2;
    if (Math.abs(seg.x1 - seg.x0) <= unit.space * 3) continue; // 短的下游本来就收得下
    if (!onGrid(y)) continue;
    const left = Math.min(seg.x0, seg.x1);
    const right = Math.max(seg.x0, seg.x1);
    for (const h of heads) {
      const cx = h.box.x + h.box.w / 2;
      if (cx < left || cx > right) continue;
      // 窗口要放到三格：谱表外两三格的音，**里面那几条加线上并没有符头**
      //（实测「需要 2 条、找到 1 条」占 66 处，缺的就是里侧那条）。
      // 放宽不怕误收——`findLegers` 自己还要判「加线落在符头与谱表之间」。
      if (Math.abs(y - (h.box.y + h.box.h / 2)) > unit.space * 3.2) continue;
      const half = h.box.w * 0.8;
      out.push({ x0: Math.max(left, cx - half), y0: y, x1: Math.min(right, cx + half), y1: y, lw: seg.lw, maxLw: seg.maxLw });
    }
  }
  return out;
}

/**
 * 骑在加线上的符头，按它自己的位置补一条加线（验过那一带确实有墨）。
 *
 * 判据：中心落在加线网格上（`ledgerGrid`）、且沿中心线左右各半个符头宽的范围内，
 * 六成以上的列在 ±线宽 内有墨。补出来的段按符头宽的一倍二，与 `trimLedger` 那条同口径。
 */
function ownLegers(heads: { box: Rect }[], bin: Binary, onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
  const out: LineSeg[] = [];
  const th = Math.max(1, Math.round(unit.lineThick));
  for (const h of heads) {
    const cy = h.box.y + h.box.h / 2;
    const cx = h.box.x + h.box.w / 2;
    const half = h.box.w * 0.6;
    // 候选位置：符头**自己骑着的**那条网格线，以及**上下各半格**的那条
    // ——符头落在加线上面/下面那一间时，压着它的那条加线同样抽不出来
    //（那一带的纵向游程是「符头 + 线」的高度，出了「细」的那道闸），
    // 而它正是 `findLegers` 要数的那一条。
    for (const y of [cy, cy - unit.space / 2, cy + unit.space / 2]) {
      if (!onGrid(y)) continue;
      let ink = 0;
      let n = 0;
      for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
        if (x < 0 || x >= bin.w) continue;
        n++;
        for (let d = -th; d <= th; d++) {
          const yy = Math.round(y) + d;
          if (yy >= 0 && yy < bin.h && bin.data[yy * bin.w + x]) {
            ink++;
            break;
          }
        }
      }
      if (!n || ink < n * 0.6) continue;
      out.push({ x0: cx - half, y0: y, x1: cx + half, y1: y, lw: th, maxLw: th });
    }
  }
  return out;
}

/** `staffBandOnly` 时谱表上下各留这么多个线距。扫过 1.5 / 2 / 3.5 格（《坚固保障》，和弦字母在上方 1.6 格处）：
 *  音符 74 / 75 / 80，其中 3.5 格那档有 5 个是被当成全音符的和弦字母。2 格是拐点。 */
const STAFF_BAND = 2;

/** 位图符杠 → 矢量路的 `BeamShape`（`buildNotes` / `findTuplets` 吃这个）。 */
function toBeamShapes(beams: BeamQuad[]): BeamShape[] {
  return beams.map((b) => {
    const box: Box = { left: b.box.x, right: b.box.x + b.box.w, top: b.box.y, bottom: b.box.y + b.box.h };
    return { box, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, level: 0 };
  });
}

/** 杠端续到干：干在杠端外这个范围（格）里。 */
const BEAM_SNAP = [0.2, 1.0] as const;
/** 杠端续到干：干的一端离杠延长线不过这么多格；杠端与干之间沿杠走向有墨的列占比下限。 */
const BEAM_SNAP_END = 0.75;
const BEAM_SNAP_INK = 0.8;

/**
 * **杠端没够着干的，续到干上**：斜的网点杠靠干那一截薄、又有网孔，检出的杠盒比真杠短半格
 *（当我们回到天家 m2：杠从 x=712 起，干在 704），`beamConnect` 的容差只有 0.2 格，那根干就接不上杠、八分读成四分。
 * 杠端外 `BEAM_SNAP` 格内有根干、干的一端正落在杠的延长线上、中间沿杠走向（杠厚上下各放一像素）的列大多有墨，就把杠端挪到干上。
 */
function snapBeamEnds(beams: BeamShape[], stems: Seg[], bin: Binary, sp: number): void {
  const yAt = (b: BeamShape, x: number) => (b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0));
  for (const b of beams) {
    const half = (b.box.bottom - b.box.top) / 2 + 1;
    const inkCol = (x: number): boolean => {
      const cy = yAt(b, x);
      for (let y = Math.round(cy - half); y <= Math.round(cy + half); y++) if (y >= 0 && y < bin.h && bin.data[y * bin.w + x]) return true;
      return false;
    };
    for (const side of [0, 1] as const) {
      const end = side === 0 ? b.x0 : b.x1;
      let got: Seg | null = null;
      for (const st of stems) {
        const d = side === 0 ? end - st.cx : st.cx - end;
        if (d < sp * BEAM_SNAP[0] || d > sp * BEAM_SNAP[1]) continue;
        const y = yAt(b, st.cx);
        if (Math.min(Math.abs(st.top - y), Math.abs(st.bottom - y)) > sp * BEAM_SNAP_END) continue;
        if (!got || Math.abs(st.cx - end) < Math.abs(got.cx - end)) got = st;
      }
      if (!got) continue;
      const xa = Math.round(Math.min(got.cx, end)) + 1;
      const xb = Math.round(Math.max(got.cx, end)) - 1;
      let n = 0;
      let k = 0;
      for (let x = xa; x <= xb; x++, n++) if (inkCol(x)) k++;
      if (n && k < n * BEAM_SNAP_INK) continue;
      const y = yAt(b, got.cx);
      if (side === 0) {
        b.x0 = got.cx;
        b.y0 = y;
        b.box.left = Math.min(b.box.left, got.cx);
      } else {
        b.x1 = got.cx;
        b.y1 = y;
        b.box.right = Math.max(b.box.right, got.cx);
      }
    }
  }
}

/** 符尾围出的「空心头」离干端不超过这么多格（见「符尾围出来的空心头不要」）。 */
const FLAG_REACH = 1.6;
/** 符尾判据里「另一端的实心头」离谱表首末线不超过这么多格。 */
const FLAG_HEAD_BAND = 2.5;
/** 符尾与干那端实心头的最小距离（格）。 */
const FLAG_GAP = 2.8;
/** 头盒中心离整音级这么多（级）以上算悬着，交模板定夺。 */
const SNAP_AMBIG = 0.25;
/** 谱线、加线上的「杠」厚不过这么多格、又挨着符头的不算层数（见 `thinOnLine`）。 */
const THIN_BEAM_H = 0.3;
/** 离最近谱表外线超过这么多格的符头要有加线链才留。扫过 **3.75** / 4.25 / 4.75：93.47 / 93.32 / 93.23%。 */
const FAR_HEAD = 3.75;
/** 页顶标题字高的上限（格）：再高的是大括号、竖线一类。 */
const TITLE_CHAR_MAX = 12;
/**
 * 离谱表外线超过几格的头要查加线链（建页前那一道）。原来同 `FAR_HEAD`（3.75 格，三条加线以外）；
 * 谱表上方的表情文字（「unis. no vibrato」）里的字母离外线两三格，收成实心头、没有干读成全音符 D6、C6
 *（望十架 p1、p6、p10 十来个）。要一条加线以上（1.25 格）就查：真音外线到头之间每隔一格都有加线墨，字没有。
 */
const LEDGER_CHAIN_FROM = 1.25;
/** 第一加线上的空心头：穿过头心的横墨（头 + 两侧加线）至少这么长（格）。 */
const FIRST_LEDGER_RUN = 1.4;
/** 墨柱补干：从头心算起伸出去的长度（格），同 `notehead.ts::INK_STEM`。 */
const INK_STEM_REACH = [2.5, 7] as const;

/** 认一页。顺序照 `staffomr/index.ts::recognizeStaffPage`，**别调**。 */
export async function recognizeRasterPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfPage: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OPS: any,
  look: RasterGlyphLookup,
  index: number,
  opts: {
    carryTime?: { beats: number; beatType: number };
    carryKey?: CarryKey;
    /**
     * 歌词条的 OCR 结果，**按条的内容指纹寻址**（`stripKey`）。
     *
     * 直接用 OCR 的文本，不做形状聚类——聚类那一版实测把四成多的字格丢在
     * 「类里投不出过半票」上（覆盖 52%，歌词 35%）。
     * 缓存由 `scripts/gen-rasterlyrics.mjs` 生成：起一次浏览器把全语料的条跑完落盘，
     * 之后识别命中缓存，仍然不起浏览器。
     */
    lyricOcr?: Map<string, OcrChar[]>;
    /** 声部标签的 OCR 缓存（`scripts/gen-rasterlabels.mjs` 的产物）。见 `stafflabel.ts`。 */
    labelOcr?: Map<string, string>;
    /** 拍号数字条的 OCR 缓存（`scripts/gen-rastertime.mjs` 的产物）。见 `timesig.ts`。 */
    timeOcr?: Map<string, string>;
    /** 文字指示带的 OCR 缓存（`scripts/gen-rasterwords.mjs` 的产物）。见 `words.ts`。 */
    wordOcr?: Map<string, WordLine[]>;
    /** 把文字指示带放进结果（`wordStrips`）。缺省不带，见该字段的说明。 */
    wantWordStrips?: boolean;
    /** 这一页是曲首页：切页眉带（`headerStrips`），有缓存就读出页眉（`header`）。 */
    wantHeader?: boolean;
    /** 页眉带的 OCR 缓存（`gen-rasterheader.mjs` 的产物，值同文字指示带）。 */
    headerOcr?: Map<string, WordLine[]>;
    /** 和弦条的 OCR 缓存（`scripts/gen-rasterharmony.mjs` 的产物）。见 `harmony.ts`。
     *  值的类型与歌词缓存共用（`OcrChar`）——两边都是「整条送 rec，回来字符带条内 x」。 */
    harmonyOcr?: Map<string, OcrChar[]>;
    /** 简谱行的离线识别缓存（`scripts/gen-rasterjianpu.mjs` 的产物）。混排谱拿它给五线谱纠错，见 `jianpufuse.ts`。 */
    jianpuOcr?: Map<string, JianpuRow[]>;
    /** 排查用：把连通块与「谁被认领了」带出来（`debugBlobs` 字段）。识别判据一条不改。 */
    debug?: boolean;
    /**
     * 谱表带之外的墨一律抹掉（上下各 `STAFF_BAND` 个线距）。**排查用，正路别开**。
     *
     * 从前立 GT 底稿要靠它挡住和弦字母（字母被收成符头，见下面那一处的实测）；
     * 现在和弦带在找符头**之前**就按检测框认领掉了（`harmony.ts`），那条理由没了。
     * 留着是因为排查「某个东西是不是带外的墨引起的」时一开就见分晓。
     * **开了歌词与和弦都没有**。
     */
    staffBandOnly?: boolean;
  } = {},
): Promise<RasterPageResult> {
  const raster = await rasterizePage(pdfPage, OPS);
  const blank = buildRasterPage({ index, width: raster?.bin.w ?? 1, height: raster?.bin.h ?? 1, unit: { lineThick: 1, space: 1, height: 4 }, staffLines: [], hSegs: [], vSegs: [] });
  if (!raster) return empty(blank, null, null, opts.carryTime, opts.carryKey);
  const unit = estimateUnit(raster.bin);
  if (!unit) return empty(blank, raster, null, opts.carryTime, opts.carryKey);
  // 行投影找谱线；**明显不够的页面**（扫得糊、线细断）再拿逐列游程的轨迹补上
  // ——判据与推平同一道闸，见 `dewarp.ts::completeStaffLines`。
  const rowLines = findStaffLines(raster.bin);
  const { lines, groups } = completeStaffLines(raster.bin, rowLines, groupStaves(rowLines));
  if (!groups.length) return empty(blank, raster, unit, opts.carryTime, opts.carryKey);
  // 谱线左端顺着线再往左追（弯页左段落在横带外，见 `traceLeft`）。一行谱五条线的左端
  // 本该一致，追的时候中间几条常被谱号挡住（齐来称颂第一行追到 153/209/216/193/153），
  // 取**至少两条吻合的最小左端**统一给五条线——下游一律拿五条线左端的最大值当谱行左缘。
  for (const g of groups) {
    const ls = g.lines.map((l) => traceLeft(raster.bin, l.left, l.y0, l.y1)).sort((a, b) => a - b);
    const agreed = ls.find((v) => ls.filter((u) => Math.abs(u - v) <= 3).length >= 2);
    // 只在差出两格以上时改：扫描件的左端本来就参差几个像素，照改会把谱号、括号的窗口
    // 挪动一点点，合唱谱扫描件歌词实测跌 5 个点。
    const cur = Math.max(...g.lines.map((l) => l.left));
    if (agreed !== undefined && cur - agreed > unit.space * 2) for (const l of g.lines) l.left = Math.min(l.left, agreed);
  }

  // **只留谱表带**（默认不开，立 GT 底稿时才开）。独唱谱那种谱表上方印和弦字母的底本，
  // 字母「C」是个圈，正落在空心符头那一档里（`HOLLOW_BAND` 上下各让三格，字母就在里面）；
  // 谱表下方的歌词字同理被收成实心符头——实测《坚固保障》整页多出六个 D6/E6 全音符、
  // 四个 C3 四分音符。歌词与和弦都不要的场合（出 GT 底稿）直接把带外的墨抹掉最省事。
  // **识别判据一条不改**：抹的是输入，不是判据。
  if (opts.staffBandOnly) {
    const bin = raster.bin;
    const keep = new Uint8Array(bin.h);
    for (const g of groups) {
      const sp = (g.lines[4].y - g.lines[0].y) / 4;
      const y0 = Math.max(0, Math.round(g.lines[0].y - sp * STAFF_BAND));
      const y1 = Math.min(bin.h - 1, Math.round(g.lines[4].y + sp * STAFF_BAND));
      for (let y = y0; y <= y1; y++) keep[y] = 1;
    }
    for (let y = 0; y < bin.h; y++) if (!keep[y]) bin.data.fill(0, y * bin.w, (y + 1) * bin.w);
  }

  // 没成组的横线（通长加线、谱表外的长横墨）只抹细的那几列：连成一长条的**符杠**也会被投影成一条「线」，
  // 照谱线抹就整条没了（主使我喜乐第三行谱表下方一格的连杠八分，杠整条被抹、十来个八分读成四分）
  const grouped = new Set(groups.flatMap((g) => g.lines.map((l) => l.y)));
  const nl = removeStaffLines(raster.bin, lines.map((l) => l.y), unit, new Set(lines.map((l) => l.y).filter((y) => !grouped.has(y))));
  /** 分好组的谱线（五条一组）。`lines` 里还混着没成组的横线，按「五条一组」取第几线的判据（`nearRestLine`、`restKind`）
   *  用它会错位（《所信有根基》简谱行里的减时线过了休止的位置闸，读成二分休止）。 */
  const staffLines = groups.flatMap((g) => g.lines);
  const staffLefts = groups.map((g) => Math.max(...g.lines.map((l) => l.left)));
  // **加线网格只认分好组的线**。`ledgerGrid` 按「五条一组」取锚点，
  // 混进没成组的线（通长的加线、噪声横线）锚点就全错位，
  // 于是加线判不出来——而谱表外的符头**要有加线撑着才归得了谱行**
  // （实测宁静 p5 八度跑动上方那七个符头，认出来了却一个都没归属，窗口里一条横段都没有）。
  const gridYs = groups.flatMap((g) => g.lines.map((l) => l.y));
  /** 各谱表五条线的 y（从上到下）。 */
  const staffYs = groups.map((g) => g.lines.map((l) => l.y).sort((p, q) => p - q));
  // 没进任何一组的行投影线：多半是**通长的加线**（见 `staffLines` 那一处的说明）
  const groupedLines = new Set(groups.flatMap((g) => g.lines));
  const strayLines: LineSeg[] = lines
    .filter((l) => !groupedLines.has(l))
    .map((l) => ({ x0: l.left, y0: l.y, x1: l.right, y1: l.y, lw: l.y1 - l.y0 + 1, maxLw: l.y1 - l.y0 + 1 }));
  const prims = findPrimitives(nl, unit, gridYs, staffLefts, raster.faint);

  // ── 简谱行（混排谱）：**先于一切**认领 ─────────────────────────────────────
  //
  // 谱表正上方那行简谱的数字、增时线、高低音点，不挡就被收成全休止和加线上的符头
  //（见 `jianpuband.ts`）。整块落在带里的墨从两张图上抹掉，带里的原语一并摘掉；
  // 抹之前把条切下来，留给离线认简谱。定位判据是「短竖线与谱表小节线同 x」，
  // 独唱谱、合唱谱对不上，这一段对它们空转。
  const staffGeoms = groups.map((g) => ({ left: Math.max(...g.lines.map((l) => l.left)), right: Math.min(...g.lines.map((l) => l.right)), top: g.lines[0].y, bottom: g.lines[4].y }));
  // **随 x 变化的五线**：页面轻微倾斜、线距不匀时，局部实测的线与整行的 y 差出 3~6 像素（44 首独唱谱 p99）。
  // 读音高、悬着的空心头定夺按该处的五线、相邻两线间的相对位置来（`staffline.ts::localLineModel`）。
  // **按音高位置配模板、吸附网格不用它**：接上之后独唱谱音符 −0.13~−0.28（拆块、摘头的候选位置一挪，
  // 和弦成员、时值跟着连锁变，主我敬拜你 +4.9、向主唱新歌 −8.8），仍是整行的等距网格。
  const frames: LineFrame[] = groups.map((g, i) => ({
    top: staffGeoms[i].top,
    bottom: staffGeoms[i].bottom,
    // 量的范围取**最长**那条线：倾斜页上有一条线的投影段在半途断了，按最短的量，右边一截只能拿末桶外推
    //（颂赞与尊贵第二行右端实测偏 4.5 像素、外推只给 1，m6 的 A4 读成 G4）。线外的桶量不到，按每桶三条以上取中位兜着
    at: localLineModel(raster.bin, g.lines.map((l) => l.y), Math.min(...g.lines.map((l) => l.left)), Math.max(...g.lines.map((l) => l.right)), unit),
  }));
  const jianpuBands = findJianpuBands(prims.vSegs, staffGeoms, unit);
  // 简谱小节线同 x 的谱表竖段补成整条小节线（细线扫描件被阈值切断的，见 `completeStaffBars`）
  completeStaffBars(prims.vSegs, staffGeoms, jianpuBands, unit);
  if (raster.gray) bridgeFaintBars(prims.vSegs, raster.gray, raster.bin.w, groups.map((g) => g.lines.map((l) => l.y)), unit);
  const jianpuStrips = jianpuBands.map((b) => cutJianpuStrip(raster.bin, b));
  if (jianpuBands.length) {
    for (const b of jianpuBands) eraseInBand([raster.bin, nl], b.box);
    const inJp = (x: number, y: number) => jianpuBands.some((b) => x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y && y <= b.box.y + b.box.h);
    const outside = (v: { x0: number; y0: number; x1: number; y1: number }) => !(inJp(v.x0, v.y0) && inJp(v.x1, v.y1));
    prims.vSegs = prims.vSegs.filter(outside);
    prims.hSegs = prims.hSegs.filter(outside);
    prims.beams = prims.beams.filter(outside);
  }
  const blobs = findBlobs(nl, prims, unit, ledgerGrid(gridYs, unit));

  // ── 顶部大字号文字：**先认成标题** ────────────────────────────────────────
  //
  // 页顶标题的字比歌词字号上限（`lyric.ts::CHAR_MAX`，2.8 格）高，整字进不了歌词带，被切下来的碎笔却进得去，
  // 拼成一行「歌词」挂到第一行谱上（你的信实广大、我一生要赞美你的标题五六个字碰巧一音一字对得上）；
  // 字里的圈与横笔还会被收成符头、休止（我一生要赞美你标题「你」配上了八分休止）。
  // 第一行谱上方、高过 `CHAR_MAX` 的块按纵向重叠归行，一行里有两个以上的就是标题行：中心落在那一行纵向范围里的块
  //（大字被去线切下的碎笔、并排印着的小字）先全部认领，歌词带与符头那几路都看不见。
  const titleIds = new Set<number>();
  if (groups.length) {
    const sp = unit.space;
    const top0 = Math.min(...groups.map((g) => g.lines[0].y));
    const above = blobs.filter((c) => c.bbox.y + c.bbox.h < top0 - sp);
    const big = above.filter((c) => c.bbox.h > sp * LYRIC_CHAR_MAX && c.bbox.h < sp * TITLE_CHAR_MAX).sort((a, b) => a.bbox.y - b.bbox.y);
    const bands: { y0: number; y1: number; n: number }[] = [];
    for (const c of big) {
      const y0 = c.bbox.y, y1 = c.bbox.y + c.bbox.h;
      const b = bands.find((q) => Math.min(q.y1, y1) - Math.max(q.y0, y0) > Math.min(q.y1 - q.y0, y1 - y0) * 0.5);
      if (b) (b.y0 = Math.min(b.y0, y0)), (b.y1 = Math.max(b.y1, y1)), b.n++;
      else bands.push({ y0, y1, n: 1 });
    }
    for (const b of bands) {
      if (b.n < 2) continue;
      for (const c of above) {
        const cy = c.bbox.y + c.bbox.h / 2;
        if (cy >= b.y0 && cy <= b.y1) titleIds.add(c.id);
      }
    }
  }

  // ── 和弦带：**先于符头认领** ──────────────────────────────────────────────
  //
  // 独唱谱在谱表上方印和弦字母。`C`、`D`、`G` 都是圈，正落在空心符头那一档里
  // （`HOLLOW_BAND` 上下各让三格，字母就在里面）——实测《坚固保障》整页因此
  // 多出六个 D6/E6 全音符、四个 C3 四分音符。从前是拿 `staffBandOnly` 把带外的墨
  // 整片抹掉换干净的，那是遮挡不是识别，和弦与歌词一起没了。
  //
  // 现在按**检测框**认领：缓存里有这条带的 OCR 结果才认领，没有就什么也不做
  // ——合唱谱那批没有和弦带缓存，这一段对它是空转，基线不动。
  // **只看系统的首行**：闭合谱、合唱谱下面几行谱表的上方不印和弦，那里是上一行的歌词与
  // 带加线的高音符头（《赞美一神》低音谱表上方的男高 D4 被读成「D」）。
  // 判据是谱表左端的系统线从上一行连下来。
  const joinedAbove = (i: number) =>
    i > 0 &&
    prims.vSegs.some((v) => {
      const left = Math.max(...groups[i].lines.map((l) => l.left));
      return Math.abs((v.x0 + v.x1) / 2 - left) <= unit.space && Math.min(v.y0, v.y1) <= groups[i - 1].lines[4].y + unit.space * 0.5 && Math.max(v.y0, v.y1) >= groups[i].lines[0].y + unit.space * 0.5;
    });
  const pageRight = Math.max(...groups.flatMap((g) => g.lines.map((l) => l.right)));
  const harmonyStrips = findHarmonyStrips(
    raster.bin,
    groups.flatMap((g, i) => joinedAbove(i) ? [] : [{
      box: {
        left: Math.max(...g.lines.map((l) => l.left)),
        // 右界取**全页谱线右端的最大值**：网点水印把谱线右段打断，五条线量出来的右端
        // 多数停在 1018~1233（真右端 1360），取最小值就切不到行尾的和弦（《求主同住》缺三个）
        right: pageRight,
        top: g.lines[0].y,
      },
      index: i,
      // 有简谱行的谱表，和弦字母印在简谱行上方
      ceiling: jianpuBands.find((b) => b.staff === i)?.box.y,
    }]),
    unit,
  );
  const harmonies: HarmonyToken[] = [];
  /** 和弦带里认出来的**文本**（词曲署名、Fine 之类）：不进和弦，单独交出去。 */
  const harmonyTexts: HarmonyToken[] = [];
  const harmonyIds = new Set<number>();
  const harmonyMasks: Rect[] = [];
  {
    // 一行谱一行：先逐条读，再按整行判是和弦行还是文本行（`harmonyLine`）
    const lines = new Map<number, { strip: HarmonyStrip; chords: HarmonyToken[] }[]>();
    const lineTexts = new Map<number, HarmonyToken[]>();
    for (const strip of harmonyStrips) {
      // 条的上沿够到上一行谱第五线下一格半以内的，是上一行挂下来的符杠与头（当我们回到天家第三系统低音谱表下的
      // 两组连杠 A2 读成两个「D」、头被当和弦字母认领走）。和弦字母离上一行谱远得多
      const prev = groups[strip.staff - 1];
      if (prev && strip.box.y < prev.lines[4].y + unit.space * 1.5) continue;
      const chars = opts.harmonyOcr?.get(harmonyKey(strip));
      if (!chars?.length) continue; // 缓存没命中：这条没跑过 OCR，宁可不认领
      const { chords, texts } = readHarmonyStrip(strip, chars);
      if (!lines.has(strip.staff)) lines.set(strip.staff, []), lineTexts.set(strip.staff, []);
      lines.get(strip.staff)!.push({ strip, chords });
      lineTexts.get(strip.staff)!.push(...texts);
    }
    for (const [staff, rows] of lines) {
      const r = harmonyLine(rows.flatMap((x) => x.chords), lineTexts.get(staff)!);
      harmonyTexts.push(...r.texts);
      if (!r.chords.length) continue;
      harmonies.push(...r.chords);
      // 切不出和弦记号的条不认领：闭合谱低音谱表的顶上那条带里是带加线的高音符头
      //（《赞美一神》男高 D4/E4），OCR 读出几个字符、文法一个也不收，整条认领就把符头吃了。
      // **认领按条的盒，不按切出来的记号**：记号的 x 是 CTC 估的，误差常有半个字；
      // 条的盒是列投影裁紧的，正是要挡掉的那一簇墨。
      for (const x of rows) if (x.chords.length) harmonyMasks.push(x.strip.box);
    }
    // 条贴着墨迹裁，往外放半格容下笔画的毛边
    const pad = unit.space * 0.5;
    for (const c of blobs) {
      const b = c.bbox;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (harmonyMasks.some((m) => cx > m.x - pad && cx < m.x + m.w + pad && cy > m.y - pad && cy < m.y + m.h + pad))
        harmonyIds.add(c.id);
    }
  }

  // ── contour 层与认领账本 ─────────────────────────────────────────────────
  //
  // 在**去谱线图**上取轮廓（原图上五条谱线把整行谱连成一团），一团墨一个号；
  // 下面每认出一样东西就按它的盒记一笔。识别判据一条不改——账本只记账。
  const cmap = traceContours(nl, unit, groups.map((g) => ({
    top: g.lines[0].y,
    bottom: g.lines[4].y,
    left: Math.max(...g.lines.map((l) => l.left)),
    right: Math.min(...g.lines.map((l) => l.right)),
  })));
  const ledger = new ContourLedger(cmap);
  // **段要等下游挂上标记再记**（`findStaves` / `findLegers` / `findStems` /
  // `findBarlines` 之后，见下面那一处）：`findPrimitives` 抽出来的横段里混着松叶的臂、
  // 连音线的一截——照抽出来就记，这些正是要找的东西反而成了「有主的」。
  // 符杠**按中心线那条带记账**，与 `blobImage` 抹墨的口径一致。
  // 记包围盒会把贴着符杠的符头也算成「有主」——账本于是查不出钢琴行漏在哪
  //（实测那一带无主 contour 只剩 8 个碎点，而那一行少了 9 个音）。
  for (const b of prims.beams) {
    const x0 = Math.min(b.x0, b.x1);
    const x1 = Math.max(b.x0, b.x1);
    const half = Math.max(1, b.lw / 2 + 2);
    const steps = Math.max(1, Math.round((x1 - x0) / Math.max(1, unit.space / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const cy = b.y0 + (b.y1 - b.y0) * t;
      ledger.claim({ x, y: cy - half, w: Math.max(2, (x1 - x0) / steps), h: half * 2 }, "beam");
    }
  }

  // 符头按性质判（填充率 + 有没有符干），不查字典；其余的块查字典。
  const onGrid = ledgerGrid(gridYs, unit);
  // 空心符头要卡在谱表带里（见 `findRasterHeads` 的说明）。
  //
  // **上下各让三格**，不是一格：一格只罩得住谱表之内，可**谱表外一两格的空心符头
  // 是常态**（间里的、带一两条加线的）——实测宁静 p1 那行叠置的空心和弦，
  // 有一个头的中心只比「一格」的边界多出半个像素就被拒了，整行五个小节只剩一个音。
  // 门槛扫过 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 格：
  // 音符 67.68 / 67.72 / 67.96 / 68.08 / **68.10** / 68.08 / 68.08，
  // 小节自检 37.7 / 38.2 / 39.5 / 39.9 / **40.1** / 40.1 / 40.1，
  // 而**歌词在四格以上开始垮**（50.0 → 46.8 → 45.1，歌词带里的字被收成空心符头）。
  // 三格是拐点。
  const inBand = (y: number) =>
    groups.some((g) => y > g.lines[0].y - unit.space * HOLLOW_BAND && y < g.lines[4].y + unit.space * HOLLOW_BAND);
  /** 中心在某行谱五条线之外、隔着至少一格（延长记号只在这里出现）。 */
  const offStaff = (y: number) =>
    !groups.some((g) => y > g.lines[0].y - unit.space && y < g.lines[4].y + unit.space);
  const matchHollow = look.templates
    ? (box: Rect) => matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, look.templates!)
    : null;
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
    const hRest = Math.max(0.1, b.h / unit.space - unit.lineThick / unit.space);
    if (w < REST_W[0] || w > REST_BEAM_W || hRest < 0.3 || hRest > REST_H) continue;
    if (Math.abs(q.y1 - q.y0) > unit.lineThick) continue; // 斜的是真符杠
    if (besideStem(b)) continue;
    if (nearStaffStart(b, groups, staffLefts, unit)) continue;
    if (restSyms.some((r) => overlapFrac(r.box, b) > 0.3)) continue;
    const tol = unit.lineThick + 2;
    const grp = groups.find((g) => b.y + b.h / 2 > g.lines[0].y && b.y + b.h / 2 < g.lines[4].y);
    if (!grp) continue;
    // 只收挪到下声部的位置（第四、五线）：第二、三线上的归块图那一路；这里放开的话，
    // 宁静的伯利恒吊在第二、三线下的一批扁块也进来，合唱谱干净档音符 −0.3
    const low = grp.lines.slice(3);
    const hang = low.some((l) => Math.abs(b.y - l.y) <= tol);
    const sit = low.some((l) => Math.abs(b.y + b.h - l.y) <= tol);
    if (!hang && !sit) continue;
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
    if (!isEighthRest(nl, full.box, full.area, unit)) continue;
    restIds.add(c.id);
    restSyms.push({ box: full.box, code: "rest8th" });
  }
  // **被谱线切成两截的八分休止**：球在线上、斜笔在线下（破碎扫描版 p8 女低 m?），去线后是两块，
  // 上面那一路回填不过谱线。没人认领的小球，正下方隔着一条谱线（间隙不过一个线宽加 3 像素）、横向重叠的另一块，
  // 合起来按八分休止的形状判
  for (const c of cmap.contours) {
    if (ledger.claimsOf(c.id).length) continue;
    const b = c.bbox;
    if (b.w < unit.space * 0.5 || b.w > unit.space * 1.2 || b.h < unit.space * 0.3 || b.h > unit.space * 1.0) continue;
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
    if (!isEighthRest(nl, box, c.area + d.area, unit, EIGHTH_REST_H_PIECES)) continue;
    if (restSyms.some((r) => overlapFrac(r.box, box) > 0.3)) continue;
    restSyms.push({ box, code: "rest8th" });
  }

  /** 块的中心压在某条符杠的中线上（半个杠厚以内）：那是提走符杠之后剩下的杠头，不是符头。 */
  const onBeamLine = (b: Rect, ext = 0) => {
    const cxb = b.x + b.w / 2;
    const cyb = b.y + b.h / 2;
    // `ext`：两端各外推多远。杠的拟合常收不到最末一截（有一位神 m4，杠拟合到 757、剩下 759~773 一截连着干尖被收成 F♯5）；
    // 只给几何闸那一路外推，判别器那一路外推了会剔掉真头（当我们回到天家 −0.4）
    return prims.beams.some((q) => {
      if (cxb < Math.min(q.x0, q.x1) - ext || cxb > Math.max(q.x0, q.x1) + ext) return false;
      const t = q.x1 === q.x0 ? 0 : (cxb - q.x0) / (q.x1 - q.x0);
      return Math.abs(cyb - (q.y0 + (q.y1 - q.y0) * t)) <= Math.max(q.lw, unit.space * 0.25);
    });
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
  const rawHeads = findRasterHeads(nl, blobs.filter((c) => !restIds.has(c.id) && !harmonyIds.has(c.id) && !titleIds.has(c.id)), prims.vSegs, unit, onGrid, inBand, matchHollow, offStaff);
  const heads = rawHeads.filter((hd) => {
    if (hd.code !== "noteheadBlack") return true;
    if (beamStump(hd.box, rawHeads.map((o) => o.box))) return false;
    return hd.box.h >= unit.space * BEAM_STUMP_H || !onBeamLine(hd.box);
  });
  const claimed = new Set([...heads.map((h) => h.comp.id), ...restIds, ...harmonyIds, ...titleIds]);

  // ── 空心符头：按**内腔（洞）**再找一遍 ───────────────────────────────────
  //
  // 空心符头被去谱线切碎之后一块都判不成符头（实测宁静 p2 钢琴右手那个二分和弦
  // 碎成四片），而它的**内腔**还在。所以在**去谱线之前**的图上取全页的孔，
  // 尺寸像内腔的往外扩一圈就是符头；骑线的头内腔被谱线豁成两半，先并回去。
  // 判据全在 `notehead.ts::hollowHeadsFromHoles`。
  const rawHoles = findHoles(raster.bin, Math.max(4, Math.round(unit.space * unit.space * 0.06)));
  // 缝落在谱线或加线上都算（`onGrid` 只管谱表外的加线位置）：《高举主大能》第三线上的 B4 二分头
  // 被第三线切成 10×5 与 13×5 两半，谱线上的不认就并不回来，头盒只剩下半截、读低一格
  const onLineOrGrid = (y: number) => onGrid(y) || gridYs.some((ly) => Math.abs(ly - y) <= unit.space * 0.25);
  // **成摞的整格谱间白**（小节线与贴着它的符干夹出来、隔着谱线一格摞一格）先剔掉：它们纵向相接，
  // 会顺着链把旁边头的内腔并成一个高孔（我一生要赞美你第六行，小节线右边紧贴的 A4 二分头
  // 与上面两格并成 17×42）。单独一格不剔：谱间里的二分头圈的上下边融进谱线、内腔被截平，
  // 也上下贴线、白也近乎占满外框（整格一律剔，坚固保障等掉一刀）。
  const half = unit.lineThick / 2;
  const cellLike = (b: Rect) => {
    if (b.h < unit.space * 0.6 || !onLineOrGrid(b.y - half - 0.5) || !onLineOrGrid(b.y + b.h + half - 0.5)) return false;
    let white = 0;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (!raster.bin.data[y * raster.bin.w + x]) white++;
    return white >= b.w * b.h * CELL_WHITE;
  };
  // 窄于 0.8 格的不剔：符干紧挨着小节线的那道窄缝（坚固保障第二行 x=996，0.47 格）剔了，
  // 缝底那一小截白单独成了「内腔」，认出一个贴着小节线的假二分头，那一刀就没了。
  const cells = rawHoles.filter((b) => b.w >= unit.space * 0.8 && b.w <= unit.space * 1.4 && cellLike(b));
  const stackedCell = (b: Rect) =>
    cells.includes(b) &&
    cells.some((o) => {
      if (o === b) return false;
      const ov = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x);
      const gap = o.y > b.y ? o.y - (b.y + b.h) : b.y - (o.y + o.h);
      return ov >= Math.min(b.w, o.w) * 0.6 && gap >= 0 && gap <= unit.lineThick + 2;
    });
  const holes = mergeHoles(rawHoles.filter((b) => !stackedCell(b)), unit, onLineOrGrid);
  // 和弦字母的**内腔**也是洞（`D`/`G`/`B`/`A` 都有），不挡住就从这一路漏回来
  // ——检测框一并算「已被占」。
  const takenBoxes = [...heads.map((h) => h.box), ...harmonyMasks];
  // 带宽照 `HOLLOW_BAND`（±3 格）。扫过 ±1.5 / ±2 / ±3 格，三档一样
  // ——这一路的过检不在带边上。
  const barSegs = prims.vSegs.filter((q) =>
    staffGeoms.some((g) => Math.abs(Math.min(q.y0, q.y1) - g.top) < unit.space * 0.4 && Math.abs(Math.max(q.y0, q.y1) - g.bottom) < unit.space * 0.4),
  );
  const stacked: RasterSym[] = hollowHeadsFromHoles(nl, holes, unit, prims.vSegs, inBand, takenBoxes, barSegs);
  // 并成一个高内腔的叠置空心和弦：按音高位置逐一配模板（`notehead.ts::hollowHeadsByPitch`），
  // 模板拿本页已认出的空心头（骑线 / 在间各一张）
  const lineYs = lines.map((l) => l.y);
  const hollowSamples = [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked].filter((s0) => !(s0 as { weak?: boolean }).weak);
  const hollowMasks = buildHollowMasks(raster.bin, hollowSamples, unit, lineYs);
  stacked.push(...hollowHeadsByPitch(raster.bin, nl, rawHoles, holes, hollowMasks, unit, makePitchSteps(groups), prims.vSegs, inBand, takenBoxes));
  // 谱表外骑加线的斜缝空心头：沿加线逐位置配同一组模板（`notehead.ts::hollowHeadsOnLedgers`）
  // 竖段表里没有、靠墨柱判出来的干：只进 `SPage`（与 `stemSegs` 同理），`buildNotes` 定时值要它
  const inkStems: LineSeg[] = [];
  stacked.push(...hollowHeadsOnLedgers(raster.bin, nl, rawHoles, hollowMasks, unit, ledgerCandidates(raster.bin, groups), makePitchSteps(groups), prims.vSegs, takenBoxes, inkStems));

  // ── 几个实心符头并成一块：按**谱内自举的 mask** 拆开 ─────────────────────
  //
  // 钢琴谱里二度、三度的和弦把两三个符头画得挨着（二度还错开在符干两侧），
  // 位图上并成一块，单头的尺寸闸一律判否——逐谱行摊开，钢琴两行漏得最狠
  //（宁静 P4.1 漏 122、破碎 P6.1 漏 213）。判据与搜索都限死在块内，见 `headmask.ts`。
  const masks = buildHeadMasks(raster.bin, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, lines.map((l) => l.y));
  // **拆和弦另用一张「符杠已擦」的图**，模板也在这张图上自举。
  //
  // 病因是量出来的（`scripts/raster-gap.mjs`）：漏掉的音里 **63.6% 焊在一团
  // 大于 4×3.2 格的墨里**——符杠 + 几根符干 + 几个头。在原图上给这种块打分，
  // 模板窗口上下那片「该有白」正压着符杠，spill 一扣分就没了。
  // 试过放松 spill（整体压到 0.5、或只算左右两侧）：**两次都把干净档打崩**
  //（85.09% → 78.63% / 75.71%），那一项正是拆块不出假头的关键，动不得。
  // 换图就两全：符杠不在图里，spill 照旧全额算。
  const noBeam = blobImage(nl, prims, unit, onGrid);
  const masksNB = buildHeadMasks(noBeam, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, lines.map((l) => l.y));
  const pitchGrid = makePitchGrid(groups, unit);
  const onLineY = (y: number) => lines.some((l) => Math.abs(l.y - y) <= unit.space * 0.25);
  const split: RasterSym[] = [];
  /** 被并块拆分认领的块（拍号那一段要用：粗体 4/4 一整块常被拆成两个黑头）。 */
  const splitIds = new Set<number>();
  /** 已经被认成**单个**符头、但要作废的那些（块里其实装着两三个头）。 */
  const dropHead = new Set<number>();
  const restTpl = (look.templates ?? []).filter((t) => t.smufl === "restQuarter" || t.smufl === "rest8th");
  if (masks.length) {
    for (const c of blobs) {
      if (claimed.has(c.id)) continue;
      let parts = splitHeadCluster(noBeam, c.bbox, c.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY);
      // **上下贴着的两个头**（三度和弦，一个头宽、两个头高、很实）：模板要头的上下是白的，
      // 贴着就各扣一截，两个都卡在门槛下（《来敬拜荣耀王》低音谱表的 E3/G♯3 得 0.45 / 0.42，门槛 0.46）。
      // 只对这种形状放到 0.40，而且要正好拆出两个、上下隔开 0.8 格以上；填充率上限也放到 `PAIR_FILL_MAX`。
      if (!parts.length && isStackedPair(c.bbox, c.area, unit)) {
        const p2 = splitHeadCluster(noBeam, c.bbox, c.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY, false, undefined, 2, PAIR_SCORE_MIN, PAIR_FILL_MAX);
        if (p2.length === 2 && Math.abs(p2[0].y - p2[1].y) >= unit.space * 0.8) parts = p2;
      }
      if (!parts.length) continue;
      claimed.add(c.id);
      splitIds.add(c.id);
      for (const b of parts) split.push({ box: b, code: "noteheadBlack" });
    }
    // **已经认成一个符头的块也要再看一眼**：漏掉的和弦成员多半就藏在这里
    // ——块被认成「一个符头」，实际装着两个（三度上下贴着、二度错开），
    // 而账本上它是「有主」的，无主报表里根本看不见（钢琴带内只剩碎点）。
    // 实测破碎钢琴右手纸上 1188 个符头，只检出 911。
    // 拆得出两个以上才作废原来那一个，拆不出就当没看过。
    for (const h of heads) {
      const b = h.comp.bbox;
      if (b.h < unit.space * 1.5 && b.w < unit.space * 1.9) continue; // 单头装得下，不动
      const parts = splitHeadCluster(noBeam, b, h.comp.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY);
      if (parts.length < 2) continue;
      dropHead.add(h.comp.id);
      for (const p of parts) split.push({ box: p, code: h.code === "noteheadBlack" ? "noteheadBlack" : h.code });
    }
  }

  // ── **光杆符干端头的无主墨**（`notehead.ts::headsOnBareStems`）───────────────
  //
  // 在拆块之后、字典之前：前面各路认下的头都算「挂上了」，剩下的无主碎片才轮得到这里。
  // 头盒取本页已认二分头的中位尺寸，标 `weak`（不进后面空心模板的样本）。
  {
    const headBoxes = [...heads.filter((h) => !dropHead.has(h.comp.id)).map((h) => h.box), ...stacked.map((q) => q.box), ...split.map((q) => q.box), ...restSyms.map((q) => q.box)];
    const free = blobs.filter((c) => !claimed.has(c.id) && inBand(c.bbox.y + c.bbox.h / 2)).map((c) => ({ id: c.id, box: c.bbox, area: c.area }));
    // 小节线：上下端正落在谱表首末线上
    const isBar = (q: LineSeg) => staffGeoms.some((g) => Math.abs(Math.min(q.y0, q.y1) - g.top) < unit.space * 0.4 && Math.abs(Math.max(q.y0, q.y1) - g.bottom) < unit.space * 0.4);
    const probes = probeBareStems(prims.vSegs, headBoxes, free, unit, isBar);
    const halves = [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked].filter((q) => q.code === "noteheadHalf" && !(q as { weak?: boolean }).weak);
    const med = (xs: number[]) => xs.sort((p, q) => p - q)[xs.length >> 1];
    const size = halves.length ? { w: med(halves.map((q) => q.box.w)), h: med(halves.map((q) => q.box.h)) } : { w: Math.round(unit.space * 1.3), h: Math.round(unit.space * 1.1) };
    for (const hd of headsOnBareStems(probes, unit, pitchGrid, size, raster.bin, (y) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick))) {
      for (const id of hd.ids) claimed.add(id);
      stacked.push(hd);
    }
    // 两根光杆干夹着一个头（两声部同音共用符头、干一上一下，头压线被切碎）
    const known = [...headBoxes, ...stacked.map((q) => q.box)];
    for (const hd of headsBetweenStemPairs(prims.vSegs, known, unit, pitchGrid, size, raster.bin, (y) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick), isBar)) stacked.push(hd);
  }
  // 弧与谱线围出的空当当成了空心头的内腔（`notehead.ts::archCavity`），剔掉，墨留给弧那一步；
  {
    const onStaffLine = (y: number) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick / 2);
    const arch = (b: Rect) => archCavity(raster.bin, b, onStaffLine);
    // 全音符**贴着符杠、又有干穿过**的也不是：两层十六分杠、干与头围出的白被收成全音符（万福泉源歌 m13）。
    // 全音符不带干，不会与杠挨着（上下 0.2 格、横向盖住半个头以上），盒里也不会有往外伸出一格的竖段。
    // 两条都要：粗圈的全音符自己就会被当成一截杠（我一生要赞美你，只看杠 −4.0）
    const tol = unit.space * 0.2;
    const byBeam = (b: Rect) =>
      prims.beams.some((q) => {
        const ov = Math.min(b.x + b.w, q.box.x + q.box.w) - Math.max(b.x, q.box.x);
        return ov >= b.w * 0.5 && q.box.y < b.y + b.h + tol && q.box.y + q.box.h > b.y - tol;
      }) &&
      stemInBox(b);
    /** 盒里有没有一列墨（去线图上）从盒里一直往上或往下伸出一格以上：干常与头、杠连成一块，竖段表里没有 */
    const stemInBox = (b: Rect): boolean => {
      const ink = (x: number, y: number) => y >= 0 && y < nl.h && !!nl.data[y * nl.w + x];
      const my = Math.round(b.y + b.h / 2);
      for (let x = Math.max(0, b.x); x < Math.min(nl.w, b.x + b.w); x++) {
        let t = my;
        let d = my;
        if (!ink(x, my)) continue;
        while (ink(x, t - 1)) t--;
        while (ink(x, d + 1)) d++;
        if (b.y - t >= unit.space || d - (b.y + b.h) >= unit.space) return true;
      }
      return false;
    };
    const fake = (q: { box: Rect; code: string }) => (q.code === "noteheadHalf" && arch(q.box)) || (q.code === "noteheadWhole" && byBeam(q.box));
    for (const h of heads) if (!dropHead.has(h.comp.id) && fake(h)) dropHead.add(h.comp.id);
    for (let i = stacked.length - 1; i >= 0; i--) if (fake(stacked[i])) stacked.splice(i, 1);
    // **盒里有干的「全音符」、过宽的实心头是带着加线的有干头**：网纹实心头看着像空心，连着右边伸出的一截加线盒宽到了 1.7 格，
    // 干落在盒中间、不在盒缘，找干那一步够不着（倚靠主永远膀臂 m3 C4、B♭3，干上还挂着 A♭4/G4，整串都没挂上干）。
    // 盒里有一列墨从头里往上/下伸出一格以上、又在盒宽的两成以内之外的，在那一列截盒（加线那一侧去掉），按截后的填充率重判空实
    for (const h of heads) {
      if (dropHead.has(h.comp.id) || !(h.code === "noteheadWhole" || (h.code === "noteheadBlack" && h.box.w >= unit.space * WIDE_BLACK))) continue;
      const b = h.box;
      const ink = (x: number, y: number) => y >= 0 && y < nl.h && !!nl.data[y * nl.w + x];
      const my = Math.round(b.y + b.h / 2);
      let sx = -1;
      for (let x = Math.max(0, b.x + Math.round(b.w * 0.2)); x < Math.min(nl.w, b.x + b.w - Math.round(b.w * 0.2)); x++) {
        if (!ink(x, my)) continue;
        let t = my;
        let d = my;
        while (ink(x, t - 1)) t--;
        while (ink(x, d + 1)) d++;
        if (b.y - t >= unit.space * 1.5 || d - (b.y + b.h) >= unit.space * 1.5) {
          sx = x;
          break;
        }
      }
      if (sx < 0) continue;
      // 干在盒右半：头在左，截到干右缘；在左半：头在右，从干左缘起
      let x0 = b.x;
      let x1 = b.x + b.w;
      if (sx >= b.x + b.w / 2) {
        let r = sx;
        while (ink(r + 1, my) && r + 1 < x1 && r - sx < 3) r++;
        x1 = r + 1;
      } else x0 = sx;
      const nb = { x: x0, y: b.y, w: x1 - x0, h: b.h };
      if (nb.w >= unit.space * 1.4 || nb.w < unit.space * 0.9) continue;
      let on = 0;
      for (let y = nb.y; y < nb.y + nb.h; y++) for (let x = nb.x; x < nb.x + nb.w; x++) if (raster.bin.data[y * raster.bin.w + x]) on++;
      h.box = nb;
      h.code = on / (nb.w * nb.h) >= 0.62 ? "noteheadBlack" : "noteheadHalf";
    }
    // **两根同向的干一左一右夹着的扁块是短杠**：两个十六分之间一格半长的杠没检出成杠原语，连着谱线被收成头
    //（有一位神 m2）。真头只在一侧有干；两侧的干还往同一头伸，就是杠
    const shortBeam = (b: Rect) => {
      if (b.h > unit.space * 0.8) return false;
      const tol = unit.space * 0.25;
      const dirAt = (x: number): number => {
        for (const v of prims.vSegs) {
          const vx = (v.x0 + v.x1) / 2;
          if (Math.abs(vx - x) > tol) continue;
          const y0 = Math.min(v.y0, v.y1);
          const y1 = Math.max(v.y0, v.y1);
          if (y0 >= b.y - tol && y0 <= b.y + b.h + tol && y1 - (b.y + b.h) >= unit.space * 1.5) return 1;
          if (y1 >= b.y - tol && y1 <= b.y + b.h + tol && b.y - y0 >= unit.space * 1.5) return -1;
        }
        return 0;
      };
      const l = dirAt(b.x);
      return l !== 0 && l === dirAt(b.x + b.w);
    };
    for (const h of heads) if (h.code === "noteheadBlack" && !dropHead.has(h.comp.id) && shortBeam(h.box)) dropHead.add(h.comp.id);
    const blackBoxes = [...heads.map((h) => h.box), ...split.map((q) => q.box)];
    for (let i = split.length - 1; i >= 0; i--) if (beamStump(split[i].box, blackBoxes)) split.splice(i, 1);
    // 内腔那一路的空心头/全音符**三成以上压在实心头上**的：升号右竖笔与两个贴着的实心头左缘围出的白
    //（千古保障歌伴奏 m7，G♯4/B4 前面读出一个 A4）。实心头是拆块那一路后认的，内腔那一路的「已认」挡不住
    const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const solids = [...heads.filter((h) => h.code === "noteheadBlack" && !dropHead.has(h.comp.id)).map((h) => h.box), ...split.map((q) => q.box)];
    for (let i = stacked.length - 1; i >= 0; i--) {
      const q = stacked[i];
      if (q.code !== "noteheadHalf" && q.code !== "noteheadWhole") continue;
      if (solids.reduce((a, b) => a + inter(q.box, b), 0) >= q.box.w * q.box.h * 0.3) stacked.splice(i, 1);
    }
    // 光杆干端头那一路收的实心头：干端正对着网纹粗杠时，杠身被收成头（耶和华是我的牧者 m11）
    for (let i = stacked.length - 1; i >= 0; i--) if (stacked[i].code === "noteheadBlack" && inBeamBody(stacked[i].box)) stacked.splice(i, 1);
  }
  // **空心头上下贴着一个实心头**（两声部三度叠放，一上一下各一根干）：实心头与空心头的轮廓连成一块，
  // 整块被空心那一路认领，实心那个没人收（圣哉三一歌伴奏 m14，G4 二分下面贴着 E♭4 四分）。
  // 空心头正上/正下一格处，头宽 × 头高七成的窗在原图上几乎全黑，窗左右两侧（非谱线行）是白的，就是实心头
  {
    const solidBoxes = [...heads.filter((h) => h.code === "noteheadBlack" && !dropHead.has(h.comp.id)).map((h) => h.box), ...split.map((q) => q.box), ...stacked.filter((q) => q.code === "noteheadBlack").map((q) => q.box)];
    const allBoxes = () => [...heads.filter((h) => !dropHead.has(h.comp.id)).map((h) => h.box), ...stacked.map((q) => q.box), ...split.map((q) => q.box)];
    const ink = (x: number, y: number) => x >= 0 && x < raster.bin.w && y >= 0 && y < raster.bin.h && !!raster.bin.data[y * raster.bin.w + x];
    const onLine = (y: number) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick);
    const bw = solidBoxes.length ? solidBoxes.map((b) => b.w).sort((p, q) => p - q)[solidBoxes.length >> 1] : unit.space * 1.25;
    const bh = solidBoxes.length ? solidBoxes.map((b) => b.h).sort((p, q) => p - q)[solidBoxes.length >> 1] : unit.space;
    const hollows = [...heads.filter((h) => h.code === "noteheadHalf" && !dropHead.has(h.comp.id)).map((h) => h.box), ...stacked.filter((q) => q.code === "noteheadHalf").map((q) => q.box)];
    for (const hb of hollows) {
      const cx = hb.x + hb.w / 2;
      const cy = hb.y + hb.h / 2;
      for (const dir of [-1, 1]) {
        const ny = cy + dir * unit.space;
        const win = { x: Math.round(cx - bw * 0.35), y: Math.round(ny - bh * 0.35), w: Math.round(bw * 0.7), h: Math.round(bh * 0.7) };
        if (allBoxes().some((b) => Math.abs(b.x + b.w / 2 - cx) < bw * 0.5 && Math.abs(b.y + b.h / 2 - ny) < bh * 0.5)) continue;
        let on = 0;
        for (let y = win.y; y < win.y + win.h; y++) for (let x = win.x; x < win.x + win.w; x++) if (ink(x, y)) on++;
        if (on < win.w * win.h * SOLID_NEIGHBOR_FILL) continue;
        // 窗左右各外 0.35 格那一列：非谱线行都要白（杠、字的横笔会往外伸）
        let side = 0;
        let rows = 0;
        for (let y = win.y; y < win.y + win.h; y++) {
          if (onLine(y)) continue;
          rows++;
          if (ink(Math.round(cx - bw / 2 - unit.space * 0.35), y) || ink(Math.round(cx + bw / 2 + unit.space * 0.35), y)) side++;
        }
        if (!rows || side > rows * 0.2) continue;
        split.push({ box: { x: Math.round(cx - bw / 2), y: Math.round(ny - bh / 2), w: Math.round(bw), h: Math.round(bh) }, code: "noteheadBlack" });
      }
    }
  }
  const syms: RasterSym[] = [
    ...heads.filter((h) => !dropHead.has(h.comp.id)).map((h) => ({ box: h.box, code: h.code })),
    ...stacked,
    ...split,
    ...restSyms,
  ];
  for (const h of heads) ledger.claim(h.box, `head:${h.code}`);
  for (const s0 of stacked) ledger.claim(s0.box, `stack:${s0.code}`);
  for (const s0 of split) ledger.claim(s0.box, "cluster:noteheadBlack");
  for (const s0 of restSyms) ledger.claim(s0.box, "rest:restHBar");
  const dictClaimed = new Set<number>();
  const metIds = new Set<number>();
  for (const c of blobs) {
    if (claimed.has(c.id)) continue;
    const code = look.lookup(binSig(nl, c.bbox), c.bbox.w / unit.space, c.bbox.h / unit.space);
    if (!code) continue;
    // **演奏记号贴着音符**：离所有谱表都四格半开外的「保持音」「断奏」是歌词字的横笔、点
    //（《赞美一神》「上」「军」底下那一横，吃掉之后那个字就从歌词行里缺了）
    // **复合音符字形先记下**：字典里 `metNote*` 这几类是「头 + 干（+ 尾）」连成一块的音符，
    // 按类名定时值会把带尾的八分当四分（《主我敬拜你》五处）。「头 + 干」那一路再试一次，
    // 摘得出头就换成它（符干进 SPage、符尾照常补），摘不出才留字典这一个（颂赞与尊贵的 A4 四分）。
    if (code.startsWith("metNote")) metIds.add(c.id);
    if (code.startsWith("artic") && !groups.some((g) => c.bbox.y + c.bbox.h > g.lines[0].y - unit.space * ARTIC_REACH && c.bbox.y < g.lines[4].y + unit.space * ARTIC_REACH)) continue; // 不记账：留给歌词
    dictClaimed.add(c.id);
    // **半/全休止要按位置验一道**：它的字形是个 1.27×0.51 格的小实心矩形，
    // 位图上这种碎块一大把（符杠断头、粗横笔的一截），实测宁静一首认出 43 个
    // 全部被采纳，而谱面上根本没那么多。它有一条硬位置：
    // 半休止**坐在中线上**、全休止**吊在上面一线下**——不贴着这两条线的不是它。
    if (isBarRest(code) && (!nearRestLine(c.bbox, staffLines, unit) || besideStem(c.bbox))) continue;
    syms.push({ box: c.bbox, code });
    ledger.claim(c.bbox, `dict:${code}`);
  }

  // **谱号兜底**：字典查不到的谱行，按位置补一个。
  //
  // 谱号是音高的基准，缺一行整行的音高就错；而它还是 `buildScore` 连跨系统谱行的
  // 主要凭据（`StaffToken` 的第一项就是行首谱号），缺了那一行会另起一个声部，
  // 一个声部因此碎成好几条——实测宁静一首 GT 5 条谱表、识别出 9 条，
  // 六成的音落在没配上的那几条里，准确率逐段漂到 0。
  // 字典能查到 85/100 行，位置自举能到 91/100，两者并起来才够。
  const bootStaves: BootStaff[] = groups.map((g) => ({
    left: Math.max(...g.lines.map((l) => l.left)),
    right: Math.min(...g.lines.map((l) => l.right)),
    lineYs: g.lines.map((l) => l.y),
  }));
  const boxes = blobs.map((c) => ({ x: c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h }));
  // 谱号**盖过字典**：字典按连通块查，谱号被自己的笔画切开时它只看到半截，
  // 尺寸恰好像另一种谱号（宁静 p7 的高音谱号上半截 2.76×2.65 与 Maestro 的
  // fClef 模板 2.84×3.34 只差一点），认成 fClef 比认不出来更糟。
  // 自举那一路先把 x 上重叠的碎块并回一个盒，再拿模板签名比——那才是完整的谱号。
  // **粘连的一串升号**不是谱号：粗体铅字本两个升号挤在一起连成一块（《耶和华是我的牧者》2.3×4.8 格），
  // 比低音谱号还高，被取作种子认成高音谱号，真谱号反倒丢了。它在原图上有三四根 2.5~3.4 格高的竖笔；
  // 44 首独唱谱的谱号候选里，高音谱号最多两根这么高的（另一根更高或更矮），没有第二种块是这样。
  const keyRun = (b: Rect) => b.h <= unit.space * KEY_RUN_MAX_H && verticalStrokes(raster.bin, b, unit.space * KEY_STROKE_H[0]).filter((s0) => s0.h <= unit.space * KEY_STROKE_H[1]).length >= 3;
  for (const h of bootstrapClefs(boxes, bootStaves, unit.space, look.templates ? { tpl: look.templates, sigOf: (b) => binSig(nl, b) } : undefined, keyRun)) {
    const b = h.box ?? blobs[h.index].bbox;
    // 落在这个盒里的字典结果作废（那是被切开的半截）。**按中心判**，不要求整个在盒里：
    // 低音谱号的圆头被当成全音符符头时，盒比谱号盒高出几个像素（《善牧恩慈歌》第二行
    // 出了个 G3 全音符；坚固保障高音谱号底下的圆球也被认成过两个黑符头），整盒判就漏了。
    // 谱号盒里不会有真音符。
    for (let i = syms.length - 1; i >= 0; i--) {
      const s0 = syms[i].box;
      const cx0 = s0.x + s0.w / 2;
      const cy0 = s0.y + s0.h / 2;
      if (cx0 >= b.x - 1 && cx0 <= b.x + b.w + 1 && cy0 >= b.y - 1 && cy0 <= b.y + b.h + 1) syms.splice(i, 1);
    }
    syms.push({ box: b, code: h.code });
    ledger.claim(b, `clef:${h.code}`);
  }
  // ── **行首谱号被切碎的行**：块图里只剩碎块（低分辨率页上低音谱号右半那道竖弧被抽成竖段抹掉，望十架扫描版 p10
  // 钢琴右手），`bootstrapClefs` 的尺寸闸一块都过不了，这一行没谱号、沿用默认的高音谱号，整行高十几级。
  // 一个谱号都没认出的行，在去线图上直接取行首窗口里的墨：从左缘往右 `CLEF_WIN_FROM` 格起，逐列有墨就串下去、
  // 空白过 0.4 格停；串出来的够谱号大小，按高度定种类（与 `bootstrapClefs` 兜底同口径）
  for (const g of groups) {
    const sp = unit.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    const top = g.lines[0].y;
    const bot = g.lines[4].y;
    if (syms.some((s0) => isClef(s0.code) && s0.box.y < bot && s0.box.y + s0.box.h > top && s0.box.x < left + sp * 4)) continue;
    const y0 = Math.max(0, Math.round(top - sp * 1.5));
    const y1 = Math.min(nl.h - 1, Math.round(bot + sp * 1.5));
    // 这一列算不算有墨：谱线行跳过，墨像素不到 0.35 格的不算（谱号的点、零星残渣）
    // 谱线不按线位跳（斜页上行首的线与整行平均、局部模型都会差出半格到一条，这一段去线图上谱线也常没去干净），
    // 按实测找：左端往右十格里有长过三格横墨的行是谱线行，上下各让一行
    const lineRow = new Set<number>();
    for (let y = y0; y <= y1; y++) {
      let run = 0;
      for (let x = Math.round(left); x < Math.min(nl.w, left + sp * 10); x++) {
        run = nl.data[y * nl.w + x] ? run + 1 : 0;
        if (run > sp * 3) { for (let d = -1; d <= 1; d++) lineRow.add(y + d); break; }
      }
    }
    const colInk = (x: number) => {
      let a = -1, b = -1, n = 0;
      // 「有没有墨」只数谱表带里的（方括号下端的弯钩伸进窗口，在末线下一格：你的信实广大第四行）；上下沿照整个窗口量
      for (let y = y0; y <= y1; y++)
        if (nl.data[y * nl.w + x] && !lineRow.has(y)) {
          if (a < 0) a = y;
          b = y;
          if (y >= top - sp * 0.5 && y <= bot + sp * 0.5) n++;
        }
      return n < sp * 0.35 ? null : [a, b];
    };
    let x = Math.round(left + sp * CLEF_WIN_FROM);
    const xEnd = Math.round(left + sp * 1.5);
    while (x < xEnd && !colInk(x)) x++;
    if (x >= xEnd) continue;
    const xs = x;
    let lastInk = x;
    let ya = Infinity, yb = -Infinity;
    for (; x < Math.min(nl.w, left + sp * 4); x++) {
      const c = colInk(x);
      if (c) { lastInk = x; ya = Math.min(ya, c[0]); yb = Math.max(yb, c[1]); }
      else if (x - lastInk > sp * 0.4) break;
    }
    const box = { x: xs, y: ya, w: lastInk - xs + 1, h: yb - ya + 1 };
    if (box.h < sp * 1.8 || box.w < sp * 0.8 || box.w > sp * 3.2) continue;
    const code: SmuflName = box.h >= sp * 3.8 ? "gClef" : "fClef";
    for (let i = syms.length - 1; i >= 0; i--) {
      const s1 = syms[i].box;
      const cx0 = s1.x + s1.w / 2;
      const cy0 = s1.y + s1.h / 2;
      if (cx0 >= box.x - 1 && cx0 <= box.x + box.w + 1 && cy0 >= box.y - 1 && cy0 <= box.y + box.h + 1) syms.splice(i, 1);
    }
    syms.push({ box, code });
    ledger.claim(box, `clef:${code}`);
  }
  // ── **行首谱号的种类按原图上的墨再定一次** ───────────────────────────────────
  //
  // 上面两路都按「并出来的盒有多高」分高低音，盒一不准就错：手写体刻谱的高音谱号中间那道直笔被抽成竖段，
  // 剩下的碎块只有 3.2 格高，认成低音谱号（是爱 p4 钢琴右手，整行低十二级）；低音谱号按去线图取墨那一路
  // 把方括号下端的弯钩串进来，盒高 5.6 格，认成高音谱号（同页男声行）。
  // 两种谱号在谱表上占的位置是死的：高音谱号从谱表上方一路探到下方，**顶线上方**与**第四、五线之间**都有它的墨；
  // 低音谱号只占上面三格，这两处都是空的。在带谱线的原图上、谱号盒的横向范围里逐行看有没有墨：
  // 两处都有的是高音谱号，两处都没有的是低音谱号，一有一无的（方括号上端的弯钩压在谱号上方、谱号断得只剩半截）不改。
  for (const g of groups) {
    const sp = unit.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    const s0 = syms.find((q) => isClef(q.code) && q.box.y < g.lines[4].y && q.box.y + q.box.h > g.lines[0].y && q.box.x < left + sp * 4);
    if (s0 && s0.code !== "gClef" && s0.code !== "fClef") continue;
    const bin0 = raster.bin;
    // 横向取**谱行左端的固定窗口**（让过系统线，到调号之前），不照第一步给的盒：那个盒可能只是压在系统线上的一块碎块
    //（望十架 p5 低音谱号的盒落在系统线上，竖线上下通着、两段里行行有墨，被改成高音），也可能只罩住谱号的一半
    const base = pastSysLine(bin0, g.lines.map((l) => l.y), left, sp);
    const xa = Math.max(0, Math.round(base + sp * CLEF_INK_X[0]));
    const xb = Math.min(bin0.w - 1, Math.round(base + sp * CLEF_INK_X[1]));
    // 行首这一段的线位按实测（斜页上与整行平均差得出半格）
    const ys = localLineModel(bin0, g.lines.map((l) => l.y), left, Math.min(bin0.w - 1, left + sp * 12), unit)((xa + xb) / 2);
    const rowInk = (y: number) => {
      if (y < 0 || y >= bin0.h) return false;
      for (let x = xa; x <= xb; x++) if (bin0.data[y * bin0.w + x]) return true;
      return false;
    };
    const frac = (ya: number, yb: number) => {
      let n = 0;
      let hit = 0;
      for (let y = Math.round(ya); y <= Math.round(yb); y++) {
        n++;
        if (rowInk(y)) hit++;
      }
      return n ? hit / n : 0;
    };
    const above = frac(ys[0] - sp * CLEF_INK_ABOVE[0], ys[0] - sp * CLEF_INK_ABOVE[1]);
    const low = frac(ys[3] + sp * CLEF_INK_LOW[0], ys[4] - sp * CLEF_INK_LOW[1]);
    // 低音谱号那一侧「第四五线之间」的门槛放到四成：粗线的低分辨率页上谱线的毛边探进这一格，量出 0.17~0.33
    //（烛光颂曲几十行低音谱号都落在这一段、判不下来；高音谱号这一格是满的）
    const code: SmuflName | null = above >= CLEF_INK_FULL && low >= CLEF_INK_FULL ? "gClef" : above <= CLEF_INK_NONE && low <= CLEF_INK_LOW_NONE ? "fClef" : null;
    if (!code || code === s0?.code) continue;
    if (!s0) {
      // **一个谱号都没认出的行按墨补一个**（谱号被系统线、括号粘住，两路都没出）。低音谱号要另有正面的证据——
      // 上面两格（一二线、二三线之间）都有墨；不然空着的行首也合「两处都没有墨」
      const upper = Math.min(frac(ys[0] + sp * CLEF_INK_LOW[0], ys[1] - sp * CLEF_INK_LOW[1]), frac(ys[1] + sp * CLEF_INK_LOW[0], ys[2] - sp * CLEF_INK_LOW[1]));
      if (code === "fClef" && upper < CLEF_INK_FULL) continue;
      const top = code === "gClef" ? ys[0] - sp * 1.5 : ys[0] - sp * 0.3;
      const bottom = code === "gClef" ? ys[4] + sp * 1.5 : ys[4];
      const box = { x: xa, y: Math.round(top), w: xb - xa, h: Math.round(bottom - top) };
      syms.push({ box, code });
      ledger.claim(box, `clef:${code}`);
      continue;
    }
    s0.code = code;
    // 盒照新种类收放：高音谱号上下沿着墨探出去（碎块别再被认成音符），低音谱号收回谱表里（弯钩不算它的）
    if (code === "gClef") {
      let ya = Math.round(ys[0]);
      while (ya > ys[0] - sp * 2 && (rowInk(ya - 1) || rowInk(ya - 2))) ya--;
      let yb = Math.round(ys[4]);
      while (yb < ys[4] + sp * 2 && (rowInk(yb + 1) || rowInk(yb + 2))) yb++;
      s0.box = { x: s0.box.x, y: Math.min(s0.box.y, ya), w: s0.box.w, h: Math.max(s0.box.y + s0.box.h, yb) - Math.min(s0.box.y, ya) };
    } else {
      const ya = Math.max(s0.box.y, Math.round(ys[0] - sp * 0.3));
      const yb = Math.min(s0.box.y + s0.box.h, Math.round(ys[4]));
      s0.box = { x: s0.box.x, y: ya, w: s0.box.w, h: yb - ya };
    }
    for (let i = syms.length - 1; i >= 0; i--) {
      if (syms[i] === s0) continue;
      const s1 = syms[i].box;
      const cx0 = s1.x + s1.w / 2;
      const cy0 = s1.y + s1.h / 2;
      if (cx0 >= s0.box.x - 1 && cx0 <= s0.box.x + s0.box.w + 1 && cy0 >= s0.box.y - 1 && cy0 <= s0.box.y + s0.box.h + 1) syms.splice(i, 1);
    }
    ledger.claim(s0.box, `clef:${code}`);
  }
  // ── **高音谱号底下挂着「8」的是低八度谱号**（男高音谱号，或带括号的「(8)」）──────────────
  //
  // 「8」紧贴在谱号尾巴底下，与尾巴连成一串墨：谱号下半那个弯的正下方（`CLEF_8_X`），从底线往下连着有墨的深度
  // 比普通高音谱号的尾巴深出大半格（`CLEF_8_DEPTH`）。歌词、段号离谱表远，与尾巴之间隔着空行，连不上。
  // 带括号的「(8)」是「男声唱时低八度」的可选记号，照低八度读（烛光颂曲首页人声行，用户定：与 GT 同口径）。
  for (const g of groups) {
    const sp = unit.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    const s0 = syms.find((q) => q.code === "gClef" && q.box.y < g.lines[4].y && q.box.y + q.box.h > g.lines[0].y && q.box.x < left + sp * 4);
    if (!s0) continue;
    const bin0 = raster.bin;
    const xa = Math.max(0, Math.round(left + sp * CLEF_8_X[0]));
    const xb = Math.min(bin0.w - 1, Math.round(left + sp * CLEF_8_X[1]));
    // 底线按行首实测：斜着没推平的谱行，整行的线位在行首能差出大半格（烛光颂曲 p5），照它量下探深度全是错的。
    // 模型底线上下一格半里，行首十格内有三格以上横墨的行是谱线行，取最低的那一条
    const bot0 = localLineModel(bin0, g.lines.map((l) => l.y), left, Math.min(bin0.w - 1, left + sp * 12), unit)((xa + xb) / 2)[4];
    // 一条都找不到的（行首被调号挤满）照模型的；最低的那条比模型高出半格以上的不量——那是第四线（底线在行首断了），照它量会多出一格
    let bot = bot0;
    for (let y = Math.round(bot0 + sp * 1.5); y >= Math.round(bot0 - sp); y--) {
      if (y < 0 || y >= bin0.h) continue;
      let run = 0;
      let long = false;
      for (let x = Math.round(left); x < Math.min(bin0.w, left + sp * 10) && !long; x++) {
        run = bin0.data[y * bin0.w + x] ? run + 1 : 0;
        long = run > sp * 3;
      }
      if (long) {
        bot = y;
        break;
      }
    }
    if (bot < bot0 - sp * 0.5) continue;
    const rowInk = (y: number) => {
      if (y < 0 || y >= bin0.h) return false;
      for (let x = xa; x <= xb; x++) if (bin0.data[y * bin0.w + x]) return true;
      return false;
    };
    // 从底线下半格起往下走，连着有墨（容一行断口）走到哪儿
    let end = Math.round(bot + sp * 0.5);
    for (let y = end, miss = 0; y < bin0.h && miss < 2; y++) {
      if (rowInk(y)) (end = y), (miss = 0);
      else miss++;
    }
    const depth = (end - bot) / sp;
    if (depth < CLEF_8_DEPTH[0] || depth > CLEF_8_DEPTH[1]) continue;
    // 行首这一段里别的高音谱号块（同一个谱号被认了两份的）一并改，下游取最左的那个
    for (const q of syms) if (q.code === "gClef" && q.box.y < g.lines[4].y && q.box.y + q.box.h > g.lines[0].y && q.box.x < left + sp * 4) q.code = "gClef8vb";
    if (s0.box.y + s0.box.h < end) s0.box = { ...s0.box, h: end - s0.box.y };
    ledger.claim(s0.box, "clef:gClef8vb");
  }
  /** 行中换谱号那一路验过的谱号（其余行中的谱号在建页前剔掉）。 */
  const midClefs = new Set<RasterSym>();
  // ── **行中换谱号**（小一号的谱号，印在小节中间或小节线前）──────────────────
  //
  // 钢琴右手下行时临时换成低音谱号（望十架 p9 m65，1.6×2.5 格，行首的是 2.25×3.5 格），
  // 行首那一路只在谱行开头四格里找，行中的一律没人认；音高仍按行首谱号读，整段差十二级。
  // 谱表里、离行首 `MID_CLEF_FROM` 格以外、尺寸像小一号谱号的块，拿本页行首的谱号比（宽高比、签名距离）；
  // 低音谱号还要右边 0.9 格内有小点（它那两个点）佐证。认出来的盒里、连同右边两个点，字典结果作废
  {
    // 模板取**本页行首认出的谱号**：字典里的谱号模板来自别的字体（低音谱号 2.84×3.34 格），
    // 这份谱的低音谱号窄高（2.25×3.49 格），缩放多少都配不上；本页自己的谱号与行中那个同一套字形
    //（望十架 p9：对本页低音谱号 75~96，对高音谱号 220 以上）
    const inkFrac = (r: Rect) => {
      let n = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) n += nl.data[y * nl.w + x];
      return n / Math.max(1, r.w * r.h);
    };
    const pageClefs = syms.filter((s0) => isClef(s0.code)).map((s0) => ({ code: s0.code, aspect: s0.box.w / s0.box.h, sig: binSig(nl, s0.box), fill: inkFrac(s0.box) }));
    const sp = unit.space;
    for (const c of blobs) {
      if (claimed.has(c.id)) continue;
      const b = c.bbox;
      const cy = b.y + b.h / 2;
      const g = groups.find((q) => cy > q.lines[0].y - sp && cy < q.lines[4].y + sp);
      if (!g) continue;
      if (b.x < Math.max(...g.lines.map((l) => l.left)) + sp * MID_CLEF_FROM) continue;
      const w = b.w / sp;
      const h = b.h / sp;
      // 位置也要像：高音谱号上下都探出谱表（尾巴探到末线下 0.7 格以外，八分和弦的头只到半格）；低音谱号落在谱表里、顶端贴着首线
      //（加线上的两个头连着干和尾，签名离高音谱号也近：你的信实广大 m?，整个在谱表上方）
      const top = g.lines[0].y;
      const bot = g.lines[4].y;
      const fShape = w >= 1.2 && w <= 2.0 && h >= 2.0 && h <= 3.0 && Math.abs(b.y - top) <= sp * 0.5 && b.y + b.h <= bot + sp * 0.5;
      const gShape = w >= 1.3 && w <= 2.4 && h >= 3.6 && h <= 5.8 && b.y <= top - sp * MID_CLEF_G_TOP && b.y + b.h >= bot + sp * 0.7;
      if (!fShape && !gShape) continue;
      const sig = binSig(nl, b);
      let hit: { smufl: SmuflName; dist: number } | null = null;
      // 墨占比也要像：谱号是细笔画；实心头连着干和尾的和弦墨实得多（万古磐石歌 m? 八分二度）
      const fill = inkFrac(b);
      for (const pc of pageClefs) {
        if (Math.abs(pc.aspect - b.w / b.h) > MID_CLEF_ASPECT || Math.abs(pc.fill - fill) > MID_CLEF_FILL) continue;
        const d = sigDistance(pc.sig, sig);
        if (d <= MID_CLEF_DIST && (!hit || d < hit.dist)) hit = { smufl: pc.code as SmuflName, dist: d };
      }
      if (!hit || (hit.smufl === "fClef") !== fShape) continue;
      const dotZone = { x: b.x + b.w, y: b.y, w: Math.round(sp * 0.9), h: Math.round(b.h * 0.6) };
      if (hit.smufl === "fClef") {
        const dots = blobs.filter((d) => d !== c && d.bbox.w <= sp * 0.5 && d.bbox.h <= sp * 0.5 && d.bbox.x >= dotZone.x - 2 && d.bbox.x <= dotZone.x + dotZone.w && d.bbox.y + d.bbox.h / 2 >= dotZone.y && d.bbox.y + d.bbox.h / 2 <= dotZone.y + dotZone.h);
        if (!dots.length) continue;
        for (const d of dots) claimed.add(d.id);
      }
      const zone = { x: b.x, y: b.y, w: b.w + (hit.smufl === "fClef" ? dotZone.w : 0), h: b.h };
      for (let i = syms.length - 1; i >= 0; i--) {
        const s0 = syms[i].box;
        const cx0 = s0.x + s0.w / 2;
        const cy0 = s0.y + s0.h / 2;
        if (cx0 >= zone.x - 1 && cx0 <= zone.x + zone.w + 1 && cy0 >= zone.y - 1 && cy0 <= zone.y + zone.h + 1) syms.splice(i, 1);
      }
      claimed.add(c.id);
      const cs: RasterSym = { box: b, code: hit.smufl };
      midClefs.add(cs);
      syms.push(cs);
      ledger.claim(zone, `clef:${hit.smufl}`);
    }
  }

  // ── **琶音记号**（和弦左边的竖波浪线）────────────────────────────────────
  //
  // 去线图上它是细长的块（宽半格上下、高两格半以上；贯穿谱表的被去谱线切开，只有谱表外那几截够高）。与符干、小节线、括号的分别是**左右摆**：
  // 逐行墨的中心一格一个周期地来回摆，直线（斜的也算）的中心是一条直线。逐行取墨的中心、减掉首尾连线，
  // 摆幅（九成分位减一成分位）要过 `ARP_SWING` 格；带半像素回差地数过零，每格的次数落在 `ARP_RATE` 里、间隔还要匀。
  // 只看逐行墨宽不行——直线上一像素的毛边也粗细交替（破碎干净版一页数出二十来条）。
  // 认出来的块里字典结果作废（波峰常被读成附点、休止的碎块），挂到和弦上的事在音符建好之后做。
  const arpeggios: Rect[] = [];
  for (const c of blobs) {
    const b = { ...c.bbox };
    const sp = unit.space;
    if (b.w > sp * ARP_W || b.h < sp * ARP_H) continue;
    if (!groups.some((q) => b.y < q.lines[4].y + sp * 2 && b.y + b.h > q.lines[0].y - sp * 2)) continue;
    const cs: number[] = [];
    let wide = 0;
    for (let y = b.y; y < b.y + b.h; y++) {
      let lo = -1;
      let hi = -1;
      for (let x = b.x; x < b.x + b.w; x++)
        if (nl.data[y * nl.w + x]) {
          if (lo < 0) lo = x;
          hi = x;
        }
      if (lo < 0) continue;
      cs.push((lo + hi) / 2);
      if (hi - lo + 1 > sp * ARP_STROKE) wide++;
    }
    if (cs.length < b.h * 0.8 || wide > cs.length * 0.1) continue;
    const res = cs.map((v, k) => v - (cs[0] + ((cs[cs.length - 1] - cs[0]) * k) / (cs.length - 1)));
    const sorted = [...res].sort((p, q) => p - q);
    const swing = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
    const mid = sorted[sorted.length >> 1];
    // 过零的位置：相邻两次之间隔半个周期
    const zs: number[] = [];
    let side = 0;
    res.forEach((v, k) => {
      const s1 = v > mid + 0.5 ? 1 : v < mid - 0.5 ? -1 : 0;
      if (s1 && side && s1 !== side) zs.push(k);
      if (s1) side = s1;
    });
    if (claimed.has(c.id)) continue;
    // 每格过零一次半到三次多（四分休止只拐两三道弯，直线上的毛边抖得更密）
    const rate = zs.length / (b.h / sp);
    if (swing < Math.max(1.5, sp * ARP_SWING) || rate < ARP_RATE[0] || rate > ARP_RATE[1]) continue;
    // 波浪是匀的：相邻两次过零的间隔在半格上下，六成以上的间隔离中位数不过六成（手写体刻谱的波浪不齐，是爱量得 5~12 像素）
    const gaps = zs.slice(1).map((z, k) => z - zs[k]).sort((p, q) => p - q);
    const gm = gaps[gaps.length >> 1] ?? 0;
    if (gaps.length < 3 || gm < sp * 0.25 || gm > sp * 0.75 || gaps.filter((g0) => Math.abs(g0 - gm) <= gm * 0.6).length < gaps.length * 0.6) continue;
    // 盒往上下接：谱表里的那几截被去谱线切成小段、不够高，没进上面的筛选。在带谱线的原图上沿这一竖条往两头走，
    // 连着有墨（容半格的断口）走到哪儿算到哪儿
    {
      const bin0 = raster.bin;
      const rowInk = (y: number) => {
        if (y < 0 || y >= bin0.h) return false;
        for (let x = b.x - 1; x <= b.x + b.w; x++) if (bin0.data[y * bin0.w + x]) return true;
        return false;
      };
      let top = b.y;
      for (let y = b.y - 1, miss = 0; y >= 0 && miss < sp * 0.5; y--) {
        if (rowInk(y)) (top = y), (miss = 0);
        else miss++;
      }
      let bottom = b.y + b.h - 1;
      for (let y = bottom + 1, miss = 0; y < bin0.h && miss < sp * 0.5; y++) {
        if (rowInk(y)) (bottom = y), (miss = 0);
        else miss++;
      }
      // 同一条波浪线的另一截已经收过了
      if (arpeggios.some((q) => Math.abs(q.x - b.x) <= sp && q.y <= bottom && q.y + q.h >= top)) continue;
      b.y = top;
      b.h = bottom - top + 1;
    }
    arpeggios.push(b);
    claimed.add(c.id);
    for (let i = syms.length - 1; i >= 0; i--) {
      const s0 = syms[i].box;
      const cx0 = s0.x + s0.w / 2;
      const cy0 = s0.y + s0.h / 2;
      if (cx0 >= b.x - 1 && cx0 <= b.x + b.w + 1 && cy0 >= b.y - 1 && cy0 <= b.y + b.h + 1) syms.splice(i, 1);
    }
    ledger.claim(b, "arpeggio");
  }

  // **调号按竖笔补认升号**（`sharpsByStrokes`）：全页至少两行、且过半的行数出同样多个升号才采信，
  // 采信后每行数出的升号盖掉那一段里别的认法（被读成降号串、假符头的碎块）。44 首里它从不多数
  // （降号曲全是 0，升号曲都不超过 GT，粘连升号的《耶和华是我的牧者》每行 2 个），少数由 `shareKeySignature` 补齐。
  {
    const clefOf = (g: (typeof groups)[number]) =>
      syms.find((s0) => isClef(s0.code) && s0.box.y + s0.box.h / 2 > g.lines[0].y && s0.box.y + s0.box.h / 2 < g.lines[4].y && s0.box.x < Math.max(...g.lines.map((l) => l.left)) + unit.space * 4);
    const found = groups.map((g) => {
      const c = clefOf(g);
      return c ? sharpsByStrokes(raster.bin, g.lines.map((l) => l.y), c.box, unit.space) : [];
    });
    const tally = new Map<number, number>();
    for (const f of found) if (f.length) tally.set(f.length, (tally.get(f.length) ?? 0) + 1);
    const [k, n] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    if (k && n >= 2 && n * 2 >= groups.length)
      for (const f of found) {
        if (!f.length) continue;
        const span: Rect = { x: f[0].x, y: Math.min(...f.map((b) => b.y)), w: f[f.length - 1].x + f[f.length - 1].w - f[0].x, h: 0 };
        span.h = Math.max(...f.map((b) => b.y + b.h)) - span.y;
        for (let i = syms.length - 1; i >= 0; i--) {
          const b = syms[i].box;
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          if (!isClef(syms[i].code) && cx >= span.x && cx <= span.x + span.w && cy >= span.y && cy <= span.y + span.h) syms.splice(i, 1);
        }
        for (const b of f) {
          syms.push({ box: b, code: "accidentalSharp" });
          ledger.claim(b, "key:accidentalSharp");
        }
        for (const c of blobs) {
          const cx = c.bbox.x + c.bbox.w / 2;
          const cy = c.bbox.y + c.bbox.h / 2;
          if (cx >= span.x && cx <= span.x + span.w && cy >= span.y && cy <= span.y + span.h) claimed.add(c.id);
        }
      }
  }

  // ── 碎块并起来再查一次字典 ────────────────────────────────────────────────
  //
  // 谱号那一路证明了这条：符号常被自己的笔画切开（中央竖笔、两道横笔被当成原语抽走），
  // 按连通块查字典就只看到半截。休止符与升降号同理——它们也压在谱线上、也有细笔画。
  // 把**x 上重叠、上下又贴着**的未识别块并起来（谱线间距的四成以内算贴着），
  // 并完再查一次；查得到才认。x 分开的不并（那是相邻的两个符号）。
  const unmatched = blobs.filter((c) => !claimed.has(c.id) && !dictClaimed.has(c.id));
  const merged = new Set<number>();
  for (const a of unmatched) {
    if (merged.has(a.id)) continue;
    let box = { ...a.bbox };
    const group = [a.id];
    for (let again = true; again; ) {
      again = false;
      for (const b of unmatched) {
        if (group.includes(b.id) || merged.has(b.id)) continue;
        const r = b.bbox;
        if (r.x > box.x + box.w || r.x + r.w < box.x) continue; // x 不重叠
        const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
        if (gap > unit.space * 0.4) continue;
        const x0 = Math.min(box.x, r.x);
        const y0 = Math.min(box.y, r.y);
        box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
        group.push(b.id);
        again = true;
      }
    }
    if (group.length < 2) continue;
    // 字典认不出就**按性质判一次符头**：空心符头骑在谱线上时会被去谱线切成两截，
    // 两截都不成符头、字典里也没有二分符头的类（见 `judgeHeadBox`）。
    const code = look.lookup(binSig(nl, box), box.w / unit.space, box.h / unit.space) ?? judgeHeadBox(nl, box, unit, prims.vSegs, inBand);
    if (!code) continue;
    // 位置闸与字典那一路一样：并出来的扁块也要贴着第二、三线
    if (isBarRest(code) && (!nearRestLine(box, staffLines, unit) || besideStem(box))) continue;
    if (code === "noteheadBlack" && beamStump(box, syms.filter((s0) => /^notehead/.test(s0.code)).map((s0) => s0.box))) continue;
    // 并出来的空心头要有**封闭的内腔**（去线图上）：全音符下沿与谱线之间的空当也像个腔，谱线一去就通到外面了
    //（我灵镇静 m8 加一线上 C4 全音符底下拼出一个 A3）。窗口只外扩 2 像素，别把上面那个全音符自己的内腔框进来
    if (code === "noteheadHalf" && enclosedWhite(nl, { left: box.x, right: box.x + box.w, top: box.y, bottom: box.y + box.h }, unit.space, 2) < box.w * box.h * MERGE_HOLLOW_CAVITY) continue;
    for (const id of group) merged.add(id);
    syms.push({ box, code });
    ledger.claim(box, `merge:${code}`);
  }

  // ── 升降号：把**被抽走的那道竖笔**并回来 ─────────────────────────────────
  //
  // 降号是「一根细长的竖笔 + 底下一个小肚子」。竖笔沿途两侧都空着，
  // `isolated` 判它是原语、`findPrimitives` 把它抽成竖段，`blobImage` 随后照段抹墨
  // ——剩下的只有那个 0.58×1.05 格的小肚子，字典当然认不出
  //（实测破碎 p4 y=314 那行的调号降号就是这么丢的：竖段 x=113 y[285,324]，
  // 块只剩 [117,304]）。升号与还原号同理，只是它们有两道竖笔、丢得没这么彻底。
  //
  // 这一条是升降号的**主要漏因**：破碎 105 行谱有 31 行的调号一个升降号都没认出来，
  // 全谱升降号块 148 个，而调号加临时记号至少要 200 个。
  //
  // 还原号同理，只是它有**两道**竖笔：左边那道与横笔连成块、右边那道被抽走
  //（实测破碎 p10 那个还原号剩下 [582,1005] 0.53×2.34 格的块 + 竖段 x=593）。
  //
  // 修法照「碎块并回再查」那一条，只是这回要并的是**竖段**：块的左边或右边紧挨着
  // 一条纵向搭得上的竖段，就把两者的盒并起来重查一次字典。
  // 并完要把那条竖段**从 `vSegs` 里摘掉**——留着的话 `findStems` 会把它当符干，
  // `findBarlines` 会把它当小节线。
  const usedSegs = new Set<LineSeg>();
  // 调号位置：同一行谱的谱号右缘往右四格以内
  const clefSyms = syms.filter((s) => s.code === "gClef" || s.code === "fClef" || s.code === "cClef");
  const atKeySlot = (b: Rect) =>
    clefSyms.some((c) => b.y < c.box.y + c.box.h && b.y + b.h > c.box.y && b.x >= c.box.x + c.box.w - 1 && b.x <= c.box.x + c.box.w + unit.space * 4);
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    const bw = b.w / unit.space;
    const bh = b.h / unit.space;
    // 窄块才试：太宽的是符头或别的东西，太小的是噪点
    if (bw < 0.25 || bw > 1.3 || bh < 0.4 || bh > 3.4) continue;
    for (const v of prims.vSegs) {
      if (usedSegs.has(v)) continue;
      const vx = (v.x0 + v.x1) / 2;
      const vTop = Math.min(v.y0, v.y1);
      const vBot = Math.max(v.y0, v.y1);
      // 竖笔要**紧贴着块**（左边或右边都算）、纵向要与块搭上
      if (vx < b.x - unit.space * 0.5 || vx > b.x + b.w + unit.space * 0.5) continue;
      if (vBot < b.y || vTop > b.y + b.h) continue;
      // 一端扎进实心头（横向落在头盒里、端点在头盒上下沿之间）的是符干，块是它的符尾：
      // 低分辨率页上干加八分尾拼成一个还原号（万福泉源歌 m4，G4/E♭4 带尾和弦的干被摘走）
      const tl = Math.max(1, unit.lineThick);
      if (syms.some((h) => h.code === "noteheadBlack" && vx >= h.box.x - tl && vx <= h.box.x + h.box.w + tl && ((vBot >= h.box.y && vBot <= h.box.y + h.box.h) || (vTop >= h.box.y && vTop <= h.box.y + h.box.h)))) continue;
      const x0 = Math.min(b.x, Math.round(vx - v.maxLw / 2));
      const y0 = Math.min(b.y, Math.round(vTop));
      const box = {
        x: x0,
        y: y0,
        w: Math.max(b.x + b.w, Math.round(vx + v.maxLw / 2)) - x0,
        h: Math.max(b.y + b.h, Math.round(vBot)) - y0,
      };
      const w1 = box.w / unit.space;
      const h1 = box.h / unit.space;
      if (w1 < 0.4 || w1 > 1.7 || h1 < 1.5 || h1 > 3.6) continue;
      const sig = binSig(nl, box);
      let code = look.lookup(sig, w1, h1);
      if (!code || !isAccidental(code)) {
        // 字典不认就拿模板验。**只收降号**：它才是「一根竖笔 + 一个小肚子」、
        // 竖笔一被抽走就什么都不剩的那一种；升号与还原号各有两道竖笔，
        // 丢不干净，靠这条路补反而是过检（实测放开三种，破碎的还原号
        // 从 17 个涨到 70 个，而 GT 只有 24 个）。
        const m = matchTemplate(sig, w1, h1, look.templates ?? [], atKeySlot(box) ? KEY_ACCID_TEMPLATE_DIST : ACCID_TEMPLATE_DIST);
        code = m && isAccidental(m.smufl) ? m.smufl : null;
      }
      if (!code) continue;
      syms.push({ box, code });
      ledger.claim(box, `accid:${code}`);
      merged.add(c.id);
      usedSegs.add(v);
      break;
    }
  }

  // **两道横笔压在谱线上的还原号**：横笔与谱线重合，去线后只剩两根竖笔、切成几块碎墨，
  // 字典与上面那条都认不出（《向主唱新歌》高音谱表的 F♮ 三处，读成调号里的 F♯）。
  // 按结构认：从无主的窄碎块出发，在去线图上沿列量出整根竖笔；右边 0.35~0.8 格处另有一根，
  // 左高右低错开、纵向搭上一格以上，两根之间在**原图**上有两道横墨（整行从左笔连到右笔），
  // 各比谱线厚、相隔 0.6 格以上。
  // 字典认领过的窄块也当种子：竖笔单独一块时字典会把它认成 `wiggleTrill` 之类
  /** 从一根竖笔（`sx` 列、纵向 `seed`）起认还原号：右边或左边 `NAT_GAP` 格处另有一根，左高右低错开，
   *  两根之间在原图上有两道比谱线厚的横墨。认出来返回盒。 */
  const natFrom = (sx: number, seed: [number, number]): Rect | null => {
    let hit: Rect | null = null;
    for (const side of [1, -1]) {
      for (let dx = Math.round(unit.space * NAT_GAP[0]); dx <= unit.space * NAT_GAP[1] && !hit; dx++) {
        const ox = sx + side * dx;
        const [lx, rx] = side > 0 ? [sx, ox] : [ox, sx];
        // 搭档那根：在种子的纵向范围里找一行有墨的地方起量
        let other: [number, number] | null = null;
        for (let y = seed[0]; y <= seed[1] && !other; y++) if (nl.data[y * nl.w + ox]) other = vRunAt(nl, ox, y);
        if (!other) continue;
        const [L, R] = side > 0 ? [seed, other] : [other, seed];
        if (L[1] - L[0] < unit.space * 1.5 || R[1] - R[0] < unit.space * 1.5 || L[1] - L[0] > unit.space * 3.4 || R[1] - R[0] > unit.space * 3.4) continue;
        if (R[0] - L[0] < unit.space * 0.3 || R[1] - L[1] < unit.space * 0.3) continue;
        const ya = Math.max(L[0], R[0]);
        const yb = Math.min(L[1], R[1]);
        if (yb - ya < unit.space) continue;
        const bars = crossRuns(raster.bin, lx, rx, Math.round(ya - unit.space * 0.3), Math.round(yb + unit.space * 0.3));
        const thick = bars.filter((r) => r[1] - r[0] + 1 >= Math.max(unit.lineThick + 2, unit.space * 0.25));
        if (thick.length < 2 || thick[thick.length - 1][0] - thick[0][1] < unit.space * 0.6) continue;
        const x0 = lx - Math.round(unit.lineThick);
        hit = { x: x0, y: L[0], w: rx + Math.round(unit.lineThick) - x0 + 1, h: R[1] - L[0] + 1 };
      }
      if (hit) break;
    }
    return hit;
  };
  // 宽到一格、带着两截横笔的无主块也当种子，从它最左那几列的竖笔起量：加线上的音的还原号，右竖笔下半截
  // 顺着加线连进了符头那团墨，剩下的左竖笔连着两截横笔成一块（Holy, Holy, Holy m14 女低 C♮4，0.83×2.8 格）
  for (const c of blobs) {
    if (claimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.h < unit.space * 0.3) continue;
    let sx = b.x + Math.floor(b.w / 2);
    let seed = b.w <= unit.space * 0.4 ? vRunAt(nl, sx, b.y + Math.floor(b.h / 2)) : null;
    if (b.w > unit.space * 0.4) {
      if (b.w > unit.space * 1.0 || b.h < unit.space * 1.5) continue;
      for (let x = b.x; x < b.x + Math.min(b.w, unit.space * 0.3) && !seed; x++) {
        for (let y = b.y; y < b.y + b.h; y++) {
          if (!nl.data[y * nl.w + x]) continue;
          const r = vRunAt(nl, x, y);
          if (r && r[1] - r[0] >= unit.space * 1.5) {
            seed = r;
            sx = x + 1;
          }
          break;
        }
      }
    }
    if (!seed) continue;
    const hit = natFrom(sx, seed);
    if (!hit) continue;
    const box = hit;
    // 盒里的碎符号（竖笔认成的装饰音之类）换掉；与盒大片相交的别的符号在，就不认
    const inner = syms.filter((s0) => overlapFrac(s0.box, box) > 0.8 && s0.box.w * s0.box.h < box.w * box.h * 0.5);
    if (syms.some((s0) => !inner.includes(s0) && overlapFrac(box, s0.box) > 0.3)) continue;
    for (const s0 of inner) syms.splice(syms.indexOf(s0), 1);
    syms.push({ box, code: "accidentalNatural" });
    ledger.claim(box, "accid:accidentalNatural");
    for (const c2 of blobs) if (!claimed.has(c2.id) && overlapFrac(c2.bbox, box) > 0.8) merged.add(c2.id);
    for (const v of prims.vSegs) if ((v.x0 + v.x1) / 2 >= box.x && (v.x0 + v.x1) / 2 <= box.x + box.w && Math.min(v.y0, v.y1) >= box.y - 2 && Math.max(v.y0, v.y1) <= box.y + box.h + 2) usedSegs.add(v);
  }

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
    const g = groups.find((g0) => cy > g0.lines[0].y - unit.space && cy < g0.lines[4].y + unit.space);
    if (!g) return Infinity;
    const inRow = (r: Rect) => r.y + r.h / 2 > g.lines[0].y - unit.space * 2 && r.y + r.h / 2 < g.lines[4].y + unit.space * 2;
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
  const sysBoxes = groupByLeftInk(raster.bin, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y, left: Math.max(...g.lines.map((l) => l.left)) })), unit);
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
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    if (w < QREST_W[0] || w > QREST_W[1] || h < QREST_H[0] || h > QREST_H[1]) continue;
    const fill = c.area / Math.max(1, b.w * b.h);
    if (fill < QREST_FILL[0] || fill > QREST_FILL[1]) continue;
    // 位置：谱表中线上下，或**让位到谱表外**（闭合谱一行两个声部，女低的休止压到第一线下方、男高的抬到第五线上方，
    // 新编赞美诗 215 奇妙能力歌的四分休止心在第一线下 1.7 格）——头心离外线 `QREST_OFF` 格以内都收
    const mid = midOfStaff(b, lines, unit);
    if (!mid && !(offStaffRest(b, lines, unit) && inGrandStaff(b))) continue;
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
    if (!midOfStaff(b, lines, unit) && !(offStaffRest(b, lines, unit) && inGrandStaff(b, true))) continue;
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

  // ── 拍号：位置自举 + 模板验 ────────────────────────────────────────────────
  //
  // 字典里**一个拍号类都没有**（`rasterglyphs.json` 4144 个类未定名，拍号一个没定），
  // 所以拍号的识别率是 0——全语料一个都没认出来。这批曲子恰好都是 4/4、
  // 下游按缺省当 4/4 办，所以没露馅；换一首 3/4 的就整首错。
  //
  // 拍号数字还被自己的笔画切开（「4」的竖笔横向游程短，被当竖笔画抽走），
  // 按连通块查必然是碎的——实测宁静 p1 那个 4/4 切成 1.60×2.76 与 1.60×1.71
  // 两个**互相重叠**的盒。所以照谱号那条路走：先按位置圈出候选、
  // 把碎块并回上下两个盒，再拿模板签名验。
  /** 拍号数字模板，外加由「6」转 180° 派生的「9」（Maestro 那本没出现过 9，字形上 9 就是倒过来的 6）。 */
  const digitTpl = (look.templates ?? []).filter((t) => timeSigDigit(t.smufl) >= 0);
  digitTpl.push(...digitTpl.filter((t) => t.smufl === "timeSig6").map((t) => ({ ...t, smufl: "timeSig9" as SmuflName, sig: t.sig.slice().reverse() })));
  /** 在 `allowed` 这几个数字里取签名最近的；尺寸只卡高度（宽度随字体差得多，签名按长边归一、不拉伸）。 */
  const digitOf = (b: Rect, allowed: readonly number[], maxDist: number): RasterSym | null => {
    const h = b.h / unit.space;
    const sig = binSig(nl, b);
    let best: { code: SmuflName; d: number } | null = null;
    let bestNot9: { code: SmuflName; d: number } | null = null;
    for (const t of digitTpl) {
      if (!allowed.includes(timeSigDigit(t.smufl)) || Math.abs(t.h - h) > 0.2 + 0.12 * t.h) continue;
      const d = sigDistance(t.sig, sig);
      if (d > maxDist) continue;
      if (!best || d < best.d) best = { code: t.smufl, d };
      if (t.smufl !== "timeSig9" && (!bestNot9 || d < bestNot9.d)) bestNot9 = { code: t.smufl, d };
    }
    // 派生的「9」不是真字形，要**明显**近过别的数字才采信：万古磐石歌的铅字「3」上头带个球，
    // 到 9 是 179、到 3 是 186，几乎打平；晨曦破晓真的 9 是 139 对 240。
    if (best?.code === "timeSig9" && bestNot9 && bestNot9.d - best.d < NINE_MARGIN) best = bestNot9;
    return best && { box: b, code: best.code };
  };
  // **第二趟：照同页已认出的拍号补缺**（Audiveris `TimeColumn`：一个系统里每行谱的拍号必须同值）。
  // 缺拍号的那行，允许已被符头那几路认领的块（休止、和弦字母除外）进候选（Audiveris 先认行首段、再找符头；
  // 我们的顺序反过来，粗体 4/4 一整块被并块拆分那一路拆成两个黑头——《欢然颂主》高音谱表），
  // 但只认与已认出的拍号**同值、x 对齐**（1.5 格内）的那一对；认中了，盒里的假头随下面「盖过字典」一并删掉。
  const timeStrips: TimeStrip[] = [];
  /** 行首每个「两个数字摞起来」形状的候选列（谱号那一列除外）与 OCR 读出的上下半，留给 `shareTimeSignature` 按系统互证。 */
  const timeCols: TimeColumn[] = [];
  const clefBoxes = syms.filter((s0) => isClef(s0.code)).map((s0) => s0.box);
  const timeFound: { x: number; codes: string }[] = [];
  const timeDone = new Set<(typeof groups)[number]>();
  // **C 拍号被当成全音符**：粗体 C 上半截的球头垂下来碰到第三线，围出一块白，被内腔那一路收成全音符
  //（有一位神第一行，C 读成 C♯5 全音符）。这样的列 C 模板的距离上限放宽一档（那个 C 到模板 225）：
  // 两格多高、骑在中线上、里头又压着个全音符的，行首只有 C 拍号
  const wholes = syms.filter((s0) => s0.code === "noteheadWhole").map((s0) => s0.box);
  for (const pass of [0, 1])
  for (const g of groups) {
    if (timeDone.has(g) || (pass === 1 && !timeFound.length)) continue;
    const left = Math.max(...g.lines.map((l) => l.left));
    const mid = g.lines[2].y;
    const top = g.lines[0].y;
    const bottom = g.lines[4].y;
    // 行首那一段：谱号 + 调号之后、第一个音符之前。放到十四格——
    // 七个升降号的调号就占了八格多。
    // **字典认走的也进来**（谱号与调号升降号除外）：C 拍号与字典里那个
    // `csymParensRightTall`（大括号）形状相近，认错了照样要能被拍号盖过。
    const cands = blobs.filter((c) => {
      const b = c.bbox;
      // 并块拆分认领的块第一趟就进来：4/4 两个数字连成一块，被拆成两个黑头（齐来崇拜第一行：本页头模板一变就拆了）。
      // 数字那一路按位置切上下两半、各配模板，真的两个叠头配不上数字
      if ((claimed.has(c.id) && !(pass === 1 && !restIds.has(c.id) && !harmonyIds.has(c.id) && !titleIds.has(c.id)) && !splitIds.has(c.id)) || merged.has(c.id)) return false;
      const dc = dictClaimed.has(c.id) ? look.lookup(binSig(nl, b), b.w / unit.space, b.h / unit.space) : null;
      if (dc && (isClef(dc) || isAccidental(dc))) return false;
      if (b.x < left || b.x > left + unit.space * 14) return false;
      if (pass === 1 && !timeFound.some((t) => Math.abs(t.x - b.x) <= unit.space * 1.5)) return false;
      return b.y + b.h > top - unit.space * 0.5 && b.y < bottom + unit.space * 0.5;
    });
    // 按 x 聚成**若干列**，逐列去试。
    //
    // 只试最左那一列不行：行首除了拍号还有谱号被切下来的碎块、调号里字典没认出的
    // 升降号，最左那一列往往是它们（实测你要等候 p2 最左是谱号的下半截，
    // 真正的 C 拍号在它右边两列开外）。
    //
    // 容一点缝（0.4 格）：C 拍号被自己的笔画切成好几块，块与块之间差几个像素
    //（实测破碎 p2 那个 C 切成 0.76×2.16 / 0.64×0.93 / 0.58×0.12 / 0.41×0.58）。
    cands.sort((a, b) => a.bbox.x - b.bbox.x);
    const cols: { box: Rect; ids: number[]; ink?: boolean }[] = [];
    for (const c of cands) {
      const b = c.bbox;
      const last = cols[cols.length - 1];
      if (last && b.x <= last.box.x + last.box.w + unit.space * 0.4) {
        const x0 = Math.min(last.box.x, b.x);
        const y0 = Math.min(last.box.y, b.y);
        last.box = { x: x0, y: y0, w: Math.max(last.box.x + last.box.w, b.x + b.w) - x0, h: Math.max(last.box.y + last.box.h, b.y + b.h) - y0 };
        last.ids.push(c.id);
      } else cols.push({ box: { ...b }, ids: [c.id] });
    }
    // **墨列**（只给 OCR 用）：粗体小号数字的笔画整根被当竖段抽走，连通块里只剩几粒碎屑，上面按块聚不出列
    //（新编赞美诗 151、121：行首 4/4 一块都没有）。回去线图上按列投影找：谱号右边、谱表带里一段连续有墨的 x，
    // 宽 0.8~2.5 格、上下正好撑满谱表的，就是「两个数字摞起来」的样子。与按块聚出的列重叠的不重复出
    if (pass === 0) {
      const clefR = Math.max(left, ...clefBoxes.filter((cb) => cb.y < bottom && cb.y + cb.h > top && cb.x < left + unit.space * 6).map((cb) => cb.x + cb.w));
      const yA = Math.max(0, Math.round(top - unit.space * 0.25)), yB = Math.min(nl.h, Math.round(bottom + unit.space * 0.25));
      const xEnd = Math.min(nl.w, Math.round(left + unit.space * 14));
      const inkAt = (x: number) => {
        let n = 0;
        for (let y = yA; y < yB; y++) if (nl.data[y * nl.w + x]) n++;
        return n >= 2;
      };
      const gap = Math.max(2, Math.round(unit.space * 0.2));
      let x0 = -1, lastInk = -1;
      const flush = () => {
        if (x0 < 0) return;
        const b: Rect = { x: x0, y: yA, w: lastInk - x0 + 1, h: yB - yA };
        if (b.w >= unit.space * 0.8 && b.w <= unit.space * 2.5 && !cols.some((c) => Math.min(c.box.x + c.box.w, b.x + b.w) - Math.max(c.box.x, b.x) > b.w * 0.5)) cols.push({ box: b, ids: [], ink: true });
        x0 = -1;
      };
      for (let x = Math.round(clefR) + 1; x < xEnd; x++) {
        if (inkAt(x)) {
          if (x0 < 0) x0 = x;
          lastInk = x;
        } else if (x0 >= 0 && x - lastInk > gap) flush();
      }
      flush();
      cols.sort((a, b) => a.box.x - b.box.x);
    }
    /** 这一段 x 上的墨是不是「上下正好撑满谱表」：顶到第五线、底到第一线，又不探出谱表（带干的和弦、谱号都探出去）。 */
    const fillsStaff = (b: Rect): boolean => {
      const xa = Math.max(0, Math.round(b.x)), xb = Math.min(nl.w, Math.round(b.x + b.w));
      const ya = Math.max(0, Math.round(top - unit.space * 1.5)), yb = Math.min(nl.h, Math.round(bottom + unit.space * 1.5));
      let lo = -1, hi = -1;
      for (let y = ya; y < yb; y++) {
        let n = 0;
        for (let x = xa; x < xb; x++) if (nl.data[y * nl.w + x]) n++;
        if (n < 2) continue;
        if (lo < 0) lo = y;
        hi = y;
      }
      return lo >= top - unit.space * 0.4 && hi <= bottom + unit.space * 0.4 && lo <= top + unit.space * 0.6 && hi >= bottom - unit.space * 0.6;
    };
    for (const col of cols) {
      const box = col.box;
      if (box.w > unit.space * 2.5 || box.w < unit.space * 0.8) continue;
      // 距离上限比通用的 `TEMPLATE_DIST`（90）松：拍号被**五条谱线横穿**，
      // 去线在它身上切了好几道口子，退化比谱号重（实测宁静那个 4/4 上下两半
      // 到 `timeSig4` 是 104 与 95，破碎那个 C 到 `timeSigCommon` 是 168）。
      // 松得起，是因为位置先验很硬：行首那一列、骑在中线上、高约两格或四格。
      const tpl = look.templates ?? [];
      const hits: RasterSym[] = [];
      let fromOcr = false;
      if (box.h < unit.space * 3) {
        if (col.ink) continue;
        // **C 拍号**（`timeSigCommon` / `timeSigCutCommon`）是一个块、骑在中线上
        if (Math.abs(box.y + box.h / 2 - mid) > unit.space * 0.8) continue;

        const whole = box.h >= unit.space * 1.8 && wholes.some((w) => w.x >= box.x - 1 && w.x + w.w <= box.x + box.w + 1 && w.y >= box.y - 1 && w.y + w.h <= box.y + box.h + 1);
        // 放宽时只在 C 模板里挑：别的模板（和弦字母、休止）在宽上限下反倒更近
        const cTpl = tpl.filter((t) => t.smufl === "timeSigCommon" || t.smufl === "timeSigCutCommon");
        const m = whole ? matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, cTpl, TIME_C_WHOLE_DIST) : matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, tpl, TIME_TEMPLATE_DIST);
        if (m && (m.smufl === "timeSigCommon" || m.smufl === "timeSigCutCommon")) hits.push({ box, code: m.smufl });
      } else {
        // **两个数字摞起来**：按中线几何切开，不按碎块自己的位置分上下半
        // ——碎块的盒互相重叠（实测上半那块高 2.76 格、已经探进下半的地界）。
        // 拍号的版式是死的：上面那个坐在第五线到第三线之间、下面那个第三线到第一线。
        // 上下各截到谱表外 0.25 格：数字夹在第一线与第五线之间，列里并进来的谱表外杂点
        // 会把半边拉高、过不了数字的高度闸（《耶和华是我的牧者》第一行顶上多出 0.43 格）
        const y0 = Math.max(box.y, Math.round(top - unit.space * 0.25));
        const y1 = Math.min(box.y + box.h, Math.round(bottom + unit.space * 0.25));
        const up: Rect = { x: box.x, y: y0, w: box.w, h: Math.round(mid) - y0 };
        const dn: Rect = { x: box.x, y: Math.round(mid), w: box.w, h: y1 - Math.round(mid) };
        if (up.h < unit.space || dn.h < unit.space) continue;
        // **数字先问 OCR**：两半各出一条，按内容指纹查缓存；上下都读成合法数字才采信，否则走下面模板那一路
        // 谱号那一列不问：低音谱号的碎块（弧 + 两点）会被读成「7:」「2」之类
        // 也不问没撑满谱表、或探出谱表的列：带干的和弦读得出「5」「2」（新编赞美诗 121 头一个八分和弦读成 5/2）
        const inClef = clefBoxes.some((cb) => cb.y < bottom && cb.y + cb.h > top && box.x + box.w / 2 < cb.x + cb.w) || !fillsStaff(box);
        const sUp = timeStripOf(nl, up, groups.indexOf(g), "num");
        const sDn = timeStripOf(nl, dn, groups.indexOf(g), "den");
        const oNum = inClef ? null : timeDigit(opts.timeOcr?.get(timeKey(sUp)), "num");
        const oDen = inClef ? null : timeDigit(opts.timeOcr?.get(timeKey(sDn)), "den");
        if (pass === 0 && !inClef) {
          timeStrips.push(sUp, sDn);
          timeCols.push({ box, mid, num: oNum, den: oDen });
        }
        if (oNum !== null && oDen !== null) {
          // 两位数（12、16）拆成左右两个数字符号：下游按 x 从左到右拼数（`timeSignatures`）
          const digitsOf = (n: number, b: Rect): RasterSym[] => {
            const ds = String(n).split("");
            const w = b.w / ds.length;
            return ds.map((d, k) => ({ box: { x: Math.round(b.x + k * w), y: b.y, w: Math.round(w), h: b.h }, code: `timeSig${d}` as SmuflName }));
          };
          hits.push(...digitsOf(oNum, up), ...digitsOf(oDen, dn));
          fromOcr = true;
        } else if (!col.ink) {
        const two = [up, dn].map((b) => {
          const m = matchTemplate(binSig(nl, b), b.w / unit.space, b.h / unit.space, tpl, TIME_TEMPLATE_DIST);
          return m && timeSigDigit(m.smufl) >= 0 ? { box: b, code: m.smufl } : null;
        });
        // **分子至少是 2**：1/x 的拍号谱面上不出现，出现只说明两个数字都是硬凑上的
        // ——旧字体（《善牧恩慈歌》那种铅字本）的「4」只有 1.1 格宽，过不了 `timeSig4`
        // 模板的宽度闸，却以 141/166 的距离过了放宽到 180 的 `timeSig1`，整首读成 1/1。
        // 拒掉之后下游按缺省拍号办，比错成 1/1 强得多（1/1 让每个四分音符都「满小节」）。
        // 分母同理只认 2、4、8：齐来谢主歌放大后分母「4」到 `timeSig1` 170、到 `timeSig4` 181，读成 4/1。
        if (two[0] && two[1] && timeSigDigit(two[0].code) >= 2 && (DEN_DIGITS as readonly number[]).includes(timeSigDigit(two[1].code))) hits.push(two[0], two[1]);
        else {
          // **按角色限定再认一次**：别的书的数字字形与 Maestro 差得远（万古磐石歌、齐来谢主歌的
          // 铅字「3」「4」只有 1.1~1.2 格宽，模板 1.5~1.6 格），过不了尺寸闸，最近的又总是
          // 一根竖笔的 `timeSig1`。可位置先验已经钉死了这两格里是什么：分子是 2~9，
          // 分母只有 2、4、8。于是只在合法的数字里取最近、尺寸只卡高度；分子认得出才认分母，
          // 分母再放宽一档（被第二、四线横穿，去线切掉的最多）。
          const num = digitOf(up, NUM_DIGITS, TIME_NUM_DIST);
          const den = num ? digitOf(dn, DEN_DIGITS, TIME_DEN_DIST) : null;
          if (num && den) hits.push(num, den);
        }
        // 模板认出了一对、OCR 只读出其中一半的：那一半听 OCR 的（分母 8 读成 4 是模板最常见的错，OCR 的「8」靠得住）
        if (hits.length === 2 && oNum !== null && oNum < 10) hits[0] = { box: hits[0].box, code: `timeSig${oNum}` as SmuflName };
        if (hits.length === 2 && oDen !== null && oDen < 10) hits[1] = { box: hits[1].box, code: `timeSig${oDen}` as SmuflName };
        }
      }
      if (!hits.length) continue;
      // **分子读成 4 时拿分母复核**：分母那个 4 是同一本同一字号的真 4，分子真是 4 就该长得像它。
      // 模板法分不开的两首（万福泉源歌放大后的「3」到 `timeSig4` 200、到 `timeSig3` 225；
      // 来敬拜荣耀王粗体铅字「3」181 对 244）：分子到分母 232~244，退而求其次的数字 225~256；
      // 真 4/4 那 60 多行分子到分母至多 196、别的数字至少 277。两条都过才改认。
      if (!fromOcr && hits.length === 2 && hits[0].code === "timeSig4" && hits[1].code === "timeSig4" && sigDistance(binSig(nl, hits[0].box), binSig(nl, hits[1].box)) > TIME_SELF_DIST) {
        const alt = digitOf(hits[0].box, NUM_DIGITS.filter((k) => k !== 4), TIME_ALT_DIST);
        if (alt) hits[0] = alt;
      }
      if (pass === 1 && !timeFound.some((t) => t.codes === hits.map((h0) => h0.code).join("/") && Math.abs(t.x - box.x) <= unit.space * 1.5)) continue;
      // 拍号**盖过字典**（与谱号同一条）：落在它盒里的字典结果作废，那是被切开的碎块
      for (let k = syms.length - 1; k >= 0; k--) {
        const s0 = syms[k].box;
        if (s0.x >= box.x - 1 && s0.x + s0.w <= box.x + box.w + 1 && s0.y >= box.y - 1 && s0.y + s0.h <= box.y + box.h + 1) syms.splice(k, 1);
      }
      syms.push(...hits);
      for (const hit of hits) ledger.claim(hit.box, `time:${hit.code}`);
      for (const id of col.ids) merged.add(id);
      timeFound.push({ x: box.x, codes: hits.map((h0) => h0.code).join("/") });
      timeDone.add(g);
      break; // 一行谱只有一个拍号
    }
  }

  // ── 调号：紧跟谱号的升降号，**位置兜底** ─────────────────────────────────
  //
  // 字典与模板都认不出的调号升降号，按「谱号右边第一串又窄又高的块」补认。
  // 病例是铅字本的细长升号（《善牧恩慈歌》0.82×2.36 格，Maestro 模板 0.95×2.73）：
  // 到 `accidentalSharp` 的签名距离 130，通用的 90 那道闸过不去，调号整个丢了，
  // 全曲的 F 都成了还原（调号错一个，测评按「移调」整首平移，音符档掉到两成）。
  // 松到拍号那一档是因为位置先验够硬：紧贴谱号、一串挨着、骑在谱表上。
  // 形状另卡**窄**（宽不过高的 0.5）：拍号数字 0.67 以上，挡得住。
  // 只吃谁都没认领的块（外加字典认成调号区不该有之物的块，见下）；字典已经认出的前几个不动，
  // 从它们的串尾接着往右认。
  //
  // 另一种丢法是**升号被符头那一路先吃了**：粗体升号的两道横笔又粗又斜，
  // 去掉竖笔后就是两个上下叠着的「黑符头」（《赞美一神》低音谱表两行都是：
  // 升号骑在 F3 线上，出了一对 F#3/A3 和弦）。认回来的判据：
  //   - 谱号右缘 2 格内（低音谱号的两点不在谱号盒里，要多让半格）、x 差不到 0.3 格、上下隔 0.7~1.3 格的两个黑符头；
  //   - 原图上盒里有**两根**竖笔（相隔 0.4 格以上）贯穿上下两头，且没有哪一列伸出一格以上
  //     ——三度和弦的符干往一头伸 2.5 格以上；升号的竖笔只探出半格（右竖笔下端还短，不能要求两头都伸）；
  //   - 只被认成**一个**头的（第二行低音谱表）：竖笔上下都要探出 0.3 格以上、最长 1.6 格。
  const keySp = unit.space;
  const keyBin = raster.bin;
  function sharpAsHeads(ss: RasterSym[], edge: number, onStaff: (r: Rect) => boolean): { heads: RasterSym[]; box: Rect } | null {
    const sp = keySp;
    // 从左往右找：串是逐个往右认的，先配上右边那个会跳过左边那个（齐来称颂低音谱表第二、三个升号）
    // 左缘可以伸进前面的盒里 0.3 格：有一位神 m18 行首的 F♯ 左缘压进高音谱号的盒 4px（谱号尾巴往右甩），
    // 被拆成两个头，从谱号右缘起算就漏了。两根贯通竖笔那道闸（`sharpBox`）挡得住谱号自己的碎块
    const hs = ss.filter((s0) => s0.code === "noteheadBlack" && onStaff(s0.box) && s0.box.x >= edge - sp * 0.3 && s0.box.x < edge + sp * 2).sort((a, b) => a.box.x - b.box.x);
    // 候选：上下叠着的一对，或者单独一个（另一道横笔没被认成头）
    const sets: RasterSym[][] = [];
    for (const a of hs)
      for (const b of hs) {
        const dy = (b.box.y - a.box.y) / sp;
        if (dy >= 0.7 && dy <= 1.3 && Math.abs(a.box.x - b.box.x) <= sp * 0.3) sets.push([a, b]);
      }
    for (const a of hs) sets.push([a]);
    for (const set of sets) {
      const box = sharpBox(set);
      if (box) return { heads: set, box };
    }
    return null;
  }
  /** 这一对（或一个）黑符头其实是升号吗：原图上有两根竖笔贯穿，且探出不多。是就返回升号的盒。 */
  /** 两个头的盒里，上下贯穿的竖笔之间有没有**不贯穿**的列（升号两根竖笔中间是空的）。 */
  function hasGapColumn(set: RasterSym[]): boolean {
    const bin = keyBin;
    const x0 = Math.min(...set.map((s0) => s0.box.x));
    const x1 = Math.max(...set.map((s0) => s0.box.x + s0.box.w));
    const u0 = set[0].box.y;
    const u1 = set[set.length - 1].box.y + set[set.length - 1].box.h - 1;
    const full: boolean[] = [];
    // 竖笔一两像素的抖动算连着（同 `sharpBox`）：斜着印的升号两根竖笔从上到下横移一两像素，严格按「整列是墨」一根竖笔都数不出来，
    // 升号就留成一对黑头（新编赞美诗 275 m4 的 F♯4 前多出 E♭4、G4 两个音）。两根竖笔之间那几列放宽后照样不满。
    const at = (x: number, y: number) => x >= 0 && x < bin.w && !!bin.data[y * bin.w + x];
    for (let x = x0; x < x1; x++) {
      let ok = true;
      for (let y = u0; y <= u1 && ok; y++) ok = at(x, y) || at(x - 1, y) || at(x + 1, y);
      full.push(ok);
    }
    const first = full.indexOf(true);
    const last = full.lastIndexOf(true);
    return first >= 0 && full.slice(first, last + 1).some((f) => !f);
  }
  function sharpBox(set: RasterSym[]): Rect | null {
    const sp = keySp;
    const bin = keyBin;
    const at = (x: number, y: number) => y >= 0 && y < bin.h && !!bin.data[y * bin.w + x];
    const x0 = Math.min(...set.map((s0) => s0.box.x));
    const x1 = Math.max(...set.map((s0) => s0.box.x + s0.box.w));
    const u0 = set[0].box.y;
    const u1 = set[set.length - 1].box.y + set[set.length - 1].box.h - 1;
    const cols: number[] = [];
    let y0 = u0;
    let y1 = u1;
    let over = 0;
    let up = 0;
    let down = 0;
    for (let x = x0; x < x1; x++) {
      let ok = true;
      // 竖笔一两像素的抖动算连着
      for (let y = u0; y <= u1 && ok; y++) ok = at(x, y) || at(x - 1, y) || at(x + 1, y);
      if (!ok) continue;
      cols.push(x);
      let t = u0;
      let d = u1;
      while (at(x, t - 1)) t--;
      while (at(x, d + 1)) d++;
      over = Math.max(over, u0 - t, d - u1);
      up = Math.max(up, u0 - t);
      down = Math.max(down, d - u1);
      y0 = Math.min(y0, t);
      y1 = Math.max(y1, d);
    }
    if (!cols.length || cols[cols.length - 1] - cols[0] < sp * 0.4) return null;
    // 一对：竖笔探出不过一格。单个：另一道横笔还挂在竖笔上，下探可到一格半，
    // 但**上下都要探出去**——带干的音只往一头伸，而且一伸就是两格半以上
    if (set.length === 2 ? over > sp : over > sp * 1.6 || up < sp * 0.3 || down < sp * 0.3) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + 1 };
  }
  for (const g of groups) {
    const left = Math.max(...g.lines.map((l) => l.left));
    const top = g.lines[0].y;
    const bottom = g.lines[4].y;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.x < left + unit.space * 4 && s0.box.y < bottom && s0.box.y + s0.box.h > top);
    if (!clef) continue;
    let edge = clef.box.x + clef.box.w;
    const onStaff = (r: Rect) => r.y < bottom && r.y + r.h > top;
    // 字典已经认出的那一串先走完，**从串尾接着认**：字典只认出前几个、后面断了的也要补。
    // 病例《圣哉三一歌伴奏》三个降号：前两个的竖笔被当成线段抹掉、只剩肚子，字典认得；
    // 第三个的竖笔没抹、与肚子断成两块，竖笔被字典认成 wiggleTrill——以前见字典有就不插手，
    // 整首少一个降号，A 全成了还原。
    let fromDict = false;
    // 相接的容差放到**半格**：错开排的窄升号，后一个的左缘常在前一个右缘左边（《来敬拜荣耀王》
    // 三个升号，C# 左缘在 F# 右缘左边 5px，接不上，A 大调读成 D 大调，整曲音级错一个五度）。
    // 只在**前面已有调号记号**时放宽：从谱号右缘起算也放宽的话，会把谱号自己的碎块收进来（《主使我喜乐》−2.3）
    const overlapTol = unit.space * KEY_OVERLAP;
    const taken = new Set<RasterSym>();
    for (;;) {
      const nx = syms
        .filter((s0) => !taken.has(s0) && isAccidental(s0.code) && onStaff(s0.box) && s0.box.x >= edge - (taken.size ? overlapTol : 1) && s0.box.x < edge + unit.space * KEY_GAP)
        .sort((a, b) => a.box.x - b.box.x)[0];
      if (!nx) break;
      taken.add(nx);
      edge = Math.max(edge, nx.box.x + nx.box.w);
      fromDict = true;
    }
    // 字典认成**调号区不该有的东西**（演奏记号之类）的块也算候选：那多半是升降号断出来的半截。
    // 谱号、升降号、拍号、符头、休止照旧不碰。
    const dictSym = new Map<number, RasterSym>();
    for (const c of blobs) {
      if (!dictClaimed.has(c.id) || claimed.has(c.id) || merged.has(c.id)) continue;
      const s0 = syms.find((x) => x.box === c.bbox);
      if (s0 && !isClef(s0.code) && !isAccidental(s0.code) && timeSigDigit(s0.code) < 0 && !/^(notehead|rest)/.test(s0.code)) dictSym.set(c.id, s0);
    }
    const cand = blobs
      .filter((c) => !claimed.has(c.id) && (!dictClaimed.has(c.id) || dictSym.has(c.id)) && !merged.has(c.id))
      .filter((c) => onStaff(c.bbox))
      .sort((a, b) => a.bbox.x - b.bbox.x);
    const union = (a: Rect, b: Rect): Rect => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    };
    // 串里**逐个**往右认，每一步先看「被当成符头的升号」、再看普通块：齐来称颂的低音谱表
    // 三个升号，第一个是普通块、后两个各被认成一对黑符头，只认一路就断在第二个上。
    // 第一个记号离谱号右缘放到两格：低音谱号的两点在谱号盒外，实测 1.77 格。
    // 字典已认出的串尾也算「前一个」：后面的记号按它比大小、比签名
    const lastDict = [...taken].sort((a, b) => b.box.x - a.box.x)[0];
    let prevKey: { box: Rect; code: SmuflName; sig: Uint8Array } | null =
      lastDict && (lastDict.code === "accidentalFlat" || lastDict.code === "accidentalSharp") ? { box: lastDict.box, code: lastDict.code, sig: binSig(nl, lastDict.box) } : null;
    for (let first = !fromDict; ; first = false) {
      const gap = unit.space * (first ? KEY_GAP_FIRST : KEY_GAP);
      const pair = sharpAsHeads(syms, edge, onStaff);
      if (pair && pair.box.x <= edge + gap) {
        for (const s0 of pair.heads) syms.splice(syms.indexOf(s0), 1);
        syms.push({ box: pair.box, code: "accidentalSharp" });
        ledger.claim(pair.box, "key:accidentalSharp");
        edge = pair.box.x + pair.box.w;
        continue;
      }
      let took = false;
      const keyTpl = (look.templates ?? []).filter((t) => t.smufl === "accidentalSharp" || t.smufl === "accidentalFlat");
      // 过得了尺寸闸与模板才算；宽另卡 1.2 格：齐来称颂的拍号「3」与「4」的上半连成一块（1.37×3.2 格），
      // 紧挨着最后一个升号，宽高比过得了 0.5 那道闸，被当成第四个升号吃掉，拍号就没了
      const asKey = (b: Rect) => {
        const w = b.w / unit.space;
        const h = b.h / unit.space;
        // 下限 1.6：小号升号（2 格上下）去线后被削到 1.76 格（《来敬拜荣耀王》的 C#）；
        // 宽高比放到 0.6：同一本的 F# 1.02×1.97 格（0.52）
        if (h < 1.6 || h > 3.4 || w < 0.4 || w > h * 0.6 || w > 1.2) return null;
        // 串里后面的记号不会比前一个矮一截：拍号 C 的上半弧（2.2 格）紧挨着最后一个升号（3.0 格），
        // 模板距离 156 过得了拍号那道宽闸，被当成第五个升号（《主使我喜乐》四个升号认成五个）
        if (prevKey && b.h < prevKey.box.h * 0.8) return null;
        const sig = binSig(nl, b);
        const m = matchTemplate(sig, w, h, keyTpl, TIME_TEMPLATE_DIST);
        if (m) return m;
        // 模板尺寸闸没过、却与**前一个已认出的记号**一般大、签名也像：粗体铅字本的升号比模板高
        // （3.3 格，模板 2.7 格的容差到 3.2），同一串里前面的认得、这一个卡在闸上
        if (prevKey && Math.abs(b.h - prevKey.box.h) <= prevKey.box.h * 0.15 && Math.abs(b.w - prevKey.box.w) <= prevKey.box.w * 0.3) {
          const d = sigDistance(sig, prevKey.sig);
          if (d <= KEY_SELF_DIST) return { smufl: prevKey.code, dist: d };
        }
        // 还认不出、又**比模板小一号**的：数竖笔。小号升号（2 格，模板 2.7 格）过不了模板的尺寸闸，
        // 可去线之前的图上两根竖笔都在（《来敬拜荣耀王》A 大调三个升号）。只认升号：两根通高的竖笔，
        // 降号、拍号数字、带干的符头都凑不出两根。
        if (h < 2.5) {
          const pad = Math.round(unit.space * 0.3);
          if (tallStrokes(raster.bin, { x: b.x - pad, y: b.y, w: b.w + pad * 2, h: b.h }) === 2) return { smufl: "accidentalSharp" as SmuflName, dist: KEY_SELF_DIST };
        }
        return null;
      };
      for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        const b = c.bbox;
        if (b.x < edge - (fromDict || prevKey ? overlapTol : 1) || merged.has(c.id)) continue;
        if (b.x > edge + gap) break; // 串断了
        if (b.w / unit.space < 0.6 && b.h / unit.space < 0.6) continue; // 噪点、谱号的小尾巴：跳过，不算断串
        let box = b;
        let used = [c];
        let m = asKey(b);
        // 单块不像，就与**右边紧挨着、上下有交叠**的下一块并起来再认（降号断成竖笔与肚子两块）
        if (!m) {
          const c2 = cand.slice(i + 1).find((d) => !merged.has(d.id) && d.bbox.x >= b.x && d.bbox.x <= b.x + b.w + unit.space * 0.3);
          if (c2 && c2.bbox.y < b.y + b.h && c2.bbox.y + c2.bbox.h > b.y) {
            box = union(b, c2.bbox);
            used = [c, c2];
            m = asKey(box);
          }
        }
        // 还不像，就把**块左缘往上伸的竖笔**接回来：降号的竖笔上半截去线后断开、没进块，
        // 剩下的肚子连着下半截竖笔只有 1.9 格高（高举主大能第四行低音谱表，读成 B♭2 头 + 干）
        if (!m) {
          // 原图（带谱线）上，块左缘三成格内的列从块顶往上还连着墨的，量到最高处
          const bin = raster.bin;
          let top = b.y;
          for (let x = b.x; x <= Math.min(bin.w - 1, b.x + Math.round(unit.space * 0.3)); x++) {
            let y = b.y;
            while (y > 0 && bin.data[(y - 1) * bin.w + x]) y--;
            if (bin.data[b.y * bin.w + x]) top = Math.min(top, y);
          }
          if (b.y - top >= unit.space * 0.3) {
            const u = { x: b.x, y: top, w: b.w, h: b.y + b.h - top };
            const m2 = asKey(u);
            if (m2 && m2.smufl === "accidentalFlat") {
              box = u;
              m = m2;
            }
          }
        }
        // 还不像，就把**同一列**（一格宽）里的碎块整列并起来：细笔画的降号被谱线切成上下几截，
        // 截与截之间空着去掉的那条线（所信有根基：B♭ 断在中线上下、隔 0.46 格，D♭ 碎成四块）
        if (!m) {
          // 左缘都要在头一块左缘半格以内：再往右就是下一个记号的碎块了（所信有根基第一行 A♭ 右边贴着 D♭ 的竖笔）
          const col = cand.filter((d) => !merged.has(d.id) && Math.abs(d.bbox.x - b.x) <= unit.space * 0.4 && d.bbox.x + d.bbox.w <= b.x + unit.space);
          // 并出来的要在**去线之前**的图上有一根贯通八成高的竖笔（升降号都有）：
          // C 拍号被谱线切成几块，并起来尺寸像降号，可它的弧贯通不了（我一生要赞美你）
          if (col.length >= 2) {
            const u = col.map((d) => d.bbox).reduce(union);
            const m2 = longestVRun(raster.bin, u) >= u.h * 0.8 ? asKey(u) : null;
            if (m2) {
              box = u;
              used = col;
              m = m2;
            }
          }
        }
        // 还不像、又比前一个记号宽出一截、高出一截：是**两个斜叠着粘在一起**的同类记号
        //（所信有根基低音谱表，E♭ 的肚子贴上 A♭ 的竖笔顶，连成 1.18×3.21 格一块；两个错开一高一低，竖着切不开）。
        // 只认前一个已认出的那一类，两半的盒按中段墨最少的那一列粗分（下游只数个数）
        if (!m && prevKey && b.w >= prevKey.box.w * 1.3 && b.w <= prevKey.box.w * 2.0 && b.h >= prevKey.box.h * 1.1 && b.h <= prevKey.box.h * 1.9) {
          const halves = splitAt(nl, b) ?? [
            { x: b.x, y: b.y, w: Math.round(b.w / 2), h: b.h },
            { x: b.x + Math.round(b.w / 2), y: b.y, w: b.w - Math.round(b.w / 2), h: b.h },
          ];
          const d = dictSym.get(c.id);
          if (d) syms.splice(syms.indexOf(d), 1);
          merged.add(c.id);
          for (const h of halves) {
            syms.push({ box: h, code: prevKey.code });
            ledger.claim(h, `key:${prevKey.code}`);
          }
          edge = Math.max(edge, b.x + b.w);
          took = true;
          break;
        }
        if (!m) break;
        for (const u of used) {
          const d = dictSym.get(u.id);
          if (d) syms.splice(syms.indexOf(d), 1);
          merged.add(u.id);
        }
        syms.push({ box, code: m.smufl });
        ledger.claim(box, `key:${m.smufl}`);
        prevKey = { box, code: m.smufl, sig: binSig(nl, box) };
        edge = Math.max(edge, box.x + box.w);
        took = true;
        break;
      }
      if (!took) break;
    }
  }

  // ── 调号记号**按竖笔数**再定一次升降 ─────────────────────────────────────
  //
  // 升号的两道横笔很细，常常正好压在谱线上，去线时一起抹掉，只剩两根竖笔
  //（《来敬拜荣耀王》A 大调三个升号全被模板认成降号，整曲音高错一片）。
  // **通高的竖笔**数得清：升号两根（右边那根高一点）、降号一根（右下是个肚子）。只拿它把降号改回升号。
  // 只改谱号右边调号区里的记号，谱中的临时记号不碰。
  for (const g of groups) {
    const top = g.lines[0].y;
    const bottom = g.lines[4].y;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < bottom && s0.box.y + s0.box.h > top && s0.box.x < Math.max(...g.lines.map((l) => l.left)) + unit.space * 4);
    if (!clef) continue;
    const right = clef.box.x + clef.box.w + unit.space * 6;
    const inKey = (s0: RasterSym) => !(s0.box.x < clef.box.x + clef.box.w - 1 || s0.box.x > right || s0.box.y > bottom || s0.box.y + s0.box.h < top);
    for (const s0 of syms) {
      if (s0.code !== "accidentalFlat" && s0.code !== "accidentalSharp") continue;
      if (!inKey(s0)) continue;
      // 数竖笔要在**去线之前**的图上、左右各放宽 0.3 格：细的那根竖笔常被当成竖段抽走，去线图上只剩一根
      const pad = Math.round(unit.space * 0.3);
      const n = tallStrokes(raster.bin, { x: s0.box.x - pad, y: s0.box.y, w: s0.box.w + pad * 2, h: s0.box.h });
      // 只往升号改：扫描件放大后升号的竖笔断断续续，数不满两根（《善牧恩慈歌》G 大调因此读成 F 大调，音符 91 → 26%）
      if (n === 2 && s0.code === "accidentalFlat") s0.code = "accidentalSharp";
    }
    // 夹在一串升号里的**还原号**是升号：去线后升号的横笔没了、两根竖笔上下错开，字典认成还原号
    //（《来敬拜荣耀王》的 C#）。调号里的还原号只在转调取消时出现，不会与升号混排在同一串。
    const ks = syms.filter((s0) => isAccidental(s0.code) && inKey(s0));
    if (ks.some((s0) => s0.code === "accidentalSharp") && !ks.some((s0) => s0.code === "accidentalFlat"))
      for (const s0 of ks) if (s0.code === "accidentalNatural") s0.code = "accidentalSharp";
    // 调号里升降也不混排：**少数服从多数**。细笔画的降号肚子只剩一圈细边，
    // 肚子右缘与竖笔数成两根（所信有根基四个降号里第三个 A♭ 读成升号）
    const nf = ks.filter((s0) => s0.code === "accidentalFlat").length;
    const ns = ks.filter((s0) => s0.code === "accidentalSharp").length;
    if (nf && ns && nf !== ns) for (const s0 of ks) if (s0.code === "accidentalFlat" || s0.code === "accidentalSharp") s0.code = nf > ns ? "accidentalFlat" : "accidentalSharp";
  }

  // ── 谱中的升号被当成两个黑符头 ───────────────────────────────────────────
  //
  // 与调号那段同一个病（粗体升号的两道横笔去掉竖笔后就是两个上下叠着的黑头），只是出在谱中：
  // 齐来称颂 m14 低音那个 E♯3 的升号成了一对 D3/F♯3 黑头，多出两个音、升号也丢了。
  // 几何判据同 `sharpBox`；谱中没有「紧贴谱号」那条先验，另要**右边 1.5 格内有个同高的符头**
  //（升号中心与头中心差不到四分之一格）——那是它要升的音。只认成对的，单个的太像带干的头。
  for (let i = 0; i < syms.length; i++) {
    const a = syms[i];
    if (a.code !== "noteheadBlack") continue;
    const b = syms.find((s0) => s0 !== a && s0.code === "noteheadBlack" && Math.abs(s0.box.x - a.box.x) <= keySp * 0.3 && (s0.box.y - a.box.y) / keySp >= 0.7 && (s0.box.y - a.box.y) / keySp <= 1.3);
    if (!b) continue;
    const box = sharpBox([a, b]);
    if (!box) continue;
    // 升号的两根竖笔之间是空的；上下贴着的两个实心头（三度和弦）每一列都有墨，`sharpBox` 分不开
    //（善牧恩慈歌线距 11px，m2 的一对黑头被当成升号）
    if (!hasGapColumn([a, b])) continue;
    const cy = box.y + box.h / 2;
    const right = box.x + box.w;
    const owner = syms.some((s0) => s0 !== a && s0 !== b && /^notehead/.test(s0.code) && s0.box.x >= right - 2 && s0.box.x - right <= keySp * 1.5 && Math.abs(s0.box.y + s0.box.h / 2 - cy) <= keySp / 4);
    if (!owner) continue;
    syms.splice(syms.indexOf(b), 1);
    syms.splice(syms.indexOf(a), 1, { box, code: "accidentalSharp" });
    ledger.claim(box, "acc:accidentalSharp");
  }

  // ── 谱中没人认领的升降还原号：按位置先验配模板 ───────────────────────────
  //
  // 字典认不出、也没人认领的块，**右边 1.5 格内有个同高的符头**（升/还原看盒中心，降看肚子），
  // 形状又像升降号（高 1.8~3.4 格、宽 0.4~1.2 格），就拿模板配（门槛见 `LOOSE_ACC_DIST`）。病例齐来称颂 m5 那个 D♯4 的升号，两道横笔分得开，
  // 字典不认，整块没人要。
  {
    const accTpl = (look.templates ?? []).filter((t) => t.smufl === "accidentalSharp" || t.smufl === "accidentalFlat" || t.smufl === "accidentalNatural");
    const sp = unit.space;
    for (const c of blobs) {
      if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
      const b = c.bbox;
      const w = b.w / sp;
      const h = b.h / sp;
      if (h < 1.8 || h > 3.4 || w < 0.4 || w > 1.2) continue;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
      // 模板配不上的再按**结构**认升号：两根通高的竖笔（上下两端各一成半高度里都有它们的墨——还原号的左竖只在上半、右竖只在下半）
      // 加两道横贯的横笔。低分辨率的小号升号（新编赞美诗 359 谱表下方 D♯4 的升号 22×58px、线距 22）签名离模板远过门槛，整块没人认，
      // 一首漏五个升号。位置先验（右边紧挨着同高的符头）照旧要过。
      const m = matchTemplate(binSig(nl, b), w, h, accTpl, LOOSE_ACC_DIST) ??
        (w >= 0.6 && h >= 2.2 && h <= 3.2 && sharpShape(raster.bin, b) ? { smufl: "accidentalSharp" as SmuflName, dist: LOOSE_ACC_DIST } : null);
      if (!m) continue;
      const py = m.smufl === "accidentalFlat" ? b.y + (b.h * (1 + FLAT_BOWL_TOP)) / 2 : b.y + b.h / 2;
      const right = b.x + b.w;
      if (!syms.some((s0) => /^notehead/.test(s0.code) && s0.box.x >= right - 2 && s0.box.x - right <= sp * LOOSE_ACC_GAP && Math.abs(s0.box.y + s0.box.h / 2 - py) <= sp / 4)) continue;
      merged.add(c.id);
      syms.push({ box: b, code: m.smufl });
      ledger.claim(b, `acc:${m.smufl}`);
    }
  }

  // ── 降号的盒要收到**下面那个肚子**上 ─────────────────────────────────────
  //
  // 降号的音高位置是肚子，不是盒中心：它的字形是「一根竖笔往上伸 + 底下一个肚子」，
  // Maestro 模板 0.84×2.36 格，肚子只占下面一格左右。而 `analyzeAccidental`
  // 判「这个记号是不是那个符头的」用的是**盒中心与符头中心同高**（容差四分之一格）
  // ——实测降号的盒中心比符头中心**高 0.55 格**，16 个里**一个都过不了**那道闸
  //（升号与还原号上下对称，中位数 0.03 格，33/36 与 10/11 都过）。
  //
  // 位图这边的 `Sym.py` 是从盒算的（`adapt.ts` 造的是假字形），所以在这里把盒
  // 收到肚子上最省事：`py` 跟着落到肚子中心，`overlapY` 与 x 上的判据都不受影响。
  // **不动 `staffomr`**——那边的 `py` 从真字形来，两条路的成因不是一回事。
  for (const s of syms) {
    if (s.code !== "accidentalFlat") continue;
    const cut = Math.round(s.box.h * FLAT_BOWL_TOP);
    s.box = { x: s.box.x, y: s.box.y + cut, w: s.box.w, h: s.box.h - cut };
  }

  // ── 符头 + 符干（+ 符尾）并成一块：把头摘出来 ────────────────────────────
  //
  // 符尾贴着符干走大半程，`isolated` 判那条符干「属于某个符号」，于是抽不成原语、
  // `blobImage` 也不照它抹墨——头、干、尾连成一块（实测 1.99×3.91 格），
  // 单头的尺寸闸一律判否。只有符干的那些同理（弧线蹭着符干时也过不了孤立性）。
  // 判据见 `headmask.ts::headFromStemBlock`；**只吃谁都没认领的块**，
  // 谱号、休止、升降号、拍号那几路已经先收过一遍。
  const stemHeads: RasterSym[] = [];
  /** 摘出来的头自带的符干（只进 `SPage`，不回写 `prims`——那边的墨已经抹过了）。 */
  const stemSegs: LineSeg[] = [];
  if (masks.length) {
    for (const c of blobs) {
      const met = metIds.has(c.id) && !merged.has(c.id);
      if (!met && (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id))) continue;
      // 已经被别的路（谱号自举、拍号自举）出成 sym 的块不碰
      const b = c.bbox;
      const metSym = met ? syms.find((s0) => s0.box === b || (s0.code.startsWith("metNote") && overlapFrac(b, s0.box) > 0.9)) : undefined;
      if (met && !metSym) continue;
      if (syms.some((s0) => s0 !== metSym && overlapFrac(b, s0.box) > 0.5)) continue;
      // **长得像休止的块先按休止收**：粗体铅字本的四分休止（1.0×3.1 格）字典里没有这一类，
      // 尺寸又正落在「头 + 干」这一档，被摘出一个假头（《主我敬拜你》第八小节的休止成了 E4）。
      // 与 Maestro 的休止模板比，距离 77；真的「头 + 干（+ 尾）」块一个都比不上。
      // 块里有一根几乎通高的直竖笔的是干（有一位神 m11 加线下的八分，干 + 尾连着下面的歌词，配上了四分休止模板）。
      // 四分休止是折线，粗体的最长竖墨也到不了块高的八成五
      const vr = longestVRun(raster.bin, b);
      const straight = vr >= b.h * 0.85 && vr >= unit.space * 2.5;
      const rm = straight ? null : matchTemplate(binSig(nl, b), b.w / unit.space, b.h / unit.space, restTpl);
      const rs = rm ?? (!straight && isEighthRest(nl, b, c.area, unit) ? { smufl: "rest8th" as SmuflName } : null);
      // 休止不会离谱表几格远：标题行的「你」字（我一生要赞美你，离第一线 8 格）配上了八分休止
      if (rs && !inBand(b.y + b.h / 2)) continue;
      if (rs) {
        stemHeads.push({ box: b, code: rs.smufl });
        ledger.claim(b, `rest:${rs.smufl}`);
        continue;
      }
      let r = headFromStemBlock(raster.bin, b, c.area, masks, unit, pitchGrid, onLineY, nl);
      // **空心头被去线切成两半**：右半个圈与干连成一块（不到一个头宽），左半个圈是另一小块（我一生要赞美你 m13 F4 附点二分）。
      // 块窄过一个头时，把干端一格内、左右紧贴着的无主小块并进来再判
      const joined: number[] = [];
      if (!r && b.w < unit.space * 0.85 && b.h >= unit.space * 1.6) {
        let box = b;
        let area = c.area;
        for (const c2 of blobs) {
          if (c2 === c || claimed.has(c2.id) || dictClaimed.has(c2.id) || merged.has(c2.id)) continue;
          const q = c2.bbox;
          if (q.w > unit.space * 1.2 || q.h > unit.space * 1.3) continue;
          if (q.x > b.x + b.w + 2 || q.x + q.w < b.x - 2) continue;
          const nearEnd = q.y + q.h > b.y + b.h - unit.space * 1.3 || q.y < b.y + unit.space * 1.3;
          if (!nearEnd || q.y < b.y - 2 || q.y + q.h > b.y + b.h + 2) continue;
          const x0 = Math.min(box.x, q.x);
          const y0 = Math.min(box.y, q.y);
          box = { x: x0, y: y0, w: Math.max(box.x + box.w, q.x + q.w) - x0, h: Math.max(box.y + box.h, q.y + q.h) - y0 };
          area += c2.area;
          joined.push(c2.id);
        }
        if (joined.length && !syms.some((s0) => overlapFrac(box, s0.box) > 0.5)) r = headFromStemBlock(raster.bin, box, area, masks, unit, pitchGrid, onLineY, nl);
      }
      if (!r) continue;
      // **两根通高竖笔的是升号**：谱表外的升号（两道粗斜横笔）也摘得出一个「头 + 干 + 尾」
      //（当我们回到天家 m15 低音 E4 前的升号收成 E4 八分）。头 + 干的块只有一根通高的竖笔。
      // 不摘就是了，块留给后面临时记号那几路
      if (!joined.length && b.w <= unit.space * 1.05 && b.h <= unit.space * 3.4 && tallStrokes(raster.bin, b) === 2) continue;
      for (const id of joined) merged.add(id);
      // 已有符头压着的不重复出（长干两头的那一档：万古磐石歌的 B♭3/B♭2 别的路已认出，再出一遍成了四个音）
      const dup = (hb: Rect) => [...syms, ...stemHeads].some((s0) => /^notehead/.test(s0.code) && overlapFrac(hb, s0.box) > 0.3);
      if (dup(r.head)) continue;
      if (metSym) syms.splice(syms.indexOf(metSym), 1);
      stemHeads.push({ box: r.head, code: "noteheadBlack" });
      for (const e of r.extra) {
        if (dup(e)) continue;
        stemHeads.push({ box: e, code: "noteheadBlack" });
        ledger.claim(e, "stemblock:noteheadBlack");
      }
      stemSegs.push({ x0: r.stemX, y0: r.stemY0, x1: r.stemX, y1: r.stemY1, lw: unit.lineThick, maxLw: unit.lineThick * 2 });
      ledger.claim(r.head, "stemblock:noteheadBlack");
    }
    syms.push(...stemHeads);
    // 两声部共干的长干中段贴着的实心头（`solidHeadsAlongStems`）
    const blackHeads = syms.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box);
    const others = syms.filter((s0) => !/^notehead/.test(s0.code)).map((s0) => s0.box);
    for (const box of solidHeadsAlongStems(raster.bin, nl, masks, unit, pitchGrid, onLineY, [...prims.vSegs, ...stemSegs], blackHeads, [...others, ...prims.beams.map((b) => b.box)])) {
      syms.push({ box, code: "noteheadBlack" });
      ledger.claim(box, "along:noteheadBlack");
      // 这些头错过了上面认还原号那一步。整个还原号顺着加线连进了这团墨、一块无主的碎块都不剩时
      //（Holy, Holy, Holy m13 男高 C♮4 与男低 F♯2 共干），从头左边 0.2~1.6 格里穿过头心的长竖笔起再认一次
      const cy = Math.round(box.y + box.h / 2);
      for (let x = Math.round(box.x - unit.space * 1.6); x <= box.x - unit.space * 0.2; x++) {
        const run = vRunAt(nl, x, cy);
        if (!run || run[1] - run[0] < unit.space * 1.5) continue;
        const nat = natFrom(x + 1, run);
        if (nat && !syms.some((s0) => overlapFrac(nat, s0.box) > 0.3)) {
          syms.push({ box: nat, code: "accidentalNatural" });
          ledger.claim(nat, "accid:accidentalNatural");
        }
        break;
      }
    }
  }

  // ── **被几何闸判否的块，交给页内自举的判别器再判一次** ────────────────────
  //
  // `findRasterHeads` 的尺寸 + 填充率是一把**没见过负例**的尺子：它只知道符头长什么样，
  // 不知道「长得像符头但不是」的东西长什么样。扫描件上符头被擦线啃窄、被符干粘住，
  // 尺寸一出闸就没人管了（实测破碎扫描版带内「够得上符头那一档」的块只有 42.7%
  // 被认领，干净版 65.9%）；而闸一放宽假头就跟着进来——歌词那条探针每次都先报警。
  //
  // 这里现训一个**带负例**的逻辑回归（`headclass.ts`）：
  // **正例**：这一页**已经认出来的全部实心符头**——不只 `findRasterHeads` 那批，
  // 还有拆块、按内腔、摘符干块捞回来的。只用「过了几何闸」的那批，样本会偏向
  // 长得端正的那一档，而判别器要判的恰恰是被啃过、被粘住的那些。
  //
  // **负例**：这一页**认出来的全部非符头符号**——谱号、休止、升降号、拍号，
  // 不论来自字典还是位置自举。正是「长得像符头但不是」的那一批，
  // 也正是那把没见过负例的尺子分不开的东西。
  //（歌词字格是更靠后才切的，这里取不到。）
  const clfPos = [
    ...heads.filter((h) => !dropHead.has(h.comp.id) && h.code === "noteheadBlack").map((h) => h.box),
    ...split.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box),
    ...stemHeads.map((s0) => s0.box),
    ...stacked.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box),
  ];
  const clfNeg: Rect[] = syms.filter((s0) => !/notehead/i.test(s0.code)).map((s0) => s0.box);
  const clf = masks.length ? trainHeadClassifier(raster.bin, masks, unit, onLineY, clfPos, clfNeg) : null;
  const clfHeads: RasterSym[] = [];
  /** 已有符头压着的位置不再出（「头 + 干」那一路只记账、不标块，这一遍会在同一块里再拆一次）。 */
  const headTaken = (hb: Rect) => [...syms, ...clfHeads].some((s0) => /^notehead/.test(s0.code) && overlapFrac(hb, s0.box) > 0.3);
  if (clf) {
    for (const c of blobs) {
      if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
      const b = c.bbox;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.5)) continue;
      const w = b.w / unit.space;
      const h = b.h / unit.space;
      if (w < CLF_W[0] || w > CLF_W[1] || h < CLF_H[0] || h > CLF_H[1]) continue;
      // 符杠的断头不是符头：块的中心压在某条符杠的中线上（半个杠厚以内）
      //（《是谁》朝下八分音符的符杠末端 1.06×0.48 格，判别器给过了，出了个 B3）
      if (onBeamLine(b)) continue;
      const gy = pitchGrid(b.y + b.h / 2);
      if (gy === null) continue;
      if (headProb(clf, raster.bin, masks, unit, b, gy, onLineY(gy)) < CLF_P) continue;
      const hw = Math.round(unit.space * 1.25);
      const hh = Math.round(unit.space * 0.95);
      const box = { x: Math.round(b.x + b.w / 2 - hw / 2), y: Math.round(gy - hh / 2), w: hw, h: hh };
      if (headTaken(box)) continue;
      clfHeads.push({ box, code: "noteheadBlack" });
      ledger.claim(box, "clf:noteheadBlack");
    }
    // ── **大团再拆一遍，拆出来的每个头都要过判别器** ────────────────────────
    //
    // `splitHeadCluster` 的尺寸闸是 6×4 格，而 `raster-gap.mjs` 量出漏音里
    // **53.8% 焊在更大的团里**。直接把闸放大试过：小节自检涨（真音确实捞回来了）
    // 而音符不涨——大团里挑出来的头对错各半，没人验。
    // 判别器（带负例、见 `headclass.ts`）恰好补上这一关，而它要等字典那一路跑完
    // 才训得出来，所以放在这里做第二遍：**闸放大，但每个头都要过判别器**。
    if (masks.length) {
      for (const c of blobs) {
        if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
        const b = c.bbox;
        if (syms.some((s0) => overlapFrac(b, s0.box) > 0.5)) continue;
        const w = b.w / unit.space;
        const h = b.h / unit.space;
        if (w > BIG_W || h > BIG_H) continue; // 再大就不是一团连桁了
        const parts = splitHeadCluster(noBeam, b, c.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY, true, (pb, gy) =>
          headProb(clf, raster.bin, masks, unit, pb, gy, onLineY(gy)) >= CLF_P,
        );
        if (parts.length < 2) continue;
        for (const pb of parts) {
          if (headTaken(pb)) continue;
          clfHeads.push({ box: pb, code: "noteheadBlack" });
          ledger.claim(pb, "clfsplit:noteheadBlack");
        }
        claimed.add(c.id);
      }
    }
    syms.push(...clfHeads);
  }

  // ── 空心头按模板再搜 ─────────────────────────────────────────────────────
  //
  // 低分辨率的全音符（《善牧恩慈歌》线距 11px）两路都认不出：叠成「8」字的三度
  // 两个头并成一块，内腔被谱线切成四片、又是斜缝，过不了内腔那一路的「横宽」闸；
  // 贴着谱线的那个被去谱线切成左右两半。可同一页上别处的空心头是认出来了的——
  // 拿它们平均出模板（`buildHollowMasks`），在**有内腔的无主块**里做匹配追踪。
  // 先把 x 上重叠、上下贴着的无主块并起来（被切成两半的头要并回一个）。
  {
    const hollowMask = buildHollowMasks(raster.bin, syms.filter((s0) => !(s0 as { weak?: boolean }).weak), unit, [])[0] ?? null;
    if (hollowMask) {
      // 带外到 `FAR_HEAD` 格的块只交全音符形状那一路（第三条加线上的全音符离外线正好 3 格：称谢歌伴奏 m16 F#3），
      // 模板那一路不放：谱表下三四格常是歌词字
      const inFar = (y: number) => groups.some((g) => y > g.lines[0].y - unit.space * FAR_HEAD && y < g.lines[4].y + unit.space * FAR_HEAD);
      // **半个全音符先被认成了实心头**：夹在两线之间的全音符去谱线后劈成左右两个月牙，粗的那半
      // 窄得不到一格、却过了实心头那一关（Holy, Holy, Holy m8 低音 A2：右半 0.92×1.17 格、左半 1.0 格没人认）。
      // 实心头必有符干——没干、旁边贴着一块同高的无主月牙、两块并起来有全音符宽的，改认全音符
      const isFree = (c: (typeof blobs)[number]) => !claimed.has(c.id) && !dictClaimed.has(c.id) && !merged.has(c.id);
      for (let i = syms.length - 1; i >= 0; i--) {
        const s0 = syms[i]!;
        if (s0.code !== "noteheadBlack" || s0.box.w > unit.space * 0.95) continue;
        const sb = s0.box;
        const stemmed = prims.vSegs.some((v) => {
          const vx = (v.x0 + v.x1) / 2;
          return (Math.abs(vx - sb.x) <= unit.space * 0.2 || Math.abs(vx - (sb.x + sb.w)) <= unit.space * 0.2) && Math.min(v.y0, v.y1) <= sb.y + sb.h && Math.max(v.y0, v.y1) >= sb.y;
        });
        if (stemmed) continue;
        const mates = blobs.filter((c) => {
          if (!isFree(c) || c.bbox.w > unit.space * 1.1) return false;
          const r = c.bbox;
          const vov = Math.min(sb.y + sb.h, r.y + r.h) - Math.max(sb.y, r.y);
          const hgap = r.x > sb.x ? r.x - (sb.x + sb.w) : sb.x - (r.x + r.w);
          return vov >= Math.max(sb.h, r.h) * 0.8 && hgap >= -unit.lineThick - 1 && hgap <= unit.space * 0.5;
        });
        if (mates.length !== 1) continue;
        const r = mates[0]!.bbox;
        const x0 = Math.min(sb.x, r.x);
        const y0 = Math.min(sb.y, r.y);
        const wb = { x: x0, y: y0, w: Math.max(sb.x + sb.w, r.x + r.w) - x0, h: Math.max(sb.y + sb.h, r.y + r.h) - y0 };
        if (wb.w < unit.space * 1.3 || wb.w > unit.space * 2.2) continue;
        syms.splice(i, 1, { box: wb, code: "noteheadWhole" });
        merged.add(mates[0]!.id);
        ledger.claim(wb, "halves:noteheadWhole");
      }
      const free = blobs.filter((c) => isFree(c) && inFar(c.bbox.y + c.bbox.h / 2));
      /** 本页已认二分头的中位尺寸（开口内腔那一档用）。 */
      const halves = syms.filter((s0) => s0.code === "noteheadHalf");
      const med = (xs: number[]) => xs.sort((p, q) => p - q)[xs.length >> 1];
      const halfSize = halves.length ? { w: med(halves.map((s0) => s0.box.w)), h: med(halves.map((s0) => s0.box.h)) } : null;
      // 带宽比 `HOLLOW_BAND` 窄：开口内腔不挑形状，歌词里的字母 o 也围得出一个（我灵镇静「soul」，在谱表下 2.7 格）
      const inCavityBand = (y: number) =>
        groups.some((g) => y > g.lines[0].y - unit.space * OPEN_CAVITY_BAND && y < g.lines[4].y + unit.space * OPEN_CAVITY_BAND);
      const used = new Set<number>();
      for (const a of free) {
        if (used.has(a.id)) continue;
        let box = { ...a.bbox };
        let area = a.area;
        const group = [a.id];
        for (let again = true; again; ) {
          again = false;
          for (const b of free) {
            if (group.includes(b.id) || used.has(b.id)) continue;
            const r = b.bbox;
            const ov = Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x);
            const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
            // **左右两半**：叠成「8」字的全音符去谱线后劈成左右两块，中间隔着内腔的白（我灵镇静 m8 A4/F4，各 0.74×2.2 格、隔 0.34 格）
            const vov = Math.min(box.y + box.h, r.y + r.h) - Math.max(box.y, r.y);
            const hgap = r.x > box.x ? r.x - (box.x + box.w) : box.x - (r.x + r.w);
            const halves = group.length === 1 && box.w <= unit.space * 0.9 && r.w <= unit.space * 0.9 && vov >= Math.max(box.h, r.h) * 0.8 && hgap > 0 && hgap <= unit.space * 0.5;
            if (!halves) {
              // 侧边紧贴的只并头的碎片：附点（高不到 0.6 格）贴在全音符右边，并进来盒就宽出尺寸闸（万口欢唱末尾附点全音符叠头）
              const side = gap < 0 && Math.abs(r.x - (box.x + box.w)) <= unit.lineThick * 2 + 1 && r.h >= unit.space * 0.6;
              if (ov < Math.min(box.w, r.w) * 0.3 && !side) continue;
              if (gap > unit.lineThick * 2 + 1) continue;
            }
            const x0 = Math.min(box.x, r.x);
            const y0 = Math.min(box.y, r.y);
            box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
            area += b.area;
            group.push(b.id);
            again = true;
          }
        }
        const w = box.w / unit.space;
        const h = box.h / unit.space;
        if (w < 0.8 || w > 2.2 || h < 0.6 || h > 3.2) continue; // 粗体全音符宽到 1.96 格（《赞美一神》）
        if (syms.some((s0) => overlapFrac(box, s0.box) > 0.3)) continue;
        {
          const whole = wholesByShape(raster.bin, nl, box, unit, pitchGrid, prims.vSegs);
          if (whole.length) {
            for (const id of group) used.add(id), merged.add(id);
            for (const wb of whole) {
              syms.push({ box: wb, code: "noteheadWhole" });
              ledger.claim(wb, "wholeshape:noteheadWhole");
            }
            continue;
          }
        }
        if (!inBand(box.y + box.h / 2)) continue;
        // 块里要有内腔（空心头的先验）。没有封闭的孔就找**开口的内腔**：那种头模板也配不上
        // （万福泉源歌连已认出的头都只打到 0.2 分），改按内腔中心直接定头（`hollowHeadsFromCavities`）
        if (!holes.some((o) => o.x >= box.x && o.x + o.w <= box.x + box.w && o.y >= box.y - 1 && o.y + o.h <= box.y + box.h + 1)) {
          if (!halfSize) continue;
          // 又窄又高的块不是头：还原号两竖笔夹着的方框也是四向碰墨的「内腔」（我灵镇静 m15 B♮，块宽 0.64 个头、高 3 格）。
          // 只按窄判会误伤缺边的真头
          if (box.w < halfSize.w * 0.8 && box.h > unit.space * 2.2) continue;
          const found = hollowHeadsFromCavities(nl, mergeHoles(openCavities(raster.bin, box, unit), unit, onLineOrGrid), unit, prims.vSegs, inCavityBand, syms.map((s0) => s0.box), halfSize, syms.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box));
          if (!found.length) continue;
          for (const id of group) used.add(id), merged.add(id);
          for (const f of found) {
            syms.push(f);
            ledger.claim(f.box, `opencavity:${f.code}`);
          }
          continue;
        }
        // 正好一个头大、或叠成「8」字一对的有腔块，门槛放到 `HOLLOW_SHAPED_SCORE`：模板多半由本页的二分头平均出来，
        // 全音符宽、内腔斜，配上去分数低（齐来谢主歌「阿们」F4/D4、F4 只得 0.29 / 0.34）
        const shaped = w >= 1.1 && w <= 1.7 && ((h >= 0.85 && h <= 1.3) || (h >= HOLLOW_PAIR_H[0] && h <= 2.2));
        let parts = splitHeadCluster(raster.bin, box, area, [hollowMask], unit, pitchGrid, onLineY, true, undefined, 1, shaped ? HOLLOW_SHAPED_SCORE : HOLLOW_MASK_SCORE);
        // 叠成「8」字的一对：先认的那个把共用的那条边减掉了，另一个的分数跟着掉，按成对再拆一次（`HOLLOW_PAIR_SCORE`）
        if (parts.length <= 1 && h >= HOLLOW_PAIR_H[0] && h <= HOLLOW_PAIR_H[1] && w <= HOLLOW_PAIR_W) {
          const p2 = splitHeadCluster(raster.bin, box, area, [hollowMask], unit, pitchGrid, onLineY, true, undefined, 2, HOLLOW_PAIR_SCORE);
          if (p2.length === 2 && Math.abs(p2[0].y - p2[1].y) >= unit.space * 0.8 && Math.abs(p2[0].x - p2[1].x) <= unit.space * 0.3) parts = p2;
        }
        if (!parts.length) continue;
        for (const id of group) used.add(id), merged.add(id);
        for (const pb of parts) {
          const stemmed = prims.vSegs.some((v) => {
            const vx = (v.x0 + v.x1) / 2;
            return (Math.abs(vx - pb.x) <= unit.space * 0.2 || Math.abs(vx - (pb.x + pb.w)) <= unit.space * 0.2) && Math.min(v.y0, v.y1) <= pb.y + pb.h && Math.max(v.y0, v.y1) >= pb.y;
          });
          const code: SmuflName = stemmed ? "noteheadHalf" : "noteheadWhole";
          syms.push({ box: pb, code });
          ledger.claim(pb, `hollowmask:${code}`);
        }
      }
    }
  }

  // ── 终止线/段落线：纵贯谱表的**实心条**补成竖段 ────────────────────────────
  //
  // 「细 + 粗」双线里那根粗线有 0.6 格宽，过不了竖段的宽度闸；紧贴着它的细线
  // 又过不了孤立性判据——两根都成了没人认领的块，小节线那一步看不见它们。
  // 《善牧恩慈歌》延长记号后、「阿们」之前那道双线就这样丢了，后面一小节并进了前一小节。
  // 判据：上下两端贴着五线的顶线与底线（各 0.4 格内）、宽不过一格、填充八成以上。
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space || c.area < b.w * b.h * 0.8) continue;
    const g = groups.find((g0) => Math.abs(b.y - g0.lines[0].y) <= unit.space * 0.4 && Math.abs(b.y + b.h - g0.lines[4].y) <= unit.space * 0.4);
    if (!g) continue;
    if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
    const x = b.x + b.w / 2;
    prims.vSegs.push({ x0: x, y0: b.y, x1: x, y1: b.y + b.h, lw: b.w, maxLw: b.w });
    merged.add(c.id);
    ledger.claim(b, "bar:thick");
  }

  // **谱号左边（和正下方）没有音符**、谱号右边紧挨着的「符头」可能是调号：花括号、方括号的弯钩落在谱表上下，圆滚滚的像个全音符
  // （《赞美一神》第二行低音谱表顶上那一个，出了个 G3 全音符）。
  for (const g of groups) {
    const top = g.lines[0].y - unit.space * 2;
    const bottom = g.lines[4].y + unit.space * 2;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < g.lines[4].y && s0.box.y + s0.box.h > g.lines[0].y);
    if (!clef) continue;
    // 调号兜底之后才摘出来的「符头」（符头连符干那一路把升号的竖笔当成符干）再验一次
    const onStaff = (r: Rect) => r.y < g.lines[4].y && r.y + r.h > g.lines[0].y;
    const edge = clef.box.x + clef.box.w;
    if (!syms.some((s0) => isAccidental(s0.code) && onStaff(s0.box) && s0.box.x >= edge - 1 && s0.box.x < edge + unit.space * KEY_GAP)) {
      const pair = sharpAsHeads(syms, edge, onStaff);
      if (pair) {
        for (const s0 of pair.heads) syms.splice(syms.indexOf(s0), 1);
        syms.push({ box: pair.box, code: "accidentalSharp" });
        ledger.claim(pair.box, "key:accidentalSharp");
      }
    }
    for (let i = syms.length - 1; i >= 0; i--) {
      const b = syms[i].box;
      // 中心在谱号**右缘**以左的都不要：谱号正下方也没有音符，高音谱号下端的弯钩被切出来就是个「头」
      //（《所信有根基》每行开头多一个 C4）
      if (/notehead/i.test(syms[i].code) && b.x + b.w / 2 < clef.box.x + clef.box.w && b.y + b.h / 2 >= top && b.y + b.h / 2 <= bottom) syms.splice(i, 1);
    }
  }

  // ── 附点：**位置 + 形状自举**，字典兜不住 ─────────────────────────────────
  //
  // 附点在位图路原先只靠字典认（`augmentationDot`），字典是在线距 15~19px 的合唱谱上建的：
  // 《是谁》线距 50px，附点直径 18px，还被横段那一步连着符头的边抽成了一截横线；
  // 《善牧恩慈歌》线距 11px，附点只有 3px。两首的附点二分、附点四分一个都没认出来。
  // 附点的位置是死的：符头右边一格之内、同一个间（线上的音写在上方那个间）。
  // 在去谱线图上找那个窗口里**孤立、近圆的小墨团**，找到就补一个附点，时值交给 `attachDots`。
  for (const d of findDots(nl, syms, unit, staffYs, (y) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick))) {
    syms.push({ box: d, code: "augmentationDot" });
    ledger.claim(d, "dot:augmentationDot");
  }

  // **大半落在升降号盒里的符头不要**：调号升号认出来了，同一块又被拆块那一路拆出两个「头」
  //（《向主唱新歌》两行行首的 F♯ 各多出一个 G5）。临时记号只挨着符头左边，交叠不到七成。
  {
    const accs = syms.filter((s0) => isAccidental(s0.code));
    for (let i = syms.length - 1; i >= 0; i--)
      if (/^notehead/.test(syms[i].code) && accs.some((a) => overlapFrac(syms[i].box, a.box) > 0.7)) syms.splice(i, 1);
  }

  // **符尾围出来的「空心头」不要**：干朝下的八分音符，干底向右弯回的符尾围出一个内腔，
  // 按内腔找的几路把它收成空心二分头（《所信有根基》低音谱表每小节多一个 A2/F2 二分）。
  // 一根干只在一端挂头（同一根干上时值只有一种）：另一端已挂着实心头，这一端就只能是符尾。
  {
    const sp = unit.space;
    const blacks = syms.filter((s0) => s0.code === "noteheadBlack");
    // 干被符头、谱线切成几段：同一 x、缺口不到一格的接成一根
    const joined: LineSeg[] = [];
    for (const q of [...prims.vSegs].sort((a, b) => Math.min(a.y0, a.y1) - Math.min(b.y0, b.y1))) {
      const x = (q.x0 + q.x1) / 2;
      const prev = joined.find((j) => Math.abs((j.x0 + j.x1) / 2 - x) <= unit.lineThick && Math.min(q.y0, q.y1) - j.y1 <= sp);
      if (prev) prev.y1 = Math.max(prev.y1, q.y0, q.y1);
      else joined.push({ ...q, y0: Math.min(q.y0, q.y1), y1: Math.max(q.y0, q.y1) });
    }
    const bin = raster.bin;
    /** 从 y 沿 x 列（左右各容一个线宽）往 dir 方向走墨，断口不过 3 像素，返回走到的最远 y。 */
    const walk = (x: number, y: number, dir: number): number => {
      let last = y;
      for (let yy = y, miss = 0; miss <= 3 && yy >= 0 && yy < bin.h; yy += dir) {
        let on = false;
        for (let xx = Math.round(x - unit.lineThick); xx <= Math.round(x + unit.lineThick) && !on; xx++) on = xx >= 0 && xx < bin.w && bin.data[yy * bin.w + xx] === 1;
        if (on) {
          last = yy;
          miss = 0;
        } else miss++;
      }
      return last;
    };
    const isFlag = (b: Rect) => {
      const cy = b.y + b.h / 2;
      return joined.some((q) => {
        if (q.y1 - q.y0 < sp * 1.5) return false;
        const sx = (q.x0 + q.x1) / 2;
        if (sx < b.x - sp * 0.3 || sx > b.x + b.w + sp * 0.3) return false;
        if (cy < q.y0 - sp * FLAG_REACH || cy > q.y1 + sp * FLAG_REACH) return false;
        // 两头都顺着墨走，取离它远的那一端（干被切剩的一截两端离它都近，按近端判方向会判反）
        const up = walk(sx, q.y0, -1);
        const dn = walk(sx, q.y1, 1);
        const far = cy - up > dn - cy ? up : dn;
        if (Math.abs(far - cy) < sp * 2.5) return false;
        // 远端的头要在谱表近旁：干的墨顺着断口接进下方歌词，字的笔画也被认成过实心头（齐来崇拜「能」）
        const nearStaff = (y: number) => staffGeoms.some((g) => y > g.top - sp * FLAG_HEAD_BAND && y < g.bottom + sp * FLAG_HEAD_BAND);
        // 符尾离那根干上的头至少三格多（所信有根基 3.5~4 格）；两格上下的是和弦里另一个头
        //（来敬拜荣耀王加线上的空心头被误认成实心，离上面那个空心头只隔两格）
        return blacks.some((h) => {
          const hy = h.box.y + h.box.h / 2;
          return Math.abs(h.box.x + h.box.w / 2 - sx) < sp * 1.3 && Math.abs(hy - far) < sp && Math.abs(hy - cy) >= sp * FLAG_GAP && nearStaff(hy);
        });
      });
    };
    for (let i = syms.length - 1; i >= 0; i--)
      if ((syms[i].code === "noteheadHalf" || syms[i].code === "noteheadWhole") && isFlag(syms[i].box)) syms.splice(i, 1);
  }

  // ── 悬在两级之间的**空心头**：按相邻线的相对位置取上下两个候选，模板定夺 ─────
  //
  // 头盒中心按该处实测的五线换成音级位置，离整数 `SNAP_AMBIG` 级以上的（头盒带进了圈的缺口、干根、加线），
  // 在上下两个候选位置各拿本页自举的空心模板打分（骑线/在间分开），取高的，头盒挪过去。
  // **只对空心头**：实心头也做，独唱谱音符 −0.19（悬着的实心头多是被符杠、干根拉偏的，模板窗口里压着同样的东西）；
  // 空心头 +0.12。
  if (hollowMasks.length) {
    const sp = unit.space;
    for (const s0 of syms) {
      if (s0.code !== "noteheadHalf" && s0.code !== "noteheadWhole") continue;
      const cx = s0.box.x + s0.box.w / 2;
      const cy = s0.box.y + s0.box.h / 2;
      const f = frames.find((q) => cy > q.top - sp * 3 && cy < q.bottom + sp * 3);
      if (!f) continue;
      const ys = f.at(cx);
      const pos = pitchPos(ys, cy);
      if (!isFinite(pos) || Math.abs(pos - Math.round(pos)) < SNAP_AMBIG) continue;
      let best: { y: number; s: number } | null = null;
      for (const p of [Math.floor(pos), Math.ceil(pos)]) {
        const y = pitchY(ys, p);
        const m = hollowMasks.find((k) => k.onLine === (p % 2 === 0)) ?? hollowMasks[0];
        const sc = scoreAt(raster.bin, m, cx, y);
        if (!best || sc > best.s) best = { y, s: sc };
      }
      if (best) s0.box = { ...s0.box, y: Math.round(s0.box.y + best.y - cy) };
    }
  }

  // ── **实心头里藏着一道斜缝的其实是空心头** ───────────────────────────────
  //
  // 这套字体的二分头圈粗、内腔只是一道斜缝；骑线时谱线从缝中间横过，去谱线后缝被线残段填上，
  // 填充率冲过实心那一档（主使我喜乐、主我敬拜你、耶和华是我的牧者一批「二分读成四分」）。
  // 放在最后、各路剔除之后才判：早判的话，拍号「4」的三角孔、叠头拆出来的半个头都被改成空心，
  // 下游那几道「只剔实心头」的闸（拍号盖字典、升号认回）就放过了它们（欢然颂主多出四个音）。
  // 只改挂着干的（头缘两倍线宽内有竖段；放到 0.4 格耶和华是我的牧者 −0.6，改成空心后挂到了别的干上）；判据见 `notehead.ts::hollowSlit`。
  {
    const sp = unit.space;
    const tol = Math.max(unit.lineThick * 2, sp * 0.25);
    for (const s0 of syms) {
      if (s0.code !== "noteheadBlack") continue;
      const b = s0.box;
      const cy = b.y + b.h / 2;
      const stemmed = [...prims.vSegs, ...stemSegs, ...inkStems].some((v) => {
        const vx = (v.x0 + v.x1) / 2;
        return (Math.abs(vx - b.x) <= tol || Math.abs(vx - b.x - b.w) <= tol) && Math.min(v.y0, v.y1) <= cy + sp && Math.max(v.y0, v.y1) >= cy - sp;
      });
      if (stemmed && hollowSlit(raster.bin, b, sp)) s0.code = "noteheadHalf";
    }
  }

  // **切加线要用最终认出来的全部符头**：除了 `findRasterHeads`，还有按内腔找的、
  // 拆块拆出来的、字典查出来的、碎块并回再判出来的——少算哪一路，那一路的符头
  // 就只能蹭邻居的加线，`findLegers` 判否、整批挂不上谱行。
  // ── 找不到竖段的二分头：**顺着头缘的墨柱补干** ─────────────────────────────
  //
  // 三度叠置的空心和弦（赞美三一真神第二行 m5 的 F4/A4 附点二分），朝下的干左侧贴着两个头的圈，
  // 一半以上的行有邻墨，`findPrimitives` 的孤立性判它「属于某个符号」、不出竖段；干没挂上，读成全音符。
  // 这里对二分头与实心头，头缘两倍线宽内又没有竖段的，从头心沿头缘的墨柱往上下走（`inkColumn`），
  // 伸出去 2.5~7 格的当干补进去。两端都压在首末线附近的是小节线，不算。
  // 独唱谱时值 90.42 → 90.66%（奇异恩典 +2.7、流血歌伴奏 +2.5、赞美三一真神 +2.4、父恩广大音符 +1.2），无一首掉；
  // 合唱谱扫描档音符 +0.10、小节自检 +1.2，干净档小节自检 +0.65、歌词 +0.09、音符 −0.02（一个音），按接受记。
  // **实心头同样补**（2026-09-27）：上端连着符尾、下端连着叠头的细干一样过不了孤立性
  //（所信有根基高音谱表干朝上的八分三度，16 处读成四分）。
  {
    const sp = unit.space;
    const tol = Math.max(unit.lineThick * 2, sp * 0.25);
    for (const s0 of syms) {
      if (s0.code !== "noteheadHalf" && s0.code !== "noteheadBlack") continue;
      const b = s0.box;
      const cy = b.y + b.h / 2;
      const has = [...prims.vSegs, ...stemSegs, ...inkStems].some((v) => {
        const vx = (v.x0 + v.x1) / 2;
        return (Math.abs(vx - b.x) <= tol || Math.abs(vx - b.x - b.w) <= tol) && Math.min(v.y0, v.y1) <= cy + sp && Math.max(v.y0, v.y1) >= cy - sp;
      });
      // 贴着的竖段要在正经那一侧：左缘上往上伸的、右缘上往下伸的是邻头的干（破碎扫描版 p7 相邻十六分，
      // 前一根朝上的干离后一个头左缘 5px；后一个头自己的干被两侧邻墨判不孤立、不出竖段，于是被并进邻头的和弦）
      const own = has && [...prims.vSegs, ...stemSegs, ...inkStems].some((v) => {
        const vx = (v.x0 + v.x1) / 2;
        const top = Math.min(v.y0, v.y1);
        const bot = Math.max(v.y0, v.y1);
        if (top > cy + sp || bot < cy - sp) return false;
        return (Math.abs(vx - b.x) <= tol && bot >= cy + sp) || (Math.abs(vx - b.x - b.w) <= tol && top <= cy - sp);
      });
      if (has && own) continue;
      const col = inkColumn(nl, b, unit, has);
      if (!col) continue;
      const reach = Math.max(cy - col[0], col[1] - cy);
      if (reach < sp * INK_STEM_REACH[0] || reach > sp * INK_STEM_REACH[1]) continue;
      const g = groups.find((q) => cy > q.lines[0].y - sp * 4 && cy < q.lines[4].y + sp * 4);
      // 一端扎进符杠的不算小节线：底线上的头、干顶到首线上方的杠，也正好两端压着首末线（破碎扫描版 p7 十六分 E4）
      const inBeam = (y: number) => prims.beams.some((q) => col[2] >= q.box.x && col[2] <= q.box.x + q.box.w && y >= q.box.y - 2 && y <= q.box.y + q.box.h + 2);
      if (g && Math.abs(col[0] - g.lines[0].y) <= sp * 0.5 && Math.abs(col[1] - g.lines[4].y) <= sp * 0.5 && !inBeam(col[0]) && !inBeam(col[1])) continue;
      inkStems.push({ x0: col[2], y0: col[0], x1: col[2], y1: col[1], lw: unit.lineThick, maxLw: unit.lineThick * 2 });
    }
  }

  // ── 沿着已挂了空心头的干补和弦里漏掉的空心头（`notehead.ts::hollowHeadsAlongStems`）──
  // 放在墨柱补干之后：叠头的圈把干切碎、竖段表里没有的干，要等上面补进 `inkStems` 才有（我灵镇静 m10）。
  // 模板按**此刻**认出的空心头重建（含弱头、两个就够）：早先那份样本不够时一张都没有（恩友歌第一页），
  // 一张也凑不出就只按墨占比与内腔佐证判。
  {
    const alongMasks = buildHollowMasks(raster.bin, syms, unit, lineYs, 2);
    const added: RasterSym[] = [];
    for (const f of hollowHeadsAlongStems(raster.bin, nl, rawHoles, alongMasks, unit, makePitchSteps(groups), [...prims.vSegs, ...stemSegs, ...inkStems], syms)) {
      syms.push(f);
      added.push(f);
      ledger.claim(f.box, "along:noteheadHalf");
    }
    // 这里补出来的头错过了上面找附点那一步，单给它们再找一次（我灵镇静 m10 附点二分 F4）
    if (added.length)
      for (const d of findDots(nl, syms, unit, staffYs, (y) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick), added)) {
        syms.push({ box: d, code: "augmentationDot" });
        ledger.claim(d, "dot:augmentationDot");
      }
  }
  // ── 离谱表太远、又没有加线链的符头不要 ───────────────────────────────────
  //
  // 大字本的歌词夹在两行谱之间，字的横笔被当成加线、一笔收成符头，读成高音谱表下方的 C3、B♭2
  //（所信有根基一首多出十几个）。44 首独唱谱 GT 里高音谱表上下、低音谱表上方最多 3 条加线，
  // 低音谱表下方 4 条；离最近谱表外线超过 `LEDGER_CHAIN_FROM` 格的头，要从外线到头之间**每隔一格都有一条横墨**
  //（横跨头心左右各半格、够 0.9 格长）才留——合唱谱钢琴行真有五六条加线的音，加线链是全的。
  // 1-bit 扫描件（`gray1`）不做：破碎扫描件一页丢七十九个（音符 +0.1），但挂词锚点连锁变，歌词 −2.6。
  if (raster.kind !== "gray1") {
    const sp = unit.space;
    for (let i = syms.length - 1; i >= 0; i--) {
      if (!/^notehead/.test(syms[i].code)) continue;
      const cy = syms[i].box.y + syms[i].box.h / 2;
      let g0 = groups[0];
      let d = Infinity;
      for (const g of groups) {
        const dd = Math.max(0, g.lines[0].y - cy, cy - g.lines[4].y);
        if (dd < d) (d = dd), (g0 = g);
      }
      // 落在第一加线上（离外线 0.75~1.25 格）的空心头：穿过头心那条加线（上下 0.3 格内）连着头的横墨要有 `FIRST_LEDGER_RUN` 格长
      //（头宽加两侧伸出的加线）。谱表上方说明文字里的「n」拱形围出内腔，收成空心头读成 A5 全音符（宁静的伯利恒每页一两个），
      // 字里最长的横笔不到一格
      if (d > sp * 0.75 && d <= sp * LEDGER_CHAIN_FROM && syms[i].code !== "noteheadBlack") {
        const b = syms[i].box;
        const cx = Math.round(b.x + b.w / 2);
        const ly = cy < g0.lines[0].y ? g0.lines[0].y - sp : g0.lines[4].y + sp;
        let best = 0;
        for (let y = Math.round(ly - sp * 0.3); y <= Math.round(ly + sp * 0.3); y++) {
          if (y < 0 || y >= raster.bin.h) continue;
          const on = (x: number) => x >= 0 && x < raster.bin.w && !!raster.bin.data[y * raster.bin.w + x];
          // 从头心往两边各走到断开（容一像素的缝）
          let l = cx, r = cx;
          while (on(l - 1) || on(l - 2)) l--;
          while (on(r + 1) || on(r + 2)) r++;
          if (on(cx) || on(cx - 1) || on(cx + 1)) best = Math.max(best, r - l + 1);
        }
        if (best < sp * FIRST_LEDGER_RUN) syms.splice(i, 1);
        continue;
      }
      if (d <= sp * LEDGER_CHAIN_FROM) continue;
      // 加线链：谱表外线到头之间每隔一格（上下容 0.3 格）一条横墨，头心左右各 0.5 格里够 0.9 格长
      const b = syms[i].box;
      const cx = b.x + b.w / 2;
      const dir = cy < g0.lines[0].y ? -1 : 1;
      const edgeY = dir < 0 ? g0.lines[0].y : g0.lines[4].y;
      let chain = true;
      for (let k = 1; k * sp < d - sp * 0.25; k++) {
        const ly = edgeY + dir * k * sp;
        let ok = false;
        for (let y = Math.round(ly - sp * 0.3); y <= Math.round(ly + sp * 0.3) && !ok; y++) {
          if (y < 0 || y >= raster.bin.h) continue;
          let run = 0;
          for (let x = Math.round(cx - sp * 0.5); x <= Math.round(cx + sp * 0.5); x++) if (x >= 0 && x < raster.bin.w && raster.bin.data[y * raster.bin.w + x]) run++;
          ok = run >= sp * 0.9;
        }
        if (!ok) {
          chain = false;
          break;
        }
      }
      if (!chain) syms.splice(i, 1);
    }
  }
  // ── 同一个头被两路各认一次：只留先认的那个 ─────────────────────────────────
  //
  // 按内腔找的空心头（`stacked`）不认领块，拆块、碎块并字典、判头各路在同一块上会再认一遍
  //（天父世界歌伴奏 m2 G4/D4 二分、高举主大能 m8 C4 全音符，两个头盒差 0~4 像素），
  // 各出一个音。**两声部同音**是另一回事：图上只有一个头，出两个音在建音符时按两根干做（`splitUnisons`），
  // 这里去的是符号层的重复，不碍那一步。
  {
    const cx = (b: Rect) => b.x + b.w / 2;
    const cy = (b: Rect) => b.y + b.h / 2;
    const kept: RasterSym[] = [];
    for (let i = 0; i < syms.length; i++) {
      const s0 = syms[i];
      if (!/^notehead/.test(s0.code)) continue;
      if (kept.some((k) => Math.abs(cy(k.box) - cy(s0.box)) < unit.space * DUP_HEAD_DY && Math.abs(cx(k.box) - cx(s0.box)) < unit.space * DUP_HEAD_DX)) {
        syms.splice(i--, 1);
        continue;
      }
      kept.push(s0);
    }
  }
  // 行中的谱号只信「行中换谱号」那一路验过的：字典按块查出来的行中「谱号」多是误认（万古磐石歌八分二度连干带尾认成高音谱号），
  // 从前每行只用行首那个、它们不起作用；现在音高按位置取谱号，留着就把后半行读错
  for (let i = syms.length - 1; i >= 0; i--) {
    const s0 = syms[i];
    if (!isClef(s0.code) || midClefs.has(s0)) continue;
    const cy = s0.box.y + s0.box.h / 2;
    const g = groups.find((q) => cy > q.lines[0].y - unit.space && cy < q.lines[4].y + unit.space);
    if (g && s0.box.x >= Math.max(...g.lines.map((l) => l.left)) + unit.space * MID_CLEF_FROM) syms.splice(i, 1);
  }
  const headBoxes = syms.filter((s0) => /notehead/i.test(s0.code)).map((s0) => ({ box: s0.box }));

  const pg = buildRasterPage({
    index,
    width: raster.bin.w,
    height: raster.bin.h,
    unit,
    // **只把分好组的那些线交下去**。`findStaves` 会拿 segs 自己再分一次组，
    // 而没进组的线里混着**通长的加线**（八度跑动共用的那条，实测宁静 p5
    // y=1004、x[244,1906]），它会顶掉真正的第五线、把整行谱上移一条线
    // ——那一行的音高整段低两级。分组那一步已经按「五条线左缘要一致」把它挡掉了，
    // 这里就别再把它递下去。
    staffLines: groups.flatMap((g) => g.lines),
    // 符头剪出来的加线要一并推进去，`findLegers` 才有得判
    // **没成组的那些行投影线要当加线用**，不能整个丢掉：密集八度跑动上方那一排短加线
    // 被行投影连成一条通长的线，它不是谱线（左缘对不上，见 `groupStaves`），
    // 但确实是加线——丢了的话上方那些符头一条加线都没有、`findLegers` 全判否，
    // 认出来的符头一个都归不了谱行（实测宁静 p5 那七个 C6 就是这样）。
    // 交给 `sharedLegers` 按符头切成短段，长度才过得了 `findLegers` 那道闸。
    hSegs: [
      ...prims.hSegs,
      ...heads.map((h) => h.ledger).filter((l): l is NonNullable<typeof l> => !!l),
      // **所有认出来的符头都要参与切加线**，不只 `findRasterHeads` 那一批：
      // 按内腔找出来的（`stacked`）、拆块拆出来的（`split`）也压在加线上。
      // 少了它们，那些头的加线是按**邻居**切的、盖不住自己，`findLegers` 就判否
      // ——实测宁静钢琴右手 663 个带内符头只归属 574 个，差的 89 个几乎全是
      // 谱表上方一到两格、等着加线撑的那些。
      ...sharedLegers([...prims.hSegs, ...strayLines], headBoxes, onGrid, unit),
      // **骑在加线上的符头，自己那条加线要补出来。**
      // 它压在符头底下，`findPrimitives` 抽不出来（那一带的纵向游程是整个符头的高度）；
      // `trimLedger` 只给 `findRasterHeads` 那一批补，按内腔找出来的、拆块拆出来的都没有。
      // 于是谱表外一到两格的音「符头认出来了却挂不上谱行」——实测宁静钢琴右手
      // 120 个未归属的头里 89 个是这一类。
      // **要验墨**：那一带真有一条横墨才补，不然等于把 `findLegers` 那道防线拆了。
      ...ownLegers(headBoxes, raster.bin, onGrid, unit),
    ],
    // 符干要**续到符头里**才与符头纵向相交（`findStems` / `buildStems` 的硬判据）。
    // 续过的段只进 `SPage`，不回写 `prims`——`findBlobs` 那边仍按原段抹墨，
    // 免得把符头啃掉（见 `extendVSegs` 的说明）。
    // 被并进升降号的竖段要摘掉（留着会被当成符干或小节线）
    vSegs: snapHeadsToStems(syms, splitVoiceStems(extendVSegs(
      nl,
      joinThroughBars(raster.bin, joinVSegs(nl, [...prims.vSegs.filter((v) => !usedSegs.has(v)), ...stemSegs, ...inkStems], VSEG_JOIN_DX, Math.round(unit.space * VSEG_JOIN_GAP)), groups.map((g) => [g.lines[0].y, g.lines[4].y] as [number, number]), unit.space),
      Math.round(unit.space * 0.35),
      groups.map((g) => [g.lines[0].y, g.lines[4].y] as [number, number]),
      unit.lineThick,
    ), headBoxes.map((h) => h.box), unit), unit),
    syms,
    braces: findBraces(nl, prims, unit, staffLefts, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y }))).map((c) => c.bbox),
    sysBrackets: groupByLeftInk(raster.bin, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y, left: Math.max(...g.lines.map((l) => l.left)) })), unit),
  });
  if (!findStaves(pg)) return empty(pg, raster, unit, opts.carryTime, opts.carryKey);
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
  const clefTally = shareOctaveClefs(pg, ctx, opts.carryKey?.clefs);
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
  extendKeyByCarry(ctx, opts.carryKey, raster.bin, unit.space);
  findMidKeysByTemplate(pg, ctx, raster.bin, unit);
  shareMidKeys(pg, ctx, unit.space);
  shareTimeSignature(pg, ctx, timeCols, unit, raster.bin, !!opts.carryTime);
  dropBarsInKey(pg, ctx, unit.space);
  keyFromChords(pg, ctx, harmonies.map((h) => h.text), unit);
  fixFlatReadAsSix(harmonies, ctx);
  makeSystems(pg);
  makeBars(pg);
  // 反复记号、房子、同系统的小节线样式（`repeats.ts`）：下游按线宽与圆点符号认，位图路两样常缺，回到图上量
  for (const b of markRepeatsAndVoltas(pg, raster.bin, cmap, unit.space)) ledger.claim(b, "repeat:dot");
  // 段的认领：**只记挂上标记的**（谱线/加线/符干/小节线/系统线/符尾）。
  // 没挂上标记的段是「抽出来了却没人要」的，留着当无主，那才是线索。
  for (const sg of pg.segs) {
    const tag = SEG_TAGS.find((t) => sg.hasTag(t));
    if (tag) ledger.claim({ x: sg.box.left, y: sg.box.top, w: sg.box.right - sg.box.left, h: sg.box.bottom - sg.box.top }, `seg:${tag}`);
  }
  // **谱线、加线上挨着符头的薄条不算杠的层数**：线压着符头、被头的墨撑厚成三四像素，过了符杠那道闸
  //（我一生要赞美你 m5–6 第五线上的 D4，八分读成十六分）。照旧留在 `prims.beams` 里抹墨（过检的杠是承重的，
  // 直接丢掉该曲音符 −5.2），只是不交给下游数层数。真杠约半格厚、离头两三格
  //（斜的网点杠只检出靠线的一片时也薄，所以要「挨着头」：大地风光 m1）
  const noteHeads = pg.symbols.filter((s0) => s0.hasTag("Note") && /^notehead/.test(s0.code));
  const thinOnLine = (b: BeamQuad) => {
    if (b.box.h > unit.space * THIN_BEAM_H) return false;
    const cy = b.box.y + b.box.h / 2;
    if (!onGrid(cy) && !gridYs.some((ly) => Math.abs(ly - cy) <= unit.lineThick + 1)) return false;
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
  snapBeamEnds(beams, pg.segs.filter((sg) => sg.isV && sg.hasTag("Stem")), raster.bin, unit.space);
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
      if (gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick / 2 + 1)) continue;
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
  // **大半落在符尾盒里的头不要**：同一块墨先被收成头、后又被符尾自举认成符尾（《所信有根基》八分的尾读成一个 A4 二分）
  {
    const flags = pg.symbols.filter((s0) => s0.hasTag("Tail"));
    const inFlag = (h: Sym) => flags.some((f) => {
      const w = Math.min(h.box.right, f.box.right) - Math.max(h.box.left, f.box.left);
      const hh = Math.min(h.box.bottom, f.box.bottom) - Math.max(h.box.top, f.box.top);
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
    const walled = (h: Sym) =>
      stemWalledCavity(raster.bin, { x: Math.round(h.box.left), y: Math.round(h.box.top), w: Math.round(h.box.right - h.box.left), h: Math.round(h.box.bottom - h.box.top) }, sp0);
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
  // 超出最外一条加线 0.9 格的不管（照旧按线距外推）
  {
    const sp0 = unit.space;
    const B = raster.bin;
    const legers = pg.segsWithTag("Leger").filter((sg) => sg.isH);
    for (const h of pg.symbols) {
      if (!h.hasTag("Note") || !/^notehead/.test(h.code) || !h.ownerStaff || h.ownerStaff.lineYs.length !== 5) continue;
      const stf = h.ownerStaff;
      const hx = (h.box.left + h.box.right) / 2;
      const ys = stf.lineYsAt ? stf.lineYsAt(hx) : stf.lineYs;
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
      const spL = (ys[4] - ys[0]) / 4;
      const grid = [edge];
      const ly = legers
        // 加线比头宽，至少一侧伸出头外：只在头里面的横墨是粗体头自己的笔画（我一生要赞美你）
        .filter((sg) => sg.left < h.box.right + sp0 * 0.3 && sg.right > h.box.left - sp0 * 0.3)
        .filter((sg) => sg.left <= h.box.left - sp0 * 0.15 || sg.right >= h.box.right + sp0 * 0.15)
        .map((sg) => (sg.y0 + sg.y1) / 2)
        .filter((y) => (y - edge) * out > sp0 * 0.5 && (y - yc) * out < sp0 * 0.5)
        .sort((p, q) => (p - q) * out);
      for (const y of ly) {
        const last = grid[grid.length - 1];
        const d = (y - last) * out;
        if (d < sp0 * 0.5) continue; // 同一条加线拆成的几段
        // 间距要像一格：近了是别的横墨，远了是中间缺了一条，往外的都不可靠
        if (d < spL * 0.8 || d > spL * 1.25) break;
        grid.push(y);
      }
      let pos = -1; // 从边线往外的半格数
      const gapAt = (i: number) => (i + 1 < grid.length ? (grid[i + 1] - grid[i]) * out : i > 0 ? (grid[i] - grid[i - 1]) * out : sp0);
      let j = 0;
      for (let i = 1; i < grid.length; i++) if (Math.abs(yc - grid[i]) < Math.abs(yc - grid[j])) j = i;
      const dj = (yc - grid[j]) * out;
      if (Math.abs(dj) <= gapAt(j) * 0.25) pos = j * 2;
      else if (dj > 0) pos = j + 1 < grid.length || dj < sp0 * 0.9 ? j * 2 + 1 : -1;
      else pos = j > 0 ? j * 2 - 1 : -1;
      if (pos < 0) continue;
      // 换成这一级的理想 y，交给 `middleStep` 读；级数没变的不动（临时记号按 py 配对，挪了会配岔：信心使我得胜）
      const py = edge + (out * (pos * spL)) / 2;
      if (stf.middleStep(py, hx) !== stf.middleStep(h.py, hx)) h.py = py;
    }
  }
  const notes = buildNotes(pg, ctx, beams, stems, hollowish);
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
  attachAccidentalsByPitch(pg, ctx, notes);
  naturalsByStrokes(pg, ctx, notes, raster.bin, unit.space);
  splitUnisons(notes, stems, beams, raster.bin, unit.space);
  markCrossStaff(pg, notes, stems, unit.space);
  fixDottedPairs(notes, unit.space);
  fixQuartersByBarSum(pg, ctx, notes, opts.carryTime, unit.space);
  findTuplets(pg, beams, stems, notes);

  // ── 演奏法与力度 ─────────────────────────────────────────────────────────
  //
  // 这三步矢量路一直在跑（`staffomr/index.ts`），位图路**从来没调过**——所以力度
  // 一个都没进过 MusicXML，而字典其实早就认得出：实测宁静 p2 那个 `f`
  // 到 Maestro 的 `dynamicForte` 模板只有 19（字典里 `dynamicForte` 26 个实例、
  // `dynamicMP` 8 个）。缺的只是这一句挂接。
  const marks = findNotations(pg);
  // 贴着符头的那几样（保持音、断奏、重音）不按「x 最近」挂：字典里叫 `articTenuto*` 的九成是谱线残段，
  // 留给后面的 `findRasterArticulations` 按与符头的关系判
  const articSyms = marks.marks.filter((m) => /^artic/.test(m.code));
  attachNotations(pg, notes, marks.marks.filter((m) => !/^artic/.test(m.code)));
  // 琶音记号挂到它右边那一列和弦上：纵向落在波浪线范围里（上下各容半格多）、横向在线右 `ARP_REACH` 格内最靠左的那一列
  for (const b of arpeggios) {
    const sp = unit.space;
    const near = notes.filter((n) => !n.rest && n.sym.box.left >= b.x + b.w - sp * 0.3 && n.sym.box.left <= b.x + b.w + sp * ARP_REACH && n.sym.py >= b.y - sp * 0.6 && n.sym.py <= b.y + b.h + sp * 0.6);
    if (!near.length) continue;
    const x0 = Math.min(...near.map((n) => n.sym.box.left));
    for (const n of near) if (n.sym.box.left <= x0 + sp * 1.4) n.marks = [...(n.marks ?? []), "arpeggiato"];
  }
  // `mf` 印出来是**两个字母**，字典只认得出 `f`——先按版式把一串字母拼起来
  // （`dynamics.ts`），再按力度文本挂接，不走 `attachDynamics` 那条按单个 SMuFL 名的路。
  const dynamics = groupDynamics(marks.dynamics, cmap, unit);
  attachDynamicTexts(pg, notes, dynamics);

  // ── 声部标签 ────────────────────────────────────────────────────────────
  //
  // 条子**不论有没有缓存都要切**（与歌词字格同一条道理：切出来这件事本身
  // 就是「这块墨是标签」的判断）；认字靠 `labelOcr` 缓存，没缓存就只出条子。
  const labelStrips = findStaffLabels(raster.bin, pg.staves, unit);
  const staffLabels = new Map<number, string>();
  for (const st of labelStrips) {
    const txt = opts.labelOcr?.get(labelKey(st));
    const name = txt ? normalizeLabel(txt) : null;
    if (name) staffLabels.set(st.staff, name);
  }

  // ── 和弦：挂到音符上 ────────────────────────────────────────────────────
  //
  // 记号在上面（找符头之前）就切好了，这里只把它们造成文本对象交给矢量路那一套
  // ——分行、拼根音与后缀、挂给**下方 x 最近**的音符，一行不改。
  if (harmonies.length) {
    const objs = harmonies.map((t, i) =>
      makeTextObj(pg.objs.length + i, { cells: [{ box: t.box, ch: t.text }], sizeDev: t.box.h }));
    for (const o of objs) o.addTag("Harmony");
    pg.objs.push(...objs);
    // `merge = false`：记号已经按和弦文法切好了，别再按左右相接拼一次
    attachHarmonies(pg, notes, objs, false);
    liftHarmonies(notes, pg.normalStaffSpace || pg.space);
  }

  // ── 歌词 ────────────────────────────────────────────────────────────────
  //
  // **不走 `analyzeText`**：那一步靠「带连字符的音节」「音节间的延长线」当锚点
  // 把文本认成歌词，中文逐字一个音节、既不连字也不拉线，一整行一个锚点都没有。
  // 位图这边本来就是**按位置**切出歌词带的（谱行下方那条带），身份已经确定，
  // 直接造成文本对象交给 `buildLyricLines` / `attachLyrics`——那两步原样跑。
  const lyricLines: LyricLine[] = [];
  const lyricStats = { rows: 0, hit: 0, parity: 0 };
  const lyricStrips: LyricStrip[] = [];
  // 字格**不论有没有 OCR 缓存都要切**：切出来的字格是「这块墨是歌词」这一判断本身，
  // 与认不认得出那个字是两回事。账本按字格记一笔，无主表里才不会把整页歌词
  // 当成「从没看见的墨」（缓存没命中时曾经就是这样，覆盖率一下子低二十个点）。
  {
    // **认领了却没落成音符的「符头」也还给歌词**：歌词字的笔画（点、口字框）常被收成符头，
    // 归不上谱表又被扔掉，可认领还在，那一格字就从歌词行里缺了
    //（《善牧恩慈歌》第 4 段行首的「主」整字没了）。只看最终的音符在不在块里，不看 OCR，
    // 条子才与离线生成缓存时切得一模一样。
    const noteCenters = notes.map((n) => ({ x: (n.sym.box.left + n.sym.box.right) / 2, y: (n.sym.box.top + n.sym.box.bottom) / 2 }));
    const orphanHead = (c: Component) =>
      claimed.has(c.id) && !restIds.has(c.id) && !harmonyIds.has(c.id) && !titleIds.has(c.id) &&
      !noteCenters.some((p) => p.x >= c.bbox.x - 1 && p.x <= c.bbox.x + c.bbox.w + 1 && p.y >= c.bbox.y - 1 && p.y <= c.bbox.y + c.bbox.h + 1);
    // **没人要的横段、竖段也是歌词的笔画**：「一」整字、「下」「生」的横笔、「上」的竖笔
    // 被原语那一步当成线段抽走，不成块，字格里就缺了那个字（《赞美一神》两行各缺一两个）。
    // 挂上了标记的（谱线、加线、符干、小节线、符杠……）不算。
    const segBlobs: Component[] = pg.segs
      .filter((sg) => !sg.hasAnyTag())
      .map((sg, k) => {
        const b = { x: Math.round(sg.box.left), y: Math.round(sg.box.top), w: Math.max(1, Math.round(sg.box.right - sg.box.left)), h: Math.max(1, Math.round(sg.box.bottom - sg.box.top)) };
        return { id: -1 - k, bbox: b, area: b.w * b.h, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
      });
    const rows = findLyricRows(
      [...blobs.filter((c) => (!claimed.has(c.id) || orphanHead(c)) && !dictClaimed.has(c.id)), ...segBlobs],
      pg.staves.map((st) => ({ top: st.box.top, bottom: st.box.bottom, left: st.box.left, right: st.box.right })),
      unit,
    );
    // **谱表上方文字行里的假音**：系统行首谱表上方印的「（副歌）」之类小字，圈状的笔画被认成符头
    //（新编赞美诗里四十来首在副歌那一行行首多出一个 D6；加线是按头的位置补出来的，查加线拦不住）。
    // 系统最上面那行谱、头心高出第五线 1.25 格以上、又落在一条文字行的字格跨度里的，是字不是音。
    {
      // 要落在**某一个字格里**（不是整行的跨度里），且那一行是六个字以内的短标签：合唱谱上一个系统最末一行歌词、
      // 速度术语就在下一个系统最上面那行谱的上方，按行跨度判会罩住女高上加线的真音（合唱谱扫描档音符 80.7 → 75.1；
      // 只限短标签、仍按跨度判 79.9）
      const spans = rows.filter((row) => row.cells.length >= 2 && row.cells.length <= 6).flatMap((row) => row.cells.map((c) => ({ x0: c.x, x1: c.x + c.w, y0: c.y, y1: c.y + c.h })));
      const pad = unit.space * 0.1;
      const topStaves = new Set(pg.systems.map((sy) => sy.staves[0]));
      const inText = (n: StaffNote) => {
        // 只看系统最上面那行：下面那行的上方就是歌词，男高的 D4、E4 带着上加线正落在歌词行的跨度里
        if (n.rest || !topStaves.has(n.staff)) return false;
        const bx = n.sym.box;
        const cx = (bx.left + bx.right) / 2;
        const cy = (bx.top + bx.bottom) / 2;
        if (cy > n.staff.box.top - unit.space * 1.25) return false;
        return spans.some((q) => cx >= q.x0 - pad && cx <= q.x1 + pad && cy >= q.y0 - pad && cy <= q.y1 + pad);
      };
      for (let i = notes.length - 1; i >= 0; i--) if (inText(notes[i])) notes.splice(i, 1);
    }
    for (const row of rows) for (const cell of row.cells) ledger.claim(cell, "lyric");
    const objs = [];
    const ocr = opts.lyricOcr;
    lyricStats.rows = rows.length;
    const stripRow = new Map<LyricStrip, LyricRow>();
    for (const row of rows) {
      const strip = stripOf(nl, row, 2, raster.lyricGray ?? raster.gray);
      if (strip) {
        lyricStrips.push(strip);
        stripRow.set(strip, row);
      }
    }
    /** OCR 认得出字的歌词行（剔「字的笔画被收成符头」要用，见下）。 */
    const readRows: LyricRow[] = [];
    const latinRows = new Set<LyricRow>();
    // 本页歌词条字高的中位数（只算命中缓存的条）：页脚小字与歌词字号差着三倍
    const hitH = (ocr ? lyricStrips : []).filter((st) => ocr!.get(stripKey(st))).map((st) => st.charH).sort((a, b) => a - b);
    const medH = hitH.length ? hitH[hitH.length >> 1] : 0;
    // **拉丁行的连字符闸只卡种子**：同一谱行下、上下紧挨着（2.5 个字高以内）一条带连字符的拉丁行的，
    // 过得了前两道闸就不要连字符——整行单音节词的歌词行常有（《奇异恩典》四段英文一半行没有连字符，
    // 漏掉的行让后面各段整体错位，拉丁歌词 20%）。书眉不会紧挨着歌词块；版权行会（晨曦破晓末行下面），
    // 但字号小：比相邻拉丁行矮两成半以上的不链
    // （原来卡两成，父恩广大末系统英文第 1 行字高 20、邻行 26，没连字符又链不进来，英文 2~4 段整体前移，拉丁 69.4 → 94.3%）。
    const latinStrips = new Set<LyricStrip>();
    {
      // 表情文字行（「poco rit.」「a tempo」「unis.」「molto cresc.」）字号与歌词一样、又夹在歌词行之间，种子、链入都会把它收进来；带这些术语的不收
      const cand = (ocr ? lyricStrips : []).filter((st) => { const ch = ocr!.get(stripKey(st)); return ch && isLatinRow(ch, false, LATIN_MIN_CHAINED) && !DIRECTION_TERM_RE.test(ch.map((c) => c.ch).join("")); });
      for (const st of cand) if (isLatinRow(ocr!.get(stripKey(st))!)) latinStrips.add(st);
      const yOf = (st: LyricStrip) => Math.min(...stripRow.get(st)!.cells.map((c) => c.y));
      // **紧挨着一行中文歌词的也是种子**（不要连字符，字母仍要够 `isLatinRow` 的下限）：中英对照谱英文行就印在中文行下面，
      // 一整行单音节词常见（望十架 p3「love. Face the cross, He dies to set us free.」两行整行丢了）。
      // 书眉、版权行旁边没有中文歌词行；字高比中文行矮一半以上的（页脚小字）不算
      const cjkStrips = (ocr ? lyricStrips : []).filter((st) => {
        const ch = ocr!.get(stripKey(st));
        const n = ch ? ch.filter((c) => /[\u4e00-\u9fff]/.test(c.ch)).length : 0;
        return n >= CJK_SEED_MIN && n >= ch!.length * 0.6;
      });
      for (const st of cand) {
        const chs = ocr!.get(stripKey(st))!;
        if (latinStrips.has(st) || !isLatinRow(chs, false)) continue;
        const r = stripRow.get(st)!;
        if (cjkStrips.some((o) => stripRow.get(o)!.staffIndex === r.staffIndex && st.charH >= o.charH * 0.5 && Math.abs(yOf(o) - yOf(st)) <= Math.max(o.charH, st.charH) * LATIN_CHAIN)) latinStrips.add(st);
      }
      for (let grew = true; grew; ) {
        grew = false;
        for (const st of cand) {
          if (latinStrips.has(st)) continue;
          const r = stripRow.get(st)!;
          if ([...latinStrips].some((o) => stripRow.get(o)!.staffIndex === r.staffIndex && st.charH >= o.charH * 0.75 && Math.abs(yOf(o) - yOf(st)) <= Math.max(o.charH, st.charH) * LATIN_CHAIN)) {
            latinStrips.add(st);
            grew = true;
          }
        }
      }
    }
    /** 行首印着段号的歌词对象。 */
    const verseObjs = new Set<PObj>();
    for (const strip of ocr ? lyricStrips : []) {
      const chars = ocr!.get(stripKey(strip));
      if (!chars) continue; // 缓存没命中：这一条没跑过 OCR，宁可留空不编造
      lyricStats.hit++;
      // **页脚小字不是歌词**：赞美三一真神末行下面的版权行（字高 12，歌词 34~41）离低音谱表
      // 不到两个谱表高，被收成男声的第 1 段
      if (strip.charH < medH * LYRIC_MIN_H) continue;
      // **三格以内、认不出一半字的条不收**：谱表紧下方带加线的低音被切成一条（赞美三一真神
      // 末系统 3 格只认出一个「户」），占掉第 1 段，后面四段整体下移一段
      if (strip.cells.length <= 3 && foldLyricChars(chars).length < strip.cells.length * 0.5) continue;
      // **拉丁行绕开字格**：字格那一套是按汉字等宽见方切的，英文词宽差着数倍。
      // 逐字造盒、按间距补词间空格，断词断音节交给 `splitSyllables`（见 `lyric.ts`）。
      const latin = latinStrips.has(strip);
      // 拉丁行也算：齐来称颂英文第一行紧贴低音谱表，「we」的 e 被收成空心符头，还配上了加线
      if (latin || chars.some((c) => /\p{Script=Han}/u.test(c.ch))) readRows.push(stripRow.get(strip)!);
      if (latin) latinRows.add(stripRow.get(strip)!);
      // **只认出一个字的不是歌词行**：谱表与歌词之间的一横被切成一条、认成「一」，占掉第 1 段，
      // 后面几段整体下移（《高举主大能》第二系统）
      // 行里的笔画照样当字剔（上面已进 `readRows`），只是不出歌词：直接跳过的话，那一行被收成符头的
      // 笔画留下来成了假音（齐来称颂 −1.3、父恩广大 −0.6）
      if (!latin && foldLyricChars(chars).length <= 1) continue;
      // **中英混在一条的切成两份**，各出一个文本对象（见 `splitMixedChars`）：拉丁那份归英文段
      const mix = splitMixedChars(chars);
      const parts = mix
        ? [latinCells(strip, mix.la), mapCharsToCells(stripWithout(strip, mix.spans), mix.zh)]
        : [latin ? latinCells(strip, chars) : mapCharsToCells(strip, chars)];
      // 「字数 == 格数」这个结构指标只对汉字行有意义（拉丁行压根不切格）
      if (!latin && !mix && foldLyricChars(chars).length === strip.cells.length) lyricStats.parity++;
      // 行首印着段号（「1.」「2、」）：OCR 读出来、折叠时剔掉了，这里记一笔——段号是歌词的强判据（`lyricsBelongBelow`）
      // 只认一位数：页顶标题前的诗歌编号（有一位神「23.有一位神」）也是「数字 + 点」
      const verseNo = /^[1-9][.．、]/.test([...chars].sort((a, b) => a.xFrac - b.xFrac).map((c) => c.ch).join(""));
      for (const cells of parts) {
        if (!cells.some((c) => c.ch)) continue;
        const o = makeTextObj(pg.objs.length + objs.length, { cells, sizeDev: strip.charH });
        o.addTag("Lyric");
        objs.push(o);
        if (verseNo) verseObjs.add(o);
      }
    }
    pg.objs.push(...objs);
    // **歌词行里的「符头」是字的笔画**：歌词离谱表近的底本（《是谁》第一段歌词只在谱表下
    // 1.8 格），字里的横笔被当成加线、口字框被当成符头，认成谱表下五六条加线的 G3/C3
    // ——一行两三个，整首十来个假音。只剔**认得出汉字**的那几行、**中心**落在行内的；
    // 真的低音符头中心离谱表不过一两格，碰不到歌词行（行上沿在谱表下 1.8 格）。
    if (readRows.length) {
      const inRow = (n: StaffNote) => {
        const cx = (n.sym.box.left + n.sym.box.right) / 2;
        const cy = (n.sym.box.top + n.sym.box.bottom) / 2;
        // 谱表**上方**也一样：两行谱之间的词归上一行谱，可字的笔画被收成头时落到了下一行谱的上加线区
        //（倚靠主永远膀臂 m3「穌」、大地风光 m3「愛」，低音谱表上方 2.4 格的空心头）
        const below = cy >= n.staff.box.bottom + unit.space;
        // 上方只看两格开外：一两格上的是上加线的真音，上一行谱的歌词紧贴着它（当我们回到天家末行八个高音、−2.7）
        // 只剔空心头（字里的口字框才围得出内腔）：实心的多半是高声部的真音（合唱谱扫描档 −0.15）
        if (!below && (cy > n.staff.box.top - unit.space * 2 || n.sym.code === "noteheadBlack")) return false;
        // 中心要落在（贴着）某个字格上：字被拆散时，剩下的笔画就在旁边成了字格；
        // 真的低音符头旁边没有字格压着（合唱谱谱表间距窄，歌词行离低音符头常只有一格，
        // 只看「落在行里」实测会误删真音）
        const pad = (r: LyricRow) => r.charH * 0.25;
        return readRows.some((r) => {
          const top = Math.min(...r.cells.map((c) => c.y));
          const bot = Math.max(...r.cells.map((c) => c.y + c.h));
          if (cy <= top || cy >= bot) return false;
          // 拉丁行：字母被收成符头之后就不在字格里了（「we」的 e），落在行的左右端之内就算
          if (latinRows.has(r)) return cx > Math.min(...r.cells.map((c) => c.x)) && cx < Math.max(...r.cells.map((c) => c.x + c.w));
          // **残格按整行高判**：字的上半截被收成符头时，那一格只剩下半截（我灵镇静第三行「萬」，
          // 残格高 15、字高 40，头中心在残格上方 7px、谱表下 2.4 格，按残格判就漏了）。
          // 只放宽不到字高六成的格、且头在谱表下两格开外：一律按整行高判，齐来称颂、齐来谢主歌各误删一个
          // 真的低音；合唱谱破碎两处谱表下一格的加一线音也被删
          const far = below ? cy >= n.staff.box.bottom + unit.space * 2 : cy <= n.staff.box.top - unit.space * 2;
          return r.cells.some((c) => {
            const [y0, y1] = far && c.h < r.charH * 0.6 ? [top, bot] : [c.y, c.y + c.h];
            return cx > c.x - pad(r) && cx < c.x + c.w + pad(r) && cy > y0 - pad(r) && cy < y1 + pad(r);
          });
        });
      };
      for (let i = notes.length - 1; i >= 0; i--) {
        if (!inRow(notes[i])) continue;
        // 删的是和弦主音：下一个成员接任，否则它挂着 chordExtra 并到前一个音（休止）上（是谁 m1 E4，主音是「是」字上收出的头）
        const next = notes[i + 1];
        if (!notes[i].chordExtra && next?.chordExtra && next.staff === notes[i].staff) next.chordExtra = undefined;
        notes.splice(i, 1);
      }
    }
    lyricLines.push(...buildLyricLines(pg, objs, undefined, (row) => lyricsBelongBelow(row, verseObjs, notes, unit.space)));
    foldBilingualLyrics(pg, lyricLines);
    moveEchoLines(pg, lyricLines, notes, unit.space);
    splitVoiceLyrics(pg, lyricLines, notes, unit.space);
    numberVersesByScript(pg, lyricLines);
    attachLyrics(notes, lyricLines, unit.space * 0.3);
    liftLyrics(pg, notes, unit.space);
  }

  // ── 拍号兜底：整页一个拍号都没认出、前页也没传下来 ─────────────────────────
  //
  // 拍号数字认不出来是常事（铅字本的「4」比模板窄一截，见上面拍号那一段的「分子至少是 2」），
  // 缺了它写出来的 MusicXML 就没有 `<time>`。按**第一声部每小节的时值和**取众数推一个 n/4，
  // 造成两个拍号数字放进首行的 ctx——写出端、跨页传递（`lastTimeSignature`）照常走。
  // 只推 2~9 拍的整拍（拍号字形只有一位数），至少要三个小节撑着。
  if (!opts.carryTime && pg.staves.every((st) => !(ctx.get(st)?.time.length))) {
    const sums: number[] = [];
    for (const st of pg.staves)
      for (const bar of st.bars) {
        const q = notes
          .filter((n) => n.staff === st && n.voice === 1 && !n.chordExtra && !n.grace && n.x >= bar.left && n.x < bar.right)
          .reduce((a, n) => a + n.duration * 4, 0);
        if (q > 0) sums.push(Math.round(q * 4) / 4);
      }
    const count = new Map<number, number>();
    for (const q of sums) count.set(q, (count.get(q) ?? 0) + 1);
    const ranked = [...count].filter(([q0]) => Number.isInteger(q0) && q0 >= 2 && q0 <= 9).sort((a, b) => b[1] - a[1]);
    // 4/4 是下游本来就缺省的拍号：证据不反对（4 拍的小节不少于最多那档的八成）就写它；
    // 别的拍数要明显压过第二名才采信——多声部谱认错的音会把小节和撑得五花八门
    //（《善牧恩慈歌》低音谱表那几行，4 拍与 5 拍各六个小节）
    const n4 = count.get(4) ?? 0;
    let q = 0;
    if (ranked.length && n4 >= 3 && n4 >= ranked[0][1] * 0.8) q = 4;
    else if (ranked.length && ranked[0][1] >= 3 && ranked[0][1] >= (ranked[1]?.[1] ?? 0) * 1.5) q = ranked[0][0];
    const first = pg.staves[0];
    const c0 = first && ctx.get(first);
    if (c0 && q) {
      const x = (c0.key.length ? Math.max(...c0.key.map((s0) => s0.box.right)) : (c0.clef?.box.right ?? first.box.left)) + unit.space * 0.5;
      const mid = (first.box.top + first.box.bottom) / 2;
      const w = unit.space;
      const up = makeSymObj(pg.objs.length, { box: { x, y: Math.round(first.box.top), w, h: Math.round(mid - first.box.top) }, code: `timeSig${q}` as SmuflName }, first.box.bottom - first.box.top);
      const dn = makeSymObj(pg.objs.length + 1, { box: { x, y: Math.round(mid), w, h: Math.round(first.box.bottom - mid) }, code: "timeSig4" }, first.box.bottom - first.box.top);
      c0.time.push(up.sym, dn.sym);
      // 拍号是这里才推出来的：「按小节拍数把四分纠回八分」那一步前面因为没有拍号跳过了，补跑一遍
      fixQuartersByBarSum(pg, ctx, notes, opts.carryTime, unit.space);
    }
  }

  // ── 混排谱：简谱行给五线谱纠错 ──────────────────────────────────────────
  //
  // 放在歌词挂完之后：纠的是音高与时值，删的是简谱对不上的多余音——
  // 挂歌词那一步要看到**所有**候选音才挂得准，先删了反而让字挂错位。
  const jianpuFix = opts.jianpuOcr && jianpuStrips.length
    ? fuseJianpu(
      notes,
      jianpuStrips,
      (strip) => pg.staves.find((st) => Math.abs(st.box.top - groups[strip.staff].lines[0].y) < unit.space),
      (strip) => opts.jianpuOcr!.get(jianpuKey(strip)),
      (st) => keyFifths(ctx.get(st)?.key ?? []),
      unit,
    )
    : null;

  // ── 带方括号的三连音 ────────────────────────────────────────────────────
  //
  // 放在歌词之后：括号常落在歌词带里被字格罩住，候选是无主的加上只被歌词认过的。已经由符杠那一路标过连音的不再动。
  {
    const cands = cmap.contours.filter((c) => ledger.claimsOf(c.id).every((q) => q.by === "lyric"));
    for (const tp of findRasterTuplets(pg, cands, notes, unit.space)) {
      if (tp.notes.some((n) => n.tuplet)) continue;
      applyTuplet(tp.notes, 3);
      for (const c of tp.contours) ledger.claim(c.bbox, "tuplet");
    }
  }

  // ── 文字指示与节拍器记号 ────────────────────────────────────────────────
  //
  // 带照固定几何切（两行谱之间的空当），认字靠 `wordOcr` 缓存；歌词行、和弦字母已经另有身份，中心落在它们盒里的行不要。
  const wordStrips = opts.wordOcr || opts.wantWordStrips ? findWordStrips(raster.bin, pg.staves, unit) : [];
  // 页眉（曲首页）：标题、词曲作者。认字同文字指示带，缓存另放
  const headerStrip = opts.wantHeader ? findHeaderStrip(raster.bin, pg.staves, unit) : null;
  const headerLines = headerStrip ? opts.headerOcr?.get(wordKey(headerStrip)) : undefined;
  const header = headerStrip && headerLines ? headerCredits(headerLines, headerStrip) : [];
  if (opts.wordOcr) {
    const skip: Rect[] = [
      // 认下来的歌词行：从行顶往下两格半（`LyricLine` 只记行顶），左右以首尾音节为界
      ...lyricLines.filter((ln) => ln.syllables.length >= 3).map((ln) => {
        const l = Math.min(...ln.syllables.map((sy) => sy.left));
        const r = Math.max(...ln.syllables.map((sy) => sy.right));
        return { x: l - unit.space, y: ln.top - unit.space * 0.5, w: r - l + unit.space * 2, h: unit.space * 3 };
      }),
      ...harmonies.map((t) => ({ x: t.box.x, y: t.box.y, w: t.box.w, h: t.box.h })),
    ];
    const placed = attachWordLines(pg, notes, wordStrips, opts.wordOcr, unit, skip, lyricStrips.map((st) => st.box));
    // 文字带里读出来的和弦记号：和弦带那一路（要自己的 OCR 缓存，合唱谱没生成）没认到和弦时才用
    if (!harmonies.length && placed.chords.length) {
      const objs = placed.chords.map((t, i) => makeTextObj(pg.objs.length + i, { cells: [{ box: t.box, ch: t.text }], sizeDev: t.box.h }));
      for (const o of objs) o.addTag("Harmony");
      pg.objs.push(...objs);
      attachHarmonies(pg, notes, objs, false);
      liftHarmonies(notes, unit.space);
    }
    // OCR 读出来的力度只补按字形那一路没认到的地方（三格内已有的不重复挂）
    attachDynamicTexts(pg, notes, placed.dynamics.filter((d) => !dynamics.some((q) => Math.abs(q.px - d.px) <= unit.space * 3 && Math.abs(q.py - d.py) <= unit.space * 2)));
  }

  // ── 贴着符头的演奏法记号（保持音 / 断奏 / 顿音 / 重音 / 延长记号）──────────────
  //
  // 放在歌词之后（歌词字的点画已经有主）、松叶与弧线之前（延长记号的弧够宽够拱，不先摘走就成了一条圆滑线）。
  {
    const taken: Rect[] = pg.symbols.filter((s0) => s0.hasTag("Augmentation")).map((s0) => ({ x: s0.box.left, y: s0.box.top, w: s0.box.right - s0.box.left, h: s0.box.bottom - s0.box.top }));
    for (const a of findRasterArticulations(pg, cmap, unit, notes, articSyms, ledger.unclaimed(), taken, (id) => ledger.claimsOf(id).map((q) => q.by))) ledger.claim(a.box, `artic:${a.code}`);
  }

  // ── 松叶 ────────────────────────────────────────────────────────────────
  //
  // 只在**无主**的 contour 里找：认出来的符号不必再判一遍，而松叶从来没人认领。
  const wedges = findRasterWedges(cmap, unit, ledger.unclaimed());
  for (const wg of wedges) {
    for (const id of [wg.contourId, wg.pairedId]) {
      const c = id === undefined ? null : cmap.byId.get(id);
      if (c) ledger.claim(c.bbox, `wedge:${wg.type}`);
    }
  }
  attachWedges(pg, notes, wedges);

  // ── 弧线（圆滑线 / 连音线）────────────────────────────────────────────────
  //
  // 无主报表里最大的一类带外图形（GT 里宁静 283 条、破碎 326 条，位图路至今一条不认）。
  // 认出来之后交给矢量路现成的那一套：挂两端 → 接回跨行的 → 落到音符上，
  // `toxml` 出 `<slur>` / `<tied>`。判据与松叶正好相反（逐列一段墨、而且拱着），
  // 所以要在松叶**之后**跑，把松叶认走的先剔掉。
  // 只被符杠认过的也算：`findPrimitives` 抽的横段里混着弧的一截（够粗、够平的那段），按中心线一记账整条弧就「有主」了
  // （望十架 p3 m24 女低 E4–D4 那条）。真符杠是直的，过不了「拱」那道闸。
  // 只被谱线认过的也算：贴着线的小弧，去线时剩下的那截记在谱线账上（破碎 p2 m2 两个八分之间那条）。
  // 被歌词字格认过的也算：谱表外的弧伸进歌词带上沿，整条记在歌词账上（望十架 p3 m29 钢琴右手的延音线、p5 m40 长笛高音上方的三条）。
  // 字的弯笔（2~3 格）也过得了弧线那几道闸（高举主大能一页二十几处），但挂不上两端的音，不出东西
  const lyricArcBoxes = new Set<string>();
  const beamOnly = cmap.contours.filter((c) => {
    const cl = ledger.claimsOf(c.id);
    const ok = cl.length > 0 && cl.every((k) => k.by === "beam" || k.by === "lyric" || k.by === "seg:Staff");
    if (ok && cl.some((k) => k.by === "lyric")) lyricArcBoxes.add(`${c.bbox.x},${c.bbox.y}`);
    return ok;
  });
  const slurs = findRasterSlurs(cmap, unit, [...ledger.unclaimed(), ...beamOnly], pg.objs.length + pg.segs.length + 1000);
  for (const sl of slurs) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur");
  // 虚线弧（`slur.ts::findRasterDashedSlurs`）：无主块之外，只被歌词字格认过的短划也算（弧两头那截常落在歌词带上沿，
  // Holy, Holy, Holy m10）；上方还是下方看近旁最近的符头；离谱表四格半开外的不认（歌词带里成串的连字符）
  const dashSide = (x0: number, x1: number, y: number): "above" | "below" | null => {
    const sp = unit.space;
    if (!pg.staves.some((st) => y > st.box.top - sp * 4.5 && y < st.box.bottom + sp * 4.5)) return null;
    let best: { d: number; cy: number } | null = null;
    for (const n of notes) {
      if (n.rest) continue;
      const b = n.sym.box;
      if (b.right < x0 - sp || b.left > x1 + sp) continue;
      const cy = (b.top + b.bottom) / 2;
      const d = Math.abs(cy - y);
      if (d <= sp * 3 && (!best || d < best.d)) best = { d, cy };
    }
    return best ? (y < best.cy ? "above" : "below") : null;
  };
  const lyricOnly = cmap.contours.filter((c) => {
    const cl = ledger.claimsOf(c.id);
    return cl.length > 0 && cl.every((k) => k.by === "lyric");
  });
  const dashed = findRasterDashedSlurs([...ledger.unclaimed(), ...lyricOnly], unit, pg.objs.length + pg.segs.length + 1000 + slurs.length, dashSide);
  for (const sl of dashed) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur:dashed");
  slurs.push(...dashed);
  // 被谱线切断的小弧（`slur.ts::findSplitArcs`）：无主或只被谱线认过的碎块
  {
    const lineOnly = cmap.contours.filter((c) => {
      const cl = ledger.claimsOf(c.id);
      return cl.length === 0 || cl.every((k) => k.by === "seg:Staff");
    });
    // 线行按半个线宽判：按整个线宽，贴着线的弧身那一两行也成了「线」
    const onLine = (y: number) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick / 2 + 0.5);
    const split = findSplitArcs(cmap, unit, lineOnly, raster.bin, onLine, pg.objs.length + pg.segs.length + 1000 + slurs.length);
    for (const sl of split) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur:split");
    slurs.push(...split);
  }
  // 粘在音符上的弧（`slur.ts::findFusedSlurs`）：只看认领里有符头的那几团墨
  {
    const headBoxes: Rect[] = notes.filter((n) => !n.rest).map((n) => ({ x: n.sym.box.left, y: n.sym.box.top, w: n.sym.box.right - n.sym.box.left, h: n.sym.box.bottom - n.sym.box.top }));
    const groupsWithHeads = cmap.contours.filter((c) => ledger.claimsOf(c.id).some((k) => /^(head|stack|cluster):/.test(k.by)));
    const fused = findFusedSlurs(cmap, unit, groupsWithHeads, headBoxes, pg.objs.length + pg.segs.length + 1000 + slurs.length);
    for (const sl of fused) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur:fused");
    slurs.push(...fused);
  }
  extendArcEnds(slurs, nl, (y) => gridYs.some((ly) => Math.abs(ly - y) <= unit.lineThick), unit.space);
  attachSlurs(slurs, notes, unit.space);
  attachSlursByStem(slurs, notes, unit.space);
  // 歌词账上来的弧，挂上的端要贴着音（弧端离头外缘 `LYRIC_ARC_REACH` 格内，真弧实测 ≤1.35）：字的弯笔（「悲」「恩」的心字底、「w」的顶）
  // 离上方的音两三格（实测至少一端 ≥1.8），`attachSlurs` 的窗口够得着（当我们回到天家 m1、m5，你的信实广大 m26–30）。一端离得远就整条不挂
  for (const sl of slurs) {
    if (!lyricArcBoxes.has(`${sl.obj.box.left},${sl.obj.box.top}`)) continue;
    const far = (n: StaffNote | undefined, y: number) => !!n && (sl.above ? n.sym.box.top - y : y - n.sym.box.bottom) > unit.space * LYRIC_ARC_REACH;
    if (far(sl.from, sl.ly) || far(sl.to, sl.ry)) (sl.from = undefined), (sl.to = undefined), (sl.tie = false);
  }
  // 延音线只连相邻两个音：两端同音高、中间却夹着同一行谱上别的音的，是跨几个音的圆滑线（宁静的伯利恒 p2 m25 钢琴右手 C5…C5）
  for (const sl of slurs) {
    if (!sl.tie || !sl.from || !sl.to) continue;
    const { from, to } = sl;
    const pad = unit.space * 0.6;
    // 只数音高相近（`TIE_BETWEEN_STEPS` 个音级内）的：一行谱两个声部时，延音线中间常夹着另一声部的音（是爱 p4 m54 F5 下面的 F4、G4）。
    // 无干的（全音符）多是另一声部，不算（是爱 p5 m65）；两个声部并存时干向与起点相反的也不算（晨曦破晓 m5 D4 延音线下面的 B3）
    // 起点或终点同一时刻有反向干的音（这行谱上两个声部并存）才按干向分；单声部旋律的干随音高翻（破碎低音），不分
    const opp = (m: StaffNote) => notes.some((n) => !n.rest && n.staff === m.staff && n.stemUp !== null && m.stemUp !== null && n.stemUp !== m.stemUp && Math.abs(n.x - m.x) < pad);
    const twoVoices = opp(from) || opp(to);
    if (notes.some((n) => !n.rest && n.staff === from.staff && n.stemUp !== null && (!twoVoices || from.stemUp === null || n.stemUp === from.stemUp) && Math.abs(n.diatonic - from.diatonic) <= TIE_BETWEEN_STEPS && n.x > from.x + pad && n.x < to.x - pad)) sl.tie = false;
  }
  reconnectSlurs(pg, slurs);
  const chordTies = tieChords(slurs, notes, unit.space);
  markSlurNotes(slurs);
  for (const [a, b] of chordTies) (a.tieStart = true), (b.tieStop = true);
  markLyricExtends(notes);

  return {
    page: pg,
    hasStaff: true,
    unknown: unknownObjs(pg).length,
    unit,
    raster,
    ctx,
    beams,
    notes,
    bars: checkBars(pg, ctx, notes, opts.carryTime),
    lyricLines,
    contours: cmap,
    ledger,
    lyricStrips,
    harmonyStrips,
    jianpuStrips,
    jianpuFix,
    harmonies,
    harmonyTexts,
    labelStrips,
    timeStrips,
    wordStrips: opts.wantWordStrips ? wordStrips : [],
    headerStrips: headerStrip ? [headerStrip] : [],
    header,
    staffLabels,
    wedges,
    dynamics,
    slurs,
    lyricStats,
    debugBlobs: opts.debug ? blobs.map((c) => ({ id: c.id, box: c.bbox, area: c.area, claimed: claimed.has(c.id) })) : undefined,
    debugNl: opts.debug ? nl : undefined,
    debugPrims: opts.debug ? prims : undefined,
    debugGroups: opts.debug ? groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y, space: g.space })) : undefined,
    debugRest: opts.debug ? blobImage(nl, prims, unit, onGrid) : undefined,
    carryTime: lastTimeSignature(pg, ctx, opts.carryTime),
    // 没有调号的页也要把谱号的见证带下去：个数记零（`extendKeyByCarry` 见零不补）
    carryKey: { ...(lastKey(pg, ctx, opts.carryKey) ?? { code: "accidentalFlat", n: 0 }), clefs: clefTally },
  };
}

/**
 * **中英对照的闭合谱：下一行谱底下的拉丁歌词并到上一行谱**（段号由 `numberVersesByScript` 接着排）。
 *
 * 齐来称颂伟大之神那种排法：中文四段印在女声谱表下（两谱表之间），英文四段印在男声谱表下。
 * `buildLyricLines` 按「上方最近的谱行」收，两边各编 1~4 段，中文第 1 段与英文第 1 段
 * 就成了同一段，混成一串。照独唱谱的约定（坚固保障：中文 1~4、英文 5~8，都挂在旋律上）
 * 把英文挂回上一行谱。
 *
 * 只在同一系统里**上一行谱全是汉字段、下一行谱全是拉丁段**时并——合唱谱四个声部
 * 各印各的中文词，那是各声部自己的第 1 段，不能动。
 */
function foldBilingualLyrics(pg: SPage, lines: LyricLine[]): void {
  const latin = isLatinLine;
  for (const sys of pg.systems) {
    for (let i = 0; i + 1 < sys.staves.length; i++) {
      const up = lines.filter((l) => l.staff === sys.staves[i]);
      const lo = lines.filter((l) => l.staff === sys.staves[i + 1]);
      if (!up.length || !lo.length || up.some(latin) || !lo.every(latin)) continue;
      // 段号由 `numberVersesByScript` 按文种重编，这里只管挪谱行
      for (const l of lo) l.staff = sys.staves[i];
    }
  }
}

/** 闭合谱的门槛：和弦附音与主音之比。 */
const LIFT_CHORDY = 0.3;

/**
 * **字挂到同一拍最上面的音**（旋律）：`attachLyrics` 只按 x 找最近的音，同一 x 上的几个和弦成员、
 * 上下两个声部谁排在前面就给谁，常落在女低或和弦的下方音上（万福泉源歌第 1 段每个字都挂在 E4、GT 在 G4）。
 * 测评按拍位展开后同一拍的音从高到低排，挂错一个成员就错开一位。同一行谱、x 相差不到半个线距、
 * 更高又没挂这一段字的音，把字挪上去。
 */
function liftLyrics(pg: SPage, notes: StaffNote[], sp: number): void {
  // 只在**闭合谱**的谱行上挪（和弦附音占这行音的 `LIFT_CHORDY` 以上：女高女低同印一行，几乎每个音都是和弦）。
  // **三行谱以上的系统不挪**（合唱谱：一个声部一行谱，外加钢琴）。那种声部行上同 x 更高的「和弦成员」多是多认出来的
  // 假头（破碎女高那行 C5 上叠出 F5），挪上去女高、女低歌词 98 → 96、97 → 94%。按「三行以上挂着歌词」判不够：
  // 扫描件（望十架）只在最上面一行认出了歌词。独唱谱语料的系统都是高低音两行
  const choral = new Set<Staff>();
  for (const sys of pg.systems) if (sys.staves.length >= 3) for (const st of sys.staves) choral.add(st);
  const chordy = new Set<Staff>();
  for (const st of new Set(notes.map((n) => n.staff))) {
    if (choral.has(st)) continue;
    const ns = notes.filter((n) => n.staff === st && !n.rest && !n.grace);
    if (ns.filter((n) => n.chordExtra).length >= ns.filter((n) => !n.chordExtra).length * LIFT_CHORDY) chordy.add(st);
  }
  for (const n of notes) {
    if (!n.lyrics?.length || n.rest || !chordy.has(n.staff)) continue;
    let top = n;
    for (const m of notes)
      if (m.staff === n.staff && !m.rest && !m.grace && Math.abs(m.x - n.x) < sp * 0.5 && m.diatonic > top.diatonic &&
        (m.chordExtra || n.chordExtra) && m.duration === n.duration)
        top = m;
    if (top === n) continue;
    const move = n.lyrics.filter((l) => !top.lyrics?.some((q) => q.verse === l.verse));
    if (!move.length) continue;
    (top.lyrics ??= []).push(...move);
    n.lyrics = n.lyrics.filter((l) => !move.includes(l));
    if (!n.lyrics.length) n.lyrics = undefined;
  }
}

/** 拉丁段在页内先编成 `LATIN_VERSE + k`，整首的中文段数定了再挪到中文段后面（`settleLyricVerses`）。 */
const LATIN_VERSE = 100;
/** 一行里伸出上方各行范围的音节，至少连着这么多个才拆成单独一段（见 `numberVersesByScript`）。 */
const SPLIT_RUN = 3;
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

const isLatinLine = (l: LyricLine) => {
  const t = l.syllables.map((s) => s.text).join("");
  const cjk = [...t].filter((c) => /[\u3400-\u9fff]/.test(c)).length;
  const lat = [...t].filter((c) => /[A-Za-z]/.test(c)).length;
  return lat > cjk * 3;
};

/**
 * **段号按文种分开编**：每行谱下的歌词行按上下次序，汉字行编 1、2、3…，拉丁行编 `LATIN_VERSE + 1`…。
 *
 * 副歌只印一次的中英对照谱（倚靠主永远膀臂、大地风光、当我们回到天家、更亲近恩主、数算主恩、信心使我得胜），
 * 副歌那几行谱下只有一行中文一行英文。原来按上下次序连着编，英文副歌成了第 2 段，
 * 落进中文第 2 段（GT 记在英文第 1 段，中文第 2 段整段归零）。
 * 英文从第几段起要看**整首**的中文段数（倚靠主第二页只有副歌），这里先占位，见 `settleLyricVerses`。
 */
/**
 * **一行谱两个声部、上下各印一行词：各归哪个声部**（望十架独唱 / 女低共用一行谱，独唱的词印在谱表上方、女低的印在下方）。
 * 不分的话两行词按 x 挂到同一串音上，下方那行成了上声部的第 2 段，下声部一个字也没有（GT 是各声部各一段中文）。
 *
 * 同 `lyricsBelongBelow`，照简谱两声部一组裁决八度点的判法：**不按上下位置定，按排除性证据定**。
 * 逐音节数「只对得上第一声部的音」与「只对得上其余声部的音」（两个声部同一拍都有音的不表态），
 * 比「上方那行归第一声部、下方归其余」与「反过来」两种分法哪种的证据多；**一个声部同一处不会挂两行同文种的词**，
 * 所以一行定了另一行就是另一个声部。证据至少 `LYRIC_ONLY_MIN` 个、且是另一种分法的 `LYRIC_ONLY_RATIO` 倍才分，
 * 否则照原样（两行当同一串音的两段词）。只拿汉字行算证据，同一侧的拉丁行跟着同侧的汉字行走。
 */
function splitVoiceLyrics(pg: SPage, lines: LyricLine[], notes: StaffNote[], sp: number): void {
  for (const st of pg.staves) {
    const ls = lines.filter((l) => l.staff === st);
    const above = ls.filter((l) => l.top < st.box.top);
    const below = ls.filter((l) => l.top > st.box.bottom);
    if (!above.length || !below.length) continue;
    const ns = notes.filter((n) => n.staff === st && !n.rest);
    const v1 = ns.filter((n) => n.voice === 1).map((n) => n.x);
    const v2 = ns.filter((n) => n.voice !== 1).map((n) => n.x);
    if (!v1.length || !v2.length) continue;
    const cxs = (side: LyricLine[]) => side.filter((l) => !isLatinLine(l)).flatMap((l) => l.syllables.map((q) => q.cx));
    const [a1, a2] = onlyFits(cxs(above), v1, v2, sp);
    const [b1, b2] = onlyFits(cxs(below), v1, v2, sp);
    const straight = a1 + b2; // 上方归第一声部、下方归其余
    const swapped = a2 + b1;
    const [upper, lower] =
      straight >= LYRIC_ONLY_MIN && straight >= swapped * LYRIC_ONLY_RATIO ? [1, 2] as const
      : swapped >= LYRIC_ONLY_MIN && swapped >= straight * LYRIC_ONLY_RATIO ? [2, 1] as const
      : [null, null];
    if (!upper || !lower) continue;
    for (const l of above) l.voice = upper;
    for (const l of below) l.voice = lower;
  }
}

function numberVersesByScript(pg: SPage, lines: LyricLine[]): void {
  const span = (l: LyricLine) => [Math.min(...l.syllables.map((s) => s.left)), Math.max(...l.syllables.map((s) => s.right))] as const;
  const extra: LyricLine[] = [];
  // 分了声部的（`splitVoiceLyrics`）各声部各编各的段号
  for (const st of pg.staves) for (const v of [undefined, 1, 2] as const) {
    const ls = lines.filter((l) => l.staff === st && l.voice === v).sort((a, b) => a.top - b.top);
    // 第几段 = 上方同文种、**横向盖得住**它的行数 + 1。各段全宽排的，彼此都盖得住，照旧按上下次序；
    // 副歌只印在右半边的（信心使我得胜「Faith is the vic-to-ry!」印在中文第 3 段那一行的右边），
    // 左边主歌那几段盖不着它，就是本文种的第 1 段。
    // **按音节数**：一行的后半截伸进上方各行都没印的地方（倚靠主低音谱表下第 2 行英文「…arms. Lean-ing on Je-sus,」，
    // 后半是副歌的呼应句，上面那行英文到「arms.」就停了），那一截是本文种的第 1 段，拆出去单独成行。
    // 伸出去不到一个音节宽、或不到 `SPLIT_RUN` 个音节的不拆：各段结尾差一两个音（melisma）是常事。
    // 汉字行也拆：GT 约定统一成「副歌只印一次的，副歌记第 1 段」（原先是谁、以马内利来临歌、你的信实广大
    // 三份照印记在第 2 段，已改成第 1 段；数算主恩、更亲近恩主本来就记第 1 段）。
    const done: LyricLine[] = [];
    for (const l of ls) {
      const lat = isLatinLine(l);
      const above = done.filter((o) => isLatinLine(o) === lat).map(span);
      const sw = median(l.syllables.map((s) => s.right - s.left));
      const ks = l.syllables.map((s) => above.filter(([a, b]) => s.cx > a - sw && s.cx < b + sw).length + 1);
      const k0 = above.filter(([a, b]) => a < span(l)[1] && b > span(l)[0]).length + 1;
      // 连续同号的段，太短的并回整行的号
      const runs: { k: number; from: number; to: number }[] = [];
      ks.forEach((k, i) => {
        const r = runs[runs.length - 1];
        if (r && r.k === k) r.to = i + 1;
        else runs.push({ k, from: i, to: i + 1 });
      });
      // 汉字行的副歌起句（数算主恩第 3 段行尾「…見天父．主的恩典，樣樣」、是谁第 2 段「捨命，是你，主耶穌…」）。
      // 两道闸：末段后的「阿们」不算（GT 记在末段：唱完末段才唱，不是副歌；万古磐石歌、救主降生等七首）；
      // 行首那一截（上一行接下来的副歌，是谁「你。是你，主耶穌，唯有你。」）要以句末标点收尾——
      // 各段字数不同的曲子行首本来就参差（耶和华是我的牧者「我擺設筵」「隨着」，96.2 → 90.9%）
      const refrain = (r: { from: number; to: number }) =>
        !/^[（(]?阿$/.test(l.syllables[r.from].text) && (r.from > 0 || /[。！？!?]$/.test(l.syllables[r.to - 1].text));
      const cut = runs.filter((r) => r.k !== k0 && r.to - r.from >= (lat ? SPLIT_RUN : 2) && (lat || refrain(r)));
      l.verse = lat ? LATIN_VERSE + k0 : k0;
      for (const r of cut) {
        extra.push({ ...l, verse: lat ? LATIN_VERSE + r.k : r.k, syllables: l.syllables.slice(r.from, r.to) });
      }
      if (cut.length) l.syllables = l.syllables.filter((_, i) => !cut.some((r) => i >= r.from && i < r.to));
      done.push(l);
    }
  }
  lines.push(...extra);
}
/** 呼应句改挂下一行谱：音节「明显离下一行谱的音更近」至少占这么多（明显 = 近半个线距以上）。 */
const ECHO_LOWER = 0.5;
/** 同时「明显离上一行谱更近」的不超过这么多；上方要有一行跟上一行谱走的（明显离下一行谱更近的不超过 `ECHO_UPPER_ROW`）。 */
const ECHO_UPPER = 0.1;
const ECHO_UPPER_ROW = 0.15;

/**
 * **印在两行谱之间、其实是下一行谱声部的词**，改挂下一行谱（`buildLyricLines` 一律挂上方最近的谱行）。
 *
 * 副歌一呼一应的谱（倚靠主永远膀臂）：高音唱长音「倚——靠」，低音接「倚靠主耶穌」，
 * 低音的词印在两谱表之间、主歌各行下面，被当成高音谱表的第 2 段（GT 记在低音的第 1 段）。
 * 判据是**音节离哪一行谱的音近**：四部和声两行谱节奏大多一样，两边一样近，照旧挂上面；
 * 应答句落在高音没有音的地方，明显离低音近（倚靠主三处 0.57~0.75，主歌各行 0~0.1）。
 * **要有对比**：同一行谱下，上面先有一行跟着上一行谱走，它下面才出现跟低音走的行，从那一行起往下都挂下一行谱。
 * 耶和华是我的牧者一行谱下三段词全都偏向低音（0.40~0.69，高音谱表的音认漏了），不能挪——只看单行挪了，中文 96 → 45%。
 */
function moveEchoLines(pg: SPage, lines: LyricLine[], notes: StaffNote[], sp: number): void {
  const xsOf = (st: Staff) => notes.filter((n) => n.staff === st && !n.rest && !n.grace).map((n) => n.x);
  const near = (x: number, xs: number[]) => Math.min(Infinity, ...xs.map((y) => Math.abs(y - x)));
  for (const sys of pg.systems) {
    for (let i = 0; i + 1 < sys.staves.length; i++) {
      const up = sys.staves[i];
      const lo = sys.staves[i + 1];
      const upX = xsOf(up);
      const loX = xsOf(lo);
      const frac = (l: LyricLine, a: number[], b: number[]) => l.syllables.filter((q) => near(q.cx, a) + sp * 0.5 < near(q.cx, b)).length / l.syllables.length;
      const gap = lines.filter((l) => l.staff === up && l.top < lo.box.top && l.syllables.length >= 3).sort((p, q) => p.top - q.top);
      let seenUpper = false;
      let from = -1;
      gap.forEach((l, k) => {
        const lb = frac(l, loX, upX);
        if (from < 0 && seenUpper && lb >= ECHO_LOWER && frac(l, upX, loX) <= ECHO_UPPER) from = k;
        if (lb <= ECHO_UPPER_ROW) seenUpper = true;
      });
      if (from >= 0) for (const l of gap.slice(from)) l.staff = lo;
    }
  }
}

/**
 * 整首的音符（各页 `recognizeRasterPage` 的 `notes` 连起来）：拉丁段挪到中文段后面
 *（中文三段就从第 4 段起），段号与独唱谱的约定一致（坚固保障：中文 1~4、英文 5~8）。
 * 全曲没有中文段的，英文从第 1 段起。
 * **零星几个字的段不算数**（字数不到最多那段的两成）：我灵镇静第三系统一条只认出「夏：」的假行
 * 成了中文第 4 段，英文整体后移一段，拉丁 81.6% → 19.4%。
 */
export function settleLyricVerses(notes: { lyrics?: { verse: number }[] }[]): void {
  const count = new Map<number, number>();
  for (const n of notes) for (const l of n.lyrics ?? []) if (l.verse < LATIN_VERSE) count.set(l.verse, (count.get(l.verse) ?? 0) + 1);
  const most = Math.max(0, ...count.values());
  let zh = 0;
  for (const [v, c] of count) if (c >= most * 0.2) zh = Math.max(zh, v);
  for (const n of notes) for (const l of n.lyrics ?? []) if (l.verse > LATIN_VERSE) l.verse = zh + l.verse - LATIN_VERSE;
}

/**
 * **调号串往右接**：`analyzeAccidental` 串调号要求相邻两个升降号**上下交叠**，
 * 而位图这边降号的盒收到了肚子上（见 `FLAT_BOWL_TOP`）——三个降号时 E♭ 的肚子在上间、
 * A♭ 的肚子在下面第二间，一点不交叠，离谱号又超过三格，第三个降号就接不上
 *（《圣哉三一歌伴奏》整首少一个降号，A 全读成还原）。升号上下对称、盒不收，不受影响。
 * 这里只补位图这一路：已有调号的谱行，右边**横向紧挨着**（间隙在 0 到自身宽之间，
 * 与 `analyzeAccidental` 同一条）、谁都没认领的升降号接到串尾。不动 `staffomr`。
 */
function extendKeyChains(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  for (const c of ctx.values()) {
    if (!c.key.length) continue;
    const onStaff = (b: Box) => b.top < c.staff.box.bottom && b.bottom > c.staff.box.top;
    for (;;) {
      const last = c.key[c.key.length - 1];
      const nx = pg.symbols.find((s0) => {
        if (!isAccidental(s0.code) || s0.hasAnyTag() || !onStaff(s0.box)) return false;
        const dx = s0.box.left - last.box.right;
        return dx >= 0 && dx <= s0.box.right - s0.box.left;
      });
      if (!nx) break;
      nx.addTag("Key");
      c.key = [...c.key, nx];
    }
  }
}

/**
 * **调号区里不出头**：头心落在谱号左缘到本行最后一个调号记号右缘之间的，是调号记号的碎块被当成了头
 *（所信有根基低音谱表四个降号，E♭ 的肚子连着 A♭ 的竖笔，收成 E♭3 空心头）。只认这一行谱自己认出的调号
 *（`ctx.key` 可能是从别行借来的）。
 */
function dropHeadsInKey(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  const sp = pg.normalStaffSpace || pg.space;
  const drop = new Set<(typeof pg.symbols)[number]>();
  for (const c of ctx.values()) {
    if (!c.clef) continue;
    const clef = c.clef.box;
    const onStaff = (b: Box) => b.top < c.staff.box.bottom && b.bottom > c.staff.box.top;
    const keys = pg.symbols.filter((s0) => s0.hasTag("Key") && onStaff(s0.box) && s0.box.left >= clef.left && s0.box.left < clef.right + sp * 10);
    if (!keys.length) continue;
    const right = Math.max(...keys.map((k) => k.box.right));
    for (const s0 of pg.symbols) {
      if (!s0.hasTag("Note") || !onStaff(s0.box)) continue;
      const cx = (s0.box.left + s0.box.right) / 2;
      if (cx > clef.left && cx < right) drop.add(s0);
    }
  }
  if (drop.size) pg.symbols = pg.symbols.filter((s0) => !drop.has(s0));
}

/**
 * **和弦挂到同一拍的上声部**。`attachHarmonies` 只按 x 远近挑音，同一拍上下两个声部的头
 * 横向只差几个像素，谁近谁得；挂到下声部，写出来就排在 `<backup>` 后面，与 GT 的次序对不上
 *（圣哉三一歌伴奏 m5、m15：头的干一补上、时值一改，和弦就跳到了下声部，和弦档 100% → 86.7%）。
 * 和弦记号印在谱表上方，归上面那个音：同一谱行、x 差不到半格、位置更高又没挂和弦的音，挪过去。
 * 只补位图这一路，不动 `staffomr`。
 */
function liftHarmonies(notes: StaffNote[], sp: number): void {
  for (const n of notes) {
    if (!n.chord || n.rest) continue;
    let top: StaffNote | null = null;
    for (const m of notes) {
      if (m === n || m.rest || m.chord || m.staff !== n.staff || Math.abs(m.x - n.x) >= sp * 0.5) continue;
      if (m.sym.box.top >= (top ?? n).sym.box.top) continue;
      top = m;
    }
    if (!top) continue;
    top.chord = n.chord;
    n.chord = undefined;
  }
}

/**
 * **`findStems` 漏挂的符干**（位图路补，不动 `staffomr`）。那边两道判据在细线扫描件上太紧：
 *   - 符头边缘离竖段中线要不到**两倍谱线粗**：齐来称颂谱线一两个像素，窗口两像素半，
 *     符头盒偏出两像素半就挂不上；
 *   - 头要在竖段**一端**（一格之内）：叠置和弦里靠干尾那个头在中段，单看它判不过。
 * 这里对没挂标记的竖段，窗口放到 0.2 格，按贴着它的**整组头**判：最上那个头贴上端、或最下那个贴下端，
 * 且竖段从那组头往外伸出一格半以上（小节线擦过符头时头在它中段，挡得住）；
 * 或者左右两侧各贴一个头、上下都伸出去（两个声部共线的干，见下）。
 * 病例齐来称颂末三小节低音的附点二分和弦，干在盒左缘往下伸四格，读成全音符。
 */
function tagLooseStems(pg: SPage): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.ownerStaff && (s0.code === "noteheadBlack" || s0.code === "noteheadHalf"));
  for (const l of pg.segs) {
    if (!l.isV || l.hasAnyTag()) continue;
    const on = heads.filter((n) => overlapY(l.box, n.box) && (Math.abs(n.box.left - l.cx) < sp * 0.2 || Math.abs(n.box.right - l.cx) < sp * 0.2));
    if (!on.length) continue;
    const top = Math.min(...on.map((n) => (n.box.top + n.box.bottom) / 2));
    const bottom = Math.max(...on.map((n) => (n.box.top + n.box.bottom) / 2));
    const upEnd = Math.abs(top - l.top) <= sp && l.bottom - bottom >= sp * 1.5;
    const downEnd = Math.abs(bottom - l.bottom) <= sp && top - l.top >= sp * 1.5;
    // 二度错排的两个声部：左边的头朝上的干（贴右缘）与右边的头朝下的干（贴左缘）在同一列，
    // 连成一根两头都伸出去的竖段，两个头都落在中段（赞美三一真神 m15 的 D4/C4）。
    // 小节线擦过符头不会左右两侧各贴一个
    const twoSides =
      on.some((n) => Math.abs(n.box.right - l.cx) < sp * 0.2) &&
      on.some((n) => Math.abs(n.box.left - l.cx) < sp * 0.2) &&
      top - l.top >= sp * 1.5 &&
      l.bottom - bottom >= sp * 1.5;
    // 小节线后紧跟着的第一个音贴着小节线的左缘（同 `findStems`，见 `isLeadNoteBarline`）
    if (!twoSides && on.every((n) => n.ownerStaff && isLeadNoteBarline(l, n, n.ownerStaff))) continue;
    if (upEnd || downEnd || twoSides) l.addTag("Stem");
  }
}

/**
 * **曲中「转调」其实是临时记号**：`analyzeAccidental` 把紧跟小节线两格内、没挂上符头的升降号
 * 当成曲中转调的调号。可这本谱的临时记号离符头有 0.6~1.1 格，挂不上（见 `attachAccidentalsByPitch`），
 * 小节线后第一个音的升号就被当成了调号（齐来称颂 m5 的 D♯4：第一行高音谱表成了四个升号，
 * 整首音高掉到两成）。这里把**不接在谱号那一串后面**、右边 1.5 格内又有同高符头的调号升降号
 * 从 `ctx.key` 里摘出来，交给临时记号那一步。标记摘不掉（`staffomr` 不动），挂靠那一步按 `ctx.key` 认。
 */
/**
 * **行末预告下一行转调的调号不算本行的**。曲中转调落在换行处时，上一行行末（复纵线之后）先印一遍新调号。
 * `ctx.key` 收的是这一行所有挂了 `Key` 的记号、按个数算调，行末那几个一并数进去，这一行就多出几个升降号
 *（爱是从神而来 p4 第二系统：行首一个降号、行末预告三个降号，认出其中一个，四行都读成两个降号）。
 * 落在谱行右端 `COURTESY_KEY` 格以内、右边再没有音符的调号记号从 `ctx.key` 里摘掉。
 */
function dropCourtesyKeys(pg: SPage, ctx: Map<Staff, StaffContext>, sp: number): void {
  const notes = pg.symbols.filter((q) => q.hasTag("Note"));
  for (const [st, c] of ctx) {
    if (!c.key.length) continue;
    const tail = (k: Sym) => k.box.left > st.box.right - sp * COURTESY_KEY && k.box.left > st.box.left + sp * 12 && !notes.some((n) => n.ownerStaff === st && n.px > k.px);
    if (c.key.some(tail)) c.key = c.key.filter((k) => !tail(k));
  }
}

/**
 * **落在行首「谱号 + 调号」那一段里的小节线不是小节线**。六个降号挤在一起，末两个的竖笔粗、孤立，
 * 被抽成竖段当了小节线（烛光颂曲 p4、p6 有三四行行首多切出一个小节）。同系统表决拦不住——七行里三行都有。
 * 调号的个数定了之后，这一段有多宽就知道了：谱号右缘（封顶在离谱行左端 3.6 格）起每个记号一格、再让三成格。
 * 这一段里的 `BarLine` 标记摘掉。只管调号三个以上的行：一两个记号的那一段短，小节线抽错落不到里面。
 */
function dropBarsInKey(pg: SPage, ctx: Map<Staff, StaffContext>, sp: number): void {
  const endOf = (st: Staff) => {
    const c = ctx.get(st);
    const n = c ? headKey(c).length : 0;
    if (!c?.clef || n < 3) return -1;
    return Math.min(c.clef.box.right, st.box.left + sp * 3.6) + sp * (n + 0.3);
  };
  for (const g of systemGroups(pg)) {
    // 同一系统各行的这一段一样宽：取最靠右的那个（个别行左端量进了括号里，自己算出来的偏左）
    const end = Math.max(...g.map(endOf));
    if (end < 0) continue;
    for (const st of g)
      for (const sg of pg.segs) {
        if (!sg.isV || !sg.hasTag("BarLine")) continue;
        if (sg.bottom <= st.box.top || sg.top >= st.box.bottom) continue;
        if (sg.cx > st.box.left + sp && sg.cx < end) sg.removeTag("BarLine");
      }
  }
}

function demoteMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.hasTag("Note"));
  for (const c of ctx.values()) {
    if (!c.clef || !c.key.length) continue;
    let edge = c.clef.box.right;
    const keep: Sym[] = [];
    for (const [i, k] of c.key.entries()) {
      const chained = k.box.left - edge <= sp * (i === 0 ? KEY_GAP_FIRST : KEY_GAP);
      const right = k.box.right;
      const owned = heads.some((n) => Math.abs(n.py - k.py) <= sp / 4 && n.box.left >= right - 2 && n.box.left - right <= sp * LOOSE_ACC_GAP);
      if (!chained && owned) continue;
      keep.push(k);
      if (chained) edge = k.box.right;
    }
    c.key = keep;
  }
}

/**
 * **调号里只有一根通高竖笔的「还原号」是降号**。还原号是左上、右下两根错开的竖笔，各占记号高的六七成；
 * 降号只有一根竖笔、右下是肚子。这份扫描件上降号的肚子与竖笔连得细，字典常认成还原号
 *（望十架 p7 行中转一个降号五行读成三个还原号、两个没认；下一系统行首一个降号有两行读成还原号），
 * 行中转调整行升降跟着错。只改 `ctx.key` 里的（谱中的临时还原号不碰），数竖笔在去线前的图上、左右各放宽 0.3 格。
 */
function fixKeyNaturals(ctx: Map<Staff, StaffContext>, bin: Binary, sp: number): void {
  const pad = Math.round(sp * 0.3);
  for (const c of ctx.values())
    for (const k of c.key) {
      if (k.code !== "accidentalNatural") continue;
      const b = k.box;
      if (tallStrokes(bin, { x: b.left - pad, y: b.top, w: b.right - b.left + pad * 2, h: b.bottom - b.top }) === 1) k.code = "accidentalFlat";
    }
}

/**
 * **行中的调号簇要紧跟双小节线才算转调**：`findClefKeyTime` 把「紧跟在小节线之后」的升降还原号都收成调号，
 * 小节头一个音的临时记号也在里面（宁静的伯利恒低音谱表四处 B♮ 收成调号）。以前整行一个 `keyFifths`、还原号不计，
 * 混进来也只是悄悄多算一两个升降；分出行中转调（`keyChanges`）之后，它们会从那里起把整段改调。
 * 转调一律印在双小节线后面，左边三格以内没有双线的行中那簇摘出调号（交回去当临时记号，`attachAccidentalsByPitch` 认）。
 */
function pruneMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary, sp: number): void {
  for (const [st, c] of ctx) {
    if (st.lineYs.length !== 5) continue;
    const head = new Set(headKey(c));
    const mids = keyChanges(c).filter((q) => q.x > -Infinity);
    if (!mids.length) continue;
    const bars = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && l.bottom > st.box.top && l.top < st.box.bottom).map((l) => l.cx);
    const drop = new Set<Sym>();
    mids.forEach((m, i) => {
      const ok = bars.some((x) => x < m.x && m.x - x <= sp * 3 && doubleBarRight(bin, st.lineYs, x, sp) !== null);
      if (ok) return;
      const next = mids[i + 1]?.x ?? Infinity;
      for (const k of c.key) if (!head.has(k) && k.box.left >= m.x && k.box.left < next) drop.add(k);
    });
    if (drop.size) c.key = c.key.filter((k) => !drop.has(k));
  }
}

/** 音节离符头多远（格）算对得上。 */
const LYRIC_NOTE_DX = 0.9;
/** 改挂到下方那行谱：下方那行**一音一字**对得上的音节占比下限。 */
const LYRIC_BELOW_FIT = 0.6;
/**
 * 上方没有谱（页顶那条带）的行要一音一字对上这么多才挂：那里还有标题。大字号标题的整字比歌词字号上限高，进不了歌词带，
 * 只剩几个零碎偏旁当字格，字距也就量不准（你的信实广大页顶标题 5/7 = 0.71 对得上下方的音；望十架 p3 页顶那行歌词 0.93）。
 */
const LYRIC_HEAD_FIT = 0.8;
/** 「只对得上一边」的音节至少几个、且是另一边的几倍，才算这一边的证据压过另一边。 */
const LYRIC_ONLY_MIN = 3;
const LYRIC_ONLY_RATIO = 2;
/** 至少这么多个音节才判。 */
const LYRIC_BELOW_MIN = 4;
/** 歌词的字距：相邻音节中心距的中位数至少是字高的这么多倍。标题、署名字挨着字排（1.0 上下），歌词跟着音符排开。 */
const LYRIC_PITCH_MIN = 1.5;

/** 一串音节 x 里，「只对得上 a 那串音、对不上 b 那串」的个数与「反过来」的个数（x 差在 `LYRIC_NOTE_DX` 格以内算对上）。 */
function onlyFits(cxs: number[], a: number[], b: number[], sp: number): [number, number] {
  const hit = (xs: number[], cx: number) => xs.some((x) => Math.abs(x - cx) <= sp * LYRIC_NOTE_DX);
  let oa = 0, ob = 0;
  for (const cx of cxs) {
    const ha = hit(a, cx), hb = hit(b, cx);
    if (ha && !hb) oa++;
    else if (hb && !ha) ob++;
  }
  return [oa, ob];
}

/**
 * **一音一字**对得上的音节占比：按 x 从左到右，每个音节配离它最近、还没配过的那一拍（同一列的和弦成员算一拍），
 * x 差在 `LYRIC_NOTE_DX` 格以内才算。只看「附近有没有音」的话，一个音能被前后几个字都算上，挤在一起的标题也凑得出高比例。
 */
function oneToOneFit(cxs: number[], noteXs: number[], sp: number): number {
  const cols: number[] = [];
  for (const x of [...noteXs].sort((p, q) => p - q)) if (!cols.length || x - cols[cols.length - 1] > sp * 0.3) cols.push(x);
  const used = new Set<number>();
  let hit = 0;
  for (const cx of [...cxs].sort((p, q) => p - q)) {
    let bi = -1;
    for (let i = 0; i < cols.length; i++) if (!used.has(i) && Math.abs(cols[i] - cx) <= sp * LYRIC_NOTE_DX && (bi < 0 || Math.abs(cols[i] - cx) < Math.abs(cols[bi] - cx))) bi = i;
    if (bi >= 0) used.add(bi), hit++;
  }
  return cxs.length ? hit / cxs.length : 0;
}

/**
 * **夹在两行谱之间的歌词归哪一行**（`buildLyricLines` 的 `pickBelow`）。默认一行歌词归它上方最近的那行谱；
 * 可有的声部把词印在谱表上方（望十架 p3 独唱声部；页底那行词其实是下一系统顶行的，挂到了上一系统的钢琴左手上）。
 *
 * 照简谱夹在两行数字之间的八度点那套判法（`omr/jianpu.ts::resolvePairOctaveDots`，见实现篇「两声部一组裁决」）：
 * **不按远近、也不比总的对位率**，先看互斥、再看排除性的证据——
 *   - 上方没有谱（页顶那条带）：没有别的主，可那里也有标题、署名、速度语。**行首有段号（一位数）的是歌词**（强判据，
 *     免掉字距、一音一字对上六成就挂）；
 *     否则要字距像歌词（相邻音节中心距的中位数 ≥ 1.5 个字高：标题、署名字挨着字排）、且一音一字对得上下方那行八成；
 *   - **互斥**：下方那行谱是单声部、自己下面已经有词（简谱「下声部脚下已有点，夹在中间的这颗归上声部」），归上方；
 *     两声部一行的谱上下可以各挂一行（各归一个声部），不互斥；上方那行谱与这一行之间已有它自己的汉字行的，这一行是
 *     它往下接的一段，也归上方；
 *   - 两边都有谱：逐音节看对不对得上两边的音，**两边都对得上的不表态**（SATB 上下两行节奏一样，各音节两边都对得上，
 *     证据为零，照默认挂上方）；只对得上下方的至少 `LYRIC_ONLY_MIN` 个、且是只对得上上方的 `LYRIC_ONLY_RATIO` 倍，
 *     下方那行又一音一字对得上六成，才挂下方。
 */
function lyricsBelongBelow(row: LyricRowInfo, verseObjs: Set<PObj>, notes: StaffNote[], sp: number): Staff | undefined {
  const { syllables, above, below } = row;
  const cxs = syllables.map((q) => q.cx);
  const xsOf = (st: Staff) => notes.filter((n) => n.staff === st && !n.rest).map((n) => n.x);
  const xb = xsOf(below);
  if (!above) {
    const fit = oneToOneFit(cxs, xb, sp);
    // 段号是强判据：免掉字距，一音一字照两行之间那一档（六成）
    if (row.objs.some((o) => verseObjs.has(o))) return fit >= LYRIC_BELOW_FIT ? below : undefined;
    if (cxs.length < LYRIC_BELOW_MIN) return undefined;
    // 字距：相邻音节中心距的中位数 / 字号。字号取各音节字格**长边**（宽、高取大）的 85 分位（汉字是方的；同 `lyric.ts` 量字宽）：
    // 大字号的标题整字进不了歌词带，只剩碎笔当字格，高只有两三像素（我一生要赞美你页顶标题「一」只剩一横，
    // 按字格高量字距 3.3 倍，六个字又碰巧一音一字全对上；碎笔长短不一，中位数也只有 44、真字 83）；整行的行盒也不行，
    // 一行里常并着别处小字号的字。真歌词的字号很齐，85 分位就是字号
    const sorted = [...syllables].sort((p, q) => p.cx - q.cx);
    const gaps = sorted.slice(1).map((q, i) => q.cx - sorted[i].cx).sort((p, q) => p - q);
    const hs = sorted.map((q) => Math.max(0, ...q.glyphs.map((g) => Math.max(g.bbox.w, g.bbox.h)))).sort((p, q) => p - q);
    const charH = hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.85))];
    if (!(charH > 0) || gaps[gaps.length >> 1] < charH * LYRIC_PITCH_MIN) return undefined;
    return fit >= LYRIC_HEAD_FIT ? below : undefined;
  }
  if (cxs.length < LYRIC_BELOW_MIN) return undefined;
  if (oneToOneFit(cxs, xb, sp) < LYRIC_BELOW_FIT) return undefined;
  // 互斥：下方那行谱是单声部、自己下面已有词，这一行就是上方那行的（破碎 p8 女低那行词有几处女低休止、男高有音，按证据挪去了男高）。
  // 两声部一行的不算：上方的词归上声部、下方的归下声部，两边各挂一行（望十架独唱 / 女低，见 `splitVoiceLyrics`）
  // 证据压倒的不管这道互斥：只对得上下方的够多、上方一个都对不上、下方一音一字几乎全对上
  //（望十架 p3 独唱 / 女低共用一行谱，词上下各一行；这时声部还没分，`voice` 全是 1，上方那行被挡在上一系统的钢琴左手上）
  const fit = oneToOneFit(cxs, xb, sp);
  const [onlyA, onlyB] = onlyFits(cxs, xsOf(above), xb, sp);
  const decisive = onlyA === 0 && onlyB >= LYRIC_ONLY_DECISIVE && fit >= 0.9;
  if (row.belowHasOwn && !decisive && !notes.some((n) => n.staff === below && !n.rest && n.voice !== 1)) return undefined;
  // 另一面的互斥：上方那行谱与这一行之间已有它自己的汉字行，这一行是那串多段歌词往下接的一段
  //（万古磐石歌第 4 段离下一系统近、下一系统两声部，按证据挪了过去，中文 100 → 75%）
  if (row.aboveHasOwn) return undefined;
  return onlyB >= LYRIC_ONLY_MIN && onlyB >= onlyA * LYRIC_ONLY_RATIO ? below : undefined;
}

/** 双小节线：小节线两侧这么多格以内另有一根贯通谱表的竖墨。 */
const DOUBLE_BAR_REACH = 1.0;

/** 小节线 x 处是不是双线；是的话返回右边那根的右缘，不是返回 null。在原图上逐列量贯通五线的竖墨。 */
function doubleBarRight(bin: Binary, lineYs: number[], x: number, sp: number): number | null {
  const y0 = Math.round(lineYs[0]);
  const y1 = Math.round(lineYs[lineYs.length - 1]);
  const full = (cx: number) => {
    if (cx < 1 || cx + 1 >= bin.w) return false;
    let n = 0;
    for (let y = y0; y <= y1; y++) if (bin.data[y * bin.w + cx] || bin.data[y * bin.w + cx - 1] || bin.data[y * bin.w + cx + 1]) n++;
    return n >= (y1 - y0 + 1) * 0.9;
  };
  const runs: [number, number][] = [];
  for (let cx = Math.round(x - sp * DOUBLE_BAR_REACH); cx <= Math.round(x + sp * DOUBLE_BAR_REACH); cx++) {
    if (!full(cx)) continue;
    const last = runs[runs.length - 1];
    if (last && cx - last[1] <= 1) last[1] = cx;
    else runs.push([cx, cx]);
  }
  return runs.length >= 2 ? runs[runs.length - 1][1] : null;
}

/** 行中调号与模板比墨：模板的墨要有这么多落在目标上（一像素以内），目标那一段的墨也要有这么多落在模板上。 */
const MID_KEY_RECALL = 0.7;
const MID_KEY_PRECISION = 0.45;

/**
 * **行中转调按下一系统行首的调号认**：转调的调号印在双小节线后面，可调号的那几路（字典、按块、按竖笔）都只在谱号右边找，
 * 行中的升降号要么没认成记号、要么被当成头一个音的临时记号、要么读成全音符（望十架 p6 转两个升号、p8 转一个升号，
 * 五行一行都没认出，整段升降全错；按竖笔数也只量得出半截）。
 * 转调之后，**下一个系统的行首必然印着新调号**，而行首那几路是认得好的。于是拿它当模板：
 * 双小节线右边一格半以内滑动，与下一系统同种谱号那几行的行首调号逐像素比墨（谱线那几行不算，一像素以内算对上）。
 * 同一系统、同一处至少两行对上同一个读数才收；没对上的行交给 `shareMidKeys` 补。已有行中调号的那处不动。
 * 一页最后一个系统里的转调没有模板，不管。
 */
function findMidKeysByTemplate(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary, unit: { space: number; height: number; lineThick?: number }): void {
  const sp = unit.space;
  const thick = Math.max(1, Math.round(unit.lineThick ?? sp * 0.1));
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  const near1 = (x: number, y: number) => ink(x, y) || ink(x - 1, y) || ink(x + 1, y) || ink(x, y - 1) || ink(x, y + 1);
  const onLine = (st: Staff, y: number) => st.lineYs.some((l) => Math.abs(y - l) <= thick);
  const groups = systemGroups(pg).sort((a, b) => a[0].box.top - b[0].box.top);
  const found: { c: StaffContext; x: number; fifths: number; syms: Sym[]; gi: number }[] = [];
  for (const [gi, g] of groups.entries()) {
    const next = groups[gi + 1];
    if (!next) continue;
    const cands = next.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c?.clef && c.staff.lineYs.length === 5 && headKey(c).length > 0);
    for (const st of g) {
      const c = ctx.get(st);
      if (!c?.clef || st.lineYs.length !== 5) continue;
      const xs = pg.segs
        .filter((l) => l.isV && l.hasTag("BarLine") && l.bottom > st.box.top && l.top < st.box.bottom && l.cx > st.box.left + sp * 6 && l.cx < st.box.right - sp * 3)
        .map((l) => l.cx)
        .sort((a, b) => a - b);
      let prev = -Infinity;
      for (const x of xs) {
        if (x - prev < sp * 1.5) continue;
        prev = x;
        const right = doubleBarRight(bin, st.lineYs, x, sp);
        if (right === null) continue;
        prev = right;
        if (c.key.some((k) => k.box.left > right && k.box.left < right + sp * 3)) continue;
        const clefHere = (c.clefs ?? []).filter((q) => q.box.left < right).pop() ?? c.clef;
        let best: { score: number; cand: StaffContext; dx: number; dy: number } | null = null;
        for (const cand of cands) {
          if (cand.clef!.code !== clefHere.code) continue;
          const csp = cand.staff.stepDistance() * 2;
          if (Math.abs(csp - st.stepDistance() * 2) > sp * 0.12) continue;
          const head = headKey(cand);
          if (keyFifths(head) === fifthsAt(c, right)) continue;
          const tx0 = Math.round(Math.min(...head.map((k) => k.box.left)));
          const tx1 = Math.round(Math.max(...head.map((k) => k.box.right)));
          const ty0 = Math.round(cand.staff.lineYs[0] - sp * 2);
          const ty1 = Math.round(cand.staff.lineYs[4] + sp * 2);
          const tpl: [number, number][] = [];
          for (let y = ty0; y <= ty1; y++) if (!onLine(cand.staff, y)) for (let x = tx0; x <= tx1; x++) if (ink(x, y)) tpl.push([x - tx0, y - cand.staff.lineYs[0]]);
          if (tpl.length < sp * 2) continue;
          for (let dx = Math.round(sp * 0.2); dx <= Math.round(sp * 1.5); dx++)
            for (let dy = -Math.round(sp * 0.3); dy <= Math.round(sp * 0.3); dy++) {
              const ox = right + dx;
              const oy = st.lineYs[0] + dy;
              let hit = 0;
              for (const [px, py] of tpl) if (near1(ox + px, Math.round(oy + py))) hit++;
              const recall = hit / tpl.length;
              if (recall < MID_KEY_RECALL || (best && recall <= best.score)) continue;
              // 反过来：目标那一段（模板宽）的墨也要多半落在模板上，满是墨的一片（符头、粗线）对得上模板但对不过来
              const tset = new Set(tpl.map(([px, py]) => `${px},${Math.round(py)}`));
              let tot = 0;
              let back = 0;
              for (let y = Math.round(oy - sp * 2); y <= Math.round(oy + sp * 6); y++) {
                if (onLine(st, y)) continue;
                for (let x = ox; x <= ox + tx1 - tx0; x++) {
                  if (!ink(x, y)) continue;
                  tot++;
                  const px = x - ox;
                  const py = Math.round(y - oy);
                  if (tset.has(`${px},${py}`) || tset.has(`${px - 1},${py}`) || tset.has(`${px + 1},${py}`) || tset.has(`${px},${py - 1}`) || tset.has(`${px},${py + 1}`)) back++;
                }
              }
              if (!tot || back / tot < MID_KEY_PRECISION) continue;
              best = { score: recall, cand, dx, dy };
            }
        }
              if (!best) continue;
        const head = headKey(best.cand);
        const tx0 = Math.min(...head.map((k) => k.box.left));
        const ddy = st.lineYs[0] + best.dy - best.cand.staff.lineYs[0];
        const syms = head.map((k, i) => {
          const b = k.box;
          const sym = makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box: { x: Math.round(right + best!.dx + b.left - tx0), y: Math.round(b.top + ddy), w: Math.round(b.right - b.left), h: Math.round(b.bottom - b.top) }, code: k.code }, unit.height).sym;
          sym.addTag("Key");
          return sym;
        });
        found.push({ c, x: right, fifths: keyFifths(head), syms, gi });
      }
    }
  }
  for (const f of found) {
    const peers = found.filter((o) => o.gi === f.gi && Math.abs(o.x - f.x) <= sp * MID_KEY_DX && o.fifths === f.fifths);
    if (new Set(peers.map((o) => o.c)).size < 2) continue;
    f.c.key.push(...f.syms);
    f.c.key.sort((a, b) => a.box.left - b.box.left);
  }
}

/** 换掉行首那段调号（`headKey`），行中转调的记号留着。 */
function setHeadKey(c: StaffContext, head: Sym[]): void {
  const old = new Set(headKey(c));
  c.key = [...head, ...c.key.filter((k) => !old.has(k))];
}

/** 行中转调：同系统各行的那处调号在这么多格以内算同一处。 */
const MID_KEY_DX = 2.5;

/**
 * **行中转调同系统互证**：一个系统里各行在同一条小节线后转调，记号各认各的，有的行没认出、有的认岔
 *（望十架 p7：五行里三行认出、两行一个都没有）。各行行中那几簇调号（`keyChanges`）按 x 归到一处，
 * 至少两行认出、读数取多数的；没认出或读数不同的行照它补（借那一行的记号对象，下游只看种类、个数与 x）。
 */
function shareMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>, sp: number): void {
  for (const g of systemGroups(pg)) {
    const cs = g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c);
    if (cs.length < 2) continue;
    const mids = cs.flatMap((c) => {
      const ch = keyChanges(c).filter((q) => q.x > -Infinity);
      return ch.map((q, i) => ({ c, x: q.x, fifths: q.fifths, syms: c.key.filter((k) => k.box.left >= q.x && (i + 1 >= ch.length || k.box.left < ch[i + 1].x)) }));
    });
    const used = new Set<(typeof mids)[number]>();
    for (const m of mids) {
      if (used.has(m)) continue;
      const near = mids.filter((o) => !used.has(o) && Math.abs(o.x - m.x) <= sp * MID_KEY_DX);
      for (const o of near) used.add(o);
      if (new Set(near.map((o) => o.c)).size < 2) continue;
      const votes = new Map<number, number>();
      for (const o of near) votes.set(o.fifths, (votes.get(o.fifths) ?? 0) + 1);
      const [best, n] = [...votes].sort((a, b) => b[1] - a[1])[0];
      if ([...votes.values()].filter((v) => v === n).length > 1) continue;
      const ref = near.find((o) => o.fifths === best)!;
      for (const c of cs) {
        const mine = near.filter((o) => o.c === c);
        if (mine.length && mine.every((o) => o.fifths === best)) continue;
        const drop = new Set(mine.flatMap((o) => o.syms));
        c.key = [...c.key.filter((k) => !drop.has(k)), ...ref.syms].sort((a, b) => a.box.left - b.box.left);
      }
    }
  }
}

/**
 * **一像素细笔的还原号按两根错开的竖笔补认**（望十架 p7 m55：五行谱十来个 F♮、C♮，去线后横笔断成碎点，
 * 字典一个也没认出，整小节按调号读成 F♯、C♯）。只补「按调号或本小节前文会变音」、又没挂临时记号的音：
 * 符头左边 1.6 格内找两根细竖笔——宽不过 0.3 格、高 1.5~3.3 格，左高右低各错开 0.3 格以上、相距 0.3~0.9 格，
 * 左笔上端在符头中心上方 0.8~2.2 格、右笔下端在下方 0.8~2.2 格（还原号上半左笔、下半右笔，符头在中间那格）。
 * 两笔都不能是别的音的符干（符干上端或下端挨着符头）。
 */
function naturalsByStrokes(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[], bin: Binary, sp: number): void {
  let hit = false;
  const heads = notes.filter((n) => !n.rest).map((n) => n.sym.box);
  // 竖笔一端挨着某个符头就是符干
  const isStem = (s: { x0: number; x1: number; top: number; bottom: number }) =>
    heads.some((b) => s.x1 >= b.left - 2 && s.x0 <= b.right + 2 && ((s.top >= b.top - 3 && s.top <= b.bottom + 3) || (s.bottom >= b.top - 3 && s.bottom <= b.bottom + 3)));
  for (const n of notes) {
    if (n.rest || n.accidental !== null || n.alter === 0) continue;
    const b = n.sym.box;
    const py = n.sym.py;
    const x0 = Math.max(0, Math.round(b.left - sp * 1.6));
    const y0 = Math.max(0, Math.round(py - sp * 2.4));
    const zone = { x: x0, y: y0, w: Math.max(0, Math.round(b.left) - 1 - x0), h: Math.min(bin.h - y0, Math.round(sp * 4.8)) };
    const ss = verticalStrokes(bin, zone, sp * 1.5).filter((s) => s.x1 - s.x0 + 1 <= sp * 0.3 && s.h <= sp * 3.3 && !isStem(s));
    const ok = ss.some((l) =>
      ss.some((r) => {
        const dx = r.x0 - l.x1;
        return (
          dx >= sp * 0.3 && dx <= sp * 0.9 &&
          r.top - l.top >= sp * 0.3 && r.bottom - l.bottom >= sp * 0.3 &&
          py - l.top >= sp * 0.8 && py - l.top <= sp * 2.2 &&
          r.bottom - py >= sp * 0.8 && r.bottom - py <= sp * 2.2
        );
      }),
    );
    if (!ok) continue;
    n.accidental = 0;
    hit = true;
  }
  if (hit) calcAlters(pg, ctx, notes);
}

/** 临时记号离符头最远多少格还算它的（见 `attachAccidentalsByPitch`）。 */
const LOOSE_ACC_GAP = 1.5;
/**
 * 谱中无主块配升降号模板的签名距离上限（见「谱中没人认领的升降还原号」）。
 * 实测真升号 46~68（齐来称颂 m5、赞美三一真神 m8/m9），误配的最近一个 87（善牧恩慈歌线距 11px
 * 的一截竖笔），再往上是 102~180 一大片；拍号那一档 180 太松，通用的 90 也挡不住 87。
 */
const LOOSE_ACC_DIST = 80;

/**
 * **临时记号按音高找主人**（位图路整个重分一遍，不动 `staffomr`）。两处不合用：
 *   - `analyzeAccidental` 要记号右缘到符头左缘不到半格、`buildNotes` 套用时又卡一格之内——
 *     齐来称颂这本谱实测 0.62~1.13 格（m3 E♯3、m7 D♯4、m13 的 C♮4 与 D♯3），认出来了也挂不上，全按调号读；
 *   - `buildNotes` 套用只看**盒子上下交叠**，升号盒有三格高，和弦里下面那个音也被盖进去
 *    （赞美三一真神 m8 F♯3 的升号给了 B2、m9 F♯3 的给了 D3）。
 * 这里按**同高**（中心差 ≤ 四分之一格；降号盒已收到肚子上）找右边第一个音，间隙放到 1.5 格：
 * 和弦里错开排的记号（还原号在上、升号在左下）各找各的。调号（`ctx.key`）不参与，重分完重算变音。
 */
function attachAccidentalsByPitch(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  const keys = new Set([...ctx.values()].flatMap((c) => c.key));
  for (const n of notes) n.accidental = null;
  const taken = new Set<Sym>();
  const between = pg.symbols.filter((a) => isAccidental(a.code) && !keys.has(a));
  for (const a of pg.symbols) {
    if (!isAccidental(a.code) || keys.has(a)) continue;
    let best: StaffNote | null = null;
    let bd = Infinity;
    for (const n of notes) {
      if (n.rest || taken.has(n.sym)) continue;
      if (Math.abs(n.sym.py - a.py) > sp / 4) continue;
      let gap = n.sym.box.left - a.box.right;
      // 和弦里错开排的记号：中间隔着的别的临时记号宽度不算（望十架 p7 m55 还原号在降号左边，离 F 头 1.9 格）
      for (const o of between) if (o !== a && o.box.left >= a.box.right - 2 && o.box.right <= n.sym.box.left + 2 && Math.abs(o.py - a.py) <= sp * 3) gap -= o.box.right - o.box.left;
      if (gap < -2 || gap > sp * LOOSE_ACC_GAP || gap >= bd) continue;
      best = n;
      bd = gap;
    }
    if (!best) continue;
    // 同一个头拆出来的同音两声部一起填
    for (const n of notes) if (n.sym === best.sym) n.accidental = accidentalAlter(a.code);
    taken.add(best.sym);
    a.addTag("Accidental");
  }
  calcAlters(pg, ctx, notes);
}

/**
 * **调号不全的谱行照抄同页的**：整首不转调是常态，同页各行调号本该一样。
 * 取**至少两行认得一模一样**的调号里最长的那个，一个都没认出、或只认出同类（全升/全降，
 * 可夹着认岔的还原号）前几个的谱行照它补齐。
 *
 *   - 颂赞与尊贵第一行的降号贴着高音谱号，去谱线后残留的一行墨把两者连成一块，
 *     被谱号盒整个吞掉；导出取第一行的调号，整首按 C 大调读、再按调号差移调，字母全错。
 *   - 齐来称颂的低音谱表三个升号，后两个在调号那一步已被别的路认领（当成符头），
 *     两行低音谱表只认出一个，G# 全读成 G。
 */
/**
 * **全页一个调号都没认出、和弦却指向别的调**：按和弦拼写补调号。
 *
 * 病例《主我敬拜你》（粗体铅字本）：F 大调的那一个降号印得极小、压在高音谱号右侧的弯钩上，
 * 与谱号连成一块，按块分不出来；六行全按 C 大调读，B♭ 全成了 B。可谱面上的和弦是
 * F、C/E、Dm、B♭、Gm7、C7……——**和弦的根音与低音是按调拼写的**，B♭ 这种拼写本身就说明了调。
 *
 * 做法：数根音与斜线后的低音，挑能容纳最多个的调（同分取升降号少的）。
 * 只在三件事都成立时才补：全页没有任何调号、和弦记号至少六个、那个调比 C 大调多容纳至少两个、
 * 带升降号拼写的根音至少两次、且容纳了八成以上——临时变化的和弦（副属和弦的根音）只是零星几个，推不动。
 */
function keyFromChords(pg: SPage, ctx: Map<Staff, StaffContext>, texts: string[], unit: { space: number; height: number }): void {
  const all = [...ctx.values()];
  if (!all.length || all.some((c) => c.key.length)) return;
  const notes: string[] = [];
  for (const t of texts)
    for (const m of t.matchAll(/(^|\/)([A-G])([#b♯♭]?)/g)) notes.push(m[2] + (m[3] === "#" || m[3] === "♯" ? "#" : m[3] ? "b" : ""));
  if (notes.length < 6) return;
  const scale = (f: number) =>
    new Set(
      "CDEFGAB".split("").map((l) =>
        f > 0 && "FCGDAEB".slice(0, f).includes(l) ? l + "#" : f < 0 && "BEADGCF".slice(0, -f).includes(l) ? l + "b" : l,
      ),
    );
  const score = (f: number) => {
    const sc = scale(f);
    return notes.filter((n) => sc.has(n)).length;
  };
  let best = 0;
  for (let f = -6; f <= 6; f++) if (score(f) > score(best) || (score(f) === score(best) && Math.abs(f) < Math.abs(best))) best = f;
  // 带升降号拼写的根音（B♭、F♯……）至少出现两次，才算和弦「说出了」调号；
  // 差额只要两个：OCR 常把 B♭ 读岔成 B6 之类，抵掉一个（《主我敬拜你》39 比 37）
  const spelled = notes.filter((n) => n.length === 2 && scale(best).has(n)).length;
  if (best === 0 || spelled < 2 || score(best) < score(0) + 2 || score(best) < notes.length * 0.8) return;
  const code: SmuflName = best > 0 ? "accidentalSharp" : "accidentalFlat";
  for (const c of all) {
    if (!c.clef) continue;
    const cb = c.clef.box;
    c.key = Array.from({ length: Math.abs(best) }, (_, i) => {
      const box = { x: cb.right + 1 + i * unit.space * 0.8, y: cb.top, w: unit.space * 0.7, h: unit.space * 2.5 };
      return makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box, code }, unit.height).sym;
    });
  }
}

/**
 * **和弦根音的降号读成了 6**：OCR 把「B♭」读成「B6」（《主我敬拜你》F 大调，B♭ 和弦两处都是）。
 * 调号定了之后按调纠：根音字母的**本音不在调内、降音在调内**，后面紧跟的 6 就是那个降号。
 * 调内有这个本音的（C 大调的 B6、G 大调的 E6）不动——那可能真是六和弦。
 */
function fixFlatReadAsSix(harmonies: HarmonyToken[], ctx: Map<Staff, StaffContext>): void {
  const c0 = [...ctx.values()].find((c) => c.key.length);
  const f = c0 ? keyFifths(c0.key) : 0;
  if (f >= 0) return;
  const flats = "BEADGCF".slice(0, -f);
  for (const h of harmonies) {
    const m = /^([A-G])6(.*)$/.exec(h.text);
    if (m && flats.includes(m[1])) h.text = `${m[1]}b${m[2]}`;
  }
}

/**
 * **调号跨页沿用**：续页的调号常印得淡、被去线切碎，只认出头一个（倚靠主永远膀臂第二页 4♭ 两行都只认出 1 个）。
 * 本页认出的调号与上一页同种、个数更少的，按上一页补足个数（拿本页已认出的最后一个记号重复补——
 * 下游只按个数算变音，记号位置取的是最右那个的右缘，重复不改它）。
 * 本页整页没认出调号的不管（`calcAlters` 本就沿用上一行；跨页那一截另说）。
 *
 * **补之前先看后面有没有墨**：记号少了也可能是真转调（望十架第 10 小节起五个降号转一个，
 * 一路补成五个补到第 6 页）。漏认的记号墨还在纸上；转调后的调号右边是空的。
 * 认出的最后一个记号右边 `CARRY_GAP` 到 `CARRY_REACH` 格里（传自别的行的调号到记号自己那一行去看），有一列在谱线之外的墨够 `CARRY_INK` 格
 *（升降号的竖笔）才补；漏的是中间一个时后面没有墨，认出的几个从头到尾已有上一页那个个数那么宽
 *（每个记号 `CARRY_PITCH` 格）的也补（烛光颂曲 p6 六个降号十行都读成五个）。
 */
const CARRY_GAP = 0.1;
const CARRY_REACH = 1.6;
const CARRY_INK = 1;
const CARRY_PITCH = 0.85;
function extendKeyByCarry(ctx: Map<Staff, StaffContext>, carry: CarryKey | undefined, bin: Binary, sp: number): void {
  if (!carry) return;
  for (const c of ctx.values()) {
    // 只看行首那段（行中转调的记号另算，见 `keyChanges`）
    const head = headKey(c);
    if (!head.length || head.length >= carry.n) continue;
    if (!head.every((k) => k.code === carry.code)) continue;
    const last = head[head.length - 1];
    // 漏在中间的（认出的几个已经占满上一页那个个数的宽度）后面没墨也补
    const span = last.box.right - Math.min(...head.map((k) => k.box.left));
    // 调号可能是别的行传过来的（`carrySystemKeys`），墨要到记号自己那一行去看
    const cy = (last.box.top + last.box.bottom) / 2;
    const home = [...ctx.values()].reduce((a, q) => (Math.abs(staffMid(q) - cy) < Math.abs(staffMid(a) - cy) ? q : a), c);
    if (span < sp * CARRY_PITCH * (carry.n - 0.5) && !inkPastKey(bin, home.staff.lineYs, last.box.right, sp)) continue;
    c.key = [...head, ...Array.from({ length: carry.n - head.length }, () => last), ...c.key.filter((k) => !head.includes(k))];
  }
}

const staffMid = (c: StaffContext) => (c.staff.lineYs[0] + c.staff.lineYs[c.staff.lineYs.length - 1]) / 2;

/** 调号最后一个记号右边还有没有像升降号竖笔的墨（见 `extendKeyByCarry`）。 */
function inkPastKey(bin: Binary, lineYs: number[], right: number, sp: number): boolean {
  if (lineYs.length < 2) return true;
  const y0 = Math.max(0, Math.round(lineYs[0] - sp * 1.5));
  const y1 = Math.min(bin.h - 1, Math.round(lineYs[lineYs.length - 1] + sp * 1.5));
  const onLine = (y: number) => lineYs.some((ly) => Math.abs(y - ly) <= sp * 0.2);
  for (let x = Math.round(right + sp * CARRY_GAP); x <= Math.min(bin.w - 1, Math.round(right + sp * CARRY_REACH)); x++) {
    let n = 0;
    // 扫描件的竖笔歪歪扭扭，一列看不全：相邻三列有一列是墨就算
    for (let y = y0; y <= y1; y++) if (!onLine(y) && (bin.data[y * bin.w + x - 1] || bin.data[y * bin.w + x] || bin.data[y * bin.w + x + 1])) n++;
    if (n >= sp * CARRY_INK) return true;
  }
  return false;
}

/** 这一页最后一行认出的调号（同种记号才算），没有就沿用上一页的。 */
function lastKey(pg: SPage, ctx: Map<Staff, StaffContext>, carry: CarryKey | undefined): CarryKey | undefined {
  for (let i = pg.staves.length - 1; i >= 0; i--) {
    const k = ctx.get(pg.staves[i])?.key ?? [];
    if (k.length && k.every((q) => q.code === k[0].code) && (k[0].code === "accidentalFlat" || k[0].code === "accidentalSharp")) return { code: k[0].code, n: k.length };
  }
  return carry;
}

/** 行首拍号离谱表左端的上限（格）：谱号、七个升降号之后的那一格。 */
const HEAD_TIME_SP = 14;
/** 终止线粗线的宽度下限（格）。 */
const FINAL_THICK = 0.3;

/** 行首一个拍号候选列：盒、中线 y、OCR 读出的上下半（读不成合法数字的是 null）。 */
interface TimeColumn {
  box: Rect;
  mid: number;
  num: number | null;
  den: number | null;
}

/**
 * **同一系统各行的拍号互证**（参照 `TimeColumn`：一个系统里每行谱的拍号同值、同 x）。
 *
 * 各行原来各认各的：大谱表高音行没认出、低音行认出了，写出端只看领头行，整首就没有拍号（新编赞美诗 035）；
 * 两行读数不同也没人裁决（071 高音 6/4、低音 4/4，谱面是 6/8）。这里按系统合起来：
 *   - 每行行首已认出的拍号投一票，OCR 上下两半都读出的候选列再各投一票（文字识别比模板签名靠得住），取票多的；
 *   - 一行都没认全时，上下两半分头凑：同一列位置上，这一行读出分子、那一行读出分母，合起来就是一个拍号；
 *   - 定下来的值写回系统里每一行（没有或读数不同的行换掉），那一列盒里被当成符头的块一并删掉。
 * 行中换拍的不管（只看谱表左端 `HEAD_TIME_SP` 格以内的）。
 *
 * **不在一首歌开头的系统从严**（一首歌只在头一个系统印拍号，别的系统行首出现拍号只会是换拍，各行必然都印）：
 * 至少两行读数相同才算数、才往别的行补；只有一行由 OCR 读出的作废——行首的和弦、休止偶尔也读得成一对数字。
 * 歌的开头 = 页上头一个系统且前页没传下拍号，或上一个系统以终止线收尾（同 `keySections`）。
 */
function shareTimeSignature(pg: SPage, ctx: Map<Staff, StaffContext>, cols: TimeColumn[], unit: RasterUnit, bin: Binary, carried: boolean): void {
  const sp = unit.space;
  const key = (t: { beats: number; beatType: number }) => `${t.beats}/${t.beatType}`;
  const groups = systemGroups(pg).sort((a, b) => a[0].box.top - b[0].box.top);
  for (const [gi, sys] of groups.entries()) {
    const staves = sys.filter((st) => ctx.has(st) && st.lineYs.length === 5);
    if (staves.length < 2) continue;
    const prev = groups[gi - 1];
    const songHead = prev ? prev.filter((st) => endsWithFinal(st, bin)).length * 2 > prev.length : !carried;
    const colsOf = (st: Staff) => cols.filter((c) => c.mid > st.box.top && c.mid < st.box.bottom);
    const headOf = (st: Staff) => {
      const all = timeSignatures(ctx.get(st)!.time, sp).filter((t) => t.x < st.box.left + sp * HEAD_TIME_SP);
      return all.length ? all[0] : null;
    };
    const votes = new Map<string, { beats: number; beatType: number; x: number; n: number; staves: Set<Staff> }>();
    const vote = (t: { beats: number; beatType: number }, x: number, st: Staff) => {
      const v = votes.get(key(t)) ?? { ...t, x, n: 0, staves: new Set<Staff>() };
      v.n++;
      v.staves.add(st);
      votes.set(key(t), v);
    };
    for (const st of staves) {
      const h = headOf(st);
      if (h) vote(h, h.x, st);
      for (const c of colsOf(st)) if (c.num !== null && c.den !== null) vote({ beats: c.num, beatType: c.den }, c.box.x, st);
    }
    if (!songHead) {
      // 从严：不够两行作证的读数，由 OCR 读出的那一行作废，别的原样不动，也不往别的行补
      const ok = [...votes.values()].filter((v) => v.staves.size >= 2).sort((a, b) => b.staves.size - a.staves.size || b.n - a.n)[0];
      if (!ok) {
        for (const st of staves) {
          const h = headOf(st);
          if (!h || !colsOf(st).some((c) => c.num === h.beats && c.den === h.beatType && Math.abs(c.box.x - h.x) <= sp * 1.5)) continue;
          const c = ctx.get(st)!;
          const old = new Set(c.time.filter((t) => Math.abs(t.px - h.x) <= sp * 3));
          c.time = c.time.filter((t) => !old.has(t));
          pg.symbols = pg.symbols.filter((s0) => !old.has(s0));
        }
        continue;
      }
      for (const k of [...votes.keys()]) if (votes.get(k) !== ok) votes.delete(k);
    }
    if (!votes.size && songHead) {
      // 上下两半分头凑：各行的候选列按 x 对齐，分子、分母各取读得出的那一行
      const all = staves.flatMap(colsOf).sort((a, b) => a.box.x - b.box.x);
      for (const c of all) {
        const near = all.filter((o) => Math.abs(o.box.x - c.box.x) <= sp * 1.5);
        const num = near.find((o) => o.num !== null)?.num ?? null;
        const den = near.find((o) => o.den !== null)?.den ?? null;
        if (num !== null && den !== null) {
          vote({ beats: num, beatType: den }, c.box.x, staves[0]);
          break;
        }
      }
    }
    if (!votes.size) continue;
    const win = [...votes.values()].sort((a, b) => b.staves.size - a.staves.size || b.n - a.n)[0];
    for (const st of staves) {
      const c = ctx.get(st)!;
      const h = headOf(st);
      if (h && key(h) === key(win)) continue;
      // 这一行原来行首那处拍号（读数不同）作废
      if (h) {
        const old = new Set(c.time.filter((t) => Math.abs(t.px - h.x) <= sp * 3));
        c.time = c.time.filter((t) => !old.has(t));
        pg.symbols = pg.symbols.filter((s0) => !old.has(s0));
      }
      const col = colsOf(st).find((o) => Math.abs(o.box.x - win.x) <= sp * 1.5);
      const x = col ? col.box.x : Math.round(win.x - sp * 0.6);
      const w = col ? col.box.w : Math.round(sp * 1.2);
      const top = Math.round(st.box.top), mid = Math.round((st.box.top + st.box.bottom) / 2), bottom = Math.round(st.box.bottom);
      const put = (n: number, y: number, h0: number) => {
        const ds = String(n).split("");
        ds.forEach((d, k) => {
          const b: Rect = { x: Math.round(x + (k * w) / ds.length), y, w: Math.round(w / ds.length), h: h0 };
          const { obj, sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, { box: b, code: `timeSig${d}` as SmuflName }, unit.height);
          pg.objs.push(obj);
          pg.symbols.push(sym);
          c.time.push(sym);
        });
      };
      put(win.beats, top, mid - top);
      put(win.beatType, mid, bottom - mid);
      // 这一列里被当成符头的块（粗体数字整块被拆成两个黑头）一并删掉
      pg.symbols = pg.symbols.filter((s0) => {
        if (!s0.hasTag("Note")) return true;
        const cx = (s0.box.left + s0.box.right) / 2, cy = (s0.box.top + s0.box.bottom) / 2;
        return !(cx > x && cx < x + w && cy > top - sp * 0.5 && cy < bottom + sp * 0.5);
      });
    }
  }
}

/**
 * **调号共享的分段**：按竖笔定调、全页共享、按系统传，都立在「整页一个调」上。一页印好几首短曲（新编赞美诗 400 阿们颂：
 * 四首各自 1♯、4♭、1♭、4♭），全页过半的四个降号把另两首也改了。一首歌只在结尾印终止线、只在头一个系统印拍号，所以
 * **上一个系统以终止线收尾**、或**整个系统每行都在行首重印拍号**的，从它起另开一段，各段分头共享。
 * 拍号这一条单靠不住（400 四首只有一首的拍号认成了拍号符号），终止线回原图量（`endsWithFinal`，这时小节线样式还没定）。
 * 只有一段的页原样返回整个 `ctx`（判据一个像素不变）。
 */
function keySections(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary): Map<Staff, StaffContext>[] {
  const groups = systemGroups(pg).sort((a, b) => a[0].box.top - b[0].box.top);
  // 行首的拍号：认出了拍号数字、且落在谱表左端往右 `HEAD_TIME_SP` 格以内（行中换拍不算新段）
  const headTime = (st: Staff) => {
    const c = ctx.get(st);
    if (!c?.time.length || st.lineYs.length !== 5) return false;
    const sp = (st.lineYs[4] - st.lineYs[0]) / 4;
    return Math.min(...c.time.map((t) => t.box.left)) < st.box.left + sp * HEAD_TIME_SP;
  };
  const secs: Staff[][] = [];
  groups.forEach((g, i) => {
    const prev = groups[i - 1];
    const fin = !!prev && prev.filter((st) => endsWithFinal(st, bin)).length * 2 > prev.length;
    if (!secs.length || fin || (i > 0 && g.every(headTime))) secs.push([]);
    secs[secs.length - 1].push(...g);
  });
  if (secs.length < 2) return [ctx];
  return secs.map((sts) => new Map(sts.filter((st) => ctx.has(st)).map((st) => [st, ctx.get(st)!] as [Staff, StaffContext])));
}

/**
 * 这一行谱是不是以**终止线**收尾：右端往左两格以内，贯穿谱表（九成的行有墨）的竖线里最右那根粗（≥ `FINAL_THICK` 格）、
 * 左边一格以内还有一根细的。
 */
function endsWithFinal(st: Staff, bin: Binary): boolean {
  if (st.lineYs.length !== 5) return false;
  const sp = (st.lineYs[4] - st.lineYs[0]) / 4;
  const y0 = Math.round(st.lineYs[0]), y1 = Math.round(st.lineYs[4]);
  const full = (x: number) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) if (bin.data[y * bin.w + x]) n++;
    return n >= (y1 - y0 + 1) * 0.9;
  };
  const runs: [number, number][] = [];
  for (let x = Math.max(0, Math.round(st.box.right - sp * 2)); x <= Math.min(bin.w - 1, Math.round(st.box.right + sp * 0.5)); x++) {
    if (!full(x)) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === x - 1) last[1] = x;
    else runs.push([x, x]);
  }
  if (runs.length < 2) return false;
  const [a, b] = runs.slice(-2);
  const thick = b[1] - b[0] + 1, thin = a[1] - a[0] + 1;
  return thick >= sp * FINAL_THICK && thin < thick * 0.6 && b[0] - a[1] <= sp;
}

/**
 * **同一系统各行的调号相同**：三行以上的系统里，认得一模一样的调号行数最多（至少两行、且比别的读法都多）的那个，
 * 就是这个系统的调号，其余行照它改。返回这样定下来的谱行——它们不再参加全页那一道共享。
 *
 * 全页共享立在「整首不转调」上；合唱谱曲中转调时，同页前后两段调号不同，按全页最长的那个补，
 * 转调前的几个系统全被改成新调（爱是从神而来 p4：前两个系统一个降号、末系统三个降号，十二行全读成三个降号）。
 * 而一个系统里四行各自认出同一个调号，是四份独立的证据，比别的系统的读数可靠。
 * 顺带把系统里个别读岔的行拉回来（同页第二系统女声行，行首 C♯ 的临时升号被并进调号读成一个升号）。
 * 只管三行以上的系统：两行的大谱表上下两行常一起漏认同一个记号，仍交给全页那一道。
 */
function shareSystemKeys(pg: SPage, ctx: Map<Staff, StaffContext>): Set<StaffContext> {
  const settled = new Set<StaffContext>();
  const sigOf = (c: StaffContext) => headKey(c).map((k) => k.code).join(",");
  for (const g of systemGroups(pg)) {
    if (g.length < 3) continue;
    const cs = g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c);
    const count = new Map<string, number>();
    for (const c of cs) if (headKey(c).length) count.set(sigOf(c), (count.get(sigOf(c)) ?? 0) + 1);
    const ranked = [...count].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 2 || (ranked[1] && ranked[1][1] === ranked[0][1])) continue;
    const best = headKey(cs.find((c) => headKey(c).length && sigOf(c) === ranked[0][0])!);
    if (best.some((k) => k.code !== best[0].code)) continue;
    for (const c of cs) {
      if (sigOf(c) !== ranked[0][0]) setHeadKey(c, best);
      settled.add(c);
    }
  }
  return settled;
}

/**
 * **谱行左端量进了系统线、括号里的**：粗的方括号加系统线有一格多宽，谱线找出来的左端落在括号左缘，
 * 「离左端几格」的取墨窗口就罩在括号的竖线上，行行有墨（烛光颂曲 p6 男声行的低音谱号被按墨改成高音）。
 * 系统线与谱号中间那道直笔的分别是**伸出谱表多远**：系统线连着上一行或下一行谱，谱号的直笔上下各只探出一格半。
 * 左端往右四格以内，谱表这一段七成半是墨、且顶线上方一到三格或底线下方一到三格也七成半是墨的列是系统线；
 * 最右那一列离左端过半格的，窗口改从它算起。贴着左端的那一根（正常情形）不动，免得窗口整体右移。
 */
function pastSysLine(bin: Binary, lineYs: number[], left: number, sp: number): number {
  const top = lineYs[0];
  const bottom = lineYs[lineYs.length - 1];
  const full = (x: number, ya: number, yb: number) => {
    let n = 0;
    let tot = 0;
    for (let y = Math.round(ya); y <= Math.round(yb); y++) {
      if (y < 0 || y >= bin.h) continue;
      tot++;
      if (bin.data[y * bin.w + x] || bin.data[y * bin.w + x - 1] || bin.data[y * bin.w + x + 1]) n++;
    }
    return tot > 0 && n >= tot * 0.75;
  };
  let last = -1;
  for (let x = Math.round(left); x <= Math.min(bin.w - 2, Math.round(left + sp * 4)); x++)
    if (full(x, top, bottom) && (full(x, top - sp * 3, top - sp) || full(x, bottom + sp, bottom + sp * 3))) last = x;
  return last > left + sp * 0.5 ? last : left;
}

/** 系统线断开处算「还连着」的墨占比（见 `bridgeFaintSysLines`）。 */
const SYS_LINE_INK = 0.5;
/** 系统线断开处，一列里最长的空白不到这么多格才算虚线（括号钩之间的白有一格半）。 */
const SYS_LINE_GAP = 0.8;
/** 两个系统左端差在这么多格以内，才在两个左端之间整段找那条线。 */
const SYS_LINE_DX = 6;

/**
 * **系统线淡得断成虚线的系统并回去**：系统由谱行左端那条竖线（或括号）串起来；扫描件上人声方括号与
 * 钢琴大谱表之间那一截细线常断成虚线，抽不成竖段，一个系统裂成两三个（烛光颂曲 p3 七行裂成 5 + 2、
 * p6 四行裂成 2 + 2、p7 裂成 4 + 1 + 1）。
 * 直接在原图上量：相邻两个系统之间，上面那个系统谱行左端一格以内，找墨最满的一列（左右各容一像素），
 * 这一截里有墨的行过 `SYS_LINE_INK` 的就是系统线还连着——真正的系统间隔那一列是白的
 *（六首合唱谱实测 0.03~0.34，断开的 0.77~0.99）。连着的几个系统补一个罩住它们的系统括号。
 */
function bridgeFaintSysLines(pg: SPage, bin: Binary, sp: number): void {
  const groups = systemGroups(pg);
  const linked = (a: Staff, b: Staff) => {
    const y0 = Math.round(a.box.bottom + sp * 0.5);
    const y1 = Math.round(b.box.top - sp * 0.5);
    if (y1 - y0 < sp * 2) return false;
    const ink = (x: number, y: number) => x >= 0 && x < bin.w && bin.data[y * bin.w + x] === 1;
    // 下面那行的左端量短了（淡得只剩后半截）时，线在两行左端之间的某一列；差得太远的是缩进不同的两个系统，只看上面那行的
    const near = Math.abs(a.box.left - b.box.left) <= sp * SYS_LINE_DX;
    const xa = near ? Math.min(a.box.left, b.box.left) : a.box.left;
    const xb = near ? Math.max(a.box.left, b.box.left) : a.box.left;
    // 墨过半之外，这一列里**最长的一段空白**还要不到 `SYS_LINE_GAP` 格：两个系统挨得近时，上一个括号的下钩、下一个括号
    // 往上伸出的一截把间隔两头填满，墨量过半（新编赞美诗 367 第 2、3 系统，0.57），中间却隔着一格半的白；虚线的断口都短
    for (let x = Math.round(xa - sp); x <= Math.round(xb + sp); x++) {
      let n = 0, gap = 0, maxGap = 0;
      for (let y = y0; y <= y1; y++) {
        if (ink(x, y) || ink(x - 1, y) || ink(x + 1, y)) (n++, (gap = 0));
        else maxGap = Math.max(maxGap, ++gap);
      }
      if (n / (y1 - y0 + 1) >= SYS_LINE_INK && maxGap < sp * SYS_LINE_GAP) return true;
    }
    return false;
  };
  let run: Staff[][] = [];
  const flush = () => {
    if (run.length > 1) {
      const sts = run.flat();
      const top = Math.min(...sts.map((s) => s.box.top));
      const bottom = Math.max(...sts.map((s) => s.box.bottom));
      const left = Math.min(...sts.map((s) => s.box.left));
      pg.objs.push(makeSysBracketObj(pg.objs.length + pg.segs.length + 1, { x: left - sp, y: top, w: sp * 0.5, h: bottom - top }));
    }
    run = [];
  };
  for (const g of groups) {
    const prev = run[run.length - 1];
    if (prev && !linked(prev[prev.length - 1], g[0])) flush();
    run.push(g);
  }
  flush();
}

/**
 * **按系统定下来的调号往没定的行传**：`shareSystemKeys` 定了调号的系统不参加全页共享，页上别的行
 * （一行没认出的系统、认岔的两行大谱表）就没处借了。调号管到下一次改之前，所以没定的行照**上一个**定了的系统补
 * （页首没有上一个的照下一个）：
 *   - 一个记号都没认出的行、认出的是它的前几个的行，补足；
 *   - 读法不同的行，同一系统里有别的行与它一致才改（同一系统各行调号相同，两行互证；
 *     烛光颂曲低音谱表把头一个降号的肚子读成一个升号）。
 * 曲中转成 C 大调的系统本来就没有调号，会被补上前一个调——这样的谱还没遇到，遇到了要另看还原号。
 */
function carrySystemKeys(pg: SPage, ctx: Map<Staff, StaffContext>, settled: Set<StaffContext>): void {
  const groups = systemGroups(pg).map((g) => g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c));
  const keyOf = groups.map((cs) => { const c = cs.find((c) => settled.has(c) && headKey(c).length); return c ? headKey(c) : undefined; });
  const sigOf = (k: Sym[]) => k.map((q) => q.code).join(",");
  // 没有哪个系统定下来的页（全是两行的大谱表）：过半的行读成同一个调号的，拿它当参照
  let pageRef: Sym[] | undefined;
  if (!settled.size) {
    const all = groups.flat();
    const count = new Map<string, number>();
    for (const c of all) if (headKey(c).length) count.set(sigOf(headKey(c)), (count.get(sigOf(headKey(c))) ?? 0) + 1);
    const top = [...count].sort((a, b) => b[1] - a[1])[0];
    const k = top && top[1] * 2 > all.length ? headKey(all.find((c) => sigOf(headKey(c)) === top[0])!) : undefined;
    if (k && k.every((q) => q.code === k[0].code)) pageRef = k;
    if (!pageRef) return;
  }
  for (const [i, cs] of groups.entries()) {
    if (keyOf[i]) continue;
    const ref = pageRef ?? keyOf.slice(0, i).reverse().find((k) => k) ?? keyOf.slice(i + 1).find((k) => k);
    if (!ref) continue;
    const want = sigOf(ref);
    const isPrefix = (c: StaffContext) => headKey(c).length < ref.length && headKey(c).every((k, j) => k.code === ref[j].code);
    // 作证的行：读得与它一样，或认出了它的前几个
    const agree = cs.some((c) => sigOf(headKey(c)) === want || (headKey(c).length > 0 && isPrefix(c)));
    for (const c of cs) if (isPrefix(c)) setHeadKey(c, ref);
    // 读法不同的行：有作证的行、或补过之后过半的行都是它，才改
    const same = cs.filter((c) => sigOf(headKey(c)) === want).length;
    // 比它多认出几个同种记号的行不收回来——按块、按笔数出来的个数只会少不会多
    const longer = (c: StaffContext) => headKey(c).length > ref.length && headKey(c).every((k) => k.code === ref[0].code);
    if (agree || same * 2 > cs.length) for (const c of cs) if (!longer(c)) setHeadKey(c, ref);
  }
}

function shareKeySignature(ctx: Map<Staff, StaffContext>, settled = new Set<StaffContext>()): void {
  const all = [...ctx.values()].filter((c) => !settled.has(c));
  const sigOf = (c: StaffContext) => headKey(c).map((k) => k.code).join(",");
  const count = new Map<string, number>();
  for (const c of all) if (headKey(c).length) count.set(sigOf(c), (count.get(sigOf(c)) ?? 0) + 1);
  let best: StaffContext | null = null;
  for (const c of all) if (headKey(c).length && count.get(sigOf(c))! >= 2 && (!best || headKey(c).length > headKey(best).length)) best = c;
  // 最长的那个只出现一次也行——只要别的行（至少两行）认出的都是它的**前几个**：
  // 敬拜万世之王五行里一行认出两个降号、四行只认出头一个（第二个降号被去谱线切碎）
  const longest = all.filter((c) => headKey(c).length).sort((a, b) => headKey(b).length - headKey(a).length)[0];
  const others = all.filter((c) => headKey(c).length && c !== longest);
  // 混着两种记号的不当「最长」：行首调号不会升降混排，那是多认了一个（我灵镇静第三行低音谱表「♭♯」，
  // 选中它后整条共享因混排作罢，另两行低音谱表的 1♭ 都没补上）
  const pure = (c: StaffContext) => headKey(c).every((k) => k.code === headKey(c)[0].code);
  if (longest && pure(longest) && others.length >= 2 && (!best || headKey(longest).length > headKey(best).length) && others.every((c) => headKey(c).every((k, i) => k.code === headKey(longest)[i]?.code)))
    best = longest;
  if (!best) return;
  const bk = headKey(best);
  const kind = bk[0].code;
  if (bk.some((k) => k.code !== kind)) return;
  // 串里混着**还原号**的也照补：行首谱号后面的调号不会有还原号（取消记号印在转调前的小节线处），
  // 那是粘连的升降号认岔了——万福泉源歌第一行三个降号挤在一起，前两个连成一块读成还原号，
  // 这一行（也就是整首高音声部）只剩一个降号
  for (const c of all) {
    const h = headKey(c);
    if (h.length <= bk.length && h.every((k) => k.code === kind || k.code === "accidentalNatural") && h.filter((k) => k.code === kind).length < bk.length)
      setHeadKey(c, bk);
    // 前面几个与共享的那串一致、后面跟着异种记号的：后面那几个是多认的
    else if (h.length > bk.length && bk.every((_, i) => h[i]?.code === kind) && h.slice(bk.length).every((k) => k.code !== kind))
      setHeadKey(c, bk);
  }
}

/** 两个盒的交叠占 `a` 的比例。 */
/**
 * **按竖笔数调号升号**（Audiveris 的路子：不看连通块，看竖笔）。粗体升号两两粘连、又贴着谱号时，
 * 按块认不出来（《耶和华是我的牧者》：一对升号连成 2.3×4.8 格一块，被读成一串降号、假符头）。
 *
 * 在带谱线的原图上，从谱号左缘起 `KEY_FROM` 格（谱号盒吞了升号时按正常谱号宽度起算）往右，逐列找
 * 2 格以上的竖直连续墨；两根相距 0.15~0.8 格、中列在竖笔中点上下各有一道厚 0.25 格以上横杠的是一个升号。
 * 串从头起、相邻不隔 1.6 格；碰到别的竖笔（降号、符干、拍号）就停。返回各升号的盒（两根竖笔围的那一段）。
 */
function sharpsByStrokes(bin: Binary, lineYs: number[], clef: Rect, sp: number): Rect[] {
  const top = lineYs[0];
  const bottom = lineYs[lineYs.length - 1];
  const x0 = Math.round(clef.x + Math.min(clef.w, sp * KEY_FROM));
  const box: Rect = { x: x0, y: Math.max(0, Math.round(top - sp * 1.5)), w: Math.round(sp * 9), h: Math.round(bottom - top + sp * 3) };
  if (box.x + box.w > bin.w || box.y + box.h > bin.h) return [];
  const strokes = verticalStrokes(bin, box, sp * 2);
  // 中列上厚 0.25 格以上的横杠，要**一道在竖笔中点以上、一道在以下**：相邻两个降号的竖笔也相距半格多，
  // 中列穿过前一个降号的肚子也是两道墨，可那两道都在竖笔下半截（《所信有根基》四个降号被数成两个升号）
  const barsAcross = (xm: number, t: number, b: number): boolean => {
    const mid = (t + b) / 2;
    let up = false;
    let dn = false;
    let run = 0;
    for (let y = box.y; y <= box.y + box.h; y++) {
      if (y < box.y + box.h && bin.data[y * bin.w + xm]) run++;
      else {
        if (run >= sp * 0.25) {
          const c = y - run / 2;
          if (c < mid) up = true;
          else dn = true;
        }
        run = 0;
      }
    }
    return up && dn;
  };
  const out: Rect[] = [];
  let lastX = x0;
  for (let i = 0; i + 1 < strokes.length; i += 2) {
    const a = strokes[i];
    const b = strokes[i + 1];
    if (a.h > sp * 3.6 || b.h > sp * 3.6) break;
    const d = (b.x0 - a.x1) / sp;
    if (d < 0.15 || d > 0.8) break;
    if ((a.x0 - lastX) / sp > (out.length ? 1.6 : 2.5)) break;
    if (!barsAcross(Math.round((a.x1 + b.x0) / 2), Math.min(a.top, b.top), Math.max(a.bottom, b.bottom))) break;
    const t = Math.min(a.top, b.top);
    // 横杠左右各探出竖笔约 0.2 格：盒按竖笔量会窄一截，调号串按盒缝判连续，窄了就在第三个上断开（齐来称颂 3 → 2 个）
    const pad = Math.round(sp * 0.2);
    out.push({ x: a.x0 - pad, y: t, w: b.x1 - a.x0 + 1 + pad * 2, h: Math.max(a.bottom, b.bottom) - t + 1 });
    lastX = b.x1;
  }
  return out;
}

/**
 * **多行系统里一行有小节线、另一行同处没抽出竖段的，回原图上验墨补一根**（在 `tagSystemBarlines` 之前）。
 *
 * 粗一点、略斜的小节线过不了竖段抽取（新编赞美诗 12 颂主化功歌第一行高音谱表 x≈499：五像素宽、
 * 自上而下往左漂两像素，一段都没抽出来），那一行就少一条小节线，与另一行错开。
 * 以另一行「两端压在外线上的竖段」的 x 为准，在这一行左右 0.6 格内找一列：从第五线到第一线几乎不断墨
 *（逐行可左右挪一列，总共漂不过 0.15 格）、是根细线、且上下都不伸出谱表（伸出去的是符干）。
 * 作准的那一根自己也要过同一道验墨；各行都验到才补。
 */
function inkSystemBarlines(pg: SPage, bin: Binary, sp: number): void {
  const tol = sp * 0.3;
  const xTol = sp * 0.6;
  const barAt = makeBarAt(bin, sp);
  for (const g of systemGroups(pg)) {
    if (g.length < 2) continue;
    const lands = (y: number) => g.some((st) => Math.abs(y - st.box.top) <= tol || Math.abs(y - st.box.bottom) <= tol);
    const barOn = (l: Seg, st: Staff) =>
      l.isV && (!l.hasAnyTag() || l.hasTag("BarLine")) && l.top <= st.box.top + tol && l.bottom >= st.box.bottom - tol && lands(l.top) && lands(l.bottom) && Math.abs(st.box.left - l.cx) >= sp;
    for (const a of g)
      for (const l of pg.segs.filter((q) => barOn(q, a))) {
        const lack = g.filter((b) => b !== a && !pg.segs.some((m) => barOn(m, b) && Math.abs(m.cx - l.cx) <= xTol));
        if (!lack.length) continue;
        // 作准的那一根自己也得过验墨：被谱线切出来、恰好两端压在外线上的一截符干不算
        if (barAt(a, l.cx, 2) === null) continue;
        const xs = lack.map((b) => barAt(b, l.cx, Math.round(xTol)));
        if (xs.some((x) => x === null)) continue;
        lack.forEach((b, i) => {
          const x = xs[i]!;
          pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: x, y0: b.box.top, x1: x, y1: b.box.bottom, lw: l.lw, maxLw: l.lw });
        });
      }
    // **各行都没抽出竖段的小节线**：淡印的页上下两行同时漏（助我进深歌每个系统漏一两条，上面那一趟要有一行抽得出才补得了）。
    // 沿头一行逐列验墨，过了的再到别的行左右 `xTol` 内验；行行都是「盖满谱行的细线、上下不外伸」才补，
    // 离已有的小节线、系统线一格以内的不重复补。两行的干同时正好盖满各自的谱行、又同 x，几乎碰不上。
    const have = (st: Staff, x: number) => pg.segs.some((m) => barOn(m, st) && Math.abs(m.cx - x) <= sp);
    const first = g[0];
    for (let x = Math.round(first.box.left + sp * 3); x < first.box.right - sp; x++) {
      if (have(first, x) || barAt(first, x, 0, true) === null) continue;
      const xs = g.slice(1).map((b) => barAt(b, x, Math.round(xTol), true));
      if (xs.some((q) => q === null)) continue;
      if (g.slice(1).some((b, i) => have(b, xs[i]!))) continue;
      const lw = Math.max(1, first.lines[0]?.lw ?? 1);
      pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: x, y0: first.box.top, x1: x, y1: first.box.bottom, lw, maxLw: lw });
      g.slice(1).forEach((b, i) => pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: xs[i]!, y0: b.box.top, x1: xs[i]!, y1: b.box.bottom, lw, maxLw: lw }));
      x += Math.round(sp);
    }
  }
}

/**
 * **多行系统里只在一行上有的小节线，别的行同处原图上也没有竖墨，就不是小节线**（在 `findBarlines` 之后）。
 *
 * `findBarlines` 那道「别的行同 x 有像样的竖线才留」放得松（别的行那一根挂成符干的也算，扫描件上真小节线断得多），
 * 钢琴右手和弦的长干正好盖满谱行、左手同处又有一根别的干时照样留下（是爱 p5 首行钢琴右手多切一刀，
 * 左手没切，两行从此错开一小节）。这里回原图上验：别的每一行在同 x 左右 0.6 格内都找不到一根贯穿谱行的细竖墨
 *（不管上下伸不伸出去——大谱表的小节线本来就连着上下两行），才摘掉。
 */
function dropLoneBarlines(pg: SPage, bin: Binary, sp: number): void {
  const xTol = sp * 0.6;
  const barAt = makeBarAt(bin, sp);
  for (const g of systemGroups(pg)) {
    if (g.length < 2) continue;
    const on = (l: Seg, st: Staff) => l.bottom > st.box.top + sp && l.top < st.box.bottom - sp;
    const bars = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && g.some((st) => on(l, st)));
    for (const l of bars) {
      const own = g.filter((st) => on(l, st));
      const others = g.filter((st) => !own.includes(st));
      if (!others.length) continue;
      // 行末的小节线不查：各行右端参差，别的行的那一根常被当成谱行右界、没进竖段
      if (own.some((st) => l.cx > st.box.right - sp * 1.5)) continue;
      const backed = others.some((st) => bars.some((m) => m !== l && on(m, st) && Math.abs(m.cx - l.cx) <= xTol) || barAt(st, l.cx, Math.round(xTol), false, true) !== null);
      if (!backed) l.removeTag("BarLine");
    }
  }
}

/**
 * **贯穿上下两行谱的小节线，在两行之间断成两截的接回一根**（建页之前）。
 *
 * 大谱表的小节线从上一行的顶线一直画到下一行的底线。竖段抽取在两行之间那一截常抽不出来
 *（旁边贴着反复记号的粗线，孤立性过不了：爱是从神而来首行 `|:` 的细线只剩压在两行谱上的两截），
 * 剩下的两截各自伸出谱表三四分之一格、又不落在任何一行的外线上，`findBarlines` 当它是符干，这一处的小节线就丢了。
 * 两截各盖满一行谱（两端离外线不过 `THROUGH_END` 格）、同 x、中间那一段原图上**每行都有墨**，就是同一根。
 */
function joinThroughBars(bin: Binary, segs: LineSeg[], staves: [number, number][], sp: number): LineSeg[] {
  const top = (v: LineSeg) => Math.min(v.y0, v.y1);
  const bot = (v: LineSeg) => Math.max(v.y0, v.y1);
  const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
  const tol = sp * THROUGH_END;
  /** 这一截盖满第几行谱（没有返回 -1） */
  const coverOf = (v: LineSeg) => staves.findIndex(([a, b]) => Math.abs(top(v) - a) <= tol && Math.abs(bot(v) - b) <= tol);
  const rows = [...staves].sort((a, b) => a[0] - b[0]);
  const cand = segs.filter((v) => bot(v) - top(v) > Math.abs(v.x1 - v.x0) && coverOf(v) >= 0).sort((a, b) => top(a) - top(b));
  const used = new Set<LineSeg>();
  const out: LineSeg[] = [];
  for (const a of cand) {
    if (used.has(a)) continue;
    let cur = a;
    for (let again = true; again; ) {
      again = false;
      for (const b of cand) {
        if (b === a || used.has(b) || top(b) <= bot(cur) || Math.abs(cx(b) - cx(cur)) > sp * 0.2) continue;
        // 中间不能隔着别的谱行
        if (rows.some(([ra, rb]) => ra > bot(cur) + tol && rb < top(b) - tol)) continue;
        const x = Math.round((cx(b) + cx(cur)) / 2);
        let solid = true;
        for (let y = Math.ceil(bot(cur)); y <= Math.floor(top(b)) && solid; y++) {
          const row = y * bin.w;
          solid = !!(bin.data[row + x] || bin.data[row + x - 1] || bin.data[row + x + 1]);
        }
        if (!solid) continue;
        const la = bot(cur) - top(cur);
        const lb = bot(b) - top(b);
        const xm = (cx(cur) * la + cx(b) * lb) / (la + lb);
        cur = { x0: xm, x1: xm, y0: top(cur), y1: bot(b), lw: (cur.lw * la + b.lw * lb) / (la + lb), maxLw: Math.max(cur.maxLw, b.maxLw) };
        used.add(b);
        again = true;
        break;
      }
    }
    if (cur !== a) (used.add(a), out.push(cur));
  }
  // **盖满两行以上谱的竖线，伸出去的那一截剪掉**：小节线上端接着反复房号括线的竖钩（是爱 p5 钢琴两行「1.」起处，
  // 竖钩从顶线上方三格起、与小节线同 x 连成一根），上端不落在任何一行的外线上，被当成符干。
  // 符干不会把上下两行谱都盖满；剪到所盖各行最外的两条线上，就是一根正经的贯穿小节线。
  const clip = (v: LineSeg): LineSeg => {
    if (bot(v) - top(v) <= Math.abs(v.x1 - v.x0)) return v;
    const cov = rows.filter(([ra, rb]) => top(v) <= ra + sp * 0.3 && bot(v) >= rb - sp * 0.3);
    if (cov.length < 2) return v;
    const ya = cov[0][0];
    const yb = cov[cov.length - 1][1];
    if (top(v) >= ya - sp * 0.3 && bot(v) <= yb + sp * 0.3) return v;
    return { ...v, y0: Math.max(top(v), ya), y1: Math.min(bot(v), yb) };
  };
  return [...segs.filter((v) => !used.has(v)), ...out].map(clip);
}

/**
 * **三行以上的系统，小节线按行数表决**（在 `findBarlines` 之后）。同一系统各行的小节线同 x，这是版式的铁律；
 * 低分辨率的合唱扫描件上每行各错各的——这一行漏一根（线断了、被符头压着），那一行多一根（调号降号的竖笔、
 * 贴着小节线的升降号被收成小节线），七行里各行的小节数是 4/4/5/5/5/5/4（烛光颂曲 p2），逐行对不上。
 * 把各行的小节线按 x 归簇（0.6 格内）：
 *   - **过半的行都有**的簇，缺的行照簇的中位 x 补一根（不再验墨：别的行已经作了证）；
 *   - **只有不到三分之一的行有**、别的行原图上同处也没有贯穿谱行的细竖墨的簇，摘掉。
 * 两行的系统不走这里（两行各执一词时没有多数，交给验墨的那两道）。
 */
function voteSystemBarlines(pg: SPage, bin: Binary, sp: number): void {
  const xTol = sp * 0.6;
  const barAt = makeBarAt(bin, sp);
  for (const g of systemGroups(pg)) {
    if (g.length < 3) continue;
    const on = (l: Seg, st: Staff) => l.bottom > st.box.top + sp && l.top < st.box.bottom - sp;
    const bars = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && g.some((st) => on(l, st))).sort((a, b) => a.cx - b.cx);
    // 归簇：与簇里最后一根相距不过 xTol
    const clusters: Seg[][] = [];
    for (const l of bars) {
      const c = clusters[clusters.length - 1];
      if (c && l.cx - c[c.length - 1].cx <= xTol) c.push(l);
      else clusters.push([l]);
    }
    for (const c of clusters) {
      const rows = g.filter((st) => c.some((l) => on(l, st)));
      const xs = c.map((l) => l.cx).sort((a, b) => a - b);
      const x = xs[xs.length >> 1];
      if (rows.length * 2 > g.length) {
        const lw = Math.max(1, c[0].lw);
        for (const st of g) {
          if (rows.includes(st)) continue;
          // 行末那一根各行右端参差，离本行右端一格半以内的不补（本行的右界就是它）
          if (x > st.box.right - sp * 1.5 || x < st.box.left + sp) continue;
          pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: x, y0: st.box.top, x1: x, y1: st.box.bottom, lw, maxLw: lw }).addTag("BarLine");
        }
      } else if (rows.length * 3 <= g.length) {
        const others = g.filter((st) => !rows.includes(st));
        const backed = others.filter((st) => barAt(st, x, Math.round(xTol), false, true) !== null).length;
        if (backed + rows.length <= g.length / 3) for (const l of c) l.removeTag("BarLine");
      }
    }
  }
}

/** 原图上验「这一行在某个 x 附近有没有一根小节线模样的竖墨」（`inkSystemBarlines` / `dropLoneBarlines` 共用）。 */
function makeBarAt(bin: Binary, sp: number): (st: Staff, cx: number, range: number, strict?: boolean, through?: boolean) => number | null {
  const ink = (x: number, y: number) => x >= 0 && x < bin.w && y >= 0 && y < bin.h && bin.data[y * bin.w + x] === 1;
  /** 这一行里含 x 的那段横向连续墨的宽度 */
  const runW = (x: number, y: number) => {
    let a = x;
    let b = x;
    while (ink(a - 1, y)) a--;
    while (ink(b + 1, y)) b++;
    return b - a + 1;
  };
  /**
   * 从 (x0, y0) 往下走到 y1（逐行可左右挪一列，总共漂不过 0.15 格）。返回断墨的行数、最长一段断口、
   * 横向墨宽过 0.4 格的行数（穿过符头、升号横杠、谱线的那些行）与走过的列范围。
   */
  const walk = (x0: number, y0: number, y1: number) => {
    let x = x0;
    let miss = 0;
    let run = 0;
    let worst = 0;
    let wide = 0;
    let lo = x0;
    let hi = x0;
    for (let y = y0; y <= y1; y++) {
      if (ink(x, y)) run = 0;
      else if (ink(x - 1, y)) (x--, (run = 0));
      else if (ink(x + 1, y)) (x++, (run = 0));
      else {
        miss++;
        worst = Math.max(worst, ++run);
        continue;
      }
      if (Math.abs(x - x0) > sp * 0.15) return null;
      if (runW(x, y) > sp * 0.4) wide++;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return { miss, worst, wide, lo, hi };
  };
  /** [y0, y1] 这几行里，[xa, xb] 左右各一列内有墨的行占比 */
  const inked = (xa: number, xb: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      let any = false;
      for (let x = xa - 1; x <= xb + 1 && !any; x++) any = ink(x, y);
      if (any) n++;
    }
    return n / Math.max(1, y1 - y0 + 1);
  };
  /** st 这一行在 cx 左右 range 像素内有没有一根小节线模样的竖墨；有则返回它的列。`through`：不查上下伸不伸出谱表 */
  return (st: Staff, cx: number, range: number, strict = false, through = false): number | null => {
    const top = Math.round(st.box.top);
    const bottom = Math.round(st.box.bottom);
    const rows = bottom - top + 1;
    for (let d = 0; d <= range; d++)
      for (const x of d ? [Math.round(cx) - d, Math.round(cx) + d] : [Math.round(cx)]) {
        const w = walk(x, top, bottom);
        if (!w || w.miss > rows * 0.06 || w.worst > 2) continue;
        // 细线：除去五条谱线那几行，横向墨宽的行不能多（贴着符头、穿过升号的竖笔过不了）
        if (w.wide > rows * 0.3) continue;
        // 没有竖段作证的那一趟从严：谱线以外的行，横向墨宽的不过两行——贴着符头的干（头占一格高）过不了
        //（父恩广大、我愿象主歌各多切一刀）
        if (strict) {
          let fat = 0;
          for (let y = top; y <= bottom; y++) {
            if (st.lineYs.some((ly) => Math.abs(ly - y) <= sp * 0.15)) continue;
            const xx = [x, x - 1, x + 1, x - 2, x + 2].find((q) => ink(q, y));
            if (xx !== undefined && runW(xx, y) > sp * 0.4) fat++;
          }
          if (fat > 2) continue;
        }
        // 上下各往外 0.4~0.9 格那一截不能有墨（符干、连谱号、系统线都会伸出去）
        if (!through && inked(w.lo, w.hi, Math.round(top - sp * 0.9), Math.round(top - sp * 0.4)) > 0.3) continue;
        if (!through && inked(w.lo, w.hi, Math.round(bottom + sp * 0.4), Math.round(bottom + sp * 0.9)) > 0.3) continue;
        return x;
      }
    return null;
  };
}

/**
 * **小节多出几个八分的拍数，就有几个四分其实是八分**。密排的单符尾八分（一个音一根尾，不连杠），尾巴贴着下一个音的头，
 * 零星有一个认不出尾、读成四分（新编赞美诗 265 愿跟随主歌，几乎每小节一个），这一小节就多出八分之一拍。
 * 拍号认出来了才做。按干朝向分声部，某个声部的时值和比拍号多 k 个八分（不过半小节）时，
 * 把这个声部里**到下一个音最近**的 k 个四分改成八分——八分的间距本来就比四分小；
 * k 正好等于四分的个数就全改，否则第 k 近的要明显比第 k+1 近的小（八成以内），分不开的不动。
 */
function fixQuartersByBarSum(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[], carry: { beats: number; beatType: number } | undefined, sp: number): void {
  if (!lastTimeSignature(pg, ctx, carry)) return;
  const eps = 1e-6;
  for (const b of checkBars(pg, ctx, notes, carry)) {
    const bar = b.staff.bars[b.index];
    const inBar = notes.filter((n) => n.staff === b.staff && n.x >= bar.left && n.x < bar.right && !n.grace).sort((p, q) => p.x - q.x);
    // **不满四拍的拍号里没有全音符**：3/4、2/4、6/8 的小节装不下一个全音符，读成全音符的是干没挂上的二分音符
    //（两声部叠着的空心头，干被另一个头的圈截断；整本「二分读成全音符」五百处）。附点照留（3/4 里的附点二分）。
    if (b.expect < 1 - eps)
      for (const n of inBar)
        if (!n.rest && n.base === 1 && n.sym.code === "noteheadWhole") {
          n.base = 1 / 2;
          n.duration = (1 / 2) * (2 - 1 / 2 ** n.dots);
        }
    // 四拍的小节里**先后两处全音符**也一样：一个小节装不下两个，都是没挂上干的二分音符
    else {
      const wholes = inBar.filter((n) => !n.rest && n.base === 1 && n.sym.code === "noteheadWhole");
      if (wholes.some((n) => Math.abs(n.x - wholes[0].x) > sp * 2) && b.expect < 2 - eps)
        for (const n of wholes) {
          n.base = 1 / 2;
          n.duration = (1 / 2) * (2 - 1 / 2 ** n.dots);
        }
    }
    if (b.full) continue;
    const dirs = [...new Set(inBar.filter((n) => !n.rest).map((n) => n.stemUp))];
    for (const d of dirs.length > 1 ? dirs : [undefined]) {
      // 这个声部的各列（同 x 的几个头算一列，时值取最短的那个）；休止两个声部都算
      const mine = inBar.filter((n) => n.rest || d === undefined || n.stemUp === d);
      const cols: { x: number; dur: number; ns: StaffNote[] }[] = [];
      for (const n of mine) {
        const c = cols[cols.length - 1];
        if (c && n.x - c.x <= sp * 0.6) (c.dur = Math.min(c.dur, n.duration)), c.ns.push(n);
        else cols.push({ x: n.x, dur: n.duration, ns: [n] });
      }
      const over = cols.reduce((a, c) => a + c.dur, 0) - b.expect;
      const k = Math.round(over * 8);
      if (k < 1 || Math.abs(over * 8 - k) > eps || over > b.expect / 2 + eps) continue;
      const quarter = (c: (typeof cols)[number]) => c.ns.every((n) => !n.rest && n.base === 1 / 4 && !n.dots && n.sym.code === "noteheadBlack");
      const cand = cols
        .map((c, i) => ({ c, gap: (cols[i + 1]?.x ?? bar.right) - c.x }))
        .filter((q) => quarter(q.c))
        .sort((p, q) => p.gap - q.gap);
      if (cand.length < k) continue;
      if (cand.length > k && cand[k - 1].gap > cand[k].gap * 0.8) continue;
      for (const { c } of cand.slice(0, k))
        for (const n of c.ns) {
          n.base = 1 / 8;
          n.duration = 1 / 8;
          n.beams = Math.max(n.beams, 1);
        }
    }
  }
}

/**
 * **附点八分后面跟的那个八分，其实是十六分**。「附点八分 + 十六分」凑一拍是最常见的附点节奏，
 * 低分辨率底本上十六分的两条符尾糊成一条，读成八分（新编赞美诗 373 仰望天家歌整首都是这个节奏，
 * 每个小节多出八分之一拍，后面的音拍位全错开）。「附点八分 + 八分」在这类谱里几乎不出现，
 * 所以附点八分右边**同一声部**（干朝向相同、同一小节）紧跟的那一个八分改成十六分；和弦里的几个头一起改。
 * 干朝向不明的不动。
 */
function fixDottedPairs(notes: StaffNote[], sp: number): void {
  const barOf = (n: StaffNote) => n.staff.bars.find((b) => n.x >= b.left && n.x < b.right);
  const by = new Map<Staff, StaffNote[]>();
  for (const n of notes) if (!n.rest) (by.get(n.staff) ?? by.set(n.staff, []).get(n.staff)!).push(n);
  for (const ns of by.values()) {
    ns.sort((a, b) => a.x - b.x);
    for (const a of ns) {
      if (a.dots !== 1 || a.base !== 1 / 8 || a.stemUp === null) continue;
      const bar = barOf(a);
      const next = ns.find((b) => b.x > a.x + sp * 0.8 && b.stemUp === a.stemUp && barOf(b) === bar);
      if (!next || next.x - a.x > sp * 6) continue;
      for (const b of ns) {
        if (Math.abs(b.x - next.x) > sp * 0.6 || b.stemUp !== a.stemUp || b.base !== 1 / 8 || b.dots) continue;
        b.base = 1 / 16;
        b.duration = 1 / 16;
        b.beams = Math.max(b.beams, 2);
      }
    }
  }
}

/**
 * **挂「8」没认出来的高音谱号，照别的系统同一位置的定**。「8」贴在谱号尾巴底下，扫描件上尾巴断开、
 * 「8」淡得连不上时量不出来（烛光颂曲 p3、p7 各一个七行系统的男高音行读成普通高音谱号，整行高八度）。
 * 分谱的合唱谱里行数相同、各行高低音谱号排法也相同的系统是同一套声部，同一位置的谱号相同：
 * 这个位置在见过的系统里（本页的连同前面各页带下来的）至少两次、且过半读成低八度谱号，没读出来的就照它改。
 * 只管四行以上的系统：三行的「独唱 + 钢琴」换一个声部唱，行数与排法都不变。只增不减——挂着的「8」只会漏认。
 * 返回更新后的见证，随 `carryKey` 带到下一页。
 */
function shareOctaveClefs(pg: SPage, ctx: Map<Staff, StaffContext>, carry: ClefTally | undefined): ClefTally {
  const tally: ClefTally = {};
  for (const [k, v] of Object.entries(carry ?? {})) tally[k] = { seen: v.seen, g8: v.g8.slice() };
  const rows: { key: string; cs: StaffContext[] }[] = [];
  for (const g of systemGroups(pg)) {
    if (g.length < 4) continue;
    const cs = g.map((st) => ctx.get(st));
    if (!cs.every((c): c is StaffContext => !!c?.clef && (c.clef.code === "gClef" || c.clef.code === "gClef8vb" || c.clef.code === "fClef"))) continue;
    const key = `${g.length}:${cs.map((c) => (c.clef!.code === "fClef" ? "f" : "g")).join("")}`;
    const t = (tally[key] ??= { seen: 0, g8: cs.map(() => 0) });
    t.seen++;
    cs.forEach((c, i) => {
      if (c.clef!.code === "gClef8vb") t.g8[i]++;
    });
    rows.push({ key, cs });
  }
  for (const { key, cs } of rows) {
    const t = tally[key];
    cs.forEach((c, i) => {
      if (c.clef!.code === "gClef" && t.g8[i] >= 2 && t.g8[i] * 2 > t.seen) c.clef!.code = "gClef8vb";
    });
  }
  return tally;
}

/**
 * **多行系统各行的行首谱号按全页的多数定**。闭合谱每个系统都是「高音谱表 + 低音谱表」，
 * 可第一系统的低音谱号挨着拍号、常被读成高音谱号（或干脆没认出来），那一行的音全按高音谱表读，
 * 整首只剩三成（新编赞美诗 149 每日新恩歌、213 曾否就主歌、121 将见我王歌）。
 * 行数相同的系统至少两个、某个位置上过半的系统认出同一种谱号，其余系统那个位置就照它改；没认出谱号的补一个。
 * 只动行首那一个（行中换谱号的不管）。
 */
function shareSystemClefs(pg: SPage, ctx: Map<Staff, StaffContext>, unit: { space: number; height: number }): void {
  const byLen = new Map<number, Staff[][]>();
  // 只管两行的系统（大谱表）：合唱谱三行以上的系统行数相同、声部却不同（女声加钢琴 / 男声加钢琴），
  // 同一位置的谱号本来就不一样（合唱谱干净档按谱行 98.17 → 97.94）
  for (const g of systemGroups(pg)) if (g.length === 2) (byLen.get(g.length) ?? byLen.set(g.length, []).get(g.length)!).push(g);
  for (const [len, gs] of byLen) {
    if (gs.length < 2) continue;
    for (let i = 0; i < len; i++) {
      const tally = new Map<SmuflName, number>();
      for (const g of gs) {
        const code = ctx.get(g[i])?.clef?.code;
        if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
      }
      let [code, n] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? [];
      // 下面那行有读成低音谱号的、且不比读成高音的少，上面那行又都是高音谱号：照低音定（上面是高音谱号的大谱表，
      // 下面那行不会也是高音）。只有两个系统、一个读成高音一个读成低音的平手（每日新恩歌），
      // 或四个系统里两行没认出谱号、剩下一高一低（尊主为大歌）都落在这里。
      const fs = tally.get("fClef") ?? 0;
      const tieBass = i === len - 1 && i > 0 && fs >= 1 && fs >= (tally.get("gClef") ?? 0) && gs.every((g) => (ctx.get(g[0])?.clef?.code ?? "gClef") === "gClef");
      if (tieBass) (code = "fClef"), (n = gs.length);
      if (!code || n === undefined || n < 2 || n * 2 <= gs.length) continue;
      for (const g of gs) {
        const c = ctx.get(g[i]);
        if (!c || c.clef?.code === code) continue;
        if (c.clef) c.clef.code = code;
        else {
          const st = g[i];
          const box = { x: st.box.left + unit.space * 0.5, y: st.box.top, w: unit.space * 2.5, h: st.box.bottom - st.box.top };
          const sym = makeSymObj(pg.objs.length + pg.segs.length + 1, { box, code }, unit.height).sym;
          sym.addTag("Clef");
          c.clef = sym;
          c.clefs = [sym, ...(c.clefs ?? [])];
        }
      }
    }
  }
}

/**
 * **调号按竖笔补足个数**（`flatsByStrokes` / `sharpsByStrokesLoose`）：三四个升降号挤在一起、笔画又淡时，
 * 按块只认出一两个，各行认出的个数还不一样，整首被当成移调（新编赞美诗 11 荣归天父歌四个降号各行读成
 * -1/-2/0；35 大哉圣名歌一个升号一行都没认出）。
 * 竖笔数的毛病是**数少**（淡笔断开就少一根），所以**只增不减**：取「至少两行数到这么多」的最大个数 k，
 * 数到 k 以上、而按块认出的同种记号不足 k 的行补到 k；别的行由 `shareKeySignature` 接着补。
 * 升降两种都数出来时取作证行数多的那种；已认出另一种记号的行不动。
 */
function extendKeyByStrokes(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary, unit: { space: number; height: number; lineThick?: number }): void {
  const rows: { c: StaffContext; flats: Rect[]; sharps: Rect[] }[] = [];
  for (const c of ctx.values()) {
    if (!c.clef || c.staff.lineYs.length !== 5) continue;
    const cb = c.clef.box;
    const clef = { x: cb.left, y: cb.top, w: cb.right - cb.left, h: cb.bottom - cb.top };
    const bass = c.clef.code === "fClef";
    let flats = flatsByStrokes(bin, c.staff.lineYs, clef, bass, unit.space, unit.lineThick ?? 0);
    // 粗线低分辨率页：高音谱号的行另按探出谱表的竖笔数一遍，取多的（见 `flatsByStairs`）
    if (!bass && isCoarseKey(unit.space, unit.lineThick ?? 0)) {
      const st = flatsByStairs(bin, c.staff.lineYs, clef, unit.space, unit.lineThick ?? 0);
      if (st.length > flats.length) flats = st;
    }
    rows.push({
      c,
      flats,
      sharps: sharpsByStrokesLoose(bin, c.staff.lineYs, clef, bass, unit.space),
    });
  }
  const pick = (of: (r: (typeof rows)[number]) => Rect[]) => {
    for (let n = 7; n >= 1; n--) {
      const m = rows.filter((r) => of(r).length >= n).length;
      if (m >= 2) return { k: n, m };
    }
    return { k: 0, m: 0 };
  };
  let f = pick((r) => r.flats);
  const sh = pick((r) => r.sharps);
  // **只有一行数全的降号也认**：短歌只有两三个系统，各行淡得不一样，常常只有一行数得全（我要向山举目歌 4,1,0）。
  // 降号的对位够严（肚子要逐个落在 B E A D… 的位置上；漏一根的容许也要后面跟着两个真的），三个以上一行就算数；
  // 这种页行数少（六行以内），全页照它定。
  let lone = false;
  {
    const best = rows.reduce((a, r) => Math.max(a, r.flats.length), 0);
    // 已有两行数到三个以上的不让单行的盖过去，只比两行作证的多一个的也不算：多出来的那一个是头一行拍号数字的竖笔
    //（新年欢喜歌 4,3,3,3；夜晚觐主歌 3,2,2,2,2,2）
    if (best >= 3 && best >= f.k + 2 && f.k < 3 && rows.length <= 6 && !sh.k) (f = { k: best, m: 1 }), (lone = true);
  }
  if (!f.k && !sh.k) return;
  // 升降两种都数出来时，取各行数出的总数多的那种
  const total = (of: (r: (typeof rows)[number]) => Rect[]) => rows.reduce((a, r) => a + of(r).length, 0);
  const useSharp = sh.k > 0 && (!f.k || total((r) => r.sharps) > total((r) => r.flats));
  const { k, m } = useSharp ? sh : f;
  const code: SmuflName = useSharp ? "accidentalSharp" : "accidentalFlat";
  const strokesOf = (r: (typeof rows)[number]) => (useSharp ? r.sharps : r.flats);
  // 只看**行首**那段调号：行中转调的记号（`keyChanges`）不算「混着别种」，改行首时也原样留着
  const headOf = headKey;
  const midOf = (c: StaffContext) => {
    const head = new Set(headOf(c));
    return c.key.filter((q) => !head.has(q));
  };
  const countOf = (c: StaffContext) => headOf(c).filter((q) => q.code === code).length;
  const setKey = (c: StaffContext, boxes: Rect[]) => {
    const mid = midOf(c);
    c.key = boxes.map((box, i) => {
      const sym = makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box, code }, unit.height).sym;
      sym.addTag("Key");
      return sym;
    });
    c.key.push(...mid);
  };
  // **同一系统里至少两行按块认出一模一样的另一种调号的，这个系统另有自己的调**，不拿全页数出来的盖：
  // 竖笔数的是全页，可一页上会转调（望十架 p7 上一个系统两个升号、下一个系统转一个降号，
  // 五行认得齐齐的两个升号被全页过半的一个降号整个盖掉）
  const own = new Set<StaffContext>();
  for (const g of systemGroups(pg)) {
    const cs = g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c);
    const count = new Map<string, number>();
    for (const c of cs) {
      const h = headOf(c);
      if (!h.length || h.some((q) => q.code !== h[0].code) || h[0].code === code || (h[0].code !== "accidentalFlat" && h[0].code !== "accidentalSharp")) continue;
      const sig = `${h[0].code}${h.length}`;
      count.set(sig, (count.get(sig) ?? 0) + 1);
    }
    if ([...count.values()].some((v) => v >= 2)) for (const c of cs) own.add(c);
  }
  // **按块多认的收回来**：比 k 多的行只是少数（不到三分之一）、而竖笔没有哪一行数过 k——多出来的是调号后面
  // 头一个音的临时记号（三博士歌一个升号，有一行按块读成三个，`shareKeySignature` 见别的行都是它的前缀就全页照它补）
  const maxStroke = Math.max(...rows.map((r) => strokesOf(r).length));
  const longer = rows.filter((r) => countOf(r.c) > k);
  if (maxStroke <= k && longer.length && longer.length * 3 <= rows.length) for (const r of longer) r.c.key = [...headOf(r.c).filter((q) => q.code === code).slice(0, k), ...midOf(r.c)];
  // **过半的行都数到 k**：全页照它定——混着别种记号的行（主恩更多歌头一行「♯♭」）、一个都没认出的行也补上
  const strong = (m >= 2 && m * 2 >= rows.length) || lone;
  for (const r of rows) {
    const c = r.c;
    if (own.has(c)) continue;
    const got = strokesOf(r);
    const mixed = headOf(c).some((q) => q.code !== code);
    if (!mixed && countOf(c) >= k) continue;
    // 混着别种记号的行：自己数到了 k（有福确据歌头一行按块读成一个降号、竖笔数出两个升号）或全页已定，才改
    if (mixed && !strong && got.length < k) continue;
    if (got.length >= k) setKey(c, got.slice(0, k));
    else if (strong) {
      // 自己没数全：从谱号右边起按固定间距摆 k 个（下游只按个数算变音、取最右那个的右缘）
      const cb = c.clef!.box;
      const x = got[0]?.x ?? cb.right + unit.space * 0.4;
      setKey(c, Array.from({ length: k }, (_, i) => ({ x: x + i * unit.space * 0.85, y: c.staff.box.top, w: unit.space * 0.8, h: unit.space * 2.5 })));
    }
  }
}

/**
 * 调号区（谱号后 9 格）的竖笔。升降号的竖笔细、常略斜、印得淡，逐列量最长竖墨会在换列处、淡处断成两截不够高：
 * 左右各抹宽一像素、容 0.25 格断口再量。代价是**两端不可靠**（会顺着谱线、肚子的弧接下去），
 * 所以对位一律不靠端点（降号看肚子、升号看整组中心）。
 * 试过在这一块里另按松阈值二值一遍（纸色往墨色走 35%）：谱线跟着变粗，竖笔与肚子、谱线粘成一片，
 * 数出来的反而更少（荣归天父歌各行 4 → 0~3），已撤；整页并回纵向长笔画也试过（前 60 首 25 升 25 降）。
 * 返回的坐标是整页的。
 */
function keyZoneStrokes(bin: Binary, lineYs: number[], clef: Rect, sp: number, minH: number, maxW = 0.5): { x0: number; strokes: ReturnType<typeof verticalStrokes>; ink: (x: number, y: number) => boolean } | null {
  const top = lineYs[0];
  const bottom = lineYs[lineYs.length - 1];
  const x0 = Math.round(clef.x + Math.min(clef.w, sp * KEY_FROM));
  const box: Rect = { x: x0, y: Math.max(0, Math.round(top - sp * 2)), w: Math.round(sp * 9), h: Math.round(bottom - top + sp * 3.5) };
  if (box.x + box.w > bin.w || box.y + box.h > bin.h) return null;
  const zone = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) zone[y * box.w + x] = bin.data[(box.y + y) * bin.w + box.x + x];
  const smear: Binary = { w: box.w, h: box.h, data: new Uint8Array(box.w * box.h) };
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (zone[i] || (x > 0 && zone[i - 1]) || (x + 1 < box.w && zone[i + 1])) smear.data[i] = 1;
    }
  const strokes = verticalStrokes(smear, { x: 0, y: 0, w: box.w, h: box.h }, minH, Math.max(2, Math.round(sp * 0.25)))
    .map((k) => ({ ...k, x0: k.x0 + box.x, x1: k.x1 + box.x, top: k.top + box.y, bottom: k.bottom + box.y }))
    .filter((k) => k.x1 - k.x0 + 1 <= sp * maxW);
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  return { x0, strokes, ink };
}

/**
 * **按竖笔数调号升号（宽松版）**：`sharpsByStrokes` 逐列量竖墨、还要中列上下各一道横杠，淡印的细升号过不了
 *（新编赞美诗 35/43/44 一个升号、46 两个、48 三个，一行都数不出）。这里竖笔按 `keyZoneStrokes` 量，
 * 挨着的两根（够 1.6 格高）并成一组算一个升号；抹宽后并成一根的，左右两侧都要有横杠探出来的厚墨。再看**位置**：
 * 升号中心的高低照调号的固定次序走（F C G D A E B），头一个落在 F 的位置上。不合的那一组起就停。
 * 只给 `extendKeyByStrokes` 用（至少两行作证、只增不减）。
 */
function sharpsByStrokesLoose(bin: Binary, lineYs: number[], clef: Rect, bass: boolean, sp: number): Rect[] {
  const z = keyZoneStrokes(bin, lineYs, clef, sp, sp * 1.6);
  if (!z) return [];
  const { x0, strokes, ink } = z;
  // 各升号中心相对头一个（F）的高低（格，向下为正）
  const STEP = [0, 1.5, -0.5, 1, 2.5, 0.5, 2];
  // F 的位置：高音谱表第五线（最上一条），低音谱表第四线
  const fY = lineYs[bass ? 1 : 0];
  /** x 这一列在 cy 上下 0.9 格内有没有厚 0.22 格以上的一道墨——升号的横杠（谱线只有 0.1 格厚） */
  const thickRun = (x: number, cy: number) => {
    let run = 0;
    for (let y = Math.round(cy - sp * 0.9); y <= Math.round(cy + sp * 0.9) + 1; y++) {
      if (y <= Math.round(cy + sp * 0.9) && ink(x, y)) run++;
      else {
        if (run >= sp * 0.22) return true;
        run = 0;
      }
    }
    return false;
  };
  // 挨着的竖笔并成一组：一个升号两根竖笔相距 0.2~0.4 格，抹宽之后常只隔一两像素、甚至并成一根粗的
  const groups: { x0: number; x1: number; top: number; bottom: number; n: number }[] = [];
  for (const k of strokes) {
    const g = groups[groups.length - 1];
    if (g && k.x0 - g.x1 <= sp * 0.5 && g.n < 2) (g.x1 = k.x1), (g.top = Math.min(g.top, k.top)), (g.bottom = Math.max(g.bottom, k.bottom)), g.n++;
    else groups.push({ x0: k.x0, x1: k.x1, top: k.top, bottom: k.bottom, n: 1 });
  }
  const out: Rect[] = [];
  let lastX = x0;
  for (const g of groups) {
    // 低音谱号的两个点上下叠着、隔着 F 线，抹宽容断之后是一根正落在 F 位置上的竖笔（C 大调的页每行数出一个升号）
    if (bass && g.x0 < x0 + sp * 0.9) continue;
    if (out.length >= 7 || g.bottom - g.top > sp * 3.6) break;
    if ((g.x0 - lastX) / sp > (out.length ? 1.6 : 3.2)) break;
    const cy = (g.top + g.bottom) / 2;
    const w = g.x1 - g.x0 + 1;
    // 只量出一根的（另一根淡得不够高，或两根并成一根粗的），**左侧**要有横杠探出来的那道厚墨：
    // 降号的肚子只在右侧、符干两侧都没有（只看右侧或任一侧，降号页上每行都数出两个「升号」）
    const fits =
      w <= sp * 1.0 &&
      // 头一个卡 0.5 格；后面的放到 1 格——伸出谱表的那半截（G、A 的上端）没有谱线托着、印得淡，
      // 量出来的中心往谱表里偏（道路真理生命歌第三个升号偏下 0.9 格）
      Math.abs((cy - fY) / sp - STEP[out.length]) <= (out.length ? 1 : 0.5) &&
      (g.n === 2 || thickRun(g.x0 - Math.round(sp * 0.15), cy));
    if (!fits) {
      // 头一个之前的杂笔（谱号的边角）跳过；串起来之后不合就停
      if (!out.length) continue;
      break;
    }
    const pad = Math.round(sp * 0.2);
    out.push({ x: g.x0 - pad, y: g.top, w: w + pad * 2, h: g.bottom - g.top + 1 });
    lastX = g.x1;
  }
  return out;
}

/** `flatsByStairs` 的起点：谱号左缘往右最多这么多格（谱号盒吞了调号时按它封顶；高音谱号自己的头在 1.7 格处）。 */
const STAIR_FROM = 3.4;

/**
 * **粗线低分辨率页的降号按「探出谱表的竖笔」数**（只管高音谱号的行）。线距十来个像素时，降号的竖笔与肚子、
 * 相邻两个降号都糊在一起，`flatsByStrokes` 逐根对肚子的位置对不上（烛光颂曲六个降号各行数出 0~4 个）。
 * 谱表**上方**是白的：第 2、4 个降号（E、D）的竖笔顶端探出最上一条线，后一根比前一根矮半格、相隔两个身位，
 * 是一道下行的台阶；别的记号没有这个形状（升号 F、G 探出的高度是先低后高，符干、谱号的头比这宽或高）。
 * 有这两级就至少四个降号，身位也定了；后面的 G、C、F 按身位逐个验竖笔：那一列有 1.5 格以上的竖墨、
 * 顶端落在该降号竖笔顶端的位置上（照 E 的顶端按调号次序推）。不合的那一个起就停。
 * 返回摆好的盒。
 */
function flatsByStairs(bin: Binary, lineYs: number[], clef: Rect, sp: number, thick: number): Rect[] {
  const x0 = Math.round(clef.x + Math.min(clef.w, sp * STAIR_FROM));
  const x1 = Math.min(bin.w - 1, Math.round(x0 + sp * 9));
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  // 最上一条线在这一段的实际位置：斜着的谱行行首与平线模型能差半格，取这一段里横向最满的那一行（几行一样满取最上）
  let top = Math.round(lineYs[0]);
  {
    let bestN = 0;
    for (let y = Math.round(lineYs[0] - sp * 0.7); y <= Math.round(lineYs[0] + sp * 0.7); y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (ink(x, y)) n++;
      if (n > bestN) (bestN = n), (top = y);
    }
    if (bestN < (x1 - x0) * 0.8) return [];
  }
  // 逐列量：紧贴线上缘起往上连续的墨（线上缘一两像素的毛边不算断）
  const base = top - 1;
  const hs: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let ya = base;
    while (ya > base - Math.max(1, Math.round(thick)) && !ink(x, ya)) ya--;
    let h = 0;
    while (ink(x, ya - h)) h++;
    hs.push(h ? base - ya + h : 0);
  }
  // 连着的几列并成一根：取最高处
  const peaks: { x: number; w: number; h: number }[] = [];
  for (let i = 0; i < hs.length; i++) {
    // 不到 0.3 格的是线上缘的毛边、肚子的顶，不算（算进来会把相邻两根并成一根宽的）
    if (hs[i] < sp * 0.3) continue;
    let j = i;
    let hi = i;
    while (j + 1 < hs.length && hs[j + 1] >= sp * 0.3) if (hs[++j] > hs[hi]) hi = j;
    peaks.push({ x: x0 + hi, w: j - i + 1, h: hs[hi] / sp });
    i = j;
  }
  // 台阶：E 探出 0.7~1.7 格，D 在它右边两个身位、矮四分之一格以上
  let e: (typeof peaks)[number] | undefined;
  let d: (typeof peaks)[number] | undefined;
  for (const [i, p] of peaks.entries()) {
    if (p.w > sp * 0.7 || p.h < 0.7 || p.h > 1.7 || (p.x - x0) / sp > 4.5) continue;
    const q = peaks.slice(i + 1).find((q) => q.h >= 0.3 && q.w <= sp * 0.7 && (q.x - p.x) / sp >= 1.5);
    if (q && (q.x - p.x) / sp <= 2.6 && q.h <= p.h - 0.25) (e = p), (d = q);
    if (e) break;
  }
  if (!e || !d) return [];
  const pitch = (d.x - e.x) / 2;
  // 各降号竖笔顶端相对 E 的那一根的高低（格）：照肚子的次序 B E A D G C F
  const STEP = [0, -1.5, 0.5, -1, 1, -0.5, 1.5];
  const topOf = (n: number) => top - e!.h * sp + (STEP[n] + 1.5) * sp;
  /** 第 n 个降号的位置上有没有它的竖笔 */
  const stemAt = (n: number) => {
    const cx = e!.x + (n - 1) * pitch;
    const want = topOf(n);
    for (let x = Math.round(cx - sp * 0.35); x <= Math.round(cx + sp * 0.35); x++) {
      let run = 0;
      for (let y = Math.round(want - sp * 0.5); y <= Math.round(want + sp * 3.4); y++) {
        if (ink(x, y)) run++;
        else {
          if (run >= sp * 1.5 && run <= sp * 3.2 && Math.abs(y - run - want) <= sp * 0.5) return true;
          run = 0;
        }
      }
    }
    return false;
  };
  let n = 4;
  while (n < 7 && stemAt(n)) n++;
  // **按最后一个降号的位置定个数**：调号那一串墨到哪一列断开（半格以上没有谱线以外的墨），
  // 横向按身位折成个数；再看纵向——末一个身位里墨的顶端要落在五度圈次序里第 n 个降号竖笔顶端的位置上。
  // 两样都合才采信（头一行后面紧跟拍号的，横向会多折出一两个，纵向对不上，仍用逐个验的那个数）。
  {
    const isLine = (y: number) => [0, 1, 2, 3, 4].some((i) => Math.abs(y - (top + thick / 2 + i * (lineYs[4] - lineYs[0]) / 4)) <= thick / 2 + 1);
    const colTop = (x: number) => {
      for (let y = Math.round(top - sp * 1.8); y <= Math.round(top + sp * 5.2); y++) if (!isLine(y) && ink(x, y)) return y;
      return -1;
    };
    let end = d.x;
    for (let x = d.x, blank = 0; x <= Math.min(bin.w - 1, Math.round(e.x + pitch * 7)); x++) {
      if (colTop(x) >= 0) (end = x), (blank = 0);
      else if (++blank >= sp * 0.5) break;
    }
    // 第 i 个降号（从 0 数）的竖笔在 e.x + (i - 1) 个身位，肚子右缘再往右约 0.8 个身位
    const m = Math.round((end - e.x) / pitch - 0.8) + 2;
    if (m > n && m <= 7) {
      let t = Infinity;
      for (let x = Math.round(e.x + (m - 2) * pitch - sp * 0.35); x <= end; x++) {
        const y = colTop(x);
        if (y >= 0 && y < t) t = y;
      }
      if (Math.abs(t - topOf(m - 1)) <= sp * 0.5) n = m;
    }
  }
  const bY = lineYs[2];
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(e!.x + (i - 1) * pitch) - 1,
    y: Math.round(bY + STEP[i] * sp - sp * FLAT_STEM),
    w: Math.round(sp * 0.8),
    h: Math.round(sp * (FLAT_STEM + 0.5)),
  }));
}

/** 粗线低分辨率的页（线宽过线距的两成、线距不到 `KEY_COARSE_SPACE`）：调号的降号另有一套量法。 */
function isCoarseKey(sp: number, thick: number): boolean {
  return thick / sp > KEY_THICK_LINE && sp < KEY_COARSE_SPACE;
}

/**
 * **按竖笔数调号降号**（与 `sharpsByStrokes` 同一路）。降号是一根 1.5~3 格的竖笔、肚子在右下：
 * 从谱号后起逐根取竖笔，要求
 *   - 肚子中心的高低照调号的固定次序走（B E A D G C F：升 1.5 格、降 2 格交替），头一个落在 B 的位置上；
 *   - 相邻两根隔 0.5~1.6 格（升号的两根竖笔隔不到 0.5 格、顶端齐平，过不了）；
 *   - 肚子那一格右侧的墨比左侧多（符头在朝上干的左下、朝下干的右上，拍号 4 的竖笔左边有墨）。
 * 不合的那一根起就停。返回各降号的盒。
 */
function flatsByStrokes(bin: Binary, lineYs: number[], clef: Rect, bass: boolean, sp: number, thick = 0): Rect[] {
  // **谱线粗的页竖笔要更高才算**：低分辨率的粗线扫描（线宽过线距的两成），降号的肚子连上下两条谱线就有
  // 「一格 + 两个线宽」高，过了 1.2 格那道闸，肚子那几列与竖笔并成一片宽笔、整串被宽度那道闸滤光
  //（烛光颂曲线距 10px、线宽 3px，六个降号一根都数不出）。闸抬到肚子连两条线之上。
  const r = thick / sp;
  // 只管低分辨率的页：线距够大的粗体铅字本（主使我喜乐，线距 14.5px）升号的两根竖笔抹宽后并成一根粗的，
  // 放宽了宽度闸就被数成降号（四个升号读成两个降号）
  const coarse = isCoarseKey(sp, thick);
  // 竖笔本身也粗（三像素的笔抹宽后五像素，连着肚子的弧有八九像素），宽度那道闸跟着放到一格
  const z = keyZoneStrokes(bin, lineYs, clef, sp, sp * (coarse ? 1 + 2 * r + 0.25 : 1.2), coarse ? 1.0 : 0.5);
  if (!z) return [];
  const { x0, strokes, ink } = z;
  // 各降号**肚子中心**相对头一个（B）的高低（格，向上为负）
  const STEP = [0, -1.5, 0.5, -1, 1, -0.5, 1.5];
  // B 的肚子中心：高音谱表第三线，低音谱表第二线（自上而下第四条）
  const bY = lineYs[bass ? 3 : 2];
  const isLine = (y: number) => lineYs.some((l) => Math.abs(y - l) <= Math.max(1, sp * 0.12));
  /** [x0, x1] × [y0, y1] 里的墨占比，不算谱线那几行 */
  const density = (xa: number, xb: number, ya: number, yb: number) => {
    let n = 0;
    let tot = 0;
    for (let y = Math.round(ya); y <= Math.round(yb); y++) {
      if (y < 0 || y >= bin.h || isLine(y)) continue;
      for (let x = Math.round(xa); x <= Math.round(xb); x++) {
        if (x < 0 || x >= bin.w) continue;
        tot++;
        if (ink(x, y)) n++;
      }
    }
    return tot ? n / tot : 0;
  };
  const out: Rect[] = [];
  let lastX = x0;
  // 中间漏一根（淡得连 1 格的竖墨都凑不出）只许一次：后一根落在再下一个位置上、横向也正好隔着两个身位，就当中间那个在
  //（是否劳倦歌四个降号，高音谱表缺头一个、低音谱表缺第二个）
  let skipped = false;
  let skipAt = -1;
  const boxAt = (x: number, cy: number): Rect => ({ x: Math.round(x) - 1, y: Math.round(cy - sp * FLAT_STEM), w: Math.round(sp * 0.8), h: Math.round(sp * (FLAT_STEM + 0.5)) });
  for (const [i, k] of strokes.entries()) {
    // 粗线页竖笔两端顺着粗谱线各多接一截（量得 3.3~3.6 格），高度上限跟着放
    if (out.length >= 7 || k.h > sp * (coarse ? 4.2 : 3.2)) break;
    // 紧跟着一根差不多高的竖笔：那是升号的两根竖笔（赞美三一歌两个升号的头一根落在 B 的位置上，被数成一个降号）
    const nx = strokes[i + 1];
    // 粗线页的竖笔宽（一根占大半格），相邻两个降号的笔缘只隔两三像素：间距改按**笔心**量（升号的两根笔心隔不到半格，降号隔一格）
    const mid = (q: { x0: number; x1: number }) => (q.x0 + q.x1) / 2;
    if (nx && (coarse ? (mid(nx) - mid(k)) / sp < 0.6 : (nx.x0 - k.x1) / sp < 0.5) && nx.h >= sp * 1.8 && k.h >= sp * 1.8) break;
    const gap = coarse ? (mid(k) - lastX) / sp - (out.length ? 0.5 : 0) : (k.x0 - lastX) / sp;
    if (gap > (out.length ? 2.6 : 4.2)) break;
    // 紧挨着上一根的短笔是它肚子的右缘，跳过
    if (out.length && gap < 0.5) continue;
    // 按**肚子**对位：沿竖笔自上而下找「右侧一格见方的墨比左侧多得最多」的那一行，就是肚子中心。
    // 竖笔两端都不可靠——容了断口之后，顶端会接到上面那条谱线、底端顺着肚子的弧与谱线接下去
    //（主爱辉煌歌低音谱表头一个降号顶端被抬高半格，四个只数出两个）。
    let cy = 0;
    let bowl = 0;
    for (let y = k.top + Math.round(sp * 0.5); y <= k.bottom + Math.round(sp * 0.3); y++) {
      const d = density(k.x1 + 1, k.x1 + sp * 0.6, y - sp * 0.45, y + sp * 0.45) - density(k.x0 - sp * 0.6, k.x0 - 1, y - sp * 0.45, y + sp * 0.45);
      if (d > bowl) (bowl = d), (cy = y);
    }
    // 粗线页一格只有十来个像素、谱线那几行又不算，肚子中心量出来差半格是常事：容差放到 0.7 格（次序里相邻两个差 1.5 格以上，仍分得开）
    const at = (n: number) => n < 7 && bowl >= 0.15 && Math.abs((cy - bY) / sp - STEP[n]) <= (coarse ? 0.7 : 0.45);
    const n = out.length;
    if (at(n) && gap <= (n ? 1.6 : 3.2)) out.push(boxAt(k.x0, cy));
    else if (!skipped && at(n + 1) && gap >= 1.2) {
      skipped = true;
      skipAt = n;
      out.push(boxAt(k.x0 - sp * 0.85, bY + STEP[n] * sp), boxAt(k.x0, cy));
    } else if (!n) continue; // 头一个之前的杂笔（谱号的边角）跳过
    else break; // 串起来之后不合就停
    lastX = coarse ? mid(k) : k.x1;
  }
  // 漏的那一个后面要有**两个**真的接着（漏在最前头的，后面至少还有两个）：只跟着一个的多半是拍号的竖笔
  //（万古磐石歌两个降号，头一行跳过「A」接上拍号 4 的竖笔，数成四个）
  if (skipAt >= 0 && out.length - skipAt - 1 < 2) out.length = skipAt;
  return out;
}

/** 跨谱表书写的音另记的声部号（比按符干、按拍分出来的都大）。 */
const CROSS_VOICE = 5;
/** 符干至少这么多格长、且远端过了两行谱之间的中线，才算伸进了相邻那一行。 */
const CROSS_STEM = 5;

/**
 * **跨谱表书写的音不算这一行的声部**。钢琴左手的琶音常升进右手谱表：符头画在上面那行，符干一路伸到下面那行、
 * 与那边的音共用一条符杠。照符头所在的行归属，这些音就混进右手的旋律里——一小节多出四五个音，凑不满拍、
 * 声部也拆不开，逐声部对拍时右手那行整段错位（是爱 p4、p5 各有一个系统多出十来个音）。
 * 同系统上下相邻的两行之间，符干远端过了两行之间的中线、干长五格以上，且那条符杠上另有相邻那一行自己的音的，是相邻那一行借地方写的：
 * 标 `crossStaff`，声部号另记，不参加这一行的凑拍（`checkBars`）。音高仍按符头所在那行的谱号读。
 */
function markCrossStaff(pg: SPage, notes: StaffNote[], stems: StemInfo[], sp: number): void {
  const bySym = new Map<Sym, StaffNote>();
  for (const n of notes) bySym.set(n.sym, n);
  for (const g of systemGroups(pg)) {
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i];
      const b = g[i + 1];
      const mid = (a.box.bottom + b.box.top) / 2;
      for (const st of stems) {
        const len = st.seg.box.bottom - st.seg.box.top;
        if (len < sp * CROSS_STEM) continue;
        for (const s of st.notes) {
          const n = bySym.get(s);
          if (!n || n.rest) continue;
          // 上面那行的头、干朝下伸过中线；下面那行的头、干朝上伸过中线
          const cross = (n.staff === a && !st.up && st.seg.box.bottom > mid) || (n.staff === b && st.up && st.seg.box.top < mid);
          if (!cross) continue;
          // 还要那条符杠上另有相邻那一行自己的音：光凭干长，谱表之间挨得近时下加线上的长干音也过中线
          // 那个音得是实心头——空心头不上符杠，是它的干顶到了这条杠上（爱是从神而来 p4：上行下声部的杠落在两行之间，
          // 下行二分和弦的干正好顶着它，上行那两组八分被当成借地方写的，这一行 92.7 → 91.9%）
          const other = n.staff === a ? b : a;
          const shared = stems.some((o) => o !== st && o.beams.some((q) => st.beams.includes(q)) && o.notes.some((t) => t.code === "noteheadBlack" && bySym.get(t)?.staff === other && !bySym.get(t)?.crossStaff));
          if (!shared) continue;
          n.crossStaff = true;
          n.voice = CROSS_VOICE;
        }
      }
    }
  }
}

/**
 * **同音两声部**：一个符头右边一根朝上的干、左边一根朝下的干——闭合谱里
 * 女高女低（男高男低）唱同一个音时就这么记，一个头算两个音。
 * 认成一个音的话，多声部 GT 每个同音处都少一个（《赞美一神》十处）。
 * 克隆出来的那个挂朝下的干，不带歌词与和弦（那两样挂接在后面，挂给原来那个）。
 *
 * **只挂上一根干的也要验另一侧**：「头 + 干 + 尾」块那一路一个头只取一根干，另一根没进竖段表
 *（万古磐石歌低音谱表 m6/m8 两个 F3 八分，干一上一下各带尾）。朝上干的头左缘往下、朝下干的头右缘往上
 * 有 `UNISON_REACH` 格以上的竖墨，而反方向没有墨（贴着头的小节线上下都有），就是另一个声部的干。
 */
function splitUnisons(notes: StaffNote[], stems: StemInfo[], beams: BeamShape[], bin: Binary, sp: number): void {
  // 朝上的干在头的**右缘**、朝下的在**左缘**。和弦共用一根干时，干常被中间的头
  // 切成两段，下面那段对上面那个头来说也「朝下」，但它还在右缘，不算。
  const up = new Set<Sym>();
  const down = new Set<Sym>();
  for (const st of stems) {
    const cx = (st.seg.box.left + st.seg.box.right) / 2;
    for (const s of st.notes) {
      const w = s.box.right - s.box.left;
      if (st.up && cx > s.box.left + w * 0.6) up.add(s);
      if (!st.up && cx < s.box.left + w * 0.4) down.add(s);
    }
  }
  /** 从 y0 起往 dir 方向，x 在 [x0, x1] 内最长的一段竖墨（像素行数；断口 ≤2 行，逐行可左右挪一列）。
   *  干是直的：整段左右漂出 0.15 格以上的不算（贴着头的歌词字一撇，有一位神 m7「有」）。 */
  const reach = (x0: number, x1: number, y0: number, dir: number) => {
    const drift = Math.max(2, sp * 0.15);
    const ink = (x: number, y: number) => x >= 0 && x < bin.w && y >= 0 && y < bin.h && bin.data[y * bin.w + x] === 1;
    let most = 0;
    for (let xs = Math.round(x0); xs <= Math.round(x1); xs++) {
      let last = 0;
      for (let x = xs, y = Math.round(y0), k = 0, miss = 0; miss <= 2 && y >= 0 && y < bin.h; y += dir, k++) {
        if (ink(x, y)) miss = 0;
        else if (x > x0 && ink(x - 1, y)) (x--, (miss = 0));
        else if (x < x1 && ink(x + 1, y)) (x++, (miss = 0));
        else {
          miss++;
          continue;
        }
        if (Math.abs(x - xs) > drift) break;
        last = k + 1;
      }
      most = Math.max(most, last);
    }
    return most;
  };
  /** [y0, y1] 行里、从 [x0, x1] 那几列横向连出去的墨有一个头宽（0.6~1.8 格）的行数：沿途挂着没认出来的头。
   *  谱线、加线、符杠比头宽得多，不算。 */
  const headRows = (x0: number, x1: number, y0: number, y1: number, lo = 0.6, hi = 1.8) => {
    let rows = 0;
    for (let y = Math.round(Math.min(y0, y1)); y <= Math.max(y0, y1); y++) {
      if (y < 0 || y >= bin.h) continue;
      // 落在已认符杠上的行不算：干穿过下层的短杠（倚靠主永远膀臂 m13 低音，十六分的第二道杠一格宽）
      if (beams.some((q) => q.box.left <= x1 && q.box.right >= x0 && y >= q.box.top - 1 && y <= q.box.bottom + 1)) continue;
      let widest = 0;
      for (let x = Math.round(x0); x <= Math.round(x1); x++) {
        if (x < 0 || x >= bin.w || !bin.data[y * bin.w + x]) continue;
        let l = x;
        let r = x;
        while (l > 0 && bin.data[y * bin.w + l - 1]) l--;
        while (r < bin.w - 1 && bin.data[y * bin.w + r + 1]) r++;
        widest = Math.max(widest, r - l + 1);
      }
      if (widest >= sp * lo && widest <= sp * hi) rows++;
    }
    return rows;
  };
  const heads = notes.filter((n) => !n.rest).map((n) => n.sym);
  /** 头另一侧那段竖墨上不能再有别的头（那是和弦里另一个头的干）。 */
  const clear = (s: Sym, x0: number, x1: number, y0: number, y1: number) =>
    !heads.some((o) => o !== s && o.box.right > x0 && o.box.left < x1 && o.box.bottom > Math.min(y0, y1) && o.box.top < Math.max(y0, y1));
  for (const n of notes) {
    if (n.rest || n.grace || up.has(n.sym) === down.has(n.sym)) continue;
    const b = n.sym.box;
    const w = b.right - b.left;
    // 窗口往头外放 0.25 格：另一根干常离头缘两三像素（倚靠主永远膀臂 m13 低音 A♭3，朝上的干在右缘外 2~4px）。
    // 「反方向没有墨」那道照旧只看头缘内：放宽了会碰上旁边的墨（万古磐石歌 m6 F3）
    const out = Math.max(1, sp * 0.25);
    // 另一根干短（歌词挤着，只伸出头外 1 格多）的，窗口收回头缘内、反方向的窗口放到头外：
    // 贴着头缘的小节线上下都有墨（我一生要赞美你 m4、有一位神 m1）；沿途也不能有比干宽的墨，
    // 那是紧贴着头的歌词字（晨曦破晓 m14「光」压在低音头上）
    if (up.has(n.sym)) {
      const x1 = b.left + w * 0.3;
      const len = reach(b.left - out, x1, b.bottom, 1) >= sp * UNISON_REACH && reach(b.left - 1, x1, b.top, -1) < sp * 0.5 ? sp * UNISON_REACH
        : reach(b.left - 1, x1, b.bottom, 1) >= sp * UNISON_SHORT && reach(b.left - out, x1, b.top, -1) < sp * 0.5 && headRows(b.left - 1, x1, b.bottom + 2, b.bottom + sp * UNISON_SHORT, 0.4, 3) < sp * 0.2 ? sp * UNISON_SHORT : 0;
      if (len && clear(n.sym, b.left - out, x1, b.bottom + 1, b.bottom + len) && headRows(b.left - out, x1, b.bottom + 2, b.bottom + len) < sp * 0.3) down.add(n.sym);
    } else {
      const x0 = b.right - w * 0.3;
      const len = reach(x0, b.right + out, b.top, -1) >= sp * UNISON_REACH && reach(x0, b.right + 1, b.bottom, 1) < sp * 0.5 ? sp * UNISON_REACH
        : reach(x0, b.right + 1, b.top, -1) >= sp * UNISON_SHORT && reach(x0, b.right + out, b.bottom, 1) < sp * 0.5 && headRows(x0, b.right + 1, b.top - sp * UNISON_SHORT, b.top - 2, 0.4, 3) < sp * 0.2 ? sp * UNISON_SHORT : 0;
      if (len && clear(n.sym, x0, b.right + out, b.top - len, b.top - 1) && headRows(x0, b.right + out, b.top - len, b.top - 2) < sp * 0.3) up.add(n.sym);
    }
  }
  /** 朝下那根「干」其实是头下方歌词字的一笔：头下 1.2 格内先是一段细墨、接着连续几行 0.9~2.4 格宽的横墨（字的横笔）。
   *  真干沿途只有细干本身与比 3 格宽得多的谱线（有一位神 m6/m7/m10 的 A3 贴着「有」字）。
   *  要先见细墨：头盒只罩住上半截时，往下先扫到的是头自己（以马内利来临歌 m15 D4）。落在已认符杠上的行不算。 */
  const intoText = (s: Sym) => {
    const b = s.box;
    let rows = 0;
    let run = 0;
    let thin = 0;
    for (let y = Math.round(b.bottom + 1); y <= b.bottom + sp * 1.2 && y < bin.h; y++) {
      let widest = 0;
      for (let x = Math.round(b.left - 1); x <= b.left + (b.right - b.left) * 0.3; x++) {
        if (x < 0 || x >= bin.w || !bin.data[y * bin.w + x]) continue;
        let l = x;
        let r = x;
        while (l > 0 && bin.data[y * bin.w + l - 1]) l--;
        while (r < bin.w - 1 && bin.data[y * bin.w + r + 1]) r++;
        widest = Math.max(widest, r - l + 1);
      }
      if (widest > 0 && widest <= sp * 0.3) thin++;
      // 短干接着的符杠斜着走，逐行切也是一两格宽（耶和华是我的牧者第二页 m7 D3）
      const onBeam = beams.some((q) => q.box.left <= b.right && q.box.right >= b.left && y >= q.box.top - 1 && y <= q.box.bottom + 1);
      run = !onBeam && thin >= 2 && widest >= sp * 0.9 && widest <= sp * 2.4 ? run + 1 : 0;
      rows = Math.max(rows, run);
    }
    return rows >= 3;
  };
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.rest || !up.has(n.sym) || !down.has(n.sym) || intoText(n.sym)) continue;
    n.stemUp = true;
    notes.splice(i + 1, 0, { ...n, stemUp: false, chordExtra: true, lyrics: undefined, chord: undefined });
  }
}

function overlapFrac(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1, a.w * a.h) : 0;
}

/** 排查用：把一页的二值图取出来（识别坐标 = 像素坐标）。 */
export type { Binary };

/**
 * 半/全休止的位置闸：块的纵向中心要贴着某行谱的**第二线或第三线**（自上而下数）。
 *
 * 全休止吊在第二线下方、半休止坐在第三线上方，两者的墨迹都紧贴那条线，
 * 中心离线不超过半格。`buildNotes` 随后再按「在线上还是线下」分全与半
 * （那两个字形逐位相同，只能按几何判）。
 */
/** 四分休止的尺寸与填充率（从字典认出来的那批量出来的）。见 `bootstrapQuarterRest` 那一段。 */
const QREST_W = [0.75, 1.1] as const;
const QREST_H = [2.2, 3.1] as const;
const QREST_FILL = [0.33, 0.62] as const;
/** 中段被抽成竖段的四分休止：宽度上限（格）。扫描件笔画粗，比 `QREST_W` 宽一点。 */
const QREST_SPINE_W = 1.25;
/** 行中换谱号：离谱行左缘多少格以外才找（行首谱号 + 调号 + 拍号在这之内）。 */
const MID_CLEF_FROM = 5;
/** 行首谱号被切碎的行：取墨窗口从谱行左缘往右几格起（让过系统线）。 */
const CLEF_WIN_FROM = 0.5;
/** 行末预告调号：离谱行右端几格以内（七个记号约占七格）。 */
const COURTESY_KEY = 8;
/** 贯穿小节线断成的两截：各自两端离所在谱行的外线不过几格（见 `joinThroughBars`）。 */
const THROUGH_END = 0.6;
/** 行首谱号按墨定种类：顶线上方那一段（离顶线几格到几格）、第四五线之间那一段（各让开线几格）。 */
const CLEF_INK_ABOVE = [1.0, 0.35];
/** 取墨的横向窗口：离谱行左端几格到几格（谱号约占 0.5~3.2 格，调号从 3.5 格上下起）。 */
const CLEF_INK_X = [0.6, 3.0];
const CLEF_INK_LOW = [0.3, 0.25];
/** 这两段里有墨的行占到几成算「有」、不到几成算「没有」。 */
const CLEF_INK_FULL = 0.6;
/** 低八度谱号的「8」：横向窗口（离谱行左端几格）、谱号尾巴那一段与「8」下半那一段（离底线几格）。 */
const CLEF_8_X = [1.3, 2.6];
/** 谱号从底线往下连着探出多少格算挂着「8」：普通高音谱号的尾巴 1.6~1.9 格，挂着「8」的 2.5~3.1 格（烛光颂曲实测）。 */
const CLEF_8_DEPTH = [2.35, 3.4];
const CLEF_INK_NONE = 0.15;
/** 判低音谱号时第四五线之间那一段「没有」的门槛（比 `CLEF_INK_NONE` 松，见用处）。 */
const CLEF_INK_LOW_NONE = 0.4;
/** 行中换谱号：与本页行首谱号的宽高比差上限、签名距离上限。 */
/** 行中的高音谱号顶端至少探出首线这么多格（小一号的只探出 0.4 格上下：望十架 p10 量得 0.43）。 */
const MID_CLEF_G_TOP = 0.3;
/** 琶音记号（竖波浪线）：块宽上限、高下限（格），逐行墨宽上限（格），挂和弦时线右往外找几格。 */
const ARP_W = 0.6;
const ARP_H = 2.5;
const ARP_STROKE = 0.7;
const ARP_REACH = 2.5;
/** 逐行墨中心的摆幅下限（格）、每格过零次数的范围。 */
const ARP_SWING = 0.1;
const ARP_RATE = [1.5, 3.2];
const MID_CLEF_ASPECT = 0.15;
const MID_CLEF_DIST = 130;
const MID_CLEF_FILL = 0.08;

/** 行首「谱号 + 调号」那一段占几格（线距的倍数）。谱号约 2 格宽，
 *  七个降号排开也就再占 4 格，留一点余量。 */
const STAFF_START = 6;
/** 行首「谱号 + 调号」右沿往右这么多格里不收四分休止（没认出的调号、拍号在那里）。 */
const KEY_TAIL = 2;

/** 盒落在某行谱的**行首那一段**里吗（谱号 + 调号的地盘）。见 `bootstrapQuarterRest` 那一段。 */
function nearStaffStart(
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
/** 两截拼起来判的那两路（被谱线上下切开、球与斜笔左右断开）的高度下限：新编赞美诗那套小号字体的八分休止只有 1.55 格
 *（033、038 系统末那一排）。全局放到 1.4 时合唱谱是爱2 多出二十来个假八分休止（73.7 → 70.6）、独唱谱 −0.03，只给这两路 */
const EIGHTH_REST_H_PIECES = 1.4;
const EIGHTH_REST_FILL = [0.3, 0.5] as const;
/** 被谱线切成两截、按不去线的墨接回来的八分休止：墨占比下限（望十架 p5 细笔扫描件 0.28）。 */
const EIGHTH_REST_FILL_PIECES = 0.25;
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
function symbolInk(nl: Binary, bin: Binary, box: Rect, reach: number): number {
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

function isEighthRest(bin: Binary, b: Rect, area: number, unit: RasterUnit, minH: number = EIGHTH_REST_H[0], minFill: number = EIGHTH_REST_FILL[0]): boolean {
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
function fillAround(bin: Binary, b: Rect, unit: RasterUnit): { box: Rect; area: number } | null {
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
function enclosedWhite(bin: Binary, b: { left: number; right: number; top: number; bottom: number }, sp: number, pad = Math.round(sp * 0.5)): number {
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
function crossRuns(bin: Binary, x0: number, x1: number, y0: number, y1: number): [number, number][] {
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
function wholesByShape(bin: Binary, nl: Binary, box0: Rect, unit: RasterUnit, grid: (y: number) => number | null, stems: LineSeg[] = []): Rect[] {
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
function sharpCrossbars(bin: Binary, b: Rect, unit: RasterUnit): boolean {
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

function vRunAt(bin: Binary, x: number, y: number): [number, number] | null {
  const ink = (xx: number, yy: number) => yy >= 0 && yy < bin.h && xx >= 0 && xx < bin.w && !!bin.data[yy * bin.w + xx];
  const at = (yy: number) => ink(x, yy) || ink(x - 1, yy) || ink(x + 1, yy);
  if (!at(y)) return null;
  let a = y;
  let b = y;
  while (at(a - 1)) a--;
  while (at(b + 1)) b++;
  return [a, b];
}

/**
 * **两个声部贴着的头各用一根干**：上声部的头在右缘出朝上的干，下声部的头在左缘出朝下的干，
 * 两头相距三度时上下贴着，下声部那根干的墨一直连到上面那个头的中心——`buildNotes` 于是把上面那个头
 * 同时挂到两根干上，出两遍（《向主唱新歌》D4/B3、A4/F4 一共五处）。
 * 这里把这种干的端点缩回到本声部的头：朝下的干顶端停在「右缘另有朝上干」的头上、
 * 同一根干上往下 0.6~1.6 格还有头、干从那个头再往下伸 1.5 格以上，就把顶端挪到下面那个头的中心；朝上的对称。
 * 「再伸 1.5 格」挡的是两个头左缘连成的竖墨（齐来称颂一根朝上的干挂两个头，左缘被当成下干，歌词 96 → 54）。
 */
function splitVoiceStems(segs: LineSeg[], heads: Rect[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  const tol = sp * 0.3;
  const xOf = (v: LineSeg) => (v.x0 + v.x1) / 2;
  const top = (v: LineSeg) => Math.min(v.y0, v.y1);
  const bot = (v: LineSeg) => Math.max(v.y0, v.y1);
  const cy = (h: Rect) => h.y + h.h / 2;
  const vertical = segs.filter((v) => bot(v) - top(v) > sp);
  return segs.map((v) => {
    if (bot(v) - top(v) <= sp) return v;
    const vx = xOf(v);
    // 朝下的干：挂在头的左缘，顶端落在头里
    const hTop = heads.find((h) => Math.abs(h.x - vx) <= tol && top(v) >= h.y - tol && top(v) <= h.y + h.h);
    if (hTop) {
      const below = heads.filter((h) => h !== hTop && Math.abs(h.x - hTop.x) <= sp * 0.4 && cy(h) - cy(hTop) >= sp * 0.6 && cy(h) - cy(hTop) <= sp * 1.6 && cy(h) <= bot(v));
      const up = vertical.some((u) => u !== v && Math.abs(xOf(u) - (hTop.x + hTop.w)) <= tol && bot(u) >= hTop.y - tol && bot(u) <= hTop.y + hTop.h + tol && top(u) < hTop.y - sp);
      if (below.length && up && bot(v) - Math.max(...below.map(cy)) >= sp * 1.5) {
        const ny = Math.min(...below.map(cy));
        return { ...v, y0: v.y0 < v.y1 ? ny : v.y0, y1: v.y0 < v.y1 ? v.y1 : ny };
      }
    }
    // 朝上的干：挂在头的右缘，底端落在头里
    const hBot = heads.find((h) => Math.abs(h.x + h.w - vx) <= tol && bot(v) >= h.y && bot(v) <= h.y + h.h + tol);
    if (hBot) {
      const above = heads.filter((h) => h !== hBot && Math.abs(h.x + h.w - (hBot.x + hBot.w)) <= sp * 0.4 && cy(hBot) - cy(h) >= sp * 0.6 && cy(hBot) - cy(h) <= sp * 1.6 && cy(h) >= top(v));
      const down = vertical.some((u) => u !== v && Math.abs(xOf(u) - hBot.x) <= tol && top(u) >= hBot.y - tol && top(u) <= hBot.y + hBot.h + tol && bot(u) > hBot.y + hBot.h + sp);
      if (above.length && down && Math.min(...above.map(cy)) - top(v) >= sp * 1.5) {
        const ny = Math.max(...above.map(cy));
        return { ...v, y0: v.y0 > v.y1 ? ny : v.y0, y1: v.y0 > v.y1 ? v.y1 : ny };
      }
    }
    return v;
  });
}

/**
 * **头盒缘收到它的干上**：按内腔外扩一圈得来的空心头盒比墨宽，干常落在盒里离边缘三四个像素，
 * `findStems` 挂得上（两倍线宽），`buildStems` 认头却只容四分之一格，于是干有了、头没归上，
 * 下游把「没干的空心头」当全音符（《主我敬拜你》附点二分读成附点全音符）。只动 x，不动 y（音高不变）。
 *
 * **实心头同样要收**：拆块、按模板合成出来的实心头盒是定宽的，叠置和弦的干落在盒里离右缘 4~5 像素，
 * 出了 `findStems` 的两倍线宽窗口，干一根没挂上，连杠的八分全读成四分（父恩广大首小节网点符杠下的两组三度）。
 * 独唱谱音符 93.04 → 93.16%、时值 90.14 → 90.42%；合唱谱干净档音符 +0.06、扫描档 +0.36。
 * 原地改 `syms` 里的盒，原样返回竖段。
 */
function snapHeadsToStems(syms: RasterSym[], segs: LineSeg[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  for (const s0 of syms) {
    if (s0.code !== "noteheadHalf" && s0.code !== "noteheadBlack") continue;
    const b = s0.box;
    for (const v of segs) {
      const vx = (v.x0 + v.x1) / 2;
      const top = Math.min(v.y0, v.y1);
      const bot = Math.max(v.y0, v.y1);
      if (bot - top < sp * 2 || bot < b.y || top > b.y + b.h) continue;
      const cy = b.y + b.h / 2;
      // 头在干的一端（与 findStems 同口径），**另一端不能已有别的符头**：符杠与谱线之间的空隙也会被当成
      // 内腔认出个「空心头」，它挂的那根干下端本有自己的黑头（坚固保障小节数 19 → 18）
      if (Math.abs(cy - top) > sp && Math.abs(cy - bot) > sp) continue;
      const farY = Math.abs(cy - top) < Math.abs(cy - bot) ? bot : top;
      if (syms.some((o) => o !== s0 && /^notehead/.test(o.code) && Math.abs(o.box.y + o.box.h / 2 - farY) <= sp && o.box.x - sp * 0.5 <= vx && vx <= o.box.x + o.box.w + sp * 0.5)) continue;
      if (vx > b.x + b.w - sp * 0.35 && vx < b.x + b.w) {
        s0.box = { ...b, w: Math.round(vx) - b.x };
        break;
      }
      if (vx > b.x && vx < b.x + sp * 0.35) {
        const nx = Math.round(vx);
        s0.box = { ...b, x: nx, w: b.x + b.w - nx };
        break;
      }
    }
  }
  return segs;
}

/** 让位到谱表外的休止：中心在第五线上方或第一线下方 `QREST_OFF` 格以内。 */
const QREST_OFF = 2.2;
function offStaffRest(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] && ys[i] - cy <= unit.space * QREST_OFF) return true;
    if (cy > ys[i + 4] && cy - ys[i + 4] <= unit.space * QREST_OFF) return true;
  }
  return false;
}

function midOfStaff(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) if (Math.abs(cy - ys[i + 2]) <= unit.space * 0.9) return true;
  return false;
}

/**
 * 符头右边的附点（见识别主流程「附点」那一段）。窗口：符头右缘往右 0.05~1.3 格、
 * 符头中心往上 0.85 格到往下 0.5 格（`DOT_BELOW`）。墨团要整个落在窗口里（孤立），
 * 大小 0.15~0.6 格、宽高比 0.6~1.7、填充过半；已经有符号压着的不算；
 * 同一列上下一格处还有一个这样的点，那是反复记号的两点，不算。
 */
/** 附点窗口往下探多少格：线上的音附点写在上方的间，可和弦里上方那个间被别的音的点占了时写在下方（《恩友歌》G4）。
 *  0.35 → 0.5：线上的音点写在下方的间，点心在头心下 0.4 格（齐来崇拜 m13 A3、敬拜万世之王 m18 D5）。 */
const DOT_BELOW = 0.5;
/** 附点心离间心的容差（格）：本语料附点 95% 以上在 0.15 格内，落在线上的是头旁谱线残渣。 */
const DOT_SPACE_TOL = 0.3;
/** 头位置取整到半格时的容差（格），见 `findDots`。 */
const DOT_HEAD_TOL = 0.3;
/** 头心下超过这么多格的点要整个落在间里（见 `findDots`）。 */
const DOT_BELOW_SOLID = 0.35;
/** 判「同列另一个点有自己的主人」时，主人可以是左右半格内的邻列头：二度错排的和弦两列头挨着、盒不重叠
 *  （恩友歌 C5/A4/G4 附点四分，右列 A4 的点因左列两个头差一个像素不算「同列」，被当成反复双点剔掉）。 */
const TWIN_COL = 0.5;
/** 和弦里上方紧挨着另一个头的，附点窗口下沿放到这么多格（恩友歌 C5/A4/G4 附点四分，G4 的点写在下方的间，头心下 0.55 格）。 */
const DOT_BELOW_STACKED = 0.75;
/** 和弦里挤着二度、最下面那个头的点往下挪一个间：头心下一格，再放一点余量。 */
const DOT_BELOW_PUSHED = 1.2;
/** 附点四周这么多格（至少 2 像素）以内的墨若连着符干，就是符尾被切断的尖（见 `findDots` 里的 `isolated`）。 */
const DOT_ISOLATE = 0.12;
/** 本页附点的中位尺寸（长边）：比它的这么多倍还小的不是附点（父恩广大 m2 头圈边上的毛刺 3px、本页附点 6~7px；
 *  我灵镇静 m25 连音线尖 5×3、本页 9×9）。本页凑不够 `DOT_MEDIAN_N` 个点就不比。 */
const DOT_SMALL = 0.62;
const DOT_MEDIAN_N = 4;
/** 附点取块时窗口上下多放的余量（格），见 `findDots`。 */
const DOT_PAD = 0.3;
/** 附点的长宽上限（格）。0.6 → 0.75：倚靠主永远膀臂的附点 10×11、线距 17.6（0.62 格），我灵镇静的圈状点 8×11（0.63 格）。 */
const DOT_MAX = 0.75;
/** 反复记号两点的判定（`findDots::repeatPair`）：点心离第二/三间间心、两点横向差、点到反复小节线的距离、
 *  粗线最窄、粗细两线的间隔（格），与竖线贯穿谱表要占的墨比例（扫描件小节线有断口）。 */
const REPEAT_Y = 0.25;
/** 附点四周要干净的范围（格），见 `findDots`。 */
const DOT_CLEAR = 0.6;
const REPEAT_X = 0.3;
const REPEAT_GAP = 1.0;
const REPEAT_THICK = 0.3;
const REPEAT_PAIR = 1.0;
const REPEAT_INK = 0.9;

/** `onLine`：这一行像素在谱线上（去线后残渣所在）。连通照走，但不计入点的盒、也不算伸出窗口
 *  ——贴着谱线的附点在去线图上常连着一截残渣，盒高超限或伸出窗口就整个丢了（我灵镇静 m3 的附点四分）。
 *  `only`：只给这几个头找（后补的头），其余头照样用来定窗口。 */
function findDots(bin: Binary, syms: RasterSym[], unit: RasterUnit, staffYs: number[][], onLine: (y: number) => boolean = () => false, only?: RasterSym[]): Rect[] {
  const sp = unit.space;
  const out: Rect[] = [];
  const heads = syms.filter((s0) => /^notehead/.test(s0.code));
  const blobsIn = (x0: number, y0: number, x1: number, y1: number): Rect[] => {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(bin.w, Math.round(x1));
    y1 = Math.min(bin.h, Math.round(y1));
    const W = x1 - x0;
    if (W <= 0 || y1 <= y0) return [];
    const seen = new Uint8Array(W * (y1 - y0));
    const found: Rect[] = [];
    const stack: number[] = [];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (seen[(y - y0) * W + (x - x0)] || !bin.data[y * bin.w + x]) continue;
        // 两套盒：`a` 全部像素、`b` 不算谱线行的像素（见 `onLine`）。先按 `a` 判，不过再按 `b`
        const a = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, area: 0, edge: false };
        const b = { ...a };
        const grow = (q: typeof a, px: number, py: number) => {
          q.area++;
          q.minX = Math.min(q.minX, px);
          q.maxX = Math.max(q.maxX, px);
          q.minY = Math.min(q.minY, py);
          q.maxY = Math.max(q.maxY, py);
        };
        seen[(y - y0) * W + (x - x0)] = 1;
        stack.push(x, y);
        while (stack.length) {
          const py = stack.pop()!;
          const px = stack.pop()!;
          grow(a, px, py);
          if (!onLine(py)) grow(b, px, py);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx;
              const ny = py + dy;
              if (nx < 0 || ny < 0 || nx >= bin.w || ny >= bin.h || !bin.data[ny * bin.w + nx]) continue;
              if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) {
                a.edge = true;
                if (!onLine(ny)) b.edge = true;
                continue;
              }
              const j = (ny - y0) * W + (nx - x0);
              if (seen[j]) continue;
              seen[j] = 1;
              stack.push(nx, ny);
            }
        }
        // 去线那一套要够大（0.3 格）：符尾尖、干根贴着谱线的碎渣去掉线行只剩三四个像素，像个小点
        const dotOk = (q: typeof a, min: number) => {
          if (!q.area || q.edge) return false;
          const w = q.maxX - q.minX + 1;
          const h = q.maxY - q.minY + 1;
          if (w < Math.max(2, sp * min) || h < Math.max(2, sp * min) || w > sp * DOT_MAX || h > sp * DOT_MAX) return false;
          return w / h >= 0.6 && w / h <= 1.7 && q.area >= w * h * 0.5;
        };
        const q = dotOk(a, 0.15) ? a : dotOk(b, 0.3) ? b : null;
        if (!q) continue;
        const w = q.maxX - q.minX + 1;
        const h = q.maxY - q.minY + 1;
        found.push({ x: q.minX, y: q.minY, w, h });
      }
    return found;
  };
  /** 附点窗口的左缘：和弦里**贴着的最右那个头**的右缘。二度和弦错开画在干另一侧的头把附点列往右推了一个头宽，
   *  按自己的右缘开窗够不着（《恩友歌》C5/A4/G4 附点四分，上下两个点又被当成反复记号的双点剔掉，23 处读成四分）。 */
  const rightOf = (b: Rect) => {
    const cy = b.y + b.h / 2;
    let r = b.x + b.w;
    for (const h2 of heads) {
      const c = h2.box;
      if (c.x <= b.x + b.w + 2 && c.x + c.w >= b.x && Math.abs(c.y + c.h / 2 - cy) <= sp * 1.5) r = Math.max(r, c.x + c.w);
    }
    return r;
  };
  /** 同一列（左右 `TWIN_COL` 格内）上下 `dy0`~`dy1` 格（往上为正）内另有一个头。 */
  const colHead = (b: Rect, dy0: number, dy1: number) => {
    const cy = b.y + b.h / 2;
    return heads.some((h2) => h2.box !== b && h2.box.x < b.x + b.w + sp * TWIN_COL && h2.box.x + h2.box.w > b.x - sp * TWIN_COL && cy - (h2.box.y + h2.box.h / 2) > sp * dy0 && cy - (h2.box.y + h2.box.h / 2) < sp * dy1);
  };
  /**
   * 窗口下沿，按附点的排版规则反推：间上的音点在本间，线上的音点在上方的间；和弦里上方的间被别的音的点占了、
   * 或下声部（和弦里别的头在上方）的线上音，点写到**下方的间**（头心下半格，天父世界歌伴奏 m11 G4、恩友歌 G4）。
   * 和弦里挤着二度的，点按头的次序一个间一个间往下排，最下面那个头的点可以再往下挪一个间（恩友歌伴奏 m17
   * C5/A4/G4/F4，F4 的点在下加一间，头心下一格）。
   */
  const below = (b: Rect) => {
    const cy = b.y + b.h / 2;
    const above = colHead(b, 0.3, 3.2);
    if (above && colHead(b, -0.1, 0.7) && !colHead(b, -3.2, -0.3)) return DOT_BELOW_PUSHED;
    if (colHead(b, 0.3, 1.2) || ((above || stemDown(b)) && onLine(Math.round(cy)))) return DOT_BELOW_STACKED;
    return DOT_BELOW;
  };
  /** 干从头的左缘往下伸（下声部）：左缘一像素内有一段 1.5 格以上的竖墨，谱线行算连着。
   *  下声部线上的音附点写在**下方的间**（Holy, Holy, Holy m11 男低 G2 附点四分，点心在头心下 0.5 格）。 */
  const stemDown = (b: Rect) => {
    for (let x = Math.max(0, b.x - 1); x <= Math.min(bin.w - 1, b.x + 1); x++) {
      let run = 0;
      for (let y = Math.round(b.y + b.h / 2); y < bin.h && (bin.data[y * bin.w + x] || onLine(y)); y++) run++;
      if (run >= sp * 1.5 + b.h / 2) return true;
    }
    return false;
  };
  /** 点落在这个头的附点窗口里吗。 */
  const inWindow = (b: Rect, d: Rect) => {
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const hy = b.y + b.h / 2;
    const r = rightOf(b);
    return cx > r + sp * 0.05 && cx < r + sp * 1.3 && cy > hy - sp * 0.85 && cy < hy + sp * below(b);
  };
  /**
   * 点的盒外一圈（`DOT_ISOLATE` 格宽、至少 2 像素）里的墨连着一根**符干**（一格半内有一段 1.5 格以上的竖墨）：
   * 是符尾的尖——符尾弯下来的末端被切断，剩一个圆点贴着笔画的断口（善牧恩慈歌 m9、万福泉源歌 m18）。
   * 只贴着连音线、加线的真附点不算（晨曦破晓 m8、m9 的附点二分）。谱线那几行不算。
   */
  const isolated = (d: Rect): boolean => {
    const g = Math.max(2, Math.round(sp * DOT_ISOLATE));
    const R = Math.round(sp * 1.5);
    const x0 = Math.max(0, d.x - R), x1 = Math.min(bin.w, d.x + d.w + R);
    const y0 = Math.max(0, d.y - R * 2), y1 = Math.min(bin.h, d.y + d.h + R * 2);
    const W = x1 - x0;
    const seen = new Uint8Array(W * (y1 - y0));
    const stack: number[] = [];
    // 谱线、加线（横向连着一格以上的墨）不算、也不从它灌过去：谱线局部位置与 `onLine` 差一两行时，
    // 从线上灌进挨着的符干会把真附点判成符尾尖（倚靠主永远膀臂 m7 贴线的附点八分）
    const hRun = (x: number, y: number) => {
      let a = x;
      let c = x;
      while (a > 0 && bin.data[y * bin.w + a - 1]) a--;
      while (c < bin.w - 1 && bin.data[y * bin.w + c + 1]) c++;
      return c - a + 1;
    };
    const inDot = (x: number, y: number) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h;
    for (let y = d.y - g; y < d.y + d.h + g; y++) {
      if (y < y0 || y >= y1 || onLine(y)) continue;
      for (let x = d.x - g; x < d.x + d.w + g; x++) {
        if (x < x0 || x >= x1 || inDot(x, y) || !bin.data[y * bin.w + x] || seen[(y - y0) * W + x - x0] || hRun(x, y) >= sp) continue;
        seen[(y - y0) * W + x - x0] = 1;
        stack.push(x, y);
      }
    }
    if (!stack.length) return true;
    // 从圈里的墨往外灌（不进点本身），记下每列灌到的最长竖段。去线图上笔画过谱线处常断开几行，
    // 竖着碰到谱线行就跳过去接着灌（符尾从干上下来要穿过一两条谱线）
    const colRun = new Map<number, [number, number]>();
    while (stack.length) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      const c = colRun.get(x);
      colRun.set(x, c ? [Math.min(c[0], y), Math.max(c[1], y)] : [y, y]);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          let ny = y + dy;
          if (dy !== 0 && ny >= y0 && ny < y1 && onLine(ny)) {
            let k = 0;
            while (k < 8 && ny >= y0 && ny < y1 && onLine(ny)) {
              ny += dy;
              k++;
            }
          }
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1 || inDot(nx, ny) || !bin.data[ny * bin.w + nx]) continue;
          const k = (ny - y0) * W + nx - x0;
          if (seen[k] || hRun(nx, ny) >= sp) continue;
          seen[k] = 1;
          stack.push(nx, ny);
        }
    }
    // 竖段要真连着：那一列从上到下逐行都是墨
    for (const [x, [a, c]] of colRun) {
      if (c - a + 1 < sp * 1.5) continue;
      let run = 0;
      let most = 0;
      for (let y = a; y <= c; y++) {
        run = bin.data[y * bin.w + x] || onLine(y) ? run + 1 : 0;
        most = Math.max(most, run);
      }
      if (most >= sp * 1.5) return false;
    }
    return true;
  };
  /** 盒里不在谱线行上的墨的纵向重心（没有就取盒中心）。 */
  const inkMidY = (o: Rect) => {
    let n = 0;
    let sy = 0;
    for (let y = o.y; y < o.y + o.h; y++) {
      if (onLine(y)) continue;
      for (let x = o.x; x < o.x + o.w; x++) if (bin.data[y * bin.w + x]) {
        n++;
        sy += y;
      }
    }
    return n ? sy / n + 0.5 : o.y + o.h / 2;
  };
  /** 盒里有不在谱线行上的墨。 */
  const offLine = (o: Rect) => {
    for (let y = o.y; y < o.y + o.h; y++) {
      if (onLine(y)) continue;
      for (let x = o.x; x < o.x + o.w; x++) if (bin.data[y * bin.w + x]) return true;
    }
    return false;
  };
  /**
   * `d`、`o` 两点是反复记号的两点：同一谱表里一个在第二间、一个在第三间（点心离间心不过 `REPEAT_Y` 格）、
   * 左右对齐（`REPEAT_X` 格内），两点左边或右边 `REPEAT_GAP` 格内有反复小节线——
   * 一粗（≥ `REPEAT_THICK` 格）一细两根、都从第一线贯穿到第五线（谱线行算墨、容 `REPEAT_INK` 的断口），相隔不过 `REPEAT_PAIR` 格。
   */
  const repeatPair = (d: Rect, o: Rect): boolean => {
    const ax = d.x + d.w / 2, ay = d.y + d.h / 2;
    const bx = o.x + o.w / 2, by = o.y + o.h / 2;
    if (Math.abs(ax - bx) > sp * REPEAT_X) return false;
    const ys = staffYs.find((l) => l.length === 5 && ay > l[0] && ay < l[4]);
    if (!ys) return false;
    const up = Math.min(ay, by), dn = Math.max(ay, by);
    if (Math.abs(up - (ys[1] + ys[2]) / 2) > sp * REPEAT_Y || Math.abs(dn - (ys[2] + ys[3]) / 2) > sp * REPEAT_Y) return false;
    // 贯穿谱表的竖墨列，并成一根根竖线
    const full = (x: number) => {
      let ink = 0;
      for (let y = Math.round(ys[0]); y <= Math.round(ys[4]); y++) if (bin.data[y * bin.w + x] || onLine(y)) ink++;
      return ink >= (Math.round(ys[4]) - Math.round(ys[0]) + 1) * REPEAT_INK;
    };
    const left = Math.min(d.x, o.x), right = Math.max(d.x + d.w, o.x + o.w);
    const x0 = Math.max(0, Math.round(left - sp * (REPEAT_GAP + REPEAT_PAIR + 1)));
    const x1 = Math.min(bin.w - 1, Math.round(right + sp * (REPEAT_GAP + REPEAT_PAIR + 1)));
    const bars: [number, number][] = [];
    for (let x = x0; x <= x1; x++) {
      if (x >= left && x < right) continue;
      if (!full(x)) continue;
      const last = bars[bars.length - 1];
      if (last && last[1] === x - 1) last[1] = x;
      else bars.push([x, x]);
    }
    const thick = (q: [number, number]) => q[1] - q[0] + 1 >= Math.max(2, sp * REPEAT_THICK);
    // 挨着点的那一根是细线，它另一侧紧挨着一根粗线
    for (const side of [-1, 1]) {
      const near = side < 0 ? bars.filter((q) => q[1] < left).pop() : bars.find((q) => q[0] >= right);
      if (!near) continue;
      const gap = side < 0 ? left - near[1] : near[0] - right;
      if (gap > sp * REPEAT_GAP || thick(near)) continue;
      const i = bars.indexOf(near);
      const other = bars[i + side];
      if (!other || !thick(other)) continue;
      const between = side < 0 ? near[0] - other[1] : other[0] - near[1];
      if (between <= sp * REPEAT_PAIR) return true;
    }
    return false;
  };
  for (const hd of only ?? heads) {
    const b = hd.box;
    const cy = b.y + b.h / 2;
    const r = rightOf(b);
    // 取块的窗口上下各多放 0.3 格，再只留中心落在原窗口里的：窗口沿正切在点的边上时，
    // 一两个毛刺像素伸出窗口就整块作废（齐来称颂低音谱表 C♯4/A3 附点二分，两个点都这么丢了）
    const bl = below(b);
    // 右边也放：点心在 1.3 格内、右缘伸出窗口的也要（敬拜万世之王 m18，8 像素宽的点被右沿切掉两列作废；只限谱表里，见下）
    // 左边也放：头盒偏宽（带进了圈外的毛边）时右缘罩住点的左边一两列，点伸出窗口就作废（齐来称颂 m18/m19 附点二分）
    // 靠这一放才收进来的（左缘在原窗口左边）要够大（两边都 0.3 格）：谱线在头右边的残渣原来被窗口切掉（我灵镇静 m21 多出一个点）
    for (const d of blobsIn(r - sp * DOT_PAD, cy - sp * (0.85 + DOT_PAD), r + sp * (1.3 + DOT_PAD), cy + sp * (bl + DOT_PAD)).filter((q) => {
      const qx = q.x + q.w / 2;
      const qy = q.y + q.h / 2;
      if (q.x < r + sp * 0.05 && (q.w < sp * 0.3 || q.h < sp * 0.3)) return false;
      if (!(qx > r + sp * 0.05 && qx < r + sp * 1.3 && qy > cy - sp * 0.85 && qy < cy + sp * bl)) return false;
      const inStaff = staffYs.some((l) => qy > l[0] - sp && qy < l[l.length - 1] + sp);
      // **按谱线定高差**：附点写在间里，点心离间心不过 `DOT_SPACE_TOL` 格；点所在的间与头的位置（按谱线取整到半格）
      // 只差几档——间上的音同一个间（0）、线上的音上下相邻的间（±半格）、和弦挤着二度的往下挪一个间（+1）。
      // 头盒中心不准（带进一截干、只罩住半个头），拿它直接量高差会错剔二十多个真附点，所以头位置取 ±`DOT_HEAD_TOL` 格内的半格。
      // 点心取不在谱线行上的墨的重心：贴线的点盒子带进线行，中心被拉偏（我灵镇静 m10、父恩广大 m6）。
      // 五线以外没有线，加线音的点常与头齐平（齐来崇拜 m8、m22 的 C4），那里不要求落在间里。谱表外一格半以外的不管
      const l = staffYs.find((ys) => ys.length === 5 && qy > ys[0] - sp * 1.5 && qy < ys[4] + sp * 1.5);
      if (l) {
        const g = (l[4] - l[0]) / 4;
        const pos = (inkMidY(q) - l[0]) / g;
        const inside = pos > -DOT_SPACE_TOL && pos < 4 + DOT_SPACE_TOL;
        const spaceOff = Math.abs(pos - Math.floor(pos) - 0.5);
        if (inside && spaceOff > DOT_SPACE_TOL) return false;
        const dotAt = inside ? Math.floor(pos) + 0.5 : Math.round(pos * 2) / 2;
        const hp = (cy - l[0]) / g;
        const heads = [Math.floor(hp * 2) / 2, Math.ceil(hp * 2) / 2].filter((h) => Math.abs(h - hp) <= DOT_HEAD_TOL);
        const ks = [0, -0.5, 0.5, ...(bl === DOT_BELOW_PUSHED ? [1] : [])];
        if (!heads.some((h) => ks.includes(dotAt - h))) return false;
      }
      // 伸出原窗口右沿的只在谱表里收：谱表外歌词行里字的一笔挨着被当成头的另一笔（破碎 p1/p2）
      if (q.x + q.w > r + sp * 1.3 && !inStaff) return false;
      // 头心下 `DOT_BELOW_SOLID` 格往下那一段只收谱表里、整个落在间里碰不到谱线行的点：
      // 扫描件谱线下沿的鼓包、残渣正好在那儿（破碎 p6/p7 三处），谱表外歌词字的一笔也常落在这儿（望十架）
      if (bl === DOT_BELOW && qy > cy + sp * DOT_BELOW_SOLID) {
        if (!inStaff) return false;
        for (let y = q.y - 1; y <= q.y + q.h; y++) if (onLine(y)) return false;
      }
      return true;
    })) {
      if (out.some((o) => overlapFrac(o, d) > 0)) continue;
      if (syms.some((s0) => overlapFrac(d, s0.box) > 0.3)) continue;
      // 反复记号的两点：同一列上下一格处还有一个点。
      // 但**和弦的附点**也是这样上下一格排着：另一个点若落在同列**另一个头**的附点窗口里，
      // 它就有自己的主人、不是反复记号（齐来称颂 m4/m17~m19、赞美三一真神 m5/m8 的附点二分和弦
      // 以前全被这条毙掉，读成二分或全音符）
      const dcx = d.x + d.w / 2;
      const dcy = d.y + d.h / 2;
      // **反复记号的判定要严**：两点正落在中线上下两个间（第二、三间）、左右对齐，旁边有一粗一细的反复小节线、
      // 点离小节线不过 `REPEAT_GAP` 格，三条都满足才不当附点（`repeatPair`）。原先只要同列上下一格还有个点就算，
      // 「8」字叠头各带一个点（以马内利来临歌 m4 只认出上面那个头）、点正上/正下方谱线行残下的一小截
      //（主使我喜乐 m7、倚靠主永远膀臂 m7）都被当成反复记号剔掉
      const twins = blobsIn(dcx - sp * 0.5, dcy - sp * 1.5, dcx + sp * 0.5, dcy + sp * 1.5)
        .filter((o) => Math.abs(o.y + o.h / 2 - dcy) > sp * 0.6 && offLine(o))
        .filter((o) => !heads.some((h2) => h2 !== hd && h2.box.x < b.x + b.w + sp * TWIN_COL && h2.box.x + h2.box.w > b.x - sp * TWIN_COL && inWindow(h2.box, o)))
        .filter((o) => repeatPair(d, o));
      if (twins.length) continue;
      // 四周 `DOT_CLEAR` 格内另有不属于任何符号的小墨团：扫描件的噪点成片（破碎一页上 4×4 的点隔七八个像素一个），
      // 真附点四周是干净的
      const speckles = blobsIn(dcx - sp * DOT_CLEAR, dcy - sp * DOT_CLEAR, dcx + sp * DOT_CLEAR, dcy + sp * DOT_CLEAR)
        .filter((o) => overlapFrac(o, d) === 0 && offLine(o) && !syms.some((s0) => overlapFrac(o, s0.box) > 0));
      if (speckles.length) continue;
      if (!isolated(d)) continue;
      out.push(d);
    }
  }
  if (out.length >= DOT_MEDIAN_N) {
    const dims = out.map((d) => Math.max(d.w, d.h)).sort((p, q) => p - q);
    const med = dims[dims.length >> 1];
    return out.filter((d) => Math.max(d.w, d.h) >= med * DOT_SMALL);
  }
  return out;
}

/** 扁矩形的休止（全休止、二分休止、整小节休止）：形状都是一个贴着谱线的小实心矩形。 */
const isBarRest = (code: string) => code === "restHalf" || code === "restWhole" || code === "restHBar";

/**
 * 扁矩形休止分全、半：**全休止吊在第二线下，二分休止坐在中线上**。
 * 两者形状一样，只差位置（中心差半格），按中心在第二线与中线的哪一半判。
 * 全休止仍记 `restHBar`（整小节休止，时值随拍号），二分休止记 `restHalf`
 * ——原先一律记成整小节休止，《是谁》首小节「二分休止 + 四分休止 + 两个八分」因此多出三拍。
 */
function restKind(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): SmuflName {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] - unit.space || cy > ys[i + 4] + unit.space) continue;
    return cy > (ys[i + 1] + ys[i + 2]) / 2 ? "restHalf" : "restHBar";
  }
  return "restHBar";
}

function nearRestLine(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
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
function splitAt(bin: Binary, box: Rect): [Rect, Rect] | null {
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
function longestVRun(bin: Binary, box: Rect): number {
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
function sharpShape(bin: Binary, box: Rect): boolean {
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
function tallStrokes(bin: Binary, box: Rect): number {
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
function isStackedPair(box: Rect, area: number, unit: { space: number }): boolean {
  const w = box.w / unit.space;
  const h = box.h / unit.space;
  return w >= 0.9 && w <= 1.7 && h >= 1.7 && h <= 2.4 && area / Math.max(1, box.w * box.h) >= 0.7;
}

/** 断开的小节线：竖段至少盖住谱表高的几成、缺口处有几成是「比左右暗」的淡墨才补。 */
const FAINT_BAR_COVER = 0.6;
const FAINT_BAR_FILL = 0.8;
/** 淡墨要比左右 `FAINT_SIDE` 像素外暗过多少灰度。实测断口 170~206、页白 245 上下。 */
const FAINT_DELTA = 25;
const FAINT_SIDE = 4;

/**
 * 块里**开口的内腔**：四向射线（在块外扩 `OPEN_CAVITY_PAD` 格的窗里）都碰得到墨的白像素，按四连通拼块，
 * 返回够 `OPEN_CAVITY_AREA` 格² 的那些块的外框。
 */
function openCavities(bin: Binary, box: Rect, unit: RasterUnit): Rect[] {
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

/**
 * **细线扫描件回灰度核断开的小节线**（只有 `RasterPage.gray` 的页才走）。
 *
 * 敬拜万世之王的小节线灰度 150~206，松阈值那一档也切不全：第五线到第四线整格没了、
 * 或下端差第一线 0.4 格，`findBarlines` 要两端贴外线（四分之一格）收不下。原图其实是连着的。
 * 整页换二值化试过三种（脊线图并入、只收长游程、只补断口），字的竖笔、弧线端跟着变，
 * 歌词、弧线各掉一两点——所以**先按几何找出疑似断开的那一根，再只看那一列的灰度**：
 * 竖段两端都在谱表内（不探出 0.3 格）、盖住谱表高六成以上，缺口里八成的行比左右暗过 25
 * （或正压在谱线上），就补成纵贯五线的一条。符干碰不上：头那一端缺口是符头的墨，
 * 左右也暗；另一端缺口是白的。
 */
function bridgeFaintBars(vSegs: LineSeg[], gray: Uint8Array, w: number, staves: number[][], unit: RasterUnit): void {
  const sp = unit.space;
  const lt = Math.max(1, unit.lineThick);
  for (const ys of staves) {
    const top = ys[0];
    const bot = ys[4];
    const onLine = (y: number) => ys.some((ly) => Math.abs(y - ly) <= lt);
    for (let i = 0; i < vSegs.length; i++) {
      const v = vSegs[i];
      const a = Math.min(v.y0, v.y1);
      const b = Math.max(v.y0, v.y1);
      if (a < top - sp * 0.3 || b > bot + sp * 0.3) continue;
      if (b - a < (bot - top) * FAINT_BAR_COVER) continue;
      if (a <= top + sp * 0.25 && b >= bot - sp * 0.25) continue;
      const x = Math.round((v.x0 + v.x1) / 2);
      if (x - FAINT_SIDE - 1 < 0 || x + FAINT_SIDE + 1 >= w) continue;
      const dark = (y: number) => {
        const r = Math.round(y) * w;
        const c = Math.min(gray[r + x - 1], gray[r + x], gray[r + x + 1]);
        const side = Math.min(gray[r + x - FAINT_SIDE - 1], gray[r + x + FAINT_SIDE + 1]);
        return side - c >= FAINT_DELTA;
      };
      let gap = 0;
      let hit = 0;
      for (let y = Math.round(top); y < a; y++) (gap++, (hit += +(onLine(y) || dark(y))));
      for (let y = Math.round(b) + 1; y <= bot; y++) (gap++, (hit += +(onLine(y) || dark(y))));
      if (!gap || hit < gap * FAINT_BAR_FILL) continue;
      vSegs[i] = { ...v, x0: x, x1: x, y0: Math.min(a, top), y1: Math.max(b, bot) };
    }
  }
}

// ── 和弦上的延音线 ───────────────────────────────────────────────────────────
//
// 两个同样的和弦之间每个音各一条延音线：上面那条压着谱线、去线时抹掉大半，中间的被谱线切成几截（还会被认成保持音），
// 剩下认得出的常只有最外侧那条（望十架 p3 m29–30 钢琴右手）。而这条弧挂端点按最近的符头挑，常挂到和弦里别的音上，成了圆滑线。
// 两件事：① 弧两头都在和弦上、两边有共同的音级、弧近水平，改挂到最外侧的共同音（弧在下取最低、在上取最高），判延音线；
// ② 两边音级完全相同（两个音以上）、已有一条延音线，其余同音也补上（返回要补的对，`markSlurNotes` 之后打标记）。

/** 弧两端纵向差的上限（格）：延音线是平的。 */
const CHORD_TIE_DY = 0.6;
/** 延音线中间夹着的音，离两端几个音级以内才算同一声部。 */
const TIE_BETWEEN_STEPS = 5;
/** 改挂时弧端离那个音外缘的上限（格）。 */
const CHORD_TIE_REACH = 1;

function tieChords(slurs: SlurArc[], notes: StaffNote[], sp: number): [StaffNote, StaffNote][] {
  const column = (n: StaffNote): StaffNote[] =>
    notes.filter((m) => !m.rest && !m.grace && m.staff === n.staff && (m.group === n.group || Math.abs(m.x - n.x) < sp * 1.2));
  const out: [StaffNote, StaffNote][] = [];
  for (const sl of slurs) {
    const { from, to } = sl;
    if (!from || !to || from === to || from.staff !== to.staff || to.x <= from.x) continue;
    if (Math.abs(sl.ly - sl.ry) > sp * CHORD_TIE_DY) continue;
    const A = column(from), B = column(to);
    if (A.length < 2 || B.length < 2) continue;
    const dA = new Set(A.map((n) => n.diatonic)), dB = new Set(B.map((n) => n.diatonic));
    const common = [...dA].filter((d) => dB.has(d)).sort((a, b) => a - b);
    if (!common.length) continue;
    if (!sl.tie) {
      const d = sl.above ? common[common.length - 1]! : common[0]!;
      const a = A.find((n) => n.diatonic === d)!, b = B.find((n) => n.diatonic === d)!;
      // 弧端要贴着那个音（弧在下离头下缘、在上离头上缘一格以内）：跨两个和弦的圆滑线挂在别处（万口欢唱 m7）
      const near = (n: StaffNote, y: number) => (sl.above ? n.sym.box.top - y : y - n.sym.box.bottom) <= sp * CHORD_TIE_REACH;
      if (!near(a, sl.ly) || !near(b, sl.ry)) continue;
      sl.from = a;
      sl.to = b;
      sl.tie = true;
    }
    if (dA.size < 2 || dA.size !== dB.size || common.length !== dA.size) continue;
    for (const d of common) {
      const a = A.find((n) => n.diatonic === d)!, b = B.find((n) => n.diatonic === d)!;
      if (a !== sl.from) out.push([a, b]);
    }
  }
  return out;
}

/**
 * 弧端挂不上符头时，把音连同它的符干一起当盒再挂一次：钢琴低音的八分一组干朝下、杠在下面，圆滑线画在杠下、
 * 弧端贴着干端，离符头三格开外（破碎 p2 低音 m2–m6 一整排）。挂上的是这根干上离弧端最近的那个头；
 * 两端同音高的照样判延音线（同 `attachSlurs`）。
 */
function attachSlursByStem(slurs: SlurArc[], notes: StaffNote[], sp: number): void {
  const withStem = notes.filter((n) => !n.rest && n.group?.stem);
  for (const sl of slurs) {
    if (sl.from && sl.to) continue;
    for (const isEnd of [false, true]) {
      if (isEnd ? sl.to : sl.from) continue;
      const px = isEnd ? sl.rx : sl.lx, py = isEnd ? sl.ry : sl.ly;
      let best: StaffNote | undefined;
      let bd = Infinity;
      for (const n of withStem) {
        const h = n.sym.box, g = n.group!.stem!.seg.box;
        const box = { left: Math.min(h.left, g.left), right: Math.max(h.right, g.right), top: Math.min(h.top, g.top), bottom: Math.max(h.bottom, g.bottom) };
        const v = validateSlurNote(isEnd, box, px, py, sp, sl.above);
        if (v === null) continue;
        // 同一根干上几个头：取离弧端最近的
        const d = v * 1e6 + Math.hypot((h.left + h.right) / 2 - px, (h.top + h.bottom) / 2 - py);
        if (d < bd) (bd = d), (best = n);
      }
      if (!best) continue;
      if (isEnd) sl.to = best;
      else sl.from = best;
    }
    if (sl.from && sl.to && sl.from === sl.to) sl.to = undefined;
    if (sl.from && sl.to && sl.from.staff === sl.to.staff && sl.from.diatonic === sl.to.diatonic) sl.tie = true;
  }
}
