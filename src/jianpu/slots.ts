// `ScoreDoc` → **排版行视图**：文本谱排版器、简谱输入模型（投影档）、双向定位共用的那一份铺排。
//
// 文本谱「简谱」档不自动断行：一个系统就是一行，行内按符号逐个步进、记号按行内区间画。
// 所以排版先把 `ScoreDoc`（声部 → 小节 → 元素，id 配对）**线性化成一行一行的符号流**：
//
// - 行内顺序：夹层（`before`）→ 主音 / 承接前音的增时线 → 各增时线（带各自夹层）→ 有样式的右小节线（带夹层）→ 行末夹层；
//   倚音折进宿主音符；左小节线不出现（它的信息由前一小节右线与房号承载）。
// - 行里每个符号都带 `refs[i]`：它的 `ElementId` 与引用的 `ScoreDoc` 对象。播放高亮、双向定位一律按 id 认。
// - 跨行记号按行切段（续接标记、续行 level）、房号由 `Barline.ending` 还原成行内区间、歌词按行级版式铺回。
//
// 铺排在 Rust（`crates/model/src/view/slots.rs`，wasm `modelDocView`）：回来的是 id 化的视图——`refs` 存下标
// （小节在投影后声部里第几个、元素第几个、增时线 / 小节线第几条），投影改过曲子（MusicXML 形状、多小节休止）的另带投影后那份 `song`。
// 这里只把下标认回对象、建 `idOf` / `elementOf` / `syllableOwner` 三张表。没投影的曲子 `refs` 直接指 `doc.songs[i]` 里的对象。
// 双向定位索引的条目（`crates/model/src/view/sync.rs`）同一趟带回，存在 `sync`（`editor/sync.ts::SyncIndex.build` 取用）。
//
// 视图里符号的形状沿用 `jianpu/ast.ts` 的元素类型（排版器与导出的几何代码按这些字段写成，原样复用）。

import type { LyricSyllable, Metadata, MusicElement, FanqieSong, ScoreLine, ScorePage, VoiceGroup } from "./ast";
import type { Barline, Chord, ElementId, Measure, Part, ScoreDoc, Song, Space, Sustain } from "../model/doc";
import { dolce } from "../common/dolce";
import { call } from "../model/rustdoc";

/** 行里一个符号的来源。 */
export interface SlotRef {
  /** 元素 id（音符和弦、承接增时线的和弦、增时线、`Space`）；小节线与夹层没有 */
  id?: ElementId;
  chord?: Chord;
  space?: Space;
  sustain?: Sustain;
  barline?: Barline;
  measure: Measure;
}

/** 一行（一个声部在一个系统里的那一段）。形状同 `ScoreLine`，另带来源。 */
export interface RowView extends ScoreLine {
  part: Part;
  measures: Measure[];
  /** 与 `elements` 平行 */
  refs: SlotRef[];
}

export interface SystemView extends VoiceGroup {
  /** 全曲第几个系统 */
  system: number;
  voices: RowView[];
}

export interface PageView extends ScorePage {
  groups: SystemView[];
}

export interface SongView extends FanqieSong {
  song: Song;
  pages: PageView[];
}

export interface DocView {
  doc: ScoreDoc;
  songs: SongView[];
  /** 行里的符号 → 它的 id（高亮、定位用） */
  idOf: Map<MusicElement, ElementId>;
  /** id → 行里的符号（一个 id 只对应一个符号） */
  elementOf: Map<ElementId, MusicElement>;
  /** 歌词音节 → 它跟的那个符号的 id */
  syllableOwner: Map<LyricSyllable, ElementId>;
  /** 双向定位索引的条目与换行符（形状见 `editor/sync.ts` 的 `SyncEntry` / `BreakMark`），按推入次序 */
  sync: { entries: object[]; breaks: object[] };
}

/** Rust 回来的形状（`dolce_model::view::slots::DocView`） */
interface WireRef {
  id?: number;
  m: number;
  e?: number;
  s?: number;
  b?: number;
}
interface WireRow extends ScoreLine {
  part: number;
  measures: number[];
  refs: WireRef[];
}
interface WireSong {
  index: number;
  metadata: Metadata;
  pages: { index: number; groups: { index: number; system: number; texts: VoiceGroup["texts"]; voices: WireRow[] }[] }[];
  song?: Song;
}

function slotRef(part: Part, w: WireRef): SlotRef {
  const measure = part.measures[w.m]!;
  const ref: SlotRef = { measure };
  if (w.id !== undefined) ref.id = w.id;
  if (w.e !== undefined) {
    const el = measure.elements[w.e]!;
    if (el.kind === "chord") {
      ref.chord = el;
      if (w.s !== undefined) ref.sustain = el.sustains![w.s]!;
    } else ref.space = el;
  }
  if (w.b !== undefined) ref.barline = measure.barlines![w.b]!;
  return ref;
}

const views = new WeakMap<ScoreDoc, DocView>();

/** 一份 `ScoreDoc` 的排版行视图。**同一份文档只建一次**：排版器、`jianpuInputOfDoc`、双向定位拿到的是同一批对象。 */
export function docView(doc: ScoreDoc): DocView {
  const hit = views.get(doc);
  if (hit) return hit;
  const wire = JSON.parse(call(() => dolce().modelDocView(JSON.stringify(doc), ""))) as { songs: WireSong[]; sync: DocView["sync"] };
  const view: DocView = { doc, songs: [], idOf: new Map(), elementOf: new Map(), syllableOwner: new Map(), sync: wire.sync };
  for (const [i, ws] of wire.songs.entries()) {
    const song = ws.song ?? doc.songs[i]!;
    const pages: PageView[] = ws.pages.map((pg) => ({
      index: pg.index,
      groups: pg.groups.map((g) => ({
        index: g.index,
        system: g.system,
        texts: g.texts,
        voices: g.voices.map(({ part: pi, measures, refs, ...line }) => {
          const part = song.parts[pi]!;
          return { ...line, part, measures: measures.map((k) => part.measures[k]!), refs: refs.map((r) => slotRef(part, r)) };
        }),
      })),
    }));
    view.songs.push({ index: ws.index, song, metadata: ws.metadata, pages });
  }
  for (const sv of view.songs) {
    for (const pg of sv.pages) {
      for (const g of pg.groups) {
        for (const row of g.voices) {
          row.elements.forEach((el, i) => {
            // 同一谱表的第二声部并成的块：块里的元素也登记（点选、高亮、原文定位靠它）
            if (el.kind === "inline-layer") {
              el.elements.forEach((sub, k) => {
                const sid = el.ids?.[k];
                if (sid === undefined || sid === null || sid < 0) return; // 补拍位的不可见休止是临时 id，模型里没有
                view.idOf.set(sub, sid);
                if (!view.elementOf.has(sid)) view.elementOf.set(sid, sub);
              });
            }
            const id = row.refs[i]!.id;
            if (id === undefined) return;
            view.idOf.set(el, id);
            if (!view.elementOf.has(id)) view.elementOf.set(id, el);
          });
          const anchors = row.elements.filter((el) => (el.kind === "note" || el.kind === "sustain") && el.lyricAnchor);
          for (const line of row.lyrics) {
            line.syllables.forEach((syl, k) => {
              const owner = anchors[k] && view.idOf.get(anchors[k]!);
              if (owner !== undefined) view.syllableOwner.set(syl, owner);
            });
          }
        }
      }
    }
  }
  views.set(doc, view);
  return view;
}
