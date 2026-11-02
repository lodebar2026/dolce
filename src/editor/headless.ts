// 无头排版会话：不起浏览器、不建编辑器，把一个文件按编辑器同一条路排成谱页（Node 回归与出图，`cli/engrave.ts`）。
// 认格式、简谱两档与五线谱/混排的排版请求都走 `paintreq.ts`（App 也走它），样式走同一个 `StyleState`，
// 所以排出来的就是编辑器里那份谱。编辑器才有的东西（识别会话、声部面板、按乐句重排、可视化编辑）这里没有，按缺省。
//
// 用法（与回归脚本以前在页面里调的 `__app` 一一对应）：
//   const s = new HeadlessSession(meta);
//   s.load(bytes, "x.musicxml");          // importBytes
//   s.applyRenderSettings({ jpPaper });   // applyRenderSettings
//   await s.setViewMode("original");      // setViewMode：排好
//   s.pages()                             // 各页 SVG（outerHTML）

import type { ScoreDoc } from "../model/doc";
import type { JianpuLayoutMode } from "../jianpu/profile";
import { MetaData } from "../smufl/smufl";
import { PaintResources, ScorePainter, type SyncPaintRequest } from "../layout/painter";
import { scoreDocToMusicXml } from "../model/toxml";
import { carryPlayOrder } from "../model/sections";
import { normalizeEol } from "../common/lines";
import { sniffDialect } from "../fanqie";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { jpwToScoreDoc } from "../model/fromjpw";
import { formatOf, musicXmlFormat, type DocFormatId, type FormatAdapter } from "./formats";
import { StyleState, type RenderSettings, type StyleStateHost } from "./stylestate";
import {
  docFormatOfName, hasLines, isMultiPartXml, jianpuLineStarts, jianpuPaintRequest, lineStartsRequest, staffPaintRequest, visibleStaffDoc,
  type JianpuSource,
} from "./paintreq";

/** 编辑器的四档（`App.ViewMode`）。 */
export type HeadlessView = "expanded" | "original" | "staff" | "mixed";

export class HeadlessSession implements StyleStateHost {
  readonly painter: ScorePainter;
  readonly style: StyleState;
  docFormat: DocFormatId = "jpwabc";
  filePath: string | null = null;
  mode: "jp" | "mixed" = "jp";
  /** 简谱两档里当前那档（编辑器出厂是投影档） */
  layoutMode: JianpuLayoutMode = "expanded";
  /** 五线谱档叠不叠简谱层（混排 / 五线谱） */
  jianpuLayer = true;
  hideBarNumber = false;
  /** 最近一条状态栏提示（读入、排版失败时看它） */
  status = "";
  private text = "";
  private scoreDoc: { text: string; doc: ScoreDoc } | null = null;
  private jpw: { text: string; doc: ScoreDoc; breakDesc: string | null } | null = null;
  private mixedDoc: ScoreDoc | null = null;

  constructor(readonly meta: MetaData) {
    this.painter = new ScorePainter(PaintResources.fixed(meta));
    this.style = new StyleState(this);
  }

  // ---- StyleStateHost ----
  get adapter(): FormatAdapter {
    return formatOf(this.docFormat);
  }
  currentScoreDoc(): ScoreDoc | null {
    const toScoreDoc = this.adapter.toScoreDoc;
    if (!toScoreDoc) return null;
    if (this.scoreDoc?.text === this.text) return this.scoreDoc.doc;
    try {
      const doc = toScoreDoc(this.text);
      this.scoreDoc = { text: this.text, doc };
      return doc;
    } catch {
      return null;
    }
  }
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
  }
  setStatus(text: string): void {
    this.status = text;
  }
  saveSettings(): void {}
  rerender(): void {}

  /** 打开一个文件（同 `App.importBytes` 认格式、解码；MusicXML 多声部默认进混排）。读不了抛错。 */
  load(bytes: Uint8Array, name: string): void {
    const fmt = docFormatOfName(name);
    const text = formatOf(fmt).decode(bytes);
    if (fmt === "fanqie") {
      const sniffed = sniffDialect(text);
      if (sniffed.dialect === null) throw new Error(`不是文本谱：${sniffed.reason}`);
    }
    this.docFormat = fmt;
    this.filePath = name;
    this.scoreDoc = null;
    this.jpw = null;
    this.mixedDoc = null;
    if (fmt === "musicxml") {
      const xml = normalizeEol(text);
      this.mixedDoc = musicXmlFormat.toScoreDoc(xml);
      if (isMultiPartXml(xml)) this.mode = "mixed";
      this.text = xml;
    } else {
      this.text = text;
    }
  }

  applyRenderSettings(opts: RenderSettings): void {
    this.style.apply(opts);
  }

  /** `.jpwabc` 那份排版用的模型与分页描述（同 `App.reloadJpwabc`）。 */
  private jpwSource(): { doc: ScoreDoc; breakDesc: string | null } | null {
    if (this.jpw?.text === this.text) return this.jpw;
    const f = JpwFile.fromString(this.text);
    if (!f) return null;
    const doc = jpwToScoreDoc(f);
    this.jpw = { text: this.text, doc, breakDesc: f.getSection(LayoutSection)?.desc ?? null };
    return this.jpw;
  }

  private jianpuSource(): JianpuSource | null {
    if (this.docFormat === "jpwabc") {
      const j = this.jpwSource();
      return j ? { format: "jpwabc", doc: j.doc, breakDesc: j.breakDesc } : null;
    }
    const doc = this.currentScoreDoc();
    return doc ? { format: this.docFormat, doc } : null;
  }

  /** 投影档的排版请求（`pptxPainter` 另排用，同 `App.expandedRequest`）。 */
  expandedRequest(): SyncPaintRequest | null {
    const src = this.jianpuSource();
    return src && hasLines(src.doc) ? jianpuPaintRequest(src, "expanded", this.style.styleOf("expanded")) : null;
  }

  /** 简谱当前档的排版请求（导出、PPTX 另排用）。 */
  jianpuRequest(mode: JianpuLayoutMode = this.layoutMode): SyncPaintRequest | null {
    const src = this.jianpuSource();
    return src ? jianpuPaintRequest(src, mode, this.style.styleOf(mode)) : null;
  }

  /** 五线谱/混排的底本：`.musicxml` 是打开时读的那份；文本格式把源文经唯一写出端投成 MusicXML 再读回
   *  （同 `MixedSession._ensureMixedDoc` + `export.ts::sourceMusicXmlBare`，行首按简谱视图排出的行）。 */
  private ensureMixedDoc(): ScoreDoc {
    if (this.mixedDoc) return this.mixedDoc;
    const src = this.jianpuSource();
    if (!src) throw new Error("没有可排的文档");
    const req = this.docFormat === "abc" ? null : lineStartsRequest(src, this.layoutMode, (m) => this.style.styleOf(m));
    const lineStarts = req ? jianpuLineStarts(this.painter.resources, req) : null;
    const doc = musicXmlFormat.toScoreDoc(scoreDocToMusicXml(src.doc, { lineStarts, midLineStarts: false, sourceIds: true }));
    carryPlayOrder(src.doc, doc);
    this.mixedDoc = doc;
    return doc;
  }

  /** 切档并排好（同 `App.setViewMode`）。 */
  async setViewMode(view: HeadlessView): Promise<void> {
    if (view === "staff" || view === "mixed") {
      this.mode = "mixed";
      this.jianpuLayer = view === "mixed";
      // 文本格式的底本随简谱档的纸、字号变：每次切档重新派生
      if (this.docFormat !== "musicxml") this.mixedDoc = null;
      const doc = this.ensureMixedDoc();
      const req = staffPaintRequest(visibleStaffDoc(doc, new Set()), {
        jianpuLayer: this.jianpuLayer,
        style: this.style.staffStyle(),
        page: this.style.staffPage,
        hideBarNumber: this.hideBarNumber,
        sourceBreaks: this.docFormat === "abc",
      });
      await this.painter.load(req);
      return;
    }
    this.mode = "jp";
    this.layoutMode = view;
    const req = this.jianpuRequest(view);
    if (!req) throw new Error("没有可排的曲行");
    this.painter.loadSync(req);
  }

  get pageCount(): number {
    return this.painter.pageCount;
  }

  /** 各页 SVG（`outerHTML`，同浏览器里铺到页面上的那份 `<svg>`）。 */
  pages(): string[] {
    const out: string[] = [];
    for (let k = 0; k < this.painter.pageCount; k++) out.push((this.painter.renderPage(k) as unknown as { outerHTML: string }).outerHTML);
    return out;
  }
}
