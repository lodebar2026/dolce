// `ScoreDoc`（MusicXML 形状）→ 演唱顺序、试听输入、`.jpwabc` 写出端输入。
//
// **口径同简谱引擎输入 `model/jianpuinput.ts::jianpuInputOfXml`**（回归 `playorder-check`）：
//   - 只读第一声部；小节、和弦、歌词段号、房号、反复经 `phrasedoc.ts::phrasePartOfDoc` 拼（与断句同一份输入）
//   - 跳转取 `<direction><sound>`：落点是**游标当时的位置**（最后一个非倚音和弦的终点），
//     由 `Direction.afterElements` 还原成它前面那个音符的终点
// 简谱形状（文本谱 / 123 / ABC / `.jpwabc`）在 `model/playsong.ts`。

import { Fraction } from "../common/fraction";
import { JumpSpec, PlayData, PlaySpecKind, TimePosition, playOrderOf } from "../score/playorder";
import { DEFAULT_VELOCITY, type PlaySource, type TimelineChord, type TimelineLyric, type TimelineMeasure, type TimelineNote, type TimelinePart } from "../score/timeline";
import type { Accidental, Barline, Chord, Direction, ElementId, Measure, Note, Part, Song } from "./doc";
import { midiPitch, topNote } from "./jianpu";
import type { JpwChordIn, JpwLineBreakIn, JpwMeasureIn, JpwPitchIn, JpwScoreIn } from "./tojpw";
import { BarStyle } from "../score/enums";
import { Key } from "../score/jppitch";
import { distinctNumbers, phrasePartOfDoc } from "./phrasedoc";
import type { PhraseChord } from "../score/phraseinput";

/** 主旋律声部：第一个带歌词的声部，都没词取第一声部（同简谱形状 `forExpanded` 的口径）。
 *  歌词段数决定唱几遍，第一声部是伴奏、词在后面声部时按第一声部推就少唱了。 */
export function leadPartOf(song: Song): number {
  const i = song.parts.findIndex((p) => p.measures.some((m) => m.elements.some((el) => el.kind === "chord" && el.lyrics?.some((l) => l.text.length > 0))));
  return i < 0 ? 0 : i;
}

/** 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。反复与跳转记号读第一声部。
 *  推理抛错照样抛出。
 *  - `lead`：段数按哪个声部的歌词推、`PlayItem.limit` 数哪个声部的和弦。缺省第一声部——引擎输入与 `.jpwabc` 写出端
 *    画的、写的都是第一声部，必须同一个；只有试听（`playSourceOfDoc`）传主旋律声部（`leadPartOf`）
 *  - `distinct`：同音同号的词顺延（试听那份，见 `phrasedoc.ts::distinctNumbers`） */
export function playDataOfDoc(song: Song, { lead = 0, distinct = false }: { lead?: number; distinct?: boolean } = {}): PlayData {
  const pd = new PlayData();
  const part = song.parts[0];
  if (!part) throw new Error("no part");
  const div = part.measures[0]?.attrs?.divisions ?? 1;
  part.measures.forEach((m, mid) => {
    for (const d of m.directions ?? []) if (d.sound) addSound(pd, d, new TimePosition(mid, cursorAt(m, d).divInt(div)));
  });
  const order = playOrderOf([phrasePartOfDoc(song, lead, distinct).part], pd);
  pd.isSimpple = order.isSimple;
  pd.measures = order.measures;
  pd.hasRepeat = order.hasRepeat;
  return pd;
}

/** `<direction>` 处的游标（divisions）：它前面最后一个非倚音和弦的终点，各声部各自累计。 */
function cursorAt(m: Measure, d: Direction): Fraction {
  const pos = new Map<number, number>();
  let end = 0;
  const n = Math.min(d.afterElements ?? 0, m.elements.length);
  for (let i = 0; i < n; i++) {
    const el = m.elements[i]!;
    if (el.kind !== "chord" || el.grace) continue;
    const p = pos.get(el.voice) ?? 0;
    end = p + el.duration.divisions;
    pos.set(el.voice, end);
  }
  return new Fraction(end);
}

/** 同 `parseSound`（速度除外）。 */
function addSound(pd: PlayData, d: Direction, tick: TimePosition): void {
  const s = d.sound!;
  if (s.coda) pd.coda.set(s.coda, tick);
  if (s.segno) pd.segno.set(s.segno, tick);
  if (s.dacapo) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Dacapo));
  if (s.fine) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Fine));
  if (s.dalsegno) {
    const j = new JumpSpec(PlaySpecKind.DalSegno);
    j.value = s.dalsegno;
    pd.jumpTo.set(tick, j);
  }
  if (s.tocoda) {
    const j = new JumpSpec(PlaySpecKind.ToCoda);
    j.value = s.tocoda;
    pd.jumpTo.set(tick, j);
  }
}

export interface PlaySourceOptions {
  /** 只取第一声部的 voice ≤ 1、和弦只取最高音，不带力度——光标跟的旋律档，口径同引擎输入 */
  melodyOnly?: boolean;
}

/** 试听/MIDI 的输入（`score/timeline.ts::PlaySource`）。缺省带全部声部（`part` 下标 = `Part` 序）、
 *  各 voice、和弦全部音与力度记号；光标只跟主旋律声部（`leadPartOf`）的 voice ≤ 1。 */
export function playSourceOfDoc(song: Song, options: PlaySourceOptions = {}): PlaySource {
  if (options.melodyOnly) {
    const playData = playDataOfDoc(song);
    playData.tempo = tempoOfDoc(song);
    return { parts: [phrasePartOfDoc(song).part], playData };
  }
  const lead = leadPartOf(song);
  const playData = playDataOfDoc(song, { lead, distinct: true });
  playData.tempo = tempoOfDoc(song);
  const slurs = slursOf(song);
  return { parts: song.parts.map((p, i) => timelinePartOf(p, i === lead, slurs, lyricsOfPart(song, i))), playData, lead };
}

/** 连音弧的起止和弦（`TimelineChord.slurStart` / `slurEnds`，判一字多音用；同 `phrasedoc.ts` 的统计）。 */
function slursOf(song: Song): { starts: Set<ElementId>; ends: Map<ElementId, number> } {
  const starts = new Set<ElementId>();
  const ends = new Map<ElementId, number>();
  for (const mk of song.marks) {
    if (mk.type !== "slur") continue;
    starts.add(mk.start);
    ends.set(mk.end, (ends.get(mk.end) ?? 0) + 1);
  }
  return { starts, ends };
}

/** 一个声部各和弦的歌词（导出 MIDI 的歌词事件）：段号、副歌取断句输入那份（同音同号已顺延、`findRefrain` 判过副歌，
 *  与 MusicXML 展开档 `jianpuInputOfXml` 同口径——副歌各遍都唱），字取模型的、并上收尾标点。
 *  断句输入只收 voice ≤ 1，其余 voice 的和弦这里没有，由 `chordEntry` 直接读模型。 */
function lyricsOfPart(song: Song, partIndex: number): Map<ElementId, TimelineLyric[]> {
  const out = new Map<ElementId, TimelineLyric[]>();
  const view = phrasePartOfDoc(song, partIndex, true);
  const byId = new Map<ElementId, Chord>();
  for (const m of song.parts[partIndex]!.measures) for (const el of m.elements) if (el.kind === "chord") byId.set(el.id, el);
  for (const m of view.part.measures) {
    for (const ch of m.entries as readonly PhraseChord[]) {
      const id = view.idOf.get(ch);
      const el = id === undefined ? undefined : byId.get(id);
      const src = ch.notes[0]?.lyrics ?? [];
      if (!el || src.length === 0) continue;
      const model = (el.lyrics ?? []).filter((l) => l.text.length > 0);
      out.set(id!, src.map((l, k) => ({ text: l.text + (model[k]?.trailingPunctuation ?? ""), number: l.number, refrain: l.refrain, extend: model[k]?.extend })));
    }
  }
  return out;
}

/** 谱面速度：第一声部里第一处 `<sound tempo>`（20..400，取整），同 `parseSound`。 */
export function tempoOfDoc(song: Song): number {
  for (const m of song.parts[0]?.measures ?? []) {
    for (const d of m.directions ?? []) {
      const t = d.sound?.tempo;
      if (t !== undefined && t >= 20 && t <= 400) return Math.round(t);
    }
  }
  return 0;
}

/** 力度记号 → note-on velocity。表外的（`sf`/`fp` 这类瞬时重音）不改当前力度。 */
const VELOCITY: Readonly<Record<string, number>> = {
  pppp: 20, ppp: 30, pp: 42, p: 56, mp: 70, mf: 84, f: 98, ff: 112, fff: 122, ffff: 127,
};

interface ChordEntry extends TimelineChord {
  readonly duration: Fraction;
}

function timelinePartOf(
  part: Part, lead: boolean,
  slurs?: { starts: ReadonlySet<ElementId>; ends: ReadonlyMap<ElementId, number> },
  lyrics?: ReadonlyMap<ElementId, TimelineLyric[]>,
): TimelinePart {
  // 时值按首小节 divisions 折算，与演唱顺序的落点（`playDataOfDoc`）同口径
  const div = part.measures[0]?.attrs?.divisions ?? 1;
  let time = { beats: 4, beatType: 4 };
  let velocity = DEFAULT_VELOCITY;
  /** 移调乐器（`<transpose>`）：记谱音高加这么多半音才是实际发声 */
  let shift = 0;
  const measures: TimelineMeasure[] = [];
  for (const m of part.measures) {
    if (m.attrs?.time) time = { beats: m.attrs.time.beats, beatType: m.attrs.time.beatType };
    if (m.attrs?.transpose) shift = m.attrs.transpose.chromatic + 12 * (m.attrs.transpose.octaveChange ?? 0);
    const dyn = (m.directions ?? [])
      .filter((d) => d.type === "dynamics" && d.text !== undefined && VELOCITY[d.text] !== undefined)
      .map((d) => ({ at: cursorAt(m, d).toFloat() + (d.offset ?? 0), v: VELOCITY[d.text!]! }))
      .sort((a, b) => a.at - b.at);
    const pos = new Map<number, number>();
    const entries: ChordEntry[] = [];
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      const onset = pos.get(el.voice) ?? 0;
      if (el.grace) continue;
      if (el.placeholder) {
        // 不占时值的占位（`Chord.placeholder`）：自己那一拍不算，身上的增时线延的是前一个音
        const extra = el.duration.divisions - el.duration.divisions / ((el.sustains?.length ?? 0) + 1);
        const prev = entries[entries.length - 1];
        if (extra && prev) entries[entries.length - 1] = { ...prev, duration: prev.duration.plus(new Fraction(extra).divInt(div)) };
        pos.set(el.voice, onset + extra);
        continue;
      }
      pos.set(el.voice, onset + el.duration.divisions);
      if (el.cue) continue;
      let v = velocity;
      for (const e of dyn) if (e.at <= onset) v = e.v;
      const entry = chordEntry(el, onset, div, v, lead && el.voice <= 1, shift, lyrics?.get(el.id));
      entries.push(slurs ? { ...entry, slurStart: slurs.starts.has(el.id), slurEnds: slurs.ends.get(el.id) ?? 0 } : entry);
    }
    if (dyn.length) velocity = dyn[dyn.length - 1]!.v;
    const t = time;
    measures.push({
      entries,
      time: t,
      get duration(): Fraction {
        if (entries.length === 0) throw new Error("measure has no chord");
        let end = entries[0]!.position.plus(entries[0]!.duration);
        for (const e of entries) {
          const x = e.position.plus(e.duration);
          if (x.compareTo(end) > 0) end = x;
        }
        return end;
      },
    });
  }
  return { measures, name: part.name };
}

function chordEntry(
  el: Chord, onset: number, div: number, velocity: number, cursor: boolean, shift = 0,
  phraseLyrics?: TimelineLyric[],
): ChordEntry {
  const notes: TimelineNote[] = el.rest ? [] : el.notes.filter((n) => n.pitch).map((n) => (n.tie?.stop ? { pitch: midiPitch(n.pitch!) + shift, tieStop: true } : { pitch: midiPitch(n.pitch!) + shift }));
  // 歌词挂在和弦第一个音上（导出 MIDI 的歌词事件），收尾标点并进前字。断句输入里有的取它那份（`lyricsOfPart`）
  const lyrics = phraseLyrics ?? distinctNumbers((el.lyrics ?? [])
    .filter((l) => l.text.length > 0)
    .map((l) => ({ text: l.text + (l.trailingPunctuation ?? ""), number: l.number, refrain: l.refrain ?? false, extend: l.extend })));
  if (notes[0] && lyrics.length) notes[0] = { ...notes[0], lyrics };
  return {
    notes,
    rest: notes.length === 0,
    position: new Fraction(onset).divInt(div),
    duration: new Fraction(el.duration.divisions).divInt(div),
    id: el.id,
    velocity,
    cursor,
  };
}

// ───────────────────────── `.jpwabc` 写出端的输入 ─────────────────────────

/** 面上的记号 → `.jpwabc` 的单字符记号位（同 `score.ts::Note.init` 的 `JP_ALTER`，双升/双降印成 `#`/`b`） */
export function jpAlterOfAccidental(acc: Accidental | undefined): string {
  switch (acc) {
    case "sharp": case "double-sharp": return "#";
    case "flat": case "double-flat": return "b";
    case "natural": return "n";
    default: return " ";
  }
}

const pitchIn = (n: Note | undefined, rest: boolean): JpwPitchIn => ({
  number: rest || !n?.degree ? "0" : String(n.degree.number),
  jpOctave: n?.degree?.octaveShift ?? 0,
  jpAlter: rest ? " " : jpAlterOfAccidental(n?.degree?.accidental),
});

/** `.jpwabc` 写出端的输入（`model/tojpw.ts::JpwScoreIn`），**口径同引擎输入**：
 *  第一声部 voice ≤ 1、和弦取最高音（与断句同一份 `phrasePartOfDoc`）；标题/credit 照 `extractScoreTitle` 与 `<credit>` 的读法；
 *  倚音挂到它后面第一个新和弦上（跨小节也挂）；小节线条目按游标位置（只看是不是在小节开头）。 */
export function jpwInputOfDoc(song: Song): JpwScoreIn {
  const playData = playDataOfDoc(song);
  playData.tempo = tempoOfDoc(song);
  const part = song.parts[0]!;
  const view = phrasePartOfDoc(song);
  const div = part.measures[0]?.attrs?.divisions ?? 1;

  const tieStarts = new Set<number>();
  const tieEnds = new Set<number>();
  const tupStarts = new Set<number>();
  const tupEnds = new Set<number>();
  for (const mk of song.marks) {
    if (mk.type === "tied") { tieStarts.add(mk.start); tieEnds.add(mk.end); }
    if (mk.type === "tuplet") { tupStarts.add(mk.start); tupEnds.add(mk.end); }
  }

  // 倚音：挂到文档序里它后面第一个非倚音和弦（任意 voice，可跨小节）
  const graces = new Map<Chord, JpwPitchIn[]>();
  let pending: JpwPitchIn[] = [];
  for (const m of part.measures) {
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      if (el.grace) {
        for (const n of el.notes) pending.push(pitchIn(n, false));
        if (el.notes.length === 0) pending.push(pitchIn(undefined, true));
        continue;
      }
      if (pending.length) {
        graces.set(el, pending);
        pending = [];
      }
    }
  }

  let fifths = 0;
  let time = { beats: 4, beatType: 4 };
  const measures: JpwMeasureIn[] = part.measures.map((m, mid) => {
    const out = view.part.measures[mid]!;
    const byId = new Map<number, Chord>();
    for (const el of m.elements) if (el.kind === "chord") byId.set(el.id, el);
    const entries: object[] = [];
    // 左小节线（带 bar-style 的）在小节开头：位置 0，写出端不写
    for (const b of m.barlines ?? []) if (b.location === "left" && b.style !== undefined) entries.push(barlineAt(b, new Fraction(0)));
    const at = cursorEnds(m, div);
    let middle = (m.barlines ?? []).filter((b) => b.location === "middle" && b.style !== undefined);
    for (const ch of out.entries as PhraseChord[]) {
      const el = byId.get(view.idOf.get(ch)!)!;
      const index = m.elements.indexOf(el);
      for (const b of middle.filter((b) => (b.afterElements ?? 0) <= index)) entries.push(barlineAt(b, at[b.afterElements ?? 0]!));
      middle = middle.filter((b) => (b.afterElements ?? 0) > index);
      const rest = ch.rest;
      const top = rest ? undefined : topNote(el);
      const chord: JpwChordIn = {
        notes: [{
          ...pitchIn(top, rest),
          number: ch.notes[0]!.number,
          jpOctave: ch.notes[0]!.jpOctave,
          tieStart: tieStarts.has(el.id),
          tieEnd: tieEnds.has(el.id),
          tupletBegin: tupStarts.has(el.id),
          tupletEnd: tupEnds.has(el.id),
          lyrics: ch.notes[0]!.lyrics,
        }],
        rest,
        dot: ch.dot,
        beats: ch.beats,
        beams: ch.beams,
        slurStart: ch.slurStart,
        slurEnds: ch.slurEnds,
        fermata: ch.fermata,
        graceNotes: graces.get(el) ?? [],
      };
      entries.push(chord);
    }
    for (const b of middle) entries.push(barlineAt(b, at[Math.min(b.afterElements ?? 0, m.elements.length)]!));
    for (const b of m.barlines ?? []) if (b.location === "right" && b.style !== undefined) entries.push(barlineAt(b, at[m.elements.length]!));

    const keyChange = m.attrs?.key !== undefined;
    if (m.attrs?.key) fifths = m.attrs.key.fifths;
    const timeChange = m.attrs?.time !== undefined;
    if (m.attrs?.time) time = { beats: m.attrs.time.beats, beatType: m.attrs.time.beatType };
    const key = new Key();
    key.fifths = fifths;
    return {
      entries,
      newSystem: !!(m.print?.newSystem || m.print?.newPage),
      newPage: !!m.print?.newPage,
      repeatForward: out.repeatForward,
      repeatBackward: out.repeatBackward,
      endingLeft: out.endingLeft,
      endingNum: out.endingNum,
      timeChange,
      keyChange,
      time,
      key: { fifths, name: key.name },
      barline: out.barline,
    };
  });

  // 标题同 `extractScoreTitle`：title 类 credit 的首行 → work-title → movement-title
  const credits = (song.credits ?? []).map((c) => ({
    type: c.type ?? null,
    // 逐个 `<credit-words>` 去首尾空白、丢空的再用换行接；模型里已接成一段，分不出元素边界，
    // 只能去整段首尾空白、丢纯空白行（元素内部换行两侧的空格留着，同原文）
    text: c.text.split("\n").filter((t) => t.trim().length > 0).join("\n").trim(),
    page: (c.page ?? 1) - 1,
    first: c.text.split("\n")[0]!.trim(),
  }));
  const title = credits.find((c) => c.type === "title" && c.first)?.first ?? song.work.title?.trim() ?? "";
  for (const c of credits) if (c.type === null && c.text === title) c.type = "title";
  return {
    title,
    credit: credits.map(({ type, text, page }) => ({ type, text, page })),
    parts: [{ measures }],
    playData,
  };
}

const barlineAt = (b: Barline, position: Fraction): { style: BarStyle | null; repeat: null; position: Fraction } => ({
  style: (b.style as BarStyle | undefined) ?? null,
  repeat: null,
  position,
});

/** `at[i]`：前 `i` 个元素读完时的游标（divisions 折算成四分音符）：最后一个非倚音和弦的终点。 */
function cursorEnds(m: Measure, div: number): Fraction[] {
  const pos = new Map<number, number>();
  const out: Fraction[] = [new Fraction(0)];
  let end = 0;
  for (const el of m.elements) {
    if (el.kind === "chord" && !el.grace) {
      const p = pos.get(el.voice) ?? 0;
      end = p + el.duration.divisions;
      pos.set(el.voice, end);
    }
    out.push(new Fraction(end).divInt(div));
  }
  return out;
}

export type { JpwLineBreakIn };
