//! macOS：`ort` 预编译的 onnxruntime 里 CoreML 那几处用了 `@available`，要 clang 运行时库里的 `__isPlatformVersionAtLeast`，
//! 而 rustc 链接时不带它（`-nodefaultlibs`），补链 `libclang_rt.osx.a`。
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("apple-darwin") || std::env::var("CARGO_FEATURE_NATIVE").is_err() {
        return;
    }
    let Ok(out) = std::process::Command::new("clang").arg("--print-resource-dir").output() else { return };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let lib = format!("{dir}/lib/darwin");
    if std::path::Path::new(&lib).join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={lib}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
