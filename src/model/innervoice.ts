// 同一谱表上的第二声部（123/ABC 的 `&`、MusicXML 同一 `<staff>` 里的第二个 `<voice>`）与文本谱 `{dsb…}` 并排块之间的互转。
//
// 简谱一行只排一路旋律：主行是 `melodyLane`（最小谱表上的最小 voice），同一谱表的第二路照番茄的临时多声部
// 排成并排块（`jianpu/slots.ts` 收成下行、`fanqie/tofanqie.ts` 写成 `{dsb…}`）；第三路起、别的谱表排不下。
// 反过来，文本谱的 `{dsb…}` 层进 123 / MusicXML 时还原成第二声部（123 写 `&`、MusicXML 写 `<voice>2`），
// 以前这一层在两边的写出端都被静默丢掉。

import { SIMPLE_DIVISIONS, type Chord, type Element, type ElementId, type InlineItem, type Mark, type Measure, type Song } from "./doc";
import { jianpuShape, melodyLane } from "./jianpu";

/** 元素在小节里属于哪一路：`main` 简谱主行、`inner` 同一谱表的第二声部、`null` 排不下（别的谱表、第三声部起）。 */
export type Lane = "main" | "inner" | null;

/** 这一小节的分路判据。小节里只有一路时恒为 `main`。 */
export function lanesOf(mea: Measure): (el: Element) => Lane {
  const lane = melodyLane(mea);
  if (!lane || mea.elements.every((el) => el.voice === lane.voice && el.staff === lane.staff)) return () => "main";
  let second: number | undefined;
  for (const el of mea.elements) {
    if (el.kind === "chord" && el.staff === lane.staff && el.voice !== lane.voice && (second === undefined || el.voice < second)) second = el.voice;
  }
  return (el) => (el.staff !== lane.staff ? null : el.voice === lane.voice ? "main" : el.voice === second ? "inner" : null);
}

export function hasInnerVoice(mea: Measure): boolean {
  const laneOf = lanesOf(mea);
  return mea.elements.some((el) => laneOf(el) === "inner");
}

/** 一路元素占几个四分（简谱形状：`divisions` 已含增时线，多连音记名义值） */
function laneQuarters(els: readonly Element[]): number {
  let q = 0;
  for (const el of els) {
    if (el.kind === "chord" ? el.grace : el.spacer !== "x") continue;
    const tm = el.duration?.timeMod;
    q += ((el.duration?.divisions ?? 0) / SIMPLE_DIVISIONS) * (tm ? tm.normal / tm.actual : 1);
  }
  return q;
}

/** 补足 `q` 个四分的不可见休止（整拍一个，零头按减时线） */
function padRests(q: number, voice: number, staff: number, newId: () => ElementId): Chord[] {
  const out: Chord[] = [];
  const rest = (quarters: number): Chord => {
    const s = jianpuShape(quarters);
    const c: Chord = {
      kind: "chord", id: newId(), notes: [], rest: {}, printObject: false,
      duration: { divisions: Math.round(quarters * SIMPLE_DIVISIONS), dots: s.dots }, voice, staff,
    };
    if (s.beams) c.beams = Array.from({ length: s.beams }, () => "continue" as const);
    return c;
  };
  for (; q >= 1 - 1e-9; q -= 1) out.push(rest(1));
  for (let k = 1; k <= 6 && q > 1e-9; k++) {
    if (q >= 2 ** -k - 1e-9) {
      out.push(rest(2 ** -k));
      q -= 2 ** -k;
    }
  }
  return out;
}

/** 连续几个带第二声部的小节 → 并排块的小节（只含第二声部；不满小节的补不可见休止，两行才按拍位一列列对齐）。
 *  小节之间补普通小节线（块里的线与主行的线对齐）。元素对象原样搬过来（id 不变：点选、试听高亮、弧都靠它）。 */
export function innerLayerMeasures(run: readonly Measure[], newId: () => ElementId): Measure[] {
  return run.map((mea) => {
    const laneOf = lanesOf(mea);
    const main = mea.elements.filter((el) => laneOf(el) === "main");
    const inner = mea.elements.filter((el) => laneOf(el) === "inner");
    const lack = laneQuarters(main) - laneQuarters(inner);
    const head = inner.find((el) => el.kind === "chord");
    const pad = lack > 1e-6 && head ? padRests(lack, head.voice, head.staff, newId) : [];
    return { number: mea.number, elements: [...inner, ...pad], barlines: [{ location: "right", style: "regular" }] };
  });
}

/** 一串小节里带第二声部的连续段（下标区间，含两端）。`breakAfter(i)`：第 i 小节之后换行，段在那里断开 */
export function innerRuns(measures: readonly Measure[], breakAfter: (i: number) => boolean = () => false): [number, number][] {
  const out: [number, number][] = [];
  const has = measures.map(hasInnerVoice);
  for (let i = 0; i < measures.length; i++) {
    if (!has[i]) continue;
    let end = i;
    while (has[end + 1] && !breakAfter(end)) end++;
    out.push([i, end]);
    i = end;
  }
  return out;
}

function maxId(song: Song): number {
  let max = 0;
  const visit = (els: readonly Element[]): void => {
    for (const el of els) {
      max = Math.max(max, el.id);
      if (el.kind !== "chord") continue;
      for (const su of el.sustains ?? []) max = Math.max(max, su.id);
      for (const it of el.before ?? []) if (it.kind === "layer") for (const m of it.measures) visit(m.elements);
    }
  };
  for (const p of song.parts) for (const m of p.measures) visit(m.elements);
  return max;
}

/** 第二声部 → `{dsb}` 层（文本谱写出端用，在克隆上做）：每个连续段挂在段首小节主行第一个音的 `before` 上，
 *  两端都在段里的弧、连音随层走。别的谱表、第三声部的元素删掉（文本谱写不出，丢失清单另报）。 */
export function voicesToLayers(src: Song, breakAfter: (part: number, i: number) => boolean = () => false): Song {
  if (!src.parts.some((p) => p.measures.some((m) => m.elements.some((el, _, all) => el.voice !== all[0]!.voice || el.staff !== all[0]!.staff)))) return src;
  const song: Song = structuredClone(src);
  let next = maxId(song) + 1;
  const newId = (): ElementId => next++;
  const moved = new Set<Mark>();
  song.parts.forEach((part, pi) => {
    for (const [a, b] of innerRuns(part.measures, (i) => breakAfter(pi, i))) {
      const run = part.measures.slice(a, b + 1);
      const measures = innerLayerMeasures(run, newId);
      const ids = new Set<ElementId>();
      for (const m of measures) for (const el of m.elements) {
        ids.add(el.id);
        if (el.kind === "chord") for (const su of el.sustains ?? []) ids.add(su.id);
      }
      const marks = song.marks.filter((mk) => !moved.has(mk) && ids.has(mk.start) && ids.has(mk.end));
      for (const mk of marks) moved.add(mk);
      const host = run[0]!.elements.find((el): el is Chord => el.kind === "chord" && !el.grace && lanesOf(run[0]!)(el) === "main");
      if (!host) continue;
      const layer: InlineItem = { kind: "layer", role: "voice", measures, marks };
      host.before = [layer, ...(host.before ?? [])];
    }
    for (const m of part.measures) {
      const laneOf = lanesOf(m);
      m.elements = m.elements.filter((el) => laneOf(el) === "main");
    }
  });
  if (moved.size) song.marks = song.marks.filter((mk) => !moved.has(mk));
  return song;
}

/** `{dsb}` 层 → 同一谱表的第二声部（123 / MusicXML 写出端用，在克隆上做）：层里第 k 个小节并进宿主小节往后数第 k 个，
 *  `voice` 取本声部用过的最大号 + 1；层从小节中间起的，前面用不可见休止补齐。层里的弧并回全曲。
 *  `{bz}` 伴奏层是另一回事（小字号的伴奏提示），不动。 */
export function layersToVoices(src: Song): Song {
  const hasLayer = src.parts.some((p) => p.measures.some((m) => m.elements.some((el) =>
    el.kind === "chord" && el.before?.some((it) => it.kind === "layer" && it.role === "voice"))));
  if (!hasLayer) return src;
  const song: Song = structuredClone(src);
  let next = maxId(song) + 1;
  const newId = (): ElementId => next++;
  for (const part of song.parts) {
    const voice = Math.max(1, ...part.measures.flatMap((m) => m.elements.map((el) => el.voice))) + 1;
    part.measures.forEach((mea, mi) => {
      mea.elements.forEach((el, j) => {
        if (el.kind !== "chord" || !el.before?.length) return;
        const layers = el.before.filter((it): it is Extract<InlineItem, { kind: "layer" }> => it.kind === "layer" && it.role === "voice");
        if (!layers.length) return;
        el.before = el.before.filter((it) => !layers.includes(it as Extract<InlineItem, { kind: "layer" }>));
        if (!el.before.length) delete el.before;
        const offset = laneQuarters(mea.elements.slice(0, j));
        for (const layer of layers) {
          layer.measures.forEach((lm, k) => {
            const target = part.measures[mi + k];
            if (!target) return;
            const els = lm.elements.map((x) => ({ ...x, voice, staff: el.staff }) as Element);
            const pad = k === 0 && offset > 1e-6 ? padRests(offset, voice, el.staff, newId) : [];
            target.elements.push(...pad, ...els);
          });
          song.marks.push(...layer.marks);
        }
      });
    });
  }
  return song;
}
