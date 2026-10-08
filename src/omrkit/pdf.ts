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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let best: { obj: any; area: number } | null = null;
  for (const { arg } of await pageImageOps(page, OPS)) {
    const obj = await pageImageObj(page, arg);
    const a = obj ? area(obj) : null;
    if (a === null) continue;
    if (!best || a > best.area) best = { obj, area: a };
  }
  return best?.obj ?? null;
}
