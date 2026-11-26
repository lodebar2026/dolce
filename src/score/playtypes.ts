// 演唱顺序、试听时间轴的数据类与产物形状。判据在 Rust（crates/model/src/play；由 `ScoreDoc` 拼输入在 crates/model/src/view），
// TS 侧经 `score/play.ts` 调；消费者读产物（试听 `editor/player.ts`、投影档 `jianpu/expand.ts::walkPlay`、断行档 `layout/input.ts`）。

import { Fraction } from "../common/fraction";
import type { ElementId } from "../model/doc";

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
  /** 按 `P:` 排的：这一项所在段落的小节。`pass` 是段内第几行词，「这一行词唱完了」只在这些小节里判（dolce-model::play `timeline.rs`、`place/expand.ts`） */
  scope?: ReadonlySet<number>;
  /** 按 `P:` 排的：这一项是进入一个段落（投影档进段不换页，`walkPlay`） */
  sectionEntry?: boolean;
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
  /** 顺序来自逐遍演唱顺序（123 `%%sing`）：投影档逐遍一页起头，断行换页照 `%%layout`，不再推断 */
  fromSing = false;
  /** 谱面速度（♩= 每分钟拍数）。0 = 未标注，试听/导出用默认值（crates/model/src/play `timeline::TEMPO`）。
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

// ───────────────────────── 试听输入 ─────────────────────────

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

/** 一份可播的谱（Rust `PlaySource`，由 `score/play.ts::playSourceOf` 拼）：时间轴、MIDI 直接吃 `json`，产物里的和弦按 `chords` 认回。 */
export interface PlaySource {
  /** Rust `PlaySource` 的 JSON（各声部按共用时间轴排的小节 + 演唱顺序 + 速度） */
  readonly json: string;
  /** 和弦按 Rust 发的号（出场次序）排 */
  readonly chords: readonly TimelineChord[];
  /** 推出来的演唱顺序（含跳转表与各标志、速度） */
  readonly playData: PlayData;
  /** 按模型的声部序（声部面板、MIDI 轨序都按它）：声部名（MIDI 轨名）、共用时间轴上的格数 */
  readonly parts: readonly { readonly name?: string; readonly measureCount: number }[];
  /** 主旋律声部（带歌词的那个；演唱顺序按它推、光标跟它、同刻起音先取它）。缺省 0 */
  readonly lead?: number;
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
  signatures: { t: number; time: { readonly beats: number; readonly beatType: number }; key?: TimelineKey }[];
  notes: TimedNote[];
  anchors: Anchor[]; // melody (`PlaySource.lead`) sounding chords, ascending by t0 — for cursor
  /** 所有声部、所有 voice 的起音和弦（按 t0 升序，同刻主旋律在前、其余按声部序）。五线谱的竖直播放线跟它走：女高音休止、别的声部在唱也照走 */
  allAnchors: Anchor[];
  /** 节拍器每一拍（四分音符为单位）；`down` = 小节第一拍。复拍子（6/8、9/8、12/8）按附点四分打 */
  clicks: { t: number; down: boolean }[];
  duration: number; // total length in quarter notes
}
