// 拍号数字条：行首拍号那一列按中线切成上下两半，各出一条送 OCR（PP-OCR 的单字数字接口）。
//
// 与歌词条、标签条同一套架构：识别这边只切条、按**内容指纹**查缓存，认字在离线脚本（`gen-rastertime.mjs`）
// 或在线识别（`ocrlive.ts::ocrTimeStrips`）里做。为什么不只靠模板：拍号数字的字形各书差得远（铅字本、粗体小号），
// 又被谱线横穿，模板签名在 8/4、6/4、3/4 之间分不开；文字识别模型见过的数字字形多得多。

import type { Binary, Rect } from "../omr/types";

export interface TimeStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  box: Rect;
  /** 这条属于第几行谱。 */
  staff: number;
  /** 上半（分子）还是下半（分母）。 */
  role: "num" | "den";
}

/** 条四周留的白边（像素）：数字贴边时 rec 容易读成半个字。 */
const PAD = 2;

/** 从二值图上按盒裁一条（四周各留 `PAD`，出界截断）。 */
export function timeStripOf(bin: Binary, box: Rect, staff: number, role: TimeStrip["role"]): TimeStrip {
  const x0 = Math.max(0, Math.round(box.x) - PAD);
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(bin.w, Math.round(box.x + box.w) + PAD);
  const y1 = Math.min(bin.h, Math.round(box.y + box.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = bin.data[(y0 + y) * bin.w + x0 + x] ? 1 : 0;
  return { w, h, data, box: { x: x0, y: y0, w, h }, staff, role };
}

/** 条的**内容指纹**（与 `stafflabel.ts::labelKey` 同一套：尺寸 + FNV-1a）。 */
export function timeKey(s: TimeStrip): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i]!;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `T${s.w}x${s.h}-${h1.toString(36)}`;
}

/** 分子的合法值：2~9，外加 12（12/8）。 */
export const TIME_NUMERATORS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 12];
/** 分母的合法值。 */
export const TIME_DENOMINATORS: readonly number[] = [2, 4, 8, 16];

/** OCR 读出的字串 → 合法的拍号数字；读不成（空、别的字、不在合法集合里）给 null。 */
export function timeDigit(text: string | undefined, role: TimeStrip["role"]): number | null {
  if (!text || !/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return (role === "num" ? TIME_NUMERATORS : TIME_DENOMINATORS).includes(n) ? n : null;
}
