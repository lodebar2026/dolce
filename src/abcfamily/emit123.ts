// 123 方言的写出端。只回答基类问的那几个问题，其余全在 `emit.ts`。

import { SIMPLE_DIVISIONS, type Chord, type Element, type Key, type Measure, type Note, type Part, type Song } from "../model/doc";
import { AbcFamilyEmitter, type MarkIndex } from "./emit";
import { BARE_CHORD_RE } from "./dialect123";
import { directionsAsMarks } from "../model/directionmarks";
import { projectForJianpu } from "../model/jianpuproject";
import { layersToVoices } from "../model/innervoice";
import { clefName, harmonyText, melodyLane, noteHeight, topNote } from "../model/jianpu";
import { tonicSpelling } from "../model/keyshift";

/** 倚音时值相对八分：下标 = `_` 个数（八分不写，`{2_}` 十六分）。四分倚音写不出，按八分 */
const GRACE_TYPES = ["eighth", "16th", "32nd", "64th"];

const ACC_TEXT: Readonly<Record<string, string>> = {
  sharp: "#",
  flat: "b",
  natural: "n",
  "double-sharp": "##",
  "double-flat": "bb",
};

export class Emitter123 extends AbcFamilyEmitter {
  protected readonly versionLine = "%123-1.0";
  protected override readonly tiesAsSlurs = true;
  protected override readonly inlineClefs = true;
  protected override readonly multiRests = true;
  protected override readonly rehearsalMarks = true;
  protected override readonly spaceBeams = false;

  /** 一个 `V:` 只写一条谱表：简谱印的那一路（`melodyLane`）所在的谱表。同一谱表上的别的 voice 照 ABC §7.4 用 `&` 接在后面
   *  （规范 §4.3）；别的谱表（钢琴下谱表）写不出，由 `planSave` 报「extraStaff」丢失。
   *  每一路里同时发声的几个音写和音 `[13]`（规范 §4.2，照 ABC §4.17 `[CEG]`），自下而上；
   *  画小的上方装饰音（`<type size="cue">`）不算。 */
  protected override emits(el: Element, mea: Measure): boolean {
    if (el.kind !== "chord") return true;
    const lane = melodyLane(mea);
    return !lane || el.staff === lane.staff;
  }

  /** 小节内的第二声部（ABC §7.4）。 */
  protected override readonly overlayText = "&";

  /** 分支不从小节起点开始时，前面用不可见休止 `x` 占住：整拍一个 `x`，余下的按减时线拆（`x_`、`x__`…）。 */
  protected override overlayPad(divisions: number): string {
    const out: string[] = [];
    let q = divisions / SIMPLE_DIVISIONS;
    for (; q >= 1 - 1e-9; q -= 1) out.push("x");
    for (let k = 1; k <= 6 && q > 1e-9; k++) {
      const len = 2 ** -k;
      if (q >= len - 1e-9) {
        out.push("x" + "_".repeat(k));
        q -= len;
      }
    }
    return out.join(" ");
  }

  protected override chordNotes(ch: Chord): Note[] {
    const normal = ch.notes.filter((n) => n.typeSize !== "cue");
    const pool = normal.length > 0 ? normal : ch.notes;
    if (pool.length < 2) {
      const top = topNote(ch);
      return top ? [top] : [];
    }
    return [...pool].sort((a, b) => noteHeight(a) - noteHeight(b));
  }

  protected override chordGroupText(inner: string, noteCount: number): string {
    return noteCount > 1 ? `[${inner}]` : inner;
  }

  /** 和弦名合规就**不带引号**（`F 3-`），后面必须跟空格——读入端按「到空白为止」切，123 的空格又不管分组。
   *  `N.C.` 这类不合规的仍写引号形。 */
  protected override chordSymbolText(text: string): string {
    return BARE_CHORD_RE.test(text) ? `${text} ` : `"${text}"`;
  }

  /** 声部名（多声部时）之外再写谱号：八度谱号 `clef=treble-8`（简谱按高八度记的男声部，`writtenOctaveOf`）；
   *  低音、中音谱号也写（简谱上不印，五线谱档要它，声部面板改了谱号要能存回）——单声部也写
   *  （大提琴分谱转过来以前丢了低音谱号，五线谱改排高音谱号）。单声部的高音谱号不写。 */
  protected override voiceAttrs(part: Part, multi: boolean): string {
    const c = part.measures[0]?.attrs?.clefs?.find((x) => (x.staff ?? 1) === 1);
    const treble = !c || (c.sign === "G" && (c.line ?? 2) === 2);
    const name = c && (c.octaveChange || !treble) ? clefName(c) : null;
    return [super.voiceAttrs(part, multi), name ? `clef=${name}` : ""].filter(Boolean).join(" ");
  }

  /** `$` 后换行：一行曲一行源码，方便与源图逐行对照。123 的代码换行不是谱面换行，读回不变。 */
  protected override breakText(newPage: boolean): string {
    return newPage ? "$$\n" : "$\n";
  }

  /** 混合拍：页眉并排印着的几个拍号都写进 `M:`（`M:3/4 4/4 混合拍`，见规范 §3）。
   *  辅助拍号写在括号里的（文本谱 `P: 4/4 ( 2/4 )`）照原样带括号写出。 */
  protected override timeValue(song: Song): string | null {
    if (!song.time) return null;
    const parts: string[] = [];
    let inParen = false;
    for (const t of [song.time, ...(song.extraTimes ?? [])]) {
      const paren = t.parenthesized === true;
      if (!paren && inParen) parts[parts.length - 1] += ")";
      parts.push((paren && !inParen ? "(" : "") + `${t.beats}/${t.beatType}`);
      inParen = paren;
    }
    if (inParen) parts[parts.length - 1] += ")";
    return parts.join(" ") + (song.timeNote ? ` ${song.timeNote}` : "");
  }

  /** MusicXML 读进来的歌先投成简谱形状：123 的 `-` 是增时线、`_` 是减时线，照 MusicXML 的 type/beam 直写会写错时值 */
  override emitSong(song: Song, fallbackNumber?: number): string {
    // 文本谱的 `{dsb…}` 并排块还原成第二声部，照 `&` 写
    return super.emitSong(projectForJianpu(directionsAsMarks(layersToVoices(song))), fallbackNumber);
  }

  /** 度数 + 八度点。变音记号**前置**（简谱惯例）。 */
  protected noteText(n: Note): string {
    const d = n.degree;
    if (!d) {
      // 只有绝对音高、没有度数（从 MusicXML 来且还没换算）——写成 0 并留给调用方报降级
      return n.pitch ? "0" : "";
    }
    let s = "";
    if (d.accidental) s += ACC_TEXT[d.accidental] ?? "";
    s += String(d.number);
    s += d.octaveShift > 0 ? "'".repeat(d.octaveShift) : ",".repeat(-d.octaveShift);
    return s;
  }

  /** 节奏音符：打击乐谱读进来的带谱表位置 `X@E5`，同时敲的几个写 `[X@E5X@F5]`（规范 §4.2） */
  protected override rhythmText(ch: Chord): string {
    const one = (n: Note | undefined): string => "X" + (n?.unpitched?.step ? `@${n.unpitched.step}${n.unpitched.octave ?? 4}` : "");
    return ch.notes.length > 1 ? `[${ch.notes.map(one).join("")}]` : one(ch.notes[0]);
  }

  /** `printObject === false` 是**不可见休止**，123 有专门的 `x`，写成 `0` 会丢掉「不可见」。 */
  protected restText(ch: Chord): string {
    return ch.printObject === false ? "x" : "0";
  }

  protected durationText(el: Element): string {
    const beams = el.kind === "chord" ? el.beams?.length ?? 0 : el.beams?.length ?? 0;
    const dots = el.kind === "chord" ? el.duration.dots : el.duration?.dots ?? 0;
    return "_".repeat(beams) + ".".repeat(dots);
  }

  /** 倚音时值相对八分：`{2}` 八分、`{2_}` 十六分（沿用 ABC §4.12 倚音自有单位的口径）。 */
  protected override graceDurationText(ch: Chord): string {
    return "_".repeat(Math.max(0, GRACE_TYPES.indexOf(ch.duration.type ?? "eighth")));
  }

  /** 增时线（各自可带弧的起止）。**这是 123 独有的**：ABC 的 `-` 是 tie。 */
  protected override sustainsText(ch: Chord, mi?: MarkIndex): string {
    let s = "";
    for (const su of ch.sustains ?? []) {
      s += "(".repeat(mi?.slurStart.get(su.id) ?? 0);
      s += su.harmony ? ` ${this.chordSymbolText(harmonyText(su.harmony))}-` : "-";
      s += ")".repeat(mi?.slurEnd.get(su.id) ?? 0);
    }
    return s;
  }

  /** 写了调式的照 ABC 调式形写回（`Em`、`Ddor`），否则写简谱首调形 `1=X` / `6=E`。 */
  protected keyValue(k: Key): string {
    if (k.spelling === "none") return "none";
    const sp = tonicSpelling(k);
    if (k.mode && k.mode !== "major" && k.mode !== "ionian") return sp + (k.mode === "minor" ? "m" : k.mode.slice(0, 3));
    return `${k.tonicDegree ?? "1"}=${sp}`;
  }
}

export const EMITTER_123 = new Emitter123();
