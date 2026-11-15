// MIDI → `ScoreDoc`（**MusicXML 形状**：绝对音高 + 每小节 divisions）。
//
// MIDI 只有音高和时间，与 MusicXML 形状同类，所以直接建这一形状的模型：简谱度数、增时线/减时线由
// `jianpuproject.ts` 投影（与打开 MusicXML 同一条），要 MusicXML 就走唯一写出端 `toxml.ts`，
// 编辑器里按打开 MusicXML 的流程落地（转成设置里的默认编辑格式、多声部进五线谱）。
//
// 这是**量化后的记谱重建**，不是无损的事件编辑：
// - 量化按拍：网格选「1/16 与三连音」时每拍各算一遍，起止点贴 1/16 与贴八分三连音哪个误差小用哪个
//   （三连音要明显更贴才用，人奏的十六分音符抖一点不该读成三连音）；复拍子（x/8）与跨小节线的拍不认三连音。
// - 声部按小节分：每小节里起止相同的音并成和弦，互相重叠的才另开声部；连奏时前一个音拖进后一个音的一小截截掉。
// - 音名按调号拼：调内音照调号，调外音在升号调（含 C）记升、降号调记降；临时记号的印法走 `edit.ts::respellMeasure`。
// - 变速只取首个速度，踏板/控制器/弯音、打击乐通道不转写（导入后在状态栏提示）。
//
// 无 DOM 依赖（Node 下能跑）。
import type { Chord, Clef, Key, Mark, Measure, Note, NoteType, Part, Pitch, ScoreDoc, Time } from "../model/doc";
import { IdGen, emptyDoc, emptySong } from "../model/helpers";
import { respellMeasure } from "../model/edit";
import { assignDegrees } from "../model/jianpu";
import { keyAlter } from "../score/jppitch";
import { t } from "../i18n";
import { parseSmf } from "./smf";

/** 量化网格：`16t` = 每拍在 1/16 与八分三连音之间择优 */
export type MidiGrid = "16t" | "16" | "32";

export interface MidiImportOptions {
  grid: MidiGrid;
  /** 给了就不读文件里的调号 */
  fifths?: number;
  /** 给了就不读文件里的拍号 */
  beats?: number;
  beatType?: number;
}

export interface MidiImportResult {
  doc: ScoreDoc;
  /** 给状态栏的提示（量化、略去了什么） */
  warnings: string[];
}

/** 一个四分音符的 divisions：到 32 分音符与三连音都是整数 */
const Q = 48;
const TRIPLET = Q / 3;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NOTES = 20000;
const MAX_PARTS = 32;
const MAX_BARS = 2000;
const MAX_VOICES = 16;

/** 不带连音的时值，大的在前 */
const STRAIGHT: readonly { dur: number; type: NoteType; dots: number }[] = [
  { dur: 192, type: "whole", dots: 0 },
  { dur: 144, type: "half", dots: 1 },
  { dur: 96, type: "half", dots: 0 },
  { dur: 72, type: "quarter", dots: 1 },
  { dur: 48, type: "quarter", dots: 0 },
  { dur: 36, type: "eighth", dots: 1 },
  { dur: 24, type: "eighth", dots: 0 },
  { dur: 18, type: "16th", dots: 1 },
  { dur: 12, type: "16th", dots: 0 },
  { dur: 6, type: "32nd", dots: 0 },
];

interface RawNote { start: number; end: number; pitch: number }
interface Bar { start: number; end: number; time: Time; key: Key; timeChanged: boolean; keyChanged: boolean }
/** 一小节里起止相同的一组音（截在小节内）。`notes` 是整音：跨小节的延音线按它接 */
interface Seg { start: number; end: number; notes: RawNote[] }
/** 一段时值：`beat` 是所在的三连音拍（不在三连音拍里为 undefined） */
interface Piece { dur: number; type: NoteType; dots: number; beat?: number }

const invalid = (): Error => new Error(t("midi.invalid"));
const tooLarge = (): Error => new Error(t("midi.limit"));

export function midiToScoreDoc(bytes: Uint8Array, title: string, options: MidiImportOptions): MidiImportResult {
  if (bytes.length > MAX_BYTES) throw invalid();
  const smf = parseSmf(bytes);
  if (!smf || smf.format > 1) throw invalid();
  const scale = Q / smf.ppq;

  // ── 读事件：每轨每通道一个声部 ──
  const meters: { at: number; time: Time }[] = [];
  const keys: { at: number; key: Key }[] = [];
  const tempos: { at: number; bpm: number }[] = [];
  const parts: { name?: string; notes: RawNote[]; triplet: Set<number> }[] = [];
  let drums = false, controls = false, dangling = false;
  for (const track of smf.tracks) {
    let name: string | undefined;
    const byChannel = new Map<number, RawNote[]>();
    const open = new Map<number, number[]>(); // 通道×128+音高 → 未收的起点（先开先收）
    for (const e of track) {
      const at = e.tick * scale;
      switch (e.type) {
        case "trackName": if (e.text) name = e.text; break;
        case "tempo": if (e.usPerQuarter > 0) tempos.push({ at, bpm: 60_000_000 / e.usPerQuarter }); break;
        case "timeSig": meters.push({ at, time: { beats: e.beats, beatType: e.beatType } }); break;
        case "keySig": keys.push({ at, key: { fifths: e.fifths, mode: e.minor ? "minor" : "major" } }); break;
        case "expression": controls = true; break;
        case "noteOn":
        case "noteOff": {
          if (e.channel === 9) { drums = true; break; }
          const k = e.channel * 128 + e.pitch;
          const q = open.get(k) ?? [];
          if (e.type === "noteOn") q.push(at);
          else {
            const start = q.shift();
            if (start !== undefined) {
              const list = byChannel.get(e.channel) ?? [];
              list.push({ start, end: at, pitch: e.pitch });
              byChannel.set(e.channel, list);
            }
          }
          open.set(k, q);
          break;
        }
      }
    }
    dangling ||= [...open.values()].some((q) => q.length > 0);
    for (const [ch, notes] of byChannel) {
      const label = byChannel.size > 1 ? [name, String(ch + 1)].filter(Boolean).join(" · ") : name;
      parts.push({ ...(label ? { name: label } : {}), notes, triplet: new Set() });
    }
  }
  const noteCount = parts.reduce((n, p) => n + p.notes.length, 0);
  if (!noteCount || noteCount > MAX_NOTES || parts.length > MAX_PARTS) throw tooLarge();
  const byAt = <T extends { at: number }>(a: T, b: T): number => a.at - b.at;
  meters.sort(byAt); keys.sort(byAt); tempos.sort(byAt);
  if (options.beats !== undefined && options.beatType !== undefined) meters.splice(0, meters.length, { at: 0, time: { beats: options.beats, beatType: options.beatType } });
  if (options.fifths !== undefined) keys.splice(0, keys.length, { at: 0, key: { fifths: options.fifths, mode: "major" } });
  for (const m of meters) if (!(m.time.beats >= 1 && m.time.beats <= 32 && [1, 2, 4, 8, 16, 32].includes(m.time.beatType))) throw invalid();
  for (const k of keys) if (Math.abs(k.key.fifths) > 7) throw invalid();

  // ── 小节：拍号变在小节中间（少见）就在那里断开 ──
  const step = options.grid === "32" ? 6 : 12;
  const bars: Bar[] = [];
  const rawEnd = Math.max(...parts.flatMap((p) => p.notes.map((n) => n.end)));
  const extendBars = (until: number): void => {
    while (!bars.length || bars[bars.length - 1]!.end < until) {
      if (bars.length >= MAX_BARS) throw tooLarge();
      const start = bars.length ? bars[bars.length - 1]!.end : 0;
      // 拍号、调号事件离小节线差一点（未量化的 tick）也算在这一小节起
      const meter = [...meters].reverse().find((m) => m.at <= start + step / 2)?.time ?? { beats: 4, beatType: 4 };
      const key = [...keys].reverse().find((k) => k.at <= start + Q / 2)?.key ?? { fifths: 0, mode: "major" };
      const nextMeter = meters.find((m) => m.at > start + step / 2);
      const len = (Q * 4 * meter.beats) / meter.beatType;
      // 小节线落在 32 分音符的格上（拍号到 x/32，各小节长都是 6 的倍数）
      const end = nextMeter ? Math.min(start + len, Math.max(start + 6, Math.round(nextMeter.at / 6) * 6)) : start + len;
      const prev = bars[bars.length - 1];
      bars.push({
        start, end, time: meter, key,
        timeChanged: !prev || prev.time.beats !== meter.beats || prev.time.beatType !== meter.beatType,
        keyChanged: !prev || prev.key.fifths !== key.fifths || prev.key.mode !== key.mode,
      });
    }
  };
  extendBars(rawEnd + 1);
  const barAt = (x: number): Bar | undefined => bars.find((b) => b.start <= x && x < b.end);

  // ── 量化 ──
  for (const p of parts) {
    if (options.grid === "16t") p.triplet = tripletBeats(p.notes, step, barAt);
    const triplet = p.triplet;
    const gridAt = (x: number): number => (triplet.has(Math.floor(x / Q)) ? TRIPLET : step);
    const quantize = (x: number): number => {
      const g = gridAt(x);
      return Math.max(0, Math.round(x / g) * g);
    };
    for (const n of p.notes) {
      n.start = quantize(n.start);
      n.end = Math.max(quantize(n.end), n.start + gridAt(n.start));
    }
    trimOverlaps(p.notes, gridAt);
  }
  const end = Math.max(...parts.flatMap((p) => p.notes.map((n) => n.end)));
  extendBars(end);
  bars.splice(bars.findIndex((b) => b.end >= end) + 1);

  // ── 建模型 ──
  const ids = new IdGen();
  const marks: Mark[] = [];
  const song = emptySong();
  song.work.title = title;
  song.key = bars[0]!.key;
  song.time = bars[0]!.time;
  const bpm = Math.round(tempos[0]?.bpm ?? 120);
  parts.forEach((p, pi) => {
    const triplet = p.triplet;
    const part: Part = { id: `P${pi + 1}`, measures: [] };
    if (p.name) part.name = p.name;
    const avg = p.notes.reduce((s, n) => s + n.pitch, 0) / p.notes.length;
    const clef: Clef = avg < 55 ? { sign: "F", line: 4 } : { sign: "G", line: 2 };
    /** 整音 → 它上一段写成的那个和弦与第几个音（延音线接下一段用）；上一小节在第几声部（跨小节尽量留在同一声部） */
    const lastPiece = new Map<RawNote, { id: number; index: number }>();
    const lastVoice = new Map<RawNote, number>();
    bars.forEach((bar, bi) => {
      const m: Measure = { number: String(bi + 1), elements: [] };
      if (bi === 0) m.attrs = { divisions: Q, key: bar.key, time: bar.time, clefs: [clef] };
      else if (bar.keyChanged || bar.timeChanged) m.attrs = { ...(bar.keyChanged ? { key: bar.key } : {}), ...(bar.timeChanged ? { time: bar.time } : {}) };
      if (bi === 0 && pi === 0) {
        m.directions = [{ type: "metronome", placement: "above", tempo: { beatUnit: "quarter", perMinute: bpm }, sound: { tempo: bpm } }];
      }
      const voices = voicesOfBar(p.notes, bar, lastVoice);
      if (voices.length > MAX_VOICES) throw tooLarge();
      voices.forEach((segs, vi) => {
        const elems: Chord[] = [];
        const piecesOf = (from: number, to: number): Piece[] => pieces(from, to, (b) => triplet.has(b));
        const rest = (from: number, to: number): void => {
          for (const pc of piecesOf(from, to)) elems.push(chordOf(pc, [], vi + 1, ids));
        };
        let pos = bar.start;
        for (const seg of segs) {
          if (seg.start > pos) rest(pos, seg.start);
          const ps = piecesOf(seg.start, seg.end);
          ps.forEach((pc, k) => {
            const notes: Note[] = seg.notes.map((n) => {
              const note: Note = { pitch: spell(n.pitch, bar.key.fifths) };
              const stop = k > 0 || n.start < seg.start;
              const start = k < ps.length - 1 || n.end > seg.end;
              if (stop || start) note.tie = { ...(stop ? { stop: true } : {}), ...(start ? { start: true } : {}) };
              return note;
            });
            const ch = chordOf(pc, notes, vi + 1, ids);
            seg.notes.forEach((n, index) => {
              const prev = lastPiece.get(n);
              if (prev && notes[index]!.tie?.stop) marks.push({ type: "tied", start: prev.id, end: ch.id, startNote: prev.index, endNote: index });
              lastPiece.set(n, { id: ch.id, index });
              lastVoice.set(n, vi);
            });
            elems.push(ch);
          });
          pos = seg.end;
        }
        if (pos < bar.end) rest(pos, bar.end);
        // 三连音：同一拍里连着的几段成一组
        let k = 0;
        let at = bar.start;
        const beatOf: (number | undefined)[] = [];
        for (const el of elems) {
          beatOf.push(el.duration.timeMod ? Math.floor(at / Q) : undefined);
          at += el.duration.divisions;
        }
        while (k < elems.length) {
          let j = k;
          while (beatOf[k] !== undefined && j + 1 < elems.length && beatOf[j + 1] === beatOf[k]) j++;
          if (beatOf[k] !== undefined && j > k) marks.push({ type: "tuplet", start: elems[k]!.id, end: elems[j]!.id, tupletActual: 3, tupletNormal: 2 });
          k = j + 1;
        }
        if (vi > 0 && elems[0]) elems[0].onset = 0;
        m.elements.push(...elems);
      });
      if (bi === bars.length - 1) m.barlines = [{ location: "right", style: "light-heavy", afterElements: m.elements.length }];
      respellMeasure(m, bar.key);
      part.measures.push(m);
    });
    assignDegrees(part, song.key ?? { fifths: 0 });
    song.parts.push(part);
  });
  song.marks = marks;
  const doc = emptyDoc("musicxml");
  doc.songs.push(song);

  const warnings = [t("midi.quantized")];
  if (tempos.some((e) => Math.round(e.bpm) !== bpm)) warnings.push(t("midi.tempoWarning"));
  if (drums) warnings.push(t("midi.drumsWarning"));
  if (controls) warnings.push(t("midi.controlWarning"));
  if (dangling) warnings.push(t("midi.danglingWarning"));
  return { doc, warnings };
}

/** 哪几拍按三连音量化：拍里的起止点贴八分三连音的误差不到贴直网格的一半。复拍子、跨小节线的拍不认。 */
function tripletBeats(notes: readonly RawNote[], step: number, barAt: (x: number) => Bar | undefined): Set<number> {
  const err = new Map<number, { straight: number; triplet: number }>();
  const off = (x: number, g: number): number => Math.abs(x - Math.round(x / g) * g);
  for (const n of notes) {
    for (const x of [n.start, n.end]) {
      const b = Math.floor(x / Q);
      const e = err.get(b) ?? { straight: 0, triplet: 0 };
      e.straight += off(x, step);
      e.triplet += off(x, TRIPLET);
      err.set(b, e);
    }
  }
  const out = new Set<number>();
  for (const [b, e] of err) {
    const bar = barAt(b * Q);
    if (!bar || bar.time.beatType > 4 || bar.end < (b + 1) * Q) continue;
    if (e.triplet < e.straight * 0.5) out.add(b);
  }
  return out;
}

/** 量化后仍重叠的：同音高的前一个收在后一个起点；连奏拖进下一个音的一小截（不超过一格、不到前音四分之一）截掉。 */
function trimOverlaps(notes: RawNote[], gridAt: (x: number) => number): void {
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const starts = [...new Set(notes.map((n) => n.start))]; // 已按起点排好
  let si = 0;
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i]!;
    while (si < starts.length && starts[si]! <= a.start) si++;
    const next = starts[si];
    if (next !== undefined && a.end > next && a.end - next <= gridAt(next) && (a.end - next) * 4 <= a.end - a.start) a.end = next;
    for (let j = i + 1; j < notes.length && notes[j]!.start < a.end; j++) {
      if (notes[j]!.pitch === a.pitch && notes[j]!.start > a.start) a.end = notes[j]!.start;
    }
  }
  // 同起点同音高的重复音只留一个
  for (let i = notes.length - 1; i > 0; i--) if (notes[i]!.start === notes[i - 1]!.start && notes[i]!.pitch === notes[i - 1]!.pitch) notes.splice(i, 1);
}

/** 一小节的声部：起止相同的并成和弦，按起点排，放进第一个已空出来的声部（上一小节接过来的音优先回原声部）。 */
function voicesOfBar(notes: readonly RawNote[], bar: Bar, lastVoice: ReadonlyMap<RawNote, number>): Seg[][] {
  const groups = new Map<string, Seg>();
  for (const n of notes) {
    if (n.end <= bar.start || n.start >= bar.end) continue;
    const start = Math.max(n.start, bar.start), end = Math.min(n.end, bar.end);
    const k = `${start}:${end}`;
    const g = groups.get(k);
    if (g) g.notes.push(n);
    else groups.set(k, { start, end, notes: [n] });
  }
  const segs = [...groups.values()].sort((a, b) => a.start - b.start || b.end - a.end);
  const voices: Seg[][] = [[]];
  const freeAt = (v: number): number => voices[v]![voices[v]!.length - 1]?.end ?? bar.start;
  for (const s of segs) {
    s.notes.sort((a, b) => a.pitch - b.pitch);
    const pref = s.notes.map((n) => lastVoice.get(n)).find((v) => v !== undefined);
    let v = pref !== undefined && pref < voices.length && freeAt(pref) <= s.start ? pref : voices.findIndex((_, i) => freeAt(i) <= s.start);
    if (v < 0) {
      v = voices.length;
      voices.push([]);
    }
    voices[v]!.push(s);
  }
  return voices;
}

/** `[from, to)` 拆成能写的时值：三连音拍里按拍内切；直拍上不跨进三连音拍，拍中间起的不跨过下一拍。 */
function pieces(from: number, to: number, isTriplet: (beat: number) => boolean): Piece[] {
  const out: Piece[] = [];
  let p = from;
  while (p < to) {
    const b = Math.floor(p / Q);
    const beatEnd = (b + 1) * Q;
    if (isTriplet(b) && !(p % Q === 0 && to - p >= Q)) {
      const len = Math.min(to, beatEnd) - p;
      if (len % TRIPLET) throw invalid();
      out.push({ dur: len, type: len === 2 * TRIPLET ? "quarter" : "eighth", dots: 0, beat: b });
      p += len;
      continue;
    }
    let limit = to;
    if (p % Q) limit = Math.min(limit, beatEnd);
    else for (let k = b + 1; k * Q < limit; k++) if (isTriplet(k)) { limit = k * Q; break; }
    const v = STRAIGHT.find((s) => s.dur <= limit - p);
    if (!v) throw invalid();
    out.push({ dur: v.dur, type: v.type, dots: v.dots });
    p += v.dur;
  }
  return out;
}

function chordOf(pc: Piece, notes: Note[], voice: number, ids: IdGen): Chord {
  const ch: Chord = {
    kind: "chord",
    id: ids.next(),
    notes,
    duration: { divisions: pc.dur, type: pc.type, dots: pc.dots, ...(pc.beat !== undefined ? { timeMod: { actual: 3, normal: 2 } } : {}) },
    voice,
    staff: 1,
  };
  if (!notes.length) ch.rest = {};
  return ch;
}

const SEMITONE = [0, 2, 4, 5, 7, 9, 11];
const STEP_NAMES: readonly Pitch["step"][] = ["C", "D", "E", "F", "G", "A", "B"];

/** MIDI 音高按调号拼成音名：调内音照调号；调外音升号调（含 C）记升、降号调记降。 */
export function spell(midi: number, fifths: number): Pitch {
  const pc = midi % 12;
  const fit = (shift: number): Pitch | null => {
    for (let s = 0; s < 7; s++) {
      const alter = keyAlter(s, fifths) + shift;
      if ((((SEMITONE[s]! + alter) % 12) + 12) % 12 === pc) {
        return { step: STEP_NAMES[s]!, alter, octave: Math.floor((midi - SEMITONE[s]! - alter) / 12) - 1 };
      }
    }
    return null;
  };
  return fit(0) ?? fit(fifths < 0 ? -1 : 1) ?? fit(fifths < 0 ? 1 : -1)!;
}
