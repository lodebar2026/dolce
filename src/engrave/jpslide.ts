// 简谱的上滑音 / 下滑音（GB/T 46845—2025 简谱通用规范 7.6.4.3 a、b）：一根**直线短箭头** ↗ / ↘，记在本音右侧偏上；
// 附点在前、滑音在后（5.11.2 e）。弯的 ↷ 是回滑音（记在音的上方），不是这里的记号。
// 形状照规范示例（7.6.4.3 示例 1《新婚别》`♯5 ↗`、示例 2《一枝花》`↘3`）量的（数字墨迹高 H）：
// - 两处是同一个箭头转向：横跨约 0.5 H、竖跨约 0.85 H；箭头两臂各约 0.25 H、张开约 ±28°；
// - ↘ 箭尾高出数字墨迹顶约 0.24 H、箭尖离基线约 0.4 H；↗ 箭尾离基线约 0.57 H、箭尖高出数字墨迹顶约 0.41 H。
// 谱例里箭头离数字约 0.38 H；横向尽量少占（用户定），收到 0.1 H。
// 排版占位（`place/spacing.ts::itemBox`）与绘制（`compose/note.ts`）共用这一份。

const GAP = 0.1;
const WIDTH = 0.5;
const ARM = 0.25;
const SPREAD = (28 * Math.PI) / 180;

/** 滑音箭头：箭杆 (`x0`,`y0`) → 箭尖 (`x1`,`y1`)，两臂端点 `arms`；`width` 是相对锚点伸出的横宽（含笔画半宽） */
export interface JpSlideArrow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  arms: [number, number][];
  lineWidth: number;
  width: number;
}

/**
 * 滑音箭头。锚点：x 为数字墨迹右缘（有附点时为最后一个附点的墨迹右缘），y 为数字基线（数字墨迹底），向下为正。
 * `up` = 上滑音 ↗，否则下滑音 ↘。
 */
export function jpSlideArrow(up: boolean, H: number): JpSlideArrow {
  const lineWidth = H * 0.07;
  const x0 = H * GAP + lineWidth / 2;
  const x1 = x0 + H * WIDTH;
  const [y0, y1] = up ? [-H * 0.57, -H * 1.41] : [-H * 1.24, -H * 0.4];
  const back = Math.atan2(y0 - y1, x0 - x1); // 箭尖指回箭尾的方向
  const arms: [number, number][] = [-SPREAD, SPREAD].map((s) => [x1 + H * ARM * Math.cos(back + s), y1 + H * ARM * Math.sin(back + s)]);
  const right = Math.max(x1, ...arms.map((a) => a[0]));
  return { x0, y0, x1, y1, arms, lineWidth, width: right + lineWidth / 2 };
}

/** 记号名 → 滑音方向：`shy` 上滑音、`xhy` 下滑音，别的为 undefined */
export function jpSlideOf(names: readonly string[]): "up" | "down" | undefined {
  if (names.includes("shy")) return "up";
  if (names.includes("xhy")) return "down";
  return undefined;
}
