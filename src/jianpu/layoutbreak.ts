// 在谱面上增删版面断点（规范 123格式 §9.1「在谱面上增删断点」）：断点一律是段落边界——
// 光标在段末只增删一条 `break=` / `newpage=`；在段中先切段（插 `[P:A-2]`、`%%sing` 里 A 换成 `A A-2`）再加；删掉后界面切出来的段合得回就合回。
// 这里只算「该做什么」（`BreakPlan`），原文怎么改交 Rust（`crates/dolce-formats/src/abc/layoutedit.rs`），一次 `setText` 一步撤销。
// 投影档按排出来的那一处音（第几遍第几个符号，`LaidInfo.projPasses`）认段；简谱档按谱面上段落标记的先后认。

import type { ElementId, Song } from "../model/doc";
import type { ProjPass } from "../layout/rustlayout";
import { dolce } from "../common/dolce";

/** 要做的事；`hint` 是状态栏提示的 i18n 键 */
export type BreakPlan =
  | {
    kind: "add";
    section: string;
    nth: number;
    /** 这一段还没名字（第一个段落标记之前）：先在曲首这个音前插 `[P:name]` */
    label?: { before: ElementId; name: string };
    /** 断在段中：在 `before` 这个音前插 `[P:newName]`，把 `section` 切开 */
    split?: { before: ElementId; newName: string };
  }
  | { kind: "remove"; section: string; nth: number; /** 删完试着合回的段（界面切出来的 `A-2`） */ merge?: string }
  | { kind: "hint"; key: string };

/** 界面切段的新名：`A-2`、`A-3`…，避开本曲已有的段名 */
export function splitName(base: string, names: ReadonlySet<string>): string {
  for (let k = 2; ; k++) if (!names.has(`${base}-${k}`)) return `${base}-${k}`;
}

/** 给第一个段落标记之前那段起名：A、B…里第一个没用过的 */
function freshName(names: ReadonlySet<string>): string {
  for (let c = 65; c <= 90; c++) if (!names.has(String.fromCharCode(c))) return String.fromCharCode(c);
  return splitName("A", names);
}

const namesOf = (song: Song): Set<string> => new Set((song.sectionMarks ?? []).map((m) => m.name));

/** 这一首的主旋律（第一个声部）按谱面先后的音（含休止） */
function leadOrder(song: Song): ElementId[] {
  const out: ElementId[] = [];
  for (const m of song.parts[0]?.measures ?? []) for (const e of m.elements) if (e.kind === "chord") out.push(e.id);
  return out;
}

/** 段中要切开时的检查与新名：写了头部 `P:` 的不自动切（`P:` 逐字母，写不下 `A-2`） */
function splitOrHint(song: Song, section: string, nth: number, before: ElementId, label?: { before: ElementId; name: string }): BreakPlan {
  if (song.sectionOrder) return { kind: "hint", key: "status.layoutBreakSectionOrder" };
  const names = namesOf(song);
  const base = label?.name ?? section;
  if (label) names.add(label.name);
  return { kind: "add", section: base, nth, label, split: { before, newName: splitName(base, names) } };
}

/** 第一个段落标记之前那段（段名空串）要先起名；写了 `%%sing` / 头部 `P:` 的不动（那段本来不唱） */
function labelFor(song: Song, section: string): { before: ElementId; name: string } | "hint" | undefined {
  if (section !== "") return undefined;
  if (song.sectionOrder || song.singOrder?.length) return "hint";
  const first = leadOrder(song)[0];
  return first === undefined ? "hint" : { before: first, name: freshName(namesOf(song)) };
}

/** 投影档：在第 `slot` 个符号（一个音）之后断 */
export function projAddPlan(pp: ProjPass, slot: number, song: Song): BreakPlan {
  const ri = pp.runs.findIndex(([, , a, b]) => slot >= a && slot <= b);
  const run = pp.runs[ri];
  if (!run) return { kind: "hint", key: "status.layoutBreakPick" };
  const [section, nth, , end] = run;
  let next = -1;
  for (let k = slot + 1; k <= end; k++) {
    if (pp.ids[k] != null) {
      next = k;
      break;
    }
  }
  if (next < 0 && ri === pp.runs.length - 1) return { kind: "hint", key: "status.layoutBreakEnd" };
  const label = labelFor(song, section);
  if (label === "hint") return { kind: "hint", key: "status.layoutBreakUnnamed" };
  if (next < 0) return { kind: "add", section: label?.name ?? section, nth, label };
  return splitOrHint(song, section, nth, pp.ids[next]!, label);
}

/** 投影档：删掉这个音前面（`back`，它得是行首）/ 后面（`forward`，行尾）的断点。不在行首行尾回 null（照常删音） */
export function projRemovePlan(pp: ProjPass, slot: number, dir: "back" | "forward"): BreakPlan {
  const ri = pp.runs.findIndex(([, , a, b]) => slot >= a && slot <= b);
  if (ri < 0) return { kind: "hint", key: "status.layoutBreakAuto" };
  const noteIn = (a: number, b: number): boolean => pp.ids.slice(a, b).some((x) => x != null);
  // 断点前那段：back 是上一段（这个音得是本段第一个音），forward 是本段（这个音得是本段最后一个音）
  const at = dir === "back" ? ri - 1 : ri;
  const run = pp.runs[at];
  const ok = run && (dir === "back" ? !noteIn(pp.runs[ri]![2], slot) : !noteIn(slot + 1, run[3] + 1) && at < pp.runs.length - 1);
  if (!ok) return { kind: "hint", key: "status.layoutBreakAuto" };
  const after = pp.runs[at + 1]![0];
  return { kind: "remove", section: run[0], nth: run[1], merge: after.startsWith(`${run[0]}-`) ? after : undefined };
}

/** 简谱档：段落标记按主旋律先后排好，各带「这个名字第几次」 */
function marksInOrder(song: Song): { name: string; before: ElementId; nth: number; at: number }[] {
  const order = leadOrder(song);
  const idx = new Map(order.map((id, i) => [id, i] as const));
  const seen = new Map<string, number>();
  return (song.sectionMarks ?? [])
    .map((m) => ({ ...m, at: idx.get(m.before) ?? -1 }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((m) => {
      const nth = (seen.get(m.name) ?? 0) + 1;
      seen.set(m.name, nth);
      return { ...m, nth };
    });
}

/** 简谱档：在音 `id` 之后断 */
export function jianpuAddPlan(song: Song, id: ElementId): BreakPlan {
  const order = leadOrder(song);
  const i = order.indexOf(id);
  if (i < 0) return { kind: "hint", key: "status.layoutBreakPick" };
  const next = order[i + 1];
  if (next === undefined) return { kind: "hint", key: "status.layoutBreakEnd" };
  const marks = marksInOrder(song);
  let k = -1;
  marks.forEach((m, j) => {
    if (m.at <= i) k = j;
  });
  const cur = marks[k];
  const label = labelFor(song, cur?.name ?? "");
  if (label === "hint") return { kind: "hint", key: "status.layoutBreakUnnamed" };
  const section = cur?.name ?? "";
  const nth = cur?.nth ?? 1;
  if (marks[k + 1]?.before === next) return { kind: "add", section: label?.name ?? section, nth, label };
  return splitOrHint(song, section, nth, next, label);
}

/** 简谱档：删掉音 `id` 前面（`back`）/ 后面（`forward`）的断点；`rowFirst`：哪些音是行首。不在行首行尾回 null */
export function jianpuRemovePlan(song: Song, id: ElementId, dir: "back" | "forward", rowFirst: (id: ElementId) => boolean): BreakPlan | null {
  const order = leadOrder(song);
  const i = order.indexOf(id);
  const start = dir === "back" ? id : order[i + 1];
  if (i < 0 || start === undefined || !rowFirst(start)) return null;
  const marks = marksInOrder(song);
  const k = marks.findIndex((m) => m.before === start);
  const prev = marks[k - 1];
  if (k < 1 || !prev) return { kind: "hint", key: "status.layoutBreakAuto" };
  const name = marks[k]!.name;
  return { kind: "remove", section: prev.name, nth: prev.nth, merge: name.startsWith(`${prev.name}-`) ? name : undefined };
}

/**
 * 照 `plan` 改原文（第 `song` 首、版面 `layout`、`pass` 遍，0 = 每一遍）；`insertAt` 给「插在这个音前」的原文偏移。
 * 改不动（规则本来就没有：自动断行）回 null。
 */
export function applyBreakPlan(
  text: string,
  song: number,
  layout: string,
  pass: number,
  plan: Extract<BreakPlan, { kind: "add" | "remove" }>,
  page: boolean,
  insertAt: (id: ElementId) => number | null,
): string | null {
  const d = dolce();
  if (plan.kind === "remove") {
    let out = d.abcLayoutRemoveBreak(text, song, layout, pass, plan.section, plan.nth);
    if (out === text) return null;
    if (plan.merge) out = d.abcMergeSection(out, song, plan.merge);
    return out;
  }
  // 后面的位置先插，前面的偏移不受影响
  const inserts: { at: number; s: string }[] = [];
  if (plan.label) {
    const at = insertAt(plan.label.before);
    if (at === null) return null;
    inserts.push({ at, s: `[P:${plan.label.name}]` });
  }
  if (plan.split) {
    const at = insertAt(plan.split.before);
    if (at === null) return null;
    inserts.push({ at, s: `[P:${plan.split.newName}]` });
  }
  let out = text;
  for (const { at, s } of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, at) + s + out.slice(at);
  if (plan.split) out = d.abcSplitSection(out, song, plan.section, plan.split.newName);
  out = d.abcLayoutAddBreak(out, song, layout, pass, plan.section, plan.nth, page);
  return out === text ? null : out;
}
