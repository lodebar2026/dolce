// OMR 的推理运行时注入点：把「模型/字典从哪来、用什么跑」从 paddleocr.ts 里剥出去，
// 让识别管线本身不绑浏览器。现在只剩 `runtime.node.ts`（onnxruntime-node，回归脚本用）；
// 浏览器那份随编辑器识别改走 Rust 删了（P12），整套 TS 识别 P13 删。
// 第三条路 Tauri 原生 OCR 不在这里——它绕开 session 直接 IPC 把张量交给 Rust，
// 见 paddleocr.ts::nativeOcr。
//
// 装配：Node 侧由 `cli/omr.ts` 显式设。
// **`runtime.node.ts` 绝不能进浏览器入口的 import 链**，否则打包会把 fs 拖进浏览器产物。

export interface OmrRunOut {
  data: Float32Array;
  dims: number[];
}

export interface OmrRuntime {
  /** 预加载某个模型（浏览器侧在「开始识别」时就拉起 session，免首次推理时才等 21MB 模型）。 */
  prepare(model: "rec" | "det"): Promise<void>;
  /** 跑一次推理。`model` 选 rec（识别）或 det（文本检测）；det 由实现懒加载。
   *  实现可按 `dims` 自行挑 session（原生下线程数最优值随张量形状反转，见 docs）。 */
  run(model: "rec" | "det", chw: Float32Array, dims: number[]): Promise<OmrRunOut>;
  /** PP-OCR 字符表原文（每行一个字符）。 */
  loadDict(): Promise<string>;
}

let _rt: OmrRuntime | null = null;

export function setOmrRuntime(rt: OmrRuntime): void {
  _rt = rt;
}

export function omrRuntime(): OmrRuntime {
  if (!_rt) throw new Error("OMR 运行时未装配：浏览器侧应先 installBrowserOmr()，Node 侧应先 setOmrRuntime()");
  return _rt;
}
