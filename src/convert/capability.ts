// **格式能力表**：每种源格式装得下什么。
//
// 用途只有一个：另存为别的格式之前，算出「这份文档里用到、但目标格式装不下」的东西，
// 列给用户，确认后再写（`editor/dialogs.ts::showConfirmDialog`）。
//
// ## 表里的内容不是凭空写的
//
// 每一条都来自既有的实测与各模块文档的「已知限制」：
//
// | 来源 | 得到的条目 |
// |---|---|
// | `../dev/docs/待办/格式与语料迁移.md`（私有仓库）「无法表达」的全语料实测 | 文字行 `W:` / 圆滑线 / 多段歌词 / 印刷段号 / 多声部 / 分曲 / 倚音 / 房号 |
// | `docs/模块/模型-scoredoc.md` | `playOrder` 与 `style` 是 **MusicXML 装不下的两样**（`<ending>` 只能整小节） |
// | `docs/模块/源格式-abc家族.md` | ABC 那一档的 clef/修饰、`Q:` 参照音符长度 |
// | `break-roundtrip-check`（断点写回 → 各写出端 → 读回） | 换页（ABC 装不下）；换行含小节中间的，六种都装得下，不列 |
//
// **改这张表之前先去改那几处的实测**——这里只是它们的汇总。

import type { Mark, ScoreDoc, Song } from "../model/doc";
import { arcsToNextNote, beamLevel1, inlineBreakOf, nestArcsInTuplets } from "../model/emitutil";
import { eachChord, verseCount } from "../model/helpers";
import { projectForJianpu } from "../model/jianpuproject";
import { melodyLane } from "../model/jianpu";
import { hasCrossStaff } from "../model/staves";
import { beatGroupIndex, beatGroupSize } from "../engrave/beatgroup";
import { fanqieArcLosses } from "../fanqie/tofanqie";
import { chordNotehead, decoKey, noteheadOf, rehearsalOf, tremoloStrokes } from "../model/deconames";
import { songHeaderFonts, songLyricSize, songPage, songStaffSize } from "../model/pagemeta";
import { getLang, t } from "../i18n";

/** 一项「文档里可能用到、格式可能装不下」的特性。 */
export type Feature =
  | "harmony"        // 和弦符号
  | "harmonyOffset"  // 落在长音中间、又不在整拍上的和弦（简谱挂不到增时线上）
  | "multiVoice"     // 多声部（多个 part）
  | "noteStack"      // 同一声部里同时发声的几个音（五线谱的和弦内音、民乐分谱的双音）
  | "innerVoice"     // 同一谱表上的第二 voice（ABC/123 的 `&`）
  | "innerVoiceLyrics" // 同一谱表上第二 voice 自己的歌词（合唱谱女低另配一套词；`w:` 只跟 `&` 的第一支）
  | "extraStaff"     // 一个声部的第二条谱表（钢琴下谱表、扬琴 `<staves>2`）
  | "crossStaff"     // 跨谱表的音与连线（钢琴谱跨谱表书写、连到另一条谱表上的弧）
  | "octaveShift"    // 八度线（`<octave-shift>`，8va / 8vb）
  | "beamGroup"      // 不按拍的符杠分组（跨拍连、拍内断开；简谱各格式的减时线一律按拍连）
  | "rhythmStack"    // 一个和弦里叠几个节奏音符（打击乐谱钹与鼓同时，`<unpitched>` 带 `<chord/>`）
  | "rhythmPosition" // 节奏音符在谱表上的显示位置（打击乐谱 `<unpitched>` 的 display-step/octave）
  | "graceArc"       // 倚音连到自己主音的弧（文本谱的倚音是音符属性，弧落不到倚音上）
  | "dynamics"       // 力度与渐强渐弱
  | "playOrder"      // 演唱顺序（含 skip/limit）
  | "style"          // 样式表引用
  | "layoutDirectives" // 文档内的版面指令（文本谱的 `FontSize:` / `Margin:` / `Space:` / `Off:`）
  | "keyChange"      // 曲中转调
  | "tonicDegree"    // 主音唱名不是 1（首调 `6=E`、`K:Em`）
  | "multiVerse"     // 多段歌词
  | "volta"          // 房号
  | "grace"          // 倚音
  | "slur"           // 圆滑线
  | "textLine"       // 文字行（段落词、注记）
  | "multiSong"      // 一个文件多首
  | "pageText"       // 页眉页脚
  | "meta"           // 扩展 meta（英文标题、经文、标签…，`Song.meta`）
  | "paper"          // 谱里自带的纸（MusicXML `<page-layout>`、123/ABC `I:meta page`）
  | "verseLabel"     // 印刷段号 `<1.>`
  | "rhythmNote"     // 节奏音符（有声无音高）
  | "invisibleRest"  // 不可见休止
  | "nestedArc"      // 一条弧线完全包住另一条（文本谱的括号先开先闭，写不出）
  | "oddTuplet"      // 比例不是 n:n−1 的多连音（文本谱里 n 个音一律占 n−1 个基本时值）
  | "slurCrossTuplet" // 跨出多连音组、又不是连到下一个音的弧（123 的括号只许嵌套，连到下一个音的写 `~`）
  | "lyricOnRest"    // 挂在可见休止上的词（123、ABC 的休止不占对位格）
  | "pageBreak"      // 谱里写的换页（小节级或小节中间的）
  | "tremolo"        // 单音震音（MusicXML `<tremolo>`、123 `!///!`）
  | "bowing"         // 弓法（`<up-bow>` `<down-bow>`、123 `!upbow!` `!downbow!`）
  | "rehearsal"      // 排练号（`<rehearsal>`、123 `!rehearsal=A!`）
  | "multiRest"      // 多小节休止（`<multiple-rest>`、123 `Zn`）
  | "notehead"       // 叉形、圈叉等换形的符头（`<notehead>`、123 `!head-x!`）
  | "arpeggio"       // 琶音（`<arpeggiate>`、123/ABC `!arpeggio!`）
  | "staccatissimo"; // 楔形顿音（`<staccatissimo>`、123 `!wedge!`），与点状顿音分开记

/** 人看的名字，直接进丢失清单。 */
export const FEATURE_NAMES: Readonly<Record<Feature, string>> = {
  harmony: "和弦符号",
  harmonyOffset: "长音中间不在整拍上的和弦（会提前到音符上）",
  multiVoice: "多声部",
  noteStack: "同一声部里同时发声的音（和音、和弦内音，只留简谱印的最高音）",
  innerVoice: "同一谱表上的第二声部（只留简谱印的第一声部）",
  innerVoiceLyrics: "同一谱表上第二声部自己的歌词（歌词只跟第一声部）",
  extraStaff: "同一声部的第二条谱表（只留第一条）",
  crossStaff: "跨谱表的音与连线（音归它落在的谱表、连到另一条谱表的弧与延音线丢掉）",
  octaveShift: "八度线（8va / 8vb；丢掉后那几个音差一个八度）",
  beamGroup: "不按拍的符杠分组（会改成按拍连）",
  rhythmStack: "同时敲的几个节奏音符（只留一个）",
  rhythmPosition: "节奏音符在谱表上的位置（五线谱一律画在中线）",
  graceArc: "倚音连到主音的弧（别的弧改挂到主音上）",
  dynamics: "力度与渐强渐弱",
  playOrder: "演唱顺序（房号跳转、第几遍配第几段词）",
  style: "样式表引用",
  layoutDirectives: "版面指令（字号、页边距等）",
  keyChange: "曲中转调",
  tonicDegree: "主音唱名（6=E 这类写法，会改写成同调号的 1= 大调）",
  multiVerse: "多段歌词",
  volta: "房号",
  grace: "倚音",
  slur: "圆滑线",
  textLine: "段落词与注记",
  multiSong: "一个文件里的多首曲子",
  pageText: "页眉页脚",
  meta: "扩展曲目信息（英文标题、经文、标签等）",
  paper: "谱里写的纸张、页边距、五线谱谱表大小与歌词字号、页眉字体（改记进设置）",
  verseLabel: "印刷段号",
  rhythmNote: "节奏音符（有声无音高）",
  invisibleRest: "不可见休止",
  nestedArc: "套在另一条弧线里的弧线（外面那条或里面那条会丢一条）",
  oddTuplet: "比例特殊的多连音（按 n 个音占 n−1 拍写不出来）",
  slurCrossTuplet: "跨出多连音组的弧线（会截到组的边界）",
  lyricOnRest: "挂在休止符上的歌词",
  pageBreak: "换页（会改成换行）",
  tremolo: "震音",
  bowing: "弓法（上弓、下弓）",
  rehearsal: "排练号",
  multiRest: "多小节休止（会写成一小节一个休止）",
  staccatissimo: "楔形顿音（会与点状顿音并成同一个顿音）",
  arpeggio: "琶音",
  notehead: "叉形、圈叉等符头（简谱印成节奏音符 X）",
};

/** 目标格式。文本谱两种方言各算一种（装得下的不一样：番茄没有页眉页脚与版面指令字段）。 */
export type TargetFormat = "123" | "abc" | "jpwabc" | "tomato" | "shige" | "jly" | "jcx" | "musicxml";

/** 丢失清单里给人看的格式名。 */
export const TARGET_LABEL: Readonly<Record<TargetFormat, string>> = {
  "123": "123",
  abc: "ABC",
  jpwabc: "JPWABC",
  tomato: "番茄简谱",
  shige: "诗歌本文本谱",
  jly: "jianpu-ly",
  jcx: "Muse 简谱",
  musicxml: "MusicXML",
};

/** 文本谱两种方言都装不下的。依据见 `fanqie/tofanqie.ts` 开头与 `docs/模块/源格式-文本谱.md` 的已知限制：
 *  样式表引用、演唱顺序、扩展 meta 没有字段可落（文本谱只有按位置的 XL/XR/TL/TR/BL/BC/BR，不往里猜）；
 *  音符堆（和音）只写简谱印的那个音（同谱表的第二声部写 `{dsb…}` 并排块，写得出）；弧线与多连音共用一个先开先闭的括号队列。 */
const FANQIE_GONE: Feature[] = [
  // `{dsb…}` 并排块里不跟词（`tofanqie.ts`）
  "innerVoiceLyrics",
  "beamGroup", "octaveShift", "style", "playOrder", "harmonyOffset", "meta", "paper", "noteStack", "extraStaff", "rhythmStack", "rhythmPosition", "graceArc", "nestedArc", "oddTuplet",
  // 文本谱的记号表里没有这几样（番茄脚本规范同；用户定 2026-10-21 不扩，要的走 123）
  "tremolo", "bowing", "rehearsal", "multiRest", "arpeggio", "notehead",
  // 顿音只有一个 `dy`：楔形与点状并成一个，读回来都是点状
  "staccatissimo",
];
/** 只有 123 与 MusicXML 装得下的（123 的扩展写法，规范 §8.3/§9）。 */
const EXT_123: Feature[] = ["tremolo", "bowing", "rehearsal", "multiRest", "arpeggio", "notehead"];

const ALL: Feature[] = Object.keys(FEATURE_NAMES) as Feature[];
/** 「除了这几样，其余都装得下」。 */
const allBut = (...gone: Feature[]): Set<Feature> => new Set(ALL.filter((f) => !gone.includes(f)));

/** 每种格式装得下哪些。**装不下的写在 `allBut(...)` 里，并在注释里写清依据。** */
export const FORMAT_CAPS: Readonly<Record<TargetFormat, ReadonlySet<Feature>>> = {
  // 123 是按「装得下全部」设计的（`docs/格式/123格式.md`），实测全语料只有 0.17% 表达不了，
  // 那些是转换层的账不是格式的账。
  // 嵌套弧与任意比例的多连音（`(5:4:`）都写得出；弧与多连音的括号只许嵌套（从组里连到组外下一个音写 `~`，
  // 跨得更远的写不出）、可见休止不跟词（规范 §4.1、§5.1）
  // 和音写 `[13]`（§4.2，照 ABC 的 `[CEG]`；民乐分谱的双音，用户定 2026-10-21 加）；同一谱表上的第二 voice 照 ABC §7.4 写 `&`、
  // 节奏音符的谱表位置与同时敲的几个写 `X@E5` / `[X@E5X@F5]`（§4.2、§4.3，用户定 2026-10-21 加）；
  // 一个声部的几条谱表各写一个 `V:`、第二条起 `part=`（§7，`staves.ts`，用户定 2026-10-24），跨谱表的东西写不出
  // 八度线（8va）两种格式都没有写法（abc2svg 的 `!8va(!` 是扩展，用户定不扩），音照实际音高写
  // 符杠一律按拍自动连（§11「语料高频但刻意不做」），写明的跨拍连杠写不出
  // `w:` 只跟 `&` 的第一支（§7.4），第二支自己的歌词写不出
  "123": allBut("harmonyOffset", "crossStaff", "innerVoiceLyrics", "slurCrossTuplet", "lyricOnRest", "octaveShift", "beamGroup"),
  // 标准 ABC：样式被规范标为 VOLATILE（§11，「not standardised」），所以 123 才把样式
  // 另走样式表；`I:playorder` 是 123 的扩展，标准 ABC 读不懂（虽然会忽略，等于丢）。
  // 休止不跟词（ABC §5.1「syllables are not aligned on … rests」）；
  // 换页写 `%%newpage`（§11.4.7 排版指令，`emitabc.ts::pageBreakLine`）；换行本身含小节中间的都装得下（`break-roundtrip-check` 实测）
  // 弓法、震音是 ABC 的标准装饰（写得出）；排练号、`Zn` 多小节休止写出端只给 123
  // 大谱表同 123：每条谱表一个 `V:`、第二条起 `part=`（`staves.ts`），跨谱表的东西写不出
  abc: allBut("style", "playOrder", "innerVoiceLyrics", "rhythmNote", "rhythmStack", "rhythmPosition", "crossStaff", "octaveShift", "harmonyOffset", "lyricOnRest", "rehearsal", "multiRest"),
  // `.jpwabc` 的语法**刻意不扩**：和弦、力度、多声部都写不进去。
  // 音符堆：写出端只留最高音、删 voice > 1
  jpwabc: allBut("beamGroup", "octaveShift", "tonicDegree", "harmony", "harmonyOffset", "slur", "dynamics", "multiVoice", "noteStack", "innerVoice", "extraStaff", "rhythmStack", "rhythmPosition", "style", "layoutDirectives", "multiSong", "grace", "meta", "paper", "nestedArc", "oddTuplet", ...EXT_123),
  // 文本谱：展开档谱面不画和弦/力度/多声部，但文本谱**原文**装得下和弦、力度（`&f`、`<`…`!`）——
  // 这里算的是「另存为之后还在不在」，所以按解析器的能力写。
  // 番茄另外没有页眉页脚与版面指令字段（写了会被嗅探成诗歌本，见 `fanqie/dialect.ts::EmitStyle.pageFields`）
  // 番茄的调号字段 `D:` 只有音名、没有主音唱名（诗歌本的 `6=E4/4` 写得出）
  tomato: allBut(...FANQIE_GONE, "pageText", "layoutDirectives", "tonicDegree"),
  shige: allBut(...FANQIE_GONE),
  // jianpu-ly 装不下什么，依据 `docs/格式/jianpu-ly.md` 与 `tojly.ts` 的 `warnings`：
  //   · 多声部/多曲只写第一路（`NextScore` 本版不写）；扩展 meta、纸、样式表、页面文字没有字段；
  //   · 演唱顺序只认跳转裸词（`Fine`/`DC`/`Segno`/`ToCoda`），`playOrder` 的自定义跳转写不出；
  //   · 演奏法（`articulations` 里不是力度名的那批）、拉丁歌词的连字符（`syllabic`）写不出；
  //   · 房号只能两房（第 3 房起退化）；换页能写 `\pageBreak`，但**再读回来**会降级成换行；
  //   · 版面指令只认它自己那几个开关（`NoBarNums` 等），文本谱那套 `fontsize`/`margin` 写不出。
  jly: allBut("beamGroup", "octaveShift", "rhythmStack", "rhythmPosition", "innerVoice", "extraStaff", "multiVoice", "multiSong", "meta", "paper", "style", "pageText", "playOrder",
    "layoutDirectives", "dynamics", "verseLabel", "tonicDegree", ...EXT_123),
  // Muse `.jcx`（`emitjcx.ts`，说明书 §3.2）：一个文件一首；没有样式表、演唱顺序、扩展 meta（只留「来源」`S:`）、
  // 纸张字段（Muse 的 `%%` 排版参数与本项目的不是一套）；页面文字只有左上 `I:` 与右上 `C:`，页脚没有；
  // 力度没有对应的装饰名（渐强渐弱的 `(<` `<)` 写得出）；歌词没有印刷段号、休止不跟词（同 ABC）；换页退成换行
  jcx: allBut("beamGroup", "octaveShift", "rhythmStack", "rhythmPosition", "innerVoice", "extraStaff", "multiSong", "style", "playOrder", "meta", "paper", "pageText", "layoutDirectives", "dynamics",
    "verseLabel", "lyricOnRest", "harmonyOffset", "pageBreak", "tonicDegree", ...EXT_123),
  // MusicXML 装不下的两样：`playOrder` 的 skip/limit（`<ending>` 只能整小节）与样式引用。
  // 见 `docs/模块/模型-scoredoc.md` 的关键判据。主音唱名（`6=E`）只有 `<fifths>`/`<mode>`，读回不记唱名。
  // jianpu-ly、Muse、`.jpwabc` 的调号也只写 `1=` 大调 / 调号，主音唱名同样写不出。
  musicxml: allBut("playOrder", "style", "layoutDirectives", "nestedArc", "oddTuplet", "tonicDegree"),
};

/** 文本谱认的版面指令（`fanqie/parse.ts` 的头部字段）。123/ABC 读进来是小写（`I:fontsize`）。 */
const LAYOUT_DIRECTIVE = /^(fontsize|margin|space|off)$/i;

function keyDiffers(a: NonNullable<Song["key"]>, b: NonNullable<Song["key"]>): boolean {
  return a.fifths !== b.fifths || (a.spelling ?? "") !== (b.spelling ?? "") || (a.tonicDegree ?? "1") !== (b.tonicDegree ?? "1");
}

/**
 * MusicXML 写明的符杠分组与按拍自动连的不一样（跨拍连成一组、或一拍里断开）：简谱各格式的减时线按拍连（`autoBeams` 同口径），写不出。
 * 只看第一层；拍长同 `engrave/beatgroup.ts`（x/8 且拍数是 3 的倍数按附点四分，其余四分）。
 */
function irregularBeams(song: Song): boolean {
  for (const part of song.parts) {
    let divisions = 1;
    let time = { beats: 4, beatType: 4 };
    for (const m of part.measures) {
      if (m.attrs?.divisions) divisions = m.attrs.divisions;
      if (m.attrs?.time) time = m.attrs.time;
      const size = beatGroupSize(time.beats, time.beatType);
      let end = 0;
      /** 各声部：上一个连杠音的（组号、拍号） */
      const prev = new Map<number, { group: number; beat: number }>();
      let group = 0;
      for (const el of m.elements) {
        const s = el.onset ?? end;
        end = s + (el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : el.duration?.divisions ?? 0);
        if (el.kind !== "chord" || el.grace) continue;
        const b = beamLevel1(el.beams);
        if (b === undefined) {
          prev.delete(el.voice);
          continue;
        }
        if (b === "begin") group++;
        const beat = beatGroupIndex(s / divisions, 0, size);
        const p = prev.get(el.voice);
        if (p) {
          if (b !== "begin" && p.beat !== beat) return true; // 一组跨了拍
          if (b === "begin" && p.beat === beat) return true; // 同一拍里断开另起
        }
        prev.set(el.voice, { group, beat });
        if (b === "end") prev.set(el.voice, { group: -1, beat });
      }
    }
  }
  return false;
}

/** 这份文档实际用到了哪些特性。 */
export function featuresUsed(doc: ScoreDoc): Set<Feature> {
  const used = new Set<Feature>();
  if (doc.songs.length > 1) used.add("multiSong");
  for (const song of doc.songs) {
    if (song.parts.length > 1) used.add("multiVoice");
    if (song.playOrder?.length) used.add("playOrder");
    if (song.style?.sheetRef || song.style?.inline?.length) used.add("style");
    for (const r of song.style?.raw ?? []) used.add(LAYOUT_DIRECTIVE.test(r.key) ? "layoutDirectives" : "style");
    // MusicXML 的页脚只写在 `<credit>` 里：转简谱文本时才落成页面文字（`jianpuproject.ts::headerFromCredits`），照转出的算
    if (song.pageText || projectForJianpu(song).pageText) used.add("pageText");
    if (song.meta && Object.keys(song.meta).length) used.add("meta");
    if (songPage(song) || songStaffSize(song) || songLyricSize(song) || Object.keys(songHeaderFonts(song)).length) used.add("paper");
    if (song.remarks?.length) used.add("textLine");
    if (verseCount(song) > 1) used.add("multiVerse");
    if (song.key?.tonicDegree && song.key.tonicDegree !== "1") used.add("tonicDegree");
    for (const m of song.marks ?? []) {
      if (m.type === "slur") used.add("slur");
      if (m.type === "wedge") used.add("dynamics"); // 渐强渐弱
    }
    for (const part of song.parts) {
      part.measures.forEach((mea, mi) => {
        if (mi > 0 && mea.attrs?.key && song.key && keyDiffers(mea.attrs.key, song.key)) used.add("keyChange");
        if (mi > 0 && mea.print?.newPage) used.add("pageBreak");
        if (mea.elements.some((el) => inlineBreakOf(el) === "page")) used.add("pageBreak");
      });
      for (const mea of part.measures) {
        const lane = melodyLane(mea);
        for (const b of mea.barlines ?? []) if (b.ending) used.add("volta");
        // 力度与渐强渐弱走 `<direction>`
        for (const d of mea.directions ?? []) {
          if (d.type === "dynamics" || d.type === "wedge") used.add("dynamics");
          if ([d, ...(d.more ?? [])].some((x) => x.type === "rehearsal")) used.add("rehearsal");
          if (d.type === "octave-shift") used.add("octaveShift");
        }
        if (mea.attrs?.multiRest) used.add("multiRest");
        for (const el of mea.elements) {
          if (el.kind === "space" && el.spacer === "x") used.add("invisibleRest");
          // MusicXML 读进来的和弦是结构化的、没有 text，所以按有无判
          if (el.harmony) used.add("harmony");
          if (el.kind === "chord") {
            const n = el.notations;
            if (n?.tremolo || n?.articulations?.some((a) => tremoloStrokes(a) !== undefined)) used.add("tremolo");
            if (n?.technical?.some((x) => x === "up-bow" || x === "down-bow") || n?.articulations?.some((a) => decoKey(a) === "sg" || decoKey(a) === "xg")) used.add("bowing");
            if (n?.articulations?.some((a) => rehearsalOf(a) !== undefined)) used.add("rehearsal");
            if (n?.articulations?.some((a) => a === "staccatissimo" || a === "wedge")) used.add("staccatissimo");
            if (n?.arpeggiate || n?.articulations?.some((a) => decoKey(a) === "arp")) used.add("arpeggio");
            if (chordNotehead(el.notes) && chordNotehead(el.notes) !== "slash" || n?.articulations?.some((a) => noteheadOf(a))) used.add("notehead");
            if (el.notes.length > 1) used.add(el.rhythm ? "rhythmStack" : "noteStack");
            if (el.rhythm && el.notes.some((x) => x.unpitched?.step)) used.add("rhythmPosition");
            if (lane && el.staff !== lane.staff) used.add("extraStaff");
            else if (lane && el.voice !== lane.voice) {
              used.add("innerVoice");
              if (el.lyrics?.some((l) => l.text !== "")) used.add("innerVoiceLyrics");
            }
            if (el.grace) used.add("grace");
            if (el.rhythm) used.add("rhythmNote");
            if (el.sectionWord) used.add("textLine");
            if (el.printObject === false && el.rest) used.add("invisibleRest");
            if (el.rest && el.printObject !== false && el.lyrics?.some((l) => l.text !== "")) used.add("lyricOnRest");
            for (const l of el.lyrics ?? []) if (l.verseLabel !== undefined) used.add("verseLabel");
          }
        }
      }
    }
    if (hasCrossStaff(song)) used.add("crossStaff");
    if (irregularBeams(song)) used.add("beamGroup");
    for (const { chord } of eachChord(song)) {
      for (const su of chord.sustains ?? []) if (su.harmony) used.add("harmony");
    }
    // 长音中途换和弦：进简谱形状后还挂不到增时线上的才算（`jianpuproject.ts`）
    if ([...eachChord(song)].some(({ chord }) => chord.laterHarmonies?.length)) {
      if ([...eachChord(projectForJianpu(song))].some(({ chord }) => chord.laterHarmonies?.length)) used.add("harmonyOffset");
    }
    // 跨出多连音的弧（123 的括号只许嵌套）：连到下一个音的写成 `~`，不算；判据与写出端同一份（`abcfamily/emit.ts`）
    for (const part of song.parts) {
      const isArc = (m: Mark): boolean => m.type === "slur" || m.type === "tied";
      const marks = song.marks ?? [];
      const nest = nestArcsInTuplets(part, marks, isArc);
      if (nest.crossedMarks.size > arcsToNextNote(part, marks, isArc).size) used.add("slurCrossTuplet");
    }
    const arcs = fanqieArcLosses(song);
    if (arcs.nested) used.add("nestedArc");
    if (arcs.oddTuplet) used.add("oddTuplet");
    if (arcs.graceArc) used.add("graceArc");
  }
  return used;
}

export interface Loss {
  feature: Feature;
  name: string;
}

/** 存成 `target` 会丢掉什么 = 用到的 ∖ 目标装得下的。空数组 = 无损。 */
export function planSave(doc: ScoreDoc, target: TargetFormat): Loss[] {
  const caps = FORMAT_CAPS[target];
  return [...featuresUsed(doc)]
    .filter((f) => !caps.has(f))
    .map((f) => ({ feature: f, name: t(`feat.${f}`) }))
    .sort((a, b) => a.name.localeCompare(b.name, getLang()));
}

/** 丢失清单里的格式名（文本谱方言按界面语言）。 */
function targetName(target: TargetFormat): string {
  return target === "tomato" || target === "shige" ? t(`fmt.target.${target}`) : TARGET_LABEL[target];
}

/** 丢失清单 → 给人看的一段话。 */
export function describeLosses(target: TargetFormat, losses: readonly Loss[]): string {
  if (losses.length === 0) return "";
  return (
    t("loss.body", { n: losses.length, format: targetName(target) }) + "\n\n" +
    losses.map((l) => `　· ${l.name}`).join("\n") +
    "\n\n" + t("loss.continue")
  );
}
