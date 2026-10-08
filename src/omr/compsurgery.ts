// 简谱识别的**连通块预拆**（`recognizeJianpu` 开头那一串 `split*`，在归类之前）：贯穿全高的小节线擦掉重做连通域、
// 小节线粘短横 / 顶帽、弧尾、线压点、弧端切点、弧中溶着的点、波音点、数字粘短横，断开的横线并回。每条判据在各函数注释里。
import type { Binary, Component, Rect } from "../omrkit/types";
import { rright, rbottom, rcx, rcy, REJOINED_ARC_ID, isRejoinedArc } from "../omrkit/types";
import { connectedComponents } from "../omrkit/ccl";
import { median, overlapRatioY, unionRect } from "../omrkit/geom";
import { probe } from "./probe";
import { tightBox, columnInk, inkFill, inkCount } from "./inkprobe";

/** 在块内按列找"竖直连续墨迹 ≥0.8 块高"的窄列簇 = 贯穿全高的竖笔（小节线）。相邻达标列并成一根，
 *  返回其中心 x、竖笔 y 起点与高度。弧/横线各列只有很短竖直段，天然不达标。 */
function fullHeightBars(bin: Binary, b: Rect, numH: number): Array<{ cx: number; y: number; h: number; w: number }> {
  const minRun = Math.floor(b.h * 0.8);
  const runs: Array<{ run: number; y0: number } | null> = [];
  for (let xx = 0; xx < b.w; xx++) {
    let best = 0, bestY0 = 0, cur = 0, curY0 = 0;
    for (let yy = 0; yy < b.h; yy++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) { if (cur === 0) curY0 = yy; cur++; if (cur > best) { best = cur; bestY0 = curY0; } }
      else cur = 0;
    }
    runs.push(best >= minRun ? { run: best, y0: bestY0 } : null);
  }
  const out: Array<{ cx: number; y: number; h: number; w: number }> = [];
  let s = -1;
  for (let xx = 0; xx <= b.w; xx++) {
    if (xx < b.w && runs[xx]) { if (s < 0) s = xx; }
    else if (s >= 0) {
      if (xx - s <= numH * 0.5) {              // 过宽的不是小节线（可能是实心块），弃
        let ry0 = runs[s]!.y0, rrun = runs[s]!.run;
        for (let j = s; j < xx; j++) if (runs[j]!.run > rrun) { rrun = runs[j]!.run; ry0 = runs[j]!.y0; }
        out.push({ cx: b.x + (s + xx - 1) / 2, y: b.y + ry0, h: rrun, w: xx - s });
      }
      s = -1;
    }
  }
  return out;
}

/** 擦掉长线后，半截弧上还粘着线旁那个音（78《马槽歌》`5⌒|1` 的 5 连着左半截弧）：按列把数字剥下来——
 *  只有一段粗列（≥0.25 字号、宽 0.3~1.2 字号），其余列都是块上半的细墨（不到粗列门）且够 0.3 字号宽，
 *  就拆成「数字 + 细弧」两块，细弧再去和线另一侧的半截接。`p` 是子图里的连通块，`labels` 是子图的标号图。 */
function peelDigit(p: Component, labels: Int32Array, b: Rect, numH: number): Component[] {
  const pb = p.bbox;
  const mk = (x0: number, y0: number, x1: number, y1: number, area: number, id: number): Component => {
    const r = { x: b.x + x0, y: b.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return { id, area, bbox: r, cx: rcx(r), cy: rcy(r) };
  };
  const whole = mk(pb.x, pb.y, pb.x + pb.w - 1, pb.y + pb.h - 1, p.area, p.id);
  if (pb.w < numH * 0.6 || pb.h < numH * 0.5) return [whole];
  const own = (x: number, y: number) => labels[y * b.w + x] === p.id;
  const cols: number[] = [], lowest: number[] = [];
  for (let x = pb.x; x < pb.x + pb.w; x++) {
    let n = 0, lo = -1;
    for (let y = pb.y; y < pb.y + pb.h; y++) if (own(x, y)) { n++; lo = y - pb.y; }
    cols.push(n); lowest.push(lo);
  }
  const spans: Array<[number, number]> = [];
  cols.forEach((n, i) => {
    if (n < numH * 0.25) return;
    const last = spans[spans.length - 1];
    if (last && i - last[1] <= 2) last[1] = i + 1; else spans.push([i, i + 1]);
  });
  // 块边缘一两列宽的粗段是擦线剩下的线边，不算第二个数字（同首 Q3 `2`+半截弧 51×43，右缘贴着一列）
  const edge = spans.filter(([sa, se]) => spans.length > 1 && se - sa < numH * 0.15 && (sa === 0 || se === pb.w));
  const core = spans.filter((sp) => !edge.includes(sp));
  if (core.length !== 1) return [whole];
  const isEdge = (i: number) => edge.some(([sa, se]) => i >= sa && i < se);
  let [a, e] = core[0]!;
  while (a > 0 && lowest[a - 1]! > pb.h * 0.5) a--;
  while (e < pb.w && lowest[e]! > pb.h * 0.5) e++;
  if (e - a < numH * 0.3 || e - a > numH * 1.2) return [whole];
  let thinW = 0;
  for (let i = 0; i < pb.w; i++) {
    if (i >= a && i < e || !cols[i] || isEdge(i)) continue;
    if (cols[i]! >= numH * 0.25 || lowest[i]! > pb.h * 0.5) return [whole];     // 不到粗列门就是细墨（弧拱处单列 7px）
    thinW++;
  }
  if (thinW < numH * 0.3) return [whole];
  const box = (inside: boolean) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, area = 0;
    for (let y = pb.y; y < pb.y + pb.h; y++) for (let x = pb.x; x < pb.x + pb.w; x++) {
      if (!own(x, y) || ((x - pb.x >= a && x - pb.x < e) !== inside)) continue;
      area++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return area ? { x0, y0, x1, y1, area } : null;
  };
  const d = box(true), t = box(false);
  if (!d || !t) return [whole];
  probe("untangleBridged.peelDigit");
  return [mk(d.x0, d.y0, d.x1, d.y1, d.area, p.id), mk(t.x0, t.y0, t.x1, t.y1, t.area, p.id + 500_000)];
}

/** 去连通：一根贯穿全高的小节线常像"桥"，把上方的圆滑线弧、数字中线的增时线 '- -' 在交叉点 4-连通地
 *  串成一个宽而稀疏的大块 —— classify 各类都不匹配而整块被丢弃（末尾小节线、跨小节 slur 随之全失，
 *  实测「哦愿我有千万舌头」两行末尾 1--｜7,-）。**本质解法是把这根竖笔从像素上擦掉、重做连通域**，
 *  让弧/增时线/数字各自独立、走正常 classify + detectSlurs，而非在别处特判抽取。
 *
 *  唯一微妙处：弧横跨小节线，整列擦除会把弧拦腰切断。但弧永远在**最顶部连续墨带**、其下才是纯竖笔，
 *  故只擦"弧带以下"的竖笔 —— 弧整条保留，它与下方增时线之间那段纯竖笔被切断即达到解连通。擦出的
 *  竖笔按小节线补回。只作用于"够高(≳2字号)、够宽(≳1字号)、够稀疏(填充<25%)"的粘连块，普通数字块/
 *  连音块（无贯穿全高竖笔）原样返回。 */
export function untangleBridged(comps: Component[], bin: Binary, numH: number): Component[] {
  const out: Component[] = [];
  for (const k of comps) {
    const b = k.bbox;
    const sparse = b.w >= numH * 0.9 && k.area < b.w * b.h * 0.25;
    if (b.h < numH * 1.6 || (!sparse && (b.h < numH * 2.8 || b.w < numH * 0.45))) { out.push(k); continue; }
    const bars = fullHeightBars(bin, b, numH);
    if (!bars.length) { out.push(k); continue; }
    // 窄块、密块本不在此列，只收「跨两声部的细长线粘着一个音」：四声部排得密，线旁的数字横笔顶到线上
    //（新编赞美诗·四声部 9 第 3 系统 `4|5` 的 4 连线 32×116、字号 33，墨占 0.26），整块哪一类都不是，音和线一起丢。
    // 线够 2.8 字号长（单声部小节线 1.5~2.2）、细（≤0.25 字号）才认，整根擦掉后剩下的照常归类。
    const glued = !sparse && bars.length === 1 && bars[0].h >= numH * 2.8 && bars[0].w <= numH * 0.25;
    if (!sparse && !glued) { out.push(k); continue; }
    if (glued) probe("untangleBridged.gluedDigit");
    // 1.6–1.8 字号的矮块只认「弧脚收在行末小节线顶上」这一形：竖线贴着块的左/右边缘。1940《宣告得胜年》
    // 第 9 行那块只带着一小截弧（27×25、字号 14，1.79 字号），整块落进数字通道读成 `0`、行末小节线没了，
    // 还把全行数字带顶高、别的数字补高后读错。不卡边缘的话，1775、11 等四首别处的块被拆，各掉一两行；
    // 两侧各一根的是房号括线那种框（主祢真伟大 69×37），也不拆。
    if (b.h < numH * 1.8 && (bars.length !== 1 || (bars[0].cx - b.x > 2 && rright(b) - bars[0].cx > 2))) { out.push(k); continue; }
    // 跨两个声部的长线（≥3.5 字号，四声部谱实测 3.2~3.9；单声部小节线 1.5~2.2，小图「哦，愿我有千万舌头」到 3.0）：弧不只在最顶上，下一声部的连音线从竖笔**中段**穿过（78《马槽歌》
    // Q3/Q4 `5⌒|5`、`5⌒|1`，线旁的音还常与弧尾粘着）。这种线**整根从上到下擦**、只擦线本身的宽度（左右各多 1px），
    // 擦完再把被线隔开的两截弧接回（见下），粘着弧尾的音交给后面的 splitArcTail。
    const spanning = glued || bars.some((bar) => bar.h >= numH * 3.5);
    const halo = spanning ? Math.max(...bars.map((bar) => Math.ceil(bar.w / 2) + 1)) : Math.ceil(numH * 0.25);
    const inBar = (absX: number) => bars.some((bar) => Math.abs(absX - bar.cx) <= halo);
    // 只取**本连通块自身**的像素：bbox 矩形里常混入相邻的独立块（如邻音的增时线），直接按矩形
    // 复制会把它们也 re-CCL 出来、与其本体重复计数。故从竖笔上一枚种子像素 8-邻接泛洪重建本块掩码。
    const mask = new Uint8Array(b.w * b.h);
    const seed = (bars[0].y - b.y) * b.w + (Math.round(bars[0].cx) - b.x);
    const st = [seed]; mask[seed] = 1;
    while (st.length) {
      const cur = st.pop()!, yy = (cur / b.w) | 0, xx = cur - yy * b.w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const ny = yy + dy, nx = xx + dx;
        if (ny < 0 || ny >= b.h || nx < 0 || nx >= b.w) continue;
        const ni = ny * b.w + nx;
        if (!mask[ni] && bin.data[(b.y + ny) * bin.w + (b.x + nx)]) { mask[ni] = 1; st.push(ni); }
      }
    }
    // 弧带 = 顶部连续墨带（列扫时跳过竖笔列，免竖笔把整列串成一带）。其下界即开始擦竖笔的位置。
    const rowInkExcl = (yy: number) => {
      let n = 0;
      for (let xx = 0; xx < b.w; xx++) if (!inBar(b.x + xx) && mask[yy * b.w + xx]) n++;
      return n;
    };
    let y = 0;
    while (y < b.h && rowInkExcl(y) === 0) y++;
    const bandTop = y;
    while (y < b.h && rowInkExcl(y) > 0) y++;
    // 顶上那条墨带离块顶超过 0.4 字号，就不是弧：是数字中线上的增时线顶到了线上（四声部 9 第 3 系统 `2 –┤`，
    // 37×118、字号 33，横线在块顶下 28px），只擦带以下的话，增时线连着上半截线成了「┐」读成 0。这种整根擦。
    const noArc = bandTop > numH * 0.4;
    if (noArc && !spanning) probe("untangleBridged.dashOnBar");
    const arcBottom = spanning || noArc ? 0 : y;         // 块内偏移：弧带下界，此下的竖笔可擦（长线整根擦）
    // 子图：本块掩码擦掉弧带以下的竖笔列，重做连通域 → 弧/增时线/数字各自独立。
    const sub: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
    for (let yy = 0; yy < b.h; yy++)
      for (let xx = 0; xx < b.w; xx++) {
        if (!mask[yy * b.w + xx]) continue;
        if (yy >= arcBottom && inBar(b.x + xx)) continue;   // 擦弧带以下的竖笔
        sub.data[yy * b.w + xx] = 1;
      }
    const labels = new Int32Array(b.w * b.h);
    const ccs = connectedComponents(sub, 4, labels);
    const pieces: Component[] = [];
    for (const p of ccs) pieces.push(...(spanning ? peelDigit(p, labels, b, numH) : [{
      id: p.id, area: p.area,
      bbox: { x: b.x + p.bbox.x, y: b.y + p.bbox.y, w: p.bbox.w, h: p.bbox.h },
      cx: b.x + p.cx, cy: b.y + p.cy,
    }]));
    for (const bar of bars)
      out.push({ id: 2_000_000 + out.length, bbox: { x: Math.round(bar.cx - 1), y: bar.y, w: 2, h: bar.h }, area: 2 * bar.h, cx: bar.cx, cy: bar.y + bar.h / 2 });
    probe("untangleBridged");
    // 弧不在最顶上也会横穿竖笔：四声部谱的小节线贯穿两个声部，下一声部跨小节线的连音线从竖笔**中段**穿过
    //（78《马槽歌》Q4 `5⌒|1`），擦竖笔时被拦腰截成两半，两半都不够弧宽、整条连音线丢了。
    // 竖笔两侧、同一高度、缺口只有擦掉的那一截宽的两块细墨，接回一条。
    // 「细」= 矮，或墨只占框的四分之一以下：弧端垂到音符头顶，半截弧的框也会被拉高（78 行首那条左半 56×26）
    // 但带着一段粗列（≥0.25 字号、连续 0.3 字号宽，即粘着个没剥下来的数字）的不算：同首 Q3 `2`+半截弧 51×43 墨也不到四分之一，被接走后 2 就丢了。
    const hasThickCol = (p: Component): boolean => {
      if (p.id >= 500_000) return false;                          // peelDigit 剥剩的细弧
      // 连续够 0.3 字号宽的粗列才是数字；弧端垂到音符头顶那一两列竖直的墨也会过 0.25 字号（78 行首左半截弧）
      const x0 = p.bbox.x - b.x, y0 = p.bbox.y - b.y;
      let run = 0;
      for (let xx = x0; xx < x0 + p.bbox.w; xx++) {
        let n = 0;
        for (let yy = y0; yy < y0 + p.bbox.h; yy++) if (labels[yy * b.w + xx] === p.id) n++;
        run = n >= numH * 0.25 ? run + 1 : 0;
        if (run >= numH * 0.3) return true;
      }
      return false;
    };
    const thin = (p: Component) => p.bbox.w >= 3 && (p.bbox.h <= numH * 0.6 || p.area < p.bbox.w * p.bbox.h * 0.25) && !hasThickCol(p);
    const used = new Set<Component>();
    for (const bar of bars) {
      for (const l of pieces) {
        if (used.has(l) || !thin(l) || Math.abs(rright(l.bbox) - (bar.cx - halo)) > 3) continue;
        const r = pieces.find((q) => q !== l && !used.has(q) && thin(q) && Math.abs(q.bbox.x - (bar.cx + halo)) <= 3 &&
          overlapRatioY(q.bbox, l.bbox) >= 0.5);
        if (!r) continue;
        used.add(l); used.add(r);
        const bb = unionRect(l.bbox, r.bbox);
        probe("untangleBridged.rejoinArc");
        pieces.push({ id: REJOINED_ARC_ID + pieces.length, area: l.area + r.area, bbox: bb, cx: rcx(bb), cy: rcy(bb) });
      }
    }
    out.push(...pieces.filter((p) => !used.has(p)));
  }
  return out;
}

/** 增时线碰上小节线：行末 `6 –|` 的 '-' 右端顶到小节线，两者粘成一块「⊣」（迦南诗选 1771《你曾向主许下》
 *  23×42、字号 30）。块比数字高、又不够瘦，小节线与横线两道判据都进不去，落进数字通道读成 `0`——这一行没了
 *  行末小节线、与下一行连成一片，数字带还被它撑高到 42px，同行别的数字 rec 补高后 7 全读成了 1。
 *  判据：块的一侧边缘是一道贯穿全高（≥0.9 块高）的细竖笔，擦掉竖笔后剩下的恰是**一条**处在块中部的细横条。
 *  拆成小节线 + 横线两块，交给 classify 各归各类。数字的竖笔都不在块边缘上贯穿全高（1 的竖笔两侧有衬线/旗，
 *  4 的横笔探出竖笔之外），剩余部分又得是一条扁平实心的横条，挡得住。 */
export function splitBarDash(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 3_000_000;
  const mk = (r: Rect, area: number): Component => ({ id: nextId++, bbox: r, area, cx: rcx(r), cy: rcy(r) });
  for (const k of comps) {
    const b = k.bbox;
    if (b.h < numH * 0.85 || b.h > numH * 2 || b.w < numH * 0.4 || b.w > numH * 1.2) { out.push(k); continue; }
    // 每列最长竖直墨段够不够贯穿全高
    const full = (xx: number) => {
      let best = 0, cur = 0;
      for (let yy = 0; yy < b.h; yy++) { if (bin.data[(b.y + yy) * bin.w + b.x + xx]) { if (++cur > best) best = cur; } else cur = 0; }
      return best >= b.h * 0.9;
    };
    const maxBar = Math.max(3, Math.round(numH * 0.15));
    let split: Component[] | null = null;
    for (const fromLeft of [true, false]) {
      const col = (i: number) => (fromLeft ? i : b.w - 1 - i);
      let n = 0;
      while (n < b.w && full(col(n))) n++;
      if (n === 0 || n > maxBar) continue;
      const bx0 = fromLeft ? 0 : b.w - n, bx1 = fromLeft ? n : b.w;             // 竖笔列 [bx0, bx1)
      const rest = fromLeft ? tightBox(bin, b, n, b.w, 0, b.h) : tightBox(bin, b, 0, b.w - n, 0, b.h);
      if (!rest || rest.h > Math.max(3, numH * 0.32) || rest.w < numH * 0.3) continue;
      const mid = (rcy(rest) - b.y) / b.h;
      if (mid < 0.3 || mid > 0.7) continue;                                   // 横条在块中部（数字中线）
      if (inkFill(bin, rest) < 0.8) continue;                                 // 实心的一条，不是几段碎墨
      const bar = tightBox(bin, b, bx0, bx1, 0, b.h)!;
      split = [mk(bar, bar.w * bar.h), mk(rest, Math.round(inkFill(bin, rest) * rest.w * rest.h))];
      break;
    }
    if (split) { probe("splitBarDash"); out.push(...split); } else out.push(k);
  }
  return out;
}

/** 小节线顶上粘着表情记号：迦南诗选 1775《十字架的路上》「渐慢rit」的「渐」印得太低，左半的笔画压在下一小节
 *  开头那根小节线的顶上，两者成了一块 30×82（字号 33）——太高太宽不像小节线，竖笔又只占块高七成，
 *  untangleBridged 的「贯穿 ≥0.8 块高」也不认，这根小节线就丢了，两小节并成一个。
 *  判据：从块底往上逐行看，每行都**只有一段**细墨（≤max(3, 0.15 字号)）、且与最底一行左右对得上，
 *  这样的行连续够一根小节线长（≥1.2 字号）；再往上剩下的墨也得够高（≥0.4 字号），确是另一样东西。
 *  拆成小节线 + 上面那块，交给 classify 各归各类。数字的竖笔（1、4、7）不到 1.2 字号，挨不上。 */
export function splitBarCap(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 4_000_000;
  const maxBar = Math.max(3, Math.round(numH * 0.15));
  for (const k of comps) {
    const b = k.bbox;
    if (b.h < numH * 1.8 || b.h > numH * 4 || b.w > numH * 1.5) { out.push(k); continue; }
    // 只看本块自己的像素：矩形里常混着邻块（1775 右边那个 6 和它的减时线），在矩形里重做连通域、
    // 取包围盒铺满整个矩形的那一块。
    const sub: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
    for (let yy = 0; yy < b.h; yy++) for (let xx = 0; xx < b.w; xx++) sub.data[yy * b.w + xx] = bin.data[(b.y + yy) * bin.w + b.x + xx];
    const labels = new Int32Array(b.w * b.h);
    const self = connectedComponents(sub, 1, labels).filter((p) => p.bbox.w === b.w && p.bbox.h === b.h)
      .sort((p, q) => q.area - p.area)[0];
    if (!self) { out.push(k); continue; }
    const own: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
    for (let i = 0; i < labels.length; i++) own.data[i] = labels[i] === self.id ? 1 : 0;
    // 一行里的墨段：只有一段时返回 [x0, x1)，否则 null
    const run = (yy: number): [number, number] | null => {
      let x0 = -1, x1 = -1;
      for (let xx = 0; xx < b.w; xx++) {
        if (!own.data[yy * b.w + xx]) continue;
        if (x0 < 0) x0 = xx;
        else if (xx > x1) return null;              // 前一段已断开，又见墨：不止一段
        x1 = xx + 1;
      }
      return x0 < 0 ? null : [x0, x1];
    };
    const base = run(b.h - 1);
    if (!base || base[1] - base[0] > maxBar) { out.push(k); continue; }
    let n = 0;
    for (let yy = b.h - 1; yy >= 0; yy--) {
      const r = run(yy);
      if (!r || r[1] - r[0] > maxBar || Math.abs(r[0] - base[0]) > 1 || Math.abs(r[1] - base[1]) > 1) break;
      n++;
    }
    // 上段**也是一段细竖墨**的，是一根整线只在中段错了一两像素：四声部谱跨两个声部的小节线（新编赞美诗·四声部
    // 《圣哉三一歌》实测 6×114、字号 36，在两声部之间错开 2px），切开后两截各 1.6 字号，被 classify 当成数字 1
    // 收回——那一行少了一根小节线，`♯4` 前也多出个音。
    // 每行都得有墨、只一段细墨、左右与底段错开不过一个线宽——「渐」字压在线顶那种（1775），三点水每行
    // 也是细细一段，但有断行、左右飘得远。
    let thinAbove = true;
    for (let yy = 0; yy < b.h - n && thinAbove; yy++) {
      const r = run(yy);
      // 宽度放 3px：同一根线上半截比下半截粗一两像素（四声部 9 第 3 系统行末两根 6×76 接 4×42，字号 33、线宽门 5），
      // 切开后上截过不了行内相对门、下截更矮，下两声部整根丢
      if (!r || r[1] - r[0] > maxBar + 3 || Math.abs(r[0] - base[0]) > maxBar) thinAbove = false;
    }
    if (thinAbove) { out.push(k); continue; }
    const at: Rect = { x: 0, y: 0, w: b.w, h: b.h };
    const top = n >= numH * 1.2 && n < b.h ? tightBox(own, at, 0, b.w, 0, b.h - n) : null;
    if (!top || top.h < numH * 0.4) { out.push(k); continue; }
    const bar = tightBox(own, at, 0, b.w, b.h - n, b.h)!;
    const mk = (r: Rect): Component => {
      let area = 0;
      for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) area += own.data[yy * b.w + xx];
      const abs = { x: b.x + r.x, y: b.y + r.y, w: r.w, h: r.h };
      return { id: nextId++, bbox: abs, area, cx: rcx(abs), cy: rcy(abs) };
    };
    probe("splitBarCap");
    out.push(mk(bar), mk(top));
  }
  return out;
}

/** 数字（或 ♯）的一侧粘着一条细弧：连音/圆滑线的一端落在音符头上、跟它连成一块（新编赞美诗·四声部
 *  《圣哉三一歌》`5 − 4 −` 的弧从 5 的右上角拉到 4，5 连弧 166×47；`3⌒♯4` 的弧尾粘在 ♯ 左边，字号 36）。
 *  整块进了数字通道：包围盒吞掉弧下的增时线，5 读成 7；♯ 被撑宽，弧也没了。
 *  判据：按列数本块自己的墨，**只有一段粗列**（≥0.25 字号，宽 0.3~1.2 字号——一个数字或记号，「1」只有 0.37），
 *  其余的列都是细墨（≤0.2 字号，弧的线宽）、加起来够 0.6 字号宽，而且都在块的上半（弧从音符头上拉出去）。
 *  78《马槽歌》擦掉小节线后，线两侧的音各连着半截连音弧（`5` 连半截弧 60×44，右缘还贴着一列线边）。
 *  按列拆成「粗段」与「其余」两块，交给 classify 各归各类。两个数字粘连时有两段粗列，不拆。 */
export function splitArcTail(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 5_000_000;
  for (const k of comps) {
    const b = k.bbox;
    // 高到 2 字号：弧从数字头顶拱起的高度也算在块里（78《马槽歌》Q2 `5⌒6` 的 6 连弧 83×55，字号 30）
    if (isRejoinedArc(k) || b.w < numH * 1.6 || b.h < numH * 0.6 || b.h > numH * 2) { out.push(k); continue; }
    const sub: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
    for (let yy = 0; yy < b.h; yy++) for (let xx = 0; xx < b.w; xx++) sub.data[yy * b.w + xx] = bin.data[(b.y + yy) * bin.w + b.x + xx];
    const labels = new Int32Array(b.w * b.h);
    const self = connectedComponents(sub, 1, labels).filter((p) => p.bbox.w === b.w && p.bbox.h === b.h)
      .sort((p, q) => q.area - p.area)[0];
    if (!self) { out.push(k); continue; }
    const own = (xx: number, yy: number) => labels[yy * b.w + xx] === self.id;
    const cols: number[] = [], lowest: number[] = [];
    for (let xx = 0; xx < b.w; xx++) {
      let n = 0, lo = -1;
      for (let yy = 0; yy < b.h; yy++) if (own(xx, yy)) { n++; lo = yy; }
      cols.push(n); lowest.push(lo);
    }
    const thick = cols.map((n) => n >= numH * 0.25);
    const spans: Array<[number, number]> = [];
    for (let xx = 0; xx < b.w; xx++) {
      if (!thick[xx]) continue;
      const last = spans[spans.length - 1];
      if (last && xx - last[1] <= 2) last[1] = xx + 1;
      else spans.push([xx, xx + 1]);
    }
    // 块边缘上一两列宽的「粗段」是擦小节线剩下的线边（untangleBridged 只擦线宽，线略歪时贴着弧的那侧留一列），
    // 不算第二个数字，这几列也不参与下面的细墨检查。
    const residue = new Set<number>();
    for (let si = spans.length - 1; si >= 0; si--) {
      const [sa, se] = spans[si]!;
      if (spans.length > 1 && se - sa < numH * 0.15 && (sa === 0 || se === b.w)) {
        for (let xx = sa; xx < se; xx++) residue.add(xx);
        spans.splice(si, 1);
      }
    }
    // 一段粗列：数字一侧粘弧（`5 − 4 −` 的 5）或记号吊在弧下；两段：一条弧两头各粘一个数字（78《马槽歌》Q1
    // `3̲⌒4̲` 连成 97×51）。
    if (spans.length < 1 || spans.length > 2) { out.push(k); continue; }
    // 数字左右缘那几列墨少，但落在块的下半——是数字的笔画，并进粗段
    const bodies = spans.map(([sa, se]): [number, number] => {
      let a = sa, e = se;
      while (a > 0 && lowest[a - 1] > b.h * 0.5 && !residue.has(a - 1)) a--;
      while (e < b.w && lowest[e] > b.h * 0.5 && !residue.has(e)) e++;
      return [a, e];
    });
    // 「1」只有一根竖笔：粗段不到 0.3 字号宽，但列墨够 0.8 字号高（弧两头各粘一个 1，新编赞美诗·四声部 281 第 1 系统
    // 第 2 声部 `1·⌒1` 122×53、字号 35，左边那个 1 的竖笔 6 列）。这种放到 0.15 字号。
    const stem = ([a, e]: [number, number]) => { for (let xx = a; xx < e; xx++) if (cols[xx]! >= numH * 0.8) return true; return false; };
    // 竖笔左边的小撇并进来（最低墨点比竖笔顶低 0.15 字号以上的几列；弧尾只到笔顶）：只剩 6px 的竖笔过不了数字块的宽度门
    for (const bd of bodies) {
      if (!stem(bd)) continue;
      const stemTop = b.h - Math.max(...cols.slice(bd[0], bd[1]));
      while (bd[0] > 0 && bd[1] - bd[0] < numH * 0.45 && cols[bd[0] - 1]! > 0 && lowest[bd[0] - 1]! >= stemTop + numH * 0.15 && !residue.has(bd[0] - 1)) bd[0]--;
    }
    // 两侧都是弧：记号挂在弧下（《圣哉三一歌》Q2 `1⌒ᵇ7`，小号 ♭ 吊在弧中间，整块 59×23），粗段窄到 0.2 字号也拆
    const hanging = bodies.length === 1 && bodies[0]![0] > numH * 0.3 && b.w - bodies[0]![1] > numH * 0.3;
    if (bodies.some((bd) => bd[1] - bd[0] < numH * (stem(bd) ? 0.15 : hanging ? 0.2 : 0.3) || bd[1] - bd[0] > numH * 1.2)) { out.push(k); continue; }
    const inSpan = (xx: number) => bodies.findIndex(([a, e]) => xx >= a && xx < e);
    let thinW = 0, ok = true;
    for (let xx = 0; xx < b.w && ok; xx++) {
      if (inSpan(xx) >= 0 || residue.has(xx)) continue;
      if (!cols[xx]) continue;
      // 紧挨竖笔的那一两列略厚的墨是「1」的小撇，不算坏了弧
      const byStem = bodies.some((bd) => stem(bd) && (xx === bd[0] - 1 || xx === bd[0] - 2 || xx === bd[1] || xx === bd[1] + 1));
      if ((cols[xx] > numH * 0.2 && !(byStem && cols[xx] <= numH * 0.3)) || lowest[xx] > b.h * 0.5) ok = false;
      thinW++;
    }
    if (!ok || thinW < numH * 0.6) { out.push(k); continue; }
    // 记号吊在弧中间时，粗段只取**弧带以下**的墨：弧横过记号头顶的那一截归弧（弧带下沿取粗段两侧相邻细列的
    // 最低墨点）。数字一侧粘弧时整列都归数字——弧尾接在数字顶横上，按弧带切会把 5 的顶横切走读成 1（78 Q3）。
    const [ha, he] = bodies[0]!;
    const bandBottom = hanging ? Math.max(ha > 0 ? lowest[ha - 1] : -1, he < b.w ? lowest[he] : -1) : -1;
    /** 这个像素归第几个数字（-1 = 弧） */
    const owner = (xx: number, yy: number) => { const si = inSpan(xx); return si >= 0 && yy > bandBottom ? si : -1; };
    const piece = (who: number): Component | null => {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, area = 0;
      for (let yy = 0; yy < b.h; yy++) for (let xx = 0; xx < b.w; xx++) {
        if (!own(xx, yy) || owner(xx, yy) !== who) continue;
        area++; x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy);
      }
      if (!area) return null;
      const abs = { x: b.x + x0, y: b.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      return { id: nextId++, bbox: abs, area, cx: rcx(abs), cy: rcy(abs) };
    };
    const digits = bodies.map((_, si) => piece(si)), arc = piece(-1);
    if (digits.some((d) => !d) || !arc) { out.push(k); continue; }
    probe(digits.length > 1 ? "splitArcTail.bridge" : "splitArcTail");
    out.push(...(digits as Component[]), arc);
  }
  return out;
}

/** 减时线上挂着八度点：点紧贴线、连成「┬」（新编赞美诗·四声部 117 第 2 声部 `5̳̣` 的第二条减时线连着低音点 30×12、字号 35），
 *  比横线的高度门高一点，哪一类都不是——那条减时线和点一起丢。线薄的时候整块过得了横线门，点也没了。
 *  判据：块顶（或块底）几行是横贯整块的实线（≥0.8 块宽、连毛边行厚不过 max(3, 0.2 字号)），其余各行的墨都挤在一小段里
 *  （≤0.35 字号宽）、够一个点高（≥0.12 字号）。拆成横线 + 点，各归各类。 */
export function splitLineDot(bin: Binary, comps: Component[], numH: number, trimRagged = false): Component[] {
  const out: Component[] = [];
  let nextId = 8_000_000;
  const maxLine = Math.max(3, Math.round(numH * 0.2));
  for (const k of comps) {
    const b = k.bbox;
    if (b.w < numH * 0.5 || b.w > numH * 4 || b.h < numH * 0.2 || b.h > numH * 0.6) { out.push(k); continue; }
    const rows: number[] = [], x0s: number[] = [], x1s: number[] = [];
    for (let yy = 0; yy < b.h; yy++) {
      let n = 0, x0 = -1, x1 = -1;
      for (let xx = 0; xx < b.w; xx++) if (bin.data[(b.y + yy) * bin.w + b.x + xx]) { n++; if (x0 < 0) x0 = xx; x1 = xx; }
      rows.push(n); x0s.push(x0); x1s.push(x1);
    }
    const full = rows.map((n) => n >= b.w * 0.8);
    let split: Component[] | null = null;
    // 实线带：连续的满行，再并上紧邻的毛边行（墨散得比一个点宽的）
    let la = full.indexOf(true), lb = la;
    if (la >= 0) {
      while (lb + 1 < b.h && full[lb + 1]) lb++;
      const ragged = (yy: number) => rows[yy]! > 0 && x1s[yy]! - x0s[yy]! + 1 > numH * 0.35;
      while (la > 0 && ragged(la - 1)) la--;
      while (lb + 1 < b.h && ragged(lb + 1)) lb++;
      const n = lb - la + 1;
      // 点只在一侧（另一侧到块边不留行），线带之外不再有满行
      const above = la, below = b.h - 1 - lb;
      if (n <= maxLine && (above === 0) !== (below === 0) && !full.some((f, yy) => f && (yy < la || yy > lb))) {
        let [ya, yb] = above ? [0, la] : [lb + 1, b.h];
        // 贴着线的那一两行常是线的毛边（比点宽、又不到「毛边行」的 0.35 字号）：算进点里，点就胖出点候选的尺寸门
        //（11《荣归天父歌》男低 `5̳̣`：点 7×7，贴线那行 11px 宽）。比点身中位宽出四成的贴线行归线。
        const spanOf = (yy: number) => (rows[yy]! > 0 ? x1s[yy]! - x0s[yy]! + 1 : 0);
        const medSpan = median(Array.from({ length: yb - ya }, (_, j) => spanOf(ya + j)).filter((v) => v > 0)) || 0;
        // 只在四声部页做：粗黑翻印本（1218）的点本来就上宽下窄，削掉贴线行反倒小出点门（全本 10 首各掉一两个点）
        if (trimRagged && above) while (yb - ya > 2 && spanOf(yb - 1) > medSpan * 1.4) yb--;
        else if (trimRagged) while (yb - ya > 2 && spanOf(ya) > medSpan * 1.4) ya++;
        let lo = Infinity, hi = -1, cnt = 0;
        for (let yy = ya; yy < yb; yy++) {
          if (!rows[yy]) continue;
          cnt++; lo = Math.min(lo, x0s[yy]!); hi = Math.max(hi, x1s[yy]!);
        }
        const dot = cnt >= numH * 0.12 && hi - lo + 1 <= numH * 0.35 && hi - lo + 1 >= numH * 0.1
          ? tightBox(bin, b, lo, hi + 1, ya, yb) : null;
        if (dot) {
          const line: Rect = { x: b.x, y: b.y + la, w: b.w, h: n };
          let lineArea = 0;
          for (let yy = la; yy <= lb; yy++) lineArea += rows[yy]!;
          split = [{ id: nextId++, bbox: line, area: lineArea, cx: rcx(line), cy: rcy(line) },
            { id: nextId++, bbox: dot, area: Math.max(1, k.area - lineArea), cx: rcx(dot), cy: rcy(dot) }];
        }
      }
    }
    if (split) { probe("splitLineDot"); out.push(...split); } else out.push(k);
  }
  return out;
}

/** 上一声部的减时线下面挂着下一声部的弧：四声部谱两声部挨得近，Q2 `7⌒1` 的弧顶碰到 Q1 `2̲3̲` 的减时线，
 *  连成一块（78《马槽歌》82×26，字号 30）——过不了横线的扁度门，Q1 那两个音就没了减时线，弧也跟着丢。
 *  判据：块顶上一条横贯整块（≥0.85 块宽）的直线带（≤0.3 字号厚），带下剩下的每列都只是细墨（<0.25 字号），
 *  且连着横贯六成以上的宽（是一条弧，不是减时线下挂的几个低音点）。
 *  拆成「横线 + 其下的墨」两块，交给 classify 各归各类。 */
export function splitLineOverArc(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 7_000_000;
  for (const k of comps) {
    const b = k.bbox;
    if (b.w < numH * 1.2 || b.h <= numH * 0.4 || b.h > numH * 1.2) { out.push(k); continue; }
    const sub: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
    for (let yy = 0; yy < b.h; yy++) for (let xx = 0; xx < b.w; xx++) sub.data[yy * b.w + xx] = bin.data[(b.y + yy) * bin.w + b.x + xx];
    const labels = new Int32Array(b.w * b.h);
    const self = connectedComponents(sub, 1, labels).filter((p) => p.bbox.w === b.w && p.bbox.h === b.h)
      .sort((p, q) => q.area - p.area)[0];
    if (!self) { out.push(k); continue; }
    const own = (xx: number, yy: number) => labels[yy * b.w + xx] === self.id;
    const run = (yy: number) => { let best = 0, cur = 0; for (let xx = 0; xx < b.w; xx++) { if (own(xx, yy)) { if (++cur > best) best = cur; } else cur = 0; } return best; };
    let y1 = 0;
    while (y1 < Math.min(3, b.h) && run(y1) < b.w * 0.85) y1++;          // 线带从顶上两三行内起
    const y0 = y1;
    while (y1 < b.h && run(y1) >= b.w * 0.85) y1++;
    if (y1 === y0 || y1 - y0 > numH * 0.3 || y1 >= b.h - 2) { out.push(k); continue; }
    // 线下那部分得是**一条**连着横贯六成宽的细墨（弧）：单声部谱减时线下挂的是低音点，零散几个，不拆
    //（从前所珍爱、8085、11 各被凭空拆出一条弧）。
    let ok = true, longest = 0, cur = 0;
    for (let xx = 0; xx < b.w && ok; xx++) {
      let n = 0;
      for (let yy = y1; yy < b.h; yy++) if (own(xx, yy)) n++;
      if (n >= numH * 0.25) ok = false;
      cur = n ? cur + 1 : 0;
      longest = Math.max(longest, cur);
    }
    if (!ok || longest < b.w * 0.6) { out.push(k); continue; }
    const box = (from: number, to: number): Component | null => {
      let x0 = Infinity, yy0 = Infinity, x1 = -1, yy1 = -1, area = 0;
      for (let yy = from; yy < to; yy++) for (let xx = 0; xx < b.w; xx++) {
        if (!own(xx, yy)) continue;
        area++; x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); yy0 = Math.min(yy0, yy); yy1 = Math.max(yy1, yy);
      }
      if (!area) return null;
      const r = { x: b.x + x0, y: b.y + yy0, w: x1 - x0 + 1, h: yy1 - yy0 + 1 };
      return { id: nextId++, bbox: r, area, cx: rcx(r), cy: rcy(r) };
    };
    const line = box(0, y1), below = box(y1, b.h);
    if (!line || !below) { out.push(k); continue; }
    probe("splitLineOverArc");
    out.push(line, below);
  }
  return out;
}

export function splitArcEndDots(bin: Binary, comps: Component[], numH: number, strokeMax = 0.12, fat = false): Component[] {
  const out: Component[] = [];
  let nextId = 2_000_000;
  // 面积：四声部页（fat）按实际墨数——弧那块按框面积算就不「稀」了，下游当成数字块读出个音
  const mk = (r: Rect): Component => ({ id: nextId++, bbox: r, area: fat ? inkCount(bin, r) : r.w * r.h, cx: rcx(r), cy: rcy(r) });
  for (const k of comps) {
    const b = k.bbox;
    if (b.w < numH * 0.6 || b.h < numH * 0.2 || b.h > numH * 0.8 || b.w < b.h * 2) { out.push(k); continue; }
    const col = columnInk(bin, b, 0, b.h);
    const stroke = median(col.filter((v) => v > 0)) || 1;
    if (stroke > numH * strokeMax) { out.push(k); continue; }              // 笔画本身就粗：不是细弧
    // 厚列门槛 2.2 倍笔画（原 2.5）：迦南诗选 1780《主快来》「头」`1̇⌒7` 那个点 8×7、弧笔画 3px，
    // 点最厚处 7 恰差半像素够不着 7.5，点没切下来、1 丢了高八度。点比弧粗两倍多已足够分开。
    const thick = Math.max(stroke * 2.2, numH * 0.15);
    // 从一端往里：跳过空列，数连续的厚列；返回 [起列, 止列)（相对 b.x），不成点返回 null
    const endRun = (fromLeft: boolean): [number, number] | null => {
      const at = (i: number) => col[fromLeft ? i : b.w - 1 - i]!;
      // 点的范围按「≥1.6 倍笔画」量（点的左右边缘那一两列墨少，按门槛量会从第一列就断掉，
      // 实测 `6,8,8,9,8,8,5` 对笔画 3），其中要有列真正厚过门槛。
      // 块最外那一两列只擦着点的圆边，墨比 1.6 倍笔画还少（2038《谁一直在街上呼喊》实测 `5,8,10,12…`、
      // `…12,8,2`，笔画 4），从那儿量会一步就断；先让过至多 0.08 字号的薄边，点的范围仍从第一列墨算起。
      let i = 0;
      while (i < b.w && at(i) === 0) i++;
      const start = i;
      while (i < b.w && i - start < numH * 0.08 && at(i) > 0 && at(i) < stroke * 1.6) i++;
      let peak = 0;
      while (i < b.w && at(i) >= stroke * 1.6) { peak = Math.max(peak, at(i)); i++; }
      const runW = i - start;
      if (peak < thick || runW < numH * 0.12 || runW > numH * 0.4 || b.w - i < numH * 0.4) return null;
      return fromLeft ? [start, i] : [b.w - i, b.w - start];
    };
    const left = endRun(true), right = endRun(false);
    if (!left && !right && !fat) { out.push(k); continue; }
    // 先按两端都切来量弧的底边，再逐个验点；没过验的那一端列还给弧
    const arc = tightBox(bin, b, left?.[1] ?? 0, right?.[0] ?? b.w, 0, b.h);
    if (!arc) { out.push(k); continue; }
    // 「比弧低」只跟**本端这一侧**的弧比：弧的另一只脚落在邻音的八度点旁，本就与这个点一样低
    //（2038 `2̇⌒3̇` 右脚底 = 左点底，右点自己没粘上弧），故量弧底时让过远端 0.5 字号。
    const foot = Math.round(numH * 0.5);
    const asDot = (run: [number, number] | null, fromLeft: boolean): Rect | null => {
      if (!run) return null;
      const d = tightBox(bin, b, run[0], run[1], 0, b.h);
      if (!d) return null;
      const ratio = d.w / d.h;
      // 宽高比下限 0.5（原 0.6）：切出来的框里除了点还含着**弧的那一小截尾巴**，框被拉高一两像素
      // ——1801《活水的江河》第 6/7/8/10 行那四个被弧脚罩住的高八度点实测 5×9 = 0.56，卡在 0.6 上
      // 整个丢掉（点自己是 5×7 = 0.71）。0.5 仍挡得住细长的弧脚碎片（那些是 2~3 px 宽、十来 px 高）。
      if (d.w > numH * 0.45 || d.h > numH * 0.45 || d.h < numH * 0.12 || ratio < 0.5 || ratio > 1.7) return null;
      const x0 = left?.[1] ?? 0, x1 = right?.[0] ?? b.w;
      const near = fromLeft ? tightBox(bin, b, x0, Math.max(x0 + 1, x1 - foot), 0, b.h)
        : tightBox(bin, b, Math.min(x1 - 1, x0 + foot), x1, 0, b.h);
      return rbottom(d) > rbottom(near ?? arc) ? d : null;                   // 点挂在弧脚上，比弧低
    };
    // 退路（只在四声部页，fat = true）：弧脚竖着落到点顶上，按列量出来的框连着那截弧脚、又高又瘦（172 `1̇⌒2̇` 右端 7×16）。
    // 改从块端底下往上逐行量墨宽：点是底下一团，往上收成一截细颈（弧脚）再接到弧上。量到宽度缩到点宽七成以下的那一行为止，
    // 以下就是点；一路往上没有收窄的是光秃秃的弧脚，不切。
    const fatDot = (fromLeft: boolean): Rect | null => {
      const need = Math.max(stroke * 1.5, numH * 0.15);
      const zone = Math.round(numH * 0.45);                              // 只看块端这一段
      const xa = fromLeft ? 0 : Math.max(0, b.w - zone), xb = fromLeft ? Math.min(b.w, zone) : b.w;
      // 只看本块自己的墨：框里常躺着别的块（弧左脚底下那个没粘上的点），照框量会把它再「切」出来一遍
      const sub: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) sub.data[y * b.w + x] = bin.data[(b.y + y) * bin.w + b.x + x];
      const labels = new Int32Array(b.w * b.h);
      const self = connectedComponents(sub, 1, labels).find((q) => q.bbox.w === b.w && q.bbox.h === b.h);
      if (!self) return null;
      const ink = (xx: number, yy: number) => labels[yy * b.w + xx] === self.id;
      // 一行里最宽的那段墨 [l, r]
      const runOf = (yy: number): [number, number] | null => {
        let best: [number, number] | null = null, st = -1;
        for (let xx = xa; xx <= xb; xx++) {
          if (xx < xb && ink(xx, yy)) { if (st < 0) st = xx; }
          else if (st >= 0) { if (!best || xx - st > best[1] - best[0] + 1) best = [st, xx - 1]; st = -1; }
        }
        return best;
      };
      let yy = b.h - 1;
      while (yy >= 0 && !runOf(yy)) yy--;
      if (yy < b.h - 1 - Math.max(1, stroke * 0.5)) return null;         // 点挂在块底：弧在上、点在脚下
      const y1 = yy;
      let x0 = Infinity, x1 = -1, maxW = 0, neck = false;
      for (; yy >= 0; yy--) {
        const r = runOf(yy);
        if (!r) break;
        const w = r[1] - r[0] + 1;
        if (y1 - yy >= numH * 0.12 && maxW >= need && w <= maxW * 0.7) { neck = true; break; }
        maxW = Math.max(maxW, w); x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[1]);
      }
      if (!neck) return null;
      // 颈以上还得有墨（弧脚接上去的那几行）：弧端自己往下垂的那一截，最顶上一两行是毛边、也窄，再往上就没有了（172 男高音行 59×13）
      let above = 0;
      for (let y = yy; y >= 0 && runOf(y); y--) above++;
      if (above < Math.max(3, stroke)) return null;
      const y0 = yy + 1, w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w > numH * 0.45 || h > numH * 0.45 || w < numH * 0.12 || w / h < 0.6 || w / h > 1.7) return null;
      if (fromLeft ? x0 > numH * 0.15 : b.w - 1 - x1 > numH * 0.15) return null;   // 贴着块端
      return { x: b.x + x0, y: b.y + y0, w, h };
    };
    const dl = asDot(left, true), dr = asDot(right, false);
    let fl: Rect | null = null, fr: Rect | null = null;
    if (fat) {
      // 四声部页先认这一路：原判据按列量，框连着点顶那截弧脚（29 `1̲̇⌒` 10×14，这一路 10×8），弧脚自己垂下来那一截
      //（93 `1̇⌒1̇` 左脚 6px 宽）也被它当成点切走，留下的弧框缺了这只脚，旁边真高音点头顶的弧脚就被当成了字
      // 这一路切不出时退回原判据的框，但它正下方另有一颗独立的点就不是点（是弧脚，93）；172 第 2 系统 `1̇⌒` 的点横着粘在弧左脚旁、
      // 量不出颈，原判据切得对
      const footOver = (r: Rect | null): Rect | null => r && comps.some((o) => o !== k && o.bbox.w <= numH * 0.45 && o.bbox.h <= numH * 0.45 &&
        Math.abs(rcx(o.bbox) - rcx(r)) <= numH * 0.3 && rcy(o.bbox) > rcy(r) && o.bbox.y - rbottom(r) <= numH * 0.4) ? null : r;
      fl = fatDot(true) ?? footOver(dl); fr = fatDot(false) ?? footOver(dr);
      if (!fl && !fr) { out.push(k); continue; }
      {
        probe("splitArcEndDots.fat");
        const xa = fl ? fl.x - b.x + fl.w : 0, xb = fr ? fr.x - b.x : b.w;
        // 弧框连点头顶那截弧脚一起算（点以上整宽）：不然弧脚落在弧框外，下游量「点上方有没有墨」时把它当成压在点上的字
        const side = tightBox(bin, b, xa, Math.max(xa + 1, xb), 0, b.h);
        const dotTop = Math.min(...[fl, fr].filter((d): d is Rect => d !== null).map((d) => d.y - b.y));
        const cap = dotTop > 0 ? tightBox(bin, b, 0, b.w, 0, dotTop) : null;
        const arcBox = side && cap ? unionRect(side, cap) : side ?? cap;
        // 点的面积按实际墨数：按内部像素数算填充率偏低，上宽下窄的半个圆点会被当成顿音的倒三角（172 第 3 系统男高音 `1̇`）
        const mkDot = (r: Rect): Component => ({ id: nextId++, bbox: r, area: Math.round(inkFill(bin, r) * r.w * r.h), cx: rcx(r), cy: rcy(r) });
        if (arcBox) { out.push(mk(arcBox), ...[fl, fr].filter((d): d is Rect => d !== null).map(mkDot)); continue; }
      }
    }
    if (!dl && !dr) { out.push(k); continue; }
    const arcBox = tightBox(bin, b, dl ? left![1] : 0, dr ? right![0] : b.w, 0, b.h);
    if (!arcBox) { out.push(k); continue; }
    const dots = [dl, dr].filter((d): d is Rect => d !== null);
    probe("splitArcEndDots");
    out.push(mk(arcBox), ...dots.map(mk));
  }
  return out;
}

/** 高八度点**溶在弧块中间**：1850《最难的事主已做成》`6 1̇ 1̇` 上一条外弧罩三音、底下 `6⌒1̇`、`1̇⌒1̇` 两条内弧
 *  首尾相接——交脚正压在第一个 1̇ 的点上，外弧与右内弧的右脚又一起落在第二个 1̇ 的点上，两个点和三条弧是一个块。
 *  splitArcEndDots 只从块的两头往里找，中间那个点够不着；右端那个也过不了它「点比弧低」一关（外弧左脚比点还低 1px）。
 *  这里逐列看**最低那一段墨**的长度：弧线（含两条内弧的交脚，1863 实测 2~4px）只有笔画粗细，点那几列是实心一整段
 *  （1850 实测 6~7px、笔画 2~3px）。连续几列都厚过 2.2 倍笔画、宽像个点、切出来的框够圆够实，就把这几列最低那段
 *  另收成一个点；弧块原样保留（点挖不出来，弧的包围盒不动，detectSlurs 照旧用它）。只在干净谱面上用（同上）。 */
export function splitArcInnerDots(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 2_500_000;
  for (const k of comps) {
    out.push(k);
    const b = k.bbox;
    if (b.w < numH * 1.2 || b.h < numH * 0.25 || b.h > numH * 0.9 || b.w < b.h * 2) continue;
    // 得是**拱起来**的弧块：上缘两头都比最高处低 0.3 字号以上。减时线下沿挂着低八度点的块也又宽又扁，
    // 上缘却是平的（1801 `7̣` 的点被这样切出一个重复的来，高低点相消）。
    const topAt = (x: number) => { let y = b.y; while (y < b.y + b.h && !bin.data[y * bin.w + x]) y++; return y; };
    const peakY = Math.min(...Array.from({ length: b.w }, (_, i) => topAt(b.x + i)));
    const edge = Math.max(2, Math.round(numH * 0.1));
    if (topAt(b.x + edge) - peakY < numH * 0.3 || topAt(b.x + b.w - 1 - edge) - peakY < numH * 0.3) continue;
    // 每列最低那一段墨 [top, bottom]（没墨为 null）
    const low: Array<[number, number] | null> = [];
    const runs: number[] = [];
    for (let x = b.x; x < b.x + b.w; x++) {
      let y = b.y + b.h - 1;
      while (y >= b.y && !bin.data[y * bin.w + x]) y--;
      if (y < b.y) { low.push(null); continue; }
      const bot = y;
      while (y >= b.y && bin.data[y * bin.w + x]) y--;
      low.push([y + 1, bot]);
      runs.push(bot - y);
    }
    const stroke = median(runs) || 1;
    if (stroke > numH * 0.12) continue;                                   // 笔画本身就粗：不是细弧
    // 门槛 1.8 倍笔画（splitArcEndDots 是 2.2）：1850 的点 7×6、弧笔画 3px，最厚才 2 倍。交脚那几列只有笔画的
    // 一两倍，再有下面「够圆、够实、两侧不比它低」三道兜着。
    const thick = Math.max(stroke * 1.8, numH * 0.15);
    const len = (i: number) => (low[i] ? low[i]![1] - low[i]![0] + 1 : 0);
    for (let i = 0; i < b.w; ) {
      if (len(i) < stroke * 1.6) { i++; continue; }
      const s = i;
      let peak = 0;
      while (i < b.w && len(i) >= stroke * 1.6) { peak = Math.max(peak, len(i)); i++; }
      const w = i - s;
      if (peak < thick || w < numH * 0.12 || w > numH * 0.45) continue;
      let y0 = Infinity, y1 = -1;
      for (let j = s; j < i; j++) { y0 = Math.min(y0, low[j]![0]); y1 = Math.max(y1, low[j]![1]); }
      const d: Rect = { x: b.x + s, y: y0, w, h: y1 - y0 + 1 };
      const ratio = d.w / d.h;
      if (d.h > numH * 0.45 || d.h < numH * 0.12 || ratio < 0.5 || ratio > 1.7 || inkFill(bin, d) < 0.6) continue;
      // 点挂在弧的**下沿**：两侧紧邻（0.3 字号内）那几列最低墨点都不比它低——否则是弧的一只脚上凑出来的厚块
      const side = Math.round(numH * 0.3);
      let lower = false;
      for (let j = Math.max(0, s - side); j < Math.min(b.w, i + side); j++) {
        if ((j < s || j >= i) && low[j] && low[j]![1] > y1 + 1) lower = true;
      }
      if (lower) continue;
      probe("splitArcInnerDots");
      out.push({ id: nextId++, bbox: d, area: Math.round(inkFill(bin, d) * d.w * d.h), cx: rcx(d), cy: rcy(d) });
    }
  }
  return out;
}

/** 小号波音**压在高八度点上**：2038《谁一直在街上呼喊》`2̇` 头上的 ∿ 与点 4-连通成 24×24 一块（字号 49）——
 *  宽过点（0.45 字号）、矮过数字块（0.55 字号），classify 哪一档都不收，点和波音一起丢了。
 *  splitOrnamentDot 管的是大号记号（主体宽 ≥0.7 字号），这块的记号只有 0.5 字号宽，够不着。
 *  这里在归类前拆：自下而上逐行量墨宽，底下一段窄行（≤0.35 字号）是点，其上紧接明显更宽（≥1.3 倍点宽）、
 *  矮（0.1~0.3 字号）的一截是记号。两截各收成一块：点照常进点池，记号交给后面的波音判据（锯齿形）裁决。 */
export function splitMordentDot(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 2_700_000;
  const mk = (r: Rect): Component => ({ id: nextId++, bbox: r, area: r.w * r.h, cx: rcx(r), cy: rcy(r) });
  for (const k of comps) {
    const b = k.bbox;
    if (b.w < numH * 0.3 || b.w > numH * 0.6 || b.h < numH * 0.35 || b.h > numH * 0.65) { out.push(k); continue; }
    const span = (y: number) => {
      let lo = -1, hi = -1;
      for (let x = 0; x < b.w; x++) if (bin.data[(b.y + y) * bin.w + b.x + x]) { if (lo < 0) lo = x; hi = x; }
      return lo < 0 ? 0 : hi - lo + 1;
    };
    const spans = Array.from({ length: b.h }, (_, y) => span(y));
    let y = b.h - 1;
    while (y >= 0 && spans[y] > 0 && spans[y] <= numH * 0.35) y--;
    const dotH = b.h - 1 - y;
    const dot = dotH > 0 ? tightBox(bin, b, 0, b.w, y + 1, b.h) : null;
    const top = y >= 0 ? tightBox(bin, b, 0, b.w, 0, y + 1) : null;
    if (!dot || !top || dotH < numH * 0.15 || dot.w / dot.h < 0.6 || dot.w / dot.h > 1.7 ||
        top.w < dot.w * 1.3 || top.h < numH * 0.1 || top.h > numH * 0.3) { out.push(k); continue; }
    probe("splitMordentDot");
    out.push(mk(top), mk(dot));
  }
  return out;
}

/** 增时线贴着数字：密排的四声部页上 `5–––` 的线头顶到数字、`3–0` 三样连成一串（新编赞美诗·四声部 f13《赐下真光》
 *  整页如此：43×38、72×38 的块当成一个数字读，线全丢，一首漏 29 道增时线）。
 *  判据：块高是一个数字（0.8~1.3 字号）、宽过一个数字（≥1 字号）；逐列量，**线列**是墨只占薄薄一段（≤max(3, 0.22 字号)）、
 *  且在块的中段（0.2~0.85 块高：f13 的线印得偏低，线底在 0.78）的列，连着 ≥0.25 字号宽算一道线；其余的列段得有够高的墨（≥0.6 块高）才算数字。
 *  至少各有一段才拆。数字自己的横笔不在中段（7、5 的顶横、2 的底横），4 的横笔探出竖笔不到 0.25 字号。 */
export function splitDigitDash(bin: Binary, comps: Component[], numH: number): Component[] {
  const out: Component[] = [];
  let nextId = 9_000_000;
  const thin = Math.max(3, numH * 0.22), minRun = numH * 0.25;
  for (const k of comps) {
    const b = k.bbox;
    if (b.h < numH * 0.8 || b.h > numH * 1.3 || b.w < numH || b.w > numH * 5) { out.push(k); continue; }
    const kind: number[] = [];   // 0 空、1 线列、2 别的
    const colH: number[] = [];
    for (let xx = 0; xx < b.w; xx++) {
      let top = -1, bot = -1;
      for (let yy = 0; yy < b.h; yy++) if (bin.data[(b.y + yy) * bin.w + b.x + xx]) { if (top < 0) top = yy; bot = yy; }
      const h = top < 0 ? 0 : bot - top + 1;
      colH.push(h);
      kind.push(top < 0 ? 0 : h <= thin && top >= b.h * 0.2 && bot <= b.h * 0.85 ? 1 : 2);
    }
    // 按类分段；不够长的线段并回数字（数字笔画的尖端也只有薄薄一段）
    const segs: { x0: number; x1: number; dash: boolean }[] = [];
    for (let xx = 0; xx < b.w;) {
      if (!kind[xx]) { xx++; continue; }
      const kd = kind[xx]!; let e = xx;
      while (e + 1 < b.w && kind[e + 1] === kd) e++;
      const dash = kd === 1 && e - xx + 1 >= minRun;
      const last = segs[segs.length - 1];
      if (!dash && last && !last.dash && last.x1 === xx) last.x1 = e + 1;
      else segs.push({ x0: xx, x1: e + 1, dash });
      xx = e + 1;
    }
    const digits = segs.filter((g) => !g.dash);
    const okDigits = digits.length > 0 && digits.every((g) => {
      let mx = 0;
      for (let xx = g.x0; xx < g.x1; xx++) mx = Math.max(mx, colH[xx]!);
      return mx >= b.h * 0.6 && g.x1 - g.x0 <= numH * 1.1;
    });
    if (!segs.some((g) => g.dash) || !okDigits) { out.push(k); continue; }
    // 线相对数字的纵向位置：增时线画在数字身上（线心在相邻数字自身高度的 0.25~0.88 之间），减时线在数字底边以下。
    // 两个八分音符坐在同一条减时线上、线下还挂着低音点的块（338 弱起 `3̲̣4̲̣`），数字之间那截减时线在整块的 0.8 处，光看块高分不开。
    const boxes = segs.map((g) => tightBox(bin, b, g.x0, g.x1, 0, b.h));
    const onBody = segs.every((g, i) => {
      if (!g.dash) return true;
      const db = boxes[i];
      const nb = [boxes[i - 1], boxes[i + 1]].filter((r, j) => r && !segs[i + (j ? 1 : -1)]?.dash) as Rect[];
      return !!db && nb.length > 0 && nb.every((r) => rcy(db) >= r.y + r.h * 0.25 && rcy(db) <= r.y + r.h * 0.88);
    });
    if (!onBody) { probe("splitDigitDash.offBody"); out.push(k); continue; }
    // 歌词里的「十」也是一根细竖两边各伸一道横（338：44×43 拆成线 + 「1」 + 线，凭空多出伪数字、字号估计跟着变）：
    // 窄段（<0.3 字号）两侧都是线的不拆。
    if (segs.some((g, i) => !g.dash && g.x1 - g.x0 < numH * 0.3 && segs[i - 1]?.dash && segs[i + 1]?.dash)) { probe("splitDigitDash.cross"); out.push(k); continue; }
    const parts: Component[] = [];
    for (const g of segs) {
      const r = tightBox(bin, b, g.x0, g.x1, 0, b.h);
      if (!r) continue;
      let area = 0;
      for (let yy = r.y; yy < rbottom(r); yy++) for (let xx = r.x; xx < rright(r); xx++) if (bin.data[yy * bin.w + xx]) area++;
      parts.push({ id: nextId++, bbox: r, area, cx: rcx(r), cy: rcy(r) });
    }
    probe("splitDigitDash");
    out.push(...parts);
  }
  return out;
}

/** 断成几截的横线接回一条。扫描件里一道减时线常被二值化断开一两个像素，断出来的碎段既够不着
 *  classify 里横线的宽度门（w ≥ 0.6 字号），也把长的那截截短——227《施比受更为有福》第 1 行
 *  `3·4` 底下那道共用减时线实测断成 81px + 12px + 18px 三截（缝各 1px），长的那截止步于 "4" 的
 *  左缘、与 "4" 只重叠 6px，过不了「横线要盖住数字四成宽」那条，两截碎的又都进不了 hlines，
 *  于是 "4" 一条减时线都没剩下，那一拍的时值凭空翻倍。
 *  只接**同一水平线上、缝隙一两像素**的扁块：真正分开的两道增时线 `- -` 之间隔着大半个字号，
 *  上下堆叠的两条减时线纵向不重叠，都够不着这个门。 */
export function mergeBrokenHlines(comps: Component[], numH: number): Component[] {
  const flat = (k: Component) => k.bbox.h <= Math.max(3, numH * 0.32) && k.bbox.w >= k.bbox.h * 2;
  const gapMax = Math.max(2, numH * 0.06);
  const rest = comps.filter((k) => !flat(k));
  const line = comps.filter(flat).sort((a, b) => a.bbox.x - b.bbox.x);
  const yTol = Math.max(2, numH * 0.06);
  const out: Component[] = [];
  for (const k of line) {
    // 往回找**同一条线**上的那一截：不能只跟紧挨着的上一个比——同一道减时线的第二层就夹在
    // 按 x 排的序列中间（227 那处的四截是 x784/866/874/879，其中 874 是下面一层），
    // 只比上一个的话第三截就接不回去了。纵向要真的挨着（上下缘各差不过一条线的厚度）。
    let host: Component | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i];
      if (k.bbox.x - rright(p.bbox) > gapMax) continue;
      if (k.bbox.x < p.bbox.x) continue;
      if (Math.abs(k.bbox.y - p.bbox.y) > yTol || Math.abs(rbottom(k.bbox) - rbottom(p.bbox)) > yTol) continue;
      // **两截里至少有一截短得不成线**（够不着 classify 里横线的 0.6 字号宽度门）。接的是二值化
      // 掉出来的碎渣，不是把两道真横线并成一道：为基督赢得城市第 1 行 `3 - - 0` 的两道增时线
      // 印得几乎挨上（缝隙不到 2px），少了这一条就并成一道、那个音少掉一拍。
      if (Math.min(k.bbox.w, p.bbox.w) >= numH * 0.6) continue;
      host = p; break;
    }
    if (host) {
      const bb = unionRect(host.bbox, k.bbox);
      probe("mergeBrokenHlines");
      out[out.indexOf(host)] = { id: host.id, bbox: bb, area: host.area + k.area, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2 };
      continue;
    }
    out.push(k);
  }
  return [...rest, ...out];
}
