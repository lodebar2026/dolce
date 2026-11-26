// Node 侧的量字后端：原生模块 `native/textmeasure`（`npm run build:native`，macOS CoreText / Windows DirectWrite / Linux 字体文件层 fontdb + rustybuzz）。
// 浏览器口径（CSS 族串按中文页面展开、单字宽取 1/64、全角标点挤压、ascent 取整与修正、f32）全在 Rust
//（`crates/engrave/src/text` 的 `BrowserCompat`，`dolce_text_native::node_measure`），与 `dolce` 命令行同一份；这里只把它接成 `MeasureBackend`。
// 这三个以外的平台没有原生模块，Node 侧排不了版。
// **只许进 Node 入口（cli/*）的 import 链。**

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rect } from "../common/geom";
import type { FeatureList, MeasureBackend } from "../common/measure";

interface Native {
  compatInit(redist: string, files: string[][]): void;
  compatGlyph(text: string, family: string, size: number, bold: boolean, features: string[], italic: boolean): number[];
  compatPositions(text: string, family: string, size: number, bold: boolean, features: string[]): number[];
  compatFontMetrics(family: string, size: number, bold: boolean, italic: boolean): number[];
  compatPathBounds(d: string): number[];
  compatOutline(text: string, family: string, size: number, bold: boolean, italic: boolean): string;
}

/** 找原生模块：`DOLCE_TEXTMEASURE` 指定的，或仓库里 `native/textmeasure/textmeasure.node`。 */
function loadNative(): Native {
  const cands = [
    process.env.DOLCE_TEXTMEASURE,
    fileURLToPath(new URL("../../native/textmeasure/textmeasure.node", import.meta.url)),
  ].filter((p): p is string => !!p);
  const req = createRequire(import.meta.url);
  for (const p of cands) if (existsSync(p)) return req(p) as Native;
  throw new Error("没有原生量字模块 native/textmeasure/textmeasure.node（npm run build:native；只支持 macOS / Windows / Linux）");
}

let native: Native | null = null;
const nat = (): Native => (native ??= loadNative());

const feats = (f: FeatureList | undefined): string[] => (f ? [...f] : []);

/** 一串字的轮廓（SVG path `d`，基线 y = 0），字体选择同量字。 */
export function textOutline(text: string, css: string, size: number, bold = false, italic = false): string {
  return nat().compatOutline(text, css, size, bold, italic);
}

/**
 * Node 侧的测量后端。`files` 是要额外按文件给的字体（族名 → 路径），仓库里的 Bravura 两支总会注册；
 * 成书注册的字体也从这里进来。每调一次换一份原生口径层（缓存作废）。
 */
export function nodeMeasure(files: Record<string, string> = {}): MeasureBackend {
  const n = nat();
  n.compatInit(fileURLToPath(new URL("../../public/redist/", import.meta.url)), Object.entries(files));
  return {
    glyph(text, family, size, weight, features, style) {
      const [w, l, t, r, b] = n.compatGlyph(text, family, size, weight === "bold", feats(features), style === "italic");
      return { width: w!, bbox: new Rect(l!, t!, r!, b!) };
    },
    positions(text, family, size, weight, features) {
      const xs = n.compatPositions(text, family, size, weight === "bold", feats(features));
      const width = xs.pop()!;
      return { xs, width };
    },
    fontMetrics(family, size, weight, style) {
      const [ascent, descent] = n.compatFontMetrics(family, size, weight === "bold", style === "italic");
      return { ascent: ascent!, descent: descent! };
    },
    pathBounds(d) {
      const [l, t, r, b] = n.compatPathBounds(d);
      return new Rect(l!, t!, r!, b!);
    },
  };
}
