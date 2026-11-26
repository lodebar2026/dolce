// MusicXML 形状的 `Song` → **简谱形状**的 `Song`：简谱排版与 123 写出端之前的投影（与 `xmlproject.ts` 方向相反）。
// 在 Rust（`crates/model/src/jianpuproject.rs`，判据与「原生 ABC 也要投」的理由见那边），这里是门面：
// 模型本身不动，在副本上投影，按 `Song` 对象缓存；不必投的原样返回。

import type { Song } from "./doc";
import { dolce } from "../common/dolce";
import { call } from "./rustdoc";

const cache = new WeakMap<Song, Song>();

export function projectForJianpu(src: Song): Song {
  const hit = cache.get(src);
  if (hit) return hit;
  const out = call(() => dolce().modelProjectForJianpu(JSON.stringify(src)));
  if (out === undefined) return src;
  const song = JSON.parse(out) as Song;
  cache.set(src, song);
  return song;
}
