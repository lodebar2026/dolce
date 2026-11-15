import { it, expect } from 'vitest';
import { writeMidi } from 'midi-file';
import { midiToMusicXml } from '../src/midi/import';
import { loadScoreDoc } from '../src/model/fromxml';
import { emit123 } from '../src/abcfamily/emit123.entry';
import { parse123 } from '../src/abcfamily/parse';
import { playSourceOf } from '../src/jianpu/playsong';
import { buildTimeline } from '../src/score/timeline';

  it('imports and re-exports a 3/4 E-flat score with a chord, rest and cross-bar held note', () => {
    const bytes = new Uint8Array(writeMidi({header:{format:1,numTracks:2,ticksPerBeat:480},tracks:[[
      {deltaTime:0,type:'timeSignature',numerator:3,denominator:4,metronome:24,thirtyseconds:8},
      {deltaTime:0,type:'keySignature',key:-3,scale:0},
      {deltaTime:0,type:'setTempo',microsecondsPerBeat:500000},
      {deltaTime:0,type:'endOfTrack'}
    ],[
      {deltaTime:480,type:'noteOn',channel:0,noteNumber:63,velocity:80},
      {deltaTime:0,type:'noteOn',channel:0,noteNumber:67,velocity:80},
      {deltaTime:1440,type:'noteOff',channel:0,noteNumber:63,velocity:0},
      {deltaTime:0,type:'noteOff',channel:0,noteNumber:67,velocity:0},
      {deltaTime:0,type:'endOfTrack'}
    ]]}));
    const converted = midiToMusicXml(bytes,'test.mid',{division:16});
    const text = emit123(loadScoreDoc(converted.xml));
    const doc = parse123(text);
    const source = playSourceOf(doc)!;
    expect(buildTimeline(source).notes.map(n => [n.pitch,n.t0,n.t1])).toEqual([[63,1,4],[67,1,4]]);
  });

it.each([
  { division: 16 as const, durations: [600,120,240], ends: [1.25,1.5,2] },
  { division: 12 as const, durations: [160,160,160], ends: [1/3,2/3,1] },
])('retains quantized timing and tempo with grid $division', ({division,durations,ends}) => {
  const bytes = new Uint8Array(writeMidi({header:{format:0,numTracks:1,ticksPerBeat:480},tracks:[[
    {deltaTime:0,type:'setTempo',microsecondsPerBeat:1000000},
    ...durations.flatMap((duration,i) => [
      {deltaTime:0,type:'noteOn' as const,channel:0,noteNumber:60+i,velocity:80},
      {deltaTime:duration,type:'noteOff' as const,channel:0,noteNumber:60+i,velocity:0},
    ]),
    {deltaTime:0,type:'endOfTrack'},
  ]]}));
  const result = midiToMusicXml(bytes,'timing.mid',{division});
  const text = emit123(loadScoreDoc(result.xml));
  const source = playSourceOf(parse123(text))!;
  expect(source.playData.tempo).toBe(60);
  const notes = buildTimeline(source).notes;
  expect(notes).toHaveLength(3);
  notes.forEach((n,i) => expect(n.t1).toBeCloseTo(ends[i]!,8));
});
