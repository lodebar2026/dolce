//! 识别的基础层。两条路线（简谱、五线谱）与取数、OCR 各层都只向下依赖它。
//!
//! - [`image`]：二值图、灰度图、矩形
//! - [`geom`]：统计与矩形运算（对应 `src/omrkit/geom.ts`）
//! - [`pixel`]：纯像素内核（连通域、形态学、游程、轮廓、二值化……）
//! - [`js`]：移植期间要与 TS 逐字相同的数值口径（取整、截断、排序）
//! - [`stage`]：阶段产物的落盘缓存（回归从第一个变了的阶段接着跑）
//! - [`progress`]：进度回调与取消标志

pub mod geom;
pub mod image;
pub mod js;
pub mod pixel;
pub mod progress;
pub mod stage;
