// `ScoreDoc` → 简谱排版引擎的输入（`layout/input.ts`）。**只此一份投影**，按形状分支：
//
//   `jianpuInputOfDoc(doc, opts)`   简谱形状：文本谱 / 123 / ABC / `.musicxml` 的简谱档（经排版行视图 `jianpu/slots.ts::docView`）
//   `jianpuInputOfJpw(doc)`         `.jpwabc`（按原文小节，行内 `$` 换行照原位）
//
// 判据是**谱面**：三个分支各照原先那条路的口径（从 mp/score 移植、多年验过的口径），
// 分歧都写成分支里明写的一条，不悄悄统一——统一观感只动绘制层，不在输入这一层抹平。
// 每个和弦带元素 id：点选、试听高亮、断句量宽都按它认。

import { Fraction } from "../common/fraction";
import { BARLINE_MARKS, DYNAMICS } from "../engrave/jpglyph";
import { TERMS } from "../model/marknames";
import { BarStyle, StartStopDiscontinue } from "../score/enums";
import { MusicCommon } from "../score/jppitch";
import { fifthsOfSpelling } from "../model/keyshift";
import { PlayData } from "../score/playorder";
import type {
  JBreak, JChord, JCredit, JKey, JLyric, JMeasure, JNote, JScore, JTime,
} from "../layout/input";
import { quarterTempos } from "../model/jianpu";
import type { ElementId, Measure as DocMeasure, Mark as DocMark, ScoreDoc, Song } from "../model/doc";
import { docView, type SlotRef } from "./slots";
import { distinctVerses, jpAlterOf } from "./phrasesong";
import { playDataOfSong } from "./playsong";
import { linesOfVoice, marksAt, nextSyllables, takesLyric, voiceNumbers } from "./ast";
import type { LyricLine, Mark, NoteElement, FanqieSong, ScoreLine } from "./ast";

// ───────────────────────── 构造 ─────────────────────────

function newMeasure(index: number, key: JKey = { fifths: 0 }, time: JTime = { beats: 4, beatType: 4 }): JMeasure {
  return {
    index, position: new Fraction(0), entries: [], key, time, keyChange: false, timeChange: false,
    leftBarline: null, barline: null, repeatForward: false, repeatBackward: false,
    endingLeft: false, endingNum: null, endingText: null, endingRight: null,
  };
}

function newChord(measure: JMeasure, id: ElementId | null): JChord {
  return {
    kind: "chord", id, measure, position: new Fraction(0), notes: [], dot: 0, beams: 0, beats: 0, rest: false,
    slurStart: false, slurEnds: 0, slurEndChords: [], fermata: false, harmony: null, sectionWord: null,
    directions: [], articulations: [], graceNotes: [],
  };
}

function newNote(chord: JChord): JNote {
  return {
    chord, number: "0", jpOctave: 0, jpAlter: " ", lyrics: [], tieStart: false, tieEnd: false,
    tieNext: null, tiePrev: null, tupletBegin: false, tupletEnd: false, tuplet: null,
  };
}

function lyric(text: string, number: number, refrain = false): JLyric {
  return { text, number, refrain };
}

/** 小节末换行：位置落在**小节末**（引擎按拍位稳定排序，默认的 0 会挤到第一个和弦之后——
 *  001《圣哉，圣哉，圣哉》行尾的「宰！」就这么被甩到下一行）。 */
export function breakAtMeasureEnd(m: JMeasure, newPage: boolean): JBreak {
  const position = m.entries.reduce((p, e) => {
    const end = e.kind === "chord" && e.duration ? e.position.plus(e.duration) : e.position;
    return end.compareTo(p) > 0 ? end : p;
  }, new Fraction(0));
  const br: JBreak = { kind: "break", position, newPage, pass: null };
  m.entries.push(br);
  return br;
}

/** 和弦之后换行（行内断点）。 */
export function breakAfterChord(m: JMeasure, c: JChord, newPage: boolean): JBreak {
  const i = m.entries.indexOf(c);
  const br: JBreak = { kind: "break", position: c.duration ? c.position.plus(c.duration) : c.position, newPage, pass: null };
  m.entries.splice(i < 0 ? m.entries.length : i + 1, 0, br);
  return br;
}

/** 连音首尾两两配对（起、止、起、止…）。 */
function pairTuplets(notes: readonly JNote[]): void {
  for (let i = 0; i + 1 < notes.length; i += 2) {
    const a = notes[i]!;
    const b = notes[i + 1]!;
    if (a.tupletEnd || b.tupletBegin) throw new Error("");
    const t = { first: a, last: b };
    a.tuplet = t;
    b.tuplet = t;
  }
}

/** "1,2" → {1,2} */
function endingNums(s: string): Set<number> {
  const res = new Set<number>();
  for (const it of s.split(",")) {
    const t = it.trim();
    if (t.length) res.add(parseInt(t, 10));
  }
  return res;
}

function chords(m: JMeasure): JChord[] {
  return m.entries.filter((e): e is JChord => e.kind === "chord");
}

/** MusicXML 的曲名：`title` 类 credit 的首行，没有就 `work-title` / `movement-title`（成书取它） */
export function xmlTitleOf(song: Song): string {
  for (const c of song.credits ?? []) {
    if (c.type?.trim() !== "title") continue;
    const t = (c.words?.[0] ?? c.text.split("\n")[0]!).trim();
    if (t) return t;
  }
  const wt = song.work.title !== song.work.movementTitle ? song.work.title?.trim() : undefined;
  return wt || song.work.movementTitle?.trim() || "";
}

// ───────────────────────── 简谱形状（经排版行视图） ─────────────────────────
//
// 口径：
//   - 每个有曲行的声部一份 part；小节按行里的小节线切，行与行之间插换行（`[fenye]` 换页）
//   - 调号拍号取头部；曲中转调/转拍号按模型小节的 `attrs` 标出（值变了才算）；和弦符号、力度、段落词、倚音不进
//   - 节奏音符 X/9 当休止；多连音起止之间的音都乘 2/3

export interface JianpuInputOptions {
  /** 取第几首（`-----` 分出的多唱法）。默认第一首。 */
  song?: number;
  /** 给展开档排版用（一遍一行词、只排 `parts[0]` 一条旋律）：
   *  带歌词的声部排到 `parts[0]`；同一条曲行下段号重复的歌词行顺延成下一段（见 `distinctVerses`）。 */
  forExpanded?: boolean;
}

/** 文本谱/123/ABC 的 `ScoreDoc` → 引擎输入。这首没有曲行时返回 null。 */
export function jianpuInputOfDoc(doc: ScoreDoc, options: JianpuInputOptions = {}): JScore | null {
  const view = docView(doc);
  const song = view.songs[options.song ?? 0];
  if (!song) return null;
  const score = songInput(song, (el) => view.idOf.get(el) ?? null, !!options.forExpanded);
  if (!score) return null;
  // 演唱顺序（反复、房号、D.C./D.S.、多段歌词逐段一遍、文档自带的 playOrder）由 ScoreDoc 推，见 `playsong.ts`
  const pd = playDataOfSong(doc, options.song ?? 0, options.forExpanded ? { forExpanded: true } : {});
  if (pd) {
    pd.tempo = score.playData.tempo;
    score.playData = pd;
  }
  return score;
}

/** 一行曲里，某个元素下标是某类记号的起点/终点。**跨行的续接端不是真端点**（弧被换行切成两个 Mark）。 */
function marksEdgeAt(marks: readonly Mark[], index: number, type: Mark["type"]): { starts: boolean; ends: boolean } {
  const hit = marksAt(marks, index, type);
  return {
    starts: hit.some((m) => m.start === index && !m.continuationFromPrevious),
    ends: hit.some((m) => m.end === index && !m.continuationToNext),
  };
}

function songInput(song: FanqieSong, idOf: (el: NoteElement) => ElementId | null, forExpanded: boolean): JScore | null {
  const meta = song.metadata;
  const credit: JCredit[] = [];
  const pushCredit = (text: string, type: string | null): void => {
    if (text) credit.push({ text, type, page: 0 });
  };
  meta.titles.forEach((t, i) => pushCredit(t, i === 0 ? "title" : "subtitle"));
  for (const t of meta.scripture ?? []) pushCredit(t, "scripture");
  for (const a of meta.authors) pushCredit(a, "composer");
  for (const t of meta.topRight) pushCredit(t, "composer");
  for (const t of meta.topLeft) pushCredit(t, "lyricist");

  const meter = meta.meters[0];
  const time: JTime = meter ? { beats: meter.numerator, beatType: meter.denominator } : { beats: 4, beatType: 4 };
  const key: JKey = { fifths: fifthsOfSpelling(meta.mode ?? "C", meta.tonic) ?? MusicCommon.keyNameToFifth(meta.mode ?? "C") };
  const playData = new PlayData();
  for (const tempo of meta.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      playData.tempo = tempo;
      break;
    }
  }

  let voices = voiceNumbers(song);
  if (forExpanded) {
    const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
    if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  }
  const parts: { measures: JMeasure[] }[] = [];
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    // ⚠ 页末（`pageEnds`）**两种视图都要给**：原来只在展开视图里给，于是换页在另一条路上被降级成换行 ——
    //   实测：123 的 `$$` 与 jianpu-ly 的 `\pageBreak` 导出去都只剩 `\break`（写出端拿不到"这是换页"）。
    parts.push({ measures: rowsPart(lines, time, key, idOf, forExpanded, pageEnds(song, v), !forExpanded) });
  }
  if (parts.length === 0) return null;
  return { parts, title: meta.titles[0] ?? "", credit, playData };
}

/** 源里 `[fenye]` 分出的页边界：每一页里该声部的最后一条曲行（末页不算）。 */
function pageEnds(song: FanqieSong, voice: number): Set<ScoreLine> {
  const out = new Set<ScoreLine>();
  song.pages.forEach((pg, i) => {
    if (i === song.pages.length - 1) return;
    let last: ScoreLine | null = null;
    for (const g of pg.groups) for (const v of g.voices) if (v.voice === voice) last = v;
    if (last) out.add(last);
  });
  return out;
}

/** 房号原文 → 适用于第几遍（文本里的数字才是遍数）。 */
function applyEndingStart(mea: JMeasure, mark: Mark): void {
  const text = (mark.caption ?? "").trim();
  mea.endingLeft = true;
  mea.endingText = text || null;
  const digits = text.match(/\d+/g);
  mea.endingNum = digits ? endingNums(digits.join(",")) : null;
}

/** 时值：beats × (附点) ÷ 2^减时线。多连音的 2/3 另乘。 */
function nominal(ch: JChord): Fraction {
  let dur = new Fraction(ch.beats);
  if (ch.dot > 0) dur = dur.timesInt(3).divInt(2);
  return dur.divInt(1 << ch.beams);
}

/** 一个声部的所有曲行（跨 system）接成一串小节，行与行之间插换行。 */
function rowsPart(
  lines: readonly ScoreLine[],
  time: JTime,
  key: JKey,
  idOf: (el: NoteElement) => ElementId | null,
  renumberVerses: boolean,
  pageEndSet?: ReadonlySet<ScoreLine>,
  decorate = false,
): JMeasure[] {
  const measures: JMeasure[] = [];
  let measure: JMeasure | null = null;
  const tupletNotes: JNote[] = [];
  /** 开着的弧的起点，后开先收（嵌套弧）；跨行的弧靠它连到下一行的收尾处 */
  const slurOpen: JChord[] = [];
  let newMeasureNeeded = true;
  let lastChord: JChord | null = null;
  let pendingRepeatForward = false;
  let pendingEnding: Mark | null = null;
  // 曲中转调/转拍号：按行里符号的来源小节（`SlotRef.measure`）取模型小节的 `attrs`，与当前的不同才算变
  let curKey = key;
  let curTime = time;
  const seen = new Set<DocMeasure>();
  /** 开着的渐强渐弱：起点和弦与 Mark（跨行的续接端在下一行接着找收尾） */
  const wedgeOpen: { from: JChord; type: "crescendo" | "diminuendo" }[] = [];
  const open = (src: DocMeasure | undefined): JMeasure => {
    const m = newMeasure(measures.length, curKey, curTime);
    if (src && !seen.has(src)) {
      seen.add(src);
      const k = src.attrs?.key;
      const t = src.attrs?.time;
      if (measures.length > 0 && k && k.fifths !== curKey.fifths) {
        m.key = curKey = { fifths: k.fifths };
        m.keyChange = true;
      }
      if (measures.length > 0 && t && (t.beats !== curTime.beats || t.beatType !== curTime.beatType)) {
        m.time = curTime = { beats: t.beats, beatType: t.beatType };
        m.timeChange = true;
      }
      // 小节**左线**上的反复起点（曲首的 `|:`、接在 `||` 后面的 `|:`）：排版行视图不把左线输出成元素
      //（`jianpu/slots.ts::buildRow`，否则多出空小节），只靠前一小节右线的 `:|:` 带不回来，在这里直接从模型读
      if (src.barlines?.some((b) => b.location === "left" && b.repeat === "forward")) m.repeatForward = true;
    }
    measure = m;
    measures.push(m);
    return m;
  };

  lines.forEach((line, lineIdx) => {
    const refs = (line as ScoreLine & { refs?: readonly SlotRef[] }).refs;
    const lyrics = renumberVerses ? distinctVerses(line.lyrics) : line.lyrics;
    const cursors = lyrics.map(() => 0);
    const voltas = line.marks.filter((mk) => mk.type === "volta");

    line.elements.forEach((el, index) => {
      for (const mk of voltas) if (mk.start === index && !mk.continuationFromPrevious) pendingEnding = mk;
      const endsVolta = voltas.filter((mk) => mk.end === index && !mk.continuationToNext);
      const closeVolta = (mea: JMeasure | null): void => {
        if (!mea) return;
        for (const mk of endsVolta) mea.endingRight = mk.openEnd ? StartStopDiscontinue.DISCONTINUE : StartStopDiscontinue.STOP;
      };

      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;

      if (el.kind === "sustain") {
        closeVolta(measure);
        // 增时线并进前一个音符的时值
        if (lastChord) {
          lastChord.beats += 1;
          lastChord.duration = nominal(lastChord);
          // 长音中途换的和弦印在对应那条增时线上（下标 = 第几条增时线 − 1）
          if (decorate && el.chord) {
            const list = (lastChord.sustainHarmonies ??= []);
            while (list.length < lastChord.beats - 1) list.push(null);
            list[lastChord.beats - 2] = el.chord;
          }
        }
        if (el.lyricAnchor && lastChord) attachLyrics(lyrics, cursors, lastChord);
        return;
      }

      if (el.kind === "barline") {
        const mea = measure ?? open(refs?.[index]?.measure);
        closeVolta(mea);
        // 反复起点 `|:` 挂到**下一小节**的 repeatForward 上
        switch (el.type) {
          case "normal": mea.barline = BarStyle.REGULAR; break;
          case "double": mea.barline = BarStyle.LIGHT_LIGHT; break;
          case "end": mea.barline = BarStyle.LIGHT_HEAVY; break;
          case "repeat-start": pendingRepeatForward = true; break;
          case "repeat-end":
            mea.repeatBackward = true;
            mea.barline = BarStyle.LIGHT_HEAVY;
            break;
          case "repeat-both":
            mea.repeatBackward = true;
            mea.barline = BarStyle.LIGHT_HEAVY;
            pendingRepeatForward = true;
            break;
          default: mea.barline = BarStyle.NONE;
        }
        mea.entries.push({ kind: "bar", position: new Fraction(0) });
        // 小节线上的跳转记号（`&fine` `&dc` `&ds` `&ty` `&hs`）贴着这条小节线、挂在它前面那个音上
        if (decorate && lastChord) {
          for (const orn of el.ornaments) {
            const bm = BARLINE_MARKS[orn.name];
            if (bm?.text) lastChord.directions.push({ text: bm.text, music: false, italic: false, atBarEnd: true });
            else if (bm?.glyph) lastChord.directions.push({ text: bm.glyph, music: true, italic: false, atBarEnd: true });
          }
        }
        newMeasureNeeded = true;
        return;
      }

      // 音符
      const mea: JMeasure = newMeasureNeeded || measure === null ? open(refs?.[index]?.measure) : measure;
      newMeasureNeeded = false;
      if (pendingRepeatForward) {
        mea.repeatForward = true;
        pendingRepeatForward = false;
      }
      if (pendingEnding) {
        applyEndingStart(mea, pendingEnding);
        pendingEnding = null;
      }
      closeVolta(mea);

      const ch = newChord(mea, idOf(el));
      const nt = newNote(ch);
      ch.notes.push(nt);
      nt.number = el.sound === "rhythm" ? "0" : String(el.pitch);
      nt.jpOctave = el.octave;
      nt.jpAlter = jpAlterOf(el);
      ch.beats = 1;
      ch.beams = Math.max(0, Math.round(Math.log2(el.duration / 4)));
      ch.dot = el.dots;
      if (el.hidden || el.sound === "rest" || el.sound === "rhythm" || nt.number === "0") ch.rest = true;
      if (el.hidden) ch.hidden = true;
      if (decorate) {
        for (const m of marksAt(line.marks, index, "crescendo").concat(marksAt(line.marks, index, "decrescendo"))) {
          const type = m.type === "crescendo" ? "crescendo" : "diminuendo";
          if (m.end === index && !m.continuationToNext) {
            const k = wedgeOpen.map((w) => w.type).lastIndexOf(type);
            const open = k >= 0 ? wedgeOpen.splice(k, 1)[0] : undefined;
            if (open) (open.from.wedges ??= []).push({ type, end: ch });
          }
          if (m.start === index && !m.continuationFromPrevious) wedgeOpen.push({ from: ch, type });
        }
      }

      const tup = marksEdgeAt(line.marks, index, "tuplet");
      if (tup.starts) nt.tupletBegin = true;
      if (tup.ends) nt.tupletEnd = true;
      if (nt.tupletBegin || nt.tupletEnd) tupletNotes.push(nt);

      // **先收后起**：同一个音既收前一条弧又起下一条（123 的 `(3_ | (3:(3_) 3_)`、ABC 的连续 tie）时，
      // 先起的话 `slurOpen` 被这个音顶掉，前一条弧就收到自己身上、整条丢了（secret base 跨小节那条）。
      // 同一个音可以同时收几条弧（外弧与内弧同终点：1921《天上的阿爸盼望你回家》`(3. (4__ (3__) 2-))`），
      // 以前只记一个开着的起点，内弧一起就把外弧的起点顶掉，外弧整条不画。
      const slurHits = marksAt(line.marks, index, "slur");
      const slurEnds = slurHits.filter((m) => m.end === index && !m.continuationToNext).length;
      for (let k = 0; k < slurEnds; k++) {
        ch.slurEnds++;
        const from = slurOpen.pop();
        if (from) from.slurEndChords.push(ch);
      }
      // 同一个音可以起几条弧（`((5_ 5_) 6)`：外弧与内弧同起点），各压一次栈
      for (const m of slurHits) {
        if (m.start !== index || m.continuationFromPrevious) continue;
        ch.slurStart = true;
        slurOpen.push(ch);
      }
      for (const orn of el.ornaments) if (orn.name === "yc" || orn.name === "ycy") ch.fermata = true;
      if (decorate) decorateChord(ch, el);
      // 倚音两档都画（用户定：展开档也保留倚音；`.jpwabc` 那一路本来就留着）
      ch.graceNotes = graceNotesOf(el);

      ch.duration = nominal(ch);
      mea.entries.push(ch);
      lastChord = ch;
      if (takesLyric(el)) attachLyrics(lyrics, cursors, ch);
    });

    // 行末换行（末行不加）。`[fenye]` 落在这一行末尾时写成换页
    if (lineIdx < lines.length - 1 && measure) breakAtMeasureEnd(measure, pageEndSet?.has(line) ?? false);
  });

  pairTuplets(tupletNotes);
  layoutTimes(measures, true);
  return measures;
}

/** 文本谱 `&xx` 记号 → 奏法记号名。 */
const ARTIC_OF_ORNAMENT: Readonly<Record<string, string>> = { zy: "accent", dy: "staccato", bc: "tenuto", hx: "breath" };

/**
 * 原样档（`decorate`）才要的那几样：和弦、段落词、重音、力度/术语。展开档不画它们（投影片只要旋律与词）；倚音两档都画（见 `rowsPart`）。
 * 只收引擎画得出的：奏法记号是重音、顿音、保持音、换气，其余 `&xx` 暂不出现。
 */
function decorateChord(ch: JChord, el: NoteElement): void {
  if (el.chord) ch.harmony = el.chord;
  if (el.annotation) ch.sectionWord = el.annotation;
  for (const orn of el.ornaments) {
    const art = ARTIC_OF_ORNAMENT[orn.name];
    if (art) ch.articulations.push(art);
    else if (DYNAMICS[orn.name]) ch.directions.push({ text: DYNAMICS[orn.name]!, music: true, dynamic: true, italic: false });
    else if (TERMS[orn.name]) ch.directions.push({ text: TERMS[orn.name]!, music: false, italic: true });
    // 挂在音符上的跳转记号：segno / coda（左线上的跳转目标，`docView` 挂到小节头一个音上）印在音符上方；
    // Fine / D.S. 落到音符上的（小节没有右线）照小节线上的口径贴着小节末
    else if (BARLINE_MARKS[orn.name]?.glyph) ch.directions.push({ text: BARLINE_MARKS[orn.name]!.glyph!, music: true, italic: false });
    else if (BARLINE_MARKS[orn.name]?.text) ch.directions.push({ text: BARLINE_MARKS[orn.name]!.text!, music: false, italic: false, atBarEnd: true });
  }
}

function graceNotesOf(el: NoteElement): JChord["graceNotes"] {
  return el.graceBefore.map((g) => ({ number: String(g.pitch), jpOctave: g.octave, jpAlter: jpAlterOf(g), duration: g.duration }));
}

/** 按时值排出各条目的拍位与小节起点。`scaleInner`：多连音起止之间的音也乘 2/3（`.jpwabc` 旧口径只乘首尾两个）。 */
function layoutTimes(measures: readonly JMeasure[], scaleInner: boolean): void {
  let inTuplet = false;
  for (const m of measures) {
    let pos = new Fraction(0);
    for (const ent of m.entries) {
      ent.position = pos;
      if (ent.kind !== "chord") continue;
      let dur = nominal(ent);
      const nt = ent.notes[0];
      if (nt?.tuplet && nt.tupletBegin) inTuplet = true;
      if ((scaleInner && inTuplet) || nt?.tuplet) dur = dur.timesInt(2).divInt(3);
      if (nt?.tuplet && nt.tupletEnd) inTuplet = false;
      ent.duration = dur;
      pos = pos.plus(dur);
    }
  }
  let acc = new Fraction(0);
  for (const m of measures) {
    m.position = acc;
    for (const ent of m.entries) if (ent.kind === "chord") acc = acc.plus(ent.duration!);
  }
}

function attachLyrics(lyrics: readonly LyricLine[], cursors: number[], ch: JChord): void {
  for (const { verse, text } of nextSyllables(lyrics, cursors)) ch.notes[0]!.lyrics.push(lyric(text, verse));
}


// ───────────────────────── `.jpwabc` ─────────────────────────
//
// 直接按模型小节建（`model/fromjpw.ts::jpwToScoreDoc` 已按原文小节切好）。口径：
//   - 小节线一律不带样式（谱面画细线，曲末由 `final` 补粗）；反复、房号不画——展开档按演唱顺序逐遍铺开
//   - 换行照原文位置：小节之间的记在下一小节的 `print` 上，小节中间的记在前一个和弦的 `lineBreakAfter` 上
//   - 倚音挂到它后面那个音符上；没有和弦符号、力度、段落词
//   - 曲首 `|:|` 连写不开空小节（`jpwToScoreDoc` 并进下一小节左线）
//   - 连音起止之间的音也乘 2/3（只乘首尾两个的话中间的音拍位偏后，符杠分组跟着错）

const DEGREE_ALTER: Readonly<Record<string, string>> = { sharp: "#", flat: "b", natural: "n" };
/** 倚音的符号时值 → `JGrace.duration`（减时线条数由它定；四分及未记的按八分画一条） */
const GRACE_DURATION: Readonly<Record<string, number>> = { eighth: 8, "16th": 16, "32nd": 32 };

/** `.jpwabc` 的 `ScoreDoc` → 引擎输入。没有声部时返回 null。 */
export function jianpuInputOfJpw(doc: ScoreDoc): JScore | null {
  const song = doc.songs[0];
  const part = song?.parts[0];
  if (!song || !part) return null;
  const credit: JCredit[] = (song.credits ?? []).map((c) => ({ type: null, text: c.text, page: 0 }));
  let key: JKey = { fifths: song.key?.fifths ?? 0 };
  let time: JTime = { beats: song.time?.beats ?? 4, beatType: song.time?.beatType ?? 4 };

  const byId = new Map<ElementId, JChord>();
  const slurEnds: { from: JChord; to: ElementId }[] = [];
  const marksFrom = new Map<ElementId, DocMark[]>();
  const marksTo = new Map<ElementId, DocMark[]>();
  const push = (map: Map<ElementId, DocMark[]>, id: ElementId, mk: DocMark): void => {
    const list = map.get(id);
    if (list) list.push(mk);
    else map.set(id, [mk]);
  };
  for (const mk of song.marks) {
    if (mk.type !== "slur" && mk.type !== "tuplet") continue;
    push(marksFrom, mk.start, mk);
    push(marksTo, mk.end, mk);
  }
  /** 带小节中间换行的和弦 */
  const inlineBreak = new Set<ElementId>();
  const tupletNotes: JNote[] = [];
  const measures: JMeasure[] = [];
  let graces: JChord["graceNotes"] = [];

  part.measures.forEach((dm, i) => {
    if (dm.attrs?.key && i > 0) key = { fifths: dm.attrs.key.fifths };
    if (dm.attrs?.time && i > 0) time = { beats: dm.attrs.time.beats, beatType: dm.attrs.time.beatType };
    const m = newMeasure(i, key, time);
    m.keyChange = i > 0 && !!dm.attrs?.key;
    m.timeChange = i > 0 && !!dm.attrs?.time;
    const prev = measures[i - 1];
    // 小节之间的换行落在上一小节末（小节线之后）；上一小节里已有小节中间换行时，那就是同一处 `$`
    const brk = dm.print?.newPage ? "page" : dm.print?.newSystem ? "system" : null;
    if (prev && brk && !chords(prev).some((c) => c.id !== null && inlineBreak.has(c.id))) breakAtMeasureEnd(prev, brk === "page");
    measures.push(m);

    for (const el of dm.elements) {
      if (el.kind !== "chord") continue;
      const n0 = el.notes[0];
      if (el.grace) {
        const d = n0?.degree;
        const dur = GRACE_DURATION[el.duration.type ?? ""];
        graces.push({ number: String(d?.number ?? 1), jpOctave: d?.octaveShift ?? 0, jpAlter: DEGREE_ALTER[d?.accidental ?? ""] ?? " ",
          ...(dur ? { duration: dur } : {}) });
        continue;
      }
      const ch = newChord(m, el.id);
      byId.set(el.id, ch);
      const nt = newNote(ch);
      ch.notes.push(nt);
      const d = n0?.degree;
      ch.rest = !d || !!el.rest;
      nt.number = d && !el.rest ? String(d.number) : "0";
      nt.jpOctave = d?.octaveShift ?? 0;
      nt.jpAlter = DEGREE_ALTER[d?.accidental ?? ""] ?? " ";
      ch.beams = el.beams?.length ?? 0;
      ch.beats = (el.sustains?.length ?? 0) + 1;
      ch.dot = el.duration.dots;
      ch.fermata = !!el.notations?.fermata;
      for (const l of el.lyrics ?? []) nt.lyrics.push(lyric(l.text, l.number));
      ch.graceNotes = graces;
      graces = [];
      for (const mk of marksTo.get(el.id) ?? []) {
        if (mk.type === "slur") ch.slurEnds++;
        else nt.tupletEnd = true;
      }
      for (const mk of marksFrom.get(el.id) ?? []) {
        if (mk.type === "slur") {
          ch.slurStart = true;
          slurEnds.push({ from: ch, to: mk.end });
        } else {
          nt.tupletBegin = true;
        }
      }
      if (nt.tupletBegin) tupletNotes.push(nt);
      if (nt.tupletEnd) tupletNotes.push(nt);
      m.entries.push(ch);
      if (el.lineBreakAfter) {
        inlineBreak.add(el.id);
        breakAfterChord(m, ch, el.lineBreakAfter === "page");
      }
    }
    if ((dm.barlines ?? []).some((b) => b.location === "right")) m.entries.push({ kind: "bar", position: new Fraction(0) });
  });
  const last = measures[measures.length - 1];
  if (last && part.endBreak) breakAtMeasureEnd(last, part.endBreak === "page");
  for (const { from, to } of slurEnds) {
    const end = byId.get(to);
    if (end) from.slurEndChords.push(end);
  }
  pairTuplets(tupletNotes);
  layoutTimes(measures, true);

  const playData = playDataOfSong(doc, 0) ?? new PlayData();
  const tempo = quarterTempos(song)[0];
  playData.tempo = typeof tempo === "number" ? tempo : 0;
  return { parts: [{ measures }], title: song.work.title ?? "", credit, playData };
}
