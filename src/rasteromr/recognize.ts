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
import type { TimeStrip } from "./timesig";
import type { Rect } from "../omrkit/types";
import { inkTextSize, TEXT_INK_EM } from "./textsize";
import { definePortable } from "./portablefn";
import { findStaves } from "../staffomr/page";
import { buildNotes, type BeamShape, type StaffContext, type StaffNote, type BarCheck } from "../staffomr/notedata";
import type { WordStrip } from "./words";
import type { HeaderCredit, WordLine } from "../omrkit/headertext";
import type { WedgeOpen, WedgeRows } from "../staffomr/notations";
import type { SPage, Staff } from "../staffomr/model";
import { buildRasterPage } from "./adapt";
import { extendVSegs, findBraces, findPrimitives, groupByLeftInk, findPartBrackets, joinVSegs, removeStaffLines, type RasterPrims } from "./prims";
import { markShapeWholes } from "./notehead";
import { RasterGlyphLookup } from "./rasterglyphs";
import type { JianpuStrip } from "./jianpuband";
import type { FuseStats, JianpuRow } from "./jianpufuse";
import type { LyricStrip, OcrChar } from "./lyric";
import type { ContourMap } from "./contour";
import type { LabelStrip } from "./stafflabel";
import type { HarmonyStrip, HarmonyToken } from "./harmony";
import type { RasterWedge } from "./wedge";
import type { RasterDynamic } from "./dynamics";
import { ContourLedger } from "./ledger";
import type { LyricLine } from "../staffomr/textanalyze";
import type { SlurArc } from "../staffomr/slur";
import { composeHeaderStrip } from "./pagecompose";
import { isTextStaff, pageTextKey, textDetScale } from "./pagetext";
import { LineGrid, lineYAt, type RasterUnit } from "./staffline";
import { findRasterStaves } from "./stafffind";
import { rasterizePage, type RasterPage } from "./rasterpage";
import { sharedLegers, ownLegers } from "./pitchgrid";
import { joinThroughBars } from "./barvote";
import { snapHeadsToStems, splitSecondStems, splitVoiceStems } from "./stems";
import { finishRasterPage } from "./pagefinish";
import { claimJianpuRows, claimTitleText, claimChordBand, buildClaimLedger } from "./stages/claims";
import { findWholeRests, findQuarterRests } from "./stages/rests";
import { hollowHeadsByCavity, splitMergedSolidHeads, headsOnBareStemEnds, splitHeadStemBlobs, rejudgeGatedBlobs, searchHollowByTemplate, resolveHangingHollow, slitSolidToHollow, addStemsForHalfNotes, hollowAlongStems, dropFarHeads, dedupeHeads } from "./stages/heads";
import { splitPairedAccidentals, rejoinAccidentalStrokes, findKeySigs, recountKeySigStrokes, fixSharpsAsHeads, matchUnclaimedAccidentals, shrinkFlatBoxes, accidentalsLeftOfHeads } from "./stages/accidentals";
import { recoverBrokenLeadClefs, reclassLeadClefs, markOctaveTrebleClefs, findMidClefChanges } from "./stages/clefs";
import { findArpeggios, relookMergedFragments, completeFinalBars, findAugDots, tidySymbols } from "./stages/marks";
import { findTimeSigs } from "./stages/timesig";
import { buildPageStructure, fixBeamsAndHeads, fixNotes, crossStaffProbes } from "./stages/structure";

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

/** 页面单位合 pt 的系数到这么大（≈80dpi）就当页面尺寸不可信（`SPage.sizeKnown`） */
const LOW_DPI_SCALE = 0.9;
/** 被符头隔断的竖段接回一根（`joinVSegs`）：中心差（px）、断口上限（格）。 */
const VSEG_JOIN_DX = 2;
const VSEG_JOIN_GAP = 1.2;

/** `staffBandOnly` 时谱表上下各留这么多个线距。扫过 1.5 / 2 / 3.5 格（《坚固保障》，和弦字母在上方 1.6 格处）：
 *  音符 74 / 75 / 80，其中 3.5 格那档有 5 个是被当成全音符的和弦字母。2 格是拐点。 */
const STAFF_BAND = 2;

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
 * 另有 `carry`：这一页拿到的上页沿用（`PageCarry`，普通数据），在第一次用到它时交出——回归测试据它单独重跑一页。
 */
export type RasterStage = "staves" | "blobs" | "syms" | "carry" | "context" | "notes" | "page";

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
  const carryOf = (): Promise<PageCarry> =>
    (carryP ??= (opts.carry ? opts.carry() : Promise.resolve({ carryTime: opts.carryTime, carryKey: opts.carryKey, wantHeader: opts.wantHeader, openWedges: opts.openWedges })).then((c) => {
      opts.trace?.("carry", c);
      return c;
    }));
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
  // ── 简谱行（混排谱）：**先于一切**认领
  const { staffGeoms, frames, jianpuBands, jianpuStrips, blobLabels, blobs, repaired, rBlobs, rBlobParts } = claimJianpuRows({ groups, raster, unit, prims, nl, onLedger, opts, staffLines });
  // ── 顶部大字号文字：**先认成标题**
  const { titleIds } = claimTitleText({ groups, unit, blobs });
  // ── 和弦带：**先于符头认领**
  const { harmonyStrips, harmonies, harmonyTexts, harmonyIds, harmonyMasks } = await claimChordBand({ prims, groups, unit, raster, jianpuBands, opts, live, yAt, blobs });
  // ── contour 层与认领账本
  const { contourStaves, cmap, ledger, rlayer, onGrid, inBand, offStaff, matchHollow } = buildClaimLedger({ groups, nl, unit, repaired, prims, onLedger, raster, yAt, look });
  // ── 整小节休止：**先摘出来，别让符头那一路吃掉**
  const { besideStem, restIds, restSyms, restStrokes, onBeamLine, beamsThrough, inBeamBody, beamStump, notHollow, allHoles, heads, claimed } = findWholeRests({ prims, unit, blobs, staffLines, grid, groups, staffLefts, yAt, raster, inBand, nl, cmap, rlayer, ledger, repaired, harmonyIds, titleIds, onGrid, matchHollow, offStaff });
  // ── 空心符头：按**内腔（洞）**再找一遍
  const { onLineOrGrid, rawHoles, holes, takenBoxes, barSegs, stacked, ledgerOnly, hollowMasks, inkStems } = hollowHeadsByCavity({ onGrid, grid, unit, raster, allHoles, heads, harmonyMasks, notHollow, prims, staffGeoms, nl, inBand, restStrokes, staffLines, groups });
  // ── 几个实心符头并成一块：按**谱内自举的 mask** 拆开
  const { masks, noBeam, masksNB, pitchGrid, onLineY, split, splitIds, dropHead, restTpl } = splitMergedSolidHeads({ raster, heads, stacked, unit, staffLines, nl, prims, onGrid, groups, grid, look, blobs, claimed, repaired });
  // ── **光杆符干端头的无主墨**（`notehead.ts::headsOnBareStems`）
  const { syms, dictClaimed, flatPieces, metIds } = headsOnBareStemEnds({ heads, dropHead, stacked, split, restSyms, blobs, claimed, inBand, staffGeoms, unit, prims, pitchGrid, raster, grid, notHollow, barSegs, takenBoxes, nl, beamStump, inBeamBody, ledgerOnly, ledger, look, groups, staffLines, besideStem });
  // ── **并排粘成一块的两个临时记号**：按竖笔之间的缝切开，两半各查一次字典
  splitPairedAccidentals({ blobs, claimed, dictClaimed, unit, nl, look, syms, ledger, groups, raster });
  // ── **行首谱号被切碎的行**：块图里只剩碎块（低分辨率页上低音谱号右半那道竖弧被抽成竖段抹掉，望十架扫描版 p10
  recoverBrokenLeadClefs({ groups, unit, yAt, syms, nl, ledger });
  // ── **行首谱号的种类按原图上的墨再定一次**
  reclassLeadClefs({ groups, unit, syms, raster, ledger });
  // ── **高音谱号底下挂着「8」的是低八度谱号**（男高音谱号，或带括号的「(8)」）
  const { midClefs } = markOctaveTrebleClefs({ groups, unit, syms, raster, ledger });
  // ── **行中换谱号**（小一号的谱号，印在小节中间或小节线前）
  findMidClefChanges({ nl, syms, unit, blobs, claimed, groups, yAt, midClefs, ledger });
  // ── **琶音记号**（和弦左边的竖波浪线）
  const { arpeggios } = findArpeggios({ blobs, unit, groups, nl, claimed, raster, syms, ledger });
  // ── 碎块并起来再查一次字典
  const { merged } = relookMergedFragments({ blobs, claimed, dictClaimed, flatPieces, syms, look, unit, prims, inBand, repaired, staffLines, besideStem, beamStump, ledger, rBlobs, rBlobParts, nl });
  // ── 升降号：把**被抽走的那道竖笔**并回来
  const { usedSegs, natFrom } = rejoinAccidentalStrokes({ restStrokes, syms, unit, blobs, claimed, dictClaimed, merged, prims, nl, look, ledger, raster });
  // ── 四分休止：**位置 + 形状自举**，字典兜不住
  findQuarterRests({ groups, yAt, unit, syms, raster, leftEdges, blobs, claimed, dictClaimed, merged, staffLines, staffLefts, nl, prims, ledger, cmap, usedSegs, rlayer, repaired });
  // ── 拍号：位置自举 + 模板验
  const { timeStrips, timeCols } = await findTimeSigs({ look, unit, nl, opts, live, syms, groups, blobs, claimed, restIds, harmonyIds, titleIds, splitIds, merged, dictClaimed, raster, ledger });
  // ── 调号：紧跟谱号的升降号，**位置兜底**
  const { keySp, sharpAsHeads, hasGapColumn, sharpBox } = findKeySigs({ unit, raster, groups, yAt, syms, blobs, dictClaimed, claimed, merged, nl, ledger, look });
  // ── 调号记号**按竖笔数**再定一次升降
  recountKeySigStrokes({ groups, unit, yAt, syms, raster });
  // ── 谱中的升号被当成两个黑符头
  fixSharpsAsHeads({ syms, keySp, sharpBox, hasGapColumn, ledger });
  // ── 谱中没人认领的升降还原号：按位置先验配模板
  matchUnclaimedAccidentals({ look, unit, blobs, claimed, dictClaimed, merged, syms, nl, raster, ledger });
  // ── 降号的盒要收到**下面那个肚子**上
  shrinkFlatBoxes({ syms });
  // ── 符头 + 符干（+ 符尾）并成一块：把头摘出来
  const { stemHeads, stemSegs } = splitHeadStemBlobs({ masks, blobs, metIds, merged, claimed, dictClaimed, syms, raster, unit, nl, restTpl, staffLines, inBand, ledger, pitchGrid, onLineY, prims, natFrom });
  // ── **被几何闸判否的块，交给页内自举的判别器再判一次**
  const { headTaken, stemBeside, solidBar } = rejudgeGatedBlobs({ heads, dropHead, split, stemHeads, stacked, syms, blobs, harmonyIds, unit, masks, raster, onLineY, claimed, dictClaimed, merged, onBeamLine, pitchGrid, ledger, noBeam, masksNB, groups, beamsThrough });
  // ── 空心头按模板再搜
  searchHollowByTemplate({ raster, syms, unit, groups, blobs, claimed, dictClaimed, merged, prims, ledger, nl, pitchGrid, inBand, holes, onLineOrGrid, onLineY });
  // ── 终止线/段落线：纵贯谱表的**实心条**补成竖段
  completeFinalBars({ unit, blobLabels, nl, blobs, claimed, dictClaimed, merged, groups, yAt, syms, prims, ledger, sharpAsHeads });
  // ── 附点：**位置 + 形状自举**，字典兜不住
  findAugDots({ nl, syms, unit, staffYs, grid, ledger, prims, raster, staffGeoms });
  // ── 悬在两级之间的**空心头**：按相邻线的相对位置取上下两个候选，模板定夺
  resolveHangingHollow({ hollowMasks, unit, syms, frames, raster, nl });
  // ── **实心头里藏着一道斜缝的其实是空心头**
  slitSolidToHollow({ unit, syms, prims, stemSegs, inkStems, raster });
  // ── 找不到竖段的二分头：**顺着头缘的墨柱补干**
  addStemsForHalfNotes({ unit, syms, prims, stemSegs, inkStems, nl, groups, yAt });
  // ── 沿着已挂了空心头的干补和弦里漏掉的空心头（`notehead.ts::hollowHeadsAlongStems`）
  hollowAlongStems({ raster, syms, unit, staffLines, nl, rawHoles, groups, prims, stemSegs, inkStems, yAt, staffGeoms, ledger, grid, beamsThrough, stemBeside, solidBar, pitchGrid, onLineY, headTaken, staffYs });
  // ── 离谱表太远、又没有加线链的符头不要
  dropFarHeads({ raster, unit, syms, groups, yAt });
  // ── 同一个头被两路各认一次：只留先认的那个
  dedupeHeads({ syms, unit });
  // ── 头左边贴着、没认出来的临时记号：在头左侧的窗里取墨查字典
  accidentalsLeftOfHeads({ unit, syms, nl, prims, look, repaired, raster, ledger });
  // ── 符号收尾：盖住临时记号的空心头、行中谱号只信验过的、杠端落在小节线上补干
  const { headBoxes, barStems } = tidySymbols({ syms, midClefs, groups, yAt, unit, prims });

  // ── 交页：建谱面（找不到谱表就交空页）
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
  // ── 谱面结构：符头、符干、符尾、小节线，谱号调号拍号（从这里起等上一页的沿用），系统与小节
  const { ctx, carry, clefTally } = await buildPageStructure({ pg, frames, unit, raster, nl, prims, harmonyMasks, ledger, carryOf, timeCols, harmonies, cmap, jianpuBands });
  // ── 符杠与符头：杠的层数、实心其实空心、细杠起头、贴头的四分休止、符尾盒里的头、谱表外的头按加线定音高
  const { beams, stems, hollowish } = fixBeamsAndHeads({ pg, unit, onGrid, grid, nl, prims, raster, look });
  // ── 拼音符
  opts.trace?.("context", ctx);
  const notes = buildNotes(pg, ctx, beams, stems, hollowish);
  opts.trace?.("notes", notes);
  // ── 音符修正：被认成音的升降号与休止、按音高配临时记号、同音、跨谱表、附点对、连音
  fixNotes({ notes, unit, raster, pg, nl, ctx, stems, beams, carry });
  // ── 跨谱表补漏：补漏音的探针、补附点的验点、不验点补附点的验空
  crossStaffProbes({ masks, unit, frames, hollowMasks, notes, raster, cmap, look, nl, pg, ctx, carry });

  // ── 交出整页结果
  return finishRasterPage({ index, opts, source, raster, unit, live, textKey, textBoxes, textBin, groups, nl, staffLines, grid, prims, jianpuStrips, blobs, repaired, titleIds, harmonyStrips, harmonies, harmonyTexts, harmonyIds, contourStaves, cmap, ledger, rlayer, onGrid, restIds, claimed, dictClaimed, arpeggios, timeStrips, stemSegs, pg, ctx, carry, clefTally, beams, notes });
}

/** 排查用：把一页的二值图取出来（识别坐标 = 像素坐标）。 */
export type { Binary };
