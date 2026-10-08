// 汉字字格：一行连通块按 x 邻近并成字（偏旁并回整字）。简谱歌词 / 页眉、位图五线谱的汉字歌词条共用。
import { rbottom, rright, type Component, type Rect } from "./types";

/** 把一行(同 y)的连通块按 x 邻近并成字格。返回每个字格的合并包围盒，按 x 排序。 */
export function mergeToChars(line: Component[], charH: number): Rect[] {
  const sorted = [...line].sort((a, b) => a.bbox.x - b.bbox.x);
  const cells: Rect[] = [];
  const gap = charH * 0.28;       // 偏旁间距 < 此值算同字
  const maxW = charH * 1.7;       // 单字最大宽度，避免把两字并一起
  for (const c of sorted) {
    const b = c.bbox;
    const last = cells[cells.length - 1];
    if (last && b.x <= rright(last) + gap && (rright(b) - last.x) <= maxW) {
      // 并入上一个字格
      const x = Math.min(last.x, b.x), y = Math.min(last.y, b.y);
      last.w = Math.max(rright(last), rright(b)) - x;
      last.h = Math.max(rbottom(last), rbottom(b)) - y;
      last.x = x; last.y = y;
    } else {
      cells.push({ ...b });
    }
  }
  return cells;
}
