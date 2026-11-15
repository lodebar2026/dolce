// src/omr：识别结果的落地。识别本身在 Rust（`crates/`，编辑器经 `omrrust/engine.ts` 调），
// 这里只有结果类型、转 ScoreDoc 与各格式的写出端、核对视图的画法（简谱 overlay、五线谱 staffoverlay / review）。

export * from "./types";
export { recognizedToDoc } from "./todoc";
export { keyNameOf, fanqieArcLosses } from "../fanqie/tofanqie";
export { metaFrom123, metaFromFanqie } from "./meta";
export { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter } from "./emit";
export type { OmrFormat, ScoreEmitter, EmittedScore } from "./emit";
export { createSurface, surfaceFromBinary, blit } from "./surface";
export type { Surface } from "./surface";
export { renderRecognitionSvg, renderRowPopup, renderHeaderPopup, renderRowSource } from "./overlay";
export type { RecogView } from "./overlay";
