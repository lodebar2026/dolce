// 混排会话：五线谱 / 混排档读的那份模型（`mixedDoc`）与它的派生——由源文派生或读 `.musicxml`、
// 和弦 id 与源模型的两向对照、乐句档的五线谱行首。
//
// 从 `app.ts` 原样搬出来的一块（照 `PlaybackController` / `OmrController` 的做法）：排版铺页
// （`App._renderMixedPages` / `_layoutStaff`）与模式切换仍在 App，这里只管模型，经 `MixedHost` 向 App 要设置。

import type { ElementId, ScoreDoc } from "../model/doc";
import type { MetaData } from "../smufl/smufl";
import type { JChord } from "../layout/input";
import { staffOptionsOf } from "../layout/painter";
import { phraseCuts, type FitMeasure } from "../pu/phrase";
import { layoutStaff } from "../mixed/layout";
import { staffChordSpans } from "../mixed/layoutpass";
import { scoreDocToMusicXml } from "../model/toxml";
import { musicXmlFormat, type DocFormatId } from "./formats";
import { t } from "../i18n";
import type { App } from "./app";

/** 混排会话向 App 要的那些能力（**列全**）。类型照 App 的取，免得两边各写一份。 */
export interface MixedHost {
  readonly meta: MetaData;
  readonly docFormat: DocFormatId;
  readonly layoutMode: App["layoutMode"];
  readonly jpPaper: App["jpPaper"];
  readonly puPaper: App["puPaper"];
  readonly fontSize: App["fontSize"];
  readonly layoutPage: App["layoutPage"];
  readonly phraseOn: boolean;
  readonly staffPaper: string;
  readonly staffPage: App["staffPage"];
  staffStyle(): ReturnType<App["staffStyle"]>;
  getText(): string;
  setStatus(s: string): void;
  /** 五线谱 / 混排档可不可用（按钮显隐） */
  _setMixedAvailable(available: boolean): void;
  /** 当前源文投成不带版面坐标的 MusicXML，带源元素 id */
  mixedSourceXml(): string;
}

export class MixedSession {
  constructor(private host: MixedHost) {}

  /** 五线谱/混排档读的模型（MusicXML 形状）；null = 还没有（或读不出）五线谱视图。
   *  `.musicxml`：底本原文在 `mixedDoc.source`，混排档导出 MusicXML 原样给出（`export.ts::buildMusicXml`）；
   *  文本格式：进五线谱时由源文派生（`_ensureMixedDoc`），`_mixedDerivedText` 记它由哪份源文与哪套简谱设置来（`_mixedDeriveKey`）。 */
  mixedDoc: ScoreDoc | null = null;
  _mixedDerivedText: string | null = null;
  /** 派生五线谱（`mixedDoc`）的和弦 id ↔ 源模型的和弦 id（`_indexMixedSrcIds`）。`.musicxml` 为空。 */
  _mixedToSrc = new Map<ElementId, ElementId>();
  _srcToMixed = new Map<ElementId, ElementId[]>();
  /** `.musicxml` 五线谱档那份模型是按哪份原文读的（原文变了才重读）。 */
  _mixedXmlText: string | null = null;
  /** 派生五线谱里各和弦在第几小节（全曲下标）：五线谱上的小节线按小节认（`mixed/prims.ts::StaffLeafData`）。 */
  _mixedMeasureOf = new Map<ElementId, number>();

  /**
   * 乐句档的五线谱行首：同一套断句（`pu/phrase.ts::phraseCuts`），**尺子换成五线谱引擎**——
   * 不带换行投一份、按当前五线谱纸与样式排一遍，量各和弦的自然跨度（`mixed/layoutpass.ts::staffChordSpans`）。
   * 小节中间的断点也要（`midLineStarts`：拆小节、中间隐藏线）；分页交给五线谱自己，`PhraseCut.page` 不用。
   * `doc` 须与投影的那份同一个（`sourceMusicXmlBare` 里那份），元素 id 才对得上。量不出来返回 null，调用方退回简谱行首。
   */
  staffPhraseLineStarts(doc: ScoreDoc): ReadonlySet<ElementId> | null {
    try {
      const bare = musicXmlFormat.toScoreDoc(scoreDocToMusicXml(doc, { sourceIds: true }));
      const options = staffOptionsOf(this.host.meta, this.host.staffStyle());
      options.page = this.host.staffPage;
      const { width, byId } = staffChordSpans(layoutStaff(bare, options));
      if (byId.size === 0) return null;
      const measure: FitMeasure = (score) => {
        const spans = new Map<JChord, { x0: number; x1: number }>();
        for (const part of score.parts) {
          for (const m of part.measures) {
            for (const e of m.entries) {
              const sp = e.kind === "chord" && e.id !== null ? byId.get(e.id) : undefined;
              if (sp) spans.set(e as JChord, sp);
            }
          }
        }
        return { width, spans };
      };
      const cuts = phraseCuts(doc, 0, { measure });
      if (!cuts) return null;
      return new Set(cuts.flatMap((c) => (c.id === null ? [] : [c.id])));
    } catch (e) {
      console.warn("五线谱按乐句断句失败，按简谱行首", e);
      return null;
    }
  }

  /** 派生五线谱要看的设置：简谱的档、纸、字号变了，断点跟着变，得重新派生。 */
  _mixedDeriveKey(): string {
    const pg = this.host.layoutPage;
    // 乐句档五线谱自己量宽断句，五线谱的纸与样式也进键
    const staff = this.host.phraseOn ? ["phrase", this.host.staffPaper, JSON.stringify(this.host.staffStyle())] : [];
    return [this.host.getText(), this.host.layoutMode, this.host.jpPaper, this.host.puPaper, this.host.fontSize, pg.w, pg.h, ...staff].join("\u0000");
  }

  /** 五线谱/混排档的模型备好了没有。`.musicxml` 就是打开时读的那份；文本格式把**当前源文**经
   *  唯一写出端投成 MusicXML（`export.ts::sourceMusicXmlBare`，与导出 MusicXML 同一条路、只是不补版面坐标）
   *  再读回——混排排版器只吃 MusicXML 形状。源文没变不重做。 */
  _ensureMixedDoc(): boolean {
    if (this.host.docFormat === "musicxml") return this.mixedDoc !== null;
    const key = this._mixedDeriveKey();
    if (this.mixedDoc && this._mixedDerivedText === key) return true;
    try {
      this.mixedDoc = musicXmlFormat.toScoreDoc(this.host.mixedSourceXml());
      this._mixedDerivedText = key;
      this._indexMixedSrcIds(this.mixedDoc);
      return true;
    } catch (e) {
      console.error("转五线谱失败", e);
      this.host.setStatus(t("status.staffFailed", { error: (e instanceof Error ? e.message : String(e)) }));
      return false;
    }
  }

  /** 派生五线谱模型里各和弦的源 id（`Chord.srcId`）两向对照：五线谱点音符 → 代码区，代码区光标 → 五线谱。 */
  _indexMixedSrcIds(doc: ScoreDoc): void {
    this._mixedToSrc.clear();
    this._srcToMixed.clear();
    this._mixedMeasureOf.clear();
    for (const song of doc.songs) {
      for (const part of song.parts) {
        for (const [mi, m] of part.measures.entries()) {
          for (const el of m.elements) {
            if (el.kind !== "chord") continue;
            this._mixedMeasureOf.set(el.id, mi);
            if (el.srcId === undefined) continue;
            this._mixedToSrc.set(el.id, el.srcId);
            const list = this._srcToMixed.get(el.srcId);
            if (list) list.push(el.id);
            else this._srcToMixed.set(el.srcId, [el.id]);
          }
        }
      }
    }
  }

  /** FormatHost：`.jpwabc` 解析 → 排版 → 渲染。 */
  /** 五线谱/混排档的模型：MusicXML 读成 `ScoreDoc`（与简谱档那份分开读——那份会被投影、断句层补字段，混排只读原样的）。
   *  读不出来时置空并提示，返回 false。 */
  _setMixedXml(xml: string): boolean {
    this._mixedDerivedText = null;
    try {
      this.mixedDoc = musicXmlFormat.toScoreDoc(xml);
      this._mixedXmlText = xml;
      this._indexMixedSrcIds(this.mixedDoc); // 小节线按小节认（`_mixedMeasureOf`）
      return true;
    } catch (e) {
      this.mixedDoc = null;
      console.error("MusicXML 读取失败", e);
      this.host.setStatus(t("status.xmlReadFailed", { error: (e instanceof Error ? e.message : String(e)) }));
      return false;
    }
  }

  /** 丢掉五线谱/混排档的模型与排版器（换文档/换格式时）。 */
  _dropMixedDoc(): void {
    this.mixedDoc = null;
    this._mixedDerivedText = null;
    this._mixedToSrc.clear();
    this._srcToMixed.clear();
    this.host._setMixedAvailable(false);
  }
}
