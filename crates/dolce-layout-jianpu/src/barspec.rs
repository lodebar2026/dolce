//! 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（照 `layout/jianpu/barspec.ts`）。定位（量宽）与绘制共用。

use dolce_engrave::barline::BarlineSpec;
use dolce_model::doc::BarStyle;
use dolce_view::ast::{BarlineElement, BarlineType};

/// 一条小节线画成什么样（spec, final）；None = 不画线。下一小节左线上起反复的画成 `|:` / `:|:`
pub fn fanqie_barline_spec(el: &BarlineElement) -> Option<(BarlineSpec, bool)> {
    let fwd = el.repeat_forward_after == Some(true);
    let ty = if fwd && matches!(el.kind, BarlineType::Normal | BarlineType::End | BarlineType::Double) {
        BarlineType::RepeatStart
    } else if fwd && el.kind == BarlineType::RepeatEnd {
        BarlineType::RepeatBoth
    } else {
        el.kind
    };
    let spec = match ty {
        BarlineType::Normal => BarlineSpec::default(),
        BarlineType::Double => BarlineSpec { style: Some(BarStyle::LightLight), ..Default::default() },
        BarlineType::End => BarlineSpec { style: Some(BarStyle::LightHeavy), ..Default::default() },
        BarlineType::RepeatStart => BarlineSpec { repeat_forward: true, ..Default::default() },
        BarlineType::RepeatEnd => BarlineSpec { repeat_backward: true, ..Default::default() },
        BarlineType::RepeatBoth => BarlineSpec { repeat_backward: true, repeat_forward: true, ..Default::default() },
        BarlineType::Hidden | BarlineType::Invisible => return None,
    };
    Some((spec, ty == BarlineType::End))
}
