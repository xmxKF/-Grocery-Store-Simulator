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
│                                                          │
│                   #prompt 底部居中（距底 96px）            │
│                                    #toast 右下 16/16 竖向堆叠 │
└──────────────────────────────────────────────────────────┘
```
- `#hud-money`：`¥ 1,234.5`，主强调色；金额变化时数字闪一次（`--accent` 增 / `--danger` 减，180ms）。
- `#hud-day` / `#hud-clock`：`第 3 天` + `14:25`，同一胶囊内，`--text` / `--text-dim`。备货阶段时钟位显示 `准备中`。
- `#hud-level`：`Lv 4` + 下方 120×4px XP 进度条（底 `--line`，填充 `--accent-2`，圆角 2px）。
- `#crosshair`：8×8px 圆点，`#FFFFFF` 60% 不透明 + 1px `rgba(0,0,0,.5)` 描边；命中可交互物时变 `--hl` 并放大到 12px（120ms）。
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
- **几何**：只用 `BoxGeometry` / `CylinderGeometry` / `PlaneGeometry`。r128 **无 `CapsuleGeometry`**，顾客用方块拼。禁止贴图与法线贴图，全部纯色。
- **材质**：统一 `MeshLambertMaterial`，`flatShading: true`，无金属/粗糙度参数。半透明仅用于冷藏柜玻璃（`transparent, opacity .35`）。
- **灯光**（只有两盏，`main.js` 建立）：
  - `AmbientLight(0xFFFFFF, 0.65)`
  - `DirectionalLight(0xFFF6E5, 0.75)`，位置 `(8, 14, 6)`，朝原点。**关闭阴影**（`castShadow = false`）以保证低配帧率。
- **商品表现**：货架格内的商品是 `0.16×0.22×0.16` 的小方块，按格内数量沿列摆开（每行 4 个，最多 4 行），颜色 = 商品 `color`。
- **纸箱**：`0.45³` 立方体，正面贴一块商品类目色的小面片（`0.2×0.12` Plane，前移 0.001）作为「标签」，一眼看出装的是什么。
- **比例**：相机高 1.65m，`fov 70`，`near 0.1`，`far 200`。货架高 1.8m、宽 2.0m、深 0.8m；通道宽 2.2m；店面 16m × 12m。
- **雾**：`scene.fog = new THREE.Fog(0xAECBE0, 30, 90)`，柔化远处墙体。

## 6. 交互反馈规则
- **准星命中**（≤3m 的 interactable）：目标 mesh 的 `material.emissive` 设为 `#FFD666`、`emissiveIntensity 0.35`；移开立即还原（缓存原值，禁止克隆材质导致泄漏）。同时 `#crosshair` 变 `--hl`、`#prompt` 显示文案。
- **提示文案格式**：`[E] 动词 + 对象`，例如 `[E] 搬起纸箱（方便面 ×24）`、`[E] 上架 1 件 · 好味方便面`、`[E] 打开订货电脑`、`[E] 进入收银台`、`[E] 丢弃空箱`。不可用时用 `--danger` 色显示原因，例如 `此格已被占用`、`该商品需冷藏`。
- **不可用操作**：`#toast` 报错 + `#prompt` 变红，**不弹模态框**。
- **上架成功**：商品方块以 90ms 从 0.8 倍缩放到 1.0 倍出现。
- **扫码成功**：商品从传送带滑到已扫区（150ms），POS 小计数字闪一次 `--accent`。
- **金钱变化**：`#hud-money` 旁飘出 `+¥12.5` / `-¥3.0` 小字（`--accent` / `--danger`），上移 24px 并在 800ms 内淡出。
- **升级**：`#toast` 用 `--accent-2` 状态条，文案 `等级提升！Lv 5 — 解锁：咖啡 / 牛奶 / 洗衣粉`。
- 所有过渡时长只用 `120ms`（UI 状态）、`180ms`（数值闪烁）、`300ms`（面板淡入淡出）三档，缓动统一 `ease-out`。
- **禁止**：闪烁警示、抖动、超过 300ms 的等待动画、任何遮挡准星的装饰。
