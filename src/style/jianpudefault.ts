// 简谱尺子的出厂值：`style/jianpu.ts`（样式表折算）与 `style/book.ts`（成书折算）共同的起点。
// 单独成文件是为了让那两份互不依赖（成书折算要出厂值，样式表折算遇到 `sheet.book` 又转去成书折算）。
import type { JianpuStyle } from "../engrave/jianpustyle";
import { STACK_GAP_DEFAULT } from "../engrave/stack";

/** 系统中文字体栈（原版用苹方-简 / 微软雅黑，webview 里交给 CSS 字体栈）。 */
const CJK = "PingFang SC, Microsoft YaHei, sans-serif";

/**
 * 出厂那一份：编辑器与 OMR 那两条路原来的观感（没有样式表的帮助示例也走它）。
 * 绝对量（小节线 2、弧厚 6…）是按 fontSize≈28 调出来的 musicpp 口径，**默认值必须原样保持**。
 */
export function defaultJianpuStyle(fontSize: number): JianpuStyle {
  const face = (family: string) => ({ family, bold: false, italic: false });
  return {
    font: { note: face(CJK), lyric: face(CJK), text: face(CJK), smufl: face("Bravura") },
    header: { title: { size: 48 }, subtitle: { size: 36 }, credit: { size: 36 }, scripture: { size: 36 } },
    size: {
      note: fontSize,
      lyric: fontSize,
      chord: 0,
      keyMeter: fontSize,
      verseNum: fontSize,
      ending: 0,
      sectionWord: 0,
      words: fontSize,
      header: fontSize,
      grace: 0.59,
      cue: 0.72,
    },
    stroke: {
      barline: 2, // musicpp lineWidths.lightBarline / heavyBarline（pptutil.cpp:139）
      finalBarline: 3.5,
      beam: 1.5, // musicpp lineWidths.jpBeam (pptutil.cpp:138)
      slur: 6, // musicpp render.cpp:1076 (`lw0 = 6/cos`)，按 fontSize≈28 调
      slurOutline: 0.7,
      slurFlat: 0,
      hairpin: 0,
      timeSigRule: 0,
      bracket: 0,
      doubleBarlineGap: 5,
    },
    dot: { octave: 0, aug: 0, repeat: 0 },
    vertical: {
      stackGap: STACK_GAP_DEFAULT,
      slurGap: fontSize / 6,
      lyricBaseline: 0,
      lyricStack: 0,
      systemGap: 0,
      systemSpread: fontSize * 0.75,
      staffDist: 0,
      voiceGap: 0,
      chordGap: 0,
      bracketFoot: 0,
      staffTop: 0,
      staffBottom: 0,
      barlineHeight: (fontSize * 4) / 3,
    },
    arc: { heightScale: 1, maxHeight: 18, minHeight: 10, flatSpan: 0, flatNotes: 0, flatRatio: 0 },
    spacing: { lyricGap: 0, maxHorizontalScale: 2.0 },
    look: {
      noteBold: true,
      chordPlain: false,
      accidentalStyle: "csym",
      accidentalScale: 1,
      punctCompress: "halfwidth",
      tupletStyle: "bracket",
      verseNumbers: "always",
      verseNumberAutoMin: 3,
      timeSigDigitRatio: 0,
      timeSigRuleLenRatio: 0,
    },
    page: { color: 0xff000000, margin: { top: fontSize * 1.5, right: 50, bottom: fontSize * 3, left: 50 } },
  };
}
