// 简谱尺子的折算：computed `StyleSheet` → `JianpuStyle`（engrave/jianpustyle.ts）。**全仓只此一处**（成书另由 `style/book.ts` 出同一类型）。
//
// 顺序：出厂（`defaultJianpuStyle`）→ 前景色 / 标题 / 词曲字号 → 预设（`jianpu.preset`）→ 角色字体 → `jianpu.overrides`。
// 预设里的公式**原样保留**（常量改存比例会出浮点尾差，见 sheet.ts 头注释）。
//
// 「排版方式」那几个开关（长图、标题排在首页顶上、整首重断行、页面装饰）不是尺寸，不进 `JianpuStyle`，
// 由 `jianpuFlagsOf` 另给。
import type { JianpuStyle } from "../engrave/jianpustyle";
import { defaultJianpuStyle } from "./jianpudefault";
import { bookJianpuStyle } from "./book";
import { familyOfRole } from "./fonts";
import { JIANPU_KEYS, ROLE_FONTS, type KeyDef } from "./keys";
import type { StyleRole, StyleSheet } from "./sheet";
import { PPTX_PAGE } from "./themes";
import { pageMargins } from "./paper";
import { headerFontsOf } from "./header";
import { resolveLength } from "./units";

/** 标题/词曲字号 ÷ 音符字号（那两档不单独设标题与词曲，字号一改整块跟着缩放）。
 *  展开档取投影片出厂那三个数的比（48/28、36/28）；原样档照 500 首成书实测（标题 22.03、署名 10.98、音符 12.08）。 */
const HEAD_RATIOS = {
  pptx: { title: PPTX_PAGE.titleSize / PPTX_PAGE.fontSize, credit: PPTX_PAGE.creditSize / PPTX_PAGE.fontSize },
  original: { title: 22.03 / 12.08, credit: 10.98 / 12.08 },
} as const;

/** 角色字号（pt）。`note` 是 em 的基准、只认 pt；别的角色写 em 就是音符字号的几倍，折出来落到整数或 .5（样式值少有效位）。 */
function rolePt(sheet: StyleSheet, role: StyleRole, notePt = NaN): number | undefined {
  const v = sheet.roles[role]?.size;
  if (v === undefined) return undefined;
  const pt = resolveLength(v, { em: notePt, sp: NaN });
  if (pt === null || !Number.isFinite(pt) || pt <= 0) return undefined;
  return typeof v === "string" && v.endsWith("em") ? Math.round(pt * 2) / 2 : pt;
}

/** 排版器的构造字号。成书取歌词那一档，其余取音符字号。 */
export function jianpuFontSize(sheet: StyleSheet): number {
  if (sheet.jianpu.preset === "book" && sheet.book) return sheet.book.roles.lyric.size;
  return rolePt(sheet, "note") ?? PPTX_PAGE.fontSize;
}

function headRatios(sheet: StyleSheet): { title: number; credit: number } {
  return sheet.jianpu.preset === "original" ? HEAD_RATIOS.original : HEAD_RATIOS.pptx;
}

/** 字号标题、词曲的实际值：给了就用；原样档没给就按出厂比例派生。 */
export function jianpuSizes(sheet: StyleSheet): { fontSize: number; titleSize: number; creditSize: number } {
  const fontSize = jianpuFontSize(sheet);
  return {
    fontSize,
    titleSize: rolePt(sheet, "title", fontSize) ?? Math.round(fontSize * headRatios(sheet).title),
    creditSize: rolePt(sheet, "credit", fontSize) ?? Math.round(fontSize * headRatios(sheet).credit),
  };
}

export function jianpuStyleOf(sheet: StyleSheet): JianpuStyle {
  const preset = sheet.jianpu.preset ?? "default";
  let st: JianpuStyle;
  if (preset === "book") {
    if (!sheet.book) throw new Error("book 预设缺 BookStyle");
    st = bookJianpuStyle(sheet.book);
  } else {
    st = defaultJianpuStyle(jianpuFontSize(sheet));
    if (sheet.page.ink !== undefined) st.page.color = sheet.page.ink;
    if (preset !== "default") {
      const s = jianpuSizes(sheet);
      st.header.title.size = s.titleSize;
      st.header.credit.size = s.creditSize;
    }
    // 副标题与经文没单独给字号的跟词曲走
    st.header.subtitle.size = st.header.scripture.size = st.header.credit.size;
    const hf = headerFontsOf(sheet);
    for (const role of ["title", "subtitle", "credit", "scripture"] as const) {
      const f = hf[role];
      if (!f) continue;
      if (f.family !== undefined) st.header[role].family = f.family;
      if (f.bold !== undefined) st.header[role].bold = f.bold;
      // 标题与词曲的字号以上面那两个为准；副标题与经文的字号给了才用
      if (f.size !== undefined && (role === "subtitle" || role === "scripture")) st.header[role].size = f.size;
    }
    if (preset === "original") {
      // 原样档的出厂值都在样式表里（`themes.ts` 的 print 主题，照 500 首、em 口径）：这里只把角色字号落进尺子。
      // 面板或谱里给了边距就用给的；没给仍是字号派生的那套（`defaultJianpuStyle`）
      const mg = pageMargins(sheet.page);
      if (mg) st.page.margin = { top: mg[0], right: mg[1], bottom: mg[2], left: mg[3] };
      const em = st.size.note;
      const role = (r: StyleRole, fallback: number): number => rolePt(sheet, r, em) ?? fallback;
      st.size.lyric = role("lyric", st.size.lyric);
      st.size.verseNum = role("verseNum", st.size.verseNum);
      st.size.keyMeter = role("keyMeter", st.size.keyMeter);
      st.size.chord = role("chord", em * 0.6);
      // 房号（一房、二房的括线与数字）：原样档按原谱排一遍，房号要印出来（展开档逐遍展开、不画）。字号同三连音数字（`tuplet` 角色）
      st.size.ending = role("tuplet", em * 0.65);
      st.size.sectionWord = role("sectionWord", st.size.chord);
      // 页眉 TL/TR 与页脚
      st.size.header = role("header", st.size.header);
    } else if (preset === "pptx") applyPptxPreset(st);
  }
  applyFonts(st, sheet);
  applyOverrides(st, sheet);
  return st;
}

/** 角色 → 字体族与字重（`note` → 数字、`lyric` → 歌词、`smufl` → 记号）。**字号不动**。 */
function applyFonts(st: JianpuStyle, sheet: StyleSheet): void {
  const fonts = st.font as unknown as Record<string, JianpuStyle["font"]["note"]>;
  for (const [role, def] of Object.entries(ROLE_FONTS)) {
    const field = def.jianpu;
    if (!field) continue;
    const f = familyOfRole(sheet, role as StyleRole);
    if (!f) continue;
    const base = fonts[field]!;
    fonts[field] = { family: f.family || base.family, bold: f.bold || base.bold, italic: base.italic };
  }
}

/** `@jianpu` 的逻辑键 → `JianpuStyle` 的路径（`style/keys.ts` 的 `jianpu` 一列）。
 *  em = 音符字号，sp = 名义谱高 / 3（简谱的名义谱高是默认小节线跨度 4/3 字号，不随 `staffTop` 变）。 */
function applyOverrides(st: JianpuStyle, sheet: StyleSheet): void {
  const ov = sheet.jianpu.overrides;
  if (!ov) return;
  const em = st.size.note;
  const ctx = { em, sp: em / 3 };
  for (const [k, v] of Object.entries(ov)) {
    const def: KeyDef | undefined = JIANPU_KEYS[k];
    if (!def) {
      console.warn(`样式 @jianpu 的 ${k}：认不出的键，忽略`);
      continue;
    }
    if (!def.jianpu) {
      console.warn(`样式 @jianpu 的 ${k}：纯简谱不支持${def.note ? `（${def.note}）` : ""}，忽略`);
      continue;
    }
    const [group, field] = def.jianpu.split(".") as [keyof JianpuStyle, string];
    const rec = st[group] as unknown as Record<string, unknown>;
    if (def.kind === "bool") {
      if (typeof v === "boolean") rec[field] = v;
      else console.warn(`样式 @jianpu 的 ${k}：开关只收 true / false，${JSON.stringify(v)} 忽略`);
      continue;
    }
    if (def.kind === "word") {
      if (typeof v === "string") rec[field] = v;
      else console.warn(`样式 @jianpu 的 ${k}：要一个词，${JSON.stringify(v)} 忽略`);
      continue;
    }
    const n = resolveLength(v as never, ctx);
    if (n === null) console.warn(`样式 @jianpu 的 ${k}：认不出的长度 ${JSON.stringify(v)}，忽略`);
    else rec[field] = n * (def.jianpuScale ?? 1);
  }
}

// 「PPT 版面」档：投影/导出 .pptx 用的那一档，编辑器的**默认档**。
//
// 底子是 2026-08 那次排版重构**之前**的观感（下面 `2a8aa85` 那一段），
// 但已有几处**刻意背离**，都写在各自的赋值旁边：小节线的上下缘改用原样档那一份
// （老档矮三分之一，投影上看不出是小节线）、拍号比例跟着回默认、
// 附点/高音点/低音点三种点统一成同一个半径。回归在 `scripts/pptx-check.mjs`。
//
// 为什么要有这一档：`editor/pptx.ts` 只是序列化器——它把排版好的页面树 1:1 翻成 OOXML
// （1 排版单位 = 1pt），本身没有任何排版参数。于是谱面观感一改，导出的 .pptx 跟着改。
//
// 与「原样」档的另一处分工在 `editor/app.ts::_jianpuRequest`（按档取样式）：
// **展开档逐段展开**（一段歌词一遍谱、一屏一段），原样档 `lyricStack > 0`
// **按原谱排一遍**、多段歌词叠在同一条谱行下。
//
// 基准是 `2a8aa85`（「新增 MusicXML 导出」，即观感大改 `29ae9dd` 的父提交）。
// 不取更早的 `9abacb3`（PPTX 导出刚落地那次）是因为两者的**笔画与尺寸完全相同**
// （`git diff 9abacb3 2a8aa85 -- src/layout/` 只有 verse 索引、播放高亮、弱起装载、
// titleSize/creditSize 提成字段这些），而 `2a8aa85` 里已经带上了 `a6a6013` 对 pptx.ts
// 本身的三处修复（字体栈压成单个 DrawingML typeface、noAutofit、无条件给 <a:ea>）。
//
// **不覆写字体与页面尺寸**：字号、纸张、标题/词曲字号由样式表的角色与 page 说了算，
// 这里只固定那些本来就没有 UI 的**笔画类**常量。
function applyPptxPreset(st: JianpuStyle): void {
  const em = st.size.note;

  // 音符数字**不加粗**：投影那一档的观感是既有的，原样档才照印刷谱加粗。
  st.look.noteBold = false;

  // **小节线的上下缘不再覆写**（用户口径：「PPT 模式的小节线有点短，用简谱模式的高度」）。
  // 老展开档是 −23/28 em 与 +5/28 em（合起来正好 1 em），比今天的 −1 em / +1/3 em
  // （合起来 4/3 em）矮三分之一；投影上那截线短得不像小节线。于是 H 回到 4/3 em，
  // 下面的拍号比例也跟着**回默认**——`TIME_SIG_DEFAULTS` 正好是老那四个数的 3/4
  // （0.75/0.1/0.625/0.375 × 3/4 = 0.5625/0.075/0.46875/0.28125），
  // 拍号画出来与老档一模一样，只有小节线变高了。

  // 小节线细线 1.5（今 2）；终止线的粗线 3.5 两版相同，写出来是为了这一档自洽。
  st.stroke.barline = 1.5;
  st.stroke.finalBarline = 3.5;

  // 减时线：线宽 1.4（= em/20，量自 2019 年那批成品 .pptx；老档 1.25、今默认 1.5）。
  // 落点与各引擎同一套等距叠层（engrave/stack.ts，用户定：展开档也不留旧式阶梯）。
  st.stroke.beam = em / 20;

  // 临时记号小一号（用户口径：「展开档的升号偏大」）——投影的数字不加粗、字号大，照混排那个比例显得压过数字。
  st.look.accidentalScale = 0.75;

  // 拍号只留分数线粗细（比例走默认，见上面小节线那一段）。
  st.stroke.timeSigRule = 1.5;

  // **附点 / 高音点 / 低音点三者同大**（用户口径）。默认两者各按自己那个字形的墨迹高折半
  // （附点照 `·` 是 ⌀4.06 @28pt、八度点照 `.` 是 ⌀3.44），附点明显更胖。
  // 这一档取两者之间的一个整数比例：⌀2r = em/7.5，附点缩一点、八度点放一点。
  st.dot.octave = em / 15;
  st.dot.aug = em / 15;

  // 弧线：旧版厚 4、无描边，且没有高度上下限、没有扁平长连音线——
  // 一律退化成 musicpp 的裸对数公式。
  st.stroke.slur = 4;
  st.stroke.slurOutline = 0;
  st.arc.maxHeight = 0;
  st.arc.minHeight = 0;
  st.arc.flatSpan = -1;
  st.arc.flatNotes = 0;
  st.arc.flatRatio = 0;
}
