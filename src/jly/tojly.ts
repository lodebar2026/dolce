// jianpu-ly 写出端：投影（简谱形状 / `.jpwabc`）与写出都在 Rust（crates/dolce-formats/src/jly/input.rs、emit.rs，wasm `jlyEmit`），这里是门面。
// 口径（目标语法只认上游 README、歌词位置与圆滑线的四条实测口径、装不下的写进 `%` 注释）见 emit.rs 文件头。

import { dolce } from "../common/dolce";
import type { ScoreDoc } from "../model/doc";
import { call } from "../model/rustdoc";

/** 导出结果：文本 + 装不下的东西（已写进文本开头的 `%` 注释） */
export interface JlyExport {
  text: string;
  warnings: string[];
}

/** `ScoreDoc` → jianpu-ly 文本。投影不出来时抛 `noLines`（与其它写出端一致，调用方翻成界面文案） */
export function emitJly(doc: ScoreDoc): JlyExport {
  return JSON.parse(call(() => dolce().jlyEmit(JSON.stringify(doc)))) as JlyExport;
}
