// dolce-wasm（crates/dolce-wasm）与 dolce-jcx-wasm（crates/dolce-jcx-wasm）的绑定形状，`scripts/build-wasm.mjs` 编到 public/redist/dolce/。
// 胶水是 wasm-bindgen `--target web` 出的，网页主线程（`common/dolce.ts::loadDolce`）与 Node（`cli/dolcewasm.node.ts`）载同一份；不入库、不进打包，按运行时路径动态载入。
// 对拍探针（`xmlDigest`、`editDigest`…）不在这份里：挂在 cargo feature `probe` 下，只编进 out/dolce-probe/ 给 dev 对拍脚本。
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

  // 模型簇给编辑器的门面（crates/dolce-wasm/src/model.rs；TS 侧在 `model/rustdoc.ts` 与各模块门面）
  /** MusicXML → `[表层句柄, ScoreDoc 的 JSON]` */
  modelLoadXml(text: string): [number, string];
  modelRelease(h: number): void;
  modelHandleCount(): number;
  /** `SyncIndex.buildXml` 的条目与换行表（JSON），对不上原文为 `"null"` */
  modelXmlSync(h: number, text: string): string;
  /** 表层查询，回 JSON */
  modelSurface(h: number, what: string, oid: number): string;
  modelHasEmbeddedLayout(h: number, measures: Uint32Array, positioned: Uint32Array): boolean;
  modelStampIds(h: number, oids: Uint32Array, ids: string[]): string | undefined;
  modelSplitFaceName(font: string): string;
  modelToXml(doc: string, h: number, opts: string): string;
  /** `{"edit": …, "doc": …}`；`tr` 把 `Msg` 的 JSON 翻成界面文字 */
  modelEdit(doc: string, h: number, cmd: string, hooks: boolean, tr?: (msg: string) => string): string;
  modelRespellMeasure(measure: string, key: string): string;
  /** `{"doc": …, "changed": n}` */
  modelHanconvDoc(doc: string, conv: (s: string) => string): string;
  modelHanDirection(doc: string, t2s: (s: string) => string): string;
  /** `SourceConvResult` 的 JSON；`parse` 回 ScoreDoc 的 JSON，读不出就抛 */
  modelHanconvSource(text: string, parse: (text: string) => string, conv: (s: string) => string): string;
  /** 歌词视图（`withLyricsFrom`），同一声部回 `"null"` */
  modelWithLyricsFrom(doc: string, from: number, to: number): string;
  /** MusicXML 是否多声部（打开时默认混排） */
  xmlIsMultiPart(xml: string): boolean;
  /** 断行（`model/breaks.ts`）：改模型的回补丁 JSON（`applyBreaks` 没落下换行回 `"null"`） */
  modelApplyBreaks(song: string, starts: string, opts: string): string;
  modelClearSongBreaks(song: string): string;
  modelBreaksOf(song: string): string;

  // ABC 家族与丢失清单（crates/dolce-wasm/src/formats.rs；TS 侧门面 `abcfamily/parse.ts`、`abcfamily/emit.ts`、`convert/capability.ts`）
  /** `dialect`：`123` / `abc` / `jcx`；回 ScoreDoc 的 JSON（带 `source`） */
  formatsParse(dialect: string, text: string): string;
  formatsEmit(dialect: string, doc: string): string;
  /** 回特性名数组的 JSON */
  formatsFeaturesUsed(doc: string, h: number): string;
  formatsPlanSave(doc: string, h: number, target: string): string;
  formatsGone(target: string): string;
  formatsAllFeatures(): string;
  formatsLyricStarts(body: string, skip: string, joinTilde: boolean): Uint32Array;
  formatsSlotsBetween(doc: string, from: number, to: number): number;
  formatsIsBareChord(name: string): boolean;
  /** 回 `Duration` 的 JSON */
  formatsDuration123(beams: number, dots: number, sustains: number): string;
  formatsNormalizeSpelling(s: string): string;
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
