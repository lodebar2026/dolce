// 谱表**正上方的简谱行**（简线混排谱）：定位、认领、切条。
//
// 诗歌本的混排谱在每行五线谱正上方印一行简谱（数字、减时线、高低音点、增时线、
// 与五线谱**同 x** 的小节线），再往上才是和弦字母。位图路原先不知道这一行：
// 数字「0」「6」、增时线「–」落在谱表上方一两格，被收成全休止、加线上的符头
// ——实测《是谁》每行都多出两三个假音、假全休止；和弦字母又被简谱行隔在
// 和弦带窗口（顶线上方 1.0~3.2 格）之外，24 个一个没认。
//
// **判据是小节线对齐**，不看数字长什么样：简谱行的小节线是一截短竖线，
// 与谱表的小节线同 x（混排谱按小节对齐排版）。独唱谱、合唱谱的谱表上方
// 没有这种东西——那里的竖笔是符干（从谱表伸上来，不悬空）和字母笔画（短、不成排）。
// 对不上两条以上就当没有，这一段对别的底本是空转。
import type { Binary, Rect } from "../omrkit/types";
import type { LineSeg } from "./prims";
import { liftRange, type RasterUnit } from "./staffline";
import { contentKey } from "../omrkit/contentkey";

/** 简谱小节线的长度（线距的倍数）：《是谁》2.34 格、敬拜万世之王 3.7 格（数字大、上下有高低音点）、祢話如甘霖 4.84 格（简谱字号比谱表线距大得多）。 */
const BAR_LEN = [1.2, 5.5] as const;
/** 对上的简谱小节线长度不超过它们中位数的几倍 */
const BAR_LEN_SPREAD = 1.15;
/** 简谱小节线的下端离谱表顶线至少多远（线距）：再近就是符干、符杠那一带。 */
const BAR_CLEAR = 0.5;
/** 往上最多找多远（线距）。 */
const BAR_REACH = 6;
/** 与谱表小节线的 x 容差（线距）。实测 2~10px / 线距 50。 */
const BAR_DX = 0.6;
/** 至少对上几条谱表小节线才算有简谱行。 */
const MIN_MATCH = 2;
/**
 * 对上的还要占谱表竖线的这么多成。谱表「小节线」按纵贯五线收，和弦的长符干也在里头；
 * 大谱表之间的歌词字竖笔（约 2 格长）偶然与两根符干同 x，就够了 `MIN_MATCH`
 *（你的信实广大第 4 系统第 2 段、末系统整行歌词被当简谱行抹掉：对上 2/13、2/14）。
 * 真的混排谱几乎每条小节线上方都有简谱小节线：是谁、敬拜万世之王、颂赞与尊贵各行 0.6~1。
 */
const MIN_MATCH_FRAC = 0.4;
/** 同一高度的其余短竖线，长度至少是对上那几条最短者的几成才算小节线。 */
const BAR_SIBLING = 0.75;
/**
 * 带在小节线上下各放多少（线距）：上面要罩住高音点和圆滑线的弧顶
 * （《是谁》弧顶比小节线顶高 0.7 格），下面要罩住减时线与低音点（低 0.25 格）。
 * 下面放得少——再往下是往上的符杠（《是谁》第一行的符杠离小节线下端只有 0.4 格）。
 */
const PAD_TOP = 0.8;
/** 叠印的上一行简谱：下一行谱表离这行谱表不过谱表高的几倍才算同一系统（祢話如甘霖两行谱表隔 1.8 倍） */
const STACK_GAP = 3;
/** 叠印的上一行简谱：对上这行小节线的成数 */
const STACK_MATCH = 0.6;
const PAD_BOTTOM = 0.3;

/** 一条简谱行：它压在哪行谱上、带的盒、行内小节线的 x。
 *  弯、斜的谱行（`lift`）上带随谱线走：`box` 的 y 按谱表中段的线位记，x 处的带要加上 `lift(x)`。 */
export interface JianpuBand {
  staff: number;
  box: Rect;
  bars: number[];
  lift?: (x: number) => number;
}

/** 定位各谱行上方的简谱行。`staves` 给每行谱的五线几何（弯、斜的另带逐列偏移 `lift`）。 */
export function findJianpuBands(
  vSegs: LineSeg[],
  staves: { left: number; right: number; top: number; bottom: number; lift?: (x: number) => number }[],
  unit: RasterUnit,
  bin?: Binary,
): JianpuBand[] {
  const sp = unit.space;
  const out: JianpuBand[] = [];
  /** 上端吊在一条长横线下（左右任一边伸出两格以上）：是房子括线的竖钩，不是简谱小节线。
   *  房子的竖钩也与谱表小节线同 x（哈利路亚主复活 m9 一房、二房，渲图上整条带连同二分音的附点被抹掉） */
  const hooked = (v: LineSeg): boolean => {
    if (!bin) return false;
    const x = Math.round((v.x0 + v.x1) / 2);
    const top = Math.round(Math.min(v.y0, v.y1));
    const reach = Math.round(unit.lineThick) + 2;
    for (let y = Math.max(0, top - reach); y <= Math.min(bin.h - 1, top + reach); y++)
      for (let x0 = x - 1; x0 <= x + 1; x0++) {
        if (x0 < 0 || x0 >= bin.w || !bin.data[y * bin.w + x0]) continue;
        let a = x0;
        let b = x0;
        while (a > 0 && bin.data[y * bin.w + a - 1]) a--;
        while (b < bin.w - 1 && bin.data[y * bin.w + b + 1]) b++;
        if (Math.max(x0 - a, b - x0) >= sp * 2) return true;
      }
    return false;
  };
  staves.forEach((st, k) => {
    const h = st.bottom - st.top;
    const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
    // 弯、斜的谱行：竖线的纵向范围减掉所在 x 处的谱线偏移，按谱线是平的来比（斜 1.7 格的页上两头的简谱小节线错开大半根，
    // 按原图 y 凑「同一高度」凑不齐）
    const lift = st.lift;
    const span = (v: LineSeg) => {
      const d = lift ? lift(cx(v)) : 0;
      return [Math.min(v.y0, v.y1) - d, Math.max(v.y0, v.y1) - d] as const;
    };
    const liftOf = (o: { lift?: (x: number) => number }, x: number) => (o.lift ? o.lift(x) : 0);
    // 谱表小节线：纵贯五线
    const staffBars = vSegs
      .filter((v) => {
        const [a, b] = span(v);
        return a <= st.top + sp * 0.5 && b >= st.bottom - sp * 0.5 && b - a <= h + sp * 1.5;
      })
      .map(cx)
      .filter((x) => x > st.left + sp * 2 && x < st.right + sp);
    // 简谱行小节线候选：悬在谱表上方的短竖线
    const cands = vSegs.filter((v) => {
      const [a, b] = span(v);
      const len = (b - a) / sp;
      return len >= BAR_LEN[0] && len <= BAR_LEN[1] && b <= st.top - sp * BAR_CLEAR && b >= st.top - sp * BAR_REACH && cx(v) >= st.left - sp && cx(v) <= st.right + sp &&
        // 压着别的谱行的是那一行自己的小节线（你的信实广大谱行只隔 5 格，上一行的小节线落进窗口）
        !staves.some((o) => o !== st && a < o.bottom + liftOf(o, cx(v)) - liftOf(st, cx(v)) && b > o.top + liftOf(o, cx(v)) - liftOf(st, cx(v))) && !hooked(v);
    });
    /** `top`~`bot` 这行简谱上方紧挨着的另一行：同 x（对上这行的小节线）、长度相当的短竖线；返回它的纵向范围与小节线 x */
    const stackedRow = (top: number, bot: number, bars: number[]): [number, number, number[]] | null => {
      const minLen = (bot - top) * BAR_SIBLING;
      const ups = vSegs.filter((v) => {
        const [a, b] = span(v);
        return b - a >= minLen && b - a <= sp * BAR_LEN[1] && b <= top - sp * 0.3 && b >= top - (bot - top) - sp * 3 &&
          bars.some((x) => Math.abs(cx(v) - x) <= sp * BAR_DX) && !hooked(v);
      });
      const dg = ups.map((v) => ups.filter((o) => same(v, o)).length);
      const hb = ups[dg.indexOf(Math.max(...dg))];
      const row = hb ? ups.filter((v) => same(v, hb)) : [];
      if (row.length < MIN_MATCH || row.length < bars.length * STACK_MATCH) return null;
      const ys = row.map(span);
      return [Math.min(...ys.map((q) => q[0])), Math.max(...ys.map((q) => q[1])), row.map(cx).sort((a, b) => a - b)];
    };
    const matched0 = cands.filter((v) => staffBars.some((x) => Math.abs(cx(v) - x) <= sp * BAR_DX));
    // **对上的要在同一高度**：取与别人纵向重叠（过短者一半）最多的那一簇。
    // 行首谱表左端上方和弦字母的竖笔也对得上（敬拜万世之王末行 y 比简谱小节线高两格），混进来带顶就罩住和弦
    const same = (p: LineSeg, q: LineSeg) => {
      const [a, b] = span(p);
      const [c, d] = span(q);
      return Math.min(b, d) - Math.max(a, c) > Math.min(b - a, d - c) * 0.5;
    };
    const deg = matched0.map((v) => matched0.filter((o) => same(v, o)).length);
    const hub = matched0[deg.indexOf(Math.max(...deg))];
    const matched1 = hub ? matched0.filter((v) => same(v, hub)) : [];
    // **长度要整齐**：小节线长度上限放到 5.5 格之后（祢話如甘霖 4.84 格），与上方字母笔画连成一根的也进得来，
    // 把带顶抬高、压住和弦（敬拜万世之王第三行）。超过中位数 1.15 倍的不要（敬拜第三行那根 4.26 格，其余 3.3~3.5）
    const lens = matched1.map((v) => span(v)[1] - span(v)[0]).sort((a, b) => a - b);
    const medLen = lens[lens.length >> 1] ?? 0;
    const matched = matched1.filter((v) => span(v)[1] - span(v)[0] <= medLen * BAR_LEN_SPREAD);
    if (matched.length < MIN_MATCH || matched.length < staffBars.length * MIN_MATCH_FRAC) return;
    // 带的纵向范围按对上的那几条定（行首那条可能是简谱行自己的起头线，不一定有谱表小节线对着）
    const ys = matched.map(span);
    const top = Math.min(...ys.map((s) => s[0]));
    const bot = Math.max(...ys.map((s) => s[1]));
    // 同一高度的其余短竖线（行首线）一并算作简谱行的小节线。**长度要与对上的相当**：
    // 数字「1」「7」的竖笔也在这一高度（敬拜万世之王末行混进十条，补小节线会把旁边的符干当小节线）
    const minLen = Math.min(...ys.map((s) => s[1] - s[0])) * BAR_SIBLING;
    const bars = cands
      .filter((v) => {
        const [a, b] = span(v);
        return a <= bot && b >= top && b - a >= minLen;
      })
      .map(cx)
      .sort((a, b) => a - b);
    const y0 = Math.round(top - sp * PAD_TOP);
    const y1 = Math.min(Math.round(bot + sp * PAD_BOTTOM), Math.round(st.top - sp * 0.2));
    const box = { x: Math.round(st.left - sp), y: y0, w: Math.round(st.right - st.left + sp * 2), h: y1 - y0 };
    // **叠印两行简谱**（祢話如甘霖 15–19 小节：一个系统两行谱表，两行简谱都印在上行谱表上方）：
    // 自上而下与谱表一一对应，紧贴上行谱表的那行其实是下行谱表的旋律。上方再有一行同 x 的简谱小节线、
    // 下面紧跟着同一系统的下一行谱表时，上面那行归这行谱、贴着的那行归下一行谱
    const below = staves[k + 1];
    const upper = below && below.top - st.bottom < h * STACK_GAP ? stackedRow(top, bot, bars) : null;
    if (upper) {
      const u0 = Math.round(upper[0] - sp * PAD_TOP);
      const u1 = Math.min(Math.round(upper[1] + sp * PAD_BOTTOM), y0);
      out.push({ staff: k, box: { ...box, y: u0, h: u1 - u0 }, bars: upper[2], ...(lift ? { lift } : {}) });
      out.push({ staff: k + 1, box, bars, ...(lift ? { lift } : {}) });
      return;
    }
    out.push({ staff: k, box, bars, ...(lift ? { lift } : {}) });
  });
  return out;
}

/** 谱表上补齐小节线：竖段至少盖住谱表高的几成（其余几成是阈值切掉的淡墨）。 */
const BAR_COVER = 0.6;
/** 补齐时竖段两端探出谱表不过多少（线距）：再多是符干。 */
const BAR_OVERSHOOT = 0.3;

/**
 * **拿简谱行的小节线补齐谱表上断开、短一截的小节线**，原地改 `vSegs`，返回补了几条。
 *
 * 细线扫描件（敬拜万世之王）的谱表小节线灰度 150~200，按阈值切成一截一截：
 * 第五线到第四线那段整格没了，或下端差第一线 0.4 格——`findBarlines` 要两端贴着外线（四分之一格），
 * 收不下，整行漏切两个小节。混排谱的简谱小节线与谱表小节线同 x，是现成的旁证：
 * 简谱小节线正下方、谱表范围内的竖段（可以是几截）合起来盖住谱表高六成以上，
 * 两端不探出谱表，就并成一条纵贯五线的竖段。已经盖满的不动；找不到竖段的不凭空补。
 */
export function completeStaffBars(
  vSegs: LineSeg[],
  staves: { top: number; bottom: number }[],
  bands: JianpuBand[],
  unit: RasterUnit,
): number {
  const sp = unit.space;
  let n = 0;
  for (const b of bands) {
    const st0 = staves[b.staff];
    const h = st0.bottom - st0.top;
    for (const x of b.bars) {
      // 弯、斜的谱行取这根小节线 x 处的首末线
      const d = b.lift ? b.lift(x) : 0;
      const st = { top: st0.top + d, bottom: st0.bottom + d };
      const near = vSegs.filter((v) => {
        const a = Math.min(v.y0, v.y1);
        const e = Math.max(v.y0, v.y1);
        return Math.abs((v.x0 + v.x1) / 2 - x) <= sp * BAR_DX && a >= st.top - sp * BAR_OVERSHOOT && e <= st.bottom + sp * BAR_OVERSHOOT;
      });
      if (!near.length) continue;
      // 竖段中心离简谱小节线最近的那一列（半个线宽内的算同一根）
      const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
      const best = Math.min(...near.map((v) => Math.abs(cx(v) - x)));
      const col = near.filter((v) => Math.abs(cx(v) - x) <= best + Math.max(2, v.lw));
      const top = Math.min(...col.map((v) => Math.min(v.y0, v.y1)));
      const bot = Math.max(...col.map((v) => Math.max(v.y0, v.y1)));
      if (top <= st.top + sp * 0.25 && bot >= st.bottom - sp * 0.25) continue;
      // 按合起来的覆盖量算（几截之间的断口不算）
      const ys = col.map((v) => [Math.max(st.top, Math.min(v.y0, v.y1)), Math.min(st.bottom, Math.max(v.y0, v.y1))]).sort((p, q) => p[0] - q[0]);
      let cover = 0;
      let reach = -Infinity;
      for (const [a, e] of ys) {
        if (e <= reach) continue;
        cover += e - Math.max(a, reach);
        reach = e;
      }
      if (cover < h * BAR_COVER) continue;
      const lw = col.reduce((s, v) => s + v.lw, 0) / col.length;
      const mx = col.reduce((s, v) => s + cx(v), 0) / col.length;
      for (const v of col) vSegs.splice(vSegs.indexOf(v), 1);
      vSegs.push({ x0: mx, y0: st.top, x1: mx, y1: st.bottom, lw, maxLw: Math.max(...col.map((v) => v.maxLw)) });
      n++;
    }
  }
  return n;
}

/**
 * 把**整个落在带里**的连通块从各张图上抹掉（八连通），返回抹掉的像素数。
 *
 * 只抹整块在带里的：从谱表伸上来的符杠、符干，块的一部分在带外，原样留着
 * ——带的下沿离往上的符杠常常不到半格，按矩形一刀切会把符杠削掉。
 * `imgs` 里第一张用来判连通（有谱线的原图），后面几张按同样的像素一并抹。
 */
export function eraseInBand(imgs: Binary[], band: Rect, lift?: (x: number) => number): number {
  const bin = imgs[0];
  const x0 = Math.max(0, band.x);
  const x1 = Math.min(bin.w, band.x + band.w);
  // 弯、斜的谱行：x 处的带上下沿各加 `lift(x)`；外框取包络
  const [lo, hi] = liftRange(lift, x0, x1);
  const y0 = Math.max(0, Math.floor(band.y + lo));
  const y1 = Math.min(bin.h, Math.ceil(band.y + band.h + hi));
  const W = x1 - x0;
  const dy = new Int32Array(W);
  if (lift) for (let x = 0; x < W; x++) dy[x] = Math.round(lift(x0 + x));
  const inBand = (x: number, y: number) => x >= x0 && x < x1 && y >= band.y + dy[x - x0] && y < band.y + band.h + dy[x - x0] && y >= y0 && y < y1;
  const seen = new Uint8Array(W * (y1 - y0));
  let erased = 0;
  const comp: number[] = [];
  const stack: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i0 = (y - y0) * W + (x - x0);
      if (seen[i0] || !bin.data[y * bin.w + x] || !inBand(x, y)) continue;
      // 灌一块；碰到带外的墨就记下「越界」，但带内的部分照灌完（免得同一块反复起灌）
      comp.length = 0;
      let out = false;
      seen[i0] = 1;
      stack.push(y * bin.w + x);
      while (stack.length) {
        const p = stack.pop()!;
        const py = Math.floor(p / bin.w);
        const px = p % bin.w;
        comp.push(p);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ny = py + dy;
            const nx = px + dx;
            if (ny < 0 || ny >= bin.h || nx < 0 || nx >= bin.w || !bin.data[ny * bin.w + nx]) continue;
            if (!inBand(nx, ny)) {
              out = true;
              continue;
            }
            const j = (ny - y0) * W + (nx - x0);
            if (seen[j]) continue;
            seen[j] = 1;
            stack.push(ny * bin.w + nx);
          }
      }
      if (out) continue;
      for (const p of comp) for (const im of imgs) im.data[p] = 0;
      erased += comp.length;
    }
  return erased;
}

/** 简谱行的裸像素（抹掉之前取，`gen-rasterjianpu` 拿它离线认简谱）。 */
export interface JianpuStrip {
  staff: number;
  box: Rect;
  w: number;
  h: number;
  data: Uint8Array;
  bars: number[];
}

/** 跨过条顶边的墨在条里高不过条高的这么多，算截下来的一截（见 `cutJianpuStrip`）。 */
const CUT_SLIVER = 0.15;

export function cutJianpuStrip(bin: Binary, band: JianpuBand): JianpuStrip {
  const { x, y, w, h } = band.box;
  // 弯、斜的谱行逐列按谱线偏移挪着取（整像素，同 `lyric.ts::stripOf`）
  const shift = new Int32Array(w);
  if (band.lift) for (let xx = 0; xx < w; xx++) shift[xx] = Math.round(band.lift(x + xx));
  const data = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      const sy = y + yy + shift[xx];
      if (sx >= 0 && sy >= 0 && sx < bin.w && sy < bin.h) data[yy * w + xx] = bin.data[sy * bin.w + sx];
    }
  // 跨过条顶边、在条里只剩薄薄一截（不到条高的 `CUT_SLIVER`）的墨，是上方和弦字母被截下的底
  //（颂赞与尊贵 m1、m5「F」下面那一横的衬线）：留着会被简谱那一路当成数字上的高音点，整团抹掉。
  // 真的高音点整个落在条里、碰不到顶边；数字、小节线顶到边的在条里还有一大截，不动
  const seen = new Uint8Array(w * h);
  for (let x0 = 0; x0 < w; x0++) {
    const sx = x + x0;
    if (!data[x0] || seen[x0] || y + shift[x0] <= 0 || sx < 0 || sx >= bin.w || !bin.data[(y + shift[x0] - 1) * bin.w + sx]) continue;
    const comp: number[] = [x0];
    seen[x0] = 1;
    let maxY = 0;
    for (let k = 0; k < comp.length; k++) {
      const xx = comp[k] % w;
      const yy = (comp[k] / w) | 0;
      maxY = Math.max(maxY, yy);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = xx + dx;
          const ny = yy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !data[ny * w + nx] || seen[ny * w + nx]) continue;
          seen[ny * w + nx] = 1;
          comp.push(ny * w + nx);
        }
    }
    if (maxY < h * CUT_SLIVER) for (const i of comp) data[i] = 0;
  }
  return { staff: band.staff, box: band.box, w, h, data, bars: band.bars };
}

/** 条的内容指纹（与 `harmonyKey` / `stripKey` 同一套）。 */
export function jianpuKey(s: JianpuStrip): string {
  return contentKey("J", s.w, s.h, s.data);
}
