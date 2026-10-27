// 换气记号：三引擎共用一份。
//
// 印刷简谱的换气是一个**细笔画的 V**，挂在音符的**右上角**——不是 SMuFL 的逗号（`breathMarkComma`）。
// 尺寸都是数字墨迹高 `H` 的倍数，照原样文档的原版矢量量的：V 尖在音符墨心右 0.75 H、
// 基线上方 0.522 H；开口宽 0.383 H、两臂高 0.477 H。
import { GraphicPath } from "../pagetree/pageitem";

const DX = 0.75;
const WIDTH = 0.383;
const ARM = 0.477;
const TIP_ABOVE_BASELINE = 0.522;

/** 换气 V 的墨迹在横向占到音符墨心右边多远（÷ H），排版让位用。 */
export const BREATH_REACH = DX + WIDTH / 2;

/**
 * 换气记号。`cx` 是音符数字的墨心 x、`baseline` 是数字基线 y（y 向下为正），`H` 是数字墨迹高。
 */
export function breathPath(cx: number, baseline: number, H: number, lineWidth: number, color: number): GraphicPath {
  const p = new GraphicPath();
  p.classes.add("breath");
  p.stroke = true;
  p.strokeColor = color;
  p.strokeWidth = lineWidth;
  const x = cx + H * DX;
  const w = H * WIDTH;
  const vy = baseline - H * TIP_ABOVE_BASELINE;
  p.moveTo(x - w / 2, vy - H * ARM);
  p.lineTo(x, vy);
  p.lineTo(x + w / 2, vy - H * ARM);
  return p;
}
