// 反复记号与房子（位图路）。`makeBars` 之后跑，结果直接写到 `Bar` 上，写出端照旧。
//
// 下游的 `classifyBarlines` 靠「小节线笔画的线宽 + 谱表里成对的圆点符号」认反复，位图路两样都常常缺：
// 粗线那一笔过不了竖段的宽度闸、紧贴着它的细线又过不了孤立性判据，圆点也多半没进形状字典。
// 这里回到图上量：第二、三间各一个圆点、左右对齐，旁边一格内是一细一粗两根贯穿谱表的竖线。
// 一个系统里有一行认出来，同系统各行同 x 的小节线都算（反复、终止线是整个系统一起画的）。
import type { Binary, Rect } from "../omrkit/types";
import { attachVoltas, type Volta } from "../staffomr/octave";
import type { Bar, SPage, Staff } from "../staffomr/model";
import type { ContourMap } from "./contour";

/** 反复点：边长（格）、填充率、点心离间心（格）、两点横向差（格）。 */
const DOT: [number, number] = [0.2, 0.65];
const DOT_FILL = 0.55;
/** 祢話如甘霖的反复点整体偏上（上点离间心 0.34 格），0.3 收不下 */
const DOT_Y = 0.45;
const DOT_X = 0.3;
/** 点到细线、细线到粗线的间隔上限（格）；粗线最窄（格）；竖线贯穿谱表要占的墨比例。 */
const GAP = 1.0;
const PAIR = 1.0;
const THICK = 0.3;
const FULL = 0.9;
/** 认出来的反复线对到小节边界上，容差（格）。 */
const SNAP = 2.2;
/** 房子：横线最短（格）、钩顶离谱表顶线的距离范围（格）、左端竖钩的长度范围（格）、钩对小节线的容差（格）。 */
const VOLTA_LEN = 3;
const VOLTA_RISE: [number, number] = [1.2, 7];
const VOLTA_HOOK: [number, number] = [0.6, 5];
const VOLTA_SNAP = 1.8;
/** 房子横线的厚度上限（格）。 */
const VOLTA_THICK = 0.3;
/** 房号印在横线上、把线断开（钩后一小截、房号、空一段再接长线）：隔着房号往右找接续的长线，起点离钩最远（格）。
 *  祢話如甘霖一房 3.7 格；二房的钩紧挨着一房收尾的钩、两根竖段并成一条，从那里量是 4.6 格 */
const VOLTA_BREAK = 5.5;

interface RepeatMark {
  /** 两个圆点的盒（记账用）。 */
  dots: Rect[];
  staff: Staff;
  /** 细、粗两根线的中点。 */
  x: number;
  dir: "forward" | "backward";
}

/** 图上找反复记号：返回每处的位置与方向。 */
export function findRasterRepeats(pg: SPage, bin: Binary, map: ContourMap, sp: number): RepeatMark[] {
  const out: RepeatMark[] = [];
  const dots = map.contours.filter((c) => c.w >= DOT[0] && c.w <= DOT[1] && c.h >= DOT[0] && c.h <= DOT[1] && c.fill >= DOT_FILL);
  for (const st of pg.staves) {
    if (st.lineYs.length !== 5) continue;
    const upper = dots.filter((d) => d.cx > st.box.left && d.cx < st.box.right + sp && Math.abs(d.cy - spaceY(st, d.cx, 1)) <= sp * DOT_Y);
    const lower = dots.filter((d) => d.cx > st.box.left && d.cx < st.box.right + sp && Math.abs(d.cy - spaceY(st, d.cx, 2)) <= sp * DOT_Y);
    for (const u of upper) {
      const l = lower.find((q) => Math.abs(q.cx - u.cx) <= sp * DOT_X);
      if (!l) continue;
      const ys = st.lineYsAt?.(u.cx) ?? st.lineYs;
      const y0 = Math.round(ys[0]);
      const y1 = Math.round(ys[4]);
      const full = (x: number) => {
        let ink = 0;
        for (let y = y0; y <= y1; y++) if (bin.data[y * bin.w + x]) ink++;
        return ink >= (y1 - y0 + 1) * FULL;
      };
      const left = Math.min(u.bbox.x, l.bbox.x);
      const right = Math.max(u.bbox.x + u.bbox.w, l.bbox.x + l.bbox.w);
      const xa = Math.max(0, Math.round(left - sp * (GAP + PAIR + 1)));
      const xb = Math.min(bin.w - 1, Math.round(right + sp * (GAP + PAIR + 1)));
      const bars: [number, number][] = [];
      for (let x = xa; x <= xb; x++) {
        if (x >= left && x < right) continue;
        if (!full(x)) continue;
        const last = bars[bars.length - 1];
        if (last && last[1] === x - 1) last[1] = x;
        else bars.push([x, x]);
      }
      const thick = (q: [number, number]) => q[1] - q[0] + 1 >= Math.max(2, sp * THICK);
      // 挨着点的那一根是细线，它另一侧紧挨着一根粗线：点在线左是 `:|`，在线右是 `|:`
      for (const side of [-1, 1]) {
        const near = side > 0 ? bars.find((q) => q[0] >= right) : [...bars].reverse().find((q) => q[1] < left);
        if (!near || thick(near)) continue;
        const gap = side > 0 ? near[0] - right : left - near[1];
        if (gap > sp * GAP) continue;
        const other = bars[bars.indexOf(near) + side];
        if (!other || !thick(other)) continue;
        const between = side > 0 ? other[0] - near[1] : near[0] - other[1];
        if (between > sp * PAIR) continue;
        const x = (near[0] + near[1] + other[0] + other[1]) / 4;
        const dir = side > 0 ? "backward" : "forward";
        if (!out.some((m) => m.staff === st && m.dir === dir && Math.abs(m.x - x) < sp)) out.push({ staff: st, x, dir, dots: [u.bbox, l.bbox] });
      }
    }
  }
  return out;
}

/** 第 `i` 间（0 起，自上而下）的间心 y。 */
function spaceY(st: Staff, x: number, i: number): number {
  const ys = st.lineYsAt?.(x) ?? st.lineYs;
  return (ys[i] + ys[i + 1]) / 2;
}

/**
 * 把反复记号、房子落到小节上，并把同系统各行的小节线样式拉齐。
 *
 * @param bin 带谱线的原图（量「贯穿谱表的竖线」要它）。
 * @returns 认作反复点的圆点的盒：调用方记进账本，免得后面被当成无主的墨（断奏点的候选）。
 */
export function markRepeatsAndVoltas(pg: SPage, bin: Binary, map: ContourMap, sp: number, jianpuBoxes: readonly Rect[] = []): Rect[] {
  const systemOf = (st: Staff) => pg.systems.find((s) => s.staves.includes(st))?.staves ?? [st];
  const repeats = findRasterRepeats(pg, bin, map, sp);
  for (const m of repeats) {
    for (const st of systemOf(m.staff)) {
      if (m.dir === "backward") {
        const b = nearest(st.bars, (q) => q.right, m.x, sp * SNAP);
        if (!b) continue;
        b.rightRepeat = true;
        b.rightStyle = "light-heavy";
      } else {
        // `|:` 记在它右边那个小节的左端；印在行首（谱号调号之后）的没有小节边界，记给第一个小节
        const b = nearest(st.bars, (q) => q.left, m.x, sp * SNAP) ?? (st.bars[0] && m.x < st.bars[0].right ? st.bars[0] : undefined);
        if (!b) continue;
        b.leftRepeat = true;
        // 反复线右边那一小节的前一小节，右端那根只是这处反复的粗线，不是终止线
        const prev = st.bars[st.bars.indexOf(b) - 1];
        if (prev && !prev.rightRepeat && prev.rightStyle === "light-heavy") prev.rightStyle = null;
      }
    }
  }
  // 终止线的粗笔过不了竖段的宽度闸、自己成不了小节线（破碎 p12 末系统那根上下贯通大谱表、贴着页图右缘），
  // 细线就只记成普通线：细线右边一格内原图上有一道贯穿谱表、够粗的竖墨，就是终止线
  for (const st of pg.staves) {
    if (st.lineYs.length !== 5) continue;
    for (const b of st.bars) {
      if (b.rightStyle || b.rightRepeat) continue;
      const ys = st.lineYsAt?.(b.right) ?? st.lineYs;
      const y0 = Math.round(ys[0]), y1 = Math.round(ys[4]);
      const full = (x: number) => {
        let ink = 0;
        for (let y = y0; y <= y1; y++) if (bin.data[y * bin.w + x]) ink++;
        return ink >= (y1 - y0 + 1) * FULL;
      };
      // 细线要就在小节右界上（两像素内）：先跨过细线自己，再找隔着白缝、比它粗得多的那一道墨
      //（右界没落在线上时，不先认出细线，那根线自己就被当成粗笔：万福泉源歌 m4 行末普通线）
      let x = Math.round(b.right) - 2;
      while (x <= Math.round(b.right) + 2 && !full(x)) x++;
      if (x > Math.round(b.right) + 2) continue;
      const x0 = x;
      while (x < bin.w && full(x)) x++;
      const thin = x - x0;
      const xb = Math.min(bin.w - 1, Math.round(b.right + sp * PAIR));
      let run = 0, best = 0;
      for (; x <= xb; x++) {
        run = full(x) ? run + 1 : 0;
        best = Math.max(best, run);
      }
      if (best >= Math.max(2, sp * THICK, thin * 1.8)) b.rightStyle = "light-heavy";
    }
  }
  // 终止线、复纵线同系统各行拉齐：有一行在这个 x 认出样式，没认出的各行照它
  for (const sys of pg.systems) {
    for (const st of sys.staves)
      for (const b of st.bars) {
        if (!b.rightStyle) continue;
        for (const o of sys.staves) {
          if (o === st) continue;
          const q = nearest(o.bars, (p) => p.right, b.right, sp);
          if (q && !q.rightStyle) q.rightStyle = b.rightStyle;
        }
      }
  }

  // ── 房子 ──────────────────────────────────────────────────────────────────
  //
  // 谱表上方一条长横线、左端一道下垂的竖钩、钩对着一根小节线。数字不认（位图路没有文字层）：
  // 按反复线的位置定是第几房（见下）。只印在系统顶行，认出来后同系统各行照抄。
  // 横线本身不在线段表里（又长又细，取图时与谱线一道被抹掉了），从竖钩顶端回到原图上往右量
  const hooks = pg.segs.filter((s) => s.isV && !s.hasAnyTag() && s.len >= sp * VOLTA_HOOK[0] && s.len <= sp * VOLTA_HOOK[1]);
  const voltas: (Volta & { staff: Staff })[] = [];
  hooks.sort((p, q) => p.cx - q.cx);
  for (const hook of hooks) {
    // 钩下方最近的那行谱（中间不能再隔着别的谱行）
    const st = pg.staves.filter((s) => s.topAt(hook.cx) > hook.top && hook.cx > s.box.left - sp && hook.cx < s.box.right).sort((p, q) => p.box.top - q.box.top)[0];
    if (!st) continue;
    // 第一线按钩所在 x 取（弯、斜的谱线）
    const stTop = st.topAt(hook.cx);
    // 简线混排谱：房子印在简谱行之上，高度从简谱带上沿量（祢話如甘霖离顶线 9.8 格）
    const band = jianpuBoxes.find((b) => hook.cx >= b.x && hook.cx <= b.x + b.w && b.y + b.h <= stTop + sp && b.y + b.h >= stTop - sp * 3);
    const rise = (band ? band.y : stTop) - hook.top;
    if (rise < sp * VOLTA_RISE[0] || rise > sp * VOLTA_RISE[1] || hook.bottom > stTop + sp) continue;
    // 钩对着一根小节线；换行后接着的那一房印在行首（谱号调号之后），没有小节线可对，落在第一小节里就算
    const atRowStart = !!st.bars[0] && hook.cx > st.bars[0].left && hook.cx < st.bars[0].right - sp * 2;
    if (!atRowStart && !st.bars.some((b) => Math.abs(b.left - hook.cx) <= sp * VOLTA_SNAP)) continue;
    const len = voltaRun(bin, Math.round(hook.cx), Math.round(hook.top), Math.max(2, Math.round(sp * 0.15)), sp);
    if (len < sp * VOLTA_LEN) continue;
    // 房子的横线是细线：没挂上标记的符干顶端连着符杠也是「竖段顶上往右一道长墨」，但符杠有半格厚
    const thick = [0.25, 0.5, 0.75].map((f) => inkThick(bin, Math.round(hook.cx + len * f), Math.round(hook.top), Math.round(sp))).sort((p, q) => p - q)[1];
    if (thick > Math.max(3, sp * VOLTA_THICK)) continue;
    // 钩底也往右拉着一条横线的是文字框的左边（框住的排练号、`Interlude`），不是房子
    if (inkRun(bin, Math.round(hook.cx), Math.round(hook.bottom), Math.max(2, Math.round(sp * 0.15))) > sp * 2) continue;
    // 钩顶往左不能也有横线（那是一个框的右上角，不是房子的左端）
    // ——除非左边那条就是上一房的横线：第 1 房的线一直画到第 2 房的钩上，上一房到这里为止
    const prevVolta = voltas.find((v) => v.staff === st && v.left < hook.cx - sp && v.right > hook.cx - sp);
    if (prevVolta) prevVolta.right = hook.cx;
    else if (inkRun(bin, Math.round(hook.cx), Math.round(hook.top), Math.max(2, Math.round(sp * 0.15)), -1) > sp) continue;
    if (voltas.some((v) => v.staff === st && Math.abs(v.left - hook.cx) < sp)) continue;
    hook.addTag("Notation");
    voltas.push({ number: "1", left: hook.cx, right: hook.cx + len, staffTop: st.box.top, staff: st });
  }
  for (const v of voltas) {
    // 前一小节右端是 `:|` 的是第 2 房；罩着的最后一小节以 `:|` 收尾的是第 1 房；都看不出、又印在行首的，是换行接过来的第 2 房
    const covered = v.staff.bars.filter((b) => b.right > v.left + sp && b.left < v.right - sp);
    const prev = covered[0] ? v.staff.bars[v.staff.bars.indexOf(covered[0]) - 1] : undefined;
    if (prev?.rightRepeat) v.number = "2";
    else if (covered[covered.length - 1]?.rightRepeat) v.number = "1";
    else if (covered[0] && covered[0] === v.staff.bars[0]) v.number = "2";
  }
  attachVoltas(pg, voltas);
  for (const v of voltas) {
    for (const b of v.staff.bars) {
      if (b.endingNumber !== v.number || !(b.right > v.left + sp && b.left < v.right - sp)) continue;
      for (const o of systemOf(v.staff)) {
        if (o === v.staff) continue;
        const q = nearest(o.bars, (p) => p.left, b.left, sp);
        if (!q) continue;
        q.endingNumber = b.endingNumber;
        q.endingStart = b.endingStart;
        q.endingStop = b.endingStop;
      }
    }
  }
  return repeats.flatMap((m) => m.dots);
}

/** 房子横线从竖钩顶往右的长度：先照 `inkRun` 量；不够长时隔过房号（`VOLTA_BREAK` 以内）接上同一高度的长线，量到它的右端。 */
function voltaRun(bin: Binary, x: number, y: number, pad: number, sp: number): number {
  const len = inkRun(bin, x, y, pad);
  if (len >= sp * VOLTA_LEN) return len;
  for (let cx = x + len + 3; cx <= x + sp * VOLTA_BREAK && cx < bin.w; cx++) {
    const r = inkRun(bin, cx, y, pad);
    if (r >= sp * VOLTA_LEN) return cx + r - x;
    cx += r;
  }
  return len;
}

/** `(x, y)` 处那道横墨的厚度：从 `y` 上下 `reach` 行里最靠近 `y` 的墨起，量连着的墨有几行。 */
function inkThick(bin: Binary, x: number, y: number, reach: number): number {
  if (x < 0 || x >= bin.w) return 0;
  const on = (cy: number) => cy >= 0 && cy < bin.h && bin.data[cy * bin.w + x] === 1;
  let y0 = -1;
  for (let d = 0; d <= reach && y0 < 0; d++) y0 = on(y - d) ? y - d : on(y + d) ? y + d : -1;
  if (y0 < 0) return 0;
  let a = y0;
  let b = y0;
  while (on(a - 1)) a--;
  while (on(b + 1)) b++;
  return b - a + 1;
}

/** 从 `(x, y)` 沿横向量一道线有多长：上下 `pad` 行里任一行有墨就算连着，容两像素的断口。 */
function inkRun(bin: Binary, x: number, y: number, pad: number, dir = 1): number {
  let gap = 0;
  let last = x;
  for (let cx = x; cx >= 0 && cx < bin.w; cx += dir) {
    let on = false;
    for (let cy = Math.max(0, y - pad); cy <= Math.min(bin.h - 1, y + pad) && !on; cy++) on = bin.data[cy * bin.w + cx] === 1;
    if (on) {
      gap = 0;
      last = cx;
    } else if (++gap > 2) break;
  }
  return Math.abs(last - x);
}

function nearest(bars: Bar[], at: (b: Bar) => number, x: number, tol: number): Bar | undefined {
  let best: Bar | undefined;
  let bd = tol;
  for (const b of bars) {
    const d = Math.abs(at(b) - x);
    if (d <= bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}
