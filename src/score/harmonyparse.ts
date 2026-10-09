// 结构化和弦符号（`ScoreDoc` 的 `Harmony`，读自 `<harmony>`）→ 和弦文本（"Am7"、"G/B"、"Fsus4"）。
//
// 是 score/harmonyxml.ts 的反向：那边把文本写成 MusicXML，这边读回来。
// 两边的 kind 映射必须对得上，否则往返一趟和弦就变了样。
//
// **无 DOM 依赖**。

/** kind 值 → 后缀。与 harmonyxml.ts::kindOf 互逆（那边是后缀 → kind）。 */
const KIND_SUFFIX: Record<string, string> = {
  major: "",
  minor: "m",
  dominant: "7",
  "major-seventh": "maj7",
  "minor-seventh": "m7",
  diminished: "dim",
  "diminished-seventh": "dim7",
  augmented: "aug",
  "suspended-fourth": "sus4",
  "suspended-second": "sus2",
  "major-sixth": "6",
  "minor-sixth": "m6",
  "dominant-ninth": "9",
  "major-ninth": "maj9",
  "minor-ninth": "m9",
  "half-diminished": "m7-5",
  power: "5",
  none: "",
  other: "",
};

const alterSign = (v: number): string => (v > 0 ? "♯".repeat(v) : v < 0 ? "♭".repeat(-v) : "");

/** `ScoreDoc` 的结构化和弦（`model/doc.ts::Harmony`）→ 文本。口径同 `harmonyElemToText`。
 *  升降号缺省写 ASCII（`#`/`b`）——123/ABC 的和弦串认的是它；简谱引擎的谱面印 `♯♭`（`"unicode"`）。有原文 `text` 时直接用原文。 */
export function harmonyToText(h: {
  root: { step: string; alter: number; alterLeft?: boolean };
  kind: string;
  kindText?: string;
  bass?: { step: string; alter: number; alterLeft?: boolean };
  degrees?: { value: number; alter: number; type: "add" | "alter" | "subtract" }[];
  text?: string;
}, signs: "ascii" | "unicode" = "ascii"): string {
  if (h.text !== undefined) return h.text;
  const sign = signs === "unicode" ? alterSign : (v: number): string => (v > 0 ? "#".repeat(v) : v < 0 ? "b".repeat(-v) : "");
  const stepAlter = (sa: { step: string; alter: number; alterLeft?: boolean }): string =>
    sa.alterLeft ? sign(sa.alter) + sa.step : sa.step + sign(sa.alter);
  let out = stepAlter(h.root);
  out += h.kindText?.trim() || KIND_SUFFIX[h.kind] || "";
  for (const d of h.degrees ?? []) {
    out += d.type === "subtract" ? `omit${d.value}` : d.type === "alter" ? `${sign(d.alter)}${d.value}` : `add${sign(d.alter)}${d.value}`;
  }
  if (h.bass) out += `/${stepAlter(h.bass)}`;
  return out;
}

/** 前置升降号（`#Fm`、`D/#F`、`bB7`，中文简谱的写法）折成后置（`F#m`、`D/F#`、`Bb7`）。
 *  给只认「字母打头」的格式用：ABC、jcx、jianpu-ly 的和弦都要求根音在前。 */
export function chordSuffixForm(text: string): string {
  return text.trim().replace(/^([#♯b♭])([A-G])/, "$2$1").replace(/\/([#♯b♭])([A-G])/, "/$2$1");
}

/** 和弦文字开头的「字母 + 升降号」，升降号前置后置都认：`F#`、`#F`、`Bb`、`bB`。
 *  `left` = 升降号写在字母前面。认不出返回 null。 */
export function chordStepAlter(s: string): { step: string; acc: string; left: boolean; len: number } | null {
  const m = /^([#♯b♭])([A-G])|^([A-G])([#♯b♭]?)/.exec(s);
  if (!m) return null;
  return m[2] ? { step: m[2], acc: m[1]!, left: true, len: 2 } : { step: m[3]!, acc: m[4] ?? "", left: false, len: m[0].length };
}
