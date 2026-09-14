# ResinForge · 光固化自动支撑系统

## 项目概述

ResinForge 是一个**纯浏览器端**的光固化（SLA/DLP/LCD）3D 打印自动支撑工具。前端基于 **Vite + React + Arco Design**，全部计算在本地浏览器完成。

核心能力：

- 载入用户 `.stl` 模型或内置演示模型（环面结、蘑菇、双层平台、悬臂雕像）
- 像素级光栅化切片引擎
- 多目标自动朝向优化
- 孤岛检测与层检查器
- 支撑热力图（模型表面按支撑需求强度着色：蓝→红）
- 语义保护面（笔刷标记不可支撑区域）
- 自动生成落板支撑 / 锚定模型表面的短小支撑
- 导出合并 STL 或仅支撑 STL

版本：v0.2（Arco React 重构版）
语言：界面与代码注释以中文为主。

---

## 技术栈

- **构建/开发**：Vite 5（`@vitejs/plugin-react`），无 TypeScript
- **UI 框架**：React 18 + `@arco-design/web-react` 2.66（暗色主题：`body[arco-theme=dark]`）
- **3D 渲染**：three.js v0.160.0（npm 依赖，非 CDN）
- **几何处理**：three.js 内置几何体 + 自定义 BufferGeometry 合并
- **STL I/O**：three.js `STLLoader` 解析；自定义二进制 STL 写入
- **运行时要求**：node 18+（开发/构建）；现代浏览器（WebGL 2 / WebGL 1）

---

## 项目结构

```text
resin-support-web/
├── index.html          # Vite 入口（<div id="root">）
├── package.json        # 依赖与脚本（dev/build/preview）
├── vite.config.js      # preserveSymlinks + 轮询 watch（网络盘兼容）
├── dev.bat / build.bat # UNC 网络盘启动器（pushd 映射盘符后 npm run）
├── src/
│   ├── main.jsx        # React 根 + Arco 样式 + 全局调试口（window.state/THREE/__dbg）
│   ├── App.jsx         # Layout：左侧参数栏 + 右侧 3D 视口
│   ├── styles.css      # 少量自定义样式（深色配色）
│   ├── store.js        # params（全部工艺参数默认值）+ state + bus（迷你 pub/sub）
│   ├── core/           # 框架无关算法层（不得 import React 组件）
│   │   ├── scene.js    # 渲染器/相机/OrbitControls/灯光/平台网格/材质/指针交互/拖放
│   │   ├── model.js    # setGeometry、内置 demo×4、STL 载入、筏层
│   │   ├── slicer.js   # rasterizeSection、analyze、buildLDI、sampleLDILayer、steepFaces 等
│   │   ├── orient.js   # 朝向候选采样、评分、缩略图（离屏渲染 → dataURL）
│   │   ├── inspect.js  # 逐层分析、层检查器绘制
│   │   ├── heat.js     # 支撑热力图（逐面热度计算 + 顶点色写入）
│   │   ├── support.js  # 支撑生成全流程（布点/防粘连/顶端几何/微型短柱）
│   │   └── stl.js      # 二进制 STL 导出
│   └── components/     # Arco UI 卡片（每卡片对应左栏一个区块）
│       ├── Viewport.jsx    # 3D 视口 + 模式栏 + 日志面板 + 层检查器 + 拖放提示
│       ├── MachineCard.jsx / ModelCard.jsx / OrientCard.jsx / ProtectCard.jsx
│       ├── SliceCard.jsx / SupportCard.jsx / ExportCard.jsx
│       └── Card.jsx / useParams.js  # 卡片壳与参数绑定钩子
└── AGENTS.md           # 本文件
```

**core ↔ React 边界**：core 只读 `params.*`、只经 `bus.emit` 发 UI 事件；React 组件订阅 bus 渲染（`log`/`toast`/`progress`/`modelInfo`/`sliceStats`/`supStats`/`orientResults`/`inspector`/`layerLabel`/`mode`/`dropHint`）。层检查器的 2D canvas 由 React 提供元素引用（`setLayerCanvas`），绘制保留在 core。

---

## 构建与运行

```bash
npm install       # 首次
npm run dev       # 开发服务器 http://127.0.0.1:8123
npm run build     # 产物到 dist/
```

### 网络盘（UNC 路径）注意事项

项目位于 `\\Nas518dbd\SHARE\resin-support-web` 之类的 UNC 路径时：

- cmd 不支持 UNC 作工作目录 → 用根目录的 `dev.bat` / `build.bat`（内部 `pushd %~dp0` 映射盘符）。
- vite 有两个 UNC 相关 bug 需要绕：`vite.config.js` 中 `resolve.preserveSymlinks: true`（阻止 realpath 把映射盘符还原成 UNC 后被 posix 归一化压垮路径）与 `server.watch.usePolling`（网络盘文件监听不可靠）。
- 若 vite 的 config 文件打包（esbuild externalize-deps）在 UNC cwd 下报 "Failed to resolve entry"，先经 bat/pushd 在映射盘符下运行即可。

### 部署

`npm run build` 后将 `dist/` 部署到任意静态托管（GitHub Pages / Vercel / Nginx 等）。无服务器端逻辑。

---

## 代码组织约定

- **参数单一事实来源**：`src/store.js` 的 `params`；core 一律 `params.xxx` 读取，React 用 `useParams()` 受控绑定（onChange 即写回并触发副作用，如 plateX/plateZ→buildPlate、raiseH→模型重新抬高）。
- **全局调试入口**（`src/main.jsx` 挂载）：
  - `window.state` — 应用状态（当前模型、支撑、分析结果、模式等）
  - `window.THREE` — 调试/自动化访问 three.js
  - `window.__dbg` — 包含 `loadDemo`、`rasterizeSection`、`analyze`、`buildLDI`、`sampleLDILayer`、`compareLDI`、`ldiColumnCrossings`
- **异步 UI 更新**：长时间循环中使用 `await nextFrame()`（即 `requestAnimationFrame`）避免阻塞渲染。
- **坐标系**：世界系即打印系——平台顶面 y=0，模型底面抬高 `raiseH`（默认 4mm），筏层厚 1.2mm。STL 载入时执行 `rotateX(-Math.PI/2)`（Z-up → Y-up），导出时逆变换回 Z-up。打印方向为 **+Y**。
- **机器配置**：板面 X/Z 与 XY 像素（µm）在左栏顶部输入，驱动模型越界警告与分析格/机器像素比提示（3D 视图不显示坐标轴与网格底板）。
- **注释风格**：中文注释为主；core 模块保留原 `/* ---------- 区块名 ---------- */` 分隔。
- **交互约定**：OrbitControls 常开；左键仅在「旋转」模式旋转，其余模式留给涂画/加/删支撑；**右键在任意模式下均以模型中心旋转视角**（`controls.target` = 模型包围盒中心），canvas 屏蔽右键系统菜单。
- **光照约定**：方向光塑形 + `RoomEnvironment` 经 PMREM 作 `scene.environment`（IBL ≈ 简易全局光照），背光面/底面不死黑；材质用 `envMapIntensity`（0.4~0.45）控制环境光占比，主场景与缩略图场景各自 PMREM（纹理不跨 renderer 共享）。
- **术语约定**：锚定模型表面的短支撑统一称「**短小支撑**」（UI 文案、日志、代码注释一致，琥珀色显示）；落到筏层/平台的称「落板支撑」（绿色显示）。支撑六部位命名见「支撑生成」节。**「顶端」** = 顶部球头 + 锥头（支撑上端接触模型的端头结构）；短小支撑下部的同构镜像（底部球头 + 锥头）称「**底端**」（原「反向销头」）。端头结构统称「顶端/底端」，不再使用「销头」。

---

## 核心算法说明

### 切片引擎

- `rasterizeSection`：自定义三角形-平面求交 + 扫描线填充，输出该层像素的占用位图（粗分析路径）。
- `buildLDI`（detail 路径）：分层深度图——每个 XZ 栅格列沿 +Y 存全部材料区间。交点携带法线方向，同向近距去重（消除镶嵌共享边重复交点），深度扫描产出**并集语义**区间（修复偶奇填充在重叠实体上的幻影洞）。`sampleLDILayer` 从区间表采样层位图；`ldiGapAt` 精确测量悬空高差（区间入口 − 下方区间出口）。
- `analyze`：对给定朝向的四元数 `q` 旋转模型后，顶点平移 `raiseH` 进入打印世界系（平台 y=0），逐层统计：
  - 支撑体积（悬空像素 × 与下方材料/平台的高差 × 像素面积）
  - 孤岛：**区域邻接有向图**（`analysis.graph`）——节点为每层连通域（含噪点小域），边为与下层节点的重叠像素数；出边权重总和 < `minAttachArea`（默认 1mm²）即孤岛；连通域面积 < `minIslArea`（默认 0.5mm²）过滤。阈值均为物理单位，与网格分辨率无关。孤岛节点保留 `pixels` 供关键点提取
  - 最大截面面积
  - 模型高度、总层数
- 抬高语义下模型最底层（悬于筏层上方）自然判为孤岛，不再豁免首层。
- 粗分析用于朝向优化（位图路径，层厚较大）；精分析用 LDI 路径（用户设置的层厚）。`opts.useLDI === false` 可回退。

### 朝向优化

- 候选集 = 13 个正交规范化朝向 + N 个随机四元数（N=32/64/128）。
- 对每个候选执行粗切片，并用 `steepFaces` 计算陡峭悬空面积（含保护面权重）。
- 评分权重：支撑体积 32%、孤岛面积 18%、陡峭悬空面积 20%、最大截面 20%、高度 10%。
- 取评分最高的 8 个候选，离屏渲染缩略图（`toDataURL`），经 bus 发给 React 渲染，可手动选择或一键应用最佳朝向。

### 保护面

- 用户进入「保护面」模式后在模型表面涂画，笔刷半径内的三角形面索引加入 `state.protectedFaces`。
- 保护面权重 `protW` 会放大该面的评分惩罚，并在生成支撑时抑制该面附近的支撑尖端。
- 受保护面在视口中显示为红色（热力图模式下改为紫色，避免与红色热点混淆）。

### 支撑热力图（`heat.js`）

- 逐面热度 = **悬空角超出量**（法线越过自支撑角的程度，阈值处 0 → 全朝下 1，经 0.6 次幂提亮低热区）× **悬空高差调制**（有精分析 LDI 时：下方 <0.8mm 有材料 = 已托住不热——与支撑生成的短跨豁免口径一致；高差越大越热，8mm 封顶）；无分析数据时退化为纯角度。
- 顶点色写入：**热度直接在平滑顶点法线场上计算**（非索引几何按位置合并重复顶点，邻接面法线按面积加权平均成连续法线场，逐唯一顶点求热度），再做 1 轮轻度邻域 Jacobi 扩散去 LDI 栅格毛刺——不用「面热度→顶点平均」的二次平滑（会沿三角拓扑扩散出波浪纹）。`applyHeatColors` 按色带（亮灰蓝→青→绿→黄→橙红→红）逐顶点写入，GPU 插值成连续渐变；保护面覆盖为紫。`setHeat(false)` 恢复白+保护面红。
- 联动：分析完成（`sliceStats`）/ 更换模型（`modelInfo`）/ 保护面增减（`protectedChanged`）时若开关开着自动重算重绘；UI 开关在「切片与孤岛分析」卡片，附图例色条。

### 支撑生成

- 输入源：精分析得到的栅格悬空点 + 陡峭面重心 + **孤岛关键点**（`graph` 孤岛节点的周界像素按 `spacing` 体素降采样 + 全岛最低点，尖端高度取 LDI 区间入口）。
- **均匀布点**（参考 Bridson 2007 泊松盘的离散候选集变体 + PrusaSlicer `UniformSupportIsland` 的种子语义）：孤岛关键点作为种子预置占位；候选池按高度升序贪心，与已放置点保持 `spacing` 三维最小间距（空间哈希格 `spacing/√3`，±2 邻域共 125 格——±1 会因格距小于间距而漏检）。三维距离在斜面上天然近似测地均匀。孤岛周界种子间允许密于 `spacing`（边缘翘曲高风险区有意加密）。
- 放置顺序：孤岛关键点优先（保障每孤岛周界与根部覆盖），普通聚类池其次；同体素互斥去重。
- **冗余过滤（支撑减量）**：
  1. **覆盖锥**（Vanek 2014 Clever Support coverage）：已放置低点支撑的自支撑锥（半径 = 高差 × tan(自支撑角)，高差上限 12mm，0.9 余量）覆盖其上方连通坡面的悬空候选——坡面底部钉住后向上逐层有重叠，不再铺满。孤岛种子永不参与被过滤。局限：纯几何近似，不验证区域连通性（0.9 余量 + 12mm 上限控制误滤）。
  2. **锥底防粘连**：落板支撑锥底在平台层互不重叠（XY 最小间距 = 底盘直径 × 1.05，与高度差无关）。例外：孤岛周界种子的锥底允许粘连成 brim 裙边（增强底边附着、防翘边，属有意行为）。
  3. **杆身防粘连**（对所有支撑生效，含种子）：主干球心（`mesh.userData.jx/jz/jbx/jbz`，倾斜后偏离接触点）XY 净距 < 中段直径+0.4mm 且 Y 区间重叠（按网格范围外扩 0.2mm，间隙判据 0.3mm）→ 互斥。泊松盘只约束尖端点，杆身/球头互撞必须显式判定——锚定长杆互粘的主要来源。**教训**：种子的「首根豁免」在多岛屿模型上失控（Arm_Left 实测 223 岛 1002 对互粘），已取消豁免；「覆盖兜底」必须在「终检去重」之前执行（兜底不做互撞检查，顺序反了会制造新互粘对）；终检对双种子互贴保留（相邻孤岛共钉）。
  4. **终检去重**：放置期无法预知候选自身球心偏移，事后按真球心站位复核清冗（去普通池优先）。
  5. **覆盖兜底**：附近无支撑的孤岛逐个尝试其关键点直到一根落地（不做互撞检查）。
- 对每个候选点：
  - 若尖端 0.15mm 已在模型实体内，则跳过（贴面过滤）。
  - **下方 0.8mm 内已有材料 → 已托住跳过**（Formlabs 短跨豁免：桥接即可，不打支撑）。
  - **最小跨度过滤 `minSupLen`**（= 2×(r_pin+r_back)+0.69mm，默认参数下 ≈1.79mm）：锚定跨度容不下顶端+底端时**不生成常规支撑**（必退化为对顶球头疙瘩），改走「**微型短柱**」（CHITUBOX 标准件风格：Ø=中段直径的竖直圆柱 + 两端半球，上下各扎入 0.1mm，几何永不退化；对齐 CHITUBOX 实测 Ø0.8mm 球端微柱铺 0.5~2mm 短间隙的做法）；落板支撑过短则直接跳过。来源：Arm_Left 羽毛尖端实测 span 0.99~1.24mm 断支撑。
  - **锚定面可信度**（仅常规底端锚定）：命中面法线 y 分量 < 0.5（竖直侧壁/悬空下表面）→ 不能承载，拒绝锚定（羽毛尖端向下射线 1~3mm 内命中相邻羽枝侧壁的典型误锚）。微型短柱为直柱，不做此检查（对锚面平整度要求低，CHITUBOX 同样锚在侧壁上）。
  - 若最近保护面距离 < 5mm，则跳过。
  - 启用「短小支撑」时，向下探测最近模型表面作为锚点，否则落到筏层顶面（筏层关闭时为平台 y=0）。
- **区域面积过滤**（BambuStudio Minimum Support Area / Orca "Remove Small Overhangs" / Wang Z. support-relevant 框架）：候选点按 2mm 格 26 邻域并查集聚成连通悬空区域，区域面积 < `minSupArea`（默认 2mm²，UI 可调）→ 整区不生成。孤岛不走此过滤（真孤岛无桥可架，由种子保障）。局限：体素并查是空间近似，面上连通的大坡面不会被拆小（那类由覆盖锥/已托住规则处理）。
- **两个生成入口**（`runGenSup({ islandsOnly })`）：
  - **自动支撑**：全流程——清空现有支撑后按「孤岛种子 → 泊松盘普通池 → 覆盖兜底 → 终检去重」重建。
  - **自动孤岛支撑**（`islandsOnly`）：**只为孤岛位置增量补打**，不清空现有支撑。只放孤岛关键点（普通候选池/区域过滤/终检全部跳过）；孤岛附近 2mm 内已有支撑则跳过（防重复补打）；放置前把既有支撑球心预登记进杆身防粘连列表，新支撑避开旧支撑；数量上限含既有支撑。
- 支撑几何为 **PrusaSlicer 风格分段结构**（`makeSupportMesh`）。**六部位命名约定**（落板支撑，从上到下；1+2 合称「**顶端**」）：
  1. **顶部球头**（半径 r_pin = 「顶部球头」直径/2）：接触模型的球头，极点沿轴扎入模型 pen mm（「嵌入深度」可调，默认 0.2）
  2. **锥头**：顶部球头与中部球头之间的圆台裙边（「锥头长度」「锥头顶宽」「锥头底宽」均可调，默认 0.7mm / 同球头直径 / 同中段直径）
  3. **中部球头**（半径 r_back = 中段直径/2）：顶端与主干的过渡球
  4. **主干**：柱身锥台，半径 = r_back
  5. **锥底**：基座锥台（底半径 = 底盘直径/2，高约跨度 15%）
  6. **底板**：筏层（`raftMesh`，模型 XZ 外接圆 + 边距，厚 1.2mm）

  锚定短小支撑下部为「**底端**」（底部球头 + 锥头镜像，与顶端同构，原称「反向销头」），无锥底；**顶端与底端均可倾斜**，主干连接两个中部球头球心（可斜置，两端藏于球内无缝）。
- **顶端/底端自动朝向**（对应 PrusaSlicer `Head.dir`）：顶端沿被托面外法线倾斜、底端沿承载面外法线倾斜，**限锥角 = 自支撑角 `selfAngle`（默认 45°）**，另有 **8° 死区**（近平面不倾斜，吸收细分法线噪声）；极点 = 接触点 + 轴·pen（沿轴扎入）；落板支撑主干垂直，短小支撑主干连接两个中部球头球心（双端头倾斜时斜置，属预期）。法线来源：顶端用 `probeFace`（尖端上方 0.05mm 竖直向下射线命中面），底端用锚定射线（`findBelow`/`rayDown`）命中面；手动加支撑用命中面法线。
- **平滑合并三原则**（PrusaSlicer `SupportTreeMesher` 的 pinhead 结构 + CHITUBOX 式重叠搭接）：
  1. 锥头为独立圆台（长度/顶宽/底宽可调），两端没入**完整球头**内部（球心距 = 锥头长度）——任意宽度组合都不会出现破面或环缝
  2. 主干端部**嵌入中部球头球心**（柱顶帽藏于球内），柱半径 = 球半径，球赤道与柱面自然相切
  3. 各段不做布尔并集，重叠实体在切片偶奇填充下自然合并（同 PrusaSlicer `its_merge`），合并为单一 Mesh
- 支撑数量上限 900；抬高后模型底面轮廓会铺满布点，占用较多配额。

### 脚手架（菱形格架，`buildScaffold`）

- 结构参考 **Materialise e-Stage**（open diamond structure：开放菱形格防树脂滞留、省料易拆）与 **TANGO V-Support**（立柱 + 横梁组成连续栅栏墙片）：相邻**落板立柱**之间沿高度连续布置**菱形格**，横向连成墙片，整片支撑成为一体格架。锚定短小支撑不参与（两端已在模型上）。
- **菱形格**：每根立柱连接 XY ≤ crossMaxXY 内最近 2 根（去重边）；每条边在「两柱主干共同高度 ∩ 起始高度以上」内按格高 crossZStep 逐格布置；**每格四梁汇于中心节点**（两柱上下端点 → 格中心）——中心节点是真实连接（四梁合一），比 X 交叉（空中相交无节点）刚性更好。
- 参数：`crossD` 梁直径（默认 0.5mm）、`crossStartH` 起始高度（默认 3mm，相对平台）、`crossZStep` 菱形格高度（默认 5mm）、`crossMaxXY` 柱距上限（默认 8mm）。
- 梁两端没入立柱主干（重叠搭接不布尔）；全部横梁合并为单一 Mesh（绿色同落板支撑），`state.supports` 中登记为 `scaffold: true` 项（随清空/导出/点删一并处理；supStats 计数不含横梁）。
- 幂等重建：`runGenSup` 末尾自动调用；UI 开关切换时也会清旧重建。

### STL 导出

- 合并模型与/或支撑顶点数据，生成二进制 STL（80 字节头 + 4 字节面数 + 每面 50 字节）。
- 支撑位置通过 `mesh.position` 偏移写入；模型附带 `mesh.position.y = raiseH` 的抬高偏移。
- 启用筏层时附带筏层圆柱（模型 XZ 外接圆半径 + 边距，厚 1.2mm）。**筏层默认关闭**：显示与导出自一致——默认支撑落到平台 y=0、导出不带底板，勾选后才显示并随导出携带。
- 写出前统一做 Y-up → Z-up 逆变换 `(x,y,z) → (x,-z,y)`，与载入的 `rotateX(-90°)` 互逆。

---

## 测试策略

- **无自动化测试框架**：项目没有单元测试、集成测试或 CI 配置。
- **无头验证工具**：`.bench.mjs`（CDP 驱动无头 Chrome，真实时间性能基准；用法：先 `npm run dev`，再 `node .bench.mjs http://127.0.0.1:8123/`）；`__dbg.compareLDI`（LDI 与位图路径逐层位图对照）。注意 `--virtual-time-budget` 下 `performance.now()` 不前进且 rAF 会停，时序测量必须用 CDP 方式。
- **手动测试路径**：
  1. `npm run dev` 打开页面，默认加载「环面结」演示模型。
  2. 载入自定义 `.stl` 或切换 demo。
  3. 运行「自动朝向优化」，查看候选缩略图与评分。
  4. 进入「保护面」模式涂画若干区域。
  5. 运行「逐层分析」，打开层检查器查看孤岛（红色高亮）。
  6. 调整支撑参数后点击「自动生成支撑」。
  7. 导出「模型+支撑 STL」与「仅支撑 STL」，在 CHITUBOX / Lychee 等切片软件中验证。
- **性能注意**：当面数 > 120,000 时，朝向优化与逐层分析会明显变慢；代码中有日志提示。

---

## 安全与隐私

- **完全客户端运行**：用户 STL 文件由浏览器 `FileReader` / `arrayBuffer()` 读取，不上传任何服务器。
- **无外部 API**：所有依赖经 npm 安装并打进 bundle，运行时不请求任何后端或 CDN。
- **无认证、无状态持久化**：刷新页面后所有模型、保护面、支撑都会丢失。

---

## 修改建议

- 如需新增 demo 模型，在 `src/core/model.js` 的 `loadDemo` 中添加分支并在 `ModelCard.jsx` 扩展按钮。
- 如需调整评分权重，修改 `src/core/orient.js` 朝向评分中归一化后的 `r.w` 计算。
- 如需支持其他格式（如 OBJ/PLY），需引入对应 three.js loader 并参照 `loadSTLBuffer` 接口实现。
- 新增工艺参数：在 `store.js` 的 `params` 加默认值 → core 用 `params.x` 读取 → 对应卡片加 `InputNumber` 绑定。
- core 模块保持「不 import React」的边界；UI 副作用一律走 bus 事件。

---

## 已知限制（v0.2）

- 支撑生成使用体素聚类中心作为尖端位置，未做射线精化贴面。
- `steepFaceMetric` 为早期废弃函数，实际使用 `steepFaces`。
- 精分析网格分辨率固定为 288，大模型可能内存占用较高。
- 无状态持久化；大模型（>60 万面）载入后朝向优化耗时较长。
