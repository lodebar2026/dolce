// 各源格式的**文件**层：默认扩展名与落盘编码（.jpwabc 存 UTF-16LE 带 BOM、.jcx 存 GBK、其余 UTF-8）。
// 编辑器的格式适配器（`editor/formats.ts`）与 Node 端歌本识别（`omr/booksplit/recognize.ts`）共用。无 DOM 依赖。
import { encodeJpwabc } from "../common/jpwcodec";
import { encodeJcx } from "../common/jcxcodec";

export type DocFormatId = "jpwabc" | "fanqie" | "123" | "abc" | "musicxml" | "jly" | "jcx";

export const DOC_EXT: Record<DocFormatId, string> = {
  jpwabc: ".jpwabc", fanqie: ".jps", "123": ".123", abc: ".abc", musicxml: ".musicxml", jly: ".jly", jcx: ".jcx",
};

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 按格式编码落盘字节（GBK 装不下的字由 `encodeJcx` 另报，这里只取字节）。 */
export function encodeDocText(format: DocFormatId, text: string): Uint8Array {
  if (format === "jpwabc") return encodeJpwabc(text);
  if (format === "jcx") return encodeJcx(text).bytes;
  return utf8(text);
}
