// 简谱 OMR（移植自 ~/proj/musicpp/omr/jianpu.cpp 的 recognition_jp 管线）。
// 不依赖 OpenCV/Tesseract 原生库：像素运算用纯 TS，OCR 子模块可插拔（现为本地 PaddleOCR）。

/** 二值图：1=前景(黑/有墨)，0=背景。row-major，w*h。 */
export interface Binary {
  w: number;
  h: number;
  data: Uint8Array; // 长度 w*h，值 0/1
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rright = (r: Rect) => r.x + r.w;
export const rbottom = (r: Rect) => r.y + r.h;
export const rcx = (r: Rect) => r.x + r.w / 2;
export const rcy = (r: Rect) => r.y + r.h / 2;

/** 连通域：包围盒 + 像素数 + 质心。 */
export interface Component {
  id: number;
  bbox: Rect;
  area: number; // 前景像素数
  cx: number;
  cy: number;
}

/** 节奏音符 X（有声无音高）在 `JpNum.digit` 里的值。取 9：不与 0-7 撞，`digit !== 0` 的「实音」判断照旧成立。 */
export const RHYTHM_DIGIT = 9;

/** jianpu.cpp: struct jpnum —— 一个简谱音符（数字 + 修饰）。 */
export interface JpNum {
  digit: number; // 0-7（0=休止）；RHYTHM_DIGIT(9)=节奏音符 X（有声无音高），同文本谱 AST 里番茄 `9` 的口径
  bbox: Rect;
  dot: number; // 附点数（右侧点）
  octave: number; // 八度偏移（上点+，下点-）
  div: number; // 下划线条数（每条时值减半）
  augment: number; // 增时线 '-' 数（延长拍）
  augmentRects?: Rect[]; // 增时线各横块源图 bbox（仅识别模式叠加按原位绘制用，不参与导出）
  // 复核：判定「差一点」的地方（如 "oct.vetoUp" 八度点像点却被上下文规则否掉）。不改识别结果，
  // 核对视图据此把这个音标黄、进「下一处」。
  doubt?: string[];
  // 复核：哪几段（0 基）的歌词字把握不大（OCR 候选第一名不是它，或第一名比第二名高不了多少）
  lyricDoubt?: number[];
  lyrics?: string[]; // 歌词：按声部(verse)索引，lyrics[0]=第一段(W1)、lyrics[1]=第二段……
  // 段落标记（Intro/Verse/Chorus/Coda…，谱面上多印成方框）：标在该段起始音符上。
  // → `Chord.sectionWord`（123 写成 `"^…"`），下游供乐句排版按段落硬换行（见 score/phrase.ts）。
  sectionMark?: string;
  // 力度（`p`…`fff`）与渐强渐弱的文字（`cresc.` / `dim.`），印在音符上方的小号斜体字，标在它起作用的那个音上，按 x 排序。
  // 力度 → `notations.articulations`（123 `!mf!`，与 .jly 读入同一个落点）；`cresc.` / `dim.` 是谱上文字 → `sectionWord`（`"^cresc."`）。
  dynamics?: string[];
  // 和弦符号（归一后的原文，如 "Am" / "G/B" / "Gsus4"）。印在本谱行音符**上方**，识别见 chordline.ts。
  // → `Chord.harmony` 与文本谱 `"hx:…"`；.jpwabc 装不下和弦，那一路会丢（同力度、渐强渐弱）。
  chord?: string;
  // 和弦在本音符时值内的拍位偏移，取 0..1 的比例（缺省=正对音符本身）。简谱上和弦常印在
  // 两音符之间的拍点上，故不能只表达「挂在某音符」。模型那路（omr/todoc.ts）正落在某条增时线那拍上就挂增时线，
  // 否则就近挂本音符；文本谱 `"hx:"` 挂不住偏移，同样就近挂到本音符（有损）。
  chordOffset?: number;
  // 同一音符时值内的**后续**和弦（长音上第二、第三拍各换一个和弦时用），offset 同上为 0..1 比例。
  // 谱面上它们印在增时线上方，模型里没有独立元素可挂，只能连同 offset 挂回起头的那个音符。
  // → 对应那条增时线的 `Sustain.harmony`（123 `-"G"`）；文本谱挂到对应的那条增时线上（`- "hx:…"`）。
  extraChords?: { tok: string; offset: number }[];
  // 圆滑线/连音线（音符上方弧形 ⌒）。一个音符可同时是上一条的结束与下一条的开始，故起止分开记。
  // slur 记的是**条数**而非布尔：两条弧嵌套时（外弧罩三音、内弧罩后两音）末音要同时收两条，
  // 见 slur.ts::splitNestedArcs。tie 没有嵌套之说，仍是布尔。
  slurStart?: number; // 本音符起了几条圆滑线 → `slur` Mark 的起点
  slurStop?: number;  // 本音符收了几条圆滑线 → `slur` Mark 的终点
  tieStart?: boolean;  // 连音线起点（弧下同音高）→ `tied` Mark 与 `Note.tie.start`
  tieStop?: boolean;   // 连音线终点 → `tied` Mark 与 `Note.tie.stop`
  // 反复与一/二房结构锚定到边界相邻音符，建模型时（omr/todoc.ts）再提升为小节左右 `Barline`。
  repeatForward?: boolean;  // 本音符所在小节左边界为 ||:
  repeatBackward?: boolean; // 本音符所在小节右边界为 :||
  // 房号原文（`Ending.text`）：一个房括号可辖多遍，写作 "1,2,3,5"。
  endingStart?: string;     // 本音符所在小节开始该房
  endingStop?: string;      // 本音符所在小节结束该房
  // 跳转记号（D.C./D.S./Fine/To Coda…），印在本谱行音符附近 → 小节右线上的记号（导出 MusicXML 时落成 <direction>+<sound>）。
  jumpMark?: string;
  // segno 𝄋：跳转的**目标**，不是跳转本身，故挂本音符所在小节的**左**线（记号名 `hs`，123 `!segno!`）。
  // 字形由 segno.ts 几何识别，与 OCR 出来的文字记号 jumpMark 分开。
  segno?: boolean;
  // 曲中转拍号：谱面上「3/4」直接印在谱行里（多见于混合拍的曲子），锚在**其右侧第一个音符**上，
  // 建模型时提升为该小节的 `Measure.attrs.time`（123 写成行内 `[M:3/4]`）。
  timeChange?: { beats: number; beatType: number };
  // 临时升降号（印在数字左侧的 ♯/♭/♮）。按简谱规矩在**小节内延续**到同数字的后续音符——
  // 各路都只照原样写印出来的记号，延续由读端处理（模型 `model/jianpu.ts::AccidentalCarry`、
  // .jpwabc/文本谱 jppitch.ts::applyJpPitch）。
  accidental?: "sharp" | "flat" | "natural";
  // 波音（音符正上方一小段两个尖峰的锯齿；中间穿一道竖杠的是下波音，见 jianpu.ts）。
  // 上波音 → `notations.ornaments: ["inverted-mordent"]`（123 `!sby!`、文本谱 `&sby`）；
  // 下波音 → `["mordent"]`（123 `!xby!`、文本谱 `&xby`）；.jpwabc 装不下。
  ornament?: "upper-mordent" | "lower-mordent";
  // 倚音（谱面上是主音符左上角的小号数字，底下压着一两条减时线、再由一小段弧连到主音符）。
  // 一个主音符可以带一串（`"yy:5 4# 4b"`），故是数组、按 x 排序。
  // → 主音符之前的 `grace` Chord（不占拍位，123 `{5}`）；文本谱 `"yy:…"`。
  grace?: { digit: number; octave: number; div: number; bbox: Rect }[];
  // 延长记号（fermata 𝄐，谱面上是音符头顶一段小弧、弧下扣一个点）。
  // → `notations.fermata`（123 `!fermata!`）；文本谱写作音符后的 `&yc`；.jpwabc 是 `{YanYin}`。
  fermata?: boolean;
  // 多连音（三连音 ⌒3⌒：括线上方标着「几连」）。组里**每个音符都带**同一份 actual/normal，
  // 首尾另标 start/stop。normal 取不大于 actual 的最大 2 的幂（3→2、5/6/7→4），即通行写法。
  // → 组内各音 `duration.timeMod` + 一条 `tuplet` Mark（123 `(3:`）；
  //   文本谱 `(y…)`；.jpwabc 装不下。
  tuplet?: { actual: number; normal: number; start: boolean; stop: boolean };
  // 顿音（谱面上是音符正上方一个**实心倒三角** ▼，简谱印刷体的顿音记号）。
  // → `notations.articulations: ["staccato"]`（与 model/xmlproject.ts 的 `dy` 同口径）；
  //   文本谱 `&dy`；.jpwabc 装不下（layout 那边只画重音）。
  // 重音（音符正上方的 `>`）→ `["accent"]`，123 `!accent!`、文本谱 `&zy`。
  articulation?: "staccato" | "accent";
}

/** 一行（一个 staff 行）识别出的内容。 */
export interface StaffRow {
  topY: number;
  bottomY: number;
  nums: JpNum[]; // 按 x 排序
  barlineXs: number[]; // 小节线 x 位置
  // 本行里印着的转拍号（「3/4」），按 x 排序。音符流里已把这两个数字摘掉，
  // 值同时锚到右侧第一个音符的 `JpNum.timeChange` 上；这里留 bbox 供识别模式按原位叠加。
  meters?: { x: number; beats: number; beatType: number; bbox: Rect }[];
  // 行末那道小节线是不是**终止线**（细+粗两根并排 ‖）。→ 右线 `style: "light-heavy"`（123 `|]`）、
  // 文本谱 `|||`（诗歌本）/`||`（番茄）。反复线由 JpNum.repeatBackward 另管，两者不叠。
  finalBarline?: "end";
  // 本行里的**复纵线**（细细双线 ‖）位置，取并排两根中**右侧**那根的 x（与 barlineXs 里的值同源）。
  // → 右线 `style: "light-light"`（123 `||`）、文本谱 `||`。反复线 `:‖` 的两根也会落进来，
  // 下游一律让 repeatBackward 优先，两者不叠。
  doubleBarXs?: number[];
  // 本行**中间**的终止线（细+粗 ‖）位置，取右侧粗线的 x。只在多声部谱（连谱号括着的声部行）里认：
  // 四声部本子在「阿们」前印一道。→ 右线 `style: "light-heavy"`（123 `|]`、文本谱 `|||`）。
  endBarXs?: number[];
  // 本行歌词行首印着的**段号**（`1.`、`3.5.`），下标 = 段号所属的 verse（0 基）。
  // 段号在装配时本就被丢弃、不占音符位，这里另存一份原样输出：文本谱写成歌词行前置说明
  // `C1:<1.>…`（pu/parse.ts::stripLyricAnnotation，排在细竖线与首字之间）。
  // 只在段号成套可信时才填（见 lyrics.ts 的 verseLabels）；模型那路记在该段首字的 `Lyric.verseLabel`（123 `w:<1.>`）。
  lyricLabels?: string[];
  // 多声部谱（四声部诗歌本）：本行属第几个系统、是其中第几声部（都 0 基，自上而下）。
  // 左侧连谱号括起来的几条谱行是一个系统（jianpu.ts 认），全曲分组齐整才填；缺省 = 单声部。
  // → 模型里每个声部一个 part（todoc.ts），文本谱 `Q1:`…`Q4:`、123 `V:1`…`V:4`。
  system?: number;
  voice?: number;
}

/** 一处带源图坐标的识别文本（页眉/歌词），供识别模式按原位、原字号叠加。 */
export interface TextRegion {
  text: string; // 识别出的展示文本（如 "日光之上"、"作词：叶薇心"、"1=♭B"、歌词单字）
  bbox: Rect; // 源图像素坐标
  // 可选：逐字源图位置（页眉行用 OCR 返回的字位）。识别模式据此把每个字落回源图 x，
  // 使展开排布的标题/著作者行逐字对位，而非整行左对齐挤在一头。
  chars?: { text: string; cx: number }[];
}

export interface RecognizedScore {
  key: string; // 如 "C"
  fifths: number;
  beats: number;
  beatType: number;
  // 混合拍：页眉并排印着的**全部**拍号（首个即 beats/beatType），只印一个时长度为 1。
  // 文本谱两家的头部都写得下多个拍号（`P: 4/4 3/4` / `1=D4/4 3/4`），.jpwabc 只写得下头一个。
  meters?: { beats: number; beatType: number }[];
  meterNote?: string; // 拍号后跟着的说明文字（"混合拍"）
  rows: StaffRow[];
  // 曲号（页眉印着的歌本内编号）：→ `Work.number`（123 `X:`、MusicXML `<work-number>`）、
  // 诗歌本文本谱 `XL:`/`XR:`（按印在标题哪一侧）；番茄没有曲号字段，拼回标题前。
  number?: string;
  numberSide?: "left" | "right";
  title?: string;
  // 副标题（多是曲名英译）：→ `Work.subtitles`（123 第二条 `T:`）、文本谱的第二条
  // 标题行。`.jpwabc` 的 `.Title` 段没有这个字段（既定，不扩语法），走那一路会丢。
  subtitle?: string;
  credits?: string[]; // 著作者整行文本（作词/作曲…），→ `identification.creators`（123 `C:`）
  tempo?: number; // 速度 ♩=NN → `Song.tempos`（123 `Q:1/4=NN`）
  tempoBeat?: { num: number; den: number }; // 速度的拍单位（附点四分 `♩.=` 为 3/8），缺省四分 → `Song.tempoBeat`
  headerRegions?: TextRegion[]; // 页眉文本的源图定位（识别模式按原位叠加）
  lyricRegions?: TextRegion[]; // 歌词单字的源图定位+字号（识别模式按原图位置/大小叠加）
  chordRegions?: TextRegion[]; // 和弦记号的源图定位（识别模式按原位叠加）
  // 谱后单独排版的附段歌词（诗行，不跟音符对齐）：收下的各行原文与源图框，识别模式按原位叠加。
  // 内容已按第 1 段的音位骨架写进各音符的 lyrics[1..]，见 stanzas.ts。
  stanzaRegions?: TextRegion[];
  dotDiam?: number; // 八度点/附点在源图的统计直径（识别模式按原图大小画点，非按字号推算）
  // 给了参照歌词时的词谱互证结果（reflyrics.ts）：改了哪些字、补了哪些字、哪里两边对不上。
  lyricCheck?: LyricCheck;
}

/** 参照歌词核对的一条。位置字段取自识别结果：谱行、段（0 基）、行内第几音（0 基）、小节（1 基）、音符源图框。 */
export interface LyricCheckItem {
  /** fixed 形近字按参照改了 · filled 补上漏读的字 · variant 版本用字不同（他/祂…，只报）· mismatch 字不同且不像（只报）·
   *  missingNote 参照多出字、谱上没有可落的音 · extraChar 识别多出参照没有的字 · slurSuspect 一字多音却没认出弧 ·
   *  repeatSuspect 按演唱顺序反而对不上（反复/房号/跳转可能认错）· noMatch 整首词对不上题（不做任何改动） */
  kind: "fixed" | "filled" | "variant" | "mismatch" | "missingNote" | "extraChar" | "slurSuspect" | "repeatSuspect" | "noMatch";
  row?: number;
  verse?: number;
  note?: number;
  bar?: number;
  /** 谱面（识别）字 */
  ocr?: string;
  /** 参照字 */
  ref?: string;
  /** 参照里所在的那一句，供人对照 */
  context?: string;
  bbox?: Rect;
  /** 该字自己的源图框（音符框下方那个字；补字没有） */
  charBox?: Rect;
  /** 参照字在 OCR 候选里的名次（0 基）与得分、首选得分：选字门槛看的就是 score / top */
  cand?: { rank: number; score: number; top: number };
  /** 已改/已补但可疑、建议人工复查的原因（识别本来读得很有把握、歌词文本自相矛盾……）；不可疑为空 */
  review?: string;
  detail?: string;
}

export interface LyricCheck {
  /** 按哪种顺序对上的：演唱顺序展开（反复写全）还是谱面印的顺序 */
  order: "expanded" | "printed";
  refChars: number;
  ocrChars: number;
  /** 识别字里与参照同字的个数（按演唱顺序，同一字唱几遍记几遍） */
  matched: number;
  items: LyricCheckItem[];
  /** 参照里整段没对上的字区间 [起, 止)（参照多写的段、谱面没印的段） */
  unmatchedRef: { from: number; to: number; text: string }[];
}

/** 编辑器文本里的一段字符区间（点选定位用）。 */
export interface JpwRange {
  from: number;
  to: number;
}

/** 识别产物文本里「识别对象 → 代码区间」的映射，供识别模式点选定位（名字沿用最早的 `.jpwabc` 那一路）。
 *  noteRanges/lyricRanges 均按 **Chord 序**（== flatten(RecognizedScore.rows[].nums) 序）。 */
export interface JpwMeta {
  noteRanges: JpwRange[]; // 第 i 个音符 token（数字+修饰段，不含前后括号/空格）
  lyricRanges: Array<Map<number, JpwRange>>; // 平行于 noteRanges：第 i 音符各 verse(0基) 的音节区间
  titleRange?: JpwRange; // 标题值
  authorRanges: Array<{ text: string; range: JpwRange }>; // 作者行里每个作者条目
}

/** 擦小节线后接回来的弧（compsurgery.ts::untangleBridged，id 落在这一段）：确定是弧——归类后不进数字核，
 *  当弧候选时底边门放宽（弧端垂到音符头顶以下，框被拉高，扁度、墨量、底边这几道门都可能漏）。 */
export const REJOINED_ARC_ID = 6_000_000;
export const isRejoinedArc = (k: { id: number }): boolean => k.id >= REJOINED_ARC_ID && k.id < REJOINED_ARC_ID + 1_000_000;
