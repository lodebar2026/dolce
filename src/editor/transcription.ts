// 转记的编辑器接入、配置、对话框与源格式写回。模型变换在 `model/transcribe.ts`。

import type { ScoreDoc } from "../model/doc";
import type { DocFormatId } from "./formats";
import { emit123 } from "../abcfamily/emit123.entry";
import { emitAbc } from "../abcfamily/emitabc.entry";
import { emitJcx } from "../abcfamily/emitjcx.entry";
import { parse123, parseAbc, parseJcx } from "../abcfamily/parse";
import { emitJpwabc } from "../convert/jpwabc";
import { emitJly } from "../jly/tojly";
import { emitFanqie } from "../fanqie/tofanqie";
import { spliceComments } from "../jianpu/docrelayout";
import { keySpelling } from "../model/jianpu";
import type { TranscriptionOptions, TranscriptionSpelling } from "../model/transcribe";
import { transcribeScore } from "../model/transcribe";
import { dropEmbeddedLayout, forgetNoteLayout } from "../model/xmlsurface";
import type { VisualHost } from "./visual/controller";
import { labeled, showFormDialog } from "./dialogs";
import { t } from "../i18n";

export interface TranscriptionPreset extends TranscriptionOptions {
  id: string;
  name: string;
}

export const FIXED_C_PRESET_ID = "builtin.fixed-c";
const FIFTHS = [0, 1, 2, 3, 4, 5, 6, 7, -1, -2, -3, -4, -5, -6, -7] as const;

function builtins(): TranscriptionPreset[] {
  return [
    { id: FIXED_C_PRESET_ID, name: t("tx.preset.fixedC"), fifths: 0, spelling: "key" },
  ];
}

function isSpelling(value: unknown): value is TranscriptionSpelling {
  return value === "key" || value === "sharp" || value === "flat";
}

export function sanitizeTranscriptionPresets(value: unknown): TranscriptionPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: TranscriptionPreset[] = [];
  for (const item of value) {
    const p = item as Partial<TranscriptionPreset>;
    if (typeof p.id !== "string" || !p.id.startsWith("user.") || seen.has(p.id)) continue;
    if (typeof p.name !== "string" || !p.name.trim()) continue;
    if (typeof p.fifths !== "number" || !Number.isInteger(p.fifths) || p.fifths < -7 || p.fifths > 7) continue;
    if (!isSpelling(p.spelling)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name.trim().slice(0, 80), fifths: p.fifths, spelling: p.spelling,
      repeatAccidentals: p.repeatAccidentals === true });
  }
  return out;
}

export function sanitizeTranscriptionPresetId(value: unknown, presets: readonly TranscriptionPreset[]): string {
  return typeof value === "string" && [...builtins(), ...presets].some((p) => p.id === value)
    ? value
    : FIXED_C_PRESET_ID;
}

interface TranscriptionSettings {
  transcriptionPresets: TranscriptionPreset[];
  transcriptionPreset: string;
}

/** 设置的读取与校验集中在自定义模块，宿主只需把结果并入自身状态。 */
export function loadTranscriptionSettings(settings: object): TranscriptionSettings {
  const input = settings as { transcriptionPresets?: unknown; transcriptionPreset?: unknown };
  const transcriptionPresets = sanitizeTranscriptionPresets(input.transcriptionPresets);
  return {
    transcriptionPresets,
    transcriptionPreset: sanitizeTranscriptionPresetId(input.transcriptionPreset, transcriptionPresets),
  };
}

/** 转记入口：控制器只转交宿主和预设状态，执行与写回逻辑留在自定义模块。 */
export function runTranscription(host: VisualHost, settings: TranscriptionSettings): boolean {
  showTranscriptionDialog(
    { presets: settings.transcriptionPresets, selectedId: settings.transcriptionPreset },
    (state) => {
      settings.transcriptionPresets = state.presets;
      settings.transcriptionPreset = state.selectedId;
      host.saveSettings();
    },
    (options) => {
      host.scorePane.focus({ preventScroll: true });
      if (!host.syncFresh()) host.reloadNow();
      const source = host.modelEditing() ? host.freshModel() : host.syncDoc();
      if (!source) {
        host.setStatus(t("tx.unreadable"));
        return;
      }
      const doc = host.modelEditing() ? source : structuredClone(source);
      try {
        const result = transcribeScore(doc, options, host.modelEditing()
          ? { forgetStem: forgetNoteLayout, forgetLayout: dropEmbeddedLayout }
          : {});
        if (result.notes === 0) {
          host.setStatus(t("tx.noNotes"));
          return;
        }
        const before = host.view.state.doc.toString();
        const after = host.modelEditing()
          ? host.writeModel(doc)
          : emitTranscribedSource(host.docFormat, before, source, doc);
        if (after !== before) {
          host.view.dispatch({ changes: [sourceDiff(before, after)], userEvent: "input.visual", scrollIntoView: false });
          host.reloadNow();
        }
        host.setStatus(t("tx.done", { key: keySpelling({ fifths: options.fifths }) }));
      } catch (error) {
        console.error("transcription failed", error);
        host.setStatus(t("tx.failed", { error: error instanceof Error ? error.message : String(error) }));
      }
    },
  );
  return true;
}

/** 当前源格式的模型写回原格式；ABC 家族把不进模型的原注释缝回去。 */
export function emitTranscribedSource(format: DocFormatId, oldText: string, oldDoc: ScoreDoc, doc: ScoreDoc): string {
  if (format === "jpwabc") {
    const out = emitJpwabc(doc);
    if (out === null) throw new Error(t("err.noLines"));
    return out;
  }
  if (format === "fanqie") return emitFanqie(doc, doc.fanqieDialect === "tomato" ? "tomato" : "shige");
  if (format === "jly") return emitJly(doc).text;
  const family = format === "123"
    ? { emit: emit123, parse: parse123 }
    : format === "abc"
      ? { emit: emitAbc, parse: parseAbc }
      : format === "jcx"
        ? { emit: emitJcx, parse: parseJcx }
        : null;
  if (!family) throw new Error(`unsupported source format: ${format}`);
  const out = family.emit(doc);
  return spliceComments(oldText, oldDoc, out, family.parse(out));
}

/** 两份原文只替换中间不同的一段；CodeMirror 仍只收到一个事务，因此撤销一次即可恢复。 */
export function sourceDiff(before: string, after: string): { from: number; to: number; insert: string } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}

export interface TranscriptionDialogState {
  presets: TranscriptionPreset[];
  selectedId: string;
}

/** “转记…”：目标 `1=?`、临时记号策略和一组很小的内置/用户预设。 */
export function showTranscriptionDialog(
  state: TranscriptionDialogState,
  persist: (next: TranscriptionDialogState) => void,
  run: (options: TranscriptionOptions) => void,
): void {
  let custom = [...state.presets];
  let selectedId = sanitizeTranscriptionPresetId(state.selectedId, custom);
  const body = document.createElement("div");
  body.className = "settings-form";
  const preset = document.createElement("select");
  const key = document.createElement("select");
  for (const fifths of FIFTHS) {
    const option = document.createElement("option");
    option.value = String(fifths);
    option.textContent = `1=${keySpelling({ fifths })}`;
    key.append(option);
  }
  const spelling = document.createElement("select");
  for (const [value, label] of [
    ["key", t("tx.spelling.key")],
    ["sharp", t("tx.spelling.sharp")],
    ["flat", t("tx.spelling.flat")],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    spelling.append(option);
  }
  const name = document.createElement("input");
  const repeatAccidentals = document.createElement("input");
  repeatAccidentals.type = "checkbox";
  name.type = "text";
  name.maxLength = 80;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button-secondary";
  save.textContent = t("tx.preset.save");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button-secondary";
  remove.textContent = t("tx.preset.delete");
  const buttons = document.createElement("span");
  buttons.style.cssText = "display:flex;gap:6px;align-items:center";
  buttons.append(name, save, remove);
  const hint = document.createElement("div");
  hint.className = "modal-hint";
  hint.textContent = t("tx.hint");

  const all = (): TranscriptionPreset[] => [...builtins(), ...custom];
  const chosen = (): TranscriptionPreset => all().find((p) => p.id === selectedId) ?? builtins()[0]!;
  const fillPresetList = (): void => {
    preset.replaceChildren();
    for (const p of all()) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.name;
      preset.append(option);
    }
    preset.value = selectedId;
  };
  const applyPreset = (): void => {
    const p = chosen();
    key.value = String(p.fifths);
    spelling.value = p.spelling;
    repeatAccidentals.checked = p.repeatAccidentals === true;
    name.value = p.name;
    remove.disabled = !p.id.startsWith("user.");
  };
  fillPresetList();
  applyPreset();
  preset.onchange = () => {
    selectedId = preset.value;
    applyPreset();
  };
  save.onclick = () => {
    const presetName = name.value.trim();
    if (!presetName) {
      name.focus();
      return;
    }
    const next: TranscriptionPreset = {
      id: selectedId.startsWith("user.") ? selectedId : `user.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`,
      name: presetName,
      fifths: Number(key.value),
      spelling: spelling.value as TranscriptionSpelling,
      repeatAccidentals: repeatAccidentals.checked,
    };
    custom = [...custom.filter((p) => p.id !== next.id), next];
    selectedId = next.id;
    fillPresetList();
    applyPreset();
    persist({ presets: custom, selectedId });
  };
  remove.onclick = () => {
    if (!selectedId.startsWith("user.")) return;
    custom = custom.filter((p) => p.id !== selectedId);
    selectedId = FIXED_C_PRESET_ID;
    fillPresetList();
    applyPreset();
    persist({ presets: custom, selectedId });
  };
  body.append(
    labeled(t("tx.preset"), preset),
    labeled(t("tx.key"), key),
    labeled(t("tx.spelling"), spelling),
    labeled(t("tx.repeatAccidentals"), repeatAccidentals),
    labeled(t("tx.preset.name"), buttons),
    hint,
  );
  showFormDialog(t("tx.title"), body, () => {
    selectedId = preset.value;
    persist({ presets: custom, selectedId });
    run({ fifths: Number(key.value), spelling: spelling.value as TranscriptionSpelling,
      repeatAccidentals: repeatAccidentals.checked });
  }, t("tx.run"));
}
