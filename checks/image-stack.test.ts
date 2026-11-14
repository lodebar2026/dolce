import { it, expect } from 'vitest';
import { imageStackLayout } from '../src/omrkit/image-stack';
  it('keeps every ordered image inside the composite bounds and rejects oversized images', () => {
    const l = imageStackLayout([{width:500,height:600},{width:1000,height:400}]);
    expect(l.pages.map(p => p.y)).toEqual([0,1232]);
    expect(l.height).toBe(1632);
    expect(() => imageStackLayout([{width:5000,height:6000}])).toThrow();
    expect(() => imageStackLayout(Array(11).fill({width:10,height:10}))).toThrow();
  });
