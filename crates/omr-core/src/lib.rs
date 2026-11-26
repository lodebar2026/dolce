//! 识别的基础层。两条路线（简谱、五线谱）与取数、OCR 各层都只向下依赖它。
//!
//! - [`image`]：二值图、灰度图、矩形
//! - [`geom`]：统计与矩形运算（对应 `src/omrkit/geom.ts`）
//! - [`pixel`]：纯像素内核（连通域、形态学、游程、轮廓、二值化……）
//! - [`js`]：移植期间要与 TS 逐字相同的数值口径（取整、截断、排序；本体在 `dolce-base`）
//! - [`stage`]：阶段产物的落盘缓存（回归从第一个变了的阶段接着跑）
//! - [`progress`]：进度回调与取消标志
//!
//! 并入的共用层（原各自一个 crate）：
//! - [`text`]：两条路线共用的文字处理（和弦文法、页眉分类、歌词切字与对音、词间空格、速度 / 跳转 / 力度词表）
//! - [`sheet`]：谱面元素层（谱表与局部坐标、元素库与证据、归属与互斥、空间查询）
//! - [`todoc`]：识别结果直出 ScoreDoc（简谱 RecognizedScore、五线谱 Score → 模型）
//! - [`ocr`]：PP-OCR 识别与检测的前后处理、推理后端（`native` 原生 ort / `tract` 纯 Rust / 宿主注入）、结果缓存
//! - `source`（`pdf` 特性）：取数层，PDF（PDFium）与图片 → 页面对象、文字、内嵌图原始像素、整页渲染

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
