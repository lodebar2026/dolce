// `ScoreDoc` → 文本谱原文（番茄简谱 / 诗歌本文本谱）：写出端在 Rust（crates/dolce-formats/src/fanqie/emit.rs），这里是门面。
//
// 模型里没有行结构的曲子要先按乐句断行（文本谱一行 `Q:` 就是谱面一行），断点要排版行视图（`jianpu/phrase.ts::phraseCuts`，
// M5 才迁）：写出端回调这边算，换行本身在 Rust 落。

import type { ScoreDoc, Song } from "../model/doc";
import { dolce } from "../common/dolce";
import { call, docJson, plainJson } from "../model/rustdoc";
import { phraseCuts } from "../jianpu/phrase";
import type { Dialect } from "./dialect";

/** 写出端回调：一首（JSON）按缺省分法（按乐句、不量宽）的各刀行首 id */
function cutsOf(songJson: string): string {
  const doc: ScoreDoc = { sourceFormat: "123", songs: [JSON.parse(songJson) as Song], diagnostics: [] };
  const cuts = phraseCuts(doc, 0, { kind: "phrase", measure: null });
  return cuts ? JSON.stringify(cuts.map((c) => c.id)) : "null";
}

/**
 * fifths → 调号名。升降号写在哪一侧**由方言决定，不能通用**：番茄 `D:` 两种顺序都收（`bB`/`Bb`），
 * 诗歌本的 `1=` 行却只认「字母在前」——写成 `1=bB4/4` 会被读成 B 调。
 */
export function keyNameOf(fifths: number, style: "prefix" | "suffix" = "prefix"): string {
  return dolce().fanqieKeyNameOf(fifths, style === "suffix");
}

/** 写成文本谱会丢的弧线（嵌套、奇数连音、倚音弧）条数：丢失提示与识谱自检用 */
export function fanqieArcLosses(src: Song): { nested: number; oddTuplet: number; graceArc: number } {
  const [nested = 0, oddTuplet = 0, graceArc = 0] = call(() => dolce().fanqieArcLosses(plainJson(src)));
  return { nested, oddTuplet, graceArc };
}

export interface EmitFanqieOptions {
  /** 模型来自文本谱本身（`ScoreDoc.sourceFormat === "fanqie"`）：照原文的写法还原，不替它收口房号 */
  fromFanqie?: boolean;
  /** 模型来自 ABC：`X:` 是文件内编号、不是曲号 */
  fromAbc?: boolean;
}

/** 一首歌 → 文本谱原文（不带结尾换行）。 */
export function emitFanqieSong(src: Song, dialect: Dialect, opts: EmitFanqieOptions = {}): string {
  return call(() => dolce().fanqieEmitSong(plainJson(src), dialect, !!opts.fromFanqie, !!opts.fromAbc, cutsOf));
}

/** 整份文档 → 文本谱原文。多首之间用整行 `-----` 分隔（两家的解析端都认）。 */
export function emitFanqie(doc: ScoreDoc, dialect: Dialect): string {
  return call(() => dolce().fanqieEmit(docJson(doc).json, dialect, cutsOf));
}
