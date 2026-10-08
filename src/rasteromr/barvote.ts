// 位图五线谱的**系统线与小节线**：同系统各行小节线同 x 投票、贯穿谱表的墨验、复纵线、淡线补断口、按坐标造小节线。
import type { Binary } from "../omrkit/types";
import { systemGroups } from "../staffomr/page";
import type { Seg, SPage, Staff } from "../staffomr/model";
import { makeSysBracketObj, pushSeg } from "./adapt";
import { type LineSeg } from "./prims";
import { type RasterUnit } from "./staffline";

/** 双小节线：小节线两侧这么多格以内另有一根贯通谱表的竖墨。 */
const DOUBLE_BAR_REACH = 1.0;

/** 小节线 x 处是不是双线；是的话返回右边那根的右缘，不是返回 null。在原图上逐列量贯通五线的竖墨。 */
export function doubleBarRight(bin: Binary, lineYs: number[], x: number, sp: number): number | null {
  const y0 = Math.round(lineYs[0]);
  const y1 = Math.round(lineYs[lineYs.length - 1]);
  const full = (cx: number) => {
    if (cx < 1 || cx + 1 >= bin.w) return false;
    let n = 0;
    for (let y = y0; y <= y1; y++) if (bin.data[y * bin.w + cx] || bin.data[y * bin.w + cx - 1] || bin.data[y * bin.w + cx + 1]) n++;
    return n >= (y1 - y0 + 1) * 0.9;
  };
  const runs: [number, number][] = [];
  for (let cx = Math.round(x - sp * DOUBLE_BAR_REACH); cx <= Math.round(x + sp * DOUBLE_BAR_REACH); cx++) {
    if (!full(cx)) continue;
    const last = runs[runs.length - 1];
    if (last && cx - last[1] <= 1) last[1] = cx;
    else runs.push([cx, cx]);
  }
  return runs.length >= 2 ? runs[runs.length - 1][1] : null;
}

/**
 * **谱行左端量进了系统线、括号里的**：粗的方括号加系统线有一格多宽，谱线找出来的左端落在括号左缘，
 * 「离左端几格」的取墨窗口就罩在括号的竖线上，行行有墨（烛光颂曲 p6 男声行的低音谱号被按墨改成高音）。
 * 系统线与谱号中间那道直笔的分别是**伸出谱表多远**：系统线连着上一行或下一行谱，谱号的直笔上下各只探出一格半。
 * 左端往右四格以内，谱表这一段七成半是墨、且顶线上方一到三格或底线下方一到三格也七成半是墨的列是系统线；
 * 最右那一列离左端过半格的，窗口改从它算起。贴着左端的那一根（正常情形）不动，免得窗口整体右移。
 */
export function pastSysLine(bin: Binary, lineYs: number[], left: number, sp: number): number {
  const top = lineYs[0];
  const bottom = lineYs[lineYs.length - 1];
  const full = (x: number, ya: number, yb: number) => {
    let n = 0;
    let tot = 0;
    for (let y = Math.round(ya); y <= Math.round(yb); y++) {
      if (y < 0 || y >= bin.h) continue;
      tot++;
      if (bin.data[y * bin.w + x] || bin.data[y * bin.w + x - 1] || bin.data[y * bin.w + x + 1]) n++;
    }
    return tot > 0 && n >= tot * 0.75;
  };
  let last = -1;
  for (let x = Math.round(left); x <= Math.min(bin.w - 2, Math.round(left + sp * 4)); x++)
    if (full(x, top, bottom) && (full(x, top - sp * 3, top - sp) || full(x, bottom + sp, bottom + sp * 3))) last = x;
  return last > left + sp * 0.5 ? last : left;
}

/** 系统线断开处算「还连着」的墨占比（见 `bridgeFaintSysLines`）。 */
const SYS_LINE_INK = 0.5;

/** 系统线断开处，一列里最长的空白不到这么多格才算虚线（括号钩之间的白有一格半）。 */
const SYS_LINE_GAP = 0.8;

/** 两个系统左端差在这么多格以内，才在两个左端之间整段找那条线。 */
const SYS_LINE_DX = 6;

/**
 * **系统线淡得断成虚线的系统并回去**：系统由谱行左端那条竖线（或括号）串起来；扫描件上人声方括号与
 * 钢琴大谱表之间那一截细线常断成虚线，抽不成竖段，一个系统裂成两三个（烛光颂曲 p3 七行裂成 5 + 2、
 * p6 四行裂成 2 + 2、p7 裂成 4 + 1 + 1）。
 * 直接在原图上量：相邻两个系统之间，上面那个系统谱行左端一格以内，找墨最满的一列（左右各容一像素），
 * 这一截里有墨的行过 `SYS_LINE_INK` 的就是系统线还连着——真正的系统间隔那一列是白的
 *（六首合唱谱实测 0.03~0.34，断开的 0.77~0.99）。连着的几个系统补一个罩住它们的系统括号。
 */
export function bridgeFaintSysLines(pg: SPage, bin: Binary, sp: number): void {
  const groups = systemGroups(pg);
  const linked = (a: Staff, b: Staff) => {
    const y0 = Math.round(a.box.bottom + sp * 0.5);
    const y1 = Math.round(b.box.top - sp * 0.5);
    if (y1 - y0 < sp * 2) return false;
    const ink = (x: number, y: number) => x >= 0 && x < bin.w && bin.data[y * bin.w + x] === 1;
    // 下面那行的左端量短了（淡得只剩后半截）时，线在两行左端之间的某一列；差得太远的是缩进不同的两个系统，只看上面那行的
    const near = Math.abs(a.box.left - b.box.left) <= sp * SYS_LINE_DX;
    const xa = near ? Math.min(a.box.left, b.box.left) : a.box.left;
    const xb = near ? Math.max(a.box.left, b.box.left) : a.box.left;
    // 墨过半之外，这一列里**最长的一段空白**还要不到 `SYS_LINE_GAP` 格：两个系统挨得近时，上一个括号的下钩、下一个括号
    // 往上伸出的一截把间隔两头填满，墨量过半（新编赞美诗 367 第 2、3 系统，0.57），中间却隔着一格半的白；虚线的断口都短
    for (let x = Math.round(xa - sp); x <= Math.round(xb + sp); x++) {
      let n = 0, gap = 0, maxGap = 0;
      for (let y = y0; y <= y1; y++) {
        if (ink(x, y) || ink(x - 1, y) || ink(x + 1, y)) (n++, (gap = 0));
        else maxGap = Math.max(maxGap, ++gap);
      }
      if (n / (y1 - y0 + 1) >= SYS_LINE_INK && maxGap < sp * SYS_LINE_GAP) return true;
    }
    return false;
  };
  let run: Staff[][] = [];
  const flush = () => {
    if (run.length > 1) {
      const sts = run.flat();
      const top = Math.min(...sts.map((s) => s.box.top));
      const bottom = Math.max(...sts.map((s) => s.box.bottom));
      const left = Math.min(...sts.map((s) => s.box.left));
      pg.objs.push(makeSysBracketObj(pg.objs.length + pg.segs.length + 1, { x: left - sp, y: top, w: sp * 0.5, h: bottom - top }));
    }
    run = [];
  };
  for (const g of groups) {
    const prev = run[run.length - 1];
    if (prev && !linked(prev[prev.length - 1], g[0])) flush();
    run.push(g);
  }
  flush();
}

/**
 * **多行系统里一行有小节线、另一行同处没抽出竖段的，回原图上验墨补一根**（在 `tagSystemBarlines` 之前）。
 *
 * 粗一点、略斜的小节线过不了竖段抽取（新编赞美诗 12 颂主化功歌第一行高音谱表 x≈499：五像素宽、
 * 自上而下往左漂两像素，一段都没抽出来），那一行就少一条小节线，与另一行错开。
 * 以另一行「两端压在外线上的竖段」的 x 为准，在这一行左右 0.6 格内找一列：从第五线到第一线几乎不断墨
 *（逐行可左右挪一列，总共漂不过 0.15 格）、是根细线、且上下都不伸出谱表（伸出去的是符干）。
 * 作准的那一根自己也要过同一道验墨；各行都验到才补。
 */
export function inkSystemBarlines(pg: SPage, bin: Binary, sp: number): void {
  const tol = sp * 0.3;
  const xTol = sp * 0.6;
  const barAt = makeBarAt(bin, sp);
  for (const g of systemGroups(pg)) {
    if (g.length < 2) continue;
    const lands = (y: number) => g.some((st) => Math.abs(y - st.box.top) <= tol || Math.abs(y - st.box.bottom) <= tol);
    const barOn = (l: Seg, st: Staff) =>
      l.isV && (!l.hasAnyTag() || l.hasTag("BarLine")) && l.top <= st.box.top + tol && l.bottom >= st.box.bottom - tol && lands(l.top) && lands(l.bottom) && Math.abs(st.box.left - l.cx) >= sp;
    for (const a of g)
      for (const l of pg.segs.filter((q) => barOn(q, a))) {
        const lack = g.filter((b) => b !== a && !pg.segs.some((m) => barOn(m, b) && Math.abs(m.cx - l.cx) <= xTol));
        if (!lack.length) continue;
        // 作准的那一根自己也得过验墨：被谱线切出来、恰好两端压在外线上的一截符干不算
        if (barAt(a, l.cx, 2) === null) continue;
        const xs = lack.map((b) => barAt(b, l.cx, Math.round(xTol)));
        if (xs.some((x) => x === null)) continue;
        lack.forEach((b, i) => {
          const x = xs[i]!;
          pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: x, y0: b.box.top, x1: x, y1: b.box.bottom, lw: l.lw, maxLw: l.lw });
        });
      }
    // **各行都没抽出竖段的小节线**：淡印的页上下两行同时漏（助我进深歌每个系统漏一两条，上面那一趟要有一行抽得出才补得了）。
    // 沿头一行逐列验墨，过了的再到别的行左右 `xTol` 内验；行行都是「盖满谱行的细线、上下不外伸」才补，
    // 离已有的小节线、系统线一格以内的不重复补。两行的干同时正好盖满各自的谱行、又同 x，几乎碰不上。
    const have = (st: Staff, x: number) => pg.segs.some((m) => barOn(m, st) && Math.abs(m.cx - x) <= sp);
    const first = g[0];
    for (let x = Math.round(first.box.left + sp * 3); x < first.box.right - sp; x++) {
      if (have(first, x) || barAt(first, x, 0, true) === null) continue;
      const xs = g.slice(1).map((b) => barAt(b, x, Math.round(xTol), true));
      if (xs.some((q) => q === null)) continue;
      if (g.slice(1).some((b, i) => have(b, xs[i]!))) continue;
      const lw = Math.max(1, first.lines[0]?.lw ?? 1);
      pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: x, y0: first.box.top, x1: x, y1: first.box.bottom, lw, maxLw: lw });
      g.slice(1).forEach((b, i) => pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: xs[i]!, y0: b.box.top, x1: xs[i]!, y1: b.box.bottom, lw, maxLw: lw }));
      x += Math.round(sp);
    }
  }
}

/**
 * **多行系统里只在一行上有的小节线，别的行同处原图上也没有竖墨，就不是小节线**（在 `findBarlines` 之后）。
 *
 * `findBarlines` 那道「别的行同 x 有像样的竖线才留」放得松（别的行那一根挂成符干的也算，扫描件上真小节线断得多），
 * 钢琴右手和弦的长干正好盖满谱行、左手同处又有一根别的干时照样留下（是爱 p5 首行钢琴右手多切一刀，
 * 左手没切，两行从此错开一小节）。这里回原图上验：别的每一行在同 x 左右 0.6 格内都找不到一根贯穿谱行的细竖墨
 *（不管上下伸不伸出去——大谱表的小节线本来就连着上下两行），才摘掉。
 */
export function dropLoneBarlines(pg: SPage, bin: Binary, sp: number): void {
  const xTol = sp * 0.6;
  const barAt = makeBarAt(bin, sp);
  for (const g of systemGroups(pg)) {
    if (g.length < 2) continue;
    const on = (l: Seg, st: Staff) => l.bottom > st.box.top + sp && l.top < st.box.bottom - sp;
    const bars = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && g.some((st) => on(l, st)));
    for (const l of bars) {
      const own = g.filter((st) => on(l, st));
      const others = g.filter((st) => !own.includes(st));
      if (!others.length) continue;
      // 行末的小节线不查：各行右端参差，别的行的那一根常被当成谱行右界、没进竖段
      if (own.some((st) => l.cx > st.box.right - sp * 1.5)) continue;
      const backed = others.some((st) => bars.some((m) => m !== l && on(m, st) && Math.abs(m.cx - l.cx) <= xTol) || barAt(st, l.cx, Math.round(xTol), false, true) !== null);
      if (!backed) l.removeTag("BarLine");
    }
  }
}

/**
 * **贯穿上下两行谱的小节线，在两行之间断成两截的接回一根**（建页之前）。
 *
 * 大谱表的小节线从上一行的顶线一直画到下一行的底线。竖段抽取在两行之间那一截常抽不出来
 *（旁边贴着反复记号的粗线，孤立性过不了：爱是从神而来首行 `|:` 的细线只剩压在两行谱上的两截），
 * 剩下的两截各自伸出谱表三四分之一格、又不落在任何一行的外线上，`findBarlines` 当它是符干，这一处的小节线就丢了。
 * 两截各盖满一行谱（两端离外线不过 `THROUGH_END` 格）、同 x、中间那一段原图上**每行都有墨**，就是同一根。
 */
export function joinThroughBars(bin: Binary, segs: LineSeg[], staves: [number, number][], sp: number): LineSeg[] {
  const top = (v: LineSeg) => Math.min(v.y0, v.y1);
  const bot = (v: LineSeg) => Math.max(v.y0, v.y1);
  const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
  const tol = sp * THROUGH_END;
  /** 这一截盖满第几行谱（没有返回 -1） */
  const coverOf = (v: LineSeg) => staves.findIndex(([a, b]) => Math.abs(top(v) - a) <= tol && Math.abs(bot(v) - b) <= tol);
  const rows = [...staves].sort((a, b) => a[0] - b[0]);
  const cand = segs.filter((v) => bot(v) - top(v) > Math.abs(v.x1 - v.x0) && coverOf(v) >= 0).sort((a, b) => top(a) - top(b));
  const used = new Set<LineSeg>();
  const out: LineSeg[] = [];
  for (const a of cand) {
    if (used.has(a)) continue;
    let cur = a;
    for (let again = true; again; ) {
      again = false;
      for (const b of cand) {
        if (b === a || used.has(b) || top(b) <= bot(cur) || Math.abs(cx(b) - cx(cur)) > sp * 0.2) continue;
        // 中间不能隔着别的谱行
        if (rows.some(([ra, rb]) => ra > bot(cur) + tol && rb < top(b) - tol)) continue;
        const x = Math.round((cx(b) + cx(cur)) / 2);
        let solid = true;
        for (let y = Math.ceil(bot(cur)); y <= Math.floor(top(b)) && solid; y++) {
          const row = y * bin.w;
          solid = !!(bin.data[row + x] || bin.data[row + x - 1] || bin.data[row + x + 1]);
        }
        if (!solid) continue;
        const la = bot(cur) - top(cur);
        const lb = bot(b) - top(b);
        const xm = (cx(cur) * la + cx(b) * lb) / (la + lb);
        cur = { x0: xm, x1: xm, y0: top(cur), y1: bot(b), lw: (cur.lw * la + b.lw * lb) / (la + lb), maxLw: Math.max(cur.maxLw, b.maxLw) };
        used.add(b);
        again = true;
        break;
      }
    }
    if (cur !== a) (used.add(a), out.push(cur));
  }
  // **盖满两行以上谱的竖线，伸出去的那一截剪掉**：小节线上端接着反复房号括线的竖钩（是爱 p5 钢琴两行「1.」起处，
  // 竖钩从顶线上方三格起、与小节线同 x 连成一根），上端不落在任何一行的外线上，被当成符干。
  // 符干不会把上下两行谱都盖满；剪到所盖各行最外的两条线上，就是一根正经的贯穿小节线。
  const clip = (v: LineSeg): LineSeg => {
    if (bot(v) - top(v) <= Math.abs(v.x1 - v.x0)) return v;
    const cov = rows.filter(([ra, rb]) => top(v) <= ra + sp * 0.3 && bot(v) >= rb - sp * 0.3);
    if (cov.length < 2) return v;
    const ya = cov[0][0];
    const yb = cov[cov.length - 1][1];
    if (top(v) >= ya - sp * 0.3 && bot(v) <= yb + sp * 0.3) return v;
    return { ...v, y0: Math.max(top(v), ya), y1: Math.min(bot(v), yb) };
  };
  return [...segs.filter((v) => !used.has(v)), ...out].map(clip);
}

/**
 * **三行以上的系统，小节线按行数表决**（在 `findBarlines` 之后）。同一系统各行的小节线同 x，这是版式的铁律；
 * 低分辨率的合唱扫描件上每行各错各的——这一行漏一根（线断了、被符头压着），那一行多一根（调号降号的竖笔、
 * 贴着小节线的升降号被收成小节线），七行里各行的小节数是 4/4/5/5/5/5/4（烛光颂曲 p2），逐行对不上。
 * 把各行的小节线按 x 归簇（0.6 格内）：
 *   - **过半的行都有**的簇，缺的行照簇的中位 x 补一根（不再验墨：别的行已经作了证）；
 *   - **只有不到三分之一的行有**、别的行原图上同处也没有贯穿谱行的细竖墨的簇，摘掉。
 * 两行的系统不走这里（两行各执一词时没有多数，交给验墨的那两道）。
 */
export function voteSystemBarlines(pg: SPage, bin: Binary, sp: number): void {
  const xTol = sp * 0.6;
  const barAt = makeBarAt(bin, sp);
  for (const g of systemGroups(pg)) {
    if (g.length < 3) continue;
    const on = (l: Seg, st: Staff) => l.bottom > st.box.top + sp && l.top < st.box.bottom - sp;
    const bars = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && g.some((st) => on(l, st))).sort((a, b) => a.cx - b.cx);
    // 归簇：与簇里最后一根相距不过 xTol
    const clusters: Seg[][] = [];
    for (const l of bars) {
      const c = clusters[clusters.length - 1];
      if (c && l.cx - c[c.length - 1].cx <= xTol) c.push(l);
      else clusters.push([l]);
    }
    for (const c of clusters) {
      const rows = g.filter((st) => c.some((l) => on(l, st)));
      const xs = c.map((l) => l.cx).sort((a, b) => a - b);
      const x = xs[xs.length >> 1];
      if (rows.length * 2 > g.length) {
        const lw = Math.max(1, c[0].lw);
        for (const st of g) {
          if (rows.includes(st)) continue;
          // 行末那一根各行右端参差，离本行右端一格半以内的不补（本行的右界就是它）
          if (x > st.box.right - sp * 1.5 || x < st.box.left + sp) continue;
          pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: x, y0: st.box.top, x1: x, y1: st.box.bottom, lw, maxLw: lw }).addTag("BarLine");
        }
      } else if (rows.length * 3 <= g.length) {
        const others = g.filter((st) => !rows.includes(st));
        const backed = others.filter((st) => barAt(st, x, Math.round(xTol), false, true) !== null).length;
        if (backed + rows.length <= g.length / 3) for (const l of c) l.removeTag("BarLine");
      }
    }
  }
}

/** 原图上验「这一行在某个 x 附近有没有一根小节线模样的竖墨」（`inkSystemBarlines` / `dropLoneBarlines` 共用）。 */
function makeBarAt(bin: Binary, sp: number): (st: Staff, cx: number, range: number, strict?: boolean, through?: boolean) => number | null {
  const ink = (x: number, y: number) => x >= 0 && x < bin.w && y >= 0 && y < bin.h && bin.data[y * bin.w + x] === 1;
  /** 这一行里含 x 的那段横向连续墨的宽度 */
  const runW = (x: number, y: number) => {
    let a = x;
    let b = x;
    while (ink(a - 1, y)) a--;
    while (ink(b + 1, y)) b++;
    return b - a + 1;
  };
  /**
   * 从 (x0, y0) 往下走到 y1（逐行可左右挪一列，总共漂不过 0.15 格）。返回断墨的行数、最长一段断口、
   * 横向墨宽过 0.4 格的行数（穿过符头、升号横杠、谱线的那些行）与走过的列范围。
   */
  const walk = (x0: number, y0: number, y1: number) => {
    let x = x0;
    let miss = 0;
    let run = 0;
    let worst = 0;
    let wide = 0;
    let lo = x0;
    let hi = x0;
    for (let y = y0; y <= y1; y++) {
      if (ink(x, y)) run = 0;
      else if (ink(x - 1, y)) (x--, (run = 0));
      else if (ink(x + 1, y)) (x++, (run = 0));
      else {
        miss++;
        worst = Math.max(worst, ++run);
        continue;
      }
      if (Math.abs(x - x0) > sp * 0.15) return null;
      if (runW(x, y) > sp * 0.4) wide++;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return { miss, worst, wide, lo, hi };
  };
  /** [y0, y1] 这几行里，[xa, xb] 左右各一列内有墨的行占比 */
  const inked = (xa: number, xb: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      let any = false;
      for (let x = xa - 1; x <= xb + 1 && !any; x++) any = ink(x, y);
      if (any) n++;
    }
    return n / Math.max(1, y1 - y0 + 1);
  };
  /** st 这一行在 cx 左右 range 像素内有没有一根小节线模样的竖墨；有则返回它的列。`through`：不查上下伸不伸出谱表 */
  return (st: Staff, cx: number, range: number, strict = false, through = false): number | null => {
    const top = Math.round(st.box.top);
    const bottom = Math.round(st.box.bottom);
    const rows = bottom - top + 1;
    for (let d = 0; d <= range; d++)
      for (const x of d ? [Math.round(cx) - d, Math.round(cx) + d] : [Math.round(cx)]) {
        const w = walk(x, top, bottom);
        if (!w || w.miss > rows * 0.06 || w.worst > 2) continue;
        // 细线：除去五条谱线那几行，横向墨宽的行不能多（贴着符头、穿过升号的竖笔过不了）
        if (w.wide > rows * 0.3) continue;
        // 没有竖段作证的那一趟从严：谱线以外的行，横向墨宽的不过两行——贴着符头的干（头占一格高）过不了
        //（父恩广大、我愿象主歌各多切一刀）
        if (strict) {
          let fat = 0;
          for (let y = top; y <= bottom; y++) {
            if (st.lineYs.some((ly) => Math.abs(ly - y) <= sp * 0.15)) continue;
            const xx = [x, x - 1, x + 1, x - 2, x + 2].find((q) => ink(q, y));
            if (xx !== undefined && runW(xx, y) > sp * 0.4) fat++;
          }
          if (fat > 2) continue;
        }
        // 上下各往外 0.4~0.9 格那一截不能有墨（符干、连谱号、系统线都会伸出去）
        if (!through && inked(w.lo, w.hi, Math.round(top - sp * 0.9), Math.round(top - sp * 0.4)) > 0.3) continue;
        if (!through && inked(w.lo, w.hi, Math.round(bottom + sp * 0.4), Math.round(bottom + sp * 0.9)) > 0.3) continue;
        return x;
      }
    return null;
  };
}

/** 贯穿小节线断成的两截：各自两端离所在谱行的外线不过几格（见 `joinThroughBars`）。 */
const THROUGH_END = 0.6;

/** 断开的小节线：竖段至少盖住谱表高的几成、缺口处有几成是「比左右暗」的淡墨才补。 */
const FAINT_BAR_COVER = 0.6;

const FAINT_BAR_FILL = 0.8;

/** 淡墨要比左右 `FAINT_SIDE` 像素外暗过多少灰度。实测断口 170~206、页白 245 上下。 */
const FAINT_DELTA = 25;

const FAINT_SIDE = 4;

/**
 * **细线扫描件回灰度核断开的小节线**（只有 `RasterPage.gray` 的页才走）。
 *
 * 敬拜万世之王的小节线灰度 150~206，松阈值那一档也切不全：第五线到第四线整格没了、
 * 或下端差第一线 0.4 格，`findBarlines` 要两端贴外线（四分之一格）收不下。原图其实是连着的。
 * 整页换二值化试过三种（脊线图并入、只收长游程、只补断口），字的竖笔、弧线端跟着变，
 * 歌词、弧线各掉一两点——所以**先按几何找出疑似断开的那一根，再只看那一列的灰度**：
 * 竖段两端都在谱表内（不探出 0.3 格）、盖住谱表高六成以上，缺口里八成的行比左右暗过 25
 * （或正压在谱线上），就补成纵贯五线的一条。符干碰不上：头那一端缺口是符头的墨，
 * 左右也暗；另一端缺口是白的。
 */
export function bridgeFaintBars(vSegs: LineSeg[], gray: Uint8Array, w: number, staves: number[][], unit: RasterUnit): void {
  const sp = unit.space;
  const lt = Math.max(1, unit.lineThick);
  for (const ys of staves) {
    const top = ys[0];
    const bot = ys[4];
    const onLine = (y: number) => ys.some((ly) => Math.abs(y - ly) <= lt);
    for (let i = 0; i < vSegs.length; i++) {
      const v = vSegs[i];
      const a = Math.min(v.y0, v.y1);
      const b = Math.max(v.y0, v.y1);
      if (a < top - sp * 0.3 || b > bot + sp * 0.3) continue;
      if (b - a < (bot - top) * FAINT_BAR_COVER) continue;
      if (a <= top + sp * 0.25 && b >= bot - sp * 0.25) continue;
      const x = Math.round((v.x0 + v.x1) / 2);
      if (x - FAINT_SIDE - 1 < 0 || x + FAINT_SIDE + 1 >= w) continue;
      const dark = (y: number) => {
        const r = Math.round(y) * w;
        const c = Math.min(gray[r + x - 1], gray[r + x], gray[r + x + 1]);
        const side = Math.min(gray[r + x - FAINT_SIDE - 1], gray[r + x + FAINT_SIDE + 1]);
        return side - c >= FAINT_DELTA;
      };
      let gap = 0;
      let hit = 0;
      for (let y = Math.round(top); y < a; y++) (gap++, (hit += +(onLine(y) || dark(y))));
      for (let y = Math.round(b) + 1; y <= bot; y++) (gap++, (hit += +(onLine(y) || dark(y))));
      if (!gap || hit < gap * FAINT_BAR_FILL) continue;
      vSegs[i] = { ...v, x0: x, x1: x, y0: Math.min(a, top), y1: Math.max(b, bot) };
    }
  }
}
