// 简谱的尺子：一份**样式值**（全是 pt，已折算好），旧简谱引擎从它取。
//
// 折算只在一处：`style/jianpu.ts::jianpuStyleOf`（样式表 → 这份）；成书走 `style/book.ts::bookJianpuStyle`。
// 引擎自己不存样式常量——栅格（`layout/jianpu/metrics.ts::JianpuGrid`）挂着它（`grid.style`）。
//
// 值为 0 的几项是「按引擎缺省 / 按字形量」（各字段注释里写明），不是「没有」。
import type { CompressMode } from "../common/cjkpunct";
import type { AccidentalSide, AccidentalStyleKind } from "./spacing";

/** 一支字：族（CSS font-family 串）+ 粗斜。字号另在 `size` 里。 */
export interface FaceSpec {
  family: string;
  bold: boolean;
  italic: boolean;
}

/** 页眉一项：族、粗体不给 = 沿用正文字（旧简谱引擎取歌词字，原样文档取 `font.text`）。 */
export interface HeaderFace {
  family?: string;
  bold?: boolean;
  size: number;
}

export interface JianpuStyle {
  font: {
    /** 音符数字；和弦、房号、调号拍号那一行也用它的族（不跟 `look.noteBold` 加粗） */
    note: FaceSpec;
    lyric: FaceSpec;
    /** 其余文字（原样文档的歌词、段号、说明行、页眉页脚的底） */
    text: FaceSpec;
    smufl: FaceSpec;
  };
  header: { title: HeaderFace; subtitle: HeaderFace; credit: HeaderFace; scripture: HeaderFace };
  size: {
    note: number;
    lyric: number;
    /** 0 = 不排和弦（旧简谱引擎：编辑器与 OMR 那两条路的输入里没有 harmony） */
    chord: number;
    keyMeter: number;
    verseNum: number;
    /** 房号字号。0 = 不画房号（投影档） */
    ending: number;
    /** 段落词。0 = 不排 */
    sectionWord: number;
    /** 说明行 `W:` */
    words: number;
    /** 页眉 `TL:`/`TR:` 与页脚 */
    header: number;
    /** 倚音 ÷ 主音字号 */
    grace: number;
    /** 临时伴奏层 ÷ 主旋律 */
    cue: number;
  };
  stroke: {
    barline: number;
    finalBarline: number;
    beam: number;
    slur: number;
    /** 弧的描边宽 */
    slurOutline: number;
    /** 扁平长连音线中段的墨迹厚。0 = 弧厚 × 0.45 */
    slurFlat: number;
    /** 渐强渐弱。0 = 数字墨迹高 × 0.07 */
    hairpin: number;
    /** 拍号分数线。0 = 引擎缺省 1.5 */
    timeSigRule: number;
    /** 房号 / 三连音括线。0 = 按字号推 */
    bracket: number;
    /** 双线 / 反复线两根竖线的间距 */
    doubleBarlineGap: number;
  };
  /** 三种点的半径。0 = 按字形量（八度点照 `.` 的墨迹高折半，附点同八度点，反复点按小节线宽推） */
  dot: { octave: number; aug: number; repeat: number };
  vertical: {
    /** 数字上下叠层的空 ÷ 数字墨迹高（engrave/stack.ts） */
    stackGap: number;
    /** 叠层顶之上到弧 / 上方带的空 */
    slurGap: number;
    /** 音符基线 → 歌词基线。0 = 引擎自算（贴着减时线 / 低音点） */
    lyricBaseline: number;
    /** 多段歌词叠在一行谱下的段间行距。0 = 逐段重复整条谱行 */
    lyricStack: number;
    /** 末行歌词 → 下一组音符基线（原样文档） */
    systemGap: number;
    /** 页内谱行均分的上限（旧简谱引擎 `maxLineDist`） */
    systemSpread: number;
    /** 谱行之间另加的空（旧简谱引擎 `staffDist`） */
    staffDist: number;
    voiceGap: number;
    /** 和弦基线离音符墨迹顶 */
    chordGap: number;
    /** 房号括线的「脚」。0 = 按字号推 */
    bracketFoot: number;
    /** 小节线上下缘相对数字基线。0 = 按字号推（−1 em / +1/3 em） */
    staffTop: number;
    staffBottom: number;
    /** 小节线高（原样文档） */
    barlineHeight: number;
  };
  /** 弧高的口径是贝塞尔控制点高（弧顶 ≈ 0.75 × 它 × heightScale）；见 engrave/arc.ts 的 SlurStyle。 */
  arc: {
    heightScale: number;
    /** <= 0 = 不封顶 */
    maxHeight: number;
    /** <= 0 = 只用公式自带的 1.2 */
    minHeight: number;
    /** 跨度超过它改画扁平长连音线。0 = 按字号自动，<0 = 一律画弧 */
    flatSpan: number;
    flatNotes: number;
    flatRatio: number;
  };
  spacing: {
    /** 相邻歌词字之间的最小横向间隙 */
    lyricGap: number;
    /** 两端对齐时往空档里加的总量最多是自然宽的这么多倍（短行不被扯得满行都是） */
    maxHorizontalScale: number;
  };
  look: {
    /** 音符数字（与倚音）加粗。只管数字，和弦、房号那些用 `font.note` 不跟着粗 */
    noteBold: boolean;
    chordPlain: boolean;
    accidentalSide?: AccidentalSide;
    accidentalStyle: AccidentalStyleKind;
    accidentalScale: number;
    punctCompress: CompressMode;
    tupletStyle: "bracket" | "arc";
    verseNumbers: "always" | "never" | "auto";
    verseNumberAutoMin: number;
    /** 拍号两个比例（÷ 小节线高）。0 = engrave/timesig.ts 的缺省 */
    timeSigDigitRatio: number;
    timeSigRuleLenRatio: number;
  };
  page: {
    color: number;
    margin: { top: number; right: number; bottom: number; left: number };
  };
}

/** 逐组浅拷贝（各组都是纯数据）。 */
export function cloneJianpuStyle(s: JianpuStyle): JianpuStyle {
  const out = { ...s } as Record<string, unknown>;
  for (const [k, v] of Object.entries(s)) if (v && typeof v === "object") out[k] = { ...v };
  const font = out.font as JianpuStyle["font"];
  for (const k of Object.keys(font) as (keyof JianpuStyle["font"])[]) font[k] = { ...font[k] };
  const header = out.header as JianpuStyle["header"];
  for (const k of Object.keys(header) as (keyof JianpuStyle["header"])[]) header[k] = { ...header[k] };
  (out.page as JianpuStyle["page"]).margin = { ...s.page.margin };
  return out as unknown as JianpuStyle;
}
