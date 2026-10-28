// Node 下的多页并行识别（回归脚本用）：`recognizeRasterSong` 按 `RASTER_WORKERS`（默认 4，=1 串行）自动挂一个 worker_threads 池。
// 脚本照旧调 `cli.recognizeRasterSong`，不用改；池在进程里只起一次，Worker 只在有页在跑时拖住进程（`ref`/`unref`）。
import { Worker } from "node:worker_threads";
import { recognizeRasterSong as recognizeRasterSongSerial } from "../rasteromr/song";
import { PagePool, type FromWorker, type PagePort } from "../rasteromr/pagepool";

/** 并行路数：`RASTER_WORKERS` 环境变量，缺省 4。 */
export function rasterWorkerCount(): number {
  const n = Number(process.env.RASTER_WORKERS ?? 4);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

let pool: PagePool | null = null;

/** 进程里共用的页池（`n` 只在第一次起池时用）。 */
export function nodeRasterPool(n = rasterWorkerCount()): PagePool {
  if (pool) return pool;
  // 文件名放变量里：免得构建时被当成要打包的资源引用
  const file = "rasterworker.js";
  const ports: PagePort[] = Array.from({ length: n }, () => {
    const w = new Worker(new URL(file, import.meta.url), { execArgv: [] });
    let handler: ((m: FromWorker) => void) | null = null;
    let busy = false;
    const sync = () => (busy ? w.ref() : w.unref());
    // 挂 `message` 监听会把 Worker 的端口重新 ref 上，所以 unref 要在挂完之后、Worker 起来之后再按忙闲设一次
    w.on("message", (m: FromWorker) => handler?.(m));
    w.on("error", (e) => handler?.({ t: "crash", error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }));
    w.once("online", sync);
    sync();
    return {
      post: (m) => w.postMessage(m),
      onMessage: (h) => (handler = h),
      terminate: () => void w.terminate(),
      busy: (on) => {
        busy = on;
        sync();
      },
    };
  });
  pool = new PagePool(ports);
  return pool;
}

/** 整曲识别（同 `rasteromr/song.ts::recognizeRasterSong`）；`RASTER_WORKERS` 不是 1 时多页并行。 */
export function recognizeRasterSong(...args: Parameters<typeof recognizeRasterSongSerial>): ReturnType<typeof recognizeRasterSongSerial> {
  const [sources, look, opts = {}] = args;
  if (opts.pool || opts.probe || rasterWorkerCount() <= 1) return recognizeRasterSongSerial(sources, look, opts);
  const p = nodeRasterPool();
  return recognizeRasterSongSerial(sources, look, { ...opts, pool: p }).catch((e) => {
    // 出错的那首可能还有页卡在等沿用、占着 Worker：整池关掉，下一首重起
    p.terminate();
    if (pool === p) pool = null;
    throw e;
  });
}
