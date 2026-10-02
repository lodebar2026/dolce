// 页面级识别。逐条对应 musicpp `qtomr/qomr.cpp` 的 `Page::findXxx`，
// 调用顺序照 `Score::process`（**别调**）。改行为前先核对那边的原文。
//
// 与 musicpp 的一处结构性差别：那边一个 pdfium PageObject 就是一条线，标记挂在对象上；
// 本书有一批 PDF 把整行谱的所有线画进**一个** path 对象，故先拆成 `Seg`（见 model.ts），
// **标记挂在段上**。凡 musicpp 写 `o->addTag(...)` 的地方，这里都是 `seg.addTag(...)`。
//
// 坐标一律设备坐标、y 向下（见 model.ts 开头那段）。
import type { VecObj } from "../omr/vector";
import type { VecTextRun } from "../omr/vectext";
import { musicFamily } from "./symbolmap";
import { StaffGlyphLookup } from "./staffglyphs";
import {
  type Box,
  Bar,
  PObj,
  SPage,
  SSystem,
  Seg,
  Staff,
  Sym,
  between,
  boxH,
  overlapX,
  overlapY,
  sortByLeft,
  sortByTop,
} from "./model";
import { isFlag, isNoteHead, isRest } from "./glyphs";
import { shapeSig } from "../omr/glyphdict";
import { isWhite, subPaths, thinRectAxis } from "./vecgeom";
import { classifyBarlines, tagRepeatDots } from "./barlines";

// 以下比例一律相对**小节线高度 H**（`SPage.barlineHeight`），别改成绝对点值。

/** 一条段最短要多长才收：H 的 4%（约六分之一格）。比这更短的是圆点、装饰片的边。 */
const MIN_SEG_RATIO = 0.04;

/** 重描合并的中心线容差：H 的 1.75%（约十四分之一格）。
 *  重描的偏移实测在这个量级，而真谱线的线距是 H/4——中间有一个数量级的余量。 */
const MERGE_TOL_RATIO = 0.0175;

/** 谱线间距的下限：H 的 10%。比这更近的两条「线」是同一条线的重描残留。 */
const MIN_LINE_GAP_RATIO = 0.1;

/** 谱线间距的上限：H 的 40%（名义值是 25%，留足小谱/大谱的余量）。 */
const MAX_LINE_GAP_RATIO = 0.4;

/** 谱行的**长宽比**下限：谱表宽度至少是它高度的这么多倍。
 *  吉他和弦图是 14×16pt 的方块，五条品格线间距也均匀——只靠「等距五条」分不开，
 *  靠这条分得开（真谱行宽 388pt、高 17pt）。 */
const STAFF_ASPECT_MIN = 4;

/** 谱线候选的长度门槛：整页最长横线的这个比例。符杠、加线都短得多。 */
const STAFF_LINE_LEN_RATIO = 0.35;
/** 凑第 n 条谱线时，离「按平均间距推出来的位置」允许差多少（相对间距）。 */
const STAFF_LINE_TOL = 0.2;
/** 兜底那一路「五条算不算等距」的容差（相对平均间距）。与 `groupStaves` 同一个数。 */
const STAFF_EVEN_TOL = 0.2;

/**
 * 量出这一页的小节线高度 H（见 `SPage.barlineHeight` 的注释）。
 *
 * 取音乐字体 run 的**字号中位数**（按字形个数加权，正谱的字形远多于小谱，
 * 中位数因此落在正谱上）。一个音乐字形都没有的页（封面/目录）退回按页宽估——
 * 那些页反正没有谱表，H 只用来滤掉过短的段。
 */
function estimateBarlineHeight(runs: VecTextRun[], width: number): number {
  const sizes: number[] = [];
  for (const r of runs) {
    if (!musicFamily(r.font) || r.sizeDev <= 0) continue;
    for (let i = 0; i < r.glyphs.length; i++) sizes.push(r.sizeDev);
  }
  if (!sizes.length) return width / 25;
  sizes.sort((a, b) => a - b);
  return sizes[sizes.length >> 1];
}

/** 从一个路径对象里抽出所有直线段。
 *  两种来源：两点的直线子路径；以及**细长的轴对齐矩形**子路径（Finale 有时把
 *  符干/小节线画成填充矩形而不是描边直线），后者取它的中心线、线宽取短边。 */
function segsOf(o: PObj, minLen: number): Seg[] {
  const p = o.path;
  if (!p) return [];
  const out: Seg[] = [];
  const lw = Math.max(p.lineWidth, 0.3);
  for (const sp of subPaths(p)) {
    if (sp.pts.some((q) => q.curve)) continue;
    if (sp.pts.length === 2) {
      const [a, b] = sp.pts;
      const s = new Seg(o, a.x, a.y, b.x, b.y, lw);
      if (s.len >= minLen && (s.isH || s.isV)) out.push(s);
      continue;
    }
    const r = thinRectAxis(sp);
    if (r) {
      const s = new Seg(o, r.x0, r.y0, r.x1, r.y1, r.w);
      if (s.len >= minLen) out.push(s);
      continue;
    }
    // 多段折线：逐段收（这一批 PDF 里整行谱线就是这么画的）
    if (sp.pts.length > 2) {
      for (let i = 1; i < sp.pts.length; i++) {
        const a = sp.pts[i - 1];
        const b = sp.pts[i];
        const s = new Seg(o, a.x, a.y, b.x, b.y, lw);
        if (s.len >= minLen && (s.isH || s.isV)) out.push(s);
      }
    }
  }
  return out;
}

/**
 * 合并**重描**出来的段。
 *
 * 本书有一批 PDF（Finale 经 Distiller 那一路）把每条线用 `lw=0.06` 描五六遍、
 * 每遍偏 0.06pt 来凑出视觉线宽。不合并的话：一条谱线变成六条（「连续五条等距」
 * 会全落在同一条线的重描上）、一条小节线变成六条（实测全书小节线数虚高到 29 万）。
 *
 * **只在同一个 path 对象内部合并**。这条是要害：这一批 PDF 连**填充**也是拿密排细线
 * 画出来的（实测 p185 的符杠 = 14pt 宽的横线密排 2.5pt 高），跨对象合并会把谱线
 * 与压在它上面的符杠串成一条 2.3pt 粗的「线」，那一行谱的线距就废了。
 * 同一条线的重描一定在同一个对象里，所以按对象分组不会漏合。
 *
 * 判据：同向、中心线相距不到 `tol`、且在长轴方向上**真的重叠**。
 * 重叠而不是「首尾相接」是要害：同一条 y 上的加线与谱线是首尾相接的两条，
 * 接起来会把加线并进谱线、谱线左端跟着变长。
 * 合并后的线宽取「重描的跨度」与「最大原始线宽」中的大者——那才是视觉线宽。
 * `tol` 按页面单位取比例（`MERGE_TOL_RATIO`），别写绝对点值：同一本书里谱表大小差一倍。
 */
function mergeRedrawn(all: Seg[], tol: number): Seg[] {
  const out: Seg[] = [];
  const byObj = new Map<PObj, Seg[]>();
  for (const s of all) {
    const a = byObj.get(s.obj) ?? [];
    a.push(s);
    byObj.set(s.obj, a);
  }
  for (const segs of byObj.values()) mergeOne(segs, tol, out);
  return out;
}

function mergeOne(segs: Seg[], tol: number, out: Seg[]): void {
  for (const dir of [true, false]) {
    const list = segs.filter((s) => (dir ? s.isH : s.isV) && !(s.isH && s.isV));
    // 键：横段按 cy、竖段按 cx
    const key = (s: Seg) => (dir ? s.cy : s.cx);
    const lo = (s: Seg) => (dir ? s.left : s.top);
    const hi = (s: Seg) => (dir ? s.right : s.bottom);
    list.sort((a, b) => key(a) - key(b) || lo(a) - lo(b));
    let i = 0;
    while (i < list.length) {
      // 同一「带」里的段（中心线彼此相距不到 tol，链式）
      let j = i + 1;
      while (j < list.length && key(list[j]) - key(list[j - 1]) < tol) j++;
      const band = list.slice(i, j);
      i = j;
      // 带内按长轴分簇（重叠或相接的算一条）
      band.sort((a, b) => lo(a) - lo(b));
      let cluster: Seg[] = [];
      const flush = () => {
        if (!cluster.length) return;
        const a = cluster[0];
        const k0 = Math.min(...cluster.map(key));
        const k1 = Math.max(...cluster.map(key));
        const span = Math.max(k1 - k0, ...cluster.map((s) => s.lw));
        const c = (k0 + k1) / 2;
        const p0 = Math.min(...cluster.map(lo));
        const p1 = Math.max(...cluster.map(hi));
        out.push(dir ? new Seg(a.obj, p0, c, p1, c, span) : new Seg(a.obj, c, p0, c, p1, span));
        cluster = [];
      };
      for (const s of band) {
        if (!cluster.length) {
          cluster.push(s);
          continue;
        }
        const end = Math.max(...cluster.map(hi));
        if (lo(s) < end) cluster.push(s);
        else {
          flush();
          cluster.push(s);
        }
      }
      flush();
    }
  }
  // 既非水平也非垂直的段（斜线）原样留着
  out.push(...segs.filter((s) => !s.isH && !s.isV));
}

/** 建页：路径对象与文字对象各包一层 `PObj`，再从路径里抽出直线段。 */
export function buildPage(index: number, width: number, height: number, paths: VecObj[], runs: VecTextRun[]): SPage {
  const pg = new SPage(index, width, height);
  let id = 0;
  pg.barlineHeight = estimateBarlineHeight(runs, width);
  const raw: Seg[] = [];
  for (const p of paths) {
    const o = new PObj(id++, p, null);
    pg.objs.push(o);
    raw.push(...segsOf(o, pg.barlineHeight * MIN_SEG_RATIO));
  }
  pg.segs = mergeRedrawn(raw, pg.barlineHeight * MERGE_TOL_RATIO);
  for (const r of runs) pg.objs.push(new PObj(id++, null, r));
  return pg;
}

// ── findSymbols ─────────────────────────────────────────────────────────────

/**
 * `Page::findSymbols`：把音乐字体的文字对象拆成 `Sym`。
 *
 * musicpp 那边靠一张写死的字体名白名单加 `getSmufl` 的码位表，
 * **认不出来整个对象就丢掉**（`if(gl.empty()) return;`）。本仓换成 `StaffGlyphLookup`
 * （轮廓聚类字典，见 staffglyphs.ts），并且**逐字形判**而不是整对象判——
 * 一次 showText 里混着认得与不认得的字形是常态。
 */
export function findSymbols(pg: SPage, look: StaffGlyphLookup): void {
  for (const o of pg.objs) {
    if (o.hasAnyTag()) continue;
    const run = o.run;
    if (!run) continue;
    if (!musicFamily(run.font)) continue;
    let i = 0;
    for (const g of run.glyphs) {
      const code = look.lookup(run.font, g, run.sizeDev);
      if (!code) continue;
      const s = new Sym(o, i++, g, code);
      o.symbols.push(s);
      pg.symbols.push(s);
    }
    if (o.symbols.length) o.addTag("Symbol");
  }
}

// ── findStaves ──────────────────────────────────────────────────────────────

/**
 * `Page::findStaves`：找出这一页的谱行。
 *
 * 两条来源，缺一不可：
 *   1. **路径谱线**（Maestro/Opus 页）：左端对齐、等距、连着五条的水平段。
 *   2. **字形谱线**（Anastasia 页）：`staff5Lines` 字形横向平铺成一行——
 *      那 115 页**一条长横路径都没有**，只走第 1 条会一无所获。
 *
 * 打击谱（`unpitchedPercussionClef2` 旁边的单条横线）照 musicpp 单独收，
 * 它的 `lineYs` 只有一条，`stepDistance()` 返回 0。
 */
export function findStaves(pg: SPage): boolean {
  const hlines = pg.segs.filter((s) => s.isH);
  const done = new Set<Seg>();

  // 1) 打击谱
  const perc: Staff[] = [];
  for (const s of pg.symbols) {
    if (s.code !== "unpitchedPercussionClef2") continue;
    for (const hl of hlines) {
      if (done.has(hl)) continue;
      if (!overlapX(hl.box, s.box) || !overlapY(hl.box, s.box)) continue;
      const stf = new Staff();
      stf.lines.push(hl);
      hl.addTag("Staff");
      stf.init();
      perc.push(stf);
      done.add(hl);
    }
  }

  // 2) 路径谱线：**以「顶线 + 线距」为假设去凑五条**，不要求候选在数组里连续。
  //
  //    musicpp 是先按「左端点 x 相同」分组再找连续五条——本书行不通，两处都会崴：
  //      · 第一线与第五线常常比中间三条往左多探出 2pt（系统线的收口），左端并不相同；
  //      · 重描合并偶尔把一条线拆成相距 0.6pt 的两簇（p185 的第五线），
  //        「连续五条」会被那个多出来的候选顶掉，整行谱就找不着。
  //    改成：拿第 i 条当顶线，试它后面几条各自当第二线定出线距 d，
  //    再去 y+2d / y+3d / y+4d 附近找线（容差 0.2d）。多出来的重复候选自然被跳过。
  //
  //    候选还要先滤一道长度：符杠（横的那些）在 `thinRectAxis` 之后也是横段，
  //    混进来会把搜索打乱。谱线是整页最长的横线，取「最长横线的 35%」当门槛。
  const maxLen = Math.max(0, ...hlines.map((l) => l.len));
  const cands = hlines.filter((l) => !done.has(l) && l.len >= maxLen * STAFF_LINE_LEN_RATIO);
  cands.sort((a, b) => a.cy - b.cy);
  const used = new Set<Seg>();
  for (let i = 0; i < cands.length; i++) {
    if (used.has(cands[i])) continue;
    let picked: Seg[] | null = null;
    for (let k = i + 1; k < Math.min(cands.length, i + 4) && !picked; k++) {
      if (used.has(cands[k])) continue;
      const d = cands[k].cy - cands[i].cy;
      // 线距既有下限也有**上限**：谱表高度就是 H，一格是 H/4。
      // 没有上限的话，吉他和弦图的品格线会被逐个系统各取一条凑成一行「谱表」
      // ——实测 p40 出过一条从 y273 拉到 y590 的假谱行，音高全废。
      if (d < pg.barlineHeight * MIN_LINE_GAP_RATIO) continue;
      if (d > pg.barlineHeight * MAX_LINE_GAP_RATIO) break;
      const five = [cands[i], cands[k]];
      let ok = true;
      // **线距要逐条重估**，不能一路拿第一段外推。低分辨率的扫描件上五条线并不匀
      //（实测望十架 p1 那行是 10 / 10.5 / 10.5 / 11 px），照第一段推到第五条，
      // 误差累到 2.0px 正好卡在 `d * 0.2` 的容差上——**差 0.02px 丢掉整行谱**
      //（那一页 10 行只出 9 行，段落随之整体错位一节）。
      // 改成拿「已经找到的那几条的平均间距」往下推，误差不再累积。
      let dd0 = d;
      for (let n = 2; n <= 4; n++) {
        const want = cands[i].cy + dd0 * n;
        let best: Seg | null = null;
        let bestD = dd0 * STAFF_LINE_TOL;
        for (const c of cands) {
          if (used.has(c) || five.includes(c)) continue;
          const dd = Math.abs(c.cy - want);
          if (dd < bestD) {
            bestD = dd;
            best = c;
          }
        }
        if (!best) {
          ok = false;
          break;
        }
        five.push(best);
        dd0 = (best.cy - cands[i].cy) / n;
      }
      if (!ok) continue;
      // x 区间要彼此大幅重叠（同一行谱的五条线跨度几乎相同）
      const left = Math.max(...five.map((l) => l.left));
      const right = Math.min(...five.map((l) => l.right));
      const shortest = Math.min(...five.map((l) => l.len));
      if (right - left < shortest * 0.8) continue;
      if (right - left < d * 4 * STAFF_ASPECT_MIN) continue;
      picked = five.sort((a, b) => a.cy - b.cy);
    }
    // ── 兜底：**连着的五条、按平均间距等距** ────────────────────────────────
    //
    // 上面那一路是「拿第一段间距往下推」，推之前先要**猜对第二线是哪一条**。
    // 低分辨率的扫描件上五条线并不匀（实测望十架 p10 那行是 11 / 15 / 12 / 12 px），
    // 第二线一取到 11 那条，第三线就推到 207、而真线在 211，差 4px 过不了容差；
    // 再往后 d 一大又撞上「线距上限」的 break，整行谱就丢了。
    // 而**按五条的平均间距判等距**（`staffline.ts::groupStaves` 那一套）分得出来：
    // 平均 12.5，四段与它各差 1.5/2.5/0.5/0.5，都在两成以内。
    // 所以这里补一条：紧挨着的五条候选，只要按平均间距算得上等距就收。
    // 放松上面那条容差（0.2 → 0.3/0.4/0.5）实测更差（真扫描件 44.57% → 44.05%）
    // ——多收进来的是别的东西，不是这一类。
    if (!picked && i + 4 < cands.length) {
      const five = cands.slice(i, i + 5);
      if (!five.some((c) => used.has(c))) {
        const ds = [1, 2, 3, 4].map((k) => five[k].cy - five[k - 1].cy);
        const avg = ds.reduce((a, b) => a + b, 0) / 4;
        const left = Math.max(...five.map((l) => l.left));
        const right = Math.min(...five.map((l) => l.right));
        const shortest = Math.min(...five.map((l) => l.len));
        if (
          avg >= pg.barlineHeight * MIN_LINE_GAP_RATIO &&
          avg <= pg.barlineHeight * MAX_LINE_GAP_RATIO &&
          ds.every((d) => Math.abs(d - avg) <= avg * STAFF_EVEN_TOL) &&
          right - left >= shortest * 0.8 &&
          right - left >= avg * 4 * STAFF_ASPECT_MIN
        )
          picked = five;
      }
    }
    if (!picked) continue;
    const stf = new Staff();
    for (const l of picked) {
      l.addTag("Staff");
      used.add(l);
      stf.lines.push(l);
    }
    stf.init();
    pg.staves.push(stf);
  }

  // 3) 字形谱线（Anastasia）
  pg.staves.push(...glyphStaves(pg));
  pg.staves.push(...perc);

  sortByTop(pg.staves);
  const dists: number[] = [];
  pg.staves.forEach((stf, i) => {
    stf.index = i;
    stf.page = pg;
    if (stf.lineYs.length <= 1) return;
    dists.push(stf.stepDistance());
  });
  dists.sort((a, b) => a - b);
  if (dists.length) {
    pg.normalStaffSpace = dists[Math.floor(dists.length / 2)] * 2;
    pg.largestSP = dists[dists.length - 1] * 2;
  }
  return pg.staves.length > 0;
}

/** `staff5Lines` 字形平铺出来的谱行（Sibelius/Anastasia 那条路）。 */
function glyphStaves(pg: SPage): Staff[] {
  const tiles = pg.symbols.filter((s) => s.code === "staff5Lines");
  if (!tiles.length) return [];
  const rows: Sym[][] = [];
  for (const t of tiles.slice().sort((a, b) => a.box.left - b.box.left)) {
    const tol = boxH(t.box) * 0.2;
    const row = rows.find((r) => Math.abs(r[0].box.top - t.box.top) < tol);
    if (row) row.push(t);
    else rows.push([t]);
  }
  const out: Staff[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.box.left - b.box.left);
    const left = row[0].box.left;
    const right = row[row.length - 1].box.right;
    const top = Math.min(...row.map((t) => t.box.top));
    const bottom = Math.max(...row.map((t) => t.box.bottom));
    const stf = new Staff();
    // 字形盒的上下沿就是第一线与第五线（`staff5Lines` 的墨迹恰好到边）
    for (let i = 0; i < 5; i++) stf.lineYs.push(top + ((bottom - top) * i) / 4);
    stf.init(left, right);
    for (const t of row) t.addTag("Staff");
    out.push(stf);
  }
  return out;
}

// ── findNoteheads ───────────────────────────────────────────────────────────

/** `Page::findNoteheads`：给每个符头/休止找它属于哪一行谱。 */
export function findNoteheads(pg: SPage): boolean {
  if (!pg.staves.length) return false;
  // 加线候选：长度**下限**一个线距、上限六个。上限只是粗筛，真正的判据在
  // `findLegers` 里按**符头宽**量——加线是给符头垫的，不会比符头宽出几倍。
  // 早先上限写死三个线距，全音符（符头有两个线距宽、加线也跟着长）的加线全被筛掉，
  // 于是 Opus 那一路谱表外的全音符整批丢掉（实测 p665 谱行0 整小节空着）。
  // 门槛本身不能去掉：吉他和弦图的格线（本书每首歌上方都有一排）会被当成加线，
  // 把图里的黑点收成谱表上方的高音符头——实测 038 首因此多出十几个 E5/C5。
  const space = pg.normalStaffSpace || pg.space;
  // **Anastasia 的加线也是字形**（同谱线、符干、小节线），路径里一条都没有。
  // 不把它们一并当成横段，谱表外的符头就永远没有加线撑着，`findLegers` 一律判否
  // ——实测那 115 页下加一线上下的 C4/B3 整批丢掉（一首歌漏十来个音）。
  // 只在本函数内部用，不推进 `pg.segs`：加线对后面几步（符干/符杠/小节线）没有意义。
  const hlines = [
    ...pg.segs.filter((s) => s.isH && !s.hasAnyTag() && s.len >= space * 0.8 && s.len <= space * 6),
    ...glyphLegers(pg),
  ];
  adoptCompositeNotes(pg);
  for (const s of pg.symbols) {
    if (!isNoteHead(s.code)) continue;
    findStaffForNote(pg, s, hlines);
  }
  return true;
}

/**
 * 复合音符字形的**符干朝向**，从字形轮廓自己看出来，不靠码位表的名字
 * （表里把朝上朝下都标成了 `…Up`，全书三个形状类里有两个其实是朝下的）。
 *
 * 办法：拿现成的 32×32 形状签名（`shapeSig`），逐行数墨迹，**最粗的那一行就是符头**
 * ——符干与符尾都只有一两格宽，符头是个实心椭圆。
 * **签名的行号是字形坐标、y 向上**（行 0 = 页面上的下沿），所以行号小 = 符头在下 = 符干朝上。
 * 拿不到轮廓时按「朝上」办（这本书里朝上的那类最常见）。
 */
function compositeStemUp(g: { outline: Float32Array | null }): boolean {
  if (!g.outline || !g.outline.length) return true;
  const sig = shapeSig(g.outline);
  const n = Math.round(Math.sqrt(sig.length));
  let bestRow = 0;
  let best = -1;
  for (let r = 0; r < n; r++) {
    let c = 0;
    for (let x = 0; x < n; x++) if (sig[r * n + x]) c++;
    if (c > best) {
      best = c;
      bestRow = r;
    }
  }
  return bestRow < n / 2;
}

/** 复合音符字形 → 时值（全音符为 1）。 */
const COMPOSITE_NOTES: Readonly<Record<string, number>> = {
  metNoteWhole: 1,
  metNoteHalfUp: 1 / 2,
  metNoteQuarterUp: 1 / 4,
  metNote8thUp: 1 / 8,
  metNote16thUp: 1 / 16,
};

/**
 * **把「符头+符干+符尾」画成一个字形的音符收编进来。**
 *
 * Anastasia 偶尔这么画（码位映到 SMuFL 里本属速度记号的 `metNote8thUp` 一族）。
 * 这种字形不在 `HEADS` 里，于是整枚被跳过——**谱面上那个音就此消失**。
 * 实测 093《黑暗中的光芒》缺的三个音全是它（p110 的 x=307/463/345），
 * 全书 29 处（`metNote8thUp` 12 + `metNoteQuarterUp` 17）。
 *
 * 两条判据：
 *  - **只收落在谱表里的**（含上下各半格，与 `findStaffForNote` 直接归属那条同口径）。
 *    谱表外的是真的速度记号 `♩= 72`——全书 133 个 `metNoteQuarterUp` 里 116 个是那一类。
 *  - **盒要收窄到符头**：符干朝上，符头在左下角，宽约一个符头、高约一个线距。
 *    音高判的是墨迹中心，拿整枚字形的中心去判会高出两三级。
 */
function adoptCompositeNotes(pg: SPage): void {
  for (const s of pg.symbols) {
    const base = COMPOSITE_NOTES[s.code];
    if (base === undefined || s.hasAnyTag()) continue;
    const stf = pg.staves.find((q) => {
      const sp = q.stepDistance() || (pg.normalStaffSpace || pg.space) / 2;
      return s.py > q.box.top - sp && s.py < q.box.bottom + sp;
    });
    if (!stf) continue;
    const space = (stf.stepDistance() || 0) * 2 || pg.normalStaffSpace || pg.space;
    const up = compositeStemUp(s.glyph);
    s.compositeBase = base;
    s.compositeStemUp = up;
    // 符干朝上 → 符头在**左下**（符尾往右上甩）；朝下 → 符头在**右上**（符干贴左边往下）。
    s.useHeadBox(
      up
        ? { left: s.box.left, right: Math.min(s.box.right, s.box.left + space * 1.15), top: s.box.bottom - space, bottom: s.box.bottom }
        : { left: Math.max(s.box.left, s.box.right - space * 1.15), right: s.box.right, top: s.box.top, bottom: s.box.top + space },
    );
    s.code = "noteheadBlack" as typeof s.code;
  }
}

/** `Page::findStaffForNote`。落在谱表纵向范围内（含上下各半格）的直接归属；
 *  否则休止取最近的一行，符头要靠**加线**确认（`findLegers`）。 */
export function findStaffForNote(pg: SPage, nt: Sym, lines: Seg[]): boolean {
  const y = nt.py;
  // 照 musicpp：`stfA` = 音符**下方**没有的那一侧，也就是音符**挂在它下面**的那行谱
  // （y 向上时 `dist<0` 即「音符在谱表中线之下」）。y 向下要反过来判，**别照抄符号**。
  let stfA: Staff | null = null; // 音符上方最近的那行谱（音符挂在它下面）
  let stfB: Staff | null = null; // 音符下方最近的那行谱（音符浮在它上面）
  let distA = Infinity;
  let distB = Infinity;
  for (const st of pg.staves) {
    const dist = y - st.cy;
    const dd = Math.abs(dist);
    let sp = st.stepDistance();
    let valid = false;
    if (sp === 0) {
      if (dd < pg.normalStaffSpace && nt.code === "restHBar") valid = true;
      sp = pg.normalStaffSpace / 2;
    }
    if (y > st.box.top - sp && y < st.box.bottom + sp) valid = true;
    if (valid) {
      nt.ownerStaff = st;
      nt.addTag("Note");
      return true;
    }
    // y 向下：dist > 0 表示音符在这行谱**下方**（谱行在音符上方）
    if (dist > 0) {
      if (dd < distA) {
        stfA = st;
        distA = dd;
      }
    } else if (dd < distB) {
      stfB = st;
      distB = dd;
    }
  }
  if (isRest(nt.code)) {
    nt.ownerStaff = distA < distB ? stfA : stfB;
    if (nt.ownerStaff) {
      nt.addTag("Note");
      return true;
    }
    return false;
  }
  // **先试音符上方那行**（照 musicpp 的次序）。反过来的话，大谱表里挂在顶行下沿的音符
  // 会先去试下面那行谱，归错行——实测多行系统的顶行小节自检因此只有 43.9%，
  // 而下行反而多出一截时值。
  // 但离下面那行近一倍以上的先试下面：两行谱之间的歌词、简谱字的横笔也横跨符头、长短合格，
  // 挂在下行谱上方两条加线的头会被上行谱「数够」七条加线收走（所信有根基 m12 E♭4 读成 D♭2）
  if (stfB && distB * 2 < distA && findLegers(nt, stfB, lines)) return true;
  if (stfA && findLegers(nt, stfA, lines)) return true;
  if (stfB && findLegers(nt, stfB, lines)) return true;
  return false;
}

/** `Page::findLegers`：谱表外的符头要有足够多条加线撑着才认。 */
export function findLegers(nt: Sym, stf: Staff, lines: Seg[]): boolean {
  const y2 = stf.cy;
  const stepDist = stf.stepDistance();
  // 往谱表反方向再让半格，免得贴着符头的那条加线被区间端点切掉
  const y1 = nt.py > y2 ? nt.py + stepDist : nt.py - stepDist;

  const poss: Seg[] = [];
  for (const l of lines) {
    // 加线要**横跨**符头（musicpp 只比左端点，那是因为它的加线对象与符头同起点；
    // 本书的加线两端都伸出符头，只比左端会把附近别的短横线也算进来）
    if (nt.px < l.left || nt.px > l.right) continue;
    // 加线按**符头宽**量：黑符头一格出头、全音符两格，加线各自跟着长。
    // 按线距写死一个上限，全音符那一档就整批落选。
    if (l.len > (nt.box.right - nt.box.left) * 3) continue;
    if (between(l.cy, y1, y2)) poss.push(l);
  }
  // **整数除**：musicpp 是 `abs(step)/2-2`，C++ 的整数除法让 |step| ≤ 5 时 need ≤ 0
  // ——谱表外一两级的音符（下加一间的 D4、上加一间的 G5）不需要加线就收，
  // 因为它们本来就没有加线。移植成浮点除再加一道 `need > 0` 的闸，
  // 这些音符会全被丢掉；丢掉的符头连带它的符干也无人认领，那根符干随后被当成小节线
  // （实测 p100 的 x=409 就是这么来的）。
  const need = Math.floor(Math.abs(stf.middleStep(nt.py)) / 2) - 2;
  // 要三条以上加线的，只数从谱表边缘起**按线距连成一串**的：谱表间歌词、简谱字的横笔也横跨符头、长短合格，
  // 会替离谱表很远的假头「数够」加线。两条以内不查：和弦里错开的头，近谱表那条加线只横跨旁边那个头
  //（向主唱新歌 m7 A3 下面的 C4 线只跨 C♯4）
  if (need >= 3) {
    const sp = stepDist * 2;
    const down = nt.py > y2;
    let at = down ? stf.box.bottom : stf.box.top;
    let chain = 0;
    for (const l of poss.slice().sort((a, b) => (down ? a.cy - b.cy : b.cy - a.cy))) {
      const gap = down ? l.cy - at : at - l.cy;
      if (gap < sp * 0.5) continue;
      if (gap > sp * 1.4) break;
      chain++;
      at = l.cy;
    }
    if (chain < need) return false;
  }
  if (poss.length >= need) {
    nt.ownerStaff = stf;
    for (const it of poss) it.addTag("Leger");
    nt.addTag("Note");
    return true;
  }
  return false;
}

// ── findStems / findTails ───────────────────────────────────────────────────

/**
 * **小节线后紧跟着的第一个音**：头的左缘贴着竖线、落在它下端，竖线两端又正好压在谱表的第五线与第一线上
 * （各 ±0.25 格）——那是小节线，不是这个头的干（朝上的干挂在右缘）。
 * 我一生要赞美你第三行 E4 二分音符、第四行 F4，头左缘贴着小节线，那几条被抢成了符干。
 * 三个条件缺一不可：放宽成「朝下的干挂左缘、朝上的挂右缘」试过，闭合谱里朝下挂右缘、
 * 左缘挂着短干的真符干大把（万古磐石歌 15 根，满拍 27.3 → 24.2%）；不看两端则会拦掉
 * 头落在第一线下、干从左缘伸到第五线的真符干（我一生要赞美你第一行的连桁八分）。
 */
export function isLeadNoteBarline(l: Seg, nt: Sym, stf: Staff): boolean {
  const sp = stf.stepDistance() * 2;
  if (!sp) return false;
  const cy = (nt.box.top + nt.box.bottom) / 2;
  if (Math.abs(cy - l.bottom) > sp || Math.abs(cy - l.top) <= sp) return false;
  if (Math.abs(nt.box.left - l.cx) >= Math.abs(nt.box.right - l.cx)) return false;
  return Math.abs(l.top - stf.box.top) <= sp * 0.25 && Math.abs(l.bottom - stf.box.bottom) <= sp * 0.25;
}

/** 窄头挂干窗口的下限（格），与算窄的盒宽（格）。 */
const STEM_WIN_MIN = 0.3;
const STEM_WIN_NARROW = 1.15;

/**
 * `Page::findStems`：符头左右两侧、纵向相交的竖线就是符干。
 *
 * 两种画法都要认，而且**都要落成 `Seg`**：
 *   1. 路径竖线（Maestro/Opus 页）。
 *   2. Anastasia 的 `stem` 字形——**符干是一个线距高的竖段沿 y 堆出来的**。
 *      不把它们拼成 Seg 的话，那 115 页一根符干都取不到，于是
 *      「八分音符读成四分、二分音符读成全音符」（实测时值混淆里最大的两项）。
 */
export function findStems(pg: SPage): void {
  // 先把 Anastasia 的符干字形拼成竖段，拼好的段与路径竖线一视同仁
  pg.segs.push(...glyphStems(pg));

  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag());
  for (const nt of pg.symbols) {
    if (!nt.ownerStaff) continue;
    if (nt.code !== "noteheadBlack" && nt.code !== "noteheadHalf") continue;
    const stf = nt.ownerStaff;
    const space = stf.stepDistance() * 2 || pg.space;
    // 窄头（小字号，盒宽不到 `STEM_WIN_NARROW` 格）窗口下限 0.3 格：细线页两倍线宽只有 4 像素，
    // 小字号头的盒右缘离自己的干 5 像素（以马内利来临歌 m23 附点二分读成全音符）。
    // 不分宽窄都放，宁静的伯利恒少一个满拍小节
    const narrow = nt.box.right - nt.box.left < space * STEM_WIN_NARROW;
    const lw = Math.max((stf.lines[0]?.lw ?? pg.barlineHeight * 0.02) * 2, narrow ? space * STEM_WIN_MIN : 0);
    // 试过一条「两端正好压在第五线与第一线上的竖线是小节线、不是符干」的判据，
    // **实测更差**（全书小节自检 80.1% → 75.9%）：符头落在第一线、符干朝上伸到第五线
    // 的情形太常见，那条会把大批真符干判掉。留着这行注释，别再试第二遍。
    // **每一侧只挂离缘最近的那几根**（差不过半个窗口）：窗口是谱线粗的两倍，粗线的低分辨率图上有十来个像素，
    // 头自己的干贴着缘、紧跟着的小节线也还在窗口里，两根都挂上就把小节线抢成了符干
    // （我一生要赞美你第一行，C4 头右缘离干 2px、离小节线 11px、窗口 12px，四条小节线全丢）。
    // 差不多远的都挂：同一根干被符杠切成同 x 的两截，或矢量路一根干拆成错开一点的两段
    // （只挂最近一根时坚固保障时值 −1.5、矢量路时值 −0.01）。
    const cand: { l: Seg; side: number; d: number }[] = [];
    for (const l of vlines) {
      const dl = Math.abs(nt.box.left - l.cx), dr = Math.abs(nt.box.right - l.cx);
      if (dl >= lw && dr >= lw) continue;
      if (!overlapY(l.box, nt.box)) continue;
      // **符头要在符干的某一端**，不能在中间：小节线也常常擦着符头过，
      // 那时符头落在它跨度的中段。不加这条，真小节线会被当成符干抢走
      // （实测 p227 每行只剩三个小节，音符全挤在一起）。
      const cy = (nt.box.top + nt.box.bottom) / 2;
      const side = dl <= dr ? 0 : 1;
      if (Math.abs(cy - l.top) > space && Math.abs(cy - l.bottom) > space) continue;
      if (side === 0 && isLeadNoteBarline(l, nt, stf)) continue;
      cand.push({ l, side, d: Math.min(dl, dr) });
    }
    // **并排重叠的两根里，两端正好压在第五线与第一线上的那根不挂**：同一侧并排两根不可能都是这个头的干
    // （符杠切开的两截纵向是错开的），挂两端离谱表外线远的那根，像小节线的留给小节线——
    // 坚固保障第三行，头盒右缘把旁边的小节线也框进来，干离缘 3.0、小节线 3.5，按远近分不开。
    // 不卡「像小节线」、并排重叠的一律只挂一根，合唱谱扫描件音符 −0.12（粗干断成并排两截）。
    const edge = (l: Seg) => Math.abs(l.top - stf.box.top) + Math.abs(l.bottom - stf.box.bottom);
    for (const side of [0, 1]) {
      const cs = cand.filter((c) => c.side === side);
      const dMin = Math.min(...cs.map((c) => c.d));
      const near = cs.filter((c) => c.d <= dMin + lw * 0.5).sort((p, q) => edge(q.l) - edge(p.l));
      const kept: Seg[] = [];
      for (const c of near) {
        const barShaped = Math.abs(c.l.top - stf.box.top) <= space * 0.25 && Math.abs(c.l.bottom - stf.box.bottom) <= space * 0.25;
        if (barShaped && kept.some((k) => Math.min(k.bottom, c.l.bottom) - Math.max(k.top, c.l.top) > Math.min(k.len, c.l.len) * 0.5)) continue;
        kept.push(c.l);
        c.l.addTag("Stem");
      }
    }
  }
}

/** `legerLine` 字形 → 横段（Anastasia 一路）。一个字形就是一条加线，不必拼。 */
function glyphLegers(pg: SPage): Seg[] {
  return pg.symbols
    .filter((s) => s.code === "legerLine")
    .map((s) => {
      const y = (s.box.top + s.box.bottom) / 2;
      return new Seg(s.parent, s.box.left, y, s.box.right, y, Math.max(s.box.bottom - s.box.top, 0.3));
    });
}

/** `stem` 字形 → 竖段：按 x 归列，列内纵向相接的一串并成一条。 */
function glyphStems(pg: SPage): Seg[] {
  const tiles = pg.symbols.filter((s) => s.code === "stem");
  if (!tiles.length) return [];
  for (const t of tiles) t.addTag("Stem");
  const xTol = pg.barlineHeight * 0.02; // 同一根符干的各段 x 完全相同，容差只为浮点
  const cols = new Map<number, Sym[]>();
  for (const t of tiles) {
    const k = Math.round((t.box.left + t.box.right) / 2 / Math.max(xTol, 1e-3));
    const a = cols.get(k) ?? [];
    a.push(t);
    cols.set(k, a);
  }
  const out: Seg[] = [];
  for (const col of cols.values()) {
    col.sort((a, b) => a.box.top - b.box.top);
    let run: Sym[] = [];
    const flush = () => {
      if (!run.length) return;
      const top = Math.min(...run.map((t) => t.box.top));
      const bottom = Math.max(...run.map((t) => t.box.bottom));
      const x = (run[0].box.left + run[0].box.right) / 2;
      const w = run[0].box.right - run[0].box.left;
      out.push(new Seg(run[0].parent, x, top, x, bottom, Math.max(w, 0.3)));
      run = [];
    };
    for (const t of col) {
      if (run.length) {
        const prevBottom = Math.max(...run.map((q) => q.box.bottom));
        // 相接（含轻微重叠）才算同一根；隔开的是另一根符干
        if (t.box.top > prevBottom + (t.box.bottom - t.box.top) * 0.5) flush();
      }
      run.push(t);
    }
    flush();
  }
  return out;
}

/** `Page::findTails`：符尾挂在与它同 x、纵向相交的符干上。 */
export function findTails(pg: SPage): boolean {
  const stems = pg.segsWithTag("Stem");
  let found = false;
  for (const t of pg.symbols) {
    if (!isFlag(t.code)) continue;
    for (const l of stems) {
      if (Math.abs(l.box.left - t.box.left) > l.lw) continue;
      if (!overlapY(t.box, l.box)) continue;
      found = true;
      t.addTag("Tail");
      break;
    }
  }
  return found;
}

// ── findBarlines ────────────────────────────────────────────────────────────

/** `Page::findBarlines`：竖线中，上端到第五线、下端到第一线的那些是小节线；
 *  与谱表左端重合的是系统线（`SysLine`），不算小节线。 */
export function findBarlines(pg: SPage): boolean {
  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag());
  const syslines: Seg[] = [];
  for (const l of vlines) {
    let isSys = false;
    for (const st of pg.staves) {
      if (Math.abs(st.box.left - l.cx) < Math.max(l.lw, 1)) isSys = true;
    }
    if (isSys) {
      l.addTag("SysLine");
      syslines.push(l);
    }
  }

  // 小节线 = **纵向盖满某一行谱**的竖线。
  //
  // musicpp 判的是「上端正好在第五线、下端正好在第一线」（`middleStep` 恰为 ±4）。
  // 那条在大谱表上不成立：钢琴/SATB 的小节线**贯穿两行谱**，对上面那行来说下端远在 −4 之外
  // ——实测 Opus 那 68 页（都是大谱表）因此一条小节线都没认出来，整页只切出一个小节。
  // 改判「盖满」：上端不低于第五线、下端不高于第一线，容差半格。
  /** 竖段有一端伸出这行谱 0.3 格以上、又没落在任何一行谱的外线上。 */
  const overshoots = (l: Seg, st: Staff): boolean => {
    const out = (s2: Staff) => (s2.stepDistance() || 1) * 0.6;
    const lands = (y: number) => pg.staves.some((s2) => Math.abs(y - s2.box.top) <= out(s2) || Math.abs(y - s2.box.bottom) <= out(s2));
    return (l.top < st.box.top - out(st) && !lands(l.top)) || (l.bottom > st.box.bottom + out(st) && !lands(l.bottom));
  };
  const topStaff = new Map<Seg, Staff>();
  const covers = new Set<Seg>();
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && !isRest(s.code));
  const stems = pg.segsWithTag("Stem");
  for (const l of vlines) {
    if (l.hasAnyTag()) continue;
    // **贴着某个符头左右缘的竖线是符干，不是小节线**。`findStems` 已经标过一遍，
    // 但它按「符头 → 找符干」走，符头没归到谱行上时那根符干就漏标了；
    // 这里按「竖线 → 找符头」再挡一道（实测 p100 的 x=409 就是这么混进来的）。
    // 唯一放行的一种：头只是**左缘贴着、落在下端**（小节线后紧跟着的第一个音，符干朝上、头在第一线附近），
    // 那不是它的干。别的配法照旧挡：放宽成「缘与端配得上才算干」试过，多声部闭合谱里头挂在另一侧、
    // 或落在干中段的真符干被收成小节线（晨曦破晓、有一位神、万口欢唱、齐来谢主歌各多切一两刀）。
    const sp = pg.normalStaffSpace || pg.space;
    const stemOf = (h: Sym) => {
      if (!overlapY(l.box, h.box)) return false;
      const atL = Math.abs(h.box.left - l.cx) < l.lw * 2, atR = Math.abs(h.box.right - l.cx) < l.lw * 2;
      if (!atL && !atR) return false;
      const cy = (h.box.top + h.box.bottom) / 2;
      const leadNote = atL && !atR && Math.abs(cy - l.bottom) <= sp && Math.abs(cy - l.top) > sp;
      if (leadNote) return false;
      // 头**已经挂了干**（`findStems` 挂的），这根就不是它的干：并排两根只挂一根（坚固保障第三行，
      // 干与紧挨着的小节线都贴右缘），或干在另一侧、小节线擦着左缘（有一位神第一行 x=446，头落在谱表中段）
      const edgeOf = (s: Seg) => Math.min(Math.abs(h.box.left - s.cx), Math.abs(h.box.right - s.cx));
      return !stems.some((s) => s !== l && edgeOf(s) < l.lw * 2 && overlapY(s.box, h.box));
    };
    if (heads.some(stemOf)) continue;
    for (const st of pg.staves) {
      // 容差取**四分之一格**：小节线的两端正落在第一线与第五线上。
      // 放宽到半格的话，从低音伸到符杠的长符干也会「盖满」谱行，被当成小节线
      // （实测 p100 因此在 x=409 处凭空多出一条）。
      const tol = (st.stepDistance() || 1) * 0.5;
      // **整条平移了的**也算：扫描件轻微倾斜，谱线却按水平直线建模，行右端的小节线整体偏上
      // （数算主恩第四行往右斜 4.5px，x=1218 那条上端 −0.10、下端差 0.31 格够不着第一线）。
      // 两端离第五线、第一线都不过 0.4 格，长度仍要够一个谱表高（差不到四分之一格）；
      // 符干的下端在头中心，头只落在线上或间里（0 或 0.5 格），碰不上这个口子。
      // 上端不卡的话，从谱表上方一格多伸下来的长符干也进来（齐来谢主歌、父恩广大各多切一刀）。
      const shifted =
        l.len >= boxH(st.box) - tol && Math.abs(l.top - st.box.top) <= tol * 1.6 && Math.abs(l.bottom - st.box.bottom) <= tol * 1.6;
      if ((l.top <= st.box.top + tol && l.bottom >= st.box.bottom - tol) || shifted) {
        // **伸出谱表的那一端要落在某行谱的外线上**：真小节线两端压在第五线、第一线上，
        // 伸出去也只伸到大谱表另一行的外线。和弦的符干上端高出一格、或两头各伸出 0.3~0.4 格，
        // 头是认不出的「8」字形空心三度，贴头那道闸拦不住（我灵镇静多切四刀）。
        if (overshoots(l, st)) break;
        topStaff.set(l, st);
        covers.add(l);
        break;
      }
    }
  }

  // **多行系统里，小节线不会只在一行上有**：只在一行上「盖满」、别的行那个位置都没有像样的竖线，
  // 是和弦的长干（新编赞美诗 3 万世之宗歌第二行高音谱表，B3–D5 的干上下都压在外线上，
  // 高音谱表多切一刀、低音谱表没切，这一行两个谱表从此错开一小节）。
  // 别的行上的那一根不论挂没挂成符干都算（挂错的由 `tagSystemBarlines` 先行纠正，这里只求别误删）。
  // 只要**有一行**对得上就留：扫描件上四五行的系统，总有一两行的小节线断得不成样子，
  // 要求行行都有的话真小节线成批丢（合唱谱扫描档满拍 65.8 → 62.1）。
  {
    const groups = systemGroups(pg).filter((g) => g.length >= 2);
    const allV = pg.segs.filter((s) => s.isV);
    for (const l of [...covers]) {
      const ts = topStaff.get(l)!;
      const g = groups.find((x) => x.includes(ts));
      if (!g) continue;
      const sp = ts.stepDistance() * 2 || pg.space;
      const spans = (m: Seg, st: Staff) => m.top <= st.box.top + sp * 0.25 && m.bottom >= st.box.bottom - sp * 0.25;
      // 没挂成符干、压着那一行够半个谱表高的也算：小节线被符头、字压断成两截时没有哪一截盖满
      //（颂主化功歌第一行高音谱表的小节线都是半截的，靠下面「短小节线」那一步按同 x 收回来）
      const half = (m: Seg, st: Staff) => !m.hasTag("Stem") && Math.min(m.bottom, st.box.bottom) - Math.max(m.top, st.box.top) >= boxH(st.box) * 0.5;
      if (!g.some((st) => st !== ts && (spans(l, st) || allV.some((m) => m !== l && Math.abs(m.cx - l.cx) <= sp * 0.6 && (spans(m, st) || half(m, st)))))) covers.delete(l);
    }
  }

  let found = false;
  const barX: { x: number; st: Staff }[] = [];
  // `tagSystemBarlines` 先定下的也进表（短小节线按同 x 补收要用）
  for (const l of pg.segs) {
    if (!l.isV || !l.hasTag("BarLine")) continue;
    const st = pg.staves.find((q) => l.top <= q.box.bottom && l.bottom >= q.box.top);
    if (st) (barX.push({ x: l.cx, st }), (found = true));
  }
  for (const it of covers) {
    const ts = topStaff.get(it)!;
    // 与谱表左端重合的是系统线，不算小节线
    if (Math.abs(ts.box.left - it.cx) >= Math.max(it.lw, 1)) {
      it.addTag("BarLine");
      barX.push({ x: it.cx, st: ts });
    }
    found = true;
  }

  // 短小节线（只跨一部分谱表的，如钢琴谱中间那截）：与**同一系统**里已认小节线同 x 的收进来。
  // 只在多行谱的系统里补：单行谱的小节线必须自己盖满谱表，别的系统同 x 有小节线只是版式巧合，
  // 按整页收会把上端高出半格的符干也收成小节线（《父恩广大》第一行 x=938 多切一刀）。
  // **长度要够**（至少半个谱表高）：同 x 会把一两 pt 长的碎段也收成小节线，`classifyBarlines`
  // 随后就在那儿切一刀（实测 p351 因此一行切出 14 个小节）。
  const sysOf = new Map<Staff, Staff[]>();
  for (const g of systemGroups(pg)) if (g.length >= 2) for (const st of g) sysOf.set(st, g);
  const minLen = Math.min(...pg.staves.map((s) => boxH(s.box))) * 0.5;
  const gapTol = (pg.normalStaffSpace || pg.space) * 0.5;
  for (const l of vlines) {
    if (l.hasAnyTag()) continue;
    if (l.len < minLen) continue;
    // **位置也要对**：要么压在某行谱上（重叠够半个谱表高），要么夹在两行谱之间、两端贴着上下两行
    // （钢琴谱中间那截）。位图上别的竖笔（升号的竖笔连着符干）落在谱表下方歌词带里、
    // 与别处小节线同 x，也够长，就被收成小节线（《来敬拜荣耀王》第 9 小节高音谱表因此多切一刀，后面整行错一个小节）。
    const onStaff = pg.staves.filter((st) => Math.min(l.bottom, st.box.bottom) - Math.max(l.top, st.box.top) >= minLen);
    const between = pg.staves.filter((a) => Math.abs(l.top - a.box.bottom) <= gapTol && pg.staves.some((b) => b !== a && Math.abs(l.bottom - b.box.top) <= gapTol));
    const sys = [...onStaff, ...between].map((st) => sysOf.get(st)).find((g) => g);
    if (!sys) continue;
    if (barX.some((b) => sys.includes(b.st) && Math.abs(l.cx - b.x) < Math.max(l.lw, 1))) l.addTag("BarLine");
  }

  // Anastasia：小节线是字形
  for (const s of pg.symbols) {
    if (s.code === "barlineSingle" || s.code === "barlineFinal" || s.code === "barlineDouble") s.addTag("BarLine");
  }
  void syslines;
  return found;
}

/**
 * **大谱表上下两行同 x 都盖满谱行的竖线，先定成小节线**（位图路在 `findStems` 之前调）。
 *
 * 闭合谱（SATB 两行）的小节线上下两行各画一截、x 对齐。`findStems` 先于 `findBarlines`，
 * 小节线后紧跟的头、或小节线前贴着的头会把它抢成符干（新编赞美诗 6 赞美三一歌第二行低音谱表，
 * 行首弱起两个八分的头右缘贴着小节线），那一行从此少一条小节线，后面整行与另一行错开一个小节。
 * 单看一行分不开「两端压在外线上的符干」与小节线（`findStems` 里那条注释试过，更差）；
 * 但**同一系统每一行在同一 x 都有一根两端压在外线上的竖线**，就只能是小节线。
 * 只管由左端标记连起来的多行系统；与谱表左端重合的（系统线）不动。
 */
export function tagSystemBarlines(pg: SPage): void {
  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag());
  for (const g of systemGroups(pg)) {
    if (g.length < 2) continue;
    const sp = g[0].stepDistance() * 2 || pg.space;
    const tol = sp * 0.3;
    const lands = (y: number) => g.some((st) => Math.abs(y - st.box.top) <= tol || Math.abs(y - st.box.bottom) <= tol);
    /** 这根竖线盖满 st、两端都落在本系统某行的外线上 */
    const barOn = (l: Seg, st: Staff) =>
      l.top <= st.box.top + tol && l.bottom >= st.box.bottom - tol && lands(l.top) && lands(l.bottom) && Math.abs(st.box.left - l.cx) >= Math.max(l.lw, 1) * 2;
    const per = g.map((st) => vlines.filter((l) => barOn(l, st)));
    // 上下两行的 x 容 0.6 格：扫描件歪一点，隔着十几格歌词的两行就错开三四个像素（赞美三一歌 234 对 230）；
    // 小节线与相邻的干至少隔一格
    const xTol = sp * 0.6;
    for (const l of per[0]) {
      const mates = per.map((ls) => ls.filter((m) => Math.abs(m.cx - l.cx) <= xTol));
      if (mates.some((ms) => !ms.length)) continue;
      for (const ms of mates) for (const m of ms) if (!m.hasAnyTag()) m.addTag("BarLine");
    }
  }
}

// ── makeSystems ─────────────────────────────────────────────────────────────

/**
 * `Page::makeSystems`：把谱行归成**系统**。
 *
 * musicpp 靠 `SysLine`（谱行左端那条竖线）串：一条系统线纵向盖住的几行谱是一个系统。
 * 本书还要补一条：Anastasia 那 115 页的系统左端画的是 `bracket` **字形**、不是路径竖线，
 * 只认路径会把 SATB 的四行谱各算一个系统。没有任何左端标记的（独唱谱）各自成系统。
 */
export function makeSystems(pg: SPage): void {
  for (const arr of systemGroups(pg)) {
    const sys = new SSystem();
    sys.staves = arr;
    sys.init();
    pg.systems.push(sys);
  }
  pg.systems.sort((a, b) => a.box.top - b.box.top);
  pg.systems.forEach((s, i) => (s.index = i));
}

/** 系统内断开处的空白上限：本页系统间距的几倍（见 `joinByGap`）。 */
const SYS_BREAK_GAP = 0.8;

/** 谱行按系统分组（各组内自上而下）。`makeSystems` 与 `findBarlines` 的短小节线补收共用。 */
export function systemGroups(pg: SPage): Staff[][] {
  const marks: Box[] = [
    ...pg.segsWithTag("SysLine").map((s) => s.box),
    ...pg.symbols.filter((s) => s.code === "bracket" || s.code === "brace").map((s) => s.box),
    // 位图路的系统括号（`findSystemBrackets`）：方括号的上下衬线会把粗竖笔与
    // 细系统线连成一块，那一块过不了竖笔画的宽度闸，`SysLine` 一条都抽不出来。
    ...pg.objs.filter((o) => o.hasTag("SysBracket")).map((o) => o.box),
  ];
  const done = new Set<Staff>();
  const out: Staff[][] = [];
  // **罩得多的先分**：同一个系统上既有罩全系统的方括号、也有罩钢琴两行的花括号，
  // 先来后到会让花括号先把那两行占走，剩下的行各自成系统（实测望十架 p3
  // 四行的系统因此裂成「2 + 1 + 1」）。
  marks.sort((a, b) => pg.staves.filter((st) => overlapY(st.box, b)).length - pg.staves.filter((st) => overlapY(st.box, a)).length);
  for (const b of marks) {
    const arr = pg.staves.filter((st) => overlapY(st.box, b));
    if (arr.length < 2) continue; // 只盖住一行的左端线不构成「系统」，留给下面各自成系统
    if (arr.some((st) => done.has(st))) continue;
    out.push(arr.slice().sort((a, b2) => a.box.top - b2.box.top));
    for (const st of arr) done.add(st);
  }
  for (const st of pg.staves) if (!done.has(st)) out.push([st]);
  return joinByGap(out);
}

/**
 * **系统线、括号断开的地方按间距并回去**：系统之间的空白比系统内断开处大。扫描件上钢琴两行左边的
 * 系统线和花括号没印出来（望十架扫描版 p10 第二系统，纸面污损），按左端标记分成了 3 + 1 + 1。
 * 系统间距取本页**两个相邻的多行系统**（都由左端标记连起来）之间最小的空白；没有左端标记的单行，
 * 与上一组或下一组的空白小于它的 `SYS_BREAK_GAP` 倍，就是同一系统里断开的，并过去。
 * 不拿系统内的最大空白当上限：人声行下面带歌词，系统内空白常比系统之间还大（宁静、破碎整页并乱）。
 */
function joinByGap(groups: Staff[][]): Staff[][] {
  const gs = groups.slice().sort((a, b) => a[0].box.top - b[0].box.top);
  const gapOf = (a: Staff[], b: Staff[]) => b[0].box.top - a[a.length - 1].box.bottom;
  let inter = Infinity;
  for (let i = 1; i < gs.length; i++) if (gs[i - 1].length > 1 && gs[i].length > 1) inter = Math.min(inter, gapOf(gs[i - 1], gs[i]));
  if (!isFinite(inter)) return gs;
  const out: Staff[][] = [];
  for (const g of gs) {
    const prev = out[out.length - 1];
    if (prev && (prev.length === 1 || g.length === 1) && gapOf(prev, g) < inter * SYS_BREAK_GAP) prev.push(...g);
    else out.push(g.slice());
  }
  return out;
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

/** `Page::removeWhite`：纯白填充是排版软件铺的底衬，原件上看不见，别当墨迹。 */
export function removeWhite(pg: SPage): void {
  pg.objs = pg.objs.filter((o) => !(o.path && isWhite(o.path) && !o.hasAnyTag()));
}

/**
 * `Page::markUnknown`：还没有主的对象。这个数是识别覆盖率的硬指标。
 *
 * 「有主」有三种：对象自己带标记（文字对象）、对象拆出来的**任一段**带标记
 * （谱线/符干/小节线都挂在段上）、对象拆出来的字形里有认出来的符号。
 */
export function unknownObjs(pg: SPage): PObj[] {
  const owned = new Set<PObj>();
  for (const s of pg.segs) if (s.hasAnyTag()) owned.add(s.obj);
  return pg.objs.filter((o) => !o.hasAnyTag() && !owned.has(o));
}

/** 还没有主的**线段**。段级覆盖率——比对象级细，动几何判据时看它。 */
export function unknownSegs(pg: SPage): Seg[] {
  return pg.segs.filter((s) => !s.hasAnyTag());
}

/** 谱表的小节：由已认的小节线切开。`System::makeBars` 的页面级前身。
 *  小节线的**样式与反复**由 `barlines.ts` 归组后给出，这里顺带记到 `Bar` 上。 */
export function makeBars(pg: SPage): void {
  /** 右端没有小节线收口的末条（最后一根小节线到谱线右端那一截）。 */
  const openTail = new Set<Bar>();
  for (const stf of pg.staves) {
    const marks = classifyBarlines(pg, stf);
    tagRepeatDots(pg, stf, marks);
    const xs = marks.map((m) => m.x);
    let left = stf.box.left;
    let pendingLeftRepeat = false;
    // 一行谱的第一小节，左端反复要从**上一行末尾**接过来（跨行的 `|:` 印在行首）
    let prevLeftRepeat = marks[0]?.repeat === "forward" || marks[0]?.repeat === "both";
    // **两条小节线挨得比两个线距还近，就是同一处**（细+粗的终止线、反复线的两笔）。
    // 原先用半个线距当门槛，实测会在终止线处切出一个 4pt 宽、一个音符都没有的空小节。
    const minBar = (stf.stepDistance() || 1) * 4;
    for (const x of xs) {
      if (x - left < minBar) {
        left = x;
        continue;
      }
      const bar = new Bar(stf);
      bar.left = left;
      bar.right = x;
      const mk = marks.find((m) => m.x === x);
      bar.rightStyle = mk?.style ?? null;
      bar.rightRepeat = mk?.repeat === "backward" || mk?.repeat === "both";
      // `|:` 记在**下一小节**的左端（MusicXML 的 forward repeat 挂在 location="left"）
      pendingLeftRepeat = mk?.repeat === "forward" || mk?.repeat === "both";
      bar.leftRepeat = prevLeftRepeat;
      prevLeftRepeat = pendingLeftRepeat;
      stf.bars.push(bar);
      left = x;
    }
    if (stf.box.right - left > minBar) {
      const bar = new Bar(stf);
      bar.left = left;
      bar.right = stf.box.right;
      bar.leftRepeat = prevLeftRepeat;
      stf.bars.push(bar);
      openTail.add(bar);
    }
    void pendingLeftRepeat;
    for (const s of pg.symbols) {
      if (!s.hasTag("Note") || s.ownerStaff !== stf) continue;
      const b = stf.bars.find((x) => s.px >= x.left && s.px < x.right);
      if (b) b.notes.push(s);
    }
    // **一行的头尾若切出一个空条，那不是小节。**
    //   行首：谱行左端到第一根小节线之间只有谱号/调号/拍号——曲子起头印 `|:` 的
    //         （或每行行首都画一根线的）就会白白多出一个小节，全书好些曲子的
    //         「小节数比 GT 多一个」都是它。
    //   行末：终止线/复纵线到谱线右端还剩一小截（实测 p101 第二行剩 13pt）。
    // 休止也带 `Note` 标记，所以「一个都没有」是真的空——整小节休止不会被误删。
    // 只动头尾两条，中间的空条留着（那多半是真读漏了，删掉反而看不见）。
    for (const b of stf.bars) sortByLeft(b.notes);
  }
  // **多行系统里头尾的空条要各行一起删**：只有一行空（那一行弱起的音、末小节的音没认出来），
  // 单删它这一行就比别的行少一个小节，整行与别的行错开（新编赞美诗 104 复活良辰歌第二、三系统）。
  // 各行的小节线对得上（头一条的右界 / 末一条的左界相差不过一格）才按系统判；对不上的照旧各删各的。
  for (const g of systemGroups(pg)) {
    const sp = g[0].stepDistance() * 2 || pg.space;
    const dropHead = (stf: Staff) => {
      const gone = stf.bars.shift()!;
      // 删掉的那一条右端若是粗笔（`|:` 的 heavy-light），把样式挪到新的首小节左端。
      if (gone.rightStyle && !stf.bars[0].leftStyle) {
        stf.bars[0].leftStyle = gone.rightStyle === "light-heavy" ? "heavy-light" : gone.rightStyle;
      }
    };
    for (;;) {
      const emptyHead = (stf: Staff) => stf.bars.length > 1 && !stf.bars[0].notes.length;
      const cand = g.filter(emptyHead);
      if (!cand.length) break;
      const aligned = g.every((stf) => stf.bars.length > 1 && Math.abs(stf.bars[0].right - g[0].bars[0].right) <= sp);
      if (aligned && cand.length < g.length) break; // 别的行这一小节有音：留着
      // 对不齐时只删**别的行没有对应小节**的那几条：一行的头尾多出一截零头（终止线到谱线右端的一小段）时各行就对不齐，
      // 照旧全删会把另一行真的空小节（整小节休止没认出来，别的行同处有音）一起删掉，那一行从此少一个小节（是爱 p5 男声行）
      const drop = aligned ? cand : cand.filter((stf) => !g.some((o) => o !== stf && !emptyHead(o) && o.bars.length > 1 && Math.abs(o.bars[0].right - stf.bars[0].right) <= sp));
      if (!drop.length) break;
      for (const stf of drop) dropHead(stf);
    }
    for (;;) {
      // **右端有小节线收口的末条是真小节**，空着是里面的音没认出来（数算主恩第二行末小节一个淡印的二分音符），
      // 与中间的空条一样留着；删的只是最后一根小节线到谱线右端那一截零头。单行的系统才这么分——
      // 多行系统各行一起空的收口末条照旧删（行末预告调号、拍号前那一根线切出来的）
      const emptyTail = (stf: Staff) =>
        stf.bars.length > 1 && !stf.bars[stf.bars.length - 1].notes.length && (g.length > 1 || openTail.has(stf.bars[stf.bars.length - 1]));
      const cand = g.filter(emptyTail);
      if (!cand.length) break;
      const aligned = g.every((stf) => stf.bars.length > 1 && Math.abs(stf.bars[stf.bars.length - 1].left - g[0].bars[g[0].bars.length - 1].left) <= sp);
      if (aligned && cand.length < g.length) break;
      const drop = aligned ? cand : cand.filter((stf) => !g.some((o) => o !== stf && !emptyTail(o) && o.bars.length > 1 && Math.abs(o.bars[o.bars.length - 1].left - stf.bars[stf.bars.length - 1].left) <= sp));
      if (!drop.length) break;
      for (const stf of drop) stf.bars.pop();
    }
  }
}
