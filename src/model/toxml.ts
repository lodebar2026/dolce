// MusicXML 写出（`ScoreDoc` → MusicXML 文本）：在 Rust（crates/dolce-model/src/toxml.rs），这里是门面。**MusicXML 的唯一写出端**：
// 简谱来源先经投影成 MusicXML 形状，MusicXML 读进来的原样序列化（表层按对象身份从原节点回填）。
// 写出端认得的属性 / 子节点之外，原节点其余的通用回填（`OWNS` 等判据见 Rust 那边）；导出时五线谱引擎排出来的版面（`layout`）显式写。

import type { ScoreDoc } from "./doc";
import type { ProjectOptions } from "./xmlproject";
import type { EngravedLayout } from "./xmlsurface";
import { dolce } from "../common/dolce";
import { call, docJson, ensureOid } from "./rustdoc";

export interface ToXmlOptions extends ProjectOptions {
  /** 取第几首（多曲文件、文本谱 `-----` 分曲）。默认第一首 */
  song?: number;
  /** 每个 `<note>` 带 `id="jp<源元素 id>"`：文本格式派生五线谱（`export.ts::sourceMusicXmlBare`）读回后，
   *  读入端把它记成 `Chord.srcId`，五线谱上点的音才对得回代码区。**只给这条内部路径用**，导出文件不带。 */
  sourceIds?: boolean;
  /** 导出版面（`editor/xmllayout.ts::engraveScoreDoc` 排出来的坐标、小节宽、系统间距、符干），键是本文档的模型对象 */
  layout?: EngravedLayout;
}

/** 导出版面过边界：键换成对象身份（没有身份的现发一个，`docJson` 会带上） */
function layoutWire(l: EngravedLayout): object {
  const pairs = <T>(m: Map<object, T>): [number, T][] => [...m].map(([k, v]) => [ensureOid(k), v]);
  return {
    ...(l.systemLayout ? { systemLayout: l.systemLayout } : {}),
    widths: pairs(l.widths), prints: pairs(l.prints), pos: pairs(l.pos), stems: pairs(l.stems), fontSize: pairs(l.fontSize),
  };
}

/** `ScoreDoc` → MusicXML 文本（含 XML 声明与 DOCTYPE）。没有那一首抛 `ModelError`（`err.noSong`）。 */
export function scoreDocToMusicXml(doc: ScoreDoc, options: ToXmlOptions = {}): string {
  // 版面先换成身份（要发新号的对象得在序列化模型之前登记）
  const layout = options.layout ? layoutWire(options.layout) : undefined;
  const { json, h } = docJson(doc);
  const opts = {
    song: options.song ?? 0,
    sourceIds: options.sourceIds === true,
    ...(options.lineStarts?.size ? { lineStarts: [...options.lineStarts] } : {}),
    midLineStarts: options.midLineStarts ?? false,
    ...(options.slurTies !== undefined ? { slurTies: options.slurTies } : {}),
    ...(layout ? { layout } : {}),
  };
  return call(() => dolce().modelToXml(json, h, JSON.stringify(opts)));
}
