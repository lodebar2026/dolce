// 和弦符号 → MusicXML `<harmony>`。写出端（model/toxml.ts，简谱来源只有和弦原文）与五线谱识别（staffomr/toxml.ts）共用。
//
// 和弦在本项目里一律以**字符串**形态流转（`"Cm"` / `"B♭7"` / `"Fm/A♭"` / `"Cadd9"`），
// 排版走 engrave/chord.ts 的 chordTextSegs，导出走这里。两边都认 ASCII 与全角升降号，升降号前置（`#Fm`）后置都认。
import { h, serializeXml, type XmlEl } from "./xmltree";
import { chordStepAlter } from "./harmonyparse";


const alterOf = (acc: string): number => (acc === "#" || acc === "♯" ? 1 : acc === "b" || acc === "♭" ? -1 : 0);

function alterEl(tag: string, sa: { acc: string; left: boolean }): XmlEl | null {
  const alter = alterOf(sa.acc);
  return alter !== 0 ? h(tag, { location: sa.left ? "left" : undefined }, alter) : null;
}

/** `"C♯m"` → `<harmony>` 树。解析不出根音就退回 `<direction><words>`（至少把字面留在谱上）。
 *  offset 为**本音符时值内的 divisions 数**：和弦印在两音符之间的拍点上时用它表达，0/缺省即正对。
 *  `fontSize`（pt）写在 `<root-step font-size>` 上（识别结果照原谱的字号）。 */
export function harmonyEl(chord: string, offset = 0, fontSize?: number): XmlEl {
  const src = chord.trim();
  const root = chordStepAlter(src);
  const fs = { "font-size": fontSize || undefined };
  if (!root) return h("direction", { placement: "above" }, h("direction-type", null, h("words", fs, chord)));
  let rest = src.slice(root.len);
  let bass = "";
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    bass = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
  }
  const b = chordStepAlter(bass);
  return h(
    "harmony",
    null,
    h("root", null, h("root-step", fs, root.step), alterEl("root-alter", root)),
    h("kind", { text: rest }, kindOf(rest)),
    b && h("bass", null, h("bass-step", null, b.step), alterEl("bass-alter", b)),
    // <offset> 在 harmony 里排在 root/kind/bass 之后（MusicXML 3.0 DTD 的元素顺序）。
    offset > 0 && h("offset", null, Math.round(offset)),
  );
}

/** 同 `harmonyEl`，序列化成文本（写出端 `model/toxml.ts` 原样插进去） */
export function harmonyXml(chord: string, offset = 0, fontSize?: number): string {
  return serializeXml(harmonyEl(chord, offset, fontSize));
}

export function kindOf(suffix: string): string {
  const s = suffix.toLowerCase();
  if (s === "") return "major";
  if (/^m(?!aj)/.test(s)) return s.includes("7") ? "minor-seventh" : "minor";
  if (s.startsWith("maj7")) return "major-seventh";
  if (s.startsWith("dim")) return "diminished";
  if (s.startsWith("aug") || s === "+") return "augmented";
  if (s.startsWith("sus")) return "suspended-fourth";
  if (s === "7") return "dominant";
  if (s === "6") return "major-sixth";
  if (s === "9") return "dominant-ninth";
  return "other";
}
