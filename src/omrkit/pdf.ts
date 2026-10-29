// PDF 的小工具（不碰 DOM，Node 链可用）：魔数判定、页面上的图指令与图对象（仿射矩阵在 `vector.ts`）。
// 打开文档（pdf.js 浏览器构建、worker、wasm 目录）在 `pdf.browser.ts`。
import { matMul, type Mat } from "./vector";

/** 是否 PDF 字节（mime 或 `%PDF-` 魔数）。 */
export function isPdf(bytes: Uint8Array, mime?: string): boolean {
  if (mime === "application/pdf") return true;
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"
}

/** 页面上每条画图指令（`paintImageXObject` / `paintImageMaskXObject`）的参数与当时的变换矩阵，按指令顺序。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pageImageOps(page: any, OPS: any): Promise<{ arg: unknown; ctm: Mat }[]> {
  const list = await page.getOperatorList();
  const out: { arg: unknown; ctm: Mat }[] = [];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = matMul(ctm, args as Mat);
    else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObject) out.push({ arg: args[0], ctm });
  }
  return out;
}

/**
 * 画图矩阵只带翻转与 90° 倍数旋转时，图在页面上那一块的**轴对齐**矩阵（宽高为正、原点在左下，同正常摆放的写法）；
 * 带错切或退化的返回 null。手机竖拍的照片多是横着存、靠矩阵（或 EXIF 方向，见 `jpegToPdf`）转正的。
 */
export function uprightCtm(m: readonly number[]): Mat | null {
  const z = (v: number) => Math.round(v * 1000) === 0;
  const [a, b, c, d, e, f] = m as Mat;
  if (z(b) && z(c) && a > 0 && d > 0) return [a, 0, 0, d, e, f];
  if (!((z(b) && z(c) && !z(a) && !z(d)) || (z(a) && z(d) && !z(b) && !z(c)))) return null;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return [Math.max(...xs) - x0, 0, 0, Math.max(...ys) - y0, x0, y0];
}

/**
 * 图的像素按画图矩阵摆正：图的单位正方形（u 向右、v 向上；图像第 0 行在 v=1）→ 页面（y 向上）。
 * 只做翻转与 90° 倍数旋转，不缩放、不插值；正常摆放（a>0、d>0、b=c=0）与带错切的原样返回。
 * `data` 是逐像素定长字节（灰度 / RGB / RGBA），或 1-bit 逐行补齐到字节（长度 = ⌈w/8⌉·h，ImageMask 与 GRAYSCALE_1BPP）。
 */
export function orientPixels<T extends Uint8Array | Uint8ClampedArray>(data: T, w: number, h: number, m: readonly number[]): { data: T; width: number; height: number } {
  const sgn = (v: number) => Math.sign(Math.round(v * 1000));
  const [sa, sb, sc, sd] = m.slice(0, 4).map(sgn) as [number, number, number, number];
  if ((sa > 0 && sd > 0 && !sb && !sc) || !uprightCtm(m)) return { data, width: w, height: h };
  const xByU = sa !== 0; // 页面 x 随 u 变（否则随 v 变，即转了 90°）
  const W = xByU ? w : h, H = xByU ? h : w;
  /** 源像素 (x, y) → 摆正后的 (X, Y)（y 向下） */
  const at = (x: number, y: number): [number, number] => {
    const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
    const fx = xByU ? (sa > 0 ? u : 1 - u) : sc > 0 ? v : 1 - v;
    const fyUp = xByU ? (sd > 0 ? v : 1 - v) : sb > 0 ? u : 1 - u;
    return [Math.min(W - 1, Math.floor(fx * W)), Math.min(H - 1, Math.floor((1 - fyUp) * H))];
  };
  const make = (n: number) => new (data.constructor as new (n: number) => T)(n);
  const stride = (w + 7) >> 3;
  if (data.length === stride * h && data.length !== w * h) {
    const S = (W + 7) >> 3;
    const bits = make(S * H);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!((data[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1)) continue;
        const [X, Y] = at(x, y);
        bits[Y * S + (X >> 3)] |= 0x80 >> (X & 7);
      }
    return { data: bits, width: W, height: H };
  }
  const bpp = data.length / (w * h);
  if (!Number.isInteger(bpp) || bpp < 1) return { data, width: w, height: h };
  const px = make(W * H * bpp);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [X, Y] = at(x, y);
      const s = (y * w + x) * bpp, t = (Y * W + X) * bpp;
      for (let k = 0; k < bpp; k++) px[t + k] = data[s + k]!;
    }
  return { data: px, width: W, height: H };
}

/** 画图指令的参数 → pdf.js 的图对象（取不到返回 null）。ImageMask 的参数是 `{ data: <objId>, … }`，普通图 XObject 是对象名字符串。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pageImageObj(page: any, arg: unknown): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = arg && typeof arg === "object" ? (arg as any).data : arg;
  if (typeof id !== "string") return null;
  return new Promise((r) => page.objs.get(id, r)).catch(() => null);
}

/** 本页面积最大的一张图：`area(obj)` 给出可用图对象的面积，不可用返回 null；面积相同取先画的。没有返回 null。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function largestPageImage(page: any, OPS: any, area: (obj: any) => number | null): Promise<any> {
  return (await largestPageImageAt(page, OPS, area))?.obj ?? null;
}

/** 同 `largestPageImage`，连同画它时的变换矩阵（图的单位正方形 → 页面用户空间，PDF 点、y 向上）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function largestPageImageAt(page: any, OPS: any, area: (obj: any) => number | null): Promise<{ obj: any; ctm: Mat } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let best: { obj: any; ctm: Mat; area: number } | null = null;
  for (const { arg, ctm } of await pageImageOps(page, OPS)) {
    const obj = await pageImageObj(page, arg);
    const a = obj ? area(obj) : null;
    if (a === null) continue;
    if (!best || a > best.area) best = { obj, ctm, area: a };
  }
  return best ? { obj: best.obj, ctm: best.ctm } : null;
}
