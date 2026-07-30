# CONTRACTS.md — 架构契约（编码 agent 必读）

本文件定义模块边界与接口。**每个 agent 只能写自己名下的文件**；跨模块只通过下述 API 与事件通信。数值参数（商品、经济、顾客容忍度等）以 `docs/GDD.md` 为准；视觉以 `DESIGN.md` 为准。

## 技术栈（固定，不可改）
- Three.js **r128 UMD**（`libs/three.min.js`，经典 `<script>` 标签，全局 `THREE`）。
  - r128 注意：无 `CapsuleGeometry`（顾客身体用 Box/Cylinder 拼），用 `BoxGeometry`/`MeshLambertMaterial`/flat color。
- 无构建步骤、无 ES modules、运行时零网络请求。双击 `index.html`（file://）即可玩。
- 每个 js 文件用 IIFE + `'use strict'`，只向全局命名空间 `window.G` 挂自己的模块。
- 游戏内 UI 文本一律**简体中文**。存档 key：`localStorage['gss-save-v1']`。

## 文件清单与归属
| 文件 | 归属 agent |
|---|---|
| `index.html`（含全部 DOM 容器与 script 标签） | scaffold |
| `libs/three.min.js`（vendor 下载） | scaffold |
| `css/style.css` | ui |
| `js/data.js`、`js/state.js`、`js/shop.js` | economy |
| `js/world.js` | world |
| `js/player.js` | player |
| `js/customers.js`、`js/checkout.js` | customers |
| `js/ui.js` | ui |
| `js/main.js`、`README.md` | integrator |

`index.html` script 顺序（固定）：
`libs/three.min.js` → `js/data.js` → `js/state.js` → `js/world.js` → `js/player.js` → `js/shop.js` → `js/customers.js` → `js/checkout.js` → `js/ui.js` → `js/main.js`

`index.html` 固定 DOM id（ui/checkout 只能用这些容器）：
`#app`(canvas 容器) `#hud` `#hud-money` `#hud-day` `#hud-clock` `#hud-level` `#crosshair` `#prompt` `#toast` `#screen-menu` `#screen-computer` `#screen-summary` `#pos` `#selftest`(隐藏 pre)

## 全局命名空间 `G`

### G.bus（state.js 提供）
```js
G.bus.on(evt, fn); G.bus.off(evt, fn); G.bus.emit(evt, payload /*单个对象*/)
```
事件表（payload 字段）：
- `'money'` {money, delta, reason} ；`'xp'` {xp, level} ；`'levelup'` {level}
- `'dayStart'` {day} ；`'dayEnd'` {summary:{revenue,cogs,rent,profit,customers,itemsSold}}
- `'delivery'` {productId} （箱子已生成在卸货区）
- `'stocked'` {productId, slotId} ；`'sale'` {total, items:[productId], pay:'cash'|'card'}
- `'customerLeft'` {angry:boolean, reason} ；`'hover'` {prompt:string|null}
- `'screen'` {name:string|null} （UI 打开/关闭全屏界面；player 据此暂停指针锁定）

### G.data（data.js）
- `G.data.PRODUCTS`: `[{id, name, cat, cost, market, boxSize, slotCap, unlockLevel, color}]`（24 项，数值抄 GDD 表）
- `G.data.CONFIG`: `{startMoney, dayLengthSec, rentPerDay, deliverySec, spawnIntervalBase, patienceSec, ...}`（抄 GDD）
- `G.data.LEVELS`: `[{level, xpNeeded, unlock:string}]`
- `G.data.productById(id)`

### G.state（state.js）
字段：`money, day, xp, level, prices{pid:number}, licenses[cat], clock(0..dayLengthSec), open:boolean, dayStats{revenue,cogs,customers,itemsSold}`
API：
```js
G.addMoney(delta, reason)   // 更新+emit('money')；不做负数校验之外的魔法
G.addXP(n)                  // 处理升级，emit('xp'/'levelup')
G.save(); G.load() /*->bool*/; G.resetSave()
// save() 内部调用 G.world.serializeShelves() / 恢复时调用 G.world.restoreShelves(data)
```

### G.world（world.js）
```js
G.world.init(scene)               // 建店：地板/墙/门/货架/收银台/仓储电脑/卸货区/垃圾桶
G.world.slots                     // [{id, pos:THREE.Vector3, productId|null, count}]
G.world.findEmptyOrMatchingSlot(pid)      // -> slot|null（上架用）
G.world.findSlotWithProduct(pid)          // -> slot|null（顾客拿货用）
G.world.addItem(slot, pid, fromPos /*可选 THREE.Vector3，飞行动画起点；省略则无飞行*/) /*->bool*/  G.world.removeItem(slot) /*->bool；count 归零保留 productId 以显示缺货*/  // 同步更新货架上的可见商品堆
G.world.updateSlotTag(slot)   // 幂等；按 slot 当前 productId/count 与 G.state.prices 重绘价签贴图
G.world.getStockCount(pid)
G.world.spawnBox(pid)             // 卸货区生成纸箱实体 {mesh, productId, itemsLeft}，注册为可交互
G.world.registerInteractable(obj3D, {type, data, prompt})   // type: 'box'|'shelfSlot'|'computer'|'register'|'trash'
G.world.interactables             // 供 player 射线检测（含 mesh 引用）
G.world.colliders                 // [{minX,maxX,minZ,maxZ}] 供 player/顾客做 AABB 限制
G.world.nav = { entry, exit, aisleSpots:[Vector3], queueSpots:[Vector3 x5], registerFront }
G.world.serializeShelves() / G.world.restoreShelves(data)
```
店内布局保证：入口→过道→货架→收银台之间为直线可达（顾客走 waypoint 直线，无需寻路）。

### G.player（player.js）
```js
G.player.init(camera, renderer.domElement); G.player.update(dt)
G.player.carrying    // null | {mesh, productId, itemsLeft}（举着的纸箱，挂在相机前）
G.player.camera                 // 只读；init() 时记下的相机引用
G.player.getPose()              // -> {x, z, yaw, pitch}（纯数值快照，非引用）
G.player.setPose(pose)          // 设定玩家位姿并立即同步到相机；收银台进出用
```
- 点击 canvas 进入 Pointer Lock；WASD 移动（用 G.world.colliders 做 AABB 碰撞）；`'screen'` 事件打开界面时释放锁并忽略输入。
- 准星射线 ≤3m 命中 interactable → `G.bus.emit('hover',{prompt})`；未命中发 `{prompt:null}`。
- 按 E / 左键：box→捡起；持箱对 shelfSlot→放 1 件（调 `G.world.addItem`，箱空自动变垃圾提示）；对 trash→丢弃箱子；computer→`G.ui.showScreen('computer')`；register→`G.checkout.enterRegister()`。
- Tab 也可开电脑；Esc 关界面/释放锁。
- `G.checkout.inRegister` 为真时 player 完全让出相机控制权，位姿由 checkout 显式还原（不再由 player 从相机反推）。

### G.shop（shop.js）
```js
G.shop.orderBoxes(cart /*[{pid,qty}]*/) /*->bool 整单校验+扣钱，deliverySec 后逐箱 spawnBox + emit('delivery')*/
G.shop.setPrice(pid, price)      // 写入 G.state.prices
G.shop.buyLicense(cat) /*->bool 成功后 emit('license')*/
G.shop.hireCashier() /*->bool Lv10、¥200*/  G.shop.fireCashier()
G.shop.update(dt)                // 推进配送计时
G.shop.isUnlocked(pid) /*->bool 等级+许可证*/
```

### G.customers（customers.js）
```js
G.customers.update(dt); G.customers.active /*[]*/; G.customers.reset()
```
- 营业中按 GDD 频率生成；FSM：`entering→shopping(逐个货架取货)→queueing→paying→leaving`。
- 购物清单只从"已上架且已解锁"商品生成；对每件按 GDD 容忍度公式决定买/嫌贵放弃（嫌贵 emit toast 事件可选）。
- 拿货调 `G.world.removeItem`；排队用 `G.checkout.joinQueue(c)`；patienceSec 超时 → 弃购离店 emit `'customerLeft'` {angry:true}。
- 移动=朝 waypoint 匀速 lerp；身体低多边形随机色。

### G.checkout（checkout.js）
```js
G.checkout.joinQueue(c); G.checkout.queue
G.checkout.enterRegister()   // 玩家进入收银模式：锁视角朝传送带，POS 面板(#pos)显示
G.checkout.exitRegister()
G.checkout.update(dt)
G.checkout.stance   // null | {pos: THREE.Vector3, yaw: Number, pitch: Number}（只读，供自测断言）
```
- 队首顾客把商品放上传送带（小 mesh 排开）；玩家逐件点击扫码（总价累计显示于 #pos）。
- 扫完 → 付款：现金（显示顾客给的钞票，玩家从零钱面板点选找零，找错多找的部分损失）或刷卡（点读卡器直接成交）。
- 成交：`G.addMoney(total,'sale')`、`G.addXP`、更新 dayStats、emit `'sale'`，顾客离店。

### G.ui（ui.js）
```js
G.ui.init()
G.ui.showScreen(name /*'menu'|'computer'|'summary'|null*/)   // emit('screen')
G.ui.prompt(text|null); G.ui.toast(text)
```
- 监听 bus 刷新 HUD；电脑界面三个标签：订货 / 定价 / 许可证（数据全来自 G.data/G.state/G.shop API）。
- 样式全部按 `DESIGN.md`。

### main.js（integrator）
- 启动：renderer/scene/light、`world.init`、各模块 init、菜单（新游戏/继续）。
- 主循环：rAF，dt≤0.1s；推进 clock；打烊逻辑：时间到停止生成顾客，场内顾客走完 → `'dayEnd'` + 结算界面（扣房租）→ 下一天。
- **自测模式**：URL 带 `?selftest` → 跳过菜单与指针锁，加速模拟脚本化场景（订货→即时送达→上架→生成顾客→强制走完→刷卡结账→日结算），把断言结果 JSON 写入 `#selftest` 并设 `document.title = 'SELFTEST:PASS'|'SELFTEST:FAIL'`；`window.onerror` 也写入其中。
  - 验收命令：`msedge --headless=new --dump-dom --virtual-time-budget=20000 "file:///C:/Users/quito/超市模拟器/index.html?selftest=1"`

## 共享工具（state.js 提供，全模块可用）
```js
G.fmt(n)        // -> '¥ 1,234.5'（zh-CN 千分位，固定 1 位小数）
G.rand(a, b)    // 均匀浮点 [a,b)
G.randInt(a, b) // 整数 [a,b] 含端点
G.clamp(v, a, b)
```

## 共享 CSS 类名（style.css 实现；checkout.js/ui.js 只能用这些类建 DOM）
`.screen`（全屏遮罩容器） `.panel` `.panel-title` `.tabs` `.tab` `.tab.active`
`.btn` `.btn-primary` `.btn-secondary` `.btn-danger`（禁用用 `[disabled]`）
`.list` `.list-row` `.cat-dot`（14px 类目色块） `.num-input` `.step-btn`
`.badge` `.badge-ok` `.badge-warn` `.badge-danger`
`.pos-list` `.pos-row` `.pos-total` `.cash-grid` `.cash-btn`
`.text-dim` `.text-accent` `.text-danger`；按键名用 `<kbd>`

## 补充事件与职责裁定
- `'toggleOpen'` {}：player 按 `O` 时 emit；**main.js** 处理开门/打烊逻辑。
- `'nextDay'` {}：ui 日结算按钮 emit；**main.js** 处理进入次日 + `G.save()`。
- `'license'` {cat}：shop.buyLicense 成功后 emit。
- **G.world.syncLayout()**：幂等；读取 `G.state.level` 与 `G.state.licenses`，把货架/冷藏柜/扩建补齐到 GDD §4 表的目标状态。main.js 在 `'levelup'`、`'license'`、读档后调用。
- `#pos` 内部 DOM 由 **checkout.js** 全权构建（用上面共享类名）；其余 screen 的 DOM 由 ui.js 构建。
- 时钟显示：ui.js 自行以 ~4Hz 轮询 `G.state.clock/open` 刷新，不设事件。
- 收银员状态存 `G.state.cashier`（boolean）；自动收银逻辑在 checkout.js。
- `'cashier'` {hired:boolean}：shop.hireCashier/fireCashier 成功后 emit；main.js 监听并调用 `G.world.setCashierVisible(hired)`，且在新游戏/读档后按 `G.state.cashier` 同步一次。
- **G.world.setCashierVisible(visible)**：幂等；在收银台后侧放置/移除一个站桩低多边形收银员（体型同顾客规格，制服固定 `#4C9BE8`，不注册交互、不参与碰撞）。
- 日终判定：main.js 检测 `clock 走完 && G.customers.active.length === 0`。
- **上架飞行动画由 `world.js` 自行在内部 `requestAnimationFrame` 中驱动**，不接入 `main.js` 主循环的 dt。理由：与现有 `popInItem` 的驱动方式一致；飞行是纯视觉表现，与游戏逻辑解耦——`addItem` 返回时商品在逻辑上已在格内。
- **价签贴图按 `(productId, price, state)` 三元组缓存 `CanvasTexture` 并复用；但每个价签持有各自的 `Material` 实例**，否则准星高亮会让同商品的所有价签一起发光。

## 编码纪律
- 不引入契约之外的跨模块调用；需要新接口时**停下上报**，不擅自加。
- 不留 TODO/占位符；每个文件写完须通过 `node --check`。
- 遵循 DESIGN.md 的配色/字体/布局；交互必须有 hover 提示（`G.ui.prompt`）。
