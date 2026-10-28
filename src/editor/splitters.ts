/** 三栏分隔条：源码｜排版（`#split-code`）、并排原图｜排版（`#split-side`，显隐由 omrctl.ts::syncSide 管）。
 *  拖动改 `#body` 上的 `--code-w`、`#score-pane-shell` 上的 `--side-w`（百分比，窗口缩放跟着走），
 *  记在 localStorage；双击复位到样式表缺省。 */

const WIDTHS_KEY = "dolce-pane-widths";

type Widths = { code?: number; side?: number };

function load(): Widths {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as Widths;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function save(w: Widths): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(w));
  } catch { /* 记不住就算了 */ }
}

export function setupSplitters(): void {
  const body = document.getElementById("body");
  const scoreShell = document.getElementById("score-pane-shell");
  const splitCode = document.getElementById("split-code");
  const splitSide = document.getElementById("split-side");
  if (!body || !scoreShell || !splitCode || !splitSide) return;
  const widths = load();
  const apply = () => {
    for (const [el, name, v] of [[body, "--code-w", widths.code], [scoreShell, "--side-w", widths.side]] as const) {
      if (typeof v === "number" && Number.isFinite(v)) el.style.setProperty(name, `${v}%`);
      else el.style.removeProperty(name);
    }
  };
  apply();

  /** `key` 那一栏的百分比 = 指针 x 相对 `ref` 的比例，夹在 [lo, hi]，`minRest` 是右边至少留的像素 */
  const wire = (bar: HTMLElement, ref: HTMLElement, key: keyof Widths, lo: number, hi: number, minRest: number) => {
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      body.classList.add("resizing");
      bar.classList.add("active");
      const move = (ev: PointerEvent) => {
        const rc = ref.getBoundingClientRect();
        if (rc.width <= 0) return;
        const x = Math.min(ev.clientX - rc.left, rc.width - minRest);
        widths[key] = Math.round(Math.min(hi, Math.max(lo, (x / rc.width) * 100)) * 10) / 10;
        apply();
      };
      // 拖到一半分隔条被藏起（并排原图关掉）也会丢捕获：一律在 lostpointercapture 收尾，免得 #body 卡在 .resizing
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("lostpointercapture", up);
        body.classList.remove("resizing");
        bar.classList.remove("active");
        save(widths);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("lostpointercapture", up);
    });
    bar.addEventListener("dblclick", () => {
      delete widths[key];
      apply();
      save(widths);
    });
  };
  wire(splitCode, body, "code", 15, 70, 240);
  wire(splitSide, scoreShell, "side", 15, 85, 160);
}
