// 认一页里的符头（`recognizeRasterPage` 按顺序调）：按内腔找空心头、拆并在一块的实心头、光杆符干端头的无主墨、
// 头干并块摘头、几何闸判否的块再判、空心头按模板再搜与悬在两级之间的定夺、补干、沿干补和弦头、去远离谱表的头与重复的头。

import type { Binary, Rect, Component } from "../../omrkit/types";
import { LineGrid, type RasterUnit, type StaffLineRun, type StaffGroup, pitchPos, pitchY } from "../staffline";
import type { RasterPage } from "../rasterpage";
import { type RasterHead, mergeHoles, hollowHeadsFromHoles, hollowHeadsFromStackedHoles, hollowHeadsByPitch, hollowHeadsOnLedgers, probeBareStems, headsOnBareStems, headsBetweenStemPairs, archCavity, hollowHeadsFromCavities, hollowSlit, inkColumn, reseatHollowHeads, hollowHeadsOnStemSeeds, hollowHeadsAlongStems, stemOf } from "../notehead";
import { type RasterPrims, type LineSeg, blobImage, binSig } from "../prims";
import type { RasterSym } from "../adapt";
import { type HeadMask, buildHollowMasks, buildHeadMasks, splitHeadCluster, headFromStemBlock, solidHeadsAlongStems, scoreAt, scoreAtMasked } from "../headmask";
import { holeSolidity } from "../contour";
import { makePitchSteps, ledgerCandidates, makePitchGrid, type LineFrame } from "../pitchgrid";
import { solidInside, EIGHTH_REST_FILL_PIECES } from "./shared";
import { RasterGlyphLookup, type OutlineTemplate, matchTemplate } from "../rasterglyphs";
import { longestVRun, isStackedPair, isBarRest, nearRestLine, isEighthRest, tallStrokes, wholesByShape, openCavities } from "../restshape";
import { ContourLedger } from "../ledger";
import { median, overlapFrac } from "../../omrkit/geom";
import type { SmuflName } from "../../staffomr/glyphs";
import { vRunAt } from "../stems";
import { trainHeadClassifier, headProb } from "../headclass";
import { close, ellipseOpen, areaClose } from "../../omrkit/morph";
import { connectedComponents } from "../../omrkit/ccl";
import { findDots } from "../dots";

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
/** 干尖符尾根（`recognize.ts` 头 + 干块那段）：两个头之间贴着干那一条，去线图上至少这么多行有墨（符尾那一笔）。 */
const FLAG_STROKE_ROWS = 0.5;
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
/** 叠头斑点（见 `stackedSpot`）：至多几个头、高与「一个头高 + 整数格」差多少格以内。 */
const SPOT_STACK_MAX = 3;
const SPOT_STACK_TOL = 0.3;
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
/** 头盒中心离整音级这么多（级）以上算悬着，交模板定夺。 */
const SNAP_AMBIG = 0.25;
/** 悬着的空心头挪一级后，盒里整行没墨的行多出盒高这么多就不挪（见用处）。 */
const BLANK_MOVE = 0.25;
/** 离最近谱表外线超过这么多格的符头要有加线链才留。扫过 **3.75** / 4.25 / 4.75：93.47 / 93.32 / 93.23%。 */
const FAR_HEAD = 3.75;
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

/** 空心符头：按**内腔（洞）**再找一遍 */
export function hollowHeadsByCavity(c: {
  onGrid: (y: number, x?: number) => boolean;
  grid: LineGrid;
  unit: RasterUnit;
  raster: RasterPage;
  allHoles: Rect[];
  heads: RasterHead[];
  harmonyMasks: Rect[];
  notHollow: Map<number, Rect>;
  prims: RasterPrims;
  staffGeoms: { left: number; right: number; top: number; bottom: number; topAt: (x: number) => number; bottomAt: (x: number) => number; lift: ((x: number) => number) | undefined; }[];
  nl: Binary;
  inBand: (y: number, x?: number) => boolean;
  restStrokes: Set<LineSeg>;
  staffLines: StaffLineRun[];
  groups: StaffGroup[];
}): {
  onLineOrGrid: (y: number, x?: number) => boolean;
  rawHoles: Rect[];
  holes: Rect[];
  takenBoxes: Rect[];
  barSegs: LineSeg[];
  stacked: RasterSym[];
  ledgerOnly: (b: Rect) => boolean;
  hollowMasks: HeadMask[];
  inkStems: LineSeg[];
} {
  const { onGrid, grid, unit, raster, allHoles, heads, harmonyMasks, notHollow, prims, staffGeoms, nl, inBand, restStrokes, staffLines, groups } = c;
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
  const seams: Rect[] = [];
  const stacked: RasterSym[] = hollowHeadsFromHoles(nl, holes, unit, [...prims.vSegs, ...(prims.shortStems ?? [])], inBand, takenBoxes, barSegs, restStrokes, seams);
  // 并排两个全音符挤掉的接缝「头」从已认出的头里删掉（`hollowHeadsFromHoles` 的 `seams`）
  for (let i = heads.length - 1; i >= 0; i--) if (seams.includes(heads[i].box)) heads.splice(i, 1);
  for (let i = takenBoxes.length - 1; i >= 0; i--) if (seams.includes(takenBoxes[i])) takenBoxes.splice(i, 1);
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
  // 上面几路都没认的「8」字叠头：从中线切开再按内腔走一遍（`notehead.ts::hollowHeadsFromStackedHoles`）
  stacked.push(...hollowHeadsFromStackedHoles(nl, holes, unit, [...prims.vSegs, ...(prims.shortStems ?? [])], inBand, takenBoxes, barSegs, restStrokes));
  // **压着实心头的「空心头」不要**：一个位置上头只有一种，盒里有一块实心头大小、几乎满墨的地方，那是真头，
  // 这块「内腔」是它与旁边的升号、谱线围出来的白（破碎 p8 m84 钢琴右手 C♯5，升号右竖与头之间读成二分 C5，把真头挤掉）
  // 内腔窄的手写粗圈页（`cavW`）上，两圈相接处也是一块实墨，夹在两个孔之间的不算（`solidInside` 的 `holes`）
  for (let i = stacked.length - 1; i >= 0; i--) if (solidInside(raster.bin, stacked[i].box, unit.space, cavW ? rawHoles : undefined)) stacked.splice(i, 1);
  return { onLineOrGrid, rawHoles, holes, takenBoxes, barSegs, stacked, ledgerOnly, hollowMasks, inkStems };
}

/** 几个实心符头并成一块：按**谱内自举的 mask** 拆开 */
export function splitMergedSolidHeads(c: {
  raster: RasterPage;
  heads: RasterHead[];
  stacked: RasterSym[];
  unit: RasterUnit;
  staffLines: StaffLineRun[];
  nl: Binary;
  prims: RasterPrims;
  onGrid: (y: number, x?: number) => boolean;
  groups: StaffGroup[];
  grid: LineGrid;
  look: RasterGlyphLookup;
  blobs: Component[];
  claimed: Set<number>;
  repaired: Binary;
}): {
  masks: HeadMask[];
  noBeam: Binary;
  masksNB: HeadMask[];
  pitchGrid: (y: number, x?: number) => number | null;
  onLineY: (y: number, x?: number) => boolean;
  split: RasterSym[];
  splitIds: Set<number>;
  dropHead: Set<number>;
  restTpl: OutlineTemplate[];
} {
  const { raster, heads, stacked, unit, staffLines, nl, prims, onGrid, groups, grid, look, blobs, claimed, repaired } = c;
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
  return { masks, noBeam, masksNB, pitchGrid, onLineY, split, splitIds, dropHead, restTpl };
}

/** **光杆符干端头的无主墨**（`notehead.ts::headsOnBareStems`） */
export function headsOnBareStemEnds(c: {
  heads: RasterHead[];
  dropHead: Set<number>;
  stacked: RasterSym[];
  split: RasterSym[];
  restSyms: RasterSym[];
  blobs: Component[];
  claimed: Set<number>;
  inBand: (y: number, x?: number) => boolean;
  staffGeoms: { left: number; right: number; top: number; bottom: number; topAt: (x: number) => number; bottomAt: (x: number) => number; lift: ((x: number) => number) | undefined; }[];
  unit: RasterUnit;
  prims: RasterPrims;
  pitchGrid: (y: number, x?: number) => number | null;
  raster: RasterPage;
  grid: LineGrid;
  notHollow: Map<number, Rect>;
  barSegs: LineSeg[];
  takenBoxes: Rect[];
  nl: Binary;
  beamStump: (b: Rect, others: Rect[]) => boolean;
  inBeamBody: (b: Rect) => boolean;
  ledgerOnly: (b: Rect) => boolean;
  ledger: ContourLedger;
  look: RasterGlyphLookup;
  groups: StaffGroup[];
  staffLines: StaffLineRun[];
  besideStem: (b: Rect) => boolean;
}): {
  syms: RasterSym[];
  dictClaimed: Set<number>;
  flatPieces: Set<number>;
  metIds: Set<number>;
} {
  const { heads, dropHead, stacked, split, restSyms, blobs, claimed, inBand, staffGeoms, unit, prims, pitchGrid, raster, grid, notHollow, barSegs, takenBoxes, nl, beamStump, inBeamBody, ledgerOnly, ledger, look, groups, staffLines, besideStem } = c;
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
  return { syms, dictClaimed, flatPieces, metIds };
}

/** 符头 + 符干（+ 符尾）并成一块：把头摘出来 */
export function splitHeadStemBlobs(c: {
  masks: HeadMask[];
  blobs: Component[];
  metIds: Set<number>;
  merged: Set<number>;
  claimed: Set<number>;
  dictClaimed: Set<number>;
  syms: RasterSym[];
  raster: RasterPage;
  unit: RasterUnit;
  nl: Binary;
  restTpl: OutlineTemplate[];
  staffLines: StaffLineRun[];
  inBand: (y: number, x?: number) => boolean;
  ledger: ContourLedger;
  pitchGrid: (y: number, x?: number) => number | null;
  onLineY: (y: number, x?: number) => boolean;
  prims: RasterPrims;
  natFrom: (sx: number, seed: [number, number]) => Rect | null;
}): {
  stemHeads: RasterSym[];
  stemSegs: LineSeg[];
} {
  const { masks, blobs, metIds, merged, claimed, dictClaimed, syms, raster, unit, nl, restTpl, staffLines, inBand, ledger, pitchGrid, onLineY, prims, natFrom } = c;
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
      const rs = rm ?? (!straight && (isEighthRest(nl, b, c.area, unit, undefined, undefined, true) || (straddle && isEighthRest(nl, b, c.area, unit, undefined, EIGHTH_REST_FILL_PIECES))) ? { smufl: "rest8th" as SmuflName } : null);
      // 休止不会离谱表几格远：标题行的「你」字（我一生要赞美你，离第一线 8 格）配上了八分休止
      // 按盒的上沿、心、下沿任一处算：两行谱之间让位的八分休止心离谱表正好 3 格出头（是爱 p5 m68 低音谱表上方，下沿离顶线 2.1 格）
      if (rs && ![b.y, b.y + b.h / 2, b.y + b.h].some((y) => inBand(y))) continue;
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
  return { stemHeads, stemSegs };
}

/** **被几何闸判否的块，交给页内自举的判别器再判一次** */
export function rejudgeGatedBlobs(c: {
  heads: RasterHead[];
  dropHead: Set<number>;
  split: RasterSym[];
  stemHeads: RasterSym[];
  stacked: RasterSym[];
  syms: RasterSym[];
  blobs: Component[];
  harmonyIds: Set<number>;
  unit: RasterUnit;
  masks: HeadMask[];
  raster: RasterPage;
  onLineY: (y: number, x?: number) => boolean;
  claimed: Set<number>;
  dictClaimed: Set<number>;
  merged: Set<number>;
  onBeamLine: (b: Rect, ext?: number) => boolean;
  pitchGrid: (y: number, x?: number) => number | null;
  ledger: ContourLedger;
  noBeam: Binary;
  masksNB: HeadMask[];
  groups: StaffGroup[];
  beamsThrough: (b: Rect, ext?: number) => number;
}): {
  headTaken: (hb: Rect) => boolean;
  stemBeside: (b: Rect, between?: boolean) => boolean;
  solidBar: (b: Rect) => boolean;
} {
  const { heads, dropHead, split, stemHeads, stacked, syms, blobs, harmonyIds, unit, masks, raster, onLineY, claimed, dictClaimed, merged, onBeamLine, pitchGrid, ledger, noBeam, masksNB, groups, beamsThrough } = c;
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
    // **竖着叠起来的几个头开成一个高斑点**：手写三度和弦「8」字连成一团、中间压着加线，开运算抹不开（是爱 p1 m18 G5/B♭5
    // 1.33×1.96 格、p2 m20 E5/G5/B♭5 1.38×2.91 格）。宽像本页一个头（中位宽的 `SPOT_RULER`~`SPOT_RULER_MAX` 倍）、
    // 高正好是一个头高再加整数格（三度一格一个头，差不过 `SPOT_STACK_TOL` 格）的，按一格一个头切开，每个照单头的证据验
    const stackedSpot = (b: { x: number; y: number; w: number; h: number }) => {
      if (!medH || b.h / unit.space <= SPOT_H[1] || b.w < medW * SPOT_RULER || b.w > medW * SPOT_RULER_MAX) return [b];
      const n = Math.round((b.h - medH) / unit.space) + 1;
      if (n < 2 || n > SPOT_STACK_MAX || Math.abs(b.h - medH - (n - 1) * unit.space) > unit.space * SPOT_STACK_TOL) return [b];
      const hh = (b.h - (n - 1) * unit.space);
      return Array.from({ length: n }, (_, k) => ({ x: b.x, y: Math.round(b.y + k * unit.space), w: b.w, h: Math.round(hh) }));
    };
    const spotHeads: RasterSym[] = [];
    for (const c of spotComps) {
      for (const b of stackedSpot(c.bbox)) {
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
    }
    syms.push(...spotHeads);
  }
  return { headTaken, stemBeside, solidBar };
}

/** 空心头按模板再搜 */
export function searchHollowByTemplate(c: {
  raster: RasterPage;
  syms: RasterSym[];
  unit: RasterUnit;
  groups: StaffGroup[];
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  merged: Set<number>;
  prims: RasterPrims;
  ledger: ContourLedger;
  nl: Binary;
  pitchGrid: (y: number, x?: number) => number | null;
  inBand: (y: number, x?: number) => boolean;
  holes: Rect[];
  onLineOrGrid: (y: number, x?: number) => boolean;
  onLineY: (y: number, x?: number) => boolean;
}): void {
  const { raster, syms, unit, groups, blobs, claimed, dictClaimed, merged, prims, ledger, nl, pitchGrid, inBand, holes, onLineOrGrid, onLineY } = c;
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
}

/** 悬在两级之间的**空心头**：按相邻线的相对位置取上下两个候选，模板定夺 */
export function resolveHangingHollow(c: {
  hollowMasks: HeadMask[];
  unit: RasterUnit;
  syms: RasterSym[];
  frames: LineFrame[];
  raster: RasterPage;
  nl: Binary;
}): void {
  const { hollowMasks, unit, syms, frames, raster, nl } = c;
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
}

/** **实心头里藏着一道斜缝的其实是空心头** */
export function slitSolidToHollow(c: {
  unit: RasterUnit;
  syms: RasterSym[];
  prims: RasterPrims;
  stemSegs: LineSeg[];
  inkStems: LineSeg[];
  raster: RasterPage;
}): void {
  const { unit, syms, prims, stemSegs, inkStems, raster } = c;
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
}

/** 找不到竖段的二分头：**顺着头缘的墨柱补干** */
export function addStemsForHalfNotes(c: {
  unit: RasterUnit;
  syms: RasterSym[];
  prims: RasterPrims;
  stemSegs: LineSeg[];
  inkStems: LineSeg[];
  nl: Binary;
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
}): void {
  const { unit, syms, prims, stemSegs, inkStems, nl, groups, yAt } = c;
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
}

/** 沿着已挂了空心头的干补和弦里漏掉的空心头（`notehead.ts::hollowHeadsAlongStems`） */
export function hollowAlongStems(c: {
  raster: RasterPage;
  syms: RasterSym[];
  unit: RasterUnit;
  staffLines: StaffLineRun[];
  nl: Binary;
  rawHoles: Rect[];
  groups: StaffGroup[];
  prims: RasterPrims;
  stemSegs: LineSeg[];
  inkStems: LineSeg[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  staffGeoms: { left: number; right: number; top: number; bottom: number; topAt: (x: number) => number; bottomAt: (x: number) => number; lift: ((x: number) => number) | undefined; }[];
  ledger: ContourLedger;
  grid: LineGrid;
  beamsThrough: (b: Rect, ext?: number) => number;
  stemBeside: (b: Rect, between?: boolean) => boolean;
  solidBar: (b: Rect) => boolean;
  pitchGrid: (y: number, x?: number) => number | null;
  onLineY: (y: number, x?: number) => boolean;
  headTaken: (hb: Rect) => boolean;
  staffYs: (x: number) => number[][];
}): void {
  const { raster, syms, unit, staffLines, nl, rawHoles, groups, prims, stemSegs, inkStems, yAt, staffGeoms, ledger, grid, beamsThrough, stemBeside, solidBar, pitchGrid, onLineY, headTaken, staffYs } = c;
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
}

/** 离谱表太远、又没有加线链的符头不要 */
export function dropFarHeads(c: {
  raster: RasterPage;
  unit: RasterUnit;
  syms: RasterSym[];
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
}): void {
  const { raster, unit, syms, groups, yAt } = c;
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
}

/** 同一个头被两路各认一次：只留先认的那个 */
export function dedupeHeads(c: {
  syms: RasterSym[];
  unit: RasterUnit;
}): void {
  const { syms, unit } = c;
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
}
/** 本页空心头内腔宽（格，下四分位）低于这个才算「内腔窄」的手写粗圈页，叠头那几条按它缩放（`notehead.ts::hollowHeadsByPitch`）。 */
const CAV_NARROW = 0.85;
