// Ported from mp/score/midi.kt (ToMidi). Builds a Standard MIDI File (format 1)
// in pure TS: a tempo meta track + one track per part, note on/off per chord (velocity from dynamics).
// Note timing comes from buildTimeline (shared with the in-editor player), so the
// exported MIDI honors the expanded play order (repeats / voltas / D.C. / D.S.).

import { buildTimeline, partGain, PlayOptions, PlaySource, playTempo, TimedNote, type Timeline } from "./timeline";

const PPQ = 960;

interface Ev {
  tick: number;
  data: number[];
  order: number; // tie-break: note-off (0) before note-on (1) at same tick
}

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function trackChunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let prev = 0;
  for (const e of events) {
    body.push(...varLen(e.tick - prev));
    body.push(...e.data);
    prev = e.tick;
  }
  body.push(...varLen(0), 0xff, 0x2f, 0x00); // end of track
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...body];
}

function tempoTrack(bpm: number): number[] {
  const mpqn = Math.round(60000000 / bpm);
  const ev: Ev = {
    tick: 0,
    order: 0,
    data: [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff],
  };
  return trackChunk([ev]);
}

/** GM 的打击乐通道（第 10 通道）：声部不占它，节拍器的嘀嗒写在这儿。 */
const DRUM_CHANNEL = 9;
/** 节拍器的音：小节第一拍高木鱼、其余低木鱼（GM 1 就有，各家音源都认）。 */
const CLICK_DOWN = 76;
const CLICK_BEAT = 77;

function partTrack(notes: TimedNote[], partIdx: number, opts?: PlayOptions): number[] {
  // 第 10 个声部起让过打击乐通道
  const channel = (partIdx < DRUM_CHANNEL ? partIdx : partIdx + 1) & 0x0f;
  const events: Ev[] = [];
  // Channel Volume (CC7) at tick 0 sets this part's level in the GM synth.
  const vol = Math.round(partGain(opts, partIdx) * 127);
  events.push({ tick: 0, order: 0, data: [0xb0 | channel, 0x07, vol & 0x7f] });
  for (const n of notes) {
    if (n.part !== partIdx) continue;
    const start = Math.round(n.t0 * PPQ);
    const end = Math.round(n.t1 * PPQ);
    events.push({ tick: start, order: 1, data: [0x90 | channel, n.pitch & 0x7f, n.velocity & 0x7f] });
    events.push({ tick: end, order: 0, data: [0x80 | channel, n.pitch & 0x7f, 0] });
  }
  return trackChunk(events);
}

/** 节拍器轨：每拍一个打击乐音，小节第一拍高一些、响一些。 */
function clickTrack(clicks: Timeline["clicks"]): number[] {
  const events: Ev[] = [];
  for (const c of clicks) {
    const start = Math.round(c.t * PPQ);
    const pitch = c.down ? CLICK_DOWN : CLICK_BEAT;
    events.push({ tick: start, order: 1, data: [0x90 | DRUM_CHANNEL, pitch, c.down ? 120 : 90] });
    events.push({ tick: start + PPQ / 8, order: 0, data: [0x80 | DRUM_CHANNEL, pitch, 0] });
  }
  return trackChunk(events);
}

/**
 * `click` = 把节拍器的嘀嗒写成一条打击乐轨（`opts.metronome` 开着才有）。只有原生音源试听传它：
 * 嘀嗒与音符由同一个定序器播，不会错拍。导出 MIDI 不传，文件里不带节拍器。
 */
export function toMidi(src: PlaySource, opts?: PlayOptions, click = false): Uint8Array {
  const { notes, clicks } = buildTimeline(src);
  const withClick = click && opts?.metronome === true && clicks.length > 0;
  const ntracks = 1 + src.parts.length + (withClick ? 1 : 0);
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd, len 6
    0, 1, // format 1
    (ntracks >> 8) & 0xff, ntracks & 0xff,
    (PPQ >> 8) & 0xff, PPQ & 0xff, // division (ticks per quarter)
  ];
  const out: number[] = [...header, ...tempoTrack(playTempo(src, opts))];
  for (let i = 0; i < src.parts.length; i++) out.push(...partTrack(notes, i, opts));
  if (withClick) out.push(...clickTrack(clicks));
  return new Uint8Array(out);
}
