//! 取数层（迁移中）。现在只有 PDFium 能力验证用的探针（`examples/`）：
//!
//! - `rawglyph`：逐字按 Unicode 值取字形轮廓（直接调原生接口；pdfium-render 的 `glyphs()` 对符号字体失效）
//! - `images`：内嵌图的过滤器、位深、页上矩阵，取未重采样的原图
//!
//! 跑法：`PDFIUM_LIB_PATH=<libpdfium> cargo run --release -p dolce-omr-source --example rawglyph -- 文件.pdf [页]`。
//! 动态库的构建号要与 `Cargo.toml` 里 pdfium-render 的 `pdfium_<构建号>` 特性一致（现在是 7881）。
