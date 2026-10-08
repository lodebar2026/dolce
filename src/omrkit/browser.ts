// 浏览器侧装配：OCR 推理运行时（onnxruntime-web）+ 图片 / PDF 解码器。
// 三路的浏览器入口（`omr/index.ts`、`rasteromr/browser.ts`）各自调一次，幂等——不靠谁先 import 了谁的副作用。
// Node 侧不走这里：`cli/omr.ts` 自己 `setOmrRuntime(nodeRuntime)` + `installNodeDecoder()`。
import { setOmrRuntime } from "./runtime";
import { browserRuntime } from "./runtime.browser";
import { installBrowserDecoder } from "./decode.browser";

let installed = false;

export function installBrowserOmr(): void {
  if (installed) return;
  installed = true;
  setOmrRuntime(browserRuntime);
  installBrowserDecoder();
}
