// Node 侧取 PDF 每页的**源图**：只认页面里内嵌的最大位图，按它的原生像素给出，不渲染、不重采样。
// 扫描本 PDF 每页就是一张 JPEG，这样取出来与原扫描图同尺寸；矢量 PDF（没有内嵌位图）直接报错。
// pdf.js 用 legacy 构建（Node 没有 DOM / OffscreenCanvas），图对象回来是 `{width, height, kind, data, ref}`。
//
// 图是 JPEG（DCTDecode）时，按 `ref` 的对象号到文件里取**原样的 JPEG 字节**交给注入的解码器（Node 侧是 sharp），
// 不用 pdf.js 自带的 JPEG 解码：两者 IDCT/上采样不同，解出的像素差一两个灰度，识别判据是按 libjpeg 的像素标定的
// （见 decode.node.ts），实测《哈利路亚》有曲名因此两路读得不同。取不到（对象流里、带别的滤镜、CMYK、带蒙版、
// 尺寸对不上）就退回 pdf.js 解出的像素。
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { largestPageImageAt } from "./pdf";
import type { RgbaImage } from "./decode";

/**
 * pdf.js 位图解码器（JBIG2 / CCITT、JPEG2000）的 wasm 目录。**不给就整张图被静默丢掉**：1-bit 扫描本多是 CCITT G4 的 ImageMask
 *（耶稣普治），没有它 pdf.js 连纯 JS 的退路（`jbig2_nowasm_fallback`）都不走，页上就「没有内嵌图片」。
 * 按 `pdfjs-dist` 的安装位置找；找不到（打包分发时）就不给。
 */
function pdfjsWasmUrl(): string | undefined {
  try {
    return pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "wasm/")).href;
  } catch {
    return undefined;
  }
}

// pdf.js 图对象的 kind（ImageKind）
const GRAYSCALE_1BPP = 1, RGB_24BPP = 2, RGBA_32BPP = 3;

export interface PdfPages {
  count: number;
  /** 第 i 页（0 起）的源图。 */
  page(i: number): Promise<RgbaImage>;
  close(): Promise<void>;
}

/** `decodeJpeg`：JPEG 字节 → RGBA（与页图同一个解码器）。不给则一律用 pdf.js 解出的像素。 */
export async function openPdfPages(bytes: Uint8Array, decodeJpeg?: (jpeg: Uint8Array) => Promise<RgbaImage>): Promise<PdfPages> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const raw = decodeJpeg ? rawJpegs(bytes) : null;
  const task = pdfjs.getDocument({
    data: decodeJpeg ? bytes.slice() : bytes, isEvalSupported: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    disableFontFace: true, verbosity: 0, wasmUrl: pdfjsWasmUrl(),
  });
  const doc = await task.promise;
  return {
    count: doc.numPages,
    async page(i) {
      const page = await doc.getPage(i + 1);
      try {
        const hit = await largestPageImageAt(page, pdfjs.OPS, (o) => (o?.data && o.width && o.height ? o.width * o.height : null));
        if (!hit) throw new Error(`PDF 第 ${i + 1} 页没有内嵌图片（矢量 PDF 请先导出为图片）`);
        const jpeg = raw?.(hit.obj.ref, hit.obj.width, hit.obj.height);
        if (jpeg && decodeJpeg) {
          const img = await decodeJpeg(jpeg).catch(() => null);
          if (img && img.width === hit.obj.width && img.height === hit.obj.height) return orient(img, hit.ctm);
        }
        return orient(toRgba(hit.obj), hit.ctm);
      } finally {
        page.cleanup();
      }
    },
    async close() { await task.destroy(); },
  };
}

/**
 * 按对象号取图像 XObject 的原样 JPEG 字节。先扫一遍全文件记下每个「N G obj」的位置（增量更新取最后一次），
 * 用时校验：字典是 `/Subtype /Image`、滤镜只有 `/DCTDecode`、宽高对得上、不是 CMYK、没有反相 Decode 与蒙版，
 * 流长取直接写的 /Length（间接引用就到该对象里读），流以 FFD8 开头。不合条件返回 null。
 */
function rawJpegs(bytes: Uint8Array): (ref: unknown, w: number, h: number) => Uint8Array | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const at = new Map<number, number>();
  const re = /(?:^|[\r\n\s])(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) at.set(Number(m[1]), m.index + m[0].length);
  const intObj = (n: number): number | null => {
    const o = at.get(n);
    const v = o === undefined ? null : /^\s*(\d+)\s/.exec(text.slice(o, o + 40));
    return v ? Number(v[1]) : null;
  };
  return (ref, w, h) => {
    const n = typeof ref === "string" ? /^(\d+)R/.exec(ref) : null;
    const o = n ? at.get(Number(n[1])) : undefined;
    if (o === undefined) return null;
    const s0 = text.indexOf("stream", o);
    if (s0 < 0 || s0 - o > 4096) return null;
    const dict = text.slice(o, s0);
    if (!/\/Subtype\s*\/Image/.test(dict) || /\/(?:SMask|Mask)\b/.test(dict) || /DeviceCMYK/.test(dict)) return null;
    const filt = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1].replace(/[[\]\s]/g, "");
    if (filt !== "/DCTDecode") return null;
    if (Number(/\/Width\s+(\d+)/.exec(dict)?.[1]) !== w || Number(/\/Height\s+(\d+)/.exec(dict)?.[1]) !== h) return null;
    const dec = /\/Decode\s*\[([^\]]*)\]/.exec(dict)?.[1].trim().split(/\s+/).map(Number);
    if (dec && dec.some((v, k) => v !== (k % 2 ? 1 : 0))) return null;
    const lm = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
    if (!lm) return null;
    const len = lm[2] ? intObj(Number(lm[1])) : Number(lm[1]);
    let start = s0 + 6;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    if (!len || start + len > bytes.length || bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return null;
    return bytes.subarray(start, start + len);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRgba(o: any): RgbaImage {
  const { width: w, height: h, kind, data } = o as { width: number; height: number; kind: number; data: Uint8Array };
  const out = new Uint8ClampedArray(w * h * 4);
  if (kind === RGBA_32BPP) out.set(data);
  else if (kind === RGB_24BPP) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
  } else if (data.length === ((w + 7) >> 3) * h) {
    // 1 位、每行按字节对齐：`kind: 1`（GRAYSCALE_1BPP）置位 = 白；ImageMask（没有 kind，按数据长度认）置位 = 盖住 = 墨。
    // `/Decode` 还能把两者都翻过来，翻没翻量了才知道：整页的墨不会过半，过半整幅取反（同 `rasteromr/rasterpage.ts` 的极性自检）
    const stride = (w + 7) >> 3;
    const setIsInk = kind !== GRAYSCALE_1BPP;
    let ink = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if ((((data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) === 1) === setIsInk) ink++;
    const flip = ink > (w * h) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isInk = ((((data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) === 1) === setIsInk) !== flip;
        const p = (y * w + x) * 4;
        out[p] = out[p + 1] = out[p + 2] = isInk ? 0 : 255; out[p + 3] = 255;
      }
    }
  } else throw new Error(`不认识的 PDF 图像格式 kind=${kind}`);
  return { data: out, width: w, height: h };
}

/** 按画图时的变换矩阵摆正：图的单位正方形（u 向右、v 向上；图像第 0 行在 v=1）→ 页面（y 向上）。
 *  只做翻转与 90° 倍数旋转，不缩放；正常摆放（a>0、d>0、b=c=0）原样返回。 */
function orient(img: RgbaImage, m: number[]): RgbaImage {
  const sgn = (v: number) => Math.sign(Math.round(v * 1000));
  const [sa, sb, sc, sd] = m.slice(0, 4).map(sgn);
  if (sa > 0 && sd > 0 && !sb && !sc) return img;
  const { width: w, height: h, data } = img;
  const xByU = sa !== 0; // 页面 x 随 u 变（否则随 v 变，即转了 90°）
  const W = xByU ? w : h, H = xByU ? h : w;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
      const fx = xByU ? (sa > 0 ? u : 1 - u) : (sc > 0 ? v : 1 - v);
      const fyUp = xByU ? (sd > 0 ? v : 1 - v) : (sb > 0 ? u : 1 - u);
      const X = Math.min(W - 1, Math.floor(fx * W)), Y = Math.min(H - 1, Math.floor((1 - fyUp) * H));
      const s = (y * w + x) * 4, t = (Y * W + X) * 4;
      out[t] = data[s]; out[t + 1] = data[s + 1]; out[t + 2] = data[s + 2]; out[t + 3] = data[s + 3];
    }
  }
  return { data: out, width: W, height: H };
}
