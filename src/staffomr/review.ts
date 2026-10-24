// 五线谱识别的**核对数据**：位图、矢量两路交出同一个形状——对照视图、并排原图、谱表 ↔ 声部关联表只认它。
// 位图路（`rasteromr/song.ts`）每页带识别出的位图；矢量路（`browser.ts::vectorOverlayResult`）把页面渲成位图拼进来。
import type { Binary } from "../omrkit/types";
import type { SPage } from "./model";
import type { StaffNote } from "./notedata";
import type { StaffScore, SystemOp } from "./score";

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
  /** `noteIds` 时：写进 `<lyric id>` / `<direction id>` / `<slur id>` / `<tied id>` 的 id → 源图上的框（同 `noteBoxes`） */
  markBoxes: Map<string, MarkBox>;
  /** 各系统各谱行现在指派到第几个声部行（`buildScore` 的结果；关联表的初值） */
  assignment(): number[][];
  /** 按新的指派（`slots[系统][谱行]`，-1 忽略）重建 MusicXML，不重跑识别 */
  rebuild(slots: number[][]): { xml: string; score: StaffScore };
  /** 改系统切分（合并 / 拆开，`score.ts::restructureSystems`）后按自动指派重建，不重跑识别；做不了返回 null */
  restructure?(op: SystemOp): { xml: string; score: StaffScore } | null;
}

/** 识别对照里音以外的源框：歌词字、弧、延音线、力度、文字指示 */
export type MarkKind = "lyric" | "slur" | "tied" | "dynamic" | "words";
export interface MarkBox {
  page: number;
  box: { left: number; right: number; top: number; bottom: number };
  kind: MarkKind;
}

/**
 * 逐页逐音编号（`pages` 下标即 `noteBoxes` 的 `page`）：音记在 `omrId`、`<note id="omrK">`；挂在音上、量到了原图框的歌词字、文字指示、
 * 力度、延音线、弧各自编号（`omrL` / `omrW` / `omrD` / `omrT` / `omrS`），记在它们身上、框进 `markBoxes`。
 * 按页序、页内音序编，同一份识别重跑号码不变（`.dolce` 不存框，重开时重识别对回去）。
 * 返回弧号 → id，交给写出端的 `arcId`（弧号是识别内部的配对键，不跨次稳定）。
 */
export function numberOmrIds(
  pages: readonly { notes: readonly StaffNote[] }[],
  noteBoxes: StaffReviewResult["noteBoxes"],
  markBoxes: Map<string, MarkBox>,
): (arc: string) => string | undefined {
  const k = { omr: 0, L: 0, W: 0, D: 0, T: 0, S: 0 };
  const arcs = new Map<string, string>();
  const mark = (pre: "L" | "W" | "D" | "T" | "S", page: number, box: MarkBox["box"], kind: MarkKind): string => {
    const id = `omr${pre}${++k[pre]}`;
    markBoxes.set(id, { page, box: { ...box }, kind });
    return id;
  };
  pages.forEach(({ notes }, pi) => {
    for (const n of notes) {
      const id = `omr${++k.omr}`;
      n.omrId = id;
      noteBoxes.set(id, { page: pi, box: { ...n.sym.box }, step: n.step ?? "C", octave: n.octave ?? 4, alter: n.alter ?? 0, rest: !!n.rest });
      for (const l of n.lyrics ?? []) if (l.box) l.id = mark("L", pi, l.box, "lyric");
      for (const w of n.words ?? []) if (w.box) w.id = mark("W", pi, w.box, "words");
      if ((n.metronome || n.tempoText) && n.tempoBox) n.tempoId = mark("W", pi, n.tempoBox, "words");
      const dynBox = n.dynamicBox ?? n.dynamicSrcBox;
      if (n.dynamic && dynBox) n.dynamicId = mark("D", pi, dynBox, "dynamic");
      if (n.tieStart && n.tieBox) n.tieId = mark("T", pi, n.tieBox, "tied");
      for (const a of n.slurBoxes ?? []) if (!arcs.has(a.arc)) arcs.set(a.arc, mark("S", pi, a.box, "slur"));
    }
  });
  return (arc) => arcs.get(arc);
}
