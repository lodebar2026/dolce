// 位图五线谱一页识别的**后半程**：音拼好之后的挂接——演奏法与力度、声部标签、和弦、歌词、拍号兜底、混排谱的简谱纠错、
// 带方括号的三连音、文字指示与节拍器记号、贴着符头的演奏法、松叶、弧线，最后交出整页结果（`RasterPageResult`）。
//
// 原是 `recognize.ts::recognizeRasterPage` 末尾的一千行，原样搬出来：前半程（找谱表、认符号、拼音）留下的中间量
// 经 `PageFinishInput` 一并交过来，名字与那边的同名局部量一一对应，判据一条不改。
import { findNotations, attachNotations, attachDynamicTexts, applyTuplet, attachWedges, markLyricExtends } from "../staffomr/notations";
import { groupDynamics, findGluedDynamics } from "./dynamics";
import { findStaffLabels, labelKey, normalizeLabel } from "./stafflabel";
import { makeTextObj, makeSymObj } from "./adapt";
import { attachHarmonies, type LyricLine, buildLyricLines, attachLyrics, lyricObjLabel } from "../staffomr/textanalyze";
import { liftHarmonies, lyricsBelongBelow, keepGapRowOrder, foldBilingualLyrics, splitSmallEchoes, moveEchoLines, splitVoiceLyrics, numberVersesByScript, liftLyrics } from "./lyricpost";
import { type LyricStrip, type LyricRow, findLyricRows, stripOf, stripKey, lyricLayoutVerdict, isLatinRow, LATIN_MIN_CHAINED, type OcrChar, foldLyricChars, splitMixedChars, latinCells, mapCharsToCells, stripWithout, jumpTail } from "./lyric";
import type { Staff, PObj, SPage, Sym } from "../staffomr/model";
import type { Component, Rect, Binary } from "../omrkit/types";
import { type StaffNote, keyFifths, checkBars, lastTimeSignature, type BeamShape, type StaffContext } from "../staffomr/notedata";
import type { SmuflName } from "../staffomr/glyphs";
import { fixQuartersByBarSum } from "./rhythmfix";
import { fuseJianpu } from "./jianpufuse";
import { jianpuKey, type JianpuStrip } from "./jianpuband";
import { findRasterTuplets } from "./tuplet";
import { findWordStrips, findFrameStrips, findNameStrips, partNameLines, type HeaderStrip, findHeaderStrip, wordKey, headerZoneLines, attachWordLines } from "./words";
import { type WordLine, headerCredits } from "../omrkit/headertext";
import { smallCapsCase, inkTextSize } from "./textsize";
import { type Contour, candidateMap, traceContours, type ContourMap, type ContourStaff, type RepairedLayer } from "./contour";
import { findRasterArticulations } from "./artic";
import { findRasterWedges, findFusedWedges, findStrippedWedges } from "./wedge";
import { findRasterSlurs, findStubSlurs, findRasterDashedSlurs, findFusedSlurs, judgeArcUnion, extendArcEnds, traceSteepArcEnds, traceLongArcTails } from "./slur";
import { type SlurArc, attachSlurs, reconnectSlurs, markSlurNotes, orphanEdge, notTie } from "../staffomr/slur";
import { removeStaffLinesByRun, blobImage, type LineSeg, type RasterPrims } from "./prims";
import { mergeArcPieces, bridgeArcPieces, attachSlursByStem, attachWideSlurs, attachEdgeSlurEnds, attachEdgeSlurStarts, snapSlurEndsToStems, completeSlurEnds, tieChords } from "./slurattach";
import { touchesText } from "./pagetext";
import { unknownObjs } from "../staffomr/page";
import { lastKey } from "./keysig";
import type { ContourLedger } from "./ledger";
import { attachJumpMarks, type HarmonyStrip, type HarmonyToken } from "./harmony";
import type { RasterPage } from "./rasterpage";
import { liftOf, type LineGrid, type RasterUnit, type StaffGroup, type StaffLineRun } from "./staffline";
import type { TimeStrip } from "./timesig";
import type { ClefTally, PageCarry, PageSource, RasterLiveOcr, RasterPageOpts, RasterPageResult } from "./recognize";

/** 前半程交过来的中间量（`recognizeRasterPage` 里的同名局部量）。 */
export interface PageFinishInput {
  index: number;
  opts: RasterPageOpts;
  source: PageSource;
  raster: RasterPage;
  unit: RasterUnit;
  live: RasterLiveOcr | undefined;
  textKey: string | undefined;
  textBoxes: Rect[] | undefined;
  textBin: Binary | undefined;
  groups: StaffGroup[];
  nl: Binary;
  staffLines: StaffLineRun[];
  grid: LineGrid;
  prims: RasterPrims;
  jianpuStrips: JianpuStrip[];
  blobs: Component[];
  repaired: Binary;
  titleIds: Set<number>;
  harmonyStrips: HarmonyStrip[];
  harmonies: HarmonyToken[];
  harmonyTexts: HarmonyToken[];
  harmonyIds: Set<number>;
  contourStaves: ContourStaff[];
  cmap: ContourMap;
  ledger: ContourLedger;
  rlayer: RepairedLayer;
  onGrid: (y: number, x?: number) => boolean;
  restIds: Set<number>;
  claimed: Set<number>;
  dictClaimed: Set<number>;
  arpeggios: Rect[];
  timeStrips: TimeStrip[];
  stemSegs: LineSeg[];
  pg: SPage;
  ctx: Map<Staff, StaffContext>;
  carry: PageCarry;
  clefTally: ClefTally;
  beams: BeamShape[];
  notes: StaffNote[];
}

/** 版权行的字样（歌词里不会出现）：`©`、copyright、「版权所有」「获准使用」 */
const COPYRIGHT_RE = /©|copyright|版[权權]所有|[获獲]准使用/i;
/** 歌词条字高不到本页中位数的这个比例就不是歌词（页脚版权小字）。 */
const LYRIC_MIN_H = 0.4;
/** 不带连字符的拉丁行离带连字符的那行多近（字高的倍数）算同一块歌词。
 *  2.5 → 3：拉丁行的字高常只量到小写字母高（更亲近恩主 12px、行距 34px），末段后半「heights of joy…」链不进来。 */
const LATIN_CHAIN = 3;
/** 拉丁行靠中文歌词行作保时，那行中文至少这么多个汉字。 */
const CJK_SEED_MIN = 4;
/** 墨归字格：整块落在字格里时字格外放几格。 */
const CELL_OWN_PAD = 0.2;

/** 墨归字格：字格高、宽的上限（本行字号的倍数），撑大的格不算。 */
const CELL_OWN_H = 1.15;
const CELL_OWN_W = 1.3;

/** 墨归字格：墨块盒子宽高都占到格的这一比例就是格本身，不算字的一部分。 */
const CELL_OWN_FILL = 0.9;

/** 孤行离上面那行谱底最多几个线距（同末行谱下第一行歌词，`lyric.ts` 的 TAIL_FIRST） */
const LONE_FIRST = 6;
/** 歌词条里的墨迹列连成的块（条内像素 `[起 x, 止 x, 上 y, 下 y)`），横向缝不过 `gap`（页面像素）的并掉 */
function inkRuns(st: LyricStrip, gap: number): [number, number, number, number][] {
  const g = gap / (st.box.w / st.w);
  const top = new Int32Array(st.w).fill(-1);
  const bot = new Int32Array(st.w).fill(-1);
  for (let y = 0; y < st.h; y++)
    for (let x = 0; x < st.w; x++)
      if (st.data[y * st.w + x]) {
        if (top[x] < 0) top[x] = y;
        bot[x] = y + 1;
      }
  /** `[起 x, 止 x, 上 y, 下 y)`，条内像素 */
  const runs: [number, number, number, number][] = [];
  for (let x = 0; x < st.w; x++) {
    if (top[x] < 0) continue;
    const last = runs[runs.length - 1];
    if (last && x - last[1] <= g) {
      last[1] = x + 1;
      last[2] = Math.min(last[2], top[x]);
      last[3] = Math.max(last[3], bot[x]);
    } else runs.push([x, x + 1, top[x], bot[x]]);
  }
  return runs;
}
/** 孤行字高的下限（本页歌词条字高中位数的倍数） */
const LONE_MIN_H = 0.8;
/** 声部、乐器标签（短拉丁行里单独成词的不是歌词） */
const VOICE_LABEL_RE = /^(?:sopranos?|altos?|tenors?|bass(?:es)?|baritones?|men|women|all|solo|tutti|unis(?:on)?|div|piano|organ|choir|voices?)$/i;
/** 力度词（短拉丁行里单独成词的不是歌词） */
const DYNAMIC_WORD_RE = /^(?:p{1,4}|f{1,4}|m[pf]|s?fz|sf|rfz?|fp)$/;
/** 反复跳转字样（短拉丁行里单独成词的不是歌词：颂赞与尊贵谱末的「Fine」） */
const JUMP_WORD_RE = /^(?:fine|coda|D\.?C\.?|D\.?S\.?)$/i;
/** 表情、速度字样（短拉丁行里单独成词的不是歌词：望十架「rit」「slower」、爱是从神而来「dolce」） */
const EXPR_WORD_RE = /^(?:rit|ritard|riten|rall|accel|slower|faster|slowly|broadly|dolce|legato|cantabile|espr|espress|marcato|maestoso|sost|ten|tenuto|lento|largo|adagio|andante|moderato|allegro|vivace|simile|sim|subito|sub|calando|morendo|meno|piu|più|mosso|rubato|tranq|tranquillo)\.?$/i;
/** 表情文字的术语、页脚注的字样（OCR 不出空格，按连写匹配，**别收会落在连写词缝里的短串**：「For all gen-」连写含 rall、「Spirit.」含 rit.）：带这些的拉丁行不是歌词（望十架 p1 页脚「Words: … Tune: …」「Flute part is on page 43」）。
 *  页脚注另认：脚注号 `*` 打头、`Tune;`（OCR 常把冒号读成分号）、生卒年 `1844-1927`（望十架 p1「** Beneath the Cross of Jesus - Tune; ST. CHRISTOPHER, by Frederick C. Maker (1844-1927)」被收成男声一行歌词） */
const DIRECTION_TERM_RE = /tempo|cresc|poco|molto|unis\.|dim\.|rall\.|stagger|section|words[:;]|tune[:;]|music[:;]|page\d|copyright|©|^[*＊]|\d{4}[-–—]\d{4}/i;
/** 歌词账上来的弧，两端离头外缘的上限（格）。 */
const LYRIC_ARC_REACH = 1.5;
/** 歌词账上来的弧离文字框多远（格）以内仍按字的笔画裁决。 */
const TEXT_ARC_PAD = 0.5;
/** 免判的弧离谱表（上下线）不过这么多格。 */
const TEXT_ARC_STAFF = 2;
/** 跨小节线的延音线：在小节线左右这么多格的窗口里取修补图上连着的墨（弧两头各一个八分的距离）。 */
const BAR_TIE_REACH = 2;
/** 跨小节线的延音线两端各伸出小节线几格。 */
const BAR_TIE_CROSS = 0.3;
/** 按游程去线图上拼弧：两截之间的空隙上限、每截的高度上限（格）。弧顶贴线那段实测 0.3~1.1 格。 */
const RUN_BRIDGE = 1.2;
const RUN_PIECE_H = 1;
/** 按游程去线图上的块，逐列平均墨厚的上限（格）放宽到这么多：弧顶压线那段连着线一起留下，块比去线图上的厚（破碎 p2 m4 两个八分下方那条）。 */
const RUN_THIN_MEAN = 0.3;
/** 按游程补出来的短弧（不到 `RUN_FLAT_W` 格宽）高宽比上限：上沿并进谱线的空心头剩下下半个碗（1.3 格宽、高宽比 0.8，望十架 p1 m10），
 *  真的短弧在 0.5 以下；宽的不管——盒子常被连着的残线撑高（主我敬拜你 m11 那条 2.8×1.8 格） */
const RUN_FLAT = 0.6;
const RUN_FLAT_W = 2;
/** 松叶算「在上一行歌词下面」要低过字的下沿这么多格（`notations.ts::ownerStaff` 的歌词下沿按它往下让）。 */
const LYRIC_BELOW = 0.5;
/** 行首半截弧的窗口：第一个音左边几格以内；上下离谱表几格以内。 */
const STUB_LEAD = 3;
const STUB_REACH = 4;

/** 文字指示：OCR 读出的行与文字层的行合并（页眉、指示文字）。 */
function mergeLayerLines(ocr: readonly WordLine[], layer: readonly WordLine[]): WordLine[] {
  const out: WordLine[] = [];
  const near = (m: WordLine, l: WordLine, k: number) => {
    const h = Math.min(m.h, l.h);
    const vy = Math.min(m.y + m.h, l.y + l.h) - Math.max(m.y, l.y);
    const gap = Math.max(m.x, l.x) - Math.min(m.x + m.w, l.x + l.w);
    return vy >= h * (k < 1 ? 0.7 : 0.5) && gap <= Math.max(m.h, l.h) * k;
  };
  const join = (o: WordLine, l: WordLine) => {
    const [a, b] = o.x <= l.x ? [o, l] : [l, o];
    const x = Math.min(o.x, l.x);
    const y = Math.min(o.y, l.y);
    const r = Math.max(o.x + o.w, l.x + l.w);
    const bot = Math.max(o.y + o.h, l.y + l.h);
    Object.assign(o, { t: `${a.t} ${b.t}`, x, y, w: r - x, h: bot - y, size: o.size ?? l.size });
  };
  for (const l of [...ocr].sort((a, b) => a.x - b.x)) {
    const o = out.find((m) => near(m, l, 0.3) && Math.max(m.h, l.h) <= Math.min(m.h, l.h) * 1.5);
    if (o) join(o, l);
    else out.push({ ...l });
  }
  for (const l of layer) {
    const o = out.find((m) => near(m, l, 2));
    if (o) join(o, l);
    else out.push({ ...l });
  }
  return out;
}
/** 延音线弧端离那头音头最远多少格（真延音线实测 ≤1.05，从中间音起、止在中间音的圆滑线 ≥1.4）。 */
const TIE_HUG = 1.2;
/** 弧端改挂到中间音时，那个音头离弧端的纵向距离上限（格）：挂对的实测 ≤1.05（破碎扫描 m31），不该挂的 ≥1.8。 */
const TIE_MID_REACH = 1.3;
/** 弧右端离小节线至少这么多格，才算「止在线左边」（`attachSlurs` 之后的跨小节线检查） */
const SLUR_BAR_CLEAR = 0.3;

/** 和弦对象记上墨迹量出来的字高（`PObj.textSize`）：`sizeDev` 是框高，判据在用，不动它 */
function withTextSize(o: PObj, pg: SPage, t: { box: Rect; text: string }): PObj {
  const h = pg.inkTextSize?.(t.box, t.text);
  if (h) o.textSize = h;
  return o;
}

/** 琶音记号挂到和弦上：竖波浪线右边往外找几格（线宽、高的判据见 `recognize.ts` 的 ARP_W 那组）。 */
const ARP_REACH = 2.5;

/** 一页的后半程（见文件头）。 */
export async function finishRasterPage(s: PageFinishInput): Promise<RasterPageResult> {
  const { index, opts, source, raster, unit, live, textKey, textBoxes, textBin, groups, nl, staffLines, grid, prims, jianpuStrips, blobs, repaired, titleIds, harmonyStrips, harmonies, harmonyTexts, harmonyIds, contourStaves, cmap, ledger, rlayer, onGrid, restIds, claimed, dictClaimed, arpeggios, timeStrips, stemSegs, pg, ctx, carry, clefTally, beams, notes } = s;
  // ── 演奏法与力度 ─────────────────────────────────────────────────────────
  //
  // 这三步矢量路一直在跑（`staffomr/pagerun.ts`），位图路**从来没调过**——所以力度
  // 一个都没进过 MusicXML，而字典其实早就认得出：实测宁静 p2 那个 `f`
  // 到 Maestro 的 `dynamicForte` 模板只有 19（字典里 `dynamicForte` 26 个实例、
  // `dynamicMP` 8 个）。缺的只是这一句挂接。
  const marks = findNotations(pg);
  // 贴着符头的那几样（保持音、断奏、重音）不按「x 最近」挂：字典里叫 `articTenuto*` 的九成是谱线残段，
  // 留给后面的 `findRasterArticulations` 按与符头的关系判
  const articSyms = marks.marks.filter((m) => /^artic/.test(m.code));
  // 颤音波浪线是横着走的一截；字典认成 `wiggleTrill` 的竖块（高过宽）是被谱线切下来的符尾下半截、
  // 琶音的一段之类（宁静 p3 m39 八分符尾、破碎扫描 p1 m7），不当颤音挂
  const isUprightWiggle = (m: Sym) => m.code.startsWith("wiggleTrill") && m.box.bottom - m.box.top > m.box.right - m.box.left;
  attachNotations(pg, notes, marks.marks.filter((m) => !/^artic/.test(m.code) && !isUprightWiggle(m)));
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
  // 粘了弧、连了笔的力度字典按整块查不着：拿本页认出的 `f` 当模板在大块里找（`dynamics.ts`）
  dynamics.push(...findGluedDynamics(marks.dynamics, cmap, unit, dynamics));
  const placedDyn = attachDynamicTexts(pg, notes, dynamics);
  // OCR 读出来的力度只让给**挂上了**的那些：字形那一路认出来却没挂上的（印在终止线外：爱是从神而来 p5 m63 `p`），OCR 那份照补
  const dynHeld = dynamics.filter((_, i) => placedDyn.has(i));

  // ── 声部标签 ────────────────────────────────────────────────────────────
  //
  // 条子**不论有没有缓存都要切**（与歌词字格同一条道理：切出来这件事本身
  // 就是「这块墨是标签」的判断）；认字靠 `labelOcr` 缓存，没缓存就只出条子。
  // 弯、斜的谱行带上逐列偏移（五线共用一条），文字条随它取带
  const liftFor = (st: Staff) => {
    const g = groups.find((q) => Math.abs(q.lines[0].y - st.box.top) < unit.space);
    return g && liftOf(g.lines[0]);
  };
  const lifted = pg.staves.map((st) => {
    const lift = liftFor(st);
    return { box: st.box, index: st.index, ...(lift ? { lift } : {}) };
  });
  const labelStrips = findStaffLabels(raster.bin, lifted, unit);
  const labelOcr = opts.labelOcr ?? (live ? await live.label(labelStrips) : undefined);
  const staffLabels = new Map<number, string>();
  for (const st of labelStrips) {
    const txt = labelOcr?.get(labelKey(st));
    const name = txt ? normalizeLabel(txt) : null;
    if (name) staffLabels.set(st.staff, name);
  }

  // ── 和弦：挂到音符上 ────────────────────────────────────────────────────
  //
  // 记号在上面（找符头之前）就切好了，这里只把它们造成文本对象交给矢量路那一套
  // ——分行、拼根音与后缀、挂给**下方 x 最近**的音符，一行不改。
  if (harmonies.length) {
    const objs = harmonies.map((t, i) =>
      withTextSize(makeTextObj(pg.objs.length + i, { cells: [{ box: t.box, ch: t.text }], sizeDev: t.box.h }), pg, t));
    for (const o of objs) o.addTag("Harmony");
    pg.objs.push(...objs);
    // `merge = false`：记号已经按和弦文法切好了，别再按左右相接拼一次
    attachHarmonies(pg, notes, objs, false);
    liftHarmonies(notes, pg.normalStaffSpace || pg.space);
  }

  // ── 和弦带里的跳转记号（D.S. al Fine、Fine、𝄋）：见 `harmony.ts::attachJumpMarks`
  attachJumpMarks(pg, notes, harmonyTexts, unit.space);

  // ── 歌词 ────────────────────────────────────────────────────────────────
  //
  // **不走 `analyzeText`**：那一步靠「带连字符的音节」「音节间的延长线」当锚点
  // 把文本认成歌词，中文逐字一个音节、既不连字也不拉线，一整行一个锚点都没有。
  // 位图这边本来就是**按位置**切出歌词带的（谱行下方那条带），身份已经确定，
  // 直接造成文本对象交给 `buildLyricLines` / `attachLyrics`——那两步原样跑。
  const lyricLines: LyricLine[] = [];
  /** OCR 认得出字的歌词行的字格（弧的候选按归属剔字的笔画用） */
  const lyricCells: Rect[] = [];
  const lyricStats = { rows: 0, hit: 0, parity: 0 };
  const lyricStrips: LyricStrip[] = [];
  // 字格**不论有没有 OCR 缓存都要切**：切出来的字格是「这块墨是歌词」这一判断本身，
  // 与认不认得出那个字是两回事。账本按字格记一笔，无主表里才不会把整页歌词
  // 当成「从没看见的墨」（缓存没命中时曾经就是这样，覆盖率一下子低二十个点）。
  /** 各行谱下方歌词的下沿：松叶隔着上一行的歌词、紧贴着下一行谱的，归下一行（`notations.ts::ownerStaff`，与矢量路同一条） */
  const lyricBottom = new Map<Staff, number>();
  /** 文字带里 OCR 读出来的力度（松叶那一步剔掉压在力度字上的） */
  const ocrDynamics: { px: number; py: number; text: string }[] = [];
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
    // **孤行**（一行只印一个音节：宁静女高 m32 尾句「人」、Gloria 散在各系统的「ri」「a」）：每个字格都正对上面那行谱的一个音、
    // 离谱表不远、离下一行谱也不贴着才收；力度框里的不算。读出来是不是字交给 OCR 之后那一道（字高、字形，见下面出歌词对象处）
    const keepLone = (row: LyricRow, normal: LyricRow[]) => {
      const st = pg.staves[row.staffIndex];
      if (!st) return false;
      const sp = unit.space;
      const top = Math.min(...row.cells.map((c) => c.y));
      const bot = Math.max(...row.cells.map((c) => c.y + c.h));
      // 弯、斜的谱行按这一行所在 x 处的末线
      const stBot = st.bottomAt((Math.min(...row.cells.map((c) => c.x)) + Math.max(...row.cells.map((c) => c.x + c.w))) / 2);
      if (top - stBot < sp * 0.5 || top - stBot > sp * LONE_FIRST) return false;
      // 不比本页歌词首行贴谱表近太多（首行离谱表距离中位数的六成）：谱表下的倒延长号（弧加一点）读成「心」，离谱表不到一格，歌词首行在两格开外（新编 209）
      const firstOff = new Map<number, number>();
      for (const r of normal) {
        const s0 = pg.staves[r.staffIndex];
        if (!s0) continue;
        const off = Math.min(...r.cells.map((c) => c.y)) - s0.box.bottom;
        firstOff.set(r.staffIndex, Math.min(firstOff.get(r.staffIndex) ?? Infinity, off));
      }
      const offs = [...firstOff.values()].filter((v) => v > 0).sort((a, b) => a - b);
      if (offs.length && top - stBot < offs[offs.length >> 1] * 0.6) return false;
      const next = pg.staves[row.staffIndex + 1];
      if (next && next.box.top - bot < sp) return false;
      const xs = notes.filter((n) => n.staff === st && !n.rest).map((n) => (n.sym.box.left + n.sym.box.right) / 2);
      return row.cells.every((c) => {
        if (c.h > sp * 2.2 || c.w < sp * 0.4) return false;
        // 碰着已认出的音头的不是字（破碎 m39 低音谱表下第三加线的 D2 连着加线成了一格）
        if (notes.some((n) => c.x < n.sym.box.right && c.x + c.w > n.sym.box.left && c.y < n.sym.box.bottom && c.y + c.h > n.sym.box.top)) return false;
        if (dynamics.some((d) => d.box && c.x < d.box.right && c.x + c.w > d.box.left && c.y < d.box.bottom && c.y + c.h > d.box.top)) return false;
        const cx = c.x + c.w / 2;
        return xs.some((x) => Math.abs(x - cx) <= Math.max(sp, c.w * 0.5));
      });
    };
    const rows = findLyricRows(
      [...blobs.filter((c) => (!claimed.has(c.id) || orphanHead(c)) && !dictClaimed.has(c.id)), ...segBlobs],
      lifted.map(({ box, lift }) => ({ top: box.top, bottom: box.bottom, left: box.left, right: box.right, ...(lift ? { lift } : {}) })),
      unit,
      keepLone,
    );
    // **谱表上方文字行里的假音**：系统行首谱表上方印的「（副歌）」之类小字，圈状的笔画被认成符头
    //（新编赞美诗里四十来首在副歌那一行行首多出一个 D6；加线是按头的位置补出来的，查加线拦不住）。
    // 系统最上面那行谱、头心高出第五线 1.25 格以上、又落在一条文字行的字格跨度里的，是字不是音。
    {
      // 要落在**某一个字格里**（不是整行的跨度里），且那一行是六个字以内的短标签：合唱谱上一个系统最末一行歌词、
      // 速度术语就在下一个系统最上面那行谱的上方，按行跨度判会罩住女高上加线的真音（合唱谱扫描档音符 80.7 → 75.1；
      // 只限短标签、仍按跨度判 79.9）
      const spans = rows.filter((row) => !row.lone && row.cells.length >= 2 && row.cells.length <= 6).flatMap((row) => row.cells.map((c) => ({ x0: c.x, x1: c.x + c.w, y0: c.y, y1: c.y + c.h })));
      const pad = unit.space * 0.1;
      const topStaves = new Set(pg.systems.map((sy) => sy.staves[0]));
      const inText = (n: StaffNote) => {
        // 只看系统最上面那行：下面那行的上方就是歌词，男高的 D4、E4 带着上加线正落在歌词行的跨度里
        if (n.rest || !topStaves.has(n.staff)) return false;
        const bx = n.sym.box;
        const cx = (bx.left + bx.right) / 2;
        const cy = (bx.top + bx.bottom) / 2;
        if (cy > n.staff.topAt(cx) - unit.space * 1.25) return false;
        return spans.some((q) => cx >= q.x0 - pad && cx <= q.x1 + pad && cy >= q.y0 - pad && cy <= q.y1 + pad);
      };
      for (let i = notes.length - 1; i >= 0; i--) if (inText(notes[i])) notes.splice(i, 1);
    }
    // 孤行是猜的，等 OCR 那道验过才记账（下面出歌词对象处）：先记了，验不过的那格墨也成了「歌词」，
    // 弧的一截落在里面就按字的弯笔从严判（Holy Holy Holy m14 低音那条圆滑线丢了）
    const claimRow = (row: LyricRow) => {
      for (const cell of row.cells) ledger.claim(cell, "lyric");
      const st = pg.staves[row.staffIndex];
      // 往下让半格：与歌词同一高度、印在末字右边的松叶，中心比字的下沿还低几个像素（爱是从神而来 p5 m63 女声那条），不算在歌词下面
      if (st) lyricBottom.set(st, Math.max(lyricBottom.get(st) ?? -Infinity, ...row.cells.map((c) => c.y + c.h + unit.space * LYRIC_BELOW)));
    };
    for (const row of rows) if (!row.lone) claimRow(row);
    const objs = [];
    lyricStats.rows = rows.length;
    const stripRow = new Map<LyricStrip, LyricRow>();
    for (const row of rows) {
      const strip = stripOf(nl, row, 2, raster.lyricGray ?? raster.gray);
      if (strip) {
        lyricStrips.push(strip);
        stripRow.set(strip, row);
      }
    }
    const ocr = opts.lyricOcr ?? (live ? await live.lyric(lyricStrips) : undefined);
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
      // **先按排法判**（`lyricLayoutVerdict`：词距、音节对不对得上音）：成段的文字（脚注、版权、说明）不收；
      // 按音符拉开、逐个对着音的直接当种子，不必带连字符。排法判不了的再看连字符与字样
      const noteXsOf = new Map<number, number[]>();
      const verdict = (st: LyricStrip) => {
        const si = stripRow.get(st)!.staffIndex;
        let xs = noteXsOf.get(si);
        if (!xs) noteXsOf.set(si, (xs = notes.filter((n) => n.staff === pg.staves[si] && !n.rest).map((n) => (n.sym.box.left + n.sym.box.right) / 2)));
        return lyricLayoutVerdict(st, xs, unit.space);
      };
      const verdicts = new Map((ocr ? lyricStrips : []).map((st) => [st, verdict(st)] as const));
      const cand = (ocr ? lyricStrips : []).filter((st) => { const ch = ocr!.get(stripKey(st)); return ch && verdicts.get(st) !== "text" && isLatinRow(ch, false, LATIN_MIN_CHAINED) && !DIRECTION_TERM_RE.test(ch.map((c) => c.ch).join("")); });
      for (const st of cand) if (isLatinRow(ocr!.get(stripKey(st))!) || (verdicts.get(st) === "lyric" && isLatinRow(ocr!.get(stripKey(st))!, false))) latinStrips.add(st);
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
    // **短拉丁音节行**（字母不到 `LATIN_MIN_CHAINED`：花腔 Gloria 拆在各系统的「Glo」「ri」「a」）：
    // 压在力度框里的字母（`f` 读成 T）先剔掉，剩下的每个词都正对上面那行谱的一个音才收。
    // 单个大写字母不收（排练号），带表情术语、力度词的不收
    /** 剔过力度字母的 OCR 字（短拉丁行用） */
    const charsFix = new Map<LyricStrip, OcrChar[]>();
    for (const st of ocr ? lyricStrips : []) {
      if (latinStrips.has(st)) continue;
      const row = stripRow.get(st)!;
      const staff = pg.staves[row.staffIndex];
      const chs0 = ocr!.get(stripKey(st));
      if (!staff || !chs0 || chs0.some((c) => /\p{Script=Han}|\d/u.test(c.ch))) continue;
      const xOf = (c: OcrChar) => st.box.x + c.xFrac * st.box.w;
      const sy0 = st.box.y, sy1 = st.box.y + st.box.h;
      const chs = chs0.filter((c) => !dynamics.some((d) => d.box && xOf(c) >= d.box.left - unit.space * 0.3 && xOf(c) <= d.box.right + unit.space * 0.3 && d.box.top < sy1 && d.box.bottom > sy0));
      const letters = chs.filter((c) => /[A-Za-z]/.test(c.ch));
      if (!letters.length || letters.length >= LATIN_MIN_CHAINED || letters.length < chs.length * 0.8) continue;
      // 按条里的空白列分词（OCR 不吐空格，`xFrac` 一个字常差半个字宽：「Glo」的 G 估在 l 左边 29px）：
      // 墨迹列连成块，缝不过一个字高的并成一个词（G 的左半被别处认领、条里只剩一截，与 l 隔着 12px），字按 `xFrac` 落进最近的词
      const runs = inkRuns(st, st.charH);
      const words: OcrChar[][] = runs.map(() => []);
      for (const c of [...letters].sort((a, b) => a.xFrac - b.xFrac)) {
        const x = c.xFrac * st.w;
        let bi = 0;
        runs.forEach(([a, b], i) => {
          const d = x < a ? a - x : x > b ? x - b : 0;
          const d0 = x < runs[bi][0] ? runs[bi][0] - x : x > runs[bi][1] ? x - runs[bi][1] : 0;
          if (d < d0) bi = i;
        });
        if (runs.length) words[bi].push(c);
      }
      const used = runs.map((r, i) => ({ r, w: words[i] })).filter((q) => q.w.length);
      // 条里说不清的墨块（没读出字母、不在力度框里、又不是连字符那样的扁短横）：碎笔画、符号凑的条，OCR 碰巧吐个字母（钢琴两行之间读出「e」）
      const sxr = st.box.w / st.w;
      const stray = runs.some(([a, b, y0, y1], i) => {
        if (words[i].length) return false;
        if (y1 - y0 <= st.charH * 0.3 / sxr) return false;
        const x0 = st.box.x + a * sxr, x1 = st.box.x + b * sxr;
        return !dynamics.some((d) => d.box && x0 < d.box.right + unit.space * 0.3 && x1 > d.box.left - unit.space * 0.3);
      });
      // 单个字母只收 a、I、O（英文里自成一词的）：落单的「s」「e」多是碎笔
      if (stray || (letters.length === 1 && !/^[aIO]$/.test(letters[0].ch))) continue;
      const texts = used.map((q) => q.w.map((c) => c.ch).join(""));
      const all = letters.map((c) => c.ch).join("");
      if (!used.length || VOICE_LABEL_RE.test(all) || texts.some((t) => /^[A-Z]$/.test(t) || DYNAMIC_WORD_RE.test(t) || JUMP_WORD_RE.test(t) || EXPR_WORD_RE.test(t) || VOICE_LABEL_RE.test(t) || DIRECTION_TERM_RE.test(t))) continue;
      const xs = notes.filter((n) => n.staff === staff && !n.rest).map((n) => (n.sym.box.left + n.sym.box.right) / 2);
      const aligned = used.every(({ r: [a, b] }) => {
        const x0 = st.box.x + a * sxr, x1 = st.box.x + b * sxr;
        const cx = (x0 + x1) / 2;
        return xs.some((x) => Math.abs(x - cx) <= Math.max(unit.space * 1.2, (x1 - x0) * 0.35));
      });
      // 碰着已认出的音头的不是字（耶和华是我的牧者 p1 下声部带加线的符头、符杠读成「ePpaaaa」）
      const sy = st.box.h / st.h;
      const onHead = used.some(({ r: [a, b, y0, y1] }) => {
        const x0 = st.box.x + a * sxr, x1 = st.box.x + b * sxr, yy0 = st.box.y + y0 * sy, yy1 = st.box.y + y1 * sy;
        return notes.some((n) => !n.rest && x0 < n.sym.box.right && x1 > n.sym.box.left && yy0 < n.sym.box.bottom && yy1 > n.sym.box.top);
      });
      if (!aligned || onHead) continue;
      latinStrips.add(st);
      charsFix.set(st, chs);
    }
    /** 行首印着段号的歌词对象。 */
    const verseObjs = new Set<PObj>();
    for (const strip of ocr ? lyricStrips : []) {
      let chars = charsFix.get(strip) ?? ocr!.get(stripKey(strip));
      if (!chars) continue; // 缓存没命中：这一条没跑过 OCR，宁可留空不编造
      lyricStats.hit++;
      // 汉字歌词行尾印着的跳转记号（祢話如甘霖二房末「…華美！Fine.」）：摘出来挂成谱表下方的文字指示，不当英文歌词
      const tail = jumpTail(chars);
      if (tail) {
        chars = tail.rest;
        const x = strip.box.x + tail.xFrac * strip.box.w;
        const st = pg.staves.filter((q) => q.box.bottom < strip.box.y && x > q.box.left && x < q.box.right + unit.space).sort((a, b) => b.box.bottom - a.box.bottom)[0];
        const row = st ? notes.filter((n) => n.staff === st && !n.chordExtra && !n.grace && n.x <= x).sort((a, b) => a.x - b.x) : [];
        const n = row[row.length - 1];
        if (n) {
          const box = { left: x, right: strip.box.x + strip.box.w, top: strip.box.y, bottom: strip.box.y + strip.box.h };
          (n.words ??= []).push({ text: tail.text, above: false, size: strip.charH, baseY: box.bottom, box });
        }
      }
      // **页脚小字不是歌词**：赞美三一真神末行下面的版权行（字高 12，歌词 34~41）离低音谱表
      // 不到两个谱表高，被收成男声的第 1 段
      // 短拉丁音节（`charsFix`，已按音位验过）放宽到一半：「Glo」字高按块高中位数量，小写字母只有汉字的三成多
      if (strip.charH < medH * LYRIC_MIN_H * (charsFix.has(strip) ? 0.5 : 1)) continue;
      // **版权行按字样剔**：字号只比歌词小一半上下的（你的信实广大末行下「词曲 © 1923 … Hope publishing Company」「版权所有 获准使用」字高 16、23，
      // 歌词 39）过得了上面的字高闸，被收成低音谱表下的第 1、2、4 段
      if (COPYRIGHT_RE.test(chars.map((c) => c.ch).join(""))) continue;
      // **三格以内、认不出一半字的条不收**：谱表紧下方带加线的低音被切成一条（赞美三一真神
      // 末系统 3 格只认出一个「户」），占掉第 1 段，后面四段整体下移一段
      if (strip.cells.length <= 3 && !latinStrips.has(strip) && foldLyricChars(chars).length < strip.cells.length * 0.5) continue;
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
      // 孤行（`keepLone` 放进来的）例外：读出来的全是汉字才收
      const lone = stripRow.get(strip)!.lone;
      // 字高要够本页歌词的八成（「乙」「万」是 18px 的碎笔画，歌词字 30 开外）、字格不扁（「二」是两道横）
      if (lone && !latin) {
        const okChars = foldLyricChars(chars).length >= 1 && chars.every((c) => /\p{Script=Han}|[，。、；：！？,.;:!?]/u.test(c.ch));
        const okSize = strip.charH >= medH * LONE_MIN_H && strip.cells.every((c) => c.box.h >= c.box.w * 0.7);
        if (!okChars || !okSize) continue;
      }
      if (!latin && !lone && foldLyricChars(chars).length <= 1) continue;
      if (lone) claimRow(stripRow.get(strip)!);
      // **中英混在一条的切成两份**，各出一个文本对象（见 `splitMixedChars`）：拉丁那份归英文段
      const mix = splitMixedChars(chars);
      const parts = mix
        ? [latinCells(strip, mix.la), mapCharsToCells(stripWithout(strip, mix.spans), mix.zh)]
        : [latin ? latinCells(strip, chars, charsFix.has(strip) ? 1 : undefined) : mapCharsToCells(strip, chars)];
      // 「字数 == 格数」这个结构指标只对汉字行有意义（拉丁行压根不切格）
      if (!latin && !mix && foldLyricChars(chars).length === strip.cells.length) lyricStats.parity++;
      // 行首印着段号（「1.」「2、」）：OCR 读出来、折叠时剔掉了，这里记一笔——段号是歌词的强判据（`lyricsBelongBelow`）
      // 只认一位数：页顶标题前的诗歌编号（有一位神「23.有一位神」）也是「数字 + 点」
      // 段号照印的记下来（「1.」「2、」），挂到这一行最左那个对象的首字上（`textanalyze.ts::lyricObjLabel`）
      const lead = [...chars].sort((a, b) => a.xFrac - b.xFrac).map((c) => c.ch).join("");
      const verseNo = /^[1-9][.．、]/.exec(lead)?.[0];
      // 英文段常印不带点的「1 Be」：拉丁行数字后面跟着大写字母的也是段号（只记下来，不当歌词归属的判据）。
      // 跟小写的不算：那多半是首字「I」读成了「1」（求主同住「1need」、更亲近恩主「1am」）
      const label = verseNo ?? (latin && !mix ? /^[1-9](?=\s*[A-Z‘’'"“])/.exec(lead)?.[0] : undefined);
      const made: PObj[] = [];
      for (const cells of parts) {
        if (!cells.some((c) => c.ch)) continue;
        const o = makeTextObj(pg.objs.length + objs.length, { cells, sizeDev: strip.charH });
        o.addTag("Lyric");
        objs.push(o);
        made.push(o);
        if (verseNo) verseObjs.add(o);
      }
      const first = made.reduce<PObj | null>((a, o) => (!a || o.box.left < a.box.left ? o : a), null);
      if (label && first) lyricObjLabel.set(first, label);
    }
    pg.objs.push(...objs);
    // 认得出字的行，字格留着给弧的候选按归属剔笔画用（没读出字的「行」可能就是谱表上方一排小弧本身，破碎 p5 钢琴右手）
    // 只收大小正常的格：粘上了旁边的弧、被撑高撑宽的格（破碎 p7 m71 女低两个音下方的小弧粘着下面「救」字）不算
    for (const r of readRows) lyricCells.push(...r.cells.filter((c) => c.h <= r.charH * CELL_OWN_H && c.w <= r.charH * CELL_OWN_W));
    // **歌词行里的「符头」是字的笔画**：歌词离谱表近的底本（《是谁》第一段歌词只在谱表下
    // 1.8 格），字里的横笔被当成加线、口字框被当成符头，认成谱表下五六条加线的 G3/C3
    // ——一行两三个，整首十来个假音。只剔**认得出汉字**的那几行、**中心**落在行内的；
    // 真的低音符头中心离谱表不过一两格，碰不到歌词行（行上沿在谱表下 1.8 格）。
    if (readRows.length) {
      const stemSegsLyr = pg.segsWithTag("Stem");
      const inRow = (n: StaffNote) => {
        const cx = (n.sym.box.left + n.sym.box.right) / 2;
        const cy = (n.sym.box.top + n.sym.box.bottom) / 2;
        // 谱表**上方**也一样：两行谱之间的词归上一行谱，可字的笔画被收成头时落到了下一行谱的上加线区
        //（倚靠主永远膀臂 m3「穌」、大地风光 m3「愛」，低音谱表上方 2.4 格的空心头）
        // 首末线按头所在 x 取（弯、斜的谱线）
        const stTop = n.staff.topAt(cx);
        const stBot = n.staff.bottomAt(cx);
        const below = cy >= stBot + unit.space;
        // 上方只看两格开外：一两格上的是上加线的真音，上一行谱的歌词紧贴着它（当我们回到天家末行八个高音、−2.7）
        // 只剔空心头（字里的口字框才围得出内腔）：实心的多半是高声部的真音（合唱谱扫描档 −0.15）
        // 离顶线三格（谱表带）以内的休止也不剔：钢琴两手之间让位的八分休止正压在上一行谱的歌词字格上（是爱 p5 m68 低音谱表上方，心离顶线 2.3 格）；
        // 歌词整行离谱表远，字收成的假休止心在三格半开外（望十架 p5 m41、p8 m64，3.6、4.0 格）
        if (!below && (cy > stTop - unit.space * 2 || n.sym.code === "noteheadBlack" || (n.rest && cy > stTop - unit.space * 3))) return false;
        // 谱表下的头挂着一根往上伸进谱表的干：字的笔画没有这种干（破碎 p10 m91 男低 B♮3，还原号的尾巴伸进「體」的字格，字格撑到了头心）
        if (below && n.stemUp === true && stemSegsLyr.some((sg) => sg.top <= stBot && sg.bottom >= n.sym.box.top && Math.abs(sg.cx - n.sym.box.right) <= unit.space * 0.3)) return false;
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
          const far = below ? cy >= stBot + unit.space * 2 : cy <= stTop - unit.space * 2;
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
    keepGapRowOrder(pg, lyricLines);
    foldBilingualLyrics(pg, lyricLines);
    splitSmallEchoes(pg, lyricLines, notes, unit.space);
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
  if (!carry.carryTime && pg.staves.every((st) => !(ctx.get(st)?.time.length))) {
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
      fixQuartersByBarSum(pg, ctx, notes, carry.carryTime, unit.space);
    }
  }

  // ── 混排谱：简谱行给五线谱纠错 ──────────────────────────────────────────
  //
  // 放在歌词挂完之后：纠的是音高与时值，删的是简谱对不上的多余音——
  // 挂歌词那一步要看到**所有**候选音才挂得准，先删了反而让字挂错位。
  const jianpuOcr = opts.jianpuOcr ?? (live && jianpuStrips.length ? await live.jianpu(jianpuStrips) : undefined);
  const jianpuFix = jianpuOcr && jianpuStrips.length
    ? fuseJianpu(
      notes,
      jianpuStrips,
      (strip) => pg.staves.find((st) => Math.abs(st.box.top - groups[strip.staff].lines[0].y) < unit.space),
      (strip) => jianpuOcr.get(jianpuKey(strip)),
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
  const wordStrips = opts.wordOcr || opts.wantWordStrips || live?.word ? findWordStrips(raster.bin, lifted, unit) : [];
  // 带里的方框（排练号、框着的段落名）另切一条单独读（`findFrameStrips`）
  wordStrips.push(...findFrameStrips(wordStrips, unit));
  // 声部名带（行首缩进与页边）：认字同文字指示带，归位另走（`partNameLines`）
  const nameStrips = opts.wordOcr || opts.wantWordStrips || live?.word ? findNameStrips(raster.bin, pg.systems.map((sy) => ({ staves: sy.staves.map((st) => lifted[pg.staves.indexOf(st)]) })), unit) : [];
  const wordOcr = opts.wordOcr ?? (live?.word ? await live.word([...wordStrips, ...nameStrips]) : undefined);
  if (wordOcr) pg.partNames = partNameLines(pg, nameStrips, wordOcr);
  // 页眉（曲首页）：标题、词曲作者。认字同文字指示带，缓存另放
  let headerStrip: HeaderStrip | null = carry.wantHeader ? findHeaderStrip(raster.bin, lifted, unit) : null;
  // 谱图里切不出页眉带、谱图又没顶到页顶的（排版软件出的 PDF，标题是另贴的小图块与文字层）：拼出谱图上方那一段（`pagecompose.ts`）
  let layerLines: WordLine[] = [];
  if (carry.wantHeader && !headerStrip) {
    const comp = await source.composeHeader(raster.bin.w);
    if (comp) (headerStrip = comp.strip), (layerLines = comp.texts);
  }
  const headerOcr = opts.headerOcr ?? (headerStrip && live?.header ? await live.header([headerStrip]) : undefined);
  // 首行谱上方那一段（`creditFrom` 以下）只留像署名的行，其余归文字指示带；留下的那几行文字指示带就不再读
  const ocrLines = headerStrip ? headerOcr?.get(wordKey(headerStrip)) : undefined;
  // 页眉带底常压着首行谱上方的和弦行：OCR 偶尔把和弦字母连着符干读成汉字（有一位神「F♯m」读成「衡拉」），
  // 框有一半落在认出的和弦上的行不算页眉（页眉带在谱图里从页顶切起，带内坐标就是页面坐标，挪列只差几像素）
  const onChord = (l: WordLine) =>
    !!headerStrip &&
    harmonies.some((t) => {
      const x = headerStrip!.box.x + l.x, y = headerStrip!.box.y + l.y;
      const ix = Math.min(x + l.w, t.box.x + t.box.w) - Math.max(x, t.box.x);
      const iy = Math.min(y + l.h, t.box.y + t.box.h) - Math.max(y, t.box.y);
      return ix > 0 && iy > 0 && ix * iy > l.w * l.h * 0.5;
    });
  const headRows = ocrLines || layerLines.length ? mergeLayerLines((ocrLines ?? []).filter((l) => !onChord(l)), layerLines) : undefined;
  const headerLines = headRows && headerStrip?.creditFrom !== undefined ? headerZoneLines(headRows, headerStrip.creditFrom, headerStrip.w) : headRows;
  const headerZone: Rect[] =
    headerLines && headerStrip?.creditFrom !== undefined
      ? headerLines.filter((l) => l.y + l.h / 2 > headerStrip!.creditFrom!).map((l) => ({ x: headerStrip!.box.x + l.x, y: headerStrip!.box.y + l.y, w: l.w, h: l.h }))
      : [];
  // 页眉字号按墨迹量（OCR 框高带留白）。在页眉带自己的像素上量：排版软件出的 PDF 页眉不在谱图里（`composeHeaderStrip` 另拼的）
  const header = (headerStrip && headerLines ? headerCredits(headerLines, headerStrip) : []).map((c) => {
    const st = headerStrip!;
    const box = { x: c.box.x - st.box.x, y: c.box.y - st.box.y, w: c.box.w, h: c.box.h };
    // 小型大写读成的全大写改回首字母大写（`smallCapsCase`），字号照改过的字折
    const text = smallCapsCase(st, box, c.text);
    const ink = inkTextSize(st, box, text);
    return ink ? { ...c, text, size: ink } : { ...c, text };
  });
  if (wordOcr) {
    const skip: Rect[] = [
      // 认下来的歌词行：从行顶往下两格半（`LyricLine` 只记行顶），左右以首尾音节为界
      ...lyricLines.filter((ln) => ln.syllables.length >= 3).map((ln) => {
        const l = Math.min(...ln.syllables.map((sy) => sy.left));
        const r = Math.max(...ln.syllables.map((sy) => sy.right));
        return { x: l - unit.space, y: ln.top - unit.space * 0.5, w: r - l + unit.space * 2, h: unit.space * 3 };
      }),
      ...harmonies.map((t) => ({ x: t.box.x, y: t.box.y, w: t.box.w, h: t.box.h })),
      ...headerZone,
    ];
    // **文字指示里的字母收成了音**：谱表上方的「Unison」「coda」，字母的圈被认成头、没有干读成全音符（是爱 p4 m55 三个 B♭5）。
    // OCR 认得出的文字行（三个以上拉丁字母或两个以上汉字）框里、在谱表外、没挂干的音删掉；挂了干的不动（贴着字的真音）
    {
      const wordBoxes: Rect[] = [];
      for (const strip of wordStrips)
        for (const l of wordOcr.get(wordKey(strip)) ?? [])
          if (/[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/.test(l.t)) wordBoxes.push({ x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h });
      const pad = unit.space * 0.1;
      const inWord = (n: StaffNote) => {
        if (n.rest || n.stemUp !== null) return false;
        const b = n.sym.box;
        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
        if (cy > n.staff.topAt(cx) - unit.space * 0.5 && cy < n.staff.bottomAt(cx) + unit.space * 0.5) return false;
        return wordBoxes.some((q) => cx >= q.x - pad && cx <= q.x + q.w + pad && cy >= q.y - pad && cy <= q.y + q.h + pad);
      };
      for (let i = notes.length - 1; i >= 0; i--) {
        if (!inWord(notes[i])) continue;
        const next = notes[i + 1];
        if (!notes[i].chordExtra && next?.chordExtra && next.staff === notes[i].staff) next.chordExtra = undefined;
        notes.splice(i, 1);
      }
    }
    const placed = attachWordLines(pg, notes, wordStrips, wordOcr, unit, skip, lyricStrips.map((st) => st.box));
    ocrDynamics.push(...placed.dynamics);
    // 文字带里读出来的和弦记号：和弦带那一路（要自己的 OCR 缓存，合唱谱没生成）没认到和弦时才用
    if (!harmonies.length && placed.chords.length) {
      const objs = placed.chords.map((t, i) => withTextSize(makeTextObj(pg.objs.length + i, { cells: [{ box: t.box, ch: t.text }], sizeDev: t.box.h }), pg, t));
      for (const o of objs) o.addTag("Harmony");
      pg.objs.push(...objs);
      attachHarmonies(pg, notes, objs, false);
      liftHarmonies(notes, unit.space);
    }
    // OCR 读出来的力度只补按字形那一路没认到的地方（三格内已有的不重复挂）
    attachDynamicTexts(pg, notes, placed.dynamics.filter((d) => !dynHeld.some((q) => Math.abs(q.px - d.px) <= unit.space * 3 && Math.abs(q.py - d.py) <= unit.space * 2)));
  }

  // ── 贴着符头的演奏法记号（保持音 / 断奏 / 顿音 / 重音 / 延长记号）──────────────
  //
  // 放在歌词之后（歌词字的点画已经有主）、松叶与弧线之前（延长记号的弧够宽够拱，不先摘走就成了一条圆滑线）。
  //
  // 演奏法记号、松叶都在**候选 contour 图**上找（`candView`）：压线的保持音、重音、穿线的松叶在修补图上是一整块，不在去线图上切成碎块再拼
  /** 候选 contour 图与它上面的账：碎块全是 `loose`（无主，或只被这几样认过）的修补块整块换进来；
   *  合并块的账取它那几块碎块的并集，谱线那一笔不算（谱线残段在修补图上已清掉，剩下的才是这个对象） */
  const candView = (loose: (by: string) => boolean, accept?: (rc: Contour) => boolean) => {
    const cv = candidateMap(cmap, rlayer, (id) => ledger.claimsOf(id).every((q) => q.by === "seg:Staff" || loose(q.by)), 2, accept);
    const claimsOf = (id: number): string[] => {
      const ps = cv.parts.get(id);
      if (!ps) return ledger.claimsOf(id).map((q) => q.by);
      return [...new Set(ps.flatMap((p) => ledger.claimsOf(p).map((q) => q.by)))].filter((by) => by !== "seg:Staff");
    };
    return { map: cv.map, claimsOf, unclaimed: () => cv.map.contours.filter((c) => !claimsOf(c.id).length) };
  };
  {
    const taken: Rect[] = pg.symbols.filter((s0) => s0.hasTag("Augmentation")).map((s0) => ({ x: s0.box.left, y: s0.box.top, w: s0.box.right - s0.box.left, h: s0.box.bottom - s0.box.top }));
    // 合并的候选与 `findRasterArticulations` 里另收的有主小记号同口径：只被符杠、歌词、附点认过的也算
    const av = candView((by) => by === "beam" || by === "lyric" || by === "dict:augmentationDot");
    for (const a of findRasterArticulations(pg, av.map, unit, notes, articSyms, av.unclaimed(), taken, av.claimsOf)) ledger.claim(a.box, `artic:${a.code}`);
  }

  // ── 松叶 ────────────────────────────────────────────────────────────────
  //
  // 只在**无主**的 contour 里找：认出来的符号不必再判一遍，而松叶从来没人认领。
  // 松叶只取谱表外并起来的：扫描件谱表里断续的谱线残段在修补图上连成一团，也张得开（破碎扫描版 p7、望十架 p1 各一处）
  const wv = candView(() => false, (rc) => rc.place.zone !== "in");
  // 行首、行尾：本行第一个音头之前、最后一个音头之后（跨系统松叶的一截落在这里，`pairArms` 的尖端闸放宽）
  const rowEdge = (x: number, y: number): boolean => {
    const st = pg.staves.filter((s0) => y >= s0.box.top - unit.space * 10 && y <= s0.box.bottom + unit.space * 10).sort((p, q) => Math.abs((p.box.top + p.box.bottom) / 2 - y) - Math.abs((q.box.top + q.box.bottom) / 2 - y))[0];
    if (!st) return false;
    const xs = notes.filter((n) => n.staff === st).map((n) => n.sym.px);
    // 谱表右端一格以内也算行尾：末音紧挨着行尾小节线时，续到下一行的那截尖端在末音之上（破碎 m89 钢琴渐弱）
    return xs.length > 0 && (x < Math.min(...xs) || x > Math.max(...xs) + unit.space * 2 || x >= st.box.right - unit.space);
  };
  // 只被符杠认过的整团也判一次（宁静 m85 男声、m86 女声那两条四十格长的渐强，两臂被横段抽取当成了符杠）：
  // 只走整团判据（逐列两段墨、一头尖一头张），不当臂去配——一根斜符杠单看就是一条直臂
  const claimedByBeamOnly = (id: number) => {
    const cl = wv.claimsOf(id);
    return cl.length > 0 && cl.every((by) => by === "beam");
  };
  const wedgeBeamOnly = wv.map.contours.filter((c) => c.w >= 4 && c.h <= 3 && claimedByBeamOnly(c.id));
  const wedges = findRasterWedges(wv.map, unit, wv.unclaimed(), rowEdge, wedgeBeamOnly);
  // 开口顶到小节线、与小节线连成一团的（`findFusedWedges`）
  wedges.push(...findFusedWedges(cmap, unit, cmap.contours.filter((c) => ledger.claimsOf(c.id).some((k) => k.by === "seg:BarLine"))));
  // 和符干、符杠、圆滑线粘成一大团的（`findStrippedWedges`）：够宽、比松叶的高度闸还高、还没认成松叶的团
  {
    // 只有候选图那一路的团号能拿来排除（小节线那一路带 `box`、团号是去线图的，同号不同团）
    const got = new Set(wedges.filter((w) => !w.box).flatMap((w) => [w.contourId, w.pairedId]));
    const pool = wv.map.contours.filter((c) => c.w >= 3 && c.h > 3 && !got.has(c.id));
    // 小节线那一路（`findFusedWedges`）用的是去线图，团号对不上：按位置去重。
    // 重叠的：原来那条也是切出来的（小节线那一路常只切出半截，宁静 m22 钢琴）、同一种、长出一格以上的换掉，不然留原来的。
    // 整团判出来的不换：剥团的候选随歌词认领变（OCR），换了会时有时无（宁静 m105 人声两条）
    for (const w of findStrippedWedges(wv.map, unit, pool, contourStaves, rowEdge)) {
      const i = wedges.findIndex((q) => Math.abs(q.cy - w.cy) < unit.space && Math.min(q.x1, w.x1) - Math.max(q.x0, w.x0) > 0.5 * Math.min(q.x1 - q.x0, w.x1 - w.x0));
      if (i < 0) wedges.push(w);
      else if (wedges[i].box && wedges[i].type === w.type && w.x1 - w.x0 > wedges[i].x1 - wedges[i].x0 + unit.space) wedges[i] = w;
    }
  }
  // **压在力度字上的不是松叶**：斜体 p 的竖笔与圆肚子逐列看也是两段墨、往右张开（破碎 p2 m8 钢琴那个 p 认成了一条 2 格宽的渐强）
  {
    const sp = unit.space;
    const dynBoxes = [
      ...dynamics.map((d) => d.box ?? { left: d.px, right: d.px + sp, top: d.py - sp * 0.5, bottom: d.py + sp * 0.5 }),
      ...ocrDynamics.map((d) => ({ left: d.px, right: d.px + sp * d.text.length, top: d.py - sp * 0.5, bottom: d.py + sp * 0.5 })),
    ];
    for (let i = wedges.length - 1; i >= 0; i--) {
      const w = wedges[i];
      if (w.x1 - w.x0 > sp * 4) continue;
      const cx = (w.x0 + w.x1) / 2;
      if (dynBoxes.some((b) => cx >= b.left - sp * 0.3 && cx <= b.right + sp * 0.3 && w.cy >= b.top - sp * 0.3 && w.cy <= b.bottom + sp * 0.3)) wedges.splice(i, 1);
    }
  }
  for (const wg of wedges) {
    if (wg.box) {
      ledger.claim(wg.box, `wedge:${wg.type}`);
      continue;
    }
    for (const id of [wg.contourId, wg.pairedId]) {
      const c = id === undefined ? null : wv.map.byId.get(id);
      if (c) ledger.claim(c.bbox, `wedge:${wg.type}`);
    }
  }
  const wedgeRows = attachWedges(pg, notes, wedges.map((w) => (w.box ? { ...w, fromBlob: true } : w)), lyricBottom, carry.openWedges);

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
  // **墨归哪个字**：整块落在一个歌词字格里（外放 `CELL_OWN_PAD` 格）的是那个字的笔画，不当弧的候选
  //（你的信实广大 m2「你」左上那一撇挂成了 E4→E4 延音线）；伸出字格的才可能是弧（谱表外的弧伸进歌词带上沿）
  const ownPad = unit.space * CELL_OWN_PAD;
  // 墨块几乎占满整格的不算（格里只有它自己：OCR 把一条小弧读成了「一」之类，破碎 p10 女低）
  const inCell = (b: Rect) =>
    lyricCells.some((q) => b.x >= q.x - ownPad && b.y >= q.y - ownPad && b.x + b.w <= q.x + q.w + ownPad && b.y + b.h <= q.y + q.h + ownPad && !(b.w >= q.w * CELL_OWN_FILL && b.h >= q.h * CELL_OWN_FILL));
  const beamOnly = cmap.contours.filter((c) => {
    const cl = ledger.claimsOf(c.id);
    if (cl.some((k) => k.by === "lyric") && inCell(c.bbox)) return false;
    const ok = cl.length > 0 && cl.every((k) => k.by === "beam" || k.by === "lyric" || k.by === "seg:Staff");
    if (ok && cl.some((k) => k.by === "lyric")) lyricArcBoxes.add(`${c.bbox.x},${c.bbox.y}`);
    return ok;
  });
  // **在修补图上取候选**（`prims.ts::repairLineCuts`）：贴着线斜穿的弧去线时断成几截，补回压线那几列后整条一块。
  // 修补图上的一块，组成它的去线图碎块全是候选（无主或只被符杠、歌词、谱线认过）才整块判；
  // 连上了别的东西（符头、干）的，退回去线图上一块一块判（同以前）
  { const D = (globalThis as any).process?.env?.SLDBG?.split(",").map(Number); if (D) for (const c of cmap.contours) { const b = c.bbox; if (b.x + b.w < D[0] || b.x > D[2] || b.y + b.h < D[1] || b.y > D[3]) continue; console.log("DBG", c.id, b, "w", c.w.toFixed(2), "h", c.h.toFixed(2), "cmp", c.compact.toFixed(3), "area", c.area, ledger.claimsOf(c.id).map((k) => k.by).join("|"), "arc?", findRasterSlurs(cmap, unit, [c], 0, repaired).map((a) => [a.lx, a.ly, a.rx, a.ry])); } }
  // 行首行尾的窗口：各行谱第一个音之前、最后一个音之后那段（半截弧只在这里找，同一处起笔的分叉也只在这里拆）
  const edgeWins: Rect[] = [];
  for (const st of pg.staves) {
    const sp = unit.space;
    const ns = notes.filter((n) => n.staff === st && !n.rest);
    if (!ns.length) continue;
    const first = Math.min(...ns.map((n) => n.sym.box.left)), last = Math.max(...ns.map((n) => n.sym.box.right));
    const y = st.box.top - sp * STUB_REACH, h = st.box.bottom - st.box.top + sp * STUB_REACH * 2;
    edgeWins.push({ x: first - sp * STUB_LEAD, y, w: sp * (STUB_LEAD + 0.5), h });
    edgeWins.push({ x: last - sp * 0.5, y, w: st.box.right - last + sp * 1.5, h });
  }
  const inEdgeWin = (b: Rect) => edgeWins.some((w) => b.x >= w.x && b.x + b.w <= w.x + w.w && b.y >= w.y && b.y + b.h <= w.y + w.h);
  const candIds = new Set([...ledger.unclaimed(), ...beamOnly].map((c) => c.id));
  const cand = candidateMap(cmap, rlayer, (id) => candIds.has(id));
  const whole = cand.merged;
  /** 整块判过的修补块里的去线碎块，不再单独判 */
  const covered = new Set(whole.flatMap((rc) => cand.parts.get(rc.id)!));
  const slurs = findRasterSlurs(cand.map, unit, whole, pg.objs.length + pg.segs.length + 1000, undefined, undefined, inEdgeWin);
  // 修补块判成了弧的，碎块已归它；没判成的修补块里的碎块也照旧单独判一次（补线连上了别的细墨，整块不像弧）
  const wholeHit = new Set(slurs.map((sl) => `${sl.obj.box.left},${sl.obj.box.top}`));
  const singles = [...ledger.unclaimed(), ...beamOnly].filter((c) => {
    if (!covered.has(c.id)) return true;
    const rc = whole.find((q) => cand.parts.get(q.id)!.includes(c.id))!;
    return !wholeHit.has(`${rc.bbox.x},${rc.bbox.y}`);
  });
  slurs.push(...findRasterSlurs(cmap, unit, singles, pg.objs.length + pg.segs.length + 1000 + slurs.length, repaired, undefined, inEdgeWin));
  // 歌词账上来的块：修补块里含着歌词碎块的也算
  for (const rc of whole) if (cand.parts.get(rc.id)!.some((id) => ledger.claimsOf(id).some((k) => k.by === "lyric"))) lyricArcBoxes.add(`${rc.bbox.x},${rc.bbox.y}`);
  // 跨行弧的半截（`slur.ts::findStubSlurs`）：只看各行谱第一个音之前、最后一个音之后那段（行首行尾，`inEdgeWin`）
  {
    const taken = slurs.map((sl) => sl.obj.box);
    const free = (b: Rect) => !taken.some((t) => b.x < t.right && b.x + b.w > t.left && b.y < t.bottom && b.y + b.h > t.top);
    const cands = [...ledger.unclaimed(), ...beamOnly].filter((c) => inEdgeWin(c.bbox) && free(c.bbox));
    slurs.push(...findStubSlurs(cmap, unit, cands, pg.objs.length + pg.segs.length + 1000 + slurs.length, repaired));
  }
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
  // 也在候选 contour 图上取：压线的短划在修补图上连回整截
  const dv = candView((by) => by === "lyric");
  const dashCands = dv.map.contours.filter((c) => dv.claimsOf(c.id).every((by) => by === "lyric"));
  const dashed = findRasterDashedSlurs(dashCands, unit, pg.objs.length + pg.segs.length + 1000 + slurs.length, dashSide);
  for (const sl of dashed) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur:dashed");
  slurs.push(...dashed);
  // 粘在音符上的弧（`slur.ts::findFusedSlurs`）：只看认领里有符头的那几团墨
  {
    const headBoxes: Rect[] = notes.filter((n) => !n.rest).map((n) => ({ x: n.sym.box.left, y: n.sym.box.top, w: n.sym.box.right - n.sym.box.left, h: n.sym.box.bottom - n.sym.box.top }));
    // 小节线那团也看：跨小节线的延音线粘在线上
    const groupsWithHeads = cmap.contours.filter((c) => ledger.claimsOf(c.id).some((k) => /^(head|stack|cluster):|^seg:BarLine$/.test(k.by)));
    const fused = findFusedSlurs(cmap, unit, groupsWithHeads, headBoxes, pg.objs.length + pg.segs.length + 1000 + slurs.length);
    // 跨小节线的短延音线在**修补图**上再看一次：弧顶压线，去线时左端断开一小截，粘在小节线上的只剩半条，拱不起来
    //（破碎 p2 m15–16、p3 m19–20 钢琴右手：只剩两格、拱 0.15 格）。修补图上小节线还连着符头、干，整块进不了候选，
    // 所以只在小节线左右 `BAR_TIE_REACH` 格的窗口里，从小节线的像素出发按八邻接把修补图上连着的墨填出来，当一团再抠
    const known = [...slurs, ...fused];
    // 已认过的同一条弧不收：两端都在半格以内算同一条（外面罩着圆滑线时两条盒子重叠，不能按盒重叠判）
    const same = (a: SlurArc) => known.some((b) => Math.abs(a.lx - b.lx) < unit.space * 0.5 && Math.abs(a.rx - b.rx) < unit.space * 0.5 && Math.abs(a.ly - b.ly) < unit.space * 0.5);
    const synth = new Int32Array(cmap.w * cmap.h);
    const SYN = -1;
    for (const c of cmap.contours) {
      if (!ledger.claimsOf(c.id).some((k) => k.by === "seg:BarLine")) continue;
      const reach = Math.round(unit.space * BAR_TIE_REACH);
      const x0 = Math.max(0, c.bbox.x - reach), x1 = Math.min(cmap.w, c.bbox.x + c.bbox.w + reach);
      const y0 = c.bbox.y, y1 = c.bbox.y + c.bbox.h;
      const stack: number[] = [];
      for (let y = y0; y < y1; y++) for (let x = c.bbox.x; x < c.bbox.x + c.bbox.w; x++) {
        const k = y * cmap.w + x;
        if (cmap.labels[k] === c.id && repaired.data[k] && synth[k] !== SYN) (synth[k] = SYN), stack.push(k);
      }
      let bx0 = x1, bx1 = x0, by0 = y1, by1 = y0;
      const filled: number[] = [];
      while (stack.length) {
        const k = stack.pop()!;
        filled.push(k);
        const x = k % cmap.w, y = (k - x) / cmap.w;
        bx0 = Math.min(bx0, x), bx1 = Math.max(bx1, x), by0 = Math.min(by0, y), by1 = Math.max(by1, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < x0 || xx >= x1 || yy < y0 || yy >= y1) continue;
          const q = yy * cmap.w + xx;
          if (repaired.data[q] && synth[q] !== SYN) (synth[q] = SYN), stack.push(q);
        }
      }
      const blob = { ...c, id: SYN, bbox: { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } };
      const map = { ...cmap, labels: synth };
      // 两端要分在小节线两边、各伸出 `BAR_TIE_CROSS` 格：只碰到小节线的是贴着它的符尾（万福泉源歌 m0 八分音符的旗）。
      // 小节线的位置取这块里墨最多的那一列（块的包围盒常连着弧的一半，比线宽得多）
      let barX = c.bbox.x, most = -1;
      for (let x = c.bbox.x; x < c.bbox.x + c.bbox.w; x++) {
        let k = 0;
        for (let y = y0; y < y1; y++) if (cmap.labels[y * cmap.w + x] === c.id) k++;
        if (k > most) (most = k), (barX = x);
      }
      const crosses = (a: SlurArc) => a.lx < barX - unit.space * BAR_TIE_CROSS && a.rx > barX + unit.space * BAR_TIE_CROSS;
      for (const sl of findFusedSlurs(map, unit, [blob], headBoxes, pg.objs.length + pg.segs.length + 1000 + slurs.length + fused.length, () => true))
        if (crosses(sl) && !same(sl)) fused.push(sl), known.push(sl);
      for (const k of filled) synth[k] = 0;
    }
    for (const sl of fused) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur:fused");
    slurs.push(...fused);
  }
  // ── 按游程去线的图上补认弧（`prims.ts::removeStaffLinesByRun`）──────────────
  //
  // 弧腹压在谱线上的扁弧（两个八分上下的小弧，宁静 p4 m56、p8 m96）在去线图上连线一起抹了，只剩两条腿，过不了弧线那几道闸。
  // 按游程去线留得下它：线心处竖游程比线厚的整段留着。只当补充的候选——不碰已认的弧、块里没有符头；补出来的两端都挂得上音才留（`runArcs`）
  const runArcs = new Set<SlurArc>();
  {
    const sp = unit.space;
    const runNl = removeStaffLinesByRun(raster.bin, staffLines, unit);
    const runMap = traceContours(runNl, unit, contourStaves);
    const taken = slurs.map((sl) => sl.obj.box);
    const heads = notes.filter((n) => !n.rest).map((n) => n.sym.box);
    const fermatas = cmap.contours.filter((c) => ledger.claimsOf(c.id).some((k) => /fermata/.test(k.by))).map((c) => c.bbox);
    const cands = runMap.contours.filter((c) => {
      const b = c.bbox;
      if (taken.some((t) => b.x < t.right && b.x + b.w > t.left && b.y < t.bottom && b.y + b.h > t.top)) return false;
      // 延长记号的弧（点认成了记号、弧在去线图上没留下）：弧下 1 格内有延长记号的不要（赞美一神）
      if (fermatas.some((f) => f.x + f.w > b.x - sp * 0.5 && f.x < b.x + b.w + sp * 0.5 && f.y + f.h > b.y - sp && f.y < b.y + b.h + sp)) return false;
      if (heads.some((hb) => (hb.left + hb.right) / 2 > b.x && (hb.left + hb.right) / 2 < b.x + b.w && (hb.top + hb.bottom) / 2 > b.y && (hb.top + hb.bottom) / 2 < b.y + b.h)) return false;
      // 块里竖着穿过一根竖段的（干、小节线穿线那段游程长、留了下来，与两旁残留的线连成一块，善牧恩慈歌）
      if ([...prims.vSegs, ...stemSegs].some((v) => { const vx = (v.x0 + v.x1) / 2; return vx > b.x && vx < b.x + b.w && Math.min(v.y0, v.y1) <= b.y + b.h * 0.3 && Math.max(v.y0, v.y1) >= b.y + b.h * 0.7; })) return false;
      // 整块落在一条谱线的线带里的是线本身（扫描件谱线局部厚一像素，按线宽去不掉，两个头之间留下一截微弯的线）
      const band = unit.lineThick + 1;
      if (staffLines.some((l) => b.y >= l.y - band && b.y + b.h <= l.y + band + 1)) return false;
      const cy = b.y + b.h / 2;
      return pg.staves.some((st) => cy > st.box.top - sp * 4 && cy < st.box.bottom + sp * 4);
    });
    { const D = (globalThis as any).process?.env?.SLDBG?.split(",").map(Number); if (D) for (const c of runMap.contours) { const b = c.bbox; if (b.x + b.w < D[0] || b.x > D[2] || b.y + b.h < D[1] || b.y > D[3]) continue; console.log("RUN", c.id, b, "w", c.w.toFixed(2), "h", c.h.toFixed(2), "cmp", c.compact.toFixed(3), "cand", cands.includes(c), "arc?", findRasterSlurs(runMap, unit, [c], 0).map((a) => [a.lx, a.ly, a.rx, a.ry, a.above])); } }
    // 弧心下（上）一格内有个点的是延长记号（没认出来的：赞美一神低音谱表下方那个）。
    // 去线图上弧自己剩下的那截（弧顶压线，只剩线上一小块）不算点：它的墨在游程去线图上属于这条弧（宁静 p9 m104 两个八分上方）
    const dotUnder = (sl: SlurArc) => {
      const b = sl.obj.box;
      const w = b.right - b.left;
      const own = new Set(runMap.contours.filter((c) => c.bbox.x >= b.left && c.bbox.y >= b.top && c.bbox.x + c.bbox.w <= b.right + 1 && c.bbox.y + c.bbox.h <= b.bottom + 1).map((c) => c.id));
      const ofArc = (c: Contour) => {
        const d = c.bbox;
        for (let y = d.y; y < d.y + d.h; y++) for (let x = d.x; x < d.x + d.w; x++) if (cmap.labels[y * cmap.w + x] === c.id && own.has(runMap.labels[y * runMap.w + x]!)) return true;
        return false;
      };
      return cmap.contours.some((c) => {
        const d = c.bbox;
        if (d.w > sp * 0.6 || d.h > sp * 0.6) return false;
        const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
        if (cx < b.left + w / 3 || cx > b.right - w / 3) return false;
        if (!(sl.above ? cy > b.top && cy < b.bottom + sp * 1.2 : cy < b.bottom && cy > b.top - sp * 1.2)) return false;
        return !ofArc(c);
      });
    };
    const flat = (sl: SlurArc) => {
      const w = sl.obj.box.right - sl.obj.box.left;
      return w >= sp * RUN_FLAT_W || sl.obj.box.bottom - sl.obj.box.top <= w * RUN_FLAT;
    };
    // 墨归谁：这条弧的墨在去线图上大半落在歌词账上的块里，是字的笔画（你的信实广大 m20「广」的一撇，按游程这张图上与字断开、单成一块），
    // 记进歌词弧（下面按歌词弧从严挂：离音远就不挂、按干放宽那遍也不给）
    const lyricInk = (sl: SlurArc) => {
      const b = sl.obj.box;
      let all = 0, lyr = 0;
      for (let y = Math.floor(b.top); y <= Math.ceil(b.bottom); y++)
        for (let x = Math.floor(b.left); x <= Math.ceil(b.right); x++) {
          const k = y * runMap.w + x;
          if (!runMap.labels[k]) continue;
          const id = cmap.labels[k];
          if (!id) continue;
          all++;
          if (ledger.claimsOf(id).some((q) => q.by === "lyric")) lyr++;
        }
      return all > 0 && lyr > all * 0.5;
    };
    for (const sl of findRasterSlurs(runMap, unit, cands, pg.objs.length + pg.segs.length + 1000 + slurs.length, undefined, RUN_THIN_MEAN)) {
      if (dotUnder(sl) || !flat(sl)) continue;
      if (lyricInk(sl)) {
        const b = sl.obj.box;
        if (inCell({ x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top })) continue;
        lyricArcBoxes.add(`${b.left},${b.top}`);
      }
      slurs.push(sl);
      runArcs.add(sl);
    }
    // 弧顶（弧底）整段贴在谱线上的，按游程也去掉了，断成左右两截、各自不够宽：相向的两头落在同一条线的线带里、隔着不过 `RUN_BRIDGE` 格的，
    // 拼成一条再判（宁静 p8 m102、p4 m56 两个八分上下那条）
    const endY = (c: Contour, right: boolean) => {
      const x = right ? c.bbox.x + c.bbox.w - 1 : c.bbox.x;
      let sum = 0, n = 0;
      for (let y = c.bbox.y; y < c.bbox.y + c.bbox.h; y++) if (runMap.labels[y * runMap.w + x] === c.id) (sum += y), n++;
      return n ? sum / n : NaN;
    };
    const used = (c: Contour) => slurs.some((sl) => c.bbox.x < sl.obj.box.right && c.bbox.x + c.bbox.w > sl.obj.box.left && c.bbox.y < sl.obj.box.bottom && c.bbox.y + c.bbox.h > sl.obj.box.top);
    const pieces = cands.filter((c) => c.h <= RUN_PIECE_H && !used(c)).sort((a, b) => a.bbox.x - b.bbox.x);
    const lineBand = unit.lineThick + 1;
    for (const a of pieces) {
      if (used(a)) continue;
      const ay = endY(a, true);
      const line = staffLines.find((l) => Math.abs(l.y - ay) <= lineBand);
      if (!line) continue;
      for (const b of pieces) {
        const gap = b.bbox.x - (a.bbox.x + a.bbox.w);
        if (b === a || gap < 0 || gap > sp * RUN_BRIDGE || used(b)) continue;
        if (Math.abs(endY(b, false) - line.y) > lineBand) continue;
        const sl = judgeArcUnion(runMap, [a, b], unit, pg.objs.length + pg.segs.length + 1000 + slurs.length);
        if (!sl || dotUnder(sl) || !flat(sl)) continue;
        slurs.push(sl);
        runArcs.add(sl);
        break;
      }
    }
  }
  mergeArcPieces(slurs, unit.space);
  extendArcEnds(slurs, nl, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x), unit.space);
  traceSteepArcEnds(slurs, raster.bin, (y: number, x?: number) => grid.onLine(y, unit.lineThick / 2 + 0.5, x), unit.lineThick, unit.space);
  traceLongArcTails(slurs, raster.bin, (y: number, x?: number) => grid.onLine(y, unit.lineThick / 2 + 0.5, x), notes.filter((n) => !n.rest).map((n) => n.sym.box), pg.staves.map((st) => st.box), unit.space);
  // 续过谱线之后再并一次：跨谱表的大弧下截续过右手第一线才够到上截（宁静 p1 m9–12 钢琴 F2→F4 那几条）
  mergeArcPieces(slurs, unit.space);
  bridgeArcPieces(slurs, unit.space, (x, y) => x >= 0 && y >= 0 && x < raster.bin.w && y < raster.bin.h && !!raster.bin.data[y * raster.bin.w + x], (y: number, x?: number) => grid.onLine(y, unit.lineThick / 2 + 0.5, x));
  attachSlurs(slurs, notes, unit.space);
  // 放宽那遍不给歌词账上来的弧、碰着整页文字框的弧（字的笔画）
  attachSlursByStem(slurs, notes, unit.space, (sl) => {
    const b = sl.obj.box;
    return lyricArcBoxes.has(`${b.left},${b.top}`) || (!!textBoxes && touchesText({ x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top }, textBoxes, 0));
  });
  attachWideSlurs(slurs, notes, unit.space);
  attachEdgeSlurEnds(slurs, notes, unit.space);
  snapSlurEndsToStems(slurs, notes, unit.space);
  // 歌词账上来的弧，挂上的端要贴着音（弧端离头外缘 `LYRIC_ARC_REACH` 格内，真弧实测 ≤1.35）：字的弯笔（「悲」「恩」的心字底、「w」的顶）
  // 离上方的音两三格（实测至少一端 ≥1.8），`attachSlurs` 的窗口够得着（当我们回到天家 m1、m5，你的信实广大 m26–30）。一端离得远就整条不挂
  // 有整页文字框时，贴着谱表（离线不过 `TEXT_ARC_STAFF` 格）又碰不着任何文字框的免掉（`pagetext.ts::touchesText`）：
  // 歌词条的认领框比字宽，谱表上沿隔着顿音点、离音两格半的延音线也记在歌词账上（破碎 p4 m33 钢琴右手）。
  // 只凭字框不够：DBNet 在密排的三段歌词上常整片漏检（你的信实广大一页只检出 45 个框，m26–30 的歌词行一个没有）
  for (const sl of slurs) {
    if (!lyricArcBoxes.has(`${sl.obj.box.left},${sl.obj.box.top}`)) continue;
    const ab = sl.obj.box;
    const nearStaff = pg.staves.some((st) => ab.bottom > st.box.top - unit.space * TEXT_ARC_STAFF && ab.top < st.box.bottom + unit.space * TEXT_ARC_STAFF);
    if (textBoxes && nearStaff && !touchesText({ x: ab.left, y: ab.top, w: ab.right - ab.left, h: ab.bottom - ab.top }, textBoxes, unit.space * TEXT_ARC_PAD)) continue;
    // 干朝弧那侧的按干端量：一组十六分上方的弧贴着符杠，离音头五六格（破碎 p7 m73 钢琴右手，墨挨着上一行歌词格记在歌词账上）
    const edge = (n: StaffNote) => (n.stemTip !== undefined && n.stemUp === sl.above ? n.stemTip : sl.above ? n.sym.box.top : n.sym.box.bottom);
    const far = (n: StaffNote | undefined, y: number) => !!n && (sl.above ? edge(n) - y : y - edge(n)) > unit.space * LYRIC_ARC_REACH;
    if (far(sl.from, sl.ly) || far(sl.to, sl.ry)) (sl.from = undefined), (sl.to = undefined), (sl.tie = false);
  }
  // 延音线只连相邻两个音、终点前没有临时记号（判据两路共用，见 `staffomr/slur.ts::notTie`）
  for (const sl of slurs) {
    if (!sl.tie || !sl.from || !sl.to) continue;
    const { from, to } = sl;
    if (notTie(from, to, notes, unit.space)) sl.tie = false;
    // 延音线两端贴着音头；弧端离那头的音头 `TIE_HUG` 格以外、中间夹着别的音的，弧其实从（到）那个音
    //（破碎 m31/m72/m91 钢琴左手：八分 C♯3、干朝下的 G3、八分 C3，弧从 G3 起止在 C3，起端被挂到同音高的 C♯3 上；
    // m62 钢琴右手：D4/A4 和弦下方的短弧往上收在 D5 八分音符下，止端被挂到后面和弦的 D4 上）
    else {
      const between = notes.filter((n) => !n.rest && !n.grace && n.staff === from.staff && n.sym.box.left > from.sym.box.right && n.sym.box.right < to.sym.box.left);
      const nearest = (ns: StaffNote[], x: (n: StaffNote) => number, at: number) => ns.reduce<StaffNote | undefined>((a, n) => (!a || Math.abs(x(n) - at) < Math.abs(x(a) - at) ? n : a), undefined);
      const mx = (sl.lx + sl.rx) / 2;
      // 中间那个音的头要在纵向贴着弧端（`TIE_MID_REACH` 格内）：长音之间的真延音线弧端也会离音头一格半，中间的音却在两格开外（新编 329 m3、264 m10、f16 m3）
      // 或者弧明显斜着往那个音去（两端高差过弧宽三成；真延音线两端等高：m62 那条短弧左低右高，收在 D5 下方两格）
      const tilt = (sl.ry - sl.ly) / Math.max(1, sl.rx - sl.lx);
      const hugs = (n: StaffNote, y: number, dir: number) =>
        Math.max(n.sym.box.top - y, y - n.sym.box.bottom, 0) <= unit.space * TIE_MID_REACH || (Math.abs(tilt) > 0.3 && Math.sign(n.sym.py - y) === Math.sign(tilt) * dir);
      const a = sl.lx - from.sym.box.right > unit.space * TIE_HUG ? nearest(between.filter((n) => n.sym.px < mx && hugs(n, sl.ly, -1)), (n) => n.sym.box.left, sl.lx) : undefined;
      const b = to.sym.box.left - sl.rx > unit.space * TIE_HUG ? nearest(between.filter((n) => n.sym.px > mx && hugs(n, sl.ry, 1)), (n) => n.sym.px, sl.rx) : undefined;
      if (a) sl.from = a;
      if (b) sl.to = b;
      if (a || b) sl.tie = false;
    }
  }
  // **弧止端不跨小节线**：弧的右端在本谱表一条小节线左边（离线 `SLUR_BAR_CLEAR` 格以上）、止端的音却在线右边——
  // 弧端越过末音的头与干（十六分音群上的长弧常这样），`validateSlurNote` 把末音拒了，只剩线右边那个音（破碎 p7 m70→71 钢琴右手，
  // 又跟 m71 起的那条撞在同一个音上）。止端退回线左边本谱表最右的音。
  // 两端同音高的不动：跨小节线的延音线常在线上断成两截、只认出左半截（望十架 p4 m33→34 女高 C5），后面才判成延音线
  for (const a of slurs) {
    const n = a.to;
    if (a.tie || !a.from || !n || a.from === n || n.staff !== a.from.staff || n.diatonic === a.from.diatonic) continue;
    const bx = (ctx.get(n.staff)?.barXs ?? []).find((x) => x > a.from!.sym.px && x < n.sym.box.left && a.rx < x - unit.space * SLUR_BAR_CLEAR);
    if (bx === undefined) continue;
    const prev = notes
      .filter((m) => m.staff === n.staff && !m.rest && !m.chordExtra && !m.grace && m.sym.px < bx && m.sym.px > a.from!.sym.px)
      .reduce<StaffNote | undefined>((x, m) => (!x || m.sym.px > x.sym.px ? m : x), undefined);
    if (prev) a.to = prev;
  }
  // **前后两条圆滑线不共用一个音**：一条止在 n、下一条又从 n 起，而前一条的右端没越过 n 的音头中心——
  // 那是两条弧首尾相挨、右端搭到了下一条起点那个音上，止端退回 n 前面那个音（宁静 p3 m34 钢琴右手：止在 B4、C5 起下一条）
  for (const a of slurs) {
    const n = a.to;
    if (a.tie || !a.from || !n || a.from === n || !slurs.some((b) => b !== a && !b.tie && b.from === n)) continue;
    if (a.rx > n.sym.px) continue;
    const prev = notes
      .filter((m) => m.staff === n.staff && !m.rest && !m.chordExtra && !m.grace && m.sym.px < n.sym.px - unit.space * 0.3 && m.sym.px > a.from!.sym.px)
      .reduce<StaffNote | undefined>((x, m) => (!x || m.sym.px > x.sym.px ? m : x), undefined);
    if (prev) a.to = prev;
  }
  // 对称的一条：一条止在 n、下一条又从 n 起，而后一条的左端已越过 n 的音头——后一条起在 n 后面那个音
  //（宁静 p5 m68 钢琴右手：前一条收在 B5，后一条从 B5 右边、正对着下一个 A4 起笔，按头盒量挂到了 B5）
  for (const a of slurs) {
    const n = a.from;
    // 前一条两头同音高的是延音线（这时还没判 tie）：延音线止在 n、圆滑线从 n 起是常规写法（破碎 p3 m19 钢琴右手 C5）
    if (a.tie || !n || !a.to || a.to === n || !slurs.some((b) => b !== a && !b.tie && b.to === n && b.from?.diatonic !== n.diatonic)) continue;
    // 越过 n 的头右缘半格以上才算（首尾共用一个音的两条弧，后一条常从那个头的右半起笔，破碎 p2 m12、p3 m19）
    if (a.lx < n.sym.box.right + unit.space * 0.5) continue;
    const next = notes
      .filter((m) => m.staff === n.staff && !m.rest && !m.chordExtra && !m.grace && m.sym.px > n.sym.px + unit.space * 0.3 && m.sym.px < a.to!.sym.px)
      .reduce<StaffNote | undefined>((x, m) => (!x || m.sym.px < x.sym.px ? m : x), undefined);
    // 起点还要离那个音的头比离 n 的头更近（破碎 p3 m19、p6 m60 起点在 n 右边一格来远、离下一个头更远，GT 起在 n）
    if (next && Math.abs(a.lx - next.sym.box.left) < a.lx - n.sym.box.right) a.from = next;
  }
  { const D = (globalThis as any).process?.env?.SLDBG?.split(",").map(Number); if (D) for (const sl of slurs) if (sl.rx > D[0] && sl.lx < D[2] && Math.max(sl.ly, sl.ry) > D[1] && Math.min(sl.ly, sl.ry) < D[3]) console.log("SL", runArcs.has(sl), sl.lx, sl.ly, sl.rx, sl.ry, sl.above, sl.from?.sym.box, sl.to?.sym.box); }
  // 按游程补出来的弧两端都要挂上音（同一个音不算）：挂不全的多是线上残留的别的墨。
  // 跨系统的半截例外：只挂一端、另一端正伸到行尾 / 行首（`orphanEdge`）的留着（破碎 p2 m16 钢琴右手行尾那截，墨还被字典认成了保持音）
  const runEdge = (sl: SlurArc) => {
    const one = sl.from && !sl.to ? sl.from : !sl.from && sl.to ? sl.to : undefined;
    return !!one && orphanEdge(sl, one) !== "mid";
  };
  for (let i = slurs.length - 1; i >= 0; i--) if (runArcs.has(slurs[i]) && !runEdge(slurs[i]) && (!slurs[i].from || !slurs[i].to || slurs[i].from === slurs[i].to)) slurs.splice(i, 1);
  reconnectSlurs(pg, slurs);
  // 跨行接上的同音两截先当圆滑线写：是不是延音线要看时间上是否紧挨着（同一声部本系统最后一个音、下一系统第一个音），
  // 声部到写出端才定，由 `toxml.ts::renumberSlurs` 判（宁静 p8 m97→m103 女高 E5…E5 是长圆滑线）
  {
    const sysOf = (st: Staff) => pg.systems.findIndex((sy) => sy.staves.includes(st));
    for (const sl of slurs) if (sl.tie && sl.from && sl.to && sysOf(sl.from.staff) !== sysOf(sl.to.staff)) sl.tie = false;
  }
  attachEdgeSlurStarts(slurs, notes, unit.space, new Set(index > 1 ? (pg.systems[0]?.staves ?? []) : []));
  completeSlurEnds(slurs, notes, unit.space);
  // 补齐的端是按头中心就近挂的，弧在干那一侧时再按干挪一遍（破碎 p7 m72 钢琴左手 E2 八分那条）
  snapSlurEndsToStems(slurs, notes, unit.space);
  const chordTies = tieChords(slurs, notes, unit.space, (x0, x1, y0, y1) => {
    const { bin } = raster;
    const xa = Math.max(0, Math.round(x0)), xb = Math.min(bin.w, Math.round(x1));
    const ya = Math.max(0, Math.round(y0)), yb = Math.min(bin.h - 1, Math.round(y1));
    const rows: number[] = [];
    for (let y = ya; y <= yb; y++) if (!grid.onLine(y, unit.lineThick, (xa + xb) / 2)) rows.push(y);
    if (xb <= xa || !rows.length) return 0;
    let hit = 0;
    for (let x = xa; x < xb; x++) if (rows.some((y) => bin.data[y * bin.w + x])) hit++;
    return hit / (xb - xa);
  });
  // 弧号「页码.页内序号」（页码按 `pageSeq` 数）：只当配对的键用，跨页不能撞号
  let slurSeq = 0;
  markSlurNotes(slurs, opts.pageSeq !== undefined ? () => `${opts.pageSeq! + 1}.${++slurSeq}` : undefined);
  for (const [a, b, above] of chordTies) (a.tieStart = true), (a.tieAbove = above), (b.tieStop = true);
  markLyricExtends(notes);

  const result: RasterPageResult = {
    page: pg,
    hasStaff: true,
    unknown: unknownObjs(pg).length,
    unit,
    raster,
    ctx,
    beams,
    notes,
    bars: checkBars(pg, ctx, notes, carry.carryTime),
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
    wordStrips: opts.wantWordStrips ? [...wordStrips, ...nameStrips] : [],
    headerStrips: headerStrip ? [headerStrip] : [],
    header,
    textKey,
    textBin,
    textBoxes,
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
    carryTime: lastTimeSignature(pg, ctx, carry.carryTime),
    // 没有调号的页也要把谱号的见证带下去：个数记零（`extendKeyByCarry` 见零不补）
    carryKey: { ...(lastKey(pg, ctx, carry.carryKey) ?? { code: "accidentalFlat", n: 0 }), clefs: clefTally },
    wedgeRows,
  };
  opts.trace?.("page", { notes, bars: result.bars, lyricLines, slurs, wedges, dynamics, harmonies, staffLabels, header, carryTime: result.carryTime, carryKey: result.carryKey });
  return result;
}
