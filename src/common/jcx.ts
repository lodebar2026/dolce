// Muse `.jcx` 的字节 ↔ 文本门面：编解码在 Rust（crates/model/src/formats/jcxcodec.rs，经单出的 dolce-jcx-wasm），签名同原 TS 实现。
// 读：BOM 优先；`%MUSE3` 或合法 UTF-8 按 UTF-8；否则 GBK，字节分布像 BIG5 的按 BIG5；行尾归一成 `\n`。
// 写：默认 `%MUSE2` + GBK（新旧版 Muse 都能开），打开的是 `%MUSE3` 就照原样 UTF-8；行尾 CRLF。
//
// 码表占体积（gzip 约 150 KB），不进开机那份 dolce-wasm：网页开机后空闲时 `preloadJcx` 预取，
// 开 / 存 .jcx 的入口先 `await ensureJcx()` 兜底；Node 由 `cli/dolcewasm.node.ts` 同步载、`setJcx`。没载就调用抛错。
import type { JcxWasm } from "./dolcewasm";
import { importDolceWasm } from "./dolce";

let inst: JcxWasm | null = null;
let loading: Promise<void> | null = null;
let base = "";

/** 载入好的 wasm 交给门面（Node 载入器调） */
export function setJcx(w: JcxWasm): void {
  inst = w;
}

/** 浏览器：记下站点根，开机后空闲时在后台取（失败不报，等用到时 `ensureJcx` 再试、再报）。 */
export function preloadJcx(siteBase: string): void {
  base = siteBase;
  const go = () => void ensureJcx().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 5000 });
  else setTimeout(go, 1000);
}

/** 已载好（同步调 `decodeJcx` / `encodeJcx` 不会抛） */
export function jcxReady(): boolean {
  return inst !== null;
}

/** 用到 .jcx 编解码前等它载好（已载即刻返回）。 */
export function ensureJcx(): Promise<void> {
  if (inst) return Promise.resolve();
  loading ??= importDolceWasm<JcxWasm>(base, "dolce_jcx_wasm").then(
    (w) => void (inst = w),
    (e) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

function jcx(): JcxWasm {
  if (!inst) throw new Error("dolce-jcx-wasm 还没载入（先 await ensureJcx()）");
  return inst;
}

/** 字节 → 文本（行尾归一成 `\n`）。 */
export function decodeJcx(bytes: Uint8Array): string {
  return jcx().decodeJcx(bytes);
}

/** 文本 → 字节。`missing`：GBK 里没有、写成了 `?` 的字（调用方报给用户）。 */
export function encodeJcx(text: string): { bytes: Uint8Array; missing: string[] } {
  const r = jcx().encodeJcx(text);
  try {
    return { bytes: r.bytes, missing: [...r.missing] };
  } finally {
    r.free();
  }
}
