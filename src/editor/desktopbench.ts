// **桌面版测速**（只在测速构建里：`VITE_DOLCE_BENCH=1` 打前端 + cargo feature `bench` 编 Rust，见 src-tauri/src/lib.rs 的 bench 模块）。
// 启动后按 `DOLCE_BENCH` 环境变量指的配置逐份识别，结果写成 JSON 后退出。正式构建里 `main.ts` 不引这个模块（构建期常量判掉，整段剔除）。
//
// 配置：{ "out": "结果 JSON 路径", "rust": [{ "files": ["绝对路径", …], "kind": "auto|staff|jianpu", "ops": [会话操作, …] }, …] }
// 走编辑器真实入口（`OmrController.recognizeFiles` → Rust 识别），记状态栏、会话种类、核对数据、各会话操作的回话与关联表原样重建。
//
// 排版宿主对账（dev `layout-node-parity.mjs --host=desktop`）：配置带 `layout`（`{ dir, jobs: [{ key, path, name, configs }] }`）时逐份打开、逐档排，
// 每份写 `<dir>/<序号>.json`：各档原生排的页（编辑器真实走的那路）、同一份请求在 WebView 的 wasm 上（WebView 量字）重排的页、请求原样（交 `dolce layout-wire`）。
import { invoke } from "@tauri-apps/api/core";
import type { RustReviewResult, RustSessionOp } from "../omrrust/adapter";
import { wasmPages, wireDump } from "../layout/rustlayout";
import { recordMeasure } from "../common/measure";
import type { App } from "./app";

interface LayoutJob {
  key: string;
  path: string;
  name: string;
  configs: string[];
}

interface BenchConfig {
  rust?: { files: string[]; kind?: "auto" | "staff" | "jianpu"; ops?: RustSessionOp[] }[];
  /** `measure`：录下 WebView 量字的调用，写 `<dir>/measure.jsonl`（交 `dolce measure-check`） */
  layout?: { dir: string; jobs: LayoutJob[]; measure?: boolean };
  out: string;
}

/** 对账的一档 → 编辑器那几步（与 dev `layout-node-parity.mjs::applyConfig` 同一套） */
async function applyConfig(app: App, cfg: string): Promise<void> {
  if (cfg === "五线谱" || cfg === "混排") return app.setViewMode(cfg === "五线谱" ? "staff" : "mixed");
  const expanded = cfg === "展开";
  if (expanded) await app.applyRenderSettings({ pageW: 960, pageH: 540, fontSize: 28 });
  else {
    const paper = cfg.replace("原样 ", "");
    await app.applyRenderSettings({ jpPaper: paper === "分页" ? "150×216mm" : paper, fontSize: 12 });
  }
  return app.setViewMode(expanded ? "expanded" : "original");
}

async function layoutJob(app: App, job: LayoutJob): Promise<unknown> {
  const out: Record<string, unknown> = { key: job.key };
  try {
    await app.setViewMode("expanded");
    await app.importBytes(await readBytes(job.path), job.name);
  } catch (e) {
    return { ...out, error: String(e) };
  }
  for (const cfg of job.configs) {
    try {
      await applyConfig(app, cfg);
      await app.whenIdle();
      const p = app.painter;
      const w = p.wire;
      out[cfg] = {
        host: Array.from({ length: p.pageCount }, (_, k) => p.pageSvg(k)),
        wasm: w ? wasmPages(w) : null,
        wire: w ? wireDump(w, job.key, cfg) : null,
      };
    } catch (e) {
      out[cfg] = `!${String(e)}`;
    }
  }
  return out;
}

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
  const saveRows = (ok: boolean, error?: string) =>
    invoke("bench_write", { path: cfg.out, text: JSON.stringify({ ok, error, ua: navigator.userAgent, rows }, null, 1) }).catch(() => undefined);
  if (cfg.rust?.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (window as any).__app;
    for (const item of cfg.rust) {
      const row: Record<string, unknown> = { files: item.files, kind: item.kind ?? "auto" };
      try {
        const files = await Promise.all(item.files.map(async (p) => ({ bytes: await readBytes(p), name: p.split("/").pop()! })));
        app.omr.kind = item.kind ?? "auto";
        const t0 = performance.now();
        row.ok = await app.omr.recognizeFiles(files);
        row.ms = Math.round(performance.now() - t0);
        row.status = app.status as string;
        row.sessionKind = app.omr.sessionKind;
        row.textHead = (app.getText() as string).slice(0, 200);
        const res = app.omr.staffResult as RustReviewResult | null;
        if (res) {
          row.stats = res.stats;
          row.noteBoxes = res.noteBoxes.size;
          row.doubts = res.doubts.length;
          row.pages = res.pages.map((p) => ({ w: p.result.raster?.bin.w, h: p.result.raster?.bin.h, scale: p.scale }));
          const ops: unknown[] = [];
          for (const op of item.ops ?? []) {
            const t1 = performance.now();
            try {
              const r = await res.apply!(op);
              ops.push({ op: op.op, ms: Math.round(performance.now() - t1), rid: r.rid, count: r.count, xml: r.xml.length });
            } catch (e) {
              ops.push({ op: op.op, error: String(e) });
            }
          }
          row.ops = ops;
          const t2 = performance.now();
          row.rebuild = await app.omr.rebuildStaff(res.assignment());
          row.rebuildMs = Math.round(performance.now() - t2);
        } else row.jianpuRows = app.omr["score"]?.rows?.length ?? null;
      } catch (e) {
        row.error = String((e as Error)?.stack ?? e);
      }
      rows.push(row);
      await step(`rust ${item.files.map((f) => f.split("/").pop()).join("+")} ${String(row.ok)} ${String(row.ms)}ms`);
      await saveRows(true);
    }
  }
  if (cfg.layout) {
    const app = (window as unknown as { __app: App }).__app;
    const take = cfg.layout.measure ? recordMeasure() : null;
    for (const [i, job] of cfg.layout.jobs.entries()) {
      const r = await layoutJob(app, job);
      await invoke("bench_write", { path: `${cfg.layout.dir}/${i}.json`, text: JSON.stringify(r) }).catch(() => undefined);
      await step(`layout ${job.key}`);
    }
    if (take) {
      const text = take().map((r) => JSON.stringify(r)).join("\n") + "\n";
      await invoke("bench_write", { path: `${cfg.layout.dir}/measure.jsonl`, text }).catch(() => undefined);
    }
  }
  await invoke("bench_exit");
}
