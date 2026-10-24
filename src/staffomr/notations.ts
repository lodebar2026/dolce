// 演奏法记号与三连音。移植自 musicpp `qtomr/qomr.cpp::findNotations` / `findTuplet`。
//
// musicpp 到「打标」为止就结束了（它的 toxml.cpp 不导出这些）；
// 「挂到音符上、写进 MusicXML」是本仓新加的。
import { SPage, Seg, Sym, type PObj, type Staff } from "./model";
import type { BeamShape, StaffNote, StemInfo } from "./notedata";
import { objText } from "./textanalyze";
import { isFill, subPaths } from "./vecgeom";

/** 会挂到音符上的记号（SMuFL 名）。力度记号另走 `<direction>`，见 `toxml.ts`。 */
const NOTATION_CODES = new Set([
  "articAccentAbove", "articAccentBelow",
  "articStaccatoAbove", "articStaccatoBelow",
  "articTenutoAbove", "articTenutoBelow",
  "articStaccatissimoAbove", "articStaccatissimoBelow",
  "articMarcatoAbove", "articMarcatoBelow",
  "articAccentStaccatoAbove", "articAccentStaccatoBelow",
  "articTenutoStaccatoAbove", "articTenutoStaccatoBelow",
  "fermataAbove", "fermataBelow",
  "ornamentTrill", "ornamentShortTrill", "wiggleTrill", "wiggleTrillSlow", "wiggleArpeggiatoUp",
  "tremolo1", "tremolo2", "tremolo3",
  "stringsUpBow", "stringsDownBow",
  "breathMarkComma", "caesura",
  "graceNoteSlashStemUp", "graceNoteSlashStemDown",
]);

/** 力度记号：挂到小节上，出 `<direction>`。 */
const DYNAMIC_CODES = new Set([
  "dynamicPiano", "dynamicMezzo", "dynamicForte", "dynamicRinforzando",
  "dynamicSforzando", "dynamicZ", "dynamicNiente",
  "dynamicPP", "dynamicPPP", "dynamicMP", "dynamicMF", "dynamicFF", "dynamicFFF",
]);

/**
 * `Page::findNotations`：把还没归属的乐谱符号里属于「演奏法」的挑出来打标。
 *
 * 原文是一张 switch 白名单，这里换成两张集合（`NOTATION_CODES` / `DYNAMIC_CODES`）
 * ——判据一样，只是加新记号时不必再动控制流。
 */
export function findNotations(pg: SPage): { marks: Sym[]; dynamics: Sym[] } {
  const marks: Sym[] = [];
  const dynamics: Sym[] = [];
  for (const s of pg.symbols) {
    if (s.hasAnyTag()) continue;
    if (NOTATION_CODES.has(s.code)) {
      s.addTag("Notation");
      marks.push(s);
    } else if (DYNAMIC_CODES.has(s.code)) {
      s.addTag("Notation");
      dynamics.push(s);
    }
  }
  return { marks, dynamics };
}

/** 琶音挂到线右边多少格以内的和弦（与位图路 `rasteromr/recognize.ts` 的 `ARP_REACH` 同值）。 */
const ARP_REACH = 2.5;

/**
 * 琶音记号：Finale 把它画成**一串竖排的 `wiggleTrill` 字形**（Maestro 'g'，同 x、上下一个接一个，
 * 宣主荣耀 p1 左手三和弦前六个）。不先挑出来，每一个都会被当成颤音挂到最近的音上。
 * 两个以上同列相接才算（单个的 wiggle 是真颤音线的一截）；Anastasia 有专门的竖波纹 `wiggleArpeggiatoUp`（八段锦钢片琴），一截也算。挂法同位图路：线右 `ARP_REACH` 格内、
 * 纵向落在线的范围里（上下容半格多）最靠左的那一列和弦。返回没被收走的记号。
 */
export function takeArpeggios(pg: SPage, notes: StaffNote[], marks: Sym[]): Sym[] {
  const sp = pg.normalStaffSpace || pg.space;
  const wig = marks.filter((m) => m.code === "wiggleTrill" || m.code === "wiggleArpeggiatoUp").sort((a, b) => a.box.left - b.box.left || a.box.top - b.box.top);
  const used = new Set<Sym>();
  for (const w of wig) {
    if (used.has(w)) continue;
    const col = [w];
    for (const u of wig) {
      if (used.has(u) || col.includes(u)) continue;
      const last = col[col.length - 1];
      if (Math.abs(u.box.left - w.box.left) > sp * 0.3) continue;
      if (u.box.top < last.box.top || u.box.top > last.box.bottom + sp * 0.5) continue;
      col.push(u);
    }
    if (col.length < 2 && w.code !== "wiggleArpeggiatoUp") continue;
    for (const u of col) used.add(u);
    const right = Math.max(...col.map((u) => u.box.right));
    const top = Math.min(...col.map((u) => u.box.top));
    const bottom = Math.max(...col.map((u) => u.box.bottom));
    const near = notes.filter((n) => !n.rest && n.sym.box.left >= right - sp * 0.3 && n.sym.box.left <= right + sp * ARP_REACH && n.sym.py >= top - sp * 0.6 && n.sym.py <= bottom + sp * 0.6);
    if (!near.length) continue;
    const x0 = Math.min(...near.map((n) => n.sym.box.left));
    for (const n of near) if (n.sym.box.left <= x0 + sp * 1.4) n.marks = [...(n.marks ?? []), "arpeggiato"];
  }
  return marks.filter((m) => !used.has(m));
}

/**
 * 短倚音的斜杠：Sibelius 画成一块**斜的填充四边形**（不是字形），斜穿倚音的干与符尾（八段锦二胡 / 高音笙 m48 倚音 D5）。
 * 没人认的话它又扁又宽、像一截符杠。记到这一列音上（`graceSlash`，写出时只对倚音起作用），路径打 `GraceSlash`。
 * 倚音要到凑拍子（`checkBars`）才定，这里还不知道：按**小符头**（头宽不到一格）认，
 * 斜杠要骑在干的中段（干从它中间穿过）——十六分的短钩斜着、也不宽，但只贴在干端。
 */
export function findGraceSlashes(pg: SPage, notes: StaffNote[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const n of notes) {
    const hb = n.sym.box;
    if (n.rest || n.stemTip === undefined || hb.right - hb.left >= sp) continue;
    const y0 = Math.min(n.stemTip, hb.top), y1 = Math.max(n.stemTip, hb.bottom);
    const sx = n.stemUp ? hb.right : hb.left;
    const o = pg.objs.find((o) => {
      if (o.hasAnyTag() || !o.path || o.path.curves || !isFill(o.path)) return false;
      const b = o.box;
      if (b.right - b.left > sp * 2.5 || b.bottom - b.top > sp * 2 || b.right - b.left < sp * 0.8) return false;
      if (sx < b.left + sp * 0.3 || sx > b.right - sp * 0.3 || b.top > y1 || b.bottom < y0) return false;
      // 斜的：四边形里有不水平也不竖直的边
      const sps = subPaths(o.path);
      return sps.length === 1 && sps[0].pts.some((q, i) => i > 0 && Math.abs(q.x - sps[0].pts[i - 1].x) > 0.3 && Math.abs(q.y - sps[0].pts[i - 1].y) > 0.3);
    });
    if (!o) continue;
    o.addTag("GraceSlash");
    for (const m of notes) if (m.staff === n.staff && Math.abs(m.x - n.x) < sp * 0.5) m.graceSlash = true;
  }
}

/**
 * 演奏法记号挂到音符上：同一行谱里 **x 最近**的那个音符。
 *
 * 记号印在符头的正上方或正下方，横向偏差极小；纵向差多少都可能（要绕开符干符杠），
 * 所以只按 x 找，再要求它落在该谱行的上下一格半以内。
 */
export function attachNotations(pg: SPage, notes: StaffNote[], marks: Sym[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const m of marks) {
    let best: StaffNote | undefined;
    let bd = Infinity;
    for (const n of notes) {
      const st = n.staff;
      // 纵向范围按谱表与这个符头合起来量：加线上的高音头顶印着的记号离谱表三格开外（牵我的手 m67 小提琴 C6 上的下弓）
      // 干尖也算进来：干朝上的音，重音印在干尖上方（八段锦小钗 m96 三个 `>` 离谱表四格）
      const tip = n.stemTip ?? (n.sym.box.top + n.sym.box.bottom) / 2;
      // 弓法、装饰音常叠在别的记号上面（高胡 m3：下弓在波音之上），放到四格半
      const reach = /^(strings|ornament)/.test(m.code) ? 4.5 : 3;
      if (m.py < Math.min(st.box.top, n.sym.box.top, tip) - sp * reach || m.py > Math.max(st.box.bottom, n.sym.box.bottom, tip) + sp * reach) continue;
      // 震音斜杠斜穿在符干上（离符头一两格）或印在全音符右边：按横向离符头墨迹的空隙算，不按原点 x
      // 其余按两边的墨迹中线比：八段锦的短波音比符头宽一倍，原点在左端，按原点比差出一格半（新笛 m30）；
      // 干朝上的音，顿音印在干那一侧（中胡 m50 偏右四点），按左端比就超了门槛
      const d = /^tremolo/.test(m.code)
        ? Math.max(0, m.box.left - n.sym.box.right, n.sym.box.left - m.box.right) + Math.abs(m.py - n.sym.py) * 0.01
        : Math.abs((n.sym.box.left + n.sym.box.right) / 2 - (m.box.left + m.box.right) / 2);
      if (/^tremolo/.test(m.code) && Math.abs(m.py - n.sym.py) > sp * 4.5) continue;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (!best || bd >= sp * (/^ornament/.test(m.code) ? 2.5 : 1.5)) continue;
    // 奏法记号按印在符头上方还是下方定字形的 Above / Below（写出时带 `placement`）：重音 `>` 上下是同一个形，
    // 字形认不出朝向；顿音楔子印在朝上符干那一侧的也有（八段锦二胡 m49 印在杠上方，中胡上下都有），照原位记
    const art = /^(artic\w+?)(Above|Below)$/.exec(m.code);
    const code = art ? `${art[1]}${m.py < best.sym.py ? "Above" : "Below"}` : m.code;
    (best.marks ??= []).push(code);
    // 全音符的震音原谱逐处手调过（八段锦，竖向 −0.5～2 格），照原位记
    if (/^tremolo/.test(m.code) && best.stemTip === undefined)
      best.tremoloAt = { x: ((m.box.left + m.box.right) / 2 - best.sym.box.left) / sp, y: (best.staff.box.top - (m.box.top + m.box.bottom) / 2) / sp };
  }
}

/**
 * 反复记号 𝄋 / 𝄌（`segno`、`coda`）挂到它右边最近的音上，出 `<direction>`。印在谱表上方，归下面那行谱。
 *
 * Anastasia 的 coda 与 ¢（`timeSigCutCommon`）是同一个字形（赞美之泉里当拍号用，字形字典按形状认，分不开）：
 * 没被拍号收走（不在谱表里）、整个印在某行谱上方四格以内的那个是 coda（八段锦唢呐 m33 前的 ⊕）。
 */
export function attachSigns(pg: SPage, notes: StaffNote[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  const below = (s: Sym) =>
    pg.staves
      .filter((st) => s.box.bottom <= st.box.top + sp * 0.5 && st.box.top - s.box.bottom < sp * 4 && s.box.right > st.box.left && s.box.left < st.box.right)
      .sort((a, b) => a.box.top - b.box.top)[0];
  const signs: { s: Sym & { code: "segno" | "coda" }; st: Staff }[] = [];
  for (const s of pg.symbols) {
    if (s.hasAnyTag()) continue;
    if (s.code === "timeSigCutCommon" && below(s)) s.code = "coda";
    if (s.code !== "segno" && s.code !== "coda") continue;
    const st = below(s);
    if (st) signs.push({ s: s as Sym & { code: "segno" | "coda" }, st });
  }
  for (const { s, st } of signs) {
    const row = notes.filter((n) => n.staff === st && !n.chordExtra && !n.grace).sort((a, b) => a.x - b.x);
    const right = row.find((m) => m.x >= s.box.left - sp);
    // 换行处的 ⊕/𝄋：Sibelius 行末（右边再没有音）画一个、下一行行首再画一个，是同一个记号，意思落在下一行头一小节上。
    // 下面哪行谱行首有同一个记号的，行末这个只认领不出（八段锦钢片琴 m32→m33，GT 只记 m33）
    // 印在行末：右边再没有音、或中心已越过本行末音（扬琴 m32 的 ⊕ 右边还压着末拍的休止）
    const rowEnd = !right || (right === row[row.length - 1] && (s.box.left + s.box.right) / 2 > right.sym.box.right);
    if (rowEnd && signs.some((o) => o.s !== s && o.s.code === s.code && o.st.box.top > st.box.top && o.s.box.left < o.st.box.left + sp * 8)) {
      s.addTag("Notation");
      continue;
    }
    const n = right ?? row[row.length - 1];
    if (!n) continue;
    // 行末的记号印在行末小节线上（八段锦各分谱 m32 末的 ⊕），意思落在小节末，写在末音之后
    if (rowEnd) (n.signsAfter ??= []).push(s.code);
    else (n.signs ??= []).push(s.code);
    s.addTag("Notation");
  }
}

/**
 * `Page::findTuplet`：符杠上方（或下方）的一个数字就是连音记号。
 *
 * 两种画法都认：乐谱字体的 `tuplet3` 字形（Anastasia 那一路），
 * 与**普通文本的单个数字**（Finale 那一路，musicpp 靠字体名 `Times-BoldItalic` 认，
 * 本仓不认字体名——同一本书里那个数字换过好几种字体——改按「单个数字 + 贴着符杠」判）。
 *
 * 找到之后把该符杠所在**符杠组**的音符全标成 n 连音。
 */
export function findTuplets(pg: SPage, beams: BeamShape[], stems: StemInfo[], notes: StaffNote[]): number {
  const nums: { n: number; cx: number; cy: number; w: number; h: number }[] = [];
  for (const s of pg.symbols) {
    if (s.hasAnyTag()) continue;
    if (s.code === "tuplet3") nums.push({ n: 3, cx: s.px, cy: s.py, w: s.box.right - s.box.left, h: s.box.bottom - s.box.top });
    else if (s.code === "tuplet0") nums.push({ n: 0, cx: s.px, cy: s.py, w: s.box.right - s.box.left, h: s.box.bottom - s.box.top });
  }
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.run) continue;
    const t = objText(o).trim();
    if (!/^[2-9]$/.test(t)) continue;
    nums.push({
      n: Number(t),
      cx: (o.box.left + o.box.right) / 2,
      cy: (o.box.top + o.box.bottom) / 2,
      w: o.box.right - o.box.left,
      h: o.box.bottom - o.box.top,
    });
  }
  if (!nums.length) return 0;

  // 每条符杠盖住的那撮音符，以及它们的**包围盒**——判「这个数字属于哪一组」要用它。
  const groupOf = new Map<BeamShape, { notes: Set<StaffNote>; top: number; bottom: number }>();
  for (const st of stems) {
    for (const b of st.beams) {
      let g = groupOf.get(b);
      if (!g) {
        g = { notes: new Set(), top: Infinity, bottom: -Infinity };
        groupOf.set(b, g);
      }
      for (const s of st.notes) {
        const n = notes.find((x) => x.sym === s);
        if (!n) continue;
        g.notes.add(n);
        g.top = Math.min(g.top, n.sym.box.top);
        g.bottom = Math.max(g.bottom, n.sym.box.bottom);
      }
    }
  }
  const sp = pg.normalStaffSpace || pg.space;

  let found = 0;
  for (const num of nums) {
    let best: BeamShape | undefined;
    let bd = Infinity;
    for (const b of beams) {
      if (num.cx < b.x0 - num.w || num.cx > b.x1 + num.w) continue;
      const g = groupOf.get(b);
      if (!g || !g.notes.size) continue;
      // **量到这一组符头的盒，不是量到符杠中心线**。
      //
      // 连音数字印在符头的**另一侧**：符干朝下时符杠在下、数字在上，
      // 中间隔着整个谱表加两截符干——实测 Opus 那本 p726 是 5.5~9.8 格，
      // 原来那道 `dy > num.h * 2`（约 2.7 格）把它们全挡掉了，
      // 一页 34 个三连音只收进 8 个，剩下的时值全按普通八分算，
      // 整小节自然凑不满（差额恰好是三连音的修正量）。
      //
      // 换成量到符头盒还顺带治好另一种误配：x 区间重叠、但在**别的谱行**上的符杠
      // （同一页上下两行的 x 范围本来就一样），那种 dy 是 39~48 格，照样出局。
      // 量到「**符头盒 ∪ 符杠盒**」这个并集，容差一格半。
      //
      // 连音数字总是贴在这一组的**外缘**，但贴哪一边看符干朝向：
      // 符干朝上时符杠在上、数字压在符杠上方；符干朝下时符杠在下、数字在符头上方。
      // 只量到符杠中心线，后一种就差着整个谱表加两截符干（实测 Opus p726 是
      // 5.5~9.8 格），34 个三连音只收进 8 个；只量到符头盒，前一种又差着一截符干
      // （实测 p132 原本收到的 7 组全丢）。取两者的**较小值**也不行——那等于把两个
      // 宽门槛并起来，假连音跟着涌进来（实测 Maestro 一下掉 60 个小节）。
      // 量到并集才既覆盖两种摆法、又不放宽：数字无论贴哪一边，离并集都只有一格半。
      // 容差扫过 1.5 / 2 / 2.5 格，**1.5 格最好**（全书 91.4% / 91.1% / 90.7%）——
      // 再放宽收到的 Opus 那十来个小节，抵不过 Maestro 涌进来的假连音。
      const top = Math.min(g.top, b.box.top);
      const bottom = Math.max(g.bottom, b.box.bottom);
      const dy = num.cy < top ? top - num.cy : num.cy > bottom ? num.cy - bottom : 0;
      if (dy > sp * 1.5) continue;
      if (dy < bd) {
        bd = dy;
        best = b;
      }
    }
    if (!best) {
      // **没有符杠的连音**：四分音符以上的连音不打符杠，改画一条**方括号**
      // （一条横线、两端各一截朝符头的短竖，中间被数字断开）。
      // 实测 p30/p31/p132/p133/p172 整页的三连音都是这一种，靠符杠一个也收不到。
      const grp = bracketGroup(pg, num, notes, sp);
      if (!grp) continue;
      found++;
      // 括号两截打上标：折线画的那截（「横线 + 一截钩」三点）不打标会被 `findWedges` 当成松叶（牵我的手 W/M/Vln 共 14 处）
      for (const o of grp.objs) if (!o.hasAnyTag()) o.addTag("Tuplet");
      applyTuplet(grp.notes, num.n);
      continue;
    }
    found++;
    // 该符杠盖住的那些符干上的音符，全算进这一组连音
    const marked = new Set<StaffNote>(groupOf.get(best)!.notes);
    applyTuplet(marked, num.n);
  }
  return found;
}

/** 三连音是「n 个音占 n-1 个音的时值」（3:2、6:4），按 musicxml 的惯例取最近的二次幂。 */
export function applyTuplet(marked: Iterable<StaffNote>, n: number): void {
  const normal = n === 3 ? 2 : n === 6 ? 4 : n === 5 ? 4 : n === 7 ? 4 : n - 1;
  const list = [...marked];
  // 起止落在组里最左、最右的音上；和弦各音 x 差不过半个符头，都算（写出时只写在和弦打头那个音上）
  const lo = Math.min(...list.map((x) => x.x));
  const hi = Math.max(...list.map((x) => x.x));
  for (const x of list) {
    const half = (x.sym.box.right - x.sym.box.left) / 2;
    x.tuplet = { actual: n, normal, start: x.x - lo <= half, stop: hi - x.x <= half };
    x.duration = (x.duration * normal) / n;
  }
}

/**
 * 连音**方括号**那一路：数字左右各有一截横线，两截同高、在数字两侧。
 *
 * 判据（都按线距 `sp` 量，别写绝对点值）：
 *   - 两截在数字两侧的内端点 y 差不到半格（同一条括号被数字断成两截）；可以是斜的（斜率 ≤0.5、两截斜率相近）；
 *   - 它们的 y 与数字中心差不到一格半（数字是嵌在括号里的）；
 *   - 一截在数字左、一截在数字右，间隙都不超过两格。
 *
 * 括号跨度定出音符范围之后，取**跨度内、离数字最近的那一行谱**上的音符。
 * 只有正好 `n` 个才认——多了少了都说明括号找错了，宁可不认（不认只是这一组
 * 时值偏长，认错会把邻组的时值一起改坏）。
 */
function bracketGroup(pg: SPage, num: { n: number; cx: number; cy: number; w: number; h: number }, notes: StaffNote[], sp: number): { notes: StaffNote[]; objs: PObj[] } | null {
  let left: Seg | null = null;
  let right: Seg | null = null;
  // **括号可以是斜的**：Finale 让它顺着音高走（牵我的手 W 声部 `G F E` 一路往下，两截各斜 1.8~2.8pt），
  // 只认水平段就一个也收不到，四分三连音整小节多出一拍。斜率放到 0.5，另靠下面「两截共线」把关
  const slope = (g: Seg) => (g.y1 - g.y0) / (g.x1 - g.x0);
  // 斜段不在 `pg.segs` 里（`segsOf` 只收水平、竖直两种，谱线、符干、小节线都靠这一点），
  // 在数字附近的未打标路径里另收：两点子路径或折线（括号是「横线 + 一截钩」一笔画下来的）
  const slanted: Seg[] = [];
  for (const o of pg.objs) {
    if (!o.path || o.hasAnyTag()) continue;
    if (o.box.right < num.cx - sp * 12 || o.box.left > num.cx + sp * 12 || o.box.bottom < num.cy - sp * 2 || o.box.top > num.cy + sp * 2) continue;
    for (const sub of subPaths(o.path)) {
      if (sub.pts.some((q) => q.curve)) continue;
      for (let i = 1; i < sub.pts.length; i++) {
        const a = sub.pts[i - 1];
        const b = sub.pts[i];
        if (Math.abs(b.x - a.x) < 0.02) continue;
        const g = new Seg(o, a.x, a.y, b.x, b.y, Math.max(o.path.lineWidth, 0.3));
        if (!g.isH) slanted.push(g);
      }
    }
  }
  for (const g of [...pg.segs, ...slanted]) {
    if (g.hasAnyTag() || g.isV) continue;
    if (!g.isH && (Math.abs(slope(g)) > 0.5 || g.right - g.left < sp)) continue;
    if (Math.abs(g.cy - num.cy) > sp * 1.5) continue;
    if (g.right <= num.cx && num.cx - g.right < sp * 2) {
      if (!left || g.right > left.right) left = g;
    } else if (g.left >= num.cx && g.left - num.cx < sp * 2) {
      if (!right || g.left < right.left) right = g;
    }
  }
  if (!left || !right) return null;
  // 同一条括号被数字断成两截：比**数字两侧的内端点**同不同高（水平括号就是两截同高），斜的还要斜率相近。
  // 楔形线（渐强渐弱）的两条一正一负，过不了这一关
  const yAt = (g: Seg, x: number) => (g.isH ? g.cy : g.y0 + slope(g) * (x - g.x0));
  if (Math.abs(yAt(left, left.right) - yAt(right, right.left)) > sp * 0.5) return null;
  if (!left.isH || !right.isH) {
    const a = left.isH ? 0 : slope(left);
    const b = right.isH ? 0 : slope(right);
    if (Math.abs(a - b) > 0.15) return null;
  }
  const x0 = left.left;
  const x1 = right.right;
  // 括号下（或上）方那一行谱：取跨度内音符最多的那行
  const inSpan = notes.filter((n) => n.x >= x0 - sp && n.x <= x1 + sp);
  if (!inSpan.length) return null;
  const cnt = new Map<StaffNote["staff"], StaffNote[]>();
  for (const n of inSpan) {
    const a = cnt.get(n.staff) ?? [];
    a.push(n);
    cnt.set(n.staff, a);
  }
  let best: StaffNote[] | null = null;
  for (const [stf, arr] of cnt) {
    if (arr.length !== num.n) continue;
    // 数字要在这行谱的上下一个谱表高之内（跨行的同 x 括号不能算）
    const h = stf.box.bottom - stf.box.top;
    if (num.cy < stf.box.top - h || num.cy > stf.box.bottom + h) continue;
    if (!best || arr.length < best.length) best = arr;
  }
  return best && { notes: best, objs: [left.obj, right.obj] };
}

/** SMuFL 力度名 → MusicXML `<dynamics>` 的子元素名。 */
export const DYNAMIC_NAME: Record<string, string> = {
  dynamicPiano: "p",
  dynamicPP: "pp",
  dynamicPPP: "ppp",
  dynamicMezzo: "m",
  dynamicMP: "mp",
  dynamicMF: "mf",
  dynamicForte: "f",
  dynamicFF: "ff",
  dynamicFFF: "fff",
  dynamicSforzando: "sf",
  dynamicRinforzando: "rf",
  dynamicZ: "z",
  dynamicNiente: "n",
};

/**
 * 力度记号挂到音符上（MusicXML 里它是 `<direction>`，挂在小节上、排在音符之前）。
 *
 * 与演奏法的区别：力度印在谱表**下方**（人声谱有时在上方）且不必对准某个符头，
 * 所以只按 x 找最近的音符，容差放到三格。
 */
export function attachDynamics(pg: SPage, notes: StaffNote[], dynamics: Sym[], lyricBottom?: Map<Staff, number>): void {
  attachDynamicTexts(
    pg,
    notes,
    dynamics.flatMap((d) => {
      const text = DYNAMIC_NAME[d.code];
      return text ? [{ px: d.px, py: d.py, text, box: d.box }] : [];
    }),
    lyricBottom,
  );
}

/**
 * 同上，只是力度**已经拼成字符串**了（`mp`/`mf`/`sfz`…）。
 *
 * 位图路认出来的是一个个字母块（`p`、`m`、`f` 各一个 contour），拼完才是一个力度记号，
 * 给不出单个 SMuFL 名——判据只留这一份，`attachDynamics` 查完表委托过来。
 */
export function attachDynamicTexts(
  pg: SPage,
  notes: StaffNote[],
  items: { px: number; py: number; text: string; box?: { left: number; right: number; top: number; bottom: number }; srcBox?: { left: number; right: number; top: number; bottom: number } }[],
  lyricBottom?: Map<Staff, number>,
): Set<number> {
  const sp = pg.normalStaffSpace || pg.space;
  /** 挂上了的（下标）：调用方据此判别的路认出的还要不要补 */
  const placed = new Set<number>();
  for (const [di, d] of items.entries()) {
    // 与松叶同一条：先定谱行（力度也印在它那行谱的下方），再在行内按 x 找最近的音符。
    // 够到六格：钢琴两行之间隔得宽的，印在正中的力度离上一行下线 5.6 格（破碎 p6 m66 `mf`）
    const owner = ownerStaff(pg, d.py, sp, 6, lyricBottom);
    for (const only of [true, false]) {
      let best: StaffNote | undefined;
      let bd = Infinity;
      for (const n of notes) {
        const st = n.staff;
        if (only ? st !== owner : d.py < st.box.top - sp * 4 || d.py > st.box.bottom + sp * 4) continue;
        const dx = Math.abs(n.sym.px - d.px);
        if (dx < bd) {
          bd = dx;
          best = n;
        }
      }
      // 三格内没有音、而有墨迹框的：取本行字框右边第一个音（四格半内）。人声的力度常印在**音前**，
      // 隔着领起歌词的段号或印在前面休止小节的末尾（宁静 p3 `mf 1. 寧`，右缘到音 3.9 格；p4 m48 两处同此）
      if (only && owner && d.box && !(best && bd < sp * 3)) {
        const right = d.box.right;
        // 按音的中线比：字框右缘常压过音头左缘一点（高胡 m78 行首 `ff` 右缘过了 E6 头左缘 0.3 点）
        const next = notes.filter((n) => n.staff === owner && (n.sym.box.left + n.sym.box.right) / 2 > right && n.sym.px - right < sp * 4.5).sort((p, q) => p.sym.px - q.sym.px)[0];
        if (next) {
          best = next;
          bd = 0;
        }
      }
      if (best && bd < sp * 3) {
        if (best.dynamic === undefined) {
          best.dynamic = d.text;
          if (d.box) best.dynamicBox = { left: d.box.left, right: d.box.right, top: d.box.top, bottom: d.box.bottom };
          else if (d.srcBox) best.dynamicSrcBox = { ...d.srcBox };
        }
        placed.add(di);
        break;
      }
    }
  }
  return placed;
}

/**
 * 记号（松叶、力度）印在谱表下方时**属于上面那行谱**。
 *
 * 取「下缘在它上方、且最近」的那一行；上方没有（页面第一行谱之上）才退回下方最近的一行。
 * 容差各五格与三格——谱表之间隔着歌词带，记号常印在带里。
 */
function ownerStaff(pg: SPage, cy: number, sp: number, reach = 5, lyricBottom?: Map<Staff, number>, nextReach = 3): Staff | null {
  let best: Staff | null = null;
  let bd = Infinity;
  for (const st of pg.staves) {
    const d = cy - st.box.bottom;
    if (d < 0 || d > sp * reach) continue;
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  // **隔着上一行的歌词、紧贴着下一行谱的，是下一行的**（`lyricBottom` 给了才判，矢量路给）。
  // 人声力度有两种版式：印在自己那行歌词下面（破碎，上面那条约定由它来）；印在自己谱表上方——也就是
  // 上一行的歌词下面（宣主荣耀：男声 m1 的 p、m9 的渐强挂到了女低）。光凭几何分不开，歌词分得开：
  // 记号在上一行歌词**下沿之下**、且下方三格内就是一行谱，归下面那行。钢琴两行之间没有歌词，不受影响
  if (best && lyricBottom) {
    const lb = lyricBottom.get(best);
    if (lb !== undefined && cy > lb) {
      const below = pg.staves.filter((st) => st.box.top >= cy && st.box.top - cy <= sp * nextReach).sort((a, b) => a.box.top - b.box.top)[0];
      if (below) return below;
    }
  }
  if (best) return best;
  for (const st of pg.staves) {
    const d = st.box.top - cy;
    if (d < 0 || d > sp * 3) continue;
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  return best;
}

/** 松叶往上找它那行谱的范围（格）：谱表下方隔着几段歌词也算。 */
const WEDGE_REACH = 9;
/** 松叶隔着上一行歌词、紧贴下一行谱的归下一行：离下一行谱顶这么多格以内（力度那一条是 3 格）。
 *  印在下一行谱上方的离谱顶 1.0~2.54 格（宣主荣耀、牵我的手、破碎 p4 m30）；破碎印在自己歌词下面的离下一行 2.80~2.92 格 */
const WEDGE_NEXT_REACH = 2.6;
/** 起端那一带在唱长音（离最近的音超过 4 格）：往左这么多格内本行有音就挂它（破碎 m98 女高） */
const WEDGE_LONG_REACH = 12;
/** 右端压过小节线这么多格以内的，算收在小节线前（开口顶着小节线、与它连成一团认出来的） */
const WEDGE_PAST_BAR = 2.5;
/** 「音头处」的容差（格，按符头左缘量）：左端在音头左缘右边这么多以内的、右端在音头左缘左边这么多以内的，都算在那个音头处 */
const WEDGE_END_TOL = 0.5;
/** 起端：左端离之前那个音头过这么多格、后一个音头在左端后这么多格以内，挂后一个音。 */
/** 止端：右端离前一个音头（左缘）不过这么多格、后一个音又远，收在这个音上。 */
const WEDGE_STOP_ON_HEAD = 1.2;
const WEDGE_START_FAR = 2.6;
const WEDGE_START_NEXT = 2.5;
/** 行首续段：左端在本行第一个音头之前这么多格以上 */
const WEDGE_CONT_LEAD = 0.5;
/** 行尾要续的：右端离谱表右端这么多格以内——续下去的直画到谱表尽头（破碎 m64、m72 差 3 像素），
 *  收在系统末小节线前的留着空（m80 差 0.65 格） */
const WEDGE_CONT_EDGE = 0.4;
/** 行尾可能续的：右端离谱表右端这么多格以内，下一系统同一行行首有同类续段才算（破碎 m89 渐弱续到下一页，右端离谱表右端 0.88 格、压在末音底下） */
const WEDGE_CONT_LOOSE = 1.5;

/** 行尾续出去的松叶：类型，确定（顶到谱表右端）还是可能（下一截认了才算）。 */
export interface WedgeOpen {
  type: "crescendo" | "diminuendo";
  sure: boolean;
}

/** `attachWedges` 交给下一页的：末系统各行续出的（`open`）、其中「可能」续出那截写了止的音（`stops`），
 *  以及本页头一个系统认作上一页续段、要撤掉上一页那截止端的行（`took`）。 */
export interface WedgeRows {
  open: (WedgeOpen | null)[];
  stops: (StaffNote | null)[];
  took: number[];
}

/** 一条松叶：两端的 x 与纵向位置（谁挂给谁由 `attachWedges` 定）。 */
export interface WedgeSpan {
  type: "crescendo" | "diminuendo";
  x0: number;
  x1: number;
  cy: number;
  /** 宽口那头的开口高（页面单位）；量不到不写 */
  spread?: number;
  /** 从粘连的大团里切出来的（位图路小节线切段、剥团） */
  fromBlob?: boolean;
  /** 窄头合成一点（矢量路量得出）：行首的渐强也是新起的，不是续段（中音笙 m10、m25） */
  closed?: boolean;
}

/**
 * 松叶挂到音符上：先定谱行（与力度同一套），起点挂左端处或之前的音、终点挂右端处或之后的第一个音
 *（右端过了末音、收在小节线前的挂末音并写在它后面），两端都不隔小节线；跨系统的那一截只写起或只写止。
 * 止端只在起端之后找，不会与起点落在同一个音上。
 * `openIn`：上一页末系统各行续过来的松叶；返回本页末系统的同一张表等（跨页沿用，见 `PageCarry.openWedges`）。
 */
export function attachWedges(pg: SPage, notes: StaffNote[], wedges: WedgeSpan[], lyricBottom?: Map<Staff, number>, openIn?: (WedgeOpen | null)[]): WedgeRows {
  const sp = pg.normalStaffSpace || pg.space;
  // 先把每条的起止定下来、记下行尾续出的行，再写：行首渐弱是不是续段要看上一系统（上一页末系统）同一行有没有续出去的
  const plans: { wg: WedgeSpan; a: StaffNote; b?: StaffNote; after: boolean; head: boolean; contOut: boolean; maybeOut: boolean }[] = [];
  const rowKey = (st: Staff): [number, number] => {
    const sys = pg.systems.findIndex((s) => s.staves.includes(st));
    return [sys, sys < 0 ? -1 : pg.systems[sys].staves.indexOf(st)];
  };
  // 挑中的是和弦附加音的换成同一和弦的主音：挂在附加音上的，写出时落在和弦头一个音之后，起止时刻被推到下一拍（破碎 m106、m107、m109）。
  // 挑的时候仍按全部音的位置（二度挤开的和弦，附加音的头比主音靠前）
  const mainOf = (n: StaffNote): StaffNote => (n.chordExtra && n.group ? (notes.find((m) => m.group === n.group && m.staff === n.staff && !m.chordExtra) ?? n) : n);
  for (const wg of wedges) {
    // **先定是哪一行谱，再在那一行里找音符。** 松叶印在它那行谱的**下方**
    // （歌词带那一条里也常见），而下面一行谱的上缘往往比它自己那行的下缘还近
    // ——不先定谱行，一条松叶会挂到下一行去，逐声部比出来的次序全乱。
    // 上方够得着的范围放到 `WEDGE_REACH` 格：合唱谱人声的松叶印在**自己那行歌词下面**（破碎 p4 女高、女低），
    // 离下一行谱表反而更近，五格以内找不到上方那行就挂到了下一行
    const owner = ownerStaff(pg, wg.cy, sp, WEDGE_REACH, lyricBottom, WEDGE_NEXT_REACH);
    const near = (x: number): StaffNote | undefined => {
      // 先在**它那行谱**里找；那一行在这个位置没有音符（人声休止、钢琴前奏一类）
      // 才退回「所有纵向够得着的谱行里 x 最近的那个」。
      // 只按 y 定谱行、找不到就丢，实测松叶从 38 掉到 14——那一行常常正好在休止。
      for (const only of [true, false]) {
        let best: StaffNote | undefined;
        let bd = Infinity;
        for (const n of notes) {
          const st = n.staff;
          if (only ? st !== owner : wg.cy < st.box.top - sp * 5 || wg.cy > st.box.bottom + sp * 5) continue;
          const dx = Math.abs(n.sym.px - x);
          if (dx < bd) {
            bd = dx;
            best = n;
          }
        }
        if (best && bd < sp * 4) return best;
        if (only && owner) {
          // 那一带在唱长音：取它左边最近的音（长音中间起的松叶，GT 挂在长音上）
          // 同一小节里的不设远近（牵我的手 m51、m87 小提琴全音符，渐强从小节后半起、离音头 14 格）
          const ownBars = owner ? pg.segsWithTag("BarLine").filter((b) => b.top <= owner.box.bottom && b.bottom >= owner.box.top).map((b) => b.cx) : [];
          const left = notes.filter((n) => n.staff === owner && n.sym.px <= x && (x - n.sym.px <= sp * WEDGE_LONG_REACH || !ownBars.some((bx) => bx > n.sym.px && bx < x))).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px > m.sym.px ? n : m), undefined);
          if (left) return left;
        }
        if (only && !owner) continue;
      }
      return undefined;
    };
    const a0 = near(wg.x0);
    if (!a0) continue;
    const bars = pg.segsWithTag("BarLine").filter((b) => b.top <= a0.staff.box.bottom && b.bottom >= a0.staff.box.top).map((b) => b.cx);
    const barBetween = (xa: number, xb: number) => bars.some((x) => x > Math.min(xa, xb) && x < Math.max(xa, xb));
    // 两端挂哪个音照排版惯例：松叶**起在它开始的那个音下**（左端在那个音头处或之后），**收在它通向的那个音之前**
    //（右端在那个音头处或之前）；右端过了小节里末一个音、收在小节线前的，止在小节末。两端都不隔小节线去找。
    // 从前两端各挂 x 最近的音：起端印在某个音右边一点就挂到了下一个音，收在小节线前的挂到了下一小节的头一个音
    // 不设回看距离：同一小节里左端之前的音再远也是它在响（起在长音中间的挂这个长音，破碎 m107 右手二分音符）
    let a = notes.filter((n) => n.staff === a0.staff && n.sym.px <= wg.x0 + sp * WEDGE_END_TOL && !barBetween(n.sym.px, wg.x0)).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px > m.sym.px ? n : m), undefined) ?? a0;
    // 左端离之前那个音已远（`WEDGE_START_FAR` 格开外）、后一个音就在跟前：起点是印在后一个音前面的（宁静 m85 男声、m86 女声，
    // 左端在后一个音前一格多、离前一个音三格）
    // 钢琴大谱表两行之间的松叶：「之前那个音」两行都算（宁静 m7 左手 2.5 拍有音、右手没有，不能因右手那一段空着就挂到下一个音）。
    // 本行没有歌词、下面紧挨着还有一行（12 格内），当作一个大谱表（下面那行的「歌词带」不可靠：排练号框也算进去；
    // 不看本行歌词、一律算上下一行的试过，宁静、破碎、破碎扫描各多一步）
    const pairBelow = !lyricBottom?.has(a.staff) ? pg.staves.find((s0) => s0 !== a.staff && s0.box.top > a.staff.box.bottom && s0.box.top - a.staff.box.bottom <= sp * 12 && wg.cy < s0.box.top) : undefined;
    const prevX = Math.max(a.sym.px, ...notes.filter((n) => n.staff === pairBelow && n.sym.px <= wg.x0 + sp * WEDGE_END_TOL && !barBetween(n.sym.px, wg.x0)).map((n) => n.sym.px));
    if (wg.x0 - prevX > sp * WEDGE_START_FAR) {
      const nx = notes.filter((n) => n.staff === a.staff && !n.chordExtra && !n.grace && n.sym.px > wg.x0 && n.sym.px - wg.x0 <= sp * WEDGE_START_NEXT && !barBetween(n.sym.px, wg.x0)).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px < m.sym.px ? n : m), undefined);
      if (nx) a = nx;
    }
    const row = notes.filter((n) => n.staff === a.staff && n.sym.px > a.sym.px);
    // 右端顶到或压过小节线（开口顶着小节线、粘在一起认出来的常见）：收在小节线前
    const barAt = bars.filter((x) => x <= wg.x1 + sp * 0.3 && wg.x1 - x <= sp * WEDGE_PAST_BAR && x > wg.x0 + sp).sort((p, q) => p - q)[0];
    const x1 = barAt === undefined ? wg.x1 : Math.min(wg.x1, barAt - 1);
    let b = row.filter((n) => n.sym.px >= x1 - sp * WEDGE_END_TOL && !barBetween(n.sym.px, x1)).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px < m.sym.px ? n : m), undefined);
    let after = false;
    // 收在长音音头上（右端离前一个音头不到 `WEDGE_STOP_ON_HEAD` 格、后一个音还在 4 格开外）：挂这个长音（破碎 m40 女高二收在第 3 拍降 B4 上）
    // 钢琴大谱表：另一行在右端附近有音（宁静 m64 右手长和弦、左手八分音符），不算收在长音中间
    const nextOther = notes.filter((n) => n.staff === pairBelow && n.sym.px >= x1 - sp * WEDGE_END_TOL && !barBetween(n.sym.px, x1)).reduce((m, n) => Math.min(m, n.sym.px), Infinity);
    if (b && b.sym.px - x1 > sp * 4 && nextOther - x1 > sp * 4) {
      const on = [a, ...row].filter((n) => n.sym.px <= x1 && x1 - n.sym.px <= sp * WEDGE_STOP_ON_HEAD && n !== a && !barBetween(n.sym.px, x1)).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px > m.sym.px ? n : m), undefined);
      if (on) b = on;
    }
    if (!b) {
      b = [a, ...row].filter((n) => n.sym.px <= x1 && !barBetween(n.sym.px, x1)).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px > m.sym.px ? n : m), undefined);
      // 收在末音与小节线（行尾是谱表右端）之间：离小节线近才是「收在小节末」；离末音音头近的是收在这个长音中途，挂它
      //（牵我的手 m45 小提琴渐强压过小节线、收在全音符下面三分之一处，GT 挂这个全音符）
      const end = Math.min(...bars.filter((x) => x > x1), a.staff.box.right);
      after = !!b && end - x1 <= x1 - b.sym.px;
    }
    b ??= row.filter((n) => n.sym.px <= wg.x1 + sp * 4).reduce<StaffNote | undefined>((m, n) => (!m || n.sym.px > m.sym.px ? n : m), undefined);
    // **跨系统的松叶**：上一系统末那一截不写止、下一系统行首那一截不写起，MusicXML 里同号的起止跨行自然接上（弧线同此）。
    // 行首那截：渐强、左端在本行第一个音头之前（渐强从尖端起，最早也是从第一个音起；左端在音前又张着口的只能是续段）。
    // 渐弱在行首本来就是开口那头，单看这一截分不出起还是续（宁静 m107 真从行首起、破碎 m30 / m90 是续段，几何一样）：
    // 看上一系统同一行有没有续出来的（见下）。
    // 行尾那截右端到了谱表右端、又在本行末音之后
    const inRow = notes.filter((n) => n.staff === a.staff).map((n) => n.sym.px);
    const head = inRow.length > 0 && wg.x0 < Math.min(...inRow) - sp * WEDGE_CONT_LEAD;
    const pastLast = inRow.length > 0 && wg.x1 > Math.max(...inRow) + sp;
    const contOut = pastLast && wg.x1 >= a.staff.box.right - sp * WEDGE_CONT_EDGE;
    // 可能续出的不看末音（要等下一截认）：破碎 m89 渐弱右端压在本行末音底下
    const maybeOut = contOut || (inRow.length > 0 && wg.x1 >= a.staff.box.right - sp * WEDGE_CONT_LOOSE);
    a = mainOf(a);
    if (b) b = mainOf(b);
    // 从粘连团里切出来的（`fromBlob`）、起止又落在同一个音（和弦）上：整条落在一个音的身后，是符尾、杠之间凑出来的碎块（新编 078 m9、105 m19）
    if (wg.fromBlob && b && (b === a || (b.group && b.group === a.group))) continue;
    plans.push({ wg, a, b, after, head, contOut, maybeOut });
  }
  // 行尾续出去的：确定的（顶到谱表右端）与可能的（离右端 `WEDGE_CONT_LOOSE` 格内，下一系统同一行行首有同类的续段才认）
  const openAt = new Map<string, { type: WedgeSpan["type"]; sure: boolean; plan: (typeof plans)[number] }>();
  for (const p of plans) {
    if (!p.maybeOut) continue;
    const [sys, row] = rowKey(p.a.staff);
    const k = `${sys}:${row}`;
    const o = openAt.get(k);
    if (!o || p.wg.x1 > o.plan.wg.x1) openAt.set(k, { type: p.wg.type, sure: p.contOut, plan: p });
  }
  const took: number[] = [];
  const contIns = plans.map((p) => {
    if (!p.head) return false;
    // 上一系统同一行（本页头一个系统看上一页末系统，`openIn`）有同类续出去的：是续段，不写起；那一截只是「可能」续出的，撤掉它的止
    // 渐弱只认这一条（宁静 m107 真从行首起）；渐强左端在行首音前张着口，本来就只能是续段
    const [sys, row] = rowKey(p.a.staff);
    const inPage = sys > 0 ? openAt.get(`${sys - 1}:${row}`) : undefined;
    const prev = inPage ?? (sys === 0 ? openIn?.[row] : undefined);
    if (prev && prev.type === p.wg.type) {
      if (!prev.sure) {
        if (inPage) inPage.plan.contOut = true;
        else took.push(row);
      }
      return true;
    }
    return p.wg.type === "crescendo" && !p.wg.closed;
  });
  plans.forEach(({ wg, a, b, after, contOut }, i) => {
    if (!contIns[i] && a.wedgeStart === undefined) {
      a.wedgeStart = wg.type;
      a.wedgeAt = { x0: wg.x0, cy: wg.cy, ...(wg.spread ? { spread: wg.spread } : {}) };
    }
    if (!contOut && b) {
      b.wedgeStop = true;
      if (after) b.wedgeStopAfter = true;
      b.wedgeStopAt = { x1: wg.x1, ...(wg.type === "crescendo" && wg.spread ? { spread: wg.spread } : {}) };
    }
  });
  // 末系统各行续到下一页的；可能续出的那截止端写在哪个音上（下一页认作续段时由整曲那头撤掉，见 `recognizeRasterSong`）
  const last = pg.systems.length - 1;
  const rows = last < 0 ? [] : pg.systems[last].staves.map((_, row) => openAt.get(`${last}:${row}`));
  return {
    open: rows.map((o) => (o ? { type: o.type, sure: o.sure } : null)),
    stops: rows.map((o) => (o && !o.sure && !o.plan.contOut ? (o.plan.b ?? null) : null)),
    took,
  };
}

/**
 * 歌词延长线（一字多音）：词尾的字（后面没有连字符）所在的音起着一条圆滑线 / 连音线，线罩着的后续音又都没有这一段的字，
 * 就在这个字上记 `extend`、线尾那个音上记 `lyricExtendStop`。**纯推导**，不去找那条下划线的墨
 * ——它印在歌词行里，又细又长，与连字符、汉字的一横分不开。弧线挂完之后跑。
 */
export function markLyricExtends(notes: StaffNote[]): void {
  const rows = new Map<string, StaffNote[]>();
  const staffIds = new Map<Staff, number>();
  for (const n of notes) {
    if (n.chordExtra || n.grace) continue;
    if (!staffIds.has(n.staff)) staffIds.set(n.staff, staffIds.size);
    const k = `${staffIds.get(n.staff)}/${n.voice}`;
    rows.set(k, [...(rows.get(k) ?? []), n]);
  }
  for (const seq of rows.values()) {
    seq.sort((a, b) => a.x - b.x);
    seq.forEach((n, i) => {
      for (const l of n.lyrics ?? []) {
        // 只有拉丁文歌词画延长线；中文逐字挂词，一字多音靠圆滑线表示，不画线
        if (l.hyphen || !/[A-Za-z]/.test(l.text)) continue;
        let j = i;
        let open = false;
        for (;;) {
          const c = seq[j];
          if (c.slurStart || c.tieStart) open = true;
          else if (j > i && (c.slurStop || c.tieStop)) open = false;
          const nx = seq[j + 1];
          if (!open || !nx || nx.rest || (nx.lyrics ?? []).some((v) => v.verse === l.verse)) break;
          j++;
        }
        if (j === i) continue;
        l.extend = true;
        (seq[j].lyricExtendStop ??= []).push(l);
      }
    });
  }
}
