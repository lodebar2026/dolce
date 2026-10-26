// 样式表对外的名字 → 各把尺子的内部字段（`jianpu` 简谱尺子 `JianpuStyle`、`mixed` 混排、`book` 成书）。
//
// `.ss` 里只见**逻辑键**（kebab-case，按谱面内容分），`JianpuStyle` / `MixedOptions`
// 的字段名（`vertical.slurGap`、`lineWidths.stem`、`musicppJpTimeSig`…）不外露：
//
//   `@jianpu` = 简谱内容（各模式通用）：纯简谱落 `JianpuStyle`，混排落 `MixedOptions` 的简谱层字段
//   `@staff`  = 五线谱内容：只在 `mode: staff / mixed` 有效，落 `MixedOptions`
//
// 模式差异由 `@media (mode: …)` 限定，不靠「写进哪个块」。字体不在这两张表里——
// 字体走角色声明（`note { font: hei }`），角色 → 字体字段的对照是 `ROLE_FONTS`。
//
// 表里缺一边 = 那个模式不支持这个键，解析期就报错（`ss.ts`），不静默忽略。
import type { StyleRole } from "./sheet";

/** 值的种类：长度（收 em/sp/裸数）、纯数（比例、层数）、开关、词（枚举值）。 */
export type KeyKind = "len" | "num" | "bool" | "word";

export interface KeyDef {
  kind: KeyKind;
  /** `JianpuStyle`（engrave/jianpustyle.ts）上的路径（`stroke.beam`…）；缺 = 纯简谱那几档不支持。 */
  jianpu?: string;
  /** `MixedOptions` 上的字段名（可带一级子路径，如 `lineWidths.stem`）；缺 = 混排/五线谱不支持。 */
  mixed?: string;
  /** 成书 `BookStyle` 上的路径（`metrics.systemGapEm`、`layout.verseNumbers`…）；缺 = 成书不读。
   *  字段名以 `Em` 结尾的，样式表里**必须**写 `em` 单位（基准是字号，不是墨迹高），数值原样存进字段（不乘字号，浮点逐位不变）；
   *  其余长度写裸数（pt）。成书这一路由 `style/bookss.ts` 读。 */
  book?: string;
  /** 解析出的长度再乘这个数才落进 `jianpu` 那一列（样式表与尺子口径不同的：弧高写弧顶、尺子存控制点；反复点写直径、尺子存半径）。 */
  jianpuScale?: number;
  /** 不支持的那一侧的说法，进报错信息。 */
  note?: string;
}

/** 角色 → 两把尺子上的字体字段。`chord` 在混排是族名串（`wordFont`），不是 `Font`。 */
export const ROLE_FONTS: Partial<Record<StyleRole, { jianpu?: "note" | "lyric" | "smufl"; mixed?: string; mixedFamilyOnly?: boolean }>> = {
  note: { jianpu: "note", mixed: "jianpuFont" },
  lyric: { jianpu: "lyric" }, // 混排歌词字体由 MusicXML <defaults> 给
  smufl: { jianpu: "smufl", mixed: "musicFont" },
  chord: { mixed: "wordFont", mixedFamilyOnly: true },
};

/** `@jianpu`：简谱内容。
 *  成书一列（`book`）里 `em` 的基准是音符字号，只有 `lyric-gap` / `slur-thickness` / `barline` /
 *  `final-barline` 按歌词字号——`style/book.ts::bookJianpuStyle` 原来就是这么乘的。 */
export const JIANPU_KEYS: Record<string, KeyDef> = {
  "note-bold": { kind: "bool", jianpu: "look.noteBold", note: "混排的简谱数字不单独加粗" },
  "beam-width": { kind: "len", jianpu: "stroke.beam", mixed: "lineWidths.jpBeam" },
  // 数字上下那一摞（八度点、减时线、低音点）墨迹到墨迹的空 ÷ 数字墨迹高（engrave/stack.ts）
  "stack-gap": { kind: "num", jianpu: "vertical.stackGap", mixed: "stackGap", book: "metrics.stackGap" },
  "slur-gap": { kind: "len", jianpu: "vertical.slurGap", book: "metrics.stackGapEm", note: "弧离叠层顶的空，混排与原样文档各按自己的弧算" },
  // 谱行之间：`system-gap` 是末行歌词基线到下一组音符基线（原样文档）；`system-spread` 是页内均分各行时行距的上限
  //（旧简谱引擎；成书拿原书量到的行间净距当它）
  "system-gap": { kind: "len", jianpu: "vertical.systemGap" },
  "system-spread": { kind: "len", jianpu: "vertical.systemSpread", book: "metrics.systemGapEm" },
  "note-step": { kind: "len", book: "metrics.noteStepEm", note: "音符步距只有成书断句用" },
  // 歌词：`lyric-gap` 是相邻两个字之间的最小横向间隙；`lyric-baseline` 是音符基线到第一行歌词基线
  "lyric-gap": { kind: "len", jianpu: "spacing.lyricGap", book: "metrics.lyricGapEm" },
  "lyric-baseline": { kind: "len", jianpu: "vertical.lyricBaseline" },
  "lyric-stack": { kind: "len", jianpu: "vertical.lyricStack", book: "metrics.lyricToLyricEm" },
  "chord-gap": { kind: "len", jianpu: "vertical.chordGap", book: "metrics.chordToNoteEm" },
  // 歌词标点挤压：halfwidth（半身式）/ clreq（全身式 + 上下文挤压）/ none
  "lrc-punct-compress": { kind: "word", jianpu: "look.punctCompress", mixed: "punctCompress" },
  "chord-plain": { kind: "bool", jianpu: "look.chordPlain", mixed: "chordPlain", book: "metrics.chordPlain" },
  // 调号、转调、和弦根音/低音的升降号写在字母前（before）还是后（after）；不写 = 各自原来的写法
  "accidental-side": { kind: "word", jianpu: "look.accidentalSide", mixed: "accidentalSide", book: "metrics.accidentalSide" },
  // 临时记号的样子：csym（照混排）/ classic（原先旧简谱引擎的，成书缺省）
  "accidental-style": { kind: "word", jianpu: "look.accidentalStyle", mixed: "accidentalStyle", book: "metrics.accidentalStyle" },
  // csym 临时记号的大小倍数（1 = 照混排）
  "accidental-scale": { kind: "num", jianpu: "look.accidentalScale", mixed: "accidentalScale", note: "成书照原书用 classic，不读这个" },
  "bracket-width": { kind: "len", jianpu: "stroke.bracket", book: "metrics.bracketWidth" },
  "bracket-foot": { kind: "len", jianpu: "vertical.bracketFoot", book: "metrics.bracketFootEm" },
  "tuplet-style": { kind: "word", jianpu: "look.tupletStyle", note: "取 bracket（括线）/ arc（两段弧）；成书与混排不支持" },
  "repeat-dot-diameter": { kind: "len", jianpu: "dot.repeat", jianpuScale: 0.5, book: "metrics.repeatDotDiam" },
  // 八度点与附点的半径（不写 = 按数字字体里 `.` 的墨迹高折半；附点不写 = 同八度点）
  "dot-radius": { kind: "len", jianpu: "dot.octave" },
  "aug-dot-radius": { kind: "len", jianpu: "dot.aug" },
  "slur-thickness": { kind: "len", jianpu: "stroke.slur", book: "metrics.slurThicknessEm" },
  "slur-outline": { kind: "len", jianpu: "stroke.slurOutline" },
  "slur-arc": { kind: "len", book: "metrics.slurArcEm", note: "弧高目标只有成书反算缩放用" },
  // 弧顶高的上下限（样式表写**弧顶**；尺子存贝塞尔控制点高，弧顶 ≈ 0.75 × 它）
  "slur-max-arc": { kind: "len", jianpu: "arc.maxHeight", jianpuScale: 1 / 0.75, book: "metrics.slurMaxArcEm" },
  "slur-min-arc": { kind: "len", jianpu: "arc.minHeight", jianpuScale: 1 / 0.75, book: "metrics.slurMinArcEm" },
  "slur-flat-span": { kind: "num", book: "metrics.slurFlatSpanSteps", note: "纯简谱的扁平阈值是物理宽度（slurFlatSpan）" },
  "slur-flat-notes": { kind: "num", jianpu: "arc.flatNotes", book: "metrics.slurFlatNotes" },
  "slur-flat-ratio": { kind: "num", jianpu: "arc.flatRatio", book: "metrics.slurFlatRatio" },
  barline: { kind: "len", jianpu: "stroke.barline", book: "metrics.barlineWidthEm" },
  "final-barline": { kind: "len", jianpu: "stroke.finalBarline", book: "metrics.finalBarlineWidthEm" },
  "hairpin-width": { kind: "len", jianpu: "stroke.hairpin" },
  // 拍号（含页眉、转拍）的分数线
  "time-sig-rule": { kind: "len", jianpu: "stroke.timeSigRule" },
  "verse-numbers": { kind: "word", jianpu: "look.verseNumbers", mixed: "verseNumbers", book: "layout.verseNumbers" },
  "max-horizontal-scale": { kind: "num", jianpu: "spacing.maxHorizontalScale", book: "layout.maxHorizontalScale" },
  "grace-scale": { kind: "num", jianpu: "size.grace", mixed: "jpGraceScale" },
  "show-key-change": { kind: "bool", mixed: "showKeyChangeJp", note: "纯简谱一定画调号" },
  "key-uses-full-font": { kind: "bool", mixed: "jpKeyJianpuFont", note: "纯简谱没有缩小的简谱层" },
  "legacy-time-sig": { kind: "bool", mixed: "musicppJpTimeSig", note: "旧版拍号笔位只在混排有" },
  "legacy-hwid-glyphs": { kind: "bool", mixed: "musicppHwidGlyphs", note: "同上" },
  "chinese-hyphen": { kind: "bool", mixed: "chineseHyphen", note: "纯简谱不画中文连字符" },
  // 多声部：同组相邻声部之间（歌词块末行 → 下一声部音符基线）
  "voice-gap": { kind: "len", jianpu: "vertical.voiceGap" },
  "barline-height": { kind: "len", jianpu: "vertical.barlineHeight" },
  "double-barline-gap": { kind: "len", jianpu: "stroke.doubleBarlineGap" },
};

/** `@staff`：五线谱内容。纯简谱那几档整块不适用（简谱的小节线宽写在 `@jianpu` 的 `barline`）。 */
export const STAFF_KEYS: Record<string, KeyDef> = {
  "staff-height": { kind: "len", mixed: "mixStaffHeight" },
  "staff-dist": { kind: "len", mixed: "mixStaffDist" },
  "barline-dist": { kind: "len", mixed: "barlineDist" },
  "slur-stem-dy": { kind: "len", mixed: "slurStemDy" },
  "harmony-size": { kind: "len", mixed: "harmonySize" },
  "harmony-y-pos": { kind: "len", mixed: "harmonyYPos" },
  "cue-size": { kind: "num", mixed: "cueSize" },
  "hide-bar-number": { kind: "bool", mixed: "hideBarNumber" },
  "initial-key-time": { kind: "bool", mixed: "initialKeyTime" },
  "melody-only": { kind: "bool", mixed: "melodyOnly" },
  "text-line-height-by-size": { kind: "bool", mixed: "textLineHeightBySize" },
  // 线宽：样式表里是一级键，内部才是 `lineWidths.*`
  "staff-line": { kind: "len", mixed: "lineWidths.staff" },
  leger: { kind: "len", mixed: "lineWidths.leger" },
  stem: { kind: "len", mixed: "lineWidths.stem" },
  beam: { kind: "len", mixed: "lineWidths.beam" },
  barline: { kind: "len", mixed: "lineWidths.lightBarline" },
  "final-barline": { kind: "len", mixed: "lineWidths.heavyBarline" },
};

/** `@break`：断句（行怎么断）。**与谱式无关**——现在只有成书读，五线谱以后也用这一块。 */
export const BREAK_KEYS: Record<string, KeyDef> = {
  enable: { kind: "bool", book: "layout.phrase" },
  "lines-per-page": { kind: "num", book: "layout.linesPerPage" },
  "target-measures": { kind: "num", book: "layout.phraseTargetMeas" },
  "length-weight": { kind: "num", book: "layout.phraseLenWeight" },
  "break-weight": { kind: "num", book: "layout.phraseBreakWeight" },
  "mid-break": { kind: "bool", book: "layout.phraseMidBreak" },
  "merge-short": { kind: "bool", book: "layout.phraseMergeShort" },
  "even-weight": { kind: "num", book: "layout.phraseEvenWeight" },
  "tail-weight": { kind: "num", book: "layout.phraseTailWeight" },
  "content-only": { kind: "bool", book: "layout.phraseContentOnly" },
  "parallel-weight": { kind: "num", book: "layout.phraseParallelWeight" },
  "tail-long-weight": { kind: "num", book: "layout.phraseTailLongWeight" },
  "more-rows-slack": { kind: "num", book: "layout.phraseMoreRowsSlack" },
  "fit-slack": { kind: "num", book: "layout.phraseFitSlack" },
};

/** 块名 → 键表。 */
export function keysOfBlock(block: "jianpu" | "staff" | "break"): Record<string, KeyDef> {
  return block === "jianpu" ? JIANPU_KEYS : block === "staff" ? STAFF_KEYS : BREAK_KEYS;
}

/** `@flow` 的键。`song-start` 归混排歌本（`pdflayout/songbook.ts`），其余是成书的起排位置（→ `BookStyle.titleBlock`）。 */
export const FLOW_KEYS: Record<string, string | null> = {
  "song-start": null,
  "number-baseline": "numberBaseline",
  "first-system-top": "firstSystemTop",
  "cont-system-top": "contSystemTop",
  "mid-start-gap": "midStartGap",
  "footer-baseline": "footerBaseline",
};

/** `@toc`：成书目录与索引页的几何（→ `BookStyle.toc`，排法在 `pdflayout/bookparts.ts::tocPages`）。
 *  混排歌本的目录走模板区域 `@template toc`，不读这一块。`leader` 是字符串，其余是裸数（pt）。 */
export const TOC_KEYS: Record<string, string> = {
  "title-baseline": "titleBaseline",
  "heading-gap-above": "headingGapAbove",
  "heading-gap-below": "headingGapBelow",
  leader: "leader",
  "entry-line-height": "lineGap",
  "entry-first-baseline": "firstBaseline",
  "left-edge": "left",
  "right-edge": "right",
  "index-columns": "indexColumns",
  "index-line-height": "indexLineGap",
  "index-first-baseline": "indexFirstBaseline",
};
