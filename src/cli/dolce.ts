// Node 门面：**签名同 `j123.js`**，回归脚本把 `import … from "out/cli/j123.js"` 换成 `dolce.js` 就吃到 Rust。
// 迁移各期把已迁的函数在这里改由 dolce-wasm 实现（照 TS 的签名包一层），没迁的照转 TS；切换期删 TS 时这里跟着收口。
// 另挂 `rs`：wasm 本身（版本、对拍原料、会话），dev `rs-diff.mjs` 用。
//
// wasm 在 web/public/redist/dolce/（`npm run build:wasm` 或 `vite build` 时编），按本文件位置找：out/cli/ → ../../public/redist/dolce/。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DolceWasm } from "../engine/dolcewasm";

export * from "./j123";

const dir = new URL("../../public/redist/dolce/", import.meta.url);
const glue = new URL("dolce_wasm.js", dir);
const bin = new URL("dolce_wasm_bg.wasm", dir);
if (!existsSync(fileURLToPath(bin))) throw new Error(`缺 ${fileURLToPath(bin)} —— 先 \`npm run build:wasm\``);
const wasm = (await import(/* @vite-ignore */ pathToFileURL(fileURLToPath(glue)).href)) as DolceWasm;
wasm.initSync({ module: readFileSync(fileURLToPath(bin)) });

/** dolce-wasm 本身（迁移期对拍用） */
export const rs: Omit<DolceWasm, "default" | "initSync"> = wasm;
