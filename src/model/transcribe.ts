// 转记：实际音高不动，只把全曲统一到目标首调，并按指定规则重算唱名与升降号。

import type { Key, Pitch, ScoreDoc, Song } from "./doc";
import { type EditHooks, midiOfPitch, respellMeasure } from "./edit";
import { keyFifths, songFifths } from "./keyshift";
import { keyAlter } from "../score/jppitch";
import { AccidentalCarry, assignDegrees, continuesMeasure, keySpelling } from "./jianpu";

export type TranscriptionSpelling = "key" | "sharp" | "flat";

export interface TranscriptionOptions {
  /** 目标调号的五度圈位置（-7..7）；界面写作 `1=?`。 */
  fifths: number;
  /** 临时半音按目标调号、统一升号或统一降号拼写。 */
  spelling: TranscriptionSpelling;
  /** 每个临时升降音都写记号，不省略同小节内重复的记号。 */
  repeatAccidentals?: boolean;
}

export interface TranscriptionResult {
  notes: number;
}

/**
 * 简谱来源通常只有 degree。先按原调号把绝对音高补齐，后面换调号时才不会改变实际音高。
 * 规则与 `xmlproject.ts` 导出 MusicXML 时一致：临时记号在小节内延续，八度谱号还原为实际八度。
 */
function fillPitches(song: Song): void {
  const initialKey = { ...song.key, fifths: songFifths(song) };
  for (const part of song.parts) {
    let key = initialKey;
    const clefOctaves = new Map<number, number>();
    let carries = new Map<number, AccidentalCarry>();
    part.measures.forEach((measure, mi) => {
      if (measure.attrs?.key) key = { ...measure.attrs.key, fifths: keyFifths(measure.attrs.key) };
      for (const clef of measure.attrs?.clefs ?? []) clefOctaves.set(clef.staff ?? 1, clef.octaveChange ?? 0);
      if (!continuesMeasure(part.measures[mi - 1], measure)) carries = new Map();
      for (const element of measure.elements) {
        if (element.kind !== "chord") continue;
        let carry = carries.get(element.staff);
        if (!carry) carries.set(element.staff, (carry = new AccidentalCarry()));
        for (const note of element.notes) {
          if (!note.degree || note.degree.number === 0) continue;
          const pitch = carry.pitch(note.degree, key);
          pitch.octave += clefOctaves.get(element.staff) ?? 0;
          if (!note.pitch) note.pitch = pitch;
        }
      }
    });
  }
}

/** 升降策略相对于目标调的唱名，而不是绝对音名的升降号。 */
function spellTranscribedMidi(midi: number, fifths: number, sign: number): Pitch {
  const steps = ["C", "D", "E", "F", "G", "A", "B"] as const;
  const semitones = [0, 2, 4, 5, 7, 9, 11];
  for (const offset of [0, sign]) for (const [i, step] of steps.entries()) {
    const alter = keyAlter(i, fifths) + offset;
    if ((semitones[i]! + alter + 12) % 12 !== (midi % 12 + 12) % 12) continue;
    return { step, alter, octave: (midi - semitones[i]! - alter) / 12 - 1 };
  }
  throw new Error(`Cannot spell MIDI pitch ${midi} in key ${fifths}`);
}

function targetKey(fifths: number): Key {
  const key: Key = { fifths, mode: "major", tonicDegree: "1" };
  key.spelling = keySpelling(key);
  return key;
}

function clearLaterKeys(song: Song, key: Key): void {
  song.key = { ...key };
  for (const part of song.parts) {
    const first = part.measures[0];
    if (first) first.attrs = { ...(first.attrs ?? {}), key: { ...key } };
    part.measures.forEach((measure, mi) => {
      if (mi > 0 && measure.attrs?.key) {
        delete measure.attrs.key;
        if (Object.keys(measure.attrs).length === 0) delete measure.attrs;
      }
      if (measure.laterAttrs) {
        for (const later of measure.laterAttrs) delete later.attrs.key;
        measure.laterAttrs = measure.laterAttrs.filter((later) => Object.keys(later.attrs).length > 0);
        if (measure.laterAttrs.length === 0) delete measure.laterAttrs;
      }
    });
  }
}

/**
 * 就地转记整份文档。所有歌曲、声部、声线、和弦音与倚音都处理；MIDI 音高保持不变。
 * 再次用同一选项执行是幂等的。
 */
export function transcribeScore(doc: ScoreDoc, options: TranscriptionOptions, hooks: EditHooks = {}): TranscriptionResult {
  const fifths = Math.max(-7, Math.min(7, Math.trunc(options.fifths)));
  const key = targetKey(fifths);
  let notes = 0;
  for (const song of doc.songs) {
    fillPitches(song);
    clearLaterKeys(song, key);
    for (const part of song.parts) {
      for (const measure of part.measures) {
        for (const element of measure.elements) {
          if (element.kind !== "chord") continue;
          let pitched = false;
          for (const note of element.notes) {
            if (!note.pitch) continue;
            notes++;
            pitched = true;
            const sign = options.spelling === "sharp" ? 1 : options.spelling === "flat" ? -1 : Math.sign(fifths);
            note.pitch = spellTranscribedMidi(midiOfPitch(note.pitch), fifths, sign || 1);
          }
          if (pitched) hooks.forgetStem?.(element);
        }
        respellMeasure(measure, key);
      }
      assignDegrees(part, key);
      if (options.repeatAccidentals) {
        for (const measure of part.measures) for (const element of measure.elements) {
          if (element.kind !== "chord") continue;
          for (const note of element.notes) {
            if (!note.pitch) continue;
            const accidental = new AccidentalCarry().mark(note.pitch, key);
            if (!accidental || accidental === "natural") continue;
            if (note.degree) note.degree.accidental = accidental;
            // 五线谱来源和写出使用绝对音名的记号，可能需要还原号。
            const alter = note.pitch.alter;
            note.accidental = alter === 0 ? "natural" : alter === 1 ? "sharp" : alter === -1 ? "flat"
              : alter === 2 ? "double-sharp" : "double-flat";
          }
        }
      }
    }
    hooks.forgetLayout?.(song);
  }
  return { notes };
}
