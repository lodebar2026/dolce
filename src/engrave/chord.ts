// 和弦符号的富文本分段与绘制——旧简谱引擎、原样文档、五线谱/混排共用。
//
// 两种风格：SMuFL 和弦（缺省，下面这套分段）与**简单文本**（`chordTextSegs(text, true)`：整串原文一段，
// 原书就是一行普通文字）。三路都由样式键 `chord-plain` 选（`style/keys.ts`）。
//
// 和弦符号不是一串普通文字：根音的升降号要用 SMuFL 的 csym 小号字形，后缀（7 / maj7 /
// sus4 …）要上标，`m` 留在基线，低音 `/G` 跟在后面。五线谱那侧原本把这套排版逻辑
// 内联在 drawHarmony 里，这里抽出来，文本谱直接复用同一套，两边观感才一致。

import { GlyphCodes } from "../smufl/smufl";
import { Font } from "../pagetree/font";
import { Group, TextFrame } from "../pagetree/pageitem";
import { Matrix33, Rect } from "../common/geom";
import { chordStepAlter } from "../score/harmonyparse";
import type { AccidentalSide } from "./spacing";

/** 和弦符号的一段：文字或 SMuFL 字形，可上标（1）/下标（-1）。 */
export interface HarmonySeg {
  text: string;
  music: boolean;
  superscript: number;
  dy: number;
  /** 就地缩放（不上标、基线不动）。纯文本风格的升降号用它——原书量到的
   *  `♭` 是 2.62×4.21，字母 `B` 是 6.33×7.01，升降号本来就印得小一号。 */
  scale?: number;
}

/** 一段的缩放：上/下标 0.75，否则就地缩放 `scale`（缺省 1）。排版与量宽同一口径。 */
function segScale(s: HarmonySeg): number {
  return s.superscript === 1 || s.superscript === -1 ? 0.75 : (s.scale ?? 1);
}

/** 分段总宽：各段 advance × 各自缩放（上/下标 0.75），**就是 `layoutHarmonySegs` 的笔位终点**。
 *  居中按它算——按未缩放算的话 A(sus4) 这类长上标的和弦会整体左偏（KL2020《基督是锚》第 9 小节偏 18 tenths）。 */
export function harmonyWidth(segs: readonly HarmonySeg[], wordFont: Font, musicFont: Font): number {
  let w = 0;
  for (const s of segs) w += (s.music ? musicFont : wordFont).measureText(s.text) * segScale(s);
  return w;
}

/** 分段的**墨迹盒**（原点在左侧基线，同 `layoutHarmonySegs`）：各段字形墨迹按各自缩放、上下标位移并起来。
 *  定位端拿它让位（Bravura 段不能用字体盒，见 CLAUDE.md）。空串返回 null。 */
export function harmonyInk(segs: readonly HarmonySeg[], wordFont: Font, musicFont: Font): Rect | null {
  let ink: Rect | null = null;
  let xpos = 0;
  for (const s of segs) {
    const font = s.music ? musicFont : wordFont;
    const scl = segScale(s);
    const dy = scl !== 1 ? (s.superscript === 1 ? -font.size / 4 : s.superscript === -1 ? font.size / 4 : 0) : s.dy;
    if (s.text.trim()) {
      const b = font.charBound(s.text);
      const r = new Rect(xpos + b.left * scl, dy + b.top * scl, xpos + b.right * scl, dy + b.bottom * scl);
      ink = ink ? new Rect(Math.min(ink.left, r.left), Math.min(ink.top, r.top), Math.max(ink.right, r.right), Math.max(ink.bottom, r.bottom)) : r;
    }
    xpos += font.measureText(s.text) * scl;
  }
  return ink;
}

/**
 * 把分段排成一个 Group（原点在左侧基线）。上标缩到 75% 并上移 1/4 字号。
 * 旧简谱引擎、原样文档、五线谱/混排三路共用。
 */
export function layoutHarmonySegs(
  segs: readonly HarmonySeg[],
  wordFont: Font,
  musicFont: Font,
  color: number,
): Group {
  const grp = new Group();
  // 标记成和弦：成书重排把页面树扁平化成 DrawList 时靠它认角色（选字体、选是否走轮廓）。
  // 不标的话这几个 TextFrame 只是「小一号的普通文字」，会被当歌词排。
  grp.classes.add("chord");
  grp.ident = { kind: "harmony" }; // 可视化编辑单独点选和弦名（`ScoreIndex.parts`）
  let xpos = 0;
  for (const s of segs) {
    const font = s.music ? musicFont : wordFont;
    const t = new TextFrame();
    t.classes.add(s.music ? "chord-music" : "chord");
    // 音乐字体（Bravura）的全局 ascent/descent 是 4 个字号高，不能拿它当行高
    t.inkBound = s.music;
    t.text = s.text;
    t.font = font;
    t.color = color;
    const scl = segScale(s);
    if (scl !== 1) {
      const dy = s.superscript === 1 ? -font.size / 4 : s.superscript === -1 ? font.size / 4 : 0;
      const g = new Group();
      const m = new Matrix33();
      m.setAffine([scl, 0, 0, scl, xpos, dy]);
      g.matrix = m;
      g.add(t);
      grp.add(g);
    } else {
      t.x = xpos;
      t.y = s.dy;
      grp.add(t);
    }
    xpos += font.measureText(s.text) * scl;
  }
  return grp;
}

/** 纯文本风格里升降号相对字母的字号比例（原书实测 ♭ 高 4.21 / 字母 7.01）。 */
const PLAIN_ACCIDENTAL_SCALE = 0.6;

const SHARP_CHARS = "#♯";
const FLAT_CHARS = "b♭";

/** 根音/低音的「字母 + 升降号」。`left`：原文把升降号写在字母前面（`#Fm`），照原样排在前面。 */
function pushStepAlter(segs: HarmonySeg[], letter: string, accidental: string, left = false): void {
  // 注意：String.includes("") 恒为真，没有升降号时必须先挡掉空串
  const glyph = accidental === "" ? ""
    : SHARP_CHARS.includes(accidental) ? GlyphCodes.csymAccidentalSharp
    : FLAT_CHARS.includes(accidental) ? GlyphCodes.csymAccidentalFlat : "";
  if (glyph && left) segs.push({ text: glyph, music: true, superscript: 0, dy: 0 });
  segs.push({ text: letter, music: false, superscript: 0, dy: 0 });
  if (glyph && !left) segs.push({ text: glyph, music: true, superscript: 0, dy: 0 });
}

/** 后缀里能直接用 SMuFL 记号表示的质量。 */
const QUALITY_SYMBOL: ReadonlyArray<[RegExp, string]> = [
  [/^(?:ø|m7b5|min7b5|halfdim)/i, GlyphCodes.csymHalfDiminished],
  [/^(?:aug|\+)/, GlyphCodes.csymAugmented],
  [/^(?:dim|°|o)(?![a-z])/i, GlyphCodes.csymDiminished],
];

/**
 * 把和弦**文字**（`Cm`、`B♭7`、`C♯m`、`Fm/A♭`、`Cadd9`）解析成分段。
 *
 * `plain` 为真时排成简单文本（见函数体开头的注释）。
 * `side`：根音/低音的升降号写在字母前还是后（样式键 `accidental-side`）；不给 = 照原文（`Eb` 排 `Eb`、`bE` 排 `bE`）。
 *
 * 文本谱里和弦本来就是写死的字符串（`"hx:C♯m"` 或不带引号的 `Dm`），没有 MusicXML
 * 那样的 kind/degree 结构，所以按写法拆：根音 → 质量后缀 → `/低音`。
 * 认不出来的整段按原文排，不猜。
 */
export function chordTextSegs(text: string, plain = false, side?: AccidentalSide): HarmonySeg[] {
  const segs: HarmonySeg[] = [];
  const src = text.trim();
  if (plain) {
    // **纯文本风格**，三条都照原书那本来：
    //   - 升降号写成 ASCII 的 `#` / `b`。`♯`/`♭` 那两个字符在成书用的方正字体里没有字形，
    //     排出来会回退到乐谱字体——绕个圈子又用上了 SMuFL，而纯文本要的正是不用它。
    //   - 升降号在字母前还是后按 `side`（原书写作 `#Fm`、`bB`，中文简谱的习惯，歌本样式表写 `accidental-side: before`），
    //     不给就照原文。
    //   - 就地缩到 `PLAIN_ACCIDENTAL_SCALE`：字母与后缀数字同字号同基线，
    //     只有升降号印得小一号（字形库量的 `♭` 是 2.62×4.21、`B` 是 6.33×7.01）。
    const segs: HarmonySeg[] = [];
    const emit = (text: string, acc = false): void => {
      segs.push({ text, music: false, superscript: 0, dy: 0, ...(acc ? { scale: PLAIN_ACCIDENTAL_SCALE } : {}) });
    };
    /** 排一个「字母 + 升降号」，升降号按 `side` 放在字母前或后。返回剩下的部分。 */
    const emitRoot = (str: string): string => {
      const m = chordStepAlter(str);
      if (!m) {
        emit(str);
        return "";
      }
      const acc = m.acc ? (SHARP_CHARS.includes(m.acc) ? "#" : "b") : "";
      const before = side ? side === "before" : m.left;
      if (acc && before) emit(acc, true);
      emit(m.step);
      if (acc && !before) emit(acc, true);
      return str.slice(m.len);
    };
    let rest = emitRoot(src);
    let bass = "";
    const slashAt = rest.indexOf("/");
    if (slashAt >= 0) {
      bass = rest.slice(slashAt + 1);
      rest = rest.slice(0, slashAt);
    }
    // 后缀里的升降号（`C7♭9`）留在原处，只换字符、缩字号
    for (const part of rest.split(/([#♯♭])/).filter(Boolean)) {
      if (part === "#" || part === "♯") emit("#", true);
      else if (part === "♭") emit("b", true);
      else emit(part);
    }
    if (bass) {
      emit("/");
      emitRoot(bass);
    }
    return segs.length ? segs : [{ text: src, music: false, superscript: 0, dy: 0 }];
  }

  // 升降号前置后置都认：前置（`#Fm`，中文简谱的写法）照原样排在字母前面
  const root = chordStepAlter(src);
  if (!root) {
    // 不是「字母打头」的和弦（例如汉字注记），原样排
    return [{ text: src, music: false, superscript: 0, dy: 0 }];
  }
  pushStepAlter(segs, root.step, root.acc, side ? side === "before" : root.left);
  let rest = src.slice(root.len);

  // 低音：`/G`、`/A♭`
  let bass = "";
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    bass = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
  }

  // 前导 m 留在基线（与五线谱侧一致），其余后缀上标
  if (/^m(?!aj)/i.test(rest)) {
    segs.push({ text: "m", music: false, superscript: 0, dy: 0 });
    rest = rest.slice(1);
  }
  if (rest) {
    let matched = false;
    for (const [re, sym] of QUALITY_SYMBOL) {
      const m = re.exec(rest);
      if (!m) continue;
      segs.push({ text: sym, music: true, superscript: 1, dy: 0 });
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (rest) {
      // 后缀里的升降号也用 csym 字形（`C7♭9`）
      for (const part of rest.split(/([#♯b♭])/).filter(Boolean)) {
        if (SHARP_CHARS.includes(part) && part.length === 1) {
          segs.push({ text: GlyphCodes.csymAccidentalSharp, music: true, superscript: 1, dy: 0 });
        } else if (FLAT_CHARS.includes(part) && part.length === 1 && matched) {
          segs.push({ text: GlyphCodes.csymAccidentalFlat, music: true, superscript: 1, dy: 0 });
        } else {
          segs.push({ text: part, music: false, superscript: 1, dy: 0 });
        }
      }
    }
  }

  if (bass) {
    segs.push({ text: "/", music: false, superscript: 0, dy: 0 });
    const b = chordStepAlter(bass);
    if (b) pushStepAlter(segs, b.step, b.acc, side ? side === "before" : b.left);
    else segs.push({ text: bass, music: false, superscript: 0, dy: 0 });
  }
  return segs;
}
