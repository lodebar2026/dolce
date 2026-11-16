// MusicXML 读入（`ScoreDoc` ← MusicXML 文本）：在 Rust（crates/dolce-model/src/fromxml.rs），这里是门面。
// 读出的模型是镜像（`rustdoc.ts`）：可绑对象的身份记在旁表里，表层（原树与绑定）留在 Rust，按身份经 `xmlsurface.ts` 查、经 `toxml.ts` 回填。

import type { ScoreDoc } from "./doc";
import { dolce } from "../common/dolce";
import { adopt, call, SurfaceRef } from "./rustdoc";

/** MusicXML 文本 → `ScoreDoc`。**读得全**是全量重写不丢东西的前提，读不懂的子节点挂在最近的 `raw` 上，由写出端原位吐回去。
 *  XML 坏了抛 `ModelError`（`err.xmlParse`）。 */
export function loadScoreDoc(xmlText: string): ScoreDoc {
  const [h, json] = call(() => dolce().modelLoadXml(xmlText));
  const doc = adopt<ScoreDoc>(json, new SurfaceRef(h));
  doc.source = xmlText;
  return doc;
}
