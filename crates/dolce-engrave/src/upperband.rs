//! 谱行**上方那一带**的纵向堆叠（`engrave/upperband.ts`）：弧 / 三连音括线 / fermata / 和弦 / 段落词 / 转调 / 房号共用一把尺子。
//! 「带序 + 扫描线」两条规则，只管 y；纯几何。

use std::collections::HashMap;

/// 一个待堆叠的对象。`top` / `bottom` 一律是**墨迹**上下缘（y 向下）。
pub struct BandItem<'a> {
    /// 回填 dy 的钥匙（TS 是对象身份；同钥匙的共用一个 dy）
    pub key: usize,
    pub x0: f64,
    pub x1: f64,
    pub top: f64,
    pub bottom: f64,
    /// 带序，自下而上：0 弧 / 三连音 / fermata / 奏法，1 和弦 / 段落词 / 表情，2 转调，3 房号
    pub layer: f64,
    /// 同层内的排序键：小的排在下面
    pub rank: Option<f64>,
    /// 同一种类之间不互避
    pub kind: Option<String>,
    /// 非空时，被同一个下层对象压住的这一类整排取齐
    pub spread: Option<String>,
    /// 这一段 x 区间内本对象的墨迹顶（相对未抬升时）；不给就用 `top`
    pub top_at: Option<Box<dyn Fn(f64, f64) -> f64 + 'a>>,
    /// 让位净距按 `gap × 这个系数`，缺省 1
    pub gap_scale: Option<f64>,
    /// 对这些 kind 不让位
    pub skip_kinds: Vec<String>,
}

#[derive(Clone, Copy)]
struct Bx {
    x0: f64,
    x1: f64,
    top: f64,
    bottom: f64,
}

fn x_hit(a: &Bx, b: &Bx) -> bool {
    a.x1 > b.x0 && a.x0 < b.x1
}

/// 算出每个对象该抬多少（dy ≤ 0），按钥匙。
pub fn stack_upper_band(items: &[BandItem], gap: f64) -> HashMap<usize, f64> {
    let mut dy: HashMap<usize, f64> = HashMap::new();
    for it in items {
        dy.insert(it.key, 0.0);
    }
    let get = |dy: &HashMap<usize, f64>, k: usize| dy.get(&k).copied().unwrap_or(0.0);
    let box_of = |dy: &HashMap<usize, f64>, it: &BandItem| {
        let d = get(dy, it.key);
        Bx { x0: it.x0, x1: it.x1, top: it.top + d, bottom: it.bottom + d }
    };
    let mut placed: Vec<usize> = Vec::new();
    let mut layers: Vec<f64> = Vec::new();
    for it in items {
        if !layers.iter().any(|l| *l == it.layer || (l.is_nan() && it.layer.is_nan())) {
            layers.push(it.layer);
        }
    }
    // `[...].sort((a, b) => a - b)`（稳定）
    layers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    for layer in layers {
        let mut cur: Vec<usize> = (0..items.len()).filter(|&i| items[i].layer == layer).collect();
        cur.sort_by(|&a, &b| {
            let (ra, rb) = (items[a].rank.unwrap_or(0.0), items[b].rank.unwrap_or(0.0));
            (ra - rb).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut done: Vec<usize> = Vec::new();
        for &ii in &cur {
            let it = &items[ii];
            for _ in 0..8 {
                let me = box_of(&dy, it);
                let mut d = get(&dy, it.key);
                for &pi in placed.iter().chain(done.iter()) {
                    let p = &items[pi];
                    if p.layer == it.layer && p.kind == it.kind {
                        continue;
                    }
                    if let Some(pk) = &p.kind {
                        if it.skip_kinds.contains(pk) {
                            continue;
                        }
                    }
                    let pb = box_of(&dy, p);
                    if !x_hit(&me, &pb) {
                        continue;
                    }
                    let p_top = match &p.top_at {
                        Some(f) => f(me.x0, me.x1) + get(&dy, p.key),
                        None => pb.top,
                    };
                    if me.bottom <= p_top || me.top >= pb.bottom {
                        continue;
                    }
                    d = dolce_base::js::min(d, p_top - gap * it.gap_scale.unwrap_or(1.0) - it.bottom);
                }
                if Some(d) == dy.get(&it.key).copied() {
                    break;
                }
                dy.insert(it.key, d);
            }
            done.push(ii);
        }
        let spreadable: Vec<usize> = done.iter().copied().filter(|&i| items[i].spread.is_some()).collect();
        if !spreadable.is_empty() && !placed.is_empty() {
            for _ in 0..8 {
                let mut changed = false;
                for &pi in &placed {
                    let pb = box_of(&dy, &items[pi]);
                    // Map 保插入序
                    let mut by_kind: Vec<(String, Vec<usize>)> = Vec::new();
                    for &si in &spreadable {
                        let it = &items[si];
                        if !x_hit(&Bx { x0: it.x0, x1: it.x1, top: 0.0, bottom: 0.0 }, &pb) {
                            continue;
                        }
                        let sp = it.spread.clone().unwrap();
                        match by_kind.iter_mut().find(|(k, _)| *k == sp) {
                            Some((_, v)) => v.push(si),
                            None => by_kind.push((sp, vec![si])),
                        }
                    }
                    for (_, arr) in &by_kind {
                        let lifted: Vec<usize> = arr.iter().copied().filter(|&i| get(&dy, items[i].key) < 0.0).collect();
                        if lifted.len() < 2 {
                            continue;
                        }
                        let lo = lifted.iter().map(|&i| get(&dy, items[i].key)).fold(f64::INFINITY, dolce_base::js::min);
                        for &i in &lifted {
                            if get(&dy, items[i].key) > lo {
                                dy.insert(items[i].key, lo);
                                changed = true;
                            }
                        }
                    }
                }
                if !changed {
                    break;
                }
            }
        }
        placed.extend(done);
    }
    dy
}

/// 一段 x 区间内、**抬完之后**的最高墨迹（`items` 的 top 已加过 dy）。空集返回 None。
pub fn band_top(items: &[BandItem], x0: f64, x1: f64) -> Option<f64> {
    let mut top = f64::INFINITY;
    for it in items {
        if it.x1 <= x0 || it.x0 >= x1 {
            continue;
        }
        top = dolce_base::js::min(top, it.top);
    }
    top.is_finite().then_some(top)
}
