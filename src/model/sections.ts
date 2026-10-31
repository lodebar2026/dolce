// ABC §3.1.9 的段落：头部 `P:` 的顺序串展开；写明的演唱顺序（`P:`、`I:playorder`）搬到另一份模型（五线谱档读回的 `mixedDoc`）。
//
// 语义见 `docs/格式/123格式.md` §6。

import type { Chord, ElementId, PlayPass, ScoreDoc, Song } from "./doc";
import { melodyChords } from "./jianpu";

/** 展开上限：`P:((((A9)9)9)9)9` 这种写错的别把内存吃光 */
const MAX_SEQ = 2000;

/** `P:((AB)3.(CD)3)2` → `A B A B A B C D …`。点与空白只作分隔；写不明白或展开太长返回 null。 */
export function expandSectionOrder(text: string): string[] | null {
  const s = text.replace(/[.\s]/g, "");
  let i = 0;
  const seq = (depth: number): string[] | null => {
    const out: string[] = [];
    while (i < s.length && s[i] !== ")") {
      let item: string[];
      if (s[i] === "(") {
        i++;
        const inner = seq(depth + 1);
        if (!inner || s[i] !== ")") return null;
        i++;
        item = inner;
      } else if (/[A-Za-z]/.test(s[i]!)) {
        item = [s[i++]!];
      } else return null;
      const m = /^\d+/.exec(s.slice(i));
      const times = m ? Number(m[0]) : 1;
      if (m) i += m[0].length;
      if (out.length + item.length * times > MAX_SEQ) return null;
      for (let k = 0; k < times; k++) out.push(...item);
    }
    return depth === 0 && i < s.length ? null : out;
  };
  const out = seq(0);
  return out && out.length > 0 ? out : null;
}

/** 音乐前最后一个字段上的 `P:` 是顺序还是第一个标记：多于一项的全大写顺序串才算顺序（`P:BA`、`P:A2`、`P:(AB)2`）；
 *  `P:A`、`P:Intro` 是标记。 */
export function looksLikeOrder(text: string): boolean {
  if (!/^[A-Z0-9().\s]+$/.test(text)) return false;
  const seq = expandSectionOrder(text);
  return seq !== null && seq.length > 1;
}

/** 排顺序用的标记：只取最靠前的那个写了标记的声部（几个声部各写一份是同一回事）。`locate` 找不到的（这份谱里没这个音）丢掉。 */
export function locateSectionMarks(
  song: Song,
  locate: (id: ElementId) => { rank: number; mid: number; skip: number } | undefined,
): { name: string; mid: number; skip: number }[] {
  const found = (song.sectionMarks ?? []).flatMap((m) => {
    const at = locate(m.before);
    return at ? [{ name: m.name, ...at }] : [];
  });
  const rank = Math.min(...found.map((m) => m.rank));
  return found.filter((m) => m.rank === rank).map(({ name, mid, skip }) => ({ name, mid, skip }));
}

/** 给 `I:playorder` / `.Repeat` 的每一项定首尾和弦（已定的不动）：写了音符级端点的就是它，否则取那一小节第一声部的第一个、最后一个音；
 *  那一小节没有音就往段内挪。一个音都没有的项没有锚点。 */
export function anchorPlayOrder(song: Song): PlayPass[] {
  const measures = song.parts[0]?.measures ?? [];
  const sounding = (i: number): Chord[] => {
    const m = measures[i];
    return m ? melodyChords(m).filter((c) => !c.grace) : [];
  };
  return (song.playOrder ?? []).map((p) => {
    const out = { ...p };
    for (let i = p.fromMeasure - 1; out.fromAnchor === undefined && i < p.toMeasure; i++) out.fromAnchor = p.fromElement ?? sounding(i)[0]?.id;
    for (let i = p.toMeasure - 1; out.toAnchor === undefined && i >= p.fromMeasure - 1; i--) out.toAnchor = p.toElement ?? sounding(i).slice(-1)[0]?.id;
    return out;
  });
}

/** 写明的演唱顺序搬到读回的那份模型上：MusicXML 写不下 `I:playorder` 与 `P:`、小节会拆、元素 id 也换了，按 `Chord.srcId` 对回去。
 *  `I:playorder` 优先于 `P:`，有它的不搬 `P:`。 */
export function carryPlayOrder(from: ScoreDoc, to: ScoreDoc): void {
  from.songs.forEach((src, i) => {
    const dst = to.songs[i];
    if (!dst) return;
    if (src.playOrder?.length) {
      const { first, last } = chordsBySrc(dst);
      const passes = anchorPlayOrder(src).flatMap((p): PlayPass[] => {
        const fromAnchor = p.fromAnchor === undefined ? undefined : first.get(p.fromAnchor);
        const toAnchor = p.toAnchor === undefined ? undefined : last.get(p.toAnchor);
        if (fromAnchor === undefined || toAnchor === undefined) return [];
        const { fromElement: _f, toElement: _t, ...rest } = p;
        return [{ ...rest, fromAnchor, toAnchor }];
      });
      if (passes.length) dst.playOrder = passes;
      return;
    }
    if (!src.sectionOrder) return;
    dst.sectionOrder = src.sectionOrder;
    const bySrc = chordsBySrc(dst).first;
    const marks = (src.sectionMarks ?? []).flatMap((m) => {
      const before = bySrc.get(m.before);
      return before === undefined ? [] : [{ name: m.name, before }];
    });
    if (marks.length) dst.sectionMarks = marks;
  });
}

/** 源 id → 读回那份里第一个、最后一个对应的和弦（跨小节的音读回是几个） */
function chordsBySrc(song: Song): { first: Map<ElementId, ElementId>; last: Map<ElementId, ElementId> } {
  const first = new Map<ElementId, ElementId>();
  const last = new Map<ElementId, ElementId>();
  for (const part of song.parts) {
    for (const m of part.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.srcId === undefined) continue;
        if (!first.has(el.srcId)) first.set(el.srcId, el.id);
        last.set(el.srcId, el.id);
      }
    }
  }
  return { first, last };
}
