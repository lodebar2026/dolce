// 演唱顺序、断句、试听时间轴、MIDI 的门面：判据在 Rust（crates/dolce-play，经 dolce-wasm），这里只做编解码——
// 把胶水拼好的输入形状（`score/playtypes.ts`、`score/phraseinput.ts`）编成 JSON 过边界，产物里指输入对象的下标认回对象，
// 签名与原 TS 实现（`score/{playorder,phrase,timeline,midi}.ts`，迁移计划 M1 删）相同，调用方不用改。
//
// 认回的口径：
//   - 断句：和弦一律用「拍平下标」（各小节和弦按小节次序首尾相接）；
//   - 时间轴：和弦按对象编号（同一个对象同一个号），光标锚点的 `occ` 也按它数；
//   - 演唱顺序：按 `P:` 排的项共用段落小节表（`scope`），认回成共用的 Set。
// 文中提到的判据函数名（`scoreAt`、`headPenalty`、`computePhraseBreaks` 的局部量……）都在 crates/dolce-play/src/phrase.rs。

import { Fraction } from "../common/fraction";
import { dolce } from "../common/dolce";
import {
  isPlayChord, isTimelineChord, PlayItem,
  type Anchor, type JumpSpec, type PlayJumps, type PlayMeasure, type PlayOptions, type PlayOrder, type PlayPart, type PlaySource,
  type RepeatSpecItem, type SectionMark, type SingPassSpec, type TimedNote, type Timeline, type TimelineChord, type TimelineMeasure,
} from "./playtypes";
import { chordsOf, type PhraseChord, type PhrasePart } from "./phraseinput";

const frac = (f: Fraction): [number, number] => [f.numerator, f.denominator];
const fracOf = (a: [number, number]): Fraction => {
  // 不经构造（构造会再约分）：两边的分子分母原样
  const f = new Fraction(0);
  f.numerator = a[0];
  f.denominator = a[1];
  return f;
};

/** 小节时值的 getter 在没有和弦时抛错：编成 null，Rust 那边取到时照样报错 */
function durationOf(m: { readonly duration: Fraction }): [number, number] | null {
  try {
    return frac(m.duration);
  } catch {
    return null;
  }
}

// ───────────────────────── 演唱顺序 ─────────────────────────

function playMeasureIn(m: PlayMeasure | undefined): object | null {
  if (!m) return null;
  return {
    chords: m.entries.filter(isPlayChord).map((c) => ({
      notes: c.notes.map((n) => ({ tieStart: n.tieStart, tieEnd: n.tieEnd, lyrics: n.lyrics.map((l) => ({ number: l.number, text: l.text ?? null })) })),
      position: frac(c.position),
      slurStart: c.slurStart,
      slurEnds: c.slurEnds,
    })),
    duration: durationOf(m),
    repeatBackward: m.repeatBackward,
    repeatForward: m.repeatForward,
    endingLeft: m.endingLeft,
    endingNum: m.endingNum ? [...m.endingNum] : null,
    endingRight: m.endingRight ?? null,
    barline: m.barline ?? null,
  };
}

const partsIn = (parts: readonly PlayPart[]): string => JSON.stringify(parts.map((p) => ({ measures: p.measures.map(playMeasureIn) })));

const posIn = (t: { mid: number; offset: Fraction }) => ({ mid: t.mid, offset: frac(t.offset) });

function jumpsIn(j: PlayJumps): string {
  return JSON.stringify({
    coda: [...j.coda].map(([k, t]) => [k, posIn(t)]),
    segno: [...j.segno].map(([k, t]) => [k, posIn(t)]),
    jumpTo: [...j.jumpTo].map(([t, v]: [unknown, JumpSpec]) => [posIn(t as { mid: number; offset: Fraction }), { kind: v.kind, value: v.value == null ? null : String(v.value) }]),
  });
}

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

function orderOut(json: string): PlayOrder {
  const o = JSON.parse(json) as { measures: ItemOut[]; isSimple: boolean; hasRepeat: boolean; impliedRepeat: number; scopes: number[][] };
  return { measures: itemsOut(o.measures, o.scopes), isSimple: o.isSimple, hasRepeat: o.hasRepeat, impliedRepeat: o.impliedRepeat };
}

/** 由谱面结构推演唱顺序（反复记号、房号、跳转）。反复与跳转只看 `parts[0]`，歌词段数取各声部最大值。推不了抛错。 */
export function playOrderOf(parts: readonly PlayPart[], jumps: PlayJumps): PlayOrder {
  return orderOut(dolce().playOrderOf(partsIn(parts), jumpsIn(jumps)));
}

/** 按头部 `P:` 排的演唱顺序（ABC §3.1.9）。`seq` 里的段落一个都不存在时返回 null，交回 `playOrderOf`。 */
export function sectionPlayOrder(parts: readonly PlayPart[], jumps: PlayJumps, seq: readonly string[], marks: readonly SectionMark[]): PlayOrder | null {
  const r = dolce().sectionPlayOrder(partsIn(parts), jumpsIn(jumps), JSON.stringify(seq), JSON.stringify(marks.map(({ name, mid, skip }) => ({ name, mid, skip }))));
  return r === "null" ? null : orderOut(r);
}

/** 按逐遍演唱顺序（123 `%%sing`）排：每项是一段直着唱，`pass` 是这一段的第几行词。 */
export function singPlayOrder(parts: readonly PlayPart[], marks: readonly SectionMark[], pages: readonly SingPassSpec[]): PlayItem[] {
  const pg = pages.map((p) => ({
    items: p.items.map((it) => ({ section: it.section, ...(it.verse !== undefined ? { verse: it.verse } : {}), ...(it.lineAfter !== undefined ? { lineAfter: it.lineAfter } : {}) })),
    ...(p.rows !== undefined ? { rows: p.rows } : {}),
  }));
  return itemsOut(JSON.parse(dolce().singPlayOrder(partsIn(parts), JSON.stringify(marks.map(({ name, mid, skip }) => ({ name, mid, skip }))), JSON.stringify(pg))) as ItemOut[]);
}

/** 显式给定的演唱顺序（`.Repeat` 段）。`part0` 用来把 skip 换成小节内位置。 */
export function playOrderFromSpec(repeat: { readonly items: readonly RepeatSpecItem[] }, part0: PlayPart | undefined): PlayItem[] {
  const items = repeat.items.map(({ first, last, verse, skip, page, limit }) => ({ first, last, verse, skip, page, limit }));
  const p0 = part0 ? JSON.stringify({ measures: part0.measures.map(playMeasureIn) }) : "null";
  return itemsOut(JSON.parse(dolce().playOrderFromSpec(JSON.stringify(items), p0)) as ItemOut[]);
}

/** 不推、按段数整曲逐遍（没有反复信息时的退路）。`passes` 为 0 时返回空表。 */
export function playOrderByVerses(measureCount: number, passes: number): PlayItem[] {
  return itemsOut(JSON.parse(dolce().playOrderByVerses(measureCount, passes)) as ItemOut[]);
}

/** 演唱顺序里一遍都没有的小节（下标升序）。 */
export function unplayedMeasures(items: readonly PlayItem[], measureCount: number): number[] {
  return JSON.parse(dolce().unplayedMeasures(JSON.stringify(itemsIn(items, [])), measureCount)) as number[];
}

// ───────────────────────── 试听时间轴、MIDI ─────────────────────────

/** `PlaySource` → 输入 JSON；`chords[k]` 是编号 k 的和弦对象（产物按号认回） */
function sourceIn(src: PlaySource): { json: string; chords: TimelineChord[] } {
  const ident = new Map<TimelineChord, number>();
  const chords: TimelineChord[] = [];
  const chordIn = (c: TimelineChord): object => {
    let k = ident.get(c);
    if (k === undefined) {
      ident.set(c, (k = chords.length));
      chords.push(c);
    }
    return {
      ident: k,
      notes: c.notes.map((n) => ({
        pitch: n.pitch,
        ...(n.tieStop ? { tieStop: true } : {}),
        ...(n.lyrics?.length ? { lyrics: n.lyrics.map((l) => ({ text: l.text, number: l.number, ...(l.refrain ? { refrain: true } : {}), ...(l.extend ? { extend: true } : {}) })) } : {}),
      })),
      rest: c.rest,
      position: frac(c.position),
      ...(c.duration ? { duration: frac(c.duration) } : {}),
      ...(c.velocity !== undefined ? { velocity: c.velocity } : {}),
      ...(c.cursor !== undefined ? { cursor: c.cursor } : {}),
      ...(c.slurStart ? { slurStart: true } : {}),
      ...(c.slurEnds ? { slurEnds: c.slurEnds } : {}),
    };
  };
  const measureIn = (m: TimelineMeasure | undefined): object | null =>
    m
      ? {
          chords: m.entries.filter(isTimelineChord).map(chordIn),
          duration: durationOf(m),
          time: { beats: m.time.beats, beatType: m.time.beatType },
          ...(m.key ? { key: { fifths: m.key.fifths, minor: m.key.minor } } : {}),
        }
      : null;
  const scopes: number[][] = [];
  const json = JSON.stringify({
    parts: src.parts.map((p) => ({ measures: p.measures.map(measureIn), ...(p.name !== undefined ? { name: p.name } : {}) })),
    playData: { measures: itemsIn(src.playData.measures, scopes), tempo: src.playData.tempo, scopes },
    ...(src.lead !== undefined ? { lead: src.lead } : {}),
  });
  return { json, chords };
}

const optsIn = (opts: PlayOptions | undefined): string =>
  opts ? JSON.stringify({ partVolumes: opts.partVolumes, metronome: opts.metronome, speed: opts.speed }) : "null";

/** 按展开的演唱顺序拍平成发声音符、光标锚点、节拍器、拍号调号变化点（试听与 MIDI 共用）。 */
export function buildTimeline(src: PlaySource): Timeline {
  const { json, chords } = sourceIn(src);
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
  return dolce().toMidi(sourceIn(src).json, optsIn(opts), click);
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
