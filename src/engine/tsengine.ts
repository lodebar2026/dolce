// `Engine` 的 TS 实现（模型排版迁移计划 E0-2）：包住现有同步代码——解析、排版走无头排版会话（`editor/headless.ts`，与编辑器同一条路），
// 编辑走 `model/edit.ts`、写出走各格式写出端、试听走 `playSourceOf`。全部返回 Promise，同一会话按调用次序排队执行。
// 迁到 Rust 后由原生 / wasm 实现顶替，接口（`api.ts`）不变。
//
// 编辑器（`App`）在 E0 期还不经它；无头回归与命令行先用。

import type { Chord, ScoreDoc } from "../model/doc";
import * as edit from "../model/edit";
import { isEditError, posOf, type ModelEdit } from "../model/edit";
import { msgText } from "../model/msg";
import type { MetaData } from "../smufl/smufl";
import { scoreDocToMusicXml } from "../model/toxml";
import { targetSpec } from "../convert/targets";
import { playSourceOf } from "../jianpu/playsong";
import { toMidi } from "../score/play";
import { diffRegion } from "../common/lines";
import { HeadlessSession } from "../editor/headless";
import { EDIT_HOOKS, isBridgeFormat, readEditModel, writeEditModel } from "../editor/modelbridge";
import { t } from "../i18n";
import {
  EngineFailure, StaleRevision,
  type EditCmd, type EditOp, type HookedOp, type EditReply, type EditTarget, type EmitTarget, type Engine, type EngineQuery, type EngineSession,
  type QueryReply, type UpdateReply, type UpdateRequest,
} from "./api";

/** 末尾带钩子参数的动作（钩子由这里挂上，命令里不带）。与 `model/edit.ts` 的签名对不上时下面两行类型核对报错。 */
const HOOKED_OPS = [
  "setDegree", "shiftOctave", "toggleAccidental", "toggleDot", "scaleDuration", "addBeat", "insertChord", "deleteChords", "splitMeasure",
  "mergeMeasures", "insertMeasure", "deleteMeasures", "setKeyAt", "setTimeAt", "addChordNote", "removeChordNote", "stepDegree",
  "stepSemitone", "shiftSemitones", "transposeScore", "setStep", "toggleTuplet", "pasteClip", "setClefAt", "rereadKeyAt", "toggleGrace",
  "insertPitch",
] as const satisfies readonly HookedOp[];
type Missing = Exclude<HookedOp, (typeof HOOKED_OPS)[number]>;
const _allHooked: [Missing] extends [never] ? true : Missing = true;
void _allHooked;
const HOOKED: ReadonlySet<EditOp> = new Set<EditOp>(HOOKED_OPS);

/** 命令落到 `model/edit.ts` 的同名函数上。 */
function applyEdit(doc: ScoreDoc, cmd: EditCmd): ModelEdit {
  const fn = edit[cmd.op] as (doc: ScoreDoc, ...args: unknown[]) => ModelEdit;
  const args: unknown[] = [...cmd.args];
  return HOOKED.has(cmd.op) ? fn(doc, ...args, EDIT_HOOKS) : fn(doc, ...args);
}

/** 改完要落的选区换成和弦位置（重解析后元素 id 会重编）。挪记号的那几个动作（`moved`）先不认回。 */
function targetOf(doc: ScoreDoc, out: Exclude<ModelEdit, { error: unknown }>): EditTarget {
  const pos = (c: Chord) => posOf(doc, c);
  if ("select" in out) return { select: out.select.map(pos).filter((p) => p !== null) };
  if ("caretAfter" in out) {
    const p = pos(out.caretAfter);
    return p ? { caretAfter: p } : null;
  }
  const p = pos(out.caretBefore);
  return p ? { caretBefore: p } : null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TsEngine implements Engine {
  constructor(private readonly meta: MetaData) {}

  open(): Promise<EngineSession> {
    return Promise.resolve(new TsEngineSession(new HeadlessSession(this.meta)));
  }
}

class TsEngineSession implements EngineSession {
  private rev = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly s: HeadlessSession) {}

  /** 排进队里执行；执行时修订已过期就拒绝。 */
  private run<T>(rev: number, fn: () => T | Promise<T>): Promise<T> {
    const job = this.queue.then(() => {
      if (this.closed) throw new Error("会话已关闭");
      if (rev !== this.rev) throw new StaleRevision(rev, this.rev);
      return fn();
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private model(): ScoreDoc {
    const doc = this.s.model();
    if (!doc) throw new EngineFailure(this.rev, t("ve.modelUnreadable"));
    return doc;
  }

  update(req: UpdateRequest): Promise<UpdateReply> {
    const rev = ++this.rev;
    return this.run(rev, async () => {
      const s = this.s;
      s.status = "";
      try {
        s.setSource(req.text, req.format);
        if (req.settings) s.style.apply(req.settings);
        await s.setViewMode(req.view);
      } catch (e) {
        throw new EngineFailure(rev, s.status || messageOf(e));
      }
      const pages = Array.from({ length: s.pageCount }, (_, i) => s.painter.pageSize(i));
      return { rev, diagnostics: s.model()?.diagnostics ?? [], pages };
    });
  }

  page(rev: number, index: number): Promise<string> {
    return this.run(rev, () => this.s.page(index));
  }

  edit(rev: number, cmd: EditCmd): Promise<EditReply> {
    return this.run(rev, (): EditReply => {
      const fmt = this.s.docFormat;
      const text = this.s.getText();
      const doc = readEditModel(fmt, text);
      if (!doc) {
        const why = fmt === "musicxml" ? "ve.xmlUnreadable" : isBridgeFormat(fmt) ? "ve.modelUnreadable" : "ve.modelUnsupported";
        return { error: t(why) };
      }
      const out = applyEdit(doc, cmd);
      if (isEditError(out)) return { error: msgText(out.error) };
      const target = targetOf(doc, out);
      const next = writeEditModel(fmt, doc);
      return { patch: next === null || next === text ? null : diffRegion(text, next), target };
    });
  }

  emit(rev: number, target: EmitTarget): Promise<string> {
    return this.run(rev, () => {
      const doc = this.model();
      return target === "musicxml" ? scoreDocToMusicXml(doc) : targetSpec(target).emit(doc);
    });
  }

  play(rev: number, song = 0): Promise<ReturnType<typeof playSourceOf>> {
    return this.run(rev, () => playSourceOf(this.model(), song));
  }

  midi(rev: number, opts?: Parameters<typeof toMidi>[1]): Promise<Uint8Array | null> {
    return this.run(rev, () => {
      const src = playSourceOf(this.model());
      return src ? toMidi(src, opts) : null;
    });
  }

  mirror(rev: number): Promise<ScoreDoc | null> {
    // 给一份拷贝：读者改不着引擎手里那份（换成 Rust 后本来就是序列化出来的）
    return this.run(rev, () => {
      const doc = this.s.model();
      return doc ? structuredClone(doc) : null;
    });
  }

  query<Q extends EngineQuery>(rev: number, q: Q): Promise<QueryReply<Q>> {
    return this.run(rev, (): QueryReply<Q> => {
      switch (q.kind) {
        case "lineStarts": {
          const set = this.s.lineStarts(q.view);
          return (set ? [...set] : null) as QueryReply<Q>;
        }
      }
      throw new Error(`未知查询 ${(q as { kind: string }).kind}`);
    });
  }

  close(): void {
    this.closed = true;
    this.s.painter.dispose();
  }
}
