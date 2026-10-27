// 元素类与三个引擎共用的落笔小件：文字、直线、填充矩形、描边路径、SMuFL 字形文字与它的墨迹盒。
// 原先原样文档（`compose/` 的 rect/stroke/text）、混排（`mixed/prims.ts::addLine`、`jianpuoverlay.ts::textAt`）各写一份。
import { Point, Rect } from "../common/geom";
import type { Font } from "../pagetree/font";
import { GraphicLine, GraphicPath, TextFrame } from "../pagetree/pageitem";
import { glyphCodeName, type MetaData } from "../smufl/smufl";

/** 一串 SMuFL 字形（Bravura 等），挂类名 `smufl`：成书按它落乐谱字体、PPTX 按它转曲。
 *  盒子按**墨迹**（`inkBound`）——Bravura 的字体盒约 4 em 高，按它算会把所在的组、谱行整个撑开。 */
export function musicText(glyphs: string, font: Font, color: number): TextFrame {
  const tf = new TextFrame();
  tf.font = font;
  tf.color = color;
  tf.text = glyphs;
  tf.inkBound = true;
  tf.classes.add("smufl");
  return tf;
}

/**
 * 一串 SMuFL 字形的**墨迹盒**（相对笔位、基线，y 向下为正）。
 *
 * 有元数据且每个字形都查得到就按元数据（与 `SmuflText.bound` 同一口径，`字号 = 4 个 staff space`），
 * 否则退回 canvas 量的墨迹（`Font.charBound`）。**不用字体盒**：Bravura 的 ascent−descent 约 4 em。
 */
export function musicInk(glyphs: string, font: Font, meta?: MetaData): Rect {
  if (meta && [...glyphs].every((g) => glyphCodeName(g) && meta.getBBox(g))) {
    const sp = font.size / 4;
    let x = 0;
    let r = new Rect();
    for (const g of glyphs) {
      const b = meta.getBBox(g)!;
      r = r.union(new Rect(x + b.bBoxSW[0] * sp, -b.bBoxNE[1] * sp, x + b.bBoxNE[0] * sp, -b.bBoxSW[1] * sp));
      x += font.measureText(g);
    }
    return r;
  }
  return font.charBound(glyphs);
}

/** 一段文字，笔位 (x, y)（y 是基线）。`compress`：多字时把挤压后的逐字笔位写进 `charXs`（`Font.run`，CLREQ 标点挤压）。 */
export function textItem(str: string, font: Font, color: number, x: number, y: number, compress = false): TextFrame {
  const t = new TextFrame();
  t.text = str;
  t.font = font;
  t.color = color;
  t.x = x;
  t.y = y;
  if (compress && [...str].length > 1) t.charXs = font.run(str).xs;
  return t;
}

/** 一条直线。 */
export function lineItem(x1: number, y1: number, x2: number, y2: number, lineWidth: number, color: number): GraphicLine {
  const l = new GraphicLine();
  l.p0 = new Point(x1, y1);
  l.p1 = new Point(x2, y2);
  l.strokeColor = color;
  l.strokeWidth = lineWidth;
  return l;
}

/** 填充矩形（左上角 x, y）。 */
export function fillRect(color: number, x: number, y: number, w: number, h: number): GraphicPath {
  const p = new GraphicPath();
  p.moveTo(x, y);
  p.lineTo(x + w, y);
  p.lineTo(x + w, y + h);
  p.lineTo(x, y + h);
  p.close();
  p.fill = true;
  p.fillColor = color;
  return p;
}

/** 空的描边路径，调用方自己 moveTo/lineTo。 */
export function strokePath(color: number, width: number): GraphicPath {
  const p = new GraphicPath();
  p.stroke = true;
  p.strokeColor = color;
  p.strokeWidth = width;
  return p;
}
