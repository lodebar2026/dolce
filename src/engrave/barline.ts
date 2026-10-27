// 小节线（含反复点）的画法：旧简谱引擎、原样文档、混排共用。
//
// 原语是**纯函数**：只认坐标与 style，不认 Entry / ChordLayout / PlacedItem 那些模型类型，
// 各路的坐标换算留在自己的调用点（musicpp 的 `sc = staffHeight/40` 之类别漏进来）。
import { Point } from "../common/geom";
import { GraphicLine, PageItem } from "../pagetree/pageitem";
import { BarStyle } from "../score/enums";
import { jpDot } from "./dot";

/** 一条小节线的样式语义（各格式读进来时折成这个）。 */
export interface BarlineSpec {
  /** MusicXML 的 bar-style。null = 普通细线。 */
  style?: BarStyle | null;
  /** `:‖`（反复回到前面）——两点画在左侧。 */
  repeatBackward?: boolean;
  /** `‖:`（反复段起点）——两点画在右侧。 */
  repeatForward?: boolean;
}

/** 小节线的画法参数。上下缘各路自己给（旧简谱引擎是 jpStaffTop/Bottom、原样文档是 barlineHeight
 *  居中于基线、混排是简谱层/谱表的上下缘），**粗细组合、线距与反复点的排布一律照这一份**。 */
export interface BarlineStyle {
  /** 上下缘，相对基线（y 向下为正，所以 top 通常是负的）。 */
  top: number;
  bot: number;
  /** 细线宽 / 粗线宽。 */
  light: number;
  heavy: number;
  /** 相邻两条线**墨迹之间**的空。缺省 = 粗线宽（与五线谱 `barlineDist` 同一口径：混排 5 = heavyBarline 5）。 */
  gap?: number;
  /** 反复点半径。<=0 = 按细线宽推算（`light * 1.6`）。 */
  dotRadius?: number;
  /** 画不画反复点。混排的反复点按谱表的间位另画（`mixed/render.ts::drawRepeatDots`），这里只要线。缺省 true。 */
  dots?: boolean;
  color: number;
}

/** 一条小节线的粗细组合（左→右）。分出来单独可测，也给 `isPlain` 用。 */
export function barlineWidths(spec: BarlineSpec, final: boolean, light: number, heavy: number): number[] {
  const st = spec.style ?? null;
  // **不画线的小节线**（MusicXML `<bar-style>none</bar-style>`）：出版社把一个小节拆到
  // 两行/两页时用它分隔，谱面上什么也不印。原先没有这一支，落到最后的 `else` 里当普通
  // 细线画了出来——正因为「画出来会多一条线」，`model/tojpw.ts` 干脆不把它写进 `.jpwabc`，
  // 于是重新解析时两个小节并成一个，`.Repeat` 里按原编号写的段落就越界
  // （094《哈利路亚，祂已复活》等 4 首整份 .pptx 排不出来）。认了它，两头都对得上。
  if (st === BarStyle.NONE && !spec.repeatBackward && !spec.repeatForward) return [];
  let widths: number[];
  // **前后反复背靠背**（`:‖:`）：上一小节收尾的 `:‖` 与本小节起头的 `‖:` 合成一条，
  // 五线谱的画法是「细 粗 细」+ 两侧各两点，而不是两根粗线并排。
  if (spec.repeatBackward && spec.repeatForward) widths = [light, heavy, light];
  else if (st === BarStyle.LIGHT_HEAVY || (final && !spec.repeatForward)) widths = [light, heavy];
  else if (st === BarStyle.HEAVY_LIGHT || spec.repeatForward) widths = [heavy, light];
  else if (st === BarStyle.LIGHT_LIGHT) widths = [light, light];
  else if (st === BarStyle.HEAVY_HEAVY) widths = [heavy, heavy];
  else if (st === BarStyle.HEAVY) widths = [heavy];
  else widths = [light];
  if (spec.repeatBackward && widths.length === 1) widths = [light, heavy];
  return widths;
}

/**
 * 一条小节线（几条竖线 + 反复点），图元相对自身原点、x 从 0 起。
 *
 * 反复点在**细线那一侧**（`:‖` 左、`‖:` 右），先占位再画线，x 顺序才对。
 * `lines` 是那几条竖线的引用——旧简谱引擎的 `clipBarlinesUnderSlurs` 要按它们缩短上缘。
 */
export class BarlineGlyph {
  readonly items: PageItem[] = [];
  readonly lines: GraphicLine[] = [];
  /** 排版占位：墨迹宽 + 末线后再留一个线距（`‖:` 则到反复点右缘）。 */
  readonly width: number;
  /** 是不是「一条普通细线」（没有反复点、没有粗线）。 */
  readonly isPlain: boolean;

  constructor(spec: BarlineSpec, final: boolean, style: BarlineStyle) {
    const { top, bot, light, heavy, color } = style;
    const widths = barlineWidths(spec, final, light, heavy);
    const dots = style.dots ?? true;
    const dotR = style.dotRadius !== undefined && style.dotRadius > 0 ? style.dotRadius : light * 1.6;
    const dotGap = dotR * 1.6;
    const dist = style.gap ?? heavy;
    let xpos = 0;

    const addDots = (cx: number): void => {
      const mid = (top + bot) / 2;
      const off = (bot - top) / 6;
      for (const cy of [mid - off, mid + off]) this.items.push(jpDot(cx, cy, dotR, color));
    };

    if (dots && spec.repeatBackward) {
      addDots(xpos + dotR);
      xpos += dotR * 2 + dotGap;
    }
    for (const w of widths) {
      const l = new GraphicLine();
      l.strokeColor = color;
      l.x = xpos + w / 2;
      l.p0 = new Point(0, top);
      l.p1 = new Point(0, bot);
      l.strokeWidth = w;
      xpos += w + dist;
      this.items.push(l);
      this.lines.push(l);
    }
    if (dots && spec.repeatForward) {
      xpos += dotGap - dist;
      addDots(xpos + dotR);
    }
    this.width = xpos;
    this.isPlain = widths.length <= 1 && !spec.repeatBackward && !spec.repeatForward;
  }

  /** 竖线墨迹的左右缘（建好、未经 `Group.update` 搬动时的本地坐标）。 */
  get inkLeft(): number {
    const f = this.lines[0];
    return f ? f.x - f.strokeWidth / 2 : 0;
  }
  get inkRight(): number {
    const l = this.lines[this.lines.length - 1];
    return l ? l.x + l.strokeWidth / 2 : 0;
  }
}
