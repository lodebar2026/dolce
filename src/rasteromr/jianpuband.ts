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
import type { RasterUnit } from "./staffline";

/** 简谱小节线的长度（线距的倍数）：《是谁》2.34 格、敬拜万世之王 3.7 格（数字大、上下有高低音点）。 */
const BAR_LEN = [1.2, 4] as const;
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
const PAD_BOTTOM = 0.3;

/** 一条简谱行：它压在哪行谱上、带的盒、行内小节线的 x。 */
export interface JianpuBand {
  staff: number;
  box: Rect;
  bars: number[];
}

/** 定位各谱行上方的简谱行。`staves` 给每行谱的五线几何。 */
export function findJianpuBands(
  vSegs: LineSeg[],
  staves: { left: number; right: number; top: number; bottom: number }[],
  unit: RasterUnit,
): JianpuBand[] {
  const sp = unit.space;
  const out: JianpuBand[] = [];
  staves.forEach((st, k) => {
    const h = st.bottom - st.top;
    const span = (v: LineSeg) => [Math.min(v.y0, v.y1), Math.max(v.y0, v.y1)] as const;
    const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
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
        !staves.some((o) => o !== st && a < o.bottom && b > o.top);
    });
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
    const matched = hub ? matched0.filter((v) => same(v, hub)) : [];
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
    out.push({ staff: k, box: { x: Math.round(st.left - sp), y: y0, w: Math.round(st.right - st.left + sp * 2), h: y1 - y0 }, bars });
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
    const st = staves[b.staff];
    const h = st.bottom - st.top;
    for (const x of b.bars) {
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
export function eraseInBand(imgs: Binary[], band: Rect): number {
  const bin = imgs[0];
  const x0 = Math.max(0, band.x);
  const y0 = Math.max(0, band.y);
  const x1 = Math.min(bin.w, band.x + band.w);
  const y1 = Math.min(bin.h, band.y + band.h);
  const W = x1 - x0;
  const seen = new Uint8Array(W * (y1 - y0));
  let erased = 0;
  const comp: number[] = [];
  const stack: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i0 = (y - y0) * W + (x - x0);
      if (seen[i0] || !bin.data[y * bin.w + x]) continue;
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
            if (ny < y0 || ny >= y1 || nx < x0 || nx >= x1) {
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
  const data = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      const sy = y + yy;
      if (sx >= 0 && sy >= 0 && sx < bin.w && sy < bin.h) data[yy * w + xx] = bin.data[sy * bin.w + sx];
    }
  // 跨过条顶边、在条里只剩薄薄一截（不到条高的 `CUT_SLIVER`）的墨，是上方和弦字母被截下的底
  //（颂赞与尊贵 m1、m5「F」下面那一横的衬线）：留着会被简谱那一路当成数字上的高音点，整团抹掉。
  // 真的高音点整个落在条里、碰不到顶边；数字、小节线顶到边的在条里还有一大截，不动
  const seen = new Uint8Array(w * h);
  for (let x0 = 0; x0 < w; x0++) {
    const sx = x + x0;
    if (!data[x0] || seen[x0] || y <= 0 || sx < 0 || sx >= bin.w || !bin.data[(y - 1) * bin.w + sx]) continue;
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
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `J${s.w}x${s.h}-${h1.toString(36)}`;
}
