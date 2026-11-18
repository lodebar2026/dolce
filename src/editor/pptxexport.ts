// 「导出 PPTX」：写出端在 Rust（`crates/dolce-export/src/pptx.rs`，经按需载入的 dolce-export-wasm；网页与桌面同一份）。
// 这里只拼料：投影档那份排版的各页场景（`layout/scenejson.ts`，带数字墨迹中心、附点与减时线挂哪个数字）、
// 附点间距、页面大小、底色，外加场景里文字用到的字体度量（文本框高按它定，wasm 里没有量字器）。
import { asset } from "../common/asset";
import { STACK_GAP_DEFAULT } from "../engrave/stack";
import { sceneNode, type Json } from "../layout/scenejson";
import { Group, PageItem, SmuflText, TextFrame } from "../pagetree/pageitem";
import { exportWasm } from "./pdfexport";

/** `ScorePainter.pptxSource`：简谱排的那一份 */
export interface PptxSource {
  pages: readonly Group[];
  /** 附点离数字的那道空（engrave/stack.ts）；没有就取缺省。 */
  stackGap?: number;
  pageWidth: number;
  pageHeight: number;
}

/** Rust `PptxInput` 的 JSON 料（命令行 `dolce pptx --in=` 吃同一份）。 */
export function pptxInput(src: PptxSource, bg = 0xffffffff): Json {
  const metrics = new Map<string, Json>();
  const walk = (it: PageItem): void => {
    if (it instanceof TextFrame && !(it instanceof SmuflText)) {
      const f = it.font;
      const font = { family: f.family, size: f.size, bold: f.bold, italic: f.italic };
      const k = JSON.stringify(font);
      if (!metrics.has(k)) {
        const m = f.metrics;
        metrics.set(k, { font, ascent: m.ascent, descent: m.descent });
      }
    }
    it.children.forEach(walk);
  };
  src.pages.forEach(walk);
  return {
    pages: src.pages.map((pg) => ({ dialect: "jianpu", cls: "score-page", w: src.pageWidth, h: src.pageHeight, root: sceneNode(pg) })),
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
