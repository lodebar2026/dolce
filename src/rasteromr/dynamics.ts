// 力度记号：把**认出来的那个字母**连同它旁边的字母拼成一个记号（`mf` / `ff` / `mp`…）。
//
// 位图路的力度检出其实早就有了——字典里 `dynamicForte` 26 个类实例、`dynamicMP` 8 个，
// 实测宁静 p2 那个 `f` 到 Maestro 模板只有 19。缺的是两件事：
//   1. 从来没调过 `findNotations` / `attachDynamics`（在 `recognize.ts` 里补上了）；
//   2. **`mf` 印出来是两个字母**（`m` 一个块、`f` 一个块），只认 `f` 就把 `mf` 读成 `f`。
//
// 第 2 件在这里做。`m` 那个块本身是认不出的：它落在字典的 `dynamicForte` 类里
// （实测距离 71~98，而真 `f` 只有 19），或者干脆被当成实心符头
// （1.87×1.17 格，正在符头的尺寸档里——实测破碎 p3/p6 都是这样）。
// 所以不靠字典认它，**靠版式**：力度是一串**贴在一起、坐同一条基线**的字母，
// 其中至少有一个是字典认得出的；旁边那些按**宽高**分是哪个字母。
import type { Sym } from "../staffomr/model";
import type { ContourMap } from "./contour";
import type { RasterUnit } from "./staffline";

export interface RasterDynamic {
  /** 记号的左端 x 与纵向中心（`attachDynamicTexts` 按它找最近的音符）。 */
  px: number;
  py: number;
  /** 拼出来的力度文本（`f` / `mf` / `ff` / `mp`…）。 */
  text: string;
  /** 整串字母的墨迹框（像素） */
  box?: { left: number; right: number; top: number; bottom: number };
}

/**
 * 字母之间的间隙。力度字母是**斜体、连着写**的：实测 `mf` 的两个块在 x 上还**重叠**
 * （`m` 的右缘越过 `f` 的左缘 9 px）。而歌词里紧挨着的汉字有半格以上的字距
 * ——实测宁静 p2 那个 `f` 右边 0.5 格处就是「在」字，照 0.7 格的间隙会把它拼成 `ff`。
 * 所以间隙的上限卡在**贴着**（0.15 格），下限允许重叠 0.8 格。
 */
const GAP_MAX = 0.15;
const GAP_MIN = -0.8;
/** 两个字母的**纵向中心**差上限（斜体 `f` 上下都出头，底边对不齐，中心才齐）。 */
const CY_TOL = 0.4;
/** 相对锚字母的高度比：`m`/`p` 只有一截 x 高，另一个 `f` 与锚同高。 */
const SHORT_RATIO: [number, number] = [0.33, 0.62];
const TALL_RATIO: [number, number] = [0.85, 1.15];

/** 按宽高判这个块是哪个力度字母（`hr` = 相对锚字母的高度比）。判不出返回 null。 */
function letterOf(w: number, h: number, hr: number): string | null {
  if (hr >= TALL_RATIO[0] && hr <= TALL_RATIO[1] && w >= 1.4 && w <= 2.8) return "f"; // 与锚同高：又一个 f
  if (hr >= SHORT_RATIO[0] && hr <= SHORT_RATIO[1] && w >= 1.4 && w <= 2.4) return "m"; // 扁而宽：m
  if (hr > SHORT_RATIO[1] && hr < TALL_RATIO[0] && w >= 0.9 && w <= 1.8) return "p"; // x 高加一条下伸：p
  void h;
  return null;
}

/**
 * 把字典认出来的力度块与紧挨着的字母块拼成记号。
 *
 * **只从字典认出来的块往外长**，不凭空认一串字母：`m`/`p` 那种形状在谱面上遍地都是
 * （符头、歌词偏旁），单独判必然过检。一串里有一个字典认得出的字母当锚，才算数。
 */
export function groupDynamics(anchors: Sym[], map: ContourMap, unit: RasterUnit): RasterDynamic[] {
  const sp = unit.space;
  const out: RasterDynamic[] = [];
  const used = new Set<Sym>();
  const sorted = [...anchors].sort((a, b) => a.box.left - b.box.left);
  for (const a of sorted) {
    if (used.has(a)) continue;
    const aw = (a.box.right - a.box.left) / sp;
    const ah = (a.box.bottom - a.box.top) / sp;
    const acy = (a.box.top + a.box.bottom) / 2;
    // `dynamicMP` 是**一个字形就是「mp」**，不必再拼
    if (a.code === "dynamicMP") {
      out.push({ px: a.box.left, py: acy, text: "mp", box: { left: a.box.left, right: a.box.right, top: a.box.top, bottom: a.box.bottom } });
      continue;
    }
    // 锚自己是哪个字母：字典把 `m` 也归进 `dynamicForte` 类（实测距离 71~98，
    // 而真 `f` 只有 19），所以不认字典给的名，按宽高自己判。
    const own = ah >= 2.0 ? "f" : ah <= 1.5 && aw >= 1.4 ? "m" : "p";
    let left = a.box.left;
    let right = a.box.right;
    let top = a.box.top;
    let bottom = a.box.bottom;
    const parts: { x: number; ch: string }[] = [{ x: a.box.left, ch: own }];
    const refH = own === "f" ? ah : ah / 0.45; // 锚是 m 时，按 x 高反推那一串的字号
    for (let again = true; again; ) {
      again = false;
      for (const c of map.contours) {
        const b = c.bbox;
        if (parts.some((p) => Math.abs(p.x - b.x) < 1)) continue;
        if (Math.abs(b.y + b.h / 2 - acy) > sp * CY_TOL) continue;
        const gapL = (left - (b.x + b.w)) / sp;
        const gapR = (b.x - right) / sp;
        const near = (gapL >= GAP_MIN && gapL <= GAP_MAX) || (gapR >= GAP_MIN && gapR <= GAP_MAX);
        if (!near) continue;
        const ch = letterOf(c.w, c.h, c.h / refH);
        if (!ch) continue;
        parts.push({ x: b.x, ch });
        left = Math.min(left, b.x);
        right = Math.max(right, b.x + b.w);
        top = Math.min(top, b.y);
        bottom = Math.max(bottom, b.y + b.h);
        again = true;
      }
    }
    // 串里的其它锚要一并标记掉（`ff` 的两个 `f` 都是锚，`mf` 的 `m` 也常是）。纵向也要落在这一串里：
    // 只看横向会把上下几行同一 x 上的力度一并吞掉（破碎 p11 女高二的 `f` 正在女高一那个的正下方）
    for (const b of sorted) if (b !== a && b.box.left >= left - 1 && b.box.right <= right + 1 && b.box.bottom > top && b.box.top < bottom) used.add(b);
    const text = parts.sort((p, q) => p.x - q.x).map((p) => p.ch).join("");
    if (!VALID.has(text)) continue; // 拼不出一个像样的力度就整个丢掉（宁可少，不可编）
    out.push({ px: left, py: acy, text, box: { left, right, top, bottom } });
  }
  return out;
}

/** 认得下的力度文本。拼出别的（`fm`、`mm`…）说明拼错了，整个丢掉。 */
const VALID = new Set(["p", "pp", "ppp", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp"]);

// ── 粘连的力度：拿本页认出的字形当模板在块里找 ─────────────────────────────
//
// 字典按**整块**查，力度一粘上别的墨就查不着了：`mp` 粘着圆滑线（破碎 p5 m49），`ff` 两个字母的横笔连成一笔
// （宁静 p8 m97，一整块）；也有本是单独一个 `f`、却先被别的判据认领、没进符号表的（宁静 p3 m41 `mf`）。
// 做法是先把认得的东西从块里拆出来、剩下的再认：本页字典已认出的 `f` 就是这本书这个字号的 `f`，
// 拿它的像素当模板在够大的块里滑窗——模板的墨**几乎全被盖住**、窗里多出来的墨不多（只是穿过的细弧、
// 相邻字母探进来的一角），就是一个 `f`。找到的 `f` 从块里扣掉，剩下的墨在同一条字行上按宽高认 `m`/`p`
// （与 `groupDynamics` 同一张 `letterOf`），拼不出 `VALID` 里的就不要。
//
// 模板取 `f`、`mp`，外加从 `mp` 里切出来的 `p`（字典里没有 `p` 类）；`m` 没有可借的，只在 `f` 旁边按宽高认。

/** 模板的墨被块盖住的比例下限。 */
const TPL_COVER = 0.9;
/** 窗里块多出来的墨（模板外扩一像素之外）占模板墨的比例上限。 */
const TPL_EXTRA = 0.45;
/** 同上，整字模板（`mp`、`p`）：不会有相邻字母探进窗里。 */
const TPL_EXTRA_WHOLE = 0.15;

interface InkTpl {
  w: number;
  h: number;
  /** 模板墨的像素偏移（相对窗左上角）。 */
  on: number[];
  /** 模板墨外扩一像素后的掩码（判「多出来的墨」用）。 */
  near: Uint8Array;
}

function inkTemplate(map: ContourMap, box: { left: number; right: number; top: number; bottom: number }): InkTpl | null {
  const x0 = Math.round(box.left), y0 = Math.round(box.top);
  const w = Math.round(box.right) - x0 + 1, h = Math.round(box.bottom) - y0 + 1;
  if (w < 4 || h < 4) return null;
  // 取盒里占墨最多的那个 contour（锚本身），别把探进盒角的邻居算进来
  const cnt = new Map<number, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const id = map.labels[(y0 + y) * map.w + x0 + x];
    if (id) cnt.set(id, (cnt.get(id) ?? 0) + 1);
  }
  const own = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!own) return null;
  const on: number[] = [];
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (map.labels[(y0 + y) * map.w + x0 + x] !== own) continue;
      on.push(y * w + x);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && xx >= 0 && yy < h && xx < w) near[yy * w + xx] = 1;
        }
    }
  return { w, h, on, near };
}

/** 一个模板在一个块里的落点。 */
interface TplHit {
  x: number;
  y: number;
  t: InkTpl;
  /** 这个模板是哪个字母（`f`），或者整个就是一个力度（`mp`）。 */
  ch: string;
}

/**
 * 模板 `t` 在块 `c` 里的落点：模板的墨漏不过一成，窗里多出来的墨（几个窗并起来算）不过 `TPL_EXTRA`。
 * `pair` 时单个窗说不通的，找并排的另一个落点一起算（`ff` 两个 f 的窗互相探进对方，单看一个窗多出半个 f）。
 */
function placeTemplate(map: ContourMap, c: { id: number; bbox: { x: number; y: number; w: number; h: number } }, t: InkTpl, pair: boolean, extraMax = TPL_EXTRA): { x: number; y: number }[] {
  const b = c.bbox;
  const maxMiss = Math.floor(t.on.length * (1 - TPL_COVER));
  const hits: { x: number; y: number; miss: number }[] = [];
  // 窗可以探出块盒几个像素（块的字号与模板差一两个像素，盒正好比模板矮一点）
  const pad = 3;
  const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad);
  const xEnd = Math.min(map.w, b.x + b.w + pad), yEnd = Math.min(map.h, b.y + b.h + pad);
  if (xEnd - x0 >= t.w && yEnd - y0 >= t.h) {
    // 窗能落到的像素先算好「本块或四邻是本块」：差一个像素的笔画不算漏（同一字形印两次，边缘常差一像素；
    // `p` 模板还是从 `mp` 里切出来的）。逐窗逐点查五次 labels 曾占识别耗时近一成
    const rw = xEnd - x0, rh = yEnd - y0;
    const ok = new Uint8Array(rw * rh);
    for (let yy = 0; yy < rh; yy++)
      for (let xx = 0; xx < rw; xx++) {
        const k = (y0 + yy) * map.w + x0 + xx;
        ok[yy * rw + xx] = map.labels[k] === c.id || map.labels[k - 1] === c.id || map.labels[k + 1] === c.id || map.labels[k - map.w] === c.id || map.labels[k + map.w] === c.id ? 1 : 0;
      }
    const offs = new Int32Array(t.on.length);
    for (let i = 0; i < t.on.length; i++) offs[i] = Math.floor(t.on[i] / t.w) * rw + (t.on[i] % t.w);
    for (let y = y0; y + t.h <= yEnd; y++)
      for (let x = x0; x + t.w <= xEnd; x++) {
        const at = (y - y0) * rw + x - x0;
        let miss = 0;
        for (let i = 0; i < offs.length; i++) {
          if (ok[at + offs[i]]) continue;
          if (++miss > maxMiss) break;
        }
        if (miss <= maxMiss) hits.push({ x, y, miss });
      }
  }
  // 非极大抑制：同一处附近一两个像素都中，留漏得最少的
  hits.sort((p, q) => p.miss - q.miss);
  const peaks: { x: number; y: number }[] = [];
  for (const h of hits) if (!peaks.some((f) => Math.abs(f.x - h.x) < t.w * 0.3 && Math.abs(f.y - h.y) < t.h * 0.3)) peaks.push(h);
  const extraOf = (fl: { x: number; y: number }[]): number => {
    const seen = new Set<number>();
    let extra = 0;
    for (const f of fl)
      for (let yy = 0; yy < t.h; yy++)
        for (let xx = 0; xx < t.w; xx++) {
          const k = (f.y + yy) * map.w + f.x + xx;
          if (seen.has(k) || map.labels[k] !== c.id) continue;
          seen.add(k);
          const inNear = fl.some((g) => {
            const gx = f.x + xx - g.x, gy = f.y + yy - g.y;
            return gx >= 0 && gy >= 0 && gx < t.w && gy < t.h && t.near[gy * t.w + gx];
          });
          if (!inNear) extra++;
        }
    return extra;
  };
  const lim = t.on.length * extraMax;
  const out: { x: number; y: number }[] = [];
  for (const h of peaks) {
    if (out.includes(h)) continue;
    if (extraOf([h]) <= lim) {
      out.push(h);
      continue;
    }
    if (!pair) continue;
    // 并排的另一个（同一条基线、错开半个到一个字宽）一起才说得通
    const mate = peaks.find((g) => g !== h && !out.includes(g) && Math.abs(g.y - h.y) <= 3 && Math.abs(g.x - h.x) >= t.w * 0.3 && Math.abs(g.x - h.x) <= t.w * 1.1 && extraOf([h, g]) <= lim);
    if (mate) out.push(h, mate);
  }
  return out;
}

/** 连写字形右边那个字母：中段（四成到七成宽）墨最少的那一列切开，取右边的墨。切口那列墨超过三成高的不切。 */
function rightPart(t: InkTpl): InkTpl | null {
  const col = new Array<number>(t.w).fill(0);
  for (const o of t.on) col[o % t.w]++;
  let cut = -1;
  for (let x = Math.floor(t.w * 0.4); x <= Math.ceil(t.w * 0.7); x++) if (cut < 0 || col[x] < col[cut]) cut = x;
  if (cut < 0 || col[cut] > t.h * 0.3) return null;
  const x0 = cut + 1;
  const ons = t.on.filter((o) => o % t.w >= x0);
  if (!ons.length) return null;
  let y0 = t.h, y1 = 0, x1 = 0;
  for (const o of ons) {
    const y = Math.floor(o / t.w);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    x1 = Math.max(x1, o % t.w);
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const on = ons.map((o) => (Math.floor(o / t.w) - y0) * w + (o % t.w) - x0);
  const near = new Uint8Array(w * h);
  for (const o of on) {
    const x = o % w, y = Math.floor(o / w);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < h && xx < w) near[yy * w + xx] = 1;
      }
  }
  return { w, h, on, near };
}

/** 取高度居中的那个当模板（字典偶尔把别的字号的同名字形也归进来）。 */
function medianTemplate(map: ContourMap, syms: Sym[]): InkTpl | null {
  if (!syms.length) return null;
  const s = [...syms].sort((a, b) => a.box.bottom - a.box.top - (b.box.bottom - b.box.top));
  return inkTemplate(map, s[Math.floor(s.length / 2)].box);
}

/**
 * 在字典没认出来的块里找粘连的力度。模板只取**本页**字典认出来的：`f`（当一个字母，连同同一条字行上
 * 贴着的 `m`/`p` 拼）、`mp`（整个就是一个力度，字典里 `mp` 是连写的一整块）。
 *
 * @param anchors 字典认出来的力度块
 * @param taken 已经认出来的力度（盒子）：与它们重叠的不再出
 */
export function findGluedDynamics(anchors: Sym[], map: ContourMap, unit: RasterUnit, taken: RasterDynamic[]): RasterDynamic[] {
  const sp = unit.space;
  const tpls: { t: InkTpl; ch: string }[] = [];
  const fT = medianTemplate(map, anchors.filter((a) => a.code === "dynamicForte" && (a.box.bottom - a.box.top) / sp >= 2.0));
  if (fT) tpls.push({ t: fT, ch: "f" });
  const mpT = medianTemplate(map, anchors.filter((a) => a.code === "dynamicMP"));
  if (mpT) tpls.push({ t: mpT, ch: "mp" });
  // 单独的 `p` 字典里没有，本页也难得有现成的——从 `mp` 那一整块里切出来：`m` 末一竖与 `p` 之间
  // 只连着一两个像素的细笔（中段墨最少的那一列），右边那截就是同一字体同一字号的 `p`（破碎 p2 m1）
  const pT = mpT ? rightPart(mpT) : null;
  if (pT) tpls.push({ t: pT, ch: "p" });
  if (!tpls.length) return [];
  const anchorIds = new Set<number>();
  for (const a of anchors) {
    const id = map.labels[Math.round((a.box.top + a.box.bottom) / 2) * map.w + Math.round((a.box.left + a.box.right) / 2)];
    if (id) anchorIds.add(id);
  }
  const out: RasterDynamic[] = [];
  const overlaps = (b: { left: number; right: number; top: number; bottom: number }) =>
    [...taken, ...out].some((d) => d.box && d.box.left < b.right && d.box.right > b.left && d.box.top < b.bottom && d.box.bottom > b.top);
  for (const c of map.contours) {
    const b = c.bbox;
    if (anchorIds.has(c.id) || b.w > sp * 40 || b.h > sp * 8) continue;
    // 块至少要装得下模板（字典本该认出、却因为被别的判据先认领没进符号表的单个 f 也在内：宁静 p3 m41）；
    // 太大的（整串符杠、大弧连着一片）不找
    const found: TplHit[] = [];
    for (const { t, ch } of tpls) {
      if (b.w < t.w * 0.9 || b.h < t.h * 0.9 || c.area < t.on.length * 0.9) continue;
      // `p` 只是一个圈带一竖：谱表里带干的符头、歌词字的一角都能盖住它——只认谱表外**单独成块**的
      // （块不比模板大四成）。`mp`、`p` 是整字模板，窗里多出来的墨也要少得多（真的 `mp` 粘了弧也是 0，
      // 符杠连干那一片盖住 `mp` 模板时多出三成多：破碎 p12）
      if (ch === "p" && (c.place.zone === "in" || b.w > t.w * 1.4 || b.h > t.h * 1.4)) continue;
      for (const p of placeTemplate(map, c, t, ch === "f", ch === "f" ? TPL_EXTRA : TPL_EXTRA_WHOLE)) found.push({ ...p, t, ch });
    }
    if (!found.length) continue;
    // 扣掉找到的字形，剩下的墨按连通块（4 邻接）在同一条字行上认字母
    const mask = new Uint8Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (map.labels[(b.y + y) * map.w + b.x + x] === c.id) mask[y * b.w + x] = 1;
    for (const f of found)
      for (let yy = 0; yy < f.t.h; yy++)
        for (let xx = 0; xx < f.t.w; xx++) {
          const my = f.y - b.y + yy, mx = f.x - b.x + xx;
          if (f.t.near[yy * f.t.w + xx] && my >= 0 && mx >= 0 && my < b.h && mx < b.w) mask[my * b.w + mx] = 0;
        }
    const rest = blobsOf(mask, b.w, b.h).map((r) => ({ x: r.x + b.x, y: r.y + b.y, w: r.w, h: r.h }));
    // 旁边单独成块的字母也算（`mf` 的 `m` 没粘上、只有 `f` 粘了别的：宁静 p3 m41）
    for (const o of map.contours) {
      if (o === c || anchorIds.has(o.id)) continue;
      const q = o.bbox;
      if (q.x > b.x + b.w + sp * 3 || q.x + q.w < b.x - sp * 3 || q.y > b.y + b.h || q.y + q.h < b.y) continue;
      rest.push({ x: q.x, y: q.y, w: q.w, h: q.h });
    }
    // 同一条字行上的几个字形各起一串（`ff` 两个 f 落在同一串里）；整个力度（`mp`）不再拼
    found.sort((p, q) => p.x - q.x);
    const used = new Set<number>();
    for (let i = 0; i < found.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const f = found[i];
      const cy = f.y + f.t.h / 2;
      let left = f.x, right = f.x + f.t.w - 1, top = f.y, bottom = f.y + f.t.h - 1;
      const parts: { x: number; ch: string }[] = [{ x: f.x, ch: f.ch }];
      const refH = fT?.h ?? f.t.h;
      for (let again = f.ch === "f"; again; ) {
        again = false;
        for (let j = 0; j < found.length; j++) {
          const g = found[j];
          if (used.has(j) || g.ch !== "f" || Math.abs(g.y + g.t.h / 2 - cy) > sp * CY_TOL) continue;
          if (g.x - right > sp * GAP_MAX || left - (g.x + g.t.w) > sp * GAP_MAX) continue;
          used.add(j);
          parts.push({ x: g.x, ch: "f" });
          left = Math.min(left, g.x);
          right = Math.max(right, g.x + g.t.w - 1);
          again = true;
        }
        for (const r of rest) {
          if (parts.some((p) => Math.abs(p.x - r.x) < 1)) continue;
          if (Math.abs(r.y + r.h / 2 - cy) > sp * CY_TOL) continue;
          const gapL = (left - (r.x + r.w)) / sp, gapR = (r.x - right) / sp;
          if (!((gapL >= GAP_MIN && gapL <= GAP_MAX) || (gapR >= GAP_MIN && gapR <= GAP_MAX))) continue;
          const ch = letterOf(r.w / sp, r.h / sp, r.h / refH);
          if (!ch) continue;
          parts.push({ x: r.x, ch });
          left = Math.min(left, r.x);
          right = Math.max(right, r.x + r.w - 1);
          top = Math.min(top, r.y);
          bottom = Math.max(bottom, r.y + r.h - 1);
          again = true;
        }
      }
      const text = parts.sort((p, q) => p.x - q.x).map((p) => p.ch).join("");
      if (!VALID.has(text)) continue;
      const box = { left, right, top, bottom };
      if (overlaps(box)) continue;
      out.push({ px: left, py: cy, text, box });
    }
  }
  return out;
}

/** 掩码里的 4 邻接连通块（盒）。块小，迭代式 flood fill 就够。 */
function blobsOf(mask: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const seen = new Uint8Array(w * h);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % w, y = (k - x) / w;
      n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const kk = yy * w + xx;
        if (mask[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); }
      }
    }
    if (n >= 8) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}
