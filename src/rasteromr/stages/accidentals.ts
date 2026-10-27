// 认一页里的升降还原号与调号（`recognizeRasterPage` 按顺序调）：并排粘连的两个切开、被抽走的竖笔并回、调号按位置兜底与按竖笔数再定、
// 谱中被当成符头的升号、没人认领的按位置配模板、降号盒收到肚子、头左边贴着的再查一次。

import type { Binary, Rect, Component } from "../../omrkit/types";
import { type RasterUnit, type StaffGroup, lineYAt } from "../staffline";
import { RasterGlyphLookup, type BootStaff, bootstrapClefs, matchTemplate } from "../rasterglyphs";
import type { RasterSym } from "../adapt";
import { ContourLedger } from "../ledger";
import type { RasterPage } from "../rasterpage";
import { binSig, verticalStrokes, type LineSeg, type RasterPrims } from "../prims";
import { isAccidental, isClef, timeSigDigit, type SmuflName } from "../../staffomr/glyphs";
import { overlapFrac, unionRect as union } from "../../omrkit/geom";
import { vRunAt } from "../stems";
import { crossRuns, tallStrokes, longestVRun, splitAt, sharpShape, sharpCrossbars, crossbarAccidental, crossbarAccidentalBox, flatAccidentalBox } from "../restshape";
import { KEY_GAP, KEY_GAP_FIRST, LOOSE_ACC_GAP } from "../keysig";
import { sigDistance } from "../../omrkit/glyphdict";
import { TIME_TEMPLATE_DIST, solidInside } from "./shared";
import { connectedComponents } from "../../omrkit/ccl";

/** 并排两个临时记号粘成的块至多这么宽（格）。 */
const ACC_PAIR_W = 2.4;
/** 头左边找临时记号的窗：往左这么多格、上下各这么多格。 */
const ACC_PROBE_W = 1.4;
const ACC_PROBE_H = 1.7;
/** 窗往上多开到这么多格：降号的竖笔从肚子中心往上就有 1.75 格，顶端碰到窗上沿会被当邻音扣掉（爱是从神而来 p5 m60 右手 ♭）。 */
const ACC_PROBE_UP = 2.1;
const ACC_PROBE_SHARP_H = 2.8;
/** 窄过这么多格的临时记号是半截。 */
const ACC_HALF_W = 0.45;
/** 记号盒中与头心差不过这么多格算这个头的（降号盒这时已收到肚子上，见 `FLAT_BOWL_TOP`）。 */
const ACC_OWN_DY = 0.45;

/** 降号的肚子从盒顶往下第几成开始。取 0.45：盒高 2.36 格时中心正好下移 0.53 格，
 *  与实测的 0.55 格偏差吻合。 */
const FLAT_BOWL_TOP = 0.45;

/** 升降号「并回竖笔」之后与模板的签名距离上限。比通用的 90 松一点：
 *  并回来的盒是块的包围盒 + 竖段的中心线拼出来的，边界不如原块齐整。 */
const ACCID_TEMPLATE_DIST = 90;
/** 紧跟谱号的**调号位置**上再放宽到这一档：颂赞与尊贵的调号降号是细网点印的，并回竖笔后
 *  距离 95。全页一律放宽的话合唱谱干净档多认假降号（小节自检 59.5 → 59.02）。 */
const KEY_ACCID_TEMPLATE_DIST = 100;
/** 调号串里后一个记号的左缘可以伸进前一个右缘多少格。 */
const KEY_OVERLAP = 0.5;
/** 调号串里按「前一个记号」认下一个的签名距离上限（同一本同一种记号，比模板近得多）。 */
const KEY_SELF_DIST = 120;
/** 结构还原号：两根竖笔的间距（格）。 */
const NAT_GAP = [0.35, 0.8] as const;
/** 粘连升号串（见谱号兜底那段）：盒高上限、竖笔高度范围（格）。 */
const KEY_RUN_MAX_H = 5.2;
const KEY_STROKE_H = [2.5, 3.4] as const;

/** 盒收到里面墨的外接框（没有墨返回 null）。 */
function shrinkBox(bin: Binary, b: Rect): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++)
      if (bin.data[y * bin.w + x]) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** **并排粘成一块的两个临时记号**：按竖笔之间的缝切开，两半各查一次字典 */
export function splitPairedAccidentals(c: {
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  unit: RasterUnit;
  nl: Binary;
  look: RasterGlyphLookup;
  syms: RasterSym[];
  ledger: ContourLedger;
  groups: StaffGroup[];
  raster: RasterPage;
}): void {
  const { blobs, claimed, dictClaimed, unit, nl, look, syms, ledger, groups, raster } = c;
  // ── **并排粘成一块的两个临时记号**：按竖笔之间的缝切开，两半各查一次字典 ─────────
  //
  // 和弦前竖排的「♭♯」挨得紧，♭ 的肚子贴着 ♯ 的竖笔连成一块（破碎 p4 m39、p12 m99 钢琴右手 C4/E♭4/F♯4/A4），
  // 整块字典查不出，♭ 的空肚子又被按内腔收成一个全音符。块里有三组以上通高竖笔（♭ 一根、♯ 两根）、
  // 高宽像两个临时记号并排的，在相邻两组竖笔之间逐个缝试切，两半都查得出临时记号才收；压在上面的头去掉
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id)) continue;
    let b = c.bbox;
    if (b.w > unit.space * ACC_PAIR_W || b.h < unit.space * 1.8 || b.h > unit.space * 3.6) continue;
    // ♭ 的竖笔被抽成竖段、不在块里（p4 m39）：去线图上块左边半格内紧贴着一根通高竖笔的，把块扩过去
    {
      const y0 = Math.max(0, Math.round(b.y - unit.space * 0.6)), y1 = Math.min(nl.h - 1, Math.round(b.y + b.h + unit.space * 0.3));
      for (let x = b.x - 1; x >= Math.max(0, b.x - unit.space * 0.5); x--) {
        let run = 0, best = 0, top = y1;
        for (let y = y0; y <= y1; y++) {
          run = nl.data[y * nl.w + x] ? run + 1 : 0;
          if (run > best) (best = run), (top = y - run + 1);
        }
        if (best < b.h * 0.8) continue;
        b = { x, y: Math.min(b.y, top), w: b.x + b.w - x, h: Math.max(b.y + b.h, top + best) - Math.min(b.y, top) };
        break;
      }
    }
    const cols: [number, number][] = [];
    for (let x = b.x; x < b.x + b.w; x++) {
      let run = 0, best = 0;
      for (let y = b.y; y < b.y + b.h; y++) (run = nl.data[y * nl.w + x] ? run + 1 : 0), (best = Math.max(best, run));
      if (best < b.h * 0.55) continue;
      const last = cols[cols.length - 1];
      if (last && x - last[1] <= 1) last[1] = x;
      else cols.push([x, x]);
    }
    if (cols.length < 3) continue;
    let done = false;
    for (let k = 1; k < cols.length && !done; k++) {
      for (let cut = cols[k - 1][1] + 1; cut <= cols[k][0] && !done; cut++) {
        const L = shrinkBox(nl, { x: b.x, y: b.y, w: cut - b.x, h: b.h });
        const R = shrinkBox(nl, { x: cut, y: b.y, w: b.x + b.w - cut, h: b.h });
        if (!L || !R) continue;
        const cl = look.lookup(binSig(nl, L), L.w / unit.space, L.h / unit.space);
        const cr = look.lookup(binSig(nl, R), R.w / unit.space, R.h / unit.space);
        if (!cl || !cr || !isAccidental(cl) || !isAccidental(cr)) continue;
        for (let i = syms.length - 1; i >= 0; i--) if (/^notehead/.test(syms[i].code) && overlapFrac(syms[i].box, b) > 0.5) syms.splice(i, 1);
        syms.push({ box: L, code: cl }, { box: R, code: cr });
        ledger.claim(L, `accpair:${cl}`);
        ledger.claim(R, `accpair:${cr}`);
        dictClaimed.add(c.id);
        done = true;
      }
    }
  }

  // **谱号兜底**：字典查不到的谱行，按位置补一个。
  //
  // 谱号是音高的基准，缺一行整行的音高就错；而它还是 `buildScore` 连跨系统谱行的
  // 主要凭据（`StaffToken` 的第一项就是行首谱号），缺了那一行会另起一个声部，
  // 一个声部因此碎成好几条——实测宁静一首 GT 5 条谱表、识别出 9 条，
  // 六成的音落在没配上的那几条里，准确率逐段漂到 0。
  // 字典能查到 85/100 行，位置自举能到 91/100，两者并起来才够。
  // 自举只看行首（谱号、调号）：弯、斜的谱行取行首往右两格处的线位
  const bootStaves: BootStaff[] = groups.map((g) => {
    const left = Math.max(...g.lines.map((l) => l.left));
    return { left, right: Math.min(...g.lines.map((l) => l.right)), lineYs: g.lines.map((l) => lineYAt(l, left + unit.space * 2)) };
  });
  const boxes = blobs.map((c) => ({ x: c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h }));
  // 谱号**盖过字典**：字典按连通块查，谱号被自己的笔画切开时它只看到半截，
  // 尺寸恰好像另一种谱号（宁静 p7 的高音谱号上半截 2.76×2.65 与 Maestro 的
  // fClef 模板 2.84×3.34 只差一点），认成 fClef 比认不出来更糟。
  // 自举那一路先把 x 上重叠的碎块并回一个盒，再拿模板签名比——那才是完整的谱号。
  // **粘连的一串升号**不是谱号：粗体铅字本两个升号挤在一起连成一块（《耶和华是我的牧者》2.3×4.8 格），
  // 比低音谱号还高，被取作种子认成高音谱号，真谱号反倒丢了。它在原图上有三四根 2.5~3.4 格高的竖笔；
  // 44 首独唱谱的谱号候选里，高音谱号最多两根这么高的（另一根更高或更矮），没有第二种块是这样。
  const keyRun = (b: Rect) => b.h <= unit.space * KEY_RUN_MAX_H && verticalStrokes(raster.bin, b, unit.space * KEY_STROKE_H[0]).filter((s0) => s0.h <= unit.space * KEY_STROKE_H[1]).length >= 3;
  for (const h of bootstrapClefs(boxes, bootStaves, unit.space, look.templates ? { tpl: look.templates, sigOf: (b) => binSig(nl, b) } : undefined, keyRun)) {
    const b = h.box ?? blobs[h.index].bbox;
    // 落在这个盒里的字典结果作废（那是被切开的半截）。**按中心判**，不要求整个在盒里：
    // 低音谱号的圆头被当成全音符符头时，盒比谱号盒高出几个像素（《善牧恩慈歌》第二行
    // 出了个 G3 全音符；坚固保障高音谱号底下的圆球也被认成过两个黑符头），整盒判就漏了。
    // 谱号盒里不会有真音符。
    for (let i = syms.length - 1; i >= 0; i--) {
      const s0 = syms[i].box;
      const cx0 = s0.x + s0.w / 2;
      const cy0 = s0.y + s0.h / 2;
      if (cx0 >= b.x - 1 && cx0 <= b.x + b.w + 1 && cy0 >= b.y - 1 && cy0 <= b.y + b.h + 1) syms.splice(i, 1);
    }
    syms.push({ box: b, code: h.code });
    ledger.claim(b, `clef:${h.code}`);
  }
}

/** 升降号：把**被抽走的那道竖笔**并回来 */
export function rejoinAccidentalStrokes(c: {
  restStrokes: Set<LineSeg>;
  syms: RasterSym[];
  unit: RasterUnit;
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  merged: Set<number>;
  prims: RasterPrims;
  nl: Binary;
  look: RasterGlyphLookup;
  ledger: ContourLedger;
  raster: RasterPage;
}): {
  usedSegs: Set<LineSeg>;
  natFrom: (sx: number, seed: [number, number]) => Rect | null;
} {
  const { restStrokes, syms, unit, blobs, claimed, dictClaimed, merged, prims, nl, look, ledger, raster } = c;
  // ── 升降号：把**被抽走的那道竖笔**并回来 ─────────────────────────────────
  //
  // 降号是「一根细长的竖笔 + 底下一个小肚子」。竖笔沿途两侧都空着，
  // `isolated` 判它是原语、`findPrimitives` 把它抽成竖段，`blobImage` 随后照段抹墨
  // ——剩下的只有那个 0.58×1.05 格的小肚子，字典当然认不出
  //（实测破碎 p4 y=314 那行的调号降号就是这么丢的：竖段 x=113 y[285,324]，
  // 块只剩 [117,304]）。升号与还原号同理，只是它们有两道竖笔、丢得没这么彻底。
  //
  // 这一条是升降号的**主要漏因**：破碎 105 行谱有 31 行的调号一个升降号都没认出来，
  // 全谱升降号块 148 个，而调号加临时记号至少要 200 个。
  //
  // 还原号同理，只是它有**两道**竖笔：左边那道与横笔连成块、右边那道被抽走
  //（实测破碎 p10 那个还原号剩下 [582,1005] 0.53×2.34 格的块 + 竖段 x=593）。
  //
  // 修法照「碎块并回再查」那一条，只是这回要并的是**竖段**：块的左边或右边紧挨着
  // 一条纵向搭得上的竖段，就把两者的盒并起来重查一次字典。
  // 并完要把那条竖段**从 `vSegs` 里摘掉**——留着的话 `findStems` 会把它当符干，
  // `findBarlines` 会把它当小节线。
  const usedSegs = new Set<LineSeg>(restStrokes);
  // 调号位置：同一行谱的谱号右缘往右四格以内
  const clefSyms = syms.filter((s) => s.code === "gClef" || s.code === "fClef" || s.code === "cClef");
  const atKeySlot = (b: Rect) =>
    clefSyms.some((c) => b.y < c.box.y + c.box.h && b.y + b.h > c.box.y && b.x >= c.box.x + c.box.w - 1 && b.x <= c.box.x + c.box.w + unit.space * 4);
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    const bw = b.w / unit.space;
    const bh = b.h / unit.space;
    // 窄块才试：太宽的是符头或别的东西，太小的是噪点
    if (bw < 0.25 || bw > 1.3 || bh < 0.4 || bh > 3.4) continue;
    for (const v of prims.vSegs) {
      if (usedSegs.has(v)) continue;
      const vx = (v.x0 + v.x1) / 2;
      const vTop = Math.min(v.y0, v.y1);
      const vBot = Math.max(v.y0, v.y1);
      // 竖笔要**紧贴着块**（左边或右边都算）、纵向要与块搭上
      if (vx < b.x - unit.space * 0.5 || vx > b.x + b.w + unit.space * 0.5) continue;
      if (vBot < b.y || vTop > b.y + b.h) continue;
      // 一端扎进实心头（横向落在头盒里、端点在头盒上下沿之间）的是符干，块是它的符尾：
      // 低分辨率页上干加八分尾拼成一个还原号（万福泉源歌 m4，G4/E♭4 带尾和弦的干被摘走）
      // 端点离头缘差一两像素也算扎进去（破碎 p4 m32 D4 十六分：干下端停在头上沿外 1 像素，干 + 两道尾读成还原号）
      const tl = Math.max(1, unit.lineThick);
      const tl2 = tl * 2;
      if (syms.some((h) => h.code === "noteheadBlack" && vx >= h.box.x - tl && vx <= h.box.x + h.box.w + tl && ((vBot >= h.box.y - tl2 && vBot <= h.box.y + h.box.h) || (vTop >= h.box.y && vTop <= h.box.y + h.box.h + tl2)))) continue;
      const x0 = Math.min(b.x, Math.round(vx - v.maxLw / 2));
      const y0 = Math.min(b.y, Math.round(vTop));
      const box = {
        x: x0,
        y: y0,
        w: Math.max(b.x + b.w, Math.round(vx + v.maxLw / 2)) - x0,
        h: Math.max(b.y + b.h, Math.round(vBot)) - y0,
      };
      const w1 = box.w / unit.space;
      const h1 = box.h / unit.space;
      if (w1 < 0.4 || w1 > 1.7 || h1 < 1.5 || h1 > 3.6) continue;
      const sig = binSig(nl, box);
      let code = look.lookup(sig, w1, h1);
      if (!code || !isAccidental(code)) {
        // 字典不认就拿模板验。**只收降号**：它才是「一根竖笔 + 一个小肚子」、
        // 竖笔一被抽走就什么都不剩的那一种；升号与还原号各有两道竖笔，
        // 丢不干净，靠这条路补反而是过检（实测放开三种，破碎的还原号
        // 从 17 个涨到 70 个，而 GT 只有 24 个）。
        const m = matchTemplate(sig, w1, h1, look.templates ?? [], atKeySlot(box) ? KEY_ACCID_TEMPLATE_DIST : ACCID_TEMPLATE_DIST);
        code = m && isAccidental(m.smufl) ? m.smufl : null;
      }
      if (!code) continue;
      syms.push({ box, code });
      ledger.claim(box, `accid:${code}`);
      merged.add(c.id);
      usedSegs.add(v);
      break;
    }
    if (merged.has(c.id)) continue;
    // 那道竖笔与旁边音的干挨着、被抽成了同一根竖段（一端扎进头，上面当符干跳过了）：在去线图上取块左边紧贴的那一列自己的竖墨，
    // 并进来查字典，只认字典查得出的（破碎 p12 m100 钢琴右手 B♮3，还原号左竖离前一个十六分的干一两像素）
    for (let x = b.x + 2; x >= b.x - unit.space * 0.3; x--) {
      let run = 0, best = 0, top = 0;
      for (let y = Math.max(0, Math.round(b.y - unit.space)); y <= Math.min(nl.h - 1, b.y + b.h + unit.space); y++) {
        run = nl.data[y * nl.w + x] ? run + 1 : 0;
        if (run > best) (best = run), (top = y - run + 1);
      }
      // 要从块里往上或往下伸出块外三成格以上：块里本来就有的那几列不算
      if (best < b.h * 0.8 || top > b.y + b.h || top + best < b.y || (top > b.y - unit.space * 0.3 && top + best < b.y + b.h + unit.space * 0.3)) continue;
      // 降号、还原号的左竖只从块往上伸；往下越过块底的是穿过去的干，块是空心头的圈（齐来谢主歌 m17 低音 G2 二分）
      if (top + best > b.y + b.h + unit.space * 0.3) break;
      const y0 = Math.min(b.y, top);
      const bx0 = Math.min(x, b.x);
      const box = { x: bx0, y: y0, w: b.x + b.w - bx0, h: Math.max(b.y + b.h, top + best) - y0 };
      const w1 = box.w / unit.space;
      const h1 = box.h / unit.space;
      if (w1 < 0.4 || w1 > 1.7 || h1 < 1.5 || h1 > 3.6) break;
      const code = look.lookup(binSig(nl, box), w1, h1);
      // 并出来的盒压着已认的头：那一列是头的边、块是头的碎片，不是还原号（齐来谢主歌 m17 低音 G2）
      if (syms.some((h) => /^notehead/.test(h.code) && overlapFrac(h.box, box) > 0.3)) break;
      if (code && isAccidental(code)) {
        syms.push({ box, code });
        ledger.claim(box, `accid:${code}`);
        merged.add(c.id);
      }
      break;
    }
  }

  // **两道横笔压在谱线上的还原号**：横笔与谱线重合，去线后只剩两根竖笔、切成几块碎墨，
  // 字典与上面那条都认不出（《向主唱新歌》高音谱表的 F♮ 三处，读成调号里的 F♯）。
  // 按结构认：从无主的窄碎块出发，在去线图上沿列量出整根竖笔；右边 0.35~0.8 格处另有一根，
  // 左高右低错开、纵向搭上一格以上，两根之间在**原图**上有两道横墨（整行从左笔连到右笔），
  // 各比谱线厚、相隔 0.6 格以上。
  // 字典认领过的窄块也当种子：竖笔单独一块时字典会把它认成 `wiggleTrill` 之类
  /** 从一根竖笔（`sx` 列、纵向 `seed`）起认还原号：右边或左边 `NAT_GAP` 格处另有一根，左高右低错开，
   *  两根之间在原图上有两道比谱线厚的横墨。认出来返回盒。 */
  const natFrom = (sx: number, seed: [number, number]): Rect | null => {
    let hit: Rect | null = null;
    for (const side of [1, -1]) {
      for (let dx = Math.round(unit.space * NAT_GAP[0]); dx <= unit.space * NAT_GAP[1] && !hit; dx++) {
        const ox = sx + side * dx;
        const [lx, rx] = side > 0 ? [sx, ox] : [ox, sx];
        // 搭档那根：在种子的纵向范围里找一行有墨的地方起量
        let other: [number, number] | null = null;
        for (let y = seed[0]; y <= seed[1] && !other; y++) if (nl.data[y * nl.w + ox]) other = vRunAt(nl, ox, y);
        if (!other) continue;
        const [L, R] = side > 0 ? [seed, other] : [other, seed];
        if (L[1] - L[0] < unit.space * 1.5 || R[1] - R[0] < unit.space * 1.5 || L[1] - L[0] > unit.space * 3.4 || R[1] - R[0] > unit.space * 3.4) continue;
        if (R[0] - L[0] < unit.space * 0.3 || R[1] - L[1] < unit.space * 0.3) continue;
        const ya = Math.max(L[0], R[0]);
        const yb = Math.min(L[1], R[1]);
        if (yb - ya < unit.space) continue;
        const bars = crossRuns(raster.bin, lx, rx, Math.round(ya - unit.space * 0.3), Math.round(yb + unit.space * 0.3));
        const thick = bars.filter((r) => r[1] - r[0] + 1 >= Math.max(unit.lineThick + 2, unit.space * 0.25));
        if (thick.length < 2 || thick[thick.length - 1][0] - thick[0][1] < unit.space * 0.6) continue;
        const x0 = lx - Math.round(unit.lineThick);
        hit = { x: x0, y: L[0], w: rx + Math.round(unit.lineThick) - x0 + 1, h: R[1] - L[0] + 1 };
      }
      if (hit) break;
    }
    return hit;
  };
  // 宽到一格、带着两截横笔的无主块也当种子，从它最左那几列的竖笔起量：加线上的音的还原号，右竖笔下半截
  // 顺着加线连进了符头那团墨，剩下的左竖笔连着两截横笔成一块（Holy, Holy, Holy m14 女低 C♮4，0.83×2.8 格）
  for (const c of blobs) {
    if (claimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.h < unit.space * 0.3) continue;
    let sx = b.x + Math.floor(b.w / 2);
    let seed = b.w <= unit.space * 0.4 ? vRunAt(nl, sx, b.y + Math.floor(b.h / 2)) : null;
    if (b.w > unit.space * 0.4) {
      if (b.w > unit.space * 1.0 || b.h < unit.space * 1.5) continue;
      for (let x = b.x; x < b.x + Math.min(b.w, unit.space * 0.3) && !seed; x++) {
        for (let y = b.y; y < b.y + b.h; y++) {
          if (!nl.data[y * nl.w + x]) continue;
          const r = vRunAt(nl, x, y);
          if (r && r[1] - r[0] >= unit.space * 1.5) {
            seed = r;
            sx = x + 1;
          }
          break;
        }
      }
    }
    if (!seed) continue;
    const hit = natFrom(sx, seed);
    if (!hit) continue;
    const box = hit;
    // 盒里的碎符号（竖笔认成的装饰音之类）换掉；与盒大片相交的别的符号在，就不认
    const inner = syms.filter((s0) => overlapFrac(s0.box, box) > 0.8 && s0.box.w * s0.box.h < box.w * box.h * 0.5);
    if (syms.some((s0) => !inner.includes(s0) && overlapFrac(box, s0.box) > 0.3)) continue;
    for (const s0 of inner) syms.splice(syms.indexOf(s0), 1);
    syms.push({ box, code: "accidentalNatural" });
    ledger.claim(box, "accid:accidentalNatural");
    for (const c2 of blobs) if (!claimed.has(c2.id) && overlapFrac(c2.bbox, box) > 0.8) merged.add(c2.id);
    for (const v of prims.vSegs) if ((v.x0 + v.x1) / 2 >= box.x && (v.x0 + v.x1) / 2 <= box.x + box.w && Math.min(v.y0, v.y1) >= box.y - 2 && Math.max(v.y0, v.y1) <= box.y + box.h + 2) usedSegs.add(v);
  }
  return { usedSegs, natFrom };
}

/** 调号：紧跟谱号的升降号，**位置兜底** */
export function findKeySigs(c: {
  unit: RasterUnit;
  raster: RasterPage;
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  syms: RasterSym[];
  blobs: Component[];
  dictClaimed: Set<number>;
  claimed: Set<number>;
  merged: Set<number>;
  nl: Binary;
  ledger: ContourLedger;
  look: RasterGlyphLookup;
}): {
  keySp: number;
  sharpAsHeads: (ss: RasterSym[], edge: number, onStaff: (r: Rect) => boolean) => { heads: RasterSym[]; box: Rect; } | null;
  hasGapColumn: (set: RasterSym[]) => boolean;
  sharpBox: (set: RasterSym[]) => Rect | null;
} {
  const { unit, raster, groups, yAt, syms, blobs, dictClaimed, claimed, merged, nl, ledger, look } = c;
  // ── 调号：紧跟谱号的升降号，**位置兜底** ─────────────────────────────────
  //
  // 字典与模板都认不出的调号升降号，按「谱号右边第一串又窄又高的块」补认。
  // 病例是铅字本的细长升号（《善牧恩慈歌》0.82×2.36 格，Maestro 模板 0.95×2.73）：
  // 到 `accidentalSharp` 的签名距离 130，通用的 90 那道闸过不去，调号整个丢了，
  // 全曲的 F 都成了还原（调号错一个，测评按「移调」整首平移，音符档掉到两成）。
  // 松到拍号那一档是因为位置先验够硬：紧贴谱号、一串挨着、骑在谱表上。
  // 形状另卡**窄**（宽不过高的 0.5）：拍号数字 0.67 以上，挡得住。
  // 只吃谁都没认领的块（外加字典认成调号区不该有之物的块，见下）；字典已经认出的前几个不动，
  // 从它们的串尾接着往右认。
  //
  // 另一种丢法是**升号被符头那一路先吃了**：粗体升号的两道横笔又粗又斜，
  // 去掉竖笔后就是两个上下叠着的「黑符头」（《赞美一神》低音谱表两行都是：
  // 升号骑在 F3 线上，出了一对 F#3/A3 和弦）。认回来的判据：
  //   - 谱号右缘 2 格内（低音谱号的两点不在谱号盒里，要多让半格）、x 差不到 0.3 格、上下隔 0.7~1.3 格的两个黑符头；
  //   - 原图上盒里有**两根**竖笔（相隔 0.4 格以上）贯穿上下两头，且没有哪一列伸出一格以上
  //     ——三度和弦的符干往一头伸 2.5 格以上；升号的竖笔只探出半格（右竖笔下端还短，不能要求两头都伸）；
  //   - 只被认成**一个**头的（第二行低音谱表）：竖笔上下都要探出 0.3 格以上、最长 1.6 格。
  const keySp = unit.space;
  const keyBin = raster.bin;
  function sharpAsHeads(ss: RasterSym[], edge: number, onStaff: (r: Rect) => boolean): { heads: RasterSym[]; box: Rect } | null {
    const sp = keySp;
    // 从左往右找：串是逐个往右认的，先配上右边那个会跳过左边那个（齐来称颂低音谱表第二、三个升号）
    // 左缘可以伸进前面的盒里 0.3 格：有一位神 m18 行首的 F♯ 左缘压进高音谱号的盒 4px（谱号尾巴往右甩），
    // 被拆成两个头，从谱号右缘起算就漏了。两根贯通竖笔那道闸（`sharpBox`）挡得住谱号自己的碎块
    const hs = ss.filter((s0) => s0.code === "noteheadBlack" && onStaff(s0.box) && s0.box.x >= edge - sp * 0.3 && s0.box.x < edge + sp * 2).sort((a, b) => a.box.x - b.box.x);
    // 候选：上下叠着的一对，或者单独一个（另一道横笔没被认成头）
    const sets: RasterSym[][] = [];
    for (const a of hs)
      for (const b of hs) {
        const dy = (b.box.y - a.box.y) / sp;
        if (dy >= 0.7 && dy <= 1.3 && Math.abs(a.box.x - b.box.x) <= sp * 0.3) sets.push([a, b]);
      }
    for (const a of hs) sets.push([a]);
    for (const set of sets) {
      const box = sharpBox(set);
      if (box) return { heads: set, box };
    }
    return null;
  }
  /** 这一对（或一个）黑符头其实是升号吗：原图上有两根竖笔贯穿，且探出不多。是就返回升号的盒。 */
  /** 两个头的盒里，上下贯穿的竖笔之间有没有**不贯穿**的列（升号两根竖笔中间是空的）。 */
  function hasGapColumn(set: RasterSym[]): boolean {
    const bin = keyBin;
    const x0 = Math.min(...set.map((s0) => s0.box.x));
    const x1 = Math.max(...set.map((s0) => s0.box.x + s0.box.w));
    const u0 = set[0].box.y;
    const u1 = set[set.length - 1].box.y + set[set.length - 1].box.h - 1;
    const full: boolean[] = [];
    // 竖笔一两像素的抖动算连着（同 `sharpBox`）：斜着印的升号两根竖笔从上到下横移一两像素，严格按「整列是墨」一根竖笔都数不出来，
    // 升号就留成一对黑头（新编赞美诗 275 m4 的 F♯4 前多出 E♭4、G4 两个音）。两根竖笔之间那几列放宽后照样不满。
    const at = (x: number, y: number) => x >= 0 && x < bin.w && !!bin.data[y * bin.w + x];
    for (let x = x0; x < x1; x++) {
      let ok = true;
      for (let y = u0; y <= u1 && ok; y++) ok = at(x, y) || at(x - 1, y) || at(x + 1, y);
      full.push(ok);
    }
    const first = full.indexOf(true);
    const last = full.lastIndexOf(true);
    return first >= 0 && full.slice(first, last + 1).some((f) => !f);
  }
  function sharpBox(set: RasterSym[]): Rect | null {
    const sp = keySp;
    const bin = keyBin;
    const at = (x: number, y: number) => y >= 0 && y < bin.h && !!bin.data[y * bin.w + x];
    const x0 = Math.min(...set.map((s0) => s0.box.x));
    const x1 = Math.max(...set.map((s0) => s0.box.x + s0.box.w));
    const u0 = set[0].box.y;
    const u1 = set[set.length - 1].box.y + set[set.length - 1].box.h - 1;
    const cols: number[] = [];
    let y0 = u0;
    let y1 = u1;
    let over = 0;
    let up = 0;
    let down = 0;
    for (let x = x0; x < x1; x++) {
      let ok = true;
      // 竖笔一两像素的抖动算连着
      for (let y = u0; y <= u1 && ok; y++) ok = at(x, y) || at(x - 1, y) || at(x + 1, y);
      if (!ok) continue;
      cols.push(x);
      let t = u0;
      let d = u1;
      while (at(x, t - 1)) t--;
      while (at(x, d + 1)) d++;
      over = Math.max(over, u0 - t, d - u1);
      up = Math.max(up, u0 - t);
      down = Math.max(down, d - u1);
      y0 = Math.min(y0, t);
      y1 = Math.max(y1, d);
    }
    if (!cols.length || cols[cols.length - 1] - cols[0] < sp * 0.4) return null;
    // 一对：竖笔探出不过一格。单个：另一道横笔还挂在竖笔上，下探可到一格半，
    // 但**上下都要探出去**——带干的音只往一头伸，而且一伸就是两格半以上
    if (set.length === 2 ? over > sp : over > sp * 1.6 || up < sp * 0.3 || down < sp * 0.3) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + 1 };
  }
  for (const g of groups) {
    const left = Math.max(...g.lines.map((l) => l.left));
    // 调号区在行首：弯、斜的谱行取左缘往右四格处的线位
    const top = yAt(g, 0, left + unit.space * 4);
    const bottom = yAt(g, 4, left + unit.space * 4);
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.x < left + unit.space * 4 && s0.box.y < bottom && s0.box.y + s0.box.h > top);
    if (!clef) continue;
    let edge = clef.box.x + clef.box.w;
    const onStaff = (r: Rect) => r.y < bottom && r.y + r.h > top;
    // 字典已经认出的那一串先走完，**从串尾接着认**：字典只认出前几个、后面断了的也要补。
    // 病例《圣哉三一歌伴奏》三个降号：前两个的竖笔被当成线段抹掉、只剩肚子，字典认得；
    // 第三个的竖笔没抹、与肚子断成两块，竖笔被字典认成 wiggleTrill——以前见字典有就不插手，
    // 整首少一个降号，A 全成了还原。
    let fromDict = false;
    // 相接的容差放到**半格**：错开排的窄升号，后一个的左缘常在前一个右缘左边（《来敬拜荣耀王》
    // 三个升号，C# 左缘在 F# 右缘左边 5px，接不上，A 大调读成 D 大调，整曲音级错一个五度）。
    // 只在**前面已有调号记号**时放宽：从谱号右缘起算也放宽的话，会把谱号自己的碎块收进来（《主使我喜乐》−2.3）
    const overlapTol = unit.space * KEY_OVERLAP;
    const taken = new Set<RasterSym>();
    for (;;) {
      const nx = syms
        .filter((s0) => !taken.has(s0) && isAccidental(s0.code) && onStaff(s0.box) && s0.box.x >= edge - (taken.size ? overlapTol : 1) && s0.box.x < edge + unit.space * KEY_GAP)
        .sort((a, b) => a.box.x - b.box.x)[0];
      if (!nx) break;
      taken.add(nx);
      edge = Math.max(edge, nx.box.x + nx.box.w);
      fromDict = true;
    }
    // 字典认成**调号区不该有的东西**（演奏记号之类）的块也算候选：那多半是升降号断出来的半截。
    // 谱号、升降号、拍号、符头、休止照旧不碰。
    const dictSym = new Map<number, RasterSym>();
    for (const c of blobs) {
      if (!dictClaimed.has(c.id) || claimed.has(c.id) || merged.has(c.id)) continue;
      const s0 = syms.find((x) => x.box === c.bbox);
      if (s0 && !isClef(s0.code) && !isAccidental(s0.code) && timeSigDigit(s0.code) < 0 && !/^(notehead|rest)/.test(s0.code)) dictSym.set(c.id, s0);
    }
    const cand = blobs
      .filter((c) => !claimed.has(c.id) && (!dictClaimed.has(c.id) || dictSym.has(c.id)) && !merged.has(c.id))
      .filter((c) => onStaff(c.bbox))
      .sort((a, b) => a.bbox.x - b.bbox.x);
    // 串里**逐个**往右认，每一步先看「被当成符头的升号」、再看普通块：齐来称颂的低音谱表
    // 三个升号，第一个是普通块、后两个各被认成一对黑符头，只认一路就断在第二个上。
    // 第一个记号离谱号右缘放到两格：低音谱号的两点在谱号盒外，实测 1.77 格。
    // 字典已认出的串尾也算「前一个」：后面的记号按它比大小、比签名
    const lastDict = [...taken].sort((a, b) => b.box.x - a.box.x)[0];
    let prevKey: { box: Rect; code: SmuflName; sig: Uint8Array } | null =
      lastDict && (lastDict.code === "accidentalFlat" || lastDict.code === "accidentalSharp") ? { box: lastDict.box, code: lastDict.code, sig: binSig(nl, lastDict.box) } : null;
    for (let first = !fromDict; ; first = false) {
      const gap = unit.space * (first ? KEY_GAP_FIRST : KEY_GAP);
      const pair = sharpAsHeads(syms, edge, onStaff);
      if (pair && pair.box.x <= edge + gap) {
        for (const s0 of pair.heads) syms.splice(syms.indexOf(s0), 1);
        syms.push({ box: pair.box, code: "accidentalSharp" });
        ledger.claim(pair.box, "key:accidentalSharp");
        edge = pair.box.x + pair.box.w;
        continue;
      }
      let took = false;
      const keyTpl = (look.templates ?? []).filter((t) => t.smufl === "accidentalSharp" || t.smufl === "accidentalFlat");
      // 过得了尺寸闸与模板才算；宽另卡 1.2 格：齐来称颂的拍号「3」与「4」的上半连成一块（1.37×3.2 格），
      // 紧挨着最后一个升号，宽高比过得了 0.5 那道闸，被当成第四个升号吃掉，拍号就没了
      const asKey = (b: Rect) => {
        const w = b.w / unit.space;
        const h = b.h / unit.space;
        // 下限 1.6：小号升号（2 格上下）去线后被削到 1.76 格（《来敬拜荣耀王》的 C#）；
        // 宽高比放到 0.6：同一本的 F# 1.02×1.97 格（0.52）
        if (h < 1.6 || h > 3.4 || w < 0.4 || w > h * 0.6 || w > 1.2) return null;
        // 串里后面的记号不会比前一个矮一截：拍号 C 的上半弧（2.2 格）紧挨着最后一个升号（3.0 格），
        // 模板距离 156 过得了拍号那道宽闸，被当成第五个升号（《主使我喜乐》四个升号认成五个）
        if (prevKey && b.h < prevKey.box.h * 0.8) return null;
        const sig = binSig(nl, b);
        const m = matchTemplate(sig, w, h, keyTpl, TIME_TEMPLATE_DIST);
        if (m) return m;
        // 模板尺寸闸没过、却与**前一个已认出的记号**一般大、签名也像：粗体铅字本的升号比模板高
        // （3.3 格，模板 2.7 格的容差到 3.2），同一串里前面的认得、这一个卡在闸上
        if (prevKey && Math.abs(b.h - prevKey.box.h) <= prevKey.box.h * 0.15 && Math.abs(b.w - prevKey.box.w) <= prevKey.box.w * 0.3) {
          const d = sigDistance(sig, prevKey.sig);
          if (d <= KEY_SELF_DIST) return { smufl: prevKey.code, dist: d };
        }
        // 还认不出、又**比模板小一号**的：数竖笔。小号升号（2 格，模板 2.7 格）过不了模板的尺寸闸，
        // 可去线之前的图上两根竖笔都在（《来敬拜荣耀王》A 大调三个升号）。只认升号：两根通高的竖笔，
        // 降号、拍号数字、带干的符头都凑不出两根。
        if (h < 2.5) {
          const pad = Math.round(unit.space * 0.3);
          if (tallStrokes(raster.bin, { x: b.x - pad, y: b.y, w: b.w + pad * 2, h: b.h }) === 2) return { smufl: "accidentalSharp" as SmuflName, dist: KEY_SELF_DIST };
        }
        return null;
      };
      for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        const b = c.bbox;
        if (b.x < edge - (fromDict || prevKey ? overlapTol : 1) || merged.has(c.id)) continue;
        if (b.x > edge + gap) break; // 串断了
        if (b.w / unit.space < 0.6 && b.h / unit.space < 0.6) continue; // 噪点、谱号的小尾巴：跳过，不算断串
        let box = b;
        let used = [c];
        let m = asKey(b);
        // 单块不像，就与**右边紧挨着、上下有交叠**的下一块并起来再认（降号断成竖笔与肚子两块）
        if (!m) {
          const c2 = cand.slice(i + 1).find((d) => !merged.has(d.id) && d.bbox.x >= b.x && d.bbox.x <= b.x + b.w + unit.space * 0.3);
          if (c2 && c2.bbox.y < b.y + b.h && c2.bbox.y + c2.bbox.h > b.y) {
            box = union(b, c2.bbox);
            used = [c, c2];
            m = asKey(box);
          }
        }
        // 还不像，就把**块左缘往上伸的竖笔**接回来：降号的竖笔上半截去线后断开、没进块，
        // 剩下的肚子连着下半截竖笔只有 1.9 格高（高举主大能第四行低音谱表，读成 B♭2 头 + 干）
        if (!m) {
          // 原图（带谱线）上，块左缘三成格内的列从块顶往上还连着墨的，量到最高处
          const bin = raster.bin;
          let top = b.y;
          for (let x = b.x; x <= Math.min(bin.w - 1, b.x + Math.round(unit.space * 0.3)); x++) {
            let y = b.y;
            while (y > 0 && bin.data[(y - 1) * bin.w + x]) y--;
            if (bin.data[b.y * bin.w + x]) top = Math.min(top, y);
          }
          if (b.y - top >= unit.space * 0.3) {
            const u = { x: b.x, y: top, w: b.w, h: b.y + b.h - top };
            const m2 = asKey(u);
            if (m2 && m2.smufl === "accidentalFlat") {
              box = u;
              m = m2;
            }
          }
        }
        // 还不像，就把**同一列**（一格宽）里的碎块整列并起来：细笔画的降号被谱线切成上下几截，
        // 截与截之间空着去掉的那条线（所信有根基：B♭ 断在中线上下、隔 0.46 格，D♭ 碎成四块）
        if (!m) {
          // 左缘都要在头一块左缘半格以内：再往右就是下一个记号的碎块了（所信有根基第一行 A♭ 右边贴着 D♭ 的竖笔）
          const col = cand.filter((d) => !merged.has(d.id) && Math.abs(d.bbox.x - b.x) <= unit.space * 0.4 && d.bbox.x + d.bbox.w <= b.x + unit.space);
          // 并出来的要在**去线之前**的图上有一根贯通八成高的竖笔（升降号都有）：
          // C 拍号被谱线切成几块，并起来尺寸像降号，可它的弧贯通不了（我一生要赞美你）
          if (col.length >= 2) {
            const u = col.map((d) => d.bbox).reduce(union);
            const m2 = longestVRun(raster.bin, u) >= u.h * 0.8 ? asKey(u) : null;
            if (m2) {
              box = u;
              used = col;
              m = m2;
            }
          }
        }
        // 还不像、又比前一个记号宽出一截、高出一截：是**两个斜叠着粘在一起**的同类记号
        //（所信有根基低音谱表，E♭ 的肚子贴上 A♭ 的竖笔顶，连成 1.18×3.21 格一块；两个错开一高一低，竖着切不开）。
        // 只认前一个已认出的那一类，两半的盒按中段墨最少的那一列粗分（下游只数个数）
        if (!m && prevKey && b.w >= prevKey.box.w * 1.3 && b.w <= prevKey.box.w * 2.0 && b.h >= prevKey.box.h * 1.1 && b.h <= prevKey.box.h * 1.9) {
          const halves = splitAt(nl, b) ?? [
            { x: b.x, y: b.y, w: Math.round(b.w / 2), h: b.h },
            { x: b.x + Math.round(b.w / 2), y: b.y, w: b.w - Math.round(b.w / 2), h: b.h },
          ];
          const d = dictSym.get(c.id);
          if (d) syms.splice(syms.indexOf(d), 1);
          merged.add(c.id);
          for (const h of halves) {
            syms.push({ box: h, code: prevKey.code });
            ledger.claim(h, `key:${prevKey.code}`);
          }
          edge = Math.max(edge, b.x + b.w);
          took = true;
          break;
        }
        if (!m) break;
        for (const u of used) {
          const d = dictSym.get(u.id);
          if (d) syms.splice(syms.indexOf(d), 1);
          merged.add(u.id);
        }
        syms.push({ box, code: m.smufl });
        ledger.claim(box, `key:${m.smufl}`);
        prevKey = { box, code: m.smufl, sig: binSig(nl, box) };
        edge = Math.max(edge, box.x + box.w);
        took = true;
        break;
      }
      if (!took) break;
    }
  }
  return { keySp, sharpAsHeads, hasGapColumn, sharpBox };
}

/** 调号记号**按竖笔数**再定一次升降 */
export function recountKeySigStrokes(c: {
  groups: StaffGroup[];
  unit: RasterUnit;
  yAt: (g: StaffGroup, k: number, x: number) => number;
  syms: RasterSym[];
  raster: RasterPage;
}): void {
  const { groups, unit, yAt, syms, raster } = c;
  // ── 调号记号**按竖笔数**再定一次升降 ─────────────────────────────────────
  //
  // 升号的两道横笔很细，常常正好压在谱线上，去线时一起抹掉，只剩两根竖笔
  //（《来敬拜荣耀王》A 大调三个升号全被模板认成降号，整曲音高错一片）。
  // **通高的竖笔**数得清：升号两根（右边那根高一点）、降号一根（右下是个肚子）。只拿它把降号改回升号。
  // 只改谱号右边调号区里的记号，谱中的临时记号不碰。
  for (const g of groups) {
    const kx = Math.max(...g.lines.map((l) => l.left)) + unit.space * 4;
    const top = yAt(g, 0, kx);
    const bottom = yAt(g, 4, kx);
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < bottom && s0.box.y + s0.box.h > top && s0.box.x < kx);
    if (!clef) continue;
    const right = clef.box.x + clef.box.w + unit.space * 6;
    const inKey = (s0: RasterSym) => !(s0.box.x < clef.box.x + clef.box.w - 1 || s0.box.x > right || s0.box.y > bottom || s0.box.y + s0.box.h < top);
    for (const s0 of syms) {
      if (s0.code !== "accidentalFlat" && s0.code !== "accidentalSharp") continue;
      if (!inKey(s0)) continue;
      // 数竖笔要在**去线之前**的图上、左右各放宽 0.3 格：细的那根竖笔常被当成竖段抽走，去线图上只剩一根
      const pad = Math.round(unit.space * 0.3);
      const n = tallStrokes(raster.bin, { x: s0.box.x - pad, y: s0.box.y, w: s0.box.w + pad * 2, h: s0.box.h });
      // 只往升号改：扫描件放大后升号的竖笔断断续续，数不满两根（《善牧恩慈歌》G 大调因此读成 F 大调，音符 91 → 26%）
      if (n === 2 && s0.code === "accidentalFlat") s0.code = "accidentalSharp";
    }
    // 夹在一串升号里的**还原号**是升号：去线后升号的横笔没了、两根竖笔上下错开，字典认成还原号
    //（《来敬拜荣耀王》的 C#）。调号里的还原号只在转调取消时出现，不会与升号混排在同一串。
    const ks = syms.filter((s0) => isAccidental(s0.code) && inKey(s0));
    if (ks.some((s0) => s0.code === "accidentalSharp") && !ks.some((s0) => s0.code === "accidentalFlat"))
      for (const s0 of ks) if (s0.code === "accidentalNatural") s0.code = "accidentalSharp";
    // 调号里升降也不混排：**少数服从多数**。细笔画的降号肚子只剩一圈细边，
    // 肚子右缘与竖笔数成两根（所信有根基四个降号里第三个 A♭ 读成升号）
    const nf = ks.filter((s0) => s0.code === "accidentalFlat").length;
    const ns = ks.filter((s0) => s0.code === "accidentalSharp").length;
    if (nf && ns && nf !== ns) for (const s0 of ks) if (s0.code === "accidentalFlat" || s0.code === "accidentalSharp") s0.code = nf > ns ? "accidentalFlat" : "accidentalSharp";
  }
}

/** 谱中的升号被当成两个黑符头 */
export function fixSharpsAsHeads(c: {
  syms: RasterSym[];
  keySp: number;
  sharpBox: (set: RasterSym[]) => Rect | null;
  hasGapColumn: (set: RasterSym[]) => boolean;
  ledger: ContourLedger;
}): void {
  const { syms, keySp, sharpBox, hasGapColumn, ledger } = c;
  // ── 谱中的升号被当成两个黑符头 ───────────────────────────────────────────
  //
  // 与调号那段同一个病（粗体升号的两道横笔去掉竖笔后就是两个上下叠着的黑头），只是出在谱中：
  // 齐来称颂 m14 低音那个 E♯3 的升号成了一对 D3/F♯3 黑头，多出两个音、升号也丢了。
  // 几何判据同 `sharpBox`；谱中没有「紧贴谱号」那条先验，另要**右边 1.5 格内有个同高的符头**
  //（升号中心与头中心差不到四分之一格）——那是它要升的音。只认成对的，单个的太像带干的头。
  for (let i = 0; i < syms.length; i++) {
    const a = syms[i];
    if (a.code !== "noteheadBlack") continue;
    const b = syms.find((s0) => s0 !== a && s0.code === "noteheadBlack" && Math.abs(s0.box.x - a.box.x) <= keySp * 0.3 && (s0.box.y - a.box.y) / keySp >= 0.7 && (s0.box.y - a.box.y) / keySp <= 1.3);
    if (!b) continue;
    const box = sharpBox([a, b]);
    if (!box) continue;
    // 升号的两根竖笔之间是空的；上下贴着的两个实心头（三度和弦）每一列都有墨，`sharpBox` 分不开
    //（善牧恩慈歌线距 11px，m2 的一对黑头被当成升号）
    if (!hasGapColumn([a, b])) continue;
    const cy = box.y + box.h / 2;
    const right = box.x + box.w;
    const owner = syms.some((s0) => s0 !== a && s0 !== b && /^notehead/.test(s0.code) && s0.box.x >= right - 2 && s0.box.x - right <= keySp * 1.5 && Math.abs(s0.box.y + s0.box.h / 2 - cy) <= keySp / 4);
    if (!owner) continue;
    syms.splice(syms.indexOf(b), 1);
    syms.splice(syms.indexOf(a), 1, { box, code: "accidentalSharp" });
    ledger.claim(box, "acc:accidentalSharp");
  }
}

/** 谱中没人认领的升降还原号：按位置先验配模板 */
export function matchUnclaimedAccidentals(c: {
  look: RasterGlyphLookup;
  unit: RasterUnit;
  blobs: Component[];
  claimed: Set<number>;
  dictClaimed: Set<number>;
  merged: Set<number>;
  syms: RasterSym[];
  nl: Binary;
  raster: RasterPage;
  ledger: ContourLedger;
}): void {
  const { look, unit, blobs, claimed, dictClaimed, merged, syms, nl, raster, ledger } = c;
  // ── 谱中没人认领的升降还原号：按位置先验配模板 ───────────────────────────
  //
  // 字典认不出、也没人认领的块，**右边 1.5 格内有个同高的符头**（升/还原看盒中心，降看肚子），
  // 形状又像升降号（高 1.8~3.4 格、宽 0.4~1.2 格），就拿模板配（门槛见 `LOOSE_ACC_DIST`）。病例齐来称颂 m5 那个 D♯4 的升号，两道横笔分得开，
  // 字典不认，整块没人要。
  {
    const accTpl = (look.templates ?? []).filter((t) => t.smufl === "accidentalSharp" || t.smufl === "accidentalFlat" || t.smufl === "accidentalNatural");
    const sp = unit.space;
    for (const c of blobs) {
      if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
      const b = c.bbox;
      const w = b.w / sp;
      const h = b.h / sp;
      if (h < 1.8 || h > 3.4 || w < 0.4 || w > 1.2) continue;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
      // 模板配不上的再按**结构**认升号：两根通高的竖笔（上下两端各一成半高度里都有它们的墨——还原号的左竖只在上半、右竖只在下半）
      // 加两道横贯的横笔。低分辨率的小号升号（新编赞美诗 359 谱表下方 D♯4 的升号 22×58px、线距 22）签名离模板远过门槛，整块没人认，
      // 一首漏五个升号。位置先验（右边紧挨着同高的符头）照旧要过。
      const m = matchTemplate(binSig(nl, b), w, h, accTpl, LOOSE_ACC_DIST) ??
        (w >= 0.6 && h >= 2.2 && h <= 3.2 && sharpShape(raster.bin, b) ? { smufl: "accidentalSharp" as SmuflName, dist: LOOSE_ACC_DIST } : null);
      if (!m) continue;
      const py = m.smufl === "accidentalFlat" ? b.y + (b.h * (1 + FLAT_BOWL_TOP)) / 2 : b.y + b.h / 2;
      const right = b.x + b.w;
      if (!syms.some((s0) => /^notehead/.test(s0.code) && s0.box.x >= right - 2 && s0.box.x - right <= sp * LOOSE_ACC_GAP && Math.abs(s0.box.y + s0.box.h / 2 - py) <= sp / 4)) continue;
      merged.add(c.id);
      syms.push({ box: b, code: m.smufl });
      ledger.claim(b, `acc:${m.smufl}`);
    }
  }
}

/** 降号的盒要收到**下面那个肚子**上 */
export function shrinkFlatBoxes(c: {
  syms: RasterSym[];
}): void {
  const { syms } = c;
  // ── 降号的盒要收到**下面那个肚子**上 ─────────────────────────────────────
  //
  // 降号的音高位置是肚子，不是盒中心：它的字形是「一根竖笔往上伸 + 底下一个肚子」，
  // Maestro 模板 0.84×2.36 格，肚子只占下面一格左右。而 `analyzeAccidental`
  // 判「这个记号是不是那个符头的」用的是**盒中心与符头中心同高**（容差四分之一格）
  // ——实测降号的盒中心比符头中心**高 0.55 格**，16 个里**一个都过不了**那道闸
  //（升号与还原号上下对称，中位数 0.03 格，33/36 与 10/11 都过）。
  //
  // 位图这边的 `Sym.py` 是从盒算的（`adapt.ts` 造的是假字形），所以在这里把盒
  // 收到肚子上最省事：`py` 跟着落到肚子中心，`overlapY` 与 x 上的判据都不受影响。
  // **不动 `staffomr`**——那边的 `py` 从真字形来，两条路的成因不是一回事。
  for (const s of syms) {
    if (s.code !== "accidentalFlat") continue;
    const cut = Math.round(s.box.h * FLAT_BOWL_TOP);
    s.box = { x: s.box.x, y: s.box.y + cut, w: s.box.w, h: s.box.h - cut };
  }
}

/** 头左边贴着、没认出来的临时记号：在头左侧的窗里取墨查字典 */
export function accidentalsLeftOfHeads(c: {
  unit: RasterUnit;
  syms: RasterSym[];
  nl: Binary;
  prims: RasterPrims;
  look: RasterGlyphLookup;
  repaired: Binary;
  raster: RasterPage;
  ledger: ContourLedger;
}): void {
  const { unit, syms, nl, prims, look, repaired, raster, ledger } = c;
  // ── 头左边贴着、没认出来的临时记号：在头左侧的窗里取墨查字典 ─────────────────
  //
  // 临时记号常与头、干、邻音粘成一块（破碎 p8 m84 C♯5：升号连着头和干成了 29×64 的一块，左竖又断成一小块），
  // 按块查的几路都看不到它。头都认完了，就从头这边找：头左 `ACC_PROBE_W` 格、上下 `ACC_PROBE_H` 格的窗里，
  // 去线图上的墨扣掉所有头盒，收成外接框——框要在窗内（左缘外一列空着，整个字形都框进来了）、纵向与头对齐，
  // 字典查得出临时记号才收
  {
    const sp = unit.space;
    // 从右往左：和弦前几列临时记号，靠里那列先认出来，外列的窗才好隔着它往左挪
    const heads = syms.filter((s0) => /^notehead/.test(s0.code)).sort((a, b) => b.box.x - a.box.x);
    const accs = syms.filter((s0) => isAccidental(s0.code));
    // 窄过 0.45 格的「临时记号」是字典按块认出的半截（升号横笔压线被切开，左半一块、右半认成别的；破碎 p8 m80），不当已有
    const whole = (a: RasterSym) => a.box.w >= sp * ACC_HALF_W;
    const cyOf = (b: Rect) => b.y + b.h / 2;
    // 记号右边另有头与它更同高：一根升号高三格，盖得住和弦里两三个头的心，却只是其中一个的
    const ownsBetter = (a: RasterSym, h: RasterSym) => {
      const d = Math.abs(cyOf(a.box) - cyOf(h.box));
      return heads.some((o) => o !== h && o.box.x >= a.box.x + a.box.w - 2 && o.box.x - (a.box.x + a.box.w) <= sp * 1.6 && Math.abs(cyOf(a.box) - cyOf(o.box)) < d && Math.abs(cyOf(a.box) - cyOf(o.box)) <= sp * ACC_OWN_DY);
    };
    for (const h of heads) {
      const hcy = h.box.y + h.box.h / 2;
      if (accs.some((a) => whole(a) && a.box.x + a.box.w <= h.box.x + 2 && a.box.x + a.box.w >= h.box.x - sp * 1.6 && a.box.y < hcy && a.box.y + a.box.h > hcy && !ownsBetter(a, h))) continue;
      let rx1 = Math.round(h.box.x) - 1;
      // 错开在干另一侧的头（二度）：左列的头挡在前面，窗从左列头的左缘起（破碎 p8 m80 F♯4）
      for (;;) {
        const o = heads.find((o) => o !== h && o.box.x < rx1 && o.box.x + o.box.w >= rx1 - sp * 0.3 && o.box.x + o.box.w <= rx1 + 4 && Math.abs(cyOf(o.box) - hcy) <= sp * 1.2);
        if (!o) break;
        rx1 = Math.round(o.box.x) - 1;
      }
      // 前面已有一列临时记号（不是这个头的）：窗隔过它往左开，找外列（同上 E♭4 的 ♭ 在 F♯4 的 ♯ 左边）
      for (;;) {
        const a = accs.find((a) => whole(a) && a.box.x <= rx1 && a.box.x + a.box.w >= rx1 - sp * 0.5 && a.box.y < hcy + sp * 0.5 && a.box.y + a.box.h > hcy - sp * 0.5);
        if (!a) break;
        rx1 = Math.round(a.box.x) - 1;
      }
      const rx0 = Math.max(0, Math.round(rx1 + 1 - sp * ACC_PROBE_W));
      const ry0 = Math.max(0, Math.round(hcy - sp * ACC_PROBE_UP)), ry1 = Math.min(nl.h - 1, Math.round(hcy + sp * ACC_PROBE_H));
      if (rx1 - rx0 < 3) continue;
      const W = rx1 - rx0 + 1, H = ry1 - ry0 + 1;
      const fromNl = ((): { box: Rect; code: SmuflName } | null => {
        const local = { w: W, h: H, data: new Uint8Array(W * H) } as Binary;
        for (let y = ry0; y <= ry1; y++)
          for (let x = rx0; x <= rx1; x++) {
            if (!nl.data[y * nl.w + x]) continue;
            if (heads.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h)) continue;
            local.data[(y - ry0) * W + (x - rx0)] = 1;
          }
        // 窗里的干先抹掉：升号左竖连着邻音朝上的干和头，整块碰到窗左边、被当成邻音扣掉（破碎 p8 m84 C♯5）
        for (const v of prims.vSegs) {
          const vx = (v.x0 + v.x1) / 2, half = Math.max(1, v.maxLw / 2);
          if (vx + half < rx0 || vx - half > rx1) continue;
          // 只抹比窗还高出去的长竖段：临时记号自己的竖笔也可能被抽成竖段
          const top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
          if (top > ry0 && bot < ry1) continue;
          for (let y = Math.max(ry0, Math.round(top)); y <= Math.min(ry1, Math.round(bot)); y++)
            for (let x = Math.max(rx0, Math.round(vx - half)); x <= Math.min(rx1, Math.round(vx + half)); x++) local.data[(y - ry0) * W + (x - rx0)] = 0;
        }
        // 碰到窗左、上、下边的连通块是邻音的干、杠、尾，扣掉；剩下的并起来
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        const labels = new Int32Array(W * H);
        const drop = new Set<number>();
        for (const cc of connectedComponents(local, 1, labels)) {
          const q = cc.bbox;
          if (q.x === 0 || q.y === 0 || q.y + q.h >= H || cc.area < sp * sp * 0.3) {
            drop.add(cc.id);
            continue;
          }
          x0 = Math.min(x0, q.x + rx0), x1 = Math.max(x1, q.x + q.w - 1 + rx0), y0 = Math.min(y0, q.y + ry0), y1 = Math.max(y1, q.y + q.h - 1 + ry0);
        }
        for (let i = 0; i < labels.length; i++) if (drop.has(labels[i])) local.data[i] = 0;
        if (x1 < 0) return null;
        const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
        const w1 = box.w / sp, h1 = box.h / sp;
        if (w1 < 0.3 || w1 > 1.1 || h1 < 1.5 || h1 > 3.2) return null;
        if (Math.abs(box.y + box.h / 2 - hcy) > sp * 0.8) return null;
        const lbox = { x: box.x - rx0, y: box.y - ry0, w: box.w, h: box.h };
        const sig = binSig(local, lbox);
        let code = look.lookup(sig, w1, h1);
        // 字典认不出（去线、扣头后字形残了）：两根通高竖笔 + 两道横贯粗横是升号（模板不用：干加邻头的墨也配得上，我灵镇静 m22）
        if (!code || !isAccidental(code)) {
          // 结构判只认升号的个头（高不过 `ACC_PROBE_SHARP_H` 格）、里面不能有实心头大小的满墨：一根干加旁边头的墨也是「两竖两横」（我灵镇静 m22）
          const isSharp = (img: Binary) => h1 <= ACC_PROBE_SHARP_H && !solidInside(img, lbox, sp) && (sharpShape(img, lbox) || (tallStrokes(img, lbox) === 2 && sharpCrossbars(img, lbox, unit)));
          code = isSharp(local) ? "accidentalSharp" : null;
          // 横笔正压在谱线上：去线图上两竖之间那段跟着线抹掉了（破碎 p8 m84 C♯5）。框里补回修补图上的线带像素（头盒、干照旧扣）再判一次
          if (!code) {
            const patched = { w: W, h: H, data: new Uint8Array(local.data) } as Binary;
            for (let y = box.y; y < box.y + box.h; y++)
              for (let x = box.x; x < box.x + box.w; x++) {
                if (!repaired.data[y * repaired.w + x] || nl.data[y * nl.w + x]) continue;
                if (heads.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h)) continue;
                patched.data[(y - ry0) * W + (x - rx0)] = 1;
              }
            code = isSharp(patched) ? "accidentalSharp" : null;
            // 最后一档：先找两道平行粗斜横，再按竖笔伸出横杠的方向分 ♯ / ♮（`restshape.ts::crossbarAccidental`）。
            // 竖笔与邻音的干共用一列、或下半被邻头盖住时，上面几档都数不对竖笔或横笔（破碎 p7 m72 G♯4）
            if (!code) code = crossbarAccidental(patched, lbox, unit);
          }
        }
        return code && isAccidental(code) ? { box, code } : null;
      })();
      // 去线图那几档都不成：在**原图**整窗上找两道平行粗斜横（`restshape.ts::crossbarAccidentalBox`）。
      // 临时记号常压在谱线上，去线时横笔跟着抹掉、碎块又小过碎点下限被扣光（破碎 p2 m7 低音 E♮3）；原图上谱线只有两三像素厚，过不了横杠的厚度下限。
      // 头盒、比窗还高的干照旧扣掉
      // 去线图那一路只认出半个（窄过 0.45 格，横杠压线被抹、只剩一竖）的当没认出，交给原图那一档（赞美三一真神 m12 低音 ♯）
      let found = fromNl && fromNl.box.w >= sp * 0.45 ? fromNl : null;
      // 窗里取 `src` 的墨，扣掉头盒与比窗还高的干
      const winOf = (src: Binary): Binary => {
        const img = { w: W, h: H, data: new Uint8Array(W * H) } as Binary;
        for (let y = ry0; y <= ry1; y++)
          for (let x = rx0; x <= rx1; x++) {
            if (!src.data[y * src.w + x]) continue;
            if (heads.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h)) continue;
            img.data[(y - ry0) * W + (x - rx0)] = 1;
          }
        for (const v of prims.vSegs) {
          const vx = (v.x0 + v.x1) / 2, half = Math.max(1, v.maxLw / 2);
          const top = Math.min(v.y0, v.y1), bot = Math.max(v.y0, v.y1);
          if (vx + half < rx0 || vx - half > rx1 || (top > ry0 && bot < ry1)) continue;
          for (let y = Math.max(ry0, Math.round(top)); y <= Math.min(ry1, Math.round(bot)); y++)
            for (let x = Math.max(rx0, Math.round(vx - half)); x <= Math.min(rx1, Math.round(vx + half)); x++) img.data[(y - ry0) * W + (x - rx0)] = 0;
        }
        return img;
      };
      if (!found) {
        const r = crossbarAccidentalBox(winOf(raster.bin), { x: 0, y: 0, w: W, h: H }, unit, true);
        if (r) {
          const box = { x: r.box.x + rx0, y: r.box.y + ry0, w: r.box.w, h: r.box.h };
          // 框宽要够一个临时记号（还原号约 0.6 格、升号 0.7~0.9 格），也不碰窗的上下边：别的笔画截一半也凑得出两道横
          const inside = r.box.y > 0 && r.box.y + r.box.h < H - 1;
          if (inside && box.w >= sp * 0.55 && Math.abs(box.y + box.h / 2 - hcy) <= sp * 0.8 && box.h <= sp * 3.2) found = { box, code: r.code };
        }
      }
      // 降号没有两道横：在修补图上按「通高竖笔 + 下半右边闭合肚子」认（`restshape.ts::flatAccidentalBox`）。
      // 竖笔被谱线切成几截、上端粘着前一个音的头，按块查不出（破碎 p8 m80 E♭4）
      if (!found) {
        const r = flatAccidentalBox(winOf(repaired), { x: 0, y: 0, w: W, h: H }, unit);
        if (r && r.y > 0 && r.y + r.h < H - 1) {
          const box = { x: r.x + rx0, y: r.y + ry0, w: r.w, h: r.h };
          if (Math.abs(cyOf(box) - hcy) <= sp * 0.8) found = { box, code: "accidentalFlat" };
        }
      }
      // 窄过 0.45 格的不是临时记号（抹干后剩下的一根竖条也配得上升号，恩友歌伴奏 m1）；
      // 与已认出的别的符号（行首调号、别的临时记号）交叠三成以上的是把它又截了一半（恩友歌伴奏 m13 行首调号的升号）
      if (!found || found.box.w < sp * ACC_HALF_W) continue;
      const hit = syms.filter((s0) => isAccidental(s0.code) && overlapFrac(found!.box, s0.box) > 0.3);
      if (hit.some(whole)) continue;
      const { code } = found;
      // 降号盒照前面字典认的一样收到肚子上（`FLAT_BOWL_TOP`）：挂头按盒中与头心同高
      const cut = code === "accidentalFlat" ? Math.round(found.box.h * FLAT_BOWL_TOP) : 0;
      const box = { ...found.box, y: found.box.y + cut, h: found.box.h - cut };
      // 交叠的只是半截：让给认全的。大半落在新框里、窄过它四分之三的别的碎块（升号右半被字典认成 wiggleTrill）一并去掉
      for (let i = syms.length - 1; i >= 0; i--) {
        const s0 = syms[i];
        const frag = !/^notehead/.test(s0.code) && s0.box.w < found.box.w * 0.75 && overlapFrac(s0.box, found.box) > 0.8;
        if (!hit.includes(s0) && !frag) continue;
        syms.splice(i, 1);
        const j = accs.indexOf(s0);
        if (j >= 0) accs.splice(j, 1);
      }
      syms.push({ box, code });
      accs.push({ box, code });
      ledger.claim(found.box, `accprobe:${code}`);
    }
  }
}
/**
 * 谱中无主块配升降号模板的签名距离上限（见「谱中没人认领的升降还原号」）。
 * 实测真升号 46~68（齐来称颂 m5、赞美三一真神 m8/m9），误配的最近一个 87（善牧恩慈歌线距 11px
 * 的一截竖笔），再往上是 102~180 一大片；拍号那一档 180 太松，通用的 90 也挡不住 87。
 */
const LOOSE_ACC_DIST = 80;
