// 五线谱识别的**核对数据**：位图、矢量两路交出同一个形状——对照视图、并排原图、谱表 ↔ 声部关联表只认它。
// 位图路（`rasteromr/song.ts`）每页带识别出的位图；矢量路（`browser.ts::vectorOverlayResult`）把页面渲成位图拼进来。
import type { Binary } from "../omrkit/types";
import type { SPage } from "./model";
import type { StaffScore } from "./score";

/** 一页的核对数据：底图（位图像素）、页面结构（谱线坐标乘 `scale` 才是像素）。 */
export interface StaffReviewPage {
  raster?: { bin: Binary } | null;
  page: SPage;
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

export interface StaffReviewResult<P extends StaffReviewPage = StaffReviewPage> {
  xml: string | null;
  score: StaffScore | null;
  stats: StaffReviewStats;
  /** 有谱的各页的识别结果（第几份底本、第几页）：对照视图要它的位图与音符坐标。
   *  `scale`：页面结构（`result.page` 的谱线坐标）乘它才是位图像素——矢量 PDF 那一路按 PDF 点识别、渲成位图时放大了（缺省 1） */
  pages: { source: number; pn: number; result: P; scale?: number }[];
  /** `noteIds` 时：写进 `<note id>` 的 id → 第几页（`pages` 下标）、源图上的框（位图像素） */
  noteBoxes: Map<string, { page: number; box: { left: number; right: number; top: number; bottom: number }; step: string; octave: number; alter: number; rest: boolean }>;
  /** 各系统各谱行现在指派到第几个声部行（`buildScore` 的结果；关联表的初值） */
  assignment(): number[][];
  /** 按新的指派（`slots[系统][谱行]`，-1 忽略）重建 MusicXML，不重跑识别 */
  rebuild(slots: number[][]): { xml: string; score: StaffScore };
}
