// 网页版识别的 wasm（crates/omr-wasm）与 PDFium 的 wasm 版 → public/redist/omr/；
// 模型 / 格式 / 排版的 wasm（crates/dolce-wasm，迁 Rust 进行中）→ public/redist/dolce/。都不入库。
// dolce-wasm 是编辑器开机就要的（演唱顺序、断句、时间轴、MIDI 已在里面，网页与桌面 WebView 都载它，
// Node 的 out/cli 各入口与识谱分发包也载它），一律要编；.jcx 编解码（GBK / BIG5 码表大）单出一份 dolce_jcx_wasm，同目录、按需载入。识别那份桌面版（Tauri 的 before 命令带 TAURI_ENV_PLATFORM）
// 与设了 DOLCE_NO_WASM 的跳过（桌面识别走原生）。
// vite 的 dev 与 build 开头调它（vite.config.ts）；`node scripts/build-wasm.mjs dolce` 只编 dolce 那两份（识谱分发包、桌面 CI 用）；
// `probe` 另编一份带对拍探针的 dolce-wasm 到 out/dolce-probe/（只给 dev 对拍脚本，不进打包）。
//
// 要：rustup target add wasm32-unknown-unknown；cargo install wasm-bindgen-cli --version <与 crates/Cargo.lock 一致>。
// 识别那份有 wasm-opt（binaryen）就再压一遍；dolce 两份走 `wasm-dolce` 编译档、不过 wasm-opt。源码没变就不重来（比 crates/ 下源码与 public/redist/omr/ 产物的修改时间）。
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
const JCX_NAME = "dolce_jcx_wasm";

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

/** 模型 / 格式 / 排版的 wasm：dolce_wasm 与按需载入的 dolce_jcx_wasm 两份（不用 SIMD 特性），共用自己的 target 目录；
 *  只看 dolce-*、它引的那几个 omr-*（识别结果建模 omr-todoc 及其依赖）与锁文件、本脚本的修改时间。`--target web` 的胶水在 Node 里也能用（门面调 `initSync` 读文件）。 */
/** dolce-wasm 依赖的识别 crate（目录名） */
const DOLCE_OMR_DEPS = ["omr-todoc", "omr-sheet", "omr-text", "omr-core"];

export function buildDolce() {
  const srcTime = Math.max(newest(crates, 0, (n) => n.startsWith("dolce-") || DOLCE_OMR_DEPS.includes(n)), statSync(join(crates, "Cargo.lock")).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs);
  const stamps = [DOLCE_NAME, JCX_NAME].map((n) => join(DOLCE_OUT, `${n}_bg.wasm`));
  if (stamps.every((f) => existsSync(f) && statSync(f).mtimeMs > srcTime)) return;
  checkBindgen();
  mkdirSync(DOLCE_OUT, { recursive: true });
  console.log("[build-wasm] 编 dolce-wasm、dolce-jcx-wasm …");
  const target = join(crates, "target/wasm-dolce");
  // crates/Cargo.toml 的 `wasm-dolce` 档（fat LTO）；不过 wasm-opt——实测它让 gzip 后反而变大（按体积编也量过，太慢，见该档注释）
  run("cargo", ["build", "-p", "dolce-wasm", "-p", "dolce-jcx-wasm", "--profile", "wasm-dolce", "--target", "wasm32-unknown-unknown", "--target-dir", target], { cwd: crates });
  for (const name of [DOLCE_NAME, JCX_NAME]) {
    const wasm = join(target, `wasm32-unknown-unknown/wasm-dolce/${name}.wasm`);
    // 去掉名字段（编辑器开机就载；panic 信息照打，只是栈上没函数名）
    run("wasm-bindgen", [wasm, "--target", "web", "--no-typescript", "--remove-name-section", "--remove-producers-section", "--out-dir", DOLCE_OUT, "--out-name", name]);
  }
}

/** 带对拍探针的那份 dolce-wasm（`--features probe`）：只给 dev `rs-diff.mjs` 用，编到 out/dolce-probe/（不进打包、不入库）。
 *  `node scripts/build-wasm.mjs probe`；与开机那份各用自己的 target 目录。 */
export function buildDolceProbe() {
  checkBindgen();
  const outDir = join(root, "out/dolce-probe");
  mkdirSync(outDir, { recursive: true });
  console.log("[build-wasm] 编 dolce-wasm（带对拍探针）…");
  const target = join(crates, "target/wasm-dolce-probe");
  run("cargo", ["build", "-p", "dolce-wasm", "--features", "probe", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target], { cwd: crates });
  run("wasm-bindgen", [join(target, `wasm32-unknown-unknown/release/${DOLCE_NAME}.wasm`), "--target", "web", "--no-typescript", "--out-dir", outDir, "--out-name", DOLCE_NAME]);
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
  if (!process.env.TAURI_ENV_PLATFORM && !process.env.DOLCE_NO_WASM) {
    buildOmr();
    fetchPdfium();
  }
  buildDolce();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "dolce") buildDolce();
  else if (process.argv[2] === "probe") buildDolceProbe();
  else buildWasm();
}
