// 标准 ABC 方言的写出端（ABC 2.1）。只回答基类问的那几个问题，其余全在 `emit.ts`。
//
// **默认音长固定写 `L:1/8`**：写出端要幂等，就不能让默认音长随内容浮动——
// 同一份 `ScoreDoc` 第二次写出必须逐字相同。读入端照样认任意 `L:`。

import { SIMPLE_DIVISIONS, type Chord, type Element, type Key, type Note, type Part, type ScoreDoc, type Song } from "../model/doc";
import { AbcFamilyEmitter, type LyricStyle, type MarkIndex } from "./emit";
import { clefName, harmonyText } from "../model/jianpu";
import { nominalQuarters } from "../model/jianpu";
import { tonicSpelling } from "../model/keyshift";
import { hasTieSyntax, isXmlShaped, slursAsTies } from "../model/xmlproject";
import { directionsAsMarks } from "../model/directionmarks";
import { fillEmptyMeasures, splitStaves } from "../model/staves";
import { fillAbsentGroups } from "../model/timeaxis";
import { withAbcAccidentals, withAbcPitches } from "./abcpitch";
import { creatorsFromCredits, headerFromCredits } from "../model/jianpuproject";

/** ABC §4.13 里不随拍号变的默认比例（`parsedialect.ts::tupletNormalAbc`）。 */
const ABC_FIXED_TUPLET: Readonly<Record<number, number>> = { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 };

/** 写出端固定的默认音长：八分音符。 */
const UNIT = SIMPLE_DIVISIONS / 2;

/** 前置变音记号。 */
const ACC_TEXT: Readonly<Record<string, string>> = {
  sharp: "^",
  flat: "_",
  natural: "=",
  "double-sharp": "^^",
  "double-flat": "__",
};

/** 最大公约数——时值分数要约分，否则 `4/8` 与 `1/2` 会在往返里来回变形。 */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** divisions → 相对 `L:1/8` 的时值后缀：`""`(=1) / `2` / `/2` / `3/2`。 */
function lengthSuffix(divisions: number): string {
  if (divisions <= 0) return "";
  let num = divisions;
  let den = UNIT;
  const g = gcd(num, den) || 1;
  num /= g;
  den /= g;
  if (num === 1 && den === 1) return "";
  if (num === 1 && den === 2) return "/";
  if (den === 1) return String(num);
  return `${num}/${den}`;
}

/** MusicXML 读进来的歌：`divisions` 以各小节 `attrs.divisions` 为分母，换成写出端的口径（四分 = `SIMPLE_DIVISIONS`）。
 *  多连音取名义时值——ABC 的 `(3` 后面写的就是名义音长。在克隆上改，模型不动。 */
function withAbcDivisions(src: Song): Song {
  const song: Song = structuredClone(src);
  for (const part of song.parts) {
    let divisions = 1;
    for (const m of part.measures) {
      if (m.attrs?.divisions !== undefined) divisions = m.attrs.divisions;
      // 记下的小节长（拆开的大谱表，`staves.ts::subMeasure`）写出端按它补齐末尾，同一口径
      if (m.duration) m.duration = Math.round((m.duration / divisions) * SIMPLE_DIVISIONS);
      // 小节中间换谱号的时刻（`emit.ts::midClefChanges`）同此
      for (const la of m.laterAttrs ?? []) if (la.onset) la.onset = Math.round((la.onset / divisions) * SIMPLE_DIVISIONS);
      for (const el of m.elements) {
        if (el.kind === "chord" && el.grace) continue;
        if ((el.kind === "chord" || el.kind === "space") && el.duration) {
          el.duration = { ...el.duration, divisions: Math.round(nominalQuarters(el, divisions) * SIMPLE_DIVISIONS) };
        }
        // 小节内起点（多声部）同样换口径，否则 `&` 后面补的那个 `x` 时值按原始 divisions 算，差一个倍数
        if (el.onset) el.onset = Math.round((el.onset / divisions) * SIMPLE_DIVISIONS);
      }
    }
  }
  return song;
}

const GRACE_LEN: Readonly<Record<string, string>> = { quarter: "2", eighth: "", "16th": "/", "32nd": "/4", "64th": "/8" };

export class EmitterAbc extends AbcFamilyEmitter {
  protected readonly versionLine = "%abc-2.1";
  /** 正在写的歌是 MusicXML 来源（`emitSong` 设） */
  private xmlSource = false;

  /** 曲中换谱号写 `[K:clef=bass]`（ABC §3.1.14 的 `clef=` 写进 `K:`） */
  protected override readonly inlineClefs = true;
  /** 小节中间换谱号在原位写（行内字段 §3 哪儿都能写；钢琴下谱表半小节处转低音谱号） */
  protected override readonly midClefs = true;

  /** 声部名之外再写谱号 `clef=bass`（ABC §3.1.20）：低音、中音谱号与八度谱号写，单声部的高音谱号不写。
   *  ABC 的音名是记谱音高，谱号只管画在哪条线上（钢琴左手的低音谱表以前转过来全丢，画成高音谱表上一串加线） */
  protected override voiceAttrs(part: Part, multi: boolean): string {
    const found = part.measures[0]?.attrs?.clefs?.find((x) => (x.staff ?? 1) === 1);
    // 八度谱号只照 MusicXML 来源写（音名是记谱音高，读回 `assignDegrees` 按它推唱名，两头对得上）；
    // 简谱来源的 `treble-8` 是「简谱按高八度记」，ABC 的音名照唱名写、不另写谱号（同以前）
    const c = found && !this.xmlSource && found.octaveChange ? { ...found, octaveChange: 0 } : found;
    const treble = !c || (c.sign === "G" && (c.line ?? 2) === 2);
    const name = c && (c.octaveChange || !treble) ? clefName(c) : null;
    return [super.voiceAttrs(part, multi), name ? `clef=${name}` : ""].filter(Boolean).join(" ");
  }

  /** 简谱口径的来源（123、文本谱…）相邻同音的括号是延音线，写成 `-`（`slursAsTies`）；ABC / Muse 来的括号就是圆滑线，照写 */
  override emitDoc(doc: ScoreDoc): string {
    return super.emitDoc(hasTieSyntax(doc) ? doc : { ...doc, songs: doc.songs.map(slursAsTies) });
  }

  /** MusicXML 形状的歌先换时值口径，否则 `L:1/8` 下写出的是原始 divisions（八分写成 `E1/8`）；
   *  简谱形状的（只有度数）先补音高与 ABC 口径的记号（`abcpitch.ts`）。 */
  override emitSong(song: Song, fallbackNumber?: number): string {
    // 钢琴大谱表拆成每条谱表一个 `V:`（`part=` 记它属于哪个声部，`model/staves.ts`）；
    // 某声部缺席的组（前几行只有一个声部）补整小节不可见休止，ABC 各声部各数各的小节（`timeaxis.ts::fillAbsentGroups`）
    const own = directionsAsMarks(splitStaves(fillEmptyMeasures(fillAbsentGroups(song))));
    this.xmlSource = isXmlShaped(own);
    if (!this.xmlSource) return super.emitSong(withAbcPitches(own), fallbackNumber);
    // 页眉只写在 `<credit>` 里的署名、左上右上的文字、标题下的英文标题落成 `C:` / `I:topleft` / `T:`（同 123 那一路，`jianpuproject.ts`）
    const xml = withAbcAccidentals(withAbcDivisions(own));
    creatorsFromCredits(xml);
    headerFromCredits(xml);
    return super.emitSong(xml, fallbackNumber);
  }

  /** 长音中途换和弦（123 的 `5 F - C - -`，和弦挂在增时线上）：ABC 没有增时线，拆成连音线相连的几段、
   *  和弦挂在各段上（`"F"A2-"C"A6`）。只在有增时线带和弦时拆，其余照旧一个音写完。
   *  MusicXML 的长音中途和弦（`laterHarmonies`）不拆：读回是几个连着的音、不再是一个长音，比丢一个和弦步数还多（丢失清单「长音中间不在整拍上的和弦」） */
  private sustainSegments(ch: Chord): { harmony?: Chord["harmony"]; divisions: number }[] | null {
    const su = ch.sustains;
    if (!su?.some((s) => s.harmony) || ch.rest || ch.grace || ch.rhythm) return null;
    const segs = [{ divisions: ch.duration.divisions - su.length * SIMPLE_DIVISIONS } as { harmony?: Chord["harmony"]; divisions: number }];
    for (const s of su) {
      if (s.harmony) segs.push({ harmony: s.harmony, divisions: SIMPLE_DIVISIONS });
      else segs[segs.length - 1]!.divisions += SIMPLE_DIVISIONS;
    }
    return segs[0]!.divisions > 0 ? segs : null;
  }

  protected override extraSlots(el: Element): number {
    return el.kind === "chord" ? Math.max(0, (this.sustainSegments(el)?.length ?? 1) - 1) : 0;
  }

  protected override elementText(el: Element, mi?: MarkIndex): string {
    const segs = el.kind === "chord" ? this.sustainSegments(el) : null;
    if (!segs || el.kind !== "chord") return super.elementText(el, mi);
    const notes = this.chordNotes(el);
    const body = this.chordGroupText(notes.map((n) => this.noteText(n)).join(""), notes.length);
    return segs.map((g, i) => (i > 0 && g.harmony ? this.chordSymbolText(harmonyText(g.harmony)) : "") + body + lengthSuffix(g.divisions)).join("-")
      + this.tieText(el);
  }

  /** 音名 + 八度：第 4 八度大写、第 5 八度小写，再往外用 `'` 与 `,`（ABC §4.1）。 */
  protected noteText(n: Note): string {
    const p = n.pitch;
    if (!p) return ""; // 度数已由 `withAbcPitches` 换成音高
    let s = n.accidental ? ACC_TEXT[n.accidental] ?? "" : "";
    const oct = p.octave;
    s += oct >= 5 ? p.step.toLowerCase() : p.step;
    if (oct > 5) s += "'".repeat(oct - 5);
    else if (oct < 4) s += ",".repeat(4 - oct);
    return s;
  }

  /** `z` 带时值；不可见休止用 ABC 的 `x`（invisible rest）。 */
  protected restText(ch: Chord): string {
    return ch.printObject === false ? "x" : "z";
  }

  protected durationText(el: Element): string {
    const dur = el.kind === "chord" ? el.duration : el.duration;
    return dur ? lengthSuffix(dur.divisions) : "";
  }

  /** tie 的 start 端写 `-`（ABC §4.11）：和弦的音全连上写在和弦后，只连其中几个的写在那几个音后（`[D-d]`，`noteTieText`）。 */
  protected override tieText(ch: Chord): string {
    const notes = this.chordNotes(ch);
    return notes.length && notes.every((n) => n.tie?.start) ? "-" : "";
  }

  protected override noteTieText(n: Note, notes: readonly Note[]): string {
    return notes.length > 1 && n.tie?.start && !notes.every((x) => x.tie?.start) ? "-" : "";
  }

  /** ABC 没有「节奏音符」，退化成一个不发音高的 `x`——比丢掉强，且时值对得上。 */
  protected override rhythmText(): string {
    return "x";
  }

  protected override headerExtra(): string[] {
    return ["L:1/8"];
  }

  /** 同时发声的几个音包进 `[]`（ABC §4.17）。单音不包——包了读回来也对，但不幂等。 */
  protected override readonly writesChordGroups = true;

  protected override chordGroupText(inner: string, noteCount: number): string {
    return noteCount > 1 ? `[${inner}]` : inner;
  }

  /** ABC 的多连音不要冒号（音符是字母，`(3` 无歧义）。比例是 §4.13 表里的固定默认值才写简写；
   *  `(5`/`(7`/`(9` 的默认值随拍号变，一律写完整形。 */
  protected override tupletText(actual: number, normal: number): string {
    return ABC_FIXED_TUPLET[actual] === normal ? `(${actual}` : `(${actual}:${normal}:${actual}`;
  }

  /** ABC 按个数收尾（§4.13），不写 `)`。 */
  protected override readonly tupletCloses = false;

  /** 小节内临时多声部分隔（ABC §7.4）。 */
  protected override readonly overlayText = "&";

  /** 分支不从小节起点开始时，前面用不可见休止 `x` 占住。 */
  protected override overlayPad(divisions: number): string {
    return divisions > 0 ? `x${lengthSuffix(divisions)}` : "";
  }

  /** 拉丁词必须空格分开，否则读回来粘成一个音节。 */
  protected override readonly lyricSeparator = " ";

  /** 印刷段号照 ABC 惯例写在首字前（`w:1.~道`），读回认（`parseLyricLine` 的 `tildeLabel`） */
  protected override readonly lyricStyle: LyricStyle = { labels: "tilde" };

  /** ABC §5.1 的跳音符。 */
  protected override readonly lyricSkip = "*";
  protected override readonly lyricSlotRule = "abc" as const;

  /** ABC 默认「代码换行即谱面换行」（§6.1），所以写真换行而不是 123 的 `$`。
   *  换页在两个系统之间另起一行写 `%%newpage`（`pageBreakLine`）。 */
  protected override breakText(): string {
    return "\n";
  }

  protected override readonly trailingBreak = false;

  /** ABC §11.4.7 的排版指令（规范标 VOLATILE，排版程序都认） */
  protected override readonly pageBreakLine = "%%newpage";

  /** 倚音长度相对倚音单位（八分，ABC §4.12 单位由软件定）：`{g/}` 十六分、`{g2}` 四分。 */
  protected override graceDurationText(ch: Chord): string {
    return GRACE_LEN[ch.duration.type ?? "eighth"] ?? "";
  }

  /** `{/g}` 短倚音（acciaccatura，ABC §4.12）。 */
  protected override graceSlashText(ch: Chord): string {
    return ch.grace?.slash ? "/" : "";
  }

  /** 音名调号。带 mode 的（`Em`）照 ABC 写法还原；123 的 `6=E` 没写 mode，按主音唱名补（`Em`）。 */
  protected keyValue(k: Key): string {
    if (k.spelling === "none") return "none";
    // 123 那侧的拼写是前置形（`bB`/`#F`），ABC 是后置形（`Bb`/`F#`）
    const sp = tonicSpelling(k).replace(/^([#b])([A-G])$/, "$2$1");
    const mode = k.mode && k.mode !== "major" && k.mode !== "ionian" ? k.mode.slice(0, 3)
      : !k.mode ? (MODE_OF_DEGREE[k.tonicDegree ?? "1"] ?? "") : "";
    return sp + (mode === "min" ? "m" : mode);
  }
}

/** 主音唱名 → ABC 调式（`6=E` → `Em`） */
const MODE_OF_DEGREE: Readonly<Record<string, string>> = {
  "2": "dor", "3": "phr", "4": "lyd", "5": "mix", "6": "min", "7": "loc",
};

export const EMITTER_ABC = new EmitterAbc();
