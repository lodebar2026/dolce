// 简谱字号的折算（设置面板显示用）：音符字号、标题 / 词曲字号。尺子（`JianpuStyle`）的折算在 Rust（`crates/engrave/src/style/jianpu.rs`）。
import type { StyleRole, StyleSheet } from "./sheet";
import { PPTX_PAGE } from "./themes";
import { resolveLength } from "./units";

/** 标题/词曲字号 ÷ 音符字号（那两档不单独设标题与词曲，字号一改整块跟着缩放）。
 *  投影档取投影片出厂那三个数的比（48/28、36/28）；简谱档照 500 首成书实测（标题 22.03、署名 10.98、音符 12.08）。 */
const HEAD_RATIOS = {
  pptx: { title: PPTX_PAGE.titleSize / PPTX_PAGE.fontSize, credit: PPTX_PAGE.creditSize / PPTX_PAGE.fontSize },
  original: { title: 22.03 / 12.08, credit: 10.98 / 12.08 },
} as const;

/** 角色字号（pt）。`note` 是 em 的基准、只认 pt；别的角色写 em 就是音符字号的几倍，折出来落到整数或 .5（样式值少有效位）。 */
function rolePt(sheet: StyleSheet, role: StyleRole, notePt = NaN): number | undefined {
  const v = sheet.roles[role]?.size;
  if (v === undefined) return undefined;
  const pt = resolveLength(v, { em: notePt, sp: NaN });
  if (pt === null || !Number.isFinite(pt) || pt <= 0) return undefined;
  return typeof v === "string" && v.endsWith("em") ? Math.round(pt * 2) / 2 : pt;
}

/** 排版器的构造字号。成书取歌词那一档，其余取音符字号。 */
export function jianpuFontSize(sheet: StyleSheet): number {
  if (sheet.jianpu.preset === "book" && sheet.book) return sheet.book.roles.lyric.size;
  return rolePt(sheet, "note") ?? PPTX_PAGE.fontSize;
}

function headRatios(sheet: StyleSheet): { title: number; credit: number } {
  return sheet.jianpu.preset === "original" ? HEAD_RATIOS.original : HEAD_RATIOS.pptx;
}

/** 字号标题、词曲的实际值：给了就用；简谱档没给就按出厂比例派生。 */
export function jianpuSizes(sheet: StyleSheet): { fontSize: number; titleSize: number; creditSize: number } {
  const fontSize = jianpuFontSize(sheet);
  return {
    fontSize,
    titleSize: rolePt(sheet, "title", fontSize) ?? Math.round(fontSize * headRatios(sheet).title),
    creditSize: rolePt(sheet, "credit", fontSize) ?? Math.round(fontSize * headRatios(sheet).credit),
  };
}
