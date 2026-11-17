// 「按乐句重排」写回原文——**文本谱以外的那几种格式**（123 / ABC / `.jpwabc`）。
//
// 断句本身与格式无关（`score/phrase.ts`），落点也已经由 `jianpu/phrase.ts::phraseCuts` 换算成
// 「新行从哪个元素起」。这里只管最后一步：把那些落点写回各自的原文。两种写法：
//
// - **123 / ABC**：断点写进 `ScoreDoc` 的换行位（`Print.newSystem` / `newPage`），整份按
//   `emit123` / `emitAbc` 重出。写出端本来就按 `$` 切系统、把各段 `w:` 行跟着重新归行
//   （`abcfamily/emit.ts::partSystems`），歌词对位因此自动跟着走——这是不自己切原文的理由。
//   代价是注释与用户手写的排布被规范化，换回「原始排版」是把重排前那份原文整份放回去（App 存着）。
// - **`.jpwabc`**：**只挪 `$` 标记**，别的字符一个不动。`.jpwabc` 是分节文件，`.Voice` 之外
//   还有 `.Words`/`.Layout`/`.Fonts` 等节，整份重出会把写出端装不下的东西（样式、分页描述）
//   一并抹掉；而歌词在 `.Words` 里按小节/音符号锚定、与行结构无关，所以只重切 `.Voice` 的行
//   就够。`.Layout` 里按行号记的 `BreakPoints` 跟着行结构作废，重排时去掉（换页改由
//   `$(true,0,0,true)` 原位表达）。
//
// **小节中间的断点**（弱起谱的乐句尾常落在这儿）三种格式一样**原位保留**：`.jpwabc` 的 `$` 写在
// 小节中间；123/ABC 记成 `Chord.lineBreakAfter`，写出端在那个音后面写 `$` 并收一行，歌词跟着
// 各段归行（123 §9「小节中间换行」）。早先 123/ABC 挪到下一根小节线，弱起句的头几个字就留在了
// 上一行行尾，与 `.jpwabc` 排出来的不一样。
//
// 判据都在 Rust：断点（`dolce_view::phraselines`）、写换行位（`dolce_model::breaks`）、`.jpwabc` 挪 `$`（`dolce_formats::jpw::relayout`）、
// 注释缝合（`dolce_formats::abc::comments`）。`relayoutDocBreaks` 逐首「算断点 → 写换行」留在这里串：行长尺子（`LinePlan.measure`）在 TS 量，
// 而且量第二首时第一首已改过，照原次序一首一首来。

import type { ScoreDoc } from "../model/doc";
import { applyBreaks, type LineStart } from "../model/breaks";
import { phraseCuts, type LinePlan } from "./phrase";
import { dolce } from "../common/dolce";
import { call } from "../model/rustdoc";

/** 缺省的分法：按乐句、不量宽 */
const PHRASE: LinePlan = { kind: "phrase", measure: null };

export interface DocRelayoutOptions {
  /** 新行怎么分（见 `jianpu/phrase.ts::LinePlan`）；不给就按乐句、出厂的小节数目标断。 */
  plan?: LinePlan;
  /** 小节中间的断点怎么落：`inline` 原位记在和弦上；`snap` 挪到下一根小节线。 */
  midBreaks: "inline" | "snap";
}

/**
 * 把重排（按乐句 / 每行 n 小节）的断点写进 `ScoreDoc` 的换行位。逐首处理，**改的是传进来的这份文档**。
 *
 * **只改换行，不造换页**：源里原有的 `%%newpage` 照留，乐句断句按「一页 4 行 + 段界」算出的换页
 * （`PhraseCut.page`）不写进源文——那是投影片的分页，投影档自己会分（`place/expand.ts`），
 * 写进 123 反倒让简谱档多出分页。
 *
 * @returns 有没有排出新的行结构（没有可排的曲行时 false）
 */
export function relayoutDocBreaks(sdoc: ScoreDoc, opt: DocRelayoutOptions): boolean {
  let changed = false;
  sdoc.songs.forEach((song, si) => {
    const cuts = phraseCuts(sdoc, si, opt.plan ?? PHRASE);
    if (!cuts || cuts.length === 0) return;
    const starts: LineStart[] = [];
    for (const cut of cuts) if (cut.id !== null) starts.push({ id: cut.id });
    if (applyBreaks(song, starts, { mid: opt.midBreaks, pages: "keep" })) changed = true;
  });
  return changed;
}

// ───────────────────────── 注释缝合（123 / ABC） ─────────────────────────

/**
 * 把原文里的注释缝进重排后的文本（123 / ABC）。注释不进模型，整份重出自然就丢了：每条注释跟着**它后面那条音乐行**走，
 * 落点用「第几个和弦」认；文件开头那一批留在文件开头，全曲之后的追加在末尾；`%%` 指令不算注释。
 *
 * @param oldText 重排前的原文
 * @param oldDoc  它解析出来的那一份（`Chord.source` 要在——落点靠它认行）
 * @param newText 重排后重出的文本
 * @param newDoc  `parse(newText)`
 */
export function spliceComments(oldText: string, oldDoc: ScoreDoc, newText: string, newDoc: ScoreDoc): string {
  return call(() => dolce().abcSpliceComments(oldText, JSON.stringify(oldDoc), newText, JSON.stringify(newDoc)));
}

// ───────────────────────── .jpwabc ─────────────────────────

/**
 * 重排（按乐句 / 每行 n 小节）一份 `.jpwabc` 原文：**只重切 `.Voice` 的行**（挪 `$`），别的节原样；
 * `.Layout` 里按行号记的 `BreakPoints` 跟着作废（换页改由 `$(true,0,0,true)` 原位表达）。
 *
 * @param text 编辑器里的原文
 * @param sdoc 它解析出来的那一份（`jpwToScoreDoc`）
 * @returns 新原文；没有可重排的曲行时原样返回
 */
export function relayoutJpwabcText(text: string, sdoc: ScoreDoc, opt: { plan?: LinePlan } = {}): string {
  const cuts = phraseCuts(sdoc, 0, opt.plan ?? PHRASE);
  if (!cuts || cuts.length === 0) return text;
  return call(() => dolce().jpwRelayoutText(text, JSON.stringify(cuts)));
}
