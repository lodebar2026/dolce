// 声部（part）的增删改：声部面板（`editor/parts.ts`）调它。纯模型、不碰 DOM。
//
// 参照打谱软件的做法：MuseScore「乐器」面板（增删、上下移、改名、Explode / Implode 拆合声部）、
// Sibelius「Arrange / Reduce」、Dorico「演奏者」。合唱谱常见的是**闭合谱**——一行谱两个声部（S/A 共用高音谱表、
// T/B 共用低音谱表），写成两个声线或和弦的上下音；拆成开放谱（每部一行）、或反过来合成闭合谱，是校谱时最常做的两件事。
//
// 改的都是传进来的那份模型（调用方先读一份新的，`.musicxml` 改完整份重写，123/ABC 改完整份重出）。

import type { Chord, Clef, Element, ElementId, Lyric, Mark, Measure, Part, ScoreDoc, Song, Transpose } from "./doc";
import { SIMPLE_DIVISIONS } from "./doc";
import { msg, msgText } from "./msg";

// ───────────────────────── 小工具 ─────────────────────────

function maxId(doc: ScoreDoc): number {
  let max = 0;
  for (const s of doc.songs) for (const p of s.parts) for (const m of p.measures) for (const e of m.elements) max = Math.max(max, e.id);
  return max;
}

function newPartId(song: Song): string {
  const used = new Set(song.parts.map((p) => p.id));
  let n = song.parts.length + 1;
  while (used.has(`P${n}`)) n++;
  return `P${n}`;
}

/** 某小节处生效的 divisions 与拍号（按第一声部算小节长）。 */
function ctxAt(part: Part, mi: number): { dpq: number; beats: number; beatType: number } {
  let dpq = SIMPLE_DIVISIONS;
  let beats = 4;
  let beatType = 4;
  for (let i = 0; i <= mi && i < part.measures.length; i++) {
    const a = part.measures[i]!.attrs;
    if (a?.divisions) dpq = a.divisions;
    if (a?.time) (beats = a.time.beats), (beatType = a.time.beatType);
  }
  return { dpq, beats, beatType };
}

/** 小节实际长度（各声线终点的最大值）。 */
function lengthOf(m: Measure): number {
  let len = m.duration ?? 0;
  const at = new Map<number, number>();
  for (const el of m.elements) {
    const start = (el.kind === "chord" ? el.onset : undefined) ?? at.get(el.voice) ?? 0;
    const d = el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : (el.duration?.divisions ?? 0);
    at.set(el.voice, start + d);
    len = Math.max(len, start + d);
  }
  return len;
}

function onsetsOf(m: Measure): Map<Element, number> {
  const out = new Map<Element, number>();
  const at = new Map<number, number>();
  for (const el of m.elements) {
    const start = (el.kind === "chord" ? el.onset : undefined) ?? at.get(el.voice) ?? 0;
    const d = el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : (el.duration?.divisions ?? 0);
    at.set(el.voice, start + d);
    out.set(el, start);
  }
  return out;
}

/** 整小节休止。MusicXML 形状（首小节带 `divisions`）写一个整小节休止；简谱形状（123/ABC）没有「整小节休止」这个写法，按拍各写一个四分休止。 */
function restChords(part: Part, mi: number, nextId: () => ElementId, len: number): Chord[] {
  const xml = part.measures[0]?.attrs?.divisions !== undefined;
  if (xml) return [{ kind: "chord", id: nextId(), notes: [], rest: { measure: true }, duration: { divisions: len, dots: 0, type: "whole" }, voice: 1, staff: 1 }];
  const { dpq } = ctxAt(part, mi);
  const n = Math.max(1, Math.round(len / dpq));
  return Array.from({ length: n }, () => ({ kind: "chord" as const, id: nextId(), notes: [], rest: {}, duration: { divisions: dpq, dots: 0, type: "quarter" as const }, voice: 1, staff: 1 }));
}

/** 新声部的小节骨架：小节号、拍号调号 divisions 照第一声部，谱号另给；小节线（反复、房号）各声部都要有，照抄。 */
function skeleton(ref: Measure, clef: Clef | undefined, first: boolean): Measure {
  const m: Measure = { number: ref.number, elements: [] };
  if (ref.implicit) m.implicit = true;
  if (ref.attrs) {
    const a = { ...ref.attrs };
    delete a.clefs;
    delete a.staves;
    if (first && clef) a.clefs = [clef];
    if (Object.keys(a).length) m.attrs = a;
  } else if (first && clef) m.attrs = { clefs: [clef] };
  if (ref.barlines) m.barlines = ref.barlines.map((b) => ({ ...b }));
  if (ref.print?.newSystem || ref.print?.newPage) m.print = { ...(ref.print.newSystem ? { newSystem: true } : {}), ...(ref.print.newPage ? { newPage: true } : {}) };
  return m;
}

// ───────────────────────── 属性 ─────────────────────────

export interface PartProps {
  name?: string;
  abbrev?: string;
  /** `treble` / `treble-8`（男高音）/ `bass` / `alto` / `tenor` */
  clef?: ClefName;
  /** 移调乐器（`<transpose>`，记谱比实际高多少）；null = 去掉。只 MusicXML 写得出 */
  transpose?: Transpose | null;
}

/** 声部面板「移调」一栏的选项：记谱 → 实际发声（MusicXML `<transpose>` 的 diatonic / chromatic / octave-change）。 */
export const TRANSPOSE_PRESETS: readonly { key: string; label: string; t: Transpose | null }[] = [
  { key: "none", label: "不移调", t: null },
  { key: "Bb", label: "B♭ 调（单簧管、小号：实际低大二度）", t: { diatonic: -1, chromatic: -2 } },
  { key: "A", label: "A 调（实际低小三度）", t: { diatonic: -2, chromatic: -3 } },
  { key: "F", label: "F 调（圆号：实际低纯五度）", t: { diatonic: -4, chromatic: -7 } },
  { key: "Eb", label: "E♭ 调（中音萨克斯：实际低大六度）", t: { diatonic: -5, chromatic: -9 } },
  { key: "8vb", label: "低八度发声（记谱高八度）", t: { diatonic: 0, chromatic: 0, octaveChange: -1 } },
  { key: "8va", label: "高八度发声（短笛、钢片琴）", t: { diatonic: 0, chromatic: 0, octaveChange: 1 } },
];

/** 声部现在的移调对应哪个选项（对不上任何一个为 `other`）。 */
export function transposeKeyOf(part: Part): string {
  const t = part.measures[0]?.attrs?.transpose;
  if (!t) return "none";
  const hit = TRANSPOSE_PRESETS.find((p) => p.t && p.t.chromatic === t.chromatic && (p.t.octaveChange ?? 0) === (t.octaveChange ?? 0));
  return hit?.key ?? "other";
}

/** 这个声部用几行谱（`<staves>`，钢琴等大谱表为 2）。 */
export function stavesOf(part: Part): number {
  let n = 1;
  for (const m of part.measures) if (m.attrs?.staves) n = Math.max(n, m.attrs.staves);
  return n;
}

/** 视图用：五线谱 / 混排里藏起来的声部去掉（浅拷贝，元素 id 不变；起止落在藏起来的声部里的记号一起去掉）。 */
export function withVisibleParts(doc: ScoreDoc, hidden: ReadonlySet<number>): ScoreDoc {
  if (!hidden.size) return doc;
  return {
    ...doc,
    songs: doc.songs.map((s) => {
      const parts = s.parts.filter((_, i) => !hidden.has(i));
      if (!parts.length || parts.length === s.parts.length) return s;
      const ids = new Set<number>();
      for (const p of parts) for (const m of p.measures) for (const e of m.elements) ids.add(e.id);
      return { ...s, parts, marks: s.marks.filter((mk) => ids.has(mk.start) && ids.has(mk.end)) };
    }),
  };
}

/** 视图用：简谱档的歌词改取第 `from` 声部的（合唱谱词常印在女低音下面）。深拷贝第 `to` 声部、清掉它的词再按时刻抄过来。 */
export function withLyricsFrom(doc: ScoreDoc, from: number, to: number): ScoreDoc {
  if (from === to) return doc;
  const out: ScoreDoc = { ...doc, songs: doc.songs.map((s) => ({ ...s, parts: [...s.parts] })) };
  out.songs.forEach((s, si) => {
    const target = s.parts[to];
    if (!target || !s.parts[from]) return;
    const copy = structuredClone(target);
    for (const m of copy.measures) for (const e of m.elements) if (e.kind === "chord") delete e.lyrics;
    s.parts[to] = copy;
    copyLyrics(out, si, from, to);
  });
  return out;
}

export type ClefName = "treble" | "treble-8" | "bass" | "alto" | "tenor";

export const CLEF_LABEL: Record<ClefName, string> = {
  treble: "高音谱号", "treble-8": "高音谱号（低八度，男高音）", bass: "低音谱号", alto: "中音谱号", tenor: "次中音谱号",
};

export function clefOf(name: ClefName): Clef {
  switch (name) {
    case "treble": return { sign: "G", line: 2 };
    case "treble-8": return { sign: "G", line: 2, octaveChange: -1 };
    case "bass": return { sign: "F", line: 4 };
    case "alto": return { sign: "C", line: 3 };
    case "tenor": return { sign: "C", line: 4 };
  }
}

/** 声部开头的谱号叫什么（读不出来按高音谱号）。 */
export function clefNameOf(part: Part): ClefName {
  const c = part.measures[0]?.attrs?.clefs?.[0];
  if (!c) return "treble";
  if (c.sign === "F") return "bass";
  if (c.sign === "C") return c.line === 4 ? "tenor" : "alto";
  return c.octaveChange === -1 ? "treble-8" : "treble";
}

export function setPartProps(song: Song, pi: number, p: PartProps): void {
  const part = song.parts[pi];
  if (!part) return;
  if (p.name !== undefined) part.name = p.name;
  if (p.abbrev !== undefined) part.abbrev = p.abbrev || undefined;
  if (p.transpose !== undefined) {
    const m0 = part.measures[0];
    if (m0) {
      const a = { ...(m0.attrs ?? {}) };
      if (p.transpose) a.transpose = p.transpose;
      else delete a.transpose;
      m0.attrs = a;
    }
  }
  if (p.clef !== undefined && p.clef !== clefNameOf(part)) {
    const m0 = part.measures[0];
    if (m0) {
      const others = (m0.attrs?.clefs ?? []).filter((c) => (c.staff ?? 1) !== 1);
      m0.attrs = { ...(m0.attrs ?? {}), clefs: [clefOf(p.clef), ...others] };
    }
  }
}

// ───────────────────────── 增删排 ─────────────────────────

/** 新建一个声部：每小节一个整小节休止，小节结构（拍号、调号、小节线、换行）照第一声部。插在 `at`（缺省最后）。 */
export function addPart(doc: ScoreDoc, si: number, props: PartProps & { at?: number } = {}): number {
  const song = doc.songs[si];
  const ref = song?.parts[0];
  if (!song || !ref) return -1;
  let id = maxId(doc);
  const part: Part = { id: newPartId(song), name: props.name ?? msgText(msg("parts.defaultName", { n: song.parts.length + 1 })), measures: [] };
  if (props.abbrev) part.abbrev = props.abbrev;
  const clef = clefOf(props.clef ?? "treble");
  ref.measures.forEach((rm, mi) => {
    const m = skeleton(rm, clef, mi === 0);
    const len = lengthOf(rm) || (() => {
      const c = ctxAt(ref, mi);
      return (c.dpq * 4 * c.beats) / c.beatType;
    })();
    m.elements = restChords(ref, mi, () => ++id, len);
    part.measures.push(m);
  });
  const at = props.at === undefined ? song.parts.length : Math.max(0, Math.min(props.at, song.parts.length));
  song.parts.splice(at, 0, part);
  return at;
}

/** 复制一个声部（新 id，弧与延音线跟着复制），插在它后面。 */
export function duplicatePart(doc: ScoreDoc, si: number, pi: number): number {
  const song = doc.songs[si];
  const src = song?.parts[pi];
  if (!song || !src) return -1;
  let id = maxId(doc);
  const map = new Map<ElementId, ElementId>();
  const copy: Part = JSON.parse(JSON.stringify(src)) as Part;
  copy.id = newPartId(song);
  copy.name = msgText(msg("parts.copyName", { name: src.name ?? msg("parts.title") }));
  for (const m of copy.measures) {
    for (const e of m.elements) {
      const nid = ++id;
      map.set(e.id, nid);
      e.id = nid;
    }
  }
  const marks: Mark[] = [];
  for (const mk of song.marks) {
    const s = map.get(mk.start);
    const e = map.get(mk.end);
    if (s !== undefined && e !== undefined) marks.push({ ...mk, start: s, end: e });
  }
  song.marks.push(...marks);
  song.parts.splice(pi + 1, 0, copy);
  return pi + 1;
}

/** 删一个声部（至少留一个）。删的是第一声部时，挂在它小节上的速度、跳转等文字记号挪给新的第一声部。 */
export function deletePart(doc: ScoreDoc, si: number, pi: number): boolean {
  const song = doc.songs[si];
  if (!song || song.parts.length < 2 || !song.parts[pi]) return false;
  const gone = song.parts[pi]!;
  const ids = new Set<ElementId>();
  for (const m of gone.measures) for (const e of m.elements) ids.add(e.id);
  song.marks = song.marks.filter((m) => !ids.has(m.start) && !ids.has(m.end));
  song.parts.splice(pi, 1);
  if (pi === 0) {
    const next = song.parts[0]!;
    gone.measures.forEach((m, mi) => {
      const keep = (m.directions ?? []).filter((d) => d.type === "metronome" || d.type === "segno" || d.type === "coda" || (d.type === "words" && d.sound));
      const t = next.measures[mi];
      if (t && keep.length) t.directions = [...(t.directions ?? []), ...keep];
    });
  }
  return true;
}

/** 把第 `from` 声部挪到第 `to` 位。 */
export function movePart(doc: ScoreDoc, si: number, from: number, to: number): boolean {
  const song = doc.songs[si];
  if (!song || !song.parts[from] || to < 0 || to >= song.parts.length || from === to) return false;
  const [p] = song.parts.splice(from, 1);
  song.parts.splice(to, 0, p!);
  return true;
}

// ───────────────────────── 拆与合 ─────────────────────────

/**
 * 按声线拆：第 2 条及以后的声线挪到新声部（插在它后面），两边都成单声线。闭合谱「两个声线一行谱」拆成开放谱用这个。
 * 某小节新声部里没有音的补整小节休止；声线一开头有空当的，新声部里照原起点（写显式起点，写出端补 `<forward>`）。
 */
export function splitByVoice(doc: ScoreDoc, si: number, pi: number, props: PartProps = {}): number {
  const song = doc.songs[si];
  const src = song?.parts[pi];
  if (!song || !src) return -1;
  if (!src.measures.some((m) => m.elements.some((e) => e.voice > 1))) return -1;
  let id = maxId(doc);
  const part: Part = { id: newPartId(song), name: props.name ?? `${src.name ?? msgText(msg("parts.title"))} 2`, measures: [] };
  const clef = props.clef ? clefOf(props.clef) : src.measures[0]?.attrs?.clefs?.[0];
  src.measures.forEach((m, mi) => {
    const nm = skeleton(m, clef, mi === 0);
    const on = onsetsOf(m);
    const moved = m.elements.filter((e) => e.voice > 1);
    m.elements = m.elements.filter((e) => e.voice <= 1);
    // 留下的第一声线从小节头接着排：显式起点只在与前一个音之间有空当时保留
    let at = 0;
    for (const e of m.elements) {
      const st = on.get(e) ?? at;
      if (e.kind === "chord") {
        if (st !== at) e.onset = st;
        else delete e.onset;
      }
      at = st + (e.kind === "chord" ? (e.grace ? 0 : e.duration.divisions) : (e.duration?.divisions ?? 0));
    }
    // 挪过去的只留第一条声线（第 3、4 条声线照样并进来，各自显式起点）
    let at2 = 0;
    const firstVoice = moved[0]?.voice;
    for (const e of moved) {
      const st = on.get(e) ?? at2;
      if (e.kind === "chord") {
        if (st !== at2 || e.voice !== firstVoice) e.onset = st;
        else delete e.onset;
      }
      e.voice = e.voice === firstVoice ? 1 : e.voice - 1;
      at2 = st + (e.kind === "chord" ? (e.grace ? 0 : e.duration.divisions) : (e.duration?.divisions ?? 0));
    }
    nm.elements = moved.length ? moved : restChords(src, mi, () => ++id, lengthOf(m));
    part.measures.push(nm);
  });
  song.parts.splice(pi + 1, 0, part);
  return pi + 1;
}

/**
 * 按和弦上下音拆：和弦里最低的那个音挪到新声部（同起点同时值），上面的留下；单音（两部同度）两边各一份，休止两边各一份。
 * 闭合谱「上下两个音共一根符干」（S/A 写成和弦）拆成开放谱用这个。只看第一声线。
 */
export function splitByChord(doc: ScoreDoc, si: number, pi: number, props: PartProps = {}): number {
  const song = doc.songs[si];
  const src = song?.parts[pi];
  if (!song || !src) return -1;
  if (!src.measures.some((m) => m.elements.some((e) => e.kind === "chord" && e.notes.length > 1))) return -1;
  let id = maxId(doc);
  const part: Part = { id: newPartId(song), name: props.name ?? `${src.name ?? msgText(msg("parts.title"))} 2`, measures: [] };
  const clef = props.clef ? clefOf(props.clef) : src.measures[0]?.attrs?.clefs?.[0];
  const midi = (n: Chord["notes"][number]): number => (n.pitch ? (n.pitch.octave + 1) * 12 + "C D EF G A B".indexOf(n.pitch.step) + n.pitch.alter : 0);
  src.measures.forEach((m, mi) => {
    const nm = skeleton(m, clef, mi === 0);
    for (const e of m.elements) {
      if (e.voice !== 1 || e.kind !== "chord") continue;
      const copy: Chord = { ...e, id: ++id, notes: [], voice: 1 };
      delete copy.lyrics;
      delete copy.harmony;
      delete copy.laterHarmonies;
      delete copy.attachedSources;
      delete copy.source;
      if (e.notes.length > 1) {
        let low = 0;
        e.notes.forEach((n, k) => {
          if (midi(n) < midi(e.notes[low]!)) low = k;
        });
        copy.notes = [e.notes[low]!];
        e.notes = e.notes.filter((_, k) => k !== low);
      } else {
        copy.notes = e.notes.map((n) => ({ ...n }));
      }
      nm.elements.push(copy);
    }
    if (!nm.elements.length) nm.elements = restChords(src, mi, () => ++id, lengthOf(m));
    part.measures.push(nm);
  });
  song.parts.splice(pi + 1, 0, part);
  return pi + 1;
}

/** 合：第 `pj` 声部并进第 `pi` 声部当第二声线（小节数要一样），然后删掉第 `pj` 声部。开放谱合成闭合谱用这个。 */
export function mergeInto(doc: ScoreDoc, si: number, pi: number, pj: number): boolean {
  const song = doc.songs[si];
  const a = song?.parts[pi];
  const b = song?.parts[pj];
  if (!song || !a || !b || pi === pj || a.measures.length !== b.measures.length) return false;
  const v = Math.max(1, ...a.measures.flatMap((m) => m.elements.map((e) => e.voice))) + 1;
  a.measures.forEach((m, mi) => {
    const bm = b.measures[mi]!;
    const on = onsetsOf(bm);
    let first = true;
    for (const e of bm.elements) {
      if (e.kind === "chord" && e.rest?.measure && bm.elements.length === 1) continue; // 整小节休止不并
      if (e.kind === "chord") e.onset = first ? on.get(e) ?? 0 : on.get(e);
      first = false;
      e.voice = v + e.voice - 1;
      m.elements.push(e);
    }
  });
  song.parts.splice(pj, 1);
  return true;
}

/** 歌词复制：第 `from` 声部的歌词按同一时刻抄给第 `to` 声部（目标那个音已有这一段的不覆盖）。SATB 中间一排词供几部共用时用。 */
export function copyLyrics(doc: ScoreDoc, si: number, from: number, to: number): number {
  const song = doc.songs[si];
  const a = song?.parts[from];
  const b = song?.parts[to];
  if (!song || !a || !b) return 0;
  let n = 0;
  a.measures.forEach((m, mi) => {
    const bm = b.measures[mi];
    if (!bm) return;
    const onA = onsetsOf(m);
    const onB = onsetsOf(bm);
    const byTime = new Map<number, Chord>();
    for (const e of bm.elements) if (e.kind === "chord" && !e.rest && !e.grace && e.voice === 1) {
      const t = onB.get(e) ?? 0;
      if (!byTime.has(t)) byTime.set(t, e);
    }
    for (const e of m.elements) {
      if (e.kind !== "chord" || !e.lyrics?.length) continue;
      const t = byTime.get(onA.get(e) ?? -1);
      if (!t) continue;
      for (const ly of e.lyrics) {
        if (t.lyrics?.some((x) => x.number === ly.number)) continue;
        t.lyrics = [...(t.lyrics ?? []), { ...(ly as Lyric) }].sort((x, y) => x.number - y.number);
        n++;
      }
    }
  });
  return n;
}

/** 视图用：第 `pi` 声部挪到最前（简谱档只排第一声部，「简谱旋律取自」选了别的声部时用）。浅拷贝，不改原模型，元素 id 不变。 */
export function withMelodyFirst(doc: ScoreDoc, pi: number): ScoreDoc {
  if (pi <= 0) return doc;
  return {
    ...doc,
    songs: doc.songs.map((s) => {
      if (!s.parts[pi]) return s;
      const parts = [...s.parts];
      const [p] = parts.splice(pi, 1);
      return { ...s, parts: [p!, ...parts] };
    }),
  };
}
