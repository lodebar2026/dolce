// L5 五线谱 / 混排引擎迁 Rust 的 TS 参考导出（dev `staff-rs-diff.mjs`）：一档用例 = 文档（带 `_oid`）+ MusicXML 原文（有表层时）
// + 选项 + 各阶段的版面态 dump（`staffDump`）+ 整页场景。Rust 那份在 `crates/dolce-layout-staff/src/dump.rs`，键与形两边同一口径。
// 只给对拍用；排版迁完（H 期）随 TS 排版一起删。
import type { ScoreDoc } from "../model/doc";
import { docJson } from "../model/rustdoc";
import { staffOptionsOf, type StaffPaintRequest } from "../layout/painter";
import { layoutStaff } from "../mixed/layout";
import { layoutStaffPages, PAGE_HEIGHT_FALLBACK } from "../mixed/staffpages";
import type { Fraction } from "../common/fraction";
import type { Font } from "../pagetree/font";
import type {
  ChordLayout, LyricLayout, MeasureLayout, PartLayout, PartMeasureLayout, StaffLayout, Sys, TextBlock, TickMap,
} from "../mixed/model";
import { sceneNode } from "./layoutref";
import type { MetaData } from "../smufl/smufl";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 数：非有限数写成 `"NaN"` / `"Inf"` / `"-Inf"` */
const jn = (x: number | undefined | null): Json =>
  x === undefined || x === null ? null : Number.isFinite(x) ? x : Number.isNaN(x) ? "NaN" : x > 0 ? "Inf" : "-Inf";
const fr = (f: Fraction | null | undefined): Json => (f ? [f.numerator, f.denominator] : null);
const font = (f: Font | undefined | null): Json => (f ? { family: f.family, size: jn(f.size), bold: f.bold, italic: f.italic } : null);
const tick = <T>(m: TickMap<T>, v: (x: T) => Json): Json => m.entries.map((e) => [fr(e.t), v(e.v)]);

function textBlock(t: TextBlock): Record<string, Json> {
  return {
    x: jn(t.x), y: jn(t.y), justify: t.justify, title: t.title,
    data: t.data.map((it) => ({
      text: it.text, font: font(it.font), dy: jn(it.dy), music: it.music, superscript: jn(it.superscript),
      nominalSize: jn(it.nominalSize), padBefore: jn(it.padBefore),
    })),
  };
}

function chord(ch: ChordLayout): Json {
  return {
    id: ch.src.id, offset: fr(ch.offset), measureRest: ch.measureRest, doubleSide: ch.doubleSide,
    stemLen: jn(ch.stemLen), stemUp: ch.stemUp, srcTipY: jn(ch.srcTipY), stemExtra: jn(ch.stemExtra),
    beams: [...ch.beams], breath: ch.breath,
    notations: ch.notations.map((n) => ({ symbol: n.symbol, dx: jn(n.dx), y: jn(n.y), above: n.above, outside: n.outside, placed: n.placed ?? null })),
    notes: ch.notes.map((n) => ({
      x: jn(n.x), writtenPitch: n.writtenPitch, jpMelody: n.jpMelody, tieBegin: n.tieBegin, tieEnd: n.tieEnd, flipped: n.flipped,
      entry: n.entry ? ch.measure.noteEntries.indexOf(n.entry) : null,
    })),
  };
}

function lyric(l: LyricLayout): Json {
  return {
    chord: l.chord.src.id, verse: l.src.number, text: l.text, prefix: l.prefix, offset: fr(l.offset), font: font(l.font), compress: l.compress,
    extend: fr(l.extend), x: jn(l.x), y: jn(l.y), srcY: jn(l.srcY), xOffset: jn(l.xOffset), width: jn(l.width),
    next: l.next ? [l.next.chord.src.id, l.next.src.number] : null,
  };
}

function partMeasure(md: PartMeasureLayout): Json {
  const beams = (gs: typeof md.beams): Json => gs.map((g) => ({ chords: g.chords.map((c) => c.src.id), jp: g.jp, doubleDir: g.doubleDir }));
  return {
    chords: md.chords.map(chord),
    lyrics: md.lyrics.map(lyric),
    harmonies: md.harmonies.map((h) => ({ offset: fr(h.offset), x: jn(h.x), y: jn(h.y), staff: h.staff })),
    texts: md.textBlocks.map((t) => ({
      ...textBlock(t), offset: fr(t.offset), staff: t.staff, relative: t.relative, autoY: t.autoY, sourceY: t.sourceY, sourceSize: t.sourceSize,
      signPlaced: t.signPlaced, boxed: t.boxed, frameless: t.frameless,
    })),
    arpegs: md.arpegs.map((a) => a.notes.map((n) => [n.chord.src.id, n.chord.notes.indexOf(n)])),
    beams: beams(md.beams), graceBeams: beams(md.graceBeams), jpBeams: beams(md.jpBeams),
    entries: md.noteEntries.map((e) => ({
      subStaff: e.subStaff, offset: fr(e.offset),
      leger: [...e.leger.ranges].map(([l, [a, b]]) => [l, jn(a), jn(b)]),
      dots: [...e.dot.dots], dotPos: jn(e.dot.dotPos),
      acc: e.acc.accidentals.map((it) => ({ line: it.line, xpos: jn(it.xpos), scale: jn(it.scale), symbols: [...it.symbols] })),
    })),
  };
}

const noteRef = (n: { chord: ChordLayout } | null | undefined): Json =>
  n ? [n.chord.src.id, n.chord.notes.indexOf(n as never)] : null;

function part(p: PartLayout): Json {
  const span = (s: { startTick: Fraction; endTick: Fraction; above: boolean }) => ({ start: fr(s.startTick), end: fr(s.endTick), above: s.above });
  const meas = (m: MeasureLayout | undefined) => (m ? m.index : null);
  return {
    pid: p.pid, name: p.name, abbrev: p.abbrev, nameSize: jn(p.nameSize),
    staves: p.staves.map((st) => ({
      order: st.order,
      key: tick(st.key, (k) => [k.fifths, k.cancel]),
      clef: tick(st.clef, (c) => [c.sign.codePointAt(0) ?? 0, c.line]),
      time: tick(st.time, (t) => [t.beats, t.beatType, t.symbol]),
      notation: tick(st.notation, (n) => n),
    })),
    measures: p.measures.map(partMeasure),
    slurs: p.slurs.map((s) => ({ ...span(s), start0: noteRef(s.startNote), end0: noteRef(s.endNote), autoDir: s.autoDir })),
    tied: p.tied.map((s) => ({ ...span(s), start0: noteRef(s.startNote), end0: noteRef(s.endNote), yOffsetType: s.yOffsetType, srcDir: s.srcDir })),
    tuplets: p.tuplets.map((s) => ({ ...span(s), start0: noteRef(s.startNote), end0: noteRef(s.endNote), tm: fr(s.timeModification), bracket: s.bracket })),
    endings: p.endings.map((s) => ({ ...span(s), sm: meas(s.startMeasure), em: meas(s.endMeasure), number: s.number, hasStop: s.hasStop })),
    wedges: p.wedges.map((s) => ({
      ...span(s), sm: meas(s.startMeasure), em: meas(s.endMeasure), crescendo: s.crescendo, staff: s.staff, ypos: jn(s.ypos), autoY: s.autoY,
      dxLeft: jn(s.dxLeft), dxRight: jn(s.dxRight), spread: jn(s.spread),
    })),
    pedals: p.pedalLines.map((s) => ({ ...span(s), sm: meas(s.startMeasure), em: meas(s.endMeasure), sign: s.sign, line: s.line, staff: s.staff, ypos: jn(s.ypos) })),
    octaves: p.octaveLines.map((s) => ({ ...span(s), sm: meas(s.startMeasure), em: meas(s.endMeasure), staff: s.staff, size: s.size })),
    lrcExtends: p.lrcExtends.map((s) => ({
      ...span(s), start0: noteRef(s.startNote), end0: noteRef(s.endNote),
      lyric: s.start ? [s.start.chord.src.id, s.start.src.number] : null, stop: s.stop ? [s.stop.chord.src.id, s.stop.src.number] : null,
    })),
  };
}

function measure(m: MeasureLayout, sysOf: Map<Sys, number>): Json {
  return {
    number: m.number, multiRest: m.multiRest, index: m.index, dur: fr(m.dur), offset: fr(m.offset), width: jn(m.width),
    forward: m.forward, backward: m.backward, endingNum: [...m.endingNum], leftEnding: m.leftEndingType, rightEnding: m.rightEndingType,
    clefPos: jn(m.clefPos), keyPos: jn(m.keyPos), timePos: jn(m.timePos), keyOffestJP: jn(m.keyOffestJP),
    leftBarlinePos: jn(m.leftBarlinePos), dataPos: jn(m.dataPos), dataEnd: jn(m.dataEnd), showBarNumber: m.showBarNumber, implicit: m.implicit,
    sibKeyOffset: jn(m.sibKeyOffset), entPos: tick(m.entPos, jn), leftBarline: m.leftBarline, rightBarline: m.rightBarline,
    system: m.system ? sysOf.get(m.system) ?? -1 : null,
  };
}

/** 版面态 dump（读入、分系统、排定、装页各阶段同一个口径；还没算到的字段照初值写）。 */
export function staffDump(score: StaffLayout): Json {
  const sysOf = new Map(score.systems.map((s, i) => [s, i] as [Sys, number]));
  const d = score.defaults;
  return {
    scaling: jn(score.scaling), autoLayout: score.autoLayout, keepBreaks: score.keepBreaks, hardBreaks: score.hardBreaks,
    longImage: score.longImage, dataXPlaced: score.dataXPlaced, scripture: [...score.scripture],
    harmonySize: jn(score.options.harmonySize),
    defaults: {
      pageWidth: jn(d.pageWidth), pageHeight: jn(d.pageHeight), leftMargin: jn(d.leftMargin), rightMargin: jn(d.rightMargin),
      topMargin: jn(d.topMargin), bottomMargin: jn(d.bottomMargin), lyricFont: font(d.lyricFont), wordFont: font(d.wordFont),
      musicTextFont: font(d.musicTextFont), wordFontGiven: d.wordFontGiven,
    },
    credits: score.credits.map((c) => ({
      page: c.page, text: c.text, type: c.type, x: jn(c.x), y: jn(c.y), justify: c.justify, fontSize: jn(c.fontSize),
      family: c.family ?? null, bold: c.bold ?? false, valign: c.valign ?? null,
    })),
    measures: score.measures.map((m) => measure(m, sysOf)),
    parts: score.parts.map(part),
    partGroups: score.partGroups.map((g) => ({
      parts: g.parts.map((p) => score.parts.indexOf(p)), number: g.number, barline: g.barline, symbol: g.symbol, staffRange: g.staffRange ?? null,
    })),
    systems: score.systems.map((s) => ({
      index: s.index, distance: jn(s.distance), firstMeasure: s.firstMeasure, measures: s.measures.length,
      leftMargin: jn(s.leftMargin), rightMargin: jn(s.rightMargin), keyChangeWidth: jn(s.keyChangeWidth), timeChangeWidth: jn(s.timeChangeWidth),
      staves: s.staves.map((st) => ({
        part: score.parts.indexOf(st.partStaff.part), sub: st.partStaff.subIndex, distance: jn(st.distance), minDistance: jn(st.minDistance),
        srcDistance: jn(st.srcDistance), staffLines: st.staffLines, staffScale: jn(st.staffScale), staffVisible: st.staffVisible,
        minY: jn(st.minY), harmonyY: jn(st.harmonyY), hasHarmony: st.hasHarmony,
      })),
    })),
    pages: score.pages.map((p) => ({
      width: jn(p.width), height: jn(p.height), left: jn(p.left), right: jn(p.right), top: jn(p.top), bottom: jn(p.bottom),
      systems: p.systems.map((s) => sysOf.get(s) ?? -1),
      texts: p.texts.map(textBlock),
    })),
  };
}

/** 五线谱引擎吃的选项（同 style-rs-diff 的 `staffPlain`：去掉 SMuFL 元数据） */
const optionsJson = (o: unknown): Json => JSON.parse(JSON.stringify(o, (k, v) => (k === "meta" ? undefined : v))) as Json;

/**
 * 五线谱这一路的一档用例：照 `painter.ts::_staffCommit` 重排一遍，沿途取四个阶段的 dump——
 * `read`（读入建树后、`finishMixedScore` 之前）、`systems`（分系统、两端对齐、`layoutAttr` 之后）、`layout`（`layoutStaff` 返回）、
 * `pages`（`layoutStaffPages` 之后，含 `placed`）——与整页场景。
 */
export function staffCase(req: StaffPaintRequest, meta: MetaData): { doc: Json; xml: string | null; options: Json; mixed: boolean; jianpuPart: number; expect: Record<string, Json> } {
  const doc: ScoreDoc = req.doc;
  const options = staffOptionsOf(meta, req.style);
  options.hideBarNumber = req.hideBarNumber;
  options.page = req.page;
  options.sourceBreaks = req.sourceBreaks ?? false;
  const optJson = optionsJson(options);
  const expect: Record<string, Json> = {};
  const score = layoutStaff(doc, options, (stage, s) => (expect[stage] = staffDump(s)));
  expect.layout = staffDump(score);
  const mixed = req.view === "mixed";
  const { pages, placed } = layoutStaffPages(score, mixed, req.jianpuPart ?? 0);
  const sysOf = new Map(score.systems.map((s, i) => [s, i] as [Sys, number]));
  const pagesDump = staffDump(score) as Record<string, Json>;
  pagesDump.placed = placed.map((p) => ({ sys: sysOf.get(p.sys) ?? -1, page: p.page, top: jn(p.top) }));
  expect.pages = pagesDump;
  const d = score.defaults;
  const w = d.pageWidth ?? 1200;
  const h = d.pageHeight ?? PAGE_HEIGHT_FALLBACK;
  expect.scenes = pages.map((root) => ({ dialect: "mixed", cls: "score-page mixed-page", w, h, root: sceneNode(root) }));
  const dj = docJson(doc);
  return {
    doc: JSON.parse(dj.json) as Json,
    xml: dj.s && doc.sourceFormat === "musicxml" && typeof doc.source === "string" ? doc.source : null,
    options: optJson,
    mixed,
    jianpuPart: req.jianpuPart ?? 0,
    expect,
  };
}
