// **弯曲扫描的拉直**：按逐列的黑白游程比找到谱线，再按列整像素上下推平。
//
// 为什么另起一条：`rasterpage.ts::deskew` 只会给整页找**一个**斜率。真扫描件不是斜的
// 那么简单——书脊附近的页面是**弯**的，一页之内谱线的高度随 x 起伏几个像素，
// 一个斜率对付不了（实测破碎那份扫描件校正后仍有页面找不齐谱线）。
// 而后面每一步都建立在「谱线是一整行几乎全是墨的横带」上，弯一点横带就抹平了。
//
// ## 判据：**竖着看，黑白间隔的规律**
//
// 谱表在**任何一列**上都是「五段黑（线）夹着四段白（间）」，而且四段白几乎等长、
// 五段黑几乎等厚——这个规律与页面斜不斜、弯不弯**无关**，因为它是逐列量的。
// 逐列扫一遍黑游程，凡是能凑出这样一个五连的地方，就是一行谱在这一列的位置。
//
// > `staffline.ts` 开头那条「不靠白游程众数量线距」的教训在这里**不适用**：
// > 那条说的是拿**全页白游程的众数**当线距（符头内部、歌词笔画的空隙数量远超谱线间隙，
// > 众数落在 3~5 px）。这里不取众数，而是要求**五连等距**——
// > 歌词笔画凑不出五段等距的黑白相间，噪声更凑不出。
import type { Binary } from "../omr/types";
import type { StaffGroup, StaffLineRun } from "./staffline";

/** 逐列取样的步长（px）。谱线横跨整页，抽稀不影响；4 px 一页几十毫秒。 */
const COL_STEP = 4;
/** 线距的取值范围（px）。这批底本 200~300 dpi，线距实测 11~19。 */
const MIN_SPACE = 6;
const MAX_SPACE = 40;
/** 五连里四个间距彼此的相对偏差上限。 */
const EVEN_TOL = 0.22;
/** 一段「黑」最厚多少（相对线距）——比这更厚的是符头、符杠、黑边。 */
const MAX_THICK = 0.45;
/** 候选的线距离全页中位数超过这么多就不要（同一页可能两种谱表大小，留两成）。 */
const SPACE_TOL = 0.2;
/** 同一行谱在相邻取样列之间，中心 y 允许挪多少（相对线距）。 */
const TRACK_STEP = 0.5;
/** 一条轨迹要横跨页宽的几成才算数。 */
const TRACK_SPAN = 0.25;
/** 平滑窗口（取样列数）。 */
const SMOOTH = 9;
/** 逐列的位移超过这么多像素才真的动图。 */
const MIN_SHIFT = 1;
/**
 * 轨迹的一头比邻行少盖页宽的这么多以上，缺的那一截才借邻行的曲线补（见 `trackCurves`）；邻行纵向离得不过 `BORROW_NEAR` 格。
 * 只管真的断了半行的：行首谱号、调号那一小截各行都量不到、参差几格，一律去借的话各行被邻行的噪声带偏
 *（借的门槛放到四格时敬拜万世之王音符 94.4 → 62.2%、耶和华是我的牧者 97.6 → 93.8%）；隔得远的行形变也不同。
 */
const BORROW_MIN = 0.15;
const BORROW_NEAR = 15;
/** 邻行的曲线在缺的那一截上至少起伏这么多格才借。 */
const BORROW_GAIN = 0.5;

/** 一列上认出来的一行谱：中心 y 与线距。 */
export interface ColHit {
  x: number;
  cy: number;
  space: number;
  thick: number;
  /** 这一列上五条线各自的中心 y（自上而下）。合成谱线要用它，见 `completeStaffLines`。 */
  ys: number[];
}

/** 一条轨迹：同一行谱在各取样列上的中心 y（`hits` 留着，合成谱线要逐条线的 y）。 */
interface Track {
  xs: number[];
  ys: number[];
  hits: ColHit[];
}

/**
 * 逐行谱各有各的弯法——所以位移是**二维**的：`shift(x, y)`。
 *
 * 一页扫歪/扫弯，越靠书脊弯得越厉害，**页面上下两端的形变并不相同**
 * （实测主，差遣我 p2 各行谱的偏移曲线峰值差着好几个像素）。
 * 只给一条逐列曲线（各行谱取中位数）等于把所有谱行按同一条曲线推，
 * 弯得多的那几行推不平、弯得少的反被推歪——实测那一版在扫描件上净亏。
 *
 * 这一版按**行谱分带**：每条轨迹（= 一行谱）自己一条偏移曲线，
 * 像素落在两行谱之间就按 y 在两条曲线之间线性插值，页面上下两头沿用最近那条。
 */
export function applyTrackWarp(bin: Binary, tracks: TrackCurve[], also: Uint8Array[] = []): void {
  const { w, h, data } = bin;
  const out = new Uint8Array(w * h);
  const outs = also.map(() => new Uint8Array(w * h));
  const sorted = [...tracks].sort((a, b) => a.mid - b.mid);
  const cols = sorted[0].off.length;
  for (let y = 0; y < h; y++) {
    // 这一行落在哪两条轨迹之间
    let k = 0;
    while (k + 1 < sorted.length && sorted[k + 1].mid <= y) k++;
    const a = sorted[k];
    const b = k + 1 < sorted.length ? sorted[k + 1] : null;
    const t = b && b.mid > a.mid ? Math.min(1, Math.max(0, (y - a.mid) / (b.mid - a.mid))) : 0;
    for (let x = 0; x < w; x++) {
      const i = Math.min(cols - 1, Math.round(x / COL_STEP));
      const off = b ? a.off[i] * (1 - t) + b.off[i] * t : a.off[i];
      const sy = y + Math.round(off);
      if (sy < 0 || sy >= h) continue;
      out[y * w + x] = data[sy * w + x];
      for (let j = 0; j < also.length; j++) outs[j][y * w + x] = also[j][sy * w + x];
    }
  }
  data.set(out);
  also.forEach((a, j) => a.set(outs[j]));
}

/** 一行谱的偏移曲线：中位高度 + 逐取样列的偏移量。 */
export interface TrackCurve {
  mid: number;
  off: number[];
}

/**
 * **行投影漏掉的谱行，拿逐列游程的轨迹补上。**
 *
 * 行投影要求「一整行几乎全是墨」，扫得糊、线又细的底本过不了那道闸
 * ——实测主，差遣我 p4 印着 12 行谱只找出 7 行（200 dpi、线距 11.5 px、线断成一节一节）。
 * 而逐列游程在同一页上明明看得见那几行（它只要求「这一列上五段黑夹四段白」）。
 *
 * **不设「整页够不够坏」那道闸**：补哪一条只看「这条带有没有被已有的谱行盖住」，
 * 那一条就够狠了（干净位图那一档每条带都被盖住，一条也不补）。
 * 一度按「轨迹数比谱行数多四成」才补，结果是**该补的补不上**——一页十二行里只坏一行时
 * 整页都不补（实测宁静 p5 那行钢琴谱因此整个丢掉）。
 *
 * 一条轨迹合成五条线：逐条线的 y 取各列的中位数（页面这时已经推平），
 * 上下沿按实测线厚，左右端取轨迹的首尾列。
 */
/** 散线凑谱行时，缺的线位沿整行验墨的下限（见 `completeStaffLines` 末段）。 */
const LOOSE_INK = 0.7;

export function completeStaffLines(bin: Binary, lines: StaffLineRun[], groups: StaffGroup[], loose = true): { lines: StaffLineRun[]; groups: StaffGroup[] } {
  const hits = columnHits(bin);
  const cols = Math.ceil(bin.w / COL_STEP);
  if (hits.length < 20) return { lines, groups };
  const spaces = hits.map((h) => h.space).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const keep = hits.filter((h) => Math.abs(h.space - space) <= space * SPACE_TOL).sort((a, b) => a.cy - b.cy);
  const need = Math.max(20, cols * BAND_SUPPORT);
  const out = [...lines];
  const outGroups = [...groups];
  for (let i = 0; i < keep.length; ) {
    let j = i;
    while (j + 1 < keep.length && keep[j + 1].cy - keep[j].cy <= space * BAND_TOL) j++;
    const band = keep.slice(i, j + 1);
    i = j + 1;
    // **支持要够多**：同一行谱在别的窗口上也会凑出「五段黑」（错开一条线的那种），
    // 但那些只有十几列支持，而真谱行有几百列（实测干净页的假带 11~54 列、
    // 真行 260~420 列；主，差遣我 p4 漏掉的五行也有 233~318 列）。
    if (band.length < need) continue;
    const cy = median(band.map((h) => h.cy));
    // 已经被行投影找出来的谱行盖住了就跳过——干净位图那一档**全部**落在这里，
    // 所以这条补线一个像素都不会动它（实测各档分毫不差）。
    const thick = Math.max(1, median(band.map((h) => h.thick)));
    const left = Math.min(...band.map((h) => h.x));
    const right = Math.max(...band.map((h) => h.x));
    const covered = groups.find((g) => cy > g.lines[0].y - space && cy < g.lines[4].y + space);
    if (covered) {
      // **盖住了、但只盖住半截**：细线扫描件（敬拜万世之王，320dpi、谱线 1px）行投影
      // 凑得出组，线却断成虚线，右端停在页面一半（实测 1004 / 1292，真谱线到 2470），
      // 下游按这个跨度切小节、认符头，后半行整个丢掉。逐列游程看得见整行，照它延长。
      // 只在差出页宽一成以上时动——干净位图的两个跨度只差几列，一个像素都不碰。
      const ext = bin.w * EXTEND_MIN;
      const gl = Math.min(...covered.lines.map((l) => l.left));
      const gr = Math.max(...covered.lines.map((l) => l.right));
      if (right - gr > ext || gl - left > ext)
        for (const l of covered.lines) (l.left = Math.min(l.left, left)), (l.right = Math.max(l.right, right));
      continue;
    }
    const five: StaffLineRun[] = [];
    for (let k = 0; k < 5; k++) {
      const y = median(band.map((h) => h.ys[k]));
      five.push({ y, y0: y - thick / 2, y1: y + thick / 2, left, right });
    }
    out.push(...five);
    // **谱行直接给出来，不再让 `groupStaves` 从一堆线里重新凑**：行投影在这种页面上
    // 留下一地散线（实测主，差遣我 p4 有 52 条线却只凑出 7 行谱），
    // 合成的五条线混进去会被那些散线搅得凑不成一组
    // （实测补了 25 条线、谱行只从 7 涨到 8；直接给谱行才是 7 → 12）。
    outGroups.push({ lines: five, space: (five[4].y - five[0].y) / 4 });
  }
  // ── 四条等距、缺一条：**外推补上** ─────────────────────────────────────
  //
  // 有一档谱行行投影只找得出四条线：第五条被密集的符杠压着（实测宁静 p5 那行钢琴
  // 右手，五线在 1023/1043/1063/1082/**1095**，最后那条盖在三层十六分符杠下）。
  // 逐列游程也救不了它——符杠把「五段黑夹四段白」那个花样打断了。
  // 但四条等距已经把第五条的位置定死了，照着外推、再验一验那儿有没有墨即可。
  const grouped = new Set(outGroups.flatMap((g) => g.lines));
  const rest = out.filter((l) => !grouped.has(l)).sort((a, b) => a.y - b.y);
  for (let i = 0; i + 3 < rest.length; i++) {
    const four = rest.slice(i, i + 4);
    const ds = [1, 2, 3].map((k) => four[k].y - four[k - 1].y);
    const avg = (ds[0] + ds[1] + ds[2]) / 3;
    if (avg <= 0 || ds.some((d) => Math.abs(d - avg) > avg * 0.2)) continue;
    if (Math.max(...four.map((l) => l.left)) - Math.min(...four.map((l) => l.left)) > avg * 3) continue;
    const left = Math.max(...four.map((l) => l.left));
    const right = Math.min(...four.map((l) => l.right));
    if (right - left < bin.w * 0.2) continue;
    for (const y of [four[0].y - avg, four[3].y + avg]) {
      if (y < 0 || y >= bin.h) continue;
      if (outGroups.some((g) => y > g.lines[0].y - avg && y < g.lines[4].y + avg)) continue;
      // 凑出来的**整行**也不能压在已有的谱行上：只验补的那一条的话，已有谱行末线下一格的通长加线正好在一格开外，
      // 与那行的后四条又凑成一行，错开一条线叠在上面（是爱 p1 末行钢琴左手，逐列游程已经补出那一行）
      const top = Math.min(y, four[0].y);
      const bottom = Math.max(y, four[3].y);
      if (outGroups.some((g) => top < g.lines[4].y - avg * 0.5 && bottom > g.lines[0].y + avg * 0.5)) continue;
      if (inkAlong(bin, y, left, right) < LINE_INK) continue;
      const add = { y, y0: y - 1, y1: y + 1, left, right };
      const five = [...four, add].sort((a, b) => a.y - b.y);
      out.push(add);
      outGroups.push({ lines: five, space: avg });
      for (const l of five) grouped.add(l);
      i += 3;
      break;
    }
  }
  // ── 散线里凑谱行：**至少三条落在等距的线位上，缺的回图上验墨补** ─────────────
  //
  // 页面局部微斜、微弯时，一条谱线的行投影在某一行只够半截，甚至整条够不上闸：
  //   · 新编赞美诗 329 尊主为大歌第二系统高音谱表，五线 y=1172/1193.5/1215.5/1237/1259，头一条只有右半 [975,2042]、
  //     第二条只有左边 [192,761]，`groupStaves` 的「x 交集」「左缘一致」两道闸过不去；
  //   · 322 信徒精兵歌第一行只找出三条（第三条还裂成上下差两像素的左右两截），后两条没有；
  //   · 297 心中阳光歌两行各只有三四条半截线。
  // 整行谱没了，下一行低音谱表还被并进上一个系统。做法：同一条线裂成的两截先并起来；以一条散线为基准，
  // 把间距是线距整数倍（两成以内）的散线归到线位上，够三条、其中至少两条跨过半页的，试各种「基准是第几线」的摆法，
  // 缺的线位在原图上沿整行验墨（上下容 0.3 格，页面斜着也量得到），都够 `LOOSE_INK` 的取墨最足的那种摆法成组。
  // 五条都在、都跨满、只是左缘差得多（6 格以上）的不管——后面另有一路按实测线位接回去，
  // 这里抢先成组反而用了不准的线位（我灵镇静末行左缘 124~320，音符 98.9 → 93.1）。
  // `loose = false`：推平要不要采纳的那道自检（`rasterpage.ts::completedAfterDeskew`）不走这一段，走下面那段旧的简版
  //（只认五条连着等距的）。那道自检量的是「推平前后各找得出几行」，凑行的本事一变，推平采不采纳就跟着变，
  // 整页像素都不一样了：这一段全开或全关，天父加恩歌 95.7 → 88.5，三首短歌的调号也跟着错回去。
  if (loose) {
    const done = new Set(outGroups.flatMap((g) => g.lines));
    const known = outGroups.map((g) => g.space).sort((a, b) => a - b);
    const ref = known.length ? known[known.length >> 1] : 0;
    const lenOf = (l: StaffLineRun) => l.right - l.left;
    // 同一条线裂成的两截（y 差不到 0.3 格）并成一条，y 按长度加权
    const loose: StaffLineRun[] = [];
    for (const l of out.filter((q) => !done.has(q) && lenOf(q) >= bin.w * 0.15).sort((a, b) => a.y - b.y)) {
      const p = loose[loose.length - 1];
      if (ref && p && l.y - p.y <= ref * 0.3) {
        const wa = lenOf(p);
        const wb = lenOf(l);
        const y = (p.y * wa + l.y * wb) / (wa + wb);
        loose[loose.length - 1] = { y, y0: y - 1, y1: y + 1, left: Math.min(p.left, l.left), right: Math.max(p.right, l.right) };
      } else loose.push(l);
    }
    const tol = Math.max(2, Math.round(ref * 0.3));
    /** y 这一行上下 tol 像素里，[left, right] 每隔 4 列有墨的列占比 */
    const inkTol = (y: number, left: number, right: number): number => {
      let n = 0;
      let hit = 0;
      for (let x = Math.round(left); x <= right; x += 4) {
        n++;
        for (let d = -tol; d <= tol; d++) {
          const yy = Math.round(y) + d;
          if (yy >= 0 && yy < bin.h && bin.data[yy * bin.w + x]) {
            hit++;
            break;
          }
        }
      }
      return n ? hit / n : 0;
    };
    const used = new Set<StaffLineRun>();
    for (let i = 0; ref && i < loose.length; i++) {
      const a = loose[i];
      if (used.has(a)) continue;
      // 归线位：a 记 0 号，往下找间距是整数倍线距的
      const slot = new Map<number, StaffLineRun>([[0, a]]);
      for (const l of loose.slice(i + 1)) {
        if (used.has(l)) continue;
        const k = (l.y - a.y) / ref;
        const r = Math.round(k);
        if (r < 1 || r > 4) continue;
        if (Math.abs(k - r) > 0.2) continue;
        if (!slot.has(r) || lenOf(l) > lenOf(slot.get(r)!)) slot.set(r, l);
      }
      if (slot.size < 3) continue;
      const mem = [...slot.values()];
      const full = mem.filter((l) => lenOf(l) >= bin.w * 0.5);
      if (full.length < 2) continue;
      if (slot.size === 5 && full.length === 5 && Math.max(...mem.map((l) => l.left)) - Math.min(...mem.map((l) => l.left)) > ref * 6) continue;
      const left = Math.min(...full.map((l) => l.left));
      const right = Math.max(...full.map((l) => l.right));
      const maxSlot = Math.max(...slot.keys());
      // 线距照成员拟合（首尾两条的距离 / 线位差）
      const avg = (slot.get(maxSlot)!.y - a.y) / maxSlot;
      let best: { s: number; score: number } | null = null;
      for (let s0 = 0; s0 + maxSlot <= 4; s0++) {
        const ys = [0, 1, 2, 3, 4].map((k) => a.y + (k - s0) * avg);
        if (outGroups.some((g) => ys[0] < g.lines[4].y + avg * 0.5 && ys[4] > g.lines[0].y - avg * 0.5)) continue;
        let score = 0;
        let ok = true;
        for (let k = 0; k < 5; k++) {
          if (slot.has(k - s0)) continue;
          const v = inkTol(ys[k], left, right);
          if (v < LOOSE_INK) ok = false;
          score += v;
        }
        if (ok && (!best || score > best.score)) best = { s: s0, score };
      }
      if (!best) continue;
      const five: StaffLineRun[] = [0, 1, 2, 3, 4].map((k) => {
        const m = slot.get(k - best!.s);
        const y = m ? m.y : a.y + (k - best!.s) * avg;
        // 跨过半页的成员留着自己的跨度（天父加恩歌：都拉成同一个跨度反而差，95.7 → 88.5）；半截的、补出来的用整行的跨度
        const own = m && lenOf(m) >= bin.w * 0.5;
        return { y, y0: m ? m.y0 : y - 1, y1: m ? m.y1 : y + 1, left: own ? m!.left : left, right: own ? m!.right : right };
      });
      for (const l of mem) used.add(l);
      // 成员的原线（连同裂成两截的那几条）从线表里摘掉，换成这五条：线表里一行谱只该有五条
      for (let k = out.length - 1; k >= 0; k--) {
        const l = out[k];
        if (!done.has(l) && five.some((f) => Math.abs(f.y - l.y) <= ref * 0.3)) out.splice(k, 1);
      }
      out.push(...five);
      for (const f of five) done.add(f);
      outGroups.push({ lines: five, space: avg });
    }
  }
  if (!loose)
  {
    const done = new Set(outGroups.flatMap((g) => g.lines));
    const loose = out.filter((l) => !done.has(l)).sort((a, b) => a.y - b.y);
    const known = outGroups.map((g) => g.space).sort((a, b) => a - b);
    const ref = known.length ? known[known.length >> 1] : 0;
    for (let i = 0; ref && i + 4 < loose.length; i++) {
      const five = loose.slice(i, i + 5);
      const ds = [1, 2, 3, 4].map((k) => five[k].y - five[k - 1].y);
      const avg = (ds[0] + ds[1] + ds[2] + ds[3]) / 4;
      if (ds.some((d) => Math.abs(d - avg) > avg * 0.2) || Math.abs(avg - ref) > ref * 0.15) continue;
      if (outGroups.some((g) => five[0].y < g.lines[4].y + avg && five[4].y > g.lines[0].y - avg)) continue;
      const full = five.filter((l) => l.right - l.left >= bin.w * 0.6);
      if (full.length < 3) continue;
      if (full.length === 5) {
        // 五条都跨满、只是左缘参差（`LEFT_SPREAD` 那道闸）：差得不多（6 格以内，行首被连谱号、弧线压着）的原样成组，
        // 跨度不动（诗篇一五零篇一行五条左缘 179~262）。差得多的不管——后面另有一路按实测线位接回去，
        // 这里抢先成组反而用了不准的线位（我灵镇静末行左缘 124~320，音符 98.9 → 93.1）
        if (Math.max(...five.map((l) => l.left)) - Math.min(...five.map((l) => l.left)) > avg * 6) continue;
      } else {
        const left = Math.min(...full.map((l) => l.left));
        const right = Math.max(...full.map((l) => l.right));
        for (const l of five) (l.left = left), (l.right = right);
      }
      outGroups.push({ lines: five, space: avg });
      i += 4;
    }
  }
  // 成了组的谱行里**每条线都拉到整行的跨度**（验过墨才拉）。行投影给的左右端是「这一行够墨的那一段」，页面微斜时
  // 一条线只够半截、或左端晚起一截；后面建谱行按线长滤候选（不到最长横线的三成五不要，接受我心歌第四行第五线只有
  // [174,765]，整行谱没了），谱行的左右界也跟着最短的那条走（善恶两军歌两行从 x=172、274 才起，前面的音全丢）。
  // 整行的跨度取五条里最左与最右；某条线在这个跨度上沿线验墨（上下容 0.3 格）够 `LOOSE_INK` 才拉过去——
  // 真的短一截的（通长加线顶替进来的）验不过，不动。
  if (loose)
    for (const g of outGroups) {
      const left = Math.min(...g.lines.map((l) => l.left));
      const right = Math.max(...g.lines.map((l) => l.right));
      const tol = Math.max(2, Math.round(g.space * 0.3));
      for (const l of g.lines) {
        if (l.left <= left + g.space && l.right >= right - g.space) continue;
        let n = 0;
        let hit = 0;
        for (let x = Math.round(left); x <= right; x += 4) {
          if (x >= l.left && x <= l.right) continue; // 只验要补的那两段
          n++;
          for (let d = -tol; d <= tol; d++) {
            const yy = Math.round(l.y) + d;
            if (yy >= 0 && yy < bin.h && bin.data[yy * bin.w + x]) {
              hit++;
              break;
            }
          }
        }
        if (n && hit / n >= LOOSE_INK) (l.left = left), (l.right = right);
      }
    }
  // **整行比别的行短一截的，照本页多数行的左右端验墨补齐**。逐列游程补出来的行，左右端取的是「看得见五黑四白」的那一段，
  // 行首挤着谱号、调号、弱起的音时晚起一大截（善恶两军歌两行从 x=343、548 才起，别的行都从 170 上下起）。
  // 本页各行左端、右端各取中位；短的那一头沿五条线验墨，至少四条够 `LOOSE_INK` 就拉过去。
  if (loose && outGroups.length >= 3) {
    const med = (a: number[]) => a.slice().sort((p, q) => p - q)[a.length >> 1];
    const L = med(outGroups.map((g) => Math.min(...g.lines.map((l) => l.left))));
    const R = med(outGroups.map((g) => Math.max(...g.lines.map((l) => l.right))));
    const inkSeg = (y: number, x0: number, x1: number, tol: number): number => {
      let n = 0;
      let hit = 0;
      for (let x = Math.round(x0); x <= x1; x += 4) {
        n++;
        for (let d = -tol; d <= tol; d++) {
          const yy = Math.round(y) + d;
          if (yy >= 0 && yy < bin.h && bin.data[yy * bin.w + x]) {
            hit++;
            break;
          }
        }
      }
      return n ? hit / n : 0;
    };
    for (const g of outGroups) {
      const tol = Math.max(2, Math.round(g.space * 0.3));
      const gl = Math.min(...g.lines.map((l) => l.left));
      const gr = Math.max(...g.lines.map((l) => l.right));
      if (gl > L + g.space * 2 && g.lines.filter((l) => inkSeg(l.y, L, gl, tol) >= LOOSE_INK).length >= 4) for (const l of g.lines) l.left = Math.min(l.left, L);
      if (gr < R - g.space * 2 && g.lines.filter((l) => inkSeg(l.y, gr, R, tol) >= LOOSE_INK).length >= 4) for (const l of g.lines) l.right = Math.max(l.right, R);
    }
  }
  outGroups.sort((a, b) => a.lines[0].y - b.lines[0].y);
  return { lines: out.sort((a, b) => a.y - b.y), groups: outGroups };
}

/** 已有谱行的跨度比逐列游程短出页宽的这个比例，才照游程延长。 */
const EXTEND_MIN = 0.1;

/** 外推出来的第五条线，那一带要有几成的列见到墨才认（符杠压着的地方本来就断）。 */
const LINE_INK = 0.5;

/** 一条横线上有墨的列占多少。 */
function inkAlong(bin: Binary, y: number, left: number, right: number): number {
  const y0 = Math.max(0, Math.round(y) - 1);
  const y1 = Math.min(bin.h - 1, Math.round(y) + 1);
  let n = 0;
  let tot = 0;
  for (let x = Math.max(0, left); x <= Math.min(bin.w - 1, right); x++) {
    tot++;
    for (let yy = y0; yy <= y1; yy++)
      if (bin.data[yy * bin.w + x]) {
        n++;
        break;
      }
  }
  return tot ? n / tot : 0;
}

/** 同一条带里，各列命中的中心 y 允许差多少（线距的倍数）。 */
const BAND_TOL = 0.4;
/** 一条带要有几成的取样列支持才算一行谱。干净页上的假带只有一成出头，真行有六成以上。 */
const BAND_SUPPORT = 0.25;

/**
 * **排查用**：逐列黑白游程看得见几行谱（不管页面平不平）。
 *
 * 与行投影（`findStaffLines` + `groupStaves`）是两条独立的证据：那一路要求
 * 「一整行几乎全是墨」，页面一弯就抹平；这一路逐列量，与斜弯无关。
 * 两个数一比，就知道谱线还漏不漏——见 `scripts/chorus-report.mjs` 的「谱行」两列。
 */
export function columnStaffTracks(bin: Binary): { count: number; bands: number; space: number } {
  const hits = columnHits(bin);
  if (hits.length < 20) return { count: 0, bands: 0, space: 0 };
  const spaces = hits.map((h) => h.space).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const keep = hits.filter((h) => Math.abs(h.space - space) <= space * SPACE_TOL);
  // `count` = 串成轨迹的（推平要用的，闸严）；
  // `bands` = **只按中心 y 聚一聚**（诊断用的宽松口径：轨迹会被符号打断，
  // 干净页上 100 行谱只串得出 33 条，当不了「一页有几行谱」的标尺）。
  const cys = keep.map((h) => h.cy).sort((a, b) => a - b);
  let bands = 0;
  let i = 0;
  while (i < cys.length) {
    let j = i;
    while (j + 1 < cys.length && cys[j + 1] - cys[j] <= space * 0.5) j++;
    if (j - i + 1 >= 10) bands++; // 至少十个取样列上看得见
    i = j + 1;
  }
  return { count: buildTracks(keep, space, bin.w).length, bands, space };
}

/**
 * 逐列黑白游程 → 各行谱的偏移曲线。找不到（页面本来就是平的、或谱线找不齐）返回 null。
 */
export function trackCurves(bin: Binary): TrackCurve[] | null {
  const hits = columnHits(bin);
  if (hits.length < 20) return null;
  const spaces = hits.map((h) => h.space).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const keep = hits.filter((h) => Math.abs(h.space - space) <= space * SPACE_TOL);
  const tracks = buildTracks(keep, space, bin.w);
  if (tracks.length < 2) return null;
  const cols = Math.ceil(bin.w / COL_STEP);
  const out: TrackCurve[] = [];
  let peak = 0;
  // **只量到半行的轨迹，缺的那一截借邻行的曲线补**。一行谱的轨迹被长休止、密集的符杠截断后只盖住半行，
  // 缺的那一截原先按最近的有效值平着补：别的行整页的斜度都推平了，这一行缺的半截没推，成了「单独斜着的半行」
  //（是爱 p4 钢琴左手只量到左半行，推平之后右端比上一行低一格半，小节线两端落不到外线上，整行少切一个小节）。
  // 页面的形变上下相邻的行差不多：缺的那一截（要缺页宽的一成半以上）照**纵向最近、那一侧盖得更远的邻行**的曲线走（接在自己最后一个实测值上）；
  // 没有这样的邻行（各行都只量到那儿）照旧平着补。盖得远的先算，好给盖得近的借。
  const spanOf = (t: Track) => {
    const cs = t.xs.map((x) => Math.min(cols - 1, Math.round(x / COL_STEP)));
    return { first: Math.min(...cs), last: Math.max(...cs) };
  };
  const done: { mid: number; first: number; last: number; off: number[] }[] = [];
  const need = Math.round(cols * BORROW_MIN);
  for (const t of [...tracks].sort((a, b) => spanOf(b).last - spanOf(b).first - (spanOf(a).last - spanOf(a).first))) {
    const mid = median([...t.ys]);
    const raw = new Array<number>(cols).fill(NaN);
    for (let i = 0; i < t.xs.length; i++) raw[Math.min(cols - 1, Math.round(t.xs[i] / COL_STEP))] = t.ys[i] - mid;
    const { first, last } = spanOf(t);
    const donor = (side: -1 | 1) =>
      done
        // 纵向不到三格的是**同一行谱的另一截轨迹**，不借：两条曲线各按各的中位高度推，借了之后这行谱上下两半各奔一个高度，
        // 线距被拉开（耶和华是我的牧者首行，音符 97.6 → 91.7%）
        .filter((d) => Math.abs(d.mid - mid) >= space * 3 && Math.abs(d.mid - mid) <= space * BORROW_NEAR && (side < 0 ? d.first <= first - need : d.last >= last + need))
        .sort((a, b) => Math.abs(a.mid - mid) - Math.abs(b.mid - mid))[0];
    // 邻行的曲线在缺的那一截上起伏不到半格的不借：平着补也差不了多少，借了反倒把邻行的噪声带进来
    // 邻行的曲线在缺的那一截上起伏不到半格的不借：平着补也差不了多少，借了反倒把邻行的噪声带进来
    const worth = (d: (typeof done)[number] | undefined, from: number, to: number) => (d && Math.abs(d.off[to] - d.off[from]) >= space * BORROW_GAIN ? d.off : undefined);
    const off = smoothFill(raw, worth(donor(-1), first, 0), worth(donor(1), last, cols - 1));
    if (!off) continue;
    for (const v of off) peak = Math.max(peak, Math.abs(v));
    out.push({ mid, off });
    done.push({ mid, first, last, off });
  }
  if (out.length < 2 || peak < MIN_SHIFT) return null;
  return out;
}

/** 逐行再推平时，一行谱沿横向量几处。 */
const LEVEL_PROBES = 9;
/** 量一处用的窗口半宽（格）。 */
const LEVEL_WIN = 3;
/** 相邻两处之间错位最多变这么多格。 */
const LEVEL_STEP = 0.4;
/** 五条线在窗口里的墨占比过这么多，这一处才算量到。 */
const LEVEL_INK = 0.6;
/** 有一行谱两端的错位差到这么多格，才动图。 */
export const LEVEL_MIN = 0.5;

/**
 * **纠斜之后各行谱残余的倾斜**：整页只找一个斜率（`deskew`），而扫描件上下两端的斜度常不一样
 * ——页首是平的，越往下越斜（烛光颂曲 p3、p5、p7 下半页的谱行行首比平线模型低一格、行尾高一格）。
 * 这种页逐列游程的推平（`trackCurves`）又常被自检否决（推完丢一行谱），下游拿着平线模型去读斜着的谱：
 * 行首的谱号、调号窗口偏大半格，音高从行首到行尾一路错过去。
 *
 * 这里不再找谱线，只**量已找到的谱行**：一行谱沿横向取 `LEVEL_PROBES` 处，各处把五条线的模型整体上下挪，
 * 取窗口里压到墨最多的那个错位（五条线一起量，符头、歌词凑不出五条等距的横墨）。
 * 量到的点拟合一条直线，就是这一行谱的偏移曲线，交给 `applyTrackWarp` 按行分带推平；两端差不到 `LEVEL_MIN` 格的行偏移记零。
 * 没有哪一行差到这么多的页返回 null（平的页不动图）。
 */
export function residualCurves(bin: Binary, groups: StaffGroup[]): TrackCurve[] | null {
  const cols = Math.ceil(bin.w / COL_STEP);
  const out: TrackCurve[] = [];
  let worst = 0;
  for (const g of groups) {
    if (g.lines.length !== 5) continue;
    const sp = g.space;
    const left = Math.max(...g.lines.map((l) => l.left));
    const right = Math.min(...g.lines.map((l) => l.right));
    if (right - left < sp * LEVEL_WIN * 6) continue;
    const ys = g.lines.map((l) => Math.round(l.y));
    const pts: { x: number; d: number }[] = [];
    const half = Math.round(sp * LEVEL_WIN);
    const step = Math.round(sp * LEVEL_STEP);
    /** 第 k 处：在 around ± step 里找压到墨最多的错位；没量到返回 null */
    const probe = (k: number, around: number): number | null => {
      const cx = Math.round(left + half + ((right - left - half * 2) * k) / (LEVEL_PROBES - 1));
      let best = 0;
      let bd = around;
      for (let d = around - step; d <= around + step; d++) {
        let n = 0;
        for (const y of ys) {
          const yy = y + d;
          if (yy < 0 || yy >= bin.h) continue;
          for (let x = cx - half; x <= cx + half; x++) if (x >= 0 && x < bin.w && bin.data[yy * bin.w + x]) n++;
        }
        // 一样多的取离上一处近的（线有几像素厚）
        if (n > best || (n === best && Math.abs(d - around) < Math.abs(bd - around))) (best = n), (bd = d);
      }
      if (best < 5 * (half * 2 + 1) * LEVEL_INK) return null;
      pts.push({ x: cx, d: bd });
      return bd;
    };
    // **从行中往两头一处一处跟**：每处只在上一处的错位上下 `LEVEL_STEP` 格里找。整段放开找的话，
    // 错开一整格时也有四条线对得上（耶和华是我的牧者首行量出「斜两格」，推完音符 97.6 → 91.7%）
    const mid = LEVEL_PROBES >> 1;
    const d0 = probe(mid, 0) ?? 0;
    for (let k = mid + 1, d = d0; k < LEVEL_PROBES; k++) d = probe(k, d) ?? d;
    for (let k = mid - 1, d = d0; k >= 0; k--) d = probe(k, d) ?? d;
    pts.sort((a, b) => a.x - b.x);
    if (pts.length < LEVEL_PROBES / 2) continue;
    // 残余的是**倾斜**，按直线拟合（斜率取两两连线的中位数，压到符杠、歌词跳开的个别点带不偏）；
    // 逐点连折线的话，平的谱行上一像素的量化抖动也被推成锯齿（独唱谱 45 首音符 98.16 → 97.33%）
    const slopes: number[] = [];
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) slopes.push((pts[b].d - pts[a].d) / (pts[b].x - pts[a].x));
    const slope = median(slopes);
    const icpt = median(pts.map((q) => q.d - slope * q.x));
    const tilt = Math.abs(slope * (right - left)) / sp;
    worst = Math.max(worst, tilt);
    // 两端差不到 `LEVEL_MIN` 格的行不动（偏移记零，仍留着给相邻的行分带用）
    const flat = tilt < LEVEL_MIN;
    const off = Array.from({ length: cols }, (_, i) => (flat ? 0 : icpt + slope * i * COL_STEP));
    out.push({ mid: (ys[0] + ys[4]) / 2, off });
  }
  return out.length && worst >= LEVEL_MIN ? out : null;
}

/** 逐列找「五段黑、四段白等距」的地方。**排查也用它**（见 `columnStaffTracks`）。 */
export function columnHits(bin: Binary): ColHit[] {
  const { w, h, data } = bin;
  const out: ColHit[] = [];
  const starts: number[] = [];
  const lens: number[] = [];
  for (let x = 0; x < w; x += COL_STEP) {
    starts.length = 0;
    lens.length = 0;
    let y = 0;
    while (y < h) {
      if (!data[y * w + x]) {
        y++;
        continue;
      }
      const s = y;
      while (y < h && data[y * w + x]) y++;
      starts.push(s);
      lens.push(y - s);
    }
    // 五连窗口
    for (let i = 0; i + 4 < starts.length; i++) {
      const c: number[] = [];
      let thick = 0;
      let ok = true;
      for (let k = 0; k < 5; k++) {
        c.push(starts[i + k] + lens[i + k] / 2);
        thick += lens[i + k];
      }
      const ds = [1, 2, 3, 4].map((k) => c[k] - c[k - 1]);
      const avg = (ds[0] + ds[1] + ds[2] + ds[3]) / 4;
      if (avg < MIN_SPACE || avg > MAX_SPACE) continue;
      for (const d of ds) if (Math.abs(d - avg) > avg * EVEN_TOL) ok = false;
      // 「黑」要够薄：谱线约 0.1~0.3 个线距厚，符头、符杠厚得多
      for (let k = 0; k < 5 && ok; k++) if (lens[i + k] > avg * MAX_THICK) ok = false;
      if (!ok) continue;
      out.push({ x, cy: (c[0] + c[4]) / 2, space: avg, thick: thick / 5, ys: c.slice() });
      i += 4; // 一列上认出一行谱就跳过它这五段（免得错位再凑一个）
    }
  }
  return out;
}

/** 把逐列的命中串成轨迹：x 相邻、中心 y 挨着的算同一行谱。 */
function buildTracks(hits: ColHit[], space: number, width: number): Track[] {
  const byX = new Map<number, ColHit[]>();
  for (const h of hits) {
    const a = byX.get(h.x) ?? [];
    a.push(h);
    byX.set(h.x, a);
  }
  const xs = [...byX.keys()].sort((a, b) => a - b);
  const open: { t: Track; lastX: number; lastY: number }[] = [];
  const done: Track[] = [];
  // 谱号、调号和密集符杠会遮住几格宽的五线花样；固定 24px 在高分辨率扫描件
  // 上还不到两格，会把整行轨迹切成达不到 TRACK_SPAN 的碎片。纵向仍须在半格内，
  // 延长的只是同一行谱可以跨过的横向遮挡。是否采纳推平另由 dewarpPage 验证。
  const maxJump = Math.max(COL_STEP * 6, space * 4);
  for (const x of xs) {
    const used = new Set<ColHit>();
    for (const o of open) {
      if (x - o.lastX > maxJump) continue;
      let best: ColHit | null = null;
      let bd = space * TRACK_STEP;
      for (const h of byX.get(x)!) {
        if (used.has(h)) continue;
        const d = Math.abs(h.cy - o.lastY);
        if (d < bd) {
          bd = d;
          best = h;
        }
      }
      if (!best) continue;
      used.add(best);
      o.t.xs.push(x);
      o.t.ys.push(best.cy);
      o.t.hits.push(best);
      o.lastX = x;
      o.lastY = best.cy;
    }
    for (const h of byX.get(x)!) {
      if (used.has(h)) continue;
      open.push({ t: { xs: [x], ys: [h.cy], hits: [h] }, lastX: x, lastY: h.cy });
    }
    // 断掉太久的收工
    for (let i = open.length - 1; i >= 0; i--)
      if (x - open[i].lastX > maxJump) {
        done.push(open[i].t);
        open.splice(i, 1);
      }
  }
  for (const o of open) done.push(o.t);
  return done.filter((t) => t.xs.length >= 8 && t.xs[t.xs.length - 1] - t.xs[0] >= width * TRACK_SPAN);
}

/**
 * 缺口按前一个有效值补上，再做一遍滑动中位数。两头没量到的那一段默认也平着补；给了邻行的曲线（`left` / `right`）
 * 就照它的起伏走、接在自己最靠那一头的实测值上（见 `trackCurves`）。
 */
function smoothFill(raw: number[], left?: number[], right?: number[]): number[] | null {
  const n = raw.length;
  const filled = new Array<number>(n).fill(NaN);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++)
    if (!Number.isNaN(raw[i])) {
      if (first < 0) first = i;
      last = i;
    }
  if (first < 0) return null;
  let prev = raw[first];
  for (let i = first; i <= last; i++) {
    if (!Number.isNaN(raw[i])) prev = raw[i];
    filled[i] = prev;
  }
  for (let i = 0; i < first; i++) filled[i] = raw[first] + (left ? left[i] - left[first] : 0);
  for (let i = last + 1; i < n; i++) filled[i] = raw[last] + (right ? right[i] - right[last] : 0);
  const out = new Array<number>(n);
  const half = SMOOTH >> 1;
  for (let i = 0; i < n; i++) {
    const a: number[] = [];
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) a.push(filled[j]);
    }
    out[i] = median(a);
  }
  return out;
}

function median(a: number[]): number {
  a.sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
}
