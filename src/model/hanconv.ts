// 简繁转换：**以 ScoreDoc 为准**决定哪些是人读的文字、按什么上下文送词表，五种源格式通用。
// 在 Rust（crates/model/src/hanconv.rs），这里是门面；词表函数（`common/hanconv.ts`）由调用方给，Rust 回调它。
//
// - 文字槽按「一起送词表的上下文」分组：头部每个字段一组；歌词同一声部、同一段号的音节**整首**按元素顺序连成一组，
//   词组跨音节、跨行都能按词转（`日光/之下`、行末「发」接下行「现」）。
// - MusicXML 没有代码区：改模型后整份重写（`convertScoreDoc` + `App.editScoreDoc`）。
// - 文本格式**只改原文里文字所在的位置**（`convertSourceText`）：有源区间的按区间，没有的按原字符串在原文里认领；
//   改完重新解析，逐片与期望对照，对不上的那处撤回——注释、空白、代码、中文键名（123 的 `标题：`）一字不动。
import type { HanConv, HanDirection } from "../common/hanconv";
import type { ScoreDoc } from "./doc";
import { dolce } from "../common/dolce";
import { adopt, call, docJson, replaceDoc } from "./rustdoc";

/** 所有文字拼起来过一遍繁→简词表：被改动说明含繁体字形 → 转简；否则（纯简体或无中文）→ 转繁。 */
export function detectHanDirection(doc: ScoreDoc, t2s: HanConv): HanDirection {
  return JSON.parse(call(() => dolce().modelHanDirection(docJson(doc).json, t2s))) as HanDirection;
}

/** 就地转换模型里的文字（没有代码区的 MusicXML 用，转完整份重写）。返回改动的片数。 */
export function convertScoreDoc(doc: ScoreDoc, conv: HanConv): number {
  const { json, s } = docJson(doc);
  const r = adopt<{ doc: ScoreDoc; changed: number }>(call(() => dolce().modelHanconvDoc(json, conv)), s);
  replaceDoc(doc, r.doc);
  return r.changed;
}

export interface SourceConvResult {
  text: string;
  /** 改动了的片数 */
  changed: number;
  /** 该转却没能写回原文的片数（找不到位置、或写回后重解析对不上而撤回） */
  missed: number;
}

/** 文本格式的整篇转换：只改原文里文字所在的位置。`parse` 是这个格式的读入（读不出抛错）。 */
export function convertSourceText(text: string, parse: (text: string) => ScoreDoc, conv: HanConv): SourceConvResult {
  return JSON.parse(call(() => dolce().modelHanconvSource(text, (t) => JSON.stringify(parse(t)), conv))) as SourceConvResult;
}
