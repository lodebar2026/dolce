// 界面语言：中文 / English。词典在 zh.ts / en.ts（en 漏键 tsc 报错）。
// 静态 DOM 用 data-i18n* 属性，动态文字调 t()；乐谱内容与记谱关键字不走这里。
import { zh, type MsgKey } from "./zh";
import { en } from "./en";
import { setMsgTranslator, type ModelMsg } from "../model/msg";

export type Lang = "zh" | "en";
/** 用户设置：跟随系统 / 指定语言。 */
export type LangPref = "auto" | Lang;
export type { MsgKey };

const STORE_KEY = "dolce-ui-lang";
const DICTS: Record<Lang, Record<MsgKey, string>> = { zh, en };

let current: Lang = "zh";
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang { return current; }

/** 取文案；`{name}` 占位按 params 替换。 */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? zh[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** 模型层的提示（`model/msg.ts`：键 + 参数，参数里可以再套一条提示）按当前语言出字。 */
function modelMsgText(m: ModelMsg): string {
  if (!m.args) return t(m.key);
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.args)) params[k] = typeof v === "object" ? modelMsgText(v) : v;
  return t(m.key, params);
}
setMsgTranslator(modelMsgText);

/** 键存在才译（用于 code→文案 的查表，如诊断）。 */
export function tOpt(key: string, params?: Record<string, string | number>): string | undefined {
  return key in zh ? t(key as MsgKey, params) : undefined;
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readPref(): LangPref {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch { /* 隐私模式等 */ }
  return "auto";
}

export function getLangPref(): LangPref { return readPref(); }

/** 「跟随系统」的落点：`/en/` 页（html data-ui-lang）优先，其次浏览器语言。 */
function autoLang(): Lang {
  const page = document.documentElement.dataset.uiLang;
  if (page === "zh" || page === "en") return page;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => /^zh\b/i.test(l ?? "")) ? "zh" : "en";
}

/** 启动时定语言：URL ?lang= → 已存设置 → 页面/浏览器。 */
export function initLang(): Lang {
  const q = new URLSearchParams(location.search).get("lang");
  const pref = readPref();
  current = q === "zh" || q === "en" ? q : pref !== "auto" ? pref : autoLang();
  document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  applyI18n(document);
  void syncWindowTitle();
  return current;
}

/** 改设置并立即生效（不重载）。 */
export function setLangPref(pref: LangPref): void {
  try {
    if (pref === "auto") localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, pref);
  } catch { /* ignore */ }
  const next = pref === "auto" ? autoLang() : pref;
  if (next === current) return;
  current = next;
  document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  applyI18n(document);
  void syncWindowTitle();
  for (const fn of listeners) fn(current);
}

/** 刷新带 data-i18n* 属性的静态元素。 */
export function applyI18n(root: ParentNode): void {
  const each = (attr: string, fn: (el: HTMLElement, key: MsgKey) => void) => {
    root.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr) as MsgKey;
      if (key in zh) fn(el, key);
    });
  };
  each("data-i18n", (el, k) => { el.textContent = t(k); });
  each("data-i18n-title", (el, k) => { el.title = t(k); });
  each("data-i18n-aria", (el, k) => { el.setAttribute("aria-label", t(k)); });
  each("data-i18n-placeholder", (el, k) => { el.setAttribute("placeholder", t(k)); });
  each("data-i18n-label", (el, k) => { el.setAttribute("label", t(k)); });
}

async function syncWindowTitle(): Promise<void> {
  const title = t("app.windowTitle");
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch { /* 无权限或非桌面 */ }
}
