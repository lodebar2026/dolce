// 实心圆：八度点、附点、反复点共用（旧简谱引擎、原样文档、混排三路同一个画法）。
import { GraphicPath } from "../pagetree/pageitem";

/**
 * 实心圆（八度点 / 附点 / 反复点共用）。
 *
 * 四段三次贝塞尔的标准正圆近似（k = 0.5523 = 4/3·(√2−1)）。
 * fanqie 原先用的是两段近似（控制点 1.34r），腰部比正圆胖出约 3%——小到看不出来，
 * 但没有理由留两套。
 */
export function jpDot(cx: number, cy: number, r: number, color: number): GraphicPath {
  const p = new GraphicPath();
  p.fill = true;
  p.stroke = false;
  p.fillColor = color;
  const k = r * 0.5523;
  p.moveTo(cx - r, cy);
  p.cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
  p.cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
  p.cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
  p.cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
  p.close();
  return p;
}
