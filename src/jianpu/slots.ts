// `ScoreDoc` → **排版行视图**：文本谱排版器、简谱输入模型（展开档）、双向定位共用的那一份铺排。
//
// ## 为什么要有这一层
//
// 文本谱「原样」档不自动断行：一个系统就是一行，行内按符号逐个步进、记号按行内区间画。
// 所以排版必须先把 `ScoreDoc`（声部 → 小节 → 元素，id 配对）**线性化成一行一行的符号流**——
// 这是排版的事，不是模型的事，任何记谱排版器都要做这一步。以前这一步混在文本谱 AST 里
// （`FanqieDoc` 本身就是扁平流），现在 `ScoreDoc` 是唯一语义模型，线性化规则就收在这里，**只写一次**：
//
// - 行内顺序：夹层（`before`）→ 主音 / 承接前音的增时线 → 各增时线（带各自夹层）→ 有样式的右小节线（带夹层）→ 行末夹层；
//   倚音折进宿主音符；左小节线不出现（它的信息由前一小节右线与房号承载）。
// - 行里每个符号都带 `refs[i]`：它的 `ElementId` 与引用的 `ScoreDoc` 对象。播放高亮、双向定位一律按 id 认。
// - 跨行记号按行切段（续接标记、续行 level）、房号由 `Barline.ending` 还原成行内区间、歌词按行级版式铺回。
//
// 视图里符号的形状沿用 `jianpu/ast.ts` 的元素类型（排版器与导出的几何代码按这些字段写成，原样复用），
// 但**入口只收 `ScoreDoc`**。`scripts/fanqie-scoredoc-check.mjs` 把视图与解析器的语法树（`parseFanqieAst`）
// 逐字段比对（含曲行/歌词行/文字行的原文区间，乐句重排靠它们改写原文），证明这份铺排对全语料文本谱无损。
//
// `dialect` 缺省填 `"shige"` 只是为了让下游取到一份印刷观感的度量（内置表 `style/books/original-shige.ss`），
// **不表示 123 是诗歌本方言**。

import type {
  BarlineElement,
  BarlineType,
  InlineLayerElement,
  LyricLine as FanqieLyricLine,
  LyricSyllable,
  Mark as FanqieMark,
  Metadata,
  MusicElement,
  NoteElement,
  Ornament,
  FanqieSong,
  ScoreLine,
  ScorePage,
  StackedNote,
  SustainElement,
  VoiceGroup,
} from "./ast";
import { getMeta } from "../model/metakeys";
import { projectForJianpu } from "../model/jianpuproject";
import { chordNotehead, decoKey, noteheadOf, tremoloStrokes } from "../model/deconames";
import { directionMarks, leadTempo } from "../model/directionmarks";
import { compressMultiRests } from "../model/multirest";
import { keySpelling, noteHeight, quarterTempos, topNote } from "../model/jianpu";
import { hasInnerVoice, innerLayerMeasures, lanesOf } from "../model/innervoice";
import { songFifths, tonicSpelling } from "../model/keyshift";
import type {
  Barline,
  Chord,
  ElementId,
  InlineItem,
  LyricLineInfo,
  Mark,
  Measure,
  Note,
  Part,
  ScoreDoc,
  SourceOrnament,
  Song,
  SourceSpan,
  Space,
  Sustain,
} from "../model/doc";

const ZERO: SourceSpan = { line: 0, column: 0, offset: 0, length: 0 };

/** 小节线样式 + 反复 → `FanqieDoc` 的 BarlineType。 */
function fanqieBarlineType(b: Barline): BarlineType {
  if (b.repeat === "forward") return "repeat-start";
  if (b.repeat === "backward") return b.alsoForward ? "repeat-both" : "repeat-end";
  switch (b.style) {
    case "none": return b.noWidth ? "hidden" : "invisible";
    case "light-light": return "double";
    case "light-heavy": return "end";
    case "heavy-light": return "double";
    case "dotted": return "hidden";
    default: return "normal";
  }
}

const fanqieOrnaments = (os: readonly SourceOrnament[] | undefined): Ornament[] =>
  (os ?? []).map((o) => ({ name: o.name, level: o.level, source: ZERO }));

/** 和弦上的记号：有原名就照原名（文本谱来源），否则由语义投影推（123 / MusicXML 来源）。
 *  123 的记号几种记法都认（`!staccato!` `!dy!` `!顿音!`），按 `deconames.ts` 归一成字形表的短名；认不出的原样留着。 */
function chordOrnaments(ch: Chord): Ornament[] {
  if (ch.ornaments) return fanqieOrnaments(ch.ornaments);
  const out: Ornament[] = [];
  const add = (name: string): void => {
    if (!out.some((o) => o.name === name)) out.push({ name, level: 0, source: ZERO });
  };
  if (ch.notations?.fermata) add("yc");
  if (ch.notations?.arpeggiate) add("arp");
  for (const a of ch.notations?.articulations ?? []) if (!noteheadOf(a)) add(decoKey(a) ?? a);
  // MusicXML / 识别来源的波音、颤音挂在 ornaments 上（`inverted-mordent`），以前简谱里不画
  for (const o of ch.notations?.ornaments ?? []) { const k = decoKey(o); if (k) add(k); }
  // 弓法（`<up-bow>`）与单音震音（123 的 `!///!` 在 articulations 里，归成 `trem3`）
  for (const tk of ch.notations?.technical ?? []) { const k = decoKey(tk); if (k) add(k); }
  const strokes = ch.notations?.tremolo ?? (ch.notations?.articulations ?? []).map(tremoloStrokes).find((n) => n !== undefined);
  if (strokes) {
    for (let i = out.length - 1; i >= 0; i--) if (tremoloStrokes(out[i]!.name) !== undefined) out.splice(i, 1);
    add(`trem${strokes}`);
  }
  return out;
}

const GRACE_DURATION: Readonly<Record<string, number>> = { eighth: 8, "16th": 16, "32nd": 32 };

/** 和弦里要叠印的几个音的唱名，自下而上；画小的上方装饰音（`cue`）不算，同一个音写两遍的只算一个。 */
function chordDegrees(ch: Chord): NonNullable<Note["degree"]>[] {
  const normal = ch.notes.filter((n) => n.typeSize !== "cue");
  const pool = (normal.length > 0 ? normal : ch.notes).filter((n) => n.degree && n.degree.number >= 1 && n.degree.number <= 7);
  const out: NonNullable<Note["degree"]>[] = [];
  for (const n of [...pool].sort((a, b) => noteHeight(a) - noteHeight(b))) {
    const d = n.degree!;
    const prev = out[out.length - 1];
    if (prev && prev.number === d.number && prev.octaveShift === d.octaveShift && prev.accidental === d.accidental) continue;
    out.push(d);
  }
  return out;
}

/** 一个和弦 → 文本谱音符（主音或倚音）。 */
function noteOf(ch: Chord, graceBefore: NoteElement[]): NoteElement {
  // 和音（123 `[13]`、MusicXML 和弦、民乐分谱的双音）：最低的音当本音，其余自下而上叠在它上面；倚音只印最高音
  // 叉形、圈叉符头（打击乐写在某个音高上的击打）：简谱照节奏音符印 `X`
  const head = chordNotehead(ch.notes) ?? (ch.notations?.articulations ?? []).map(noteheadOf).find((h) => h !== undefined);
  const rhythm = ch.rhythm || (!ch.rest && (head === "x" || head === "circle-x" || head === "cross"));
  const stacked = ch.grace || ch.rest || rhythm ? [] : chordDegrees(ch);
  const deg = stacked.length > 1 ? stacked[0] : topNote(ch)?.degree;
  const beams = ch.beams?.length;
  const n: NoteElement = {
    kind: "note",
    // 节奏音符在 `FanqieDoc` 里是 pitch 9 + sound "rhythm"（番茄写 `9`、诗歌本写 `X`）
    pitch: (rhythm ? 9 : ch.rest ? 0 : (deg?.number ?? 0)) as NoteElement["pitch"],
    sound: rhythm ? "rhythm" : ch.rest ? "rest" : "note",
    hidden: ch.printObject === false,
    // 倚音不占对位格；123 来源的倚音没有这一位
    lyricAnchor: ch.lyricAnchor ?? (ch.grace ? false : !ch.rest),
    octave: rhythm ? 0 : deg?.octaveShift ?? ch.rest?.octaveShift ?? 0,
    // 123 的倚音不记 beams，减时线记在符号时值上（`{2__}` 是十六分）；没写的按八分画
    duration: beams === undefined && ch.grace ? GRACE_DURATION[ch.duration.type ?? ""] ?? 8 : 4 << (beams ?? 0),
    dots: ch.duration.dots,
    ornaments: chordOrnaments(ch),
    graceBefore,
    graceAfter: [],
    code: "",
    source: ch.source ?? ZERO,
  };
  if (deg?.accidental && !rhythm) n.accidental = deg.accidental;
  // 同时敲的几个节奏音符（`[X@E5X@F5]`、打击乐谱的 `<unpitched>` 和弦）：几个 `X` 照和音上下叠
  if (rhythm && !ch.grace && ch.notes.length > 1) n.stack = ch.notes.slice(1).map(() => ({ pitch: 9 as const, octave: 0 }));
  if (stacked.length > 1) {
    n.stack = stacked.slice(1).map((d) => ({
      pitch: d.number as StackedNote["pitch"],
      octave: d.octaveShift,
      ...(d.accidental ? { accidental: d.accidental } : {}),
    }));
  }
  if (ch.placeholder) n.placeholder = true;
  if (ch.harmony?.text !== undefined) n.chord = ch.harmony.text;
  if (ch.sectionWord !== undefined) n.annotation = ch.sectionWord;
  return n;
}

function sustainOf(src: {
  harmony?: Chord["harmony"];
  sectionWord?: string;
  ornaments?: SourceOrnament[];
  lyricAnchor?: boolean;
  source?: SourceSpan;
}): SustainElement {
  const s: SustainElement = {
    kind: "sustain",
    duration: 4,
    lyricAnchor: src.lyricAnchor ?? false,
    ornaments: fanqieOrnaments(src.ornaments),
    code: "-",
    source: src.source ?? ZERO,
  };
  if (src.harmony?.text !== undefined) s.chord = src.harmony.text;
  if (src.sectionWord !== undefined) s.annotation = src.sectionWord;
  return s;
}

type Anchor = Chord | Sustain | Space;

/** 行里一个符号的来源。 */
export interface SlotRef {
  /** 元素 id（音符和弦、承接增时线的和弦、增时线、`Space`）；小节线与夹层没有 */
  id?: ElementId;
  chord?: Chord;
  space?: Space;
  sustain?: Sustain;
  barline?: Barline;
  measure: Measure;
}

/** 把一段小节铺成扁平元素流时要带出去的东西。 */
interface RowBuild {
  elements: MusicElement[];
  /** 与 `elements` 平行 */
  refs: SlotRef[];
  /** 元素 id → 行内下标。`FanqieDoc` 的 Mark 用下标区间配对 */
  indexOf: Map<ElementId, number>;
  /** 参与对位的元素（按顺序），歌词按它铺 */
  anchors: Anchor[];
  /** 小节 → [首元素下标, 末元素下标（含右小节线）] */
  measureSpan: Map<Measure, { first: number; last: number }>;
  /** 小节 direction 里的渐强渐弱起止（MusicXML 来源；配成 Mark 见 `directionWedgeMarks`） */
  wedges: { edge: "start" | "stop"; type?: "crescendo" | "diminuendo"; id: ElementId }[];
}

function pushInline(row: RowBuild, items: readonly InlineItem[] | undefined, measure: Measure): void {
  for (const it of items ?? []) {
    row.refs.push({ measure });
    if (it.kind === "boundary") {
      row.elements.push({
        kind: "beat-boundary",
        behavior: it.behavior,
        code: it.behavior === "join" ? "~" : "^",
        source: it.source ?? ZERO,
      });
    } else {
      const sub = buildRow(it.measures);
      row.elements.push({
        kind: "inline-layer",
        role: it.role,
        elements: sub.elements,
        marks: [...segmentMarks(it.marks, [sub], 0), ...rowVoltas([it.measures], [sub])[0]!],
        code: "",
        source: it.source ?? ZERO,
      });
    }
  }
}

/** 同一谱表上的第二声部：连续几个带第二声部的小节并成一个并排块（下行），推在第一个小节的头上。
 *  不满小节的补不可见休止，好让下行与主行按拍位一列列对齐；块内的弧、连音只收两端都在块里的。 */
function innerVoiceLayer(run: readonly Measure[], marks: readonly Mark[], nextId: () => ElementId): InlineLayerElement {
  const sub = innerLayerMeasures(run, nextId);
  const b = buildRow(sub);
  const own = marks.filter((mk) => b.indexOf.has(mk.start) && b.indexOf.has(mk.end));
  return {
    kind: "inline-layer",
    role: "voice",
    below: true,
    elements: b.elements,
    ids: b.refs.map((r) => r.id),
    marks: [...segmentMarks(own, [b], 0), ...rowTuplets([sub], [b])[0]!.filter((t) => !own.some((mk) => mk.type === "tuplet" && b.indexOf.get(mk.start) === t.start))],
    code: "",
    source: ZERO,
  };
}

/** `ranges`：切在小节中间的那几个小节只取 `[from, to)` 这一段元素（见 `SystemRow.ranges`）；
 *  右小节线与小节尾的夹层只归最后一段。
 *  `marks`：本声部的记号，同一谱表上的第二声部并成并排块时取块里的弧（见 `innerVoiceLayer`）。 */
function buildRow(measures: readonly Measure[], ranges?: ReadonlyMap<Measure, readonly [number, number]>, marks: readonly Mark[] = []): RowBuild {
  const row: RowBuild = { elements: [], refs: [], indexOf: new Map(), anchors: [], measureSpan: new Map(), wedges: [] };
  let padId = 0;
  const nextPadId = (): ElementId => --padId;
  /** 小节被换行切开的不并第二声部（块对不齐两段） */
  const hasInner = measures.map((mea) => !ranges?.has(mea) && hasInnerVoice(mea));
  for (const [mi, mea] of measures.entries()) {
    const first = row.elements.length;
    const [from, to] = ranges?.get(mea) ?? [0, mea.elements.length];
    const tail = to >= mea.elements.length;
    const laneOf = lanesOf(mea);
    if (hasInner[mi] && !hasInner[mi - 1]) {
      let end = mi;
      while (hasInner[end + 1]) end++;
      row.elements.push(innerVoiceLayer(measures.slice(mi, end + 1), marks, nextPadId));
      row.refs.push({ measure: mea });
    }
    // **左小节线不输出为元素**：`FanqieDoc` 里 barline 元素就是小节分隔，行首再来一根会凭空
    // 多出一个空小节（引擎输入随即 `measure has no chord` 抛错）。
    // 它携带的信息已由「前一小节的右线」与房号的 volta mark 承载。
    let pendingGrace: NoteElement[] = [];
    let lastNote: NoteElement | null = null;
    /** 小节元素下标 → 落成的那个符号（方向记号按下标挂，见 `directionmarks.ts`） */
    const headAt = new Map<number, NoteElement | SustainElement>();
    for (const [j, el] of mea.elements.entries()) {
      if (j < from || j >= to) continue;
      if (laneOf(el) !== "main") continue;
      if (el.kind === "space") {
        // `y`（无时值占位）与 `x`（不可见休止）都落成**隐藏音符**：
        // `FanqieDoc` 没有无时值占位，`hidden` 的 0 是最接近的东西。
        // `y` 不参与对位（`lyricAnchor: false`），与诗歌本的 `9` 同口径。
        const n: NoteElement = {
          kind: "note",
          pitch: 0,
          sound: "rest",
          hidden: true,
          lyricAnchor: el.spacer === "x",
          octave: 0,
          duration: el.spacer === "x" ? 4 << (el.beams?.length ?? 0) : 4,
          dots: el.duration?.dots ?? 0,
          ornaments: [],
          graceBefore: [],
          graceAfter: [],
          code: el.spacer,
          source: el.source ?? ZERO,
        };
        if (el.harmony?.text) n.chord = el.harmony.text;
        if (pendingGrace.length) {
          n.graceBefore = pendingGrace;
          pendingGrace = [];
        }
        row.indexOf.set(el.id, row.elements.length);
        row.elements.push(n);
        row.refs.push({ id: el.id, space: el, measure: mea });
        if (n.lyricAnchor) row.anchors.push(el);
        headAt.set(j, n);
        continue;
      }
      const ch = el;
      // 倚音：前倚音攒着挂到下一个主音，后倚音挂回刚才那个主音
      if (ch.grace) {
        const g = noteOf(ch, []);
        if (ch.grace.after && lastNote) lastNote.graceAfter.push(g);
        else pendingGrace.push(g);
        continue;
      }
      pushInline(row, ch.before, mea);
      let head: MusicElement;
      if (ch.continued) {
        head = sustainOf({ ...ch, lyricAnchor: ch.lyricAnchor ?? !ch.rest });
      } else {
        head = noteOf(ch, pendingGrace);
        pendingGrace = [];
        lastNote = head;
        if (ch.rest && mea.attrs?.multiRest) head.multiRest = mea.attrs.multiRest;
      }
      row.indexOf.set(ch.id, row.elements.length);
      row.elements.push(head);
      row.refs.push({ id: ch.id, chord: ch, measure: mea });
      if (head.lyricAnchor) row.anchors.push(ch);
      if (head.kind === "note" || head.kind === "sustain") headAt.set(j, head);
      // 增时线展开：`FanqieDoc` 里它们是独立元素
      for (const su of ch.sustains ?? []) {
        pushInline(row, su.before, mea);
        row.indexOf.set(su.id, row.elements.length);
        const s = sustainOf(su);
        row.elements.push(s);
        row.refs.push({ id: su.id, chord: ch, sustain: su, measure: mea });
        if (s.lyricAnchor) row.anchors.push(su);
      }
    }
    // 小节里的 direction（MusicXML 来的力度、术语、文字、跳转）挂到对应的符号上；左线上的跳转目标（123 的
    // `| !segno! 5`）挂到本小节头一个符号上——行视图不出左线（见上）
    const dm = directionMarks(mea);
    const heads = [...headAt.entries()].sort((a, b) => a[0] - b[0]);
    const headFrom = (j: number): NoteElement | SustainElement | undefined => heads.find(([k]) => k >= j)?.[1] ?? heads[heads.length - 1]?.[1];
    const addOrn = (h: NoteElement | SustainElement | BarlineElement | undefined, o: SourceOrnament): void => {
      if (h && "ornaments" in h && !h.ornaments.some((x) => x.name === o.name)) h.ornaments.push({ name: o.name, level: o.level, source: ZERO });
    };
    // 小节被换行切成几段时每段都会走到这里：只收落在本段 `[from, to)` 里的，否则另一段的记号会挂到本段末尾、挂两遍
    const inRange = (j: number): boolean => j >= from && j < to;
    for (const [j, orns] of dm.byElement) if (inRange(j)) for (const o of orns) addOrn(headFrom(j), o);
    for (const [j, text] of dm.words) {
      if (!inRange(j)) continue;
      const h = headFrom(j);
      if (h?.kind === "note" && h.annotation === undefined) h.annotation = text;
    }
    if (from === 0) {
      for (const b of mea.barlines ?? []) {
        if (b.location !== "left") continue;
        for (const o of b.ornaments ?? (b.jump ? [{ name: b.jump, level: 0 }] : [])) addOrn(heads[0]?.[1], o);
      }
    }
    // 只有房号、没有线的「右线」是行末补出来挂 ending 的，原文那里没有小节线
    const right = tail ? (mea.barlines ?? []).find((b) => b.location === "right") : undefined;
    let rightEl: BarlineElement | undefined;
    if (right && right.style !== undefined) {
      pushInline(row, right.before, mea);
      rightEl = fanqieBar(right);
      row.elements.push(rightEl);
      row.refs.push({ barline: right, measure: mea });
    }
    if (tail) for (const o of dm.barEnd) addOrn(rightEl ?? heads[heads.length - 1]?.[1], o);
    for (const w of dm.wedges) if (inRange(w.index)) row.wedges.push({ ...w, id: mea.elements[w.index]!.id });
    if (tail) pushInline(row, mea.trailing, mea);
    // 跨度只数有归属的符号与小节线（夹层不算），房号的起止偏移以此为基准（`Ending.startOffset/endOffset`）
    let f = -1;
    let l = -1;
    for (let i = first; i < row.elements.length; i++) {
      const ref = row.refs[i]!;
      if (ref.id === undefined && !ref.barline) continue;
      if (f < 0) f = i;
      l = i;
    }
    row.measureSpan.set(mea, f < 0 ? { first, last: Math.max(first, row.elements.length - 1) } : { first: f, last: l });
  }
  return row;
}

function fanqieBar(b: Barline): BarlineElement {
  const e: BarlineElement = {
    kind: "barline",
    type: fanqieBarlineType(b),
    ornaments: b.ornaments ? fanqieOrnaments(b.ornaments) : [],
    code: "|",
    source: b.source ?? ZERO,
  };
  if (!b.ornaments && b.jump) e.ornaments.push({ name: b.jump, level: 0, source: ZERO });
  if (b.time) {
    e.temporaryMeter = {
      numerator: b.time.beats,
      denominator: b.time.beatType,
      parenthesized: b.time.parenthesized ?? false,
    };
  }
  if (b.annotation !== undefined) e.annotation = b.annotation;
  return e;
}

/** 行内的歌词。有 `print.lyricLines`（文本谱来源）就照它的版式还原；否则按段号铺，全空的行不产生。 */
function rowLyrics(row: RowBuild, infos: readonly LyricLineInfo[] | undefined): FanqieLyricLine[] {
  if (infos) {
    return infos.map((info, lineIdx) => {
      const syllables: LyricSyllable[] = [];
      for (let a = 0; a < Math.min(info.count, row.anchors.length); a++) {
        const hit = (row.anchors[a]!.lyrics ?? []).find(
          (l) =>
            l.number === info.verseFrom &&
            (l.numberTo ?? l.number) === info.verseTo &&
            (l.lineIndex === undefined || l.lineIndex === lineIdx),
        );
        const syl: LyricSyllable = { text: hit?.text ?? "", source: info.sources?.[a] ?? hit?.source ?? ZERO };
        if (hit?.trailingPunctuation) syl.trailingPunctuation = hit.trailingPunctuation;
        syllables.push(syl);
      }
      const line: FanqieLyricLine = {
        verseFrom: info.verseFrom,
        verseTo: info.verseTo,
        annotationGap: info.annotationGap,
        syllables,
        source: info.source ?? ZERO,
      };
      if (info.annotation !== undefined) line.annotation = info.annotation;
      if (info.joinBrace) line.joinBrace = true;
      return line;
    });
  }
  const verses = new Set<number>();
  for (const a of row.anchors) {
    for (const l of a.lyrics ?? []) {
      for (let v = l.number; v <= (l.numberTo ?? l.number); v++) verses.add(v);
    }
  }
  const out: FanqieLyricLine[] = [];
  for (const v of [...verses].sort((a, b) => a - b)) {
    const syllables: LyricSyllable[] = [];
    let label: string | undefined;
    for (const a of row.anchors) {
      const hit = (a.lyrics ?? []).find((l) => v >= l.number && v <= (l.numberTo ?? l.number));
      if (hit?.verseLabel !== undefined) label = hit.verseLabel;
      const syl: LyricSyllable = { text: hit?.text ?? "", source: hit?.source ?? ZERO };
      if (hit?.trailingPunctuation) syl.trailingPunctuation = hit.trailingPunctuation;
      syllables.push(syl);
    }
    // 全空就不产生这一行
    if (!syllables.some((s) => s.text !== "")) continue;
    const line: FanqieLyricLine = { verseFrom: v, verseTo: v, annotationGap: 20, syllables, source: ZERO };
    if (label !== undefined) line.annotation = label;
    out.push(line);
  }
  return out;
}

/** 和音里第 `k` 个音（`Chord.notes` 下标）叠印在第几层（0 = 本音即最低那个，同 `chordDegrees` 的次序）；不是叠印的和音为 undefined */
function stackLevel(ch: Chord, k: number): number | undefined {
  const d = ch.notes[k]?.degree;
  const ds = chordDegrees(ch);
  if (!d || ds.length < 2) return undefined;
  const i = ds.findIndex((x) => x.number === d.number && x.octaveShift === d.octaveShift && x.accidental === d.accidental);
  return i < 0 ? undefined : i;
}

/**
 * 同一对相邻和音之间的延音线（MusicXML 一个音一条 `<tied>`、123 `[1~5]` 也是一音一条）先归组：
 * 连上了叠印里每个数字的是整和音的弧，组里只留第一条、不记 `digits`（照旧画在叠印顶上，其余记 null 不画）；
 * 只连其中几个的各记两端连的是第几层（`FanqieMark.digits`），简谱照它贴着那个数字画（`place/marks.ts`）。
 */
function chordTieDigits(marks: readonly Mark[], chordOf: (id: ElementId) => Chord | undefined): Map<Mark, [number, number] | null> {
  const out = new Map<Mark, [number, number] | null>();
  const groups = new Map<string, Mark[]>();
  for (const m of marks) {
    if (m.type !== "tied") continue;
    const k = `${m.start}>${m.end}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const g of groups.values()) {
    const a = chordOf(g[0]!.start);
    const b = chordOf(g[0]!.end);
    if (!a || !b) continue;
    const levels = g.map((m) => [stackLevel(a, m.startNote ?? 0), stackLevel(b, m.endNote ?? 0)] as const);
    const whole = levels.some(([i, j]) => i === undefined || j === undefined) || new Set(levels.map(([i]) => i)).size >= chordDegrees(a).length;
    if (whole) for (const m of g.slice(1)) out.set(m, null);
    else g.forEach((m, n) => out.set(m, [levels[n]![0]!, levels[n]![1]!]));
  }
  return out;
}

/** Mark：id 配对 → 第 `rowIdx` 行的下标区间。跨行的截断在行边界、打上续接标记，
 *  续行那一段的 level 取 `continuationLevels`。 */
function segmentMarks(marks: readonly Mark[], rows: readonly RowBuild[], rowIdx: number): FanqieMark[] {
  const row = rows[rowIdx]!;
  const rowOf = (id: ElementId): number => rows.findIndex((r) => r.indexOf.has(id));
  const chordOf = (id: ElementId): Chord | undefined => {
    const r = rows[rowOf(id)];
    return r?.refs[r.indexOf.get(id)!]?.chord;
  };
  const digitsOf = chordTieDigits(marks, chordOf);
  const out: FanqieMark[] = [];
  for (const m of marks) {
    const digits = digitsOf.get(m);
    if (digits === null) continue;
    // tie 在简谱里与圆滑线同形，归 slur；pedal/octaveShift/lyricExtend 没有对应物
    const type: FanqieMark["type"] | null =
      m.type === "slur" || m.type === "tied" ? "slur"
        : m.type === "tuplet" ? "tuplet"
          : m.type === "wedge" ? (m.wedgeType === "diminuendo" ? "decrescendo" : "crescendo")
            : null;
    if (type === null) continue;
    // 起点写在上一行行尾的：上一行补一段空的起头
    if (m.leadInPreviousLine && rows[rowIdx + 1]?.indexOf.has(m.start)) {
      out.push({
        type, start: row.elements.length - (m.leadBack ?? 0), end: Math.max(0, row.elements.length - 1),
        level: m.level ?? 0, source: ZERO, continuationToNext: true,
      });
      continue;
    }
    const a = row.indexOf.get(m.start);
    const b = row.indexOf.get(m.end);
    const startRow = a !== undefined ? rowIdx : rowOf(m.start);
    const endRow = b !== undefined ? rowIdx : rowOf(m.end);
    if (a === undefined && b === undefined) {
      // 两端都不在本行：只有跨过本行的才画（中间整行都在弧下）
      if (startRow < 0 || endRow < 0 || rowIdx < startRow || rowIdx > endRow) continue;
    }
    if (m.collapsed) {
      if (a !== undefined) out.push({ type, start: a + 1, end: a, level: m.level ?? 0, source: ZERO });
      continue;
    }
    const seg = (startRow >= 0 ? rowIdx - startRow : 0) + (m.leadInPreviousLine ? 1 : 0);
    const pm: FanqieMark = {
      type,
      start: a !== undefined ? a - (m.startLead ?? 0) : 0,
      end: b !== undefined ? b + (m.endTrail ?? 0) : Math.max(0, row.elements.length - 1),
      level: seg === 0 ? (m.level ?? 0) : (m.continuationLevels?.[seg - 1] ?? m.level ?? 0),
      source: ZERO,
    };
    if (a === undefined || m.continuesFromPrevious || (m.leadInPreviousLine && seg === 1)) pm.continuationFromPrevious = true;
    if (b === undefined) pm.continuationToNext = true;
    if (m.tupletActual !== undefined) pm.caption = String(m.tupletActual);
    if (digits) pm.digits = digits;
    out.push(pm);
  }
  return out;
}

/**
 * 跨小节线的两样东西挂到前一小节的右线上（行视图不出左线）：下一小节左线上的反复起点（只供画线，`repeatForwardAfter`），与
 * 曲中换拍号（123 / MusicXML 记在小节的 `attrs.time` 上）→ 前一小节右线上的临时拍号（文本谱 `"p:3/4"` 的口径，
 * 原样文档照它在线后印拍号）。文本谱来源的小节线本来就带着（`Barline.time`），不重复。
 */
function carryToPrevBarline(measures: readonly Measure[], rows: readonly RowBuild[], songTime?: { beats: number; beatType: number }): void {
  // 起头的拍号：首小节没写 `attrs.time` 的（123 / ABC 的 `M:` 只记在曲头 `Song.time`）从曲头起比，
  // 否则曲中第一次换拍号认不出来（单声部全特性 `|] [M:3/4]` 那条线后的 3/4 原先没印）
  let cur: { beats: number; beatType: number } | undefined = songTime ? { beats: songTime.beats, beatType: songTime.beatType } : undefined;
  const prevBar = (i: number): BarlineElement | undefined => {
    const prev = measures[i - 1];
    for (const row of rows) {
      const k = row.refs.findIndex((r) => r.barline && r.measure === prev);
      if (k < 0) continue;
      const el = row.elements[k];
      return el?.kind === "barline" ? el : undefined;
    }
    return undefined;
  };
  measures.forEach((mea, i) => {
    if (i > 0 && mea.barlines?.some((b) => b.location === "left" && b.repeat === "forward")) {
      const el = prevBar(i);
      if (el) el.repeatForwardAfter = true;
    }
    const t = mea.attrs?.time;
    if (!t) return;
    const changed = cur !== undefined && (t.beats !== cur.beats || t.beatType !== cur.beatType);
    cur = { beats: t.beats, beatType: t.beatType };
    if (!changed || i === 0) return;
    const el = prevBar(i);
    if (el && !el.temporaryMeter) el.temporaryMeter = { numerator: t.beats, denominator: t.beatType, parenthesized: t.parenthesized ?? false };
  });
}

/** 一个声部各行里 direction 的渐强渐弱起止 → `Mark`（同类型后开先收）。 */
function directionWedgeMarks(rows: readonly RowBuild[]): Mark[] {
  const out: Mark[] = [];
  const open: { type: "crescendo" | "diminuendo"; id: ElementId }[] = [];
  for (const row of rows) {
    for (const w of row.wedges) {
      if (w.edge === "start" && w.type) open.push({ type: w.type, id: w.id });
      else if (w.edge === "stop") {
        const s = open.pop();
        if (s) out.push({ type: "wedge", start: s.id, end: w.id, wedgeType: s.type, level: 0 });
      }
    }
  }
  return out;
}

const captionOfEnding = (e: NonNullable<Barline["ending"]>): string | undefined =>
  e.captionless ? undefined : (e.text ?? e.numbers.join("."));

/** 房号：`Barline.ending` → Mark volta（`FanqieDoc` 的排版器靠它画跳房子）。跨行的拆成各行一段。 */
function rowVoltas(measuresByRow: readonly (readonly Measure[])[], rows: readonly RowBuild[]): FanqieMark[][] {
  const out: FanqieMark[][] = rows.map(() => []);
  interface Open {
    ending: NonNullable<Barline["ending"]>;
    startRow: number;
    start: number;
    fromPrev: boolean;
  }
  /** 开着的房号。一般至多一个；文本谱解析器会留下跨行不收口的、与后面的重叠 */
  let open: Open[] = [];
  const levelOf = (o: Open, r: number): number => {
    const seg = r - o.startRow;
    return seg === 0 ? (o.ending.level ?? 0) : (o.ending.continuationLevels?.[seg - 1] ?? 0);
  };
  const mark = (o: Open, r: number, end: number): FanqieMark => {
    const pm: FanqieMark = { type: "volta", start: o.start, end, level: levelOf(o, r), source: ZERO };
    const caption = captionOfEnding(o.ending);
    if (caption !== undefined) pm.caption = caption;
    if (o.fromPrev) pm.continuationFromPrevious = true;
    return pm;
  };
  measuresByRow.forEach((measures, r) => {
    const row = rows[r]!;
    open = open.map((o) => ({ ...o, start: 0, fromPrev: true }));
    for (const mea of measures) {
      const span = row.measureSpan.get(mea)!;
      for (const b of mea.barlines ?? []) {
        if (b.location !== "left" || b.ending?.type !== "start") continue;
        const e = b.ending;
        const caption = captionOfEnding(e);
        if (e.collapsed) {
          const pm: FanqieMark = { type: "volta", start: span.first, end: span.first - 1, level: e.level ?? 0, source: ZERO };
          if (caption !== undefined) pm.caption = caption;
          out[r]!.push(pm);
          continue;
        }
        if (e.leadInPreviousLine && r > 0) {
          const prev = rows[r - 1]!;
          const pm: FanqieMark = {
            type: "volta", start: prev.elements.length, end: Math.max(0, prev.elements.length - 1),
            level: e.level ?? 0, source: ZERO, continuationToNext: true,
          };
          if (caption !== undefined) pm.caption = caption;
          out[r - 1]!.push(pm);
          open.push({ ending: e, startRow: r - 1, start: 0, fromPrev: true });
          continue;
        }
        open.push({ ending: e, startRow: r, start: span.first + (e.startOffset ?? 0), fromPrev: false });
      }
      for (const right of mea.barlines ?? []) {
        if (right.location === "right" && right.ending?.danglingLead) {
          const pm: FanqieMark = {
            type: "volta", start: row.elements.length, end: Math.max(0, row.elements.length - 1),
            level: right.ending.level ?? 0, source: ZERO, continuationToNext: true,
          };
          const caption = captionOfEnding(right.ending);
          if (caption !== undefined) pm.caption = caption;
          out[r]!.push(pm);
          continue;
        }
        if (right.location !== "right" || !right.ending || right.ending.type === "start" || !open.length) continue;
        const stop = right.ending;
        // 有配对号按号收，否则收最近开的那个
        let k = stop.pair !== undefined ? open.findIndex((o) => o.ending.pair === stop.pair) : -1;
        if (k < 0) k = open.length - 1;
        const o = open[k]!;
        const pm = mark(o, r, span.last + (stop.endOffset ?? 0));
        if (stop.type === "discontinue") pm.openEnd = true;
        out[r]!.push(pm);
        open.splice(k, 1);
      }
    }
    for (const o of open) out[r]!.push({ ...mark(o, r, Math.max(0, row.elements.length - 1)), continuationToNext: true });
  });
  return out;
}

/** 拍单位 → 速度记号里的音符字（文字字体里有的那几个；附点四分写 `♩.`） */
function beatChar(b: { num: number; den: number }): string {
  const key = `${b.num}/${b.den}`;
  return ({ "1/4": "♩", "1/2": "𝅗𝅥", "1/8": "♪", "3/8": "♩.", "3/4": "𝅗𝅥.", "1/1": "𝅝" } as Record<string, string>)[key] ?? "♩";
}

/** `printTempo`：把速度数字印出来（`♩=144`）。文本谱的 `J:`、`.jpwabc` 的速度数字原样档不印，只给别的来源。 */
function toMetadata(song: Song, printTempo: boolean): Metadata {
  const meta: Metadata = {
    titles: [],
    authors: [],
    remarks: [],
    meters: [],
    tempos: [],
    topLeft: [],
    topRight: [],
    bottomLeft: [],
    bottomCenter: [],
    bottomRight: [],
    fontSizes: [],
    margins: [],
    options: [],
  };
  if (song.work.title !== undefined) meta.titles.push(song.work.title);
  meta.titles.push(...song.work.subtitles);
  // MusicXML 的副标题只在 `<credit>` 里（`credit-type` 为 subtitle），`work` 那边没有
  if (!song.work.subtitles.length) {
    for (const c of song.credits ?? []) if (c.type === "subtitle" && c.text.trim() && !meta.titles.includes(c.text.trim())) meta.titles.push(c.text.trim());
  }
  const scripture = [...getMeta(song, "scripture"), ...getMeta(song, "scripture-ref")].filter((t) => t.trim());
  if (scripture.length) meta.scripture = scripture;
  if (song.work.version !== undefined) meta.version = song.work.version;
  // `.jpwabc` 的词曲一条写了好几行（`作词：…\n作曲：…`）：作者条为写 123 的 `C:` 拼成了一行，原文的分行在 credits 里，照原文分行
  for (const c of song.identification?.creators ?? []) {
    const multi = song.credits?.find((k) => !k.type && k.text.includes("\n") && k.text.replace(/\n/g, " ") === c.text);
    meta.authors.push(multi?.text ?? c.text);
  }
  if (song.key) {
    if (song.key.display !== undefined) meta.mode = song.key.display;
    else if (song.key.spelling && song.key.spelling !== "none") meta.mode = song.key.spelling;
    // ⚠ 只有 `fifths` 的文档（有的读入端只写它）也要把调号带过去，否则引擎输入按 C 算 ——
    //   实测：JP-Word 的 `1=D` 谱导出成 jianpu-ly 写成 `1=C`。
    //   主音唱名不是 1 的（识别出的小调 `6=E`）拼主音，不拼大调名
    else if (song.key.spelling !== "none") meta.mode = tonicSpelling(song.key);
    if (song.key.tonicDegree && song.key.tonicDegree !== "1") meta.tonic = song.key.tonicDegree;
  }
  for (const t of [song.time, ...(song.extraTimes ?? [])]) {
    if (!t) continue;
    meta.meters.push({ numerator: t.beats, denominator: t.beatType, parenthesized: t.parenthesized ?? false });
  }
  if (song.timeNote !== undefined) meta.timeNote = song.timeNote;
  for (const t of quarterTempos(song)) meta.tempos.push(t);
  if (printTempo) {
    const lead = leadTempo(song);
    if (lead) meta.tempoMark = `${beatChar(lead.beat)}=${lead.perMinute}`;
  }
  meta.remarks.push(...(song.remarks ?? []));
  const pt = song.pageText;
  if (pt) {
    if (pt.indexLeft !== undefined) meta.indexLeft = pt.indexLeft;
    if (pt.indexRight !== undefined) meta.indexRight = pt.indexRight;
    meta.topLeft.push(...pt.topLeft);
    meta.topRight.push(...pt.topRight);
    meta.bottomLeft.push(...pt.bottomLeft);
    meta.bottomCenter.push(...pt.bottomCenter);
    meta.bottomRight.push(...pt.bottomRight);
  }
  // 文档内样式指令原文（`FontSize:` / `Margin:` / 其它）交给 metrics 解释
  for (const r of song.style?.raw ?? []) {
    if (/^fontsize$/i.test(r.key)) meta.fontSizes.push(r.value);
    else if (/^margin$/i.test(r.key)) meta.margins.push(r.value);
    else meta.options.push({ key: r.key, value: r.value });
  }
  return meta;
}

interface SystemRow {
  /** `print.system`（文本谱来源才有） */
  system: number | undefined;
  measures: Measure[];
  /** 切在小节中间的小节：这一行只取它 `[from, to)` 这一段元素（见 `splitSystems`） */
  ranges?: Map<Measure, [number, number]>;
  /** 这一行是从小节中间接着起的：首小节的 `print` 属于上一行，不是这一行的 */
  cont?: boolean;
}

/** 和弦（或它的某条增时线）之后原位换行（`Chord.lineBreakAfter`，`.jpwabc` 与 123 的小节中间 `$`）。 */
const breaksInline = (el: Chord | Space): boolean =>
  el.kind === "chord" && (el.lineBreakAfter !== undefined || (el.sustains ?? []).some((su) => su.lineBreakAfter !== undefined));

/**
 * 一个声部按系统切开（模型口径：带 `print` 的小节**起**新系统，见 `doc.ts::Print`）。
 * **小节中间换行**（`Chord.lineBreakAfter`）照原位切：那一小节分成两段、各归一行，
 * 下一小节上同源的那条小节级 `print`（「这一小节之后换行」的另一份记法）就不再断第二次。
 */
function splitSystems(part: Part): SystemRow[] {
  const rows: SystemRow[] = [];
  let cur: Measure[] = [];
  let ranges = new Map<Measure, [number, number]>();
  let cont = false;
  let sys: number | undefined;
  /** 上一小节里已经在原位断过：这一小节的 `print` 是同一处换行 */
  let swallow = false;
  const flush = (): void => {
    if (cur.length) rows.push({ system: sys, measures: cur, ...(ranges.size ? { ranges } : {}), ...(cont ? { cont } : {}) });
    cur = [];
    ranges = new Map();
    cont = false;
  };
  for (const m of part.measures) {
    if (m.print?.newSystem || m.print?.newPage) {
      if (!swallow) flush();
      sys = m.print.system;
    }
    swallow = false;
    let from = 0;
    m.elements.forEach((el, i) => {
      if (i === m.elements.length - 1 || !breaksInline(el)) return;
      ranges.set(m, [from, i + 1]);
      cur.push(m);
      flush();
      cont = true;
      from = i + 1;
      swallow = true;
    });
    if (from > 0) ranges.set(m, [from, m.elements.length]);
    cur.push(m);
  }
  flush();
  return rows.length ? rows : [{ system: undefined, measures: [] }];
}

/** 一行（一个声部在一个系统里的那一段）。形状同 `ScoreLine`，另带来源。 */
export interface RowView extends ScoreLine {
  part: Part;
  measures: Measure[];
  /** 与 `elements` 平行 */
  refs: SlotRef[];
}

export interface SystemView extends VoiceGroup {
  /** 全曲第几个系统 */
  system: number;
  voices: RowView[];
}

export interface PageView extends ScorePage {
  groups: SystemView[];
}

export interface SongView extends FanqieSong {
  song: Song;
  pages: PageView[];
}

export interface DocView {
  doc: ScoreDoc;
  songs: SongView[];
  /** 行里的符号 → 它的 id（高亮、定位用） */
  idOf: Map<MusicElement, ElementId>;
  /** id → 行里的符号（一个 id 只对应一个符号） */
  elementOf: Map<ElementId, MusicElement>;
  /** 歌词音节 → 它跟的那个符号的 id */
  syllableOwner: Map<LyricSyllable, ElementId>;
}

/** 一个声部里真正换了调的小节 → 转调标签。与前一小节同调的 `attrs.key`（MusicXML 每行重申的）不算 */
function keyChangeLabels(song: Song, part: Part): Map<Measure, string> {
  const out = new Map<Measure, string>();
  let cur = part.measures[0]?.attrs?.key?.fifths ?? songFifths(song);
  part.measures.forEach((m, i) => {
    const k = m.attrs?.key;
    if (i === 0 || !k || k.fifths === cur) return;
    cur = k.fifths;
    const prev = part.measures[i - 1]!.barlines?.find((b) => b.location === "right" && b.annotation);
    // 升降号用真符号、写在字母前（同页眉调号）；字样同编辑器那一路的 `KeySig`
    const name = keySpelling(k).replace(/b/g, "\u266D").replace(/#/g, "\u266F");
    out.set(m, prev?.annotation ?? `转1=${name}`);
  });
  return out;
}

/** 连音：`Chord.duration.timeMod` → Mark tuplet。
 *  `FanqieDoc` 靠它画连音括号、`jianpuinput` 靠它置 `tupletBegin`（写出端才能写 `n[ … ]`）。
 *  ⚠ jly 这条路把连音记在 **`duration.timeMod`** 上，而 123/ABC 的解析器是**同时**写 fanqie 标记的
 *  （见 `parse.ts:533/537`）。以前没人把 `timeMod` 翻成标记，于是整条链都看不到连音 ——
 *  实测写出端连 `3[` 都写不出来、`5[ 1 1 1 1 1 ]` 重出成 `1 1 1 1 1`（上游 review 第 9 条）。
 *  连续一串带同一个 `timeMod` 的和弦算一组（跨行的组按行拆成多段，与房号同一处理）。 */
function rowTuplets(measuresByRow: readonly (readonly Measure[])[], rows: readonly RowBuild[]): FanqieMark[][] {
  const out: FanqieMark[][] = rows.map(() => []);
  measuresByRow.forEach((measures, r) => {
    const row = rows[r]!;
    let open: number | null = null;
    const close = (end: number): void => {
      if (open === null) return;
      out[r]!.push({ type: "tuplet", start: open, end, level: 0, source: ZERO });
      open = null;
    };
    for (const mea of measures) {
      const span = row.measureSpan.get(mea);
      if (!span) continue;
      for (let i = span.first; i <= span.last; i++) {
        const tm = row.refs[i]?.chord?.duration.timeMod;
        if (tm) { if (open === null) open = i; continue; }
        close(i - 1);
      }
    }
    close(row.elements.length - 1);
  });
  return out;
}

function toFanqieSong(song: Song, index: number, rawLines: readonly string[], handPages: boolean, printTempo: boolean): SongView {
  const perPart = song.parts.map((p) => splitSystems(p));
  /** 文本谱来源：一组不一定含全部声部，按 `print.system` 对回同一组；其余按行序号 */
  const bySystem = perPart.some((rows) => rows.some((r) => r.system !== undefined));
  const voiceOf = (pi: number): number => {
    const m = bySystem ? /^P(\d+)$/.exec(song.parts[pi]!.id) : null;
    return m ? Number(m[1]) : pi + 1;
  };
  // 各声部的全部行先建好——跨行记号要看别的行有没有端点
  const builds = perPart.map((rows) => rows.map((row) => buildRow(row.measures, row.ranges, song.marks)));
  perPart.forEach((rows, pi) => carryToPrevBarline(rows.flatMap((r) => r.measures), builds[pi]!, song.time));
  // MusicXML 来源的渐强渐弱只有 direction（`Mark` 在写出时才投成 direction，读回不还原）：按起止配成 Mark
  const hasWedgeMarks = song.marks.some((m) => m.type === "wedge");
  const wedgeMarks = builds.map((rows) => (hasWedgeMarks ? [] : directionWedgeMarks(rows)));
  const marksOfPart = (pi: number): readonly Mark[] => (wedgeMarks[pi]!.length ? [...song.marks, ...wedgeMarks[pi]!] : song.marks);
  const voltas = perPart.map((rows, pi) => rowVoltas(rows.map((r) => r.measures), builds[pi]!));
  const tuplets = perPart.map((rows, pi) => rowTuplets(rows.map((r) => r.measures), builds[pi]!));

  const systems = new Map<number, { pi: number; r: number }[]>();
  perPart.forEach((rows, pi) => {
    rows.forEach((row, r) => {
      const key = bySystem ? (row.system ?? r) : r;
      let list = systems.get(key);
      if (!list) systems.set(key, (list = []));
      list.push({ pi, r });
    });
  });

  const pages: PageView[] = [];
  let page: PageView = { index: 0, groups: [] };
  for (const key of [...systems.keys()].sort((a, b) => a - b)) {
    const voices: RowView[] = [];
    let texts: string[] = [];
    let textSources: readonly SourceSpan[] = [];
    let newPage = false;
    for (const { pi, r } of systems.get(key)!) {
      const part = song.parts[pi]!;
      const build = builds[pi]![r]!;
      const sr = perPart[pi]![r]!;
      const p = sr.cont ? undefined : sr.measures[0]?.print;
      // 换页：文本谱的 `[fenye]`、123 / ABC 手写的 `$$`。MusicXML 的 `new-page` 是原排版软件按它那张纸断的，不照搬
      if ((bySystem || handPages) && p?.newPage) newPage = true;
      if (p?.texts) {
        texts = p.texts;
        textSources = p.textSources ?? [];
      }
      const segs = segmentMarks(marksOfPart(pi), builds[pi]!, r);
      // 123/ABC 的解析器同时写了连音标记，按 `timeMod` 补出来的同一段就不再要（否则同一个连音画两遍）
      const extra = tuplets[pi]![r]!.filter((t) => !segs.some((s) => s.type === "tuplet" && s.start === t.start && s.end === t.end));
      const line: RowView = {
        part,
        measures: perPart[pi]![r]!.measures,
        refs: build.refs,
        voice: voiceOf(pi),
        elements: build.elements,
        marks: [...segs, ...voltas[pi]![r]!, ...extra],
        lyrics: rowLyrics(build, p?.lyricLines),
        raw: p?.source ? (rawLines[p.source.line] ?? "") : "",
        source: p?.source ?? ZERO,
      };
      const caption = bySystem ? p?.caption : part.name;
      if (caption !== undefined) line.caption = caption;
      if (p?.variant !== undefined) line.variant = p.variant;
      voices.push(line);
    }
    if (newPage && page.groups.length) {
      pages.push(page);
      page = { index: pages.length, groups: [] };
    }
    page.groups.push({
      index: page.groups.length,
      system: key,
      texts: texts.map((t, i) => ({ text: t, source: textSources[i] ?? ZERO })),
      voices,
    });
  }
  pages.push(page);
  return { index, song, metadata: toMetadata(song, printTempo), pages };
}

const views = new WeakMap<ScoreDoc, DocView>();

/** 一份 `ScoreDoc` 的排版行视图。**同一份文档只建一次**：排版器、`jianpuInputOfDoc`、双向定位拿到的是同一批对象。 */
export function docView(doc: ScoreDoc): DocView {
  const hit = views.get(doc);
  if (hit) return hit;
  // 行的 `raw`：文本谱来源按 `Print.source` 的行号取原文（乐句重排改写原文要它）
  const rawLines = doc.source && doc.sourceFormat === "fanqie" ? doc.source.split(/\r?\n/) : [];
  const view: DocView = {
    doc,
    // MusicXML 读进来的先投成简谱形状（长音拆增时线、减时线按 `<type>` 算、和弦补原文）
    songs: doc.songs.map((s, i) => toFanqieSong(compressMultiRests(projectForJianpu(s)), i, rawLines, doc.sourceFormat === "123" || doc.sourceFormat === "abc",
      // 速度数字只给 123 / ABC / MusicXML 这类来源印；文本谱的 `J:`、JP-Word 的 `Expression` 原样档本来不印
      doc.sourceFormat !== "fanqie" && doc.sourceFormat !== "jpwabc")),
    idOf: new Map(),
    elementOf: new Map(),
    syllableOwner: new Map(),
  };
  const labelsOf = new Map<Part, Map<Measure, string>>();
  const labelled = new Set<Measure>();
  for (const sv of view.songs) {
    for (const pg of sv.pages) {
      for (const g of pg.groups) {
        for (const row of g.voices) {
          let labels = labelsOf.get(row.part);
          if (!labels) labelsOf.set(row.part, (labels = keyChangeLabels(sv.song, row.part)));
          row.elements.forEach((el, i) => {
            const ref = row.refs[i]!;
            const label = labels.get(ref.measure);
            // 转调全曲同步（`fromfanqie.ts` 补齐了各声部），标签只印在一组的第一个声部上
            if (label !== undefined && row === g.voices[0] && el.kind === "note" && ref.chord && !labelled.has(ref.measure)) {
              labelled.add(ref.measure);
              el.keyLabel = label;
            }
            // 同一谱表的第二声部并成的块：块里的元素也登记（点选、高亮、原文定位靠它）
            if (el.kind === "inline-layer") {
              el.elements.forEach((sub, k) => {
                const sid = el.ids?.[k];
                if (sid === undefined || sid < 0) return; // 补拍位的不可见休止是临时 id，模型里没有
                view.idOf.set(sub, sid);
                if (!view.elementOf.has(sid)) view.elementOf.set(sid, sub);
              });
            }
            const id = ref.id;
            if (id === undefined) return;
            view.idOf.set(el, id);
            if (!view.elementOf.has(id)) view.elementOf.set(id, el);
          });
          const anchors = row.elements.filter((el) => (el.kind === "note" || el.kind === "sustain") && el.lyricAnchor);
          for (const line of row.lyrics) {
            line.syllables.forEach((syl, k) => {
              const owner = anchors[k] && view.idOf.get(anchors[k]!);
              if (owner !== undefined) view.syllableOwner.set(syl, owner);
            });
          }
        }
      }
    }
  }
  views.set(doc, view);
  return view;
}

