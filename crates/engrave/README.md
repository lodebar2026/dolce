# dolce-engrave

> Engraving foundation of Dolce: notation elements shared by the jianpu and staff engines, text measurement, page scene / SVG, style sheets.

悦谱 Dolce 的**排版底座**，简谱引擎（`dolce-layout-jianpu`）与五线谱 / 混排引擎（`dolce-layout-staff`）共用。
不开 `native` / `fontfile-system` 时无平台依赖，能编到 wasm。

## 内容

- 根上：谱面元素——每种元素（数字、八度点、减时线、弧、小节线、反复房、力度……）一份画法与定位判据；量字与 SMuFL 元数据经 `Env` 传入，不走全局。
- `text`：量字层——量字 trait、缓存、标点挤压、浏览器口径层、录放后端；`text::assets` 带随包的 Bravura 字体与 SMuFL 元数据原文。
- `scene`：页面场景节点、身份表、两种 SVG 方言（`scene::svg::page_svg`）、SMuFL 码位与元数据紧盒（`scene::smufl`）。
- `style`：`.ss` 样式表、级联、主题与纸张、三把尺子的适配器。

## 特性

- `fontfile`：字体文件层（fontdb + rustybuzz），导出嵌字用。
- `fontfile-system`：在上面再加系统字体库（Linux 经 fontconfig）。
- `native`：系统文字引擎量字——macOS CoreText、Windows DirectWrite、Linux 走 `fontfile-system`。

## 链接

- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

代码 MIT；随包的 Bravura 字体与元数据为 SIL Open Font License 1.1（故整体标 `MIT AND OFL-1.1`）。
