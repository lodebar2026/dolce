// 「按乐句重排」写回原文——**文本谱以外的那几种格式**（123 / ABC / `.jpwabc`）。
//
// 断句本身与格式无关（`score/phrase.ts`），落点也已经由 `jianpu/phrase.ts::phraseCuts` 换算成
// 「新行从哪个元素起」。这里只管最后一步：把那些落点写回各自的原文。两种写法：
//
// - **123 / ABC**：断点写进 `ScoreDoc` 的换行位（`Print.newSystem` / `newPage`），整份按
//   `emit123` / `emitAbc` 重出。写出端本来就按 `$` 切系统、把各段 `w:` 行跟着重新归行
//   （`abcfamily/emit.ts::partSystems`），歌词对位因此自动跟着走——这是不自己切原文的理由。
//   代价是注释与用户手写的排布被规范化，换回「原样」是把重排前那份原文整份放回去（App 存着）。
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

import type { ScoreDoc } from "../model/doc";
import { applyBreaks, type LineStart } from "../model/breaks";
import { phraseCuts, type LinePlan, type PhraseCut } from "./phrase";
import { JpwFile, LayoutSection, VoiceSection } from "../jpword/jpwfile";

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
 * @returns 有没有排出新的行结构（没有可排的曲行时 false）
 */
export function relayoutDocBreaks(sdoc: ScoreDoc, opt: DocRelayoutOptions): boolean {
  let changed = false;
  sdoc.songs.forEach((song, si) => {
    const cuts = phraseCuts(sdoc, si, opt.plan ?? PHRASE);
    if (!cuts || cuts.length === 0) return;
    const starts: LineStart[] = [];
    for (const cut of cuts) if (cut.id !== null) starts.push({ id: cut.id, page: cut.page });
    if (applyBreaks(song, starts, { mid: opt.midBreaks, pages: "write" })) changed = true;
  });
  return changed;
}

// ───────────────────────── 注释缝合（123 / ABC） ─────────────────────────
//
// 注释不进模型（`abcfamily/parse.ts` 读到 `%` 就跳，`abcfamily/lex.ts` 遇 `%` 断行），整份重出自然
// 就丢了。所以重排完再把原文的注释**缝回去**：每条注释跟着**它后面那条音乐行**走
// （注释说的是下面那段谱），落点用「第几个和弦」认——两份文本内容一样，序号对得上，
// 行号对不上。文件开头那一批（任何正文之前）留在文件开头，全曲之后的追加在末尾。
//
// `%%` 指令不算注释（等价 `I:`，已经进了模型、写出端自己会写），照写会写重。

/** 引号外第一个 `%` 的下标（`"F#m"` 这类和弦里的不算）；没有注释返回 -1。 */
function commentStart(raw: string): number {
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') quoted = !quoted;
    else if (ch === "%" && !quoted) return i;
  }
  return -1;
}

/** 文件头的版本声明（`%123-1.0` / `%abc-2.1`）：写出端自己会写，不当注释收。 */
const VERSION_RE = /^%(123|abc)-/;

/** 平行于「全曲第几个和弦」：它在原文的第几行（拿不到原文位置的记 -1）。 */
function chordLines(doc: ScoreDoc): number[] {
  const out: number[] = [];
  for (const song of doc.songs) {
    for (const part of song.parts) {
      for (const mea of part.measures) {
        for (const el of mea.elements) {
          if (el.kind === "chord") out.push(el.source?.line ?? -1);
        }
      }
    }
  }
  return out;
}

interface Comment {
  text: string;
  /** 跟着第几个和弦走；null = 全曲之后 */
  at: number | null;
  /** 在任何正文之前（文件头那一批） */
  head: boolean;
}

/** 扫原文收注释，并把每条锚到「后面那条音乐行的第一个和弦」。 */
function collectComments(text: string, lineToChord: ReadonlyMap<number, number>): Comment[] {
  const out: Comment[] = [];
  let pending: Array<{ text: string; head: boolean }> = [];
  let seen = false; // 见过正文了没有
  text.split(/\r?\n/).forEach((raw, ln) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const cut = commentStart(raw);
    if (trimmed.startsWith("%")) {
      if (!trimmed.startsWith("%%") && !VERSION_RE.test(trimmed)) pending.push({ text: trimmed, head: !seen });
      return;
    }
    const at = lineToChord.get(ln);
    if (at !== undefined) {
      for (const p of pending) out.push({ text: p.text, at, head: p.head });
      pending = [];
      // 行尾注释：就近跟着本行（缝回去时成了这一行上方的独立注释行）
      if (cut > 0) out.push({ text: raw.slice(cut).trimEnd(), at, head: false });
    } else if (cut > 0) {
      pending.push({ text: raw.slice(cut).trimEnd(), head: !seen }); // 字段行/歌词行行尾的，跟着下一条音乐行
    }
    seen = true;
  });
  for (const p of pending) out.push({ text: p.text, at: null, head: p.head });
  return out;
}

/**
 * 把原文里的注释缝进重排后的文本（123 / ABC）。
 *
 * @param oldText 重排前的原文
 * @param oldDoc  它解析出来的那一份（`Chord.source` 要在——落点靠它认行）
 * @param newText 重排后重出的文本
 * @param newDoc  `parse(newText)`
 */
export function spliceComments(oldText: string, oldDoc: ScoreDoc, newText: string, newDoc: ScoreDoc): string {
  const oldLines = chordLines(oldDoc);
  const newLines = chordLines(newDoc);
  if (oldLines.length !== newLines.length) return newText; // 和弦都对不上就别动它
  const lineToChord = new Map<number, number>(); // 原文行 → 该行第一个和弦
  oldLines.forEach((line, k) => {
    if (line >= 0 && !lineToChord.has(line)) lineToChord.set(line, k);
  });
  const comments = collectComments(oldText, lineToChord);
  if (comments.length === 0) return newText;

  const head: string[] = [];
  const tail: string[] = [];
  const before = new Map<number, string[]>(); // 输出行 → 插在它前面的注释
  for (const c of comments) {
    const line = c.at === null ? -1 : (newLines[c.at] ?? -1);
    if (c.head) head.push(c.text);
    else if (line < 0) tail.push(c.text);
    else before.set(line, [...(before.get(line) ?? []), c.text]);
  }

  const raws = newText.split("\n");
  const out: string[] = [];
  // 文件头那一批留在文件头（版本声明仍在最前）
  let at = 0;
  if (head.length > 0) {
    if (VERSION_RE.test(raws[0]?.trim() ?? "")) out.push(raws[at++]!);
    out.push(...head);
  }
  for (let i = at; i < raws.length; i++) {
    out.push(...(before.get(i) ?? []));
    out.push(raws[i]!);
  }
  out.push(...tail);
  return out.join("\n");
}

// ───────────────────────── .jpwabc ─────────────────────────

/** `.Voice` 里的换行标记（`$` ParamList?，见 `jpword/lex.ts`）。 */
const BREAK_RE = /\$(\([^)]*\))?/g;
const BREAK_LINE = "$(true)";
const BREAK_PAGE = "$(true,0,0,true)";

/** 去掉一段 `.Voice` 原文里的换行标记，并把首尾空白收干净。 */
function stripBreaks(text: string): string {
  return text.replace(BREAK_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * 重排（按乐句 / 每行 n 小节）一份 `.jpwabc` 原文：**只重切 `.Voice` 的行**（挪 `$`），别的节原样。
 *
 * @param text 编辑器里的原文
 * @param sdoc 它解析出来的那一份（`jpwToScoreDoc`）
 * @returns 新原文；没有可重排的曲行时原样返回
 */
export function relayoutJpwabcText(text: string, sdoc: ScoreDoc, opt: { plan?: LinePlan } = {}): string {
  const cuts = phraseCuts(sdoc, 0, opt.plan ?? PHRASE);
  if (!cuts || cuts.length === 0) return text;
  const file = JpwFile.fromString(text);
  const voice = file?.getSection(VoiceSection) ?? null;
  if (!file || !voice || voice.lines.length === 0) return text;

  // 落点按原文位置排好：`.Voice` 里一个位置只会断一次
  const at = new Map<number, PhraseCut[]>(); // 行号 → 该行上的落点
  for (const cut of cuts) {
    if (!cut.source) continue;
    const list = at.get(cut.source.line) ?? [];
    list.push(cut);
    at.set(cut.source.line, list);
  }
  if (at.size === 0) return text;

  // 末行原来那个标记照旧（JP-Word 写的是 `$(true,0,0,true)`，别的来源可能只有 `$(true)`）
  const lastRaw = voice.lines[voice.lines.length - 1]!;
  const lastMark = [...lastRaw.matchAll(BREAK_RE)].pop()?.[0] ?? BREAK_PAGE;

  const out: string[] = [];
  let buf = "";
  const push = (piece: string): void => {
    const s = stripBreaks(piece);
    if (s.length === 0) return;
    buf = buf.length === 0 ? s : `${buf} ${s}`;
  };
  const flush = (mark: string): void => {
    if (buf.length === 0) return;
    out.push(buf + mark);
    buf = "";
  };
  voice.lines.forEach((raw, i) => {
    const here = (at.get(voice.lineNos[i]!) ?? []).slice().sort((a, b) => a.source!.column - b.source!.column);
    let from = 0;
    for (const cut of here) {
      const col = cut.source!.column;
      // 落点在行首（断点与原来的行结构重合）：此前攒下的就是上一行，直接收
      if (col < from) continue;
      push(raw.slice(from, col));
      flush(cut.page ? BREAK_PAGE : BREAK_LINE);
      from = col;
    }
    push(raw.slice(from));
  });
  flush(lastMark);
  if (out.length === 0) return text;

  // 写回原文：`.Voice` 那几行换成新的，其余行原样；按行号记的分页描述跟着作废
  const raws = text.split("\n");
  const crlf = text.includes("\r\n");
  const first = voice.lineNos[0]!;
  const drop = new Set(voice.lineNos);
  const layout = file.getSection(LayoutSection);
  if (layout && layout.breakPoints !== null) {
    layout.lineNos.forEach((no, i) => {
      if (/^\s*breakpoints\s*=/i.test(layout.lines[i]!)) drop.add(no);
    });
  }
  const merged: string[] = [];
  raws.forEach((raw, no) => {
    if (no === first) merged.push(...out.map((l) => (crlf ? `${l}\r` : l)));
    if (!drop.has(no)) merged.push(raw);
  });
  // `.Words` 的锚点 `@m,n` 只按小节线数小节（`fromjpw.ts::assignLyrics`），挪 `$` 不动它
  return merged.join("\n");
}
