// 位图五线谱的单页识别：位图 → `StaffPageResult`（与矢量路同一个返回类型）。
//
// **下游全部复用 `src/staffomr/`**，那边一行不改。本文件只做两件事：
//   1. 把位图变成 `Staff` / `Seg` / `Sym`（`adapt.ts`）；
//   2. 按矢量路 `staffomr/pagerun.ts::recognizeStaffPage` 的**同一个次序**往下调。
//
// 与矢量路的差别只有三处，都是「那边从路径对象里取、这边从像素里取」：
//   - 符杠：矢量路 `findBeams` 读 `pg.objs` 的填充路径；位图路自己找（`prims.ts`）。
//   - 符头：矢量路查字形字典；位图路按性质判（`notehead.ts`）。
//   - 文本层：矢量路读文字对象；位图路要 OCR（尚未接，故歌词/力度/速度暂缺）。
import type { Binary } from "../omrkit/types";
import { closedHoles, timeDigit, timeKey, timeStripOf, type TimeStrip } from "./timesig";
import type { Component, Rect } from "../omrkit/types";
import { inkTextSize, TEXT_INK_EM } from "./textsize";
import { definePortable } from "./portablefn";
import { findBarlines, findNoteheads, findStaves, findStems, findTails, makeBars, makeSystems, tagSystemBarlines } from "../staffomr/page";
import { isAccidental, isClef, timeSigDigit, type SmuflName } from "../staffomr/glyphs";
import { buildNotes, findClefKeyTime, type BeamShape, type StaffContext, type StaffNote, type StemInfo, type BarCheck } from "../staffomr/notedata";
import { markRepeatsAndVoltas } from "./repeats";
import type { WordStrip } from "./words";
import type { HeaderCredit, WordLine } from "../omrkit/headertext";
import { findTuplets, type WedgeOpen, type WedgeRows } from "../staffomr/notations";
import type { SPage, Staff, Sym, Tag } from "../staffomr/model";
import { buildRasterPage, makeSymObj, type RasterSym } from "./adapt";
import { binSig, blobImage, extendVSegs, findBlobs, findBraces, findPrimitives, groupByLeftInk, findPartBrackets, joinVSegs, removeStaffLines, repairLineCuts, verticalStrokes, type BeamQuad, type LineSeg, type RasterPrims } from "./prims";
import { archCavity, stemWalledCavity, findRasterHeads, hollowHeadsByPitch, headsOnBareStems, headsBetweenStemPairs, probeBareStems, hollowHeadsFromCavities, hollowHeadsAlongStems, hollowHeadsFromHoles, hollowHeadsOnStemSeeds, reseatHollowHeads, stemOf, hollowHeadsOnLedgers, hollowSlit, inkColumn, judgeHeadBox, mergeHoles, markShapeWholes } from "./notehead";
import { bootstrapClefs, matchTemplate, RasterGlyphLookup, type BootStaff } from "./rasterglyphs";
import { sigDistance } from "../omrkit/glyphdict";
import { completeStaffBars, cutJianpuStrip, eraseInBand, findJianpuBands, type JianpuStrip } from "./jianpuband";
import type { FuseStats, JianpuRow } from "./jianpufuse";
import { CHAR_MAX as LYRIC_CHAR_MAX, type LyricStrip, type OcrChar } from "./lyric";
import { candidateMap, cavityLike, findHoles, holeSolidity, repairedLayer, traceContours, type ContourMap } from "./contour";
import { buildHeadMasks, buildHollowMasks, headFromStemBlock, scoreAt, scoreAtMasked, solidHeadsAlongStems, splitHeadCluster } from "./headmask";
import { headProb, trainHeadClassifier } from "./headclass";
import type { LabelStrip } from "./stafflabel";
import { findHarmonyStrips, harmonyKey, harmonyLine, readHarmonyStrip, type HarmonyStrip, type HarmonyToken } from "./harmony";
import type { RasterWedge } from "./wedge";
import type { RasterDynamic } from "./dynamics";
import { ContourLedger } from "./ledger";
import type { LyricLine } from "../staffomr/textanalyze";
import type { SlurArc } from "../staffomr/slur";
import { composeHeaderStrip } from "./pagecompose";
import { isTextStaff, pageTextKey, textDetScale } from "./pagetext";
import { LineGrid, liftOf, lineYAt, localLineModel, pitchPos, pitchY, type RasterUnit } from "./staffline";
import { findRasterStaves } from "./stafffind";
import { rasterizePage, type RasterPage } from "./rasterpage";
import { median, rowHasInk, unionRect as union, overlapFrac } from "../omrkit/geom";
import { connectedComponents } from "../omrkit/ccl";
import { areaClose, close, ellipseOpen } from "../omrkit/morph";
import { type LineFrame, makePitchSteps, ledgerCandidates, makePitchGrid, sharedLegers, ownLegers } from "./pitchgrid";
import { bridgeFaintBars, pastSysLine, joinThroughBars, inkSystemBarlines, bridgeFaintSysLines, dropLoneBarlines, voteSystemBarlines } from "./barvote";
import { nearRestLine, restKind, nearStaffStart, fillAround, isEighthRest, symbolInk, isStackedPair, isBarRest, enclosedWhite, crossRuns, midOfStaff, offStaffRest, sharpCrossbars, crossbarAccidental, crossbarAccidentalBox, flatAccidentalBox, tallStrokes, longestVRun, splitAt, sharpShape, wholesByShape, openCavities, STAFF_START } from "./restshape";
import { sharpsByStrokes, dropCourtesyKeys, demoteMidKeys, extendKeyChains, dropHeadsInKey, pruneMidKeys, fixKeyNaturals, keySections, extendKeyByStrokes, shareSystemKeys, shareKeySignature, carrySystemKeys, extendKeyByCarry, findMidKeysByTemplate, shareMidKeys, dropBarsInKey, keyFromChords, fixFlatReadAsSix, attachAccidentalsByPitch, naturalsByStrokes, KEY_GAP, KEY_GAP_FIRST, LOOSE_ACC_GAP } from "./keysig";
import { vRunAt, snapHeadsToStems, splitSecondStems, splitVoiceStems, tagLooseStems, splitUnisons, doubleUnisonWholes, markCrossStaff } from "./stems";
import { type TimeColumn, shareSystemClefs, shareOctaveClefs, shareTimeSignature } from "./clefmeter";
import { findDots } from "./dots";
import { bootstrapFlags, toBeamShapes, snapBeamEnds } from "./flags";
import { fixByCrossStaff, type DotProbe, type GapProbe, type HeadSearch } from "./crossalign";
import { dropBorrowedBeams, fixDottedPairs, fixQuartersByBarSum, tupletsByBarSum } from "./rhythmfix";
import { finishRasterPage } from "./pagefinish";

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
  /** 页的内容指纹（`pagetext.ts::pageTextKey`）：文字区缓存按它寻址。只在给了 `pageTexts` 或 `wantTextBin` 时算。 */
  textKey?: string;
  /** 送文字检测的那张位图（`opts.wantTextBin` 且缓存里还没有这一页时带出，在线识别拿去检测）。 */
  textBin?: Binary;
  /** 这一页用上的文字框（`opts.pageTexts` 命中时）。 */
  textBoxes?: Rect[];
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
  /** 末系统各行续到下一页的松叶等（见 `attachWedges`）。 */
  wedgeRows?: WedgeRows;
}

/** 跨页沿用的调号：记号种类与个数。 */
export interface CarryKey {
  code: string;
  n: number;
  /** 多行系统各位置上低八度谱号的见证（见 `shareOctaveClefs`），随调号一起往下一页带。 */
  clefs?: ClefTally;
}

/** 一页从前面各页接过来的东西：沿用的拍号、调号，以及前面还没有页眉（这一页要切页眉带）。 */
export interface PageCarry {
  carryTime?: { beats: number; beatType: number };
  carryKey?: CarryKey;
  wantHeader?: boolean;
  /** 上一页末系统各行续过来的松叶 */
  openWedges?: (WedgeOpen | null)[];
}

/** 一页的来源：栅格化、拼页眉带（曲首页的页眉印在谱图之外时）。串行路由 pdf.js 页对象实现，Worker 里另有实现。 */
export interface PageSource {
  raster(): Promise<RasterPage | null>;
  composeHeader(binW: number): Promise<{ strip: WordStrip; texts: WordLine[] } | null>;
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

/** 按本页位图量文字墨高（`SPage.inkTextSize`）；可重建，页结果才传得过线程（`pagetransfer.ts`）。 */
const inkTextSizeOn = definePortable("inkTextSize", (bin: Binary) => (box: { x: number; y: number; w: number; h: number }, text: string) => inkTextSize(bin, box, text));

/** 记账时算「这条段有主」的标记。见 `makeBars` 之后那一段。 */
const SEG_TAGS: Tag[] = ["Staff", "Leger", "Stem", "BarLine", "SysLine", "Tail", "Beam", "Bracket"];

/** 页面单位合 pt 的系数到这么大（≈80dpi）就当页面尺寸不可信（`SPage.sizeKnown`） */
const LOW_DPI_SCALE = 0.9;

/** 判别器只看这个尺寸包络内的块（线距的倍数）——比 `findRasterHeads` 的闸宽一圈，
 *  正是要捞被啃窄、被粘宽的那一批；再宽就成了「拿模板去空地里找东西」。 */
const CLF_W = [0.5, 2.2] as const;
const CLF_H = [0.4, 1.6] as const;
/** 判别器收下的概率门槛。扫过 0.6 / 0.7 / **0.8** / 0.9 / 0.95：
 *  扫描件音符 65.45 / 65.16 / **65.46** / 65.06 / 64.95%，
 *  干净档音符 84.89 / 84.94 / **84.94** / 84.94 / 84.94%——0.8 是扫描档见顶
 *  且干净档一分不动的那一点（0.6 扫描相当但干净档掉 0.05）。 */
const CLF_P = 0.8;
/** 分类器补头时，与已认的几个头重叠比例**加起来**过这么多也算已占（`headTaken`）。是爱 p5 m70 那块两份各 0.25、0.27。 */
const HEAD_TAKEN_SUM = 0.45;
/** 第二遍拆块的尺寸上限（线距的倍数）。取的正是 `findBlobs` 自己的上限
 *  （宽 6 格、高 9 格）——**等于不再设限**，拆出来的头全交给判别器把关。
 *  写成 9×5.5 / 12×7 / 16×9 实测结果完全相同，因为再大的块 `findBlobs` 根本不出。 */
/** 斑点补头（判别器那一段之后）：开运算椭圆的半轴（格）——比扫描件的线宽、干宽都粗，比实心头的半高细。 */
/** 认成波浪线的竖条宽不过这么多格（格）就不认领，留给临时记号并竖笔。 */
const WIGGLE_THIN = 0.3;
/** 并排两个临时记号粘成的块至多这么宽（格）。 */
const ACC_PAIR_W = 2.4;
/** 头左边找临时记号的窗：往左这么多格、上下各这么多格。 */
const ACC_PROBE_W = 1.4;
const ACC_PROBE_H = 1.7;
/** 窗往上多开到这么多格：降号的竖笔从肚子中心往上就有 1.75 格，顶端碰到窗上沿会被当邻音扣掉（爱是从神而来 p5 m60 右手 ♭）。 */
const ACC_PROBE_UP = 2.1;
/** 干尖符尾根（`recognize.ts` 头 + 干块那段）：两个头之间贴着干那一条，去线图上至少这么多行有墨（符尾那一笔）。 */
const FLAG_STROKE_ROWS = 0.5;
const ACC_PROBE_SHARP_H = 2.8;
/** 窄过这么多格的临时记号是半截。 */
const ACC_HALF_W = 0.45;
/** 记号盒中与头心差不过这么多格算这个头的（降号盒这时已收到肚子上，见 `FLAT_BOWL_TOP`）。 */
const ACC_OWN_DY = 0.45;
const SPOT_RX = 0.28;
const SPOT_RY = 0.22;
/** 斑点的尺寸闸（格）与离外线多远以内（格，带加线的头）。 */
const SPOT_W = [0.6, 1.9] as const;
const SPOT_H = [0.45, 1.5] as const;
const SPOT_BAND = 3;
/** 干的证据：头心起往干那头量多长（格）、那一列墨要占几成（断成虚线的干也算）。 */
const SPOT_STEM = 2.5;
/** 压在符杠中线上的斑点，矮过这个（格）才当杠片：真杠开运算后只剩杠厚（半格上下），头有大半格高——
 *  扫描件上同高的几个头被残线连成一条厚「杠」，真头就压在它中线上（破碎扫描 p10 m96）。 */
const SPOT_BEAM_H = 0.75;
const SPOT_STEM_INK = 0.65;
const SPOT_BAR = 3;
/** 斑点宽、高都要到本页已认实心头斑点中位数的这么多；本页够 `SPOT_RULER_N` 个才有尺子。 */
const SPOT_RULER = 0.8;
const SPOT_RULER_N = 8;
/** 斑点宽的上限：本页中位数的这么多倍。 */
const SPOT_RULER_MAX = 1.3;
/** 斑点那一路判别器的门槛：比块那几路（`CLF_P`）松，因为另有干的证据。扫过 0.8 / 0.65 / 0.5：
 *  合唱谱扫描件四份 84.27·80.97·85.31·92.12 / 84.43·80.93·85.63·92.12 / 84.39·80.93·85.66·91.95（破碎扫描·是爱·望十架·爱是从神而来）。 */
const SPOT_P = 0.65;
/** 空心头的斑点：先填上不过这么大（格²）的小内腔再开运算。 */
const HSPOT_HOLE = 0.8;
/** 头心小椭圆里原图的白要占这么多（有内腔）。 */
const HSPOT_WHITE = 0.25;
/** 本页空心模板的分。 */
const HSPOT_SCORE = 0.3;
/** 本页已认空心头的斑点够这么多个才有尺子。 */
const HSPOT_RULER_N = 4;
/** 叠成一摞的和弦斑点的高度上限（格）：三个三度叠头。 */
const HSPOT_STACK_H = 3.4;
/** 旁边没干的斑点宽到这么多格才按全音符试。 */
const HSPOT_WHOLE_W = 1.5;
/** 原图墨柱补的干：头心离墨柱一端不过这么多格。 */
const HSPOT_STEM_END = 0.75;
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
/** 八分休止候选左边 0.8 格、上六成高里墨够这么多（格，按像素数折算）就当左边挨着字母（和弦记号「C7」的 7）。 */
const SEVEN_LEFT_INK = 1;
/** 临时记号的盒有这么大一部分落在一个空心头盒里，那个头不算（见「盖住一个临时记号大半的空心头」）。 */
const ACC_UNDER_HEAD = 0.5;
/** 从符杠表里捡的休止，不压线的部分至少这么高（格）：手写本的全休止只是线下一道 0.3 格的粗横（是爱 p1 m6、p5 m70）。 */
const REST_BEAM_H = 0.2;

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
/** 上下被谱线封住的孔（见 `pinched`）：宽过多少格才判、凸度低于多少不当内腔。合唱谱各份真内腔 0.8~0.9，降号旁那块 0.59。 */
const PINCHED_W = 0.8;
const HOLE_CONVEX_MIN = 0.7;
const OPEN_CAVITY_BAND = 2;
/** 演奏记号离谱表最远几格（线距）：带加线的低音再往下一格，四格半够了。 */
const ARTIC_REACH = 4.5;
/** 调号串里后一个记号的左缘可以伸进前一个右缘多少格。 */
const KEY_OVERLAP = 0.5;
/** 上下贴着的两个头（`isStackedPair`）拆分时每个头的得分门槛。 */
const PAIR_SCORE_MIN = 0.4;
/** 两个头盒中心上下差不到这么多格、左右差不到 `DUP_HEAD_DX` 格，就是同一个头被两路各认了一次。
 *  0.3 → 0.6：左右不错开的两个头上下不会只差一级（二度必定左右错开一个头宽）；万福泉源歌末小节「8」字叠头上面那个 E4
 *  被两路各认一次、盒差 0.5 格，多出一个 D4。 */
const DUP_HEAD_DY = 0.6;
const DUP_HEAD_DX = 0.5;
/** 上下贴着的两个实心头填满外框的九成以上（所信有根基 F4/D♭4 0.904），拆块的「太实是黑块」上限 0.9 对它放到这个数。 */
const PAIR_FILL_MAX = 0.96;
/** 空心头正上/正下一格、头宽×头高七成的窗里墨占这么多，算贴着一个实心头。 */
const SOLID_NEIGHBOR_FILL = 0.7;
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
/** 细杠起头那截扁墨的高度上限（格，`beamRoot`）：望十架 p3 两处 0.6、0.68，正常实心头 0.9 起。 */
const BEAM_ROOT_H = 0.75;
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
/** 量头落不落在符尾里时，符尾盒往尾梢那头延长的格数（见用处）。 */
const FLAG_TAIL_EXT = 1.5;
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
/** 谱表到头之间的加线都在时，空心头允许离谱表这么多格（见 `inBand`）。 */
const HOLLOW_BAND_LEDGER = 5.3;
/** 谱表外的头按墨定高时，墨高（格）要在这个范围里才算一个头。 */
const HEAD_INK_H = [0.8, 1.3] as const;

/** `staffBandOnly` 时谱表上下各留这么多个线距。扫过 1.5 / 2 / 3.5 格（《坚固保障》，和弦字母在上方 1.6 格处）：
 *  音符 74 / 75 / 80，其中 3.5 格那档有 5 个是被当成全音符的和弦字母。2 格是拐点。 */
const STAFF_BAND = 2;

/** 符尾围出的「空心头」离干端不超过这么多格（见「符尾围出来的空心头不要」）。 */
const FLAG_REACH = 1.6;
/** 符尾判据里「另一端的实心头」离谱表首末线不超过这么多格。 */
const FLAG_HEAD_BAND = 2.5;
/** 符尾与干那端实心头的最小距离（格）。 */
const FLAG_GAP = 2.8;
/** 头盒中心离整音级这么多（级）以上算悬着，交模板定夺。 */
const SNAP_AMBIG = 0.25;
/** 悬着的空心头挪一级后，盒里整行没墨的行多出盒高这么多就不挪（见用处）。 */
const BLANK_MOVE = 0.25;
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
/** 头缘贴着短竖段、改走墨柱补干时，墨柱远端离谱表的上限（格）。 */
const SHORT_STEM_OUT = 1.5;

/**
 * 页眉的行：**同一行、紧挨着**的两段并成一行。同一行 = 纵向重叠过矮者一半；紧挨着 = 横向空当不过两个字高。
 * - 拼页面读出的页眉：文字层的行并进 OCR 行（宁静「詞／曲／編：余遠淳」是贴的小图块、后面的「Yenn Chwen Er」在文字层，谱面上是一行字）；
 * - OCR 行之间：DBNet 在一行里的大空当处会断成两框（倚靠主「…everlasting arms.」与「— Deuteronomy 33:27」、
 *   父恩广大标题「…Heavenly」与「Father」），这样断开的两框首尾相叠（空当为负），
 *   故只并字高相近（差不过一半）、纵向重叠七成、空当不过 0.3 个字高的：居中的题记与右栏署名常字高相同、只隔一个字
 *   （晨曦破晓「…we shall rejoice...」与「Arranged by David Evans」隔 31 点、字高 47）。
 * 同一行的中英文记一条，分行印的才各记一条。
 */
/**
 * 盒下面紧接着一道斜笔：干与弯回干尖的符尾围出一块白（破碎 p9 m87/m89 低音 B3 朝下的八分），配空心模板配得上，
 * 收成和弦里的空心头。真空心头下面半格内除了谱线、加线那种整行横墨是白的；符尾那一笔每行都有、又窄，而且每行只有一段。
 * 叠成「8」字的三度空心和弦，上头正下方是下头的圈，每行也只有窄墨，但圈从第二三行起就分成左右两段（晨曦破晓 m5 D4/F4）。
 */
function flagLoop(bin: Binary, b: Rect, onLine: (y: number, x?: number) => boolean, sp: number): boolean {
  let rows = 0;
  let inked = 0;
  for (let y = Math.round(b.y + b.h); y < b.y + b.h + sp * 0.6 && y < bin.h; y++) {
    if (onLine(y, b.x + b.w / 2)) continue;
    rows++;
    let n = 0;
    let runs = 0;
    for (let x = Math.max(0, Math.round(b.x + b.w * 0.25)); x < Math.min(bin.w, b.x + b.w); x++) {
      const on = bin.data[y * bin.w + x];
      n += on;
      if (on && !bin.data[y * bin.w + x - 1]) runs++;
    }
    if (runs > 1) return false;
    if (n > 0 && n <= sp * 0.5) inked++;
  }
  return rows >= 3 && inked >= rows * 0.8;
}

/** 盒（左右各外扩 0.3 格）里放得下一个 0.9×0.6 格、墨占九成以上的窗：贴着一个实心头。
 *  给了 `holes`（原始孔）时，左右两侧 0.3 格内都贴着孔的窗不算：那是两个空心头的圈相接处（是爱 p2 m21 手写粗圈，
 *  B♭4 与错开在右边的 C5 两圈之间连成 0.9 格宽的实墨）；实心头至少一侧是空白或别的笔画。 */
function solidInside(bin: Binary, b: Rect, sp: number, holes?: Rect[]): boolean {
  const ww = Math.round(sp * 0.9), wh = Math.round(sp * 0.6);
  const x0 = Math.round(b.x - sp * 0.3), x1 = Math.round(b.x + b.w + sp * 0.3) - ww;
  const reach = sp * 0.3;
  const flanked = (x: number, y: number) =>
    !!holes &&
    holes.some((h) => h.y < y + wh && h.y + h.h > y && h.x + h.w >= x - reach && h.x + h.w <= x + ww / 2) &&
    holes.some((h) => h.y < y + wh && h.y + h.h > y && h.x <= x + ww + reach && h.x >= x + ww / 2);
  for (let y = Math.round(b.y); y <= b.y + b.h - wh; y++)
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x + ww > bin.w || y + wh > bin.h) continue;
      let k = 0;
      for (let yy = y; yy < y + wh; yy++) for (let xx = x; xx < x + ww; xx++) k += bin.data[yy * bin.w + xx];
      if (k >= ww * wh * 0.9 && !flanked(x, y)) return true;
    }
  return false;
}

/** 盒收到里面墨的外接框（没有墨返回 null）。 */
function shrinkBox(bin: Binary, b: Rect): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++)
      if (bin.data[y * bin.w + x]) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 在线识别（编辑器用）：把一页切出来的条送 OCR，回同形的表（`ocrlive.ts`）。
 *  `recognizeRasterPage` 在每处查缓存的地方，缓存没给就当场把那一处切出的条送它——一页只走一趟。 */
export interface RasterLiveOcr {
  harmony(strips: readonly HarmonyStrip[]): Promise<Map<string, OcrChar[]>>;
  lyric(strips: readonly LyricStrip[]): Promise<Map<string, OcrChar[]>>;
  label(strips: readonly LabelStrip[]): Promise<Map<string, string>>;
  /** 拍号数字条（可缺：缺了拍号只靠模板）。 */
  time?(strips: readonly TimeStrip[]): Promise<Map<string, string>>;
  jianpu(strips: readonly JianpuStrip[]): Promise<Map<string, JianpuRow[]>>;
  /** 文字指示带（可缺：缺了就不出 `<words>`）。 */
  word?(strips: readonly WordStrip[]): Promise<Map<string, WordLine[]>>;
  /** 页眉带（可缺：缺了就不出 `<credit>`）。 */
  header?(strips: readonly WordStrip[]): Promise<Map<string, WordLine[]>>;
  /** 整页文字检测（可缺：缺了各路判据不避文字）。`scale` 见 `pagetext.ts::textDetScale`。 */
  textDet?(bin: Binary, scale: number): Promise<Rect[]>;
}

/** `recognizeRasterPage` 的选项（`pagefinish.ts` 也要读其中几样）。 */
export interface RasterPageOpts {
  carryTime?: { beats: number; beatType: number };
  carryKey?: CarryKey;
  openWedges?: (WedgeOpen | null)[];
  /**
   * 跨页沿用（上一页的 `carryTime` / `carryKey`、前面有没有页眉）**晚到**的版本：给了它就不看同名的三个同步字段，
   * 识别走到第一处要用沿用的地方（`shareOctaveClefs` 之前）才 await。多页并行时前段不等上一页（见 `pagepool.ts`）。
   */
  carry?: () => Promise<PageCarry>;
  /** 这一页在整曲里的序号（从 0 起，跨几份底本连续数）：弧号带上它（「页码.页内序号」），见 `markSlurNotes`。 */
  pageSeq?: number;
  /** 页源：给了就不碰 `pdfPage` / `OPS`（Worker 里没有 pdf.js 页对象，见 `pagepool.ts`）。 */
  source?: PageSource;
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
  /** 整页文字框（`gen-rastertext.mjs` 的产物，按 `pageTextKey` 寻址；在线识别缺的页当场检测并记进来）。见 `pagetext.ts`。 */
  pageTexts?: Map<string, Rect[]>;
  /** 缓存里没有这一页的文字框时把位图带出来（`textBin`），在线识别拿去检测。 */
  wantTextBin?: boolean;
  /** 和弦条的 OCR 缓存（`scripts/gen-rasterharmony.mjs` 的产物）。见 `harmony.ts`。
   *  值的类型与歌词缓存共用（`OcrChar`）——两边都是「整条送 rec，回来字符带条内 x」。 */
  harmonyOcr?: Map<string, OcrChar[]>;
  /** 简谱行的离线识别缓存（`scripts/gen-rasterjianpu.mjs` 的产物）。混排谱拿它给五线谱纠错，见 `jianpufuse.ts`。 */
  jianpuOcr?: Map<string, JianpuRow[]>;
  /** 在线识别：上面哪张表没给，就在查它的地方把这一页切出的条当场送 OCR（编辑器用；回归脚本给离线缓存，不给它）。 */
  live?: RasterLiveOcr;
  /** 这一页已经栅格化过（编辑器判路时取的，`rasteromr/browser.ts::probeRasterStaff`）：直接用，不再取一遍。会被就地改写，只能用一次。 */
  raster?: RasterPage | null;
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
  /** 各阶段结束时把当时的中间产物交出去（回归测试的阶段快照）。数据之后还会被就地改，要留就当场序列化；识别判据一条不改。 */
  trace?: (stage: RasterStage, data: unknown) => void;
}

/**
 * 一页识别的几个阶段（回归测试的阶段快照按它分，见 `opts.trace`）：
 * `staves` 谱表与线距 → `blobs` 去线后的连通块 → `syms` 认出的符号 → `context` 谱号调号拍号 → `notes` 拼好的音 → `page` 整页结果。
 */
export type RasterStage = "staves" | "blobs" | "syms" | "context" | "notes" | "page";

/** 认一页。顺序照 `staffomr/pagerun.ts::recognizeStaffPage`，**别调**。 */
export async function recognizeRasterPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfPage: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OPS: any,
  look: RasterGlyphLookup,
  index: number,
  opts: RasterPageOpts = {},
): Promise<RasterPageResult> {
  const source: PageSource = opts.source ?? { raster: () => rasterizePage(pdfPage, OPS), composeHeader: (binW) => composeHeaderStrip(pdfPage, OPS, binW) };
  let carryP: Promise<PageCarry> | null = null;
  const carryOf = (): Promise<PageCarry> => (carryP ??= opts.carry ? opts.carry() : Promise.resolve({ carryTime: opts.carryTime, carryKey: opts.carryKey, wantHeader: opts.wantHeader, openWedges: opts.openWedges }));
  /** 没认出谱的页照样把沿用原样交下去 */
  const emptyPage = async (page: SPage, raster: RasterPage | null, unit: RasterUnit | null): Promise<RasterPageResult> => {
    const c = await carryOf();
    return empty(page, raster, unit, c.carryTime, c.carryKey);
  };
  const raster = opts.raster !== undefined ? opts.raster : await source.raster();
  const blank = buildRasterPage({ index, width: raster?.bin.w ?? 1, height: raster?.bin.h ?? 1, unit: { lineThick: 1, space: 1, height: 4 }, staffLines: [], hSegs: [], vSegs: [] });
  if (!raster) return emptyPage(blank, null, null);
  // 按逐列游程找谱表（`stafffind.ts::findRasterStaves`），线宽线距跟着出来
  const found = findRasterStaves(raster.bin);
  if (!found) return emptyPage(blank, raster, null);
  const unit = found.unit;
  // 整页文字框（找谱线之前就要）：缓存按页指纹查，查不到且要在线检测的把位图带出去
  const live = opts.live;
  const textKey = opts.pageTexts || opts.wantTextBin || live?.textDet ? pageTextKey(raster.bin) : undefined;
  let textBoxes = textKey ? opts.pageTexts?.get(textKey) : undefined;
  if (textKey && !textBoxes && live?.textDet) {
    textBoxes = await live.textDet({ w: raster.bin.w, h: raster.bin.h, data: new Uint8Array(raster.bin.data) }, textDetScale(unit));
    opts.pageTexts?.set(textKey, textBoxes);
  }
  const textBin = opts.wantTextBin && !textBoxes ? { w: raster.bin.w, h: raster.bin.h, data: new Uint8Array(raster.bin.data) } : undefined;
  const withText = (r: RasterPageResult): RasterPageResult => Object.assign(r, { textKey, textBin, textBoxes });
  // **落在文字里的「谱表」不要**（密排的中文段落凑出的五条等距横笔，见 `pagetext.ts`），它的线也不当谱线去抹
  const textStaves = textBoxes ? found.groups.filter((g) => isTextStaff(g, textBoxes)) : [];
  const groups = found.groups.filter((g) => !textStaves.includes(g));
  if (!groups.length) return withText(await emptyPage(blank, raster, unit));
  opts.trace?.("staves", { unit, staves: groups.map((g) => g.lines) });

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

  /** 全页谱线（五条一组、按行谱自上而下） */
  const staffLines = groups.flatMap((g) => g.lines);
  /** 第 k 条线在 x 处的 y（弯、斜的谱线按曲线取，平直的就是 `lines[k].y`） */
  const yAt = (g: (typeof groups)[number], k: number, x: number) => lineYAt(g.lines[k], x);
  /** 各行谱在 x 处的首末线 */
  const staffSpans = groups.map((g) => (x: number): [number, number] => [yAt(g, 0, x), yAt(g, 4, x)]);
  const nl = removeStaffLines(raster.bin, staffLines, unit);
  const staffLefts = groups.map((g) => Math.max(...g.lines.map((l) => l.left)));
  /** 各行谱左端的首末线（系统括号、花括号、按左端的墨分系统都看这一处；弯、斜的谱线按曲线取） */
  const leftEdges = groups.map((g, i) => ({ top: yAt(g, 0, staffLefts[i]), bottom: yAt(g, 4, staffLefts[i]), left: staffLefts[i] }));
  // **加线网格**（`staffline.ts::LineGrid`，按 x 取弯、斜谱线该处的线位）：加线位置按每行谱的首末线往外推。
  // 谱表外的符头**要有加线撑着才归得了谱行**（实测宁静 p5 八度跑动上方那七个符头，认出来了却一个都没归属，窗口里一条横段都没有）。
  const grid = new LineGrid(groups, unit);
  const onLedger = (y: number, x?: number) => grid.ledger(y, x);
  /** 各谱表五条线的 y（从上到下）。 */
  /** 各谱行在 x 处的五线（弯、斜的谱线按曲线取），自上而下 */
  const staffYs = (x: number) => groups.map((g) => g.lines.map((l) => lineYAt(l, x)).sort((p, q) => p - q));
  const prims = findPrimitives(nl, unit, grid, staffLefts, raster.faint);

  // ── 简谱行（混排谱）：**先于一切**认领 ─────────────────────────────────────
  //
  // 谱表正上方那行简谱的数字、增时线、高低音点，不挡就被收成全休止和加线上的符头
  //（见 `jianpuband.ts`）。整块落在带里的墨从两张图上抹掉，带里的原语一并摘掉；
  // 抹之前把条切下来，留给离线认简谱。定位判据是「短竖线与谱表小节线同 x」，
  // 独唱谱、合唱谱对不上，这一段对它们空转。
  const staffGeoms = groups.map((g) => ({
    left: Math.max(...g.lines.map((l) => l.left)),
    right: Math.min(...g.lines.map((l) => l.right)),
    top: g.lines[0].y,
    bottom: g.lines[4].y,
    topAt: (x: number) => lineYAt(g.lines[0], x),
    bottomAt: (x: number) => lineYAt(g.lines[4], x),
    lift: liftOf(g.lines[0]),
  }));
  // **随 x 变化的五线**：页面轻微倾斜、线距不匀时，局部实测的线与整行的 y 差出 3~6 像素（44 首独唱谱 p99）。
  // 读音高、悬着的空心头定夺按该处的五线、相邻两线间的相对位置来（`staffline.ts::localLineModel`）。
  // **按音高位置配模板、吸附网格不用它**：接上之后独唱谱音符 −0.13~−0.28（拆块、摘头的候选位置一挪，
  // 和弦成员、时值跟着连锁变，主我敬拜你 +4.9、向主唱新歌 −8.8），仍是整行的等距网格。
  const frames: LineFrame[] = groups.map((g, i) => ({
    top: staffGeoms[i].top,
    bottom: staffGeoms[i].bottom,
    // 量的范围取**最长**那条线：倾斜页上有一条线的投影段在半途断了，按最短的量，右边一截只能拿末桶外推
    //（颂赞与尊贵第二行右端实测偏 4.5 像素、外推只给 1，m6 的 A4 读成 G4）。线外的桶量不到，按每桶三条以上取中位兜着
    at: localLineModel(raster.bin, g.lines, Math.min(...g.lines.map((l) => l.left)), Math.max(...g.lines.map((l) => l.right)), unit),
  }));
  const jianpuBands = findJianpuBands(prims.vSegs, staffGeoms, unit, raster.bin);
  // 简谱小节线同 x 的谱表竖段补成整条小节线（细线扫描件被阈值切断的，见 `completeStaffBars`）
  completeStaffBars(prims.vSegs, staffGeoms, jianpuBands, unit);
  if (raster.gray) bridgeFaintBars(prims.vSegs, raster.gray, raster.bin.w, groups.map((g) => g.lines.map((l) => l.y)), unit);
  const jianpuStrips = jianpuBands.map((b) => cutJianpuStrip(raster.bin, b));
  if (jianpuBands.length) {
    for (const b of jianpuBands) eraseInBand([raster.bin, nl], b.box, b.lift);
    const inJp = (x: number, y: number) =>
      jianpuBands.some((b) => {
        const d = b.lift ? b.lift(x) : 0;
        return x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y + d && y <= b.box.y + b.box.h + d;
      });
    const outside = (v: { x0: number; y0: number; x1: number; y1: number }) => !(inJp(v.x0, v.y0) && inJp(v.x1, v.y1));
    prims.vSegs = prims.vSegs.filter(outside);
    prims.hSegs = prims.hSegs.filter(outside);
    prims.beams = prims.beams.filter(outside);
  }
  const blobLabels = new Int32Array(nl.w * nl.h);
  const blobs = findBlobs(nl, prims, unit, onLedger, blobLabels);
  opts.trace?.("blobs", blobs);
  // **修补图**（`prims.ts::repairLineCuts`）：去线时贴线穿过、被当线抹掉的笔画补回，被谱线切开的对象在这张图上是一整块。
  // 各路从这里取整块，不先切碎再按盒距拼：符号块（下面「碎块并起来再查一次字典」）、contour（`contour.ts::candidateMap`）
  const repaired = repairLineCuts(raster.bin, nl, staffLines, unit);
  const rBlobLabels = new Int32Array(nl.w * nl.h);
  const rBlobs = findBlobs(repaired, prims, unit, onLedger, rBlobLabels);
  /** 修补图上的符号块 → 组成它的去线图符号块 */
  const rBlobParts = new Map<number, Set<number>>();
  {
    const known = new Set(blobs.map((c) => c.id));
    for (let i = 0; i < rBlobLabels.length; i++) {
      const r = rBlobLabels[i], c = blobLabels[i];
      if (!r || !c || !known.has(c)) continue;
      let set = rBlobParts.get(r);
      if (!set) rBlobParts.set(r, (set = new Set()));
      set.add(c);
    }
  }

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
      lift: liftOf(g.lines[0]),
    }]),
    unit,
  );
  const harmonyOcr = opts.harmonyOcr ?? (live ? await live.harmony(harmonyStrips) : undefined);
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
      if (prev && strip.box.y < yAt(prev, 4, strip.box.x + strip.box.w / 2) + unit.space * 1.5) continue;
      const chars = harmonyOcr?.get(harmonyKey(strip));
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
  const contourStaves = groups.map((g) => ({
    top: g.lines[0].y,
    bottom: g.lines[4].y,
    left: Math.max(...g.lines.map((l) => l.left)),
    right: Math.min(...g.lines.map((l) => l.right)),
    lift: liftOf(g.lines[0]),
  }));
  const cmap = traceContours(nl, unit, contourStaves);
  const ledger = new ContourLedger(cmap);
  // 修补图上的 contour 层：各路按自己那一刻的候选从里面挑整块（`contour.ts::candidateMap`）
  const rlayer = repairedLayer(cmap, repaired, unit, contourStaves);
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
  const onGrid = onLedger;
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
  // 给了 x 的：加线外的头（低音谱表下三条加线外的 G1、五条加线上的 D1）也算，要谱表到头之间那几条加线在头的位置上都在
  // （望十架 p8 m63 低音 G1 二分、m60 D1/D2 全音符）。加线在原图上逐条验：头心两侧各 0.6 格那一行（上下各容一行）整段有墨
  const ledgerAt = (x: number, y: number, half: number) => {
    const B = raster.bin;
    for (const yy of [Math.round(y) - 1, Math.round(y), Math.round(y) + 1]) {
      if (yy < 0 || yy >= B.h) continue;
      let ok = true;
      for (let xx = Math.round(x - half); xx <= Math.round(x + half) && ok; xx++) ok = xx >= 0 && xx < B.w && B.data[yy * B.w + xx] === 1;
      if (ok) return true;
    }
    return false;
  };
  const inBand = (y: number, x?: number) =>
    groups.some((g) => {
      const top = x === undefined ? g.lines[0].y : yAt(g, 0, x);
      const bottom = x === undefined ? g.lines[4].y : yAt(g, 4, x);
      if (y > top - unit.space * HOLLOW_BAND && y < bottom + unit.space * HOLLOW_BAND) return true;
      if (x === undefined) return false;
      const out = y < top ? -1 : 1;
      const edge = out < 0 ? top : bottom;
      const d = (y - edge) * out;
      if (d > g.space * HOLLOW_BAND_LEDGER) return false;
      for (let k = 1; k <= Math.floor(d / g.space + 0.3); k++) if (!ledgerAt(x, edge + out * k * g.space, g.space * 0.6)) return false;
      return true;
    });
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

  // ── 空心符头：按**内腔（洞）**再找一遍 ───────────────────────────────────
  //
  // 空心符头被去谱线切碎之后一块都判不成符头（实测宁静 p2 钢琴右手那个二分和弦
  // 碎成四片），而它的**内腔**还在。所以在**去谱线之前**的图上取全页的孔，
  // 尺寸像内腔的往外扩一圈就是符头；骑线的头内腔被谱线豁成两半，先并回去。
  // 判据全在 `notehead.ts::hollowHeadsFromHoles`。
  // 缝落在谱线或加线上都算（`onGrid` 只管谱表外的加线位置）：《高举主大能》第三线上的 B4 二分头
  // 被第三线切成 10×5 与 13×5 两半，谱线上的不认就并不回来，头盒只剩下半截、读低一格
  const onLineOrGrid = (y: number, x?: number) => onGrid(y, x) || grid.onLine(y, unit.space * 0.25, x);
  // **上下被两条谱线封住、两侧墙往里鼓的白不是内腔**：降号的肚子贴着全音符左沿，肚子与圈之间、上下两条谱线之间那块白
  // 比真内腔还宽（22×18，真内腔 13×16），收出一个偏左、盖着降号的头，真头的右半落单成附点、降号也丢了
  //（爱是从神而来 p5 m59、m60 低音 G♭3）。真内腔是椭圆或斜缝，凸度 0.8 以上；这块两侧都凹进来，0.59。
  // 只判宽过 0.8 格、上下边都贴着谱线的：小孔逐像素量凸度天然偏低（燭光頌曲 5~13px 的内腔 0.5~0.7）
  const halfLine = unit.lineThick / 2;
  const pinched = (b: Rect) =>
    b.w >= unit.space * PINCHED_W && onLineOrGrid(b.y - halfLine - 0.5, b.x + b.w / 2) && onLineOrGrid(b.y + b.h + halfLine - 0.5, b.x + b.w / 2) && holeSolidity(raster.bin, b) < HOLE_CONVEX_MIN;
  const rawHoles = allHoles.filter((b) => !pinched(b));
  // **成摞的整格谱间白**（小节线与贴着它的符干夹出来、隔着谱线一格摞一格）先剔掉：它们纵向相接，
  // 会顺着链把旁边头的内腔并成一个高孔（我一生要赞美你第六行，小节线右边紧贴的 A4 二分头
  // 与上面两格并成 17×42）。单独一格不剔：谱间里的二分头圈的上下边融进谱线、内腔被截平，
  // 也上下贴线、白也近乎占满外框（整格一律剔，坚固保障等掉一刀）。
  const half = unit.lineThick / 2;
  const cellLike = (b: Rect) => {
    if (b.h < unit.space * 0.6 || !onLineOrGrid(b.y - half - 0.5, b.x + b.w / 2) || !onLineOrGrid(b.y + b.h + half - 0.5, b.x + b.w / 2)) return false;
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
  // **左右两侧都贴着贯通上下的竖墨**的格子：两根相邻的干与上下两条谱线围出的长方空当，不是内腔
  //（破碎 p3 m29 钢琴右手两个十六分的干之间，读成一个 1.7 格宽的二分 D5）。真内腔是椭圆，两侧是圈的弧
  const walledBy = (b: Rect, left: boolean) => {
    const B = raster.bin;
    const ink = (x: number, y: number) => x >= 0 && x < B.w && y >= 0 && y < B.h && !!B.data[y * B.w + x];
    const cy = Math.round(b.y + b.h / 2);
    for (const x of left ? [b.x - 1, b.x - 2] : [b.x + b.w, b.x + b.w + 1]) {
      if (!ink(x, cy)) continue;
      let y0 = cy, y1 = cy;
      while (ink(x, y0 - 1)) y0--;
      while (ink(x, y1 + 1)) y1++;
      // 竖墨比格子高出一个线距以上：是干；内腔外的圈只比内腔高出一圈
      if (y0 <= b.y - unit.space * 0.5 && y1 >= b.y + b.h + unit.space * 0.5) return true;
    }
    return false;
  };
  // 还要是方的：孔的外接框里白占九成以上。空心和弦的内腔两侧是圈，圈边接着别的头或干也成通长竖墨，但椭圆内腔四角是圈的墨
  //（我一生要赞美你、恩友歌伴奏的二分和弦，不卡方的各丢两三个头）
  const boxWhite = (b: Rect) => {
    let k = 0;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (!raster.bin.data[y * raster.bin.w + x]) k++;
    return k / Math.max(1, b.w * b.h);
  };
  // 或者两侧的墙在孔上下半格处仍是细竖线（横向墨宽不过 0.25 格）：干、临时记号的竖笔是细线，空心和弦那一侧接的是别的头的圈
  //（破碎 p8 m80 ♭ 竖笔与 ♯ 左竖之间的孔，♭ 的肚子伸进来、白只占七成，读成全音符 F4）
  const thinWall = (b: Rect, left: boolean) => {
    const x = left ? b.x - 1 : b.x + b.w;
    const B = raster.bin;
    const ink = (xx: number, y: number) => xx >= 0 && xx < B.w && y >= 0 && y < B.h && !!B.data[y * B.w + xx];
    return [Math.round(b.y - unit.space * 0.5), Math.round(b.y + b.h + unit.space * 0.5)].every((y) => {
      if (!ink(x, y)) return false;
      let a = x, z = x;
      while (ink(a - 1, y)) a--;
      while (ink(z + 1, y)) z++;
      return z - a + 1 <= unit.space * 0.25;
    });
  };
  const stemCell = (b: Rect) => walledBy(b, true) && walledBy(b, false) && (boxWhite(b) >= 0.9 || (thinWall(b, true) && thinWall(b, false)));
  // 隔一条谱线紧挨着一个剔掉的格子、两侧也贴着贯通竖墨的孔一并剔：杠与谱线之间那截白，留下来就单独成孔读出空心头（有一位神 m1 E5）
  const cellSet = rawHoles.filter(stemCell);
  const besideCell = (b: Rect) =>
    walledBy(b, true) &&
    walledBy(b, false) &&
    cellSet.some((c) => c !== b && Math.abs(c.x - b.x) <= 2 && Math.abs(c.x + c.w - (b.x + b.w)) <= 2 && (Math.abs(c.y - (b.y + b.h)) <= unit.lineThick + 2 || Math.abs(b.y - (c.y + c.h)) <= unit.lineThick + 2));
  const holes = mergeHoles(rawHoles.filter((b) => !stackedCell(b) && !cellSet.includes(b) && !besideCell(b)), unit, onLineOrGrid);
  // 和弦字母的**内腔**也是洞（`D`/`G`/`B`/`A` 都有），不挡住就从这一路漏回来
  // ——检测框一并算「已被占」。
  // 判头那一路因「没有被围住的白」剔掉的块也算占着：剔它之前它就挡着按内腔找头的几路（是爱 p5 m67 符杠斜端与谱线夹出的尖白）
  const takenBoxes = [...heads.map((h) => h.box), ...harmonyMasks, ...notHollow.values()];
  // 带宽照 `HOLLOW_BAND`（±3 格）。扫过 ±1.5 / ±2 / ±3 格，三档一样
  // ——这一路的过检不在带边上。
  const barSegs = prims.vSegs.filter((q) =>
    staffGeoms.some((g) => Math.abs(Math.min(q.y0, q.y1) - g.topAt((q.x0 + q.x1) / 2)) < unit.space * 0.4 && Math.abs(Math.max(q.y0, q.y1) - g.bottomAt((q.x0 + q.x1) / 2)) < unit.space * 0.4),
  );
  const stacked: RasterSym[] = hollowHeadsFromHoles(nl, holes, unit, [...prims.vSegs, ...(prims.shortStems ?? [])], inBand, takenBoxes, barSegs, restStrokes);
  // 并成一个高内腔的叠置空心和弦：按音高位置逐一配模板（`notehead.ts::hollowHeadsByPitch`），
  // 模板拿本页已认出的空心头（骑线 / 在间各一张）
  // 靠加线才放进谱表带的头（`inBand` 给 x 那一档）不当模板样本：加线把圈切成几截，平均进去模板就糊了（望十架 p10 长笛 G5 全音符跟着丢）
  const ledgerOnly = (b: Rect) => !inBand(b.y + b.h / 2);
  const hollowSamples = [...heads.filter((h) => !ledgerOnly(h.box)).map((h) => ({ box: h.box, code: h.code })), ...stacked].filter((s0) => !(s0 as { weak?: boolean }).weak);
  const hollowMasks = buildHollowMasks(raster.bin, hollowSamples, unit, staffLines);
  // 本页空心头内腔的宽（格，下四分位）：手写体扫描件的二分头内腔窄到 0.7 格，叠头判据的宽度与内腔椭圆照它缩（`hollowHeadsByPitch`）
  const cavWs = holes
    .filter((h) => h.h <= unit.space && hollowSamples.some((s0) => s0.code !== "noteheadBlack" && h.x + h.w / 2 > s0.box.x && h.x + h.w / 2 < s0.box.x + s0.box.w && h.y + h.h / 2 > s0.box.y && h.y + h.h / 2 < s0.box.y + s0.box.h))
    .map((h) => h.w / unit.space)
    .sort((a, b) => a - b);
  // 只认明显窄的（是爱 0.63~0.75）：干净页的下四分位也有 0.93 上下的，开了这几条反伤（破碎干净版 p3、p8）
  const cavW = cavWs.length >= 8 && cavWs[cavWs.length >> 2] < CAV_NARROW ? cavWs[cavWs.length >> 2] : undefined;
  // 紧贴着一个实心头（盒正上方或正下方 0.7 格高的一条墨占六成以上）：同一根干上头型不会实空混用，
  // 挨着实心头的「空心头」才可能是符尾围出来的（那个实心头这时未必已认出）。叠成「8」字的三度空心和弦上下都是空心，不碍（晨曦破晓 m5 D4/F4）
  const besideSolid = (b: Rect) => {
    const B = raster.bin;
    const fillOf = (y0: number, y1: number) => {
      let k = 0, n = 0;
      for (let y = Math.round(y0); y < Math.round(y1); y++)
        for (let x = Math.round(b.x + b.w * 0.2); x < Math.round(b.x + b.w * 0.8); x++) {
          if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
          n++;
          k += B.data[y * B.w + x];
        }
      return n ? k / n : 0;
    };
    const hh = unit.space * 0.7;
    return Math.max(fillOf(b.y - hh, b.y), fillOf(b.y + b.h, b.y + b.h + hh)) >= 0.6;
  };
  stacked.push(...hollowHeadsByPitch(raster.bin, nl, rawHoles, holes, hollowMasks, unit, makePitchSteps(groups), prims.vSegs, inBand, takenBoxes, cavW).filter((h) => !(flagLoop(raster.bin, h.box, onLineOrGrid, unit.space) && besideSolid(h.box))));
  // 谱表外骑加线的斜缝空心头：沿加线逐位置配同一组模板（`notehead.ts::hollowHeadsOnLedgers`）
  // 竖段表里没有、靠墨柱判出来的干：只进 `SPage`（与 `stemSegs` 同理），`buildNotes` 定时值要它
  const inkStems: LineSeg[] = [];
  stacked.push(...hollowHeadsOnLedgers(raster.bin, nl, rawHoles, hollowMasks, unit, ledgerCandidates(raster.bin, groups), makePitchSteps(groups), prims.vSegs, takenBoxes, inkStems));
  // **压着实心头的「空心头」不要**：一个位置上头只有一种，盒里有一块实心头大小、几乎满墨的地方，那是真头，
  // 这块「内腔」是它与旁边的升号、谱线围出来的白（破碎 p8 m84 钢琴右手 C♯5，升号右竖与头之间读成二分 C5，把真头挤掉）
  // 内腔窄的手写粗圈页（`cavW`）上，两圈相接处也是一块实墨，夹在两个孔之间的不算（`solidInside` 的 `holes`）
  for (let i = stacked.length - 1; i >= 0; i--) if (solidInside(raster.bin, stacked[i].box, unit.space, cavW ? rawHoles : undefined)) stacked.splice(i, 1);

  // ── 几个实心符头并成一块：按**谱内自举的 mask** 拆开 ─────────────────────
  //
  // 钢琴谱里二度、三度的和弦把两三个符头画得挨着（二度还错开在符干两侧），
  // 位图上并成一块，单头的尺寸闸一律判否——逐谱行摊开，钢琴两行漏得最狠
  //（宁静 P4.1 漏 122、破碎 P6.1 漏 213）。判据与搜索都限死在块内，见 `headmask.ts`。
  const masks = buildHeadMasks(raster.bin, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, staffLines);
  // **拆和弦另用一张「符杠已擦」的图**，模板也在这张图上自举。
  //
  // 病因是量出来的（`scripts/raster-gap.mjs`）：漏掉的音里 **63.6% 焊在一团
  // 大于 4×3.2 格的墨里**——符杠 + 几根符干 + 几个头。在原图上给这种块打分，
  // 模板窗口上下那片「该有白」正压着符杠，spill 一扣分就没了。
  // 试过放松 spill（整体压到 0.5、或只算左右两侧）：**两次都把干净档打崩**
  //（85.09% → 78.63% / 75.71%），那一项正是拆块不出假头的关键，动不得。
  // 换图就两全：符杠不在图里，spill 照旧全额算。
  const noBeam = blobImage(nl, prims, unit, onGrid);
  const masksNB = buildHeadMasks(noBeam, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, staffLines);
  const pitchGrid = makePitchGrid(groups, unit);
  const onLineY = (y: number, x?: number) => grid.onLine(y, unit.space * 0.25, x);
  const split: RasterSym[] = [];
  /** 被并块拆分认领的块（拍号那一段要用：粗体 4/4 一整块常被拆成两个黑头）。 */
  const splitIds = new Set<number>();
  /** 已经被认成**单个**符头、但要作废的那些（块里其实装着两三个头）。 */
  const dropHead = new Set<number>();
  const restTpl = (look.templates ?? []).filter((t) => t.smufl === "restQuarter" || t.smufl === "rest8th");
  if (masks.length) {
    for (const c of blobs) {
      if (claimed.has(c.id)) continue;
      // **四分休止不拆**：窄高的折线块按休止模板配得上、又没有通高直竖笔（干）的，留给后面字典那一路收。
      // 拆块的模板是本页实心头自举的，样本一多一少，这种块就在「两个骑线头」与「拆不出」之间翻（破碎 p3 m17 三处）
      if (c.bbox.w < unit.space * 1.3 && c.bbox.h >= unit.space * 2.2) {
        const vr = longestVRun(raster.bin, c.bbox);
        // 去线图与修补图任一张配得上就算：休止压线的几笔去线时会被啃掉（主我敬拜你 m4、m16 去线图上差到 100、修补图 89，拆成两个黑头）
        const restLike = (img: Binary) => matchTemplate(binSig(img, c.bbox), c.bbox.w / unit.space, c.bbox.h / unit.space, restTpl)?.smufl === "restQuarter";
        if (!(vr >= c.bbox.h * 0.85 && vr >= unit.space * 2.5) && (restLike(nl) || restLike(repaired))) continue;
      }
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
    const isBar = (q: LineSeg) => staffGeoms.some((g) => Math.abs(Math.min(q.y0, q.y1) - g.topAt((q.x0 + q.x1) / 2)) < unit.space * 0.4 && Math.abs(Math.max(q.y0, q.y1) - g.bottomAt((q.x0 + q.x1) / 2)) < unit.space * 0.4);
    const probes = probeBareStems(prims.vSegs, headBoxes, free, unit, isBar);
    // 叠头和弦的短干（`prims.ts::cleanTail`）只在这里用：探出了头才并进竖段表（别处有它反倒抢了实心头墨柱那根干，是爱 p4 m55）
    const shortProbes = probeBareStems(prims.shortStems ?? [], headBoxes, free, unit, isBar, true).filter((q) => !probes.some((p) => p.ids.some((id) => q.ids.includes(id))));
    probes.push(...shortProbes);
    const halves = [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked].filter((q) => q.code === "noteheadHalf" && !(q as { weak?: boolean }).weak);
    const size = halves.length ? { w: median(halves.map((q) => q.box.w)), h: median(halves.map((q) => q.box.h)) } : { w: Math.round(unit.space * 1.3), h: Math.round(unit.space * 1.1) };
    for (const hd of headsOnBareStems(probes, unit, pitchGrid, size, raster.bin, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x))) {
      for (const id of hd.ids) claimed.add(id);
      stacked.push(hd);
      const sp = shortProbes.find((q) => q.ids.some((id) => hd.ids.includes(id)));
      if (sp && !prims.vSegs.includes(sp.stem)) prims.vSegs.push(sp.stem);
    }
    // 两根光杆干夹着一个头（两声部同音共用符头、干一上一下，头压线被切碎）
    // 判头那一路因「没有被围住的白」剔掉的块也算占着：剔它之前它挡着这一路，剔了就在符杠斜端与干之间配出假头（是爱 p5 m67）
    const known = [...headBoxes, ...stacked.map((q) => q.box), ...notHollow.values()];
    for (const hd of headsBetweenStemPairs(prims.vSegs, known, unit, pitchGrid, size, raster.bin, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x), isBar)) stacked.push(hd);
  }
  // **贴着小节线形竖段（`barSegs`）、又挂不成它的头的不要**：干在头左边只会朝下（头在竖段上端）、在右边只会朝上（头在下端），
  // 和弦中段的头另有一个头占着那一端。那一端没有头的，是小节线、谱线与延音线弧端围出的白格
  //（望十架 p8 m61 小节线后两道延音线收尾，按音高配出两个二分头、小节线当干，小节多两拍、后面四个四分被砍成八分）
  {
    const sp = unit.space;
    const atEndOf = (bar: LineSeg) => {
      const cx = (bar.x0 + bar.x1) / 2;
      return (b: Rect, left: boolean) => {
        const end = left ? Math.min(bar.y0, bar.y1) : Math.max(bar.y0, bar.y1);
        return Math.abs(b.y + b.h / 2 - end) <= sp * 0.6 && (left ? b.x + b.w / 2 > cx : b.x + b.w / 2 < cx) && Math.abs((left ? b.x : b.x + b.w) - cx) <= sp * 0.5;
      };
    };
    const lone = (b: Rect) => {
      const bar = barSegs.find((s0) => {
        const half = s0.maxLw / 2, cx = (s0.x0 + s0.x1) / 2;
        const cy = b.y + b.h / 2;
        if (Math.min(s0.y0, s0.y1) > cy || Math.max(s0.y0, s0.y1) < cy) return false;
        // 竖段在盒左缘或右缘附近（盒常压进竖段里半个线宽以上）
        return (cx + half >= b.x - 2 && cx <= b.x + sp * 0.4) || (cx - half <= b.x + b.w + 2 && cx >= b.x + b.w - sp * 0.4);
      });
      if (!bar) return false;
      // 竖墨伸出谱表半格以上的不是本行的小节线：干穿过和弦伸到谱表外（是爱 p3 m36 手写 B♭5/E5/C5 共干，C5 头贴在干中段）
      {
        const B = raster.bin;
        const cx = Math.round((bar.x0 + bar.x1) / 2);
        const ink = (y: number) => y >= 0 && y < B.h && [cx - 1, cx, cx + 1].some((x) => x >= 0 && x < B.w && !!B.data[y * B.w + x]);
        const reach = Math.round(sp * 0.6);
        let up = 0, dn = 0;
        while (up < reach && ink(Math.min(bar.y0, bar.y1) - unit.lineThick - 1 - up)) up++;
        while (dn < reach && ink(Math.max(bar.y0, bar.y1) + unit.lineThick + 1 + dn)) dn++;
        if (up >= reach || dn >= reach) return false;
      }
      const left = (bar.x0 + bar.x1) / 2 < b.x + b.w / 2;
      // 头自己另有一根干的不算：右缘朝上、或左缘朝下，干端落在头上（有一位神 m1 小节线后紧贴的 F4 二分，干在右缘）
      const cy = b.y + b.h / 2;
      const ownStem = prims.vSegs.some((v) => {
        if (v === bar) return false;
        const vx = (v.x0 + v.x1) / 2, top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
        if (bot - top < sp * 2) return false;
        if (Math.abs(vx - (b.x + b.w)) <= sp * 0.3 && Math.abs(bot - cy) <= sp * 0.6) return true;
        return Math.abs(vx - b.x) <= sp * 0.3 && Math.abs(top - cy) <= sp * 0.6 && Math.abs(vx - (bar.x0 + bar.x1) / 2) > 2;
      });
      if (ownStem) return false;
      const at = atEndOf(bar);
      return !at(b, left) && !takenBoxes.some((t) => at(t, left)) && !stacked.some((o) => o.box !== b && at(o.box, left));
    };
    for (let i = stacked.length - 1; i >= 0; i--) if (lone(stacked[i].box)) stacked.splice(i, 1);
  }
  // 弧与谱线围出的空当当成了空心头的内腔（`notehead.ts::archCavity`），剔掉，墨留给弧那一步；
  {
    const onStaffLine = (y: number, x?: number) => grid.onLine(y, unit.lineThick / 2, x);
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
    // **一截斜笔不是空心头**：弧穿过谱线、被符杠认去一截之后，剩下的一段斜笔（宽一格多、填充率正落在空心那一档）收成了二分头
    //（宁静的伯利恒 p5 m64 钢琴两行之间那条弧，读成 F3 全音符）。真空心头中间那几行是「墨-白-墨」两段；
    // 中段（谱线行不算）七成五以上的行只有一段墨、而墨从盒左右两边都穿出去的，是长笔画的一截
    const strokePiece = (h: { box: Rect }): boolean => {
      const b = h.box;
      // 笔画从盒里穿出去：去线图上盒左、盒右 0.4 格内都有墨（真头至多一侧挨着干、弧端）；
      // 只看紧挨着的一列不行，笔画斜穿谱线那几列被去线抹了，缺口正落在盒边（这一处 5 列）
      const reach = Math.max(2, Math.round(unit.space * 0.4));
      // 加线行：盒里一段墨横贯九成以上（骑加线的二分头，加线伸出盒两侧、那几行又只有一段墨，以马内利来临歌 m16、m22 两个头被剔了）
      const ledgerRow = (y: number) => {
        if (y < 0 || y >= raster.bin.h) return false;
        let run = 0, best = 0;
        for (let x = Math.max(0, b.x); x < Math.min(raster.bin.w, b.x + b.w); x++) (run = raster.bin.data[y * raster.bin.w + x] ? run + 1 : 0), (best = Math.max(best, run));
        return best >= b.w * 0.9;
      };
      const sideInk = (x0: number, dir: number) => {
        for (let k = 0; k < reach; k++) {
          const x = x0 + dir * k;
          if (x < 0 || x >= nl.w) return false;
          for (let y = Math.max(0, b.y - 3); y < Math.min(nl.h, b.y + b.h + 3); y++) if (nl.data[y * nl.w + x] && !ledgerRow(y)) return true;
        }
        return false;
      };
      if (!sideInk(b.x - 1, -1) || !sideInk(b.x + b.w, 1)) return false;
      // 挨着竖段（干）的是真头：一截斜笔不带干（以马内利来临歌 m22 B3 挂在加线下、圈左下角断开，量不出内腔）
      const tolX = Math.max(3, unit.lineThick * 2);
      if (prims.vSegs.some((v) => { const vx = (v.x0 + v.x1) / 2; return vx >= b.x - tolX && vx <= b.x + b.w + tolX && Math.min(v.y0, v.y1) <= b.y + b.h && Math.max(v.y0, v.y1) >= b.y; })) return false;
      // 盒里有被墨围住的白（内腔，从盒边灌不进去）的是真头：斜缝内腔的空心头挂在加线下，前两条都会命中（以马内利来临歌 m22 B3）
      // 盒常偏在头的一边（只框住半个圈，内腔从盒边漏出去），量内腔时左右各外放 0.3 格、上下 0.2 格
      {
        const px = Math.round(unit.space * 0.3), py = Math.round(unit.space * 0.2);
        const bx = b.x - px, by = b.y - py;
        const W = b.w + px * 2, H = b.h + py * 2, seen = new Uint8Array(W * H);
        const white = (i: number) => {
          const x = bx + (i % W), y = by + ((i / W) | 0);
          return x >= 0 && y >= 0 && x < raster.bin.w && y < raster.bin.h && !raster.bin.data[y * raster.bin.w + x];
        };
        const stack: number[] = [];
        for (let i = 0; i < W * H; i++) {
          const x = i % W, y = (i / W) | 0;
          if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && white(i)) (seen[i] = 1), stack.push(i);
        }
        while (stack.length) {
          const i = stack.pop()!;
          const x = i % W, y = (i / W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (!seen[j] && white(j)) (seen[j] = 1), stack.push(j);
          }
        }
        let enclosed = 0;
        for (let i = 0; i < W * H; i++) if (!seen[i] && white(i)) enclosed++;
        if (enclosed >= 3) return false;
      }
      let rows = 0, single = 0;
      for (let y = Math.round(b.y + b.h * 0.2); y <= Math.round(b.y + b.h * 0.8); y++) {
        if (onStaffLine(y, b.x + b.w / 2) || y < 0 || y >= raster.bin.h || ledgerRow(y)) continue;
        let runs = 0, prev = false;
        for (let x = Math.max(0, b.x); x < Math.min(raster.bin.w, b.x + b.w); x++) {
          const on = !!raster.bin.data[y * raster.bin.w + x];
          if (on && !prev) runs++;
          prev = on;
        }
        if (!runs) continue;
        rows++;
        if (runs === 1) single++;
      }
      return rows >= 3 && single >= rows * 0.75;
    };
    for (const h of heads) if (!dropHead.has(h.comp.id) && (fake(h) || (h.code === "noteheadHalf" && strokePiece(h)))) dropHead.add(h.comp.id);
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
    const onLine = (y: number, x?: number) => grid.onLine(y, unit.lineThick, x);
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
          if (onLine(y, cx)) continue;
          rows++;
          if (ink(Math.round(cx - bw / 2 - unit.space * 0.35), y) || ink(Math.round(cx + bw / 2 + unit.space * 0.35), y)) side++;
        }
        if (!rows || side > rows * 0.2) continue;
        // 头心按去线图上那团实墨的上下沿定：空心头离实心头不一定正好一格，照「空心头心 ± 一格」出盒，
        // 头心常落在两级之间、吸到哪一级凭运气（信心使我得胜 m15 低音 B♭2，下面符尾弯钩围出的假空心头，读成 C3）
        const x0 = Math.round(cx - bw * 0.3), x1 = Math.round(cx + bw * 0.3);
        const solidRow = (y: number) => {
          if (y < 0 || y >= nl.h) return false;
          let k = 0;
          for (let x = Math.max(0, x0); x <= Math.min(nl.w - 1, x1); x++) k += nl.data[y * nl.w + x];
          return k >= (x1 - x0 + 1) * 0.6;
        };
        let ya = Math.round(ny), yb = ya;
        if (solidRow(ya)) {
          while (solidRow(ya - 1) && ny - (ya - 1) <= bh) ya--;
          while (solidRow(yb + 1) && yb + 1 - ny <= bh) yb++;
        }
        const hy = solidRow(Math.round(ny)) ? (ya + yb) / 2 : ny;
        split.push({ box: { x: Math.round(cx - bw / 2), y: Math.round(hy - bh / 2), w: Math.round(bw), h: Math.round(bh) }, code: "noteheadBlack" });
      }
    }
  }
  const syms: RasterSym[] = [
    ...heads.filter((h) => !dropHead.has(h.comp.id)).map((h) => ({ box: h.box, code: h.code, ...(ledgerOnly(h.box) ? { noSample: true, weak: true } : {}) })),
    ...stacked,
    ...split,
    ...restSyms,
  ];
  for (const h of heads) ledger.claim(h.box, `head:${h.code}`);
  for (const s0 of stacked) ledger.claim(s0.box, `stack:${s0.code}`);
  for (const s0 of split) ledger.claim(s0.box, "cluster:noteheadBlack");
  for (const s0 of restSyms) ledger.claim(s0.box, "rest:restHBar");
  const dictClaimed = new Set<number>();
  /** 字典认成整/半休止、却没过位置闸的扁块（见下）。 */
  const flatPieces = new Set<number>();
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
    // **波浪线是横着走的**：认成 `wiggle*` 的细竖条（宽不过 `WIGGLE_THIN` 格）是被抽剩下的竖笔（破碎 p2 m6 低音 E♭3 前降号那一竖，3×36 像素），
    // 不留给它，降号那几路才能把竖笔并回肚子上。宽的竖向折线照旧（当我们回到天家 0.8×2 格那几块，放开就伤四步）
    if (code.startsWith("wiggle") && c.bbox.h > c.bbox.w && c.bbox.w <= unit.space * WIGGLE_THIN) continue;
    if (code.startsWith("metNote")) metIds.add(c.id);
    if (code.startsWith("artic") && !groups.some((g) => c.bbox.y + c.bbox.h > g.lines[0].y - unit.space * ARTIC_REACH && c.bbox.y < g.lines[4].y + unit.space * ARTIC_REACH)) continue; // 不记账：留给歌词
    // **半/全休止要按位置验一道**：它的字形是个 1.27×0.51 格的小实心矩形，
    // 位图上这种碎块一大把（符杠断头、粗横笔的一截），实测宁静一首认出 43 个
    // 全部被采纳，而谱面上根本没那么多。它有一条硬位置：
    // 半休止**坐在中线上**、全休止**吊在上面一线下**——不贴着这两条线的不是它。
    dictClaimed.add(c.id);
    // 没过位置闸的另记一笔：骑加线的实心头被抽加线切成上下两片扁块，正像这种矩形，要放给后面碎块并回那一路（父恩广大 m2 男高 C4）。
    // 只放给那一路：别的几路照旧当已认领（全放开的话有一位神歌词 −1）
    if (isBarRest(code) && (!nearRestLine(c.bbox, staffLines, unit) || besideStem(c.bbox))) {
      flatPieces.add(c.id);
      continue;
    }
    syms.push({ box: c.bbox, code });
    ledger.claim(c.bbox, `dict:${code}`);
  }
  // ── **并排粘成一块的两个临时记号**：按竖笔之间的缝切开，两半各查一次字典 ─────────
  //
  // 和弦前竖排的「♭♯」挨得紧，♭ 的肚子贴着 ♯ 的竖笔连成一块（破碎 p4 m39、p12 m99 钢琴右手 C4/E♭4/F♯4/A4），
  // 整块字典查不出，♭ 的空肚子又被按内腔收成一个全音符。块里有三组以上通高竖笔（♭ 一根、♯ 两根）、
  // 高宽像两个临时记号并排的，在相邻两组竖笔之间逐个缝试切，两半都查得出临时记号才收；压在上面的头去掉
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id)) continue;
    let b = c.bbox;
    if (b.w > unit.space * ACC_PAIR_W || b.h < unit.space * 1.8 || b.h > unit.space * 3.6) continue;
    // ♭ 的竖笔被抽成竖段、不在块里（p4 m39）：去线图上块左边半格内紧贴着一根通高竖笔的，把块扩过去
    {
      const y0 = Math.max(0, Math.round(b.y - unit.space * 0.6)), y1 = Math.min(nl.h - 1, Math.round(b.y + b.h + unit.space * 0.3));
      for (let x = b.x - 1; x >= Math.max(0, b.x - unit.space * 0.5); x--) {
        let run = 0, best = 0, top = y1;
        for (let y = y0; y <= y1; y++) {
          run = nl.data[y * nl.w + x] ? run + 1 : 0;
          if (run > best) (best = run), (top = y - run + 1);
        }
        if (best < b.h * 0.8) continue;
        b = { x, y: Math.min(b.y, top), w: b.x + b.w - x, h: Math.max(b.y + b.h, top + best) - Math.min(b.y, top) };
        break;
      }
    }
    const cols: [number, number][] = [];
    for (let x = b.x; x < b.x + b.w; x++) {
      let run = 0, best = 0;
      for (let y = b.y; y < b.y + b.h; y++) (run = nl.data[y * nl.w + x] ? run + 1 : 0), (best = Math.max(best, run));
      if (best < b.h * 0.55) continue;
      const last = cols[cols.length - 1];
      if (last && x - last[1] <= 1) last[1] = x;
      else cols.push([x, x]);
    }
    if (cols.length < 3) continue;
    let done = false;
    for (let k = 1; k < cols.length && !done; k++) {
      for (let cut = cols[k - 1][1] + 1; cut <= cols[k][0] && !done; cut++) {
        const L = shrinkBox(nl, { x: b.x, y: b.y, w: cut - b.x, h: b.h });
        const R = shrinkBox(nl, { x: cut, y: b.y, w: b.x + b.w - cut, h: b.h });
        if (!L || !R) continue;
        const cl = look.lookup(binSig(nl, L), L.w / unit.space, L.h / unit.space);
        const cr = look.lookup(binSig(nl, R), R.w / unit.space, R.h / unit.space);
        if (!cl || !cr || !isAccidental(cl) || !isAccidental(cr)) continue;
        for (let i = syms.length - 1; i >= 0; i--) if (/^notehead/.test(syms[i].code) && overlapFrac(syms[i].box, b) > 0.5) syms.splice(i, 1);
        syms.push({ box: L, code: cl }, { box: R, code: cr });
        ledger.claim(L, `accpair:${cl}`);
        ledger.claim(R, `accpair:${cr}`);
        dictClaimed.add(c.id);
        done = true;
      }
    }
  }

  // **谱号兜底**：字典查不到的谱行，按位置补一个。
  //
  // 谱号是音高的基准，缺一行整行的音高就错；而它还是 `buildScore` 连跨系统谱行的
  // 主要凭据（`StaffToken` 的第一项就是行首谱号），缺了那一行会另起一个声部，
  // 一个声部因此碎成好几条——实测宁静一首 GT 5 条谱表、识别出 9 条，
  // 六成的音落在没配上的那几条里，准确率逐段漂到 0。
  // 字典能查到 85/100 行，位置自举能到 91/100，两者并起来才够。
  // 自举只看行首（谱号、调号）：弯、斜的谱行取行首往右两格处的线位
  const bootStaves: BootStaff[] = groups.map((g) => {
    const left = Math.max(...g.lines.map((l) => l.left));
    return { left, right: Math.min(...g.lines.map((l) => l.right)), lineYs: g.lines.map((l) => lineYAt(l, left + unit.space * 2)) };
  });
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
    // 行首窗口：弯、斜的谱行取左缘往右两格处的线位
    const top = yAt(g, 0, left + sp * 2);
    const bot = yAt(g, 4, left + sp * 2);
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
    const base = pastSysLine(bin0, g.lines.map((l) => lineYAt(l, left)), left, sp);
    const xa = Math.max(0, Math.round(base + sp * CLEF_INK_X[0]));
    const xb = Math.min(bin0.w - 1, Math.round(base + sp * CLEF_INK_X[1]));
    // 行首这一段的线位按实测（斜页上与整行平均差得出半格）
    const ys = localLineModel(bin0, g.lines, left, Math.min(bin0.w - 1, left + sp * 12), unit)((xa + xb) / 2);
    const rowInk = (y: number) => rowHasInk(bin0, y, xa, xb);
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
    const bot0 = localLineModel(bin0, g.lines, left, Math.min(bin0.w - 1, left + sp * 12), unit)((xa + xb) / 2)[4];
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
    const rowInk = (y: number) => rowHasInk(bin0, y, xa, xb);
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
      const bx = b.x + b.w / 2;
      const g = groups.find((q) => cy > yAt(q, 0, bx) - sp && cy < yAt(q, 4, bx) + sp);
      if (!g) continue;
      if (b.x < Math.max(...g.lines.map((l) => l.left)) + sp * MID_CLEF_FROM) continue;
      const w = b.w / sp;
      const h = b.h / sp;
      // 位置也要像：高音谱号上下都探出谱表（尾巴探到末线下 0.7 格以外，八分和弦的头只到半格）；低音谱号落在谱表里、顶端贴着首线
      //（加线上的两个头连着干和尾，签名离高音谱号也近：你的信实广大 m?，整个在谱表上方）
      const top = yAt(g, 0, bx);
      const bot = yAt(g, 4, bx);
      const fShape = w >= 1.2 && w <= 2.0 && h >= 2.0 && h <= 3.0 && Math.abs(b.y - top) <= sp * 0.5 && b.y + b.h <= bot + sp * 0.5;
      const gShape = w >= 1.3 && w <= 2.4 && h >= 3.6 && h <= 5.8 && b.y <= top - sp * MID_CLEF_G_TOP && b.y + b.h >= bot + sp * 0.7;
      if (!fShape && !gShape) continue;
      // 高音谱号是细笔画：横向连着一格以上墨的行不过两成。叠置的实心和弦带干，宽高、签名、墨占比都像（是爱 p3 m32 B♭4/D5/F5 读成行中高音谱号）
      if (gShape) {
        let wide = 0;
        for (let y = b.y; y < b.y + b.h; y++) {
          let run = 0, best = 0;
          for (let x = b.x; x < b.x + b.w; x++) best = Math.max(best, (run = nl.data[y * nl.w + x] ? run + 1 : 0));
          if (best >= sp) wide++;
        }
        if (wide > b.h * 0.2) continue;
      }
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
      const rowInk = (y: number) => rowHasInk(bin0, y, b.x - 1, b.x + b.w);
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
      // 符头不会压着波浪线：横向三成以上叠在线上的头是小节线与波浪线之间的白读成的空心头（是爱 p3 m32 两个）
      else if (/^notehead/.test(syms[i].code) && cy0 >= b.y && cy0 <= b.y + b.h && Math.min(s0.x + s0.w, b.x + b.w) - Math.max(s0.x, b.x) >= s0.w * 0.3) syms.splice(i, 1);
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
      return c ? sharpsByStrokes(raster.bin, g.lines.map((l) => lineYAt(l, c.box.x + c.box.w + unit.space)), c.box, unit.space) : [];
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
  const unmatched = blobs.filter((c) => !claimed.has(c.id) && (!dictClaimed.has(c.id) || flatPieces.has(c.id)));
  const merged = new Set<number>();
  /** 并出来的盒按 `img` 再查一次；查得到、过了位置闸才认 */
  const tryMerged = (box: Rect, group: number[], img: Binary): boolean => {
    // 已经认出来的符号压着的不再并（被谱线切开的八分休止，球那一块认过了、斜笔那块还剩着）
    if (syms.some((q) => overlapFrac(q.box, box) > 0.3)) return false;
    // 字典认不出就**按性质判一次符头**：空心符头骑在谱线上时会被去谱线切成两截，
    // 两截都不成符头、字典里也没有二分符头的类（见 `judgeHeadBox`）。
    const code = look.lookup(binSig(img, box), box.w / unit.space, box.h / unit.space) ?? judgeHeadBox(img, box, unit, prims.vSegs, inBand);
    if (!code) return false;
    // 全 / 二分休止只贴在一条线的一侧，不会被谱线切开：修补图上连成一块的是休止挨着别的墨（主我敬拜你 m3 多出一个全休止）
    if (img === repaired && isBarRest(code)) return false;
    // 位置闸与字典那一路一样：并出来的扁块也要贴着第二、三线
    if (isBarRest(code) && (!nearRestLine(box, staffLines, unit) || besideStem(box))) return false;
    if (code === "noteheadBlack" && beamStump(box, syms.filter((s0) => /^notehead/.test(s0.code)).map((s0) => s0.box))) return false;
    // 并出来的空心头要有**封闭的内腔**（在去线图 / 修补图上量，谱线不算圈）：全音符下沿与谱线之间的空当也像个腔，谱线一去就通到外面了
    //（我灵镇静 m8 加一线上 C4 全音符底下拼出一个 A3）。窗口只外扩 2 像素，别把上面那个全音符自己的内腔框进来
    // 全音符同理（贴着谱线的一小段弧，修补后整块像个扁圆，破碎扫描版 p1 m2）
    if ((code === "noteheadHalf" || code === "noteheadWhole") && enclosedWhite(img, { left: box.x, right: box.x + box.w, top: box.y, bottom: box.y + box.h }, unit.space, 2) < box.w * box.h * MERGE_HOLLOW_CAVITY) return false;
    for (const id of group) merged.add(id);
    syms.push({ box, code });
    ledger.claim(box, `merge:${code}`);
    return true;
  };
  // 先按**修补图**并：修补图上连成一块、碎块全没认出来的，整块在修补图上查（被谱线切开的符号）
  {
    const free = new Set(unmatched.map((c) => c.id));
    for (const rb of rBlobs) {
      const ids = [...(rBlobParts.get(rb.id) ?? [])];
      if (ids.length < 2 || !ids.every((id) => free.has(id) && !merged.has(id))) continue;
      tryMerged(rb.bbox, ids, repaired);
    }
  }
  // 修补图没连上的（被竖笔、横段抽取切开的）：把**x 上重叠、上下又贴着**的未识别块并起来（谱线间距的四成以内算贴着）
  for (const a of unmatched) {
    if (merged.has(a.id)) continue;
    let box = { ...a.bbox };
    const group = [a.id];
    for (let again = true; again; ) {
      again = false;
      for (const b of unmatched) {
        if (group.includes(b.id) || merged.has(b.id)) continue;
        const r = b.bbox;
        // x 不重叠的不并；只差一像素的算相接（破碎 p2 m6 降号的竖笔与肚子被去线切开，竖笔右缘与肚子左缘隔一列）
        if (r.x > box.x + box.w + 1 || r.x + r.w < box.x - 1) continue;
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
    tryMerged(box, group, nl);
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
  const usedSegs = new Set<LineSeg>(restStrokes);
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
      // 端点离头缘差一两像素也算扎进去（破碎 p4 m32 D4 十六分：干下端停在头上沿外 1 像素，干 + 两道尾读成还原号）
      const tl = Math.max(1, unit.lineThick);
      const tl2 = tl * 2;
      if (syms.some((h) => h.code === "noteheadBlack" && vx >= h.box.x - tl && vx <= h.box.x + h.box.w + tl && ((vBot >= h.box.y - tl2 && vBot <= h.box.y + h.box.h) || (vTop >= h.box.y && vTop <= h.box.y + h.box.h + tl2)))) continue;
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
    if (merged.has(c.id)) continue;
    // 那道竖笔与旁边音的干挨着、被抽成了同一根竖段（一端扎进头，上面当符干跳过了）：在去线图上取块左边紧贴的那一列自己的竖墨，
    // 并进来查字典，只认字典查得出的（破碎 p12 m100 钢琴右手 B♮3，还原号左竖离前一个十六分的干一两像素）
    for (let x = b.x + 2; x >= b.x - unit.space * 0.3; x--) {
      let run = 0, best = 0, top = 0;
      for (let y = Math.max(0, Math.round(b.y - unit.space)); y <= Math.min(nl.h - 1, b.y + b.h + unit.space); y++) {
        run = nl.data[y * nl.w + x] ? run + 1 : 0;
        if (run > best) (best = run), (top = y - run + 1);
      }
      // 要从块里往上或往下伸出块外三成格以上：块里本来就有的那几列不算
      if (best < b.h * 0.8 || top > b.y + b.h || top + best < b.y || (top > b.y - unit.space * 0.3 && top + best < b.y + b.h + unit.space * 0.3)) continue;
      // 降号、还原号的左竖只从块往上伸；往下越过块底的是穿过去的干，块是空心头的圈（齐来谢主歌 m17 低音 G2 二分）
      if (top + best > b.y + b.h + unit.space * 0.3) break;
      const y0 = Math.min(b.y, top);
      const bx0 = Math.min(x, b.x);
      const box = { x: bx0, y: y0, w: b.x + b.w - bx0, h: Math.max(b.y + b.h, top + best) - y0 };
      const w1 = box.w / unit.space;
      const h1 = box.h / unit.space;
      if (w1 < 0.4 || w1 > 1.7 || h1 < 1.5 || h1 > 3.6) break;
      const code = look.lookup(binSig(nl, box), w1, h1);
      // 并出来的盒压着已认的头：那一列是头的边、块是头的碎片，不是还原号（齐来谢主歌 m17 低音 G2）
      if (syms.some((h) => /^notehead/.test(h.code) && overlapFrac(h.box, box) > 0.3)) break;
      if (code && isAccidental(code)) {
        syms.push({ box, code });
        ledger.claim(box, `accid:${code}`);
        merged.add(c.id);
      }
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
  /** 在线时逐列现读（只读头一趟、谱号列以外的那几条，与离线缓存收的条一致）；第二趟只查已读的 */
  const timeOcr = opts.timeOcr ?? (live?.time ? new Map<string, string>() : undefined);
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
    // 拍号在行首那一小段：弯、斜的谱行取行首往右四格处的线位
    const ax = left + unit.space * 4;
    const mid = lineYAt(g.lines[2], ax);
    const top = lineYAt(g.lines[0], ax);
    const bottom = lineYAt(g.lines[4], ax);
    // 行首那一段：谱号 + 调号之后、第一个音符之前。放到十四格——
    // 七个升降号的调号就占了八格多。
    // **字典认走的也进来**（谱号与调号升降号除外）：C 拍号与字典里那个
    // `csymParensRightTall`（大括号）形状相近，认错了照样要能被拍号盖过。
    const cands = blobs.filter((c) => {
      const b = c.bbox;
      // 并块拆分认领的块第一趟就进来：4/4 两个数字连成一块，被拆成两个黑头（齐来崇拜第一行：本页头模板一变就拆了）。
      // 数字那一路按位置切上下两半、各配模板，真的两个叠头配不上数字
      // 第二趟按已认出的 C 拍号找时，被当成休止认领的块也进来：粗体 C 常被认成四分休止（S253 钢琴两行）
      const cFound = timeFound.some((t) => t.codes === "timeSigCommon" || t.codes === "timeSigCutCommon");
      if ((claimed.has(c.id) && !(pass === 1 && (!restIds.has(c.id) || cFound) && !harmonyIds.has(c.id) && !titleIds.has(c.id)) && !splitIds.has(c.id)) || merged.has(c.id)) return false;
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
    // 本页已认出过拍号的，与它竖直对齐（1.5 格内）的列先试：同一系统各行的拍号上下对齐，行首调号的碎块聚成的列在它左边，
    // 按从左到右先试会先撞上（新编 f03 低音行四个降号的碎块撑满谱表，OCR 读成 7/2，后面对齐的 4/4 没轮到，整首拍号读错）
    if (timeFound.length) {
      const aligned = (c: (typeof cols)[number]) => (timeFound.some((t) => Math.abs(t.x - c.box.x) <= unit.space * 1.5) ? 1 : 0);
      cols.sort((a, b) => aligned(b) - aligned(a) || a.box.x - b.box.x);
    }
    /** 这一段 x 上的墨是不是「上下正好撑满谱表」：顶到第五线、底到第一线，又不探出谱表（带干的和弦、谱号都探出去）。 */
    const fillsStaff = (b: Rect): boolean => {
      const xa = Math.max(0, Math.round(b.x)), xb = Math.min(nl.w, Math.round(b.x + b.w));
      const ya = Math.max(0, Math.round(top - unit.space * 1.5)), yb = Math.min(nl.h, Math.round(bottom + unit.space * 1.5));
      // 只量**与中线连着的那一段**墨：去线留下的缝（一个线宽加两像素）算连着，隔开更远的不算——
      // 拍号正上方挨着速度术语（美哉主耶稣「Moderately」压在 12/8 上方不到一格），一并量进来就判成探出谱表
      const inkRow = (y: number) => {
        let n = 0;
        for (let x = xa; x < xb; x++) if (nl.data[y * nl.w + x]) n++;
        return n >= 2;
      };
      // 内侧三条线那几行（按 x 取线位）不算缝：去线的缝正落在线上，宽度跟着去线的口径走，只容「线宽 + 2」时
      // 线宽量成 3 的页上两个数字在中线处就断开（新编 257 低音行 2/2，整首拍号读成 2/4）。
      // 外线不放：跨过外线就连上谱表外的墨，判成探出谱表（353 首行 4/4 没了）
      const gapMax = Math.ceil(unit.lineThick) + 2;
      const lys = g.lines.slice(1, 4).map((l) => lineYAt(l, b.x + b.w / 2));
      const lineRow = (y: number) => lys.some((ly) => Math.abs(ly - y) <= unit.lineThick + 1);
      const walk = (from: number, step: 1 | -1, end: number) => {
        let last = -1;
        for (let y = from, gap = 0; step > 0 ? y < end : y >= end; y += step) {
          if (inkRow(y)) (last = y), (gap = 0);
          else if (lineRow(y)) continue;
          else if (last >= 0 && ++gap > gapMax) break;
        }
        return last;
      };
      const m0 = Math.round(mid);
      const lo = walk(m0, -1, ya), hi = walk(m0, 1, yb);
      if (lo < 0 || hi < 0) return false;
      return lo >= top - unit.space * 0.4 && hi <= bottom + unit.space * 0.4 && lo <= top + unit.space * 0.6 && hi >= bottom - unit.space * 0.6;
    };
    for (const col of cols) {
      const box = col.box;
      // 两位数的分子（12/8）一列宽近三格：放到 `TIME_WIDE` 格，但超过 2.5 格的只认 OCR 读出两位数分子的（美哉主耶稣 12/8 宽 2.87 格，
      // 整页没认出拍号、数字的笔画被补成符头）
      const wide = box.w > unit.space * 2.5;
      if (box.w > unit.space * TIME_WIDE || box.w < unit.space * 0.8) continue;
      // 距离上限比通用的 `TEMPLATE_DIST`（90）松：拍号被**五条谱线横穿**，
      // 去线在它身上切了好几道口子，退化比谱号重（实测宁静那个 4/4 上下两半
      // 到 `timeSig4` 是 104 与 95，破碎那个 C 到 `timeSigCommon` 是 168）。
      // 松得起，是因为位置先验很硬：行首那一列、骑在中线上、高约两格或四格。
      const tpl = look.templates ?? [];
      const hits: RasterSym[] = [];
      let fromOcr = false;
      if (box.h < unit.space * 3) {
        if (col.ink || wide) continue;
        // **C 拍号**（`timeSigCommon` / `timeSigCutCommon`）是一个块、骑在中线上
        if (Math.abs(box.y + box.h / 2 - mid) > unit.space * 0.8) continue;

        const whole = box.h >= unit.space * 1.8 && wholes.some((w) => w.x >= box.x - 1 && w.x + w.w <= box.x + box.w + 1 && w.y >= box.y - 1 && w.y + w.h <= box.y + box.h + 1);
        // 放宽时只在 C 模板里挑：别的模板（和弦字母、休止）在宽上限下反倒更近
        const cTpl = tpl.filter((t) => t.smufl === "timeSigCommon" || t.smufl === "timeSigCutCommon");
        let m = whole ? matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, cTpl, TIME_C_WHOLE_DIST) : matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, tpl, TIME_TEMPLATE_DIST);
        // 衬线粗体的 C（球形笔端，哈利路亚哈利路亚 S253）离 C 模板 259，过不了闸；可所有模板里最近的就是它。
        // 紧骑中线（0.3 格内）、高约两格的，最近的是 C 又在 `TIME_C_LOOSE` 以内就认
        if (!m && Math.abs(box.y + box.h / 2 - mid) <= unit.space * 0.3 && box.h >= unit.space * 1.6 && box.h <= unit.space * 2.6) {
          const near = matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, tpl, TIME_C_LOOSE);
          if (near && (near.smufl === "timeSigCommon" || near.smufl === "timeSigCutCommon")) m = near;
        }
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
        // 压线笔画补回的那条（`timeStripOf` 的 `raw`）只给下面「模板认出一对、OCR 只读出一半」那一步兜底：去线条读不出的
        //（「9」读成「0」、「6」「3」读空）问它。不让它单独成对采信——行首的和弦列补了线也读得成一对数字（373 低音行读出 5/2），
        // 补线还会把「3」左侧压线的开口封上、读成「8」（万口欢唱 3/2）
        const reach = Math.ceil(unit.lineThick) + 2;
        const sUp = timeStripOf(nl, up, groups.indexOf(g), "num");
        const sDn = timeStripOf(nl, dn, groups.indexOf(g), "den");
        const fUp = timeStripOf(nl, up, groups.indexOf(g), "num", raster.bin, reach);
        const fDn = timeStripOf(nl, dn, groups.indexOf(g), "den", raster.bin, reach);
        if (pass === 0 && !inClef && !opts.timeOcr && live?.time && timeOcr) for (const [k, v] of await live.time([sUp, sDn, fUp, fDn])) timeOcr.set(k, v);
        // 分子 3 与 8 OCR 分不开（低清图上 3 左侧的开口被糊墨封上读成 8），按有没有封闭孔定（`closedHoles`）
        const ocrNum = inClef ? null : timeDigit(timeOcr?.get(timeKey(sUp)), "num");
        let oNum = ocrNum === 3 || ocrNum === 8 ? (closedHoles(sUp) > 0 ? 8 : 3) : ocrNum;
        // 两位数分子 OCR 读成「1?」却不是合法拍号（美哉主耶稣的 12 读成 19：低清的 2 像 9）：右半个数字按模板在 0、2、5、6 里认
        const rawNum = timeOcr?.get(timeKey(sUp));
        if (wide && oNum === null && !inClef && rawNum && /^1\d$/.test(rawNum)) {
          const d = digitOf({ x: Math.round(up.x + up.w / 2), y: up.y, w: Math.round(up.w / 2), h: up.h }, [0, 2, 5, 6], TIME_NUM_DIST);
          if (d) oNum = timeDigit(String(10 + timeSigDigit(d.code)), "num");
        }
        const oDen = inClef ? null : timeDigit(timeOcr?.get(timeKey(sDn)), "den");
        const fNum = inClef ? null : oNum ?? timeDigit(timeOcr?.get(timeKey(fUp)), "num");
        const fDen = inClef ? null : oDen ?? timeDigit(timeOcr?.get(timeKey(fDn)), "den");
        if (pass === 0 && !inClef) {
          timeStrips.push(sUp, sDn, fUp, fDn);
          timeCols.push({ box, mid, num: oNum, den: oDen });
        }
        if (wide && !(oNum !== null && oNum >= 10 && oDen !== null)) continue;
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
        if (hits.length === 2 && fNum !== null && fNum < 10) hits[0] = { box: hits[0].box, code: `timeSig${fNum}` as SmuflName };
        if (hits.length === 2 && fDen !== null && fDen < 10) hits[1] = { box: hits[1].box, code: `timeSig${fDen}` as SmuflName };
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
      // 拍号**盖过字典**（与谱号同一条）：落在它盒里的字典结果作废，那是被切开的碎块。
      // 符头按**中心**落在盒里算：「4」下半的三角内腔按孔补成空心头，头盒按头的个头摆、探出拍号盒底（一婴孩为我们降生 男声 m1 多出一个二分音符）
      for (let k = syms.length - 1; k >= 0; k--) {
        const s0 = syms[k].box;
        const cx = s0.x + s0.w / 2, cy = s0.y + s0.h / 2;
        const headIn = syms[k].code.startsWith("notehead") && cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
        if (headIn || (s0.x >= box.x - 1 && s0.x + s0.w <= box.x + box.w + 1 && s0.y >= box.y - 1 && s0.y + s0.h <= box.y + box.h + 1)) syms.splice(k, 1);
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
    // 调号区在行首：弯、斜的谱行取左缘往右四格处的线位
    const top = yAt(g, 0, left + unit.space * 4);
    const bottom = yAt(g, 4, left + unit.space * 4);
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
    const kx = Math.max(...g.lines.map((l) => l.left)) + unit.space * 4;
    const top = yAt(g, 0, kx);
    const bottom = yAt(g, 4, kx);
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < bottom && s0.box.y + s0.box.h > top && s0.box.x < kx);
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
      // **骑在谱线上的八分休止**：球在一间、斜笔在下一间，中间压着的那条线去掉后只剩细笔连着，墨占比掉到 0.3 以下
      //（信心使我得胜 m18 女高、男高共用的那枚，0.29）。盒中段压着一条谱线的，墨占比下限放到拼块那一档
      // 这一档还要够宽（≥1 格，真休止 1.14）：窄的是干带尾的一截（新编赞美诗 f37 m12，0.87 格）
      const straddle = b.w >= unit.space && staffLines.some((l) => l.y > b.y + b.h * 0.3 && l.y < b.y + b.h * 0.7);
      const rs = rm ?? (!straight && (isEighthRest(nl, b, c.area, unit) || (straddle && isEighthRest(nl, b, c.area, unit, undefined, EIGHTH_REST_FILL_PIECES))) ? { smufl: "rest8th" as SmuflName } : null);
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
      // 块的另一端顺着干连到一个已认出的头、摘出的头又没有和弦伙伴：这块是那个头的干（+ 尾），摘出来的是干尖的符尾
      //（宁静的伯利恒 p2 m22 男声 A3 八分朝下的干，头单独成块先认了，干抽成竖段，剩下的符尾块在尾尖摘出一个 B2）。
      // 那个头也可能是这一轮刚从「头 + 干」块里摘出的，所以 `stemHeads` 也要查
      if (!r.extra.length) {
        const headTop = r.head.y + r.head.h / 2 < b.y + b.h / 2;
        const dir = headTop ? 1 : -1;
        const far = Math.round(headTop ? b.y + b.h : b.y);
        const tol = unit.space * 0.3;
        const B = raster.bin;
        const inkAt = (y: number) => [-1, 0, 1].some((d) => {
          const x = Math.round(r!.stemX) + d;
          return x >= 0 && x < B.w && y >= 0 && y < B.h && !!B.data[y * B.w + x];
        });
        let y = far;
        while (inkAt(y + dir) && Math.abs(y - far) < unit.space * 5) y += dir;
        const onStem = (k: number) => [...syms, ...stemHeads].filter((s0) => /^notehead/.test(s0.code) && s0.box.x < r!.stemX + k && s0.box.x + s0.box.w > r!.stemX - k);
        if (onStem(tol).some((s0) => s0.box.y < y + tol && s0.box.y + s0.box.h > y - tol)) continue;
        // 去线把一根干切成两截、或干尖的符尾根单成一块时，摘出的「头」不在块的远端那头
        //（爱是从神而来 p5 m55、p3 m38 男声朝下的八分，符尾根压着一截加粗的谱线，摘出 D3）。
        // 顺着干往里走到一个已认出的头，再从摘出的头往外量干还伸出多少：0.5~2 格的是干尖的符尾根。
        // 两声部共干、干尖那个头离干端不到 0.3 格；和弦最低音下面的干多有两格半以上，短的接着符杠，或两头之间没有符尾那一笔
        const hc = r.head.y + r.head.h / 2;
        const walk = (dir: number): number => {
          let yy = Math.round(hc);
          while (inkAt(yy + dir) && Math.abs(yy - hc) < unit.space * 5) yy += dir;
          return yy;
        };
        const flagRoot = [1, -1].some((dir) => {
          const yi = walk(-dir);
          const ye = walk(dir);
          const tail = Math.abs(ye - hc);
          if (tail < unit.space * 0.5 || tail >= unit.space * 2) return false;
          // 干端接着符杠的是和弦（倚靠主永远膀臂 m5 附点八分 + 十六分和弦，杠前只伸出 1.9 格）
          if (prims.beams.some((q) => q.box.x <= r!.stemX + tol && q.box.x + q.box.w >= r!.stemX - tol && ye >= q.box.y - tol && ye <= q.box.y + q.box.h + tol)) return false;
          const lo = Math.min(yi, hc - dir * unit.space * 0.8);
          const hi = Math.max(yi, hc - dir * unit.space * 0.8);
          // 头盒收窄过的离干半格（p3 m38 那颗头左沿离干 6px）
          const k = onStem(unit.space * 0.5).find((s0) => s0.box.y < hi + tol && s0.box.y + s0.box.h > lo - tol);
          if (!k) return false;
          // 两个头之间、摘出的头那一侧贴着干一个头宽的一条，去线图上大半行有墨：那是符尾斜着甩上去的一笔。
          // 真和弦（父恩广大 m13 朝下的干 B3/G2，G2 下面干只伸 1.4 格）、两声部共干（我灵镇静 m12，两个头分在干两侧）那里是白的
          const right = r!.head.x + r!.head.w / 2 > r!.stemX;
          const xa = Math.round(right ? r!.stemX + unit.lineThick + 1 : r!.stemX - unit.space * 1.4);
          const xb = Math.round(right ? r!.stemX + unit.space * 1.4 : r!.stemX - unit.lineThick - 1);
          const ya = Math.round(Math.min(k.box.y + k.box.h, r!.head.y + r!.head.h));
          const yb = Math.round(Math.max(k.box.y, r!.head.y));
          let rows = 0, inked = 0;
          for (let y = ya; y < yb; y++) {
            rows++;
            for (let x = Math.max(0, xa); x <= Math.min(nl.w - 1, xb); x++) if (nl.data[y * nl.w + x]) { inked++; break; }
          }
          return rows > 0 && inked >= rows * FLAG_STROKE_ROWS;
        });
        if (flagRoot) continue;
      }
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
  // **和弦条认领的字母块也是负例**：认领前它们多半被当成升降号、休止进了负例（Bb 的 b 当降号），
  // 认领后负例平白少几个——《敬拜万世之王》只剩 28 个、不到 `MIN_NEG`，判别器不训，
  // 后面按判别器补头的两路整段不跑，m4、m18 四个头没了。字母形状正是「长得像符头但不是」。
  const clfPos = [
    ...heads.filter((h) => !dropHead.has(h.comp.id) && h.code === "noteheadBlack").map((h) => h.box),
    ...split.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box),
    ...stemHeads.map((s0) => s0.box),
    ...stacked.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box),
  ];
  const clfNeg: Rect[] = [
    ...syms.filter((s0) => !/notehead/i.test(s0.code)).map((s0) => s0.box),
    ...blobs.filter((c) => harmonyIds.has(c.id) && c.bbox.w <= unit.space * 2.5 && c.bbox.h <= unit.space * 2.5).map((c) => c.bbox),
  ];
  const clf = masks.length ? trainHeadClassifier(raster.bin, masks, unit, onLineY, clfPos, clfNeg) : null;
  const clfHeads: RasterSym[] = [];
  /** 已有符头压着的位置不再出（「头 + 干」那一路只记账、不标块，这一遍会在同一块里再拆一次）。
   *  **两个头合起来压着的也算**：密排和弦里夹在上下两个已认头之间、各压两成多的一块是它们的边角，
   *  不是第三个头（是爱 p5 m70 F4/A4 之间切出个 G4；分类器的反例里多了几个全休止，这块就翻过了 `CLF_P`）。 */
  const headTaken = (hb: Rect) => {
    const prev = [...syms, ...clfHeads].filter((s0) => /^notehead/.test(s0.code)).map((s0) => overlapFrac(hb, s0.box));
    return prev.some((f) => f > 0.3) || prev.reduce((a, f) => a + f, 0) > HEAD_TAKEN_SUM;
  };
  /** 头盒 `b` 旁边（左沿往下、右沿往上）有没有一根干：那一列从头心起 `SPOT_STEM` 格里墨占 `SPOT_STEM_INK` 以上。 */
  const stemBeside = (b: Rect, between = false): boolean => {
    const cy = Math.round(b.y + b.h / 2);
    const len = Math.round(unit.space * SPOT_STEM);
    const col = (x: number, dir: 1 | -1): number => {
      let n = 0;
      for (let k = 1; k <= len; k++) {
        const y = cy + dir * k;
        if (y < 0 || y >= raster.bin.h) return 0;
        n += raster.bin.data[y * raster.bin.w + x];
      }
      return n / len;
    };
    const best = (x0: number, x1: number, dir: 1 | -1): number => {
      let m = 0;
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(raster.bin.w - 1, Math.round(x1)); x++) m = Math.max(m, col(x, dir));
      return m;
    };
    // `between`：左右两缘都有同向的干——两根干中间夹着的一截短杠（破碎 p8 m85 十六分的第二层杠没拟合成杠，补上内腔后是个头大小的斑点）
    if (between)
      return ([1, -1] as const).some((dir) => best(b.x - unit.space * 0.2, b.x + unit.space * 0.3, dir) >= SPOT_STEM_INK && best(b.x + b.w - unit.space * 0.3, b.x + b.w + unit.space * 0.2, dir) >= SPOT_STEM_INK);
    return (
      best(b.x - unit.space * 0.2, b.x + unit.space * 0.3, 1) >= SPOT_STEM_INK ||
      best(b.x + b.w - unit.space * 0.3, b.x + b.w + unit.space * 0.2, -1) >= SPOT_STEM_INK
    );
  };
  /** 斑点中段每一列在原图上都是纵贯 `SPOT_BAR` 格以上的墨：终止线、段落线那根粗线（0.6 格宽，开运算留得下，
   *  自己又给自己作了「干」的证据；我灵镇静 m26 出了两个头）。头的干在盒边，中段只有一个头高 */
  const solidBar = (b: Rect): boolean => {
    for (let x = Math.round(b.x + b.w * 0.25); x <= Math.round(b.x + b.w * 0.75); x++) {
      const run = vRunAt(raster.bin, x, Math.round(b.y + b.h / 2));
      if (!run || run[1] - run[0] < unit.space * SPOT_BAR) return false;
    }
    return true;
  };
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
      const gy = pitchGrid(b.y + b.h / 2, b.x + b.w / 2);
      if (gy === null) continue;
      if (headProb(clf, raster.bin, masks, unit, b, gy, onLineY(gy, b.x + b.w / 2)) < CLF_P) continue;
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
          headProb(clf, raster.bin, masks, unit, pb, gy, onLineY(gy, pb.x + pb.w / 2)) >= CLF_P,
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

    // ── **不靠连通块的实心头：原图开运算的斑点** ─────────────────────────────
    //
    // 上面几路都从连通块出发：块的尺寸、块里的拆法、块有没有被认领。扫描件上「头 + 干 + 尾」常再粘上一截弧、
    // 几粒噪点，块就出了每一路的闸；字典又会把整块认成别的字形（节拍器的「四分音符」）。漏音归因
    //（`raster-gap.mjs`）量出扫描件漏掉的实心头里，头的墨完好的占大半，干断成虚线的也不少。
    // 这里直接在**原图**上找：椭圆结构元的开运算抹掉比它细的笔画——谱线、符干、细弧——实心头留成一个斑点，
    // 不管它和谁连着。斑点只给位置，收不收要三样证据都在：落在音位格上、判别器过（`SPOT_P`，有干作证所以比块那几路松）、
    // 旁边有干（原图上那一列墨占六成以上，断成虚线的干也算）。已有符号压着的、矮的又压在符杠中线上的不要。
    // 两张图的斑点都当候选：原图直接开，和先补一道 3×3 闭运算再开。扫描件的头常是一片网点，直接开会缩成一小粒、甚至抹光
    //（破碎扫描 p5 m61 G2）；先闭又会把上下贴着的和弦两个头并成一个过高的斑点（是爱 p5 m65）。同一处只收一次
    const rx = Math.max(1, Math.round(unit.space * SPOT_RX));
    const ry = Math.max(1, Math.round(unit.space * SPOT_RY));
    const closed = { ...raster.bin, data: raster.bin.data.slice() };
    close(closed, 1);
    const spotComps = [...connectedComponents(ellipseOpen(raster.bin, rx, ry), 4), ...connectedComponents(ellipseOpen(closed, rx, ry), 4)];
    const inBand = (y: number) => groups.some((g) => y > g.lines[0].y - unit.space * SPOT_BAND && y < g.lines[4].y + unit.space * SPOT_BAND);
    // 本页的尺子：已认实心头所在斑点的中位宽高。升号交叉处、粗圈空心头留下的斑点比真头小一圈（f37 0.69×0.59、0.82×0.64 格，
    // 同页真头 1.1×0.85 上下）；网点印的扫描件头开运算后也缩，尺子跟着缩
    const known = syms.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box);
    const onHead = spotComps.filter((c) => known.some((kb) => overlapFrac(c.bbox, kb) > 0.5));
    const medW = onHead.length >= SPOT_RULER_N ? median(onHead.map((c) => c.bbox.w)) : 0;
    const medH = onHead.length >= SPOT_RULER_N ? median(onHead.map((c) => c.bbox.h)) : 0;
    const spotHeads: RasterSym[] = [];
    for (const c of spotComps) {
      const b = c.bbox;
      const w = b.w / unit.space;
      const h = b.h / unit.space;
      if (w < SPOT_W[0] || w > SPOT_W[1] || h < SPOT_H[0] || h > SPOT_H[1]) continue;
      if (b.w < medW * SPOT_RULER || b.h < medH * SPOT_RULER) continue;
      // 两根干之间的一截短杠整段留成斑点（追思歌 m14：41×20 像素，同页真头斑点中位 31×22），比头宽出一截
      if (medW && b.w > medW * SPOT_RULER_MAX) continue;
      const cy = b.y + b.h / 2;
      if (!inBand(cy)) continue;
      // 节拍器字形（`metNote*`）压着的不算占用：谱表带里「头 + 干 + 尾」被字典认成了节拍器的音符（破碎扫描 p1 m6 B♭3），收了头就把它换掉；
      // 保持音的短横也是：它比开运算的椭圆细，自己留不下斑点，头大小的斑点压着它，是头的残片被认成了保持音（同页 m16 G4）
      const over = syms.filter((s0) => overlapFrac(b, s0.box) > 0.2 || overlapFrac(s0.box, b) > 0.2);
      if (over.some((s0) => !/^met/.test(s0.code))) continue;
      const beamsHit = beamsThrough(b);
      if (beamsHit >= 2 || (beamsHit === 1 && b.h < unit.space * SPOT_BEAM_H)) continue;
      const gy = pitchGrid(cy, b.x + b.w / 2);
      if (gy === null) continue;
      if (!stemBeside(b)) continue;
      if (solidBar(b)) continue;
      if (headProb(clf, raster.bin, masks, unit, b, gy, onLineY(gy, b.x + b.w / 2)) < SPOT_P) continue;
      const hw = Math.round(unit.space * 1.25);
      const hh = Math.round(unit.space * 0.95);
      const box = { x: Math.round(b.x + b.w / 2 - hw / 2), y: Math.round(gy - hh / 2), w: hw, h: hh };
      if (headTaken(box) || spotHeads.some((s0) => overlapFrac(box, s0.box) > 0.3)) continue;
      spotHeads.push({ box, code: "noteheadBlack" });
      ledger.claim(box, "spot:noteheadBlack");
      for (const s0 of over) {
        const i = syms.indexOf(s0);
        if (i >= 0) syms.splice(i, 1);
      }
    }
    syms.push(...spotHeads);
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
      // 已认出的符号盖住大半的碎块不算空闲：「stack」那一路认出的头只记账、不标块，留在这里会被并进旁边的块
      //（爱是从神而来 p5 m63 E♭5 全音符的左右两半隔 7px 并进下面 G4/B♭4 叠成「8」字的那块，盒高 3.6 格过不了尺寸闸，两个头都丢了）
      const free = blobs.filter((c) => isFree(c) && inFar(c.bbox.y + c.bbox.h / 2) && !syms.some((s0) => overlapFrac(c.bbox, s0.box) > 0.5));
      /** 本页已认二分头的中位尺寸（开口内腔那一档用）。 */
      const halves = syms.filter((s0) => s0.code === "noteheadHalf");
      const halfSize = halves.length ? { w: median(halves.map((s0) => s0.box.w)), h: median(halves.map((s0) => s0.box.h)) } : null;
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
  // **填充率不算两端各两个线厚**：竖条两端落在谱线上，去线后交点那几行常留一圈毛边，盒子被撑宽
  //（新编 327 末行首根小节线 5px，底端四行 7px，整盒填充 0.72）。推平前这几行恰好被移位削掉，
  // 不推平就得自己让开。
  const solidFill = (c: Component): number => {
    const b = c.bbox;
    const cut = Math.round(unit.lineThick * 2);
    let n = 0, lo = Infinity, hi = -Infinity;
    for (let y = b.y + cut; y < b.y + b.h - cut; y++)
      for (let x = b.x; x < b.x + b.w; x++)
        if (blobLabels[y * nl.w + x] === c.id) n++, (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
    return n ? n / ((hi - lo + 1) * (b.h - cut * 2)) : 0;
  };
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space || solidFill(c) < 0.8) continue;
    const g = groups.find((g0) => Math.abs(b.y - yAt(g0, 0, b.x + b.w / 2)) <= unit.space * 0.4 && Math.abs(b.y + b.h - yAt(g0, 4, b.x + b.w / 2)) <= unit.space * 0.4);
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
    // 行首那一段：弯、斜的谱行取左缘往右四格处的线位
    const kx = Math.max(...g.lines.map((l) => l.left)) + unit.space * 4;
    const t0 = yAt(g, 0, kx);
    const b4 = yAt(g, 4, kx);
    const top = t0 - unit.space * 2;
    const bottom = b4 + unit.space * 2;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < b4 && s0.box.y + s0.box.h > t0);
    if (!clef) continue;
    // 调号兜底之后才摘出来的「符头」（符头连符干那一路把升号的竖笔当成符干）再验一次
    const onStaff = (r: Rect) => r.y < b4 && r.y + r.h > t0;
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
  for (const d of findDots(nl, syms, unit, staffYs, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x))) {
    syms.push({ box: d, code: "augmentationDot" });
    ledger.claim(d, "dot:augmentationDot");
  }
  // 附点休止：休止右边的点同一个窗口找（破碎 p4 m32 钢琴右手附点八分休止）
  {
    const rests = syms.filter((s0) => s0.code === "rest8th" || s0.code === "rest16th" || s0.code === "restQuarter");
    if (rests.length)
      for (const d of findDots(nl, syms, unit, staffYs, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x), rests)) {
        if (syms.some((s0) => s0.code === "augmentationDot" && overlapFrac(s0.box, d) > 0)) continue;
        syms.push({ box: d, code: "augmentationDot" });
        ledger.claim(d, "dot:augmentationDot");
      }
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
        const nearStaff = (y: number) => staffGeoms.some((g) => y > g.topAt(sx) - sp * FLAG_HEAD_BAND && y < g.bottomAt(sx) + sp * FLAG_HEAD_BAND);
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
      if (!best) continue;
      const moved = { ...s0.box, y: Math.round(s0.box.y + best.y - cy) };
      // 挪过去盒里多出几行整行没墨的不挪：扫描件上肚里留白的实心头模板对不上哪一级，
      // 分高的那级会把盒挪出墨外，干端就挂不上了（望十架 p5 m39 低音 B♭3 八分，挪到 A3 线上、盒底空 6 行，读成全音符）
      const blank = (b: Rect) => {
        let n = 0;
        for (let y = b.y; y < b.y + b.h; y++) {
          let on = false;
          for (let x = b.x; x < b.x + b.w && !on; x++) on = !!nl.data[y * nl.w + x];
          if (!on) n++;
        }
        return n;
      };
      if (blank(moved) - blank(s0.box) >= moved.h * BLANK_MOVE) continue;
      s0.box = moved;
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
      let short = false;
      const own = has && [...prims.vSegs, ...stemSegs, ...inkStems].some((v) => {
        const vx = (v.x0 + v.x1) / 2;
        const top = Math.min(v.y0, v.y1);
        const bot = Math.max(v.y0, v.y1);
        if (top > cy + sp || bot < cy - sp) return false;
        // 不到补干下限的那截不算（干上端连着符尾，竖段只抽出符尾以下 1.9 格，挂干时又嫌短：破碎干净版 p9 m89 D4 八分读成四分）
        // 远端扎进符杠的干本来就短（两层杠的十六分，宁静的伯利恒 p5 m71），照旧算挂着
        const far = cy - top > bot - cy ? top : bot;
        const beamed = prims.beams.some((q) => vx >= q.box.x - tol && vx <= q.box.x + q.box.w + tol && far >= q.box.y - tol && far <= q.box.y + q.box.h + tol);
        // 按竖段全长量：和弦里靠干端那个头离干端本来就近。只看贴着本头的那截（先判横向）：
        // 先判长短的话，整页纵向重叠的任何短段都把头标成「短」，正常走墨柱补干的头也被下面两道拦了（向主唱新歌 F2/C3/F3 八分读成四分）
        const side = (Math.abs(vx - b.x) <= tol && bot >= cy + sp) || (Math.abs(vx - b.x - b.w) <= tol && top <= cy - sp);
        if (side && !beamed && bot - top < sp * INK_STEM_REACH[0]) return (short = true), false;
        return side;
      });
      if (has && own) continue;
      // 墨柱断口容到一条谱线厚：去线图上干被每条谱线切断，粗线页（是爱线厚 4px）只容两行就在第一条线处断了（是爱 −8、破碎扫描 −13）
      const col = inkColumn(nl, b, unit, has, Math.max(2, Math.round(unit.lineThick)));
      if (!col) continue;
      const reach = Math.max(cy - col[0], col[1] - cy);
      if (reach < sp * INK_STEM_REACH[0] || reach > sp * INK_STEM_REACH[1]) continue;
      const g = groups.find((q) => cy > yAt(q, 0, col[2]) - sp * 4 && cy < yAt(q, 4, col[2]) + sp * 4);
      // 原本贴着一截短竖段、改走墨柱的：墨柱远端不出谱表 `SHORT_STEM_OUT` 格（往上走进上一行歌词，字当成干与符尾，那一行歌词全散：破碎扫描版 p8 m86–89）
      if (short) {
        // 头所在的那行谱：离谱表上下沿最近的（`g` 取的是第一个四格内包得住的，常是上一行）
        const dist = (q: (typeof groups)[number]) => Math.max(0, yAt(q, 0, col[2]) - cy, cy - yAt(q, 4, col[2]));
        const own = groups.reduce((p, q) => (dist(q) < dist(p) ? q : p), groups[0]!);
        if (Math.min(col[0], col[1]) < yAt(own, 0, col[2]) - sp * SHORT_STEM_OUT || Math.max(col[0], col[1]) > yAt(own, 4, col[2]) + sp * SHORT_STEM_OUT) continue;
      }
      // 一端扎进符杠的不算小节线：底线上的头、干顶到首线上方的杠，也正好两端压着首末线（破碎扫描版 p7 十六分 E4）
      const inBeam = (y: number) => prims.beams.some((q) => col[2] >= q.box.x && col[2] <= q.box.x + q.box.w && y >= q.box.y - 2 && y <= q.box.y + q.box.h + 2);
      // 远端右侧挂着符尾的也不算：第一间的八分干朝上，从头心正好顶到第五线（破碎干净版 p5 m55 F4）
      const far = cy - col[0] > col[1] - cy ? col[0] : col[1];
      let flag = 0;
      for (let y = Math.round(Math.min(far, far + (far === col[0] ? sp : -sp))); y <= Math.round(Math.max(far, far + (far === col[0] ? sp : -sp))); y++)
        for (let x = col[2] + 2; x <= col[2] + sp; x++) if (x < nl.w && y >= 0 && y < nl.h && nl.data[y * nl.w + x]) flag++;
      const flagged = flag >= sp * sp * 0.12;
      if (g && Math.abs(col[0] - yAt(g, 0, col[2])) <= sp * 0.5 && Math.abs(col[1] - yAt(g, 4, col[2])) <= sp * 0.5 && !inBeam(col[0]) && !inBeam(col[1]) && !flagged) continue;
      inkStems.push({ x0: col[2], y0: col[0], x1: col[2], y1: col[1], lw: unit.lineThick, maxLw: unit.lineThick * 2 });
    }
  }

  // ── 沿着已挂了空心头的干补和弦里漏掉的空心头（`notehead.ts::hollowHeadsAlongStems`）──
  // 放在墨柱补干之后：叠头的圈把干切碎、竖段表里没有的干，要等上面补进 `inkStems` 才有（我灵镇静 m10）。
  // 模板按**此刻**认出的空心头重建（含弱头、两个就够）：早先那份样本不够时一张都没有（恩友歌第一页），
  // 一张也凑不出就只按墨占比与内腔佐证判。
  {
    const alongMasks = buildHollowMasks(raster.bin, syms.filter((s0) => !(s0 as { noSample?: boolean }).noSample), unit, staffLines, 2, 3);
    // 挂在干端、被读偏一级的空心头先挪回去（`notehead.ts::reseatHollowHeads`），下面沿干找头才有对的参照
    reseatHollowHeads(raster.bin, nl, rawHoles, alongMasks, unit, makePitchSteps(groups), [...prims.vSegs, ...stemSegs, ...inkStems], syms);
    const added: RasterSym[] = [];
    // 两端都没挂头的干：以干为锚、不要参照头（`notehead.ts::hollowHeadsOnStemSeeds`），收到的头下面沿干找头时当参照
    {
      // 行首「谱号 + 调号」的右沿（同 `afterKey`），再放半格：调号末一个升降号没认出时，模板会落进前一个的圆肚
      const inHeader = (b: Rect) => {
        const cy = b.y + b.h / 2;
        const g = groups.find((g0) => cy > yAt(g0, 0, b.x + b.w / 2) - unit.space * 2 && cy < yAt(g0, 4, b.x + b.w / 2) + unit.space * 2);
        if (!g) return false;
        const inRow = (r: Rect) => r.y + r.h / 2 > yAt(g, 0, r.x + r.w / 2) - unit.space * 2 && r.y + r.h / 2 < yAt(g, 4, r.x + r.w / 2) + unit.space * 2;
        const clef = syms.filter((s0) => s0.code.endsWith("Clef") && inRow(s0.box) && s0.box.x < b.x + b.w).sort((p, q) => q.box.x - p.box.x)[0];
        if (!clef) return false;
        let right = clef.box.x + clef.box.w;
        const accs = syms.filter((s0) => /^accidental(Flat|Sharp)$/.test(s0.code) && inRow(s0.box) && s0.box.x > clef.box.x).sort((p, q) => p.box.x - q.box.x);
        for (const [i, a] of accs.entries()) {
          if (a.box.x - right > unit.space * (i ? 1.2 : 2)) break;
          right = Math.max(right, a.box.x + a.box.w);
        }
        return b.x < right + unit.space * 0.5;
      };
      const isBar = (q: LineSeg) => staffGeoms.some((g) => Math.abs(Math.min(q.y0, q.y1) - g.topAt((q.x0 + q.x1) / 2)) < unit.space * 0.4 && Math.abs(Math.max(q.y0, q.y1) - g.bottomAt((q.x0 + q.x1) / 2)) < unit.space * 0.4);
      for (const f of hollowHeadsOnStemSeeds(raster.bin, nl, rawHoles, alongMasks, unit, makePitchSteps(groups), [...prims.vSegs, ...stemSegs, ...inkStems], syms, prims.beams.map((q) => q.box), isBar, inHeader)) {
        syms.push(f);
        added.push(f);
        ledger.claim(f.box, "seed:noteheadHalf");
      }
    }
    for (const f of hollowHeadsAlongStems(raster.bin, nl, rawHoles, alongMasks, unit, makePitchSteps(groups), [...prims.vSegs, ...stemSegs, ...inkStems], syms)) {
      syms.push(f);
      added.push(f);
      ledger.claim(f.box, "along:noteheadHalf");
    }
    // ── **不靠连通块的空心头：补上内腔再开运算的斑点** ─────────────────────────
    //
    // 实心头那一路（判别器之后）的空心版。上面几路都靠内腔或参照头：内腔被谱线切碎、圈被网点糊开口，参照头本身也没认出
    //（三度叠头整摞都漏，是爱 m36、m48）时就都进不来。这里先在**原图**上把不过 `HSPOT_HOLE` 格²的小白块填上（`areaClose`），
    // 空心头就成了实心椭圆，再用实心那一路同一个椭圆开运算，头留成斑点。收不收看：头心原图上有白（`HSPOT_WHITE`，实心头、
    // 杠的交叉处没有）、本页空心模板的分（`HSPOT_SCORE`）、竖段表里找得到干或原图上量得到墨柱（钉盒缘、补进 `inkStems`）。
    // 三度叠头的圈补实后连成一根高斑点（不过 `HSPOT_STACK_H` 格），按音位逐级试；旁边没干又够宽的按全音符试（爱是从神而来 m62 的三度叠全音符）。
    // 符杠压着的、左右两缘都有同向干的（两根干之间的短杠）不要。本页凑不出空心模板的不做（信心使我得胜：没有模板分把关，八分的符杠围出的白全收成了头）。
    if (alongMasks.length) {
      const sp = unit.space;
      const filled = { ...raster.bin, data: raster.bin.data.slice() };
      areaClose(filled, Math.round(sp * sp * HSPOT_HOLE));
      const rx = Math.max(1, Math.round(sp * SPOT_RX));
      const ry = Math.max(1, Math.round(sp * SPOT_RY));
      const comps = connectedComponents(ellipseOpen(filled, rx, ry), 4);
      const halves = syms.filter((s0) => s0.code === "noteheadHalf").map((s0) => s0.box);
      const onHalf = comps.filter((c) => halves.some((kb) => overlapFrac(c.bbox, kb) > 0.5));
      const medW = onHalf.length >= HSPOT_RULER_N ? median(onHalf.map((c) => c.bbox.w)) : 0;
      const medH = onHalf.length >= HSPOT_RULER_N ? median(onHalf.map((c) => c.bbox.h)) : 0;
      const hw = halves.length ? median(halves.map((q) => q.w)) : Math.round(sp * 1.3);
      const hh = halves.length ? median(halves.map((q) => q.h)) : Math.round(sp * 1.1);
      /** 头心那个小椭圆里（谱线行不算）原图的白占比：空心头有内腔，实心头、粗线交叉没有 */
      const white = (cx: number, cy: number): number => {
        let n = 0;
        let k = 0;
        const ax = sp * 0.3;
        const ay = sp * 0.18;
        for (let y = Math.round(cy - ay); y <= Math.round(cy + ay); y++) {
          if (y < 0 || y >= raster.bin.h || grid.onLine(y, unit.lineThick / 2 + 0.5, cx)) continue;
          for (let x = Math.round(cx - ax); x <= Math.round(cx + ax); x++) {
            if (x < 0 || x >= raster.bin.w || ((x - cx) / ax) ** 2 + ((y - cy) / ay) ** 2 > 1) continue;
            n++;
            if (!raster.bin.data[y * raster.bin.w + x]) k++;
          }
        }
        return n ? k / n : 0;
      };
      const hspotStems = [...prims.vSegs, ...stemSegs, ...inkStems];
      const steps = makePitchSteps(groups);
      for (const c of comps) {
        const b = c.bbox;
        const w = b.w / sp;
        const h = b.h / sp;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        // 叠成一摞的和弦（三度叠头的圈补实后连成一根高斑点）：按音位逐级试
        const stack = h > SPOT_H[1] && h <= HSPOT_STACK_H;
        if (w < SPOT_W[0] || w > SPOT_W[1] || h < SPOT_H[0] || (h > SPOT_H[1] && !stack)) continue;
        if (medW && (b.w < medW * SPOT_RULER || (!stack && b.h < medH * SPOT_RULER) || b.w > medW * SPOT_RULER_MAX)) continue;
        if (!groups.some((g) => cy > g.lines[0].y - sp * SPOT_BAND && cy < g.lines[4].y + sp * SPOT_BAND)) continue;
        // 符杠压着的不要：两层短杠夹着一条谱线，围出的白条补上后也是个头大小的斑点（破碎 p6 m66 十六分那一截杠）
        if (beamsThrough(b)) continue;
        // 斑点压着实心头、符尾的不要：八分的符尾顺着干往下甩，与干、谱线围出的白补实后连着头成一根高斑点（主使我喜乐、来敬拜荣耀王）；
        // 一根干上也不会一半实心一半空心
        if (syms.some((s0) => /^(noteheadBlack|flag)/.test(s0.code) && (overlapFrac(b, s0.box) > 0.2 || overlapFrac(s0.box, b) > 0.2))) continue;
        // 旁边没干、又够全音符宽的：按全音符试（不要干）
        const whole = !stemBeside(b) && w >= HSPOT_WHOLE_W;
        if (!whole && !stemBeside(b)) continue;
        if (stemBeside(b, true)) continue;
        if (solidBar(b)) continue;
        const ys: number[] = [];
        if (stack) for (const st of steps(b.y + sp * 0.35, b.y + b.h - sp * 0.35, b.x + b.w / 2)) ys.push(st.y);
        else {
          const gy = pitchGrid(cy, b.x + b.w / 2);
          if (gy === null) continue;
          ys.push(gy);
        }
        const cands: { box: Rect; s: number; ink: LineSeg | null; y: number }[] = [];
        for (const gy of ys) {
          const box = whole ? { x: b.x, y: Math.round(gy - hh / 2), w: b.w, h: hh } : { x: Math.round(cx - hw / 2), y: Math.round(gy - hh / 2), w: hw, h: hh };
          const over = syms.filter((s0) => overlapFrac(box, s0.box) > 0.2 || overlapFrac(s0.box, box) > 0.2);
          if (over.length) continue;
          const wh = white(cx, gy);
          if (wh < HSPOT_WHITE) continue;
          const m = alongMasks.find((k) => k.onLine === onLineY(gy, cx)) ?? alongMasks[0];
          let sc = 0;
          for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) sc = Math.max(sc, scoreAtMasked(raster.bin, m, cx + dx, gy + dy));
          if (sc < HSPOT_SCORE) continue;
          if (whole) {
            box.x = Math.round(cx - box.w / 2);
            if (headTaken(box)) continue;
            cands.push({ box, s: sc, ink: null, y: gy });
            continue;
          }
          // 干要在竖段表里找得到（盒缘贴着），盒缘钉在干上：只凭原图那一列有墨的，后面挂不上干、落成全音符（是爱 p4 m60 的 B♭5）。
          // 一摞里中间的头挂在干的中段。竖段表里没有的（扫描件的干断成虚线）：原图上量墨柱（断口 ≤2 像素），够一根干长就补进 `inkStems`
          let v = stemOf(box, hspotStems, unit, nl, stack);
          let ink: LineSeg | null = null;
          const col = inkColumn(raster.bin, box, unit, false);
          // 原图上这一列墨通到已认的实心头上的不要：一根干上不会一半实心一半空心。八分的符尾贴着干、与谱线围出的白补实后成了斑点，
          // 竖段表里的干断在符尾根上、看着像挂在干端，原图上那一列却一直通到干端的实心头（新编 336、203）。
          // 竖段表里的干也要「头心在墨柱一端」的话，挡掉和弦里另几个头没认出、干从这个头两头都伸出去的真头（是爱 m46 C5）
          if (col && syms.some((s0) => s0.code === "noteheadBlack" && s0.box.x - unit.space * 0.25 <= col[2] && s0.box.x + s0.box.w + unit.space * 0.25 >= col[2] && s0.box.y <= col[1] && s0.box.y + s0.box.h >= col[0])) continue;
          // 墨柱补的干，头心要离它一端不过 `HSPOT_STEM_END`：没有竖段表作证，两头都伸出去的多半是别的东西（和弦另几个头也没认出时宁可不收，是爱 p4 m60 的 B♭5）
          const atEnd = (c: [number, number, number]) => stack || Math.min(Math.abs(c[0] - gy), Math.abs(c[1] - gy)) <= sp * HSPOT_STEM_END;
          if (!v && col && col[1] - col[0] >= sp * SPOT_STEM && atEnd(col)) v = ink = { x0: col[2], y0: col[0], x1: col[2], y1: col[1], lw: unit.lineThick, maxLw: unit.lineThick * 2 };
          if (!v) continue;
          const vx = (v.x0 + v.x1) / 2;
          box.x = Math.abs(box.x + box.w - vx) <= Math.abs(box.x - vx) ? Math.round(vx - box.w) : Math.round(vx);
          if (headTaken(box)) continue;
          cands.push({ box, s: sc, ink, y: gy });
        }
        // 一摞里相邻一级（半格）不能都是头：按模板分先后，离已收的不到 0.75 格的让位
        cands.sort((p, q) => q.s - p.s);
        const picked: typeof cands = [];
        for (const k of cands) if (!picked.some((q) => Math.abs(q.y - k.y) < sp * 0.75)) picked.push(k);
        for (const k of picked) {
          if (k.ink) inkStems.push(k.ink);
          const f: RasterSym = { box: k.box, code: whole ? "noteheadWhole" : "noteheadHalf" };
          syms.push(f);
          added.push(f);
          ledger.claim(k.box, `hspot:${f.code}`);
        }
      }
    }
    // 这里补出来的头错过了上面找附点那一步，单给它们再找一次（我灵镇静 m10 附点二分 F4）
    if (added.length)
      for (const d of findDots(nl, syms, unit, staffYs, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x), added)) {
        // 已经认过的附点不再收一遍：补出来的头紧挨着带附点的头时，同一个点会被再认一次、成了两个点
        if (syms.some((q) => q.code === "augmentationDot" && q.box.x < d.x + d.w && d.x < q.box.x + q.box.w && q.box.y < d.y + d.h && d.y < q.box.y + q.box.h)) continue;
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
      // 外线按头所在 x 处取（弯、斜的谱线）
      const hx = syms[i].box.x + syms[i].box.w / 2;
      let g0 = groups[0];
      let d = Infinity;
      for (const g of groups) {
        const dd = Math.max(0, yAt(g, 0, hx) - cy, cy - yAt(g, 4, hx));
        if (dd < d) (d = dd), (g0 = g);
      }
      const top0 = yAt(g0, 0, hx);
      const bot0 = yAt(g0, 4, hx);
      // 落在第一加线上（离外线 0.75~1.25 格）的空心头：穿过头心那条加线（上下 0.3 格内）连着头的横墨要有 `FIRST_LEDGER_RUN` 格长
      //（头宽加两侧伸出的加线）。谱表上方说明文字里的「n」拱形围出内腔，收成空心头读成 A5 全音符（宁静的伯利恒每页一两个），
      // 字里最长的横笔不到一格
      if (d > sp * 0.75 && d <= sp * LEDGER_CHAIN_FROM && syms[i].code !== "noteheadBlack") {
        const b = syms[i].box;
        const cx = Math.round(b.x + b.w / 2);
        const ly = cy < top0 ? top0 - sp : bot0 + sp;
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
      const dir = cy < top0 ? -1 : 1;
      const edgeY = dir < 0 ? top0 : bot0;
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
    // 字典把「头 + 干」整块认成节拍器的音符字形（`metNote*`，建页时按复合音符收编成一个实心头），
    // 而这个头别的路已经认出来了：同一个音出两遍（宁静的伯利恒 p1 m12 附点二分 C4 多出一个实心四分 C4、
    // p4 m56 E3）。字形盒的一端压着已认的头就丢掉字形
    for (let i = syms.length - 1; i >= 0; i--) {
      const b = syms[i].box;
      if (!/^metNote/.test(syms[i].code)) continue;
      const tol = unit.space * 0.3;
      if (kept.some((k) => cx(k.box) > b.x - tol && cx(k.box) < b.x + b.w + tol && (Math.abs(cy(k.box) - (b.y + b.h)) < unit.space || Math.abs(cy(k.box) - b.y) < unit.space))) syms.splice(i, 1);
    }
  }
  // ── 头左边贴着、没认出来的临时记号：在头左侧的窗里取墨查字典 ─────────────────
  //
  // 临时记号常与头、干、邻音粘成一块（破碎 p8 m84 C♯5：升号连着头和干成了 29×64 的一块，左竖又断成一小块），
  // 按块查的几路都看不到它。头都认完了，就从头这边找：头左 `ACC_PROBE_W` 格、上下 `ACC_PROBE_H` 格的窗里，
  // 去线图上的墨扣掉所有头盒，收成外接框——框要在窗内（左缘外一列空着，整个字形都框进来了）、纵向与头对齐，
  // 字典查得出临时记号才收
  {
    const sp = unit.space;
    // 从右往左：和弦前几列临时记号，靠里那列先认出来，外列的窗才好隔着它往左挪
    const heads = syms.filter((s0) => /^notehead/.test(s0.code)).sort((a, b) => b.box.x - a.box.x);
    const accs = syms.filter((s0) => isAccidental(s0.code));
    // 窄过 0.45 格的「临时记号」是字典按块认出的半截（升号横笔压线被切开，左半一块、右半认成别的；破碎 p8 m80），不当已有
    const whole = (a: RasterSym) => a.box.w >= sp * ACC_HALF_W;
    const cyOf = (b: Rect) => b.y + b.h / 2;
    // 记号右边另有头与它更同高：一根升号高三格，盖得住和弦里两三个头的心，却只是其中一个的
    const ownsBetter = (a: RasterSym, h: RasterSym) => {
      const d = Math.abs(cyOf(a.box) - cyOf(h.box));
      return heads.some((o) => o !== h && o.box.x >= a.box.x + a.box.w - 2 && o.box.x - (a.box.x + a.box.w) <= sp * 1.6 && Math.abs(cyOf(a.box) - cyOf(o.box)) < d && Math.abs(cyOf(a.box) - cyOf(o.box)) <= sp * ACC_OWN_DY);
    };
    for (const h of heads) {
      const hcy = h.box.y + h.box.h / 2;
      if (accs.some((a) => whole(a) && a.box.x + a.box.w <= h.box.x + 2 && a.box.x + a.box.w >= h.box.x - sp * 1.6 && a.box.y < hcy && a.box.y + a.box.h > hcy && !ownsBetter(a, h))) continue;
      let rx1 = Math.round(h.box.x) - 1;
      // 错开在干另一侧的头（二度）：左列的头挡在前面，窗从左列头的左缘起（破碎 p8 m80 F♯4）
      for (;;) {
        const o = heads.find((o) => o !== h && o.box.x < rx1 && o.box.x + o.box.w >= rx1 - sp * 0.3 && o.box.x + o.box.w <= rx1 + 4 && Math.abs(cyOf(o.box) - hcy) <= sp * 1.2);
        if (!o) break;
        rx1 = Math.round(o.box.x) - 1;
      }
      // 前面已有一列临时记号（不是这个头的）：窗隔过它往左开，找外列（同上 E♭4 的 ♭ 在 F♯4 的 ♯ 左边）
      for (;;) {
        const a = accs.find((a) => whole(a) && a.box.x <= rx1 && a.box.x + a.box.w >= rx1 - sp * 0.5 && a.box.y < hcy + sp * 0.5 && a.box.y + a.box.h > hcy - sp * 0.5);
        if (!a) break;
        rx1 = Math.round(a.box.x) - 1;
      }
      const rx0 = Math.max(0, Math.round(rx1 + 1 - sp * ACC_PROBE_W));
      const ry0 = Math.max(0, Math.round(hcy - sp * ACC_PROBE_UP)), ry1 = Math.min(nl.h - 1, Math.round(hcy + sp * ACC_PROBE_H));
      if (rx1 - rx0 < 3) continue;
      const W = rx1 - rx0 + 1, H = ry1 - ry0 + 1;
      const fromNl = ((): { box: Rect; code: SmuflName } | null => {
        const local = { w: W, h: H, data: new Uint8Array(W * H) } as Binary;
        for (let y = ry0; y <= ry1; y++)
          for (let x = rx0; x <= rx1; x++) {
            if (!nl.data[y * nl.w + x]) continue;
            if (heads.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h)) continue;
            local.data[(y - ry0) * W + (x - rx0)] = 1;
          }
        // 窗里的干先抹掉：升号左竖连着邻音朝上的干和头，整块碰到窗左边、被当成邻音扣掉（破碎 p8 m84 C♯5）
        for (const v of prims.vSegs) {
          const vx = (v.x0 + v.x1) / 2, half = Math.max(1, v.maxLw / 2);
          if (vx + half < rx0 || vx - half > rx1) continue;
          // 只抹比窗还高出去的长竖段：临时记号自己的竖笔也可能被抽成竖段
          const top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
          if (top > ry0 && bot < ry1) continue;
          for (let y = Math.max(ry0, Math.round(top)); y <= Math.min(ry1, Math.round(bot)); y++)
            for (let x = Math.max(rx0, Math.round(vx - half)); x <= Math.min(rx1, Math.round(vx + half)); x++) local.data[(y - ry0) * W + (x - rx0)] = 0;
        }
        // 碰到窗左、上、下边的连通块是邻音的干、杠、尾，扣掉；剩下的并起来
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        const labels = new Int32Array(W * H);
        const drop = new Set<number>();
        for (const cc of connectedComponents(local, 1, labels)) {
          const q = cc.bbox;
          if (q.x === 0 || q.y === 0 || q.y + q.h >= H || cc.area < sp * sp * 0.3) {
            drop.add(cc.id);
            continue;
          }
          x0 = Math.min(x0, q.x + rx0), x1 = Math.max(x1, q.x + q.w - 1 + rx0), y0 = Math.min(y0, q.y + ry0), y1 = Math.max(y1, q.y + q.h - 1 + ry0);
        }
        for (let i = 0; i < labels.length; i++) if (drop.has(labels[i])) local.data[i] = 0;
        if (x1 < 0) return null;
        const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
        const w1 = box.w / sp, h1 = box.h / sp;
        if (w1 < 0.3 || w1 > 1.1 || h1 < 1.5 || h1 > 3.2) return null;
        if (Math.abs(box.y + box.h / 2 - hcy) > sp * 0.8) return null;
        const lbox = { x: box.x - rx0, y: box.y - ry0, w: box.w, h: box.h };
        const sig = binSig(local, lbox);
        let code = look.lookup(sig, w1, h1);
        // 字典认不出（去线、扣头后字形残了）：两根通高竖笔 + 两道横贯粗横是升号（模板不用：干加邻头的墨也配得上，我灵镇静 m22）
        if (!code || !isAccidental(code)) {
          // 结构判只认升号的个头（高不过 `ACC_PROBE_SHARP_H` 格）、里面不能有实心头大小的满墨：一根干加旁边头的墨也是「两竖两横」（我灵镇静 m22）
          const isSharp = (img: Binary) => h1 <= ACC_PROBE_SHARP_H && !solidInside(img, lbox, sp) && (sharpShape(img, lbox) || (tallStrokes(img, lbox) === 2 && sharpCrossbars(img, lbox, unit)));
          code = isSharp(local) ? "accidentalSharp" : null;
          // 横笔正压在谱线上：去线图上两竖之间那段跟着线抹掉了（破碎 p8 m84 C♯5）。框里补回修补图上的线带像素（头盒、干照旧扣）再判一次
          if (!code) {
            const patched = { w: W, h: H, data: new Uint8Array(local.data) } as Binary;
            for (let y = box.y; y < box.y + box.h; y++)
              for (let x = box.x; x < box.x + box.w; x++) {
                if (!repaired.data[y * repaired.w + x] || nl.data[y * nl.w + x]) continue;
                if (heads.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h)) continue;
                patched.data[(y - ry0) * W + (x - rx0)] = 1;
              }
            code = isSharp(patched) ? "accidentalSharp" : null;
            // 最后一档：先找两道平行粗斜横，再按竖笔伸出横杠的方向分 ♯ / ♮（`restshape.ts::crossbarAccidental`）。
            // 竖笔与邻音的干共用一列、或下半被邻头盖住时，上面几档都数不对竖笔或横笔（破碎 p7 m72 G♯4）
            if (!code) code = crossbarAccidental(patched, lbox, unit);
          }
        }
        return code && isAccidental(code) ? { box, code } : null;
      })();
      // 去线图那几档都不成：在**原图**整窗上找两道平行粗斜横（`restshape.ts::crossbarAccidentalBox`）。
      // 临时记号常压在谱线上，去线时横笔跟着抹掉、碎块又小过碎点下限被扣光（破碎 p2 m7 低音 E♮3）；原图上谱线只有两三像素厚，过不了横杠的厚度下限。
      // 头盒、比窗还高的干照旧扣掉
      // 去线图那一路只认出半个（窄过 0.45 格，横杠压线被抹、只剩一竖）的当没认出，交给原图那一档（赞美三一真神 m12 低音 ♯）
      let found = fromNl && fromNl.box.w >= sp * 0.45 ? fromNl : null;
      // 窗里取 `src` 的墨，扣掉头盒与比窗还高的干
      const winOf = (src: Binary): Binary => {
        const img = { w: W, h: H, data: new Uint8Array(W * H) } as Binary;
        for (let y = ry0; y <= ry1; y++)
          for (let x = rx0; x <= rx1; x++) {
            if (!src.data[y * src.w + x]) continue;
            if (heads.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h)) continue;
            img.data[(y - ry0) * W + (x - rx0)] = 1;
          }
        for (const v of prims.vSegs) {
          const vx = (v.x0 + v.x1) / 2, half = Math.max(1, v.maxLw / 2);
          const top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
          if (vx + half < rx0 || vx - half > rx1 || (top > ry0 && bot < ry1)) continue;
          for (let y = Math.max(ry0, Math.round(top)); y <= Math.min(ry1, Math.round(bot)); y++)
            for (let x = Math.max(rx0, Math.round(vx - half)); x <= Math.min(rx1, Math.round(vx + half)); x++) img.data[(y - ry0) * W + (x - rx0)] = 0;
        }
        return img;
      };
      if (!found) {
        const r = crossbarAccidentalBox(winOf(raster.bin), { x: 0, y: 0, w: W, h: H }, unit, true);
        if (r) {
          const box = { x: r.box.x + rx0, y: r.box.y + ry0, w: r.box.w, h: r.box.h };
          // 框宽要够一个临时记号（还原号约 0.6 格、升号 0.7~0.9 格），也不碰窗的上下边：别的笔画截一半也凑得出两道横
          const inside = r.box.y > 0 && r.box.y + r.box.h < H - 1;
          if (inside && box.w >= sp * 0.55 && Math.abs(box.y + box.h / 2 - hcy) <= sp * 0.8 && box.h <= sp * 3.2) found = { box, code: r.code };
        }
      }
      // 降号没有两道横：在修补图上按「通高竖笔 + 下半右边闭合肚子」认（`restshape.ts::flatAccidentalBox`）。
      // 竖笔被谱线切成几截、上端粘着前一个音的头，按块查不出（破碎 p8 m80 E♭4）
      if (!found) {
        const r = flatAccidentalBox(winOf(repaired), { x: 0, y: 0, w: W, h: H }, unit);
        if (r && r.y > 0 && r.y + r.h < H - 1) {
          const box = { x: r.x + rx0, y: r.y + ry0, w: r.w, h: r.h };
          if (Math.abs(cyOf(box) - hcy) <= sp * 0.8) found = { box, code: "accidentalFlat" };
        }
      }
      // 窄过 0.45 格的不是临时记号（抹干后剩下的一根竖条也配得上升号，恩友歌伴奏 m1）；
      // 与已认出的别的符号（行首调号、别的临时记号）交叠三成以上的是把它又截了一半（恩友歌伴奏 m13 行首调号的升号）
      if (!found || found.box.w < sp * ACC_HALF_W) continue;
      const hit = syms.filter((s0) => isAccidental(s0.code) && overlapFrac(found!.box, s0.box) > 0.3);
      if (hit.some(whole)) continue;
      const { code } = found;
      // 降号盒照前面字典认的一样收到肚子上（`FLAT_BOWL_TOP`）：挂头按盒中与头心同高
      const cut = code === "accidentalFlat" ? Math.round(found.box.h * FLAT_BOWL_TOP) : 0;
      const box = { ...found.box, y: found.box.y + cut, h: found.box.h - cut };
      // 交叠的只是半截：让给认全的。大半落在新框里、窄过它四分之三的别的碎块（升号右半被字典认成 wiggleTrill）一并去掉
      for (let i = syms.length - 1; i >= 0; i--) {
        const s0 = syms[i];
        const frag = !/^notehead/.test(s0.code) && s0.box.w < found.box.w * 0.75 && overlapFrac(s0.box, found.box) > 0.8;
        if (!hit.includes(s0) && !frag) continue;
        syms.splice(i, 1);
        const j = accs.indexOf(s0);
        if (j >= 0) accs.splice(j, 1);
      }
      syms.push({ box, code });
      accs.push({ box, code });
      ledger.claim(found.box, `accprobe:${code}`);
    }
  }
  // **盖住一个临时记号大半的空心头**是记号的竖笔、谱线与右边的头围出的那块白（是爱 p1 m14 手写降号与 B♭4/D5 之间，
  // 凸度 0.78、过了「上下贴线的凹孔」那道），真头只挨着记号，盖不到它一半
  for (let i = syms.length - 1; i >= 0; i--) {
    const s0 = syms[i];
    if (s0.code !== "noteheadHalf") continue;
    if (!syms.some((a) => isAccidental(a.code) && overlapFrac(a.box, s0.box) > ACC_UNDER_HEAD)) continue;
    syms.splice(i, 1);
  }
  // 行中的谱号只信「行中换谱号」那一路验过的：字典按块查出来的行中「谱号」多是误认（万古磐石歌八分二度连干带尾认成高音谱号），
  // 从前每行只用行首那个、它们不起作用；现在音高按位置取谱号，留着就把后半行读错
  for (let i = syms.length - 1; i >= 0; i--) {
    const s0 = syms[i];
    if (!isClef(s0.code) || midClefs.has(s0)) continue;
    const cy = s0.box.y + s0.box.h / 2;
    const sx = s0.box.x + s0.box.w / 2;
    const g = groups.find((q) => cy > yAt(q, 0, sx) - unit.space && cy < yAt(q, 4, sx) + unit.space);
    if (g && s0.box.x >= Math.max(...g.lines.map((l) => l.left)) + unit.space * MID_CLEF_FROM) syms.splice(i, 1);
  }
  const headBoxes = syms.filter((s0) => /notehead/i.test(s0.code)).map((s0) => ({ box: s0.box }));
  // **杠端落在小节线上：那里藏着一根干**。小节线不接符杠；小节末那个音的干离小节线只有两三像素时，
  // 抽竖段把两根并成了一根（破碎 p8 m77 钢琴右手 F4 十六分，干在小节线左边 3 像素），那个头没干、被并进前一个音的和弦。
  // 杠的一端落在一根纵贯谱表的竖线上、竖线左边紧贴着一个头（朝上的干贴头右缘）：从杠端到头心补一根干
  const barStems: LineSeg[] = [];
  {
    const tol = Math.max(3, unit.lineThick * 2);
    for (const q of prims.beams) {
      const ex = q.box.x + q.box.w;
      const ey = q.box.y + q.box.h;
      const bar = prims.vSegs.find((v) => {
        const vx = (v.x0 + v.x1) / 2;
        if (Math.abs(vx - ex) > tol) return false;
        const top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
        // 纵向要贴着这条杠（杠端在竖线上端附近）
        if (top > ey + unit.space || bot < ey + unit.space) return false;
        return groups.some((g) => top <= yAt(g, 0, vx) + unit.space * 0.3 && bot >= yAt(g, 4, vx) - unit.space * 0.3 && yAt(g, 0, vx) < ey + unit.space * 2 && yAt(g, 4, vx) > q.box.y);
      });
      if (!bar) continue;
      const bx = (bar.x0 + bar.x1) / 2;
      const h = headBoxes.find((hb) => hb.box.x + hb.box.w >= bx - tol - unit.space * 0.3 && hb.box.x + hb.box.w <= bx + 1 && hb.box.y > ey && hb.box.y < ey + unit.space * 5 && hb.box.y < Math.max(bar.y0, bar.y1));
      if (!h) continue;
      const x = Math.min(bx - 2, ex, h.box.x + h.box.w);
      const had = barStems.find((v) => Math.abs(v.x0 - x) < 2 && v.y1 === h.box.y + h.box.h / 2);
      if (had) had.y0 = Math.min(had.y0, q.box.y);
      else barStems.push({ x0: x, y0: q.box.y, x1: x, y1: h.box.y + h.box.h / 2, lw: unit.lineThick, maxLw: unit.lineThick });
    }
  }

  markShapeWholes(syms, nl, prims.vSegs, unit);
  opts.trace?.("syms", syms);
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
      ...sharedLegers(prims.hSegs, headBoxes, onGrid, unit),
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
    vSegs: snapHeadsToStems(syms, splitSecondStems(splitVoiceStems(extendVSegs(
      nl,
      joinThroughBars(raster.bin, joinVSegs(nl, [...prims.vSegs.filter((v) => !usedSegs.has(v)), ...stemSegs, ...inkStems], VSEG_JOIN_DX, Math.round(unit.space * VSEG_JOIN_GAP)), staffSpans, unit.space),
      Math.round(unit.space * 0.35),
      staffSpans,
      unit.lineThick,
    ).concat(barStems), headBoxes.map((h) => h.box), unit), syms, unit), unit),
    syms,
    braces: findBraces(nl, prims, unit, staffLefts, leftEdges).map((c) => c.bbox),
    sysBrackets: groupByLeftInk(raster.bin, leftEdges, unit),
    partBrackets: findPartBrackets(raster.bin, leftEdges, unit),
  });
  pg.ptPerUnit = raster.imageRect.w / raster.bin.w;
  pg.originPt = { x: raster.imageRect.x, y: raster.imageRect.y };
  pg.sizePt = { w: raster.pageWidth, h: raster.pageHeight };
  // 一像素合一点以上（不到 80dpi）：多半是图片封的单页 PDF（`jpegToPdf` 一像素记一点），页面尺寸不可信
  pg.sizeKnown = pg.ptPerUnit < LOW_DPI_SCALE;
  pg.textEm = 1 / TEXT_INK_EM;
  pg.inkTextSize = inkTextSizeOn(raster.bin);
  if (!findStaves(pg)) return withText(await emptyPage(pg, raster, unit));
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
  opts.trace?.("context", ctx);
  const notes = buildNotes(pg, ctx, beams, stems, hollowish);
  opts.trace?.("notes", notes);
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

  return finishRasterPage({ index, opts, source, raster, unit, live, textKey, textBoxes, textBin, groups, nl, staffLines, grid, prims, jianpuStrips, blobs, repaired, titleIds, harmonyStrips, harmonies, harmonyTexts, harmonyIds, contourStaves, cmap, ledger, rlayer, onGrid, restIds, claimed, dictClaimed, arpeggios, timeStrips, stemSegs, pg, ctx, carry, clefTally, beams, notes });
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
/**
 * 谱中无主块配升降号模板的签名距离上限（见「谱中没人认领的升降还原号」）。
 * 实测真升号 46~68（齐来称颂 m5、赞美三一真神 m8/m9），误配的最近一个 87（善牧恩慈歌线距 11px
 * 的一截竖笔），再往上是 102~180 一大片；拍号那一档 180 太松，通用的 90 也挡不住 87。
 */
const LOOSE_ACC_DIST = 80;

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
/** 劈成几截再拼的四分休止填充下限：劈口那道谱线去掉后修补只补回一部分墨（一婴孩为我们降生 女声 m8 细笔，0.31） */
const QREST_FILL_PIECES = 0.28;
/** 偏细的四分休止填充下限，与「本页已认出的同尺寸四分休止」互证才收；尺寸差上限（格） */
const QREST_FILL_THIN = 0.27;
const QREST_SAME = 0.15;
/** 两声部让位的四分休止：心离中线至多几格（见 `shiftedRest`） */
const QREST_SHIFT = 1.8;
/** 劈开的、偏细的四分休止那两路：最长竖墨占盒高过这么多的是降号 */
const QREST_FLAT_RUN = 0.8;
/** 降号被认成头 + 朝上短干：干短于几格（见上） */
const FLAT_STEM = 1.5;
/** 无干单个黑头：宽不到本页带干黑头中位宽的这么多倍的剔掉 */
const TINY_HEAD = 0.75;
const TINY_HEAD_H = 0.85;
/** 行中换谱号：离谱行左缘多少格以外才找（行首谱号 + 调号 + 拍号在这之内）。 */
const MID_CLEF_FROM = 5;
/** 行首谱号被切碎的行：取墨窗口从谱行左缘往右几格起（让过系统线）。 */
const CLEF_WIN_FROM = 0.5;
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
/** 琶音记号（竖波浪线）：块宽上限、高下限（格），逐行墨宽上限（格）。挂和弦时往右找几格见 `pagefinish.ts` 的 ARP_REACH。 */
const ARP_W = 0.6;
const ARP_H = 2.5;
const ARP_STROKE = 0.7;
/** 逐行墨中心的摆幅下限（格）、每格过零次数的范围。 */
const ARP_SWING = 0.1;
const ARP_RATE = [1.5, 3.2];
const MID_CLEF_ASPECT = 0.15;
const MID_CLEF_DIST = 130;
const MID_CLEF_FILL = 0.08;
/** 行首「谱号 + 调号」右沿往右这么多格里不收四分休止（没认出的调号、拍号在那里）。 */
const KEY_TAIL = 2;
/** 两截拼起来判的那两路（被谱线上下切开、球与斜笔左右断开）的高度下限：新编赞美诗那套小号字体的八分休止只有 1.55 格
 *（033、038 系统末那一排）。全局放到 1.4 时合唱谱是爱2 多出二十来个假八分休止（73.7 → 70.6）、独唱谱 −0.03，只给这两路 */
const EIGHTH_REST_H_PIECES = 1.4;
/** 斜笔连球一起被抽成竖段的八分休止：竖段长度（格）与斜率（横移 / 竖长）下限。是爱这类竖段斜 0.12~0.22。 */
const SLANT_REST_LEN = [1.3, 2.6] as const;
/** C 拍号放宽的那一档距离：最近的模板就是 C、又紧骑中线时用。 */
const TIME_C_LOOSE = 280;
/** 拍号列的宽度上限（格）：两位数分子的 12/8 宽近三格。 */
const TIME_WIDE = 3.6;
const SLANT_REST_SLANT = 0.1;
/** 本页空心头内腔宽（格，下四分位）低于这个才算「内腔窄」的手写粗圈页，叠头那几条按它缩放（`notehead.ts::hollowHeadsByPitch`）。 */
const CAV_NARROW = 0.85;
/** 被谱线切成两截、按不去线的墨接回来的八分休止：墨占比下限（望十架 p5 细笔扫描件 0.28；烛光颂曲管风琴右手细斜笔 0.23）。 */
const EIGHTH_REST_FILL_PIECES = 0.2;
