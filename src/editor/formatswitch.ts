// 代码区标题栏的**格式下拉**：代码区里这份文本换成别的源格式。
//
// 两种东西用它，下拉本身（控件、显隐、手改确认）共用这一份，切换怎么做各自实现 `FormatSource`：
//   - 识别结果（`OmrController`）：真身是 `RecognizedScore`，切格式 = 从识别结果重出文本、不重跑识别；
//   - 打开的文件与五线谱识别结果（下面的 `DocFormatSource`）：真身起初是**原文**，在哪种格式里改过就换成那份。
//     切到别的格式 = 从真身的模型写出（装不下的先列出来、给出装得下的建议格式）；切回真身的格式 = 逐字还原。
// 两者出文本走同一张转换目标表（`convert/targets.ts`）。
//
// 下拉顶掉格式标签（`index.html` 的 `#doc-format-field`）：切的本来就是代码区里这份文本是什么格式。

import type { ScoreDoc } from "../model/doc";
import { CONVERT_TARGETS, targetSpec, type ConvertTarget } from "../convert/targets";
import { describeLosses, planSave, type Loss } from "../convert/capability";
import { scoreDocToMusicXml } from "../model/toxml";
import type { DocFormatId } from "./formats";
import { showChoiceDialog, showConfirmDialog } from "./dialogs";
import { t } from "../i18n";

/** 下拉里的一项。 */
export interface FormatOption {
  value: string;
  label: string;
}

/** 下拉旁的一行提示（转换丢了什么、怎么回到原稿）。 */
export interface FormatNote {
  text: string;
  /** 悬停看的细节（丢了哪几样） */
  title?: string;
  action?: { label: string; run(): void };
}

/** 一种「代码区文本从哪儿来、能换成哪些格式」。 */
export interface FormatSource {
  options(): readonly FormatOption[];
  /** 当前选中的那一项 */
  current(): string;
  /** 切到 `value`。返回 false 表示没切（用户取消、转换失败），下拉拨回原值 */
  switchTo(value: string): Promise<boolean>;
  /** 下拉旁的提示；没有为 null */
  note?(): FormatNote | null;
  /** 还是原稿 `origin`（没改过，只是换了格式看） */
  pristineOf?(origin: string): boolean;
  /** 接着上回（识别项目重开）：现在在 `value` 那种格式里、原文是 `text`（当它是改过的，成为真身） */
  resume?(value: string, text: string): void;
}

/** 代码区文本被手工改过时，切格式会用真身重出文本、丢掉这些改动：先问一声。 */
export function confirmDiscardEdits(): Promise<boolean> {
  return showConfirmDialog(
    t("fs.confirmTitle"),
    t("fs.confirmBody"),
  );
}

export interface FormatSwitchHost {
  /** 上下文相关控件的显隐 */
  setContextControl(el: Element | null, on: boolean): void;
  /** 下拉显隐变了：格式标签跟着让位 */
  syncFormatLabel(): void;
}

export class FormatSwitch {
  private selectEl: HTMLSelectElement | null = null;
  private fieldEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private src: FormatSource | null = null;

  constructor(private host: FormatSwitchHost) {}

  get source(): FormatSource | null {
    return this.src;
  }

  bind(el: HTMLSelectElement): void {
    this.selectEl = el;
    this.fieldEl = el.closest<HTMLElement>(".pane-select-field, .toolbar-select-field") ?? el;
    // 等 change 事件整个返回再切：WKWebView 的原生下拉在回调里还拿着选项，切格式同步重建选项会让 WebContent 进程崩掉
    // （页面随即自动重载，启动时就问「恢复未保存的内容」）
    el.addEventListener("change", () => {
      const value = el.value;
      setTimeout(() => void this.choose(value), 0);
    });
    this.render();
  }

  /** 下拉旁的提示（`#doc-format-note`：一段字 + 一个链接样的按钮）。 */
  bindNote(el: HTMLElement): void {
    this.noteEl = el;
    this.refreshNote();
  }

  /** 原文改了（或换了来源）：提示重出。 */
  refreshNote(): void {
    const el = this.noteEl;
    if (!el) return;
    const note = this.src?.note?.() ?? null;
    el.hidden = note === null;
    el.replaceChildren();
    if (!note) return;
    const txt = document.createElement("span");
    txt.textContent = note.text;
    if (note.title) el.title = note.title;
    else el.removeAttribute("title");
    el.append(txt);
    if (note.action) {
      const { label, run } = note.action;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => run());
      el.append(btn);
    }
  }

  /** 换来源（`null` = 没有可切的，收起下拉、露出格式标签）。 */
  use(source: FormatSource | null): void {
    this.src = source;
    this.render();
  }

  /** 界面语言变了：选项文字重出。 */
  relabel(): void {
    this.render();
  }

  /** 来源的当前格式变了（不经下拉切的）：同步下拉的值。 */
  sync(): void {
    if (this.selectEl && this.src) this.selectEl.value = this.src.current();
    this.refreshNote();
  }

  private async choose(value: string): Promise<void> {
    const src = this.src;
    if (!src || value === src.current()) return;
    await src.switchTo(value);
    this.sync(); // 没切成就拨回原值
  }

  private render(): void {
    const el = this.selectEl;
    const opts = this.src?.options() ?? [];
    const same = el !== null && el.options.length === opts.length
      && opts.every((o, i) => el.options[i].value === o.value && el.options[i].textContent === o.label);
    if (el && !same) {
      // 选项没变就不重建
      el.replaceChildren();
      for (const { value, label } of opts) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        el.appendChild(opt);
      }
    }
    this.sync();
    this.host.setContextControl(this.fieldEl, this.src !== null);
    this.host.syncFormatLabel();
  }
}

// ───────────────────────── 打开的文件、五线谱识别结果 ─────────────────────────

/** `DocFormatSource` 向 App 要的能力。 */
export interface FileSwitchHost {
  getText(): string;
  readonly filePath: string | null;
  /** 按当前格式解析当前文本（App 那边有缓存）；读不出返回 null */
  scoreDoc(): ScoreDoc | null;
  /** 换成某种源格式的文本：切格式、设文件路径、设文本 */
  adoptText(format: DocFormatId, text: string, filePath: string | null): void;
  setStatus(text: string): void;
}

/** 原文是什么格式：可写出的文本格式（`123` / `tomato` …）、`musicxml`（没有代码区），
 *  以及 **jianpu-ly**（`jly`：能读能写，但**不在 `CONVERT_TARGETS` 那张表里** —— 它是独立实现）。 */
export type OriginFormat = ConvertTarget | "musicxml" | "jly";

function originName(origin: OriginFormat): string {
  if (origin === "musicxml") return "MusicXML";
  if (origin === "jly") return "jianpu-ly";
  return targetSpec(origin).label;
}

/** 下拉里原文那一项的显示名。 */
function originLabel(origin: OriginFormat): string {
  return t("fs.origin", { format: originName(origin) });
}

/** 某种格式的文本在编辑器里按哪种源格式打开。 */
function docFormatOf(f: OriginFormat): DocFormatId {
  return f === "musicxml" || f === "jly" ? f : targetSpec(f).docFormat;
}

/** 装不下时建议改用的格式，按这个次序取第一个装得下全部的：五线谱通行的 ABC、本项目的 123、无损的 MusicXML。 */
const SUGGEST_ORDER: readonly OriginFormat[] = ["abc", "123", "musicxml"];

/** 一份文本连同它是什么格式。 */
interface Version {
  format: OriginFormat;
  text: string;
  filePath: string | null;
  /** 它的模型（转出去要用；按需读） */
  doc: ScoreDoc | null;
}

/**
 * 打开的文件、五线谱识别结果：**真身跟着改动走**。
 *
 * - 真身起初是原文。切到别的格式 = 从真身的模型写出，先列装不下的（`planSave`）并给出装得下的建议格式；
 *   文件路径清空（存盘走另存为，原文件不动）。
 * - 切回真身的格式：逐字还原真身。所以「转成简谱看一眼再切回来」不丢东西。
 * - 在哪种格式里改过，再切走时**改过的文本就成了真身**（不丢改动、也不再问）；之后从它转。
 * - 原稿一直留着：在有损的格式里改过（或真身已经换成了它），下拉旁的提示给「放弃改动，回到原稿」。
 */
export class DocFormatSource implements FormatSource {
  /** 最初打开 / 识别出来的那份 */
  private readonly origin: Version;
  private truth: Version;
  private cur: OriginFormat;
  /** 上次写进代码区的文本；与当前文本不同即说明改过 */
  private emitted: string;
  /** 最初的原文（在原格式里改过，`origin.text` 会跟着换） */
  private readonly originText: string;
  /** 从原稿一路转过来丢掉的（空 = 没丢过，回不回原稿都一样） */
  private lost: Loss[] = [];

  constructor(
    private host: FileSwitchHost,
    origin: { format: OriginFormat; text: string },
  ) {
    this.origin = { format: origin.format, text: origin.text, filePath: host.filePath, doc: null };
    this.originText = origin.text;
    this.truth = this.origin;
    this.cur = origin.format;
    this.emitted = origin.text;
  }

  options(): readonly FormatOption[] {
    const out: FormatOption[] = [];
    const o = this.origin.format;
    if (o === "musicxml" || o === "jly") out.push({ value: o, label: originLabel(o) });
    for (const c of CONVERT_TARGETS) out.push({ value: c.id, label: c.id === o ? originLabel(c.id) : c.label });
    return out;
  }

  current(): string {
    return this.cur;
  }

  private has(f: OriginFormat): boolean {
    return this.options().some((o) => o.value === f);
  }

  /** 当前文本改过了：它成为真身（在真身的格式里改就是改真身）。 */
  private absorbEdits(): boolean {
    const text = this.host.getText();
    if (text === this.emitted && this.truth.doc) return true;
    const doc = this.host.scoreDoc();
    if (!doc) {
      this.host.setStatus(t("fs.unreadable"));
      return false;
    }
    if (this.cur === this.truth.format && this.truth !== this.origin) {
      this.truth.text = text;
      this.truth.doc = doc;
      this.truth.filePath = this.host.filePath;
    } else if (this.cur === this.origin.format && this.truth === this.origin) {
      // 在原格式里改：改过的就是新的原文（原文件路径以此刻为准，打开后才设上）
      this.origin.text = text;
      this.origin.doc = doc;
      this.origin.filePath = this.host.filePath;
    } else {
      this.truth = { format: this.cur, text, filePath: this.host.filePath, doc };
    }
    this.emitted = text;
    return true;
  }

  async switchTo(value: string): Promise<boolean> {
    if (value === this.cur) return true;
    if (!this.has(value as OriginFormat)) return false;
    if (!this.absorbEdits()) return false;
    let target = value as OriginFormat;
    if (target === this.truth.format) {
      this.adopt(this.truth);
      this.host.setStatus(t(this.truth === this.origin ? "fs.backToOrigin" : "fs.backTo", { format: originName(target) }));
      return true;
    }
    const doc = this.truth.doc!;
    let losses = planSave(doc, target);
    if (losses.length) {
      const pick = await this.confirmLosses(doc, target, losses);
      if (!pick) return false;
      if (pick !== target) {
        target = pick;
        if (target === this.truth.format) {
          this.adopt(this.truth);
          return true;
        }
        losses = planSave(doc, target);
      }
    }
    if (!this.convert(doc, target, losses)) return false;
    this.host.setStatus(t("fs.converted", { format: originName(target) }));
    return true;
  }

  /** 从真身的模型写出 `target` 落地。写不出返回 false（状态栏已说明）。 */
  private convert(doc: ScoreDoc, target: OriginFormat, losses: readonly Loss[]): boolean {
    let out: string;
    try {
      out = target === "musicxml" ? scoreDocToMusicXml(doc) : this.emitText(target, doc);
    } catch (e) {
      console.error("转换失败", e);
      this.host.setStatus(t("fs.failed", { error: (e instanceof Error ? e.message : String(e)) }));
      return false;
    }
    this.host.adoptText(docFormatOf(target), out, null);
    this.cur = target;
    this.emitted = out;
    for (const l of losses) if (!this.lost.some((x) => x.feature === l.feature)) this.lost.push(l);
    return true;
  }

  /**
   * 落地时换成默认编辑格式（不弹框）：`preferred` 装得下就用它；装不下改用建议的格式（ABC → 123 → MusicXML 取第一个装得下全部的），
   * 都装不下就留在原格式。返回落到的格式与 `preferred` 装不下的东西（给状态栏说明）。
   */
  autoSwitch(preferred: OriginFormat): { to: OriginFormat; lost: Loss[] } {
    if (!this.has(preferred) || !this.absorbEdits()) return { to: this.cur, lost: [] };
    const doc = this.truth.doc!;
    const lost = planSave(doc, preferred);
    const target = lost.length
      ? SUGGEST_ORDER.find((f) => this.has(f) && planSave(doc, f).length === 0) ?? this.truth.format
      : preferred;
    if (target === this.cur) return { to: target, lost };
    if (target === this.truth.format) {
      this.adopt(this.truth);
      return { to: target, lost };
    }
    return this.convert(doc, target, []) ? { to: target, lost } : { to: this.cur, lost };
  }

  private emitText(target: OriginFormat, doc: ScoreDoc): string {
    const spec = CONVERT_TARGETS.find((c) => c.id === target);
    if (!spec) throw new Error(target);
    return spec.emit(doc);
  }

  private adopt(v: Version): void {
    this.host.adoptText(docFormatOf(v.format), v.text, v.filePath);
    this.cur = v.format;
    this.emitted = v.text;
    if (v === this.origin) this.lost = [];
  }

  /** 装不下的先列出来：有装得下全部的格式就建议改用它。返回最后要转成的格式，取消为 null。 */
  private async confirmLosses(doc: ScoreDoc, target: OriginFormat, losses: readonly Loss[]): Promise<OriginFormat | null> {
    const from = originName(this.truth.format);
    const body = describeLosses(target, losses).replace(/\n\n[^\n]*$/, "") + "\n\n" + t("fs.lossHint", { from, to: originName(target) });
    // 真身自己的格式不算建议（那等于不转）
    const better = SUGGEST_ORDER.find((f) => f !== target && f !== this.truth.format && this.has(f) && planSave(doc, f).length === 0);
    if (!better) return (await showConfirmDialog(t("fs.lossTitle"), body + "\n\n" + t("loss.continue"))) ? target : null;
    const res = await showChoiceDialog(t("fs.lossTitle"), body, [
      { value: better, label: t("fs.useSuggested", { format: originName(better) }) },
      { value: target, label: t("fs.convertAnyway", { format: originName(target) }) },
    ], { defaultValue: better });
    return res?.value ?? null;
  }

  resume(value: string, text: string): void {
    if (!this.has(value as OriginFormat)) return;
    const format = value as OriginFormat;
    this.host.adoptText(docFormatOf(format), text, null);
    this.cur = format;
    this.emitted = text;
    if (format !== this.origin.format) this.truth = { format, text, filePath: null, doc: null };
  }

  pristineOf(origin: string): boolean {
    return this.originText === origin && this.truth === this.origin && this.origin.text === this.originText && this.host.getText() === this.emitted;
  }

  note(): FormatNote | null {
    if (!this.lost.length) return null;
    const title = this.lost.map((l) => `· ${l.name}`).join("\n");
    const origin = originName(this.origin.format);
    const edited = this.truth !== this.origin || this.host.getText() !== this.emitted;
    if (!edited) {
      return {
        text: t("fs.noteLost", { from: origin, n: this.lost.length }), title,
        action: { label: t("fs.noteBack", { format: origin }), run: () => void this.backToOrigin(false) },
      };
    }
    return {
      text: t("fs.noteEdited", { n: this.lost.length }), title,
      action: { label: t("fs.noteRevert", { format: origin }), run: () => void this.backToOrigin(true) },
    };
  }

  /** 回到原稿；`discard`：之后的改动都丢，先问一声。 */
  private async backToOrigin(discard: boolean): Promise<void> {
    if (discard && !(await showConfirmDialog(t("fs.revertTitle"), t("fs.revertBody", { format: originName(this.origin.format) })))) return;
    this.truth = this.origin;
    this.adopt(this.origin);
    this.host.setStatus(t("fs.backToOrigin", { format: originName(this.origin.format) }));
    this.onSwitched?.();
  }

  /** 不经下拉切了（提示里的链接）：App 同步下拉 */
  onSwitched: (() => void) | null = null;
}
