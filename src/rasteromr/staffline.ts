// 谱线：量出**基本单位**（线宽与线距），再把五条一组的谱线找出来。
//
// 这是位图路的第一块判据，后面所有几何门槛都按这里量出来的线距写
// ——与矢量路同一个口径（`page.ts`：「一切长度都是小节线高度 H 的比例」）。
import type { Binary } from "../omrkit/types";

/** 页面的基本单位。musicpp `omr/pixel.cpp::findUnit` 量的就是这两个。 */
export interface RasterUnit {
  /** 谱线线宽（px）。 */
  lineThick: number;
  /** 一个线距（px，两条相邻谱线的中心距）。 */
  space: number;
  /** 谱表高度 = 小节线高度 H = 四个线距。矢量路的 `SPage.barlineHeight` 就是它。 */
  height: number;
}

/**
 * 量线宽与线距：**先找谱线，再从五条一组反推**。
 *
 * 试过先量单位再找线，不行：musicpp `pixel.cpp::findUnit` 的办法是取逐列黑白游程的
 * 众数，一页乐谱里最多的白色纵向游程「应该」是两条谱线之间那一段——
 * 这本书上不成立。符头内部、歌词笔画之间、和弦图格线的小空隙数量远超谱线间隙，
 * 白游程众数实测落在 3~5 px，而真线距是 17~19 px（差了四倍，后面所有门槛全废）。
 *
 * 反过来做就没这个问题：谱线是「一整行几乎全是墨」的横带，行投影一次就找齐
 * （实测宁静的伯利恒 p1 一次找出 50 条 = 10 行谱，分毫不差）；
 * 五条一组分出来之后，组内相邻线的间距就是线距，取全页中位数。
 * **线宽**取这些谱线横带的中位厚度——那是真谱线的厚度，不掺别的。
 */
export function estimateUnit(bin: Binary): RasterUnit | null {
  const lines = findStaffLines(bin);
  const groups = groupStaves(lines);
  if (!groups.length) return null;
  const spaces = groups.map((g) => g.space).sort((a, b) => a - b);
  const thicks = groups.flatMap((g) => g.lines.map((l) => l.y1 - l.y0 + 1)).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const lineThick = thicks[thicks.length >> 1];
  return { lineThick, space, height: space * 4 };
}

/** 一条谱线：中心 y、上下沿、左右端。 */
export interface StaffLineRun {
  y: number;
  /** 横带里墨量够峰值八成的那几行（上下沿）；`groupStaves` 拿它纠正被符杠拉偏的线，见 `findStaffLines`。 */
  peak?: [number, number];
  y0: number;
  y1: number;
  left: number;
  right: number;
}

/** 谱线候选的墨迹占比门槛：一行里至少这么多列有墨。比这更短的横线是符杠、加线、渐强线。 */
const LINE_INK_RATIO = 0.3;

/**
 * 找谱线：行投影取出「几乎整行都是墨」的横带，再逐条量它的左右端。
 *
 * **不依赖线距**——线距要靠它反推出来（见 `estimateUnit`）。所以两道门槛都写成
 * 页面尺寸的比例：厚度不超过页高的 1%（比这更厚的是黑边、粗横线、整块反白），
 * 左右端允许中断，连续空白不超过页宽的 5%。
 *
 * 左右端**必须允许中断**：谱线被小节线、符干、歌词框断开是常态，
 * 不允许的话一行谱会碎成十几截，后面「长度 ≥ 最长横线的 35%」那道闸全过不去。
 *
 * 这一版**不处理倾斜**（合唱谱这批底本实测倾斜 ≤1.23px，行投影一次就找齐）。
 * 真扫描件（倾斜 3~4px）要改成按纵向分带各投影一次再连起来，那时再说。
 */
export function findStaffLines(bin: Binary): StaffLineRun[] {
  const { w, h, data } = bin;
  const th = w * LINE_INK_RATIO;
  const maxThick = Math.max(6, h * 0.01);
  const maxGap = w * 0.05;
  const bands: [number, number][] = [];
  const rowInk = new Uint32Array(h);
  let start = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) n += data[row + x];
    rowInk[y] = n;
    if (n > th) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      bands.push([start, y - 1]);
      start = -1;
    }
  }
  if (start >= 0) bands.push([start, h - 1]);

  const out: StaffLineRun[] = [];
  for (const [b0, b1] of bands) {
    // **另记横带里墨量够峰值八成的那几行**（`peak`）：一行连桁的粗符杠紧贴着谱线时
    // （我一生要赞美你第二行，C4/A3 和弦的八分一路连到底），符杠那几行也过了 0.3 页宽，
    // 与谱线连成 10px 的一条带，中心被拉偏 3.5px；五条线不再等距，分组往下错一条，
    // 第一线下的通长加线顶了进来，整行谱低一格。取八成：第一行的符杠更密，那几行墨量有谱线的七成。
    // 只给 `groupStaves` 纠偏用：一律拿它当中心、或按它收上下沿都试过，普通谱线的中心也挪零点几个像素，
    // 音高吸附与去谱线后的歌词条跟着变（收上下沿时中文歌词 45 → 35%）。
    let peak = b0;
    for (let y = b0; y <= b1; y++) if (rowInk[y] > rowInk[peak]) peak = y;
    let p0 = peak, p1 = peak;
    while (p0 > b0 && rowInk[p0 - 1] >= rowInk[peak] * 0.8) p0--;
    while (p1 < b1 && rowInk[p1 + 1] >= rowInk[peak] * 0.8) p1++;
    if (b1 - b0 + 1 > maxThick) continue;
    const y0 = b0, y1 = b1;
    // 逐列有没有墨
    const ink = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let y = y0; y <= y1; y++) v |= data[y * w + x];
      ink[x] = v;
    }
    // 端点要**连续有墨**才算，不能见到一个墨点就算起点：
    // 系统的花括号、乐器名的笔画常常擦到谱线这一带，一擦谱行的左缘就跑到页边
    // （实测宁静 p1 十行谱里六行的左缘被拉到 x=2，`makeSystems` 判系统线、
    // `makeBars` 切小节全跟着偏）。要求连着 `runMin` 列有墨。
    const runMin = Math.max(4, Math.round(maxGap / 4));
    let left = -1;
    for (let x = 0; x + runMin <= w; x++) {
      let ok = true;
      for (let k = 0; k < runMin; k++)
        if (!ink[x + k]) {
          ok = false;
          x += k;
          break;
        }
      if (ok) {
        left = x;
        break;
      }
    }
    if (left < 0) continue;
    let right = left;
    let gap = 0;
    for (let x = left; x < w; x++) {
      if (ink[x]) {
        right = x;
        gap = 0;
      } else if (++gap > maxGap) break; // 断得太开：右边那截多半是另一件东西
    }
    out.push({ y: (y0 + y1) / 2, peak: [p0, p1], y0, y1, left, right });
  }
  return out;
}

/** 往左追谱线时，一列找不到墨最多容忍几列。 */
const TRACE_GAP = 3;

/**
 * **顺着谱线往左追**：横带定出来的左端，再沿线往左走，每列允许上下各漂一个像素。
 *
 * 去倾斜是整页一个斜率，弯的扫描页（齐来称颂伟大之神）左段谱线比主带低三个像素，
 * 落在横带外，左端就被量到谱号右边（实测 204，真谱线从 155 起）；
 * 谱行左端一偏，谱号落不进候选窗口，后面的升号被当成谱号，整页调号全错。
 * 只接**连着的**墨（断口不过 `TRACE_GAP` 列），乐器名之类隔开的东西接不进来；
 * **在识别阶段、谱线定稿之后才追**（`recognizeRasterPage`）：取图层量网点率也要找谱线，
 * 那时网点还没去，追线会一路追进网点里（实测坚固保障网点率 0.359 → 0，去网没做）。
 * 碰上竖笔（系统线、谱号的竖笔）那一列墨超出线厚，窗口不跟着动。
 */
export function traceLeft(bin: Binary, left: number, y0: number, y1: number): number {
  const { w, h, data } = bin;
  // 补线合成的谱线（`completeStaffLines`）上下沿是小数
  let lo = Math.floor(y0);
  let hi = Math.ceil(y1);
  const thick = hi - lo + 1;
  let gap = 0;
  let best = left;
  for (let x = left - 1; x >= 0; x--) {
    let a = -1;
    let b = -1;
    for (let y = Math.max(0, lo - 1); y <= Math.min(h - 1, hi + 1); y++)
      if (data[y * w + x]) {
        if (a < 0) a = y;
        b = y;
      }
    if (a < 0) {
      if (++gap > TRACE_GAP) break;
      continue;
    }
    gap = 0;
    best = x;
    // 窗口只跟着线厚那么宽的墨走；整窗都是墨的是竖笔，不挪
    if (b - a + 1 <= thick + 1) (lo = a), (hi = b);
  }
  return best;
}

/** 同一行谱五条线的左缘允许差多少（线距的倍数）。 */
const LEFT_SPREAD = 3;

/** 五条线的平均线距与四个间距里最大的相对偏差。 */
function spacing(five: StaffLineRun[]): { avg: number; dev: number } {
  const ds = [1, 2, 3, 4].map((k) => five[k].y - five[k - 1].y);
  const avg = ds.reduce((a, b) => a + b, 0) / 4;
  return { avg, dev: avg > 0 ? Math.max(...ds.map((d) => Math.abs(d - avg))) / avg : Infinity };
}

/** 一行谱：五条线加它们定出来的线距。 */
export interface StaffGroup {
  lines: StaffLineRun[];
  /** 组内相邻线的平均间距。 */
  space: number;
}

/**
 * 五条一组。判据两道：
 *   - 组内四个间距彼此相差不超过两成（等距）；
 *   - 五条线的 x 区间交集不短于最短那条的八成（同一行谱的五条线跨度几乎相同）。
 *
 * 第二道不能省：一页上下两行谱的 y 序列首尾相接，光靠等距会把上一行的末两条
 * 与下一行的头三条凑成一「行」。
 */
export function groupStaves(lines: StaffLineRun[]): StaffGroup[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const out: StaffGroup[] = [];
  for (let i = 0; i + 4 < sorted.length; ) {
    const five = sorted.slice(i, i + 5);
    // 按峰值那几行**明显更等距**（最大偏差少五个百分点以上）就用它：粗符杠贴着谱线把横带中心拉偏
    // （见 `findStaffLines`）。偏得少的那种（我一生要赞美你第一行，间距 12/15/14/17）照两成的闸
    // 也算等距，只在不等距时才重试的话它漏过去，那一行音高全低。普通谱线两个中心差不到半像素，不换。
    const sRaw = spacing(five);
    const sPk = spacing(five.map((l) => ({ ...l, y: l.peak ? (l.peak[0] + l.peak[1]) / 2 : l.y })));
    // 原组偏得太厉害（>0.3）的不换：那是一整条线被压住（宁静 p5 第五线盖在三层十六分符杠下），
    // 这里凑不成组，留给 `completeStaffLines` 按四条等距外推，换了反而小节自检掉 1.2 点。
    const usePeak = sRaw.dev <= 0.3 && sPk.dev < sRaw.dev - 0.05;
    const { avg, dev } = usePeak ? sPk : sRaw;
    const left = Math.max(...five.map((l) => l.left));
    const right = Math.min(...five.map((l) => l.right));
    const shortest = Math.min(...five.map((l) => l.right - l.left));
    // **五条线的左缘要一致**。密集的八度跑动会共用一条**通长的加线**（实测宁静 p5
    // 那条 y=1004、x[244,1906]，比谱线只短一截），等距与 x 交集两道闸都拦不住它
    // ——它顶掉了真正的第五线，整行谱因此上移一条线，**那一行的音高整段低两级**
    //（GT `C5 C6 C5 C6…` 被读成 `A4 A5 A4 A5…`）。
    // 真谱线从系统线起画，一个系统里五条的左缘几乎相同；加线从音符处才起。
    const spread = Math.max(...five.map((l) => l.left)) - Math.min(...five.map((l) => l.left));
    // 五条里不能有**零头**（不到最长那条的四分之一）：x 交集那道闸拿「最短那条的八成」当尺子，最短的只有三十像素时
    // 交集二十几像素也算过——新编赞美诗 381 一行谱的第五线被一截 31px 的碎线顶替，后面按线长滤谱线时整行谱丢了
    const longest = Math.max(...five.map((l) => l.right - l.left));
    if (dev <= 0.2 && right - left >= shortest * 0.8 && shortest >= longest * 0.25 && spread <= avg * LEFT_SPREAD) {
      // 中心写回**原对象**：`completeStaffLines` 按对象认「已分组」，换成副本的话原来那几条
      // 被当成散线，又外推出一行错一条线的重复谱行
      if (usePeak)
        for (const l of five)
          if (l.peak) (l.y = (l.peak[0] + l.peak[1]) / 2), (l.y0 = l.peak[0]), (l.y1 = l.peak[1]);
      out.push({ lines: five, space: avg });
      i += 5;
    } else i++;
  }
  return out;
}

/**
 * **随 x 变化的五线位置**：整行谱一个 y 只是投影峰，页面轻微倾斜、弯曲、线距不匀时，
 * 局部实测的线与它差出 3~6 像素（44 首独唱谱 p99；线距 15~20 像素时，半格只有 7~10 像素，
 * 读音高四舍五入的分界离中心 3.5~5 像素）。
 *
 * 按一格宽的桶逐列量：每条线在名义 y 上下 0.35 格里找墨的竖游程，厚度不超过 2.5 个线宽
 *（压着符头、符干的列厚得多，不算），取桶内中位；五条线的偏移再取中位当这一桶的整体平移。
 * 量不到的桶从两侧插值、一侧都没有就取最近的。返回 `x → 五条线的 y`（桶中心之间线性插值）。
 */
export function localLineModel(bin: Binary, lineYs: number[], left: number, right: number, unit: RasterUnit): (x: number) => number[] {
  const sp = unit.space;
  const bw = Math.max(4, Math.round(sp));
  const x0 = Math.max(0, Math.round(left));
  const x1 = Math.min(bin.w - 1, Math.round(right));
  const nb = Math.max(1, Math.ceil((x1 - x0 + 1) / bw));
  const maxRun = unit.lineThick * 2.5;
  const reach = sp * 0.35;
  /** 每条线、每个桶的实测中心（量不到为 NaN）。 */
  const meas = lineYs.map((ly) => {
    const out = new Float64Array(nb).fill(NaN);
    for (let b = 0; b < nb; b++) {
      const cs: number[] = [];
      for (let x = x0 + b * bw; x < Math.min(x1 + 1, x0 + (b + 1) * bw); x++) {
        let best = NaN;
        for (let y = Math.max(0, Math.round(ly - reach)); y <= Math.min(bin.h - 2, Math.round(ly + reach)); y++) {
          if (!bin.data[y * bin.w + x]) continue;
          let e = y;
          while (e + 1 < bin.h && bin.data[(e + 1) * bin.w + x]) e++;
          // 游程从窗口上沿之外连进来的，起点往上补齐再量厚度
          let s = y;
          while (s > 0 && bin.data[(s - 1) * bin.w + x]) s--;
          if (e - s + 1 <= maxRun) {
            const c = (s + e) / 2;
            if (isNaN(best) || Math.abs(c - ly) < Math.abs(best - ly)) best = c;
          }
          y = e;
        }
        if (!isNaN(best)) cs.push(best);
      }
      if (cs.length >= Math.max(2, bw / 4)) {
        cs.sort((a, b2) => a - b2);
        out[b] = cs[cs.length >> 1];
      }
    }
    return out;
  });
  // 每桶取**五条线偏移的中位数**当整体平移：骑线的空心头、贴线的符杠只带偏其中一条（奇异恩典中线被头的细圈带偏 2.6 像素）
  const shift = new Float64Array(nb).fill(NaN);
  for (let b = 0; b < nb; b++) {
    const ds = meas.map((m, k) => m[b] - lineYs[k]).filter((d) => !isNaN(d)).sort((a, c) => a - c);
    if (ds.length >= 3) shift[b] = ds[ds.length >> 1];
  }
  const idx = [...shift.keys()].filter((i) => !isNaN(shift[i]));
  if (!idx.length) return () => lineYs;
  for (let i = 0; i < nb; i++) {
    if (!isNaN(shift[i])) continue;
    const lo = idx.filter((j) => j < i).pop();
    const hi = idx.find((j) => j > i);
    shift[i] = lo === undefined ? shift[hi!] : hi === undefined ? shift[lo] : shift[lo] + ((shift[hi] - shift[lo]) * (i - lo)) / (hi - lo);
  }
  // 相邻三桶取中位，压掉单桶的跳变
  const sm = shift.map((_, i) => [shift[Math.max(0, i - 1)], shift[i], shift[Math.min(nb - 1, i + 1)]].sort((a, c) => a - c)[1]);
  return (x: number) => {
    const t = (x - x0) / bw - 0.5;
    const i = Math.max(0, Math.min(nb - 1, Math.floor(t)));
    const j = Math.min(nb - 1, i + 1);
    const f = Math.max(0, Math.min(1, t - i));
    const d = sm[i] + (sm[j] - sm[i]) * f;
    return lineYs.map((y) => y + d);
  };
}

/** 按**相邻两条线的相对位置**把 y 换成音级位置：第一线为 0、往下每半格 +1；线外按最近的线距外推。 */
export function pitchPos(ys: number[], y: number): number {
  if (y <= ys[0]) return ((y - ys[0]) / (ys[1] - ys[0])) * 2;
  if (y >= ys[4]) return 8 + ((y - ys[4]) / (ys[4] - ys[3])) * 2;
  let k = 0;
  while (k < 3 && y > ys[k + 1]) k++;
  return k * 2 + ((y - ys[k]) / (ys[k + 1] - ys[k])) * 2;
}

/** `pitchPos` 的反函数：音级位置 → y。 */
export function pitchY(ys: number[], p: number): number {
  if (p <= 0) return ys[0] + (p / 2) * (ys[1] - ys[0]);
  if (p >= 8) return ys[4] + ((p - 8) / 2) * (ys[4] - ys[3]);
  const k = Math.min(3, Math.floor(p / 2));
  return ys[k] + (p / 2 - k) * (ys[k + 1] - ys[k]);
}
