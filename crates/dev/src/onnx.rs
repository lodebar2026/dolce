//! `onnx-fp16 <输入.onnx> <输出.onnx> [--min N]`：把 ONNX 模型里大的 FLOAT 权重改存 FLOAT16，后面接 `Cast(to=FLOAT)`，
//! 用到它的节点照旧读原名。图的输入输出与计算精度都不变：tract（`into_optimized`）与 onnxruntime（图优化）都把常量 Cast 折掉，
//! 推理仍是 fp32，只是权重舍入到 fp16——模型文件小一半（网页版识别要下载它）。
//!
//! 只转元素数不少于 `--min`（默认 1024）的：小张量（Resize 的 scales、短偏置）省不了几个字节，而且有的算子要在类型推断时就读常量，
//! 留 fp32 免得多一层 Cast。权重存在 `initializer` 或 `Constant` 节点的 `value` 属性里都转；子图（If / Loop）不碰。
use half::f16;
use prost::Message;
use tract_onnx::pb::{attribute_proto::AttributeType, tensor_proto::DataType, AttributeProto, GraphProto, ModelProto, NodeProto, TensorProto};

pub fn onnx_fp16(args: &[String]) -> i32 {
    let mut min = 1024usize;
    let mut files = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--min" => min = it.next().and_then(|v| v.parse().ok()).unwrap_or(min),
            _ => files.push(a.clone()),
        }
    }
    let [input, output] = files.as_slice() else {
        eprintln!("用法：dolce-dev onnx-fp16 <输入.onnx> <输出.onnx> [--min 元素数]");
        return 2;
    };
    let bytes = match std::fs::read(input) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("读 {input} 失败：{e}");
            return 1;
        }
    };
    let mut model = match ModelProto::decode(bytes.as_slice()) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("解析 {input} 失败：{e}");
            return 1;
        }
    };
    let Some(graph) = model.graph.as_mut() else {
        eprintln!("{input} 没有图");
        return 1;
    };
    let (n, before, after) = convert_graph(graph, min);
    let out = model.encode_to_vec();
    if let Err(e) = std::fs::write(output, &out) {
        eprintln!("写 {output} 失败：{e}");
        return 1;
    }
    eprintln!("转了 {n} 个张量：权重 {} → {} KB；文件 {} → {} KB", before / 1024, after / 1024, bytes.len() / 1024, out.len() / 1024);
    0
}

/// 张量的 f32 值（`raw_data` 小端或 `float_data`）。
fn floats(t: &TensorProto) -> Vec<f32> {
    if !t.raw_data.is_empty() {
        t.raw_data.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()
    } else {
        t.float_data.clone()
    }
}

/// 够大的 FLOAT 张量改成 FLOAT16（`raw_data` 存），回改前改后的字节数；不够格的回 `None`、不动。
fn to_f16(t: &mut TensorProto, min: usize) -> Option<(usize, usize)> {
    if t.data_type != DataType::Float as i32 || t.data_location.is_some_and(|l| l != 0) {
        return None;
    }
    let v = floats(t);
    if v.len() < min {
        return None;
    }
    t.raw_data = v.iter().flat_map(|&x| f16::from_f32(x).to_le_bytes()).collect();
    t.float_data.clear();
    t.data_type = DataType::Float16 as i32;
    Some((v.len() * 4, v.len() * 2))
}

fn cast_node(from: &str, to: &str) -> NodeProto {
    NodeProto {
        name: format!("{to}__cast"),
        op_type: "Cast".into(),
        input: vec![from.into()],
        output: vec![to.into()],
        attribute: vec![AttributeProto { name: "to".into(), r#type: AttributeType::Int as i32, i: DataType::Float as i64, ..Default::default() }],
        ..Default::default()
    }
}

/// 回（转了几个，改前字节，改后字节）。
fn convert_graph(g: &mut GraphProto, min: usize) -> (usize, usize, usize) {
    let (mut n, mut before, mut after) = (0, 0, 0);
    let mut casts = Vec::new();
    let mut renamed = std::collections::HashSet::new();
    for t in &mut g.initializer {
        if let Some((b, a)) = to_f16(t, min) {
            let orig = t.name.clone();
            t.name = format!("{orig}__fp16");
            casts.push(cast_node(&t.name, &orig));
            renamed.insert(orig);
            (n, before, after) = (n + 1, before + b, after + a);
        }
    }
    // 老式导出把 initializer 也列进图输入（声明成 FLOAT）：改了名的去掉那条，免得与 Cast 的输出重名
    g.input.retain(|i| !renamed.contains(&i.name));
    let mut nodes = Vec::with_capacity(g.node.len() + casts.len());
    nodes.extend(casts);
    for mut node in std::mem::take(&mut g.node) {
        let mut cast = None;
        if node.op_type == "Constant" && node.output.len() == 1 {
            if let Some(t) = node.attribute.iter_mut().find(|a| a.name == "value").and_then(|a| a.t.as_mut()) {
                if let Some((b, a)) = to_f16(t, min) {
                    let orig = node.output[0].clone();
                    node.output[0] = format!("{orig}__fp16");
                    cast = Some(cast_node(&node.output[0], &orig));
                    (n, before, after) = (n + 1, before + b, after + a);
                }
            }
        }
        nodes.push(node);
        nodes.extend(cast);
    }
    g.node = nodes;
    (n, before, after)
}
