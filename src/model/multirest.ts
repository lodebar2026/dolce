// 多小节休止（`MeasureAttrs.multiRest`：MusicXML `<multiple-rest>`、123 `Zn`）在**谱面上**并成一个小节。
//
// 模型里那 n 个小节一个不少（试听、导出、编辑都按真实小节走），只有排版视图（简谱 `jianpu/slots.ts::docView`、
// 五线谱 `mixed/layout.ts::layoutStaff`）先过这一道：首小节只留一个休止，后面 n−1 个拿掉，收尾那根线挪到首小节上。
// 并不了的（中间有音、换行、换拍号调号谱号、左线、记号、歌词……）照常一小节一小节排，`multiRest` 摘掉免得误画。

import type { Measure, Song } from "./doc";
import { breakAfter } from "./helpers";

/** 整小节都是休止、没挂别的东西（第一个小节可以带记号与文字：排练号、力度、pizz 照常画在横杠上） */
function restOnly(m: Measure, head: boolean): boolean {
  return m.elements.length > 0 && m.elements.every((el) => el.kind === "chord" && !!el.rest && !el.grace
    && !el.lyrics?.length && !el.sustains?.length && (head || (!el.notations && !el.ornaments?.length && !el.sectionWord && !el.harmony)));
}

/** 并好的歌（没有可并的原样返回同一个对象；有的浅拷贝，不动原件）。多声部要各声部同一串都是休止才并。 */
export function compressMultiRests(song: Song): Song {
  const lead = song.parts[0];
  if (!lead?.measures.some((m) => m.attrs?.multiRest)) return song;
  const keep: boolean[] = lead.measures.map(() => true);
  const runs = new Map<number, number>(); // 首小节下标 → n
  for (let i = 0; i < lead.measures.length; i++) {
    const n = lead.measures[i]!.attrs?.multiRest ?? 0;
    if (n < 2 || i + n > lead.measures.length) continue;
    const ok = song.parts.every((p) => {
      for (let j = i; j < i + n; j++) {
        const x = p.measures[j];
        if (!x || !restOnly(x, j === i)) return false;
        if (j > i && (x.attrs || x.laterAttrs?.length || x.print?.newSystem || x.print?.newPage || x.directions?.length
          || (x.barlines ?? []).some((b) => b.location === "left"))) return false;
        if (j < i + n - 1 && (breakAfter(p, j) || (x.barlines ?? []).some((b) => b.location === "right" && (b.style !== "regular" || b.repeat || b.ending || b.ornaments?.length)))) return false;
      }
      return true;
    });
    if (!ok) continue;
    runs.set(i, n);
    for (let j = i + 1; j < i + n; j++) keep[j] = false;
    i += n - 1;
  }
  return {
    ...song,
    parts: song.parts.map((p) => ({
      ...p,
      measures: p.measures.flatMap((m, i): Measure[] => {
        if (!keep[i]) return [];
        const n = runs.get(i);
        if (n === undefined) {
          if (!m.attrs?.multiRest) return [m];
          const { multiRest: _drop, ...attrs } = m.attrs;
          void _drop;
          return [{ ...m, attrs }];
        }
        const last = p.measures[i + n - 1]!;
        return [{
          ...m,
          attrs: { ...m.attrs, multiRest: n },
          elements: [m.elements[0]!],
          barlines: [...(m.barlines ?? []).filter((b) => b.location !== "right"), ...(last.barlines ?? []).filter((b) => b.location === "right")],
        }];
      }),
    })),
  };
}
