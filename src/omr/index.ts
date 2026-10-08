// src/omr 公共入口：简谱图像识别（OMR）。
// 副作用：装配浏览器运行时（ort-web）与解码器（`omrkit/browser.ts`）。Node CLI 不走这个入口，自己 setOmrRuntime(nodeRuntime)。
import { installBrowserOmr } from "../omrkit/browser";
installBrowserOmr();

export * from "../omrkit/types";
export { binarize, rgbaToBinary, toGray, otsuThreshold } from "../omrkit/preprocess";
export { connectedComponents } from "../omrkit/ccl";
export { recognizeJianpu } from "./jianpu";
export { recognizedToDoc } from "./todoc";
export { keyNameOf, puArcLosses } from "../model/topu";
export { metaFrom123, metaFromPu } from "./meta";
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
