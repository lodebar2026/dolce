// 浏览器侧的图片/PDF 解码：createImageBitmap + OffscreenCanvas，PDF 经 pdf.js 光栅化。
// **只有这个文件碰这些 API**——识别管线其余部分经 decode.ts 的注入点拿解码能力
// （同 staffomr/browser.ts 的分工约定）。
import { setImageDecoder, type RgbaImage } from "./decode";
import { largestPageImage } from "./pdf";
import { openPdf } from "./pdf.browser";

const PDF_W = 2000; // PDF 光栅化目标宽度（矢量图放大到此宽度取墨迹）

/** 图片字节 → RGBA（原尺寸；超宽缩图交给 decode.ts 统一做）。 */
async function decodeImage(bytes: Uint8Array, mime?: string): Promise<RgbaImage> {
  const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
  const bmp = await createImageBitmap(blob);
  const { canvas, ctx } = newCanvas(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

function newCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  return { canvas, ctx };
}

/** 取本页最大的一张内嵌位图（其解码后的 ImageBitmap）。多为扫描版乐谱整页图；无则返回 null。
 *  非位图（少见的按 kind 打包的数据）不算，留给整页渲染兜底。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function largestPageBitmap(page: any, OPS: any): Promise<ImageBitmap | null> {
  const obj = await largestPageImage(page, OPS, (o) => (o.bitmap ? o.bitmap.width * o.bitmap.height : null));
  return obj?.bitmap ?? null;
}

/** 单页 → 白底画布：优先直接抽取内嵌位图（源本就是 1-bit 扫描图，避免整页矢量合成重画、
 *  并顺带甩掉赞美诗页码/栏目标题等叠加文字）；页面纯矢量（无内嵌图）时退回整页渲染。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfPageToCanvas(page: any, OPS: any): Promise<OffscreenCanvas> {
  const bmp = await largestPageBitmap(page, OPS);
  if (bmp) {
    const scale = bmp.width > PDF_W ? PDF_W / bmp.width : 1;
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const { canvas, ctx } = newCanvas(w, h);
    ctx.fillStyle = "#fff"; // ImageMask 只有墨迹为不透明黑、其余透明 → 铺白底
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas;
  }
  const viewport = page.getViewport({ scale: PDF_W / page.getViewport({ scale: 1 }).width });
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);
  const { canvas, ctx } = newCanvas(w, h);
  ctx.fillStyle = "#fff"; // PDF 背景透明 → 铺白底，二值化才认得墨迹
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** PDF 字节 → ImageData：逐页取图后竖向拼接为一张白底长图。 */
async function pdfToImageData(bytes: Uint8Array): Promise<ImageData> {
  const { pdf, OPS } = await openPdf(bytes);

  const pages: OffscreenCanvas[] = [];
  let totalH = 0;
  let maxW = 1;
  for (let i = 1; i <= pdf.numPages; i++) {
    const canvas = await pdfPageToCanvas(await pdf.getPage(i), OPS);
    pages.push(canvas);
    totalH += canvas.height;
    maxW = Math.max(maxW, canvas.width);
  }

  const { ctx: octx } = newCanvas(maxW, totalH);
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, maxW, totalH);
  let y = 0;
  for (const c of pages) {
    octx.drawImage(c, 0, y);
    y += c.height;
  }
  return octx.getImageData(0, 0, maxW, Math.max(1, totalH));
}

/** 装配浏览器解码器。由 `browser.ts::installBrowserOmr` 调用。 */
export function installBrowserDecoder(): void {
  setImageDecoder(decodeImage, async (bytes) => {
    const img = await pdfToImageData(bytes);
    return { data: img.data, width: img.width, height: img.height };
  });
}
