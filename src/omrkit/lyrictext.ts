// 歌词文字的**纯文本口径**（不看像素）：哪些标点贴字、怎么折全半角。简谱（`omr/lyrics.ts`、`stanzas.ts`）与位图五线谱（`rasteromr/lyric.ts`）共用。

// 歌词里贴在字尾的标点。简谱印刷用全角，但 PP-OCR 常把 ，；：！？ 识成半角 , ; : ! ? ——
// 一并收下、统一折成全角（与 GT 一致；半角句点 . 不收，避免撞段号 "1." / 小数点）。
export const LYRIC_PUNCT = /[，。、；：！？…—,;:!?]/;
/** 半角句读折全角（只这五个）。 */
const HALF_TO_FULL: Record<string, string> = { ",": "，", ";": "；", ":": "：", "!": "！", "?": "？" };
export const fullPunct = (ch: string) => HALF_TO_FULL[ch] ?? ch;
// 简谱这边括号反过来折成半角：四声部本子「(阿 们)」印的是半角括号，rec 常读成全角（参考谱、GT 都写半角）。
const PUNCT_FULL: Record<string, string> = { ...HALF_TO_FULL, "（": "(", "）": ")" };
export const normPunct = (ch: string) => PUNCT_FULL[ch] ?? ch;
// 英文（拉丁字母）音节后的标点一律半角：rec 读英文行也常吐全角「，！？」（青年诗歌 22《将一生奉献》「To You，dear Lord！」），GT 记半角。
const FULL_TO_HALF: Record<string, string> = { "，": ",", "；": ";", "：": ":", "！": "!", "？": "?", "。": ".", "（": "(", "）": ")" };
export const halfPunct = (ch: string) => FULL_TO_HALF[ch] ?? ch;
/** 贴在这串字后面的标点该怎么折：末字是拉丁字母（含撇号收尾）折半角，否则照汉字口径 `normPunct`。 */
export const punctAfter = (prev: string, ch: string) => /[A-Za-z\u00C0-\u024F'’]$/.test(prev) ? halfPunct(ch) : normPunct(ch);
// 引号（都不占音符）：开引号 “‘ **领起后一字**（如 “阿门”里的 “ 贴 阿），闭引号 ”’ **贴前一字**。
// PP-OCR 对中文引号输出全角（实测 rec 已能读出 “ ”），故一并收下；半/全角开闭都认。
// 括号同理：左括号领起后一字、右括号贴前一字（四声部本子末尾的「(阿 们)」，阿、们各占一个阿们音）。
export const LYRIC_QUOTE_OPEN = /[“‘"'(（]/;
export const LYRIC_QUOTE_CLOSE = /[”’)）]/;
