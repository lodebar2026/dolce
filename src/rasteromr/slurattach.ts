import { type StaffNote } from "../staffomr/notedata";
import { validateSlurNote, orphanEdge, type SlurArc } from "../staffomr/slur";

// ── 和弦上的延音线 ───────────────────────────────────────────────────────────
//
// 两个同样的和弦之间每个音各一条延音线：上面那条压着谱线、去线时抹掉大半，中间的被谱线切成几截（还会被认成保持音），
// 剩下认得出的常只有最外侧那条（望十架 p3 m29–30 钢琴右手）。而这条弧挂端点按最近的符头挑，常挂到和弦里别的音上，成了圆滑线。
// 两件事：① 弧两头都在和弦上、两边有共同的音级、弧近水平，改挂到最外侧的共同音（弧在下取最低、在上取最高），判延音线；
// ② 两边音级完全相同（两个音以上）、已有一条延音线，其余同音也补上（返回要补的对，`markSlurNotes` 之后打标记）。
//    **补之前要有证据**：同一段上另有一条弧，或在原图上验墨——两个和弦之间、那个音上下各 `CHORD_TIE_BAND` 格的带里（谱线、加线那几行不算）有墨的列要过 `CHORD_TIE_INK`。
//    印了却认不出的延音线照样留着碎墨（望十架那几截）；排版软件只印最外侧一条的（破碎 p5 m49 钢琴左手八度只连下面的 D2、
//    p12 m108 右手全音符和弦只连顶音），和弦之间是白的，补上就多出几条延音线、MIDI 里少起几个音。

/** 弧两端纵向差的上限（格）：延音线是平的。 */
const CHORD_TIE_DY = 0.6;

/** 改挂时弧端离那个音外缘的上限（格）。 */
const CHORD_TIE_REACH = 1;

/** 验墨带：音头中心上下各几格。 */
const CHORD_TIE_BAND = 0.7;

/** 验墨带：和弦最外侧那个音往外伸几格（它的延音线画在和弦外面，弧腹离头一格多）。 */
const CHORD_TIE_OUTER = 2.5;

/** 验墨：和弦之间有墨的列至少占几成。 */
const CHORD_TIE_INK = 0.5;

/** 同一段上的另一条弧：左右各放几格、至少有这条的几成长。 */
const CHORD_TIE_TWIN = 1.5;
const CHORD_TIE_TWIN_LEN = 0.3;
const CHORD_TIE_TWIN_R = 3;

/** `inkCols(x0, x1, y0, y1)`：原图 [x0, x1) 列里，[y0, y1] 行（谱线行除外）有墨的列占几成。不给就不验。
 *  返回补出来的延音线两端与朝向：比认出那条弧挂的音高的朝上、低的朝下（和弦延音线的常规画法），同音级随那条弧 */
export function tieChords(
  slurs: SlurArc[], notes: StaffNote[], sp: number,
  inkCols?: (x0: number, x1: number, y0: number, y1: number) => number,
): [StaffNote, StaffNote, boolean][] {
  /** `outer`：-1 / 1 = 这个音是和弦里最上 / 最下那个、找到的那条在另一头：它的延音线画在和弦外侧，带子往外伸到 `CHORD_TIE_OUTER` 格
   *（望十架 p8 m60 两个全音符的和弦，上面的音延音线在上、下面的音在下） */
  const inked = (a: StaffNote, b: StaffNote, outer: number) => {
    if (!inkCols) return true;
    const yc = (a.sym.box.top + a.sym.box.bottom) / 2;
    const x0 = a.sym.box.right + sp * 0.2, x1 = b.sym.box.left - sp * 0.2;
    const up = outer < 0 ? CHORD_TIE_OUTER : CHORD_TIE_BAND, down = outer > 0 ? CHORD_TIE_OUTER : CHORD_TIE_BAND;
    return x1 <= x0 || inkCols(x0, x1, yc - sp * up, yc + sp * down) >= CHORD_TIE_INK;
  };
  const column = (n: StaffNote): StaffNote[] =>
    notes.filter((m) => !m.rest && !m.grace && m.staff === n.staff && (m.group === n.group || Math.abs(m.x - n.x) < sp * 1.2));
  const out: [StaffNote, StaffNote, boolean][] = [];
  for (const sl of slurs) {
    const { from, to } = sl;
    if (!from || !to || from === to || from.staff !== to.staff || to.x <= from.x) continue;
    if (Math.abs(sl.ly - sl.ry) > sp * CHORD_TIE_DY) continue;
    const A = column(from), B = column(to);
    // ⓪ 一头单音、一头和弦，两头相邻（中间这行谱上没有别的音），单音那个音级在和弦里：弧挂到了和弦里别的音上，改挂共同音、判延音线。
    // 二度和弦的音错开排，弧从错到干另一侧的头起（破碎 p5 m55–56 钢琴右手 F4/G4 → F4，弧高出头两格，规则 ① 的「贴着」过不了），
    // 跨小节线的那几处同此（m59、m74、m93）
    if (!sl.tie && (A.length < 2) !== (B.length < 2)) {
      const single = A.length < 2 ? from : to;
      const chord = A.length < 2 ? B : A;
      const right = Math.max(...A.map((n) => n.x)), left = Math.min(...B.map((n) => n.x));
      const between = notes.some((m) => !m.rest && !m.grace && m.staff === from.staff && m.x > right + sp * 0.3 && m.x < left - sp * 0.3);
      // 只管**二度**：共同音与弧挂着的那头差一个音级（挤在一起的两个头，里面那个的延音线没地方画，画到和弦外面去了）。
      // 三度以上的和弦里每个音的延音线都画得下，弧挂在外侧那个音上就是它自己的圆滑线（新编赞美诗 073 m20 F4/A4 → A4 是 F4→A4 的圆滑线）。
      // 还得同一个声部：同一个和弦组、干与单音同向（闭合谱两个声部共一行，「和弦」常是女高女低各一个音，011 m25）
      const end = single === from ? to : from;
      const twin = chord.find(
        (n) =>
          n.diatonic === single.diatonic && n !== single && Math.abs(n.diatonic - end.diatonic) <= 1 && n.group === end.group &&
          (n.stemUp === null || single.stemUp === null || n.stemUp === single.stemUp),
      );
      if (!between && twin) {
        if (single === from) sl.to = twin;
        else sl.from = twin;
        sl.tie = true;
      }
      continue;
    }
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
    // 两个和弦之间另有一条弧落在同一段里（同一行谱，左右各放 `CHORD_TIE_TWIN` 格，不短于这条的 `CHORD_TIE_TWIN_LEN`）：
    // 每个音各有一条。外侧的那几条画在和弦外面（是爱 p1 m1 两音和弦，上面的音延音线在上、下面的音在下），验墨看不到；
    // 里面那条比外面的短、起得晚（是爱 m54 三音和弦），压线的常只认出半截（是爱 m1 下面那条只到一半），都照算；
    // 右端常顺着下一个和弦的符杠续长（是爱 m65 下面那条），右边多放到 `CHORD_TIE_TWIN_R` 格
    const twin = slurs.some(
      (o) =>
        o !== sl && (o.from ?? o.to)?.staff === from.staff &&
        o.lx >= sl.lx - sp * CHORD_TIE_TWIN && o.rx <= sl.rx + sp * CHORD_TIE_TWIN_R && o.rx - o.lx >= (sl.rx - sl.lx) * CHORD_TIE_TWIN_LEN,
    );
    for (const d of common) {
      const a = A.find((n) => n.diatonic === d)!, b = B.find((n) => n.diatonic === d)!;
      const outer = sl.above ? (d === common[0] ? 1 : 0) : d === common[common.length - 1] ? -1 : 0;
      if (a !== sl.from && (twin || inked(a, b, outer))) {
        const ref = sl.from!.diatonic;
        out.push([a, b, d > ref ? true : d < ref ? false : sl.above]);
      }
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

/** 接头处往音符那侧收了多少格算「这一截在这儿收尾」。 */
const PIECE_TAIL = 0.3;

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
        // 接头两边都往音符那侧收（弧在上方：a 的右端、b 的左端都比各自的顶低 `PIECE_TAIL` 格以上；弧在下方反过来）的不并：
        // 那是首尾共用一个音的前后两条弧，一条弧被切成的两截在接头处总有一截是平着或往外走的。
        // 「端点挨着」与「盒子互相罩着」两路都过这道闸（破碎 p12 m100 女低：圆滑线收在 D5 上、紧接 D5→D5 跨小节线的延音线，
        // 并成一条就成了从圆滑线起点到下一小节 D5 的弧）
        const tail = (s: SlurArc, y: number) => (s.above ? y - s.obj.box.top : s.obj.box.bottom - y) >= sp * PIECE_TAIL;
        if (tail(a, a.ry) && tail(b, b.ly)) continue;
        const touch = Math.abs(a.rx - b.lx) <= sp * PIECE_TOUCH && Math.abs(a.ry - b.ly) <= sp * PIECE_TOUCH;
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

// ── 隔着一段的两截 ──────────────────────────────────────────────────────────
//
// 跨谱表大弧的陡段贴着音头、符干走，那一截并进了音符的墨块，弧只剩陡段两头各一截（宁静 p1 m11 钢琴 D3→C5：
// 下截 D3 起、右端停在 E4 头旁，上截从 E4 上方平着收到 C5，接头隔 3 格多）。`mergeArcPieces` 要两截挨着，并不上。
// 两截同向、接头在 `BRIDGE_GAP` 格内（平的接头 `BRIDGE_FLAT_GAP`），左截末端、接头弦、右截三段的斜率依次单调（弧上方：越往右越往下弯；下方反过来，
// 合起来是一条凸向一侧的弧），接头弦上逐列（弦到弧凸起一侧 `BRIDGE_BULGE` 格的带里）都有墨的，并成一条。

/** 接头两端的距离上限（格）。 */
const BRIDGE_GAP = 5;

/** 接头弦外侧的墨带宽（格）：弦与真弧之间的拱高。 */
const BRIDGE_BULGE = 0.8;

/** 接头弦上有墨的列占比下限。 */
const BRIDGE_INK = 0.9;

/** 平的接头（长弧拱顶那段没认出来）两端距离上限（格）。 */
const BRIDGE_FLAT_GAP = 60;

export function bridgeArcPieces(slurs: SlurArc[], sp: number, ink: (x: number, y: number) => boolean, onLine: (y: number, x?: number) => boolean): void {
  const slope = (x0: number, y0: number, x1: number, y1: number) => (y1 - y0) / Math.max(1, x1 - x0);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (const a of slurs)
      for (const b of slurs) {
        if (a === b || a.above !== b.above || a.dashed || b.dashed || a.tie || b.tie) continue;
        const gx = b.lx - a.rx, gy = b.ly - a.ry;
        // 陡的接头：贴着音头、符干那段；平的接头：长弧拱顶整段没认出（宁静 p7 m89 女高一整行的弧，拱顶擦着上方的文字，只剩两头各一截）。
        // 平的接头隔得远，验墨时谱线行上的墨不算（弦贴着一条谱线时线会把墨带填满）
        const steep = Math.abs(gy) >= sp;
        if (gx <= 0 || Math.hypot(gx, gy) > sp * (steep ? BRIDGE_GAP : BRIDGE_FLAT_GAP)) continue;
        // 弧上方（∩）在图像坐标里斜率从左到右递增；下方（∪）递减
        const s = [slope(a.lx, a.ly, a.rx, a.ry), slope(a.rx, a.ry, b.lx, b.ly), slope(b.lx, b.ly, b.rx, b.ry)];
        const mono = a.above ? s[0] <= s[1] && s[1] <= s[2] : s[0] >= s[1] && s[1] >= s[2];
        if (!mono) continue;
        const out = a.above ? -1 : 1, bulge = sp * BRIDGE_BULGE;
        let hit = 0, n = 0;
        for (let x = Math.ceil(a.rx); x <= Math.floor(b.lx); x++, n++) {
          const y = a.ry + (gy * (x - a.rx)) / gx;
          for (let d = -2; d <= bulge; d++) {
            const yy = Math.round(y + out * d);
            if (ink(x, yy) && (steep || !onLine(yy, x))) {
              hit++;
              break;
            }
          }
        }
        if (!n || hit < n * BRIDGE_INK) continue;
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
const EDGE_START = 2.5;

/** 起端离首音外缘的纵向上限（格）。 */
const EDGE_START_DY = 3.5;

/** 量起端纵向距离时，首音右边几格内的音一起算（首拍那组十六分高低交替，弧贴着高的那个走）。 */
const EDGE_START_SPAN = 2;

/** 起端可以比首拍那组音的外缘还往里多少（格）：弧从头侧边起笔、比头顶略低（宁静 p5 m71 低 0.44 格）。 */
const EDGE_START_UNDER = 1;

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
 *  `skip`：页上第一个系统的谱行（可能接的是上一页）：只记 `edgeFirst`，整曲拼页时再定（`song.ts::settleEdgeSlurStarts`）。 */
export function attachEdgeSlurStarts(slurs: SlurArc[], notes: StaffNote[], sp: number, skip: Set<unknown>): void {
  for (const sl of slurs) {
    if (sl.from || !sl.to || sl.rx - sl.lx < sp * EDGE_MIN_W) continue;
    const st = sl.to.staff;
    const first = notes.filter((n) => !n.rest && !n.grace && n.staff === st).reduce<StaffNote | undefined>((a, n) => (!a || n.sym.box.left < a.sym.box.left ? n : a), undefined);
    if (!first || first === sl.to || first.sym.box.right >= sl.to.sym.box.left) continue;
    if (sl.lx >= first.sym.box.left || first.sym.box.left - sl.lx > sp * EDGE_START) continue;
    // 起端要贴着首音（弧那一侧 `EDGE_START_DY` 格内）：跨行进来的弧按上一行的高度进行，离首音远（望十架那条高出 3.8 格，宁静 1.6 格）
    const head = notes.filter((n) => !n.rest && !n.grace && n.staff === st && n.sym.box.left <= first.sym.box.left + sp * EDGE_START_SPAN);
    const dy = sl.above ? Math.min(...head.map((n) => n.sym.box.top)) - sl.ly : sl.ly - Math.max(...head.map((n) => n.sym.box.bottom));
    if (dy < -sp * EDGE_START_UNDER || dy > sp * EDGE_START_DY) continue;
    // 页首系统：先记下，整曲拼页时上一页末系统没有对应的行尾半截才挂（同音高的多半是跨页延音线，不记）
    if (skip.has(st)) {
      if (first.diatonic !== sl.to.diatonic) sl.edgeFirst = first;
      continue;
    }
    sl.from = first;
    if (first.diatonic === sl.to.diatonic) sl.tie = true;
  }
}

// ── 弧在干那一侧时按干挪端 ────────────────────────────────────────────────────
//
// 弧画在符干那一侧（干朝上、弧在上方）时，弧端对着的是干端，不是头：一组十六分上方的弧从第一根干右边一点起笔
//（破碎 p7 m70 钢琴右手：起点在第一根干右 7 像素、第二根干左 15 像素），按头盒量（`attachSlurs`）第二个音的头更近，起端挂错一个音。
// 已挂上的端，挂的那个音的干在弧端外侧（起端：干在弧端右边 `STEM_ORDER` 格以外；止端反过来）、
// 同一行谱上另有同朝向的干落在弧端内侧 `STEM_SNAP` 格以内的，改挂干离弧端最近的那个。

/** 弧端往里找干的范围（格）。 */
const STEM_SNAP = 1;

/** 干背着弧时改挂：弧端在干外侧多远以内（格，旗尾约一格宽）。 */
const STEM_TIP_DX = 2;

/** 干背着弧时改挂：弧端离干端的纵向上限（格）。 */
const STEM_TIP_DY = 2;

export function snapSlurEndsToStems(slurs: SlurArc[], notes: StaffNote[], sp: number): void {
  const stemX = (n: StaffNote) => {
    const g = n.group?.stem?.seg.box;
    return g ? (g.left + g.right) / 2 : undefined;
  };
  for (const sl of slurs) {
    // 延音线两头贴着头，不按干挪
    if (sl.tie) continue;
    for (const isEnd of [false, true]) {
      const n = isEnd ? sl.to : sl.from;
      if (!n) continue;
      // 挂着的音干背着弧（弧在上、干朝下）：前面（止端：后面）紧挨着有个干朝弧那侧的音、弧端就在它的干端外侧，改挂那个音
      //（破碎 p7 m70 钢琴左手：八分 B2 干朝上带旗，弧从旗尾右边、下一个 F3 头正上方起，GT 起在 B2）
      if (n.stemUp !== null && n.stemUp !== sl.above) {
        const px = isEnd ? sl.rx : sl.lx, py = isEnd ? sl.ry : sl.ly;
        const m = notes
          .filter((m) => m !== n && !m.rest && !m.grace && m.staff === n.staff && m.stemUp === sl.above && m.stemTip !== undefined && (isEnd ? m.x > n.x : m.x < n.x))
          .find((m) => {
            const mx = stemX(m);
            if (mx === undefined) return false;
            const out = isEnd ? mx - px : px - mx;
            return out >= -sp * STEM_ORDER && out <= sp * STEM_TIP_DX && Math.abs(py - m.stemTip!) <= sp * STEM_TIP_DY;
          });
        if (m) {
          if (isEnd) sl.to = m;
          else sl.from = m;
        }
        continue;
      }
      if (n.stemUp === null || n.stemUp !== sl.above) continue;
      const nx = stemX(n);
      if (nx === undefined) continue;
      const px = isEnd ? sl.rx : sl.lx;
      // 起端：干在弧端右边过 `STEM_ORDER` 格才挪；止端：干在弧端左边
      if ((isEnd ? px - nx : nx - px) <= sp * STEM_ORDER) continue;
      let best: StaffNote | undefined;
      let bd = Infinity;
      for (const m of notes) {
        if (m === n || m.rest || m.grace || m.staff !== n.staff || m.stemUp !== n.stemUp) continue;
        const mx = stemX(m);
        if (mx === undefined) continue;
        const inward = isEnd ? mx - px : px - mx;
        if (inward < -sp * STEM_ORDER || inward > sp * STEM_SNAP) continue;
        const d = Math.abs(mx - px);
        if (d < bd) (bd = d), (best = m);
      }
      if (!best) continue;
      if (isEnd) sl.to = best;
      else sl.from = best;
    }
    if (sl.from && sl.to && sl.from === sl.to) sl.to = undefined;
  }
}

// ── 补齐另一端 ──────────────────────────────────────────────────────────────
//
// 除了跨系统的半截（行尾 `end`、行首 `begin`，由 `reconnectSlurs` / 写出端跨页接），一条弧两端都要挂、而且挂在不同的音上。
// 前面几路挂完还缺一端的（系统中间的 `mid`，写出端整条不写），缺的那端挂到弧端那一侧
// 本行谱上离弧端横向最近的音（头中心横向 `COMPLETE_DX` 格内；起端要在止音左边、止端要在起音右边）。
// 两端挂到同一个音上的不是弧，两端都摘掉。

/** 补端时弧端离音头中心的横向上限（格）。 */
const COMPLETE_DX = 3;

export function completeSlurEnds(slurs: SlurArc[], notes: StaffNote[], sp: number): void {
  const cx = (n: StaffNote) => (n.sym.box.left + n.sym.box.right) / 2;
  const nearest = (st: unknown, px: number, ok: (n: StaffNote) => boolean) =>
    notes
      .filter((n) => !n.rest && !n.grace && n.staff === st && ok(n) && Math.abs(cx(n) - px) <= sp * COMPLETE_DX)
      .reduce<StaffNote | undefined>((a, n) => (!a || Math.abs(cx(n) - px) < Math.abs(cx(a) - px) ? n : a), undefined);
  for (const sl of slurs) {
    if (sl.from && sl.to && sl.from === sl.to) {
      // 两端挂同一个音的不是弧（字的弯笔、符尾、点之类），整条不要
      sl.from = sl.to = undefined;
      sl.tie = false;
      continue;
    } else if (sl.from && !sl.to) {
      if (orphanEdge(sl, sl.from) !== "mid") continue;
      const f = sl.from;
      sl.to = nearest(f.staff, sl.rx, (m) => cx(m) > cx(f));
    } else if (!sl.from && sl.to) {
      if (orphanEdge(sl, sl.to) !== "mid") continue;
      const t = sl.to;
      sl.from = nearest(t.staff, sl.lx, (m) => cx(m) < cx(t));
    } else continue;
    if (sl.from && sl.to && sl.from.staff === sl.to.staff && sl.from.diatonic === sl.to.diatonic && !notes.some((m) => !m.rest && m.staff === sl.from!.staff && cx(m) > cx(sl.from!) && cx(m) < cx(sl.to!))) sl.tie = true;
  }
}

/** 弧端越过那根干的容差（格）。 */
const STEM_ORDER = 0.25;

/** 按干挂不上时纵向再放宽的格数。 */
const STEM_REACH_MORE = 2;

/** 放宽那遍不要求另一端先挂上的弧宽下限（格）：长弧不像碎墨（破碎 p7 m73 钢琴右手两端都差一点够不着）。 */
const STEM_REACH_LONG = 5;

/**
 * 弧端挂不上符头时，把音连同它的符干一起当盒再挂一次：钢琴低音的八分一组干朝下、杠在下面，圆滑线画在杠下、
 * 弧端贴着干端，离符头三格开外（破碎 p2 低音 m2–m6 一整排）。挂上的是这根干上离弧端最近的那个头；
 * 两端同音高的照样判延音线（同 `attachSlurs`）。
 */
export function attachSlursByStem(slurs: SlurArc[], notes: StaffNote[], sp: number, inText?: (sl: SlurArc) => boolean): void {
  const withStem = notes.filter((n) => !n.rest && n.group?.stem);
  for (const sl of slurs) {
    if (sl.from && sl.to) continue;
    // 两端先各按三格挂一遍，再给缺的那端放宽（另一端挂上了才放；长弧不要求）
    for (const [isEnd, loose] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      if (isEnd ? sl.to : sl.from) continue;
      if (loose && ((!(isEnd ? sl.from : sl.to) && sl.rx - sl.lx < sp * STEM_REACH_LONG) || inText?.(sl))) continue;
      const px = isEnd ? sl.rx : sl.lx, py = isEnd ? sl.ry : sl.ly;
      let best: StaffNote | undefined;
      let bd = Infinity;
      // 挂不上的再放宽纵向：弧端往音符那侧挪 `STEM_REACH_MORE` 格再量（破碎 p4 m32 钢琴右手：起点在带旗十六分 D4 右边、
      // 下一组 E4 的干左 10 像素，D4 的干端低 3.5 格，`validateSlurNote` 三格够不着；GT 起在 D4）
      // 放宽那遍只给另一端已挂上的弧（两端都挂不上的多是扫描件上的碎墨，爱是 p1 m11；长弧例外），碰着整页文字框的也不放（`inText`：
      // 你的信实广大 m20 歌词「广」的一撇挂成 D4→C4）
      const more = loose ? STEM_REACH_MORE : 0;
      for (const n of withStem) {
        const h = n.sym.box, g = n.group!.stem!.seg.box;
        const box = { left: Math.min(h.left, g.left), right: Math.max(h.right, g.right), top: Math.min(h.top, g.top), bottom: Math.max(h.bottom, g.bottom) };
        const v = validateSlurNote(isEnd, box, px, py + (sl.above ? 1 : -1) * sp * more, sp, sl.above);
        if (v === null) continue;
        // 起端不在起音的干左边、止端不在止音的干右边（容 `STEM_ORDER` 格）：一组十六分上方的弧，起端的细尾巴二值化后断成几粒点，
        // 认出的起点落到第二个音的头上方，按「头 + 干」的盒量第二个音反倒更近（破碎 p4 m30 钢琴右手，起点在第一根干右边 17 像素、第二根干左边 9 像素）
        const sx = (g.left + g.right) / 2;
        if ((isEnd ? px - sx : sx - px) > sp * STEM_ORDER) continue;
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
