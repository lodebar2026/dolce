#!/usr/bin/env node
// 简谱 OMR 命令行：图片 → 文本谱 / 123，**不起浏览器**（onnxruntime-node 原生推理）。
// 用法（仓库里从根跑；分发包里就在包目录跑）：
//   node scripts/omr-cli.mjs 图片.jpg                      # 默认输出诗歌本文本谱到 stdout
//   node scripts/omr-cli.mjs 图片.jpg -f 123 -o 曲.123   # 换格式、写文件
//   node scripts/omr-cli.mjs 图片.jpg --profile             # 附带分段耗时与线程配置
//   node scripts/omr-cli.mjs a.jpg b.jpg 谱子目录/ -o 出目录/ # 批量：一个进程跑完整批
//   node scripts/omr-cli.mjs 图.jpg --thread-mode=always --threads=8   # 调线程策略
//   node scripts/omr-cli.mjs 图.jpg --lyrics 歌词.txt        # 参照歌词互证：形近字按歌词选字、补漏字，不一致处报到 stderr
//   node scripts/omr-cli.mjs 图.jpg -l 歌词.lrc --lyrics-report 核对.json   # 核对结果另落 JSON
//   node scripts/omr-cli.mjs split 歌本.pdf -o 歌谱/       # 歌本切分：整本 PDF 或页图目录 → 一首一张图 + 目录核对
//   node scripts/omr-cli.mjs split 矢量歌本.pdf -o 歌谱/ --dpi 200 --recognize -f 123   # 转曲矢量歌本：出 PNG，逐首按矢量识别
// 格式清单取自 src/omr/emit.ts::OMR_EMITTERS，加格式不用改本脚本。
//
// 参照歌词（--lyrics）只配**单张图**：一份歌词文件对一首歌（.txt / .lrc，编码 UTF-8/GBK/UTF-16 自动认）。
// 歌词按演唱顺序写全（反复、副歌每段都写）即可，结构行 `1.`、`(副歌)` 与 lrc 时间戳自动去掉。
//
// **批量比逐张起进程快得多**：模型 21MB、ONNX 图反序列化 + ORT 初始化 + JIT 预热大约要
// 2.4s（M5 实测，弱 CPU 上更久），逐张调用等于每张都付一遍；同一进程连跑只付一次。
// 服务端集成请优先用批量，或把本文件当库 import（见包内 README）。
//
// 线程策略（同一份判据在不同 CPU 上结论会反，详见 src/omr/runtime.node.ts）：
//   --thread-mode=auto    默认，按张量形状分派；单核强、核少的机器（Apple M 系）最快
//   --thread-mode=always  一律多线程；**单核弱、核多的机器（Xeon E5 那代）该用这个**
//   --thread-mode=single  一律单线程；CPU quota 只有一两核的容器里用
//   --threads=N           多线程时用几个核（默认 4）
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);

const argv = process.argv.slice(2);
if (argv[0] === "split") await runSplit(argv.slice(1)); // 不返回

const opts = { format: "shige", out: null, profile: false, help: false, imgs: [], lyrics: null, lyricsReport: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-f" || a === "--format") opts.format = argv[++i];
  else if (a === "-o" || a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = true;
  else if (a === "-l" || a === "--lyrics") opts.lyrics = argv[++i];
  else if (a === "--lyrics-report") opts.lyricsReport = argv[++i];
  else if (a === "-h" || a === "--help") opts.help = true;
  // 线程开关要在 import 产物**之前**落到 env——那两个是模块顶层常量，import 完再设就晚了。
  else if (a.startsWith("--threads=")) process.env.OMR_THREADS = a.slice(10);
  else if (a.startsWith("--thread-mode=")) process.env.OMR_THREAD_MODE = a.slice(14);
  else opts.imgs.push(a);
}

function usage(emitters) {
  const list = emitters ? emitters.map((e) => `${e.id}（${e.label}）`).join("、") : "shige / tomato / 123";
  console.error(`用法: omr-cli.mjs <图片…|目录…> [-f 格式] [-o 输出] [--profile]
              [--thread-mode=auto|always|single] [--threads=N]
              [-l 歌词文件 [--lyrics-report 核对.json]]
格式: ${list}
批量: 多个图片或目录一起给，同一进程跑完（省掉每张的模型加载）；-o 给目录则逐个写文件。
歌词: -l/--lyrics 给同一首诗歌的歌词文本（.txt/.lrc），只配单张图；形近字按歌词选字、补漏字，
      两边不一致处打到 stderr，--lyrics-report 另落 JSON。`);
}

// 两种布局都要认：仓库里是 ../out/cli/omr.js，打包产物里是同目录的 ./omr.js。
const CLI_URL = ["./omr.js", "../out/cli/omr.js"]
  .map((r) => new URL(r, import.meta.url))
  .find((u) => existsSync(fileURLToPath(u)));
if (!CLI_URL) { console.error("找不到 omr.js —— 仓库里先跑 npm run build:cli"); process.exit(1); }
const cli = await import(CLI_URL.href);

if (opts.help || !opts.imgs.length) { usage(cli.OMR_EMITTERS); process.exit(opts.help ? 0 : 1); }
if (!cli.isOmrFormat(opts.format)) {
  console.error(`未知格式 ${opts.format}`); usage(cli.OMR_EMITTERS); process.exit(1);
}

/** 展开输入：目录 → 里面的图片（不递归，按名排序）。 */
async function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = await stat(p); } catch { console.error(`跳过（打不开）：${p}`); continue; }
    if (!st.isDirectory()) { out.push(p); continue; }
    const files = (await readdir(p)).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort();
    if (!files.length) console.error(`跳过（目录里没图片）：${p}`);
    for (const f of files) out.push(join(p, f));
  }
  return out;
}

const imgs = await expand(opts.imgs);
if (!imgs.length) { console.error("没有可识别的图片"); process.exit(1); }
if (opts.lyricsReport && !opts.lyrics) { console.error("--lyrics-report 要和 --lyrics 一起给"); process.exit(1); }
let refLyrics;
if (opts.lyrics) {
  if (imgs.length !== 1) { console.error("--lyrics 只配单张图（一份歌词对一首歌），批量请逐张跑"); process.exit(1); }
  try { refLyrics = cli.decodeLyricsBytes(new Uint8Array(await readFile(opts.lyrics))); }
  catch (e) { console.error(`读不了歌词文件 ${opts.lyrics}：${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
}

// -o 是目录（多图，或路径本身就是已存在的目录）时逐个写文件，否则当单个输出文件。
const outIsDir = opts.out != null && (imgs.length > 1 || (existsSync(opts.out) && (await stat(opts.out)).isDirectory()));
if (outIsDir) await mkdir(opts.out, { recursive: true });
const EXT = { "123": ".123", jpwabc: ".jpwabc" };
// .jpwabc 按 JP-Word 的 UTF-16LE 带 BOM 落盘，其余 UTF-8
const encodeOut = (r) => (r.format === "jpwabc" ? Buffer.from("\ufeff" + r.text, "utf16le") : Buffer.from(r.text, "utf-8"));

let failed = 0;
const t0all = performance.now();
for (const img of imgs) {
  const t0 = performance.now();
  cli.omrProfileReset();
  let r;
  try {
    r = await cli.recognizeImage(new Uint8Array(await readFile(img)), {
      mime: MIME[extname(img).toLowerCase()], format: opts.format, lyrics: refLyrics,
    });
  } catch (e) {
    console.error(`✗ ${basename(img)}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
    continue;
  }
  const wall = performance.now() - t0;

  if (outIsDir) {
    const dst = join(opts.out, basename(img, extname(img)) + (EXT[r.format] ?? ".txt"));
    await writeFile(dst, encodeOut(r));
    console.error(`已写入 ${dst}`);
  } else if (opts.out) {
    await writeFile(opts.out, encodeOut(r));
    console.error(`已写入 ${opts.out}`);
  } else {
    if (imgs.length > 1) process.stdout.write(`# ===== ${basename(img)} =====\n`);
    process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
  }

  if (refLyrics !== undefined) {
    const lc = r.detail.score.lyricCheck;
    if (!lc) console.error("[歌词核对] 没有识别到歌词，未核对");
    else {
      const cnt = (k) => lc.items.filter((x) => x.kind === k).length;
      const review = lc.items.filter((x) => x.review).length;
      console.error(`[歌词核对] 按${lc.order === "expanded" ? "演唱顺序" : "谱面顺序"}对齐：同字 ${lc.matched}/${lc.ocrChars}（参照 ${lc.refChars} 字）`
        + ` ｜ 已改 ${cnt("fixed")}、已补 ${cnt("filled")}${review ? `（其中待复查 ${review}）` : ""}、待核 ${lc.items.length - cnt("fixed") - cnt("filled")}`);
      for (const x of lc.items) console.error("  " + cli.formatLyricCheckItem(x));
      for (const u of lc.unmatchedRef) console.error(`  [参照未对上] 第 ${u.from + 1}–${u.to} 字「${u.text}」`);
    }
    if (opts.lyricsReport) {
      await writeFile(opts.lyricsReport, JSON.stringify(lc ?? null, null, 2));
      console.error(`已写入 ${opts.lyricsReport}`);
    }
  }

  if (opts.profile) {
    const p = cli.omrProfile();
    const rows = r.detail.score.rows ?? [];
    const notes = rows.reduce((a, x) => a + (x.nums?.length ?? 0), 0);
    const ti = cli.threadInfo();
    console.error(`[OMR] ${basename(img)} ${r.detail.bin.w}×${r.detail.bin.h} ${rows.length}行/${notes}音`
      + ` ｜ 总 ${wall.toFixed(0)}ms = infer ${p.infer.toFixed(0)}(${p.calls}次) + CTC ${p.ctc.toFixed(0)}`
      + ` + 其余 ${(wall - p.infer - p.ctc).toFixed(0)}`
      + ` ｜ 线程 ${ti.mode}/${ti.threads}`);
  }
}

if (imgs.length > 1) {
  const total = performance.now() - t0all;
  console.error(`\n共 ${imgs.length} 张，成功 ${imgs.length - failed}，合计 ${(total / 1000).toFixed(1)}s，`
    + `平均 ${(total / imgs.length).toFixed(0)}ms/张（首张含模型加载）`);
}
process.exit(failed ? 1 : 0);

// ───────────────────────── split：歌本切分 ─────────────────────────
// 整本分页简谱（PDF 取每页内嵌源图，或页图文件夹按文件名自然序）→ 输出目录里一首一张 `曲号 曲名.jpg`：
// 一页多首按标题切开、一首跨页按序拼接，去页码，拼缝处用本首的系统间距，边距照源图、切口补纸色；
// 再自动认书内目录页（「首句 曲号 页码」或只有「曲号 曲名」）核对缺漏，报告写到 `输出目录/切分报告.txt`（及 --report JSON）。
// 转曲矢量 PDF（页上没有内嵌位图）整页渲成图来扫描，出 `曲号 曲名.png`（--dpi，缺省 300）；
// --recognize 切完逐首识别，回原书取矢量对象（不认渲出来的图），-f 选格式（缺省 musicxml），与图片同名放在一起。
// 有缺号、重号或识别失败时退出码 1。
async function runSplit(args) {
  const o = { input: null, out: null, report: null, quality: 92, dpi: null, tocPages: null, dryRun: false, recognize: false, format: "musicxml" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") o.out = args[++i];
    else if (a === "--report") o.report = args[++i];
    else if (a === "--quality") o.quality = Number(args[++i]);
    else if (a === "--dpi") o.dpi = Number(args[++i]);
    else if (a === "--toc-pages") o.tocPages = args[++i];
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--recognize") o.recognize = true;
    else if (a === "-f" || a === "--format") o.format = args[++i];
    else if (a.startsWith("--threads=")) process.env.OMR_THREADS = a.slice(10);
    else if (a.startsWith("--thread-mode=")) process.env.OMR_THREAD_MODE = a.slice(14);
    else if (a === "-h" || a === "--help") o.input = null, o.out = null, i = args.length;
    else o.input = a;
  }
  if (!o.input || (!o.out && !o.dryRun)) {
    console.error(`用法: omr-cli.mjs split <歌本.pdf | 页图目录> -o <输出目录>
              [--report 报告.json] [--quality 92] [--dpi 300] [--toc-pages 3-15] [--dry-run]
              [--recognize [-f musicxml]]
  --toc-pages  目录页（按源页序，1 起；如 3-15 或 3,5,7-9）；不给则自动认歌谱区之前全是字行的页
  --dry-run    只扫描、核对并打印报告，不写图片
  --quality    位图歌本出 JPEG 的质量
  --dpi        转曲矢量歌本出 PNG 的分辨率
  --recognize  切完逐首识别（只收转曲矢量歌本，取原书矢量对象）；-f 选格式：musicxml（缺省）/ 123 / jpwabc / abc / shige / tomato / jly / jcx`);
    process.exit(o.input ? 1 : 0);
  }
  if (o.recognize && o.dryRun) { console.error("--recognize 要写文件，不能与 --dry-run 一起用"); process.exit(1); }
  if (!(o.quality >= 1 && o.quality <= 100)) { console.error("--quality 要在 1–100"); process.exit(1); }
  if (o.dpi !== null && !(o.dpi >= 36 && o.dpi <= 1200)) { console.error("--dpi 要在 36–1200"); process.exit(1); }
  const tocPages = o.tocPages ? parseRanges(o.tocPages).map((n) => n - 1) : undefined;

  const url = ["./omr.js", "../out/cli/omr.js"].map((r) => new URL(r, import.meta.url)).find((u) => existsSync(fileURLToPath(u)));
  if (!url) { console.error("找不到 omr.js —— 仓库里先跑 npm run build:cli"); process.exit(1); }
  const cli = await import(url.href);

  const t0 = performance.now();
  if (o.recognize && !cli.isBookFormat(o.format)) { console.error(`未知格式 ${o.format}，可选：${cli.BOOK_FORMATS.join(" / ")}`); process.exit(1); }
  const src = await cli.openBookSource(o.input);
  if (o.recognize && !src.vector) {
    console.error("--recognize 只收转曲矢量歌本；位图歌本请先 split 出图，再用 omr-cli 批量识别图片目录");
    process.exit(1);
  }
  if (src.vector) console.error(`转曲矢量 PDF：出 PNG（${o.dpi ?? 300} dpi）`);
  else if (o.dpi !== null) console.error("--dpi 只对转曲矢量 PDF 有效，位图歌本照源图原分辨率出 JPEG，已忽略");
  const tick = (label) => (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${label} ${d}/${n}`); if (d === n) process.stderr.write(process.stderr.isTTY ? "\n" : `${label} ${n}/${n}\n`); };
  const plan = await cli.planBook(src, cli.paddleOcrBackend(), { tocPages, onProgress: tick("扫描") });
  const names = cli.songFileNames(plan.songs);
  const rep = cli.checkAgainstToc(plan, names, (i) => src.name(i));
  let recRep = null;
  if (!o.dryRun) {
    await cli.writeSongs(src, plan.layouts, names, o.out, { quality: o.quality, dpi: o.dpi ?? undefined, onProgress: tick("写出") });
    if (o.recognize) recRep = await cli.recognizeBookSongs(src, plan, names, o.out, cli.paddleOcrBackend(), { format: o.format, onProgress: tick("识别") });
    await writeFile(join(o.out, "切分报告.txt"), rep.text + (recRep ? "\n" + recRep.text : ""));
  }
  if (o.report) {
    const { text, ...rest } = rep;
    await writeFile(o.report, JSON.stringify({ ...rest, songs: plan.songs.map((s, k) => ({ file: names[k] + cli.songImageExt(src), ...s })), ...(recRep ? { recognize: { ok: recRep.ok, failed: recRep.failed } } : {}) }, null, 2));
  }
  await src.close();
  console.error(rep.text);
  if (recRep) console.error(recRep.text);
  console.error(`用时 ${((performance.now() - t0) / 1000).toFixed(1)}s` + (o.dryRun ? "" : `，已写入 ${o.out}`));
  process.exit(rep.missing.length || rep.duplicate.length || recRep?.failed.length ? 1 : 0);
}

/** 「3-15」「3,5,7-9」→ 数组。 */
function parseRanges(s) {
  const out = [];
  for (const part of s.split(/[,，]/)) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) { console.error(`--toc-pages 写法不对：${s}`); process.exit(1); }
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.push(n);
  }
  return out;
}
