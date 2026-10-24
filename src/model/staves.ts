// **一个声部的几条谱表**（钢琴大谱表）在 ABC 家族文本里的写法：每条谱表一个 `V:`，第二条起写 `part=<首条的 V 号>`
// （`V:2 clef=bass part=1`，配 `%%score {1 2}` 画花括号；规范见 `docs/格式/123格式.md` §7）。
//
// 模型里两种形状：
//   - MusicXML 读进来的：一个 `Part` 带 `<staves>`，元素的 `staff` 是 1、2…，第 k 条谱表上的 voice 按每谱表 4 个编（5–8 在第二条）；
//   - 123 / ABC 读进来的：每条谱表各是一个 `Part`，第二条起 `staffOf` 指向首条的 id，元素的 `staff` 都是 1。
// 写出 ABC / 123 之前 `splitStaves` 把前者拆成后者；写 MusicXML（`xmlproject.ts`，五线谱 / 混排、试听、导出都经它）时
// `mergeStaffParts` 把后者并回前者。两头互逆：谱表号、谱号、voice 号、跨小节的连线都回得来。
//
// 拆不开的只有**跨谱表**的东西：连到另一条谱表上的音的弧 / 延音线 / 渐强渐弱（各写一个 `V:` 就配不上对）、
// 一个 voice 的音写到另一条谱表上（钢琴谱的跨谱表书写）——前者丢掉，后者归它落在的谱表；
// `capability.ts` 的 `crossStaff` 报出来。

import type { Direction, Element, ElementId, Measure, MeasureAttrs, Part, Song } from "./doc";

/** 每条谱表的 voice 号段（MusicXML 惯例：第 k 条谱表用 4(k−1)+1 … 4k） */
const VOICES_PER_STAFF = 4;

/** 元素占的时值（倚音、`y` 不占）。 */
function lengthOf(el: Element): number {
  if (el.kind === "chord") return el.grace ? 0 : el.duration.divisions;
  return el.duration?.divisions ?? 0;
}

/** 小节里各元素的起点（`onset` 缺省 = 前一个元素的终点）。 */
function startsOf(m: Measure): number[] {
  const out: number[] = [];
  let end = 0;
  for (const el of m.elements) {
    const s = el.onset ?? end;
    out.push(s);
    end = s + lengthOf(el);
  }
  return out;
}

/** 「排在第几个元素之后、起点多少」这种挂法的时刻（`Direction` / `laterAttrs` / 中间小节线同一口径）。 */
function timeAt(m: Measure, starts: readonly number[], after: number | undefined, onset: number | undefined): number {
  if (onset !== undefined) return onset;
  const k = after ?? 0;
  return k > 0 ? starts[k - 1]! + lengthOf(m.elements[k - 1]!) : 0;
}

/** 这份歌里有没有一个声部带几条谱表（拆了才写得进 ABC 家族）。 */
export function hasExtraStaves(song: Song): boolean {
  return song.parts.some((p) => staffNumbers(p).length > 1);
}

function staffNumbers(part: Part): number[] {
  const set = new Set<number>();
  for (const m of part.measures) for (const el of m.elements) set.add(el.staff || 1);
  for (let k = 2; k <= (part.staffCount ?? 1); k++) set.add(k);
  return [...set].sort((a, b) => a - b);
}

/** 一个 voice 的「家」：它第一个音所在的谱表。 */
function homeStaves(part: Part): Map<number, number> {
  const home = new Map<number, number>();
  for (const m of part.measures) for (const el of m.elements) if (!home.has(el.voice)) home.set(el.voice, el.staff || 1);
  return home;
}

/** 跨谱表的东西：连两条谱表上的音的记号、写到别的谱表上的音。`capability.ts` 的 `crossStaff` 用它。 */
export function hasCrossStaff(song: Song): boolean {
  const staffOf = new Map<ElementId, string>();
  for (const p of song.parts) {
    if (staffNumbers(p).length < 2) continue;
    const home = homeStaves(p);
    for (const m of p.measures) {
      for (const el of m.elements) {
        staffOf.set(el.id, `${p.id}/${el.staff || 1}`);
        if (el.kind === "chord" && !el.rest && home.get(el.voice) !== (el.staff || 1)) return true;
      }
    }
  }
  return song.marks.some((mk) => {
    const a = staffOf.get(mk.start), b = staffOf.get(mk.end);
    return a !== undefined && b !== undefined && a !== b;
  });
}

/** 把元素子集挑出来另成一个小节：元素按需补 `onset`，`Direction` / `laterAttrs` / 中间小节线重算挂在第几个元素之后。 */
function subMeasure(m: Measure, keep: (el: Element) => boolean, dirKeep: (d: Direction) => boolean, attrsOf: (a: MeasureAttrs) => MeasureAttrs | null, newId: () => ElementId): Measure {
  const starts = startsOf(m);
  const idx: number[] = [];
  m.elements.forEach((el, j) => {
    if (keep(el)) idx.push(j);
  });
  const elements: Element[] = [];
  let end = 0;
  for (const j of idx) {
    const el = { ...m.elements[j]! };
    const s = starts[j]!;
    if (s !== end) el.onset = s;
    else delete el.onset;
    elements.push(el);
    end = s + lengthOf(el);
  }
  /** 原来挂在第 `after` 个元素之后、时刻 `t` 的东西，在子集里挂在第几个之后、要不要写明时刻 */
  const relocate = (after: number | undefined, onset: number | undefined): { afterElements: number; onset?: number } => {
    const t = timeAt(m, starts, after, onset);
    const k = idx.filter((j) => j < (after ?? 0)).length;
    const def = k > 0 ? starts[idx[k - 1]!]! + lengthOf(m.elements[idx[k - 1]!]!) : 0;
    return t !== def ? { afterElements: k, onset: t } : { afterElements: k };
  };
  // 这条谱表这一小节一个音都没有（原谱整小节空着、`<forward>` 跳过）：补一个不可见的整小节休止占住，
  // 否则写出 `| |` 空小节，读回投影时被并掉（`mergeEmptyMeasures`），后面的小节整体错一位
  if (!elements.length && m.elements.length) {
    const len = Math.max(m.duration ?? 0, ...m.elements.map((el, j) => starts[j]! + lengthOf(el)));
    if (len > 0) {
      elements.push({ kind: "chord", id: newId(), notes: [], rest: { measure: true }, printObject: false, duration: { divisions: len, dots: 0, type: "whole" }, voice: 1, staff: 1 });
    }
  }
  const out: Measure = { ...m, elements };
  // 留下的音比整小节短（跨谱表的声部这一小节后半在另一条谱表上）：记下原小节长，写出端照它在末尾补空拍，读回各谱表小节等长
  const full = Math.max(m.duration ?? 0, ...m.elements.map((el, j) => starts[j]! + lengthOf(el)));
  const subStarts = startsOf(out);
  if (full > Math.max(0, ...elements.map((el, j) => subStarts[j]! + lengthOf(el)))) out.duration = full;
  if (m.attrs) {
    const a = attrsOf(m.attrs);
    if (a) out.attrs = a;
    else delete out.attrs;
  }
  if (m.laterAttrs) {
    const later = m.laterAttrs.flatMap((la) => {
      const a = attrsOf(la.attrs);
      return a ? [{ ...relocate(la.afterElements, la.onset), attrs: a }] : [];
    });
    if (later.length) out.laterAttrs = later;
    else delete out.laterAttrs;
  }
  if (m.directions) {
    const dirs = m.directions.filter(dirKeep).map((d) => {
      const r = relocate(d.afterElements, d.onset);
      const nd: Direction = { ...d, afterElements: r.afterElements };
      if (r.onset !== undefined) nd.onset = r.onset;
      else delete nd.onset;
      delete nd.staff;
      return nd;
    });
    if (dirs.length) out.directions = dirs;
    else delete out.directions;
  }
  if (m.barlines?.some((b) => b.location === "middle")) {
    out.barlines = m.barlines.map((b) => b.location === "middle" ? { ...b, afterElements: relocate(b.afterElements, undefined).afterElements } : b);
  }
  return out;
}

/** 谱号等属性里属于第 `k` 条谱表的那部分，谱表号改成 1；`staves` 去掉。拍号调号各条谱表都带。 */
function attrsForStaff(a: MeasureAttrs, k: number): MeasureAttrs | null {
  const out: MeasureAttrs = { ...a };
  delete out.staves;
  if (a.clefs) {
    const clefs = a.clefs.filter((c) => (c.staff ?? 1) === k).map((c) => {
      const nc = { ...c };
      delete nc.staff;
      return nc;
    });
    if (clefs.length) out.clefs = clefs;
    else delete out.clefs;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * MusicXML 形状的歌里**整小节一个元素都没有**的小节（识别稿整小节空着、合唱谱某声部这一小节没认出音）补一个不可见的整小节休止：
 * 否则 ABC 家族写出 `| |`，读回投影时被并掉（`mergeEmptyMeasures`），这个声部后面的小节整体错一位。
 * 长度按小节的 `duration`，没有就按生效的拍号；都没有按四拍。简谱形状的歌不动（空小节是行首 `|:` 之类，本来就该并掉）。不动原件。
 */
export function fillEmptyMeasures(song: Song): Song {
  if (!song.parts.some((p) => p.measures[0]?.attrs?.divisions !== undefined)) return song;
  let maxId = 0;
  for (const p of song.parts) for (const m of p.measures) for (const el of m.elements) maxId = Math.max(maxId, el.id);
  let hit = false;
  const parts = song.parts.map((p) => {
    let time = song.time, dpq = 0;
    const measures = p.measures.map((m) => {
      if (m.attrs?.time) time = m.attrs.time;
      if (m.attrs?.divisions) dpq = m.attrs.divisions;
      if (m.elements.length || !dpq) return m;
      const len = m.duration ?? (time ? (dpq * 4 * time.beats) / time.beatType : dpq * 4);
      hit = true;
      return { ...m, elements: [{ kind: "chord" as const, id: ++maxId, notes: [], rest: { measure: true }, printObject: false, duration: { divisions: len, dots: 0, type: "whole" as const }, voice: 1, staff: 1 }] };
    });
    return { ...p, measures };
  });
  return hit ? { ...song, parts } : song;
}

/**
 * 带几条谱表的声部拆成每条谱表一个声部（第二条起 `staffOf` 指向首条）。没有就原样返回。不动原件。
 * 跨谱表的记号（两头落在不同谱表上）丢掉；写到别的谱表上的音归它落在的那条。
 */
export function splitStaves(song: Song): Song {
  if (!hasExtraStaves(song)) return song;
  const parts: Part[] = [];
  const partOf = new Map<ElementId, string>();
  const groups = song.partGroups?.map((g) => ({ ...g, parts: [...g.parts] }));
  let maxId = 0;
  for (const p of song.parts) for (const m of p.measures) for (const el of m.elements) maxId = Math.max(maxId, el.id);
  const newId = (): ElementId => ++maxId;
  for (const p of song.parts) {
    const staves = staffNumbers(p);
    if (staves.length < 2) {
      parts.push(p);
      for (const m of p.measures) for (const el of m.elements) partOf.set(el.id, p.id);
      continue;
    }
    const added: string[] = [];
    for (const k of staves) {
      const id = k === staves[0] ? p.id : `${p.id}-S${k}`;
      const base = (k - 1) * VOICES_PER_STAFF;
      const sp: Part = {
        ...p,
        id,
        measures: p.measures.map((m) => {
          const sub = subMeasure(
            m,
            (el) => (el.staff || 1) === k,
            (d) => (d.staff ?? 1) === k,
            (a) => attrsForStaff(a, k),
            newId,
          );
          sub.elements = sub.elements.map((el) => ({ ...el, staff: 1, voice: el.voice > base ? el.voice - base : el.voice }));
          return sub;
        }),
      };
      delete sp.staffCount;
      if (k !== staves[0]) {
        sp.staffOf = p.id;
        delete sp.name;
        delete sp.abbrev;
        delete sp.nameSize;
        added.push(id);
      }
      for (const m of sp.measures) for (const el of m.elements) partOf.set(el.id, id);
      parts.push(sp);
    }
    // 组里有这个声部的，拆出来的几条谱表跟着进组
    for (const g of groups ?? []) {
      const at = g.parts.indexOf(p.id);
      if (at >= 0) g.parts.splice(at + 1, 0, ...added);
    }
  }
  const marks = song.marks.filter((mk) => {
    const a = partOf.get(mk.start), b = partOf.get(mk.end);
    return a === undefined || b === undefined || a === b;
  });
  return { ...song, parts, marks, ...(groups ? { partGroups: groups } : {}) };
}

/**
 * `splitStaves` 的反向：`staffOf` 指向同一首条的声部并回那个声部，成为它的第 2、3… 条谱表。
 * 输入是 MusicXML 形状（`xmlproject.ts` 投影完的）。并进去的元素接在首条之后、按需补 `onset`，voice 号按谱表段挪，
 * 谱号挂上谱表号、首小节写 `staves`。就地改。
 */
export function mergeStaffParts(song: Song): void {
  const byId = new Map(song.parts.map((p) => [p.id, p]));
  const guestsOf = new Map<string, Part[]>();
  for (const p of song.parts) {
    if (!p.staffOf || p.staffOf === p.id) continue;
    const host = byId.get(p.staffOf);
    if (!host || host.staffOf) continue; // 指向不存在的、或指向另一条从属谱表的：当普通声部
    guestsOf.set(host.id, [...(guestsOf.get(host.id) ?? []), p]);
  }
  if (!guestsOf.size) {
    for (const p of song.parts) delete p.staffOf;
    return;
  }
  const merged = new Set<string>();
  for (const [hostId, guests] of guestsOf) {
    const host = byId.get(hostId)!;
    guests.forEach((g, gi) => {
      const k = gi + 2;
      const base = (k - 1) * VOICES_PER_STAFF;
      g.measures.forEach((gm, mi) => {
        let hm = host.measures[mi];
        if (!hm) host.measures.push((hm = { number: gm.number, elements: [] }));
        const hostStarts = startsOf(hm);
        const hostEnd = hm.elements.length ? hostStarts[hostStarts.length - 1]! + lengthOf(hm.elements[hm.elements.length - 1]!) : 0;
        const gStarts = startsOf(gm);
        const offset = hm.elements.length;
        let end = hostEnd;
        gm.elements.forEach((el, j) => {
          const s = gStarts[j]!;
          const ne: Element = { ...el, staff: k, voice: (el.voice || 1) + base };
          if (s !== end) ne.onset = s;
          else delete ne.onset;
          hm.elements.push(ne);
          end = s + lengthOf(ne);
        });
        const fix = <T extends { afterElements?: number; onset?: number }>(x: T): T => {
          const t = timeAt(gm, gStarts, x.afterElements, x.onset);
          const after = offset + (x.afterElements ?? 0);
          const def = after > 0 ? (after > offset ? gStarts[after - offset - 1]! + lengthOf(gm.elements[after - offset - 1]!) : hostEnd) : 0;
          const out = { ...x, afterElements: after };
          if (t !== def) out.onset = t;
          else delete out.onset;
          return out;
        };
        const withStaff = (a: MeasureAttrs): MeasureAttrs | null => a.clefs?.length ? { clefs: a.clefs.map((c) => ({ ...c, staff: k })) } : null;
        if (gm.attrs) {
          const a = withStaff(gm.attrs);
          if (a) {
            hm.attrs ??= {};
            const own = (hm.attrs.clefs ?? []).map((c) => (c.staff ? c : { ...c, staff: 1 }));
            hm.attrs.clefs = [...own, ...a.clefs!];
          }
        }
        for (const la of gm.laterAttrs ?? []) {
          const a = withStaff(la.attrs);
          if (a) (hm.laterAttrs ??= []).push(fix({ ...la, attrs: a }));
        }
        for (const d of gm.directions ?? []) (hm.directions ??= []).push({ ...fix(d), staff: k });
      });
    });
    const staves = guests.length + 1;
    host.staffCount = staves;
    const first = host.measures[0];
    if (first) {
      first.attrs ??= {};
      first.attrs.staves = staves;
      first.attrs.clefs = (first.attrs.clefs ?? []).map((c) => (c.staff ? c : { ...c, staff: 1 }));
      for (let k = 1; k <= staves; k++) {
        if (!first.attrs.clefs.some((c) => c.staff === k)) first.attrs.clefs.push({ sign: "G", line: 2, staff: k });
      }
    }
    // 后面小节的谱号也都要带谱表号（首条的写成 1）
    for (const m of host.measures.slice(1)) {
      if (m.attrs?.clefs) m.attrs.clefs = m.attrs.clefs.map((c) => (c.staff ? c : { ...c, staff: 1 }));
    }
    for (const m of host.measures) {
      for (const la of m.laterAttrs ?? []) if (la.attrs.clefs) la.attrs.clefs = la.attrs.clefs.map((c) => (c.staff ? c : { ...c, staff: 1 }));
      // 首条自己的力度、文字、渐强渐弱同样写明谱表号：不写的 `<direction>` 别的软件（与评分）当整个声部的，下谱表也算一份
      if (m.directions) m.directions = m.directions.map((d) => (d.staff ? d : { ...d, staff: 1 }));
    }
    for (const g of guests) merged.add(g.id);
  }
  song.parts = song.parts.filter((p) => !merged.has(p.id));
  for (const p of song.parts) delete p.staffOf;
  // 组里并掉的声部拿掉；只剩一个声部的组（就是这个大谱表本身）也拿掉——花括号由 `<staves>` 自己画
  if (song.partGroups) {
    song.partGroups = song.partGroups
      .map((g) => ({ ...g, parts: g.parts.filter((id) => !merged.has(id)) }))
      .filter((g) => g.parts.length > 1);
    if (!song.partGroups.length) delete song.partGroups;
  }
}
