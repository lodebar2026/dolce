// 位图五线谱识别的**浏览器侧入口**（编辑器拖入图片 / 扫描 PDF 时用）：图片包成单页 PDF、看前几页判该走哪条路、
// 在线 OCR 跑整曲识别。只有这个文件碰 DOM（画布转 JPEG）与 pdf.js 的浏览器构建；识别本身在 `song.ts`，与回归脚本同一份。
//
// 图片为什么要包成 PDF：位图路吃的是 pdf.js 的页对象（取页里最大的那张内嵌位图，`rasterpage.ts`），
// 包一层就能复用整条管线，回归脚本也是这么喂图片的（`jpegToPdf` 与那边逐字节同构）。

import { openStaffPdf } from "../staffomr/browser";
import { paddleOcrBackend } from "../omr/paddleocr";
import { RasterGlyphLookup, outlineTemplates, type RasterGlyphDict } from "./rasterglyphs";
import { rasterizePage } from "./rasterpage";
import { staffGroupCount } from "./detect";
import { recognizeRasterSong, type RasterSongResult } from "./song";
import { ocrHarmonyStrips, ocrJianpuStrips, ocrLabelStrips, ocrLyricStrips, ocrTimeStrips, ocrWordStrips } from "./ocrlive";
import type { TimeStrip } from "./timesig";

/**
 * 位图路打开 PDF：**关掉浏览器版 pdf.js 的图像解码优化**。缺省它把内嵌位图交成 `ImageBitmap`（离屏画布 / ImageDecoder），
 * `rasterpage.ts` 要的是原始像素（`obj.data`），取不到就当这页没有整页位图——Node 版（回归脚本）本来就给原始像素。
 */
function openRasterPdf(bytes: Uint8Array) {
  return openStaffPdf(bytes, { isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
}

const isPdf = (b: Uint8Array): boolean => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
const isJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** JPEG 的宽高与通道数（SOF0/1/2/9/10 帧头）。 */
function jpegInfo(b: Uint8Array): { w: number; h: number; comps: number } | null {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if ([0xc0, 0xc1, 0xc2, 0xc9, 0xca].includes(m)) {
      return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]!, comps: b[i + 9]! };
    }
    i += 2 + len;
  }
  return null;
}

/** JPEG → 单页 PDF（图像**原样**作 `DCTDecode` 流，不解码不重编码）。 */
export function jpegToPdf(jpg: Uint8Array): Uint8Array {
  const info = jpegInfo(jpg);
  if (!info) throw new Error("读不出 JPEG 尺寸");
  const { w, h, comps } = info;
  const cs = comps === 1 ? "/DeviceGray" : comps === 4 ? "/DeviceCMYK" : "/DeviceRGB";
  const enc = new TextEncoder();
  const objs: (string | { dict: string | null; stream: Uint8Array })[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    { dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, stream: jpg },
    { dict: null, stream: enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`) },
  ];
  const parts: Uint8Array[] = [enc.encode("%PDF-1.4\n")];
  const offs: number[] = [];
  let pos = parts[0]!.length;
  objs.forEach((o, i) => {
    let b: Uint8Array;
    if (typeof o === "string") b = enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`);
    else {
      const dict = o.dict ?? `<< /Length ${o.stream.length} >>`;
      const head = enc.encode(`${i + 1} 0 obj\n${dict}\nstream\n`);
      const tail = enc.encode("\nendstream\nendobj\n");
      b = new Uint8Array(head.length + o.stream.length + tail.length);
      b.set(head, 0);
      b.set(o.stream, head.length);
      b.set(tail, head.length + o.stream.length);
    }
    offs.push(pos);
    parts.push(b);
    pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(enc.encode(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 别的格式的图片（PNG、WebP…）经画布转成 JPEG（质量 1.0，同回归脚本 `sips … formatOptions 100`）。 */
async function toJpeg(bytes: Uint8Array, mime?: string): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], mime ? { type: mime } : {}));
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.fillStyle = "#fff"; // 透明底的 PNG 转成白底
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 1.0));
  if (!blob) throw new Error("图片转 JPEG 失败");
  return new Uint8Array(await blob.arrayBuffer());
}

/** 一份输入（图片或 PDF 字节）→ 位图路吃的 PDF 字节。 */
export async function asRasterPdf(bytes: Uint8Array, mime?: string): Promise<Uint8Array> {
  if (isPdf(bytes)) return bytes;
  return jpegToPdf(isJpeg(bytes) ? bytes : await toJpeg(bytes, mime));
}

/**
 * 这份输入该不该走位图五线谱：前三页（封面、目录页没有谱表）里有一页认得出五线谱表就算。
 * 判据见 `detect.ts`；矢量 PDF（没有整页位图）不在这里认，由矢量那条路（`staffomr`）先判。
 */
export async function looksLikeStaffBytes(pdfBytes: Uint8Array): Promise<boolean> {
  const { pdf, OPS } = await openRasterPdf(pdfBytes);
  try {
    for (let pn = 1; pn <= Math.min(3, pdf.numPages as number); pn++) {
      const page = await pdf.getPage(pn);
      try {
        const r = await rasterizePage(page, OPS);
        if (r && staffGroupCount(r.bin) > 0) return true;
      } finally {
        page.cleanup?.();
      }
    }
    return false;
  } finally {
    pdf.destroy?.();
  }
}

let lookPromise: Promise<RasterGlyphLookup> | null = null;
/** 形状字典与谱号模板（两份 json 动态 import，只在真跑位图五线谱时加载）。与回归脚本同一套配法。 */
function glyphLookup(): Promise<RasterGlyphLookup> {
  lookPromise ??= Promise.all([
    import("./rasterglyphs.json").then((m) => m.default as unknown as RasterGlyphDict),
    import("../staffomr/glyphmap.json").then((m) => m.default as unknown as Parameters<typeof outlineTemplates>[0]),
  ]).then(([dict, glyphmap]) => {
    const look = new RasterGlyphLookup(dict);
    look.templates = outlineTemplates(glyphmap);
    return look;
  });
  return lookPromise;
}

/**
 * 几份输入（每份已是 PDF 字节，图片先 `asRasterPdf`）按顺序合成一首识别。OCR 在线跑（PP-OCR，`ocrlive.ts`）。
 * 返回整曲结果，外加打开的各份 PDF（对照视图取页面位图要用，调用方用完 `destroy`）。
 */
export async function recognizeRasterPdfs(
  pdfs: readonly Uint8Array[],
  opts: { title?: string; onPage?: (done: number, total: number) => void; cancelled?: () => boolean } = {},
): Promise<RasterSongResult> {
  const look = await glyphLookup();
  const ocr = paddleOcrBackend();
  const sources = [];
  for (const b of pdfs) sources.push(await openRasterPdf(b));
  try {
    return await recognizeRasterSong(sources.map((s) => ({ pdf: s.pdf, OPS: s.OPS })), look, {
      title: opts.title,
      onPage: opts.onPage,
      cancelled: opts.cancelled,
      noteIds: true,
      live: {
        harmony: (s) => ocrHarmonyStrips(ocr, s),
        lyric: (s) => ocrLyricStrips(ocr, s),
        label: (s) => ocrLabelStrips(ocr, s),
        time: (s) => ocrTimeStrips(ocr, s),
        jianpu: (s) => ocrJianpuStrips(ocr, s),
        word: (s) => ocrWordStrips(ocr, s),
      },
    });
  } finally {
    for (const s of sources) s.pdf.destroy?.();
  }
}

/** 拍号数字条送 OCR（生成离线缓存的脚本用：与在线识别同一个实现）。回 `[指纹, 读数]` 对。 */
export async function ocrTimeStripsRaw(strips: { w: number; h: number; data: number[] }[]): Promise<[string, string][]> {
  const list = strips.map((s) => ({ ...s, data: Uint8Array.from(s.data), box: { x: 0, y: 0, w: s.w, h: s.h }, staff: 0, role: "num" as const })) satisfies TimeStrip[];
  return [...(await ocrTimeStrips(paddleOcrBackend(), list))];
}
