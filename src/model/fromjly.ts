// jianpu-ly 的**词法与装配**（路线 B：独立实现，不塞进 `abcfamily` 家族）。
//
// 目标语法 = 上游 https://github.com/ssb22/jianpu-ly 的 README（v1.890），**不是 jianpu-db 语料的方言**。
// 与 dolce 的 123 方言（`abcfamily/dialect123.ts`）的三处关键差异：
//   ① **词内顺序无关** —— `#1`=`1#`、`'1`=`1'`、**`s1`=`1s`**（上游 README 原话）；
//      123 的扫描器是严格 `[变音][数字][八度][时值]`，照它读不了 jianpu-ly。
//   ② **时值是字母** —— `s`=16分、`q`=8分、无字母=4分、`d`=32分、`h`=64分；123 用 `_` 减时线。
//      另有 `\` / `\\` 替代写法（README：**必须写在音高之后**）。
//   ③ **连音是 `3[ … ]`** —— 方括号成组；123 是 `(3: … )`、ABC 是 `(3`，都不是这个形状
//      （且 `[` 在 ABC 家族里已被和弦 / 行内字段占用）。
//
// 模型口径（照 `j123/parse.ts` 的权威写法）：
//   八度进 `Degree { number, octaveShift }`；减时线条数 = `Chord.beams` 数组长度；
//   增时线既要**加成时值**、又要**挂独立 `Sustain` 对象**；连音写 `Duration.timeMod`。
//
// **位置信息（`SourceSpan`）是必需品**，不是可选项：编辑器的双向定位（代码区光标 ↔ 谱面元素）、
// 诊断的落点（`Diagnostic.source` 必填）、以及"改过才整份重写、没改过存回原文"的保存策略都靠它。
// 每个 token 都带 0 基的行号 / 行内列 / 全文偏移 / 长度，一路落到 `Chord` / `Sustain` / `Measure` / `Lyric`。
//
// 本版**不收**的写法一律走 `JlyLosses` → `doc.diagnostics` 报出（dolce 现成的机制），**不静默丢**。

import {
  SIMPLE_DIVISIONS,
  type Barline,
  type Chord,
  type Diagnostic,
  type Lyric,
  type Measure,
  type Note,
  type ScoreDoc,
  type SourceSpan,
} from "./doc";
import { emptyDoc, emptySong, IdGen } from "./helpers";
import { BARE_DIRECTION } from "./tojly";
import { DYNAMICS } from "../pu/glyph";
import { lyPitchToText, lySuffixToText, parseChordToken } from "./jlychords";

// ───────────────────────── 词法 ─────────────────────────

/** 一个音符 token。`beams` 是**减时线条数**（0 = 四分），与 dolce 模型同一口径。 */
export interface JlyNote {
  kind: "note";
  /** 1–7；`0` 是休止 */
  degree: number;
  /** 变音：`#` / `b` / `n` / `##` / `bb` / 空 */
  alter: string;
  /** 八度点数：`'` 加一、`,` 减一 */
  octave: number;
  beams: number;
  dots: number;
  /** **多音和弦**里第 2…n 个音（第 1 个就是上面那组字段）。
   *  上游写法见 README「简单和弦：`,135'`」——八度/变音记号**逐音贴在各数字后面**
   *  （实测真 jianpu-ly：`,135` → LilyPond `<c e' g'>`，即 `1` 低一个八度、`3`/`5` 在基准八度）。
   *  ⚠ 以前这里只认单音，于是写出端自己的和弦产物 `,135` 落到 `unknown` 里被静默丢掉。 */
  chord?: JlyChordNote[];
}

/** 和弦里除第一个音以外的音（字段与 `JlyGraceNote` 同形）。 */
export interface JlyChordNote {
  degree: number;
  alter: string;
  octave: number;
  dots: number;
  beams: number;
}

export type JlyToken =
  | JlyNote
  | { kind: "sustain" }
  | { kind: "bar" }
  | { kind: "tie" }
  | { kind: "slur-open"; melisma: boolean } | { kind: "slur-close"; melisma: boolean }
  | { kind: "tuplet-open"; n: number } | { kind: "tuplet-close" }
  | { kind: "text"; above: boolean; value: string }
  | { kind: "jump"; text: string }
  | { kind: "dynamic"; name: string }
  | { kind: "fermata" }
  | { kind: "grace"; notes: JlyGraceNote[] }
  | { kind: "repeat-open" } | { kind: "alt-open" } | { kind: "repeat-close" }
  | { kind: "percent-open"; times: number }
  | { kind: "multirest"; n: number }
  | { kind: "break"; page: boolean }
  | { kind: "barstyle"; style: string }
  | { kind: "header"; key: string; value: string }
  | { kind: "loss"; what: string };

/** 一个倚音（`g[#45]` 里的一个音）：时值字母可选（未记按八分画一条减时线），八度与附点照音符那一套。 */
export interface JlyGraceNote {
  degree: number;
  alter: string;
  octave: number;
  dots: number;
  beams: number;
}

/** 一个 token 在**本行**里的列号与长度（0 基）。 */
export interface JlyPos { col: number; len: number }

const LETTER_BEAMS: Readonly<Record<string, number>> = { q: 1, s: 2, d: 3, h: 4 };

/** 力度指令：从 `pu/glyph.ts::DYNAMICS` 的名字表长出来（别另抄一份名字，两处会漂）。 */
const DYNAMIC_COMMAND = new RegExp("^\\\\(?:" + Object.keys(DYNAMICS).join("|") + ")$");

/** 跳转记号写成规范形（`dc` → `D.C.`、`ds` → `D.S.`）：写出端的 `BARE_DIRECTION` 认这几个词。 */
const JUMP_CANON: Readonly<Record<string, string>> = {
  fine: "Fine", dc: "D.C.", "d.c.": "D.C.", ds: "D.S.", "d.s.": "D.S.",
  segno: "Segno", tocoda: "ToCoda",
};
const canonicalJump = (word: string): string => JUMP_CANON[word.toLowerCase()] ?? word;

/** 规范词 → 123/文本谱那套短名（`abcfamily/jumpmarks.ts::BARLINE_ORNAMENT_NAME` 的反向）。
 *  跳转记号在模型里是 `Barline.ornaments` 上的短名，与 123 的 `!fine!` 同一个落点。 */
const JUMP_SHORT: Readonly<Record<string, string>> = {
  Fine: "fine", "D.C.": "dc", "D.S.": "ds", Segno: "hs", ToCoda: "ty",
};
/** 深拷贝出来的副本要换掉所有 `id`（`ElementId` 全曲唯一；同一号会让编辑器把副本认成原件）。 */
function freshIds<T>(obj: T, ids: IdGen): T {
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const it of v) walk(it); return; }
    const rec = v as Record<string, unknown>;
    if (typeof rec.id === "number") rec.id = ids.next();
    for (const k of Object.keys(rec)) if (k !== "id") walk(rec[k]);
  };
  walk(obj);
  return obj;
}
const ACC: Readonly<Record<string, string>> = {  "#": "sharp", b: "flat", n: "natural", "##": "double-sharp", bb: "double-flat",
};

/** 拿不到位置时的兜底 span（只用于诊断，不参与定位）。 */
const ZERO_SPAN: SourceSpan = { line: 0, column: 0, offset: 0, length: 0 };

/** 报告册：同一类问题只记一次（附原文例子与首个落点）；既能给导出路径当注释，也能变成诊断。 */
export class JlyLosses {
  private readonly seen = new Map<string, { raw: string; span?: SourceSpan }>();
  add(what: string, raw: string, span?: SourceSpan): void {
    if (!this.seen.has(what)) this.seen.set(what, { raw, span });
  }
  list(): string[] { return [...this.seen].map(([what, v]) => `${what}（例：${v.raw}）`); }
  /** → 模型诊断（`Diagnostic.source` 必填，所以每个落点都要有 span）。 */
  diagnostics(): Diagnostic[] {
    return [...this.seen].map(([what, v]) => ({
      severity: "warning" as const,
      code: "jly-unsupported",
      message: what + "：本版不收，已跳过（没有写进模型）",
      source: v.span ?? ZERO_SPAN,
    }));
  }
}

/** 本版不收的写法：先认出来、报出去，别当音符硬读。 */
const NOT_YET: readonly (readonly [RegExp, string])[] = [
  [/^x$/, "打击乐 `x`（与 dolce 的不可见休止语义不同）"],
  [/^(LP:|:LP|LPH:|:LPH)$/, "原样 LilyPond 代码块（`LP: … :LP`）"],
  [/^(KeepLength|ChordsRoman|NoBarNums|NoIndent|OnePage|RaggedLast|SeparateTimesig|angka|WithStaff|PartMidi|RepeatAccidentals|NormalAccidentals)$/, "布局 / 结构开关"],
  [/^(chords|frets|instrument)=/, "和弦符号 / 指板图 / 乐器"],
  [/^arp(Up|Down)?$/, "琶音"],
  [/^(Fr=|slide|souyin|harmonic|bend)/, "二胡符号"],
  [/^(letter[A-Z0-9]+|glis|Harm:)$/, "排练记号 / 滑音 / 泛音"],
  [/^[<>]$/, "基准八度切换"],
  [/^[89]$/, "八度快捷键（`8`=`1'`）"],
  [/^\\/, "LilyPond 指令"],
];

/** `g[#45]` / `g[d4d5s6]` 里的音。**倚音和弦**（`g[1&3&5]`）本版不收（引擎输入里一个倚音只有一个音高）。 */
function parseGrace(inner: string, loss: JlyLosses, span?: SourceSpan): JlyGraceNote[] | null {
  if (inner.includes("&")) { loss.add("倚音和弦（`g[1&3&5]`）", inner, span); return null; }
  const out: JlyGraceNote[] = [];
  let i = 0;
  while (i < inner.length) {
    let beams = 1;                                  // 未记时值 = 八分（与引擎输入那边的默认一致）
    if (LETTER_BEAMS[inner[i]!] !== undefined) { beams = LETTER_BEAMS[inner[i]!]!; i++; }
    let alter = "";
    const two = inner.slice(i, i + 2);
    if (ACC[two]) { alter = two; i += 2; }
    else if (ACC[inner[i]!]) { alter = inner[i]!; i++; }
    if (!/[0-7]/.test(inner[i] ?? "")) { loss.add("倚音组里读不动的写法", inner, span); return null; }
    const degree = Number(inner[i]!);
    i++;
    let octave = 0;
    let dots = 0;
    while (i < inner.length && (inner[i] === "'" || inner[i] === "," || inner[i] === ".")) {
      if (inner[i] === "'") octave++;
      else if (inner[i] === ",") octave--;
      else dots++;
      i++;
    }
    out.push({ degree, alter, octave, dots, beams });
  }
  return out.length ? out : null;
}

/**
 * 一个词（空格分隔）→ token。**顺序无关**：先把词里所有记号认出来，再判断合不合法。
 * `span` 只用于把"本版不收"的落点记进报告册。
 */
export function scanWord(word: string, loss: JlyLosses, span?: SourceSpan): JlyToken | null {
  if (word === "-") return { kind: "sustain" };
  if (word === "~") return { kind: "tie" };
  // 圆滑线两种写法**语义不同**，不能一律当同一种：`(` 是 jianpu-ly 的圆滑线，落到 LilyPond 上会被
  // 当成"一字多音"（`melismaBusyProperties` 默认含 `slurMelismaBusy`），弧线里的音**不吃音节**；
  // `\(` 是 LilyPond 的乐句线，照样画弧线但不吞音节。所以歌词对位要按它区分（实测，见 `tojly.ts`）。
  if (word === "(") return { kind: "slur-open", melisma: true };
  if (word === ")") return { kind: "slur-close", melisma: true };
  if (word === "\\(") return { kind: "slur-open", melisma: false };
  if (word === "\\)") return { kind: "slur-close", melisma: false };
  if (word === "]") return { kind: "tuplet-close" };
  if (/^\|+$/.test(word)) return { kind: "bar" };
  if (/^\d+\[$/.test(word)) return { kind: "tuplet-open", n: Number(word.slice(0, -1)) };
  if (/^[\^_]".*"$/.test(word)) return { kind: "text", above: word[0] === "^", value: word.slice(2, -1) };
  // 跳转记号与力度：上游写成**裸词**（`Fine` `DC` `Segno` `ToCoda` `DS`）或 LilyPond 指令（`\mf`）。
  // 不认它们就只剩"报出来"，而写出端是会写这两种的 —— 读写两头对不上，往返就丢。
  if (BARE_DIRECTION.test(word)) return { kind: "jump", text: canonicalJump(word) };
  if (DYNAMIC_COMMAND.test(word)) return { kind: "dynamic", name: word.slice(1) };
  if (word === "\\fermata") return { kind: "fermata" };
  // 换行/换页：LilyPond 指令原样透传，但**语义是实的**（上游会照着换系统/换页），所以要读进模型。
  //  实测：`\break` 让 32 个音挤一行的谱变成两行（25 + 8 两带）；`\pageBreak` 让 1 页变 3 页。
  if (word === "\\break") return { kind: "break", page: false };
  if (word === "\\pageBreak") return { kind: "break", page: true };
  // 反复跳跃：`R{ 第一遍 } A{ 第二遍 }`（上游自己的 MusicXML 导入端就是这么做出来的：
  //   `<repeat forward>` → `R{`、`<repeat backward>` → `}`、`<ending start>` → `A{`）。
  if (/^R\*\d+$/.test(word)) return { kind: "multirest", n: Number(word.slice(2)) };   // 多小节休止：R*8 = 8 个小节
  if (word === "R{") return { kind: "repeat-open" };
  // 小节反复（％）：`R4{ 1 2 }` —— 上游译成 `\repeat percent 4 { … }`，即里面这些小节**共唱 4 遍**。
  if (/^R[1-9][0-9]*\{$/.test(word)) return { kind: "percent-open", times: Number(word.slice(1, -1)) };
  if (word === "A{") return { kind: "alt-open" };
  if (word === "}") return { kind: "repeat-close" };
  if (/^g\[.*\]$/.test(word)) {
    const notes = parseGrace(word.slice(2, -1), loss, span);
    return notes ? { kind: "grace", notes } : { kind: "loss", what: "倚音" };
  }
  for (const [re, what] of NOT_YET) {
    if (re.test(word)) { loss.add(what, word, span); return { kind: "loss", what }; }
  }
  // ── 多音和弦（上游 README「简单和弦：`,135' 1 1b3 1`」）────────────────────────
  // ⚠ 必须在**单音解析之前**：单音那条路碰到第二个数字就 `return null`（下面 `if (degree !== null)`），
  //   于是**写出端自己的和弦产物** `,135` 会落到 `unknown`、整块静默消失（上游 review 第 1 条）。
  //   形态：可选时值字母前缀 + 逐个音（数字前后都能带八度记号、变音在数字前）+ 末尾附点。
  if ((word.match(/[0-7]/g) ?? []).length >= 2) {
    const chord = scanChordWord(word);
    if (chord) return chord;
  }
  let i = 0;
  let alter = "";
  let degree: number | null = null;
  let octave = 0;
  let beams = 0;
  let dots = 0;
  let backslashes = 0;
  while (i < word.length) {
    const c = word[i]!;
    if (c === "#" || c === "b" || c === "n") {
      const two = word.slice(i, i + 2);
      if (!alter && ACC[two]) { alter = two; i += 2; continue; }
      if (!alter && ACC[c]) { alter = c; i += 1; continue; }
      return null;
    }
    if (c === "'") { octave++; i++; continue; }
    if (c === ",") { octave--; i++; continue; }
    if (c === ".") { dots++; i++; continue; }
    if (c === "\\") { backslashes++; i++; continue; }
    if (/[0-7]/.test(c)) {
      if (degree !== null) return null;
      degree = Number(c); i++; continue;
    }
    if (LETTER_BEAMS[c] !== undefined) { beams = LETTER_BEAMS[c]!; i++; continue; }
    return null;
  }
  if (degree === null) {
    if (backslashes) { loss.add("反斜杠时值（`1\\`）", word, span); return { kind: "loss", what: "反斜杠时值" }; }
    return null;
  }
  if (backslashes) beams = backslashes === 1 ? 1 : 2;   // README：`1\` 八分、`1\\` 十六分
  return { kind: "note", degree, alter, octave, beams, dots };
}

/**
 * 多音和弦词 → 一个 `JlyNote`（首个音放在外层字段，其余放 `chord`）。
 *
 * 语法按上游 `jianpu-ly.py::chordNotes_markup` + README「简单和弦：`,135'`」定，并**用真工具实测过**：
 *   * 八度/变音记号贴在各自数字上（`,135` → LilyPond `<c e' g'>`：`1` 低一个八度、`3`/`5` 基准八度）；
 *   * 数字**前后**的八度记号都算（上游 `grace_octave_fix` 两种都归一化）；
 *   * 时值字母/反斜杠是**前缀**（`q,135`）；
 *   * 末尾的 `.` 是整个和弦的附点（`chordBody` 就是 `"," + 各音 + dots`）。
 * 认不出来（比如和弦里混了 `0`/`x`）就返回 `null`，让调用方走原来的路（并报"认不出的词"）。
 */
function scanChordWord(word: string): JlyNote | null {
  let i = 0;
  let beams = 0;
  while (i < word.length && (LETTER_BEAMS[word[i]!] !== undefined || word[i] === "\\")) {
    if (word[i] === "\\") beams = Math.min(2, beams + 1);
    else beams = LETTER_BEAMS[word[i]!]!;
    i++;
  }
  let j = word.length;
  let dots = 0;
  while (j > i && word[j - 1] === ".") { dots++; j--; }
  const body = word.slice(i, j);
  const notes: JlyChordNote[] = [];
  let k = 0;
  while (k < body.length) {
    let octave = 0;
    let alter = "";
    while (k < body.length && (body[k] === "'" || body[k] === ",")) { octave += body[k] === "'" ? 1 : -1; k++; }
    const two = body.slice(k, k + 2);
    if (ACC[two]) { alter = two; k += 2; }
    else if (body[k] && ACC[body[k]!]) { alter = body[k]!; k++; }
    const c = body[k];
    if (!c || !/[1-7]/.test(c)) return null;          // 和弦里不收 `0`（上游直接报错）、`x`、别的记号
    k++;
    while (k < body.length && (body[k] === "'" || body[k] === ",")) { octave += body[k] === "'" ? 1 : -1; k++; }
    notes.push({ degree: Number(c), alter, octave, dots: 0, beams });
  }
  if (notes.length < 2) return null;                  // 单音走原来那条路，别在这里抢
  const [first, ...rest] = notes;
  return { kind: "note", degree: first!.degree, alter: first!.alter, octave: first!.octave, beams, dots, chord: rest };
}

/** 这一行是不是**曲行**（有音符/小节线那些）。`L:`/`H:` 词行、页头、拍号/调号/速度、`NextScore` 都不是。 *  分类与 `parseJly` 的派发次序同一套（改一处要改两处）。 */
export function isJlyMusicLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith("%")) return false;
  if (/^[LH]:/.test(t)) return false;
  if (/^[A-Za-z][A-Za-z0-9]*=/.test(t)) return false;        // 页头 / `chords=` / `frets=` …
  if (/^\d+\/\d+(,\d+)?$/.test(t)) return false;             // 拍号
  if (/^[1-7]=[A-Ga-g][#b]?$/.test(t)) return false;         // 调号
  if (/^\d+(\.\d+)?=\d+$/.test(t)) return false;             // 速度
  if (t === "NextScore" || t === "NextPart") return false;
  return scanMusicLine(t, new JlyLosses()).tokens.length > 0;
}

/**
 * 把曲行按**每 N 小节一行**重新断行，别的一个字不动（词行、页头、注释都留在原处）。
 *
 * 为什么要重排：上游不看行（行只是排版偏好，`%` 里那点提示随行也无所谓），可 **dolce 自己按文件的行排版**
 * ——整首挤成一行时音符与歌词叠成一团（用户截图）。
 *
 * ⚠ **只搬字符、不整份重出**：写出端还不认识 `R{ } A{ }`、倚音、`chords=` 这些，整份重出会把它们抹掉。
 * 所以这里按 token 切片搬运，行内空白规范成一个空格（对上游无意义），其余原样。
 */
export function rewrapJlyText(text: string, measuresPerLine = 4): string {
  const rows = [...text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .map((m) => ({ raw: m[1]!, sep: m[2] ?? "" }))
    .filter((r, i, all) => !(i === all.length - 1 && r.raw === "" && r.sep === ""));
  // ⚠ **分段**（上游 review 第 7 条）：`NextScore` / `NextPart` / 曲中转调转拍号/速度这些行不能跨。
  //   以前把**全文件**的曲行 token 都收到第一条曲行上，于是这些分隔行之后的音被挪到它们**前面** ——
  //   第二首就没音了。现在按这些分隔行切开，逐段重排，分隔行原样留在原地。
  const isSep = (raw: string): boolean => {
    const t = raw.trim();
    if (!t || t.startsWith("%")) return false;
    if (t === "NextScore" || t === "NextPart") return true;
    return /^\d+\/\d+(,\d+)?$/.test(t) || /^[1-7]=[A-Ga-g][#b]?$/.test(t) || /^\d+(\.\d+)?=\d+$/.test(t);
  };
  const segs: { raw: string; sep: string }[][] = [];
  let acc: { raw: string; sep: string }[] = [];
  for (const r of rows) {
    if (isSep(r.raw)) { segs.push(acc); acc = []; segs.push([r]); continue; }
    acc.push(r);
  }
  segs.push(acc);
  if (segs.length === 1) return rewrapJlyRows(rows, measuresPerLine);
  return segs.map((s) => (s.length === 1 && isSep(s[0]!.raw) ? s[0]!.raw + s[0]!.sep : rewrapJlyRows(s, measuresPerLine))).join("");
}

/** 单段的重排（原实现；分隔行已在 `rewrapJlyText` 里切开，不会跨首尾）。 */
function rewrapJlyRows(rows: { raw: string; sep: string }[], measuresPerLine = 4): string {
  const isMusic = rows.map((r) => isJlyMusicLine(r.raw));
  if (!isMusic.some(Boolean)) return rows.map((r) => r.raw + r.sep).join("");

  // 曲行里的 token，按文件顺序集中起来；行内注释挪到这一组最后一行的行尾（仍是注释）
  const tokens: string[] = [];
  const comments: string[] = [];
  rows.forEach((r, i) => {
    if (!isMusic[i]) return;
    const at = r.raw.indexOf("%");
    const body = at >= 0 ? r.raw.slice(0, at) : r.raw;
    if (at >= 0) comments.push(r.raw.slice(at).trim());
    for (const word of body.split(/\s+/).filter(Boolean)) tokens.push(word);
  });

  // 切小节：`|` 收小节（小节里已经有 token 才算收尾线，行首的 `|` 是左线）
  const lines: string[] = [];
  let cur: string[] = [];
  let inMeasure: string[] = [];
  let count = 0;
  const flushLine = (): void => { if (inMeasure.length) { cur.push(...inMeasure); inMeasure = []; } if (cur.length) { lines.push(cur.join(" ")); cur = []; } };
  for (const tk of tokens) {
    if (/^\|+$/.test(tk) && inMeasure.length) {
      inMeasure.push(tk);
      cur.push(...inMeasure);
      inMeasure = [];
      if (++count >= measuresPerLine) { lines.push(cur.join(" ")); cur = []; count = 0; }
      continue;
    }
    inMeasure.push(tk);
  }
  flushLine();
  if (comments.length && lines.length) lines[lines.length - 1] += "  " + comments.join(" ");

  const out: string[] = [];
  let slot = 0;
  for (const [i, r] of rows.entries()) {
    if (!isMusic[i]) { out.push(r.raw); continue; }
    // 新的曲行全部落在**第一条**曲行的位置上，后面的曲行不再占行；
    // ⚠ 不能把「第一条到最后一条」整段替换掉：歌词行可能夹在两条曲行之间（上游允许 `L:` 写在任何地方），
    //   整段替换会把夹在中间的词行整条抹掉（第一版就是这样）。
    if (slot === 0) out.push(...lines);
    slot++;
  }
  // 段的**行尾**沿用段内最后一行的分隔符（整文件时就是原来的行为）。
  const tail = rows.length ? rows[rows.length - 1]!.sep : "";
  return out.join("\n") + tail;
}

/** 一整行音乐 → token 与各自的位置（按空白切；`%` 起头是注释，README：「忽略：`% 注释`」）。 */export function scanMusicLine(
  line: string,
  loss: JlyLosses,
  spanAt?: (col: number, len: number) => SourceSpan,
): { tokens: JlyToken[]; pos: JlyPos[]; unknown: string[] } {
  const tokens: JlyToken[] = [];
  const pos: JlyPos[] = [];
  const unknown: string[] = [];
  const body = line.replace(/%.*$/, "");
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const word = m[0];
    // `\bar "…"` 是**两个词**（指令 + 引号里的参数），要成对读：上游/我们自己写出的反复线都是这个形态。
    if (word === "\\bar") {
      const nxt = /\S+/.exec(body.slice(m.index + word.length));
      const arg = nxt ? /^"([^"]*)"$/.exec(nxt[0]) : null;
      if (arg) {
        tokens.push({ kind: "barstyle", style: arg[1]! });
        pos.push({ col: m.index, len: word.length + nxt![0].length });
        re.lastIndex = m.index + word.length + nxt!.index + nxt![0].length;
        continue;
      }
    }
    const t = scanWord(word, loss, spanAt?.(m.index, word.length));
    if (t) { tokens.push(t); pos.push({ col: m.index, len: word.length }); }
    else {
      // ⚠ 认不出的词**必须报出来**，不能只塞进 `unknown` 就完事（上游 review 指出：`1 2 ,135 3 |`
      //   会静默变成 `1 2 3`，和弦整块消失）。走 `loss` 才会变成模型诊断、才看得见。
      loss.add("认不出的词（已跳过）", word, spanAt?.(m.index, word.length));
      unknown.push(word);
    }
  }
  return { tokens, pos, unknown };
}

/** 歌词里的一个音节。`null`（列表里）表示**占位**——这个音上没词，别把后面的字往前挪。 */
interface JlySyllable { text: string; /** 词内断音节（上游写 `syl-`，模型里是 `syllabic: "begin"`） */ begin?: boolean }

/**
 * 一行歌词正文 → 音节列表。三种"占位"记号都收成 `null`（都是上游自己的写法）：
 *   `""`   —— 上游 MusicXML 导入端给"这个音没词"写的就是空串；
 *   孤立的 `_`（拉丁行）—— 上游给 melisma 的续音写它；
 *   `\skip 1` —— LilyPond 原生的跳过。
 * **汉字行**里的 `_` 不是跳过，是连写（`一_三` = 一个字两个汉字，仍只占一格）；
 * 行尾的 `-` 是词内断音节（上游把 `syl- la- bles` 译成 ` -- `），跟 123 读法一致收成 `syllabic: "begin"`。
 * 位置感由调用方按"哪些和弦算歌词位置"决定（见 `parseJly` 里 `slots`）。
 */
function syllablesOf(body: string, han: boolean): (JlySyllable | null)[] {
  const out: (JlySyllable | null)[] = [];
  /** LilyPond 的字符串音节：`"do"` 就是一个字（`""` 是空 = 占位）。写出端**一律**这么写拉丁歌词，
   *  因为不加引号的 `4` / `s0` 会被 LilyPond 当成时值（实测直接报错）。 */
  const unquote = (w: string): string | null => {
    if (w.length < 2 || !w.startsWith('"') || !w.endsWith('"')) return w;
    const inner = w.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return inner === "" ? null : inner;
  };
  const push = (raw: string): void => {
    const text = unquote(raw);
    if (text === null) { if (raw === "") return; out.push(null); return; }
    if (text === "") return;
    if (text.endsWith("-")) out.push({ text: text.slice(0, -1), begin: true });
    else out.push({ text });
  };
  if (han) {
    // 汉字行：**一个汉字一个音节**（真 jianpu-ly 实测：`H: 你好世界` → LilyPond 歌词 `你 好 世 界`）；
    //   `_` 是连写、整段合成一格（`H: 一_三` → `一三`）；空白只是排版分隔；引号包住的整串算一格。
    //   ⚠ 以前整行按空白切，于是 `H: 你好世界` 四个字全压在第 1 个音上（上游 review）。
    for (const w of body.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []) {
      if (w.length >= 2 && w.startsWith('"') && w.endsWith('"')) { push(w); continue; }
      if (w.includes("_")) { const text = w.split("_").join(""); if (text) push(text); continue; }
      for (const ch of w) if (ch.trim()) push(ch);
    }
    return out;
  }
  // ⚠ 先按空白切、再剥引号是**错的**：写出端把一个音上的多个拉丁词写成 `"a b"`（引号里有空格），
  //   切开会得到 `"a` 与 `b"` 两个带残留引号的音节，后面的歌词整体错位、往返不闭合。
  //   所以先把**整对引号**当一格取出来（上游 review 第 4 条）。
  const words = body.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "_") { out.push(null); continue; }
    if (/^\\skip\d*$/.test(w)) {                     // `\skip 1` / `\skip1`
      out.push(null);
      if (w === "\\skip" && /^\d+$/.test(words[i + 1] ?? "")) i++;
      continue;
    }
    push(w);
  }
  return out;
}

// ───────────────────────── 装配：token → ScoreDoc ─────────────────────────

export interface JlyParse {
  doc: ScoreDoc;
  losses: string[];
  unknown: string[];
}

/** 大调主音名 → `fifths`（`tojly.ts` 那张表的反向）。 */
const FIFTHS: Readonly<Record<string, number>> = {
  Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1,
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
};

const CREDIT_KEYS = new Set(["composer", "poet", "lyricist", "arranger", "copyright", "opus"]);
const dotFactor = (dots: number): number => (dots === 0 ? 1 : 2 - Math.pow(2, -dots));
/** 倚音的减时线条数 → 符号时值：0 条四分、1 条八分（未记的默认）、2 条十六、3 条三十二、4 条六十四。 */
const GRACE_TYPES = ["quarter", "eighth", "16th", "32nd", "64th"] as const;
const graceTypeOf = (beams: number): NonNullable<Chord["duration"]["type"]> =>
  GRACE_TYPES[Math.max(0, Math.min(4, Math.round(beams)))]!;
/** `n[ … ]` 里 n 个音占几个（README 的表：3→2、5/6/7→4，其余取小于 n 的最大 2 的幂）。 */
const tupletNormal = (n: number): number => { let p = 1; while (p * 2 < n) p *= 2; return p; };

/**
 * jianpu-ly 文本 → `ScoreDoc`（带位置信息与诊断）。
 *
 * 覆盖：页头（`title=` / 署名 / `1=Bb` / `4/4` / `4=85`）、音符（顺序无关、字母时值、附点、八度、变音）、
 * 增时线 `-`（加时值 + 挂 `Sustain`）、休止 `0`、小节线、延音线 `~`、连音 `3[ … ]`、
 * 歌词 `L:` / `H:`（逐段挂到前面已读出的音上）、多曲 `NextScore`、多声部 `NextPart`。
 */
export function parseJly(text: string): JlyParse {
  const loss = new JlyLosses();
  const unknown: string[] = [];
  const doc = emptyDoc("jly");
  const ids = new IdGen();

  let song = emptySong();
  doc.songs.push(song);
  let part = { id: "P1", measures: [] as Measure[] };
  song.parts.push(part);

  let cur: Measure | null = null;
  /** 上一个和弦的**引用**：延音线的起点要跨小节回找它（见下面 `pendingTie` 那段）。
   *  换曲/换声部时清掉 —— 延音线不该跨过 `NextScore`/`NextPart`。 */
  let prevChordRef: Chord | null = null;
  let openTuplet: number | null = null;
  let pendingTie = false;
  /** 没写段号的歌词行按出现顺序编号（跨 `L:`/`H:` 共用，上游也只是一条条往下叠）。 */
  let autoVerse = 0;
  /** 小节反复 `R4{ … }`：还没收尾的（起点、次数）与已经收尾的段（展开在最后统一做）。 */
  const percentStack: { from: number; times: number }[] = [];
  const percentRanges: { from: number; to: number; times: number }[] = [];
  /** 小节线之后出现的换行/换页：挂到**下一小节**的 `print` 上（开下一小节时才用，见 `openMeasure`）。 */
  let pendingBreak: "system" | "page" | null = null;
  /** `chords=` 行里的和弦符号（按乐章分开，装到那个时间上的音上；见解析循环里那段注释）。 */
  const chordTokens: { song: number; text: string; whole: number | null }[] = [];
  /** 反复跳跃区（`R{ … } A{ … }`）：小节下标，-1 = 还没出现。 */
  const repeats: { rStart: number; rEnd: number; aStart: number; aEnd: number }[] = [];
  // 歌词位置：**发音**的和弦。休止不占（LilyPond 的 `\lyricsto` 跳过休止，实测连带梁休止也跳），
  // 圆滑线 `(` … `)` 里的音也不占（那是"一字多音"：`slurMelismaBusy`，实测 `1 ( 2 ) 3 4`
  // 配 `L: A B C D` 时 B 会跳到第 3 个音上）。乐句线 `\(` `\)` 不吞音节，所以不算在里面。
  const slots: Chord[] = [];
  let melismaOpen = 0;                   // 已经从**前面**的音开始的圆滑线（本音不吃音节）
  let pendingMelisma = 0;                // 本音自己开的圆滑线：从**下一个**音起才吞
  const verses = new Map<string, { han: boolean; syllables: (JlySyllable | null)[]; span?: SourceSpan }>();

  /** 开一小节；`source` 落在这一小节的第一个 token 上（编辑器按它定位小节）。
   *  ⚠ 换行/换页指令如果正好落在小节线之后（`… 5 5 | \break 6 6 …`），模型的口径是"**下一小节**
   *  的 `print` 起新系统/新页" —— 但**不能**为了挂这个标记就先开一个空小节：空小节会真的出现在谱上
   *  （实测：4 小节变 5 小节，还多出一根小节线）。所以先记成 `pendingBreak`，等真正要开下一小节时再挂。 */
  const openMeasureRaw = (source?: SourceSpan): Measure => {
    const m: Measure = { number: String(part.measures.length + 1), elements: [] };
    if (source) m.source = source;
    part.measures.push(m);
    return m;
  };
  const openMeasure = (source?: SourceSpan): Measure => {
    const m = openMeasureRaw(source);
    if (pendingBreak) {
      m.print = { ...(m.print ?? {}), ...(pendingBreak === "page" ? { newPage: true } : { newSystem: true }) };
      pendingBreak = null;
    }
    return m;
  };

  let lineNo = 0;                        // 0 基行号（`SourceSpan` 口径）
  let lineOffset = 0;                    // 本行起点的全文偏移
  // ⚠ 必须按**实际分隔符**推进偏移：CRLF 是两个字符，按 `+1` 累加会让每行少 1，
  //   偏移一路漂走（实测 6606 个 span 里错了 6242 个，切片指向别的行）。
  //   先把行拆出来（而不是边扫边 `advance`），是为了歌词的**多行写法**能往后吃掉几行。
  const rows = [...text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .map((m) => ({ raw: m[1]!, sep: m[2] ?? "" }))
    .filter((r, i, all) => !(i === all.length - 1 && r.raw === "" && r.sep === ""));
  for (let li = 0; li < rows.length; li++) {
    const { raw, sep } = rows[li]!;
    const indent = raw.length - raw.trimStart().length;
    const spanOf = (col: number, len: number): SourceSpan =>
      ({ line: lineNo, column: indent + col, offset: lineOffset + indent + col, length: len });
    const advance = (): void => { lineNo++; lineOffset += raw.length + sep.length; };

    const line = raw.trim();
    if (!line || line.startsWith("%")) { advance(); continue; }

    // 歌词行。音节串可以只写一行，也可以 `L:` 之后换行、分几行写、以**空行**结束
    // （上游 README：「在:之后换行输入，并以2个空行结束」；它自己也是先把这几行合成一行再解析）。
    const mLyric = /^([LH]):\s*(.*)$/.exec(line);
    if (mLyric) {
      const han = mLyric[1] === "H";
      const head = spanOf(indent, line.length);
      let body = mLyric[2] ?? "";
      if (!body) {
        const parts: string[] = [];
        while (li + 1 < rows.length) {
          const nxt = rows[li + 1]!;
          const t = nxt.raw.trim();
          if (!t || t.startsWith("%")) break;              // 空行结束（`%` 注释也当结束）
          parts.push(t);
          li++;
          lineNo++;
          lineOffset += nxt.raw.length + nxt.sep.length;   // 吃掉的行也要推进偏移，否则后面的 span 全漂
        }
        body = parts.join(" ");
      }
      let verse = "";
      const mv = /^(\d+)\.\s*(.*)$/.exec(body);
      if (mv) { verse = mv[1]!; body = mv[2] ?? ""; autoVerse = Math.max(autoVerse, Number(verse)); }
      else {
        // 没写段号：**每一条歌词行各自是一段**（上游把每条 `L:`/`H:` 行变成一个 `\new Lyrics` 叠下去，
        // 就是这么排的）。原来一律塞进第 1 段，于是"两行词"会连成一行、后面的字还挤到后面的音上
        // ——用户截图里 `L: do re …` 和第二条 `L: …` 连成 `…do是是是的的` 就是这个。
        verse = String(++autoVerse);
      }
      const key = verse + (han ? "H" : "L");
      const syls = syllablesOf(body, han);
      // 上游的 `L:` 行**不拆汉字**（只有 `H:` 行会逐字自动分开），所以一串汉字会被当成一个音节，
      // 排出来是"好几个字挤在一个音下面"。这不改读法（要跟真工具一致），但要说清楚怎么写。
      if (!han && syls.some((s) => s && [...s.text].filter((c) => /[\u3400-\u9fff]/.test(c)).length > 1)) {
        loss.add("拉丁歌词行（`L:`）里的连续汉字：上游把整串当一个音节，要逐字分开请写成 `H:`", body, head);
      }
      const slot = verses.get(key) ?? { han, syllables: [], span: head };
      slot.syllables.push(...syls);
      verses.set(key, slot);
      advance();
      continue;
    }

    // 页头字段。⚠ `chords=…` 也长得像页头（`key=value`），所以这里先把它排除掉 ——
    //    否则它会被当成"页头字段 chords="报掉，下面那段和弦行永远进不来（踩过）。
    const isChordRow = /^chords\s*=/i.test(line);
    const mHead = isChordRow ? null : /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (mHead) {
      const key = mHead[1]!.toLowerCase();
      const value = mHead[2]!.trim();
      if (key === "title" || key === "movement-title") song.work.title = value;
      else if (key === "subtitle") song.work.subtitles.push(value);
      else if (CREDIT_KEYS.has(key)) song.credits = [...(song.credits ?? []), { type: key, text: value }];
      else loss.add("页头字段 `" + key + "=`", line, spanOf(0, line.length));
      advance();
      continue;
    }
    const mTime = /^(\d+)\/(\d+)(,\d+)?$/.exec(line);
    if (mTime) {
      song.time = { beats: Number(mTime[1]), beatType: Number(mTime[2]) };
      if (mTime[3]) loss.add("弱起拍号（`4/4,8`）", line, spanOf(0, line.length));
      advance();
      continue;
    }
    const mKey = /^([1-7])=([A-Ga-g][#b]?)$/.exec(line);
    if (mKey) {
      const tonic = mKey[2]!;
      const fifths = FIFTHS[tonic] ?? FIFTHS[tonic[0]!.toUpperCase() + tonic.slice(1)];
      if (fifths === undefined) loss.add("调号 `" + line + "`", line, spanOf(0, line.length));
      else song.key = { fifths, spelling: tonic };
      advance();
      continue;
    }
    const mTempo = /^\d+(?:\.\d+)?=(\d+)$/.exec(line);
    if (mTempo) { song.tempos = [Number(mTempo[1])]; advance(); continue; }

    // 和弦符号行：`chords=c2. g:7 c`，token 是 **LilyPond 和弦语法**（上游原样塞进 `\chordmode`）。
    // 时值走 LilyPond 的口径（没写就沿用上一个，第一个默认四分），整行的时值就是从曲首起的时间线；
    // 谱上印的文字按 `jlychords.ts` 那两张表转回来，模型里存成 `Chord.harmony`（与 123 的 `"Am"` 同落点）。
    const mChords = /^chords\s*=\s*(.*)$/i.exec(line);
    if (mChords) {
      const head = spanOf(indent, line.length);
      let body = mChords[1] ?? "";
      if (!body) {
        const parts: string[] = [];
        while (li + 1 < rows.length) {
          const nxt = rows[li + 1]!;
          const t = nxt.raw.trim();
          if (!t || t.startsWith("%")) break;
          parts.push(t);
          li++;
          lineNo++;
          lineOffset += nxt.raw.length + nxt.sep.length;
        }
        body = parts.join(" ");
      }
      for (const tok of body.split(/\s+/).filter(Boolean)) {
        const parsed = parseChordToken(tok);
        if (!parsed) { loss.add("和弦符号行里读不动的 token", tok, head); continue; }
        const root = lyPitchToText(parsed.pitch);
        if (root === null) { loss.add("和弦符号行里读不动的音名", tok, head); continue; }
        const bass = parsed.bass ? lyPitchToText(parsed.bass) : null;
        chordTokens.push({
          song: doc.songs.length - 1,
          text: root + lySuffixToText(parsed.suffix) + (bass ? "/" + bass : ""),
          whole: parsed.whole,
        });
      }
      advance();
      continue;
    }

    if (line === "NextScore") {      finishSong();       // ⚠ 切曲前先把当前曲收尾（上游 review 第 4 条）
      song = emptySong(); doc.songs.push(song);
      part = { id: "P1", measures: [] }; song.parts.push(part);
      cur = null; prevChordRef = null; slots.length = 0; melismaOpen = 0; pendingMelisma = 0; autoVerse = 0; advance(); continue;
    }
    if (line === "NextPart") {
      part = { id: "P" + (song.parts.length + 1), measures: [] }; song.parts.push(part);
      cur = null; advance(); continue;
    }

    // 音乐行
    const { tokens, pos, unknown: unk } = scanMusicLine(line, loss, spanOf);
    unknown.push(...unk);
    const spanAt = (i: number): SourceSpan => spanOf(pos[i]?.col ?? 0, pos[i]?.len ?? 0);
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i]!;
      /** 记号落在"前一个音"上（上游的 `\mf` / `\fermata` 都是"适用于之前的音符"）。 */
      const lastChord = (): Chord | null => {
        const here = cur?.elements[cur.elements.length - 1];
        if (here && here.kind === "chord") return here;
        const prev = part.measures[part.measures.length - 1];
        const last = prev?.elements[prev.elements.length - 1];
        return last && last.kind === "chord" ? last : null;
      };
      /** 跳转记号在 123 里是**小节线上的记号**（`Barline.ornaments`，短名 `hs`/`ty`/`ds`/`dc`/`fine`）。
       *  照它的口径存，渲染、跨格式与写出端才都对得上（实测：`!fine!` 导出成裸词 `Fine` 走的就是这条链）。 */
      const addJump = (short: string): void => {
        const host = cur ?? part.measures[part.measures.length - 1];
        if (!host) { loss.add("跳转记号（还没有小节）", short, spanAt(i)); return; }
        const lines = host.barlines ?? (host.barlines = []);
        const right = lines.find((b) => b.location === "right");
        if (right) right.ornaments = [...(right.ornaments ?? []), { name: short, level: 0 }];
        else lines.push({ location: "right", source: spanAt(i), ornaments: [{ name: short, level: 0 }] });
      };
      switch (tk.kind) {
        case "loss": case "header": break;
        case "text": {
          // 与 123 同一个落点：`"^渐慢"` 在那边存成 `Chord.sectionWord`（谱上文字）
          const host = lastChord();
          if (host) host.sectionWord = host.sectionWord ? host.sectionWord + " " + tk.value : tk.value;
          else loss.add("谱上文字（前面没有音）", tk.value, spanAt(i));
          break;
        }
        case "dynamic": {
          // 与 123 同一个落点：`!mf!` 在那边存成 `Chord.notations.articulations` 里的一项
          const host = lastChord();
          if (host) {
            const not = { ...(host.notations ?? {}) };
            not.articulations = [...(not.articulations ?? []), tk.name];
            host.notations = not;
          } else loss.add("力度记号（前面没有音）", tk.name, spanAt(i));
          break;
        }
        case "fermata": {
          const host = lastChord();
          if (host) host.notations = { ...(host.notations ?? {}), fermata: true };
          else loss.add("延长记号 `\\fermata`（前面没有音）", "\\fermata", spanAt(i));
          break;
        }
        case "jump": addJump(JUMP_SHORT[tk.text] ?? "fine"); break;
        case "break": {
          // `\break` / `\pageBreak` 的语义是「**这里之后**换系统/换页」（与 123 的 `$` / `$$` 同一套口径）：
          //   本小节里已经有音 = 小节中间换行，记在那个和弦的 `lineBreakAfter` 上；
          //   没有 = 刚收尾的那一小节之后换，记在**下一小节**的 `print` 上（模型的口径与 MusicXML 一致：
          //   `newSystem`/`newPage` 表示「本小节起新系统/新页」）。
          const host = cur && cur.elements.length ? cur : part.measures[part.measures.length - 1];
          if (!host) { loss.add("换行/换页（前面还没有小节）", tk.page ? "\\pageBreak" : "\\break", spanAt(i)); break; }
          if (cur && cur.elements.length) {
            const last = cur.elements[cur.elements.length - 1];
            if (last && last.kind === "chord") last.lineBreakAfter = tk.page ? "page" : "system";
          } else {
            // 小节线之后：记成"下一小节起新系统/新页"，等下一小节真的开出来再挂（别先开空小节）
            pendingBreak = tk.page ? "page" : "system";
          }
          break;
        }
        case "barstyle": {
          // `\bar "…"`（LilyPond 的小节线）：认得出来的映回模型的反复/样式，其余报出来。
          //   `".|:"` 写在反复体**开头**（我们写出端就是这么写的）→ 当前这一小节的左线；
          //   `":|."` 写在反复体末尾 → 刚收尾那一小节的右线（兼终止线）。
          const st = tk.style.trim();
          const at: "left" | "right" = st.startsWith(".") && st.includes(":") ? "left" : "right";
          // ⚠ 左线这条要**把新开的小节赋回 `cur`** —— 不然 `cur` 还是 null，紧接着的第一个音又会开一个新小节，
          //   于是谱头多出一个"只有反复线"的空小节（实测踩过）。
          if (at === "left" && !cur) cur = openMeasure(spanAt(i));
          const host = at === "left"
            ? cur!
            : (cur && cur.elements.length ? cur : part.measures[part.measures.length - 1]);
          if (!host) { loss.add("小节线样式 `\\bar`（前面还没有小节）", st, spanAt(i)); break; }
          const lines = host.barlines ?? (host.barlines = []);
          let bl = lines.find((b) => b.location === at);
          if (!bl) { bl = { location: at, source: spanAt(i) }; lines.push(bl); }
          const map: Readonly<Record<string, { style?: Barline["style"]; repeat?: "forward" | "backward" }>> = {
            ".|:": { style: "heavy-light", repeat: "forward" },
            ".|": { style: "heavy-light" },
            ":|.": { style: "light-heavy", repeat: "backward" },
            ":|": { style: "light-heavy", repeat: "backward" },
            ":|:": { style: "light-light", repeat: "backward" },
            "|.": { style: "light-heavy" },
            "||": { style: "light-light" },
            "|": { style: "regular" },
          };
          const hit = map[st];
          if (!hit) { loss.add("小节线样式 `\\bar`", st, spanAt(i)); break; }
          if (hit.style) bl.style = hit.style;
          if (hit.repeat) bl.repeat = hit.repeat;
          if (st === ":|:") bl.alsoForward = true;
          break;
        }
        case "multirest": {
          // `R*8` = 8 个整小节休止：**展开成 8 个小节**（上游只是把它压缩着画，音乐本来就是 8 小节）。
          // 模型里没有"N 小节休止"这种字段，但小节的个数是真实的，展开一样东西都不丢；
          // 写出端会把连着的整小节休止再压回 `R*N`（见 tojly.ts::multirestOf）。
          const beats = (song.time?.beats ?? 4) * (SIMPLE_DIVISIONS * 4 / (song.time?.beatType ?? 4));
          for (let k = 0; k < tk.n; k++) {
            const m = openMeasure(spanAt(i));
            (m.barlines ??= []).push({ location: "right", style: "regular", source: spanAt(i) });
            m.elements.push({
              kind: "chord", id: ids.next(), notes: [],
              duration: { divisions: Math.round(beats), dots: 0, type: "whole" },
              rest: { measure: true }, voice: 1, staff: 1,
              source: spanAt(i),
            });
            cur = null;
          }
          break;
        }
        case "repeat-open": {
          // `R{` = 反复开始：落在**当前这一小节**的左线上（还没有小节就开一个）
          if (!cur) cur = openMeasure(spanAt(i));
          const lines = cur.barlines ?? (cur.barlines = []);
          const left = lines.find((b) => b.location === "left");
          if (left) left.repeat = "forward";
          else lines.unshift({ location: "left", style: "heavy-light", repeat: "forward", source: spanAt(i) });
          repeats.push({ rStart: part.measures.length - 1, rEnd: -1, aStart: -1, aEnd: -1 });
          break;
        }
        case "alt-open": {
          // `A{` = 第二遍（第二房）开始：上一小节收掉第一房，这一小节起第二房
          const open = repeats[repeats.length - 1];
          if (!open || open.rEnd < 0) { loss.add("反复跳跃 `A{`（前面没有配对的 `}`）", "A{", spanAt(i)); break; }
          if (!cur) cur = openMeasure(spanAt(i));
          // ⚠ 先保证 cur 指向 A 段的第一小节（`A{` 前刚被 `}` 收掉，cur 是空的），再取下标；
          //   若先取 `part.measures.length` 会多算一格（`openMeasure` 已经把这一小节推进去了）。
          open.aStart = part.measures.length - 1;
          break;
        }
        case "percent-open": {
          // `R4{` 小节反复：先记起点与次数，到配对的 `}` 处记成一段；真展开放在**歌词对位之后**做
          //   （见下面那段注释 —— 先展开会把歌词音节分给副本）。
          percentStack.push({ from: part.measures.length, times: tk.times });
          break;
        }
        case "repeat-close": {
          if (percentStack.length) {                       // 收的是小节反复，不是反复跳跃
            const p = percentStack.pop()!;
            // ⚠ 顺手把这一段**收尾**（这个 `}` 就是它的收尾线）：组里没写 `|` 时，收尾线不给出来的话
            //   投影那边没有 `Barline` 就认不出小节边界，展开出来的几小节会被并成一长条
            //   （实测：`R3{ 1 2 3 4 }` 写成 `1 2 3 4 1 2 3 4 1 2 3 4 |`）。
            if (cur && cur.elements.length) {
              (cur.barlines ??= []).push({ location: "right", style: "regular", source: spanAt(i) });
              cur = null;
            }
            percentRanges.push({ from: p.from, to: part.measures.length, times: p.times });
            break;
          }
          const open = repeats[repeats.length - 1];
          if (!open) { loss.add("反复跳跃 `}`（前面没有 `R{` / `A{`）", "}", spanAt(i)); break; }
          // ⚠ `}` 同时也是这一段的**收尾线**：先把进行中的小节收掉再记下标，否则
          //   `R{ 1 2 3 4 } A{ 5 6 7 1 }` 会变成一个 8 拍的小节、反复与房子都丢掉（上游 review 第 3 条）。
          //   （小节反复那条路上面已经这么做了，这里以前漏了。）
          if (cur && cur.elements.length) {
            (cur.barlines ??= []).push({ location: "right", style: "regular", source: spanAt(i) });
            cur = null;
          }
          if (open.aStart >= 0 && open.aEnd < 0) { open.aEnd = part.measures.length - 1; }   // ⚠ 别 pop：收尾要留在表里等后面统一落房号（pop 掉就等于没记）
          else if (open.rEnd < 0) { open.rEnd = part.measures.length - 1; }
          else { loss.add("反复跳跃 `}`（多出来的）", "}", spanAt(i)); }
          break;
        }
        case "grace": {
          // 倚音在模型里是**独立元素**（`Chord.grace`），时值 0；投影时会被收进后一个音的 `graceNotes`。
          // 口径与 123 一致（`{…}` 也这么存）。
          if (!cur) cur = openMeasure(spanAt(i));
          for (const g of tk.notes) {
            const note: Note = { degree: { number: g.degree, octaveShift: g.octave } };
            if (g.alter && ACC[g.alter]) {
              note.accidental = ACC[g.alter] as Note["accidental"];
              note.degree!.accidental = note.accidental;
            }
            cur.elements.push({
              kind: "chord", id: ids.next(), notes: [note],
              duration: { divisions: 0, dots: g.dots, type: graceTypeOf(g.beams) },
              grace: {}, voice: 1, staff: 1,
              source: spanAt(i),
            });
          }
          break;
        }
        case "bar": {
          // ⚠ 小节线要**记进模型**，不能只把当前小节收掉就算了：投影成排版输入时，
          //   小节结构（以及曲行怎么断）全是从 `Measure.barlines` 长出来的。原来这里只写 `cur = null`，
          //   于是整首歌在谱面上是**一根没有小节线的长行**——音符与歌词挤成一团（用户截图就是这个）。
          //   口径与 123 一致：小节里已经有音就是**收尾线**，还没有音就是行首的**左线**。
          const bl: Barline = { location: "right", style: "regular", source: spanAt(i) };
          if (cur && cur.elements.length) {
            (cur.barlines ??= []).push(bl);
            cur = null;
          } else {
            if (!cur) cur = openMeasure(spanAt(i));
            (cur.barlines ??= []).push({ ...bl, location: "left" });
          }
          break;
        }
        case "slur-open":
          // 弧算在**哪个音**头上要看它写在哪儿：jianpu-ly 原样透传，于是
          //   `1 ( 2 3 ) 4` → `c4 ( d4 e4 )`：LilyPond 把 `(` 当**前一个音**的后置事件，弧从 `1` 起，
          //   弧内（`2` `3`，到 `)` 那个音为止）不吃音节 —— 实测 A→1、B→4；
          //   而弧写在最前面（`( 1 2 ) 3 4`）时它算在**下一个音**头上 —— 实测 A→1、B→3、C→4。
          //   两种都要跟：前一个 token 是音就立刻生效，否则等这个音读完再生效（组首自己是吃音节的）。
          if (tk.melisma) {
            if (tokens[i - 1]?.kind === "note") melismaOpen++;
            else pendingMelisma++;
          }
          loss.add(tk.melisma ? "圆滑线 `( )`" : "乐句线 `\\( \\)`", tk.melisma ? "(" : "\\(", spanAt(i));
          break;
        case "slur-close":
          if (tk.melisma) melismaOpen = Math.max(0, melismaOpen - 1);
          break;
        case "tuplet-open": openTuplet = tk.n; break;
        case "tuplet-close": openTuplet = null; break;
        case "tie": pendingTie = true; break;
        case "sustain": {
          const host = cur?.elements[cur.elements.length - 1];
          if (host && host.kind === "chord") {
            host.duration = { ...host.duration, divisions: host.duration.divisions + SIMPLE_DIVISIONS };
            host.sustains = [...(host.sustains ?? []), { id: ids.next(), source: spanAt(i) }];
          } else unknown.push("-");
          break;
        }
        case "note": {
          if (!cur) cur = openMeasure(spanAt(i));
          const divisions = Math.round(SIMPLE_DIVISIONS * Math.pow(2, -tk.beams) * dotFactor(tk.dots));
          const ch: Chord = {
            kind: "chord", id: ids.next(), notes: [],
            duration: { divisions, dots: tk.dots },
            voice: 1, staff: 1,
            source: spanAt(i),
          };
          if (openTuplet !== null) ch.duration.timeMod = { actual: openTuplet, normal: tupletNormal(openTuplet) };
          if (tk.beams > 0) ch.beams = Array.from({ length: tk.beams }, () => "continue" as const);
          let tieStop = false;
          if (tk.degree === 0) {
            ch.rest = {};
          } else {
            const note: Note = { degree: { number: tk.degree, octaveShift: tk.octave } };
            if (tk.alter && ACC[tk.alter]) {
              note.accidental = ACC[tk.alter] as Note["accidental"];
              note.degree!.accidental = note.accidental;
            }
            if (pendingTie) {
              // ⚠ 前一个音要**跨小节**回找（上游 review）：`1 2 3 4 ~ | 4 …` 换小节后 `cur` 是空的，
              //   只在 `cur.elements` 里找会变成"后一个 4 有 tie.stop、前一个 4 却没有 tie.start"。
              //   注意不能改用既有的 `lastChord()`：刚闭合的小节那时还没落进 `part.measures`，它会取到更早的音。
              const pn = prevChordRef?.notes[0];
              if (pn) pn.tie = { ...(pn.tie ?? {}), start: true };
              note.tie = { ...(note.tie ?? {}), stop: true };
              tieStop = true;
              pendingTie = false;
            }
            ch.notes.push(note);
            // 多音和弦：其余各音照同一套落点（变音/八度各自带），但**不**参与连音线那套（线只挂在首音上）。
            for (const extra of tk.chord ?? []) {
              const n2: Note = { degree: { number: extra.degree, octaveShift: extra.octave } };
              if (extra.alter && ACC[extra.alter]) {
                n2.accidental = ACC[extra.alter] as Note["accidental"];
                n2.degree!.accidental = n2.accidental;
              }
              ch.notes.push(n2);
            }
          }
          cur.elements.push(ch);
          prevChordRef = ch;
          // 本音是不是一个歌词位置：启音（倚音）不算、休止不算、已经在圆滑线里（一字多音）的也不算，
          // **被延音线接续的音也不算**（LilyPond 不给它分配音节；算了后面的字会整体前移一位 —— 上游 review）。
          if (tk.degree !== 0 && !ch.grace && melismaOpen === 0 && !tieStop) slots.push(ch);
          melismaOpen += pendingMelisma;      // 本音开的弧线，从下一个音起才吞音节
          pendingMelisma = 0;
          break;
        }
      }
    }
    advance();
  }

  // 换行/换页写在最后一个音之后（后面不再有音符）：挂到最后一个音的 `lineBreakAfter` 上，别丢。
  if (pendingBreak) {
    const lastM = part.measures[part.measures.length - 1];
    const lastEl = lastM?.elements[lastM.elements.length - 1];
    if (lastEl && lastEl.kind === "chord") lastEl.lineBreakAfter = pendingBreak;
    else loss.add("换行/换页（后面没有音）", pendingBreak === "page" ? "\\pageBreak" : "\\break", undefined);
    pendingBreak = null;
  }

  /** 一首曲子的收尾：反复跳跃落房号 → 歌词对位 → `R4{}` 展开 → 和弦符号时间线。
   *  ⚠ 必须在**每次切到下一首之前**对当前曲跑一遍（上游 review 第 4 条）：以前这四步全在主循环之后，
   *    于是只有最后一首被收尾 —— 第一首没歌词、第二首把第一首的词当第 1 段；和弦时间线也因此建在
   *    `R4{}` 展开之前，展开出来的副本被重新数一遍（第 10 条）。
   *  注：反复/小节反复的下标是相对**当前声部**记的（与改动前一致），多声部谱只收当前声部。 */
  function finishSong(): void {
    // 反复跳跃收尾：`}` 记在**反复体最后一小节**的收尾线上（上游那个 `}` 就是 `<repeat backward>`）；
    // `A{ … }` 记成**第二房**（左线 start、右线 stop）—— 与 123 的 `|2 … :|` 同一个落点。
    // 第一遍那一段不另记房号（jianpu-ly 的写法里"反复体本身"就是第一遍，记了反而会把整个体都罩进第一房）。
    for (const r of repeats) {
      if (r.rEnd < 0) continue;
      const last = part.measures[r.rEnd];
      if (last) {
        const lines = last.barlines ?? (last.barlines = []);
        const right = lines.find((b) => b.location === "right");
        if (right) { right.repeat = "backward"; right.style = "light-heavy"; }
        else lines.push({ location: "right", style: "light-heavy", repeat: "backward" });
      }
      if (r.aStart >= 0) {
        const head = part.measures[r.aStart];
        const tail = part.measures[r.aEnd >= 0 ? r.aEnd : part.measures.length - 1];
        if (head) {
          const lines = head.barlines ?? (head.barlines = []);
          const left = lines.find((b) => b.location === "left");
          const ending = { numbers: [2], type: "start" as const, text: "2" };
          if (left) left.ending = ending;
          else lines.unshift({ location: "left", ending });
        }
        if (tail) {
          const lines = tail.barlines ?? (tail.barlines = []);
          const right = lines.find((b) => b.location === "right");
          const ending = { numbers: [2], type: "discontinue" as const, text: "2" };
          if (right) right.ending = ending;
          else lines.push({ location: "right", style: "light-heavy", ending });
        }
      }
    }
    // 歌词按顺序、逐段挂到已读出的音上。**逐位置推进**：这一格没字（占位）也要往下走一格，
    // 否则后面的字会整体前移（上游 README 的"对位"就是这么算的）。挂不满的差额报出来。
    for (const [key, slot] of verses) {
      const verse = Number(key.replace(/[HL]$/, ""));
      let i = 0;
      for (const ch of slots) {
        if (i >= slot.syllables.length) break;
        const syl = slot.syllables[i++]!;
        if (!syl) continue;
        const lyric: Lyric = { number: verse, text: syl.text };
        if (syl.begin) lyric.syllabic = "begin";
        if (slot.span) lyric.source = slot.span;
        ch.lyrics = [...(ch.lyrics ?? []), lyric];
      }
      if (slot.syllables.length > slots.length) {
        loss.add(
          `歌词第 ${verse} 段多出 ${slot.syllables.length - slots.length} 个音节`,
          slot.syllables.slice(slots.length).map((s) => s?.text ?? '""').slice(0, 3).join(" "),
          slot.span,
        );
      }
    }
    // 小节反复 `R4{ 1 2 }`：模型里没有"这一段再唱 N 遍"的字段，**展开成真实小节**（`\repeat percent 4` 的音乐
    //   就是这 2 小节唱 4 遍 = 8 小节；上游只是把重复的几遍印成 ％ 记号）。写出端一律照真实小节写。
    //   ⚠ 必须放在**歌词对位之后**：音节是按 `slots` 逐格发的，展开出来的副本不在 `slots` 里，先展开的话
    //   副本一个词都拿不到（实测：第一遍有词、后面三遍光秃秃），而副本该跟着原件一起有词。
    //   同 id 的副本会让编辑器把副本认成原件，所以复制时每个 `id` 都换新号。
    for (const r of [...percentRanges].sort((a, b) => b.from - a.from)) {
      const base = part.measures.slice(r.from, r.to);
      if (!base.length || r.times < 2) continue;
      const copies: Measure[] = [];
      for (let k = 1; k < r.times; k++) { for (const m of base) copies.push(freshIds(structuredClone(m), ids)); }
      part.measures.splice(r.to, 0, ...copies);
    }
    // 和弦符号行是一条**时间线**（整音符为单位、从本乐章曲首起，divisions 48 = 四分）：
    // 逐个落到"起点 ≤ 该时刻"的最后一个音上（对不齐时往左靠 —— LilyPond 的 `\chordmode` 也是这么对的）。
      // ⚠ 放在 `R4{}` **展开之后**（上游 review 第 10 条）：以前建在展开之前，展开出来的副本会被重新数一遍。
      const songIdx = doc.songs.indexOf(song);
      const theSong = songIdx >= 0 ? doc.songs[songIdx] : undefined;
      if (theSong) {
      const at: { chord: Chord; whole: number }[] = [];
      let acc = 0;
      for (const p of theSong.parts) for (const m of p.measures) for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        at.push({ chord: el, whole: acc / (SIMPLE_DIVISIONS * 4) });
        // ⚠ 连音组里的时值要按 `normal/actual` 折算（上游 review 第 10 条）：`divisions` 记的是
        //   **写出来的名义时值**，而时间线要走**实际**时长（口径同 `beatcheck.ts:59` 的 `raw * normal / actual`）。
        //   不折算的话，三连音之后的和弦全体落到错的音上。
        const tm = el.duration.timeMod;
        acc += tm ? (el.duration.divisions * tm.normal) / tm.actual : el.duration.divisions;
      }
      if (at.length) {
      const total = acc / (SIMPLE_DIVISIONS * 4);
      let t = 0;
      let carried = 0.25;                                 // LilyPond：没写时值就沿用上一个，第一个默认四分
      for (const c of chordTokens.filter((x) => x.song === songIdx)) {
        const whole = c.whole ?? carried;
        carried = whole;
        let pick = at[0]!.chord;
        for (const e of at) { if (e.whole <= t + 1e-6) pick = e.chord; else break; }
        pick.harmony = { root: { step: "C", alter: 0 }, kind: "", text: c.text };
        t += whole;
      }
      if (t > total + 1e-6) {
        loss.add(`和弦符号行比曲子长（超出 ${(t - total).toFixed(2)} 个全音符）`, chordTokens.filter((x) => x.song === songIdx).slice(-1)[0]!.text, undefined);
      }
      }
      }
    // 收尾完清干净，别带到下一首（歌词/反复/小节反复都是**每首各自**的）。
    repeats.length = 0; percentRanges.length = 0; verses.clear(); slots.length = 0;
  }

  finishSong();

  doc.diagnostics = loss.diagnostics();
  return { doc, losses: loss.list(), unknown: [...new Set(unknown)] };
}

// 上游**没有**任何决定性标记可以拿来判"这段文本是不是 jianpu-ly"：没有版本行（不像 ABC 的 `%abc-2.1`
// 或本项目的 `%123-1.0`）、没有签名、也没有必需项 —— 它 README 第一句就是"普通文本文件**以空格分隔**的"，
// `title=` / `4/4` / `1=Bb` 都只是 token，能不能独占一行是**排版偏好**，不是语法。
// 所以这里**不做**内容嗅探（曾经写过 `looksLikeJly`，那只是特征猜测，已删）：
// 判据只有一个 —— 扩展名 `.jly`（那是它自己 `--export-jly` 写出来的后缀，见 README 命令行选项）。
