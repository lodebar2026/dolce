// L6 成书迁 Rust 的 TS 参考导出（dev `book-draw-rs-diff.mjs`）：`pdflayout/browser.ts`（成书读谱、简谱引擎成书档、页面树 → DrawList、
// 数谱行、量自然跨度与一行容量）与 `pdflayout/songbook.ts`（混排歌本整本）各出一档期望。Rust 那份在 `crates/dolce-book`
// （`scenedraw.rs` / `songbook.rs`），比对在 `crates/dolce-cli/src/bookdraw.rs`。
// 只导出、不改行为；排版迁完（H 期）随 TS 排版一起删。
import {
  bookCellsPerLine, bookDocOf, bookRoleOf, countStaffRows, layoutBookDoc, maxStaffRowCells, measureBookSpans, pageItemsToDrawPage,
} from "../pdflayout/browser";
import { layoutMixedSongbook, type SongbookInput } from "../pdflayout/songbook";
import type { DrawPage } from "../pdflayout/drawlist";
import type { BookStyle } from "../style/bookstyle";
import type { ScoreDoc } from "../model/doc";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 数：非有限数写成 `"NaN"` / `"Inf"` / `"-Inf"` */
const jn = (x: number | undefined | null): Json =>
  x === undefined || x === null ? null : Number.isFinite(x) ? x : Number.isNaN(x) ? "NaN" : x > 0 ? "Inf" : "-Inf";
const plain = (v: unknown): Json => (v === undefined ? null : (JSON.parse(JSON.stringify(v)) as Json));

/** 文档 → JSON（顶层 `source` 是原文，不比） */
function docOf(doc: ScoreDoc): Json {
  const { source: _s, ...rest } = doc as ScoreDoc & { source?: unknown };
  void _s;
  return plain(rest);
}

/** 一种落页调法：角色口径、整页平移、缩放 */
export interface DrawVariant {
  role: "book" | "item";
  offset: [number, number];
  scale?: number;
}

/**
 * 成书一首的用例期望：读谱后的文档、一行容量、自然跨度，以及按几种页高排出、按几种调法落成 DrawList 的页与谱行数。
 * `pageHs` 里的 `"compact"` = 紧排（`margin.top + naturalH + 0.5 + margin.bottom`，naturalH 取第一种页高那次），同 rebuild 的紧排。
 */
export function bookDrawCase(
  xml: string, style: BookStyle, pageHs: (number | "compact")[], variants: DrawVariant[][], id: string, title: string,
): Record<string, Json> {
  const spans = measureBookSpans(bookDocOf(xml), style);
  const layouts: Json[] = [];
  let natural0: number | null = null;
  pageHs.forEach((h0, li) => {
    const pageH = h0 === "compact" ? style.page.margin.top + (natural0 ?? 0) + 0.5 + style.page.margin.bottom : h0;
    const r = layoutBookDoc(bookDocOf(xml), style, pageH);
    natural0 ??= r.naturalH;
    const draws: Json[] = (variants[li] ?? variants[0]).map((v) => {
      const pages: DrawPage[] = r.pages.map((g, i) =>
        pageItemsToDrawPage(g, style.page.w, style.page.h, {
          style,
          ...(v.role === "book" ? { roleOf: bookRoleOf } : {}),
          pageNo: i + 1,
          offset: { x: v.offset[0], y: v.offset[1] },
          ...(v.scale !== undefined ? { scale: v.scale } : {}),
          meta: { kind: "score", songs: [{ id, title, first: i === 0 }] },
        }));
      return { variant: plain(v), pages: plain(pages), rows: countStaffRows(pages), maxCells: maxStaffRowCells(pages) };
    });
    layouts.push({ pageH: jn(pageH), naturalH: jn(r.naturalH), draws });
  });
  return {
    doc: docOf(bookDocOf(xml)),
    cells: jn(bookCellsPerLine(bookDocOf(xml), style)),
    spans: { width: jn(spans.width), spans: [...spans.spans].map(([k, s]) => [k as Json, { x0: jn(s.x0), x1: jn(s.x1), x1b: jn(s.x1b) }]) },
    layouts,
  };
}

/** 混排歌本整本的用例期望（报错只比标题：错误文本是 TS 的栈） */
export async function songbookCase(input: SongbookInput): Promise<Record<string, Json>> {
  const r = await layoutMixedSongbook(input);
  return {
    pages: plain(r.pages), toc: plain(r.toc), starts: r.starts, titles: r.titles, families: r.families,
    errors: r.errors.map((e) => ({ title: e.title })), frames: plain(r.frames),
  };
}
