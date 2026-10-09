// 圆滑线与连音线。移植自 musicpp `qtomr/qomr.cpp::findSlurTies` 与
// `qtomr/NoteData.cpp::analyzeSlurTie` / `SlurTie::checkTie`。
//
// 坐标一律设备坐标、y 向下——原文是 y 向上，纵向判据逐处翻过来了，见每处注释。
import { type Box, PObj, SPage, Seg, overlapX, ySpace } from "./model";
import { pathPoints } from "./vecgeom";
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
}

/**
 * `Page::findWedges`：渐强渐弱记号（`<`、`>`）。**要在找弧之前跑**——
 * 它们也是又宽又扁的图形，不先挑出来就会被当成圆滑线。
 *
 * 两种画法：三点的折线（一笔画出的 `<`）；或者两条**斜的**直线（上下各一笔）
 * 左端对齐、纵向靠近。水平/垂直的直线不算（那是谱线小节线）。
 */
export function findWedges(pg: SPage): PObj[] {
  const sp = pg.normalStaffSpace || pg.space;
  const out: PObj[] = [];
  const lines: PObj[] = [];
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.path) continue;
    const pts = pathPoints(o.path);
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
export function wedgeSpans(objs: PObj[]): import("./notations").WedgeSpan[] {
  const out: import("./notations").WedgeSpan[] = [];
  const span = (tipX: number, tipY: number, x0: number, x1: number): void => {
    out.push({ type: tipX <= (x0 + x1) / 2 ? "crescendo" : "diminuendo", x0, x1, cy: tipY });
  };
  for (let i = 0; i < objs.length; i++) {
    const pts = objs[i].path ? pathPoints(objs[i].path!) : [];
    if (pts.length === 3) {
      const xs = pts.map((p) => p.x);
      span(pts[1].x, pts[1].y, Math.min(...xs), Math.max(...xs));
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
    if (leftGap <= rightGap) span(x0, (al.y + bl.y) / 2, x0, x1);
    else span(x1, (ar.y + br.y) / 2, x0, x1);
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
  const sp = pg.normalStaffSpace || pg.space;
  const out: SlurArc[] = [];
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
    if (!p.curves && p.segs < 12) continue;
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
    if (w < sp * 0.9 || w < h * 1.5) continue;
    let isBracket = false;
    for (const l of syslines) {
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
      cur.rx = b.rx;
      cur.ry = b.ry;
    }
    out.push(cur);
  }
  return out;
}

/** 从路径点算出弧的两端与朝向（`SlurTie::SlurTie`）。 */
function arcOf(o: PObj): SlurArc | null {
  const pts = pathPoints(o.path!);
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
    let far = 0;
    for (const p of pts) {
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

export function validateSlurNote(isEnd: boolean, nt: Box, px: number, py: number, sp: number, above: boolean): number | null {
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
  if (isEnd) {
    if (px > nt.right) return null;
    if (px < nt.left - 4 * sp) return null;
    dx = px - nt.left;
  } else {
    if (px < nt.left) return null;
    if (px > nt.right + 4 * sp) return null;
    dx = px - nt.right;
  }
  return dx * dx + dy * dy;
}

/**
 * `Page::analyzeSlurTie`：给每条弧找两端的音符，再判是不是连音线。
 *
 * 连音线的判据照 `SlurTie::checkTie`：两端**在谱表上的音级相同**。
 */
export function attachSlurs(arcs: SlurArc[], notes: StaffNote[], sp: number): void {
  const pitched = notes.filter((n) => !n.rest);
  for (const sl of arcs) {
    let bestL: StaffNote | undefined;
    let bestR: StaffNote | undefined;
    let dl = Infinity;
    let dr = Infinity;
    for (const nt of pitched) {
      const b = nt.sym.box;
      const vl = validateSlurNote(false, b, sl.lx, sl.ly, sp, sl.above);
      const vr = validateSlurNote(true, b, sl.rx, sl.ry, sp, sl.above);
      if (vl !== null && vl < dl) {
        dl = vl;
        bestL = nt;
      }
      if (vr !== null && vr < dr) {
        dr = vr;
        bestR = nt;
      }
    }
    if (bestL && bestL === bestR) {
      // 两端落到同一个音符上：按 x 判掉不合理的那一端（照原文）
      if (bestL.sym.box.left > sl.rx) bestL = undefined;
      if (bestR && bestR.sym.box.right < sl.lx) bestR = undefined;
    }
    sl.from = bestL;
    sl.to = bestR;
    if (bestL && bestR && bestL.staff === bestR.staff && bestL.diatonic === bestR.diatonic) sl.tie = true;
  }
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
 */
export function reconnectSlurs(pg: SPage, arcs: SlurArc[]): void {
  const staffOf = (a: SlurArc) => (a.from ?? a.to)?.staff;
  const dangRight = arcs.filter((a) => a.from && !a.to);
  const dangLeft = arcs.filter((a) => !a.from && a.to);
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
    for (let i = 0; i + 1 < systems.length; i++) {
      const A = systems[i].staves, B = systems[i + 1].staves;
      if (A.length !== B.length) continue;
      for (let k = 0; k < A.length; k++) {
        // 行尾悬空的取最靠右的、行首悬空的取最靠左的（行里别处也有悬空的弧：另一端没挂上的），各取同样几条再按高低配
        let rs = dangRight.filter((a) => staffOf(a) === A[k]).sort((p, q) => q.rx - p.rx);
        let ls = dangLeft.filter((b) => staffOf(b) === B[k]).sort((p, q) => p.lx - q.lx);
        const n = Math.min(rs.length, ls.length);
        rs = rs.slice(0, n).sort((p, q) => rel(p, p.ry) - rel(q, q.ry));
        ls = ls.slice(0, n).sort((p, q) => rel(p, p.ly) - rel(q, q.ly));
        for (let j = 0; j < n; j++) join(rs[j], ls[j]);
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
const slurIdOf = new WeakMap<SlurArc, number>();
let nextSlurId = 1;
const pushId = (a: number[] | undefined, id: number) => (a?.includes(id) ? a : [...(a ?? []), id]);

/**
 * 只认出一端的弧，悬空那端在哪：跨行弧的前半，右端伸到本行**最后一小节**或谱表右缘之外（`end`）；
 * 跨行弧的后半，左端落在本行**第一小节的前半**（`begin`，谱号调号那段也算）；别处都是 `mid`（系统中间缺一端，多半是端点没挂上符头）。
 * 只有前两种才去接下一系统 / 上一系统的半截——光看「缺一端」就接，系统中间的半截会被接到隔着几十小节的另一个半截上（是爱 m1→m44）。
 */
function orphanEdge(sl: SlurArc, n: StaffNote): "end" | "begin" | "mid" {
  const bars = n.staff.bars;
  if (!bars.length) return "mid";
  if (!sl.to) return sl.rx >= bars[bars.length - 1].left ? "end" : "mid";
  const b0 = bars[0];
  return sl.lx <= (b0.left + b0.right) / 2 ? "begin" : "mid";
}

/** 弧 → 挂到音符上的标记。一个音符可以同时是上一条的收尾与下一条的起头。 */
export function markSlurNotes(arcs: SlurArc[]): void {
  // **两端落在同一处的弧算同一条**：同一条圆滑线常被检出两个弧对象（牵我的手每条都是两份），
  // 还有一头挂在和弦的不同成员上的（我灵镇静 m4 E4→A4、E4→F4，A4/F4 同一个和弦）。
  // 原来只记布尔值，又按谱表号编号，两条同号、读入端只留一条，碰巧是对的；按弧号逐条写出就成了两条。
  // 「同一处」= 同一个音，或同一行谱上横向差不到半个符头宽（同一和弦）。两份总在同一批里，按这一批去重
  const ends: { id: number; from?: StaffNote; to?: StaffNote }[] = [];
  const near = (a?: StaffNote, b?: StaffNote) =>
    a === b || (!!a && !!b && a.staff === b.staff && Math.abs(a.x - b.x) < (a.sym.box.right - a.sym.box.left) * 0.5);
  for (const sl of arcs) {
    if (!sl.tie) {
      let id = slurIdOf.get(sl);
      if (id === undefined) {
        id = ends.find((e) => near(e.from, sl.from) && near(e.to, sl.to))?.id;
        if (id === undefined) ends.push({ id: (id = nextSlurId++), from: sl.from, to: sl.to });
        slurIdOf.set(sl, id);
      }
      if (sl.from) sl.from.slurStartIds = pushId(sl.from.slurStartIds, id);
      if (sl.to) sl.to.slurStopIds = pushId(sl.to.slurStopIds, id);
      const one = sl.from && !sl.to ? sl.from : !sl.from && sl.to ? sl.to : undefined;
      if (one && !one.slurOrphans?.some((o) => o.id === id)) (one.slurOrphans ??= []).push({ id, edge: orphanEdge(sl, one), above: sl.above });
    }
    if (sl.from) {
      if (sl.tie) (sl.from.tieStart = true), (sl.from.tieAbove = sl.above);
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
