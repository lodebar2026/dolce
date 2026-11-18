// Rust 识别的前端入口（迁移计划 P12）：桌面版走 Tauri 命令（`src-tauri/src/omr.rs`），网页版走 wasm Worker（`worker.ts`）。
// 两边一个接口：打开文档 → 渲染 / 核对底图 / 识别（进度、取消）→ 五线谱会话。识别、判路、会话都在 Rust（`crates/omr-engine`）。
import type { Binary, RecognizedScore } from "../omr/types";
import { asBuffer, tauriCore, type TauriCore } from "../common/tauricore";

export interface EngineProgress {
  done: number;
  total: number;
  /** `page` / `rows` / `notes` / `lyrics` / `header` / `spans` / `beats` / `assemble` */
  stage: string;
}

export type RecognizeKind = "auto" | "staff" | "jianpu";

export type RecognizeResult =
  /** 五线谱（含混排）：带识别 id 的 MusicXML、核对 JSON、各结果页对应的文档页号 */
  | { kind: "staff"; xml: string; review: string; pages: number[] }
  | { kind: "jianpu"; score: RecognizedScore };

/** 核对底图：`scale` = 核对坐标乘它是底图像素；`place` = 底图在页上的框与页尺寸（点；简谱没有）。 */
export interface PageBinary {
  bin: Binary;
  scale: number;
  place: { rect: { x: number; y: number; w: number; h: number }; pageW: number; pageH: number } | null;
}

export interface SessionReply {
  xml: string;
  review: string;
  /** 点原图补认：新音的识别 id */
  rid?: string;
  /** 框选重认：换了几个字 */
  count?: number;
}

export interface OmrDocHandle {
  /** 各页尺寸（PDF 是点，图片是像素） */
  readonly sizes: readonly { w: number; h: number }[];
  readonly pdf: boolean;
  render(page: number, scale: number): Promise<{ w: number; h: number; rgba: Uint8ClampedArray }>;
  binary(page: number): Promise<PageBinary>;
  recognize(opts: { kind: RecognizeKind; pages?: number[]; title?: string }, onProgress?: (p: EngineProgress) => void): Promise<RecognizeResult>;
  /** 正在识别的停下来（识别回「已取消」） */
  cancel(): void;
  /** 五线谱会话操作（`omr-staff::session::Op` 各种，外加 `insert` / `region`） */
  session(op: object): Promise<SessionReply>;
  close(): void;
}

export interface OmrEngine {
  /** 几个文件合成一份文档（页按次序接起来） */
  open(files: readonly Uint8Array[]): Promise<OmrDocHandle>;
}

/** 识别取消时 Rust 回的错误文字（`omr-core::progress::CANCELLED`）。 */
export const CANCELLED = "已取消";

export function isCancelled(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)) === CANCELLED;
}

/** 几个文件打成一个请求体：`u32 个数` + 各个 `u32 长度` + 字节（小端）。Tauri 与 Worker 同一格式。 */
export function packFiles(files: readonly Uint8Array[]): Uint8Array {
  const total = 4 + files.reduce((n, f) => n + 4 + f.byteLength, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, files.length, true);
  let off = 4;
  for (const f of files) {
    dv.setUint32(off, f.byteLength, true);
    out.set(f, off + 4);
    off += 4 + f.byteLength;
  }
  return out;
}

/** 核对底图的字节（`omr_binary` / Worker 同一格式）→ `PageBinary`。 */
export function parseBinary(buf: ArrayBuffer): PageBinary {
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true), h = dv.getUint32(4, true), scale = dv.getFloat32(8, true);
  const f = Array.from({ length: 6 }, (_, i) => dv.getFloat32(12 + i * 4, true));
  const place = f[2]! > 0 && f[3]! > 0 ? { rect: { x: f[0]!, y: f[1]!, w: f[2]!, h: f[3]! }, pageW: f[4]!, pageH: f[5]! } : null;
  return { bin: { w, h, data: new Uint8Array(buf, 36, w * h) }, scale, place };
}

/** 渲染结果的字节（`u32 宽, u32 高` + RGBA）。 */
export function parseRendered(buf: ArrayBuffer): { w: number; h: number; rgba: Uint8ClampedArray } {
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
  return { w, h, rgba: new Uint8ClampedArray(buf, 8, w * h * 4) };
}

// ---------------- 桌面版（Tauri） ----------------

function tauriEngine(core: TauriCore): OmrEngine {
  return {
    async open(files) {
      const r = (await core.invoke("omr_open", packFiles(files))) as { id: number; pdf: boolean; sizes: [number, number][] };
      const id = r.id;
      return {
        sizes: r.sizes.map(([w, h]) => ({ w, h })),
        pdf: r.pdf,
        async render(page, scale) {
          return parseRendered(asBuffer(await core.invoke("omr_render", { id, page, scale })));
        },
        async binary(page) {
          return parseBinary(asBuffer(await core.invoke("omr_binary", { id, page })));
        },
        async recognize(opts, onProgress) {
          const ch = new core.Channel<EngineProgress>();
          ch.onmessage = (p) => onProgress?.(p);
          return (await core.invoke("omr_recognize", { id, opts: { kind: opts.kind, pages: opts.pages ?? [], title: opts.title ?? null }, onProgress: ch })) as RecognizeResult;
        },
        cancel() {
          void core.invoke("omr_cancel", { id }).catch(() => undefined);
        },
        async session(op) {
          return (await core.invoke("omr_session", { id, op })) as SessionReply;
        },
        close() {
          void core.invoke("omr_close", { id }).catch(() => undefined);
        },
      };
    },
  };
}

let engine: Promise<OmrEngine> | null = null;

/** 当前环境的识别引擎：桌面版 Tauri，网页版 wasm Worker（用到时才加载）。 */
export function omrEngine(): Promise<OmrEngine> {
  engine ??= (async () => {
    const core = tauriCore();
    if (core) return tauriEngine(core);
    return (await import("./webengine")).webEngine();
  })();
  return engine;
}

/** 整页渲染的上限像素（WebKit 单张画布的上限约 1677 万）。 */
const RENDER_MAX_PX = 16_000_000;

/** 第 `page` 页渲成 PNG 的地址（并排原图的底图）；`scale` 每点几像素，太大降下来。画不出回 null。 */
export async function renderPageUrl(doc: OmrDocHandle, page: number, scale: number): Promise<{ url: string; w: number; h: number } | null> {
  const sz = doc.sizes[page];
  if (!sz) return null;
  const k = Math.min(scale, Math.sqrt(RENDER_MAX_PX / Math.max(1, sz.w * sz.h)));
  try {
    const r = await doc.render(page, k);
    const cv = document.createElement("canvas");
    cv.width = r.w;
    cv.height = r.h;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
    return blob ? { url: URL.createObjectURL(blob), w: r.w, h: r.h } : null;
  } catch {
    return null;
  }
}
