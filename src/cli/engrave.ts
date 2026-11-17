// Node CLI 侧的排版入口：不起浏览器，把文件排成谱页（SVG 字符串）、页面树、DrawList。
// 由 `npm run build:cli` 打成 out/cli/engrave.js，供 ../dev/scripts 里的排版回归与出图脚本 import。
//
// 装配（import 本模块即生效）：
//   - 测量后端：`textmeasure.node.ts`（macOS CoreText / Windows DirectWrite 原生模块，没编就退回字体文件）；
//   - SVG 出口：`layout/svgnode.ts` 的轻量节点（`outerHTML` 同浏览器序列化）；
//   - SMuFL 元数据：读 `public/redist/bravura_metadata.json`。
// 排版件（依赖 common/measure.ts 的那些）只许经这个入口进 Node：别的 CLI 入口不装测量后端，碰了会抛「测量后端未装配」。
import "./dolcewasm.node"; // 演唱顺序、断句、时间轴、MIDI、jcx 编解码在 dolce-wasm
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setMeasureBackend } from "../common/measure";
import { nodeMeasure, measureKind } from "./textmeasure.node";
import { setSvgDocument } from "../layout/render";
import { svgNodeDocument } from "../layout/svgnode";
import { MetaData } from "../smufl/smufl";
import { PaintResources, staffOptionsOf } from "../layout/painter";
import { recordMeasure, type MeasureRecord } from "./layoutref";

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

/** 排版迁 Rust 的参考导出（dev `layout-ref.mjs`）：从此处起量字调用逐条录下，返回取走已录条目的函数。 */
export function recordMeasureLog(files: Record<string, string> = {}): () => MeasureRecord[] {
  return recordMeasure(nodeMeasure(files));
}
export { sceneNode, pageScenes, plainOf, jianpuRefs } from "./layoutref";

/** 换测量后端的字体（成书注册的字体按族名给文件）：重新装配，之前的度量缓存作废。 */
export function useFonts(files: Record<string, string>): void {
  setMeasureBackend(nodeMeasure(files));
}

// ---- 与浏览器侧 `window.__*`（src/main.ts）一一对应的几组，脚本从页面里调的改成直接调 ----
import * as pdflayoutBrowser from "../pdflayout/browser";
import * as bookStyle from "../style/book";
import * as painterMod from "../layout/painter";
import * as play from "../score/play";
import * as applybreaks from "../jianpu/applybreaks";
import * as jpwfile from "../jpword/jpwfile";
import * as jpwparse from "../jpword/lex";
import * as jianpuinput from "../jianpu/jianpuinput";
import * as fanqieMod from "../fanqie";
import * as fromxml from "../model/fromxml";
import * as playtypes from "../score/playtypes";
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
import * as styleJianpu from "../style/jianpu";
import * as styleHeader from "../style/header";
import * as stylePaper from "../style/paper";

pptxMod.provideBravuraOtf(readFileSync(fileURLToPath(new URL("../../public/redist/Bravura.otf", import.meta.url))).buffer as ArrayBuffer);

/** 同 `__book`：成书重排（BookStyle 注入 + 页面树 → DrawList）。 */
export const book = {
  ...pdflayoutBrowser, ...bookStyle, ...painterMod, ...play, ...applybreaks, ...jpwfile, ...jpwparse, ...jianpuinput, fanqie: fanqieMod,
  ...fromxml, ...playtypes, ...layoutInput,
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

/** 样式层的适配器（迁 Rust L1 对拍 `style-rs-diff.mjs` 用）：简谱尺子、页眉字体、纸与曲内层。 */
export const style = { ...styleJianpu, ...styleHeader, ...stylePaper };

export { HeadlessSession, type HeadlessView } from "../editor/headless";
export { TsEngine } from "../engine/tsengine";
export { isStale, StaleRevision, EngineFailure } from "../engine/api";
export { ScorePainter, PaintResources, staffOptionsOf } from "../layout/painter";
export { SvgNode } from "../layout/svgnode";
export { outlinedSvg } from "./outline.node";
export { SAMPLE } from "../editor/sample";
export * from "./j123";

// ---- 图元层迁 Rust（L2）的对拍 `engrave-rs-diff.mjs`：逐元素现算 ----
import * as elAccidental from "../engrave/accidental";
import * as elArc from "../engrave/arc";
import * as elArpeggio from "../engrave/arpeggio";
import * as elArticulation from "../engrave/articulation";
import * as elAugdot from "../engrave/augdot";
import * as elBarline from "../engrave/barline";
import * as elBeatgroup from "../engrave/beatgroup";
import * as elBreath from "../engrave/breath";
import * as elChord from "../engrave/chord";
import * as elDash from "../engrave/dash";
import * as elDot from "../engrave/dot";
import * as elDynamics from "../engrave/dynamics";
import * as elEnding from "../engrave/ending";
import * as elGrace from "../engrave/grace";
import * as elHairpin from "../engrave/hairpin";
import * as elHeader from "../engrave/header";
import * as elJpglyph from "../engrave/jpglyph";
import * as elJpnumber from "../engrave/jpnumber";
import * as elJpslide from "../engrave/jpslide";
import * as elJptremolo from "../engrave/jptremolo";
import * as elKeysig from "../engrave/keysig";
import * as elPrims from "../engrave/prims";
import * as elSectionword from "../engrave/sectionword";
import * as elStack from "../engrave/stack";
import * as elSyllable from "../engrave/syllable";
import * as elTimesig from "../engrave/timesig";
import * as elTuplet from "../engrave/tuplet";
import * as elUpperband from "../engrave/upperband";
import { Font as ElFont } from "../pagetree/font";
import { Point as ElPoint, Rect as ElRect } from "../common/geom";
import { Group as ElGroup } from "../pagetree/pageitem";

/** 图元层各模块与它们要的几个基础类。 */
export const els = {
  ...elAccidental, ...elArc, ...elArpeggio, ...elArticulation, ...elAugdot, ...elBarline, ...elBeatgroup, ...elBreath,
  ...elChord, ...elDash, ...elDot, ...elDynamics, ...elEnding, ...elGrace, ...elHairpin, ...elHeader, ...elJpglyph,
  ...elJpnumber, ...elJpslide, ...elJptremolo, ...elKeysig, ...elPrims, ...elSectionword, ...elStack, ...elSyllable,
  ...elTimesig, ...elTuplet, ...elUpperband,
  Font: ElFont, Point: ElPoint, Rect: ElRect, Group: ElGroup,
};
