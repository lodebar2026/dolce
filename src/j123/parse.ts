// `.123` 文本 → `ScoreDoc`。规范见 `docs/格式/123格式.md`。
//
// 分工：词法（切 token）在 `lex.ts`，字段与指令在 `fields.ts`，**本文件只做组装**——
// 小节切分、时值累计、符杠分组、Mark 配对、歌词对位、`I:playorder` 的音符级端点回填。
//
// 几条判据（改之前先读）：
//   - **123 的空白不表示符杠分组**：符杠按拍自动算（排版 `beamGroupsOf`），空格只为好读。
//     只有 ABC 方言按 §4.7 把「连写」落成 `Chord.beamGroup`（`ParseDialect.spaceBeams`）。
//   - **歌词 CJK 连写逐字成音节**（规范 §5.2，对 ABC 的扩展）；拉丁词仍按空格/连字符分。
//     收尾标点**并入前一字、不占音符格**，规则复用 `common/cjkpunct.ts`，别再写一份。
//   - **`(N:` 的冒号必需**：简谱音符是数字，裸 `(3` 与圆滑线冲突，见规范「`(` 的歧义」。
//   - 认不出的东西一律**报诊断、继续往下**——半截或写错的文本也要给出大部分结果。

import { lineStarts } from "../common/lines";
import { jumpOrnamentName } from "../abcfamily/jumpmarks";
import {
  PU_LYRIC_QUOTES,
  isLyricCjk as isCjk,
  isLyricOpenQuote as isOpenQuote,
  isLyricTrailingPunct as isTrailingPunct,
} from "../common/cjkpunct";
import type {
  AttachedSource,
  Barline,
  Chord,
  Clef,
  Diagnostic,
  Element,
  ElementId,
  Lyric,
  Mark,
  Measure,
  NoteType,
  Part,
  PlayPass,
  ScoreDoc,
  Song,
  SourceSpan,
  Space,
  Sustain,
} from "../model/doc";
import { IdGen, breaksAfterToStart, emptyDoc, emptySong } from "../model/helpers";
import { resolveAbcPitches } from "../abcfamily/abcpitch";
import { addMeta, creatorOf, isMetaKey } from "../model/metakeys";
import type { BreakKind } from "../model/helpers";
import {
  CJK_INSTRUCTION_ALIAS,
  parseFieldLine,
  parseInstruction,
  parseLinebreak,
  parsePlayOrder,
  parseTempo,
  parseTempoBeat,
  parseTime,
  parseTimes,
  parseVoiceClef,
  type FieldLine,
  type FieldName,
  type RawPlayPass,
} from "./fields";
import type { Token } from "../abcfamily/types";
import { isLyricSlot, lyricSlots, type LyricSlotRule } from "../abcfamily/lyricslot";
import {
  DIALECT_123, DIALECT_ABC, DIALECT_JCX, typeAndDots, type DefaultLen, type ParseDialect,
} from "../abcfamily/parsedialect";
import { LETTER_OF_DEGREE } from "../abcfamily/dialectjcx";
import { t as tr } from "../i18n";

/** 歌词块：一行曲（到 `$` 换行为止的连续音乐行），紧跟其后的 `w` 行从块的第一个对位格起对位
 *  （规范 §5.1，同 ABC §5.1、文本谱 `Q:` 后跟 `C1:`）。
 *  块在两处断开：跟过 `w` 行之后、或已经见过换行（`$`；ABC 是每个代码行）之后，下一条音乐行开新块。
 *  只靠「跟过 `w`」不够：没有词的一行（前奏）会和下一行并成一块，下一行的词就从前奏第一个音挂起。 */
interface LyricBlock {
  /** 块首的对位格序号（声部内全局，`abcfamily/lyricslot.ts` 口径） */
  start: number;
  /** 块尾（不含）。下一块开始或整首收尾时才定 */
  end?: number;
  /** 块内各段写到哪一格：同一段用 `+:` 分几条写时接着往下挂 */
  cursor: Map<number, number>;
  /** 块内 `w:` 的条数：按出现顺序编段号 1、2、3…（规范 §5.1，同 ABC §5.1） */
  verses: number;
  /** 上一条 `w:` 是第几段：`+:` 续行接着写它 */
  lastVerse?: number;
  /** 块里已经换过行：下一条音乐行开新块 */
  broken: boolean;
}

/** 一个声部在组装期的累积状态。 */
interface PartBuild {
  part: Part;
  /** 当前小节（还没收尾） */
  measure: Measure;
  /** 本小节内已出现的音符数（`I:playorder` 的 skip/limit 按它定位） */
  noteCount: number;
  /** 小节号计数 */
  measureNo: number;
  /** 本小节里当前写到第几个临时声部（ABC `&`，§7.4）。主分支 1，每个 `&` 切到下一个；
   *  真正的小节线复位回 1。**必须存在声部级**：一个小节可以跨几个代码行，`&` 的作用域不随行结束 */
  voice: number;
  /** 本小节最后一个 `&` 在原文里的位置：分支收尾时发现它是空的，诊断要指到这儿 */
  overlaySource?: SourceSpan;
  /** 开着的弧/多连音、欠着的和弦记号、开着的房号。**按声部各存一份**：
   *  交错写法里 `V:1` 的弧常跨行，中间隔着 `V:2` 的行，共用一份会配错对 */
  openSlurs: OpenMark[];
  openTuplets: OpenMark[];
  /** `srcs`：欠着的这些记号在原文里的位置（`AttachedSource`，只给编辑用），随记号一起落到元素上 */
  pending: { chord?: string; annotations: string[]; decos: string[]; srcs: AttachedSource[] };
  openEnding: number[][];
  /** 当前歌词块；`afterLyrics` 表示上一块已经跟过 `w` 行，下一条音乐行开新块 */
  block?: LyricBlock;
  afterLyrics: boolean;
  /** 刚见过的 `$` 落在小节中间还是小节末，要看后面先来的是音符还是小节线：先记下 `$` 前的最后一个和弦
   *  （及它当时有几条增时线），同一小节里再来音符才落成 `lineBreakAfter`（同 `.jpwabc`，见 `fromjpw.ts`） */
  inlineBreak: { host: Chord; sustains: number; kind: BreakKind } | null;
  /** `V:n clef=…`（123）：收尾时落到第一小节的 `attrs.clefs` */
  clef?: Clef;
  /** 123 的后置 `~` 还没配到下一个音：起点和弦与 `~` 的位置。存在声部级，`~` 可以跨 `$` 行 */
  arcNext: { from: ElementId; source: SourceSpan } | null;
  /** 开着的渐强渐弱（Muse 的 `(<` … `<)`），起点同弧一样由 `attach` 回填 */
  openWedges: OpenMark[];
  /** 行内 `[L:…]` 改过的默认音长：**只管这个声部**（ABC §7：声部里的行内字段只作用于该声部），
   *  交错或分块写的别的声部仍用头部的 `L:` */
  len?: DefaultLen;
  /** Muse `V:… style=`：`staff` 的字母是绝对音高（收尾时换算），`tab`/`ukulele` 整轨不读（只认简谱与五线谱） */
  museStyle?: "jianpu" | "staff" | "skip";
}

/** 见到 `$`（或 ABC 的代码行末）：当前小节已有和弦时先记下，是不是小节中间换行等后面来的是什么再定（`PartBuild.inlineBreak`）。 */
function noteInlineBreak(pb: PartBuild, kind: BreakKind): void {
  const last = pb.measure.elements[pb.measure.elements.length - 1];
  pb.inlineBreak = last?.kind === "chord" ? { host: last, sustains: last.sustains?.length ?? 0, kind } : null;
}

/** 声部里到目前为止的最后一个元素（含还没收尾的小节）。 */
function lastElementId(pb: PartBuild): ElementId | null {
  const els = pb.measure.elements;
  if (els.length) return els[els.length - 1]!.id;
  for (let i = pb.part.measures.length - 1; i >= 0; i--) {
    const m = pb.part.measures[i]!.elements;
    if (m.length) return m[m.length - 1]!.id;
  }
  return null;
}

/** 声部里到目前为止的对位格数（含还没收尾的小节）。 */
function slotCount(pb: PartBuild, rule: LyricSlotRule): number {
  let n = 0;
  for (const m of pb.part.measures) for (const el of m.elements) if (isLyricSlot(el, rule)) n++;
  for (const el of pb.measure.elements) if (isLyricSlot(el, rule)) n++;
  return n;
}

interface Ctx {
  ids: IdGen;
  diagnostics: Diagnostic[];
  lineNo: number;
  lineOffset: number;
  /** 方言钩子：时值、音符、调号、`-` 的语义。组装逻辑本身两种方言共用。 */
  d: ParseDialect;
  /** ABC 的 `L:` 默认音长（123 用不到，恒为 1/4）。 */
  len: DefaultLen;
  /** 见过显式 `L:` 没有——没见过时 `M:` 要按 ABC §3.1.7 反推默认音长。 */
  sawL: boolean;
  /** 当前拍号：ABC 多连音的默认比例要看是不是复拍子（§4.13） */
  time: { beats: number; beatType: number } | null;
  /** `$` 记在哪一小节**之后**。一首收尾时经 `breaksAfterToStart` 翻成模型口径（`doc.ts::Print`） */
  breakAfter: Map<Measure, BreakKind>;
}

function report(ctx: Ctx, code: string, message: string, source: SourceSpan): void {
  ctx.diagnostics.push({ severity: "warning", code, message, source });
}

/** 小节线归一名 → MusicXML 的 bar-style + repeat。 */
function barlineFrom(value: string, times: number | undefined, source: SourceSpan): Barline {
  const b: Barline = { location: "right", source };
  switch (value) {
    case "normal": b.style = "regular"; break;
    case "double": b.style = "light-light"; break;
    case "final": b.style = "light-heavy"; break;
    case "reverse-final": b.style = "heavy-light"; break;
    case "dotted": b.style = "dotted"; break;
    case "none": b.style = "none"; break;
    case "repeat-start": b.style = "heavy-light"; b.repeat = "forward"; break;
    case "repeat-end": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "repeat-both": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "heavy-light": b.style = "heavy-light"; b.repeat = "forward"; break;
    case "light-heavy": b.style = "light-heavy"; b.repeat = "backward"; break;
    default: b.style = "regular"; break;
  }
  if (times) b.repeatTimes = times;
  return b;
}

// 时值换算（基准 `model/doc.ts::SIMPLE_DIVISIONS`，两种方言各自的算法）在 `abcfamily/parsedialect.ts`。

/** 歌词行 → 音节数组。
 *
 *  - **CJK 连写逐字成音节**（规范 §5.2）；拉丁按空格与 `-` 分。
 *  - `_` 前一音节延长一音（melisma）、跳音符（123 `/`、ABC `*`，见 `ParseDialect.lyricSkip`）、
 *    `~` 与 `{}` 多字一音、`|` 推进到下一小节；`\-` `\/` 是字面字符。
 *  - 123 里写了旧的 `*`：报 `lyric-old-skip`，仍当跳音符（不然整行静默错一格）。
 *  - 收尾标点并入前一字、不占音符格（`common/cjkpunct.ts` 的同一份规则）。
 *  - 段首 `<1.>` 是**印刷段号**，不占音符格（语料 55.6% 这么写）。
 *  - `joinTilde`（Muse `.jcx`）：`~` 在**任何**音节后面都把下一个音节并到同一个音（说明书「~ 连接两个字」），
 *    不只在汉字后面——`1.~圣`、`the~Lord` 都是一格，拉丁与拉丁之间并成空格。123/ABC 不开：那两档拉丁词里的 `~` 照旧是字面字符。 */
export function parseLyricLine(
  body: string,
  verse: number,
  source: SourceSpan,
  valueOffset?: number,
  skip: "/" | "*" = "/",
  warn?: (code: string, message: string) => void,
  joinTilde = false,
): { syllables: Lyric[]; label?: string; starts: number[] } {
  const out: Lyric[] = [];
  /** 各音节（含跳音符、续记号这类空音节）在 body 里的起点，与 `out` 一一对应——
   *  可视化编辑按对位格数拆 `w:` 行要它（空音节不记 `source`） */
  const starts: number[] = [];
  let i = 0;
  /** 当前音节在 body 里的起点：给音节记源区间（识别核对的点选定位落到字上） */
  let tokStart = 0;
  let label: string | undefined;

  // 印刷段号 `<1.>`。**不认 `"1."`**：直引号在歌词里是贴前字的标点（规范 §5.2），
  // 行首 `"主啊"，我…` 会被误吞成段号
  const lm = /^\s*<([^>]*)>/.exec(body);
  if (lm) {
    label = lm[1];
    i = lm[0].length;
  }

  /** 还没有前字可并的行首标点，攒着挂到下一个音节前面 */
  let prefix = "";

  /** 收尾标点。`joinTilde` 时 `~` 是并字符号、不是标点（标点表里有它） */
  const trail = (c: string): boolean => isTrailingPunct(c) && !(joinTilde && c === "~");
  /** 上一个音节后面跟着 `~`：下一个有字的音节并进去（`joinTilde`） */
  let joinNext = false;
  const push = (l: Lyric): void => {
    const prev = out[out.length - 1];
    if (joinNext && prev && l.text !== "") {
      joinNext = false;
      const latin = /[A-Za-z0-9]$/.test(prev.text) && !prev.trailingPunctuation && /^[A-Za-z0-9]/.test(l.leadingPunctuation ?? l.text);
      prev.text += (prev.trailingPunctuation ?? "") + (latin ? " " : "") + (l.leadingPunctuation ?? "") + l.text;
      if (l.trailingPunctuation) prev.trailingPunctuation = l.trailingPunctuation;
      else delete prev.trailingPunctuation;
      if (l.syllabic) prev.syllabic = l.syllabic;
      if (prev.source && l.source) prev.source = { ...prev.source, length: l.source.offset + l.source.length - prev.source.offset };
      return;
    }
    joinNext = false;
    out.push(l);
    starts.push(tokStart);
  };

  const mk = (text: string): Lyric => {
    const l: Lyric = { number: verse, text };
    if (prefix && text !== "") {
      l.leadingPunctuation = prefix;
      prefix = "";
    }
    if (valueOffset !== undefined && text !== "") {
      l.source = { line: source.line, column: valueOffset - source.offset + tokStart, offset: valueOffset + tokStart, length: text.length };
    }
    return l;
  };

  while (i < body.length) {
    const ch = body[i]!;
    if (ch === " " || ch === "\t") { i++; continue; }
    tokStart = i;
    if (joinTilde && ch === "~") {
      joinNext = out.length > 0;
      i++;
      continue;
    }
    // 跳一个音符（该音符不配字）
    if (ch === skip) { push(mk("")); i++; continue; }
    if (ch === "*") {
      warn?.("lyric-old-skip", tr("diag.j123.oldSkip"));
      push(mk(""));
      i++;
      continue;
    }
    // 前一音节延长到这个音符
    if (ch === "_") {
      const prev = out[out.length - 1];
      if (prev) prev.extend = true;
      push(mk(""));
      i++;
      continue;
    }
    // 推进到下一小节：对齐自检用，不产生音节
    if (ch === "|") { i++; continue; }
    // 多字一音：`~` 连接，或 `{多字}`
    if (ch === "{") {
      const close = body.indexOf("}", i);
      if (close < 0) { i++; continue; }
      const l = mk(body.slice(i + 1, close));
      i = close + 1;
      // 紧跟的 `-` 同拉丁音节：词内断音节（写出端 `emit123` 会写 `{来”}-`，从前这里读丢，211《等主来》往返不幂等）
      if (body[i] === "-") {
        l.syllabic = "begin";
        i++;
      }
      push(l);
      continue;
    }
    // 转义的真连字符 / 斜杠（拉丁词中间的在下面拉丁分支里吃掉，这里是紧跟在 CJK 或 `}` 后的）
    if (ch === "\\" && (body[i + 1] === "-" || body[i + 1] === "/")) {
      const prev = out[out.length - 1];
      if (prev) prev.text += body[i + 1]!;
      i += 2;
      continue;
    }
    // CJK：一字一音节，随后的收尾标点并进来
    if (isCjk(ch)) {
      let text = ch;
      i++;
      // `~` 把后续词并到同一个音符下。后面是标点（Muse 谱里常见 `样~，`）就只是贴标点，照收尾标点收
      while (body[i] === "~" && body[i + 1] !== undefined) {
        if (trail(body[i + 1]!)) {
          i++;
          break;
        }
        i++;
        text += body[i]!;
        i++;
      }
      let trailing = "";
      while (i < body.length && trail(body[i]!)) {
        trailing += body[i]!;
        i++;
      }
      const l = mk(text);
      if (trailing) l.trailingPunctuation = trailing;
      push(l);
      continue;
    }
    // 左引号：领起**后**一个字，所以先吃住、挂到下一个音节前缀
    if (PU_LYRIC_QUOTES.includes(ch) && isOpenQuote(ch)) {
      const next = body[i + 1];
      if (next !== undefined && isCjk(next)) {
        let text = ch + next;
        i += 2;
        let trailing = "";
        while (i < body.length && trail(body[i]!)) { trailing += body[i]!; i++; }
        const l = mk(text);
        if (trailing) l.trailingPunctuation = trailing;
        push(l);
        continue;
      }
      i++;
      continue;
    }
    // 标点并到前一音节；**前面没字可并时不能丢**——`《圣经》…` 行首那个 `《`
    // 丢了就会让整行少一个字符、往返不稳
    if (trail(ch)) {
      const prev = out[out.length - 1];
      if (prev) prev.trailingPunctuation = (prev.trailingPunctuation ?? "") + ch;
      else prefix += ch;
      i++;
      continue;
    }
    // 拉丁：到空白 / `-` / `_` / 跳音符为止算一个音节；`-` 表示词内断音节，`\-` `\/` 是词里的字面字符
    {
      let j = i;
      let text = "";
      while (j < body.length) {
        const c = body[j]!;
        if (c === "\\" && (body[j + 1] === "-" || body[j + 1] === "/")) { text += body[j + 1]!; j += 2; continue; }
        if (/[\s\-_*|{}\\]/.test(c) || c === skip || isCjk(c) || trail(c) || (joinTilde && c === "~")) break;
        text += c;
        j++;
      }
      if (j === i) { i++; continue; }
      i = j;
      let syllabic: Lyric["syllabic"] | undefined;
      if (body[i] === "-") {
        syllabic = "begin";
        i++;
      }
      let trailing = "";
      while (i < body.length && trail(body[i]!)) { trailing += body[i]!; i++; }
      const l = mk(text);
      if (syllabic) l.syllabic = syllabic;
      if (trailing) l.trailingPunctuation = trailing;
      push(l);
    }
  }
  const res: { syllables: Lyric[]; label?: string; starts: number[] } = { syllables: out, starts };
  if (label !== undefined) res.label = label;
  void source;
  return res;
}



// ───────────────────────── 组装 ─────────────────────────

interface OpenMark {
  type: Mark["type"];
  /** 0 = 还没遇到第一个元素，等 `attach` 回填 */
  start: ElementId;
  level: number;
  tupletActual?: number;
  tupletNormal?: number;
  /** 三连音还差几个音符收尾（ABC §4.13：`(3` 作用于随后 3 个音符，不需要显式收尾）。
   *  123 的多连音由 `)` 收（`ParseDialect.tupletClose`），不用它 */
  remaining?: number;
  /** `(` 在原文里的位置（见 `Mark.openSource`） */
  openSource?: SourceSpan;
  /** 渐强渐弱（`type === "wedge"`） */
  wedgeType?: "crescendo" | "diminuendo";
}

/** `(` 在原文里的位置：123 的 `)` 收最近开的那个，弧与多连音两个栈靠它比先后 */
function openOffset(o: OpenMark): number {
  return o.openSource?.offset ?? -1;
}

/** 把一行音乐体的 token 组装进声部。 */
function buildMusicLine(
  ctx: Ctx,
  pb: PartBuild,
  tokens: readonly Token[],
  marks: Mark[],
): void {
  const { openSlurs, openTuplets, pending, openEnding } = pb;
  // 用对象持有：`attach` 是闭包，直接给局部 let 赋值会让 TS 的控制流分析把它窄成 never
  const cur: {
    last: Element | null;
    sustainHost: Chord | null;
    /** 刚按计数收掉一个多连音——紧随的 `)` 是写谱人的习惯写法，静默消费、不报「多余」 */
    justClosedTuplet: boolean;
    /** 收在「带着增时线的音」上的弧：后面再来增时线，说明弧是收在增时线中间的（`1-)-`），终点改记到当时最后那根增时线上 */
    arcEnds: { mk: Mark; host: Chord; su: Sustain }[];
  } = { last: null, sustainHost: null, justClosedTuplet: false, arcEnds: [] };
  /** ABC：上一个 `-` 还没配到下一个音符（tie 的 stop 端） */
  let pendingTie = false;
  /** ABC：上一个 `>`/`<` 还欠着——正数表示下一个音符要减半、上一个加附点 */
  let pendingBroken = 0;
  /** ABC：结算欠着的 tie 与破碎节奏。123 永远不会触发（那两种 token 不产生）。 */
  const applyTieAndBroken = (ch: Chord): void => {
    if (pendingTie) {
      for (const n of ch.notes) n.tie = { ...(n.tie ?? {}), stop: true };
      pendingTie = false;
    }
    if (pendingBroken !== 0 && cur.sustainHost) {
      // `>` n 个：前音 ×(2-2^-n)、后音 ×2^-n；`<` 反过来
      const k = Math.abs(pendingBroken);
      const f = 1 / (1 << k);
      const prev = cur.sustainHost;
      const long = pendingBroken > 0 ? prev : ch;
      const short = pendingBroken > 0 ? ch : prev;
      const lo = Math.round(long.duration.divisions * (2 - f));
      const sh = Math.round((ctx.d.brokenFromLong ? long : short).duration.divisions * f);
      // **type/dots 必须跟着 divisions 重算**：只改 divisions 会写出 `B/` 却读回
      // 「八分音符 12 divisions」，往返一轮就变形
      long.duration = { ...long.duration, divisions: lo, ...typeAndDots(lo) };
      short.duration = { ...short.duration, divisions: sh, ...typeAndDots(sh) };
      pendingBroken = 0;
    }
  };

  /** 同一符杠组的编号：没有空白相隔的相邻音符同组 */
  let beamGroup = 0;
  let sawSpaceSinceLastNote = true;

  const attach = (el: Element): void => {
    if (pending.chord !== undefined) {
      el.harmony = { root: { step: "C", alter: 0 }, kind: "", text: pending.chord };
      pending.chord = undefined;
    }
    if (pending.annotations.length) {
      const text = pending.annotations.join(" ");
      if (el.kind === "chord") el.sectionWord = text;
      pending.annotations = [];
    }
    if (pending.decos.length) {
      const fermata = pending.decos.some((d) => /^fermata$/i.test(d));
      const arts = pending.decos.filter((d) => !/^fermata$/i.test(d));
      el.notations = {
        ...(fermata ? { fermata: true } : {}),
        ...(arts.length ? { articulations: arts } : {}),
      };
      pending.decos = [];
    }
    if (pending.srcs.length) {
      // `y` 上不落段落词（上面只给 chord 设 sectionWord），它的位置也不记
      const srcs = el.kind === "chord" ? pending.srcs : pending.srcs.filter((a) => a.kind !== "annotation");
      if (srcs.length) el.attachedSources = srcs;
      pending.srcs = [];
    }
    // 上一个 `$` 后面同一小节里又来了音符：那是**小节中间**换行，在原位记一份（`Chord.lineBreakAfter`；
    // `$` 之后才补上的增时线不算——那时换行落在已有的最后一条增时线后面）
    if (pb.inlineBreak) {
      const { host, sustains, kind } = pb.inlineBreak;
      const su = host.sustains ?? [];
      const at = su.length > sustains && sustains > 0 ? su[sustains - 1]! : host;
      at.lineBreakAfter = kind;
      pb.inlineBreak = null;
    }
    // 123：`$` 同时结束这一批歌词（`ParseDialect.breakEndsLyricBlock`），同一代码行里 `$` 之后的音符另起一批
    if (ctx.d.breakEndsLyricBlock && pb.block?.broken) {
      const at = slotCount(pb, ctx.d.lyricSlotRule);
      pb.block.end = at;
      pb.block = { start: at, cursor: new Map(), verses: 0, broken: false };
      pb.afterLyrics = false;
    }
    pb.measure.elements.push(el);
    cur.last = el;
    // 123 的 `~`：弧从前一个音连到这个音（倚音不算「下一个音」）
    if (pb.arcNext && el.kind === "chord" && !el.grace) {
      marks.push({ type: "slur", start: pb.arcNext.from, end: el.id, level: openSlurs.length, openSource: pb.arcNext.source });
      pb.arcNext = null;
    }
    // 回填还没拿到起点的开弧/开连音——它们的起点就是「`(` 之后的第一个元素」
    for (const o of openSlurs) if (!o.start) o.start = el.id;
    for (const o of openTuplets) if (!o.start) o.start = el.id;
    for (const o of pb.openWedges) if (!o.start) o.start = el.id;
    // 123：组内**所有**占时值的元素（音符、`0`、`x`、`X`）都按比例折算；嵌套的比例相乘
    if (ctx.d.tupletClose === "paren" && el.kind === "chord" && !el.grace && openTuplets.length) {
      let actual = 1;
      let normal = 1;
      for (const tp of openTuplets) {
        actual *= tp.tupletActual!;
        normal *= tp.tupletNormal!;
      }
      el.duration.timeMod = { actual, normal };
    }
  };

  for (const t of tokens) {
    switch (t.kind) {
      case "space":
        // 只影响 ABC 的符杠分组（123 不看）。**不能清 `sustainHost`**——`5 - 3 -` 这种带空格的写法是常态，
        // 增时线仍归最近的那个音符
        sawSpaceSinceLastNote = true;
        break;

      case "note": {
        cur.justClosedTuplet = false;
        if (sawSpaceSinceLastNote) beamGroup++;
        sawSpaceSinceLastNote = false;
        const rest = ctx.d.isRest(t);
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          duration: ctx.d.duration(t, ctx.len),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        if (rest) {
          ch.rest = {};
        } else {
          ch.notes.push(ctx.d.note(t));
        }
        if ((t.beams ?? 0) > 0) {
          ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
          if (ctx.d.spaceBeams) ch.beamGroup = beamGroup;
        }
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        // ABC：多连音按音符计数收尾，并给组内音符打 time-modification（123 在 `attach` 里打、由 `)` 收）
        if (ctx.d.tupletClose === "count") for (let k = openTuplets.length - 1; k >= 0; k--) {
          const tp = openTuplets[k]!;
          tp.remaining = (tp.remaining ?? 0) - 1;
          ch.duration.timeMod = { actual: tp.tupletActual ?? 3, normal: tp.tupletNormal ?? 2 };
          if (tp.remaining <= 0) {
            if (tp.start) {
              marks.push({
                type: "tuplet",
                start: tp.start,
                end: ch.id,
                level: 0,
                tupletActual: tp.tupletActual ?? 3,
                tupletNormal: tp.tupletNormal ?? 2,
              });
            }
            openTuplets.splice(k, 1);
            cur.justClosedTuplet = true;
          }
        }
        break;
      }

      case "sustain": {
        // 增时线并进前一个和弦的时值，但**自己有 id**——和弦可以挂在它上面（规范 §8.1，语料 190 次）
        const host = cur.sustainHost;
        if (!host) {
          report(ctx, "orphan-sustain", tr("diag.j123.orphanSustain"), t.source);
          break;
        }
        const s: Sustain = { id: ctx.ids.next(), source: t.source };
        if (pending.chord !== undefined) {
          s.harmony = { root: { step: "C", alter: 0 }, kind: "", text: pending.chord };
          pending.chord = undefined;
          const hs = pending.srcs.filter((a) => a.kind === "harmony");
          if (hs.length) s.attachedSources = hs;
          pending.srcs = pending.srcs.filter((a) => a.kind !== "harmony");
        }
        // 弧收在增时线中间（`1-)-`，文本谱里弧画到第一根增时线为止）：终点记到那根增时线上，写回还是 `1-)-`
        for (const a of cur.arcEnds) if (a.host === host) a.mk.end = a.su.id;
        cur.arcEnds = [];
        (host.sustains ??= []).push(s);
        host.duration = ctx.d.reduration(host, ctx.len);
        sawSpaceSinceLastNote = false;
        break;
      }

      // ── 下面四种只有标准 ABC 会产生（123 的休止走 note(degree=0)、`-` 是增时线）──

      case "rest": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          rest: {},
          duration: ctx.d.duration(t, ctx.len),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        break;
      }

      case "chordGroup": {
        // `[CEG]`：同时发声的几个音 —— `ScoreDoc.Chord.notes[]` 本来就装得下
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: (t.notes ?? []).map((g) => ctx.d.note(g)),
          duration: ctx.d.duration(
            { ...t, num: t.num ?? (t.notes?.[0]?.num ?? 1), den: t.den ?? (t.notes?.[0]?.den ?? 1) },
            ctx.len,
          ),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        break;
      }

      case "arcNext":
        // 123 的后置 `~`：从前一个音连一条弧到下一个音，不进括号栈（规范 §4.1）
        if (pb.arcNext) report(ctx, "orphan-arc-next", "`~` 后面没有音符", pb.arcNext.source);
        if (cur.sustainHost && !cur.sustainHost.grace) pb.arcNext = { from: cur.sustainHost.id, source: t.source };
        else {
          pb.arcNext = null;
          report(ctx, "orphan-arc-next", "`~` 前面没有音符", t.source);
        }
        break;

      case "tie":
        // ABC 的 `-`：给前一个和弦的音打 start，下一个音打 stop
        if (cur.sustainHost) {
          for (const n of cur.sustainHost.notes) n.tie = { ...(n.tie ?? {}), start: true };
          pendingTie = true;
        } else {
          report(ctx, "orphan-tie", tr("diag.j123.orphanTie"), t.source);
        }
        break;

      case "broken":
        // `a>b`：前音附点、后音减半（ABC §4.4）。欠着，等下一个音符来结算
        pendingBroken = t.broken ?? 1;
        break;

      case "rhythm": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          rhythm: true,
          duration: ctx.d.duration(t, ctx.len),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        if ((t.beams ?? 0) > 0) ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        break;
      }

      case "spacer": {
        // **`x` 是不可见休止**：有时值、占对位格（对应文本谱的隐藏休止 `8`），
        // 所以它是 `Chord`（rest + printObject=false）而不是 `Space`——
        // 若做成 `Space`，`attachLyrics` 不给它配词而 emit 的对位槽又含它，歌词就会错一格。
        // **`y` 才是 `Space`**：无时值、不占对位格，只为挂和弦（规范 §8.1）。
        if (t.value === "x") {
          const ch: Chord = {
            kind: "chord",
            id: ctx.ids.next(),
            notes: [],
            rest: {},
            printObject: false,
            duration: ctx.d.duration(t, ctx.len),
            voice: pb.voice,
            staff: 1,
            source: t.source,
          };
          if ((t.beams ?? 0) > 0) ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
          attach(ch);
          cur.sustainHost = ch;
          if (pb.voice === 1) pb.noteCount++;
          break;
        }
        const sp: Space = {
          kind: "space",
          id: ctx.ids.next(),
          spacer: "y",
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        attach(sp);
        cur.sustainHost = null;
        break;
      }

      case "chord":
        // Muse 的引号不分和弦与文字（都印在音符上方）：同一个音前两段引号，前一段是文字（写出端先写文字，`emitjcx.ts`），
        // 不能让后一段顶掉（谱例 `"Ⅴ""(玄乐)"`、123 转来的 `"Chorus""E7"`）
        if (ctx.d.id === "jcx" && pending.chord !== undefined) {
          pending.annotations.push(pending.chord);
          for (const a of pending.srcs) if (a.kind === "harmony") a.kind = "annotation";
        }
        pending.chord = t.value ?? "";
        // 连写两个和弦名只留后一个（上面覆盖），位置也只留后一个
        pending.srcs = pending.srcs.filter((a) => a.kind !== "harmony");
        pending.srcs.push({ kind: "harmony", name: pending.chord, source: t.source });
        break;

      case "annotation":
        // `"^文字"` / `"_文字"`（ABC §4.19 的注记，`^` 上方 `_` 下方）——
        // 段落词（`（副歌）` 这类）就走这条，与 emit 对称
        pending.annotations.push((t.value ?? "").replace(/^[\^_<>@]/, ""));
        pending.srcs.push({ kind: "annotation", name: pending.annotations[pending.annotations.length - 1]!, source: t.source });
        break;

      case "deco": {
        const deco = t.value ?? "";
        // 跳转记号不是音符上的装饰，而是挂在小节线上的（`Barline.ornaments`）。
        // 写在线**之后**（小节还一个元素都没有）的是**左线**上的记号——segno/coda 这类跳转目标；
        // 写在线之前的攒着，等下面 `case "barline"` 把它挂到那条右线上。
        const jump = jumpOrnamentName(deco);
        if (jump && pb.measure.elements.length === 0) {
          const bls = (pb.measure.barlines ??= []);
          const left = bls.find((b) => b.location === "left");
          if (left) (left.ornaments ??= []).push({ name: jump, level: 0 });
          else bls.push({ location: "left", ornaments: [{ name: jump, level: 0 }], source: t.source });
          break;
        }
        pending.decos.push(deco);
        pending.srcs.push({ kind: "deco", name: deco, source: t.source });
        break;
      }

      case "grace": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: (t.notes ?? []).map((g) => ctx.d.note(g)),
          duration: { divisions: 0, dots: 0, type: graceType(t.notes?.[0]) },
          grace: { ...(t.acciaccatura ? { slash: true } : {}), ...(t.graceAfter ? { after: true } : {}) },
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        pb.measure.elements.push(ch);
        break;
      }

      case "slurStart":
        // 起点未定：等 `attach` 把「`(` 之后的第一个元素」回填进来
        openSlurs.push({ type: "slur", start: 0, level: openSlurs.length, openSource: t.source });
        break;

      case "slurEnd": {
        // 123：`)` 收**最近开的那个**括号，圆滑线与多连音同一套嵌套（规范 §4「多连音」）。
        // 谁更近看 `(` 在原文里的位置——两者各有一个栈，但在原文里是交替嵌套的
        if (ctx.d.tupletClose === "paren") {
          const tp = openTuplets[openTuplets.length - 1];
          const sl = openSlurs[openSlurs.length - 1];
          if (tp && (!sl || openOffset(tp) > openOffset(sl))) {
            openTuplets.pop();
            if (tp.start && cur.last) {
              marks.push({
                type: "tuplet",
                start: tp.start,
                end: cur.last.id,
                level: 0,
                tupletActual: tp.tupletActual!,
                tupletNormal: tp.tupletNormal!,
              });
            } else {
              report(ctx, "empty-tuplet", tr("diag.j123.emptyTuplet"), t.source);
            }
            break;
          }
        }
        // **`)` 是二义符号**：收圆滑线 还是 收多连音？判据照 `.jpwabc` 那条
        // （`docs/模块/源格式-jpwabc.md`：「前面的音符还欠着 `(` 就先收弧，欠完了才轮到三连音」）——
        // ABC 的多连音本不需要 `)`，但写谱人习惯带上，照收不误。
        if (openSlurs.length === 0 && ctx.d.tupletClose === "count") {
          if (cur.justClosedTuplet) {
            cur.justClosedTuplet = false;
            break;
          }
          const tp = openTuplets.pop();
          if (tp) {
            if (tp.start && cur.last) {
              marks.push({
                type: "tuplet",
                start: tp.start,
                end: cur.last.id,
                level: 0,
                tupletActual: tp.tupletActual ?? 3,
                tupletNormal: tp.tupletNormal ?? 2,
              });
            }
          } else {
            report(ctx, "unmatched-slur", tr("diag.j123.extraParen"), t.source);
          }
          break;
        }
        if (openSlurs.length === 0) {
          report(ctx, "unmatched-slur", tr("diag.j123.extraParen"), t.source);
          break;
        }
        // 一个音符**收一条又起一条**（ABC §4.11 `(c d (e) f g a)` = c→e、e→a 两条）：栈顶那条正是
        // 在本音符上刚起的，`)` 收的是它底下那条更早的；只有一条开着时 `(1)` 才是单音弧。
        // 识别出的 `5 3 3` 上外弧 + 首尾相接的两条内弧就写作 `((5 (3) 3))`（1863）。
        // 123 里这条特判只在「下面那层也是弧」时走：两条弧之间夹着一个开着的多连音，就按单音弧收
        const top = openSlurs[openSlurs.length - 1];
        const below = openSlurs[openSlurs.length - 2];
        const innerTuplet = openTuplets[openTuplets.length - 1];
        const chain = top && top.start && top.start === cur.last?.id && below
          && !(ctx.d.tupletClose === "paren" && innerTuplet && openOffset(innerTuplet) > openOffset(below));
        const open = chain ? openSlurs.splice(openSlurs.length - 2, 1)[0] : openSlurs.pop();
        if (!open) {
          report(ctx, "unmatched-slur", tr("diag.j123.extraParen"), t.source);
          break;
        }
        // `open.start` 由 `attach` 回填；同音起止（`(1)`）时起点就是终点，合法（ABC §4.11）
        if (open.start && cur.last) {
          const mk: Mark = { type: "slur", start: open.start, end: cur.last.id, level: open.level, closeSource: t.source };
          if (open.openSource) mk.openSource = open.openSource;
          marks.push(mk);
          const host = cur.sustainHost;
          const su = host && host === cur.last ? host.sustains?.[host.sustains.length - 1] : undefined;
          if (host && su) cur.arcEnds.push({ mk, host, su });
        } else {
          report(ctx, "empty-slur", tr("diag.j123.emptySlur"), t.source);
        }
        break;
      }

      case "wedge": {
        // Muse 的 `(<` … `<)`：起点等 `attach` 回填（同圆滑线），收在当时最后一个元素上
        const [type, edge] = (t.value ?? "").split(" ") as ["crescendo" | "diminuendo", string];
        if (edge === "start") {
          pb.openWedges.push({ type: "wedge", start: 0, level: 0, wedgeType: type, openSource: t.source });
          break;
        }
        const k = pb.openWedges.map((o) => o.wedgeType).lastIndexOf(type);
        const open = k >= 0 ? pb.openWedges.splice(k, 1)[0]! : undefined;
        if (open?.start && cur.last) {
          marks.push({ type: "wedge", start: open.start, end: cur.last.id, wedgeType: type, ...(open.openSource ? { openSource: open.openSource } : {}), closeSource: t.source });
        } else {
          report(ctx, "unmatched-wedge", tr("diag.jcx.wedge"), t.source);
        }
        break;
      }

      case "tuplet": {
        const actual = Number(t.value ?? 3);
        openTuplets.push({
          type: "tuplet",
          start: 0,
          level: 0,
          tupletActual: actual,
          // p 是「占几个的时间」，没写（0）取方言的默认表（`ParseDialect.tupletNormal`）
          tupletNormal: t.numbers?.[1] || ctx.d.tupletNormal(actual, ctx.time),
          // ABC `(n:p:q` 的 q 是「作用于几个音符」，缺省就是 n（123 由 `)` 收，不用它）
          remaining: t.numbers?.[2] || actual,
          openSource: t.source,
        });
        break;
      }

      case "ending": {
        // `[N` 标记第 N 房**开始**（ABC §4.9/§4.10），它总出现在小节开头，
        // 所以挂在**所属小节的左线**上；房号的 stop 由后面那根结束线给出
        let nums = t.numbers ?? [];
        let text = nums.join(",");
        // Muse：房号写 0 时，小节线前引号里的字就是房号文字（`"1、3"|0`，说明书 §3.2.3.11）
        if (ctx.d.id === "jcx" && nums.length === 1 && nums[0] === 0 && pending.chord !== undefined) {
          text = pending.chord;
          nums = (text.match(/\d+/g) ?? ["1"]).map(Number);
          pending.chord = undefined;
          pending.srcs = pending.srcs.filter((a) => a.kind !== "harmony");
        }
        const ending = { numbers: nums, type: "start" as const, text };
        // `|1` 会先产生一根左线，房号挂到它上面；行首直接写 `[1` 时才新建
        const existingLeft = (pb.measure.barlines ?? []).find((b) => b.location === "left");
        if (existingLeft) existingLeft.ending = ending;
        else (pb.measure.barlines ??= []).push({ location: "left", ending, source: t.source });
        openEnding.push(nums);
        break;
      }

      case "barline": {
        const bl = barlineFrom(t.value ?? "normal", t.repeatTimes, t.source);
        // 线**之前**攒下的跳转记号（`… 6 !fine! |]`）挂这条线，别落到音符的 articulations 上
        // **右线**（小节里已有音符）之前攒下的其余记号也是这条线上的（文本谱 `|&ykh` 的右括弧，写出端同样写在线前）：
        // 音符的装饰总写在音符之前，线前的后面没有音符可挂，留着会落到下一行头一个音上或在曲末丢掉
        const onLine = (d: string): boolean => !!jumpOrnamentName(d) || pb.measure.elements.length > 0;
        const taken = pending.decos.filter(onLine);
        if (taken.length) {
          pending.decos = pending.decos.filter((d) => !onLine(d));
          pending.srcs = pending.srcs.filter((a) => a.kind !== "deco" || !onLine(a.name));
          bl.ornaments = taken.map((d) => ({ name: jumpOrnamentName(d) ?? d, level: 0 }));
        }
        // **小节里还没有元素 = 这是左线**（行首的 `|`、或紧跟上一根），不收尾，
        // 否则会凭空多出一个空小节
        // 例外：前面已经收过小节、这根又是**只能当右线**的终止线/双线/反复收（`… | |]`、`… :| ||`）——
        // 它是一个只有右线的空小节（文本谱曲末常见），当成左线的话后面没有小节可挂、写回就丢了
        const closesEmpty = pb.part.measures.length > 0 && !pb.measure.barlines?.length && bl.repeat !== "forward"
          && (bl.style === "light-heavy" || bl.style === "light-light");
        if (pb.measure.elements.length === 0 && !closesEmpty) {
          bl.location = "left";
          (pb.measure.barlines ??= []).push(bl);
          break;
        }
        // 结束类小节线收掉开着的房号
        const isEndingStop = ["light-light", "light-heavy", "heavy-light"].includes(bl.style ?? "");
        if (isEndingStop && openEnding.length) {
          const nums = openEnding.pop()!;
          bl.ending = { numbers: nums, type: "stop", text: nums.join(",") };
        }
        (pb.measure.barlines ??= []).push(bl);
        pb.inlineBreak = null; // `$` 之后先到的是小节线：小节末换行，小节级那一份就够了
        closeMeasure(ctx, pb);
        beamGroup = 0;
        sawSpaceSinceLastNote = true;
        cur.sustainHost = null;
        // 多连音跨不过小节线，收掉。123 要求 `)`，走到这里就是漏写了
        if (ctx.d.tupletClose === "paren") {
          for (const tp of openTuplets) report(ctx, "unclosed-tuplet", tr("diag.j123.tupletOpen"), tp.openSource ?? t.source);
        }
        openTuplets.length = 0;
        break;
      }

      case "overlay": {
        // ABC §7.4：`&` 把时间退回本小节起点，后面是与前一分支**同时发声**的临时声部。
        // 这里只切声部号（元素仍按原文顺序存在同一个小节里），小节内各声部的实际起点
        // 由投影按每声部的游标算（`model/xmlproject.ts`），因为那时才折算完多连音与 divisions。
        if (openSlurs.length) {
          report(ctx, "overlay-open-slur", tr("diag.j123.slurOverlay"), t.source);
          openSlurs.length = 0;
        }
        if (openTuplets.length) {
          report(ctx, "overlay-open-tuplet", tr("diag.j123.tupletOverlay"), t.source);
          openTuplets.length = 0;
        }
        if (pb.arcNext) {
          report(ctx, "orphan-arc-next", "`~` 后面没有音符", pb.arcNext.source);
          pb.arcNext = null;
        }
        if (!pb.measure.elements.some((el) => el.voice === pb.voice)) {
          report(ctx, "empty-overlay", tr("diag.j123.overlayBefore"), t.source);
        }
        pb.voice++;
        pb.overlaySource = t.source;
        // 分支各自从头计时，所以分支间的状态一律不继承：tie、破碎节奏、增时线宿主、符杠分组
        pendingTie = false;
        pendingBroken = 0;
        cur.sustainHost = null;
        cur.last = null;
        cur.justClosedTuplet = false;
        beamGroup++;
        sawSpaceSinceLastNote = true;
        break;
      }

      case "break": {
        // `$` 的语义是「**这一小节之后**换行」。小节线通常先到、当前小节已被推进 `measures`，
        // 所以要赋给刚收尾的那一个；否则每次往返都会把换行往后挪一格。
        const target = pb.measure.elements.length > 0
          ? pb.measure
          : pb.part.measures[pb.part.measures.length - 1] ?? pb.measure;
        ctx.breakAfter.set(target, t.value === "page" ? "page" : "system");
        (pb.part.breakSources ??= []).push({ page: t.value === "page", after: lastElementId(pb), source: t.source });
        noteInlineBreak(pb, t.value === "page" ? "page" : "system");
        if (pb.block) pb.block.broken = true;
        break;
      }

      case "inlineField": {
        const m = /^([A-Za-z])\s*[:：]\s*(.*)$/.exec(t.value ?? "");
        if (!m) break;
        const name = m[1]!.toUpperCase();
        const val = m[2] ?? "";
        pb.measure.attrs ??= {};
        if (name === "K") {
          const r = ctx.d.parseKey(val);
          if (r.error) report(ctx, "bad-key", r.error, t.source);
          pb.measure.attrs.key = r.key;
        } else if (name === "M") {
          // Muse 野外文件有 `[M:4/4/]` 这种笔误（Muse 自己照读）：只取开头的 `n/m`
          const r = parseTime(ctx.d.id === "jcx" ? /^\s*(\d+\s*\/\s*\d+|C\|?)/i.exec(val)?.[1] ?? val : val);
          if (r.error) report(ctx, "bad-time", r.error, t.source);
          else if (r.time) {
            pb.measure.attrs.time = r.time;
            ctx.time = r.time;
          }
        } else if (name === "L") {
          // 曲中改默认音长（ABC §3.1.7；Muse 的 FAQ 就教这么写：一段一拍、一段半拍的谱）。123 的时值不看它
          const lm = /^(\d+)\s*\/\s*(\d+)$/.exec(val.trim());
          if (lm && Number(lm[2]) > 0) ctx.len = pb.len = { num: Number(lm[1]), den: Number(lm[2]) };
          else report(ctx, "bad-length", tr("diag.j123.badLength", { v: val }), t.source);
        }
        break;
      }

      case "unknown":
        break;
    }
  }
}

/** 小节收尾：推进到下一小节。空小节（连续两根小节线）不产生。 */
/**
 * 123/ABC 的房号约定：**一组房的最后一房不封口**。ABC 本身没有区分封口与否的写法（ABC §4.9/§4.10：房号止于
 * 双线、反复线或下一房的开始），读入时结束类小节线一律收成 `stop`；这里把「后面不再紧跟一房」的那个 `stop`
 * 改记 `discontinue`。排版器（简谱引擎、原样文档布局、五线谱）只照模型里的值画，不再各自判断；
 * MusicXML、文本谱照各自原文。
 */
function markLastEndings(part: Part): void {
  const ms = part.measures;
  ms.forEach((m, i) => {
    for (const b of m.barlines ?? []) {
      if (b.location !== "right" || b.ending?.type !== "stop") continue;
      const next = ms[i + 1];
      if (!next?.barlines?.some((x) => x.location === "left" && x.ending?.type === "start")) b.ending.type = "discontinue";
    }
  });
}

function closeMeasure(ctx: Ctx, pb: PartBuild): void {
  if (pb.measure.elements.length === 0 && !pb.measure.barlines?.length) return;
  // 末尾那个分支是空的（`… & |`）：`&` 写了却没有音，多半是漏了内容
  if (pb.voice > 1 && pb.overlaySource && !pb.measure.elements.some((el) => el.voice === pb.voice)) {
    report(ctx, "empty-overlay", tr("diag.j123.overlayAfter"), pb.overlaySource);
  }
  pb.overlaySource = undefined;
  pb.part.measures.push(pb.measure);
  pb.measureNo++;
  pb.measure = { number: String(pb.measureNo), elements: [] };
  pb.noteCount = 0;
  // `&` 的临时声部只活到小节线（ABC §7.4），下一小节从主声部重新开始
  pb.voice = 1;
}

/** 把 `I:playorder` 的「第几个音符」换成元素 id。 */
function resolvePlayOrder(song: Song, raw: readonly RawPlayPass[]): PlayPass[] {
  const out: PlayPass[] = [];
  const part = song.parts[0];
  for (const r of raw) {
    const p: PlayPass = { fromMeasure: r.fromMeasure, toMeasure: r.toMeasure };
    if (r.verse !== undefined) p.verse = r.verse;
    if (r.pageBreakAfter) p.pageBreakAfter = true;
    if (part) {
      if (r.fromNoteIndex !== undefined) {
        const id = nthNoteId(part, r.fromMeasure, r.fromNoteIndex);
        if (id !== undefined) p.fromElement = id;
      }
      if (r.toNoteIndex !== undefined) {
        const id = nthNoteId(part, r.toMeasure, r.toNoteIndex);
        if (id !== undefined) p.toElement = id;
      }
    }
    out.push(p);
  }
  return out;
}

/** 第 `measureNo` 小节（1 基）里第 `n` 个音符（1 基）的元素 id。 */
function nthNoteId(part: Part, measureNo: number, n: number): ElementId | undefined {
  const m = part.measures[measureNo - 1];
  if (!m) return undefined;
  let k = 0;
  for (const el of m.elements) {
    if (el.kind === "chord" && !el.grace) {
      k++;
      if (k === n) return el.id;
    }
  }
  return undefined;
}

/** 歌词挂到对位格上：从 `start` 格起、到 `end` 格为止（歌词块的范围，规范 §5.1）。
 *
 *  返回**超出块尾、有字的音节数**。多余的被忽略（ABC §5.1 的标准行为），
 *  但必须报出来——ABC 规范自己就写了「the program should warn the user」，
 *  而静默丢字在语料迁移时是灾难（迁移报表要靠这条诊断发现对位错）。
 *  超出的只是 `_` 与跳音符不算：行末 melisma 写 `主_`，那个 `_` 本就落在下一行的格上。 */
function attachLyrics(
  slots: readonly Element[],
  syllables: readonly Lyric[],
  start: number,
  end: number,
): number {
  let over = 0;
  for (let si = 0; si < syllables.length; si++) {
    const syl = syllables[si]!;
    const k = start + si;
    if (k >= end || k >= slots.length) {
      if (syl.text !== "") over++;
      continue;
    }
    if (syl.text === "" && !syl.extend) continue; // 跳音符：该音符不配字
    (slots[k]!.lyrics ??= []).push(syl);
  }
  return over;
}

export interface ParseOptions {
  /** 文件名，仅用于诊断 */
  name?: string;
}

/** `.123` 文本 → `ScoreDoc`。 */
/** 倚音不占拍（divisions 0），印出来的时值记在 `type` 上。长度**相对倚音单位（八分）**
 *  （ABC 2.1 §4.12：花括号里照普通音符写长度，单位另定）：123 每个 `_` 减半（`{2_}` 十六分），
 *  ABC 按 num/den（`{d/}` 十六分、`{d2}` 四分）；什么都不写就是八分。 */
function graceType(g: Token | undefined): NoteType {
  const ratio = (g?.num ?? 1) / (g?.den ?? 1) / 2 ** (g?.beams ?? 0);
  const k = Math.round(Math.log2(ratio));
  return (["64th", "32nd", "16th", "eighth", "quarter", "half"] as const)[Math.max(0, Math.min(5, k + 3))]!;
}

export function parse123(text: string, options: ParseOptions = {}): ScoreDoc {
  return parseAbcFamily(text, DIALECT_123, options);
}

/** `.abc` 文本 → `ScoreDoc`（**原生解析**，不经 MusicXML）。
 *
 *  为什么不转 MusicXML 再读：那条路把源字符偏移丢光了，编辑器的双向定位最多到小节级、
 *  往返也只能「原文或全量重写」二选一。见 `docs/模块/源格式-abc家族.md`。 */
export function parseAbc(text: string, options: ParseOptions = {}): ScoreDoc {
  return parseAbcFamily(text, DIALECT_ABC, options);
}

/** Muse 曲谱软件的 `.jcx` 文本 → `ScoreDoc`（原生解析，ABC 家族的第三个方言）。
 *  见 `docs/格式/jcx.md`；字节 → 文本的编码判断在 `common/jcxcodec.ts`。 */
export function parseJcx(text: string, options: ParseOptions = {}): ScoreDoc {
  return parseAbcFamily(text, DIALECT_JCX, options);
}

/** Muse `V:` 声明的一个参数值：`name="主旋律"`、`nm=“Violin I”`（说明书用的是中文弯引号）、`snm=女`。 */
function museParam(value: string, names: readonly string[]): string | undefined {
  for (const n of names) {
    const m = new RegExp(`(?:^|\\s)${n}\\s*=\\s*(?:"([^"]*)"|“([^”]*)”|(\\S+))`).exec(value);
    if (m) return m[1] ?? m[2] ?? m[3];
  }
  return undefined;
}

/** Muse 的 `V:<标志> style=jianpu name=… ins=… vol=…`（说明书 §3.2.2 表 2）：认音轨类型与名字，其余参数原文留给写出端。
 *  只在声明那一处读（正文里的 `[V:x]` 只是切声部）。 */
function museVoiceAttrs(ctx: Ctx, b: PartBuild, f: FieldLine): void {
  if (b.museStyle !== undefined) return;
  const rest = f.value.trim().replace(/^\S+\s*/, "");
  const style = (/(?:^|\s)style\s*=\s*(\S+)/.exec(rest)?.[1] ?? "jianpu").toLowerCase();
  if (style === "staff") b.museStyle = "staff";
  else if (style === "jianpu") b.museStyle = "jianpu";
  else {
    b.museStyle = "skip";
    report(ctx, "jcx-track-skipped", tr("diag.jcx.trackSkipped", { style }), f.source);
  }
  const name = museParam(rest, ["name", "nm"]);
  if (name !== undefined && b.part.name === undefined) b.part.name = name;
  const abbrev = museParam(rest, ["sname", "snm"]);
  if (abbrev !== undefined && b.part.abbrev === undefined) b.part.abbrev = abbrev;
  const extra = rest
    .replace(/(?:^|\s)(?:style|name|nm|sname|snm)\s*=\s*(?:"[^"]*"|“[^”]*”|\S+)/g, "")
    .trim();
  if (extra) b.part.museAttrs = extra;
}

/** Muse 的五线谱轨（`style=staff`）：字母是**绝对音名**（同 ABC），读进来时按简谱轨的口径记成了度数，这里改回音名，
 *  随后与 ABC 同走 `resolveAbcPitches`（按调号与小节内延续定实际音高，再推度数）。 */
function museStaffPitches(part: Part): void {
  const alterOf: Readonly<Record<string, number>> = { "double-flat": -2, flat: -1, natural: 0, sharp: 1, "double-sharp": 2 };
  for (const m of part.measures) {
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      for (const n of el.notes) {
        const d = n.degree;
        if (!d || d.number < 1) continue;
        n.pitch = {
          step: LETTER_OF_DEGREE[d.number - 1] as NonNullable<typeof n.pitch>["step"],
          alter: n.accidental ? alterOf[n.accidental] ?? 0 : 0,
          octave: 4 + d.octaveShift,
        };
        delete n.degree;
      }
    }
  }
}

/** ABC 家族的通用解析：**组装逻辑两种方言共用**，差异全在 `dialect` 那几个钩子里。
 *  见 `docs/模块/源格式-abc家族.md`。 */
export function parseAbcFamily(
  text: string,
  dialect: ParseDialect,
  options: ParseOptions = {},
): ScoreDoc {
  void options;
  const doc = emptyDoc(dialect.id);
  doc.source = text;
  const ids = new IdGen();
  const ctx: Ctx = {
    ids,
    diagnostics: doc.diagnostics,
    lineNo: 0,
    lineOffset: 0,
    d: dialect,
    len: dialect.defaultLen(4, 4),
    sawL: false,
    time: null,
    breakAfter: new Map(),
  };

  const lines = text.split(/\r?\n/);
  const starts = lineStarts(text);
  let song: Song | null = null;
  /** 当前声部 */
  let pb: PartBuild | null = null;
  /** 本曲各声部，按首次出现的顺序。`V:n` 再次出现是**续写**该声部（ABC 语义，交错写法靠它） */
  let builds = new Map<number, PartBuild>();
  let rawPlay: RawPlayPass[] = [];
  let marks: Mark[] = [];
  /** 待挂的歌词行：整首读完、小节都收尾后才挂 */
  let pendingLyrics: PendingLyric[] = [];

  const finishSong = (): void => {
    if (!song) return;
    for (const b of builds.values()) {
      if (ctx.d.tupletClose === "paren") {
        for (const tp of b.openTuplets) report(ctx, "unclosed-tuplet", tr("diag.j123.tupletOpen"), tp.openSource!);
        b.openTuplets.length = 0;
      }
      if (b.arcNext) {
        report(ctx, "orphan-arc-next", "`~` 后面没有音符", b.arcNext.source);
        b.arcNext = null;
      }
      for (const w of b.openWedges) report(ctx, "unmatched-wedge", tr("diag.jcx.wedge"), w.openSource!);
      b.openWedges.length = 0;
      closeMeasure(ctx, b);
      markLastEndings(b.part);
      if (b.block && b.block.end === undefined) b.block.end = slotCount(b, ctx.d.lyricSlotRule);
      const first = b.part.measures[0];
      if (b.clef && first) (first.attrs ??= {}).clefs = [b.clef];
      if (b.museStyle === "staff") museStaffPitches(b.part);
      if (b.part.measures.length && b.museStyle !== "skip") song.parts.push(b.part);
    }
    const slotsOf = new Map<Part, Element[]>();
    for (const { f, verse, syl, part, block, start } of pendingLyrics) {
      // 歌词挂在它**紧跟的那个声部**上（四声部谱里词常挂在某一个声部下）
      let slots = slotsOf.get(part);
      if (!slots) slotsOf.set(part, (slots = lyricSlots(part, undefined, undefined, undefined, undefined, ctx.d.lyricSlotRule).slots));
      const left = attachLyrics(slots, syl, start, block.end ?? slots.length);
      if (left > 0) {
        report(
          ctx,
          "lyric-overflow",
          tr("diag.j123.lyricOverflow", { verse, left }),
          f.source,
        );
      }
    }
    pendingLyrics = [];
    // **ABC 只给音名，简谱那一侧要度数**（排版、`emit123`、播放都按度数走）。
    // 先按调号与小节内延续把音名换成实际音高，度数再从音高推（`abcpitch.ts`，写出端同一份规则）。
    // Muse 的五线谱轨同此（`museStaffPitches` 已把字母落成音名）；简谱轨的音没有音高，这一步不碰它们
    if (ctx.d.id === "abc" || [...builds.values()].some((b) => b.museStyle === "staff")) resolveAbcPitches(song);
    for (const part of song.parts) breaksAfterToStart(part, ctx.breakAfter);
    ctx.breakAfter.clear();
    song.marks = marks;
    if (rawPlay.length) song.playOrder = resolvePlayOrder(song, rawPlay);
    doc.songs.push(song);
    song = null;
    pb = null;
    builds = new Map();
    voiceIds = new Map();
    marks = [];
    rawPlay = [];
  };

  const ensureSong = (): Song => {
    if (!song) song = emptySong();
    return song;
  };
  const newPart = (voice: number): PartBuild => ({
    part: { id: `P${voice}`, measures: [] },
    measure: { number: "1", elements: [] },
    noteCount: 0,
    measureNo: 1,
    voice: 1,
    openSlurs: [],
    openTuplets: [],
    pending: { annotations: [], decos: [], srcs: [] },
    openEnding: [],
    afterLyrics: false,
    inlineBreak: null,
    arcNext: null,
    openWedges: [],
  });
  /** `V:n` 切到声部 n：没有就新开，有就**续写**（不收尾它开着的小节）。四声部谱靠这个分开，否则会被拼成一串小节。 */
  const startPart = (voice: number): PartBuild => {
    ensureSong();
    let b = builds.get(voice);
    if (!b) builds.set(voice, (b = newPart(voice)));
    pb = b;
    return b;
  };
  const ensurePart = (): PartBuild => pb ?? startPart(1);
  /** Muse 的音轨标志可以是任意名字（说明书 §3.2.2「V:音轨」），按首次出现的顺序编成 1、2、3… */
  let voiceIds = new Map<string, number>();
  const museVoice = (label: string): number => {
    let n = voiceIds.get(label);
    if (n === undefined) voiceIds.set(label, (n = voiceIds.size + 1));
    return n;
  };
  /** 行首的 `[V:x]`：切声部（说明书 §3.2.3.1「在每一行乐谱的开头加上 [V: <音轨标志>]」，ABC §7 同）。
   *  返回这一行剩下的音乐从第几列起；不是这种行返回 0。ABC 只认数字声部号（同 `fields.ts` 的 `V:`）。 */
  const inlineVoice = (raw: string): number => {
    const m = /^\s*\[V\s*[:：]\s*([^\]]*)\]/.exec(raw);
    if (!m) return 0;
    const label = m[1]!.trim().split(/\s+/)[0] ?? "";
    if (ctx.d.id === "jcx") startPart(museVoice(label));
    else if (/^\d+$/.test(label)) startPart(Number(label));
    else return 0;
    return m[0].length;
  };
  /** Muse 的 `%%begintext` … `%%endtext` 文字块（说明书 §3.2.6.5）：块里是裸文字，不能当音乐读 */
  let textBlock: { lines: string[]; source: SourceSpan } | null = null;

  /** 上一条字段名：`+:` 续行接着写它（ABC §3.1.18） */
  let lastField: FieldName | undefined;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!;
    const lineOffset = starts[ln]!;
    ctx.lineNo = ln;
    ctx.lineOffset = lineOffset;
    const line = raw.trim();
    if (textBlock) {
      if (/^%%\s*endtext\b/i.test(line)) {
        (ensureSong().remarks ??= []).push(textBlock.lines.join("\n"));
        textBlock = null;
      } else {
        textBlock.lines.push(line);
      }
      continue;
    }
    if (line === "") continue;
    // 版本声明与注释
    if (line.startsWith("%")) {
      // Muse 的 `%%` 是它自己的排版参数（字体、页边、行距，说明书 §3.2.6），不是 ABC 指令：
      // 原文另存（`Song.museDirectives`，只写回 `.jcx`），不按 `I:` 解释、不进 `style.raw`（那是本项目的版面指令）；文字块另收
      if (ctx.d.id === "jcx" && line.startsWith("%%")) {
        if (/^%%\s*begintext\b/i.test(line)) textBlock = { lines: [], source: { line: ln, column: 0, offset: lineOffset, length: raw.length } };
        else if (!/^%%\s*endtext\b/i.test(line)) (ensureSong().museDirectives ??= []).push(line.slice(2).trim());
        continue;
      }
      // `%%directive` 等价 `I:directive`（ABC §11.0.2）
      if (line.startsWith("%%")) {
        applyInstruction(ctx, ensureSong(), parseInstruction(line.slice(2)), { line: ln, column: 0, offset: lineOffset, length: raw.length }, (r) => { rawPlay = rawPlay.concat(r); });
      }
      continue;
    }

    // 行首 `[V:x]`：切声部，同一行后面接着的是这个声部的音乐
    const musicFrom = ctx.d.id === "123" ? 0 : inlineVoice(raw);
    if (musicFrom > 0 && raw.slice(musicFrom).trim() === "") continue;

    const f = musicFrom > 0 ? null : parseFieldLine(raw, ln, lineOffset);
    if (f && ctx.d.id === "jcx") {
      // Muse 把 `W:` 也当歌词行用（谱例《爱的诫命》《充满我》），`V:` 的标志是名字
      if (f.name === "W") f.name = "w";
      if (f.name === "V") f.voice = museVoice(f.value.split(/\s+/)[0] ?? "");
    }
    if (f) {
      // `+:` 续行（ABC §3.1.18）：只支持歌词行——`w:` 太长要拆几条写时用它，
      // 别的字段续行语料里没有、也没有消费方，报一条提示后丢掉
      if (f.cont) {
        if (lastField === "w") addLyricLine(ctx, ensurePart(), f, pendingLyrics);
        else {
          report(ctx, "cont-unsupported", tr("diag.j123.contUnsupported"), f.source);
        }
        continue;
      }
      lastField = f.name;
      // `X:` 开新曲
      if (f.name === "X") {
        finishSong();
        const s = ensureSong();
        s.work.number = f.value;
        continue;
      }
      if (f.name === "w") {
        const lp = ensurePart();
        if (lp.museStyle !== "skip") addLyricLine(ctx, lp, f, pendingLyrics);
        continue;
      }
      applyField(ctx, ensureSong(), f, startPart, (r) => { rawPlay = rawPlay.concat(r); });
      continue;
    }

    // 音乐体
    lastField = undefined;
    const s = ensureSong();
    void s;
    const p = ensurePart();
    // Muse 的吉他谱、尤克里里谱轨（`style=tab`/`ukulele`）不读：报过一次，这里静默跳过
    if (p.museStyle === "skip") continue;
    // 上一块已经跟过歌词（或还没有块）：这一行开新歌词块
    if (!p.block || p.afterLyrics || p.block.broken) {
      const at = slotCount(p, ctx.d.lyricSlotRule);
      if (p.block) p.block.end = at;
      p.block = { start: at, cursor: new Map(), verses: 0, broken: false };
      p.afterLyrics = false;
    }
    const lex = ctx.d.lex(raw.slice(musicFrom), ln, lineOffset, musicFrom);
    for (const e of lex.errors) report(ctx, "lex", e.message, e.source);
    // 这个声部自己的默认音长（行内 `[L:]` 改过的）只在读它的行时生效，读完还回头部那一份
    const headerLen = ctx.len;
    if (p.len) ctx.len = p.len;
    buildMusicLine(ctx, p, lex.tokens, marks);
    ctx.len = headerLen;
    // ABC §6.1：**代码里的换行就是谱面换行**（默认 `I:linebreak <EOL>`）。
    // 123 不吃这一条——它用显式的 `$`，简谱一行常写得很长，不该被源码折行绑死。
    // 语义同 `$`：「这一小节之后换行」，所以挂在刚收尾的那一个上。
    if (ctx.d.lineEndIsBreak) {
      const target = p.measure.elements.length > 0
        ? p.measure
        : p.part.measures[p.part.measures.length - 1];
      if (target && !ctx.breakAfter.has(target)) {
        ctx.breakAfter.set(target, "system");
        noteInlineBreak(p, "system");
      } else if (target === p.measure && p.inlineBreak?.host !== p.measure.elements[p.measure.elements.length - 1]) {
        // 同一小节里第二个代码行末：又是一刀小节中间换行（行尾写了 `$` 的，那一刀已经记在同一个音上）
        noteInlineBreak(p, "system");
      }
      if (p.block) p.block.broken = true;
    }
  }
  // 文字块没收尾：后面的全被当成文字吞了，曲谱多半读不出音符——指到那条 `%%begintext`，别只报「没读出音符」
  if (textBlock) {
    report(ctx, "jcx-text-open", tr("diag.jcx.textOpen"), textBlock.source);
    (ensureSong().remarks ??= []).push(textBlock.lines.join("\n"));
  }
  finishSong();
  return doc;
}

/** 待挂的一条歌词行 */
interface PendingLyric {
  f: FieldLine;
  /** 这一行是第几段（段号由 `w:` 的出现顺序定） */
  verse: number;
  syl: Lyric[];
  part: Part;
  block: LyricBlock;
  /** 从第几个对位格起挂 */
  start: number;
}

/** `w` 行：挂到当前声部**当前歌词块**上（规范 §5.1）。
 *  `f.cont`（`+:`）接着写上一条 `w:` 的那一段，不占新段位。 */
function addLyricLine(ctx: Ctx, pb: PartBuild, f: FieldLine, pendingLyrics: PendingLyric[]): void {
  // 旧写法 `w1:`／`w1-2:`：段号已废（段号由出现顺序定），这一行整条丢掉并报错——
  // 放进去会把段位算错，掉进音乐体又会炸出一串词法错
  if (f.legacyVerse !== undefined) {
    report(
      ctx,
      "lyric-verse-number",
      tr("diag.j123.verseNumber", { n: f.legacyVerse }),
      f.source,
    );
    return;
  }
  // 音乐行之前就写了词：给它一个从当前位置起的空块（多半全部超出、报 overflow）
  const block: LyricBlock = pb.block ??= { start: slotCount(pb, ctx.d.lyricSlotRule), cursor: new Map(), verses: 0, broken: false };
  pb.afterLyrics = true;
  // `w:` 按块内顺序编段号（ABC §5.1：同一行音乐下的几条 `w:` 依次是各段）
  const from = f.cont ? block.lastVerse ?? ++block.verses : ++block.verses;
  block.lastVerse = from;
  const { syllables, label } = parseLyricLine(
    f.value, from, f.source, f.valueOffset, ctx.d.lyricSkip,
    (code, message) => report(ctx, code, message, f.source),
    ctx.d.id === "jcx",
  );
  // 印刷段号不占音符格，挂在该段**第一个非空**音节上——空音节（跳音符）不会被挂到元素上
  // （`attachLyrics` 会跳过），label 跟着它一起丢
  if (label !== undefined) {
    const first = syllables.find((x) => x.text !== "");
    if (first) first.verseLabel = label;
  }
  const start = block.cursor.get(from) ?? block.start;
  block.cursor.set(from, start + syllables.length);
  pendingLyrics.push({ f, verse: from, syl: syllables, part: pb.part, block, start });
}

function applyField(
  ctx: Ctx,
  song: Song,
  f: FieldLine,
  startPart: (voice: number) => PartBuild,
  addPlay: (r: RawPlayPass[]) => void,
): void {
  switch (f.name) {
    case "T":
      if (song.work.title === undefined) song.work.title = f.value;
      else song.work.subtitles.push(f.value);
      break;
    case "C":
      (song.identification ??= { creators: [] }).creators.push(creatorOf(f.value));
      break;
    case "K": {
      const r = ctx.d.parseKey(f.value);
      if (r.error) report(ctx, "bad-key", r.error, f.source);
      song.key = r.key;
      break;
    }
    case "M": {
      // 头部可并排写几个拍号（混合拍）＋一段说明文字；首个是起头拍号，其余进 `extraTimes`。
      const r = parseTimes(f.value);
      if (r.error) report(ctx, "bad-time", r.error, f.source);
      const [first, ...rest] = r.times;
      if (first) {
        song.time = first;
        ctx.time = first;
        if (rest.length) song.extraTimes = rest;
        if (r.note) song.timeNote = r.note;
        // ABC §3.1.7：没写 `L:` 时默认音长由 `M:` 推出来
        if (!ctx.sawL) ctx.len = ctx.d.defaultLen(first.beats, first.beatType);
      }
      break;
    }
    case "L": {
      // ABC 的默认音长 `L:1/8`。123 里可省（时值由 `_`/`-`/`.` 相对表达），故只有 ABC 用
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(f.value.trim());
      if (m) {
        ctx.len = { num: Number(m[1]), den: Number(m[2]) };
        ctx.sawL = true;
      } else {
        report(ctx, "bad-length", tr("diag.j123.badLength", { v: f.value }), f.source);
      }
      break;
    }
    case "Q": {
      // **追加不覆盖**：源里常有两条（`Q:1/4=130` 与 `Q:"热情地"`），
      // 直接赋值会让后一条把前一条顶掉，往返一轮速度就丢了
      song.tempos = [...(song.tempos ?? []), ...parseTempo(f.value)];
      // 拍单位（`Q:3/8=60` 附点四分）另记，缺省四分
      const tb = parseTempoBeat(f.value);
      if (tb) song.tempoBeat = tb;
      break;
    }
    case "V": {
      const b = startPart(f.voice ?? 1);
      // 八度谱号只在 123 里有简谱语义（男声部高八度记）；ABC 的音名本就是实际音高，照旧不管
      const clef = ctx.d.id === "123" ? parseVoiceClef(f.value) : null;
      if (clef) b.clef = clef;
      if (ctx.d.id === "jcx") {
        museVoiceAttrs(ctx, b, f);
        break;
      }
      // 声部名：`name="女高"` / `subname="S"`（ABC §3.1.20），只认声明那一处（之后的 `V:n` 只是切声部）
      const nm = /(?:^|\s)name="([^"]*)"/.exec(f.value);
      if (nm && b.part.name === undefined) b.part.name = nm[1]!;
      const sn = /(?:^|\s)subname="([^"]*)"/.exec(f.value);
      if (sn && b.part.abbrev === undefined) b.part.abbrev = sn[1]!;
      break;
    }
    case "W":
      (song.remarks ??= []).push(f.value);
      break;
    case "N":
      (song.remarks ??= []).push(f.value);
      break;
    case "I":
      // Muse 的 `I:` 是写在谱左上角的文字（说明书 §3.2.2「I:提示词」），不是 ABC 指令
      if (ctx.d.id === "jcx") (song.pageText ??= emptyPageText()).topLeft.push(f.value);
      else applyInstruction(ctx, song, parseInstruction(f.value), f.source, addPlay);
      break;
    case "S":
      // ABC 与 Muse 都是「来源」；123 照旧不读（以前就丢），只有 Muse 那一档留着写回
      if (ctx.d.id === "jcx" && f.value) addMeta(song, "source", f.value);
      break;
    case "P":
      // ABC 的段落顺序串（`P:A2`）。**本轮只存原文**，展开语义归后续
      (song.remarks ??= []).push(`P:${f.value}`);
      break;
    default:
      break;
  }
}

function emptyPageText(): NonNullable<Song["pageText"]> {
  return { topLeft: [], topRight: [], bottomLeft: [], bottomCenter: [], bottomRight: [] };
}

function applyInstruction(
  ctx: Ctx,
  song: Song,
  ins: { name: string; value: string },
  source: SourceSpan,
  addPlay: (r: RawPlayPass[]) => void,
): void {
  const name = CJK_INSTRUCTION_ALIAS[ins.name] ?? ins.name;
  switch (name) {
    case "playorder":
      addPlay(parsePlayOrder(ins.value, source, ctx.diagnostics));
      break;
    case "style":
      (song.style ??= {}).sheetRef = ins.value.trim();
      break;
    // 扩展 meta：`I:meta 键 值`（键见 model/metakeys.ts；多值写多行）
    case "meta": {
      const m = /^\s*(\S+)(?:\s+(.*))?$/.exec(ins.value);
      if (m && isMetaKey(m[1]!)) addMeta(song, m[1]!, (m[2] ?? "").trim());
      else (song.style ??= {}).raw = [...(song.style.raw ?? []), { key: name, value: ins.value }];
      break;
    }
    // 页眉页脚：与 emit 对称（见 `j123/emit.ts` 的同名指令）
    case "indexleft": (song.pageText ??= emptyPageText()).indexLeft = ins.value; break;
    case "indexright": (song.pageText ??= emptyPageText()).indexRight = ins.value; break;
    case "topleft": (song.pageText ??= emptyPageText()).topLeft.push(ins.value); break;
    case "topright": (song.pageText ??= emptyPageText()).topRight.push(ins.value); break;
    case "bottomleft": (song.pageText ??= emptyPageText()).bottomLeft.push(ins.value); break;
    case "bottomcenter": (song.pageText ??= emptyPageText()).bottomCenter.push(ins.value); break;
    case "bottomright": (song.pageText ??= emptyPageText()).bottomRight.push(ins.value); break;
    case "linesperpage": {
      const n = Number(ins.value.trim());
      if (Number.isFinite(n) && n > 0) song.linesPerPage = n;
      break;
    }
    case "linebreak":
      (song.style ??= {}).raw = [...(song.style.raw ?? []), { key: "linebreak", value: parseLinebreak(ins.value) }];
      break;
    default:
      (song.style ??= {}).raw = [...(song.style.raw ?? []), { key: name, value: ins.value }];
      break;
  }
}
