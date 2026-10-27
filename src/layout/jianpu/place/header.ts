// 页眉定位：标题、副标题、经文、词曲、TL/TR、XL/XR、调号拍号行、`J:` 速度文字。compose/header.ts 只照它画。
//
// 排法照 500 首的成书页眉：标题居中，副标题、经文跟在标题下面居中；
// 词曲署名逐行右对齐、紧接在标题块下面；**调号拍号在左、与最后一行署名同基线**（成书观感）。
// 窄纸装不下最宽那一行时标题、署名整块等比缩（同 `bookHead` 的 k）。
import type { Metadata, Meter } from "../../../jianpu/ast";
import type { JianpuGrid } from "../metrics";
import type { Rect } from "../../../common/geom";

/** 页眉各行的角色（字体与字号由绘制端定，`compose/header.ts::headerRoleFont`） */
export type HeaderTextRole = "title" | "subtitle" | "scripture" | "credit" | "top" | "index" | "tempo"
  // 展开档的标题页与页脚（`placeTitlePage` / `placeSlideFooter`）：字体沿用歌词字（同旧简谱引擎 `titlePage` / `addFooters`），标题不加粗
  | "slide-title" | "slide-subtitle" | "slide-scripture" | "slide-credit" | "slide-footer";

/** 页眉量具（`compose/index.ts` 注入）：角色字的字面宽与墨迹盒（相对落笔原点、基线 y = 0）；调号拍号行的墨迹上下缘 */
export interface HeaderMeasurer {
  headerText(str: string, role: HeaderTextRole): { advance: number; ink: Rect };
  /** 调号拍号行相对其基线的墨迹上下缘，`eqMid` 是「=」墨迹的竖直中心（拍号分数线对准它） */
  keyLine(meter: Meter | undefined): { top: number; bottom: number; eqMid: number };
}

export interface PlacedHeaderLine {
  role: HeaderTextRole;
  text: string;
  /** 横向锚点：`left` = system 左缘，`center` = 页面中线，`right` = 版心右缘（长图收窄页宽，锚点由绘制端按实际页宽给） */
  anchor: "left" | "center" | "right";
  /** 相对锚点的落笔 x（居中 = −宽/2，右对齐 = −宽） */
  dx: number;
  baseline: number;
}

export interface PlacedHeader {
  lines: PlacedHeaderLine[];
  /** 标题、副标题、经文、署名的字号倍率（窄纸缩排，见上） */
  scale: number;
  /** 调号拍号行的基线（调号从 system 左缘起） */
  keyBaseline: number;
  /** 拍号分数线相对 keyBaseline 的偏移（对准「=」的墨迹中心，补回半个线宽） */
  meterDy: number;
  /** 页首的**墨迹底**；正文首组墨迹顶离它空一行（place/song.ts::layoutSong） */
  bottom: number;
}

/** 拍号分数线粗细（`time-sig-rule`；0 = 与减时线同粗）。 */
export function timeSigRule(m: JianpuGrid): number {
  return m.style.stroke.timeSigRule || m.style.stroke.beam;
}

/** `TL:` / `TR:` 去掉开头的空行：左右两块顶部对齐（用户定；《圣哉三一歌》TR 前两行留空是为了底对齐，不照它） */
function topLines(lines: readonly string[]): readonly string[] {
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  return lines.slice(i);
}

/** 词曲署名逐行：一条署名里换了行（MusicXML `<creator>` 常把「作词：…\n作曲：…」写成一条）照原样分行，不并成一行 */
function authorLines(meta: Metadata): string[] {
  return meta.authors.flatMap((a) => a.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

export function placeHeader(meta: Metadata, m: JianpuGrid, ink: HeaderMeasurer): PlacedHeader {
  const hs = m.style.header;
  const lh = m.head.creditLineHeight;
  const lines: PlacedHeaderLine[] = [];
  const authors = authorLines(meta);
  const scripture = meta.scripture ?? [];

  // 窄纸缩排：标题、副标题、经文、署名里最宽那一行比版心宽，整块按比例缩；够宽时 k = 1、一点不动
  const avail = Math.max(1, m.page.width - m.page.margin.left - m.page.margin.right);
  let need = 0;
  meta.titles.forEach((t, i) => { need = Math.max(need, ink.headerText(t, i === 0 ? "title" : "subtitle").advance); });
  for (const t of scripture) need = Math.max(need, ink.headerText(t, "scripture").advance);
  for (const t of authors) need = Math.max(need, ink.headerText(t, "credit").advance);
  const k = need > avail ? avail / need : 1;
  const measure = (str: string, role: HeaderTextRole) => {
    const r = ink.headerText(str, role);
    const s = role === "title" || role === "subtitle" || role === "scripture" || role === "credit" ? k : 1;
    return { advance: r.advance * s, top: r.ink.top * s, bottom: r.ink.bottom * s };
  };

  // 标题、副标题、题下经文：居中。经文接在最后一行标题下面，行距同副标题（没有标题就从标题那一行起）
  const titleSize = hs.title.size * k;
  const subSize = hs.subtitle.size * k;
  let titleInkBottom = 0;
  const centred = (text: string, role: HeaderTextRole, baseline: number): void => {
    const r = measure(text, role);
    lines.push({ role, text, anchor: "center", dx: -r.advance / 2, baseline });
    titleInkBottom = Math.max(titleInkBottom, baseline + r.bottom);
  };
  let y = m.head.titleBaseline;
  meta.titles.forEach((t, i) => {
    y = m.head.titleBaseline + (i === 0 ? 0 : titleSize * 0.2 + i * (subSize * 1.35));
    centred(t, i === 0 ? "title" : "subtitle", y);
  });
  const scrSize = (hs.scripture.size ?? hs.subtitle.size) * k;
  if (meta.titles.length === 1) y += titleSize * 0.2;
  else if (meta.titles.length === 0) y = m.head.titleBaseline - scrSize * 1.35;
  for (const t of scripture) {
    y += scrSize * 1.35;
    centred(t, "scripture", y);
  }
  const hasTitleBlock = meta.titles.length + scripture.length > 0;

  // 左右文字块：右列 `TR:` 在上、词曲署名接在下面，逐行右对齐；左块 `TL:` 与右列顶部对齐。
  // 紧接在标题块下面（同 bookHead 的署名），没有标题块时落在 creditBaseline
  const blockTop = hasTitleBlock ? y + lh : m.head.creditBaseline;
  const tl = topLines(meta.topLeft);
  const tr = topLines(meta.topRight);
  const right = [...tr.map((t) => ({ t, role: "top" as const })), ...authors.map((t) => ({ t, role: "credit" as const }))];
  let blockBottom = 0;
  right.forEach(({ t, role }, i) => {
    if (!t) return;
    const r = measure(t, role);
    lines.push({ role, text: t, anchor: "right", dx: -r.advance, baseline: blockTop + i * lh });
    blockBottom = Math.max(blockBottom, blockTop + i * lh + r.bottom);
  });
  tl.forEach((t, i) => {
    if (!t) return;
    lines.push({ role: "top", text: t, anchor: "left", dx: 0, baseline: blockTop + i * lh });
    blockBottom = Math.max(blockBottom, blockTop + i * lh + measure(t, "top").bottom);
  });

  // 调号拍号行：与右列最后一行同基线（成书：调号拍号与末行署名齐）；左边有 `TL:` 块时排在它下方。
  // 两样都没有时贴着标题：标题墨迹底 → 调号拍号墨迹顶只空**一行**（歌词字高；用户口径：离标题近一点）
  const key = ink.keyLine(meta.meters[0]);
  let keyY: number;
  if (right.length > 0 || tl.length > 0) {
    keyY = -Infinity;
    if (right.length > 0) keyY = blockTop + (right.length - 1) * lh;
    if (tl.length > 0) keyY = Math.max(keyY, blockTop + tl.length * lh + m.style.size.keyMeter * 0.6);
    // 只有一行署名时调号拍号（上下叠的拍号顶得高）别顶上标题：至少空半行
    if (hasTitleBlock) keyY = Math.max(keyY, titleInkBottom + m.style.size.lyric * 0.5 - key.top);
  } else if (hasTitleBlock) {
    keyY = titleInkBottom + m.style.size.lyric - key.top;
  } else {
    keyY = m.head.keyMeterBaseline;
  }
  let keyBottom = keyY + key.bottom;

  // `J:` 里的文字部分（「深情地」「高亢、自由地」）排在调号拍号**下一行**，左对齐；文本谱的数字部分是播放速度，不印
  // 别的来源的速度数字（`♩=144`，`Metadata.tempoMark`）排在这一行最前面
  const tempoWords = [...(meta.tempoMark ? [meta.tempoMark] : []), ...meta.tempos.filter((t): t is string => typeof t === "string" && t !== "")];
  if (tempoWords.length > 0) {
    const text = tempoWords.join(" ");
    const baseline = keyY + m.style.size.keyMeter * 1.55;
    lines.push({ role: "tempo", text, anchor: "left", dx: 0, baseline });
    keyBottom = baseline + m.style.size.keyMeter * 0.85 * 0.15;
  }

  // 序号：左上对齐 system 左缘、右上对齐版心右缘，与标题同基线
  if (meta.indexLeft) lines.push({ role: "index", text: meta.indexLeft, anchor: "left", dx: 0, baseline: m.head.titleBaseline });
  if (meta.indexRight) {
    const r = measure(meta.indexRight, "index");
    lines.push({ role: "index", text: meta.indexRight, anchor: "right", dx: -r.advance, baseline: m.head.titleBaseline });
  }

  // 只报页首的**墨迹底**；「空一行」由 layout 量到首组真正的墨迹顶（和弦、W: 文字行、弧线都算），
  // 见 place/song.ts::layoutSong 的 firstTop（小兔子乖乖的「引子」贴上了拍号）
  return {
    lines,
    scale: k,
    keyBaseline: keyY,
    meterDy: key.eqMid + timeSigRule(m) / 2,
    bottom: Math.max(titleInkBottom, blockBottom, keyBottom),
  };
}

/**
 * 展开档的标题页：标题 → 副标题 → 经文 → 词曲逐行居中，
 * 首行基线在页高 0.3 处，往下每行下移本行的字号。
 */
export function placeTitlePage(meta: Metadata, m: JianpuGrid, ink: HeaderMeasurer): PlacedHeaderLine[] {
  const hs = m.style.header;
  const items: Array<{ text: string; role: HeaderTextRole; size: number }> = [];
  meta.titles.forEach((t, i) => items.push(i === 0 ? { text: t, role: "slide-title", size: hs.title.size } : { text: t, role: "slide-subtitle", size: hs.subtitle.size }));
  for (const t of meta.scripture ?? []) items.push({ text: t, role: "slide-scripture", size: hs.scripture.size ?? hs.subtitle.size });
  for (const t of authorLines(meta)) items.push({ text: t, role: "slide-credit", size: hs.credit.size });
  let y = m.page.height * 0.3;
  return items.map(({ text, role, size }) => {
    const line: PlacedHeaderLine = { role, text, anchor: "center", dx: -ink.headerText(text, role).advance / 2, baseline: y };
    y += size;
    return line;
  });
}

/**
 * 展开档每个谱页的页脚（同旧简谱引擎 `addFooters`）：曲名在版心里居中，「i/n」页码左缘落在 左边距 + 0.8 × 纸宽、
 * 放不下时收回到版心右缘以内；基线在下边距的一半处。`x` 以页面左缘为原点（锚点 left = 0）。
 */
export function placeSlideFooter(title: string, page: number, pages: number, m: JianpuGrid, ink: HeaderMeasurer): PlacedHeaderLine[] {
  const { width, height, margin } = m.page;
  const y = height - margin.bottom * 0.5;
  const out: PlacedHeaderLine[] = [];
  if (title) {
    const w = ink.headerText(title, "slide-footer").advance;
    out.push({ role: "slide-footer", text: title, anchor: "left", dx: margin.left + (width - margin.left - margin.right - w) / 2, baseline: y });
  }
  const no = `${page}/${pages}`;
  const w = ink.headerText(no, "slide-footer").advance;
  out.push({ role: "slide-footer", text: no, anchor: "left", dx: Math.min(margin.left + 0.8 * width, width - margin.right - w), baseline: y });
  return out;
}
