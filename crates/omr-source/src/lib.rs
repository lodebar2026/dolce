//! 取数层：PDF（PDFium）与图片 → 页面内容（内嵌图原始像素、路径、文字层与字形轮廓）、整页渲染。
//!
//! - [`model`]：交出的纯数据（页面点、左上原点、y 向下）
//! - [`pdf`]：PDF 文档（`PdfDoc::open` → `content` / `render`）
//! - [`raster`]：位图识别的取图（最大内嵌图 / 拼图页 / 图片文件 → 摆正的灰度原图）与二值化
//! - `pdfium`：原生接口的薄封装与全进程一把锁（PDFium 不是线程安全的）
//!
//! PDFium 动态库的构建号要与 `Cargo.toml` 里 pdfium-render 的 `pdfium_<构建号>` 特性一致（现 7881，见 `build.rs`）。
//! `examples/` 里是能力验证用的探针。

pub mod model;
pub mod pdf;
pub mod raster;
pub mod vector;
mod pdfium;
pub use pdfium::set_library_path;

pub use model::*;
pub use pdf::{ContentOpts, PdfDoc, Rendered};
