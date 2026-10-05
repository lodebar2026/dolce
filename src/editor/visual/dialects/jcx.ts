// Muse `.jcx` 的音符 token：`[^ _ =]*字母[' ,]*[时值]`，休止 `z[时值]`——写法同 ABC（`dialects/abc.ts`），
// **但简谱轨的字母就是唱名**（C=1，`abcfamily/dialectjcx.ts`）：不经调号换算，升降号也直接是简谱的（相对调号）。
// 所以只有时值那一半借 ABC 的（相对 `L:`、没有增时线，二分音符 `C4` 在动作层里当作「带一条增时线」）。
// 换行就是代码行末，`w:` 对紧挨在前的那条代码行；延音线写 `-`。

import type { Accidental } from "../../../model/doc";
import { DEGREE_OF_LETTER, LETTER_OF_DEGREE } from "../../../abcfamily/dialectjcx";
import { type EditDialect, keyFifthsAt, type NoteCtx, type NoteDuration, type NoteToken } from "../dialect";
import { colonFields } from "../header";
import { abcFamilyMeasure } from "../measureops";
import { keyTonic } from "../measureinput";
import { tupletNormal } from "../../../model/edit";
import { lenOf, lenText, quartersOf, split, unitAt } from "./abc";

const ACC_OF: Record<string, Accidental> = { "^^": "double-sharp", __: "double-flat", "^": "sharp", _: "flat", "=": "natural" };
const ACC_TEXT: Record<Accidental, string> = { "double-sharp": "^^", "double-flat": "__", sharp: "^", flat: "_", natural: "=" };

const NOTE_RE = /^(\^\^|__|\^|_|=)?([A-Ga-g])([',]*)(\d*)(\/*)(\d*)$/;
const REST_RE = /^z(\d*)(\/*)(\d*)$/;

export const DIALECT_JCX: EditDialect = {
  parseNote(src: string, nc: NoteCtx) {
    const rest = REST_RE.exec(src);
    const m = rest ? null : NOTE_RE.exec(src);
    if (!rest && !m) return null;
    const q = (rest ? lenOf(rest[1]!, rest[2]!, rest[3]!) : lenOf(m![4]!, m![5]!, m![6]!)) * nc.unitQuarters;
    const dur = split(q);
    if (!dur) return null;
    const base = { halvings: dur.h, dots: dur.d, inlineSustains: dur.s, pre: "", post: "" };
    if (rest) return { acc: null, degree: 0, octave: 0, ...base };
    const letter = m![2]!;
    const octave = (/[a-g]/.test(letter) ? 1 : 0) + [...m![3]!].reduce((n, c) => n + (c === "'" ? 1 : -1), 0);
    return {
      acc: m![1] ? ACC_OF[m![1]] ?? null : null,
      degree: DEGREE_OF_LETTER[letter.toUpperCase()]!,
      octave,
      ...base,
    };
  },
  printNote(t: NoteToken, nc: NoteCtx) {
    const len = lenText(quartersOf(t) / nc.unitQuarters);
    if (t.degree === 0) return `${t.pre}z${len}${t.post}`;
    const letter = LETTER_OF_DEGREE[t.degree - 1] ?? "C";
    const head = t.octave >= 1 ? letter.toLowerCase() + "'".repeat(t.octave - 1) : letter + ",".repeat(-t.octave);
    return `${t.pre}${t.acc ? ACC_TEXT[t.acc] : ""}${head}${len}${t.post}`;
  },
  noteParts(src: string) {
    if (REST_RE.test(src)) return { head: [0, 1], dots: null };
    const m = NOTE_RE.exec(src);
    if (!m) return null;
    return { head: [0, (m[1] ?? "").length + 1 + m[3]!.length], dots: null };
  },
  newNote(degree: number, dur: NoteDuration, nc: NoteCtx) {
    return this.printNote({ acc: null, degree, octave: 0, halvings: dur.halvings, dots: dur.dots, inlineSustains: 0, pre: "", post: "" }, nc);
  },
  contextAt(state, doc, pos): NoteCtx {
    return { fifths: keyFifthsAt(doc, pos), unitQuarters: unitAt(state, pos) };
  },
  headerFields: (text) => colonFields(text, { T: "text", C: "text", Q: "text", K: "key", M: "time" }),
  // 调号照 Muse 自己存的写法：降号在前（`bE`）
  measure: abcFamilyMeasure((fifths) => keyTonic(fifths).replace(/^([A-G])([#b])$/, "$2$1")),
  sustain: "inline",
  sep: " ",
  barline: "|",
  lineBreak: "",
  pageBreak: null,
  slurOpen: "(",
  slurClose: ")",
  slurInToken: false,
  slurNesting: true,
  tie: "-",
  lyricBlockByCodeLine: true,
  lyricsFollowBreaks: true,
  // Muse 的装饰名（说明书 §3.2.3.16；谱例里延长是 `!HOLD!`、重音是 `!ATT!`）
  deco: { names: { fermata: "HOLD", accent: "ATT" }, text: (n) => `!${n}!`, place: "before" },
  chordText: (name) => `"${name}"`,
  tuplet: { open: (n) => (n <= 4 ? `(${n}` : `(${n}:${tupletNormal(n)}`), close: null, openRe: /\(\d+(?::\d*){0,2}\s*$/ },
  bracketChords: true,
};
