// 认一页的头几步（`recognizeRasterPage` 按顺序调）：先于符头认领的东西——混排谱的简谱行、页顶的大字号标题、谱表上方的和弦带——
// 以及 contour 层与认领账本（之后每认出一样东西就按盒记一笔）。

import { type StaffGroup, type RasterUnit, type StaffLineRun, lineYAt, liftOf, localLineModel } from "../staffline";
import type { RasterPage } from "../rasterpage";
import { type RasterPrims, findBlobs, repairLineCuts, binSig } from "../prims";
import type { Binary, Component, Rect } from "../../omrkit/types";
import type { LineFrame } from "../pitchgrid";
import { type JianpuBand, type JianpuStrip, findJianpuBands, completeStaffBars, cutJianpuStrip, eraseInBand } from "../jianpuband";
import { bridgeFaintBars } from "../barvote";
import type { RasterPageOpts, RasterLiveOcr } from "../recognize";
import { CHAR_MAX as LYRIC_CHAR_MAX } from "../lyric";
import { type HarmonyStrip, type HarmonyToken, findHarmonyStrips, harmonyKey, readHarmonyStrip, harmonyLine } from "../harmony";
import { RasterGlyphLookup, matchTemplate } from "../rasterglyphs";
import { type ContourMap, type RepairedLayer, traceContours, repairedLayer } from "../contour";
import { ContourLedger } from "../ledger";
import type { SmuflName } from "../../staffomr/glyphs";

/** 空心符头允许离谱表多远（线距的倍数）。见 `inBand` 那段的说明。 */
const HOLLOW_BAND = 3.0;
/** 谱表到头之间的加线都在时，空心头允许离谱表这么多格（见 `inBand`）。 */
const HOLLOW_BAND_LEDGER = 5.3;
/** 页顶标题字高的上限（格）：再高的是大括号、竖线一类。 */
const TITLE_CHAR_MAX = 12;

// ───────────────────────── 认一页的各阶段（`recognizeRasterPage` 按顺序调） ─────────────────────────

/** 简谱行（混排谱）：**先于一切**认领 */
export function claimJianpuRows(c: {
  groups: StaffGroup[];
  raster: RasterPage;
  unit: RasterUnit;
  prims: RasterPrims;
  nl: Binary;
  onLedger: (y: number, x?: number) => boolean;
  opts: RasterPageOpts;
  staffLines: StaffLineRun[];
}): {
  staffGeoms: { left: number; right: number; top: number; bottom: number; topAt: (x: number) => number; bottomAt: (x: number) => number; lift: ((x: number) => number) | undefined; }[];
  frames: LineFrame[];
  jianpuBands: JianpuBand[];
  jianpuStrips: JianpuStrip[];
  blobLabels: Int32Array;
  blobs: Component[];
  repaired: Binary;
  rBlobs: Component[];
  rBlobParts: Map<number, Set<number>>;
} {
  const { groups, raster, unit, prims, nl, onLedger, opts, staffLines } = c;
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
  return { staffGeoms, frames, jianpuBands, jianpuStrips, blobLabels, blobs, repaired, rBlobs, rBlobParts };
}

/** 顶部大字号文字：**先认成标题** */
export function claimTitleText(c: {
  groups: StaffGroup[];
  unit: RasterUnit;
  blobs: Component[];
}): {
  titleIds: Set<number>;
} {
  const { groups, unit, blobs } = c;
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
  return { titleIds };
}

/** 和弦带：**先于符头认领** */
export async function claimChordBand(c: {
  prims: RasterPrims;
  groups: StaffGroup[];
  unit: RasterUnit;
  raster: RasterPage;
  jianpuBands: JianpuBand[];
  opts: RasterPageOpts;
  live: RasterLiveOcr | undefined;
  yAt: (g: StaffGroup, k: number, x: number) => number;
  blobs: Component[];
}): Promise<{
  harmonyStrips: HarmonyStrip[];
  harmonies: HarmonyToken[];
  harmonyTexts: HarmonyToken[];
  harmonyIds: Set<number>;
  harmonyMasks: Rect[];
}> {
  const { prims, groups, unit, raster, jianpuBands, opts, live, yAt, blobs } = c;
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
  return { harmonyStrips, harmonies, harmonyTexts, harmonyIds, harmonyMasks };
}

/** contour 层与认领账本 */
export function buildClaimLedger(c: {
  groups: StaffGroup[];
  nl: Binary;
  unit: RasterUnit;
  repaired: Binary;
  prims: RasterPrims;
  onLedger: (y: number, x?: number) => boolean;
  raster: RasterPage;
  yAt: (g: StaffGroup, k: number, x: number) => number;
  look: RasterGlyphLookup;
}): {
  contourStaves: { top: number; bottom: number; left: number; right: number; lift: ((x: number) => number) | undefined; }[];
  cmap: ContourMap;
  ledger: ContourLedger;
  rlayer: RepairedLayer;
  onGrid: (y: number, x?: number) => boolean;
  inBand: (y: number, x?: number) => boolean;
  offStaff: (y: number) => boolean;
  matchHollow: ((box: Rect) => { smufl: SmuflName; dist: number; } | null) | null;
} {
  const { groups, nl, unit, repaired, prims, onLedger, raster, yAt, look } = c;
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
  return { contourStaves, cmap, ledger, rlayer, onGrid, inBand, offStaff, matchHollow };
}
