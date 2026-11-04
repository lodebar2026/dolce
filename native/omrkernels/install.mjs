// cargo 编出的动态库 → native/omrkernels/omrkernels.node（Node 侧像素内核从这里加载，见 src/cli/omrkernels.node.ts）。
// 用法：npm run build:native
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = { darwin: "libdolce_omrkernels.dylib", win32: "dolce_omrkernels.dll", linux: "libdolce_omrkernels.so" }[process.platform];
if (!lib) {
  console.log(`omrkernels：${process.platform} 不编原生像素内核，Node 侧走 TS 实现`);
  process.exit(0);
}
const src = join(here, "target", "release", lib);
if (!existsSync(src)) {
  console.error(`没有 ${src}，先 cargo build --release`);
  process.exit(1);
}
copyFileSync(src, join(here, "omrkernels.node"));
console.log(`omrkernels.node ← ${lib}`);
