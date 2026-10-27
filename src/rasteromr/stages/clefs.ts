// 认一页里的谱号（`recognizeRasterPage` 按顺序调）：行首谱号被切碎的补回、种类按原图再定、高音谱号挂「8」的低八度、行中换谱号。

import { type StaffGroup, type RasterUnit, lineYAt, localLineModel } from "../staffline";
import type { RasterSym } from "../adapt";
import type { Binary, Component, Rect } from "../../omrkit/types";
import { ContourLedger } from "../ledger";
import { isClef, type SmuflName } from "../../staffomr/glyphs";
import type { RasterPage } from "../rasterpage";
import { pastSysLine } from "../barvote";
import { rowHasInk } from "../../omrkit/geom";
import { binSig } from "../prims";
import { sigDistance } from "../../omrkit/glyphdict";
import { MID_CLEF_FROM } from "./shared";

/** **行首谱号被切碎的行**：块图里只剩碎块（低分辨率页上低音谱号右半那道竖弧被抽成竖段抹掉，望十架扫描版 p10 */
export function recoverBrokenLeadClefs(c: {
  groups: StaffGroup[];
  unit: RasterUnit;
  yAt: (g: StaffGroup, k: number, x: number) => number;
  syms: RasterSym[];
  nl: Binary;
  ledger: ContourLedger;
}): void {
  const { groups, unit, yAt, syms, nl, ledger } = c;
  // ── **行首谱号被切碎的行**：块图里只剩碎块（低分辨率页上低音谱号右半那道竖弧被抽成竖段抹掉，望十架扫描版 p10
  // 钢琴右手），`bootstrapClefs` 的尺寸闸一块都过不了，这一行没谱号、沿用默认的高音谱号，整行高十几级。
  // 一个谱号都没认出的行，在去线图上直接取行首窗口里的墨：从左缘往右 `CLEF_WIN_FROM` 格起，逐列有墨就串下去、
  // 空白过 0.4 格停；串出来的够谱号大小，按高度定种类（与 `bootstrapClefs` 兜底同口径）
  for (const g of groups) {
    const sp = unit.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    // 行首窗口：弯、斜的谱行取左缘往右两格处的线位
    const top = yAt(g, 0, left + sp * 2);
    const bot = yAt(g, 4, left + sp * 2);
    if (syms.some((s0) => isClef(s0.code) && s0.box.y < bot && s0.box.y + s0.box.h > top && s0.box.x < left + sp * 4)) continue;
    const y0 = Math.max(0, Math.round(top - sp * 1.5));
    const y1 = Math.min(nl.h - 1, Math.round(bot + sp * 1.5));
    // 这一列算不算有墨：谱线行跳过，墨像素不到 0.35 格的不算（谱号的点、零星残渣）
    // 谱线不按线位跳（斜页上行首的线与整行平均、局部模型都会差出半格到一条，这一段去线图上谱线也常没去干净），
    // 按实测找：左端往右十格里有长过三格横墨的行是谱线行，上下各让一行
    const lineRow = new Set<number>();
    for (let y = y0; y <= y1; y++) {
      let run = 0;
      for (let x = Math.round(left); x < Math.min(nl.w, left + sp * 10); x++) {
        run = nl.data[y * nl.w + x] ? run + 1 : 0;
        if (run > sp * 3) { for (let d = -1; d <= 1; d++) lineRow.add(y + d); break; }
      }
    }
    const colInk = (x: number) => {
      let a = -1, b = -1, n = 0;
      // 「有没有墨」只数谱表带里的（方括号下端的弯钩伸进窗口，在末线下一格：你的信实广大第四行）；上下沿照整个窗口量
      for (let y = y0; y <= y1; y++)
        if (nl.data[y * nl.w + x] && !lineRow.has(y)) {
          if (a < 0) a = y;
          b = y;
          if (y >= top - sp * 0.5 && y <= bot + sp * 0.5) n++;
        }
      return n < sp * 0.35 ? null : [a, b];
    };
    let x = Math.round(left + sp * CLEF_WIN_FROM);
    const xEnd = Math.round(left + sp * 1.5);
    while (x < xEnd && !colInk(x)) x++;
    if (x >= xEnd) continue;
    const xs = x;
    let lastInk = x;
    let ya = Infinity, yb = -Infinity;
    for (; x < Math.min(nl.w, left + sp * 4); x++) {
      const c = colInk(x);
      if (c) { lastInk = x; ya = Math.min(ya, c[0]); yb = Math.max(yb, c[1]); }
      else if (x - lastInk > sp * 0.4) break;
    }
    const box = { x: xs, y: ya, w: lastInk - xs + 1, h: yb - ya + 1 };
    if (box.h < sp * 1.8 || box.w < sp * 0.8 || box.w > sp * 3.2) continue;
    const code: SmuflName = box.h >= sp * 3.8 ? "gClef" : "fClef";
    for (let i = syms.length - 1; i >= 0; i--) {
      const s1 = syms[i].box;
      const cx0 = s1.x + s1.w / 2;
      const cy0 = s1.y + s1.h / 2;
      if (cx0 >= box.x - 1 && cx0 <= box.x + box.w + 1 && cy0 >= box.y - 1 && cy0 <= box.y + box.h + 1) syms.splice(i, 1);
    }
    syms.push({ box, code });
    ledger.claim(box, `clef:${code}`);
  }
}

/** **行首谱号的种类按原图上的墨再定一次** */
export function reclassLeadClefs(c: {
  groups: StaffGroup[];
  unit: RasterUnit;
  syms: RasterSym[];
  raster: RasterPage;
  ledger: ContourLedger;
}): void {
  const { groups, unit, syms, raster, ledger } = c;
  // ── **行首谱号的种类按原图上的墨再定一次** ───────────────────────────────────
  //
  // 上面两路都按「并出来的盒有多高」分高低音，盒一不准就错：手写体刻谱的高音谱号中间那道直笔被抽成竖段，
  // 剩下的碎块只有 3.2 格高，认成低音谱号（是爱 p4 钢琴右手，整行低十二级）；低音谱号按去线图取墨那一路
  // 把方括号下端的弯钩串进来，盒高 5.6 格，认成高音谱号（同页男声行）。
  // 两种谱号在谱表上占的位置是死的：高音谱号从谱表上方一路探到下方，**顶线上方**与**第四、五线之间**都有它的墨；
  // 低音谱号只占上面三格，这两处都是空的。在带谱线的原图上、谱号盒的横向范围里逐行看有没有墨：
  // 两处都有的是高音谱号，两处都没有的是低音谱号，一有一无的（方括号上端的弯钩压在谱号上方、谱号断得只剩半截）不改。
  for (const g of groups) {
    const sp = unit.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    const s0 = syms.find((q) => isClef(q.code) && q.box.y < g.lines[4].y && q.box.y + q.box.h > g.lines[0].y && q.box.x < left + sp * 4);
    if (s0 && s0.code !== "gClef" && s0.code !== "fClef") continue;
    const bin0 = raster.bin;
    // 横向取**谱行左端的固定窗口**（让过系统线，到调号之前），不照第一步给的盒：那个盒可能只是压在系统线上的一块碎块
    //（望十架 p5 低音谱号的盒落在系统线上，竖线上下通着、两段里行行有墨，被改成高音），也可能只罩住谱号的一半
    const base = pastSysLine(bin0, g.lines.map((l) => lineYAt(l, left)), left, sp);
    const xa = Math.max(0, Math.round(base + sp * CLEF_INK_X[0]));
    const xb = Math.min(bin0.w - 1, Math.round(base + sp * CLEF_INK_X[1]));
    // 行首这一段的线位按实测（斜页上与整行平均差得出半格）
    const ys = localLineModel(bin0, g.lines, left, Math.min(bin0.w - 1, left + sp * 12), unit)((xa + xb) / 2);
    const rowInk = (y: number) => rowHasInk(bin0, y, xa, xb);
    const frac = (ya: number, yb: number) => {
      let n = 0;
      let hit = 0;
      for (let y = Math.round(ya); y <= Math.round(yb); y++) {
        n++;
        if (rowInk(y)) hit++;
      }
      return n ? hit / n : 0;
    };
    const above = frac(ys[0] - sp * CLEF_INK_ABOVE[0], ys[0] - sp * CLEF_INK_ABOVE[1]);
    const low = frac(ys[3] + sp * CLEF_INK_LOW[0], ys[4] - sp * CLEF_INK_LOW[1]);
    // 低音谱号那一侧「第四五线之间」的门槛放到四成：粗线的低分辨率页上谱线的毛边探进这一格，量出 0.17~0.33
    //（烛光颂曲几十行低音谱号都落在这一段、判不下来；高音谱号这一格是满的）
    const code: SmuflName | null = above >= CLEF_INK_FULL && low >= CLEF_INK_FULL ? "gClef" : above <= CLEF_INK_NONE && low <= CLEF_INK_LOW_NONE ? "fClef" : null;
    // 认出的「谱号」盒心在谱行左端以左的，是左边的括号（是爱 p2 第三系统，括号上端那块认成低音谱号，真谱号碎在右边、
    // 中段与调号 ♭ 被收成 D5、B4 两个头）：横向挪到行首窗口，下面按新盒清掉压在谱号上的碎符号
    const onBracket = !!s0 && !!code && s0.box.x + s0.box.w / 2 < left;
    if (onBracket) s0!.box = { ...s0!.box, x: xa, w: xb - xa };
    if (!code || (code === s0?.code && !onBracket)) continue;
    if (!s0) {
      // **一个谱号都没认出的行按墨补一个**（谱号被系统线、括号粘住，两路都没出）。低音谱号要另有正面的证据——
      // 上面两格（一二线、二三线之间）都有墨；不然空着的行首也合「两处都没有墨」
      const upper = Math.min(frac(ys[0] + sp * CLEF_INK_LOW[0], ys[1] - sp * CLEF_INK_LOW[1]), frac(ys[1] + sp * CLEF_INK_LOW[0], ys[2] - sp * CLEF_INK_LOW[1]));
      if (code === "fClef" && upper < CLEF_INK_FULL) continue;
      const top = code === "gClef" ? ys[0] - sp * 1.5 : ys[0] - sp * 0.3;
      const bottom = code === "gClef" ? ys[4] + sp * 1.5 : ys[4];
      const box = { x: xa, y: Math.round(top), w: xb - xa, h: Math.round(bottom - top) };
      syms.push({ box, code });
      ledger.claim(box, `clef:${code}`);
      continue;
    }
    s0.code = code;
    // 盒照新种类收放：高音谱号上下沿着墨探出去（碎块别再被认成音符），低音谱号收回谱表里（弯钩不算它的）
    if (code === "gClef") {
      let ya = Math.round(ys[0]);
      while (ya > ys[0] - sp * 2 && (rowInk(ya - 1) || rowInk(ya - 2))) ya--;
      let yb = Math.round(ys[4]);
      while (yb < ys[4] + sp * 2 && (rowInk(yb + 1) || rowInk(yb + 2))) yb++;
      s0.box = { x: s0.box.x, y: Math.min(s0.box.y, ya), w: s0.box.w, h: Math.max(s0.box.y + s0.box.h, yb) - Math.min(s0.box.y, ya) };
    } else {
      const ya = Math.max(s0.box.y, Math.round(ys[0] - sp * 0.3));
      const yb = Math.min(s0.box.y + s0.box.h, Math.round(ys[4]));
      s0.box = { x: s0.box.x, y: ya, w: s0.box.w, h: yb - ya };
    }
    for (let i = syms.length - 1; i >= 0; i--) {
      if (syms[i] === s0) continue;
      const s1 = syms[i].box;
      const cx0 = s1.x + s1.w / 2;
      const cy0 = s1.y + s1.h / 2;
      if (cx0 >= s0.box.x - 1 && cx0 <= s0.box.x + s0.box.w + 1 && cy0 >= s0.box.y - 1 && cy0 <= s0.box.y + s0.box.h + 1) syms.splice(i, 1);
    }
    ledger.claim(s0.box, `clef:${code}`);
  }
}

/** **高音谱号底下挂着「8」的是低八度谱号**（男高音谱号，或带括号的「(8)」） */
export function markOctaveTrebleClefs(c: {
  groups: StaffGroup[];
  unit: RasterUnit;
  syms: RasterSym[];
  raster: RasterPage;
  ledger: ContourLedger;
}): {
  midClefs: Set<RasterSym>;
} {
  const { groups, unit, syms, raster, ledger } = c;
  // ── **高音谱号底下挂着「8」的是低八度谱号**（男高音谱号，或带括号的「(8)」）──────────────
  //
  // 「8」紧贴在谱号尾巴底下，与尾巴连成一串墨：谱号下半那个弯的正下方（`CLEF_8_X`），从底线往下连着有墨的深度
  // 比普通高音谱号的尾巴深出大半格（`CLEF_8_DEPTH`）。歌词、段号离谱表远，与尾巴之间隔着空行，连不上。
  // 带括号的「(8)」是「男声唱时低八度」的可选记号，照低八度读（烛光颂曲首页人声行，用户定：与 GT 同口径）。
  for (const g of groups) {
    const sp = unit.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    const s0 = syms.find((q) => q.code === "gClef" && q.box.y < g.lines[4].y && q.box.y + q.box.h > g.lines[0].y && q.box.x < left + sp * 4);
    if (!s0) continue;
    const bin0 = raster.bin;
    const xa = Math.max(0, Math.round(left + sp * CLEF_8_X[0]));
    const xb = Math.min(bin0.w - 1, Math.round(left + sp * CLEF_8_X[1]));
    // 底线按行首实测：斜着没推平的谱行，整行的线位在行首能差出大半格（烛光颂曲 p5），照它量下探深度全是错的。
    // 模型底线上下一格半里，行首十格内有三格以上横墨的行是谱线行，取最低的那一条
    const bot0 = localLineModel(bin0, g.lines, left, Math.min(bin0.w - 1, left + sp * 12), unit)((xa + xb) / 2)[4];
    // 一条都找不到的（行首被调号挤满）照模型的；最低的那条比模型高出半格以上的不量——那是第四线（底线在行首断了），照它量会多出一格
    let bot = bot0;
    for (let y = Math.round(bot0 + sp * 1.5); y >= Math.round(bot0 - sp); y--) {
      if (y < 0 || y >= bin0.h) continue;
      let run = 0;
      let long = false;
      for (let x = Math.round(left); x < Math.min(bin0.w, left + sp * 10) && !long; x++) {
        run = bin0.data[y * bin0.w + x] ? run + 1 : 0;
        long = run > sp * 3;
      }
      if (long) {
        bot = y;
        break;
      }
    }
    if (bot < bot0 - sp * 0.5) continue;
    const rowInk = (y: number) => rowHasInk(bin0, y, xa, xb);
    // 从底线下半格起往下走，连着有墨（容一行断口）走到哪儿
    let end = Math.round(bot + sp * 0.5);
    for (let y = end, miss = 0; y < bin0.h && miss < 2; y++) {
      if (rowInk(y)) (end = y), (miss = 0);
      else miss++;
    }
    const depth = (end - bot) / sp;
    if (depth < CLEF_8_DEPTH[0] || depth > CLEF_8_DEPTH[1]) continue;
    // 行首这一段里别的高音谱号块（同一个谱号被认了两份的）一并改，下游取最左的那个
    for (const q of syms) if (q.code === "gClef" && q.box.y < g.lines[4].y && q.box.y + q.box.h > g.lines[0].y && q.box.x < left + sp * 4) q.code = "gClef8vb";
    if (s0.box.y + s0.box.h < end) s0.box = { ...s0.box, h: end - s0.box.y };
    ledger.claim(s0.box, "clef:gClef8vb");
  }
  /** 行中换谱号那一路验过的谱号（其余行中的谱号在建页前剔掉）。 */
  const midClefs = new Set<RasterSym>();
  return { midClefs };
}

/** **行中换谱号**（小一号的谱号，印在小节中间或小节线前） */
export function findMidClefChanges(c: {
  nl: Binary;
  syms: RasterSym[];
  unit: RasterUnit;
  blobs: Component[];
  claimed: Set<number>;
  groups: StaffGroup[];
  yAt: (g: StaffGroup, k: number, x: number) => number;
  midClefs: Set<RasterSym>;
  ledger: ContourLedger;
}): void {
  const { nl, syms, unit, blobs, claimed, groups, yAt, midClefs, ledger } = c;
  // ── **行中换谱号**（小一号的谱号，印在小节中间或小节线前）──────────────────
  //
  // 钢琴右手下行时临时换成低音谱号（望十架 p9 m65，1.6×2.5 格，行首的是 2.25×3.5 格），
  // 行首那一路只在谱行开头四格里找，行中的一律没人认；音高仍按行首谱号读，整段差十二级。
  // 谱表里、离行首 `MID_CLEF_FROM` 格以外、尺寸像小一号谱号的块，拿本页行首的谱号比（宽高比、签名距离）；
  // 低音谱号还要右边 0.9 格内有小点（它那两个点）佐证。认出来的盒里、连同右边两个点，字典结果作废
  {
    // 模板取**本页行首认出的谱号**：字典里的谱号模板来自别的字体（低音谱号 2.84×3.34 格），
    // 这份谱的低音谱号窄高（2.25×3.49 格），缩放多少都配不上；本页自己的谱号与行中那个同一套字形
    //（望十架 p9：对本页低音谱号 75~96，对高音谱号 220 以上）
    const inkFrac = (r: Rect) => {
      let n = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) n += nl.data[y * nl.w + x];
      return n / Math.max(1, r.w * r.h);
    };
    const pageClefs = syms.filter((s0) => isClef(s0.code)).map((s0) => ({ code: s0.code, aspect: s0.box.w / s0.box.h, sig: binSig(nl, s0.box), fill: inkFrac(s0.box) }));
    const sp = unit.space;
    for (const c of blobs) {
      if (claimed.has(c.id)) continue;
      const b = c.bbox;
      const cy = b.y + b.h / 2;
      const bx = b.x + b.w / 2;
      const g = groups.find((q) => cy > yAt(q, 0, bx) - sp && cy < yAt(q, 4, bx) + sp);
      if (!g) continue;
      if (b.x < Math.max(...g.lines.map((l) => l.left)) + sp * MID_CLEF_FROM) continue;
      const w = b.w / sp;
      const h = b.h / sp;
      // 位置也要像：高音谱号上下都探出谱表（尾巴探到末线下 0.7 格以外，八分和弦的头只到半格）；低音谱号落在谱表里、顶端贴着首线
      //（加线上的两个头连着干和尾，签名离高音谱号也近：你的信实广大 m?，整个在谱表上方）
      const top = yAt(g, 0, bx);
      const bot = yAt(g, 4, bx);
      const fShape = w >= 1.2 && w <= 2.0 && h >= 2.0 && h <= 3.0 && Math.abs(b.y - top) <= sp * 0.5 && b.y + b.h <= bot + sp * 0.5;
      const gShape = w >= 1.3 && w <= 2.4 && h >= 3.6 && h <= 5.8 && b.y <= top - sp * MID_CLEF_G_TOP && b.y + b.h >= bot + sp * 0.7;
      if (!fShape && !gShape) continue;
      // 高音谱号是细笔画：横向连着一格以上墨的行不过两成。叠置的实心和弦带干，宽高、签名、墨占比都像（是爱 p3 m32 B♭4/D5/F5 读成行中高音谱号）
      if (gShape) {
        let wide = 0;
        for (let y = b.y; y < b.y + b.h; y++) {
          let run = 0, best = 0;
          for (let x = b.x; x < b.x + b.w; x++) best = Math.max(best, (run = nl.data[y * nl.w + x] ? run + 1 : 0));
          if (best >= sp) wide++;
        }
        if (wide > b.h * 0.2) continue;
      }
      const sig = binSig(nl, b);
      let hit: { smufl: SmuflName; dist: number } | null = null;
      // 墨占比也要像：谱号是细笔画；实心头连着干和尾的和弦墨实得多（万古磐石歌 m? 八分二度）
      const fill = inkFrac(b);
      for (const pc of pageClefs) {
        if (Math.abs(pc.aspect - b.w / b.h) > MID_CLEF_ASPECT || Math.abs(pc.fill - fill) > MID_CLEF_FILL) continue;
        const d = sigDistance(pc.sig, sig);
        if (d <= MID_CLEF_DIST && (!hit || d < hit.dist)) hit = { smufl: pc.code as SmuflName, dist: d };
      }
      if (!hit || (hit.smufl === "fClef") !== fShape) continue;
      const dotZone = { x: b.x + b.w, y: b.y, w: Math.round(sp * 0.9), h: Math.round(b.h * 0.6) };
      if (hit.smufl === "fClef") {
        const dots = blobs.filter((d) => d !== c && d.bbox.w <= sp * 0.5 && d.bbox.h <= sp * 0.5 && d.bbox.x >= dotZone.x - 2 && d.bbox.x <= dotZone.x + dotZone.w && d.bbox.y + d.bbox.h / 2 >= dotZone.y && d.bbox.y + d.bbox.h / 2 <= dotZone.y + dotZone.h);
        if (!dots.length) continue;
        for (const d of dots) claimed.add(d.id);
      }
      const zone = { x: b.x, y: b.y, w: b.w + (hit.smufl === "fClef" ? dotZone.w : 0), h: b.h };
      for (let i = syms.length - 1; i >= 0; i--) {
        const s0 = syms[i].box;
        const cx0 = s0.x + s0.w / 2;
        const cy0 = s0.y + s0.h / 2;
        if (cx0 >= zone.x - 1 && cx0 <= zone.x + zone.w + 1 && cy0 >= zone.y - 1 && cy0 <= zone.y + zone.h + 1) syms.splice(i, 1);
      }
      claimed.add(c.id);
      const cs: RasterSym = { box: b, code: hit.smufl };
      midClefs.add(cs);
      syms.push(cs);
      ledger.claim(zone, `clef:${hit.smufl}`);
    }
  }
}
/** 行首谱号被切碎的行：取墨窗口从谱行左缘往右几格起（让过系统线）。 */
const CLEF_WIN_FROM = 0.5;
/** 行首谱号按墨定种类：顶线上方那一段（离顶线几格到几格）、第四五线之间那一段（各让开线几格）。 */
const CLEF_INK_ABOVE = [1.0, 0.35];
/** 取墨的横向窗口：离谱行左端几格到几格（谱号约占 0.5~3.2 格，调号从 3.5 格上下起）。 */
const CLEF_INK_X = [0.6, 3.0];
const CLEF_INK_LOW = [0.3, 0.25];
/** 这两段里有墨的行占到几成算「有」、不到几成算「没有」。 */
const CLEF_INK_FULL = 0.6;
/** 低八度谱号的「8」：横向窗口（离谱行左端几格）、谱号尾巴那一段与「8」下半那一段（离底线几格）。 */
const CLEF_8_X = [1.3, 2.6];
/** 谱号从底线往下连着探出多少格算挂着「8」：普通高音谱号的尾巴 1.6~1.9 格，挂着「8」的 2.5~3.1 格（烛光颂曲实测）。 */
const CLEF_8_DEPTH = [2.35, 3.4];
const CLEF_INK_NONE = 0.15;
/** 判低音谱号时第四五线之间那一段「没有」的门槛（比 `CLEF_INK_NONE` 松，见用处）。 */
const CLEF_INK_LOW_NONE = 0.4;
/** 行中换谱号：与本页行首谱号的宽高比差上限、签名距离上限。 */
/** 行中的高音谱号顶端至少探出首线这么多格（小一号的只探出 0.4 格上下：望十架 p10 量得 0.43）。 */
const MID_CLEF_G_TOP = 0.3;
const MID_CLEF_ASPECT = 0.15;
const MID_CLEF_DIST = 130;
const MID_CLEF_FILL = 0.08;
