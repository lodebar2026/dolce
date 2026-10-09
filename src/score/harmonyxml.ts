// 和弦符号 → MusicXML `<harmony>`。写出端（model/toxml.ts，简谱来源只有和弦原文）与五线谱识别（staffomr/toxml.ts）共用。
//
// 和弦在本项目里一律以**字符串**形态流转（`"Cm"` / `"B♭7"` / `"Fm/A♭"` / `"Cadd9"`），
// 排版走 layout/harmony.ts 的 chordTextSegs，导出走这里。两边都认 ASCII 与全角升降号，升降号前置（`#Fm`）后置都认。
import { escapeAttr, escapeXml } from "./xmlutil";
import { chordStepAlter } from "./harmonyparse";


const alterOf = (acc: string): number => (acc === "#" || acc === "♯" ? 1 : acc === "b" || acc === "♭" ? -1 : 0);

/** `"C♯m"` → `<harmony>`。解析不出根音就退回 `<direction><words>`（至少把字面留在谱上）。
 *  offset 为**本音符时值内的 divisions 数**：和弦印在两音符之间的拍点上时用它表达，0/缺省即正对。 */
export function harmonyXml(chord: string, offset = 0): string {
  const src = chord.trim();
  const root = chordStepAlter(src);
  if (!root) {
    return `<direction placement="above"><direction-type><words>${escapeXml(chord)}</words>` +
      `</direction-type></direction>`;
  }
  let rest = src.slice(root.len);
  let bass = "";
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    bass = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
  }
  const kind = kindOf(rest);
  let xml = `<harmony><root><root-step>${root.step}</root-step>` + alterXml("root-alter", root) +
    `</root><kind text="${escapeAttr(rest)}">${kind}</kind>`;
  const b = chordStepAlter(bass);
  if (b) xml += `<bass><bass-step>${b.step}</bass-step>` + alterXml("bass-alter", b) + `</bass>`;
  // <offset> 在 harmony 里排在 root/kind/bass 之后（MusicXML 3.0 DTD 的元素顺序）。
  if (offset > 0) xml += `<offset>${Math.round(offset)}</offset>`;
  return xml + `</harmony>`;
}

/** `<root-alter>` / `<bass-alter>`；前置写法（`#Fm`）标 `location="left"`，读回来照样印在字母前面。 */
function alterXml(tag: string, sa: { acc: string; left: boolean }): string {
  const alter = alterOf(sa.acc);
  return alter !== 0 ? `<${tag}${sa.left ? ' location="left"' : ""}>${alter}</${tag}>` : "";
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
