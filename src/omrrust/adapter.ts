// Rust 识别（`crates/omr-staff`）→ 编辑器的**核对数据**（`omr/review.ts::StaffReviewResult`）。
//
// 过渡件（迁移计划 P10 方案 A）：乐谱本身走带识别 id 的 MusicXML（Rust `Score::to_musicxml`，编辑器照旧 `adoptStaffXml` → `fromxml`，
// `xmlsurface` / `surfaceIds` / `carryIds` / 按 id 回放一行不改）；MusicXML 表达不了的——各页谱行几何、系统表、关联表、源框、
// 可疑清单、落选候选——走核对 JSON（Rust `Song::review_json_with`，`omr-cli recognize staff` 写成 `<曲>.review.json`）。
// ScoreDoc 以后若迁进 Rust，识别结果直接建模型，这份适配器连同 JSON 中转一并退役。
//
// 改关联表、改系统切分不重认：转调 Rust 会话（`omr-staff::session`），会话回新的 MusicXML 与核对 JSON。
// 页面几何（谱行、小节、音框）不随这两样变，适配器只换系统表与关联表，系统里引用的谱行、页对象与 `pages[].result.page` 保持同一个
// （编辑器按引用比，见 `ReviewGeometry`）。
import type { Binary } from "../omr/types";
import type { MarkBox, ReviewGeometry, ReviewPageGeom, ReviewStaff, StaffReviewPage, StaffReviewResult, StaffReviewStats } from "../omr/review";
import type { SystemOp } from "../omr/review";

type LrtbBox = { left: number; right: number; top: number; bottom: number };

/** 落选候选（Rust `review.rs`：满拍裁决那几样，`cost` 越小越像）。 */
export type RustAlt =
  | { kind: "duration"; type: string; dots: number; cost: number }
  | { kind: "drop"; cost: number };

/** 可疑项（Rust `omr-sheet::result::Doubt`）：`rect` 是原图像素 xywh，`at.page` 1 起。 */
export interface RustDoubt {
  rid?: string;
  at: { page: number; system?: number; row?: number; measure?: number; note?: number };
  rect: { x: number; y: number; w: number; h: number };
  code: string;
  note?: string;
  alts?: unknown[];
}

/** 核对 JSON（`version` 1）。页下标 0 起，坐标是原图像素。 */
export interface RustReviewJson {
  version: 1;
  pages: { pn: number; scale: number; staves: ReviewStaff[]; jianpu: number }[];
  /** 各系统：第几页、由页内哪几行谱组成（自上而下）。含会话里标了「不要」的行 */
  systems: { page: number; staves: number[] }[];
  /** 与 `systems` 同形：各行配到第几个声部行，`null` = 这一行不要 */
  assignment: (number | null)[][];
  noteBoxes: Record<string, { page: number; box: LrtbBox; step: string; octave: number; alter: number; rest: boolean }>;
  markBoxes: Record<string, MarkBox>;
  doubts: RustDoubt[];
  /** 事件第一个音的识别 id → 落选候选 */
  alts: Record<string, RustAlt[]>;
  stats: { pages: number; parts: number; systems: number; notes: number; bars: number; full: number };
}

/** 识别音高（同 MusicXML：`step` 0..6 = C..B）。 */
export type RustPitch = { step: number; octave: number; alter: number };

/** 会话操作（Rust `omr-staff::session::Op` 与 `omr-engine` 的 insert / region）。 */
export type RustSessionOp =
  | { op: "rebuild"; slots: (number | null)[][] }
  | { op: "restructure"; change: { kind: "merge"; system: number } | { kind: "split"; system: number; row: number } }
  | { op: "pin"; rid: string; fact: { fact: "drop" } | { fact: "duration"; ntype: string; dots: number } | { fact: "pitch"; pitch: RustPitch } }
  | { op: "unpin"; rid: string }
  | { op: "choose"; rid: string; alt: number }
  | { op: "insert"; page: number; x: number; y: number }
  | { op: "region"; page: number; rect: { x: number; y: number; w: number; h: number }; class: "lyric" | "text" };

/** 会话的回话：新的 MusicXML 与核对 JSON（补认另回新音的 id，重认回换了几个字）。 */
export type RustSessionReply = { xml: string; review: string | RustReviewJson; rid?: string; count?: number };

/** 转调会话：做一条操作；做不了回 null（Tauri 命令 / wasm Worker 都是异步的）。 */
export type RustSessionCall = (op: RustSessionOp) => Promise<RustSessionReply | null>;

export interface RustReviewResult extends StaffReviewResult {
  /** 可疑清单与落选候选（随会话操作更新） */
  doubts: RustDoubt[];
  alts: Map<string, RustAlt[]>;
  /** 做一条会话操作（钉住、换候选、补认、重认……），回新的 MusicXML 与系统结构；回话里的 `rid` / `count` 原样带出。没有会话为 undefined */
  apply?(op: RustSessionOp): Promise<{ xml: string; score: ReviewGeometry; rid?: string; count?: number }>;
}

export interface RustReviewOpts {
  /** 各页底图（与 `pages` 同序；对照视图要）。缺了的页 `raster` 为 null */
  rasters?: readonly (Binary | null | undefined)[];
  /** 各页核对坐标乘几是底图像素（矢量页按 PDF 点识别、底图放大渲；缺省取核对 JSON 的） */
  scales?: readonly (number | undefined)[];
  /** 会话；不给就不能改关联表 / 系统切分 */
  call?: RustSessionCall;
}

const parse = (j: string | RustReviewJson): RustReviewJson => {
  const o = typeof j === "string" ? (JSON.parse(j) as RustReviewJson) : j;
  if (o.version !== 1) throw new Error(`核对 JSON 版本不认得：${String(o.version)}`);
  return o;
};

/** TS 关联表里 -1 = 不要；Rust 记 null。 */
const toTs = (a: readonly (readonly (number | null)[])[]): number[][] => a.map((r) => r.map((v) => v ?? -1));
const toRust = (a: readonly (readonly number[])[]): (number | null)[][] => a.map((r) => r.map((v) => (v < 0 ? null : v)));

export function systemOpToRust(op: SystemOp): RustSessionOp {
  return "merge" in op
    ? { op: "restructure", change: { kind: "merge", system: op.merge } }
    : { op: "restructure", change: { kind: "split", system: op.split.system, row: op.split.row } };
}

/** 核对 JSON + 带 id 的 MusicXML → `StaffReviewResult`（对照视图、关联表、谱行菜单照用）。 */
export function reviewFromRust(json: string | RustReviewJson, xml: string, opts: RustReviewOpts = {}): RustReviewResult {
  const first = parse(json);
  // 页面几何只建一次：之后换系统表时，系统里引用的还是这些对象
  const pageGeoms: ReviewPageGeom[] = first.pages.map((p) => ({ staves: p.staves }));
  const pages: StaffReviewResult["pages"] = first.pages.map((p, i) => {
    const bin = opts.rasters?.[i];
    const result: StaffReviewPage & { jianpuStrips: readonly unknown[] } = {
      raster: bin ? { bin } : null,
      page: pageGeoms[i]!,
      jianpuStrips: Array.from({ length: p.jianpu }, () => null),
    };
    return { source: 0, pn: p.pn, result, scale: opts.scales?.[i] ?? p.scale };
  });
  const geometry = (j: RustReviewJson): ReviewGeometry => ({
    systems: j.systems.map((s) => {
      const page = pageGeoms[s.page];
      if (!page) throw new Error(`核对 JSON 的系统指向没有的页 ${s.page}`);
      return { page, sys: { staves: s.staves.map((k) => page.staves[k]!) } };
    }),
  });
  const noteBoxes: StaffReviewResult["noteBoxes"] = new Map();
  const markBoxes: StaffReviewResult["markBoxes"] = new Map();
  let current = first;
  const res: RustReviewResult = {
    xml,
    score: geometry(first),
    stats: statsOf(first),
    pages,
    noteBoxes,
    markBoxes,
    doubts: [],
    alts: new Map(),
    assignment: () => toTs(current.assignment),
    async rebuild(slots) {
      const r = await run({ op: "rebuild", slots: toRust(slots) });
      if (!r) throw new Error("会话没有回结果");
      return r;
    },
  };
  const adopt = (j: RustReviewJson): void => {
    current = j;
    noteBoxes.clear();
    for (const [id, b] of Object.entries(j.noteBoxes)) noteBoxes.set(id, b);
    markBoxes.clear();
    for (const [id, b] of Object.entries(j.markBoxes)) markBoxes.set(id, b);
    res.doubts = j.doubts;
    res.alts = new Map(Object.entries(j.alts));
    res.stats = statsOf(j);
  };
  const run = async (op: RustSessionOp): Promise<{ xml: string; score: ReviewGeometry; rid?: string; count?: number } | null> => {
    if (!opts.call) throw new Error("没有会话，不能重拼");
    const r = await opts.call(op);
    if (!r) return null;
    const j = parse(r.review);
    if (j.pages.length !== pageGeoms.length) throw new Error("会话回来的页数变了");
    adopt(j);
    res.xml = r.xml;
    return { xml: r.xml, score: geometry(j), ...(r.rid ? { rid: r.rid } : {}), ...(r.count !== undefined ? { count: r.count } : {}) };
  };
  if (opts.call) {
    res.restructure = (op) => run(systemOpToRust(op));
    res.apply = async (op) => {
      const r = await run(op);
      if (!r) throw new Error("会话没有回结果");
      return r;
    };
  }
  adopt(first);
  return res;
}

function statsOf(j: RustReviewJson): StaffReviewStats {
  const s = j.stats;
  return {
    notes: s.notes,
    harmonies: 0,
    lyricLines: 0,
    lyricStats: { rows: 0, hit: 0, parity: 0 },
    bars: s.bars,
    full: s.full,
    unknown: 0,
    staves: j.pages.reduce((n, p) => n + p.staves.length, 0),
    pages: s.pages,
    halftone: null,
    kind: null,
    jianpuFix: { pairs: 0, pitch: 0, duration: 0, removed: 0, inserted: 0 },
    systems: s.systems,
    parts: s.parts,
  };
}
