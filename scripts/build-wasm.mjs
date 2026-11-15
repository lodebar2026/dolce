// 网页版识别的 wasm（crates/omr-wasm）与 PDFium 的 wasm 版 → public/redist/omr/；
// 模型 / 格式 / 排版的 wasm（crates/dolce-wasm，迁 Rust 进行中）→ public/redist/dolce/（Node 门面 out/cli/dolce.js 也载这一份）。都不入库。
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
const DOLCE_OUT = join(root, "public/redist/dolce");
const DOLCE_NAME = "dolce_wasm";

function newest(dir, acc = 0, only = null) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (only && dir === crates && e.isDirectory() && !only(e.name)) continue;
    if (e.name === "target" || e.name.startsWith("target-") || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) acc = newest(p, acc, only);
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

/** 两份：`dolce_omr_wasm` 只用 simd128（Safari 没有 relaxed-simd）；`dolce_omr_wasm_relaxed` 另开 relaxed-simd——tract 的矩阵内核
 *  改用融合乘加，Chromium 里 OCR 快一成多。Worker 按浏览器支持挑一份（`worker.ts::loadOmr`）。两份各用自己的 target 目录，免得来回全量重编。 */
const VARIANTS = [
  { name: NAME, features: "+simd128", target: "target", opt: [] },
  { name: `${NAME}_relaxed`, features: "+simd128,+relaxed-simd", target: "target/wasm-relaxed", opt: ["--enable-relaxed-simd"] },
];

function checkBindgen() {
  const want = bindgenVersion();
  const got = has("wasm-bindgen") ? execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(" ")[1] : null;
  if (got !== want) throw new Error(`要 wasm-bindgen-cli ${want}（现在 ${got ?? "没有"}）：cargo install wasm-bindgen-cli --version ${want}`);
}

function buildOmr() {
  const srcTime = Math.max(newest(crates), statSync(fileURLToPath(import.meta.url)).mtimeMs);
  const todo = VARIANTS.filter((v) => {
    const stamp = join(out, `${v.name}_bg.wasm`);
    return !(existsSync(stamp) && statSync(stamp).mtimeMs > srcTime);
  });
  if (!todo.length) return;
  checkBindgen();
  mkdirSync(out, { recursive: true });
  for (const v of todo) {
    console.log(`[build-wasm] 编 omr-wasm（${v.features}）…`);
    const target = join(crates, v.target);
    run("cargo", ["build", "-p", "dolce-omr-wasm", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target], {
      cwd: crates,
      env: { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} -C target-feature=${v.features}`.trim() },
    });
    const wasm = join(target, `wasm32-unknown-unknown/release/${NAME}.wasm`);
    // 去掉名字段（30 → 21 MB；panic 信息照打，只是栈上没函数名）
    run("wasm-bindgen", [wasm, "--target", "web", "--no-typescript", "--remove-name-section", "--remove-producers-section", "--out-dir", out, "--out-name", v.name]);
    const stamp = join(out, `${v.name}_bg.wasm`);
    if (has("wasm-opt")) run("wasm-opt", ["-O2", "--enable-simd", ...v.opt, "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals", stamp, "-o", stamp]);
  }
}

/** 模型 / 格式 / 排版的 wasm：一份（不用 SIMD 特性），自己的 target 目录；只看 dolce-* 与锁文件的修改时间。
 *  `--target web` 的胶水在 Node 里也能用（门面调 `initSync` 读文件）。 */
export function buildDolce() {
  const srcTime = Math.max(newest(crates, 0, (n) => n.startsWith("dolce-")), statSync(join(crates, "Cargo.lock")).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs);
  const stamp = join(DOLCE_OUT, `${DOLCE_NAME}_bg.wasm`);
  if (existsSync(stamp) && statSync(stamp).mtimeMs > srcTime) return;
  checkBindgen();
  mkdirSync(DOLCE_OUT, { recursive: true });
  console.log("[build-wasm] 编 dolce-wasm …");
  const target = join(crates, "target/wasm-dolce");
  run("cargo", ["build", "-p", "dolce-wasm", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target], { cwd: crates });
  const wasm = join(target, `wasm32-unknown-unknown/release/${DOLCE_NAME}.wasm`);
  run("wasm-bindgen", [wasm, "--target", "web", "--no-typescript", "--remove-producers-section", "--out-dir", DOLCE_OUT, "--out-name", DOLCE_NAME]);
  if (has("wasm-opt")) run("wasm-opt", ["-O2", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals", stamp, "-o", stamp]);
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
  buildDolce();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildWasm();
