// ABC 家族（123 / ABC / Muse `.jcx`）的写出：在 Rust（crates/model/src/formats/abc/emit.rs），这里是门面。

import type { ScoreDoc } from "../model/doc";
import { dolce } from "../common/dolce";
import { call, docJson } from "../model/rustdoc";

function emitWith(dialect: "123" | "abc" | "jcx", doc: ScoreDoc): string {
  let { json } = docJson(doc);
  // 送进 Rust 的 JSON 不带原文；Muse 的写出端要看原文头（`%MUSE3` 的整份重写后仍按 `%MUSE3`），jcx 来源补上
  if (doc.sourceFormat === "jcx" && doc.source !== undefined) json = `${json.slice(0, -1)},"source":${JSON.stringify(doc.source)}}`;
  return call(() => dolce().formatsEmit(dialect, json));
}

/** 整份文档 → `.123` 文本。多曲之间空一行，且**每首都带 `X:`**（分隔靠它）。 */
export function emit123(doc: ScoreDoc): string {
  return emitWith("123", doc);
}

/** 整份文档 → `.abc` 文本。多曲之间空一行，每首都带 `X:`（ABC tunebook 的分隔）。 */
export function emitAbc(doc: ScoreDoc): string {
  return emitWith("abc", doc);
}

/** 整份文档 → Muse `.jcx` 文本（未编码）。Muse 一个文件一首，多曲只写第一首。 */
export function emitJcx(doc: ScoreDoc): string {
  return emitWith("jcx", doc);
}
