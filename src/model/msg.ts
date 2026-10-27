// 模型层交给界面的提示：**只给键与参数，不翻译**。翻成哪种语言是界面层的事——
// `i18n/index.ts` 加载时用 `setMsgTranslator` 注册翻译函数，界面显示时 `msgText(m)` 取当前语言的文字。
// 这样模型层（`edit.ts` 的报错、`ModelError`）对 i18n 只有类型依赖（`MsgKey`），CLI 与无头脚本不必为报错带上词典。

import type { MsgKey } from "../i18n";

/** 参数值可以是另一条提示（`me.crossBar` 的声部名缺省是「另一声部」，也要按语言出）。 */
export type MsgArgs = Readonly<Record<string, string | number | ModelMsg>>;

export interface ModelMsg {
  readonly key: MsgKey;
  readonly args?: MsgArgs;
}

export const msg = (key: MsgKey, args?: MsgArgs): ModelMsg => (args ? { key, args } : { key });

/** 没注册翻译函数时（只加载了模型层）给键本身。 */
let translate: (m: ModelMsg) => string = (m) => m.key;

export function setMsgTranslator(fn: (m: ModelMsg) => string): void {
  translate = fn;
}

/** 一条提示按当前语言的文字。 */
export function msgText(m: ModelMsg): string {
  return translate(m);
}

/** 模型层抛的错：带一条提示，`message` 按显示时的语言取（各处 `catch` 照旧读 `e.message`）。 */
export class ModelError extends Error {
  constructor(readonly msg: ModelMsg) {
    super();
    Object.defineProperty(this, "message", { get: () => translate(msg), enumerable: false, configurable: true });
  }
}
