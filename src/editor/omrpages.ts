// **识别的原图页面板**（工具栏「原图页」）：这次识别用了哪几份原图，按什么顺序合成一首。
//
// 可以上下挪、删掉、再加几张，图片还能旋转 90°、裁掉边上不要的部分；改完点「按这些页重新识别」整首重跑。
// 不做「只重跑一页」：整曲识别里各页串着前一页的拍号调号，
// 一页单独重跑会和前后对不上；其余页原样输入、识别是确定的，重跑结果不变，只是要等。
// PDF 只能挪和删（页面里的位图要经 pdf.js 取，不在这里改）。

import { showFormDialog } from "./dialogs";
import type { RecogInput } from "./omrctl";
import { t } from "../i18n";

const isPdf = (f: RecogInput): boolean => f.mime === "application/pdf" || /\.pdf$/i.test(f.name ?? "");

/** 图片字节 → 位图（读不了的抛错） */
async function bitmapOf(f: RecogInput): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([f.bytes as BlobPart], { type: f.mime ?? "image/png" }));
}

/** 画布 → PNG（无损：简谱路要二值化，JPEG 的块状噪声会伤细线） */
async function pngOf(canvas: HTMLCanvasElement, name: string | undefined): Promise<RecogInput> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("pages.encodeFailed")))), "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", name: (name ?? "page").replace(/\.[^.]+$/, "") + ".png" };
}

/** 顺时针转 90°。 */
export async function rotateImage(f: RecogInput): Promise<RecogInput> {
  const bmp = await bitmapOf(f);
  const c = document.createElement("canvas");
  c.width = bmp.height;
  c.height = bmp.width;
  const g = c.getContext("2d")!;
  g.translate(c.width, 0);
  g.rotate(Math.PI / 2);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return pngOf(c, f.name);
}

/** 按比例框（0–1）裁剪。 */
export async function cropImage(f: RecogInput, r: { x: number; y: number; w: number; h: number }): Promise<RecogInput> {
  const bmp = await bitmapOf(f);
  const sx = Math.round(r.x * bmp.width);
  const sy = Math.round(r.y * bmp.height);
  const sw = Math.max(1, Math.round(r.w * bmp.width));
  const sh = Math.max(1, Math.round(r.h * bmp.height));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  c.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();
  return pngOf(c, f.name);
}

/** 裁剪框：整张图铺在遮罩上，按住拖出要留的那块，「裁剪」确认。返回比例框；放弃为 null。 */
function pickCrop(f: RecogInput): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "omr-crop-overlay";
    const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.mime ?? "image/png" }));
    const wrap = document.createElement("div");
    wrap.className = "omr-crop-wrap";
    const img = document.createElement("img");
    img.src = url;
    img.draggable = false;
    const box = document.createElement("div");
    box.className = "omr-crop-box";
    box.hidden = true;
    wrap.append(img, box);
    const bar = document.createElement("div");
    bar.className = "omr-crop-bar";
    const hint = document.createElement("span");
    hint.textContent = t("pages.crop.hint");
    const ok = document.createElement("button");
    ok.className = "modal-button-primary";
    ok.textContent = t("pages.crop");
    ok.disabled = true;
    const cancel = document.createElement("button");
    cancel.textContent = t("pages.cancel");
    bar.append(hint, cancel, ok);
    overlay.append(wrap, bar);
    document.body.append(overlay);
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    let start: { x: number; y: number } | null = null;
    const frac = (ev: PointerEvent): { x: number; y: number } => {
      const b = img.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (ev.clientY - b.top) / b.height)) };
    };
    const draw = (): void => {
      if (!rect) return;
      box.hidden = false;
      Object.assign(box.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
    };
    wrap.addEventListener("pointerdown", (ev) => {
      start = frac(ev);
      wrap.setPointerCapture(ev.pointerId);
    });
    wrap.addEventListener("pointermove", (ev) => {
      if (!start) return;
      const p = frac(ev);
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      draw();
    });
    wrap.addEventListener("pointerup", () => {
      start = null;
      ok.disabled = !rect || rect.w < 0.02 || rect.h < 0.02;
    });
    // Esc 只关裁剪框：捕获阶段先截下，别让底下的原图页对话框也收到（它会当「取消」整个关掉）
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      done(null);
    };
    document.addEventListener("keydown", onKey, true);
    const done = (r: typeof rect): void => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    ok.addEventListener("click", () => done(rect));
    cancel.addEventListener("click", () => done(null));
  });
}

/**
 * 原图页面板。`inputs` 是这次识别的原图（顺序即合成的顺序）；确定时把改过的列表交给 `apply`（由它决定要不要先问「丢弃改动」）。
 */
export function showPagesDialog(
  inputs: readonly RecogInput[], apply: (files: RecogInput[]) => void,
  opts: { okLabel?: string; hint?: string; onCancel?: () => void } = {},
): void {
  let list = [...inputs];
  /** 对话框关了：还在编码的旋转 / 裁剪回来不再重画（不再建缩略图的 ObjectURL） */
  let closed = false;
  /** 手上正在做的旋转 / 裁剪（「确定」等它做完再交列表） */
  let pending: Promise<void> = Promise.resolve();
  const busy = (): boolean => table.classList.contains("busy");
  const body = document.createElement("div");
  body.className = "settings-form omr-pages";
  const table = document.createElement("div");
  table.className = "omr-pages-list";
  const urls: string[] = [];
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:8px;opacity:0.75;font-size:12px;line-height:1.6";
  hint.textContent = opts.hint ?? t("pages.hint");
  const render = (): void => {
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    if (closed) return;
    table.replaceChildren();
    list.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "omr-pages-row";
      // 拖动换顺序：拖起这一行、放到哪一行上就挪到那儿
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        ev.dataTransfer?.setData("text/x-omr-page", String(i));
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      // 落在这一行的上半截 = 插到它前面，下半截 = 插到它后面（提示线画在对应那一边）
      const below = (ev: DragEvent): boolean => {
        const b = row.getBoundingClientRect();
        return ev.clientY > b.top + b.height / 2;
      };
      row.addEventListener("dragover", (ev) => {
        if (ev.dataTransfer?.types.includes("text/x-omr-page") && !busy()) {
          ev.preventDefault();
          row.classList.toggle("drop-before", !below(ev));
          row.classList.toggle("drop-after", below(ev));
        }
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
      row.addEventListener("drop", (ev) => {
        if (!ev.dataTransfer?.types.includes("text/x-omr-page")) return;
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-before", "drop-after");
        const from = Number(ev.dataTransfer.getData("text/x-omr-page"));
        if (!Number.isInteger(from) || busy()) return;
        let to = i + (below(ev) ? 1 : 0);
        if (from < to) to--;
        if (from === to) return;
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved!);
        render();
      });
      const idx = document.createElement("span");
      idx.className = "omr-pages-idx";
      idx.textContent = String(i + 1);
      const thumb = document.createElement(isPdf(f) ? "span" : "img");
      thumb.className = "omr-pages-thumb";
      if (thumb instanceof HTMLImageElement) {
        const u = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.mime ?? "image/png" }));
        urls.push(u);
        thumb.src = u;
        thumb.alt = f.name ?? "";
      } else thumb.textContent = "PDF";
      const name = document.createElement("span");
      name.className = "omr-pages-name";
      name.textContent = f.name ?? t("pages.nth", { n: i + 1 });
      const btn = (label: string, title: string, on: () => void | Promise<void>, disabled = false): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        // 旋转、裁剪要编码一会儿：这期间整张表锁住，免得点到还没换掉的旧按钮（它捏着旧图）
        b.addEventListener("click", () => {
          if (busy() || closed) return;
          table.classList.add("busy");
          pending = Promise.resolve(on()).catch((e) => {
            hint.textContent = t("pages.failed") + (e instanceof Error ? e.message : String(e));
          }).finally(() => {
            table.classList.remove("busy");
            render();
          });
        });
        return b;
      };
      const swap = (a: number, b: number): void => {
        [list[a], list[b]] = [list[b]!, list[a]!];
      };
      row.append(
        idx, thumb, name,
        btn("↑", t("pages.up"), () => swap(i, i - 1), i === 0),
        btn("↓", t("pages.down"), () => swap(i, i + 1), i === list.length - 1),
        // 编码回来按对象找回它现在的位置（期间加了图，下标可能已变）
        btn(t("pages.rotate"), t("pages.rotate.title"), async () => {
          const out = await rotateImage(f);
          const k = list.indexOf(f);
          if (k >= 0) list[k] = out;
        }, isPdf(f)),
        btn(t("pages.crop"), t("pages.crop.title"), async () => {
          const r = await pickCrop(f);
          if (!r) return;
          const out = await cropImage(f, r);
          const k = list.indexOf(f);
          if (k >= 0) list[k] = out;
        }, isPdf(f)),
        btn(t("pages.delete"), t("pages.delete.title"), () => {
          list = list.filter((_, k) => k !== i);
        }, list.length <= 1),
      );
      table.append(row);
    });
  };
  render();
  const add = document.createElement("input");
  add.type = "file";
  add.multiple = true;
  add.accept = "image/*,application/pdf";
  add.hidden = true;
  const addFiles = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      if (!/^image\/|^application\/pdf$/.test(file.type) && !/\.(pdf|png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name)) continue;
      list.push({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || undefined, name: file.name });
    }
    if (!busy()) render();
  };
  add.addEventListener("change", async () => {
    const files = Array.from(add.files ?? []);
    add.value = "";
    await addFiles(files);
  });
  // 外面拖进来的图片 / PDF 当「加图」（别让浏览器把图打开、离开本页）
  body.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
  });
  body.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer?.files.length) return;
    ev.preventDefault();
    ev.stopPropagation();
    void addFiles(Array.from(ev.dataTransfer.files));
  });
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = t("pages.add");
  addBtn.addEventListener("click", () => add.click());
  body.append(table, addBtn, add, hint);
  showFormDialog(t("pages.title"), body, () => {
    closed = true;
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    // 旋转 / 裁剪还在编码：等它做完再交（交出去的才是转过的那张）
    void pending.then(() => apply(list));
  }, opts.okLabel ?? t("pages.rerun"), () => {
    closed = true;
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    opts.onCancel?.();
  });
}

/** 识别**之前**先调整原图（起始页勾了「识别前先调整原图」）：确定返回调好的列表，取消返回 null。 */
export function adjustBeforeRecognize(files: readonly RecogInput[]): Promise<RecogInput[] | null> {
  return new Promise((resolve) => {
    let done = false;
    showPagesDialog(files, (list) => {
      done = true;
      resolve(list);
    }, {
      okLabel: t("pages.start"),
      hint: t("pages.beforeHint"),
      onCancel: () => {
        if (!done) resolve(null);
      },
    });
  });
}
