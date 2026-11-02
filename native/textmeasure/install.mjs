// cargo 编出的动态库 → native/textmeasure/textmeasure.node（Node 侧量字从这里加载，见 src/cli/textmeasure.node.ts）。
// 用法：npm run build:native
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = { darwin: "libdolce_textmeasure.dylib", win32: "dolce_textmeasure.dll" }[process.platform];
if (!lib) {
  console.log(`textmeasure：${process.platform} 不编原生量字，Node 侧走字体文件后端`);
  process.exit(0);
}
const src = join(here, "target", "release", lib);
if (!existsSync(src)) {
  console.error(`没有 ${src}，先 cargo build --release`);
  process.exit(1);
}
copyFileSync(src, join(here, "textmeasure.node"));
console.log(`textmeasure.node ← ${lib}`);
