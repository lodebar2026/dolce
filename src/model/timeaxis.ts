// 各声部**共用的时间轴**（试听、演唱顺序、导出 MusicXML 共用）：轴上一格是一小节，各声部的小节按「组号 + 组内第几小节」落格。
//
// 文本谱一组不一定含全部声部（issue 11：前几行只有 `Q:`，末组才出 `Q1:`/`Q2:`），`fromfanqie.ts` 按声部号建 part 时
// 各声部首尾相接、缺席的组不占位，小节序号对不上。同组里第 k 小节同时起（同原样档组内按「小节序号 + 拍数」归列），
// 每组在轴上占「该组各声部小节数的最大值」格，组的起点是前面各组的累加。缺席、偏短的声部在那几格上**没有小节**，
// 不补任何东西（从前在克隆上补无声小节，补出来的是新 id、照抄小节线的假小节）。
//
// 组号取 `Measure.print.system`（各声部每行首小节都有，往后继承）；有声部的首小节没有它（非文本谱来源）就按小节序号一一对应。

import { SIMPLE_DIVISIONS, type Chord, type Measure, type Song, type Time } from "./doc";

export interface TimeAxis {
  /** 轴上一共几格 */
  length: number;
  /** 各声部第 i 小节落在轴上第几格（严格递增） */
  slot: number[][];
  /** 轴上第 s 格是各声部的第几小节；那一格没有该声部的小节为 -1 */
  local: number[][];
  /** 各组在轴上从第几格起、占几格（不按组排时整首一组） */
  groups: { start: number; length: number }[];
  /** 是不是按组排的（false = 按小节序号一一对应） */
  grouped: boolean;
}

/** 由各声部各小节的组号排时间轴。`systems[p][i]` 为 undefined 的沿用前一小节的组；有声部首小节没有组号、或只有一个声部时按序号一一对应。 */
export function axisOf(systems: readonly (readonly (number | undefined)[])[]): TimeAxis {
  const grouped = systems.length > 1 && systems.every((s) => s.length === 0 || s[0] !== undefined);
  if (!grouped) {
    const length = Math.max(0, ...systems.map((s) => s.length));
    const slot = systems.map((s) => s.map((_, i) => i));
    const local = systems.map((s) => Array.from({ length }, (_, i) => (i < s.length ? i : -1)));
    return { length, slot, local, groups: [{ start: 0, length }], grouped };
  }
  /** 各声部各小节所属的组、在组内第几小节 */
  const at = systems.map((s) => {
    let sys = s[0]!;
    let k = -1;
    return s.map((v) => {
      if (v !== undefined && v !== sys) {
        sys = v;
        k = -1;
      }
      return { sys, k: ++k };
    });
  });
  const size = new Map<number, number>();
  for (const part of at) for (const { sys, k } of part) size.set(sys, Math.max(size.get(sys) ?? 0, k + 1));
  const start = new Map<number, number>();
  const groups: TimeAxis["groups"] = [];
  let length = 0;
  for (const sys of [...size.keys()].sort((a, b) => a - b)) {
    start.set(sys, length);
    groups.push({ start: length, length: size.get(sys)! });
    length += size.get(sys)!;
  }
  const slot = at.map((part) => part.map(({ sys, k }) => start.get(sys)! + k));
  const local = slot.map((s) => {
    const out = new Array<number>(length).fill(-1);
    s.forEach((g, i) => (out[g] = i));
    return out;
  });
  return { length, slot, local, groups, grouped };
}

/** 一首的时间轴（按 `Song.parts` 的次序）。 */
export function axisOfSong(song: Song): TimeAxis {
  return axisOf(song.parts.map((p) => p.measures.map((m) => m.print?.system)));
}

/** 一个声部的小节按轴摊开：没有小节的格为 undefined。 */
export function spreadOnAxis<T>(items: readonly T[], slots: readonly number[], length: number): (T | undefined)[] {
  const out = new Array<T | undefined>(length).fill(undefined);
  items.forEach((it, i) => (out[slots[i]!] = it));
  return out;
}

/**
 * 某声部在某组缺席（文本谱前几行只有 `Q:`、识别稿前几行单声部，见 issue 11）的那几格补上整小节**不可见休止**，补完各声部小节一一对应。
 * 给按声部各数各的小节、不认组号的写出端用（123 / ABC：`V:2` 不写这几行，读回来就从第一小节对起，整体错位）。
 * 补的小节照抄同一格首个有小节的声部那一小节的小节号、换行（`print`）与拍号，按拍一拍一个休止，余数单成一个。不按组排的原样返回。不动原件。
 */
export function fillAbsentGroups(song: Song): Song {
  const axis = axisOfSong(song);
  if (!axis.grouped || axis.local.every((l) => l.every((i) => i >= 0))) return song;
  let maxId = 0;
  for (const p of song.parts) for (const m of p.measures) for (const el of m.elements) maxId = Math.max(maxId, el.id);
  // 各格的样板小节（首个有小节的声部）与那一格生效的拍号
  const timeAt: (Time | undefined)[] = [];
  const leadAt: Measure[] = [];
  const dpqAt: number[] = [];
  for (let s = 0; s < axis.length; s++) {
    const pi = axis.local.findIndex((l) => l[s]! >= 0);
    leadAt[s] = song.parts[pi]!.measures[axis.local[pi]![s]!]!;
  }
  let time = song.time, dpq = SIMPLE_DIVISIONS;
  for (let s = 0; s < axis.length; s++) {
    const a = leadAt[s]!.attrs;
    if (a?.time) time = a.time;
    if (a?.divisions) dpq = a.divisions;
    timeAt[s] = time;
    dpqAt[s] = dpq;
  }
  const parts = song.parts.map((p, pi) => {
    if (axis.local[pi]!.every((i) => i >= 0)) return p;
    const measures: Measure[] = [];
    for (let s = 0; s < axis.length; s++) {
      const i = axis.local[pi]![s]!;
      if (i >= 0) { measures.push(p.measures[i]!); continue; }
      const lead = leadAt[s]!;
      const len = lead.duration ?? lead.elements.reduce((t, el) => t + (el.kind === "chord" && !el.grace ? el.duration.divisions : 0), 0);
      const t = timeAt[s];
      const beat = t ? (dpqAt[s]! * 4) / t.beatType : dpqAt[s]!;
      const elements: Chord[] = [];
      for (let left = len; left > 0; left -= beat) {
        elements.push({ kind: "chord", id: ++maxId, notes: [], rest: {}, printObject: false,
          duration: { divisions: Math.min(beat, left), dots: 0 }, voice: 1, staff: 1 });
      }
      const m: Measure = { number: lead.number, elements };
      if (lead.print) m.print = { ...(lead.print.newSystem ? { newSystem: true } : {}), ...(lead.print.newPage ? { newPage: true } : {}), ...(lead.print.system !== undefined ? { system: lead.print.system } : {}) };
      if (lead.attrs?.time || lead.attrs?.divisions) m.attrs = { ...(lead.attrs.time ? { time: lead.attrs.time } : {}), ...(lead.attrs.divisions ? { divisions: lead.attrs.divisions } : {}) };
      measures.push(m);
    }
    return { ...p, measures };
  });
  return { ...song, parts };
}
