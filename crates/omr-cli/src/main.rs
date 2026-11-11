//! `omr-cli`：识别的命令行。现在只有回归（`regress`）；识别、切分随两条路线落地后加。
mod recognize;
mod regress;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "用法：
  omr-cli regress <jianpu|solo|chorus|vector|xinbian> [--only=子串] [--jobs=N] [--out=目录] [--ref=目录] [--web=目录] [--replay=目录] [--area=结构] [--judge-only]
      跑识别（各曲并行）→ 产物落盘到 --out → 调私有仓库判分（solo-ops / chorus-ops 的 --from）→ 与 --ref 的 TS 基线逐曲比
      缺省：--out=../dev/data/rust-omr/runs/<档>，--ref=../dev/data/rust-omr/ref-c7c02820，--web=../web（判分脚本与 out/cli 所在的检出）
      --replay：不识别，拷那个目录里同名的产物来判（拿 TS 归档自测回归流程）
      --area：只比这一档的步数（结构 / 音符 / 记号 / 歌词 / 文字 / 页眉）；--judge-only：产物不动，只重新判分对比
  omr-cli recognize jianpu 文件 [--render] [--out=文件]
      识别一个简谱文件，打出行数、音数、小节数与满拍率；--render：PDF 页先用 PDFium 渲染再走像素路（对照纯矢量页那条路）";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("regress") => match regress::run(&regress::Opts::parse(&args[1..])) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(2)
            }
        },
        Some("recognize") => match recognize::one(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(2)
            }
        },
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// 仓库同级目录：编译时记下的本 crate 位置往上两级是 web 检出（`web-rust/`），它的父目录放着 `web/`、`dev/`。
pub fn sibling(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(name)
}
