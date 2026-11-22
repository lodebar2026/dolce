// 简谱识别结果的 TS 门面（私有仓库的自检脚本 `beat-check.mjs`、`omr-fanqie-check.mjs`、`rsdiff/omrjianpu.mjs` 吃 `dolce run` 的产物用）。
// 由 `npm run build:cli` 打成 out/cli/omrfmt.js。识谱命令行本身（出各格式、参照歌词）全在 Rust `dolce`，不经这里。
import "./dolcewasm.node"; // 建模、写出在 dolce-wasm
export { recognizedToDoc } from "../omr/todoc";
export { recognizedBeatIssues } from "../omr/beats";
export { omrEmitter } from "../omr/emit";
