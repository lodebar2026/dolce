// 简谱记号的名字表：文本谱 `&xx`、123/ABC 的 `!xx!`、jianpu-ly 的 `\mf` 与 MusicXML 投影共用一份。
// 这里只有名字与要排的文字；力度的字形在 `engrave/jpglyph.ts::DYNAMICS`（由这份名字表长出来）。
// 模型层与各格式的读写只认名字，不碰字形。

/** 认得的力度名（语法表）。 */
export const DYNAMIC_NAMES: readonly string[] = [
  "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "fp", "sfp", "sfz", "sffz", "fz", "rf", "rfz",
];

const DYNAMIC_SET: ReadonlySet<string> = new Set(DYNAMIC_NAMES);

export function isDynamicName(name: string): boolean {
  return DYNAMIC_SET.has(name);
}

/** 术语类记号：直接排文字。 */
export const TERMS: Readonly<Record<string, string>> = {
  cresc: "cresc.",
  dim: "dim.",
  rit: "rit.",
  tempo: "a tempo",
  atempo: "a tempo",
};
