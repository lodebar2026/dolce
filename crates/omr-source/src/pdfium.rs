//! PDFium 原生接口的薄封装：只用 pdfium-render 的**绑定层**（`PdfiumLibraryBindings`），不用它的高层对象——
//! 高层封装藏起了原生句柄，而取字形轮廓（`FPDFFont_GetGlyphPath`）、内嵌图解码这些要直接调。
//!
//! PDFium 不是线程安全的：全进程一份绑定，所有调用经 [`with`] 拿锁串行。取数一页一锁、取完就转成 `model` 里的纯数据，
//! 识别在锁外并行。
use pdfium_render::prelude::*;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub(crate) struct Lib {
    pub b: Box<dyn PdfiumLibraryBindings>,
}

static LIB: OnceLock<Result<Mutex<Lib>, String>> = OnceLock::new();
static OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// 指定动态库路径（桌面版从资源目录取）。要在第一次用 PDFium 之前调；回 false 表示已经指定过。
pub fn set_library_path(p: PathBuf) -> bool {
    OVERRIDE.set(p).is_ok()
}

/// 动态库位置：[`set_library_path`] 指定的 → 环境变量 `PDFIUM_LIB_PATH` → 可执行文件同目录 → 构建时找到的目录（`build.rs`）。
fn locate() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = OVERRIDE.get().cloned().into_iter().collect();
    if let Ok(p) = std::env::var("PDFIUM_LIB_PATH") {
        v.push(PathBuf::from(p));
    }
    let name = Pdfium::pdfium_platform_library_name();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.join(&name));
        }
    }
    if let Some(d) = option_env!("DOLCE_PDFIUM_DIR") {
        v.push(PathBuf::from(d).join(&name));
    }
    v
}

fn load() -> Result<Mutex<Lib>, String> {
    let mut errs = Vec::new();
    for p in locate() {
        if !p.exists() {
            continue;
        }
        match Pdfium::bind_to_library(&p) {
            Ok(b) => {
                unsafe { b.FPDF_InitLibrary() };
                return Ok(Mutex::new(Lib { b }));
            }
            Err(e) => errs.push(format!("{}: {e:?}", p.display())),
        }
    }
    Err(if errs.is_empty() { "找不到 PDFium 动态库（设 PDFIUM_LIB_PATH）".into() } else { errs.join("；") })
}

/// 拿锁调 PDFium。
pub(crate) fn with<T>(f: impl FnOnce(&Lib) -> T) -> Result<T, String> {
    let lib = LIB.get_or_init(load).as_ref().map_err(|e| e.clone())?;
    let g = lib.lock().map_err(|_| "PDFium 锁中毒".to_string())?;
    Ok(f(&g))
}
