// **识别项目** `.dolce`：一次识别连同它的来龙去脉存成一个文件，重开后接着核对、接着改，不必重新识别。
//
// 只存识别产物的文本（123 / MusicXML）的话，重开就丢了原图、原图对照、「切输出格式不重跑识别」、谱表 ↔ 声部关联表。
// 这里把下面这些打成一个 zip（`fflate`）：
//
// | 条目 | 内容 |
// |---|---|
// | `manifest.json` | 版本、应用版本、识别路（简谱 / 位图五线谱 / 矢量五线谱）、源格式、输出格式、识别为、对照方式、各源文件名 |
// | `source/<k>.<ext>` | 原图 / 原 PDF 字节，原样（不压缩：本来就是压缩过的） |
// | `doc.txt` / `emitted.txt` | 当前在改的原文；「刚识别出来」的那份（判断手改过没有） |
// | `result/recognized.json` + `result/bin.raw` | 简谱：识别结果（纯数据）与二值图（逐像素 0/1） |
// | `result/meta.json` | 简谱：已随编辑迁移过的点选映射（原图对照点选直接可用） |
//
// 五线谱的对照数据（逐页位图、音符坐标）不入包：第一次进原图对照时从 `source/` 重跑识别补回来——同一份输入、同一份代码，
// 写进 `<note id>` 的编号是确定的，对得上已存的 MusicXML。撤销历史不入包。

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { Binary, JpwMeta, RecognizedScore } from "../omr";
import type { DocFormatId } from "./formats";
import { t } from "../i18n";

export const PROJECT_EXT = "dolce";
/** 包格式版本：读到比这新的拒绝（让用户升级），旧的按能读多少读多少 */
export const PROJECT_VERSION = 1;

export type ProjectKind = "jianpu" | "staff" | "vector";

export interface ProjectSnapshot {
  kind: ProjectKind;
  docFormat: DocFormatId;
  /** 当前在改的原文 */
  text: string;
  /** 刚识别出来的那份原文（手改过没有按它判）；没有为 null */
  emitted: string | null;
  omrFormat?: string;
  recogKind?: string;
  recogView?: string;
  sources: { name: string; mime?: string; bytes: Uint8Array }[];
  /** 简谱识别的产物 */
  jianpu?: { score: RecognizedScore; bin: Binary; meta: JpwMeta | null };
}

/** JSON 里的 `Map`（`JpwMeta.lyricRanges` 是一串 Map）写成 `{ "__map": [[k, v], …] }`。 */
const replacer = (_k: string, v: unknown): unknown => (v instanceof Map ? { __map: [...v.entries()] } : v);
const reviver = (_k: string, v: unknown): unknown =>
  v && typeof v === "object" && "__map" in (v as object) ? new Map((v as { __map: [unknown, unknown][] }).__map) : v;

const extOf = (name: string, mime?: string): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (m) return m[1]!.toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  return "jpg";
};

/** `fast`：自动保存草稿用——二值图不压缩（大图压一遍要在主线程卡几百毫秒，草稿几秒存一次） */
export function packProject(s: ProjectSnapshot, appVersion: string, fast = false): Uint8Array {
  const files: Zippable = {};
  const manifest = {
    version: PROJECT_VERSION,
    app: appVersion,
    kind: s.kind,
    docFormat: s.docFormat,
    omrFormat: s.omrFormat,
    recogKind: s.recogKind,
    recogView: s.recogView,
    sources: s.sources.map((src, k) => ({ file: `source/${k}.${extOf(src.name, src.mime)}`, name: src.name, mime: src.mime })),
    bin: s.jianpu ? { w: s.jianpu.bin.w, h: s.jianpu.bin.h } : undefined,
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 1));
  s.sources.forEach((src, k) => (files[manifest.sources[k]!.file] = [src.bytes, { level: 0 }]));
  files["doc.txt"] = strToU8(s.text);
  if (s.emitted !== null) files["emitted.txt"] = strToU8(s.emitted);
  if (s.jianpu) {
    files["result/recognized.json"] = strToU8(JSON.stringify(s.jianpu.score, replacer));
    files["result/bin.raw"] = fast ? [s.jianpu.bin.data, { level: 0 }] : s.jianpu.bin.data;
    if (s.jianpu.meta) files["result/meta.json"] = strToU8(JSON.stringify(s.jianpu.meta, replacer));
  }
  return zipSync(files, { level: fast ? 1 : 6 });
}

/** 读识别项目。版本比这份代码新、或包坏了抛错（说明给用户看）。缺条目按能还原多少还原多少。 */
export function unpackProject(bytes: Uint8Array): ProjectSnapshot {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(t("proj.notZip"));
  }
  const mf = files["manifest.json"];
  if (!mf) throw new Error(t("proj.noManifest"));
  let manifest: {
    version: number; kind: ProjectKind; docFormat: DocFormatId; omrFormat?: string; recogKind?: string; recogView?: string;
    sources: { file: string; name: string; mime?: string }[]; bin?: { w: number; h: number };
  };
  try {
    manifest = JSON.parse(strFromU8(mf));
  } catch {
    throw new Error(t("proj.badManifest"));
  }
  if (typeof manifest?.version !== "number") throw new Error(t("proj.noVersion"));
  if (manifest.version > PROJECT_VERSION) throw new Error(t("proj.tooNew"));
  if (!(["jianpu", "staff", "vector"] as unknown[]).includes(manifest.kind)) throw new Error(t("proj.badKind", { v: String(manifest.kind) }));
  if (!(["jpwabc", "pu", "123", "abc", "musicxml", "jly"] as unknown[]).includes(manifest.docFormat)) throw new Error(t("proj.badFormat", { v: String(manifest.docFormat) }));
  if (!Array.isArray(manifest.sources)) manifest.sources = [];
  const text = files["doc.txt"] ? strFromU8(files["doc.txt"]) : "";
  const emitted = files["emitted.txt"] ? strFromU8(files["emitted.txt"]) : null;
  const sources = manifest.sources.flatMap((s) => (files[s.file] ? [{ name: s.name, mime: s.mime, bytes: files[s.file]! }] : []));
  let jianpu: ProjectSnapshot["jianpu"];
  const rec = files["result/recognized.json"];
  const raw = files["result/bin.raw"];
  // 二值图尺寸对不上（包坏了）就不还原识别结果，打开后按原图重识别
  if (manifest.kind === "jianpu" && rec && raw && manifest.bin && raw.length === manifest.bin.w * manifest.bin.h) {
    jianpu = {
      score: JSON.parse(strFromU8(rec), reviver) as RecognizedScore,
      bin: { w: manifest.bin.w, h: manifest.bin.h, data: raw },
      meta: files["result/meta.json"] ? (JSON.parse(strFromU8(files["result/meta.json"]), reviver) as JpwMeta) : null,
    };
  }
  return {
    kind: manifest.kind, docFormat: manifest.docFormat, text, emitted, sources,
    ...(manifest.omrFormat ? { omrFormat: manifest.omrFormat } : {}),
    ...(manifest.recogKind ? { recogKind: manifest.recogKind } : {}),
    ...(manifest.recogView ? { recogView: manifest.recogView } : {}),
    ...(jianpu ? { jianpu } : {}),
  };
}
