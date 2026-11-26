// 简谱记号名 → 字形 / 文字：力度、小节线上的反复 / 导航记号。文本谱 `&xx`、jianpu-ly 写出、识别歌词共用（无 DOM 依赖）。
// 名字表在 `model/marknames.ts`；排版在 Rust（`crates/engrave` 有同一套表）。
//
// PUA 码位一律用 String.fromCharCode 写，**切勿在源码里写字面 PUA 字符**。

import { GlyphCodes } from "../smufl/smufl";
import { DYNAMIC_NAMES } from "../model/marknames";

const C = (n: number): string => String.fromCharCode(n);

/** 力度的单字母字形（逐字母拼，`sffz`、`rfz`、`pppp` 这类不在常用表里的组合也拼得出）。 */
const LETTER: Readonly<Record<string, string>> = {
  p: GlyphCodes.dynamicPiano,
  m: GlyphCodes.dynamicMezzo,
  f: GlyphCodes.dynamicForte,
  r: GlyphCodes.dynamicRinforzando,
  s: GlyphCodes.dynamicSforzando,
  z: GlyphCodes.dynamicZ,
  n: GlyphCodes.dynamicNiente,
};

/** 力度名 → 字形串；有认不出的字母（不是力度名）返回 ""。 */
export function dynamicGlyphs(name: string): string {
  let res = "";
  for (const c of name) {
    const g = LETTER[c];
    if (g === undefined) return "";
    res += g;
  }
  return res;
}

/** 力度名 → 字形。 */
export const DYNAMICS: Readonly<Record<string, string>> = Object.fromEntries(DYNAMIC_NAMES.map((n) => [n, dynamicGlyphs(n)]));

/** 小节线上的反复 / 导航记号。 */
export const BARLINE_MARKS: Readonly<Record<string, { text?: string; glyph?: string; label: string }>> = {
  fine: { text: "Fine", label: "曲终" },
  dc: { text: "D.C.", label: "从头反复" },
  ds: { text: "D.S.", label: "大反复" },
  ty: { glyph: C(0xe048), label: "跳跃记号" },
  hs: { glyph: C(0xe047), label: "花 S 记号" },
  sbf: { label: "声部括弧起点" },
};
