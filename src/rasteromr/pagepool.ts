// **多页并行识别**：每页在一个 Worker 里跑 `recognizeRasterPage`，结果与逐页串行逐字一致。
//
// 跨页只靠沿用（上一页的拍号、调号，前面有没有页眉，`PageCarry`）。识别走到第一处要用沿用的地方（`shareOctaveClefs` 之前，
// 约占单页耗时的九成之后）才向主线程要；主线程按页序收结果，收到第 k 页就把第 k+1 页的沿用发过去（流水线）。
// OCR 留在主线程（桌面版的 Tauri `invoke` 只在主线程能用；在线识别各页共用一份模型），Worker 里要 OCR、要拼页眉带都发 RPC 回来。
// 页结果经 `pagetransfer.ts` 打包传回（类实例图、可重建函数）。
//
// 这个文件不碰 DOM 与 Node API：两头各由入口接上——浏览器 `pageworker.ts` + `browser.ts`，Node `src/cli/rasterworker.ts` + `src/cli/rasterpool.ts`。

import { RasterGlyphLookup } from "./rasterglyphs";
import { rasterizeImage, type PageImage, type RasterPage } from "./rasterpage";
import { recognizeRasterPage, type PageCarry, type PageSource, type RasterLiveOcr, type RasterPageResult, type RasterStage } from "./recognize";
import { packPageResult, unpackPageResult } from "./pagetransfer";
import type { RasterOcrCaches } from "./song";

/** 在线 OCR 的各路（`RasterLiveOcr` 的方法名）。 */
export type LiveName = keyof RasterLiveOcr;

/** 一页的活：图（主线程从 pdf.js 取出的）或已栅格化好的页（判路时取过的），外加页内选项。 */
export interface PageJob {
  index: number;
  /** 在整曲里的序号（`recognizeRasterPage` 的 `pageSeq`） */
  seq: number;
  image?: PageImage | null;
  raster?: RasterPage | null;
  /** 要逐阶段的中间产物（回归测试的阶段快照）：Worker 用 `servePageWorker` 的 `project` 就地投影后发回 */
  trace?: boolean;
}

/** 主线程 → Worker */
export type ToWorker =
  | { t: "init"; look: RasterGlyphLookup; caches?: RasterOcrCaches; live: LiveName[] }
  | { t: "job"; id: number; job: PageJob }
  | { t: "carry"; id: number; carry: PageCarry }
  | { t: "reply"; rid: number; ok: true; value: unknown }
  | { t: "reply"; rid: number; ok: false; error: string };

/** Worker → 主线程 */
export type FromWorker =
  | { t: "ocr"; rid: number; id: number; name: LiveName; args: unknown[] }
  | { t: "header"; rid: number; id: number; binW: number }
  | { t: "trace"; id: number; stage: RasterStage; data: unknown }
  | { t: "done"; id: number; result: RasterPageResult }
  | { t: "fail"; id: number; error: string }
  /** Worker 本身出错死了（宿主发现后代它报） */
  | { t: "crash"; error: string };

/** 一个 Worker 的两头：发消息、收消息、关掉；`busy` 告诉宿主有没有活在跑（Node 据此 ref/unref，免得空闲 Worker 拖住进程退出）。 */
export interface PagePort {
  post(msg: ToWorker): void;
  onMessage(handler: (msg: FromWorker) => void): void;
  terminate(): void;
  busy?(on: boolean): void;
}

// ── Worker 一侧 ──────────────────────────────────────────────────────────────

/**
 * Worker 里的页处理器：收 `init` / `job` / `carry` / `reply`。
 * `project`：阶段中间产物的投影（只有测试的 Worker 入口给）。中间产物是处处回指的类实例图、过后还被就地改，
 * 传不过线程，只能在 Worker 里当场投成普通数据再发回。
 */
export function servePageWorker(post: (msg: FromWorker) => void, project?: (stage: RasterStage, data: unknown) => unknown): (msg: ToWorker) => void {
  let look: RasterGlyphLookup | null = null;
  let caches: RasterOcrCaches = {};
  let live: RasterLiveOcr | undefined;
  let rid = 0;
  const replies = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const carries = new Map<number, { resolve: (c: PageCarry) => void; promise: Promise<PageCarry> }>();
  const ask = (msg: { t: "ocr"; id: number; name: LiveName; args: unknown[] } | { t: "header"; id: number; binW: number }): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const r = ++rid;
      replies.set(r, { resolve, reject });
      post({ ...msg, rid: r });
    });
  const carryOf = (id: number) => {
    let c = carries.get(id);
    if (!c) {
      let resolve!: (v: PageCarry) => void;
      const promise = new Promise<PageCarry>((r) => (resolve = r));
      c = { resolve, promise };
      carries.set(id, c);
    }
    return c;
  };
  const run = async (id: number, job: PageJob): Promise<void> => {
    try {
      const source: PageSource = {
        raster: async () => (job.image ? rasterizeImage(job.image) : null),
        composeHeader: (binW) => ask({ t: "header", id, binW }) as ReturnType<PageSource["composeHeader"]>,
      };
      // 页文字框：离线缓存给的整张表；在线识别每页现检，各 Worker 自留一张
      const pageTexts = caches.pageTexts ?? new Map();
      if (!look) throw new Error("页 Worker 没收到 init");
      const r = await recognizeRasterPage(null, null, look, job.index, {
        ...caches,
        pageTexts,
        live,
        source,
        raster: job.raster,
        pageSeq: job.seq,
        carry: () => carryOf(id).promise,
        ...(job.trace && project ? { trace: (stage: RasterStage, data: unknown) => post({ t: "trace", id, stage, data: project(stage, data) }) } : {}),
      });
      post({ t: "done", id, result: packPageResult(r) });
    } catch (e) {
      post({ t: "fail", id, error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
    } finally {
      carries.delete(id);
    }
  };
  return (msg) => {
    switch (msg.t) {
      case "init": {
        // 主线程那份形状字典克隆过来，接回原型（只有数据字段）
        look = Object.setPrototypeOf(msg.look, RasterGlyphLookup.prototype) as RasterGlyphLookup;
        caches = msg.caches ?? {};
        live = msg.live.length ? (Object.fromEntries(msg.live.map((name) => [name, (...args: unknown[]) => ask({ t: "ocr", id: 0, name, args })])) as unknown as RasterLiveOcr) : undefined;
        break;
      }
      case "job":
        void run(msg.id, msg.job);
        break;
      case "carry":
        carryOf(msg.id).resolve(msg.carry);
        break;
      case "reply": {
        const r = replies.get(msg.rid);
        replies.delete(msg.rid);
        if (!r) break;
        if (msg.ok) r.resolve(msg.value);
        else r.reject(new Error(msg.error));
        break;
      }
    }
  };
}

// ── 主线程一侧 ──────────────────────────────────────────────────────────────

/** 一页在主线程这边要应的 RPC：OCR（`live`）与拼页眉带。 */
export interface PageHost {
  live?: RasterLiveOcr;
  composeHeader(binW: number): ReturnType<PageSource["composeHeader"]>;
  /** 收 Worker 发回的阶段产物（已投影，见 `servePageWorker` 的 `project`） */
  trace?: (stage: RasterStage, data: unknown) => void;
}

interface Slot {
  port: PagePort;
  /** 正在跑的页（null = 空闲） */
  job: { id: number; host: PageHost; resolve: (r: RasterPageResult) => void; reject: (e: Error) => void } | null;
}

export class PagePool {
  private readonly slots: Slot[];
  private readonly queue: (() => void)[] = [];
  private nextId = 0;
  private inited: { look: RasterGlyphLookup; caches: RasterOcrCaches | undefined; names: string } | null = null;
  constructor(ports: PagePort[]) {
    this.slots = ports.map((port) => ({ port, job: null }));
    for (const slot of this.slots) slot.port.onMessage((m) => this.onMessage(slot, m));
  }

  get size(): number {
    return this.slots.length;
  }

  /** 各 Worker 换一套形状字典、离线缓存与在线 OCR 的路数（同一份对象不重发）。 */
  init(look: RasterGlyphLookup, caches: RasterOcrCaches | undefined, live: RasterLiveOcr | undefined): void {
    const names = live ? (Object.keys(live) as LiveName[]).filter((k) => typeof live[k] === "function") : [];
    const same = (x: RasterOcrCaches | undefined, y: RasterOcrCaches | undefined) => {
      const ks = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]) as Set<keyof RasterOcrCaches>;
      return [...ks].every((k) => x?.[k] === y?.[k]);
    };
    if (this.inited && this.inited.look === look && same(this.inited.caches, caches) && this.inited.names === names.join(",")) return;
    this.inited = { look, caches, names: names.join(",") };
    for (const s of this.slots) s.port.post({ t: "init", look, caches, live: names });
  }

  /**
   * 跑一页：等到有空的 Worker 就发过去；沿用由 `carry` 给（识别要用时才等它）。
   * 返回解包好的页结果。
   */
  run(job: PageJob, carry: Promise<PageCarry>, host: PageHost): Promise<RasterPageResult> {
    return new Promise((resolve, reject) => {
      const start = () => {
        const slot = this.slots.find((s) => !s.job)!;
        const id = ++this.nextId;
        slot.job = { id, host, resolve, reject };
        slot.port.busy?.(true);
        slot.port.post({ t: "job", id, job });
        carry.then(
          (c) => {
            if (slot.job?.id === id) slot.port.post({ t: "carry", id, carry: c });
          },
          () => undefined,
        );
      };
      if (this.slots.some((s) => !s.job)) start();
      else this.queue.push(start);
    });
  }

  terminate(): void {
    for (const s of this.slots) {
      s.job?.reject(new Error("已取消"));
      s.job = null;
      s.port.terminate();
    }
    this.queue.length = 0;
  }

  private finish(slot: Slot): void {
    slot.job = null;
    const next = this.queue.shift();
    if (next) next();
    else slot.port.busy?.(false);
  }

  private onMessage(slot: Slot, m: FromWorker): void {
    const job = slot.job;
    switch (m.t) {
      case "done":
        if (!job || job.id !== m.id) return;
        this.finish(slot);
        job.resolve(unpackPageResult(m.result));
        return;
      case "trace":
        if (job && job.id === m.id) job.host.trace?.(m.stage, m.data);
        return;
      case "crash":
        if (!job) return;
        this.finish(slot);
        job.reject(new Error(`页 Worker 出错：${m.error}`));
        return;
      case "fail":
        if (!job || job.id !== m.id) return;
        this.finish(slot);
        job.reject(new Error(m.error));
        return;
      case "ocr":
      case "header": {
        const reply = (p: Promise<unknown>) =>
          p.then(
            (value) => slot.port.post({ t: "reply", rid: m.rid, ok: true, value }),
            (e) => slot.port.post({ t: "reply", rid: m.rid, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
        if (!job) return void slot.port.post({ t: "reply", rid: m.rid, ok: false, error: "没有在跑的页" });
        if (m.t === "header") return void reply(job.host.composeHeader(m.binW));
        const f = job.host.live?.[m.name] as ((...a: unknown[]) => Promise<unknown>) | undefined;
        if (!f) return void slot.port.post({ t: "reply", rid: m.rid, ok: false, error: `没有在线 OCR：${m.name}` });
        return void reply(f(...m.args));
      }
    }
  }
}
