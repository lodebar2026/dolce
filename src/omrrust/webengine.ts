// 网页版识别引擎：识别、PDFium 都在 Worker 里（`worker.ts`，wasm），这里只把 `OmrEngine` 接口翻成消息。
// 取消：页面跨源隔离时经 SharedArrayBuffer 里的标志让 Worker 在下一步停（识别回「已取消」）；
// 不隔离时 Worker 收不到消息（识别同步跑满），只能整个停掉 Worker，那时打开的文档跟着作废。
import { CANCELLED, packFiles, parseBinary, parseRendered, type EngineProgress, type OmrDocHandle, type OmrEngine, type RecognizeResult, type SessionReply } from "./engine";
import type { Reply, Request } from "./worker";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: EngineProgress) => void };

// 分配到各请求上的 Omit 保留联合各支
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

class Channel {
  private worker: Worker | null = null;
  private next = 0;
  private pending = new Map<number, Pending>();
  /** 换过几回 Worker（停掉重开后旧文档作废） */
  gen = 0;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<Reply>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      if ("progress" in r) return p.onProgress?.(r.progress);
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    };
    w.onerror = (ev) => this.reset(new Error(ev.message || "识别 Worker 出错"));
    this.worker = w;
    return w;
  }

  call<T>(q: DistributiveOmit<Request, "id">, transfer: Transferable[] = [], onProgress?: (p: EngineProgress) => void): Promise<T> {
    const w = this.ensure();
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      w.postMessage({ ...q, id } as Request, transfer);
    });
  }

  /** 停掉 Worker，未完的请求都以 `e` 结束。 */
  reset(e: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.gen++;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}

const SHARED = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;

export function webEngine(): OmrEngine {
  const ch = new Channel();
  return {
    async open(files) {
      const body = packFiles(files);
      const r = await ch.call<{ id: number; pdf: boolean; sizes: [number, number][] }>({ cmd: "open", body }, [body.buffer]);
      const doc = r.id;
      const gen = ch.gen;
      let flag: Int32Array | null = null;
      let running = false;
      const alive = () => {
        if (ch.gen !== gen) throw new Error("识别 Worker 已重开，文档要重新打开");
      };
      const handle: OmrDocHandle = {
        sizes: r.sizes.map(([w, h]) => ({ w, h })),
        pdf: r.pdf,
        async render(page, scale) {
          alive();
          return parseRendered(await ch.call<ArrayBuffer>({ cmd: "render", doc, page, scale }));
        },
        async binary(page) {
          alive();
          return parseBinary(await ch.call<ArrayBuffer>({ cmd: "binary", doc, page }));
        },
        async recognize(opts, onProgress) {
          alive();
          flag = SHARED ? new Int32Array(new SharedArrayBuffer(4)) : null;
          const o = { kind: opts.kind, pages: opts.pages ?? [], title: opts.title ?? null };
          running = true;
          try {
            return await ch.call<RecognizeResult>({ cmd: "recognize", doc, opts: o, cancel: flag }, [], onProgress);
          } finally {
            flag = null;
            running = false;
          }
        },
        cancel() {
          if (flag) Atomics.store(flag, 0, 1);
          else if (running && ch.gen === gen) ch.reset(new Error(CANCELLED));
        },
        async session(op) {
          alive();
          return ch.call<SessionReply>({ cmd: "session", doc, op });
        },
        close() {
          if (ch.gen === gen) void ch.call({ cmd: "close", doc }).catch(() => undefined);
        },
      };
      return handle;
    },
  };
}
