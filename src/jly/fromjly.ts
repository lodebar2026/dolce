// jianpu-ly 的读入（目标语法 = 上游 jianpu-ly README v1.890）：词法与装配都在 Rust（crates/dolce-formats/src/jly/fromjly.rs），这里是门面。
// 与 123 方言的差异（词内顺序无关、时值是字母、连音 `3[ … ]`）与模型口径见 `docs/格式/` 与模块页；
// 本版不收的写法走损失清单 → `doc.diagnostics` 报出，不静默丢。

import type { ScoreDoc } from "../model/doc";
import { msgText, type ModelMsg } from "../model/msg";
import { dolce } from "../common/dolce";

export interface JlyParse {
  doc: ScoreDoc;
  /** 本版不收的东西，每条一句（按界面语言） */
  losses: string[];
  unknown: string[];
}

/** jianpu-ly 原文 → `ScoreDoc` 与损失清单。 */
export function parseJly(text: string): JlyParse {
  const r = JSON.parse(dolce().jlyParse(text)) as { doc: ScoreDoc; losses: ModelMsg[]; unknown: string[] };
  return { doc: r.doc, losses: r.losses.map(msgText), unknown: r.unknown };
}

/** 这一行是不是**曲行**（有音符/小节线那些）。`L:`/`H:` 词行、页头、拍号/调号/速度、`NextScore` 都不是。 */
export function isJlyMusicLine(line: string): boolean {
  return dolce().jlyIsMusicLine(line);
}

/**
 * 把曲行按**每 N 小节一行**重新断行，别的一个字不动（词行、页头、注释都留在原处）：dolce 按文件的行排版，
 * 整首挤成一行时音符与歌词叠成一团。只搬字符、不整份重出（写出端还不认识 `R{ } A{ }`、倚音、`chords=`）。
 */
export function rewrapJlyText(text: string, measuresPerLine = 4, opt: { skipPickup?: boolean } = {}): string {
  return dolce().jlyRewrap(text, measuresPerLine, !!opt.skipPickup);
}
