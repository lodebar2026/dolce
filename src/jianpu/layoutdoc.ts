// 版面（123 `%%layout`，规范 123格式 §9.1）在简谱档的落法：断行方式（`linebreak=`）与段落断点（`break=` / `newpage=`）
// 先在文档**副本**上落成换行再交排版器，原文不动。投影档的版面在 Rust 展开时落（`place/expand.rs`），不走这里。

import type { ElementId, LayoutSpec, ScoreDoc, Song } from "../model/doc";
import { applyBreaks, breaksOf, clearSongBreaks, type LineStart } from "../model/breaks";
import { relayoutDocBreaks } from "./docrelayout";
import type { FitMeasure, LinePlan } from "./phrase";

/** 编辑器四档各自的内置版面名（写进原文的规范名） */
export const VIEW_LAYOUT = { expanded: "投影", original: "简谱", staff: "五线谱", mixed: "混排" } as const;

/** 编辑器的四档 */
export type LayoutView = keyof typeof VIEW_LAYOUT;

/** 这一首叫这个名字的版面（读入时内置名已归一成中文名） */
export function layoutOf(song: Song | undefined, name: string): LayoutSpec | undefined {
  return song?.layouts?.find((l) => l.name === name);
}

/** 版面照哪一档排：内置版面是它自己那档，自定义版面看 `base`（没写或写错回 null，读入时已报 `layout-no-base`） */
export function viewOfLayout(spec: LayoutSpec): LayoutView | null {
  const base = spec.base ?? spec.name;
  return (Object.keys(VIEW_LAYOUT) as LayoutView[]).find((v) => VIEW_LAYOUT[v] === base) ?? null;
}

/** 这一首的自定义版面（有 `base` 的） */
export function customLayouts(song: Song | undefined): LayoutSpec[] {
  const builtin = new Set<string>(Object.values(VIEW_LAYOUT));
  return (song?.layouts ?? []).filter((l) => !builtin.has(l.name) && viewOfLayout(l) !== null);
}

/** 档 `view` 当前排的版面：选了照这一档排的自定义版面 `custom` 就是它，否则是这一档的内置版面 */
export function activeLayout(song: Song | undefined, view: LayoutView, custom: string | null): { name: string; spec?: LayoutSpec; custom: boolean } {
  const c = custom !== null ? customLayouts(song).find((l) => l.name === custom) : undefined;
  if (c && viewOfLayout(c) === view) return { name: c.name, spec: c, custom: true };
  return { name: VIEW_LAYOUT[view], spec: layoutOf(song, VIEW_LAYOUT[view]), custom: false };
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

/** 五线谱系版面要不要当硬断点排：写了照源、每行 N 小节、装满或段落断点（按乐句的五线谱自己量宽断，不算） */
function staffHard(spec: LayoutSpec | undefined): boolean {
  if (!spec || spec.linebreak === "phrase") return false;
  return spec.linebreak === "source" || spec.linebreak === "fill" || planOf(spec.linebreak, null) !== null || !!spec.breaks?.length;
}

/** 五线谱 / 混排档的版面 `name` 要不要把换行当硬断点（`sourceBreaks`） */
export function staffLayoutHard(doc: ScoreDoc, name: string): boolean {
  return doc.songs.some((s) => staffHard(layoutOf(s, name)));
}

/**
 * 五线谱 / 混排档（规范 §9.1）：版面写了照源（`source`）、每行 N 小节、装满或段落断点时，落好换行的副本，交五线谱当硬断点
 * （`sourceBreaks`；一行压不下的五线谱再均分）。只写了段落断点、没写断行方式的，别处按装满（交五线谱均分）。
 * 没写这些（自动，照简谱视图排出的行当优选断点）与按乐句（`MixedSession.staffPhraseLineStarts`）回 null。
 */
export function staffLayoutDoc(doc: ScoreDoc, name: string): ScoreDoc | null {
  if (!staffLayoutHard(doc, name)) return null;
  const tmp = structuredClone(doc);
  for (const song of tmp.songs) {
    const spec = layoutOf(song, name);
    if (staffHard(spec) && (!spec!.linebreak || spec!.linebreak === "auto")) spec!.linebreak = "fill";
  }
  return applyLayoutBreaks(tmp, name, null) ?? tmp;
}

/** 按乐句的五线谱另加上版面的段落断点（行首音 id） */
export function sectionLineStarts(doc: ScoreDoc, name: string): ElementId[] {
  return doc.songs.flatMap((s) => {
    const spec = layoutOf(s, name);
    return spec ? sectionStarts(s, spec).map((x) => x.id) : [];
  });
}
