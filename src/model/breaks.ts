// **断行的读写对**：模型里的换行 ↔ 「新行从哪个元素起」。在 Rust（crates/dolce-model/src/breaks.rs），这里是门面。
//
// 断行是「这份谱怎么印」的事实，随文档保存、往返。模型里分两处记：
// 小节级的在 `Measure.print.newSystem/newPage`（本小节**起**新系统，口径见 `helpers.ts::breaksAfterToStart`），
// 小节中间的在前一个和弦（或它的增时线）的 `lineBreakAfter` 上。排版引擎与断句交出来的都是「行首元素」——这里负责两种说法互换：
//
// - `breaksOf`：读出模型里现有的断行（回归比对用：写出 → 读回，断点集合应不变）；
// - `applyBreaks`：把一组行首写进模型，**替换**原有断行。用它的有三处：乐句重排写回 123/ABC
//   （`relayout.ts::relayoutDocBreaks`，`inline`）、导出 MusicXML 时照简谱视图重断（`xmlproject.ts`，
//   `source` / `inline`）、跨格式另存为带上简谱视图的断行（`App.convertTo`，`source`）。
//
// 小节中间的行首怎么落由 `mid` 定：原位记（`inline`）、挪到下一根小节线（`snap`）、只留源文本来就写明的（`source`）。
// 多声部各声部的切点对不齐，小节中间的一律顺延。判据细节见 Rust 那边。
//
// 改模型的两个（`applyBreaks`、`clearSongBreaks`）就地改传进来的这首：Rust 回补丁（改了哪些小节的 `print`、
// 哪些和弦 / 增时线 / 小节线的 `lineBreakAfter`），这里照补丁改原对象，对象身份不变。

import type { Chord, ElementId, Print, Song, Sustain } from "./doc";
import type { BreakKind } from "./helpers";
import { dolce } from "../common/dolce";
import { call } from "./rustdoc";

/** 新的一行从这个元素（和弦或增时线）起。`page`：这一行起新页。 */
export interface LineStart {
  id: ElementId;
  page?: boolean;
}

export interface ApplyBreaksOptions {
  /** 多声部也在小节中间断（只断旋律那一路；其余声部在下一小节断）。缺省挪到下一根小节线 */
  midInAnyPart?: boolean;
  /** 小节中间的行首：`inline` 原位记 `lineBreakAfter`；`snap` 挪到下一根小节线；
   *  `source` 只留源文本来就在那里换行的（原位），其余挪到下一根小节线。 */
  mid: "inline" | "snap" | "source";
  /** `write`：清掉原有换页，按 `LineStart.page` 重写；`keep`：原有换页不动（行首集合里没有换页信息时）。 */
  pages: "write" | "keep";
}

type PrintBreaks = Pick<Print, "newSystem" | "newPage" | "system">;
interface BreaksPatch {
  measures: [number, number, { [K in keyof PrintBreaks]: PrintBreaks[K] | null } | null][];
  hosts: [ElementId, BreakKind | null][];
  barlines: [number, number, number, BreakKind | null][];
}

/** 照补丁就地改 `song` */
function applyPatch(song: Song, patch: BreaksPatch): void {
  for (const [pi, mi, pr] of patch.measures) {
    const m = song.parts[pi]!.measures[mi]!;
    if (!pr) {
      delete m.print;
      continue;
    }
    const target = (m.print ??= {});
    for (const k of ["newSystem", "newPage", "system"] as const) {
      const v = pr[k];
      if (v === null || v === undefined) delete target[k];
      else (target as Record<string, unknown>)[k] = v;
    }
  }
  if (patch.hosts.length) {
    const hosts = new Map<ElementId, Chord | Sustain>();
    for (const part of song.parts) {
      for (const m of part.measures) {
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          hosts.set(el.id, el);
          for (const su of el.sustains ?? []) hosts.set(su.id, su);
        }
      }
    }
    for (const [id, kind] of patch.hosts) {
      const h = hosts.get(id)!;
      if (kind === null) delete h.lineBreakAfter;
      else h.lineBreakAfter = kind;
    }
  }
  for (const [pi, mi, bi, kind] of patch.barlines) {
    const b = song.parts[pi]!.measures[mi]!.barlines![bi]!;
    if (kind === null) delete b.lineBreakAfter;
    else b.lineBreakAfter = kind;
  }
}

/** 清掉整首的换行与换页（成书量容量、量自然宽之前：量的是「自然排下来」，不是原书怎么断）。 */
export function clearSongBreaks(song: Song): void {
  applyPatch(song, JSON.parse(call(() => dolce().modelClearSongBreaks(JSON.stringify(song)))) as BreaksPatch);
}

/**
 * 把一组行首写进模型的换行位，**替换**原有的断行。改的是传进来的这首。
 *
 * 行首都该在同一个声部里（排版与断句都只看旋律那一路）：取第一个认得出行首的声部，其余声部的忽略；
 * 小节级换行各声部在同一小节上断。多声部的文本谱（带组序号 `print.system`）各声部小节对不齐，不重断。
 *
 * @returns 有没有落下任何换行。一个行首都对不上（id 过期）时不改模型、返回 false
 */
export function applyBreaks(song: Song, starts: Iterable<LineStart>, opt: ApplyBreaksOptions): boolean {
  const list = [...starts].map((s) => ({ id: s.id, page: !!s.page }));
  const patch = JSON.parse(call(() => dolce().modelApplyBreaks(JSON.stringify(song), JSON.stringify(list), JSON.stringify(opt)))) as BreaksPatch | null;
  if (!patch) return false;
  applyPatch(song, patch);
  return true;
}

/**
 * 读出一首现有的断行：第一声部上的行首元素，按谱序。小节级的取该小节第一个和弦（倚音跳过），
 * 小节中间的取换行之后紧跟的那个元素（增时线之后的取下一根增时线或下一个和弦）；
 * 它在下一小节上另记的那份小节级的不另算。
 * 全曲末尾之后的换行（`Part.endBreak`）没有行首，不算。
 */
export function breaksOf(song: Song): LineStart[] {
  return JSON.parse(call(() => dolce().modelBreaksOf(JSON.stringify(song)))) as LineStart[];
}
