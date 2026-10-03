// Shared "score model -> timed note events" flattening, honoring the expanded
// play order (repeats / voltas / D.C. / D.S. / Coda) in playData.measures (PlayItem[]).
// Consumed by both the MIDI export (toMidi) and the in-editor player (ScorePlayer),
// so the two stay in lockstep. Times are in quarter-note units.
//
// 输入形状：只经下面这组接口读谱，由 `model/playsong.ts::playSourceOf` 从 `ScoreDoc` 拼
//（它按形状分给 `playSourceOfSong`（简谱形状）与 `model/playdoc.ts::playSourceOfDoc`（MusicXML 形状））。

import type { Fraction } from "../common/fraction";
import type { ElementId } from "../model/doc";
import type { PlayData } from "./playorder";

export const TEMPO = 90; // BPM fallback when the score carries no ♩= marking

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

export interface TimelineMeasure {
  /** 和弦与其它条目混排；只取 `isTimelineChord` 为真的那些。 */
  readonly entries: readonly object[];
  /** 小节时值（末和弦的位置 + 时值）。**没有和弦时抛错**，与 `layout/input.ts::measureDuration` 同口径。 */
  readonly duration: Fraction;
  /** 没有和弦时按拍号算小节长 */
  readonly time: { readonly beats: number; readonly beatType: number };
}

export interface TimelinePart {
  readonly measures: readonly TimelineMeasure[];
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
export function playTempo(src: PlaySource, opts?: PlayOptions): number {
  const base = src.playData.tempo > 0 ? src.playData.tempo : TEMPO;
  const mul = opts?.speed;
  const k = mul === undefined || Number.isNaN(mul) ? 1 : Math.max(0.25, Math.min(3, mul));
  return base * k;
}

/** Per-part linear gain in [0,1], defaulting to 1 (full) when unset. */
export function partGain(opts: PlayOptions | undefined, part: number): number {
  const v = opts?.partVolumes?.[part];
  if (v === undefined || Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

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

/** 歌词条目前的印刷段号（`1.圣`），同 `NoteEntry.addLyric` 的 `ignoreVerseNumber` */
const VERSE_PREFIX = /^\d+\.(?=.)/;

/** 第 `pass` 遍唱的字：段号对上的那段，没有就取副歌（同展开档 `NoteEntry.addLyric`）。 */
function lyricOfPass(note: TimelineNote | undefined, pass: number): { text: string; extend: boolean } | undefined {
  const lyrics = note?.lyrics;
  if (!lyrics?.length) return undefined;
  const l = lyrics.find((x) => x.number === pass) ?? lyrics.find((x) => x.refrain);
  const text = l?.text.replace(VERSE_PREFIX, "").trim();
  return text ? { text, extend: l!.extend === true } : undefined;
}

export interface Anchor {
  t0: number;
  chord: TimelineChord;
  pass: number; // repeat pass / lyric verse (matches NoteEntry.verse in layout)
}

export interface Timeline {
  notes: TimedNote[];
  anchors: Anchor[]; // melody (`PlaySource.lead`) sounding chords, ascending by t0 — for cursor
  /** 所有声部、所有 voice 的起音和弦（按 t0 升序，同刻主旋律在前、其余按声部序）。五线谱的竖直播放线跟它走：女高音休止、别的声部在唱也照走 */
  allAnchors: Anchor[];
  /** 节拍器每一拍（四分音符为单位）；`down` = 小节第一拍。复拍子（6/8、9/8、12/8）按附点四分打 */
  clicks: { t: number; down: boolean }[];
  duration: number; // total length in quarter notes
}

/** Measure length in quarter notes, max across parts, with a time-signature fallback. */
function measureLen(src: PlaySource, mid: number): number {
  let len = 0;
  for (const part of src.parts) {
    const m = part.measures[mid];
    if (!m) continue;
    try {
      len = Math.max(len, m.duration.toFloat());
    } catch {
      // no chord in this measure: fall back to the time signature
      len = Math.max(len, (m.time.beats * 4) / m.time.beatType);
    }
  }
  return len;
}

/** Expanded play order as [mid, end) measure ranges with a start offset + pass.
 *  `until` clips the last measure (PlayItem.limit：只唱到该小节第 n 个音符为止)。 */
function playRanges(
  src: PlaySource,
): { mid: number; end: number; offset: number; pass: number; until: number }[] {
  const items = src.playData.measures;
  if (items.length > 0) {
    return items.map((p) => ({
      mid: p.mid,
      end: p.end,
      offset: p.offset.toFloat(),
      pass: p.pass,
      until: p.limit >= 0 ? chordEnd(src, p.end - 1, p.limit) : Number.POSITIVE_INFINITY,
    }));
  }
  // No expansion computed: linear single pass over all measures.
  const n = src.parts[src.lead ?? 0]?.measures.length ?? 0;
  return n > 0 ? [{ mid: 0, end: n, offset: 0, pass: 1, until: Number.POSITIVE_INFINITY }] : [];
}

/** 第 `limit` 个和弦唱完时的小节内位置（四分音符为单位；数的是主旋律声部的和弦，同演唱顺序）。 */
function chordEnd(src: PlaySource, mid: number, limit: number): number {
  const m = src.parts[src.lead ?? 0]?.measures[mid];
  if (!m) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (const ent of m.entries) {
    if (!isTimelineChord(ent)) continue;
    n++;
    if (n === limit) return ent.position.toFloat() + (ent.duration?.toFloat() ?? 0);
  }
  return Number.POSITIVE_INFINITY;
}

export function buildTimeline(src: PlaySource): Timeline {
  const notes: TimedNote[] = [];
  const anchors: Anchor[] = [];
  const allAnchors: Anchor[] = [];
  const clicks: Timeline["clicks"] = [];
  let pos = 0; // running timeline position in quarter notes
  /** 各声部各音高最近一个音（延音线收尾时找它延长） */
  const lastByPitch = new Map<string, TimedNote>();
  /** 各声部最近一个起音的旋律音（和弦第一个音），判一字多音用 */
  /** `held` = 这条拖腔链起头的字带续记号（后面的 `-` 是谱上写明的，不撤） */
  const lastSung = new Map<number, { note: TimedNote; pass: number; held: boolean }>();
  const lead = src.lead ?? 0;
  const allAnchorPart = new Map<Anchor, number>();
  /** 各声部当前开着几条弧 */
  const slurDepth = new Map<number, number>();
  /** 记了 `-` 但不在弧里的音（行中间的 `_`）：这一遍后面要是再没有字，说明词已唱完，撤掉 */
  const looseDash: { note: TimedNote; pass: number }[] = [];
  /** 各声部各遍最后一个有字的音的起点 */
  const lastWord = new Map<string, number>();

  for (const range of playRanges(src)) {
    for (let mid = range.mid; mid < range.end; mid++) {
      const startOffset = mid === range.mid ? range.offset : 0;
      const endOffset = mid === range.end - 1 ? range.until : Number.POSITIVE_INFINITY;
      for (let pi = 0; pi < src.parts.length; pi++) {
        const m = src.parts[pi]!.measures[mid];
        if (!m) continue;
        for (const ent of m.entries) {
          if (!isTimelineChord(ent)) continue;
          const cp = ent.position.toFloat();
          if (cp < startOffset) continue; // clipped by a mid-measure jump entry
          if (cp >= endOffset) continue; // clipped by PlayItem.limit
          const t0 = pos + (cp - startOffset);
          const t1 = t0 + (ent.duration?.toFloat() ?? 0);
          if (pi === lead && !ent.rest && ent.cursor !== false) anchors.push({ t0, chord: ent, pass: range.pass });
          if (!ent.rest) {
            const an: Anchor = { t0, chord: ent, pass: range.pass };
            allAnchors.push(an);
            allAnchorPart.set(an, pi);
          }
          if (ent.rest) continue;
          const velocity = ent.velocity ?? DEFAULT_VELOCITY;
          // 收弧的那个音也在弧里；起弧的那个是带字的
          const depth = slurDepth.get(pi) ?? 0;
          const inSlur = depth > 0;
          slurDepth.set(pi, Math.max(0, depth + (ent.slurStart ? 1 : 0) - (ent.slurEnds ?? 0)));
          ent.notes.forEach((nt, k) => {
            const key = `${pi}:${nt.pitch}`;
            const prev = nt.tieStop ? lastByPitch.get(key) : undefined;
            // 只接首尾相接的那个：反复跳转、中间隔了休止都照常起音
            if (prev && Math.abs(prev.t1 - t0) < 1e-6) {
              prev.t1 = t1;
              return;
            }
            const tn: TimedNote = { t0, t1, pitch: nt.pitch, part: pi, velocity, chord: ent };
            if (k === 0) {
              // 这一遍没字、紧接着同一遍里上一个有字（或也在拖腔）的音：一字多音，记 `-`。隔了休止、换了一遍都不算。
              // 起头的字带续记号的是谱上写明的；没写的，在弧里、或这一遍后面还有字才算（否则是这一遍的词唱完了，见 `looseDash`）
              const before = lastSung.get(pi);
              const follows = before !== undefined && before.pass === range.pass && Math.abs(before.note.t1 - t0) < 1e-6;
              const word = lyricOfPass(nt, range.pass);
              tn.lyric = word?.text ?? (follows && before.note.lyric !== undefined ? "-" : undefined);
              const held = word ? word.extend : tn.lyric !== undefined && before!.held;
              if (word !== undefined) lastWord.set(`${pi}:${range.pass}`, t0);
              else if (tn.lyric !== undefined && !held && !inSlur) looseDash.push({ note: tn, pass: range.pass });
              // 与上一个音重叠、又没字的（同一声部里的副 voice）不顶替它，免得把主旋律的拖腔链打断
              if (tn.lyric !== undefined || !before || t0 > before.note.t1 - 1e-6 || before.pass !== range.pass) {
                lastSung.set(pi, { note: tn, pass: range.pass, held });
              }
            }
            notes.push(tn);
            lastByPitch.set(key, tn);
          });
        }
      }
      const len = Math.min(measureLen(src, mid), endOffset);
      const time = src.parts[lead]?.measures[mid]?.time;
      if (time) {
        const compound = time.beatType === 8 && time.beats % 3 === 0 && time.beats > 3;
        const beat = (4 / time.beatType) * (compound ? 3 : 1);
        // 曲首弱起小节（不满一整小节）是一小节的**后半截**：拍点从整小节的哪儿数起要往后挪，重拍不落在它头上
        const full = (time.beats * 4) / time.beatType;
        const shift = mid === 0 && len < full - 1e-9 ? full - len : 0;
        for (let k = Math.ceil((shift + startOffset) / beat - 1e-9); k * beat < shift + len - 1e-9; k++) {
          clicks.push({ t: pos + k * beat - shift - startOffset, down: k === 0 });
        }
      }
      pos += len - startOffset;
    }
  }

  for (const { note, pass } of looseDash) {
    if (note.t0 > (lastWord.get(`${note.part}:${pass}`) ?? Number.NEGATIVE_INFINITY)) delete note.lyric;
  }
  anchors.sort((a, b) => a.t0 - b.t0);
  // 稳定排序：同刻的主旋律在前（播放线同刻只停一处，停在它上面——展开档只画它），其余按声部序
  const rank = (a: Anchor): number => (allAnchorPart.get(a) === lead ? 0 : 1);
  allAnchors.sort((a, b) => a.t0 - b.t0 || rank(a) - rank(b));
  return { notes, anchors, allAnchors, clicks, duration: pos };
}
