// TS 排版引擎的配置拼法（迁 Rust 前 `painter.ts` 里那几个）：编辑器已改走 Rust（`painter.ts` → dolce-wasm），
// 这里只剩还没迁走的读者（混排会话的乐句量宽、参考导出 `cli/layoutref.ts` / `cli/staffref.ts`）。H6 随 TS 排版一起删。
// Rust 侧对应：`crates/dolce-session/src/layout.rs`（`jianpu_config` / `layout_staff_doc` / `measure_document`）。

import type { ScoreDoc } from "../model/doc";
import { MetaData } from "../smufl/smufl";
import { jianpuStyleOf } from "../style/jianpu";
import type { StyleSheet } from "../style/sheet";
import { applyStaffStyle } from "../style/staff";
import { computeStyleForPaper, LONG_IMAGE_WIDTH, THEMES } from "../style/themes";
import { pageMargins, resolvePaper } from "../style/paper";
import type { Region } from "../style/ss";
import { MixedOptions } from "../mixed/model";
import { type JianpuLayoutConfig } from "./jianpu/compose";
import { clearSongBreaks } from "../model/breaks";
import type { JianpuPaintRequest } from "./painter";

/** `measureDocument` 交给简谱引擎的那份文档与配置（只留断句的旋律声部、清掉换行）；没有可量的为 null。 */
export function measureRequestOf(
  doc: ScoreDoc, sheet: StyleSheet, width: number, slide = false, song = 0,
): { doc: ScoreDoc; cfg: JianpuLayoutConfig } | null {
  const one = doc.songs[song];
  if (!one) return null;
  const lead = one.parts.find((p) => p.measures.some((m) => m.elements.some((e) => e.kind === "chord" && (e.lyrics?.length ?? 0) > 0))) ?? one.parts[0];
  if (!lead) return null;
  const clone = structuredClone({ ...doc, songs: [{ ...one, parts: [lead] }] });
  if (doc.sourceFormat !== "fanqie") for (const song of clone.songs) clearSongBreaks(song);
  return {
    doc: clone,
    cfg: {
      style: jianpuStyleOf(sheet),
      page: { width, height: width, continuous: true },
      userMargins: pageMargins(sheet.page) !== undefined,
      foot: null,
      measure: true,
      ...(slide ? { book: true } : {}),
    },
  };
}

const defaultStaffStyle = (): StyleSheet => computeStyleForPaper([THEMES.staff], { engine: "staff" });

/** 五线谱 / 混排的排版选项：按样式表（缺省取内置 `staff` 主题）灌好。 */
export function staffOptionsOf(meta: MetaData, style?: StyleSheet): MixedOptions {
  const options = new MixedOptions(meta);
  applyStaffStyle(options, style ?? defaultStaffStyle());
  return options;
}

/** 简谱这一路的请求 → 简谱引擎的外部配置（纸、尺子、页脚模板）。 */
export function jianpuCfgOf(req: JianpuPaintRequest): JianpuLayoutConfig {
  const sheet = req.style ?? computeStyleForPaper([THEMES.print], { mode: "original", engine: "jianpu" });
  const paper = resolvePaper(sheet.page);
  const slide = req.view === "expanded" ? { width: sheet.page.size?.[0] ?? 960, height: sheet.page.size?.[1] ?? 540, continuous: false } : null;
  return {
    style: jianpuStyleOf(sheet),
    page: slide ?? (req.page
      ? { width: req.page.w, height: req.snippet ? req.page.w : req.page.h, continuous: !!req.snippet }
      : paper ? { width: paper.w, height: paper.h, continuous: false } : { width: LONG_IMAGE_WIDTH, height: LONG_IMAGE_WIDTH, continuous: true }),
    userMargins: pageMargins(sheet.page) !== undefined,
    foot: (sheet.template?.regions?.["song-foot"] as Region | undefined) ?? null,
    noReflow: req.noReflow,
    expanded: req.view === "expanded",
    breakDesc: req.breakDesc ?? null,
    ...(req.snippet ? { snippet: true } : {}),
    ...(req.ink !== undefined ? { ink: req.ink } : {}),
  };
}
