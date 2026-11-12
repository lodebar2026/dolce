// 网页版识别的 wasm（crates/omr-wasm）与 PDFium 的 wasm 版 → public/redist/omr/（不入库）。
// vite 的 dev 与 build 开头调它（vite.config.ts）；桌面版（Tauri 的 before 命令带 TAURI_ENV_PLATFORM）与设了 DOLCE_NO_WASM 的跳过。
//
// 要：rustup target add wasm32-unknown-unknown；cargo install wasm-bindgen-cli --version <与 crates/Cargo.lock 一致>。
// 有 wasm-opt（binaryen）就再压一遍。源码没变就不重来（比 crates/ 下源码与 public/redist/omr/ 产物的修改时间）。
// PDFium 的构建号与 crates/omr-source/build.rs 同一个（绑定按那一版的符号表取函数）。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crates = join(root, "crates");
const out = join(root, "public/redist/omr");
const PDFIUM_BUILD = "7881";
const NAME = "dolce_omr_wasm";

function newest(dir, acc = 0) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name.startsWith("target-") || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) acc = newest(p, acc);
    else if (/\.(rs|toml|lock)$/.test(e.name)) acc = Math.max(acc, statSync(p).mtimeMs);
  }
  return acc;
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function has(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Cargo.lock 里 wasm-bindgen 的版本（CLI 要同一版）。 */
function bindgenVersion() {
  const lock = readFileSync(join(crates, "Cargo.lock"), "utf8");
  return /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1] ?? "?";
}

function buildOmr() {
  const stamp = join(out, `${NAME}_bg.wasm`);
  if (existsSync(stamp) && statSync(stamp).mtimeMs > Math.max(newest(crates), statSync(fileURLToPath(import.meta.url)).mtimeMs)) return;
  const want = bindgenVersion();
  const got = has("wasm-bindgen") ? execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(" ")[1] : null;
  if (got !== want) throw new Error(`要 wasm-bindgen-cli ${want}（现在 ${got ?? "没有"}）：cargo install wasm-bindgen-cli --version ${want}`);
  console.log("[build-wasm] 编 omr-wasm …");
  run("cargo", ["build", "-p", "dolce-omr-wasm", "--release", "--target", "wasm32-unknown-unknown"], {
    cwd: crates,
    env: { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} -C target-feature=+simd128`.trim() },
  });
  mkdirSync(out, { recursive: true });
  const wasm = join(crates, `target/wasm32-unknown-unknown/release/${NAME}.wasm`);
  // 去掉名字段（30 → 21 MB；panic 信息照打，只是栈上没函数名）
  run("wasm-bindgen", [wasm, "--target", "web", "--no-typescript", "--remove-name-section", "--remove-producers-section", "--out-dir", out]);
  if (has("wasm-opt")) run("wasm-opt", ["-O2", "--enable-simd", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals", stamp, "-o", stamp]);
}

/** pdfium-binaries 的 wasm 包（pdfium.js + pdfium.wasm），缓存在 ~/.cache/dolce-pdfium/<构建号>/wasm/。 */
function fetchPdfium() {
  if (existsSync(join(out, "pdfium.wasm")) && existsSync(join(out, "pdfium.js"))) return;
  const cache = join(process.env.PDFIUM_WASM_DIR ?? join(homedir(), ".cache/dolce-pdfium", PDFIUM_BUILD, "wasm"));
  const lib = join(cache, "lib");
  if (!existsSync(join(lib, "pdfium.wasm"))) {
    mkdirSync(cache, { recursive: true });
    const tgz = join(cache, "pdfium.tgz");
    console.log(`[build-wasm] 取 PDFium ${PDFIUM_BUILD} 的 wasm 版 …`);
    run("curl", ["-sSfL", "-o", tgz, `https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${PDFIUM_BUILD}/pdfium-wasm.tgz`]);
    run("tar", ["xzf", tgz, "-C", cache]);
    rmSync(tgz);
  }
  mkdirSync(out, { recursive: true });
  for (const f of ["pdfium.js", "pdfium.wasm"]) copyFileSync(join(lib, f), join(out, f));
  writeFileSync(join(out, "PDFIUM_VERSION"), PDFIUM_BUILD);
}

export function buildWasm() {
  if (process.env.TAURI_ENV_PLATFORM || process.env.DOLCE_NO_WASM) return;
  buildOmr();
  fetchPdfium();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildWasm();
