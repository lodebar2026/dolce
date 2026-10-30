// 自有的 XML 树：MusicXML 读写用，**浏览器与 Node 同一份**（不用浏览器的 `DOMParser`——Node 侧的脚本与测试不必起浏览器，
// 两边也不会因 DOM 实现不同读出两样）。DOM 风格的接口（`children` / `getAttribute` / `textContent`…）只留读写 MusicXML 用到的。
//
// - 认：元素、属性（保原序）、文本、CDATA、注释、处理指令、`<!DOCTYPE>`（内部子集里的一般实体声明 `<!ENTITY x "…">` 也认）；
//   五个预定义实体与数字实体。**不认命名空间**（MusicXML 不用），`xml:lang` 之类当普通属性名。
// - 不合法就抛 `XmlError`：标签不配对、没闭合、多个根、属性没引号或重名、属性值里有 `<`、不认得的实体。
// - 换行按 XML 规定归一（`\r\n`、`\r` → `\n`；属性值里的空白字符 → 空格）。
// - 每个读进来的元素记下它在原文里的区间 `start`/`end`（开标签的 `<` 到闭标签的 `>` 之后），`editor/sync.ts` 按它对原文位置；
//   新建、克隆的元素没有区间（-1）。
//
// 序列化 `serializeXml`：转义口径同浏览器的 `XMLSerializer`（文字转 `& < >`，属性再转 `"`；另剔掉 XML 1.0 不许的控制字符），空元素写 `<x/>`；
// 整份文档把根前根后的原文（声明、DOCTYPE、注释）原样带上。
//
// 建树用 `h(标签, 属性, ...子节点)`（五线谱识别的写出就这么建，不拼字符串）。

export class XmlError extends Error {
  constructor(message: string, readonly at: number) {
    super(`${message} @${at}`);
  }
}

export interface XmlAttr {
  readonly name: string;
  value: string;
}

/** 元素之外的节点：文字、CDATA、注释、处理指令（`data` 是 `<?` 与 `?>` 之间的原文） */
export class XmlText {
  parentElement: XmlEl | null = null;
  constructor(readonly type: "text" | "cdata" | "comment" | "pi", public data: string) {}
}

export type XmlNode = XmlEl | XmlText;

export class XmlEl {
  parentElement: XmlEl | null = null;
  /** 根元素所属的文档（只记在根上，`ownerDocument` 往上找） */
  private doc: XmlDoc | null = null;
  /** 原文区间（读进来的才有；新建、克隆的为 -1） */
  start = -1;
  end = -1;
  private readonly attrs: XmlAttr[] = [];
  private readonly kids: XmlEl[] = [];
  /** 全部子节点（元素与文字等），按文档序 */
  readonly childNodes: XmlNode[] = [];

  constructor(readonly tagName: string) {}

  /** 所在文档：往上找到根，根挂在哪份文档上（建出来还没挂的为 null） */
  get ownerDocument(): XmlDoc | null {
    let e: XmlEl = this;
    while (e.parentElement) e = e.parentElement;
    return e.doc;
  }

  /** `XmlDoc.documentElement` 设根时用 */
  static adopt(root: XmlEl, doc: XmlDoc): void {
    root.doc = doc;
  }

  /** 子元素（只含元素），按文档序 */
  get children(): readonly XmlEl[] {
    return this.kids;
  }

  get firstElementChild(): XmlEl | null {
    return this.kids[0] ?? null;
  }

  /** 属性，按原文次序 */
  get attributes(): readonly XmlAttr[] {
    return this.attrs;
  }

  getAttribute(name: string): string | null {
    for (const a of this.attrs) if (a.name === name) return a.value;
    return null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.some((a) => a.name === name);
  }

  setAttribute(name: string, value: string): void {
    const a = this.attrs.find((x) => x.name === name);
    if (a) a.value = value;
    else this.attrs.push({ name, value });
  }

  removeAttribute(name: string): void {
    const i = this.attrs.findIndex((a) => a.name === name);
    if (i >= 0) this.attrs.splice(i, 1);
  }

  /** 文字与 CDATA 按文档序拼起来（含后代；注释、处理指令不算） */
  get textContent(): string {
    let s = "";
    for (const n of this.childNodes) {
      if (n instanceof XmlEl) s += n.textContent;
      else if (n.type === "text" || n.type === "cdata") s += n.data;
    }
    return s;
  }

  /** 后代里的 `tag` 元素（不含自己），按文档序 */
  getElementsByTagName(tag: string): XmlEl[] {
    const out: XmlEl[] = [];
    const walk = (e: XmlEl) => {
      for (const c of e.kids) {
        if (c.tagName === tag) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** 接到最后（原先挂在别处的先摘下来） */
  appendChild<T extends XmlNode>(node: T): T {
    if (node.parentElement) detach(node);
    node.parentElement = this;
    this.childNodes.push(node);
    if (node instanceof XmlEl) this.kids.push(node);
    return node;
  }

  /** 插到 `ref` 之前（`ref` 为 null 接到最后）；原先挂在别处的先摘下来 */
  insertBefore<T extends XmlNode>(node: T, ref: XmlNode | null): T {
    if (!ref) return this.appendChild(node);
    if (node.parentElement) detach(node);
    node.parentElement = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    if (node instanceof XmlEl) {
      // 元素表里排在 ref 之后第一个元素之前
      const at = this.childNodes.indexOf(node);
      const next = this.childNodes.slice(at + 1).find((n): n is XmlEl => n instanceof XmlEl);
      this.kids.splice(next ? this.kids.indexOf(next) : this.kids.length, 0, node);
    }
    return node;
  }

  /** 从父元素上摘下来 */
  remove(): void {
    if (this.parentElement) detach(this);
  }

  /** 深拷贝（不带原文区间） */
  cloneNode(): XmlEl {
    const el = new XmlEl(this.tagName);
    for (const a of this.attrs) el.attrs.push({ ...a });
    for (const n of this.childNodes) el.appendChild(n instanceof XmlEl ? n.cloneNode() : new XmlText(n.type, n.data));
    return el;
  }
}

function detach(node: XmlNode): void {
  const p = node.parentElement!;
  p.childNodes.splice(p.childNodes.indexOf(node), 1);
  if (node instanceof XmlEl) (p.children as XmlEl[]).splice(p.children.indexOf(node), 1);
  node.parentElement = null;
}

export class XmlDoc {
  private root!: XmlEl;
  /** 根元素之前的原文（`<?xml …?>`、`<!DOCTYPE …>`、注释、空白），序列化原样写回 */
  prolog = "";
  /** 根元素之后的原文 */
  epilog = "";

  get documentElement(): XmlEl {
    return this.root;
  }

  set documentElement(el: XmlEl) {
    this.root = el;
    XmlEl.adopt(el, this);
  }

  /** 全文档里的 `tag` 元素（含根），按文档序 */
  getElementsByTagName(tag: string): XmlEl[] {
    const root = this.documentElement;
    return root.tagName === tag ? [root, ...root.getElementsByTagName(tag)] : root.getElementsByTagName(tag);
  }
}

// ───────────────────────── 解析 ─────────────────────────

const PREDEFINED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = /[^\s<>/=!?"'&;]+/y;
const SPACE = /\s*/y;

/** MusicXML 文本 → 树。不合法抛 `XmlError`。 */
export function parseXml(text: string): XmlDoc {
  const doc = new XmlDoc();
  const entities = new Map<string, string>();
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (what: string, at = i): never => {
    throw new XmlError(what, at);
  };
  const decode = (s: string, at: number): string => {
    if (s.indexOf("&") < 0) return s;
    return s.replace(/&([^;&\s]*);?/g, (m, e: string, off: number) => {
      if (!m.endsWith(";")) fail("实体没写分号", at + off);
      if (e[0] === "#") {
        const code = e[1] === "x" ? parseInt(e.slice(2), 16) : /^\d+$/.test(e.slice(1)) ? Number(e.slice(1)) : NaN;
        if (!Number.isFinite(code) || code > 0x10ffff) fail(`坏的字符引用 ${m}`, at + off);
        return String.fromCodePoint(code);
      }
      const v = PREDEFINED[e] ?? entities.get(e);
      if (v === undefined) fail(`不认得的实体 ${m}`, at + off);
      return v!;
    });
  };
  const newlines = (s: string) => (s.indexOf("\r") < 0 ? s : s.replace(/\r\n?/g, "\n"));
  const nameAt = (at: number): string => {
    NAME.lastIndex = at;
    const m = NAME.exec(text);
    if (!m) fail("缺标签名或属性名", at);
    return m![0];
  };
  const skipSpace = () => {
    SPACE.lastIndex = i;
    SPACE.exec(text);
    i = SPACE.lastIndex;
  };
  const until = (close: string, what: string): number => {
    const e = text.indexOf(close, i);
    if (e < 0) fail(`${what}没收口`);
    return e;
  };

  /** `<!DOCTYPE …>`：跳过（引号里与内部子集里的 `>` 不算收口），顺手记下一般实体声明 */
  const doctype = () => {
    let depth = 0;
    let j = i + 9;
    for (; j < n; j++) {
      const c = text[j];
      if (c === '"' || c === "'") {
        const e = text.indexOf(c, j + 1);
        if (e < 0) fail("DOCTYPE 引号没收口", j);
        j = e;
      } else if (c === "[") {
        depth++;
        const sub = /<!ENTITY\s+([^\s%]+)\s+("([^"]*)"|'([^']*)')\s*>/y;
        for (let k = j + 1; k < n && text[k] !== "]"; ) {
          sub.lastIndex = k;
          const m = sub.exec(text);
          if (m) {
            if (!entities.has(m[1]!)) entities.set(m[1]!, m[3] ?? m[4]!);
            k = sub.lastIndex;
          } else k++;
        }
      } else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) break;
    }
    if (j >= n) fail("DOCTYPE 没收口");
    i = j + 1;
  };

  /** 根前根后的那些：空白、注释、处理指令（`doctypeOk` 时还有 DOCTYPE） */
  const misc = (doctypeOk: boolean): void => {
    for (;;) {
      skipSpace();
      if (text.startsWith("<!--", i)) i = until("-->", "注释") + 3;
      else if (text.startsWith("<?", i)) i = until("?>", "处理指令") + 2;
      else if (doctypeOk && text.startsWith("<!DOCTYPE", i)) doctype();
      else return;
    }
  };

  const prologFrom = i;
  misc(true);
  if (i >= n || text[i] !== "<") fail(i >= n ? "没有根元素" : "根元素前有文字");
  doc.prolog = text.slice(prologFrom, i);

  const stack: XmlEl[] = [];
  const top = () => stack[stack.length - 1]!;
  for (;;) {
    if (i >= n) fail(`<${top().tagName}> 没闭合`);
    if (text[i] !== "<") {
      const lt = text.indexOf("<", i);
      const end = lt < 0 ? n : lt;
      if (!stack.length) break;
      top().appendChild(new XmlText("text", decode(newlines(text.slice(i, end)), i)));
      i = end;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      if (!stack.length) break;
      const e = until("-->", "注释");
      top().appendChild(new XmlText("comment", text.slice(i + 4, e)));
      i = e + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      if (!stack.length) fail("CDATA 在根元素外");
      const e = until("]]>", "CDATA");
      top().appendChild(new XmlText("cdata", newlines(text.slice(i + 9, e))));
      i = e + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      if (!stack.length) break;
      const e = until("?>", "处理指令");
      top().appendChild(new XmlText("pi", text.slice(i + 2, e)));
      i = e + 2;
      continue;
    }
    if (text[i + 1] === "!") fail("元素里不能有声明");
    if (text[i + 1] === "/") {
      const name = nameAt(i + 2);
      const el = stack.pop();
      if (!el) fail(`多余的 </${name}>`);
      if (el!.tagName !== name) fail(`</${name}> 与 <${el!.tagName}> 不配对`);
      i += 2 + name.length;
      skipSpace();
      if (text[i] !== ">") fail(`</${name}> 没收口`);
      i++;
      el!.end = i;
      if (!stack.length) break;
      continue;
    }
    if (!stack.length && doc.documentElement) fail("不止一个根元素");
    const start = i;
    const el = new XmlEl(nameAt(i + 1));
    el.start = start;
    i += 1 + el.tagName.length;
    for (;;) {
      const before = i;
      skipSpace();
      if (text.startsWith("/>", i) || text[i] === ">") break;
      if (i === before) fail(`<${el.tagName}> 里属性之间缺空白`);
      if (i >= n) fail(`<${el.tagName}> 没收口`);
      const name = nameAt(i);
      i += name.length;
      skipSpace();
      if (text[i] !== "=") fail(`属性 ${name} 缺 =`);
      i++;
      skipSpace();
      const q = text[i];
      if (q !== '"' && q !== "'") fail(`属性 ${name} 没加引号`);
      const e = text.indexOf(q!, i + 1);
      if (e < 0) fail(`属性 ${name} 引号没收口`);
      const raw = text.slice(i + 1, e);
      if (raw.indexOf("<") >= 0) fail(`属性 ${name} 的值里有 <`);
      if (el.hasAttribute(name)) fail(`属性 ${name} 重复`);
      el.setAttribute(name, decode(raw.replace(/\r\n|[\t\n\r]/g, " "), i + 1));
      i = e + 1;
    }
    if (stack.length) top().appendChild(el);
    else doc.documentElement = el;
    if (text[i] === "/") {
      i += 2;
      el.end = i;
      if (!stack.length) break;
    } else {
      i++;
      stack.push(el);
    }
  }
  const epilogFrom = i;
  misc(false);
  if (i < n) fail("根元素后还有内容");
  doc.epilog = text.slice(epilogFrom);
  return doc;
}

// ───────────────────────── 建树 ─────────────────────────

/** 属性值：`undefined` / `null` / `false` 不写 */
export type XmlAttrs = Readonly<Record<string, string | number | null | undefined | false>>;
/** 子节点：字符串与数字成文字节点，空值不写，数组摊开 */
export type XmlKid = XmlNode | string | number | null | undefined | false | readonly XmlKid[];

/** 建一个元素：`h("note", { id }, h("pitch", null, h("step", null, "C")), …)` */
export function h(tag: string, attrs?: XmlAttrs | null, ...kids: XmlKid[]): XmlEl {
  const el = new XmlEl(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  const add = (k: XmlKid): void => {
    if (k === undefined || k === null || k === false) return;
    if (Array.isArray(k)) for (const x of k as readonly XmlKid[]) add(x);
    else if (typeof k === "string" || typeof k === "number") el.appendChild(new XmlText("text", String(k)));
    else el.appendChild(k as XmlNode);
  };
  for (const k of kids) add(k);
  return el;
}

// ───────────────────────── 序列化 ─────────────────────────

// XML 1.0 不许出现的控制字符剔掉（同 `xmlutil.ts::escapeXml`）：识别从音乐字体里取到的文字会带，写进去整份文件读不开
const escText = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

function writeNode(node: XmlNode, out: string[]): void {
  if (node instanceof XmlText) {
    if (node.type === "text") out.push(escText(node.data));
    else if (node.type === "cdata") out.push(`<![CDATA[${node.data}]]>`);
    else if (node.type === "comment") out.push(`<!--${node.data}-->`);
    else out.push(`<?${node.data}?>`);
    return;
  }
  let open = `<${node.tagName}`;
  for (const a of node.attributes) open += ` ${a.name}="${escAttr(a.value)}"`;
  if (!node.childNodes.length) {
    out.push(`${open}/>`);
    return;
  }
  out.push(`${open}>`);
  for (const c of node.childNodes) writeNode(c, out);
  out.push(`</${node.tagName}>`);
}

/** 元素（或整份文档：根前根后的原文原样带上）→ XML 文本 */
export function serializeXml(node: XmlEl | XmlDoc): string {
  const out: string[] = [];
  if (node instanceof XmlDoc) {
    out.push(node.prolog);
    writeNode(node.documentElement, out);
    out.push(node.epilog);
  } else writeNode(node, out);
  return out.join("");
}
