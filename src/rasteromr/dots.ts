// 位图五线谱的**附点与反复点**：符头右边（或下移半格）的实心小点，判据全在 `findDots` 的注释里。
import type { Binary } from "../omrkit/types";
import type { Rect } from "../omrkit/types";
import { type RasterSym } from "./adapt";
import { type RasterUnit } from "./staffline";
import { overlapFrac } from "../omrkit/geom";

/**
 * 符头右边的附点（见识别主流程「附点」那一段）。窗口：符头右缘往右 0.05~1.3 格、
 * 符头中心往上 0.85 格到往下 0.5 格（`DOT_BELOW`）。墨团要整个落在窗口里（孤立），
 * 大小 0.15~0.6 格、宽高比 0.6~1.7、填充过半；已经有符号压着的不算；
 * 同一列上下一格处还有一个这样的点，那是反复记号的两点，不算。
 */
/** 附点窗口往下探多少格：线上的音附点写在上方的间，可和弦里上方那个间被别的音的点占了时写在下方（《恩友歌》G4）。
 *  0.35 → 0.5：线上的音点写在下方的间，点心在头心下 0.4 格（齐来崇拜 m13 A3、敬拜万世之王 m18 D5）。 */
const DOT_BELOW = 0.5;

/** 附点心离间心的容差（格）：本语料附点 95% 以上在 0.15 格内，落在线上的是头旁谱线残渣。 */
const DOT_SPACE_TOL = 0.3;

/** 头位置取整到半格时的容差（格），见 `findDots`。 */
const DOT_HEAD_TOL = 0.3;

/** 头心下超过这么多格的点要整个落在间里（见 `findDots`）。 */
const DOT_BELOW_SOLID = 0.35;

/** 判「同列另一个点有自己的主人」时，主人可以是左右半格内的邻列头：二度错排的和弦两列头挨着、盒不重叠
 *  （恩友歌 C5/A4/G4 附点四分，右列 A4 的点因左列两个头差一个像素不算「同列」，被当成反复双点剔掉）。 */
const TWIN_COL = 0.5;

/** 和弦里上方紧挨着另一个头的，附点窗口下沿放到这么多格（恩友歌 C5/A4/G4 附点四分，G4 的点写在下方的间，头心下 0.55 格）。 */
const DOT_BELOW_STACKED = 0.75;

/** 和弦里挤着二度、最下面那个头的点往下挪一个间：头心下一格，再放一点余量。 */
const DOT_BELOW_PUSHED = 1.2;

/** 附点四周这么多格（至少 2 像素）以内的墨若连着符干，就是符尾被切断的尖（见 `findDots` 里的 `isolated`）。 */
const DOT_ISOLATE = 0.12;

/** 本页附点的中位尺寸（长边）：比它的这么多倍还小的不是附点（父恩广大 m2 头圈边上的毛刺 3px、本页附点 6~7px；
 *  我灵镇静 m25 连音线尖 5×3、本页 9×9）。本页凑不够 `DOT_MEDIAN_N` 个点就不比。 */
const DOT_SMALL = 0.62;

const DOT_MEDIAN_N = 4;

/** 附点取块时窗口上下多放的余量（格），见 `findDots`。 */
const DOT_PAD = 0.3;

/** 附点的长宽上限（格）。0.6 → 0.75：倚靠主永远膀臂的附点 10×11、线距 17.6（0.62 格），我灵镇静的圈状点 8×11（0.63 格）。 */
const DOT_MAX = 0.75;

/** 反复记号两点的判定（`findDots::repeatPair`）：点心离第二/三间间心、两点横向差、点到反复小节线的距离、
 *  粗线最窄、粗细两线的间隔（格），与竖线贯穿谱表要占的墨比例（扫描件小节线有断口）。 */
const REPEAT_Y = 0.25;

/** 附点四周要干净的范围（格），见 `findDots`。 */
const DOT_CLEAR = 0.6;

const REPEAT_X = 0.3;

const REPEAT_GAP = 1.0;

const REPEAT_THICK = 0.3;

const REPEAT_PAIR = 1.0;

const REPEAT_INK = 0.9;

/** `onLine`：这一行像素在谱线上（去线后残渣所在）。连通照走，但不计入点的盒、也不算伸出窗口
 *  ——贴着谱线的附点在去线图上常连着一截残渣，盒高超限或伸出窗口就整个丢了（我灵镇静 m3 的附点四分）。
 *  `only`：只给这几个头找（后补的头），其余头照样用来定窗口。 */
export function findDots(bin: Binary, syms: RasterSym[], unit: RasterUnit, staffYs: number[][], onLine: (y: number) => boolean = () => false, only?: RasterSym[]): Rect[] {
  const sp = unit.space;
  const out: Rect[] = [];
  const heads = syms.filter((s0) => /^notehead/.test(s0.code));
  const blobsIn = (x0: number, y0: number, x1: number, y1: number): Rect[] => {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(bin.w, Math.round(x1));
    y1 = Math.min(bin.h, Math.round(y1));
    const W = x1 - x0;
    if (W <= 0 || y1 <= y0) return [];
    const seen = new Uint8Array(W * (y1 - y0));
    const found: Rect[] = [];
    const stack: number[] = [];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (seen[(y - y0) * W + (x - x0)] || !bin.data[y * bin.w + x]) continue;
        // 两套盒：`a` 全部像素、`b` 不算谱线行的像素（见 `onLine`）。先按 `a` 判，不过再按 `b`
        const a = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, area: 0, edge: false };
        const b = { ...a };
        const grow = (q: typeof a, px: number, py: number) => {
          q.area++;
          q.minX = Math.min(q.minX, px);
          q.maxX = Math.max(q.maxX, px);
          q.minY = Math.min(q.minY, py);
          q.maxY = Math.max(q.maxY, py);
        };
        seen[(y - y0) * W + (x - x0)] = 1;
        stack.push(x, y);
        while (stack.length) {
          const py = stack.pop()!;
          const px = stack.pop()!;
          grow(a, px, py);
          if (!onLine(py)) grow(b, px, py);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx;
              const ny = py + dy;
              if (nx < 0 || ny < 0 || nx >= bin.w || ny >= bin.h || !bin.data[ny * bin.w + nx]) continue;
              if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) {
                a.edge = true;
                if (!onLine(ny)) b.edge = true;
                continue;
              }
              const j = (ny - y0) * W + (nx - x0);
              if (seen[j]) continue;
              seen[j] = 1;
              stack.push(nx, ny);
            }
        }
        // 去线那一套要够大（0.3 格）：符尾尖、干根贴着谱线的碎渣去掉线行只剩三四个像素，像个小点
        const dotOk = (q: typeof a, min: number) => {
          if (!q.area || q.edge) return false;
          const w = q.maxX - q.minX + 1;
          const h = q.maxY - q.minY + 1;
          if (w < Math.max(2, sp * min) || h < Math.max(2, sp * min) || w > sp * DOT_MAX || h > sp * DOT_MAX) return false;
          return w / h >= 0.6 && w / h <= 1.7 && q.area >= w * h * 0.5;
        };
        const q = dotOk(a, 0.15) ? a : dotOk(b, 0.3) ? b : null;
        if (!q) continue;
        const w = q.maxX - q.minX + 1;
        const h = q.maxY - q.minY + 1;
        found.push({ x: q.minX, y: q.minY, w, h });
      }
    return found;
  };
  /** 附点窗口的左缘：和弦里**贴着的最右那个头**的右缘。二度和弦错开画在干另一侧的头把附点列往右推了一个头宽，
   *  按自己的右缘开窗够不着（《恩友歌》C5/A4/G4 附点四分，上下两个点又被当成反复记号的双点剔掉，23 处读成四分）。 */
  const rightOf = (b: Rect) => {
    const cy = b.y + b.h / 2;
    let r = b.x + b.w;
    for (const h2 of heads) {
      const c = h2.box;
      if (c.x <= b.x + b.w + 2 && c.x + c.w >= b.x && Math.abs(c.y + c.h / 2 - cy) <= sp * 1.5) r = Math.max(r, c.x + c.w);
    }
    return r;
  };
  /** 同一列（左右 `TWIN_COL` 格内）上下 `dy0`~`dy1` 格（往上为正）内另有一个头。 */
  const colHead = (b: Rect, dy0: number, dy1: number) => {
    const cy = b.y + b.h / 2;
    return heads.some((h2) => h2.box !== b && h2.box.x < b.x + b.w + sp * TWIN_COL && h2.box.x + h2.box.w > b.x - sp * TWIN_COL && cy - (h2.box.y + h2.box.h / 2) > sp * dy0 && cy - (h2.box.y + h2.box.h / 2) < sp * dy1);
  };
  /**
   * 窗口下沿，按附点的排版规则反推：间上的音点在本间，线上的音点在上方的间；和弦里上方的间被别的音的点占了、
   * 或下声部（和弦里别的头在上方）的线上音，点写到**下方的间**（头心下半格，天父世界歌伴奏 m11 G4、恩友歌 G4）。
   * 和弦里挤着二度的，点按头的次序一个间一个间往下排，最下面那个头的点可以再往下挪一个间（恩友歌伴奏 m17
   * C5/A4/G4/F4，F4 的点在下加一间，头心下一格）。
   */
  const below = (b: Rect) => {
    const cy = b.y + b.h / 2;
    const above = colHead(b, 0.3, 3.2);
    if (above && colHead(b, -0.1, 0.7) && !colHead(b, -3.2, -0.3)) return DOT_BELOW_PUSHED;
    if (colHead(b, 0.3, 1.2) || ((above || stemDown(b)) && onLine(Math.round(cy)))) return DOT_BELOW_STACKED;
    return DOT_BELOW;
  };
  /** 干从头的左缘往下伸（下声部）：左缘一像素内有一段 1.5 格以上的竖墨，谱线行算连着。
   *  下声部线上的音附点写在**下方的间**（Holy, Holy, Holy m11 男低 G2 附点四分，点心在头心下 0.5 格）。 */
  const stemDown = (b: Rect) => {
    for (let x = Math.max(0, b.x - 1); x <= Math.min(bin.w - 1, b.x + 1); x++) {
      let run = 0;
      for (let y = Math.round(b.y + b.h / 2); y < bin.h && (bin.data[y * bin.w + x] || onLine(y)); y++) run++;
      if (run >= sp * 1.5 + b.h / 2) return true;
    }
    return false;
  };
  /** 点落在这个头的附点窗口里吗。 */
  const inWindow = (b: Rect, d: Rect) => {
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const hy = b.y + b.h / 2;
    const r = rightOf(b);
    return cx > r + sp * 0.05 && cx < r + sp * 1.3 && cy > hy - sp * 0.85 && cy < hy + sp * below(b);
  };
  /**
   * 点的盒外一圈（`DOT_ISOLATE` 格宽、至少 2 像素）里的墨连着一根**符干**（一格半内有一段 1.5 格以上的竖墨）：
   * 是符尾的尖——符尾弯下来的末端被切断，剩一个圆点贴着笔画的断口（善牧恩慈歌 m9、万福泉源歌 m18）。
   * 只贴着连音线、加线的真附点不算（晨曦破晓 m8、m9 的附点二分）。谱线那几行不算。
   */
  const isolated = (d: Rect): boolean => {
    const g = Math.max(2, Math.round(sp * DOT_ISOLATE));
    const R = Math.round(sp * 1.5);
    const x0 = Math.max(0, d.x - R), x1 = Math.min(bin.w, d.x + d.w + R);
    const y0 = Math.max(0, d.y - R * 2), y1 = Math.min(bin.h, d.y + d.h + R * 2);
    const W = x1 - x0;
    const seen = new Uint8Array(W * (y1 - y0));
    const stack: number[] = [];
    // 谱线、加线（横向连着一格以上的墨）不算、也不从它灌过去：谱线局部位置与 `onLine` 差一两行时，
    // 从线上灌进挨着的符干会把真附点判成符尾尖（倚靠主永远膀臂 m7 贴线的附点八分）
    const hRun = (x: number, y: number) => {
      let a = x;
      let c = x;
      while (a > 0 && bin.data[y * bin.w + a - 1]) a--;
      while (c < bin.w - 1 && bin.data[y * bin.w + c + 1]) c++;
      return c - a + 1;
    };
    const inDot = (x: number, y: number) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h;
    for (let y = d.y - g; y < d.y + d.h + g; y++) {
      if (y < y0 || y >= y1 || onLine(y)) continue;
      for (let x = d.x - g; x < d.x + d.w + g; x++) {
        if (x < x0 || x >= x1 || inDot(x, y) || !bin.data[y * bin.w + x] || seen[(y - y0) * W + x - x0] || hRun(x, y) >= sp) continue;
        seen[(y - y0) * W + x - x0] = 1;
        stack.push(x, y);
      }
    }
    if (!stack.length) return true;
    // 从圈里的墨往外灌（不进点本身），记下每列灌到的最长竖段。去线图上笔画过谱线处常断开几行，
    // 竖着碰到谱线行就跳过去接着灌（符尾从干上下来要穿过一两条谱线）
    const colRun = new Map<number, [number, number]>();
    while (stack.length) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      const c = colRun.get(x);
      colRun.set(x, c ? [Math.min(c[0], y), Math.max(c[1], y)] : [y, y]);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          let ny = y + dy;
          if (dy !== 0 && ny >= y0 && ny < y1 && onLine(ny)) {
            let k = 0;
            while (k < 8 && ny >= y0 && ny < y1 && onLine(ny)) {
              ny += dy;
              k++;
            }
          }
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1 || inDot(nx, ny) || !bin.data[ny * bin.w + nx]) continue;
          const k = (ny - y0) * W + nx - x0;
          if (seen[k] || hRun(nx, ny) >= sp) continue;
          seen[k] = 1;
          stack.push(nx, ny);
        }
    }
    // 竖段要真连着：那一列从上到下逐行都是墨
    for (const [x, [a, c]] of colRun) {
      if (c - a + 1 < sp * 1.5) continue;
      let run = 0;
      let most = 0;
      for (let y = a; y <= c; y++) {
        run = bin.data[y * bin.w + x] || onLine(y) ? run + 1 : 0;
        most = Math.max(most, run);
      }
      if (most >= sp * 1.5) return false;
    }
    return true;
  };
  /** 盒里不在谱线行上的墨的纵向重心（没有就取盒中心）。 */
  const inkMidY = (o: Rect) => {
    let n = 0;
    let sy = 0;
    for (let y = o.y; y < o.y + o.h; y++) {
      if (onLine(y)) continue;
      for (let x = o.x; x < o.x + o.w; x++) if (bin.data[y * bin.w + x]) {
        n++;
        sy += y;
      }
    }
    return n ? sy / n + 0.5 : o.y + o.h / 2;
  };
  /** 盒里有不在谱线行上的墨。 */
  const offLine = (o: Rect) => {
    for (let y = o.y; y < o.y + o.h; y++) {
      if (onLine(y)) continue;
      for (let x = o.x; x < o.x + o.w; x++) if (bin.data[y * bin.w + x]) return true;
    }
    return false;
  };
  /**
   * `d`、`o` 两点是反复记号的两点：同一谱表里一个在第二间、一个在第三间（点心离间心不过 `REPEAT_Y` 格）、
   * 左右对齐（`REPEAT_X` 格内），两点左边或右边 `REPEAT_GAP` 格内有反复小节线——
   * 一粗（≥ `REPEAT_THICK` 格）一细两根、都从第一线贯穿到第五线（谱线行算墨、容 `REPEAT_INK` 的断口），相隔不过 `REPEAT_PAIR` 格。
   */
  const repeatPair = (d: Rect, o: Rect): boolean => {
    const ax = d.x + d.w / 2, ay = d.y + d.h / 2;
    const bx = o.x + o.w / 2, by = o.y + o.h / 2;
    if (Math.abs(ax - bx) > sp * REPEAT_X) return false;
    const ys = staffYs.find((l) => l.length === 5 && ay > l[0] && ay < l[4]);
    if (!ys) return false;
    const up = Math.min(ay, by), dn = Math.max(ay, by);
    if (Math.abs(up - (ys[1] + ys[2]) / 2) > sp * REPEAT_Y || Math.abs(dn - (ys[2] + ys[3]) / 2) > sp * REPEAT_Y) return false;
    // 贯穿谱表的竖墨列，并成一根根竖线
    const full = (x: number) => {
      let ink = 0;
      for (let y = Math.round(ys[0]); y <= Math.round(ys[4]); y++) if (bin.data[y * bin.w + x] || onLine(y)) ink++;
      return ink >= (Math.round(ys[4]) - Math.round(ys[0]) + 1) * REPEAT_INK;
    };
    const left = Math.min(d.x, o.x), right = Math.max(d.x + d.w, o.x + o.w);
    const x0 = Math.max(0, Math.round(left - sp * (REPEAT_GAP + REPEAT_PAIR + 1)));
    const x1 = Math.min(bin.w - 1, Math.round(right + sp * (REPEAT_GAP + REPEAT_PAIR + 1)));
    const bars: [number, number][] = [];
    for (let x = x0; x <= x1; x++) {
      if (x >= left && x < right) continue;
      if (!full(x)) continue;
      const last = bars[bars.length - 1];
      if (last && last[1] === x - 1) last[1] = x;
      else bars.push([x, x]);
    }
    const thick = (q: [number, number]) => q[1] - q[0] + 1 >= Math.max(2, sp * REPEAT_THICK);
    // 挨着点的那一根是细线，它另一侧紧挨着一根粗线
    for (const side of [-1, 1]) {
      const near = side < 0 ? bars.filter((q) => q[1] < left).pop() : bars.find((q) => q[0] >= right);
      if (!near) continue;
      const gap = side < 0 ? left - near[1] : near[0] - right;
      if (gap > sp * REPEAT_GAP || thick(near)) continue;
      const i = bars.indexOf(near);
      const other = bars[i + side];
      if (!other || !thick(other)) continue;
      const between = side < 0 ? near[0] - other[1] : other[0] - near[1];
      if (between <= sp * REPEAT_PAIR) return true;
    }
    return false;
  };
  for (const hd of only ?? heads) {
    const b = hd.box;
    const cy = b.y + b.h / 2;
    const r = rightOf(b);
    // 取块的窗口上下各多放 0.3 格，再只留中心落在原窗口里的：窗口沿正切在点的边上时，
    // 一两个毛刺像素伸出窗口就整块作废（齐来称颂低音谱表 C♯4/A3 附点二分，两个点都这么丢了）
    const bl = below(b);
    // 右边也放：点心在 1.3 格内、右缘伸出窗口的也要（敬拜万世之王 m18，8 像素宽的点被右沿切掉两列作废；只限谱表里，见下）
    // 左边也放：头盒偏宽（带进了圈外的毛边）时右缘罩住点的左边一两列，点伸出窗口就作废（齐来称颂 m18/m19 附点二分）
    // 靠这一放才收进来的（左缘在原窗口左边）要够大（两边都 0.3 格）：谱线在头右边的残渣原来被窗口切掉（我灵镇静 m21 多出一个点）
    // 上沿在谱线网格验得了间位的地方多放 `DOT_HEAD_TOL`：头盒带进加线下面一截时中心偏下，线上音写在上方间里的点
    // 就出了窗口（齐来谢主歌 m13 低音谱表上加一线 C4 附点二分，差 0.4 像素）。放进来的仍要过下面按谱线定高差那一道
    const gridAt = (qy: number) => staffYs.find((ys) => ys.length === 5 && qy > ys[0] - sp * 1.5 && qy < ys[4] + sp * 1.5);
    const upTol = gridAt(cy) ? DOT_HEAD_TOL : 0;
    for (const d of blobsIn(r - sp * DOT_PAD, cy - sp * (0.85 + upTol + DOT_PAD), r + sp * (1.3 + DOT_PAD), cy + sp * (bl + DOT_PAD)).filter((q) => {
      const qx = q.x + q.w / 2;
      const qy = q.y + q.h / 2;
      if (q.x < r + sp * 0.05 && (q.w < sp * 0.3 || q.h < sp * 0.3)) return false;
      if (!(qx > r + sp * 0.05 && qx < r + sp * 1.3 && qy > cy - sp * (0.85 + (gridAt(qy) ? upTol : 0)) && qy < cy + sp * bl)) return false;
      const inStaff = staffYs.some((l) => qy > l[0] - sp && qy < l[l.length - 1] + sp);
      // **按谱线定高差**：附点写在间里，点心离间心不过 `DOT_SPACE_TOL` 格；点所在的间与头的位置（按谱线取整到半格）
      // 只差几档——间上的音同一个间（0）、线上的音上下相邻的间（±半格）、和弦挤着二度的往下挪一个间（+1）。
      // 头盒中心不准（带进一截干、只罩住半个头），拿它直接量高差会错剔二十多个真附点，所以头位置取 ±`DOT_HEAD_TOL` 格内的半格。
      // 点心取不在谱线行上的墨的重心：贴线的点盒子带进线行，中心被拉偏（我灵镇静 m10、父恩广大 m6）。
      // 五线以外没有线，加线音的点常与头齐平（齐来崇拜 m8、m22 的 C4），那里不要求落在间里。谱表外一格半以外的不管
      const l = staffYs.find((ys) => ys.length === 5 && qy > ys[0] - sp * 1.5 && qy < ys[4] + sp * 1.5);
      if (l) {
        const g = (l[4] - l[0]) / 4;
        const pos = (inkMidY(q) - l[0]) / g;
        const inside = pos > -DOT_SPACE_TOL && pos < 4 + DOT_SPACE_TOL;
        const spaceOff = Math.abs(pos - Math.floor(pos) - 0.5);
        if (inside && spaceOff > DOT_SPACE_TOL) return false;
        const dotAt = inside ? Math.floor(pos) + 0.5 : Math.round(pos * 2) / 2;
        const hp = (cy - l[0]) / g;
        // 五线以外（加线上下）的头盒更不准：带进加线外那一截，中心偏出近半格（齐来谢主歌 m13 低音谱表上加一线 C4），两个半格都算
        const off = hp < -DOT_HEAD_TOL || hp > 4 + DOT_HEAD_TOL;
        const heads = [Math.floor(hp * 2) / 2, Math.ceil(hp * 2) / 2].filter((h) => off || Math.abs(h - hp) <= DOT_HEAD_TOL);
        const ks = [0, -0.5, 0.5, ...(bl === DOT_BELOW_PUSHED ? [1] : [])];
        if (!heads.some((h) => ks.includes(dotAt - h))) return false;
      }
      // 伸出原窗口右沿的只在谱表里收：谱表外歌词行里字的一笔挨着被当成头的另一笔（破碎 p1/p2）
      if (q.x + q.w > r + sp * 1.3 && !inStaff) return false;
      // 头心下 `DOT_BELOW_SOLID` 格往下那一段只收谱表里、整个落在间里碰不到谱线行的点：
      // 扫描件谱线下沿的鼓包、残渣正好在那儿（破碎 p6/p7 三处），谱表外歌词字的一笔也常落在这儿（望十架）
      if (bl === DOT_BELOW && qy > cy + sp * DOT_BELOW_SOLID) {
        if (!inStaff) return false;
        for (let y = q.y - 1; y <= q.y + q.h; y++) if (onLine(y)) return false;
      }
      return true;
    })) {
      if (out.some((o) => overlapFrac(o, d) > 0)) continue;
      if (syms.some((s0) => overlapFrac(d, s0.box) > 0.3)) continue;
      // 反复记号的两点：同一列上下一格处还有一个点。
      // 但**和弦的附点**也是这样上下一格排着：另一个点若落在同列**另一个头**的附点窗口里，
      // 它就有自己的主人、不是反复记号（齐来称颂 m4/m17~m19、赞美三一真神 m5/m8 的附点二分和弦
      // 以前全被这条毙掉，读成二分或全音符）
      const dcx = d.x + d.w / 2;
      const dcy = d.y + d.h / 2;
      // **反复记号的判定要严**：两点正落在中线上下两个间（第二、三间）、左右对齐，旁边有一粗一细的反复小节线、
      // 点离小节线不过 `REPEAT_GAP` 格，三条都满足才不当附点（`repeatPair`）。原先只要同列上下一格还有个点就算，
      // 「8」字叠头各带一个点（以马内利来临歌 m4 只认出上面那个头）、点正上/正下方谱线行残下的一小截
      //（主使我喜乐 m7、倚靠主永远膀臂 m7）都被当成反复记号剔掉
      const twins = blobsIn(dcx - sp * 0.5, dcy - sp * 1.5, dcx + sp * 0.5, dcy + sp * 1.5)
        .filter((o) => Math.abs(o.y + o.h / 2 - dcy) > sp * 0.6 && offLine(o))
        .filter((o) => !heads.some((h2) => h2 !== hd && h2.box.x < b.x + b.w + sp * TWIN_COL && h2.box.x + h2.box.w > b.x - sp * TWIN_COL && inWindow(h2.box, o)))
        .filter((o) => repeatPair(d, o));
      if (twins.length) continue;
      // 四周 `DOT_CLEAR` 格内另有不属于任何符号的小墨团：扫描件的噪点成片（破碎一页上 4×4 的点隔七八个像素一个），
      // 真附点四周是干净的
      const speckles = blobsIn(dcx - sp * DOT_CLEAR, dcy - sp * DOT_CLEAR, dcx + sp * DOT_CLEAR, dcy + sp * DOT_CLEAR)
        .filter((o) => overlapFrac(o, d) === 0 && offLine(o) && !syms.some((s0) => overlapFrac(o, s0.box) > 0));
      if (speckles.length) continue;
      if (!isolated(d)) continue;
      out.push(d);
    }
  }
  if (out.length >= DOT_MEDIAN_N) {
    const dims = out.map((d) => Math.max(d.w, d.h)).sort((p, q) => p - q);
    const med = dims[dims.length >> 1];
    return out.filter((d) => Math.max(d.w, d.h) >= med * DOT_SMALL);
  }
  return out;
}
