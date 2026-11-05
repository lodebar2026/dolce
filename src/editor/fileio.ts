// .jpwabc encoding helpers. JP-Word writes UTF-16LE; we read BOM-aware and
// write UTF-16LE with a BOM for unambiguous round-tripping.

import { isTauri } from "@tauri-apps/api/core";

// 编解码挪到无依赖的 common/jpwcodec.ts（Node 端也用），这里照旧导出
export { decodeJpwabc, encodeJpwabc } from "../common/jpwcodec";

export function isTauriRuntime(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** 落盘：Tauri 走保存对话框 + writeFile，浏览器走 a[download]。
 *  返回落盘路径（仅 Tauri；用户取消或浏览器下载返回 null）。 */
export async function saveBytes(
  bytes: Uint8Array,
  defaultName: string,
  mime = "application/octet-stream",
): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: defaultName });
    if (!dest) return null;
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(dest, bytes);
    return dest;
  } else {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], { type: mime });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = defaultName;
    a.style.display = "none";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return null;
  }
}

