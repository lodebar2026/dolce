import { type StaffNote } from "../staffomr/notedata";
import { validateSlurNote, type SlurArc } from "../staffomr/slur";

// ── 和弦上的延音线 ───────────────────────────────────────────────────────────
//
// 两个同样的和弦之间每个音各一条延音线：上面那条压着谱线、去线时抹掉大半，中间的被谱线切成几截（还会被认成保持音），
// 剩下认得出的常只有最外侧那条（望十架 p3 m29–30 钢琴右手）。而这条弧挂端点按最近的符头挑，常挂到和弦里别的音上，成了圆滑线。
// 两件事：① 弧两头都在和弦上、两边有共同的音级、弧近水平，改挂到最外侧的共同音（弧在下取最低、在上取最高），判延音线；
// ② 两边音级完全相同（两个音以上）、已有一条延音线，其余同音也补上（返回要补的对，`markSlurNotes` 之后打标记）。

/** 弧两端纵向差的上限（格）：延音线是平的。 */
const CHORD_TIE_DY = 0.6;

/** 改挂时弧端离那个音外缘的上限（格）。 */
const CHORD_TIE_REACH = 1;

export function tieChords(slurs: SlurArc[], notes: StaffNote[], sp: number): [StaffNote, StaffNote][] {
  const column = (n: StaffNote): StaffNote[] =>
    notes.filter((m) => !m.rest && !m.grace && m.staff === n.staff && (m.group === n.group || Math.abs(m.x - n.x) < sp * 1.2));
  const out: [StaffNote, StaffNote][] = [];
  for (const sl of slurs) {
    const { from, to } = sl;
    if (!from || !to || from === to || from.staff !== to.staff || to.x <= from.x) continue;
    if (Math.abs(sl.ly - sl.ry) > sp * CHORD_TIE_DY) continue;
    const A = column(from), B = column(to);
    if (A.length < 2 || B.length < 2) continue;
    const dA = new Set(A.map((n) => n.diatonic)), dB = new Set(B.map((n) => n.diatonic));
    const common = [...dA].filter((d) => dB.has(d)).sort((a, b) => a - b);
    if (!common.length) continue;
    if (!sl.tie) {
      const d = sl.above ? common[common.length - 1]! : common[0]!;
      const a = A.find((n) => n.diatonic === d)!, b = B.find((n) => n.diatonic === d)!;
      // 弧端要贴着那个音（弧在下离头下缘、在上离头上缘一格以内）：跨两个和弦的圆滑线挂在别处（万口欢唱 m7）
      const near = (n: StaffNote, y: number) => (sl.above ? n.sym.box.top - y : y - n.sym.box.bottom) <= sp * CHORD_TIE_REACH;
      if (!near(a, sl.ly) || !near(b, sl.ry)) continue;
      sl.from = a;
      sl.to = b;
      sl.tie = true;
    }
    if (dA.size < 2 || dA.size !== dB.size || common.length !== dA.size) continue;
    for (const d of common) {
      const a = A.find((n) => n.diatonic === d)!, b = B.find((n) => n.diatonic === d)!;
      if (a !== sl.from) out.push([a, b]);
    }
  }
  return out;
}

// ── 一条弧的几截 ───────────────────────────────────────────────────────────
//
// 跨谱表的大弧斜着穿过好几条谱线，去线后断成几截，认成好几条弧，各挂各的音（宁静的伯利恒 p1 m13–16 钢琴那几条：
// 下截挂 C3→E4、上截又挂一条到 C5）。同向两截、首尾互相落在对方盒里（外放 `PIECE_PAD` 格）的并成一条：左端取左截的、右端取右截的。

/** 判首尾相接时盒外放（格）。 */
const PIECE_PAD = 0.3;

/** 两截端点相挨的上限（格）。 */
const PIECE_TOUCH = 0.6;

export function mergeArcPieces(slurs: SlurArc[], sp: number): void {
  const pad = sp * PIECE_PAD;
  const inBox = (b: { left: number; right: number; top: number; bottom: number }, x: number, y: number) =>
    x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (const a of slurs)
      for (const b of slurs) {
        if (a === b || a.above !== b.above || a.dashed || b.dashed) continue;
        if (!(a.lx < b.lx && b.rx > a.rx)) continue;
        // 或者两截的端点挨着（续端之后盒子没跟着长，`extendArcEnds` 只挪端点）
        // 接头不能同时是两截各自的谷底（弧在上方；弧在下方是顶）：首尾共用一个音的前后两条弧，接头两边都往外拱
        const low = (s: SlurArc, y: number) => (s.above ? y >= s.obj.box.bottom - sp * 0.5 : y <= s.obj.box.top + sp * 0.5);
        const touch = Math.abs(a.rx - b.lx) <= sp * PIECE_TOUCH && Math.abs(a.ry - b.ly) <= sp * PIECE_TOUCH && !(low(a, a.ry) && low(b, b.ly));
        if (!touch && (!inBox(a.obj.box, b.lx, b.ly) || !inBox(b.obj.box, a.rx, a.ry))) continue;
        const ab = a.obj.box, bb = b.obj.box;
        const box = { left: Math.min(ab.left, bb.left), right: Math.max(ab.right, bb.right), top: Math.min(ab.top, bb.top), bottom: Math.max(ab.bottom, bb.bottom) };
        (a.obj as { box: typeof box }).box = box;
        a.rx = b.rx;
        a.ry = b.ry;
        slurs.splice(slurs.indexOf(b), 1);
        merged = true;
        break outer;
      }
  }
}

// ── 宽弧的端 ────────────────────────────────────────────────────────────────
//
// 一组音上的长圆滑线要躲开中间最低（最高）的音，两端离端头的音三四格（破碎 p2 m15 钢琴右手 G3…G4，右端离 G4 3.9 格），
// 起点还常落在头左缘外（弧从头底下中间起）。`attachSlurs` 的三格窗口够不着。宽过 `WIDE_ARC` 格的弧，挂不上的端再找一次：
// 横向弧端落在头左右 `WIDE_ARC_DX` 格内，纵向在弧那一侧 `WIDE_ARC_REACH` 格内，取离头盒最近的；
// 弧身下（上）不能有比弧端更外侧的音（那样弧就不是躲着这组音画的）。

/** 弧宽下限（格）。 */
const WIDE_ARC = 5;

/** 弧端离头左右缘的横向容差（格）。 */
const WIDE_ARC_DX = 1;

/** 弧端离头外缘的纵向上限（格）。 */
const WIDE_ARC_REACH = 4.5;

export function attachWideSlurs(slurs: SlurArc[], notes: StaffNote[], sp: number): void {
  for (const sl of slurs) {
    if ((sl.from && sl.to) || sl.rx - sl.lx < sp * WIDE_ARC) continue;
    for (const isEnd of [false, true]) {
      if (isEnd ? sl.to : sl.from) continue;
      const px = isEnd ? sl.rx : sl.lx, py = isEnd ? sl.ry : sl.ly;
      let best: StaffNote | undefined;
      let bd = Infinity;
      for (const n of notes) {
        if (n.rest || n.grace) continue;
        const b = n.sym.box;
        if (px < b.left - sp * WIDE_ARC_DX || px > b.right + sp * WIDE_ARC_DX) continue;
        const dy = sl.above ? b.top - py : py - b.bottom;
        if (dy < 0 || dy > sp * WIDE_ARC_REACH) continue;
        // 离头盒最近点的距离。弧端要在头的「顺手」一侧（同 `validateSlurNote`：起点不在头左缘外、终点不在头右缘外，
        // 破碎 p3 m28 钢琴右手终点离 A4 右缘 6 像素、离 C5 头底 3.5 格，挂 C5）；贴着头（一格内）的不论哪侧
        // （p2 m15 起点在 G3 左缘外 11 像素、离头底 0.5 格）
        const dx = Math.max(0, b.left - px, px - b.right);
        const d = Math.hypot(dx, dy);
        const ok = d <= sp || (isEnd ? px <= b.right + 2 : px >= b.left - 2);
        if (ok && d < bd) (bd = d), (best = n);
      }
      if (!best) continue;
      // 弧身那一侧不能有越过弧的音
      const y0 = Math.min(sl.ly, sl.ry), y1 = Math.max(sl.ly, sl.ry);
      const cross = notes.some((n) => !n.rest && n.x > sl.lx && n.x < sl.rx && (sl.above ? n.sym.box.top < y0 : n.sym.box.bottom > y1) && n.staff === best!.staff);
      if (cross) continue;
      if (isEnd) sl.to = best;
      else sl.from = best;
    }
    if (sl.from && sl.to && sl.from === sl.to) sl.to = undefined;
    if (sl.from && sl.to && sl.from.staff === sl.to.staff && sl.from.diatonic === sl.to.diatonic) sl.tie = true;
  }
}

// ── 行首行尾越出音符的弧端 ───────────────────────────────────────────────────
//
// 一行最后两个音上的圆滑线画在杠上方，右端越过末音右缘近一格、正到行尾（宁静 p1 m4、p3 m36 钢琴右手 A4–B4）；
// 一行第一个音起的长弧左端在头左缘外一格多（p3 m37 C5–B4）。端头挂不上，两条都像跨行弧的半截，`reconnectSlurs` 把它们互相接上。
// 右端越过本行末音不过 `EDGE_END` 格的，止端挂末音；左端在本行首音左边不过 `EDGE_START` 格、弧又不短（`EDGE_MIN_W` 格，行首的半截弧更短）、
// 跨行也没配上的，起端挂首音。
// 真跨行的弧伸到行尾、离末音更远（破碎 p2 m11 钢琴右手两条 1.3、1.8 格）。

/** 右端越过末音右缘的上限（格）。 */
const EDGE_END = 1.2;

/** 左端在首音左缘外的上限（格）。 */
const EDGE_START = 1.5;

/** 起端离首音外缘的纵向上限（格）。 */
const EDGE_START_DY = 2.5;

/** 起端兜底的弧宽下限（格）。 */
const EDGE_MIN_W = 3;

export function attachEdgeSlurEnds(slurs: SlurArc[], notes: StaffNote[], sp: number): void {
  for (const sl of slurs) {
    if (sl.to || !sl.from) continue;
    const st = sl.from.staff;
    const last = notes.filter((n) => !n.rest && !n.grace && n.staff === st).reduce<StaffNote | undefined>((a, n) => (!a || n.sym.box.right > a.sym.box.right ? n : a), undefined);
    if (!last || last === sl.from || last.sym.box.left <= sl.from.sym.box.right) continue;
    if (sl.rx <= last.sym.box.right || sl.rx - last.sym.box.right > sp * EDGE_END) continue;
    sl.to = last;
    if (sl.from.diatonic === last.diatonic) sl.tie = true;
  }
}

/** 起端兜底在 `reconnectSlurs` **之后**：上一系统有对应的行尾悬空弧的是真跨行（望十架 p2 女高 G4 前那条，起点同样在首音左边 1.4 格）。
 *  `skip`：不做的谱行（页上第一个系统可能接的是上一页）。 */
export function attachEdgeSlurStarts(slurs: SlurArc[], notes: StaffNote[], sp: number, skip: Set<unknown>): void {
  for (const sl of slurs) {
    if (sl.from || !sl.to || skip.has(sl.to.staff) || sl.rx - sl.lx < sp * EDGE_MIN_W) continue;
    const st = sl.to.staff;
    const first = notes.filter((n) => !n.rest && !n.grace && n.staff === st).reduce<StaffNote | undefined>((a, n) => (!a || n.sym.box.left < a.sym.box.left ? n : a), undefined);
    if (!first || first === sl.to || first.sym.box.right >= sl.to.sym.box.left) continue;
    if (sl.lx >= first.sym.box.left || first.sym.box.left - sl.lx > sp * EDGE_START) continue;
    // 起端要贴着首音（弧那一侧 `EDGE_START_DY` 格内）：跨行进来的弧按上一行的高度进行，离首音远（望十架那条高出 3.8 格，宁静 1.6 格）
    const dy = sl.above ? first.sym.box.top - sl.ly : sl.ly - first.sym.box.bottom;
    if (dy < 0 || dy > sp * EDGE_START_DY) continue;
    sl.from = first;
    if (first.diatonic === sl.to.diatonic) sl.tie = true;
  }
}

/**
 * 弧端挂不上符头时，把音连同它的符干一起当盒再挂一次：钢琴低音的八分一组干朝下、杠在下面，圆滑线画在杠下、
 * 弧端贴着干端，离符头三格开外（破碎 p2 低音 m2–m6 一整排）。挂上的是这根干上离弧端最近的那个头；
 * 两端同音高的照样判延音线（同 `attachSlurs`）。
 */
export function attachSlursByStem(slurs: SlurArc[], notes: StaffNote[], sp: number): void {
  const withStem = notes.filter((n) => !n.rest && n.group?.stem);
  for (const sl of slurs) {
    if (sl.from && sl.to) continue;
    for (const isEnd of [false, true]) {
      if (isEnd ? sl.to : sl.from) continue;
      const px = isEnd ? sl.rx : sl.lx, py = isEnd ? sl.ry : sl.ly;
      let best: StaffNote | undefined;
      let bd = Infinity;
      for (const n of withStem) {
        const h = n.sym.box, g = n.group!.stem!.seg.box;
        const box = { left: Math.min(h.left, g.left), right: Math.max(h.right, g.right), top: Math.min(h.top, g.top), bottom: Math.max(h.bottom, g.bottom) };
        const v = validateSlurNote(isEnd, box, px, py, sp, sl.above);
        if (v === null) continue;
        // 同一根干上几个头：取离弧端最近的
        const d = v * 1e6 + Math.hypot((h.left + h.right) / 2 - px, (h.top + h.bottom) / 2 - py);
        if (d < bd) (bd = d), (best = n);
      }
      if (!best) continue;
      if (isEnd) sl.to = best;
      else sl.from = best;
    }
    if (sl.from && sl.to && sl.from === sl.to) sl.to = undefined;
    if (sl.from && sl.to && sl.from.staff === sl.to.staff && sl.from.diatonic === sl.to.diatonic) sl.tie = true;
  }
}
