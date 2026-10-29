// **移调**：全曲换调，或选中的音移几个半音。
//
// 全曲：每处调号按同一个音程换（主音取常用写法，`model/edit.ts::transposeFifths`）；简谱各格式唱名不变，只改调号，
// ABC 的音名是绝对的，按新调号把每个音重写一遍（解析出的唱名不变、换个调号写回去就是移过去的音名）。
// 选区：音移几个半音、调号不动（`ops.ts::shiftSemitones`）。MusicXML 两样都在模型上改（`model/edit.ts`）。

import { labeled, showFormDialog } from "../dialogs";
import { type MsgKey, t as tr } from "../../i18n";
import { transposeFifths } from "../../model/edit";
import { type EditCtx, type EditOutcome, noteCtx, rewriteToken } from "./ops";

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC_OF: Record<string, number> = { "": 0, "#": 1, "♯": 1, b: -1, "♭": -1 };
// 新主音的写法：与 `transposeFifths` 同一张表（大调）；小调取关系大调同号的那个（D♯m 与 F♯ 同为 6 个升号）
const MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** 调号的写法里把主音移 `n` 个半音：简谱式 `1=bB`（升降号在前）、ABC 式 `Bb`/`F#m`（在后）。认不出主音返回 null。 */
export function retonic(value: string, n: number): string | null {
  // 升降号在前（`1=bB`）或在后（文本谱 `1=Eb`），照原来的位置写
  const jp = /(1\s*=\s*)([#b♯♭]?)([A-G])([#b♯♭]?)/.exec(value);
  if (jp) {
    const pc = (((LETTER_PC[jp[3]!]! + ACC_OF[jp[2] || jp[4]!]! + n) % 12) + 12) % 12;
    const name = MAJOR_NAMES[pc]!;
    const tonic = name.length > 1 && !jp[4] ? name[1] + name[0]! : name;
    return value.slice(0, jp.index) + jp[1] + tonic + value.slice(jp.index + jp[0].length);
  }
  const abc = /^(\s*)([A-G])([#b]?)/.exec(value);
  if (!abc) return null;
  const rest = value.slice(abc[0].length);
  const minor = /^\s*(m(?!aj|ix)|min)/i.test(rest);
  const pc = (((LETTER_PC[abc[2]!]! + ACC_OF[abc[3]!]! + n) % 12) + 12) % 12;
  return abc[1] + (minor ? MINOR_NAMES : MAJOR_NAMES)[pc]! + rest;
}

/** 调号（升号个数）对应的大调主音写法（给对话框标「→ 1=D」）。 */
export function tonicName(fifths: number): string {
  return MAJOR_NAMES[(((fifths * 7) % 12) + 12) % 12]!.replace(/^([A-G])([#b])$/, "$2$1");
}

/** ABC 家族（123 / ABC）每处 `K:` 的值：行首的 `K:` 与行内的 `[K:…]`。 */
function abcKeyFields(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const m of text.matchAll(/^[ \t]*K:[ \t]*([^\n%]*)/gm)) {
    const v = m[1]!.replace(/\s+$/, "");
    const from = m.index! + m[0].length - m[1]!.length;
    out.push({ from, to: from + v.length });
  }
  for (const m of text.matchAll(/\[K:([^\]\n]*)\]/g)) out.push({ from: m.index! + 3, to: m.index! + 3 + m[1]!.length });
  return out;
}

/** 原文里每处写调号的值（ABC 家族的 `K:` 与 `[K:…]`，其余格式取文件头里的调号字段）。转记（`transcription.ts`）也用。 */
export function keyFields(ctx: EditCtx, text: string): { from: number; to: number }[] {
  return ctx.dialect.measure
    ? abcKeyFields(text)
    : (ctx.dialect.headerFields?.(text) ?? []).filter((f) => f.role === "key" || f.role === "keytime");
}

/** 全曲移 `n` 个半音（文本格式）：每处调号换主音；音名是绝对的格式（ABC）按新调号重写每个音。 */
export function transposeText(ctx: EditCtx, n: number): EditOutcome {
  const text = ctx.state.doc.toString();
  const fields = keyFields(ctx, text);
  const changes: { from: number; to: number; insert: string }[] = [];
  let keys = 0;
  for (const f of fields) {
    const v = text.slice(f.from, f.to);
    const nv = retonic(v, n);
    if (nv === null) continue;
    keys++;
    if (nv !== v) changes.push({ from: f.from, to: f.to, insert: nv });
  }
  if (!keys) return { error: tr("tp.noKey") };
  const tonicMidi = ctx.dialect.tonicMidi;
  for (const e of ctx.sync.ordered()) {
    if (e.kind !== "note") continue;
    const src = text.slice(e.from, e.to);
    const nc = noteCtx(ctx, e.from);
    const nf = transposeFifths(nc.fifths, n);
    // 音名绝对的格式：唱名不变、换了主音，主音所在八度另有约定（`wrOf`）——按实际音高差补八度，往下移就是往下
    const oct = tonicMidi ? Math.round((n - (tonicMidi(nf) - tonicMidi(nc.fifths))) / 12) : 0;
    const out = rewriteToken({ ...ctx.dialect, printNote: (t, c) => ctx.dialect.printNote(t, { ...c, fifths: nf }) }, src, nc, (t) => {
      if (t.degree !== 0) t.octave += oct;
      return t;
    });
    if (typeof out === "string" && out !== src) changes.push({ from: e.from, to: e.to, insert: out });
  }
  if (!changes.length) return { error: tr("tp.octave") };
  changes.sort((a, b) => a.from - b.from);
  const cs = ctx.state.changes(changes);
  const sel = ctx.state.selection.main;
  return { changes, anchor: cs.mapPos(sel.anchor, -1), head: cs.mapPos(sel.head, 1) };
}

const INTERVALS = ["", "m2", "M2", "m3", "M3", "P4", "A4", "P5", "m6", "M6", "m7", "M7", "P8"] as const;

/**
 * 移调对话框。`fifths` 是现在的主调号（标出移过去是几调）；`hasSelection` 时可选「只移选中的音」。
 * 确定后回调 `run(全曲?, 半音数)`。
 */
export function showTransposeDialog(fifths: number, hasSelection: boolean, run: (whole: boolean, n: number) => void): void {
  const body = document.createElement("div");
  body.className = "settings-form";
  const scope = document.createElement("select");
  for (const [v, label] of [["all", tr("tp.all")], ["sel", tr("tp.sel")]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (v === "sel") o.disabled = !hasSelection;
    scope.append(o);
  }
  if (hasSelection) scope.value = "sel";
  const by = document.createElement("select");
  const fill = (): void => {
    const keep = by.value;
    by.replaceChildren();
    for (const dir of [1, -1]) {
      for (let k = 1; k <= 12; k++) {
        const n = dir * k;
        const o = document.createElement("option");
        o.value = String(n);
        const to = scope.value === "all" && k < 12 ? `　→ 1=${tonicName(transposeFifths(fifths, n))}` : "";
        o.textContent = tr("tp.option", { dir: tr(dir > 0 ? "tp.up" : "tp.down"), iv: tr(`tp.iv.${INTERVALS[k]!}` as MsgKey), k, to });
        by.append(o);
      }
    }
    by.value = keep || "2";
  };
  fill();
  scope.addEventListener("change", fill);
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:8px;opacity:0.75;font-size:12px;line-height:1.6";
  hint.textContent = tr("tp.hint", { key: tonicName(fifths) });
  body.append(labeled(tr("tp.scope"), scope), labeled(tr("tp.by"), by), hint);
  showFormDialog(tr("tp.title"), body, () => run(scope.value === "all", Number(by.value)));
}
