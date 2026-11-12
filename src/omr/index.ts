// src/omr 公共入口：简谱图像识别（OMR）。
// 编辑器只用它的结果类型、核对视图的画法与输出格式；识别本身在 Rust（`omrrust/engine.ts`），这里不再装浏览器运行时与解码器。

export * from "../omrkit/types";
export { rgbaToBinary, toGray } from "../omrkit/preprocess";
export { connectedComponents } from "../omrkit/ccl";
export { recognizeJianpu } from "./jianpu";
export { recognizedToDoc } from "./todoc";
export { keyNameOf, fanqieArcLosses } from "../fanqie/tofanqie";
export { metaFrom123, metaFromFanqie } from "./meta";
export { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter } from "./emit";
export type { OmrFormat, ScoreEmitter, EmittedScore } from "./emit";
export type { OcrBackend } from "../omrkit/ocr";
export { nullOcr } from "../omrkit/ocr";
export { decodeToBinary } from "../omrkit/decode";
export { paddleOcrBackend } from "../omrkit/paddleocr";
export { recognizeMusicppDetailed } from "./recognize";
export type { MusicppDetail } from "./recognize";
export { buildStrip } from "./lyrics";
export { createSurface, surfaceFromBinary, blit } from "../omrkit/surface";
export type { Surface } from "../omrkit/surface";
export { renderRecognitionSvg, renderRowPopup, renderHeaderPopup, renderRowSource } from "./overlay";
export type { RecogView } from "./overlay";

export { setOmrRuntime } from "../omrkit/runtime";
export type { OmrRuntime } from "../omrkit/runtime";
