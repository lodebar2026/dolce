// dolce-wasm（crates/dolce-wasm）与 dolce-jcx-wasm（crates/dolce-jcx-wasm）的绑定形状，`scripts/build-wasm.mjs` 编到 public/redist/dolce/。
// 胶水是 wasm-bindgen `--target web` 出的，网页主线程（`common/dolce.ts::loadDolce`）与 Node（`cli/dolcewasm.node.ts`）载同一份；不入库、不进打包，按运行时路径动态载入。
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

  // 演唱顺序、断句、时间轴、MIDI（crates/dolce-play）：入参回值是 JSON，编解码在 `score/play.ts`
  playOrderOf(parts: string, jumps: string): string;
  /** 回 `PlayOrder` 或 `"null"` */
  sectionPlayOrder(parts: string, jumps: string, seq: string, marks: string): string;
  singPlayOrder(parts: string, marks: string, pages: string): string;
  playOrderFromSpec(items: string, part0: string): string;
  playOrderByVerses(measureCount: number, passes: number): string;
  unplayedMeasures(items: string, measureCount: number): string;
  buildTimeline(src: string): string;
  toMidi(src: string, opts: string, click: boolean): Uint8Array;
  playTempo(tempo: number, opts: string): number;
  partGain(opts: string, part: number): number;
  computePhraseBreaks(part: string, opts: string): string;
  targetMeasForCells(part: string, cells: number): number;
  /** `[主歌词, 标点分, 旋律键]` */
  phraseChordFacts(chord: string): string;
  headFpOf(chords: string): string;

  // 模型（crates/dolce-model，M2 迁移中，对拍用）
  /** `ScoreDoc` 的 JSON 读进 Rust 类型再写回 */
  docRoundtrip(doc: string): string;
  /** 查询层摘要（口径见 dev `rs-diff.mjs query`） */
  queryDigest(doc: string): string;
  /** MusicXML 读入摘要（口径见 dev `rs-diff.mjs fromxml`） */
  fromXmlDigest(text: string): string;
}

/** 按需载入的那份（crates/dolce-jcx-wasm，同目录 `dolce_jcx_wasm.*`）：Muse .jcx 字节编解码，GBK / BIG5 码表占体积所以不进开机那份。 */
export interface JcxWasm {
  default(init?: { module_or_path: string | URL }): Promise<object>;
  initSync(init: { module: BufferSource | WebAssembly.Module }): object;
  decodeJcx(bytes: Uint8Array): string;
  encodeJcx(text: string): { readonly bytes: Uint8Array; readonly missing: string; free(): void };
}

/** 会话失败（`EngineError` 的 JSON 形状）。 */
export type DolceEngineError =
  | { kind: "stale"; rev: number; current: number }
  | { kind: "failure"; rev: number; msg: { key: string; args?: Record<string, unknown> } };
