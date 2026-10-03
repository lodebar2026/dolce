// jianpu-ly 写出端：把当前谱**导出成 jianpu-ly 文本**，交给上游 `jianpu-ly` 预处理器生成 LilyPond。
//
// 上游: https://github.com/ssb22/jianpu-ly （Silas S. Brown，Apache-2.0）。
// **目标语法只有一个：上游的那一套**（以它 `--markdown --chinese` 生成的 README 为准，v1.890）：
//   音符 `1`–`7`、八度 `'`/`,`（`1' 1'' 1, 1,,`）、变音 `#1 b2 n3`、
//   时值 `s`=16分 `q`=8分 无字母=4分 `d`=32分 `h`=64分、附点 `.`、
//   **半音符及以上写增时线** `1 -`（附点二分 `1 - -`、全音符 `1 - - -`）、休止 `0`、
//   连音 `3[ q1 q1 q1 ]`、前倚音 `g[#45] 1`、圆滑线 `( )`（一字多音）/ 乐句线 `\( \)`（其余，见下）、
//   延音线 `~`、文字 `^"上方"`、LilyPond 指令 `\fermata`/`\bar "||"`/`\pageBreak` 原样透传、
//   拍号 `4/4`、调号 `1=Bb`（大调）、歌词 `L:`（拉丁音节）/`H:`（汉字，含空位占位 `""`）、注释 `%`。
//
// ⚠ **不要混淆方言**：jianpu-db（语料站）的曲谱文件只是 jianpu-ly 的**一种方言** ——
//   它多出 `%<文件名>`、`status=`、`source=`、`%--`、`subtitle=`、以及**收尾的 `%END`**。
//   那些**不是**上游语法，这里一律**不写**（曾经照语料样本抄过 `%END`，是错的）。
//   判断依据永远是上游 README，而不是某份语料样本。
//
// **输入形状**：只经简谱引擎的输入接口（`layout/input.ts` 的 `JScore`），由 `model/jianpuinput.ts`
// 从 `ScoreDoc` 投影出来——与 `tojpw.ts` 同一条原则：写出端不认 `ScoreDoc` 的类，口径与谱面一致。
//
// **单向导出**：不承诺能把 jianpu-ly 文本再读回编辑器（回读要另加方言与高亮，见 `docs/模块/导出.md`）。
// 装不下的东西走 `warnings` 报出来（多声部、和弦符号、演奏法、反复跳跃…），**不静默丢**。
//
// ⚠ 关于语言：`warnings` 是**写进导出文件里的 `%` 注释**，不是界面文字，所以不走 `t()`
//   （`CLAUDE.md` 那条约束的是界面；123 格式本身也写中文，如 `标题：奇异恩典`）。
//   真要让界面提示，调用方可以自己 `t()`——`capability.ts` 的 losses 就是那种结构化形态。

import type { JChord, JMeasure, JNote, JScore } from "../layout/input";
import type { ScoreDoc } from "./doc";
import { jianpuInputOfDoc, jianpuInputOfJpw } from "./jianpuinput";
import { DYNAMICS } from "../pu/glyph";
import { Fraction } from "../common/fraction";
import { harmonyToChordToken, wholeToDuration } from "./jlychords";
import { GlyphCodes } from "../smufl/smufl";

/** 导出结果：文本 + 装不下的东西（调用方拿去提示）。 */
export interface JlyExport {
  text: string;
  warnings: string[];
}

// ───────────────────────── 基础映射 ─────────────────────────

/** 减时线条数 → 时值字母（0 条即四分音符，不写字母）。 */
const BEAM_LETTER: readonly string[] = ["", "q", "s", "d", "h"];

/** 模型没给换行时，一行写几个小节（简谱的常规版面，见 `emitJlyOfScore` 里的说明）。 */
const MEASURES_PER_LINE = 4;

/** 调号 `fifths` → 大调主音名（jianpu-ly 的 `1=<名>`）。 */
const MAJOR_BY_FIFTHS: Readonly<Record<number, string>> = {
  [-7]: "Cb", [-6]: "Gb", [-5]: "Db", [-4]: "Ab", [-3]: "Eb", [-2]: "Bb", [-1]: "F",
  0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
};

/** 变音记号：引擎输入用**一个空格**表示"没有记号"（`jianpuinput.ts` 里是 `?? " "`），
 *  不能原样拼进 token —— 那会写出 `q 1`、`q 1` 之间多个空格，上游直接把字母和数字读成两个词。 */
const alterOf = (jpAlter: string): string => (jpAlter || "").trim();

const octaveMarks = (jpOctave: number): string =>
  jpOctave > 0 ? "'".repeat(jpOctave) : ",".repeat(-jpOctave);

/** 音高：变音 + 数字 + 八度。 */
const pitchOf = (n: JNote): string => alterOf(n.jpAlter) + n.number + octaveMarks(n.jpOctave);

/** 时值字母 + 音高 + 附点（README 的写法：`s1.`）。 */
const noteOf = (n: JNote, letter: string, dots: string): string => letter + pitchOf(n) + dots;

/** 一个和弦会不会被写成 `0`（休止）。**歌词位置也算它**——两处口径必须同一份，
 *  不然"算不算一个音"在谱面和歌词上会各说各话。 */
const isRestToken = (c: JChord): boolean => c.rest || c.notes.length === 0;

/** 休止或和弦。和弦按 README 的 `,135'` 写法：`,` 起头。 */
function chordBody(c: JChord, letter: string, dots: string): string {
  if (isRestToken(c)) return letter + "0" + dots;
  if (c.notes.length === 1) return noteOf(c.notes[0]!, letter, dots);
  const inner = c.notes.map((n) => alterOf(n.jpAlter) + n.number + octaveMarks(n.jpOctave)).join("");
  return "," + inner + dots;
}

/** 增时线：`beats` 里的 1 表示没有，多出来的每一拍一个 `-`（**前面留空格**，上游 #134 就是修这个）。 */
function sustainOf(c: JChord): string {
  const n = Math.max(0, (c.beats || 1) - 1);
  return n ? " " + Array(n).fill("-").join(" ") : "";
}

function ornamentsBefore(c: JChord, tupletSize: ReadonlyMap<object, number>, warnings: Set<string>): string {
  let out = "";
  if (c.notes.some((n) => n.tupletBegin)) {
    // 上游 README：连音写作 `3[ q1 q1 q1 ]` —— **n 就是"这一组有几个音"**，缩放由 jianpu-ly 自己算。
    // ⚠ 以前这里写死 `3[`，五连音会被写成三连音（上游 review 第 9 条）。组信息来自 `JNote.tuplet`
    //   （`{ first, last }`），音数在 `emitJlyOfScore` 里预先数好传进来。
    const grp = c.notes.find((n) => n.tuplet)?.tuplet;
    const n = grp ? tupletSize.get(grp) ?? 0 : 0;
    if (n >= 2) out += n + "[ ";
    else { warnings.add("有连音组数不出音数（按三连音写出）"); out += "3[ "; }
  }
  if (c.graceNotes.length) {
    // ⚠ 倚音组内**不能有空格**：上游是 `g[#45] 1`（连写）。我第一版写成 `g[#4 b5]`，
    //    真 jianpu-ly 直接报 `Unrecognised command g[#4`。这条是拿真工具跑出来的，不是猜的。
    // 时值：未记（八分）不写字母，十六/三十二分写 `s` / `d`（读写对称，见 fromjly.ts::parseGrace）。
    const letter = (dur: number | undefined): string => (dur === 16 ? "s" : dur === 32 ? "d" : dur === 64 ? "h" : "");
    out += "g[" + c.graceNotes.map((g) => letter(g.duration) + alterOf(g.jpAlter) + g.number + octaveMarks(g.jpOctave)).join("") + "] ";
  }
  return out;
}

/** 跳转记号用 jianpu-ly 的**裸词**（`Fine`/`DC`/`Segno`/`ToCoda`/`DS`），其余当谱上文字。
 *  ⚠ 读的时候带点的 `D.C.` / `D.S.` 也认（模型里、123 里都是带点的），**写出去必须去掉点**：
 *  实测 `D.C.` 会被上游拒掉（`Unrecognised command D.C. in score 1`），`DC` / `DS` 才对。 */
export const BARE_DIRECTION = /^(Fine|D\.?C\.?|Segno|ToCoda|D\.?S\.?)$/i;
const JUMP_OUT: Readonly<Record<string, string>> = {
  fine: "Fine", dc: "DC", "d.c.": "DC", ds: "DS", "d.s.": "DS", segno: "Segno", tocoda: "ToCoda",
};

/** 力度字形串 → 名字（`pu/glyph.ts::DYNAMICS` 的反查）：把字形写回 jianpu-ly 的 `\mf`。
 *  不反查就会把私有区字形当成文字写成 `^"<PUA>"` —— 实测过，印出来是一团乱码。 */
const DYNAMIC_NAME: ReadonlyMap<string, string> = new Map(Object.entries(DYNAMICS).map(([k, v]) => [v, k]));

function ornamentsAfter(c: JChord, plan: JlyPlan, warnings: Set<string>): string {
  // 圆滑线**一律后置**（贴在起音的数字后面），不能写在它前面：实测 `1 ( 2 3 ) 4` 里 LilyPond 把 `(` 算在
  // **前一个音**头上（弧从那儿起，弧内的音到 `)` 那个音为止都不吃音节）。写成前置的话，弧会往前挪一个音
  // ——把本该吃音节的起音也吞掉，后面每个音节都错位一格（随机谱面测出来的）。
  // 先收（内层先收）、再开；同一个音既收又开时就是这个顺序。
  let out = plan.slurClose.get(c) ?? "";
  out += plan.slurOpen.get(c) ?? "";
  if (c.notes.some((n) => n.tupletEnd)) out += " ]";
  if (c.fermata) out += " \\fermata";
  // 谱上文字（123 的 `"^渐慢"` 在模型里是 `Chord.sectionWord`）→ 上游的 `^"…"`
  const said = new Set<string>();
  if (c.sectionWord && c.sectionWord.trim()) {
    said.add(c.sectionWord.trim());
    out += ' ^"' + c.sectionWord.trim().replace(/"/g, "'") + '"';
  }
  // 演奏法：其中"看着像力度名"的（`mf` `pp` …）在 123 里就是这么存的，写成 jianpu-ly 的 `\mf`；其余报出来
  const arts: string[] = [];
  for (const a of c.articulations) {
    const name = a.trim();
    if (!name) continue;
    if (name in DYNAMICS) { out += " \\" + name; continue; }
    arts.push(name);
  }
  if (arts.length) warnings.add("演奏法记号尚未导出：" + arts.join(" "));
  for (const d of c.directions) {
    const text = d.text.trim();
    if (!text) continue;
    if (said.has(text)) continue;                       // 同一个字别写两遍（sectionWord 与 direction 可能是同一件事）
    // 字形记号（力度、segno/coda）走 jianpu-ly 的指令或裸词；写成 `^"…"` 会把私有区字形印成乱码。
    if (d.music) {
      const name = DYNAMIC_NAME.get(text);
      if (name) { out += " \\" + name; continue; }
      if (text === GlyphCodes.segno) { out += " Segno"; continue; }
      if (text === GlyphCodes.coda) { out += " ToCoda"; continue; }
      warnings.add("有一种字形记号写不出（既不是力度，也不是 segno / coda）");
      continue;
    }
    out += BARE_DIRECTION.test(text) ? " " + (JUMP_OUT[text.toLowerCase()] ?? text) : ' ^"' + text.replace(/"/g, "'") + '"';
  }
  return out;
}

// ───────────────────────── 谱头 / 歌词 ─────────────────────────

const HEADER_TYPES = new Set(["subtitle", "composer", "poet", "arranger", "copyright", "opus"]);

function headerLines(score: JScore, first: JMeasure | null): string[] {
  const out: string[] = [];
  if (score.title) out.push("title=" + score.title.replace(/\n/g, " "));
  const seen = new Set<string>();
  for (const cr of score.credit) {
    const type = (cr.type || "").toLowerCase();
    if (!HEADER_TYPES.has(type) || !cr.text || seen.has(type)) continue;
    seen.add(type);
    out.push(type + "=" + cr.text.replace(/\n/g, " "));
  }
  const key = first ? MAJOR_BY_FIFTHS[first.key.fifths] : undefined;
  if (key) out.push("1=" + key);
  if (first) out.push(first.time.beats + "/" + first.time.beatType);
  return out;
}

const isHan = (text: string): boolean => /[\u3400-\u9fff\uf900-\ufaff]/.test(text);

// ───────────────── 歌词位置 / 圆滑线：全是实测口径，别照直觉改 ─────────────────
//
// 上游**没有**"歌词格"这种语法：`L:` / `H:` 行的音节**按顺序**落到 `\lyricsto` 那个声部的音上，
// 第 k 个音节落在第几个音，全看中间有几个音"吃"掉了音节。所以对得齐不对得齐，只取决于下面四条。
// （四条都是拿**真 jianpu-ly + 真 LilyPond** 跑出来、再从产出 SVG 的坐标里读回来的，不是照 README 推的。）
//
// ① 一个音 = 一个位置。休止（`0`，带梁的 `q0` 一样）、倚音 `g[12]` 是**跳过**；增时线 `-`、
//    附点、连音 `3[ ]`、和弦 `,135'` 本来就是一个音，不额外占位。
// ② 某一段在这个音上没词，**必须写占位**，否则它后面每个音节都左移一格。
//    实测：`1 2 3 4` 上"缺一格"（`do * mi fa`）时，7 个音节里有 6 个落错音。
//    占位写 **`""`**——那是上游自己的写法（`jianpu-ly.py` 的 MusicXML 导入端就写 `s if s else '""'`）。
//    孤立的 `_` 也能占位，但它在**汉字**行里是"连写"标记（`一_三` = 一个字两个汉字，仍只占一格），
//    两种行统一用 `""` 才不会串位。
// ③ 同一段在同一个音上挂了多个字：拉丁用 `_` 连写（上游的 elision 口径 `a_b`）、汉字也用 `_`
//    （上游 hanzi 口径 `一_三`），都仍只占一格。
// ④ 圆滑线 `( )` **不能无条件写**：jianpu-ly 把它译成 LilyPond 的圆滑线，而 LilyPond 的
//    `melismaBusyProperties` 默认含 `slurMelismaBusy`——弧线里的音会被当成"一字多音"而**不吃音节**。
//    实测 `1 ( 2 ) 3 4` 配 `L: A B C D`：A→1、B→3、C→4（B 跳过 2）。所以只有**真的一字多音**
//    （每一段在这组弧线里至多一个音节、且落在组首）才写 `(`；其余写 LilyPond 的乐句线 `\(` `\)`：
//    照样画一条弧线（SVG 里 path 数 2→3），却不吞音节（四段歌词四四对应，实测）。

/** 一段歌词在这个音上没词时的占位：LilyPond 的空字符串音节（上游自己也写它，见上）。 */
const LYRIC_HOLD = '""';

/** 拉丁音节：**一律加引号**。
 *
 *  不加引号的字会被 LilyPond 的歌词解析当成音乐记号：`4`、`s0`、`r` 这种"看着像时值"的字会被读成
 *  跳过记号 —— 实测（随机谱面）整份 LilyPond 直接报 `not a duration`，一个音都排不出来。
 *  加了引号就是 LilyPond 的**字符串音节**，原样印出（空串 `""` 就是我们用的占位）。 */
const latinQuote = (text: string): string =>
  '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const OPEN_QUOTE = /[\u2018\u201c\u300a]/;

/** 汉字行里一个音节的写法。上游会把**相邻的两个汉字**自动拆成两个音节（`汉字歌词：有无空格都可`），
 *  所以要把多字压在一个音上就得写 `_` 连写（实测 `H: 一_三` 就是一个音节；汉字后紧跟左引号同理）。 */
function hanziGlue(text: string): string {
  let out = "";
  for (const c of text) {
    const prev = out.slice(-1);
    if (prev && HAN.test(prev) && (HAN.test(c) || OPEN_QUOTE.test(c))) out += "_";
    out += c;
  }
  return out;
}

interface JlyPlan {
  /** 圆滑线：组首挂开括号、组尾挂闭括号（同一个音上收多条时内层在前） */
  slurOpen: Map<JChord, string>;
  slurClose: Map<JChord, string>;
  /** 歌词位置：**发音**的和弦；一字多音的圆滑线整组算一个位置 */
  slots: JChord[];
  /** 段号（按首次出现的顺序） */
  verses: number[];
  /** 和弦 → 段号 → 该段在这个音上的字（可能多个，用 `_` 连写） */
  at: Map<JChord, Map<number, string[]>>;
}

function planJly(measures: readonly JMeasure[], warnings: Set<string>): JlyPlan {
  const order: JChord[] = [];
  const index = new Map<JChord, number>();
  for (const m of measures) for (const e of m.entries) {
    if (e.kind !== "chord") continue;
    const c = e as JChord;
    index.set(c, order.length);
    order.push(c);
  }

  // 逐段的字。**不能**用 `seen` 丢掉同段的第二个字：那正是"一个音上两个汉字"（`一_三`）。
  const at = new Map<JChord, Map<number, string[]>>();
  const verses: number[] = [];
  for (const c of order) {
    for (const n of c.notes) for (const ly of n.lyrics) {
      if (!ly.text) continue;
      if (isRestToken(c)) { warnings.add("有歌词挂在休止符上：jianpu-ly 那边休止不占歌词位，这个字已略过"); continue; }
      let per = at.get(c);
      if (!per) { per = new Map(); at.set(c, per); }
      const list = per.get(ly.number) ?? [];
      if (!list.includes(ly.text)) list.push(ly.text);      // 同一个字重复挂（多声部投影）只算一次
      per.set(ly.number, list);
      if (!verses.includes(ly.number)) verses.push(ly.number);
    }
  }
  const has = (c: JChord, v: number): boolean => (at.get(c)?.get(v)?.length ?? 0) > 0;

  // 圆滑线分组：引擎输入已经把配对算好（`slurStart` + `slurEndChord`），这里不用自己搭栈。
  const groups: { start: number; end: number; melisma: boolean }[] = [];
  order.forEach((c, i) => {
    if (!c.slurStart) return;
    const j = c.slurEndChord ? index.get(c.slurEndChord) : undefined;
    // 配不上对的弧线**不写**：写了 LilyPond 会拿到一个没有收尾的 `(`。
    if (j === undefined || j < i) { warnings.add("有配不上对的圆滑线（少了收尾），已略过"); return; }
    // 一字多音：每一段在这组里至多一个音节，且落在组首——才敢用会吞音节的 `(`。
    const melisma = verses.every((v) => {
      const hits = order.slice(i, j + 1).filter((x) => has(x, v));
      return hits.length <= 1 && (hits.length === 0 || hits[0] === c);
    });
    groups.push({ start: i, end: j, melisma });
  });
  const slurOpen = new Map<JChord, string>();
  const slurClose = new Map<JChord, string>();
  const closing = new Map<number, { start: number; melisma: boolean }[]>();
  for (const g of groups) {
    slurOpen.set(order[g.start]!, g.melisma ? " (" : " \\(");
    const list = closing.get(g.end) ?? [];
    list.push(g);
    closing.set(g.end, list);
  }
  for (const [end, list] of closing) {
    list.sort((a, b) => b.start - a.start);                 // 内层（后开）先收
    slurClose.set(order[end]!, list.map((g) => (g.melisma ? " )" : " \\)")).join(""));
  }

  const swallowed = new Set<JChord>();                     // 一字多音的弧线里，组首以外的音不吃音节
  for (const g of groups) if (g.melisma) for (let i = g.start + 1; i <= g.end; i++) swallowed.add(order[i]!);
  const slots = order.filter((c) => !isRestToken(c) && !swallowed.has(c));
  return { slurOpen, slurClose, slots, verses, at };
}

/** 一行和弦符号（`chords=c2. g:7 c`）：上游把它原样塞进 `\new ChordNames { \chordmode { … } }`，
 *  所以 token 是 LilyPond 和弦语法 + 时值；时值按"持续到下一个和弦"算（最后一个到曲末）。
 *  一个都写不出就返回 null（不占一行）。 */
function chordLine(measures: readonly JMeasure[], warnings: Set<string>): string | null {
  const chords: { text: string; position: Fraction; duration: Fraction }[] = [];
  for (const m of measures) for (const e of m.entries) {
    if (e.kind !== "chord") continue;
    const c = e as JChord;
    if (!c.harmony || isRestToken(c)) continue;
    chords.push({ text: c.harmony, position: m.position.plus(c.position), duration: c.duration ?? new Fraction(1, 4) });
  }
  if (!chords.length) return null;
  // 曲末：最后一小节最后一音之后
  let end = chords[chords.length - 1]!.position.plus(chords[chords.length - 1]!.duration);
  for (const m of measures) for (const e of m.entries) {
    if (e.kind !== "chord") continue;
    const stop = m.position.plus(e.position).plus((e as JChord).duration ?? new Fraction(0));
    if (stop.toFloat() > end.toFloat()) end = stop;
  }
  const toks: string[] = [];
  chords.forEach((c, i) => {
    const next = chords[i + 1]?.position ?? end;
    // ⚠ 引擎输入里的时值/位置以**四分音符为 1**（`score/ast.ts::elementQuarters` 的口径），
    //   而 `chords=` 的时值是"几个全音符"—— 不除 4 会写出 `1...` 这种离谱时值（踩过）。
    const whole = Math.max(1 / 64, next.minus(c.position).toFloat() / 4);
    const tok = harmonyToChordToken(c.text, whole);
    if (tok) {
      toks.push(tok);
      if (!wholeToDuration(whole).exact && !/\*/.test(tok)) warnings.add("和弦时值不是规整时值，已按最接近的写出（" + c.text + "）");
    } else {
      warnings.add("和弦符号写不出（上游用 LilyPond 和弦语法，认不出的后缀没法写）：" + c.text);
    }
  });
  return toks.length ? "chords=" + toks.join(" ") : null;
}

/** 反复跳跃（`R{ … } A{ … }`）。上游自己的写法是：`<repeat forward>` → `R{`、`<repeat backward>` → `}`、
 *  `<ending start>` → `A{`、曲末 → `}`。所以反复开始的那一小节前写 `R{`、反复收尾那小节后写 `}`；
 *  第二房开头写 `A{`、第二房收尾写 `}`。三房及以上上游表达不了，报出来（退化成普通小节线）。
 *  返回：小节下标 → 写在该小节**之前** / **之后**的词。 */
function endingMarks(measures: readonly JMeasure[], warnings: Set<string>): { before: Map<number, string>; after: Map<number, string> } {
  const before = new Map<number, string>();
  const after = new Map<number, string>();
  const plain = { before, after };
  // 上游的 `R{ } A{ }` 只能表达**一种**形态：一次反复开始 + 一次反复收尾 + 一段第二房。
  // 别的一律退回 `\bar` 小节线（写坏了比不写更糟 —— 实测多一根 `}` 会让上游 IndexError 直接崩）。
  const fwd = measures.map((m, i) => [m, i] as const).filter(([m]) => m.repeatForward).map(([, i]) => i);
  const back = measures.map((m, i) => [m, i] as const).filter(([m]) => m.repeatBackward).map(([, i]) => i);
  const ends = measures.flatMap((m, i) => [...(m.endingNum ?? [])].map((n) => ({ i, n })));
  const alt = ends.filter((e) => e.n === 2).map((e) => e.i);
  if (fwd.length !== 1 || back.length !== 1 || alt.length === 0 || ends.some((e) => e.n !== 2)) {
    if (fwd.length || back.length || ends.length) {
      warnings.add("反复跳跃的写法不是上游能表达的那一种（一次反复 + 一段第二房），已退化成普通小节线");
    }
    return plain;
  }
  const add = (map: Map<number, string>, i: number, word: string): void => { map.set(i, (map.get(i) ?? "") + word); };
  add(before, fwd[0]!, "R{");
  add(after, back[0]!, "}");
  add(before, alt[0]!, "A{");
  add(after, alt[alt.length - 1]!, "}");
  return { before, after };
}

/** ⚠ 试过把写出的整小节休止也压成 `R*N`（`skipBars`），**退回去了**：语料里大量"写满的休止小节"
 *  并不是压缩记号，压了就是替用户改记谱 —— 实测 29 份真语料里有 18 份的导出随之变了。
 *  现在只**读**（`R*8` 展开成 8 个真实小节，音乐不丢），写出一律写成 `0 0 0 0`（音乐一样）。
 *  （哪天模型里真有了"N 小节休止"这种字段，再回头做双向压缩。） */

/** 逐段收集歌词。位置对不齐就全错（见上面的四条口径），所以这里只做"逐位置填字或填占位"。 */
function lyricLines(plan: JlyPlan, warnings: Set<string>): string[] {
  const out: string[] = [];
  const numbered = plan.verses.length > 1;                 // 多段才印段号（上游多段时写 `2. `）
  for (const v of plan.verses) {
    const latin: string[] = [];
    const han: string[] = [];
    let lastLatin = -1;
    let lastHan = -1;
    plan.slots.forEach((c, i) => {
      const texts = plan.at.get(c)?.get(v) ?? [];
      const l = texts.filter((t) => !isHan(t));
      const h = texts.filter((t) => isHan(t));
      if (l.length && h.length) {
        warnings.add("同一段歌词里拉丁与汉字混排：已拆成 `L:` 与 `H:` 两行（上游没有混排写法）");
      }
      // 同一个音上同一段有多个字：拉丁并成一个引号音节（`"a b"`），汉字用 `_` 连写（`一_三`）。
      latin.push(l.length ? latinQuote(l.join(" ")) : LYRIC_HOLD);
      han.push(h.length ? h.map(hanziGlue).join("_") : LYRIC_HOLD);
      if (l.length) lastLatin = i;
      if (h.length) lastHan = i;
    });
    // 段号：多段才印（上游多段时写 `2. `）。⚠ 模型里第一格的字**自己就可能带着段号**
    //   （JP-Word 的 `{1.[圣]}哉…` 读进来就是 `1.圣`），那就别再叠一个 —— 实测出过 `H: 1. 1.圣 哉…`。
    const already = (arr: readonly string[]): boolean => {
      const first = arr.find((t) => t !== "");
      // `1.圣` 这种（JP-Word 读进来就是带点不带空格的）也算已经带了段号
      return !!first && (first.startsWith(v + ". ") || first.startsWith(v + "."));
    };
    const label = (arr: readonly string[]): string => (numbered && !already(arr) ? v + ". " : "");
    // 尾巴上的空位不用写（上游导出时也会把尾部的空音节剪掉）。
    if (lastLatin >= 0) out.push("L: " + label(latin) + latin.slice(0, lastLatin + 1).join(" "));
    if (lastHan >= 0) out.push("H: " + label(han) + han.slice(0, lastHan + 1).join(" "));
  }
  // 引擎输入的 `JLyric` **不带 `syllabic`**（那个字段只在模型层），所以拉丁歌词只能按空格分音节写；
  // `L:` 的连字符（上游的 `syl- la- bles`）这一版表达不出来，报出来别静默丢。
  if (out.some((l) => l.startsWith("L:"))) {
    warnings.add("拉丁歌词的连字符（`syl- la- bles`）尚未导出，按空格分音节写出");
  }
  return out;
}

// ───────────────────────── 主流程 ─────────────────────────

/** 纯函数：简谱输入形状 → jianpu-ly 文本。`warnings` 由调用方传入并去重。 */
export function emitJlyOfScore(score: JScore, warnings: Set<string> = new Set()): string {
  const measures = score.parts[0]?.measures ?? [];
  const lines: string[] = headerLines(score, measures[0] ?? null);
  // 和弦符号行紧跟谱头（上游就这么写）。
  const chordRow = chordLine(measures, warnings);
  if (chordRow) lines.push(chordRow);
  // 歌词位置与圆滑线写法要**先算**：音乐行里写 `(` 还是 `\(` 由它定，歌词行也按它填占位。
  const plan = planJly(measures, warnings);

  // 行的累加器是**函数级**的：一行可以跨多个小节（源谱一行四小节是常事），
  // 只有遇到源谱的换行（`JBreak`）才收一行。第一版把它放在小节循环里，
  // 于是"一行四小节"变成了"一小节一行"；去掉每小节 flush 之后更糟——整小节内容被丢掉，
  // 真 jianpu-ly 直接报 `No jianpu in score`。两处都是端到端跑出来的。
  let tokens: string[] = [];
  const flush = (): void => { if (tokens.length) { lines.push(tokens.join(" ")); tokens = []; } };

  // 一行放几个小节：模型自己带了换行（`JBreak`）就听模型的；没有就**每 4 小节收一行**。
  // 为什么不能一行到底：上游不看行（行只是排版偏好），可 **dolce 自己要看** —— `.jly` 打开后是按
  // 文件里的行排版的，整首挤成一行时音符和歌词会叠成一团（用户截图上就是那样：34 个音挤在 850px 里，
  // 歌词连成一串）。4 小节一行是简谱的常规版面，源谱"一行四小节"也正是这个数。
  let sinceBreak = 0;
  /** 已经到小节末的换行/换页：等小节线写完再落地（见下面 `case "break"`） */
  let pendingBreakWord: string | null = null;
  const marks = endingMarks(measures, warnings);
  // 连音组 → 组内音数（写出端要写 `n[ … ]`，n = 这一组几个音；上游 review 第 9 条）。
  // ⚠ `tuplet` 只挂在组的**首尾两个音**上（`jiepuinput.ts` 的 `pairTuplets` 是两两配对），
  //   所以音数要数"首音所在和弦 → 末音所在和弦"之间有多少个和弦，不能只数带 `tuplet` 的音。
  const chordOrder: JChord[] = [];
  for (const m of measures) for (const e of m.entries) if (e.kind === "chord") chordOrder.push(e as JChord);
  const posOfNote = new Map<JNote, number>();
  chordOrder.forEach((c, i) => c.notes.forEach((n) => posOfNote.set(n, i)));
  const tupletSize = new Map<object, number>();
  for (const c of chordOrder) for (const n of c.notes) {
    const t = n.tuplet;
    if (!t) continue;
    const a = posOfNote.get(t.first);
    const b = posOfNote.get(t.last);
    if (a !== undefined && b !== undefined && b >= a) tupletSize.set(t, b - a + 1);
  }
  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    const m = measures[mIdx]!;
    if (marks.before.has(mIdx)) { flush(); tokens.push(marks.before.get(mIdx)!); }
    // 拍号/调号变更各占一行（jianpu-ly 里它们本来就是行内 token）——
    // ⚠ 只有**真的**变更才 flush，别写成 `if (m.index > 0) { flush(); … }`：
    //   那等于每小节都换行，源谱"一行四小节"就被拆散了（第三处、也是最后一处同类错误）。
    if (m.timeChange) { flush(); lines.push(m.time.beats + "/" + m.time.beatType); sinceBreak = 0; }
    if (m.keyChange) {
      const tonic = MAJOR_BY_FIFTHS[m.key.fifths];
      if (tonic) { flush(); lines.push("1=" + tonic); sinceBreak = 0; }
    }
    // 用上 `R{ } A{ }` 时就不再写 `\bar` 反复线（重复记号由上游的 `\repeat volta` 出，写重了是噪音）
    if (m.repeatForward && !marks.before.has(mIdx)) { flush(); tokens.push('\\bar ".|:"'); }
    for (const e of m.entries) {
      if (e.kind === "chord") {
        const c = e as JChord;
        if (c.beams >= BEAM_LETTER.length) warnings.add("有超过 4 条减时线（64 分）的时值，已按 64 分写出");
      const dots = ".".repeat(c.dot || 0);
        tokens.push(ornamentsBefore(c, tupletSize, warnings) + chordBody(c, BEAM_LETTER[c.beams] ?? "", dots) + sustainOf(c) + ornamentsAfter(c, plan, warnings));
        if (c.notes.some((n) => n.tieStart)) tokens.push("~");       // 延音线写在两音之间
      } else if (e.kind === "break") {
        // ⚠ 模型里的换行（`JBreak`）**都是显式的**（123 的 `$`/`$$`、MusicXML 的 `<print new-system>`、
        //   `.jly` 的 `\break`），所以除了收一行，还得把指令写出去 —— 只收一行的话上游根本不看行，
        //   "换系统"这个语义就丢了（实测：`\break` 的效果是真换行）。我们自己的 4 小节折行不走这里。
        // 写的位置要能**原样读回来**，不然来回一趟表示法就变了（实测：第二次导出把 `\break` 丢了）：
        //   · 这一小节后面还有音（小节中间的换行）→ 就地写；
        //   · 已经到小节末 → 等小节线写完再写（读回来是"下一小节起新系统"，与写出去的位置一一对应）。
        const brk = (e as { newPage?: boolean }).newPage ? "\\pageBreak" : "\\break";
        const atEnd = !m.entries.slice(m.entries.indexOf(e) + 1).some((x) => x.kind === "chord");
        if (atEnd) pendingBreakWord = brk;
        else { tokens.push(brk); flush(); sinceBreak = 0; }
      }
    }
    if (m.endingNum && m.endingNum.size) {
      if (m.endingNum && [...m.endingNum].some((n) => n > 2)) warnings.add("反复跳跃有第 3 房及以后：上游只能表达两房（`R{ } A{ }`）");
    }
    tokens.push(m.repeatBackward && !marks.after.has(mIdx) ? '\\bar ":|."' : "|");
    if (pendingBreakWord) { tokens.push(pendingBreakWord); flush(); sinceBreak = 0; pendingBreakWord = null; }
    if (marks.after.has(mIdx)) tokens.push(marks.after.get(mIdx)!);
    if (++sinceBreak >= MEASURES_PER_LINE) { flush(); sinceBreak = 0; }
  }
  flush();                                                           // 收尾那一行

  const lyrics = lyricLines(plan, warnings);
  if (lyrics.length) lines.push(...lyrics);
  // 装不下的东西**写进文件本身**当注释（上游 README：「忽略：`% 注释`」）：提示随文件走，
  // 既不静默丢，也不用为它新开一条界面提示通道。空集合时一行都不加。
  const notes = [...warnings].map((w) => "% " + w);
  // ⚠ **不要写 `%END`**：那是 **jianpu-db 语料**的收尾约定，不是上游 jianpu-ly 的语法
  //   （jianpu-db 的曲谱只是 jianpu-ly 的**一种方言**）。导出目标永远是上游语法，
  //   语料那套（`%<文件名>` / `status=` / `source=` / `%--` / `subtitle=` / `%END`）一律不写。
  return [...notes, ...lines].filter((l) => l.trim() !== "").join("\n") + "\n";
}

/** `ScoreDoc` → jianpu-ly 文本。投影不出来时抛错（与其它写出端一致，调用方翻成界面文案）。
 *
 *  **两种输入形状都收**（与 `tojpw.ts` 同一套口径）：`caps.layout === "scoredoc"` 的那几种
 *  （文本谱 / 123 / ABC / MusicXML）走 `jianpuInputOfDoc`，`.jpwabc` 走 `jianpuInputOfJpw`。
 *  第一版只用了前者，于是 `.jpwabc` 文档会抛 `noLines` ✗（是端到端点出来的）。 */
export function emitJly(doc: ScoreDoc): JlyExport {
  const warnings = new Set<string>();
  const score = jianpuInputOfDoc(doc) ?? jianpuInputOfJpw(doc);
  if (!score) throw new Error("noLines");
  if (score.parts.length > 1) {
    warnings.add("多声部：jianpu-ly 导出只写第一声部（共 " + score.parts.length + " 个）");
  }
  // 多曲（上游 `NextScore`）：本版只写第一首 —— 也必须报出来，别静默丢。
  if (doc.songs.length > 1) {
    warnings.add("多曲：jianpu-ly 导出只写第一首（共 " + doc.songs.length + " 首）");
  }
  // ⚠ 同一 part 里的多声部**不能靠投影结果判**：`jianpuInputOfDoc` 在读每个小节时就
  //   `voice <= 1` 过滤掉了（`jianpuinput.ts` 的「读完一小节」那步），投影出来恒为单声部。
  //   所以回到 `ScoreDoc` 上数，否则第 2 及以后的声部会被**静默丢掉**。
  const extraVoice = doc.songs.some((s) =>
    s.parts.some((p) => p.measures.some((m) => m.elements.some((e) => e.voice > 1))));
  if (extraVoice) {
    warnings.add("多声部：投影只取第 1 声部，第 2 及以后的声部不会出现在导出的文本里");
  }
  return { text: emitJlyOfScore(score, warnings), warnings: [...warnings] };
}
