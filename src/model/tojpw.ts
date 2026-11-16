// `.jpwabc` 写出端：在 Rust（crates/dolce-formats/src/jpw/write.rs），这里是门面。
//
// 输入形状：只经下面这组接口读谱，不认 `Score` 的类——`Score` 结构上满足，`ScoreDoc` 那一侧由 `convert/jpwabc.ts::emitJpwabc`
// 按形状拼（MusicXML 形状 `model/playdoc.ts::jpwInputOfDoc`、简谱形状 `jianpu/playsong.ts::jpwInputOfSong`）。
// 过边界时打成 JSON：条目打 `kind`、`Set` → 数组、`Fraction` → `[分子, 分母]`、只取写出端读的字段。
//
// JP-Word 的 `.Voice` 只有单声部：只写第一声部。和弦符号、力度、slur 以外的弧等装不下的，见 `capability.ts`。

import type { Fraction } from "../common/fraction";
import type { BarStyle } from "../score/enums";
import { dolce } from "../common/dolce";

// ───────────────────────── 输入形状 ─────────────────────────

export interface JpwLyricIn {
  readonly text: string;
  readonly number: number;
  readonly refrain: boolean;
}

/** 简谱写法的一个音：数字、八度点、面上的记号（`b` / `#` / `n` / 空）。 */
export interface JpwPitchIn {
  readonly number: string;
  readonly jpOctave: number;
  readonly jpAlter: string;
}

export interface JpwNoteIn extends JpwPitchIn {
  readonly tieStart: boolean;
  readonly tieEnd: boolean;
  readonly tupletBegin: boolean;
  readonly tupletEnd: boolean;
  readonly lyrics: readonly JpwLyricIn[];
}

export interface JpwChordIn {
  /** 只读 `notes[0]` */
  readonly notes: readonly JpwNoteIn[];
  readonly rest: boolean;
  readonly dot: number;
  readonly beats: number;
  readonly beams: number;
  readonly slurStart: boolean;
  readonly slurEnds: number;
  readonly fermata: boolean;
  readonly graceNotes: readonly JpwPitchIn[];
}

/** 行内换行（`Score.LineBreak`）。 */
export interface JpwLineBreakIn {
  readonly newPage: boolean;
  readonly pass: number | null;
}

/** 小节线条目（`Score.BarlineEntry`）：只看位置——不在小节开头的就地写一根。 */
export interface JpwBarlineIn {
  readonly style: BarStyle | null;
  readonly repeat: "forward" | "backward" | null;
  readonly position: Fraction;
}

export interface JpwMeasureIn {
  /** 和弦、换行、小节线按原次序混排 */
  readonly entries: readonly object[];
  readonly newSystem: boolean;
  readonly newPage: boolean;
  readonly repeatForward: boolean;
  readonly repeatBackward: boolean;
  readonly endingLeft: boolean;
  readonly endingNum: ReadonlySet<number> | null;
  readonly timeChange: boolean;
  readonly keyChange: boolean;
  readonly time: { readonly beats: number; readonly beatType: number };
  readonly key: { readonly fifths: number; readonly name: string };
  readonly barline: BarStyle | null;
}

export interface JpwPlayItemIn {
  readonly mid: number;
  readonly end: number;
  readonly pass: number;
  readonly skip: number;
  readonly limit: number;
}

export interface JpwScoreIn {
  readonly title: string;
  readonly credit: readonly { readonly type: string | null; readonly page: number; readonly text: string }[];
  readonly parts: readonly { readonly measures: readonly JpwMeasureIn[] }[];
  readonly playData: { readonly noRepeat: boolean; readonly tempo: number; readonly measures: readonly JpwPlayItemIn[] };
}

const pitchIn = (p: JpwPitchIn) => ({ number: p.number, jpOctave: p.jpOctave, jpAlter: p.jpAlter });

const noteIn = (n: JpwNoteIn) => ({
  ...pitchIn(n), tieStart: n.tieStart, tieEnd: n.tieEnd, tupletBegin: n.tupletBegin, tupletEnd: n.tupletEnd,
  lyrics: n.lyrics.map((l) => ({ text: l.text, number: l.number, refrain: l.refrain })),
});

/** 条目按形状判别（次序：换行 → 和弦 → 小节线，同原写出端） */
function entryIn(e: object): object {
  if ("newPage" in e && "pass" in e) {
    const b = e as JpwLineBreakIn;
    return { kind: "lineBreak", newPage: b.newPage, pass: b.pass ?? null };
  }
  if ("notes" in e && "beats" in e) {
    const c = e as JpwChordIn;
    return {
      kind: "chord", notes: c.notes.map(noteIn), rest: c.rest, dot: c.dot, beats: c.beats, beams: c.beams,
      slurStart: c.slurStart, slurEnds: c.slurEnds, fermata: c.fermata, graceNotes: c.graceNotes.map(pitchIn),
    };
  }
  if ("style" in e && "repeat" in e) {
    const b = e as JpwBarlineIn;
    return { kind: "barline", style: b.style ?? null, repeat: b.repeat ?? null, position: [b.position.numerator, b.position.denominator] };
  }
  return { kind: "other" };
}

const measureIn = (m: JpwMeasureIn) => ({
  entries: m.entries.map(entryIn), newSystem: m.newSystem, newPage: m.newPage, repeatForward: m.repeatForward, repeatBackward: m.repeatBackward,
  endingLeft: m.endingLeft, endingNum: m.endingNum ? [...m.endingNum] : null, timeChange: m.timeChange, keyChange: m.keyChange,
  time: { beats: m.time.beats, beatType: m.time.beatType }, key: { fifths: m.key.fifths, name: m.key.name }, barline: m.barline ?? null,
});

/** 一份满足输入形状的谱 → `.jpwabc` 文本（保留原始排版的换行）。写不出（坏 jpAlter、heavy-light 线、多房号……）抛错。 */
export function writeJpwabc(score: JpwScoreIn): string {
  const input = {
    title: score.title,
    credit: score.credit.map((c) => ({ type: c.type ?? null, page: c.page, text: c.text })),
    parts: score.parts.map((p) => ({ measures: p.measures.map(measureIn) })),
    playData: {
      noRepeat: score.playData.noRepeat, tempo: score.playData.tempo,
      measures: score.playData.measures.map((i) => ({ mid: i.mid, end: i.end, pass: i.pass, skip: i.skip, limit: i.limit })),
    },
  };
  return dolce().jpwWrite(JSON.stringify(input));
}
