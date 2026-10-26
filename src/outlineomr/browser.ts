// 浏览器侧入口：转曲的矢量五线谱 PDF → MusicXML。文字走在线 OCR（与位图路同一套 `rasteromr/ocrlive.ts`）。
// PDF 由调用方用 `staffomr/browser.ts::openStaffPdf` 打开（矢量路判路、识别、渲对照底图共用一份）。
import { paddleOcrBackend } from "../omrkit/paddleocr";
import type { StaffGlyphDict } from "../staffomr/staffglyphs";
import type { StaffPdfDoc } from "../staffomr/browser";
import { ocrHarmonyStrips, ocrHeaderStrips, ocrJianpuStrips, ocrLabelStrips, ocrLyricStrips, ocrTimeStrips, ocrWordStrips } from "../rasteromr/ocrlive";
import { OutlineGlyphLookup } from "./glyphs";
import { recognizeOutlinedDoc, type OutlinedPdfResult } from "./song";

export { isOutlinedStaffPdf, type OutlinedPdfResult } from "./song";

let lookPromise: Promise<OutlineGlyphLookup> | null = null;
/** 字形字典与矢量路同一份（`staffomr/glyphmap.json`，动态 import 单独成 chunk），查表器全会话建一次 */
function lookup(): Promise<OutlineGlyphLookup> {
  lookPromise ??= import("../staffomr/glyphmap.json").then((m) => new OutlineGlyphLookup(m.default as unknown as StaffGlyphDict));
  return lookPromise;
}

export async function recognizeOutlinedPdf(
  doc: StaffPdfDoc,
  opts: { title?: string; onProgress?: (done: number, total: number) => void; noteIds?: boolean } = {},
): Promise<OutlinedPdfResult> {
  const look = await lookup();
  const ocr = paddleOcrBackend();
  return recognizeOutlinedDoc(doc.pdf, doc.OPS, look, {
    ...opts,
    live: {
      harmony: (s) => ocrHarmonyStrips(ocr, s),
      lyric: (s) => ocrLyricStrips(ocr, s),
      label: (s) => ocrLabelStrips(ocr, s),
      time: (s) => ocrTimeStrips(ocr, s),
      jianpu: (s) => ocrJianpuStrips(ocr, s),
      word: (s) => ocrWordStrips(ocr, s),
      header: (s) => ocrHeaderStrips(ocr, s),
    },
  });
}
