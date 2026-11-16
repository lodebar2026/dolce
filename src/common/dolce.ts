// dolce-wasm 的实例（模型 / 格式 / 排版迁 Rust 期间的同步门面）：载入一次，之后各处同步调。
// 网页与桌面（WebView）在 `main.ts` 开机时 `await loadDolce()`；Node（out/cli 各入口、vitest）由 `cli/dolcewasm.node.ts` 读文件 `initSync`。
// 没载就调用抛错（不静默退回 TS：已迁的判据 TS 那份删了）。
import type { DolceWasm } from "./dolcewasm";

let inst: DolceWasm | null = null;

/** 载入好的 wasm 交给门面（两种宿主的载入器调） */
export function setDolce(w: DolceWasm): void {
  inst = w;
}

/** 门面用：取已载入的 wasm */
export function dolce(): DolceWasm {
  if (!inst) throw new Error("dolce-wasm 还没载入（网页 main.ts::loadDolce / Node cli/dolcewasm.node.ts）");
  return inst;
}

/** 浏览器载入 public/redist/dolce/ 下的一份 wasm：胶水按文本取来、从 Blob 地址 import
 *  （开发服务器不让把 public/ 下的脚本当模块加载，同 `omrrust/worker.ts`），再按地址实例化。 */
export async function importDolceWasm<T extends { default(init: { module_or_path: string }): Promise<object> }>(base: string, name: string): Promise<T> {
  const dir = new URL(`${base}redist/dolce/`, location.href).href;
  const r = await fetch(`${dir}${name}.js`);
  if (!r.ok) throw new Error(`取 ${name} 失败（${r.status}）`);
  const blob = URL.createObjectURL(new Blob([await r.text()], { type: "text/javascript" }));
  let w: T;
  try {
    w = (await import(/* @vite-ignore */ blob)) as T;
  } finally {
    URL.revokeObjectURL(blob);
  }
  await w.default({ module_or_path: `${dir}${name}_bg.wasm` });
  return w;
}

/** 开机载入（`main.ts`） */
export async function loadDolce(base: string): Promise<void> {
  if (!inst) inst = await importDolceWasm<DolceWasm>(base, "dolce_wasm");
}
