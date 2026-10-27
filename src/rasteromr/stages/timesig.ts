// 认一页里的拍号（`recognizeRasterPage` 按顺序调）：位置自举 + 模板验。

import { RasterGlyphLookup, matchTemplate } from "../rasterglyphs";
import { type RasterUnit, type StaffGroup, lineYAt } from "../staffline";
import type { Binary, Component, Rect } from "../../omrkit/types";
import type { RasterSym } from "../adapt";
import type { RasterPage } from "../rasterpage";
import { ContourLedger } from "../ledger";
import { type TimeStrip, timeStripOf, timeDigit, timeKey, closedHoles } from "../timesig";
import type { TimeColumn } from "../clefmeter";
import { timeSigDigit, type SmuflName, isClef, isAccidental } from "../../staffomr/glyphs";
import { binSig } from "../prims";
import { sigDistance } from "../../omrkit/glyphdict";
import type { RasterPageOpts, RasterLiveOcr } from "../recognize";
import { TIME_TEMPLATE_DIST } from "./shared";

/** 压着一个全音符的 C 拍号列用的距离上限（见拍号那一段）。 */
const TIME_C_WHOLE_DIST = 240;
/** 按角色限定认拍号数字（见拍号那一段）：分子只在 2~9 里挑，分母只在 2、4、8 里挑。
 *  距离上限：万古磐石歌的铅字「3」到 `timeSig3` 186/214，齐来谢主歌分母「4」181/230，
 *  万古磐石歌分母「4」246/275（去线切得最狠）。 */
const NUM_DIGITS = [2, 3, 4, 5, 6, 7, 8, 9] as const;
const DEN_DIGITS = [2, 4, 8] as const;
const TIME_NUM_DIST = 230;
const TIME_DEN_DIST = 300;
/** 分子读成 4 时的复核（见拍号那一段）：分子到分母 4 的签名距离过这个数，
 *  且别的数字在 `TIME_ALT_DIST` 以内，就改认那个数字。 */
const TIME_SELF_DIST = 215;
const TIME_ALT_DIST = 265;
/** 派生的「9」要比别的数字近出这么多才采信（见 `digitOf`）。 */
const NINE_MARGIN = 30;

/** 拍号：位置自举 + 模板验 */
export async function findTimeSigs(c: {
  look: RasterGlyphLookup;
  unit: RasterUnit;
  nl: Binary;
  opts: RasterPageOpts;
  live: RasterLiveOcr | undefined;
  syms: RasterSym[];
  groups: StaffGroup[];
  blobs: Component[];
  claimed: Set<number>;
  restIds: Set<number>;
  harmonyIds: Set<number>;
  titleIds: Set<number>;
  splitIds: Set<number>;
  merged: Set<number>;
  dictClaimed: Set<number>;
  raster: RasterPage;
  ledger: ContourLedger;
}): Promise<{
  timeStrips: TimeStrip[];
  timeCols: TimeColumn[];
}> {
  const { look, unit, nl, opts, live, syms, groups, blobs, claimed, restIds, harmonyIds, titleIds, splitIds, merged, dictClaimed, raster, ledger } = c;
  // ── 拍号：位置自举 + 模板验 ────────────────────────────────────────────────
  //
  // 字典里**一个拍号类都没有**（`rasterglyphs.json` 4144 个类未定名，拍号一个没定），
  // 所以拍号的识别率是 0——全语料一个都没认出来。这批曲子恰好都是 4/4、
  // 下游按缺省当 4/4 办，所以没露馅；换一首 3/4 的就整首错。
  //
  // 拍号数字还被自己的笔画切开（「4」的竖笔横向游程短，被当竖笔画抽走），
  // 按连通块查必然是碎的——实测宁静 p1 那个 4/4 切成 1.60×2.76 与 1.60×1.71
  // 两个**互相重叠**的盒。所以照谱号那条路走：先按位置圈出候选、
  // 把碎块并回上下两个盒，再拿模板签名验。
  /** 拍号数字模板，外加由「6」转 180° 派生的「9」（Maestro 那本没出现过 9，字形上 9 就是倒过来的 6）。 */
  const digitTpl = (look.templates ?? []).filter((t) => timeSigDigit(t.smufl) >= 0);
  digitTpl.push(...digitTpl.filter((t) => t.smufl === "timeSig6").map((t) => ({ ...t, smufl: "timeSig9" as SmuflName, sig: t.sig.slice().reverse() })));
  /** 在 `allowed` 这几个数字里取签名最近的；尺寸只卡高度（宽度随字体差得多，签名按长边归一、不拉伸）。 */
  const digitOf = (b: Rect, allowed: readonly number[], maxDist: number): RasterSym | null => {
    const h = b.h / unit.space;
    const sig = binSig(nl, b);
    let best: { code: SmuflName; d: number } | null = null;
    let bestNot9: { code: SmuflName; d: number } | null = null;
    for (const t of digitTpl) {
      if (!allowed.includes(timeSigDigit(t.smufl)) || Math.abs(t.h - h) > 0.2 + 0.12 * t.h) continue;
      const d = sigDistance(t.sig, sig);
      if (d > maxDist) continue;
      if (!best || d < best.d) best = { code: t.smufl, d };
      if (t.smufl !== "timeSig9" && (!bestNot9 || d < bestNot9.d)) bestNot9 = { code: t.smufl, d };
    }
    // 派生的「9」不是真字形，要**明显**近过别的数字才采信：万古磐石歌的铅字「3」上头带个球，
    // 到 9 是 179、到 3 是 186，几乎打平；晨曦破晓真的 9 是 139 对 240。
    if (best?.code === "timeSig9" && bestNot9 && bestNot9.d - best.d < NINE_MARGIN) best = bestNot9;
    return best && { box: b, code: best.code };
  };
  // **第二趟：照同页已认出的拍号补缺**（Audiveris `TimeColumn`：一个系统里每行谱的拍号必须同值）。
  // 缺拍号的那行，允许已被符头那几路认领的块（休止、和弦字母除外）进候选（Audiveris 先认行首段、再找符头；
  // 我们的顺序反过来，粗体 4/4 一整块被并块拆分那一路拆成两个黑头——《欢然颂主》高音谱表），
  // 但只认与已认出的拍号**同值、x 对齐**（1.5 格内）的那一对；认中了，盒里的假头随下面「盖过字典」一并删掉。
  const timeStrips: TimeStrip[] = [];
  /** 在线时逐列现读（只读头一趟、谱号列以外的那几条，与离线缓存收的条一致）；第二趟只查已读的 */
  const timeOcr = opts.timeOcr ?? (live?.time ? new Map<string, string>() : undefined);
  /** 行首每个「两个数字摞起来」形状的候选列（谱号那一列除外）与 OCR 读出的上下半，留给 `shareTimeSignature` 按系统互证。 */
  const timeCols: TimeColumn[] = [];
  const clefBoxes = syms.filter((s0) => isClef(s0.code)).map((s0) => s0.box);
  const timeFound: { x: number; codes: string }[] = [];
  const timeDone = new Set<(typeof groups)[number]>();
  // **C 拍号被当成全音符**：粗体 C 上半截的球头垂下来碰到第三线，围出一块白，被内腔那一路收成全音符
  //（有一位神第一行，C 读成 C♯5 全音符）。这样的列 C 模板的距离上限放宽一档（那个 C 到模板 225）：
  // 两格多高、骑在中线上、里头又压着个全音符的，行首只有 C 拍号
  const wholes = syms.filter((s0) => s0.code === "noteheadWhole").map((s0) => s0.box);
  for (const pass of [0, 1])
  for (const g of groups) {
    if (timeDone.has(g) || (pass === 1 && !timeFound.length)) continue;
    const left = Math.max(...g.lines.map((l) => l.left));
    // 拍号在行首那一小段：弯、斜的谱行取行首往右四格处的线位
    const ax = left + unit.space * 4;
    const mid = lineYAt(g.lines[2], ax);
    const top = lineYAt(g.lines[0], ax);
    const bottom = lineYAt(g.lines[4], ax);
    // 行首那一段：谱号 + 调号之后、第一个音符之前。放到十四格——
    // 七个升降号的调号就占了八格多。
    // **字典认走的也进来**（谱号与调号升降号除外）：C 拍号与字典里那个
    // `csymParensRightTall`（大括号）形状相近，认错了照样要能被拍号盖过。
    const cands = blobs.filter((c) => {
      const b = c.bbox;
      // 并块拆分认领的块第一趟就进来：4/4 两个数字连成一块，被拆成两个黑头（齐来崇拜第一行：本页头模板一变就拆了）。
      // 数字那一路按位置切上下两半、各配模板，真的两个叠头配不上数字
      // 第二趟按已认出的 C 拍号找时，被当成休止认领的块也进来：粗体 C 常被认成四分休止（S253 钢琴两行）
      const cFound = timeFound.some((t) => t.codes === "timeSigCommon" || t.codes === "timeSigCutCommon");
      if ((claimed.has(c.id) && !(pass === 1 && (!restIds.has(c.id) || cFound) && !harmonyIds.has(c.id) && !titleIds.has(c.id)) && !splitIds.has(c.id)) || merged.has(c.id)) return false;
      const dc = dictClaimed.has(c.id) ? look.lookup(binSig(nl, b), b.w / unit.space, b.h / unit.space) : null;
      if (dc && (isClef(dc) || isAccidental(dc))) return false;
      if (b.x < left || b.x > left + unit.space * 14) return false;
      if (pass === 1 && !timeFound.some((t) => Math.abs(t.x - b.x) <= unit.space * 1.5)) return false;
      return b.y + b.h > top - unit.space * 0.5 && b.y < bottom + unit.space * 0.5;
    });
    // 按 x 聚成**若干列**，逐列去试。
    //
    // 只试最左那一列不行：行首除了拍号还有谱号被切下来的碎块、调号里字典没认出的
    // 升降号，最左那一列往往是它们（实测你要等候 p2 最左是谱号的下半截，
    // 真正的 C 拍号在它右边两列开外）。
    //
    // 容一点缝（0.4 格）：C 拍号被自己的笔画切成好几块，块与块之间差几个像素
    //（实测破碎 p2 那个 C 切成 0.76×2.16 / 0.64×0.93 / 0.58×0.12 / 0.41×0.58）。
    cands.sort((a, b) => a.bbox.x - b.bbox.x);
    const cols: { box: Rect; ids: number[]; ink?: boolean }[] = [];
    for (const c of cands) {
      const b = c.bbox;
      const last = cols[cols.length - 1];
      if (last && b.x <= last.box.x + last.box.w + unit.space * 0.4) {
        const x0 = Math.min(last.box.x, b.x);
        const y0 = Math.min(last.box.y, b.y);
        last.box = { x: x0, y: y0, w: Math.max(last.box.x + last.box.w, b.x + b.w) - x0, h: Math.max(last.box.y + last.box.h, b.y + b.h) - y0 };
        last.ids.push(c.id);
      } else cols.push({ box: { ...b }, ids: [c.id] });
    }
    // **墨列**（只给 OCR 用）：粗体小号数字的笔画整根被当竖段抽走，连通块里只剩几粒碎屑，上面按块聚不出列
    //（新编赞美诗 151、121：行首 4/4 一块都没有）。回去线图上按列投影找：谱号右边、谱表带里一段连续有墨的 x，
    // 宽 0.8~2.5 格、上下正好撑满谱表的，就是「两个数字摞起来」的样子。与按块聚出的列重叠的不重复出
    if (pass === 0) {
      const clefR = Math.max(left, ...clefBoxes.filter((cb) => cb.y < bottom && cb.y + cb.h > top && cb.x < left + unit.space * 6).map((cb) => cb.x + cb.w));
      const yA = Math.max(0, Math.round(top - unit.space * 0.25)), yB = Math.min(nl.h, Math.round(bottom + unit.space * 0.25));
      const xEnd = Math.min(nl.w, Math.round(left + unit.space * 14));
      const inkAt = (x: number) => {
        let n = 0;
        for (let y = yA; y < yB; y++) if (nl.data[y * nl.w + x]) n++;
        return n >= 2;
      };
      const gap = Math.max(2, Math.round(unit.space * 0.2));
      let x0 = -1, lastInk = -1;
      const flush = () => {
        if (x0 < 0) return;
        const b: Rect = { x: x0, y: yA, w: lastInk - x0 + 1, h: yB - yA };
        if (b.w >= unit.space * 0.8 && b.w <= unit.space * 2.5 && !cols.some((c) => Math.min(c.box.x + c.box.w, b.x + b.w) - Math.max(c.box.x, b.x) > b.w * 0.5)) cols.push({ box: b, ids: [], ink: true });
        x0 = -1;
      };
      for (let x = Math.round(clefR) + 1; x < xEnd; x++) {
        if (inkAt(x)) {
          if (x0 < 0) x0 = x;
          lastInk = x;
        } else if (x0 >= 0 && x - lastInk > gap) flush();
      }
      flush();
      cols.sort((a, b) => a.box.x - b.box.x);
    }
    // 本页已认出过拍号的，与它竖直对齐（1.5 格内）的列先试：同一系统各行的拍号上下对齐，行首调号的碎块聚成的列在它左边，
    // 按从左到右先试会先撞上（新编 f03 低音行四个降号的碎块撑满谱表，OCR 读成 7/2，后面对齐的 4/4 没轮到，整首拍号读错）
    if (timeFound.length) {
      const aligned = (c: (typeof cols)[number]) => (timeFound.some((t) => Math.abs(t.x - c.box.x) <= unit.space * 1.5) ? 1 : 0);
      cols.sort((a, b) => aligned(b) - aligned(a) || a.box.x - b.box.x);
    }
    /** 这一段 x 上的墨是不是「上下正好撑满谱表」：顶到第五线、底到第一线，又不探出谱表（带干的和弦、谱号都探出去）。 */
    const fillsStaff = (b: Rect): boolean => {
      const xa = Math.max(0, Math.round(b.x)), xb = Math.min(nl.w, Math.round(b.x + b.w));
      const ya = Math.max(0, Math.round(top - unit.space * 1.5)), yb = Math.min(nl.h, Math.round(bottom + unit.space * 1.5));
      // 只量**与中线连着的那一段**墨：去线留下的缝（一个线宽加两像素）算连着，隔开更远的不算——
      // 拍号正上方挨着速度术语（美哉主耶稣「Moderately」压在 12/8 上方不到一格），一并量进来就判成探出谱表
      const inkRow = (y: number) => {
        let n = 0;
        for (let x = xa; x < xb; x++) if (nl.data[y * nl.w + x]) n++;
        return n >= 2;
      };
      // 内侧三条线那几行（按 x 取线位）不算缝：去线的缝正落在线上，宽度跟着去线的口径走，只容「线宽 + 2」时
      // 线宽量成 3 的页上两个数字在中线处就断开（新编 257 低音行 2/2，整首拍号读成 2/4）。
      // 外线不放：跨过外线就连上谱表外的墨，判成探出谱表（353 首行 4/4 没了）
      const gapMax = Math.ceil(unit.lineThick) + 2;
      const lys = g.lines.slice(1, 4).map((l) => lineYAt(l, b.x + b.w / 2));
      const lineRow = (y: number) => lys.some((ly) => Math.abs(ly - y) <= unit.lineThick + 1);
      const walk = (from: number, step: 1 | -1, end: number) => {
        let last = -1;
        for (let y = from, gap = 0; step > 0 ? y < end : y >= end; y += step) {
          if (inkRow(y)) (last = y), (gap = 0);
          else if (lineRow(y)) continue;
          else if (last >= 0 && ++gap > gapMax) break;
        }
        return last;
      };
      const m0 = Math.round(mid);
      const lo = walk(m0, -1, ya), hi = walk(m0, 1, yb);
      if (lo < 0 || hi < 0) return false;
      return lo >= top - unit.space * 0.4 && hi <= bottom + unit.space * 0.4 && lo <= top + unit.space * 0.6 && hi >= bottom - unit.space * 0.6;
    };
    for (const col of cols) {
      const box = col.box;
      // 两位数的分子（12/8）一列宽近三格：放到 `TIME_WIDE` 格，但超过 2.5 格的只认 OCR 读出两位数分子的（美哉主耶稣 12/8 宽 2.87 格，
      // 整页没认出拍号、数字的笔画被补成符头）
      const wide = box.w > unit.space * 2.5;
      if (box.w > unit.space * TIME_WIDE || box.w < unit.space * 0.8) continue;
      // 距离上限比通用的 `TEMPLATE_DIST`（90）松：拍号被**五条谱线横穿**，
      // 去线在它身上切了好几道口子，退化比谱号重（实测宁静那个 4/4 上下两半
      // 到 `timeSig4` 是 104 与 95，破碎那个 C 到 `timeSigCommon` 是 168）。
      // 松得起，是因为位置先验很硬：行首那一列、骑在中线上、高约两格或四格。
      const tpl = look.templates ?? [];
      const hits: RasterSym[] = [];
      let fromOcr = false;
      if (box.h < unit.space * 3) {
        if (col.ink || wide) continue;
        // **C 拍号**（`timeSigCommon` / `timeSigCutCommon`）是一个块、骑在中线上
        if (Math.abs(box.y + box.h / 2 - mid) > unit.space * 0.8) continue;

        const whole = box.h >= unit.space * 1.8 && wholes.some((w) => w.x >= box.x - 1 && w.x + w.w <= box.x + box.w + 1 && w.y >= box.y - 1 && w.y + w.h <= box.y + box.h + 1);
        // 放宽时只在 C 模板里挑：别的模板（和弦字母、休止）在宽上限下反倒更近
        const cTpl = tpl.filter((t) => t.smufl === "timeSigCommon" || t.smufl === "timeSigCutCommon");
        let m = whole ? matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, cTpl, TIME_C_WHOLE_DIST) : matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, tpl, TIME_TEMPLATE_DIST);
        // 衬线粗体的 C（球形笔端，哈利路亚哈利路亚 S253）离 C 模板 259，过不了闸；可所有模板里最近的就是它。
        // 紧骑中线（0.3 格内）、高约两格的，最近的是 C 又在 `TIME_C_LOOSE` 以内就认
        if (!m && Math.abs(box.y + box.h / 2 - mid) <= unit.space * 0.3 && box.h >= unit.space * 1.6 && box.h <= unit.space * 2.6) {
          const near = matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, tpl, TIME_C_LOOSE);
          if (near && (near.smufl === "timeSigCommon" || near.smufl === "timeSigCutCommon")) m = near;
        }
        if (m && (m.smufl === "timeSigCommon" || m.smufl === "timeSigCutCommon")) hits.push({ box, code: m.smufl });
      } else {
        // **两个数字摞起来**：按中线几何切开，不按碎块自己的位置分上下半
        // ——碎块的盒互相重叠（实测上半那块高 2.76 格、已经探进下半的地界）。
        // 拍号的版式是死的：上面那个坐在第五线到第三线之间、下面那个第三线到第一线。
        // 上下各截到谱表外 0.25 格：数字夹在第一线与第五线之间，列里并进来的谱表外杂点
        // 会把半边拉高、过不了数字的高度闸（《耶和华是我的牧者》第一行顶上多出 0.43 格）
        const y0 = Math.max(box.y, Math.round(top - unit.space * 0.25));
        const y1 = Math.min(box.y + box.h, Math.round(bottom + unit.space * 0.25));
        const up: Rect = { x: box.x, y: y0, w: box.w, h: Math.round(mid) - y0 };
        const dn: Rect = { x: box.x, y: Math.round(mid), w: box.w, h: y1 - Math.round(mid) };
        if (up.h < unit.space || dn.h < unit.space) continue;
        // **数字先问 OCR**：两半各出一条，按内容指纹查缓存；上下都读成合法数字才采信，否则走下面模板那一路
        // 谱号那一列不问：低音谱号的碎块（弧 + 两点）会被读成「7:」「2」之类
        // 也不问没撑满谱表、或探出谱表的列：带干的和弦读得出「5」「2」（新编赞美诗 121 头一个八分和弦读成 5/2）
        const inClef = clefBoxes.some((cb) => cb.y < bottom && cb.y + cb.h > top && box.x + box.w / 2 < cb.x + cb.w) || !fillsStaff(box);
        // 压线笔画补回的那条（`timeStripOf` 的 `raw`）只给下面「模板认出一对、OCR 只读出一半」那一步兜底：去线条读不出的
        //（「9」读成「0」、「6」「3」读空）问它。不让它单独成对采信——行首的和弦列补了线也读得成一对数字（373 低音行读出 5/2），
        // 补线还会把「3」左侧压线的开口封上、读成「8」（万口欢唱 3/2）
        const reach = Math.ceil(unit.lineThick) + 2;
        const sUp = timeStripOf(nl, up, groups.indexOf(g), "num");
        const sDn = timeStripOf(nl, dn, groups.indexOf(g), "den");
        const fUp = timeStripOf(nl, up, groups.indexOf(g), "num", raster.bin, reach);
        const fDn = timeStripOf(nl, dn, groups.indexOf(g), "den", raster.bin, reach);
        if (pass === 0 && !inClef && !opts.timeOcr && live?.time && timeOcr) for (const [k, v] of await live.time([sUp, sDn, fUp, fDn])) timeOcr.set(k, v);
        // 分子 3 与 8 OCR 分不开（低清图上 3 左侧的开口被糊墨封上读成 8），按有没有封闭孔定（`closedHoles`）
        const ocrNum = inClef ? null : timeDigit(timeOcr?.get(timeKey(sUp)), "num");
        let oNum = ocrNum === 3 || ocrNum === 8 ? (closedHoles(sUp) > 0 ? 8 : 3) : ocrNum;
        // 两位数分子 OCR 读成「1?」却不是合法拍号（美哉主耶稣的 12 读成 19：低清的 2 像 9）：右半个数字按模板在 0、2、5、6 里认
        const rawNum = timeOcr?.get(timeKey(sUp));
        if (wide && oNum === null && !inClef && rawNum && /^1\d$/.test(rawNum)) {
          const d = digitOf({ x: Math.round(up.x + up.w / 2), y: up.y, w: Math.round(up.w / 2), h: up.h }, [0, 2, 5, 6], TIME_NUM_DIST);
          if (d) oNum = timeDigit(String(10 + timeSigDigit(d.code)), "num");
        }
        const oDen = inClef ? null : timeDigit(timeOcr?.get(timeKey(sDn)), "den");
        const fNum = inClef ? null : oNum ?? timeDigit(timeOcr?.get(timeKey(fUp)), "num");
        const fDen = inClef ? null : oDen ?? timeDigit(timeOcr?.get(timeKey(fDn)), "den");
        if (pass === 0 && !inClef) {
          timeStrips.push(sUp, sDn, fUp, fDn);
          timeCols.push({ box, mid, num: oNum, den: oDen });
        }
        if (wide && !(oNum !== null && oNum >= 10 && oDen !== null)) continue;
        if (oNum !== null && oDen !== null) {
          // 两位数（12、16）拆成左右两个数字符号：下游按 x 从左到右拼数（`timeSignatures`）
          const digitsOf = (n: number, b: Rect): RasterSym[] => {
            const ds = String(n).split("");
            const w = b.w / ds.length;
            return ds.map((d, k) => ({ box: { x: Math.round(b.x + k * w), y: b.y, w: Math.round(w), h: b.h }, code: `timeSig${d}` as SmuflName }));
          };
          hits.push(...digitsOf(oNum, up), ...digitsOf(oDen, dn));
          fromOcr = true;
        } else if (!col.ink) {
        const two = [up, dn].map((b) => {
          const m = matchTemplate(binSig(nl, b), b.w / unit.space, b.h / unit.space, tpl, TIME_TEMPLATE_DIST);
          return m && timeSigDigit(m.smufl) >= 0 ? { box: b, code: m.smufl } : null;
        });
        // **分子至少是 2**：1/x 的拍号谱面上不出现，出现只说明两个数字都是硬凑上的
        // ——旧字体（《善牧恩慈歌》那种铅字本）的「4」只有 1.1 格宽，过不了 `timeSig4`
        // 模板的宽度闸，却以 141/166 的距离过了放宽到 180 的 `timeSig1`，整首读成 1/1。
        // 拒掉之后下游按缺省拍号办，比错成 1/1 强得多（1/1 让每个四分音符都「满小节」）。
        // 分母同理只认 2、4、8：齐来谢主歌放大后分母「4」到 `timeSig1` 170、到 `timeSig4` 181，读成 4/1。
        if (two[0] && two[1] && timeSigDigit(two[0].code) >= 2 && (DEN_DIGITS as readonly number[]).includes(timeSigDigit(two[1].code))) hits.push(two[0], two[1]);
        else {
          // **按角色限定再认一次**：别的书的数字字形与 Maestro 差得远（万古磐石歌、齐来谢主歌的
          // 铅字「3」「4」只有 1.1~1.2 格宽，模板 1.5~1.6 格），过不了尺寸闸，最近的又总是
          // 一根竖笔的 `timeSig1`。可位置先验已经钉死了这两格里是什么：分子是 2~9，
          // 分母只有 2、4、8。于是只在合法的数字里取最近、尺寸只卡高度；分子认得出才认分母，
          // 分母再放宽一档（被第二、四线横穿，去线切掉的最多）。
          const num = digitOf(up, NUM_DIGITS, TIME_NUM_DIST);
          const den = num ? digitOf(dn, DEN_DIGITS, TIME_DEN_DIST) : null;
          if (num && den) hits.push(num, den);
        }
        // 模板认出了一对、OCR 只读出其中一半的：那一半听 OCR 的（分母 8 读成 4 是模板最常见的错，OCR 的「8」靠得住）
        if (hits.length === 2 && fNum !== null && fNum < 10) hits[0] = { box: hits[0].box, code: `timeSig${fNum}` as SmuflName };
        if (hits.length === 2 && fDen !== null && fDen < 10) hits[1] = { box: hits[1].box, code: `timeSig${fDen}` as SmuflName };
        }
      }
      if (!hits.length) continue;
      // **分子读成 4 时拿分母复核**：分母那个 4 是同一本同一字号的真 4，分子真是 4 就该长得像它。
      // 模板法分不开的两首（万福泉源歌放大后的「3」到 `timeSig4` 200、到 `timeSig3` 225；
      // 来敬拜荣耀王粗体铅字「3」181 对 244）：分子到分母 232~244，退而求其次的数字 225~256；
      // 真 4/4 那 60 多行分子到分母至多 196、别的数字至少 277。两条都过才改认。
      if (!fromOcr && hits.length === 2 && hits[0].code === "timeSig4" && hits[1].code === "timeSig4" && sigDistance(binSig(nl, hits[0].box), binSig(nl, hits[1].box)) > TIME_SELF_DIST) {
        const alt = digitOf(hits[0].box, NUM_DIGITS.filter((k) => k !== 4), TIME_ALT_DIST);
        if (alt) hits[0] = alt;
      }
      if (pass === 1 && !timeFound.some((t) => t.codes === hits.map((h0) => h0.code).join("/") && Math.abs(t.x - box.x) <= unit.space * 1.5)) continue;
      // 拍号**盖过字典**（与谱号同一条）：落在它盒里的字典结果作废，那是被切开的碎块。
      // 符头按**中心**落在盒里算：「4」下半的三角内腔按孔补成空心头，头盒按头的个头摆、探出拍号盒底（一婴孩为我们降生 男声 m1 多出一个二分音符）
      for (let k = syms.length - 1; k >= 0; k--) {
        const s0 = syms[k].box;
        const cx = s0.x + s0.w / 2, cy = s0.y + s0.h / 2;
        const headIn = syms[k].code.startsWith("notehead") && cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
        if (headIn || (s0.x >= box.x - 1 && s0.x + s0.w <= box.x + box.w + 1 && s0.y >= box.y - 1 && s0.y + s0.h <= box.y + box.h + 1)) syms.splice(k, 1);
      }
      syms.push(...hits);
      for (const hit of hits) ledger.claim(hit.box, `time:${hit.code}`);
      for (const id of col.ids) merged.add(id);
      timeFound.push({ x: box.x, codes: hits.map((h0) => h0.code).join("/") });
      timeDone.add(g);
      break; // 一行谱只有一个拍号
    }
  }
  return { timeStrips, timeCols };
}
/** C 拍号放宽的那一档距离：最近的模板就是 C、又紧骑中线时用。 */
const TIME_C_LOOSE = 280;
/** 拍号列的宽度上限（格）：两位数分子的 12/8 宽近三格。 */
const TIME_WIDE = 3.6;
