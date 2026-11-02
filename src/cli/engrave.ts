// Node CLI 侧的排版入口：不起浏览器，把文件排成谱页（SVG 字符串）、页面树、DrawList。
// 由 `npm run build:cli` 打成 out/cli/engrave.js，供 ../dev/scripts 里的排版回归与出图脚本 import。
//
// 装配（import 本模块即生效）：
//   - 测量后端：`textmeasure.node.ts`（macOS CoreText / Windows DirectWrite 原生模块，没编就退回字体文件）；
//   - SVG 出口：`layout/svgnode.ts` 的轻量节点（`outerHTML` 同浏览器序列化）；
//   - SMuFL 元数据：读 `public/redist/bravura_metadata.json`。
// 排版件（依赖 common/measure.ts 的那些）只许经这个入口进 Node：别的 CLI 入口不装测量后端，碰了会抛「测量后端未装配」。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setMeasureBackend } from "../common/measure";
import { nodeMeasure, measureKind } from "./textmeasure.node";
import { setSvgDocument } from "../layout/render";
import { svgNodeDocument } from "../layout/svgnode";
import { MetaData } from "../smufl/smufl";
import { PaintResources, staffOptionsOf } from "../layout/painter";

setMeasureBackend(nodeMeasure());
setSvgDocument(svgNodeDocument);

/** 缺省那份 SMuFL 元数据（全进程一份）。 */
export const meta: MetaData = MetaData.fromJson(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../public/redist/bravura_metadata.json", import.meta.url)), "utf8")),
);
MetaData.provide(meta);

/** 量字走的是哪条路：`native`（系统文字引擎）或 `font`（字体文件）。 */
export const measure = (): string => measureKind;

/** 同浏览器侧 `__paint`：统一排版器与出厂资源。 */
export const resources = PaintResources.fixed(meta);
export const staffOptions = () => staffOptionsOf(meta);

/** 换测量后端的字体（成书注册的字体按族名给文件）：重新装配，之前的度量缓存作废。 */
export function useFonts(files: Record<string, string>): void {
  setMeasureBackend(nodeMeasure(files));
}

// ---- 与浏览器侧 `window.__*`（src/main.ts）一一对应的几组，脚本从页面里调的改成直接调 ----
import * as pdflayoutBrowser from "../pdflayout/browser";
import * as bookStyle from "../style/book";
import * as painterMod from "../layout/painter";
import * as phrase from "../score/phrase";
import * as applybreaks from "../jianpu/applybreaks";
import * as jpwfile from "../jpword/jpwfile";
import * as jpwparse from "../jpword/parse";
import * as jianpuinput from "../jianpu/jianpuinput";
import * as fanqieMod from "../fanqie";
import * as fromxml from "../model/fromxml";
import * as phrasedoc from "../model/phrasedoc";
import * as timeline from "../score/timeline";
import * as playdoc from "../model/playdoc";
import * as midi from "../score/midi";
import * as layoutInput from "../layout/input";
import * as songbookMod from "../pdflayout/songbook";
import * as ss from "../style/ss";
import * as pptxMod from "../editor/pptx";
import { pptxPainter } from "../editor/paintreq";
import * as xmllayout from "../editor/xmllayout";
import * as fromjpw from "../model/fromjpw";
import * as mixedModelMod from "../mixed/model";
import * as smufl from "../smufl/smufl";
import * as mixedLayout from "../mixed/layout";
import * as staffpages from "../mixed/staffpages";

pptxMod.provideBravuraOtf(readFileSync(fileURLToPath(new URL("../../public/redist/Bravura.otf", import.meta.url))).buffer as ArrayBuffer);

/** 同 `__book`：成书重排（BookStyle 注入 + 页面树 → DrawList）。 */
export const book = {
  ...pdflayoutBrowser, ...bookStyle, ...painterMod, ...phrase, ...applybreaks, ...jpwfile, ...jpwparse, ...jianpuinput, fanqie: fanqieMod,
  ...fromxml, ...phrasedoc, ...timeline, ...playdoc, ...midi, ...layoutInput,
};
/** 同 `__songbook`：混排歌本（清单 + .ss → DrawPage[]）。 */
export const songbook = { ...songbookMod, ...ss };
/** 同 `__pptx`：PPTX 序列化器与投影档排版器。 */
export const pptx = { ...pptxMod, pptxPainter };
/** 同 `__fanqie`。 */
export const fanqie = fanqieMod;
/** 同 `__xmlout`。 */
export const xmlout = { ...xmllayout, ...jianpuinput, ...fromxml, ...fromjpw, ...jpwfile, ...jpwparse };
/** 同 `__mixedModel`。 */
export const mixedModel = { ...mixedModelMod, GlyphCodes: smufl.GlyphCodes, MetaData: smufl.MetaData, ...mixedLayout, formatMixedScore: staffpages.formatMixedScore };

export { HeadlessSession, type HeadlessView } from "../editor/headless";
export { ScorePainter, PaintResources, staffOptionsOf } from "../layout/painter";
export { SvgNode } from "../layout/svgnode";
export { outlinedSvg } from "./outline.node";
export * from "./j123";
