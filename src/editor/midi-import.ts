import type { App } from "./app";
import { midiToMusicXml, type MidiImportOptions } from "../midi/import";
import { loadScoreDoc } from "../model/fromxml";
import { emit123 } from "../abcfamily/emit123.entry";
import { t } from "../i18n";

export function installMidiImport(app: App, reveal: () => void): void {
  const button = document.createElement("button"); button.className = "button"; button.textContent = t("midi.import");
  button.onclick = () => {
    const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".mid,.midi,audio/midi";
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file || !(await app.confirmReplace())) return;
      try {
        if (await importMidiInto(app, new Uint8Array(await file.arrayBuffer()), file.name)) reveal();
      } catch (e) { app.setStatus(e instanceof Error ? e.message : String(e)); }
    };
    picker.click();
  };
  document.getElementById("btn-export")?.before(button);
}

export function midiOptions(): Promise<MidiImportOptions | null> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "max-width:480px;padding:24px;border:1px solid #ccc;border-radius:12px";
    const title = document.createElement("h3"); title.textContent = t("midi.import");
    const help = document.createElement("p"); help.textContent = t("midi.help");
    const grid = document.createElement("select"); grid.setAttribute("aria-label", t("midi.grid"));
    for (const [value, label] of [["16", "1/16"], ["32", "1/32"], ["12", t("midi.triplet")]]) grid.add(new Option(label, value));
    const key = document.createElement("select"); key.setAttribute("aria-label", t("midi.key"));
    key.add(new Option(t("midi.autoKey"), "auto"));
    ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"].forEach((name, i) => key.add(new Option(`1=${name}`, String(i - 7))));
    const meter = document.createElement("select"); meter.setAttribute("aria-label", t("midi.meter"));
    meter.add(new Option(t("midi.autoMeter"), "auto"));
    for (const m of ["2/4", "3/4", "4/4", "6/8", "9/8", "12/8"]) meter.add(new Option(m, m));
    for (const [text, control] of [[t("midi.grid"), grid], [t("midi.key"), key], [t("midi.meter"), meter]] as const) {
      const label = document.createElement("label"); label.textContent = text + " "; label.style.cssText = "display:block;margin:12px 0"; label.append(control); dialog.append(label);
    }
    dialog.prepend(title, help);
    const finish = (result: MidiImportOptions | null) => { dialog.close(); dialog.remove(); resolve(result); };
    const ok = document.createElement("button"); ok.textContent = t("midi.import"); ok.onclick = () => {
      const options: MidiImportOptions = { division: Number(grid.value) as MidiImportOptions["division"] };
      if (key.value !== "auto") options.fifths = Number(key.value);
      if (meter.value !== "auto") [options.beats, options.beatType] = meter.value.split("/").map(Number);
      finish(options);
    };
    const cancel = document.createElement("button"); cancel.textContent = t("midi.cancel"); cancel.onclick = () => finish(null);
    dialog.oncancel = e => { e.preventDefault(); finish(null); };
    dialog.append(ok, cancel); document.body.append(dialog); dialog.showModal();
  });
}

export async function importMidiInto(app: App, bytes: Uint8Array, name: string): Promise<boolean> {
  const options = await midiOptions();
  if (!options) return false;
  const result = midiToMusicXml(bytes, name, options);
  const text = emit123(loadScoreDoc(result.xml));
  app.importBytes(new TextEncoder().encode(text), name.replace(/\.midi?$/i, ".123"));
  app.filePath = null;
  await app.setViewMode("original");
  app.setStatus(result.warnings.join(" "));
  return true;
}
