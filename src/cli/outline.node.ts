// 页 SVG 里的 `<text>` 换成字形轮廓路径：Node 侧出位图（sharp 栅格化）前用，栅格化器不用自己找字体，
// 字体选择、回退与量字是同一套（原生模块的 `outline`）。带逐字笔位（`x` 是一串）的按笔位一字一段。
// 只认渲染出口（layout/render.ts、svgnode.ts）写出的那种 `<text>`：属性值里没有 `>`，内容是转义过的纯文字。
import { textOutline } from "./textmeasure.node";

const unescape = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

function attrsOf(tag: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) m.set(a[1]!, unescape(a[2]!));
  return m;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** 换掉所有 `<text>`；没有原生模块（量字退回字体文件那条路）时抛错。根上补 `xmlns`，成为独立的 `.svg`。 */
export function outlinedSvg(svg: string): string {
  const out = svg.replace(/<text\b([^>]*)>([^<]*)<\/text>/g, (_m, attrStr: string, content: string) => {
    const a = attrsOf(attrStr);
    const text = unescape(content);
    const family = a.get("font-family") ?? "sans-serif";
    const size = Number(a.get("font-size") ?? 16);
    const bold = a.get("font-weight") === "bold";
    const italic = a.get("font-style") === "italic";
    const fill = a.get("fill") ?? "black";
    const tf = a.get("transform");
    const xs = (a.get("x") ?? "0").trim().split(/\s+/).map(Number);
    const y = Number(a.get("y") ?? 0);
    const outline = (s: string): string => {
      const d = textOutline(s, family, size, bold, italic);
      if (d === null) throw new Error("没有原生量字模块，出不了轮廓（npm run build:native）");
      return d;
    };
    let body: string;
    if (xs.length > 1) {
      const chars = [...text];
      body = chars
        .map((ch, i) => {
          const d = outline(ch);
          return d ? `<path transform="translate(${xs[Math.min(i, xs.length - 1)]} ${y})" d="${d}"/>` : "";
        })
        .join("");
    } else {
      const d = outline(text);
      body = d ? `<path transform="translate(${xs[0] ?? 0} ${y})" d="${d}"/>` : "";
    }
    return `<g${tf ? ` transform="${esc(tf)}"` : ""} fill="${esc(fill)}">${body}</g>`;
  });
  return out.replace(/^<svg\b(?![^>]*\bxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
}
