// 模型层的显示名（模型与 CLI 保留中文原名），界面经这里按语言取。
import type { ConvertTarget } from "../convert/targets";
import { t } from "./index";
import { msgText, type ModelMsg } from "../model/msg";

/** 另存为 / 格式下拉里的目标格式名。 */
export function targetLabel(id: ConvertTarget): string {
  return t(`fmt.target.${id}` as const);
}

/** 文本谱方言名（`Dialect` 与 `ConvertTarget` 的 tomato/shige 同名）。 */
export function dialectLabel(dialect: "tomato" | "shige"): string {
  return t(`fmt.target.${dialect}` as const);
}

/** 诊断显示文字：按当前界面语言出（诊断只带键与参数，没有原文回退）。 */
export const diagText = (d: { readonly msg: ModelMsg }): string => msgText(d.msg);
