//! `omr-cli`：识别的命令行：回归（`regress`）、识别一个文件（`recognize`）、五线谱会话（`session`）、歌本切分（`split`）。
mod recognize;
mod regress;
mod split;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "用法：
  omr-cli regress <jianpu|solo|chorus|vector|xinbian> [--only=子串] [--jobs=N] [--out=目录] [--ref=目录] [--web=目录] [--replay=目录] [--area=结构] [--judge-only]
      跑识别（各曲并行）→ 产物落盘到 --out → 调私有仓库判分（solo-ops / chorus-ops 的 --from）→ 与 --ref 的 TS 基线逐曲比
      缺省：--out=../dev/data/rust-omr/runs/<档>，--ref=../dev/data/rust-omr/ref-c7c02820，--web=../web（判分脚本与 out/cli 所在的检出）
      --replay：不识别，拷那个目录里同名的产物来判（拿 TS 归档自测回归流程）
      --area：只比这一档的步数（结构 / 音符 / 记号 / 歌词 / 文字 / 页眉）；--judge-only：产物不动，只重新判分对比
  omr-cli recognize jianpu 文件 [--render] [--out=文件]
      识别一个简谱文件，打出行数、音数、小节数与满拍率；--render：PDF 页先用 PDFium 渲染再走像素路（对照纯矢量页那条路）
  omr-cli recognize staff 文件 [--out=目录]
      识别一个五线谱文件，写出 <曲>.musicxml（带识别 id）与 <曲>.review.json（核对 JSON：各页谱行几何、系统、关联表、源框、可疑、候选）
  omr-cli session 五线谱文件 --ops=操作.jsonl [--out=目录]
      识别后开会话，逐条做操作（每行一条 JSON：rebuild / restructure / pin / unpin / choose / context，见 omr-staff::session::Op），
      每一步写出 <步>.musicxml、<步>.rec.json 与 <步>.review.json，报声部数、小节数与识别 id 比上一步留下 / 没了 / 新出的个数
";

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
        Some("session") => match recognize::session(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
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
        Some("split") => match split::run(&args[1..]) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(1)
            }
        },
        _ => {
            eprintln!("{USAGE}{}", split::USAGE);
            ExitCode::from(2)
        }
    }
}

/// 仓库同级目录：编译时记下的本 crate 位置往上两级是 web 检出（`web-rust/`），它的父目录放着 `web/`、`dev/`。
pub fn sibling(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(name)
}
