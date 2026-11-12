//! 打包前把 PDFium 动态库拷进 `pdfium/`（tauri.conf.json 的资源目录；不入库）：库由 crates/omr-source 的构建脚本
//! 找到或下载（固定构建号），经 `links = "pdfium"` 交来 `DEP_PDFIUM_DIR`。
fn main() {
    if let Ok(dir) = std::env::var("DEP_PDFIUM_DIR") {
        let dst = std::path::Path::new("pdfium");
        let _ = std::fs::create_dir_all(dst);
        for name in ["libpdfium.dylib", "pdfium.dll", "libpdfium.so"] {
            let src = std::path::Path::new(&dir).join(name);
            if src.exists() {
                let to = dst.join(name);
                let stale = std::fs::metadata(&to).map(|m| m.len()).ok() != std::fs::metadata(&src).map(|m| m.len()).ok();
                if stale {
                    std::fs::copy(&src, &to).expect("拷 PDFium 动态库");
                }
            }
        }
    }
    tauri_build::build()
}
