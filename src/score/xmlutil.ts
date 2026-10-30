// MusicXML 写出端（model/toxml.ts）的转义，与投影（model/xmlproject.ts）用的 `<type>` 反推。
// 建树、解析、序列化在 ./xmltree.ts，读树的小工具在 ./xmldom.ts。
import { Fraction } from "../common/fraction";

// XML 1.0 不许出现的控制字符一并剔掉：矢量识别从没有 ToUnicode 的音乐字体里取文字，
// 会吐出 \x03 之类（牵我的手的速度「= 60」），原样写进去整份文件就读不开了
export const escapeXml = (s: string): string =>
  s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "")
    .replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

export const escapeAttr = (s: string): string => escapeXml(s).replace(/"/g, "&quot;");

const BASES: Array<[string, number]> = [
  ["whole", 4], ["half", 2], ["quarter", 1], ["eighth", 0.5],
  ["16th", 0.25], ["32nd", 0.125], ["64th", 0.0625],
];

/** BASES 里的值都是 2 的幂或其倒数，×16 后必为整数。 */
const frac = (v: number): Fraction => new Fraction(Math.round(v * 16), 16);

/** 由总时值（四分音符为 1）反推 `<type>` + 附点数，Fraction 精确比较。 */
export function typeOfDuration(duration: Fraction): { type: string; dots: number } {
  const q = duration;
  for (const [type, val] of BASES) {
    const b = frac(val);
    if (q.equals(b)) return { type, dots: 0 };
    if (q.equals(b.times(new Fraction(3, 2)))) return { type, dots: 1 };
    if (q.equals(b.times(new Fraction(7, 4)))) return { type, dots: 2 };
  }
  for (const [type, val] of BASES) if (q.compareTo(frac(val)) >= 0) return { type, dots: 0 };
  return { type: "64th", dots: 0 };
}
