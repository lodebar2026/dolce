// 模型层的显示名（模型与 CLI 保留中文原名），界面经这里按语言取。
import type { ConvertTarget } from "../convert/targets";
import { t, tOpt } from "./index";

/** 另存为 / 格式下拉里的目标格式名。 */
export function targetLabel(id: ConvertTarget): string {
  return t(`fmt.target.${id}` as const);
}

/** 文本谱方言名（`Dialect` 与 `ConvertTarget` 的 tomato/shige 同名）。 */
export function dialectLabel(dialect: "tomato" | "shige"): string {
  return t(`fmt.target.${dialect}` as const);
}

/** 诊断显示文字：有 `diag.<code>` 译文用译文（`args` 填占位），否则回落解析器原文。 */
export interface DiagLike {
  code?: string;
  message: string;
  args?: Readonly<Record<string, string | number>>;
  source: { line: number };
}
export function diagText(d: Omit<DiagLike, "source">): string {
  return (d.code && tOpt(`diag.${d.code}`, d.args as Record<string, string | number> | undefined)) || d.message;
}
