// 原样文档布局的定位结构：排版行视图 → 各符号、记号、声部、谱组、页的位置。只有数据，算法在同目录各文件。
import type { InlineLayerElement, LyricSyllable, Mark, MusicElement, ScoreLine, VoiceGroup } from "../../../jianpu/ast";
import type { JianpuGrid } from "../metrics";
import type { Rect } from "../../../common/geom";

/** 一个占位的谱面符号（音符 / 增时线 / 小节线）。 */
export interface PlacedItem {
  /** 占位序号（只数音符/增时线/小节线） */
  index: number;
  /** 在 voice.elements 里的下标——记号的 start/end 用的是这个坐标系 */
  srcIndex: number;
  /** 锚点 x（行坐标系；数字按墨迹居中于此） */
  x: number;
  /** 自然宽度（拉伸前），供两端对齐用 */
  advance: number;
  element: MusicElement;
  /** 起始拍位（小节内），用于减时线分组与多声部对齐 */
  beat: number;
  /** 时值（拍） */
  beats: number;
  /** 本音符所跟的歌词音节，逐段一个（缺段为 null） */
  syllables: Array<LyricSyllable | null>;
  /** 纵向偏移：`{dsb}` 并排块里，主旋律这一段要下移半个行距 */
  dy?: number;
  /** 小节线不画（分声部前的空声部，见 song.ts::hideEmptyBarlines）；占位照旧 */
  noBarline?: true;
}

/** 一条跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱），已换算成行内坐标。 */
export interface PlacedMark {
  /** 纵向偏移：并排块里主旋律那一段的记号也要跟着下移 */
  dy?: number;
  mark: Mark;
  x0: number;
  x1: number;
  /** 纵向落点（相对该声部的音符基线，负为上）：弧线/多连音是弧端那条线（`placeMarks`），松叶是底边、房号是横线（`band.ts`） */
  y?: number;
  /** 弧罩住的音符够多（`arc.flatNotes`，成书用），不论跨度都画扁平式（同 `Line.addSlurTie`） */
  flat?: true;
  /** 和音最下面那个音单连的延音线：画在叠印下方、开口朝上，`y` 是弧端那条线（数字、减时线、低音点之下一道空） */
  below?: true;
  /** 嵌套层数或 `+` 抬高级别 */
  level: number;
  /** 左端续自上一行 / 右端续到下一行（弧线与跳房子支持跨行） */
  openLeft: boolean;
  openRight: boolean;
  /** 两端实际落在哪两个符号上。`FanqieMark.start/end` 是**行内下标**不是元素 id，
   *  可视化编辑要按元素 id 认这条弧，只能从这里取（`DocView.idOf`）。排版不读。 */
  startEl?: MusicElement;
  endEl?: MusicElement;
}

/**
 * 临时伴奏 `{bz…}`：画在主旋律上方的小字号行。
 * 临时多声部 `{dsb…}`：**并排块**——括起的内容与主旋律的对应片段上下并排、同字号，
 * 左（或右）侧一个大花括号；主旋律在这一段里下移半个行距，并排段外仍在原位。
 */
export interface PlacedLayer {
  layer: InlineLayerElement;
  items: PlacedItem[];
  underlines: PlacedUnderline[];
  /** `{dsb}` 的并排块信息；`{bz}` 没有 */
  split?: PlacedSplit;
  /** `{bz}` 小字号行的数字墨迹中线（相对主旋律基线，`band.ts::placeCue`） */
  y?: number;
}

export interface PlacedSplit {
  /** 上行（括起的内容）相对主旋律基线的偏移，负值 */
  dy: number;
  line: ScoreLine;
  marks: PlacedMark[];
  /** 花括号：并排段在行内开始就画左向的，在行内结束就画右向的 */
  braceLeftX?: number;
  braceRightX?: number;
  braceTop: number;
  braceBottom: number;
  /** 上行自己的上方带（相对上行基线，`band.ts::placeBand`） */
  band?: PlacedText[];
}

/** 一条减时线段：第 level 层，从 x0 到 x1。 */
export interface PlacedUnderline {
  level: number;
  x0: number;
  x1: number;
  dy?: number;
}

export interface PlacedVoice {
  voice: ScoreLine;
  /** 音符基线 y（页坐标系） */
  y: number;
  items: PlacedItem[];
  underlines: PlacedUnderline[];
  marks: PlacedMark[];
  layers: PlacedLayer[];
  /** 各段歌词的基线 y，与 voice.lyrics 平行 */
  lyricY: number[];
  /** 谱行上方那一带的字与记号（和弦、注释、转调标签、力度/术语/跳转字、奏法记号），y 已定死（`band.ts`） */
  band: PlacedText[];
  /** 头顶最高的墨迹（相对基线，负为上）与其中字的最高墨迹顶（组间让位用，`vertical.ts::groupHeadroom`） */
  top: number;
  textTop: number | null;
  /** 器乐谱谱行下方那条带（力度、渐强渐弱）的墨迹底（相对基线），没有就不写（`band.ts::placeBelow`） */
  bottom?: number;
}

/** 上方带里的一件：和弦、段落词（音符注释）、转调标签、力度/术语/跳转字、奏法记号字形。 */
export interface PlacedText {
  kind: "chord" | "section-word" | "key-label" | "direction" | "artic";
  el: MusicElement;
  text: string;
  /** 字体：乐谱字体（Bravura）、文字字体或歌词字体（段落词）；字号 pt */
  face: "music" | "text" | "lyric";
  size: number;
  /** 落笔点：行坐标 x、相对声部基线的 y */
  x: number;
  y: number;
  /** 墨迹盒（同一坐标系）：堆叠与让位都按它 */
  ink: Rect;
  /** 逐字笔位（相对 `x`，标点挤压后的，`engrave/sectionword.ts::sectionWordRun`）：段落词才有 */
  xs?: number[] | null;
  /** 外面套方框（排练号）：`ink` 已含框 */
  boxed?: boolean;
  /** 粗体（排练号，GB/T 46845 5.9.5 谱例） */
  bold?: boolean;
}

export interface PlacedGroup {
  group: VoiceGroup;
  voices: PlacedVoice[];
  /** 说明性文字（`W:`）的基线 y */
  textY: number;
  /** 连谱号：多声部时从首声部画到末声部 */
  braceTop: number;
  braceBottom: number;
  hasBrace: boolean;
  /** `&sbf` 标出的分声部起点（行内 x）；没标就从 system 左缘起 */
  braceFromX?: number;
  /** 属于第几首（连续长图把多首接成一页后，页脚按首找本曲最低一行） */
  song: number;
}

export interface PlacedPage {
  groups: PlacedGroup[];
  /** 本页属于第几首（一首多唱时用来决定是否重画标题） */
  song: number;
  /** 是否是该首的首页——首页才画标题、作者、调号拍号 */
  firstOfSong: boolean;
  /** 连续长图把多首接成一页时，后面各首的页眉整块下移多少（`place/song.ts::layoutDocument`）；首曲的页眉照 firstOfSong 画 */
  headers?: Array<{ song: number; dy: number }>;
  /** 展开档的标题页（没有谱行，`compose` 按 `placeTitlePage` 画） */
  titlePage?: true;
  /** 展开档、成书：本页各谱行占位盒高之和 + 行距下限（不摊开时的自然高） */
  natural?: number;
}

export interface PlacedScore {
  pages: PlacedPage[];
  metrics: JianpuGrid;
  /** 内容最下沿（连续长图模式据此定页高） */
  contentBottom: number;
  /** 内容最右沿（行内坐标；连续长图模式据此定页宽） */
  contentRight: number;
}

/** 一个音节画出来的那串（字 + 尾随标点，标点挤压后）的横向度量，口径同旧简谱引擎的 `Lyric`（`pageitem.ts`）。
 *  音节按**主体**居中于锚点、前后标点挂出去（同 compose/lyric.ts::paintSyllables）。 */
export interface LyricRun {
  text: string;
  /** 整串字面宽 */
  width: number;
  /** 前置标点（`“凡` 的引号）宽 */
  lead: number;
  /** 主体宽 */
  body: number;
  /** 首字墨迹左边的留白（从挤压后的笔位起算） */
  headBlank: number;
  /** 末字墨迹右边的留白 */
  tailBlank: number;
}

/** 定位用的墨迹量具，由绘制端注入（`compose/index.ts`）：排版这一层不碰字体。 */
export interface InkMeasurer {
  lyric(syl: LyricSyllable): LyricRun;
  /** 歌词字体的空格宽（西文词与词之间补的那一格） */
  readonly lyricSpace: number;
  /** 音符数字（`0`–`7`、`X`、增时线 `-`、附点 `·`）：字面宽，与墨迹盒（相对落笔原点、基线 y = 0）。 */
  digit(ch: string): { advance: number; ink: Rect };
  /** 和弦（engrave/chord.ts 的分段，风格与升降号前后照尺子）：字面宽与墨迹盒（相对左侧基线）；空串墨迹为 null */
  chord(text: string): { advance: number; ink: Rect | null };
  /** 角色字：字面宽与墨迹盒（相对落笔原点、基线 y = 0） */
  text(str: string, role: InkTextRole): { advance: number; ink: Rect };
  /** 段落词（歌词字、段落词字号，标点挤压同 `sectionWordRun`）：量宽、逐字笔位与墨迹盒（相对落笔原点、基线 y = 0） */
  sectionWord(str: string): { advance: number; xs: number[] | null; ink: Rect };
  /** 数字 / 歌词字体的字体盒上下缘（相对基线，上为负）：展开档照旧简谱引擎谱行包围盒码页用（`song.ts::slideBlock`） */
  fontBox(face: "note" | "lyric"): { top: number; bottom: number };
  /** SMuFL 字形的墨迹盒（相对落笔原点、基线 y = 0）：按字形量，不用 4 em 的字体盒 */
  smufl(glyph: string, size: number): Rect;
}

/** 上方带里各种字的角色（字体与字号由绘制端按尺子定，`compose/index.ts`）：
 *  段落词（歌词字、段落词字号）、术语 / 跳转字 / 转调标签（文字字、和弦字号）、房号（数字字、房号字号）、`W:` 说明行。 */
export type InkTextRole = "section-word" | "term" | "jump" | "key-label" | "ending" | "words";
