// 简谱的同音高震音号（GB/T 46845—2025 简谱通用规范 7.8.2.1）：左低右高的几道并列短线，记在音符的**右下角**；
// 和音每个数字各画一个（7.8.3 a），附点在前、震音号在后（同 5.11.2 e「音符右侧符号排在附点之后」）。
// 形状照规范示例 1《打虎上山》逐像素量的（「1 ///」「5· ///」两处，数字墨迹高 H）：
// - 每道是上下两端水平截平的平行四边形，粗细接近数字笔画（谱例粗体数字下水平厚约 0.22 H，这里按本引擎数字的字重取 0.1 H）；
// - 一道竖跨约 0.72 H、横跨约 0.58 H（约 51°）；
// - 几道**依次往右下错开**：每道右移约 0.29 H、下移约 0.23 H；第一道顶齐数字墨迹顶，三道时最后一道的底低出数字底约 0.2 H；
// - 第一道离数字（有附点时离最后一个附点）约 0.45 H。
// 排版占位（`place/spacing.ts::itemBox`）与绘制（`compose/note.ts`）共用这一份。

/** 一道斜线：下端中点 (`x0`, `y0`)、上端中点 (`x1`, `y1`)，两端水平截平、水平厚 `thick` */
export interface JpTremoloStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thick: number;
}

/** 震音号相对锚点（数字墨迹右缘，有附点时为最后一个附点的墨迹右缘；y 为数字墨迹中心，向下为正）的几道斜线与伸出的宽 */
export function jpTremoloStrokes(n: number, H: number): { strokes: JpTremoloStroke[]; width: number } {
  const thick = H * 0.1; // 谱例是粗体数字、斜线水平厚 0.22 H；本引擎数字字重轻，收细到 0.1 H（用户定 2026-10-21）
  const lead = H * 0.45 + thick / 2;
  const dx = H * 0.58;
  const rise = H * 0.72;
  const stepX = H * 0.29;
  const stepY = H * 0.23;
  const top = -H / 2; // 第一道上端齐数字墨迹顶
  const strokes: JpTremoloStroke[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = lead + i * stepX;
    const y1 = top + i * stepY;
    strokes.push({ x0, y0: y1 + rise, x1: x0 + dx, y1, thick });
  }
  return { strokes, width: n > 0 ? lead + (n - 1) * stepX + dx + thick / 2 : 0 };
}

/** 记号名 → 震音几道（`trem1`–`trem4`），不是震音为 0 */
export function jpTremoloCount(names: readonly string[]): number {
  for (const n of names) {
    const m = /^trem([1-4])$/.exec(n);
    if (m) return Number(m[1]);
  }
  return 0;
}
