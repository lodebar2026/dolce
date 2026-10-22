// 拖进来的图片 / 扫描 PDF 该走哪条识别路：**有五线谱表就走位图五线谱**（简线混排谱也走这条，它自带简谱互证），
// 一组都没有就是简谱。判据就用位图路自己的谱线检测（`stafffind.ts::findRasterStaves`：逐列五段黑夹四段白等距、串成长轨迹），
// 简谱页上没有这种东西——减时线、下划线都短，表格线不成五条等距。
// 调用方看前几页（封面、目录页没有谱表），有一页有就算。

import type { Binary } from "../omrkit/types";
import { findRasterStaves } from "./stafffind";

/** 这一页（二值图）上有几组五线谱表。0 = 当简谱。与识别同一道找线。 */
export function staffGroupCount(bin: Binary): number {
  const groups = findRasterStaves(bin)?.groups ?? [];
  // 谱表要够长：五条线的平均长度过页宽四成（一组孤立的等距横线、页眉装饰线不算）
  return groups.filter((g) => g.lines.reduce((n, l) => n + (l.right - l.left), 0) / g.lines.length > bin.w * 0.4).length;
}

export function looksLikeStaff(bin: Binary): boolean {
  return staffGroupCount(bin) > 0;
}
