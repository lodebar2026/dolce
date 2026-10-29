// 转记的编辑器接入、配置、对话框与源格式写回。模型变换在 `model/transcribe.ts`。

import type { Chord, ScoreDoc } from "../model/doc";
import type { DocFormatId } from "./formats";
import { emit123 } from "../abcfamily/emit123.entry";
import { emitAbc } from "../abcfamily/emitabc.entry";
import { emitJcx } from "../abcfamily/emitjcx.entry";
import { parse123, parseAbc, parseJcx } from "../abcfamily/parse";
import { emitJpwabc } from "../convert/jpwabc";
import { emitJly } from "../jly/tojly";
import { emitFanqie } from "../fanqie/tofanqie";
import { parseFanqie } from "../fanqie/parse";
import { parseJly } from "../jly/fromjly";
import { JpwFile } from "../jpword/jpwfile";
import { jpwToScoreDoc } from "../model/fromjpw";
import { midiOfPitch } from "../model/edit";
import { projectForMusicXml } from "../model/xmlproject";
import { spliceComments } from "../jianpu/docrelayout";
import { keySpelling } from "../model/jianpu";
import type { TranscriptionOptions, TranscriptionSpelling } from "../model/transcribe";
import { transcribeScore } from "../model/transcribe";
import { dropEmbeddedLayout, forgetNoteLayout } from "../model/xmlsurface";
import type { VisualHost } from "./visual/controller";
import { type EditCtx, noteCtx } from "./visual/ops";
import { keyFields } from "./visual/transpose";
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
    { id: FIXED_C_PRESET_ID, name: t("tx.preset.fixedC"), fifths: 0, spelling: "keep" },
  ];
}

function isSpelling(value: unknown): value is TranscriptionSpelling {
  return value === "keep" || value === "key" || value === "sharp" || value === "flat";
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

/** 转记入口：控制器只转交宿主和预设状态，执行与写回逻辑留在自定义模块。`editCtx` 给文本格式逐音改原文用。 */
export function runTranscription(host: VisualHost, settings: TranscriptionSettings, editCtx: () => EditCtx | null): boolean {
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
          : transcribedText(host.docFormat, editCtx(), before, source, doc, options.fifths);
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

/**
 * 文本格式的写回。先逐音改原文（`patchTranscribedSource`：排版、注释、别的节一字不动）；改不了或读回音高不对，
 * 退回整份重新写出（`emitTranscribedSource`）。整份写出读回也对不上就报错、不动原文。
 */
export function transcribedText(format: DocFormatId, ctx: EditCtx | null, before: string, oldDoc: ScoreDoc, doc: ScoreDoc, fifths: number): string {
  const reference = sounding(parseSource(format, before));
  const patched = ctx ? patchTranscribedSource(ctx, oldDoc, doc, fifths) : null;
  if (patched !== null && sameSounding(reference, patched, format)) return patched;
  const out = emitTranscribedSource(format, before, oldDoc, doc);
  if (!sameSounding(reference, out, format)) throw new Error(t("tx.pitchMismatch"));
  return out;
}

function parseSource(format: DocFormatId, text: string): ScoreDoc {
  switch (format) {
    case "jpwabc": {
      const f = JpwFile.fromString(text);
      if (!f) throw new Error(t("err.noLines"));
      return jpwToScoreDoc(f);
    }
    case "fanqie": return parseFanqie(text);
    case "123": return parse123(text);
    case "abc": return parseAbc(text);
    case "jcx": return parseJcx(text);
    case "jly": return parseJly(text).doc;
    default: throw new Error(`unsupported source format: ${format}`);
  }
}

/** 全曲每个音的实际音高（MIDI），按声部、声线、先后排成一串，比较转记前后用。 */
function sounding(doc: ScoreDoc): string[] {
  const out: string[] = [];
  for (const song of doc.songs) {
    projectForMusicXml(song).parts.forEach((part, pi) => part.measures.forEach((m) => m.elements.forEach((el) => {
      if (el.kind !== "chord" || el.rest) return;
      out.push(`${pi}:${el.voice}:${el.notes.map((n) => (n.pitch ? midiOfPitch(n.pitch) : "?")).join("+")}`);
    })));
  }
  return out;
}

function sameSounding(reference: string[], text: string, format: DocFormatId): boolean {
  let now: string[];
  try {
    now = sounding(parseSource(format, text));
  } catch {
    return false;
  }
  return now.length === reference.length && now.every((x, i) => x === reference[i]);
}

/** 调号字段的值换成目标调：简谱式 `1=bB`（升降号在前）、ABC 式 `Bb` / `Am`（在后，小调取同调号的关系小调）。认不出返回 null。 */
function retargetKey(value: string, fifths: number): string | null {
  const jp = /(1\s*=\s*)([#b♯♭]?)([A-G])([#b♯♭]?)/.exec(value);
  if (jp) {
    // 升降号照原来的位置写：前置（`1=bB`）或后置（文本谱 `1=Eb`）
    const name = keySpelling({ fifths });
    const tonic = jp[4] ? name.replace(/^([#b])([A-G])$/, "$2$1") : name;
    return value.slice(0, jp.index) + jp[1] + tonic + value.slice(jp.index + jp[0].length);
  }
  const abc = /^(\s*)([A-G])([#b]?)/.exec(value);
  if (!abc) return null;
  const rest = value.slice(abc[0].length);
  const minor = /^\s*(m(?!aj|ix)|min)/i.test(rest);
  const name = keySpelling({ fifths, mode: minor ? "minor" : "major" }, "mode");
  return abc[1] + name.replace(/^([#b])([A-G])$/, "$2$1") + rest;
}

/** 原文里同一段区间上的音符元素（倚音组 `{5,6}` 几个元素共用一段），转记前后成对。 */
interface SourceGroup {
  from: number;
  to: number;
  before: Chord[];
  after: Chord[];
}

/** 按原文区间把元素分组；有音高却没有区间的返回 null（这种来源改不了原文）。 */
function sourceGroups(oldDoc: ScoreDoc, doc: ScoreDoc): SourceGroup[] | null {
  const groups = new Map<string, SourceGroup>();
  for (let si = 0; si < oldDoc.songs.length; si++) {
    const a = oldDoc.songs[si]!.parts;
    const b = doc.songs[si]?.parts;
    for (let pi = 0; pi < a.length; pi++) for (let mi = 0; mi < a[pi]!.measures.length; mi++) {
      const ea = a[pi]!.measures[mi]!.elements;
      const eb = b?.[pi]?.measures[mi]?.elements;
      for (let ei = 0; ei < ea.length; ei++) {
        const was = ea[ei]!;
        const now = eb?.[ei];
        if (was.kind !== "chord" || now?.kind !== "chord" || was.id !== now.id) {
          if (was.kind === "chord" || now?.kind === "chord") return null;
          continue;
        }
        if (!was.notes.some((n) => n.degree && n.degree.number > 0)) continue;
        const src = was.source;
        if (!src || src.length <= 0) return null;
        const k = `${src.offset}:${src.length}`;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { from: src.offset, to: src.offset + src.length, before: [], after: [] }));
        g.before.push(was);
        g.after.push(now);
      }
    }
  }
  return [...groups.values()];
}

/**
 * 逐音改原文：每处调号换成目标调，每个音换成转记后的唱名、八度点与升降号，别的字一个不动（手排的空格、换行、
 * 注释、`.jpwabc` 的 `.Repeat` 等节都留着）。`oldDoc` 是原文读出的模型，`doc` 是它转记后的克隆。
 * 元素区间整段读不懂（和音 `[135]`、倚音组 `{5,6}`、区间带进后面的字）时，从左往右切出读得懂的最长单音逐个改。
 * 音对不上模型、区间缺失时返回 null；读回音高的核对在调用方。
 */
export function patchTranscribedSource(ctx: EditCtx, oldDoc: ScoreDoc, doc: ScoreDoc, fifths: number): string | null {
  const text = ctx.state.doc.toString();
  const changes: { from: number; to: number; insert: string }[] = [];
  const fields = keyFields(ctx, text);
  if (!fields.length) return null;
  for (const f of fields) {
    const v = text.slice(f.from, f.to);
    const nv = retargetKey(v, fifths);
    if (nv === null) return null;
    if (nv !== v) changes.push({ from: f.from, to: f.to, insert: nv });
  }
  // 不在调号字段里的转调记号（文本谱 `"k:2"`）删掉：全曲已收到目标调号
  for (const m of ctx.dialect.keyChangeMarks?.(text) ?? []) changes.push({ from: m.from, to: m.to, insert: "" });
  const groups = sourceGroups(oldDoc, doc);
  if (!groups) return null;
  const { dialect } = ctx;
  for (const g of groups) {
    const nc = noteCtx(ctx, g.from);
    const src = text.slice(g.from, g.to);
    // 这一段里的音：转记前后成对，按唱名与八度认
    const pool = g.before.flatMap((c, ci) => c.notes.map((n, ni) => ({ was: n.degree, now: g.after[ci]!.notes[ni]?.degree, used: false })));
    const rewrite = (chunk: string): string | null => {
      const tok = dialect.parseNote(chunk, nc);
      if (!tok) return null;
      if (tok.degree === 0) return chunk;
      const hit = pool.find((p) => !p.used && p.was?.number === tok.degree && p.was.octaveShift === tok.octave);
      if (!hit?.now) return null;
      hit.used = true;
      const d = hit.now;
      // 没变的音照抄原文（不把 `7♭` 重写成 `7b`）
      if (d.number === tok.degree && d.octaveShift === tok.octave && (d.accidental ?? null) === tok.acc) return chunk;
      const next = { ...tok, degree: d.number, octave: d.octaveShift, acc: d.accidental ?? null };
      if (dialect.validate?.(next)) return null;
      // 音名绝对的格式（ABC）按目标调号写音名
      return dialect.printNote(next, { ...nc, fifths });
    };
    let out = rewrite(src);
    if (out === null) {
      for (const p of pool) p.used = false;
      out = "";
      let i = 0;
      while (i < src.length) {
        let j = src.length;
        while (j > i && !dialect.parseNote(src.slice(i, j), nc)) j--;
        if (j === i) {
          out += src[i];
          i++;
          continue;
        }
        const piece = rewrite(src.slice(i, j));
        if (piece === null) return null;
        out += piece;
        i = j;
      }
    }
    if (pool.some((p) => !p.used && p.was && p.was.number > 0)) return null;
    if (out !== src) changes.push({ from: g.from, to: g.to, insert: out });
  }
  changes.sort((a, b) => a.from - b.from);
  let result = "";
  let at = 0;
  for (const c of changes) {
    if (c.from < at) return null;
    result += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return result + text.slice(at);
}

/** `.jpwabc` 整份写出时只取新的 `.Voice` 与 `KeyAndMeters`，别的节（`.Repeat`、`.Words`、`.Layout`…）照原文。 */
function keepJpwSections(oldText: string, newText: string): string {
  const split = (text: string): { head: string; sections: [string, string][] } => {
    const parts = text.split(/^(?=\.\w)/m);
    const head = parts[0]!.startsWith(".") ? "" : parts.shift()!;
    return { head, sections: parts.map((p) => [/^\.(\w+)/.exec(p)![1]!.toLowerCase(), p]) };
  };
  const old = split(oldText);
  const now = new Map(split(newText).sections);
  const voice = now.get("voice");
  if (!voice || !old.sections.some(([name]) => name === "voice")) return newText;
  const keyLine = /^\s*KeyAndMeters\s*=.*$/m;
  const newKey = keyLine.exec(now.get("title") ?? "")?.[0];
  return old.head + old.sections.map(([name, body]) => {
    if (name === "voice") return voice.endsWith("\n") || !body.endsWith("\n") ? voice : voice + "\n";
    if (name === "title" && newKey !== undefined) return body.replace(keyLine, () => newKey);
    return body;
  }).join("");
}

/** 当前源格式的模型写回原格式；ABC 家族把不进模型的原注释缝回去。 */
export function emitTranscribedSource(format: DocFormatId, oldText: string, oldDoc: ScoreDoc, doc: ScoreDoc): string {
  if (format === "jpwabc") {
    const out = emitJpwabc(doc);
    if (out === null) throw new Error(t("err.noLines"));
    return keepJpwSections(oldText, out);
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
    ["keep", t("tx.spelling.keep")],
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
