// Node CLI 构建：把 src/ 里不碰 DOM 的模块打成 Node ESM 产物，供**不起浏览器**的脚本 import。
// 与 app 共用同一份源码，避免逻辑分叉成两份。各入口：
//   out/cli/index.js —— 矢量 PDF 版面那一摊（page-report.mjs / pdf-diff.mjs 等）
//   out/cli/omrfmt.js —— 简谱识别结果的门面（私有仓库自检脚本用；识谱命令行全在 Rust 的 dolce（crates/dolce-cli））
//   out/cli/j123.js  —— 123 格式与语义模型（j123-check.mjs、j123-migrate.mjs）
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false, // 别把 public/redist 拷进来
  build: {
    ssr: true,
    outDir: "out/cli",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: {
      input: { index: "src/cli/index.ts", omrfmt: "src/cli/omrfmt.ts", j123: "src/cli/j123.ts", engrave: "src/cli/engrave.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    },
  },
});
