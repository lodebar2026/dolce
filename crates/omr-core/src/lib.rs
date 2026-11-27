//! 悦谱 Dolce 识别（OMR）的共用底层。简谱、五线谱两条路线与取数、OCR 各层都只向下依赖它；不开特性时没有平台依赖，能编到 `wasm32`。
//!
//! > 内部实现；外部请用识别的对外入口 [`dolce-omr`](https://docs.rs/dolce-omr)。
//!
//! ## 模块
//!
//! - [`image`]：二值图、灰度图、矩形
//! - [`geom`]：统计与矩形运算
//! - [`pixel`]：纯像素内核（连通域、形态学、游程、轮廓、二值化等）
//! - [`js`]：与前端保持一致的数值口径（取整、截断、排序；本体在 `dolce_model::base::js`）
//! - [`stage`]：阶段产物的落盘缓存（回归从第一个变了的阶段接着跑）
//! - [`progress`]：进度回调与取消标志
//! - [`text`]：两条路线共用的文字处理（和弦文法、页眉分类、歌词切字与对音、词间空格、速度 / 跳转 / 力度词表）
//! - [`sheet`]：谱面元素层（谱表与局部坐标、元素库与证据、归属与互斥、空间查询）
//! - [`todoc`]：识别结果直出 `ScoreDoc`（简谱 `RecognizedScore`、五线谱 `Score` → 模型）
//! - [`ocr`]：PP-OCR 识别与检测的前后处理、推理后端与结果缓存
//! - `source`（`pdf` 特性）：取数层，PDF（PDFium）与图片 → 页面对象、文字、内嵌图原始像素、整页渲染
//!
//! ## 特性
//!
//! - `native`：OCR 推理走原生 ONNX Runtime（`ort`）。
//! - `tract`：OCR 推理走纯 Rust `tract-onnx`（网页 wasm）。
//! - `pdf`：`source` 模块，经 PDFium 读 PDF 与图片。
//!
//! 各模块的判据见仓库 `docs/模块/识别-Rust.md`。

#![cfg_attr(docsrs, feature(doc_cfg))]

pub mod geom;
pub mod image;
pub use dolce_model::base::js;
pub mod pixel;
pub mod progress;
pub mod stage;

pub mod ocr;
pub mod sheet;
#[cfg(feature = "pdf")]
pub mod source;
pub mod text;
pub mod todoc;
