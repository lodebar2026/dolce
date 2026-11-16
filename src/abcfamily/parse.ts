// ABC 家族（123 / ABC / Muse `.jcx`）的读入：在 Rust（crates/dolce-formats/src/abc/），这里是门面。
// 词法、字段与头部、正文组装、歌词对位的判据都在那边（口径见 `docs/格式/123格式.md`、`docs/模块/源格式-abc家族.md`）；
// 编辑器还要的几样小判据（歌词行切音节、对位格、裸和弦名、123 时值、调号拼写）也经这里调同一份。

import type { Duration, ScoreDoc } from "../model/doc";
import { dolce } from "../common/dolce";
import { docJson } from "../model/rustdoc";

export interface ParseOptions {
  /** 文件名，仅用于诊断 */
  name?: string;
}

function parseWith(dialect: "123" | "abc" | "jcx", text: string): ScoreDoc {
  const doc = JSON.parse(dolce().formatsParse(dialect, text)) as ScoreDoc;
  // 原文换回 JS 那份（孤立代理过边界会变成 U+FFFD，码元数不变）
  doc.source = text;
  return doc;
}

/** `.123` 文本 → `ScoreDoc`。 */
export function parse123(text: string, _options: ParseOptions = {}): ScoreDoc {
  return parseWith("123", text);
}

/** 标准 ABC 文本 → `ScoreDoc`。 */
export function parseAbc(text: string, _options: ParseOptions = {}): ScoreDoc {
  return parseWith("abc", text);
}

/** Muse `.jcx` 文本（已解码）→ `ScoreDoc`。 */
export function parseJcx(text: string, _options: ParseOptions = {}): ScoreDoc {
  return parseWith("jcx", text);
}

/** 歌词行各音节（含跳音符、续记号这类空音节）在 `body` 里的起点（UTF-16），与解析器切音节同一份口径。
 *  `skip`：跳音符（123 `/`、ABC `*`）；`joinTilde`：Muse `.jcx` 的 `~` 把下一个音节并到同一个音。 */
export function lyricStarts(body: string, skip: "/" | "*" = "/", joinTilde = false): number[] {
  return [...dolce().formatsLyricStarts(body, skip, joinTilde)];
}

/** 原文区间 `[from, to)` 里的歌词对位格数（按模型里元素的原文位置；休止占不占格按来源方言）。 */
export function lyricSlotsBetween(doc: ScoreDoc, from: number, to: number): number {
  return dolce().formatsSlotsBetween(docJson(doc).json, from, to);
}

/** 和弦名能不能不带引号写（123 规范 §8.1：`Am7 ` 直接写，别的加引号）。 */
export function isBareChord(name: string): boolean {
  return dolce().formatsIsBareChord(name);
}

/** 123 的时值：减时线、附点、增时线 → `Duration`。 */
export function duration123(beams: number, dots: number, sustains: number): Duration {
  return JSON.parse(dolce().formatsDuration123(beams, dots, sustains)) as Duration;
}

/** 调号拼写归一（`♭A` → `bA`、`F#` → `#F` 等）。 */
export function normalizeSpelling(s: string): string {
  return dolce().formatsNormalizeSpelling(s);
}
