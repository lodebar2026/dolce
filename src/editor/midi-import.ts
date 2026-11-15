// 打开 MIDI：问量化网格与调号拍号 → `midi/import.ts` 建模型 → 唯一写出端 `toxml.ts` 写成 MusicXML →
// 按打开 MusicXML 的流程落地（转成设置里的默认编辑格式，多声部进五线谱）。原 .mid 不动，存盘走另存为。
import type { App } from "./app";
import { midiToScoreDoc, type MidiGrid, type MidiImportOptions } from "../midi/import";
import { scoreDocToMusicXml } from "../model/toxml";
import { labeled, showFormDialog } from "./dialogs";
import { t } from "../i18n";

const KEY_NAMES = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const METERS = ["2/4", "3/4", "4/4", "6/8", "9/8", "12/8"];

function select(options: readonly [string, string][]): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [value, label] of options) sel.add(new Option(label, value));
  return sel;
}

/** 导入选项对话框；取消返回 null。 */
export function midiImportOptions(): Promise<MidiImportOptions | null> {
  return new Promise((resolve) => {
    const grid = select([["16t", t("midi.gridMixed")], ["16", "1/16"], ["32", "1/32"]]);
    const key = select([["auto", t("midi.autoKey")], ...KEY_NAMES.map((n, i): [string, string] => [String(i - 7), `1=${n}`])]);
    const meter = select([["auto", t("midi.autoMeter")], ...METERS.map((m): [string, string] => [m, m])]);
    const body = document.createElement("div");
    const help = document.createElement("div");
    help.className = "modal-row";
    help.textContent = t("midi.help");
    body.append(help, labeled(t("midi.grid"), grid), labeled(t("midi.key"), key), labeled(t("midi.meter"), meter));
    showFormDialog(t("midi.import"), body, () => {
      const options: MidiImportOptions = { grid: grid.value as MidiGrid };
      if (key.value !== "auto") options.fifths = Number(key.value);
      if (meter.value !== "auto") [options.beats, options.beatType] = meter.value.split("/").map(Number);
      resolve(options);
    }, t("midi.import"), () => resolve(null));
  });
}

/** 打开一份 MIDI（打开对话框、拖入都走这里；替换前的确认由调用方做过）。落地了返回 true。 */
export async function openMidi(app: App, bytes: Uint8Array, path: string): Promise<boolean> {
  const options = await midiImportOptions();
  if (!options) return false;
  const name = path.split(/[\\/]/).pop()!.replace(/\.midi?$/i, "");
  let xml: string;
  let warnings: string[];
  try {
    const r = midiToScoreDoc(bytes, name, options);
    xml = scoreDocToMusicXml(r.doc);
    warnings = r.warnings;
  } catch (e) {
    app.setStatus(e instanceof Error ? e.message : String(e));
    return false;
  }
  app.importBytes(new TextEncoder().encode(xml), `${name}.musicxml`);
  app.filePath = null; // 存不回 .mid：保存走另存为
  await app.onDocumentOpened(warnings);
  return true;
}
