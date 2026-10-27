// 增时线「-」：原样文档、混排简谱层共用（旧简谱引擎的增时线是格位里的 `JpNumber("-")`，同一个字形）。
//
// 观感照混排：就是数字字体里「-」那一笔。画成**矢量横线**、尺寸按该字形的墨迹量（线宽 = 墨迹高、
// 半长 = 墨迹半宽），与字形一模一样，换数字字体自己跟着走；不另给粗细长短。
// 位置按**墨迹**：墨心落在 (cx, cy)——横向对准拍位，纵向对准数字的墨迹中线。
import { Point } from "../common/geom";
import type { Font } from "../pagetree/font";
import { GraphicLine } from "../pagetree/pageitem";

export interface DashStyle {
  /** 数字字体：尺寸按它的「-」墨迹量。 */
  font: Font;
  color: number;
}

/** 一条增时线，墨心落在 (cx, cy)。 */
export function sustainDash(cx: number, cy: number, style: DashStyle): GraphicLine {
  const b = style.font.charBound("-");
  const half = (b.right - b.left) / 2;
  const l = new GraphicLine();
  l.p0 = new Point(cx - half, cy);
  l.p1 = new Point(cx + half, cy);
  l.strokeColor = style.color;
  l.strokeWidth = b.bottom - b.top;
  return l;
}
