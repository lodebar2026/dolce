// 位图五线谱识别的**浏览器侧入口**（编辑器拖入图片 / 扫描 PDF 时用）：图片包成单页 PDF、看前几页判该走哪条路、
// 在线 OCR 跑整曲识别。只有这个文件碰 DOM（画布转 JPEG）与 pdf.js 的浏览器构建；识别本身在 `song.ts`，与回归脚本同一份。
//
// 图片为什么要包成 PDF：位图路吃的是 pdf.js 的页对象（取页里最大的那张内嵌位图，`rasterpage.ts`），
// 包一层就能复用整条管线，回归脚本也是这么喂图片的（`jpegToPdf` 与那边逐字节同构）。

import { openPdf } from "../omrkit/pdf.browser";
import { paddleOcrBackend } from "../omrkit/paddleocr";
import { installBrowserOmr } from "../omrkit/browser";
import { RasterGlyphLookup, outlineTemplates, type RasterGlyphDict } from "./rasterglyphs";
import { rasterizePage, type RasterPage } from "./rasterpage";
import { staffGroupCount } from "./detect";
import { recognizeRasterSong, type RasterSongResult } from "./song";
import { ocrHarmonyStrips, ocrJianpuStrips, ocrLabelStrips, ocrLyricStrips, ocrTimeStrips, ocrWordStrips, ocrHeaderStrips, detectPageTexts } from "./ocrlive";
import type { TimeStrip } from "./timesig";
import { isPdf, largestPageImageAt } from "../omrkit/pdf";
import { PagePool, type FromWorker, type PagePort } from "./pagepool";

// 在线 OCR 要推理运行时：自己装上，不靠编辑器先 import 了 `omr/index`
installBrowserOmr();

/**
 * 位图路打开 PDF：**关掉浏览器版 pdf.js 的图像解码优化**。缺省它把内嵌位图交成 `ImageBitmap`（离屏画布 / ImageDecoder），
 * `rasterpage.ts` 要的是原始像素（`obj.data`），取不到就当这页没有整页位图——Node 版（回归脚本）本来就给原始像素。
 */
function openRasterPdf(bytes: Uint8Array) {
  return openPdf(bytes, { disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
}

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

/** 判路的结果，外加判的时候栅格化过的页（页号 → 结果）：交给 `recognizeRasterPdfs` 的 `firstPages`，那几页不再栅格化一遍。 */
export interface RasterProbe {
  isStaff: boolean;
  pages: Map<number, RasterPage | null>;
}

export async function probeRasterStaff(pdfBytes: Uint8Array): Promise<RasterProbe> {
  const pages = new Map<number, RasterPage | null>();
  const { pdf, OPS } = await openRasterPdf(pdfBytes);
  try {
    for (let pn = 1; pn <= Math.min(3, pdf.numPages as number); pn++) {
      const page = await pdf.getPage(pn);
      try {
        const r = await rasterizePage(page, OPS);
        pages.set(pn, r);
        // 判路只读不改：`staffGroupCount` 不动位图
        if (r && staffGroupCount(r.bin) > 0) return { isStaff: true, pages };
      } finally {
        page.cleanup?.();
      }
    }
    return { isStaff: false, pages };
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
  opts: {
    title?: string;
    onPage?: (done: number, total: number) => void;
    cancelled?: () => boolean;
    /** 第一份底本判路时栅格化过的页（`probeRasterStaff`）：用一次就丢 */
    firstPages?: Map<number, RasterPage | null>;
    /** 并行路数（缺省按核数，见 `pagePoolSize`；1 = 逐页串行） */
    workers?: number;
  } = {},
): Promise<RasterSongResult> {
  const look = await glyphLookup();
  const ocr = paddleOcrBackend();
  const sources = [];
  for (const b of pdfs) sources.push(await openRasterPdf(b));
  // 多页并行（`pagepool.ts`）：一页的不开；起不来 Worker 就串行
  const pageCount = sources.reduce((n, s) => n + (s.pdf.numPages as number), 0);
  const pool = pageCount > 1 ? browserPagePool(Math.min(pageCount, opts.workers ?? pagePoolSize())) : null;
  try {
    return await recognizeRasterSong(sources.map((s) => ({ pdf: s.pdf, OPS: s.OPS })), look, {
      pool: pool ?? undefined,
      title: opts.title,
      onPage: opts.onPage,
      cancelled: opts.cancelled,
      noteIds: true,
      rastered: (si, pn) => {
        if (si !== 0 || !opts.firstPages?.has(pn)) return undefined;
        const r = opts.firstPages.get(pn)!;
        opts.firstPages.delete(pn);
        return r;
      },
      live: {
        harmony: (s) => ocrHarmonyStrips(ocr, s),
        lyric: (s) => ocrLyricStrips(ocr, s),
        label: (s) => ocrLabelStrips(ocr, s),
        time: (s) => ocrTimeStrips(ocr, s),
        jianpu: (s) => ocrJianpuStrips(ocr, s),
        word: (s) => ocrWordStrips(ocr, s),
        header: (s) => ocrHeaderStrips(ocr, s),
        textDet: (bin, scale) => detectPageTexts(ocr, bin, scale),
      },
    });
  } finally {
    pool?.terminate();
    for (const s of sources) s.pdf.destroy?.();
  }
}

/** 并排原图整页画布的像素上限（WebKit 单张画布约 16.7M 像素封顶，留余量）。 */
const PAGE_VIEW_MAX_PX = 12e6;

/** 原样画好的一页 PDF（`renderPdfPages`）：整页 PNG，连同谱图（页上最大那张图）在页面上的变换与页面范围，摆放时用（`placePageView`）。
 *  页上没有图（矢量谱、文字页）或谱图带旋转/错切的，`ctm` 为 null：整页照画，只是不能按位图路的框摆。 */
export interface RenderedPage {
  url: string;
  ctm: number[] | null;
  view: number[];
}

/** 页上没有谱图时画整页的倍数（同矢量路渲对照底图）。 */
const PAGE_VIEW_PLAIN_SCALE = 2;

/** `renderPdfPages` 的一页：页面大小（PDF 点，先给，好铺白纸占位）与画好的整页（画好前是挂着的 promise）。 */
export interface PendingPage {
  w: number;
  h: number;
  rendered: Promise<RenderedPage | null>;
}

/**
 * 并排原图的底图：原样画出 PDF 各页（页眉的小图块、文字层、页边都在）。**不等识别**：开始识别、打开项目时就画，
 * 文档只开一次；外层 promise 在量完各页大小时给出，各页按页序一页页画，画好一页先给一页。
 * 画不出来的页给 null。图片输入不走这里，调用方直接画原图。
 * `opts.dpi`：按这个分辨率画（每英寸 72 点）；缺省按谱图原分辨率、没有谱图的页按 `PAGE_VIEW_PLAIN_SCALE`。
 * 两种都受 `PAGE_VIEW_MAX_PX` 封顶（WebKit 单张画布的上限），给太高的 dpi 会降下来。
 */
export async function renderPdfPages(pdfBytes: Uint8Array, opts: { dpi?: number } = {}): Promise<PendingPage[]> {
  const { pdf, OPS } = await openRasterPdf(pdfBytes); // 图对象要带 `data`（同取图），不然认不出谱图
  const n = pdf.numPages as number;
  const sizes: { w: number; h: number }[] = [];
  for (let pn = 1; pn <= n; pn++) {
    const [x0, y0, x1, y1] = (await pdf.getPage(pn)).view as number[];
    sizes.push({ w: x1 - x0, h: y1 - y0 });
  }
  let prev: Promise<unknown> = Promise.resolve();
  const pages = sizes.map((sz, k) => {
    const rendered = prev.then(() => renderOne(pdf, OPS, k + 1, opts.dpi)).catch(() => null);
    prev = rendered;
    return { ...sz, rendered };
  });
  void prev.finally(() => pdf.destroy?.());
  return pages;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderOne(pdf: any, OPS: any, pn: number, dpi?: number): Promise<RenderedPage | null> {
  const page = await pdf.getPage(pn);
  try {
    const found = await largestPageImageAt(page, OPS, (o) => (o.data && o.width && o.height ? o.width * o.height : null));
    const [a, b, c, d] = found?.ctm ?? [0, 0, 0, 0];
    const ctm = found && !b && !c && a > 0 && d > 0 ? [...found.ctm] : null;
    const [x0, y0, x1, y1] = page.view as number[];
    // 给了 dpi 按它画；否则按谱图的原分辨率（像素/点 = 图宽 / 图在页面上的宽）。太大的降下来
    const want = dpi && dpi > 0 ? dpi / 72 : ctm && found ? found.obj.width / a : PAGE_VIEW_PLAIN_SCALE;
    const r = Math.min(want, Math.sqrt(PAGE_VIEW_MAX_PX / ((x1 - x0) * (y1 - y0))));
    const vp = page.getViewport({ scale: r });
    const cv = document.createElement("canvas");
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    // toBlob 异步编码、不堵主线程（整页几百万像素，toDataURL 要卡一两百毫秒）
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
    return blob ? { url: URL.createObjectURL(blob), ctm, view: [x0, y0, x1, y1] } : null;
  } finally {
    page.cleanup?.();
  }
}

/**
 * 画好的页摆到识别位图的坐标里：识别框在位图像素里，这里只按谱图在页面上的位置做缩放 + 平移
 *（横竖各按位图宽高 / 谱图宽高），返回整页图在**位图坐标**里的位置（`x`、`y` 为负 = 页面在位图左上方伸出去的那一截）。
 * 不跟取图的纠斜、推平：干净版与照片没动过图，框是准的；纠过斜、推平过的扫描件框与原图差几个像素（斜率上限 0.015）。
 */
export function placePageView(r: RenderedPage, bin: { w: number; h: number }): { url: string; x: number; y: number; w: number; h: number } | null {
  if (!r.ctm) return null;
  const [a, , , d, e, f] = r.ctm;
  const [x0, y0, x1, y1] = r.view;
  const sx = bin.w / a;
  const sy = bin.h / d;
  return { url: r.url, x: -(e - x0) * sx, y: -(y1 - (f + d)) * sy, w: (x1 - x0) * sx, h: (y1 - y0) * sy };
}

/** 并行路数：留一个核给主线程（OCR、pdf.js 取图在主线程），最多 4 路（每页在途要几百 MB 的整页数组）。 */
function pagePoolSize(): number {
  const hw = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, hw - 1));
}

/** 起 `n` 个页 Worker；起不来（不支持 module Worker 等）回 null，调用方串行。 */
function browserPagePool(n: number): PagePool | null {
  if (n < 2 || typeof Worker === "undefined") return null;
  try {
    const ports: PagePort[] = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./pageworker.ts", import.meta.url), { type: "module" });
      let handler: ((m: FromWorker) => void) | null = null;
      w.onmessage = (e: MessageEvent<FromWorker>) => handler?.(e.data);
      w.onerror = (e) => handler?.({ t: "crash", error: e.message || "Worker 出错" });
      return { post: (m) => w.postMessage(m), onMessage: (h) => (handler = h), terminate: () => w.terminate() };
    });
    return new PagePool(ports);
  } catch (e) {
    console.warn("[OMR] 页 Worker 起不来，改逐页识别：", e);
    return null;
  }
}

/** 拍号数字条送 OCR（生成离线缓存的脚本用：与在线识别同一个实现）。回 `[指纹, 读数]` 对。 */
export async function ocrTimeStripsRaw(strips: { w: number; h: number; data: number[] }[]): Promise<[string, string][]> {
  const list = strips.map((s) => ({ ...s, data: Uint8Array.from(s.data), box: { x: 0, y: 0, w: s.w, h: s.h }, staff: 0, role: "num" as const })) satisfies TimeStrip[];
  return [...(await ocrTimeStrips(paddleOcrBackend(), list))];
}
