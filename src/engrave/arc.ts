// 弧线（圆滑线 / 延音线，及三连音的两段弧）：三引擎共用一份。上半是样式参数与两个纯函数（弧高、控制点），
// 下半是月牙形图元本身（`SlurTieBase` / `Slur` / `Tie`：填充 + 描边、扁平长连音线、断口），
// 避让与纵向预留（原样文档 `jianpuSlurRise`、混排 `arcExtent`）按它们算，与画出来的弧同一份。
import { Point } from "../common/geom";
import { Group, GraphicPath } from "../pagetree/pageitem";

/** 弧线（圆滑线 / 连音线）的样式参数。位置参数太多不可读，统一走这个对象。 */
export interface SlurStyle {
  /** 月牙形的最大厚度（musicpp 的 `lw0`），也是扁平式线宽的折算基准。 */
  thickness: number;
  color: number;
  /** 整条弧随字号缩放（成书排版用小字号，绝对像素会显得过高）。默认 1。 */
  heightScale?: number;
  /** 细描边的线宽。默认 0.7。 */
  outlineWidth?: number;
  /** 弧高上限，**未乘 `heightScale` 的原始像素口径**。<=0 或省略 = 不封顶。 */
  maxHeight?: number;
  /** 弧高下限，同样是未乘 `heightScale` 的原始像素口径。<=0 或省略 = 只用公式自带的 1.2。 */
  minHeight?: number;
  /** 跨度超过它就改画扁平长连音线。<=0 或省略 = 一律画弧。 */
  flatSpan?: number;
  /** **这一条**强制走扁平式（按弧覆盖的音符个数判，见 `Line.addSlurTie`）。 */
  forceFlat?: boolean;
  /** 弧的**宽高比**（跨度 ÷ 弧顶高）超过它就改画扁平式。<=0 或省略 = 不看这一条。
   *  跨度阈值是绝对宽度，跟不上字号与弧高上限的变化；宽高比才是「这条弧看着扁不扁」。 */
  flatRatio?: number;
  /** 扁平式**中段**的墨迹厚度（两端一样收尖）。省略 = `thickness * 0.45`。 */
  flatLineWidth?: number;
  /**
   * 弧的开口朝向。默认 `"up"`——**简谱的弧一律在音符上方、开口朝下**，
   * 三条简谱路（编辑器 / 成书重排 / 文本谱）都不设它。
   * `"down"` 只给混排的五线谱层用：那里 slur/tie 跟着符干走，符干朝上时弧在音符下方。
   */
  side?: "up" | "down";
  /**
   * 中间挖掉 `[x0, x1]` 这一截（页面 x），只画两头——三连音的「两段弧」风格（数字坐在断口里，
   * 见 `Line.addTuplet`）。切的是**同一条月牙**，所以音符那一端照样收尖、断口处是弧中段的厚度，
   * 与同页的 slur 同一套形状语言，不另画等宽线。有 gap 时一律画弧，不走扁平式。
   */
  gap?: { x0: number; x1: number };
}

/**
 * 弧高（正数，实际画的时候取负——简谱的弧一律在音符上方、开口朝下）。
 * **这是弧高的唯一算法**：谱面排版、成书重排、文本谱的绘制与纵向预留全走它。
 *
 * musicpp 的公式（按 jianpuFont≈28 调的绝对像素）在**短弧**上会算出负值
 * ——dist < 10^(16/17) ≈ 8.7pt 时 h 变正，弧就翻过来开口朝上了，所以钳住下限。
 *
 * 上限是本项目加的（musicpp / 原 Kotlin 都没有）：对数虽然涨得慢却**没有上限**，
 * 28px 字号下典型跨度（3 个音符步距，dist≈90）弧高 17px，整行的长弧（dist≈600）
 * 冲到 31px，将近两倍——顶到上方的和弦符号上。参考 open-fanqie
 * （renderer.ts:703，弧高恒定 10px 与跨度无关）封顶，短弧的手感一点不变。
 */
export function arcHeight(dist: number, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight"> = {}): number {
  const floor = o.minHeight !== undefined && o.minHeight > 0 ? o.minHeight : 1.2;
  const raw = Math.max(Math.log10(Math.max(dist, 1e-6)) * 17 - 16, floor);
  const cap = o.maxHeight !== undefined && o.maxHeight > 0 ? Math.max(o.maxHeight, floor) : Infinity;
  return Math.min(raw, cap) * (o.heightScale ?? 1);
}

export function calcSlurPoints(pl: Point, pr: Point, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight" | "side"> = {}): [Point, Point, number] {
  const xr = pr.x, xl = pl.x, yr = pr.y, yl = pl.y;
  const dx = xr - xl, dy = yr - yl;
  const square = dx * dx + dy * dy;
  const dist = Math.sqrt(square);
  const theta = Math.atan2(dy, dx);
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);
  const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
  // 页面坐标 y 向下为正，所以「弧在上方」= 控制点 y 取负。
  const h = arcHeight(dist, o) * (o.side === "down" ? 1 : -1);
  let p1 = new Point(xlen, h).rotate(cos, sin);
  let p2 = new Point(dist - xlen, h).rotate(cos, sin);
  p1 = p1.offset(xl, yl);
  p2 = p2.offset(xl, yl);
  return [p1, p2, cos];
}

/** 首尾相接的两条弧（前一条的终点就是后一条的起点）在接点**各内缩**数字字号的几分之一：免得两条弧顶在一起。
 *  旧简谱引擎与原样文档同一个值（musicpp 的 size/14）。 */
export const ARC_CHAIN_INSET_DIV = 14;

// ── 弧的定位：只分**简谱**与**五线谱**两种（用户定） ──
//
// 简谱弧（旧简谱引擎、原样文档、混排的简谱层三路同一条）：
//   - 端点落在数字墨心；高度只看**起止两个音**：两摞（数字、高音点；终点那个音再算上它的临时记号——起点的在弧外侧）
//     的墨迹顶取高者，再往上**一道叠层的空**（`stack-gap × 数字墨迹高`，与八度点、减时线之间同一个量）；
//   - 首尾相接的两条在接点各内缩字号的 1/`ARC_CHAIN_INSET_DIV`；
//   - 弧套弧：外弧按实际弧线判碰内弧（`arcClearShift`，障碍 = 内弧弧顶），碰了才整条抬，抬到高出一道空；
//   - 跨行的弧**两截都画**：起头那行画到行末那个音右侧半格，收尾那行从行首那个音左侧半格起弧；敞口那截的高度只认真有的那一端。
// 五线谱弧（混排的五线谱层）：端点照原 C++ 工程挂符头/符干，**看整个跨度**——跨度里的符头、符干尖都是障碍。

/** 简谱弧的端点高度：起止两摞的墨迹顶（终点算上临时记号，由调用方并进 `endTop`）取高者，再往上一道 `gap`。y 向下为正。 */
export function jpArcY(startTop: number, endTop: number, gap: number): number {
  return Math.min(startTop, endTop) - gap;
}

/** 一个障碍点：弧那一侧最外的墨迹（朝上的弧给墨迹顶，朝下的给墨迹底）。 */
export interface ArcObstacle {
  x: number;
  y: number;
}

/**
 * 弧要**整条**挪多少才让开这些障碍、再留一道 `gap`。弧线按抛物线近似：端点连线 + 弧高 `rise × 4u(1−u)`
 * （贝塞尔弧的顶在控制点高的 0.75，调用方给 `rise` 时已折好）。`above` 为真时弧朝上（y 减）。
 * 返回值朝上为负、朝下为正；不用挪返回 0。只看端点之间（开区间）的障碍。
 */
export function arcClearShift(
  x0: number, y0: number, x1: number, y1: number,
  rise: number, above: boolean, obstacles: readonly ArcObstacle[], gap: number,
): number {
  if (x1 - x0 <= 1e-6) return 0;
  let shift = 0;
  for (const o of obstacles) {
    if (o.x <= x0 || o.x >= x1) continue;
    const u = (o.x - x0) / (x1 - x0);
    const line = y0 + (y1 - y0) * u;
    const bulge = rise * 4 * u * (1 - u);
    if (above) shift = Math.min(shift, o.y - gap - (line - bulge));
    else shift = Math.max(shift, o.y + gap - (line + bulge));
  }
  return shift;
}

/** 弧（月牙）弧顶离端点连线多高：控制点高 `arcHeight` 的 0.75（三次贝塞尔两控制点等高时的顶点）。 */
export function arcRise(dist: number, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight"> = {}): number {
  return arcHeight(dist, o) * 0.75;
}

// ───────────────────────── 弧线图元（页面树） ─────────────────────────

/** 三次贝塞尔在 `[a, b]` 这一段（de Casteljau 切两刀）。 */
function bezierSeg(p: readonly [Point, Point, Point, Point], a: number, b: number): [Point, Point, Point, Point] {
  const lerp = (u: Point, v: Point, t: number): Point => new Point(u.x + (v.x - u.x) * t, u.y + (v.y - u.y) * t);
  const split = (q: readonly [Point, Point, Point, Point], t: number): [[Point, Point, Point, Point], [Point, Point, Point, Point]] => {
    const p01 = lerp(q[0], q[1], t), p12 = lerp(q[1], q[2], t), p23 = lerp(q[2], q[3], t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
    const m = lerp(p012, p123, t);
    return [[q[0], p01, p012, m], [m, p123, p23, q[3]]];
  };
  const head = b >= 1 ? [p[0], p[1], p[2], p[3]] as [Point, Point, Point, Point] : split(p, b)[0];
  return a <= 0 ? head : split(head, a / b)[1];
}

/** 三次贝塞尔上 x 取 `x` 的参数 t（x(t) 单调时二分；弧线两端同高，天然单调）。 */
function bezierTAtX(p: readonly [Point, Point, Point, Point], x: number): number {
  const xAt = (t: number): number => {
    const u = 1 - t;
    return u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x;
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (xAt(mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export abstract class SlurTieBase extends Group {
  /**
   * 走了**扁平长连音线**那条路时，两端那个钩的水平长度（`initFlat` 的 `hx`）；画成弧的是 0。
   *
   * 上方带堆叠要拿它算「这一段 x 上墨迹到底多高」（`Line.collectBandItems` 的 `topAt`）：
   * 弧的墨迹按抛物线两头低、中间高，扁平式却是**中段一路平着、只有两端 hx 那截往下收**
   * ——照抛物线算，落在末端附近的 fermata 会被判成「那儿的弧几乎贴着音符」而不让位，
   * 于是压在扁平线上（171《回家吧》末行的延长号）。
   */
  flatHx = 0;

  init(pl: Point, pr: Point, style: SlurStyle): void {
    const dx = pr.x - pl.x, dy = pr.y - pl.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // 「看着扁不扁」按**宽高比**判：弧高是对数公式加上下限算的，长跨度那头封了顶，
    // 所以跨度一长比值就迅速变大。绝对跨度那条阈值留着（两者取先满足的）。
    const arcH = arcHeight(dist, style) * 0.75;
    const flatByRatio = style.flatRatio !== undefined && style.flatRatio > 0
      && arcH > 0 && dist / arcH > style.flatRatio;
    if (style.gap) {
      this.initArc(pl, pr, style);
      return;
    }
    if (style.forceFlat || flatByRatio
        || (style.flatSpan !== undefined && style.flatSpan > 0 && dist > style.flatSpan)) {
      this.initFlat(pl, pr, dist, style);
      return;
    }
    this.initArc(pl, pr, style);
  }

  private initArc(pl: Point, pr: Point, style: SlurStyle): void {
    const [pt0, pt1, cos] = calcSlurPoints(pl, pr, style);
    const clr = style.color;
    const lw0 = style.thickness / cos;

    // musicpp drawSlurTied (render.cpp:1078-1104): a filled crescent — out
    // along the curve, back with both control points pushed *down* by lw0/2 so
    // the shape is thick in the middle and pointed at both ends — plus a thin
    // outline stroked along a curve offset by lw0/4.
    // (The earlier port pushed pt0 along x instead of y, which flattened the
    // left end and made the arc visibly lopsided.)
    const upper: [Point, Point, Point, Point] = [pl, pt0, pt1, pr];
    const lower: [Point, Point, Point, Point] = [pl, pt0.offset(0, lw0 / 2), pt1.offset(0, lw0 / 2), pr];
    const mid: [Point, Point, Point, Point] = [pl, pt0.offset(0, lw0 / 4), pt1.offset(0, lw0 / 4), pr];
    // 要画的参数区间：整条是 [0,1]；挖了中段就是两头两截（三条曲线的控制点只差 y，x(t) 相同，共用一个 t）
    const spans: [number, number][] = [];
    if (style.gap) {
      const tl = bezierTAtX(upper, style.gap.x0);
      const tr = bezierTAtX(upper, style.gap.x1);
      spans.push([0, tl], [tr, 1]);
    } else {
      spans.push([0, 1]);
    }
    const paths: GraphicPath[] = [];
    for (const [a, b] of spans) {
      const up = bezierSeg(upper, a, b);
      const lo = bezierSeg(lower, a, b);
      const obj = new GraphicPath();
      obj.fill = true;
      obj.stroke = false;
      obj.fillColor = clr;
      obj.moveTo(up[0]);
      obj.cubicTo(up[1], up[2], up[3]);
      if (lo[3].x !== up[3].x || lo[3].y !== up[3].y) obj.lineTo(lo[3]); // 断口那一端是平头
      obj.cubicTo(lo[2], lo[1], lo[0]);
      obj.close();
      paths.push(obj);
    }
    for (const [a, b] of spans) {
      const md = bezierSeg(mid, a, b);
      const outline = new GraphicPath();
      outline.fill = false;
      outline.stroke = true;
      outline.strokeWidth = style.outlineWidth ?? 0.7;
      outline.strokeColor = clr;
      outline.moveTo(md[0]);
      outline.cubicTo(md[1], md[2], md[3]);
      paths.push(outline);
    }

    this.finish(paths);
  }

  /**
   * 超长跨度的扁平长连音线：两端各一小段钩弧，中间一条水平细线。
   *
   * 照 open-fanqie（renderer.ts:690-700，`slurStyle: auto` 下跨度 > 100px 就改这个
   * 画法，用 `lianyinxian_zuo`/`lianyinxian_you` 两个钩字形 + `stroke-width 1.2` 的直线）。
   * 本项目没有那两个字形，钩自己用贝塞尔画。
   *
   * 高度取**阈值处那条弧的弧顶**（`arcHeight(flatSpan) * 0.75`——贝塞尔的弧顶约为控制点
   * 高的 0.75），所以跨度跨过阈值的一刻高度连续，同一页里弧形与扁平并存也不会一高一低。
   */
  private initFlat(pl: Point, pr: Point, dist: number, style: SlurStyle): void {
    // 高度按阈值那条弧算；没设阈值（纯按音符个数强制扁平）就拿这一条自己的跨度算
    const h = arcHeight(
      style.flatSpan !== undefined && style.flatSpan > 0 ? style.flatSpan : dist, style) * 0.75;
    // 钩的水平长度：短了会显得两端急折，长了中段的直线就没了。h 的 2.5 倍最耐看。
    const hx = Math.min(dist * 0.12, h * 2.5);
    const t = style.flatLineWidth !== undefined && style.flatLineWidth > 0
      ? style.flatLineWidth
      : style.thickness * 0.45;
    const clr = style.color;

    // 与弧形同一套形状语言：**填充的月牙**，中段厚 t、两端收到端点上成尖角
    // （去程画上缘、回程沿同一条形状下压 t 画回来，两端共用 pl/pr 所以天然是尖的）。
    // 早先这里是一条等宽描边线，两端齐头齐脑，跟满页的月牙弧摆在一起很扎眼。
    this.flatHx = hx;
    const obj = new GraphicPath();
    obj.fill = true;
    obj.stroke = false;
    obj.fillColor = clr;
    this.flatEdge(obj, pl, pr, hx, h, 0, false);
    this.flatEdge(obj, pl, pr, hx, h, t, true);
    obj.close();

    this.finish([obj]);
  }

  /**
   * 扁平连音线的一条边：`down` = 回程（从右往左、整体下压 `dy`）。
   * 钩子在端点处陡、接上平线处水平：控制点一个贴端点抬起、一个落在平线上。
   */
  private flatEdge(p: GraphicPath, pl: Point, pr: Point, hx: number, h: number, dy: number, down: boolean): void {
    const topL = pl.y - h + dy, topR = pr.y - h + dy;
    if (!down) {
      p.moveTo(pl);
      p.cubicTo(new Point(pl.x + hx * 0.15, pl.y - h * 0.55), new Point(pl.x + hx * 0.45, topL), new Point(pl.x + hx, topL));
      p.lineTo(new Point(pr.x - hx, topR));
      p.cubicTo(new Point(pr.x - hx * 0.45, topR), new Point(pr.x - hx * 0.15, pr.y - h * 0.55), pr);
    } else {
      p.cubicTo(new Point(pr.x - hx * 0.15, pr.y - h * 0.55 + dy), new Point(pr.x - hx * 0.45, topR), new Point(pr.x - hx, topR));
      p.lineTo(new Point(pl.x + hx, topL));
      p.cubicTo(new Point(pl.x + hx * 0.45, topL), new Point(pl.x + hx * 0.15, pl.y - h * 0.55 + dy), pl);
    }
  }

  /** 把画好的路径挪到自身坐标系原点，并把包围盒记到 x/y/width/height 上。 */
  private finish(paths: GraphicPath[]): void {
    let box = paths[0].computeTightBounds();
    for (const p of paths.slice(1)) box = box.union(p.computeTightBounds());
    for (const p of paths) {
      p.offset(-box.left, -box.top);
      p.x = 0;
      p.y = 0;
      p.width = box.width;
      p.height = box.height;
      this.add(p);
    }
    this.x = box.left;
    this.y = box.top;
    this.width = box.width;
    this.height = box.height;
  }
}
export class Tie extends SlurTieBase {
  /** 这条弧连的是哪两个和弦（`ScoreDoc` 元素 id）。可视化编辑按 `起点:终点` 认出弧本身好点选；
   *  多连音那种没有起止音符的弧不填。**排版不读它**。 */
  startId: number | null = null;
  endId: number | null = null;
}
export class Slur extends SlurTieBase {}
