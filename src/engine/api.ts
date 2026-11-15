// 排版引擎的前端接口（模型排版迁移计划 E0-2）：模型、格式读写、排版都在引擎里，TS 只经这一个异步接口说话。
// 迁移期先由 TS 实现（`tsengine.ts`，包住现有同步代码）顶上；终态桌面版是 Tauri 命令调原生 Rust、网页版是 wasm、
// 回归走命令行——接口不变，实现后换。写法同识别那一套（`omrrust/engine.ts`）。
//
// 一次会话对应一份打开的文档。`update` 交原文与排版请求，回一个修订号 `rev`；其余调用都带 `rev`，
// 引擎手里已经是更新的修订时，旧修订的调用一律以 `StaleRevision` 拒绝（调用方丢掉结果即可，不是错误）。
// 同一会话的调用按发出次序执行。
//
// 这里只放类型（与 `StaleRevision`），不引实现。

import type { Diagnostic, ElementId, ScoreDoc } from "../model/doc";
import type { ChordPos } from "../model/edit";
import type * as EditFns from "../model/edit";
import type { DocFormatId } from "../editor/formats";
import type { RenderSettings } from "../editor/stylestate";
import type { ConvertTarget } from "../convert/targets";
import type { PlayOptions, PlaySource } from "../score/timeline";

/** 编辑器的四档：简谱两档（投影 / 简谱）与五线谱、混排。 */
export type EngineView = "expanded" | "original" | "staff" | "mixed";

/** 按键路径的一次往返：原文 + 怎么排。 */
export interface UpdateRequest {
  readonly text: string;
  readonly format: DocFormatId;
  readonly view: EngineView;
  /** 排版设置（纸、字号、颜色……），同 `App.applyRenderSettings`；不给沿用上一次 */
  readonly settings?: RenderSettings;
}

export interface PageInfo {
  /** 页尺寸（排版单位，同 `ScorePainter.pageSize`） */
  readonly w: number;
  readonly h: number;
}

export interface UpdateReply {
  readonly rev: number;
  /** 解析告警（不拦排版） */
  readonly diagnostics: readonly Diagnostic[];
  readonly pages: readonly PageInfo[];
}

/** 读不出、排不了：`message` 是给状态栏的话。修订号照样前进（旧修订的结果已作废）。 */
export class EngineFailure extends Error {
  constructor(readonly rev: number, message: string) {
    super(message);
    this.name = "EngineFailure";
  }
}

/** 调用带的修订号已被新的 `update` 取代。 */
export class StaleRevision extends Error {
  constructor(readonly rev: number, readonly current: number) {
    super(`修订 ${rev} 已过期（当前 ${current}）`);
    this.name = "StaleRevision";
  }
}

export const isStale = (e: unknown): e is StaleRevision => e instanceof StaleRevision;

// ---------------------------------------------------------------- 编辑命令

/** 模型编辑动作（`model/edit.ts`，返回 `ModelEdit` 的那一批）。名字与参数照搬那边的函数，参数去掉开头的 `doc` 与末尾的钩子；
 *  M2 期 Rust 侧 `EditCmd` 照这张表逐个对上。 */
export type EditOp =
  | "setDegree" | "shiftOctave" | "toggleAccidental" | "toggleDot" | "scaleDuration" | "addBeat" | "insertChord" | "deleteChords"
  | "splitMeasure" | "mergeMeasures" | "setBreakBefore" | "toggleSlur" | "toggleTie" | "toggleDeco" | "insertMeasure" | "deleteMeasures"
  | "setKeyAt" | "setTimeAt" | "setTempoAt" | "setBarKind" | "toggleEnding" | "toggleJump" | "addChordNote" | "removeChordNote"
  | "stepDegree" | "stepSemitone" | "shiftSemitones" | "transposeScore" | "setStep" | "toggleTuplet" | "setLyric" | "setHarmony"
  | "setDirectionText" | "pasteClip" | "setClefAt" | "rereadKeyAt" | "moveMarkEnd" | "moveDirection" | "moveHarmony" | "shiftLyrics"
  | "toggleGrace" | "toggleWedge" | "toggleOctaveShift" | "removeNotation" | "deleteDirection" | "insertPitch";

/** 去掉末尾可选的钩子参数（`EditHooks` 是函数，过不了进程边界；钩子由引擎自己挂）。钩子在的函数，其余参数都必填。 */
type RequiredPrefix<T extends unknown[]> = T extends [infer H, ...infer R] ? [H, ...RequiredPrefix<R>] : [];
type DropHooks<A extends unknown[]> = Required<A> extends [...unknown[], infer L] ? (L extends EditFns.EditHooks ? (EditFns.EditHooks extends L ? RequiredPrefix<A> : A) : A) : A;
type ArgsOf<F> = F extends (doc: ScoreDoc, ...args: infer A) => unknown ? DropHooks<A> : never;
type TakesHooks<F> = F extends (doc: ScoreDoc, ...args: infer A) => unknown ? (DropHooks<A> extends A ? (A extends DropHooks<A> ? false : true) : true) : false;
/** 末尾带钩子参数的动作（实现里要把钩子挂上）。 */
export type HookedOp = { [K in EditOp]: TakesHooks<(typeof EditFns)[K]> extends true ? K : never }[EditOp];

export type EditCmd = { [K in EditOp]: { readonly op: K; readonly args: ArgsOf<(typeof EditFns)[K]> } }[EditOp];

/** 原文补丁：把 `[from, to)` 换成 `insert`（照 CodeMirror 的 change 形状）。 */
export interface TextPatch {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** 改完之后落选区：按和弦位置说（元素 id 重解析后会重编，见计划 E0-5）。 */
export type EditTarget =
  | { readonly select: readonly ChordPos[] }
  | { readonly caretAfter: ChordPos }
  | { readonly caretBefore: ChordPos }
  | null;

export type EditReply =
  /** `patch` 为 null = 改完原文没变 */
  | { readonly patch: TextPatch | null; readonly target: EditTarget }
  /** 动作做不了（`message` 给状态栏） */
  | { readonly error: string };

// ---------------------------------------------------------------- 查询

/** 低频查询：名字 → 参数与回答。 */
export interface EngineQueries {
  /** 简谱视图此刻会排出的各行首音（和弦 id），五线谱自动铺排拿它当优选断点（`paintreq.ts::lineStartsRequest`）。null = 这一路不用另给 */
  lineStarts: { args: { view: "expanded" | "original" }; reply: readonly ElementId[] | null };
}

export type EngineQuery = { [K in keyof EngineQueries]: { readonly kind: K } & EngineQueries[K]["args"] }[keyof EngineQueries];
export type QueryReply<Q extends EngineQuery> = EngineQueries[Q["kind"]]["reply"];

// ---------------------------------------------------------------- 会话

/** 写出目标：可编辑的文本格式（`convert/targets.ts`）或 MusicXML。 */
export type EmitTarget = ConvertTarget | "musicxml";

export interface EngineSession {
  /** 交原文、按请求排好。旧修订的在途调用随之作废。读不出、排不了以 `EngineFailure` 拒绝。 */
  update(req: UpdateRequest): Promise<UpdateReply>;
  /** 第 `index` 页的 SVG（页按需取，不随 `update` 全量给） */
  page(rev: number, index: number): Promise<string>;
  /** 在这份修订的模型上做一个编辑动作，回原文补丁（调用方放进代码区后照常 `update`） */
  edit(rev: number, cmd: EditCmd): Promise<EditReply>;
  /** 整份写成某种格式 */
  emit(rev: number, target: EmitTarget): Promise<string>;
  /** 试听输入（演唱顺序已展开）；这份没有曲行为 null */
  play(rev: number, song?: number): Promise<PlaySource | null>;
  /** 标准 MIDI 文件；没有曲行为 null */
  midi(rev: number, opts?: PlayOptions): Promise<Uint8Array | null>;
  /** 模型的只读镜像（识别核对等少数低频读者用；形状 = `model/doc.ts`） */
  mirror(rev: number): Promise<ScoreDoc | null>;
  query<Q extends EngineQuery>(rev: number, q: Q): Promise<QueryReply<Q>>;
  close(): void;
}

export interface Engine {
  open(): Promise<EngineSession>;
}
