// 歌本切分的数据类型。
import type { RgbaImage } from "../../omrkit/decode";
import type { Rect } from "../../omrkit/types";
import type { Band, PageLayout } from "./layout";

/** 整本的页面来源（PDF 或页图文件夹），按页惰性取原分辨率图。 */
export interface PageSource {
  count: number;
  /** 报告里称呼第 i 页用（文件名或「第 n 页」）。 */
  name(i: number): string;
  page(i: number): Promise<RgbaImage>;
  close(): Promise<void>;
  /** 转曲矢量歌本（`vector.node.ts`）：`page()` 是按 `scale`（像素 / PDF 点）渲的扫描图，`render` 按别的分辨率重渲，
   *  识别回 `pdf` 取对象。位图歌本没有。 */
  vector?: VectorBook;
}

export interface VectorBook {
  /** pdf.js 的 PDFDocumentProxy */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: any;
  OPS: Record<string, number>;
  /** 扫描图每 PDF 点几个像素 */
  scale: number;
  render(i: number, scale: number): Promise<RgbaImage>;
}

/** 一页上认出的标题。 */
export interface TitleHit {
  band: Band;
  /** 曲名（OCR，去字间空格）；没认出为空串。 */
  title: string;
  /** 标题行上印的曲号（OCR）。 */
  number?: number;
  /** 整行 OCR 里曲号首末两字的横坐标（逐字重认用）。 */
  numberSpan?: [number, number];
  /** 曲名由几框拼成时的整段外框（整段重认用）。 */
  titleBox?: Rect;
}

/** 第一遍扫描每页得到的信息（不留像素）。 */
export interface PageInfo {
  index: number;
  layout: PageLayout;
  /** 印的页码（页脚 OCR）。 */
  printed?: number;
  /** 页码的墨迹框（已从正文剔除；与正文同排时输出图上要涂掉）。 */
  footer?: Rect;
  /** 正文带（去页脚）。 */
  body: Band[];
  titles: TitleHit[];
  /** 整页 OCR 出的目录条目（只对像目录的页做）。 */
  toc: TocEntry[];
}

export interface TocEntry {
  /** 首句 / 经文等（只作报告用）。 */
  text: string;
  number: number;
  /** 印的页码；只列「曲号 曲名」的目录没有。 */
  page?: number;
}

/** 一首歌在某一页上的一段。 */
export interface Piece {
  page: number;
  /** 段内容的纵向范围 [y0, y1)（源图像素）。 */
  y0: number;
  y1: number;
  /** 该页版心左缘（各段按它对齐）。 */
  typeX: number;
}

export interface SongPlan {
  number?: number;
  title: string;
  /** 起始页（源序号，0 起）。 */
  startPage: number;
  pieces: Piece[];
  /** 拼缝处用的系统间距（像素）。 */
  seamGap: number;
  issues: string[];
}

/** 合成参数：版心距纸边的边距与输出宽。 */
export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 版心宽（全书中位）。 */
  typeW: number;
}

/** 一张输出图的摆放：每段从源页 `src` 矩形拷到画布 (dx, dy)，其余填纸色。 */
export interface Placement {
  page: number;
  src: Rect;
  dx: number;
  dy: number;
}

export interface Layout {
  width: number;
  height: number;
  paper: [number, number, number];
  parts: Placement[];
  /** 拷进来的源图里夹带的页码，画布坐标，涂纸色。 */
  erase: Rect[];
}
