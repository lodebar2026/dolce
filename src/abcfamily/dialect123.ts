// 123 方言的音乐体：**唯一偏离 ABC 之处**（规范 §4）。
//
// 与 ABC 的两处硬冲突（必须记住）：
//   `-` 在 ABC 是 tie，在 123 是**增时线**（加一拍）
//   `_` 在 ABC 是降号，在 123 是**减时线**（时值减半）
// 所以 123 的音乐体不是合法 ABC 音乐体——这是方言的代价，也是唯一的代价。
//
// 符杠**按拍自动算**，空白不表示分组（偏离 ABC §4.7，见 `ParseDialect.spaceBeams`）。

import type { Accidental } from "../model/doc";
import { AbcFamilyLexer } from "./lex";
import type { DurationScan, NoteScan } from "./types";
import { t as tr } from "../i18n";

const ACCIDENTALS: Readonly<Record<string, Accidental>> = {
  "#": "sharp",
  b: "flat",
  n: "natural",
  "##": "double-sharp",
  bb: "double-flat",
};

/** 不带引号的和弦名（规范 §8.1）：根音 + 性质/延伸 + 可选低音；升降号可写在字母前（`#Fm`、`D/#F`，中文简谱的写法）。
 *  写出端拿它决定能不能省引号（`emit123.ts`），所以**不能放进空白、引号、`%`**——读回时按「到空白为止」切。 */
export const BARE_CHORD_RE = /^(?:[#b][A-G]|[A-G][#b]?)[A-Za-z0-9#+\-°ø()]*(?:\/(?:[#b][A-G]|[A-G][#b]?))?$/;

export class Lexer123 extends AbcFamilyLexer {
  readonly id = "123" as const;
  /** `-` 是增时线，加一拍。 */
  protected readonly hyphen = "sustain" as const;
  /** 音符是数字，裸 `(3` 与「圆滑线 + 音符 3」冲突，所以冒号必需。 */
  protected readonly tupletNeedsColon = true;
  /** 后置 `~` = 弧连到下一个音（规范 §4.1：括号只许嵌套，从多连音里连到组外相邻音靠它）。 */
  protected override readonly arcNextTilde = true;
  /** 大写 `X` 是节奏音符（ABC 里 X 不是音名、123 也没占用）。 */
  protected override readonly rhythmLetters = "X";
  /** `&`：小节内的第二声部（ABC §7.4，规范 §4.3）。 */
  protected override readonly voiceOverlay = true;
  protected override readonly rhythmPositions = true;

  /** 不带引号的和弦：**大写 A–G 开头（或 `#`/`b` 紧跟大写 A–G）、读到空白为止、后面必须跟空格**。
   *  123 音乐体里 A–G 没有别的用处（音符是数字、节奏音符是 `X`、行内字段以 `[` 起头），不会撞；
   *  音符的升降号后面跟的是数字（`#4`、`b7`），跟大写字母的只能是和弦。
   *  到空白为止是为了切得开：`G71`、`Bb3` 这种粘连读不出是 `G7`+`1` 还是 `B`+`b3`。 */
  protected override scanBareChord(line: string, i: number): { len: number; error?: string } | null {
    if (!/[A-G]/.test(line[i] ?? "") && !/^[#b][A-G]/.test(line.slice(i, i + 2))) return null;
    let j = i + 1;
    while (j < line.length && line[j] !== " " && line[j] !== "\t") j++;
    const body = line.slice(i, j);
    const res: { len: number; error?: string } = { len: j - i };
    if (j >= line.length) res.error = tr("diag.abc.chordSpace", { body });
    else if (!BARE_CHORD_RE.test(body)) res.error = tr("diag.abc.badChord", { body });
    return res;
  }

  /** 123 的休止是 `0`，当成 degree 0 的音符走 `scanNote`，这里只认整小节休止 `Z` / `Zn`
   *  （ABC §4.6 同写法：`Z` 一小节，`Z4` 四小节，五线谱、简谱都印成一个多小节休止）。 */
  protected scanRest(line: string, i: number): DurationScan | null {
    const m = /^Z(\d*)/.exec(line.slice(i));
    if (!m) return null;
    return { beams: 0, dots: 0, bars: m[1] ? Math.max(1, Number(m[1])) : 1, next: i + m[0].length };
  }

  /** 时值修饰：`_` 减时线（可多条）与 `.` 附点（可多个），两者可交替出现。 */
  protected scanDuration(line: string, i: number): DurationScan | null {
    let beams = 0;
    let dots = 0;
    let j = i;
    while (j < line.length) {
      if (line[j] === "_") {
        beams++;
        j++;
      } else if (line[j] === ".") {
        dots++;
        j++;
      } else break;
    }
    if (j === i) return null;
    return { beams, dots, next: j };
  }

  /** 和音 `[13]` `[1,5]` `[#46']`（照 ABC §4.17 的 `[CEG]`）：`[` 后紧跟两个以上的音（不含休止）、中间不留空格、`]` 收住；
   *  时值写在 `]` 后面、几个音共用（`[13]_.`），括号里的音不带时值，可后跟 `~` 单连这一个音（`[1~3]`）。
   *  这样与房号 `[1 …`（后面跟空格）分得开。 */
  protected override scanChordGroup(line: string, i: number): { text: string; notes: NoteScan[]; dur: DurationScan | null } | null {
    if (line[i] !== "[") return null;
    // 同时敲的几个节奏音符 `[X@E5X@F5]`（打击乐谱一拍里钹与鼓同时），只许全是 `X`
    const rh = /^\[((?:X(?:@[A-G]\d)?){2,})\]/.exec(line.slice(i));
    if (rh) return { text: rh[0], notes: [], dur: this.scanDuration(line, i + rh[0].length) };
    const notes: NoteScan[] = [];
    let k = i + 1;
    while (k < line.length && line[k] !== "]") {
      const n = this.scanNote(line, k);
      if (!n || n.degree === 0 || n.beams || n.dots) return null;
      notes.push(n);
      k = n.next;
      // 音后的 `~`：只这一个音连到下一个和音里的同音（同 ABC `[C-E]` 的 tie）
      if (line[k] === "~") k++;
    }
    if (line[k] !== "]" || notes.length < 2) return null;
    return { text: line.slice(i, k + 1), notes, dur: this.scanDuration(line, k + 1) };
  }

  /** `[` 后不留空格一直写到 `]`、又不是合规和音的（`[03]` `[1X]` `[13_]` `[1]`）：房号后面总跟空格，这只能是写错的和音 */
  protected override malformedChordGroup(line: string, i: number): { message: string; len: number } | null {
    const m = /^\[[\d#bnX][^\s[\]|"!]*\]/.exec(line.slice(i));
    if (!m || this.scanChordGroup(line, i)) return null;
    return { message: tr("diag.j123.badChordGroup", { text: m[0] }), len: m[0].length };
  }

  /** 音符：`[#b n]数字['`,]*[_.]*`。变音记号**前置**（简谱惯例，与 ABC 的 `^_=` 不同）。 */
  protected scanNote(line: string, i: number): NoteScan | null {
    let j = i;
    let accidental: Accidental | undefined;
    // 双升降先试（`##4` / `bb7`）
    const two = line.slice(j, j + 2);
    if (ACCIDENTALS[two] && /[0-7]/.test(line[j + 2] ?? "")) {
      accidental = ACCIDENTALS[two];
      j += 2;
    } else {
      const one = line[j]!;
      if (ACCIDENTALS[one] && /[0-7]/.test(line[j + 1] ?? "")) {
        accidental = ACCIDENTALS[one];
        j += 1;
      }
    }
    const d = line[j];
    if (d === undefined || !/[0-7]/.test(d)) return null;
    const degree = Number(d);
    j++;
    // 八度点
    let octave = 0;
    while (j < line.length) {
      if (line[j] === "'") {
        octave++;
        j++;
      } else if (line[j] === ",") {
        octave--;
        j++;
      } else break;
    }
    const dur = this.scanDuration(line, j);
    const res: NoteScan = {
      degree,
      octave,
      beams: dur?.beams ?? 0,
      dots: dur?.dots ?? 0,
      next: dur?.next ?? j,
    };
    if (accidental) res.accidental = accidental;
    return res;
  }
}

/** 单例——词法器无状态。 */
export const LEXER_123 = new Lexer123();
