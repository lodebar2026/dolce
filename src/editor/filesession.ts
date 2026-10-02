// 文件会话：打开 / 保存 / 另存、上次文件、自动保存草稿与未保存保护、存识别项目。
//
// 从 `app.ts` 原样搬出来的一块（照 `PlaybackController` / `OmrController` 的做法）：文档本身的状态
// （原文、格式、`filePath`）仍在 App，这里只通过 `FileHost` 要；读进来的内容怎么落地（`importBytes` /
// `openProject` / `adoptText`）也仍是 App 的事。

import { isTauriRuntime, saveBytes } from "./fileio";
import { DOC_EXT, acceptAttr, isProjectFile } from "../common/filetypes";
import { clearDraft, loadDraft, saveDraft, type Draft } from "./autosave";
import { formatOf, type DocFormatId, type FormatAdapter } from "./formats";
import { describeLosses, planSave } from "../model/capability";
import { packProject, PROJECT_EXT, type ProjectSnapshot } from "./omrproject";
import { clearLastFile, loadLastFile, saveLastFile } from "./settings";
import { targetSpec, type ConvertTarget } from "../model/convert";
import { showConfirmDialog } from "./dialogs";
import { t } from "../i18n";
import { targetLabel } from "../i18n/labels";
import type { ScoreDoc } from "../model/doc";

/** 文件会话向 App 要的那些能力（**列全**）。 */
export interface FileHost {
  filePath: string | null;
  readonly docFormat: DocFormatId;
  readonly adapter: FormatAdapter;
  readonly omr: { snapshot(): ProjectSnapshot | null };
  getText(): string;
  setStatus(s: string): void;
  importBytes(bytes: Uint8Array, name: string): void;
  openProject(bytes: Uint8Array, name: string, opts?: { draft?: boolean }): Promise<boolean>;
  adoptText(format: DocFormatId, text: string, filePath: string | null): void;
  loadBookSheet(): Promise<void>;
  onDocumentOpened(): Promise<void>;
  /** 当前文档的 `ScoreDoc`（丢失清单要用） */
  scoreDoc(): ScoreDoc | null;
  /** 当前文档 → 目标格式的文本；转不了返回 null */
  convertTo(target: ConvertTarget): string | null;
  documentTitle(): string;
  /** 存到 XML 路径上时写的那份 MusicXML（`export.ts::buildMusicXml`） */
  musicXmlForSave(): Promise<string>;
}

export class FileSession {
  constructor(private host: FileHost) {}

  /** 记住上次打开/保存的文件路径（仅 Tauri：浏览器路径不可复读）。 */
  rememberLastFile(path: string): void {
    saveLastFile(path);
  }

  /** 启动时尝试复读上次打开的文件（仅 Tauri）。返回 true 表示已加载，false 则保持示例文本。 */
  async tryRestoreLastFile(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    const path = loadLastFile();
    if (!path) return false;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      if (isProjectFile(path)) {
        if (!(await this.host.openProject(bytes, path))) throw new Error("bad project");
      } else this.host.importBytes(bytes, path);
      this.host.filePath = path;
      void this.host.loadBookSheet();
      return true;
    } catch {
      // 文件已被移动/删除/不可读 — 忘掉它，回退到示例
      clearLastFile();
      return false;
    }
  }

  async openFile(): Promise<boolean> {
    // 没有没存的内容时不 await：浏览器版下面的 `input.click()` 得留在点击手势的同步调用栈里（Safari 隔一个 await 就不弹选文件框）
    if (this.isDirty() && !(await this.confirmReplace())) return false;
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sel = await open({
        multiple: false,
        filters: [
          {
            name: t("filter.scoreDocs"),
            // 白名单只在 `common/filetypes.ts` 写一次；`.jpwabc` 另给大写形（部分系统区分）
            extensions: [...DOC_EXT, "JPWABC"],
          },
        ],
      });
      if (typeof sel !== "string") return false;
      const bytes = await readFile(sel);
      this.host.importBytes(bytes, sel);
      this.host.filePath = sel;
      this.rememberLastFile(sel);
      void this.host.onDocumentOpened();
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const input = document.createElement("input");
      let settled = false;
      let changeStarted = false;
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        resolve(opened);
      };
      input.type = "file";
      input.accept = acceptAttr(DOC_EXT);
      input.onchange = async () => {
        changeStarted = true;
        const file = input.files?.[0];
        if (!file) { finish(false); return; }
        const buf = new Uint8Array(await file.arrayBuffer());
        this.host.importBytes(buf, file.name);
        this.host.filePath = file.name;
        finish(true);
        void this.host.onDocumentOpened();
      };
      window.addEventListener("focus", () => setTimeout(() => {
        if (!changeStarted) finish(false);
      }, 500), { once: true });
      input.click();
    });
  }

  async saveFile(): Promise<void> {
    // 有识别会话：存成识别项目（原图、识别结果、在改的原文一起），重开接着核对；只要文本用「另存为」
    if (this.host.omr.snapshot()) {
      await this.saveProject(false);
      return;
    }
    if (this.host.filePath && isTauriRuntime()) {
      // 存回原文件 = 原格式进原格式出，不会丢东西，不必问
      await this.writeTo(this.host.filePath);
      this.markClean();
      return;
    }
    await this.saveFileAs();
  }

  async saveFileAs(): Promise<void> {
    // 落盘细节（对话框 / a[download]）统一在 fileio.saveBytes，这里只管记住路径。
    const dest = await saveBytes(this.encodeForSave(), this.defaultSaveName());
    // 桌面版没给路径 = 对话框里取消了，没存
    if (!dest && isTauriRuntime()) return;
    // 浏览器版下载不回路径，也算存过了
    this.markClean();
    if (!dest) return;
    this.host.filePath = dest;
    this.rememberLastFile(dest);
  }

  /** 跨格式另存为：**先算会丢什么，列给用户，确认了再写**（`model/capability.ts`）。
   *  同格式存回不走这条——那是原文进原文出。 */
  async saveAsFormat(target: ConvertTarget): Promise<void> {
    const doc = this.host.scoreDoc();
    if (doc) {
      const losses = planSave(doc, target);
      if (losses.length) {
        const ok = await showConfirmDialog(t("saveAs.lossTitle"), describeLosses(target, losses));
        if (!ok) return;
      }
    }
    const text = this.host.convertTo(target);
    if (text === null) {
      this.host.setStatus(t("status.saveAsUnsupported", { target }));
      return;
    }
    const adapter = formatOf(targetSpec(target).docFormat);
    const dest = await saveBytes(adapter.encode(text), (this.host.documentTitle() || t("file.untitled")) + adapter.defaultExt);
    if (!dest) return;
    this.host.setStatus(t("status.savedAs", { format: targetLabel(target), ext: adapter.defaultExt }));
  }

  // ---------------- 自动保存与崩溃恢复（`autosave.ts`） ----------------
  /** 与盘上（或刚打开时）一致的那份原文；null = 还没有这样一份（刚识别完、恢复的草稿） */
  _cleanText: string | null = null;
  private _draftTimer: ReturnType<typeof setTimeout> | undefined;

  /** 有没存的内容：与盘上（或刚打开时）那份不一样，或根本没有那样一份（刚识别完、恢复的草稿）。 */
  isDirty(): boolean {
    return this.host.getText() !== this._cleanText;
  }

  /** 要用别的内容换掉当前文档（打开、拖入、示例、识别）或关窗之前：有没存的内容就先问。返回 false = 用户不换了。 */
  async confirmReplace(closing = false): Promise<boolean> {
    if (!this.isDirty()) return true;
    return showConfirmDialog(t("unsaved.title"), t(closing ? "unsaved.closeBody" : "unsaved.body"));
  }

  /** 现在的内容与盘上一致（刚存盘、刚打开）：草稿作废。 */
  markClean(): void {
    this._cleanText = this.host.getText();
    clearTimeout(this._draftTimer);
    void clearDraft();
  }

  /** 改过之后 3 秒存一份草稿；内容与盘上一致就删掉草稿。识别会话连原图一起打包（恢复后不必重新识别）。 */
  _scheduleDraft(): void {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      const text = this.host.getText();
      if (text === this._cleanText) {
        void clearDraft();
        return;
      }
      const snap = this.host.omr.snapshot();
      void saveDraft({
        time: Date.now(), filePath: this.host.filePath, docFormat: this.host.docFormat, text,
        ...(snap ? { project: packProject(snap, __APP_VERSION__, true) } : {}),
      });
    }, 3000);
  }

  /** 启动时先把草稿读出来——之后恢复上次的文件会 `markClean` 删掉它（`offerDraftRestore` 拿这份问）。 */
  takeDraft(): Promise<Draft | null> {
    return loadDraft();
  }

  /** 启动时：有上次没存的草稿（且与现在打开的不同）就问要不要恢复。恢复了返回 true。 */
  async offerDraftRestore(d: Draft | null): Promise<boolean> {
    if (!d || d.text === this.host.getText()) return false;
    const when = new Date(d.time).toLocaleString();
    const what = d.project ? t("draft.session") : d.filePath ? d.filePath.replace(/^.*[\\/]/, "") : t("draft.untitled");
    const ok = await showConfirmDialog(t("draft.title"), t("draft.body", { what, when }));
    if (!ok) {
      void clearDraft();
      return false;
    }
    // 恢复回来的还没存：草稿留着（不 markClean），打不开识别项目就只恢复文本
    if (!d.project || !(await this.host.openProject(d.project, d.filePath ?? "", { draft: true }))) {
      this.host.adoptText(d.docFormat as DocFormatId, d.text, d.filePath);
    }
    this._cleanText = null;
    this._scheduleDraft();
    this.host.setStatus(t("draft.restored"));
    return true;
  }

  // ---------------- 识别项目 `.dolce`（`omrproject.ts`） ----------------
  /** 存识别项目。桌面版已有 `.dolce` 路径且不是「另存」就直接覆盖，否则问路径（浏览器版下载）。 */
  async saveProject(asNew: boolean): Promise<boolean> {
    const snap = this.host.omr.snapshot();
    if (!snap) {
      this.host.setStatus(t("proj.nothing"));
      return false;
    }
    const bytes = packProject(snap, __APP_VERSION__);
    if (!asNew && this.host.filePath && isProjectFile(this.host.filePath) && isTauriRuntime()) {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(this.host.filePath, bytes);
    } else {
      const dest = await saveBytes(bytes, `${this.host.documentTitle() || t("proj.defaultName")}.${PROJECT_EXT}`, "application/zip");
      if (!dest && isTauriRuntime()) return false; // 对话框里取消了，没存
      if (dest) {
        this.host.filePath = dest;
        this.rememberLastFile(dest);
      }
    }
    this.markClean();
    this.host.setStatus(t("proj.saved"));
    return true;
  }

  /** 存盘用的文件名：扩展名由适配器给。 */
  private defaultSaveName(): string {
    return (this.host.documentTitle() || t("file.untitled")) + this.host.adapter.defaultExt;
  }

  /** 存盘编码：文本谱等是 UTF-8 原文，`.jpwabc` 是 JP-Word 的 UTF-16LE+BOM。 */
  private encodeForSave(): Uint8Array {
    return this.host.adapter.encode(this.host.getText());
  }

  /** 盘上那份文件是不是 MusicXML（文本格式另存到 XML 路径时，编辑器里是简谱文本、盘上是 XML）。 */
  private get onDiskIsXml(): boolean {
    return this.host.filePath !== null && /\.(xml|musicxml)$/i.test(this.host.filePath);
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    // `.musicxml` 那一档：文档里就是 XML（未改动是原文，改过的已由 `editScoreDoc` 整份重写）。
    // 其余格式存到 XML 路径上：由唯一写出端整份重写。
    const bytes = this.host.docFormat === "musicxml"
      ? this.encodeForSave()
      : this.onDiskIsXml
        ? new TextEncoder().encode(await this.host.musicXmlForSave())
        : this.encodeForSave();
    await writeFile(path, bytes);
  }
}
