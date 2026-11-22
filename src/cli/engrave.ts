// Node CLI 侧的排版入口：不起浏览器，把文件排成谱页（SVG 字符串）。排版在 dolce-wasm（Rust），这里只装宿主。
// 由 `npm run build:cli` 打成 out/cli/engrave.js，供 ../dev/scripts 里的排版回归与出图脚本 import。
//
// 装配（import 本模块即生效）：
//   - 量字：`textmeasure.node.ts`（原生模块 `native/textmeasure`，系统文字引擎 + Rust 浏览器口径层，`npm run build:native`）；
//   - SMuFL 元数据：读 `public/redist/bravura_metadata.json`。
import "./dolcewasm.node"; // 演唱顺序、断句、时间轴、MIDI、jcx 编解码、排版在 dolce-wasm
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordMeasure, setMeasureBackend, type MeasureRecord } from "../common/measure";
/** 量一串字的墨迹（基线 y = 0；page-check 这类按场景量几何的脚本用）。 */
export { measureGlyphText } from "../common/measure";
import { nodeMeasure } from "./textmeasure.node";
import { MetaData } from "../smufl/smufl";
import { PaintResources } from "../layout/painter";
import { installLayoutHost } from "../layout/rustlayout";

setMeasureBackend(nodeMeasure());

/** 缺省那份 SMuFL 元数据（全进程一份）。 */
const smuflText = readFileSync(fileURLToPath(new URL("../../public/redist/bravura_metadata.json", import.meta.url)), "utf8");
export const meta: MetaData = MetaData.fromJson(JSON.parse(smuflText));
MetaData.provide(meta);
// 排版在 dolce-wasm：量字回调上面装的 Node 后端（之后 `useFonts` 换后端也跟着换）
installLayoutHost(smuflText);

/** 量字走的是哪条路（只剩原生一条，留着给旧脚本打日志）。 */
export const measure = (): string => "native";

/** 同浏览器侧 `__paint`：统一排版器与出厂资源。 */
export const resources = PaintResources.fixed(meta);

/** 从此处起量字调用逐条录下（交 `dolce-dev measure-check` 对原生），返回取走已录条目的函数。 */
export function recordMeasureLog(files: Record<string, string> = {}): () => MeasureRecord[] {
  return recordMeasure(nodeMeasure(files));
}
export { pageScenes } from "../layout/scenejson";

/** 换测量后端的字体（成书注册的字体按族名给文件）：重新装配，之前的度量缓存作废。 */
export function useFonts(files: Record<string, string>): void {
  setMeasureBackend(nodeMeasure(files));
}

// ---- 与浏览器侧 `window.__*`（src/main.ts）一一对应的几组，脚本从页面里调的改成直接调 ----
import * as jianpuinput from "../jianpu/jianpuinput";
import * as fanqieMod from "../fanqie";
import * as fromxml from "../model/fromxml";
import { pptxPainter } from "../editor/paintreq";
import { pptxInput } from "../editor/pptxexport";
import * as xmllayout from "../editor/xmllayout";
import * as fromjpw from "../model/fromjpw";
import * as jpwfile from "../jpword/jpwfile";
import * as jpwparse from "../jpword/lex";

/** 同 `__pptx`：PPTX 拼料与投影档排版器。 */
export const pptx = { pptxPainter, pptxInput };
/** 同 `__fanqie`。 */
export const fanqie = fanqieMod;
/** 同 `__xmlout`。 */
export const xmlout = { ...xmllayout, ...jianpuinput, ...fromxml, ...fromjpw, ...jpwfile, ...jpwparse };

export { HeadlessSession, type HeadlessView } from "../editor/headless";
export { TsEngine } from "../engine/tsengine";
export { isStale, StaleRevision, EngineFailure } from "../engine/api";
export { ScorePainter, PaintResources } from "../layout/painter";
export { staffChordSpans } from "../layout/rustlayout";
export { outlinedSvg } from "./outline.node";
export { SAMPLE } from "../editor/sample";
export * from "./j123";
