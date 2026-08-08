# DESIGN.md — 《小店经营者》设计系统

> 视觉的唯一权威。UI（`css/style.css`、`js/ui.js`）与 3D（`js/world.js`、`js/customers.js`）都必须遵守。
> 风格关键词：**扁平、低多边形、明亮日光、暗色半透明 HUD**。不用渐变、不用图片素材、不用外部字体。

## 1. 色板

### 1.1 UI（暗色面板浮在明亮 3D 场景上）
| 用途 | 变量 | Hex |
|---|---|---|
| 面板底 | `--panel` | `#1B2028`（面板背景用 `rgba(27,32,40,.94)`） |
| 面板次层 / 列表行 | `--panel-2` | `#232A34` |
| 分隔线 / 边框 | `--line` | `#2E3742` |
| 主文字 | `--text` | `#E8ECF1` |
| 次文字 / 说明 | `--text-dim` | `#97A2B0` |
| 主强调（金钱、确认、净利为正） | `--accent` | `#4CC38A` |
| 次强调（信息、选中标签、链接） | `--accent-2` | `#4C9BE8` |
| 警告（价格偏高、库存低） | `--warn` | `#E8B54C` |
| 危险（亏损、拒绝、扣钱） | `--danger` | `#E8574C` |
| 交互高亮（hover / 准星命中） | `--hl` | `#FFD666` |
| 遮罩（全屏界面背景） | `--scrim` | `rgba(10,13,17,.62)` |

### 1.2 商品类目色（UI 色块与 3D 商品都用）
| 类目 | Hex |
|---|---|
| 食品 | `#E8A33D` |
| 饮料 | `#3D8FE8` |
| 生鲜 | `#4CB963` |
| 日用品 | `#9B6FE0` |
单品在类目色系内做明度变化，具体每项 hex 见 `docs/GDD.md` 商品表的 `color` 列。

### 1.3 3D 世界
本表为 lowfx 纯色回退值；正常态观感由 §5.4 程序化纹理主色覆盖（如地板木纹 #C9B48E、墙裙 #8C7A62、踢脚 #4E4238、冷藏柜框 #C2CDD4）。
| 物体 | Hex |
|---|---|
| 背景 / 天空（`scene.background`） | `#AECBE0` |
| 地板 | `#D8D2C6` |
| 墙面 | `#EFE9DE` |
| 天花板 | `#F5F2EC` |
| 货架框架 | `#8C9AA6` |
| 冷藏柜（半透明玻璃面 opacity .35） | `#BFE3EC` |
| 收银台 / 传送带 | `#6E7A88` / `#4E5866` |
| 纸箱（满） / 空箱 | `#C08B4E` / `#8A6538` |
| 仓储电脑机身 / 屏幕 | `#3A424C` / `#4C9BE8` |
| 垃圾桶 | `#5A6B5E` |
| 门框 / 卸货区地面 | `#7A6A55` / `#C7BEAF` |
| 顾客随机色板 | `#E8574C` `#4C9BE8` `#4CC38A` `#E8B54C` `#9B6FE0` `#E88AB0` `#F0F0F0` `#5A6B7A` |
| 顾客裤装色板 | `#3A424C` `#4E5866` `#5A6B7A` `#6E5A48` `#2E3742` |
| 顾客肤色色板 | `#F0C9A0` `#D9A878` `#C08B4E` `#8A5A3B` |
| 顾客发色色板 | `#2A2118` `#4A3524` `#6E5A48` `#A8A29A` |
| 顾客鞋色 | `#2E3742` |

## 2. 字体
```css
font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC",
             "Hiragino Sans GB", "Heiti SC", sans-serif;
```
- 所有数字容器加 `font-variant-numeric: tabular-nums;`（金额、时钟、库存不跳动）。
- 字号：HUD 数值 **18px/600**；面板标题 **20px/600**；正文与列表 **14px/400**；次说明 **12px/400**；按钮 **14px/500**；日结算「净利」**28px/700**。
- 行高统一 1.5。禁止斜体。中文不使用字母间距（`letter-spacing: 0`），纯数字标题可用 `.5px`。

## 3. HUD 布局（固定 DOM id，`position: fixed`，`pointer-events: none`）
```
┌──────────────────────────────────────────────────────────┐
│ #hud-money 左上 16/16      #hud-day + #hud-clock 顶部居中  #hud-level 右上 16/16 │
│                                                          │
│                        #crosshair 正中                    │
│                 #charge 准星下方 28px（蓄力时可见）        │
│                                                          │
│                   #prompt 底部居中（距底 96px）            │
│                                    #toast 右下 16/16 竖向堆叠 │
└──────────────────────────────────────────────────────────┘
```
- `#hud-money`：`¥ 1,234.5`，主强调色；金额变化时数字闪一次（`--accent` 增 / `--danger` 减，180ms）。
- `#hud-day` / `#hud-clock`：`第 3 天` + `14:25`，同一胶囊内，`--text` / `--text-dim`。备货阶段时钟位显示 `准备中`。
- `#hud-level`：`Lv 4` + 下方 120×4px XP 进度条（底 `--line`，填充 `--accent-2`，圆角 2px）。
- `#crosshair`：8×8px 圆点，`#FFFFFF` 60% 不透明 + 1px `rgba(0,0,0,.5)` 描边；命中可交互物时变 `--hl` 并放大到 12px（120ms）。
- `#charge`：蓄力力度条，`#crosshair` 正下方 28px 居中，120×4px，`radius 2px`；底 `--line`，填充 `--accent-2`（与 `#hud-level` 的 XP 条同规格，不引入新视觉语言）。持箱按住右键蓄力时显示，填充宽度 = `charge × 120px`；松开 / 取消后 `display: none`。`pointer-events: none`。
- `#prompt`：胶囊，`rgba(27,32,40,.88)`，`padding 8px 14px`，`radius 999px`，14px `--text`。按键名用 `<kbd>`：`--panel-2` 底、`--hl` 字、`radius 4px`、`padding 1px 6px`。无内容时 `display:none`。
- `#toast`：宽 260px，`radius 8px`，左侧 3px 状态条（成功 `--accent` / 警告 `--warn` / 失败 `--danger`），淡入 120ms、停留 2.5s、淡出 300ms，最多同时 3 条。

## 4. UI 组件样式
- **面板 / 全屏界面**：`background: rgba(27,32,40,.94)`；`border: 1px solid var(--line)`；`border-radius: 12px`；`box-shadow: 0 8px 32px rgba(0,0,0,.45)`；内边距 24px。全屏界面外覆 `--scrim`，容器 `max-width: 880px`，居中，`max-height: 82vh` 内部滚动。
- **标签页**（电脑三标签）：横排文字按钮，未选中 `--text-dim`，选中 `--text` + 底部 2px `--accent-2` 下划线，无背景填充。
- **按钮**：`radius 6px`；`padding 8px 16px`；无边框；`transition: 120ms`。
  - 主要：底 `--accent`，字 `#0F1A14`；hover 亮度 +8%；active 下移 1px。
  - 次要：底 `--panel-2`，字 `--text`，`1px solid var(--line)`；hover 边框变 `--accent-2`。
  - 危险：底 `--danger`，字 `#FFF`。
  - 禁用：`opacity .4`，`cursor: not-allowed`，无 hover 效果。
- **列表行**：高 44px，隔行底色 `--panel-2`，hover 整行底色 `rgba(76,155,232,.12)`；行首 14×14px 类目色圆角方块（`radius 3px`）作为商品图标。
- **数字输入**：底 `--panel-2`，`1px solid var(--line)`，`radius 6px`，右对齐，聚焦时边框 `--accent-2`。左右配 `−/+` 次要按钮。
- **倍率标签**（定价页）：小胶囊，`≤1.10` 绿 `--accent`，`≤1.40` 黄 `--warn`，`>1.40` 红 `--danger`，字色统一 `#12161B`。
- **POS 面板**：右侧固定宽 340px，贴屏幕右缘，上方为已扫列表，下方大号总额（24px/700 `--accent`），找零按钮为 4×2 网格次要按钮。
- **日结算**：三行明细（营业额 / 成本 / 支出）用 `--text-dim` 标签 + 右对齐数字，分隔线后大号净利，正数 `--accent`、负数 `--danger`。
- 圆角只用 `4 / 6 / 8 / 12 / 999px` 五档；间距只用 `4 / 8 / 12 / 16 / 24 / 32px`。

## 5. 3D 美术方向

### 5.1 风格总纲
程序化纹理暖色写意：保留现有低多边形骨架，表面纹理全部由 `CanvasTexture` 运行时生成（零外部图片/素材、零网络请求），开启 `PCFSoftShadowMap` 软阴影。暖色感来源 = 纹理像素值 + `HemisphereLight` 地面反弹色（**不**依赖色彩管线，见 §5.3）。硬约束继承项目基线：Three.js r128 UMD、无构建、ES5、IIFE + `window.G`、file:// 即玩。

### 5.2 几何白名单
只用 `BoxGeometry` / `CylinderGeometry` / `PlaneGeometry` / `LatheGeometry` / `IcosahedronGeometry` / `EdgesGeometry`。r128 仍**无 `CapsuleGeometry`**、无 `RoundedBoxGeometry`，顾客与商品一律用上述几何拼接或车削。禁止外部图片素材与法线贴图。

### 5.3 材质与色彩管线
- 统一 `MeshLambertMaterial`，`flatShading: true`，无金属/粗糙度参数。半透明用于冷藏柜玻璃（`transparent, opacity .35`）与货架格命中盒（`transparent, opacity 0`，纯交互用，`visible=false`）。
- 允许材质挂 `map`（`CanvasTexture`），由材质 `color` 与贴图像素值相乘染色（传送带、纸箱、商品标签均用此机制）。
- 【条款】不开 outputEncoding=sRGBEncoding、不开 toneMapping——DOM HUD 不经 3D 管线，开启会让 §1.1 UI 色板与 3D 观感分家；§1.3 全部 hex 均按线性输出标定。

### 5.4 程序化纹理规范
新模块 `js/textures.js`（IIFE + `window.G.tex`），script 顺序插在 `state.js` 之后、`world.js` 之前。

`G.tex.on`：模块加载时读一次 `localStorage['gss-lowfx'] !== '1'`。每个生成器在 `!on` 时直接返回 `null`，调用方 `map:null` 天然退化纯色；lowfx 路径与升级前构建视觉等价（货架材质已合并共享，行为一致）。生成器签名统一为 `G.tex.xxx(repeatX, repeatY, ...内容参数)`。`labelBand(shape, accent)` 为唯一例外：repeat 恒 (1,1)，内容参数即缓存键。

【条款】纹理双层缓存：canvas 按 (生成器, 内容参数) 缓存；CanvasTexture 按 (生成器, 内容参数, repeatX, repeatY) 缓存。调用方严禁改动返回纹理的 repeat/wrapS/wrapT。

- 像素源层：`canvas` 按 (生成器名, 内容参数) 缓存（如 `labelBand` 的 (shape, accent)）——昂贵的 2D 绘制只发生一次。
- 纹理实例层：`CanvasTexture` 按 (生成器名, 内容参数, repeatX, repeatY) 缓存——repeat 与 wrap 是缓存键的一部分。相同 repeat 的表面共享同一 Texture；不同 repeat 的表面必须得到不同的 Texture 实例（共享底层 canvas，GPU 各自上传一份，256² 级别开销可忽略）。

生成器清单：

| 生成器 | 用途 | 分辨率 | 贴片 | repeat |
|---|---|---|---|---|
| `floorWood()` | 地板 32×20 | 512² | 2m | (16, 10) |
| `yardConcrete()` | 卸货区（东 4×8 / 西 4×7） | 256² | 1.75m | (2, 4) / (2, 3.5) |
| `wallWainscot()` | 13 段墙（含腔裙板+踢脚线，画在纹理下部） | 256×512 | 2m 横向 | (L/2, 1) |
| `ceilingPanel()` | 天花板矿棉格 32×20 | 256² | 1.2m | (26.7, 16.7) |
| `shelfMetal()` | 货架框/背板/层板拉丝；另供卷帘门 (2,3) 与仓库存储位标记 (1,1) | 256² | 0.5m | (4, 4) |
| `fridgeSteel()` | 冷藏柜框 | 256² | 0.5m | (4, 4) |
| `counterLaminate()` | 收银台柜体 | 256² | 1m | (1.2, 2) |
| `beltRubber()` | 传送带橡胶（近灰度，靠材质色相乘） | 256² | 0.3m | (3, 5) |
| `cardboard()` | 纸箱瓦楞（近灰度） | 256² | 0.45m | (1, 1) |
| `labelBand(shape, accent)` | 商品标签环带，按 (shape,accent) 缓存 | 64² | — | (1, 1) |

表中 repeat 为**实际生产调用值**（C-T8 逐调用点实读；`floorWood(8,6)` 只出现在自测里，不是生产值）。墙体一律由 `wallAlongX/Z` 按各自段长传 `L/2`（如南北外墙段长 32.4m → 16.2，东墙北段 4.0m → 2.0）。全部 POT + `RepeatWrapping` + 默认 mipmap（WebGL1 合法）。anisotropy 只给 `floorWood`/`yardConcrete`：`Math.min(4, renderer ? renderer.capabilities.getMaxAnisotropy() : 1)`——必须判 `renderer` null（无头环境为 null）。UV 不改：Box 大面 U 沿长度、V 沿高度，`repeat.set(n,1)` 使腔裙板贴底、横向平铺；Plane 同理。生成总耗时预算 < 20ms（一次性，启动时）。

红线：
- 【红线】传送带材质 .color 恒为 #4E5866（视觉契约：收银台台面在全店配色里的唯一识别色，玩家一眼认得出放货位置；C-T3 起 checkout 已改经 `registers[i].beltMesh` 定位，色值不再兼任功能锚点）；橡胶纹理做成近灰度靠材质色相乘。
- 【红线】纸箱材质保持 color.set() 语义（updateBoxVisual 靠改色切换满/空）；瓦楞纹理近灰度。

### 5.5 灯光与阴影
三灯（`main.js` 建立）：
- `HemisphereLight(0xAECBE0 /*天*/, 0xC7BEAF /*地*/, 0.55)`——阴影区的暖色反弹，暖色风的主要来源
- `AmbientLight(0xFFFFFF, 0.12)`——保底不死黑
- `DirectionalLight(0xFFF6E5, 0.85)` @ `(8,14,6)`，`castShadow = true`（唯一投影灯）

阴影参数（**C-T8 实测回写**，值取自 `main.js buildScene()` 实读 + 全开态 collider 实测）：世界 AABB x∈[-20.4, 20.4]、z∈[-10.2, 10.7]（全开态 40 个 collider 的并集：32×20 主壳 + 东西两院围栏），y∈[0, `WALL_H` 3.6] → shadow camera：`ortho ±26`、`near 0.5`、`far 60`；`mapSize 4096²`（≈1.27cm/texel，52m/4096——与 B 期 26m/2048 同精度）；`bias -0.0004`、`normalBias 0.03`（flatShading Box 用 normalBias 防痤疮不产生 peter-panning）；`renderer.shadowMap.type = PCFSoftShadowMap`。断言 `shadow.frustumCovers` 逐 collider 取 8 角点验证全部落在该视锥内，采样高度 y ∈ [0, `WALL_H`]（**C-终审订正**：原为字面量 3，是 WALL_H=3.0 时代的残留，墙顶 3.0-3.6 段从未被验证过；现改读 `G.world.WALL_H`）。

**【near 余量】阴影视锥的真实瓶颈是 `near` 而不是 ±26 正交框。**实测（全开态 40 个 collider × 8 角点，取六个面的最小余量）：`near=1` + y→3.0 余量 0.72m、y→3.6 仅 **0.23m**、y→4.0 直接 FAIL；最紧角点恒为东院围栏东北角 (20.4, WALL_H, 10.2)。C-终审将 `near` 1→**0.5**，余量回到 **0.73m**（断言 detail 自带实测值与最紧角点）。【警告】东院方向任何抬高的物件（更高围栏、货车、招牌、雨棚）会**静默掉出阴影视锥**，表现为影子突然消失而非报错——动东院几何前先看这条断言的余量。

cast / receive 矩阵：

| 物体 | cast | receive | 理由 |
|---|---|---|---|
| 地板 / 卸货区 | ✗ | ✓ | |
| 墙 / 天花板 / 门框柱 | ✗ | ✓ | 无窗室内，壳体投影=全店漆黑；headless 自测看不出来，必须先写断言再动灯 |
| 货架框/层板/背板 | ✓ | ✓ | 层板投在下层，空间感主力 |
| 价签 / 命中盒 | ✗ | ✗ | |
| 商品 InstancedMesh | ✗ | ✗ | 0.16m 商品阴影可解但价值低：省 ≤24 组深度 draw，接触暗部由层板投影代偿 |
| 顾客（躯干/头/腿） | ✓ | ✗ | 移动阴影是"活着"的最强信号；发型/臂/鞋不 cast 省一半 |
| 纸箱/收银台/传送带/电脑/垃圾桶 | ✓ | ✓ | |
| 收银员 | ✓ | ✗ | 站桩体型同顾客规格，cast only（不接，代码与顾客一致） |

【红线】墙与天花板 castShadow 恒为 false（无窗室内，壳体投影 = 全店漆黑，headless 自测无法发现，只能靠断言 shadow.shellNoCast 防守）。

阴影 pass **237** 个深度 draw（**C-终审清场后满配实测**，与 §5.8 的 702 同一场景同一次运行；口径 = 全场 `castShadow===true` 且自身与全部祖先 `visible!==false` 的 Mesh）：

| cast 分项 | 深度 draw | 算式 |
|---|---:|---|
| 货架层板 | 40 | 20 组 × 2 层 |
| 货架背板 | 20 | 20 组 × 1 |
| 货架侧板 | 40 | 20 组 × 2（右侧板走 `sideGeo.clone()`，r128 下类型退化为 `BufferGeometry`） |
| 纸箱箱体 | 36 | 36 只箱 × 1（仓库 24 + 卸货 12；`0.45³`，类目色标签面片不投影） |
| 顾客 + 收银员 | 92 | 23 人 × 4（2 腿 + 躯干 + 头；发型/臂/鞋不 cast） |
| 收银台 + 传送带 | 6 | 3 台 × 2 |
| 仓储电脑机身/屏幕 + 垃圾桶身 | 3 | 桶盖不 cast |
| **合计** | **237** | |

不投影者：冷藏柜玻璃、价签、命中盒（`visible=false`）、InstancedMesh 商品、顾客发型/臂/鞋、箱标签面片、存储位地面标记、壳体（红线）、卷帘门（全开后 `visible=false`）。

总提交 **939** = 702 主渲染 + 237 阴影深度（断言 perf.renderCalls 实读 renderer.info.render.calls，见 §5.8 的两个口径表）。lowfx：`shadowMap.enabled=false` 一个布尔，阴影 pass 归零。

**D 期起闸门场景加 12 只散落箱**（§5.8 已改为 726/760）；散落箱箱体同样 `castShadow=true`（`world.js:1244`），本节的 237/939 尚未把它们计入，待 D-T7 实测回写（不在此处预填推算值）。

### 5.6 商品表现
八套共享几何（单件 ≤112 三角（jug 上限）；XZ 包络 ≤0.165m（断言值；tray 0.175 躺放例外））：

| key | 品类 | 几何 | 尺寸 | 三角 |
|---|---|---|---|---|
| `bottle` | 饮料 | Lathe(7点, 8段) | ⌀0.075×0.22 | 96 |
| `can` | 饮料 | Cylinder(8) | ⌀0.072×0.13 | 32 |
| `carton` | 食品/日用 | Box | 0.14×0.20×0.07 | 12 |
| `bag` | 食品/日用 | Cylinder(6) 收口 | ⌀0.16×0.20 | 24 |
| `tub` | 日用/罐头 | Cylinder(10) | ⌀0.12×0.16 | 40 |
| `jug` | 日用 | Lathe(8点带颈, 8段) | ⌀0.09×0.21 | 112 |
| `tray` | 生鲜 | Box | 0.17×0.06×0.12 | 12 |
| `produce` | 生鲜 | Icosahedron(0) | ⌀0.11 | 20 |

tray 0.17 宽为唯一例外——躺放不与列距冲突（高度仅 0.06）。三角量为解析预算（900×112≈10.1 万），无独立断言；实例分组由 world.js 内部共享几何缓存（baseGeos()/BASE_GEOS，≤8 套）守护，一个 draw call 内，零压力。

数据：`data.js` PRODUCTS 加三列：`shape`（八键之一）、`scale`（可省，默认 [1,1,1]）、`accent`（标签强调色，省略时回退 color，当前 24 商品均显式给值）。`color` 列已是先例，单一真相源；避免 world.js 再养一张平行映射表。

标签：64² `labelBand(shape, accent)`：一条浅色横带 + 2-3 个深色抽象"字"块，按 (shape, accent) 缓存，挂 per-pid 材质 `map`，由材质 `color` 相乘染色。Cylinder/Lathe 的 u 绕轴、v 沿高，横带天然水平；Box 每面 0..1 同理。

【条款】价签不实例化（每格贴图独立 + 准星高亮载体必须逐格材质）；商品标签不加独立 mesh（labelBand 贴图烘进 per-pid 材质）。

**纸箱**：`0.45³` 立方体，正面贴一块商品类目色的小面片（`0.2×0.12` Plane，前移 0.001）作为「标签」，一眼看出装的是什么。

### 5.7 顾客构造
9 部件（几何初始化时 translate 到枢轴，不加 Group）：

| 部件 | 几何 | 尺寸 | y | 材质槽 |
|---|---|---|---|---|
| 鞋×2 | Box | 0.16×0.08×0.22 | 0.04 | shoe |
| 腿×2 | Box(translate 到髋) | 0.15×0.64×0.17 | 枢轴 0.72 | pants |
| 躯干 | Box | 0.44×0.68×0.26 | 1.06 | shirt |
| 臂×2 | Box(translate 到肩) | 0.11×0.58×0.13 | 枢轴 1.34, x±(0.22w+0.07) | shirt |
| 头 | Box | 0.26³ | 1.53 | skin |
| 发型 | 4 款共享几何（短块/后长/平顶/蓬顶） | ~0.29×0.11×0.29 | 1.70 | hair |

随机：身高 h∈[0.90,1.08]（group.scale.y）；胖瘦 w∈[0.88,1.22] 只作用躯干（scale.set(w, 1, w×0.9)——z 向 0.9 收窄防止过厚）+ 腿距 ±0.115w。存 `c.dims={h,w}`。头顶（含发型）y ∈ [1.56, 1.91]（h∈[0.90,1.08]）。

色板见 §1.3「顾客裤装色板」「顾客肤色色板」「顾客发色色板」「顾客鞋色」；衣色沿用现有 8 色「顾客随机色板」。材质走模块级缓存，总数 ≤22。

步态（`applyGait(c, dt, moving)`，`customers.js` 内唯一写入点）：
- `c.phase += dt × customerSpeed × 3.4`（步频 ~0.87Hz）
- 腿 `sin(phase)×0.44`（±25.2°）反相；臂 `−sin(phase)×0.30` 反相；鞋随腿。
- 浮沉：躯干/头/发 各自 baseY − `0.03×|sin(phase)|×amp`（下沉式，物理正确相位）。**根节点 y 恒 0**——浮沉只动部件，导航/队列判定/未来物理不受扰动。
- 静止：角度按 `k=min(1,dt×8)` 衰减归零，禁止冻在半步。
- 结构约束：物理接管钩子 `applyGait` 开头 `if (c.ragdoll) return;`（D-T4 起由 `stepKnockdown` 写入 `c.ragdoll`）；不缓存世界矩阵；`c.dims` 可推 AABB。不加 `motionMode`/`velocity` 等专用字段。

**被砸倒地姿态**（D-T4，纯视觉；判定阈值与冻结范围见 spec §7，此处只定表现）：
- 顾客不参与物理，倒地是根节点的一条单轴旋转：`mesh.rotation.x` 在 `±π/2` 之间插值，**枢轴就是根节点（脚下 y=0）**，绕脚踝倒下，本节「根节点 y 恒 0」不破——倒地全程不写 `mesh.position`。
- `mesh.rotation.order` 必须是 `'YXZ'`（`buildBody` 建组时即设）：默认 XYZ 下 `rotation.x` 绕的是**世界** X 轴，顾客朝 ±z 时会歪着倒；YXZ 下绕的才是「朝向之后的自身左右轴」。`rotation.x === 0` 时两种 order 完全等价，对站桩/行走零影响。
- 方向：存 `c.ragdollDir`（`+1` / `−1`），触发当帧按「箱速 · 顾客正前方」的正负定死、倒地期间不再改——从背后砸来 → 前扑 `+π/2`（脸朝下）；否则后仰 `−π/2`。方向一旦锁定，连击也不会让顾客在两个姿态间来回翻。
- 时序（单变量 `c.ragdollT`，线性无缓动，与积木风的硬转折一致）：0→0.25s 倒下，0.25→2.50s 躺平，2.50→2.85s 爬起，≥2.85s 归零复位。倒地中再次被砸不重播倒下动作，只把躺平计时拉回 0.25s。
- 手持商品**跟随根节点一起转、不散落**（`hands` 始终挂在 `mesh` 下）：商品不参与物理，满地滚的碎件既无回收路径也会撑爆实例池。

**收银员站桩**：`buildFigure` 固定参数——衣 `#4C9BE8`（契约）/裤 `#2E3742`/肤 `#D9A878`/发 `#2A2118` 短块/h=w=1.0；无步态（站桩）。

### 5.8 性能契约
InstancedMesh 商品实例池：按商品 pid 分组，每个上架中的商品一个 `InstancedMesh(baseGeo[shape], matForProduct(pid), capacity)`，全店 ≤24 个，惰性创建；容量 64 起，溢出 ×2 重建换入；`instanceMatrix.setUsage(THREE.DynamicDrawUsage)`；`mesh.count` 只画有效数；每格最多渲染 `min(count,16)` 件。

- 【禁令】实例颜色一律走 per-pid 材质，不使用 instanceColor/setColorAt——不是能力缺失（本构建支持），而是架构必然：每个商品的 labelBand 贴图不同，材质本就必须 per-pid，instanceColor 只能合并同 (shape,accent) 组、收益不抵复杂度。
- 【禁令】InstancedMesh 必须 frustumCulled = false（r128 无 computeBoundingSphere，默认视锥剔除按原点包围球计算，会导致整组商品消失）。
**两个口径必须分清**（C-终审订正：断言名此前叫 `drawCallCeiling`，数的却是可见对象数，与本节自己写的「总提交 951」对不上）：

| 口径 | 是什么 | 天花板 | 断言 |
|---|---|---:|---|
| **主 pass 可见对象数** | 自身与全部祖先 `visible !== false` 的 Mesh/InstancedMesh 个数（不含视锥剔除，不含阴影 pass） | **760**（spec §8 原意） | `perf.mainPassDrawables` |
| 阴影 pass 深度提交 | `castShadow === true` 且可见者，每帧一次深度绘制 | 无独立闸门，含在下一行 | — |
| **一帧真实 draw call 总提交** | `renderer.info.render.calls`（主 pass + 阴影 pass，已扣视锥剔除） | **1050** = 760 + 阴影余量 290 | `perf.renderCalls` |

- 读 `renderer.info.render.calls` 有个坑：r128 的 `render()` 在 `shadowMap.render()` **之后**才 `info.reset()`，默认 `autoReset` 下读到的只有主 pass。断言里关掉 `autoReset` 自行 `reset()` 才拿得到总提交。
- 总提交是机位相关的（视锥剔除）：断言前把相机摆到 `(0,34,34)` 俯视全场，否则贴脸看墙能测出只有一两百次，数字不代表负载。
- 【闸门场景纪律】`perf.mainPassDrawables` 必须用**轮转灌店**（外层轮次、内层遍历 24 个商品，每轮每个商品各上一格），不得顺序灌店。理由：顺序灌店会把同一商品灌满一格才换下一个，全店 120 格只需 2-3 个 pid 就填满，实例池只建 2 组，测出来的 draw call 比真实游玩低 20 余个——池上限 ≤24 这条约束根本没被求值。轮转灌店才能逼出 24 组池全开的最坏形态（C-T7 实测：轮转 24 组 / 顺序 2 组）。

draw call 账（大卖场扩张 Lv10 满配，绝对最坏负载，spec `2026-08-02-大卖场扩张-design.md` §8）。**下表为 C-T8 实测值**（`perf.drawCallCeiling` 断言现场逐类普查，非估算）：

| 分项 | draw call | 算式 / 说明 |
|---|---:|---|
| 价签 | 120 | 120 格 × 1；每格独立 Material（准星高亮载体） |
| 命中盒 | **0** | 120 个 `visible=false`，渲染器整体跳过（不占 draw call） |
| 货架框 | 104 | 20 组 ×（1 背板 + 2 侧板 + 2 层板）= 100，+ 4 台冷藏柜玻璃面 |
| 实例池 | 24 | 上架中的商品每 pid 一个 InstancedMesh；满配恰好触顶 ≤24 |
| 壳体 | 21 | `userData.shell` 打标者（地板/天花板/**13 段墙**/门柱/院地面…；墙段数与 §5.4 一致：外墙 6 + 内隔墙 7，C-终审订正原「12 墙」） |
| 卷帘门 | **0** | 3 扇（非 4）；全开后 `visible=false`，未开时各 1 |
| 收银台 | 6 | 3 台 ×（柜体 + 传送带） |
| 设施 | **4** | 仓储电脑机身 + 屏幕 + 垃圾桶身 + 桶盖 |
| 存储位标记 | **24** | 24 个 `0.6×0.02×0.6` 地面标记，各 1 draw（材质必须逐个独立） |
| 仓库箱 | 48 | 24 箱 ×（箱体 + 类目色标签面片） |
| 卸货箱 | 24 | 12 箱 × 2 |
| 收银员站桩 | 27 | 3 人 × 9 部件 |
| 顾客 | 180 | 20 人 × 9 部件 |
| 顾客手持（上限 6/人） | 120 | 20 × 6 |
| 散落地面箱 | 24 | `BOX_HARD_CAP` 48 − 仓库 24 − 卸货 12 = 最多 12 只 × 2 mesh（D 期投掷落地箱） |
| **理论满配合计** | **726** | 含 D 期 12 只散落地面箱（702 + 24） |
| 自测现场实测 | 726（D-T7 待实测） | 本行当前是预写值，非实测；D-T7 起闸门场景在满配基础上再放 12 只散落地面箱后测量并回填 |

**总闸门 550→760**，余量 **34**（D 期把 12 只散落地面箱纳入闸门场景后，余量从 58 收窄到 34）。

**纸箱总数硬上限 48**（GDD §3）：`spawnBox` 起手校验全场箱实体总数，达上限拒绝生成。地面囤箱是本表唯一的无界项——箱进场受卸货区 12 位判据约束，但按 Q 放到地上后脱离一切计数、跨天不清、每只 2 draw call，无此上限时可无限循环囤积并越过 760。断言 `world.boxHardCap`。

- **【订正】「存储架 10」是 C-T4 前按「两条金属横梁」结构做的预算，与实现不符。** T4 按 YAGNI 只建了 24 个地面位标记、未建横梁，实际行项为 **24**。横梁属未实现的美术意图，若 D 期补建，须按 +draw call 重估该行项与 760 闸门。
- 「卷帘门 4」「设施 3」同为 T0 预写估值，实测分别为 3 与 4。
- `addHandCube` 视觉上限 6/人（逻辑 `c.items` 完整，仅渲染截断）。
- 价签图集**本期不做**（预案留档：每 rack 6 格图集 + 单一全局高亮框，120→21；帧率实测不达标才启用）。
- TAG_TEX 治漏：**C-T7 起**缓存键改为 `pid|state`（价格不入键，改价 dispose 重建），理论上界 **49**（`empty|-` 1 + 24 pid × `stocked`/`out` 各一）——断言 `world.tagTexNoLeak` 已按此收紧，实测 5。
- 阴影深度 pass **237**、一帧总提交 **939**（C-终审实测，清场后的干净满配；C-T8 的 241/951 是含 4 只残留地面箱的旧场景，差 4 箱 = 深度 4 + 主 pass 8）。

**满配场景的真实构成**（`perf.mainPassDrawables` detail 自带，回归时直接看）：货架 120/120 格有货、收银 3 台、仓库 24/24 箱、卸货区 12/12 箱、测试顾客 20 名（每客塞 12 件逻辑手持、实渲染 6）。分阶段差分（C-T8 实测，箱数按当时的 710 场景）：`preZones 135 → 建 B/C/W 317 → 站桩 344 → 灌店 366 → 仓库补箱 410 → 卸货补箱 410（院已满，spawnBox 全 null）→ 20 顾客 710`。

方法论沿用 B-T7：闸门以自测脚本实际运行到该断言时的场景状态为准（含前序测试残留），比理论刚启动负载更高更保守。

**未纳入闸门场景的负载**（下次加装饰前须先补进来）：传送带上的商品 mesh、玩家举起的纸箱。余量 **34** 比看上去薄得多 —— 散落地面箱已于 D 期纳入闸门场景（12 只 × 2 = 24），下一次加装饰前必须先重估这 34 格。

### 5.9 lowfx
`localStorage['gss-lowfx']='1'` → `G.tex.on=false`（生成器全返回 null，材质纯色）+ `renderer.shadowMap.enabled=false` + 跳过 castShadow 赋值。逻辑对象、价签状态、命中盒不变——玩法与存档不分叉。切换需刷新页面。

### 5.10 比例与雾
（**C-T8 实测回写**，逐项与 `main.js` / `world.js` 常量对齐）相机高 1.65m，`fov 70`，`near 0.1`，`far 200`。货架 `SHELF_H` 1.8m × `SHELF_W` 2.0m × `SHELF_D` 0.8m；**主购物通道净宽 2.4m**（货架行中心 z=±1.6、进深 0.8 → 架面在 z=±1.2；C 区 z=-8.6/-5.4 行同为 2.4m）；店面 **32m × 20m**（`ROOM_HALF_X` 16 / `ROOM_HALF_Z` 10，`WALL_H` 3.0→**3.6**）。`scene.fog = new THREE.Fog(0xAECBE0, 45, 140)`，柔化远处墙体。

- **【订正】原记「通道宽 2.2m」是 B 期小店值，大卖场布局实为 2.4m。**

阴影视锥随店面放大同步扩容，**已落地**（C-T1 实施、C-T8 实读核实）：ortho ±13→**±26**、far 40→**60**、`mapSize` 2048²→**4096²**（1.27cm/texel 精度不降）。参数正本以 §5.5 灯光与阴影一节为准。

## 6. 交互反馈规则
- **准星命中**（≤3m 的 interactable）：目标 mesh 的 `material.emissive` 设为 `#FFD666`、`emissiveIntensity 0.35`；移开立即还原（缓存原值，禁止克隆材质导致泄漏）。同时 `#crosshair` 变 `--hl`、`#prompt` 显示文案。
- **提示文案格式**：`[E] 动词 + 对象`，例如 `[E] 搬起纸箱（方便面 ×24）`、`[E] 上架 1 件 · 好味方便面`、`[E] 打开订货电脑`、`[E] 进入收银台`、`[E] 丢弃空箱`。不可用时用 `--danger` 色显示原因，例如 `此格已被占用`、`该商品需冷藏`。
- **不可用操作**：`#toast` 报错 + `#prompt` 变红，**不弹模态框**。
- **上架成功**：商品自纸箱位置直线飞向目标格位，180ms `ease-out`；落位后接 90ms 由 0.8 倍缩放到 1.0 倍。
- **扫码成功**：商品从传送带滑到已扫区（150ms），POS 小计数字闪一次 `--accent`。
- **金钱变化**：`#hud-money` 旁飘出 `+¥12.5` / `-¥3.0` 小字（`--accent` / `--danger`），上移 24px 并在 800ms 内淡出。
- **升级**：`#toast` 用 `--accent-2` 状态条，文案 `等级提升！Lv 5 — 解锁：咖啡 / 牛奶 / 洗衣粉`。
- **所有 3D 位移动画统一使用 `ease-out` 缓动**（`f(t) = 1 - (1-t)³`）。
- 过渡时长档位：UI 状态 120ms / 3D 位移 90-300ms / 数值闪烁 180ms / 金钱飘字 800ms；缓动统一 `ease-out`。
- **禁止**：闪烁警示、抖动、超过 300ms 的等待动画、任何遮挡准星的装饰。
