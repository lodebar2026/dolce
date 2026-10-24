// 位图五线谱的**识别对照视图**：页面位图打底，每个识别出的音按源图框画一个框，框上标它**现在**的音名
// （谱面上改过的跟着变：改过的标青、删掉的划掉变灰、新插的按前后音插值画虚框），供逐音核对。小节线按源图位置画一条竖线
// （并掉的划掉）。命中层每个音一个透明框（`data-omr` = 写进 `<note id>` 的那个 id；新插的没有识别 id，带 `data-id` = 元素 id），
// 每条小节线一个（`data-measure` = 它现在收尾的是全曲第几小节），编辑器按它们把点选对到模型（同简谱的核对视图）。
// 歌词字、弧、力度、文字指示各一个细框（`StaffSourceMark`，`data-kind` 为 `lyric` / `mark`、`data-omr` = 写进元素 `id` 的那个），
// 不标字（原图上就是那个字），改过标青、删掉划掉；命中框垫在音的下面（弧的外框罩着音，点音仍是音）。
// 坐标就是位图像素（与 `RasterPageResult.raster.bin` 同一空间）。

import type { Binary } from "../omrkit/types";
import { SVG_NS, pageSvg, svgRect } from "../omrkit/svgkit";

export interface StaffMark {
  /** 识别 id；新插的音没有，用 `elementId` */
  id: string;
  elementId?: number;
  box: { left: number; right: number; top: number; bottom: number };
  /** 框上标的字（音名，休止为「休」） */
  label: string;
  state?: "edited" | "deleted" | "inserted";
}

/** 音以外的识别框：歌词字、弧、延音线、力度、文字指示 */
export interface StaffSourceMark {
  id: string;
  kind: "lyric" | "slur" | "tied" | "dynamic" | "words";
  box: { left: number; right: number; top: number; bottom: number };
  state?: "edited" | "deleted";
}

/** 源图上的一条小节线：竖线 `x`，从谱表顶到底；`measure` = 它现在收尾的那一小节（全曲下标），并掉了为 null */
export interface StaffBarMark {
  x: number;
  top: number;
  bottom: number;
  measure: number | null;
}

/** 一页：位图 + 识别框 + 命中层。`view` 同简谱核对：原位叠加画框与音名，仅原图只留命中层。 */
export function renderStaffRecognitionPage(bin: Binary, marks: readonly StaffMark[], view: "inplace" | "floating" | "original" = "inplace", bars: readonly StaffBarMark[] = [], others: readonly StaffSourceMark[] = []): SVGSVGElement {
  const svg = pageSvg(bin, "omr-recognize omr-staff-recognize");
  const hs = marks.map((m) => m.box.bottom - m.box.top).sort((a, b) => a - b);
  const h = hs.length ? hs[hs.length >> 1]! : 12; // 符头高的中位数：字号、线宽按它
  if (view !== "original") {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "omr-overlay omr-staff-overlay");
    for (const b of bars) {
      const l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("x1", String(b.x));
      l.setAttribute("x2", String(b.x));
      l.setAttribute("y1", String(b.top));
      l.setAttribute("y2", String(b.bottom));
      l.setAttribute("class", b.measure === null ? "omr-staff-bar omr-staff-bar-gone" : "omr-staff-bar");
      l.setAttribute("stroke-width", String(Math.max(1.5, h * 0.18)));
      g.appendChild(l);
    }
    for (const m of others) {
      const sub = document.createElementNS(SVG_NS, "g");
      sub.setAttribute("class", ["omr-staff-src", `omr-src-${m.kind}`, m.state ? `omr-num-${m.state}` : ""].filter(Boolean).join(" "));
      const pad = h * 0.08;
      sub.appendChild(svgRect(m.box.left - pad, m.box.top - pad, m.box.right - m.box.left + pad * 2, m.box.bottom - m.box.top + pad * 2,
        { class: "omr-staff-box omr-src-box", "stroke-width": String(Math.max(1, h * 0.06)) }));
      if (m.state === "deleted") {
        const l = document.createElementNS(SVG_NS, "line");
        l.setAttribute("x1", String(m.box.left - pad));
        l.setAttribute("y1", String(m.box.bottom + pad));
        l.setAttribute("x2", String(m.box.right + pad));
        l.setAttribute("y2", String(m.box.top - pad));
        l.setAttribute("class", "omr-strike");
        l.setAttribute("stroke-width", String(Math.max(1.5, h * 0.1)));
        sub.appendChild(l);
      }
      g.appendChild(sub);
    }
    for (const m of marks) {
      const sub = document.createElementNS(SVG_NS, "g");
      sub.setAttribute("class", ["omr-staff-note", m.state ? `omr-num-${m.state}` : ""].filter(Boolean).join(" "));
      const pad = h * 0.15;
      sub.appendChild(svgRect(m.box.left - pad, m.box.top - pad, m.box.right - m.box.left + pad * 2, m.box.bottom - m.box.top + pad * 2,
        { rx: String(pad), class: m.state === "inserted" ? "omr-staff-box omr-inserted-box" : "omr-staff-box", "stroke-width": String(Math.max(1, h * 0.08)) }));
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", String((m.box.left + m.box.right) / 2));
      t.setAttribute("y", String(m.box.top - h * 0.35));
      t.setAttribute("font-size", String(h * 0.9));
      t.setAttribute("text-anchor", "middle");
      t.textContent = m.label;
      sub.appendChild(t);
      if (m.state === "deleted") {
        const l = document.createElementNS(SVG_NS, "line");
        l.setAttribute("x1", String(m.box.left - pad));
        l.setAttribute("y1", String(m.box.bottom + pad));
        l.setAttribute("x2", String(m.box.right + pad));
        l.setAttribute("y2", String(m.box.top - pad));
        l.setAttribute("class", "omr-strike");
        l.setAttribute("stroke-width", String(Math.max(1.5, h * 0.12)));
        sub.appendChild(l);
      }
      g.appendChild(sub);
    }
    svg.appendChild(g);
  }
  const hits = document.createElementNS(SVG_NS, "g");
  hits.setAttribute("class", "omr-hits");
  // 弧的外框最大，垫在最底下；删掉的同音一样留框不带 id
  for (const m of [...others].sort((a, b) => Number(b.kind === "slur" || b.kind === "tied") - Number(a.kind === "slur" || a.kind === "tied"))) {
    const pad = h * 0.1;
    const attrs: Record<string, string> = { "data-kind": m.kind === "lyric" ? "lyric" : "mark", "data-src": m.kind, class: "omr-hit" };
    if (m.state !== "deleted") attrs["data-omr"] = m.id;
    hits.appendChild(svgRect(m.box.left - pad, m.box.top - pad, m.box.right - m.box.left + pad * 2, m.box.bottom - m.box.top + pad * 2, attrs));
  }
  for (const m of marks) {
    // 删掉的音照简谱核对留着命中框：模型里没有它，点它等于点空白（落插入光标），两边手感一致
    const pad = h * 0.3;
    const attrs: Record<string, string> = { "data-kind": "note", class: "omr-hit" };
    if (m.state === "inserted" && m.elementId !== undefined) attrs["data-id"] = String(m.elementId);
    else if (m.state !== "deleted") attrs["data-omr"] = m.id;
    hits.appendChild(svgRect(m.box.left - pad, m.box.top - pad, m.box.right - m.box.left + pad * 2, m.box.bottom - m.box.top + pad * 2, attrs));
  }
  for (const b of bars) {
    if (b.measure === null) continue;
    const w = Math.max(4, h * 0.6);
    hits.appendChild(svgRect(b.x - w / 2, b.top, w, b.bottom - b.top, { "data-kind": "barline", "data-measure": String(b.measure), class: "omr-hit" }));
  }
  svg.appendChild(hits);
  return svg;
}
