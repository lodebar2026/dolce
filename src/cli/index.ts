// Node CLI 侧的入口：汇出矢量 PDF 版面与样式表那一摊，由 `npm run build:cli`（vite --ssr）打成
// out/cli/index.js 供脚本 import（识别在 Rust 的 omr-cli，不经这里）。
//
// **这里只能汇出不碰 DOM 的模块**——page-report / pdf-diff 一类脚本不起浏览器。
// 排版件（依赖 common/measure.ts 的）走 `cli/engrave.ts`（它装测量后端），也不进这里。
export * from "../common/cjkpunct";
export * from "../pdflayout/vector";
export * from "../pdflayout/vectext";
export * from "../pdflayout/bookprofile";
export * from "../pdflayout/inventory";
export * from "../pdflayout/glyphdict";
export * from "../pdflayout/spec";
export * from "../style/sheet";
export * from "../style/cascade";
export * from "../style/ss";
export * from "../style/template";
export * from "../style/themes";
export * from "../style/bookss";
export * from "../style/bookstyle";
export * from "../pdflayout/stats";
export * from "../pdflayout/drawlist";
export * from "../pdflayout/align";
export * from "../pdflayout/bookmeta";
export * from "../pdflayout/bookparts";
export * from "../pdflayout/booktemplate";
export * from "../pdflayout/manifest";
export { creatorOf, creatorTypeOf, META_KEYS } from "../model/metakeys";
export type { Binary, Component, Rect, JpNum, StaffRow, RecognizedScore, TextRegion } from "../omr/types";
