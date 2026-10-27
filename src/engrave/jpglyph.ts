// 简谱记号的字形：文本谱 `&xx`、力度、小节线记号、临时记号、连谱号 → Bravura（SMuFL）码位。
// 名字表（力度名、术语）在 `model/marknames.ts`。
//
// PUA 码位一律用 String.fromCharCode 写，**切勿在源码里写字面 PUA 字符**
// （编辑工具会损坏这些字节）。这里不引用项目主谱面的 GlyphCodes，是因为文本谱要的
// 记号集与它只有部分重叠，各自维护更清楚。

import { dynamicGlyphs } from "./dynamics";
import { articGlyph } from "./articulation";
import { DYNAMIC_NAMES } from "../model/marknames";

const C = (n: number): string => String.fromCharCode(n);

/** 记号在音符的哪一侧。 */
export type OrnamentPlacement = "above" | "below";

export interface OrnamentGlyph {
  /** Bravura 字符 */
  glyph: string;
  placement: OrnamentPlacement;
  /** 相对数字字号的缩放 */
  scale: number;
  /** 中文名，用于提示与诊断 */
  label: string;
}

/** `&xx` 记号表。名称取符号中文名的拼音首字母（两种方言一致）。 */
export const ORNAMENTS: Readonly<Record<string, OrnamentGlyph>> = {
  // 延长、保持、重音、顿音的字形走公共那一份（engrave/articulation.ts，简谱印法：顿音是实心倒三角 ▼）
  yc: { glyph: articGlyph("fermata", true), placement: "above", scale: 1.0, label: "延长记号" },
  ycy: { glyph: articGlyph("fermata", true), placement: "above", scale: 1.0, label: "延长记号" },
  bc: { glyph: articGlyph("tenuto", true), placement: "above", scale: 0.9, label: "保持音" },
  zy: { glyph: articGlyph("accent", true), placement: "above", scale: 0.9, label: "重音" },
  // ▼ 宽约数字高的 0.45、高约 0.4（GB/T 46845 7.9.2.2 谱例量的）
  dy: { glyph: articGlyph("staccato", true), placement: "above", scale: 1.6, label: "顿音" },
  hx: { glyph: C(0xe4ce), placement: "above", scale: 0.9, label: "呼吸记号" },
  shy: { glyph: C(0xe5d0), placement: "above", scale: 0.9, label: "上滑音" },
  xhy: { glyph: C(0xe5d3), placement: "above", scale: 0.9, label: "下滑音" },
  sby: { glyph: C(0xe56c), placement: "above", scale: 0.9, label: "上波音" },
  xby: { glyph: C(0xe56d), placement: "above", scale: 0.9, label: "下波音" },
  cy: { glyph: C(0xe566), placement: "above", scale: 0.9, label: "颤音" },
  tr: { glyph: C(0xe566), placement: "above", scale: 0.9, label: "颤音" },
  // 下面几样文本谱的 `&xx` 里没有（番茄脚本规范同），只给 123 / MusicXML 来源的简谱排版用（`jianpu/slots.ts::chordOrnaments`）
  sg: { glyph: C(0xe612), placement: "above", scale: 0.9, label: "上弓" }, // stringsUpBow
  xg: { glyph: C(0xe610), placement: "above", scale: 0.9, label: "下弓" }, // stringsDownBow
  // 单音震音：简谱印在数字上方的几道斜线（tremolo1–4）
  trem1: { glyph: C(0xe220), placement: "above", scale: 0.8, label: "震音" },
  trem2: { glyph: C(0xe221), placement: "above", scale: 0.8, label: "震音" },
  trem3: { glyph: C(0xe222), placement: "above", scale: 0.8, label: "震音" },
  trem4: { glyph: C(0xe223), placement: "above", scale: 0.8, label: "震音" },
};

/** 力度名 → 字形（名字表在 `model/marknames.ts`）；字形走公共那一份（engrave/dynamics.ts），与五线谱、旧简谱引擎同一套。 */
export const DYNAMICS: Readonly<Record<string, string>> = Object.fromEntries(DYNAMIC_NAMES.map((n) => [n, dynamicGlyphs(n)]));

/** 小节线上的反复/导航记号。 */
export const BARLINE_MARKS: Readonly<Record<string, { text?: string; glyph?: string; label: string }>> =
  {
    fine: { text: "Fine", label: "曲终" },
    dc: { text: "D.C.", label: "从头反复" },
    ds: { text: "D.S.", label: "大反复" },
    ty: { glyph: C(0xe048), label: "跳跃记号" },
    hs: { glyph: C(0xe047), label: "花 S 记号" },
    sbf: { label: "声部括弧起点" },
  };

/** 临时升降号：与 .jpwabc 谱面同一套 SMuFL 字形（不是 ♯♭♮ 文字符号）。 */
export const ACCIDENTAL_GLYPH: Readonly<Record<string, string>> = {
  flat: C(0xe260),
  natural: C(0xe261),
  sharp: C(0xe262),
  "double-sharp": C(0xe263),
  "double-flat": C(0xe264),
};

/** 连谱号（声部括弧）：SMuFL 的上下两截，中间用竖线接起来。 */
export const BRACKET = {
  top: C(0xe003), // bracketTop
  bottom: C(0xe004), // bracketBottom
  /** 花括号，用于歌词的联合括号（非等比缩放后使用） */
  brace: C(0xe000),
  /** Bravura 的可选字形：窄→宽依次 braceLarger/braceLarge/brace/braceSmall */
  braceSmall: C(0xf400),
};

/** 伴奏括弧：写在音符后的 `&zkh` / `&ykh`。 */
export const ACCOMP_BRACKET = new Set(["zkh", "ykh"]);
