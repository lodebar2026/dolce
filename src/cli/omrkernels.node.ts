// Node 侧的像素内核原生模块（`native/omrkernels`，`npm run build:native` 编）：找得到就装进 `omrkit/kernels.ts`，
// 找不到（没编、平台不对）就照旧走 TS 实现，结果一样只是慢。`DOLCE_OMRKERNELS=off` 强制走 TS（对照、比对用），
// 也可以指向别处编好的 `.node`。每个线程各装一次（主线程的 CLI 入口与 `rasterworker.ts`）。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setPixelKernels, type PixelKernels } from "../omrkit/kernels";

let loaded: string | null | undefined;

/** 装上原生像素内核；返回加载的模块路径，没装上为 null。重复调用只装一次。 */
export function installNodeKernels(): string | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  const env = process.env.DOLCE_OMRKERNELS;
  if (env === "off") return loaded;
  const cands = [env, fileURLToPath(new URL("../../native/omrkernels/omrkernels.node", import.meta.url))].filter((p): p is string => !!p);
  const req = createRequire(import.meta.url);
  for (const p of cands) {
    if (!existsSync(p)) continue;
    try {
      const mod = req(p) as PixelKernels;
      // `DOLCE_OMRKERNELS_ONLY=a,b`：只启用列出的内核（逐批测速、排查用），其余走 TS
      const only = process.env.DOLCE_OMRKERNELS_ONLY?.split(",").filter(Boolean);
      setPixelKernels(only ? (Object.fromEntries(only.filter((k) => k in mod).map((k) => [k, (mod as Record<string, unknown>)[k]])) as PixelKernels) : mod);
      loaded = p;
      break;
    } catch {
      /* 平台不对或缺依赖：试下一个 */
    }
  }
  return loaded;
}

/** 当前装没装原生内核（装了返回模块路径）。 */
export function nodeKernelsInfo(): string | null {
  return loaded ?? null;
}
