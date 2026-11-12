// **桌面版测速**（只在测速构建里：`VITE_DOLCE_BENCH=1` 打前端 + cargo feature `bench` 编 Rust，见 src-tauri/src/lib.rs 的 bench 模块）。
// 启动后按 `DOLCE_BENCH` 环境变量指的配置逐份识别，结果写成 JSON 后退出。正式构建里 `main.ts` 不引这个模块（构建期常量判掉，整段剔除）。
//
// 配置：{ "out": "结果 JSON 路径", "rust": [{ "files": ["绝对路径", …], "kind": "auto|staff|jianpu", "ops": [会话操作, …] }, …] }
// 走编辑器真实入口（`OmrController.recognizeFiles` → Rust 识别），记状态栏、会话种类、核对数据、各会话操作的回话与关联表原样重建。
import { invoke } from "@tauri-apps/api/core";
import type { RustReviewResult, RustSessionOp } from "../omrrust/adapter";

interface BenchConfig {
  rust?: { files: string[]; kind?: "auto" | "staff" | "jianpu"; ops?: RustSessionOp[] }[];
  out: string;
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
  await invoke("bench_exit");
}
