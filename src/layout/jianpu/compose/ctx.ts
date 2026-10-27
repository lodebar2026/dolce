// 一次原样文档排版的绘制上下文与几样共用的小画法（点、线、文字、数字落笔原点）。
import type { JianpuGrid } from "../metrics";
import { Font } from "../../../pagetree/font";
import type { Rect } from "../../../common/geom";
import { GraphicPath, TextFrame } from "../../../pagetree/pageitem";
import { JpNumber, JpOctaveDot } from "../../../engrave/jpnumber";
import { jpDot } from "../../../engrave/dot";
import { fillRect, strokePath, textItem } from "../../../engrave/prims";
import type { Region } from "../../../style/ss";
import type { DocView } from "../../../jianpu/slots";
import type { PlacedScore, PlacedText } from "../place/model";
import type { PlacedHeader } from "../place/header";
import type { MusicElement } from "../../../jianpu/ast";

/** 一次原样文档排版的上下文（原 PuPainter 的实例状态）。墨色也在这里：
 *  原先是模块级可变量、在 `load` 开头设一次，现在随上下文传，多个实例互不影响。 */
export interface OriginalCtx {
  metrics: JianpuGrid;
  doc: DocView;
  placed: PlacedScore | null;
  digitFont: Font;
  /** 正在画的这一行的上方带（`PlacedVoice.band` 按元素分好）与它的坐标原点（行左缘、声部基线）：`page.ts::paintVoice` 设 */
  band?: ReadonlyMap<MusicElement, readonly PlacedText[]>;
  bandOrigin?: { x: number; y: number };
  pageWidth: number;
  pageHeight: number;
  /** 连续长图裁紧后，整页要平移多少（把墨迹推到左侧留白处） */
  _pageShiftX: number;
  /** 墨色（`style.page.color`）。歌词同色。 */
  ink: number;
  lyricInk: number;
  /** 展开档（投影片，导出 PPTX）：数字落在同一条基线上、增时线是数字字体的「-」字（同旧简谱引擎；PPTX 换目标字体时按它们对位，见 `editor/pptx.ts`） */
  slide?: boolean;
  /** 展开档：正在画的那个符号所在那一遍的遍号（`place/expand.ts::passesOfRow`，`page.ts::paintVoice` 逐个设）；原样档不设 */
  pass?: number;
  /** 各首的页眉定位（place/header.ts::placeHeader；`compose/index.ts` 排版前填） */
  heads?: readonly PlacedHeader[];
  /** 页脚模板（样式表的 `song-foot` 区域；没有就不印） */
  foot: Region | null;
}

/** 实心圆。谱面/混排/文本谱共用一份（`engrave/dot.ts::jpDot`，四段贝塞尔的标准正圆）。
 *  这里原先是两段近似（控制点 1.34r），腰部比正圆略胖。 */
export const dot = (color: number, cx: number, cy: number, r: number): GraphicPath =>
  jpDot(cx, cy, r, color);

export const rect = fillRect;
export const stroke = (color: number, width = 1.4): GraphicPath => strokePath(color, width);

/** 标点挤压（CLREQ，见 common/cjkpunct.ts）：一个音节 = 一个 `<text>`，字 + 尾随标点、或前引号 + 字都在同一串里，
 *  挤压在这里就压掉了（engrave/prims.ts::textItem）。 */
export function text(str: string, x: number, y: number, font: Font, color: number): TextFrame {
  return textItem(str, font, color, x, y, true);
}

/** 音符数字（成书、PPTX 按 `JpNumber` 认）。落笔点由调用方按墨迹居中算好（`digitOrigin`）。 */
export function digitItem(ch: string, x: number, y: number, font: Font, color: number): JpNumber {
  const t = new JpNumber();
  t.text = ch;
  t.font = font;
  t.color = color;
  t.x = x;
  t.y = y;
  return t;
}

/** 八度点 / 附点：圆心 (cx, cy)、半径 r 的实心圆（`JpOctaveDot`，局部盒 (0,0)–(2r,2r)）。 */
export function octaveDot(color: number, cx: number, cy: number, r: number): JpOctaveDot {
  const d = new JpOctaveDot(r, color);
  d.x = cx - r;
  d.y = cy - r;
  return d;
}

/** 数字按墨迹居中于锚点：返回该把文字画在哪个 x/y，并附带墨迹盒。 */
export function digitOrigin(c: OriginalCtx, ch: string): { dx: number; dy: number; b: Rect } {
  const b = c.digitFont.charBound(ch);
  // 展开档：各数字共一条基线（按「1」的墨迹中线定，同旧简谱引擎），PPTX 换成目标字体时框底才齐
  const v = c.slide ? c.digitFont.charBound("1") : b;
  return {
    dx: -(b.left + b.right) / 2,
    dy: -(v.top + v.bottom) / 2,
    b,
  };
}
