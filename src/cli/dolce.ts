// Node 门面：**签名同 `j123.js`**，回归脚本把 `import … from "out/cli/j123.js"` 换成 `dolce.js` 就吃到 Rust。
// 迁移各期把已迁的函数改由 dolce-wasm 实现（M1 起 j123 本身就经 wasm：演唱顺序、断句、时间轴、MIDI、jcx 编解码），
// 没迁的照转 TS；切换期删 TS 时这里跟着收口。另挂 `rs`：wasm 本身（版本、会话）；对拍探针在另一份（`build-wasm.mjs probe`）。
import type { DolceWasm } from "../common/dolcewasm";
import { dolceWasm } from "./dolcewasm.node";

export * from "./j123";

/** dolce-wasm 本身 */
export const rs: Omit<DolceWasm, "default" | "initSync"> = dolceWasm;
