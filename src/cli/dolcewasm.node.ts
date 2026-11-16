// Node 宿主载 dolce-wasm 与 dolce-jcx-wasm（out/cli 各入口、vitest 的 setup 都 import 它；网页在 `main.ts::loadDolce`）。
// wasm 找两处：同目录 `dolce/`（识谱命令行分发包，`scripts/pack-omr.mjs` 拷进去）、仓库的 `public/redist/dolce/`
// （本文件在 src/cli/ 或打包后的 out/cli/，往上两级都是 web 根）。`npm run build:wasm` 产出。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DolceWasm, JcxWasm } from "../common/dolcewasm";
import { setDolce } from "../common/dolce";
import { setJcx } from "../common/jcx";

const dirs = [new URL("./dolce/", import.meta.url), new URL("../../public/redist/dolce/", import.meta.url)];
const dir = dirs.find((d) => existsSync(fileURLToPath(new URL("dolce_wasm_bg.wasm", d))));
if (!dir) throw new Error(`缺 dolce-wasm（${dirs.map((d) => fileURLToPath(d)).join("、")}）—— 先 \`npm run build:wasm\``);
async function load<T extends { initSync(init: { module: BufferSource }): object }>(name: string): Promise<T> {
  const w = (await import(/* @vite-ignore */ pathToFileURL(fileURLToPath(new URL(`${name}.js`, dir))).href)) as T;
  w.initSync({ module: readFileSync(fileURLToPath(new URL(`${name}_bg.wasm`, dir))) });
  return w;
}
const wasm = await load<DolceWasm>("dolce_wasm");
setDolce(wasm);
// .jcx 编解码那份（网页按需载；Node 不在乎开机多读两百 KB，一起载好、各处同步调）
setJcx(await load<JcxWasm>("dolce_jcx_wasm"));

export const dolceWasm: DolceWasm = wasm;
