// 文本谱（番茄简谱 / 诗歌本）的读入：语法树与转 ScoreDoc 都在 Rust（crates/model/src/formats/fanqie/{parse,fromfanqie}.rs），这里是门面。
// 判据口径见 `docs/格式/` 与 `docs/模块/` 的文本谱篇。

import type { FanqieDoc } from "../jianpu/ast";
import type { ScoreDoc } from "../model/doc";
import { dolce } from "../common/dolce";
import { call } from "../model/rustdoc";
import type { Dialect } from "./dialect";

export interface ParseOptions {
  /** 指定方言，跳过嗅探 */
  dialect?: Dialect;
}

/** 文本谱 → 语法树。**只是进 `ScoreDoc` 之前的中间产物**：产品代码一律用 `parseFanqie`；
 *  直接要树的只有 AST 级校验脚本（`fanqie-parse-check` / `fanqie-scoredoc-check` / `omr-fanqie-check`）。 */
export function parseFanqieAst(text: string, options: ParseOptions = {}): FanqieDoc {
  const ast = JSON.parse(dolce().fanqieParseAst(text, options.dialect ?? "")) as FanqieDoc;
  // 原文换回 JS 那份（孤立代理过边界会变成 U+FFFD，码元数不变）
  ast.source = text;
  return ast;
}

/** 语法树 → `ScoreDoc`。 */
export function fanqieToScoreDoc(ast: FanqieDoc): ScoreDoc {
  const doc = JSON.parse(call(() => dolce().fanqieToScoreDoc(JSON.stringify(ast)))) as ScoreDoc;
  doc.source = ast.source;
  return doc;
}

/** 文本谱 → `ScoreDoc`。 */
export function parseFanqie(text: string, options: ParseOptions = {}): ScoreDoc {
  const doc = JSON.parse(dolce().fanqieParse(text, options.dialect ?? "")) as ScoreDoc;
  doc.source = text;
  return doc;
}
