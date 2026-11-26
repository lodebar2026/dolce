// MIDI → `ScoreDoc`（**MusicXML 形状**：绝对音高 + 每小节 divisions）：SMF 读取与量化建模在 Rust
// （crates/model/src/formats/midi/），这里是门面；导入对话框在 `editor/midi-import.ts`。
//
// 这是**量化后的记谱重建**，不是无损的事件编辑（量化按拍、声部按小节分、音名按调号拼、变速只取首个速度，
// 踏板 / 控制器 / 弯音 / 打击乐通道不转写），口径见模块页。简谱度数等由 `jianpuproject.ts` 投影，与打开 MusicXML 同一条。

import type { ScoreDoc } from "../model/doc";
import { ModelError, msgText, type ModelMsg } from "../model/msg";
import { dolce } from "../common/dolce";

/** 量化网格：`16t` = 每拍在 1/16 与八分三连音之间择优 */
export type MidiGrid = "16t" | "16" | "32";

export interface MidiImportOptions {
  grid: MidiGrid;
  /** 给了就不读文件里的调号 */
  fifths?: number;
  /** 给了就不读文件里的拍号 */
  beats?: number;
  beatType?: number;
}

export interface MidiImportResult {
  doc: ScoreDoc;
  /** 给状态栏的提示（量化、略去了什么） */
  warnings: string[];
}

/** 读不出（不是 SMF、格式 2）或太大时抛错，`message` 按界面语言。 */
export function midiToScoreDoc(bytes: Uint8Array, title: string, options: MidiImportOptions): MidiImportResult {
  const r = JSON.parse(dolce().midiImport(bytes, title, JSON.stringify(options))) as
    | { doc: ScoreDoc; warnings: ModelMsg[] }
    | { error: ModelMsg };
  if ("error" in r) throw new ModelError(r.error);
  return { doc: r.doc, warnings: r.warnings.map(msgText) };
}
