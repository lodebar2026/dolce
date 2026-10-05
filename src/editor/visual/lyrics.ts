// **歌词录入**的文本那一路：把某个音第 `verse` 段的字写成 `text`。
//
// 123 / ABC（`EditDialect.measure` 有写法表的那一族）按对位格写 `w:` 行：这个音在它那一行曲里是第 k 个对位格
// （`breaks.ts::slotsBetween`，与解析器同一份口径），`w:` 行里第 k 格（`parseLyricLine` 的 `starts`）换成新字，
// 不够 k 格先用跳格符补齐，这一段还没有 `w:` 行就新起一行。连字符写成 `字-`，续记号（一字多音）在下一格写 `_`。
// 文本谱、`.jpwabc` 的词行写法各不相同，只改已经有字的格（索引里的歌词条目），没字的格请在源码里补。

import type { EditorState } from "@codemirror/state";
import { parseLyricLine } from "../../j123/parse";
import { ZERO_SPAN } from "../../model/helpers";
import type { SyncEntry } from "../sync";
import { blockStart, lastMusicLine, lyricBody, lyricLinesAfter, slotsBetween } from "./breaks";
import type { EditCtx, EditOutcome } from "./ops";
import { t as tr } from "../../i18n";

const CJK = /[㐀-鿿豈-﫿]/;

/** 词行 body 里第 `k` 格的区间（字本身，不含后面的分隔）与它后面的分隔（空格、连字符）。 */
function slotSpan(body: string, starts: readonly number[], k: number): { from: number; to: number; sep: string } {
  const from = starts[k]!;
  const end = k + 1 < starts.length ? starts[k + 1]! : body.length;
  const seg = body.slice(from, end);
  const sep = /[\s-]*$/.exec(seg)![0];
  return { from, to: end - sep.length, sep };
}

/** 新字与后面那格之间写什么：要连字符写 `-`；原来是连字符而现在不要就换成空格；两边都是汉字可以不隔；否则至少一个空格。 */
function sepAfter(oldSep: string, text: string, next: string | null, hyphen: boolean): string {
  if (hyphen) return "-";
  if (next === null) return oldSep.includes("-") ? "" : oldSep;
  if (oldSep.includes("-")) return " ";
  if (oldSep === "" && !(CJK.test(text.slice(-1)) && CJK.test(next.charAt(0)))) return " ";
  return oldSep;
}

/** 词行 body 里各格的起点（与解析器同一份口径）。 */
const parseStarts = (body: string, skip: "/" | "*"): number[] => parseLyricLine(body, 1, ZERO_SPAN, undefined, skip).starts;

/**
 * 把音 `note` 第 `verse` 段（1 起）的字写成 `text`（空串 = 这格改成跳格）。`hyphen` 后面接连字符；
 * `extend` 时下一格写续记号 `_`（一字多音：下一个音不另配字）。
 */
export function setLyricText(ctx: EditCtx, note: SyncEntry, verse: number, text: string, hyphen: boolean, extend: boolean): EditOutcome {
  if (!ctx.dialect.measure) return setExisting(ctx, note, verse, text);
  const { state } = ctx;
  const skip: "/" | "*" = ctx.doc?.sourceFormat === "abc" || ctx.doc?.sourceFormat === "jcx" ? "*" : "/";
  const byLine = !!ctx.dialect.lyricBlockByCodeLine;
  const breaks = ctx.sync.ordered().filter((e) => e.kind === "break");
  const start = blockStart(state, note.from, breaks, byLine);
  const k = slotsBetween(ctx.doc, start, note.from);
  const last = lastMusicLine(state, state.doc.lineAt(note.from).number, breaks, byLine);
  const lines = lyricLinesAfter(state, last.number);
  if (typeof lines === "string") return { error: lines };
  const want = text === "" ? skip : text;
  const line = lines[verse - 1];
  if (!line) {
    if (verse - 1 > lines.length) return { error: tr("ve.fillVerseFirst", { n: lines.length + 1 }) };
    // 这一段还没有词行：新起一行，前面 k 格补跳格符
    const after = lines.length ? lines[lines.length - 1]! : last;
    const body = [...Array<string>(k).fill(skip), want + (hyphen ? "-" : ""), ...(extend ? ["_"] : [])].join(" ");
    const insert = `\nw: ${body}`;
    return { changes: [{ from: after.to, to: after.to, insert }], anchor: state.selection.main.anchor, head: state.selection.main.head };
  }
  const { body, bodyFrom } = lyricBody(line);
  const starts = parseStarts(body, skip);
  const changes: { from: number; to: number; insert: string }[] = [];
  if (k >= starts.length) {
    // 词不够长：补跳格符到第 k 格再写
    const tail = body.replace(/\s+$/, "");
    const pad = [...Array<string>(k - starts.length).fill(skip), want + (hyphen ? "-" : ""), ...(extend ? ["_"] : [])].join(" ");
    const lead = tail === "" || /-$/.test(tail) ? "" : " ";
    changes.push({ from: bodyFrom + tail.length, to: line.to, insert: lead + pad });
  } else {
    const cur = slotSpan(body, starts, k);
    const nextFrom = k + 1 < starts.length ? starts[k + 1]! : null;
    const next = nextFrom === null ? null : body.slice(nextFrom);
    changes.push({ from: bodyFrom + cur.from, to: bodyFrom + cur.to + cur.sep.length, insert: want + sepAfter(cur.sep, want, next, hyphen) });
    if (extend) {
      if (k + 1 < starts.length) {
        const nx = slotSpan(body, starts, k + 1);
        changes.push({ from: bodyFrom + nx.from, to: bodyFrom + nx.to, insert: "_" });
      } else changes.push({ from: line.to, to: line.to, insert: hyphen ? "_" : " _" });
    }
  }
  return { changes, anchor: state.selection.main.anchor, head: state.selection.main.head };
}

/** 文本谱、`.jpwabc`：只改已经有字的那一格（索引里的歌词条目）。 */
function setExisting(ctx: EditCtx, note: SyncEntry, verse: number, text: string): EditOutcome {
  const e = lyricEntry(ctx.sync.ordered(), note, verse);
  if (!e) return { error: tr("ve.lyricNoSlot") };
  return { changes: [{ from: e.from, to: e.to, insert: text }], anchor: ctx.state.selection.main.anchor, head: ctx.state.selection.main.head };
}

/** 音 `note` 第 `verse` 段那个字的索引条目。 */
export function lyricEntry(entries: readonly SyncEntry[], note: SyncEntry, verse: number): SyncEntry | null {
  return entries.find((e) => e.kind === "lyric" && e.id === note.id && (e.verseNo ?? (e.verse ?? 0) + 1) === verse) ?? null;
}

/** 这个音这一段现在的字（框里预填），没有为空串。 */
export function lyricTextOf(state: EditorState, entries: readonly SyncEntry[], note: SyncEntry, verse: number): string {
  const e = lyricEntry(entries, note, verse);
  return e ? state.doc.sliceString(e.from, e.to) : "";
}
