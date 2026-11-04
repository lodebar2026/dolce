// 歌本切分 · 转曲矢量 PDF 的页面来源：页上没有内嵌位图、文字也转成了路径。按给定分辨率把整页对象画成 SVG 交 sharp（librsvg）
// 栅格化，扫描（固定 `SCAN_DPI`）与出图（`--dpi`）各渲一遍；识别不看这份栅格，回原书取对象（`recognize.ts`）。
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { extractVectorPage, objToSvg, type OpsEnum } from "../../omrkit/vector";
import type { RgbaImage } from "../../omrkit/decode";
import type { PageSource } from "./types";

/** 扫描用的分辨率：与位图歌本的扫描本（300 dpi 上下）同尺度，版面判据、OCR 条的字高都按那个量级标定 */
export const SCAN_DPI = 300;

function pdfjsWasmUrl(): string | undefined {
  try {
    return pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "wasm/")).href;
  } catch {
    return undefined;
  }
}

/** 取样几页判路：都没有内嵌位图、有路径 → 矢量歌本；有文字层的矢量页本期不收。是位图歌本返回 null。 */
export async function openVectorBook(bytes: Uint8Array, stem: string): Promise<PageSource | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes.slice(), isEvalSupported: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    disableFontFace: true, verbosity: 0, wasmUrl: pdfjsWasmUrl(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = await task.promise;
  const OPS: OpsEnum = pdfjs.OPS;
  const n: number = doc.numPages;
  const picks = [...new Set([0.2, 0.5, 0.8].map((f) => Math.min(n, Math.max(1, Math.round(n * f)))))];
  let text = false;
  for (const pn of picks) {
    const page = await doc.getPage(pn);
    try {
      const vec = await extractVectorPage(page, OPS, { scale: 1 });
      if (vec.extras?.images.length || !vec.objs.length) {
        await task.destroy();
        return null;
      }
      if (vec.extras?.hasText) text = true;
    } finally {
      page.cleanup?.();
    }
  }
  if (text) {
    await task.destroy();
    throw new Error("这份矢量 PDF 带文字层（字没有转曲），歌本切分暂只收转曲的矢量 PDF 或位图歌本");
  }
  const scanScale = SCAN_DPI / 72;
  const render = async (i: number, scale: number): Promise<RgbaImage> => {
    const page = await doc.getPage(i + 1);
    try {
      const vec = await extractVectorPage(page, OPS, { scale });
      const w = Math.round(vec.width), h = Math.round(vec.height);
      const body = vec.objs.map((o) => objToSvg(o)).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
      const { data, info } = await sharp(Buffer.from(svg), { limitInputPixels: false, unlimited: true })
        .flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
    } finally {
      page.cleanup?.();
    }
  };
  return {
    count: n,
    name: (i) => `${stem} 第${i + 1}页`,
    page: (i) => render(i, scanScale),
    close: () => task.destroy(),
    vector: { pdf: doc, OPS, scale: scanScale, render },
  };
}
