// 转记：实际音高不动，只把全曲统一到目标首调，并按指定规则重算唱名与升降号。在 Rust（crates/model/src/transcribe.rs，经 `EditCmd`），这里是门面。

import type { ScoreDoc } from "./doc";
import { applyEditCmd, type EditHooks } from "./edit";

export type TranscriptionSpelling = "keep" | "key" | "sharp" | "flat";

export interface TranscriptionOptions {
  /** 目标调号的五度圈位置（-7..7）；界面写作 `1=?`。 */
  fifths: number;
  /** 临时半音的拼写：`keep` 照原谱的方向（原来写升号仍写升号、写降号仍写降号；原来是调内音的按两调号谁升号多），
   *  `key` 按目标调号（降号调写降号，升号调与 C 调写升号），或统一升号、降号。 */
  spelling: TranscriptionSpelling;
  /** 每个临时升降音都写记号，不省略同小节内重复的记号。 */
  repeatAccidentals?: boolean;
}

export interface TranscriptionResult {
  notes: number;
}

/**
 * 就地转记整份文档。所有歌曲、声部、声线、和弦音与倚音都处理；MIDI 音高保持不变。
 * 再次用同一选项执行是幂等的。`hooks` 给了就作废改了音的表层版面（`.musicxml`）。
 */
export function transcribeScore(doc: ScoreDoc, options: TranscriptionOptions, hooks: EditHooks = {}): TranscriptionResult {
  const r = applyEditCmd(doc, { op: "transcribe", options }, hooks);
  return { notes: "number" in r ? r.number : 0 };
}
