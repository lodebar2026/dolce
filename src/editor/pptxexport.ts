// 「导出 PPTX」：写出端在 Rust（`crates/dolce-export/src/pptx.rs`，经按需载入的 dolce-export-wasm；网页与桌面同一份）。
// 这里只拼料：投影档那份排版的各页场景（`layout/scenejson.ts`，带数字墨迹中心、附点与减时线挂哪个数字）、
// 附点间距、页面大小、底色，外加场景里文字用到的字体度量（文本框高按它定，wasm 里没有量字器）。
import { asset } from "../common/asset";
import { measureFontMetrics } from "../common/measure";
import type { Json } from "../layout/painter";
import { exportWasm } from "./pdfexport";

/** 附点离数字那道空的缺省（`crates/dolce-engrave` 的 `STACK_GAP_DEFAULT`）：排版结果没给时用。 */
const STACK_GAP_DEFAULT = 0.17;

/** `ScorePainter.pptxSource`：简谱排的那一份（各页场景 JSON） */
export interface PptxSource {
  pages: readonly Json[];
  /** 附点离数字的那道空（engrave/stack.ts）；没有就取缺省。 */
  stackGap?: number;
  pageWidth: number;
  pageHeight: number;
}

/** Rust `PptxInput` 的 JSON 料（命令行 `dolce-dev pptx --in=` 吃同一份）。 */
export function pptxInput(src: PptxSource, bg = 0xffffffff): Json {
  const metrics = new Map<string, Json>();
  // 场景里的文字节点（`t: "x"`；SMuFL 字是 `s`，不量）用到的字体
  const walk = (n: { t?: string; font?: { family: string; size: number; bold?: boolean; italic?: boolean }; k?: unknown[] }): void => {
    if (n.t === "x" && n.font) {
      const f = n.font;
      const font = { family: f.family, size: f.size, bold: !!f.bold, italic: !!f.italic };
      const k = JSON.stringify(font);
      if (!metrics.has(k)) {
        const m = measureFontMetrics(f.family, f.size, f.bold ? "bold" : "normal", f.italic ? "italic" : "normal");
        metrics.set(k, { font, ascent: m.ascent, descent: m.descent });
      }
    }
    for (const c of n.k ?? []) walk(c as typeof n);
  };
  for (const pg of src.pages) {
    const root = (pg as { root?: unknown }).root;
    if (root) walk(root as Parameters<typeof walk>[0]);
  }
  return {
    pages: src.pages as Json[],
    stackGap: src.stackGap ?? STACK_GAP_DEFAULT,
    pageWidth: src.pageWidth,
    pageHeight: src.pageHeight,
    bg,
    metrics: [...metrics.values()],
  };
}

let bravura: Promise<Uint8Array> | null = null;

export async function buildPptx(src: PptxSource, bg = 0xffffffff): Promise<Uint8Array> {
  bravura ??= fetch(asset("redist/Bravura.otf"))
    .then((r) => {
      if (!r.ok) throw new Error(`Bravura.otf：${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b))
    .catch((e: unknown) => {
      bravura = null;
      throw e;
    });
  const [w, font] = await Promise.all([exportWasm(), bravura]);
  return w.pptx(JSON.stringify(pptxInput(src, bg)), font);
}
