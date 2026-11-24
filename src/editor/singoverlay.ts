// 按参照歌词生成的段落与演唱顺序**挂在模型上**（无 DOM）：原文格式写不下 `%%sing` 的（ABC、文本谱、`.jpwabc`、jcx、jianpu-ly、MusicXML，
// 见 `crates/dolce-formats/src/capability.rs::gone`）不改原文，每次读出模型后照它补上段落标记与演唱顺序——投影、试听、导出都照它走，
// 存成原格式时照常走保存前丢失提示（用户定 2026-11-24）；123 写进原文，不走这里（`singapply.ts`）。
//
// 段落标记按位置记（第几声部第几小节第几个元素），不按元素 id：改了原文元素 id 会重编，位置在没动的地方照样对得上；
// 有标记的位置没了（删了那几小节）就整份作废。

import type { ScoreDoc, SingPass } from "../model/doc";
import type { SingFitReport } from "../layout/rustlayout";

interface Pos {
  part: number;
  measure: number;
  element: number;
}

export interface SingOverlay {
  song: number;
  marks: { name: string; at: Pos }[];
  order: SingPass[];
}

function posOf(doc: ScoreDoc, song: number, id: number): Pos | null {
  const s = doc.songs[song];
  if (!s) return null;
  for (let part = 0; part < s.parts.length; part++) {
    const ms = s.parts[part]!.measures;
    for (let measure = 0; measure < ms.length; measure++) {
      const element = ms[measure]!.elements.findIndex((e) => e.kind === "chord" && e.id === id);
      if (element >= 0) return { part, measure, element };
    }
  }
  return null;
}

/** 生成结果 → 挂在模型上的那份；有标记在模型里找不到为 null。 */
export function overlayOf(doc: ScoreDoc, song: number, fit: SingFitReport): SingOverlay | null {
  if (!fit.order.length) return null;
  const marks: SingOverlay["marks"] = [];
  for (const m of fit.marks) {
    const at = posOf(doc, song, m.before);
    if (!at) return null;
    marks.push({ name: m.name, at });
  }
  return { song, marks, order: fit.order };
}

/** 照挂着的那份补进刚读出的模型（就地改）：段落标记整套换掉、演唱顺序换上、头部 `P:` 去掉。位置对不上返回 false、不改。 */
export function applyOverlay(doc: ScoreDoc, ov: SingOverlay): boolean {
  const s = doc.songs[ov.song];
  if (!s) return false;
  const marks: { name: string; before: number }[] = [];
  for (const m of ov.marks) {
    const el = s.parts[m.at.part]?.measures[m.at.measure]?.elements[m.at.element];
    if (!el || el.kind !== "chord") return false;
    marks.push({ name: m.name, before: el.id });
  }
  s.sectionMarks = marks;
  s.singOrder = ov.order.map((p) => ({ ...p, items: p.items.map((it) => ({ ...it })) }));
  delete s.sectionOrder;
  return true;
}
