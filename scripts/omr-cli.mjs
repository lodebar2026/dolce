#!/usr/bin/env node
// 识谱命令行：简谱 / 五线谱的图片或 PDF → 文本谱 / 123 / MusicXML 等，**不起浏览器**。
// 识别在 Rust（`omr-cli run` / `split`，crates/omr-cli）；本脚本起它、收它的产物，再用编辑器同一套写出端（out/cli/omrfmt.js）转格式。
// 用法（仓库里从根跑；分发包里就在包目录跑）：
//   node scripts/omr-cli.mjs 图片.jpg                      # 默认输出诗歌本文本谱到 stdout
//   node scripts/omr-cli.mjs 图片.jpg -f 123 -o 曲.123     # 换格式、写文件
//   node scripts/omr-cli.mjs 合唱.pdf -f musicxml -o 合唱.musicxml   # 五线谱（自动判路：先按五线谱认，一页谱表都没有再走简谱）
//   node scripts/omr-cli.mjs a.jpg b.pdf 谱子目录/ -o 出目录/      # 批量：一个进程跑完整批（一个文件一首）
//   node scripts/omr-cli.mjs 图片.jpg --kind=jianpu --profile       # 指定路线、附带每首耗时
//   node scripts/omr-cli.mjs 图.jpg -l 歌词.txt [--lyrics-report 核对.json]   # 简谱参照歌词互证：形近字按歌词选字、补漏字，不一致处报到 stderr
//   node scripts/omr-cli.mjs split 歌本.pdf -o 歌谱/       # 歌本切分：整本 PDF 或页图目录 → 一首一张图 + 目录核对
//   node scripts/omr-cli.mjs split 矢量歌本.pdf -o 歌谱/ --dpi 200 --recognize -f 123   # 转曲矢量歌本：出 PNG，逐首按矢量识别
// 格式清单取自 src/convert/targets.ts（加 MusicXML），加格式不用改本脚本。
//
// Rust 可执行文件按这个次序找：包内同目录 → 环境变量 DOLCE_OMR_BIN → 仓库 crates/target/release。
// 模型目录：OMR_MODELS → 可执行文件旁的 models/ → 仓库 public/redist/ocr（Rust 那边找）。
//
// **批量比逐张起进程快得多**：OCR 模型加载与推理会话初始化每个进程付一次。
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { extname, basename, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === "win32" ? "omr-cli.exe" : "omr-cli";

function findBin() {
  const cands = [join(here, EXE), process.env.DOLCE_OMR_BIN, join(here, "../crates/target/release", EXE)].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) {
    console.error(`找不到识别程序 ${EXE}（找过：${cands.join("、")}）—— 仓库里先 cd crates && cargo build --release -p dolce-omr-cli，或设 DOLCE_OMR_BIN`);
    process.exit(1);
  }
  return hit;
}

// 两种布局都要认：仓库里是 ../out/cli/omrfmt.js，打包产物里是同目录的 ./omrfmt.js。
async function isDirPath(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }

async function loadFmt() {
  const url = ["./omrfmt.js", "../out/cli/omrfmt.js"].map((r) => new URL(r, import.meta.url)).find((u) => existsSync(fileURLToPath(u)));
  if (!url) { console.error("找不到 omrfmt.js —— 仓库里先跑 npm run build:cli"); process.exit(1); }
  return import(url.href);
}

/** 起 Rust 程序；stdout 逐行交 `onLine`，stderr 照传。回退出码。 */
function runBin(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(findBin(), args, { stdio: ["ignore", onLine ? "pipe" : "inherit", "inherit"] });
    const done = onLine ? new Promise((r) => {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let chain = Promise.resolve();
      rl.on("line", (l) => { chain = chain.then(() => onLine(l)); });
      rl.on("close", () => r(chain));
    }) : Promise.resolve();
    child.on("error", reject);
    child.on("close", (code) => done.then(() => resolve(code ?? 1), reject));
  });
}

const argv = process.argv.slice(2);
if (argv[0] === "split") await runSplit(argv.slice(1)); // 不返回

const opts = { format: "shige", out: null, profile: false, help: false, kind: "auto", inputs: [], lyrics: null, lyricsReport: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-f" || a === "--format") opts.format = argv[++i];
  else if (a === "-o" || a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = true;
  else if (a.startsWith("--kind=")) opts.kind = a.slice(7);
  else if (a === "-l" || a === "--lyrics") opts.lyrics = argv[++i];
  else if (a === "--lyrics-report") opts.lyricsReport = argv[++i];
  else if (a.startsWith("--threads=") || a.startsWith("--thread-mode=")) console.error(`${a.split("=")[0]} 已不用（推理线程由识别程序自己定），忽略`);
  else if (a === "-h" || a === "--help") opts.help = true;
  else opts.inputs.push(a);
}

const fmt = await loadFmt();

function usage() {
  const list = fmt.OUT_FORMATS.map((f) => `${f}（${fmt.formatLabel(f)}）`).join("、");
  console.error(`用法: omr-cli.mjs <图片…|PDF…|目录…> [-f 格式] [-o 输出] [--kind=auto|staff|jianpu] [--profile]
              [-l 歌词文件 [--lyrics-report 核对.json]]
格式: ${list}；缺省 shige
歌词: -l/--lyrics 给同一首诗歌的歌词文本（.txt/.lrc），只配单张简谱；形近字按歌词选字、补漏字，
      两边不一致处打到 stderr，--lyrics-report 另落 JSON。
路线: 缺省自动（先按五线谱认，一页谱表都没有再走简谱），--kind 指定
批量: 多个文件或目录一起给，同一进程跑完（一个文件一首；目录取里面的图片与 PDF，不递归）；-o 给目录则逐个写文件。`);
}

if (opts.help || !opts.inputs.length) { usage(); process.exit(opts.help ? 0 : 1); }
if (!fmt.isOutFormat(opts.format)) { console.error(`未知格式 ${opts.format}`); usage(); process.exit(1); }
if (!["auto", "staff", "jianpu"].includes(opts.kind)) { console.error(`--kind 只有 auto / staff / jianpu`); process.exit(1); }

if (opts.lyricsReport && !opts.lyrics) { console.error("--lyrics-report 要和 --lyrics 一起给"); process.exit(1); }
let refLyrics;
if (opts.lyrics) {
  if (opts.inputs.length !== 1 || (await isDirPath(opts.inputs[0]))) { console.error("--lyrics 只配单张图（一份歌词对一首歌），批量请逐张跑"); process.exit(1); }
  try { refLyrics = fmt.decodeLyricsBytes(new Uint8Array(await readFile(opts.lyrics))); }
  catch (e) { console.error(`读不了歌词文件 ${opts.lyrics}：${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
}

// -o 是目录（多个输入、给了目录，或路径本身就是已存在的目录）时逐个写文件，否则当单个输出文件。
const isDir = isDirPath;
const anyDir = (await Promise.all(opts.inputs.map(isDir))).some(Boolean);
const outIsDir = opts.out != null && (opts.inputs.length > 1 || anyDir || (await isDir(opts.out)));
if (outIsDir) await mkdir(opts.out, { recursive: true });

let n = 0, failed = 0;
const t0all = performance.now();
let tPrev = t0all;
const multi = opts.inputs.length > 1 || anyDir;
const code = await runBin(["run", `--kind=${opts.kind}`, ...opts.inputs], async (line) => {
  const r = JSON.parse(line);
  const name = basename(r.file);
  const ms = performance.now() - tPrev;
  tPrev = performance.now();
  n++;
  if (r.error) { console.error(`✗ ${name}: ${r.error}`); failed++; return; }
  // 参照歌词互证：改字、补字要在写出之前
  let lc;
  if (refLyrics !== undefined && r.kind === "jianpu") lc = await fmt.checkRefLyrics(r.score, refLyrics);
  else if (refLyrics !== undefined) console.error("[歌词核对] 参照歌词只用于简谱，五线谱未核对");
  let enc;
  try {
    enc = r.kind === "staff" ? fmt.encodeStaffXml(r.xml, opts.format) : fmt.encodeRecognized(r.score, opts.format);
  } catch (e) {
    console.error(`✗ ${name}: 转 ${opts.format} 失败：${e instanceof Error ? e.message : String(e)}`);
    failed++;
    return;
  }
  if (outIsDir) {
    const dst = join(opts.out, basename(r.file, extname(r.file)) + enc.ext);
    await writeFile(dst, enc.bytes);
    console.error(`已写入 ${dst}`);
  } else if (opts.out) {
    await writeFile(opts.out, enc.bytes);
    console.error(`已写入 ${opts.out}`);
  } else {
    if (multi) process.stdout.write(`# ===== ${name} =====\n`);
    process.stdout.write(enc.text.endsWith("\n") ? enc.text : enc.text + "\n");
  }
  if (refLyrics !== undefined && r.kind === "jianpu") {
    if (!lc || !lc.ocrChars) console.error("[歌词核对] 没有识别到歌词，未核对");
    else {
      const cnt = (k) => lc.items.filter((x) => x.kind === k).length;
      const review = lc.items.filter((x) => x.review).length;
      console.error(`[歌词核对] 按${lc.order === "expanded" ? "演唱顺序" : "谱面顺序"}对齐：同字 ${lc.matched}/${lc.ocrChars}（参照 ${lc.refChars} 字）`
        + ` ｜ 已改 ${cnt("fixed")}、已补 ${cnt("filled")}${review ? `（其中待复查 ${review}）` : ""}、待核 ${lc.items.length - cnt("fixed") - cnt("filled")}`);
      for (const x of lc.items) console.error("  " + fmt.formatLyricCheckItem(x));
      for (const u of lc.unmatchedRef) console.error(`  [参照未对上] 第 ${u.from + 1}–${u.to} 字「${u.text}」`);
    }
    if (opts.lyricsReport) {
      await writeFile(opts.lyricsReport, JSON.stringify(lc ?? null, null, 2));
      console.error(`已写入 ${opts.lyricsReport}`);
    }
  }
  if (opts.profile) console.error(`[OMR] ${name} ${r.kind === "staff" ? "五线谱" : "简谱"} ${ms.toFixed(0)}ms`);
});

if (n > 1) {
  const total = performance.now() - t0all;
  console.error(`\n共 ${n} 首，成功 ${n - failed}，合计 ${(total / 1000).toFixed(1)}s，平均 ${(total / n).toFixed(0)}ms/首（第一首含模型加载）`);
}
process.exit(failed || code !== 0 ? 1 : 0);

// ───────────────────────── split：歌本切分 ─────────────────────────
// 整本分页简谱（PDF 取每页内嵌源图，或页图文件夹按文件名自然序）→ 输出目录里一首一张 `曲号 曲名.jpg`，按书内目录核对缺漏，
// 报告写到 `输出目录/切分报告.txt`（及 --report JSON）。切分与识别都在 Rust（`omr-cli split`，参数照传）；
// `--recognize -f` 选 MusicXML 以外的格式时，Rust 先写 MusicXML，这里再逐首转成那种格式（MusicXML 删掉）。
async function runSplit(args) {
  if (args.some((a) => a === "-h" || a === "--help") || !args.length) {
    await runBin(["split", "--help"]);
    console.error("  -f 可选：musicxml（缺省）/ 123 / jpwabc / abc / shige / tomato / jly / jcx（非 musicxml 由本脚本转）");
    process.exit(args.length ? 0 : 1);
  }
  const rest = [];
  let format = "musicxml", out = null, report = null, recognize = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--format") format = args[++i];
    else if (a.startsWith("--threads=") || a.startsWith("--thread-mode=")) console.error(`${a.split("=")[0]} 已不用，忽略`);
    else {
      if (a === "-o" || a === "--out") out = args[i + 1];
      if (a === "--report") report = args[i + 1];
      if (a === "--recognize") recognize = true;
      rest.push(a);
    }
  }
  const fmt = await loadFmt();
  if (!fmt.isOutFormat(format)) { console.error(`未知格式 ${format}，可选：${fmt.OUT_FORMATS.join(" / ")}`); process.exit(1); }
  const convert = recognize && format !== "musicxml";
  // 要转格式就得知道写了哪几首：没要报告也临时要一份
  const tmpReport = convert && !report ? join(tmpdir(), `dolce-split-${process.pid}.json`) : null;
  const code = await runBin(["split", ...rest, ...(recognize ? ["-f", "musicxml"] : []), ...(tmpReport ? ["--report", tmpReport] : [])]);
  if (convert && out) {
    const rep = JSON.parse(await readFile(report ?? tmpReport, "utf8"));
    let ok = 0;
    const bad = [];
    for (const s of rep.songs ?? []) {
      const xmlPath = join(out, basename(s.file, extname(s.file)) + ".musicxml");
      if (!existsSync(xmlPath)) continue;
      try {
        const enc = fmt.encodeStaffXml(await readFile(xmlPath, "utf8"), format);
        await writeFile(join(out, basename(s.file, extname(s.file)) + enc.ext), enc.bytes);
        await rm(xmlPath);
        ok++;
      } catch (e) {
        bad.push(`${basename(xmlPath)}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.error(`转 ${format}：${ok} 首${bad.length ? `，失败 ${bad.length} 首（MusicXML 留着）\n  ${bad.join("\n  ")}` : ""}`);
    if (tmpReport) await rm(tmpReport, { force: true });
    if (bad.length) process.exit(1);
  }
  process.exit(code);
}
