// 版面（123 `%%layout`，规范 123格式 §9.1）在简谱档的落法：断行方式（`linebreak=`）与段落断点（`break=` / `newpage=`）
// 先在文档**副本**上落成换行再交排版器，原文不动。投影档的版面在 Rust 展开时落（`place/expand.rs`），不走这里。

import type { LayoutSpec, ScoreDoc, Song } from "../model/doc";
import { applyBreaks, breaksOf, clearSongBreaks, type LineStart } from "../model/breaks";
import { relayoutDocBreaks } from "./docrelayout";
import type { FitMeasure, LinePlan } from "./phrase";

/** 编辑器四档各自的内置版面名（写进原文的规范名） */
export const VIEW_LAYOUT = { expanded: "投影", original: "简谱", staff: "五线谱", mixed: "混排" } as const;

/** 这一首叫这个名字的版面（读入时内置名已归一成中文名） */
export function layoutOf(song: Song | undefined, name: string): LayoutSpec | undefined {
  return song?.layouts?.find((l) => l.name === name);
}

/** `linebreak=` → 重排方案；照源（`source` / 没写）与装满不是重排，回 null */
function planOf(linebreak: string | undefined, measure: FitMeasure | null): LinePlan | null {
  if (linebreak === "phrase") return { kind: "phrase", measure };
  const n = linebreak?.startsWith("bars:") ? Number(linebreak.slice(5)) : NaN;
  return Number.isInteger(n) && n > 0 ? { kind: "bars", n, measure } : null;
}

/** 段落断点 → 行首：`break=A` 落在 A（第 n 次）之后那个段落标记的音上；A 是最后一段的不算 */
function sectionStarts(song: Song, spec: LayoutSpec): LineStart[] {
  const marks = song.sectionMarks ?? [];
  const out: LineStart[] = [];
  for (const b of spec.breaks ?? []) {
    let seen = 0;
    const at = marks.findIndex((m) => m.name === b.section && ++seen === (b.nth ?? 1));
    const next = at >= 0 ? marks[at + 1] : undefined;
    if (next) out.push({ id: next.before, page: !!b.page });
  }
  return out;
}

/** 有没有要在副本上落的东西 */
function rewrites(spec: LayoutSpec | undefined): boolean {
  return !!spec && (spec.linebreak === "fill" || planOf(spec.linebreak, null) !== null || !!spec.breaks?.length);
}

/**
 * 按版面 `name` 落好断行的副本；各首都没写要落的（照原文排）回 null。
 * `measure`：按乐句 / 每行 N 小节的行长尺子（同编辑器「按乐句重排」那把）。
 */
export function applyLayoutBreaks(doc: ScoreDoc, name: string, measure: FitMeasure | null): ScoreDoc | null {
  const specs = doc.songs.map((s) => layoutOf(s, name));
  if (!specs.some(rewrites)) return null;
  const clone = structuredClone(doc);
  clone.songs.forEach((song, si) => {
    const spec = specs[si];
    if (!rewrites(spec)) return;
    const plan = planOf(spec!.linebreak, measure);
    if (plan) relayoutDocBreaks(clone, { plan, midBreaks: "inline", songs: [si] });
    else if (spec!.linebreak === "fill") clearSongBreaks(song);
    const extra = sectionStarts(song, spec!);
    if (extra.length === 0) return;
    const have = breaksOf(song);
    const ids = new Set(have.map((s) => s.id));
    const merged = [...have];
    for (const s of extra) {
      if (!ids.has(s.id)) merged.push(s);
      else if (s.page) merged.find((x) => x.id === s.id)!.page = true;
    }
    applyBreaks(song, merged, { mid: "inline", pages: "write" });
  });
  return clone;
}

/** 给副本加上（或改掉）这一个版面的断行方式：写不下 `%%layout` 的格式在内存里挂版面用 */
export function withLinebreak(doc: ScoreDoc, name: string, linebreak: string): ScoreDoc {
  const clone = structuredClone(doc);
  for (const song of clone.songs) {
    const layouts = (song.layouts ??= []);
    const spec = layouts.find((l) => l.name === name);
    if (spec) spec.linebreak = linebreak;
    else layouts.push({ name, linebreak });
  }
  return clone;
}
