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
import { degreeFromPitch, pitchFromDegree } from "./jianpu";
import { t as tr } from "../i18n";

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
  | { error: string };

export const isEditError = (e: ModelEdit): e is { error: string } => "error" in e;

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

/** 把音高挪到离 `near` 最近的那个八度（插入新音时八度取离前一个音最近的，同 MuseScore）。 */
function nearestOctave(p: Pitch, near: number): Pitch {
  let best = p;
  let bd = Infinity;
  for (let o = 0; o <= 8; o++) {
    const q = { ...p, octave: o };
    const d = Math.abs(midiOfPitch(q) - near);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** 同一声部里 `loc` 之前最近的一个有音高的音（没有就往后找），给新音定八度。 */
function neighbourMidi(part: Part, mi: number, index: number, voice: number): number {
  const flat: Chord[] = [];
  // 插入点前面有几个本声线的和弦（插在小节末尾、后面紧跟别的声线时 `index` 处不是本声线的音，照样数得出）
  let at = 0;
  part.measures.forEach((m, i) => m.elements.forEach((e, j) => {
    if (e.kind !== "chord" || e.voice !== voice) return;
    if (i < mi || (i === mi && j < index)) at = flat.length + 1;
    flat.push(e);
  }));
  const hit = (c: Chord | undefined): number | null => (c?.notes[0]?.pitch ? midiOfPitch(c.notes[0].pitch) : null);
  for (let k = at - 1; k >= 0; k--) {
    const v = hit(flat[k]);
    if (v !== null) return v;
  }
  for (let k = at; k < flat.length; k++) {
    const v = hit(flat[k]);
    if (v !== null) return v;
  }
  return 67; // G4：高音谱号中间
}

/** 印出来的临时记号：与调号（及小节内延续）一致就不印，否则按实际升降印。 */
function accidentalFor(alter: number): Note["accidental"] {
  return alter === -2 ? "double-flat" : alter === -1 ? "flat" : alter === 0 ? "natural" : alter === 1 ? "sharp" : "double-sharp";
}

/**
 * 重算一小节里临时记号的**印法**：同一谱表、同一音名同一八度，按时间先后，与当前生效的升降（调号或前面的临时记号）
 * 一致就不印、不一致就印。改音高之后要跑：前面把 F 改成 F♯，后面原本不印记号的 F 就得印还原号。
 */
export function respellMeasure(measure: Measure, key: Key): void {
  const items: { at: number; order: number; note: Note; staff: number }[] = [];
  const voiceAt = new Map<number, number>();
  measure.elements.forEach((el, order) => {
    if (el.kind !== "chord") return;
    const start = el.onset ?? voiceAt.get(el.voice) ?? 0;
    voiceAt.set(el.voice, start + (el.grace ? 0 : el.duration.divisions));
    for (const n of el.notes) if (n.pitch) items.push({ at: start, order, note: n, staff: el.staff });
  });
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  const state = new Map<string, number>();
  for (const it of items) {
    const p = it.note.pitch!;
    const k = `${it.staff}:${p.step}:${p.octave}`;
    const cur = state.get(k) ?? keyAlter(p.step, key.fifths);
    if (p.alter === cur) delete it.note.accidental;
    else it.note.accidental = accidentalFor(p.alter);
    state.set(k, p.alter);
  }
}

/** 唱名 → 音高：八度点照 `octaveShift`，升降照 `acc`（相对调号）。 */
function pitchOfDegree(number: number, octaveShift: number, key: Key, acc?: Note["accidental"]): Pitch | null {
  return pitchFromDegree({ number, octaveShift, ...(acc ? { accidental: acc } : {}) }, key);
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

/** `want`（按当前单位算的 divisions）不是整数时，把声部单位放大到够用的最小倍数，返回放大后的值。 */
function fitDivisions(part: Part, want: number): number {
  if (Number.isInteger(want)) return want;
  for (const k of [2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    if (Number.isInteger(Math.round(want * k * 1e6) / 1e6)) {
      scalePartDivisions(part, k);
      return Math.round(want * k);
    }
  }
  return want;
}

/** 按新的 divisions 改时值（连音不改：连音里改时值会把整组拍子带乱）。 */
function setDivisions(ch: Chord, div: number, dpq: number): string | null {
  if (ch.duration.timeMod) return tr("me.tupletDur");
  if (!Number.isInteger(div) || div <= 0) return tr("me.divCoarse");
  const t = typeOfDivisions(div, dpq);
  if (!t) return tr("me.durInvalid");
  ch.duration = { ...ch.duration, divisions: div, type: t.type, dots: t.dots };
  return null;
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

/** 改完音高的小节：临时记号重算印法，原文的符干方向作废（音高变了，按引擎自己推）。 */
function touched(locs: readonly ChordLoc[], forgetStem?: (ch: Chord) => void): void {
  const seen = new Set<Measure>();
  for (const l of locs) {
    forgetStem?.(l.chord);
    if (seen.has(l.measure)) continue;
    seen.add(l.measure);
    respellMeasure(l.measure, measureCtx(l.song, l.part, l.mi).key);
  }
}

export interface EditHooks {
  /** 音高变了：原文里这个和弦的符干方向、纵坐标作废（`xmlsurface.ts::forgetNoteLayout`） */
  forgetStem?(ch: Chord): void;
  /** 小节的内容变了（增删音、改时值、拆并小节）：整曲的版面坐标作废，改由五线谱引擎自动铺排（`xmlsurface.ts::dropEmbeddedLayout`） */
  forgetLayout?(song: Song): void;
}

/** 改唱名（`0` = 改成休止）：八度点不变；休止改成音时八度取离前一个音最近的。 */
export function setDegree(doc: ScoreDoc, ids: readonly ElementId[], degree: number, hooks: EditHooks = {}): ModelEdit {
  const locs = chordsOf(doc, ids).filter((l) => !l.chord.grace);
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  for (const l of locs) {
    const { key } = measureCtx(l.song, l.part, l.mi);
    const ch = l.chord;
    if (degree === 0) {
      ch.notes = [];
      ch.rest = {};
      continue;
    }
    const old = ch.notes[0]?.pitch;
    const shift = old ? degreeFromPitch(old, key).octaveShift : 0;
    let p = pitchOfDegree(degree, shift, key);
    if (!p) continue;
    if (!old) p = nearestOctave(p, neighbourMidi(l.part, l.mi, l.index, ch.voice));
    delete ch.rest;
    // 和弦只改最上面那个音（选中的是和弦时唱名只有一个位置可放）；单音就是它
    const top = ch.notes.length ? ch.notes.reduce((a, b) => (midiOfPitch(b.pitch ?? { step: "C", alter: 0, octave: 0 }) > midiOfPitch(a.pitch ?? { step: "C", alter: 0, octave: 0 }) ? b : a)) : null;
    if (top) top.pitch = p;
    else ch.notes = [{ pitch: p }];
  }
  touched(locs, hooks.forgetStem);
  return { select: locs.map((l) => l.chord) };
}

/** 升降八度：和弦里每个音一起挪。 */
export function shiftOctave(doc: ScoreDoc, ids: readonly ElementId[], delta: number, hooks: EditHooks = {}): ModelEdit {
  const locs = chordsOf(doc, ids);
  const pitched = locs.filter((l) => l.chord.notes.some((n) => n.pitch));
  if (pitched.length === 0) return { error: tr("me.restOctave") };
  for (const l of pitched) for (const n of l.chord.notes) if (n.pitch) n.pitch = { ...n.pitch, octave: n.pitch.octave + delta };
  touched(pitched, hooks.forgetStem);
  return { select: locs.map((l) => l.chord) };
}

/** 升号 / 降号 / 还原号（相对调号，同简谱的写法）：已经是这样就取消（回到调号本身）。 */
export function toggleAccidental(doc: ScoreDoc, ids: readonly ElementId[], acc: "sharp" | "flat" | "natural", hooks: EditHooks = {}): ModelEdit {
  const locs = chordsOf(doc, ids).filter((l) => l.chord.notes.some((n) => n.pitch));
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  for (const l of locs) {
    const { key } = measureCtx(l.song, l.part, l.mi);
    for (const n of l.chord.notes) {
      if (!n.pitch) continue;
      const base = keyAlter(n.pitch.step, key.fifths);
      const want = acc === "sharp" ? base + 1 : acc === "flat" ? base - 1 : 0;
      const on = acc === "natural" ? n.pitch.alter === 0 && base !== 0 : n.pitch.alter === want;
      n.pitch = { ...n.pitch, alter: on ? base : want };
    }
  }
  touched(locs, hooks.forgetStem);
  return { select: locs.map((l) => l.chord) };
}

/** 改时值的公用一步：改完这一小节这个声线的符杠重排、整曲版面坐标作废。 */
function retime(doc: ScoreDoc, ids: readonly ElementId[], fn: (ch: Chord, dpq: number) => number | string, hooks: EditHooks): ModelEdit {
  const locs = chordsOf(doc, ids).filter((l) => !l.chord.grace);
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  for (const l of locs) {
    const want = fn(l.chord, measureCtx(l.song, l.part, l.mi).dpq);
    if (typeof want === "string") return { error: want };
    const div = fitDivisions(l.part, want); // 放大过单位的，`dpq` 也跟着变了，下面重取
    const err = setDivisions(l.chord, div, measureCtx(l.song, l.part, l.mi).dpq);
    if (err) return { error: err };
  }
  const seen = new Set<string>();
  for (const l of locs) {
    const k = `${l.si}:${l.pi}:${l.mi}:${l.chord.voice}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const { time, dpq } = measureCtx(l.song, l.part, l.mi);
    rebeam(l.measure, l.chord.voice, time, dpq);
    delete l.measure.duration;
  }
  for (const s of new Set(locs.map((l) => l.song))) hooks.forgetLayout?.(s);
  return { select: locs.map((l) => l.chord) };
}

const dotFactor = (dots: number): number => 2 - Math.pow(0.5, dots);

/** 附点：加一个或去掉（去掉时全部去掉）。 */
export function toggleDot(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  return retime(doc, ids, (ch) => {
    const base = ch.duration.divisions / dotFactor(ch.duration.dots);
    return ch.duration.dots ? base : base * 1.5;
  }, hooks);
}

/** 时值减半 / 加倍（附点照留）。 */
export function scaleDuration(doc: ScoreDoc, ids: readonly ElementId[], factor: 0.5 | 2, hooks: EditHooks = {}): ModelEdit {
  return retime(doc, ids, (ch) => ch.duration.divisions * factor, hooks);
}

/** 增时线：多一拍（一个四分音符）。 */
export function addBeat(doc: ScoreDoc, id: ElementId, hooks: EditHooks = {}): ModelEdit {
  return retime(doc, [id], (ch, dpq) => ch.duration.divisions + dpq, hooks);
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

function nextId(doc: ScoreDoc): ElementId {
  let max = 0;
  for (const s of doc.songs) for (const p of s.parts) for (const m of p.measures) for (const e of m.elements) max = Math.max(max, e.id);
  return max + 1;
}

/** 元素增删之后，按「排在第几个元素之后」记位置的东西（文字力度、小节中间的属性与小节线）跟着挪。 */
function remapAfter(m: Measure, map: (a: number) => number): void {
  for (const d of m.directions ?? []) if (d.afterElements !== undefined) d.afterElements = map(d.afterElements);
  for (const a of m.laterAttrs ?? []) a.afterElements = map(a.afterElements);
  for (const b of m.barlines ?? []) if (b.afterElements !== undefined) b.afterElements = map(b.afterElements);
}
/** 在第 `index` 个元素前插了一个：挂在它及以后的往后挪（小节开头的速度、记号不动） */
const shiftForInsert = (m: Measure, index: number): void => remapAfter(m, (a) => (a > index || (a === index && index > 0) ? a + 1 : a));

/** 在锚点处插入一个音（`degree` 0 = 休止）。 */
export function insertChord(doc: ScoreDoc, anchor: InsertAnchor, degree: number, dur: NewDuration, hooks: EditHooks = {}): ModelEdit {
  let song: Song, part: Part, measure: Measure, mi: number, index: number, voice: number, staff: number;
  if ("after" in anchor) {
    const l = locate(doc, anchor.after);
    if (!l) return { error: tr("me.noInsertPos") };
    ({ song, part, measure, mi } = l);
    index = l.index + 1;
    voice = l.chord.voice;
    staff = l.chord.staff;
  } else {
    const a = anchor.measureStart;
    const s = doc.songs[a.si];
    const p = s?.parts[a.pi];
    const m = p?.measures[a.mi];
    if (!s || !p || !m) return { error: tr("me.noInsertPos") };
    song = s;
    part = p;
    measure = m;
    mi = a.mi;
    voice = a.voice;
    const first = m.elements.findIndex((e) => e.voice === voice);
    index = first < 0 ? m.elements.length : first;
    // 这一小节里本声线还没有音：谱表照它在别的小节落的那条（下谱表的声线不能落回第一条谱表）
    staff = first >= 0 ? m.elements[first]!.staff : staffOfVoice(p, voice);
  }
  const div = fitDivisions(part, (measureCtx(song, part, mi).dpq / Math.pow(2, dur.halvings)) * dotFactor(dur.dots));
  const { key, time, dpq } = measureCtx(song, part, mi);
  const ch: Chord = { kind: "chord", id: nextId(doc), notes: [], duration: { divisions: 0, dots: 0 }, voice, staff };
  const err = setDivisions(ch, div, dpq);
  if (err) return { error: err };
  if (degree === 0) ch.rest = {};
  else {
    const p = pitchOfDegree(degree, 0, key);
    if (!p) return { error: tr("me.degree07") };
    ch.notes = [{ pitch: nearestOctave(p, neighbourMidi(part, mi, index, voice)) }];
  }
  // 插在别的声线开头（带 onset）的前面时，新音接的是本声线前一个音的终点；首个元素要给它显式的起点
  const follower = measure.elements[index];
  if (follower && follower.voice === voice && follower.kind === "chord" && follower.onset !== undefined) {
    ch.onset = follower.onset;
    delete follower.onset;
  }
  measure.elements.splice(index, 0, ch);
  shiftForInsert(measure, index);
  delete measure.duration;
  rebeam(measure, voice, time, dpq);
  respellMeasure(measure, key);
  hooks.forgetLayout?.(song);
  return { caretAfter: ch };
}

/** 删掉一些和弦：连带删掉以它们为端点的弧、连音线与延音线（对面那个音的 `tie` 也清掉）。 */
export function deleteChords(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  const locs = chordsOf(doc, ids);
  if (locs.length === 0) return { error: tr("me.nothingToDelete") };
  const gone = new Set(locs.map((l) => l.chord.id));
  for (const song of new Set(locs.map((l) => l.song))) {
    const keep: Mark[] = [];
    for (const mk of song.marks) {
      if (!gone.has(mk.start) && !gone.has(mk.end)) {
        keep.push(mk);
        continue;
      }
      if (mk.type === "tied") {
        const other = locate(doc, gone.has(mk.start) ? mk.end : mk.start)?.chord;
        for (const n of other?.notes ?? []) if (n.tie) delete n.tie[gone.has(mk.start) ? "stop" : "start"];
      }
    }
    song.marks = keep;
  }
  // 删之前记下光标该落在谁后面：第一个被删的前面那个同声线的音
  const first = locs[0]!;
  const before = first.measure.elements.slice(0, first.index).reverse().find((e): e is Chord => e.kind === "chord" && e.voice === first.chord.voice && !gone.has(e.id));
  const touchedMeasures = new Map<Measure, ChordLoc>();
  for (const l of locs) touchedMeasures.set(l.measure, l);
  for (const [m, l] of touchedMeasures) {
    // 被删的音若带着显式起点，交给同声线的下一个
    m.elements.forEach((e, i) => {
      if (!gone.has(e.id) || e.kind !== "chord" || e.onset === undefined) return;
      const nxt = m.elements.slice(i + 1).find((x) => x.voice === e.voice && !gone.has(x.id));
      if (nxt && nxt.kind === "chord" && nxt.onset === undefined) nxt.onset = e.onset;
    });
    const removed = m.elements.flatMap((e, i) => (gone.has(e.id) ? [i] : []));
    m.elements = m.elements.filter((e) => !gone.has(e.id));
    remapAfter(m, (a) => a - removed.filter((i) => i < a).length);
    delete m.duration;
    const { key, time, dpq } = measureCtx(l.song, l.part, l.mi);
    for (const v of new Set(locs.filter((x) => x.measure === m).map((x) => x.chord.voice))) rebeam(m, v, time, dpq);
    respellMeasure(m, key);
  }
  for (const s of new Set(locs.map((l) => l.song))) hooks.forgetLayout?.(s);
  if (before) return { caretAfter: before };
  const after = first.measure.elements.find((e): e is Chord => e.kind === "chord" && e.voice === first.chord.voice);
  return after ? { caretBefore: after } : { select: [] };
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

/** 小节的实际长度：各声线终点的最大值。 */
function measureLength(m: Measure): number {
  let len = m.duration ?? 0;
  const voiceAt = new Map<number, number>();
  for (const el of m.elements) {
    const start = (el.kind === "chord" ? el.onset : undefined) ?? voiceAt.get(el.voice) ?? 0;
    const end = start + (el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : (el.duration?.divisions ?? 0));
    voiceAt.set(el.voice, end);
    len = Math.max(len, end);
  }
  return len;
}

/** 小节号从 `from` 起顺着往后重排（原文是整数的才动；弱起那种 implicit 小节不计号）。 */
function renumber(part: Part, from: number): void {
  let n = from > 0 ? Number.parseInt(part.measures[from - 1]!.number, 10) : 0;
  if (!Number.isFinite(n)) return;
  for (let i = Math.max(from, 0); i < part.measures.length; i++) {
    const m = part.measures[i]!;
    if (!/^\d+$/.test(m.number)) return;
    if (m.implicit) continue;
    m.number = String(++n);
  }
}

/** 插小节线：把锚点所在小节在锚点之后劈成两节。**所有声部一起劈**，要求每个声部每个声线在那一刻都有音符边界。 */
export function splitMeasure(doc: ScoreDoc, afterId: ElementId, hooks: EditHooks = {}): ModelEdit {
  const l = locate(doc, afterId);
  if (!l) return { error: tr("me.noInsertPos") };
  const cut0 = (onsets(l.measure).get(l.chord) ?? 0) + l.chord.duration.divisions;
  if (cut0 >= measureLength(l.measure)) return { error: tr("me.atMeasureEnd") };
  // 各声部的 divisions 可以不同（改过附点、十六分会单独放大单位）：劈开处按四分音符换算到每个声部自己的单位
  const cutQ = cut0 / measureCtx(l.song, l.part, l.mi).dpq;
  const cutOf = (part: Part): number => cutQ * measureCtx(l.song, part, l.mi).dpq;
  for (const part of l.song.parts) {
    const m = part.measures[l.mi];
    if (!m) continue;
    const cut = cutOf(part);
    const on = onsets(m);
    for (const [ch, at] of on) {
      if (at < cut && at + (ch.grace ? 0 : ch.duration.divisions) > cut) {
        return { error: tr("me.crossBar", { part: part.name || tr("me.otherPart") }) };
      }
    }
  }
  for (const part of l.song.parts) {
    const m = part.measures[l.mi];
    if (!m) continue;
    const cut = cutOf(part);
    const on = onsets(m);
    const keep = m.elements.filter((e) => e.kind !== "chord" || (on.get(e) ?? 0) < cut);
    const moved = m.elements.filter((e) => !keep.includes(e));
    // 挪过去的每个声线的第一个音给显式起点（新小节里各声线从头排）
    const firstOf = new Set<number>();
    for (const e of moved) {
      if (e.kind !== "chord") continue;
      if (e.onset !== undefined || !firstOf.has(e.voice)) e.onset = (on.get(e) ?? cut) - cut;
      firstOf.add(e.voice);
      if (e.onset === 0 && moved.find((x) => x.voice === e.voice) === e && moved[0] === e) delete e.onset;
    }
    const nm: Measure = { number: m.number, elements: moved };
    const right = (m.barlines ?? []).filter((b) => b.location === "right");
    if (right.length) {
      nm.barlines = right;
      m.barlines = (m.barlines ?? []).filter((b) => b.location !== "right");
    }
    // 文字记号、小节中间的属性按「排在第几个元素之后」挂：跟着它前面挨着的那个元素走（多声线时留下的元素不是连续一段），
    // 排在最后的跟着去新小节，排在开头的留在原小节
    const old = m.elements;
    const place = (a: number): { moves: boolean; at: number } => {
      if (a <= 0) return { moves: false, at: 0 };
      if (a >= old.length) return { moves: moved.length > 0, at: moved.length > 0 ? moved.length : keep.length };
      const e = old[a]!;
      return moved.includes(e) ? { moves: true, at: moved.indexOf(e) } : { moves: false, at: keep.indexOf(e) };
    };
    const dirs = m.directions ?? [];
    const movedDirs: NonNullable<Measure["directions"]> = [];
    const stay: NonNullable<Measure["directions"]> = [];
    for (const d of dirs) {
      const p = place(d.afterElements ?? 0);
      (p.moves ? movedDirs : stay).push({ ...d, afterElements: p.at });
    }
    if (movedDirs.length) nm.directions = movedDirs;
    if (stay.length) m.directions = stay;
    else delete m.directions;
    const later = m.laterAttrs ?? [];
    const movedLater = later.flatMap((x) => { const p = place(x.afterElements); return p.moves ? [{ ...x, afterElements: p.at }] : []; });
    const stayLater = later.flatMap((x) => { const p = place(x.afterElements); return p.moves ? [] : [{ ...x, afterElements: p.at }]; });
    if (movedLater.length) nm.laterAttrs = movedLater;
    if (stayLater.length) m.laterAttrs = stayLater;
    else delete m.laterAttrs;
    m.elements = keep;
    delete m.duration;
    part.measures.splice(l.mi + 1, 0, nm);
    renumber(part, l.mi + 1);
    const { time, dpq } = measureCtx(l.song, part, l.mi);
    for (const v of new Set([...keep, ...moved].map((e) => e.voice))) {
      rebeam(m, v, time, dpq);
      rebeam(nm, v, time, dpq);
    }
  }
  hooks.forgetLayout?.(l.song);
  return { caretAfter: l.chord };
}

/** 删小节线：第 `mi` 小节与下一小节并成一节（所有声部一起并）。下一小节换了调号 / 拍号的不并。 */
export function mergeMeasures(doc: ScoreDoc, si: number, mi: number, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  for (const part of song.parts) {
    const b = part.measures[mi + 1];
    if (!part.measures[mi] || !b) return { error: tr("me.lastBar") };
    if (b.attrs?.key || b.attrs?.time) return { error: tr("me.mergeKeyTime") };
    if (b.attrs?.divisions !== undefined && b.attrs.divisions !== measureCtx(song, part, mi).dpq) return { error: tr("me.mergeDiv") };
  }
  let anchor: Chord | null = null;
  for (const [pi, part] of song.parts.entries()) {
    const a = part.measures[mi]!;
    const b = part.measures[mi + 1]!;
    const len = measureLength(a);
    const onB = onsets(b);
    const seen = new Set<number>();
    for (const e of b.elements) {
      if (e.kind !== "chord") continue;
      if (e.onset !== undefined || !seen.has(e.voice)) e.onset = (onB.get(e) ?? 0) + len;
      seen.add(e.voice);
    }
    // 接在 a 后面的第一个声线（通常是 1）本来就从 a 的终点起，去掉多余的显式起点
    const lastA = [...a.elements].reverse().find((e) => e.kind === "chord");
    if (pi === 0) anchor = (lastA as Chord | undefined) ?? null;
    const first = b.elements.find((e) => e.kind === "chord");
    if (first && first.kind === "chord" && lastA && first.voice === lastA.voice && first.onset === len) delete first.onset;
    const aN = a.elements.length;
    a.directions = [...(a.directions ?? []), ...(b.directions ?? []).map((d) => ({ ...d, afterElements: (d.afterElements ?? 0) + aN }))];
    if (!a.directions.length) delete a.directions;
    // 下一小节开头换的谱号（等）成了这一小节中间的属性；它中间的属性、小节线照挪
    const { divisions: _d, ...battrs } = b.attrs ?? {};
    void _d;
    const later = [
      ...(a.laterAttrs ?? []),
      ...(Object.keys(battrs).length ? [{ afterElements: aN, onset: len, attrs: battrs }] : []),
      ...(b.laterAttrs ?? []).map((x) => ({ ...x, afterElements: x.afterElements + aN, ...(x.onset !== undefined ? { onset: x.onset + len } : {}) })),
    ];
    if (later.length) a.laterAttrs = later;
    for (const x of b.barlines ?? []) if (x.location === "middle" && x.afterElements !== undefined) x.afterElements += aN;
    a.elements = [...a.elements, ...b.elements];
    a.barlines = [...(a.barlines ?? []).filter((x) => x.location !== "right"), ...(b.barlines ?? []).filter((x) => x.location !== "left")];
    if (!a.barlines.length) delete a.barlines;
    delete a.duration;
    part.measures.splice(mi + 1, 1);
    renumber(part, mi + 1);
    const { time, dpq, key } = measureCtx(song, part, mi);
    for (const v of new Set(a.elements.map((e) => e.voice))) rebeam(a, v, time, dpq);
    respellMeasure(a, key);
  }
  hooks.forgetLayout?.(song);
  return anchor ? { caretAfter: anchor } : { select: [] };
}

/** 在第 `mi` 小节之前换行 / 换页（null = 去掉）。五线谱只能在小节线处换行。 */
export function setBreakBefore(doc: ScoreDoc, si: number, mi: number, kind: "system" | "page" | null): ModelEdit {
  const song = doc.songs[si];
  if (!song || mi <= 0) return { error: tr("me.breakFirst") };
  let anchor: Chord | null = null;
  for (const [pi, part] of song.parts.entries()) {
    const m = part.measures[mi];
    if (!m) continue;
    const p = { ...(m.print ?? {}) };
    delete p.newSystem;
    delete p.newPage;
    if (kind === "system") p.newSystem = true;
    if (kind === "page") p.newPage = true;
    if (Object.keys(p).length) m.print = p;
    else delete m.print;
    if (pi === 0) anchor = ([...(part.measures[mi - 1]?.elements ?? [])].reverse().find((e) => e.kind === "chord") as Chord | undefined) ?? null;
  }
  return anchor ? { caretAfter: anchor } : { select: [] };
}

/** 圆滑线：首尾两个音之间加一条；已有同样起止的就去掉。 */
export function toggleSlur(doc: ScoreDoc, firstId: ElementId, lastId: ElementId): ModelEdit {
  if (firstId === lastId) return { error: tr("ve.slurTwo") };
  const a = locate(doc, firstId);
  const b = locate(doc, lastId);
  if (!a || !b) return { error: tr("me.selectToSlur") };
  if (a.pi !== b.pi) return { error: tr("me.slurCrossPart") };
  const song = a.song;
  const same = song.marks.findIndex((m) => m.type === "slur" && m.start === firstId && m.end === lastId);
  if (same >= 0) song.marks.splice(same, 1);
  else {
    // number 取与它重叠的弧都没用的最小号（同类重叠靠 number 配对）
    const used = new Set(song.marks.filter((m) => m.type === "slur").map((m) => m.number ?? 1));
    let number = 1;
    while (used.has(number)) number++;
    song.marks.push({ type: "slur", number, start: firstId, end: lastId });
  }
  return { select: [a.chord, b.chord] };
}

/** 同一声线里 `loc` 之后的下一个和弦（可跨小节）。 */
function nextInVoice(loc: ChordLoc): Chord | null {
  for (let mi = loc.mi; mi < loc.part.measures.length; mi++) {
    const els = loc.part.measures[mi]!.elements;
    for (let i = mi === loc.mi ? loc.index + 1 : 0; i < els.length; i++) {
      const e = els[i]!;
      if (e.kind === "chord" && e.voice === loc.chord.voice && !e.grace) return e;
    }
  }
  return null;
}

/** 延音线：连到同一声线的下一个音（音高要相同）；已连着就去掉。 */
export function toggleTie(doc: ScoreDoc, id: ElementId): ModelEdit {
  const l = locate(doc, id);
  if (!l || l.chord.rest || l.chord.notes.length === 0) return { error: tr("ve.selectNote") };
  const nxt = nextInVoice(l);
  const same = (x: Chord | null): boolean => !!x && x.notes.length === l.chord.notes.length &&
    x.notes.every((n, i) => n.pitch && l.chord.notes[i]?.pitch && midiOfPitch(n.pitch) === midiOfPitch(l.chord.notes[i]!.pitch!));
  if (!nxt || !same(nxt)) return { error: tr("me.tieSamePitch") };
  const on = l.chord.notes.every((n) => n.tie?.start);
  l.song.marks = l.song.marks.filter((m) => !(m.type === "tied" && m.start === l.chord.id && m.end === nxt.id));
  l.chord.notes.forEach((n, i) => {
    const m = nxt.notes[i]!;
    if (on) {
      if (n.tie) delete n.tie.start;
      if (m.tie) delete m.tie.stop;
    } else {
      n.tie = { ...(n.tie ?? {}), start: true };
      m.tie = { ...(m.tie ?? {}), stop: true };
      l.song.marks.push({ type: "tied", number: 1, start: l.chord.id, end: nxt.id, ...(i ? { startNote: i, endNote: i } : {}) });
    }
  });
  return { select: [l.chord] };
}

/** 音符上的记号：延长号（`fermata` / 倒置 `fermata-inverted`）、奏法（accent、staccato、tenuto…）、装饰（trill-mark、mordent、turn…）。 */
export type DecoKind = "fermata" | "fermata-inverted" | (typeof ARTICULATIONS)[number] | (typeof ORNAMENTS)[number];
export const ARTICULATIONS = ["accent", "staccato", "tenuto", "strong-accent", "staccatissimo", "detached-legato", "breath-mark"] as const;
export const ORNAMENTS = ["trill-mark", "mordent", "inverted-mordent", "turn", "inverted-turn"] as const;

function hasDeco(c: Chord, kind: DecoKind): boolean {
  const n = c.notations;
  if (kind === "fermata") return !!n?.fermata && !n.fermataInverted;
  if (kind === "fermata-inverted") return !!n?.fermata && !!n.fermataInverted;
  return (ARTICULATIONS as readonly string[]).includes(kind) ? !!n?.articulations?.includes(kind) : !!n?.ornaments?.includes(kind);
}

/** 音符记号：有就去掉，没有就加上（选中几个音时，全都有才算有）。 */
export function toggleDeco(doc: ScoreDoc, ids: readonly ElementId[], kind: DecoKind): ModelEdit {
  const locs = chordsOf(doc, ids);
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  const on = locs.every((l) => hasDeco(l.chord, kind));
  for (const { chord: c } of locs) {
    const n = { ...(c.notations ?? {}) };
    if (kind === "fermata" || kind === "fermata-inverted") {
      delete n.fermata;
      delete n.fermataInverted;
      if (!on) {
        n.fermata = true;
        if (kind === "fermata-inverted") n.fermataInverted = true;
      }
    } else {
      const field = (ARTICULATIONS as readonly string[]).includes(kind) ? "articulations" : "ornaments";
      const list = (n[field] ?? []).filter((a) => a !== kind);
      if (!on) list.push(kind);
      if (list.length) n[field] = list;
      else delete n[field];
    }
    if (Object.keys(n).length) c.notations = n;
    else delete c.notations;
  }
  return { select: locs.map((l) => l.chord) };
}

// ───────────────────────── 小节 ─────────────────────────

/** 本小节该有多长（按拍号；没有拍号按实际最长声线）。 */
function nominalLength(song: Song, part: Part, mi: number): number {
  const { time, dpq } = measureCtx(song, part, mi);
  const m = part.measures[mi];
  return time ? (dpq * 4 * time.beats) / time.beatType : m ? measureLength(m) : dpq * 4;
}

/** 整小节休止（声线 1，谱表 1）。 */
function wholeRest(doc: ScoreDoc, len: number, dpq: number): Chord {
  const t = typeOfDivisions(len, dpq) ?? { type: "whole" as NoteType, dots: 0 };
  return { kind: "chord", id: nextId(doc), notes: [], rest: { measure: true }, duration: { divisions: len, type: t.type, dots: t.dots }, voice: 1, staff: 1 };
}

/** 在第 `mi` 小节之前插入一个空小节（`mi` = 小节数时追加在最后）：所有声部一起插，各放一个整小节休止。 */
export function insertMeasure(doc: ScoreDoc, si: number, mi: number, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  let pick: Chord | null = null;
  for (const [pi, part] of song.parts.entries()) {
    const at = Math.max(0, Math.min(mi, part.measures.length));
    // 拍号取插入处前面那一小节的（后一小节换了拍号，新小节仍按换之前的）
    const ref = Math.max(0, Math.min(at > 0 ? at - 1 : 0, part.measures.length - 1));
    const len = nominalLength(song, part, ref);
    const dpqRef = measureCtx(song, part, ref).dpq;
    const rest = wholeRest(doc, len, dpqRef);
    const nm: Measure = { number: "", elements: [rest] };
    // 大谱表（钢琴等）：每行谱表各一个整小节休止，声线照参照小节那一行用的
    let staves = 1;
    for (let k = 0; k <= ref; k++) staves = part.measures[k]?.attrs?.staves ?? staves;
    for (let st = 2; st <= staves; st++) {
      const r = wholeRest(doc, len, dpqRef);
      r.staff = st;
      r.voice = part.measures[ref]?.elements.find((e) => e.staff === st)?.voice ?? (st - 1) * 4 + 1;
      r.onset = 0;
      nm.elements.push(r);
    }
    // 插在第一小节前面：原来第一小节的属性（调号、拍号、divisions、谱号）挪到新的第一小节
    if (at === 0 && part.measures[0]?.attrs) {
      nm.attrs = part.measures[0].attrs;
      delete part.measures[0].attrs;
    }
    // 追加在最后：终止线挪到新的最后一小节（带反复、房号的尾线留在原处——它们是那一小节自己的）
    if (at === part.measures.length) {
      const last = part.measures[at - 1];
      const right = (last?.barlines ?? []).filter((b) => b.location === "right" && b.style === "light-heavy" && !b.repeat && !b.ending);
      if (last && right.length) {
        nm.barlines = right;
        last.barlines = (last.barlines ?? []).filter((b) => !right.includes(b));
        if (!last.barlines.length) delete last.barlines;
      }
    }
    part.measures.splice(at, 0, nm);
    nm.number = at > 0 ? String((Number.parseInt(part.measures[at - 1]!.number, 10) || at) + 1) : "1";
    renumber(part, at);
    if (pi === 0) pick = rest;
  }
  hooks.forgetLayout?.(song);
  return pick ? { select: [pick] } : { select: [] };
}

/** 删掉第 `from`..`to` 小节（含）：所有声部一起删；删掉的第一小节带的属性挪给后面那一小节，以它们为端点的弧与连音线一起去掉。 */
export function deleteMeasures(doc: ScoreDoc, si: number, from: number, to: number, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  const n = song.parts[0]?.measures.length ?? 0;
  if (to - from + 1 >= n) return { error: tr("me.keepOneMeasure") };
  const gone = new Set<ElementId>();
  for (const part of song.parts) {
    const removed = part.measures.slice(from, to + 1);
    for (const m of removed) for (const e of m.elements) gone.add(e.id);
    // 删掉的小节里最早生效的属性（调号、拍号、divisions、谱号）合并给紧跟着的那一小节
    const next = part.measures[to + 1];
    const carried = removed.reduce<Measure["attrs"]>((acc, m) => (m.attrs ? { ...acc, ...m.attrs } : acc), undefined);
    if (next && carried) next.attrs = { ...carried, ...(next.attrs ?? {}) };
    // 删的是最后几小节：终止线挪给新的最后一小节
    const lastRight = removed[removed.length - 1]?.barlines?.filter((b) => b.location === "right") ?? [];
    part.measures.splice(from, to - from + 1);
    if (!next && lastRight.length) {
      const last = part.measures[part.measures.length - 1]!;
      last.barlines = [...(last.barlines ?? []).filter((b) => b.location !== "right"), ...lastRight];
    }
    renumber(part, from);
  }
  // 一头删掉的延音线：留下那头的音上的 tie 标记也清掉（不然写出孤零零的 <tie type="stop">）
  for (const mk of song.marks) {
    if (mk.type !== "tied" || gone.has(mk.start) === gone.has(mk.end)) continue;
    const other = locate(doc, gone.has(mk.start) ? mk.end : mk.start)?.chord;
    for (const nt of other?.notes ?? []) if (nt.tie) delete nt.tie[gone.has(mk.start) ? "stop" : "start"];
  }
  song.marks = song.marks.filter((m) => !gone.has(m.start) && !gone.has(m.end));
  hooks.forgetLayout?.(song);
  const after = song.parts[0]?.measures[Math.min(from, (song.parts[0]?.measures.length ?? 1) - 1)]?.elements.find((e): e is Chord => e.kind === "chord");
  return after ? { select: [after] } : { select: [] };
}

/** 从第 `mi` 小节起换调号（音高不动，临时记号的印法到下一次换调号为止重算）。 */
export function setKeyAt(doc: ScoreDoc, si: number, mi: number, fifths: number, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  for (const part of song.parts) {
    const m = part.measures[mi];
    if (!m) continue;
    m.attrs = { ...(m.attrs ?? {}), key: { ...(m.attrs?.key ?? {}), fifths } };
    if (mi === 0) song.key = { ...(song.key ?? {}), fifths };
    for (let i = mi; i < part.measures.length; i++) {
      if (i > mi && part.measures[i]!.attrs?.key) break;
      respellMeasure(part.measures[i]!, measureCtx(song, part, i).key);
    }
  }
  hooks.forgetLayout?.(song);
  return { select: [] };
}

/** 从第 `mi` 小节起换拍号（小节里的音不动，拍数不对的由自检标出）。 */
export function setTimeAt(doc: ScoreDoc, si: number, mi: number, beats: number, beatType: number, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  if (!(beats > 0 && [1, 2, 4, 8, 16, 32].includes(beatType))) return { error: tr("me.timeFormat") };
  for (const part of song.parts) {
    const m = part.measures[mi];
    if (!m) continue;
    m.attrs = { ...(m.attrs ?? {}), time: { beats, beatType } };
    if (mi === 0) song.time = { beats, beatType };
    const { time, dpq } = measureCtx(song, part, mi);
    for (let i = mi; i < part.measures.length; i++) {
      const x = part.measures[i]!;
      if (i > mi && x.attrs?.time) break;
      for (const v of new Set(x.elements.map((e) => e.voice))) rebeam(x, v, time, dpq);
    }
  }
  hooks.forgetLayout?.(song);
  return { select: [] };
}

/** 第 `mi` 小节开头的速度记号（♩ = bpm）；bpm 为 0 = 去掉。只挂在第一声部上（MusicXML 的通例）。 */
export function setTempoAt(doc: ScoreDoc, si: number, mi: number, bpm: number): ModelEdit {
  const m = doc.songs[si]?.parts[0]?.measures[mi];
  if (!m) return { error: tr("me.noMeasure") };
  const rest = (m.directions ?? []).filter((d) => !(d.type === "metronome" && !(d.afterElements ?? 0)));
  if (bpm > 0) rest.unshift({ type: "metronome", tempo: { beatUnit: "quarter", perMinute: bpm }, sound: { tempo: bpm } });
  if (rest.length) m.directions = rest;
  else delete m.directions;
  return { select: [] };
}

export type BarKind = "single" | "double" | "final" | "repeatStart" | "repeatEnd";

/** 第 `mi` 小节的小节线样式：反复开始在小节头（左线），其余在小节尾（右线）。所有声部一起改。 */
export function setBarKind(doc: ScoreDoc, si: number, mi: number, kind: BarKind): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  for (const part of song.parts) {
    const m = part.measures[mi];
    if (!m) continue;
    const loc = kind === "repeatStart" ? "left" : "right";
    const old = (m.barlines ?? []).find((b) => b.location === loc);
    const others = (m.barlines ?? []).filter((b) => b !== old);
    const b = { ...(old ?? {}), location: loc } as NonNullable<Measure["barlines"]>[number];
    delete b.style;
    delete b.repeat;
    if (kind === "double") b.style = "light-light";
    if (kind === "final") b.style = "light-heavy";
    if (kind === "repeatEnd") (b.style = "light-heavy"), (b.repeat = "backward");
    if (kind === "repeatStart") (b.style = "heavy-light"), (b.repeat = "forward");
    const keep = kind !== "single" || b.ending || b.jump;
    m.barlines = keep ? [...others, b] : others;
    if (!m.barlines.length) delete m.barlines;
  }
  return { select: [] };
}

/** 房号：第 `from`..`to` 小节标成第 `n` 房（已是就去掉）。所有声部一起标。 */
export function toggleEnding(doc: ScoreDoc, si: number, from: number, to: number, n: number): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  const cur = song.parts[0]?.measures[from]?.barlines?.find((b) => b.location === "left" && b.ending?.type === "start");
  const on = !!cur && cur.ending!.numbers.includes(n);
  for (const part of song.parts) {
    for (const [i, loc, type] of [[from, "left", "start"], [to, "right", "stop"]] as const) {
      const m = part.measures[i];
      if (!m) continue;
      const old = (m.barlines ?? []).find((b) => b.location === loc);
      const others = (m.barlines ?? []).filter((b) => b !== old);
      const b = { ...(old ?? {}), location: loc } as NonNullable<Measure["barlines"]>[number];
      if (on) delete b.ending;
      // 最后一房不封口（`discontinue`），前面的房封口
      else b.ending = { numbers: [n], type: type === "stop" && n > 1 ? "discontinue" : type };
      const keep = b.style || b.repeat || b.ending || b.jump;
      m.barlines = keep ? [...others, b] : others;
      if (!m.barlines.length) delete m.barlines;
    }
  }
  return { select: [] };
}

export type JumpKind = "segno" | "coda" | "dc" | "ds" | "fine";

/** 跳转记号：segno / coda 挂在小节头，D.C. / D.S. / Fine 挂在小节尾（带 `<sound>`，试听与演唱顺序按它跳）。已有就去掉。 */
export function toggleJump(doc: ScoreDoc, si: number, mi: number, kind: JumpKind): ModelEdit {
  const m = doc.songs[si]?.parts[0]?.measures[mi];
  if (!m) return { error: tr("me.noMeasure") };
  const end = kind === "dc" || kind === "ds" || kind === "fine";
  const text = { dc: "D.C.", ds: "D.S.", fine: "Fine" } as const;
  const is = (d: NonNullable<Measure["directions"]>[number]): boolean =>
    kind === "segno" || kind === "coda" ? d.type === kind : d.type === "words" && d.text === text[kind as "dc" | "ds" | "fine"];
  const dirs = m.directions ?? [];
  if (dirs.some(is)) m.directions = dirs.filter((d) => !is(d));
  else {
    const at = end ? m.elements.length : 0;
    const d: NonNullable<Measure["directions"]>[number] = kind === "segno" || kind === "coda"
      ? { type: kind, afterElements: at, sound: kind === "segno" ? { segno: "segno" } : { coda: "coda" } }
      : { type: "words", text: text[kind], afterElements: at, sound: kind === "dc" ? { dacapo: true } : kind === "ds" ? { dalsegno: "segno" } : { fine: true } };
    m.directions = [...dirs, d];
  }
  if (!m.directions?.length) delete m.directions;
  return { select: [] };
}

// ───────────────────────── 和弦与声线 ─────────────────────────

/** 往和弦里加一个音：唱名 `degree`，放在和弦最高音之上最近的那个八度（同 MuseScore 的 Shift+音名）。 */
export function addChordNote(doc: ScoreDoc, id: ElementId, degree: number, hooks: EditHooks = {}): ModelEdit {
  const l = locate(doc, id);
  if (!l || l.chord.rest || !l.chord.notes.length) return { error: tr("me.selectNoteNoRest") };
  const { key } = measureCtx(l.song, l.part, l.mi);
  const top = Math.max(...l.chord.notes.map((n) => (n.pitch ? midiOfPitch(n.pitch) : 0)));
  const p0 = pitchOfDegree(degree, 0, key);
  if (!p0) return { error: tr("me.degree17") };
  let p = nearestOctave(p0, top + 6);
  while (midiOfPitch(p) <= top) p = { ...p, octave: p.octave + 1 };
  const old = [...l.chord.notes];
  l.chord.notes.push({ pitch: p });
  l.chord.notes.sort((a, b) => (a.pitch ? midiOfPitch(a.pitch) : 0) - (b.pitch ? midiOfPitch(b.pitch) : 0));
  renoteMarks(l.song, l.chord, old);
  touched([l], hooks.forgetStem);
  return { select: [l.chord] };
}

/** 和弦里的音重排、删了一个之后：挂在「第几个音」上的弧与延音线跟着那个音走（音删掉了，挂在它上面的去掉）。 */
function renoteMarks(song: Song, chord: Chord, old: readonly Note[]): void {
  const at = (i: number | undefined): number => chord.notes.indexOf(old[i ?? 0]!);
  song.marks = song.marks.filter((mk) => {
    if (mk.start === chord.id) {
      const j = at(mk.startNote);
      if (j < 0) return false;
      if (j) mk.startNote = j;
      else delete mk.startNote;
    }
    if (mk.end === chord.id) {
      const j = at(mk.endNote);
      if (j < 0) return false;
      if (j) mk.endNote = j;
      else delete mk.endNote;
    }
    return true;
  });
}

/** 选中和弦里的第 `index` 个音（从低到高）单独删掉；只剩一个音时不删。 */
export function removeChordNote(doc: ScoreDoc, id: ElementId, index: number, hooks: EditHooks = {}): ModelEdit {
  const l = locate(doc, id);
  if (!l || l.chord.notes.length < 2) return { error: tr("me.lastChordNote") };
  // `index` 按谱面从低到高数；模型里的次序是原文的（不少软件从高往低写）
  const byPitch = [...l.chord.notes].sort((a, b) => (a.pitch ? midiOfPitch(a.pitch) : 0) - (b.pitch ? midiOfPitch(b.pitch) : 0));
  const gone = byPitch[index];
  if (!gone) return { error: tr("me.noNote") };
  const old = [...l.chord.notes];
  l.chord.notes = old.filter((n) => n !== gone);
  renoteMarks(l.song, l.chord, old);
  touched([l], hooks.forgetStem);
  return { select: [l.chord] };
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
  const song = doc.songs[at.si];
  const part = song?.parts[at.pi];
  const measure = part?.measures[at.mi];
  if (!song || !part || !measure) return { error: tr("me.noInsertPos") };
  const dpq0 = measureCtx(song, part, at.mi).dpq;
  const div = fitDivisions(part, (dpq0 / Math.pow(2, dur.halvings)) * dotFactor(dur.dots));
  const { key, time, dpq: scale } = measureCtx(song, part, at.mi); // 可能刚放大过单位
  const onset = (at.onset * scale) / dpq0;
  const ch: Chord = { kind: "chord", id: nextId(doc), notes: [], duration: { divisions: 0, dots: 0 }, voice, staff: at.staff };
  const err = setDivisions(ch, div, scale);
  if (err) return { error: err };
  if (degree === 0) ch.rest = {};
  else {
    const p = pitchOfDegree(degree, 0, key);
    if (!p) return { error: tr("me.degree07") };
    ch.notes = [{ pitch: nearestOctave(p, neighbourMidi(part, at.mi, measure.elements.length, voice)) }];
  }
  const on = onsets(measure);
  const mine = measure.elements.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === "chord" && e.voice === voice);
  if (mine.some(({ e }) => !(e as Chord).grace && (on.get(e as Chord) ?? 0) === onset)) {
    return { error: tr("me.voiceBusy", { n: shown }) };
  }
  const before = mine.filter(({ e }) => (on.get(e as Chord) ?? 0) <= onset).pop();
  // 比本声线第一个音还早：插在它前面（不能接在小节元素末尾——排在后面的元素起点在前，符杠与位置都乱）
  const index = before ? before.i + 1 : (mine[0]?.i ?? measure.elements.length);
  const prevEnd = before ? (on.get(before.e as Chord) ?? 0) + (before.e as Chord).duration.divisions : -1;
  if (prevEnd !== onset) ch.onset = onset;
  // 后面同声线的那个音若原本接着前一个音，现在前面换成了新音，给它显式起点保住原位
  const follower = mine.find(({ i }) => i >= index);
  if (follower && follower.e.kind === "chord" && follower.e.onset === undefined) follower.e.onset = on.get(follower.e) ?? 0;
  measure.elements.splice(index, 0, ch);
  shiftForInsert(measure, index);
  delete measure.duration;
  rebeam(measure, voice, time, scale);
  respellMeasure(measure, key);
  hooks.forgetLayout?.(song);
  return { caretAfter: ch };
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
  const locs = chordsOf(doc, ids).filter((l) => l.chord.notes.some((n) => n.pitch));
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  for (const l of locs) {
    const { key } = measureCtx(l.song, l.part, l.mi);
    for (const n of l.chord.notes) {
      if (!n.pitch) continue;
      const d = degreeFromPitch(n.pitch, key);
      let num = d.number + delta;
      let shift = d.octaveShift;
      if (num > 7) (num = 1), shift++;
      if (num < 1) (num = 7), shift--;
      const p = pitchOfDegree(num, shift, key);
      if (p) n.pitch = p;
    }
  }
  touched(locs, hooks.forgetStem);
  return { select: locs.map((l) => l.chord) };
}

/** 半音走一步（`Alt+↑`/`Alt+↓`）：落在调内音上写本音，否则升号调写升号、降号调写降号，C 调按走的方向。 */
export function stepSemitone(doc: ScoreDoc, ids: readonly ElementId[], delta: 1 | -1, hooks: EditHooks = {}): ModelEdit {
  return shiftSemitones(doc, ids, delta, hooks);
}

/** 选中的音移 `n` 个半音（移调对话框的「选区」），拼写同 `stepSemitone`。 */
export function shiftSemitones(doc: ScoreDoc, ids: readonly ElementId[], n: number, hooks: EditHooks = {}): ModelEdit {
  const locs = chordsOf(doc, ids).filter((l) => l.chord.notes.some((x) => x.pitch));
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  for (const l of locs) {
    const { key } = measureCtx(l.song, l.part, l.mi);
    const sign = key.fifths > 0 ? 1 : key.fifths < 0 ? -1 : Math.sign(n) || 1;
    for (const x of l.chord.notes) if (x.pitch) x.pitch = spellMidi(midiOfPitch(x.pitch) + n, key.fifths, sign);
  }
  touched(locs, hooks.forgetStem);
  return { select: locs.map((l) => l.chord) };
}

/** 调号（升号个数）移 `n` 个半音后的调号：新主音按常用写法取（升 / 降不超过 6 个，F♯ 与 G♭ 取 F♯）。 */
export function transposeFifths(fifths: number, n: number): number {
  const pc = (((fifths * 7 + n) % 12) + 12) % 12;
  return [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][pc]!;
}

/** 全曲移 `n` 个半音：每个音移过去、每处调号跟着换（`transposeFifths`），按新调号拼写；和弦记号不动。 */
export function transposeScore(doc: ScoreDoc, n: number, hooks: EditHooks = {}): ModelEdit {
  if (n === 0) return { error: tr("me.nothingToMove") };
  const all: Chord[] = [];
  for (const song of doc.songs) {
    if (song.key) song.key = { ...song.key, fifths: transposeFifths(song.key.fifths, n) };
    for (const part of song.parts) {
      // 一处调号都没写（C 调）：在第一小节补上新调号，否则移过去的音没有调号可依
      const first = part.measures[0];
      if (!song.key && first && !first.attrs?.key) first.attrs = { ...first.attrs, key: { fifths: 0 } };
      let fifths = song.key?.fifths ?? 0;
      for (const m of part.measures) {
        if (m.attrs?.key) {
          m.attrs.key = { ...m.attrs.key, fifths: transposeFifths(m.attrs.key.fifths, n) };
          fifths = m.attrs.key.fifths;
        }
        const sign = fifths > 0 ? 1 : fifths < 0 ? -1 : Math.sign(n);
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          for (const x of el.notes) if (x.pitch) x.pitch = spellMidi(midiOfPitch(x.pitch) + n, fifths, sign);
          if (el.notes.some((x) => x.pitch)) all.push(el);
        }
      }
    }
    hooks.forgetLayout?.(song);
  }
  for (const id of all.map((c) => c.id)) {
    const l = locate(doc, id);
    if (l) touched([l], hooks.forgetStem);
  }
  return { select: [] };
}

/** MIDI 音高拼成音名：调内音优先，其次本位，再按 `sign` 取升或降。 */
function spellMidi(midi: number, fifths: number, sign: number): Pitch {
  let best: Pitch | null = null;
  let rank = Infinity;
  for (const step of STEPS) {
    for (const alter of [-1, 0, 1]) {
      const pc = (STEP_SEMI[step]! + alter + 12) % 12;
      if (pc !== ((midi % 12) + 12) % 12) continue;
      const r = alter === keyAlter(step, fifths) ? 0 : alter === 0 ? 1 : Math.sign(alter) === sign ? 2 : 3;
      if (r >= rank) continue;
      rank = r;
      const octave = Math.floor((midi - STEP_SEMI[step]! - alter) / 12) - 1;
      best = { step, alter, octave };
    }
  }
  return best!;
}

/** 按音名改（`A`–`G`，编辑模式）：升降照调号，八度取离原来那个音最近的；休止改成音时离前一个音最近。和弦只改最上面那个音。 */
export function setStep(doc: ScoreDoc, ids: readonly ElementId[], letter: string, hooks: EditHooks = {}): ModelEdit {
  const step = STEPS.find((x) => x === letter.toUpperCase());
  if (!step) return { error: tr("me.stepAG") };
  const locs = chordsOf(doc, ids).filter((l) => !l.chord.grace);
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  for (const l of locs) {
    const { key } = measureCtx(l.song, l.part, l.mi);
    const ch = l.chord;
    const top = topNote(ch);
    const ref = top?.pitch ? midiOfPitch(top.pitch) : neighbourMidi(l.part, l.mi, l.index, ch.voice);
    const p = nearestOctave({ step, alter: keyAlter(step, key.fifths), octave: 4 }, ref);
    delete ch.rest;
    if (top) top.pitch = p;
    else ch.notes = [{ pitch: p }];
  }
  touched(locs, hooks.forgetStem);
  return { select: locs.map((l) => l.chord) };
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
  const locs = chordsOf(doc, ids).filter((l) => !l.chord.grace).sort((a, b) => a.index - b.index);
  if (locs.length < 2) return { error: tr("ve.tupletTwo") };
  const f = locs[0]!;
  if (locs.some((l) => l.measure !== f.measure || l.chord.voice !== f.chord.voice)) return { error: tr("me.tupletSame") };
  const song = f.song;
  const mark = song.marks.find((m) => m.type === "tuplet" && m.start === f.chord.id && m.end === locs[locs.length - 1]!.chord.id);
  if (mark) {
    // 拆回去：时值还原、去掉比例与括号
    for (const l of locs) {
      const tm = l.chord.duration.timeMod;
      if (!tm) continue;
      l.chord.duration.divisions = fitDivisions(l.part, (l.chord.duration.divisions * tm.actual) / tm.normal);
      delete l.chord.duration.timeMod;
    }
    song.marks = song.marks.filter((m) => m !== mark);
  } else {
    if (locs.some((l) => l.chord.duration.timeMod)) return { error: tr("me.tupletAlready") };
    const n = locs.length;
    const normal = tupletNormal(n);
    for (const l of locs) {
      // 放大单位（`fitDivisions` 可能整声部乘一倍）后再按当前值算，前面改过的也一起放大了，比例不变
      l.chord.duration.divisions = fitDivisions(l.part, (l.chord.duration.divisions * normal) / n);
      l.chord.duration.timeMod = { actual: n, normal };
    }
    song.marks.push({ type: "tuplet", start: f.chord.id, end: locs[locs.length - 1]!.chord.id, tupletActual: n, tupletNormal: normal });
  }
  const { time, dpq } = measureCtx(song, f.part, f.mi);
  rebeam(f.measure, f.chord.voice, time, dpq);
  delete f.measure.duration;
  hooks.forgetLayout?.(song);
  return { select: locs.map((l) => l.chord) };
}

// ───────────────────────── 歌词 ─────────────────────────

/** 同声部同声线、`id` 之前最近的一个和弦（找连字符的前一半）。 */
function prevChord(l: ChordLoc): Chord | null {
  for (let mi = l.mi; mi >= 0; mi--) {
    const els = l.part.measures[mi]!.elements;
    for (let i = (mi === l.mi ? l.index : els.length) - 1; i >= 0; i--) {
      const e = els[i]!;
      if (e.kind === "chord" && e.voice === l.chord.voice && !e.grace) return e;
    }
  }
  return null;
}

function nextChord(l: ChordLoc): Chord | null {
  for (let mi = l.mi; mi < l.part.measures.length; mi++) {
    const els = l.part.measures[mi]!.elements;
    for (let i = mi === l.mi ? l.index + 1 : 0; i < els.length; i++) {
      const e = els[i]!;
      if (e.kind === "chord" && e.voice === l.chord.voice && !e.grace) return e;
    }
  }
  return null;
}

type LyricOf = NonNullable<Chord["lyrics"]>[number];
const hyphenAfter = (ly: LyricOf | undefined): boolean => ly?.syllabic === "begin" || ly?.syllabic === "middle";
/** 前面那个字接不接连字符变了：这个字的 syllabic 跟着改（自己后面接不接不变） */
function relinkSyllabic(ly: LyricOf | undefined, joinedBefore: boolean): void {
  if (!ly) return;
  const hy = hyphenAfter(ly);
  ly.syllabic = joinedBefore ? (hy ? "middle" : "end") : hy ? "begin" : "single";
}

/**
 * 歌词录入：和弦 `id` 第 `verse` 段的字写成 `text`（空串 = 去掉这一段的字）。`hyphen` = 后面接连字符（`<syllabic>` 按前一个字推：
 * 前一个字后面带连字符的这个是 middle / end，否则 begin / single）；`extend` = 一字多音的续线。
 */
export function setLyric(doc: ScoreDoc, id: ElementId, verse: number, text: string, hyphen: boolean, extend: boolean): ModelEdit {
  const l = locate(doc, id);
  if (!l) return { error: tr("me.noNote") };
  const ch = l.chord;
  const rest = (ch.lyrics ?? []).filter((x) => x.number !== verse);
  const prev = prevChord(l)?.lyrics?.find((x) => x.number === verse);
  const next = nextChord(l)?.lyrics?.find((x) => x.number === verse);
  if (text === "") {
    ch.lyrics = rest;
    if (!ch.lyrics.length) delete ch.lyrics;
    // 字去掉了：前一个字不再连到这儿、后一个字也不再接着这个字（Hal-le-lu 去掉 le → Hal、lu 各自成字）
    if (prev && hyphenAfter(prev)) prev.syllabic = prev.syllabic === "middle" ? "end" : "single";
    relinkSyllabic(next, false);
    return { select: [ch] };
  }
  const joined = hyphenAfter(prev);
  relinkSyllabic(next, hyphen);
  const old = ch.lyrics?.find((x) => x.number === verse);
  const ly = { ...(old ?? {}), number: verse, text, syllabic: (joined ? (hyphen ? "middle" : "end") : hyphen ? "begin" : "single") as NonNullable<typeof old>["syllabic"] };
  if (extend) ly.extend = true;
  else delete ly.extend;
  delete ly.extendType;
  ch.lyrics = [...rest, ly].sort((a, b) => a.number - b.number);
  return { select: [ch] };
}

/** 和弦名录入：和弦 `id` 的和弦名写成 `text`（空串 = 去掉）。只记原文，结构由写出端按文字解析（同简谱来源的和弦名）。 */
export function setHarmony(doc: ScoreDoc, id: ElementId, text: string): ModelEdit {
  const l = locate(doc, id);
  if (!l) return { error: tr("me.noNote") };
  if (text === "") delete l.chord.harmony;
  else l.chord.harmony = { root: { step: "C", alter: 0 }, kind: "", text };
  return { select: [l.chord] };
}

/** 文字 / 力度录入：和弦 `id` 前面挂一条 `<direction>`（文字在上方、力度在下方）；`text` 空串 = 去掉。 */
export function setDirectionText(doc: ScoreDoc, id: ElementId, type: "words" | "dynamics", text: string): ModelEdit {
  const l = locate(doc, id);
  if (!l) return { error: tr("me.noNote") };
  const m = l.measure;
  const at = (d: Direction): boolean => d.type === type && (d.afterElements ?? 0) === l.index && (d.voice === undefined || d.voice === l.chord.voice);
  const rest = (m.directions ?? []).filter((d) => !at(d));
  if (text !== "") {
    rest.push({ type, text, afterElements: l.index, placement: type === "dynamics" ? "below" : "above", voice: l.chord.voice, staff: l.chord.staff });
  }
  if (rest.length) m.directions = rest;
  else delete m.directions;
  return { select: [l.chord] };
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
  let at = anchor;
  let last: Chord | null = null;
  const added: Chord[] = [];
  for (const it of items) {
    if (it.kind === "bar") continue;
    if (it.kind === "sustain") {
      if (last) {
        const r = addBeat(doc, last.id, hooks);
        if (isEditError(r)) return r;
      }
      continue;
    }
    const r = insertChord(doc, at, it.degree, { halvings: it.halvings, dots: it.dots }, hooks);
    if (isEditError(r) || !("caretAfter" in r)) return r;
    last = r.caretAfter;
    added.push(last);
    if (it.degree > 0) {
      const l = locate(doc, last.id)!;
      const p = pitchOfDegree(it.degree, it.octave, measureCtx(l.song, l.part, l.mi).key, it.acc ?? undefined);
      if (p) last.notes = [{ pitch: p }];
      touched([l], hooks.forgetStem);
    }
    at = { after: last.id };
  }
  return added.length ? { select: added } : { error: tr("me.clipNoNotes") };
}

// ───────────────────────── 识别修正：重读与挪动 ─────────────────────────
//
// 识谱软件里改谱号、改调号是**纠正认错**（PhotoScore、SmartScore 默认符头不动、按新谱号 / 调号重读音高），
// 与打谱软件的「保音高、挪符头」相反，两种都给（`reread`）。挪动类（连线端点、力度文字、和弦名、歌词）一次挪一个音，
// 对齐识谱软件「拖到最近的音上吸附」那一下。

const DIATONIC: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const ACC_ALTER: Record<Accidental, number> = { "double-flat": -2, flat: -1, natural: 0, sharp: 1, "double-sharp": 2 };

/** 谱号最下面那条线是第几个自然音级（八度 × 7 + 音级）：G 谱号第二线 G4、F 谱号第四线 F3、C 谱号第三线 C4。 */
function clefBottom(c: Clef): number {
  const ref = c.sign === "F" ? 3 * 7 + 3 : c.sign === "C" ? 4 * 7 : 4 * 7 + 4;
  const line = c.line ?? (c.sign === "F" ? 4 : c.sign === "C" ? 3 : 2);
  return ref + 7 * (c.octaveChange ?? 0) - 2 * (line - 1);
}

const staffOf = (c: { staff?: number }): number => c.staff ?? 1;

/** 第 `mi` 小节开头第 `staff` 谱表生效的谱号（含本小节 `attrs`、不含小节中间的）。 */
function clefAt(part: Part, mi: number, staff: number): Clef {
  let cur: Clef = { sign: "G", line: 2 };
  for (let i = 0; i <= mi && i < part.measures.length; i++) {
    const m = part.measures[i]!;
    if (i > 0) for (const la of part.measures[i - 1]!.laterAttrs ?? []) for (const c of la.attrs.clefs ?? []) if (staffOf(c) === staff) cur = c;
    for (const c of m.attrs?.clefs ?? []) if (staffOf(c) === staff) cur = c;
  }
  return cur;
}

/**
 * 重读一小节里（某谱表上、`keep` 放行的）音的升降：印了临时记号的照记号，没印的按本小节前面同音级同八度印过的、
 * 再按延音线接过来的（`carry`，上一小节末的连音起点），最后按调号——即读谱的人怎么读。返回本小节末仍连着的音，给下一小节当 `carry`。
 */
function rereadAlters(m: Measure, key: Key, staff: number | null, keep: (ch: Chord, at: number) => boolean, carry: Map<string, number>): Map<string, number> {
  const at = onsets(m);
  const items: { at: number; order: number; note: Note; staff: number; ch: Chord }[] = [];
  m.elements.forEach((el, order) => {
    if (el.kind !== "chord" || (staff !== null && el.staff !== staff)) return;
    for (const n of el.notes) if (n.pitch) items.push({ at: at.get(el) ?? 0, order, note: n, staff: el.staff, ch: el });
  });
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  const state = new Map<string, number>();
  const out = new Map<string, number>();
  for (const it of items) {
    const p = it.note.pitch!;
    const k = `${it.staff}:${p.step}:${p.octave}`;
    if (keep(it.ch, it.at)) {
      const alter = it.note.accidental ? ACC_ALTER[it.note.accidental]
        : it.note.tie?.stop && carry.has(k) ? carry.get(k)!
          : state.get(k) ?? keyAlter(p.step, key.fifths);
      it.note.pitch = { ...p, alter };
    }
    state.set(k, it.note.pitch!.alter);
    if (it.note.tie?.start) out.set(k, it.note.pitch!.alter);
  }
  return out;
}

/**
 * 换谱号：第 `pi` 声部第 `staff` 谱表自第 `mi` 小节起改成 `clef`，到这一谱表下一次换谱号为止。
 * `reread`：符头在谱表上的位置不动、按新谱号重读音高（识别认错谱号的纠正）；否则音高不动（谱面上符头跟着挪）。
 */
export function setClefAt(doc: ScoreDoc, si: number, pi: number, mi: number, staff: number, clef: Clef, reread: boolean, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  const part = song?.parts[pi];
  const m0 = part?.measures[mi];
  if (!song || !part || !m0) return { error: tr("me.noMeasure") };
  const old = clefAt(part, mi, staff);
  const nc: Clef = { ...clef, ...(staff > 1 || (part.staffCount ?? 1) > 1 ? { staff } : {}) };
  m0.attrs = { ...(m0.attrs ?? {}), clefs: [...(m0.attrs?.clefs ?? []).filter((c) => staffOf(c) !== staff), nc] };
  // 保音高：音不动，谱面上符头跟着谱号挪（临时记号印法与谱号无关，不用重算）
  if (reread) {
    const shift = clefBottom(nc) - clefBottom(old);
    let carry = new Map<string, number>();
    for (let i = mi; i < part.measures.length; i++) {
      const m = part.measures[i]!;
      if (i > mi && m.attrs?.clefs?.some((c) => staffOf(c) === staff)) break;
      // 小节中间换了这一谱表的谱号：那之后的音不归这一段
      // 小节中间那条的位置：读入时多半没记 `onset`（缺省 = 它前面那个元素的终点，同写出端的游标）
      const cut = (m.laterAttrs ?? []).filter((la) => la.attrs.clefs?.some((c) => staffOf(c) === staff)).map((la) => la.onset ?? defaultOnsetBefore(m, la.afterElements));
      const stop = cut.length ? Math.min(...cut) : Infinity;
      const keep = (_: Chord, at: number): boolean => at < stop;
      const at = onsets(m);
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.staff !== staff || !keep(el, at.get(el) ?? 0)) continue;
        for (const n of el.notes) {
          if (!n.pitch) continue;
          const d = n.pitch.octave * 7 + DIATONIC[n.pitch.step]! + shift;
          n.pitch = { step: STEPS[((d % 7) + 7) % 7]!, alter: n.pitch.alter, octave: Math.floor(d / 7) };
        }
        hooks.forgetStem?.(el);
      }
      // 印出来的临时记号就是谱面上的，重读不改它的印法（不跑 `respellMeasure`，否则提醒记号会被当成多余的去掉）
      carry = rereadAlters(m, measureCtx(song, part, i).key, staff, keep, carry);
      if (stop !== Infinity) break;
    }
  }
  hooks.forgetLayout?.(song);
  return { select: [] };
}

/**
 * 换调号并**重读**：自第 `mi` 小节起各声部改成 `fifths`，到下一次换调号为止，没印临时记号的音按新调号重读升降
 * （印了的照记号；同小节前面印过的、延音线接过来的照前面）。保音高那一种见 `setKeyAt`。
 */
export function rereadKeyAt(doc: ScoreDoc, si: number, mi: number, fifths: number, hooks: EditHooks = {}): ModelEdit {
  const song = doc.songs[si];
  if (!song) return { error: tr("me.noMeasure") };
  for (const part of song.parts) {
    const m0 = part.measures[mi];
    if (!m0) continue;
    m0.attrs = { ...(m0.attrs ?? {}), key: { ...(m0.attrs?.key ?? {}), fifths } };
    if (mi === 0) song.key = { ...(song.key ?? {}), fifths };
    let carry = new Map<string, number>();
    for (let i = mi; i < part.measures.length; i++) {
      const m = part.measures[i]!;
      if (i > mi && m.attrs?.key) break;
      const key = measureCtx(song, part, i).key;
      carry = rereadAlters(m, key, null, () => true, carry);
      for (const el of m.elements) if (el.kind === "chord") hooks.forgetStem?.(el);
    }
  }
  hooks.forgetLayout?.(song);
  return { select: [] };
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

/** 先后：同一声部里谁在前（小节、小节内下标）。 */
const before = (a: ChordLoc, b: ChordLoc): boolean => a.mi < b.mi || (a.mi === b.mi && a.index < b.index);

/**
 * 连线（圆滑线、三连音以外的跨音记号）一端挪一个音：`which` 哪一端、`delta` 往后 +1 / 往前 −1；`which` 为 `both` 整条一起挪。
 * 挪到的音不能越过另一端。延音线只连相邻同音，不挪（删了在对的地方重加）。
 */
export function moveMarkEnd(doc: ScoreDoc, type: Mark["type"], startId: ElementId, endId: ElementId, which: "start" | "end" | "both", delta: number): ModelEdit & { moved?: MovedMark } {
  const a = locate(doc, startId);
  const b = locate(doc, endId);
  if (!a || !b) return { error: tr("me.noNote") };
  const mk = a.song.marks.find((m) => m.type === type && m.start === startId && m.end === endId);
  if (!mk) return { error: tr("me.noMark") };
  if (type === "tied") return { error: tr("me.tieNoMove") };
  const skip = (c: Chord): boolean => !!c.grace || !!c.rest;
  let na = a;
  let nb = b;
  if (which !== "end") {
    const x = stepInVoice(a, delta, skip);
    if (!x) return { error: tr("me.noNeighbour") };
    na = x;
  }
  if (which !== "start") {
    const x = stepInVoice(b, delta, skip);
    if (!x) return { error: tr("me.noNeighbour") };
    nb = x;
  }
  if (!before(na, nb)) return { error: tr("me.markCollapse") };
  mk.start = na.chord.id;
  mk.end = nb.chord.id;
  delete mk.startNote;
  delete mk.endNote;
  return { select: [na.chord, nb.chord], moved: { markOn: na.chord, kind: "slur" } };
}

/** 小节里第 `i` 个元素之前、按写出端的游标（文档序）缺省落在哪一刻（见 `toxml.ts` 的 `end`）。 */
function defaultOnsetBefore(m: Measure, i: number): number {
  let cursor = 0;
  for (let k = 0; k < i && k < m.elements.length; k++) {
    const el = m.elements[k]!;
    const start = el.onset ?? cursor;
    cursor = start + (el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : (el.duration?.divisions ?? 0));
  }
  return cursor;
}

/** 一条 `<direction>` 的位置：第几首、第几声部、第几小节、`directions` 里第几条。 */
export interface DirRef {
  si: number;
  pi: number;
  mi: number;
  index: number;
}

/** 这条记号挂在哪个音前（`afterElements` 指的那个和弦；挂在小节末的取最后一个和弦）。 */
/** `atEnd`：挂在小节里最后一个（同声线）和弦**之后**（小节末的力度、渐强渐弱的终点），`loc` 借那最后一个和弦。 */
function dirAnchor(doc: ScoreDoc, r: DirRef): { loc: ChordLoc; dir: Direction; atEnd: boolean } | null {
  const song = doc.songs[r.si];
  const part = song?.parts[r.pi];
  const m = part?.measures[r.mi];
  const dir = m?.directions?.[r.index];
  if (!song || !part || !m || !dir) return null;
  const k = Math.min(dir.afterElements ?? 0, m.elements.length - 1);
  // 往后找第一个和弦（同声线优先）
  for (let i = Math.max(0, k); i < m.elements.length; i++) {
    const e = m.elements[i]!;
    if (e.kind === "chord" && (dir.voice === undefined || e.voice === dir.voice)) return { loc: { si: r.si, pi: r.pi, mi: r.mi, song, part, measure: m, chord: e, index: i }, dir, atEnd: (dir.afterElements ?? 0) > i };
  }
  for (let i = m.elements.length - 1; i >= 0; i--) {
    const e = m.elements[i]!;
    if (e.kind === "chord" && (dir.voice === undefined || e.voice === dir.voice)) return { loc: { si: r.si, pi: r.pi, mi: r.mi, song, part, measure: m, chord: e, index: i }, dir, atEnd: true };
  }
  for (let i = m.elements.length - 1; i >= 0; i--) {
    const e = m.elements[i]!;
    if (e.kind === "chord") return { loc: { si: r.si, pi: r.pi, mi: r.mi, song, part, measure: m, chord: e, index: i }, dir, atEnd: true };
  }
  return null;
}

/** 挂点在声部里的先后：挂在第 `index` 个元素前为 `index`，挂在它之后（小节末）再加半格。 */
const dirPos = (loc: ChordLoc, atEnd: boolean): number => loc.mi * 1e6 + loc.index + (atEnd ? 0.5 : 0);

/** 把一条 `<direction>` 挂到 `to` 那个和弦前（可换小节）。 */
function placeDirection(from: Measure, dir: Direction, to: ChordLoc): void {
  from.directions = (from.directions ?? []).filter((d) => d !== dir);
  if (!from.directions.length) delete from.directions;
  dir.afterElements = to.index;
  delete dir.offset;
  const want = onsets(to.measure).get(to.chord) ?? 0;
  if (want === defaultOnsetBefore(to.measure, to.index)) delete dir.onset;
  else dir.onset = want;
  (to.measure.directions ??= []).push(dir);
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
  const refs = [r, ...(pair ? [pair] : [])];
  const anchors = refs.map((x) => dirAnchor(doc, x));
  if (anchors.some((x) => !x)) return { error: tr("me.noMark") };
  const targets: ChordLoc[] = [];
  for (const an of anchors as NonNullable<ReturnType<typeof dirAnchor>>[]) {
    let to: ChordLoc | null;
    if (byMeasure) {
      const mi = an.loc.mi + delta;
      const m = an.loc.part.measures[mi];
      if (!m) return { error: tr("me.noNeighbour") };
      const want = onsets(an.loc.measure).get(an.loc.chord) ?? 0;
      let best: ChordLoc | null = null;
      let bd = Infinity;
      const os = onsets(m);
      m.elements.forEach((e, i) => {
        if (e.kind !== "chord" || e.grace || e.voice !== an.loc.chord.voice) return;
        const d = Math.abs((os.get(e) ?? 0) - want);
        if (d < bd) (bd = d), (best = { ...an.loc, mi, measure: m, chord: e, index: i });
      });
      to = best;
    } else {
      // 挂在最后一个音之后的（小节末）：往后挪是挂到后面第 delta 个音前，往前挪一格是挂到最后那个音前
      const steps = an.atEnd && delta <= 0 ? delta + 1 : delta;
      to = steps === 0 ? an.loc : stepInVoice(an.loc, steps, (c) => !!c.grace);
    }
    if (!to) return { error: tr("me.noNeighbour") };
    targets.push(to);
  }
  // 挪完起点不能越过终点：整条挪时两端比；只挪一端时与另一端（`guard`）比
  if (pair && !before(targets[0]!, targets[1]!) && targets[0]!.chord !== targets[1]!.chord) return { error: tr("me.markCollapse") };
  if (guard) {
    const other = dirAnchor(doc, guard);
    const isStart = anchors[0]!.dir.spanType === "start";
    if (other) {
      const mine = dirPos(targets[0]!, false);
      const theirs = dirPos(other.loc, other.atEnd);
      if (isStart ? mine >= theirs : mine <= theirs) return { error: tr("me.markCollapse") };
    }
  }
  (anchors as NonNullable<ReturnType<typeof dirAnchor>>[]).forEach((an, k) => placeDirection(an.loc.measure, an.dir, targets[k]!));
  return { select: [targets[0]!.chord], moved: { markOn: targets[0]!.chord, kind: "dir", dirType: anchors[0]!.dir.type } };
}

/** 和弦名挪一个音（同声线，休止也能挂）；那个音已有和弦名就拒绝。 */
export function moveHarmony(doc: ScoreDoc, id: ElementId, delta: number): ModelEdit & { moved?: MovedMark } {
  const l = locate(doc, id);
  if (!l?.chord.harmony) return { error: tr("me.noMark") };
  const to = stepInVoice(l, delta, (c) => !!c.grace);
  if (!to) return { error: tr("me.noNeighbour") };
  if (to.chord.harmony) return { error: tr("me.harmonyTaken") };
  to.chord.harmony = l.chord.harmony;
  delete l.chord.harmony;
  delete to.chord.harmony.onset;
  delete to.chord.harmony.offset;
  return { select: [to.chord], moved: { markOn: to.chord, kind: "harmony" } };
}

/**
 * 歌词挪格（识别漏认 / 多认一个音，后面的字整串错开）：`delta` +1 = 在这个字前空出一格，这个字连同后面紧接着的字各往后挪一个音，
 * 挪到本段第一个空着的音为止（那一格吸收掉）；−1 = 前一个音空着时，这个字连同后面紧接着的字各往前挪一格。
 * 能配字的音 = 同声线、不是倚音；休止只在本来挂着字时算（同 `Chord.lyricAnchor` 的缺省）。
 * `count`：只挪从这个字起的几个字（选中了几个字时）；往后挪时紧挨着的下一格不空，照样顺次推到第一个空格为止。
 */
export function shiftLyrics(doc: ScoreDoc, id: ElementId, verse: number, delta: number, count?: number): ModelEdit & { moved?: MovedMark } {
  // 挪几格 = 一格一格挪（每一格都按「空一格 / 收一格」的口径，拖动一次跨几个音时与按几下 Alt+→ 一样）
  let at = id;
  let last: ModelEdit & { moved?: MovedMark } = { error: tr("me.noLyric") };
  for (let n = Math.abs(delta); n > 0; n--) {
    last = shiftLyricsOnce(doc, at, verse, delta > 0 ? 1 : -1, count);
    if (isEditError(last)) return last;
    if (last.moved && "lyricOf" in last.moved) at = last.moved.lyricOf.id;
  }
  return last;
}

function shiftLyricsOnce(doc: ScoreDoc, id: ElementId, verse: number, delta: number, count?: number): ModelEdit & { moved?: MovedMark } {
  const l = locate(doc, id);
  if (!l) return { error: tr("me.noNote") };
  const seq: Chord[] = [];
  for (const m of l.part.measures) {
    for (const e of m.elements) {
      if (e.kind !== "chord" || e.voice !== l.chord.voice || e.grace) continue;
      const anchor = e.lyricAnchor ?? (!e.rest || !!e.lyrics?.length);
      if (anchor) seq.push(e);
    }
  }
  const k = seq.indexOf(l.chord);
  const has = (c: Chord | undefined): boolean => !!c?.lyrics?.some((x) => x.number === verse);
  if (k < 0 || !has(l.chord)) return { error: tr("me.noLyric") };
  const take = (c: Chord): LyricOf => {
    const ly = c.lyrics!.find((x) => x.number === verse)!;
    c.lyrics = c.lyrics!.filter((x) => x !== ly);
    if (!c.lyrics.length) delete c.lyrics;
    return ly;
  };
  const put = (c: Chord, ly: LyricOf): void => {
    c.lyrics = [...(c.lyrics ?? []), ly].sort((a, b) => a.number - b.number);
  };
  // 从这个字起紧接着的一串（给了 `count` 就只取这几个；往后挪时再顺次推到空格）
  let j = k;
  const lim = count && count > 0 ? k + count - 1 : Infinity;
  while (j + 1 < seq.length && has(seq[j + 1]) && (j < lim || delta > 0)) j++;
  if (delta > 0) {
    if (j + 1 >= seq.length) return { error: tr("me.lyricNoRoom") };
    for (let i = j; i >= k; i--) put(seq[i + 1]!, take(seq[i]!));
    return { select: [seq[k + 1]!], moved: { lyricOf: seq[k + 1]!, verse } };
  }
  if (k === 0 || has(seq[k - 1])) return { error: tr("me.lyricNoRoom") };
  for (let i = k; i <= j; i++) put(seq[i - 1]!, take(seq[i]!));
  return { select: [seq[k - 1]!], moved: { lyricOf: seq[k - 1]!, verse } };
}

/** 倚音 ↔ 正音：倚音改成正音按它印的时值占拍；正音改成倚音不占拍（照印的时值，八分的带斜线）。 */
export function toggleGrace(doc: ScoreDoc, ids: readonly ElementId[], hooks: EditHooks = {}): ModelEdit {
  const locs = chordsOf(doc, ids).filter((l) => !l.chord.rest);
  if (locs.length === 0) return { error: tr("ve.selectNote") };
  const on = locs.every((l) => l.chord.grace);
  for (const l of locs) {
    const ch = l.chord;
    const { dpq } = measureCtx(l.song, l.part, l.mi);
    if (on) {
      delete ch.grace;
      const base = TYPES.find(([t]) => t === (ch.duration.type ?? "eighth"))?.[1] ?? 0.5;
      const div = fitDivisions(l.part, base * dpq * dotFactor(ch.duration.dots));
      ch.duration = { ...ch.duration, divisions: div };
    } else {
      ch.grace = ch.duration.type === "eighth" ? { slash: true } : {};
      if (!ch.duration.type) ch.duration = { ...ch.duration, type: "eighth" };
    }
    rebeam(l.measure, ch.voice, measureCtx(l.song, l.part, l.mi).time, measureCtx(l.song, l.part, l.mi).dpq);
    delete l.measure.duration;
  }
  for (const s of new Set(locs.map((l) => l.song))) hooks.forgetLayout?.(s);
  return { select: locs.map((l) => l.chord) };
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
  const a = locate(doc, firstId);
  const b = locate(doc, lastId);
  if (!a || !b) return { error: tr("me.noNote") };
  if (a.pi !== b.pi || !before(a, b)) return { error: tr("ve.slurTwo") };
  const isStart = (d: Direction): boolean => d.type === "wedge" && d.spanType !== "stop" && (d.afterElements ?? 0) === a.index;
  const cur = a.measure.directions?.find(isStart);
  if (cur) {
    a.measure.directions = a.measure.directions!.filter((d) => d !== cur);
    // 配对的终点：同声部往后第一条 wedge stop
    for (let mi = a.mi; mi < a.part.measures.length; mi++) {
      const m = a.part.measures[mi]!;
      const stop = m.directions?.find((d) => d.type === "wedge" && d.spanType === "stop" && (mi > a.mi || (d.afterElements ?? 0) >= a.index));
      if (stop) {
        m.directions = m.directions!.filter((d) => d !== stop);
        if (!m.directions.length) delete m.directions;
        break;
      }
    }
    if (!a.measure.directions?.length) delete a.measure.directions;
    if (cur.wedgeType === kind) return { select: [a.chord, b.chord] };
  }
  (a.measure.directions ??= []).push({ type: "wedge", spanType: "start", wedgeType: kind, afterElements: a.index, placement: "below", voice: a.chord.voice, staff: a.chord.staff });
  const stop: Direction = { type: "wedge", spanType: "stop", afterElements: b.index + 1, placement: "below", voice: b.chord.voice, staff: b.chord.staff };
  const endAt = (onsets(b.measure).get(b.chord) ?? 0) + b.chord.duration.divisions;
  if (endAt !== defaultOnsetBefore(b.measure, b.index + 1)) stop.onset = endAt;
  (b.measure.directions ??= []).push(stop);
  return { select: [a.chord, b.chord] };
}

/** 八度线（`<octave-shift>`）挪的八度数：8va / 15ma 实际比记谱高（down），8vb / 15mb 低（up）。 */
function octaveOf(d: Direction): number {
  const n = (d.shift?.size ?? 8) >= 15 ? 2 : 1;
  return d.shift?.dir === "up" ? -n : n;
}

/** 方向记号在小节里的游标（divisions）。 */
function dirOnset(m: Measure, d: Direction): number {
  return d.onset ?? defaultOnsetBefore(m, d.afterElements ?? 0);
}

/** 谱表 `staff` 上 `[from, to)`（小节下标 + 小节内游标）里的音实际音高挪 `oct` 个八度（符头不动）。 */
function shiftOctaveSpan(part: Part, staff: number, from: [number, number], to: [number, number], oct: number): void {
  for (let mi = from[0]; mi <= to[0] && mi < part.measures.length; mi++) {
    const m = part.measures[mi]!;
    const on = onsets(m);
    for (const e of m.elements) {
      if (e.kind !== "chord" || (e.staff ?? 1) !== staff) continue;
      const t = on.get(e) ?? 0;
      if ((mi === from[0] && t < from[1]) || (mi === to[0] && t >= to[1])) continue;
      for (const n of e.notes) if (n.pitch) n.pitch = { ...n.pitch, octave: n.pitch.octave + oct };
    }
  }
}

/** 一对八度线起止（`start`、`stop` 是那两条 direction 的位置）去掉前，范围里的音挪回记谱那个八度。 */
function undoOctaveShift(part: Part, start: DirRef, stop: DirRef): void {
  const ms = part.measures[start.mi]!, me = part.measures[stop.mi]!;
  const d = ms.directions![start.index]!;
  shiftOctaveSpan(part, d.staff ?? 1, [start.mi, dirOnset(ms, d)], [stop.mi, dirOnset(me, me.directions![stop.index]!)], -octaveOf(d));
}

/**
 * 选中的头尾两个音之间加 / 去一条八度线（`8va` 印在上方、`8vb` 在下方）。**符头留在谱面原位**：
 * 加 8va 等于说这段实际高一个八度，范围里本谱表的音音高跟着挪（识谱漏了八度线时就是这样纠正）；去掉时挪回。
 */
export function toggleOctaveShift(doc: ScoreDoc, firstId: ElementId, lastId: ElementId, kind: "8va" | "8vb"): ModelEdit {
  const a = locate(doc, firstId);
  const b = locate(doc, lastId);
  if (!a || !b) return { error: tr("me.noNote") };
  if (a.pi !== b.pi || !before(a, b)) return { error: tr("ve.slurTwo") };
  const staff = a.chord.staff ?? 1;
  // 第二声线等写了 onset 的和弦：起点照它的游标（不是前一个元素的终点）
  const at = onsets(a.measure).get(a.chord) ?? defaultOnsetBefore(a.measure, a.index);
  const ci = a.measure.directions?.findIndex((d) => d.type === "octave-shift" && d.spanType !== "stop" && (d.staff ?? 1) === staff && dirOnset(a.measure, d) === at) ?? -1;
  if (ci >= 0) {
    const r: DirRef = { si: a.si, pi: a.pi, mi: a.mi, index: ci };
    const cur = a.measure.directions![ci]!;
    const pair = dirPartner(doc, r);
    if (pair) undoOctaveShift(a.part, r, pair);
    const stop = pair ? a.part.measures[pair.mi]!.directions![pair.index]! : null;
    for (const m of a.part.measures) {
      if (!m.directions?.some((d) => d === cur || d === stop)) continue;
      m.directions = m.directions.filter((d) => d !== cur && d !== stop);
      if (!m.directions.length) delete m.directions;
    }
    if ((cur.shift?.dir === "up") === (kind === "8vb")) return { select: [a.chord, b.chord] };
  }
  const placement = kind === "8va" ? "above" : "below";
  const start: Direction = { type: "octave-shift", spanType: "start", shift: { dir: kind === "8va" ? "down" : "up", size: 8 }, afterElements: a.index, placement, staff };
  const stop: Direction = { type: "octave-shift", spanType: "stop", afterElements: b.index + 1, placement, staff };
  if (at !== defaultOnsetBefore(a.measure, a.index)) start.onset = at;
  const endAt = (onsets(b.measure).get(b.chord) ?? 0) + b.chord.duration.divisions;
  if (endAt !== defaultOnsetBefore(b.measure, b.index + 1)) stop.onset = endAt;
  (a.measure.directions ??= []).push(start);
  (b.measure.directions ??= []).push(stop);
  shiftOctaveSpan(a.part, staff, [a.mi, at], [b.mi, endAt], octaveOf(start));
  return { select: [a.chord, b.chord] };
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
  const l = locate(doc, id);
  if (!l) return { error: tr("me.noNote") };
  const n = { ...(l.chord.notations ?? {}) };
  if (name === "fermata" || name === "fermata-inverted") {
    delete n.fermata;
    delete n.fermataInverted;
  } else {
    for (const field of ["articulations", "ornaments", "technical"] as const) {
      const list = (n[field] ?? []).filter((a) => a !== name);
      if (list.length) n[field] = list;
      else delete n[field];
    }
  }
  if (Object.keys(n).length) l.chord.notations = n;
  else delete l.chord.notations;
  return { select: [l.chord] };
}

/** 删一条 `<direction>`（渐强渐弱这类成对的连配对那条一起删）。 */
export function deleteDirection(doc: ScoreDoc, r: DirRef): ModelEdit {
  const an = dirAnchor(doc, r);
  if (!an) return { error: tr("me.noMark") };
  const pair = dirPartner(doc, r);
  // 删八度线：符头不动，范围里的音挪回记谱那个八度（同 `toggleOctaveShift` 去掉时）
  if (an.dir.type === "octave-shift" && pair) {
    const [s, e] = an.dir.spanType === "stop" ? [pair, r] : [r, pair];
    undoOctaveShift(an.loc.part, s, e);
  }
  const gone = [an.dir, ...(pair ? [doc.songs[pair.si]!.parts[pair.pi]!.measures[pair.mi]!.directions![pair.index]!] : [])];
  for (const m of an.loc.part.measures) {
    if (!m.directions?.some((d) => gone.includes(d))) continue;
    m.directions = m.directions.filter((d) => !gone.includes(d));
    if (!m.directions.length) delete m.directions;
  }
  return { select: [an.loc.chord] };
}

/** 同一声部同一声线里前 / 后一个音（可跨小节，倚音不算；`skipRests` 时休止也跳过）。文本格式挪记号用它找邻居。 */
export function neighbourChord(doc: ScoreDoc, id: ElementId, delta: number, skipRests = false): Chord | null {
  const l = locate(doc, id);
  return l ? stepInVoice(l, delta, (c) => !!c.grace || (skipRests && !!c.rest))?.chord ?? null : null;
}

/** 在锚点处插一个**给定音高**的音（升降按那里的调号，印法重算）：Alt+点原图补漏识的音用（音高由点的位置定，不是唱名）。 */
export function insertPitch(doc: ScoreDoc, anchor: InsertAnchor, pitch: { step: Pitch["step"]; octave: number }, dur: NewDuration, hooks: EditHooks = {}): ModelEdit {
  const r = insertChord(doc, anchor, 1, dur, hooks);
  if (isEditError(r)) return r;
  const ch = "caretAfter" in r ? r.caretAfter : "select" in r ? r.select[0] : "caretBefore" in r ? r.caretBefore : undefined;
  const l = ch ? locate(doc, ch.id) : null;
  if (!l) return r;
  const { key } = measureCtx(l.song, l.part, l.mi);
  l.chord.notes = [{ pitch: { step: pitch.step, octave: pitch.octave, alter: keyAlter(pitch.step, key.fifths) } }];
  delete l.chord.rest;
  respellMeasure(l.measure, key);
  hooks.forgetStem?.(l.chord);
  return { select: [l.chord] };
}

/** 和弦现在的时值换成「新音」的写法（减半次数 + 附点）：Alt+点补音时照选中的那个音的时值。 */
export function newDurationOf(ch: Chord): NewDuration {
  const H: Partial<Record<NoteType, number>> = { whole: -2, half: -1, quarter: 0, eighth: 1, "16th": 2, "32nd": 3, "64th": 4 };
  return { halvings: H[ch.duration.type ?? "quarter"] ?? 0, dots: ch.duration.dots };
}
