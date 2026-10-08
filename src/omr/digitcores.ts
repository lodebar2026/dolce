// 简谱识别的**数字块 → 数字核**：粘连块拆开（连音弧、升降号粘数字）、按行分组、拍号候选。
import type { Binary, Component, Rect } from "../omrkit/types";
import { rright, rbottom, rcx, rcy } from "../omrkit/types";
import { median, unionRect } from "../omrkit/geom";
import { accidentalOf } from "./accidental";
import { probe } from "./probe";
import { type DigitCore } from "./jianpu";
import { rowInk, tightBox, columnInk, stackedHline } from "./inkprobe";

// 探测「圆滑线弧帽 + 数字」粘连块：弧线常贴着它跨越的两个数字顶端，4-连通把弧与数字粘成
// 一个**明显超高(h>1.2字号)**的块。结构（实测）：顶部弧帽(单段宽笔)→两条下垂弧尾(低墨谷)→
// 底部 ~一个字号的数字体。据**行墨廓线**找谷底、把数字体定位到底部，弧帽切出来供 detectSlurs 用。
// 返回 { bodyTop: 数字体起始行(块内偏移，0=无弧), arc: 弧帽紧包围盒|null }。
function mergedArcSplit(bin: Binary, b: Rect, numH: number): { bodyTop: number; arc: Rect | null } {
  if (b.h <= numH * 1.2 || b.w < numH * 1.2) return { bodyTop: 0, arc: null };
  const rows = rowInk(bin, b);
  const maxInk = Math.max(...rows);
  // 在 [0.3字号, 块高-0.6字号) 内找最低墨行（弧尾与数字体之间的谷）。
  const lo = Math.floor(numH * 0.3), hi = Math.floor(b.h - numH * 0.6);
  let vIdx = -1, vMin = Infinity;
  for (let y = lo; y < hi; y++) if (rows[y] < vMin) { vMin = rows[y]; vIdx = y; }
  if (vIdx < 0 || vMin >= maxInk * 0.3) return { bodyTop: 0, arc: null }; // 无清晰分隔 → 不是弧
  // 数字体顶：自谷底下行找首个墨量回升到 0.35×峰值 的行。
  let bodyTop = vIdx;
  for (let y = vIdx; y < b.h; y++) if (rows[y] >= maxInk * 0.35) { bodyTop = y; break; }
  // 弧帽高须在 [0.2, 0.85]×字号（短于一个数字），数字体须 ≥0.7字号；否则疑似两数字纵向粘连，弃。
  if (bodyTop < numH * 0.2 || bodyTop > numH * 0.85 || b.h - bodyTop < numH * 0.7) return { bodyTop: 0, arc: null };
  const arc = tightBox(bin, b, 0, b.w, 0, bodyTop);
  if (!arc || arc.w < b.w * 0.55) return { bodyTop: 0, arc: null }; // 弧帽须横跨大半块宽
  probe("mergedArcSplit");
  return { bodyTop, arc };
}

// 把一个数字块拆成若干数字格，并测出共享的下划线条数(div)。
// jianpu.cpp 用形态学分离横线；这里用"底部带状宽行 = 下划线"+"上部列投影空隙 = 数字间隔"。
export function splitBlock(bin: Binary, comp: Component, numH: number): { cores: DigitCore[]; arc: Rect | null } {
  const b = comp.bbox;
  // 减时线(下划线)在本图里是数字**正下方的独立横线连通块**(归入 c.hlines)，并不在数字块内
  //（数字块高度≈字号，块内底部宽行其实是数字自身的底横笔，初版据此判 div 会把 5/6/2/3 全部误判）。
  // 因此 div 不在此处测，改到 buildJpNums 里按"数字下方的 hline"统计（见 underlineDiv）。
  const div = 0;
  // 圆滑线弧帽常与所跨数字粘连成超高块 → 仅**取出弧帽**(供 detectSlurs)；数字格仍按整块切分。
  // （不据弧帽裁数字体：块包围盒常跨到相邻独立数字上，裁后底带会漏进邻字像素 → 重复数字。）
  const { arc } = mergedArcSplit(bin, b, numH);
  const yLimit = b.h;

  // 2) 上部按列投影空隙切分（仅当块明显宽于一个数字时才尝试，避免把单个数字切碎）。
  const cores: DigitCore[] = [];
  if (b.w <= numH * 1.4) {
    const box = tightBox(bin, b, 0, b.w, 0, yLimit) ?? { x: b.x, y: b.y, w: b.w, h: yLimit };
    cores.push({ bbox: box, div });
    return { cores, arc };
  }
  const cols = columnInk(bin, b, 0, yLimit);
  // 收集前景列的连续段（空列 = 间隔）
  const segs: Array<[number, number]> = [];
  let s = -1;
  for (let xx = 0; xx < b.w; xx++) {
    if (cols[xx] > 0) { if (s < 0) s = xx; }
    else if (s >= 0) { segs.push([s, xx]); s = -1; }
  }
  if (s >= 0) segs.push([s, b.w]);
  // 过滤过窄的噪声段（< numH*0.25），把它们并入相邻段
  const minSeg = numH * 0.3;
  const merged: Array<[number, number]> = [];
  for (const [a, e] of segs) {
    if (e - a < minSeg && merged.length) merged[merged.length - 1][1] = e;
    else merged.push([a, e]);
  }
  for (const [a, e] of merged.length ? merged : segs) {
    const box = tightBox(bin, b, a, e, 0, yLimit);
    if (box) cores.push({ bbox: box, div });
  }
  return { cores: cores.length ? cores : [{ bbox: { x: b.x, y: b.y, w: b.w, h: yLimit }, div }], arc };
}

// 按 y 把数字格分行（贪心：行内 y 重叠或中心接近）。
//
// **先用够大的块定行，小块随后挂靠**：变音记号这类块比数字矮、又骑在数字左上角，中心比
// 数字高小半格。一轮贪心是按 y 中心从上往下走的，小块会先跟头顶的弧帽结成一行，等数字来时
// 那行的中位数已经偏高、进不去，小块就跟着那行一起被后面「行里得有小节线」的判据滤掉
// （8《心持两意的人》第 1 行的 ♮ 正是这样丢的：它与三个弧帽结成 y=154 那行，数字行在 179）。
/** ♯ 的横笔顶到数字上、连成一块：新编赞美诗·四声部的 ♯ 印得和数字一般宽，两道横笔伸进右邻数字（236 `♯5` 50×41、
 *  `♯1` 41×46，字号 36），整块当成一个数字读成 `0`——全本漏 ♯ 二百多处。
 *  判据：块宽 1.0~1.9 字号；从左数 0.45~0.9 字号之间墨最少的一列为界，左半得是 ♯ 的形——**两根竖笔**（列墨 ≥0.55 左半高的
 *  两段列，隔开）加**两道横笔**（横贯左半 ≥0.85 宽的两段行，隔开）；右半够一个数字高（≥0.7 字号）。
 *  两个数字粘连的块没有「两竖两横」。拆成 ♯ 与数字两个核，♯ 交给后面的临时升降号判据。 */
export function splitGluedSharp(bin: Binary, comp: Component, numH: number): DigitCore[] | null {
  const b = comp.bbox;
  if (b.w < numH * 0.95 || b.w > numH * 1.9 || b.h < numH * 0.8 || b.h > numH * 1.5) return null;
  const cols = columnInk(bin, b, 0, b.h);
  // 小号 ♭ 粘在数字左上角（236 `♭6` 40×42：♭ 14×20）：0.25~0.55 字号之间墨最少的一列为界，左半矮（不过右半高的 0.75）、
  // 悬在上面（底比数字底高 ≥0.2 字号）、形状判成 ♭。
  {
    let c2 = -1;
    for (let xx = Math.round(numH * 0.25); xx <= Math.min(b.w - Math.round(numH * 0.3), Math.round(numH * 0.55)); xx++)
      if (c2 < 0 || cols[xx]! < cols[c2]!) c2 = xx;
    if (c2 >= 0 && cols[c2]! <= numH * 0.2) {
      const l = tightBox(bin, b, 0, c2, 0, b.h), r = tightBox(bin, b, c2, b.w, 0, b.h);
      if (l && r && r.h >= numH * 0.7 && r.w >= numH * 0.3 && l.w >= numH * 0.25 && l.h >= numH * 0.35 && l.h <= r.h * 0.75 &&
        rbottom(r) - rbottom(l) >= numH * 0.2 && accidentalOf(bin, l) === "flat") {
        probe("splitGluedFlat");
        return [{ bbox: l, div: 0 }, { bbox: r, div: 0 }];
      }
    }
  }
  if (b.w < numH) return null;
  let cut = -1;
  for (let xx = Math.round(numH * 0.45); xx <= Math.min(b.w - Math.round(numH * 0.2), Math.round(numH * 0.9)); xx++)
    if (cut < 0 || cols[xx]! < cols[cut]!) cut = xx;
  if (cut < 0 || cols[cut]! > numH * 0.3) return null;
  const left = tightBox(bin, b, 0, cut, 0, b.h), right = tightBox(bin, b, cut, b.w, 0, b.h);
  if (!left || !right || right.h < numH * 0.7 || left.h < numH * 0.5 || left.w < numH * 0.4) return null;
  // 数「隔开的段数」：flags 里连续 true 算一段
  const bands = (flags: boolean[]): number => flags.reduce((n, f, i) => n + (f && !flags[i - 1] ? 1 : 0), 0);
  const colFull: boolean[] = [], rowFull: boolean[] = [];
  for (let x = left.x; x < rright(left); x++) {
    let n = 0;
    for (let y = left.y; y < rbottom(left); y++) if (bin.data[y * bin.w + x]) n++;
    colFull.push(n >= left.h * 0.55);
  }
  for (let y = left.y; y < rbottom(left); y++) {
    let best = 0, cur = 0;
    for (let x = left.x; x < rright(left); x++) { if (bin.data[y * bin.w + x]) { if (++cur > best) best = cur; } else cur = 0; }
    rowFull.push(best >= left.w * 0.85);
  }
  if (bands(colFull) !== 2 || bands(rowFull) !== 2) return null;
  probe("splitGluedSharp");
  return [{ bbox: left, div: 0 }, { bbox: right, div: 0 }];
}

export function groupRows(cores: DigitCore[], numH: number): DigitCore[][] {
  // 自上而下贪心：够近就并进那一行，否则另起一行
  const greedy = (list: DigitCore[], into: DigitCore[][]): DigitCore[][] => {
    for (const d of [...list].sort((a, b) => rcy(a.bbox) - rcy(b.bbox))) {
      let placed = false;
      for (const row of into) {
        const ry = median(row.map((k) => rcy(k.bbox)));
        if (Math.abs(rcy(d.bbox) - ry) < numH * 0.7) { row.push(d); placed = true; break; }
      }
      if (!placed) into.push([d]);
    }
    return into;
  };
  // 一轮：够大的块（真数字）定下每一行的中位数
  const rows = greedy(cores.filter((k) => k.bbox.h >= numH * 0.7), []);
  // 二轮：小块挂到中心**最近**的那一行（不是第一个够近的），挂不上的再互相聚成行
  const orphans: DigitCore[] = [];
  for (const d of cores.filter((k) => k.bbox.h < numH * 0.7)) {
    let best: DigitCore[] | null = null;
    let bestDist = numH * 0.7;
    for (const row of rows) {
      const dist = Math.abs(rcy(d.bbox) - median(row.map((k) => rcy(k.bbox))));
      if (dist < bestDist) { best = row; bestDist = dist; }
    }
    if (best) best.push(d); else orphans.push(d);
  }
  rows.push(...greedy(orphans, []));
  for (const row of rows) row.sort((a, b) => a.bbox.x - b.bbox.x);
  // **行序必须自上而下单调**：下游一律按下标取相邻行——歌词带的下界是 `staff[i+1]` 的上缘
  // （lyrics.ts），段落标记/和弦挂在 `staff[rowIdx + 1]` 上，跳转记号按 `staff[rowIdx ± 1]` 就近归行。
  // 二轮那几行孤儿是 push 在数组**尾部**的，行序就此断了：95《灵同胞》末谱行（y1460）的「下一行」
  // 成了 y380 的碎块行，歌词带算出 yBot < yTop、整条带没扫，末行歌词一个字都没挂上。
  rows.sort((a, b) => median(a.map((k) => rcy(k.bbox))) - median(b.map((k) => rcy(k.bbox))));
  return rows;
}

/** 曲中转拍号（谱行里直接印着的「3/4」）候选：一条短分数线，正上方一个数字、正下方一个数字。
 *  不摘出去有两害：① 分子分母会当成两个音符混进音流；② 分子在数字带上方、分母在下方，整行的
 *  y 跨度被撑到两倍（714《我说算了吧》那行 76px vs 常规 35px），贯穿本行的小节线过不了
 *  buildRowMeta 里「覆盖 70% 行高」那道判据 → **整行连音符带歌词一起丢**。
 *  判据只用几何：分数线与两个数字同 x 居中、上下间隙都在半个字号内。增时线 '-' 与减时线也是
 *  短横块，但前者没有正上/正下方紧贴的数字，后者上方是数字、下方是歌词（不在 cores 里），分得开。 */
export function meterCandidates(cores: DigitCore[], hlines: Component[], numH: number, spare: DigitCore[] = []): MeterCand[] {
  const out: MeterCand[] = [];
  const real = new Set(cores);
  const pool = [...cores, ...spare];
  for (const h of hlines) {
    const hb = h.bbox;
    if (hb.w < numH * 0.35 || hb.w > numH * 1.6) continue; // 分数线与数字同宽量级
    const hcx = rcx(hb);
    const near = (k: DigitCore) => Math.abs(rcx(k.bbox) - hcx) <= Math.max(numH * 0.3, hb.w * 0.5);
    const pick = (cands: DigitCore[], key: (k: DigitCore) => number) =>
      cands.sort((a, b) => key(a) - key(b))[0];
    const up = pick(pool.filter((k) => near(k) && hb.y - rbottom(k.bbox) >= -2 &&
      hb.y - rbottom(k.bbox) < numH * 0.55), (k) => hb.y - rbottom(k.bbox));
    const dn = pick(pool.filter((k) => near(k) && k.bbox.y - rbottom(hb) >= -2 &&
      k.bbox.y - rbottom(hb) < numH * 0.55), (k) => k.bbox.y - rbottom(hb));
    if (!up || !dn) continue;
    // 补位块（spare）只能当**一头**，另一头必须是正经数字格，且两头字号相当——
    // 同一个拍号的分子分母本是同一字号，差出两成的多半是凑巧夹着横线的别的东西。
    if (!real.has(up) && !real.has(dn)) continue;
    if (!real.has(up) || !real.has(dn)) {
      const [a, b] = [up.bbox.h, dn.bbox.h].sort((x, y) => x - y);
      if (a < b * 0.8) continue;
    }
    // 分子分母都不宽于分数线（宽出去的多半是别的东西恰好上下夹着一条横线）
    if (up.bbox.w > hb.w * 1.5 || dn.bbox.w > hb.w * 1.5) continue;
    // 上下还叠着一条横线的是双减时线，不是分数线：四声部谱上声部的 `2̳` 正下方隔着线就是下声部的 `4`
    //（新编赞美诗·四声部 f6《哈利路亚赞美耶稣》凑成 2/4、6/4，下声部的十六分 4 被当分母摘走）
    if (stackedHline(hlines, hb, numH)) { probe("meter.stackedLine"); continue; }
    out.push({ line: h, up, dn, bbox: unionRect(unionRect(up.bbox, dn.bbox), hb) });
  }
  // 分子分母**各自**在同一高度左右都有别的数字：两头各属一个谱行（四声部上下两声部），是一个音符的减时线夹在两行之间。
  // 真转拍号的分子分母悬在数字带上下、同高处没有音符；页眉连印的 `3/4 4/4` 邻居本身也是候选，不算
  // 左右找到 5 字号（原 2.5）：行首弱起的那个八分音符后面隔着小节线，离下一个音 3.9 字号（四声部 281 第 3 系统
  // 行首上声部 `5̲`、下声部 `3̲` 读成 5/4，两个弱起音都被摘走）
  const inCand = new Set(out.flatMap((m) => [m.up, m.dn]));
  const rowMate = (k: DigitCore) => cores.some((o) => o !== k && !inCand.has(o) && o.bbox.h >= k.bbox.h * 0.7 &&
    Math.abs(rcy(o.bbox) - rcy(k.bbox)) <= numH * 0.2 && Math.abs(rcx(o.bbox) - rcx(k.bbox)) <= numH * 5);
  return out.filter((m) => {
    if (rowMate(m.up) && rowMate(m.dn)) { probe("meter.voiceRows"); return false; }
    return true;
  });
}

/** 转拍号候选：分数线 + 分子/分母两个数字格（值待 OCR）。 */
interface MeterCand {
  line: Component;
  up: DigitCore;
  dn: DigitCore;
  bbox: Rect;
}
