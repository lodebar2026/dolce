// Node 侧字体定位：CSS 族名 + 字重/字形 → 系统里的那一支字（文件 + ttc 子字体序号），取字节给 fontkit。
//
// 测量后端（common/measure.font.ts）是**同步**调用的，所以这里全用同步 IO，只读表头
//（ttc 目录、name、OS/2），不整份读文件；找到以后才读字节。
// 匹配口径照浏览器：族名比 name 表的 nameID 1/16（任一语言，不分大小写），字重按 CSS 字体匹配算法挑最近的
//（PingFang SC 没有 700，`bold` 落到 Semibold 600），斜体有就挑斜体。
// 先按文件名里的关键词缩小范围（"PingFang SC" → PingFang.ttc），找不到再把字体目录整个过一遍名字表。
//
// 成书 PDF 那一路（dev 的 fontres.mjs / pdfwrite.mjs）也从这里取字节，量字与落字同一份。
// **只许进 Node 入口（cli/*）的 import 链。**

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FontFile, FontLocator } from "../common/measure.font";
import type { FontStyle, FontWeight } from "../common/measure";

const FONT_DIRS = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  join(homedir(), "Library/Fonts"),
  "/System/Library/AssetsV2",
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  join(homedir(), ".fonts"),
  join(homedir(), ".local/share/fonts"),
  "C:\\Windows\\Fonts",
];

const FONT_EXT = /\.(otf|ttf|ttc)$/i;

export interface FaceInfo {
  file: string;
  /** ttc 里的子字体序号；单字体文件为 0 */
  index: number;
  /** nameID 1 与 16 的全部取值（各语言），小写 */
  families: string[];
  /** nameID 6 */
  postscript: string;
  /** OS/2 usWeightClass */
  weight: number;
  italic: boolean;
}

function readAt(fd: number, off: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  readSync(fd, b, 0, len, off);
  return b;
}

function decodeName(raw: Buffer, platform: number): string {
  // 先拷贝再换字节序：swap16 是原地改的
  if ((platform === 3 || platform === 0) && raw.length % 2 === 0) return Buffer.from(raw).swap16().toString("utf16le");
  return raw.toString("latin1");
}

function readFace(fd: number, file: string, off: number, index: number): FaceInfo | null {
  const head = readAt(fd, off, 12);
  const numTables = head.readUInt16BE(4);
  const dir = readAt(fd, off + 12, numTables * 16);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const r = i * 16;
    tables.set(dir.toString("latin1", r, r + 4), { offset: dir.readUInt32BE(r + 8), length: dir.readUInt32BE(r + 12) });
  }
  const nameT = tables.get("name");
  if (!nameT) return null;
  const name = readAt(fd, nameT.offset, nameT.length);
  const count = name.readUInt16BE(2);
  const strOff = name.readUInt16BE(4);
  const families = new Set<string>();
  let postscript = "";
  for (let k = 0; k < count; k++) {
    const r = 6 + k * 12;
    if (r + 12 > name.length) break;
    const platform = name.readUInt16BE(r);
    const nameId = name.readUInt16BE(r + 6);
    if (nameId !== 1 && nameId !== 16 && nameId !== 6) continue;
    const len = name.readUInt16BE(r + 8);
    const o = strOff + name.readUInt16BE(r + 10);
    if (o + len > name.length) continue;
    const s = decodeName(name.subarray(o, o + len), platform).trim();
    if (!s) continue;
    if (nameId === 6) postscript ||= s;
    else families.add(s.toLowerCase());
  }
  let weight = 400;
  let italic = false;
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 64) {
    const b = readAt(fd, os2.offset, 64);
    weight = b.readUInt16BE(4);
    const fsSel = b.readUInt16BE(62);
    italic = (fsSel & 1) !== 0 || (fsSel & (1 << 9)) !== 0;
  }
  return { file, index, families: [...families], postscript, weight, italic };
}

const facesCache = new Map<string, FaceInfo[]>();

/** 一个字体文件里的全部子字体（读不了的文件给空表）。 */
export function facesOf(file: string): FaceInfo[] {
  const hit = facesCache.get(file);
  if (hit) return hit;
  let out: FaceInfo[] = [];
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const head = readAt(fd, 0, 12);
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const n = head.readUInt32BE(8);
      const offs = readAt(fd, 12, n * 4);
      for (let i = 0; i < n; i++) {
        const f = readFace(fd, file, offs.readUInt32BE(i * 4), i);
        if (f) out.push(f);
      }
    } else {
      const f = readFace(fd, file, 0, 0);
      if (f) out.push(f);
    }
  } catch {
    out = [];
  } finally {
    if (fd >= 0) closeSync(fd);
  }
  facesCache.set(file, out);
  return out;
}

let allFiles: string[] | null = null;

/** 字体目录里全部字体文件（递归；读不了的子目录跳过）。只在头一次用到时扫。 */
function fontFiles(): string[] {
  if (allFiles) return allFiles;
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (FONT_EXT.test(e.name)) out.push(p);
    }
  };
  const seen = new Set<string>();
  for (const d of FONT_DIRS) {
    if (seen.has(d) || !existsSync(d)) continue;
    seen.add(d);
    // Supplemental 在 Fonts 底下，递归时已经走过
    if (FONT_DIRS.some((p) => p !== d && d.startsWith(p + "/") && seen.has(p))) continue;
    walk(d);
  }
  allFiles = out;
  return out;
}

const familyCache = new Map<string, FaceInfo[]>();

/** 族名 → 这个族的全部子字体。先按文件名关键词找（快），落空再整个过一遍名字表。 */
export function familyFaces(family: string): FaceInfo[] {
  const want = family.toLowerCase();
  const hit = familyCache.get(want);
  if (hit) return hit;
  const ofFamily = (files: string[]) => files.flatMap(facesOf).filter((f) => f.families.includes(want));
  const keys = [family, family.replace(/\s+/g, ""), family.split(/\s+/)[0]!]
    .map((k) => k.toLowerCase())
    .filter((k, i, a) => k && a.indexOf(k) === i);
  let faces: FaceInfo[] = [];
  for (const key of keys) {
    faces = ofFamily(fontFiles().filter((p) => p.toLowerCase().includes(key)));
    if (faces.length) break;
  }
  if (!faces.length) faces = ofFamily(fontFiles());
  familyCache.set(want, faces);
  return faces;
}

/** CSS Fonts 4 §5.2 的字重与字形匹配：同字形里挑最近的字重。 */
export function matchFace(faces: FaceInfo[], weight: number, italic: boolean): FaceInfo | null {
  if (!faces.length) return null;
  const sameStyle = faces.filter((f) => f.italic === italic);
  const pool = sameStyle.length ? sameStyle : faces;
  const exact = pool.find((f) => f.weight === weight);
  if (exact) return exact;
  const asc = (xs: FaceInfo[]) => [...xs].sort((a, b) => a.weight - b.weight);
  const desc = (xs: FaceInfo[]) => [...xs].sort((a, b) => b.weight - a.weight);
  let order: FaceInfo[];
  if (weight >= 400 && weight <= 500) {
    order = [
      ...asc(pool.filter((f) => f.weight > weight && f.weight <= 500)),
      ...desc(pool.filter((f) => f.weight < weight)),
      ...asc(pool.filter((f) => f.weight > 500)),
    ];
  } else if (weight < 400) {
    order = [...desc(pool.filter((f) => f.weight < weight)), ...asc(pool.filter((f) => f.weight > weight))];
  } else {
    order = [...asc(pool.filter((f) => f.weight > weight)), ...desc(pool.filter((f) => f.weight < weight))];
  }
  return order[0] ?? null;
}

/**
 * 抽出 ttc 里的一个子字体，返回独立 sfnt 的字节（pdf-lib 的 embedFont 只吃单个 sfnt）。
 * 各子字体常共享同一份表数据，所以不能整段切，得按表记录重新拼。单字体文件原样返回。
 */
export function extractFace(file: string, index = 0): Uint8Array {
  const buf = readFileSync(file);
  if (buf.toString("latin1", 0, 4) !== "ttcf") return new Uint8Array(buf);
  const n = buf.readUInt32BE(8);
  if (index < 0 || index >= n) throw new Error(`${file} 里没有第 ${index} 个子字体（共 ${n} 个）`);
  const off = buf.readUInt32BE(12 + index * 4);
  const sfntVersion = buf.readUInt32BE(off);
  const numTables = buf.readUInt16BE(off + 4);
  const records: { tag: string; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    records.push({
      tag: buf.toString("latin1", r, r + 4),
      checksum: buf.readUInt32BE(r + 4),
      offset: buf.readUInt32BE(r + 8),
      length: buf.readUInt32BE(r + 12),
    });
  }
  records.sort((a, b) => (a.tag < b.tag ? -1 : 1)); // 表目录按 tag 升序
  const dirSize = 12 + numTables * 16;
  const pad4 = (v: number) => (v + 3) & ~3;
  let total = dirSize;
  for (const r of records) total += pad4(r.length);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  const p2 = Math.pow(2, Math.floor(Math.log2(numTables)));
  out.writeUInt16BE(p2 * 16, 6);
  out.writeUInt16BE(Math.log2(p2), 8);
  out.writeUInt16BE(numTables * 16 - p2 * 16, 10);
  let cursor = dirSize;
  records.forEach((r, i) => {
    const rec = 12 + i * 16;
    out.write(r.tag, rec, 4, "latin1");
    out.writeUInt32BE(r.checksum, rec + 4);
    out.writeUInt32BE(cursor, rec + 8);
    out.writeUInt32BE(r.length, rec + 12);
    buf.copy(out, cursor, r.offset, r.offset + r.length);
    cursor += pad4(r.length);
  });
  return new Uint8Array(out);
}

const bytesCache = new Map<string, Uint8Array>();

function bytesOf(file: string, index: number): Uint8Array {
  const key = `${file}#${index}`;
  let b = bytesCache.get(key);
  if (!b) bytesCache.set(key, (b = extractFace(file, index)));
  return b;
}

/**
 * 系统字体定位器。`files` 给出不在系统里、按族名直接指定文件的字（Bravura 两支、成书注册的字体）。
 * 挑到的字重不够 600 而要的是粗体时标 `synthBold`（浏览器此时合成粗体）。
 */
export function nodeFontLocator(files: Record<string, string> = {}): FontLocator {
  const fixed = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return (family: string, weight: FontWeight, style: FontStyle): FontFile | null => {
    const w = weight === "bold" ? 700 : 400;
    const italic = style === "italic";
    const file = fixed.get(family.toLowerCase());
    let face: FaceInfo | null;
    if (file) {
      if (!existsSync(file) || !statSync(file).isFile()) return null;
      face = matchFace(facesOf(file), w, italic) ?? { file, index: 0, families: [], postscript: "", weight: 400, italic: false };
    } else {
      face = matchFace(familyFaces(family), w, italic);
    }
    if (!face) return null;
    return {
      bytes: bytesOf(face.file, face.index),
      key: `${face.file}#${face.index}`,
      synthBold: w >= 600 && face.weight < 600,
      synthItalic: italic && !face.italic,
    };
  };
}
