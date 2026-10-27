// 奏法记号与延长记号（MusicXML 的 articulation 名 / fermata）→ SMuFL 字形（朝上那一个）：三引擎共用一份。
// 不碰 DOM（文本谱的语法表 `engrave/jpglyph.ts` 也 import）。朝下的字形由各引擎翻（混排 `NotationItem.setAbove`）。
//
// **简谱与五线谱的断奏不是同一个字**：五线谱是圆点；简谱数字正上方的圆点已经是高八度点，
// 印刷简谱的断奏一律是实心倒三角 ▼，否则两者分不开（1640《主要在中国掌权》）。
// 简谱的 ▼ 照 GB/T 46845 7.9.2.2 谱例（《一枝花》）是宽略大于高的实心三角，借 SMuFL 的朝下实心三角符头
// noteheadTriangleDownBlack（U+E0C7，1.17×1 格）；articStaccatissimo 是 0.4×1.17 格的瘦高楔，排出来像一道短竖线。
import { GlyphCodes } from "../smufl/smufl";

/** 简谱断奏 ▼：noteheadTriangleDownBlack */
const JIANPU_WEDGE = String.fromCharCode(0xe0c7);

export type ArticName = "fermata" | "accent" | "strong-accent" | "staccato" | "tenuto" | "staccatissimo";

/** 记号名 → 朝上的字形；不认得返回 ""。`jianpu` 为真时按简谱的印法（断奏 → 倒三角）。 */
export function articGlyph(name: string, jianpu: boolean): string {
  switch (name) {
    case "fermata": return GlyphCodes.fermataAbove;
    case "accent": return GlyphCodes.articAccentAbove;
    case "strong-accent": return GlyphCodes.articMarcatoAbove;
    case "tenuto": return GlyphCodes.articTenutoAbove;
    case "staccatissimo": return jianpu ? JIANPU_WEDGE : GlyphCodes.articStaccatissimoAbove;
    case "staccato": return jianpu ? JIANPU_WEDGE : GlyphCodes.articStaccatoAbove;
    default: return "";
  }
}
