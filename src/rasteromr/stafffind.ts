// **按游程找谱线**：逐列的黑白游程里找「五段黑夹四段白、四段白等长」，串成一行行谱，五条线各自随 x 走（`LineCurve`）。
//
// 不用行投影：行投影要「一整行几乎全是墨」，页面一斜、一弯横带就抹平（2000 px 宽的页斜 0.5° 两端差一个线距），
// 而识别不推平、不纠斜（`rasterpage.ts::rasterizeImage`）。这个规律与页面斜不斜、弯不弯**无关**，因为它是逐列量的。
//
// > `staffline.ts` 里「不靠白游程众数量线距」的教训在这里**不适用**：那条说的是拿**全页白游程的众数**当线距
// >（符头内部、歌词笔画的空隙数量远超谱线间隙，众数落在 3~5 px）。这里不取众数，而是要求**五连等距**——
// > 歌词笔画凑不出五段等距的黑白相间，噪声更凑不出。
import type { Binary } from "../omrkit/types";
import { lineYAt, type LineCurve, type RasterUnit, type StaffGroup, type StaffLineRun } from "./staffline";
import { median } from "../omrkit/geom";

/** 逐列取样的步长（px）。谱线横跨整页，抽稀不影响；4 px 一页几十毫秒。 */
const COL_STEP = 4;
/** 线距的取值范围（px）。这批底本 200~300 dpi，线距实测 11~19；上限另随页面放大（`maxSpaceOf`）。 */
const MIN_SPACE = 6;
const MAX_SPACE = 40;
/** 高分辨率的图线距上限按长边放：是谁 4958×6600 的图线距六十来像素。 */
const maxSpaceOf = (bin: Binary) => Math.max(MAX_SPACE, Math.round(Math.max(bin.w, bin.h) / 50));
/** 五连里四个间距彼此的相对偏差上限。 */
const EVEN_TOL = 0.22;
/** 一段「黑」最厚多少（相对线距）——比这更厚的是符头、符杠、黑边。 */
const MAX_THICK = 0.45;
/** 候选的线距离全页中位数超过这么多就不要（同一页可能两种谱表大小，留两成）。 */
const SPACE_TOL = 0.2;
/** 同一行谱在相邻取样列之间，中心 y 允许挪多少（相对线距）。 */
const TRACK_STEP = 0.5;
/** 平滑窗口（取样列数）。 */
const SMOOTH = 9;
/** 一行谱至少要有这么多取样列量到五连（占页宽取样列数的比例；另有 `MIN_COLS` 兜底）。 */
const STAFF_SUPPORT = 0.12;
const MIN_COLS = 16;
/** 两截轨迹中心差不过这么多格、横向不重叠的是同一行谱断成的几截；横向重叠的是错开一条线凑出的假五连。 */
const SAME_STAFF = 2.5;
/** 曲线谱线在谱行左右端内起伏不过这么多像素（且整体偏移不过一像素）的不挂曲线：平直的行按常数 y。 */
const FLAT_SPREAD = 1.5;
/** 沿曲线往两头验墨定左右端：五条线里至少几条那一列有墨才算谱线还在。 */
const EXTENT_LINES = 4;

/** 一列上认出来的一行谱：中心 y 与线距。 */
export interface ColHit {
  x: number;
  cy: number;
  space: number;
  thick: number;
  /** 这一列上五条线各自的中心 y（自上而下）。 */
  ys: number[];
}

/** 一条轨迹：同一行谱在各取样列上的中心 y（`hits` 留着，合成谱线要逐条线的 y）。 */
interface Track {
  xs: number[];
  ys: number[];
  hits: ColHit[];
}

/**
 * **找谱表**：逐列五连（`columnHits`）→ 串成轨迹（`buildTracks`，被密集音符隔断的几截按走向接回，`joinTracks`）
 * → 同一行谱的几截并起来、错开一条线凑出的假五连丢掉 → 每行谱五条线各取各列的 y。
 *
 * - 线位：每条线的常数 `y` 取各列实测的中位；随 x 的偏移五条线共用一条（各列五条线偏移的中位，单条线的采样被符头、
 *   符杠带偏，五条一起量才稳），量到的列之间线性插值，两头按整段的斜率（两两连线斜率的中位数）外推，再滑动中位数压掉单列的跳变。
 *   谱行左右端内起伏不过 `FLAT_SPREAD` 像素、整体偏移不过一像素的不挂曲线。
 * - 左右端：从轨迹两头沿曲线逐列往外验墨，五条线里 `EXTENT_LINES` 条以上有墨的列算谱线还在；断口容半格，
 *   端点要连着一格有墨才算（系统的花括号、乐器名的笔画擦到谱线那一带，不能一擦就把左缘拉过去）；
 *   虚线（各条线断口错开）每条线看左右四分之一格的小窗再走一遍，远出两格以上才用它。
 * - 单位：线距取各行谱线距的中位，线宽取五连各段黑的平均厚度的中位（取整）。
 *
 * 一行谱都凑不出返回 null（封面、歌词页、简谱页）。
 */
export function findRasterStaves(bin: Binary): { unit: RasterUnit; groups: StaffGroup[] } | null {
  const hits = columnHits(bin);
  if (hits.length < 20) return null;
  const space = median(hits.map((h) => h.space));
  const keep = hits.filter((h) => Math.abs(h.space - space) <= space * SPACE_TOL);
  const cols = Math.ceil(bin.w / COL_STEP);
  const colOf = (x: number) => Math.min(cols - 1, Math.round(x / COL_STEP));
  // 轨迹按量到的列数从多到少：先收的是真谱行，与它横向重叠、纵向挨着的是错开一条线的假五连，丢掉；横向不重叠的是同一行谱的另一截，并进来
  const tracks = joinTracks(buildTracks(keep, space, bin.w, 0, 1), space)
    .filter((t) => t.xs.length >= 8)
    .sort((a, b) => b.xs.length - a.xs.length);
  const staves: { hits: ColHit[]; cy: number; x0: number; x1: number }[] = [];
  for (const t of tracks) {
    const cy = median(t.ys);
    const x0 = t.xs[0];
    const x1 = t.xs[t.xs.length - 1];
    const near = staves.filter((s) => Math.abs(s.cy - cy) < space * SAME_STAFF);
    if (near.some((s) => x0 <= s.x1 && x1 >= s.x0)) continue;
    const same = near.sort((a, b) => Math.abs(a.cy - cy) - Math.abs(b.cy - cy))[0];
    if (same && Math.abs(same.cy - cy) < space * TRACK_STEP * 2) {
      same.hits.push(...t.hits);
      same.x0 = Math.min(same.x0, x0);
      same.x1 = Math.max(same.x1, x1);
      continue;
    }
    staves.push({ hits: [...t.hits], cy, x0, x1 });
  }
  const need = Math.max(MIN_COLS, cols * STAFF_SUPPORT);
  const groups: StaffGroup[] = [];
  const thicks: number[] = [];
  for (const st of staves) {
    if (new Set(st.hits.map((h) => h.x)).size < need) continue;
    const ys = [0, 1, 2, 3, 4].map((k) => median(st.hits.map((h) => h.ys[k])));
    const thick = median(st.hits.map((h) => h.thick));
    thicks.push(thick);
    // 逐列五条线的共同偏移
    const per: number[][] = Array.from({ length: cols }, () => []);
    for (const h of st.hits) per[colOf(h.x)].push(median(h.ys.map((y, k) => y - ys[k])));
    const raw = per.map((a) => (a.length ? median(a) : NaN));
    const known = raw.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0);
    const pick = known.filter((_, i) => i % Math.max(1, Math.floor(known.length / 60)) === 0);
    const slopes: number[] = [];
    for (let a = 0; a < pick.length; a++) for (let b = a + 1; b < pick.length; b++) slopes.push((raw[pick[b]] - raw[pick[a]]) / (pick[b] - pick[a]));
    const slope = slopes.length ? median(slopes) : 0;
    const first = known[0];
    const last = known[known.length - 1];
    const filled = new Array<number>(cols);
    let prev = first;
    for (let c = 0; c < cols; c++) {
      if (c < first) filled[c] = raw[first] + slope * (c - first);
      else if (c > last) filled[c] = raw[last] + slope * (c - last);
      else if (!Number.isNaN(raw[c])) (filled[c] = raw[c]), (prev = c);
      else {
        let next = c + 1;
        while (Number.isNaN(raw[next])) next++;
        filled[c] = raw[prev] + ((raw[next] - raw[prev]) * (c - prev)) / (next - prev);
      }
    }
    const half = SMOOTH >> 1;
    const d = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const a: number[] = [];
      for (let k = -half; k <= half; k++) if (c + k >= 0 && c + k < cols) a.push(filled[c + k]);
      d[c] = median(a);
    }
    const curve: LineCurve = { step: COL_STEP, d };
    const yAt = (k: number, x: number) => ys[k] + d[colOf(Math.max(0, x))];
    // 左右端：沿曲线往外验墨
    const r = Math.ceil(thick / 2) + 1;
    /** x 处五条线里有几条有墨；`half` > 0 时每条线看左右 `half` 列的小窗（虚线） */
    const present = (half: number) => (x: number) => {
      let n = 0;
      for (let k = 0; k < 5; k++) {
        const yc = Math.round(yAt(k, x));
        let hit = false;
        for (let xx = Math.max(0, x - half); xx <= Math.min(bin.w - 1, x + half) && !hit; xx++)
          for (let y = Math.max(0, yc - r); y <= Math.min(bin.h - 1, yc + r); y++)
            if (bin.data[y * bin.w + xx]) {
              hit = true;
              break;
            }
        if (hit) n++;
      }
      return n >= EXTENT_LINES;
    };
    const strict = present(0);
    // **虚线**：扫描件的谱线断成一截一截、各条线的断口错开（新编 026 第四行），逐列看常常只有两三条线有墨，
    // 左端一路退到谱号后面（268，别的行 190 上下），按左端开窗的系统线判据罩进了下一行的谱号、两个系统并成一个。
    // 每条线看左右半格的小窗再走一遍（盖得住一格以内的断口），走完往里退过竖笔（系统线、方括号：开窗会把它的几列
    // 也算成「五条线都在」）与竖笔、谱线起点之间的空列；比逐列走得远出两格以上才用它，实线的端点一像素不动。
    // 走到竖笔就停试过：谱号的竖笔也挡（新编 f07 四行虚线谱，左端停在谱号右边，系统没分对）
    const dashed = present(Math.max(1, Math.round(space * 0.5)));
    const near = present(1);
    /** 竖笔（系统线、方括号）：四个间的中点有三个以上有墨 */
    const vertical = (x: number) => {
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const y = Math.round((yAt(k, x) + yAt(k + 1, x)) / 2);
        if (y >= 0 && y < bin.h && bin.data[y * bin.w + x]) n++;
      }
      return n >= 3;
    };
    // 点状虚线（新编 f07 第二系统高音行，谱号到第一个音之间点距过半格）：半格窗只见三条线，再放到一格窗走一遍，同样退过竖笔与空列
    const dotted = present(Math.max(1, Math.round(space)));
    const walkEnd = (from: number, dir: -1 | 1) => {
      const a = walk(from, dir, strict);
      const back = (b: number) => {
        while ((b - a) * dir > 0 && (vertical(b) || !near(b))) b -= dir;
        return b;
      };
      const b = back(walk(from, dir, dashed));
      if ((b - a) * dir > space * 2) return b;
      const c = back(walk(from, dir, dotted));
      return (c - a) * dir > space * 2 ? c : a;
    };
    const gapMax = Math.max(3, Math.round(space * 0.5));
    const runMin = Math.max(4, Math.round(space));
    const walk = (from: number, dir: -1 | 1, present: (x: number) => boolean): number => {
      let end = from;
      let gap = 0;
      let streak = 0;
      for (let x = from; x >= 0 && x < bin.w; x += dir) {
        if (present(x)) {
          gap = 0;
          if (++streak >= runMin) end = x;
        } else {
          streak = 0;
          if (++gap > gapMax) break;
        }
      }
      return end;
    };
    const left = walkEnd(st.x0, -1);
    const right = walkEnd(st.x1, 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = colOf(left); c <= colOf(right); c++) (lo = Math.min(lo, d[c])), (hi = Math.max(hi, d[c]));
    const flat = hi - lo <= FLAT_SPREAD && Math.abs((hi + lo) / 2) <= 1;
    const lines: StaffLineRun[] = ys.map((y) => ({ y, y0: y - thick / 2, y1: y + thick / 2, left, right, curve: flat ? undefined : curve }));
    groups.push({ lines, space: (ys[4] - ys[0]) / 4 });
  }
  if (!groups.length) return null;
  groups.sort((a, b) => a.lines[0].y - b.lines[0].y);
  // 线宽按推平时代的口径量（`bandThick`），量不出来才退回逐列游程的中位数。
  // 每条线的上下沿也按它自己的带厚取（`y1 − y0 + 1` = 带厚，同行投影）：谱线段的线宽由它来（`adapt.ts`），
  // 挂干窗口是两倍线宽（`findStems`），按逐列游程多算一像素，宁静 p5 钢琴贯穿小节线离头 6 像素被挂成了符干
  const bands: number[] = [];
  for (const g of groups)
    for (const l of g.lines) {
      const t = bandThick(bin, l);
      if (t === null) continue;
      bands.push(t);
      l.y0 = l.y - (t - 1) / 2;
      l.y1 = l.y + (t - 1) / 2;
    }
  bands.sort((a, b) => a - b);
  const lineThick = bands.length ? bands[bands.length >> 1] : Math.max(1, Math.round(median(thicks)));
  return { unit: { lineThick, space: median(groups.map((g) => g.space)), height: median(groups.map((g) => g.space)) * 4 }, groups };
}

/** 横带取墨量过页宽这个比例的行（同推平时代的行投影找线）。 */
const BAND_INK = 0.3;

/**
 * **线宽照推平时代的口径量**：沿这条线逐列按曲线取整对齐（等于整像素推平），再做行投影，墨量过页宽三成的那几行连成的带有多厚。
 * 逐列游程的中位数是真线厚，比这个小一档（新编 442 页里 295 页小 1~2 像素）：整像素推平留下 ±0.5 像素的残差，
 * 投影带总比单列厚一行。线宽是全流程的尺子——竖笔、横笔的「细」（两倍线宽）、加线剪列、去线都按它，
 * 那些阈值都是对着推平后的量法一首首调出来的；换成真线厚，5px 的小节线过不了「细」（新编 005、327 各丢一根），
 * 斜一像素的加线剪不掉（045 下加一线的 C4）。
 */
function bandThick(bin: Binary, l: StaffLineRun): number | null {
  const { w, h, data } = bin;
  const R = Math.max(6, Math.round(h * 0.01));
  const cnt = new Uint32Array(R * 2 + 1);
  for (let x = Math.max(0, l.left); x <= Math.min(w - 1, l.right); x++) {
    const y = Math.round(lineYAt(l, x));
    for (let o = -R; o <= R; o++) {
      const yy = y + o;
      if (yy >= 0 && yy < h && data[yy * w + x]) cnt[o + R]++;
    }
  }
  const th = w * BAND_INK;
  let peak = R;
  for (const o of [R - 1, R + 1]) if (cnt[o] > cnt[peak]) peak = o;
  if (cnt[peak] <= th) return null;
  let a = peak, b = peak;
  while (a > 0 && cnt[a - 1] > th) a--;
  while (b < R * 2 && cnt[b + 1] > th) b++;
  return b - a + 1;
}

/** 页面的基本单位（线宽与线距）：按游程找到的谱表反推（`findRasterStaves`）。一行谱都没有返回 null。 */
export function estimateUnit(bin: Binary): RasterUnit | null {
  return findRasterStaves(bin)?.unit ?? null;
}

/** 逐列找「五段黑、四段白等距」的地方。 */
export function columnHits(bin: Binary): ColHit[] {
  const { w, h, data } = bin;
  const maxSpace = maxSpaceOf(bin);
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
        // 线心按像素中心算（首行 + 末行）/ 2，与行投影同口径；「起点 + 长/2」整体偏下半像素，干净位图的音高、贴线判据跟着偏
        c.push(starts[i + k] + (lens[i + k] - 1) / 2);
        thick += lens[i + k];
      }
      const ds = [1, 2, 3, 4].map((k) => c[k] - c[k - 1]);
      const avg = (ds[0] + ds[1] + ds[2] + ds[3]) / 4;
      if (avg < MIN_SPACE || avg > maxSpace) continue;
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
function buildTracks(hits: ColHit[], space: number, width: number, minSpan: number, minHits = 8): Track[] {
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
  // 上还不到两格，会把整行轨迹切成碎片。纵向仍须在半格内，延长的只是同一行谱可以跨过的横向遮挡。
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
  return done.filter((t) => t.xs.length >= minHits && t.xs[t.xs.length - 1] - t.xs[0] >= width * minSpan);
}

/**
 * 断开的轨迹接回去：音符密的地方一连一百多像素凑不出「五黑四白」，超过 `buildTracks` 能跨的空档，一行谱断成几截。
 * 按 x 排，拿**两截里长的那截**按自己的走向（最小二乘直线）外推到另一截的端点，中心 y 差在 `TRACK_STEP` 格内、x 上不重叠的接成一条。
 * 比的是轨迹自己延伸过去的位置，不拿两截端点的 y 直接比——斜的页隔七八百像素就差出大半格（297 第二系统低音谱表）。
 */
function joinTracks(tracks: Track[], space: number): Track[] {
  const fit = (t: Track) => {
    const n = t.xs.length;
    const mx = t.xs.reduce((a, x) => a + x, 0) / n, my = t.ys.reduce((a, y) => a + y, 0) / n;
    let sxx = 0, sxy = 0;
    for (let k = 0; k < n; k++) (sxx += (t.xs[k] - mx) ** 2), (sxy += (t.xs[k] - mx) * (t.ys[k] - my));
    const b = sxx > 0 && t.xs[n - 1] - t.xs[0] >= space * 4 ? sxy / sxx : 0;
    return (x: number) => my + b * (x - mx);
  };
  const out: Track[] = [];
  for (const t of [...tracks].sort((a, b) => a.xs[0] - b.xs[0])) {
    let best: Track | null = null;
    let bd = space * TRACK_STEP;
    for (const o of out) {
      if (o.xs[o.xs.length - 1] >= t.xs[0]) continue;
      // 长的那截外推到短的那截靠近的那一端
      const d = o.xs.length >= t.xs.length ? Math.abs(fit(o)(t.xs[0]) - median(t.ys.slice(0, 5))) : Math.abs(fit(t)(o.xs[o.xs.length - 1]) - median(o.ys.slice(-5)));
      if (d < bd) (bd = d), (best = o);
    }
    if (best) {
      best.xs.push(...t.xs);
      best.ys.push(...t.ys);
      best.hits.push(...t.hits);
    } else out.push({ xs: [...t.xs], ys: [...t.ys], hits: [...t.hits] });
  }
  return out;
}

