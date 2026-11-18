// 模型簇（crates/dolce-model）的 TS 镜像：Rust 回来的 `ScoreDoc` JSON 读成普通对象（形状同 `doc.ts`），
// 可绑对象的身份 `_oid` 摘下来记在旁表里（对象上不留，`{ ...obj }` 展开、`structuredClone` 出来的新对象照旧没有身份——同以前的表层 WeakMap）。
// MusicXML 读进来的那份表层（原树 + 绑定表）留在 Rust 里按句柄取；句柄挂在旁表上，镜像对象都回收了就释放。
// 往 Rust 送模型时按旁表把 `_oid` 补回去，Rust 的写出、编辑就能照身份找原节点。

import { dolce } from "../common/dolce";
import { ModelError, msgText, type ModelMsg } from "./msg";
import type { ScoreDoc } from "./doc";

/** 一份表层（Rust 侧句柄）。没有对象再指着它时释放。 */
export class SurfaceRef {
  constructor(readonly h: number) {
    RELEASE.register(this, h);
  }
}

const RELEASE = new FinalizationRegistry<number>((h) => {
  try {
    dolce().modelRelease(h);
  } catch {
    // wasm 已卸载（进程收尾）
  }
});

interface Bound {
  readonly s: SurfaceRef | null;
  readonly oid: number;
}

const BOUND = new WeakMap<object, Bound>();

/** 对象的身份：有表层的给句柄与号；没有为 null。 */
export function boundOf(obj: object | null | undefined): Bound | null {
  return (obj && BOUND.get(obj)) ?? null;
}

/** Rust 回来的 JSON → 镜像对象（`_oid` 摘下记进旁表，挂表层 `s`）。
 *  不用 reviver（慢三倍）：先整份解析再走一遍；`_oid` 在 Rust 那边排在各结构末尾，删最后一个属性对象不退化。 */
export function adopt<T>(json: string, s: SurfaceRef | null): T {
  const root = JSON.parse(json) as unknown;
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === "object") walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const k in o) {
      const x = o[k];
      if (x !== null && typeof x === "object") walk(x);
    }
    const oid = o._oid;
    if (typeof oid === "number") {
      delete o._oid;
      BOUND.set(o, { s, oid });
    }
  };
  walk(root);
  return root as T;
}

/** 送进 Rust 的 JSON：补上 `_oid`（只补同一份表层的，另一份表层来的对象当无身份）；顶层 `source`（原文）不送。
 *  回 JSON 与表层（没有为 null；`h` 是它的句柄，0 = 没有）。 */
export function docJson(doc: ScoreDoc): { json: string; s: SurfaceRef | null; h: number } {
  let chosen: SurfaceRef | null = null;
  const json = JSON.stringify(doc, function (this: unknown, k: string, v: unknown) {
    if (this === doc && k === "source") return undefined;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const b = BOUND.get(v);
    if (!b) return v;
    if (b.s) {
      chosen ??= b.s;
      if (b.s !== chosen) return v;
    }
    return { ...(v as object), _oid: b.oid };
  });
  const s = chosen as SurfaceRef | null;
  return { json, s, h: s?.h ?? 0 };
}

/** 任意值（小节、调号…）送进 Rust 的 JSON（不带身份）。 */
export const plainJson = (v: unknown): string => JSON.stringify(v);

/** wasm 抛的错：`message` 是 `Msg` 的 JSON 时转成 `ModelError`，别的原样抛。 */
export function rethrow(e: unknown): never {
  if (e instanceof Error) {
    let m: ModelMsg | null = null;
    try {
      const v = JSON.parse(e.message) as { key?: unknown };
      if (v && typeof v.key === "string") m = v as ModelMsg;
    } catch {
      // 不是 JSON
    }
    if (m) throw new ModelError(m);
  }
  throw e;
}

/** 调 wasm，失败按 `rethrow` 转。 */
export function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    rethrow(e);
  }
}

/** 就地把 `doc` 换成 `fresh` 的内容（调用方手里拿的是 `doc` 这个对象）；原文 `source` 留着。 */
export function replaceDoc(doc: ScoreDoc, fresh: ScoreDoc): void {
  const source = doc.source;
  for (const k of Object.keys(doc)) delete (doc as unknown as Record<string, unknown>)[k];
  Object.assign(doc, fresh);
  if (source !== undefined) doc.source = source;
}

/** 编辑钩子的提示文字（缺省声部名等）：按界面语言出，给 Rust 回调 */
export const msgTextOfJson = (json: string): string => msgText(JSON.parse(json) as ModelMsg);
