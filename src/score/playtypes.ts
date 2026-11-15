// 演唱顺序、试听时间轴的数据类与输入 / 产物形状。判据在 Rust（crates/dolce-play），TS 侧经 `score/play.ts` 调；
// 这里只留胶水要用的类型：`ScoreDoc` 两侧拼输入（MusicXML 形状 `model/playdoc.ts`、简谱形状 `jianpu/playsong.ts`），
// 消费者读产物（试听 `editor/player.ts`、投影档 `jianpu/expand.ts::walkPlay`、`.jpwabc` 写出端）。
// 拼输入搬进 Rust（迁移计划 M5）后这些形状随之删掉。

import { Fraction } from "../common/fraction";
import type { ElementId } from "../model/doc";
import type { BarStyle, StartStopDiscontinue } from "./enums";

// ───────────────────────── 演唱顺序：产物 ─────────────────────────

export enum PlaySpecKind {
  Dacapo,
  DalSegno,
  ToCoda,
  Fine,
}

export class JumpSpec {
  value: unknown = null;
  constructor(public kind: PlaySpecKind) {}
}

export class TimePosition {
  mid = 0;
  pass = 0;
  offset = new Fraction(0);
  constructor(m?: number, t?: Fraction) {
    if (m !== undefined && t !== undefined) {
      if (m < 0) throw new Error("");
      this.mid = m;
      this.offset = t;
    }
  }
}

export class PlayItem extends TimePosition {
  end = 0;
  endOfPass = false;
  /** 首小节要跳过的和弦个数（弱起式接入，`.Repeat` 里写作 `11.2-20V4`）。 */
  skip = 0;
  /** 末小节只取前这么多个和弦（-1 = 整节，`.Repeat` 里写作 `11.1-11.1V1`）。 */
  limit = -1;
  /** 从这一小节起接在前面同一行末尾、不另起一行（只在最后一遍唱的「阿们」结尾，`lastVerseTail`） */
  glueFrom = -1;
  /** 按 `P:` 排的：这一项所在段落的小节。`pass` 是段内第几行词，「这一行词唱完了」只在这些小节里判（dolce-play `timeline.rs`、`place/expand.ts`） */
  scope?: ReadonlySet<number>;
  /** 按 `P:` 排的：这一项是进入一个段落（投影档进段不换页，`walkPlay`） */
  sectionEntry?: boolean;
  /** 逐遍演唱顺序（123 `%%sing` 的 `/`）：这一项之后换行 */
  lineAfter?: boolean;
  /** 逐遍演唱顺序：一遍的第一项带这一遍单独改的参数（`[rows=5]`） */
  page?: { rows?: number };
  clone(): PlayItem {
    const p = new PlayItem();
    p.mid = this.mid;
    p.pass = this.pass;
    p.offset = this.offset;
    p.end = this.end;
    p.endOfPass = this.endOfPass;
    p.skip = this.skip;
    p.glueFrom = this.glueFrom;
    if (this.sectionEntry) p.sectionEntry = true;
    if (this.lineAfter) p.lineAfter = true;
    if (this.page) p.page = this.page;
    p.limit = this.limit;
    p.scope = this.scope;
    return p;
  }
}

export class PlayData {
  coda = new Map<string, TimePosition>();
  segno = new Map<string, TimePosition>();
  jumpTo = new Map<TimePosition, JumpSpec>();
  measures: PlayItem[] = [];
  hasRepeat = false;
  isSimpple = false; // no repeat, only multiple verse
  /** 第一处漏写 `:|` 的房（小节下标，见 `PlayOrder.impliedRepeat`）；没有为 -1 */
  impliedRepeat = -1;
  /** 顺序来自头部 `P:`：没唱的小节是作者定的 */
  fromSections = false;
  /** 顺序来自逐遍演唱顺序（123 `%%sing`）：投影档照 `endOfPass` / `lineAfter` 逐页逐行排，不再推断 */
  fromSing = false;
  /** 谱面速度（♩= 每分钟拍数）。0 = 未标注，试听/导出用默认值（crates/dolce-play `timeline::TEMPO`）。
   *  来源：MusicXML `<sound tempo>` / OMR 页眉的 `♩=76` / .jpwabc `.Title` 的 `Tempo`。 */
  tempo = 0;

  /** 没有反复、跳转（`.jpwabc` 写出端据此不写 `.Repeat`） */
  get noRepeat(): boolean {
    if (this.hasRepeat) return false;
    if (this.coda.size > 0 || this.segno.size > 0) return false;
    if (this.jumpTo.size > 0) return false;
    return true;
  }
}

// ───────────────────────── 演唱顺序：输入形状 ─────────────────────────

export interface PlayLyric {
  readonly number: number;
  /** 字面（行首可能带印刷段号「1.2.」，见 dolce-play `playorder::label_passes`） */
  readonly text?: string;
}

export interface PlayNote {
  readonly tieStart: boolean;
  readonly tieEnd: boolean;
  readonly lyrics: readonly PlayLyric[];
}

export interface PlayChord {
  readonly notes: readonly PlayNote[];
  /** 小节内位置（四分音符为 1） */
  readonly position: Fraction;
  readonly slurStart: boolean;
  readonly slurEnds: number;
}

export interface PlayMeasure {
  /** 和弦与其它条目混排；只取 `isPlayChord` 为真的那些。 */
  readonly entries: readonly object[];
  /** 小节时值（末和弦的位置 + 时值）。**没有和弦时抛错**，与 `layout/input.ts::measureDuration` 同口径。 */
  readonly duration: Fraction;
  readonly repeatBackward: boolean;
  readonly repeatForward: boolean;
  readonly endingLeft: boolean;
  readonly endingNum: ReadonlySet<number> | null;
  readonly endingRight: StartStopDiscontinue | null;
  /** 小节右边的小节线样式（没写 = 普通细线） */
  readonly barline?: BarStyle | null;
}

export interface PlayPart {
  /** 按各声部共用的时间轴排（`model/timeaxis.ts`）：这一声部在某格没有小节就是 undefined。
   *  `parts[0]` 读反复、房号、小节线，须每格都有（简谱形状给的是「每格的代表小节」，见 `jianpu/playsong.ts`） */
  readonly measures: readonly (PlayMeasure | undefined)[];
}

/** 跳转记号与其落点。键的**插入次序**有意义（同一小节几个记号按它先后判）。 */
export interface PlayJumps {
  readonly coda: ReadonlyMap<string, TimePosition>;
  readonly segno: ReadonlyMap<string, TimePosition>;
  readonly jumpTo: ReadonlyMap<TimePosition, JumpSpec>;
}

export function isPlayChord(e: object): e is PlayChord {
  return "notes" in e && "slurEnds" in e;
}

export interface PlayOrder {
  measures: PlayItem[];
  /** 没有反复、只是多段歌词逐段一遍 */
  isSimple: boolean;
  /** 谱面有 `:|` */
  hasRepeat: boolean;
  /** 第一处封口却没写 `:|`、紧跟着下一房的房（小节下标），按反复回头唱；没有为 -1 */
  impliedRepeat: number;
}

/** 曲内段落标记：从第 `mid` 小节第 `skip` 个和弦起（`skip` 大于 0 = 写在小节中间） */
export interface SectionMark {
  readonly name: string;
  readonly mid: number;
  readonly skip: number;
}

/** 逐遍演唱顺序的一遍（`model/doc.ts::SingPass` 的形状）：段落名、配第几行词、之后换行 */
export interface SingPassSpec {
  readonly items: readonly { readonly section: string; readonly verse?: number; readonly lineAfter?: boolean }[];
  readonly rows?: number;
}

/** `.Repeat` 的一条 */
export class RepeatSpecItem {
  constructor(
    public first: number,
    public last: number,
    public verse: number,
    /** 首小节跳过的和弦个数（`11.2-20V4` → skip=1）。 */
    public skip = 0,
    /** 段末换页：这一段（主歌/副歌）唱完起新页，写作 `1-10V1P`。 */
    public page = false,
    /** 末小节只取前 n 个和弦（-1 = 整节），写作 `11.1-11.1V1`。 */
    public limit = -1,
  ) {}
  toString(): string {
    const head = this.skip > 0 ? `${this.first}.${this.skip + 1}` : `${this.first}`;
    const tail = this.limit >= 0 ? `${this.last}.${this.limit}` : `${this.last}`;
    return `${head}-${tail}V${this.verse}${this.page ? "P" : ""}`;
  }
}

// ───────────────────────── 试听时间轴 ─────────────────────────

/** 力度缺省（没有力度记号时的 note-on velocity）。 */
export const DEFAULT_VELOCITY = 100;

/** 速度倍率的可选档位（试听工具条 + MIDI 导出共用）。 */
export const SPEED_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2] as const;

/** Mixing options shared by MIDI export and playback. */
export interface PlayOptions {
  /** Per-part linear volume in [0,1]; index = part index. Missing/undefined = 1. */
  partVolumes?: number[];
  /** 试听时打节拍器（每拍一声，小节第一拍重） */
  metronome?: boolean;
  /** 播放速度倍率（1 = 谱面标注速度）。夹在 [0.25, 3]。 */
  speed?: number;
}

// ───────────────────────── 输入形状 ─────────────────────────

/** 一个音底下的一段歌词（一个字，收尾标点已并进 `text`）。 */
export interface TimelineLyric {
  readonly text: string;
  /** 段号：第几遍唱它（同 `PlayItem.pass`） */
  readonly number: number;
  /** 副歌：各遍共用 */
  readonly refrain?: boolean;
  /** 续记号（123 的 `_`、MusicXML `<extend>`）：后面紧接的无字音接着唱这个字 */
  readonly extend?: boolean;
}

export interface TimelineNote {
  /** MIDI 音高 */
  readonly pitch: number;
  /** 延音线收尾：前一个同音高的音若首尾相接，就延长它、不再起音 */
  readonly tieStop?: boolean;
  /** 歌词（只看和弦第一个音的）。导出 MIDI 按遍取段写成歌词事件 */
  readonly lyrics?: readonly TimelineLyric[];
}

export interface TimelineChord {
  readonly notes: readonly TimelineNote[];
  readonly rest: boolean;
  /** 小节内位置（四分音符为 1） */
  readonly position: Fraction;
  readonly duration?: Fraction;
  /** 模型里的元素 id（高亮、起播点按它认） */
  readonly id?: ElementId;
  /** note-on 力度 1..127，缺省 `DEFAULT_VELOCITY` */
  readonly velocity?: number;
  /** false = 不当光标锚点（同一声部里的副 voice）。缺省 true */
  readonly cursor?: boolean;
  /** 连音弧从这个和弦起 / 在这儿收几条（判一字多音用：弧里没字的音唱前一个字） */
  readonly slurStart?: boolean;
  readonly slurEnds?: number;
}

/** 小节的调号（导出 MIDI 写 `FF 59` 用）：实际发声的调（移调乐器已换算），`minor` 是小调 */
export interface TimelineKey {
  readonly fifths: number;
  readonly minor: boolean;
}

export interface TimelineMeasure {
  /** 和弦与其它条目混排；只取 `isTimelineChord` 为真的那些。 */
  readonly entries: readonly object[];
  /** 小节时值（末和弦的位置 + 时值）。**没有和弦时抛错**，与 `layout/input.ts::measureDuration` 同口径。 */
  readonly duration: Fraction;
  /** 没有和弦时按拍号算小节长 */
  readonly time: { readonly beats: number; readonly beatType: number };
  /** 调号（随曲中转调）。不给就不写调号事件 */
  readonly key?: TimelineKey;
}

export interface TimelinePart {
  /** 按各声部共用的时间轴排（`model/timeaxis.ts`）：这一声部在某格没有小节（文本谱一组没写这个声部）就是 undefined */
  readonly measures: readonly (TimelineMeasure | undefined)[];
  /** 声部名（MIDI 轨名） */
  readonly name?: string;
}

/** 一份可播的谱：各声部 + 演唱顺序（含速度）。 */
export interface PlaySource {
  /** 按模型的声部序（声部面板、MIDI 轨序都按它） */
  readonly parts: readonly TimelinePart[];
  readonly playData: PlayData;
  /** 主旋律声部（带歌词的那个；演唱顺序按它推、光标跟它、同刻起音先取它）。缺省 0 */
  readonly lead?: number;
}

export function isTimelineChord(e: object): e is TimelineChord {
  return "notes" in e && "rest" in e && "position" in e;
}

// ───────────────────────── 产物 ─────────────────────────

/** 实际播放速度 = 谱面 ♩=（无则 90）× 用户倍率。 */

export interface TimedNote {
  t0: number; // quarter-note units
  t1: number;
  pitch: number;
  part: number;
  velocity: number;
  chord: TimelineChord;
  /** 这一遍唱的字（`lyricOfPass`）；一字多音的后几个音是 `-`（歌声合成软件的「延续上一字」） */
  lyric?: string;
}

export interface Anchor {
  t0: number;
  chord: TimelineChord;
  pass: number; // repeat pass / lyric verse (matches NoteEntry.verse in layout)
  /** 同一个和弦、同一个 `pass` 在这份锚点表里第几次出现（0 起）：只有一段词的反复两遍同段号，
   *  投影档按它认第几次画的那一格（`ScoreIndex.note` 的 `occ`） */
  occ?: number;
}

export interface Timeline {
  /** 拍号 / 调号的变化点（按演唱顺序展开，首项在 t=0；读主旋律声部的小节），导出 MIDI 写 `FF 58` / `FF 59` */
  signatures: { t: number; time: TimelineMeasure["time"]; key?: TimelineKey }[];
  notes: TimedNote[];
  anchors: Anchor[]; // melody (`PlaySource.lead`) sounding chords, ascending by t0 — for cursor
  /** 所有声部、所有 voice 的起音和弦（按 t0 升序，同刻主旋律在前、其余按声部序）。五线谱的竖直播放线跟它走：女高音休止、别的声部在唱也照走 */
  allAnchors: Anchor[];
  /** 节拍器每一拍（四分音符为单位）；`down` = 小节第一拍。复拍子（6/8、9/8、12/8）按附点四分打 */
  clicks: { t: number; down: boolean }[];
  duration: number; // total length in quarter notes
}
