// 灰度、Otsu、Sauvola 二值化（移植 preprocess.cpp 思路：自适应阈值得到墨迹前景）。简谱与位图五线谱共用。
import type { Binary } from "./types";

/** 彩色像素灰度化（Rec.601 luma，截断取整）。`step`：每像素几个字节——4 = RGBA（ImageData），3 = RGB，1 = 已是灰度（原样拷）。 */
export function toGray(px: ArrayLike<number>, w: number, h: number, step = 4): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += step) {
    g[i] = step === 1 ? px[p] : (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
  }
  return g;
}

/** Otsu：最佳全局阈值 `thr` 与此时的类间方差 `sep`（越大说明前景/背景分得越开，挑通道用）。 */
export function otsu(gray: Uint8Array): { thr: number; sep: number } {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, max = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  return { thr, sep: max };
}

/** 取某通道（0=R,1=G,2=B）为灰度。 */
function channel(rgba: Uint8ClampedArray, n: number, c: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, p = c; i < n; i++, p += 4) g[i] = rgba[p];
  return g;
}

/** Sauvola 的动态范围 R：8 位灰度的一半。 */
const SAUVOLA_R = 128;

/**
 * Sauvola 局部自适应二值化，写进 `out`（1 = 墨）：阈值随窗口内均值 m、标准差 sd 变化
 * `thr = m·(1 + k·(sd/R − 1))`。墨迹边缘 sd 大→阈值压低保细笔；
 * 平滑的水印/渐变底 sd 小→阈值贴近均值→被判背景。比全局 Otsu 抗低对比/底纹。
 * 窗口是以像素为心、半径 `r` 的方块（贴边处截断）。简谱（`rgbaToBinary`）与位图五线谱（`rasteromr/rasterpage.ts`）共用，
 * 两边各自定 `r`、`k`。
 */
export function sauvola(gray: Uint8Array, w: number, h: number, r: number, k: number, out: Uint8Array = new Uint8Array(w * h)): Uint8Array {
  // 积分图（多一行一列的零边，省去边界判断）
  const sw = w + 1;
  const S1 = new Float64Array(sw * (h + 1));
  const S2 = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      r1 += v;
      r2 += v * v;
      S1[(y + 1) * sw + x + 1] = S1[y * sw + x + 1] + r1;
      S2[(y + 1) * sw + x + 1] = S2[y * sw + x + 1] + r2;
    }
  }
  const box = (S: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    S[y1 * sw + x1] - S[y0 * sw + x1] - S[y1 * sw + x0] + S[y0 * sw + x0];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = box(S1, x0, y0, x1, y1) / n;
      const v = Math.max(0, box(S2, x0, y0, x1, y1) / n - m * m);
      const t = m * (1 + k * (Math.sqrt(v) / SAUVOLA_R - 1));
      out[y * w + x] = gray[y * w + x] <= t ? 1 : 0; // 暗 = 墨
    }
  }
  return out;
}

/**
 * 便捷：RGBA → Binary。
 * 先按「类间方差」从 R/G/B/luma 中挑分得最开的通道（暖色/泛黄扫描里墨迹吸蓝，
 * 蓝通道对比最高；纯黑白稿四通道一致退化为 luma），再走 Sauvola 局部阈值。
 */
export function rgbaToBinary(rgba: Uint8ClampedArray, w: number, h: number): Binary {
  const n = w * h;
  const cands: Uint8Array[] = [
    toGray(rgba, w, h),
    channel(rgba, n, 0),
    channel(rgba, n, 1),
    channel(rgba, n, 2),
  ];
  let best = cands[0], bestSep = -1;
  for (const g of cands) {
    const { sep } = otsu(g);
    if (sep > bestSep) { bestSep = sep; best = g; }
  }
  // 窗口约取图像短边的 1/30（取奇数），覆盖一个字号又不至于退化成全局阈值。
  const win = Math.max(15, (Math.round(Math.min(w, h) / 30) | 1));
  return { w, h, data: sauvola(best, w, h, win >> 1, 0.2) };
}
