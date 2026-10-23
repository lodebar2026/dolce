// 位图五线谱的**符干与声部**：散干标记、跨谱表的音、同度拆两声部、二度错排的干切开、符头贴干。
import type { Binary } from "../omrkit/types";
import type { Rect } from "../omrkit/types";
import { isLeadNoteBarline, systemGroups } from "../staffomr/page";
import { type BeamShape, type StaffNote, type StemInfo } from "../staffomr/notedata";
import type { Seg, SPage, Sym } from "../staffomr/model";
import { overlapY } from "../staffomr/model";
import { pushSeg, type RasterSym } from "./adapt";
import { type LineSeg } from "./prims";
import { type RasterUnit } from "./staffline";

/** 同音两声部只挂上一根干时，头另一侧的竖墨至少这么多格才算另一根干（`splitUnisons`）。 */
const UNISON_REACH = 2.0;

/** 另一根干够得上 `UNISON_REACH` 时，头缘内反方向的竖墨照旧不过半格（贴头路过的小节线、邻头的干一伸就是几格）；
 *  **已挂上的那根干带符尾**的放到这么多格：符尾常弯回头底下（是爱 p3 m36 女高女低同音 C4，朝下的干带八分尾，尾尖在头右下 0.54 格）。
 *  不分带不带尾一律放宽会误拆向主唱新歌 m2 的 B3。 */
const UNISON_BACK = 1.0;
/** 判「另一根干其实是贴着头的四分休止」时只量挨着头的这么多格（`splitUnisons` 的 `restLike`）。 */
const UNISON_REST_SPAN = 1.3;

/** 另一根干够不上 `UNISON_REACH` 时，贴着头缘、反方向（放到头外）也没墨的，这么多格就算（我灵镇静 m26 F4，歌词挤得干只伸出头外 1.1 格）。 */
const UNISON_SHORT = 1.0;

/** 干中段贴着的头：头盒缘离干（盒外）不过这么多格就收到干上（`snapHeadsToStems`）。 */
const MID_STEM_GAP = 0.4;
/** 干中段贴着的头与干端那个头至少隔这么多格（八度 3.5 格）。 */
const MID_STEM_MATE = 2.5;

/**
 * **`findStems` 漏挂的符干**（位图路补，不动 `staffomr`）。那边两道判据在细线扫描件上太紧：
 *   - 符头边缘离竖段中线要不到**两倍谱线粗**：齐来称颂谱线一两个像素，窗口两像素半，
 *     符头盒偏出两像素半就挂不上；
 *   - 头要在竖段**一端**（一格之内）：叠置和弦里靠干尾那个头在中段，单看它判不过。
 * 这里对没挂标记的竖段，窗口放到 0.2 格，按贴着它的**整组头**判：最上那个头贴上端、或最下那个贴下端，
 * 且竖段从那组头往外伸出一格半以上（小节线擦过符头时头在它中段，挡得住）；
 * 或者左右两侧各贴一个头、上下都伸出去（两个声部共线的干，见下）。
 * 病例齐来称颂末三小节低音的附点二分和弦，干在盒左缘往下伸四格，读成全音符。
 */
export function tagLooseStems(pg: SPage): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.ownerStaff && (s0.code === "noteheadBlack" || s0.code === "noteheadHalf"));
  for (const l of pg.segs) {
    if (!l.isV || l.hasAnyTag()) continue;
    const on = heads.filter((n) => overlapY(l.box, n.box) && (Math.abs(n.box.left - l.cx) < sp * 0.2 || Math.abs(n.box.right - l.cx) < sp * 0.2));
    if (!on.length) continue;
    const top = Math.min(...on.map((n) => (n.box.top + n.box.bottom) / 2));
    const bottom = Math.max(...on.map((n) => (n.box.top + n.box.bottom) / 2));
    const upEnd = Math.abs(top - l.top) <= sp && l.bottom - bottom >= sp * 1.5;
    const downEnd = Math.abs(bottom - l.bottom) <= sp && top - l.top >= sp * 1.5;
    // 二度错排的两个声部：左边的头朝上的干（贴右缘）与右边的头朝下的干（贴左缘）在同一列，
    // 连成一根两头都伸出去的竖段，两个头都落在中段（赞美三一真神 m15 的 D4/C4）。
    // 小节线擦过符头不会左右两侧各贴一个
    const twoSides =
      on.some((n) => Math.abs(n.box.right - l.cx) < sp * 0.2) &&
      on.some((n) => Math.abs(n.box.left - l.cx) < sp * 0.2) &&
      top - l.top >= sp * 1.5 &&
      l.bottom - bottom >= sp * 1.5;
    // 小节线后紧跟着的第一个音贴着小节线的左缘（同 `findStems`，见 `isLeadNoteBarline`）
    if (!twoSides && on.every((n) => n.ownerStaff && isLeadNoteBarline(l, n, n.ownerStaff))) continue;
    if (upEnd || downEnd || twoSides) l.addTag("Stem");
  }
}

/** 断成两截的一根干：两截中线横向差不过这么多格（`mergeSplitStems`）。 */
const SPLIT_STEM_DX = 0.15;
/** 两截各自伸出对方至少这么多格才并（`mergeSplitStems`）。 */
const SPLIT_STEM_OUT = 0.25;
/** 并成的干至少一头离所挂某个头的头心不过这么多格（`mergeSplitStems`）。 */
const SPLIT_STEM_END = 0.75;

/**
 * **一根干抽成了上下两截、互相叠着**：手写叠头和弦的干被头团切开，竖段一截从顶上那个头起、一截从下面那个头起，
 * 中线差一两个像素、竖向叠着一大段（是爱 p3 m46 钢琴右手 G5/B♭5：一截 2987–3057 挂两个头、一截 3008–3085 只挂 G5，
 * 外层杠在 3078，只接得上第二截，和弦按第一截算就少一层杠，十六分读成八分）。
 * 两截中线差不过 `SPLIT_STEM_DX` 格、竖向相交、两头各自伸出对方、又贴着**同一个头**的，并成一根（上下端取两截的并）。
 * 同一个头两侧的两根干（同度两声部）中线差一个头宽，并不到一起。
 */
export function mergeSplitStems(pg: SPage): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.ownerStaff && s0.hasTag("Note") && /^notehead/.test(s0.code));
  const touches = (l: Seg, n: Sym) => overlapY(l.box, n.box) && (Math.abs(n.box.left - l.cx) < sp * 0.2 || Math.abs(n.box.right - l.cx) < sp * 0.2);
  for (let again = true; again; ) {
    again = false;
    const stems = pg.segs.filter((l) => l.isV && l.hasTag("Stem"));
    for (let i = 0; i < stems.length && !again; i++)
      for (let j = i + 1; j < stems.length && !again; j++) {
        const a = stems[i];
        const b = stems[j];
        if (Math.abs(a.cx - b.cx) > sp * SPLIT_STEM_DX || Math.min(a.bottom, b.bottom) < Math.max(a.top, b.top)) continue;
        // 两头要各自伸出对方（`SPLIT_STEM_OUT` 格以上）：一截整个包在另一截里的是和弦每个头各抽了一段，并了什么也不添，
        // 反倒把两声部分开的两根干并成一根（新编 340 m14 女低 E4 并进女高的和弦）
        const [hi, lo] = a.top <= b.top ? [a, b] : [b, a];
        if (lo.top - hi.top < sp * SPLIT_STEM_OUT || lo.bottom - hi.bottom < sp * SPLIT_STEM_OUT) continue;
        if (!heads.some((n) => touches(a, n) && touches(b, n))) continue;
        // 并成的一根至少有一头落在它所挂的头上（离头心 `SPLIT_STEM_END` 格内）：两头都离头远的，是两截别的竖笔（干尾 + 小节线、
        // 两个声部的干）碰巧共线，不是一根干断成两截
        const top = Math.min(a.top, b.top);
        const bottom = Math.max(a.bottom, b.bottom);
        const cys = heads.filter((n) => touches(a, n) || touches(b, n)).map((n) => (n.box.top + n.box.bottom) / 2);
        const endGap = Math.min(...cys.map((cy) => Math.min(Math.abs(cy - top), Math.abs(cy - bottom))));
        if (endGap > sp * SPLIT_STEM_END) continue;
        const keep = a.len >= b.len ? a : b;
        for (const l of [a, b]) pg.segs.splice(pg.segs.indexOf(l), 1);
        const m = pushSeg(pg, pg.objs.length + pg.segs.length + 1, { x0: keep.cx, y0: Math.min(a.top, b.top), x1: keep.cx, y1: Math.max(a.bottom, b.bottom), lw: Math.max(a.lw, b.lw), maxLw: Math.max(a.lw, b.lw) });
        m.addTag("Stem");
        again = true;
      }
  }
}

/** 跨谱表书写的音另记的声部号（比按符干、按拍分出来的都大）。 */
const CROSS_VOICE = 5;

/** 符干至少这么多格长、且远端过了两行谱之间的中线，才算伸进了相邻那一行。 */
const CROSS_STEM = 5;

/**
 * **跨谱表书写的音不算这一行的声部**。钢琴左手的琶音常升进右手谱表：符头画在上面那行，符干一路伸到下面那行、
 * 与那边的音共用一条符杠。照符头所在的行归属，这些音就混进右手的旋律里——一小节多出四五个音，凑不满拍、
 * 声部也拆不开，逐声部对拍时右手那行整段错位（是爱 p4、p5 各有一个系统多出十来个音）。
 * 同系统上下相邻的两行之间，符干远端过了两行之间的中线、干长五格以上，且那条符杠上另有相邻那一行自己的音的，是相邻那一行借地方写的：
 * 标 `crossStaff`、`crossTo` 记借的那一行：不参加这一行的凑拍，算进那一行的（`checkBars`），写出时进那一行的声部。音高仍按符头所在那行的谱号读。
 */
export function markCrossStaff(pg: SPage, notes: StaffNote[], stems: StemInfo[], sp: number): void {
  const bySym = new Map<Sym, StaffNote>();
  for (const n of notes) bySym.set(n.sym, n);
  for (const g of systemGroups(pg)) {
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i];
      const b = g[i + 1];
      const mid = (a.box.bottom + b.box.top) / 2;
      for (const st of stems) {
        const len = st.seg.box.bottom - st.seg.box.top;
        if (len < sp * CROSS_STEM) continue;
        for (const s of st.notes) {
          const n = bySym.get(s);
          if (!n || n.rest) continue;
          // 上面那行的头、干朝下伸过中线；下面那行的头、干朝上伸过中线
          const cross = (n.staff === a && !st.up && st.seg.box.bottom > mid) || (n.staff === b && st.up && st.seg.box.top < mid);
          if (!cross) continue;
          // 还要那条符杠上另有相邻那一行自己的音：光凭干长，谱表之间挨得近时下加线上的长干音也过中线
          // 那个音得是实心头——空心头不上符杠，是它的干顶到了这条杠上（爱是从神而来 p4：上行下声部的杠落在两行之间，
          // 下行二分和弦的干正好顶着它，上行那两组八分被当成借地方写的，这一行 92.7 → 91.9%）
          const other = n.staff === a ? b : a;
          const shared = stems.some((o) => o !== st && o.beams.some((q) => st.beams.includes(q)) && o.notes.some((t) => t.code === "noteheadBlack" && bySym.get(t)?.staff === other && !bySym.get(t)?.crossStaff));
          if (!shared) continue;
          n.crossStaff = true;
          n.crossTo = other;
          n.voice = CROSS_VOICE;
        }
      }
    }
  }
}

/**
 * **同音两声部**：一个符头右边一根朝上的干、左边一根朝下的干——闭合谱里
 * 女高女低（男高男低）唱同一个音时就这么记，一个头算两个音。
 * 认成一个音的话，多声部 GT 每个同音处都少一个（《赞美一神》十处）。
 * 克隆出来的那个挂朝下的干，不带歌词与和弦（那两样挂接在后面，挂给原来那个）。
 *
 * **只挂上一根干的也要验另一侧**：「头 + 干 + 尾」块那一路一个头只取一根干，另一根没进竖段表
 *（万古磐石歌低音谱表 m6/m8 两个 F3 八分，干一上一下各带尾）。朝上干的头左缘往下、朝下干的头右缘往上
 * 有 `UNISON_REACH` 格以上的竖墨，而反方向没有墨（贴着头的小节线上下都有），就是另一个声部的干。
 */
export function splitUnisons(notes: StaffNote[], stems: StemInfo[], beams: BeamShape[], bin: Binary, sp: number): void {
  // 朝上的干在头的**右缘**、朝下的在**左缘**。和弦共用一根干时，干常被中间的头
  // 切成两段，下面那段对上面那个头来说也「朝下」，但它还在右缘，不算。
  const up = new Set<Sym>();
  const down = new Set<Sym>();
  /** 挂着的那根干带符尾的头（见 `UNISON_BACK`）。 */
  const flagged = new Set<Sym>();
  for (const st of stems) {
    const cx = (st.seg.box.left + st.seg.box.right) / 2;
    for (const s of st.notes) {
      const w = s.box.right - s.box.left;
      if (st.up && cx > s.box.left + w * 0.6) up.add(s);
      if (!st.up && cx < s.box.left + w * 0.4) down.add(s);
      if (st.flags > 0) flagged.add(s);
    }
  }
  /** 从 y0 起往 dir 方向，x 在 [x0, x1] 内最长的一段竖墨（像素行数；断口 ≤2 行，逐行可左右挪一列）。
   *  干是直的：整段左右漂出 0.15 格以上的不算（贴着头的歌词字一撇，有一位神 m7「有」）。 */
  const reach = (x0: number, x1: number, y0: number, dir: number) => {
    const drift = Math.max(2, sp * 0.15);
    const ink = (x: number, y: number) => x >= 0 && x < bin.w && y >= 0 && y < bin.h && bin.data[y * bin.w + x] === 1;
    let most = 0;
    for (let xs = Math.round(x0); xs <= Math.round(x1); xs++) {
      let last = 0;
      for (let x = xs, y = Math.round(y0), k = 0, miss = 0; miss <= 2 && y >= 0 && y < bin.h; y += dir, k++) {
        if (ink(x, y)) miss = 0;
        else if (x > x0 && ink(x - 1, y)) (x--, (miss = 0));
        else if (x < x1 && ink(x + 1, y)) (x++, (miss = 0));
        else {
          miss++;
          continue;
        }
        if (Math.abs(x - xs) > drift) break;
        last = k + 1;
      }
      most = Math.max(most, last);
    }
    return most;
  };
  /** [y0, y1] 行里、从 [x0, x1] 那几列横向连出去的墨有一个头宽（0.6~1.8 格）的行数：沿途挂着没认出来的头。
   *  谱线、加线、符杠比头宽得多，不算。 */
  const headRows = (x0: number, x1: number, y0: number, y1: number, lo = 0.6, hi = 1.8) => {
    let rows = 0;
    for (let y = Math.round(Math.min(y0, y1)); y <= Math.max(y0, y1); y++) {
      if (y < 0 || y >= bin.h) continue;
      // 落在已认符杠上的行不算：干穿过下层的短杠（倚靠主永远膀臂 m13 低音，十六分的第二道杠一格宽）
      if (beams.some((q) => q.box.left <= x1 && q.box.right >= x0 && y >= q.box.top - 1 && y <= q.box.bottom + 1)) continue;
      let widest = 0;
      for (let x = Math.round(x0); x <= Math.round(x1); x++) {
        if (x < 0 || x >= bin.w || !bin.data[y * bin.w + x]) continue;
        let l = x;
        let r = x;
        while (l > 0 && bin.data[y * bin.w + l - 1]) l--;
        while (r < bin.w - 1 && bin.data[y * bin.w + r + 1]) r++;
        widest = Math.max(widest, r - l + 1);
      }
      if (widest >= sp * lo && widest <= sp * hi) rows++;
    }
    return rows;
  };
  const heads = notes.filter((n) => !n.rest).map((n) => n.sym);
  /** 那段「竖墨」紧挨着头的 `UNISON_REST_SPAN` 格里有三成以上的行横着宽过 0.4 格：是贴着头的四分休止（扫描件上休止顶端细细地
   *  连在头底下，望十架 p3 m26 女低 C4 下的四分休止当了朝下的干），不是干。窗口同短干那一档。
   *  只量挨着头的那截：短干尖上的两层杠也是宽行（新编 367 m1 等十几处低音十六分，量满两格就把真干剔了）；
   *  那截里有一列墨直通到底的也是干（杠从干的一侧斜着伸出去，干本身是直的，f34 m1 低音 F3 十六分；休止的墨左右飘） */
  const restLike = (x0: number, x1: number, y0: number, y1: number) => {
    const y2 = y1 > y0 ? Math.min(y1, y0 + sp * UNISON_REST_SPAN) : Math.max(y1, y0 - sp * UNISON_REST_SPAN);
    const [ya, yb] = [Math.max(0, Math.round(Math.min(y0, y2))), Math.min(bin.h - 1, Math.round(Math.max(y0, y2)))];
    for (let x = Math.max(0, Math.round(x0)); x <= Math.min(bin.w - 1, Math.round(x1)); x++) {
      let y = ya;
      while (y <= yb && bin.data[y * bin.w + x]) y++;
      if (y > yb) return false;
    }
    return headRows(x0, x1, y0, y2, 0.4, 3) >= Math.abs(y2 - y0) * 0.3;
  };
  /** 头另一侧那段竖墨上不能再有别的头（那是和弦里另一个头的干）。 */
  const clear = (s: Sym, x0: number, x1: number, y0: number, y1: number) =>
    !heads.some((o) => o !== s && o.box.right > x0 && o.box.left < x1 && o.box.bottom > Math.min(y0, y1) && o.box.top < Math.max(y0, y1));
  /** [x0, x1] 里有一列竖墨从头的这一侧外 `above` 一直连到另一侧外半格：是贴着头路过的线（邻头的干、小节线），
   *  不是在这个头上停住的另一根干（宁静的伯利恒 m71/m72 钢琴十六分，低头 F4 右缘紧贴高头 F5 朝下的干，那根干一直伸到头下的符杠）。 */
  const passes = (x0: number, x1: number, b: Sym["box"], dir: number) => {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      const run = vRunAt(bin, x, Math.round(dir < 0 ? b.top - 2 : b.bottom + 2));
      if (!run) continue;
      if (dir < 0 ? run[0] <= b.top - sp * UNISON_SHORT && run[1] >= b.bottom + sp * 0.5 : run[1] >= b.bottom + sp * UNISON_SHORT && run[0] <= b.top - sp * 0.5) return true;
    }
    return false;
  };
  for (const n of notes) {
    if (n.rest || n.grace || up.has(n.sym) === down.has(n.sym)) continue;
    const b = n.sym.box;
    const w = b.right - b.left;
    // 窗口往头外放 0.25 格：另一根干常离头缘两三像素（倚靠主永远膀臂 m13 低音 A♭3，朝上的干在右缘外 2~4px）。
    // 「反方向没有墨」那道照旧只看头缘内：放宽了会碰上旁边的墨（万古磐石歌 m6 F3）
    const out = Math.max(1, sp * 0.25);
    // 另一根干短（歌词挤着，只伸出头外 1 格多）的，窗口收回头缘内、反方向的窗口放到头外：
    // 贴着头缘的小节线上下都有墨（我一生要赞美你 m4、有一位神 m1）；沿途也不能有比干宽的墨，
    // 那是紧贴着头的歌词字（晨曦破晓 m14「光」压在低音头上）
    // 头缘按头心那一行的墨实际伸到哪（至多再出半格）：头盒偏窄时另一根干落在盒缘外几像素，收回头缘内的窗口够不着
    //（你的信实广大 m14 低音男高男低同音 B♭3，盒宽 14、墨到 20，朝上的干在盒右缘外 3 像素）
    const cy = Math.round((b.top + b.bottom) / 2);
    const inkAt = (x: number) => x >= 0 && x < bin.w && cy >= 0 && cy < bin.h && bin.data[cy * bin.w + x] === 1;
    let bl = Math.round(b.left);
    while (bl > b.left - sp * 0.5 && inkAt(bl - 1)) bl--;
    let br = Math.round(b.right);
    while (br < b.right + sp * 0.5 && inkAt(br + 1)) br++;
    // 连着的墨比一个头加一根干还宽，是贴着别的头（二度挤在一起、邻音的干），不延（宁静的伯利恒钢琴谱多出假同音）
    if (br - bl > sp * 1.6) {
      bl = Math.round(b.left);
      br = Math.round(b.right);
    }
    if (up.has(n.sym)) {
      const x1 = b.left + w * 0.3;
      const len = reach(Math.min(b.left - out, bl - 1), x1, b.bottom, 1) >= sp * UNISON_REACH && reach(b.left - 1, x1, b.top, -1) < sp * (flagged.has(n.sym) ? UNISON_BACK : 0.5) ? sp * UNISON_REACH
        : reach(bl - 1, x1, b.bottom, 1) >= sp * UNISON_SHORT && reach(Math.min(b.left - out, bl - 1), x1, b.top, -1) < sp * 0.5 && headRows(bl - 1, x1, b.bottom + 2, b.bottom + sp * UNISON_SHORT, 0.4, 3) < sp * 0.2 ? sp * UNISON_SHORT : 0;
      if (len && clear(n.sym, Math.min(b.left - out, bl - 1), x1, b.bottom + 1, b.bottom + len) && headRows(Math.min(b.left - out, bl - 1), x1, b.bottom + 2, b.bottom + len) < sp * 0.3 && !restLike(bl - 1, x1, b.bottom + 2, b.bottom + len) && !passes(Math.min(b.left - out, bl - 1), b.left - 1, b, 1)) down.add(n.sym);
    } else {
      const x0 = b.right - w * 0.3;
      const len = reach(x0, Math.max(b.right + out, br + 1), b.top, -1) >= sp * UNISON_REACH && reach(x0, b.right + 1, b.bottom, 1) < sp * (flagged.has(n.sym) ? UNISON_BACK : 0.5) ? sp * UNISON_REACH
        : reach(x0, br + 1, b.top, -1) >= sp * UNISON_SHORT && reach(x0, Math.max(b.right + out, br + 1), b.bottom, 1) < sp * 0.5 && headRows(x0, br + 1, b.top - sp * UNISON_SHORT, b.top - 2, 0.4, 3) < sp * 0.2 ? sp * UNISON_SHORT : 0;
      if (len && clear(n.sym, x0, Math.max(b.right + out, br + 1), b.top - len, b.top - 1) && headRows(x0, Math.max(b.right + out, br + 1), b.top - len, b.top - 2) < sp * 0.3 && !restLike(x0, br + 1, b.top - 2, b.top - len) && !passes(b.right + 1, Math.max(b.right + out, br + 1), b, -1)) up.add(n.sym);
    }
  }
  /** 朝下那根「干」其实是头下方歌词字的一笔：头下 1.2 格内先是一段细墨、接着连续几行 0.9~2.4 格宽的横墨（字的横笔）。
   *  真干沿途只有细干本身与比 3 格宽得多的谱线（有一位神 m6/m7/m10 的 A3 贴着「有」字）。
   *  要先见细墨：头盒只罩住上半截时，往下先扫到的是头自己（以马内利来临歌 m15 D4）。落在已认符杠上的行不算。 */
  const intoText = (s: Sym) => {
    const b = s.box;
    let rows = 0;
    let run = 0;
    let thin = 0;
    for (let y = Math.round(b.bottom + 1); y <= b.bottom + sp * 1.2 && y < bin.h; y++) {
      let widest = 0;
      for (let x = Math.round(b.left - 1); x <= b.left + (b.right - b.left) * 0.3; x++) {
        if (x < 0 || x >= bin.w || !bin.data[y * bin.w + x]) continue;
        let l = x;
        let r = x;
        while (l > 0 && bin.data[y * bin.w + l - 1]) l--;
        while (r < bin.w - 1 && bin.data[y * bin.w + r + 1]) r++;
        widest = Math.max(widest, r - l + 1);
      }
      if (widest > 0 && widest <= sp * 0.3) thin++;
      // 短干接着的符杠斜着走，逐行切也是一两格宽（耶和华是我的牧者第二页 m7 D3）
      const onBeam = beams.some((q) => q.box.left <= b.right && q.box.right >= b.left && y >= q.box.top - 1 && y <= q.box.bottom + 1);
      run = !onBeam && thin >= 2 && widest >= sp * 0.9 && widest <= sp * 2.4 ? run + 1 : 0;
      rows = Math.max(rows, run);
    }
    return rows >= 3;
  };
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.rest || !up.has(n.sym) || !down.has(n.sym) || intoText(n.sym)) continue;
    n.stemUp = true;
    // 原来那根干的端点不知归哪个声部，两个都不带（排版按缺省长度画）
    n.stemTip = undefined;
    // 空心头一侧的干接着符杠的：那个声部是杠上的八分（十六分），另一侧是二分（一婴孩为我们降生 钢琴 m27–m31：
    // 上声部二分音符与下声部一串八分共用头，照抄成两个二分、小节多出一拍半；左手反过来，二分朝下、八分朝上）。
    // 杠数按头缘往外 8 格内横过干那一列的杠数（朝上的干在右缘、朝下的在左缘）
    const b = n.sym.box;
    const tol = sp * 0.3;
    // 只数离头最近那道杠起一格内叠着的几道（再远的是别的谱表的杠：一婴孩为我们降生 p4 m32 左手头上 8 格内够得着右手的杠）
    const crossing = (x: number, below: boolean) => {
      // 只认挂着别的音的干的杠：谱线的残段也会当成杠（耶和华是我的牧者 m2，女高女低同音共用 D4 二分，头上一截 6 像素厚的线段）
      const ys = beams
        .filter((q) => stems.some((st) => !st.notes.includes(n.sym) && st.beams.includes(q)))
        .filter((q) => q.box.left <= x + tol && q.box.right >= x - tol && (below ? q.box.top > b.bottom && q.box.top < b.bottom + sp * 8 : q.box.bottom < b.top && q.box.bottom > b.top - sp * 8))
        .map((q) => (below ? q.box.top - b.bottom : b.top - q.box.bottom));
      const near = Math.min(...ys);
      return ys.filter((d) => d <= near + sp).length;
    };
    const kUp = crossing(b.right, false);
    const kDown = crossing(b.left, true);
    const timed = (k: number) => {
      const base = k ? 1 / 2 ** (k + 2) : 1 / 2;
      return { beams: k, base, duration: base * (2 - 0.5 ** n.dots) };
    };
    const mixed = n.sym.code === "noteheadHalf" && (kUp > 0) !== (kDown > 0);
    if (mixed) Object.assign(n, timed(kUp));
    // 时值不同的不能并成和弦（并进去就按头一个音的时值算），单出一个音交给分声部
    const twin: StaffNote = { ...n, ...(mixed ? timed(kDown) : {}), stemUp: false, chordExtra: !mixed, lyrics: undefined, chord: undefined };
    // 自成一枚（不带干）：留着原音那枚的话，分声部按和弦取音、看不见它
    if (mixed && n.group) twin.group = { ...n.group, notes: [twin], stem: null, offset: 0, dur: 0, timed: false, voice: 1 };
    notes.splice(i + 1, 0, twin);
  }
}

/**
 * **同音两声部的全音符**：全音符没有干，`splitUnisons` 认不出它是两个声部共用的头。闭合谱上女高女低一路同度
 *（每个头都挂一上一下两根干、拆成了两个音），到句尾一个全音符照样是两个声部各一个（是爱 p3 m37–38、p5 m67–68 女声 F4）。
 * 只有全音符（不挂干、不带休止）的小节，同一行谱左边最近的那个别的小节里每个头都拆成了两个音，就照样拆；
 * 在行首（左边没有别的小节）的看右边。左边是两声部分开写的、右边才合成同度的不拆（是爱 p5 m65 女声 F4 全音符，GT 只记一个）。
 */
export function doubleUnisonWholes(pg: SPage, notes: StaffNote[]): void {
  for (const stf of pg.staves) {
    const kinds = stf.bars.map((bar) => {
      const inBar = notes.filter((n) => n.staff === stf && !n.crossStaff && !n.crossTo && n.x >= bar.left && n.x < bar.right);
      if (!inBar.length) return "empty";
      if (inBar.every((n) => !n.rest && n.sym.code === "noteheadWhole" && n.stemUp === null) && new Set(inBar.map((n) => n.sym)).size === inBar.length) return "whole";
      const heads = inBar.filter((n) => !n.rest);
      const per = new Map<Sym, number>();
      for (const n of heads) per.set(n.sym, (per.get(n.sym) ?? 0) + 1);
      return heads.length >= 2 && [...per.values()].every((k) => k === 2) ? "unison" : "other";
    });
    const near = (i: number, dir: number): string | undefined => {
      for (let j = i + dir; j >= 0 && j < kinds.length; j += dir) if (kinds[j] !== "whole" && kinds[j] !== "empty") return kinds[j];
      return undefined;
    };
    stf.bars.forEach((bar, i) => {
      if (kinds[i] !== "whole" || (near(i, -1) ?? near(i, 1)) !== "unison") return;
      for (let k = notes.length - 1; k >= 0; k--) {
        const n = notes[k];
        if (n.staff !== stf || n.x < bar.left || n.x >= bar.right) continue;
        notes.splice(k + 1, 0, { ...n, chordExtra: true, lyrics: undefined, chord: undefined });
      }
    });
  }
}

export function vRunAt(bin: Binary, x: number, y: number): [number, number] | null {
  const ink = (xx: number, yy: number) => yy >= 0 && yy < bin.h && xx >= 0 && xx < bin.w && !!bin.data[yy * bin.w + xx];
  const at = (yy: number) => ink(x, yy) || ink(x - 1, yy) || ink(x + 1, yy);
  if (!at(y)) return null;
  let a = y;
  let b = y;
  while (at(a - 1)) a--;
  while (at(b + 1)) b++;
  return [a, b];
}

/**
 * **两个声部贴着的头各用一根干**：上声部的头在右缘出朝上的干，下声部的头在左缘出朝下的干，
 * 两头相距三度时上下贴着，下声部那根干的墨一直连到上面那个头的中心——`buildNotes` 于是把上面那个头
 * 同时挂到两根干上，出两遍（《向主唱新歌》D4/B3、A4/F4 一共五处）。
 * 这里把这种干的端点缩回到本声部的头：朝下的干顶端停在「右缘另有朝上干」的头上、
 * 同一根干上往下 0.6~1.6 格还有头、干从那个头再往下伸 1.5 格以上，就把顶端挪到下面那个头的中心；朝上的对称。
 * 「再伸 1.5 格」挡的是两个头左缘连成的竖墨（齐来称颂一根朝上的干挂两个头，左缘被当成下干，歌词 96 → 54）。
 */
export function splitVoiceStems(segs: LineSeg[], heads: Rect[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  const tol = sp * 0.3;
  const xOf = (v: LineSeg) => (v.x0 + v.x1) / 2;
  const top = (v: LineSeg) => Math.min(v.y0, v.y1);
  const bot = (v: LineSeg) => Math.max(v.y0, v.y1);
  const cy = (h: Rect) => h.y + h.h / 2;
  const vertical = segs.filter((v) => bot(v) - top(v) > sp);
  return segs.map((v) => {
    if (bot(v) - top(v) <= sp) return v;
    const vx = xOf(v);
    // 朝下的干：挂在头的左缘，顶端落在头里
    const hTop = heads.find((h) => Math.abs(h.x - vx) <= tol && top(v) >= h.y - tol && top(v) <= h.y + h.h);
    if (hTop) {
      const below = heads.filter((h) => h !== hTop && Math.abs(h.x - hTop.x) <= sp * 0.4 && cy(h) - cy(hTop) >= sp * 0.6 && cy(h) - cy(hTop) <= sp * 1.6 && cy(h) <= bot(v));
      const up = vertical.some((u) => u !== v && Math.abs(xOf(u) - (hTop.x + hTop.w)) <= tol && bot(u) >= hTop.y - tol && bot(u) <= hTop.y + hTop.h + tol && top(u) < hTop.y - sp);
      if (below.length && up && bot(v) - Math.max(...below.map(cy)) >= sp * 1.5) {
        const ny = Math.min(...below.map(cy));
        return { ...v, y0: v.y0 < v.y1 ? ny : v.y0, y1: v.y0 < v.y1 ? v.y1 : ny };
      }
    }
    // 朝上的干：挂在头的右缘，底端落在头里
    const hBot = heads.find((h) => Math.abs(h.x + h.w - vx) <= tol && bot(v) >= h.y && bot(v) <= h.y + h.h + tol);
    if (hBot) {
      const above = heads.filter((h) => h !== hBot && Math.abs(h.x + h.w - (hBot.x + hBot.w)) <= sp * 0.4 && cy(hBot) - cy(h) >= sp * 0.6 && cy(hBot) - cy(h) <= sp * 1.6 && cy(h) >= top(v));
      const down = vertical.some((u) => u !== v && Math.abs(xOf(u) - hBot.x) <= tol && top(u) >= hBot.y - tol && top(u) <= hBot.y + hBot.h + tol && bot(u) > hBot.y + hBot.h + sp);
      if (above.length && down && Math.min(...above.map(cy)) - top(v) >= sp * 1.5) {
        const ny = Math.max(...above.map(cy));
        return { ...v, y0: v.y0 > v.y1 ? ny : v.y0, y1: v.y0 > v.y1 ? v.y1 : ny };
      }
    }
    return v;
  });
}

/**
 * **二度错排的两个声部共一条竖线**：上声部的头在线左（朝上的干出右缘）、下声部的头在线右（朝下的干出左缘），
 * 两根干正好对齐、连成一条贯穿两个头的竖线（248 m16 低音的 F4/E♭4）。两个头心都在线的中段，`findStems` 要头在干端，
 * 一根也挂不上，两个头都落成全音符。线左的头比线右的高 0.3~1.2 格、两头心离线两端都有 `SECOND_ARM` 格的，
 * 在两个头心处切成两根干；线右那个头已因找不到干判成全音符的，改回二分。
 * 只认二分：两端各挂符尾的实心八分（021 m2）下游本就挂得对，切了反倒带偏后面的时值。
 */
const SECOND_ARM = 2;

export function splitSecondStems(segs: LineSeg[], syms: RasterSym[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  const heads = syms.filter((s) => s.code === "noteheadHalf" || s.code === "noteheadWhole");
  const cy = (h: RasterSym) => h.box.y + h.box.h / 2;
  return segs.flatMap((v) => {
    const vx = (v.x0 + v.x1) / 2;
    const top = Math.min(v.y0, v.y1);
    const bot = Math.max(v.y0, v.y1);
    if (bot - top < sp * SECOND_ARM * 2) return [v];
    const mid = (h: RasterSym) => cy(h) - top >= sp * SECOND_ARM && bot - cy(h) >= sp * SECOND_ARM;
    const left = heads.filter((h) => h.code === "noteheadHalf" && Math.abs(h.box.x + h.box.w - vx) <= tol && mid(h));
    const right = heads.filter((h) => Math.abs(h.box.x - vx) <= tol && mid(h));
    for (const l of left)
      for (const r of right) {
        const d = cy(r) - cy(l);
        if (d < sp * 0.3 || d > sp * 1.2) continue;
        if (r.code === "noteheadWhole") r.code = "noteheadHalf";
        return [
          { ...v, y0: top, y1: cy(l) },
          { ...v, y0: cy(r), y1: bot },
        ];
      }
    return [v];
  });
}

/**
 * **头盒缘收到它的干上**：按内腔外扩一圈得来的空心头盒比墨宽，干常落在盒里离边缘三四个像素，
 * `findStems` 挂得上（两倍线宽），`buildStems` 认头却只容四分之一格，于是干有了、头没归上，
 * 下游把「没干的空心头」当全音符（《主我敬拜你》附点二分读成附点全音符）。只动 x，不动 y（音高不变）。
 *
 * **实心头同样要收**：拆块、按模板合成出来的实心头盒是定宽的，叠置和弦的干落在盒里离右缘 4~5 像素，
 * 出了 `findStems` 的两倍线宽窗口，干一根没挂上，连杠的八分全读成四分（父恩广大首小节网点符杠下的两组三度）。
 * 独唱谱音符 93.04 → 93.16%、时值 90.14 → 90.42%；合唱谱干净档音符 +0.06、扫描档 +0.36。
 * 原地改 `syms` 里的盒，原样返回竖段。
 */
export function snapHeadsToStems(syms: RasterSym[], segs: LineSeg[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  for (const s0 of syms) {
    if (s0.code !== "noteheadHalf" && s0.code !== "noteheadBlack") continue;
    const b = s0.box;
    for (const v of segs) {
      const vx = (v.x0 + v.x1) / 2;
      const top = Math.min(v.y0, v.y1);
      const bot = Math.max(v.y0, v.y1);
      if (bot - top < sp * 2 || bot < b.y || top > b.y + b.h) continue;
      const cy = b.y + b.h / 2;
      // 头在干的一端（与 findStems 同口径），**另一端不能已有别的符头**：符杠与谱线之间的空隙也会被当成
      // 内腔认出个「空心头」，它挂的那根干下端本有自己的黑头（坚固保障小节数 19 → 18）
      if (Math.abs(cy - top) > sp && Math.abs(cy - bot) > sp) continue;
      const farY = Math.abs(cy - top) < Math.abs(cy - bot) ? bot : top;
      if (syms.some((o) => o !== s0 && /^notehead/.test(o.code) && Math.abs(o.box.y + o.box.h / 2 - farY) <= sp && o.box.x - sp * 0.5 <= vx && vx <= o.box.x + o.box.w + sp * 0.5)) continue;
      if (vx > b.x + b.w - sp * 0.35 && vx < b.x + b.w) {
        s0.box = { ...b, w: Math.round(vx) - b.x };
        break;
      }
      if (vx > b.x && vx < b.x + sp * 0.35) {
        const nx = Math.round(vx);
        s0.box = { ...b, x: nx, w: b.x + b.w - nx };
        break;
      }
    }
  }
  // **干中段贴着的头**（八度双音：是爱 p3 m43、m45 钢琴右手 F5/F4、E5/E4，干朝下从上头左缘起笔、穿过下头左缘再往下 2.5 格）：
  // 拆块时干那几列归了干，下头的盒从干右边 0.3 格才起，`buildStems` 的四分之一格窗口挂不上，读成另一声部的四分。
  // 干两端都伸出头外一格以上（叠头和弦里挨着的头另有归法，收了反把盒挤坏：是爱 p1 m1 F5/A5/C6）、干端挂着同一列的另一个头、头盒缘离干不过 `MID_STEM_GAP` 格（干在盒外）的，盒缘收到干上
  for (const s0 of syms) {
    if (s0.code !== "noteheadHalf" && s0.code !== "noteheadBlack") continue;
    const b = s0.box;
    for (const v of segs) {
      const vx = (v.x0 + v.x1) / 2;
      const top = Math.min(v.y0, v.y1);
      const bot = Math.max(v.y0, v.y1);
      if (bot - top < sp * 2 || top > b.y - sp || bot < b.y + b.h + sp) continue;
      // 干的起笔端挂着另一个头、与这个头上下对齐（同一列的八度）：十六分串里贴着邻音的干路过的头不收（破碎干净版 p4 m34 G4 等十几处，收进去成了邻音的和弦音）
      // 两头隔开 `MID_STEM_MATE` 格以上（八度那样中间空着一段干）：密排和弦里挨着的头另有归法，收了盒一挪反把和弦拆乱（望十架 p10 m74 B3/D4、p9 m65）
      const mate = syms.some((o) => o !== s0 && /^notehead/.test(o.code) && Math.abs(o.box.x - b.x) <= sp * 0.5 &&
        Math.abs(o.box.y - b.y) >= sp * MID_STEM_MATE &&
        (Math.abs(o.box.y + o.box.h / 2 - top) <= sp || Math.abs(o.box.y + o.box.h / 2 - bot) <= sp));
      if (!mate) continue;
      if (vx < b.x && b.x - vx <= sp * MID_STEM_GAP) {
        const nx = Math.round(vx);
        s0.box = { ...b, x: nx, w: b.x + b.w - nx };
        break;
      }
      if (vx > b.x + b.w && vx - (b.x + b.w) <= sp * MID_STEM_GAP) {
        s0.box = { ...b, w: Math.round(vx) - b.x };
        break;
      }
    }
  }
  return segs;
}
