// **挪动**的文本那一路（识谱软件「拖到最近的音上吸附」的键盘版，模型那一路见 `modelops.ts::moveSelected`）：
//
// - 歌词字挪格：123 / ABC 的 `w:` 行里插 / 删跳格符（对位格口径同歌词录入，`lyrics.ts`）。往后挪 = 在这个字前插一个跳格、
//   后面第一个跳格吸收掉（同一行曲里没有跳格时词行多出一格）；往前挪 = 前一格是跳格时删掉它、在这串字后面补一个，后面的字不动。
// - 力度、注记、和弦名（`AttachedSource`，写在音符前面的 `!mf!`、`"^…"`、`"C"`）：整段原文搬到相邻那个音前面。
// - 圆滑线的 `(` / `)`：搬到相邻那个音的前面 / 后面。
//
// 邻居按模型找（同一声部同一声线，`model/edit.ts::neighbourChord`），再按索引取它在原文里的位置。
// 文本谱、`.jpwabc` 的词行与记号写法各不相同，这几样拒绝并说明（同歌词录入只改已有字的口径）。

import { parseLyricLine } from "../../abcfamily/parse";
import { ZERO_SPAN } from "../../model/helpers";
import { neighbourChord } from "../../model/edit";
import type { SyncEntry } from "../sync";
import { blockStart, lastMusicLine, lyricBody, lyricLinesAfter, slotsBetween } from "./breaks";
import { type EditCtx, type EditOutcome, mapper } from "./ops";
import { t as tr } from "../../i18n";

/**
 * 歌词条目 `ly` 那个字连同后面紧接的字挪一格（`count` 给了只挪这几个：往后挪仍推开挡在前面的字，往回挪只收这几个）。
 * 可视化编辑总按选中的字数给 `count`，选一个字往回挪就只收它自己。
 */
export function shiftLyricText(ctx: EditCtx, ly: SyncEntry, delta: number, count?: number): EditOutcome {
  if (!ctx.dialect.measure) return { error: tr("ve.moveTextFormat") };
  const { state } = ctx;
  const skip: "/" | "*" = ctx.doc?.sourceFormat === "abc" || ctx.doc?.sourceFormat === "jcx" ? "*" : "/";
  const note = ctx.sync.ordered().find((e) => e.kind === "note" && e.id === ly.id);
  if (!note) return { error: tr("me.noNote") };
  const byLine = !!ctx.dialect.lyricBlockByCodeLine;
  const breaks = ctx.sync.ordered().filter((e) => e.kind === "break");
  const start = blockStart(state, note.from, breaks, byLine);
  const last = lastMusicLine(state, state.doc.lineAt(note.from).number, breaks, byLine);
  const lines = lyricLinesAfter(state, last.number);
  if (typeof lines === "string") return { error: lines };
  // 这个字在哪一条 `w:` 行：按字的原文位置认（段号与行序不一定一样）
  const line = lines.find((l) => ly.from >= l.from && ly.from <= l.to);
  if (!line) return { error: tr("me.noLyric") };
  const { body, bodyFrom } = lyricBody(line);
  const starts = parseLyricLine(body, 1, ZERO_SPAN, undefined, skip, undefined, ctx.doc?.sourceFormat === "jcx").starts;
  // 各格的原文（连同后面的分隔）；格前的段号留在 `lead`
  const lead = body.slice(0, starts[0] ?? body.length);
  const toks = starts.map((s, i) => body.slice(s, i + 1 < starts.length ? starts[i + 1]! : body.length));
  const empty = (i: number): boolean => toks[i]?.trim().replace(/[\s-]+$/, "") === skip;
  const k0 = starts.findIndex((s, i) => bodyFrom + s <= ly.from && (i + 1 >= starts.length || bodyFrom + starts[i + 1]! > ly.from));
  if (k0 < 0) return { error: tr("me.noLyric") };
  const slot = (): string => `${skip} `;
  // 删掉一个跳格：它若紧贴着前一格（`morn/ing`，写出端在跳格两边不加空格），前一格补个空格，免得两个字粘成一个
  const dropSlot = (i: number): void => {
    toks.splice(i, 1);
    if (i > 0 && i < toks.length && !/[\s-]$/.test(toks[i - 1]!)) toks[i - 1] += " ";
  };
  const total = slotsBetween(ctx.doc, start, last.to + 1);
  // 挪几格 = 一格一格挪（与按几下 Alt+→ 一样）
  let k = k0;
  for (let n = Math.abs(delta); n > 0; n--) {
    let j = k;
    const lim = count && count > 0 ? k + count - 1 : Infinity;
    while (j + 1 < toks.length && !empty(j + 1) && (j < lim || delta > 0)) j++;
    if (delta > 0) {
      const gap = toks.findIndex((_, i) => i > j && empty(i));
      if (gap >= 0) dropSlot(gap);
      // 这一行曲里没有空格可吸收：词行多出一格，最后那个字要还有音可配
      else if (toks.length + 1 > total) return { error: tr("me.lyricNoRoom") };
      toks.splice(k, 0, slot());
      k++;
    } else {
      if (k === 0 || !empty(k - 1)) return { error: tr("me.lyricNoRoom") };
      dropSlot(k - 1);
      // 后面的字不动：这串字后面补回一格（行尾就不用补）
      if (j < toks.length) toks.splice(j, 0, slot());
      k--;
    }
  }
  // 最后一格后面不留多余的空白
  const joined = lead + toks.join("").replace(/\s+$/, "");
  const changes = [{ from: bodyFrom, to: line.to, insert: joined }];
  // 选中挪过去的那个字
  const ns = parseLyricLine(joined.slice(lead.length), 1, ZERO_SPAN, undefined, skip, undefined, ctx.doc?.sourceFormat === "jcx").starts;
  const from = bodyFrom + lead.length + (ns[k] ?? 0);
  const text = state.doc.sliceString(ly.from, ly.to);
  return { changes, anchor: from, head: from + text.length };
}

/** 挂在音符前面的记号（力度、注记、和弦名）整段搬到相邻那个音前面。 */
export function moveAttachedText(ctx: EditCtx, mark: SyncEntry, delta: number): EditOutcome {
  if (!ctx.doc || ctx.dialect.deco?.place === "inToken") return { error: tr("ve.moveTextFormat") };
  const to = neighbourChord(ctx.doc, mark.id, delta);
  const span = to ? ctx.sync.spanOfNote(to.id) : null;
  if (!to || !span) return { error: tr("me.noNeighbour") };
  const raw = ctx.state.doc.sliceString(mark.from, mark.to);
  // 连着后面一个空格一起搬（`!mf! 5` 搬走后不留双空格）
  const after = ctx.state.doc.sliceString(mark.to, mark.to + 1) === " " ? 1 : 0;
  const changes = [
    { from: mark.from, to: mark.to + after, insert: "" },
    { from: span.from, to: span.from, insert: raw + (after ? " " : "") },
  ].sort((a, b) => a.from - b.from);
  const map = mapper(ctx.state, changes);
  const at = map(span.from, -1);
  return { changes, anchor: at, head: at + raw.length };
}

/** 圆滑线的一端（`which`）或整条挪几个音：`(` 搬到那个音前面、`)` 搬到它后面。 */
export function moveSlurText(ctx: EditCtx, slur: SyncEntry, which: "start" | "end" | "both", delta: number): EditOutcome {
  if (!ctx.doc || slur.end === undefined || !slur.pair) return { error: tr("ve.moveTextFormat") };
  const open = slur.from < slur.pair.from ? { from: slur.from, to: slur.to } : slur.pair;
  const close = slur.from < slur.pair.from ? slur.pair : { from: slur.from, to: slur.to };
  const changes: { from: number; to: number; insert: string }[] = [];
  let startSpan = ctx.sync.spanOfNote(slur.id);
  let endSpan = ctx.sync.spanOfNote(slur.end);
  if (which !== "end") {
    const st = neighbourChord(ctx.doc, slur.id, delta, true);
    startSpan = st ? ctx.sync.spanOfNote(st.id) : null;
    if (!startSpan) return { error: tr("me.noNeighbour") };
    changes.push({ from: open.from, to: open.to, insert: "" }, { from: startSpan.from, to: startSpan.from, insert: ctx.state.doc.sliceString(open.from, open.to) });
  }
  if (which !== "start") {
    const en = neighbourChord(ctx.doc, slur.end, delta, true);
    endSpan = en ? ctx.sync.spanOfNote(en.id) : null;
    if (!endSpan) return { error: tr("me.noNeighbour") };
    changes.push({ from: close.from, to: close.to, insert: "" }, { from: endSpan.to, to: endSpan.to, insert: ctx.state.doc.sliceString(close.from, close.to) });
  }
  if (!startSpan || !endSpan || endSpan.from <= startSpan.from) return { error: tr("me.markCollapse") };
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  const map = mapper(ctx.state, changes);
  const at = map(which !== "end" ? startSpan.from : open.from, -1);
  return { changes, anchor: at, head: at + (open.to - open.from) };
}
