// 认一页里的其余记号（`recognizeRasterPage` 按顺序调）：琶音、碎块并起来再查字典、终止线 / 段落线补成竖段、附点、认完符号后的几道收拾。

import type { Component, Binary, Rect } from "../../omrkit/types";
import { type RasterUnit, type StaffGroup, lineYAt, type StaffLineRun, LineGrid } from "../staffline";
import type { RasterPage } from "../rasterpage";
import type { RasterSym } from "../adapt";
import { ContourLedger } from "../ledger";
import { rowHasInk, overlapFrac } from "../../omrkit/geom";
import { isClef, isAccidental } from "../../staffomr/glyphs";
import { sharpsByStrokes, KEY_GAP } from "../keysig";
import { RasterGlyphLookup } from "../rasterglyphs";
import { type RasterPrims, binSig, type LineSeg } from "../prims";
import { judgeHeadBox, stemWalledCavity } from "../notehead";
import { isBarRest, nearRestLine, enclosedWhite } from "../restshape";
import { findDots } from "../dots";
import { MID_CLEF_FROM } from "./shared";

/** 临时记号的盒有这么大一部分落在一个空心头盒里，那个头不算（见「盖住一个临时记号大半的空心头」）。 */
const ACC_UNDER_HEAD = 0.5;
/** 碎块并回判出的空心头，封闭内腔（最大一块）占盒的下限。 */
const MERGE_HOLLOW_CAVITY = 0.05;

/** 符尾围出的「空心头」离干端不超过这么多格（见「符尾围出来的空心头不要」）。 */
const FLAG_REACH = 1.6;
/** 符尾判据里「另一端的实心头」离谱表首末线不超过这么多格。 */
const FLAG_HEAD_BAND = 2.5;
/** 符尾与干那端实心头的最小距离（格）。 */
const FLAG_GAP = 2.8;
/** 同上，内腔一侧直接就是干的（`stemWalledCavity`）放到这么多格；干端离它也只要这么远。 */
const FLAG_GAP_WALLED = 1.8;

/** **琶音记号**（和弦左边的竖波浪线） */
export function findArpeggios(c: {
  blobs: Component[];
  unit: RasterUnit;
  groups: StaffGroup[];
  nl: Binary;
  claimed: Set<number>;
  raster: RasterPage;
  syms: RasterSym[];
  ledger: ContourLedger;
}): {
  arpeggios: Rect[];
} {
  const { blobs, unit, groups, nl, claimed, raster, syms, ledger } = c;
  // ── **琶音记号**（和弦左边的竖波浪线）────────────────────────────────────
  //
  // 去线图上它是细长的块（宽半格上下、高两格半以上；贯穿谱表的被去谱线切开，只有谱表外那几截够高）。与符干、小节线、括号的分别是**左右摆**：
  // 逐行墨的中心一格一个周期地来回摆，直线（斜的也算）的中心是一条直线。逐行取墨的中心、减掉首尾连线，
  // 摆幅（九成分位减一成分位）要过 `ARP_SWING` 格；带半像素回差地数过零，每格的次数落在 `ARP_RATE` 里、间隔还要匀。
  // 只看逐行墨宽不行——直线上一像素的毛边也粗细交替（破碎干净版一页数出二十来条）。
  // 认出来的块里字典结果作废（波峰常被读成附点、休止的碎块），挂到和弦上的事在音符建好之后做。
  const arpeggios: Rect[] = [];
  for (const c of blobs) {
    const b = { ...c.bbox };
    const sp = unit.space;
    if (b.w > sp * ARP_W || b.h < sp * ARP_H) continue;
    if (!groups.some((q) => b.y < q.lines[4].y + sp * 2 && b.y + b.h > q.lines[0].y - sp * 2)) continue;
    const cs: number[] = [];
    let wide = 0;
    for (let y = b.y; y < b.y + b.h; y++) {
      let lo = -1;
      let hi = -1;
      for (let x = b.x; x < b.x + b.w; x++)
        if (nl.data[y * nl.w + x]) {
          if (lo < 0) lo = x;
          hi = x;
        }
      if (lo < 0) continue;
      cs.push((lo + hi) / 2);
      if (hi - lo + 1 > sp * ARP_STROKE) wide++;
    }
    if (cs.length < b.h * 0.8 || wide > cs.length * 0.1) continue;
    const res = cs.map((v, k) => v - (cs[0] + ((cs[cs.length - 1] - cs[0]) * k) / (cs.length - 1)));
    const sorted = [...res].sort((p, q) => p - q);
    const swing = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
    const mid = sorted[sorted.length >> 1];
    // 过零的位置：相邻两次之间隔半个周期
    const zs: number[] = [];
    let side = 0;
    res.forEach((v, k) => {
      const s1 = v > mid + 0.5 ? 1 : v < mid - 0.5 ? -1 : 0;
      if (s1 && side && s1 !== side) zs.push(k);
      if (s1) side = s1;
    });
    if (claimed.has(c.id)) continue;
    // 每格过零一次半到三次多（四分休止只拐两三道弯，直线上的毛边抖得更密）
    const rate = zs.length / (b.h / sp);
    if (swing < Math.max(1.5, sp * ARP_SWING) || rate < ARP_RATE[0] || rate > ARP_RATE[1]) continue;
    // 波浪是匀的：相邻两次过零的间隔在半格上下，六成以上的间隔离中位数不过六成（手写体刻谱的波浪不齐，是爱量得 5~12 像素）
    const gaps = zs.slice(1).map((z, k) => z - zs[k]).sort((p, q) => p - q);
    const gm = gaps[gaps.length >> 1] ?? 0;
    if (gaps.length < 3 || gm < sp * 0.25 || gm > sp * 0.75 || gaps.filter((g0) => Math.abs(g0 - gm) <= gm * 0.6).length < gaps.length * 0.6) continue;
    // 盒往上下接：谱表里的那几截被去谱线切成小段、不够高，没进上面的筛选。在带谱线的原图上沿这一竖条往两头走，
    // 连着有墨（容半格的断口）走到哪儿算到哪儿
    {
      const bin0 = raster.bin;
      const rowInk = (y: number) => rowHasInk(bin0, y, b.x - 1, b.x + b.w);
      let top = b.y;
      for (let y = b.y - 1, miss = 0; y >= 0 && miss < sp * 0.5; y--) {
        if (rowInk(y)) (top = y), (miss = 0);
        else miss++;
      }
      let bottom = b.y + b.h - 1;
      for (let y = bottom + 1, miss = 0; y < bin0.h && miss < sp * 0.5; y++) {
        if (rowInk(y)) (bottom = y), (miss = 0);
        else miss++;
      }
      // 同一条波浪线的另一截已经收过了
      if (arpeggios.some((q) => Math.abs(q.x - b.x) <= sp && q.y <= bottom && q.y + q.h >= top)) continue;
      b.y = top;
      b.h = bottom - top + 1;
    }
    arpeggios.push(b);
    claimed.add(c.id);
    for (let i = syms.length - 1; i >= 0; i--) {
      const s0 = syms[i].box;
      const cx0 = s0.x + s0.w / 2;
      const cy0 = s0.y + s0.h / 2;
      if (cx0 >= b.x - 1 && cx0 <= b.x + b.w + 1 && cy0 >= b.y - 1 && cy0 <= b.y + b.h + 1) syms.splice(i, 1);
      // 符头不会压着波浪线：横向三成以上叠在线上的头是小节线与波浪线之间的白读成的空心头（是爱 p3 m32 两个）
      else if (/^notehead/.test(syms[i].code) && cy0 >= b.y && cy0 <= b.y + b.h && Math.min(s0.x + s0.w, b.x + b.w) - Math.max(s0.x, b.x) >= s0.w * 0.3) syms.splice(i, 1);
    }
    ledger.claim(b, "arpeggio");
  }

  // **调号按竖笔补认升号**（`sharpsByStrokes`）：全页至少两行、且过半的行数出同样多个升号才采信，
  // 采信后每行数出的升号盖掉那一段里别的认法（被读成降号串、假符头的碎块）。44 首里它从不多数
  // （降号曲全是 0，升号曲都不超过 GT，粘连升号的《耶和华是我的牧者》每行 2 个），少数由 `shareKeySignature` 补齐。
  {
    const clefOf = (g: (typeof groups)[number]) =>
      syms.find((s0) => isClef(s0.code) && s0.box.y + s0.box.h / 2 > g.lines[0].y && s0.box.y + s0.box.h / 2 < g.lines[4].y && s0.box.x < Math.max(...g.lines.map((l) => l.left)) + unit.space * 4);
    const found = groups.map((g) => {
      const c = clefOf(g);
      return c ? sharpsByStrokes(raster.bin, g.lines.map((l) => lineYAt(l, c.box.x + c.box.w + unit.space)), c.box, unit.space) : [];
    });
    const tally = new Map<number, number>();
    for (const f of found) if (f.length) tally.set(f.length, (tally.get(f.length) ?? 0) + 1);
    const [k, n] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    if (k && n >= 2 && n * 2 >= groups.length)
      for (const f of found) {
        if (!f.length) continue;
        const span: Rect = { x: f[0].x, y: Math.min(...f.map((b) => b.y)), w: f[f.length - 1].x + f[f.length - 1].w - f[0].x, h: 0 };
        span.h = Math.max(...f.map((b) => b.y + b.h)) - span.y;
        for (let i = syms.length - 1; i >= 0; i--) {
          const b = syms[i].box;
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          if (!isClef(syms[i].code) && cx >= span.x && cx <= span.x + span.w && cy >= span.y && cy <= span.y + span.h) syms.splice(i, 1);
        }
        for (const b of f) {
          syms.push({ box: b, code: "accidentalSharp" });
          ledger.claim(b, "key:accidentalSharp");
        }
        for (const c of blobs) {
          const cx = c.bbox.x + c.bbox.w / 2;
          const cy = c.bbox.y + c.bbox.h / 2;
          if (cx >= span.x && cx <= span.x + span.w && cy >= span.y && cy <= span.y + span.h) claimed.add(c.id);
        }
      }
  }
  return { arpeggios };
}

/** 碎块并起来再查一次字典 */
export function relookMergedFragments(c: {
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  flatPieces: Set<number>;
  syms: RasterSym[];
  look: RasterGlyphLookup;
  unit: RasterUnit;
  prims: RasterPrims;
  inBand: (y: number, x?: number) => boolean;
  repaired: Binary;
  staffLines: StaffLineRun[];
  besideStem: (b: Rect) => boolean;
  beamStump: (b: Rect, others: Rect[]) => boolean;
  ledger: ContourLedger;
  rBlobs: Component[];
  rBlobParts: Map<number, Set<number>>;
  nl: Binary;
}): {
  merged: Set<number>;
} {
  const { blobs, claimed, dictClaimed, flatPieces, syms, look, unit, prims, inBand, repaired, staffLines, besideStem, beamStump, ledger, rBlobs, rBlobParts, nl } = c;
  // ── 碎块并起来再查一次字典 ────────────────────────────────────────────────
  //
  // 谱号那一路证明了这条：符号常被自己的笔画切开（中央竖笔、两道横笔被当成原语抽走），
  // 按连通块查字典就只看到半截。休止符与升降号同理——它们也压在谱线上、也有细笔画。
  // 把**x 上重叠、上下又贴着**的未识别块并起来（谱线间距的四成以内算贴着），
  // 并完再查一次；查得到才认。x 分开的不并（那是相邻的两个符号）。
  const unmatched = blobs.filter((c) => !claimed.has(c.id) && (!dictClaimed.has(c.id) || flatPieces.has(c.id)));
  const merged = new Set<number>();
  /** 并出来的盒按 `img` 再查一次；查得到、过了位置闸才认 */
  const tryMerged = (box: Rect, group: number[], img: Binary): boolean => {
    // 已经认出来的符号压着的不再并（被谱线切开的八分休止，球那一块认过了、斜笔那块还剩着）
    if (syms.some((q) => overlapFrac(q.box, box) > 0.3)) return false;
    // 字典认不出就**按性质判一次符头**：空心符头骑在谱线上时会被去谱线切成两截，
    // 两截都不成符头、字典里也没有二分符头的类（见 `judgeHeadBox`）。
    const code = look.lookup(binSig(img, box), box.w / unit.space, box.h / unit.space) ?? judgeHeadBox(img, box, unit, prims.vSegs, inBand);
    if (!code) return false;
    // 全 / 二分休止只贴在一条线的一侧，不会被谱线切开：修补图上连成一块的是休止挨着别的墨（主我敬拜你 m3 多出一个全休止）
    if (img === repaired && isBarRest(code)) return false;
    // 位置闸与字典那一路一样：并出来的扁块也要贴着第二、三线
    if (isBarRest(code) && (!nearRestLine(box, staffLines, unit) || besideStem(box))) return false;
    if (code === "noteheadBlack" && beamStump(box, syms.filter((s0) => /^notehead/.test(s0.code)).map((s0) => s0.box))) return false;
    // 并出来的空心头要有**封闭的内腔**（在去线图 / 修补图上量，谱线不算圈）：全音符下沿与谱线之间的空当也像个腔，谱线一去就通到外面了
    //（我灵镇静 m8 加一线上 C4 全音符底下拼出一个 A3）。窗口只外扩 2 像素，别把上面那个全音符自己的内腔框进来
    // 全音符同理（贴着谱线的一小段弧，修补后整块像个扁圆，破碎扫描版 p1 m2）
    if ((code === "noteheadHalf" || code === "noteheadWhole") && enclosedWhite(img, { left: box.x, right: box.x + box.w, top: box.y, bottom: box.y + box.h }, unit.space, 2) < box.w * box.h * MERGE_HOLLOW_CAVITY) return false;
    for (const id of group) merged.add(id);
    syms.push({ box, code });
    ledger.claim(box, `merge:${code}`);
    return true;
  };
  // 先按**修补图**并：修补图上连成一块、碎块全没认出来的，整块在修补图上查（被谱线切开的符号）
  {
    const free = new Set(unmatched.map((c) => c.id));
    for (const rb of rBlobs) {
      const ids = [...(rBlobParts.get(rb.id) ?? [])];
      if (ids.length < 2 || !ids.every((id) => free.has(id) && !merged.has(id))) continue;
      tryMerged(rb.bbox, ids, repaired);
    }
  }
  // 修补图没连上的（被竖笔、横段抽取切开的）：把**x 上重叠、上下又贴着**的未识别块并起来（谱线间距的四成以内算贴着）
  for (const a of unmatched) {
    if (merged.has(a.id)) continue;
    let box = { ...a.bbox };
    const group = [a.id];
    for (let again = true; again; ) {
      again = false;
      for (const b of unmatched) {
        if (group.includes(b.id) || merged.has(b.id)) continue;
        const r = b.bbox;
        // x 不重叠的不并；只差一像素的算相接（破碎 p2 m6 降号的竖笔与肚子被去线切开，竖笔右缘与肚子左缘隔一列）
        if (r.x > box.x + box.w + 1 || r.x + r.w < box.x - 1) continue;
        const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
        if (gap > unit.space * 0.4) continue;
        const x0 = Math.min(box.x, r.x);
        const y0 = Math.min(box.y, r.y);
        box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
        group.push(b.id);
        again = true;
      }
    }
    if (group.length < 2) continue;
    tryMerged(box, group, nl);
  }
  return { merged };
}

/** 终止线/段落线：纵贯谱表的**实心条**补成竖段 */
export function completeFinalBars(c: {
  unit: RasterUnit;
  blobLabels: Int32Array;
  nl: Binary;
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  merged: Set<number>;
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  syms: RasterSym[];
  prims: RasterPrims;
  ledger: ContourLedger;
  sharpAsHeads: (ss: RasterSym[], edge: number, onStaff: (r: Rect) => boolean) => { heads: RasterSym[]; box: Rect; } | null;
}): void {
  const { unit, blobLabels, nl, blobs, claimed, dictClaimed, merged, groups, yAt, syms, prims, ledger, sharpAsHeads } = c;
  // ── 终止线/段落线：纵贯谱表的**实心条**补成竖段 ────────────────────────────
  //
  // 「细 + 粗」双线里那根粗线有 0.6 格宽，过不了竖段的宽度闸；紧贴着它的细线
  // 又过不了孤立性判据——两根都成了没人认领的块，小节线那一步看不见它们。
  // 《善牧恩慈歌》延长记号后、「阿们」之前那道双线就这样丢了，后面一小节并进了前一小节。
  // 判据：上下两端贴着五线的顶线与底线（各 0.4 格内）、宽不过一格、填充八成以上。
  // **填充率不算两端各两个线厚**：竖条两端落在谱线上，去线后交点那几行常留一圈毛边，盒子被撑宽
  //（新编 327 末行首根小节线 5px，底端四行 7px，整盒填充 0.72）。推平前这几行恰好被移位削掉，
  // 不推平就得自己让开。
  const solidFill = (c: Component): number => {
    const b = c.bbox;
    const cut = Math.round(unit.lineThick * 2);
    let n = 0, lo = Infinity, hi = -Infinity;
    for (let y = b.y + cut; y < b.y + b.h - cut; y++)
      for (let x = b.x; x < b.x + b.w; x++)
        if (blobLabels[y * nl.w + x] === c.id) n++, (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
    return n ? n / ((hi - lo + 1) * (b.h - cut * 2)) : 0;
  };
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space || solidFill(c) < 0.8) continue;
    const g = groups.find((g0) => Math.abs(b.y - yAt(g0, 0, b.x + b.w / 2)) <= unit.space * 0.4 && Math.abs(b.y + b.h - yAt(g0, 4, b.x + b.w / 2)) <= unit.space * 0.4);
    if (!g) continue;
    if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
    const x = b.x + b.w / 2;
    prims.vSegs.push({ x0: x, y0: b.y, x1: x, y1: b.y + b.h, lw: b.w, maxLw: b.w });
    merged.add(c.id);
    ledger.claim(b, "bar:thick");
  }

  // **谱号左边（和正下方）没有音符**、谱号右边紧挨着的「符头」可能是调号：花括号、方括号的弯钩落在谱表上下，圆滚滚的像个全音符
  // （《赞美一神》第二行低音谱表顶上那一个，出了个 G3 全音符）。
  for (const g of groups) {
    // 行首那一段：弯、斜的谱行取左缘往右四格处的线位
    const kx = Math.max(...g.lines.map((l) => l.left)) + unit.space * 4;
    const t0 = yAt(g, 0, kx);
    const b4 = yAt(g, 4, kx);
    const top = t0 - unit.space * 2;
    const bottom = b4 + unit.space * 2;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < b4 && s0.box.y + s0.box.h > t0);
    if (!clef) continue;
    // 调号兜底之后才摘出来的「符头」（符头连符干那一路把升号的竖笔当成符干）再验一次
    const onStaff = (r: Rect) => r.y < b4 && r.y + r.h > t0;
    const edge = clef.box.x + clef.box.w;
    if (!syms.some((s0) => isAccidental(s0.code) && onStaff(s0.box) && s0.box.x >= edge - 1 && s0.box.x < edge + unit.space * KEY_GAP)) {
      const pair = sharpAsHeads(syms, edge, onStaff);
      if (pair) {
        for (const s0 of pair.heads) syms.splice(syms.indexOf(s0), 1);
        syms.push({ box: pair.box, code: "accidentalSharp" });
        ledger.claim(pair.box, "key:accidentalSharp");
      }
    }
    for (let i = syms.length - 1; i >= 0; i--) {
      const b = syms[i].box;
      // 中心在谱号**右缘**以左的都不要：谱号正下方也没有音符，高音谱号下端的弯钩被切出来就是个「头」
      //（《所信有根基》每行开头多一个 C4）
      if (/notehead/i.test(syms[i].code) && b.x + b.w / 2 < clef.box.x + clef.box.w && b.y + b.h / 2 >= top && b.y + b.h / 2 <= bottom) syms.splice(i, 1);
    }
  }
}

/** 附点：**位置 + 形状自举**，字典兜不住 */
export function findAugDots(c: {
  nl: Binary;
  syms: RasterSym[];
  unit: RasterUnit;
  staffYs: (x: number) => number[][];
  grid: LineGrid;
  ledger: ContourLedger;
  prims: RasterPrims;
  raster: RasterPage;
  staffGeoms: { left: number; right: number; top: number; bottom: number; topAt: (x: number) => number; bottomAt: (x: number) => number; lift: ((x: number) => number) | undefined; }[];
}): void {
  const { nl, syms, unit, staffYs, grid, ledger, prims, raster, staffGeoms } = c;
  // ── 附点：**位置 + 形状自举**，字典兜不住 ─────────────────────────────────
  //
  // 附点在位图路原先只靠字典认（`augmentationDot`），字典是在线距 15~19px 的合唱谱上建的：
  // 《是谁》线距 50px，附点直径 18px，还被横段那一步连着符头的边抽成了一截横线；
  // 《善牧恩慈歌》线距 11px，附点只有 3px。两首的附点二分、附点四分一个都没认出来。
  // 附点的位置是死的：符头右边一格之内、同一个间（线上的音写在上方那个间）。
  // 在去谱线图上找那个窗口里**孤立、近圆的小墨团**，找到就补一个附点，时值交给 `attachDots`。
  for (const d of findDots(nl, syms, unit, staffYs, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x))) {
    syms.push({ box: d, code: "augmentationDot" });
    ledger.claim(d, "dot:augmentationDot");
  }
  // 附点休止：休止右边的点同一个窗口找（破碎 p4 m32 钢琴右手附点八分休止）
  {
    const rests = syms.filter((s0) => s0.code === "rest8th" || s0.code === "rest16th" || s0.code === "restQuarter");
    if (rests.length)
      for (const d of findDots(nl, syms, unit, staffYs, (y: number, x?: number) => grid.onLine(y, unit.lineThick, x), rests)) {
        if (syms.some((s0) => s0.code === "augmentationDot" && overlapFrac(s0.box, d) > 0)) continue;
        syms.push({ box: d, code: "augmentationDot" });
        ledger.claim(d, "dot:augmentationDot");
      }
  }

  // **大半落在升降号盒里的符头不要**：调号升号认出来了，同一块又被拆块那一路拆出两个「头」
  //（《向主唱新歌》两行行首的 F♯ 各多出一个 G5）。临时记号只挨着符头左边，交叠不到七成。
  {
    const accs = syms.filter((s0) => isAccidental(s0.code));
    for (let i = syms.length - 1; i >= 0; i--)
      if (/^notehead/.test(syms[i].code) && accs.some((a) => overlapFrac(syms[i].box, a.box) > 0.7)) syms.splice(i, 1);
  }

  // **符尾围出来的「空心头」不要**：干朝下的八分音符，干底向右弯回的符尾围出一个内腔，
  // 按内腔找的几路把它收成空心二分头（《所信有根基》低音谱表每小节多一个 A2/F2 二分）。
  // 一根干只在一端挂头（同一根干上时值只有一种）：另一端已挂着实心头，这一端就只能是符尾。
  {
    const sp = unit.space;
    const blacks = syms.filter((s0) => s0.code === "noteheadBlack");
    // 干被符头、谱线切成几段：同一 x、缺口不到一格的接成一根
    const joined: LineSeg[] = [];
    for (const q of [...prims.vSegs].sort((a, b) => Math.min(a.y0, a.y1) - Math.min(b.y0, b.y1))) {
      const x = (q.x0 + q.x1) / 2;
      const prev = joined.find((j) => Math.abs((j.x0 + j.x1) / 2 - x) <= unit.lineThick && Math.min(q.y0, q.y1) - j.y1 <= sp);
      if (prev) prev.y1 = Math.max(prev.y1, q.y0, q.y1);
      else joined.push({ ...q, y0: Math.min(q.y0, q.y1), y1: Math.max(q.y0, q.y1) });
    }
    const bin = raster.bin;
    /** 从 y 沿 x 列（左右各容一个线宽）往 dir 方向走墨，断口不过 3 像素，返回走到的最远 y。 */
    const walk = (x: number, y: number, dir: number): number => {
      let last = y;
      for (let yy = y, miss = 0; miss <= 3 && yy >= 0 && yy < bin.h; yy += dir) {
        let on = false;
        for (let xx = Math.round(x - unit.lineThick); xx <= Math.round(x + unit.lineThick) && !on; xx++) on = xx >= 0 && xx < bin.w && bin.data[yy * bin.w + xx] === 1;
        if (on) {
          last = yy;
          miss = 0;
        } else miss++;
      }
      return last;
    };
    const isFlag = (b: Rect) => {
      const cy = b.y + b.h / 2;
      // 内腔一侧直接就是干的（尾弯回干围出的白），干短也认：手写谱的干只有两格来长（是爱 p3 m36、p4 m56 低音 E3 朝下的八分，
      // 尾梢围出的白离头两格、干全长 2.4 格，收成 A2 二分把那个八分也带成了二分）。实心头与空心头本就不会挂同一根干
      let walledB: boolean | undefined;
      const walled = () => (walledB ??= stemWalledCavity(bin, b, sp, true));
      return joined.some((q) => {
        if (q.y1 - q.y0 < sp * 1.5) return false;
        const sx = (q.x0 + q.x1) / 2;
        if (sx < b.x - sp * 0.3 || sx > b.x + b.w + sp * 0.3) return false;
        if (cy < q.y0 - sp * FLAG_REACH || cy > q.y1 + sp * FLAG_REACH) return false;
        // 两头都顺着墨走，取离它远的那一端（干被切剩的一截两端离它都近，按近端判方向会判反）
        const up = walk(sx, q.y0, -1);
        const dn = walk(sx, q.y1, 1);
        const far = cy - up > dn - cy ? up : dn;
        if (Math.abs(far - cy) < sp * 2.5 && !(Math.abs(far - cy) >= sp * FLAG_GAP_WALLED && walled())) return false;
        // 远端的头要在谱表近旁：干的墨顺着断口接进下方歌词，字的笔画也被认成过实心头（齐来崇拜「能」）
        const nearStaff = (y: number) => staffGeoms.some((g) => y > g.topAt(sx) - sp * FLAG_HEAD_BAND && y < g.bottomAt(sx) + sp * FLAG_HEAD_BAND);
        // 符尾离那根干上的头至少三格多（所信有根基 3.5~4 格）；两格上下的是和弦里另一个头
        //（来敬拜荣耀王加线上的空心头被误认成实心，离上面那个空心头只隔两格）
        return blacks.some((h) => {
          const hy = h.box.y + h.box.h / 2;
          return Math.abs(h.box.x + h.box.w / 2 - sx) < sp * 1.3 && Math.abs(hy - far) < sp && (Math.abs(hy - cy) >= sp * FLAG_GAP || (Math.abs(hy - cy) >= sp * FLAG_GAP_WALLED && walled())) && nearStaff(hy);
        });
      });
    };
    for (let i = syms.length - 1; i >= 0; i--)
      if ((syms[i].code === "noteheadHalf" || syms[i].code === "noteheadWhole") && isFlag(syms[i].box)) syms.splice(i, 1);
  }
}

/** 符号收尾：盖住临时记号的空心头、行中谱号只信验过的、杠端落在小节线上补干 */
export function tidySymbols(c: {
  syms: RasterSym[];
  midClefs: Set<RasterSym>;
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  unit: RasterUnit;
  prims: RasterPrims;
}): {
  headBoxes: { box: Rect; }[];
  barStems: LineSeg[];
} {
  const { syms, midClefs, groups, yAt, unit, prims } = c;
  // ── 符号收尾：盖住临时记号的空心头、行中谱号只信验过的、杠端落在小节线上补干
  // **盖住一个临时记号大半的空心头**是记号的竖笔、谱线与右边的头围出的那块白（是爱 p1 m14 手写降号与 B♭4/D5 之间，
  // 凸度 0.78、过了「上下贴线的凹孔」那道），真头只挨着记号，盖不到它一半
  for (let i = syms.length - 1; i >= 0; i--) {
    const s0 = syms[i];
    if (s0.code !== "noteheadHalf") continue;
    if (!syms.some((a) => isAccidental(a.code) && overlapFrac(a.box, s0.box) > ACC_UNDER_HEAD)) continue;
    syms.splice(i, 1);
  }
  // 行中的谱号只信「行中换谱号」那一路验过的：字典按块查出来的行中「谱号」多是误认（万古磐石歌八分二度连干带尾认成高音谱号），
  // 从前每行只用行首那个、它们不起作用；现在音高按位置取谱号，留着就把后半行读错
  for (let i = syms.length - 1; i >= 0; i--) {
    const s0 = syms[i];
    if (!isClef(s0.code) || midClefs.has(s0)) continue;
    const cy = s0.box.y + s0.box.h / 2;
    const sx = s0.box.x + s0.box.w / 2;
    const g = groups.find((q) => cy > yAt(q, 0, sx) - unit.space && cy < yAt(q, 4, sx) + unit.space);
    if (g && s0.box.x >= Math.max(...g.lines.map((l) => l.left)) + unit.space * MID_CLEF_FROM) syms.splice(i, 1);
  }
  const headBoxes = syms.filter((s0) => /notehead/i.test(s0.code)).map((s0) => ({ box: s0.box }));
  // **杠端落在小节线上：那里藏着一根干**。小节线不接符杠；小节末那个音的干离小节线只有两三像素时，
  // 抽竖段把两根并成了一根（破碎 p8 m77 钢琴右手 F4 十六分，干在小节线左边 3 像素），那个头没干、被并进前一个音的和弦。
  // 杠的一端落在一根纵贯谱表的竖线上、竖线左边紧贴着一个头（朝上的干贴头右缘）：从杠端到头心补一根干
  const barStems: LineSeg[] = [];
  {
    const tol = Math.max(3, unit.lineThick * 2);
    for (const q of prims.beams) {
      const ex = q.box.x + q.box.w;
      const ey = q.box.y + q.box.h;
      const bar = prims.vSegs.find((v) => {
        const vx = (v.x0 + v.x1) / 2;
        if (Math.abs(vx - ex) > tol) return false;
        const top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
        // 纵向要贴着这条杠（杠端在竖线上端附近）
        if (top > ey + unit.space || bot < ey + unit.space) return false;
        return groups.some((g) => top <= yAt(g, 0, vx) + unit.space * 0.3 && bot >= yAt(g, 4, vx) - unit.space * 0.3 && yAt(g, 0, vx) < ey + unit.space * 2 && yAt(g, 4, vx) > q.box.y);
      });
      if (!bar) continue;
      const bx = (bar.x0 + bar.x1) / 2;
      const h = headBoxes.find((hb) => hb.box.x + hb.box.w >= bx - tol - unit.space * 0.3 && hb.box.x + hb.box.w <= bx + 1 && hb.box.y > ey && hb.box.y < ey + unit.space * 5 && hb.box.y < Math.max(bar.y0, bar.y1));
      if (!h) continue;
      const x = Math.min(bx - 2, ex, h.box.x + h.box.w);
      const had = barStems.find((v) => Math.abs(v.x0 - x) < 2 && v.y1 === h.box.y + h.box.h / 2);
      if (had) had.y0 = Math.min(had.y0, q.box.y);
      else barStems.push({ x0: x, y0: q.box.y, x1: x, y1: h.box.y + h.box.h / 2, lw: unit.lineThick, maxLw: unit.lineThick });
    }
  }
  return { headBoxes, barStems };
}
/** 琶音记号（竖波浪线）：块宽上限、高下限（格），逐行墨宽上限（格）。挂和弦时往右找几格见 `pagefinish.ts` 的 ARP_REACH。 */
const ARP_W = 0.6;
const ARP_H = 2.5;
const ARP_STROKE = 0.7;
/** 逐行墨中心的摆幅下限（格）、每格过零次数的范围。 */
const ARP_SWING = 0.1;
const ARP_RATE = [1.5, 3.2];
