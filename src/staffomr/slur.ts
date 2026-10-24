// 圆滑线与连音线。移植自 musicpp `qtomr/qomr.cpp::findSlurTies` 与
// `qtomr/NoteData.cpp::analyzeSlurTie` / `SlurTie::checkTie`。
//
// 坐标一律设备坐标、y 向下——原文是 y 向上，纵向判据逐处翻过来了，见每处注释。
import { type Box, PObj, SPage, Seg, type Staff, overlapX, ySpace } from "./model";
import { pathPoints, subPaths } from "./vecgeom";
import type { StaffNote } from "./notedata";

/** 一条弧。 */
export interface SlurArc {
  obj: PObj;
  /** 最左、最右的那个点（设备坐标）。原文 `leftMost`/`rightMost`。 */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** 弧朝上（开口向下，画在音符上方）。 */
  above: boolean;
  /** 起点、终点音符（可能为 null：跨行的弧只有一头在这一页）。 */
  from?: StaffNote;
  to?: StaffNote;
  /** 是连音线（两端同音高）而不是圆滑线。 */
  tie: boolean;
  /** 画成虚线（位图路 `findRasterDashedSlurs`）。 */
  dashed?: boolean;
  /** 页上第一个系统行首起笔、只挂了止端的弧：几何上能挂首音（`slurattach.ts::attachEdgeSlurStarts`），
   *  但可能接的是上一页末尾的半截，留到整曲拼页时再定（`song.ts`，记在首音的 `slurEdgeCands` 上）。 */
  edgeFirst?: StaffNote;
}

/**
 * `Page::findWedges`：渐强渐弱记号（`<`、`>`）。**要在找弧之前跑**——
 * 它们也是又宽又扁的图形，不先挑出来就会被当成圆滑线。
 *
 * 两种画法：三点的折线（一笔画出的 `<`）；或者两条**斜的**直线（上下各一笔）
 * 左端对齐、纵向靠近。水平/垂直的直线不算（那是谱线小节线）。
 */
/**
 * 松叶的折线点：三点折线照原样；**两段共一个端点**的（八段锦：一条路径 `M a L b M b L c`，或从尖起笔 `M b L a M b L c`）
 * 也收成三点，尖在中间。又扁又宽才算（宽过两格、高不到宽的四成）——别把别的两笔线当成松叶。
 */
function wedgePoints(o: PObj, sp: number): ReturnType<typeof pathPoints> {
  const pts = pathPoints(o.path!);
  if (pts.length !== 4) return pts;
  const same = (a: (typeof pts)[number], b: (typeof pts)[number]) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  const tri = same(pts[1], pts[2]) ? [pts[0], pts[1], pts[3]] : same(pts[0], pts[2]) ? [pts[1], pts[0], pts[3]] : null;
  if (!tri) return pts;
  const w = o.box.right - o.box.left;
  const h = o.box.bottom - o.box.top;
  return w > sp * 2 && h < w * 0.4 ? tri : pts;
}

export function findWedges(pg: SPage): PObj[] {
  const sp = pg.normalStaffSpace || pg.space;
  const out: PObj[] = [];
  const lines: PObj[] = [];
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.path) continue;
    const pts = wedgePoints(o, sp);
    if (pts.length === 2) {
      const dy = Math.abs(pts[0].y - pts[1].y);
      const dx = Math.abs(pts[0].x - pts[1].x);
      if (dy < 0.02 || dx < 0.02) continue; // 水平/垂直的不是渐强线
      if (dy > 0.2 * dx) continue; // 太陡的不是（渐强线很扁）
      lines.push(o);
      continue;
    }
    if (pts.length !== 3) continue;
    o.addTag("Wedge");
    out.push(o);
  }
  const done = new Set<PObj>();
  for (let i = 0; i < lines.length; i++) {
    if (done.has(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (done.has(lines[j])) continue;
      if (!overlapX(lines[i].box, lines[j].box)) continue;
      if (ySpace(lines[i].box, lines[j].box) > sp * 2) continue;
      if (Math.abs(lines[i].box.left - lines[j].box.left) > sp / 2) continue;
      lines[i].addTag("Wedge");
      lines[j].addTag("Wedge");
      done.add(lines[i]);
      done.add(lines[j]);
      out.push(lines[i], lines[j]);
      break;
    }
  }
  return out;
}

/**
 * `findWedges` 挑出来的对象 → 松叶（`attachWedges` 吃的形状）。原文到打标为止，挂音符是本仓加的。
 *
 * 三点折线：中间那点是尖——尖在左是渐强、在右是渐弱。两条斜线（`findWedges` 成对推进 `out`）：
 * 哪一头两线挨得近，尖就在哪一头。
 */
export function wedgeSpans(objs: PObj[], sp = Infinity): import("./notations").WedgeSpan[] {
  const out: import("./notations").WedgeSpan[] = [];
  const span = (tipX: number, tipY: number, x0: number, x1: number, spread: number, closed: boolean): void => {
    out.push({ type: tipX <= (x0 + x1) / 2 ? "crescendo" : "diminuendo", x0, x1, cy: tipY, ...(spread > 0 ? { spread } : {}), ...(closed ? { closed } : {}) });
  };
  for (let i = 0; i < objs.length; i++) {
    const pts = objs[i].path ? wedgePoints(objs[i], sp) : [];
    if (pts.length === 3) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      span(pts[1].x, pts[1].y, Math.min(...xs), Math.max(...xs), Math.max(...ys) - Math.min(...ys), true);
      continue;
    }
    const o2 = objs[i + 1];
    const q = o2?.path ? pathPoints(o2.path) : [];
    if (pts.length !== 2 || q.length !== 2) continue;
    i++;
    const ends = (p: typeof pts) => (p[0].x <= p[1].x ? [p[0], p[1]] : [p[1], p[0]]);
    const [al, ar] = ends(pts);
    const [bl, br] = ends(q);
    const leftGap = Math.abs(al.y - bl.y);
    const rightGap = Math.abs(ar.y - br.y);
    const x0 = Math.min(al.x, bl.x);
    const x1 = Math.max(ar.x, br.x);
    // 窄头合成一点（两线端点差不到 0.3 格）：是新起的一条，不是从上一行续过来张着口的那截
    const tol = Number.isFinite(sp) ? sp * 0.3 : 1;
    if (leftGap <= rightGap) span(x0, (al.y + bl.y) / 2, x0, x1, rightGap, leftGap < tol);
    else span(x1, (ar.y + br.y) / 2, x0, x1, leftGap, rightGap < tol);
  }
  return out;
}

/**
 * `Page::findSlurTies`：填充的曲线路径就是弧。
 *
 * 一处要害照原文：**落在系统线左边**、且与它纵向相交的曲线不是弧，是**谱表括号**
 * （钢琴谱的花括号）。不挡掉的话每个系统都会多出一条横跨整行的「圆滑线」。
 */
export function findSlurs(pg: SPage): SlurArc[] {
  const syslines: Seg[] = pg.segsWithTag("SysLine");
  const stems: Seg[] = pg.segsWithTag("Stem");
  const sp = pg.normalStaffSpace || pg.space;
  const out: SlurArc[] = [];
  // **一截弧画三遍**（八段锦：Sibelius 打的谱经 XPS 转出的 PDF）：上下两沿各一条描边贝塞尔（或一条闭合的描边轮廓）、中间一块压平的填充月牙，
  // 三个外框几乎重合（差不到半个线宽）；整条弧还常从极点断成两截。三遍只留填充那块，两条描边打 `SlurPart`。
  // 成套的就是弧：半截弧又短又陡（5×5 点），下面「又宽又扁」那道闸对它放宽，不然左半截全丢、右半截单独去挂音
  const near = (a: Box, b: Box, tol: number) => Math.abs(a.left - b.left) < tol && Math.abs(a.right - b.right) < tol && Math.abs(a.top - b.top) < tol && Math.abs(a.bottom - b.bottom) < tol;
  const layered = new Set<PObj>();
  {
    const strokes = pg.objs.filter((o) => !o.hasAnyTag() && o.path && o.path.curves > 0 && /stroke/i.test(o.path.paint) && !/fill/i.test(o.path.paint));
    const fills = pg.objs.filter((o) => !o.hasAnyTag() && o.path && !o.path.curves && o.path.segs >= 4 && /fill/i.test(o.path.paint));
    const used = new Set<PObj>();
    const eb = new Map(strokes.map((o) => [o, arcBox(o)] as const));
    for (const a0 of strokes) {
      if (used.has(a0)) continue;
      const a = { box: eb.get(a0)! };
      const mates = strokes.filter((t) => t !== a0 && !used.has(t) && near(eb.get(t)!, a.box, sp * 0.3));
      // 填充月牙的尖常比描边短一截（中阮 m94 的长延音线左尖短 1.7 点，扬琴 m47 的陡弧尖横竖都短 2 点）：
      // 落在描边框里、长宽都短不过半格就算同一截
      const within = (f: PObj) =>
        f.box.left > a.box.left - sp * 0.3 && f.box.right < a.box.right + sp * 0.3 && f.box.top > a.box.top - sp * 0.3 && f.box.bottom < a.box.bottom + sp * 0.3 &&
        f.box.right - f.box.left > a.box.right - a.box.left - sp * 0.5 && f.box.bottom - f.box.top > a.box.bottom - a.box.top - sp * 0.5;
      const fill = fills.filter((f) => !used.has(f) && within(f));
      // 弧伸出页面左右缘（八段锦钢片琴跨行的长弧，行末那截与下一行行首那截）：填充那块被页面截掉一段（截成矩形，或剩半个月牙），
      // 落在描边框里、贴着框的一个角（行末那截左上角，行首那截右下角）
      const touch = (u: number, v: number) => Math.abs(u - v) < sp * 0.3;
      const offPage = a.box.left < 1 || a.box.right > pg.width - 1;
      const clipped = fills.filter(
        (f) =>
          offPage && !used.has(f) && !fill.includes(f) &&
          f.box.left > a.box.left - sp * 0.3 && f.box.right < a.box.right + sp * 0.3 && f.box.top > a.box.top - sp * 0.3 && f.box.bottom < a.box.bottom + sp * 0.3 &&
          (touch(f.box.left, a.box.left) || touch(f.box.right, a.box.right)) && (touch(f.box.top, a.box.top) || touch(f.box.bottom, a.box.bottom)),
      );
      if (!mates.length && !fill.length) continue;
      const group = [a0, ...mates, ...fill, ...clipped];
      for (const t of group) used.add(t);
      // 填充是十几段折线的月牙就拿它当这截弧；压成四边形的（中音笙和弦里叠着的延音线，5 段）弯度只剩描边看得出，拿描边
      const rep = fill.find((f) => f.path!.segs >= 12) ?? a0;
      layered.add(rep);
      for (const t of group) if (t !== rep) t.addTag("SlurPart");
    }
  }
  for (const o of pg.objs) {
    if (o.hasAnyTag()) continue;
    const p = o.path;
    if (!p) continue;
    // 弧的三种画法都要认：
    //   ① 贝塞尔曲线（Finale 原生，`curves > 0`）；
    //   ② 描边的曲线（Sibelius/Anastasia，见下）；
    //   ③ **压平成多段折线的多边形**（这一批经 Distiller 的 PDF，实测 p205 一条弧
    //      是 60 段直线围出来的月牙、`curves` 恰好是 0）——只认 `curves > 0` 的话
    //      那些页一条弧都找不到。折线段数取 12 作门槛：符杠是 4 点、矩形 4~5 点。
    if (!p.curves && p.segs < 12 && !layered.has(o)) continue;
    // **又窄又高、在系统线左边的曲线是花括号**（Finale 直出把它画成上下两半两条曲线，各 5×36 点）。
    // 下面那道「又宽又扁」的形状闸会先把它筛掉、走不到判括号那一步，于是钢琴谱的两行一直没有花括号可认
    // ——分声部只能靠「相邻 G + F 谱号」那条兜底，把合唱谱的女低（G）与男声（F）并成了一个大谱表（宣主荣耀）。
    {
      const bw = o.box.right - o.box.left;
      const bh = o.box.bottom - o.box.top;
      if (bh >= sp * 4 && bh >= bw * 3 && syslines.some((l) => o.box.right <= l.box.left + sp * 0.5 && o.box.left >= l.box.left - sp * 4 && !(o.box.bottom < l.box.top || l.box.bottom < o.box.top))) {
        o.addTag("Bracket");
        continue;
      }
      // **跨在系统线上、罩住两行以上谱的窄长曲线是方括号**（合唱谱人声那几行；Finale 画成一笔粗竖带上下两个弯钩的填充）。
      // 花括号贴在系统线左边、上面那条先收走；方括号骑在系统线上，过不了那条，接着又被下面「又宽又扁」的闸丢掉，谁都没认
      //（宣主荣耀三声部：S / A / T&B 三行的括号）
      if (
        bh >= bw * 3 &&
        bw <= sp * 2.5 &&
        syslines.some((l) => o.box.left < l.box.right && o.box.right > l.box.left && !(o.box.bottom < l.box.top || l.box.bottom < o.box.top)) &&
        pg.staves.filter((st) => !(st.box.bottom < o.box.top || o.box.bottom < st.box.top)).length >= 2
      ) {
        o.addTag("PartBracket");
        continue;
      }
    }
    // **描边的曲线也要收**：musicpp 只认填充（`path->fill()`），那是因为它只见过
    // Finale 那一路把弧画成实心月牙；Sibelius 的 Anastasia 页把弧画成描边曲线，
    // 只认填充的话那 115 页一条弧都找不到。
    const w = o.box.right - o.box.left;
    const h = o.box.bottom - o.box.top;
    // 形状判据：弧**又宽又扁**。不加这条，吉他和弦图里的小圆点（2.3×2.3 的填充曲线，
    // 每页上百个）会全被当成弧——实测 p185 因此多出 177 条「圆滑线」。
    //
    // **宽度下限只能按「半条弧」量**：这批 PDF 把每条弧从极点劈成左右两半各画一个对象
    // （见 `mergeArcHalves`），整条两格宽的连音线，半条就只有一格。
    // 原先取 1.2 格，把两个音符之间那种短连音线整批挡在外面——252A《祢是配得赞美》
    // 四条 A4 的连音线一条都没读到（音符全对、弧线只有 79.5%）。
    // 改成 0.9 格：全书弧数 415 → **423，与 GT 的 423 分毫不差**，弧线档 93.7% → 95.3%。
    // 再往下放（0.7/0.5）弧数反而多出一条，且挡小圆点全靠下面那条长宽比了——就停在 0.9。
    // **陡弧**（宽过一格半、宽 ≥ 高）不贴着任何符干端头、也不圈着字的也收（符尾贴着干；排练号的框带圆角曲线、圈着字）：
    // 牵我的手 m53 / m89 钢琴左手八度下行两个八分之间那种，行首续过来的长弧尾巴（从上方一路落到首音，p2 钢琴左手 m13 那截 8.8×6.3 点）。
    // 赞美之泉弧线档 95.5% → 95.7%
    const steep = () =>
      w > sp * 1.5 &&
      w >= h &&
      !pg.objs.some((t) => t.run && t.box.left >= o.box.left && t.box.right <= o.box.right && t.box.top >= o.box.top && t.box.bottom <= o.box.bottom) &&
      !stems.some((sg) => sg.cx >= o.box.left - sp * 0.5 && sg.cx <= o.box.right + sp * 0.5 && [sg.top, sg.bottom].some((y) => y >= o.box.top - sp * 0.5 && y <= o.box.bottom + sp * 0.5));
    // 成套的按长边量：短弧陡的那半截只有两点多宽、五点高（二胡 p1 m3 十六分上的小弧右半），最短的左半截 2.4×2.4 点（二胡 p1 m5）
    if (layered.has(o) ? Math.max(w, h) < sp * 0.3 : w < sp * 0.9 || (w < h * 1.5 && !steep())) continue;
    let isBracket = false;
    // 又长又扁的是弧，不是括号的弯钩：行首跨行弧的后半截从页面左缘起笔，整个在系统线左边（钢片琴系统 7）
    for (const l of w > sp * 4 && h < w * 0.5 ? [] : syslines) {
      // y 向下：纵向相交 = 不在彼此的上下之外
      if (o.box.bottom < l.box.top || l.box.bottom < o.box.top) continue;
      if (o.box.left < l.box.left) {
        isBracket = true;
        break;
      }
    }
    if (isBracket) {
      o.addTag("Bracket");
      continue;
    }
    const arc = arcOf(o);
    if (!arc) continue;
    o.addTag("Slur");
    out.push(arc);
  }
  // 成套弧端头那一小截描边（0.4×1.1 点的线帽）：贴着某条弧的端点的，也归弧
  if (layered.size)
    for (const o of pg.objs) {
      if (o.hasAnyTag() || !o.path || o.path.curves || o.box.right - o.box.left > sp * 0.35 || o.box.bottom - o.box.top > sp * 0.35) continue;
      const cx = (o.box.left + o.box.right) / 2;
      const cy = (o.box.top + o.box.bottom) / 2;
      if (out.some((a) => layered.has(a.obj) && [[a.lx, a.ly], [a.rx, a.ry]].some(([x, y]) => Math.abs(x - cx) < sp * 0.3 && Math.abs(y - cy) < sp * 0.4))) o.addTag("SlurPart");
    }
  return out;
}

/**
 * **一条弧画成两个对象**：这一批 PDF 把每条弧从极点处劈成左右两半，各是一个路径对象
 * （实测 p170 那些连音线：`(283.9,173.3)→(289.8,175.0)` 与 `(289.8,175.0)→(295.7,173.3)`
 * 明明是同一条）。不并回去的话，每一半各自去找两端的音符：
 * 左半的右端落在弧顶下面那个音符上，两端音高就不同了——**连音线整批读成圆滑线**
 * （全书 113 处 `t→s` + 111 处 `T→S`，弧的条数也比 GT 多出两成）。
 *
 * 判据：前一条的右端与后一条的左端**重合**（五分之一格以内）、朝向相同，
 * 且接口正好是**极点**——朝下的弧是「前一段降、后一段升」，朝上的反过来。
 * 极点这一条是要害：两条**真的相邻**的弧（前一条收在某个音符上、后一条从它起头）
 * 端点也重合，但那里是两条弧各自的端，前一段升、后一段降，正好相反。
 */
export function mergeArcHalves(arcs: SlurArc[], sp: number): SlurArc[] {
  const tol = sp * 0.2;
  const sorted = arcs.slice().sort((a, b) => a.lx - b.lx);
  const used = new Set<SlurArc>();
  const out: SlurArc[] = [];
  /** b 接得上 a 吗（端点重合 + 接口是极点）。 */
  const joins = (a: SlurArc, b: SlurArc): boolean => {
    if (b.above !== a.above) return false;
    if (Math.abs(b.lx - a.rx) > tol || Math.abs(b.ly - a.ry) > tol) return false;
    return a.above ? a.ry < a.ly && b.ry > b.ly : a.ry > a.ly && b.ry < b.ly;
  };
  for (const a of sorted) {
    if (used.has(a)) continue;
    used.add(a);
    const cur: SlurArc = { ...a };
    for (;;) {
      const b = sorted.find((q) => !used.has(q) && joins(cur, q));
      if (!b) break;
      used.add(b);
      b.obj.addTag("SlurPart");
      cur.rx = b.rx;
      cur.ry = b.ry;
    }
    out.push(cur);
  }
  return out;
}

/**
 * 弧路径的点，去掉夹带的**极短直线子路径**（一点以内）：中音笙和弦里的延音线，一条描边常捎上别的弧端头那 0.6 点的竖线帽，
 * 外框被撑到另一条弧那里，配不上自己的填充块，朝向也被它带偏。
 */
function arcPoints(o: PObj): ReturnType<typeof pathPoints> {
  const sps = subPaths(o.path!);
  if (sps.length < 2) return pathPoints(o.path!);
  const keep = sps.filter((s) => s.pts.some((q) => q.curve) || s.pts.length > 2 || Math.hypot(s.pts[0].x - s.pts[s.pts.length - 1].x, s.pts[0].y - s.pts[s.pts.length - 1].y) > 1);
  return keep.length ? keep.flatMap((s) => s.pts) : pathPoints(o.path!);
}

/** `arcPoints` 的外框 */
function arcBox(o: PObj): Box {
  const pts = arcPoints(o);
  return { left: Math.min(...pts.map((q) => q.x)), right: Math.max(...pts.map((q) => q.x)), top: Math.min(...pts.map((q) => q.y)), bottom: Math.max(...pts.map((q) => q.y)) };
}

/** 从路径点算出弧的两端与朝向（`SlurTie::SlurTie`）。 */
function arcOf(o: PObj): SlurArc | null {
  const pts = arcPoints(o);
  if (pts.length < 4) return null;
  let li = 0;
  let ri = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x < pts[li].x) li = i;
    if (pts[i].x > pts[ri].x) ri = i;
  }
  // 朝向：拿弧的第一段贝塞尔判——控制点在两端连线的哪一侧。
  // 原文只处理 8 个点的情形（两条三次贝塞尔围出的月牙）；本仓退一步：
  // 取**离两端连线最远**的那个点来判，点数多少都成立。
  let above = true;
  const x0 = pts[li].x;
  const y0 = pts[li].y;
  const x1 = pts[ri].x;
  const y1 = pts[ri].y;
  if (x1 > x0) {
    // 端点上的竖直收尾（极点处断开的半截弧，描边末尾还拖一段竖线）不算：它离连线远，却不说明弧往哪边拱。
    const eps = (x1 - x0) * 0.02;
    const inner = pts.filter((p) => p.x > x0 + eps && p.x < x1 - eps);
    let far = 0;
    for (const p of inner.length ? inner : pts) {
      const yLine = y0 + ((y1 - y0) * (p.x - x0)) / (x1 - x0);
      const d = p.y - yLine;
      if (Math.abs(d) > Math.abs(far)) far = d;
    }
    // y 向下：最远点在连线**上方**（y 更小）说明弧朝上
    above = far < 0;
  }
  return { obj: o, lx: pts[li].x, ly: pts[li].y, rx: pts[ri].x, ry: pts[ri].y, above, tie: false };
}

/**
 * `validateSlurNote`：弧的某一端能不能挂到这个音符上，返回距离的平方（越小越好）。
 *
 * @param isEnd 这一端是弧的**终点**（挂到音符左缘）；否则是起点（挂到右缘）
 */
/**
 * 弧的一端离符头墨迹**纵向**能有多远（格数）。
 *
 * 原文是一格。本书不行：朝上的弧画在**符杠之上**、朝下的弧画在符干末端之下，
 * 离符头两三格是常事，一格的窗口把那些端点全判掉，弧只剩一头挂着。
 * 实测（`scripts/staff-diff.mjs` 的弧线档 / 识别出的条数，GT 413 条）：
 * 1 格 93.4% / 353 条，2 格 93.9% / 382 条，**3 格 94.1% / 402 条**，4 格 94.0% / 418 条
 * ——再放就开始乱挂了。
 */
const SLUR_REACH = 3;

export function validateSlurNote(isEnd: boolean, nt: Box, px: number, py: number, sp: number, above: boolean, headSlack = 0): number | null {
  // y 向下：`nt.top` 是视觉上沿。原文比的是 y 向上的 top/bottom，这里整段翻过来。
  if (py < nt.top - sp * SLUR_REACH) return null;
  if (py > nt.bottom + sp * SLUR_REACH) return null;
  let dy: number;
  if (py < nt.top) {
    dy = nt.top - py;
    if (!above) return null;
  } else if (py > nt.bottom) {
    dy = py - nt.bottom;
    if (above) return null;
  } else {
    dy = 0;
  }
  let dx: number;
  // `headSlack`：端点可以略出符头（头宽的几成）。矢量路给 0.4：倚音到主音的小弧起笔在倚音头左下方（二胡 m48 倚音 D5，左出 1.4 点），
  // 卡死在头的左缘就挂到前一小节的同音上去了。位图路不给（破碎干净档的弧挂法会变）。
  // 起点至少容 0.6 格：朝下的弧从符头左下方起笔，二胡 m43 E5 下面那条起在头左缘外 2.8 点（头宽四成只有 2.4）。
  // 止端不放：牵我的手 p10 左手 C3→A2 跨行弧的前半截，弧尾越过行末 B2 右缘 0.5 格，放了就挂在 B2 上、接不回下一行
  const slack = (nt.right - nt.left) * headSlack;
  const startSlack = headSlack > 0 ? Math.max(slack, sp * 0.6) : 0;
  if (isEnd) {
    if (px > nt.right + slack) return null;
    if (px < nt.left - 4 * sp) return null;
    dx = px - nt.left;
  } else {
    if (px < nt.left - startSlack) return null;
    if (px > nt.right + 4 * sp) return null;
    dx = px - nt.right;
  }
  // 矢量路（给了 `headSlack`）：按端点到符头盒的横向距离算，横向不在头上的另加半格的罚——Sibelius 的短弧从符头正上方起笔，
  // 按离右缘量的话头里的起点反比紧挨着的前一个音还远，起点挂到前一个音上（高胡 m13 第二条弧起在 E6 头里，dx −4.2 比前一个 F♯6 的 5.1 还大；
  // 二胡 m39 起在 D5 头里、比前一个 E5 低 2.5 点，只按距离也归 E5）
  if (headSlack > 0) {
    const gap = px < nt.left ? nt.left - px : px > nt.right ? px - nt.right : 0;
    return gap * gap + dy * dy + (gap > 0 ? (sp * 0.5) ** 2 : 0);
  }
  return dx * dx + dy * dy;
}

/**
 * `Page::analyzeSlurTie`：给每条弧找两端的音符，再判是不是连音线。
 *
 * 连音线的判据照 `SlurTie::checkTie`：两端**在谱表上的音级相同**。
 */
/**
 * @param opts.stemEnds 两端都挂不上符头时按符干端补挂（只矢量路开，见下）
 * @param opts.tieNeighbors 两端同音级还要过 `notTie` 才判延音线（矢量路开；位图路挂完弧端、修过几轮之后在 `pagefinish.ts` 里另判）
 * @param opts.rowNext 下一（`d = 1`）/ 上一（`d = -1`）系统里同一行谱，本页没有的给 undefined（`overshoot` 时判弧尾拖到行末还是跨行半截）
 */
export function attachSlurs(
  arcs: SlurArc[],
  notes: StaffNote[],
  sp: number,
  opts: { stemEnds?: boolean; tieNeighbors?: boolean; overshoot?: boolean; headSlack?: number; spreadTies?: boolean; barClip?: boolean; rowNext?: (st: Staff, d: 1 | -1) => Staff | undefined } = {},
): void {
  const pitched = notes.filter((n) => !n.rest);
  /** x 落在这行谱第几小节（不在任何小节里给 -1） */
  const barAt = (st: Staff, x: number) => st.bars.findIndex((b) => x >= b.left && x <= b.right);
  /** 弧端 x 与音不在同一小节（两边都定得出小节时） */
  const crossBar = (nt: StaffNote, x: number) => {
    const a = barAt(nt.staff, x), b = barAt(nt.staff, nt.x);
    return a >= 0 && b >= 0 && a !== b;
  };
  for (const sl of arcs) {
    let bestL: StaffNote | undefined;
    let bestR: StaffNote | undefined;
    let dl = Infinity;
    let dr = Infinity;
    for (const nt of pitched) {
      const b = nt.sym.box;
      const vl = validateSlurNote(false, b, sl.lx, sl.ly, sp, sl.above, opts.headSlack);
      const vr = validateSlurNote(true, b, sl.rx, sl.ry, sp, sl.above, opts.headSlack);
      if (vl !== null && vl < dl) {
        dl = vl;
        bestL = nt;
      }
      if (vr !== null && vr < dr) {
        dr = vr;
        bestR = nt;
      }
    }
    // 两端都没挂上的再按「符头 + 符干」的盒找一遍：弧画在符杠外侧（朝上的弧压在上翘的符杠之上），离符头四五格，
    // 按符头量够不着（牵我的手 W m58 / m94 末两个八分 G4→F4）。只收两端都这样挂上、落在同一行谱上的：
    // 只缺一端就按符干补，赞美之泉多出二十几条弧、弧线档反降。只矢量路开（`stemEnds`）：位图路的干端不准，破碎、独唱各多一两步
    if (opts.stemEnds && !bestL && !bestR) {
      const stemBox = (nt: StaffNote): Box | null => {
        if (nt.stemTip === undefined || nt.stemUp === null || nt.stemUp !== sl.above) return null;
        const b = nt.sym.box;
        return nt.stemUp ? { ...b, top: Math.min(b.top, nt.stemTip) } : { ...b, bottom: Math.max(b.bottom, nt.stemTip) };
      };
      let sl0: StaffNote | undefined, sr0: StaffNote | undefined;
      let d0 = Infinity, d1 = Infinity;
      for (const nt of pitched) {
        const b = stemBox(nt);
        if (!b) continue;
        const vl = validateSlurNote(false, b, sl.lx, sl.ly, sp, sl.above);
        const vr = validateSlurNote(true, b, sl.rx, sl.ry, sp, sl.above);
        if (vl !== null && vl < d0) (d0 = vl), (sl0 = nt);
        if (vr !== null && vr < d1) (d1 = vr), (sr0 = nt);
      }
      // 两端都贴着符干端（一格半以内）：离干端还远的是别的东西（赞美之泉几处短弧、长弧挂到远处的干上）
      const nearTip = (nt: StaffNote, y: number) => Math.abs(y - nt.stemTip!) <= sp * 1.5;
      if (sl0 && sr0 && sl0 !== sr0 && sl0.staff === sr0.staff && nearTip(sl0, sl.ly) && nearTip(sr0, sl.ry)) (bestL = sl0), (bestR = sr0);
    }
    // 一端挂不上时容它越过符头一格（八段锦：Sibelius 的弧尾常伸到末音右缘外、甚至贴着后面的休止，琵琶 m48）。只矢量路开（`overshoot`）
    if (opts.overshoot && (!bestL || !bestR)) {
      let d0 = Infinity, d1 = Infinity;
      let l0: StaffNote | undefined, r0: StaffNote | undefined;
      for (const nt of pitched) {
        const b = nt.sym.box;
        // 纵向也容一格：陡的短弧收尾翘得高，端点离符头三格多（中胡 m57 十六分上的小弧）
        const dy = (sl.above ? 1 : -1) * sp;
        const vl = bestL ? null : validateSlurNote(false, b, sl.lx + sp * 1.2, sl.ly + dy, sp, sl.above);
        const vr = bestR ? null : validateSlurNote(true, b, sl.rx - sp * 1.2, sl.ry + dy, sp, sl.above);
        if (vl !== null && vl < d0) (d0 = vl), (l0 = nt);
        if (vr !== null && vr < d1) (d1 = vr), (r0 = nt);
      }
      // 伸到谱行右缘（左缘）两格以内的是跨行弧的半截，那一端本来就没有音，不补（牵我的手 p1 钢琴左手 C3 行末的弧）
      const nearEdge = (n: StaffNote, x: number, right: boolean) => (right ? n.staff.box.right - x : x - n.staff.box.left) < sp * 2;
      if (l0 && l0 !== bestR && !nearEdge(l0, sl.lx, false)) bestL = l0;
      if (r0 && r0 !== bestL && !nearEdge(r0, sl.rx, true)) bestR = r0;
      // 伸到行末（行首）、可下一（上一）系统在这一页而同一行行首（行末）没有同朝向的续段：是弧尾拖到了行末，不是跨行半截，
      // 止端挂这一行弧下最后一个音（起端挂第一个）。高音笙 m40 G4→A4 弧尾越过 A4 两格多、离行末 0.38 格，
      // 牵我的手的跨行半截离行末 0.17 格，光比距离分不开
      const noCont = (st: Staff, right: boolean) => {
        const row = opts.rowNext?.(st, right ? 1 : -1);
        if (!row?.bars.length) return false;
        const b = right ? row.bars[0] : row.bars[row.bars.length - 1];
        const band = (y: number) => y > row.box.top - sp * 4 && y < row.box.bottom + sp * 4;
        return !arcs.some((a) => a !== sl && a.above === sl.above && (right ? a.lx <= (b.left + b.right) / 2 && band(a.ly) : a.rx >= b.left && band(a.ry)));
      };
      const dy = (sl.above ? 1 : -1) * sp;
      const under = (st: Staff, right: boolean) =>
        pitched
          .filter((n) => n.staff === st && n.sym.box.left < sl.rx && n.sym.box.right > sl.lx)
          .sort((a, b) => (right ? b.x - a.x : a.x - b.x))
          .find((n) => validateSlurNote(right, n.sym.box, right ? n.sym.box.right : n.sym.box.left, (right ? sl.ry : sl.ly) + dy, sp, sl.above) !== null);
      if (!bestR && bestL && bestL.staff.box.right - sl.rx < sp * 2 && noCont(bestL.staff, true)) {
        const r = under(bestL.staff, true);
        if (r && r !== bestL && r.x > bestL.x) bestR = r;
      }
      if (!bestL && bestR && sl.lx - bestR.staff.box.left < sp * 2 && noCont(bestR.staff, false)) {
        const l = under(bestR.staff, false);
        if (l && l !== bestR && l.x < bestR.x) bestL = l;
      }
    }
    // 弧尾越过末音两格多、停在小节线前，按距离只够得着小节线那边的音（笛子 m40 G4→A4 弧尾过 A4 2.4 格，挂成了 m41 的 B4）：
    // 改挂弧尾那一小节里弧下最后一个音（`barClip`，只矢量路开）
    if (opts.barClip && bestL && bestR && crossBar(bestR, sl.rx)) {
      const bar = barAt(bestL.staff, sl.rx);
      const dy = (sl.above ? 1 : -1) * sp;
      const r = pitched
        .filter((n) => n.staff === bestL!.staff && n.x > bestL!.x && n.sym.box.right < sl.rx && barAt(n.staff, n.x) === bar)
        .sort((a, b) => b.x - a.x)
        .find((n) => validateSlurNote(true, n.sym.box, n.sym.box.right, sl.ry + dy, sp, sl.above) !== null);
      if (r) bestR = r;
    }
    // 矢量路：两端落到同一个音上，改取两端都挂得上、挂在不同音上、两端距离和最小的一对
    // （二胡 m4 F♯5→E5 十六分上的小弧，止端越过 F♯5 右缘 2.2 点、也落在 E5 头里，单按距离两端都归 F♯5）
    if (opts.headSlack && bestL && bestL === bestR) {
      let best = Infinity;
      let pair: [StaffNote, StaffNote] | undefined;
      const ls = pitched.map((n) => [n, validateSlurNote(false, n.sym.box, sl.lx, sl.ly, sp, sl.above, opts.headSlack)] as const).filter((x) => x[1] !== null);
      const rs = pitched.map((n) => [n, validateSlurNote(true, n.sym.box, sl.rx, sl.ry, sp, sl.above, opts.headSlack)] as const).filter((x) => x[1] !== null);
      for (const [l, vl] of ls) for (const [r, vr] of rs) if (l !== r && l.x < r.x && vl! + vr! < best) (best = vl! + vr!), (pair = [l, r]);
      if (pair) [bestL, bestR] = pair;
    }
    if (bestL && bestL === bestR) {
      // 两端落到同一个音符上：按 x 判掉不合理的那一端（照原文）
      if (bestL.sym.box.left > sl.rx) bestL = undefined;
      if (bestR && bestR.sym.box.right < sl.lx) bestR = undefined;
    }
    sl.from = bestL;
    sl.to = bestR;
    if (bestL && bestR && bestL.staff === bestR.staff && bestL.diatonic === bestR.diatonic && !(opts.tieNeighbors && notTie(bestL, bestR, pitched, sp, sl.above))) sl.tie = true;
  }
  if (opts.spreadTies) spreadChordTies(arcs, pitched);
}

/**
 * 和弦里叠着的几条延音线常挂到同一对音上（高音笙 m74 A4/F♯4/D4 三条：中间那条贴着 D4 头顶，按距离归了 D4，与最下面那条重了）。
 * 同一对音上挂了不止一条的，在这个和弦里重新分：每条归**弧那一侧**（朝下的弧在头的下面）离它最近、
 * 后一个和弦里有同音级的音，一个音只分一条。
 */
function spreadChordTies(arcs: SlurArc[], pitched: StaffNote[]): void {
  const groups = new Map<StaffNote, SlurArc[]>();
  for (const sl of arcs) if (sl.tie && sl.from && sl.to) groups.set(sl.from, [...(groups.get(sl.from) ?? []), sl]);
  const tiedFrom = new Set(arcs.filter((a) => a.tie && a.from).map((a) => a.from!));
  for (const [from, g] of groups) {
    if (g.length < 2 || g.some((sl) => sl.to !== g[0].to)) continue;
    const to = g[0].to!;
    const hw = from.sym.box.right - from.sym.box.left;
    const col = (n: StaffNote) => pitched.filter((m) => m.staff === n.staff && Math.abs(m.x - n.x) < hw * 0.5);
    const fromCol = col(from), toCol = col(to);
    for (const m of fromCol) if (m !== from) tiedFrom.delete(m);
    tiedFrom.delete(from);
    const pairs: { sl: SlurArc; m: StaffNote; t: StaffNote; d: number }[] = [];
    for (const sl of g)
      for (const m of fromCol) {
        if (tiedFrom.has(m) || (sl.above ? m.sym.py <= sl.ly : m.sym.py >= sl.ly)) continue;
        const t = toCol.find((q) => q.diatonic === m.diatonic);
        if (t) pairs.push({ sl, m, t, d: Math.abs(m.sym.py - sl.ly) });
      }
    pairs.sort((a, b) => a.d - b.d);
    const done = new Set<SlurArc>();
    for (const p of pairs) {
      if (done.has(p.sl) || tiedFrom.has(p.m)) continue;
      p.sl.from = p.m;
      p.sl.to = p.t;
      done.add(p.sl);
      tiedFrom.add(p.m);
    }
  }
}

/** 延音线中间夹着的音，离两端几个音级以内才算同一声部。 */
const TIE_BETWEEN_STEPS = 5;

/**
 * 两端同音高的弧**不是延音线**的两种情形（位图路 `pagefinish.ts` 与矢量路 `attachSlurs` 共用）：
 *   · 延音线只连相邻两个音：中间夹着同一行谱上别的音的，是跨几个音的圆滑线（宁静的伯利恒 p2 m25 钢琴右手 C5…C5；
 *     牵我的手 Syn 左手 m106 B3 → m108 B3、小提琴 m39 G♯4–F♯4–G♯4）。
 *     只数音高相近（`TIE_BETWEEN_STEPS` 个音级内）的：一行谱两个声部时，延音线中间常夹着另一声部的音（是爱 p4 m54 F5 下面的 F4、G4）。
 *     无干的（全音符）多是另一声部，不算（是爱 p5 m65）；两个声部并存时干向与起点相反的也不算（晨曦破晓 m5 D4 延音线下面的 B3）。
 *     起点或终点同一时刻有反向干的音（这行谱上两个声部并存）才按干向分；单声部旋律的干随音高翻（破碎低音），不分。
 *   · 终点音前印了临时记号：音高变了，是圆滑线（破碎 p8 m81、p12 m100 钢琴右手 G4→♮G4）。
 *
 * `above`（弧朝向，矢量路给）：夹着的音还要在弧那一侧、越过两端（弧朝上的比两端高）。钢琴上声部一条延音线保持着、
 * 底下内声部同干向的八分照走是常规写法（牵我的手 p1 m8 右手 B4 延音线下面的 E4、Syn 右手 A5 下面的 E5），不加这条误判 24 处；
 * 真圆滑线夹着的音都在弧那一侧（G♯4–F♯4–G♯4 弧在下、F♯2–C♯3–F♯2 弧在上）。位图路弧向不总可靠，不给。
 */
export function notTie(from: StaffNote, to: StaffNote, notes: StaffNote[], sp: number, above?: boolean): boolean {
  const pad = sp * 0.6;
  const opp = (m: StaffNote) => notes.some((n) => !n.rest && n.staff === m.staff && n.stemUp !== null && m.stemUp !== null && n.stemUp !== m.stemUp && Math.abs(n.x - m.x) < pad);
  const twoVoices = opp(from) || opp(to);
  const side = (n: StaffNote) => above === undefined || (above ? n.diatonic > from.diatonic : n.diatonic < from.diatonic);
  if (notes.some((n) => !n.rest && n.staff === from.staff && n.stemUp !== null && (!twoVoices || from.stemUp === null || n.stemUp === from.stemUp) && Math.abs(n.diatonic - from.diatonic) <= TIE_BETWEEN_STEPS && side(n) && n.x > from.x + pad && n.x < to.x - pad)) return true;
  return to.accidental !== null && to.staff === from.staff;
}

/**
 * **延音线要时间上紧挨着**：前一个音的终点正是后一个音的起点（同一小节），或者前一个音收在小节末、后一个音在下一小节头（跨小节线、跨行）。
 * 同音高、几何上也像延音线的弧，中间隔着拍点的是圆滑线（牵我的手 p1 m8 钢琴右手 B4 四分 → B4 附点四分，底下内声部走着八分）。
 * 要等 `checkBars` 定了各音的起点（`StaffChord.offset`）才判得了，两端都凑满了小节（`timed`）才判，其余照几何的结论。
 * 改判的弧把两端的延音线标记换成圆滑线（`markSlurNotes` 已经打过标）。
 */
export function retimeTies(arcs: SlurArc[], notes: StaffNote[]): void {
  const eps = 1e-6;
  const barOf = (n: StaffNote) => n.staff.bars.findIndex((b) => n.x >= b.left && n.x <= b.right);
  const end = (n: StaffNote) => n.group!.offset + n.duration;
  const barEnd = (n: StaffNote, bi: number) =>
    Math.max(...notes.filter((m) => m.staff === n.staff && m.group?.timed && !m.grace && barOf(m) === bi).map(end));
  const flipped: SlurArc[] = [];
  for (const sl of arcs) {
    const { from, to } = sl;
    if (!sl.tie || !from || !to || !from.group?.timed || !to.group?.timed) continue;
    const bf = barOf(from), bt = barOf(to);
    if (bf < 0 || bt < 0) continue;
    let adjacent: boolean;
    if (from.staff === to.staff && bf === bt) adjacent = Math.abs(end(from) - to.group.offset) < eps;
    else {
      const next = from.staff === to.staff ? bt === bf + 1 : bf === from.staff.bars.length - 1 && bt === 0;
      adjacent = next && to.group.offset < eps && end(from) >= barEnd(from, bf) - eps;
    }
    if (adjacent) continue;
    sl.tie = false;
    from.tieStart = false;
    from.tieAbove = undefined;
    to.tieStop = false;
    flipped.push(sl);
  }
  // 一批标：同一条弧画两份的按一批去重（见 `markSlurNotes`）
  if (flipped.length) markSlurNotes(flipped);
}

/**
 * `System::updateSlurTied` 的要点：**跨行的弧要接回一条**。
 *
 * 谱面上一条跨行的圆滑线画成两段（上一行末一段、下一行头一段），
 * 而 GT 里它是**一对** start/stop。不接的话我们会多出一个起点与一个终点
 * ——实测全书多认出三分之一的弧就是这么来的。
 *
 * 判据：上一行有条弧只有起点没终点（右端悬空），下一行紧接着有条弧只有终点没起点。
 * 按谱行顺序两两配。
 *
 * 给了 `notes`（矢量路）时，行首两端都没挂上的弧也当后半截：从行首起笔、收在这一行第一个音之前（页面裁掉了一截，
 * 八段锦钢片琴 m36→m38 续段收在首音前 30 点），止端挂这一行第一个音，再去配上一系统同一行行尾悬空的。
 */
export function reconnectSlurs(pg: SPage, arcs: SlurArc[], notes?: StaffNote[]): void {
  const staffOf = (a: SlurArc) => (a.from ?? a.to)?.staff;
  // 只接真在行尾、行首的半截（`orphanEdge`，写出端同此）：长弧拱顶没认出、左截悬在行中间的，接到下一系统去就成了一条跨行弧（宁静 p7 m89→m93 女高）
  const dangRight = arcs.filter((a) => a.from && !a.to && orphanEdge(a, a.from) === "end");
  const dangLeft = arcs.filter((a) => !a.from && a.to && orphanEdge(a, a.to) === "begin");
  if (notes)
    for (let i = 1; i < pg.systems.length; i++) {
      const A = pg.systems[i - 1].staves, B = pg.systems[i].staves;
      if (A.length !== B.length) continue;
      B.forEach((st, k) => {
        if (!st.bars.length || !dangRight.some((a) => staffOf(a) === A[k])) return;
        const sp = pg.normalStaffSpace || pg.space;
        const b0 = st.bars[0];
        const own = notes.filter((n) => n.staff === st && !n.rest).sort((p, q) => p.x - q.x);
        for (const a of arcs) {
          if (a.from || a.to || a.lx > (b0.left + b0.right) / 2 || a.ry < st.box.top - sp * 4 || a.ry > st.box.bottom + sp * 4) continue;
          if (!own.length || own[0].sym.box.left < a.rx || !dangRight.some((r) => staffOf(r) === A[k] && r.above === a.above)) continue;
          a.to = own[0];
          dangLeft.push(a);
        }
      });
    }
  const join = (a: SlurArc, b: SlurArc) => {
    a.to = b.to;
    b.from = undefined;
    b.to = undefined;
    // 接回来之后再判一次连音线
    if (a.from && a.to && a.from.diatonic === a.to.diatonic) a.tie = true;
  };
  // **按系统配**：一个系统几行谱（合唱谱人声 + 钢琴）时，「下一行谱」是同一系统的下一个声部，不是下一系统的同一行。
  // 本系统第 k 行右端悬空的，配下一系统第 k 行左端悬空的（两个系统行数相同才配）
  //（破碎 p2 m11 钢琴右手 A4 延音线与它下方那条圆滑线）
  const systems = pg.systems.filter((sy) => sy.staves.length);
  if (systems.length) {
    const rel = (a: SlurArc, y: number) => y - staffOf(a)!.box.top;
    const sp = pg.normalStaffSpace || pg.space;
    for (let i = 0; i + 1 < systems.length; i++) {
      const A = systems[i].staves, B = systems[i + 1].staves;
      if (A.length !== B.length) continue;
      for (let k = 0; k < A.length; k++) {
        // 同一条弧常画两份（Finale 填充、描边各一个对象，牵我的手）：两端重合的并成一簇，按簇配，配上了一簇里每份都接
        const clusters = (xs: SlurArc[]) => {
          const out: SlurArc[][] = [];
          for (const a of xs) {
            const c = out.find((q) => q[0].above === a.above && Math.abs(q[0].lx - a.lx) < sp * 0.2 && Math.abs(q[0].rx - a.rx) < sp * 0.2 && Math.abs(q[0].ly - a.ly) < sp * 0.2 && Math.abs(q[0].ry - a.ry) < sp * 0.2);
            if (c) c.push(a);
            else out.push([a]);
          }
          return out;
        };
        const joinAll = (r: SlurArc[], l: SlurArc[]) => {
          const to = l[0].to;
          for (const b of l) (b.from = undefined), (b.to = undefined);
          for (const a of r) join(a, { ...l[0], to } as SlurArc);
        };
        // 行尾悬空的取最靠右的、行首悬空的取最靠左的（行里别处也有悬空的弧：另一端没挂上的），各取同样几条再按高低配
        let rs = clusters(dangRight.filter((a) => staffOf(a) === A[k])).sort((p, q) => q[0].rx - p[0].rx);
        let ls = clusters(dangLeft.filter((b) => staffOf(b) === B[k])).sort((p, q) => p[0].lx - q[0].lx);
        const n = Math.min(rs.length, ls.length);
        rs = rs.slice(0, n);
        ls = ls.slice(0, n);
        // **同一个音上既有延音线又有圆滑线**（跨行时两截都在行尾、行首叠着）：两端高低差不多，按高低配常配错（牵我的手 Syn 左手 m30→31）。
        // 先配延音线：同音级、同朝向的一对里取两截加起来最短的（延音线只从末音画到谱表尽头、从行首画到首音，比圆滑线短）
        const width = (c: SlurArc[]) => c[0].rx - c[0].lx;
        while (rs.length >= 2) {
          let best: [number, number] | undefined;
          for (let x = 0; x < rs.length; x++)
            for (let y = 0; y < ls.length; y++) {
              const r = rs[x][0], l = ls[y][0];
              if (r.above !== l.above || r.from!.diatonic !== l.to!.diatonic) continue;
              if (!best || width(rs[x]) + width(ls[y]) < width(rs[best[0]]) + width(ls[best[1]])) best = [x, y];
            }
          if (!best) break;
          joinAll(rs[best[0]], ls[best[1]]);
          rs.splice(best[0], 1);
          ls.splice(best[1], 1);
        }
        rs.sort((p, q) => rel(p[0], p[0].ry) - rel(q[0], q[0].ry));
        ls.sort((p, q) => rel(p[0], p[0].ly) - rel(q[0], q[0].ly));
        for (let j = 0; j < rs.length; j++) joinAll(rs[j], ls[j]);
      }
    }
    return;
  }
  const order = new Map(pg.staves.map((s, i) => [s, i]));
  const used = new Set<SlurArc>();
  for (const a of dangRight) {
    const sa = staffOf(a);
    if (sa === undefined) continue;
    const ia = order.get(sa) ?? -1;
    let best: SlurArc | undefined;
    for (const b of dangLeft) {
      if (used.has(b)) continue;
      const sb = staffOf(b);
      if (sb === undefined) continue;
      if ((order.get(sb) ?? -1) !== ia + 1) continue;
      best = b;
      break;
    }
    if (!best) continue;
    join(a, best);
    used.add(best);
  }
}

/** 弧号：写出时给 `<slur>` 配对用（`toxml.ts::renumberSlurs`）。按弧对象记住，同一个弧对象再标一次时号不变。 */
const slurIdOf = new WeakMap<SlurArc, string>();
let nextSlurId = 1;
const pushId = (a: string[] | undefined, id: string) => (a?.includes(id) ? a : [...(a ?? []), id]);

/**
 * 只认出一端的弧，悬空那端在哪：跨行弧的前半，右端伸到本行**最后一小节**或谱表右缘之外（`end`）；
 * 跨行弧的后半，左端落在本行**第一小节的前半**（`begin`，谱号调号那段也算）；别处都是 `mid`（系统中间缺一端，多半是端点没挂上符头）。
 * 只有前两种才去接下一系统 / 上一系统的半截——光看「缺一端」就接，系统中间的半截会被接到隔着几十小节的另一个半截上（是爱 m1→m44）。
 */
export function orphanEdge(sl: SlurArc, n: StaffNote): "end" | "begin" | "mid" {
  const bars = n.staff.bars;
  if (!bars.length) return "mid";
  if (!sl.to) return sl.rx >= bars[bars.length - 1].left ? "end" : "mid";
  const b0 = bars[0];
  return sl.lx <= (b0.left + b0.right) / 2 ? "begin" : "mid";
}

/**
 * 弧 → 挂到音符上的标记。一个音符可以同时是上一条的收尾与下一条的起头。
 * `newId` 发新弧号（只当写出端配对的键，`toxml.ts::renumberSlurs`）：缺省取进程里的全局计数；位图路按「页码.页内序号」发
 * （多页并行时各 Worker 的计数互不相知，单用计数会跨页撞号、被写出端配成一条）。
 */
export function markSlurNotes(arcs: SlurArc[], newId: () => string = () => String(nextSlurId++), byDirection = false): void {
  // **两端落在同一处的弧算同一条**：同一条圆滑线常被检出两个弧对象（牵我的手每条都是两份），
  // 还有一头挂在和弦的不同成员上的（我灵镇静 m4 E4→A4、E4→F4，A4/F4 同一个和弦）。
  // 原来只记布尔值，又按谱表号编号，两条同号、读入端只留一条，碰巧是对的；按弧号逐条写出就成了两条。
  // 「同一处」= 同一个音，或同一行谱上横向差不到半个符头宽（同一和弦）。两份总在同一批里，按这一批去重
  // 只挂了一端的半截还要比几何（朝向、两端横坐标差不到符头宽的 0.15——同一条画两份的外框差零点几点，叠着的两个半截差一点多）：同一个音上既起延音线又起圆滑线、跨行各剩半截时，
  // 两条都只挂着这个音，光比音就并成一条（牵我的手 W m36→37 F4 的延音线与圆滑线、Syn 左手 m24→25）
  const ends: { id: string; from?: StaffNote; to?: StaffNote; sl: SlurArc }[] = [];
  const near = (a?: StaffNote, b?: StaffNote) =>
    a === b || (!!a && !!b && a.staff === b.staff && Math.abs(a.x - b.x) < (a.sym.box.right - a.sym.box.left) * 0.5);
  const sameHalf = (a: SlurArc, b: SlurArc) => {
    const n = a.from && a.to ? undefined : (a.from ?? a.to);
    // 两端都挂上的也要朝向相同：和弦上下各一条（新笛 m45 上面 F♯4→G4、下面 D4→E4），两端同处却是两条。
    // 只矢量路开（`byDirection`）：位图路的弧向不总可靠，同一条弧的两份朝向判得不一，破碎干净档多出五六处「挪连线」
    if (!n) return !byDirection || a.above === b.above;
    const w = n.sym.box.right - n.sym.box.left;
    return a.above === b.above && Math.abs(a.lx - b.lx) < w * 0.15 && Math.abs(a.rx - b.rx) < w * 0.15;
  };
  for (const sl of arcs) {
    if (!sl.tie) {
      let id = slurIdOf.get(sl);
      if (id === undefined) {
        id = ends.find((e) => near(e.from, sl.from) && near(e.to, sl.to) && sameHalf(sl, e.sl))?.id;
        if (id === undefined) ends.push({ id: (id = newId()), from: sl.from, to: sl.to, sl });
        slurIdOf.set(sl, id);
      }
      // 原图上的外框记在挂上的那一端（起端优先），识别对照按弧号配框；同一条画两份的只记头一份
      const host = sl.from ?? sl.to;
      if (host && !host.slurBoxes?.some((b) => b.arc === id)) (host.slurBoxes ??= []).push({ arc: id, box: { ...sl.obj.box } });
      if (sl.from) sl.from.slurStartIds = pushId(sl.from.slurStartIds, id);
      if (sl.to) sl.to.slurStopIds = pushId(sl.to.slurStopIds, id);
      const one = sl.from && !sl.to ? sl.from : !sl.from && sl.to ? sl.to : undefined;
      if (one && !one.slurOrphans?.some((o) => o.id === id)) (one.slurOrphans ??= []).push({ id, edge: orphanEdge(sl, one), above: sl.above });
      if (one === sl.to && sl.edgeFirst && !sl.edgeFirst.slurEdgeCands?.some((o) => o.id === id)) (sl.edgeFirst.slurEdgeCands ??= []).push({ id, above: sl.above });
    }
    if (sl.from) {
      if (sl.tie) (sl.from.tieStart = true), (sl.from.tieAbove = sl.above), (sl.from.tieBox ??= { ...sl.obj.box });
      else (sl.from.slurStart = true), (sl.from.slurAbove = sl.above);
      if (sl.dashed) {
        if (sl.tie) sl.from.tieDashed = true;
        else sl.from.slurDashed = true;
      }
    }
    if (sl.to) {
      if (sl.tie) sl.to.tieStop = true;
      else {
        sl.to.slurStop = true;
        if (sl.from) sl.to.slurStopFrom = sl.from.staff;
      }
    }
  }
}
