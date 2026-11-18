// 桌面版（Tauri）的 `invoke` 入口：取 `window.__TAURI__.core`（不经 `@tauri-apps/api` 打包，网页版里就是 null）。
// 识别（`omrrust/engine.ts`）与原生排版（`layout/rustlayout.ts`）共用。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TauriCore = { invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<any>; Channel: new <T>() => { onmessage: (m: T) => void } };

/** 桌面版的 Tauri core；网页、Node 里为 null。 */
export function tauriCore(): TauriCore | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((globalThis as any).__TAURI__?.core as TauriCore | undefined) ?? null;
}

/** `ipc::Response` 回来的字节统一成 ArrayBuffer。 */
export function asBuffer(raw: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}
