//! 两件事，按特性开：
//!
//! - `native`（OCR 走 onnxruntime）：macOS 上 `ort` 预编译的 onnxruntime 里 CoreML 那几处用了 `@available`，要 clang 运行时库里的
//!   `__isPlatformVersionAtLeast`，而 rustc 链接时不带它（`-nodefaultlibs`），补链 `libclang_rt.osx.a`。
//! - `pdf`（取数层 `source`）：找 PDFium 动态库，把所在目录烘进二进制（`DOLCE_PDFIUM_DIR`，运行时第二顺位，见 `src/source/pdfium.rs::locate`）。
//!   构建号必须与 `Cargo.toml` 里 pdfium-render 的 `pdfium_<构建号>` 特性一致（绑定时按那一版的符号表取函数，差一版就缺符号）。
//!   顺序：环境变量 `PDFIUM_LIB_PATH` → 缓存 `~/.cache/dolce-pdfium/<构建号>/<目标>/` → 从 pdfium-binaries 下载 `chromium/<构建号>` 到缓存。
//!   下载失败不算构建失败（警告一句），运行时找不到库再报错。wasm 目标不走这里（PDFium 的 wasm 版由宿主页面加载）。
use std::path::{Path, PathBuf};
use std::process::Command;

const BUILD: &str = "7881";

fn main() {
    clang_rt();
    if std::env::var_os("CARGO_FEATURE_PDF").is_some() {
        pdfium();
    }
}

fn clang_rt() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("apple-darwin") || std::env::var("CARGO_FEATURE_NATIVE").is_err() {
        return;
    }
    let Ok(out) = Command::new("clang").arg("--print-resource-dir").output() else { return };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let lib = format!("{dir}/lib/darwin");
    if Path::new(&lib).join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={lib}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}

fn pdfium() {
    println!("cargo:rerun-if-env-changed=PDFIUM_LIB_PATH");
    if std::env::var_os("DOCS_RS").is_some() {
        return;
    }
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
