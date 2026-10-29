// 可视化编辑的**右键菜单**与**记号面板**：给不熟悉快捷键的人用。
//
// 两者都从动作表（`keys.ts::VISUAL_ACTIONS`）生成——动作名、快捷键提示、在哪种模式下可用都取自那一份，
// 点了调的是控制器同一个 `run`，不另写一套逻辑。

import { groupLabel, keyTextOf, VISUAL_ACTIONS, type VisualAction, type VisualMode } from "./keys";
import { t } from "../../i18n";

/** 面板与菜单里不列的：移动、轮换这类纯键盘操作，和面板自己的开关 */
const KEYBOARD_ONLY = new Set(["nav.prev", "nav.next", "nav.extendPrev", "nav.extendNext", "nav.home", "nav.end", "mark.next", "mark.prev",
  "nav.measPrev", "nav.measNext", "nav.extendMeasPrev", "nav.extendMeasNext"]);

/** 唱名那个动作展开成一排：1–7、0；音名 C–B；加和弦音 1–7；声部 1–4 */
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "0"];
const ROWS: Record<string, { keys: string[]; label: (d: string) => string; title: (d: string) => string }> = {
  "note.digit": { keys: DIGITS, label: (d) => d, title: (d) => (d === "0" ? t("vis.rest") : t("vis.degree", { d })) },
  "note.letter": { keys: ["c", "d", "e", "f", "g", "a", "b"], label: (d) => d.toUpperCase(), title: (d) => t("vis.letter", { d: d.toUpperCase() }) },
  "chord.add": { keys: DIGITS.slice(0, 7), label: (d) => `+${d}`, title: (d) => t("vis.chordAdd", { d }) },
  "voice.set": { keys: ["1", "2", "3", "4"], label: (d) => t("vis.voiceShort", { d }), title: (d) => t("vis.voiceTitle", { d }) },
};
/** 右键菜单里收进「小节」子菜单的那组 */
const SUBMENU_GROUP = "meas";

export interface MenuRunner {
  readonly mode: VisualMode;
  /** 现在在哪种谱面上：五线谱 / 混排档的时值按钮画音符（`STAFF_SHORT`） */
  readonly surface?: "jianpu" | "staff" | "recognize";
  /** 当前格式能不能做这个动作（和弦音、声部只对 MusicXML；小节操作要格式有写法表）。缺省都能 */
  available?(a: VisualAction): boolean;
  run(a: VisualAction, key?: string): boolean;
  /** 跑完把焦点还给谱面（键盘接着能用） */
  refocus(): void;
}

/** 右键点中的是什么：决定菜单里摆哪些动作 */
export type MenuTarget = "note" | "mark" | "break" | "caret" | "other";

const listed = (): VisualAction[] => VISUAL_ACTIONS.filter((a) => !KEYBOARD_ONLY.has(a.id));
const usable = (a: VisualAction, mode: VisualMode): boolean => !a.modes || a.modes.includes(mode);

function button(label: string, title: string, onPick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.title = title;
  // 按下时不抢谱面的焦点
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onPick);
  return b;
}

// ───────────────────────── 记号面板 ─────────────────────────

/** 面板上每个按钮显示什么：尽量用谱面上看得到的那个符号（缺省用动作名）。完整名称与快捷键在按钮的提示里。
 *  八度点、减时线、附点用组合字符叠在「1」上，与谱面上的样子一致。 */
const SHORT: Record<string, string> = {
  "mode.insert": "\u258F", // ▏ 竖线光标
  "mode.edit": "\u25AE", // ▮ 方块光标
  "step.up": "\u2191", "step.down": "\u2193", // ↑ ↓ 音级
  "semi.up": "+\u00BD", "semi.down": "\u2212\u00BD", // ±½ 半音
  "oct.up": "1\u0307", // 1̇
  "oct.down": "1\u0323", // 1̣
  "acc.sharp": "\u266F", "acc.flat": "\u266D", "acc.natural": "\u266E",
  "dur.halve": "1\u0332", // 1̲ 加减时线
  "dur.double": "\u00D72", // ×2
  "dur.dot": "1\u00B7", // 1·
  "sus.add": "1 \u2013", // 1 –
  "slur.toggle": "\u2322", // ⌢
  "tie.toggle": "\u2040", // ⁀
  "tuplet.toggle": "\u23B43\u23B5", // ⎴3⎵
  "deco.fermata": "\u{1D110}", // 𝄐
  "deco.accent": ">",
  "bar.insert": "|",
  "brk.line": "\u21B5", // ↵
  "brk.page": "\u2913", // ⤓
  "del.forward": "\u2326", // ⌦
  "del.back": "\u232B", // ⌫
  "meas.append": "+\u2502", "meas.insert": "\u2502+", "meas.delete": "\u2212\u2502",
  "meas.key": "1=", "meas.time": "\u00BE", "meas.tempo": "\u2669=",
  "bar.single": "\u2502", "bar.double": "\u2016", "bar.final": "\u2502\u258C", "bar.repeatStart": "\u2016:", "bar.repeatEnd": ":\u2016",
  "volta.1": "\u23B41.", "volta.2": "\u23B42.",
  "jump.segno": "\u{1D10B}", "jump.coda": "\u{1D10C}", "jump.dc": "D.C.", "jump.ds": "D.S.", "jump.fine": "Fine",
  "move.prev": "\u21E0", "move.next": "\u21E2", // ⇠ ⇢
  "move.measPrev": "\u21C7", "move.measNext": "\u21C9", // ⇇ ⇉
  "span.endPrev": "\u2322\u2190", "span.endNext": "\u2322\u2192", // ⌢← ⌢→
  "sel.beamGroup": "\u266B", // ♫
  "issue.prev": "\u2190!", "issue.next": "!\u2192",
  "deco.staccato": "\u2022", "deco.tenuto": "\u2012", "deco.marcato": "^", "deco.staccatissimo": "\u25BE",
  "deco.fermataInv": "\u{1D111}", "deco.trill": "tr", "deco.mordent": "\u223F", "deco.turn": "\u223D",
  "wedge.cresc": "\u{1D192}", "wedge.dim": "\u{1D193}", // 𝆒 𝆓
  "ottava.up": "8va", "ottava.down": "8vb",
  "grace.toggle": "\u266A\u0338", // ♪̸
  "meas.keyReread": "1=\u21BB", "meas.clef": "\u{1D11E}", "meas.clefReread": "\u{1D11E}\u21BB",
  "view.formatMarks": "\u00B6", // ¶
  "nav.gotoMeasure": "\u2192\u2116", // →№
  "edit.transpose": "\u21C5", // ⇅
  "edit.transcribe": "1=?",
  "edit.undo": "\u21B6", // ↶
  "edit.redo": "\u21B7", // ↷
};

/** 五线谱 / 混排档换成音符的那几个（简谱那套「1̲」「1·」在五线谱上对不上号）。 */
const STAFF_SHORT: Record<string, string> = {
  "dur.halve": "\u266A", // ♪ 减半
  "dur.double": "\u{1D15E}", // 𝅗𝅥 加倍
  "dur.dot": "\u2669.", // ♩.
  "sus.add": "\u2669+", // ♩+ 多一拍
  "oct.up": "8\u2191", "oct.down": "8\u2193",
};

/** 把面板建进 `root`；返回刷新函数（模式一变，按钮可用与否跟着变）。 */
export function buildPalette(root: HTMLElement, r: MenuRunner): () => void {
  root.replaceChildren();
  const entries: { a: VisualAction; el: HTMLButtonElement }[] = [];
  const groups = new Map<string, HTMLElement>();
  for (const a of listed()) {
    let g = groups.get(a.group);
    if (!g) {
      g = document.createElement("div");
      g.className = "visual-palette-group";
      g.dataset.group = a.group;
      groups.set(a.group, g);
      root.appendChild(g);
    }
    const row = ROWS[a.id];
    if (row) {
      for (const d of row.keys) {
        const el = button(row.label(d), `${row.title(d)}（${keyTextOf(a)}）：${a.help}`, () => {
          r.run(a, d);
          r.refocus();
        }, "visual-palette-digit");
        g.appendChild(el);
        entries.push({ a, el });
      }
      continue;
    }
    const el = button(SHORT[a.id] ?? a.label, `${a.label}（${keyTextOf(a)}）：${a.help}`, () => {
      r.run(a);
      r.refocus();
    });
    g.appendChild(el);
    entries.push({ a, el });
  }
  return () => {
    const staff = r.surface === "staff";
    for (const { a, el } of entries) {
      el.disabled = !usable(a, r.mode) || r.available?.(a) === false;
      const alt = STAFF_SHORT[a.id];
      if (alt && !ROWS[a.id]) el.textContent = staff ? alt : SHORT[a.id] ?? a.label;
    }
  };
}

// ───────────────────────── 右键菜单 ─────────────────────────

/** 各种目标上摆哪些动作（按动作 id 前缀 / 全名挑） */
function actionsFor(target: MenuTarget, mode: VisualMode): VisualAction[] {
  const all = listed().filter((a) => usable(a, mode));
  switch (target) {
    case "mark":
      // 记号、歌词字：删、挪（识谱软件「拖到别的音上」的键盘版）
      return all.filter((a) => a.id === "del.forward" || a.id.startsWith("edit.") || a.id.startsWith("move.") || a.id.startsWith("span."));
    case "break":
      return all.filter((a) => a.id === "del.forward" || a.id.startsWith("edit."));
    case "caret":
      return all.filter((a) => ["note.digit", "note.letter", "voice.set", "sus.add", "bar.insert", "brk.line", "brk.page", "del.forward", "del.back", "mode.edit", "dur.halve", "dur.double", "edit.paste"].includes(a.id) || a.group === SUBMENU_GROUP);
    case "note":
      return all.filter((a) => !["mode.edit", "del.back", "view.formatMarks", "voice.set", "issue.next", "issue.prev"].includes(a.id) &&
        !a.id.startsWith("move.") && !a.id.startsWith("span."));
    default:
      return all.filter((a) => a.id.startsWith("edit.") || a.id === "view.formatMarks" || a.group === SUBMENU_GROUP);
  }
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/** 在屏幕坐标 `(x, y)` 弹出菜单。 */
export function showMenu(x: number, y: number, target: MenuTarget, r: MenuRunner): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "visual-menu";
  menu.setAttribute("role", "menu");
  const pick = (a: VisualAction, key?: string) => () => {
    closeMenu();
    r.run(a, key);
    r.refocus();
  };
  const item = (a: VisualAction): HTMLButtonElement => {
    const it = button("", a.help, pick(a), "visual-menu-item");
    const label = document.createElement("span");
    label.textContent = a.label;
    const key = document.createElement("kbd");
    key.textContent = keyTextOf(a);
    it.append(label, key);
    it.setAttribute("role", "menuitem");
    return it;
  };
  const actions = actionsFor(target, r.mode).filter((a) => r.available?.(a) !== false);
  for (const a of actions) {
    if (a.group === SUBMENU_GROUP) continue;
    const row = ROWS[a.id];
    if (row) {
      const el = document.createElement("div");
      el.className = "visual-menu-digits";
      el.title = a.label;
      for (const d of row.keys) el.appendChild(button(row.label(d), row.title(d), pick(a, d)));
      menu.appendChild(el);
      continue;
    }
    menu.appendChild(item(a));
  }
  // 小节操作收成一个可展开的子菜单（一共十几项，平铺会把菜单撑得比屏幕还高）
  const sub = actions.filter((a) => a.group === SUBMENU_GROUP);
  if (sub.length) {
    const head = button("", t("vis.measSubmenu"), () => {
      box.hidden = !box.hidden;
      head.classList.toggle("open", !box.hidden);
      place(); // 展开后变高了，重新贴回视口里
      if (!box.hidden) box.scrollIntoView({ block: "nearest" });
    }, "visual-menu-item visual-menu-sub");
    const label = document.createElement("span");
    label.textContent = groupLabel(SUBMENU_GROUP);
    const arrow = document.createElement("kbd");
    arrow.textContent = "▸";
    head.append(label, arrow);
    const box = document.createElement("div");
    box.className = "visual-menu-subbox";
    box.hidden = true;
    for (const a of sub) box.appendChild(item(a));
    menu.append(head, box);
  }
  document.body.appendChild(menu);
  // 贴着指针弹出，出不了视口（比视口还高时由 CSS 的 max-height 滚动）
  function place(): void {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }
  place();
  openMenu = menu;
  const away = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    if (e.target instanceof Node && menu.contains(e.target)) return;
    closeMenu();
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("keydown", away, true);
  };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", away, true);
}
