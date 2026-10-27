// 渐强 / 渐弱（松叶）：原样文档与五线谱/混排共用一个画法。
// 两条边各是一段直线（一条路径），尖端处两边高度同为 0 自然汇于一点；跨行断开的那一截由调用方给开口。
import { GraphicPath } from "../pagetree/pageitem";

export interface HairpinSpec {
  x0: number;
  x1: number;
  /** 中线 y。 */
  y: number;
  /** 左、右两端的**半**开口（尖端为 0）。 */
  half0: number;
  half1: number;
  lineWidth: number;
  color: number;
}

export function hairpinPath(h: HairpinSpec): GraphicPath {
  const p = new GraphicPath();
  p.fill = false;
  p.stroke = true;
  p.strokeColor = h.color;
  p.strokeWidth = h.lineWidth;
  p.moveTo(h.x0, h.y + h.half0);
  p.lineTo(h.x1, h.y + h.half1);
  p.moveTo(h.x0, h.y - h.half0);
  p.lineTo(h.x1, h.y - h.half1);
  return p;
}

/**
 * 简谱松叶的几何（旧简谱引擎 `Line.addWedges` 与原样文档 `place/marks.ts` 同一份），尺寸都按数字墨迹高 H：
 * 起止落在音符墨迹中心外 0.3 H，全开口 0.7 H，线宽缺省 0.07 H；跨行的照弧的口径——起头那行画到行末、开口只张到六成，
 * 收尾那行从行首第一个音左 0.9 H 接着张到全开。
 */
export const JP_HAIRPIN = { pad: 0.3, half: 0.35, lineWidth: 0.07, part: 0.6, carryLead: 0.9 } as const;

/** 线宽：尺子给了（`hairpin-width`）就用它，否则 0.07 H。 */
export function jpHairpinLineWidth(width: number, inkHeight: number): number {
  return width > 0 ? width : inkHeight * JP_HAIRPIN.lineWidth;
}

/** 左右两端的半开口。按「张开到几成」算：渐强从尖（0）张到全开（1），渐弱反过来；跨行时行末那截渐强张到六成、
 *  下一行从六成接着张，渐弱则行末收到四成、下一行从四成收尖（两截接起来是同一个松叶）。 */
export function jpHairpinHalves(
  type: "crescendo" | "diminuendo", inkHeight: number, openLeft: boolean, openRight: boolean,
): [number, number] {
  const half = inkHeight * JP_HAIRPIN.half;
  const p = JP_HAIRPIN.part;
  const [f0, f1] = type === "crescendo"
    ? [openLeft ? p : 0, openRight ? p : 1]
    : [openLeft ? 1 - p : 1, openRight ? 1 - p : 0];
  return [half * f0, half * f1];
}
