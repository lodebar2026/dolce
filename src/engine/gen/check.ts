// Rust 生成的类型（ts-rs，`npm run gen:types`）与手写类型的互赋值核对：`tsc` 编到这里就核对，对不上编译报错。
// 迁移期两份并存（手写的是现行代码在用的），每期切换后手写那份删掉、改引生成的，这里对应的行一起删。
import type { Msg, SourceSpan as GenSpan } from "./base.gen";
import type { SourceSpan } from "../../model/doc";
import type { SourceSpan as AstSpan } from "../../jianpu/ast";
import type { ModelMsg } from "../../model/msg";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Sub<A, B> = [A] extends [B] ? true : false;

export const typeChecks: {
  span: Same<GenSpan, SourceSpan>;
  astSpan: Same<GenSpan, AstSpan>;
  /** 手写的 `key` 是 i18n 键的并集，生成的只能是 string：只核手写 → 生成这一向 */
  msg: Sub<ModelMsg, Msg>;
} = { span: true, astSpan: true, msg: true };
