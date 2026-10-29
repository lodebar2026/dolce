// 内置主题：级联的最底层。**切主题 = 换一整层**。
//
// | 主题        | 谁在用                                  |
// |-------------|-----------------------------------------|
// | projection  | 编辑器「投影」档（两种格式）与导出 PPTX |
// | print       | 编辑器「简谱」档（各格式）              |
// | book        | 成书重排（scripts/rebuild.mjs）         |
// | staff       | 五线谱 / 混排                           |
//
// 编辑器里主题由排版模式决定（投影 → projection、简谱 → print），切模式按钮就是整层切换。
// 数值一律写成它们原来的样子（裸数字 = pt）：改写成比例会有浮点尾差，破几何基线。
//
// 无 DOM 依赖。
import { computeStyle, type StyleContext, type StyleLayer } from "./cascade";
import type { StyleSheet } from "./sheet";
import type { Length } from "./units";
import { STANDARD_PAPERS } from "../model/pagemeta";
import { parseSs } from "./ss";

/** 老版投影档的「出厂默认」（投影片 960×540，字号 28/48/36）。 */
export const PPTX_PAGE = { w: 960, h: 540, fontSize: 28, titleSize: 48, creditSize: 36 } as const;

/** 「投影」档只有这两种投影片比例（1 排版单位 = 1pt，导出 PPTX 要的就是这个）。
 *  **不给实际纸张**：展开是投影用的，一屏一段（用户口径：「不需要纸张设置，只要 2 种比例」）。 */
export const PAGE_RATIOS: Record<string, [number, number]> = {
  "16:9": [960, 540],
  "4:3": [720, 540],
};

/** 简谱档能选的纸：**实际纸张尺寸**（pt，1pt = 1/72 in），外加一档「长图」。
 *  长图不是纸——它是一张连续长纸，宽度取 `LONG_IMAGE_WIDTH`、高度由内容说了算。
 *  **这里没有 16:9 / 4:3**：那是投影片的比例，只归投影档。 */
export const PAPER_SIZES: Record<string, readonly [number, number] | null> = { ...STANDARD_PAPERS, 长图: null };

/** 「简谱」档能选的纸（含长图）。 */
export const ORIGINAL_PAPERS = ["A4", "A5", "B5", "Letter", "150×216mm", "155×240mm", "长图"] as const;

/** 「长图」那一档的纸宽：与 500 首那张纸（`150×216mm`）同宽（用户定）——长图只是不分页，版心与字号照分页纸。
 *  从前取文本谱「原版」的 1000 宽、配 PPT 的 28pt，比 500 首宽出一倍多。 */
export const LONG_IMAGE_WIDTH = STANDARD_PAPERS["150×216mm"]![0];

/** 简谱档的出厂音符字号：照 500 首（实测 12.08pt），不借投影档投影片的 28。 */
export const ORIGINAL_NOTE_SIZE = 12;

/** 出厂纸。简谱档与文本谱「原版」档一贯的观感都是长图。 */
export const PAPER_DEFAULT = "长图";

/** 五线谱/混排的出厂纸：155×240mm（歌本开本，用户定）。五线谱一贯按实际纸张排（MusicXML 的 `<page-layout>` 也都是纸），
 *  不跟简谱档的「长图」——长图宽 1000pt、页高随内容，短曲子排出来是一张扁图，像横版。 */
export const STAFF_PAPER_DEFAULT = "155×240mm";

/** 五线谱/混排选了「长图」时的纸宽：按出厂纸的宽排，只是不分页（1000pt 宽的谱表比纸宽出一倍多）。 */
export const STAFF_LONG_IMAGE_WIDTH = STANDARD_PAPERS[STAFF_PAPER_DEFAULT]![0];

/** 这个纸张名在不在表里。 */
export const isPaper = (k: unknown): k is string =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(PAPER_SIZES, k);

/** 简谱档的角色字号：照 500 首成书（音符 12.08 时：歌词 11.8、和弦 10.1、标题 22.0、署名 11.0、三连音与房号 7.2），
 *  折成音符字号的倍数、取两位有效数字（落到 pt 时再取整或 .5，见 `style/jianpu.ts::rolePt`）。
 *  段落词成书量到 7.8（0.65em），屏幕上看太小，用户定与和弦同大（0.85em）。 */
const PRINT_ROLES = {
  lyric: { size: "1em" },
  verseNum: { size: "1em" },
  keyMeter: { size: "1em" },
  chord: { size: "0.85em" },
  title: { size: "1.8em" },
  credit: { size: "0.9em" },
  tuplet: { size: "0.6em" },
  sectionWord: { size: "0.85em" },
} as const;

/** 简谱档的笔画与间距：照 500 首（`dev/style/books/hymn500-measured.ss` 的 @jianpu），em = 音符字号，取两位有效数字或常见分数。
 *  减时线、弧描边、松叶、拍号分数线 500 首没量，取与它同一档的比例。写成绝对量的话换小纸（500 首那张、字号 12）时不跟着缩。 */
const PRINT_JIANPU: Record<string, Length | boolean> = {
  barline: `${1 / 14}em`,
  "final-barline": `${1 / 8}em`,
  "beam-width": "0.05em",
  "slur-thickness": "0.2em",
  "slur-outline": "0.025em",
  "slur-max-arc": "0.45em",
  "slur-min-arc": "0.28em",
  "hairpin-width": "0.05em",
  "repeat-dot-diameter": "0.16em",
  // 拍号分数线与小节线同粗（原 0.025em，字号 12 时只有 0.3pt，看着太细；2026-10-14 用户定加粗）
  "time-sig-rule": `${1 / 14}em`,
  "slur-gap": "0.15em",
  "lyric-stack": "1.25em",
  // 和弦基线离音符墨迹顶留一道空（0 = 贴着数字）。0.25em 时和弦贴得太近（用户定调大，2026-10-14）
  "chord-gap": "0.4em",
  "chord-plain": true,
  // 末行歌词基线 → 下一组音符基线：歌词墨迹底到下一组数字墨迹顶只空一行字（诗歌本口径）；同组相邻声部之间
  "system-gap": "1.6em",
  "voice-gap": "1.5em",
  "lrc-punct-compress": "halfwidth" as Length,
  "grace-scale": 0.6,
  // 音符的临时记号小一号（用户口径：照混排那个比例压过数字），同投影档、混排
  "accidental-scale": 0.75,
};

/** 每首末页底下的页脚（文本谱的 BL / BC / BR；语料里 BL 常写 `-` 占位，视为空）：区域顶在本曲末页最低一行之下
 *  一个歌词字高处，字号按 `as 角色` 取（`header` 与 TL/TR 同档）。现在只有简谱引擎印。语法见 docs/格式/ss.md。 */
const PRINT_FOOT = parseSs(`
@template song-foot {
  flow: block;
  align-x: content;
  line-height: 1.35em;
  row { left: "{pageText.bottomLeft | dash-empty | lines-trim}" as header; }
  row(gap-before: 4) { center: "{pageText.bottomCenter | dash-empty | lines-trim}" as header; }
  row(gap-before: 4) { right: "{pageText.bottomRight | dash-empty | lines-trim}" as header; }
}
`).rules;

const INK = 0xff000000;
const PAPER_WHITE = 0xffffffff;

export type ThemeId = "projection" | "print" | "book" | "staff";

export const THEMES: Record<ThemeId, StyleLayer> = {
  projection: [
    {
      set: {
        roles: { note: { size: PPTX_PAGE.fontSize }, title: { size: PPTX_PAGE.titleSize }, credit: { size: PPTX_PAGE.creditSize } },
        page: { size: [PPTX_PAGE.w, PPTX_PAGE.h], ink: INK, background: PAPER_WHITE },
        jianpu: { preset: "pptx" },
      },
    },
  ],
  print: [
    {
      set: {
        page: { paper: PAPER_DEFAULT, ink: INK, background: PAPER_WHITE },
        roles: { note: { size: ORIGINAL_NOTE_SIZE }, ...PRINT_ROLES },
        jianpu: { preset: "original", overrides: PRINT_JIANPU },
      },
    },
    ...PRINT_FOOT,
  ],
  // 成书的其余一切在 `book` 块（由歌本样式表算出的 BookStyle，见 style/bookss.ts），由调用方作为第二层叠上
  book: [{ set: { jianpu: { preset: "book" } } }],
  staff: [{ set: { page: { paper: STAFF_PAPER_DEFAULT }, staff: { preset: "musicpp" } } }],
};

/** 编辑器排版模式 → 主题。 */
export function themeOfMode(mode: "expanded" | "original"): "projection" | "print" {
  return mode === "expanded" ? "projection" : "print";
}

/** 这份样式表算出来的是分页还是长图。长图 = 纸张表里值为 `null` 的那一档；
 *  没写纸（投影档按投影片尺寸走）一律算分页。 */
export function isPagedSheet(sheet: StyleSheet): boolean {
  const paper = sheet.page.paper;
  if (paper === undefined) return true;
  return PAPER_SIZES[paper] !== null;
}

/** 级联两趟：先算出纸，再把 `paged` 填进上下文重算——`@media (paged: …)` 要的就是这一维，
 *  而纸本身又是样式表算出来的（主题给出厂纸、歌本与用户层可改），所以只能这么定。
 *  第一趟的结果只用来看纸，不外传。 */
export function computeStyleForPaper(layers: readonly StyleLayer[], ctx: StyleContext): StyleSheet {
  const paged = isPagedSheet(computeStyle(layers, ctx));
  return computeStyle(layers, { ...ctx, paged });
}
