// **桌面版测速**（只在测速构建里：`VITE_DOLCE_BENCH=1` 打前端 + cargo feature `bench` 编 Rust，见 src-tauri/src/lib.rs 的 bench 模块）。
// 启动后按 `DOLCE_BENCH` 环境变量指的配置逐份识别位图五线谱，量几何与 OCR 各段，结果写成 JSON 后退出。
// 正式构建里 `main.ts` 不引这个模块（构建期常量判掉，整段剔除）。
//
// 配置：{ "pdfs": ["绝对路径", …], "caches": "放 raster*.json 离线缓存的目录", "jianpu": ["简谱图片绝对路径", …], "dump": "简谱输出目录", "out": "结果 JSON 路径" }
// 位图五线谱每份跑两遍：按离线缓存认（只量几何，同 Node 回归与 dev 的 WebKit 测速）、现跑 OCR（推理走原生 ort，按种类计时）。
// 简谱每张现跑一遍，计时并把 123 与整份识别结果写到 `dump`（与 Node 现跑的输出逐字比，验原生推理那一路）。
import { invoke } from "@tauri-apps/api/core";
import { omrProfile, omrProfileReset } from "../omrkit/paddleocr";
import type { RasterOcrCaches } from "../rasteromr/song";

interface BenchConfig {
  pdfs?: string[];
  jianpu?: string[];
  dump?: string;
  caches?: string;
  out: string;
}

const CACHE_FILES: [keyof RasterOcrCaches, string][] = [
  ["lyricOcr", "rasterlyrics"],
  ["labelOcr", "rasterlabels"],
  ["harmonyOcr", "rasterharmony"],
  ["jianpuOcr", "rasterjianpu"],
  ["wordOcr", "rasterwords"],
  ["timeOcr", "rastertime"],
  ["headerOcr", "rasterheader"],
  ["pageTexts", "rastertext"],
];

const readBytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await invoke<ArrayBuffer>("bench_read", { path }));

/** 有测速配置就跑完并退出；没有（不是测速启动）什么都不做。 */
export async function maybeRunDesktopBench(): Promise<void> {
  const text = await invoke<string | null>("bench_config").catch(() => null);
  if (!text) return;
  const cfg = JSON.parse(text) as BenchConfig;
  const rows: unknown[] = [];
  // 进度逐步写到 <out>.log：卡住时看得出停在哪一步
  const t00 = performance.now();
  let log = "";
  const step = async (msg: string) => {
    log += `${((performance.now() - t00) / 1000).toFixed(1)}s ${msg}\n`;
    await invoke("bench_write", { path: `${cfg.out}.log`, text: log }).catch(() => undefined);
  };
  await step("开始");
  try {
    const m = await import("../rasteromr/browser");
    let caches: RasterOcrCaches | undefined;
    if (cfg.caches) {
      caches = {};
      for (const [k, f] of CACHE_FILES) {
        const json = JSON.parse(new TextDecoder().decode(await readBytes(`${cfg.caches}/${f}.json`))) as Record<string, never>;
        (caches as Record<string, unknown>)[k] = new Map(Object.entries(json));
      }
    }
    await step("缓存已载入");
    const save = (ok: boolean, error?: string) =>
      invoke("bench_write", { path: cfg.out, text: JSON.stringify({ ok, error, ua: navigator.userAgent, cores: navigator.hardwareConcurrency, rows }, null, 1) }).catch(() => undefined);
    /** 现跑 OCR 识别一遍，按种类计时，连同推理与 IPC 分段 */
    const live = async (path: string, bytes: Uint8Array, tag: string): Promise<Record<string, unknown>> => {
      omrProfileReset();
      await invoke("bench_ort_stats");
      const ocrMs: Record<string, number> = {};
      const ocrCalls: Record<string, number> = {};
      const t1 = performance.now();
      const r = await m.recognizeRasterPdfs([bytes.slice()], {
        onPage: (d, n) => void step(`${tag} ${path.split("/").pop()} 现跑 ${d}/${n} 页`),
        onOcr: (kind, ms) => {
          ocrMs[kind] = (ocrMs[kind] ?? 0) + ms;
          ocrCalls[kind] = (ocrCalls[kind] ?? 0) + 1;
        },
      });
      const liveMs = performance.now() - t1;
      const row = { path, tag, pages: r.pages.length, liveMs, ocrMs, ocrCalls, tsProfile: omrProfile(), ort: await invoke("bench_ort_stats"), hidden: document.hidden, focus: document.hasFocus() };
      await step(`${tag} 现跑完 ${(liveMs / 1000).toFixed(1)}s ${JSON.stringify(row.ort)}`);
      return row;
    };
    if (cfg.jianpu?.length) {
      const { recognizeMusicppDetailed } = await import("../omr/recognize");
      const { omrEmitter } = await import("../omr/emit");
      const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", bmp: "image/bmp" };
      for (const path of cfg.jianpu) {
        const name = path.split("/").slice(-2).join("_");
        omrProfileReset();
        await invoke("bench_ort_stats");
        const t0 = performance.now();
        const det = await recognizeMusicppDetailed(await readBytes(path), MIME[path.split(".").pop()!.toLowerCase()]);
        const ms = performance.now() - t0;
        if (cfg.dump) await invoke("bench_write", { path: `${cfg.dump}/${name}.txt`, text: omrEmitter("123").emit(det.score).text + "\n" + JSON.stringify(det.score) });
        rows.push({ path, tag: "简谱", ms, tsProfile: omrProfile(), ort: await invoke("bench_ort_stats"), hidden: document.hidden });
        await step(`简谱 ${name} ${(ms / 1000).toFixed(1)}s`);
      }
      await save(true);
    }
    const pdfs = cfg.pdfs ?? [];
    // 热身一遍（模块、字形字典、OCR 会话载入）：也量，与正式那遍对比
    if (pdfs[0]) rows.push(await live(pdfs[0], await readBytes(pdfs[0]), "热身"));
    await save(true);
    for (const path of pdfs) {
      const bytes = await readBytes(path);
      if (caches) {
        const t0 = performance.now();
        const r = await m.recognizeRasterPdfs([bytes.slice()], { ocrCaches: caches });
        const ms = performance.now() - t0;
        rows.push({ path, tag: "几何", pages: r.pages.length, geometryMs: ms });
        await step(`${path.split("/").pop()} 几何完 ${(ms / 1000).toFixed(1)}s`);
      }
      rows.push(await live(path, bytes, "正式"));
      await save(true);
    }
    await save(true);
  } catch (e) {
    await invoke("bench_write", { path: cfg.out, text: JSON.stringify({ ok: false, error: String((e as Error)?.stack ?? e), rows }, null, 1) }).catch(() => undefined);
  }
  await invoke("bench_exit");
}
