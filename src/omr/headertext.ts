// 页眉文字的**纯文本判据**（不看像素）：简谱页眉（`header.ts`）与位图五线谱页眉（`rasteromr/words.ts::headerCredits`）共用。
// 署名几种写法的正则、标题按「有效字高」挑的比法放这里；按墨列补空格、拍号墨迹这些要回源图量的留在各自那边。
import type { Rect } from "./types";

// 著作者前缀：`作词：`/`词曲：`，也含顿号/斜杠分列的 `词、曲：`、`作词/作曲：`。
export const CREDIT_PREFIX_RE = /^\s*[作詞词曲編编譯译]{1,2}(?:\s*[、，,/／]\s*[作詞词曲編编譯译]{1,2})*\s*[:：]/;
// 后缀式著作者：中文谱很常见把职能写在名字**后面**、且不带冒号——"盛晓玫 词曲"、
// "卢永亨词曲"、"黄霑作词、作曲"。前缀式一条都认不出（实测 4 首词曲整档 0 分）。
// 判据是整行恰好等于「人名(2~4 字，可顿号并列) + 职能词组」。**认出来后照谱面原样输出**
// （从前归一成 `<职能>：<名字>`）：谱面怎么印就怎么写，不调换次序、不补分隔符——
// "黄 霑作词、作曲" 那种名字与职能之间本就没有空当，补一个反倒不是原样。
// 要求**不是最大字号行**，免得短标题被当成著作者、连标题一起丢掉。
// 名字组**非贪婪**、职能组锚定行尾：贪婪会把「卢永亨词曲」的「词」吃进名字、只剩「曲」→
// 出成 `作曲：卢永亨词`。非贪婪 + `$` 让引擎先给名字最短长度，回溯到「卢永亨」+「词曲」。
// 职能词之间的分隔符**可选**：既有「作词、作曲」也有连写的「词曲」，后者若强求分隔符，
// 职能组只吃得下一个字，剩下那个会被名字回溯吞掉（→ `作曲：卢永亨词`）。
export const CREDIT_SUFFIX_RE = /^\s*([一-鿿·]{2,4}?(?:\s*[、，,]\s*[一-鿿·]{2,4}?)*)\s*((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$/;
// 后缀式著作者的名字也可能是**英文名**——"John Laudon 词曲"（1《以色列的圣者》）。上面那条
// 正则的名字组只收汉字，整行就落到"非著作者行"里、词曲整档为空。故另走一条：先按行尾的
// 职能词组切开，剩下的前半必须是**纯拉丁名**（字母 + 空格/点/连字符之类），再按字距补回
// 词间空格（rec 不吐空格，读出来是 `JohnLaudon词曲`）。名字里但凡有个汉字就不走这条，
// 仍归上面那条中文名规则，两条互不重叠。
export const CREDIT_ROLE_TAIL_RE = /((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$/;
// 名字里还可能带生卒/出版年份与括号（"Felice de Giardini (1769) 曲"），故收数字与括号；
// 但**必须以字母打头**——纯数字/符号的短碎块（页码、调号）不会被当成人名。
export const LATIN_NAME_RE = /^[A-Za-z][A-Za-z0-9 .,'’&·()（）\-]*$/;
// 名字 + 职能 + 年份（新编赞美诗·四声部：「希伯词 1826」「刘廷芳 杨荫浏合译 1932」「柯克帕特里克曲 1838 – 1921」
// 「据传马丁·路德词 1530」）。上面那条名字只收 2~4 字、不收「译」、行尾也不许带年份，一条都认不出。
export const CREDIT_YEAR_RE = /^\s*[一-鿿·]{2,10}?\s*(?:合译|[作編编]?[詞词曲譯译])\s*\d{4}(?:\s*[-–—]\s*\d{4})?\s*$/;
// 署名下一行括号里的原文名（「(Reginald Heber)」「(John B. Dykes)」），单独成行。
export const LATIN_PAREN_RE = /^\s*[(（][A-Za-z][A-Za-z .'’\-]*[)）]\s*$/;

/**
 * 一行字的**有效字高**：框高与「框宽 ÷ 字数」取小——只在明显叠排（按字宽算不到框高七成）时才换：det 框高带留白，
 * 正常一排字的「框宽 ÷ 字数」也比框高小一成上下，一律取小会把标题与右上角分类行拉平、按宽度输掉（选本 36「第三十六首」输给「相信接受29」）。
 */
export function effectiveCharH(text: string, bbox: Rect, charH: number): number {
  const units = [...text].reduce((a, c) => a + (/[一-鿿]/.test(c) ? 1 : /[A-Za-z0-9]/.test(c) ? 0.6 : 0), 0);
  return units >= 2 && bbox.w / units < charH * 0.7 ? bbox.w / units : charH;
}

/**
 * 候选 a 比现任标题 b 更像标题：有效字高大出 25% 以上；或差不多（15% 以内）而**更宽**。det 给的框高只是个近似，
 * 同一本书里印在右上角的出版方（迦南诗选每页都印着「迦南诗歌」）会因框松紧不同忽而比标题矮、忽而比它高——
 * 整行宽度在这里是压倒性的（标题是一整句、出版方只有四个字）。
 */
export function betterTitle(effA: number, wA: number, effB: number, wB: number): boolean {
  return effA > effB * 1.25 || (effA >= effB * 0.85 && wA > wB);
}

/**
 * 一行是不是署名（只看文字）。`smaller`：这行字比页眉里最大的字小（后缀式、年份式、括号原文名要求这一条，免得短标题被当成署名）。
 * 简谱那边逐条分支各有原样输出的讲究，判「是不是」与这里同一口径；五线谱页眉另认拉丁写法（`Words by`、`Music by`、`arr.`…）。
 */
export function isCreditText(text: string, smaller: boolean, latin = false): boolean {
  const t = text.trim();
  if (CREDIT_PREFIX_RE.test(t)) return true;
  if (smaller && (CREDIT_SUFFIX_RE.test(t) || CREDIT_YEAR_RE.test(t) || LATIN_PAREN_RE.test(t))) return true;
  if (smaller) {
    const m = CREDIT_ROLE_TAIL_RE.exec(t);
    const name = m ? t.slice(0, m.index).trim() : "";
    if (m && LATIN_NAME_RE.test(name) && /[A-Za-z]{2}/.test(name)) return true;
  }
  return latin && LATIN_CREDIT_RE.test(t);
}
/** 拉丁写法的署名：`Words by …`、`Music by …`、`Arr. …`、`Text: …`、`Tune: …`、`Translated by …`。 */
export const LATIN_CREDIT_RE = /^\s*(?:words|music|lyrics?|text|tune|arr(?:anged)?|translated|transl?|harmony|harm)\b\.?\s*(?:by\b|:)?/i;

/** 署名的角色：有「曲」（或 music / tune / arr）的算作曲，只有「词 / 译」的算作词。 */
export function creditRole(text: string): "lyricist" | "composer" {
  return /[曲編编]|music|tune|arr|harm/i.test(text) ? "composer" : "lyricist";
}
