// 声部面板：合唱谱的声部（part）增删、排序、改名、谱号、拆合、歌词复制，外加试听的静音 / 独奏 / 音量与「简谱旋律取自」。
//
// 参照 MuseScore「乐器」面板（增删、上下移、长短名、Explode / Implode）、Sibelius「Arrange / Reduce」、Dorico「演奏者」。
// 每一步立刻生效（经 `App.editParts` 改模型再写回原文，撤销照常），面板随之重画；试听设置只存会话、不写文件。
// 能改到哪一步看格式（`App.partsEditable`）：MusicXML、123、ABC 能改结构；文本谱与 `.jpwabc` 只有试听设置。

import type { App } from "./app";
import type { ScoreDoc } from "../model/doc";
import {
  addPart, CLEF_LABEL, clefNameOf, type ClefName, copyLyrics, deletePart, duplicatePart, mergeInto, movePart, setPartProps,
  splitByChord, splitByVoice, stavesOf, TRANSPOSE_PRESETS, transposeKeyOf, type PartProps,
} from "../model/parts";
import { openModal, showConfirmDialog } from "./dialogs";
import { type MsgKey, t } from "../i18n";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function btn(label: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", "parts-btn", label);
  b.type = "button";
  b.title = title;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/** 一个声部的概况：几条声线、有没有和弦（闭合谱）、有没有词。 */
function partShape(doc: ScoreDoc, pi: number): { voices: number; chords: boolean; lyrics: boolean; measures: number } {
  const part = doc.songs[0]?.parts[pi];
  let voices = 1;
  let chords = false;
  let lyrics = false;
  for (const m of part?.measures ?? []) {
    for (const e of m.elements) {
      voices = Math.max(voices, e.voice);
      if (e.kind === "chord" && e.notes.length > 1) chords = true;
      if (e.kind === "chord" && e.lyrics?.length) lyrics = true;
    }
  }
  return { voices, chords, lyrics, measures: part?.measures.length ?? 0 };
}

/** 原文里有没有会被整份重出丢掉的注释（`%` 开头的行；版本声明 `%abc` / `%123` 与 `%%` 指令不算）。 */
function hasComments(text: string): boolean {
  return text.split("\n").some((l) => /^\s*%(?!%|abc|123)/i.test(l));
}

/**
 * 123 / ABC：改第 `pi` 个声部的名字、简称、谱号——直接改它的 `V:` 声明行的属性（局部补丁，不整份重出）。
 * 声部按 `V:` 号第一次出现的先后排（与解析同口径）。单声部没有 `V:` 行时在 `K:` 行后面补一行 `V:1`。
 * 改不了（找不到这个声部的声明）返回 null，调用方再走整份重出。
 */
export function patchVoiceLine(text: string, pi: number, props: { name?: string; abbrev?: string; clef?: ClefName }): string | null {
  const lines = text.split("\n");
  const seen: string[] = [];
  let at = -1;
  // 只看第一首（面板列的是第一首的声部）：多曲文件后面曲子的 `V:` 不算
  let tunes = 0;
  let end = lines.length;
  for (const [i, l] of lines.entries()) {
    if (/^\s*X:/.test(l) && ++tunes > 1) {
      end = i;
      break;
    }
  }
  for (const [i, l] of lines.slice(0, end).entries()) {
    const m = /^\s*V:\s*(\S+)/.exec(l);
    if (!m || seen.includes(m[1]!)) continue;
    seen.push(m[1]!);
    if (seen.length - 1 === pi) {
      at = i;
      break;
    }
  }
  const setAttr = (line: string, key: string, value: string | undefined, quoted: boolean): string => {
    // ABC 的简写 `nm=` / `snm=` 与全称是同一个属性：一起换掉，免得改完两个名字
    const alias = key === "name" ? "|nm" : key === "subname" ? "|snm" : "";
    const re = new RegExp(`\\s(?:${key}${alias})=(?:"[^"]*"|\\S+)`, "g");
    const stripped = line.replace(re, "");
    if (!value) return stripped;
    return `${stripped} ${key}=${quoted ? `"${value.replace(/"/g, "'")}"` : value}`;
  };
  const apply = (line: string): string => {
    let out = line.replace(/\s+$/, "");
    if (props.name !== undefined) out = setAttr(out, "name", props.name, true);
    if (props.abbrev !== undefined) out = setAttr(out, "subname", props.abbrev, true);
    if (props.clef !== undefined) out = setAttr(out, "clef", props.clef === "treble" ? undefined : props.clef, false);
    return out;
  };
  if (at >= 0) {
    lines[at] = apply(lines[at]!);
    return lines.join("\n");
  }
  if (seen.length === 0 && pi === 0) {
    const k = lines.slice(0, end).findIndex((l) => /^\s*K:/.test(l));
    if (k < 0) return null;
    lines.splice(k + 1, 0, apply("V:1"));
    return lines.join("\n");
  }
  return null;
}

/** 开着的声部面板的关闭函数（重画时先关旧的，连它的 Esc 监听一起撤）。 */
let openPanel: (() => void) | null = null;

/** 打开声部面板（已开着就重画）。 */
export function showPartsPanel(app: App): void {
  openPanel?.();
  const body = el("div", "parts-body");
  const done = el("button", "modal-button-primary", t("parts.done"));
  done.type = "button";
  const { close } = openModal({
    title: t("parts.title"),
    boxClass: "parts-box",
    body: [body],
    footer: [done],
    onClose: () => {
      openPanel = null;
      app.scorePane.focus({ preventScroll: true });
    },
  });
  done.addEventListener("click", close);
  openPanel = close;

  /** 改结构的一步：先问一声会不会丢注释（123 / ABC 整份重出），做完重画。 */
  /** `remap`：声部序号怎么变（旧 → 新，删掉为 -1），按声部记的会话设置跟着走 */
  const structural = async (
    what: string, mutate: (doc: ScoreDoc) => boolean | number | void, isStructure = true, remap?: (i: number) => number,
  ): Promise<void> => {
    if (app.docFormat !== "musicxml" && hasComments(app.getText())) {
      const ok = await showConfirmDialog(t("parts.confirmTitle"), t("parts.confirmComments", { what }));
      if (!ok) return;
    }
    if (!app.editParts(mutate, isStructure)) app.setStatus(t("parts.failed", { what: what.toLowerCase() }));
    else {
      if (remap) app.remapParts(remap);
      app.setStatus(t("parts.doneStatus", { what }));
    }
    render();
  };
  /** 序号映射：a、b 两个声部对调 / 在 at 后面插一个 / 删掉 at（并进别的也算删） */
  const swapMap = (a: number, b: number) => (i: number): number => (i === a ? b : i === b ? a : i);
  const insertAfter = (at: number) => (i: number): number => (i > at ? i + 1 : i);
  const removed = (at: number) => (i: number): number => (i === at ? -1 : i > at ? i - 1 : i);

  function render(): void {
    body.replaceChildren();
    const doc = app.partsDoc();
    const parts = doc?.songs[0]?.parts ?? [];
    const mode = app.partsEditable();
    const can = mode === "structure";
    if (!can) {
      body.append(el("p", "parts-note", app.docFormat === "jpwabc"
        ? t("parts.note.jpw")
        : t("parts.note.fanqie")));
    }
    if (!doc || parts.length === 0) {
      body.append(el("p", "parts-note", t("parts.note.none")));
      return;
    }
    const table = el("table", "parts-table");
    const head = el("tr");
    for (const h of ["", t("parts.col.name"), t("parts.col.abbr"), t("parts.col.clef"), t("parts.col.transpose"), t("parts.col.staves"), t("parts.col.visible"), t("parts.col.mute"), t("parts.col.solo"), t("parts.col.volume"), t("parts.col.jianpu"), t("parts.col.lyrics"), ""]) head.append(el("th", "", h));
    table.append(head);
    parts.forEach((part, pi) => {
      const tr = el("tr");
      const shape = partShape(doc, pi);
      tr.append(el("td", "parts-idx", String(pi + 1)));
      // 名称 / 简称：失焦或回车提交
      const nameIn = el("input", "parts-input");
      nameIn.value = part.name ?? "";
      nameIn.placeholder = t("parts.defaultName", { n: pi + 1 });
      nameIn.disabled = !can;
      const abbrIn = el("input", "parts-input parts-abbr");
      abbrIn.value = part.abbrev ?? "";
      abbrIn.placeholder = t("parts.abbrPlaceholder");
      abbrIn.disabled = !can;
      const commitName = (): void => {
        const name = nameIn.value.trim();
        const abbrev = abbrIn.value.trim();
        if (name === (part.name ?? "") && abbrev === (part.abbrev ?? "")) return;
        props(t("parts.op.rename"), { name, abbrev });
      };
      for (const inp of [nameIn, abbrIn]) {
        inp.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") inp.blur();
        });
        inp.addEventListener("change", commitName);
      }
      tr.append(el("td"), el("td"));
      tr.children[1]!.append(nameIn);
      tr.children[2]!.append(abbrIn);
      // 谱号
      const clefSel = el("select", "parts-select");
      for (const k of Object.keys(CLEF_LABEL)) {
        const o = el("option", "", t(`parts.clef.${k}` as MsgKey));
        o.value = k;
        clefSel.append(o);
      }
      clefSel.value = clefNameOf(part);
      // ABC 的谱号解析不读（音名本就是实际音高），改了也看不出来，不给改
      clefSel.disabled = !can || app.docFormat === "abc";
      clefSel.addEventListener("change", () => props(t("parts.op.clef"), { clef: clefSel.value as ClefName }));
      /** 改名、简称、谱号：123 / ABC 直接改 `V:` 行（不整份重出），MusicXML 改模型 */
      function props(what: string, p: PartProps): void {
        if (app.docFormat === "123" || app.docFormat === "abc") {
          const next = patchVoiceLine(app.getText(), pi, p);
          if (next !== null && app.replaceText(next, "input.parts")) {
            app.setStatus(t("parts.doneStatus", { what }));
            render();
            return;
          }
        }
        void structural(what, (d) => setPartProps(d.songs[0]!, pi, p), false);
      }
      const tdClef = el("td");
      tdClef.append(clefSel);
      tr.append(tdClef);
      // 移调乐器：只 MusicXML 写得出 `<transpose>`
      const trSel = el("select", "parts-select");
      for (const pr of TRANSPOSE_PRESETS) {
        const o = el("option", "", t(`parts.tr.${pr.key}` as MsgKey));
        o.value = pr.key;
        trSel.append(o);
      }
      const trKey = transposeKeyOf(part);
      if (trKey === "other") {
        const o = el("option", "", t("parts.tr.other"));
        o.value = "other";
        trSel.append(o);
      }
      trSel.value = trKey;
      const xml = app.docFormat === "musicxml";
      trSel.disabled = !can || !xml;
      trSel.title = xml ? t("parts.tr.title") : t("parts.tr.onlyXml");
      trSel.addEventListener("change", () => {
        const pr = TRANSPOSE_PRESETS.find((x) => x.key === trSel.value);
        if (pr) props(t("parts.op.transpose"), { transpose: pr.t });
      });
      const tdTr = el("td");
      tdTr.append(trSel);
      // 谱表数（钢琴等大谱表为 2）：只显示
      const tdStaves = el("td", "parts-idx", String(stavesOf(part)));
      tdStaves.title = t("parts.staves.title");
      // 五线谱 / 混排里显示不显示（会话内）
      const vis = el("input");
      vis.type = "checkbox";
      vis.checked = !app.hiddenParts.has(pi);
      vis.title = t("parts.visible.title");
      vis.addEventListener("change", () => app.setPartVisible(pi, vis.checked));
      const tdVis = el("td");
      tdVis.append(vis);
      tr.append(tdTr, tdStaves, tdVis);
      // 试听：静音 / 独奏 / 音量
      const mute = el("input");
      mute.type = "checkbox";
      mute.checked = !!app.playback.partMuted[pi];
      mute.title = t("parts.mute.title");
      mute.addEventListener("change", () => app.playback.setPartMuted(pi, mute.checked));
      const solo = el("input");
      solo.type = "checkbox";
      solo.checked = app.playback.solo === pi;
      solo.title = t("parts.solo.title");
      solo.addEventListener("change", () => {
        app.playback.setSolo(solo.checked ? pi : null);
        render();
      });
      const vol = el("input", "parts-vol");
      vol.type = "range";
      vol.min = "0";
      vol.max = "100";
      vol.value = String(Math.round(app.playback.getPartVolume(pi) * 100));
      vol.title = t("parts.volume.title");
      vol.addEventListener("change", () => app.playback.setPartVolume(pi, Number(vol.value) / 100));
      for (const c of [mute, solo, vol]) {
        const td = el("td");
        td.append(c);
        tr.append(td);
      }
      // 简谱旋律取自
      const mel = el("input");
      mel.type = "radio";
      mel.name = "parts-melody";
      mel.checked = app.melodyPart === pi;
      mel.title = t("parts.melody.title");
      mel.addEventListener("change", () => {
        if (mel.checked) app.setMelodyPart(pi);
      });
      const tdMel = el("td");
      tdMel.append(mel);
      tr.append(tdMel);
      // 简谱档的歌词取自（MusicXML；合唱谱词常印在女低音下）
      const lyr = el("input");
      lyr.type = "radio";
      lyr.name = "parts-lyric";
      // 缺省（都不勾）= 自动：展开档挑带词的那个声部排在最前
      lyr.checked = app.lyricPart === pi;
      lyr.disabled = app.docFormat !== "musicxml";
      lyr.title = lyr.disabled ? t("parts.lyric.textFmt") : t("parts.lyric.title");
      lyr.addEventListener("change", () => {
        if (lyr.checked) app.setLyricPart(pi);
      });
      const tdLyr = el("td");
      tdLyr.append(lyr);
      tr.append(tdLyr);
      // 操作
      const ops = el("td", "parts-ops");
      ops.append(
        btn("↑", t("parts.up"), () => void structural(t("parts.op.up"), (d) => movePart(d, 0, pi, pi - 1), true, swapMap(pi, pi - 1)), !can || pi === 0),
        btn("↓", t("parts.down"), () => void structural(t("parts.op.down"), (d) => movePart(d, 0, pi, pi + 1), true, swapMap(pi, pi + 1)), !can || pi === parts.length - 1),
        btn(t("parts.dup"), t("parts.dup.title"), () => void structural(t("parts.op.dup"), (d) => duplicatePart(d, 0, pi), true, insertAfter(pi)), !can),
        btn(t("parts.splitVoice"), t("parts.splitVoice.title"), () => void structural(t("parts.op.splitVoice"), (d) => splitByVoice(d, 0, pi), true, insertAfter(pi)), !can || shape.voices < 2),
        btn(t("parts.splitChord"), t("parts.splitChord.title"), () => void structural(t("parts.op.splitChord"), (d) => splitByChord(d, 0, pi), true, insertAfter(pi)), !can || !shape.chords),
        // 123 / ABC 的写出端不写小节内临时声部（`&`），并成第二声线会丢音：合成闭合谱只对 MusicXML
        btn(t("parts.merge"), app.docFormat === "musicxml" ? t("parts.merge.title") : t("parts.merge.onlyXml"),
          () => void structural(t("parts.op.merge"), (d) => mergeInto(d, 0, pi - 1, pi), true, removed(pi)), !can || pi === 0 || app.docFormat !== "musicxml"),
        btn(t("parts.delete"), t("parts.delete.title"), () => {
          void showConfirmDialog(t("parts.op.delete"), t("parts.delete.confirm", { name: part.name || t("parts.defaultName", { n: pi + 1 }) })).then((ok) => {
            if (ok) void structural(t("parts.op.delete"), (d) => deletePart(d, 0, pi), true, removed(pi));
          });
        }, !can || parts.length < 2),
      );
      tr.append(ops);
      table.append(tr);
    });
    body.append(table);

    // 底部：新建声部 · 歌词复制
    const tools = el("div", "parts-tools");
    const newClef = el("select", "parts-select");
    for (const k of Object.keys(CLEF_LABEL)) {
      const o = el("option", "", t(`parts.clef.${k}` as MsgKey));
      o.value = k;
      newClef.append(o);
    }
    tools.append(
      btn(t("parts.add"), t("parts.add.title"), () =>
        void structural(t("parts.add"), (d) => addPart(d, 0, { clef: newClef.value as ClefName })), !can),
      newClef,
    );
    if (parts.length > 1) {
      const from = el("select", "parts-select");
      const to = el("select", "parts-select");
      parts.forEach((p, i) => {
        const label = p.name || t("parts.defaultName", { n: i + 1 });
        const a = el("option", "", label);
        a.value = String(i);
        from.append(a);
        const b = el("option", "", label);
        b.value = String(i);
        to.append(b);
      });
      to.value = "1";
      tools.append(
        el("span", "parts-sep"),
        el("span", "parts-label", t("parts.lyricFrom")), from, el("span", "parts-label", t("parts.lyricTo")), to,
        btn(t("parts.copyLyrics"), t("parts.copyLyrics.title"), () => {
          const a = Number(from.value);
          const b = Number(to.value);
          if (a === b) return;
          void structural(t("parts.copyLyrics"), (d) => copyLyrics(d, 0, a, b) > 0);
        }, !can),
      );
    }
    body.append(tools);
    renderAssignment();
  }

  /**
   * 识别出的五线谱：「谱表 ↔ 声部」关联表（参照 Audiveris 的逻辑声部：跨系统把每行谱对到同一个声部）。
   * 每个系统一行、每行谱一个下拉：第几个声部行 / 新声部 / 忽略（钢琴伴奏不要时）。应用后按新指派重建，不重跑识别。
   */
  function renderAssignment(): void {
    const a = app.omr.staffAssignment();
    if (!a || !a.slots.length) return;
    const k = Math.max(0, ...a.slots.flat()) + 1;
    const draft = a.slots.map((row) => [...row]);
    const sec = el("div", "parts-assign");
    sec.append(el("div", "parts-assign-title", t("parts.assign.title")));
    sec.append(el("p", "parts-note", t("parts.assign.note")));
    const table = el("table", "parts-table");
    const cols = Math.max(...a.slots.map((r) => r.length));
    const head = el("tr");
    head.append(el("th", "", t("parts.assign.system")));
    for (let c = 0; c < cols; c++) head.append(el("th", "", t("parts.assign.staff", { n: c + 1 })));
    table.append(head);
    a.slots.forEach((row, si) => {
      const tr = el("tr");
      tr.append(el("td", "parts-idx", t("parts.assign.sysPage", { n: si + 1, page: a.systems[si]!.page + 1 })));
      for (let c = 0; c < cols; c++) {
        const td = el("td");
        if (c < row.length) {
          const sel = el("select", "parts-select");
          for (let v = 0; v < k; v++) {
            const o = el("option", "", t("parts.assign.row", { n: v + 1 }));
            o.value = String(v);
            sel.append(o);
          }
          const nw = el("option", "", t("parts.assign.new"));
          nw.value = String(k);
          sel.append(nw);
          const ig = el("option", "", t("parts.assign.ignore"));
          ig.value = "-1";
          sel.append(ig);
          sel.value = String(row[c]);
          sel.addEventListener("change", () => (draft[si]![c] = Number(sel.value)));
          td.append(sel);
        }
        tr.append(td);
      }
      table.append(tr);
    });
    sec.append(table);
    sec.append(btn(t("parts.assign.apply"), t("parts.assign.apply.title"), () => {
      void app.omr.rebuildStaff(draft).then((ok) => {
        if (ok) render();
      });
    }));
    body.append(sec);
  }
  render();
}
