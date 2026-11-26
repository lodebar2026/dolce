// **格式能力表**：每种源格式装得下什么。表与判据在 Rust（crates/model/src/formats/capability.rs，依据逐条写在那边），这里是门面：
// 特性的名字（按界面语言）、目标格式名、丢失清单排序与给人看的那段话。
//
// 用途只有一个：另存为别的格式之前，算出「这份文档里用到、但目标格式装不下」的东西，
// 列给用户，确认后再写（`editor/dialogs.ts::showConfirmDialog`）。

import type { ScoreDoc } from "../model/doc";
import { dolce } from "../common/dolce";
import { call, docJson } from "../model/rustdoc";
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
  | "singOrder"         // 逐遍演唱顺序（123 `%%sing`：逐页逐行写明排哪几段、配哪段词）
  | "sectionOrder"   // 段落顺序（ABC §3.1.9 的 `P:` 与曲内标记）
  | "layouts"        // 版面（123 `%%layout`：断行方式、断点、每页行数、自定义版面）
  | "style"          // 样式表引用
  | "layoutDirectives" // 文档内的版面指令（文本谱的 `FontSize:` / `Margin:` / `Space:` / `Off:`）
  | "keyChange"      // 曲中转调
  | "tonicDegree"    // 主音唱名不是 1（首调 `6=E`、`K:Em`）
  | "multiVerse"     // 多段歌词
  | "volta"          // 房号
  | "shortOpenVolta" // 只罩一小节、右端不封口的房号（番茄单小节的 `]/` 照样封口）
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
  playOrder: "演唱顺序 .Repeat（会改成按谱面的反复记号唱）",
  singOrder: "逐遍演唱顺序 %%sing（投影会改成按谱面的反复记号逐遍排）",
  sectionOrder: "段落顺序（P:，会改成按谱面的反复记号唱）",
  layouts: "版面 %%layout（断行方式、断点、每页行数与自定义版面，只留谱里写的换行）",
  style: "样式表引用",
  layoutDirectives: "版面指令（字号、页边距等）",
  keyChange: "曲中转调",
  tonicDegree: "主音唱名（6=E 这类写法，会改写成同调号的 1= 大调）",
  multiVerse: "多段歌词",
  volta: "房号",
  shortOpenVolta: "只罩一小节的不封口房号（会画成封口）",
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

const TARGETS = Object.keys(TARGET_LABEL) as TargetFormat[];

/** 每种格式装得下哪些（能力表那一行；按需向 Rust 取一次）。 */
export const FORMAT_CAPS: Readonly<Record<TargetFormat, ReadonlySet<Feature>>> = (() => {
  const out = {} as Record<TargetFormat, ReadonlySet<Feature>>;
  for (const target of TARGETS) {
    let caps: ReadonlySet<Feature> | undefined;
    Object.defineProperty(out, target, {
      enumerable: true,
      get: () => (caps ??= ((): ReadonlySet<Feature> => {
        const gone = new Set(JSON.parse(dolce().formatsGone(target)) as Feature[]);
        return new Set((Object.keys(FEATURE_NAMES) as Feature[]).filter((f) => !gone.has(f)));
      })()),
    });
  }
  return out;
})();

/** 这份文档实际用到了哪些特性。 */
export function featuresUsed(doc: ScoreDoc): Set<Feature> {
  const { json, h } = docJson(doc);
  return new Set(JSON.parse(call(() => dolce().formatsFeaturesUsed(json, h))) as Feature[]);
}

export interface Loss {
  feature: Feature;
  name: string;
}

/** 存成 `target` 会丢掉什么 = 用到的 ∖ 目标装得下的。空数组 = 无损。 */
export function planSave(doc: ScoreDoc, target: TargetFormat): Loss[] {
  const { json, h } = docJson(doc);
  return (JSON.parse(call(() => dolce().formatsPlanSave(json, h, target))) as Feature[])
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
