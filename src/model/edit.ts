// 改模型的编辑动作：`.musicxml` 在谱面上改谱走这里（`editor/visual/modelops.ts` 调它，改完经 `toxml.ts` 整份重写）。
//
// 文本格式的可视化编辑改的是原文（`editor/visual/ops.ts`），MusicXML 没有可以局部补丁的「原文 token」——
// 它的真身是模型：改音高、时值、增删音与小节都在 `ScoreDoc` 上做，多声部的 `<backup>`/`<forward>` 由写出端按 `onset` 重算。
// **纯模型、不碰 DOM**（CLI 能测）。每个动作返回改完要选中什么（`ModelEdit`），由调用方按「位置」重新认回新读出的模型
// （重写再读回元素 id 会重编，只有位置——第几声部第几小节哪个声线第几个——跨得过去，见 `ChordPos`）。
//
// 语义对齐文本格式那一路（`ops.ts`）：唱名按调号换算、八度点不变；删音符就是删，不补休止（不满的小节由拍数自检标红）；
// 增时线 = 多一拍；小节线 = 把这一小节在光标处劈成两节（所有声部一起劈）。

import type { Accidental, Chord, Clef, Direction, ElementId, Key, Mark, Measure, Note, NoteType, Part, Pitch, ScoreDoc, Song, Time } from "./doc";
import { SIMPLE_DIVISIONS } from "./doc";
import { degreeFromPitch } from "./jianpu";
import type { ModelMsg } from "./msg";
import { dolce } from "../common/dolce";
import { adopt, call, docJson, msgTextOfJson, replaceDoc } from "./rustdoc";

// ───────────────────────── 定位 ─────────────────────────

export interface ChordLoc {
  si: number;
  pi: number;
  mi: number;
  song: Song;
  part: Part;
  measure: Measure;
  chord: Chord;
  /** 在 `measure.elements` 里的下标 */
  index: number;
}

export function locate(doc: ScoreDoc, id: ElementId): ChordLoc | null {
  for (const [si, song] of doc.songs.entries()) {
    for (const [pi, part] of song.parts.entries()) {
      for (const [mi, measure] of part.measures.entries()) {
        const index = measure.elements.findIndex((e) => e.id === id);
        const el = measure.elements[index];
        if (el?.kind === "chord") return { si, pi, mi, song, part, measure, chord: el, index };
      }
    }
  }
  return null;
}

/** 某小节处生效的调号、拍号与每四分音符的 divisions。 */
export function measureCtx(song: Song, part: Part, mi: number): { key: Key; time?: Time; dpq: number } {
  let key: Key = song.key ?? { fifths: 0 };
  let time: Time | undefined = song.time;
  let dpq = SIMPLE_DIVISIONS;
  for (let i = 0; i <= mi && i < part.measures.length; i++) {
    const a = part.measures[i]!.attrs;
    if (a?.key) key = a.key;
    if (a?.time) time = a.time;
    if (a?.divisions) dpq = a.divisions;
  }
  return { key, time, dpq };
}

/** 一个和弦的「位置」：重写再读回之后元素 id 会重编，按位置认回来。`ord` 是它在本小节本声线里是第几个和弦。 */
export interface ChordPos {
  si: number;
  pi: number;
  mi: number;
  voice: number;
  ord: number;
}

export function posOf(doc: ScoreDoc, chord: Chord): ChordPos | null {
  const loc = locate(doc, chord.id);
  if (!loc) return null;
  const ord = loc.measure.elements.filter((e, i) => i < loc.index && e.kind === "chord" && e.voice === chord.voice).length;
  return { si: loc.si, pi: loc.pi, mi: loc.mi, voice: chord.voice, ord };
}

export function chordAtPos(doc: ScoreDoc, p: ChordPos): Chord | null {
  const m = doc.songs[p.si]?.parts[p.pi]?.measures[p.mi];
  const list = (m?.elements ?? []).filter((e): e is Chord => e.kind === "chord" && e.voice === p.voice);
  return list[p.ord] ?? null;
}

// ───────────────────────── 结果 ─────────────────────────

/** 改完要选中的：一串和弦（编辑模式）或某个和弦前 / 后的插入光标。 */
export type ModelEdit =
  | { select: Chord[] }
  | { caretAfter: Chord }
  | { caretBefore: Chord }
  | { error: ModelMsg };

export const isEditError = (e: ModelEdit): e is { error: ModelMsg } => "error" in e;

// ───────────────────────── 执行（Rust） ─────────────────────────

/** Rust 回的动作结果（和弦按元素 id 给，`number` 是声部面板与转记的回值） */
export type RawEdit =
  | { select: ElementId[] }
  | { caretAfter: ElementId }
  | { caretBefore: ElementId }
  | { error: ModelMsg }
  | { moved: { select: ElementId[]; moved: { markOn: ElementId; kind: string; dirType?: string } | { lyricOf: ElementId; verse: number } } }
  | { number: number };

/** 在 Rust 里执行一个编辑动作（`EditCmd`，`crates/dolce-model/src/edit.rs`）：`doc` 就地换成改后的（表层身份照旧挂着）。
 *  `hooks` 给了就作废改动碰到的表层版面（同以前传 `forgetStem` / `forgetLayout`）。 */
export function applyEditCmd(doc: ScoreDoc, cmd: object, hooks?: EditHooks): RawEdit {
  const { json, s, h } = docJson(doc);
  const touch = !!(hooks?.forgetStem || hooks?.forgetLayout);
  const out = call(() => dolce().modelEdit(json, h, JSON.stringify(cmd), touch, msgTextOfJson));
  const r = adopt<{ edit: RawEdit; doc: ScoreDoc }>(out, s);
  replaceDoc(doc, r.doc);
  return r.edit;
}

/** 编辑动作：执行后把结果里的元素 id 认回改后模型里的和弦 */
function run(doc: ScoreDoc, cmd: object, hooks?: EditHooks): ModelEdit & { moved?: MovedMark } {
  const r = applyEditCmd(doc, cmd, hooks);
  const at = (id: ElementId): Chord | null => locate(doc, id)?.chord ?? null;
  const all = (ids: ElementId[]): Chord[] => ids.map(at).filter((c): c is Chord => c !== null);
  if ("error" in r) return r;
  if ("select" in r) return { select: all(r.select) };
  if ("caretAfter" in r) {
    const c = at(r.caretAfter);
    return c ? { caretAfter: c } : { select: [] };
  }
  if ("caretBefore" in r) {
    const c = at(r.caretBefore);
    return c ? { caretBefore: c } : { select: [] };
  }
  if ("moved" in r) {
    const m = r.moved.moved;
    const host = at("lyricOf" in m ? m.lyricOf : m.markOn);
    const moved: MovedMark | undefined = !host ? undefined
      : "lyricOf" in m ? { lyricOf: host, verse: m.verse }
      : m.kind === "dir" ? { markOn: host, kind: "dir", dirType: m.dirType ?? "" }
      : { markOn: host, kind: m.kind as "harmony" | "slur" };
    return { select: all(r.moved.select), ...(moved ? { moved } : {}) };
  }
  return { select: [] };
}

// ───────────────────────── 音高 ─────────────────────────

const STEPS = ["C", "D", "E", "F", "G", "A", "B"] as const;
const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];

/** 调号里这个音名本来带的升降（`K:F` 的 B 为 -1）。 */
export function keyAlter(step: string, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

export function midiOfPitch(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMI[p.step]! + p.alter;
}

/**
 * 重算一小节里临时记号的**印法**：同一谱表、同一音名同一八度，按时间先后，与当前生效的升降（调号或前面的临时记号）
 * 一致就不印、不一致就印。改音高之后要跑：前面把 F 改成 F♯，后面原本不印记号的 F 就得印还原号。
 */
export function respellMeasure(measure: Measure, key: Key): void {
  // 只动各音的 `accidental`：就地抄回，音符对象（及其表层身份）不换
  const fresh = JSON.parse(call(() => dolce().modelRespellMeasure(JSON.stringify(measure), JSON.stringify(key)))) as Measure;
  measure.elements.forEach((el, i) => {
    const f = fresh.elements[i];
    if (el.kind !== "chord" || f?.kind !== "chord") return;
    el.notes.forEach((n, k) => {
      const acc = f.notes[k]?.accidental;
      if (acc === undefined) delete n.accidental;
      else n.accidental = acc;
    });
  });
}

// ───────────────────────── 时值 ─────────────────────────

const TYPES: readonly [NoteType, number][] = [
  ["whole", 4], ["half", 2], ["quarter", 1], ["eighth", 0.5], ["16th", 0.25], ["32nd", 0.125], ["64th", 0.0625],
];

/** divisions → 符号时值（带至多两个附点）；写不出（五连音那种）为 null。 */
export function typeOfDivisions(div: number, dpq: number): { type: NoteType; dots: number } | null {
  const q = div / dpq;
  for (const [type, base] of TYPES) {
    for (let dots = 0; dots <= 2; dots++) {
      const len = base * (2 - Math.pow(0.5, dots));
      if (Math.abs(len - q) < 1e-9) return { type, dots };
    }
  }
  return null;
}

/**
 * 整个声部的时值单位放大 `k` 倍（每四分音符的 divisions、所有时值、起点、偏移一起乘）。
 * 原谱 divisions 太粗（每四分音符 1、2 个）时，附点八分、十六分写不成整数，先放大再写——MusicXML 允许任意 divisions，
 * 读谱的软件按它换算，音乐上一个音不变。
 */
export function scalePartDivisions(part: Part, k: number): void {
  const h = (x: { offset?: number; onset?: number } | undefined): void => {
    if (!x) return;
    if (x.offset !== undefined) x.offset *= k;
    if (x.onset !== undefined) x.onset *= k;
  };
  for (const m of part.measures) {
    if (m.attrs?.divisions) m.attrs.divisions *= k;
    for (const la of m.laterAttrs ?? []) {
      if (la.onset !== undefined) la.onset *= k;
      if (la.attrs.divisions) la.attrs.divisions *= k;
    }
    if (m.duration !== undefined) m.duration *= k;
    for (const d of m.directions ?? []) h(d);
    for (const el of m.elements) {
      if (el.duration) el.duration.divisions *= k;
      if (el.onset !== undefined) el.onset *= k;
      h(el.harmony);
      if (el.kind === "chord") for (const lh of el.laterHarmonies ?? []) h(lh);
    }
  }
}

/**
 * 重排一小节一个声线的符杠：同一拍里连着的八分及更短的音连成一组（复拍子三个八分一组），休止断开。
 * 改了时值、增删了音的那一段要跑，否则原文的 `<beam>` 还挂在旧的组上。
 */
export function rebeam(measure: Measure, voice: number, time: Time | undefined, dpq: number): void {
  const group = time && time.beatType === 8 && time.beats % 3 === 0 ? dpq * 1.5 : dpq;
  const LEVEL: Partial<Record<NoteType, number>> = { eighth: 1, "16th": 2, "32nd": 3, "64th": 4, "128th": 5 };
  const chords: { ch: Chord; at: number; lv: number }[] = [];
  let at = 0;
  for (const el of measure.elements) {
    if (el.kind !== "chord" || el.voice !== voice) continue;
    if (el.onset !== undefined) at = el.onset;
    if (el.grace) continue;
    const lv = el.rest || el.duration.timeMod ? 0 : LEVEL[el.duration.type ?? "quarter"] ?? 0;
    chords.push({ ch: el, at, lv });
    at += el.duration.divisions;
  }
  let i = 0;
  while (i < chords.length) {
    const g = Math.floor(chords[i]!.at / group);
    let j = i;
    while (j < chords.length && chords[j]!.lv > 0 && Math.floor(chords[j]!.at / group) === g) j++;
    if (j === i) {
      if (!chords[i]!.ch.duration.timeMod) delete chords[i]!.ch.beams;
      i++;
      continue;
    }
    const run = chords.slice(i, j);
    if (run.length < 2) delete run[0]!.ch.beams;
    else {
      for (const [k, c] of run.entries()) {
        const beams: NonNullable<Chord["beams"]> = [];
        for (let level = 1; level <= c.lv; level++) {
          const prev = (run[k - 1]?.lv ?? 0) >= level;
          const next = (run[k + 1]?.lv ?? 0) >= level;
          beams.push(prev && next ? "continue" : prev ? "end" : next ? "begin" : k === 0 ? "forward hook" : "backward hook");
        }
        c.ch.beams = beams;
      }
    }
    i = j;
  }
}

// ───────────────────────── 动作 ─────────────────────────

function chordsOf(doc: ScoreDoc, ids: readonly ElementId[]): ChordLoc[] {
  return ids.map((id) => locate(doc, id)).filter((l): l is ChordLoc => l !== null);
}

export interface EditHooks {
  /** 音高变了：原文里这个和弦的符干方向、纵坐标作废（`xmlsurface.ts::forgetNoteLayout`） */
  forgetStem?(ch: Chord): void;
  /** 小节的内容变了（增删音、改时值、拆并小节）：整曲的版面坐标作废，改由五线谱引擎自动铺排（`xmlsurface.ts::dropEmbeddedLayout`） */
  forgetLayout?(song: Song): void;
}

/** 改唱名（`0` = 改成休止）：八度点不变；休止改成音时八度取离前一个音最近的。 */
export function setDegree(doc: ScoreDoc, ids: readonly ElementId[], degree: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "setDegree", ids, degree }, hooks);
}

/** 升降八度：和弦里每个音一起挪。 */
export function shiftOctave(doc: ScoreDoc, ids: readonly ElementId[], delta: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "shiftOctave", ids, delta }, hooks);
}

/** 升号 / 降号 / 还原号（相对调号，同简谱的写法）：已经是这样就取消（回到调号本身）。 */
export function toggleAccidental(doc: ScoreDoc, ids: readonly ElementId[], acc: "sharp" | "flat" | "natural", hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "toggleAccidental", ids, acc }, hooks);
}

/** 附点：加一个或去掉（去掉时全部去掉）。 */
export function toggleDot(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "toggleDot", ids }, hooks);
}

/** 时值减半 / 加倍（附点照留）。 */
export function scaleDuration(doc: ScoreDoc, ids: readonly ElementId[], factor: 0.5 | 2, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "scaleDuration", ids, factor }, hooks);
}

/** 增时线：多一拍（一个四分音符）。 */
export function addBeat(doc: ScoreDoc, id: ElementId, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "addBeat", id }, hooks);
}

/** 插入位置：某个和弦之后，或某小节开头（声部、声线照给的）。 */
export type InsertAnchor =
  | { after: ElementId }
  | { measureStart: { si: number; pi: number; mi: number; voice: number } };

/** 某声线落在哪条谱表（取它第一个音的；整个声部都没有它为 1）。 */
export function staffOfVoice(part: Part, voice: number): number {
  for (const m of part.measures) for (const e of m.elements) if (e.kind === "chord" && e.voice === voice) return e.staff;
  return 1;
}

/**
 * 谱表内的「第 k 声线」（声部输入 Ctrl+Alt+1–4 的口径，同 MuseScore：每条谱表各有 1–4）在这个声部里的 voice 号。
 * MusicXML 的 voice 号在整个 `<part>` 里统一编，多谱表通行每条谱表占四个（下谱表 5–8，Finale、MuseScore 写出都这样），
 * 也有接着编的（下谱表从 2 起）。所以按本谱表实际用到的号从小到大数第 k 个；不够数时从本谱表第一个号
 * （本谱表还没有音按每谱表四个）往后接，跳开已用掉的号。
 */
export function staffVoice(part: Part, staff: number, k: number): number {
  const mine = new Set<number>();
  const others = new Set<number>();
  for (const m of part.measures) {
    for (const e of m.elements) if (e.kind === "chord") (e.staff === staff ? mine : others).add(e.voice);
  }
  const used = [...mine].sort((a, b) => a - b);
  if (k <= used.length) return used[k - 1]!;
  let v = (used[0] ?? (staff - 1) * 4 + 1) + k - 1;
  while (mine.has(v) || others.has(v)) v++;
  return v;
}

/** 新音符的时值：相对四分音符的减半次数与附点（与文本格式的「当前时值」同一口径）。 */
export interface NewDuration {
  halvings: number;
  dots: number;
}

/** 在锚点处插入一个音（`degree` 0 = 休止）。 */
export function insertChord(doc: ScoreDoc, anchor: InsertAnchor, degree: number, dur: NewDuration, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "insertChord", anchor, degree, dur }, hooks);
}

/** 删掉一些和弦：连带删掉以它们为端点的弧、连音线与延音线（对面那个音的 `tie` 也清掉）。 */
export function deleteChords(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "deleteChords", ids }, hooks);
}

/** 小节里某声线各和弦的起点（divisions）。 */
function onsets(m: Measure): Map<Chord, number> {
  const out = new Map<Chord, number>();
  const voiceAt = new Map<number, number>();
  for (const el of m.elements) {
    const start = (el.kind === "chord" ? el.onset : undefined) ?? voiceAt.get(el.voice) ?? 0;
    const dur = el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : (el.duration?.divisions ?? 0);
    voiceAt.set(el.voice, start + dur);
    if (el.kind === "chord") out.set(el, start);
  }
  return out;
}

/** 插小节线：把锚点所在小节在锚点之后劈成两节。**所有声部一起劈**，要求每个声部每个声线在那一刻都有音符边界。 */
export function splitMeasure(doc: ScoreDoc, afterId: ElementId, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "splitMeasure", afterId }, hooks);
}

/** 删小节线：第 `mi` 小节与下一小节并成一节（所有声部一起并）。下一小节换了调号 / 拍号的不并。 */
export function mergeMeasures(doc: ScoreDoc, si: number, mi: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "mergeMeasures", si, mi }, hooks);
}

/** 在第 `mi` 小节之前换行 / 换页（null = 去掉）。五线谱只能在小节线处换行。 */
export function setBreakBefore(doc: ScoreDoc, si: number, mi: number, kind: "system" | "page" | null): ModelEdit {
  return run(doc, { op: "setBreakBefore", si, mi, kind });
}

/** 圆滑线：首尾两个音之间加一条；已有同样起止的就去掉。 */
export function toggleSlur(doc: ScoreDoc, firstId: ElementId, lastId: ElementId): ModelEdit {
  return run(doc, { op: "toggleSlur", firstId, lastId });
}

/** 延音线：连到同一声线的下一个音（音高要相同）；已连着就去掉。 */
export function toggleTie(doc: ScoreDoc, id: ElementId): ModelEdit {
  return run(doc, { op: "toggleTie", id });
}

/** 音符上的记号：延长号（`fermata` / 倒置 `fermata-inverted`）、奏法（accent、staccato、tenuto…）、装饰（trill-mark、mordent、turn…）。 */
export type DecoKind = "fermata" | "fermata-inverted" | (typeof ARTICULATIONS)[number] | (typeof ORNAMENTS)[number];
export const ARTICULATIONS = ["accent", "staccato", "tenuto", "strong-accent", "staccatissimo", "detached-legato", "breath-mark"] as const;
export const ORNAMENTS = ["trill-mark", "mordent", "inverted-mordent", "turn", "inverted-turn"] as const;

/** 音符记号：有就去掉，没有就加上（选中几个音时，全都有才算有）。 */
export function toggleDeco(doc: ScoreDoc, ids: readonly ElementId[], kind: DecoKind): ModelEdit {
  return run(doc, { op: "toggleDeco", ids, kind });
}

// ───────────────────────── 小节 ─────────────────────────

/** 在第 `mi` 小节之前插入一个空小节（`mi` = 小节数时追加在最后）：所有声部一起插，各放一个整小节休止。 */
export function insertMeasure(doc: ScoreDoc, si: number, mi: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "insertMeasure", si, mi }, hooks);
}

/** 删掉第 `from`..`to` 小节（含）：所有声部一起删；删掉的第一小节带的属性挪给后面那一小节，以它们为端点的弧与连音线一起去掉。 */
export function deleteMeasures(doc: ScoreDoc, si: number, from: number, to: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "deleteMeasures", si, from, to }, hooks);
}

/** 从第 `mi` 小节起换调号（音高不动，临时记号的印法到下一次换调号为止重算）。 */
export function setKeyAt(doc: ScoreDoc, si: number, mi: number, fifths: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "setKeyAt", si, mi, fifths }, hooks);
}

/** 从第 `mi` 小节起换拍号（小节里的音不动，拍数不对的由自检标出）。 */
export function setTimeAt(doc: ScoreDoc, si: number, mi: number, beats: number, beatType: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "setTimeAt", si, mi, beats, beatType }, hooks);
}

/** 第 `mi` 小节开头的速度记号（♩ = bpm）；bpm 为 0 = 去掉。只挂在第一声部上（MusicXML 的通例）。 */
export function setTempoAt(doc: ScoreDoc, si: number, mi: number, bpm: number): ModelEdit {
  return run(doc, { op: "setTempoAt", si, mi, bpm });
}

export type BarKind = "single" | "double" | "final" | "repeatStart" | "repeatEnd";

/** 第 `mi` 小节的小节线样式：反复开始在小节头（左线），其余在小节尾（右线）。所有声部一起改。 */
export function setBarKind(doc: ScoreDoc, si: number, mi: number, kind: BarKind): ModelEdit {
  return run(doc, { op: "setBarKind", si, mi, kind });
}

/** 房号：第 `from`..`to` 小节标成第 `n` 房（已是就去掉）。所有声部一起标。 */
export function toggleEnding(doc: ScoreDoc, si: number, from: number, to: number, n: number): ModelEdit {
  return run(doc, { op: "toggleEnding", si, from, to, n });
}

export type JumpKind = "segno" | "coda" | "dc" | "ds" | "fine";

/** 跳转记号：segno / coda 挂在小节头，D.C. / D.S. / Fine 挂在小节尾（带 `<sound>`，试听与演唱顺序按它跳）。已有就去掉。 */
export function toggleJump(doc: ScoreDoc, si: number, mi: number, kind: JumpKind): ModelEdit {
  return run(doc, { op: "toggleJump", si, mi, kind });
}

// ───────────────────────── 和弦与声线 ─────────────────────────

/** 往和弦里加一个音：唱名 `degree`，放在和弦最高音之上最近的那个八度（同 MuseScore 的 Shift+音名）。 */
export function addChordNote(doc: ScoreDoc, id: ElementId, degree: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "addChordNote", id, degree }, hooks);
}

/** 选中和弦里的第 `index` 个音（从低到高）单独删掉；只剩一个音时不删。 */
export function removeChordNote(doc: ScoreDoc, id: ElementId, index: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "removeChordNote", id, index }, hooks);
}

/**
 * 在指定声线的某一时刻插一个音（声部输入：第二、三、四条旋律）。插在这个声线里起点不晚于 `onset` 的最后一个音之后，
 * 起点照 `onset` 给（与前一个音之间有空当时写显式起点，写出端补 `<forward>`）；后面同声线的音保持原来的起点不动。
 * 这个声线在本小节还没有音时，新音接在小节元素末尾、显式起点。`shown` 是报错里说的声线号（谱表内第几声线，缺省同 `voice`）。
 */
export function insertInVoice(
  doc: ScoreDoc, at: { si: number; pi: number; mi: number; onset: number; staff: number }, voice: number, degree: number, dur: NewDuration,
  hooks: EditHooks = {}, shown = voice,
): ModelEdit {
  return run(doc, { op: "insertInVoice", at, voice, degree, dur, shown }, hooks);
}

/** 和弦的起点（给声部输入算插入时刻）。 */
export function chordOnset(doc: ScoreDoc, id: ElementId): number | null {
  const l = locate(doc, id);
  return l ? onsets(l.measure).get(l.chord) ?? null : null;
}

/** 选中音的 MIDI 音高（按键发声用）。 */
export function midiOf(doc: ScoreDoc, id: ElementId): number | null {
  const p = locate(doc, id)?.chord.notes[0]?.pitch;
  return p ? midiOfPitch(p) : null;
}

/** 调内音阶走一级（`↑`/`↓`，7 往上到高音 1）。给 P7 的键位用，这里先备好。 */
export function stepDegree(doc: ScoreDoc, ids: readonly ElementId[], delta: 1 | -1, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "stepDegree", ids, delta }, hooks);
}

/** 半音走一步（`Alt+↑`/`Alt+↓`）：落在调内音上写本音，否则升号调写升号、降号调写降号，C 调按走的方向。 */
export function stepSemitone(doc: ScoreDoc, ids: readonly ElementId[], delta: 1 | -1, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "stepSemitone", ids, delta }, hooks);
}

/** 选中的音移 `n` 个半音（移调对话框的「选区」），拼写同 `stepSemitone`。 */
export function shiftSemitones(doc: ScoreDoc, ids: readonly ElementId[], n: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "shiftSemitones", ids, n }, hooks);
}

/** 调号（升号个数）移 `n` 个半音后的调号：新主音按常用写法取（升 / 降不超过 6 个，F♯ 与 G♭ 取 F♯）。 */
export function transposeFifths(fifths: number, n: number): number {
  const pc = (((fifths * 7 + n) % 12) + 12) % 12;
  return [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][pc]!;
}

/** 全曲移 `n` 个半音：每个音移过去、每处调号跟着换（`transposeFifths`），按新调号拼写；和弦记号不动。 */
export function transposeScore(doc: ScoreDoc, n: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "transposeScore", n }, hooks);
}

/** 按音名改（`A`–`G`，编辑模式）：升降照调号，八度取离原来那个音最近的；休止改成音时离前一个音最近。和弦只改最上面那个音。 */
export function setStep(doc: ScoreDoc, ids: readonly ElementId[], letter: string, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "setStep", ids, letter }, hooks);
}

function topNote(ch: Chord): Note | null {
  let top: Note | null = null;
  for (const n of ch.notes) if (n.pitch && (!top?.pitch || midiOfPitch(n.pitch) > midiOfPitch(top.pitch))) top = n;
  return top;
}

/** 音名在这个调里是几（`1=` 那个音名算 1）。 */
export function degreeOfStep(letter: string, fifths: number): number {
  const idx = STEPS.indexOf(letter.toUpperCase() as (typeof STEPS)[number]);
  const tonic = (((fifths * 4) % 7) + 7) % 7;
  return ((idx - tonic + 7) % 7) + 1;
}

/** 插入位置所在小节的调号（升号个数）。 */
export function anchorFifths(doc: ScoreDoc, anchor: InsertAnchor): number {
  if ("after" in anchor) {
    const l = locate(doc, anchor.after);
    return l ? measureCtx(l.song, l.part, l.mi).key.fifths : 0;
  }
  const a = anchor.measureStart;
  const song = doc.songs[a.si];
  const part = song?.parts[a.pi];
  return song && part ? measureCtx(song, part, a.mi).key.fifths : 0;
}

// ───────────────────────── 连音 ─────────────────────────

/** 连音的默认比例：二连、四连占 3，其余占小于 n 的最大 2 的幂（3→2、5→4、6→4、7→4），同 123 的表。 */
export function tupletNormal(n: number): number {
  if (n === 2 || n === 4) return 3;
  let p = 1;
  while (p * 2 < n) p *= 2;
  return p;
}

/** 选中的几个音（同一小节、同一声线）做成连音，已经是同一组连音就拆回去。 */
export function toggleTuplet(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "toggleTuplet", ids }, hooks);
}

// ───────────────────────── 歌词 ─────────────────────────

/**
 * 歌词录入：和弦 `id` 第 `verse` 段的字写成 `text`（空串 = 去掉这一段的字）。`hyphen` = 后面接连字符（`<syllabic>` 按前一个字推：
 * 前一个字后面带连字符的这个是 middle / end，否则 begin / single）；`extend` = 一字多音的续线。
 */
export function setLyric(doc: ScoreDoc, id: ElementId, verse: number, text: string, hyphen: boolean, extend: boolean): ModelEdit {
  return run(doc, { op: "setLyric", id, verse, text, hyphen, extend });
}

/** 和弦名录入：和弦 `id` 的和弦名写成 `text`（空串 = 去掉）。只记原文，结构由写出端按文字解析（同简谱来源的和弦名）。 */
export function setHarmony(doc: ScoreDoc, id: ElementId, text: string): ModelEdit {
  return run(doc, { op: "setHarmony", id, text });
}

/** 文字 / 力度录入：和弦 `id` 前面挂一条 `<direction>`（文字在上方、力度在下方）；`text` 空串 = 去掉。 */
export function setDirectionText(doc: ScoreDoc, id: ElementId, type: "words" | "dynamics", text: string): ModelEdit {
  return run(doc, { op: "setDirectionText", id, kind: type, text });
}

/** 和弦 `id` 前面那条文字 / 力度现在的值。 */
export function directionTextOf(doc: ScoreDoc, id: ElementId, type: "words" | "dynamics"): string {
  const l = locate(doc, id);
  const d = l?.measure.directions?.find((x) => x.type === type && (x.afterElements ?? 0) === l.index);
  return d?.text ?? "";
}

// ───────────────────────── 剪贴板 ─────────────────────────

/** 剪贴板里的一样东西：与格式无关（文本格式、MusicXML 之间也能贴）。音按唱名记（相对调号，贴到别的调里按唱名走），
 *  时值按简谱口径（减时线条数 + 附点，四分以上拆成增时线）。 */
export type ClipItem =
  | { kind: "note"; degree: number; octave: number; acc: Accidental | null; halvings: number; dots: number }
  | { kind: "sustain" }
  | { kind: "bar" };

const HALVINGS: Partial<Record<NoteType, number>> = { quarter: 0, eighth: 1, "16th": 2, "32nd": 3, "64th": 4 };

/** 选中的和弦 → 剪贴板（和弦取最上面那个音；连音、写不出的时值按最近的四分拍数拆）。 */
export function clipOfChords(doc: ScoreDoc, ids: readonly ElementId[]): ClipItem[] {
  const out: ClipItem[] = [];
  for (const l of chordsOf(doc, ids)) {
    const { key, dpq } = measureCtx(l.song, l.part, l.mi);
    const ch = l.chord;
    const top = topNote(ch);
    const d = top?.pitch ? degreeFromPitch(top.pitch, key, top.accidental) : null;
    const t = typeOfDivisions(ch.duration.divisions, dpq);
    const h = t ? HALVINGS[t.type] : undefined;
    let halvings = 0, dots = 0, sustains = 0;
    if (t && h !== undefined) (halvings = h), (dots = t.dots);
    else sustains = Math.max(0, Math.round(ch.duration.divisions / dpq) - 1);
    out.push({ kind: "note", degree: d ? d.number : 0, octave: d ? d.octaveShift : 0, acc: d?.accidental ?? null, halvings, dots });
    for (let k = 0; k < sustains; k++) out.push({ kind: "sustain" });
  }
  return out;
}

/** 剪贴板贴到锚点处（同一声线、接着往后插）；增时线并进前一个音（多一拍），小节线不贴（小节由拍号管）。返回贴进来的那些音。 */
export function pasteClip(doc: ScoreDoc, anchor: InsertAnchor, items: readonly ClipItem[], hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "pasteClip", anchor, items }, hooks);
}

// ───────────────────────── 识别修正：重读与挪动 ─────────────────────────
//
// 识谱软件里改谱号、改调号是**纠正认错**（PhotoScore、SmartScore 默认符头不动、按新谱号 / 调号重读音高），
// 与打谱软件的「保音高、挪符头」相反，两种都给（`reread`）。挪动类（连线端点、力度文字、和弦名、歌词）一次挪一个音，
// 对齐识谱软件「拖到最近的音上吸附」那一下。

/**
 * 换谱号：第 `pi` 声部第 `staff` 谱表自第 `mi` 小节起改成 `clef`，到这一谱表下一次换谱号为止。
 * `reread`：符头在谱表上的位置不动、按新谱号重读音高（识别认错谱号的纠正）；否则音高不动（谱面上符头跟着挪）。
 */
export function setClefAt(doc: ScoreDoc, si: number, pi: number, mi: number, staff: number, clef: Clef, reread: boolean, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "setClefAt", si, pi, mi, staff, clef, reread }, hooks);
}

/**
 * 换调号并**重读**：自第 `mi` 小节起各声部改成 `fifths`，到下一次换调号为止，没印临时记号的音按新调号重读升降
 * （印了的照记号；同小节前面印过的、延音线接过来的照前面）。保音高那一种见 `setKeyAt`。
 */
export function rereadKeyAt(doc: ScoreDoc, si: number, mi: number, fifths: number, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "rereadKeyAt", si, mi, fifths }, hooks);
}

/** 同一声部同一声线里 `loc` 前 / 后第 |`delta`| 个和弦（可跨小节；`skip` 放过的不算，如休止、倚音）。 */
function stepInVoice(l: ChordLoc, delta: number, skip: (c: Chord) => boolean): ChordLoc | null {
  const dir = delta > 0 ? 1 : -1;
  let cur: ChordLoc = l;
  for (let n = Math.abs(delta); n > 0; n--) {
    let mi = cur.mi;
    let i = cur.index + dir;
    let found: ChordLoc | null = null;
    while (!found) {
      const m = l.part.measures[mi];
      if (!m) return null;
      if (i < 0 || i >= m.elements.length) {
        mi += dir;
        const nm = l.part.measures[mi];
        if (!nm) return null;
        i = dir > 0 ? 0 : nm.elements.length - 1;
        continue;
      }
      const e = m.elements[i]!;
      if (e.kind === "chord" && e.voice === l.chord.voice && !skip(e)) found = { ...l, mi, measure: m, chord: e, index: i };
      i += dir;
    }
    cur = found;
  }
  return cur;
}

/**
 * 连线（圆滑线、三连音以外的跨音记号）一端挪一个音：`which` 哪一端、`delta` 往后 +1 / 往前 −1；`which` 为 `both` 整条一起挪。
 * 挪到的音不能越过另一端。延音线只连相邻同音，不挪（删了在对的地方重加）。
 */
export function moveMarkEnd(doc: ScoreDoc, type: Mark["type"], startId: ElementId, endId: ElementId, which: "start" | "end" | "both", delta: number): ModelEdit & { moved?: MovedMark } {
  return run(doc, { op: "moveMarkEnd", kind: type, startId, endId, which, delta });
}

/** 一条 `<direction>` 的位置：第几首、第几声部、第几小节、`directions` 里第几条。 */
export interface DirRef {
  si: number;
  pi: number;
  mi: number;
  index: number;
}

/** 选中的记号挪了之后要选回它：挂在哪个和弦上、是什么（模型那一路重写读回后按和弦位置 + 种类认回，`modelops.ts`）。 */
export type MovedMark =
  | { markOn: Chord; kind: "dir"; dirType: string }
  | { markOn: Chord; kind: "harmony" | "slur" }
  | { lyricOf: Chord; verse: number };

/**
 * 力度、表情文字、速度、渐强渐弱的一端（都是 `<direction>`）挪一个音：`delta` +1 往后、−1 往前，`byMeasure` 时挪到前 / 后一小节的同一拍
 * （那一小节里起点最近的音）。渐强渐弱的起点与终点各是一条，`pair` 给了就两条一起挪（整条挪）。
 */
export function moveDirection(doc: ScoreDoc, r: DirRef, delta: number, byMeasure = false, pair?: DirRef, guard?: DirRef): ModelEdit & { moved?: MovedMark } {
  return run(doc, { op: "moveDirection", r, delta, byMeasure, pair, guard });
}

/** 和弦名挪一个音（同声线，休止也能挂）；那个音已有和弦名就拒绝。 */
export function moveHarmony(doc: ScoreDoc, id: ElementId, delta: number): ModelEdit & { moved?: MovedMark } {
  return run(doc, { op: "moveHarmony", id, delta });
}

/**
 * 歌词挪格（识别漏认 / 多认一个音，后面的字整串错开）：`delta` +1 = 在这个字前空出一格，这个字连同后面紧接着的字各往后挪一个音，
 * 挪到本段第一个空着的音为止（那一格吸收掉）；−1 = 前一个音空着时，这个字连同后面紧接着的字各往前挪一格。
 * 能配字的音 = 同声线、不是倚音；休止只在本来挂着字时算（同 `Chord.lyricAnchor` 的缺省）。
 * `count`：只挪从这个字起的几个字（选中了几个字时）；往后挪时紧挨着的下一格不空，照样顺次推到第一个空格为止。
 */
export function shiftLyrics(doc: ScoreDoc, id: ElementId, verse: number, delta: number, count?: number): ModelEdit & { moved?: MovedMark } {
  return run(doc, { op: "shiftLyrics", id, verse, delta, count });
}

/** 倚音 ↔ 正音：倚音改成正音按它印的时值占拍；正音改成倚音不占拍（照印的时值，八分的带斜线）。 */
export function toggleGrace(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "toggleGrace", ids }, hooks);
}

/**
 * 符杠组：选中音所在的那一组连杠的音（同小节同声线、`beams` 连着的一串）。原文没写 `<beam>`（手抄的 GT、部分识别稿）时
 * 按 `rebeam` 同一口径（同一拍里连着的八分及更短、休止断开）划。不在杠下的只有它自己。
 */
export function beamGroupOf(doc: ScoreDoc, id: ElementId): Chord[] {
  const l = locate(doc, id);
  if (!l) return [];
  const run = l.measure.elements.filter((e): e is Chord => e.kind === "chord" && e.voice === l.chord.voice && !e.grace);
  const k = run.indexOf(l.chord);
  if (run.some((c) => c.beams?.length)) {
    if (!l.chord.beams?.length) return [l.chord];
    let a = k;
    while (a > 0 && run[a]!.beams![0] !== "begin" && run[a - 1]!.beams?.length) a--;
    let b = k;
    while (b + 1 < run.length && run[b]!.beams![0] !== "end" && run[b + 1]!.beams?.length) b++;
    return run.slice(a, b + 1);
  }
  const { time, dpq } = measureCtx(l.song, l.part, l.mi);
  const group = time && time.beatType === 8 && time.beats % 3 === 0 ? dpq * 1.5 : dpq;
  const os = onsets(l.measure);
  const flagged = (c: Chord): boolean => !c.rest && !c.duration.timeMod && (c.duration.divisions < dpq);
  if (!flagged(l.chord)) return [l.chord];
  const beat = (c: Chord): number => Math.floor((os.get(c) ?? 0) / group);
  let a = k;
  while (a > 0 && flagged(run[a - 1]!) && beat(run[a - 1]!) === beat(l.chord)) a--;
  let b = k;
  while (b + 1 < run.length && flagged(run[b + 1]!) && beat(run[b + 1]!) === beat(l.chord)) b++;
  return run.slice(a, b + 1);
}

/** 渐强 / 渐弱：选中的头尾两个音之间加一条（两条 `<direction>`：起点挂头一个音前、终点挂尾一个音后）。已有同起点的就去掉。 */
export function toggleWedge(doc: ScoreDoc, firstId: ElementId, lastId: ElementId, kind: "crescendo" | "diminuendo"): ModelEdit {
  return run(doc, { op: "toggleWedge", firstId, lastId, kind });
}

/**
 * 选中的头尾两个音之间加 / 去一条八度线（`8va` 印在上方、`8vb` 在下方）。**符头留在谱面原位**：
 * 加 8va 等于说这段实际高一个八度，范围里本谱表的音音高跟着挪（识谱漏了八度线时就是这样纠正）；去掉时挪回。
 */
export function toggleOctaveShift(doc: ScoreDoc, firstId: ElementId, lastId: ElementId, kind: "8va" | "8vb"): ModelEdit {
  return run(doc, { op: "toggleOctaveShift", firstId, lastId, kind });
}

/** 渐强渐弱、踏板、八度线的起点 / 终点各是一条 `<direction>`：给一条，找配对的另一条（同声部、同类、按先后最近的那条）。 */
export function dirPartner(doc: ScoreDoc, r: DirRef): DirRef | null {
  const part = doc.songs[r.si]?.parts[r.pi];
  const d = part?.measures[r.mi]?.directions?.[r.index];
  if (!part || !d || !d.spanType || d.spanType === "continue") return null;
  // 同谱表、同声线（都写了才比）、同类；按先后排好，从它往后（终点往前）数，套着的同类一对对跳过
  const same = (x: Direction): boolean => x.type === d.type && (x.staff ?? 1) === (d.staff ?? 1) &&
    (x.voice === undefined || d.voice === undefined || x.voice === d.voice) && (x.spanType === "start" || x.spanType === "stop");
  const list: { ref: DirRef; dir: Direction; pos: number }[] = [];
  part.measures.forEach((m, mi) => (m.directions ?? []).forEach((x, index) => {
    if (same(x)) list.push({ ref: { si: r.si, pi: r.pi, mi, index }, dir: x, pos: mi * 1e6 + (x.afterElements ?? 0) * 2 + (x.spanType === "stop" ? 0 : 1) });
  }));
  list.sort((a, b) => a.pos - b.pos);
  const k = list.findIndex((x) => x.dir === d);
  const fwd = d.spanType === "start";
  let depth = 0;
  for (let i = k + (fwd ? 1 : -1); i >= 0 && i < list.length; i += fwd ? 1 : -1) {
    const x = list[i]!.dir;
    if (x.spanType === d.spanType) depth++;
    else if (depth === 0) return list[i]!.ref;
    else depth--;
  }
  return null;
}

/** 删音符上的一个记号（`<notations>` 里按名字：奏法、装饰、延长号都行，不限 `DecoKind` 那几种）。 */
export function removeNotation(doc: ScoreDoc, id: ElementId, name: string): ModelEdit {
  return run(doc, { op: "removeNotation", id, name });
}

/** 删一条 `<direction>`（渐强渐弱这类成对的连配对那条一起删）。 */
export function deleteDirection(doc: ScoreDoc, r: DirRef): ModelEdit {
  return run(doc, { op: "deleteDirection", r });
}

/** 同一声部同一声线里前 / 后一个音（可跨小节，倚音不算；`skipRests` 时休止也跳过）。文本格式挪记号用它找邻居。 */
export function neighbourChord(doc: ScoreDoc, id: ElementId, delta: number, skipRests = false): Chord | null {
  const l = locate(doc, id);
  return l ? stepInVoice(l, delta, (c) => !!c.grace || (skipRests && !!c.rest))?.chord ?? null : null;
}

/** 在锚点处插一个**给定音高**的音（升降按那里的调号，印法重算）：Alt+点原图补漏识的音用（音高由点的位置定，不是唱名）。 */
export function insertPitch(doc: ScoreDoc, anchor: InsertAnchor, pitch: { step: Pitch["step"]; octave: number }, dur: NewDuration, hooks: EditHooks = {}): ModelEdit {
  return run(doc, { op: "insertPitch", anchor, pitch, dur }, hooks);
}

/** 和弦现在的时值换成「新音」的写法（减半次数 + 附点）：Alt+点补音时照选中的那个音的时值。 */
export function newDurationOf(ch: Chord): NewDuration {
  const H: Partial<Record<NoteType, number>> = { whole: -2, half: -1, quarter: 0, eighth: 1, "16th": 2, "32nd": 3, "64th": 4 };
  return { halvings: H[ch.duration.type ?? "quarter"] ?? 0, dots: ch.duration.dots };
}
