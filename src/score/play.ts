// 演唱顺序、试听、断句、MIDI 的门面：判据在 Rust（crates/dolce-play；由 `ScoreDoc` 拼输入在 crates/dolce-view，经 dolce-wasm），
// 这里只做编解码——`ScoreDoc` 过边界、产物认回 TS 对象（`PlayData` / `PlayItem`、断句输入的和弦对象）。
//
// 认回的口径：
//   - 断句：和弦一律用「拍平下标」（各小节和弦按小节次序首尾相接）；
//   - 时间轴：和弦按 `PlaySource.chords` 的下标（Rust 按出场次序发的号），光标锚点的 `occ` 也按它数；
//   - 演唱顺序：按 `P:` 排的项共用段落小节表（`scope`），认回成共用的 Set。
// 文中提到的判据函数名（`scoreAt`、`headPenalty`、`computePhraseBreaks` 的局部量……）都在 crates/dolce-play/src/phrase.rs。

import { Fraction } from "../common/fraction";
import { dolce } from "../common/dolce";
import type { ElementId, ScoreDoc, Song } from "../model/doc";
import {
  JumpSpec, PlayData, PlayItem, TimePosition,
  type Anchor, type PlayOptions, type PlaySource, type PlaySpecKind, type TimedNote, type Timeline, type TimelineChord,
} from "./playtypes";
import { chordsOf, type PhraseChord, type PhraseMeasure, type PhrasePart } from "./phraseinput";

const frac = (f: Fraction): [number, number] => [f.numerator, f.denominator];
const fracOf = (a: [number, number]): Fraction => {
  // 不经构造（构造会再约分）：两边的分子分母原样
  const f = new Fraction(0);
  f.numerator = a[0];
  f.denominator = a[1];
  return f;
};

// ───────────────────────── 演唱顺序 ─────────────────────────

interface ItemOut {
  mid: number; pass: number; offset: [number, number]; end: number; endOfPass: boolean; skip: number; limit: number; glueFrom: number;
  scope?: number; sectionEntry?: boolean; lineAfter?: boolean; pageRows?: number;
}

/** 产物 → `PlayItem`。`scopes`：段落小节表，同一下标认回同一个 Set */
function itemsOut(items: readonly ItemOut[], scopes: readonly number[][] = []): PlayItem[] {
  const sets = new Map<number, ReadonlySet<number>>();
  return items.map((o) => {
    const p = new PlayItem();
    p.mid = o.mid;
    p.pass = o.pass;
    p.offset = fracOf(o.offset);
    p.end = o.end;
    p.endOfPass = o.endOfPass;
    p.skip = o.skip;
    p.limit = o.limit;
    p.glueFrom = o.glueFrom;
    if (o.scope !== undefined) {
      let s = sets.get(o.scope);
      if (!s) sets.set(o.scope, (s = new Set(scopes[o.scope])));
      p.scope = s;
    }
    if (o.sectionEntry) p.sectionEntry = true;
    if (o.lineAfter) p.lineAfter = true;
    if (o.pageRows !== undefined) p.page = { rows: o.pageRows };
    return p;
  });
}

/** `PlayItem` → 输入（时间轴、未唱小节用）。`scopes` 收集各项的段落小节表（同一个 Set 编同一个号） */
function itemsIn(items: readonly PlayItem[], scopes: number[][]): object[] {
  const ids = new Map<ReadonlySet<number>, number>();
  return items.map((p) => {
    let scope: number | undefined;
    if (p.scope) {
      scope = ids.get(p.scope);
      if (scope === undefined) {
        ids.set(p.scope, (scope = scopes.length));
        scopes.push([...p.scope]);
      }
    }
    return {
      mid: p.mid, pass: p.pass, offset: frac(p.offset), end: p.end, endOfPass: p.endOfPass, skip: p.skip, limit: p.limit, glueFrom: p.glueFrom,
      ...(scope !== undefined ? { scope } : {}),
      ...(p.sectionEntry ? { sectionEntry: true } : {}),
      ...(p.lineAfter ? { lineAfter: true } : {}),
      ...(p.page?.rows ? { pageRows: p.page.rows } : {}),
    };
  });
}

/** 演唱顺序里一遍都没有的小节（下标升序）。 */
export function unplayedMeasures(items: readonly PlayItem[], measureCount: number): number[] {
  return JSON.parse(dolce().unplayedMeasures(JSON.stringify(itemsIn(items, [])), measureCount)) as number[];
}

// ───────────────────────── 由 ScoreDoc 拼（crates/dolce-view）：试听输入、演唱顺序 ─────────────────────────

type PosOut = { mid: number; offset: [number, number] };

/** Rust `PlayData` 的 JSON 形状（`crates/dolce-view/src/playdata.rs`） */
interface PlayDataOut {
  coda: [string, PosOut][];
  segno: [string, PosOut][];
  jumpTo: [PosOut, { kind: PlaySpecKind; value: string | null }][];
  measures: ItemOut[];
  scopes: number[][];
  hasRepeat: boolean;
  isSimpple: boolean;
  impliedRepeat: number;
  fromSections: boolean;
  fromSing: boolean;
  tempo: number;
}

const posOut = (p: PosOut): TimePosition => new TimePosition(p.mid, fracOf(p.offset));

function playDataOut(o: PlayDataOut): PlayData {
  const pd = new PlayData();
  for (const [k, t] of o.coda) pd.coda.set(k, posOut(t));
  for (const [k, t] of o.segno) pd.segno.set(k, posOut(t));
  for (const [t, v] of o.jumpTo) {
    const j = new JumpSpec(v.kind);
    j.value = v.value;
    pd.jumpTo.set(posOut(t), j);
  }
  pd.measures = itemsOut(o.measures, o.scopes);
  pd.hasRepeat = o.hasRepeat;
  pd.isSimpple = o.isSimpple;
  pd.impliedRepeat = o.impliedRepeat;
  pd.fromSections = o.fromSections;
  pd.fromSing = o.fromSing;
  pd.tempo = o.tempo;
  return pd;
}

/** Rust `PlaySource` 的 JSON 形状（只列门面认回要读的） */
interface SourceWire {
  parts: { name?: string; measures: ({ chords: ChordWire[] } | null)[] }[];
  lead?: number;
}
interface ChordWire {
  ident: number;
  id?: ElementId;
  notes: { pitch: number; tieStop?: boolean; lyrics?: { text: string; number: number; refrain?: boolean; extend?: boolean }[] }[];
  rest: boolean;
  position: [number, number];
  duration?: [number, number] | null;
  velocity?: number | null;
  cursor?: boolean | null;
  slurStart?: boolean;
  slurEnds?: number;
}

function sourceOut(r: string): PlaySource | null {
  if (r === "null") return null;
  const o = JSON.parse(r) as { source: SourceWire; playData: PlayDataOut };
  const chords: TimelineChord[] = [];
  for (const p of o.source.parts) {
    for (const m of p.measures) {
      for (const c of m?.chords ?? []) {
        chords[c.ident] = {
          notes: c.notes,
          rest: c.rest,
          position: fracOf(c.position),
          ...(c.duration ? { duration: fracOf(c.duration) } : {}),
          ...(c.id !== undefined ? { id: c.id } : {}),
          ...(c.velocity != null ? { velocity: c.velocity } : {}),
          ...(c.cursor != null ? { cursor: c.cursor } : {}),
          ...(c.slurStart ? { slurStart: true } : {}),
          ...(c.slurEnds ? { slurEnds: c.slurEnds } : {}),
        };
      }
    }
  }
  return {
    json: JSON.stringify(o.source),
    chords,
    playData: playDataOut(o.playData),
    parts: o.source.parts.map((p) => ({ ...(p.name !== undefined && p.name !== null ? { name: p.name } : {}), measureCount: p.measures.length })),
    ...(o.source.lead !== undefined && o.source.lead !== null ? { lead: o.source.lead } : {}),
  };
}

export interface PlaySourceOptions {
  /** 见 `ToScoreOptions.forExpanded`：带歌词的声部当主旋律、同号歌词顺延 */
  forExpanded?: boolean;
}

/** **试听/MIDI 的统一入口**（各格式共用）：MusicXML 形状带全部声部、voice 与力度，简谱形状按排版行视图拼。
 *  这首没有曲行返回 null；推演唱顺序出错抛错。 */
export function playSourceOf(doc: ScoreDoc, songIdx = 0, options: PlaySourceOptions = {}): PlaySource | null {
  return sourceOut(dolce().modelPlaySource(JSON.stringify(doc), songIdx, !!options.forExpanded));
}

/** MusicXML 形状的一首（`melodyOnly`：只取第一声部主分支、和弦取最高音、不带力度——光标跟的旋律档，口径同引擎输入） */
export function playSourceOfDoc(song: Song, options: { melodyOnly?: boolean } = {}): PlaySource {
  return sourceOut(dolce().modelPlaySourceOfDoc(JSON.stringify(song), !!options.melodyOnly))!;
}

/** 简谱形状的演唱顺序（下标是第一份声部——`forExpanded` 时是带歌词的那个——自己的小节序）。这首没有曲行返回 null。 */
export function playDataOfSong(doc: ScoreDoc, songIdx = 0, options: PlaySourceOptions = {}): PlayData | null {
  const r = dolce().modelPlayData(JSON.stringify(doc), songIdx, !!options.forExpanded);
  return r === "null" ? null : playDataOut(JSON.parse(r) as PlayDataOut);
}

// ───────────────────────── 断句输入 ─────────────────────────

/** 断句输入连同和弦 → 元素 id（断点写回文档要按 id 对上） */
export interface PhraseView {
  part: PhrasePart;
  idOf: Map<PhraseChord, ElementId>;
}

interface PhraseChordWire {
  notes: PhraseChord["notes"];
  rest: boolean;
  beats: number;
  beams: number;
  dot: number;
  duration?: [number, number] | null;
  position: [number, number];
  fermata: boolean;
  slurStart: boolean;
  slurEnds: number;
}
interface PhraseWire {
  part: { measures: (Omit<PhraseMeasure, "entries"> & { chords: PhraseChordWire[] })[] };
  ids: (ElementId | null)[];
}

function phraseOut(r: string): PhraseView | null {
  if (r === "null") return null;
  const o = JSON.parse(r) as PhraseWire;
  const idOf = new Map<PhraseChord, ElementId>();
  let k = 0;
  const measures: PhraseMeasure[] = o.part.measures.map(({ chords, ...m }) => ({
    ...m,
    entries: chords.map((c) => {
      const { duration, position, ...rest } = c;
      const ch: PhraseChord = { ...rest, position: fracOf(position), ...(duration ? { duration: fracOf(duration) } : {}) };
      const id = o.ids[k++];
      if (id !== null && id !== undefined) idOf.set(ch, id);
      return ch;
    }),
  }));
  return { part: { measures }, idOf };
}

/** 简谱形状的断句输入（主旋律那一个声部：带歌词的声部优先；口径同引擎输入投影档那一份）。这首没有曲行返回 null。 */
export function phrasePartOfSong(doc: ScoreDoc, songIdx = 0): PhraseView | null {
  return phraseOut(dolce().modelPhrasePart(JSON.stringify(doc), songIdx));
}

/** MusicXML 形状的断句输入（`partIndex` 缺省第一声部）。`distinctLyrics` = 同音同号的词顺延（只试听要）。 */
export function phrasePartOfDoc(song: Song, partIndex = 0, distinctLyrics = false): PhraseView {
  return phraseOut(dolce().modelPhrasePartOfDoc(JSON.stringify(song), partIndex, distinctLyrics))!;
}

/** 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节下标（0 基）。`segno` / `coda` 是跳转的目标、不算。 */
export function phraseJumpMeasures(song: Song, partIndex = 0): Set<number> {
  return new Set(dolce().modelPhraseJumpMeasures(JSON.stringify(song), partIndex));
}

// ───────────────────────── 试听时间轴、MIDI ─────────────────────────

const optsIn = (opts: PlayOptions | undefined): string =>
  opts ? JSON.stringify({ partVolumes: opts.partVolumes, metronome: opts.metronome, speed: opts.speed }) : "null";

/** 按展开的演唱顺序拍平成发声音符、光标锚点、节拍器、拍号调号变化点（试听与 MIDI 共用）。 */
export function buildTimeline(src: PlaySource): Timeline {
  const { json, chords } = src;
  type AnchorOut = Omit<Anchor, "chord"> & { chord: number };
  const o = JSON.parse(dolce().buildTimeline(json)) as Omit<Timeline, "notes" | "anchors" | "allAnchors"> & {
    notes: (Omit<TimedNote, "chord"> & { chord: number })[];
    anchors: AnchorOut[];
    allAnchors: AnchorOut[];
  };
  const anchor = (a: AnchorOut): Anchor => ({ ...a, chord: chords[a.chord]! });
  return {
    signatures: o.signatures,
    notes: o.notes.map((n) => ({ ...n, chord: chords[n.chord]! })),
    anchors: o.anchors.map(anchor),
    allAnchors: o.allAnchors.map(anchor),
    clicks: o.clicks,
    duration: o.duration,
  };
}

/** 谱面 ♩=（0 = 没标，取缺省）× 用户倍率。 */
export function tempoBpm(tempo: number, opts?: PlayOptions): number {
  return dolce().playTempo(tempo, optsIn(opts));
}

/** 实际播放速度 = 谱面 ♩=（无则缺省）× 用户倍率。 */
export function playTempo(src: PlaySource, opts?: PlayOptions): number {
  return tempoBpm(src.playData.tempo, opts);
}

/** 各声部线性音量 [0,1]，没设为 1。 */
export function partGain(opts: PlayOptions | undefined, part: number): number {
  return dolce().partGain(optsIn(opts), part);
}

/** 标准 MIDI 文件（format 1）。`click` = 带节拍器轨（原生音源试听用；导出不传）；导出的各声部轨带轨名与歌词事件。 */
export function toMidi(src: PlaySource, opts?: PlayOptions, click = false): Uint8Array {
  return dolce().toMidi(src.json, optsIn(opts), click);
}

// ───────────────────────── 断句 ─────────────────────────

/**
 * **「一行放不放得下」的真实判据**（`pdflayout/browser.ts::measureChordSpans` 量出来的）。
 *
 * 用户口径：**「不要算格数，真实坐标排一遍，放不下再补刀」**。格数（`LineInfo.cells`）
 * 是近似——同样 30 格，歌词字多的行、带八度点与附点的行都更宽；照它判，排版器会在我们的
 * 断点之外**又折一刀**，而 `scripts/rebuild.mjs` 的容量收敛循环随后把容量越收越小
 * （064《啊！圣善夜》本来 7 行的方案被一路收成 9 行 13 格）。
 *
 * `spans` 与排版器折行用的是同一把尺子（`layout.ts::Line.naturalSpans`），
 * 且**与断点无关**（自然位置在分行之前就算完），所以整首量一次，补刀/合并反复试都能用。
 */
export interface FitMetric {
  /** 版心宽度。 */
  width: number;
  /** 每个和弦的自然横向区间。`x1b`：后面紧跟小节线时含这条线的右缘——引擎折行量到行末小节线，
   *  **只在与版心宽比「放不放得下」时用它**（`fitSpan`），行长匀度、行宽比、过短判据照旧量到音为止（`x1`）。 */
  spans: Map<PhraseChord, { x0: number; x1: number; x1b?: number }>;
}

/**
 * 一个**可落刀的乐句子句断点**（`PhraseBreaks.cuts` 的元素）。断句本身选哪些断点由 DP
 * 做完了，这张表是给**补刀层**看的：「一行排不下、非得在它内部再切一刀」时，
 * 哪些位置有乐句凭据、各值多少分。
 */
export interface CutCandidate {
  /** 在该和弦**之后**断行。 */
  chord: PhraseChord;
  mi: number;
  /** 收在小节线上（写 `measureBreaks`）；否则是行内断点（写 `midBreaks`）。 */
  isLast: boolean;
  /** 断点强度 − 行首罚（`scoreAt` − `headPenalty`），**可以是负的**。 */
  score: number;
  /**
   * 在这里断，**下一行的开头与前面某一行的开头是同一段旋律**吗——是的话公共前缀有多长
   * （`parallelAt`，比到 12 个音封顶）。0 = 不是平行乐句开头。
   *
   * 补刀要看它：原书的分行大量是「平行乐句各自成行、对齐着排」，而强度分里
   * 平行只值 2 分（`scoreAt` 拿它打平局用）。144《求圣灵吹我》两句「求主圣灵向我吹气」
   * 该各自成行、168《爱喜乐生命》后三行该按两句「让主爱…」并成两行，都是这一条。
   */
  parallel: number;
  /**
   * 这里是不是**句末**（`isSentenceEnd` 的口径，不受「短分句减半」影响）。
   *
   * 单独带出来是因为强度分**分不出句号与逗号**：`punctScore` 里两者只差 2 分
   * （6 vs 4），而「很短的分句减半」还会把句号折成 3——168《爱喜乐生命》的
   * 「忧愁不再。」只跟在「心底，」后面四个字，句号被折成 3，输给了「心底，」的 10 分
   * （逗号 4 + 长音 4 + 小节线加分），一整句就被劈到了下一行开头。
   * 补刀这一层要的正是「落在句号上」，所以它在 `pickCuts` 里另有加分。
   */
  end: boolean;
}

export interface PhraseBreaks {
  measureBreaks: Set<number>; // 小节边界换行：在该下标小节前起新行
  midBreaks: Set<PhraseChord>;      // 行内换行：在该和弦（乐句尾休止/长音）之后换行，不加小节线
  /** 段落（Intro/Verse/Chorus/Coda…）起点的小节下标：这些小节前不但换行，还**另起一页**
   *  ——否则主歌与副歌会挤在同一页上。measureBreaks 是其超集。 */
  sectionStarts: Set<number>;
  /** 段界落在小节内部（弧闭合处）时的断点和弦：在该和弦后换行**并另起一页**。midBreaks 是其超集。 */
  sectionCutChords: Set<PhraseChord>;
  /** 是否已为「副歌起点」安排了段界（含弱起顺延）。原 jpscore 据此不再自行在副歌首音处断行。 */
  refrainCut: boolean;
  /**
   * **全部候选断点**（按位置升序，含落在小节中间的那些）。
   *
   * 给**容量补刀**用（`applybreaks.ts::pickCuts`）：断句本身不看纸张，排不下就整首换档，
   * 而换的那个档也得挑个像样的落点——原来它只按格数找最接近的小节线，不看标点、
   * 不看长音、不看行首罚，刀常落在句子中间（全书行首带标点 190 处）。
   *
   * **行内候选一并带出**：乐句的自然子句断点常落在小节中间（弱起谱尤其如此），
   * 原来这里 `if (!isLast) continue` 把它们全丢了，补刀只能在小节线里挑。
   * 落不落在小节线上改由补刀层按权重定（`BAR_END_BONUS`），不再是硬约束。
   */
  cuts: CutCandidate[];
  /** **容量补刀落下的断点**（`applybreaks.ts::applyCapacityCuts` 写，两种键与
   *  `measureBreaks` / `midBreaks` 同义）。断句本身不产生它们——它们是「这一行放不下」
   *  才切出来的。`describeLines` 据此给 `LineInfo.fromCut` 打记号，`scripts/line-check.mjs`
   *  的 D2 据此豁免（拆分导致的弱起不一致不算错误）。 */
  capacityCuts: Set<PhraseChord | number>;
  /** **不许删的断点**（小节下标，语义同 `measureBreaks`）：跳转记号（Fine / D.C. / D.S. /
   *  To Coda）所在的小节末。`measureBreaks` 的子集。后续的并行/补刀（`chooseLineLayout`）
   *  一律绕开它们——记号是给唱的人看路标的，印在一行的中段读不出来。 */
  forced: Set<number>;
}

/** 行长参数。默认值是拿具体曲子调出来的（见上面各常量的注释），**别随手改默认**；
 *  成书排版要更均匀的行长时按需收紧上限（见 scripts/rebuild.mjs）。 */
export interface PhraseOptions {
  targetMeas?: number;
  minMeas?: number;
  maxMeas?: number;
  maxSentenceMeas?: number;
  /** 一行最多几格。**成书排版按纸张宽度算**（版心宽 ÷ 音符步距），
   *  而不是用这里那个按经验定的 25——版心窄的书一行本来就放不下 25 格。 */
  maxCells?: number;
  maxSentenceCells?: number;
  /** 断点强度的权重。调大 = 更看重「断在乐句真正收尾的地方」（长音、延长号、句末标点）。
   *  默认 1 时，断点代价被钳在 0 以上（`max(0, BASE_BREAK − 强度)`），
   *  于是 8 分的强断点和 10 分的更强断点**代价一样**，「更长的音符 + 标点」体现不出优势。
   *  调大之后强断点能挣出净收益（有封顶），乐句收尾处就会压过「各行一样长」。 */
  breakWeight?: number;
  /** 「很短的分句」的字数上限：从上一个标点起唱了这么几个字以内，句末标点的分**减半**
   *  （「哈利路亚！」「阿们！」这类呼语句句带感叹号，与整句同权会主导整个行结构）。
   *  **默认 0 = 关**：编辑器那条路的分行基线是按原权重调出来的；成书排版传 5。 */
  shortSentenceWords?: number;
  /** 重复段边界是否**按重复长度加分**（越长的重复越该整段成行）。默认 false = 一律 +8，
   *  编辑器那条路行为不变；成书排版打开（015《赞美真神》结尾三句「哈利路亚！」）。 */
  repeatLenBonus?: boolean;
  /** `maxCells` 的单位是不是**排版器数出来的「个数」**（音符与增时线各算一个）。
   *  成书那条路的容量由 `measureCellsPerLine` 数出来，就是这个单位；而 `cellsOf` 为了行长目标
   *  把增时线折算成 0.7 格，两把尺子混用会把长音多的行判成「放得下」而实际折行
   *  （378《主耶稣我爱祢》副歌 32 个格、容量 31，折算后只有 28.x）。
   *  **默认 false**：编辑器那条路的 `DEF_MAX_CELLS = 25` 是按折算后的格数调出来的。 */
  cellsAreItems?: boolean;
  /** 「别把一句话的最后一小截甩到下一行开头」的权重（0 = 关）。
   *  419《人生崎岖路》第 6 行开头的「却成了祝福。」——上一行明明还差好几格。
   *  **默认关**：15 首编辑器基线里它会把「至高的爱尽见于刺 / 穿的手」这样的词劈开
   *  （断点被推去了别处），成书那条路才打开。 */
  tailWeight?: number;
  /** **摊匀行长**的权重（0 = 关）。开着时 DP 跑两遍：第一遍定下「这一段要几行」，
   *  第二遍把行长目标改成「本段小节数 ÷ 行数」、行长代价按这个权重加重，
   *  在同样的行数里挑长短最接近的那套断点。默认 0——编辑器那条路的基线是按一遍调出来的；
   *  成书排版打开（原书每一行都差不多长，我们却会一行顶格、一行半幅）。 */
  evenWeight?: number;
  /** 多排一行的代价（`evenWeight > 0` 时的方案评分用）。默认 20。 */
  rowCost?: number;
  /**
   * **「放得下」当平局裁判的容差**（方案评分用，`contentOnly` 那一路才有意义）。默认 0 = 关。
   *
   * 断句层照旧不把容量算进代价（见 `contentOnly`）；这一项只让纸张当**平局的裁判**：
   * 「每行都放得下」的那套方案与最优方案差距在这个数以内，就用前者。
   * 详见 `computePhraseBreaks` 里用到它的那段注释（070《天使歌唱》的 0.85 分之差）。
   */
  fitSlack?: number;
  /** **行数多的方案优先**：与最优方案差在这个数以内就选行数最多的那套（0 = 关）。
   *  内容层的规则，与版心无关——原委见 `computePhraseBreaks` 里用到它的那段注释。 */
  moreRowsSlack?: number;
  /** **平行乐句开头**在断点强度里值多少分（按公共前缀长度折算）。
   *  用户口径：不管成书还是其它歌谱排版，平行句都更优先于标点（逗号 4、句号 6）。默认 8。 */
  parallelScore?: number;
  /**
   * **真实坐标**（`pdflayout/browser.ts::measureChordSpans`）。给了它，「这一套方案放不放得下」
   * 就按真实宽度判（与排版器折行同一把尺子）；没给就退回按格数（`maxCells`）估。
   * 用户口径：不要算格数，真实坐标排一遍。
   */
  fit?: FitMetric;
  /** 「末两行别一长一短」的权重。一段的最后两行长短悬殊最扎眼（125《主名至宝》、
   *  404《你若不压橄榄成渣》都是倒数第二行短、末行长），而普通的行长代价管不到它——
   *  末行本来就允许短。默认 1；0 = 关。 */
  lastPairWeight?: number;
  /** **断句只看内容**（成书那条路开着）。开着时 DP 与方案评分里**一切与纸张有关的分都不算**：
   *  行长目标 `(meas − target)²`（target 由版心容量折算而来）、`maxMeas` 罚、
   *  `MIN_MEAS` / `MIN_CELLS` 那一路「行太稀」的罚、以及「每多排一行 `rowCost` 分」。
   *  版心宽度只剩一个作用：**超容量是硬约束**（排不下的方案不能选）。
   *  抑制「断得太碎」交回 `BASE_BREAK`（每断一次都要付费），抑制「一行太长」交给超容量罚。
   *  **默认 false**：编辑器那条路的 15 首基线是按旧口径调出来的。 */
  contentOnly?: boolean;
  /** 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节下标。这些地方**要高优先级断开**
   *  ——`Fine` 落在主歌多段歌词中间时，不断在那儿的话记号就印在了一行的中段（096）。
   *  它们只存在演唱顺序 `playData` 里，断句输入拿不到，所以由调用方传进来。 */
  jumpMeasures?: Set<number>;
  /** **平行乐句开头**的加分（0 = 关）。一行的头几个音与另一行的头几个音相同时，
   *  把它们排成各自的行首，两行就对齐得上——简谱排版的惯例，也最贴近原谱分行
   *  （070 副歌两行同开头、077 的 `13|5565|`、175 的一二行）。默认 0；成书传 6。 */
  parallelWeight?: number;
  /** **行末收在长音上**的加分（0 = 关；成书传 4，编辑器不开）。一行收在一个长音上，
   *  唱的人有地方换气、看的人一眼看得出乐句到头了——原书的分行大量是这个样子。
   *  与 `parallelWeight` 是一对：那条管「下一行从哪儿起」，这条管「这一行在哪儿收」。
   *  用户口径：「应该通过平行句 + 长音结尾让 4 行赢过 3 行」（061《坚固保障》）。 */
  tailLongWeight?: number;
  /** 行长代价的权重。调大 = 更看重「各行一样长」。
   *  默认 1 是编辑器那条路调出来的；成书要工整的行长，调到 2 以上，
   *  16 小节的歌才会选 4+4+4+4 而不是 4+6+6（后者行长代价 8，但少断一次省 8 分，默认权重下打平）。
   *  **`targetMeas` 由容量折算时要反过来调小**（成书那条路 0.25）：目标行长已经就是版心宽，
   *  行长代价再重就会压过「断在乐句收尾处」，把行末从标点上挪走（实测全书行末收标点 94% → 81%）。 */
  lenWeight?: number;
  /** **一页排几行**（0 = 不管分页；编辑器/PPT 那条路传 4，与 `applybreaks.ts::pageBreakLines`
   *  同一个数）。给了就在第一遍 DP 之后补一道「把末页排满」：整首排下来若剩个半空的页
   *  （001《圣哉，圣哉，圣哉》16 小节排成 4+6+6 三行，而版面装得下 4 行），就照
   *  「行数凑满整页」再排一遍，每行仍不许太稀（`MIN_MEAS` / `MIN_CELLS` 满足其一）。
   *  凑不出合规的方案就维持原判——5 行的曲子不会为了凑 8 行被切碎。 */
  pageLines?: number;
}


function phraseChordIn(c: PhraseChord): object {
  return {
    notes: c.notes.map((n) => ({ number: n.number, jpOctave: n.jpOctave, tieStart: n.tieStart, tieEnd: n.tieEnd, lyrics: n.lyrics.map((l) => ({ text: l.text, number: l.number, refrain: l.refrain })) })),
    rest: c.rest,
    beats: c.beats,
    beams: c.beams,
    dot: c.dot,
    ...(c.duration ? { duration: frac(c.duration) } : {}),
    position: frac(c.position),
    fermata: c.fermata,
    slurStart: c.slurStart,
    slurEnds: c.slurEnds,
  };
}

/** `PhrasePart` → 输入 JSON 与拍平的和弦（产物里的拍平下标按它认回） */
function phrasePartIn(part: PhrasePart): { json: string; flat: PhraseChord[] } {
  const flat: PhraseChord[] = [];
  const measures = part.measures.map((m) => {
    const cs = chordsOf(m);
    flat.push(...cs);
    return {
      chords: cs.map(phraseChordIn),
      barline: m.barline ?? null,
      repeatBackward: m.repeatBackward,
      repeatForward: m.repeatForward,
      keyChange: m.keyChange,
      endingLeft: m.endingLeft,
      endingRight: m.endingRight ?? null,
      sectionMark: m.sectionMark ?? null,
    };
  });
  return { json: JSON.stringify({ measures }), flat };
}

const spanIn = (s: { x0: number; x1: number; x1b?: number } | undefined): object | null =>
  s ? { x0: s.x0, x1: s.x1, ...(s.x1b !== undefined ? { x1b: s.x1b } : {}) } : null;

/** 在小节边界上找乐句断点，凑成不太稀疏也不太密的行长（判据见 crates/dolce-play/src/phrase.rs）。 */
export function computePhraseBreaks(part: PhrasePart, opts: PhraseOptions = {}): PhraseBreaks {
  const { json, flat } = phrasePartIn(part);
  const { fit, jumpMeasures, ...rest } = opts;
  const optIn = {
    ...rest,
    ...(jumpMeasures ? { jumpMeasures: [...jumpMeasures] } : {}),
    ...(fit ? { fit: { width: fit.width, spans: flat.map((c) => spanIn(fit.spans.get(c))) } } : {}),
  };
  const o = JSON.parse(dolce().computePhraseBreaks(json, JSON.stringify(optIn))) as {
    measureBreaks: number[]; midBreaks: number[]; sectionStarts: number[]; sectionCutChords: number[]; refrainCut: boolean; forced: number[];
    cuts: (Omit<CutCandidate, "chord"> & { chord: number })[];
  };
  const at = (k: number): PhraseChord => flat[k]!;
  return {
    measureBreaks: new Set(o.measureBreaks),
    midBreaks: new Set(o.midBreaks.map(at)),
    sectionStarts: new Set(o.sectionStarts),
    sectionCutChords: new Set(o.sectionCutChords.map(at)),
    refrainCut: o.refrainCut,
    cuts: o.cuts.map((c) => ({ ...c, chord: at(c.chord) })),
    capacityCuts: new Set(),
    forced: new Set(o.forced),
  };
}

/**
 * 断句之后那几步的通道（`jianpu/applybreaks.ts` 门面用，判据在 crates/dolce-play/src/applybreaks.rs）：
 * 编输入、调 Rust，再把 Rust 改过的三个集合（`measureBreaks` / `midBreaks` / `capacityCuts`，按 Rust 的插入次序）**原地写回** `breaks`。
 * 回 Rust 的结果与拍平的和弦（结果里的和弦是拍平下标，调用方按 `flat` 认回）。
 */
export function phraseLayoutOp(
  op: string, part: PhrasePart, breaks: PhraseBreaks, opts: Record<string, unknown> & { fit?: FitMetric },
): { out: unknown; flat: PhraseChord[] } {
  const { json, flat } = phrasePartIn(part);
  const idx = new Map<PhraseChord, number>();
  flat.forEach((c, i) => idx.set(c, i));
  const at = (c: PhraseChord): number => {
    const i = idx.get(c);
    if (i === undefined) throw new Error("断点和弦不在断句输入里");
    return i;
  };
  const bIn = {
    measureBreaks: [...breaks.measureBreaks],
    midBreaks: [...breaks.midBreaks].map(at),
    sectionStarts: [...breaks.sectionStarts],
    sectionCutChords: [...breaks.sectionCutChords].map(at),
    refrainCut: breaks.refrainCut,
    cuts: breaks.cuts.map((c) => ({ ...c, chord: at(c.chord) })),
    forced: [...breaks.forced],
    capacityCuts: [...breaks.capacityCuts].map((k) => (typeof k === "number" ? { measure: k } : { chord: at(k) })),
  };
  const { fit, ...rest } = opts;
  const optIn = { ...rest, ...(fit ? { fit: { width: fit.width, spans: flat.map((c) => spanIn(fit.spans.get(c))) } } : {}) };
  const o = JSON.parse(dolce().phraseLayoutOp(op, json, JSON.stringify(bIn), JSON.stringify(optIn))) as {
    out: unknown; breaks: { measureBreaks: number[]; midBreaks: number[]; capacityCuts: ({ measure: number } | { chord: number })[] };
  };
  breaks.measureBreaks.clear();
  for (const v of o.breaks.measureBreaks) breaks.measureBreaks.add(v);
  breaks.midBreaks.clear();
  for (const v of o.breaks.midBreaks) breaks.midBreaks.add(flat[v]!);
  breaks.capacityCuts.clear();
  for (const k of o.breaks.capacityCuts) breaks.capacityCuts.add("measure" in k ? k.measure : flat[k.chord]!);
  return { out: o.out, flat };
}

/** 成书断点写回与段落词的输入（`applybreaks.ts` 门面用）：断句输入 JSON、拍平下标 → 元素 id、断点集合 JSON */
export function phraseBookIn(part: PhrasePart, idOf: ReadonlyMap<PhraseChord, ElementId>, breaks?: PhraseBreaks): { part: string; ids: string; breaks: string } {
  const { json, flat } = phrasePartIn(part);
  const idx = new Map<PhraseChord, number>();
  flat.forEach((c, i) => idx.set(c, i));
  const at = (c: PhraseChord): number => idx.get(c) ?? -1;
  const bIn = breaks ? {
    measureBreaks: [...breaks.measureBreaks],
    midBreaks: [...breaks.midBreaks].map(at),
    sectionStarts: [...breaks.sectionStarts],
    sectionCutChords: [...breaks.sectionCutChords].map(at),
    refrainCut: breaks.refrainCut,
    cuts: [],
    forced: [...breaks.forced],
  } : null;
  return { part: json, ids: JSON.stringify(flat.map((c) => idOf.get(c) ?? null)), breaks: JSON.stringify(bIn) };
}

/** 一行放得下 `cells` 格时，行长目标该定几小节（按本曲实测的每小节格数折算）。 */
export function targetMeasForCells(part: PhrasePart, cells: number): number {
  return dolce().targetMeasForCells(phrasePartIn(part).json, cells);
}

/** 断句的逐和弦事实（和弦是不可变的输入形状，按对象记住） */
const facts = new WeakMap<PhraseChord, [string, number, string]>();
function factsOf(c: PhraseChord): [string, number, string] {
  let f = facts.get(c);
  if (!f) facts.set(c, (f = JSON.parse(dolce().phraseChordFacts(JSON.stringify(phraseChordIn(c)))) as [string, number, string]));
  return f;
}

/** 一个和弦上的「主歌词」（第 1 段或副歌那一条）。断句判据与逐行报告共用同一份取法。 */
export function mainLyricText(c: PhraseChord): string {
  return factsOf(c)[0];
}

/** 一个和弦上各段歌词末尾标点分的中位数（只算有词的段）：句末 6 / 句中 4 / 无 0。 */
export function lyricPunctScore(c: PhraseChord): number {
  return factsOf(c)[1];
}

/** 一行开头的旋律指纹（跳过行首休止后的前几个音；不足返回空串）。两行相同 = 平行乐句开头。 */
export function headFpOf(chords: readonly PhraseChord[]): string {
  return dolce().headFpOf(JSON.stringify(chords.map(phraseChordIn)));
}
