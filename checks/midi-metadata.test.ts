import { it, expect } from 'vitest';
import { parse123 } from '../src/abcfamily/parse';
import { playSourceOf } from '../src/jianpu/playsong';
import { buildTimeline } from '../src/score/timeline';
import { toMidi } from '../src/score/midi';
it('exports written 3/4 and E-flat metadata without changing note timing', () => {
  const src = playSourceOf(parse123('X:1\nT:Metadata\nM:3/4\nQ:1/4=90\nK:1=Eb\n1 2 3 |\n'))!;
  const timeline = buildTimeline(src);
  expect(timeline.signatures).toMatchObject([{ t: 0, time: { beats: 3, beatType: 4 }, key: { fifths: -3 } }]);
  expect(timeline.notes.map(n => [n.pitch,n.t0,n.t1])).toEqual([[63,0,1],[65,1,2],[67,2,3]]);
  const hex = [...toMidi(src)].map(b => b.toString(16).padStart(2,'0')).join('');
  expect(hex).toContain('ff580403021808');
  expect(hex).toContain('ff5902fd00');
});
