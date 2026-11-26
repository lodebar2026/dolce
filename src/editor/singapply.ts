// 按参照歌词生成的段落与演唱顺序写回 123 原文（无 DOM）：只动四样——曲内 `[P:x]`（整套换成生成的、插在段首和弦及其前置记号之前）、
// 整行的 `P:`（头部段落顺序与行首段落标记，写了 `%%sing` 就不起作用了，留着指向旧段名）、`%%sing` 行（换成生成的、写在这一首末尾）、
// 投影版面里引用段落的断点（`%%layout 投影` 带 `pass=` 的行整行换成生成的；不带的只去掉 `break=` / `newpage=`，别的选项留着）。
// 其余原文一个字不动。生成本身在 Rust（`crates/model/src/view/singfit.rs`，门面 `layout/rustlayout.ts::singFromLyrics`）。

import type { ElementId, ScoreDoc, Song } from "../model/doc";
import type { SingFitReport } from "../layout/rustlayout";

interface Change {
  from: number;
  to: number;
  insert: string;
}

/** 第 `song` 首在原文里的范围：多首时按 `X:` 行切（`X:` 行数与曲数对不上为 null），一首时全文。 */
export function songRange(text: string, doc: ScoreDoc, song: number): { from: number; to: number } | null {
  if (doc.songs.length <= 1) return { from: 0, to: text.length };
  const starts = [...text.matchAll(/^X:/gm)].map((m) => m.index ?? 0);
  if (starts.length !== doc.songs.length || song >= starts.length) return null;
  return { from: starts[song] ?? 0, to: starts[song + 1] ?? text.length };
}

/** 原文偏移落在第几首（`X:` 切；切不了为 0）。 */
export function songAtOffset(text: string, doc: ScoreDoc, offset: number): number {
  for (let i = doc.songs.length - 1; i > 0; i--) {
    const r = songRange(text, doc, i);
    if (r && offset >= r.from) return i;
  }
  return 0;
}

/** 段落标记插在哪：和弦本身、挂在它前面的记号（和弦名、注记、装饰）、从它起的弧的 `(`，取最靠前的那个。 */
function insertAt(song: Song, id: ElementId): number | null {
  for (const part of song.parts) {
    for (const m of part.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.id !== id || !el.source) continue;
        let at = el.source.offset;
        for (const a of el.attachedSources ?? []) if (a.source.offset < at) at = a.source.offset;
        for (const mk of song.marks) {
          if (mk.start === id && mk.openSource && mk.openSource.offset < at && el.source.offset - mk.openSource.offset <= 2) at = mk.openSource.offset;
        }
        return at;
      }
    }
  }
  return null;
}

/** 写回后的原文；某个段落标记找不到原文位置、或这一首在原文里定不了位时为 null（宁可不写，不写错位）。 */
export function applySingFit(text: string, doc: ScoreDoc, song: number, fit: SingFitReport): string | null {
  const s = doc.songs[song];
  const range = songRange(text, doc, song);
  if (!s || !range || !fit.sing) return null;
  const region = text.slice(range.from, range.to);
  const changes: Change[] = [];
  // 旧的：整行 `P:`、`%%sing`（连行尾换行），曲行里的 `[P:x]`（歌词行、注释行不碰）
  let off = 0;
  for (const line of region.split("\n")) {
    const end = off + line.length + 1;
    const proj = /^(?:%%|I:)layout\s+(?:投影|projection)(?:\s|$)/i.test(line);
    if (/^(P:|%%sing\b)/.test(line) || (proj && /(?:^|\s)pass=/.test(line))) changes.push({ from: off, to: Math.min(end, region.length), insert: "" });
    else if (proj) {
      const kept = line.split(/\s+/).filter((t) => t && !/^(break|newpage)=/.test(t));
      if (kept.length !== line.trim().split(/\s+/).length) {
        changes.push({ from: off, to: Math.min(end, region.length), insert: kept.length > 2 ? `${kept.join(" ")}\n` : "" });
      }
    } else if (!/^(%|[wW]:)/.test(line)) {
      for (const m of line.matchAll(/\[P:[^\]\n]*\]/g)) changes.push({ from: off + (m.index ?? 0), to: off + (m.index ?? 0) + m[0].length, insert: "" });
    }
    off = end;
  }
  for (const mk of fit.marks) {
    const at = insertAt(s, mk.before);
    if (at === null || at < range.from || at > range.to) return null;
    changes.push({ from: at - range.from, to: at - range.from, insert: `[P:${mk.name}]` });
  }
  // 从后往前改；同一处先删后插（删的是 [from, to)，插在 from，先插就被删掉了）
  changes.sort((a, b) => b.from - a.from || (b.to - b.from) - (a.to - a.from));
  let out = region;
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  // `%%sing` 写在这一首末尾（末尾的空行照留，与下一首隔开）
  const body = out.replace(/\s+$/, "");
  const tail = out.slice(body.length);
  out = `${body}\n${fit.sing}${tail.includes("\n") ? tail : "\n"}`;
  return text.slice(0, range.from) + out + text.slice(range.to);
}
