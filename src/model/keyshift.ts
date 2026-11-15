// 文本谱曲中转调 `"k:2"`：新调主音在主调里的级数 ↔ 小节调号（`Measure.attrs.key`）。
// 按五度圈算：级数对应的五度数加到主调的 fifths 上，拼写因此唯一（`k:#4` 与 `k:b5` 是两个调），往返不丢。

import { MusicCommon } from "../score/jppitch";
import type { Key, Song } from "./doc";

/** 各级（1..7）相对主音的五度数 */
const DEGREE_FIFTHS = [0, 2, 4, -1, 1, 3, 5];

/** `N=X`（主音唱名 N 是音名 X）的调号：X 大调退回唱名 N 的五度数。`6=E` 同 `1=G`（1 个升号），
 *  `2=D` 同 `1=C`。拼写认不出返回 `undefined`；越过 ±7 的按同音换回 ±7 以内。 */
export function fifthsOfSpelling(spelling: string, tonicDegree?: string): number | undefined {
  const base = MusicCommon.keyNameToFifth(spelling);
  if (base < -7 || base > 7) return undefined;
  const n = Number(tonicDegree ?? "1");
  let f = base - (n >= 1 && n <= 7 ? DEGREE_FIFTHS[n - 1]! : 0);
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

/** 调号的 fifths。只记了拼写的（文本谱读进来 `fifths` 留 0；123 认不出的拼写）按拼写与主音唱名补算 */
export function keyFifths(k: Key): number {
  if (k.fifths !== 0 || !k.spelling || k.spelling === "none") return k.fifths;
  return fifthsOfSpelling(k.spelling, k.tonicDegree) ?? 0;
}

/** 调式 → 主音唱名（MusicXML `<mode>` 全名） */
const MODE_DEGREE: Readonly<Record<string, number>> = {
  major: 1, ionian: 1, dorian: 2, phrygian: 3, lydian: 4, mixolydian: 5, minor: 6, aeolian: 6, locrian: 7,
};

/** 主音的音名（前置升降号形，`bB`）：有拼写用拼写；否则按主音唱名（或调式推出的唱名）在调号里取 */
export function tonicSpelling(k: Key): string {
  if (k.spelling) return k.spelling;
  const n = Number(k.tonicDegree ?? MODE_DEGREE[k.mode ?? ""] ?? 1);
  let f = k.fifths + (n >= 1 && n <= 7 ? DEGREE_FIFTHS[n - 1]! : 0);
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return MusicCommon.keys[f + 7]!;
}

/** 首调号的 fifths */
export function songFifths(song: Song): number {
  return song.key ? keyFifths(song.key) : 0;
}

/** `k:#4` → 新调号。超出 ±7 的（`1=B` 里 `k:#5`）按同音换成 ±7 以内的拼写 */
export function keyOfDegree(home: number, degree: string): Key | undefined {
  const m = /^([#b]?)([1-7])$/.exec(degree);
  if (!m) return undefined;
  let f = home + DEGREE_FIFTHS[Number(m[2]) - 1]! + (m[1] === "#" ? 7 : m[1] === "b" ? -7 : 0);
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return { fifths: f, spelling: MusicCommon.keys[f + 7]! };
}

/** `keyOfDegree` 的逆：新调号 → 级数写法（`2`、`#4`、`b7`） */
export function degreeOfKey(home: number, fifths: number): string {
  let d = fifths - home;
  while (d > 12) d -= 12;
  while (d < -8) d += 12;
  const acc = d >= 6 ? "#" : d <= -2 ? "b" : "";
  const base = acc === "#" ? d - 7 : acc === "b" ? d + 7 : d;
  return acc + String(DEGREE_FIFTHS.indexOf(base) + 1);
}

/** 是不是小调（导出 MIDI 调号事件的 mi 位）：调式写了 minor / aeolian，或没写调式、主音唱名是 6（`6=A`） */
export function isMinorKey(k: Key): boolean {
  return k.mode !== undefined ? MODE_DEGREE[k.mode] === 6 : k.tonicDegree === "6";
}

/** 移调乐器（`<transpose>`）的记谱调号 → 实际发声的调号：每升一个半音加 7 个五度，越过 ±7 的按同音换回 ±7 以内 */
export function soundingFifths(written: number, chromatic: number): number {
  let f = written + 7 * chromatic;
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}
