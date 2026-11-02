// 「打开的文件 → 排版请求」这一段的纯函数：编辑器（`App`）与无头排版会话（`editor/headless.ts`，Node 回归与出图）共用，
// 两边排出来的谱才是同一份。这里不碰 DOM、不碰编辑器状态——要的都由调用方传进来。

import type { ScoreDoc } from "../model/doc";
import type { StyleSheet } from "../style/sheet";
import type { JianpuLayoutMode } from "../jianpu/profile";
import { ScorePainter, type PaintResources, type StaffPaintRequest, type SyncPaintRequest } from "../layout/painter";
import { is123File, isFanqieFile, isJcxFile, isJlyFile } from "../common/filetypes";
import { parseXml } from "../score/xmltree";
import { docView } from "../jianpu/slots";
import { voiceNumbers } from "../jianpu/ast";
import { withLyricsFrom, withMelodyFirst, withVisibleParts } from "../model/parts";
import type { DocFormatId } from "./formats";
import { t } from "../i18n";

/** 按文件名认源格式（打开文件时用；识别项目由调用方先认掉）。认不出的一律当 `.jpwabc`。 */
export function docFormatOfName(name: string): DocFormatId {
  if (/\.abc$/i.test(name)) return "abc";
  if (is123File(name)) return "123";
  // jianpu-ly 只看扩展名（上游输入里没有版本行、签名，内容嗅探只能靠猜）
  if (isJlyFile(name)) return "jly";
  if (isJcxFile(name)) return "jcx";
  if (isFanqieFile(name)) return "fanqie";
  if (/\.(xml|musicxml)$/i.test(name)) return "musicxml";
  return "jpwabc";
}

/** 判断 MusicXML 是否多声部（≥2 part、单 part 多谱表、或 ≥2 voice）→ 默认混排。 */
export function isMultiPartXml(xml: string): boolean {
  try {
    const doc = parseXml(xml);
    if (doc.getElementsByTagName("score-part").length >= 2) return true;
    for (const s of doc.getElementsByTagName("staves")) {
      if (parseInt(s.textContent ?? "1", 10) >= 2) return true;
    }
    const voices = new Set<string>();
    for (const v of doc.getElementsByTagName("voice")) {
      const t = v.textContent.trim();
      if (t) voices.add(t);
    }
    return voices.size >= 2;
  } catch {
    return false;
  }
}

/** 这份文档有没有可排的曲行（首曲至少一行）。 */
export function hasLines(doc: ScoreDoc): boolean {
  return docView(doc).songs[0]?.pages.some((p) => p.groups.length > 0) ?? false;
}

/** 首曲只有一条旋律（单声部）。 */
export function singleVoice(doc: ScoreDoc): boolean {
  const song = docView(doc).songs[0];
  return song !== undefined && voiceNumbers(song).length === 1;
}

/** 简谱两档排版要的那份源：`.jpwabc` 是排版器那份模型加分页描述，其余是解析出的 `ScoreDoc`。 */
export interface JianpuSource {
  format: DocFormatId;
  doc: ScoreDoc;
  /** `.jpwabc` 的 `.Layout` 分页描述 */
  breakDesc?: string | null;
  /** MusicXML：旋律声部与歌词来源（声部面板） */
  melodyPart?: number;
  lyricPart?: number | null;
}

/** 投影档排的那份文档：MusicXML 按声部面板换旋律声部与歌词来源（元素 id 不变）。 */
export function expandedDocOf(src: JianpuSource): ScoreDoc {
  if (src.format !== "musicxml") return src.doc;
  const melody = src.melodyPart ?? 0;
  const lyr = src.lyricPart !== null && src.lyricPart !== undefined ? withLyricsFrom(src.doc, src.lyricPart, melody) : src.doc;
  return withMelodyFirst(lyr, melody);
}

/** 简谱两档（简谱 / 投影）的排版请求。投影档没有曲行时返回 null。 */
export function jianpuPaintRequest(src: JianpuSource, mode: JianpuLayoutMode, style: StyleSheet): SyncPaintRequest | null {
  if (src.format === "jpwabc") return { view: mode, doc: src.doc, style, breakDesc: src.breakDesc ?? null };
  if (mode === "expanded") return hasLines(src.doc) ? { view: "expanded", doc: expandedDocOf(src), style } : null;
  return { view: "original", doc: src.doc, style };
}

/**
 * 量「简谱视图此刻会排出的各行首音」要排的那一份（五线谱自动铺排拿行首当优选断点，`xmlproject.ts::applyLineStarts`）。
 * 文本谱、MusicXML 与多声部的简谱档返回 null：那一路一行就是 `ScoreDoc` 里的一行，不用另给。
 */
export function lineStartsRequest(src: JianpuSource, mode: JianpuLayoutMode, styleOf: (m: JianpuLayoutMode) => StyleSheet): SyncPaintRequest | null {
  if (src.format === "jpwabc") return jianpuPaintRequest(src, mode, styleOf(mode));
  if (mode === "expanded") return jianpuPaintRequest(src, "expanded", styleOf("expanded"));
  if (src.format === "fanqie" || src.format === "musicxml" || !singleVoice(src.doc)) return null;
  return { view: "original", doc: src.doc, style: styleOf("original") };
}

/** 另造一个排版器排一遍，取各行首音（和弦 id）。 */
export function jianpuLineStarts(resources: PaintResources, req: SyncPaintRequest): ReadonlySet<number> {
  const p = new ScorePainter(resources);
  p.loadSync(req);
  return new Set(p.result?.jianpuLineStarts ?? []);
}

/** 五线谱 / 混排档的排版请求要的设置。 */
export interface StaffRequestOpts {
  /** 叠不叠简谱层（混排 / 五线谱） */
  jianpuLayer: boolean;
  style: StyleSheet;
  page: StaffPaintRequest["page"];
  hideBarNumber: boolean;
  /** 声部面板里藏起来的声部（会话内） */
  hiddenParts?: ReadonlySet<number>;
  melodyPart?: number;
  /** ABC 的代码换行与 `%%newpage` 就是谱面换行换页（§6.1）：五线谱照它分，不另按宽度重排（issue 24） */
  sourceBreaks: boolean;
}

/** 混排底本剔掉声部面板里藏起来的声部（屏幕铺页那份）。 */
export function visibleStaffDoc(mixedDoc: ScoreDoc, hiddenParts: ReadonlySet<number>): ScoreDoc {
  return withVisibleParts(mixedDoc, hiddenParts);
}

/** 五线谱 / 混排档的排版请求。`doc` 原样排（屏幕铺页那份先过 `visibleStaffDoc`）。 */
export function staffPaintRequest(doc: ScoreDoc, o: StaffRequestOpts): StaffPaintRequest {
  const hidden = o.hiddenParts ?? new Set<number>();
  const melody = o.melodyPart ?? 0;
  return {
    view: o.jianpuLayer ? "mixed" : "staff",
    doc,
    style: o.style,
    page: o.page,
    hideBarNumber: o.hideBarNumber,
    // 简谱层取的声部下标跟着藏起来的声部往前挪
    jianpuPart: hidden.has(melody) ? 0 : melody - [...hidden].filter((i) => i < melody).length,
    sourceBreaks: o.sourceBreaks,
  };
}

/** `pptxPainter` 向编辑器要的那几样（`App` 与无头排版会话都有）。 */
export interface PptxHost {
  readonly painter: ScorePainter;
  readonly mode: string;
  expandedRequest(): SyncPaintRequest | null;
}

/** 按投影档另排一份（导出 PPTX）。屏幕已在投影档时直接用屏幕那个，省一次排版。
 *  **设置取投影档那一套**（`expandedRequest` 按 `styleOf("expanded")`），不是屏幕上简谱档的那套——
 *  否则导出的投影片会带着简谱档的字号与颜色。 */
export function pptxPainter(app: PptxHost): ScorePainter {
  const cur = app.painter;
  // 识别模式里屏幕上那个排版器不随改动重排（谱面区是核对视图），只有简谱档的才能直接用
  if (app.mode === "jp" && cur.renderer === "jianpu" && cur.jianpuView === "expanded") return cur;
  const req = app.expandedRequest();
  if (!req) throw new Error(t("export.noFanqieLines"));
  const p = new ScorePainter(cur.resources);
  p.loadSync(req);
  return p;
}
