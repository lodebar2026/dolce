// 可视化编辑的**模型那一路**：`.musicxml` 没有可以局部补丁的原文 token，动作改的是 `ScoreDoc`（`model/edit.ts`），
// 改完经唯一写出端整份重写，只把前后不同的那一段放进代码区（代码区隐藏着，里面就是 XML 原文），撤销重做仍是代码区那份 history。
//
// 与文本那一路（`ops.ts` + `EditDialect`）同一张动作表、同一份选区：选区在 XML 原文上（`SyncIndex.buildXml` 建的索引），
// 动作按选区碰到的条目认音符。改完元素 id 会重编（重写再读回），按「第几声部第几小节哪个声线第几个」认回来落选区。
// 导航、模式切换、全选、撤销这些与改法无关的动作不在这里（返回 null，控制器照旧处理）。

import type { EditorView } from "@codemirror/view";
import type { Chord, ElementId, ScoreDoc } from "../../model/doc";
import {
  addBeat, addChordNote, type BarKind, chordAtPos, chordOnset, deleteChords, deleteMeasures, insertChord, insertInVoice, insertMeasure,
  isEditError, type JumpKind, locate, mergeMeasures, midiOf, type ChordPos, type EditHooks, type InsertAnchor, type ModelEdit, posOf,
  removeChordNote, scaleDuration, setBarKind, setBreakBefore, setDegree, setKeyAt, setTempoAt, setTimeAt, shiftOctave, splitMeasure,
  pasteClip, type ClipItem, setDirectionText, toggleTuplet, setHarmony, setLyric, shiftSemitones, transposeScore, stepDegree, stepSemitone, setStep, degreeOfStep, anchorFifths, toggleAccidental, toggleDeco, toggleDot, toggleEnding, toggleJump, toggleSlur, toggleTie,
  type DecoKind, deleteDirection, removeNotation, insertPitch, staffOfVoice, staffVoice, newDurationOf, dirPartner, moveDirection, moveHarmony, moveMarkEnd, type MovedMark, rereadKeyAt, setClefAt, shiftLyrics, toggleGrace, toggleOctaveShift, toggleWedge,
} from "../../model/edit";
import { parseClefInput, parseKeyInput, parseTempoInput, parseTimeInput } from "./measureinput";
import { dropEmbeddedLayout, forgetNoteLayout } from "../../model/xmlsurface";
import type { SyncEntry, SyncIndex } from "../sync";
import type { NoteDuration } from "./dialect";
import type { VisualAction } from "./keys";
import { t as tr } from "../../i18n";
import { msg, msgText } from "../../model/msg";

/** 模型那一路向控制器要的东西。 */
export interface ModelActionCtx {
  readonly view: EditorView;
  readonly sync: SyncIndex;
  /** 按代码区当前原文**新读一份**模型（改的是它：它的原节点只为这次重写而活，改表层不碍着谱面那份） */
  freshModel(): ScoreDoc | null;
  /** 模型 → 原文（唯一写出端） */
  writeModel(doc: ScoreDoc): string;
  /** 索引用的那份模型（重排后按它认回选区） */
  syncDoc(): ScoreDoc | null;
  reloadNow(): void;
  setStatus(text: string): void;
  select(from: number, to: number): void;
  /** 按原文顺序、方向键能停的条目 */
  navigable(): SyncEntry[];
  /** 选区碰到的条目 */
  selectedEntries(): SyncEntry[];
  readonly curDur: NoteDuration;
  /** 声部输入：插入模式新插的音落在光标所在谱表的第几声线（1–4）；null = 没指定过，跟光标前那个音的声线 */
  readonly curVoice: number | null;
  /** Alt+点击单独选中的和弦里某个音（从低到高第几个）；没有为 null */
  readonly pickedChordNote: { id: ElementId; index: number } | null;
  /** 按键发声 */
  play(midi: number): void;
  /** 弹一个输入框问一句（调号、拍号、速度），放弃为 null */
  prompt(hint: string, initial: string): Promise<string | null>;
}

const HOOKS: EditHooks = { forgetStem: forgetNoteLayout, forgetLayout: dropEmbeddedLayout };

/** 记号动作 → `toggleDeco` 的记号名 */
const DECO_OF: Record<string, DecoKind> = {
  "deco.staccato": "staccato", "deco.tenuto": "tenuto", "deco.marcato": "strong-accent", "deco.staccatissimo": "staccatissimo",
  "deco.fermataInv": "fermata-inverted", "deco.trill": "trill-mark", "deco.mordent": "mordent", "deco.turn": "turn",
};

/** 两份原文前后相同的部分去掉，剩下中间不同的那一段。 */
function diffRegion(a: string, b: string): { from: number; to: number; insert: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { from: p, to: a.length - q, insert: b.slice(p, b.length - q) };
}

type Target =
  | { select: ChordPos[] } | { caretAfter: ChordPos } | { caretBefore: ChordPos }
  /** 挪过的记号 / 歌词字：按挂的和弦位置 + 种类认回那一条 */
  | { mark: { at: ChordPos; markKind: NonNullable<SyncEntry["markKind"]>; name?: string } }
  | { lyric: { at: ChordPos; verse: number } }
  | null;

/**
 * 改一次模型并落地。`fn` 在新读出的模型上就地改，返回要选中的（和弦对象）；这里先把它们换成位置，
 * 再写出、放进代码区、重排，最后在重排后的索引里按位置认回来落选区。`sound` 时响一下选中的第一个音。
 */
function commit(ctx: ModelActionCtx, fn: (doc: ScoreDoc) => ModelEdit & { moved?: MovedMark }, sound = false): boolean {
  const doc = ctx.freshModel();
  if (!doc) {
    ctx.setStatus(tr("ve.xmlUnreadable"));
    return true;
  }
  const out = fn(doc);
  if (isEditError(out)) {
    ctx.setStatus(msgText(out.error));
    return true;
  }
  const pos = (c: Chord): ChordPos | null => posOf(doc, c);
  const mv = out.moved;
  const mvAt = mv ? pos("lyricOf" in mv ? mv.lyricOf : mv.markOn) : null;
  const target: Target = mv && mvAt
    ? ("lyricOf" in mv ? { lyric: { at: mvAt, verse: mv.verse } }
      : mv.kind === "dir" ? { mark: { at: mvAt, markKind: DIR_KIND(mv.dirType), ...(DIR_KIND(mv.dirType) === "dir" ? { name: mv.dirType } : {}) } }
        : { mark: { at: mvAt, markKind: mv.kind } })
    : "select" in out
    ? { select: out.select.map(pos).filter((p): p is ChordPos => p !== null) }
    : "caretAfter" in out
      ? (pos(out.caretAfter) ? { caretAfter: pos(out.caretAfter)! } : null)
      : (pos(out.caretBefore) ? { caretBefore: pos(out.caretBefore)! } : null);
  const xml = ctx.writeModel(doc);
  const old = ctx.view.state.doc.toString();
  if (xml !== old) {
    ctx.view.dispatch({ changes: [diffRegion(old, xml)], userEvent: "input.visual", scrollIntoView: false });
    ctx.reloadNow();
  }
  reselect(ctx, target);
  if (sound) {
    const first = ctx.selectedEntries().find((e) => e.kind === "note") ??
      [...ctx.navigable()].reverse().find((e) => e.kind === "note" && e.to <= ctx.view.state.selection.main.head);
    const d = ctx.syncDoc();
    const midi = first && d ? midiOf(d, first.id) : null;
    if (midi !== null) ctx.play(midi);
  }
  ctx.setStatus("");
  return true;
}

/** `<direction>` 的类型 → 索引条目的 `markKind`（同 `sync.ts::buildXml`） */
const DIR_KIND = (type: string): NonNullable<SyncEntry["markKind"]> =>
  type === "dynamics" ? "dynamic" : type === "words" || type === "rehearsal" ? "annotation" : "dir";

function reselect(ctx: ModelActionCtx, t: Target): void {
  const doc = ctx.syncDoc();
  if (!doc || !t) return;
  if ("mark" in t || "lyric" in t) {
    const ch = chordAtPos(doc, "mark" in t ? t.mark.at : t.lyric.at);
    if (!ch) return;
    const e = ctx.sync.ordered().find((x) => "mark" in t
      ? x.kind === "mark" && x.id === ch.id && x.markKind === t.mark.markKind && (t.mark.name === undefined || x.name === t.mark.name)
      : x.kind === "lyric" && x.id === ch.id && x.verseNo === t.lyric.verse);
    if (e) ctx.select(e.from, e.to);
    return;
  }
  const spanOf = (p: ChordPos): { from: number; to: number } | null => {
    const ch = chordAtPos(doc, p);
    return ch ? ctx.sync.spanOfNote(ch.id) : null;
  };
  if ("select" in t) {
    const spans = t.select.map(spanOf).filter((s): s is { from: number; to: number } => s !== null);
    if (spans.length) ctx.select(Math.min(...spans.map((s) => s.from)), Math.max(...spans.map((s) => s.to)));
  } else if ("caretAfter" in t) {
    const s = spanOf(t.caretAfter);
    if (s) ctx.select(s.to, s.to);
  } else {
    const s = spanOf(t.caretBefore);
    if (s) ctx.select(s.from, s.from);
  }
}

/** 选区里的音符 id（编辑模式）。 */
function selectedNotes(ctx: ModelActionCtx): ElementId[] {
  return ctx.selectedEntries().filter((e) => e.kind === "note").map((e) => e.id);
}

/** 插入模式光标前面那个条目（没有为 null）。 */
function entryBeforeCaret(ctx: ModelActionCtx): SyncEntry | null {
  const head = ctx.view.state.selection.main.head;
  return [...ctx.navigable()].reverse().find((e) => e.to <= head) ?? null;
}

function entryAfterCaret(ctx: ModelActionCtx): SyncEntry | null {
  const head = ctx.view.state.selection.main.head;
  return ctx.navigable().find((e) => e.from >= head) ?? null;
}

/** 选区（或光标前那个元素）落在哪几小节：`from`..`to` 是小节下标。小节线条目算它前面那一小节。 */
function selectedMeasures(ctx: ModelActionCtx, doc: ScoreDoc): { si: number; from: number; to: number } | null {
  const sel = ctx.view.state.selection.main;
  const es = sel.empty ? [entryBeforeCaret(ctx) ?? entryAfterCaret(ctx)].filter((e): e is SyncEntry => !!e) : ctx.selectedEntries();
  const locs = es.map((e) => locate(doc, e.id)).filter((l): l is NonNullable<typeof l> => l !== null);
  if (!locs.length) return null;
  // 插入模式光标落在小节线后面：那是下一小节的开头
  const after = sel.empty && es[0] && (es[0].kind === "barline" || es[0].kind === "break") && es[0].to <= sel.head ? 1 : 0;
  const mis = locs.map((l) => l.mi + after);
  return { si: locs[0]!.si, from: Math.min(...mis), to: Math.max(...mis) };
}

/** 插入位置：光标前是音符就接在它后面；是小节线 / 换行就是下一小节开头；什么都没有就是第一小节开头。 */
function insertAnchor(ctx: ModelActionCtx, doc: ScoreDoc): InsertAnchor | null {
  const sel = ctx.view.state.selection.main;
  const prev = sel.empty ? entryBeforeCaret(ctx) : ctx.selectedEntries().pop() ?? null;
  if (prev?.kind === "note") return { after: prev.id };
  const next = entryAfterCaret(ctx);
  const nl = next?.kind === "note" ? locate(doc, next.id) : null;
  if (prev && (prev.kind === "barline" || prev.kind === "break")) {
    const l = locate(doc, prev.id);
    if (!l) return null;
    // 小节开头：插进后面那个音的声线（小节线条目借的是小节里最后那个元素的身份，它的声线不算数）；后面没有音取第一条谱表的第一声线
    const voice = nl && nl.si === l.si && nl.pi === l.pi && nl.mi === l.mi + 1 ? nl.chord.voice : staffVoice(l.part, 1, 1);
    return { measureStart: { si: l.si, pi: l.pi, mi: l.mi + 1, voice } };
  }
  const l = next ? locate(doc, next.id) : null;
  return l ? { measureStart: { si: l.si, pi: l.pi, mi: l.mi, voice: nl ? nl.chord.voice : staffVoice(l.part, 1, 1) } } : null;
}

/**
 * 插入模式插一个音（`degreeAt` 按插入位置给唱名：音名要看那里的调号）。没指定声线就接在光标前那个音的声线里；
 * 指定了（声部输入）按光标所在谱表的第几声线（`staffVoice`）认，与光标前那个音不是同一声线时插在光标所在时刻。
 * 以前声部输入缺省第 1 声线、按整个声部的 voice 号比：识别出的钢琴 / 合唱大谱表下谱表是 voice 5、6，
 * 光标在下谱表时新音一律要往 voice 1 的这一刻塞，上谱表这一刻有音就插不进（issue 23）。
 */
function insertNote(ctx: ModelActionCtx, degreeAt: (doc: ScoreDoc, at: InsertAnchor) => number): boolean {
  return commit(ctx, (doc) => {
    const at = insertAnchor(ctx, doc);
    if (!at) return { error: msg("ve.cantInsert") };
    const d = degreeAt(doc, at);
    const k = ctx.curVoice;
    if (k === null) return insertChord(doc, at, d, ctx.curDur, HOOKS);
    if ("after" in at) {
      const ref = locate(doc, at.after);
      const voice = ref ? staffVoice(ref.part, ref.chord.staff, k) : null;
      if (ref && voice !== null && ref.chord.voice !== voice) {
        const onset = (chordOnset(doc, ref.chord.id) ?? 0) + ref.chord.duration.divisions;
        return insertInVoice(doc, { si: ref.si, pi: ref.pi, mi: ref.mi, onset, staff: ref.chord.staff }, voice, d, ctx.curDur, HOOKS, k);
      }
      return insertChord(doc, at, d, ctx.curDur, HOOKS);
    }
    const m = at.measureStart;
    const part = doc.songs[m.si]?.parts[m.pi];
    if (!part) return { error: msg("ve.cantInsert") };
    const staff = staffOfVoice(part, m.voice);
    const voice = staffVoice(part, staff, k);
    if (voice !== m.voice) return insertInVoice(doc, { si: m.si, pi: m.pi, mi: m.mi, onset: 0, staff }, voice, d, ctx.curDur, HOOKS, k);
    return insertChord(doc, at, d, ctx.curDur, HOOKS);
  }, true);
}

/**
 * Alt+点原图补漏识的音（PhotoScore 的 Alt+点复制）：插在 `after` 那个音后面（左边没有音时插在 `before` 那一小节开头），
 * 音高由点的位置定（`pitch`），时值照选中的那个音（没选中按当前输入时值）。插完选中它，接着可以 ↑↓ 微调。
 */
export function insertAtSourceModel(ctx: ModelActionCtx, at: { after: ElementId | null; before: ElementId | null }, pitch: { step: "A" | "B" | "C" | "D" | "E" | "F" | "G"; octave: number }): boolean {
  const sel = selectedNotes(ctx)[0];
  return commit(ctx, (doc) => {
    const ref = sel !== undefined ? locate(doc, sel)?.chord : undefined;
    const dur = ref && !ref.grace ? newDurationOf(ref) : ctx.curDur;
    let anchor: InsertAnchor | null = null;
    if (at.after !== null) anchor = { after: at.after };
    else if (at.before !== null) {
      const l = locate(doc, at.before);
      if (l) anchor = { measureStart: { si: l.si, pi: l.pi, mi: l.mi, voice: l.chord.voice } };
    }
    return anchor ? insertPitch(doc, anchor, pitch, dur, HOOKS) : { error: msg("ve.cantInsert") };
  }, true);
}

/** 粘贴（`clipboard.ts`）：插入模式贴在光标处、光标落在贴进来的最后一个音后面；编辑模式贴在选区后面、选中贴进来的那段。 */
export function pasteModel(ctx: ModelActionCtx, items: readonly ClipItem[]): boolean {
  const insert = ctx.view.state.selection.main.empty;
  return commit(ctx, (doc) => {
    const at = insertAnchor(ctx, doc);
    const r = at ? pasteClip(doc, at, items, HOOKS) : { error: msg("ve.cantPaste") };
    return insert && "select" in r ? { caretAfter: r.select[r.select.length - 1]! } : r;
  });
}

/** 移调（`transpose.ts` 的对话框）：全曲换调（音、调号一起移），或选中的音移几个半音。 */
export function transposeModel(ctx: ModelActionCtx, whole: boolean, n: number): boolean {
  if (whole) return commit(ctx, (doc) => transposeScore(doc, n, HOOKS));
  const ids = selectedNotes(ctx);
  if (!ids.length) {
    ctx.setStatus(tr("ve.selectToMove"));
    return true;
  }
  return commit(ctx, (doc) => shiftSemitones(doc, ids, n, HOOKS), true);
}

/** 歌词录入：和弦 `id` 第 `verse` 段写成 `text`（`model/edit.ts::setLyric`），写完选中这个音。 */
export function lyricModel(ctx: ModelActionCtx, id: ElementId, verse: number, text: string, hyphen: boolean, extend: boolean): boolean {
  return commit(ctx, (doc) => setLyric(doc, id, verse, text, hyphen, extend));
}

/** 和弦名录入：和弦 `id` 的和弦名写成 `text`。 */
export function harmonyModel(ctx: ModelActionCtx, id: ElementId, text: string): boolean {
  return commit(ctx, (doc) => setHarmony(doc, id, text));
}

/** 文字 / 力度录入：和弦 `id` 前面那条写成 `text`。 */
export function directionModel(ctx: ModelActionCtx, id: ElementId, type: "words" | "dynamics", text: string): boolean {
  return commit(ctx, (doc) => setDirectionText(doc, id, type, text));
}

/** 某个条目对应的音符 id：音符就是它；小节线、换行是它前面那个音。 */
function anchorNote(ctx: ModelActionCtx): ElementId | null {
  const sel = ctx.view.state.selection.main;
  const e = sel.empty ? entryBeforeCaret(ctx) : ctx.selectedEntries().pop() ?? null;
  return e ? e.id : null;
}

/** 删文字：歌词连同整个 `<lyric>` 元素去掉（连它前面的缩进）；标题清空（原字相同的几处一起）。纯文字改动，局部补丁。 */
function removeText(ctx: ModelActionCtx, e: SyncEntry): boolean {
  const doc = ctx.view.state.doc;
  const text = doc.toString();
  let changes: { from: number; to: number; insert: string }[];
  if (e.kind === "lyric") {
    const open = text.lastIndexOf("<lyric", e.from);
    const close = text.indexOf("</lyric>", e.to);
    if (open < 0 || close < 0) return true;
    let from = open;
    while (from > 0 && /[ \t]/.test(text[from - 1]!)) from--;
    if (from > 0 && text[from - 1] === "\n") from--;
    changes = [{ from, to: close + "</lyric>".length, insert: "" }];
  } else {
    const raw = doc.sliceString(e.from, e.to);
    changes = ctx.sync.ordered().filter((x) => x.kind === "header" && doc.sliceString(x.from, x.to) === raw).map((x) => ({ from: x.from, to: x.to, insert: "" }));
  }
  ctx.view.dispatch({ changes, userEvent: "input.visual" });
  ctx.reloadNow();
  const at = changes[0]!.from;
  ctx.select(at, at);
  return true;
}

/** 删一条记号（选区恰好是它）：弧、延音线、`<direction>`（渐强渐弱连配对）、和弦名、音符上的奏法装饰。 */
function removeMark(ctx: ModelActionCtx, e: SyncEntry): boolean {
  if (e.markKind === "slur" && e.end !== undefined) return commit(ctx, (doc) => toggleSlur(doc, e.id, e.end!));
  if (e.markKind === "tied") return commit(ctx, (doc) => toggleTie(doc, e.id));
  if (e.dir) {
    const r = { si: 0, ...e.dir };
    return commit(ctx, (doc) => deleteDirection(doc, r));
  }
  if (e.markKind === "harmony") return commit(ctx, (doc) => setHarmony(doc, e.id, ""));
  // 按名字删（顿音、颤音之外的 caesura、stress… 也删得掉；不走 `toggleDeco`，那边不认的名字会当装饰加上去）
  if (e.markKind === "deco" && e.name) return commit(ctx, (doc) => removeNotation(doc, e.id, e.name!));
  ctx.setStatus(tr("ve.cantDeleteXml"));
  return true;
}

/** 选区恰好是的那一条记号 / 歌词字（单击、Tab 选中的） */
function exactEntry(ctx: ModelActionCtx): SyncEntry | null {
  const sel = ctx.view.state.selection.main;
  if (sel.empty) return null;
  return ctx.sync.range(sel.from, sel.to).find((e) => (e.kind === "mark" || e.kind === "lyric") && e.from === sel.from && e.to === sel.to) ?? null;
}

/**
 * 挪选中的记号 / 歌词字（识谱软件「拖到最近的音上吸附」的键盘版）：`delta` ±1；`byMeasure` 按小节；`endOnly` 只挪连线的终点。
 * 弧挪端点；`<direction>`（力度、文字、速度、渐强渐弱）挪到相邻的音，渐强渐弱整条挪时起止一起；和弦名挪到相邻的音；
 * 歌词字连同后面紧接的字整串挪一格（选了几个字就只挪这几个）。
 */
export function moveSelected(ctx: ModelActionCtx, delta: number, byMeasure: boolean, which: "both" | "start" | "end" = "both"): boolean {
  const endOnly = which !== "both";
  const e = exactEntry(ctx);
  const lyrics = ctx.view.state.selection.main.empty ? [] : ctx.sync.range(ctx.view.state.selection.main.from, ctx.view.state.selection.main.to).filter((x) => x.kind === "lyric");
  const ly = e?.kind === "lyric" ? e : lyrics[0];
  if (ly && ly.verseNo !== undefined) {
    if (byMeasure || endOnly) return status(ctx, tr("ve.moveLyricOneNote"));
    const count = lyrics.filter((x) => x.verseNo === ly.verseNo).length || 1;
    return commit(ctx, (doc) => shiftLyrics(doc, ly.id, ly.verseNo!, delta, count > 1 ? count : undefined));
  }
  if (!e || e.kind !== "mark") return status(ctx, tr("ve.selectToMoveMark"));
  if (e.markKind === "slur" && e.end !== undefined) {
    if (byMeasure) return status(ctx, tr("ve.moveLineByNote"));
    return commit(ctx, (doc) => moveMarkEnd(doc, "slur", e.id, e.end!, which, delta));
  }
  if (e.markKind === "tied") return status(ctx, tr("me.tieNoMove"));
  if (e.dir) {
    const r = { si: 0, ...e.dir };
    return commit(ctx, (doc) => {
      const pair = dirPartner(doc, r);
      if (endOnly) {
        if (!pair) return { error: msg("ve.moveEndOnlyLine") };
        // 只挪一端：选中的是哪一端无所谓，按 `which` 取起点或终点那条
        const d = doc.songs[0]?.parts[r.pi]?.measures[r.mi]?.directions?.[r.index];
        const isStop = d?.spanType === "stop";
        // 挪的那一端不能越过另一端
        const [mine, other] = (which === "end") === isStop ? [r, pair] : [pair, r];
        return moveDirection(doc, mine, delta, byMeasure, undefined, other);
      }
      return moveDirection(doc, r, delta, byMeasure, pair ?? undefined);
    });
  }
  if (e.markKind === "harmony") {
    if (byMeasure || endOnly) return status(ctx, tr("ve.moveLyricOneNote"));
    return commit(ctx, (doc) => moveHarmony(doc, e.id, delta));
  }
  return status(ctx, tr("ve.selectToMoveMark"));
}

function status(ctx: ModelActionCtx, text: string): true {
  ctx.setStatus(text);
  return true;
}

/** 删掉一个条目（或一段）：音符删音、小节线并小节、换行去掉、弧去掉。 */
function removeEntries(ctx: ModelActionCtx, targets: SyncEntry[]): boolean {
  if (targets.length === 0) return true;
  const bar = targets.find((e) => e.kind === "barline");
  const brk = targets.find((e) => e.kind === "break");
  const slur = targets.find((e) => e.kind === "mark" && e.markKind === "slur");
  const notes = targets.filter((e) => e.kind === "note").map((e) => e.id);
  if (notes.length) return commit(ctx, (doc) => deleteChords(doc, notes, HOOKS));
  if (bar) {
    return commit(ctx, (doc) => {
      const l = locate(doc, bar.id);
      return l ? mergeMeasures(doc, l.si, l.mi, HOOKS) : { error: msg("ve.noBarline") };
    });
  }
  if (brk) {
    return commit(ctx, (doc) => {
      const l = locate(doc, brk.id);
      return l ? setBreakBefore(doc, l.si, l.mi + 1, null) : { error: msg("ve.noBreak") };
    });
  }
  if (slur && slur.end !== undefined) return commit(ctx, (doc) => toggleSlur(doc, slur.id, slur.end!));
  ctx.setStatus(tr("ve.cantDeleteXml"));
  return true;
}

/**
 * 模型那一路处理这个动作；不归它管的（导航、模式、全选、撤销、格式标记、插入模式改「当前时值」）返回 null，控制器照旧处理。
 */
export function runModelAction(ctx: ModelActionCtx, a: VisualAction, key: string): boolean | null {
  const sel = ctx.view.state.selection.main;
  const edit = !sel.empty;
  const ids = (): ElementId[] => selectedNotes(ctx);
  const need = (fn: (doc: ScoreDoc, ids: ElementId[]) => ModelEdit, sound = false): boolean => {
    const list = ids();
    if (list.length === 0) {
      ctx.setStatus(tr("ve.selectNote"));
      return true;
    }
    return commit(ctx, (doc) => fn(doc, list), sound);
  };
  // 改音高的几样（音级、半音、八度）：插入模式作用于光标前刚插的那个音，光标留在它后面（同 MuseScore 输入态）
  const pitch = (fn: (doc: ScoreDoc, ids: ElementId[]) => ModelEdit): boolean => {
    if (edit) return need(fn, true);
    const prev = entryBeforeCaret(ctx);
    if (prev?.kind !== "note") {
      ctx.setStatus(tr("ve.selectNote"));
      return true;
    }
    return commit(ctx, (doc) => {
      const r = fn(doc, [prev.id]);
      return "select" in r && r.select[0] ? { caretAfter: r.select[0] } : r;
    }, true);
  };
  switch (a.id) {
    case "note.digit": {
      const d = Number(key);
      if (edit) return need((doc, l) => setDegree(doc, l, d, HOOKS), true);
      return insertNote(ctx, () => d);
    }
    case "note.letter": {
      if (edit) return need((doc, l) => setStep(doc, l, key, HOOKS), true);
      return insertNote(ctx, (doc, at) => degreeOfStep(key, anchorFifths(doc, at)));
    }
    case "chord.add": {
      const d = Number(key);
      const id = ids().pop();
      if (id === undefined) {
        ctx.setStatus(tr("ve.selectNote"));
        return true;
      }
      return commit(ctx, (doc) => addChordNote(doc, id, d, HOOKS), true);
    }
    case "voice.set": return null; // 控制器记下当前声部
    case "meas.append":
      return commit(ctx, (doc) => insertMeasure(doc, 0, doc.songs[0]?.parts[0]?.measures.length ?? 0, HOOKS));
    case "meas.insert":
      return commit(ctx, (doc) => {
        const r = selectedMeasures(ctx, doc);
        return insertMeasure(doc, r?.si ?? 0, r?.from ?? 0, HOOKS);
      });
    case "meas.delete":
      return commit(ctx, (doc) => {
        const r = selectedMeasures(ctx, doc);
        return r ? deleteMeasures(doc, r.si, r.from, r.to, HOOKS) : { error: msg("ve.selectMeasToDelete") };
      });
    case "meas.key":
    case "meas.time":
    case "meas.tempo": {
      const hint = a.id === "meas.key" ? tr("ve.hint.key") : a.id === "meas.time" ? tr("ve.hint.time") : tr("ve.hint.tempo");
      void ctx.prompt(hint, "").then((v) => {
        if (v === null) return;
        commit(ctx, (doc) => {
          const r = selectedMeasures(ctx, doc);
          if (!r) return { error: msg("ve.selectInMeasure") };
          if (a.id === "meas.key") {
            const f = parseKeyInput(v);
            return f === null ? { error: msg("ve.badKey", { v }) } : setKeyAt(doc, r.si, r.from, f, HOOKS);
          }
          if (a.id === "meas.time") {
            const t = parseTimeInput(v);
            return t ? setTimeAt(doc, r.si, r.from, t.beats, t.beatType, HOOKS) : { error: msg("ve.badTime", { v }) };
          }
          const bpm = parseTempoInput(v);
          return bpm === null ? { error: msg("ve.badTempo", { v }) } : setTempoAt(doc, r.si, r.from, bpm);
        });
      });
      return true;
    }
    case "bar.single":
    case "bar.double":
    case "bar.final":
    case "bar.repeatStart":
    case "bar.repeatEnd": {
      const kind = a.id.slice(4) as BarKind;
      return commit(ctx, (doc) => {
        const r = selectedMeasures(ctx, doc);
        if (!r) return { error: msg("ve.selectMeasOrBar") };
        return setBarKind(doc, r.si, kind === "repeatStart" ? r.from : r.to, kind);
      });
    }
    case "volta.1":
    case "volta.2":
      return commit(ctx, (doc) => {
        const r = selectedMeasures(ctx, doc);
        return r ? toggleEnding(doc, r.si, r.from, r.to, a.id === "volta.1" ? 1 : 2) : { error: msg("ve.selectVolta") };
      });
    case "jump.segno":
    case "jump.coda":
    case "jump.dc":
    case "jump.ds":
    case "jump.fine":
      return commit(ctx, (doc) => {
        const r = selectedMeasures(ctx, doc);
        const kind = a.id.slice(5) as JumpKind;
        if (!r) return { error: msg("ve.selectInMeasure") };
        return toggleJump(doc, r.si, kind === "segno" || kind === "coda" ? r.from : r.to, kind);
      });
    case "oct.up": return pitch((doc, l) => shiftOctave(doc, l, 1, HOOKS));
    case "oct.down": return pitch((doc, l) => shiftOctave(doc, l, -1, HOOKS));
    case "step.up": return pitch((doc, l) => stepDegree(doc, l, 1, HOOKS));
    case "step.down": return pitch((doc, l) => stepDegree(doc, l, -1, HOOKS));
    case "semi.up": return pitch((doc, l) => stepSemitone(doc, l, 1, HOOKS));
    case "semi.down": return pitch((doc, l) => stepSemitone(doc, l, -1, HOOKS));
    case "acc.sharp": return need((doc, l) => toggleAccidental(doc, l, "sharp", HOOKS), true);
    case "acc.flat": return need((doc, l) => toggleAccidental(doc, l, "flat", HOOKS), true);
    case "acc.natural": return need((doc, l) => toggleAccidental(doc, l, "natural", HOOKS), true);
    case "dur.dot": return need((doc, l) => toggleDot(doc, l, HOOKS));
    case "dur.halve": return edit ? need((doc, l) => scaleDuration(doc, l, 0.5, HOOKS)) : null;
    case "dur.double": return edit ? need((doc, l) => scaleDuration(doc, l, 2, HOOKS)) : null;
    case "sus.add": {
      // 模型里没有独立的增时线：给选中的（插入模式：光标前那个）音多一拍
      const id = edit ? ids().pop() : (() => {
        const p = entryBeforeCaret(ctx);
        return p?.kind === "note" ? p.id : undefined;
      })();
      if (id === undefined) {
        ctx.setStatus(tr("ve.selectNote"));
        return true;
      }
      return commit(ctx, (doc) => addBeat(doc, id, HOOKS));
    }
    case "slur.toggle": {
      const l = ids();
      if (l.length < 2) {
        ctx.setStatus(tr("ve.slurTwo"));
        return true;
      }
      return commit(ctx, (doc) => toggleSlur(doc, l[0]!, l[l.length - 1]!));
    }
    case "tuplet.toggle": return need((doc, l) => toggleTuplet(doc, l, HOOKS));
    case "move.prev": return moveSelected(ctx, -1, false);
    case "move.next": return moveSelected(ctx, 1, false);
    case "move.measPrev": return moveSelected(ctx, -1, true);
    case "move.measNext": return moveSelected(ctx, 1, true);
    case "span.endPrev": return moveSelected(ctx, -1, false, "end");
    case "span.endNext": return moveSelected(ctx, 1, false, "end");
    case "deco.staccato": case "deco.tenuto": case "deco.marcato": case "deco.staccatissimo": case "deco.fermataInv":
    case "deco.trill": case "deco.mordent": case "deco.turn":
      return need((doc, l) => toggleDeco(doc, l, DECO_OF[a.id]!));
    case "wedge.cresc":
    case "wedge.dim": {
      const l = ids();
      if (l.length < 2) return status(ctx, tr("ve.wedgeTwo"));
      return commit(ctx, (doc) => toggleWedge(doc, l[0]!, l[l.length - 1]!, a.id === "wedge.cresc" ? "crescendo" : "diminuendo"));
    }
    case "ottava.up":
    case "ottava.down": {
      const l = ids();
      if (l.length < 2) return status(ctx, tr("ve.ottavaTwo"));
      return commit(ctx, (doc) => toggleOctaveShift(doc, l[0]!, l[l.length - 1]!, a.id === "ottava.up" ? "8va" : "8vb"));
    }
    case "grace.toggle": return need((doc, l) => toggleGrace(doc, l, HOOKS));
    case "meas.keyReread":
      void ctx.prompt(tr("ve.hint.keyReread"), "").then((v) => {
        if (v === null) return;
        commit(ctx, (doc) => {
          const r = selectedMeasures(ctx, doc);
          if (!r) return { error: msg("ve.selectInMeasure") };
          const f = parseKeyInput(v);
          return f === null ? { error: msg("ve.badKey", { v }) } : rereadKeyAt(doc, r.si, r.from, f, HOOKS);
        });
      });
      return true;
    case "meas.clef":
    case "meas.clefReread": {
      const reread = a.id === "meas.clefReread";
      void ctx.prompt(tr(reread ? "ve.hint.clefReread" : "ve.hint.clef"), "").then((v) => {
        if (v === null) return;
        commit(ctx, (doc) => {
          const clef = parseClefInput(v);
          if (!clef) return { error: msg("ve.badClef", { v }) };
          // 哪一谱表：选中（插入模式：光标前）的那个音所在的
          const id = anchorNote(ctx);
          const l = id !== null ? locate(doc, id) : null;
          if (!l) return { error: msg("ve.selectInMeasure") };
          const sel = ctx.view.state.selection.main;
          const before = sel.empty ? entryBeforeCaret(ctx) : null;
          const mi = before && (before.kind === "barline" || before.kind === "break") ? l.mi + 1 : l.mi;
          return setClefAt(doc, l.si, l.pi, mi, l.chord.staff, clef, reread, HOOKS);
        });
      });
      return true;
    }
    case "tie.toggle": return need((doc, l) => toggleTie(doc, l[0]!));
    case "deco.fermata": return need((doc, l) => toggleDeco(doc, l, "fermata"));
    case "deco.accent": return need((doc, l) => toggleDeco(doc, l, "accent"));
    case "bar.insert": {
      const id = anchorNote(ctx);
      if (id === null) return true;
      return commit(ctx, (doc) => splitMeasure(doc, id, HOOKS));
    }
    case "brk.line":
    case "brk.page": {
      const id = anchorNote(ctx);
      if (id === null) return true;
      const page = a.id === "brk.page";
      return commit(ctx, (doc) => {
        const l = locate(doc, id);
        if (!l) return { error: msg("ve.noBreakPos") };
        const last = [...l.measure.elements].reverse().find((e) => e.kind === "chord" && e.voice === l.chord.voice);
        if (last !== l.chord) return { error: msg("ve.breakAtBar") };
        return setBreakBefore(doc, l.si, l.mi + 1, page ? "page" : "system");
      });
    }
    case "del.forward":
    case "del.back": {
      // Alt+点击单独选中的和弦音：只删它
      const pn = ctx.pickedChordNote;
      if (edit && pn) return commit(ctx, (doc) => removeChordNote(doc, pn.id, pn.index, HOOKS));
      // 选中的是一段文字（歌词、标题）：直接改原文里那几个字
      const text = edit ? ctx.sync.range(sel.from, sel.to).find((e) => (e.kind === "lyric" || e.kind === "header") && e.from === sel.from && e.to === sel.to) : undefined;
      if (text) return removeText(ctx, text);
      // 选中的是一条记号（Tab 轮到的、点中的）：只删它——记号的区间在 `<note>` 里面，按选区碰到的条目算会把音符一起删掉
      const mark = edit ? ctx.sync.range(sel.from, sel.to).find((e) => e.kind === "mark" && e.from === sel.from && e.to === sel.to) : undefined;
      if (mark) return removeMark(ctx, mark);
      if (edit) return removeEntries(ctx, ctx.selectedEntries());
      const t = a.id === "del.forward" ? entryAfterCaret(ctx) : entryBeforeCaret(ctx);
      return removeEntries(ctx, t ? [t] : []);
    }
  }
  return null;
}
