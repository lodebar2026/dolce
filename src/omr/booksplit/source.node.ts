// 歌本切分 · Node 侧页面来源：PDF（取每页内嵌源图；转曲矢量 PDF 见 vector.node.ts）或页图文件夹（按文件名自然序），都给原分辨率 RGBA。
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp, { type Sharp } from "sharp";
import { isPdf } from "../../omrkit/pdf";
import { openPdfPages } from "../../omrkit/pdf.node";
import type { RgbaImage } from "../../omrkit/decode";
import type { PageSource } from "./types";
import { openVectorBook } from "./vector.node";

const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);

export async function openBookSource(path: string): Promise<PageSource> {
  if ((await stat(path)).isDirectory()) return folderSource(path);
  const bytes = new Uint8Array(await readFile(path));
  if (!isPdf(bytes)) throw new Error(`${path} 既不是 PDF 也不是文件夹`);
  const stem = basename(path, extname(path));
  // 转曲矢量 PDF（页上没有内嵌位图）：整页对象渲成图来扫描、出图
  const vec = await openVectorBook(bytes, stem);
  if (vec) return vec;
  // 内嵌 JPEG 原样交给 sharp 解，与页图同一套解码（见 omrkit/pdf.node.ts）
  const pdf = await openPdfPages(bytes, (jpeg) => decodeImage(sharp(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength))));
  return {
    count: pdf.count,
    name: (i) => `${stem} 第${i + 1}页`,
    page: (i) => pdf.page(i),
    close: () => pdf.close(),
  };
}

async function folderSource(dir: string): Promise<PageSource> {
  const files = (await readdir(dir))
    .filter((f) => IMG_EXT.has(extname(f).toLowerCase()) && !f.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "zh", { numeric: true }));
  if (!files.length) throw new Error(`${dir} 里没有图片`);
  return {
    count: files.length,
    name: (i) => files[i],
    page: (i) => decodeFile(join(dir, files[i])),
    close: async () => {},
  };
}

async function decodeFile(path: string): Promise<RgbaImage> {
  // rotate()：按 EXIF 方向摆正（手机拍的页图常带方向标记）
  return decodeImage(sharp(path).rotate());
}

async function decodeImage(img: Sharp): Promise<RgbaImage> {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}
