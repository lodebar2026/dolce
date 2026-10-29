// 可视化编辑的**动作表**：快捷键、名字、说明只写这一份。
//
// 键盘分派（`controller.ts`）、帮助页的快捷键表（`help.ts`）、右键菜单与记号面板都从这里取，
// 加一个动作只改这张表加一个处理函数，几处不会脱节。
//
// **`/` 不绑定**：留给歌词对位（歌词录入模式要用它，见 `../dev/docs/待办/重构与编辑器.md`（私有仓库）「可视化编辑的后续」）。

import { isTauriRuntime } from "../fileio";
import { t, type MsgKey } from "../../i18n";

/** 编辑模式 = 方块光标罩住元素；插入模式 = 竖线光标落在两个元素之间。
 *  **不单独存**：由代码区选区推出（非空 = 编辑，空 = 插入），两侧因此不会不同步。 */
export type VisualMode = "edit" | "insert";

export interface KeyBinding {
  /** `KeyboardEvent.key`（字符键按产生的字符认，`#` 就是 `#`） */
  key: string;
  /** 按物理键认（`Digit3`）：带 Alt 的组合一律这么认——Mac 上 Option+3 产生的字符是 `£`、欧洲键盘 Ctrl+Alt 是 AltGr */
  code?: string;
  shift?: boolean;
  /** Ctrl（Windows/Linux）或 ⌘（macOS） */
  mod?: boolean;
  /** Alt / Option。缺省不看 Alt（老绑定照旧） */
  alt?: boolean;
}

export type ActionGroup = "mode" | "nav" | "note" | "dur" | "mark" | "brk" | "edit" | "meas" | "voice";

/** 分组显示名（界面语言）。 */
export const groupLabel = (g: ActionGroup): string => t(`va.group.${g}`);

export interface VisualAction {
  id: string;
  label: string;
  group: ActionGroup;
  keys: KeyBinding[];
  /** 帮助与菜单里怎么写这组键 */
  keyText: string;
  /** 哪种模式下可用；缺省两种都行 */
  modes?: VisualMode[];
  /** 一句话说明（帮助页用） */
  help: string;
  /** 网页版另用的键（浏览器自己占着桌面版那组：Ctrl+G 查找下一个、Ctrl+L 地址栏、Ctrl/⌘+1–8 切标签……）；缺省两边一样 */
  web?: { keys: KeyBinding[]; keyText: string };
}

/** 网页版（不在 Tauri 外壳里）：取 `web` 那组键 */
const isWeb = (): boolean => !isTauriRuntime();

/** 这个动作在当前运行环境下的键 */
export function keysOf(a: VisualAction): KeyBinding[] {
  return isWeb() && a.web ? a.web.keys : a.keys;
}

/** 这个动作在当前运行环境下怎么写（菜单、面板提示用；帮助表两组都列） */
export function keyTextOf(a: VisualAction): string {
  return isWeb() && a.web ? a.web.keyText : a.keyText;
}

/** 名字与说明按界面语言取（键 `va.<id>.label` / `va.<id>.help`，见 i18n/zh.ts）。 */
function act(a: Omit<VisualAction, "label" | "help">): VisualAction {
  return {
    ...a,
    get label() { return t(`va.${a.id}.label` as MsgKey); },
    get help() { return t(`va.${a.id}.help` as MsgKey); },
  };
}

const RAW_ACTIONS: readonly Omit<VisualAction, "label" | "help">[] = [
  { id: "mode.insert", group: "mode", keys: [{ key: "Insert" }, { key: "i" }], keyText: "Insert / i",
    modes: ["edit"] },
  { id: "mode.edit", group: "mode", keys: [{ key: "Escape" }], keyText: "Esc",
    modes: ["insert"] },
  { id: "nav.prev", group: "nav", keys: [{ key: "ArrowLeft" }], keyText: "←" },
  { id: "nav.next", group: "nav", keys: [{ key: "ArrowRight" }], keyText: "→" },
  { id: "nav.extendPrev", group: "nav", keys: [{ key: "ArrowLeft", shift: true }], keyText: "Shift+←" },
  { id: "nav.extendNext", group: "nav", keys: [{ key: "ArrowRight", shift: true }], keyText: "Shift+→" },
  { id: "nav.measPrev", group: "nav", keys: [{ key: "ArrowLeft", mod: true }], keyText: "Ctrl/⌘+←" },
  { id: "nav.measNext", group: "nav", keys: [{ key: "ArrowRight", mod: true }], keyText: "Ctrl/⌘+→" },
  { id: "nav.extendMeasNext", group: "nav", keys: [{ key: "ArrowRight", mod: true, shift: true }], keyText: "Ctrl/⌘+Shift+→" },
  { id: "nav.extendMeasPrev", group: "nav", keys: [{ key: "ArrowLeft", mod: true, shift: true }], keyText: "Ctrl/⌘+Shift+←" },
  { id: "nav.gotoMeasure", group: "nav", keys: [{ key: "g", mod: true }], keyText: "Ctrl/⌘+G",
    web: { keys: [{ key: "g", code: "KeyG", alt: true }], keyText: "Alt+G" } },
  { id: "sel.all", group: "nav", keys: [{ key: "a", mod: true }], keyText: "Ctrl/⌘+A" },
  { id: "nav.home", group: "nav", keys: [{ key: "Home" }], keyText: "Home" },
  { id: "nav.end", group: "nav", keys: [{ key: "End" }], keyText: "End" },
  { id: "note.digit", group: "note",
    keys: ["0", "1", "2", "3", "4", "5", "6", "7"].map((key) => ({ key })), keyText: "1–7 · 0" },
  { id: "note.letter", group: "note",
    keys: ["a", "b", "c", "d", "e", "f", "g"].map((key) => ({ key })), keyText: "A–G" },
  { id: "step.up", group: "note", keys: [{ key: "ArrowUp", alt: false }], keyText: "↑" },
  { id: "step.down", group: "note", keys: [{ key: "ArrowDown", alt: false }], keyText: "↓" },
  { id: "semi.up", group: "note", keys: [{ key: "ArrowUp", alt: true }], keyText: "Alt+↑" },
  { id: "semi.down", group: "note", keys: [{ key: "ArrowDown", alt: true }], keyText: "Alt+↓" },
  { id: "oct.up", group: "note", keys: [{ key: "'" }, { key: "ArrowUp", mod: true }], keyText: "' / Ctrl/⌘+↑" },
  { id: "oct.down", group: "note", keys: [{ key: "," }, { key: "ArrowDown", mod: true }], keyText: ", / Ctrl/⌘+↓" },
  { id: "acc.sharp", group: "note", keys: [{ key: "#" }], keyText: "#",
    modes: ["edit"] },
  { id: "acc.flat", group: "note", keys: [{ key: "b", shift: true }], keyText: "Shift+B",
    modes: ["edit"] },
  { id: "acc.natural", group: "note", keys: [{ key: "n" }], keyText: "n",
    modes: ["edit"] },
  { id: "dur.halve", group: "dur", keys: [{ key: "_" }], keyText: "_" },
  { id: "dur.double", group: "dur", keys: [{ key: "=" }], keyText: "=" },
  { id: "dur.dot", group: "dur", keys: [{ key: "." }], keyText: ".",
    modes: ["edit"] },
  { id: "sus.add", group: "dur", keys: [{ key: "-" }], keyText: "-" },
  { id: "bar.insert", group: "edit", keys: [{ key: "|" }], keyText: "|" },
  { id: "brk.line", group: "brk", keys: [{ key: "Enter" }], keyText: "Enter" },
  { id: "brk.page", group: "brk", keys: [{ key: "Enter", shift: true }], keyText: "Shift+Enter" },
  { id: "del.forward", group: "edit", keys: [{ key: "Delete" }], keyText: "Delete" },
  { id: "del.back", group: "edit", keys: [{ key: "Backspace" }], keyText: "Backspace" },
  { id: "slur.toggle", group: "mark", keys: [{ key: "s" }, { key: "(" }], keyText: "s / (",
    modes: ["edit"] },
  { id: "tie.toggle", group: "mark", keys: [{ key: "t" }], keyText: "t",
    modes: ["edit"] },
  { id: "tuplet.toggle", group: "dur", keys: [{ key: "3", code: "Digit3", mod: true }], keyText: "Ctrl/⌘+3",
    web: { keys: [{ key: "3", code: "Digit3", alt: true, shift: true }], keyText: "Alt+Shift+3" },
    modes: ["edit"] },
  { id: "deco.fermata", group: "mark", keys: [{ key: "f", shift: true }], keyText: "Shift+F",
    modes: ["edit"] },
  { id: "deco.accent", group: "mark", keys: [{ key: ">" }], keyText: ">",
    modes: ["edit"] },
  { id: "mark.next", group: "mark", keys: [{ key: "Tab" }], keyText: "Tab",
    modes: ["edit"] },
  { id: "mark.prev", group: "mark", keys: [{ key: "Tab", shift: true }], keyText: "Shift+Tab",
    modes: ["edit"] },
  // 挪动（识谱软件「拖到最近的音上」的键盘版）：选中的记号 / 歌词字整个挪一个音，连线另可只挪终点
  { id: "move.prev", group: "mark", keys: [{ key: "ArrowLeft", alt: true }], keyText: "Alt+←", modes: ["edit"] },
  { id: "move.next", group: "mark", keys: [{ key: "ArrowRight", alt: true }], keyText: "Alt+→", modes: ["edit"] },
  { id: "move.measPrev", group: "mark", keys: [{ key: "ArrowLeft", alt: true, mod: true }], keyText: "Ctrl/⌘+Alt+←",
    web: { keys: [{ key: "PageUp", alt: true }], keyText: "Alt+PageUp" }, modes: ["edit"] },
  { id: "move.measNext", group: "mark", keys: [{ key: "ArrowRight", alt: true, mod: true }], keyText: "Ctrl/⌘+Alt+→",
    web: { keys: [{ key: "PageDown", alt: true }], keyText: "Alt+PageDown" }, modes: ["edit"] },
  { id: "span.endPrev", group: "mark", keys: [{ key: "ArrowLeft", alt: true, shift: true }], keyText: "Shift+Alt+←", modes: ["edit"] },
  { id: "span.endNext", group: "mark", keys: [{ key: "ArrowRight", alt: true, shift: true }], keyText: "Shift+Alt+→", modes: ["edit"] },
  { id: "sel.beamGroup", group: "nav", keys: [{ key: "g", shift: true }], keyText: "Shift+G", modes: ["edit"] },
  { id: "issue.next", group: "nav", keys: [{ key: "F8" }], keyText: "F8" },
  { id: "issue.prev", group: "nav", keys: [{ key: "F8", shift: true }], keyText: "Shift+F8" },
  { id: "deco.staccato", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.tenuto", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.marcato", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.staccatissimo", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.fermataInv", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.trill", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.mordent", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "deco.turn", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "wedge.cresc", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "wedge.dim", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "ottava.up", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "ottava.down", group: "mark", keys: [], keyText: "", modes: ["edit"] },
  { id: "grace.toggle", group: "note", keys: [], keyText: "", modes: ["edit"] },
  { id: "chord.add", group: "note",
    keys: ["1", "2", "3", "4", "5", "6", "7"].map((d) => ({ key: d, code: `Digit${d}`, alt: true })), keyText: "Alt+1–7",
    modes: ["edit"] },
  { id: "voice.set", group: "voice",
    keys: ["1", "2", "3", "4"].map((d) => ({ key: d, code: `Digit${d}`, alt: true, mod: true })), keyText: "Ctrl+Alt+1–4" },
  { id: "meas.append", group: "meas", keys: [{ key: "b", mod: true }], keyText: "Ctrl/⌘+B" },
  { id: "meas.insert", group: "meas", keys: [{ key: "b", mod: true, shift: true }], keyText: "Ctrl/⌘+Shift+B" },
  { id: "meas.delete", group: "meas", keys: [{ key: "Delete", mod: true }, { key: "Backspace", mod: true }], keyText: "Ctrl/⌘+Delete" },
  { id: "meas.key", group: "meas", keys: [], keyText: "" },
  { id: "meas.keyReread", group: "meas", keys: [], keyText: "" },
  { id: "meas.clef", group: "meas", keys: [], keyText: "" },
  { id: "meas.clefReread", group: "meas", keys: [], keyText: "" },
  { id: "meas.time", group: "meas", keys: [], keyText: "" },
  { id: "meas.tempo", group: "meas", keys: [], keyText: "" },
  { id: "bar.single", group: "meas", keys: [], keyText: "" },
  { id: "bar.double", group: "meas", keys: [], keyText: "" },
  { id: "bar.final", group: "meas", keys: [], keyText: "" },
  { id: "bar.repeatStart", group: "meas", keys: [], keyText: "" },
  { id: "bar.repeatEnd", group: "meas", keys: [], keyText: "" },
  { id: "volta.1", group: "meas", keys: [], keyText: "" },
  { id: "volta.2", group: "meas", keys: [], keyText: "" },
  { id: "jump.segno", group: "meas", keys: [], keyText: "" },
  { id: "jump.coda", group: "meas", keys: [], keyText: "" },
  { id: "jump.dc", group: "meas", keys: [], keyText: "" },
  { id: "jump.ds", group: "meas", keys: [], keyText: "" },
  { id: "jump.fine", group: "meas", keys: [], keyText: "" },
  { id: "view.formatMarks", group: "edit", keys: [{ key: "m", mod: true, shift: true }], keyText: "Ctrl/⌘+Shift+M" },
  { id: "edit.copy", group: "edit", keys: [{ key: "c", mod: true }], keyText: "Ctrl/⌘+C" },
  { id: "edit.cut", group: "edit", keys: [{ key: "x", mod: true }], keyText: "Ctrl/⌘+X" },
  { id: "edit.paste", group: "edit", keys: [{ key: "v", mod: true }], keyText: "Ctrl/⌘+V" },
  { id: "edit.repeat", group: "edit", keys: [{ key: "r" }], keyText: "R",
    modes: ["edit"] },
  { id: "lyric.entry", group: "edit", keys: [{ key: "l", mod: true }], keyText: "Ctrl/⌘+L",
    web: { keys: [{ key: "l", code: "KeyL", alt: true }], keyText: "Alt+L" } },
  { id: "chord.entry", group: "edit", keys: [{ key: "k", mod: true }], keyText: "Ctrl/⌘+K",
    web: { keys: [{ key: "k", code: "KeyK", alt: true }], keyText: "Alt+K" } },
  { id: "text.entry", group: "edit", keys: [{ key: "t", mod: true }], keyText: "Ctrl/⌘+T",
    web: { keys: [{ key: "t", code: "KeyT", alt: true }], keyText: "Alt+T" } },
  { id: "dyn.entry", group: "edit", keys: [{ key: "e", mod: true }], keyText: "Ctrl/⌘+E",
    web: { keys: [{ key: "e", code: "KeyE", alt: true }], keyText: "Alt+E" } },
  { id: "edit.transpose", group: "edit", keys: [], keyText: "" },
  { id: "edit.transcribe", group: "edit", keys: [], keyText: "" },
  { id: "edit.undo", group: "edit", keys: [{ key: "z", mod: true }], keyText: "Ctrl/⌘+Z" },
  { id: "edit.redo", group: "edit", keys: [{ key: "z", mod: true, shift: true }, { key: "y", mod: true }], keyText: "Ctrl/⌘+Shift+Z" },
];

export const VISUAL_ACTIONS: readonly VisualAction[] = RAW_ACTIONS.map(act);

/** 按下的键对应哪个动作、以及它代表的字符（按物理键认的绑定给 `KeyBinding.key`，不是 Option 打出来的 `£`）。 */
export function keyHit(ev: KeyboardEvent): { action: VisualAction; key: string } | null {
  const mod = ev.ctrlKey || ev.metaKey;
  // 字母键带 Shift 时 `key` 是大写，统一按小写比
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  // 先认按物理键的（Alt 组合）：Windows 上 Alt+1 的 `key` 仍是「1」，先走字符那一轮就被当成改唱名
  for (const a of VISUAL_ACTIONS) {
    for (const k of keysOf(a)) {
      if (!k.code || ev.code !== k.code || !!k.mod !== mod || !!k.alt !== ev.altKey || !!k.shift !== ev.shiftKey) continue;
      return { action: a, key: k.key };
    }
  }
  for (const a of VISUAL_ACTIONS) {
    for (const k of keysOf(a)) {
      if (k.code) continue;
      if (k.alt !== undefined && k.alt !== ev.altKey) continue;
      // 没写 alt 的字母键、方向键等不认 Alt 组合（Alt+C 不是改音名 C）；符号键放过——有的键盘布局要 AltGr / Option 才打得出
      if (k.alt === undefined && ev.altKey && (k.key.length > 1 || /[a-z]/i.test(k.key))) continue;
      if (k.key.toLowerCase() !== key.toLowerCase()) continue;
      if (!!k.mod !== mod) continue;
      // 符号键（`#`、`(`、`|`）本身就要按 Shift 才打得出，不看 Shift
      const shiftMatters = k.key.length > 1 || /[a-z]/i.test(k.key);
      if (shiftMatters && !!k.shift !== ev.shiftKey) continue;
      return { action: a, key: ev.key };
    }
  }
  return null;
}
