# dolce-omr-staff

> Staff notation (and mixed staff + jianpu) recognition route of Dolce's OMR. Internal crate; use `dolce-omr`.

悦谱 Dolce 的**五线谱识别路线**（含五线谱与简谱混排）。

这是内部实现，识别的对外入口是 [`dolce-omr`](https://crates.io/crates/dolce-omr)。

## 流程

- `prep`：预处理——按谱表定成像策略、去网点与网纹
- `frame`：框架结构——谱线与谱表、墨层、系统、小节线
- `attrs`：结构信息——行首谱号 / 调号 / 拍号、行中切换、同系统互证
- `notes`：音符数据——实心 / 空心头与全音符、加线、符干与挂头、休止、符杠符尾、临时记号与附点、贴头奏法、连音
- `text`：文本及符号——文字行、分类与归属、页眉
- `spans`：线性符号——弧、松叶、房子
- `mixed`：混排简谱互证——简谱行交简谱路线认、逐小节配对纠错
- `page` / `song` / `session`：一页的流水线、整曲拼接、可改的识别会话
- `vector`：矢量 PDF 的取原语——把对象库化成原语与探针，识别判据与像素页共用

## 链接

- API 文档：<https://docs.rs/dolce-omr-staff>
- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
