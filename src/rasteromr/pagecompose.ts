// **拼页面**（只给页眉用）：贴进 PDF 的谱图没顶到页顶时，把谱图上方那一段按谱图的分辨率拼出来。
//
// 宁静、破碎电子版（排版软件出的 PDF）整页谱是一张 1-bit ImageMask，从速度字那一行起；页眉不在这张图里——
// 中文标题、署名是**逐字贴的小图块**（宁静「寧靜的伯利恆」六个 101×101、「詞/曲/編：余遠淳」一串 34×34），
// 英文标题与英文署名在**文字层**（「Song of Bethlehem」「Ye n n C h w e n E r」）。
// 取图层（`rasterpage.ts`）只取最大的那张，这些都不在识别用的位图里，页眉带切不出来。
//
// 这里只拼页眉：别的 ImageMask 按各自的变换矩阵画到「页顶 → 谱图上沿」那一段（送 OCR，缓存照旧按条指纹），
// 文字层落在这一段里的字直接当页眉行（不用认）。识别用的位图一点不动，其余各路条子的指纹都不变。
import type { WordLine, WordStrip } from "./words";
import { decodeImage } from "./rasterpage";

/** 谱图上沿离页顶不到这么多（PDF 点）就不拼：整页扫描件、或页眉本就在谱图里。 */
const MIN_GAP_PT = 20;
/** 一个小图块墨过这么多就当极性反了（字的笔画到不了六成）。 */
const MASK_FLIP = 0.6;

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * 谱图上方那一段的页眉条与文字层行。
 *
 * @param binW 识别用位图的宽（像素）：拼出来的条与它同一分辨率（像素/点 = binW / 谱图在页面上的宽）。
 * @returns `strip.box` 在识别位图的坐标里（`y` 为负：在图的上方）；`texts` 在条内坐标。拼不了返回 null。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function composeHeaderStrip(page: any, OPS: any, binW: number): Promise<{ strip: WordStrip; texts: WordLine[] } | null> {
  const list = await page.getOperatorList();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const images: { arg: any; ctm: Mat }[] = [];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as Mat);
    else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObject) images.push({ arg: args[0], ctm });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objOf = async (arg: any) => {
    const id = arg && typeof arg === "object" ? arg.data : arg;
    if (typeof id !== "string") return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = await new Promise((r) => page.objs.get(id, r)).catch(() => null);
    return obj?.data && obj.width && obj.height ? obj : null;
  };
  // 谱图：最大的那张（与 `rasterizePage` 同一口径）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objs: { obj: any; ctm: Mat }[] = [];
  for (const im of images) {
    const obj = await objOf(im.arg);
    if (obj) objs.push({ obj, ctm: im.ctm });
  }
  if (!objs.length) return null;
  const main = objs.reduce((a, b) => (b.obj.width * b.obj.height > a.obj.width * a.obj.height ? b : a));
  const [a0, b0, c0, d0, e0, f0] = main.ctm;
  if (b0 || c0 || a0 <= 0 || d0 <= 0) return null;
  const [, , pageW, pageTop] = page.view as number[];
  const mainTop = f0 + d0;
  if (pageTop - mainTop < MIN_GAP_PT) return null;
  const s = binW / a0;
  const W = Math.round(pageW * s);
  const H = Math.round((pageTop - mainTop) * s);
  const data = new Uint8Array(W * H);
  for (const { obj, ctm: m } of objs) {
    if (obj === main.obj || m[1] || m[2] || m[0] <= 0 || m[3] <= 0) continue;
    if (m[5] + m[3] <= mainTop) continue; // 整个在谱图上沿之下
    const mask = decodeImage(obj, obj.width, obj.height);
    if (!mask) continue;
    let ink = 0;
    for (let i = 0; i < mask.data.length; i++) ink += mask.data[i];
    const flip = ink > mask.data.length * MASK_FLIP ? 1 : 0;
    const x0 = m[4] * s;
    const x1 = (m[4] + m[0]) * s;
    const y0 = (pageTop - (m[5] + m[3])) * s;
    const y1 = (pageTop - m[5]) * s;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
      const v = Math.min(mask.h - 1, Math.floor(((y + 0.5 - y0) / (y1 - y0)) * mask.h));
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
        const u = Math.min(mask.w - 1, Math.floor(((x + 0.5 - x0) / (x1 - x0)) * mask.w));
        if (mask.data[v * mask.w + u] ^ flip) data[y * W + x] = 1;
      }
    }
  }
  // 文字层：基线落在这一段里的字，同一基线、挨着的并成一行
  const items = ((await page.getTextContent()).items as { str: string; transform: number[]; width: number }[])
    .map((it) => ({ str: it.str, x: it.transform[4], base: it.transform[5], size: Math.hypot(it.transform[2], it.transform[3]), w: it.width }))
    .filter((it) => it.base > mainTop && it.base < pageTop)
    .sort((p, q) => q.base - p.base || p.x - q.x);
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const r = rows.find((g) => Math.abs(g[0].base - it.base) < g[0].size * 0.3);
    if (r) r.push(it);
    else rows.push([it]);
  }
  const texts: WordLine[] = [];
  for (const r of rows) {
    r.sort((p, q) => p.x - q.x);
    // 字距拉开的字（「Ye n n」「C h w e n」）：一个文字项里全是一两个字的碎块，空格是字距不是词界
    const t = r
      .map((it) => (/^(\S{1,2} )+\S{1,2}$/.test(it.str) ? it.str.replace(/ /g, "") : it.str))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) continue;
    const size = Math.max(...r.map((it) => it.size));
    const x = Math.min(...r.map((it) => it.x));
    const right = Math.max(...r.map((it) => it.x + it.w));
    texts.push({ t, x: Math.round(x * s), y: Math.round((pageTop - r[0].base - size * 0.8) * s), w: Math.round((right - x) * s), h: Math.round(size * s) });
  }
  let any = 0;
  for (let i = 0; i < data.length && !any; i++) any = data[i];
  if (!any && !texts.length) return null;
  return { strip: { w: W, h: H, data, box: { x: -Math.round(e0 * s), y: -H, w: W, h: H } }, texts };
}
