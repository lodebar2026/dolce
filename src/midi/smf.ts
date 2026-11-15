// 标准 MIDI 文件（SMF）的读取：只取导入成谱要用的事件（音符、速度、拍号、调号、轨名），其余只记「有没有」。
//
// 读得宽：规范允许的外来块（非 `MTrk`）跳过；文件尾的填充字节、截断的末轨按读到的算——
// 实际流传的 .mid 这两种都常见，按字节严格对账会把能用的文件当坏文件拒掉。
// 只认按四分音符计 tick 的（PPQ）；SMPTE 计时的不认（返回 null）。无 DOM 依赖。

export type SmfEvent =
  | { tick: number; type: "noteOn" | "noteOff"; channel: number; pitch: number; velocity: number }
  | { tick: number; type: "tempo"; usPerQuarter: number }
  | { tick: number; type: "timeSig"; beats: number; beatType: number }
  | { tick: number; type: "keySig"; fifths: number; minor: boolean }
  | { tick: number; type: "trackName"; text: string }
  /** 改变演奏而谱面上不转写的：踏板（CC 64/66/67）、调制轮（CC 1）踩下，弯音离开中位。音量、声像、音色这类设置不算 */
  | { tick: number; type: "expression"; channel: number };

export interface Smf {
  format: number;
  /** 每个四分音符的 tick 数 */
  ppq: number;
  tracks: SmfEvent[][];
}

const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u16 = (b: Uint8Array, at: number): number => (b[at]! << 8) + b[at + 1]!;

/** 读不出 SMF 头、或是 SMPTE 计时，返回 null。 */
export function parseSmf(bytes: Uint8Array): Smf | null {
  if (bytes.length < 14 || tag(bytes, 0) !== "MThd") return null;
  const headLen = u32(bytes, 4);
  if (headLen < 6) return null;
  const format = u16(bytes, 8);
  const division = u16(bytes, 12);
  if (division & 0x8000 || division === 0) return null;
  const tracks: SmfEvent[][] = [];
  for (let at = 8 + headLen; at + 8 <= bytes.length;) {
    const len = u32(bytes, at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + len));
    if (tag(bytes, at) === "MTrk") tracks.push(parseTrack(body));
    at += 8 + len;
  }
  return { format, ppq: division, tracks };
}

function parseTrack(b: Uint8Array): SmfEvent[] {
  const out: SmfEvent[] = [];
  let at = 0;
  let tick = 0;
  let running = 0;
  const varlen = (): number => {
    let v = 0;
    for (let k = 0; k < 4 && at < b.length; k++) {
      const c = b[at++]!;
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    return v;
  };
  while (at < b.length) {
    tick += varlen();
    if (at >= b.length) break;
    let status = b[at]!;
    if (status & 0x80) at++;
    else if (running) status = running; // 连续状态：沿用上一条通道消息的状态字节
    else break; // 没有状态可沿用：坏了，后面不读
    if (status === 0xff) {
      const type = b[at++];
      const len = varlen();
      const data = b.subarray(at, Math.min(b.length, at + len));
      at += len;
      if (type === 0x2f) break;
      if (type === 0x51 && data.length >= 3) out.push({ tick, type: "tempo", usPerQuarter: (data[0]! << 16) + (data[1]! << 8) + data[2]! });
      else if (type === 0x58 && data.length >= 2) out.push({ tick, type: "timeSig", beats: data[0]!, beatType: 2 ** data[1]! });
      else if (type === 0x59 && data.length >= 2) out.push({ tick, type: "keySig", fifths: (data[0]! << 24) >> 24, minor: data[1] === 1 });
      else if (type === 0x03) out.push({ tick, type: "trackName", text: decodeText(data) });
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      at += varlen();
      continue;
    }
    if (status >= 0xf0) break; // 文件里不该有的实时消息：当坏轨处理
    running = status;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const d1 = b[at++] ?? 0;
    const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : b[at++] ?? 0;
    if (kind === 0x90 && d2 > 0) out.push({ tick, type: "noteOn", channel, pitch: d1, velocity: d2 });
    else if (kind === 0x80 || kind === 0x90) out.push({ tick, type: "noteOff", channel, pitch: d1, velocity: d2 });
    else if ((kind === 0xb0 && [1, 64, 66, 67].includes(d1) && d2 > 0) || (kind === 0xe0 && (d2 << 7) + d1 !== 0x2000)) out.push({ tick, type: "expression", channel });
  }
  return out;
}

/** 轨名：先按 UTF-8，不合法再按 GBK（国内软件导出的中文轨名多是 GBK）。 */
function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).trim();
  } catch {
    try {
      return new TextDecoder("gbk").decode(data).trim();
    } catch {
      return "";
    }
  }
}
