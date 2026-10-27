// 认一页的各阶段共用的阈值与小件（`recognize.ts` 与 `stages/*` 都要用的才放这里；只一处用的跟着用处走）。

import type { Binary, Rect } from "../../omrkit/types";

/** 拍号数字与模板的签名距离上限。见 `bootstrapTimeSig` 那段的说明。 */
export const TIME_TEMPLATE_DIST = 180;

/** 盒（左右各外扩 0.3 格）里放得下一个 0.9×0.6 格、墨占九成以上的窗：贴着一个实心头。
 *  给了 `holes`（原始孔）时，左右两侧 0.3 格内都贴着孔的窗不算：那是两个空心头的圈相接处（是爱 p2 m21 手写粗圈，
 *  B♭4 与错开在右边的 C5 两圈之间连成 0.9 格宽的实墨）；实心头至少一侧是空白或别的笔画。 */
export function solidInside(bin: Binary, b: Rect, sp: number, holes?: Rect[]): boolean {
  const ww = Math.round(sp * 0.9), wh = Math.round(sp * 0.6);
  const x0 = Math.round(b.x - sp * 0.3), x1 = Math.round(b.x + b.w + sp * 0.3) - ww;
  const reach = sp * 0.3;
  const flanked = (x: number, y: number) =>
    !!holes &&
    holes.some((h) => h.y < y + wh && h.y + h.h > y && h.x + h.w >= x - reach && h.x + h.w <= x + ww / 2) &&
    holes.some((h) => h.y < y + wh && h.y + h.h > y && h.x <= x + ww + reach && h.x >= x + ww / 2);
  for (let y = Math.round(b.y); y <= b.y + b.h - wh; y++)
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x + ww > bin.w || y + wh > bin.h) continue;
      let k = 0;
      for (let yy = y; yy < y + wh; yy++) for (let xx = x; xx < x + ww; xx++) k += bin.data[yy * bin.w + xx];
      if (k >= ww * wh * 0.9 && !flanked(x, y)) return true;
    }
  return false;
}

/**
 * 半/全休止的位置闸：块的纵向中心要贴着某行谱的**第二线或第三线**（自上而下数）。
 *
 * 全休止吊在第二线下方、半休止坐在第三线上方，两者的墨迹都紧贴那条线，
 * 中心离线不超过半格。`buildNotes` 随后再按「在线上还是线下」分全与半
 * （那两个字形逐位相同，只能按几何判）。
 */
/** 四分休止的尺寸与填充率（从字典认出来的那批量出来的）。见 `bootstrapQuarterRest` 那一段。 */
export const QREST_W = [0.75, 1.1] as const;
export const QREST_H = [2.2, 3.1] as const;
export const QREST_FILL = [0.33, 0.62] as const;
/** 中段被抽成竖段的四分休止：宽度上限（格）。扫描件笔画粗，比 `QREST_W` 宽一点。 */
export const QREST_SPINE_W = 1.25;
/** 行中换谱号：离谱行左缘多少格以外才找（行首谱号 + 调号 + 拍号在这之内）。 */
export const MID_CLEF_FROM = 5;
/** 被谱线切成两截、按不去线的墨接回来的八分休止：墨占比下限（望十架 p5 细笔扫描件 0.28；烛光颂曲管风琴右手细斜笔 0.23）。 */
export const EIGHTH_REST_FILL_PIECES = 0.2;
