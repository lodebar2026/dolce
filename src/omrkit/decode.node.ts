// Node 侧图片解码：sharp（libvips）。
//
// **解码器选谁直接影响识别精度**，不是无关紧要的实现细节：判据里那些尺寸阈值（如 jianpu.ts 的
// `w,h <= numH*0.45` 判小点）都是在**浏览器解码出的像素**上标定的，换一套 IDCT/色度上采样等于
// 把所有边界样本重掷一次。实测「我今来就你」第 4 谱行首个音符的附点块：浏览器与 sharp 都出
// 9×13（≤ numH*0.45=13.95 → 判附点），纯 JS 的 jpeg-js 出 9×14（落选，且既不够高进数字块、
// 又不够宽进窄块分支，整块被丢弃 → 附点消失）。sharp 走 libjpeg-turbo，与浏览器同一套解码，
// 实测 18 首**逐像素、逐字符**一致，故不留纯 JS 回退——两套解码器就是两套精度基线。
//
// 两种装法都逐像素一致，按分发形态选：
//   npm i sharp                 原生，按平台拉预编译二进制（~28MB，含 libvips）
//   npm i --cpu=wasm32 sharp    纯 wasm（~11MB），跨平台一份，可打进单文件分发
import sharp from "sharp";
import { setImageDecoder, type RgbaImage } from "./decode";
import { openPdfPages } from "./pdf.node";

async function decodeImage(bytes: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

/** PDF → 逐页**源图**（页里最大的内嵌位图，原生像素、不渲染不重采样，见 `pdf.node.ts`）竖向拼成一张白底长图，靠左摆（同浏览器那份）。
 *  纯矢量页（没有内嵌位图）报错：Node 里没有渲染器，矢量谱走矢量那条路。 */
async function rasterizePdf(bytes: Uint8Array): Promise<RgbaImage> {
  const doc = await openPdfPages(bytes, decodeImage);
  try {
    const pages: RgbaImage[] = [];
    for (let i = 0; i < doc.count; i++) pages.push(await doc.page(i));
    const W = Math.max(1, ...pages.map((p) => p.width));
    const H = Math.max(1, pages.reduce((n, p) => n + p.height, 0));
    const out = new Uint8ClampedArray(W * H * 4).fill(255);
    let y0 = 0;
    for (const p of pages) {
      for (let y = 0; y < p.height; y++) out.set(p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4), ((y0 + y) * W) * 4);
      y0 += p.height;
    }
    return { data: out, width: W, height: H };
  } finally {
    await doc.close();
  }
}

/** 装配 Node 解码器：图片走 sharp，PDF 取每页的内嵌源图（`rasterizePdf`）。 */
export function installNodeDecoder(): void {
  setImageDecoder(decodeImage, rasterizePdf);
}
