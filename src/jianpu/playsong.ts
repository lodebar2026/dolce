// 试听统一入口 `playSourceOf`（各格式共用），以及简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC / `.jpwabc`）
// → 演唱顺序、试听输入、`.jpwabc` 写出端输入。
//
// 与 `playdoc.ts`（MusicXML 形状）分工同断句那一对（`jianpu/phrasesong.ts` / `phrasedoc.ts`），
// 小节序列与断句共用 `jianpu/phrasesong.ts::buildMeasures`，行视图取 `jianpu/slots.ts::docView`。**口径同简谱输入模型 `jianpuinput.ts::jianpuInputOfDoc`**：
//   - 每个有曲行的声部都算一份（歌词段数取各声部最大值），反复与跳转只看第一份（它在某格没有小节就看那一格的代表小节）；
//     各份叠在共用时间轴上（`timeaxis.ts`，文本谱一组不一定含全部声部）；
//     `forExpanded` 时带歌词的声部排第一、同号歌词顺延（同 `ToScoreOptions.forExpanded`）。
//     试听输入（`playSourceOfSong`）推完演唱顺序后把声部排回模型顺序、主旋律记进 `PlaySource.lead`；
//     编辑器试听不论哪一档都传 `forExpanded`（`App.playable`）
//   - 跳转记号换算同 `applyJumps`；推不出来（抛错）才退回整曲按段数逐遍
// 另有两条只归 `.jpwabc` 的：
//   - 文档自带演唱顺序（`Song.playOrder`，`.Repeat` 段）→ 照它排，不推
//   - `.jpwabc` 没有 `.Repeat`、也没有反复记号 → 不推，整曲按段数逐遍（JP-Word 本来就这么唱）；有 `|: :|` 照它推

import type { Chord, ElementId, Part, PlayPass, ScoreDoc, Song } from "../model/doc";
import { writtenOctaveOf } from "../model/jianpu";
import { Fraction } from "../common/fraction";
import {
  JumpSpec, PlayData, PlaySpecKind, RepeatSpecItem, TimePosition,
  playOrderByVerses, playOrderFromSpec, playOrderOf,
} from "../score/playorder";
import { linesOfVoice, voiceNumbers, type MusicElement, type FanqieSong } from "./ast";
import { Key, MusicCommon } from "../score/jppitch";
import { fifthsOfSpelling } from "../model/keyshift";
import type { PlaySource } from "../score/timeline";
import type { JpwChordIn, JpwMeasureIn, JpwScoreIn } from "../model/tojpw";
import { buildMeasures, type JumpOut, type MeasureOut } from "./phrasesong";
import { docView } from "./slots";
import { playSourceOfDoc } from "../model/playdoc";
import { hasTieSyntax, hasVoiceOverlay, isXmlShaped, projectForMusicXml } from "../model/xmlproject";
import { axisOfSong, spreadOnAxis } from "../model/timeaxis";
import { breaksOf } from "../model/breaks";

export interface PlaySongOptions {
  /** 见 `ToScoreOptions.forExpanded` */
  forExpanded?: boolean;
}

/** **试听/MIDI 的统一入口**（各格式共用）：MusicXML 形状走 `playdoc.ts::playSourceOfDoc`（全部声部、voice 与力度），
 *  简谱形状走 `playSourceOfSong`。拼不出（这首没有曲行）返回 null。
 *  多声部按各声部共用的时间轴叠（`timeaxis.ts`：文本谱一组不一定含全部声部，按组号落格，缺席处不补任何东西）。 */
export function playSourceOf(doc: ScoreDoc, songIdx = 0, options: PlaySongOptions = {}): PlaySource | null {
  const song = doc.songs[songIdx];
  if (!song) return null;
  if (isXmlShaped(song)) return playSourceOfDoc(song);
  // ABC `&` 的临时多声部：简谱那条路一个声部行只走一条旋律，会把并行的分支当成接着唱的音。
  // 先投成 MusicXML 形状（元素 id 不变，高亮照样认得）再按 voice 分轨播（`playdoc.ts`）。
  // 大谱表（`V:2 part=1`）与和音（`[CEG]`）同此：简谱那条路一个和弦只响一个音、不读力度
  if (hasVoiceOverlay(song) || song.parts.some((p) => p.staffOf) || song.parts.some((p) => p.measures.some((m) => m.elements.some((el) => el.kind === "chord" && !el.rhythm && el.notes.length > 1)))) {
    return playSourceOfDoc(projectForMusicXml(song, { slurTies: !hasTieSyntax(doc) }));
  }
  return playSourceOfSong(doc, songIdx, options);
}

/** 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。这首没有曲行时返回 null。
 *  在共用时间轴上推，小节下标折回第一份声部（`forExpanded` 时是带歌词的那个）自己的小节序：展开档、`.jpwabc` 只排它。 */
export function playDataOfSong(doc: ScoreDoc, songIdx = 0, options: PlaySongOptions = {}): PlayData | null {
  const built = songMeasures(doc, songIdx, options, false);
  return built && foldToFirstPart(playDataOf(doc, songIdx, built), built);
}

/** 试听/MIDI 的输入（`score/timeline.ts::PlaySource`）：各声部小节序列 + 演唱顺序 + 速度，和弦带元素 id。
 *  口径同 `jianpuInputOfDoc`（声部顺序；音高换算 `applyJpPitch`、速度取 `meta.tempos` 首个 20..400 的数）。 */
export function playSourceOfSong(doc: ScoreDoc, songIdx = 0, options: PlaySongOptions = {}): PlaySource | null {
  const built = songMeasures(doc, songIdx, options, true);
  if (!built) return null;
  markExtends(doc.songs[songIdx]!, built.parts);
  const playData = playDataOf(doc, songIdx, built);
  for (const tempo of built.song.metadata.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      playData.tempo = tempo;
      break;
    }
  }
  // 演唱顺序按「带歌词的声部在前」推好了；交出去时声部排回模型的顺序（声部面板、MIDI 轨序按它），主旋律另记
  const order = built.parts.map((_, i) => i).sort((a, b) => built.docRank[a]! - built.docRank[b]!);
  return {
    parts: order.map((i) => ({ measures: spreadOnAxis(built.parts[i]!, built.slots[i]!, built.length), name: built.names[i] })),
    playData,
    lead: order.indexOf(0),
  };
}

/** 歌词的续记号（`_`）从模型补到小节序列的字上（导出 MIDI 判一字多音用：带它的字后面紧接的无字音接着唱它）。
 *  行视图的音节不带这一项；按元素 id 找回模型的和弦，再按字与段号认是哪一条（`C1-2:` 一条词展开成几段，不能按下标）。 */
function markExtends(song: Song, parts: readonly MeasureOut[][]): void {
  const byId = new Map<ElementId, Chord>();
  for (const p of song.parts) for (const m of p.measures) for (const el of m.elements) if (el.kind === "chord") byId.set(el.id, el);
  for (const measures of parts) {
    for (const m of measures) {
      for (const ch of m.entries) {
        const model = ch.id === undefined ? undefined : byId.get(ch.id)?.lyrics?.filter((l) => l.extend && l.text.length > 0);
        if (!model?.length) continue;
        for (const l of ch.notes[0]!.lyrics) {
          const same = model.filter((x) => x.text + (x.trailingPunctuation ?? "") === l.text);
          const hit = same.find((x) => x.number <= l.number && l.number <= (x.numberTo ?? x.number)) ?? same[0];
          if (hit) l.extend = true;
        }
      }
    }
  }
}

/** 行视图的声部号 → 模型的 part（`jianpu/slots.ts::toFanqieSong` 按 `P<n>` 的 id 或 part 序编号）。 */
function partOfVoice(song: Song, voice: number): Part | undefined {
  return song.parts.find((p) => p.id === `P${voice}`) ?? song.parts[voice - 1];
}

/** 曲中转调：模型小节上的调号（第二小节起，口径同 `jianpuinput.ts` 与 `playdoc.ts`）按元素 id 交给 `buildMeasures`。
 *  全曲没有转调时不给（`buildMeasures` 照头部调号算）。文本谱后几组才出场的声部，头一小节上的调号也算（缺席时转了调，`fromfanqie.ts` 补在它上面）。 */
function keyChangesOf(view: ReturnType<typeof docView>, part: Part | undefined): { fifthsOf?: (el: MusicElement) => number | undefined } {
  const changes = (m: Part["measures"][number], i: number): boolean => !!m.attrs?.key && (i > 0 || (m.print?.system ?? 0) > 0);
  if (!part || !part.measures.some(changes)) return {};
  const byId = new Map<ElementId, number>();
  let fifths: number | undefined;
  part.measures.forEach((m, i) => {
    if (changes(m, i)) fifths = m.attrs!.key!.fifths;
    if (fifths === undefined) return;
    for (const el of m.elements) if (el.kind === "chord") byId.set(el.id, fifths);
  });
  return {
    fifthsOf: (el) => {
      const id = view.idOf.get(el);
      return id === undefined ? undefined : byId.get(id);
    },
  };
}

interface SongMeasures {
  song: FanqieSong;
  key: Key;
  time: { beats: number; beatType: number };
  voices: number[];
  parts: MeasureOut[][];
  /** 与 `parts` 平行：声部名（MIDI 轨名） */
  names: (string | undefined)[];
  /** 与 `parts` 平行：在模型声部序里排第几（`forExpanded` 把带歌词的声部挪到了第一份） */
  docRank: number[];
  /** 第一份声部的跳转记号（小节是它自己的小节序） */
  jumps: JumpOut[];
  /** 第一份声部的和弦 → 轴上第几格、小节内第几个 */
  idToChord: Map<ElementId, { measure: number; index: number }>;
  /** 共用时间轴：`slots[k][i]` = 第 k 份第 i 小节落在第几格；一共 `length` 格，每格至少有一份有小节 */
  slots: number[][];
  length: number;
}

function songMeasures(doc: ScoreDoc, songIdx: number, options: PlaySongOptions, withPitch: boolean): SongMeasures | null {
  const view = docView(doc);
  const song = view.songs[songIdx];
  if (!song) return null;
  const docVoices = voiceNumbers(song);
  let voices = docVoices;
  if (options.forExpanded) {
    const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
    if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  }
  // 调号/拍号同 `songToScore`：全曲一个，取头部
  const meta = song.metadata;
  const meter = meta.meters[0];
  const time = meter ? { beats: meter.numerator, beatType: meter.denominator } : { beats: 4, beatType: 4 };
  const key = new Key();
  // 调名缺省时取模型的 fifths：`.jpwabc` 来源只记 fifths、不记调名拼写（`.Title` 的调号）
  const fifths = doc.songs[songIdx]!.key?.fifths;
  key.fifths = meta.mode === undefined && fifths !== undefined ? fifths : (fifthsOfSpelling(meta.mode ?? "C", meta.tonic) ?? MusicCommon.keyNameToFifth(meta.mode ?? "C"));
  const parts: MeasureOut[][] = [];
  const models: (Part | undefined)[] = [];
  const names: (string | undefined)[] = [];
  const docRank: number[] = [];
  let jumps: JumpOut[] = [];
  const idToChord = new Map<ElementId, { measure: number; index: number }>();
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    const first = parts.length === 0;
    const pitch = withPitch
      ? { key: { basePitch: MusicCommon.getBasePitchOfKey(key), fifths: key.fifths, alter: {} }, time, ...keyChangesOf(view, partOfVoice(doc.songs[songIdx]!, v)), slurTies: !hasTieSyntax(doc) }
      : undefined;
    const built = buildMeasures(lines, (ch, el) => {
      const id = view.idOf.get(el);
      if (id !== undefined) ch.id = id;
    }, !!options.forExpanded, pitch);
    // 八度谱号的声部（四声部简谱的男高、男低按高八度记）实际低八度发声
    const part = withPitch ? partOfVoice(doc.songs[songIdx]!, v) : undefined;
    const oc = part ? writtenOctaveOf(part) : 0;
    if (oc) {
      for (const m of built.measures) for (const ch of m.entries) for (const n of ch.notes) if (n.pitch > 0) n.pitch += 12 * oc;
    }
    if (first) jumps = built.jumps;
    parts.push(built.measures);
    models.push(partOfVoice(doc.songs[songIdx]!, v));
    names.push(partOfVoice(doc.songs[songIdx]!, v)?.name);
    docRank.push(docVoices.indexOf(v));
  }
  if (parts.length === 0) return null;
  const { slots, length } = axisOfMeasures(doc.songs[songIdx]!, models, parts);
  parts[0]!.forEach((m, measure) => m.entries.forEach((ch, index) => {
    if (ch.id !== undefined) idToChord.set(ch.id, { measure: slots[0]![measure]!, index });
  }));
  return { song, key, time, voices, parts, names, docRank, jumps, idToChord, slots, length };
}

/** 各份小节序列在共用时间轴（`timeaxis.ts`）上的格：小节按首个和弦的元素 id 找回模型小节、取它的格。
 *  不按组排的谱（非文本谱、单声部）各份照自己的小节序号一一对应（行视图切的小节与模型小节不一定一一对应，不去对）。
 *  一格都没有小节的（模型小节没切出行视图小节）压掉，保证每格至少有一份。 */
function axisOfMeasures(song: Song, models: readonly (Part | undefined)[], parts: readonly MeasureOut[][]): { slots: number[][]; length: number } {
  const axis = axisOfSong(song);
  if (!axis.grouped) return { slots: parts.map((ms) => ms.map((_, i) => i)), length: Math.max(0, ...parts.map((ms) => ms.length)) };
  const raw = parts.map((ms, k) => {
    const pi = models[k] ? song.parts.indexOf(models[k]!) : -1;
    const slotOf = new Map<ElementId, number>();
    song.parts[pi]?.measures.forEach((m, i) => {
      for (const el of m.elements) slotOf.set(el.id, axis.slot[pi]![i]!);
    });
    let prev = -1;
    return ms.map((m) => {
      const hit = m.entries.find((ch) => ch.id !== undefined && slotOf.has(ch.id));
      prev = Math.max(hit ? slotOf.get(hit.id!)! : prev + 1, prev + 1);
      return prev;
    });
  });
  const used = [...new Set(raw.flat())].sort((a, b) => a - b);
  const rank = new Map(used.map((g, i) => [g, i]));
  return { slots: raw.map((s) => s.map((g) => rank.get(g)!)), length: used.length };
}

/** 轴上每一格的「代表小节」：第一份的，第一份在这一格没有小节就取后面第一个有的。推演唱顺序时读小节线、反复、房号用（引用原小节，不复制）。 */
function leadOnAxis({ parts, slots, length }: SongMeasures): MeasureOut[] {
  const out = new Array<MeasureOut | undefined>(length).fill(undefined);
  parts.forEach((ms, k) => ms.forEach((m, i) => {
    const g = slots[k]![i]!;
    out[g] ??= m;
  }));
  return out as MeasureOut[];
}

/** 轴上推的演唱顺序 → 第一份声部自己的小节序（它每格都有小节时原样返回）。
 *  第一份在某格没有小节：一项只留它有小节的那几格（首尾换了小节就不再截半小节），一格都没有的项丢掉（换页挪给前一项）；
 *  跳转落点挪到它往后第一个有的小节。 */
function foldToFirstPart(pd: PlayData, { slots, length }: SongMeasures): PlayData {
  const mine = slots[0]!;
  if (mine.length === length) return pd;
  const local = new Array<number>(length).fill(-1);
  mine.forEach((g, i) => (local[g] = i));
  /** 第 g 格往后（含）第一个有小节的格，没有就是小节总数 */
  const nextLocal = (g: number): number => {
    for (let s = g; s < length; s++) if (local[s]! >= 0) return local[s]!;
    return mine.length;
  };
  const out = new PlayData();
  out.hasRepeat = pd.hasRepeat;
  out.isSimpple = pd.isSimpple;
  out.tempo = pd.tempo;
  for (const it of pd.measures) {
    const have: number[] = [];
    for (let g = it.mid; g < it.end; g++) if (local[g]! >= 0) have.push(g);
    if (have.length === 0) {
      const prev = out.measures[out.measures.length - 1];
      if (prev && it.endOfPass) prev.endOfPass = true;
      continue;
    }
    const c = it.clone();
    c.mid = local[have[0]!]!;
    c.end = local[have[have.length - 1]!]! + 1;
    if (have[0] !== it.mid) {
      c.offset = new Fraction(0);
      c.skip = 0;
    }
    if (have[have.length - 1] !== it.end - 1) c.limit = -1;
    if (it.glueFrom >= 0) c.glueFrom = Math.min(nextLocal(it.glueFrom), c.end);
    out.measures.push(c);
  }
  const move = (t: TimePosition): TimePosition => {
    const m = nextLocal(t.mid);
    return local[t.mid]! >= 0 ? new TimePosition(m, t.offset) : new TimePosition(m, new Fraction(0));
  };
  for (const [k, t] of pd.segno) out.segno.set(k, move(t));
  for (const [k, t] of pd.coda) out.coda.set(k, move(t));
  for (const [t, v] of pd.jumpTo) out.jumpTo.set(move(t), v);
  return out;
}

function playDataOf(doc: ScoreDoc, songIdx: number, built: SongMeasures): PlayData {
  const { song, voices, parts, jumps, idToChord, slots, length } = built;
  const main = leadOnAxis(built);
  const pd = new PlayData();
  const docSong = doc.songs[songIdx]!;
  if (docSong.playOrder?.length) {
    pd.measures = playOrderFromSpec({ items: docSong.playOrder.map((p) => specItem(p, idToChord)) }, { measures: main });
    return pd;
  }
  // 段数 = 主旋律歌词最多的那一行的段号上限（`.jpwabc` 即 `.Words` 各段的遍数上限）
  let passes = 0;
  for (const line of linesOfVoice(song, voices[0]!)) {
    for (const l of line.lyrics) passes = Math.max(passes, l.verseTo);
  }
  // `.jpwabc` 没有 `.Repeat`：谱里没有反复记号就整曲按段数逐遍（JP-Word 本来就这么唱）；
  // 有 `|: :|` 的照反复记号推（用户定，2026-10-14：020《向主歌唱》的 `.Layout` 时值总长对得上「走反复」）
  if (doc.sourceFormat === "jpwabc" && !main.some((m) => m.repeatBackward)) {
    pd.measures = playOrderByVerses(main.length, passes);
    pd.isSimpple = true;
    return pd;
  }

  applyJumps(pd, main, jumps.map((j) => ({ ...j, measure: slots[0]![j.measure]! })));
  try {
    const order = playOrderOf([{ measures: main }, ...parts.slice(1).map((ms, k) => ({ measures: spreadOnAxis(ms, slots[k + 1]!, length) }))], pd);
    pd.isSimpple = order.isSimple;
    // `.jpwabc` 读进来按反复记号推的顺序，重读时照样推得出来：不算「有反复」，写出端就不另补 `.Repeat`（往返定点）
    pd.hasRepeat = order.hasRepeat && doc.sourceFormat !== "jpwabc";
    pd.measures = order.measures;
    if (pd.measures.length > 0) return pd;
  } catch (e) {
    console.warn("文本谱反复推理失败，按段数逐遍", e);
  }
  pd.measures = playOrderByVerses(main.length, Math.max(1, passes));
  pd.isSimpple = true;
  return pd;
}

/** `PlayPass` → `.Repeat` 的一条（小节 1 基 → 0 基；接入/收尾的元素 id → 小节内和弦序号）。 */
function specItem(p: PlayPass, idToChord: ReadonlyMap<ElementId, { measure: number; index: number }>): RepeatSpecItem {
  const from = p.fromElement !== undefined ? idToChord.get(p.fromElement) : undefined;
  const to = p.toElement !== undefined ? idToChord.get(p.toElement) : undefined;
  return new RepeatSpecItem(
    p.fromMeasure - 1,
    p.toMeasure - 1,
    p.verse ?? 0,
    from ? from.index : 0,
    p.pageBreakAfter ?? false,
    to ? to.index + 1 : -1,
  );
}

/** 跳转记号 → 演唱顺序的跳转表。 */
function applyJumps(pd: PlayData, measures: readonly MeasureOut[], jumps: readonly JumpOut[]): void {
  const count = measures.length;
  const end = (mid: number): TimePosition => new TimePosition(mid, measures[mid]!.duration);
  const target = (j: JumpOut): TimePosition =>
    j.onBarline && j.measure + 1 < count
      ? new TimePosition(j.measure + 1, new Fraction(0))
      : new TimePosition(j.measure, new Fraction(0));
  const codas = jumps.filter((j) => j.name === "ty");
  for (const j of jumps) {
    switch (j.name) {
      case "dc":
        pd.jumpTo.set(end(j.measure), new JumpSpec(PlaySpecKind.Dacapo));
        break;
      case "fine":
        pd.jumpTo.set(end(j.measure), new JumpSpec(PlaySpecKind.Fine));
        break;
      case "ds": {
        const s = new JumpSpec(PlaySpecKind.DalSegno);
        s.value = "1";
        pd.jumpTo.set(end(j.measure), s);
        break;
      }
      case "hs":
        pd.segno.set("1", target(j));
        break;
      case "ty":
        // 两处尾声记号：前一处是 To Coda，后一处是尾声的起点；只有一处就只当起点
        if (codas.length >= 2 && j === codas[0]) {
          const s = new JumpSpec(PlaySpecKind.ToCoda);
          s.value = "1";
          pd.jumpTo.set(end(j.measure), s);
        } else {
          pd.coda.set("1", target(j));
        }
        break;
    }
  }
}

/** `.jpwabc` 写出端的输入（`model/tojpw.ts::JpwScoreIn`），**口径同 `jianpuInputOfDoc`**（非展开档那一份）：
 *  第一个有曲行的声部；小节线条目与行末换行按原次序；标题/credit 同 `songToScore`。这首没有曲行时返回 null。 */
export function jpwInputOfSong(doc: ScoreDoc, songIdx = 0): JpwScoreIn | null {
  const built = songMeasures(doc, songIdx, {}, false);
  if (!built) return null;
  const playData = foldToFirstPart(playDataOf(doc, songIdx, built), built);
  const meta = built.song.metadata;
  for (const tempo of meta.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      playData.tempo = tempo;
      break;
    }
  }
  const credit: { type: string | null; page: number; text: string }[] = [];
  const push = (text: string, type: string | null): void => {
    if (text) credit.push({ type, text, page: 0 });
  };
  meta.titles.forEach((t, i) => push(t, i === 0 ? "title" : "subtitle"));
  // 作者条目照原文分行（`.jpwabc` 的 `WordsByAndMusicBy` 一条多行，行视图已取 credit 原文，见 `jianpu/slots.ts::toMetadata`）
  for (const a of meta.authors) push(a, "composer");
  for (const t of meta.topRight) push(t, "composer");
  for (const t of meta.topLeft) push(t, "lyricist");

  const key = { fifths: built.key.fifths, name: built.key.name };
  // 换页：换行之后紧跟的那个音是换页的行首（`breaks.ts::breaksOf`，小节级与小节中间的都在里面）
  const pageStarts = new Set(breaksOf(doc.songs[songIdx]!).filter((b) => b.page).map((b) => b.id));
  const seq = built.parts[0]!.flatMap((m) => m.seq);
  const pageAfter = new Set<number>(); // `seq` 里第几项是换页
  seq.forEach((it, i) => {
    if (it !== "break") return;
    const next = seq.slice(i + 1).find((x) => typeof x !== "string");
    if (typeof next === "object" && next.id !== undefined && pageStarts.has(next.id)) pageAfter.add(i);
  });
  let at = 0;
  const measures: JpwMeasureIn[] = built.parts[0]!.map((m) => {
    let chords = 0;
    const entries = m.seq.map((it): object => {
      if (it === "break") return { newPage: pageAfter.has(at++), pass: null };
      at++;
      if (it === "barline") return { style: null, repeat: null, position: new Fraction(chords > 0 ? 1 : 0) };
      chords++;
      const n = it.notes[0]!;
      const chord: JpwChordIn = {
        notes: [{
          number: n.number, jpOctave: n.jpOctave, jpAlter: n.jpAlter,
          tieStart: n.tieStart, tieEnd: n.tieEnd, tupletBegin: it.tupletBegin, tupletEnd: it.tupletEnd,
          lyrics: n.lyrics,
        }],
        rest: it.rest,
        dot: it.dot,
        beats: it.beats,
        beams: it.beams,
        slurStart: it.slurStart,
        slurEnds: it.slurEnds,
        fermata: it.fermata,
        graceNotes: [],
      };
      return chord;
    });
    return {
      entries,
      newSystem: false,
      newPage: false,
      repeatForward: m.repeatForward,
      repeatBackward: m.repeatBackward,
      endingLeft: m.endingLeft,
      endingNum: m.endingNum,
      timeChange: false,
      keyChange: false,
      time: built.time,
      key,
      barline: m.barline,
    };
  });
  return { title: meta.titles[0] ?? "", credit, parts: [{ measures }], playData };
}
