// 声部（part）的增删改：声部面板（`editor/parts.ts`）调它。纯模型、不碰 DOM。
//
// 参照打谱软件的做法：MuseScore「乐器」面板（增删、上下移、改名、Explode / Implode 拆合声部）、
// Sibelius「Arrange / Reduce」、Dorico「演奏者」。合唱谱常见的是**闭合谱**——一行谱两个声部（S/A 共用高音谱表、
// T/B 共用低音谱表），写成两个声线或和弦的上下音；拆成开放谱（每部一行）、或反过来合成闭合谱，是校谱时最常做的两件事。
//
// 改的都是传进来的那份模型（调用方先读一份新的，`.musicxml` 改完整份重写，123/ABC 改完整份重出）。
// 增删拆合这几样在 Rust（crates/dolce-model/src/parts.rs，经 `EditCmd`）；视图与几个只读查询留在这里给 TS 排版用（随排版迁 Rust 再删）。

import type { Clef, Part, ScoreDoc, Transpose } from "./doc";
import { applyEditCmd } from "./edit";
import { dolce } from "../common/dolce";
import { adopt, call, docJson } from "./rustdoc";

/** 在 Rust 里执行一个声部动作（`EditCmd`），回它的数值结果（新声部下标 / 成否 / 抄了几个字）。 */
function num(doc: ScoreDoc, cmd: object): number {
  const r = applyEditCmd(doc, cmd);
  return "number" in r ? r.number : -1;
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
  // 抄词在 Rust 里做（`copyLyrics` 同一份），整份回来；目标声部是复制出来的（表层身份不带），其余对象身份照旧
  const { json, s } = docJson(doc);
  const r = call(() => dolce().modelWithLyricsFrom(json, from, to));
  if (r === "null") return doc;
  const out = adopt<ScoreDoc>(r, s);
  if (doc.source !== undefined) out.source = doc.source;
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

export function setPartProps(doc: ScoreDoc, si: number, pi: number, p: PartProps): void {
  applyEditCmd(doc, { op: "setPartProps", si, pi, props: p });
}

// ───────────────────────── 增删排 ─────────────────────────

/** 新建一个声部：每小节一个整小节休止，小节结构（拍号、调号、小节线、换行）照第一声部。插在 `at`（缺省最后）。 */
export function addPart(doc: ScoreDoc, si: number, props: PartProps & { at?: number } = {}): number {
  return num(doc, { op: "addPart", si, props: { ...props, at: undefined }, at: props.at });
}

/** 复制一个声部（新 id，弧与延音线跟着复制），插在它后面。 */
export function duplicatePart(doc: ScoreDoc, si: number, pi: number): number {
  return num(doc, { op: "duplicatePart", si, pi });
}

/** 删一个声部（至少留一个）。删的是第一声部时，挂在它小节上的速度、跳转等文字记号挪给新的第一声部。 */
export function deletePart(doc: ScoreDoc, si: number, pi: number): boolean {
  return num(doc, { op: "deletePart", si, pi }) === 1;
}

/** 把第 `from` 声部挪到第 `to` 位。 */
export function movePart(doc: ScoreDoc, si: number, from: number, to: number): boolean {
  return num(doc, { op: "movePart", si, from, to }) === 1;
}

// ───────────────────────── 拆与合 ─────────────────────────

/**
 * 按声线拆：第 2 条及以后的声线挪到新声部（插在它后面），两边都成单声线。闭合谱「两个声线一行谱」拆成开放谱用这个。
 * 某小节新声部里没有音的补整小节休止；声线一开头有空当的，新声部里照原起点（写显式起点，写出端补 `<forward>`）。
 */
export function splitByVoice(doc: ScoreDoc, si: number, pi: number, props: PartProps = {}): number {
  return num(doc, { op: "splitByVoice", si, pi, props });
}

/**
 * 按和弦上下音拆：和弦里最低的那个音挪到新声部（同起点同时值），上面的留下；单音（两部同度）两边各一份，休止两边各一份。
 * 闭合谱「上下两个音共一根符干」（S/A 写成和弦）拆成开放谱用这个。只看第一声线。
 */
export function splitByChord(doc: ScoreDoc, si: number, pi: number, props: PartProps = {}): number {
  return num(doc, { op: "splitByChord", si, pi, props });
}

/** 合：第 `pj` 声部并进第 `pi` 声部当第二声线（小节数要一样），然后删掉第 `pj` 声部。开放谱合成闭合谱用这个。 */
export function mergeInto(doc: ScoreDoc, si: number, pi: number, pj: number): boolean {
  return num(doc, { op: "mergeInto", si, pi, pj }) === 1;
}

/** 歌词复制：第 `from` 声部的歌词按同一时刻抄给第 `to` 声部（目标那个音已有这一段的不覆盖）。SATB 中间一排词供几部共用时用。 */
export function copyLyrics(doc: ScoreDoc, si: number, from: number, to: number): number {
  return num(doc, { op: "copyLyrics", si, from, to });
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
