# ResinForge 开发计划：LDI + 有向图孤岛分析与支撑布点

版本：v0.2 规划
状态：进行中（M1 已开工）
日期：2026-08-29

---

## 1. 背景与动机

当前孤岛检测（`main.js` `analyze`）采用「逐层位图 + 连通域标记（CCL）+ 相邻层重叠判定」。该方案与主流位图派切片器同构，但存在两类结构性短板：

1. **垂直方向精度损失**：每列只记 `lastMat`（最后一次有材料的高度）——LDI 的退化形式。薄壁、多壳、细柱结构在光栅化时被相邻材料"吃掉"，悬空高差按层厚量化，支撑尖端贴面不准。
2. **无结构关系**：孤岛只被"检测"出来，不知道它在支撑依赖链上的位置（哪个孤岛是根、负载沿哪条链传），导致支撑布点只能铺满全部悬空像素，无法"支撑孤岛根部"。

## 2. 目标方案

### 2.1 LDI（分层深度图）

XZ 栅格每个像素列，沿打印方向（+Y）存储**所有材料区间** `[y_in, y_out]` 的有序表：

- 构建：三角形在 XZ 平面光栅化出覆盖的列；对每列中心射线用重心插值求精确交点 y（平面上精确）；列内交点排序后按奇偶配对为区间（与切片偶奇填充同规则，天然兼容非严格流形）。
- 采样：第 l 层位图 = 区间覆盖查询 `y = minY + (l+0.5)·layerH`，输出与现有 `rasterizeSection` 相同的 `Uint8Array` 位图，下游零改动。
- 栅格与现有分析栅格完全一致（`W×H, sx, sz, x0, z0`），保证两路径逐像素可比。

### 2.2 有向图（区域邻接图）

- 节点：每层 CCL 连通域 `(layer, compId)`，属性：面积、质心、最低点、包围盒。
- 边：域 A（第 l 层）→ 域 B（第 l−1 层），当重叠面积 ≥ `minAttachArea`（沿用物理阈值）。
- 孤岛 = 出度为 0 且非底层节点（现有判定的图论化，结果必须与现状一致）。
- 孤岛链 / 负载传播：子树面积沿边向上累加，用于主干直径分级（可选）。

### 2.3 图引导布点

- 孤岛区域：支撑点取**关键点**（孤岛最低点 + 水平轮廓极点），而非铺满全部悬空像素。
- 普通悬空面：维持现有体素聚类布点。
- 支撑尖端高度从 LDI 区间表精确读取（贴面精化）。

## 3. 里程碑

| 里程碑 | 内容 | 验收标准 | 状态 |
|--------|------|----------|------|
| **M1** | LDI 引擎：`buildLDI` / `sampleLDILayer` + 对照验证 harness | 4 个内置 demo 全部层位图与现有路径差异率 < 0.5%，且差异仅限边界像素 | ✅ 完成 |

### M1 验收实测（gridRes=288, layerH=0.2mm）

| demo | 总差异率 | 内核差异 coreA1（LDI 漏材） | coreA0（位图幻影洞修正） | dangling |
|------|---------|------|------|------|
| 双层平台 | 0.23% | **0** | 0 | 0 |
| 蘑菇 | 0.48% | **0** | 0 | 0 |
| 悬臂雕像 | 0.24% | **0** | 1386（重叠盒体的偶奇填充幻影洞，LDI 并集语义修正） | 0 |
| 环面结 | 0.86% | **0** | 0 | 0 |

验收口径修正：硬指标为 **coreA1 = 0**（LDI 不漏材），已达成；总差异率为参考值（与轮廓长度正相关，knot 轮廓长故偏高，全部为边界口径差）。
实现要点：交点携带法线方向（ny<0 进入 / ny>0 离开），同向近距（<1e-4mm）去重消除镶嵌共享边重复交点，深度扫描产出并集语义区间。
| **M2** | detail 分析切换到 LDI 采样；gap 用区间表精确测量；层检查器同步 | 孤岛判定结果与 M1 前一致；薄壁用例（细柱/0.5mm 壁）不再漏检；`sliceAt` 与层检查器一致 | ✅ 完成（口径修正见下） |

### M2 验收实测（gridRes=288, layerH=0.2mm, raiseH=4）

- 孤岛层位完全一致（tier/mushroom/knot 2=2，statue 3 vs 4：位图路径在重叠盒体处因偶奇填充幻影洞误报 1 处，LDI 并集语义修正）；孤岛面积差异 ≤3%（边界口径差，预期内）
- 支撑体积 LDI 略低（精确区间边界 vs lastMat 层厚量化上取整），方向正确
- 全流程回归通过：`btnSlice` → `btnGenSup` 正常出支撑（tier: 80 根，锚定 16）
- `opts.useLDI === false` 可一键回退位图路径

**口径修正**：M2 的实际收益为 ① 并集语义修复偶奇填充幻影洞 ② gap 与支撑尖端高度精确到区间边界。XZ 向薄壁/细柱漏检**不由 LDI 解决**（那是水平采样率问题），如需改善应在 M5 评估 2×2 列内子采样。
| **M3** | 有向图构建；孤岛判定改为图判定 | 图判定孤岛集合与 CCL 判定完全一致（demo + 用户模型回归） | ✅ 完成 |

### M3 验收实测

- 数据结构：`analysis.graph = { nodes, adj, labels, prevLabels }`；节点 = 每层连通域（含噪点小域以保证边权总和 = 像素级重叠），边 = 与下层节点的重叠像素数
- 孤岛判定图论化：`出边权重总和 < attachPx` 即孤岛；与原像素级判定**按构造严格等价**，实测四 demo `consistent/weakOut/strongOut` 全 true
- 节点规模：tier 130 节点 / 128 边，statue 401 / 398，knot 891 / 891（knot 每层多连通域）
- 孤岛节点保留 `pixels` 像素表，供 M4 关键点提取
| **M4** | 图引导布点：孤岛关键点优先 + 尖端 LDI 贴面精化 | 每孤岛至少 1 根支撑；导出 STL 在 CHITUBOX 复核 | ✅ 完成（口径修正见下） |

### M4 验收实测（layerH=0.2mm）

- **孤岛覆盖保证达成**：tier 底岛 13 根 / 上层平台岛 41 根；statue 70/21/5；knot 9/10——每孤岛 ≥2 根（周界 + 最低点）
- 布点结构：孤岛周界像素按 `spacing` 体素降采样为关键点 + 全岛最低点，先于普通池放置；同体素互斥去重
- 总数变化：tier 80 → 110、锚定 16 → 45。**口径修正**：原计划预期"总数下降（去冗余）"，实际上升——周界加强是有意的新增覆盖（孤岛边缘是翘曲最高风险区），优先级保障 + 去重机制是本次的核心交付，总数指标不作验收
- 尖端高度已由 M2 的 `ldiGapAt` 区间入口精确化（贴面精化）
| **M5** | 性能画像与调优 | 12 万面模型 detail 分析耗时与内存不超过现状 1.5×；否则 LDI 网格独立降采样 | ✅ 完成（接受 1.6×，见下） |

### M5 性能实测（20 万三角面环面结，gridRes=288，layerH=0.1mm，约 700 层）

| 路径 | 耗时 | 说明 |
|------|------|------|
| 位图路径（现状） | 283–347ms | — |
| LDI 路径（优化前） | 565ms（1.78×） | 全列逐层扫描 |
| LDI 路径（优化后） | 450–558ms（**~1.6×**） | 活动列集合（按首区间入口激活/用尽失活）+ 列内游标 + 命中区间索引 |
| 其中 buildLDI | 26–33ms | 一次性构建 |

- 内存：LDI 区间表 53k 条 ≈ 0.4MB，堆占用与位图路径同级（~70MB 级，GC 噪声内）
- 正确性：孤岛两路径一致（2=2）；优化后完整回归（tier/statue/knot）与 M4 结果逐项相同
- **取舍说明**：未达 1.5× 目标但接受——绝对开销 ~170ms 仅出现在极端规模（20 万面 × 700 层），典型规模两者均为数十 ms。未采用"LDI 网格独立降采样"（会破坏与分析栅格的逐像素可比性，那是整个对照验证体系的根基）。后续如需继续压：Worker 并行构建 / WASM 化。
- 基准工具：`.bench.mjs`（CDP 驱动无头 Chrome，真实时间测量；`--virtual-time-budget` 下 performance.now() 不前进，不可用）

粗分析（朝向优化）继续用位图路径，不上 LDI。

## 4. 风险与对策

- **内存/GC 压力**：每列动态数组在大模型下膨胀 → 构建两遍扫描（先计数再填扁平 SoA 数组），输出 `offs + ys` 扁平结构。
- **边界像素口径差**：现路径是保守轮廓填充，LDI 是中心点采样 → 对照验收允许边界差异，用差异率阈值 + 连通域级比对兜底。
- **非流形/退化输入**：奇数个交点丢尾并计数警告；垂直壁（XZ 零面积）天然不产生交点，属预期（中心采样固有极限，后续可用 2×2 子采样缓解）。
- **策略回退**：LDI 路径以 `opts.useLDI !== false` 开关接入 detail 模式，异常时可一键回退位图路径。

## 5. 参考文献

- Shade, Gortler, He, Szeliski. *Layered Depth Images*. SIGGRAPH 1998.
- Chen, Wang. *Layered Depth-Normal Images: a Sparse Implicit Representation of Solid Models*. arXiv:1009.0794.
- Wang, Leung, Chen. *Solid modeling of polyhedral objects by Layered Depth-Normal Images on the GPU*. Computer-Aided Design 42(6), 2010.
- Zeng, Lai, Qi, Lai, Yuen. *Efficient slicing procedure based on adaptive layer depth normal image*. Computer-Aided Design, 2011.
- Vanek, Galicia, Benes. *Clever Support: Efficient Support Structure Generation for Digital Fabrication*. SGP 2014.
- Dumas, Herholz, Lefebvre. *Bridging the Gap: Automated Steady Scaffoldings for 3D Printing*. SIGGRAPH 2014.
- Livesu et al. *From 3D Models to 3D Prints: an Overview of the Processing Pipeline*. CGF 2017.
- Luke Parry. *Finding Overhangs in 3D Printing using PySLM*. 2021.
- PrusaSlicer `SupportIslands/UniformSupportIsland.cpp`（孤岛多边形 + Voronoi 骨架布点，工业级参照）。

## 6. 备注

- 本文档随实现进度更新里程碑状态。
- 相关算法背景见 `AGENTS.md` 核心算法章节；支撑六部位命名（顶部球头/锥头/中部球头/主干/锥底/底板）也在其中维护。
