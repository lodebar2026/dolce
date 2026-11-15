// 五线谱识别的**核对数据**：位图、矢量两路交出同一个形状——对照视图、并排原图、谱表 ↔ 声部关联表只认它。
// 由 Rust 会话产物经 `omrrust/adapter.ts` 包成。
import type { Binary } from "./types";
/** 系统切分的修正：并到上一系统 / 从某行起切开（交给 Rust 会话的 restructure）。 */
export type SystemOp = { merge: number } | { split: { system: number; row: number } };

type LrtbBox = { left: number; right: number; top: number; bottom: number };

/** 核对视图用到的一行谱：五条线的 y、各小节的右线与里面各音的框（TS 的 `model.ts::Staff`、Rust 核对 JSON 都满足）。 */
export interface ReviewStaff {
  readonly lineYs: readonly number[];
  readonly bars: readonly { readonly right: number; readonly notes: readonly { readonly box: LrtbBox }[] }[];
}

/** 核对视图用到的一页结构（TS 的 `SPage`、Rust 核对 JSON 都满足）。 */
export interface ReviewPageGeom {
  readonly staves: readonly ReviewStaff[];
}

/**
 * 编辑器（`omrctl.ts`：点谱行菜单 `staffRowAt`、对照视图 `renderStaffPages`、关联表 `staffAssignment`）从整曲结果里读的只有系统表：
 * 各系统在哪一页、由哪几行谱组成。系统里的谱行、页对象与 `pages[].result.page` 里的是**同一个对象**（按引用比）。
 * TS 识别路的 `StaffScore` 原样满足；Rust 那一路由 `omrrust/adapter.ts` 按核对 JSON 拼出。
 */
export interface ReviewGeometry {
  readonly systems: readonly { readonly page: ReviewPageGeom; readonly sys: { readonly staves: readonly ReviewStaff[] } }[];
}

/** 一页的核对数据：底图（位图像素）、页面结构（谱线坐标乘 `scale` 才是像素）。 */
export interface StaffReviewPage {
  raster?: { bin: Binary } | null;
  page: ReviewPageGeom;
  /** 谱表正上方认出的简谱行（只有位图路的简线混排谱有） */
  jianpuStrips?: readonly unknown[];
}

export interface StaffReviewStats {
  notes: number;
  harmonies: number;
  lyricLines: number;
  lyricStats: { rows: number; hit: number; parity: number };
  bars: number;
  full: number;
  unknown: number;
  staves: number;
  pages: number;
  halftone: number | null;
  kind: string | null;
  jianpuFix: { pairs: number; pitch: number; duration: number; removed: number; inserted: number };
  systems?: number;
  parts?: number;
}

/** 重建的产物：新的 MusicXML 与系统结构。 */
export type Rebuilt = { xml: string; score: ReviewGeometry };

export interface StaffReviewResult<P extends StaffReviewPage = StaffReviewPage> {
  xml: string | null;
  score: ReviewGeometry | null;
  stats: StaffReviewStats;
  /** 有谱的各页的识别结果（第几份底本、第几页）：对照视图要它的位图与音符坐标。
   *  `scale`：页面结构（`result.page` 的谱线坐标）乘它才是位图像素——矢量 PDF 那一路按 PDF 点识别、渲成位图时放大了（缺省 1） */
  pages: { source: number; pn: number; result: P; scale?: number }[];
  /** `noteIds` 时：写进 `<note id>` 的 id → 第几页（`pages` 下标）、源图上的框（位图像素） */
  noteBoxes: Map<string, { page: number; box: { left: number; right: number; top: number; bottom: number }; step: string; octave: number; alter: number; rest: boolean }>;
  /** `noteIds` 时：写进 `<lyric id>` / `<direction id>` / `<slur id>` / `<tied id>` 的 id → 源图上的框（同 `noteBoxes`） */
  markBoxes: Map<string, MarkBox>;
  /** 各系统各谱行现在指派到第几个声部行（`buildScore` 的结果；关联表的初值） */
  assignment(): number[][];
  /** 按新的指派（`slots[系统][谱行]`，-1 忽略）重建 MusicXML，不重跑识别（Rust 会话是异步的，TS 各路同步回） */
  rebuild(slots: number[][]): Rebuilt | Promise<Rebuilt>;
  /** 改系统切分（合并 / 拆开，`score.ts::restructureSystems`）后按自动指派重建，不重跑识别；做不了返回 null */
  restructure?(op: SystemOp): Rebuilt | null | Promise<Rebuilt | null>;
}

/** 识别对照里音以外的源框：歌词字、弧、延音线、力度、文字指示 */
export type MarkKind = "lyric" | "slur" | "tied" | "dynamic" | "words";
export interface MarkBox {
  page: number;
  box: { left: number; right: number; top: number; bottom: number };
  kind: MarkKind;
}
