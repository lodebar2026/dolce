// 源格式之间的**转换目标注册表**：同一份 `ScoreDoc` 能写成哪几种可编辑的文本格式。
//
// 用它的有三处，以前各列各的：识别结果的输出格式（`omr/emit.ts`）、打开文件后在代码区标题栏切格式
// （`editor/formatswitch.ts`）、另存为别的源格式（`App.saveAsFormat`）。加一种目标格式 = 往这里补一项。
// 无 DOM 依赖（Node CLI 与回归脚本也用）。

import type { ScoreDoc } from "./doc";
import type { TargetFormat } from "./capability";
import { emit123 } from "../j123/emit";
import { emitAbc } from "../abcfamily/emitabc.entry";
import { emitJpwabc } from "./tojpw";
import { emitJly } from "./tojly";
import { emitPu } from "./topu";
import { withPageMeta } from "./pagemeta";
import { t } from "../i18n";

/** 可写出的文本格式。文本谱两种方言各算一种。 */
export type ConvertTarget = "123" | "abc" | "jpwabc" | "tomato" | "shige" | "jly";

export interface TargetSpec {
  id: ConvertTarget & TargetFormat;
  /** 下拉里的显示名（按界面语言） */
  readonly label: string;
  /** 写出来的文本在编辑器里按哪种源格式打开（`editor/formats.ts::DocFormatId`） */
  docFormat: "123" | "abc" | "jpwabc" | "pu" | "jly";
  emit(doc: ScoreDoc): string;
}

/** 顺序即下拉里的顺序；第一项是识别的默认输出格式。 */
export const CONVERT_TARGETS: readonly TargetSpec[] = [
  // 123 / ABC 把 MusicXML 的纸写成 `I:meta page …`（`pagemeta.ts`），转过去再打开纸不丢
  { id: "123", get label() { return t("fmt.target.123"); }, docFormat: "123", emit: (doc) => emit123(withPageMeta(doc)) },
  {
    id: "jpwabc",
    get label() { return t("fmt.target.jpwabc"); },
    docFormat: "jpwabc",
    emit: (doc) => {
      const text = emitJpwabc(doc);
      if (text === null) throw new Error(t("err.noLines"));
      return text;
    },
  },
  { id: "abc", get label() { return t("fmt.target.abc"); }, docFormat: "abc", emit: (doc) => emitAbc(withPageMeta(doc)) },
  { id: "tomato", get label() { return t("fmt.target.tomato"); }, docFormat: "pu", emit: (doc) => emitPu(doc, "tomato") },
  { id: "shige", get label() { return t("fmt.target.shige"); }, docFormat: "pu", emit: (doc) => emitPu(doc, "shige") },
  // jianpu-ly：能读能写，导出端是 `tojly.ts`（`%` 注释里带着"装不下什么"的说明，写在文本里随文件走）
  { id: "jly", get label() { return t("fmt.target.jly"); }, docFormat: "jly", emit: (doc) => emitJly(doc).text },
];

export function isConvertTarget(v: unknown): v is ConvertTarget {
  return CONVERT_TARGETS.some((t) => t.id === v);
}

export function targetSpec(id: ConvertTarget): TargetSpec {
  return CONVERT_TARGETS.find((t) => t.id === id) ?? CONVERT_TARGETS[0]!;
}
