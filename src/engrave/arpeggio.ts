// 琶音：竖着的波浪线，画在和弦左边、从最低的音画到最高的音。两个引擎共用这一份：
// SMuFL 的 `wiggleTrillSlow` 一段段横着拼起来、整串转 90°（照 musicpp render.cpp drawMeasureMeta）。
// 一段的长度是 1.2 个 staff space（字号 = 4 个 staff space）。
import { Matrix33 } from "../common/geom";
import { Font } from "../pagetree/font";
import type { PageItem } from "../pagetree/pageitem";
import { GlyphCodes } from "../smufl/smufl";
import { textItem } from "./prims";

/** 简谱：乐谱字体字号取数字墨迹高的 1.2 倍（一段约 0.36 个墨迹高），线在临时记号/数字左边再空这么多（÷ 墨迹高） */
export const JP_ARPEGGIO_SIZE = 1.2;
export const JP_ARPEGGIO_LEAD = 0.6;

/** 琶音线从 `top` 画到 `bottom`（y 向下为正），x 是线的位置；`size` 是乐谱字体字号。 */
export function arpeggioGroup(x: number, top: number, bottom: number, size: number, color = 0xff000000): PageItem {
  const seg = (size / 4) * 1.2;
  const cnt = Math.max(1, Math.ceil((bottom - top) / seg));
  const t = textItem(GlyphCodes.wiggleTrillSlow.repeat(cnt), new Font("Bravura", size), color, 0, 0);
  t.classes.add("arpeggio");
  // 旋转直接放在字形这一片叶子上（两条路都认叶子自带的 matrix；套一层 Group 会被 update() 归一冲掉）
  const m = new Matrix33();
  m.setAffine([0, 1, -1, 0, x, top]); // translate(x, top) ∘ rotate(90°)：字形往下排
  t.matrix = m;
  return t;
}
