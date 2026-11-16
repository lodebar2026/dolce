// `.Voice` 正文的词法：在 Rust（crates/dolce-formats/src/jpw/lex.rs），这里是门面。
// 规则沿用原 JP-Word 的词法定义（见 docs/格式/jpwabc.md §4 词法表）：在当前位置把各规则都试一遍，
// **取最长匹配，等长按规则先后**；空白与 `//` 注释也产出（高亮要），认不出的字符静默跳过。

import { dolce } from "../common/dolce";

export type JpwTok =
  | "preludeBeg" // `(`：前奏开始
  | "preludeEnd" // `)`：前奏结束
  | "note"
  | "lbrack" // 落单的 `[`（正文里出现即解析失败）
  | "rbrack" // 落单的 `]`（同上）
  | "barline"
  | "rbrace" // 落单的 `)`：等长时让给 preludeEnd，实际不会产出
  | "return" // `$(...)` 换行
  | "timesig"
  | "string"
  | "comment"
  | "ws";

export interface JpwToken {
  type: JpwTok;
  text: string;
  /** 在输入里的 [start, end) 偏移（UTF-16 码元） */
  start: number;
  end: number;
  /** 起点的 0 基行号与列（行以 `\n` 分） */
  line: number;
  column: number;
}

/** 把 `.Voice` 正文切成 token（含 ws/comment）。 */
export function lexVoice(text: string): JpwToken[] {
  const rows = JSON.parse(dolce().jpwLex(text)) as Array<[JpwTok, string, number, number, number, number]>;
  // 原文按偏移从 JS 那份取（孤立代理过边界会变 U+FFFD）
  return rows.map(([type, , start, end, line, column]) => ({ type, text: text.slice(start, end), start, end, line, column }));
}
