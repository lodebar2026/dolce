// dolce-wasm（crates/wasm）与 dolce-jcx-wasm（crates/jcx-wasm）的绑定形状，`scripts/build-wasm.mjs` 编到 public/redist/dolce/。
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

/** 排版结果句柄（`crates/wasm/src/layout.rs::Layout`）：排好的一份留在 wasm 里，按页取 SVG、身份表、场景。 */
export interface DolceLayoutWasm {
  /** `LaidInfo` 的 JSON（`layout/rustlayout.ts::LaidInfo`） */
  info(): string;
  pageCount(): number;
  /** 第 `i` 页的 SVG（`outerHTML` 口径） */
  svg(i: number): string;
  /** 第 `i` 页的身份表（`SceneHit[]` 的 JSON） */
  hits(i: number): string;
  /** 第 `i` 页的场景 JSON（导出 PDF / PPTX） */
  scene(i: number): string;
  /** 简谱：定稿栅格 / 定位结构的 JSON；五线谱回空串 */
  gridJson(): string;
  placedJson(): string;
  free(): void;
}

/** 交给 wasm 的量字适配器（`layout/rustlayout.ts::wasmMeasure`）：结果一律是数组。 */
export interface WasmMeasure {
  /** `[advance, l, t, r, b]` */
  glyph(text: string, family: string, size: number, bold: boolean, features: string, italic: boolean): Float64Array;
  /** `[x0, x1, …, 总宽]` */
  positions(text: string, family: string, size: number, bold: boolean, features: string): Float64Array;
  /** `[ascent, descent]` */
  fontMetrics(family: string, size: number, bold: boolean, italic: boolean): Float64Array;
  /** `[l, t, r, b]` */
  pathBounds(d: string): Float64Array;
}

export interface DolceWasm {
  // 排版（crates/dolce-session/src/layout.rs）：宿主设一次量字与 SMuFL 元数据，之后同步排
  setLayoutHost(measure: WasmMeasure, smufl: string): void;
  clearMeasureCache(): void;
  /** `doc` 是 ScoreDoc JSON，`req` 是 `JianpuRequest` JSON */
  layoutJianpu(doc: string, req: string): DolceLayoutWasm;
  /** `surface` 是 MusicXML 表层句柄（0 = 没有） */
  layoutStaff(doc: string, surface: number, req: string): DolceLayoutWasm;
  /** `{width, spans: [[id, {x0, x1, x1b}]]}` 的 JSON */
  measureDocument(doc: string, style: string, width: number, slide: boolean, song: number): string;
  engravedMusicXml(doc: string, surface: number, req: string): string;
  staffChordSpans(doc: string, surface: number, req: string): string;
  /** 按参照歌词生成段落与 `%%sing`（`dolce_session::sing`）：`req` 是投影档 `JianpuRequest` JSON，回 `SingFitReport` JSON */
  singFromLyrics(doc: string, song: number, lyrics: string, req: string): string;

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
  /** 断句之后的那几步（`applybreaks.ts` 门面）：回 `{breaks, out}` */
  phraseLayoutOp(op: string, part: string, breaks: string, opts: string): string;
  pageBreakLines(lines: number, sectionEnds: Uint32Array, pageLines: number): Uint32Array;
  /** `[主歌词, 标点分, 旋律键]` */
  phraseChordFacts(chord: string): string;
  headFpOf(chords: string): string;

  // 模型簇给编辑器的门面（crates/wasm/src/model.rs；TS 侧在 `model/rustdoc.ts` 与各模块门面）
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
  /** 表层改过几次（桌面版原生排版据此判断要不要重送快照） */
  modelSurfaceGen(h: number): number;
  /** 表层整份快照（bincode，交给原生排版） */
  modelSurfaceSnapshot(h: number): Uint8Array;
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
  /** 小节时值自检；`opts` 是 `{meters?, pickup?: boolean[][]}` 的 JSON，回 `BeatIssue[]` 的 JSON */
  modelBeatCheck(doc: string, opts: string): string;
  /** 简谱来源投成 MusicXML 形状（不带身份）；`opts` 是 `{lineStarts?, midLineStarts?, slurTies?}` 的 JSON */
  modelProjectForMusicXml(song: string, opts: string): string;
  /** 同音弧改记延音线；没有要改的回 undefined */
  modelSlursAsTies(song: string): string | undefined;
  /** `[[小节下标, {start?, stop, repeatBack}]]` 的 JSON */
  modelVoltasOfPlayOrder(song: string): string;
  /** 投成简谱形状；不必投的回 undefined */
  modelProjectForJianpu(song: string): string | undefined;
  /** `{page, staffSize, lyricSize, headerFonts}` 的 JSON；`h` 是表层句柄（0 = 没有） */
  modelPageInfo(song: string, h: number): string;
  modelStandardPaperOf(w: number, h: number): string;
  modelHeaderRoleOfCredit(kind: string | undefined, justify: string | undefined, biggest: boolean): string | undefined;
  /** 没有要写进 meta 的回 undefined，有就回整份新文档（带身份） */
  modelWithPageMeta(doc: string, h: number): string | undefined;
  /** 各首要设的演唱顺序字段 `[{playOrder?, sectionOrder?, singOrder?, sectionMarks?}]` 的 JSON */
  modelCarryPlayOrder(from: string, to: string): string;
  /** 排版行视图（`jianpu/slots.ts`）：id 化的 `DocView` JSON（`refs` 存下标，投影改过曲子的另带 `song`）；`source` 空串 = 用 `doc.source` */
  modelDocView(doc: string, source: string): string;
  /** 由 `ScoreDoc` 拼试听输入（crates/dolce-view，门面 `score/play.ts`）：回 `{source: PlaySource, playData: PlayData}`，没有曲行回 `"null"` */
  modelPlaySource(doc: string, song: number, forExpanded: boolean): string;
  modelPlaySourceOfDoc(song: string, melodyOnly: boolean): string;
  /** 简谱形状的演唱顺序（已折回第一份声部）：`PlayData` 的 JSON，没有曲行回 `"null"` */
  modelPlayData(doc: string, song: number, forExpanded: boolean): string;
  /** 断句输入：`{part: PhrasePart, ids: (number|null)[]}`（`ids` 按拍平下标），没有曲行回 `"null"` */
  modelPhrasePart(doc: string, song: number): string;
  modelPhrasePartOfDoc(song: string, partIndex: number, distinct: boolean): string;
  modelPhraseJumpMeasures(song: string, partIndex: number): Uint32Array;
  /** `ScoreDoc` → `.jpwabc`（`convert/jpwabc.ts`）；没有曲行回 undefined */
  /** 成书断点 → 行首：回 `{starts, lines, pages}` */
  modelPhraseLineStarts(song: string, part: string, ids: string, breaks: string, opts: string): string;
  /** 成书段落词挂到哪个和弦：回 `[[元素 id, 词]]` */
  modelSectionWordTargets(song: string, part: string, ids: string, rows: string): string;
  /** 按乐句 / 每行 n 小节重排：回 `{cuts, lines, kept, overflow}` */
  modelPhraseCuts(doc: string, song: number, plan: string, measured: string): string;
  /** 逐遍走小节：扁平步骤（放小节 `0, mid, pass, skip, limit, last, glue, 项下标`、换页 `1`、往回跳只换行 `2`） */
  walkPlay(items: Float64Array, jumpBack: boolean): Float64Array;
  countPasses(items: Float64Array): number;
  /** 照原有行结构在某元素后加 / 去一刀：回新行或 `null` */
  modelPhraseLinesEdited(doc: string, song: number, afterId: number, add: boolean, page: boolean): string;
  modelEmitJpwabc(doc: string, song: number): string | undefined;

  // ABC 家族与丢失清单（crates/wasm/src/formats.rs；TS 侧门面 `abcfamily/parse.ts`、`abcfamily/emit.ts`、`convert/capability.ts`）
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

  // 文本谱、.jpwabc、jianpu-ly、MIDI 导入（crates/wasm/src/textformats.rs；TS 侧门面 `fanqie/*`、`jpword/*`、`model/fromjpw.ts`、`convert/jpwabc.ts`、`jly/*`、`midi/import.ts`）
  /** `dialect` 空串 = 嗅探；回语法树 / ScoreDoc 的 JSON */
  fanqieParseAst(text: string, dialect: string): string;
  fanqieParse(text: string, dialect: string): string;
  fanqieToScoreDoc(ast: string): string;
  /** `{ dialect, reason: Msg }` */
  fanqieSniff(text: string): string;
  fanqieDialectSpec(dialect: string): string;
  /** `phraseCuts(songJson)` 回各刀行首 id 的 JSON 数组或 `"null"` */
  fanqieEmit(doc: string, dialect: string): string;
  fanqieEmitSong(song: string, dialect: string, fromFanqie: boolean, fromAbc: boolean): string;
  /** 文本谱按逐首新行重排原文 */
  fanqieRelayoutText(text: string, doc: string, plans: string): string;
  /** 文本谱增删一处换行：加不上 / 去不掉回 undefined */
  fanqieRelayoutBreak(text: string, doc: string, afterId: number, add: boolean, page: boolean): string | undefined;
  /** `.jpwabc` 按断点只挪 `.Voice` 的 `$` */
  jpwRelayoutText(text: string, cuts: string): string;
  /** 123 / ABC 重排后把原文注释缝回 */
  abcSpliceComments(oldText: string, oldDoc: string, newText: string, newDoc: string): string;
  /** 123 / ABC 原文里第 `song` 首版面 `layout` 的整体选项 `key` 设成 `value`（空串 = 去掉），只改 `%%layout` 行 */
  abcSetLayoutOption(text: string, song: number, layout: string, key: string, value: string): string;
  abcRemoveLayout(text: string, song: number, layout: string): string;
  /** `pass` 0 = 每一遍 */
  abcLayoutAddBreak(text: string, song: number, layout: string, pass: number, section: string, nth: number, page: boolean): string;
  abcLayoutRemoveBreak(text: string, song: number, layout: string, pass: number, section: string, nth: number): string;
  abcSplitSection(text: string, song: number, name: string, newName: string): string;
  abcMergeSection(text: string, song: number, name: string): string;
  fanqieKeyNameOf(fifths: number, suffix: boolean): string;
  /** `[嵌套, 奇数连音, 倚音弧]` */
  fanqieArcLosses(song: string): Uint32Array;
  /** 每个 token `[类型, 原文, 起, 止, 行, 列]` */
  jpwLex(text: string): string;
  /** 分节；读不出 `"null"` */
  jpwFile(text: string): string;
  /** `{ doc }` / `{ error: { model: Msg } | { fail } }`；分节读不出 `"null"` */
  jpwToScoreDoc(text: string): string;
  jpwSource(text: string): string;
  /** `ScoreDoc` JSON → `{ text, warnings }`；投影不出来抛 `noLines` */
  jlyEmit(doc: string): string;
  /** `{ doc, losses: Msg[], unknown }` */
  jlyParse(text: string): string;
  jlyRewrap(text: string, measuresPerLine: number, skipPickup: boolean): string;
  jlyIsMusicLine(line: string): boolean;
  jlyChordTimeline(tokens: string, fallback: number): string;
  jlyHarmonyToChordToken(text: string, whole: number): string | undefined;
  /** `[文字, 是否精确]` */
  jlyWholeToDuration(whole: number): string;
  /** `{ doc, warnings: Msg[] }` / `{ error: Msg }` */
  midiImport(bytes: Uint8Array, title: string, opts: string): string;

  // 识别结果建模（crates/omr-todoc）：入参是 `RecognizedScore` 的 JSON
  /** `{ doc, numOf: [元素 id, 拍平后的音符下标][] }` */
  omrJianpuDoc(score: string): string;
  /** 各音符（拍平序）的和弦落点 `"h"` / `"s<k>"` / `"l<k>"` */
  omrChordPlaces(score: string): string;
}

/** 按需载入的那份（crates/jcx-wasm，同目录 `dolce_jcx_wasm.*`）：Muse .jcx 字节编解码，GBK / BIG5 码表占体积所以不进开机那份。 */
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
