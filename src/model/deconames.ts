// 音符记号的别名表。123 的 `!xx!` **几种记法都认**（规范 §8.3）：文本谱的拼音短名（`dy`）、
// ABC 名（`staccato` `uppermordent`）、MusicXML 元素名（`inverted-mordent`）、中文名（`顿音`）、
// Muse `.jcx` 的大写名（`HOLD` 延长、`STACC` 顿音、`ATT`/`HAT` 重音、`HUANQI` 换气、`DANBOYIN` 单波音）。
//
// 模型里记号**原名照存**（写回 123 时原样写，作者写什么就还是什么），**用的地方先归一**：
// 简谱排版（`jianpu/slots.ts`，字形表 `engrave/jpglyph.ts::ORNAMENTS` 按短名查）、文本谱写出（`tofanqie.ts`）、
// MusicXML 投影（`xmlproject.ts`）、识别回归的奏法档。以前各处只认自己那一种，
// `!staccato!` 读得进来、简谱里却不画（识别写出的正是这个名字）。
//
// 归一后的键就是文本谱的 `&xx` 短名——排版字形表、文本谱写出端都按它查。

/** 短名 → 别名。别名里的拉丁字母不分大小写。 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  yc: ["fermata", "invertedfermata", "延长", "延长记号", "hold"],
  ycy: [],
  bc: ["tenuto", "保持音"],
  zy: ["accent", ">", "emphasis", "strong-accent", "重音", "att", "hat"],
  dy: ["staccato", "staccatissimo", "顿音", "stacc"],
  hx: ["breath", "breath-mark", "呼吸", "呼吸记号", "huanqi"],
  shy: ["scoop", "上滑音"],
  xhy: ["falloff", "下滑音"],
  sby: ["uppermordent", "pralltriller", "inverted-mordent", "上波音", "danboyin"],
  xby: ["lowermordent", "mordent", "下波音"],
  cy: [],
  tr: ["trill", "trill-mark", "颤音"],
  // 弓法（123 的 `!upbow!` `!downbow!` 是 ABC 标准名；文本谱没有这两个记号，转文本谱时进丢失清单）
  sg: ["upbow", "up-bow", "上弓"],
  xg: ["downbow", "down-bow", "下弓"],
  // 琶音（ABC 标准装饰 `!arpeggio!`，MusicXML `<arpeggiate>`；文本谱没有，转文本谱时进丢失清单）
  arp: ["arpeggio", "arpeggiate", "琶音"],
  // 小节线上的跳转记号（123 的写法与归属见 `abcfamily/jumpmarks.ts`）
  hs: ["segno"],
  ty: ["coda"],
  fine: [],
  dc: ["d.c."],
  ds: ["d.s."],
};

const KEY: ReadonlyMap<string, string> = new Map(
  Object.entries(ALIASES).flatMap(([key, names]) => [[key, key], ...names.map((n) => [n.toLowerCase(), key] as [string, string])]),
);

/** 记号名（任一种记法）→ 短名；认不出返回 undefined。 */
export function decoKey(name: string): string | undefined {
  return KEY.get(name) ?? KEY.get(name.toLowerCase());
}

/** 单音震音的道数：`!/!` `!//!` `!///!` `!////!`（ABC 2.1 标准没有震音，这是 abcm2ps / abc2svg / abcjs 的写法，四道只有 abcjs 认）、
 *  中文名 `!震音!`（三道）；不是震音返回 undefined。`tremolo` 不认：MusicXML 的双音震音（`type="start"/"stop"`）按元素名写出来就是它，
 *  对应那三家的 `!trem1!`–`!trem4!`（两音之间），不是单音的 */
export function tremoloStrokes(name: string): number | undefined {
  if (/^\/{1,4}$/.test(name)) return name.length;
  return name === "震音" ? 3 : undefined;
}

/** 换符头的装饰 `!head-x!` `!head-circle-x!`（abc2svg：名字以 `head-` 开头的装饰换符头；`head-` 后面用 MusicXML 的 notehead 名）→ 符头名 */
export function noteheadOf(name: string): string | undefined {
  const m = /^head-([a-z][a-z-]*)$/i.exec(name);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** 整个和弦共用的非常规符头（打击乐的叉形、圈叉），写 `!head-…!` 用；各音不一样或是普通符头返回 undefined */
export function chordNotehead(notes: readonly { notehead?: string }[]): string | undefined {
  const h = notes[0]?.notehead?.trim();
  return h && h !== "normal" && notes.every((n) => n.notehead?.trim() === h) ? h : undefined;
}

/** 排练号：123 的 `!rehearsal=A!`（也认 `!排练号=A!`）→ `A`；不是排练号返回 undefined。 */
export function rehearsalOf(name: string): string | undefined {
  const m = /^(?:rehearsal|排练号)\s*=\s*(.+)$/i.exec(name);
  return m ? m[1]!.trim() : undefined;
}

/** 排练号自带方头括号（谱面印「【A】」，八段锦）：照原样排字、不再套方框；MusicXML 写 `enclosure="none"` */
export function rehearsalBracketed(text: string): boolean {
  return /^【.+】$/.test(text.trim());
}
