// 「按乐句重排」写回文本谱原文（编辑器工具栏那个按钮的文本谱一侧）。
//
// 搬运原文片段在 Rust（crates/model/src/formats/fanqie/relayout.rs，wasm `fanqieRelayoutText` / `fanqieRelayoutBreak`），这里是门面：
// 新行怎么分要行长尺子（`LinePlan.measure` 在 TS 量），所以逐首先经 `jianpu/phrase.ts::planLines` 算好（回调照常触发），再整份交 Rust 写回。
//
// **只做原文片段的搬运**：新的每一行都是原文里那几段字符接起来的，不重新生成任何记号——和弦、`&记号`、注释、并字号、跳词符都跟着原文走。
// 简谱档走的是原样文档布局（吃排版行视图），文本谱里「一行 `Q:` 就是谱面一行」，所以落到文本而不是往引擎输入插换行。
// 无 DOM 依赖。

import type { ScoreDoc } from "../model/doc";
import { dolce } from "../common/dolce";
import { call } from "../model/rustdoc";
import { planLines, type LinePlan } from "../jianpu/phrase";

/**
 * 重排一份文本谱原文（按乐句 / 每行 n 小节）。
 *
 * 逐首处理（`-----` 分出的多唱法各自断句）；头部字段、`W:` 文字行、`-----` 原样保留，
 * 换掉的只有曲行与歌词行所在的那一段，以及分组空行与 `[fenye]`（行结构变了，它们要重来）。
 *
 * @param text    编辑器里的原文（`doc` 必须是它解析出来的那一份，`parseFanqie(text)`）
 * @param plan    新行怎么分（`jianpu/phrase.ts::LinePlan`）；不给就按乐句、断句的出厂目标断
 */
export function relayoutFanqieText(text: string, sdoc: ScoreDoc, opt: { plan?: LinePlan } = {}): string {
  const plans = sdoc.songs.map((_, i) => planLines(sdoc, i, opt.plan ?? { kind: "phrase", measure: null }));
  if (plans.every((p) => p === null)) return text;
  return call(() => dolce().fanqieRelayoutText(text, JSON.stringify(sdoc), JSON.stringify(plans)));
}

/**
 * 可视化编辑增删一处换行：照现有行结构只在元素 `afterId` 之后加一刀、或去掉它后面那一刀，
 * 写回的办法与乐句重排相同（原文片段搬运）。只改 `afterId` 所在的那一首。
 *
 * @returns 新原文；这一刀加不上 / 去不掉时返回 null
 */
export function relayoutFanqieBreak(
  text: string, sdoc: ScoreDoc, edit: { afterId: number; add: boolean; page: boolean },
): string | null {
  return call(() => dolce().fanqieRelayoutBreak(text, JSON.stringify(sdoc), edit.afterId, edit.add, edit.page)) ?? null;
}
