#!/usr/bin/env node
// 发布前验证（scripts/release.sh 在改版本号之前调）：三项任一明显变差就以退出码 1 中止发布。
//
// 1. wasm 体积：本机编出的各份 wasm（public/redist/omr、public/redist/dolce）对比线上 Pages 现行版本同名文件，
//    原始字节与 brotli 后都看；任一份涨过 10% 且多出 300 KB 算不过。线上还没有的那份只记、不判。
// 2. 识别耗时：release 构建的命令行 `dolce omr` 把固定样张（简谱、五线谱、合唱、扫描、矢量 PDF）一个进程认完，跑 3 遍取墙钟中位数；
//    比上次发布记下的读数涨过 25% 算不过。
// 3. 内存：同一批的最大驻留内存（/usr/bin/time）取 3 遍最大；比上次涨过 30%、或超过 6 GB 算不过。
//
// 耗时与内存的「上次」记在私有仓库 `../dev/data/release-bench/latest.json`（与本机绑定，不入库）；没有私有仓库或样张就跳过这两项。
// 第一次跑只记录、不判定。release.sh 发布成功后调 `--save=<版本>`，把本次读数（pending.json）转成 latest.json 并按版本另存一份。
//
// 用法（从仓库根跑）：
//   node scripts/release-check.mjs            # 编、量、对比
//   node scripts/release-check.mjs --force    # 不过也以 0 退出（只打印）
//   node scripts/release-check.mjs --no-build # 不重编 wasm / 命令行，直接量现有产物
//   node scripts/release-check.mjs --save=0.9.0
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = "https://lodebar2026.github.io/dolce/";
const BENCH = join(ROOT, "..", "dev", "data", "release-bench");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

/** 阈值 */
// 内存绝对上限按 2026-11-23 实测定：5 份样张一个进程最大驻留 3.7~4.0 GB（v0.8.8 同量级，TS 版约其六成，见 dev 待办「识别内存」）
const WASM_PCT = 10, WASM_KB = 300, TIME_PCT = 25, RSS_PCT = 30, RSS_MAX_MB = 6144, RUNS = 3;
/** 固定样张（相对仓库根；testdata 链到私有仓库） */
const SAMPLES = [
  "testdata/简谱/日光之下/日光之下简谱.jpg",
  "testdata/简谱/耶稣普治/耶稣普治.pdf",
  "testdata/五线谱/万古磐石歌/万古磐石歌.jpg",
  "testdata/合唱谱/破碎/S014320OC.pdf",
  "testdata/合唱谱/破碎扫描/破碎.pdf",
];
const WASM_DIRS = ["redist/omr", "redist/dolce"];

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);
const sign = (p) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;

if (val("save")) {
  const ver = val("save");
  const pending = join(BENCH, "pending.json");
  if (!existsSync(pending)) {
    console.log("（没有 pending.json：本次发布没跑识别读数，不更新基线）");
    process.exit(0);
  }
  const rec = { ...JSON.parse(readFileSync(pending, "utf8")), version: ver };
  writeFileSync(join(BENCH, "latest.json"), JSON.stringify(rec, null, 1));
  copyFileSync(join(BENCH, "latest.json"), join(BENCH, `${ver}.json`));
  rmSync(pending);
  console.log(`==> 发布读数已记为 ${ver}（${join("..", "dev", "data", "release-bench")}）`);
  process.exit(0);
}

const fails = [];
const run = (cmd, a, cwd = ROOT) => execFileSync(cmd, a, { cwd, stdio: "inherit" });

// ---------------------------------------------------------------- 编
if (!has("--no-build")) {
  console.log("==> 编 wasm（识别两份 + 编辑器三份）");
  run("node", ["scripts/build-wasm.mjs"]);
}

// ---------------------------------------------------------------- 1. wasm 体积
console.log("\n==> wasm 体积（对比线上现行版本）");
const brotli = (buf) => brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 9, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
const wasmRows = [];
for (const d of WASM_DIRS) {
  const dir = join(ROOT, "public", d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".wasm")).sort()) {
    const buf = readFileSync(join(dir, f));
    const row = { file: `${d}/${f}`, raw: buf.length, br: brotli(buf) };
    try {
      const res = await fetch(`${PAGES}${d}/${f}?_=${Date.now()}`);
      if (res.ok) {
        const old = Buffer.from(await res.arrayBuffer());
        row.oldRaw = old.length;
        row.oldBr = brotli(old);
      }
    } catch {
      /* 线上取不到：只记 */
    }
    if (row.oldRaw) {
      const grow = (n, o) => pct(n, o) > WASM_PCT && n - o > WASM_KB * 1024;
      row.bad = grow(row.raw, row.oldRaw) || grow(row.br, row.oldBr);
      if (row.bad) fails.push(`${row.file} 变大：原始 ${sign(pct(row.raw, row.oldRaw))}、brotli ${sign(pct(row.br, row.oldBr))}`);
    }
    wasmRows.push(row);
  }
}
for (const r of wasmRows) {
  const cmp = r.oldRaw ? `线上 ${kb(r.oldRaw)} → ${sign(pct(r.raw, r.oldRaw))}，brotli ${kb(r.oldBr)} → ${kb(r.br)}（${sign(pct(r.br, r.oldBr))}）` : "线上没有（新增，只记）";
  console.log(`  ${r.bad ? "✗" : "✓"} ${r.file.padEnd(42)} ${kb(r.raw).padStart(9)}  ${cmp}`);
}

// ---------------------------------------------------------------- 2/3. 识别耗时与内存
const samples = SAMPLES.filter((f) => existsSync(join(ROOT, f)));
const bench = { date: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), wasm: Object.fromEntries(wasmRows.map((r) => [r.file, { raw: r.raw, br: r.br }])) };
if (!existsSync(join(ROOT, "..", "dev")) || samples.length < SAMPLES.length) {
  console.log(`\n（没有私有仓库或样张不全 ${samples.length}/${SAMPLES.length}，跳过识别耗时与内存）`);
} else if (process.platform === "win32") {
  console.log("\n（Windows 上没有 /usr/bin/time，跳过识别耗时与内存）");
} else {
  const exe = join(ROOT, "crates", "target", "release", "dolce");
  if (!has("--no-build")) {
    console.log("\n==> 编命令行（cargo build --release -p dolce-cli）");
    run("cargo", ["build", "--release", "-p", "dolce-cli"], join(ROOT, "crates"));
  }
  console.log(`\n==> 识别耗时与内存（${samples.length} 份样张一个进程认完，跑 ${RUNS} 遍）`);
  const out = mkdtempSync(join(tmpdir(), "dolce-release-check-"));
  const timeArgs = process.platform === "darwin" ? ["-l"] : ["-v"];
  const walls = [], rsss = [];
  let perFile = {};
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync("/usr/bin/time", [...timeArgs, exe, "omr", ...samples, "-f", "musicxml", "-o", out, "--profile"], { cwd: ROOT, encoding: "utf8" });
    const wall = Number(process.hrtime.bigint() - t0) / 1e9;
    if (r.status !== 0) {
      console.error(r.stderr);
      fails.push(`识别出错（退出码 ${r.status}）`);
      break;
    }
    // macOS：「N  maximum resident set size」（字节）；Linux：「Maximum resident set size (kbytes): N」
    const mac = /(\d+)\s+maximum resident set size/.exec(r.stderr);
    const lin = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(r.stderr);
    const rss = mac ? Number(mac[1]) : lin ? Number(lin[1]) * 1024 : 0;
    walls.push(wall);
    rsss.push(rss);
    perFile = {};
    for (const m of r.stderr.matchAll(/\[OMR\] (.+?) \S+ (\d+)ms/g)) perFile[m[1]] = Number(m[2]);
    console.log(`  第 ${i + 1} 遍：墙钟 ${wall.toFixed(2)} s，最大驻留 ${mb(rss)}`);
  }
  rmSync(out, { recursive: true, force: true });
  if (walls.length === RUNS) {
    const wall = [...walls].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
    const rss = Math.max(...rsss);
    Object.assign(bench, { samples, wall, rss, perFile });
    const latestPath = join(BENCH, "latest.json");
    const last = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, "utf8")) : null;
    const sameSamples = last && JSON.stringify(last.samples) === JSON.stringify(samples);
    if (rss > RSS_MAX_MB * 1024 * 1024) fails.push(`最大驻留 ${mb(rss)} 超过上限 ${RSS_MAX_MB} MB`);
    if (!sameSamples) {
      console.log(`  墙钟中位 ${wall.toFixed(2)} s、最大驻留 ${mb(rss)}；${last ? "样张清单变了" : "还没有上次发布的读数"}，只记录不判定`);
    } else {
      const tp = pct(wall, last.wall), rp = pct(rss, last.rss);
      const tBad = tp > TIME_PCT, rBad = rp > RSS_PCT;
      console.log(`  ${tBad ? "✗" : "✓"} 墙钟中位 ${last.wall.toFixed(2)} → ${wall.toFixed(2)} s（${sign(tp)}，上限 +${TIME_PCT}%；上次 ${last.version ?? "?"}）`);
      console.log(`  ${rBad ? "✗" : "✓"} 最大驻留 ${mb(last.rss)} → ${mb(rss)}（${sign(rp)}，上限 +${RSS_PCT}%）`);
      if (tBad) fails.push(`识别变慢 ${sign(tp)}`);
      if (rBad) fails.push(`内存涨 ${sign(rp)}`);
      const slow = Object.entries(perFile).filter(([f, ms]) => last.perFile?.[f] && pct(ms, last.perFile[f]) > TIME_PCT);
      for (const [f, ms] of slow) console.log(`    慢了的一份：${f} ${last.perFile[f]} → ${ms} ms（${sign(pct(ms, last.perFile[f]))}）`);
    }
    mkdirSync(BENCH, { recursive: true });
    writeFileSync(join(BENCH, "pending.json"), JSON.stringify(bench, null, 1));
  }
}

// ---------------------------------------------------------------- 结论
if (fails.length) {
  console.error(`\n✗ 发布前验证不过：\n  - ${fails.join("\n  - ")}`);
  if (has("--force")) {
    console.error("（--force：照样放行）");
    process.exit(0);
  }
  process.exit(1);
}
console.log("\n✓ 发布前验证通过");
