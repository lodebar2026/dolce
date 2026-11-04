// 歌本切分 · Node 侧写出：按摆放从源图原分辨率裁片、贴到纸色画布上，写 JPEG；转曲矢量歌本按 `dpi` 重渲整页再裁，写 PNG。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { RgbaImage } from "../../omrkit/decode";
import type { Rect } from "../../omrkit/types";
import type { Layout, PageSource } from "./types";

/** 只留最近用到的几页源图（一首最多跨几页，顺序写出时命中率很高）。 */
class PageCache {
  private m = new Map<number, Promise<RgbaImage>>();
  /** `scale`：矢量歌本出图的每 PDF 点像素数；不给按扫描图取 */
  constructor(private src: PageSource, private keep = 4, private scale?: number) {}
  get(i: number): Promise<RgbaImage> {
    let p = this.m.get(i);
    if (p) { this.m.delete(i); this.m.set(i, p); return p; }
    p = this.scale !== undefined && this.src.vector ? this.src.vector.render(i, this.scale) : this.src.page(i);
    this.m.set(i, p);
    while (this.m.size > this.keep) this.m.delete(this.m.keys().next().value!);
    return p;
  }
}

/** 摆放整体缩放 k 倍（扫描分辨率 → 出图分辨率）。 */
function scaleLayout(l: Layout, k: number): Layout {
  if (k === 1) return l;
  const r = (v: number) => Math.round(v * k);
  const rect = (q: Rect): Rect => ({ x: r(q.x), y: r(q.y), w: r(q.x + q.w) - r(q.x), h: r(q.y + q.h) - r(q.y) });
  return {
    width: r(l.width), height: r(l.height), paper: l.paper,
    parts: l.parts.map((p) => ({ page: p.page, src: rect(p.src), dx: r(p.dx), dy: r(p.dy) })),
    erase: l.erase.map(rect),
  };
}

async function renderLayout(cache: PageCache, l: Layout, opts: { format: "jpg" | "png"; quality: number }): Promise<Buffer> {
  const inputs: OverlayOptions[] = [];
  for (const part of l.parts) {
    const img = await cache.get(part.page);
    // 裁到画布与源图内
    const x0 = Math.max(part.src.x, part.src.x - part.dx, 0), y0 = Math.max(part.src.y, part.src.y - part.dy, 0);
    const x1 = Math.min(part.src.x + part.src.w, img.width, l.width - part.dx + part.src.x);
    const y1 = Math.min(part.src.y + part.src.h, img.height, l.height - part.dy + part.src.y);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) continue;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      const s = ((y0 + y) * img.width + x0) * 4;
      buf.set(img.data.subarray(s, s + w * 4), y * w * 4);
    }
    inputs.push({ input: buf, raw: { width: w, height: h, channels: 4 }, left: part.dx + (x0 - part.src.x), top: part.dy + (y0 - part.src.y) });
  }
  const [r, g, b] = l.paper;
  for (const e of l.erase) {
    const x = Math.max(0, Math.round(e.x)), y = Math.max(0, Math.round(e.y));
    const w = Math.min(l.width, Math.round(e.x + e.w)) - x, h = Math.min(l.height, Math.round(e.y + e.h)) - y;
    if (w <= 0 || h <= 0) continue;
    inputs.push({ input: { create: { width: w, height: h, channels: 3, background: { r, g, b } } }, left: x, top: y });
  }
  const img = sharp({ create: { width: l.width, height: l.height, channels: 3, background: { r, g, b } } }).composite(inputs);
  if (opts.format === "jpg") return img.jpeg({ quality: opts.quality }).toBuffer();
  // 矢量渲的图只有黑白灰：先合成再转单通道，PNG 小得多
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .toColourspace("b-w").png({ compressionLevel: 9 }).toBuffer();
}

/** 本来源写出的图片扩展名：矢量歌本 png，位图歌本 jpg。 */
export function songImageExt(src: PageSource): ".png" | ".jpg" {
  return src.vector ? ".png" : ".jpg";
}

/**
 * 按 layouts 逐首写出 `<names[k]>.jpg`（位图歌本，原分辨率）或 `<names[k]>.png`（矢量歌本，按 `dpi` 重渲，缺省 300）。
 * `quality` 只管 jpg，`dpi` 只管矢量歌本。
 */
export async function writeSongs(
  src: PageSource, layouts: readonly Layout[], names: readonly string[], outDir: string,
  opts: { quality?: number; dpi?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const vec = src.vector;
  const outScale = vec ? (opts.dpi ?? 300) / 72 : undefined;
  const cache = new PageCache(src, 4, outScale);
  const k0 = vec && outScale ? outScale / vec.scale : 1;
  const format = vec ? "png" : "jpg";
  const out: string[] = [];
  for (let k = 0; k < layouts.length; k++) {
    const path = join(outDir, names[k] + songImageExt(src));
    await writeFile(path, await renderLayout(cache, scaleLayout(layouts[k], k0), { format, quality: opts.quality ?? 92 }));
    out.push(path);
    opts.onProgress?.(k + 1, layouts.length);
  }
  return out;
}
