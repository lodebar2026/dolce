// Muse 曲谱软件 `.jcx` 的写出端（格式见 `docs/格式/jcx.md`）。只回答基类问的那几个问题，其余全在 `emit.ts`。
//
// - **简谱轨**：每个声部写成 `V:n style=jianpu`，字母是首调唱名（C=1，`dialectjcx.ts` 那张表），
//   临时记号相对调号直写（`^` 升、`_` 降、`=` 还原），与简谱的记法一一对应，不用 ABC 那套绝对音名换算。
// - 头部照 Muse 自己存出来的样子排：`T:` 起、`K:` 收，`V:` 声明随后，正文每段前 `[V: n]`（说明书 §3.2.3.1）。
// - 时值与 ABC 写出端同一口径：固定 `L:1/8`、分数后缀；倚音、多连音、tie 同 ABC。
// - 落盘编码（`%MUSE2` + GBK）在 `common/jcxcodec.ts`，这里只出文本。

import { SIMPLE_DIVISIONS, type Chord, type Element, type Key, type Note, type Song } from "../model/doc";
import { AbcFamilyEmitter, lyricLines, type LyricStyle } from "./emit";
import { systemRanges } from "../model/emitutil";
import { isXmlShaped } from "../model/xmlproject";
import { LETTER_OF_DEGREE } from "./dialectjcx";
import { assignDegrees, keySpelling } from "../model/jianpu";
import { projectForJianpu } from "../model/jianpuproject";
import { getMeta } from "../model/metakeys";

/** 写出端固定的默认音长：八分音符（同 `emitabc.ts`，幂等的前提）。 */
const UNIT = SIMPLE_DIVISIONS / 2;

const ACC_TEXT: Readonly<Record<string, string>> = {
  sharp: "^",
  flat: "_",
  natural: "=",
  "double-sharp": "^^",
  "double-flat": "__",
};

const ABC_FIXED_TUPLET: Readonly<Record<number, number>> = { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 };
const GRACE_LEN: Readonly<Record<string, string>> = { quarter: "2", eighth: "", "16th": "/", "32nd": "/4", "64th": "/8" };

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** divisions → 相对 `L:1/8` 的时值后缀。 */
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

/** 只有音高没有度数的音（MusicXML、五线谱识别来的）：在克隆上按简谱口径补度数（`assignDegrees`，与简谱排版同一份）。 */
function withDegrees(src: Song): Song {
  const missing = src.parts.some((p) => p.measures.some((m) => m.elements.some((el) =>
    el.kind === "chord" && el.notes.some((n) => n.pitch && !n.degree))));
  if (!missing) return src;
  const song: Song = structuredClone(src);
  for (const part of song.parts) assignDegrees(part, song.key ?? { fifths: 0 });
  return song;
}

/** 增时线在 Muse 里没有独立写法（并进音长 `C4`），起止落在增时线上的弧改挂到它的宿主音上，否则写出只有 `(` 没有 `)`。 */
function marksOffSustains(src: Song): Song {
  const host = new Map<number, number>();
  for (const p of src.parts) for (const m of p.measures) for (const el of m.elements) {
    if (el.kind === "chord") for (const su of el.sustains ?? []) host.set(su.id, el.id);
  }
  if (!src.marks.some((mk) => host.has(mk.start) || host.has(mk.end))) return src;
  return {
    ...src,
    marks: src.marks.map((mk) => ({ ...mk, start: host.get(mk.start) ?? mk.start, end: host.get(mk.end) ?? mk.end })),
  };
}

/** 文字值里不能有换行（会断成裸行），也不能把字段前缀带出去。 */
const oneLine = (s: string): string => s.split(/\r\n?|\n/).map((x) => x.trim()).filter(Boolean).join(" ");

export class EmitterJcx extends AbcFamilyEmitter {
  /** Muse 3.1 以前的版本号；文件按 GBK 落盘（`jcxcodec.ts`），新旧版 Muse 都能开 */
  protected readonly versionLine = "%MUSE2";

  /** 度数 → 字母（C=1）+ 八度：第 0 个八度大写、高一个八度小写，再往外用 `'` 与 `,`（与读入端 ABC 词法同口径）。 */
  protected noteText(n: Note): string {
    const d = n.degree;
    if (!d || d.number < 1) return "";
    const letter = LETTER_OF_DEGREE[d.number - 1] ?? "C";
    let s = d.accidental ? ACC_TEXT[d.accidental] ?? "" : "";
    const oct = d.octaveShift;
    s += oct >= 1 ? letter.toLowerCase() + "'".repeat(oct - 1) : letter + ",".repeat(-oct);
    return s;
  }

  /** `z`；不可见休止 Muse 写 `@`（它的 `x` 是节奏音符）。 */
  protected restText(ch: Chord): string {
    return ch.printObject === false ? "@" : "z";
  }

  protected durationText(el: Element): string {
    return el.duration ? lengthSuffix(el.duration.divisions) : "";
  }

  protected override tieText(ch: Chord): string {
    return ch.notes.some((n) => n.tie?.start) ? "-" : "";
  }

  /** 节奏音符（有声无音高）：Muse 的 X 音符。 */
  protected override rhythmText(): string {
    return "X";
  }

  protected override chordGroupText(inner: string, noteCount: number): string {
    return noteCount > 1 ? `[${inner}]` : inner;
  }

  protected override tupletText(actual: number, normal: number): string {
    return ABC_FIXED_TUPLET[actual] === normal ? `(${actual}` : `(${actual}:${normal}:${actual}`;
  }

  protected override readonly tupletCloses = false;
  /** 中文连写，拉丁词由基类补空格 */
  protected override readonly lyricSeparator = "";
  protected override readonly lyricSkip = "*";
  protected override readonly lyricSlotRule = "abc" as const;
  /** Muse 没有 `{多字}` 与印刷段号；多字一音用 `~` 连，一字多音的延长位只能写 `*` */
  protected override readonly lyricStyle: LyricStyle = {
    joinMulti: (text) => [...text].join("~"),
    labels: false,
    extend: "*",
  };

  /** 代码换行就是谱面换行（读入端同口径），所以写真换行；换页 Muse 没有记号，退成换行 */
  protected override breakText(): string {
    return "\n";
  }

  protected override readonly trailingBreak = false;

  protected override graceDurationText(ch: Chord): string {
    return GRACE_LEN[ch.duration.type ?? "eighth"] ?? "";
  }

  /** 后倚音 `{@C}` */
  protected override graceSlashText(ch: Chord): string {
    return ch.grace?.after ? "@" : "";
  }

  /** 音符前引号里的字 Muse 一律印在音符上方（`"_…"` 才在下方），没有 ABC 的 `^` 前缀，写了会照印出来 */
  protected override annotationText(word: string): string {
    return `"${word.replace(/"/g, "'")}"`;
  }

  protected override readonly annotationBeforeChord = true;

  /** 渐强 `(<` … `<)`、渐弱 `(>` … `>)` */
  protected override wedgeText(type: "crescendo" | "diminuendo", edge: "start" | "stop"): string {
    const c = type === "crescendo" ? "<" : ">";
    return edge === "start" ? `(${c}` : `${c})`;
  }

  /** Muse 的 `K:` 定的是调号（1 = 大调主音）：前置升降号形（`bE`，Muse 自己存出来就是这样），带调式时照 ABC 写 `Em`。 */
  protected keyValue(k: Key): string {
    if (k.spelling === "none") return "C";
    const mode = k.mode && k.mode !== "major" && k.mode !== "ionian" ? k.mode.slice(0, 3) : "";
    if (mode) return keySpelling(k, "mode") + (mode === "min" || mode === "aeo" ? "m" : mode);
    // 首调写成「5=D」这类（主音唱名不是 1、又没有调式）：Muse 写不出，按调号写 1 的音
    if (k.tonicDegree && k.tonicDegree !== "1") return keySpelling({ fifths: k.fifths });
    return keySpelling(k);
  }

  /** 正文**按声部分块**写（Muse 自己存出来就是这样）：`[V: n]` 一行，随后这个声部的各行音乐，各跟各的 `w:`。
   *  不照基类按第一声部切系统交错写——各声部在 Muse 里的断行各不相同，`w:` 又只对紧挨在前的那行，
   *  按第一声部切会把别的声部几行并成一行、几行词并成一条。 */
  protected override bodyLines(song: Song): string[] {
    const L: string[] = [];
    song.parts.forEach((part, i) => {
      const ranges = systemRanges(part);
      const texts = this.partSystems(part, song, ranges, true);
      L.push(`[V: ${i + 1}]`);
      ranges.forEach((sys, r) => {
        if (!texts[r]) return;
        L.push(texts[r]!);
        L.push(...lyricLines(part, this.lyricSeparator, this.lyricSkip, sys, this.lyricSlotRule, this.lyricStyle));
      });
    });
    return L;
  }

  /** 一首歌 → Muse 文本。MusicXML 形状的先投成简谱形状（时值换成以四分为 `SIMPLE_DIVISIONS` 的口径），再补度数。
   *  别的来源时值本就是这个口径，不投——投了长休止会拆成一串四分休止。 */
  override emitSong(src: Song): string {
    const song = marksOffSustains(withDegrees(isXmlShaped(src) ? projectForJianpu(src) : src));
    const L: string[] = [];
    // Muse 自己的排版参数（读入时原样留在 `style.raw`）照写回去
    for (const r of song.style?.raw ?? []) L.push(`%%${r.key} ${oneLine(r.value)}`.trimEnd());
    // 说明书 FAQ「最容易犯的错误」：头部必须以 `T:` 起，哪怕是空的
    L.push(`T:${oneLine(song.work.title ?? "")}`);
    for (const st of song.work.subtitles) L.push(`T:${oneLine(st)}`);
    for (const c of song.identification?.creators ?? []) if (oneLine(c.text)) L.push(`C:${oneLine(c.text)}`);
    for (const t of song.pageText?.topRight ?? []) if (oneLine(t)) L.push(`C:${oneLine(t)}`);
    for (const s of getMeta(song, "source")) L.push(`S:${oneLine(s)}`);
    for (const t of song.pageText?.topLeft ?? []) if (oneLine(t)) L.push(`I:${oneLine(t)}`);
    if (song.time) L.push(`M:${song.time.beats}/${song.time.beatType}`);
    L.push("L:1/8");
    for (const t of song.tempos ?? []) {
      if (typeof t !== "number") continue; // 文字速度（「中速」）Muse 的 `Q:` 写不了，已在左上角文字里就留着
      const beat = song.tempoBeat ? `${song.tempoBeat.num}/${song.tempoBeat.den}` : "1/4";
      L.push(`Q:${beat}=${t}`);
    }
    L.push(`K:${song.key ? this.keyValue(song.key) : "C"}`);
    song.parts.forEach((part, i) => {
      const a = ["style=jianpu"];
      if (part.name) a.push(`name="${part.name.replace(/"/g, "'")}"`);
      if (part.abbrev) a.push(`sname="${part.abbrev.replace(/"/g, "'")}"`);
      if (part.museAttrs) a.push(part.museAttrs);
      L.push(`V:${i + 1} ${a.join(" ")}`);
    });
    // 文字块（说明书 §3.2.6.5）：读入的 `%%begintext` 与别的格式的说明文字都落在这里
    for (const r of song.remarks ?? []) {
      if (r.startsWith("P:")) continue; // ABC 的段落顺序，Muse 没有
      L.push("%%begintext", ...r.split(/\r\n?|\n/), "%%endtext");
    }
    L.push(...this.bodyLines(song));
    return L.join("\n");
  }

  /** 整份文档 → 文本。**Muse 一个文件一首**：多曲文档只写第一首（`capability.ts` 报 `multiSong` 丢失）。 */
  override emitDoc(doc: Parameters<AbcFamilyEmitter["emitDoc"]>[0]): string {
    const first = doc.songs[0];
    return [this.versionLine, first ? this.emitSong(first) : "T:\nK:C"].join("\n") + "\n";
  }
}

export const EMITTER_JCX = new EmitterJcx();
