// 页脚（BL/BC/BR 模板）的排版。
import { Font } from "../../../pagetree/font";
import { TextFrame } from "../../../pagetree/pageitem";
import { layoutRegion, songFields } from "../../../style/template";
import { type OriginalCtx, text } from "./ctx";

/** 页脚区域（样式表的 `song-foot`，出厂在 print 主题）。分页时排在本曲末页的页面底部，连续长图跟在本曲最低一行之下。按页宽算右缘，所以 `shiftX` 与 paintHeader 同口径；字号按 `as 角色` 取（`footerSize`）。 */
export function layoutFooters(c: OriginalCtx, shiftX: number): { page: number; bottom: number; items: TextFrame[] }[] {
  const region = c.foot;
  const placed = c.placed;
  if (!region || !c.doc || !placed) return [];
  const out: { page: number; bottom: number; items: TextFrame[] }[] = [];
  placed.pages.forEach((pg, i) => {
    // 连续长图把多首接成了一页：每首各在本曲最低一行之下
    const songs = pg.headers ? [...new Set(pg.groups.map((g) => g.song))] : [pg.song];
    for (const song of songs) {
      const next = placed.pages[i + 1];
      if (!pg.headers && next && next.song === pg.song) continue; // 不是本曲末页
      let low = 0;
      for (const g of pg.groups) if (!pg.headers || g.song === song) for (const v of g.voices) low = Math.max(low, v.y, ...v.lyricY);
      // 分页：页脚固定在页面底部（底边贴下边距线，用户定 2026-10-21）；谱排得太低、底部放不下才跟在曲后（不压谱）。
      // 连续长图没有固定的页底，照旧跟在本曲最低一行之下
      if (!pg.headers && !c.metrics.page.longImage) {
        const span = footerAt(c, region, song, 0, shiftX)?.bottom ?? 0;
        low = Math.max(low, c.pageHeight - c.metrics.page.margin.bottom - span);
      }
      const f = footerAt(c, region, song, low, shiftX);
      if (f) out.push({ page: i, ...f });
    }
  });
  return out;
}

/** 本曲页脚从最低一行往下占多高（没有页脚为 0）：连续长图接下一首要先让开它（place/song.ts::layoutDocument） */
export function footerSpan(c: OriginalCtx, song: number): number {
  if (!c.foot || !c.doc) return 0;
  const f = footerAt(c, c.foot, song, 0, 0);
  return f ? f.bottom : 0;
}

/** 一首的页脚：区域顶在 `low`（本曲最低一行）之下一个歌词字高处。没有页脚文字返回 null */
function footerAt(c: OriginalCtx, region: NonNullable<OriginalCtx["foot"]>, song: number, low: number, shiftX: number): { bottom: number; items: TextFrame[] } | null {
  const m = c.metrics;
  const meta = c.doc!.songs[song]?.metadata;
  if (!meta || ![...meta.bottomLeft, ...meta.bottomCenter, ...meta.bottomRight].some((t) => t.trim() && t.trim() !== "-")) return null;
  const font = (size: number): Font => new Font(m.style.font.text.family, size);
  const res = layoutRegion(region, {
    field: songFields(undefined, {
      "pageText.bottomLeft": meta.bottomLeft.map((text) => ({ text })),
      "pageText.bottomCenter": meta.bottomCenter.map((text) => ({ text })),
      "pageText.bottomRight": meta.bottomRight.map((text) => ({ text })),
    }),
    pageNo: 1,
    content: { left: m.page.margin.left, right: c.pageWidth - m.page.margin.right - shiftX },
    dy: low + m.style.size.lyric,
    sizeOf: (role) => footerSize(m, role),
    measure: (_r, t, size) => font(size).measureText(t),
    fontMetrics: (_r, size) => ({ ascent: -font(size).metrics.ascent, height: size }),
  });
  const items = res.items.flatMap((p) => {
    if (p.kind !== "text") return [];
    const f = font(p.size);
    const w = f.measureText(p.text);
    const x = p.align === "center" ? p.x - w / 2 : p.align === "right" ? p.x - w : p.x;
    return [text(p.text, x, p.y, f, c.ink)];
  });
  return { bottom: low + m.style.size.lyric + res.span, items };
}

/** 模板角色 → 字号：取尺子 `JianpuStyle` 的 `size` 与页眉四项，角色名与字段同名（`header`、`lyric`、`note`、`title`…）。 */
function footerSize(m: OriginalCtx["metrics"], role: string): number {
  const st = m.style;
  const sizes: Record<string, number> = { ...st.size };
  for (const r of ["title", "subtitle", "credit", "scripture"] as const) sizes[r] = st.header[r].size;
  const v = sizes[role];
  if (typeof v !== "number") throw new Error(`原样文档布局的模板认不出角色 ${role}（可用：${Object.keys(sizes).join(" ")}）`);
  return v;
}
