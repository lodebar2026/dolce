// 统一排版结果的契约（`docs/实现/PuPainter退役.md` §4.3）：页面树、逐页几何（原生坐标 ↔ pt）、
// 命中记录、诊断、五线谱系统落位与简谱行首建议。布局模块产出、ScorePainter 提交、导出与交互消费。
// `readonly` 是消费契约，不是深冻结：页面树内部可变，发布前已 `update()` 归一化，之后谁都不改。

import type { ElementId, SourceSpan } from "../model/doc";
import type { StaffLayout, Sys } from "../mixed/model";
import type { Group } from "../pagetree/pageitem";

/** 一页的几何。`viewBox` 是原生坐标（简谱排版单位 / 五线谱 tenths），`sizePt` 是物理尺寸。 */
export interface PageGeometry {
  readonly viewBox: { x: number; y: number; w: number; h: number };
  readonly sizePt: { w: number; h: number };
  /** 一个原生单位合多少 pt（简谱 1，五线谱取谱里的 scaling）。 */
  readonly ptPerUnit: number;
}

export interface LayoutPage {
  readonly root: Group;
  readonly geometry: PageGeometry;
  readonly renderer: "jianpu" | "staff";
  readonly songIndexes: readonly number[];
}

export interface LayoutDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly source?: SourceSpan;
}

/** 五线谱排好的版面与各系统落位（MusicXML 布局导出写版面坐标用，`editor/xmllayout.ts`）。`top` 是 tenths。 */
export interface StaffPlacement {
  readonly songIndex: number;
  readonly score: StaffLayout;
  readonly systems: readonly { sys: Sys; page: number; top: number }[];
}

export interface LayoutResult {
  readonly title: string;
  readonly pages: readonly LayoutPage[];
  readonly diagnostics: readonly LayoutDiagnostic[];
  readonly staffPlacements: readonly StaffPlacement[];
  /** `Layout.lineStarts` 原值（行序，展开档可能重复）；null = 此视图按源行分行，不给建议。 */
  readonly jianpuLineStarts: readonly ElementId[] | null;
}

/** 原生尺寸 + 换算系数 → 一页的几何（viewBox 原点在 0,0）。 */
export function pageGeometry(w: number, h: number, ptPerUnit: number): PageGeometry {
  return { viewBox: { x: 0, y: 0, w, h }, sizePt: { w: w * ptPerUnit, h: h * ptPerUnit }, ptPerUnit };
}
