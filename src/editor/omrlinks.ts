// 五线谱识别的**识别 id ↔ 文档里的音**，任何源格式都认得（issue 23 源码问题 P3）。
//
// 识别时每个 `<note>` 写 `id="omr<k>"`（`rasteromr/song.ts`），原图对照、并排原图、重建回放都按它认框。
// MusicXML 原文里 id 就在 `<note>` 上（`xmlsurface.ts::surfaceOf`）；ABC / 123 这些文本里没有地方写，改记一张旁表：
// **和弦记号在原文里的起点 → 各音的识别 id**（`StaffLinks`），随编辑迁移起点（同简谱识别的 `JpwMeta`）。
//
// 换格式时（格式下拉、重建后切回原来的格式）旁表从**换之前那份**带过来：两边都投成 MusicXML 形状（`xmlproject.ts`，
// 123/ABC 的大谱表并回 `<staves>`），按「第几声部、第几谱表、绝对拍点、音高」对上，同一处几个音按音高逐个认。
// 简谱的一拍一个 `0` 把识别的二分休止拆成了几个：后面几个落在识别那个休止的时值里，记成「接着的」（`COVERED`），
// 对照里不当新插的音画虚框。

import type { Chord, ElementId, Measure, ScoreDoc, Song } from "../model/doc";
import { hasTieSyntax, isXmlShaped, projectForMusicXml } from "../model/xmlproject";
import { surfaceOf } from "../model/xmlsurface";

/** 接着前一个识别休止的一段（简谱拆开的休止）：不对应识别框，也不算新插的 */
export const COVERED = "";

/** 一个和弦各音的识别 id（休止一项）；`undefined` = 没有（新插的） */
export type StaffIds = (string | undefined)[];

/** 文档 → 各和弦（MusicXML 形状里的）各音的识别 id。 */
export interface StaffView {
  /** MusicXML 形状的那首（文本格式是投影出来的；元素 id 与原文模型的相同） */
  song: Song;
  idsOf(el: Chord): StaffIds;
}

/** 投成 MusicXML 形状（123 / ABC 的大谱表并回一个声部）。已经是的原样返回。 */
export function xmlShape(doc: ScoreDoc): Song | null {
  const song = doc.songs[0];
  if (!song) return null;
  return isXmlShaped(song) ? song : projectForMusicXml(song, { slurTies: !hasTieSyntax(doc) });
}

/** 和弦第 `k` 个音的实际音高：简谱形状的（123 只有唱名）按投影出来的 MusicXML 形状取。没有返回 undefined */
export function pitchAt(doc: ScoreDoc, id: ElementId, k = 0): Chord["notes"][number]["pitch"] {
  const find = (song: Song | null): Chord | undefined => {
    for (const part of song?.parts ?? []) for (const m of part.measures) for (const el of m.elements) if (el.kind === "chord" && el.id === id) return el;
    return undefined;
  };
  return find(doc.songs[0] ?? null)?.notes[k]?.pitch ?? find(xmlShape(doc))?.notes[k]?.pitch;
}

/** MusicXML 原文：id 读 `<note id>`（和弦各音各一个；休止读它自己的）。 */
export function surfaceIds(el: Chord): StaffIds {
  const attr = (o: object | undefined): string | undefined => (o ? surfaceOf(o)?.getAttribute("id") ?? undefined : undefined);
  return el.notes.length ? el.notes.map((n) => attr(n) ?? attr(el)) : [attr(el)];
}

const lengthOf = (el: Measure["elements"][number]): number =>
  el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : el.duration?.divisions ?? 0;

/** 各和弦的位置：声部序、谱表、绝对起止（四分音符为单位）、各音音高。 */
interface Pos {
  el: Chord;
  where: string;
  /** 第几小节（拍点对不上时按小节里的先后再认一遍） */
  mi: number;
  t0: number;
  t1: number;
  pitches: string[];
}

function positions(song: Song): Pos[] {
  const out: Pos[] = [];
  song.parts.forEach((part, pi) => {
    let at = 0;
    let divisions = 1;
    part.measures.forEach((m, mi) => {
      if (m.attrs?.divisions) divisions = m.attrs.divisions;
      let end = 0;
      let far = 0;
      for (const el of m.elements) {
        const s = el.onset ?? end;
        end = s + lengthOf(el);
        far = Math.max(far, end);
        if (el.kind !== "chord") continue;
        out.push({
          el,
          mi,
          where: `${pi}/${el.staff || 1}`,
          t0: Math.round(((at + s / divisions) * 1e6)) / 1e6,
          t1: Math.round(((at + end / divisions) * 1e6)) / 1e6,
          pitches: el.rest ? ["r"] : el.notes.map((n) => (n.pitch ? `${n.pitch.step}${n.pitch.alter}${n.pitch.octave}` : "?")),
        });
      }
      at += Math.max(far, m.duration ?? 0) / divisions;
    });
  });
  return out;
}

/**
 * 把 `from` 里各音的识别 id 带到 `to`（都是 MusicXML 形状）：同声部同谱表同拍点、同音高的对上；
 * `to` 里落在 `from` 某个识别休止时值里头的休止记成 `COVERED`。返回 `to` 的和弦 id → 各音 id。
 */
export function carryIds(from: StaffView, to: Song): Map<ElementId, StaffIds> {
  const pool = new Map<string, { pitch: string; id: string | undefined; used: boolean }[]>();
  const rests: { where: string; t0: number; t1: number }[] = [];
  for (const p of positions(from.song)) {
    if (p.el.grace) continue;
    const ids = from.idsOf(p.el);
    const key = `${p.where}@${p.t0}`;
    const list = pool.get(key) ?? [];
    p.pitches.forEach((pitch, k) => list.push({ pitch, id: ids[k], used: false }));
    pool.set(key, list);
    if (p.el.rest && ids[0]) rests.push({ where: p.where, t0: p.t0, t1: p.t1 });
  }
  // 拍点对不上的（小节里删了音、没补休止，后面的音往前挪了）：同小节同谱表里按先后、音高再认
  const byMeasure = new Map<string, { pitches: string; order: string[]; ids: StaffIds; used: boolean }[]>();
  for (const p of positions(from.song)) {
    if (p.el.grace) continue;
    const key = `${p.where}#${p.mi}`;
    byMeasure.set(key, [...(byMeasure.get(key) ?? []), { pitches: [...p.pitches].sort().join(","), order: p.pitches, ids: from.idsOf(p.el), used: false }]);
  }
  const out = new Map<ElementId, StaffIds>();
  const later: Pos[] = [];
  for (const p of positions(to)) {
    if (p.el.grace) continue;
    const list = pool.get(`${p.where}@${p.t0}`) ?? [];
    const ids: StaffIds = p.pitches.map((pitch) => {
      const hit = list.find((x) => !x.used && x.pitch === pitch);
      if (!hit) return undefined;
      hit.used = true;
      return hit.id;
    });
    if (p.el.rest && ids[0] === undefined && rests.some((r) => r.where === p.where && r.t0 < p.t0 && p.t0 < r.t1)) ids[0] = COVERED;
    if (ids.some((x) => x !== undefined)) {
      out.set(p.el.id, ids);
      const list = byMeasure.get(`${p.where}#${p.mi}`);
      const hit = list?.find((x) => !x.used && x.ids.some((id) => id && ids.includes(id)));
      if (hit) hit.used = true;
    } else later.push(p);
  }
  for (const p of later) {
    const key = [...p.pitches].sort().join(",");
    const hit = byMeasure.get(`${p.where}#${p.mi}`)?.find((x) => !x.used && x.pitches === key);
    if (!hit) continue;
    hit.used = true;
    // 音序按音高对回去（同音高的几个按先后）
    const taken = new Set<number>();
    out.set(p.el.id, p.pitches.map((pitch) => {
      const k = hit.order.findIndex((x, i) => x === pitch && !taken.has(i));
      if (k < 0) return undefined;
      taken.add(k);
      return hit.ids[k];
    }));
  }
  return out;
}

/**
 * 文本格式的旁表：和弦记号在原文里的起点 → 各音的识别 id（按原文模型里和弦的音序）。
 */
export class StaffLinks {
  constructor(private readonly at: Map<number, StaffIds>) {}

  /** 按 `carryIds` 的结果建：`doc` 是当前原文读出的模型（和弦带 `source`），`ids` 以元素 id 为键。 */
  static of(doc: ScoreDoc, ids: ReadonlyMap<ElementId, StaffIds>): StaffLinks {
    const at = new Map<number, StaffIds>();
    for (const part of doc.songs[0]?.parts ?? []) {
      for (const m of part.measures) {
        for (const el of m.elements) {
          const got = el.kind === "chord" && el.source ? ids.get(el.id) : undefined;
          if (got) at.set(el.source!.offset, got);
        }
      }
    }
    return new StaffLinks(at);
  }

  idsOf(el: Chord): StaffIds {
    return (el.source && this.at.get(el.source.offset)) || [];
  }

  /** 原文改了：起点跟着挪；记号被整个删掉的（`mapPos` 返回 null）丢掉。 */
  remap(mapPos: (pos: number) => number | null): StaffLinks {
    const at = new Map<number, StaffIds>();
    for (const [pos, ids] of this.at) {
      const np = mapPos(pos);
      if (np !== null && !at.has(np)) at.set(np, ids);
    }
    return new StaffLinks(at);
  }

  entries(): [number, StaffIds][] {
    return [...this.at.entries()];
  }
}

/** 文本格式的文档 → StaffView：投影出来的和弦按 id 找回原文模型里那个和弦，再按它的原文起点查旁表。 */
export function textView(doc: ScoreDoc, links: StaffLinks): StaffView | null {
  const song = xmlShape(doc);
  if (!song) return null;
  const orig = new Map<ElementId, Chord>();
  for (const part of doc.songs[0]?.parts ?? []) for (const m of part.measures) for (const el of m.elements) if (el.kind === "chord") orig.set(el.id, el);
  return { song, idsOf: (el) => links.idsOf(orig.get(el.id) ?? el) };
}

/**
 * 把识别 id 写回一份没有它们的 MusicXML（从文本格式转回 MusicXML 时）：按 `carryIds` 对上的写进各 `<note id>`。
 * 返回写好的原文；一个也对不上就原样返回。
 */
export function stampXmlIds(xml: string, from: StaffView, load: (xml: string) => ScoreDoc): string {
  let doc: ScoreDoc;
  try {
    doc = load(xml);
  } catch {
    return xml;
  }
  const song = doc.songs[0];
  if (!song) return xml;
  const ids = carryIds(from, song);
  let root: Document | null = null;
  for (const part of song.parts) {
    for (const m of part.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        const got = ids.get(el.id);
        if (!got) continue;
        const nodes = el.notes.length ? el.notes.map((n) => surfaceOf(n)) : [surfaceOf(el)];
        nodes.forEach((node, k) => {
          const id = got[k];
          if (!node || !id) return;
          node.setAttribute("id", id);
          root ??= node.ownerDocument;
        });
      }
    }
  }
  return root ? new XMLSerializer().serializeToString(root) : xml;
}

/**
 * 五线谱对照里音以外的识别框（歌词字、弧、延音线、力度、文字指示）现在各落在哪：
 * - `id`：MusicXML 原文读元素上的 `id`（`<lyric>` / `<direction>` / `<slur>`、`<tied>` 起止两端，`toxml.ts` 回填，挪了跟着走）；文本格式没有
 * - `key`：按宿主音的识别 id 认的位置（歌词「哪个音第几段」、力度文字「哪个音上第几条」、弧「起在哪个音上第几条」），文本格式靠它反查 id
 * - `sig`：判「改过」比的样子（宿主音与文字；弧是起止两音）
 * - `entry`：对上索引条目用的键（`markEntryKey`）；`alsoEntry`：文本格式的力度、注记条目挂在宿主音上（`AttachedSource`），按「宿主音 + 种类」认
 * - `stopId`：跨行接上的弧，后半截自己的 id（写在止端）：点 `)` 那一端的条目对它的框
 */
export interface StaffMarkNow {
  ids: string[];
  key: string | null;
  /** 歌词另按「宿主音 + 字」认：换成文本格式时段号会变（ABC 的 `w:` 行按声部接着编） */
  alt?: string;
  sig: string;
  entry: string;
  alsoEntry?: string;
  stopId?: string;
}

/** 索引条目（`sync.ts::SyncEntry`）→ `StaffMarkNow.entry`；不是这几类的返回 null */
export function markEntryKey(e: { kind: string; id: ElementId; verse: number | null; verseNo?: number; markKind?: string; name?: string; end?: ElementId; dir?: { pi: number; mi: number; index: number } }): string | null {
  if (e.kind === "lyric") return `L:${e.id}:${e.verseNo ?? (e.verse ?? 0) + 1}`;
  if (e.kind !== "mark") return null;
  if ((e.markKind === "slur" || e.markKind === "tied") && e.end !== undefined) return `${e.markKind}:${e.id}:${e.end}`;
  if (e.dir) return `D:${e.dir.pi}:${e.dir.mi}:${e.dir.index}`;
  // 文本格式：挂在音上的力度、注记（同一个音上同类的几条认成同一个框）
  if (e.markKind === "dynamic" || e.markKind === "annotation") return `K:${e.id}:${e.markKind}`;
  // ABC 的力度写成装饰 `!mf!`
  if (e.markKind === "deco" && e.name && DYNAMIC_NAME.test(e.name)) return `K:${e.id}:dynamic`;
  return null;
}

const DYNAMIC_NAME = /^(p{1,4}|f{1,4}|m[pf]|s?fz?p?|fp|rfz?|sffz)$/;

/** 小节里各和弦的起点（divisions，按声线接着算） */
function chordOnsets(m: Measure): Map<Chord, number> {
  const out = new Map<Chord, number>();
  const at = new Map<number, number>();
  for (const el of m.elements) {
    const start = (el.kind === "chord" ? el.onset : undefined) ?? at.get(el.voice) ?? 0;
    at.set(el.voice, start + (el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : el.duration?.divisions ?? 0));
    if (el.kind === "chord") out.set(el, start);
  }
  return out;
}

export function staffMarksOf(view: StaffView, withIds: boolean): StaffMarkNow[] {
  const out: StaffMarkNow[] = [];
  const attr = (o: object | undefined, role?: string): string | undefined => (withIds && o ? surfaceOf(o, role)?.getAttribute("id") ?? undefined : undefined);
  const omrOf = new Map<ElementId, string>();
  const nth = new Map<string, number>();
  const keyOf = (pre: string, host: string | undefined): string | null => {
    if (!host) return null;
    const k = `${pre}|${host}`;
    const i = nth.get(k) ?? 0;
    nth.set(k, i + 1);
    return `${k}|${i}`;
  };
  view.song.parts.forEach((part, pi) => part.measures.forEach((m, mi) => {
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      const host = view.idsOf(el).find((x) => x);
      if (host) omrOf.set(el.id, host);
      for (const ly of el.lyrics ?? []) {
        if (!ly.text) continue;
        const id = attr(ly);
        out.push({ ids: id ? [id] : [], key: host ? `L|${host}|${ly.number}` : null, ...(host ? { alt: `Lt|${host}|${ly.text}` } : {}), sig: `${host}|${ly.text}`, entry: `L:${el.id}:${ly.number}` });
      }
    }
    (m.directions ?? []).forEach((d, index) => {
      if (d.type !== "dynamics" && d.type !== "words" && d.type !== "rehearsal" && d.type !== "metronome") return;
      // 宿主音同索引（`sync.ts::buildXml`）：`afterElements` 之后第一个同声线的和弦，小节末的借最后一个
      const same = (e: Measure["elements"][number]): e is Chord => e.kind === "chord" && (d.voice === undefined || e.voice === d.voice);
      // 文本格式投影出来的只记拍位（`offset`），没有 `afterElements`：取那一拍起的音（没有就取其后最近的）
      let h: Chord | undefined;
      if (d.afterElements === undefined) {
        const want = d.offset ?? d.onset ?? 0;
        const os = [...chordOnsets(m)].filter(([c]) => same(c) && !c.grace);
        h = os.filter(([, o]) => o >= want).sort((a, b) => a[1] - b[1])[0]?.[0] ?? os[os.length - 1]?.[0];
      } else h = m.elements.slice(Math.max(0, d.afterElements)).find(same) ?? [...m.elements].reverse().find(same);
      const host = h ? view.idsOf(h).find((x) => x) : undefined;
      const id = attr(d);
      const pre = d.type === "dynamics" ? "D" : "W";
      out.push({ ids: id ? [id] : [], key: keyOf(pre, host), sig: `${host}|${d.text ?? ""}${d.tempo?.perMinute ?? ""}`, entry: `D:${pi}:${mi}:${index}`, ...(h ? { alsoEntry: `K:${h.id}:${d.type === "dynamics" ? "dynamic" : "annotation"}` } : {}) });
    });
  }));
  for (const mk of view.song.marks) {
    if (mk.type !== "slur" && mk.type !== "tied") continue;
    const stop = attr(mk, "stop");
    const ids = [attr(mk, "start"), stop].filter((x): x is string => !!x);
    const a = omrOf.get(mk.start);
    out.push({ ids, key: keyOf(mk.type, a), sig: `${a}|${omrOf.get(mk.end)}`, entry: `${mk.type}:${mk.start}:${mk.end}`, ...(stop ? { stopId: stop } : {}) });
  }
  return out;
}
