// 双向定位：**源文本偏移 ↔ 谱面元素**。
//
// 代码区的光标移到某个音符上，谱面上那个音符亮起来；点谱面上的音符，代码区光标跳过去。
// 两条方向共用这一份索引。可视化编辑（`editor/visual/`）也读它：选中、方向键导航、删除都按条目走。
//
// ## 为什么在这一层
//
// 索引建在 **`ScoreDoc` 的 `source: SourceSpan`** 上——每个音符、每个歌词音节解析时就记了它在
// 原文里的位置（文本谱经 `fanqie/fromfanqie.ts` 转来时照样带着）。有代码区的四种格式（文本谱、123、ABC、
// `.jpwabc`）共用同一套代码。条目按**元素 id** 认，谱面那一侧（`ScorePainter.entryEl(id)` /
// `lyricEl` / `partEls`）也按 id 取，两路页面树的差别由排版器自己消化。
//
// 建表在 Rust：有原文位置的四种格式走 `crates/dolce-view/src/sync.rs`（随排版行视图一趟出，`docView(doc).sync`），
// `.musicxml` 走 `crates/dolce-model/src/xmlsync.rs`；两路都按推入次序给，排序、音符反查表与查询留在这里。
//
// 这里不碰页面树，只经 App（VisualHost）拿排版器给的 `<g>`，
// 高亮靠加 CSS 类完成，**不重渲染**（沿用编辑器既有判据）。
//
// ## 条目的种类
//
// | kind | 原文 | `id`（谱面上靠哪个音符定位） |
// |---|---|---|
// | `note` | 音符/休止 token | 它自己 |
// | `lyric` | 歌词音节 | 它跟的那个音符 |
// | `sustain` | 增时线 `-` | 宿主音符（`own` 是增时线自己的 id） |
// | `barline` | 小节线 | 小节线前面那个元素 |
// | `mark` | 和弦名、装饰、注记（`AttachedSource`），slur 的 `(` 与 `)` 各一条 | 宿主 / 弧的起点 |
// | `break` | 换行/换页符号 | 符号前面那个元素 |
// | `header` | 页眉字段的值（标题、署名、调号拍号…） | 不用（-1）；模型里不记位置，按格式从原文认（`EditDialect.headerFields`），谱面按字对上（`App._bindHeader`） |
//
// 增时线、小节线、弧现在没有自己的 `<g>`，谱面上借宿主音符的 `<g>` 定位；和弦名、装饰、注记按类名在音符格里认出自己的
// （`App._markPartEl`）。统一 ScorePainter 落地后改接它的 `locate`。
//
// ## `.musicxml` 另一种建法（`buildXml`）
//
// MusicXML 的模型不记原文位置，但编辑器里存的就是 XML 原文，`fromxml.ts` 又把每个模型对象绑在它的原节点上
// （表层，在 Rust：`crates/dolce-model/src/xmlsync.rs`），而原节点记着自己在原文里的区间（`crates/dolce-model/src/xml` 的 `start`/`end`），直接取就是。
// 条目区间是整个元素（`<note>…</note>`），歌词取 `<text>` 里那几个字，
// 小节线取 `</measure>`（MusicXML 里普通小节线没有元素，小节边界就是它），弧取 `<slur type="start">`。
// 选区仍只存一份（代码区选区，只是代码区不显示），撤销还原选区也是代码区自带。

// ## 歌词音节怎么配到音符
//
// 走排版行视图（`jianpu/slots.ts::docView`）：音节配给哪个音符在视图里已经定好（`syllableOwner`），
// 与排版器、简谱输入模型用的是**同一份**，不在这里另算。

import type { AttachedSource, ElementId, ScoreDoc } from "../model/doc";
import { xmlSyncOf } from "../model/xmlsurface";
import { docView } from "../jianpu/slots";

export type SyncKind = "note" | "lyric" | "sustain" | "barline" | "mark" | "break" | "header";

/** 索引里的一条：原文的一段 ↔ 谱面上的一个东西。 */
export interface SyncEntry {
  kind: SyncKind;
  /** 原文区间（0 基字符偏移，`to` 不含） */
  from: number;
  to: number;
  /** 谱面上靠哪个音符定位（见文件头的表） */
  id: ElementId;
  /** 命中的是第几段歌词（0 基）；不是歌词时为 null */
  verse: number | null;
  /** 歌词：原文里的段号（`W2`、`w:` 第 2 行为 2）。一行里缺了某段时与 `verse + 1` 不同 */
  verseNo?: number;
  /** 增时线自己的 id；`mark`：挂在增时线上的记号，那条增时线的 id */
  own?: ElementId;
  /** 增时线是宿主音符的第几条（0 基）：旧简谱引擎那一路的增时线不带 id，按序号在音符格后面数 */
  ord?: number;
  /** `barline`：这条线画在 `id` 那个音符**之前**还是**之后**（对应模型的 `location`）。
   *  小节线没有自己的 id，两个排版器都按「相邻音符 id + edge」索引它的 `<g>` */
  edge?: "before" | "after";
  /** `mark`：挂的是什么（`AttachedSource.kind`，或 slur 的 `"slur"`）与记号名。`.musicxml` 另有延音线 `"tied"`、
   *  `<direction>` 里力度以外的那些 `"dir"`（渐强渐弱、速度、踏板…，`name` 是 `Direction.type`） */
  markKind?: AttachedSource["kind"] | "slur" | "tied" | "dir";
  name?: string;
  /** slur：终点音符（Tab 在起点、终点上都能轮到它） */
  end?: ElementId;
  /** 成对符号的另一半（slur 的 `(` 条目指向 `)`、`)` 条目指向 `(`；另一半没记位置时缺省） */
  pair?: { from: number; to: number };
  /** `break`：换页 */
  page?: boolean;
  /** `.musicxml` 的 `<direction>`（力度、文字、渐强渐弱…）：第几声部第几小节 `directions` 里第几条（模型那一路按它改） */
  dir?: { pi: number; mi: number; index: number };
  /** `<direction>` 挂在小节里最后一个音**之后**（`id` 借那最后一个音）：拖动换算格数时要差一格 */
  dirEnd?: boolean;
  /** `header`：调号、拍号、两样写在一处（`header.ts::HeaderRole`）；文字字段缺省 */
  headerRole?: "key" | "time" | "keytime";
}

/** 一处换行/换页（谱面显示换行符用）。原文里没有符号可指（文本谱另起一行 `Q:`、ABC 的代码行末）时 `span` 为 null。 */
export interface BreakMark {
  page: boolean;
  /** 符号前面那个元素：谱面上换行符画在它右边 */
  after: ElementId;
  span: { from: number; to: number } | null;
}

/** 源文本偏移 ↔ 谱面元素的双向索引。`build` 之后两个方向都是 O(log n) / O(1)。 */
export class SyncIndex {
  /** 按 `from` 升序；同起点时短的在前（歌词音节的区间比曲行短） */
  private entries: SyncEntry[] = [];
  /** 音符 id → 它自己那条（`kind === "note"`） */
  private byNote = new Map<ElementId, SyncEntry>();
  private breakList: BreakMark[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** 从模型重建。文本一变就要重建——偏移全变了。条目在 Rust 随排版行视图一趟建好（`docView(doc).sync`）。 */
  build(doc: ScoreDoc): void {
    this.adopt(docView(doc).sync as { entries: SyncEntry[]; breaks: BreakMark[] });
  }

  /**
   * `.musicxml`：条目的原文区间取原节点记的区间（见文件头）。
   * 原节点不是从这份原文读出来的（区间对不上原文）就不建，返回 false——宁可不能编辑，也不按错位的偏移改。
   */
  buildXml(doc: ScoreDoc, text: string): boolean {
    const r = xmlSyncOf<SyncEntry, BreakMark>(doc, text);
    this.adopt(r ?? { entries: [], breaks: [] });
    return !!r;
  }

  /** 收下 Rust 按推入次序给的条目：音符反查表照推入次序建（同 id 后来的覆盖先来的），再排序。
   *  拷一份再排：`docView` 按文档缓存，同一份文档可能再建一次索引。 */
  private adopt(r: { entries: SyncEntry[]; breaks: BreakMark[] }): void {
    this.byNote.clear();
    for (const e of r.entries) if (e.kind === "note") this.byNote.set(e.id, e);
    this.breakList = r.breaks;
    // **按偏移排序**——`at()` 的二分依赖它。同起点时短的在前。
    this.entries = [...r.entries].sort((a, b) => a.from - b.from || a.to - b.to);
  }

  /** 并进页眉字段（原文里认出来的，见 `EditDialect.headerFields`）。重建索引后调一次。 */
  addHeader(fields: readonly { from: number; to: number; role: "text" | "key" | "time" | "keytime" }[]): void {
    const extra: SyncEntry[] = fields
      .filter((f) => f.to > f.from)
      .map((f) => ({ kind: "header", from: f.from, to: f.to, id: -1, verse: null, ...(f.role !== "text" ? { headerRole: f.role } : {}) }));
    if (extra.length === 0) return;
    this.entries = [...this.entries, ...extra].sort((a, b) => a.from - b.from || a.to - b.to);
  }

  /** 落在这个偏移上的那一条。命中不了返回 null（光标在头部字段、注释、空白里都算不中）。 */
  at(offset: number): SyncEntry | null {
    const es = this.entries;
    // 最后一条 from <= offset 的
    let lo = 0;
    let hi = es.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (es[mid]!.from <= offset) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // 同起点可能有多条（短的在前），往回找一条真正盖住 offset 的
    for (let i = k; i >= 0 && i > k - 8; i--) {
      const e = es[i]!;
      if (offset >= e.from && offset < e.to) return e;
    }
    return null;
  }

  /** 全部条目，**音符条目在前、其余在后**——建「谱面元素 → 条目」的反查表时，
   *  投影档里音符与它的歌词共用一个 `<g>`，增时线与记号也借宿主的 `<g>`，先来的音符条目该占住它。
   *  （`entries` 本身必须保持按偏移排序，那是 `at()` 的二分所依赖的。） */
  all(): SyncEntry[] {
    const rank = (e: SyncEntry): number => (e.kind === "note" ? 0 : e.kind === "lyric" ? 1 : 2);
    return [...this.entries].sort((a, b) => rank(a) - rank(b));
  }

  /** 按原文顺序的全部条目（方向键导航用）。 */
  ordered(): readonly SyncEntry[] {
    return this.entries;
  }

  /** 与 `[from, to)` 有交叠的全部条目（文本框选 → 谱面多处高亮）。 */
  range(from: number, to: number): SyncEntry[] {
    if (to <= from) {
      const one = this.at(from);
      return one ? [one] : [];
    }
    return this.entries.filter((e) => e.from < to && e.to > from);
  }

  /** 一个音符对应的原文区间（谱面 → 文本用）。 */
  spanOfNote(id: ElementId): { from: number; to: number } | null {
    return this.byNote.get(id) ?? null;
  }

  /** 挂在这个音符上的记号条目（和弦名、装饰、注记、从它起或到它止的弧），按原文顺序。 */
  marksOf(id: ElementId): SyncEntry[] {
    const seen = new Set<string>();
    return this.entries.filter((e) => {
      if (e.kind !== "mark" || (e.id !== id && e.end !== id)) return false;
      // 弧的 `(` 与 `)` 算一个记号，只留先出现的那条
      const key = e.pair ? `${Math.min(e.from, e.pair.from)}` : `${e.from}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** 全部换行/换页（含原文里没有符号可指的），谱面按它画换行符。 */
  breaks(): readonly BreakMark[] {
    return this.breakList;
  }
}
