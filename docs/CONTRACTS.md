# CONTRACTS.md — 架构契约（编码 agent 必读）

本文件定义模块边界与接口。**每个 agent 只能写自己名下的文件**；跨模块只通过下述 API 与事件通信。数值参数（商品、经济、顾客容忍度等）以 `docs/GDD.md` 为准；视觉以 `DESIGN.md` 为准。

## 技术栈（固定，不可改）
- Three.js **r128 UMD**（`libs/three.min.js`，经典 `<script>` 标签，全局 `THREE`）。
  - r128 注意：无 `CapsuleGeometry`（顾客身体用 Box/Cylinder 拼），用 `BoxGeometry`/`MeshLambertMaterial`/flat color。
- 无构建步骤、无 ES modules、运行时零网络请求。双击 `index.html`（file://）即可玩。
- 每个 js 文件用 IIFE + `'use strict'`，只向全局命名空间 `window.G` 挂自己的模块。
- 游戏内 UI 文本一律**简体中文**。存档 key：`localStorage['gss-save-v2']`（结构见 G.state 段「存档」条款）；`gss-save-v1` 保留供一次性迁移读取。

## 文件清单与归属
| 文件 | 归属 agent |
|---|---|
| `index.html`（含全部 DOM 容器与 script 标签） | scaffold |
| `libs/three.min.js`（vendor 下载） | scaffold |
| `css/style.css` | ui |
| `js/data.js`、`js/state.js`、`js/shop.js` | economy |
| `js/textures.js`、`js/world.js` | world |
| `js/physics.js`（D 期新增） | physics |
| `libs/cannon.min.js`（vendor 下载） | scaffold |
| `js/player.js` | player |
| `js/customers.js`、`js/checkout.js` | customers |
| `js/ui.js` | ui |
| `js/main.js`、`README.md` | integrator |

`index.html` script 顺序（固定）：
`libs/three.min.js` → `libs/cannon.min.js` → `js/data.js` → `js/state.js` → `js/textures.js` → `js/physics.js` → `js/world.js` → `js/player.js` → `js/shop.js` → `js/customers.js` → `js/checkout.js` → `js/ui.js` → `js/main.js`
**`js/physics.js` 必须在 `js/world.js` 之前**（D 期）：`world.init()` 会走到 `rebuildGraph → syncStatics`，若 `G.physics` 未定义，`syncStatics()` 无从调用。

`index.html` 固定 DOM id（ui/checkout 只能用这些容器）：
`#app`(canvas 容器) `#hud` `#hud-money` `#hud-day` `#hud-clock` `#hud-level` `#crosshair` `#charge` `#prompt` `#toast` `#screen-menu` `#screen-computer` `#screen-summary` `#pos` `#selftest`(隐藏 pre)
（`#charge` 自 D-T3 起存在于 `index.html`；D-T0~T2 阶段该 id 尚未接入，属预写契约。）

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

**本表为常用事件，完整事件集见文末「补充事件」段**（`zone` / `cashier` / `toggleOpen` / `nextDay` / `license` 等在那里）。

### G.data（data.js）
- `G.data.PRODUCTS`: `[{id, name, cat, cost, market, boxSize, slotCap, unlockLevel, color, shape, scale?, accent?}]`（24 项；shape ∈ bottle|can|carton|bag|tub|jug|tray|produce；scale 省略视为 [1,1,1]；accent 省略时回退 color，当前 24 商品均显式给值）
- `G.data.CONFIG`: `{startMoney, dayLengthSec, rentPerDay, deliverySec, spawnIntervalBase, patienceSec, ...}`（抄 GDD）
- `G.data.LEVELS`: `[{level, xpNeeded, unlock:string, warehouseAvailable?:true, zoneB?:true, zoneC?:true, maxBoxesPerOrder?, cashierAvailable?:true}]`（C-T5 换表；旧字段 `shelfGroups`/`expansion` 已删）
  - 只有 `maxBoxesPerOrder` 有真实消费方（shop.js 订货上限）。`warehouseAvailable`/`zoneB`/`zoneC`/`cashierAvailable` 目前**零消费方**——等级门槛的真相在 `CONFIG.zoneLevels` 与 `shop.hireCashier` 的硬编码 `level < 10`，两处现值一致但不同源，改一处不会自动同步另一处。
- `G.data.productById(id)`

### G.state（state.js）
字段：`money, day, xp, level, prices{pid:number}, licenses[cat], clock(0..dayLengthSec), open:boolean, negDays(连续日结为负的天数，GDD §8 连续 3 天 → 游戏结束), dayStats{revenue,cogs,customers,itemsSold}, zones:{A,B,C,W}, registers:[{owned,staffed}×3]`（`cashier` 字段废弃，仅迁移期兼容读）
API：
```js
G.addMoney(delta, reason)   // 更新+emit('money')；不做负数校验之外的魔法
G.addXP(n)                  // 处理升级，emit('xp'/'levelup')
G.save(); G.load() /*->bool*/; G.resetSave()
// save() 内部调用 G.world.serializeShelves()/serializeBoxes() 与 G.shop.serializeDeliveries()；
// load() 先按 zones 建区，再 restoreShelves/restoreBoxes/restoreDeliveries
```
存档结构 `gss-save-v2`（照录）：
```js
{ v:2, money, day, xp, level, prices, licenses, negDays,
  zones:{A:true,B:false,C:false,W:false},
  registers:[{owned,staffed}×3],
  shelves:[{id,productId,count}],
  boxes:[{pid,left,where:'storage'|'yard'|'floor',slotId?,x?,z?}],
  deliveries:[{pid,qty,remaining}] }
```
- `boxes` 是全部箱实体（仓库位 / 卸货区 / 店内地面 / 玩家手上）的单一真相；手上那只按玩家脚下位置存为 `'floor'`。`deliveries` 是已扣款的在途订单。二者与 `shelves` 共同兑现 GDD §3「已付的钱不退、箱子不消失」。
- **旧 v2 档兼容**：C 期终审前的 v2 只有 `storage:[{id,pid,left}]`（仅仓库位）。`load()` 见不到 `boxes` 时清场后回落 `restoreStorage(data.storage)`；新写的档不再含 `storage`。
- 读取分流：优先 `gss-save-v2`；无则读 `gss-save-v1` → `migrateV1`：继承 money/day/xp/level/prices/licenses/negDays；`cashier → registers[0].staffed`；zones 全锁（仅 A）；shelves 不继承 → 按进价全额折现入 money；首次 save 写 v2；**v1 键保留不删**。
- `resetSave()`：**双键清除**（`gss-save-v1` 与 `gss-save-v2` 一并删除）。

### G.tex（textures.js）
```js
G.tex.on                    // boolean，加载时读 localStorage['gss-lowfx'] !== '1'
G.tex.setRenderer(renderer) // main.js 在 buildRenderer 后调用；null 安全（无头环境）
// 生成器（G.tex.on 为 false 时一律返回 null；返回的 Texture 禁止调用方改 repeat/wrap）：
G.tex.floorWood(rx, ry)  G.tex.yardConcrete(rx, ry)  G.tex.wallWainscot(rx, ry)
G.tex.ceilingPanel(rx, ry)  G.tex.shelfMetal(rx, ry)  G.tex.fridgeSteel(rx, ry)
G.tex.counterLaminate(rx, ry)  G.tex.beltRubber(rx, ry)  G.tex.cardboard(rx, ry)
G.tex.labelBand(shape, accentHexString)   // 64²，repeat 恒 (1,1)
G.tex._cache   // {canvases, textures}，双层缓存内部表，仅供自测
```

### G.physics（physics.js）
```js
G.physics.init()                  // 建 CANNON.World（gravity (0,-9.82,0)、NaiveBroadphase、solver.iterations 10、allowSleep）
                                  // + 地面 plane(y=0) + 天花板 plane(y=CEIL_Y=3.40)。
                                  // 【必须在 G.world.init(scene) 之前调用】——world.init 会走到 rebuildGraph → syncStatics
G.physics.syncStatics()           // 按 G.world.colliders 全量重建静态刚体（先清后建）；地/天花板 plane 不参与重建。
                                  // 【唯一真相源】引擎静态刚体一律由此生成，绝不手写第二份几何表
G.physics.update(dt)              // world.step(1/60, dt, 10)，然后把全部 loose 箱的 interpolatedPosition / quaternion 写回 box.mesh
G.physics.attach(box)             // 由 mesh 当前 position/quaternion 建【动态】刚体，挂到 box.rb；幂等（先 detach）
G.physics.attachStatic(box)       // 同上但 mass = 0（存储位用）
G.physics.detach(box)             // 从 world 移除 box.rb，box.rb = null；幂等
G.physics.throwBox(box, dir /*THREE.Vector3 单位向量*/, speed, spin /*{x,y,z}*/)   // attach 后设 velocity/angularVelocity
G.physics.looseBoxes()            // -> [box]（箱实体，不是 body）。【只读、共用同一个内部数组，调用方不得持有跨帧】
                                  // 调用方从 box.mesh.position 与 box.rb.velocity 取值
G.physics.heightOf(collider)      // -> 该 collider 的竖直高度（占 y ∈ 0..h）；缺省 h 时返回 G.world.WALL_H。
                                  // 【唯一真相源】需要 collider 高度的代码一律调它，不得再抄一份「缺省 = WALL_H」
G.physics.CEIL_Y                  // 3.40 = WALL_H − 0.20（spec §9.2 实测定值，改它必须重跑 physics.ceilingCaps）
G.physics.BOX_HALF                // 0.225 = 纸箱边长 0.45 的一半（mesh 与刚体零偏移）。
                                  // 需要箱半边长的代码一律读它，不得再抄一份 0.225
G.physics._test                   // 仅供自测：bodyCount() / staticCount()（只数 collider 静态体 + 2 plane，不含 slotted 箱）
                                  // / hasBody(body) / stateOf(box) -> 'held'|'slotted'|'loose' / stepOnce()
                                  // / src() / probeCeiling(v0) / probeTunnel(speed)
```
- **刚体引用字段名是 `box.rb`，不是 `box.body`**（`box.body` 已被占用：它是纸箱的纸板 mesh，且 `destroyBox` 会对它调 `geometry.dispose()`）。
- **箱实体的所有权仍归 world.js**：`G.physics` 只持 `box.rb` 引用，`allBoxes()` 仍是唯一枚举口径。
- `G.world.colliders` 的每条可带**可选**高度字段 `h`（米，缺省视为 `WALL_H` 3.6）。**读 `h` 的只有两处：`physics.syncStatics`（建静态刚体）与 `player.boxFitsAt`（D-T3 钳投掷出手点），且两者必须一律经 `G.physics.heightOf(collider)` 取值——绝不各抄一份「缺省 = WALL_H」，两份口径漂移会让钳位按错误高度放行，投掷穿墙的缺陷在窄带内重开且无断言报警。寻路（`segHitsBox`）与玩家碰撞（`collidesAt`）只读 `minX/maxX/minZ/maxZ` 四个 2D 字段，不得读 `h`。**
- **墙的 mesh 半厚 0.1、collider 半厚 0.2**：`wallAlongX/Z` 的 `BoxGeometry` 用 `WALL_T = 0.2` 作**总**厚（半厚 0.1），而同一段推入的 collider 是 `z ± 0.2` / `x ± 0.2`（**总厚 0.4**，比 mesh 宽一圈，是有意的留白）。**任何按墙面几何反推坐标的代码或断言一律按 collider 的 0.2 半厚算**，按 mesh 的 0.1 推会整整差 0.1 m（D-T3 的 `player.throwNoWallClip` 站位就被咬过一次：南外墙中面 z = −10，贴墙站位是 −9.45 而不是 −9.55）。几何本身不改——改了要连带重跑寻路 `NAV_INFLATE`、收银站位与 `isOnYard` 一整串。
- `rebuildGraph()` 的每一个调用点都必须紧跟一行 `if (G.physics) G.physics.syncStatics();`。漂移由断言 `physics.staticsMatchColliders` 钉死。

### G.world（world.js）
```js
G.world.init(scene)               // 建店：地板/墙/门/货架/收银台/仓储电脑/卸货区/垃圾桶
G.world.slots                     // [{id, pos:THREE.Vector3, productId|null, count, fridge:bool, marker:Group, tagMesh, hitMesh, itemGroup, aisleSpot:Vector3, faceZ:±1}]（前四项是跨模块契约面，其余为 world.js 内部渲染字段，只读）
G.world.findEmptyOrMatchingSlot(pid)      // -> slot|null（上架用）
G.world.findSlotWithProduct(pid)          // -> slot|null（顾客拿货用）
G.world.addItem(slot, pid, fromPos /*可选 THREE.Vector3，飞行动画起点；省略则无飞行*/) /*->bool*/  G.world.removeItem(slot) /*->bool；count 归零保留 productId 以显示缺货*/  // 同步更新货架上的可见商品堆
G.world.updateSlotTag(slot)   // 幂等；按 slot 当前 productId/count 与 G.state.prices 重绘价签贴图
G.world.updateBoxVisual(box)  // 幂等；按 box.itemsLeft 切换满/空材质色（player.js 举箱变空、main.js 卸货时调用）
G.world.itemGeoFor(pid)   // -> BufferGeometry（品类基础形，T3 前恒为 0.16×0.22×0.16 Box）（契约：所有基础几何基面恰在 y=0，非居中——摆放/飞行/传送带偏移全押在此上）
G.world.itemMatFor(pid)   // -> Material（per-pid，T3 起含 labelBand 贴图）
G.world.getStockCount(pid)
G.world.spawnBox(pid, atPos /*可选 Vector3；省略走 activeYard 空位，满则返回 null*/)   // 生成纸箱实体 {mesh, productId, itemsLeft}，注册为可交互
G.world.registerInteractable(obj3D, {type, data, prompt})   // type: 'box'|'shelfSlot'|'computer'|'register'|'trash'|'shutter'（shutter.data = {zone, label}；价格/等级门槛不入 data，单一真相是 CONFIG.zonePrices/zoneLevels）
G.world.interactables             // 供 player 射线检测（含 mesh 引用）
G.world.colliders                 // [{minX,maxX,minZ,maxZ}] 供 player/顾客做 AABB 限制；另带可选 zoneGate 与（D 期）可选高度字段 h，详见下方 G.physics 段
G.world.nav = { entry, exit, aisleSpots:[Vector3], registers /*= G.world.registers 同引用*/ }   // 旧 queueSpots/registerFront 已于 T3 删除
G.world.serializeShelves() / G.world.restoreShelves(data)
G.world.registers   // [{index, mesh, beltMesh, front:Vector3, queueSpots:[Vector3×4], zone}]（按区域解锁惰性建造）
G.world.storageSlots // [{id:'st0'..'st23', pos:Vector3, marker:Mesh, box:null|箱}]（C-T4；仓库购买后建造，24 位 = 6 列 × 4 排地面标记）
G.world.storeBox(slot, box) /*->bool*/  G.world.takeBox(slot) /*->box|null*/   // C-T4
// takeBox 只解绑不搬箱（mesh 留在原位），调用方负责重新定位；storeBox 起手先解绑该箱的旧位，杜绝「一箱两位」
// takeBox 返回的箱处于「无刚体」的移交态（rb === null），调用方必须在同一 tick 内以 storeBox / attach / pickUpBox 之一定案——这是三态不变式的唯一显式例外
G.world.releaseStorageOf(box)   // C-T4；按 box 反查并清空所占存储位（玩家直接搬起存储位上的箱时由 player 调用）
G.world.serializeStorage() /*->[{id,pid,left}]*/  G.world.restoreStorage(data)   // C-T4；restore 靠 slot.id 匹配，必须在 buildZone('W') 之后调用；存档已改走 serializeBoxes，此对仅供旧 v2 档回落与自测
G.world.allBoxes() /*->[box]*/   // C-终审；场上全部箱实体 = 交互体表里的箱 + G.player.carrying（举箱时交互体被摘除）；总数上限/序列化/清场的单一枚举
G.world.destroyBox(box)          // C-终审；销毁一只箱（清存储位 + 摘交互体 + 出场景 + dispose 自有几何材质）
G.world.registerBoxInteractable(box)   // D 期导出；箱交互体的唯一登记入口（起手 retire 一次，保证「一 mesh 一交互体」），投掷松手时由 player.releaseThrow 调用
G.world.serializeBoxes() /*->[{pid,left,where:'storage'|'yard'|'floor',slotId?,x?,z?,ry?}]*/  G.world.restoreBoxes(data)   // C-终审；restore 起手清场再重建，data 非数组时只清场；必须在 buildZone('W') 之后调用
// ry（D 期）：绕 Y 的偏航（弧度）。所有箱一律按「落地平放」口径存档——y 恒 0.225 不入档，俯仰与翻滚丢弃。旧档无 ry 视为 0，v:2 不变更。
G.world.WALL_H                   // 3.6；断言与文档的墙高单一真相（shadow.frustumCovers 采样高度读它）
G.world.buildZone(z /*'B'|'C'|'W'*/)   // C-T1；幂等；自置位 zones[z]+开门+除collider+启用节点+建造该区设施
G.world.zoneOf(x, z) /*->'core'|'A'|'B'|'C'|'W'|null*/   // C-T2；点落在哪个区域矩形（core 优先），findPath 目的地闸消费
G.world.isOnYard(mesh) /*->bool*/   // C-T4；箱 mesh 是否停在当前生效卸货区的 12 个位上（0.3m 判据）
```
**新 API 落地时点**（T0 立契约、下游实施）：`buildZone` = C-T1；`nav.findPath` / `zoneOf` = C-T2；
`registers[]` 逐台化 + `setCashierVisible(index, visible)` = C-T3；`storageSlots` / `storeBox` / `takeBox` /
`releaseStorageOf` / `serializeStorage` / `restoreStorage` / `isOnYard` = C-T4；`shop.yardHasRoomFor` /
`world._tagStats` / `player._test.prompt` = C-T7。
店内寻路：`G.world.nav.findPath(from, to) -> [Vector3]`（走廊节点图 + Dijkstra；未解锁区域节点禁用，
不可达返回 []）。顾客经 findPath 折线移动，互不碰撞可穿过；玩家与员工不寻路。

### G.player（player.js）
```js
G.player.init(camera, renderer.domElement); G.player.update(dt)
G.player.carrying    // null | {mesh, productId, itemsLeft}（举着的纸箱，挂在相机前）
G.player.camera                 // 只读；init() 时记下的相机引用
G.player.getPose()              // -> {x, z, yaw, pitch}（纯数值快照，非引用）
G.player.setPose(pose)          // 设定玩家位姿并立即同步到相机；收银台进出用
G.player._test   // 仅供自测：prompt(entry) / pickUp(box) / putDown() / storeInto(slot) / throwConsts()
                 // / charge(tSec) / chargeState() / peekThrow() / throwNow() / setRmb(down)
                 // / stepCharge(dt) / setHover(entry) / setMouseDown(down) / doInteractions()
                 // / resetStockCooldown()
```
- 点击 canvas 进入 Pointer Lock；WASD 移动（用 G.world.colliders 做 AABB 碰撞）；`'screen'` 事件打开界面时释放锁并忽略输入。
- 准星射线 ≤3m 命中 interactable → `G.bus.emit('hover',{prompt})`；未命中发 `{prompt:null}`。
- 按 E / 左键：box→捡起；持箱对 shelfSlot→放 1 件（调 `G.world.addItem`，箱空自动变垃圾提示）；对 trash→丢弃箱子；computer→`G.ui.showScreen('computer')`；register→`G.checkout.enterRegister(entry.data.register)`；shutter→`G.shop.buyZone(entry.data.zone)`（提示由 computePrompt 按等级/资金生成，失败 toast 原因）。
- Tab 也可开电脑；Esc 关界面/释放锁。
- `G.checkout.inRegister` 为真时 player 完全让出相机控制权，位姿由 checkout 显式还原（不再由 player 从相机反推）。
- **持箱时按住右键蓄力、松开投掷**（D 期）：与准星指向何处无关，左键的两个既有语义（`mouseJustPressed` 点击交互、`mouseDown` 持箱按住连续上架）零改动、可与右键蓄力同时独立生效。蓄力中 `inRegister` / 有全屏界面 / 失去指针锁定 → 取消蓄力（箱留在手上）。
- canvas 上注册 `contextmenu` → `e.preventDefault()`：指针锁定下多数浏览器已抑制右键菜单，但不得依赖。断言 `player.contextMenuSuppressed`。

### G.shop（shop.js）
```js
G.shop.orderBoxes(cart /*[{pid,qty}]*/) /*->bool 整单校验+扣钱，deliverySec 后逐箱 spawnBox + emit('delivery')*/
G.shop.setPrice(pid, price)      // 写入 G.state.prices
G.shop.buyLicense(cat) /*->bool 成功后 emit('license')*/
G.shop.buyZone(z) /*->bool 等级+金钱双校验*/
G.shop.hireCashier(i) /*->bool Lv10、¥200*/  G.shop.fireCashier(i)
G.shop.update(dt)                // 推进配送计时
G.shop.isUnlocked(pid) /*->bool 等级+许可证*/
G.shop.yardHasRoomFor(qty) /*->bool 卸货区容量判据的单一真相：院内箱数 + 在途队列 + qty <= CONFIG.maxBoxesInYard；orderBoxes 与订货面板的按钮禁用共用此函数*/
G.shop.serializeDeliveries() /*->[{pid,qty,remaining}]*/  G.shop.restoreDeliveries(data)   // C-终审；在途订单已扣款，必须入档（GDD §3）；restore 起手清空现有队列
```

### G.customers（customers.js）
```js
G.customers.init(scene)  // main.js 启动时调用，记下 scene 引用（供 §手持道具/自测取 scene 用）
G.customers.update(dt); G.customers.active /*[]*/; G.customers.reset()
G.customers.buildFigure(opts /*{shirt?,pants?,skin?,hair?,hairStyle?,h?,w?} 省略项随机*/) // -> 顾客构造体（收银员站桩复用）
```
- 营业中按 GDD 频率生成；FSM：`entering→shopping(逐个货架取货)→queueing→paying→leaving`。
- 购物清单只从"已上架且已解锁"商品生成；对每件按 GDD 容忍度公式决定买/嫌贵放弃（嫌贵 emit toast 事件可选）。
- 拿货调 `G.world.removeItem`；排队用 `G.checkout.joinQueue(c)`；patienceSec 超时 → 弃购离店 emit `'customerLeft'` {angry:true}。
- 移动=按 `G.world.nav.findPath` 折线折点匀速 lerp；身体低多边形随机色。

### G.checkout（checkout.js）
```js
G.checkout.init(scene, camera)   // main.js 启动时调用，记下 scene/camera 引用
G.checkout.joinQueue(c)   // 队列改为逐台私有（reg.queue），单例 G.checkout.queue 于 T3 移除
G.checkout.enterRegister(reg)   // reg 可为 G.world.registers 项 / 省略（默认首台）；玩家进入收银模式：锁视角朝传送带，POS 面板(#pos)显示；已占别台时忽略并 toast「先退出当前收银台」
G.checkout.exitRegister()
G.checkout.update(dt)
G.checkout.stance   // null | {pos: THREE.Vector3, yaw: Number, pitch: Number}（只读，供自测断言）
G.checkout.activeRegisterId   // 只读；玩家当前所在台 index，未进入时 null
G.checkout._test    // 自测钩子：ease/registers()/frame(i)/tx(i)/scanAll(i)/settle(i)/payCard(i)，仅 ?selftest 使用
// 【二义警告】这些钩子的 i 是 ensureRegisters() 返回数组的**位序**，不是 register.index。
// 现状二者恒等（R1 开局建、R2 随 B、R3 随 C，push 顺序即 index 顺序）；但玩家若先买 C 后买 B，
// 数组位序会变成 [0, 2, 1] 而 index 仍是 0/1/2 —— 届时 _test.tx(1) 取到的是 R3。断言若需按台号定位，用 index 自行查找。
```
- `joinQueue(c)`：在已建收银台中选 `queue.length` 最小者入队（并列取低 index），全部满则返回 false。
- 队首顾客把商品放上传送带（小 mesh 排开）；玩家逐件点击扫码（总价累计显示于 #pos）。
- 扫完 → 付款：现金（显示顾客给的钞票，玩家从零钱面板点选找零，找错多找的部分损失）或刷卡（点读卡器直接成交）。
- 成交：`G.addMoney(total,'sale')`、`G.addXP`、更新 dayStats、emit `'sale'`，顾客离店。

### G.ui（ui.js）
```js
G.ui.init()
G.ui.showScreen(name /*'menu'|'computer'|'summary'|null*/)   // emit('screen')
G.ui.prompt(text|null); G.ui.toast(text, kind /*'ok'|'warn'|'danger'，省略为 'ok'；同时最多堆 3 条*/)
G.ui.setCharge(v /*0..1 显示并设填充宽度；null 隐藏*/)   // D 期；#charge 蓄力力度条
```
- 监听 bus 刷新 HUD；电脑界面三个标签：订货 / 定价 / 许可证（数据全来自 G.data/G.state/G.shop API）。
- 样式全部按 `DESIGN.md`。

### main.js（integrator）
- 启动：renderer/scene/light、`world.init`、各模块 init、菜单（新游戏/继续）。
- 主循环：rAF，dt≤0.1s；推进 clock；打烊逻辑：时间到停止生成顾客，场内顾客走完 → `'dayEnd'` + 结算界面（扣房租）→ 下一天。
- **自测模式**：URL 带 `?selftest` → 跳过菜单与指针锁，加速模拟脚本化场景（订货→即时送达→上架→生成顾客→强制走完→刷卡结账→日结算），把断言结果 JSON 写入 `#selftest` 并设 `document.title = 'SELFTEST:PASS'|'SELFTEST:FAIL'`；`window.onerror` 也写入其中。
  - 验收命令（正常态）：
    ```
    msedge --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
           --user-data-dir=<每次跑前 rm -rf 的全新目录> --virtual-time-budget=120000 \
           --dump-dom "file:///C:/Users/quito/超市模拟器/index.html?selftest=1"
    ```
  - **三个已实证的环境坑**（C 期逐一踩出，勿省略上面任何一个开关）：
    1. `--user-data-dir` 会把 `gss-lowfx` 留在 profile 里。两态必须用**各自独立**的 profile 目录并在**每次跑前 `rm -rf`**，否则正常态会静默跑成 lowfx（表现为断言总数变少、`tex.*` 整块消失）。
    2. **`&lowfx=1` URL 参数不存在。** lowfx 态只能用跳板页：一个临时 html 先 `localStorage.setItem('gss-lowfx','1')` 再 `location.replace('index.html?selftest=1')`，且必须带 `--allow-file-access-from-files`。
    3. 在受沙箱约束的 shell 里调用 headless Edge 会静默产出 0 字节 DOM（无报错）。必须在不受沙箱约束的方式下调用。
  - 当前基线：正常态 **140/140**、lowfx **135/135**（D-T1 实测）。

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
- `'zone'` {zone}：shop.buyZone 成功后 emit（扣款与 `G.world.buildZone` 之后）。ui 订阅它刷新电脑界面——`addMoney` 触发的那次 `refreshComputerIfOpen` 发生在 `buildZone` 之前（那一刻 `zones[z]` 还是 false、R2/R3 未建），不能靠它。
- **G.world.syncLayout()**：幂等；读取 `G.state.zones`、`G.state.level` 与 `G.state.licenses`，把已开放区域的货架/冷藏柜补齐到 GDD §4 区域表的目标状态。main.js 在 `'levelup'`、`'license'`、读档后调用。真的建了 ≥1 组货架时自己调 `rebuildGraph()`（新 collider 可能打断既有导航边）。

### 不变式（改动前先读）
- **`G.world.buildZone(z)` 是区域建造的唯一入口**，运行期买区与读档重建共用它，二者产出的世界必须等价（C-终审实证 11 项逐字节等价：格位 / collider / 交互体 / 导航节点与边 / 收银台 / 存储位 …）。任何「读档时特事特办」的分支都是这条不变式的破口。
- **场上纸箱实体总数 ≤ 48**（`spawnBox` 起手校验，GDD §3）：`G.world.allBoxes()` 是唯一枚举口径（交互体表里的箱 + `G.player.carrying`），序列化 / 清场 / 上限判定都走它。
- `G.world.takeBox(slot)` **无生产调用方**（全项目只有 main.js 自测在调）：玩家从存储位搬箱走的是 `player.pickUpBox` + `G.world.releaseStorageOf(box)`。改 takeBox 不会影响玩家路径，反之亦然。
- `#pos` 内部 DOM 由 **checkout.js** 全权构建（用上面共享类名）；其余 screen 的 DOM 由 ui.js 构建。
- 时钟显示：ui.js 自行以 ~4Hz 轮询 `G.state.clock/open` 刷新，不设事件。
- 收银员状态存 `G.state.registers[i].staffed`；`G.state.cashier` 废弃（仅迁移期兼容读）；自动收银逻辑在 checkout.js。
- `'cashier'` {hired, index}：shop.hireCashier(i)/fireCashier(i) 成功后 emit；main.js 监听并按 index 调用对应台的站桩显隐，且在新游戏/读档后按 `G.state.registers[i].staffed` 逐台同步一次。
- **G.world.setCashierVisible(index, visible)**：幂等；在指定收银台（`registers[index]`）后侧放置/移除一个站桩低多边形收银员（体型同顾客规格，制服固定 `#4C9BE8`，不注册交互、不参与碰撞）（自收银员美术升级起字面为真：经 `G.customers.buildFigure` 构造）。
- 日终判定：main.js 检测 `clock 走完 && G.customers.active.length === 0`。
- **上架飞行动画由 `world.js` 自行在内部 `requestAnimationFrame` 中驱动**，不接入 `main.js` 主循环的 dt。理由：与现有 `popInItem` 的驱动方式一致；飞行是纯视觉表现，与游戏逻辑解耦——`addItem` 返回时商品在逻辑上已在格内。
- **价签贴图按 `(productId, price, state)` 三元组缓存 `CanvasTexture` 并复用；但每个价签持有各自的 `Material` 实例**，否则准星高亮会让同商品的所有价签一起发光（C-T7 起改为 `(productId, state)` 二元组，改价 dispose 旧条）。
- 商品实例池：world.js 内部按 pid 维护 InstancedMesh（G.world._instPools 仅供自测），
  增删一律 rebuildProduct(pid) 全量重建；实例颜色一律走 per-pid 材质，不使用 instanceColor/setColorAt——不是能力缺失（本构建支持），而是架构必然：每个商品的 labelBand 贴图不同，材质本就必须 per-pid，instanceColor 只能合并同 (shape,accent) 组、收益不抵复杂度。
- 上架飞行动画队列 `G.world._flights`（仅供自测）：`[{mesh, from, to, t0, slot, onDone, pid, idx}]`，`stepFlights` 自驱 rAF 消费。
- `G.customers._test`：自测钩子（spawnOne / gait / addHand / remove / stepOne），仅 ?selftest 使用。spawnOne 返回的对象带 `items` 与 `popItem`，便于验手持不变式。
- **顾客倒地三字段**（D-T4）：`c.ragdoll: bool`（是否倒地；`applyGait` 开头据此跳过步态，写入点只有 `stepKnockdown`）、`c.ragdollT: number`（倒地起算的秒数，单变量驱动全部姿态）、`c.ragdollDir: ±1`（`+1` 前扑 / `−1` 后仰，触发当帧按 `dot(箱速, 顾客正前方) > 0` 定死，倒地期间不再改）。三者在 `spawn()` 与 `_test.spawnOne()` 两处都必须初始化为 `false / 0 / 1`。姿态数值与时序见 DESIGN §5.7。
- `G.world._tagStats()`（仅供自测）：`{cache: TAG_TEX, disposed: 累计 dispose 次数}`，用于钉死价签贴图缓存不泄漏。
- **顾客手持渲染上限 6 件**（C-T7）：`addHandCube` 超过 6 件不再建 mesh，`popItem` 守不变式 `hands.children.length === min(items.length, 6)`。逻辑 `items` 不受影响（清单最多 6 条 ×2 件 = 12 件），结账金额与库存扣减照常。
- lowfx：textures.js 是唯一读取 gss-lowfx 的模块；main.js、world.js 与 customers.js 通过 G.tex.on 判断。
- `belt.userData.belt`：world.js 打标（另带 `userData.registerId`）。C-T3 起 checkout 经 `G.world.registers[i].beltMesh` 直取自家台面，`userData.belt` 标记与 #4E5866 色值均不再承担 checkout 定位职责（色值红线仍在 DESIGN §5.4，属视觉契约）。
- `userData.shell`：world.js 打标（`addShell()` 7 个调用点，满配实测 **21** 个壳体 mesh：地板 1 + 天花板 1 + 外墙 6 段 + 内隔墙 7 段 + 门框柱 4 + 东西院混凝土地面 2）、main.js 自测 shellNoCast 断言消费——壳体绝不 castShadow 的硬标记。
- **静态刚体的单一真相源是 `G.world.colliders`**（D 期）：`G.physics.syncStatics()` 全量重建，绝不手写第二份几何表；`rebuildGraph()` 的每个调用点必须同步调 `syncStatics()`。断言 `physics.staticsMatchColliders` / `physics.staticsAfterZoneOpen`。
- **`interpolatedQuaternion` 在本项目中禁止使用**（D 期）：cannon 0.6.2 对醒着的动态体根本不写入该字段（永远是单位四元数），失效是静默的（表现为「箱不转」）。位置写回用 `body.interpolatedPosition`，旋转写回用 `body.quaternion`。断言 `physics.noInterpolatedQuaternion` 源码级钉死。
- **`G.physics.CEIL_Y − 卷帘门 collider 的 h` 必须 < 箱边长 0.45**（D 期）：门洞处墙体是断开的，关闭的卷帘门静态体只到 `h = 3.0`，其上到 `WALL_H` 的空当只由天花板 plane 压住；空当 ≥ 0.45 就能隔着关着的门往未购区域扔箱。`CEIL_Y ≥ 3.45` 即开洞。当前 `WALL_H = 3.6` 下 `physics.ceilingCaps` 恰好也在 3.45 跟着红（v0=9.0 支路 3.5682 尚绿、v0=12.0 支路 3.6245 已红），**但这是巧合，不能依赖**：`WALL_H` 一旦抬高，`ceilingCaps` 立刻放宽而本条纹丝不动（`WALL_H = 4.0` 时 `ceilingCaps` 可放行到 `CEIL_Y = 3.83`——实测 3.9714 ✓、3.84 → 4.0105 ✗——门顶空当已达 0.83 ≫ 0.45）。`CEIL_Y` 不是只被阴影视锥（spec §9.2）一条约束钉住的。断言 `physics.ceilingSealsZoneGates`。
- **箱三态与其刚体形态一一对应**（D 期）：`held`（`G.player.carrying === box`）无刚体；`slotted`（`storageSlotOf(box) !== null`）静态刚体 `mass 0`；`loose`（其余）动态刚体。四个转移入口 `pickUpBox` / `putDownBox` / `storeBox` / `releaseThrow` 各恰好一行物理调用，另加 `spawnBox` / `takeBox` / `destroyBox` / `restoreBoxes` 四处非玩家路径。
- **`G.customers._test.stepOne(c, dt)`**（D 期，仅供自测）：跑一名顾客的完整每帧流程（`stepKnockdown` → 非倒地时 `stepAvoid`/`stepMove`/`applyGait` → `stepState`），与 `update()` 的循环体同源同函数。

## 编码纪律
- 不引入契约之外的跨模块调用；需要新接口时**停下上报**，不擅自加。
- 不留 TODO/占位符；每个文件写完须通过 `node --check`。
- 遵循 DESIGN.md 的配色/字体/布局；交互必须有 hover 提示（`G.ui.prompt`）。
