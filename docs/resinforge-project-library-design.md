# ResinForge 零件库 / 机器材料库 / 工程文件管理与可行性分析

> 目标：在现有 ResinForge（Vite + React + three.js，Tauri 桌面壳）上，补齐 BPS 式的「零件库 + 机器选择 + 材料选择 + 带支撑的工程文件管理 + 零件库管理」。
> 本文包含：产品设计、数据模型、文件格式、与现有代码的接入点、可行性评估与实施计划。
> BPS 的设计拆解见 [bps-design-analysis.md](./bps-design-analysis.md)。

---

## 0. 结论先行

1. **可行，建议桌面版优先。** 现有 `state.parts`、`params`、`state.supportPoints`、`state.supports` 的数据形态已经接近可序列化；工程保存的主要工作量在“模型源文件保留 + 存储层 + 恢复顺序”，不在支撑算法。
2. **零件库建议用“副本语义 + 内容寻址”**：库里和工程里各有一份元数据，底层模型文件按 SHA-256 只存一份。这样既能像 BPS 一样“放入工程后互不影响”，又不会把同一模型复制十几份。
3. **工程文件建议用明文 JSON + 标准 zip（`.rfproj`）**，桌面端落在 AppData 目录，浏览器端落在 IndexedDB / OPFS。不做 BPS 那种私有混淆格式。
4. **机器 / 材料做“档案 + 快照”**：机器是参数档案，材料带层厚与支撑预设；工程保存展开后的参数快照，老工程不受库更新影响。
5. **支撑结构不落盘**：只保存支撑点、支撑参数、保护面、零件变换与底板设置，打开工程后重新分析并重建结构。这样文件小、可继续编辑，避免 BPS 那种参数化支撑与文件型支撑两套语义。
6. **工作量**：MVP（工程保存 / 打开 + 零件库 + 机器材料库 + 工程列表）约 **15～20 人日**；做到接近 BPS 的完整度（自动保存、恢复、导入导出、配额、迁移）约 **25～35 人日**。

---

## 1. 范围与产品原则

### 1.1 本期范围

| 模块 | 本期内容 |
|---|---|
| 工程文件管理 | 新建、打开、保存、另存、自动保存、关闭提示、工程列表、文件夹、搜索、星标、多选、移动、重命名、删除、复制、导入 / 导出 `.rfproj` |
| 零件库 | 跨工程复用；文件夹、标签、搜索、排序、收藏、批量导入、从工程加入、插入工程、重命名、移动、删除、导出原文件、去重、容量提示 |
| 机器库 | 内置机型 + 自定义机型；增删改、复制、导入 / 导出；板面 / 高度 / 像素 / 分辨率 / 光源 / 膜类型 |
| 材料库 | 内置材料 + 自定义材料；颜色、密度、成本、收缩、层厚预设、曝光参数、默认支撑预设、备注；导入 / 导出 |
| 支撑工程状态 | 支撑点、支撑参数、保护面、零件变换、底板类型、模型抬高、导出设置随工程保存与恢复 |
| 存储 | 桌面端 AppData 文件；浏览器 IndexedDB（大文件后续可切 OPFS）；配额提示；原子写与损坏恢复 |

### 1.2 不做 / 后置

- 账号、云端同步、多人协作；
- 在线打印机、任务队列、清洗 / 固化设备；
- 官方系统零件库；
- 外部支撑网格（文件型支撑）；
- 多窗口 / 多标签工程（先做单窗口，数据结构预留）；
- BPS `.bpsp` / `.bpsc` 直接导入（后续可作为迁移工具）。

### 1.3 产品原则

1. **本地优先**：没有账号也能完整使用；所有模型与工程不上传。
2. **副本语义**：从零件库放进工程就是独立副本；工程里的修改不污染库。
3. **快照可复现**：工程保存机器 / 材料 / 工艺参数快照，不依赖库的当前状态。
4. **明文可迁移**：JSON + 标准 zip，用户能备份、脚本能读、坏了能修。
5. **桌面优先、浏览器可用**：大库与大工程推荐桌面版；浏览器版保证单工程与中小零件库可用。
6. **复用现有算法**：不重写模型、切片、支撑、导出，只在外面加“资源与工程”层。

---

## 2. 用户旅程与信息架构

### 2.1 顶层结构

从“打开软件直接进支撑向导”改为：

```text
启动
├── 最近工程存在 → 打开最近工程（可关闭）
└── 资源库首页
    ├── 工程
    │   ├── 全部 / 最近 / 星标 / 文件夹
    │   └── 工程卡片 → 进入 Studio（五步支撑流程）
    ├── 零件库
    │   ├── 全部 / 最近使用 / 收藏 / 文件夹 / 标签
    │   └── 零件卡片 → 插入当前工程 / 打开详情
    └── 机器与材料
        ├── 机器库
        └── 材料库（含层厚 / 支撑预设）
```

只有两个“大页面”：

- **资源库**：工程 / 零件 / 机器材料的管理；
- **Studio**：当前工程的五步支撑流程。

这样避免 BPS 那种“工作区 / 切片库 / 设备 / 任务”四个入口带来的概念负担；打印相关入口等有打印功能时再加。

### 2.2 新建工程向导

BPS 是五级级联；我们压缩成三步：

```text
① 机器            ② 材料与层厚             ③ 零件
┌──────────┐      ┌──────────────┐        ┌──────────────────┐
│ 机型卡片  │  →   │ 材料卡片      │   →    │ 从零件库添加      │
│ 自定义机型│      │ 层厚预设      │        │ 导入文件          │
│          │      │ 支撑预设（高级）│        │ 演示模型          │
└──────────┘      └──────────────┘        └──────────────────┘
```

- 默认带出**上一次使用的机器 / 材料 / 层厚 / 支撑预设**。
- “高级”折叠：支撑预设、底板类型、模型抬高；不放在主路径。
- 机器卡片显示板面尺寸、高度、XY 像素、机型类型；材料卡片显示颜色、类型、层厚选项。
- 创建后进入 Studio，工程名默认 `未命名工程 YYYY-MM-DD HH-mm`，可立即改。

### 2.3 Studio 内的工程感知

在现有 Studio 浮动卡片外壳上增加最小改动：

- 顶栏左侧：`工程名 · 已保存 / 未保存`，点工程名回到资源库或弹出工程菜单；
- 顶栏右侧：机器 chip（现有 `MachinePicker`）+ 材料 chip（新增）+ 保存按钮；
- 模型卡片：显示零件来自“库 / 文件 / 演示”，支持“从零件库添加”；
- 关闭窗口 / 返回资源库：未保存时提示“保存 / 不保存 / 取消”。

不把零件库塞进 Studio 左侧 320px，而是用“从零件库添加”模态：左侧文件夹树 + 右侧卡片网格，宽度 720～880px。

---

## 3. 核心实体与数据模型

### 3.1 实体关系

```text
Project 1 ── n ProjectPart ── 1 Blob（源文件或派生网格）
Project 1 ── 1 ProjectSettings（params 快照 + 机器 / 材料快照）
Project 1 ── 1 SupportState（支撑点 + 支撑参数）
Project 1 ── 1 Thumbnail

LibraryFolder 1 ── n LibraryPart ── 1 Blob
LibraryPart 0..1 ── n ProjectPart（插入时产生副本）

MachineProfile（档案）
MaterialProfile（档案） ── n LayerPreset
```

### 3.2 工程 manifest（`manifest.json`）

```json
{
  "schema": "resinforge.project",
  "schemaVersion": 1,
  "appVersion": "0.4.0",
  "id": "prj_01J...",
  "name": "戒指支撑",
  "createdAt": "2026-10-19T08:00:00.000Z",
  "updatedAt": "2026-10-19T08:30:00.000Z",
  "starred": false,
  "folderId": "pf_01J...",
  "thumbnail": "sha256:...",
  "machine": {
    "id": "mars4ultra",
    "name": "Elegoo Mars 4 Ultra",
    "plateX": 153.4,
    "plateY": 165,
    "plateZ": 77.8,
    "pixelUm": 18,
    "type": "lcd",
    "builtin": true
  },
  "material": {
    "id": "mat_std_grey",
    "name": "标准树脂 灰",
    "family": "standard",
    "color": "#9aa0a6",
    "density": 1.1,
    "costPerKg": 180,
    "layerUm": 30,
    "supportPreset": "fine"
  },
  "settings": {
    "params": {
      "plateX": 153.4, "plateY": 165, "plateZ": 77.8, "pixelUm": 18,
      "layerH": 0.03, "raiseH": 4, "selfAngle": 45,
      "spacing": 2.5, "edgeInset": 0.5, "esBarW": 0.6,
      "baseJoin": true, "autoPlateOn": false, "unionExport": true
    }
  },
  "parts": [
    {
      "id": "pt_01J...",
      "name": "ring.stl",
      "origin": { "type": "library", "libraryId": "lp_01J..." },
      "source": { "blob": "sha256:...", "format": "stl", "bytes": 5242880 },
      "derived": null,
      "transform": {
        "ox": 12.5, "oy": 0, "oz": -3.2,
        "q": [0, 0, 0, 1]
      },
      "protectedFaces": [12, 13, 88],
      "visible": true
    }
  ],
  "supportAlgorithmVersion": 3,
  "view": { "step": "support", "camera": { "position": [0, 120, 180], "target": [0, 20, 0] } }
}
```

说明：

- `settings.params` 保存**展开后的全量参数快照**，不依赖机器库 / 材料库 / 模板的当前值。
- `machine` / `material` 是给人看和做兼容检查的快照；打开工程时以 `settings.params` 为准。
- `source.blob` 是内容寻址的源文件；`derived` 用于“简化 / 修复 / 朝向烘焙”等派生结果：

```json
"derived": {
  "type": "simplify",
  "ratio": 0.6,
  "blob": "sha256:...",
  "format": "bin-positions",
  "note": "保留 60% 三角形"
}
```

- 零件 ID 必须在工程内稳定；`state.parts` 现在用数字自增 `id`（`src/core/model.js:194`），建议给工程零件增加 `uid`，内部数字 id 只在运行时使用。保存时按数组顺序建立 `uid ↔ 运行时 id` 映射，支撑点的 `partId` 写入 `uid`。

### 3.3 支撑状态（`supports.json`）

```json
{
  "schema": "resinforge.supports",
  "schemaVersion": 1,
  "algorithmVersion": 3,
  "params": {
    "spacing": 2.5, "edgeInset": 0.5, "minSupArea": 2, "shortSup": true,
    "pen": 0.2, "esCell": 3.5, "esDiamAngle": 55, "esBarW": 0.6,
    "esBarT": 0.6, "esMidBars": true, "esGap": 1.2, "smallScale": 0.8,
    "esColRatio": 2, "esTowerMaxR": 4, "esHullRed": 0,
    "esConnW": 0.6, "esNeedleT": 0.6, "esTipW": 0.3, "esTopD": 0.3,
    "esBotD": 0.6, "tipBall": true, "esContactMargin": 0,
    "esTaper": 1.5, "esNeedleMax": 6, "esFoundH": 1, "esNotchH": 0.5,
    "baseJoin": true, "baseChamfer": false, "baseFlush": true, "baseHole": true,
    "autoPlateOn": false, "apOffset": 2, "apHeight": 1.3,
    "apBorder": 2.5, "apHoleR": 4, "apWall": 1.5,
    "apChamfer": true, "apChamferAngle": 15
  },
  "points": [
    {
      "partId": "pt_01J...",
      "x": 10.2, "y": 4.8, "z": -2.1,
      "n": [0, -1, 0],
      "ax": 10.2, "ay": 4.8, "az": -2.1,
      "manual": false,
      "island": null
    }
  ]
}
```

必须保存：

- `x/y/z`：当前接触点；
- `ax/ay/az`：布点锚点（`src/core/support.js:1289` 起每次重建从锚点出发，避免多次重建漂移）；
- `n`：被托面法线；
- `manual`：手动点，重新生成时保留；
- `island`：孤岛标记；
- `partId`：多零件归属；
- 支撑参数快照。

不保存：

- `state`（`ground/mesh/micro/unroutable` 等生成结果，重建后重新写）；
- 结构网格 `state.supports`；
- 支撑统计 `supportStats`（可保存摘要用于列表显示，但不作为恢复依据）。

打开工程后的恢复顺序：

```text
读 manifest / supports
→ 应用 params 快照（含机器 / 材料 / 底板）
→ 载入零件（源 blob 或 derived blob）
→ 恢复零件变换、保护面、可见性
→ 恢复支撑点（partId 映射到运行时 id）
→ 运行逐层分析（必要时）
→ rebuildStructure() 重建支撑
→ 恢复相机 / 当前步骤
```

分析结果是派生数据，默认不存；如果后续要做“秒开”，可以增加分析缓存，用 `模型 hash + 变换 + layerH + 关键参数` 作为键，缓存失效就重算。

### 3.4 零件库条目

```json
{
  "id": "lp_01J...",
  "name": "戒圈_01",
  "folderId": "lf_01J...",
  "tags": ["戒指", "测试"],
  "blob": "sha256:...",
  "format": "stl",
  "bytes": 5242880,
  "faces": 120000,
  "bounds": { "x": 22.4, "y": 8.1, "z": 22.4 },
  "thumbnail": "sha256:...",
  "favorite": false,
  "note": "",
  "createdAt": "2026-10-19T08:00:00.000Z",
  "lastUsedAt": "2026-10-19T09:00:00.000Z"
}
```

- `blob` 指向内容寻址存储；工程插入时建立新的 `ProjectPart`，引用同一个 blob。
- 删除库条目只减引用；blob 在没有任何引用时由 GC 清理。
- 库条目几何不可变；名称、标签、文件夹、备注可改。需要改几何时“另存为新条目”。

### 3.5 机器 / 材料档案

机器（沿用现有字段命名，避免和 core 脱节）：

```json
{
  "id": "mars4ultra",
  "brand": "Elegoo",
  "model": "Mars 4 Ultra",
  "plateX": 153.4,
  "plateY": 165,
  "plateZ": 77.8,
  "pixelUm": 18,
  "resolution": { "x": 8520, "y": 4800 },
  "type": "lcd",
  "lightNm": 405,
  "releaseFilm": "ACF",
  "builtin": true,
  "notes": ""
}
```

材料：

```json
{
  "id": "mat_std_grey",
  "brand": "Generic",
  "name": "标准树脂 灰",
  "family": "standard",
  "color": "#9aa0a6",
  "density": 1.1,
  "costPerKg": 180,
  "shrinkagePct": 0.5,
  "layerPresets": [
    { "um": 30, "exposureS": 2.0, "bottomLayers": 5, "bottomExposureS": 25 },
    { "um": 50, "exposureS": 2.5, "bottomLayers": 4, "bottomExposureS": 20 }
  ],
  "supportPreset": "fine",
  "builtin": true,
  "notes": ""
}
```

- 材料是“显示 + 默认工艺”的档案，不直接参与支撑算法；选择材料后把 `layerUm` 写入 `params.layerH`，把 `supportPreset` 写入支撑模板。
- 机器 / 材料都可以导入 / 导出 JSON，便于车间共享。
- 工程保存快照，不保存“对档案的引用”作为恢复依据。

---

## 4. 工程文件格式与存储

### 4.1 桌面端目录

```text
%APPDATA%/ResinForge/
├── store/
│   └── blobs/
│       └── 3f/3f9c...（无扩展名，内容寻址）
├── library/
│   ├── index.json          库条目数组
│   ├── folders.json        文件夹树
│   └── thumbs/<hash>.webp
├── projects/
│   ├── index.json          工程列表（可重建，作为加速索引）
│   └── <projectId>/
│       ├── manifest.json
│       ├── supports.json
│       ├── thumbnail.webp
│       └── backups/
│           ├── 2026-10-19T08-30-00.manifest.json
│           └── 2026-10-19T08-30-00.supports.json
└── profiles/
    ├── machines.json
    └── materials.json
```

- 工程目录放 manifest / supports / 缩略图；模型文件在 `store/blobs`，多个工程共享。
- `index.json` 只是索引；损坏时可以扫描 `projects/*/manifest.json` 重建。
- 原子写：先写 `*.tmp`，`fsync` / 关闭后重命名为正式文件；保留最近 3～5 份 manifest / supports 备份。

### 4.2 浏览器端

MVP 使用 IndexedDB：

```text
DB: resinforge
  stores:
    projects      key: id, value: manifest
    supports      key: projectId, value: supports
    library       key: id, value: entry
    folders       key: id, value: folder
    profiles      key: kind, value: { machines, materials }
    blobs         key: sha256, value: Blob
    thumbs        key: sha256, value: Blob
```

- 大文件后续可切 OPFS：`navigator.storage.getDirectory()` 写文件，IndexedDB 只存元数据。
- 启动时 `navigator.storage.persist()` 申请持久化；`navigator.storage.estimate()` 显示用量与预警。
- 浏览器版建议默认只保留“当前工程 + 中小零件库”，大库引导桌面版。

### 4.3 可移植工程包 `.rfproj`

标准 zip，内容：

```text
manifest.json
supports.json
thumbnail.webp
blobs/<sha256>          # 只打包本工程引用到的 blob
```

- 导出：收集 manifest 引用的 blob + supports + 缩略图，打包。
- 导入：校验 `schema` / `schemaVersion`，拒绝路径穿越（`..`、绝对路径）、限制解压总大小与文件数；解压到临时目录，确认完整后再落正式目录 / IndexedDB。
- 不加密、不混淆；需要分享时用户自己加密压缩包。

### 4.4 保存 / 打开 / 自动保存

**保存**：

1. 序列化 manifest 与 supports；
2. 确保所有引用的 blob 已写入 store（导入时已写，保存时只校验）；
3. 写 manifest / supports（原子写 + 备份）；
4. 更新 `projects/index.json`、`lastUsedAt`；
5. 清脏标记。

**自动保存**：

- 元数据 / supports 变化后 1.5～2s 防抖保存；
- 支撑点变化只写 `supports.json`（几十 KB～1MB），不重写模型；
- 导入模型 / 加入库 / 插入库时才写 blob；
- 关闭窗口时若有未落盘变更，提示保存 / 不保存 / 取消；
- 崩溃恢复：启动时如果发现 `*.tmp` 或备份比正式文件新，提示恢复。

**脏状态来源**（建议接到现有 bus）：

| 事件 | 置脏 | 失效 |
|---|---|---|
| `modelInfo`（载入 / 删除 / 变换提交） | 是 | 分析 + 支撑 |
| `sliceStats` | 是 | — |
| `supStats` / 支撑点增删 | 是 | 支撑结构 |
| 参数变更（支撑 / 底板 / 材料 / 层厚） | 是 | 视参数而定 |
| 保护面变化 | 是 | 分析 + 支撑 |
| 相机 / 当前步骤 | 可选（节流） | — |

### 4.5 版本与迁移

- `schemaVersion` 从 1 开始；每次结构变更写迁移函数。
- 打开旧工程时先迁移到内存，再另存为新版本；不原地破坏旧文件。
- `supportAlgorithmVersion` 记录生成支撑时的算法版本；版本不一致时提示“支撑将按当前算法重建”，不阻止打开。
- 备份保留最近 3～5 份，只备份 manifest / supports，不备份大 blob。

---

## 5. 零件库设计

### 5.1 页面布局

```text
┌──────────────────────────────────────────────────────────────┐
│ 零件库      [导入文件] [新建文件夹] [搜索…] [排序]            │
├──────────────┬───────────────────────────────────────────────┤
│ 全部零件      │  卡片网格（缩略图 / 名称 / 尺寸 / 面数 / 标签）  │
│ 最近使用      │  □ 卡片  □ 卡片  □ 卡片  □ 卡片               │
│ 收藏          │  □ 卡片  □ 卡片  □ 卡片  □ 卡片               │
│ ─ 文件夹 ─    │                                               │
│ 戒指          │                                               │
│ 手办          │                                               │
│ 测试          │                                               │
└──────────────┴───────────────────────────────────────────────┘
选中后底部操作条：插入工程 / 移到文件夹 / 加标签 / 导出 / 删除
```

### 5.2 操作语义

| 操作 | 行为 |
|---|---|
| 导入文件 | 支持 STL / OBJ / 3MF；多选；可按文件夹批量导入；解析后生成缩略图、面数、包围盒、哈希 |
| 从工程加入 | 当前选中的工程零件复制进库；有派生网格时保存当前显示的几何 |
| 插入工程 | 库条目复制成新的 `ProjectPart`；同一模型可以插入多次，互不影响 |
| 重命名 / 移动 / 标签 | 只改元数据 |
| 删除 | 有工程引用时提示“库条目删除后不影响已打开工程”；blob 按引用计数回收 |
| 导出原文件 | 导出库条目对应的源文件 / 派生几何 |
| 去重 | 导入时按 SHA-256 查重；可选择“使用已有条目”或“仍要导入副本” |
| 搜索 / 排序 | 名称、标签、文件夹；按最近使用 / 名称 / 大小 / 导入时间 |
| 收藏 | 智能视图“收藏” |
| 容量 | 显示总占用、单个零件大小；80% 预警；不设 50 件硬上限 |

### 5.3 内容寻址与引用计数

```text
BlobStore.put(fileOrBlob) -> sha256
BlobStore.get(sha256) -> Blob
refs(sha256) = library entries + project parts + thumbnails?
```

- 工程和库都只存 `sha256`。
- 删除库条目：先删元数据，再检查是否还有工程 / 库引用；没有才删 blob。
- 工程删除：同上。
- 简化 / 修复后的派生几何也是 blob，类型写 `bin-positions` 或重新编码 STL。
- 去重不跨格式：同一模型 STL 与 OBJ 的哈希不同，按“同格式内容相同”去重即可。

### 5.4 缩略图

- 复用 `src/core/orient.js` 的离屏渲染思路，新增 `src/project/thumbnail.js`：
  - 输入几何，按外接球取景，固定相机方向，浅灰背景；
  - 输出 512×512 WebP（或 PNG），质量 0.85；
  - 同时写 `thumbs/<hash>.webp`，库和工程共用。
- 缩略图在以下时机生成：导入库、从工程加入库、工程保存时（若没有或模型变了）。
- 失败时用占位图，不阻塞保存。

### 5.5 容量建议

- 不照搬 BPS 的 50 件上限；改为**配额 + 预警**：
  - 单文件 > 500MB：提示可能影响性能；
  - 库总占用 > 配额 80%：黄色提示；
  - 超过配额：拒绝导入并给出“删除 / 导出 / 切换桌面版”的路径。
- 桌面端配额以磁盘剩余空间为准；浏览器以 `navigator.storage.estimate()` 为准。
- 现有 core 的模型内存上限可参考 BPS 的 4096MB 量级，但建议改成“同时打开的工程零件总面数 / 总内存”预警，而不是固定文件大小。

---

## 6. 机器库与材料库设计

### 6.1 机器库

- 内置机型沿用 `src/demo/machines.js` 的 13 款（`BUILTIN_MACHINES`，`src/demo/machines.js:16`），补充 `resolution`、`type`、`lightNm`、`releaseFilm` 等可选字段。
- 自定义机型：新增 / 编辑 / 复制 / 删除 / 命名保存；校验板面、高度、像素为正数。
- 导入 / 导出：`.rfmachines.json`，便于车间共享。
- 选择机型的效果：
  - 写 `params.plateX/plateY/plateZ/pixelUm`（与现有 `selectMachine` 一致，`src/demo/machines.js:97`）；
  - 触发 `onPlateChanged()` 更新体积框；
  - 若工程已有分析 / 支撑，提示“板面变化可能影响排版与支撑”，不自动删除，由用户决定是否重新分析。
- 机器库只做参数档案，不做在线设备；等有打印功能再拆出“设备”概念。

### 6.2 材料库

- 内置材料从“通用类型”开始：标准树脂、水洗树脂、工程树脂、铸造树脂、弹性树脂；每类给一个保守的默认层厚 / 曝光 / 支撑预设。
- 自定义材料字段：名称、品牌、类型、颜色、密度、成本、收缩率、层厚预设、默认支撑预设、备注。
- 层厚预设：每个材料可以有多个 `um` 选项；选择后写 `params.layerH = um / 1000`。
- 支撑预设复用现有 `SUPPORT_TEMPLATES`（`src/core/supportTemplates.js:127`）：细 / 中细 / 中粗 / 粗；选择材料时只是给默认值，用户在支撑步骤仍可改。
- 导入 / 导出：`.rfmaterials.json`。
- 变更策略：
  - 只改名称 / 颜色 / 成本：不失效任何结果；
  - 改层厚 / 支撑预设：分析失效、支撑需重建（弹提示）；
  - 工程里已有支撑时，材料切换不自动删支撑，只标记“需重建”。

### 6.3 工艺解析

```text
MachineProfile + MaterialProfile + LayerPreset + SupportPreset
        ↓ 展开
params 快照（层厚、板面、像素、支撑参数、底板参数…）
        ↓ 写入工程
manifest.settings.params
```

- 运行时仍使用现有 `params` 单例（`src/store.js:9`），不引入第二套参数系统。
- 工程打开时用快照覆盖 `params`，再调用现有 `onPlateChanged()` / `syncModelLift()` / `runSliceAnalysis()` 等入口。
- 不建议在工程里只存 `materialId` 然后运行时查库：库更新会让老工程不可复现。

---

## 7. 支撑工程状态：保存与恢复

### 7.1 保存什么

| 数据 | 来源 | 说明 |
|---|---|---|
| 零件源文件 / 派生几何 | 新增 `sourceBlob` / `derived` | 内容寻址 blob；现有 `part.source` 只是顶点数组，不等于原始文件，不能直接拿来当工程源文件 |
| 零件变换 | `part.ox/oy/oz/q`（`src/store.js:77`） | 世界系与打印系一致 |
| 保护面 | `part.protected`（局部面索引，`src/core/model.js:194` 起） | 按零件保存；恢复时写回 `state.protectedFaces` |
| 支撑点 | `state.supportPoints`（`src/store.js:86`） | 含锚点、手动、孤岛、partId |
| 支撑参数 | `params` 中与支撑 / 底板相关键 | 全量快照更稳 |
| 底板 / 抬高 | `baseJoin`、`autoPlateOn`、`ap*`、`raiseH` | 属于工程设置 |
| 导出设置 | `unionExport` | 工程级偏好 |
| 相机 / 步骤 | 可选 | 提升“接着上次继续”的体验 |

### 7.2 不保存什么

- `state.supports`（结构网格）：重建得到，避免文件巨大且与算法版本绑定。
- `state.analysis`：默认不存；可选缓存。
- `supportStats.state`：重建后重新写。
- 自动底板网格：由参数与支撑投影重建（`ensureAutoPlateGeom`，`src/core/model.js`）。
- 视口临时状态（选中、模式、热力图开关）：可存 `step` / `camera`，其余不存。

### 7.3 恢复支撑的关键顺序

现有 `rebuildStructure()` 要求 `state.analysis` 与 `state.mesh` 存在（`src/core/support.js:1276`）。因此打开工程后：

1. 先恢复零件与变换；
2. 应用参数快照；
3. 重新跑逐层分析（`runSliceAnalysis()`）；
4. 再 `rebuildStructure()`；
5. 若支撑点为空，跳过 3～4。

界面表现：

- 打开工程先显示模型；
- 状态条显示“恢复支撑：分析中 / 重建中”；
- 完成后支撑出现；失败时保留模型并提示“支撑恢复失败，可手动重新生成”，不让工程打不开。

### 7.4 失效矩阵

| 改动 | 分析 | 支撑点 | 支撑结构 | 处理 |
|---|---|---|---|---|
| 移动 / 旋转 / 缩放零件 | 失效 | 保留但坐标需跟随 | 失效 | 当前 core 已在变换后清分析 / 支撑，按现状 |
| 更换机器（板面 / 像素） | 可能需要重跑 | 保留 | 可能需重排 / 重建 | 提示，不自动删 |
| 更换材料（仅元数据） | 否 | 保留 | 否 | 只更新工程设置 |
| 更换层厚 / 支撑预设 | 失效 | 保留 | 失效 | 提示重新分析 / 重建 |
| 改支撑参数 | 否 | 保留 | 失效 | 自动重建 |
| 增删手动支撑点 | 否 | 变 | 失效 | 自动重建 |
| 改保护面 | 失效 | 保留 | 失效 | 重新分析 + 重建 |
| 改底板类型 / 板厚 | 模型抬高变 | 保留（锚点随抬高） | 失效 | 走现有 `syncModelLift` / `rebuildStructure` |

---

## 8. 存储层设计

### 8.1 适配器接口

```js
// src/project/storage.js
export const storage = {
  kind: 'tauri' | 'browser',
  async listProjects(),
  async readProject(id),          // manifest + supports
  async writeProject(id, manifest, supports),
  async deleteProject(id),
  async listLibrary(),
  async writeLibraryEntry(entry),
  async deleteLibraryEntry(id),
  async listFolders(),
  async writeFolder(folder),
  async putBlob(blob),            // -> sha256
  async getBlob(hash),            // -> Blob
  async hasBlob(hash),
  async gcBlobs(),
  async exportPackage(id, targetPath),
  async importPackage(fileOrPath),
  async usage(),                  // 已用 / 配额
};
```

- 桌面端：`src/project/storage-tauri.js`，使用 `@tauri-apps/api/path` 的 `appDataDir()` 与 `@tauri-apps/plugin-fs`。
- 浏览器端：`src/project/storage-idb.js`，IndexedDB；后续可加 `storage-opfs.js`。
- 入口按 `'__TAURI_INTERNALS__' in window` 选择（与 `src/core/stl.js:12` 同一判定）。

### 8.2 Tauri 权限

现有 `src-tauri/capabilities/default.json` 已有 `dialog:default`、`fs:default`、`fs:allow-write-file`。新增 AppData 目录递归读写权限，例如：

```json
"fs:allow-appdata-read-recursive",
"fs:allow-appdata-write-recursive"
```

（具体权限名以 `@tauri-apps/plugin-fs` 生成的权限表为准；如果没有 appdata 专用项，使用 `fs:allow-app-*` 并在 `tauri.conf.json` 的 fs scope 中声明。）

导入外部模型时：

- 桌面版优先用 `plugin-dialog` 的 `open()` 选择文件，拿到路径后用 `plugin-fs` 的 `copyFile()` 复制到 `store/blobs/tmp`，再计算哈希 / 解析；避免把 1GB 文件整个读进 JS 内存。
- 浏览器版用 `<input type="file">` 的 `File`（本身就是 Blob），直接写 IndexedDB。

### 8.3 哈希策略

- 优先 SHA-256（WebCrypto `crypto.subtle.digest`）。
- 大文件（> 300MB）可选“大小 + 名称 + 修改时间”的快速指纹，或在工作线程里分块计算；MVP 可以先对全部文件做 SHA-256，遇到性能问题再降级。
- 哈希只用于去重与 blob 命名，不作为安全校验。

### 8.4 损坏与并发

- 单窗口、单实例；如果检测到另一个实例已打开同一工程，只读打开并提示。
- 写入前检查目标目录可写；写失败保留 tmp 文件并在下次启动提示恢复。
- `projects/index.json` 与 `library/index.json` 可重建，不作为唯一数据源。

---

## 9. 与现有代码的接入点

| 现有位置 | 现状 | 需要新增 / 调整 |
|---|---|---|
| `src/store.js:9` `params` | 全局工艺参数单例 | 增加 `projectMeta`（当前工程 id / 名称 / 脏状态）；工程打开时批量覆盖；区分环境参数与工程参数 |
| `src/store.js:74` `state` | 运行时模型 / 支撑 / 分析 | 增加 `projectId`、`dirty`、`partUid` 映射；不改 core 算法 |
| `src/demo/machines.js:16` | 13 款内置 + localStorage 自定义 | 扩展为 `machines.js` 档案 CRUD；存储迁到 IndexedDB/文件；保留 `selectMachine` 行为 |
| 新增 `src/profiles/materials.js` | 无 | 材料档案、层厚预设、支撑预设、导入导出 |
| `src/core/model.js:194` `makePart` | 数字自增 id；不保留原始文件字节（`part.source` 是顶点数组） | 增加 `uid`、`sourceBlob`、`derived`；新增 `restoreProjectParts()`；导入时把源文件交给存储层 |
| `src/core/model.js:1674` `loadModelFiles` | 读文件 → arrayBuffer → 解析 | 增加 `onSource` 回调 / `sourceBlob` 参数，避免存储层再读一遍 |
| `src/core/model.js:1703` `loadSTLBuffers` | 批量载入 | 复用为工程恢复的解析入口 |
| `src/core/support.js:1276` `rebuildStructure` | 依赖分析结果 | 不改算法；新增 `serializeSupportState()` / `restoreSupportState()` 包装 |
| `src/core/support.js:1335` `runGenSup` | 生成支撑点 + 结构 | 不改；工程恢复时直接调用 `rebuildStructure` |
| `src/core/supportTemplates.js:127` | 四档模板 | 材料 / 工艺预设直接引用 |
| `src/core/stl.js:37` `exportSTL` | 导出 STL | 不改；新增 `exportProjectPackage()` / `importProjectPackage()` |
| `src/core/orient.js` | 离屏缩略图 | 抽出通用缩略图函数供零件库使用 |
| `src/studio/StudioApp.jsx` | 单页 Studio | 增加路由（hash 或状态机）：资源库 / 向导 / Studio |
| `src/studio/ShellC.jsx` | 浮动卡片外壳 | 增加工程名 / 保存状态 / 材料 chip / 保存按钮 |
| `src/demo/components/MachinePicker.jsx` | 顶栏机型选择 | 复用，增加“管理机型…”入口；选择逻辑不变 |
| `src-tauri/capabilities/default.json` | 现有权限 | 增加 AppData 递归读写；导入外部文件所需的 scope |
| `vite.config.js` | 三入口 | 可保持；资源库与 Studio 共用 `studio.html`，用 hash 路由切换 |

### 9.1 建议的新增目录

```text
src/project/
├── schema.js         工程 / 支撑 / 库的 schema 与校验
├── migration.js      schemaVersion 迁移
├── storage.js        适配器选择
├── storage-tauri.js
├── storage-idb.js
├── package.js        .rfproj 导入导出
├── runtime.js        工程 → 运行时（params / parts / supports）与反向序列化
├── autosave.js       脏状态、防抖、关闭提示、崩溃恢复
└── thumbnail.js      缩略图

src/library/
├── store.js          库条目 / 文件夹 / 搜索 / 引用计数
├── thumbnails.js     缩略图缓存
└── import.js         批量导入 / 去重

src/profiles/
├── machines.js       机器档案（从 demo/machines 迁移）
├── materials.js      材料档案
└── process.js        机器 + 材料 + 层厚 + 支撑预设 → params 快照

src/screens/
├── HomeScreen.jsx    资源库首页（工程 / 零件 / 机器材料）
├── ProjectWizard.jsx 三步新建向导
├── PartsLibrary.jsx  零件库管理页
├── ProjectList.jsx   工程列表
├── Profiles.jsx      机器 / 材料库
└── ...
```

### 9.2 API 草图

```js
// src/project/runtime.js
export async function saveProject(projectId) {
  const manifest = serializeManifest(state, params, getProjectMeta());
  const supports = serializeSupports(state);
  await storage.writeProject(projectId, manifest, supports);
}

export async function openProject(projectId) {
  const { manifest, supports } = await storage.readProject(projectId);
  const m = migrate(manifest);
  applyParamsSnapshot(params, m.settings.params);
  await restoreProjectParts(m.parts, storage);
  restoreProtectedFaces(m.parts);
  restoreSupportPoints(supports, state);
  if (state.supportPoints.length) {
    await runSliceAnalysis();
    await rebuildStructure();
  }
  bus.emit('projectOpened', m);
}
```

关键要求：

- `serializeManifest` 不直接 `JSON.stringify` 整个 `state`（含 `BufferGeometry` / `Set` / `THREE.Quaternion`）。
- `state.protectedFaces` 是全局并集；保存按 `part.protected` 的局部索引写，恢复时按 `faceStart` 重新合并。
- 支撑点 `partId` 写 `uid`，恢复时映射回运行时数字 id。
- 打开工程失败时保持当前工程不变，错误弹窗而不是清空场景。

---

## 10. 可行性分析

### 10.1 技术可行性矩阵

| 能力 | 可行性 | 依据 | 主要风险 |
|---|---|---|---|
| 工程保存 / 打开（零件 + 变换 + 参数） | 高 | `state.parts`、`params` 已是普通数据；`loadSTLBuffers` 可复用 | 源文件需要保留 / 重新读取 |
| 支撑状态保存 / 恢复 | 高 | `supportPoints` 是普通 JSON；结构可重建 | 打开后要重跑分析，耗时数秒 |
| 多零件 partId 映射 | 中 | 现有数字 id 自增，支撑点引用数字 id | 需要 `uid` 或映射表 |
| 零件库 | 高（桌面）/ 中（浏览器） | Blob 存储、哈希去重、缩略图都可实现 | 浏览器配额、超大文件 |
| 机器库 | 高 | 现有 `machines.js` 已有 80% 结构 | 档案字段扩展、迁移旧 localStorage |
| 材料库 | 高 | 纯数据 CRUD + 现有模板 | 参数默认值需要整理 / 校验 |
| 工程列表 / 文件夹 / 搜索 | 高 | 纯前端数据 + UI | 缩略图、批量操作的交互量 |
| 自动保存 / 崩溃恢复 | 中 | 原子写、备份、脏状态都有成熟做法 | 关闭拦截、WebView 生命周期 |
| `.rfproj` 导入导出 | 高 | zip + JSON；模型 blob 已是二进制 | 路径穿越、zip 炸弹、版本迁移 |
| 云端同步 | 中（但本期不做） | 需要账号、对象存储、冲突策略 | 超出范围 |
| 多标签 / 多窗口 | 中（本期不做） | 当前单窗口；数据结构可预留 | 工程锁、未保存提示 |

### 10.2 性能与容量

- **工程元数据**：manifest 约几十 KB；支撑点 3000 点约 0.3～1MB；保存很快。
- **模型文件**：典型树脂件 20～100MB；STL 解析已在 Worker 中做（`simplify.worker.js` / `geom.worker.js`），打开工程与首次导入耗时接近。
- **缩略图**：512×512 WebP 约 20～60KB；1000 件库约 20～60MB。
- **内容去重**：同一模型被多个工程引用时只存一份；库 + 工程不会线性膨胀。
- **浏览器配额**：Chrome/Edge 通常允许数 GB，但会被清理；大库必须桌面版。
- **内存**：当前 core 会把所有零件几何同时放在内存；50 件 × 5 万面会明显吃内存。建议：
  - 打开工程时按“可见 / 选中”懒加载；
  - 或至少给出总面数 / 内存预警；
  - 大工程参考 BPS 的 4096MB 量级设上限，但不硬编码到产品文案。
- **恢复耗时**：分析 + 重建支撑在 4 个演示模型上约 1～3 秒；真实大模型可能 5～15 秒，需要进度条和可取消。

### 10.3 工作量估算

以单人、熟悉现有代码为前提：

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 数据层 | schema、序列化 / 反序列化、blob store、IDB/Tauri 适配、partId 映射 | 5～7 人日 |
| P1 工程生命周期 | 保存 / 打开 / 另存 / 删除 / 自动保存 / 关闭提示 / 恢复支撑 | 4～6 人日 |
| P2 零件库 | 库页面、文件夹、导入、去重、缩略图、插入工程、引用计数 | 5～7 人日 |
| P3 工程列表 | 卡片 / 文件夹 / 搜索 / 排序 / 星标 / 多选 / 移动 / 复制 / 导入导出 | 4～6 人日 |
| P4 机器 / 材料库 | 档案 CRUD、内置数据、向导、导入导出、迁移 | 3～5 人日 |
| P5 打磨 | 配额、错误处理、迁移、桌面权限、无头验收 | 3～5 人日 |
| **合计** | MVP～完整一期 | **24～36 人日** |

如果只做“最小可用”：工程保存 / 打开 + 零件库基础 + 机器材料选择，约 **12～16 人日**。

### 10.4 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 源文件没有保留 | 工程只能存派生几何，重开失真 | 导入时把源文件写入 blob store；简化时把派生几何另存 blob |
| 支撑点 partId 错位 | 打开工程后支撑挂错模型 | 保存 `uid`，恢复时建映射；加回归测试 |
| 参数快照不完整 | 老工程重开后支撑 / 底板不一致 | manifest 保存全量 `params`；加“保存前 diff”测试 |
| 打开工程重算太慢 | 用户以为卡死 | 进度条 + 可取消；后续加分析缓存 |
| 浏览器配额被清 | 工程丢失 | 持久化申请、导出提醒、桌面版优先 |
| 大文件读入内存 | 崩溃 / 卡顿 | Blob/磁盘流式复制；导入解析在 Worker；大文件预警 |
| zip 导入攻击 | 路径穿越 / 解压炸弹 | 校验路径、限制文件数 / 总大小、先解压到临时目录 |
| Tauri 权限不足 | 读写 AppData 失败 | 补 capabilities；启动自检并给出明确提示 |
| 旧 localStorage 机型丢失 | 用户自定义机型消失 | 首次启动迁移 `resinforge:machines.v1` → 新档案存储 |
| 工程 / 零件库概念混淆 | 用户不知道改哪边 | UI 明确“插入为副本”；库条目详情显示“被 N 个工程使用” |

### 10.5 验收标准

1. **工程往返**：新建工程 → 导入 2 个零件 → 变换 → 加保护面 → 生成支撑 → 保存 → 重启应用 → 打开工程；零件、变换、保护面、支撑点、参数、机器 / 材料、底板设置全部一致；支撑重建成功，失败 / 穿模 / 未覆盖不高于保存前。
2. **零件库**：导入 → 加标签 / 移动文件夹 → 插入工程 → 删除库条目；已打开工程不受影响；去重命中正确；导出原文件可重新导入。
3. **工程列表**：新建文件夹、拖拽移动、重命名、星标、搜索、多选删除、复制、导出 `.rfproj`、导入 `.rfproj` 往返一致。
4. **机器 / 材料**：自定义机器 / 材料保存后重启仍在；切换材料层厚后分析失效提示正确；工程快照不受库更新影响。
5. **存储**：桌面端 AppData 目录结构正确；浏览器 IndexedDB 读写正确；配额不足 / 写失败有明确提示。
6. **异常**：损坏 manifest、缺失 blob、zip 非法、支撑算法版本不一致时，应用不崩溃，给出可操作提示。

### 10.6 建议实施顺序

```text
P0 数据层（先把“能存能读”打通）
  ↓
P1 工程保存 / 打开 / 自动保存（最核心的用户价值）
  ↓
P2 零件库（复用同一套 blob / 缩略图 / 文件夹）
  ↓
P4 机器材料库 + 新建向导（依赖工程设置快照）
  ↓
P3 工程列表与文件夹（UI 量最大，可以并行）
  ↓
P5 导入导出 / 配额 / 迁移 / 验收
```

先做 P0 + P1 的原因：零件库、工程列表、机器材料最终都落在同一套 **blob + manifest + 工程设置快照** 上；这套地基不稳，后面的 UI 都会返工。

---

## 11. 附：与 BPS 的取舍对照

| BPS 做法 | 我们的取舍 | 原因 |
|---|---|---|
| 五级级联向导 | 三步 + 高级折叠 | 降低新建成本 |
| 工程目录 + 多个 `.bpsc` | 目录 + `manifest.json` + `supports.json` + 内容寻址 blob | 明文、可修、局部写 |
| 私有加密格式 | 标准 zip / JSON | 可迁移、可脚本化 |
| 支撑参数化 + 文件型两套 | 只做参数化 | 现有算法是确定性的，重建即可 |
| 零件库 50 件 | 配额制 | 不把产品限制当技术限制 |
| 零件库藏在左侧栏 | 独立页面 + 插入模态 | 库大了需要搜索 / 标签 / 详情 |
| 云端工程 20 个 | 本地优先，云同步后置 | 无需账号即可用 |
| 工作区 / 切片库两套文件管理 | 统一“工程”入口 | 减少概念重复 |
| 配置引用材料 / 机器 ID | 保存展开后的参数快照 | 老工程可复现 |

---

## 12. 一句话总结

**BPS 的核心可复用资产是“工程目录 + 配置快照 + 支撑数据独立 + 零件副本库”这套结构；ResinForge 已经有支撑算法和运行时状态，缺的只是外面这层资源与工程管理。先做存储与工程往返，再做零件库和机器材料库，整体在现有架构上可行，桌面版优先。**

---

## 13. 需要确认的四个产品决策

1. **浏览器端要做到什么程度？**
   建议：桌面版完整零件库；浏览器版保证单工程 + 中小零件库（配额提示），大库引导桌面版。
2. **零件库规模预期？**
   如果会直接接管现有 2750 个 / 97GB 的零件库，桌面端需要做缩略图队列、批量导入、按文件夹扫描与断点续跑；浏览器端不适合。
3. **材料数据从哪里来？**
   MVP 用通用材料档案 + 四档支撑预设；后续是否要导入黑格 `.pp` 工艺包参数（外部逆向工作区已有解析工具）需要再确认授权与产品边界。
4. **是否需要在线打印 / 设备管理？**
   本期建议不做；如果近期要做，机器档案与“在线设备”应从一开始就分成两个实体，避免后期拆表。

---

## 14. Demo 入口与三套方案

开发服务器启动后打开：

```text
http://127.0.0.1:8123/library.html
```

右上角「方案 A / B / C」实时切换，三套共用同一份数据与交互：

| 方案 | 定位 | 主要特点 |
|---|---|---|
| A · 文件管理器 | 最接近 BPS 的工程库 | 左侧文件夹树 + 卡片网格 + 右侧检查器；适合作日常主界面 |
| B · 工作台 | 最近工程优先 | 大标题工作台、继续上次、快捷操作、零件货架；适合个人 / 小团队 |
| C · 专业库 | 高密度管理 | 图标栏 + 列表行 + 检查器；适合零件多、需要快速扫读 |

Demo 交互包括：切换工程 / 零件库 / 机器材料、文件夹筛选、搜索、卡片选中、新建工程三步向导、零件库插入、工程复制 / 导出提示。数据是本地演示数据，不写入工程文件。

对应源码：

```text
library.html
src/library-demo/main.jsx
src/library-demo/LibraryDemo.jsx
src/library-demo/candidates.jsx
src/library-demo/ui.jsx
src/library-demo/data.js
src/library-demo/models.js
src/library-demo/thumbs.js
src/library-demo/library-demo.css
```


