// Node 宿主载 dolce-wasm（out/cli 各入口、vitest 的 setup 都 import 它；网页在 `main.ts::loadDolce`）。
// wasm 找两处：同目录 `dolce/`（识谱命令行分发包，`scripts/pack-omr.mjs` 拷进去）、仓库的 `public/redist/dolce/`
// （本文件在 src/cli/ 或打包后的 out/cli/，往上两级都是 web 根）。`npm run build:wasm` 产出。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DolceWasm } from "../common/dolcewasm";
import { setDolce } from "../common/dolce";

const dirs = [new URL("./dolce/", import.meta.url), new URL("../../public/redist/dolce/", import.meta.url)];
const dir = dirs.find((d) => existsSync(fileURLToPath(new URL("dolce_wasm_bg.wasm", d))));
if (!dir) throw new Error(`缺 dolce-wasm（${dirs.map((d) => fileURLToPath(d)).join("、")}）—— 先 \`npm run build:wasm\``);
const wasm = (await import(/* @vite-ignore */ pathToFileURL(fileURLToPath(new URL("dolce_wasm.js", dir))).href)) as DolceWasm;
wasm.initSync({ module: readFileSync(fileURLToPath(new URL("dolce_wasm_bg.wasm", dir))) });
setDolce(wasm);

export const dolceWasm: DolceWasm = wasm;
