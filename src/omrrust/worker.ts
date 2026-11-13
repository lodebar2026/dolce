// 网页版识别 Worker：PDFium（emscripten 的 wasm 版）与识别（crates/omr-wasm）都在这里跑，主线程只收发消息（`webengine.ts`）。
// 两个 wasm 与 OCR 模型都在 public/redist/ 下（scripts/build-wasm.mjs 产出），用到时才取：开文档前取 PDFium 与识别模块，
// 识别 / 框选重认前取 OCR 模型。消息与 Tauri 命令一一对应，字节与 JSON 的格式同桌面版（omr-engine::Handle）。
//
// wasm 里没有线程：识别同步跑完，进度回调里查主线程放在 SharedArrayBuffer 里的取消标志，置位就在下一步停。
// OCR 分轮预取（`CachedOcr::rounds`）：每轮只查缓存跑一遍识别，缺的 OCR 攒成几份活，分给本 Worker 和几个帮手 Worker
//（同一脚本再开几份，只加载识别模块与 OCR 模型）一起推理，结果写回缓存再跑下一轮；齐了的那一轮就是结果（与逐条推理逐字一致）。

const BASE = import.meta.env.BASE_URL;
const OMR_DIR = `${BASE}redist/omr/`;
const OCR_DIR = `${BASE}redist/ocr/`;

/** omr-wasm 的导出（wasm-bindgen 生成的胶水，不带类型声明）。 */
interface OmrDocWasm {
  info(): string;
  render(page: number, scale: number): Uint8Array;
  binary(page: number): Uint8Array;
  recognize(opts: string, progress: (done: number, total: number, stage: string) => boolean): string;
  /** 齐了回结果 JSON；缺 OCR 回各份活 */
  recognize_round(opts: string, progress: (done: number, total: number, stage: string) => boolean): string | Uint8Array[];
  session(op: string): string;
  free(): void;
}
interface OmrWasm {
  default(init: { module_or_path: string | URL }): Promise<object>;
  initialize_pdfium_render(pdfium: object, local: object, debug: boolean): boolean;
  set_pdfium_module(pdfium: object): void;
  load_ocr(rec: Uint8Array, det: Uint8Array, dict: string): void;
  ocr_loaded(): boolean;
  ocr_exec(job: Uint8Array): string;
  ocr_put(results: string): void;
  OmrDoc: { open(body: Uint8Array): OmrDocWasm };
}

export type Request =
  | { id: number; cmd: "open"; body: Uint8Array }
  | { id: number; cmd: "render"; doc: number; page: number; scale: number }
  | { id: number; cmd: "binary"; doc: number; page: number }
  | { id: number; cmd: "recognize"; doc: number; opts: object; cancel: Int32Array | null }
  | { id: number; cmd: "session"; doc: number; op: object }
  | { id: number; cmd: "close"; doc: number }
  /** 帮手 Worker：推理一份 OCR 活，回 `[[缓存键, 结果], …]` 的 JSON */
  | { id: number; cmd: "ocr_exec"; job: Uint8Array };

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: { done: number; total: number; stage: string } };

const url = (rel: string) => new URL(rel, self.location.href).href;

async function bytes(path: string): Promise<Uint8Array> {
  const r = await fetch(url(path));
  if (!r.ok) throw new Error(`取 ${path} 失败（${r.status}）`);
  return new Uint8Array(await r.arrayBuffer());
}

/** PDFium 的 emscripten 脚本不是模块、把运行时挂在 `Module` 上：当函数体跑，`Module` 由参数交进去。
 *  它的 wasm 导出表是脚本内的局部量，pdfium-render 要从 `Module.wasmExports` 拿，顺手挂上；
 *  这一版只导出 `FPDF_InitLibrary`，pdfium-render 认 `PDFium_Init`，补个别名。 */
async function loadPdfium(): Promise<object> {
  const r = await fetch(url(`${OMR_DIR}pdfium.js`));
  if (!r.ok) throw new Error(`取 PDFium 失败（${r.status}）`);
  const text = `${await r.text()}\n;Module.__wasmExports = () => wasmExports;`;
  return new Promise((resolve, reject) => {
    const Module: Record<string, unknown> = {
      locateFile: (p: string) => url(`${OMR_DIR}${p}`),
      onRuntimeInitialized: () => {
        Module.wasmExports = (Module.__wasmExports as () => object)();
        Module._PDFium_Init ??= Module._FPDF_InitLibrary;
        resolve(Module);
      },
      onAbort: (e: unknown) => reject(new Error(`PDFium 加载失败：${String(e)}`)),
    };
    new Function("Module", text)(Module);
  });
}

/** 识别模块的胶水按文本取来、从 Blob 地址 import（开发服务器不让把 public/ 下的脚本当模块加载）。 */
async function loadOmr(): Promise<OmrWasm> {
  const r = await fetch(url(`${OMR_DIR}dolce_omr_wasm.js`));
  if (!r.ok) throw new Error(`取识别模块失败（${r.status}）`);
  const blob = URL.createObjectURL(new Blob([await r.text()], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ blob)) as OmrWasm;
  } finally {
    URL.revokeObjectURL(blob);
  }
}

let omrReady: Promise<{ m: OmrWasm; local: object }> | null = null;

/** 只加载识别模块（帮手 Worker 只推理 OCR，不要 PDFium）。 */
function omrOnly(): Promise<{ m: OmrWasm; local: object }> {
  omrReady ??= (async () => {
    const m = await loadOmr();
    const local = await m.default({ module_or_path: url(`${OMR_DIR}dolce_omr_wasm_bg.wasm`) });
    return { m, local };
  })();
  omrReady.catch(() => (omrReady = null));
  return omrReady;
}

let ready: Promise<OmrWasm> | null = null;

function wasm(): Promise<OmrWasm> {
  ready ??= (async () => {
    const [{ m, local }, pdfium] = await Promise.all([omrOnly(), loadPdfium()]);
    if (!m.initialize_pdfium_render(pdfium, local, false)) throw new Error("PDFium 绑定失败");
    m.set_pdfium_module(pdfium);
    return m;
  })();
  ready.catch(() => (ready = null));
  return ready;
}

let ocrReady: Promise<void> | null = null;

function ocr(m: OmrWasm): Promise<void> {
  if (m.ocr_loaded()) return Promise.resolve();
  ocrReady ??= (async () => {
    const [rec, det, dict] = await Promise.all([
      bytes(`${OCR_DIR}ch_PP-OCRv6_small_rec_infer.onnx`),
      bytes(`${OCR_DIR}ch_PP-OCRv4_det_infer.onnx`),
      bytes(`${OCR_DIR}ppocrv6_dict.txt`).then((b) => new TextDecoder().decode(b)),
    ]);
    m.load_ocr(rec, det, dict);
  })();
  ocrReady.catch(() => (ocrReady = null));
  return ocrReady;
}

/** 帮手 Worker 几个：核数减 3（留给本 Worker、页面与系统），至多 7 个；没有 `Worker`（个别环境的 Worker 里不能再开）就不开。
 *  每个帮手各载一份识别模块与 OCR 模型（约多占 60 MB），闲置 [`HELPER_IDLE_MS`] 后停掉还内存。 */
const HELPERS = typeof Worker === "undefined" ? 0 : Math.min(7, Math.max(0, (self.navigator?.hardwareConcurrency ?? 2) - 3));
const HELPER_IDLE_MS = 60_000;

class Helper {
  private w: Worker | null = new Worker(self.location.href, { type: "module" });
  private next = 0;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  constructor() {
    this.w!.onmessage = (ev: MessageEvent<Reply>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p || "progress" in r) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.value as string);
      else p.reject(new Error(r.error));
    };
    this.w!.onerror = () => this.fail(new Error("OCR 帮手 Worker 出错"));
  }

  get alive(): boolean {
    return this.w !== null;
  }

  exec(job: Uint8Array): Promise<string> {
    const w = this.w;
    if (!w) return Promise.reject(new Error("OCR 帮手 Worker 已停"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, cmd: "ocr_exec", job } satisfies Request);
    });
  }

  stop(): void {
    this.fail(new Error("OCR 帮手 Worker 已停"));
  }

  private fail(e: Error): void {
    this.w?.terminate();
    this.w = null;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}

let helpers: Helper[] | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** 一轮的 OCR 活：帮手各自取下一份，本 Worker 也同步干，每干完一份让出一下（收帮手的结果）。帮手出错的那份本 Worker 补做。 */
async function runJobs(m: OmrWasm, jobs: Uint8Array[]): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  helpers ??= Array.from({ length: HELPERS }, () => new Helper());
  idleTimer = setTimeout(() => {
    helpers?.forEach((h) => h.stop());
    helpers = null;
  }, HELPER_IDLE_MS);
  let next = 0;
  const redo: Uint8Array[] = [];
  const crew = helpers.filter((h) => h.alive).map(async (h) => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      try {
        m.ocr_put(await h.exec(j));
      } catch {
        redo.push(j);
        return;
      }
    }
  });
  // 让出一下收帮手的结果：setTimeout(0) 连着用会被钳到 4 ms，一轮几百份活就白等一两秒，改用 MessageChannel
  const yieldTask = () =>
    new Promise<void>((r) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => r();
      c.port2.postMessage(0);
    });
  while (next < jobs.length) {
    m.ocr_put(m.ocr_exec(jobs[next++]!));
    if (crew.length) await yieldTask();
  }
  await Promise.all(crew);
  for (const j of redo) m.ocr_put(m.ocr_exec(j));
}

/** 分轮识别最多几轮（同 Rust `MAX_ROUNDS`），再多就逐条推理跑完。 */
const MAX_ROUNDS = 40;

const docs = new Map<number, OmrDocWasm>();
let nextDoc = 0;

function doc(id: number): OmrDocWasm {
  const d = docs.get(id);
  if (!d) throw new Error(`没有文档 ${id}`);
  return d;
}

/** wasm 交出的 `Uint8Array` 换成独立的 ArrayBuffer（转移给主线程）。 */
function own(b: Uint8Array): ArrayBuffer {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.slice().buffer as ArrayBuffer);
}

/** wasm-bindgen 的 JsError 里是 Rust 回的错误文字。 */
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function handle(q: Request): Promise<{ value: unknown; transfer?: Transferable[] }> {
  if (q.cmd === "ocr_exec") {
    const { m } = await omrOnly();
    await ocr(m);
    return { value: m.ocr_exec(q.job) };
  }
  const m = await wasm();
  switch (q.cmd) {
    case "open": {
      const d = m.OmrDoc.open(q.body);
      const id = ++nextDoc;
      docs.set(id, d);
      return { value: { id, ...JSON.parse(d.info()) } };
    }
    case "render": {
      const b = own(doc(q.doc).render(q.page, q.scale));
      return { value: b, transfer: [b] };
    }
    case "binary": {
      const b = own(doc(q.doc).binary(q.page));
      return { value: b, transfer: [b] };
    }
    case "recognize": {
      const d = doc(q.doc);
      await ocr(m);
      const flag = q.cancel;
      // 每轮都从头跑一遍：进度只往前报
      let best = 0;
      const progress = (done: number, total: number, stage: string) => {
        const r = done / Math.max(1, total);
        if (r >= best) {
          best = r;
          self.postMessage({ id: q.id, progress: { done, total, stage } } satisfies Reply);
        }
        return flag ? Atomics.load(flag, 0) !== 0 : false;
      };
      const opts = JSON.stringify(q.opts);
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const out = d.recognize_round(opts, progress);
        if (typeof out === "string") return { value: JSON.parse(out) };
        await runJobs(m, out);
      }
      return { value: JSON.parse(d.recognize(opts, progress)) };
    }
    case "session": {
      const d = doc(q.doc);
      if ((q.op as { op?: string }).op === "region") await ocr(m);
      return { value: JSON.parse(d.session(JSON.stringify(q.op))) };
    }
    case "close": {
      docs.get(q.doc)?.free();
      docs.delete(q.doc);
      return { value: null };
    }
  }
}

self.onmessage = (ev: MessageEvent<Request>) => {
  const q = ev.data;
  handle(q).then(
    ({ value, transfer }) => self.postMessage({ id: q.id, ok: true, value } satisfies Reply, { transfer: transfer ?? [] }),
    (e: unknown) => self.postMessage({ id: q.id, ok: false, error: message(e) } satisfies Reply),
  );
};
