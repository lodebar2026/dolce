import { defineConfig, type Plugin } from "vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "./src/i18n/en";

// @ts-expect-error import.meta.dirname 在 Vite 的 ESM 配置里可用（node ≥20 亦有）
const here = typeof import.meta.dirname === "string" ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));

// 网页版识别的 wasm（Rust 识别 + PDFium 的 wasm 版）→ public/redist/omr/（不入库，见 scripts/build-wasm.mjs）。
// 开发时编不出来只警告（网页版识别用不了，其余照常）；构建时编不出来就失败。桌面版（TAURI_ENV_PLATFORM）与 DOLCE_NO_WASM 跳过。
function buildOmrWasm(): Plugin {
  const run = async (strict: boolean) => {
    // @ts-expect-error 构建脚本是无类型的 .mjs
    const { buildWasm } = (await import("./scripts/build-wasm.mjs")) as { buildWasm: () => void };
    try {
      buildWasm();
    } catch (e) {
      if (strict) throw e;
      console.warn(`[build-wasm] ${(e as Error).message}——网页版识别用不了`);
    }
  };
  return { name: "build-omr-wasm", buildStart: () => run(true), configureServer: () => run(false) };
}

// 英文落地页 `/en/`（SEO）：构建完把产出的 index.html 复制一份到 en/index.html——
// `<!-- seo:start -->…<!-- seo:end -->` 换成 seo/head.en.html，`<html>` 标成英文（`data-ui-lang` 让
// 界面默认英文，见 i18n/index.ts），带 data-i18n* 的静态文字按英文词典预译（爬虫拿到的正文就是英文）。
// 资源引用都是 base 绝对路径，两页共用同一套产物。
function emitEnPage(): Plugin {
  let outDir = "out/dist";
  const dict = en as Record<string, string>;
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    name: "emit-en-page",
    apply: "build",
    configResolved(c) { outDir = c.build.outDir; },
    writeBundle() {
      const zhHtml = readFileSync(`${here}/${outDir}/index.html`, "utf-8");
      const head = readFileSync(`${here}/seo/head.en.html`, "utf-8");
      let html = zhHtml.replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->/, () => head.trim());
      if (html === zhHtml) throw new Error("emit-en-page: index.html 里没有 seo:start / seo:end 标记");
      html = html.replace(/<html lang="zh-CN">/, '<html lang="en" data-ui-lang="en">');
      // 开始标签上的 data-i18n-title / -aria / -placeholder → 改对应属性
      html = html.replace(/<[a-zA-Z][^>]*\sdata-i18n[^>]*>/g, (tag) => {
        for (const [attr, target] of [["title", "title"], ["aria", "aria-label"], ["placeholder", "placeholder"]]) {
          const key = new RegExp(`\\sdata-i18n-${attr}="([^"]+)"`).exec(tag)?.[1];
          const val = key && dict[key];
          if (val) tag = tag.replace(new RegExp(`(\\s${target}=")[^"]*"`), (_m, p1: string) => `${p1}${esc(val)}"`);
        }
        return tag;
      });
      // data-i18n 的纯文本内容
      html = html.replace(/(<[a-zA-Z][^>]*\sdata-i18n="([^"]+)"[^>]*>)([^<]*)</g, (m, open: string, key: string) => {
        const val = dict[key];
        return val ? `${open}${esc(val)}<` : m;
      });
      mkdirSync(`${here}/${outDir}/en`, { recursive: true });
      writeFileSync(`${here}/${outDir}/en/index.html`, html);
    },
  };
}

// 应用版本号只在 package.json 维护一处（release.sh 同步 tauri.conf.json / Cargo.toml），
// 构建期注入成 __APP_VERSION__ 供「关于」页与更新检查用——别在前端再抄一份常量。
const pkgVersion = JSON.parse(readFileSync(`${here}/package.json`, "utf-8")).version as string;

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// GitHub Pages 项目页部署在子路径下（BASE_PATH=/dolce/）。Tauri 桌面构建
// 不设此 env，base 保持 "/"，桌面包资源解析不受影响。
// @ts-expect-error process is a nodejs global
const base = process.env.BASE_PATH || "/";

// https://vite.dev/config/
export default defineConfig(async () => ({
  base,
  plugins: [buildOmrWasm(), emitEnPage()],
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  // 程序产出一律放 out/（构建、脚本报告、缓存），web 根下不再散落输出目录
  build: { outDir: "out/dist", emptyOutDir: true },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // 跨源隔离：网页版识别（wasm Worker）的取消标志放在 SharedArrayBuffer 里（`omrrust/webengine.ts`）。
    // 全站资源同源，COEP require-corp 无副作用。生产 GitHub Pages 设不了响应头，靠 coi-serviceworker 补。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`；out/ 是构建与脚本产出，写报告不该触发重载
      ignored: ["**/src-tauri/**", "**/out/**"],
    },
  },
}));
