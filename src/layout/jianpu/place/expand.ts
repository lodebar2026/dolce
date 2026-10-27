// 展开档（反复与多段歌词逐遍展开、一遍一页）：按演唱顺序（`PlayItem[]`）把行视图里的小节逐遍切出来，
// 每遍接成一长行、只挂这一遍的歌词，再按版心宽逐行装满（同旧简谱引擎 `layout.ts::Line.doLineBreak`），
// 拼成一份「展开后的」行视图交给 `layoutSong` 照常排——横向、纵向、上方带全是原样档那一套。
//
// 逐遍怎么走（首尾裁切、遍末与往回跳换页）复用 `jianpu/expand.ts::walkPlay`；小节的切法同 `jianpu/phrasesong.ts::buildMeasures`
// （演唱顺序的 `mid` 就是按它数的），只排一个声部：带歌词的那个（同 `songMeasures` 的 `forExpanded`）。
import { walkPlay } from "../../../jianpu/expand";
import { Fraction } from "../../../common/fraction";
import type { PlayItem } from "../../../score/playorder";
import { distinctVerses } from "../../../jianpu/phrasesong";
import type { Measure as DocMeasure } from "../../../model/doc";
import { REFRAIN_WORD_RE, sectionMarkOf } from "../../../model/helpers";
import { elementQuarters, takesLyric, tupletRatios, voiceNumbers, type BarlineElement, type ScoreLine, type LyricLine, type LyricSyllable, type Mark, type MusicElement } from "../../../jianpu/ast";
import type { DocView, PageView, RowView, SongView, SystemView } from "../../../jianpu/slots";
import { contentWidth, type JianpuGrid } from "../metrics";
import type { InkMeasurer } from "./model";
import { naturalColumns } from "./spacing";
import { assignLyrics, layoutVoiceLine } from "./voice";

/** 展开出来的行 → 各符号所在那一遍的遍号（与 `elements` 平行）。绘制端给音符身份标 `pass`（同旧简谱引擎 `fromChord` 的 `lrc`：
 *  是 `PlayItem.pass` 即段号，不是第几遍），播放高亮按它找同一个音在哪一遍那一格 */
export const passesOfRow = new WeakMap<ScoreLine, readonly number[]>();

/** 行视图里的一个符号：第几行（展开声部的行序）、行内下标 */
interface Slot {
  row: number;
  idx: number;
}

/**
 * 展开声部的小节切片：第 k 小节由哪几行的哪些下标组成（可跨行）。切法同 `buildMeasures`：
 * 小节从小节线之后的第一个音起，小节线、其后到下一个音之前的符号都归前一小节；曲首 `|:` 等音前的符号归第一小节。
 */
export function measureSlices(rows: readonly RowView[]): Slot[][] {
  const out: Slot[][] = [];
  let cur: Slot[] | null = null;
  let pending: Slot[] = [];
  let needNew = true;
  rows.forEach((row, r) => {
    row.elements.forEach((el, idx) => {
      const s = { row: r, idx };
      if (el.kind === "note") {
        if (needNew || cur === null) {
          cur = [...pending];
          pending = [];
          out.push(cur);
        }
        needNew = false;
        cur.push(s);
        return;
      }
      if (el.kind === "barline") needNew = true;
      if (cur === null) pending.push(s);
      else (cur as Slot[]).push(s);
    });
  });
  return out;
}

/** 一遍：按次序的符号、各符号所属的歌词遍号；`breaks`：源里的换行 / 换页落在第几个符号之前（true = 换页） */
interface Pass {
  slots: Slot[];
  verses: number[];
  breaks: Map<number, boolean>;
  /** 往回跳（同一段词）处必断的行：落在第几个符号之前 */
  hard?: Set<number>;
  /** 不许在它前面换行的符号（落在第几个符号之前；「阿们」结尾整段接在末行） */
  glue?: Set<number>;
}

/**
 * 源里的换行：每行（末行除外）收尾处断，行是源里一页的末行就换页（`[fenye]`，同 `pageEnds`）。返回「这个符号之后断」→ 是否换页。
 * 断在哪：`exact(r)` 的行断在行末那个符号之后（同 `jianpuinput.ts` 的 `breakAfterChord`），其余断在行末所在那个小节的末尾
 * （同 `rowsPart` 的 `breakAtMeasureEnd`，行在小节中间结束就断在小节末）。小节被 `limit` 截掉尾巴时，断点随尾巴一起不要（同 `Line.load`）。
 */
function sourceBreaks(
  slices: readonly Slot[][], rows: readonly RowView[], pageEndRows: ReadonlySet<number>, exact: (r: number) => boolean,
): Map<string, boolean> {
  const measureOf = new Map<string, number>();
  slices.forEach((sl, k) => { for (const s of sl) measureOf.set(`${s.row}:${s.idx}`, k); });
  const out = new Map<string, boolean>();
  rows.forEach((row, r) => {
    if (r === rows.length - 1 || row.elements.length === 0) return;
    let key = `${r}:${row.elements.length - 1}`;
    if (!exact(r)) {
      const sl = slices[measureOf.get(key) ?? -1];
      const last = sl?.[sl.length - 1];
      if (!last) return;
      key = `${last.row}:${last.idx}`;
    }
    out.set(key, (out.get(key) ?? false) || pageEndRows.has(r));
  });
  return out;
}

/** 一个小节在这一遍里取哪些符号：`skip` 去掉开头几个音（连同其前的符号），`limit` 只留前几个音（截断处不要小节线）；
 *  临时伴奏 / 并排块不画（旧简谱引擎展开档的投影也跳过它） */
function cutSlots(slots: readonly Slot[], rows: readonly RowView[], cut: { skip: number; limit: number }): Slot[] {
  const isNote = (s: Slot): boolean => rows[s.row]!.elements[s.idx]!.kind === "note";
  let out = [...slots];
  if (cut.skip > 0) {
    let n = 0;
    const at = out.findIndex((s) => isNote(s) && n++ === cut.skip);
    out = at < 0 ? [] : out.slice(at);
  }
  if (cut.limit >= 0) {
    let n = 0;
    const at = out.findIndex((s) => isNote(s) && n++ === cut.limit);
    if (at >= 0) out = out.slice(0, at);
  }
  return out.filter((s) => rows[s.row]!.elements[s.idx]!.kind !== "inline-layer");
}

/** 按演唱顺序逐遍取符号。`skip` 去掉小节开头几个音（连同其前的符号），`limit` 只留前几个音（截断处不要小节线）。 */
function passesOf(
  slices: readonly Slot[][], rows: readonly RowView[], plan: readonly PlayItem[], breaks: ReadonlyMap<string, boolean>,
): Pass[] {
  const passes: Pass[] = [];
  let cur: Pass | null = null;
  walkPlay(plan, {
    measure: (mid, pass, cut) => {
      const slots = cutSlots(slices[mid] ?? [], rows, cut);
      if (slots.length === 0) return;
      cur ??= { slots: [], verses: [], breaks: new Map() };
      if (cur.slots.length === 0) passes.push(cur);
      if (cut.glue && cur.slots.length > 0) {
        cur.glue ??= new Set();
        for (let k = 0; k < slots.length; k++) cur.glue.add(cur.slots.length + k);
      }
      for (const s of slots) {
        cur.slots.push(s);
        cur.verses.push(pass);
        const br = breaks.get(`${s.row}:${s.idx}`);
        if (br !== undefined) cur.breaks.set(cur.slots.length, br);
      }
    },
    passEnd: () => {
      cur = null;
    },
    jumpBack: () => {
      if (cur) (cur.hard ??= new Set()).add(cur.slots.length);
    },
  });
  return passes;
}

/** 一条跨符号的记号（跨行的续接段已连成一条），起止落在哪个符号上 */
interface LogicalMark {
  mark: Mark;
  start: Slot;
  end: Slot;
}

/** 展开声部各行的记号连成整条（跨行的弧按 `continuationToNext` / `continuationFromPrevious` 接起来）。房号不要（展开档不画房号）。 */
function logicalMarks(rows: readonly RowView[]): LogicalMark[] {
  const out: LogicalMark[] = [];
  const open = new Map<Mark["type"], LogicalMark[]>();
  rows.forEach((row, r) => {
    for (const mk of row.marks) {
      if (mk.type === "volta" || mk.type === "crescendo" || mk.type === "decrescendo") continue;
      let lm: LogicalMark | undefined;
      if (mk.continuationFromPrevious) lm = open.get(mk.type)?.shift();
      if (lm) lm.end = { row: r, idx: mk.end };
      else {
        lm = { mark: mk, start: { row: r, idx: mk.start }, end: { row: r, idx: mk.end } };
        out.push(lm);
      }
      if (mk.continuationToNext) (open.get(mk.type) ?? open.set(mk.type, []).get(mk.type)!).push(lm);
    }
  });
  return out;
}

/**
 * 展开档只要旋律与词（投影片）：和弦、段落词、奏法、力度/术语、小节线上的跳转字与 segno、松叶、临时伴奏都不画，
 * 延长记号与倚音留着（倚音用户定保留；同旧简谱引擎展开档的投影 `jianpuinput.ts::rowsPart`），上 / 下滑音也留着（用户定）。换下来的符号记同一个 id。
 */
function bare(el: MusicElement): MusicElement {
  if (el.kind === "note") {
    const ornaments = el.ornaments.filter((o) => o.name === "yc" || o.name === "ycy" || o.name === "shy" || o.name === "xhy");
    if (!el.chord && !el.annotation && ornaments.length === el.ornaments.length) return el;
    return { ...el, ornaments, chord: undefined, annotation: undefined };
  }
  if (el.kind === "sustain") {
    if (!el.chord && !el.annotation && el.ornaments.length === 0) return el;
    return { ...el, ornaments: [], chord: undefined, annotation: undefined };
  }
  if (el.kind === "barline" && el.ornaments.length > 0) return { ...el, ornaments: [] };
  return el;
}

/** 字前的印刷段号（MusicXML 把 `1.` 与字并成一个音节 `1.圣`）去掉：一遍只挂一段词，段号没有意义（同旧简谱引擎 `ignoreVerseNumber`）。
 *  换下来的音节记同一个归属（`DocView.syllableOwner`） */
function bareSyllable(syl: LyricSyllable, owners: Map<LyricSyllable, unknown>): LyricSyllable {
  const m = /^[0-9.]+/.exec(syl.text);
  if (!m || m[0].length === syl.text.length) return syl;
  const out = { ...syl, text: syl.text.slice(m[0].length) };
  const owner = owners.get(syl);
  if (owner !== undefined) owners.set(out, owner);
  return out;
}

/** 唱了不止一遍的小节（反复确实展开了）就不画反复记号：反复线画成普通线（同 `Line.load` 的 `unrolled`） */
function plainBarline(el: BarlineElement): BarlineElement {
  const repeat = el.type === "repeat-start" || el.type === "repeat-end" || el.type === "repeat-both";
  if (!repeat && !el.repeatForwardAfter) return el;
  return { ...el, type: repeat ? "normal" : el.type, repeatForwardAfter: false };
}

/** 第 `v` 段整首最后一个字落在哪（源行序、行内第几个字）；按 `lyricsOf` 缓存 */
const verseEnds = new WeakMap<readonly (readonly LyricLine[])[], Map<number, [number, number]>>();

/** (`row`, `k`) 这一格在第 `v` 段整首最后一个字之后（这一段的词唱完了） */
function afterVerseEnd(lyricsOf: readonly (readonly LyricLine[])[], v: number, row: number, k: number): boolean {
  let ends = verseEnds.get(lyricsOf);
  if (!ends) verseEnds.set(lyricsOf, (ends = new Map()));
  let end = ends.get(v);
  if (!end) {
    end = [-1, -1];
    lyricsOf.forEach((lines, r) => {
      const l = lines.find((x) => x.verseFrom <= v && v <= x.verseTo);
      l?.syllables.forEach((x, i) => { if (x.text) end = [r, i]; });
    });
    ends.set(v, end);
  }
  return row > end[0] || (row === end[0] && k > end[1]);
}

/** 一遍里的符号区间 [a, b) 拼成一行行视图：记号截到行内（跨行的标续接），歌词只挂这一遍的那一行 */
function rowOf(
  pass: Pass, a: number, b: number, rows: readonly RowView[], lyricsOf: readonly (readonly LyricLine[])[],
  cursorOf: readonly (readonly number[])[], marks: readonly LogicalMark[], posOf: ReadonlyMap<string, readonly number[]>,
  unrolled: boolean, idOf: Map<MusicElement, unknown>, owners: Map<LyricSyllable, unknown>,
  bars: { plain: boolean; finalAt: number },
): RowView {
  const first = rows[pass.slots[a]!.row]!;
  const elements: MusicElement[] = [];
  const refs: RowView["refs"] = [];
  // 同一个符号在这一行里出现第二次（`.Layout` 把各遍接成一长串、遍内反复两次）要另给一个对象：
  // 排版按 `elements.indexOf` 认下标，同一对象会落回第一次那一格
  const used = new Set<MusicElement>();
  for (let i = a; i < b; i++) {
    const s = pass.slots[i]!;
    const src = rows[s.row]!;
    const orig = src.elements[s.idx]!;
    let el = bare(orig);
    if (used.has(el)) el = { ...el };
    used.add(el);
    if (unrolled && el.kind === "barline") el = plainBarline(el);
    // 小节线的样式（同旧简谱引擎）：`.jpwabc` 不认样式、一律细线，只有整首最后一条画终止线；
    // 其余格式照源，整首最后一条是细线的也补成终止线（`Barline` 的 `final`）
    if (el.kind === "barline") {
      const repeat = el.type.startsWith("repeat");
      let type = el.type;
      if (bars.plain && !repeat && type !== "invisible") type = "normal";
      // 终止线只画在整首最后（用户定 2026-10-14）：D.C. 前、曲中 `|]` 唱到半路的都画成细线
      if (type === "end" && i !== bars.finalAt) type = "normal";
      if (i === bars.finalAt && type === "normal") type = "end";
      // 唱完这里就跳走（往回跳的同一遍、一遍的末尾）：原谱跳转处的双线展开后接的是别处，画成细线（250 D.S. 前的 `||`）
      if (type === "double" && (pass.hard?.has(i + 1) || (i === pass.slots.length - 1 && bars.finalAt < 0))) type = "normal";
      if (type !== el.type) el = { ...el, type };
    }
    if (el !== orig) {
      const id = idOf.get(orig);
      if (id !== undefined) idOf.set(el, id);
    }
    elements.push(el);
    refs.push(src.refs[s.idx]!);
  }
  const outMarks: Mark[] = [];
  // 同一个符号在这一遍里出现几次（`.Layout` 把各遍接成一长串、遍内反复）：每次出现各画一份，终点取起点之后最近的那次
  for (const lm of marks) {
    const ends = posOf.get(`${lm.end.row}:${lm.end.idx}`) ?? [];
    for (const s of posOf.get(`${lm.start.row}:${lm.start.idx}`) ?? []) {
      const e = ends.find((x) => x >= s);
      if (e === undefined) continue;
      if (e < a || s >= b) continue;
      outMarks.push({
        ...lm.mark,
        start: Math.max(s, a) - a,
        end: Math.min(e, b - 1) - a,
        continuationFromPrevious: s < a,
        continuationToNext: e >= b,
      });
    }
  }
  // 这一遍的歌词：各符号取它那一行里段号区间罩住本遍遍号的那行词（同 `NoteEntry.addLyric` 的 number === pass）
  const syllables: LyricSyllable[] = [];
  let any = false;
  for (let i = a; i < b; i++) {
    const s = pass.slots[i]!;
    const el = rows[s.row]!.elements[s.idx]!;
    if (!takesLyric(el)) continue;
    const v = pass.verses[i]!;
    const k = cursorOf[s.row]![s.idx]!;
    const own = lyricsOf[s.row]!.find((l) => l.verseFrom <= v && v <= l.verseTo);
    // 这一段的词已经唱完（整首里这一段最后一个字之后：副歌只在第 1 段写了，190《凡愿意者可来》、395《十架归路》、
    // 020《向主歌唱》第 2 段「庆贺。」之后的哈利路亚）：借最前面在这一格写了字的那一段。段中间用 `/` 留空的拖腔格后面还有字，不借
    const done = afterVerseEnd(lyricsOf, v, s.row, k);
    const line = !done ? own : lyricsOf[s.row]!.find((l) => !!l.syllables[k]?.text) ?? own;
    const syl = line?.syllables[k];
    if (syl && syl.text) any = true;
    syllables.push(syl ? bareSyllable(syl, owners) : { text: "", source: first.source });
  }
  const lyrics: LyricLine[] = any
    ? [{ verseFrom: pass.verses[a]!, verseTo: pass.verses[a]!, annotationGap: 20, syllables, source: first.source }]
    : [];
  const row: RowView = { ...first, elements, refs, marks: outMarks, lyrics };
  passesOfRow.set(row, pass.verses.slice(a, b));
  return row;
}

/**
 * 逐行装满（同 `Line.doLineBreak`）：按自然宽（紧排 + 歌词避让，不两端对齐）往行里收，放不下就退回到本行最后一条小节线之后断
 * （`‖:` 断在它前面）；本行一条小节线都没有才在小节中间断。只剩小节线的行并回上一行。返回各行在这一遍里的起点。
 */
export function fillLines(
  row: ScoreLine, forced: ReadonlyMap<number, boolean>, m: JianpuGrid, ink: InkMeasurer, width: number,
  meter: SongView["metadata"]["meters"][number] | undefined,
  /** 必断的行（往回跳处）；`skipShort`：源里的换行会留下不到三分之一宽的短行就不照断（跳进源行中间、接着就碰上源换行，094） */
  opts: { hard?: ReadonlySet<number>; skipShort?: boolean; glue?: ReadonlySet<number> } = {},
): Array<{ start: number; page: boolean }> {
  const laid = layoutVoiceLine(row, m, { meter });
  for (const it of laid.items) it.syllables = new Array(row.lyrics.length).fill(null);
  assignLyrics(laid.items, row.lyrics);
  const nat = naturalColumns([laid], m, ink);
  const items = laid.items;
  // 源里的换行落在第几个占位符号之前（元素下标 → 占位序号：落在它后面第一个占位符号上）
  const forcedAt = new Map<number, boolean>();
  for (const [at, page] of forced) {
    const k = items.findIndex((it) => it.srcIndex >= at);
    if (k > 0) forcedAt.set(k, (forcedAt.get(k) ?? false) || page);
  }
  const hardAt = new Set<number>();
  for (const at of opts.hard ?? []) {
    const k = items.findIndex((it) => it.srcIndex >= at);
    if (k > 0) hardAt.add(k);
  }
  const glueAt = new Set<number>();
  for (const at of opts.glue ?? []) {
    const k = items.findIndex((it) => it.srcIndex >= at);
    if (k > 0) glueAt.add(k);
  }
  const starts: number[] = [0];
  const pageAt = new Set<number>();
  let i = 0;
  while (i < items.length) {
    const left = nat.leftOf.get(items[i]!) ?? 0;
    let last = i;
    while (last < items.length) {
      if (last > i && hardAt.has(last)) break;
      if (last > i && forcedAt.has(last) && !glueAt.has(last)) {
        const page = forcedAt.get(last)!;
        const short = (nat.rightOf.get(items[last - 1]!) ?? 0) - left < width / 3;
        if (page || !opts.skipShort || !short) {
          if (page) pageAt.add(last);
          break;
        }
      }
      const r = nat.rightOf.get(items[last]!) ?? 0;
      if (r - left < width || last === i) {
        last++;
        continue;
      }
      for (let k = last; k > i + 1; k--) {
        const bar = items[k - 1]!.element;
        if (bar.kind !== "barline" || !items.slice(i, k - 1).some((it) => it.element.kind === "note")) continue;
        const brk = bar.type === "repeat-start" ? k - 1 : k;
        if (glueAt.has(brk)) continue;
        last = brk;
        break;
      }
      break;
    }
    if (last < items.length) starts.push(last);
    i = last;
  }
  // 行首按符号算的下标 → 元素下标：行首之前不占位的符号（`~`、内联层）跟着下一行
  const at = starts.map((k, n) => ({ start: n === 0 ? 0 : items[k - 1]!.srcIndex + 1, page: pageAt.has(k) }));
  // 只剩小节线的行并回上一行
  const out: Array<{ start: number; page: boolean }> = [];
  at.forEach((s, n) => {
    const e = at[n + 1]?.start ?? row.elements.length;
    const hasNote = row.elements.slice(s.start, e).some((el) => el.kind === "note");
    if (n === 0 || hasNote) out.push(s);
  });
  return out;
}

/** 展开档每页最多几行（没有 `.Layout` 时；用户定 2026-10-14） */
const MAX_ROWS = 4;

/** 把一遍的各行按页分：源里已定的换页之间每段最多 `MAX_ROWS` 行；要断时优先断在副歌起头那行之前（至少留两行），
 *  没有就按行数均分（5 行分 3 + 2，不分 4 + 1）。就地改 `page`。 */
function pageByRows(lines: Array<{ start: number; page: boolean }>, refrainAt: (n: number) => boolean): void {
  let s = 0;
  while (s < lines.length) {
    let e = s + 1;
    while (e < lines.length && !lines[e]!.page) e++;
    let a = s;
    while (e - a > MAX_ROWS) {
      let b = -1;
      // 副歌前换页：前后两页都至少 2 行（爱是不保留 5 行原先断成 4 + 1）
      for (let k = Math.min(a + MAX_ROWS, e - 2); k >= a + 2; k--) if (refrainAt(k)) { b = k; break; }
      if (b < 0) {
        const pages = Math.ceil((e - a) / MAX_ROWS);
        b = a + Math.ceil((e - a) / pages);
      }
      lines[b]!.page = true;
      a = b;
    }
    s = e;
  }
}

/** `.Layout` 的 `BreakPoints = …`：时值串（`|` 分页、`.` 或空格分行，`{x}` 那一段不排），累计时值 → 0 丢弃 / 1 换行 / 2 换页（同 `Layout.parseBreakDur`） */
function parseBreakDur(s: string): Map<string, number> {
  const res = new Map<string, number>();
  let last = new Fraction(0);
  for (const pg of s.replace(/\|/g, "\n").replace(/\./g, " ").split("\n")) {
    if (pg.length === 0) continue;
    for (const it of pg.split(" ")) {
      let str = it.trim();
      if (!str) continue;
      let v = 1;
      if (str.includes("{")) {
        v = 0;
        str = str.replace(/[{}]/g, "");
      }
      last = last.plus(Fraction.fromString(str));
      res.set(last.toString(), v);
    }
    res.set(last.toString(), 2);
  }
  return res;
}

/** `.Layout` 描述 → 断点表（同 `Layout.durationInfo`）：`LinesPerPage = a|b|…` 把整首时值均分成各行；一遍一遍平铺时（`passes`）按全曲时值逐遍复制 */
function durationInfo(desc: string, total: Fraction, passes: number | null): Map<string, number> {
  const info = new Map<string, number>();
  const at = desc.indexOf("=");
  const body = (at < 0 ? desc : desc.slice(at + 1)).trim();
  if (desc.includes("LinesPerPage")) {
    const arr = body.split("|").map((x) => parseInt(x, 10));
    const dur = total.divInt(arr.reduce((a, b) => a + b, 0));
    let pos = new Fraction(0);
    for (const n of arr) {
      for (let i = 0; i < n; i++) {
        pos = pos.plus(dur);
        info.set(pos.toString(), i === n - 1 ? 2 : 1);
      }
    }
  } else for (const [k, v] of parseBreakDur(body)) info.set(k, v);
  if (passes !== null) {
    const keys = [...info.keys()];
    for (let i = 1; i < passes; i++) for (const k of keys) info.set(Fraction.fromString(k).plus(total.timesInt(i)).toString(), info.get(k)!);
  }
  return info;
}

/**
 * `.Layout` 分页描述（`.jpwabc`）：源里的换行与遍末换页都不认，整个演唱顺序接成一长串，按时值插换行 / 换页、丢掉 `{}` 那几段
 * （同 `Layout.buildLine` 给了 `dur` 的那条路与 `breakByDur`）。断点只落在音符上、同一时刻只断一次。
 */
function passesByDur(
  slices: readonly Slot[][], rows: readonly RowView[], plan: readonly PlayItem[], desc: string, simple: boolean,
): Pass[] {
  const all: Pass = { slots: [], verses: [], breaks: new Map() };
  walkPlay(plan, {
    measure: (mid, pass, cut) => {
      for (const s of cutSlots(slices[mid] ?? [], rows, cut)) {
        all.slots.push(s);
        all.verses.push(pass);
      }
    },
    passEnd: () => {},
  });
  // 时值：四分音符为 1，多连音按比例（同旧简谱引擎 `layoutTimes`）
  const ratios = rows.map((r) => tupletRatios(r));
  const dur = (s: Slot): Fraction => {
    const el = rows[s.row]!.elements[s.idx]!;
    const q = elementQuarters(el);
    const t = ratios[s.row]![s.idx];
    return t ? q.timesInt(t.num).divInt(t.den) : q;
  };
  let total = new Fraction(0);
  for (const sl of slices) for (const s of sl) total = total.plus(dur(s));
  const info0 = durationInfo(desc, total, simple ? plan.length : null);
  // 时值断点之后一拍以内就是源里的换行（`$`）的，断在源换行上：JP-Word 记的时值常比源换行早半拍到一拍
  //（048《创造奇功》31 对 32、156《一百只羊有九十九》11 对 12、32.5 对 33），照记的断会把行末那个音挤到下一行行首
  const srcBreaks: Fraction[] = [];
  {
    let t = new Fraction(0);
    all.slots.forEach((s, i) => {
      if (i > 0 && s.row !== all.slots[i - 1]!.row) srcBreaks.push(t);
      t = t.plus(dur(s));
    });
  }
  const one = new Fraction(1);
  const info = new Map<string, number>();
  for (const [k, v] of info0) {
    const at = Fraction.fromString(k);
    const snap = srcBreaks.find((b) => b.compareTo(at) > 0 && b.minus(at).compareTo(one) <= 0);
    const key = (snap ?? at).toString();
    info.set(key, Math.max(info.get(key) ?? 0, v));
  }
  const out: Pass = { slots: [], verses: [], breaks: new Map() };
  let tick = new Fraction(0);
  let lineBeg = 0;
  let lastTick: string | null = null;
  all.slots.forEach((s, i) => {
    const el = rows[s.row]!.elements[s.idx]!;
    const key = tick.toString();
    if (el.kind === "note" && key !== lastTick && info.has(key)) {
      if (info.get(key) === 0) {
        out.slots.length = lineBeg;
        out.verses.length = lineBeg;
      } else {
        out.breaks.set(out.slots.length, info.get(key) === 2);
        lineBeg = out.slots.length;
      }
      lastTick = key;
    }
    out.slots.push(s);
    out.verses.push(all.verses[i]!);
    tick = tick.plus(dur(s));
  });
  return out.slots.length ? [out] : [];
}

/** 展开档：一首曲子 → 逐遍展开、逐行装满的行视图（每遍一页起头） */
export function expandSong(
  song: SongView, plan: readonly PlayItem[], m: JianpuGrid, ink: InkMeasurer, idOf: Map<MusicElement, unknown>,
  owners: Map<LyricSyllable, unknown>,
  layout: { desc: string; simple: boolean } | null = null,
  /** 源里的换行断在行末那个符号之后（`.jpwabc`），否则断在那个小节末 */
  exactBreaks = false,
  /** 源里一行就是谱面一行（文本谱的 `Q:` 行）：行在小节中间收尾也是写明的换行，原位断 */
  rowIsLine = false,
): SongView {
  // 只排一个声部：带歌词的那个（同 `playsong.ts::songMeasures` 的 forExpanded），没有就第一个
  const voices = voiceNumbers(song);
  const rowsOfVoice = (v: number): RowView[] => song.pages.flatMap((p) => p.groups.flatMap((g) => g.voices.filter((r) => r.voice === v)));
  const lead = voices.find((v) => rowsOfVoice(v).some((r) => r.lyrics.length > 0)) ?? voices[0]!;
  const rows = rowsOfVoice(lead);
  const lyricsOf = rows.map((r) => distinctVerses(r.lyrics));
  const cursorOf = rows.map((r) => {
    let n = 0;
    return r.elements.map((el) => (takesLyric(el) ? n++ : -1));
  });
  const slices = measureSlices(rows);
  // 源里一页的末行：该处的换行写成换页。文本谱的 `[fenye]` 已分进行视图的页（同 `jianpuinput.ts::pageEnds`）
  const pageEndRows = new Set<number>();
  {
    let r = 0;
    song.pages.forEach((pg, pi) => {
      for (const g of pg.groups) for (const v of g.voices) if (v.voice === lead) r++;
      if (pi < song.pages.length - 1 && r > 0) pageEndRows.add(r - 1);
    });
  }
  // `.jpwabc` 的换页记在模型上（同 `jianpuInputOfJpw`）：小节中间换页是行末那个和弦（或它的增时线）的 `lineBreakAfter`，
  // 小节处换页是下一行首小节的 `print.newPage`
  if (exactBreaks) {
    rows.forEach((row, r) => {
      const next = rows[r + 1];
      if (!next) return;
      const chord = [...row.refs].reverse().find((ref) => ref.chord)?.chord;
      const inline = chord && (chord.lineBreakAfter === "page" || (chord.sustains ?? []).some((su) => su.lineBreakAfter === "page"));
      const head = next.measures[0];
      const atMeasure = head !== undefined && head !== row.refs[row.refs.length - 1]?.measure && head.print?.newPage === true;
      if (inline || atMeasure) pageEndRows.add(r);
    });
  }
  // 行在小节中间收尾的：`.jpwabc` 与文本谱（一行 `Q:` 就是谱面一行）一律原位断；其余格式只在源文写明了小节中间换行
  //（行末那个和弦带 `lineBreakAfter`，123/ABC 小节中间的 `$`、按乐句重排写回的断点）时原位断，否则顺延到小节末
  const inlineEnd = (r: number): boolean => {
    const chord = [...rows[r]!.refs].reverse().find((ref) => ref.chord)?.chord;
    return !!chord && (chord.lineBreakAfter !== undefined || (chord.sustains ?? []).some((su) => su.lineBreakAfter !== undefined));
  };
  const breaks = sourceBreaks(slices, rows, pageEndRows, (r) => exactBreaks || rowIsLine || inlineEnd(r));
  const marks = logicalMarks(rows);
  const seen = new Set<number>();
  let unrolled = false;
  for (const it of plan) for (let mid = it.mid; mid < it.end; mid++) {
    if (seen.has(mid)) unrolled = true;
    seen.add(mid);
  }
  const width = contentWidth(m);
  const meter = song.metadata.meters[0];
  // 副歌起头的小节：这一小节起只剩一行词、前面有字的小节不止一行（250《主，差遣我》），在它前面断行、换页。
  // 标了副歌的（模型小节上的段落标记 `sectionMarkOf`，各格式同一个判据：123 的 `"^Chorus"`、文本谱的「(副歌)」、
  // MusicXML 的段落词）**只当大致位置**：标记常挂在副歌弱起上、甚至上一句收尾的那个小节里（「脚步」的【Chorus】
  // 标在「路。求给我」那一小节），逐音去认弱起不稳——换页落在离它最近的行首（源里的行首、按乐句重排后就是乐句起头），
  // 即标记小节或下一小节里起头的第一行（`refrainMark`）；源里那附近没有行首的才照旧在标记小节前断行
  const slotKey = (sl: Slot): string => `${sl.row}:${sl.idx}`;
  const measureOf = new Map<string, number>();
  slices.forEach((sl, k) => { for (const x of sl) measureOf.set(slotKey(x), k); });
  const refrainStart = new Set<number>();
  const refrainMark = new Set<number>();
  {
    // 源里各行起头落在哪个小节（行的第一个符号所在的那一小节）
    const rowStartMeasures = new Set<number>();
    const seenRow = new Set<number>();
    slices.forEach((sl, k) => { for (const x of sl) if (!seenRow.has(x.row)) { seenRow.add(x.row); rowStartMeasures.add(k); } });
    let prevLines = 0;
    const seenMeasure = new Set<DocMeasure>();
    slices.forEach((sl, k) => {
      const withText = new Set<LyricLine>();
      let marked = false;
      for (const x of sl) {
        const ref = rows[x.row]!.refs[x.idx];
        if (ref && !seenMeasure.has(ref.measure)) {
          seenMeasure.add(ref.measure);
          if (REFRAIN_WORD_RE.test(sectionMarkOf(ref.measure) ?? "")) {
            if (rowStartMeasures.has(k) || rowStartMeasures.has(k + 1)) refrainMark.add(k);
            else marked = true;
          }
        }
        const c = cursorOf[x.row]![x.idx]!;
        if (c >= 0) for (const l of lyricsOf[x.row]!) if (l.syllables[c]?.text) withText.add(l);
      }
      if (marked || (withText.size === 1 && prevLines > 1)) refrainStart.add(k);
      if (withText.size > 0) prevLines = withText.size;
    });
  }
  const pages: PageView[] = [];
  let system = 0;
  const passes = layout ? passesByDur(slices, rows, plan, layout.desc, layout.simple) : passesOf(slices, rows, plan, breaks);
  // 整首最后一条小节线（末遍末个符号是小节线时）：画终止线
  const lastPass = passes[passes.length - 1];
  const bars = (pass: Pass): { plain: boolean; finalAt: number } => {
    const end = pass.slots.length - 1;
    const tail = pass === lastPass ? pass.slots[end] : undefined;
    return { plain: exactBreaks, finalAt: tail && rows[tail.row]!.elements[tail.idx]!.kind === "barline" ? end : -1 };
  };
  for (const pass of passes) {
    const posOf = new Map<string, number[]>();
    pass.slots.forEach((s, i) => {
      const k = `${s.row}:${s.idx}`;
      const list = posOf.get(k);
      if (list) list.push(i);
      else posOf.set(k, [i]);
    });
    // 副歌起头也换行（短行照样不断），换页才有地方落在副歌前
    if (!layout) {
      let prev = -1;
      pass.slots.forEach((sl, i) => {
        const k = measureOf.get(slotKey(sl)) ?? -1;
        if (i > 0 && k !== prev && refrainStart.has(k) && !pass.breaks.has(i)) pass.breaks.set(i, false);
        prev = k;
      });
    }
    const whole = rowOf(pass, 0, pass.slots.length, rows, lyricsOf, cursorOf, marks, posOf, unrolled, idOf, owners, bars(pass));
    const lines = fillLines(whole, pass.breaks, m, ink, width, meter, { hard: pass.hard, skipShort: !layout, glue: pass.glue });
    // 没有 `.Layout` 的：一页最多 4 行，优先在副歌起头处换页，否则按行数均分（不留一页一行）
    if (!layout) {
      const startMeasure = (n: number): number => measureOf.get(slotKey(pass.slots[lines[n]!.start]!)) ?? -1;
      const markHeads = new Set<number>();
      for (const k of refrainMark) {
        const n = lines.findIndex((_, n) => startMeasure(n) >= k);
        if (n > 0 && startMeasure(n) <= k + 1) markHeads.add(n);
      }
      pageByRows(lines, (n) => markHeads.has(n) || refrainStart.has(startMeasure(n)));
    }
    // 一遍一页起头；遍内源里的换页另起一页
    let groups: SystemView[] = [];
    lines.forEach((l, n) => {
      if (l.page && groups.length > 0) {
        pages.push({ index: pages.length, groups });
        groups = [];
      }
      const end = lines[n + 1]?.start ?? pass.slots.length;
      groups.push({
        index: groups.length,
        texts: [],
        system: system++,
        voices: [rowOf(pass, l.start, end, rows, lyricsOf, cursorOf, marks, posOf, unrolled, idOf, owners, bars(pass))],
      });
    });
    if (groups.length > 0) pages.push({ index: pages.length, groups });
  }
  return { ...song, pages };
}

/** 整份文档的展开档行视图（各首各按自己的演唱顺序逐首排；推不出演唱顺序的那首照原样） */
export function expandView(
  view: DocView, plans: readonly ({ measures: readonly PlayItem[]; isSimpple: boolean } | null)[], m: JianpuGrid, ink: InkMeasurer,
  /** `.jpwabc` 的 `.Layout` 分页描述（只管第一首） */
  breakDesc: string | null = null,
): DocView {
  const idOf = view.idOf as Map<MusicElement, unknown>;
  const owners = view.syllableOwner as Map<LyricSyllable, unknown>;
  const songs = view.songs.map((song, i) => {
    const pd = plans[i];
    if (!pd) return song;
    const layout = breakDesc && i === 0 ? { desc: breakDesc, simple: pd.isSimpple } : null;
    return expandSong(song, pd.measures, m, ink, idOf, owners, layout, view.doc.sourceFormat === "jpwabc", view.doc.sourceFormat === "fanqie");
  });
  return { ...view, songs };
}
