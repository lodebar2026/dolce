// 不靠 DOM 的 SVG 元素：只实现渲染出口（layout/render.ts）用到的那几样——
// setAttribute / getAttribute / appendChild / firstChild / textContent / outerHTML。
// Node 侧排版出图用（`cli/engrave.ts` 经 `setSvgDocument` 装上）。
//
// `outerHTML` 照浏览器在 HTML 文档里的序列化写：属性按设置的先后，不补 xmlns，每个元素都写结束标签；
// 文字转义 `& < >` 与不换行空格，属性值转义 `& " < >` 与不换行空格。指纹脚本拿它哈希，与浏览器那一份同格式。
// 要独立 `.svg` 文件时用 `toXml()`（根上补 xmlns，同 XMLSerializer）。

const escText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const escAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const escXmlText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escXmlAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class SvgNode {
  readonly attrs = new Map<string, string>();
  readonly children: (SvgNode | string)[] = [];
  parentNode: SvgNode | null = null;

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  appendChild<T extends SvgNode>(child: T): T {
    if (child.parentNode) {
      const sib = child.parentNode.children;
      sib.splice(sib.indexOf(child), 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  /** 只有元素子级时用（renderPageSvg 整批搬 `<g>` 的子级）；首个子级是文字时给 null。 */
  get firstChild(): SvgNode | null {
    const c = this.children[0];
    return c !== undefined && typeof c !== "string" ? c : null;
  }

  /** 页面树只给 `<text>` 设文字，设了就是唯一的子级。 */
  set textContent(s: string) {
    for (const c of this.children) if (typeof c !== "string") c.parentNode = null;
    this.children.length = 0;
    if (s) this.children.push(s);
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }

  /** Node 侧没有渲染树；当作已挂上，免得调用方按「没铺到页面上」跳过。 */
  get isConnected(): boolean {
    return true;
  }

  get outerHTML(): string {
    let s = `<${this.tagName}`;
    for (const [k, v] of this.attrs) s += ` ${k}="${escAttr(v)}"`;
    s += ">";
    for (const c of this.children) s += typeof c === "string" ? escText(c) : c.outerHTML;
    return `${s}</${this.tagName}>`;
  }

  /** 独立的 XML（`.svg` 文件）：根上补 `xmlns`，同浏览器的 XMLSerializer。 */
  toXml(root = true): string {
    let s = `<${this.tagName}`;
    if (root && !this.attrs.has("xmlns")) s += ` xmlns="http://www.w3.org/2000/svg"`;
    for (const [k, v] of this.attrs) s += ` ${k}="${escXmlAttr(v)}"`;
    if (!this.children.length) return `${s}/>`;
    s += ">";
    for (const c of this.children) s += typeof c === "string" ? escXmlText(c) : c.toXml(false);
    return `${s}</${this.tagName}>`;
  }
}

/** `setSvgDocument` 用的文档。 */
export const svgNodeDocument = {
  createElementNS(_ns: string, tag: string): Element {
    return new SvgNode(tag) as unknown as Element;
  },
};
