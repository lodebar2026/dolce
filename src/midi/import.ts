import { parseMidi } from "midi-file";
import { t } from "../i18n";

export interface MidiImportOptions { division: 12 | 16 | 32; fifths?: number; beats?: number; beatType?: number }
type Note = { start: number; end: number; pitch: number };
type Meter = { tick: number; beats: number; beatType: number };
type Key = { tick: number; fifths: number; minor: boolean };
const PPQ = 960;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const at = <T extends { tick: number }>(events: T[], tick: number): T => events.filter(e => e.tick <= tick).slice(-1)[0]!;

/** Quantized notation import, not a lossless MIDI event editor. */
export function midiToMusicXml(bytes: Uint8Array, name: string, options: MidiImportOptions): { xml: string; warnings: string[]; noteCount: number } {
  if (bytes.length < 14 || bytes.length > 10 * 1024 * 1024) throw new Error(t("midi.invalid"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  if (tag(0) !== "MThd" || view.getUint32(4) < 6) throw new Error(t("midi.invalid"));
  let offset = 8 + view.getUint32(4);
  for (let i = 0; i < view.getUint16(10); i++) {
    if (offset + 8 > bytes.length || tag(offset) !== "MTrk") throw new Error(t("midi.invalid"));
    offset += 8 + view.getUint32(offset + 4);
    if (offset > bytes.length) throw new Error(t("midi.invalid"));
  }
  if (offset !== bytes.length) throw new Error(t("midi.invalid"));
  const data = parseMidi(bytes);
  if (![0, 1].includes(data.header.format) || !data.header.ticksPerBeat || data.header.ticksPerBeat <= 0) throw new Error(t("midi.invalid"));
  const unit = PPQ / data.header.ticksPerBeat;
  const quantum = 4 * PPQ / options.division;
  const quantize = (tick: number) => Math.max(0, Math.round(tick * unit / quantum) * quantum);
  const meters: Meter[] = [{ tick: 0, beats: options.beats ?? 4, beatType: options.beatType ?? 4 }];
  const keys: Key[] = [{ tick: 0, fifths: options.fifths ?? 0, minor: false }];
  const tempos: { tick: number; bpm: number }[] = [];
  const parts: { name: string; notes: Note[] }[] = [];
  let drums = false, controls = false, dangling = false;
  for (const [trackIndex, track] of data.tracks.entries()) {
    let tick = 0;
    let trackName = `Track ${trackIndex + 1}`;
    const channels = new Map<number, Note[]>();
    const open = new Map<string, { start: number; pitch: number }[]>();
    for (const event of track) {
      tick += event.deltaTime;
      if (!Number.isSafeInteger(tick) || tick < 0) throw new Error(t("midi.invalid"));
      if (event.type === "trackName") trackName = event.text;
      if (event.type === "setTempo") tempos.push({ tick, bpm: 60000000 / event.microsecondsPerBeat });
      if (event.type === "timeSignature" && options.beats === undefined) meters.push({ tick: quantize(tick), beats: event.numerator, beatType: event.denominator });
      if (event.type === "keySignature" && options.fifths === undefined) keys.push({ tick: quantize(tick), fifths: event.key, minor: event.scale === 1 });
      if (event.type === "controller" || event.type === "pitchBend") controls = true;
      if (event.type !== "noteOn" && event.type !== "noteOff") continue;
      if (event.channel === 9) { drums = true; continue; }
      const key = `${event.channel}:${event.noteNumber}`;
      const queue = open.get(key) ?? [];
      if (event.type === "noteOn" && event.velocity > 0) queue.push({ start: tick, pitch: event.noteNumber });
      else {
        const n = queue.shift();
        if (n) {
          const start = quantize(n.start), end = Math.max(start + quantum, quantize(tick));
          const ns = channels.get(event.channel) ?? [];
          ns.push({ start, end, pitch: n.pitch }); channels.set(event.channel, ns);
        }
      }
      open.set(key, queue);
    }
    dangling ||= [...open.values()].some(q => q.length);
    for (const [channel, notes] of channels) if (notes.length) parts.push({ name: channels.size > 1 ? `${trackName} · ${channel + 1}` : trackName, notes });
  }
  const noteCount = parts.reduce((n, p) => n + p.notes.length, 0);
  if (!noteCount || noteCount > 20000 || parts.length > 32) throw new Error(t("midi.limit"));
  meters.sort((a, b) => a.tick - b.tick); keys.sort((a, b) => a.tick - b.tick); tempos.sort((a, b) => a.tick - b.tick);
  const bpm = tempos[0]?.bpm ?? 120;
  if (!(bpm > 0 && Number.isFinite(bpm))) throw new Error(t("midi.invalid"));
  const end = Math.max(...parts.flatMap(p => p.notes.map(n => n.end)));
  const bars: { start: number; end: number; meter: Meter; key: Key }[] = [];
  for (let start = 0; start < end;) {
    if (bars.length >= 2000) throw new Error(t("midi.limit"));
    const meter = at(meters, start), key = at(keys, start);
    if (!(meter.beats >= 1 && meter.beats <= 32) || ![1, 2, 4, 8, 16, 32, 64].includes(meter.beatType) || Math.abs(key.fifths) > 7) throw new Error(t("midi.invalid"));
    const nextChange = Math.min(...[...meters, ...keys].filter(e => e.tick > start).map(e => e.tick), Infinity);
    const barEnd = Math.min(start + PPQ * 4 * meter.beats / meter.beatType, nextChange);
    bars.push({ start, end: barEnd, meter, key }); start = barEnd;
  }
  const values: [number, string, number][] = [[3840,"whole",0],[2880,"half",1],[1920,"half",0],[1440,"quarter",1],[960,"quarter",0],[720,"eighth",1],[480,"eighth",0],[360,"16th",1],[240,"16th",0],[180,"32nd",1],[120,"32nd",0],[60,"64th",0],[30,"128th",0]];
  const pieces = (duration: number): number[] => {
    const allowed = [...values.map(v => v[0]), ...(options.division === 12 ? values.filter(v => !v[2]).map(v => v[0] * 2 / 3) : [])].sort((a,b) => b-a);
    const out: number[] = [];
    while (duration > 0) {
      const length = allowed.find(v => v <= duration);
      if (!length) throw new Error(t("midi.invalid"));
      out.push(length); duration -= length;
    }
    return out;
  };
  // The existing Jianpu player pairs distinct tuplet endpoints. Represent an
  // isolated triplet as two tied halves, avoiding a start+stop on one note.
  const fragments = (duration: number) => pieces(duration).flatMap(length =>
    options.division === 12 && !values.some(v => v[0] === length)
      ? [{ duration: length / 2, tuplet: "start" }, { duration: length / 2, tuplet: "stop" }]
      : [{ duration: length, tuplet: "" }]);
  const noteXml = (duration: number, voice: number, pitch?: number, chord = false, tieStart = false, tieStop = false, flat = false, tuplet = ""): string => {
    const names = flat ? ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"] : ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
    const natural = [0, 2, 4, 5, 7, 9, 11];
    const pc = (pitch ?? 60) % 12, step = names[pc]!;
    const alter = pc - natural["CDEFGAB".indexOf(step)]!;
    const pitchXml = pitch === undefined ? "<rest/>" : `<pitch><step>${step}</step><alter>${alter}</alter><octave>${Math.floor(pitch / 12) - 1}</octave></pitch>`;

    const value = values.find(v => v[0] === duration);
    const triplet = options.division === 12 && !value ? values.find(v => v[0] === duration * 1.5 && !v[2]) : undefined;
    const typ = value ? `<type>${value[1]}</type>${value[2] ? "<dot/>" : ""}` : triplet ? `<type>${triplet[1]}</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>` : "";
    return `<note>${chord ? "<chord/>" : ""}${pitchXml}<duration>${duration}</duration>${tieStop ? '<tie type="stop"/>' : ""}${tieStart ? '<tie type="start"/>' : ""}<voice>${voice}</voice>${typ}${tieStart || tieStop || tuplet ? `<notations>${tuplet ? `<tuplet type="${tuplet}" number="1"/>` : ""}${tieStop ? '<tied type="stop"/>' : ""}${tieStart ? '<tied type="start"/>' : ""}</notations>` : ""}</note>`;
  };
  const partXml = parts.map((p, pi) => {
    const groups = new Map<string, Note[]>();
    for (const n of p.notes) { const k = `${n.start}:${n.end}`; groups.set(k, [...(groups.get(k) ?? []), n]); }
    const voices: Note[][][] = [];
    for (const g of [...groups.values()].sort((a, b) => a[0]!.start - b[0]!.start || b[0]!.end - a[0]!.end)) {
      let v = voices.findIndex(v => v[v.length - 1]![0]!.end <= g[0]!.start);
      if (v < 0) { v = voices.length; voices.push([]); }
      if (v >= 16) throw new Error(t("midi.limit"));
      voices[v]!.push(g);
    }
    const body = bars.map((bar, bi) => {
      let xml = `<measure number="${bi + 1}"><attributes><divisions>${PPQ}</divisions><key><fifths>${bar.key.fifths}</fifths><mode>${bar.key.minor ? "minor" : "major"}</mode></key><time><beats>${bar.meter.beats}</beats><beat-type>${bar.meter.beatType}</beat-type></time></attributes>`;
      if (bi === 0) xml += `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`;
      voices.forEach((voice, vi) => {
        if (vi) xml += `<backup><duration>${bar.end - bar.start}</duration></backup>`;
        let pos = bar.start;
        for (const group of voice) {
          const n = group[0]!;
          if (n.start >= bar.end || n.end <= bar.start) continue;
          const start = Math.max(n.start, bar.start), stop = Math.min(n.end, bar.end);
          if (start > pos) for (const f of fragments(start - pos)) xml += noteXml(f.duration, vi + 1, undefined, false, false, false, false, f.tuplet);
          const segments = fragments(stop - start);
          segments.forEach((f, si) => group.forEach((note, ni) => {
            xml += noteXml(f.duration, vi + 1, note.pitch, ni > 0, si < segments.length - 1 || n.end > bar.end, si > 0 || n.start < bar.start, bar.key.fifths < 0, ni === 0 ? f.tuplet : "");
          }));
          pos = stop;
        }
        if (pos < bar.end) for (const f of fragments(bar.end - pos)) xml += noteXml(f.duration, vi + 1, undefined, false, false, false, false, f.tuplet);
      });
      return xml + "</measure>";
    }).join("");
    return `<part id="P${pi + 1}">${body}</part>`;
  }).join("");
  const warnings = [t("midi.quantized")];
  if (tempos.some(e => Math.abs(e.bpm - bpm) > 0.01)) warnings.push(t("midi.tempoWarning"));
  if (drums) warnings.push(t("midi.drumsWarning"));
  if (controls) warnings.push(t("midi.controlWarning"));
  if (dangling) warnings.push(t("midi.danglingWarning"));
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${escape(name.replace(/\.midi?$/i, ""))}</work-title></work><part-list>${parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${escape(p.name)}</part-name></score-part>`).join("")}</part-list>${partXml}</score-partwise>`;
  return { xml, warnings, noteCount };
}
