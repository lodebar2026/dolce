// 变音记号（♯ / ♭ / ♮）的形状分类。谱面上有两处要认它：音符左上角的临时升降号（jianpu.ts），
// 与页眉调号里的那个（header.ts，`1=♭B` 的 ♭ 常被 OCR 读成 `″` 这类残字，只能回头看形状）。
// 两处共用同一套判据——同一个记号在同一张图上不该有两种结论。
import type { Binary, Rect } from "../omrkit/types";
import { rbottom, rright } from "../omrkit/types";

/** 判 ♯ / ♭ / ♮。四象限墨迹占比 + 左右两半的墨迹重心：
 *  - **♯**：两条竖笔上下贯通 → 四象限都有墨、且大致均匀（实测四格 0.38~0.55、rt/rb 0.93~1.18）。
 *  - **♭**：只有左边一条竖笔贯通全高，肚子鼓在右下 → **右上明显比右下空**（rt/rb 0.56）、
 *    而**左下与右下一般满**（lb/rb 0.93）。后一条不能省：♮ 同样右上空（rt/rb 0.52），
 *    分开二者的是左竖的下半截——♭ 的左竖到底（lb 0.63），♮ 的左竖只在上半（lb 0.29）。
 *    右上/右下的门放到 0.62 才收得住小号的 ♭：页眉调号的上标 ♭ 只有 11×16，紧包围盒里
 *    肚子占了大半、越过中线（227《施比受更为有福》实测 lt .81 rt .38 lb .63 rb .68）。
 *  - **♮**：两条竖笔**一高一低**——左竖在上半、右竖在下半，故**左半墨迹的重心明显高于右半**。
 *    早先写成「左上空 + 右下空」的四象限判据，方向正好反了（8《心持两意的人》第 1 行实测
 *    左上 0.43 / 右下 0.61 才是有墨的那两格）；且中间两条横笔一压，四格比例本就不干净，
 *    改用左右两半的重心差（那两条横笔左右各占一半，对差值影响相互抵消）。 */
export function accidentalOf(bin: Binary, b: Rect): "sharp" | "flat" | "natural" | null {
  const half = (x0: number, x1: number, y0: number, y1: number): number => {
    let ink = 0, tot = 0;
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) { tot++; if (bin.data[y * bin.w + x]) ink++; }
    return tot ? ink / tot : 0;
  };
  /** 半边墨迹的重心（0=顶、1=底）；没墨返回 null */
  const centerY = (x0: number, x1: number): number | null => {
    let sum = 0, ink = 0;
    for (let y = Math.round(b.y); y < Math.round(rbottom(b)); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++)
        if (bin.data[y * bin.w + x]) { ink++; sum += y - b.y; }
    return ink ? sum / ink / Math.max(1, b.h - 1) : null;
  };
  const mx = b.x + b.w / 2, my = b.y + b.h / 2;
  const lt = half(b.x, mx, b.y, my), rt = half(mx, rright(b), b.y, my);
  const lb = half(b.x, mx, my, rbottom(b)), rb = half(mx, rright(b), my, rbottom(b));
  if (lt + rt + lb + rb < 0.3) return null;                            // 墨太少 → 噪点，不认
  if (rt < rb * 0.62 && lt > rt && lb >= rb * 0.7) return "flat";      // 右上空、左竖到底 → ♭
  const lc = centerY(b.x, mx), rc = centerY(mx, rright(b));
  if (lc !== null && rc !== null && rc - lc > 0.18) return "natural";  // 左竖高、右竖低 → ♮
  // 小号粗印的 ♭（新编赞美诗·四声部《圣哉三一歌》`ᵇ7`，14×18）四格墨量几乎一样（.65/.56/.56/.54），
  // 上面几条分不开，看轮廓：♭ 顶上只有一根竖笔（每行一段窄墨）、底下是肚子（宽）；♯ 顶上两根竖笔（每行两段，
  // 同书的 ♯ 26×24 顶三行有两行是两段）；♮ 底下只剩右竖（窄）。顶带只看最上 12%：从弧下拆出来的记号
  // 顶上常残着一两点弧墨。
  const rowRuns = (y: number): { span: number; runs: number } => {
    let lo = -1, hi = -1, runs = 0, prev = false;
    for (let x = Math.round(b.x); x < Math.round(rright(b)); x++) {
      const on = !!bin.data[y * bin.w + x];
      if (on) { if (lo < 0) lo = x; hi = x; if (!prev) runs++; }
      prev = on;
    }
    return { span: lo < 0 ? 0 : (hi - lo + 1) / b.w, runs };
  };
  const band = (y0: number, y1: number) => {
    const rs: { span: number; runs: number }[] = [];
    for (let y = Math.round(y0); y < Math.max(Math.round(y0) + 1, Math.round(y1)); y++) rs.push(rowRuns(y));
    return rs;
  };
  const top = band(b.y, b.y + b.h * 0.12), bottom = band(rbottom(b) - b.h * 0.25, rbottom(b));
  const avg = (rs: { span: number }[]) => rs.reduce((a, r) => a + r.span, 0) / Math.max(1, rs.length);
  if (top.every((r) => r.runs === 1 && r.span < 0.4) && avg(bottom) >= 0.6) return "flat";
  if (Math.min(lt, rt, lb, rb) >= 0.12) return "sharp";                // 四格都有墨 → ♯
  return null;
}
