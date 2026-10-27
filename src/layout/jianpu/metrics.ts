// 简谱引擎（文本谱、MusicXML、多声部 123/ABC 的原样档）的栅格与谱面自带的版面指令。
//
// 样式值只有一把尺子 `JianpuStyle`（`style/jianpu.ts::jianpuStyleOf` 折算，与旧简谱引擎同一份）；
// 这里只剩原版（番茄）量来的那套栅格，按音符字号等比缩放：
//   横向步进（实测在未拉伸的行上逐点吻合，数字字号 25 时）：
//     同一拍内、前后都带减时线      → 25
//     其余音符之间                  → 37.5
//     音符与小节线之间（两侧）      → 35
//     每个附点额外                  → +12.5
//   行内算完自然宽度后再整体拉伸/压缩到版心宽度（两端对齐）。
// 子计划 3 改成按拍位归列、列宽按内容定之后，步进退役。

import { Font } from "../../pagetree/font";
import { arcHeight, type SlurStyle } from "../../engrave/arc";
import type { GraceMetrics, GraceNote } from "../../engrave/grace";
import { highDotY, lowDotY, type StackStyle } from "../../engrave/stack";
import type { NoteElement } from "../../jianpu/ast";
import type { JianpuStyle } from "../../engrave/jianpustyle";

/**
 * 简谱引擎的**栅格**：贴着音符排的步进、记号槽位、页头基线，与版面。单位 pt。
 * 样式值（字号、字体、笔画、点、竖向间距、写法）**不在这里**，一律从 `style`（尺子 `JianpuStyle`）取；
 * 栅格是照番茄原版量的一套（数字字号 25 时的值，`GRID_NOTE_SIZE`），按 `style.size.note` 等比缩放（`gridOf`）。
 * 子计划 4 换成上方带堆叠后，槽位与页头基线退役。
 */
export interface JianpuMetrics {
  page: {
    width: number;
    height: number;
    margin: { top: number; right: number; bottom: number; left: number };
    /** 连续长图：不按纸张分页，整份谱排成一张，页高随内容增长 */
    longImage: boolean;
    /** 版心第一行音符基线相对上边距的偏移 */
    firstSystemTop: number;
  };
  /** 音符栅格：随音符字号等比。 */
  note: {
    /** 横向步进：其余音符之间 / 同一拍内前后都带减时线 / 音符与小节线之间（两侧）/ 每个附点额外 */
    noteStep: number;
    beamedNoteStep: number;
    barlineSpace: number;
    augDotStep: number;
    /** 减时线左右各伸出锚点多少 */
    beamHalfSpan: number;
    /** 源码里 `+` 抬高级别每级上移多少（记号先按级预抬再进上方带堆叠，place/band.ts） */
    levelStep: number;
  };
  /** 页头逐项落位（基线 y）。 */
  head: {
    titleBaseline: number;
    /** 首个署名行基线，其后每行下移 creditLineHeight */
    creditBaseline: number;
    creditLineHeight: number;
    keyMeterBaseline: number;
  };
}

/** 定稿栅格：挂上尺子 `style`（点半径已按字形量好），再补按数字字体实测的派生量。 */
export interface JianpuGrid extends JianpuMetrics {
  style: JianpuStyle;
  ink: {
    /** 数字「1」的**墨迹高**：纵向栅格（减时线、八度点、记号槽位）是贴着墨迹排的，拿它当内部单位。 */
    noteHeight: number;
    /** 数字上下那一摞的取尺（engrave/stack.ts），空已乘好墨迹高。 */
    stack: StackStyle;
  };
}

/** 栅格量版时的数字字号：原版量到数字墨迹高 17.9，苹方粗体「1」墨迹占字号 0.714，折成字号 25.07，落整数。 */
const GRID_NOTE_SIZE = 25;

/** 原版（番茄）那套栅格，数字字号 `GRID_NOTE_SIZE` 时的值。 */
const GRID = {
  firstSystemTop: 156,
  note: {
    noteStep: 37.5,
    beamedNoteStep: 25,
    barlineSpace: 35,
    augDotStep: 12.5,
    beamHalfSpan: 6,
    levelStep: 6,
  },
  head: { titleBaseline: 110, creditBaseline: 175, creditLineHeight: 21, keyMeterBaseline: 176 },
} as const;

/** 纸：宽高（pt；长图的高只是占位）与是不是长图。 */
export interface GridPage {
  width: number;
  height: number;
  continuous: boolean;
}

/**
 * 尺子 + 纸 → 定稿栅格。栅格按 `style.size.note / GRID_NOTE_SIZE` 等比缩放；
 * 点半径为 0 的按数字字体里 `.` 的墨迹高折半（附点、反复点为 0 = 同八度点，与旧简谱引擎同一口径）；
 * 数字按墨迹竖直居中于基线画（墨迹顶 −noteHeight/2、底 +noteHeight/2），八度点与减时线的落点
 * 走公共那一份（engrave/stack.ts：墨迹到墨迹等距，空 = `vertical.stackGap` × 墨迹高）。
 */
export function gridOf(src: JianpuStyle, page: GridPage): JianpuGrid {
  const style: JianpuStyle = { ...src, dot: { ...src.dot } };
  const noteFont = new Font(style.font.note.family, style.size.note, style.look.noteBold);
  if (!(style.dot.octave > 0)) {
    const b = noteFont.charBound(".");
    style.dot.octave = (b.bottom - b.top) / 2;
  }
  if (!(style.dot.aug > 0)) style.dot.aug = style.dot.octave;
  if (!(style.dot.repeat > 0)) style.dot.repeat = style.dot.octave;
  const k = style.size.note / GRID_NOTE_SIZE;
  const scaled = <T extends Record<string, number>>(g: T): { -readonly [K in keyof T]: number } =>
    Object.fromEntries(Object.entries(g).map(([key, v]) => [key, v * k])) as { -readonly [K in keyof T]: number };
  const head = scaled(GRID.head);
  // 署名行距跟着署名字号走（出厂 21 对 16 号字）：谱里给的署名字号大了，行与行就叠在一起
  head.creditLineHeight = Math.max(head.creditLineHeight, style.header.credit.size * (21 / 16));
  const one = new Font(style.font.note.family, 100, style.look.noteBold).charBound("1");
  const noteHeight = style.size.note * ((Math.abs(one.bottom - one.top) || 71) / 100);
  return {
    page: {
      width: page.width,
      height: page.height,
      margin: { ...style.page.margin },
      longImage: page.continuous,
      firstSystemTop: GRID.firstSystemTop * k,
    },
    note: scaled(GRID.note),
    head,
    style,
    ink: {
      noteHeight,
      stack: { gap: style.vertical.stackGap * noteHeight, dotRadius: style.dot.octave, beamWidth: style.stroke.beam },
    },
  };
}

/** 小节线上下缘（相对数字墨迹中线，即本引擎的 baseline）：与旧简谱引擎同一口径——上缘在数字**基线**上 3/4 小节线高、
 *  下缘在下 1/4（缺省 4/3 字号即 −1 em / +1/3 em）。行内拍号竖向居中于它。 */
export function barlineSpan(m: JianpuGrid): { top: number; bottom: number } {
  const base = m.ink.noteHeight / 2;
  const h = m.style.vertical.barlineHeight;
  return { top: base - h * 0.75, bottom: base + h * 0.25 };
}

/** 转调标签（「转1=D」）的字号：同和弦；不排和弦的档（展开档 `chord` = 0）取歌词字号的 0.6（同旧简谱引擎 `KeySig`）。 */
export function keyLabelSize(m: JianpuGrid): number {
  return m.style.size.chord > 0 ? m.style.size.chord : m.style.size.lyric * 0.6;
}

/** 括线（房号、连音括线）的线宽：尺子给了 `bracket` 就用它，否则同小节线（同旧简谱引擎 `Line.drawEnding`）。两者同一个值（用户定）。 */
export function bracketLineWidth(m: JianpuGrid): number {
  return m.style.stroke.bracket > 0 ? m.style.stroke.bracket : m.style.stroke.barline;
}

/** 音符堆叠与挂在它上面的记号（延长记号等）之间让的空：就是叠层那道空。 */
export function noteMarkGap(m: JianpuGrid): number {
  return m.ink.stack.gap;
}

/** 版心宽度。 */
export function contentWidth(m: JianpuMetrics): number {
  return m.page.width - m.page.margin.left - m.page.margin.right;
}


// ---------------- 谱面自带的版面指令 ----------------

/**
 * `FontSize: T2=65%;TL=80%;TR=80%` —— 各类文字相对默认字号的百分比。
 * 真实谱里分隔符并不规范（`TR=80%T2=90%` 可以不带分号），所以按「键=数字%」全局匹配，
 * 不依赖分隔符。键不区分大小写。
 */
export function parseFontSizes(lines: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*=\s*(\d+(?:\.\d+)?)\s*%/g)) {
      const pct = Number(m[2]);
      if (pct > 0 && pct < 1000) out[m[1]!.toLowerCase()] = pct / 100;
    }
  }
  return out;
}

/** `Margin: left=100;top=30;right=100` —— pt。 */
export function parseMargins(lines: readonly string[]): Partial<Record<"left" | "right" | "top" | "bottom", number>> {
  const out: Partial<Record<"left" | "right" | "top" | "bottom", number>> = {};
  for (const line of lines) {
    for (const m of line.matchAll(/\b(left|right|top|bottom)\s*=\s*(-?\d+(?:\.\d+)?)/gi)) {
      const v = Number(m[2]);
      if (Number.isFinite(v) && v >= 0 && v <= 400) {
        out[m[1]!.toLowerCase() as "left"] = v;
      }
    }
  }
  return out;
}

/**
 * 谱面自带的 `FontSize:` / `Margin:`：叠在尺子上的**乘法层**（百分比），返回新的一份、不改入参。
 *
 * `all` 乘全部文字字号（真实语料里用得最多）；`c` 乘歌词，歌词的两个行距跟着乘——字大了行距不跟，
 * 放大后就互相压住；`q` 乘音符数字与贴着它画的那几样（点、减时线、小节线高、弧高），栅格随音符字号走（`gridOf`）。
 * 边距 `keepMargins`（面板上给了边距，用户说了算）时不动。
 */
export function applyDocOptions(
  base: JianpuStyle,
  fontSizes: readonly string[],
  margins: readonly string[],
  keepMargins: boolean,
): JianpuStyle {
  const fs = parseFontSizes(fontSizes);
  const mg = keepMargins ? {} : parseMargins(margins);
  if (Object.keys(fs).length === 0 && Object.keys(mg).length === 0) return base;
  const st = structuredClone(base);
  const all = fs.all ?? 1;
  const k = (key: string): number => (fs[key] ?? 1) * all;

  st.header.title.size *= k("t");
  st.header.subtitle.size *= k("t2");
  st.header.scripture.size *= k("t2");
  st.header.credit.size *= k("z");
  st.size.header *= (fs.tl ?? fs.tr ?? 1) * all;
  for (const f of ["keyMeter", "chord", "ending", "sectionWord", "words"] as const) st.size[f] *= all;
  st.size.verseNum *= k("zs");
  const lyricK = k("c");
  st.size.lyric *= lyricK;
  st.vertical.lyricBaseline *= lyricK;
  st.vertical.lyricStack *= lyricK;

  const noteK = fs.q ?? 1;
  if (noteK !== 1) {
    st.size.note *= noteK;
    for (const f of ["octave", "aug", "repeat"] as const) st.dot[f] *= noteK;
    st.stroke.beam *= noteK;
    st.vertical.barlineHeight *= noteK;
    st.vertical.slurGap *= noteK;
    st.arc.maxHeight *= noteK;
    st.arc.minHeight *= noteK;
    if (st.arc.flatSpan > 0) st.arc.flatSpan *= noteK;
  }

  for (const side of ["left", "right", "top", "bottom"] as const) if (mg[side] !== undefined) st.page.margin[side] = mg[side]!;
  return st;
}

/**
 * 原样文档布局的弧线样式：与旧简谱引擎同一口径（`layout.ts::slurStyleOf`）。绘制与纵向预留**共用这一个来源**。
 */
export function jianpuSlurStyle(m: JianpuGrid, color: number): SlurStyle {
  const st = m.style;
  return {
    thickness: st.stroke.slur,
    color,
    heightScale: st.arc.heightScale,
    outlineWidth: st.stroke.slurOutline,
    maxHeight: st.arc.maxHeight,
    minHeight: st.arc.minHeight,
    flatSpan: st.arc.flatSpan < 0 ? 0 : st.arc.flatSpan || st.size.note * 5,
    flatRatio: st.arc.flatRatio,
    flatLineWidth: st.stroke.slurFlat,
  };
}

/** 弧线实际占的头顶高度（纵向预留用），与 jianpuSlurStyle 同源。 */
export function jianpuSlurRise(m: JianpuGrid): number {
  return arcHeight(Infinity, jianpuSlurStyle(m, 0)) * 0.75;
}

/** 原样文档布局折算给公共倚音几何的度量（见 `engrave/grace.ts`）。
 *  painter 画倚音、layout 给倚音留位，用的必须是同一份。 */
export function jianpuGraceMetrics(m: JianpuGrid): GraceMetrics {
  const st = m.style;
  return {
    ink: m.ink.noteHeight,
    scale: st.size.grace,
    octaveUpY: highDotY(-m.ink.noteHeight / 2, 0, m.ink.stack),
    octaveDownY: lowDotY(m.ink.noteHeight / 2, 0, 0, m.ink.stack),
    octaveDotGap: m.ink.stack.gap + 2 * st.dot.octave,
    octaveDotRadius: st.dot.octave,
    underlineGap: m.ink.stack.gap + st.stroke.beam,
    stackGap: st.vertical.stackGap,
  };
}

/** fanqie 的音符元素 → 公共倚音几何要的那几个字段。 */
export function jianpuGraceNotes(els: readonly NoteElement[]): GraceNote[] {
  return els.map((gn) => ({
    digit: String(gn.pitch),
    octave: gn.octave,
    duration: gn.duration,
    ...(gn.accidental ? { alter: gn.accidental } : {}),
  }));
}
