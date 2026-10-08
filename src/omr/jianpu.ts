// 简谱结构识别（移植 jianpu.cpp recognition_jp 的几何启发式，OpenCV→纯 TS）。
// 流程：连通域 → 估计字号 → 分类(数字块/小节线/横线/点) → 数字块内部拆分(下划线/相邻数字)
//        → 按行分组 → 归并八度点/增时线/附点 → OCR 数字 → 按小节线切分。
//
// 关键修复（相对 musicpp 初版移植）：
//   1. 减时下划线常与数字相连成同一连通域，初版用"独立横线"判 div 会漏判 → 改为在
//      每个数字块底部带状区域内直接数下划线层数得 div。
//   2. 带下划线的连音（如 6_5_）会粘成一个宽连通域，初版 classify 因 w>numH 直接丢弃 →
//      现按列投影把宽块切成多个数字格。
import type { Binary, Component, JpNum, Rect, StaffRow, RecognizedScore } from "../omrkit/types";
import { rright, rbottom, rcx, rcy, RHYTHM_DIGIT, isRejoinedArc } from "../omrkit/types";
import { connectedComponents } from "../omrkit/ccl";
import type { OcrBackend } from "../omrkit/ocr";
import { recognizeLyrics, type LyricCharRef, type LyricHooks } from "./lyrics";
import { applyRefLyrics } from "./reflyrics";
import { recognizeHeader } from "./header";
import { recognizeTrailingStanzas } from "./stanzas";
import { detectSlurs, resolveSlurRefits, tupletCandidates } from "./slur";
import { detectRepeatsAndEndings } from "./repeats";
import { detectSegno } from "./segno";
import { median, overlapX, unionRect } from "../omrkit/geom";
import { accidentalOf } from "./accidental";
import { probe } from "./probe";
import { mergeBrokenHlines, untangleBridged, splitBarDash, splitBarCap, splitDigitDash, splitArcTail, splitLineOverArc, splitLineDot, splitArcEndDots, splitArcInnerDots, splitMordentDot } from "./compsurgery";
import { splitGluedSharp, splitBlock, meterCandidates, groupRows } from "./digitcores";
import { buildJpNums, resolvePairOctaveDots } from "./jpnums";
import { rowInk, tightBox, columnInk } from "./inkprobe";

/** 一个数字格：紧包围盒 + 自身下划线条数(div)。 */
export interface DigitCore {
  bbox: Rect;
  div: number;
}

export interface Classified {
  blocks: Component[];   // 数字（块，可能含下划线/粘连，待拆分）
  barlines: Component[]; // 小节线（高瘦竖条）
  longBarlines: Component[]; // 6~14 字号的系统通长线（四声部本从首声部画到末声部），只供按行归线用
  hlines: Component[];   // 独立横线（增时线 '-' / 分隔线）
  dots: Component[];     // 小点（八度点/附点）
  /** 又短又厚的实心横块：尺寸上分不清是增时线还是压扁的点，先放在 dots 里；buildJpNums 里落在数字右侧、
   *  与数字中线对齐的挪去 hlines 当增时线（八度点、波音不在中线上），见 classify「更短的 '-'」 */
  dashLike: Component[];
  clean: boolean;        // 干净谱面（isCleanPage）：几条专治翻拍件毛病的判据在这种页上不开
  lineH: number;         // 本页统计线粗（strokeLineH），0 = 页上横线太少、量不出
  /** 已认出的延长记号（弧、或弧点粘成的一块）的框：四声部下一声部的延长记号正扣在上一声部数字的脚下，顶上那道拱又平又宽，
   *  逐列量像一道减时线（83《…》`3 2 1̂ –` 上声部读成 `1̲`）。数减时线时当作下界（`recountUnderlines`）。认完延长记号后填。 */
  fermataCaps?: Rect[];
}

// jianpu.cpp: findBarline/analyze_barline/analyze_hline/analyze_dot —— 按形状分类连通域。
/** 高/低八度的窄数字（尤其唯一单竖笔的 "1"）常与其八度点 4-连通粘成一个**过高的窄竖块**
 *  （点 + 竖笔），落进"终止/粗小节线"判据被整块丢弃 —— 但**数字字形不含点**，故顶/底部这个
 *  与主笔隔着低墨谷的小墨斑必是八度点。按行墨廓在谷处切开，返回 { dot, digit } 两个合成连通块
 *  （dot 归 c.dots 供 buildJpNums 记八度、digit 归 c.blocks 正常识别）；非此形态返回 null。 */
function splitMergedOctaveDot(
  bin: Binary, b: Rect, numH: number, strict = false,
): { dot: Component; digit: Component } | null {
  // 仅"过高、但仍有真实笔宽的窄竖块"才可能是点+数字笔：真小节线常细至 1~2px（下限剔之），
  // 数字笔即便是最窄的 "1" 也有可观宽度（≈0.3~0.55字号）。
  // 宽数字粘点（78《马槽歌》Q2 `6̣`，6 与点连成 26×48，字号 30）：块高 ≥1.35 字号、宽不过一字号时也试，只走严格判据。
  const wide = strict && b.h >= numH * 1.35;
  if (b.h <= numH * 1.05 || b.w < numH * 0.3 || b.w > numH * (wide ? 1 : 0.6)) return null;
  const ink = rowInk(bin, b);
  const strokeInk = median(ink.filter((v) => v > 0)) || 1;
  const mk = (y0: number, y1: number): Component | null => {
    const t = tightBox(bin, b, 0, b.w, y0, y1);
    return t ? { id: -1, bbox: t, area: t.w * t.h, cx: rcx(t), cy: rcy(t) } : null;
  };
  // 在顶部窗口(高八度点)或底部窗口(低八度点)找与主笔隔开的低墨谷。
  const tryCut = (winLo: number, winHi: number, dotAtTop: boolean): { dot: Component; digit: Component } | null => {
    let v = -1, vMin = Infinity;
    for (let y = winLo; y < winHi; y++) if (ink[y] < vMin) { vMin = ink[y]; v = y; }
    if (v < 0 || vMin > strokeInk * 0.6) return null; // 无清晰低墨谷 → 非点+笔（真小节线墨廓均匀）
    // 严格：谷处近乎断开（只剩一个像素粘着）；宽数字那档放到 0.15 字号（同首 `6̣` 点带一截尾巴粘上来，二值图谷宽 4px）
    if (strict && vMin > (wide ? Math.max(1, numH * 0.15) : 1)) return null;
    const dotSeg = dotAtTop ? mk(0, v) : mk(v + 1, b.h);
    const digSeg = dotAtTop ? mk(v + 1, b.h) : mk(0, v);
    if (!dotSeg || !digSeg) return null;
    const dh = dotSeg.bbox.h, dgh = digSeg.bbox.h;
    // 点须是真墨斑(≥0.13字号见方、≤0.5字号)、数字笔须够高(≥0.55字号)且宽度像数字(≥0.28字号)。
    // 宽度下限把 1~2px 的细小节线/扫描竖纹挡在门外（它们墨廓也会有单像素起伏被误当"谷"）。
    if (dh > numH * 0.5 || dotSeg.bbox.w > numH * 0.5 || dotSeg.bbox.w < numH * 0.13) return null;
    if (dgh < numH * 0.55 || dgh > numH * 1.7 || digSeg.bbox.w > numH * (wide ? 1 : 0.7) || digSeg.bbox.w < numH * 0.28) return null;
    // 严格：点近乎方形、且明显窄于数字——3、5 的顶横扁而与数字等宽，过不了。
    if (strict && (dotSeg.bbox.w > dh * 1.7 || dh > dotSeg.bbox.w * 1.7 || dotSeg.bbox.w > digSeg.bbox.w * 0.8)) return null;
    // 宽数字那档另要点比谷明显宽：「4」的竖笔下端与谷一样粗，会被当成点切下来（同首 Q1 `4̲` 读成 `4̣`）
    if (wide && vMin > dotSeg.bbox.w * 0.55) return null;
    probe("splitMergedOctaveDot");
    return { dot: dotSeg, digit: digSeg };
  };
  return tryCut(Math.round(numH * 0.12), Math.round(numH * 0.6), true) ??
    tryCut(b.h - Math.round(numH * 0.6), b.h - Math.round(numH * 0.12), false);
}

/** 本页减时线的**统计线粗**：够宽够扁的横线的高度中位数（同伴 3px、切慕 2px）。
 *  剥线时按它量「线带该有多厚」，挂在线上的毛刺/点才不会被算成线。没有横线则 0（不剥）。 */
function strokeLineH(comps: Component[], numH: number): number {
  const hs = comps
    .filter((k) => k.bbox.w >= numH * 0.6 && k.bbox.h <= Math.max(3, numH * 0.32) && k.bbox.w >= k.bbox.h * 3)
    .map((k) => k.bbox.h);
  return hs.length >= 3 ? median(hs) : 0;
}

/** 减时线粘着别的墨：**按统计线粗把横线墨迹剥掉，再看剩下的是什么**。两种粘法：
 *
 *  · 线 + 挂在线下的低八度点（「线型」）：扁长的线下沿挂着一两个小墨斑，整块高过一条线，
 *    过不了「横线要够扁」那道门，也不是点、不是数字，**整块被丢**——那几拍的减时线和低音点一起没了
 *    （迦南诗选《竭力保守》`2̲ 1̳ 6̳` 207×15；《切慕》末行 `0̲6̣̲` 27×7；《同伴》首行 `0 3̣ 6̣ 7̣` 47×7，
 *    线顶还多个毛刺像素、线下挂两个点）。线行按「最长横向游程 ≥ 0.8 块宽」认。
 *  · 数字 + 它下面的线（+ 线下的点）（「数字型」）：数字的尾笔碰到减时线，线跑进了数字块里，
 *    buildJpNums 只在块外找线，这个音就没了减时线；块被撑高，还连累同行别的数字 rec 补高时把线裁进去
 *    （《同伴》「灵」19×22；第 3 行 `6̣ 7̣` 的 6 连线带两点 47×26，把同行的 7 读成了 1）。
 *    **数字底部总是窄的，减时线却要盖住整个数字宽**：先量块上部数字体的宽 bodyW，线行的游程要比它
 *    **宽出一截**（2 的底横、7 的顶横本就与数字等宽，只要求「不窄于」会把 2 的底笔剥掉），
 *    线带上方还得有一段窄「颈」（6 的尾巴、2 的底笔都窄于线），上下一样宽的不切。
 *
 *  线带找到后向上下吸收毛边行（墨量 ≥ 0.3 线宽），总厚不超过统计线粗 + 1。剥掉线带、对剩下的像素
 *  重做连通域，每一块都得说得清是什么：≤3px 的毛刺丢掉；线下方圆而实的小块是点；（数字型）线上方
 *  一个整字高的块是数字。**有一块说不清就整块放弃**，退回原来的归类——宁可漏也不凭空造出音符或八度。
 *  **只在干净谱面上用**（调用处把门）：脏页上线下沿粘的碎渣与八度点同形，切开等于凭空多一个八度。
 *  脏页只收剥出 ≥2 个数字的（一排数字压在同一条线上）。 */
function stripUnderline(
  bin: Binary, k: Component, numH: number, lineH: number,
): { lines: Component[]; dots: Component[]; digits: Component[] } | null {
  const b = k.bbox;
  if (lineH <= 0 || b.h <= lineH + 1) return null;                 // 高度对得上一条线 → 不用剥
  // 块高上限 0.7 字号：线下挂着低音点、点与线之间还连着一截颈，整块就超过 0.6（赞美诗歌1218 144 `6̲̣5̲̣` 73×21，字号 34）。
  // 超过 0.6 的那段要扁长（宽 ≥ 1.8 倍高）：升号 ♯ 近方、两道横笔也够宽（新编赞美诗·四声部 1 的 `#4` 21×19）
  const flat = b.w >= b.h * 1.8;
  const lineMode = b.w >= numH * 0.6 && (b.h <= numH * 0.6 || (flat && b.h <= numH * 0.7));
  // 块高下限 1.05 字号（原 1.15）：数字直接坐在线上，块高只是「字高 + 线粗」——新编赞美诗·四声部 f10 末系统 `1̲ 1̲ 1̲` 203×41、
  // f14 单个 `1̲` 31×40（字号 36）都够不上 1.15。剥出来还得是整字高的数字、线带上方有颈，说不清照旧整块放弃
  const digitMode = !lineMode && b.h >= numH * 1.05 && b.h <= numH * 2 && b.w >= numH * 0.3;
  if (!lineMode && !digitMode) return null;
  // 本块自己的像素（包围盒里可能还躺着别的块，如《同伴》那个 6 连线块的框里就有右邻的 7）。
  const sub: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) sub.data[y * b.w + x] = bin.data[(b.y + y) * bin.w + b.x + x];
  const labels = new Int32Array(b.w * b.h);
  const parts = connectedComponents(sub, 1, labels);
  const self = parts.find((p) => p.bbox.w === b.w && p.bbox.h === b.h) ?? parts.sort((p, q) => q.area - p.area)[0];
  if (!self) return null;
  const on = (x: number, y: number) => labels[y * b.w + x] === self.id;
  const rowCount = (y: number) => { let n = 0; for (let x = 0; x < b.w; x++) if (on(x, y)) n++; return n; };
  const rowRun = (y: number) => {
    let best = 0, cur = 0;
    for (let x = 0; x < b.w; x++) { if (on(x, y)) { if (++cur > best) best = cur; } else cur = 0; }
    return best;
  };
  const rowSpan = (y: number) => {
    let lo = -1, hi = -1;
    for (let x = 0; x < b.w; x++) if (on(x, y)) { if (lo < 0) lo = x; hi = x; }
    return lo < 0 ? 0 : hi - lo + 1;
  };
  const runs = Array.from({ length: b.h }, (_, y) => rowRun(y));
  let need: number;
  let yFrom = 0;                                                    // 线带只在这一行以下找
  // 几个数字并排压在一条线上（块宽 ≥1.4 字号）：数字体的横跨就是整块宽，「线比数字体宽出一截」够不上，
  // 改为线横贯块宽八成、颈按最长游程判（两个数字之间是空的，横跨宽不代表粘着）。
  const multi = digitMode && b.w >= numH * 1.4;
  if (lineMode || multi) {
    need = Math.max(numH * 0.6, b.w * 0.8);
    if (multi) yFrom = Math.round(numH * 0.7);
  } else {
    let bodyW = 0;
    for (let y = 0; y < Math.min(b.h, Math.round(numH * 0.8)); y++) bodyW = Math.max(bodyW, rowSpan(y));
    need = Math.max(numH * 0.6, bodyW + Math.max(2, numH * 0.1));
    yFrom = Math.round(numH * 0.7);
  }
  // 连续的线行成一条线带（可能两条：双减时线）
  const bands: Array<[number, number]> = [];
  for (let y = yFrom; y < b.h; y++) {
    if (runs[y] < need) continue;
    const last = bands[bands.length - 1];
    if (last && last[1] === y - 1) last[1] = y; else bands.push([y, y]);
  }
  if (!bands.length) return null;
  const cut = new Uint8Array(b.h);
  for (const band of bands) {
    const lineW = Math.max(...runs.slice(band[0], band[1] + 1));
    if (digitMode) {
      // 颈：线带上方紧挨的那一行得明显窄于线（上下一样宽 = 数字自己的横笔，不是粘上来的线）
      // 线带顶上断了口的毛边行（横跨够线宽、最长游程却不够）先让过去，至多一条线粗：新编赞美诗·四声部通本 `1̲` 的竖笔直接
      // 坐在线上，线顶那一行被竖笔两侧的缺口断成两段（f16 `1̲` 30×40：首行游程 18、横跨 28），拿它当「颈」就成了
      //「上下一样宽」，整块不剥——全本 `1̲→1` 一百五十处。数字自己的横笔横跨不过 need（need 比数字体宽出一截）。
      // 毛边行还得**密**（墨够四成线宽；274 `1̲` 线顶那行 20/35）：汉字「仁」底横上面那一行只有亻的竖笔和横笔收尾的钩，横跨够、墨很少（选本 346 歌词行
      // 由此剥出一串「1̲」凑成伪谱行）
      let above = band[0] - 1;
      // 几个数字共一条线的块同理（f11 `1̲ 1̲` 右边那个 1 坐线 97×40）：线顶毛边行的游程过了六成线宽、又不到 need
      for (let skip = 0; skip < lineH && above >= 0 && (multi ? runs[above]! >= lineW * 0.6 : rowSpan(above) >= need && rowCount(above) >= lineW * 0.4); skip++) above--;
      if (above < 0 || (multi ? runs[above]! : rowSpan(above)) >= lineW * 0.6) return null;
    }
    // 吸收毛边行，总厚不超过统计线粗 + 1
    let [y0, y1] = band;
    const maxH = lineH + 1;
    if (y1 - y0 + 1 > maxH) return null;                             // 比线还厚：不是减时线
    while (y1 - y0 + 1 < maxH) {
      const up = y0 - 1 >= 0 && (!digitMode || y0 - 1 >= yFrom) ? rowCount(y0 - 1) : 0;
      const dn = y1 + 1 < b.h ? rowCount(y1 + 1) : 0;
      if (up >= lineW * 0.3 && up >= dn) y0--;
      else if (dn >= lineW * 0.3) y1++;
      else break;
    }
    for (let y = y0; y <= y1; y++) cut[y] = 1;
    band[0] = y0; band[1] = y1;
  }
  const mkComp = (r: Rect, area: number): Component => ({ id: -1, bbox: r, area, cx: rcx(r), cy: rcy(r) });
  // 先照常剥线、认剩下的块；认不下来（说不清）再退一步**按行投影量线带**重来一遍（proj）
  const analyse = (proj: boolean): { lines: Component[]; dots: Component[]; digits: Component[] } | null => {
    // 吸收毛边后重叠的线带并成一道：隔行够长的一根线会先被认成几道单行线带，吸收后都成了同一段（爱主颂 95 的 `-` 20×8 → 三道 [1,5]）
    const bs: Array<[number, number]> = [];
    for (const [y0, y1] of bands) {
      const last = bs[bs.length - 1];
      if (last && y0 <= last[1]) last[1] = Math.max(last[1], y1); else bs.push([y0, y1]);
    }
    const ct = cut.slice();
    let extra = 0;
    // （线型）按行投影量出下方的短线带，不靠剥完再认：长线罩着几个音、第二道线只在其中一两个音下面，
    // 两道之间还被一坨墨连着（赞美诗歌1218 35 `3̲4̳` 70×16：短线 28px 与长线之间连着 7px 宽的墨），
    // 连着的那截高过一条线，剥出来认不成「第二条线」，整块放弃、两个音的线全丢。游程够长（≥ 0.4 字号且 ≥ 3 倍线粗）、
    // 厚度像条线的行段就是一道线带。只作退路：照常剥得出来的仍按剥出的块（爱主颂 92 `1̳6̳` 的第二道线
    // 投影只量得 2 行、剥出的块是 3 行，下游按块高认双线）。
    if (proj) {
      const need2 = Math.max(numH * 0.4, lineH * 3);
      let y = bs[bs.length - 1][1] + 1;
      while (y < b.h) {
        if (runs[y] < need2) { y++; continue; }
        let y1 = y;
        while (y1 + 1 < b.h && runs[y1 + 1] >= need2) y1++;
        const th = y1 - y + 1;
        if (th >= Math.max(2, lineH * 0.5) && th <= lineH + 1) {
          // 同主线带一样吸收上下毛边行（1218 35 那截短线实为 30×8，游程够长的只中间 5 行）
          const w2 = Math.max(...runs.slice(y, y1 + 1));
          let y0 = y;
          const last = bs[bs.length - 1][1];
          while (y1 - y0 + 1 < lineH + 1) {
            const up = y0 - 1 > last && !ct[y0 - 1] ? rowCount(y0 - 1) : 0;
            const dn = y1 + 1 < b.h ? rowCount(y1 + 1) : 0;
            if (up >= w2 * 0.3 && up >= dn) y0--;
            else if (dn >= w2 * 0.3) y1++;
            else break;
          }
          for (let yy = y0; yy <= y1; yy++) ct[yy] = 1;
          bs.push([y0, y1]); extra++;
        }
        y = y1 + 1;
      }
    }
    const lines: Component[] = [];
    for (const [y0, y1] of bs) {
      let x0 = b.w, x1 = -1, area = 0;
      for (let y = y0; y <= y1; y++) for (let x = 0; x < b.w; x++) if (on(x, y)) { area++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
      lines.push(mkComp({ x: b.x + x0, y: b.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, area));
    }
    // 剥掉线带后剩下的像素逐块认
    const rest: Binary = { w: b.w, h: b.h, data: new Uint8Array(b.w * b.h) };
    for (let y = 0; y < b.h; y++) if (!ct[y]) for (let x = 0; x < b.w; x++) if (on(x, y)) rest.data[y * b.w + x] = 1;
    const topBand = bs[0][0], botBand = bs[bs.length - 1][1];
    const dots: Component[] = [], digits: Component[] = [];
    for (const p of connectedComponents(rest, 1)) {
      // 毛刺：面积门随字号走（(0.15 字号)²；原固定 3px）。粗黑翻印件线上沿挂着几个几像素的斜碎点（1218 277：5~8px），
      // 固定 3px 时「说不清」整块放弃，减时线连着底下的点一起丢。真八度点远大于此（该页 ~90px；小图字号 16 时门约 6px）
      if (p.area <= Math.max(3, (numH * 0.15) ** 2)) continue;
      // （退路）夹在两道线带之间的墨是把两道线连成一块的连接墨（1218 270 双减时线 178×16，两道之间连着几坨），吞掉
      if (proj && bs.length >= 2 && p.bbox.y > topBand && p.bbox.y + p.bbox.h - 1 < botBand) continue;
      const r: Rect = { x: b.x + p.bbox.x, y: b.y + p.bbox.y, w: p.bbox.w, h: p.bbox.h };
      const pc = mkComp(r, p.area);
      const ratio = r.w / r.h;
      if (p.bbox.y > botBand && r.w >= numH * 0.1 && r.h >= numH * 0.1 && r.w <= numH * 0.5 && r.h <= numH * 0.5 &&
          // 宽高比下限 0.5：点经一截颈粘在线下，剥掉线带后颈还留在点上，成了竖长的水滴（1218 159 `7̲̣` 剥出 7×12）
          ratio >= 0.5 && ratio <= 1.7 && p.area >= r.w * r.h * 0.6) { dots.push(pc); continue; }
      // （线型）线带下方另一截**短减时线**：长线罩着 `6̳ 1̲ 1̳` 三个音，第二条线只在 6 和末一个 1 下面各有一截，
      // 右边那截顶到长线上粘成一块（迦南诗选 1776《在天上我有一位阿爸》110×12）。按「线」认回来，
      // 不然这块说不清、整块放弃，两个 1 的减时线全丢。
      // **厚度也得像条线**：剥完线带后沿常留一行一两像素的毛边（二值化把 `-` 的下沿啃出个台阶），
      // 1811《心愿》末音那根增时线（24×7、统计线粗 5）就这么被剥成「6px 的线 + 1px 的线」两条，
      // 于是 stackedHline 判成双减时线、增时线整根不算数，末小节少一拍。真的第二条线不会细过统计
      // 线粗的一半（1776 那两条同粗）。
      // 数字型也收：`2̲̇· 2̳̇` 两个数字连两道线成一块（新编赞美诗·四声部 37 第 2 系统 107×46），长线剥掉后右边那个 2 下面
      // 还剩一截短线，说不清就整块当成一个音
      // 厚度按「游程够六成块宽的行数」量：短线上沿常连着一两行数字底笔的残墨（同块剩 40×7，够长的只 3 行）
      let thick = 0;
      for (let y = p.bbox.y; y < p.bbox.y + p.bbox.h; y++) if (runs[y]! >= r.w * 0.6) thick++;
      if (p.bbox.y > botBand && thick >= Math.max(2, lineH * 0.5) && thick <= lineH + 1 && r.h <= lineH * 2 + 1 &&
          r.w >= Math.max(numH * 0.4, thick * 3)) {
        lines.push(pc); extra++; continue;
      }
      // 高上限 1.25 字号；够宽（≥0.3 字号，不是粘上来的小节线）的放到 1.4：一页两种字号时字号按小的那种估
      //（新编赞美诗·四声部 275 伴奏小行数字 30、声部行 37~38，字号估 30），声部行 `1̲̇ 2̲̇ 1̲̇` 连线一块 156×43，剥出的 2 高 38 过不了 1.25，
      // 整块当成一个音
      if (digitMode && p.bbox.y + p.bbox.h <= topBand && r.h >= numH * 0.85 &&
          (r.h <= numH * 1.25 || (r.h <= numH * 1.4 && r.w >= numH * 0.3))) { digits.push(pc); continue; }
      return null;                                                  // 说不清是什么 → 整块不动
    }
    if (digitMode && !digits.length) return null;
    // 只剩一条线：交给原来的横线判据。退路量出两道以上线带的（双减时线被连接墨粘成一块，1218 270）照收
    if (lineMode && !dots.length && !extra && !(proj && bs.length >= 2)) return null;
    // 退路至多两道：量出三道的是糊成一团的数字横笔（1218 1188 41×22，「5」「3」自带三道横笔），诗歌里几乎没有三条减时线
    if (proj && bs.length > 2) return null;
    probe(lineMode ? (proj ? "stripUnderline.lineProj" : "stripUnderline.line") : "stripUnderline.digit");
    if (extra) probe("stripUnderline.extraLine");
    return { lines, dots, digits };
  };
  // 退路同样只给扁长块：升号的两道横笔按投影也是「两道线带」（爱主颂 95 `#` 21×19）
  return analyse(false) ?? (lineMode && flat ? analyse(true) : null);
}

/** 倚音底下的减时线条数：从块底往下 0.6 字高内，逐行看有没有一条与它同宽的横墨，连着的算一条。
 *  **不数连通块**：第二条常与那道连到主音符的弧连成一块（2152 末行实测 15×11），
 *  按「扁而宽」的块判据一卡就只数得出一条，倚音的时值差一倍。 */
function graceDivLines(bin: Binary, b: Rect, medH: number): number {
  const x0 = Math.max(0, Math.round(b.x - b.w * 0.4));
  const x1 = Math.min(bin.w - 1, Math.round(rright(b) + b.w * 0.4));
  const need = b.w * 0.8;
  const yEnd = Math.min(bin.h, Math.round(rbottom(b) + medH * 0.6));
  let runs = 0, inRun = false;
  for (let y = Math.round(rbottom(b)) + 1; y < yEnd; y++) {
    let best = 0, cur = 0;
    for (let x = x0; x <= x1; x++) {
      if (bin.data[y * bin.w + x]) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    const wide = best >= need;
    if (wide && !inRun) runs++;
    inRun = wide;
  }
  return Math.min(runs, 3);
}

/** 装饰记号（波音 ∿、涟音等）画在音符**正上方**，常与那个音的高八度点 4-连通粘成一块：
 *  块进了数字通道，又因远离数字带被 groupRows 丢弃，粘着的点也就跟着没了
 *  （1600《南非之行》末小节的 `2̇`——记号盖住了它的八度点，音高整个掉了一个八度）。
 *  这里从这类**没进任何谱行**的块底部把圆点切回来：自下而上找一段窄行（宽 ≤0.5 字号 = 点宽），
 *  上头接着明显更宽的记号主体，两段之间墨宽突变即切点。切出的点交回 `cls.dots`，
 *  八度归属仍由 buildJpNums 原有那套判据决定（居中于数字、间隙 <0.8 字号）。 */
function splitOrnamentDot(bin: Binary, b: Rect, numH: number): Component | null {
  if (b.h < numH * 0.35 || b.h > numH * 0.95 || b.w < numH * 0.5 || b.w > numH * 1.6) return null;
  // 逐行的墨迹左右缘 → 行宽。点那几行窄，记号主体那几行宽。
  const rowSpan = (y: number): number => {
    let lo = -1, hi = -1;
    for (let x = 0; x < b.w; x++) if (bin.data[(b.y + y) * bin.w + (b.x + x)]) { if (lo < 0) lo = x; hi = x; }
    return lo < 0 ? 0 : hi - lo + 1;
  };
  const spans = Array.from({ length: b.h }, (_, y) => rowSpan(y));
  let y1 = b.h - 1;
  while (y1 >= 0 && spans[y1] === 0) y1--;            // 跳过底部空行
  let y0 = y1;
  while (y0 >= 0 && spans[y0] > 0 && spans[y0] <= numH * 0.5) y0--;
  const dotH = y1 - y0;
  if (dotH < numH * 0.15 || dotH > numH * 0.5) return null;
  if (y0 < 0 || spans[y0] < numH * 0.7) return null;   // 点上头必须紧接着明显更宽的记号主体
  const t = tightBox(bin, b, 0, b.w, y0 + 1, y1 + 1);
  if (!t || t.w > numH * 0.5 || t.w < numH * 0.13 || t.w < dotH * 0.5) return null; // 近方形的小墨斑才是点
  probe("splitOrnamentDot");
  return { id: -1, bbox: t, area: t.w * t.h, cx: rcx(t), cy: rcy(t) };
}

/** 估计数字字号：取"近似方形且较大"连通块的高度中位数。 */
function estimateNumH(comps: Component[]): number {
  const squarish = comps.filter((k) => {
    const r = k.bbox.w / k.bbox.h;
    return r > 0.35 && r < 1.6 && k.bbox.h >= 6;
  });
  const est = median(squarish.map((k) => k.bbox.h)) || 16;
  // 多段歌词的页上汉字拆成的偏旁碎块压低了中位（补充本 155：21，数字实高 33）。数字是瘦高的（宽高比 0.35~0.85），
  // 只拿瘦高块再估一次；明显更大（>1.3 倍）且瘦高块够多才改用——歌词少的页两者本来就差不多，不动
  const tall = squarish.filter((k) => k.bbox.w / k.bbox.h <= 0.85);
  const est2 = tall.length >= 20 ? median(tall.map((k) => k.bbox.h)) : 0;
  // 歌词字比数字大、段数又多时反过来估大：新编赞美诗 1《圣哉三一歌》四段词的汉字 h≈43 压过数字 h≈32，numH 估成 43，
  // 12×31 的「1」过不了数字块的宽度门（0.3 字号）被整曲丢光。改拿**夹在小节线之间**的瘦高块再估一次：
  // 小节线是细高竖条（宽 ≤ max(3, 0.12 高)），数字在它纵向中段、横向几个线高以内；歌词在线外，挨不上。
  // 抽样 6 本 48 首与识别出的数字实高差 ≤1px（没小节线的页凑不够样本，照旧）。
  const bars = comps.filter((k) => k.bbox.h >= 12 && k.bbox.w <= Math.max(3, k.bbox.h * 0.12));
  const anchored = bars.length >= 3 ? tall.filter((k) => bars.some((b) =>
    b.bbox.h >= k.bbox.h * 1.2 && Math.abs(b.bbox.x - k.bbox.x) <= b.bbox.h * 6 &&
    Math.abs(rcy(b.bbox) - rcy(k.bbox)) < b.bbox.h * 0.3)) : [];
  // 锚上的得占瘦高块的两成、且不小于原估计的 0.6：没几根真小节线的页（迦南诗选 1677《祷告》，16/385 块、中位 12 对数字 48）
  // 凑上来的是碎笔
  const est3 = anchored.length >= 15 && anchored.length >= tall.length * 0.2 ? median(anchored.map((k) => k.bbox.h)) : 0;
  if (est3 && est > est3 * 1.15 && est3 >= est * 0.6) { probe("numH.barAnchored"); return est3; }
  // 估小方向同理：补充本七十来页字号估 27~30、数字实高 36~37（汉字碎块压低了中位，est2 的 1.3 倍门又够不着）。
  // 门开在 1.2：差一成多的页照旧。还得跟瘦高块的估计 est2 对得上（差不到一成）：四声部的小节线跨两个声部，锚上的瘦高块混进
  // 别的东西（四声部 f1 数字 25、锚定估出 31 多，一整行丢了）；补充本那些页两者都在 36 上下
  if (est3 && est3 > est * 1.2 && est2 && Math.abs(est3 - est2) <= est3 * 0.1) { probe("numH.barAnchoredUp"); return est3; }
  return est2 > est * 1.3 ? est2 : est;
}

function isCleanPage(comps: Component[], numH: number): boolean {
  const barCands = comps.filter((k) =>
    k.bbox.h >= numH * 0.85 && k.bbox.h <= numH * 1.6 && k.bbox.w <= Math.max(2, numH * 0.35));
  return barCands.length >= 4 &&
    median(barCands.map((k) => k.bbox.w)) >= 2 &&
    median(barCands.map((k) => k.area / (k.bbox.w * k.bbox.h))) >= 0.95;
}

/** 圆滑线的端点粘着高八度点：谱面上弧从 `1̇` 的点旁起笔，两者 8-连通成一块（1697《温州的水 温州的山》
 *  一房 `1̇⌒6`、二房 `2̇⌒1̇`、`1̇⌒6⌒6`，4 个点全丢，音高各低一个八度）。这块在归类里什么都不是，
 *  点也就进不了点池；即便进了，整块弧的底边就是点的底边，buildJpNums 的「弧脚碎片」判据也会把它剔掉。
 *  故在归类**之前**拆开：按列数墨——弧线那几列只有一两像素的笔画，点那几列是实心的一整段
 *  （实测 6~8px vs 1~2px）。从块的左右两端往里扫，开头连着几列都明显比笔画厚、宽度像个点，
 *  就把这几列切成点，其余列收成去掉点的弧。点须圆（宽高比 0.6~1.7）、底边低于弧的其余部分
 *  （点挂在弧脚上，弧脚是弧的最低处）。
 *  **只在干净谱面上用**（isCleanPage）：翻拍件的弧线笔画粗细不匀，端点的墨团与点分不开。 */
/** 四声部页：跨两个声部的细长小节线（2.6~6 字号高）成排出现。 */
function isVoicedPage(comps: Component[], numH: number): boolean {
  return comps.filter((k) => k.bbox.h >= numH * 2.6 && k.bbox.h <= numH * 6 && k.bbox.w <= Math.max(2, numH * 0.35)).length >= 8;
}

function classify(comps: Component[], bin: Binary): { c: Classified; numH: number } {
  const numH = estimateNumH(comps);
  // 「干净谱面」判据：**看小节线直不直**。数字排版直接出的印刷本，小节线是一根绝对竖直、
  // 墨廓填满的矩形（bbox 内前景占比 ≥0.95，实测迦南诗选那批 0.977~1.000）；翻拍/复印件的
  // 同一根线总是歪一两个像素、边缘发毛，bbox 被撑宽、占比掉到 0.37~0.82（全部现有语料如此）。
  // 另要求线**够粗**（中位宽 ≥2px）——1px 细线的占比恒等于 1，分不出干净与否；以及**够多**
  // （≥4 根）免得拿一两根的偶然值当判据。
  // 只有干净页才做下面的「减时线+八度点」粘连切分：脏页上碎渣挂在减时线下沿时长得跟八度点
  // 一模一样，切开就是凭空多一个八度。
  const pageClean = isCleanPage(comps, numH);
  const lineH = strokeLineH(comps, numH);
  const c: Classified = { blocks: [], barlines: [], longBarlines: [], hlines: [], dots: [], dashLike: [], clean: pageClean, lineH };
  // 高瘦竖块可能是"八度点 + 窄数字"粘连体（数字不含点）：优先切开、把点与数字笔各归其类，
  // 否则会被下面的小节线判据整块吞掉而丢音（实测高八度 "1̇" 在单行简谱里 h 恰同真小节线）。
  const barCand = (w: number, h: number) =>
    (h >= numH * 0.85 && w <= Math.max(2, numH * 0.35)) || (h >= numH * 1.3 && w <= numH * 0.6 && h / w >= 2.2);
  // 点贴得近时整块只高 1.25 字号、够不上小节线候选（《祭司的国度》末行「权」的 1̇，点与竖笔只隔
  // 一个像素粘连，7×20 / numH 16），直接当数字块就把点裹进数字里、丢了八度。这类「窄而略高」的块
  // 也试切，但走严格判据（strict）：3、5 的顶横与竖笔之间也有细腰，宽松判据会把顶横当点切下来。
  for (const k of comps) {
    const { w, h } = k.bbox;
    const cand = barCand(w, h);
    if (cand || (w <= numH * 0.6 && h > numH * 1.05) || (w <= numH && h >= numH * 1.35)) {
      const sp = splitMergedOctaveDot(bin, k.bbox, numH, !cand);
      if (sp) { c.dots.push(sp.dot); c.blocks.push(sp.digit); continue; }
    }
    // 小节线：细高竖条（高 ≳ 字号，宽很窄），但**高不过一个谱行**——真线实测 1.5~2.2 字号
    // （1801《活水的江河》h48/numH31 = 1.55，基督更美 h118/数字 h55 = 2.15），故上限原取 4 字号；四声部本里两个声部
    // 共用一根小节线（新编赞美诗·四声部 7：h118、numH≈28，4.2 倍），卡 4 倍整行丢线，放到 6 倍。挡的是**贯穿整页的墨**：1801 那张图最右一列 x=1399 整列全黑（扫描边框，
    // 1977/1977 像素），过了细高竖条这道门进了 barlines，把每个谱行的行内相对门（见 buildRowMeta
    // 的 maxH）顶到 1977，全曲真小节线一根不剩。被挡下的边框列成了未归类块留在 comps 里，
    // 下游哪条通道都够不着（弧要 w ≥ 0.7 字号、波音 ≥0.25 字号、歌词带要 w ≥ 0.4 字宽、
    // 拍号补位池要 h < 0.55 字号），不必另行清理。
    // 四声部本还有从首声部一直画到末声部、中间隔着四行歌词的系统通长线（343 第 1、2 系统，约 12 字号）：上限放到 14 字号，
    // 另加不过页高三成——挡扫描边框靠的是它贯穿整页
    // 这种线只进 longBarlines：进了 barlines，系统左边那道连线会被反复记号检测配上点、读成「|:」（三一来临歌）
    const barMaxH = Math.min(numH * 14, bin.h * 0.3);
    if (h >= numH * 0.85 && w <= Math.max(2, numH * 0.35)) {
      if (h > barMaxH) { probe("barline.tooTall"); }
      else if (h > numH * 6) { c.longBarlines.push(k); continue; }
      else { c.barlines.push(k); continue; }
    }
    // 终止线/粗小节线：比普通小节线粗（w 可达 ~0.5字号），但仍**明显更瘦长**——高于一个字号且
    // h/w≥3.5。数字 "1"（一条竖笔）恰是"更宽更矮"：实测 w≈0.5字号、h≈1.3字号 → h/w≈2.7，低于
    // 3.5 被排除、落到下面的数字块判据；而粗终止线 ▮（实测 w15 h56 → h/w≈3.7）仍 ≥3.5 保留。
    // 早先用 h/w≥2.2 会把 "1" 当小节线整片丢掉（本行八处 "1" 全失，见「哦愿我有千万舌头」）。
    // 上限 6 字号（原 4）：四声部本里两个声部共用一根小节线（新编赞美诗·四声部 7：h118、numH≈28，4.2 倍），卡 4 倍整行丢线；
    // 这道上限挡的是贯穿整页的扫描边框（上千像素高），6 倍照样挡得住。
    if (h >= numH * 1.3 && h <= barMaxH && w <= numH * 0.6 && h / w >= 3.5) { (h > numH * 6 ? c.longBarlines : c.barlines).push(k); continue; }
    // 粗体本的终止线 ‖ 细粗两根糊成一块：赞美诗歌1218 599 末尾 24×51（字号 34），宽过 0.6 字号、h/w 只有 2.1，落进数字块读成 `0`。
    // 认法看墨：填充 ≥0.7、六成以上的列墨贯通 0.85 倍块高（实测 0.81、16/24 列）；数字 0 的填充 0.4 上下，粗体 8 也就 0.6
    if (h >= numH * 1.3 && h <= numH * 6 && w <= numH * 0.9 && k.area >= w * h * 0.7) {
      const cols = columnInk(bin, k.bbox, 0, h);
      // 还得是**两根**：中间有一道墨不到三成高的谷列，谷的左右两侧都有贯通列（599 那块第 10 列只 4px）。粗体「1」也实心、列墨贯通，
      // 但只有一根竖笔（哦，愿我有千万舌头 三个 `1` 被收成了线）
      const full = (v: number) => v >= h * 0.85;
      const valley = cols.some((v, x) => v <= h * 0.3 && cols.slice(0, x).some(full) && cols.slice(x + 1).some(full));
      if (valley && cols.filter(full).length >= w * 0.6) { probe("barline.fusedFinal"); c.barlines.push(k); continue; }
    }
    // 减时线粘着低八度点 / 数字：剥掉线带，各归各类（判据见 stripUnderline）。
    // 脏页只收「剥出 ≥2 个数字」的：一排数字底都压在同一条减时线上（78《马槽歌》Q2 `1̲2̲` 连线成一块 101×42，
    // 读成一个 1），这形是明摆着的，碎渣冒充八度点的顾虑在这里不成立。
    {
      const sp = stripUnderline(bin, k, numH, lineH);
      // 脏页上线型（只剥出点）的也收，但每个点正上方都得压着一个数字大小的块（横向对齐、底边离线顶不到 0.6 字号）：
      // 赞美诗歌1218 粗黑翻印件 `6̲1̲6̲` 的减时线连着底下的低八度点成一片（126×19），不剥就连线带点一起丢。
      // 碎渣挂在线下不会恰好正对着数字。
      const dotsUnderDigits = !!sp && !sp.digits.length && sp.dots.length > 0 && sp.dots.every((d) => comps.some((o) =>
        o !== k && o.bbox.h >= numH * 0.8 && o.bbox.h <= numH * 1.3 && o.bbox.w <= numH * 1.2 &&
        rcx(d.bbox) >= o.bbox.x && rcx(d.bbox) <= rright(o.bbox) &&
        k.bbox.y - rbottom(o.bbox) >= -2 && k.bbox.y - rbottom(o.bbox) <= numH * 0.6));
      // 只剥出线、没有点也没有数字的（双减时线粘成一块，1218 277 `6̳1̳` 131×16）：没有碎渣冒充八度点的顾虑，脏页也收
      // 要真是上下叠的双线（至少两道、横向重叠过半）：增时线挨着减时线粘成的块剥出来是左右错开的两截，按纯线收会把增时线
      // 当成第二道减时线（麦子若生了虫 `1-` 丢了增时线）
      const pureLines = !!sp && !sp.dots.length && !sp.digits.length && sp.lines.length >= 2 &&
        sp.lines.some((a, i) => sp.lines.some((b2, j) => j > i &&
          Math.min(rright(a.bbox), rright(b2.bbox)) - Math.max(a.bbox.x, b2.bbox.x) >= Math.min(a.bbox.w, b2.bbox.w) * 0.5 &&
          // 两道要一般粗：一根厚增时线也会被剥成「线 + 贴着的毛边」（麦子 20×7 → 20×5 + 19×2），毛边不到一半粗；
          // 真双减时线（1218 277，两道之间还连着细丝、框贴着）两道差不多粗
          Math.min(a.bbox.h, b2.bbox.h) >= Math.max(a.bbox.h, b2.bbox.h) * 0.5));
      // 一条减时线罩着两个音、只有一个粘上了线：剥出一个数字 + 一条往旁边伸出去的线，伸出去那段正上方还压着另一个
      // 数字大小的块（新编赞美诗·四声部 4 行首 `1̲ 3̲` 133×47，3 粘线、1 不粘；不收就整块当一个「3」、框宽 133，
      // 排到 1 前头成了 `3̲ 1̲`，下一声部的 `5̣̲ 5̣̲` 连点带线全丢）。碎渣不会恰好在线的另一头压着一个数字
      const digitOn = (o: Component, ln: Component) => o.bbox.h >= numH * 0.8 && o.bbox.h <= numH * 1.3 && o.bbox.w <= numH * 1.2 &&
        rcx(o.bbox) >= ln.bbox.x && rcx(o.bbox) <= rright(ln.bbox) &&
        ln.bbox.y - rbottom(o.bbox) >= -2 && ln.bbox.y - rbottom(o.bbox) <= numH * 0.6;
      const sharedLine = !!sp && sp.digits.length === 1 && sp.lines.length > 0 && (() => {
        const dg = sp.digits[0]!;
        const mates = comps.filter((o) => o !== k && sp.lines.some((ln) => digitOn(o, ln)) &&
          (rright(o.bbox) < dg.bbox.x || o.bbox.x > rright(dg.bbox)));
        return mates.length > 0 && sp.dots.every((d) => [dg, ...mates].some((o) =>
          rcx(d.bbox) >= o.bbox.x && rcx(d.bbox) <= rright(o.bbox)));
      })();
      // 一个数字坐在自己的减时线上、没剥出点：脏页那道门防的是碎渣冒充八度点，没有点就没这个顾虑
      //（新编赞美诗·四声部 f14 第 4 声部 `1̲` 连线一块 31×40，整块当成没线的 1，这本 `1̲` 漏线近两百处）。
      // 剥出的数字宽不过 0.9 字号：歌词汉字底下那一横也会被剥成「字 + 线」（1218 753「监」35×29、字号 30），数字最宽 0.8 上下
      const ownLine = !!sp && sp.digits.length === 1 && !sp.dots.length && sp.lines.length > 0 &&
        sp.digits[0]!.bbox.w <= numH * 0.9;
      if (sp && (pageClean || sp.digits.length >= 2 || dotsUnderDigits || pureLines || sharedLine || ownLine)) {
        if (!pageClean) probe(sp.digits.length >= 2 ? "stripUnderline.dirtyMulti" : sharedLine ? "stripUnderline.dirtySharedLine" :
          ownLine ? "stripUnderline.dirtyOwnLine" : "stripUnderline.dirtyDotsUnderDigits");
        c.hlines.push(...sp.lines); c.dots.push(...sp.dots); c.blocks.push(...sp.digits); continue;
      }
    }
    // 独立横线：扁宽（增时线/分隔），且不够高不足以含数字。
    // 宽度门 0.6 字号是照减时线（要盖住整个数字）定的，**增时线可以短得多**：迦南诗选那批
    // 粗体版面的 '-' 实测只有 0.48 字号宽（23px / numH 48），过不了门就整根丢掉——那批曲子
    // 每小节末尾的长音全变短，小节时值对不上。补一条「细长条」通道：宽 ≥0.4 字号且长宽比 ≥3
    // （真 '-' 实测 23×6 = 3.8 倍）。比值这条挡住了同宽度量级的碎渣（多是近方的小块）。
    // 比值的「高」用**平均墨厚**（面积 / 宽），不用包围盒高：线下沿挂一个毛刺像素，包围盒就高出一截——
    // 《同伴》「语，」`2 - -` 的第一条 '-' 实测 10×4、面积 25（厚 2.5），按包围盒 10 < 12 被挡，少了一拍。
    // 近方的碎渣平均墨厚与包围盒高相当，照样挡得住。
    // 比值从 3 放到 2.6：小图厚印的本子上 '-' 又短又粗——92《麦子若生了虫》第 2 行行首那根实测
    // 19×7（字号 32，比值 2.71），宽度差 0.2px 够不着 0.6 字号那道门，比值又卡在 3 上，整根被丢，
    // 那个音少一拍（同一行另外两根 20px 的就认了出来，可见是卡在噪声上）。近方的碎渣比值多在 1~2，
    // 2.6 仍挡得住。
    if ((w >= numH * 0.6 || (w >= numH * 0.4 && w >= (k.area / w) * 2.6)) && h <= Math.max(3, numH * 0.32)) {
      c.hlines.push(k); continue;
    }
    // 更短的 '-'：迦南诗选 1863《至暂至轻的苦楚算什么》小节末的 `3 - -` 印成两根 8×4 的短横（字号 24，
    // 只有 0.33 字号宽），尺寸落进下面「小点」那道门，被读成附点——`3 - -` 成了 `3.`。同页真附点 5×4。
    // 两者分在**扁度**：附点近圆（宽/平均墨厚 ≈1.25），短横 2 倍；门开在 1.8、宽另要 ≥0.28 字号、
    // 高 ≤0.2 字号（附点再扁也不会只有这么薄）。
    if (w >= numH * 0.28 && w >= (k.area / w) * 1.8 && h <= numH * 0.2) {
      probe("hline.shortDash"); c.hlines.push(k); continue;
    }
    // 再厚一点的：雅歌通本的 '-' 实测 13×7（字号 33，高 0.21、扁度 2.0），同页真附点 7×8（扁度 1.1），
    // 卡在上面 0.2 那道门外，全本 `5 - -` 读成 `5.`。但尺寸上它和小号粗印本里压扁的八度点、短波音分不开
    //（一概收成横线，1940、714、我今来就你 的八度点成了第三道减时线）——那两种不在数字中线上，增时线在。
    // 所以只记成候选、先当点，到 buildJpNums 按位置裁决（resolveDashLike）。
    // 扁度门比上面放低到 1.6：雅歌 1 的 `5̣ - - -` 第一根 12×7、平均墨厚 6.75，扁度 1.78 差一点；真圆点只有 1.0~1.1，
    // 候选还要过 resolveDashLike 的位置裁决
    // 宽下限 0.33 字号（原 0.28，雅歌的短横 12~13px 即 0.36~0.39）：新编赞美诗 100《万古磐石歌》末系统 `1̇.` 的附点 10×7
    //（字号 33，0.30）扁得过 1.6，又正落在数字中线上，被当成增时线
    if (w >= numH * 0.33 && w >= (k.area / w) * 1.6 && h <= numH * 0.25 && k.area >= w * h * 0.75) {
      c.dots.push(k); c.dashLike.push(k); continue;
    }
    // 小点：八度点/附点
    if (w <= numH * 0.45 && h <= numH * 0.45) { c.dots.push(k); continue; }
    // 数字块：高度接近字号（可略高于字号以容纳粘连的下划线），宽度不限（连音会更宽）。
    if (h >= numH * 0.55 && h <= numH * 2.0 && w >= numH * 0.3) { c.blocks.push(k); continue; }
    // 淡印的窄音符（典型是 "1"：二值化常只留上半截）高度会略低于一般阈值——窄竖块（w≤0.6字号）
    // 单独放宽到 0.5。但**只放窄块**：宽而矮的块多是下划线/碎片，放进来会凭空多识一个音（实测
    // 日光末行 w52 h24 误成 "7"）。
    if (w >= numH * 0.3 && w <= numH * 0.6 && h >= numH * 0.5 && h <= numH * 2.0) { c.blocks.push(k); continue; }
  }
  // 断成上下几截的小节线接回一根：新编赞美诗 293《耶稣住我心歌》第 2 行 `3·3̲|3̲` 那根断成 29+34px（同行整根 64px），
  // 两截各自过不了 buildRowMeta 的行内相对门（最高线的 0.6），整根丢掉。只接**细**的（≤ max(3, 0.2 字号) 宽，数字 1 宽 ≥0.28 字号）、
  // 同一竖直线上（中心差 ≤2px）、上下相隔不过 max(3, 0.15 字号) 的。只接已归为小节线的几截：连没归类的细竖碎块一起接，
  // 会把歌词、段号的竖笔接到线上（四声部 95、115、155 首谱行被当伪行丢、歌词整段错位）
  {
    // 每截都得够短（≤1.4 字号）：四声部上下两声部各自的整根小节线也是上下相接、只隔几像素（360《小小水滴歌》），接成一根就把两个声部连成一组
    // 长一些的两截，接起来不超过本页长线的中位高也接（一根跨两声部的线断成 76+42，整根 118）；360 那种接起来是两根长
    const tallH = median(c.barlines.filter((k) => k.bbox.h > numH * 1.4).map((k) => k.bbox.h)) || 0;
    const slim = (k: Component) => k.bbox.w <= Math.max(3, numH * 0.2);
    const thin = (k: Component) => slim(k) && k.bbox.h <= numH * 1.4;
    const gapMax = Math.max(3, numH * 0.15);
    const joinable = (a: Rect, b: Rect) => Math.abs(rcx(a) - rcx(b)) <= 2 &&
      Math.max(a.y, b.y) - Math.min(rbottom(a), rbottom(b)) <= gapMax;
    const joinTall = (a: Component, b: Component) => slim(a) && slim(b) && joinable(a.bbox, b.bbox) &&
      unionRect(a.bbox, b.bbox).h <= tallH * 1.1;
    const merged: Component[] = [];
    const used = new Set<Component>();
    for (const k of c.barlines) {
      if (used.has(k)) continue;
      if (!slim(k)) { merged.push(k); continue; }
      let bb = k.bbox, n = 1, area = k.area, grew = true;
      while (grew) {
        grew = false;
        for (const o of c.barlines) {
          if (o === k || used.has(o)) continue;
          const cur: Component = { ...k, bbox: bb };
          if (!(thin(k) && thin(o) && joinable(bb, o.bbox)) && !joinTall(cur, o)) continue;
          used.add(o); bb = unionRect(bb, o.bbox); area += o.area; n++; grew = true;
        }
      }
      if (n > 1) { probe("barline.rejoined"); merged.push({ id: k.id, bbox: bb, area, cx: rcx(bb), cy: rcy(bb) }); }
      else merged.push(k);
    }
    c.barlines = merged;
  }
  // 「细高竖条」既可能是小节线，也可能是数字 "1"（一条竖笔）。二者宽都很窄、高都 ≳ 字号，
  // 形状难分；但真小节线会明显高于数字带，而 "1" 的高度通常不超过 1.25×字号、笔宽仍至少约
  // 0.28×字号。先用这两个绝对尺度收回 "1"；再用候选高度中位数兜底处理偏矮者。不能只依赖
  // 中位数：当一首歌的 1 很多时（如「爱是不保留」首行），候选中位数本身就是 1 的高度，
  // 原规则会把同一组四个 1 全留在小节线里。
  if (c.barlines.length >= 4) {
    const medH = median(c.barlines.map((k) => k.bbox.h));
    const real: Component[] = [];
    for (const k of c.barlines) {
      const digitOneSized = k.bbox.h <= numH * 1.25 && k.bbox.w >= numH * 0.28;
      if (digitOneSized || k.bbox.h < medH * 0.55) {
        // 偏矮 → 多半是数字 "1"。但终止/复纵线（‖）的细线常因扫描淡而偏矮，它紧贴另一根
        // 竖线（间距 < 0.7×字号、同 y）——这种有近邻的不当 "1"，保留为小节线。
        // 邻线也不能高出它太多：四声部谱跨两声部的长线（新编赞美诗·四声部《圣哉三一歌》115px）旁边紧挨着的
        // `1`（35px，距 17px）会被当成终止线的细线留下，那一小节整个没了。终止线的两根再淡也差不了两倍（原 2.5：
        // 补充本 198 阿们行 `|1---` 的瘦「1」12×37 贴着 83px 的小节线，2.24 倍，被当成终止线的细线）
        const paired = c.barlines.some((o) => o !== k &&
          Math.abs(rcx(o.bbox) - rcx(k.bbox)) < numH * 0.7 && Math.abs(rcy(o.bbox) - rcy(k.bbox)) < numH &&
          o.bbox.h <= k.bbox.h * 2);
        // 细于 0.2 字号的不是 1（1 的竖笔至少 0.28 字号宽）：是小节线断下来的一截或擦线剩下的线边
        //（78《马槽歌》末系统 Q2 那截 5×43、行首擦剩的 2×36）。够一字高的留作小节线，否则丢掉。
        if (!paired && k.bbox.w < numH * 0.2) {
          probe("barline.residue");
          if (k.bbox.h >= numH) real.push(k);
          continue;
        }
        if (!paired) { c.blocks.push(k); continue; }
      }
      real.push(k);
    }
    c.barlines = real;
  }
  return { c, numH };
}

/** 合法拍号：分母 2 的幂、分子 1..16（同 header.ts::validMeter 的口径）。 */
const validMeter = (n: number, d: number) => n >= 1 && n <= 16 && (d === 2 || d === 4 || d === 8 || d === 16);

/** 复核歌词字（`JpNum.lyricDoubt`）：每个汉字取 OCR 候选，第一名不是识别结果（上层按上下文改过），
 *  或第一名比第二名高不了 `LYRIC_DOUBT_MARGIN` 的，记下这一段。取不到候选的字（附段、参照歌词补的）不看。 */
const LYRIC_DOUBT_MARGIN = 0.7;
async function markLyricDoubts(rows: readonly StaffRow[], hooks: LyricHooks): Promise<void> {
  // `idx` 与 `charSrc` 同口径：这一段里第几个**汉字**（引号、括号不数）
  const hanzi = (text: string | undefined): string[] => [...(text ?? "")].filter((c) => /[\u4e00-\u9fff]/.test(c));
  const reqs: LyricCharRef[] = [];
  for (const r of rows) for (const n of r.nums) (n.lyrics ?? []).forEach((text, verse) => {
    hanzi(text).forEach((_, idx) => reqs.push({ n, verse, idx }));
  });
  if (!reqs.length) return;
  const alts = await hooks.rankAlts(reqs);
  reqs.forEach((q, k) => {
    const a = alts[k];
    const ch = hanzi(q.n.lyrics?.[q.verse])[q.idx];
    if (!a || !a.alts.length || !ch) return;
    const margin = (a.scores[0] ?? 1) - (a.scores[1] ?? 0);
    if (a.alts[0] !== ch || margin < LYRIC_DOUBT_MARGIN) {
      const set = new Set<number>(q.n.lyricDoubt ?? []);
      set.add(q.verse);
      q.n.lyricDoubt = [...set].sort((x, y) => x - y);
    }
  });
}

/** 数字框中央横带的前景占比（x∈[0.28,0.72]×y∈[0.42,0.58]）：简谱 "0" 是空心椭圆环，中带几乎无墨
 *  （实测各图真 0 ≤0.47）；被二值化糊死的 "3"（中间横笔连成一条穿心的"斜线"）中带占满（3 恒 ≥0.7）。
 *  → 判"读成 0 却中带有横笔"= 实为糊住的 3 等，供 0 误判复原（简谱 0 从不带斜线）。 */
function midbandInk(bin: Binary, b: Rect): number {
  const x0 = Math.round(b.x + b.w * 0.28), x1 = Math.round(b.x + b.w * 0.72);
  const y0 = Math.round(b.y + b.h * 0.42), y1 = Math.round(b.y + b.h * 0.58);
  let n = 0, t = 0;
  for (let y = Math.max(0, y0); y < Math.min(bin.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(bin.w, x1); x++) { t++; if (bin.data[y * bin.w + x]) n++; }
  return t ? n / t : 0;
}

/** 中带（0.42–0.58 块高）过半的行在左右墨迹之间夹着空白 = 有内孔。粗体小图的 0 内孔只剩 2px，
 *  按 midbandInk 的固定中框量墨会过 0.65（1940《宣告得胜年》末行 `0 0`，12×14），被当成糊死的 3
 *  复原成别的数；糊死的 3 中带左边是敞口、不夹空白，分得开。 */
function midbandHole(bin: Binary, b: Rect): boolean {
  const y0 = Math.round(b.y + b.h * 0.42), y1 = Math.max(y0 + 1, Math.round(b.y + b.h * 0.58));
  let rows = 0, holes = 0;
  for (let y = Math.max(0, y0); y < Math.min(bin.h, y1); y++) {
    rows++;
    let lo = -1, hi = -1, ink = 0;
    for (let x = b.x; x < Math.min(bin.w, b.x + b.w); x++) if (bin.data[y * bin.w + x]) { if (lo < 0) lo = x; hi = x; ink++; }
    if (lo >= 0 && ink < hi - lo + 1) holes++;
  }
  return rows > 0 && holes * 2 > rows;
}

/** `refLyrics`：同一首诗歌的歌词文本（已解码），给了就与识别歌词互证纠错（reflyrics.ts），结果在 `lyricCheck`。 */
export async function recognizeJianpu(bin: Binary, ocr: OcrBackend, opts: { refLyrics?: string; review?: boolean } = {}): Promise<RecognizedScore> {
  // 去连通：把贯穿全高的小节线（常像"桥"把弧/增时线粘成一团）从像素上擦掉重做连通域，
  // 让弧/小节线/数字各自独立、以干净连通块流入下面的 classify 与 detectSlurs。
  const raw = connectedComponents(bin, 4);
  // 每拆一步块表就换一份，字号随之重估；同一份块表只估一次（各 split 都返回新数组、不就地改块，按数组认就行）
  let nhOf: Component[] | null = null, nhVal = 0;
  const numHOf = (cs: Component[]): number => (cs === nhOf ? nhVal : ((nhOf = cs), (nhVal = estimateNumH(cs))));
  let comps = mergeBrokenHlines(untangleBridged(raw, bin, numHOf(raw)), numHOf(raw));
  comps = splitBarDash(bin, comps, numHOf(comps));
  comps = splitBarCap(bin, comps, numHOf(comps));
  if (isVoicedPage(comps, numHOf(comps))) comps = splitDigitDash(bin, comps, numHOf(comps));
  comps = splitArcTail(bin, comps, numHOf(comps));
  comps = splitLineOverArc(bin, comps, numHOf(comps));
  comps = splitLineDot(bin, comps, numHOf(comps), isVoicedPage(comps, numHOf(comps)));
  // 弧端切点在四声部页上也做：这种页的线跨两个声部（≥2.6 字号），进不了「干净页」的尺子；弧又贴着音起笔，
  // 右脚常压在下一个音的高音点上（新编赞美诗·四声部 172 `1̇⌒2̇` 弧连点 58×22，整本漏高音点三百多处）
  const cleanPage = isCleanPage(comps, numHOf(comps));
  // 这本的弧画得粗（4~5px、字号 32~36，中位列墨 0.13~0.15 字号），笔画门放到 0.18
  if (cleanPage || isVoicedPage(comps, numHOf(comps))) comps = splitArcEndDots(bin, comps, numHOf(comps), cleanPage ? 0.12 : 0.18, !cleanPage);
  if (cleanPage) {
    comps = splitArcInnerDots(bin, comps, numHOf(comps));
    comps = splitMordentDot(bin, comps, numHOf(comps));
  }
  const { c, numH } = classify(comps, bin);

  // 数字块 → 数字格（拆分粘连/连音，并测各自下划线 div）。
  // 与数字粘连的圆滑线弧帽在此切出，作为合成连通块补进 comps 供 detectSlurs 检测。
  let allCores: DigitCore[] = [];
  const mergedArcs: Rect[] = [];
  const voicedPage = isVoicedPage(comps, numH);
  for (const blk of c.blocks) {
    // 扁而宽的矮块不是数字：连音弧拱得高一点就够不上横线的扁度门、落进数字块（78《马槽歌》擦掉小节线后接回的
    // `5⌒|5` 弧 56×17，字号 30）。单声部谱上它在数字行上方另成一「行」、随后被滤掉；四声部谱两声部挨得近，
    // 它并进了下一声部的谱行，读成 `0`。数字再怎么粘连也没这么扁（两三个粘连的数字宽高比也就 1~2）。
    // 拱得高的弧（同首 56×26）扁度不够，但墨只是一条线：够宽、不到一字高、墨占包围盒不到两成的也不是数字。
    const thinCurve = blk.bbox.w >= numH * 1.5 && blk.bbox.h < numH && blk.area < blk.bbox.w * blk.bbox.h * 0.2;
    if ((blk.bbox.w >= blk.bbox.h * 2.5 && blk.bbox.h < numH * 0.7) || thinCurve ||
      isRejoinedArc(blk)) { probe("block.flatArc"); continue; }
    const sharp = voicedPage ? splitGluedSharp(bin, blk, numH) : null;
    if (sharp) { allCores.push(...sharp); continue; }
    const { cores, arc } = splitBlock(bin, blk, numH);
    allCores.push(...cores);
    if (arc) mergedArcs.push(arc);
  }
  const arcComps: Component[] = mergedArcs.map((bb, i) => ({
    id: 1_000_000 + i, bbox: bb, area: bb.w * bb.h, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2,
  }));

  // 曲中转拍号「3/4」：先把分子/分母两个数字格与分数线从音符流里摘出去（见 meterCandidates），
  // 再按 OCR 出的数值校验；读出来不是合法拍号就当误判、把两个数字格放回音符流。
  // 分数线候选不能只取 hlines：拍号那道线**比减时线短得多**（与数字同宽，实测 19px / numH 48），
  // 过不了 classify 里横线的宽度门、落进了「小点」那一类 —— 于是页眉的 `6/4`、`3/4 4/4` 一个都
  // 认不出来，整曲退回默认 4/4（迦南诗选《天不蓝了》全曲 24 小节因此每小节都对不上拍）。
  // 故把「扁而短的小块」也放进候选池：meterCandidates 要求正上、正下各紧贴一个数字，
  // 八度点/附点凑不齐这两条，不会误判。
  const flatDot = (k: Component) => k.bbox.w >= numH * 0.3 && k.bbox.w >= k.bbox.h * 2.5;
  // 拍号数字比音符小一号，高度就卡在 classify 数字块门槛（0.5 字号）上下：1717《不怕劳累 不怕饥寒》
  // 页眉 `3/4 4/4 5/4` 三个分母 18/17/18px、numH 36，门是 18——中间那个 4 差 1px，没归进任何一类
  // 被整个丢掉，4/4 就没了。这些没归类的小块单放一个补位池，只在凑拍号时借用（规矩见 meterCandidates）。
  const classified = new Set<Component>([...c.blocks, ...c.barlines, ...c.hlines, ...c.dots]);
  const spareCores: DigitCore[] = comps
    .filter((k) => !classified.has(k) && k.bbox.w >= numH * 0.25 && k.bbox.h >= numH * 0.35 && k.bbox.h < numH * 0.55)
    .map((k) => ({ bbox: k.bbox, div: 0 }));
  const meterCands = meterCandidates(allCores, [...c.hlines, ...c.dots.filter(flatDot)], numH, spareCores);
  const meterMarks: { x: number; beats: number; beatType: number; bbox: Rect }[] = [];
  const meterCores = new Set<DigitCore>();
  const meterLines = new Set<Component>();
  if (meterCands.length) {
    const rects = meterCands.flatMap((m) => [m.up.bbox, m.dn.bbox]);
    const vals = await ocr.recognizeDigits(bin, rects);
    // 0–7 之外的数（分母 8、分子 9）另按 0–9 读。分子只收 9：粗体小字的 3 常读成 8（1940），
    // recognizeDigits 的闭环改判能把它改回 3，0–9 那路不改——分子 8 的拍号又少见，宁取前者。
    const wide = ocr.recognizeNumerals ? await ocr.recognizeNumerals(bin, rects) : [];
    meterCands.forEach((m, i) => {
      const wb = wide[2 * i], wt = wide[2 * i + 1];
      const beats = wb === 9 ? 9 : vals[2 * i] ?? 0;
      const beatType = wt !== undefined && validMeter(1, wt) ? wt : vals[2 * i + 1] ?? 0;
      if (!validMeter(beats, beatType)) return;
      probe("meterCandidates");
      meterMarks.push({ x: rcx(m.bbox), beats, beatType, bbox: m.bbox });
      meterCores.add(m.up); meterCores.add(m.dn); meterLines.add(m.line);
    });
    if (meterCores.size) {
      allCores = allCores.filter((k) => !meterCores.has(k));
      // 分数线留在 hlines 里会被右邻音符当成增时线（它与数字带同高）；来自小点池的同理要摘掉。
      c.hlines = c.hlines.filter((h) => !meterLines.has(h));
      c.dots = c.dots.filter((k) => !meterLines.has(k));
    }
  }

  const rowsC = groupRows(allCores, numH);
  // 每行的 y 范围 + 穿过的小节线。
  const rowMetaAll = rowsC.map((rd) => {
    const topY = Math.min(...rd.map((k) => k.bbox.y));
    const botY = Math.max(...rd.map((k) => rbottom(k.bbox)));
    // 小节线须**纵向贯穿本行**（覆盖本行 [topY,botY] 的大部分）。歌词行竖笔在行下方、
    // 与本行纵向重叠≈0 → 自然被滤掉。用"重叠占比"而非两道紧边界阈值：后者会因竖线起点
    // 偏几像素(如行3 x=466 顶部仅低 1.2px)就误杀真线。
    const rowH = botY - topY;
    // 纵向贯穿本行的小节线候选（覆盖本行 [topY,botY] 的大部分）。歌词行竖笔在行下方、
    // 与本行纵向重叠≈0 → 自然被滤掉。
    // 高度也要**跟本行一般高**（≤4 倍行高）：下面的 maxH 是行内相对门，一根异常高的候选就能
    // 把整行真线剔光（1801 那张图的页面边框列实测 h1977、行高 31，全曲小节线因此一根不剩）。
    // classify 里已按字号挡过一道，这里再按行高挡一道——两处口径一致、互不依赖。
    // 重叠也可以按**数字带**（各核上下沿的中位数）量：行里有个探出去的升降号/弧帽，包围范围就被撑高，
    // 四声部谱跨两声部的小节线本就只从数字顶附近起画（《圣哉三一歌》第 2 系统 Q3：`♯` 把行顶抬到 1210，
    // 线从 1226 起，按包围范围重叠 0.68，按数字带 0.79）。两种量法任一够 0.7 就算贯穿。
    const bandTop = median(rd.map((k) => k.bbox.y)), bandBot = median(rd.map((k) => rbottom(k.bbox)));
    const overlapsRow = (b: { bbox: Rect }) =>
        (Math.min(rbottom(b.bbox), botY) - Math.max(b.bbox.y, topY) >= rowH * 0.7 ||
          Math.min(rbottom(b.bbox), bandBot) - Math.max(b.bbox.y, bandTop) >= (bandBot - bandTop) * 0.7 ||
          // 下两个声部共用一根长线（新编赞美诗·四声部 313：1329~1437，第 3 声部数字带 1315~1352），线头落在上面那个声部的
          // 中腰，只重叠 0.62——长过数字带两倍的线放到 0.55，免得整行被当成没小节线的歌词行丢掉
          (b.bbox.h >= (bandBot - bandTop) * 2 &&
            Math.min(rbottom(b.bbox), bandBot) - Math.max(b.bbox.y, bandTop) >= (bandBot - bandTop) * 0.55));
    const spanning = c.barlines.filter((b) => b.bbox.h <= rowH * 4 && overlapsRow(b));
    // 系统通长线（四声部 343 第 1、2 系统：从首声部画到末声部、中间隔着四行歌词，约 12 字号）：比 4 倍行高还长，
    // 单独收——落在本行音符横向范围内才算，也不进下面的行内相对门（不然本行正常的短线全被它压掉）
    const x1 = Math.max(...rd.map((k) => rright(k.bbox)));
    // 左边至少两个核：系统起始那道连线左边只有连谱号的钩（常被收成一个核，52 读成「0 |」）
    const longBars = [...c.barlines, ...c.longBarlines].filter((b) => b.bbox.h > rowH * 4 && b.bbox.h <= rowH * 12 &&
      rd.filter((k) => rcx(k.bbox) < rcx(b.bbox)).length >= 2 && rcx(b.bbox) < x1 + numH * 2 && overlapsRow(b));
    // 真小节线是贯穿整个谱行的高竖线（实测远高于数字行：基督更美 h118 vs 数字 h55）；而数字 "1"
    // 的竖笔、扫描里的细竖纹等"伪小节线"仅约一个字高、且常仅 1px 宽，会撞上面的贯穿判据。它们与真线
    // 同 x 反复出现 → 凭单条 overlap 难剔。但**同一谱行内真小节线高度集中成簇且明显最高**：按本行候选
    // 的最大高度设相对门（<0.6×行内最高 → 丢弃）即可干净分开——基督更美 h44<0.6×118 被剔，而日光
    // (45~70)、世上(真 35~49)行内最高与真线同簇，整簇保留。绝对/字号比阈值跨图不通，故用行内相对。
    // 最高线不算行首音左边的：系统起始那道连线（四声部 9 第 3 系统下两声部 2×163，普通线 118）比谁都高，
    // 拿它当尺，断成两截的真线（76px）就过不了 0.6
    const xFirst = Math.min(...rd.map((k) => k.bbox.x));
    const inRow = spanning.filter((b) => rcx(b.bbox) > xFirst);
    const maxH = Math.max(0, ...(inRow.length ? inRow : spanning).map((b) => b.bbox.h));
    const real = [...spanning.filter((b) => b.bbox.h >= maxH * 0.6), ...longBars].sort((a, b) => rcx(a.bbox) - rcx(b.bbox));
    const barlineXs = real.map((b) => rcx(b.bbox));
    return { rd, topY, botY, barlineXs, bars: real, long: new Set(longBars), tail: false };
  });

  // 少于三个数字的「行」多半是噪声（歌词碎笔、标题/页脚里的竖笔），一概不要——**除了末行
  // 那种「一个音 + 一条终止线」**：2157《在这希望的田野上》末行就是 `1 - - -‖`，整行只有一个
  // 数字（减时线是 hline，不算核），旧判据一刀切掉，整行连歌词「望！」一起丢。
  // 救回的门开得极窄，三条都得满足，缺一条就是误救（实测放宽任一条都会在别的曲子上凑出假谱行：
  // 只卡「有高竖线」时，世上/南非的标题带被凑成一行，标题识别跟着归零）：
  //   ① 位置在所有正经谱行**之下**——末行才叫末行；
  //   ② 带着**两条**并排的终止线（普通小节线只有一条，凑不出这个形）；
  //   ③ 那两条与正经谱行的小节线一般高（中位高的 0.6，与行内相对判据同一口径）。
  // 伪行的**几何**剔除（赶在 buildJpNums/OCR 之前——留着会污染 medBarH、staffY 与歌词带的行序）：
  //   · **扁块行**：数字一律高瘦，行内多数核却是「扁而矮」（w ≥ 1.5h 且 h < 0.7 字号）的，
  //     那是歌词汉字的底部笔画被 classify 收成了数字块（95《灵同胞》实测 46×19、49×19，字号 32，
  //     两行凑在歌词行下沿，OCR 读成 `0 2 7` / `1 0 7` 混进曲末）。
  //   · **贴着谱行的装饰碎块行**：核少（<4）又紧挨在另一条像样谱行的上缘（间隙 <1.2 字号）的，
  //     是那一行的弧帽/八度点碎块自成一「行」（1801《活水的江河》实测 15×22、58×24、15×21，
  //     topY 1432 距下方谱行 1461 只 0.94 字号，OCR 读成 `2. 0. 5`）。真谱行之间隔着一整条歌词带，
  //     挨不了这么近。
  const flatCore = (k: DigitCore) => k.bbox.w >= k.bbox.h * 1.5 && k.bbox.h < numH * 0.7;
  //   · **调号行**：`1=♭E 4/4` 单印一行、字号与谱行相当时，1、E、拍号数字凑够了核，♭ 的竖笔又被收成小节线
  //    （补充本 71《义仆君王》：读成 `1 | 7 1`、页眉 ROI 随之只剩一行）。认法：行首核右边一个字宽内有 `=`——
  //     两道上下叠、横向对齐、都落在该核腰部的短横。简谱里增时线从不上下叠，减时线在数字下方，凑不出这个形。
  //     尺度用行首那个「1」自己的高度，不用 numH——多段歌词的页 numH 常被偏旁碎块压小（补充本 151 估成 19，
  //     `=` 的横 23px、「1」高 34）。
  const keyLineRow = (rd: DigitCore[]): boolean => {
    if (!rd.length) return false;
    const first = rd.reduce((a, b) => (b.bbox.x < a.bbox.x ? b : a)).bbox;
    const u = Math.max(numH, first.h);
    const bars = c.hlines.map((k) => k.bbox).filter((b) => b.x >= rright(first) - 1 && b.x - rright(first) <= u &&
      b.w <= u * 1.2 && rcy(b) >= first.y + first.h * 0.2 && rcy(b) <= first.y + first.h * 0.8);
    return bars.some((a) => bars.some((b) => b !== a && rcy(b) > rcy(a) && rcy(b) - rcy(a) <= numH * 0.5 &&
      Math.min(rright(a), rright(b)) - Math.max(a.x, b.x) >= Math.min(a.w, b.w) * 0.6));
  };
  // **第一条像样的谱行以上**是页眉：标题、曲号、左上角分类小字那几排被凑成「行」，分类小字中间的分隔横线又被
  // 当成增时线，休止占比的门跟着放到 0.8，整排读作 0 的汉字也留了下来（补充本 151、174、95 前两三「行」全是页眉）。
  // 那片区域里调号行以上的丢掉。（试过再按「半数核近方」丢汉字行：粗体数字、连着减时线的核也近方，老语料多首第一谱行被删，未上。）
  // 只在第一谱行**之上**动：「1=」的形在分类小字里也凑得出来（151「信徒灵修」的「信」竖笔 +「徒」两横），
  // 放到全页去找，歌词里碰上一处就会把上面的真谱行整片删掉。
  const squareCore = (k: DigitCore) => k.bbox.w > k.bbox.h * 0.8 && k.bbox.h >= numH * 0.6;
  const firstMusicTop = Math.min(...rowMetaAll
    .filter((m) => m.rd.length >= 3 && m.barlineXs.length >= 2 && m.rd.filter((k) => !squareCore(k)).length >= m.rd.length * 0.7)
    .map((m) => m.topY));
  const musicRowH = median(rowMetaAll.filter((m) => m.rd.length >= 3 && m.barlineXs.length >= 2).map((m) => median(m.rd.map((k) => k.bbox.h)))) || numH;
  const keyLineBot = Math.max(-Infinity, ...rowMetaAll.filter((m) => m.botY < firstMusicTop && keyLineRow(m.rd)).map((m) => m.botY));
  const pageRowH = median(rowMetaAll.filter((m) => m.rd.length >= 3).map((m) => median(m.rd.map((k) => k.bbox.h))));
  // **通栏横线以下是注释**：选本诗歌712 通本谱后隔一道过半页宽的细线印词语注释（「(11)1.昏沉若病：…」），
  // 注释里的数字凑成了几条伪谱行（`[1 0. 2. | 3 |`）。线上方至少已有两条谱行才认，免得页眉的装饰线误伤。
  const noteRuleY = Math.min(...c.hlines
    .filter((h) => h.bbox.w >= bin.w * 0.5 && rowMetaAll.filter((m) => m.botY < h.bbox.y && m.barlineXs.length >= 2).length >= 2)
    .map((h) => h.bbox.y));
  // **末谱行以下的方块字行是注释**：没有通栏线隔开的（选本 217 附段下直接印「(217)1.你名似膏香：…」），注释里的汉字与
  // 数字同高，被 classify 收成了核，零星的「1.」「2」过得了休止占比的门。汉字核近正方（18×18），数字瘦（11×18）。
  // 只看最后一条像样谱行（≥3 根小节线、七成核不方）以下——粗体数字也近方，谱区里不能这么判；整页找不出像样谱行
  //（我今来就你，数字粗方）就不判。
  const hanCore = (k: DigitCore) => k.bbox.w >= k.bbox.h * 0.9 && k.bbox.h >= musicRowH * 0.85;
  const lastMusicBot = Math.max(-Infinity, ...rowMetaAll
    .filter((m) => m.rd.length >= 3 && m.barlineXs.length >= 3 && m.rd.filter((k) => !squareCore(k)).length >= m.rd.length * 0.7)
    .map((m) => m.botY));
  const rowMeta = rowMetaAll.filter((m) => {
    if (m.topY > noteRuleY) { probe("pseudoRow.belowNoteRule"); return false; }
    if (Number.isFinite(lastMusicBot) && m.topY > lastMusicBot && m.rd.length >= 6 && m.rd.filter(hanCore).length * 2 >= m.rd.length) { probe("pseudoRow.proseTail"); return false; }
    if (m.rd.length < 3) return false;
    if (m.rd.filter(flatCore).length * 2 > m.rd.length) { probe("pseudoRow.flat"); return false; }
    if (keyLineRow(m.rd)) { probe("pseudoRow.keyLine"); return false; }
    if (m.botY < firstMusicTop && m.botY <= keyLineBot) { probe("pseudoRow.aboveKeyLine"); return false; }
    // 第一谱行以上、自己又不像谱行的（小节线 ≤1 根，或是小字）都是页眉：1218 页眉的「E调4/4」小字、大号曲号
    // 连标题凑成的行读成 `0 4 4 |`、`1 1 1 | 1 1`（1176、540、842），页眉 ROI 随之被截掉
    // （不按「核近方」判：小图粗体的数字核也近方，1940 第一谱行被当页眉删过）
    // 「小字」跟**谱行**（≥2 根小节线）的中位高比，不跟全页各行比——歌词行比数字高，把全页中位抬上去，1218 1168 的真谱行
    // （数字 30px，全页中位 42）被当小字删光过
    // 小节线 ≤1 根还不够：散板谱（新编赞美诗 164「节奏自由」）真第一谱行也只有一根线。要再满足核少（<6）或核高与谱行差出 25%
    // （页眉小字「E调4/4」、大号曲号连标题）。
    const hRow = median(m.rd.map((k) => k.bbox.h));
    const offSize = hRow < musicRowH * 0.8 || hRow > musicRowH * 1.25;
    if (Number.isFinite(firstMusicTop) && m.botY < firstMusicTop &&
      ((m.barlineXs.length <= 1 && (m.rd.length < 6 || offSize)) || hRow < musicRowH * 0.8)) { probe("pseudoRow.headerAboveFirst"); return false; }
    // **大字行**：核的中位高超过 1.4 字号——音符数字都在一个字号上下，大一号的是标题/曲号那一排
    //（补充本 71：「受难」小字 + 大号曲号「71」（59×46、60×26，字号 36）凑成一行，读成 `1 | 7 1`）。
    // 还要比**全页各行**的中位高高出 1.4 倍：numH 估小了的页（补充本 155，数字核连着八度点）正经谱行也过得了
    // 前一道门，只按字号判整页谱行全丢。
    const rowH = median(m.rd.map((k) => k.bbox.h));
    // 有三根以上小节线、核又多（≥6）的不是标题：新编赞美诗·四声部的短歌（f1、f33 等）旋律行印大号字（核高 36）、其余三声部小号（25），
    // 页字号按多数估成 25，旋律行正好是 1.44 倍，整行被当标题丢掉——每个系统少一个声部。标题那一排凑不出三根贯穿的小节线。
    if (rowH >= numH * 1.4 && rowH >= pageRowH * 1.4 && !(m.barlineXs.length >= 3 && m.rd.length >= 6)) { probe("pseudoRow.tall"); return false; }
    // 行内拍号「3/4」连着下一行的 ♯ 凑成四个核、底边还压进下面谱行半个字高（选本 586），也算：核 ≤4、重叠放到一个字号内
    if (m.rd.length <= 4 && rowMetaAll.some((o) => o !== m && o.rd.length >= m.rd.length * 2 && o.topY > m.topY &&
      o.topY - m.botY > -numH && o.topY - m.botY < numH * 1.2)) {
      probe("pseudoRow.deco"); return false;
    }
    return true;
  });
  // 系统通长线不算：它比普通小节线长好几倍，算进来就把中位数抬上去，只有短线的行过不了下面 withBars 的门（343）
  const medBarH = median(rowMeta.flatMap((m) => m.bars.filter((b) => !m.long.has(b)).map((b) => b.bbox.h)));
  if (medBarH > 0) {
    // 「之下」要跟**正经谱行**比，不能跟 rowMeta 里的歌词行/页脚比（歌词行也有三个以上的核，
    // 页脚更在末行下方一大截，拿它当界，末行永远进不来）。
    // 线也要够高（同下面 withBars 的 0.85 倍中位线高）：新编赞美诗整本曲末都有一行「阿们」`1--- | 1---‖`，底下的歌词「(阿 们)」
    // 凑出 5 个核、括号竖笔（46px，中位线高 63）又算一根线，它成了「末谱行」，阿们那行反倒在它之上、救不回来
    const staffY = rowMeta.filter((m) => m.bars.some((b) => b.bbox.h >= medBarH * 0.85)).map((m) => m.botY);
    const lastY = staffY.length ? Math.max(...staffY) : Infinity;
    const tail = rowMetaAll
      .filter((m) => m.rd.length && m.rd.length < 3 && m.topY > lastY && m.topY < noteRuleY)
      .filter((m) => m.bars.filter((b) => b.bbox.h >= medBarH * 0.6).length >= 2);
    for (const t of tail) t.tail = true;
    rowMeta.push(...tail);
  }

  // 关键启发式：乐谱行有小节线穿过，歌词/标题行没有。先筛出乐谱行，
  // **只对乐谱行做 OCR**——避免把歌词汉字也送去识别（拖慢且污染结果）；整曲无小节线则回退全部。
  // 光有「一条贯穿本行的高竖线」还不够：页眉里的经文出处「（徒20：35）」那对括号、速度记号旁的
  // 竖笔，都能凑出一条，1123《施比受更为有福》的「♩=103 （徒20：35）」就整行被当成谱行读成
  // `1--0#3|20..350`（连带把第一谱行顶到页眉 ROI 之外，速度记号跟着丢）。真小节线在**全谱**是
  // 同一高度：14 首实测各行都在中位高的 0.96~1.04，伪线一概 ≤0.82（本首括号 0.73、和弦行竖笔
  // 0.45~0.55）。故按全谱中位高设 0.85 的门——中位数按**每条线一票**算，真谱行每行贡献三五条、
  // 伪行只有一两条，中位数稳落在真线上，不受伪行多寡影响。末行救回来的那些（终止线本就矮一截，
  // 判据见上）豁免。
  // 一行里有三根以上够 1.3 字号高、又细（≤0.25 字号宽）的线也算（新编 370 末排歌词凑出三根竖笔 1.4 字号高、却宽 0.37 字号）：四声部 343 首声部是单声部短线（66px），全页中位却被下面两声部共用的长线
  // 抬到 112，按 0.85 倍整行丢。伪线（页眉括号、和弦竖笔）一行只凑得出一两根
  const withBars = rowMeta.filter((m) => m.barlineXs.length > 0
    && (m.tail || !(medBarH > 0) || m.bars.some((b) => b.bbox.h >= medBarH * 0.85) ||
      m.bars.filter((b) => b.bbox.h >= numH * 1.3 && b.bbox.w <= numH * 0.25).length >= 3));
  const staff = withBars.length ? withBars : rowMeta;

  // 多声部（四声部诗歌本）：一个系统上下叠着几条谱行，左侧一道连谱号 `[` 把它们括成一组，
  // 歌词夹在第 2、3 声部之间。认法：各行首音左边的**高窄竖块**（新编赞美诗·四声部《圣哉三一歌》实测
  // 每个系统断成两三段、宽 5~43px、高 390~439px，numH 36；首音 x≈176~188、连谱号右缘 ≤164），
  // 纵向相交的并成一道；与它的纵向范围（两端各放 0.5 字号）重叠够 0.3 行高的谱行就是一个系统，自上而下编
  // 声部号。不按行中心判：连谱号下钩常只画到末行半腰（78《马槽歌》第 2 系统末行中心低出下钩 18px，字号 30）。连谱号的上下钩与首行首音挨着，常被收成一个数字核
  //（第 3、4 系统首音前多读出一个 `1`），右缘以左的核一并摘掉。
  // 分组是否齐整（各系统行数相同、≥2 个系统）要等伪行剔完再验，见下面 `rows` 之后。
  const sysOf = new Map<object, { sys: number; voice: number }>();
  const braceRects: Rect[] = [];
  if (staff.length >= 4) {
    const firstX = median(staff.map((m) => Math.min(...m.rd.map((k) => k.bbox.x))));
    const bars = raw.filter((k) => k.bbox.h >= numH * 4 && k.bbox.w <= numH * 2 && rright(k.bbox) < firstX)
      .map((k) => ({ y0: k.bbox.y, y1: rbottom(k.bbox), x0: k.bbox.x, x1: rright(k.bbox) }))
      .sort((a, b) => a.y0 - b.y0);
    const braces: { y0: number; y1: number; x0: number; x1: number }[] = [];
    for (const b of bars) {
      const last = braces[braces.length - 1];
      if (last && b.y0 <= last.y1) {
        last.y1 = Math.max(last.y1, b.y1); last.x0 = Math.min(last.x0, b.x0); last.x1 = Math.max(last.x1, b.x1);
      } else braces.push({ ...b });
    }
    braceRects.push(...braces.map((br) => ({ x: br.x0, y: br.y0, w: br.x1 - br.x0, h: br.y1 - br.y0 })));
    const inBrace = (m: (typeof rowMetaAll)[number], br: (typeof braces)[number]) =>
      Math.min(m.botY, br.y1 + numH * 0.5) - Math.max(m.topY, br.y0 - numH * 0.5) >= (m.botY - m.topY) * 0.3;
    // **静默声部行**：系统里某声部整段不唱，只印一个行首 `0` 和几根小节线（新编赞美诗·四声部 12 第 3 系统 B 声部），
    // 核不到 3 个被上面当噪声剔了，这个系统少一行、整页声部分组验收不过退回单声部。比别的系统少行时，
    // 连谱号范围内的 1~2 核短行救回来：首核在声部行首音那一列（一字号内）、至少两根小节线与同系统谱行的线对齐。
    {
      const counts = braces.map((br) => staff.filter((m) => inBrace(m, br)).length);
      const full = Math.max(0, ...counts);
      if (full >= 3 && counts.filter((n) => n === full).length >= 2) {
        braces.forEach((br, i) => {
          if (counts[i] >= full) return;
          const mates = staff.filter((m) => inBrace(m, br));
          for (const m of rowMetaAll) {
            if (staff.includes(m) || !m.rd.length || m.rd.length >= 3 || !inBrace(m, br)) continue;
            if (Math.abs(Math.min(...m.rd.map((k) => k.bbox.x)) - firstX) > numH) continue;
            if (mates.some((o) => Math.min(o.botY, m.botY) > Math.max(o.topY, m.topY))) continue;
            const aligned = m.bars.filter((b) => mates.some((o) => o.barlineXs.some((x) => Math.abs(x - rcx(b.bbox)) <= numH * 0.3)));
            if (aligned.length < 2) continue;
            probe("voices.silentRow");
            staff.push(m);
          }
        });
        staff.sort((a, b) => a.topY - b.topY);
      }
    }
    braces.forEach((br, sys) => {
      const inside = staff.filter((m) => inBrace(m, br));
      if (inside.length < 2) return;
      inside.forEach((m, voice) => {
        sysOf.set(m, { sys, voice });
        const hook = m.rd.filter((k) => rright(k.bbox) <= br.x1 + numH * 0.3);
        if (hook.length && hook.length < m.rd.length) {
          probe("brace.hook");
          m.rd = m.rd.filter((k) => !hook.includes(k));
          m.topY = Math.min(...m.rd.map((k) => k.bbox.y));
          m.botY = Math.max(...m.rd.map((k) => rbottom(k.bbox)));
        }
      });
    });
  }

  // 同一系统上下相邻两个声部行**共用**贯穿两行的小节线：线的一端常只画到另一行的半腰（78《马槽歌》第 3 系统
  // 行首那根 y1703–1815，Q4 数字 1789–1829），按「覆盖本行七成」那一行就少一根线、少一个小节，按小节序号对行
  // 时整行错位。一根线伸进相邻声部行的数字带过半，也算那一行的。
  if (sysOf.size) {
    for (const m of staff) {
      const sv = sysOf.get(m);
      if (!sv) continue;
      const n = staff.find((o) => sysOf.get(o)?.sys === sv.sys && sysOf.get(o)!.voice === sv.voice + 1);
      if (!n) continue;
      const share = (from: typeof m, to: typeof m, down: boolean) => {
        const h = to.botY - to.topY;
        for (const bar of from.bars) {
          const x = rcx(bar.bbox);
          // 「已有这根」按 0.15 字号判：终止线的细粗两根只隔 8px（同首末系统 1532/1540，字号 30）
          if (to.barlineXs.some((t) => Math.abs(t - x) <= numH * 0.15)) continue;
          const reach = down ? rbottom(bar.bbox) - to.topY : to.botY - bar.bbox.y;
          // 线在两声部之间断成两截时，这一行里正对着的那截短竖线（被行内「不到最高线六成」滤掉了，
          // 末系统 Q2 那截 5×43）也算（同首）。
          const piece = reach < h * 0.4 ? c.barlines.find((k) => Math.abs(rcx(k.bbox) - x) <= numH * 0.3 &&
            Math.min(rbottom(k.bbox), to.botY) - Math.max(k.bbox.y, to.topY) >= h * 0.6) : bar;
          if (!piece || to.bars.includes(piece)) continue;
          probe("barline.sharedVoice");
          to.bars.push(piece);
          to.barlineXs.push(rcx(piece.bbox));
        }
        to.bars.sort((a, b) => rcx(a.bbox) - rcx(b.bbox));
        to.barlineXs.sort((a, b) => a - b);
      };
      share(m, n, true);
      share(n, m, false);
    }
  }

  // 互证用的「同一系统的声部行」：连谱号有时把几个系统括成一组（36：全页 8 行同一个 sys），各系统的小节线、延长记号位置又常常雷同，
  // 混在一起投票就串了系统。四声部谱每个系统四行：组里行数是 4 的倍数时按纵向次序每四行一组；恰好三行的（三声部）原样；别的不互证。
  const voiceSystems = (): (typeof staff)[number][][] => {
    const bySys = new Map<number, (typeof staff)[number][]>();
    for (const m of staff) { const si = sysOf.get(m)?.sys; if (si !== undefined) (bySys.get(si) ?? bySys.set(si, []).get(si)!).push(m); }
    const out: (typeof staff)[number][][] = [];
    for (const rows of bySys.values()) {
      rows.sort((p, q) => p.topY - q.topY);
      if (rows.length === 3) out.push(rows);
      else if (rows.length % 4 === 0) for (let i = 0; i < rows.length; i += 4) out.push(rows.slice(i, i + 4));
    }
    return out;
  };
  // 小节线多声部互证（同延长记号那条的思路）：小节线管的是一个时间点，同一系统各声部的小节线横向位置相同。
  // 别的声部里有两行以上在这个位置有线、本行这里又没有数字挡着（线不会从数字身上穿过），本行缺的这根补上。
  // 缺线多是那一截印淡了、被弧或增时线粘走、或没过行内相对高度门（全本漏小节线二百来处，多数只缺在一个声部）。
  if (sysOf.size) {
    for (const rows of voiceSystems()) {
      const add = new Map<(typeof staff)[number], number[]>();
      for (const m of rows) {
        const x0 = Math.min(...m.rd.map((k) => k.bbox.x)), x1 = Math.max(...m.rd.map((k) => rright(k.bbox)));
        // 本行自己得先像个声部行：已有的线不少于别的行中位根数的一半（至少两根）。连谱号里夹着的歌词行只凑得出一根伪线，
        // 给它补齐了线它就成了「声部」（43：歌词行补上两根，整首多出一行、全部错位）。
        const others = median(rows.filter((q) => q !== m).map((q) => q.barlineXs.length));
        if (m.barlineXs.length < 2 || m.barlineXs.length < others * 0.5) continue;
        const seen: number[] = [];
        for (const o of rows) if (o !== m) for (const x of o.barlineXs) {
          if (seen.some((t) => Math.abs(t - x) <= numH * 0.4)) continue;
          seen.push(x);
          // 只补行内的（首尾两个数字之间）：行首的系统起始线、行末线另有各自的规矩（43 补了行首那道，整首错位）
          if (x <= x0 || x >= x1) continue;
          if (m.barlineXs.some((t) => Math.abs(t - x) <= numH * 0.4)) continue;
          const votes = rows.filter((q) => q !== m && q.barlineXs.some((t) => Math.abs(t - x) <= numH * 0.4)).length;
          if (votes < 2) continue;
          if (m.rd.some((k) => k.bbox.x - numH * 0.1 < x && rright(k.bbox) + numH * 0.1 > x)) continue;
          (add.get(m) ?? add.set(m, []).get(m)!).push(x);
        }
      }
      for (const [m, xs] of add) {
        for (const x of xs) { probe("barline.mutual"); m.barlineXs.push(x); }
        m.barlineXs.sort((p, q) => p - q);
      }
    }
  }

  // 临时升降号：印在音符左侧、紧贴着，比数字矮一截也窄一截（实测 ♯ 是 10×17，同行数字 15×24）。
  // 摘出音符流，记在右邻那个音符上（下游 applyJpPitch 会按简谱规矩在小节内延续）。
  const accidentals = new Map<DigitCore, "sharp" | "flat" | "natural">();
  const accCores = new Set<DigitCore>();
  for (const m of staff) {
    // 尺子用本行数字的**中位高/宽**，不能用整条带高：记号本身骑在数字上方，带高被它撑大
    // （17 第 3 行带高 37、数字才 24），拿带高作比例，右邻的正常数字反倒不达标。
    const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
    // 宽度尺子不算「1」（窄竖笔，<0.45 字号）：满是 1 的行中位宽就只剩一根竖笔宽，小号 ♭ 也显得「不比数字窄」
    //（新编赞美诗·四声部《圣哉三一歌》末系统 Q2 `1 - 1 1 | 1 - 1⌒ᵇ7`，中位 14px = ♭ 的宽）。
    const wideW = m.rd.map((k) => k.bbox.w).filter((w) => w >= numH * 0.45);
    const medW = median(wideW.length ? wideW : m.rd.map((k) => k.bbox.w)) || numH;
    for (let j = 0; j + 1 < m.rd.length; j++) {
      const k = m.rd[j], nx = m.rd[j + 1];
      // 与数字一般大 → 就是数字。**高度只挡明显更高的**：记号与数字孰高孰低随书而异——
      // 17《不失足》的 ♯ 是 10×17、数字 15×24（矮一截），2152《就是不一样》第 5 行的 ♯ 却是
      // 14×38、本行数字中位 12×32（反倒高出一截）；按 0.85 字高一卡，后者整个被挡在外面，
      // 那个 ♯ 就当成音符送去 OCR、读成了休止 0。真正稳的判据是**宽度**（14 vs 22，记号一律
      // 比数字窄）加上后面 accidentalOf 的形状判据。
      // ♯ 的宽度随书而异：新编赞美诗·四声部的 ♯ 印得和数字一般宽（《圣哉三一歌》实测 26×24，本行数字中位
      // 26×37），宽度门挡不住它。放宽只给**连谱号括着的声部行**里、**矮、悬在右邻数字上半截**（底比数字底
      // 高 ≥0.2 字高）且形状判据认定是 ♯ 的：光凭形状，密排行里正常高度的数字也会被认成 ♯（92、1727 等
      // 八首各丢几个音），谱后正文里汉字的碎块也有矮而悬高、形似 ♯ 的（1811《心愿》）。
      if (k.bbox.h > medH * 1.25) continue;
      // 「矮」不能只看块高：同书的 ♯ 也有印得和数字差不多高的（97《受难歌》28×32、26×30 对数字 37；101《我有主耶稣歌》`6 ♯5`
      // 的 ♯ 19×21 ~ 18×26 对数字 17×25），高度门一卡就当音符送去 OCR、读成休止 0。门放到 0.9 字高；再高的要整个悬高——
      // **顶比右邻数字高出 0.25、底高出 0.3 字高以上**（101 是 0.28~0.44；同行的数字顶是齐的，歪页上相邻两个数字也会差出 0.2：319 末行 `5 5`）。
      // 声部页上没归进系统的声部行（18《快乐崇拜歌》末系统第 4 声部）也认，见下。
      const hungLow = rbottom(nx.bbox) - rbottom(k.bbox) >= medH * 0.2;
      const raised = k.bbox.h < medH * 0.9 || (k.bbox.h <= medH * 1.1 && nx.bbox.y - k.bbox.y >= medH * 0.25 && rbottom(nx.bbox) - rbottom(k.bbox) >= medH * 0.3);
      // 没归进系统的行只收明显矮的（<0.8 字高）。另两样形似 ♯ 的要挡：弧连着三连音的「3」（269，一块百来像素宽）——宽不过 1.5 倍数字宽（140 的 ♯ 34×27 对数字宽 25）；
      // 倚音的小号数字（319 末行 `⁵⁵5`，矮、悬高）——它脚下压着减时线，♯ 脚下是空的。
      const underlined = (b: Rect): boolean => {
        // 从块底两行起扫：减时线常和倚音粘成一块（319：30×29），线就是块的最底几行；♯ 的底是两根竖笔的脚（下横笔在其上，137）
        // 只看到块底下 0.15 字高：再往下是右邻音符自己的减时线，常伸到 ♯ 底下（140 `♯4̲`）
        for (let y = rbottom(b) - 2; y <= rbottom(b) + medH * 0.15; y++) {
          let n = 0;
          for (let x = b.x; x < rright(b); x++) if (bin.data[Math.round(y) * bin.w + Math.round(x)]) n++;
          if (n >= b.w * 0.9) return true;
        }
        return false;
      };
      const wideSharp = (sysOf.has(m) ? raised : voicedPage && k.bbox.h < medH * 0.8) && hungLow && k.bbox.w <= medW * 1.5 &&
        accidentalOf(bin, k.bbox) === "sharp" && !underlined(k.bbox);
      if (k.bbox.w > medW * 0.85 && !wideSharp) continue;
      if (k.bbox.h < medH * 0.45 || k.bbox.w < medW * 0.3) continue;         // 太小 → 点/碎片
      // 没紧贴右边那个数字。上面按形状认定的宽 ♯ 间隙放到 0.5 字号：101 第 1 系统 `6 ♯5` 的 ♯ 离数字 10px（字号 25）、67 是 13px（字号 35）
      if (nx.bbox.x - rright(k.bbox) > numH * (wideSharp ? 0.5 : 0.3)) continue;
      if (nx.bbox.h < medH * 0.85) continue;                                 // 右邻得是个正常数字
      // 记号印在音符的**左上角**：顶比数字高、底也不该垂到数字底下（17 实测记号顶比数字高 10px）。
      if (k.bbox.y > nx.bbox.y + medH * 0.15 || rbottom(k.bbox) > rbottom(nx.bbox) + medH * 0.1) continue;
      const kind = accidentalOf(bin, k.bbox);
      if (!kind) continue;
      // 还原号要**悬高**：底比右邻数字底高出 0.1 字高以上（四声部实测 0.14~0.62）。粗体窄字本（赞美诗歌1218）的「1」紧贴下一个数字、
      // 同顶同底（底差 0.00~0.03），形状判据当成 ♮，`1_ 2_` 读成 `♮2_`——全本真还原号为 0，识别出 151 个
      if (kind === "natural" && rbottom(nx.bbox) - rbottom(k.bbox) < medH * 0.1) { probe("accidental.naturalFlush"); continue; }
      probe("accidental");
      accidentals.set(nx, kind);
      accCores.add(k);
    }
    if (accCores.size) m.rd = m.rd.filter((k) => !accCores.has(k));
  }

  // 倚音：小号数字印在主音符的左上方，**底下压着一两条与它同宽的减时线**，再由一小段弧连到
  // 主音符（2156《祢为我解读一生的道路》第 7 行的 `4 ³5`）。那个小数字比数字带矮一截、中心又高
  // 出大半个字（实测 cy 差 42px > groupRows 的 0.7 字号），挂不上任何谱行，自成一「行」后被
  // 「行里得有三个数字」滤掉——整个倚音连同减时线一起没了。
  // 判据里**减时线不可省**：三连音的那个小 `3` 也印在音符上方，它下面是括线不是减时线；
  // 变音记号同样矮一截，但与主音符齐顶齐底、下面也没有横线（且早一步被上面那段摘走了）。
  const graceOf = new Map<DigitCore, { digit: number; octave: number; div: number; bbox: Rect }[]>();
  {
    const cands: { box: Rect; owner: DigitCore; div: number; octave: number; dot?: Component }[] = [];
    // 已经进了某条带的块一概不考虑：倚音之所以要单独救，正是因为它的中心比数字带高出大半个
    // 字、**挂不上任何带**。反过来，落在带里的就是那条带的正经音符——谱面上和弦字母行、歌词行
    // 也会各自成带（要等 OCR 完才按休止占比剔掉），不设这道门，上一带行末那个带减时线的音符
    // 就会被下一带认领成倚音（实测为基督/因有主同在/主祢真伟大各因此吃掉一个真音符）。
    const rowBoxes = staff.flatMap((m) => m.rd.map((k) => k.bbox));
    const inRow = (b: Rect) => rowBoxes.some((r) =>
      b.x < rright(r) && rright(b) > r.x && b.y < rbottom(r) && rbottom(b) > r.y);
    // **候选从 comps 里取，不能只看 allCores**：倚音的 `1` 只有一条细竖笔（2152 末行实测宽 8），
    // 够不着 classify 里数字块「宽 ≥0.3 字号」的门槛，压根没进数字通道，allCores 里找不到它。
    for (const m of staff) {
      const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
      const medW = median(m.rd.map((k) => k.bbox.w)) || numH;
      for (const kc of comps) {
        const kb = kc.bbox;
        if (inRow(kb)) continue;
        if (kb.h < medH * 0.45 || kb.h > medH * 0.8) continue;   // 小号数字：比正经数字矮一号
        if (kb.w > medW * 0.9) continue;                         // 也比它窄（圆滑线弧帽宽得多）
        // 位置：底边**贴着数字带的顶**（倚音只是印得高一点，并没有离开这一行）。上下都要卡死：
        // 只卡上界的话，**上一谱行**行末那个带减时线的音符正好落进窗口——它比本行数字略矮、
        // 底下又真有一条减时线，判据条条都对。实测真倚音的底边就压在带顶上（2156 是带顶 +1px），
        // 那些误判则在带顶上方一整个字高开外。
        if (rbottom(kb) > m.topY + medH * 0.25) continue;
        if (rbottom(kb) < m.topY - medH * 0.5) continue;
        const div = graceDivLines(bin, kb, medH);
        if (!div) continue;                                      // 底下没有减时线 → 不是倚音
        // 右边紧跟着的那个正常数字就是它修饰的主音符
        const owner = m.rd.find((n) => n.bbox.h >= medH * 0.85 &&
          n.bbox.x >= rright(kb) - 2 && n.bbox.x - rright(kb) < medH * 0.9);
        if (!owner) continue;
        // 八度点**只认上面那个**：连到主音符的那道小弧就挂在减时线下方，断成的碎块
        // （2156 实测 15×11）与八度点（13×14）一般大、也几乎正对着小数字（中心只偏 6px），
        // 形状与位置都分不开——认下面那个点，等于给每个倚音都平白记上一个低八度。
        // 高八度点没有这个麻烦：小数字上方空无一物。低八度的倚音因此少一个点（有损）。
        const dot = c.dots.find((o) => Math.abs(rcx(o.bbox) - rcx(kb)) <= Math.max(kb.w * 0.5, numH * 0.2) &&
          o.bbox.w <= Math.max(kb.w * 0.8, numH * 0.3) &&
          kb.y - rbottom(o.bbox) >= -2 && kb.y - rbottom(o.bbox) < medH * 0.5);
        cands.push({ box: kb, owner, div, octave: dot ? 1 : 0, dot });
      }
    }
    if (cands.length) {
      const vals = await ocr.recognizeDigits(bin, cands.map((g) => g.box));
      const taken: Rect[] = [];
      const usedDots = new Set<Component>();
      cands.forEach((g, i) => {
        const digit = vals[i] ?? 0;
        if (digit < 1 || digit > 7) return;            // 读不出合法音就当误判，原样留给别的判据
        const list = graceOf.get(g.owner) ?? [];
        list.push({ digit, octave: g.octave, div: g.div, bbox: g.box });
        probe("grace");
        graceOf.set(g.owner, list);
        taken.push(g.box);
        if (g.dot) usedDots.add(g.dot);
      });
      if (taken.length) {
        // 倚音自己那几块要从音符流里摘干净：小数字、它底下的减时线（留着会被主音符当成自己的）、
        // 八度点。减时线按几何剔——它们多半根本没进 hlines 那个池子（太窄），进了的按位置认。
        const mine = (b: Rect) => taken.some((t) =>
          Math.abs(rcx(b) - rcx(t)) <= t.w && b.y >= rbottom(t) - 2 && b.y - rbottom(t) < numH * 0.6);
        allCores = allCores.filter((k) => !taken.some((t) => t.x === k.bbox.x && t.y === k.bbox.y));
        c.hlines = c.hlines.filter((h) => !mine(h.bbox));
        c.dots = c.dots.filter((o) => !usedDots.has(o));
      }
    }
  }

  const allDigits = staff.flatMap((m) => m.rd);
  // rec 输入裁剪：连通域偶尔只截到半个字（淡印/断笔的 "1" 竖笔断开，块高≈半个字高 → 送 rec 成半字被
  // 误读，如"1"读成"4"）。据本行数字带统计高度把过矮的块纵向补到整字高（cellOf 按 rect 从二值图裁，
  // 会把带内断开的另一半笔画一并纳入）。带由数字核算出、不含下划线/八度点 → 补高安全。
  // 仅补高、不动 x/w，且只作用于 rec 裁剪；几何(八度/附点/div/缓存键)仍用原 bbox。
  // 声部行的带按各核上下沿的**中位数**量：个别高块（粘着点、弧的数字）会把 [topY, botY] 撑大，按它补高，正常高度的数字
  // 也被补到带底、裁进下面的减时线和低音点（新编赞美诗·四声部 78《马槽歌》Q2 `7̲̣`：带被撑到 57px，34px 的 7 补高后读成 1）。
  // 只在连谱号括着的行上这么量：单声部谱的伪行剔除靠 OCR 把标题/正文汉字读成 0，裁剪一变 2152 的标题带就混成了谱行。
  const recRects = staff.flatMap((m) => {
    const voiced = sysOf.has(m);
    const top = voiced ? median(m.rd.map((k) => k.bbox.y)) : m.topY;
    const bot = voiced ? median(m.rd.map((k) => rbottom(k.bbox))) : m.botY;
    const bandH = bot - top;
    // 斜着的谱行（整行上下沿比数字高出 1.3 倍以上）：按整行的带补高会把数字下面的减时线、低八度点一起裁进去——
    // 赞美诗歌1218 25 首行斜 14px，6 补到 57px 高、连着线和点读成 5（全本 `6_→5_` 三百多处）。改按左右各 3 个邻近数字的
    // 上下沿中位数就地补高。
    const medH = median(m.rd.map((k) => k.bbox.h));
    const slanted = !voiced && bandH > medH * 1.3;
    const xs = slanted ? [...m.rd].sort((a, b) => a.bbox.x - b.bbox.x) : [];
    return m.rd.map((k) => {
      let t = top, b2 = bot;
      if (slanted) {
        const i = xs.indexOf(k);
        const nb = xs.slice(Math.max(0, i - 3), i + 4);
        t = median(nb.map((o) => o.bbox.y)); b2 = median(nb.map((o) => rbottom(o.bbox)));
      }
      if (k.bbox.h >= (b2 - t) * 0.7) return k.bbox;
      const y = Math.min(k.bbox.y, t);
      return { x: k.bbox.x, y, w: k.bbox.w, h: Math.max(rbottom(k.bbox), b2) - y };
    });
  });
  const recog = await ocr.recognizeDigits(bin, recRects, { rhythm: true });
  const digitCache = new Map<Rect, number>();
  allDigits.forEach((k, i) => digitCache.set(k.bbox, recog[i] ?? 0));
  // 读成 1 的宽块多半是 7：粗体窄字（赞美诗歌1218 通本）的 7 顶横短、带上减时线，数字模型读成 1——全本 `7_→1_` 三百多处。
  // 真「1」是一根竖笔（该页 17px 宽），这些 7 与别的数字一样宽（24~27px）。门：宽过本页真 1 中位宽的 1.35 倍，
  // 且顶部两成高度里有一道横贯七成宽度的横笔（7 的顶横；1 顶上只有一小撇）。
  {
    const ones = allDigits.filter((k) => digitCache.get(k.bbox) === 1).map((k) => k.bbox.w).sort((a, b) => a - b);
    const oneW = ones.length >= 3 ? ones[Math.floor(ones.length * 0.3)]! : 0;   // 取偏窄的分位，免得被误读的 7 抬高
    const topBar = (b: Rect): boolean => {
      const y1 = b.y + Math.max(2, Math.round(b.h * 0.2));
      for (let y = b.y; y < y1; y++) {
        let run = 0, best = 0;
        for (let x = b.x; x < b.x + b.w; x++) { if (bin.data[y * bin.w + x]) { run++; if (run > best) best = run; } else run = 0; }
        if (best >= b.w * 0.7) return true;
      }
      return false;
    };
    if (oneW > 0) for (const k of allDigits) {
      if (digitCache.get(k.bbox) === 1 && k.bbox.w >= oneW * 1.35 && topBar(k.bbox)) { probe("digit.wideOneIsSeven"); digitCache.set(k.bbox, 7); }
    }
  }
  // 读成 0 的矮块得有**封闭的洞**：赞美诗歌1218 通本倚音与主音之间那道侧放的小连线（ᶜ 形，125、631 实测 23×19 / 22×19，
  // 数字 34）读成休止 0，凭空多一个音。只查比本行数字矮一截（<0.75）的：正常大小的 0 不动（粗黑页上 0 的洞可能糊死）
  {
    const hasHole = (b: Rect): boolean => {
      const W = b.w + 2, H = b.h + 2;
      const seen = new Uint8Array(W * H);
      const ink = (x: number, y: number) => x >= 1 && y >= 1 && x <= b.w && y <= b.h && bin.data[(b.y + y - 1) * bin.w + b.x + x - 1] === 1;
      const stack = [0];
      seen[0] = 1;
      while (stack.length) {
        const p = stack.pop()!, x = p % W, y = (p - x) / W;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (seen[q] || ink(nx, ny)) continue;
          seen[q] = 1; stack.push(q);
        }
      }
      let holes = 0;
      for (let y = 1; y <= b.h; y++) for (let x = 1; x <= b.w; x++) if (!seen[y * W + x] && !ink(x, y)) holes++;
      return holes >= 2;
    };
    // 0 占三成以上的行不动：多半是歌词/页眉凑成的伪行，要留给后面「休止占比」那道门整行剔掉（先剔了 0 占比就降下来，伪行反倒活了，1218 347）
    for (const m of staff) {
      const medH = median(m.rd.map((k) => k.bbox.h));
      if (m.rd.filter((k) => digitCache.get(k.bbox) === 0).length >= m.rd.length * 0.3) continue;
      const drop = m.rd.filter((k) => digitCache.get(k.bbox) === 0 && k.bbox.h < medH * 0.75 && !hasHole(k.bbox));
      if (drop.length) { probe("rest.openArc"); m.rd = m.rd.filter((k) => !drop.includes(k)); }
    }
  }
  const ocrDigit = (b: Rect) => digitCache.get(b) ?? 0;

  // 圆滑线弧帽候选（宽而薄的连通块）：用于在 buildJpNums 里把弧脚碎片从"高八度点"中剔除。
  const arcCands = [...comps, ...arcComps].filter((k) => {
    const b = k.bbox;
    return b.w >= numH * 0.8 && b.h >= 2 && b.h <= numH * 0.8 && b.w / b.h >= 2;
  });

  // 与装饰记号粘连的八度点：把没进任何谱行的块底部的圆点切回 dots（见 splitOrnamentDot）。
  const inStaff = new Set(staff.flatMap((m) => m.rd));
  for (const k of allCores) {
    if (inStaff.has(k)) continue;
    const dotComp = splitOrnamentDot(bin, k.bbox, numH);
    if (dotComp) c.dots.push(dotComp);
  }

  const dotSizes: number[] = []; // 累积所有被采纳的八度点/附点源图直径 → 取中位数当统计点径
  // 终止线：谱末那道 ‖ 是细线加粗线并排（16《爱心的功课》实测 5px + 8px、相距 5px，
  // 而普通小节线 4px）。两根线都各自进了 barlineXs（中间切出的空小节由 measuresOfRow 滤掉），
  // 这里只认「行末最后两根挨着、其中一根明显更粗」这一形，标在该行上供下游写成 `|||` / light-heavy。
  // 复纵线（细细双线 ‖）：同一形态、只差粗细，故与终止线在同一趟里分流。曲中分段、房尾收口
  // 都写它（76《天上有粮》一房末实测两根各 6px、中心距 9px、字号 44）。两根都各自进了
  // barlineXs，不标出来的话下游只看得见一条普通线（中间切出的空小节由 measuresOfRow 滤掉）。
  {
    const medW = median(staff.flatMap((m) => m.bars.map((b) => b.bbox.w))) || 1;
    for (const m of staff) {
      for (let i = 1; i < m.bars.length; i++) {
        const prev = m.bars[i - 1]!, cur = m.bars[i]!;
        const gap = rcx(cur.bbox) - rcx(prev.bbox);
        // 声部行（连谱号括着）的两根离得开一些（四声部《圣哉三一歌》Q3/Q4 中心距 20~21px，字号 36），
        // 粗细也按两根彼此比：同一道 ‖ 的细粗之比比与全曲中位比稳（《三一来临歌》那道对中位不到 1.5 倍）。
        const braced = sysOf.has(m);
        // 下限按字号放到 0.15（至少 4px）：擦小节线接弧时同一根线会剩两截、中心只差 2px（78《马槽歌》下两声部
        // 行首读成 `||`）；真复纵线两根中心距 9px 起（76《天上有粮》，字号 44 即 0.2）。
        if (gap > numH * (braced ? 0.7 : 0.5) || gap < Math.max(4, numH * 0.15)) continue;   // 不是并排的两根 / 同一根被切成两截
        const thick = Math.max(cur.bbox.w, prev.bbox.w) >= medW * 1.5 ||
          (braced && Math.max(cur.bbox.w, prev.bbox.w) >= Math.min(cur.bbox.w, prev.bbox.w) * 1.3);
        const rowLast = i === m.bars.length - 1;
        // 「更粗的那根」只在**中间的谱行**上要求：那里两根并排的还可能是分段用的复纵线，粗细是
        // 唯一可分的线索。**末行**行末的两根并排不作他想，就是终止线——而且细粗之别常印不出来：
        // 227《施比受更为有福》末行那道 ‖ 实测 5px + 7px、中位 5px，比 1.5 倍差一点点就整个丢了
        // （同一首歌的另一版 1123 是 6px + 10px，同一条判据一个过一个不过，说明门槛卡在噪声上）。
        // 多声部谱的末系统每个声部行都是「末行」（新编赞美诗·四声部实测细粗 5px+9px、4px+8px，中位 6px）。
        const lastSys = sysOf.get(staff[staff.length - 1]!)?.sys;
        const inLastSys = lastSys !== undefined && sysOf.get(m)?.sys === lastSys;
        if (rowLast && (thick || m === staff[staff.length - 1] || inLastSys)) {
          (m as { finalBarline?: "end" }).finalBarline = "end";
          continue;
        }
        // 行中出现细+粗：宁可当普通线，别把终止线形态乱扣到曲中。**连谱号括着的声部行**例外：四声部本子
        // 在「阿们」前印一道终止线（《圣哉三一歌》《三一来临歌》），各声部同一位置都有，不会是乱扣。
        if (thick) {
          if (braced) { probe("barline.midEnd"); ((m as { endBarXs?: number[] }).endBarXs ??= []).push(rcx(cur.bbox)); }
          continue;
        }
        // 两根等粗 → 复纵线。再要求高度相近：被切开的数字竖笔、噪声细纹与真线并排时高度差得远。
        if (Math.abs(cur.bbox.h - prev.bbox.h) > Math.max(cur.bbox.h, prev.bbox.h) * 0.25) continue;
        probe("barline.double");
        // 记**右侧**那根的 x：切小节时跨过的最后一根就是它，下游按右界对齐。
        ((m as { doubleBarXs?: number[] }).doubleBarXs ??= []).push(rcx(cur.bbox));
      }
    }
  }

  // 延长记号（fermata 𝄐）：音符头顶一段小弧、弧下扣一个点。整块只有半个字号宽，够不着
  // detectSlurs 的圆滑线判据（那里要求宽 ≥0.8 字号），弧本身常连归类都轮不上；而弧下那个点
  // 正落在八度点的窗口里，于是 16《爱心的功课》末行的 `5·6̂ 7̂` 读成了 `5. 6̇ 7̇`（高了一个八度）。
  // 判据：宽薄小弧（0.5~1.6 字号宽、扁平）+ 正下方居中的一个小点 + 再下方紧跟着数字。
  // 宽高上限按赞美诗选 21《我歌颂你》放到 1.6 / 0.7：那本的弧大一号（实测 39×17px、字号 28，
  // 即 1.39 / 0.61），点还扣在弧**里面**（点顶高于弧底）。放宽不怕误认：点要居中、正下方还得
  // 紧跟一个正常字号的数字，圆滑线跨两个音，中心下方落不着数字。
  const fermataOf = new Map<DigitCore, boolean>();
  const fermataDots = new Set<Component>();
  // 认出来的弧也记下：它与下一谱行的歌词带同高，不摘掉会被聚成一条伪 verse 行，
  // 连同行里伸上来的小节线头一起送 OCR（《我歌颂你》末行那道高小节线读成了 W2 的「I」）。
  const fermataArcs = new Set<Component>();
  // 得**拱**得起来：上缘两端都比最高点低 ≥0.12 字号（口径同下面 fermata.cap 的 capOk）。
  // 只卡「宽而扁」是不够的：1812《在世不属世》末音 `1̇` 头上那道斜直短笔（22×6，字号 32）
  // 条条都过，把正下方的高八度点（间隙 8px，正卡在 0.25 字号的门上）当成延长记号的点吃掉，
  // `1'` 读成了 `1`。斜笔的上缘一头到一头单调下降，过不了这道；那道笔本身照旧不识别。
  const arched = (b: Rect): boolean => {
    const top: number[] = [];
    for (let x = b.x; x < rright(b); x++) {
      let y = b.y;
      while (y < rbottom(b) && !bin.data[y * bin.w + x]) y++;
      if (y < rbottom(b)) top.push(y);
    }
    if (top.length < 3) return false;
    const peak = Math.min(...top);
    return top[0] - peak >= numH * 0.12 && top[top.length - 1] - peak >= numH * 0.12;
  };
  for (const m of staff) {
    const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
    for (const arc of comps) {
      const ab = arc.bbox;
      // 四声部页放到 2 字号：新编赞美诗·四声部的延长记号弧大一号（10《齐来谢主歌》70×17、字号 38，1.84），四个声部各印一个
      if (ab.w < numH * 0.5 || ab.w > numH * (voicedPage ? 2 : 1.6)) continue;
      // 宽高比门 1.5（原 1.8）：新编赞美诗 250 的弧高一号（39×22、字号 32，1.77），点扣在弧里；点居中、正下方紧跟数字、弧拱得起来这几道门够严
      if (ab.h < numH * 0.15 || ab.h > numH * 0.7 || ab.w / ab.h < 1.5) continue;
      const dotC = c.dots.find((o) => {
        const ob = o.bbox;
        return Math.abs(rcx(ob) - rcx(ab)) <= numH * 0.25 && ob.y >= ab.y &&
          ob.y - rbottom(ab) <= numH * 0.25 && ob.w <= numH * 0.4;
      });
      if (!dotC) continue;
      const owner = m.rd.find((k) => Math.abs(rcx(k.bbox) - rcx(ab)) <= numH * 0.3 &&
        // 窗口同八度点（0.8 字号）：八度那边收得到的点，延长记号得先认（补充本 62 的小号延长记号离数字 0.64 字号，点被当成高音点）
        k.bbox.y - rbottom(dotC.bbox) >= -2 && k.bbox.y - rbottom(dotC.bbox) <= numH * 0.8 &&
        k.bbox.h >= medH * 0.85);
      if (!owner) continue;
      // 延长记号的弧只罩一个音：弧横向盖住另一个数字过半，就是跨两音的圆滑线/连音线（新编赞美诗 384 两个紧挨的八分
      // `2̇⌒3̇`，短弧宽同延长记号），弧下的点还给八度
      if (m.rd.some((k) => k !== owner && overlapX(k.bbox, ab) >= k.bbox.w * 0.5)) { probe("fermata.spansTwo"); continue; }
      if (!arched(ab)) { probe("fermata.archReject"); continue; }
      probe("fermata.arc");
      fermataOf.set(owner, true);
      fermataDots.add(dotC);
      fermataArcs.add(arc);
    }
  }
  // 弧下那个点不是八度点，别让 buildJpNums 收走。
  // 补充一路：弧与别的弧粘成一块时（1697 末音 `6⌒6̂`：延长记号的弧顶接在前面那条圆滑线的尾巴上，
  // 整块 59px，中心偏到了左边），上面「点居中于弧」一条就对不上。改从点出发：
  //  · 数字正上方一个小点（宽高都不过 0.3 字号）；高八度点也长这样，分开它俩靠下一条的弧顶形状——
  //    高八度点头上即便压着圆滑线，那也是长弧，两脚离得远；
  //  · 点正上方 0.35 字号内贴着墨（弧顶）；从弧顶沿着墨往左右走到弧脚，两脚离点心 0.15~0.45 字号、
  //    都比弧顶低 0.12 字号以上——弧是个窄帽子（1697 实测宽 17px、脚低 6~7px，字号 37）。
  //    长圆滑线跨在音符上方时一走就走出半个字号，过不了脚距那一条。
  {
    const topInk = (x: number, y0: number, y1: number): number => {
      const xi = Math.round(x);
      if (xi < 0 || xi >= bin.w) return NaN;
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(bin.h, Math.round(y1)); y++) if (bin.data[y * bin.w + xi]) return y;
      return NaN;
    };
    for (const m of staff) {
      const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
      for (const owner of m.rd) {
        if (fermataOf.get(owner) || owner.bbox.h < medH * 0.85) continue;
        const ob = owner.bbox;
        const dotC = c.dots.find((o) => {
          const b = o.bbox;
          const gap = ob.y - rbottom(b);
          return Math.abs(rcx(b) - rcx(ob)) <= numH * 0.25 && gap >= -1 && gap <= numH * 0.5 &&
            b.w <= numH * 0.3 && b.h <= numH * 0.3;
        });
        if (!dotC) continue;
        const db = dotC.bbox, cx = rcx(db);
        const capTop = topInk(cx, db.y - numH * 0.35, db.y - 1);
        if (isNaN(capTop)) continue;
        // 点头顶那道墨是上一声部的数字底笔或它的减时线，就不是弧顶：四声部上声部 `5̲̣` 的低音点夹在减时线与下声部数字之间，
        // 往上 0.35 字号够到了 5 的底笔，减时线两端成了「弧脚」（f16 首系统，字号 36：点顶 260、5 的底 249、线 254~257），
        // 认成下声部的延长记号，点从八度里摘走
        if (c.hlines.some((h) => cx >= h.bbox.x && cx <= rright(h.bbox) && capTop >= h.bbox.y - 1 && capTop <= rbottom(h.bbox)) ||
          staff.some((o) => o.rd.some((k) => k !== owner && cx >= k.bbox.x && cx <= rright(k.bbox) && capTop >= k.bbox.y && capTop <= rbottom(k.bbox)))) {
          probe("fermata.capIsNote"); continue;
        }
        // 沿弧往两边走到脚：列里（弧顶到点底这一带）有墨、且上缘没有重新抬起就继续，停下的那一列是弧脚。
        // 「重新抬起」要算：1697 的弧脚与前面圆滑线的尾巴连着，不停就一路走进圆滑线里去了。
        const foot = (dir: number): { dx: number; top: number } | null => {
          let low: { dx: number; top: number } | null = null;           // 走过的最低点
          for (let dx = 1; dx <= numH * 0.6; dx++) {
            const t = topInk(cx + dir * dx, capTop, rbottom(db) + 1);
            if (isNaN(t) || (low && t < low.top - 1)) break;           // 没墨了，或上缘又抬起来（接上了别的弧）
            if (!low || t >= low.top) low = { dx, top: t };
          }
          return low;
        };
        const fl = foot(-1), fr = foot(1);
        const capOk = (f: { dx: number; top: number } | null) =>
          !!f && f.dx >= numH * 0.15 && f.dx <= numH * 0.45 && f.top - capTop >= numH * 0.12;
        if (!capOk(fl) || !capOk(fr)) continue;
        const span: Rect = { x: Math.round(cx - fl!.dx), y: capTop, w: fl!.dx + fr!.dx + 1, h: 1 };
        if (m.rd.some((k) => k !== owner && overlapX(k.bbox, span) >= k.bbox.w * 0.5)) { probe("fermata.spansTwo"); continue; }
        probe("fermata.cap");
        fermataOf.set(owner, true);
        fermataDots.add(dotC);
      }
    }
  }
  // 第三路：弧顶被别的弧粘上（新编赞美诗 386：圆滑线尾巴正落在延长记号的弧顶上，连成一块），沿上沿找弧脚会顺着圆滑线爬上去。
  // 改看**点的两侧**：点中线这一行左右 0.2~0.65 字号处各有一条弧腿、两边差不多远（差 ≤0.3 字号），点正上方 0.35 字号内有墨（弧顶）。
  // 高音点头上压着的圆滑线，两脚隔着一两个音距，够不着或一近一远。
  {
    for (const m of staff) {
      const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
      for (const owner of m.rd) {
        if (fermataOf.get(owner) || owner.bbox.h < medH * 0.85) continue;
        const ob = owner.bbox;
        const dotC = c.dots.find((o) => {
          const b = o.bbox;
          const gap = ob.y - rbottom(b);
          return !fermataDots.has(o) && Math.abs(rcx(b) - rcx(ob)) <= numH * 0.25 && gap >= -1 && gap <= numH * 0.5 &&
            b.w <= numH * 0.3 && b.h <= numH * 0.3;
        });
        if (!dotC) continue;
        const db = dotC.bbox, cy = Math.round(rcy(db));
        const at = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
        let cap = false;
        for (let y = db.y - 2; y >= db.y - numH * 0.35 && !cap; y--) if (at(Math.round(rcx(db)), y)) cap = true;
        if (!cap) continue;
        const leg = (dir: number): number => {
          for (let dx = Math.round(db.w / 2) + 2; dx <= numH * 0.65; dx++) if (at(Math.round(rcx(db) + dir * dx), cy)) return dx;
          return Infinity;
        };
        const dl = leg(-1), dr = leg(1);
        // 下限 0.1 字号：四声部下方声部印的是小号延长记号（约 0.4 字号宽，135 Q3 `3̂`），弧腿离点心不到 0.2 字号
        if (dl < numH * 0.1 || dr < numH * 0.1 || !isFinite(dl) || !isFinite(dr) || Math.abs(dl - dr) > numH * 0.3) continue;
        const span: Rect = { x: Math.round(rcx(db) - dl), y: cy, w: dl + dr + 1, h: 1 };
        if (m.rd.some((k) => k !== owner && overlapX(k.bbox, span) >= k.bbox.w * 0.5)) continue;
        probe("fermata.legs");
        fermataOf.set(owner, true);
        fermataDots.add(dotC);
      }
    }
  }
  // 第四路：小号延长记号的点与弧粘成一块（四声部 135 下方声部 `3̂` 16×12），整块落进 dots 当了高音点。
  // 八度点是实心圆，上下一样窄；这块上部是一道宽拱（最宽处 ≥1.5 倍于下部），拱下是空心——上半有一行分成左右两段墨。
  // 四声部页上这种小记号也有印得比点宽的（88《无量荣光歌》23×13、字号 36：宽 0.64 字号，进不了点候选，哪一类都不是，全书漏三百来个）：
  // 宽 0.45~0.8、高 0.25~0.5 字号的块一并拿来按同一套拱形判据量。
  const wideCaps = voicedPage ? comps.filter((k) => k.bbox.w > numH * 0.45 && k.bbox.w <= numH * 0.8 &&
    k.bbox.h >= numH * 0.25 && k.bbox.h <= numH * 0.5 && !c.dots.includes(k)) : [];
  {
    for (const m of staff) {
      const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
      for (const owner of m.rd) {
        if (fermataOf.get(owner) || owner.bbox.h < medH * 0.85) continue;
        const ob = owner.bbox;
        for (const o of [...c.dots, ...wideCaps]) {
          const b = o.bbox, gap = ob.y - rbottom(b);
          if (fermataDots.has(o) || Math.abs(rcx(b) - rcx(ob)) > numH * 0.25 || gap < -1 || gap > numH * 0.8) continue;
          if (b.h < Math.max(6, numH * 0.28) || b.w > numH * (wideCaps.includes(o) ? 0.8 : 0.6)) continue;
          // 每行：横跨宽、墨段数、段间最大空隙
          const spans: number[] = [], runsN: number[] = [], gaps: number[] = [];
          for (let y = b.y; y < rbottom(b); y++) {
            let lo = -1, hi = -1, runs = 0, prev = false, gap = 0, cur = 0;
            for (let x = b.x; x < rright(b); x++) {
              const v = bin.data[y * bin.w + x] === 1;
              if (v) { if (lo >= 0 && cur > gap) gap = cur; if (lo < 0) lo = x; hi = x; if (!prev) runs++; cur = 0; } else if (lo >= 0) cur++;
              prev = v;
            }
            spans.push(lo < 0 ? 0 : hi - lo + 1); runsN.push(runs); gaps.push(gap);
          }
          const half = spans.length >> 1;
          const topW = Math.max(...spans.slice(0, half)), botW = Math.max(...spans.slice(spans.length - Math.max(2, Math.round(spans.length * 0.4))));
          // 拱：上半有一行整段（拱顶），紧接其下连续两行以上分成左右两段、段间空 ≥2px（拱下空心）。
          // 只看「上宽下窄 + 上半某行分段」会把顶上挂毛刺的扁点当成拱（1600《南非之行》12×8 的高音点）
          let arch = false;
          for (let i = 0; i + 2 <= half && !arch; i++) {
            if (runsN[i] !== 1) continue;
            let k = i + 1;
            while (k < spans.length && runsN[k]! >= 2 && gaps[k]! >= 2) k++;
            if (k - (i + 1) >= 2) arch = true;
          }
          if (topW < botW * 1.5 || !arch) continue;
          probe("fermata.fusedDot");
          fermataOf.set(owner, true);
          fermataDots.add(o);
          if (wideCaps.includes(o)) fermataArcs.add(o);
          break;
        }
      }
    }
  }
  // 多声部互证（用户提的思路）：延长记号管的是一个时间点，同一系统里一个声部在这个位置认出来了，别的声部同一位置也有。
  // 这本各声部各印一个，夹在两行之间的那几个不是粘在数字顶上、就是弧太扁过不了拱形门（83 第 1 系统四个只认出女高一个）。
  // 对齐位置（横向差 ≤0.4 字号）上放宽了找弧帽：数字头顶 0.8 字号内、宽 0.4~2 字号、高 ≤0.7 字号、不是点也不是别的数字的块，
  // 横线类的要拱得起来（上声部的减时线也在那里）。找着了，帽下紧挨的那颗点归延长记号（不再当高音点）；
  // 没找着帽、但已有两个以上声部作证的也补上，点不动。
  if (sysOf.size && fermataOf.size) {
    for (const rows of voiceSystems()) {
      const seeds = rows.flatMap((m) => m.rd.filter((k) => fermataOf.get(k)).map((k) => ({ m, x: rcx(k.bbox) })));
      if (!seeds.length) continue;
      for (const m of rows) for (const k of m.rd) {
        if (fermataOf.get(k)) continue;
        const kb = k.bbox;
        const n = seeds.filter((sd) => sd.m !== m && Math.abs(sd.x - rcx(kb)) <= numH * 0.4).length;
        if (!n) continue;
        const cap = comps.find((o) => {
          const ob = o.bbox;
          if (c.dots.includes(o) || fermataArcs.has(o)) return false;
          if (ob.w < numH * 0.4 || ob.w > numH * 2 || ob.h > numH * 0.7) return false;
          if (Math.abs(rcx(ob) - rcx(kb)) > numH * 0.4 || ob.y >= kb.y) return false;
          const gap = kb.y - rbottom(ob);
          if (gap > numH * 0.8 || gap < -numH * 0.3) return false;
          return !c.hlines.includes(o) || arched(ob);
        });
        if (!cap && n < 2) continue;
        probe(cap ? "fermata.mutualCap" : "fermata.mutual");
        fermataOf.set(k, true);
        if (!cap) continue;
        fermataArcs.add(cap);
        const dotC = c.dots.filter((o) => !fermataDots.has(o) && Math.abs(rcx(o.bbox) - rcx(cap.bbox)) <= numH * 0.3 &&
          o.bbox.y >= cap.bbox.y && o.bbox.y - rbottom(cap.bbox) <= numH * 0.25 && rbottom(o.bbox) <= kb.y + 1)
          .sort((p, q) => p.bbox.y - q.bbox.y)[0];
        if (dotC) fermataDots.add(dotC);
      }
    }
  }
  if (fermataDots.size) c.dots = c.dots.filter((o) => !fermataDots.has(o));
  if (fermataDots.size) c.hlines = c.hlines.filter((o) => !fermataDots.has(o));
  c.fermataCaps = [...fermataArcs].map((k) => k.bbox);

  // 波音（上波音 ∿）：音符正上方一小段**两个尖峰的锯齿**（2152《就是不一样》第 5、8 行）。
  // 与它同区的还有圆滑线弧帽与延长记号，三者都是「音符上方一块扁而宽的墨」，靠两条分开：
  //   · **宽度**——波音只有一个字宽（实测 29px ≈ 0.9 字号），圆滑线至少跨两个音（81~143px）；
  //   · **形状**——弧是凸的、顶点在正中间；波音正中间是两峰之间的**谷**。取每列最高墨点连成
  //     上缘线，比「中间那几列的最高点」与「整块的最高点」：弧的差是 0，波音差着小半块高。
  // **小号波音**另开一档：迦南诗选 1677《祷告》的波音只有 16×9px（字号 48，即 0.33 × 0.19），
  // 过不了上面那档的宽度门，尺寸又正落在 classify 的「小点」档里、被 buildJpNums 收成了高八度点
  //（`6̃` 读成 `6̇`）。形状判据照用：真八度点是圆的（宽高比 ≈1）、上缘只有一个峰，过不了
  // 宽高比与谷这两道。小号档宽度封顶 0.6 字号，挡住「八度点粘着弧端」那种又宽又扁的块。
  // **下波音**（∿ 中间一道竖杠）另走一档：迦南诗选 1775《十字架的路上》实测 29×21（字号 32），竖杠穿出锯齿上下，
  // 宽高比只有 1.38、高度也超了上面两档。先认出贯穿全高的那道竖杠（居中、一两像素宽），擦掉再照锯齿判据看剩下的。
  // 它原先被 splitOrnamentDot 从底部切出一个「八度点」（竖杠下端），`2` 读成 `2̇`、`6̣` 的高低点相消成 `6`——
  // 认出来后落在它包围盒里的点一并摘掉。
  // **owner 的纵向间隙量到波音正下方最近的那样东西**：数字，或数字头上的高八度点。1765《主啊，求你回来吧》
  // `2̇` 上的波音离点 4px、离数字 21px（字号 33），按数字顶量就卡在 0.5 字号上整个漏掉。
  // **弧尾粘着小号波音**（1771《你曾向主许下》`3⌒2̃`，弧与波音 8-连通成 49×9 一块）：块太宽，两档都进不去。
  // 对弧形块两端各取 0.45 字号宽的窗口照小号档判——弧自己的端点上缘一路往脚下降，峰都挤在窗口内侧，过不了
  // 「两峰分开」；弧块本身不动，照旧交给 detectSlurs。
  const ornamentOf = new Map<DigitCore, "upper-mordent" | "lower-mordent">();
  const mordentDots = new Set<Component>();
  const lowerBoxes: Rect[] = [];
  // 锯齿：r 内每列最高墨点连成上缘线（skip 的列不算），两峰要分得开（≥0.35 宽）、峰之间要有 ≥minValley 的谷。
  const zigzag = (r: Rect, minValley: number, skip?: (x: number) => boolean): boolean => {
    const top: number[] = [];
    for (let x = r.x; x < rright(r); x++) {
      if (skip?.(x)) { top.push(NaN); continue; }
      let y = r.y;
      while (y < rbottom(r) && !bin.data[y * bin.w + x]) y++;
      top.push(y < rbottom(r) ? y - r.y : NaN);
    }
    const valid = top.filter((v) => !isNaN(v));
    if (!valid.length) return false;
    const peak = Math.min(...valid);
    const hi = top.map((v, i) => (!isNaN(v) && v <= peak + r.h * 0.15 ? i : -1)).filter((i) => i >= 0);
    const pl = hi[0], pr = hi[hi.length - 1];
    if (pr - pl < r.w * 0.35) return false;                     // 峰都挤在一处 → 是弧顶，不是锯齿
    const valley = Math.max(...top.slice(pl, pr + 1).filter((v) => !isNaN(v)));
    return valley - peak >= minValley;                          // 两峰之间没有谷 → 还是弧
  };
  // 居中的竖杠：块中部 [0.3, 0.7] 宽内、最长竖直墨段 ≥0.85 块高的连续列，宽不过 max(3, 0.12 字号)。
  const centerStroke = (b: Rect): [number, number] | null => {
    let s0 = -1, s1 = -1;
    for (let x = Math.ceil(b.x + b.w * 0.3); x <= Math.floor(b.x + b.w * 0.7); x++) {
      let best = 0, cur = 0;
      for (let y = b.y; y < rbottom(b); y++) { if (bin.data[y * bin.w + x]) { if (++cur > best) best = cur; } else cur = 0; }
      if (best < b.h * 0.85) continue;
      if (s0 < 0) s0 = x;
      else if (x !== s1 + 1) return null;                        // 两道分开的竖杠：不是下波音
      s1 = x;
    }
    return s0 >= 0 && s1 - s0 + 1 <= Math.max(3, numH * 0.12) ? [s0, s1] : null;
  };
  for (const m of staff) {
    const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
    const ownerBelow = (b: Rect, self: Component) => m.rd.find((n) => {
      if (Math.abs(rcx(n.bbox) - rcx(b)) > numH * 0.4 || n.bbox.h < medH * 0.85) return false;
      if (ocrDigit(n.bbox) === 0) return false;                   // 休止符不带波音
      let top = n.bbox.y;
      for (const o of c.dots) {
        const ob = o.bbox;
        if (o === self || rcx(ob) < n.bbox.x || rcx(ob) > rright(n.bbox)) continue;
        if (rbottom(ob) > n.bbox.y + 1 || n.bbox.y - rbottom(ob) > numH * 0.6) continue;
        if (ob.y < rbottom(b) - numH * 0.25) continue;            // 点得在记号下面
        top = Math.min(top, ob.y);
      }
      const gap = top - rbottom(b);
      return gap >= -numH * 0.25 && gap <= numH * 0.5;
    });
    for (const k of comps) {
      const b = k.bbox;
      const big = b.w >= numH * 0.6 && b.w <= numH * 1.4 && b.h >= numH * 0.25 && b.h <= numH * 0.6;
      const small = b.w >= numH * 0.25 && b.w < numH * 0.6 && b.h >= numH * 0.12 && b.h < numH * 0.3;
      if ((big || small) && b.w / b.h >= 1.6) {
        const owner = ownerBelow(b, k);
        // 谷深：大档按块高的三成；小号档改按**像素**——1727《主为我》的波音只有 13×7，谷实测
        // 2px，而 0.3×7=2.1 差 0.1 就判成弧（两处波音全丢）。这么小的块上「三成」已细过像素栅格，
        // 2px 就是能分辨的最小谷。圆的八度点根本没有两个峰，卡在上面那道，不靠这一道挡。
        // 大档另要求**只罩一个音**：波音印在单音头上，圆滑线至少跨两个音。92《麦子若生了虫》
        // 那种密排小图里，跨两个八分音符的短弧只有 42×18（字号 31），宽高比、谷深都与波音重合
        // ——同一行另外三条同形弧（41×18~19）只差一两像素的谷就分到了另一边，光靠形状分不开。
        // 小号档/下波音/弧尾档窄得多（≤0.6 字号），罩不到第二个音，不必加这道。
        const spansTwo = big && owner && m.rd.some((n) => n !== owner && n.bbox.h >= medH * 0.85 &&
          rcx(n.bbox) > b.x && rcx(n.bbox) < rright(b) && Math.abs(rcx(n.bbox) - rcx(owner.bbox)) >= numH * 0.5);
        if (spansTwo) probe("mordent.spanTwoReject");
        if (owner && !spansTwo && zigzag(b, big ? b.h * 0.3 : 2)) {
          probe(big ? "mordent.big" : "mordent.small");
          ornamentOf.set(owner, "upper-mordent");
          mordentDots.add(k);
          continue;
        }
      }
      // 下波音
      if (b.w >= numH * 0.6 && b.w <= numH * 1.4 && b.h >= numH * 0.4 && b.h <= numH * 0.9 && b.w / b.h >= 1.1) {
        const st = centerStroke(b);
        const owner = st && ownerBelow(b, k);
        if (st && owner) {
          const off = (x: number) => x >= st[0] - 1 && x <= st[1] + 1;   // 竖杠两侧各让一列毛边
          const lft = tightBox(bin, b, 0, st[0] - 1 - b.x, 0, b.h);
          const rgt = tightBox(bin, b, st[1] + 2 - b.x, b.w, 0, b.h);
          const z = lft && rgt ? unionRect(lft, rgt) : null;
          if (z && zigzag(z, z.h * 0.3, off)) {
            probe("mordent.lower");
            ornamentOf.set(owner, "lower-mordent");
            mordentDots.add(k);
            lowerBoxes.push(b);
            continue;
          }
        }
      }
      // 弧尾粘着的小号波音
      if (b.w >= numH * 0.7 && b.h <= numH * 0.6 && b.w / b.h >= 2) {
        const ww = Math.round(numH * 0.45);
        const col = columnInk(bin, b, 0, b.h);
        const stroke = median(col.filter((v) => v > 0)) || 1;
        for (const x0 of [0, b.w - ww]) {
          const z = tightBox(bin, b, x0, x0 + ww, 0, b.h);
          if (!z || z.w < numH * 0.25 || z.h < numH * 0.12 || z.h >= numH * 0.3) continue;
          // 波音是实心的锯齿，列墨厚明显超过弧笔画（1771/1790 实测 5~9px 对笔画 3~4px，纯弧端各列 ≤4）；
          // 光凭上缘线不够——弧顶一个像素的毛边就能凑出 2px 的「谷」（1790《这条路》`2⌒1`）。
          const thick = Math.max(stroke * 1.5, stroke + 2);
          if (col.slice(x0, x0 + ww).filter((v) => v >= thick).length < ww * 0.25) continue;
          const owner = ownerBelow(z, k);
          if (owner && !ornamentOf.has(owner) && zigzag(z, 2)) { probe("mordent.arcEnd"); ornamentOf.set(owner, "upper-mordent"); }
        }
      }
    }
  }
  // 小号波音本躺在 dots 里，摘掉才不会再被收成八度点；下波音包围盒里切出来的「点」同理。
  const inLower = (o: Component) => lowerBoxes.some((r) => o.bbox.x >= r.x - 1 && rright(o.bbox) <= rright(r) + 1 &&
    o.bbox.y >= r.y - 1 && rbottom(o.bbox) <= rbottom(r) + 1);
  if (mordentDots.size) c.dots = c.dots.filter((o) => !mordentDots.has(o) && !inLower(o));

  // 顿音（▼）：音符正上方一个**实心倒三角**（1640《主要在中国掌权》整首每音一个）。
  // 尺寸落在 classify 的「小点」档里（实测 12×14，字号 32），故它本已躺在 c.dots 里，
  // 随时可能被 buildJpNums 收成高八度点——认出来后要从 dots 里摘掉。
  // 与真八度点靠**形状**分：三角是上宽下尖，逐行墨宽单调收到一个尖；圆点上下一样宽。
  // 再加填充率（三角 ≈0.5、圆点 ≈0.8）兜一道，免得淡印的圆点因边缘缺墨被当成三角。
  const staccatoOf = new Map<DigitCore, boolean>();
  const staccatoComps = new Set<Component>();
  for (const m of staff) {
    const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
    for (const k of comps) {
      const b = k.bbox;
      if (b.w < numH * 0.2 || b.w > numH * 0.6 || b.h < numH * 0.2 || b.h > numH * 0.6) continue;
      const ratio = b.w / b.h;
      if (ratio < 0.6 || ratio > 1.6) continue;
      const fill = k.area / (b.w * b.h);
      if (fill < 0.4 || fill > 0.75) continue;
      // 正下方紧跟着一个正常字号的数字。三角与数字之间隔着大半个字号（实测 0.7），
      // 比八度点/附点那种紧贴的窗口宽得多，故窗口放到 1 个字号。
      const owner = m.rd.find((n) => Math.abs(rcx(n.bbox) - rcx(b)) <= numH * 0.35 &&
        n.bbox.y - rbottom(b) >= -numH * 0.1 && n.bbox.y - rbottom(b) <= numH &&
        n.bbox.h >= medH * 0.85);
      if (!owner) continue;
      // 逐行墨宽：上宽下尖且一路不回头（容 1px 二值化毛刺）。
      const rowW: number[] = [];
      for (let y = b.y; y < rbottom(b); y++) {
        let lo = -1, hi = -1;
        for (let x = b.x; x < rright(b); x++) if (bin.data[y * bin.w + x]) { if (lo < 0) lo = x; hi = x; }
        rowW.push(lo < 0 ? 0 : hi - lo + 1);
      }
      if (rowW.length < 4) continue;
      if (rowW[0] < b.w * 0.8) continue;                                   // 顶行不是最宽 → 不是倒三角
      if (rowW[rowW.length - 1] > b.w * 0.4) continue;                     // 底行没收成尖
      if (rowW.some((v, i) => i > 0 && v > rowW[i - 1] + 1)) continue;     // 中途变宽 → 不是三角
      probe("staccato");
      staccatoOf.set(owner, true);
      staccatoComps.add(k);
    }
  }
  // 三角不是八度点，别让 buildJpNums 收走。
  if (staccatoComps.size) c.dots = c.dots.filter((o) => !staccatoComps.has(o));

  // 重音（>）：音符正上方一个**空心的尖朝右的楔形**（1889《愿你们刚强》副歌一连十几个）。
  // 实测 13×10（字号 29，即 0.45 × 0.34），离数字顶 12px；尺寸同样可能落进「小点」档被收成高八度点。
  // 靠形状认：逐行墨的右缘在中间那几行最靠右、顶行底行都缩回左半；中间行的左缘也离开左边（中空），
  // 实心的点、倒三角都过不了后一条。窗口口径同顿音，但点得在记号下面：高八度点可以夹在中间。
  const accentOf = new Map<DigitCore, boolean>();
  const accentComps = new Set<Component>();
  for (const m of staff) {
    const medH = median(m.rd.map((k) => k.bbox.h)) || numH;
    for (const k of comps) {
      const b = k.bbox;
      if (b.w < numH * 0.25 || b.w > numH * 0.7 || b.h < numH * 0.2 || b.h > numH * 0.6) continue;
      const ratio = b.w / b.h;
      if (ratio < 0.9 || ratio > 2.2) continue;
      if (k.area / (b.w * b.h) > 0.6) continue;
      const lo: number[] = [], hi: number[] = [];
      for (let y = b.y; y < rbottom(b); y++) {
        let l = -1, r = -1;
        for (let x = b.x; x < rright(b); x++) if (bin.data[y * bin.w + x]) { if (l < 0) l = x - b.x; r = x - b.x; }
        lo.push(l); hi.push(r);
      }
      if (lo.some((v) => v < 0) || lo.length < 5) continue;
      const n = lo.length, mid = hi.indexOf(Math.max(...hi));
      if (mid < n * 0.25 || mid > n * 0.75 || hi[mid] < b.w * 0.85) continue;          // 尖不在中间偏右
      if (hi[0] > b.w * 0.55 || hi[n - 1] > b.w * 0.55) continue;                       // 两头没缩回左半
      if (lo[0] > b.w * 0.25 || lo[n - 1] > b.w * 0.25 || lo[mid] < b.w * 0.35) continue; // 不是开口朝左的楔
      const owner = m.rd.find((d) => Math.abs(rcx(d.bbox) - rcx(b)) <= numH * 0.35 &&
        d.bbox.y - rbottom(b) >= -numH * 0.1 && d.bbox.y - rbottom(b) <= numH &&
        d.bbox.h >= medH * 0.85 && ocrDigit(d.bbox) !== 0);
      if (!owner) continue;
      probe("accent");
      accentOf.set(owner, true);
      accentComps.add(k);
    }
  }
  if (accentComps.size) c.dots = c.dots.filter((o) => !accentComps.has(o));

  // 每行数字高：宽不过 1.1 字号的核（窄的「1」也算，粘连的宽块不算——299 一行全是 1 加一块 97×51，只数宽的就成了 51），不足三个不算
  const rowDigitH = new Map(staff.map((m) => {
    const hs = m.rd.filter((k) => k.bbox.w <= numH * 1.1).map((k) => k.bbox.h);
    return [m, hs.length >= 3 ? median(hs) : 0] as const;
  }));
  const smallRows = [...rowDigitH.values()].some((h) => h > 0 && h <= numH * 1.1);
  const allRows: StaffRow[] = staff.map((m) => {
    const mySys = sysOf.get(m)?.sys;
    // 歌词行不算别的声部：四声部谱夹在第 2、3 声部之间的几行歌词此时还在系统里（新编赞美诗·四声部 11《荣归天父歌》三行词 41px 见方，
    // 数字 38×22），第 2 声部压在字顶上的低音点被 nearerOther 判成「离下面那个数字更近」、整排丢掉（全本第 2 声部漏低音点七百多处）。
    // 汉字核近方（宽 ≥0.85 高）且比本行数字高，一半以上的核是这样的行就是歌词
    const myH = median(m.rd.map((k) => k.bbox.h));
    const lyricRow = (o: typeof m) => o.rd.filter((k) => k.bbox.w >= k.bbox.h * 0.85 && k.bbox.h >= myH * 1.05).length * 2 >= o.rd.length;
    const mates = mySys !== undefined ? staff.filter((o) => o !== m && sysOf.get(o)?.sys === mySys && !lyricRow(o)).flatMap((o) => o.rd.map((k) => k.bbox)) : [];
    // 一页两种字号（四声部二十几页：第 1 声部数字 37~38、其余声部 29~31，页字号按多数的小号估成 29）：大号那行的八度点、
    // 减时线、附点窗口全按小号量，够不着。本行数字中位高比页字号大 15% 以上就按本行量（×0.96：字号一致的页上字号/数字高实测比）
    // 只在真是两种字号时：页上还得有数字高在页字号 1.1 倍以内的行（整页一律比字号高两成的是字号估小，不归这里，四声部 38）
    const rowH = rowDigitH.get(m) || numH;
    const rowNumH = rowH >= numH * 1.15 && smallRows ? rowH * 0.96 : numH;
    if (rowNumH !== numH) probe("numH.perRow");
    // 上下相邻系统挨着的那一行（多声部谱才找）：上一系统末声部的低音点也会落进本系统首声部的上方窗口
    //（四声部 32 第 1 声部按大号量窗口后，收了上一系统低音声部 `5̣ 3̣ 5̣` 的点）
    const others = mySys === undefined ? [] : [-1, 1].flatMap((dir) => {
      const cand = staff.filter((o) => o !== m && sysOf.get(o)?.sys !== undefined && sysOf.get(o)!.sys !== mySys && !lyricRow(o) &&
        (dir < 0 ? o.botY <= m.topY : o.topY >= m.botY));
      const near = cand.sort((a, b) => dir < 0 ? b.botY - a.botY : a.topY - b.topY)[0];
      return near ? near.rd.map((k) => k.bbox) : [];
    });
    const nums = buildJpNums(bin, m.rd, rowNumH, c, ocrDigit, arcCands, m.barlineXs, dotSizes, mates, others);
    // buildJpNums 与 rd 一一对应，故按下标把摘出来的变音记号挂回它所修饰的那个音符。
    m.rd.forEach((k, j) => {
      const a = accidentals.get(k); if (a && nums[j]) nums[j].accidental = a;
      if (fermataOf.get(k) && nums[j]) nums[j].fermata = true;
      const orn = ornamentOf.get(k); if (orn && nums[j]) nums[j].ornament = orn;
      if (staccatoOf.get(k) && nums[j]) nums[j].articulation = "staccato";
      if (accentOf.get(k) && nums[j]) nums[j].articulation = "accent";
      const g = graceOf.get(k); if (g && nums[j]) nums[j].grace = g;
    });
    const row: StaffRow = { topY: m.topY, bottomY: m.botY, barlineXs: m.barlineXs, nums,
      finalBarline: (m as { finalBarline?: "end" }).finalBarline,
      doubleBarXs: (m as { doubleBarXs?: number[] }).doubleBarXs,
      endBarXs: (m as { endBarXs?: number[] }).endBarXs };
    const sv = sysOf.get(m);
    if (sv) { row.system = sv.sys; row.voice = sv.voice; }
    return row;
  });

  // 剔除「和弦标记行」等伪乐谱行：五线谱上方的 G/D7/Am… 和弦字母被 OCR 成非数字→几乎全是
  // 休止(digit 0)，且贯穿小节线很少。实测真乐谱行休止占比 ≤18%、小节线 ≥4；伪行休止 ≥79%、
  // 线 ≤2，间隔极大。用「休止占比 < 0.5」即可干净分开（保留余量，避免误杀含少量休止的真行）。
  // 但**有增时线的行**放宽到 0.8（伪行实测 ≥79%）：迦南诗选 1780《主快来》末行 `6 – 0 0 ‖` 休止占 2/3，
  // 按 0.5 整行被当伪行删掉。增时线要落在数字右侧、与数字纵向重叠且居中（buildJpNums），伪行里没有
  //（1697 标题行、1717 一行歌词实测都是 0 条）。**终止线不能当凭据**：汉字几道竖笔并排就够得上
  // （1697 标题行、1717 那行歌词都被标成了 finalBarline），拿它放行，两首都多出一行、1697 连页眉都丢了。
  const restShare = (nums: JpNum[]) => nums.filter((n) => n.digit === 0).length / nums.length;
  const keepBy = (nums: JpNum[]) => restShare(nums) < (nums.some((n) => n.augment > 0) ? 0.8 : 0.5);
  // 整行判伪之前先试「截行」：谱后印的正文/右侧边注与末谱行同高时，groupRows 会把它并进那一行，
  // 汉字全读成休止 0 → 占比过半 → **整行连真音符带歌词一起丢**（1811《心愿》末行 y1760~1815 与
  // 注记首行 y1778~1805 同带，`处处是春天` 那一行就是这么没的）。真休止在谱面上是零星的（相邻总
  // 隔着音符或小节线），连成五个以上的只可能是正文；故把「连续 ≥5 个读作 0 的核」整段剔掉再判。
  // 只在整行**本来要被丢**时才截（截行会改音流，不能动本来就过关的行）；和弦字母行整行全 0、
  // 截无可截，仍照旧整行丢。
  const trimProse = (r: StaffRow): boolean => {
    const keep: JpNum[] = [];
    for (let i = 0; i < r.nums.length; i++) {
      let j = i;
      while (j + 1 < r.nums.length && r.nums[j + 1].digit === 0 && r.nums[i].digit === 0) j++;
      if (r.nums[i].digit === 0 && j - i + 1 >= 5) { i = j; continue; }
      keep.push(r.nums[i]);
    }
    if (keep.length === r.nums.length || keep.length < 3 || !keepBy(keep)) return false;
    probe("pseudoRow.trim");
    r.nums = keep;
    return true;
  };
  // 截行只对**第一条正经谱行以下**的行开：页眉那条带（曲号 + 标题汉字）同样是「几个数字 + 一长串
  // 读作 0 的汉字」，截完剩下的曲号数字足以冒充一条谱行，第一谱行的位置随之上移，页眉 ROI 被吃掉
  // ——1697《温州的水 温州的山》的标题/曲号/词曲/调号会一起归零。
  // 连谱号分组是否整体成立（验收口径同下面 useRows 那一道）：不成立时系统号只是左边碰巧有道高竖块，
  // 不能拿它给休止多的行作保（1811《心愿》谱后的正文行就是这么混进来的）。
  const bracedOk = ((): boolean => {
    const rs = allRows.filter((r) => r.nums.length);
    if (!rs.length || rs.some((r) => r.system === undefined)) return false;
    const sizes = new Map<number, number>();
    for (const r of rs) sizes.set(r.system!, (sizes.get(r.system!) ?? 0) + 1);
    const n = [...sizes.values()];
    return sizes.size >= 2 && n.every((x) => x === n[0] && x >= 2);
  })();
  const firstOkTop = Math.min(...allRows.filter((r) => r.nums.length && keepBy(r.nums)).map((r) => r.topY));
  // 页眉那一排（1218 通本「95 F调 4/4 超乎万有」曲号与拍号是数字、标题读成 0）被凑成了最上面一「行」：休止占比 0.44
  // 过得了 0.5 的门。真第一谱行一行里总有几根小节线；这一排至多一两根（标题字的竖笔，468）。
  const topRow = allRows.filter((r) => r.nums.length).reduce<StaffRow | undefined>((a, r) => (!a || r.topY < a.topY ? r : a), undefined);
  const headerLike = !!topRow && topRow.barlineXs.length <= 2 && restShare(topRow.nums) >= 0.3 &&
    allRows.filter((r) => r !== topRow && r.barlineXs.length >= 3).length >= 2;
  const rows = allRows.filter((r) => {
    if (!r.nums.length) return false;
    if (headerLike && r === topRow) { probe("pseudoRow.headerLine"); return false; }
    const rest = restShare(r.nums);
    // 连谱号括着的行是实打实的声部行：四声部谱的伴奏声部休止多（78《马槽歌》第 2 系统 Q3 `5 5 0 0 | 0 0 6 …`
    // 过半是 0），按单声部的 0.5 会被当成和弦字母伪行删掉，整个系统缺一声部、分组验收失败。
    // 静默声部：连谱号括着、有两根以上小节线、整行几乎全是 0（新编赞美诗·四声部 76 第 2 系统第 4 声部「0 0 0 0 | 000 0 |…」）。
    // 和弦字母、汉字凑成的伪行不会既归了系统又有小节线。
    // 休止 0 是瘦长的椭圆（宽高比 ~0.6）；歌词行被读成一串 0 时核是近方的汉字（~1.0），这页小节线又穿过歌词区（18），要分开
    const silentVoice = r.system !== undefined && r.barlineXs.length >= 2 && rest >= 0.8 &&
      median(r.nums.map((n) => n.bbox.w / Math.max(1, n.bbox.h))) <= 0.8;
    const ok = keepBy(r.nums) || (bracedOk && r.system !== undefined && rest < 0.8) || silentVoice;
    if (silentVoice && !keepBy(r.nums)) probe("pseudoRow.silentVoice");
    const keep = ok || (r.topY > firstOkTop && trimProse(r));
    probe(!keep ? "pseudoRow.drop" : ok && rest >= 0.5 ? "pseudoRow.keepByAugment" : "row");
    return keep;
  });
  for (const r of rows) for (const n of r.nums) if (n.digit === RHYTHM_DIGIT) probe("rhythmX");
  // 整曲都被判伪行（极端情况）则回退，至少出点东西。
  let useRows = rows.length ? rows : allRows;
  // 多声部分组验收：每条谱行都归了系统、≥2 个系统、各系统行数相同且声部号连续——缺一条就当单声部
  //（连谱号认错、伪行剔掉了其中一条，硬分声部会把音乐次序整个打乱）。
  if (useRows.some((r) => r.system !== undefined)) {
    // 连谱号认得不全时的几种补救，都以「每系统行数的众数」为准（行数对不上验收就整页退回单声部）：
    {
      const countOf = () => {
        const cnt = new Map<number, number>();
        for (const r of useRows) if (r.system !== undefined) cnt.set(r.system, (cnt.get(r.system) ?? 0) + 1);
        return cnt;
      };
      // ⓪ 系统里夹着的碎行（94 第 1 系统第 3、4 声部之间一条 4 个音的碎行；313 每个系统都夹着几条 4~6 个音的）：
      //    音数不到同系统中位数四成的剔掉，剔完至少还剩 3 行才剔。先剔再数众数，否则众数被碎行抬高
      const drop = new Set<StaffRow>();
      // 同一谱行被 groupRows 拆成纵向重叠的两三段（243：816~883 与 849~892；179 拆成三段），合回一行
      for (const sys of countOf().keys()) {
        const g = useRows.filter((r) => r.system === sys).sort((a, b) => a.topY - b.topY);
        for (let i = 0; i < g.length; i++) {
          const a = g[i]!;
          if (drop.has(a)) continue;
          for (let j = i + 1; j < g.length; j++) {
            const b = g[j]!;
            const ov = Math.min(a.bottomY, b.bottomY) - Math.max(a.topY, b.topY);
            if (ov < Math.min(a.bottomY - a.topY, b.bottomY - b.topY) * 0.4) break;
            // 拆开的一行两段在横向上错开；上下两个声部（行框被八度点、弧撑得交叠，141、317）的音却上下对齐——对齐的过三成不并
            const stacked = b.nums.filter((n) => a.nums.some((m) => Math.abs(rcx(m.bbox) - rcx(n.bbox)) <= numH * 0.5)).length;
            if (stacked > b.nums.length * 0.3) continue;
            probe("voices.mergeSplitRow");
            a.nums = [...a.nums, ...b.nums].sort((p, q) => p.bbox.x - q.bbox.x);
            a.barlineXs = [...new Set([...a.barlineXs, ...b.barlineXs])].sort((p, q) => p - q);
            if (b.doubleBarXs) a.doubleBarXs = [...(a.doubleBarXs ?? []), ...b.doubleBarXs].sort((p, q) => p - q);
            if (b.endBarXs) a.endBarXs = [...(a.endBarXs ?? []), ...b.endBarXs].sort((p, q) => p - q);
            if (b.finalBarline) a.finalBarline = b.finalBarline;
            a.topY = Math.min(a.topY, b.topY); a.bottomY = Math.max(a.bottomY, b.bottomY);
            drop.add(b);
          }
        }
      }
      // 连谱号括进来的歌词行（43：「4.耶稣 最清洁…」段号读成数字、右边长小节线穿过歌词区）：核是近方的汉字，
      // 中位宽高比 ≥0.85（数字瘦长 ~0.6、休止 0 ~0.7），剔完还剩 ≥3 行才剔
      for (const [sys, n] of countOf()) {
        const g = useRows.filter((r) => r.system === sys && !drop.has(r));
        // 小字号印的声部（234 第 1 系统首声部，核高 27、别的声部 39）宽高比也偏大，但它矮、又有一排小节线（6 根）；
        // 歌词行要么跟数字一般高，要么只凑得出一两根线（43 那排歌词核高 25、1 根线）
        const sysH = median(g.map((r) => median(r.nums.map((k) => k.bbox.h))));
        const sq = g.filter((r) => median(r.nums.map((k) => k.bbox.w / Math.max(1, k.bbox.h))) >= 0.85 &&
          !(median(r.nums.map((k) => k.bbox.h)) < sysH * 0.85 && r.barlineXs.length >= 3));
        if (sq.length && n - sq.length >= 3) { probe("voices.dropLyricRow"); for (const r of sq) drop.add(r); }
      }
      for (const r of drop) { delete r.system; delete r.voice; }
      const cThin = countOf(), fqThin = new Map<number, number>();
      for (const n of cThin.values()) fqThin.set(n, (fqThin.get(n) ?? 0) + 1);
      const mdThin = [...fqThin].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? 0;   // 平局取小（f32 两个系统 4 行、5 行）
      for (const [sys, n] of cThin) {
        const g = useRows.filter((r) => r.system === sys);
        const med = median(g.map((r) => r.nums.length));
        // 有三根以上小节线的不算碎行：全是长音的小字声部（234 第 4 声部「1 — — | 1 — —」只 6 个音、6 根线）；碎行至多一根。
        // 系统行数已超过众数时不豁免——系统通长线穿过的碎行也有一排线（f32 第 2 系统和弦上叠的那几个小字）
        const thin = g.filter((r) => r.nums.length < med * 0.4 && (r.barlineXs.length < 3 || n > mdThin));
        if (thin.length && n - thin.length >= 3) { probe("voices.dropThin"); for (const r of thin) drop.add(r); }
      }
      for (const r of drop) { delete r.system; delete r.voice; }
      // 比别的系统多一行、系统里声部行本来就短，碎行按系统中位的四成剔不掉（117 第 4 系统：声部行 12 个音，
      // 两声部之间那排歌词只剩 5 个窄核）：多出一行的系统里最短那行不到全页声部行中位一半时剔掉
      {
        const c0 = countOf(), fq = new Map<number, number>();
        for (const n of c0.values()) fq.set(n, (fq.get(n) ?? 0) + 1);
        const md = [...fq].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0]?.[0] ?? 0;
        const medPage = median(useRows.filter((r) => r.system !== undefined).map((r) => r.nums.length));
        for (const [sys, n] of c0) {
          if (md < 2 || n !== md + 1 || (fq.get(md) ?? 0) < 2) continue;
          const g = useRows.filter((r) => r.system === sys);
          const short = g.reduce((a, b) => (b.nums.length < a.nums.length ? b : a));
          if (short.nums.length < medPage * 0.5) { probe("voices.dropExtraThin"); drop.add(short); delete short.system; delete short.voice; }
        }
      }
      let cnt = countOf();
      const freq = new Map<number, number>();
      for (const n of cnt.values()) freq.set(n, (freq.get(n) ?? 0) + 1);
      const mode = [...freq].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0]?.[0] ?? 0;
      let nextSys = Math.max(-1, ...cnt.keys()) + 1;
      const byY = useRows.filter((r) => !drop.has(r)).sort((x, y) => x.topY - y.topY);
      // ① 两个系统的连谱号上下挨着连成了一道（336：8 行）：正好两倍就从中间劈开
      for (const [sys, n] of cnt) {
        if (mode < 2 || n !== mode * 2) continue;
        probe("voices.splitDouble");
        const g = byY.filter((r) => r.system === sys);
        for (const r of g.slice(mode)) r.system = nextSys;
        nextSys++;
      }
      // ② 整个系统的连谱号没认出来（83 第 1 系统）：连续一段没归系统的行，行数正好是众数，自成一个系统
      for (let i = 0; i < byY.length; ) {
        let j = i;
        while (j < byY.length && byY[j].system === undefined) j++;
        if (j - i === mode && mode >= 2) {
          probe("voices.orphanSystem");
          for (let k = i; k < j; k++) byY[k].system = nextSys;
          nextSys++;
        }
        i = Math.max(j, i + 1);
      }
      cnt = countOf();
      // ③ 连谱号下钩没够着的末声部行（34 第 1 系统第 4 行）、上钩没够着的首声部行（270 第 4 系统）：
      //    紧贴某系统的末行/首行（中间没隔歌词，间隔 <1.5 字号）、且那个系统比众数少一行，就并进去
      byY.forEach((r, i) => {
        if (r.system !== undefined) return;
        const prev = byY[i - 1], next = byY[i + 1];
        if (prev?.system !== undefined && (cnt.get(prev.system) ?? 0) < mode && r.topY - prev.bottomY < numH * 1.5) {
          probe("voices.adoptBelow");
          r.system = prev.system;
        } else if (next?.system !== undefined && (cnt.get(next.system) ?? 0) < mode && next.topY - r.bottomY < numH * 1.5) {
          probe("voices.adoptAbove");
          r.system = next.system;
        } else return;
        cnt.set(r.system, (cnt.get(r.system) ?? 0) + 1);
      });
      // ④ 那一行被**下一个**连谱号的上钩罩了进去（85 第 3 系统 3 行、第 4 系统 5 行）：
      //    相邻两系统差两行、多的那个首行紧贴少的那个末行时挪回去
      byY.forEach((r, i) => {
        const prev = byY[i - 1];
        if (!prev || prev.system === undefined || r.system === undefined || r.system === prev.system) return;
        const a = cnt.get(prev.system) ?? 0, b = cnt.get(r.system) ?? 0;
        if (a >= b || b - a !== 2 || r.topY - prev.bottomY >= numH * 1.5) return;
        probe("voices.moveUp");
        cnt.set(r.system, b - 1); cnt.set(prev.system, a + 1);
        r.system = prev.system;
      });
      // 没归系统的碎行（64：一条 3 个音的碎块行）：音数不到全曲声部行中位数四成的剔掉，免得「每行都归了系统」这一条验收不过
      {
        const medAll = median(useRows.filter((r) => r.system !== undefined && !drop.has(r)).map((r) => r.nums.length));
        for (const r of useRows) if (r.system === undefined && !drop.has(r) && r.nums.length < medAll * 0.4) { probe("voices.dropOrphanThin"); drop.add(r); }
      }
      if (drop.size) useRows = useRows.filter((r) => !drop.has(r));
      // 系统号按纵向位置重排（①② 新开的号排在后面）
      const order = [...new Set(byY.filter((r) => !drop.has(r) && r.system !== undefined).map((r) => r.system!))];
      const remap = new Map(order.map((sys, k) => [sys, k]));
      for (const r of useRows) if (r.system !== undefined) r.system = remap.get(r.system);
    }
    const bySys = new Map<number, StaffRow[]>();
    for (const r of useRows) if (r.system !== undefined) (bySys.get(r.system) ?? bySys.set(r.system, []).get(r.system)!).push(r);
    // 声部号按剔完伪行后剩下的行重排：连谱号括进来的一行歌词（新编赞美诗·四声部 201 第 2 系统，歌词行
    // 几何上凑成了谱行）先占了一个声部号，OCR 后才被当伪行剔掉，剩下 0、1、3、4——号不连续就整页退回单声部。
    for (const g of bySys.values()) {
      g.sort((a, b) => a.topY - b.topY);
      g.forEach((r, i) => { if (r.voice !== i) { probe("voices.renumber"); r.voice = i; } });
    }
    const sizes = [...bySys.values()].map((g) => g.length);
    // 整首只有一个系统的（393）也算，但要 ≥3 行——两行的「系统」多半是连谱号认错
    const ok = useRows.every((r) => r.system !== undefined) && (bySys.size >= 2 || sizes[0]! >= 3) && sizes.every((n) => n === sizes[0] && n >= 2)
      && [...bySys.values()].every((g) => g.every((r, i) => r.voice === i));
    probe(ok ? "voices" : "voices.reject");
    if (!ok) for (const r of useRows) { delete r.system; delete r.voice; }
    else {
      resolvePairOctaveDots(useRows, numH);
      // 系统行末线只画到上面几个声部（12 第 3 系统：下两声部一个尾音一行空、右端无线），各声部同一系统一起收尾——
      // 缺的那几行借本系统最右那根，否则末小节「开口」并进下一系统、该声部此后整首错一小节。
      for (const g of bySys.values()) {
        const endX = Math.max(...g.map((r) => r.barlineXs.length ? r.barlineXs[r.barlineXs.length - 1]! : -Infinity));
        if (!Number.isFinite(endX)) continue;
        for (const r of g) {
          const last = r.barlineXs.length ? r.barlineXs[r.barlineXs.length - 1]! : -Infinity;
          if (last >= endX - numH * 0.5 || r.nums.some((n) => rright(n.bbox) > endX)) continue;
          probe("voices.shareEndBar");
          r.barlineXs.push(endX);
        }
      }
    }
  }

  // 转拍号归行：落在哪一谱行的纵向范围里就归哪一行，并锚到**其右侧第一个音符**上
  // （谱面上转拍号总印在小节线右边、新小节的头一个音符之前）。本行右侧没有音符了
  // （行末换拍）就锚到下一行的第一个音符。
  // 页眉上并排印着的那几个拍号（`1=C 3/4 4/4`）也是同一个形，几何法一并认了出来，
  // 它们落在第一谱行**上方**、归不进任何谱行；收起来交给 recognizeHeader 当混合拍用。
  const headerMeters: { beats: number; beatType: number; bbox: Rect }[] = [];
  for (const mk of meterMarks) {
    const mcy = rcy(mk.bbox);
    const ri = useRows.findIndex((r) => mcy >= r.topY - numH && mcy <= r.bottomY + numH);
    if (ri < 0) {
      if (useRows.length && mcy < useRows[0].topY) { probe("meter.header"); headerMeters.push(mk); }
      continue;
    }
    probe("meter.inRow");
    const row = useRows[ri];
    (row.meters ??= []).push(mk);
    const anchor = row.nums.find((n) => n.bbox.x > mk.x) ?? useRows[ri + 1]?.nums[0];
    if (anchor) anchor.timeChange = { beats: mk.beats, beatType: mk.beatType };
  }
  for (const r of useRows) r.meters?.sort((a, b) => a.x - b.x);

  // 反复线与一/二房：以冒号点对/顶括线几何识别，锚到相邻音符，建模型时提升为小节线。
  await detectRepeatsAndEndings(bin, comps, c.dots, useRows, numH, ocr);
  // segno 𝄋（跳转目标）：字形识别，锚到下方音符所在小节的左线。
  detectSegno(comps, useRows, numH);

  // 多连音（三连音 ⌒3⌒）：先于 slur 认——括线的两半自己也够得着圆滑线的判据，认出来后
  // 要把它们从 detectSlurs 的输入里摘掉。「几连」靠 OCR 读括线上那个小号数字；
  // **读出的数要与括线罩住的音符个数对上**才采信（三连音三个音），对不上宁可整条作废：
  // 这一条同时兜住了误检——凑巧的三块墨很难恰好又是个数字、又与音符数吻合。
  const tupComps = new Set<Component>();
  {
    const cands = tupletCandidates(bin, [...comps, ...arcComps], useRows, numH);
    const digits = cands.length ? await ocr.recognizeDigits(bin, cands.map((c) => c.numeral)) : [];
    cands.forEach((cand, i) => {
      const actual = digits[i] ?? 0;
      // normal = 不大于 actual 的最大 2 的幂（3→2、5/6/7→4）。4 连音是「4 占 3」、
      // 2 连音是「2 占 3」，都只出现在复拍子里且这条推法不成立，故不收。
      if (![3, 5, 6, 7].includes(actual) || cand.notes.length < actual) return;
      // 密排（1218 746「1̇1̇7 1̇1̇7」一组挨一组）：左右放宽半个字号会罩进邻组的音。多出来时取中心离括线数字最近的连续 actual 个
      if (cand.notes.length > actual) {
        const cx = rcx(cand.numeral);
        let bi = 0, bd = Infinity;
        for (let i = 0; i + actual <= cand.notes.length; i++) {
          const w = cand.notes.slice(i, i + actual);
          const d = Math.abs((rcx(w[0]!.bbox) + rcx(w[actual - 1]!.bbox)) / 2 - cx);
          if (d < bd) { bd = d; bi = i; }
        }
        probe("tuplet.trimDense");
        cand.notes = cand.notes.slice(bi, bi + actual);
      }
      const normal = Math.pow(2, Math.floor(Math.log2(actual)));
      cand.notes.forEach((n, k) => {
        if (k === 0) probe("tuplet");
        n.tuplet = { actual, normal, start: k === 0, stop: k === cand.notes.length - 1 };
      });
      for (const a of cand.arcs) tupComps.add(a);
      // 括线上的数字先前被当成了倚音（方括号式「┌3┐」离数字带近，1218 746 读出一串 `{3}`）：认成多连音后摘掉
      const nb = cand.numeral;
      for (const row of useRows) for (const n of row.nums) {
        if (!n.grace) continue;
        const kept = n.grace.filter((g) => Math.min(rright(g.bbox), rright(nb)) - Math.max(g.bbox.x, nb.x) <= 0 ||
          Math.min(rbottom(g.bbox), rbottom(nb)) - Math.max(g.bbox.y, nb.y) <= 0);
        if (kept.length !== n.grace.length) { probe("tuplet.dropGrace"); n.grace = kept.length ? kept : undefined; }
      }
    });
  }

  // 圆滑线/连音线：检测音符上方弧形连通块 → 置位起止音符（不依赖 OCR 后端）。
  // comps 之外再补上与数字粘连切出的弧帽（arcComps）。与小节线粘连的弧已在 untangleBridged
  // 去连通阶段还原为 comps 里的独立连通块，这里天然一并检测。
  const slurRefits = detectSlurs(bin, [...comps, ...arcComps].filter((k) => !tupComps.has(k)), useRows, numH);

  // 页眉：标题/作词/作曲/调号/速度（同样仅 PaddleOCR 后端）。
  // **必须排在歌词/和弦识别之前**：第一谱行的「上方带」（和弦所在）与页眉 ROI 在几何上是重叠的，
  // 页眉里的调号 `1=C 4/4` 会一并落进和弦通道（OCR 常把它读成 `-C4`、`C4` 这类残片，
  // 恰好是合法的「根音 + 数字」和弦，「为基督赢得城市」就凭空多出一个 C4）。
  // 拿 header **已采纳**的字段区域当禁区交给 recognizeLyrics 剔，比在文法上猜可靠得多——
  // det 框里那个真和弦 `Am` 不会被 header 采纳，故不在禁区里。
  let title: string | undefined, subtitle: string | undefined, credits: string[] | undefined;
  let number: string | undefined, numberSide: RecognizedScore["numberSide"];
  let fifths = 0, tempo: number | undefined, tempoBeat: RecognizedScore["tempoBeat"];
  let beats = 4, beatType = 4;
  let meters: RecognizedScore["meters"], meterNote: string | undefined;
  let headerRegions: RecognizedScore["headerRegions"];
  if (ocr.recognizeTexts && useRows.length) {
    const h = await recognizeHeader(bin, comps, useRows[0].topY, numH, ocr,
      headerMeters.sort((a, b) => a.bbox.x - b.bbox.x));
    title = h.title; subtitle = h.subtitle; number = h.number; numberSide = h.numberSide; credits = h.credits.length ? h.credits : undefined;
    if (h.fifths !== undefined) fifths = h.fifths;
    if (h.beats !== undefined && h.beatType !== undefined) { beats = h.beats; beatType = h.beatType; }
    meters = h.meters; meterNote = h.meterNote;
    tempo = h.tempo; tempoBeat = h.tempoBeat;
    headerRegions = h.regions.length ? h.regions : undefined;
  }

  // 歌词：仅当后端支持中文文本识别(PaddleOCR)时，识别乐谱行下方歌词并按 x 对齐到音符。
  let lyricRegions: RecognizedScore["lyricRegions"];
  let chordRegions: RecognizedScore["chordRegions"];
  let stanzaRegions: RecognizedScore["stanzaRegions"];
  let lyricCheck: RecognizedScore["lyricCheck"];
  if (ocr.recognizeTexts) {
    // 连谱号（多声部谱左侧那道 `[`）竖穿歌词带，它的竖笔与钩会被当成行首的字（《圣哉三一歌》第 1、2 系统
    // 歌词读成 `I///L`）。多声部分组成立时剔掉。右缘不放宽：钩已在连谱号的包围盒里，紧挨着的就是段号（「1圣哉」的 1）。
    // 只剔连谱号本身（够高的竖笔块）和上下钩那两端的块：钩向右伸，框把紧挨竖线的段号「1」也罩了进去（三一来临歌、马槽歌）。
    const inBrace = (k: Component) => useRows.some((r) => r.voice !== undefined) && braceRects.some((br) =>
      k.bbox.x >= br.x - numH * 0.3 && rright(k.bbox) <= rright(br) + 2 &&
      k.bbox.y >= br.y - numH * 0.5 && rbottom(k.bbox) <= rbottom(br) + numH * 0.5 &&
      (k.bbox.h >= numH * 2 || k.bbox.y <= br.y + numH * 1.5 || rbottom(k.bbox) >= rbottom(br) - numH * 1.5));
    // 同一系统里共用小节线（有线从上一行穿过缝伸进下一行）的两个声部行（Q1/Q2、Q3/Q4）之间不印歌词，那道缝里只有连音线和线的碎段，
    // 当成歌词行就读出 `////一`、`/a u r` 这类伪歌词（78《马槽歌》下两声部）。
    const pairedGaps: Array<[number, number]> = [];
    for (let i = 0; i + 1 < useRows.length; i++) {
      const r = useRows[i]!, n = useRows[i + 1]!;
      if (r.system === undefined || r.system !== n.system) continue;
      const gapMid = (r.bottomY + n.topY) / 2;
      if (c.barlines.some((k) => k.bbox.y < gapMid - numH * 0.3 && rbottom(k.bbox) > gapMid + numH * 0.3 &&
        r.barlineXs.some((x) => Math.abs(x - rcx(k.bbox)) <= numH * 0.3))) pairedGaps.push([r.bottomY, n.topY]);
    }
    const inPairedGap = (k: Component) => pairedGaps.some(([y0, y1]) => rcy(k.bbox) > y0 && rcy(k.bbox) < y1);
    const lyricComps = comps.filter((k) => !fermataArcs.has(k) && !inBrace(k) && !inPairedGap(k));
    const lr = await recognizeLyrics(bin, lyricComps, useRows, numH, ocr, headerRegions);
    lyricRegions = lr.lyrics.length ? lr.lyrics : undefined;
    chordRegions = lr.chords.length ? lr.chords : undefined;
    // 谱后单独排版的附段（第 2…N 段印成诗行、不跟音符对齐）：照第 1 段的音位骨架填进去。
    // 要排在下面「digit=0 复原」「隐含 tie 补检」之前——两者都看音符有没有词。
    // 多声部谱的歌词只挂在一个声部上（四声部本子夹在第 2、3 声部之间 → 第 2 声部）。别的声部行底下被当成歌词行的
    // 是连音线、小节线碎段、连谱号钩一类（78《马槽歌》读出 `/a u r`、`//一十。十`），按声部整体判：字数不到
    // 词最多那个声部三成的，整声部清掉。
    if (useRows.some((r) => r.voice !== undefined)) {
      const charsOf = (v: number) => useRows.filter((r) => r.voice === v)
        .reduce((a, r) => a + r.nums.reduce((b, n) => b + (n.lyrics ?? []).join("").replace(/[^一-鿿A-Za-z]/g, "").length, 0), 0);
      const voices = [...new Set(useRows.map((r) => r.voice!))];
      const best = Math.max(...voices.map(charsOf));
      for (const v of voices) {
        if (charsOf(v) >= best * 0.3) continue;
        probe("lyrics.voiceNoise");
        for (const r of useRows) if (r.voice === v) { for (const n of r.nums) delete n.lyrics; delete r.lyricLabels; }
      }
    }
    const st = await recognizeTrailingStanzas(bin, useRows, numH, ocr, lyricRegions);
    if (st.length) stanzaRegions = st;
    // 参照歌词互证：各段歌词都落位之后、弧裁决与「有词的 0」复原之前——补上的字要喂给那几步。
    // 演唱顺序要从反复/房号/跳转推，那些此时都已认完；页眉字段也已定（拍号决定小节时值）。
    if (opts.refLyrics) {
      lyricCheck = await applyRefLyrics({ key: "C", fifths, beats, beatType, meters, rows: useRows, number, title },
        opts.refLyrics, lr.hooks);
    }
    // 弧配音两可的（整体右偏的弧），等各段歌词都落位后按一字多音的形裁决。
    resolveSlurRefits(slurRefits);
    // 复核歌词字（再跑一遍逐字候选，费时）：`review: false` 时不做（批量回归、只要文本的命令行）
    if (opts.review !== false) await markLyricDoubts(useRows, lr.hooks);
  }
  {
    const verses = Math.max(0, ...useRows.flatMap((r) => r.nums.map((n) => n.lyrics?.length ?? 0)));
    if (verses > 1) probe("lyrics.multiVerse");
    if (chordRegions) probe("chords");
  }

  // 房内的歌词**不按房号迁段**：段号（W1/W2…）只表示排版——词印在第几行就是第几段，与第几遍唱无关。
  // 房下只印一行词就留在 W1（沧海一声笑 `[4`「一襟晚照」、1811《心愿》同行的 `[2`）；
  // 「第几遍唱哪行词」交给演唱顺序层（`score/playorder.ts`）去推。

  // digit=0 误判复原（取数字候选排序里首个非零值）。两条独立线索，任一命中即复原：
  //  ① 休止符不带歌词，故「digit=0 却对齐到歌词」几乎必是退化字形被 CTC 误判成空白→默认 0；
  //  ② 简谱 "0" 是空心环、从不带斜线；「digit=0 却中央横带占满」= 糊死的 "3" 等被读成"内含斜线的 0"。
  if (ocr.rankDigits) {
    const bad: JpNum[] = [];
    for (const r of useRows) for (const n of r.nums) {
      if (n.digit !== 0) continue;
      const alignedToLyric = n.lyrics?.some((s) => s && s.trim());
      const notHollowRing = midbandInk(bin, n.bbox) >= 0.65 && !midbandHole(bin, n.bbox);
      if (alignedToLyric || notHollowRing) bad.push(n);
    }
    if (bad.length) {
      const ranks = await ocr.rankDigits(bin, bad.map((n) => n.bbox));
      bad.forEach((n, i) => {
        const nz = ranks[i]?.find((d) => d !== 0);
        if (nz !== undefined) { probe("restRestore"); n.digit = nz; }
      });
    }
  }
  // 休止 0 不接附点：尾随休止右侧常有终止线碎块/噪点被误当附点（为基督 r5 末 "0" → 误 "0."）；
  // 简谱附点休止极罕见，休止右侧本就无修饰。放在**复原之后**清零——放在 buildJpNums 里会把
  // 「被误读成 0、复原后是 3」的音符的真附点一并丢掉。
  // 例外：**右侧同一小节里还有音符**的休止，那个点是真附点（`0. 5` 这种附点休止，
  // 714《我说算了吧》第 4、7 谱行各一处）。噪点误判都出在小节末/行末的尾随休止上。
  for (const r of useRows) {
    r.nums.forEach((n, i) => {
      if (n.digit !== 0 || !n.dot) return;
      const next = r.nums[i + 1];
      const sameBar = next && !r.barlineXs.some((x) => x > rright(n.bbox) && x < next.bbox.x);
      if (!sameBar) { probe("restDotClear"); n.dot = 0; }
    });
  }

  // **隐含 tie 补检**：无歌词的音符若与前一个音同音高，就是延音——简谱里同音延续本该有连音线，
  // 但**跨谱行的弧画不出来**（原图上就没有），行内的淡弧也可能漏检。有歌词的音是新音节、不算延音；
  // 纯器乐行（前奏/间奏，整行无词）没有"有无歌词"这条线索，跳过以免把重复音全连成一片。
  // **衬词行同理**：「啦 …… 啦 …… 」这种一行二十来个音只印四个「啦」（其余是省略号，不成字），
  // 有词率两成——和器乐行一样没有线索，却因为"有那么几个字"过了 some() 这道门，行里凡是重复音
  // 都被连成延音（沧海一声笑末行 `1_ 1-` 凭空多一条 tie）。改看**有词率**：低于四成即视同无词行。
  {
    const flat: { n: JpNum; rowHasLyrics: boolean }[] = [];
    for (const row of useRows) {
      const withLyric = row.nums.filter((n) => n.lyrics?.some((t) => t && t.trim())).length;
      const has = row.nums.length > 0 && withLyric / row.nums.length >= 0.4;
      for (const n of row.nums) flat.push({ n, rowHasLyrics: has });
    }
    // **圆滑线里面不补**：一字多音的 slur 罩着的同音重复是重新发音，不是延音（1782《祝福新人》`2⌒3 3⌒2`
    // 外面再套一条大弧，两个 3 之间没字，被当延音连上）。前一个音收弧/后一个音起弧、或两音都在一条
    // 还没闭合的 slur 里，都跳过。
    let depth = 0;                                                     // 到 prev 为止还开着的 slur 数
    for (let i = 1; i < flat.length; i++) {
      const cur = flat[i].n, prev = flat[i - 1].n;
      depth = Math.max(0, depth + (prev.slurStart ?? 0) - (prev.slurStop ?? 0));
      if (depth > 0 || prev.slurStop || cur.slurStart) { if (cur.digit === prev.digit && cur.octave === prev.octave) probe("impliedTie.inSlur"); continue; }
      if (!flat[i].rowHasLyrics) continue;
      if (cur.lyrics?.some((t) => t && t.trim())) continue;          // 有词 → 新音节，不是延音
      if (cur.digit === 0 || prev.digit === 0) continue;             // 休止不参与
      if (cur.digit === RHYTHM_DIGIT) continue;                      // 节奏音符无音高，谈不上同音延续
      if (cur.digit !== prev.digit || cur.octave !== prev.octave) continue;
      if (cur.tieStop || cur.slurStop || prev.tieStart || prev.slurStart) continue; // 已有弧
      probe("impliedTie");
      prev.tieStart = true; cur.tieStop = true;
    }
  }

  const dotDiam = dotSizes.length ? median(dotSizes) : undefined;

  return { key: "C", fifths, beats, beatType, meters, meterNote, rows: useRows, number, numberSide, title, subtitle, credits, tempo, tempoBeat, headerRegions, lyricRegions, chordRegions, stanzaRegions, dotDiam, lyricCheck };
}

