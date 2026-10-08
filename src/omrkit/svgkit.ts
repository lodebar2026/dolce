// 识别核对视图的 SVG 小件：二值图底图、整页 svg 根、矩形。简谱（`omr/overlay.ts`）与五线谱（`rasteromr/overlay.ts`）共用。
// 碰 DOM（document / canvas），不进 Node 链。
import type { Binary } from "./types";
import { surfaceFromBinary } from "./surface";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** 二值图 → PNG dataURL 的缓存：核对视图里改一个音就重画整张叠加层，底图不变，别每次重编码 PNG。 */
const binUrlCache = new WeakMap<Binary, string>();

/** 二值图 → PNG dataURL（黑字白底，作叠加背景）。 */
function binDataUrl(bin: Binary): string {
  const hit = binUrlCache.get(bin);
  if (hit) return hit;
  const url = binDataUrlRaw(bin);
  binUrlCache.set(bin, url);
  return url;
}

function binDataUrlRaw(bin: Binary): string {
  const surf = surfaceFromBinary(bin); // 黑字白底（底图 data URL 本身按图缓存在上面）
  const cv = document.createElement("canvas");
  cv.width = bin.w;
  cv.height = bin.h;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.putImageData(new ImageData(surf.data, bin.w, bin.h), 0, 0);
  return cv.toDataURL("image/png");
}

/** 二值图作底图（`<image>`，data URL 按二值图缓存）。 */
export function baseImage(bin: Binary): SVGImageElement {
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("x", "0");
  img.setAttribute("y", "0");
  img.setAttribute("width", String(bin.w));
  img.setAttribute("height", String(bin.h));
  const url = binDataUrl(bin);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
  img.setAttribute("href", url);
  return img;
}

/** 整页核对 svg：viewBox 即位图像素、撑满宽度，底下铺二值图。 */
export function pageSvg(bin: Binary, cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", `0 0 ${bin.w} ${bin.h}`);
  svg.style.width = "100%";
  svg.style.display = "block";
  svg.appendChild(baseImage(bin));
  return svg;
}

/** 一个矩形（命中框、圈框）：`attrs` 原样写上（`class`、`data-*`、`rx`…）。 */
export function svgRect(x: number, y: number, w: number, h: number, attrs: Record<string, string> = {}): SVGRectElement {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", String(x));
  r.setAttribute("y", String(y));
  r.setAttribute("width", String(w));
  r.setAttribute("height", String(h));
  for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v);
  return r;
}
