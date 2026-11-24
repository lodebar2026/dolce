// Minimal modal dialogs (replacing options.fxml / SimpleLayout.fxml).
import type { App, PaperChoice, PaperEngine } from "./app";
import { resolvePaper, pageMargins, CUSTOM_PAPER } from "../style/paper";
import { HEADER_ROLES } from "../style/header";
import { NOTE_FONTS } from "../style/fonts";
import type { PageDecl } from "../style/sheet";
import { ORIGINAL_PAPERS, PAGE_RATIOS, PAPER_SIZES } from "../style/themes";
import { CONVERT_TARGETS } from "../convert/targets";
import { getLangPref, setLangPref, t, type LangPref, type MsgKey } from "../i18n";
import { targetLabel } from "../i18n/labels";
import type { SingFitNote } from "../layout/rustlayout";
import type { SingPreview } from "./app";

/** 模态框的底座：遮罩 + 盒（标题 / 内容 / 页脚）、Esc 与点遮罩关闭。按钮与内容由调用方给。
 *  `close` 可重复调用，`onClose` 只回一次（不论是按钮、Esc 还是点遮罩关的）。 */
export function openModal(opts: {
  title: string;
  /** `modal-box` 之外再加的类（定宽、定高之类）。 */
  boxClass?: string;
  titleId?: string;
  body: readonly HTMLElement[];
  footer: readonly HTMLElement[];
  onClose?: () => void;
}): { overlay: HTMLElement; close: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = opts.boxClass ? `modal-box ${opts.boxClass}` : "modal-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const h = document.createElement("div");
  h.className = "modal-title";
  h.textContent = opts.title;
  if (opts.titleId) {
    h.id = opts.titleId;
    box.setAttribute("aria-labelledby", h.id);
  }
  const footer = document.createElement("div");
  footer.className = "modal-footer";
  footer.append(...opts.footer);
  box.append(h, ...opts.body, footer);
  overlay.append(box);
  document.body.append(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);
    opts.onClose?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeyDown);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  return { overlay, close };
}

/** 确定/取消两钮的对话框。`extra`：页脚左侧再放一个按钮（点了执行并关闭，不算取消）。 */
function modal(
  title: string,
  body: HTMLElement,
  onOk: () => void,
  onCancel?: () => void,
  extra?: { label: string; onClick: () => void },
  okLabel?: string,
): void {
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "modal-button-primary";
  ok.textContent = okLabel ?? t("dlg.ok");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("dlg.cancel");
  const extraBtn = extra ? document.createElement("button") : null;
  if (extraBtn && extra) {
    extraBtn.type = "button";
    extraBtn.textContent = extra.label;
    extraBtn.style.marginRight = "auto";
  }

  let settled = false;
  const { close } = openModal({
    title,
    boxClass: "settings-box",
    titleId: "settings-dialog-title",
    body: [body],
    footer: extraBtn ? [extraBtn, cancel, ok] : [cancel, ok],
    // 取消（含 Esc / 点遮罩）也要有回声，否则确认框的调用方永远等不到答复。
    onClose: () => {
      if (!settled) {
        settled = true;
        onCancel?.();
      }
    },
  });
  cancel.onclick = close;
  ok.onclick = () => {
    settled = true;
    onOk();
    close();
  };
  if (extraBtn && extra) {
    extraBtn.onclick = () => {
      settled = true;
      extra.onClick();
      close();
    };
  }
  (body.querySelector("input,select") as HTMLElement | null)?.focus();
}

/** 一张表单对话框：确定时调 `onOk`（取消什么也不做）。 */
export function showFormDialog(title: string, body: HTMLElement, onOk: () => void, okLabel?: string, onCancel?: () => void): void {
  modal(title, body, onOk, onCancel, undefined, okLabel);
}

/** 是/否确认框。用同一套 modal 样式，别退回 window.confirm——桌面版观感对不上。 */
export function showConfirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "modal-row";
    body.textContent = message;
    modal(title, body, () => resolve(true), () => resolve(false));
  });
}

/** 单选框：列一组选项，确定返回选中的值；取消（含 Esc / 点遮罩）返回 `null`。
 *  `remember` 给了就在下面加一个「记住选择」勾选框，结果里带回它的勾选状态。 */
export function showChoiceDialog<T extends string>(
  title: string,
  message: string,
  options: readonly { value: T; label: string }[],
  opts: { defaultValue: T; remember?: string },
): Promise<{ value: T; remember: boolean } | null> {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;gap:6px";
    if (message) {
      const msg = document.createElement("div");
      msg.className = "modal-row";
      msg.textContent = message;
      body.append(msg);
    }
    const name = `choice-${Math.random().toString(36).slice(2)}`;
    const radios: HTMLInputElement[] = [];
    for (const o of options) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer";
      const r = document.createElement("input");
      r.type = "radio";
      r.name = name;
      r.value = o.value;
      r.checked = o.value === opts.defaultValue;
      radios.push(r);
      const span = document.createElement("span");
      span.textContent = o.label;
      row.append(r, span);
      body.append(row);
    }
    const remember = document.createElement("input");
    remember.type = "checkbox";
    if (opts.remember) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;opacity:0.85;cursor:pointer";
      const span = document.createElement("span");
      span.textContent = opts.remember;
      row.append(remember, span);
      body.append(row);
    }
    modal(title, body, () => {
      const picked = radios.find((r) => r.checked)?.value as T | undefined;
      resolve({ value: picked ?? opts.defaultValue, remember: remember.checked });
    }, () => resolve(null));
  });
}

export function labeled(label: string, el: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "modal-row";
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, el);
  return row;
}

const HANCONV_KEY = "dolce-hanconv-dir";

/** 简繁 — 整篇转换源码中的中文（歌词/标题/词曲）。 */
export function showHanConvDialog(app: App): void {
  const body = document.createElement("div");
  body.className = "settings-form";
  const sel = document.createElement("select");
  const opts: [string, string][] = [
    ["auto", t("han.auto")],
    ["s2t", t("han.s2t")],
    ["t2s", t("han.t2s")],
  ];
  const last = localStorage.getItem(HANCONV_KEY) ?? "auto";
  for (const [v, text] of opts) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    if (v === last) o.selected = true;
    sel.append(o);
  }
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:8px;opacity:0.75;font-size:12px;line-height:1.6";
  hint.textContent = t("han.hint");
  body.append(labeled(t("han.direction"), sel), hint);
  modal(t("han.title"), body, () => {
    const dir = sel.value as "auto" | "s2t" | "t2s";
    try {
      localStorage.setItem(HANCONV_KEY, dir);
    } catch { /* 隐私模式下忽略 */ }
    void app.convertHanzi(dir);
  });
}

/** 歌词文件字节 → 文本：带 BOM 的 UTF-16 / UTF-8，否则先按 UTF-8 严格解、解不了退 GBK（老 .txt / .lrc 多是 GBK；同 Rust `decode_lyrics_bytes`）。 */
function decodeLyricsFile(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("gbk").decode(b);
  }
}

function singNoteText(n: SingFitNote): string {
  const bar = n.bar ?? "?";
  const ctx = n.context ? `  〔${n.context}〕` : "";
  switch (n.kind) {
    case "refExtra": return t("sing.note.refExtra", { bar, ref: n.ref ?? "" }) + ctx;
    case "scoreExtra": return t("sing.note.scoreExtra", { bar, score: n.score ?? "" }) + ctx;
    case "mismatch": return t("sing.note.mismatch", { bar, score: n.score ?? "", ref: n.ref ?? "" }) + ctx;
    case "offScore": return t("sing.note.offScore", { from: n.fromBar ?? "?", bar }) + ctx;
    case "noMatch": return t("sing.note.noMatch");
  }
}

/** 按歌词生成演唱顺序：粘贴 / 读文件 → 生成预览（`%%sing` 与差异）→ 写入（改 123 原文，一次可撤销）。 */
export function showSingDialog(app: App): void {
  const body = document.createElement("div");
  body.className = "settings-form sing-form";
  const hint = document.createElement("div");
  hint.className = "modal-hint sing-hint";
  hint.textContent = t("sing.hint");
  const area = document.createElement("textarea");
  area.rows = 12;
  area.placeholder = t("sing.placeholder");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".txt,.lrc,text/plain";
  fileInput.hidden = true;
  const fileBtn = document.createElement("button");
  fileBtn.type = "button";
  fileBtn.textContent = t("sing.file");
  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    area.value = decodeLyricsFile(new Uint8Array(await f.arrayBuffer()));
    schedule(0);
  };
  fileBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => void loadFile(fileInput.files?.[0]);
  area.addEventListener("dragover", (e) => e.preventDefault());
  area.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    void loadFile(f);
  });
  const result = document.createElement("div");
  result.className = "sing-result";
  body.append(hint, area, fileBtn, fileInput, result);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("dlg.cancel");
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "modal-button-primary";
  apply.textContent = t("sing.apply");
  apply.disabled = true;
  const { close } = openModal({ title: t("sing.title"), boxClass: "settings-box sing-box", body: [body], footer: [cancel, apply] });
  cancel.onclick = () => {
    clearTimeout(timer);
    seq++;
    close();
  };

  // 歌词一改就重新预览（停顿片刻再跑），不另设「生成」按钮；`seq` 丢掉过时的结果
  let pending: SingPreview | null = null;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay = 400) => {
    clearTimeout(timer);
    pending = null;
    apply.disabled = true;
    const my = ++seq;
    if (!area.value.trim()) {
      result.replaceChildren();
      return;
    }
    timer = setTimeout(() => void preview(my), delay);
  };
  area.oninput = () => schedule();
  const preview = async (my: number) => {
    result.textContent = t("sing.busy");
    try {
      const r = await app.previewSingFromLyrics(area.value);
      if (my !== seq) return;
      result.replaceChildren();
      const line = (text: string, cls = "") => {
        const d = document.createElement("div");
        d.textContent = text;
        d.className = cls;
        result.append(d);
        return d;
      };
      if (!r) {
        line(t("sing.notApplicable"));
        return;
      }
      const passes = r.report.sing ? r.report.sing.split("\n").length : 0;
      line(t("sing.summary", { matched: r.report.matched, total: r.report.refChars, passes }));
      if (r.report.sing) {
        const pre = document.createElement("pre");
        pre.textContent = r.report.sing;
        result.append(pre);
      }
      if (r.report.notes.length) {
        const ul = document.createElement("ul");
        for (const n of r.report.notes) {
          const li = document.createElement("li");
          li.textContent = singNoteText(n);
          ul.append(li);
        }
        result.append(ul);
      }
      if (r.report.sing && r.apply === null) line(t("sing.unplaced"), "sing-error");
      else if (r.report.sing) {
        if (!r.inSource) line(t("sing.modelOnly"), "modal-hint");
        if (r.replaces) line(t("sing.replaces"), "modal-hint");
      }
      pending = r.report.sing ? r : null;
      apply.disabled = pending?.apply == null;
    } catch (e) {
      if (my !== seq) return;
      console.error("sing from lyrics failed", e);
      result.textContent = t("sing.failed");
    }
  };
  apply.onclick = () => {
    if (!pending?.apply) return;
    clearTimeout(timer);
    pending.apply();
    app.setStatus(t(pending.inSource ? "sing.applied" : "sing.appliedModel"));
    close();
  };
  area.focus();
}

/** ARGB → <input type="color">。取色器只认 #rrggbb，alpha 一律当不透明处理
 *  （谱面从来没用过半透明色，存量数据里的 alpha 也一直是 0xff）。 */
function colorInput(argb: number): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "color";
  el.value = "#" + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  return el;
}

/** 取色器的值读回 ARGB。浏览器给不出合法值时（理论上不会）退回原值，不要静默变黑。 */
function colorValue(el: HTMLInputElement, fallback: number): number {
  const rgb = parseInt(el.value.slice(1), 16);
  if (!Number.isFinite(rgb)) return fallback;
  return (0xff000000 | (rgb & 0xffffff)) >>> 0;
}

/** 选项。**只摆当前模式下真正生效的项**——面板是全局的，但四档视图（投影 / 简谱 /
 *  五线谱 / 混排）各走各的排版器，参数并不通用：字号与颜色只有简谱排版器那条路吃
 *  （文本谱有自己的整套 metrics、混排有自己的一套色），纸张两档各记各的，
 *  「每页行数」只对分页的那一档有意义。摆出无效项等于骗人——改了没反应。
 *  背景色是唯一四档通吃的（它铺的是纸，不是谱，见 App._applyPageBg）。 */
const PT_PER_MM = 72 / 25.4;

/** 纸张一句话：「A4 竖」（边距在下面那一行显示）。 */
function describePage(p: PageDecl): string {
  const size = resolvePaper(p);
  if (size === null) return t("paper.longImage");
  const name = p.paper === CUSTOM_PAPER && size ? `${Math.round(size.w)}×${Math.round(size.h)}pt` : p.paper ?? "";
  return `${name} ${t(size && size.w > size.h ? "paper.landscape" : "paper.portrait")}`;
}

/** 纸张栏：纸（谱里写了纸时多一项「跟随文件」）+ 方向 + 四边距（mm，留空 = 自动）。
 *  `read()` 返回 null 表示没动过——没动过就不写用户层，免得把「跟随文件」悄悄钉成一张具体的纸。 */
function paperGroup(app: App, engine: PaperEngine): { rows: HTMLElement[]; read(): PaperChoice | null } {
  const st = app.style.paperState(engine);
  const following = !st.userSet && st.doc !== null;
  const paper = document.createElement("select");
  if (st.doc) {
    const o = document.createElement("option");
    o.value = "follow";
    o.textContent = t("paper.followFile", { what: describePage(st.doc) });
    paper.append(o);
  }
  for (const k of ORIGINAL_PAPERS) {
    const wh = PAPER_SIZES[k];
    const o = document.createElement("option");
    o.value = k;
    o.textContent = wh ? `${k}（${wh[0]}×${wh[1]}pt）` : paperName(k);
    paper.append(o);
  }
  paper.value = following ? "follow" : isPaperKey(st.page.paper) ? st.page.paper! : "A4";

  const orient = document.createElement("select");
  for (const [v, label] of [["portrait", t("paper.portraitOpt")], ["landscape", t("paper.landscapeOpt")]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    orient.append(o);
  }
  const size = resolvePaper(st.page);
  orient.value = size && size.w > size.h ? "landscape" : "portrait";

  const mgNow = pageMargins(st.page);
  const margins = ([t("paper.top"), t("paper.right"), t("paper.bottom"), t("paper.left")]).map((label, i) => {
    const el = document.createElement("input");
    el.type = "number";
    el.min = "0";
    el.max = "100";
    el.placeholder = label;
    el.title = t("paper.marginTitle", { side: label });
    el.style.cssText = "flex:1 1 0;min-width:0";
    if (mgNow) el.value = String(Math.round(mgNow[i]! / PT_PER_MM));
    return el;
  });
  const mgBox = document.createElement("span");
  mgBox.style.cssText = "display:flex;gap:6px";
  mgBox.append(...margins);

  // 跟随文件 / 长图时方向与边距没有意义（长图的边距仍由排版器自己定）
  const sync = () => {
    const fixed = paper.value === "follow" || paper.value === "长图";
    orient.disabled = fixed;
    for (const m of margins) m.disabled = paper.value === "follow";
  };
  paper.onchange = sync;
  sync();

  const initial = JSON.stringify([paper.value, orient.value, margins.map((m) => m.value)]);
  return {
    rows: [labeled(t("paper.paper"), paper), labeled(t("paper.orientation"), orient), labeled(t("paper.margins"), mgBox)],
    read() {
      if (JSON.stringify([paper.value, orient.value, margins.map((m) => m.value)]) === initial) return null;
      if (paper.value === "follow") return "follow";
      const vals = margins.map((m) => m.value.trim());
      const margin = vals.every((v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0)
        ? vals.map((v) => Math.round(Number(v) * PT_PER_MM * 10) / 10)
        : null;
      return { paper: paper.value, orientation: orient.value as "portrait" | "landscape", margin };
    },
  };
}

/** 页眉字体下拉里的几支常用字。值是 CSS 字体栈（Mac / Windows 各给一支，缺了由浏览器回退）。 */
const HEADER_FAMILIES: readonly [MsgKey | null, string][] = [
  ["font.hei", "PingFang SC, Microsoft YaHei, sans-serif"],
  ["font.song", "Songti SC, SimSun, serif"],
  ["font.kai", "Kaiti SC, STKaiti, KaiTi, serif"],
  ["font.fangsong", "STFangsong, FangSong, serif"],
  ["font.weibei", "Weibei SC, STXinwei, serif"],
  ["font.yuan", "Yuanti SC, YouYuan, sans-serif"],
  [null, "Times New Roman, Times, serif"],
];

/** 页眉一组：标题 / 副标题 / 经文 / 词曲作者，各一个字体下拉 + 字号（pt，留空 = 跟随文件或出厂）。各档共用一份。 */
function headerGroup(app: App): { rows: HTMLElement[]; apply(): boolean } {
  const st = app.style.headerState();
  const rows: HTMLElement[] = [];
  const reads: (() => boolean)[] = [];
  for (const role of HEADER_ROLES) {
    const doc = st.doc[role];
    const user = st.user[role];
    const fam = document.createElement("select");
    const def = document.createElement("option");
    def.value = "";
    def.textContent = doc?.family ? t("paper.followFile", { what: doc.family.split(",")[0]! }) : t("font.default");
    fam.append(def);
    const known = new Set<string>();
    for (const [label, stack] of HEADER_FAMILIES) {
      const o = document.createElement("option");
      o.value = stack;
      o.textContent = label ? t(label) : "Times";
      fam.append(o);
      known.add(stack);
    }
    if (user?.family && !known.has(user.family)) {
      const o = document.createElement("option");
      o.value = user.family;
      o.textContent = user.family.split(",")[0]!;
      fam.append(o);
    }
    fam.value = user?.family ?? "";
    const size = document.createElement("input");
    size.type = "number";
    size.min = "6";
    size.max = "120";
    size.style.cssText = "flex:0 0 72px;width:72px";
    fam.style.cssText = "flex:1 1 auto;min-width:0";
    size.placeholder = doc?.size ? String(Math.round(doc.size)) : t("font.default");
    size.title = t("font.sizeTitle", { fallback: t(doc?.size ? "font.followFile" : "font.factory") });
    if (user?.size) size.value = String(Math.round(user.size * 10) / 10);
    const box = document.createElement("span");
    box.style.cssText = "display:flex;gap:6px;align-items:center";
    box.append(fam, size);
    rows.push(labeled(t(`role.${role}`), box));
    const init = JSON.stringify([fam.value, size.value]);
    reads.push(() => {
      if (JSON.stringify([fam.value, size.value]) === init) return false;
      const n = parseFloat(size.value);
      app.style.setHeaderFont(role, { family: fam.value || null, size: Number.isFinite(n) && n > 0 ? n : null });
      return true;
    });
  }
  const title = document.createElement("div");
  title.style.cssText = "margin-top:8px;font-weight:600;opacity:0.8";
  title.textContent = t("role.group");
  return { rows: [title, ...rows], apply: () => reads.map((r) => r()).some(Boolean) };
}

/** 纸张键的显示名：「长图」是个键，界面上按语言显示。 */
const paperName = (k: string): string => (k === "长图" ? t("paper.longImage") : k);

const isPaperKey = (k: string | undefined): boolean => k !== undefined && (ORIGINAL_PAPERS as readonly string[]).includes(k);

const SETTINGS_TAB_KEY = "dolce-settings-tab";

/** 设置面板的标签页：顶上一排标签，下面各页一个 `settings-form`。空页不显示；记住上次停在哪一页。 */
function settingsTabs(pages: readonly [string, string, HTMLElement][]): HTMLElement {
  const wrap = document.createElement("div");
  const bar = document.createElement("div");
  bar.className = "settings-tabs";
  bar.setAttribute("role", "tablist");
  wrap.append(bar);
  const shown = pages.filter(([, , el]) => el.childElementCount > 0);
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SETTINGS_TAB_KEY);
  } catch {
    saved = null;
  }
  const tabs: HTMLButtonElement[] = [];
  const select = (i: number) => {
    shown.forEach(([, , el], j) => (el.hidden = j !== i));
    tabs.forEach((tab, j) => {
      tab.classList.toggle("active", j === i);
      tab.setAttribute("aria-selected", String(j === i));
    });
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, shown[i]![0]);
    } catch {
      // 存不了就每次从第一页开始
    }
  };
  shown.forEach(([, label, el], i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = label;
    tab.setAttribute("role", "tab");
    tab.onclick = () => select(i);
    tabs.push(tab);
    bar.append(tab);
    el.className = "settings-form settings-pane";
    el.setAttribute("role", "tabpanel");
    wrap.append(el);
  });
  const at = shown.findIndex(([id]) => id === saved);
  if (shown.length) select(at >= 0 ? at : 0);
  return wrap;
}

export function showOptionsDialog(app: App): void {
  // 三个标签页：版面 / 页眉与样式 / 其他（一页摆全太高，小屏上确定按钮都够不着）
  const pLayout = document.createElement("div");
  const pHeader = document.createElement("div");
  const pOther = document.createElement("div");

  const view = app.viewMode;
  const isMixed = app.mode === "mixed"; // 五线谱 / 混排
  /** 投影档：两种格式同一条投影档排版，摆同一组设置。 */
  const isPpt = !isMixed && view === "expanded";
  /** 简谱（投影档或简谱档，各格式同一组设置） */
  const isJp = !isMixed;
  const isJianpu = isJp && view === "original";
  /** 「每页行数」写进 `.jpwabc` 的 `.Layout` 段，文本谱与 123 没有这个段。 */
  const hasLayoutSection = isPpt && app.docFormat === "jpwabc";

  const num = (value: number, min: number, max: number): HTMLInputElement => {
    const el = document.createElement("input");
    el.type = "number";
    el.min = String(min);
    el.max = String(max);
    el.value = String(value);
    return el;
  };
  const note = (text: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.style.cssText = "margin-top:4px;opacity:0.75;font-size:12px;line-height:1.6";
    el.textContent = text;
    return el;
  };

  // ---- 纸张 ----
  // 投影档取 PAGE_RATIOS 的**绝对尺寸**（导出 PPTX 就是这个纸）；简谱档只取**比例**，
  // 纸宽锁定（见 App.layoutPage），所以两档虽然共用这张表，选中项各按各的算。
  /** 纸张下拉。`withSize` 时把实际尺寸写进选项文字——简谱档选的是**纸**（「A4」不该还要人
   *  去猜多大）；投影档选的是**比例**（「16:9」本身就说清楚了），照旧只写键名。
   *  值为 null 的那一档是「长图」：不是纸，宽固定、高由内容定。 */
  const paperSelect = (
    keys: readonly string[],
    sizeOf: (k: string) => [number, number] | null,
    selected: (k: string) => boolean,
    withSize: boolean,
  ): HTMLSelectElement => {
    const el = document.createElement("select");
    for (const k of keys) {
      const wh = sizeOf(k);
      const o = document.createElement("option");
      o.value = k;
      o.textContent = withSize && wh ? `${k}（${wh[0]}×${wh[1]}pt）` : paperName(k);
      o.selected = selected(k);
      el.append(o);
    }
    return el;
  };

  // 投影档是投影片，选的是 16:9 / 4:3 那几个比例；简谱档选的是实际纸张，外加一档长图。
  const ratio = paperSelect(
    Object.keys(PAGE_RATIOS),
    (k) => PAGE_RATIOS[k],
    (k) => PAGE_RATIOS[k][0] === app.style.pageW && PAGE_RATIOS[k][1] === app.style.pageH,
    false,
  );
  // 纸张栏（纸 + 方向 + 边距）：简谱档、五线谱/混排两档各记各的；
  // 五线谱/混排自己一张纸（出厂 155×240mm），不借简谱档那张长图
  const paperEngine: PaperEngine | null = isMixed ? "staff" : isJianpu ? "jianpu" : null;
  const paperUi = paperEngine ? paperGroup(app, paperEngine) : null;

  // ---- 每页行数（写进文档 .Layout 段，只有 jpwabc 有这个段）----
  const lines = document.createElement("input");
  lines.type = "text";
  lines.placeholder = t("settings.linesPlaceholder");
  lines.value = hasLayoutSection ? app.getLinesPerPage() : "";
  // 「每页行数」只归投影档：那一档是逐段展开、一屏一段，每页放几行是版面决定；
  // 简谱档按原谱排一遍，行数由内容与纸说了算，人为定死只会把谱挤坏。
  const linesRow = labeled(t("settings.linesPerPage"), lines);

  // ---- 字号 ----
  const fs = num(app.style.fontSize, 12, 72);

  const color = colorInput(app.style.color);
  const bgColor = colorInput(app.style.bgColor);

  if (paperUi) {
    pLayout.append(...paperUi.rows);
  } else if (isPpt) {
    pLayout.append(labeled(t("settings.ratio"), ratio));
  }
  if (hasLayoutSection) pLayout.append(linesRow);
  if (isJp) {
    pLayout.append(labeled(t("settings.fontSize"), fs));
    // 简谱档只调基础字号：那一档的标题与词曲字号是按比例派生的（`style/jianpu.ts::jianpuSizes`），
    // 摆出来只会让人以为能单独调。投影档三个都是独立设置，照旧全给。
    pLayout.append(labeled(t("settings.color"), color));
  }
  pLayout.append(labeled(t("settings.bgColor"), bgColor));

  // 混排专属：隐藏小节号。
  const hideBarNum = document.createElement("input");
  hideBarNum.type = "checkbox";
  hideBarNum.checked = app.mixedHideBarNumber;
  // 五线谱/混排的「基础字号」：谱表大小（mm）+ 歌词字号（pt），留空 = 跟随文件（没写就是出厂 7mm）
  const ss = app.style.staffSizeState();
  const staffMm = num(0, 3, 15);
  staffMm.step = "0.1";
  staffMm.value = ss.user.mm ? String(ss.user.mm) : "";
  staffMm.placeholder = ss.doc.mm ? t("settings.staffFollow", { v: ss.doc.mm }) : t("settings.factoryValue", { v: 7 });
  const lyricPt = num(0, 5, 40);
  lyricPt.step = "0.5";
  lyricPt.value = ss.user.lyricPt ? String(ss.user.lyricPt) : "";
  lyricPt.placeholder = ss.doc.lyricPt ? t("settings.staffFollow", { v: ss.doc.lyricPt }) : t("settings.factoryValue", { v: 9.9 });
  const staffInit = JSON.stringify([staffMm.value, lyricPt.value]);
  if (isMixed) {
    pLayout.append(labeled(t("settings.staffSize"), staffMm), labeled(t("settings.lyricSize"), lyricPt), labeled(t("settings.hideBarNumbers"), hideBarNum));
  }

  if (isMixed) {
    pLayout.append(note(t("settings.staffNote")));
  }

  // 可视化编辑：谱面上插入/改音时响一下（只在简谱档、能改谱的格式下摆出来）
  const noteSound = document.createElement("input");
  noteSound.type = "checkbox";
  noteSound.checked = app.visual.noteSound;
  const showNoteSound = app.mode === "jp" && app.editDialect() !== null;
  // 界面语言：确定后即时切换，不重载
  const langSel = document.createElement("select");
  for (const [v, label] of [["auto", t("settings.lang.auto")], ["zh", t("lang.zh")], ["en", t("lang.en")]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = v === getLangPref();
    langSel.append(o);
  }
  pOther.append(labeled(t("settings.lang"), langSel));
  if (showNoteSound) pOther.append(labeled(t("settings.noteSound"), noteSound));

  // 诗集样式表：显示当前生效的那份与来源；选择 / 不用 / 恢复自动查找 /（123、ABC）写进文件
  const bs = app.style.bookSheet;
  const bsText = document.createElement("span");
  bsText.style.cssText = "opacity:0.85;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  bsText.textContent = bs
    ? `${t(bs.source === "ref" ? "status.bookSheet.ref" : bs.source === "manual" ? "settings.bookSheet.manual" : "status.bookSheet.auto")}：${bs.path.split(/[\\/]/).pop()}`
    : t("settings.bookSheet.none");
  bsText.title = bs?.path ?? "";
  const bsBtn = (label: string, fn: () => void | Promise<unknown>): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = () => {
      document.querySelector(".modal-overlay")?.remove(); // 换了样式表面板上的值都变了，关掉重开
      void Promise.resolve(fn()).then(() => showOptionsDialog(app));
    };
    return b;
  };
  const bsBox = document.createElement("span");
  bsBox.style.cssText = "display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap";
  bsBox.append(bsText, bsBtn(t("settings.bookSheet.choose"), () => app.style.chooseBookSheet()), bsBtn(t("settings.bookSheet.disable"), () => app.style.disableBookSheet()), bsBtn(t("settings.bookSheet.auto"), () => app.style.resetBookSheet()));
  if (bs && (app.docFormat === "123" || app.docFormat === "abc") && app.filePath) {
    bsBox.append(bsBtn(t("settings.bookSheet.write"), () => { app.style.writeBookSheetRef(); }));
  }
  pHeader.append(labeled(t("settings.bookSheet"), bsBox));

  // 简谱档的音符字体、和弦升降号写法：各格式共用一套
  const choice = (opts: readonly (readonly [string, MsgKey])[], value: string): HTMLSelectElement => {
    const el = document.createElement("select");
    for (const [v, label] of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t(label);
      o.selected = v === value;
      el.append(o);
    }
    return el;
  };
  const noteFontSel = choice([["", "settings.noteFont.follow"], ...NOTE_FONTS.map((f) => [f.id, `settings.noteFont.${f.id}` as MsgKey] as const)], app.style.noteFont);
  const chordAccSel = choice([["", "settings.chordAccidental.source"], ["before", "settings.chordAccidental.before"], ["after", "settings.chordAccidental.after"]], app.style.chordAccidental);
  if (isJianpu) {
    pHeader.append(labeled(t("settings.noteFont"), noteFontSel), labeled(t("settings.chordAccidental"), chordAccSel));
  }
  const pairPages = document.createElement("input");
  pairPages.type = "checkbox";
  pairPages.checked = app.style.pairPages;
  if (isJp && view === "expanded") pLayout.append(labeled(t("settings.pairPages"), pairPages));
  const noIntro = document.createElement("input");
  noIntro.type = "checkbox";
  noIntro.checked = app.style.noIntro;
  if (isJp && view === "expanded") pLayout.append(labeled(t("settings.noIntro"), noIntro));

  // 页眉四项的字体字号：各档共用（投影档原来单列的标题 / 词曲字号也并在这里）
  const header = headerGroup(app);
  pHeader.append(...header.rows);

  // MusicXML（打开的、五线谱识别出的）落地后用哪种源码格式编辑（缺省 ABC，装不下自动改用建议的格式）
  const xmlImport = document.createElement("select");
  for (const [v, label] of [
    ["musicxml", t("settings.xml.keep")],
    ...CONVERT_TARGETS.map((c) => [c.id, t("settings.xml.convert", { format: targetLabel(c.id) })] as const),
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = v === app.musicXmlImport;
    xmlImport.append(o);
  }
  pOther.append(labeled(t("settings.xml.open"), xmlImport));

  // 各声部音量、静音、独奏挪到工具条「声部」面板（`editor/parts.ts`），这里留一句指引
  if (app.partCount > 1) {
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:8px;opacity:0.8";
    hint.textContent = t("settings.partsHint");
    pOther.append(hint);
  }

  // 「长图」一勾一取消，「每页行数」要跟着出现/消失——现开现关，不必确定后才知道。
  const body = settingsTabs([
    ["layout", t("settings.tab.layout"), pLayout],
    ["header", t("settings.tab.header"), pHeader],
    ["other", t("settings.tab.other"), pOther],
  ]);

  modal(t("settings.title"), body, () => {
    // 没摆出来的项一律不回灌：把它们的初值当用户输入送回去，等于替用户做了没做过的决定。
    const [w, h] = isPpt ? PAGE_RATIOS[ratio.value] ?? [app.style.pageW, app.style.pageH] : [undefined, undefined];
    const fontSize = isJp ? parseInt(fs.value, 10) || app.style.fontSize : undefined;
    header.apply(); // 先落用户层，下面 applyRenderSettings 统一存盘并重排
    const argb = isJp ? colorValue(color, app.style.color) : undefined;
    if (hasLayoutSection) {
      const linesVal = lines.value.trim();
      if (linesVal !== app.getLinesPerPage()) app.setLinesPerPage(linesVal);
    }
    app.applyRenderSettings({
      pageW: w, pageH: h, fontSize,
      paper: (() => {
        const c = paperUi?.read();
        return paperEngine && c ? { [paperEngine]: c } : undefined;
      })(),
      staffSize: isMixed && JSON.stringify([staffMm.value, lyricPt.value]) !== staffInit
        ? { mm: parseFloat(staffMm.value) || null, lyricPt: parseFloat(lyricPt.value) || null }
        : undefined,
      color: argb, bgColor: colorValue(bgColor, app.style.bgColor),
      ...(isJp && view === "expanded" && pairPages.checked !== app.style.pairPages ? { pairPages: pairPages.checked } : {}),
      ...(isJp && view === "expanded" && noIntro.checked !== app.style.noIntro ? { noIntro: noIntro.checked } : {}),
      ...(isJianpu ? {
        ...(noteFontSel.value !== app.style.noteFont ? { noteFont: noteFontSel.value } : {}),
        ...(chordAccSel.value !== app.style.chordAccidental ? { chordAccidental: chordAccSel.value as "" | "before" | "after" } : {}),
      } : {}),
    });
    if (isMixed) void app.setMixedHideBarNumber(hideBarNum.checked);
    if (xmlImport.value !== app.musicXmlImport) {
      app.musicXmlImport = xmlImport.value as typeof app.musicXmlImport;
      app.saveSettings();
    }
    if (showNoteSound && noteSound.checked !== app.visual.noteSound) app.visual.setNoteSound(noteSound.checked);
    if (langSel.value !== getLangPref()) setLangPref(langSel.value as LangPref);
  }, undefined, isMixed ? undefined : {
    // 清掉当前档（投影 / 简谱）的用户层，回到内置主题；另一档与声部音量不动
    label: t("settings.reset"),
    onClick: () => app.resetRenderSettings(),
  });
}
