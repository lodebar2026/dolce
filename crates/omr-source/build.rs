//! 找 PDFium 动态库，把所在目录烘进二进制（`DOLCE_PDFIUM_DIR`，运行时第二顺位，见 `src/pdfium.rs::locate`）。
//!
//! 构建号必须与 `Cargo.toml` 里 pdfium-render 的 `pdfium_<构建号>` 特性一致（绑定时按那一版的符号表取函数，差一版就缺符号）。
//! 顺序：环境变量 `PDFIUM_LIB_PATH` → 缓存 `~/.cache/dolce-pdfium/<构建号>/<目标>/` → 从 pdfium-binaries 下载 `chromium/<构建号>` 到缓存。
//! 下载失败不算构建失败（警告一句），运行时找不到库再报错。wasm 目标不走这里（PDFium 的 wasm 版由宿主页面加载）。
use std::path::{Path, PathBuf};
use std::process::Command;

const BUILD: &str = "7881";

fn main() {
    println!("cargo:rerun-if-env-changed=PDFIUM_LIB_PATH");
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.starts_with("wasm32") {
        return;
    }
    if let Ok(p) = std::env::var("PDFIUM_LIB_PATH") {
        export(Path::new(&p).parent().unwrap_or(Path::new(".")));
        return;
    }
    let Some(asset) = asset_of(&target) else {
        println!("cargo:warning=没有 {target} 的 PDFium 预编译包，设 PDFIUM_LIB_PATH");
        return;
    };
    let dir = cache_dir(&target);
    let lib = dir.join(lib_name(&target));
    if !lib.exists() {
        if let Err(e) = download(asset, &dir, &lib_name(&target)) {
            println!("cargo:warning=取 PDFium {BUILD} 失败（{e}），设 PDFIUM_LIB_PATH 或手动放进 {}", dir.display());
            return;
        }
    }
    export(&dir);
}

fn export(dir: &Path) {
    println!("cargo:rustc-env=DOLCE_PDFIUM_DIR={}", dir.display());
    // 直接依赖本 crate 的构建脚本读 `DEP_PDFIUM_DIR`（桌面版 src-tauri 打包时拷库）
    println!("cargo:dir={}", dir.display());
}

fn cache_dir(target: &str) -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    home.join(".cache").join("dolce-pdfium").join(BUILD).join(target)
}

fn asset_of(target: &str) -> Option<&'static str> {
    Some(match target {
        "aarch64-apple-darwin" => "pdfium-mac-arm64",
        "x86_64-apple-darwin" => "pdfium-mac-x64",
        "x86_64-pc-windows-msvc" => "pdfium-win-x64",
        "aarch64-pc-windows-msvc" => "pdfium-win-arm64",
        "x86_64-unknown-linux-gnu" => "pdfium-linux-x64",
        "aarch64-unknown-linux-gnu" => "pdfium-linux-arm64",
        _ => return None,
    })
}

fn lib_name(target: &str) -> String {
    if target.contains("apple") {
        "libpdfium.dylib".into()
    } else if target.contains("windows") {
        "pdfium.dll".into()
    } else {
        "libpdfium.so".into()
    }
}

/// curl + tar（macOS、Windows 10+、Linux 都自带）；包里库在 `lib/`（Windows 在 `bin/`）。
fn download(asset: &str, dir: &Path, lib: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tgz = dir.join("pdfium.tgz");
    let url = format!("https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F{BUILD}/{asset}.tgz");
    let ok = Command::new("curl").args(["-sSfL", "-o"]).arg(&tgz).arg(&url).status().map_err(|e| e.to_string())?;
    if !ok.success() {
        return Err(format!("curl {url}"));
    }
    let ok = Command::new("tar").arg("xzf").arg(&tgz).arg("-C").arg(dir).status().map_err(|e| e.to_string())?;
    if !ok.success() {
        return Err("tar".into());
    }
    for sub in ["lib", "bin"] {
        let p = dir.join(sub).join(lib);
        if p.exists() {
            std::fs::copy(&p, dir.join(lib)).map_err(|e| e.to_string())?;
        }
    }
    let _ = std::fs::remove_file(&tgz);
    if dir.join(lib).exists() { Ok(()) } else { Err(format!("包里没有 {lib}")) }
}
