// 歌词音节的量宽与落笔：旧简谱引擎、原样文档、五线谱/混排共用一份。
//
// 一个音节切成「前标点 / 主体 / 后标点」三段（`“凡`、`召：`、`主,`），**按主体居中**对音符，
// 两头的标点挂出去。宽度与逐字笔位一律取**标点挤压后**的那一串（`Font.run`，规则在 common/cjkpunct.ts），
// 量宽与绘制同一串坐标——挤压档由样式键 `lrc-punct-compress`（halfwidth / clreq / none）选。
// 原先三路三套：旧简谱引擎按 `LYRIC_SPLIT_PUNCT` 切、混排把首尾所有非汉字（连英文字母）都当标点、
// 原样文档按未挤压的主体宽居中却按挤压后的笔位画。
import type { CompressMode } from "../common/cjkpunct";
import { LYRIC_SPLIT_PUNCT, MIXED_PUNCT } from "../common/cjkpunct";
import type { Font } from "../pagetree/font";
import { TextFrame } from "../pagetree/pageitem";

/** 音节首尾当标点挂出去的字（两份表的并集：旧简谱引擎那份含数字与半角标点，混排那份含书名号括号与顿号）。 */
export const LYRIC_EDGE_PUNCT = [...new Set([...LYRIC_SPLIT_PUNCT, ...MIXED_PUNCT])].join("");

export interface SyllableRun {
  /** 逐字（按码点）落笔点，相对音节起点；`none` 档或单字时为 null（连排）。 */
  xs: number[] | null;
  width: number;
  /** 前标点 / 主体 / 后标点三段宽。 */
  lead: number;
  body: number;
  tail: number;
}

/** 量一个音节。`compress = "none"` 不挤压（逐字按 advance 连排）。 */
export function syllableRun(text: string, font: Font, compress: CompressMode): SyllableRun {
  const chars = [...text];
  let nl = 0, nc = chars.length;
  if (chars.length > 1) {
    let pos = 0;
    while (pos < chars.length && LYRIC_EDGE_PUNCT.includes(chars[pos]!)) pos++;
    nl = pos;
    while (pos < chars.length && !LYRIC_EDGE_PUNCT.includes(chars[pos]!)) pos++;
    nc = pos - nl;
  }
  const { xs, width } = compress !== "none"
    ? font.run(text, compress)
    : { xs: chars.map((_, i) => font.measureText(chars.slice(0, i).join(""))), width: font.measureText(text) };
  const at = (i: number): number => (i <= 0 ? 0 : i >= xs.length ? width : xs[i]!);
  return {
    xs: compress !== "none" && xs.length > 1 ? xs : null,
    width,
    lead: at(nl),
    body: at(nl + nc) - at(nl),
    tail: width - at(nl + nc),
  };
}

/**
 * 相邻两个音节之间要不要补一个**西文词间空格**（三引擎共用的判据）。中文一字一格挨着排没问题，
 * 西文照中文挨排就成了 `love,andjoy?`、`十love`。交界的任一侧是西文——后一个以西文字母开头，
 * 或前一个以西文字母/数字收尾（后面可以跟半角标点；`主啊,` 这种中文带半角逗号的不算）——就补；
 * 前一个以连字符 `-` 收尾的是词中断开的音节，不补。
 */
export function latinWordBreak(prev: string, next: string): boolean {
  if (!prev || !next || prev.endsWith("-")) return false;
  return /^[A-Za-zÀ-ɏ]/.test(next) || /[A-Za-zÀ-ɏ0-9][,.;:!?'")]*$/.test(prev);
}

/** 歌词一条（一个音节），页面树叶子。宽度与逐字笔位走上面的 `syllableRun`。 */
export class Lyric extends TextFrame {
  _widths = [0, 0, 0];
  /** 标点挤压的档（`JianpuStyle.look.punctCompress`）。 */
  compress: CompressMode = "halfwidth";
  /** 段号（`JLyric.number`）。可视化编辑按它认出点中的是哪一段（叠排时各段同在一个音符格里） */
  verse = 0;
  constructor() {
    super();
    this.selectable = true;
    this.classes.add("lyric"); // 页面检查（scripts/page-check.mjs）靠它认歌词——构建会压缩类名，instanceof 用不上
  }
  /** 开头那串标点的宽度（`“凡` 的引号）。避让时可以悬挂出去，见 calcXPos。 */
  get leadWidth(): number {
    return this._widths[0];
  }
  get left(): number {
    return this._widths[0] + this._widths[1] / 2;
  }
  get right(): number {
    return this._widths[1] / 2 + this._widths[2];
  }
  /** 末字右侧的留白（advance 减墨迹）。相邻两条歌词能挤多近由它和下一条的左留白决定。 */
  get tailBlank(): number {
    const t = this.text;
    if (!t) return 0;
    const chars = [...t];
    const last = chars[chars.length - 1];
    // 末字的落笔点按**挤压后**的笔位算（charXs 是 update 时量的，与绘制同一串坐标）
    const upto = this.charXs ? this.charXs[chars.length - 1] : this.measureText(0, t.length - last.length);
    return Math.max(0, this.width - (upto + this.font.charBound(last).right));
  }
  /** 首字左侧的留白（墨迹离本条歌词的落笔点多远）。`“` 这种标点的墨只占方框右半边。
   *  **要从挤压后的笔位起算**：半角档下前引号的笔位已经左挪了半格（墨正好落在格内左半），
   *  照字形的 inkLeft 算就把这半格又算了一遍，避让时凭空多出半格空档，
   *  上一个字的尾标点就被压住了（076「说：」压「“忠」、159 两处、376「召：」压「“将」）。 */
  get headBlank(): number {
    const t = this.text;
    if (!t) return 0;
    const pen = this.charXs?.[0] ?? 0;
    return Math.max(0, pen + this.font.charBound([...t][0]).left);
  }
  override update(): void {
    // 「前标点 / 主体 / 后标点」三段与挤压后的逐字笔位走公共那一份（engrave/syllable.ts）
    const run = syllableRun(this.text, this.font, this.compress);
    const width = run.width;
    this.charXs = run.xs;
    this._widths[0] = run.lead;
    this._widths[1] = run.body;
    this._widths[2] = run.tail;
    this.width = width;
    this.height = this.font.size;
  }
}
