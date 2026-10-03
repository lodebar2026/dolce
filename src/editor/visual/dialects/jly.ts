// jianpu-ly 的可视化编辑方言（`editor/visual/dialect.ts::EditDialect`）。
//
// 与 `dialects/j123.ts` 的差别，逐条对着上游 README（v1.890）写：
//   · **词内顺序无关**（`#1`=`1#`、`'1`=`1'`、`s1`=`1s`）——所以读的时候按字符归类，不按固定位置。
//   · **时值是字母**：`q`=8分、`s`=16分、`d`=32分、`h`=64分、无字母=4分（123 用 `_` 减时线）。
//     规范写法（写回时用）：**字母在音高之前**（`s1.`），与 README 的 `s1. q1. 1.` 同形。
//   · **连音是 `3[ … ]`**（123 是 `(3: … )`）——方括号成组，收尾是 `]`。
//   · **装饰写 `\名字` 且在音符之后**（LilyPond 原样透传）；力度（`\mf`）同理。
//   · **行结构不是语义**（README：普通文本文件以空格分隔）→ **换行就写真换行**，
//     绝不写 123 那个 `$`（jianpu-ly 不认它，写进去就是往谱里塞垃圾 ✗）。
//   · 增时线是**独立 token** `-`（与 123 同）✓。

import { BARE_CHORD_RE } from "../../../abcfamily/dialect123";
import { chordTimeline, harmonyToChordToken } from "../../../model/jlychords";
import { isJlyMusicLine } from "../../../model/fromjly";
import { t as tr } from "../../../i18n";
import { mapper, type EditCtx, type EditOutcome } from "../ops";
import type { SyncEntry } from "../../sync";
import type { Accidental } from "../../../model/doc";
import { dotsRange, type EditDialect, type NoteDuration, type NoteToken } from "../dialect";

const ACC_OF: Record<string, Accidental> = {
  "#": "sharp", b: "flat", n: "natural", "##": "double-sharp", bb: "double-flat",
};
const ACC_TEXT: Partial<Record<Accidental, string>> = {
  sharp: "#", flat: "b", natural: "n", "double-sharp": "##", "double-flat": "bb",
};

/** 减时线条数 ↔ 字母（README：`s` 十六分、`q` 八分、`d` 三十二分、`h` 六十四分；0 = 四分）。 */
const LETTER_BY_BEAMS: readonly string[] = ["", "q", "s", "d", "h"];
const BEAMS_BY_LETTER: Readonly<Record<string, number>> = { q: 1, s: 2, d: 3, h: 4 };

/** 一个词里的音符：变音 / 数字 / 八度 / 字母时值 / 附点，**顺序任意**（重复或认不出的字符 → null）。 */
function scan(src: string): { acc: Accidental | null; degree: number; octave: number; beams: number; dots: number } | null {
  let acc: Accidental | null = null;
  let degree: number | null = null;
  let octave = 0;
  let beams = 0;
  let dots = 0;
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    const ch = src[i]!;
    if (!acc && ACC_OF[two]) { acc = ACC_OF[two]!; i += 2; continue; }
    if (ACC_OF[ch] && !acc) { acc = ACC_OF[ch]!; i += 1; continue; }
    if (ch === "'") { octave++; i++; continue; }
    if (ch === ",") { octave--; i++; continue; }
    if (ch === ".") { dots++; i++; continue; }
    if (BEAMS_BY_LETTER[ch] !== undefined && beams === 0) { beams = BEAMS_BY_LETTER[ch]!; i++; continue; }
    if (/[0-7]/.test(ch) && degree === null) { degree = Number(ch); i++; continue; }
    return null;
  }
  if (degree === null) return null;
  return { acc, degree, octave, beams, dots };
}

export const DIALECT_JLY: EditDialect = {
  parseNote(src) {
    const t = scan(src);
    if (!t) return null;
    return {
      acc: t.degree === 0 ? null : t.acc,
      degree: t.degree,
      octave: t.octave,
      halvings: t.beams,
      dots: t.dots,
      pre: "",
      post: "",
      inlineSustains: 0,
    };
  },
  /** 规范写法：`字母 + 变音 + 数字 + 八度 + 附点`（与 README 的 `s1.` 同形）。 */
  printNote(t: NoteToken) {
    const acc = t.acc && t.degree !== 0 ? ACC_TEXT[t.acc] ?? "" : "";
    const oct = t.octave > 0 ? "'".repeat(t.octave) : ",".repeat(-t.octave);
    const letter = LETTER_BY_BEAMS[t.halvings] ?? "";
    return `${t.pre}${letter}${acc}${t.degree}${oct}${".".repeat(t.dots)}${t.post}`;
  },
  noteParts(src) {
    const t = scan(src);
    if (!t) return null;
    // 音头 = 到附点之前（含字母/变音/数字/八度）；附点是末尾那一串 `.`
    const dotsStart = src.length - t.dots;
    const dots = dotsRange(".".repeat(t.dots), Math.max(0, dotsStart));
    return { head: [0, Math.max(0, dotsStart)], dots: dots ?? [dotsStart, src.length] };
  },
  newNote(degree: number, dur: NoteDuration) {
    const letter = LETTER_BY_BEAMS[dur.halvings] ?? "";
    return `${letter}${degree}${".".repeat(dur.dots)}`;
  },
  /** 超过 4 条减时线（64 分）jianpu-ly 的字母就写不出来了 —— 如实拒绝，别硬写。 */
  validate(t) {
    if (t.halvings > 4) return "jianpu-ly 的时值字母只到 64 分（`h`），再短写不出来";
    return null;
  },
  // 装饰与力度走 LilyPond 原样指令，**写在音符之后**（`1 \fermata`）
  deco: { names: { fermata: "fermata", accent: "accent" }, text: (n) => `\\${n}`, place: "after" },
  annotationText: (t) => `^"${t}"`,
  dynamicText: (n) => `\\${n}`,
  // 连音：`3[ q1 q1 q1 ]`（与 123 的 `(3: … )` 不同）
  tuplet: { open: (n) => `${n}[ `, close: " ]", openRe: /\d+\[\s*$/ },
  sustain: "token",
  sep: " ",
  barline: "|",
  // **不是 `$`**：jianpu-ly 的行就是普通的换行，写 `$` 它不认（见文件头）。
  lineBreak: "\n",
  pageBreak: "\n",
  slurOpen: "(",
  slurClose: ")",
  slurInToken: false,
  slurNesting: true,
  lyricsFollowBreaks: true,
  // 和弦名不在音符旁边（在文件头上的 `chords=` 行上），走自己的写法 —— 见下面的 `chordEdit`
  chordEdit,
};

/** 和弦名：jianpu-ly 的和弦**不在音符旁边**，而在文件头上一条 `chords=` 行上（`c2. g:7 c`，
 *  token 是 LilyPond 和弦语法 + 时值，靠时值排成时间线）。所以不给 `chordText`（那会往曲行里
 *  插一个上游不认的词 ✗），改用 `chordEdit` 按时间线改那一行。 */
export const JLY_CHORD_UNSUPPORTED = BARE_CHORD_RE;

/** 谱上点一个音、改它的和弦名：算出这个音在曲首起的时间线里落在哪，去改 `chords=` 那一行。
 *
 *  时间线怎么算（与读入端同一套）：逐行扫曲行，音符按减时线字母（`q` 八分…）折成四分音符数，
 *  `-` 各加一拍（增时线是"延长前一个音"，所以它只把后面的音往后推）；休止、圆滑线等不推时间。
 *  ⚠ 和弦 token 的时值以**全音符**为 1（`c2.` = 附点二分），所以时间线除以 4 再对位。 */
function chordEdit(ctx: EditCtx, note: SyncEntry, name: string): EditOutcome {
  const s = ctx.state;
  const text = s.doc.toString();
  if (name.includes('"')) return { error: tr("ve.chordQuote") };
  // ① 这个音在时间线上的位置（四分音符 → 全音符）
  const quarters = quartersBefore(text, note.from);
  if (quarters === null) return { error: tr("ve.chordSrcOnly") };
  const start = quarters / 4;
  // ② 现有 `chords=` 行（只认一行写法；多行写法会被改写成一行 —— 上游不看行，语义一样）
  const row = findChordRow(text);
  const line = chordTimeline(row ? row.body.split(/\s+/).filter(Boolean) : []);
  if (!row && name === "") return { error: tr("ve.noChord") };
  // ③ 新的和弦表：原样留下别的格，落在同一时刻的那一格换成新名字（空名字 = 删掉）。
  //    被"插进中间"的那一格不用手工切短：写回时每格的时值 = 到下一格为止，自动就是切短的。
  const out: { text: string; at: number }[] = [];
  for (const t of line) {
    if (Math.abs(t.at - start) < 1e-6) continue;                       // 同一时刻：换掉 / 删掉
    out.push({ text: t.text, at: t.at });
  }
  if (name !== "") out.push({ text: name, at: start });
  out.sort((a, b) => a.at - b.at);
  if (!out.length) return done(ctx, [{ from: row!.from, to: row!.to, insert: "" }]);   // 一个不剩：整行去掉
  // ④ 逐个写回 token：时值 = 到下一个和弦为止，最后一个到曲末（上游自己生成这行时就是这么写的）
  const musicEnd = musicWhole(text);
  const toks: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const next = out[i + 1]?.at ?? Math.max(musicEnd, c.at + 0.25);
    const tok = harmonyToChordToken(c.text, Math.max(1 / 64, next - c.at));
    if (!tok) return { error: tr("ve.chordUnwritable", { name: c.text }) };
    toks.push(tok);
  }
  const body = toks.join(" ");
  if (row) return done(ctx, [{ from: row.bodyFrom, to: row.to, insert: body }]);
  // 还没有这一行：插到**第一个曲行之前**（上游收到哪儿都认，这是最稳的位置）
  const at2 = firstMusicLineFrom(text);
  return done(ctx, [{ from: at2, to: at2, insert: "chords=" + body + "\n" }]);
}

/** 从曲首到 `pos` 为止有多少个四分音符（走不动返回 null）。 */
function quartersBefore(text: string, pos: number): number | null {
  let quarters = 0;
  let i = 0;
  for (const line of text.split("\n")) {
    if (i >= pos) break;
    if (isJlyMusicLine(line)) {
      // 逐**词**走，词的位置用正则取 —— 用 `indexOf` 找一个重复出现的词会算错（`1 1 1` 那种）
      const re = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (i + m.index >= pos) return quarters;      // 目标音就是这个词（或更前一个）
        const w = m[0];
        if (w === "-") { quarters += 1; continue; }
        if (/^\|+$/.test(w) || w === "(" || w === ")" || w === "\\(" || w === "\\)" || w === "~" || w === "]") continue;
        const n = scan(w);
        // ⚠ 时值单位是**四分音符 = 1**：`q` 八分 = 0.5、`s` 十六分 = 0.25、没有字母 = 1。
        //    写成 `4 / 2 ** beams` 就把它当成"拍数"了 —— 八分会算成 2 拍，整首的时间线全部偏大
        //    （实测：8 小节的曲子算成 30.5 个全音符，和弦时值写出 `a2*59` 这种怪物）。
        if (n) quarters += (1 / 2 ** n.beams) * dotValue(n.dots);
      }
    }
    i += line.length + 1;
  }
  return quarters;
}

const dotValue = (dots: number): number => (dots === 0 ? 1 : 2 - 2 ** -dots);

/** 曲子的总长度（全音符）。 */
function musicWhole(text: string): number {
  return quartersBefore(text, text.length) === null ? 1 : quartersBefore(text, text.length)! / 4;
}

/** `chords=` 那一行（一行写法）：行首、body 起止。 */
function findChordRow(text: string): { from: number; to: number; bodyFrom: number; body: string } | null {
  const re = /^chords\s*=/im;
  const m = re.exec(text);
  if (!m) return null;
  const from = m.index;
  const nl = text.indexOf("\n", from);
  const to = nl < 0 ? text.length : nl;
  const bodyFrom = from + m[0].length;
  return { from, to, bodyFrom, body: text.slice(bodyFrom, to) };
}

/** 第一个曲行在原文里的偏移（`chords=` 要插在它前面；没有曲行就插在最后）。 */
function firstMusicLineFrom(text: string): number {
  let i = 0;
  for (const line of text.split("\n")) {
    if (isJlyMusicLine(line)) return i;
    i += line.length + 1;
  }
  return text.length;
}

function done(ctx: EditCtx, changes: { from: number; to: number; insert: string }[]): EditOutcome {
  const sel = ctx.state.selection.main;
  const map = mapper(ctx.state, changes);
  return { changes, anchor: map(sel.anchor, 1), head: map(sel.head, 1) };
}


