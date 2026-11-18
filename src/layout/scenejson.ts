// 场景 JSON（`crates/dolce-scene` 的 `Node` / `Page` 形状）：编辑器「导出 PDF / PPTX」把它交 Rust 写出端。
// 排版在 Rust，场景直接取排好那份（wasm 或桌面原生）。不碰 DOM。
import type { ScorePainter } from "./painter";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 当前结果的各页场景。 */
export function pageScenes(painter: ScorePainter): Promise<Json[]> {
  return painter.scenes();
}
