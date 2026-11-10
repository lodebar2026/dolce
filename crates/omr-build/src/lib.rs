//! 构建脚本用：给阶段算**代码指纹**（阶段缓存键的一部分，见 `omr-core::stage`）。
//!
//! 在 crate 的 `build.rs` 里：
//! ```ignore
//! dolce_omr_build::fingerprint("STAFF_M1", &["src/frame", "../omr-sheet/src", "../omr-core/src"]);
//! ```
//! 代码里 `env!("OMR_CODE_STAFF_M1")` 取出。列出的目录（递归，只认 `.rs`）任一文件内容变了指纹就变，
//! cargo 也会因 `rerun-if-changed` 重跑构建脚本。上游 crate 的源码目录要一并列上——上游改了判据，下游阶段的缓存也得失效。
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// 算一组目录的指纹，导出成编译期环境变量 `OMR_CODE_<name>`。
pub fn fingerprint(name: &str, dirs: &[&str]) {
    let fp = hash_dirs(dirs.iter().map(Path::new));
    println!("cargo:rustc-env=OMR_CODE_{name}={fp}");
    for d in dirs {
        println!("cargo:rerun-if-changed={d}");
    }
}

/// 目录下所有 `.rs` 文件（按相对路径排序）的路径与内容合成的指纹，取前 16 个十六进制字符。
pub fn hash_dirs<'a>(dirs: impl IntoIterator<Item = &'a Path>) -> String {
    let mut h = Sha256::new();
    for d in dirs {
        let mut files = Vec::new();
        collect(d, &mut files);
        files.sort();
        for f in files {
            let rel = f.strip_prefix(d).unwrap_or(&f).to_string_lossy().replace('\\', "/");
            h.update(d.to_string_lossy().as_bytes());
            h.update([0]);
            h.update(rel.as_bytes());
            h.update([0]);
            h.update(fs::read(&f).unwrap_or_default());
            h.update([0]);
        }
    }
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        if dir.extension().is_some_and(|e| e == "rs") {
            out.push(dir.to_path_buf());
        }
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|e| e == "rs") {
            out.push(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_with_content_and_ignores_other_files() {
        let d = std::env::temp_dir().join(format!("dolce-fp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("a.rs"), "fn a() {}").unwrap();
        fs::write(d.join("sub/b.rs"), "fn b() {}").unwrap();
        let h1 = hash_dirs([d.as_path()]);
        fs::write(d.join("notes.md"), "x").unwrap();
        assert_eq!(h1, hash_dirs([d.as_path()]));
        fs::write(d.join("sub/b.rs"), "fn b() { 1; }").unwrap();
        assert_ne!(h1, hash_dirs([d.as_path()]));
        let _ = fs::remove_dir_all(&d);
    }
}
