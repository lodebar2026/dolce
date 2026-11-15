// dolce-wasm（crates/dolce-wasm，`scripts/build-wasm.mjs` 编到 public/redist/dolce/）的绑定形状。
// 胶水是 wasm-bindgen `--target web` 出的，网页主线程与 Node 门面（`cli/dolce.ts`）载同一份；不入库、不进打包，按运行时路径动态载入。
// 数据过边界一律 JSON 字符串；会话调用失败抛 `Error`，`message` 是 `dolce_session::EngineError` 的 JSON。

export interface DolceSessionWasm {
  /** `UpdateRequest` 的 JSON → `UpdateReply` 的 JSON */
  update(req: string): string;
  page(rev: number, index: number): string;
  emit(rev: number, target: string): string;
  free(): void;
}

export interface DolceWasm {
  default(init?: { module_or_path: string | URL }): Promise<object>;
  initSync(init: { module: BufferSource | WebAssembly.Module }): object;
  version(): string;
  /** XML 树对拍原料：`{"ok":true,"xml","spans"}` 或 `{"ok":false,"message","at"}` */
  xmlDigest(text: string): string;
  Session: new () => DolceSessionWasm;
}

/** 会话失败（`EngineError` 的 JSON 形状）。 */
export type DolceEngineError =
  | { kind: "stale"; rev: number; current: number }
  | { kind: "failure"; rev: number; msg: { key: string; args?: Record<string, unknown> } };
