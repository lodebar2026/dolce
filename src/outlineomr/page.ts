// 转曲矢量谱**一页**识别：几何（谱线、符干、小节线、符杠、弧、房子）与音乐字形直接读路径对象，
// 文字（歌词、和弦、简谱行、页眉）把对象画成小条送 OCR（与位图路同一套在线 OCR / 离线缓存，`RasterLiveOcr`）。
//
// 流程照位图路的接法（`rasteromr/adapt.ts`）：自己认出符号造成 `Sym`，然后接矢量路后半段
// （`staffomr/pagerun.ts::recognizeBuiltPage`：找谱表 → 符头符干 → 小节 → 音符 → 记号 → 自检）。
// 文字部分照位图路 `pagefinish.ts` 的做法造文本对象挂音（歌词不走 `analyzeText`：中文逐字一个音节，没有锚点）。
// 不碰 DOM。
import { extractVectorPage, type OpsEnum, type VecObj } from "../omrkit/vector";
import type { Rect } from "../omrkit/types";
import { buildPage } from "../staffomr/page";
import { recognizeBuiltPage, type StaffPageResult } from "../staffomr/pagerun";
import { attachHarmonies, attachLyrics, buildLyricLines } from "../staffomr/textanalyze";
import { keyFifths } from "../staffomr/notedata";
import type { PObj, SPage, Staff } from "../staffomr/model";
import { attachVoltas, type Volta } from "../staffomr/octave";
import { makeSymObj, makeTextObj } from "../rasteromr/adapt";
import type { RasterLiveOcr } from "../rasteromr/recognize";
import { findJianpuBands, jianpuKey, type JianpuBand, type JianpuStrip } from "../rasteromr/jianpuband";
import { fuseJianpu, type FuseStats, type JianpuRow } from "../rasteromr/jianpufuse";
import { attachJumpMarks, harmonyKey, harmonyLine, readHarmonyStrip, type HarmonyStrip, type HarmonyToken } from "../rasteromr/harmony";
import { jumpTail, mapCharsToCells, stripKey, type LyricStrip } from "../rasteromr/lyric";
import { liftHarmonies } from "../rasteromr/lyricpost";
import { wordKey, type WordStrip } from "../rasteromr/words";
import { timeKey, type TimeStrip } from "../rasteromr/timesig";
import type { LineSeg } from "../rasteromr/prims";
import type { RasterUnit } from "../rasteromr/staffline";
import { headerCredits, type HeaderCredit, type WordLine } from "../omrkit/headertext";
import { objRect, isGeometry, splitPieces, type OutlineGlyphLookup } from "./glyphs";
import { rasterizeObjs } from "./raster";

/** 送 OCR 的条按每设备单位（PDF 点）几个像素画：线距 4.8 点的谱上汉字约 70 像素高，与位图路的条相当 */
export const OCR_SCALE = 6;

/** 字形落在谱表上下这么多线距以内才当音乐符号认（加线上的低音、谱表上方的附点与符尾） */
const STAFF_ZONE_ABOVE = 4.5;
const STAFF_ZONE_BELOW = 4;
/** 简谱行里的说明文字：至少几个字、字间缝不过字高的几成（简谱数字之间隔得开） */
const NOTE_RUN = 5;
const NOTE_GAP = 0.35;
/** 形状简单（一道横、一点、一竖）的符号：从一个对象拆出来的块认成它们不算数 */
const PLAIN_SHAPES = new Set<string>(["articTenutoAbove", "articTenutoBelow", "legerLine", "stem", "augmentationDot", "articStaccatoAbove", "articStaccatoBelow", "barlineSingle", "restHBar"]);
/** 和弦带：简谱行（没有简谱行时谱表顶线）以上这么多线距 */
const CHORD_ZONE = 4.5;
/** 和弦带里横向隔开过这么多线距就是下一个记号 */
const CHORD_GAP = 0.9;
/** 歌词行：字高至少这么多线距（拍号、减时线、小附点不算） */
const LYRIC_MIN_H = 1.2;
/** 歌词行比这个（`LYRIC_MIN_H` 的倍数）还矮的是页脚小字：歌词字高 3.3 格、版权行 2.1 格 */
const LYRIC_FOOT = 2;
/** 歌词行至少几个字块 */
const LYRIC_MIN_ITEMS = 3;

export interface OutlinedPageResult extends StaffPageResult {
  /** 谱表正上方认出了简谱行（简线混排谱：识别后进混排档、单行系统归第一声部） */
  jianpuBands: JianpuBand[];
  jianpuFix: FuseStats | null;
  harmonies: number;
  lyricRows: number;
  /** 曲首页的页眉（标题、词曲）；不是曲首页为空 */
  header: HeaderCredit[];
}

interface Group5 {
  ys: number[];
  left: number;
  right: number;
}

/** 谱线：页宽三成以上的细横线，五条等距一组。返回各组与线距；一组都没有为 null。 */
export function staffGroups(objs: readonly VecObj[], pageW: number): { groups: Group5[]; sp: number } | null {
  const lines = objs
    .filter((o) => o.curves === 0 && o.bbox.w > pageW * 0.3 && o.bbox.h < 2)
    .map((o) => ({ y: o.bbox.y + o.bbox.h / 2, left: o.bbox.x, right: o.bbox.x + o.bbox.w }))
    .sort((a, b) => a.y - b.y);
  // 同一条线描了几遍（重描）：y 差不到半点的并掉
  const uniq: typeof lines = [];
  for (const l of lines) if (!uniq.length || l.y - uniq[uniq.length - 1].y > 0.5) uniq.push(l);
  const groups: Group5[] = [];
  for (let i = 0; i + 4 < uniq.length; ) {
    const five = uniq.slice(i, i + 5);
    const d = five.slice(1).map((l, k) => l.y - five[k].y);
    const mean = d.reduce((a, b) => a + b, 0) / 4;
    if (d.every((x) => Math.abs(x - mean) <= mean * 0.15) && Math.abs(five[0].left - five[4].left) < mean) {
      groups.push({ ys: five.map((l) => l.y), left: Math.max(...five.map((l) => l.left)), right: Math.min(...five.map((l) => l.right)) });
      i += 5;
    } else i++;
  }
  if (!groups.length) return null;
  const ds = groups.flatMap((g) => g.ys.slice(1).map((y, k) => y - g.ys[k])).sort((a, b) => a - b);
  return { groups, sp: ds[ds.length >> 1] };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const cx = (o: VecObj) => o.bbox.x + o.bbox.w / 2;
const cy = (o: VecObj) => o.bbox.y + o.bbox.h / 2;
/** 几个对象的外框 */
function unionBox(objs: readonly VecObj[]): Rect {
  const x0 = Math.min(...objs.map((o) => o.bbox.x));
  const y0 = Math.min(...objs.map((o) => o.bbox.y));
  const x1 = Math.max(...objs.map((o) => o.bbox.x + o.bbox.w));
  const y1 = Math.max(...objs.map((o) => o.bbox.y + o.bbox.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 });

/** 按纵向重叠（过矮者一半）分行，行内按 x 排。 */
function rowsOf(items: readonly VecObj[]): VecObj[][] {
  const rows: { top: number; bottom: number; objs: VecObj[] }[] = [];
  for (const o of [...items].sort((a, b) => a.bbox.y - b.bbox.y)) {
    const t = o.bbox.y;
    const b = o.bbox.y + o.bbox.h;
    const row = rows.find((r) => Math.min(b, r.bottom) - Math.max(t, r.top) > Math.min(b - t, r.bottom - r.top) * 0.5);
    if (row) {
      row.objs.push(o);
      row.top = Math.min(row.top, t);
      row.bottom = Math.max(row.bottom, b);
    } else rows.push({ top: t, bottom: b, objs: [o] });
  }
  return rows.map((r) => r.objs.sort((a, b) => a.bbox.x - b.bbox.x));
}

/**
 * 一行字块 → 字格：左右相交或缝不过三成字高的并成一格（左右结构的字拆成两个对象），一格不宽过 1.1 个字高；
 * 矮小的块（逗号、句号）并进前一格（同位图路 `squareCells` 的尾随标点）。
 */
function charCells(row: readonly VecObj[], rowH: number): VecObj[][] {
  // 字宽按字高量：行高里算进了标点、上下出头的笔画，比字高大一圈（祢話如甘霖行高 16、字高 12，按行高卡「下」并进了「話」的言字旁）
  const tall = row.filter((o) => o.bbox.h >= rowH * 0.6).map((o) => o.bbox.h).sort((a, b) => a - b);
  const charH = tall.length ? tall[tall.length >> 1] : rowH;
  const cells: VecObj[][] = [];
  for (const o of row) {
    const last = cells[cells.length - 1];
    if (last) {
      const b = unionBox(last);
      const small = o.bbox.h < charH * 0.5 && o.bbox.w < charH * 0.5;
      const gap = o.bbox.x - (b.x + b.w);
      const w = Math.max(b.x + b.w, o.bbox.x + o.bbox.w) - b.x;
      if (small ? gap < charH * 0.6 : gap < charH * 0.3 && w <= charH * 1.1) {
        last.push(o);
        continue;
      }
    }
    cells.push([o]);
  }
  return cells;
}

/**
 * 认一页转曲矢量谱。`look` 认音乐字形；`live` 是在线 OCR（或回归脚本的缓存查表），缺了文字就不出。
 */
export async function recognizeOutlinedPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfPage: any,
  OPS: OpsEnum,
  look: OutlineGlyphLookup,
  index: number,
  opts: { live?: RasterLiveOcr; carryTime?: { beats: number; beatType: number }; wantHeader?: boolean } = {},
): Promise<OutlinedPageResult> {
  const vec = await extractVectorPage(pdfPage, OPS, { scale: 1 });
  const st5 = staffGroups(vec.objs, vec.width);
  const empty = (): OutlinedPageResult => {
    const pg = buildPage(index, vec.width, vec.height, [], [], 20);
    return { ...recognizeBuiltPage(pg, { carryTime: opts.carryTime }), jianpuBands: [], jianpuFix: null, harmonies: 0, lyricRows: 0, header: [] };
  };
  if (!st5) return empty();
  const { groups, sp } = st5;
  const unit: RasterUnit = { space: sp, lineThick: 0.6, height: sp * 4 };
  const staffBoxes = groups.map((g) => ({ left: g.left, right: g.right, top: g.ys[0], bottom: g.ys[4] }));

  // ── 线与字形分开；字形里画了好几个符号的（调号一串升号）先试整个认，认不出再拆块 ──────────
  const geo = new Set(vec.objs.filter((o) => isGeometry(o, sp)));
  const geometry = vec.objs.filter((o) => geo.has(o));
  const glyphObjs = vec.objs.filter((o) => !geo.has(o));

  // ── 简谱行：谱表上方悬着的短竖线与谱表小节线同 x（位图路 `jianpuband.ts` 同一判据，线段换成路径） ──
  const vSegs: LineSeg[] = geometry
    .filter((o) => o.bbox.w < sp * 0.3 && o.bbox.h > sp * 0.5)
    .map((o) => ({ x0: cx(o), y0: o.bbox.y, x1: cx(o), y1: o.bbox.y + o.bbox.h, lw: o.bbox.w, maxLw: o.bbox.w }));
  const bands = findJianpuBands(vSegs, staffBoxes, unit);
  const inBand = (o: VecObj) => bands.some((b) => inside(b.box, cx(o), cy(o)));

  // ── 音乐符号：谱表上下一带、不在简谱行里 ─────────────────────────────────
  const syms: { box: Rect; code: import("../staffomr/glyphs").SmuflName }[] = [];
  const texts: VecObj[] = [];
  const inStaffZone = (o: VecObj) =>
    staffBoxes.some((s) => cx(o) > s.left - sp && cx(o) < s.right + sp && cy(o) > s.top - sp * STAFF_ZONE_ABOVE && cy(o) < s.bottom + sp * STAFF_ZONE_BELOW);
  // 文字按**整个对象**收（一字一个对象）：拆了块，「話」的言字旁碎成几道横，会被当成标点并进前一个字
  for (const o of glyphObjs) {
    if (inBand(o) || !inStaffZone(o)) {
      texts.push(o);
      continue;
    }
    const whole = look.classify(o, sp);
    if (whole) {
      syms.push({ box: objRect(o), code: whole.code });
      continue;
    }
    const pieces = splitPieces(o);
    // 拆出来的块只收形状复杂的符号（调号串里的升降号）：一道横、一点、一竖拆哪个字都拆得出来（「話」的言字旁被认成保持音）
    const got = pieces.length > 1 ? pieces.map((p) => look.classify(p, sp)).map((c) => (c && !PLAIN_SHAPES.has(c.code) ? c : null)) : [null];
    if (!got.some(Boolean)) {
      texts.push(o);
      continue;
    }
    pieces.forEach((p, i) => (got[i] ? syms.push({ box: objRect(p), code: got[i]!.code }) : texts.push(p)));
  }

  // 文字里也有无曲线的小块：和弦的「/」、汉字「一」——不是细线（加线、减时线、房子），也不长（谱线、小节线）
  const marks = geometry.filter((o) => o.bbox.w >= sp * 0.3 && o.bbox.h >= sp * 0.3 && Math.max(o.bbox.w, o.bbox.h) <= sp * 2.5);
  texts.push(...marks);

  // ── 建页，接矢量路后半段 ─────────────────────────────────────────────────
  const pg = buildPage(index, vec.width, vec.height, geometry, [], sp * 4);
  let id = pg.objs.length;
  for (const s of syms) {
    const { obj, sym } = makeSymObj(id++, s, sp * 4);
    pg.objs.push(obj);
    pg.symbols.push(sym);
  }
  const r = recognizeBuiltPage(pg, { carryTime: opts.carryTime });
  if (r.hasStaff) markVoltas(pg, bands, sp);
  const res: OutlinedPageResult = { ...r, jianpuBands: bands, jianpuFix: null, harmonies: 0, lyricRows: 0, header: [] };
  if (!r.hasStaff) return res;
  const notes = r.notes;
  // `findJianpuBands` 的谱行下标是 `staffBoxes` 的；对到 `pg.staves`（按顶线 y）
  const staffOfBox = (k: number): Staff | undefined => pg.staves.find((s) => Math.abs(s.box.top - staffBoxes[k].top) < sp);
  const live = opts.live;
  if (!live) return res;

  // ── 简谱行之上的和弦带 ───────────────────────────────────────────────────
  const used = new Set<VecObj>();
  const harmonyStrips: HarmonyStrip[] = [];
  staffBoxes.forEach((s, k) => {
    const st = staffOfBox(k);
    if (!st) return;
    const own = bands.filter((b) => b.staff === k);
    const bottom = own.length ? Math.min(...own.map((b) => b.box.y)) : s.top - sp * 0.3;
    const zone: Rect = { x: s.left - sp * 2, y: bottom - sp * CHORD_ZONE, w: s.right - s.left + sp * 4, h: sp * CHORD_ZONE };
    const items = texts.filter((o) => !used.has(o) && !inBand(o) && inside(zone, cx(o), cy(o))).sort((a, b) => a.bbox.x - b.bbox.x);
    const toks: VecObj[][] = [];
    for (const o of items) {
      const last = toks[toks.length - 1];
      if (last && o.bbox.x - Math.max(...last.map((q) => q.bbox.x + q.bbox.w)) <= sp * CHORD_GAP) last.push(o);
      else toks.push([o]);
    }
    for (const t of toks) {
      for (const o of t) used.add(o);
      const box = pad(unionBox(t), sp * 0.15);
      const bin = rasterizeObjs(t, box, OCR_SCALE);
      harmonyStrips.push({ w: bin.w, h: bin.h, data: bin.data, box, staff: pg.staves.indexOf(st) });
    }
  });
  if (harmonyStrips.length) {
    const ocr = await live.harmony(harmonyStrips);
    const byStaff = new Map<number, { chords: HarmonyToken[]; texts: HarmonyToken[] }>();
    for (const strip of harmonyStrips) {
      const chars = ocr.get(harmonyKey(strip));
      if (!chars?.length) continue;
      const got = readHarmonyStrip(strip, chars);
      const acc = byStaff.get(strip.staff) ?? { chords: [], texts: [] };
      acc.chords.push(...got.chords);
      acc.texts.push(...got.texts);
      byStaff.set(strip.staff, acc);
    }
    const chords: HarmonyToken[] = [];
    const marks: HarmonyToken[] = [];
    for (const v of byStaff.values()) {
      const line = harmonyLine(v.chords, v.texts);
      chords.push(...line.chords);
      marks.push(...line.texts);
    }
    if (chords.length) {
      const objs = chords.map((t, i) => makeTextObj(pg.objs.length + i, { cells: [{ box: t.box, ch: t.text }], sizeDev: t.box.h }));
      for (const o of objs) o.addTag("Harmony");
      pg.objs.push(...objs);
      attachHarmonies(pg, notes, objs, false);
      liftHarmonies(notes, sp);
      res.harmonies = chords.length;
    }
    attachJumpMarks(pg, notes, marks, sp);
  }

  // ── 歌词：谱表下方的字行 ─────────────────────────────────────────────────
  const lyricStrips: LyricStrip[] = [];
  const stripStaff = new Map<LyricStrip, Staff>();
  staffBoxes.forEach((s, k) => {
    const st = staffOfBox(k);
    if (!st) return;
    // 下一行谱（连同它上方的简谱行、和弦带）之前
    const next = staffBoxes[k + 1];
    const nextTop = next ? Math.min(next.top, ...bands.filter((b) => b.staff === k + 1).map((b) => b.box.y)) - sp * (bands.some((b) => b.staff === k + 1) ? CHORD_ZONE : 0.5) : vec.height;
    const zone: Rect = { x: s.left - sp * 2, y: s.bottom + sp * 0.5, w: s.right - s.left + sp * 4, h: nextTop - s.bottom - sp * 0.5 };
    if (zone.h <= 0) return;
    const items = texts.filter((o) => !used.has(o) && !inBand(o) && inside(zone, cx(o), cy(o)));
    for (const row of rowsOf(items)) {
      const box0 = unionBox(row);
      if (box0.h < sp * LYRIC_MIN_H || row.length < LYRIC_MIN_ITEMS) continue;
      // 页脚的版权小字（「© 2024 劉安淑/小羊詩歌版權所有」，字高只有歌词的六成）
      if (box0.h < sp * LYRIC_MIN_H * LYRIC_FOOT) continue;
      for (const o of row) used.add(o);
      const rowH = box0.h;
      const cells = charCells(row, rowH);
      const box = pad(box0, rowH * 0.15);
      const bin = rasterizeObjs(row, box, OCR_SCALE);
      const strip: LyricStrip = {
        w: bin.w,
        h: bin.h,
        data: bin.data,
        box,
        charH: [...cells.map((c) => unionBox(c).h)].sort((a, b) => a - b)[cells.length >> 1],
        cells: cells.map((c) => {
          const b = unionBox(c);
          return { x0: (b.x - box.x) / box.w, x1: (b.x + b.w - box.x) / box.w, box: b };
        }),
      };
      lyricStrips.push(strip);
      stripStaff.set(strip, st);
    }
  });
  if (lyricStrips.length) {
    const ocr = await live.lyric(lyricStrips);
    const objs: PObj[] = [];
    for (const strip of lyricStrips) {
      let chars = ocr.get(stripKey(strip));
      if (!chars?.length) continue;
      // 行尾的跳转记号（「…華美！Fine.」）摘出来挂成谱表下方的文字指示
      const tail = jumpTail(chars);
      if (tail) {
        chars = tail.rest;
        const x = strip.box.x + tail.xFrac * strip.box.w;
        const st = stripStaff.get(strip)!;
        const row = notes.filter((n) => n.staff === st && !n.chordExtra && !n.grace && n.x <= x).sort((a, b) => a.x - b.x);
        const n = row[row.length - 1];
        if (n) {
          const box = { left: x, right: strip.box.x + strip.box.w, top: strip.box.y, bottom: strip.box.y + strip.box.h };
          (n.words ??= []).push({ text: tail.text, above: false, size: strip.charH, baseY: box.bottom, box });
        }
      }
      const cells = mapCharsToCells(strip, chars);
      if (!cells.some((c) => c.ch)) continue;
      const o = makeTextObj(pg.objs.length + objs.length, { cells, sizeDev: strip.charH });
      o.addTag("Lyric");
      objs.push(o);
    }
    pg.objs.push(...objs);
    const lines = buildLyricLines(pg, objs);
    attachLyrics(notes, lines);
    res.lyricRows = lines.length;
    res.lyricLines = lines;
  }

  // ── 简谱行里印的说明文字（「(桥段反復時用上方的旋律)」）：一串挨得很紧的字，简谱数字之间都隔着空 ──────────
  const notes2 = new Set<VecObj>();
  const noteStrips: { strip: LyricStrip; st: Staff }[] = [];
  for (const b of bands) {
    const st = staffOfBox(b.staff);
    if (!st) continue;
    const inb = texts.filter((o) => inside(b.box, cx(o), cy(o)) && o.bbox.h > sp * 0.8).sort((p, q) => p.bbox.x - q.bbox.x);
    let run: VecObj[] = [];
    const flush = () => {
      if (run.length >= NOTE_RUN) {
        for (const o of run) notes2.add(o);
        const box = pad(unionBox(run), sp * 0.3);
        const bin = rasterizeObjs(run, box, OCR_SCALE);
        const strip: LyricStrip = { w: bin.w, h: bin.h, data: bin.data, box, charH: box.h, cells: run.map((o) => ({ x0: (o.bbox.x - box.x) / box.w, x1: (o.bbox.x + o.bbox.w - box.x) / box.w, box: objRect(o) })) };
        noteStrips.push({ strip, st });
      }
      run = [];
    };
    for (const o of inb) {
      const last = run[run.length - 1];
      if (last && o.bbox.x - (last.bbox.x + last.bbox.w) > Math.max(o.bbox.h, last.bbox.h) * NOTE_GAP) flush();
      run.push(o);
    }
    flush();
  }
  if (noteStrips.length) {
    const ocr = await live.lyric(noteStrips.map((q) => q.strip));
    for (const { strip, st } of noteStrips) {
      const text = (ocr.get(stripKey(strip)) ?? []).map((c) => c.ch).join("").trim();
      if (!/[\u4e00-\u9fff]{2}/.test(text)) continue;
      const row = notes.filter((n) => n.staff === st && !n.chordExtra && !n.grace).sort((a, b) => a.x - b.x);
      // 说明印在它管的那几小节上方：挂字左端所在那一小节的第一个音（字常比首音还靠右一点；往左让又会够着前一小节的末音）
      const x0 = strip.box.x + sp * 0.3;
      const bar = st.bars.find((b) => x0 >= b.left && x0 < b.right);
      const n = row.find((q) => q.x >= (bar ? bar.left : x0)) ?? row[row.length - 1];
      if (!n) continue;
      const box = { left: strip.box.x, right: strip.box.x + strip.box.w, top: strip.box.y, bottom: strip.box.y + strip.box.h };
      (n.words ??= []).push({ text, above: true, size: strip.box.h, baseY: box.bottom, box });
    }
  }

  // ── 简谱行互证（位图路 `jianpufuse.ts`；OCR 回来的 x 是条里的像素，换回页面单位） ──────────────
  if (bands.length && live.jianpu) {
    const strips: JianpuStrip[] = bands.map((b) => {
      const objs = vec.objs.filter((o) => inside(b.box, cx(o), cy(o)) && o.bbox.w < b.box.w * 0.5 && !notes2.has(o));
      const bin = rasterizeObjs(objs, b.box, OCR_SCALE);
      return { staff: b.staff, box: b.box, w: bin.w, h: bin.h, data: bin.data, bars: b.bars };
    });
    const ocr = await live.jianpu(strips);
    const rows = (strip: JianpuStrip): JianpuRow[] | undefined =>
      ocr.get(jianpuKey(strip))?.map((row) => ({ bars: row.bars.map((x) => x / OCR_SCALE), nums: row.nums.map((n) => ({ ...n, x: n.x / OCR_SCALE })) }));
    res.jianpuFix = fuseJianpu(notes, strips, (strip) => staffOfBox(strip.staff), rows, (st) => keyFifths(r.ctx.get(st)?.key ?? []), unit);
  }

  // ── 页眉（曲首页）：首行谱的和弦带以上 ─────────────────────────────────────
  if (opts.wantHeader && live.header) {
    const s0 = staffBoxes[0];
    const own = bands.filter((b) => b.staff === 0);
    const limit = (own.length ? Math.min(...own.map((b) => b.box.y)) : s0.top) - sp * CHORD_ZONE;
    const items = texts.filter((o) => !used.has(o) && cy(o) < limit);
    // 速度记号先摘出来（页眉 OCR 读不出音符字形，连带把「=64」也丢了）
    const tempo = findTempoMark(items, sp);
    let bpm: number | null = null;
    if (tempo && live.time) {
      const box = pad(unionBox(tempo.digits), sp * 0.3);
      const bin = rasterizeObjs(tempo.digits, box, OCR_SCALE);
      const strip: TimeStrip = { w: bin.w, h: bin.h, data: bin.data, box, staff: 0, role: "num" };
      const txt = (await live.time([strip])).get(timeKey(strip));
      if (txt && /^\d{2,3}$/.test(txt)) bpm = Number(txt);
    }
    const rest = tempo ? items.filter((o) => !tempo.parents.has(o)) : items;
    if (rest.length) {
      const box = pad(unionBox(rest), sp * 0.5);
      const bin = rasterizeObjs(rest, box, OCR_SCALE);
      const strip: WordStrip = { w: bin.w, h: bin.h, data: bin.data, box };
      const lines = (await live.header([strip])).get(wordKey(strip)) ?? [];
      let scaled: WordLine[] = lines.map((l) => ({ ...l, x: l.x / OCR_SCALE, y: l.y / OCR_SCALE, w: l.w / OCR_SCALE, h: l.h / OCR_SCALE }));
      const first = [...notes].filter((n) => !n.grace).sort((a, b) => a.staff.box.top - b.staff.box.top || a.x - b.x)[0];
      if (tempo && bpm && first) {
        first.metronome = { unit: "quarter", bpm };
        const t = unionBox([...tempo.parents]);
        first.tempoBox = { left: t.x, right: t.x + t.w, top: t.y, bottom: t.y + t.h };
        // 同一行、紧跟在速度后面的字（「渴慕、宣告地」）是速度文字，不是署名
        const same = scaled.find((l) => {
          const y0 = box.y + l.y, y1 = y0 + l.h, x0 = box.x + l.x;
          return Math.min(y1, t.y + t.h) - Math.max(y0, t.y) > Math.min(l.h, t.h) * 0.5 && x0 > t.x + t.w - sp && x0 - (t.x + t.w) < sp * 8;
        });
        if (same) {
          first.tempoText = same.t;
          scaled = scaled.filter((l) => l !== same);
        }
      }
      res.header = headerCredits(scaled, strip);
    }
  }
  return res;
}


/** 房子的竖钩长度（线距） */
const VOLTA_HOOK: [number, number] = [0.6, 5];
/** 房子横线被房号断开（钩后一小截、房号、空一段再接长线）：接续的长线起点离钩最远（线距），同位图路 `repeats.ts::VOLTA_BREAK` */
const VOLTA_BREAK = 5.5;
/** 房子横线至少多长（线距） */
const VOLTA_LEN = 3;

/**
 * 房子：横线、左端下垂的竖钩，钩底落在简谱行（没有简谱行时谱表）之上三格以内。矢量路的 `findVoltas` 要钩底贴着谱表顶、
 * 房号是文字层，简线混排谱两样都不满足（房子在简谱行之上、房号是转曲的字形）。房号不认字，按反复线推（同位图路 `repeats.ts`）：
 * 前一小节右端是 `:|` 的是第 2 房，罩着的末小节以 `:|` 收尾的是第 1 房，印在行首、接上一行的是第 2 房。同系统各行照抄。
 */
function markVoltas(pg: SPage, bands: readonly JianpuBand[], sp: number): void {
  const hs = pg.segs.filter((q) => q.isH && !q.hasAnyTag() && q.len >= sp * 0.3);
  const hooks = pg.segs.filter((q) => q.isV && !q.hasAnyTag() && q.len >= sp * VOLTA_HOOK[0] && q.len <= sp * VOLTA_HOOK[1]).sort((a, b) => a.cx - b.cx);
  const voltas: (Volta & { staff: Staff })[] = [];
  for (const hook of hooks) {
    const st = pg.staves.find((s) => {
      if (hook.cx < s.box.left - sp || hook.cx > s.box.right + sp) return false;
      const own = bands.filter((b) => Math.abs(b.box.y + b.box.h - s.box.top) < sp * 3 || inside(b.box, hook.cx, s.box.top - sp));
      const top = own.length ? Math.min(...own.map((b) => b.box.y)) : s.box.top;
      return hook.bottom <= top + sp * 0.5 && top - hook.bottom <= sp * 3;
    });
    if (!st) continue;
    const y = hook.top;
    const level = hs.filter((q) => Math.abs(q.cy - y) <= sp * 0.4 && q.right > hook.cx + sp * 0.2).sort((a, b) => a.left - b.left);
    const stub = level.find((q) => Math.abs(q.left - hook.cx) <= sp * 0.5);
    if (!stub) continue;
    let right = stub.right;
    for (const q of level) {
      if (q === stub || q.left < right - sp * 0.2) continue;
      if (q.left - hook.cx > sp * VOLTA_BREAK && q.left - right > sp * 0.5) break;
      // 隔着下一房的钩就停（第 1 房收尾的「┐」后面紧接着第 2 房）
      if (hooks.some((h) => h !== hook && h.cx > right + sp * 0.3 && h.cx < q.left && Math.abs(h.top - y) <= sp * 0.4)) break;
      right = Math.max(right, q.right);
    }
    if (right - hook.cx < sp * VOLTA_LEN) continue;
    hook.addTag("Notation");
    voltas.push({ number: "1", left: hook.cx, right, staffTop: st.box.top, staff: st });
  }
  for (const v of voltas) {
    const covered = v.staff.bars.filter((b) => b.right > v.left + sp && b.left < v.right - sp);
    const prev = covered[0] ? v.staff.bars[v.staff.bars.indexOf(covered[0]) - 1] : undefined;
    if (prev?.rightRepeat) v.number = "2";
    else if (covered[covered.length - 1]?.rightRepeat) v.number = "1";
    else if (covered[0] && covered[0] === v.staff.bars[0]) v.number = "2";
  }
  attachVoltas(pg, voltas);
  for (const v of voltas) {
    const sys = pg.systems.find((q) => q.staves.includes(v.staff));
    for (const b of v.staff.bars) {
      if (b.endingNumber !== v.number) continue;
      for (const o of sys?.staves ?? []) {
        if (o === v.staff) continue;
        const q = o.bars.find((x) => Math.abs(x.left - b.left) < sp);
        if (!q) continue;
        q.endingNumber = b.endingNumber;
        q.endingStart = b.endingStart;
        q.endingStop = b.endingStop;
      }
    }
  }
}

/**
 * 页眉里的速度记号「♩=64」：音符字形（符头连符干一块，窄、两格多高）右边紧跟「=」（两条平行短横），再跟一串数字。
 * 返回数字那几块（送拍号数字的 OCR）与它们所属的对象（页眉 OCR 不再收）；找不到为 null。
 */
function findTempoMark(objs: readonly VecObj[], sp: number): { digits: VecObj[]; parents: Set<VecObj> } | null {
  // 「♩=64」常是一个对象（一次 showText 转出来的），拆成块再找
  const parent = new Map<VecObj, VecObj>();
  const items: VecObj[] = [];
  for (const o of objs) for (const p of splitPieces(o)) (parent.set(p, o), items.push(p));
  for (const n of items) {
    const w = n.bbox.w / sp;
    const h = n.bbox.h / sp;
    if (w < 0.5 || w > 1.1 || h < 2 || h > 3) continue;
    const right = n.bbox.x + n.bbox.w;
    const bars = items.filter((o) => o.bbox.h < sp * 0.3 && o.bbox.w > sp * 0.6 && o.bbox.w < sp * 1.6 && o.bbox.x > right && o.bbox.x - right < sp * 1.5 && cy(o) > n.bbox.y && cy(o) < n.bbox.y + n.bbox.h);
    if (bars.length !== 2) continue;
    let end = Math.max(...bars.map((b) => b.bbox.x + b.bbox.w));
    const digits: VecObj[] = [];
    for (const o of [...items].sort((a, b) => a.bbox.x - b.bbox.x)) {
      if (o.bbox.x < end - sp * 0.1 || o.bbox.x - end > sp * 0.6 || o.bbox.h < sp * 1.2 || o.bbox.h > sp * 2.2 || cy(o) < n.bbox.y || cy(o) > n.bbox.y + n.bbox.h) continue;
      digits.push(o);
      end = o.bbox.x + o.bbox.w;
    }
    if (digits.length) return { digits, parents: new Set([n, ...bars, ...digits].map((p) => parent.get(p)!)) };
  }
  return null;
}
