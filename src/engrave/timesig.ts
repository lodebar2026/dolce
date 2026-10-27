// 分数式简谱拍号：旧简谱引擎、原样文档、混排简谱层共用。
import { Point, Rect } from "../common/geom";
import { GraphicLine, PageItem, TextFrame } from "../pagetree/pageitem";
import type { Font } from "../pagetree/font";

/**
 * 分数式拍号的取尺。**一切长度都是小节线高度 H 的比例**——原先三条路各按自己的字号
 * 或 musicpp 的 staff space 常量给（layout `numberSize*0.625`、mixed `sc*(40+dy)`、
 * fanqie `font.size*0.62`），换个字号三处就各走各的。以 H 为基准，拍号与小节线自然等高对齐。
 *
 * 默认比例照 layout 原来的观感反算（H = numberSize·4/3，故 `numberSize = H·0.75`）：
 *   字号 numberSize·0.75 = H·0.5625、上数字 −numberSize·0.1 = −H·0.075、
 *   下数字 +numberSize·0.625 = +H·0.46875。
 */
export interface TimeSigStyle {
  /** 小节线高度 H —— 所有比例的基准。 */
  height: number;
  /** 分数线的 y（相对基线）。通常取小节线上下缘的中点。 */
  centerY: number;
  /** 分数线粗细。 */
  ruleWidth: number;
  color: number;
  /** 数字字体（字号由 `digitRatio × H` 定，传进来的 size 会被覆盖）。 */
  font: Font;
  /** 数字字号 ÷ H。**竖向排布只认这一个参数**（见 `TIME_SIG_GAP_EM`）。 */
  digitRatio?: number;
  /** 分数线长度 ÷ H，**按每一位数字算**（长度 = ratio × H × 位数）。 */
  ruleLengthRatio?: number;
}

/**
 * 数字墨迹与分数线墨迹之间的净距 ÷ 拍值字号 —— 就是**减时线与音符**那一格
 * （1/9 em，按展开档实测的距离定）。
 *
 * 竖向排布因此**只由拍值字号一个参数决定**：上数字的墨迹底离分数线上缘一格、
 * 下数字的墨迹顶离分数线下缘一格，上下对称。原先是两个「基线 ÷ H」的比例常量
 * （`upperRatio` / `lowerRatio`），那两个数是按谱面档的数字（0.5625 H）反算的，
 * 换个字号就散架：混排的数字是 0.75 H，照搬会让两个数字挤到一处、
 * 分数线还压在下数字的墨迹上。
 *
 * 两处口径都按**墨迹**算（数字的墨迹底≈基线、墨迹顶要减去数字高），
 * 与「数字 ↓ 减时线 ↓ 低音点」那一摞同一把尺子。
 */
export const TIME_SIG_GAP_EM = 1 / 9;

export const TIME_SIG_DEFAULTS = {
  digitRatio: 0.5625,
  /**
   * **每一位数字**占的分数线长度 ÷ H。
   *
   * 为什么不是一个定长比例：全书 592 处拍号里 579 处是一位数、13 处是 `12/8`。
   * 实测（Times，数字等宽）一位数 = 0.2813 H、两位数 = 0.5627 H——单给一个常数，
   * 取小的那 13 处分数线比数字还窄，取大的那 579 处分数线比数字宽出一倍。
   * 按位数算两边都对得上，而长度**仍然只由 H 与位数决定**，
   * 不再跟着字体的 advance 走（0.28125 = digitRatio × 0.5，即数字 advance 半个 em）。
   */
  ruleLengthRatio: 0.28125,
} as const;

/** 拍号占的宽（即分数线长）：只由小节线高 `H` 与位数定，纯算术——横向排布给行中转拍让位用（`place/spacing.ts`）。 */
export function timeSigWidth(beats: number, beatType: number, H: number, digitRatio?: number, ruleLengthRatio?: number): number {
  const digits = Math.max(String(beats).length, String(beatType).length);
  return digits * (ruleLengthRatio !== undefined ? H * ruleLengthRatio : H * (digitRatio ?? TIME_SIG_DEFAULTS.digitRatio) * 0.5);
}

/**
 * 分数式拍号（分子在上、分母在下、中间一横），**两个数字都横向居中于分数线**。
 * 图元相对自身原点，x 从 0 起，宽度即分数线长度。
 */
export class TimeSigGlyph {
  readonly items: PageItem[];
  readonly rule: GraphicLine;
  readonly width: number;
  /** 墨迹盒（数字按字形墨迹、分数线按描边），本地坐标。 */
  private readonly ink: Rect;

  constructor(beats: number, beatType: number, style: TimeSigStyle) {
    const H = style.height;
    const d = TIME_SIG_DEFAULTS;
    const font = style.font.makeWithSize(H * (style.digitRatio ?? d.digitRatio));
    const y = style.centerY - style.ruleWidth / 2;

    const mk = (s: string): { tf: TextFrame; w: number; ink: Rect } => {
      const tf = new TextFrame();
      tf.font = font;
      tf.color = style.color;
      tf.text = s;
      return { tf, w: tf.measureText(), ink: font.charBound(s) };
    };
    const up = mk(String(beats));
    const lo = mk(String(beatType));

    // **长度按位数算**，不跟着字体量出来的数字宽度走：给了 `ruleLengthRatio` 就按 H 的比例，
    // 没给就按**拍值字号的半个 em**（数字 advance）——那正是默认比例 0.28125 的来历
    //（0.5 × 默认 digitRatio 0.5625），字号一改自己跟着走，不必再算一遍比例。
    const width = timeSigWidth(beats, beatType, H, style.digitRatio, style.ruleLengthRatio);

    // 竖向：两个数字各离分数线**一格**（TIME_SIG_GAP_EM × 拍值字号，墨迹到墨迹），
    // `TextFrame.y` 是基线，故上数字要减去墨迹底（数字一般 ≈ 0）、下数字要减去墨迹顶
    //（负值，即数字高）。`y` 是分数线的**描边中心**。
    const gap = font.size * TIME_SIG_GAP_EM;
    up.tf.y = y - style.ruleWidth / 2 - gap - up.ink.bottom;
    up.tf.x = (width - up.w) / 2;
    lo.tf.y = y + style.ruleWidth / 2 + gap - lo.ink.top;
    lo.tf.x = (width - lo.w) / 2;

    const rule = new GraphicLine();
    rule.strokeWidth = style.ruleWidth;
    rule.strokeColor = style.color;
    rule.p0 = new Point(0, y);
    rule.p1 = new Point(width, y);

    this.items = [up.tf, lo.tf, rule];
    this.rule = rule;
    this.width = width;
    this.ink = up.ink
      .offset(up.tf.x, up.tf.y)
      .union(lo.ink.offset(lo.tf.x, lo.tf.y))
      .union(new Rect(0, y - style.ruleWidth / 2, width, y + style.ruleWidth / 2));
  }

  /** 墨迹盒（本地坐标，未加调用方的平移）。 */
  box(): Rect {
    return this.ink;
  }
}
