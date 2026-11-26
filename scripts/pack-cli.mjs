#!/usr/bin/env node
// 把识谱命令行打成**自包含**分发包：解压即用，不联网、不装依赖，也不要 Node。
//
// 包里：Rust 命令行 `dolce`（crates/cli：识别、各格式写出、参照歌词互证、歌本切分都在里面，ONNX Runtime 静态链入）
//      + PDFium 动态库 + `models/`（OCR 模型）+ README（Windows 另内置 VC++ 运行库）。
//
// 用法（从仓库根跑）：
//   node scripts/pack-cli.mjs                                 # 当前平台（识别程序没编就当场 cargo build --release）
//   node scripts/pack-cli.mjs --targets=linux-x64,win32-x64   # 别的平台：识别程序要先在那个平台（或 CI）编好，见下
//   node scripts/pack-cli.mjs --no-crt                        # Windows 包不内置 VC++ 运行库
//   node scripts/pack-cli.mjs --keep                          # 保留目录、不打压缩包
//
// 识别程序与 PDFium 都是原生的，**不能交叉打包**：别的平台的 `dolce` 按
// `crates/target/<三元组>/release/` → `--bin-dir=目录` 找，PDFium 按 `~/.cache/dolce-pdfium/<构建号>/<三元组>/`
// （omr-core 的构建脚本（pdf 特性）编那个目标时下载）→ `--pdfium-dir=目录` 找；缺了就报错，不打半成品。
//
// 产物：out/pkg/dolce-cli-<版本>-<os>-<cpu>.{tar.gz|zip}（解出来是同名目录）
import { readFile, writeFile, mkdir, rm, cp, readdir, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { crtLibrary, crtClosure, peImports } from "./vcredist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "dolce-cli";
const OUT = join(ROOT, "out/pkg");
/** 与 crates/omr-core/build.rs 同一个构建号 */
const PDFIUM_BUILD = "7881";

/** 目标 → Rust 三元组、PDFium 库名。 */
const TARGETS = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", lib: "libpdfium.dylib" },
  "darwin-x64": { triple: "x86_64-apple-darwin", lib: "libpdfium.dylib" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", lib: "libpdfium.so" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", lib: "libpdfium.so" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", lib: "pdfium.dll" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", lib: "pdfium.dll" },
};
const HOST = `${process.platform}-${process.arch}`;

const argv = process.argv.slice(2);
const opt = (k, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const KEEP = argv.includes("--keep");
const CRT = !argv.includes("--no-crt"); // Windows 包内置 VC++ 运行库（app-local），见 vcredist.mjs
const BIN_DIR = opt("bin-dir", null);
const PDFIUM_DIR = opt("pdfium-dir", null);
const targets = opt("targets", HOST).split(",").map((t) => t.trim());

for (const t of targets) {
  if (!TARGETS[t]) {
    console.error(`不认识的目标 ${t}；可选：${Object.keys(TARGETS).join(" / ")}`);
    process.exit(1);
  }
}

/** 当前目标的 CRT 库，installCrt 填上、verify 复用。 */
let CRT_LIB = new Map();

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
const VER = pkg.version;
/** Windows 上没有 du，自己遍历。 */
async function bytesOf(p) {
  const st = await stat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await readdir(p)) total += await bytesOf(join(p, e));
  return total;
}
const human = (n) => (n >= 1 << 20 ? `${Math.round(n / (1 << 20))}M` : `${Math.round(n / 1024)}K`);
const du = async (p) => human(await bytesOf(p));

/** 识别程序：别的平台按三元组目录 / --bin-dir；本机没编就当场编。 */
function findBin(target) {
  const { triple } = TARGETS[target];
  const exe = target.startsWith("win32") ? "dolce.exe" : "dolce";
  const cands = [BIN_DIR && join(BIN_DIR, exe), join(ROOT, "crates/target", triple, "release", exe), target === HOST && join(ROOT, "crates/target/release", exe)].filter(Boolean);
  let hit = cands.find((p) => existsSync(p));
  if (!hit && target === HOST) {
    console.log("编识别程序（cargo build --release -p dolce-cli）…");
    execFileSync("cargo", ["build", "--release", "-p", "dolce-cli"], { cwd: join(ROOT, "crates"), stdio: "inherit" });
    hit = cands.find((p) => existsSync(p));
  }
  if (!hit) throw new Error(`缺 ${target} 的识别程序（找过：${cands.join("、")}）——在那个平台或 CI 上 cargo build --release -p dolce-cli，再用 --bin-dir 指过来`);
  return { path: hit, exe };
}

function findPdfium(target) {
  const { triple, lib } = TARGETS[target];
  const cands = [PDFIUM_DIR && join(PDFIUM_DIR, lib), join(homedir(), ".cache/dolce-pdfium", PDFIUM_BUILD, triple, lib)].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) throw new Error(`缺 ${target} 的 PDFium（找过：${cands.join("、")}）——编那个目标时 omr-core 的构建脚本（pdf 特性）会下载，或用 --pdfium-dir 指过来`);
  return { path: hit, lib };
}

/** 递归找出包里的 Windows 原生二进制（dll / exe），返回 [绝对路径, 依赖的 DLL 名]。 */
async function scanPe(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { await scanPe(p, out); continue; }
    if (!/\.(dll|exe)$/i.test(e.name)) continue;
    out.push([p, peImports(await readFile(p))]);
  }
  return out;
}

/** 每个目录里缺哪些 CRT（app-local 的搜索范围是加载者自己那个目录）。lib 为 null 时只报需求、不算闭包（校验用）。 */
async function crtNeeds(dir, lib) {
  const byDir = new Map();
  for (const [file, deps] of await scanPe(dir)) {
    const d = dirname(file);
    const has = new Set((await readdir(d)).map((f) => f.toLowerCase()));
    for (const dep of deps) {
      const name = dep.toLowerCase();
      if (!(lib ?? CRT_LIB).has(name) || has.has(name)) continue;
      if (!byDir.has(d)) byDir.set(d, new Set());
      byDir.get(d).add(name);
    }
  }
  if (!lib) return byDir;
  return new Map([...byDir].map(([d, needs]) => [d, crtClosure(needs, lib)]));
}

/** Windows：把 VC++ 运行库放到用它的二进制旁边（app-local），省掉用户装 vc_redist 这一步（见 scripts/vcredist.mjs）。 */
async function installCrt(dir, cpu) {
  const lib = (CRT_LIB = await crtLibrary(cpu));
  let n = 0;
  for (let round = 0; round < 4; round++) {
    const needs = await crtNeeds(dir, lib);
    if (!needs.size) break;
    for (const [d, dlls] of needs) {
      for (const name of dlls) { await writeFile(join(d, name), lib.get(name)); n++; }
      console.log(`内置 VC++ 运行库：${[...dlls].sort().join(" ")}`);
    }
  }
  if (!n) console.log("内置 VC++ 运行库：包里没有依赖 CRT 的二进制，跳过");
}

async function verify(dir, os, exe, lib) {
  const problems = [];
  for (const f of [exe, lib, "Bravura.otf", "BravuraText.otf", "models/ppocrv6_dict.txt", "README.md"]) {
    if (!existsSync(join(dir, f))) problems.push(`缺 ${f}`);
  }
  if (CRT && os === "win32") {
    for (const [d, dlls] of await crtNeeds(dir, null)) problems.push(`${d.replace(dir + "/", "")} 缺 ${[...dlls].sort().join(" ")}`);
  }
  return problems;
}

/** tar 是不是 bsdtar（libarchive）——只有它能产 zip。macOS 与 Win10 1803+ 自带的都是。 */
let _bsdtar = null;
function hasBsdtar() {
  if (_bsdtar === null) {
    try { _bsdtar = /bsdtar|libarchive/i.test(execFileSync("tar", ["--version"]).toString()); }
    catch { _bsdtar = false; }
  }
  return _bsdtar;
}

/** 打包成 zip 或 tar.gz。bsdtar 产 zip 要显式给 deflate；GNU tar 不认 zip，回退到 zip 命令。 */
function archive(file, dirName, asZip) {
  if (!asZip) { execFileSync("tar", ["czf", file, "-C", OUT, dirName]); return; }
  if (hasBsdtar()) {
    execFileSync("tar", ["-a", "-cf", file, "--options", "zip:compression=deflate", "-C", OUT, dirName]);
    return;
  }
  try { execFileSync("zip", ["-qry", file, dirName], { cwd: OUT }); }
  catch { throw new Error("打 zip 需要 bsdtar 或 zip 命令，两者都没有"); }
}

function readme(os, cpu) {
  const win = os === "win32";
  const linux = os === "linux";
  const run = win ? "dolce.exe" : "./dolce";
  const c = win ? "::" : "#";
  const sep = win ? "\\" : "/";
  return `# ${NAME} ${VER}

识谱命令行：简谱、五线谱的图片或 PDF → 文本谱 / 123 / MusicXML 等。自包含：解压即用，不联网、不装依赖，也不要 Node。
本包目标平台 **${os}/${cpu}**。

\`\`\`${win ? "bat" : "bash"}
${run} omr 图片.jpg                   ${c} 默认输出诗歌本文本谱到 stdout
${run} omr 图片.jpg -f 123 -o 曲.123      ${c} 换格式、写文件
${run} omr 合唱.pdf -f musicxml -o 合唱.musicxml   ${c} 五线谱
${run} omr a.jpg b.pdf 谱子目录${sep} -o 出目录${sep}   ${c} 批量：一个进程跑完（一个文件一首）
${run} omr 图片.jpg --kind=jianpu --profile   ${c} 指定路线、附带每首耗时
${run} omr 图片.jpg -l 歌词.txt --lyrics-report 核对.json   ${c} 简谱参照歌词互证
${run} convert 曲.123 -f musicxml -o 曲.musicxml          ${c} 格式互转（支持 -o 扩展名推断）
${run} convert 曲.123 -o 曲.pdf                            ${c} 排版导出矢量 PDF / PNG / SVG / PPTX
${run} convert 曲.123 -o 曲.mid                            ${c} 导出标准 MIDI（含演唱顺序与逐遍歌词）
${run} split 歌本.pdf -o 歌谱${sep}        ${c} 歌本切分：整本 PDF / 页图目录 → 一首一张图，按目录核对缺漏
${run} --help                         ${c} 全部参数
\`\`\`

输入：图片（jpg / png / webp / bmp / tif）与 PDF；一个文件一首（几页的 PDF 是一首）。路线缺省自动：先按五线谱认，
一页谱表都没有再走简谱；\`--kind=staff|jianpu\` 指定。
格式：\`shige\`（诗歌本文本谱，缺省）、\`tomato\`（番茄简谱）、\`123\`、\`jpwabc\`、\`abc\`、\`jly\`、\`jcx\`、\`musicxml\`。

格式转换与导出（\`convert\`）：支持 \`.123\` / \`.abc\` / \`.jcx\` / \`.jpwabc\` / \`.jps\` / \`.jly\` / \`.musicxml\` / \`.mxl\` / \`.mid\`
互转为上述谱面格式，或导出 \`midi\`（按演唱顺序展开、带声部名与逐遍歌词，\`--tempo\` / \`--no-lyrics\` / \`--metronome\`）
以及排版成品 \`pdf\` / \`png\` / \`svg\` / \`pptx\`（\`--view=auto|jianpu|expanded|staff|mixed\`、\`--paper\`、\`--landscape\`、\`--dpi\`）。

参照歌词互证（\`-l\` / \`--lyrics\`，只配单张简谱）：给同一首诗歌的歌词文本（.txt / .lrc，UTF-8 / UTF-16 / GBK 都认），
形近字按歌词选字、补回漏读的字；两边对不上的（版本用字、字多字少、疑漏弧、反复顺序对不上）只报到 stderr、不改，
\`--lyrics-report\` 另落 JSON。

歌本切分（\`split\`）：分页的诗歌集切成一首一张 \`曲号 曲名.jpg\`——一页多首按标题切开、一首跨页按序拼接，
去掉页码，拼缝处用本首的系统间距，边距照源图。输入是扫描 PDF（取每页内嵌的原图，不重新渲染）或页图目录（按文件名自然序）。
自动认书内目录页核对缺号、重号、起始页，报告写到输出目录的 \`切分报告.txt\`；认错目录页时用 \`--toc-pages 3-15\` 指定，
\`--dry-run\` 只出报告不写图。转曲矢量 PDF 出 \`曲号 曲名.png\`（\`--dpi\`，缺省 300）；加 \`--recognize\` 切完逐首识别（回原书取矢量对象），
\`-f\` 选格式（缺省 \`musicxml\`），与图片同名放在一起。

环境变量：\`OMR_MODELS\` 指定模型目录（缺省包内 \`models/\`）。
${win ? `\n${CRT ? "识谱程序动态链接 VC++ 运行库，本包已把它们放在同目录内置，不必另装 Microsoft Visual C++ 可再发行组件。" : "需要 Microsoft Visual C++ 2015–2022 可再发行组件。"}\n输出编码为 UTF-8，用 \`-o\` 写文件最稳；直接看 stdout 的话先 \`chcp 65001\`。\n` : ""}${linux ? "\n要求 glibc 2.39 及以上（Ubuntu 24.04、Debian 13、Fedora 40 及更新的发行版）与系统自带的 libstdc++。\n" : ""}`;
}

async function build(target) {
  const [os, cpu] = target.split("-");
  const base = `${NAME}-${VER}-${target}`;
  const dir = join(OUT, base);
  console.log(`\n===== ${target} =====`);
  const bin = findBin(target);
  const pdfium = findPdfium(target);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // 1. 识别程序 + PDFium + Bravura 音乐字体（识别/排版程序在自己旁边找 PDFium、字体与 models/）
  await cp(bin.path, join(dir, bin.exe));
  await chmod(join(dir, bin.exe), 0o755);
  await cp(pdfium.path, join(dir, pdfium.lib));
  for (const font of ["Bravura.otf", "BravuraText.otf"]) {
    await cp(join(ROOT, "public", "redist", font), join(dir, font));
  }
  // 2. 模型
  await mkdir(join(dir, "models"), { recursive: true });
  for (const f of await readdir(join(ROOT, "public", "redist", "ocr"))) await cp(join(ROOT, "public", "redist", "ocr", f), join(dir, "models", f));
  console.log(`识别程序 ${await du(join(dir, bin.exe))}、PDFium ${await du(join(dir, pdfium.lib))}、模型 ${await du(join(dir, "models"))}`);

  if (CRT && os === "win32") await installCrt(dir, cpu);
  await writeFile(join(dir, "README.md"), readme(os, cpu));

  const problems = await verify(dir, os, bin.exe, pdfium.lib);
  if (problems.length) {
    console.error(`✗ ${target} 校验不过：${problems.join("；")}`);
    return { target, ok: false };
  }
  const size = await du(dir);
  if (KEEP) { console.log(`✓ ${target}  ${size}  → ${dir}`); return { target, ok: true, size }; }
  const isWin = os === "win32";
  const file = join(OUT, `${base}.${isWin ? "zip" : "tar.gz"}`);
  await rm(file, { force: true });
  archive(file, base, isWin);
  await rm(dir, { recursive: true, force: true });
  console.log(`✓ ${target}  目录 ${size} → ${file.replace(ROOT + "/", "")} (${await du(file)})`);
  return { target, ok: true, size, file };
}

console.log(`打包 ${NAME} ${VER}：${targets.join(", ")}`);
await mkdir(OUT, { recursive: true });
const results = [];
for (const t of targets) {
  try {
    results.push(await build(t));
  } catch (e) {
    console.error(`✗ ${t}：${e instanceof Error ? e.message : String(e)}`);
    results.push({ target: t, ok: false });
  }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n完成 ${results.length - bad.length}/${results.length}`);
if (bad.length) { console.error(`失败：${bad.map((r) => r.target).join(", ")}`); process.exit(1); }
