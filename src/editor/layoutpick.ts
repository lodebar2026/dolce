// 版面下拉（规范 123格式 §9.1 自定义版面）：档位按钮旁列「这一档的内置版面 + 本曲照这一档排的自定义版面」，
// 末尾「新建版面…」「删除版面」改原文的 `%%layout` 行（一次 `setText`、一步撤销）。只 123 / ABC 显示。

import type { ScoreDoc } from "../model/doc";
import { customLayouts, viewOfLayout, VIEW_LAYOUT, type LayoutView } from "../jianpu/layoutdoc";
import { dolce } from "../common/dolce";
import { PAGE_RATIOS, PAPER_SIZES } from "../style/themes";
import { t, type MsgKey } from "../i18n";
import { labeled, showConfirmDialog, showFormDialog } from "./dialogs";

/** 下拉要的宿主能力（App 实现） */
export interface LayoutPickHost {
  readonly docFormat: string;
  readonly viewMode: LayoutView;
  readonly customLayout: string | null;
  setCustomLayout(name: string | null): Promise<void>;
  currentScoreDoc(): ScoreDoc | null;
  getText(): string;
  setText(text: string): void;
  setStatus(msg: string): void;
}

const NEW = "\u0000new";
const DEL = "\u0000del";

/** 版面名不能带空白与 `=`（`%%layout 名 键=值` 按空白切），也不能撞内置名 */
function badName(name: string, taken: ReadonlySet<string>): boolean {
  return !name || /[\s=,*]/.test(name) || taken.has(name) || (Object.values(VIEW_LAYOUT) as string[]).includes(name);
}

export class LayoutPicker {
  constructor(
    private readonly host: LayoutPickHost,
    private readonly sel: HTMLSelectElement,
  ) {
    sel.addEventListener("change", () => void this._onChange());
  }

  /** 原文或档位变了：重列选项（选中的自定义版面没了就回内置） */
  sync(): void {
    const h = this.host;
    const on = h.docFormat === "123" || h.docFormat === "abc";
    this.sel.hidden = !on;
    if (!on) return;
    const view = h.viewMode;
    const customs = customLayouts(h.currentScoreDoc()?.songs[0]).filter((l) => viewOfLayout(l) === view);
    const cur = h.customLayout !== null && customs.some((l) => l.name === h.customLayout) ? h.customLayout : null;
    const opts: [string, string][] = [["", t(`view.${view}` as MsgKey)]];
    for (const l of customs) opts.push([l.name, l.name]);
    opts.push([NEW, t("layout.new")]);
    if (cur !== null) opts.push([DEL, t("layout.delete", { name: cur })]);
    this.sel.replaceChildren(...opts.map(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      return o;
    }));
    this.sel.value = cur ?? "";
  }

  private async _onChange(): Promise<void> {
    const h = this.host;
    const v = this.sel.value;
    if (v === NEW) {
      this.sync();
      this._newDialog();
    } else if (v === DEL) {
      const name = h.customLayout;
      this.sync();
      if (name !== null && (await showConfirmDialog(t("layout.delete", { name }), t("layout.deleteConfirm", { name })))) {
        const text = h.getText();
        const songs = Math.max(1, h.currentScoreDoc()?.songs.length ?? 1);
        let out = text;
        for (let i = 0; i < songs; i++) out = dolce().abcRemoveLayout(out, i, name);
        await h.setCustomLayout(null);
        if (out !== text) h.setText(out);
      }
    } else {
      await h.setCustomLayout(v || null);
    }
  }

  /** 新建：名、照哪一档、纸、音符字号；写进第一首（多首时每首都写） */
  private _newDialog(): void {
    const h = this.host;
    const body = document.createElement("div");
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = t("layout.namePlaceholder");
    const base = document.createElement("select");
    for (const v of Object.keys(VIEW_LAYOUT) as LayoutView[]) {
      const o = document.createElement("option");
      o.value = VIEW_LAYOUT[v];
      o.textContent = t(`view.${v}` as MsgKey);
      base.append(o);
    }
    base.value = VIEW_LAYOUT[h.viewMode];
    const paper = document.createElement("select");
    const fillPapers = (): void => {
      const proj = base.value === VIEW_LAYOUT.expanded;
      const names = proj ? Object.keys(PAGE_RATIOS) : Object.keys(PAPER_SIZES);
      paper.replaceChildren(...["", ...names].map((p) => {
        const o = document.createElement("option");
        o.value = p;
        o.textContent = p || t("layout.paperInherit");
        return o;
      }));
    };
    fillPapers();
    base.addEventListener("change", fillPapers);
    const size = document.createElement("input");
    size.type = "number";
    size.min = "6";
    size.max = "96";
    size.placeholder = t("layout.paperInherit");
    body.append(
      labeled(t("layout.name"), name),
      labeled(t("layout.base"), base),
      labeled(t("layout.paper"), paper),
      labeled(t("layout.noteSize"), size),
    );
    showFormDialog(t("layout.newTitle"), body, () => {
      const n = name.value.trim();
      const doc = h.currentScoreDoc();
      const taken = new Set((doc?.songs ?? []).flatMap((s) => (s.layouts ?? []).map((l) => l.name)));
      if (badName(n, taken)) {
        h.setStatus(t("layout.badName", { name: n }));
        return;
      }
      const sz = Number(size.value);
      const text = h.getText();
      const songs = Math.max(1, doc?.songs.length ?? 1);
      let out = text;
      for (let i = 0; i < songs; i++) {
        out = dolce().abcSetLayoutOption(out, i, n, "base", base.value);
        if (paper.value) out = dolce().abcSetLayoutOption(out, i, n, "paper", paper.value);
        if (size.value && Number.isFinite(sz) && sz > 0) out = dolce().abcSetLayoutOption(out, i, n, "note-size", String(sz));
      }
      if (out === text) return;
      h.setText(out);
      void h.setCustomLayout(n);
    });
  }
}
