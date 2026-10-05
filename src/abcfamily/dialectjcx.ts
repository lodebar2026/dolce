// Muse 曲谱软件 `.jcx` 的音乐体（说明书 §3.2「脚本输入方式」，格式规范见 `docs/格式/jcx.md`）。
//
// 词法与 ABC 同源（字母音名 + 分数时值 + `-` 是 tie），只差下面几处，都在这个子类里：
//
// | | ABC | Muse |
// |---|---|---|
// | 不可见休止 | `x` | `@` |
// | 节奏音符（有声无音高） | 无 | `x` / `X` |
// | 渐强渐弱 | `!<(!` 这类装饰 | 成对括号 `(<` … `<)`、`(>` … `>)` |
// | 后倚音 | 无 | `{@C}` |
// | 小节内多声部 `&` | 有 | 无 |
//
// **语义**上最大的差别不在词法：`style=jianpu` 的声部里**字母是首调唱名，C 恒为 1**
// （说明书 FAQ「简谱和五线谱在脚本输入上有什么不同」），`K:` 只定 1 是哪个音。
// 字母 ↔ 度数的对照只在这里写一份，读（`parsedialect.ts::DIALECT_JCX`）写（`emitjcx.ts`）
// 与可视化编辑（`editor/visual/dialects/jcx.ts`）共用。

import { LexerAbc } from "./dialectabc";
import type { Key } from "../model/doc";
import { parseKey as parseKey123 } from "../j123/fields";

/** 字母 → 简谱度数（C=1 … B=7）。 */
export const DEGREE_OF_LETTER: Readonly<Record<string, number>> = {
  C: 1, D: 2, E: 3, F: 4, G: 5, A: 6, B: 7,
};

/** 度数 → 字母（大写，第 0 个八度）。 */
export const LETTER_OF_DEGREE = "CDEFGAB";

export class LexerJcx extends LexerAbc {
  override readonly id = "jcx" as const;
  protected override readonly voiceOverlay = false;
  protected override readonly rhythmLetters = "xX";
  protected override readonly invisibleRest = "@";
  protected override readonly wedgeParens = true;
  protected override readonly postGraceMark = "@";
}

/** 单例——词法器无状态。 */
export const LEXER_JCX = new LexerJcx();

/**
 * Muse 的 `K:`：`K:F` `K:bE`（实际文件把降号写在前）`K:Eb`（说明书写法）`K:Am` `K:A bass`，
 * 野外还见过 `K: G、F`（转调的说明）。只取开头的「升降号 + 字母 + 升降号 + 调式词」，
 * 后面的谱号与说明不管——简谱只要知道 1 是哪个音。拼写按 123 的口径归一成前置形（`bE`）。
 */
export function parseKeyJcx(value: string): { key: Key; error?: string } {
  const v = value.trim();
  if (v === "" || /^none$/i.test(v)) return { key: { fifths: 0, spelling: "none" } };
  const m = /^([#b♯♭]?[A-Ga-g][#b♯♭]?)(?:\s*(maj|min|ion|aeo|mix|dor|phr|lyd|loc|m)[A-Za-z]*)?(?![A-Za-z])/i.exec(v);
  if (!m) return parseKey123(v);
  return parseKey123(m[1]! + (m[2] ?? ""));
}
