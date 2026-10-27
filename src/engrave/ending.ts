// 房号括线（volta / ending）的**画法**：旧简谱引擎（`layout.ts::Line.drawEnding`）与五线谱 / 混排
// （`mixed/render.ts::drawEnding`）共用。位置各算各的（简谱按小节线墨迹、五线谱按小节的 tick 与数据区），
// 这里只管「横线 + 可选的两侧竖脚 + 房号」怎么落笔，两边观感因此一致。
import type { Font } from "../pagetree/font";
import { GraphicPath, Group, TextFrame } from "../pagetree/pageitem";

/** 房号墨迹顶与横线下沿之间的空，按房号字号计。 */
const LABEL_GAP = 0.3;

export interface EndingBracket {
  /** 横线左右端（竖脚就落在这两处）。坐标系是调用方给的 `g`。 */
  x0: number;
  x1: number;
  /** 横线的 y；竖脚从这里往下 `drop`。 */
  top: number;
  drop: number;
  /** 左脚：跨行续过来的那一段不画。 */
  leftFoot: boolean;
  /** 右脚：`stop` 封口；`discontinue`、跨到下一行、一组房的最后一房都不封。 */
  rightFoot: boolean;
  lineWidth: number;
  color: number;
  /** 房号：摆在左脚右侧 `dx` 处；纵向**从横线往下算**，见 `labelBaseline`。 */
  label?: { text: string; font: Font; dx: number };
  /** 给下游认的类名（成书的 line-check 靠它们认房号，见 `pdflayout/browser.ts::CLS_TAGS`）。 */
  classes?: { line: string; label: string };
}

/**
 * 房号基线相对横线（线心）的下移量：半个线宽 + 一道空 + 房号**墨迹**的上伸高度。
 * 按墨迹量而不是按字号或竖脚长估，所以换字体、换字号、竖脚长短不一（成书是实测的短脚）时，
 * 文字顶都落在横线下方，永远不与横线相压。
 */
export function labelBaseline(font: Font, text: string, lineWidth: number): number {
  return labelBaselineOf(font.charBound(text).top, font.size, lineWidth);
}

/** 同 `labelBaseline`，墨迹顶（基线之上为负）由调用方量好（原样文档定位端不碰字体）。 */
export function labelBaselineOf(inkTop: number, size: number, lineWidth: number): number {
  return lineWidth / 2 + size * LABEL_GAP - Math.min(0, inkTop);
}

/** 竖脚长：尺子给了实测短脚（`vertical.bracketFoot`，成书）就用它，否则与房号字号等长（五线谱是两个线距、房号 20 tenths）。 */
export function endingDrop(bracketFoot: number, size: number): number {
  return bracketFoot > 0 ? bracketFoot : size;
}

/** 房号离左脚的横向距离：编辑器照五线谱右移约半个字号；成书照原书 0.28 个字号（竖脚是实测的短脚）。 */
export function endingLabelDx(lineWidth: number, size: number, bracketFoot: number): number {
  return lineWidth + size * (bracketFoot > 0 ? 0.28 : 0.4);
}

/** 房号原文规整：只由数字与分隔（逗号/顿号/中点/空格/句点）组成时，数字之间统一用半角句点，
 *  尾点照原文（原书 `1.2` / `3` 不带尾点）；含别的字（`Fine`、`D.C.`…）原样返回。 */
export function normEndingText(text: string): string {
  if (!/^[\d\s.,，、·]+$/.test(text) || !/\d/.test(text)) return text;
  const t = text.trim();
  return (t.match(/\d+/g) ?? []).join(".") + (t.endsWith(".") ? "." : "");
}

/** 画进 `g`，返回房号那个文字对象（没有房号时为 null），调用方需要时自己 `update()`。 */
export function addEndingBracket(g: Group, b: EndingBracket): TextFrame | null {
  const path = new GraphicPath();
  if (b.classes) path.classes.add(b.classes.line);
  path.stroke = true;
  path.fill = false;
  path.strokeColor = b.color;
  path.strokeWidth = b.lineWidth;
  if (b.leftFoot) {
    path.moveTo(b.x0, b.top + b.drop);
    path.lineTo(b.x0, b.top);
  } else {
    path.moveTo(b.x0, b.top);
  }
  path.lineTo(b.x1, b.top);
  if (b.rightFoot) path.lineTo(b.x1, b.top + b.drop);
  g.add(path);
  if (b.label) {
    const tf = new TextFrame();
    if (b.classes) tf.classes.add(b.classes.label);
    tf.font = b.label.font;
    tf.color = b.color;
    tf.text = b.label.text;
    tf.x = b.x0 + b.label.dx;
    tf.y = b.top + labelBaseline(b.label.font, b.label.text, b.lineWidth);
    g.add(tf);
    return tf;
  }
  return null;
}
