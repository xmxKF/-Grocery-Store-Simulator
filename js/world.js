// js/world.js — 店铺世界：几何体、货架格位系统、纳夫点、可交互对象
(function () {
  'use strict';

  // ---- 类目色（抄 DESIGN.md §1.2，data.js 未导出此表，故本模块自持） ----
  var CAT_COLORS = {
    '食品': 0xE8A33D,
    '饮料': 0x3D8FE8,
    '生鲜': 0x4CB963,
    '日用品': 0x9B6FE0
  };

  // ---- C 期布局（32×20 大壳；原点居中）----
  var ROOM_HALF_X = 16, ROOM_HALF_Z = 10;
  var WALL_H = 3.6, WALL_T = 0.2;

  /* 区域范围（AABB，含义：该区的地面活动范围） */
  var ZONE_RECTS = {
    A:    { minX: 0.2,  maxX: 15.8, minZ: -3.5, maxZ: 3.5 },
    B:    { minX: -15.8, maxX: -0.2, minZ: -3.5, maxZ: 3.5 },
    C:    { minX: -15.8, maxX: 15.8, minZ: -9.8, maxZ: -4.2 },
    W:    { minX: -15.8, maxX: -8.0, minZ: 4.2,  maxZ: 9.8 },
    core: { minX: -8.0,  maxX: 15.8, minZ: 4.0,  maxZ: 9.8 }   // 前厅+收银，恒开
  };

  /* 卷帘门：购买后 mesh 隐藏 + collider 移除 + 节点启用 */
  /* 价格/等级门槛不在此表：单一真相是 CONFIG.zonePrices / zoneLevels（shop.buyZone 与提示文案同源） */
  var SHUTTERS = [
    { zone: 'B', minX: -5, maxX: -3, z: 4,  label: '区域 B' },   // 内墙 z=+4 上
    { zone: 'C', minX: 3,  maxX: 5,  z: -4, label: '区域 C' },   // 内墙 z=-4 上
    { zone: 'W', x: -8, minZ: 6, maxZ: 8,   label: '仓库' }      // 仓库东墙 x=-8 上
  ];

  /* 货架表：zone + 中心 + aisleZ（buildRack 朝向与服务点由 aisleZ 推导） */
  var SHELF_TABLE = [
    // 区域 A（开局 4 架）
    { zone:'A', x: 3.0,  z:-1.6, aisleZ: 0 }, { zone:'A', x: 7.5, z:-1.6, aisleZ: 0 },
    { zone:'A', x: 12.0, z:-1.6, aisleZ: 0 }, { zone:'A', x: 3.0, z: 1.6, aisleZ: 0 },
    // 区域 B（6 架）
    { zone:'B', x:-13.5, z:-1.6, aisleZ: 0 }, { zone:'B', x:-10.0, z:-1.6, aisleZ: 0 },
    { zone:'B', x:-6.5,  z:-1.6, aisleZ: 0 }, { zone:'B', x:-13.5, z: 1.6, aisleZ: 0 },
    { zone:'B', x:-10.0, z: 1.6, aisleZ: 0 }, { zone:'B', x:-6.5,  z: 1.6, aisleZ: 0 },
    // 区域 C（6 架，双行，走廊 z=-7.0）
    { zone:'C', x:-12.0, z:-8.6, aisleZ:-7.0 }, { zone:'C', x:-6.0, z:-8.6, aisleZ:-7.0 },
    { zone:'C', x: 0.0,  z:-8.6, aisleZ:-7.0 }, { zone:'C', x: 6.0, z:-8.6, aisleZ:-7.0 },
    { zone:'C', x:-12.0, z:-5.4, aisleZ:-7.0 }, { zone:'C', x:-6.0, z:-5.4, aisleZ:-7.0 }
  ];
  var FRIDGE_TABLE = [
    { zone:'A', x: 7.5, z: 1.6, aisleZ: 0 }, { zone:'A', x: 12.0, z: 1.6, aisleZ: 0 },
    { zone:'B', x:-2.5, z:-1.6, aisleZ: 0 }, { zone:'B', x:-2.5,  z: 1.6, aisleZ: 0 }
  ];
  // 合计 16 组货架 + 4 冷藏 = 120 格 ✓

  /* 收银台：柜台长轴沿 x（Box 2.0×1.0×1.2），中心 z=7.6；R1 开局，R2/R3 随 B/C */
  var REGISTER_TABLE = [
    { index: 0, x: -2, zone: 'core' },
    { index: 1, x: 4,  zone: 'B' },
    { index: 2, x: 10, zone: 'C' }
  ];
  var REGISTER_Z = 7.6;
  // front=(x, 0, 6.8)；queueSpots z = 6.3, 5.8, 5.3, 4.8（沿 -z 排，共 4 位）
  // 末位 4.8 距 z=4 内墙的膨胀带（3.35..4.65）留 0.15m，四位全部可寻路——
  // 旧表末两位 4.4/3.8 埋在膨胀带里，nearestNode 只能降级走穿墙直线（C-T2 实证）
  var QUEUE_ZS = [6.3, 5.8, 5.3, 4.8];

  /* 仓库存储位：单层地面网格 6 列 × 4 排 = 24 位 */
  var STORAGE_XS = [-14.9, -13.7, -12.5, -11.3, -10.1, -8.9];
  var STORAGE_ZS = [5.0, 6.3, 7.6, 8.9];
  var STORAGE_TABLE = [];
  STORAGE_ZS.forEach(function (z) {
    STORAGE_XS.forEach(function (x) { STORAGE_TABLE.push({ x: x, z: z }); });
  });   // 24 位（T4 消费；T1 只定义常量不建造）

  /* 卸货区东/西两套点位（各 12 位，同时只有一套生效）：仓库未购 = 东侧人行道北段；已购 = 西侧仓库外。
     与 GDD §4「双点位」（指同一区域的两处出入口）同词异义，勿混 */
  var YARD_EAST = [];
  [16.6, 17.4, 18.2, 19.0].forEach(function (x) {
    [6.9, 7.7, 8.5].forEach(function (z) { YARD_EAST.push({ x: x, z: z }); });
  });   // 12 位
  var YARD_WEST = [];
  [-19.2, -18.4, -17.6, -16.8].forEach(function (x) {
    [4.5, 5.5, 6.5].forEach(function (z) { YARD_WEST.push({ x: x, z: z }); });
  });   // 12 位
  function activeYardPositions() {
    return (G.state && G.state.zones && G.state.zones.W) ? YARD_WEST : YARD_EAST;
  }

  /* 点落在哪个区域（core 优先；不在任何区域返回 null） */
  function zoneOf(x, z) {
    var keys = ['core', 'A', 'B', 'C', 'W'];
    for (var i = 0; i < keys.length; i++) {
      var r = ZONE_RECTS[keys[i]];
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return keys[i];
    }
    return null;
  }

  // ---- 常量（DESIGN.md §5 / §1.3） ----
  var SHELF_W = 2.0, SHELF_D = 0.8, SHELF_H = 1.8;
  var SLOT_LOCAL_X = [-0.6, 0, 0.6];
  var SLOT_HEIGHTS = [0.9, 1.4];

  // 格位商品方块：几何体全局共享，形状未知时兜底（每格最多 16 个 × 最多 48 格，绝不逐个 new）
  var ITEM_GEO = null;

  function itemGeo() {
    if (!ITEM_GEO) ITEM_GEO = new THREE.BoxGeometry(0.16, 0.22, 0.16);
    return ITEM_GEO;
  }

  // ---- 品类基础几何（B-T3）：8 套共享，基面 y=0，XZ 包络 ≤0.16（tray 0.17 躺放例外）----
  var BASE_GEOS = null;
  function baseGeos() {
    if (BASE_GEOS) return BASE_GEOS;
    var g = {};
    var pts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.034, 0),
      new THREE.Vector2(0.037, 0.02), new THREE.Vector2(0.037, 0.13),
      new THREE.Vector2(0.018, 0.17), new THREE.Vector2(0.016, 0.21),
      new THREE.Vector2(0.001, 0.22)
    ];
    g.bottle = new THREE.LatheGeometry(pts, 8);
    g.can = new THREE.CylinderGeometry(0.036, 0.036, 0.13, 8);
    g.can.translate(0, 0.065, 0);
    g.carton = new THREE.BoxGeometry(0.14, 0.20, 0.07);
    g.carton.translate(0, 0.10, 0);
    g.bag = new THREE.CylinderGeometry(0.08, 0.066, 0.20, 6);
    g.bag.translate(0, 0.10, 0);
    g.tub = new THREE.CylinderGeometry(0.06, 0.055, 0.16, 10);
    g.tub.translate(0, 0.08, 0);
    var jpts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.042, 0),
      new THREE.Vector2(0.045, 0.03), new THREE.Vector2(0.045, 0.12),
      new THREE.Vector2(0.026, 0.15), new THREE.Vector2(0.020, 0.17),
      new THREE.Vector2(0.020, 0.21), new THREE.Vector2(0.001, 0.21)
    ];
    g.jug = new THREE.LatheGeometry(jpts, 8);
    g.tray = new THREE.BoxGeometry(0.17, 0.06, 0.12);
    g.tray.translate(0, 0.03, 0);
    g.produce = new THREE.IcosahedronGeometry(0.055, 0);
    g.produce.translate(0, 0.055 * 0.85065, 0);
    BASE_GEOS = g;
    return g;
  }

  // ---- 商品实例池（B-T2）：按 pid 一组 InstancedMesh，增删走全量重建，无索引簿记 ----
  var instPools = {};          // pid -> { mesh: InstancedMesh, cap: number }
  var instPops = [];           // { pid, at: number(实例下标), t0 } 落位弹入动画
  var instPopRaf = false;
  var _m4 = new THREE.Matrix4();
  var _q = new THREE.Quaternion();
  var _vp = new THREE.Vector3();

  var PID_MATS = {};
  function itemGeoFor(pid) {
    var product = G.data.productById(pid);
    var g = baseGeos();
    return (product && g[product.shape]) ? g[product.shape] : itemGeo();
  }
  function itemMatFor(pid) {
    if (PID_MATS[pid]) return PID_MATS[pid];
    var product = G.data.productById(pid);
    var accent = (product && product.accent) || (product && product.color) || '#FFFFFF';
    var map = (G.tex && G.tex.labelBand) ? G.tex.labelBand(product ? product.shape : '', accent) : null;
    PID_MATS[pid] = flatMat(product ? product.color : 0xFFFFFF, map ? { map: map } : null);
    return PID_MATS[pid];
  }

  function ensurePool(pid, need) {
    var pool = instPools[pid];
    if (pool && pool.cap >= need) return pool;
    var cap = pool ? pool.cap : 64;
    while (cap < need) cap *= 2;
    var mesh = new THREE.InstancedMesh(itemGeoFor(pid), itemMatFor(pid), cap);
    mesh.count = 0;
    mesh.frustumCulled = false;                 // r128 无 computeBoundingSphere，必关
    mesh.castShadow = false;                    // spec §4.3：实例不投影
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (pool && pool.mesh.parent) pool.mesh.parent.remove(pool.mesh);
    if (pool) pool.mesh.dispose();
    if (sceneRef) sceneRef.add(mesh);
    instPools[pid] = { mesh: mesh, cap: cap };
    return instPools[pid];
  }

  function flightsFor(slot, pid) {
    var n = 0;
    for (var i = 0; i < flights.length; i++) {
      if (flights[i].slot === slot && flights[i].pid === pid) n++;
    }
    return n;
  }

  function rebuildProduct(pid) {
    if (!pid) return;
    var product = G.data.productById(pid);
    if (!product) return;
    var psc = product.scale;
    var sVec = new THREE.Vector3(psc ? psc[0] : 1, psc ? psc[1] : 1, psc ? psc[2] : 1);
    // 取消该 pid 的挂起弹入（重建后实例下标会移位）
    for (var pi = instPops.length - 1; pi >= 0; pi--) {
      if (instPops[pi].pid === pid) instPops.splice(pi, 1);
    }
    var need = 0;
    for (var i = 0; i < allSlots.length; i++) {
      var s = allSlots[i];
      if (s.productId === pid) need += Math.min(s.count, 16);
    }
    if (need === 0) {
      if (instPools[pid]) instPools[pid].mesh.count = 0;
      if (instPools[pid]) instPools[pid].mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    var pool = ensurePool(pid, need);
    var at = 0;
    for (var j = 0; j < allSlots.length; j++) {
      var slot = allSlots[j];
      if (slot.productId !== pid) continue;
      var vis = Math.min(slot.count, 16) - flightsFor(slot, pid);   // 在飞的落位后才出现
      for (var k = 0; k < vis; k++) {
        _vp.copy(itemLocalPos(k, slot.faceZ)).add(slot.itemGroup.position);
        _m4.compose(_vp, _q, sVec);
        pool.mesh.setMatrixAt(at++, _m4);
      }
    }
    pool.mesh.count = at;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  /* 落位弹入：0.8→1.0 缩放重写单实例矩阵，90ms；rebuild 会取消挂起项 */
  function startInstancePop(pid, slot, idxInSlot) {
    var pool = instPools[pid];
    if (!pool || typeof requestAnimationFrame !== 'function') return;
    // 定位该 (slot, idxInSlot) 在池中的实例下标：按 rebuildProduct 的确定性顺序重算
    var at = 0, found = -1;
    for (var j = 0; j < allSlots.length; j++) {
      var s = allSlots[j];
      if (s.productId !== pid) continue;
      var vis = Math.min(s.count, 16) - flightsFor(s, pid);
      if (s === slot) {
        found = (idxInSlot < vis) ? at + idxInSlot : -1;
        break;
      }
      at += vis;
    }
    if (found < 0) return;
    // 立即以 0.8 缩放写入该实例矩阵，消除下一帧渲染前的全尺寸闪现
    var product = G.data.productById(pid);
    var psc = product && product.scale;
    var popVec0 = new THREE.Vector3(
      0.8 * (psc ? psc[0] : 1), 0.8 * (psc ? psc[1] : 1), 0.8 * (psc ? psc[2] : 1));
    _vp.copy(itemLocalPos(idxInSlot, slot.faceZ)).add(slot.itemGroup.position);
    _m4.compose(_vp, _q, popVec0);
    pool.mesh.setMatrixAt(found, _m4);
    pool.mesh.instanceMatrix.needsUpdate = true;
    instPops.push({ pid: pid, at: found, slot: slot, idxInSlot: idxInSlot, t0: Date.now() });
    if (!instPopRaf) { instPopRaf = true; requestAnimationFrame(stepInstancePops); }
  }

  function stepInstancePops() {
    var now = Date.now();
    for (var i = instPops.length - 1; i >= 0; i--) {
      var p = instPops[i];
      var pool = instPools[p.pid];
      if (!pool || p.at >= pool.mesh.count) { instPops.splice(i, 1); continue; }
      var k = Math.min(1, (now - p.t0) / 90);
      var sc = 0.8 + 0.2 * k;
      var product = G.data.productById(p.pid);
      var psc = product && product.scale;
      var popVec = new THREE.Vector3(
        sc * (psc ? psc[0] : 1), sc * (psc ? psc[1] : 1), sc * (psc ? psc[2] : 1));
      _vp.copy(itemLocalPos(p.idxInSlot, p.slot.faceZ)).add(p.slot.itemGroup.position);
      _m4.compose(_vp, _q, popVec);
      pool.mesh.setMatrixAt(p.at, _m4);
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (k >= 1) instPops.splice(i, 1);
    }
    if (instPops.length) requestAnimationFrame(stepInstancePops);
    else instPopRaf = false;
  }

  /* 每行 4 个、最多 4 行（DESIGN §5）：列距 0.14 使一格的堆宽 0.58 < 格间距 0.6；
     行沿格位深度向货架内侧排（层高只有 0.5m，竖着堆会穿过上层隔板） */
  function itemLocalPos(i, faceZ) {
    var col = i % 4, row = Math.floor(i / 4);
    var depth = -(faceZ || 1);
    return new THREE.Vector3((col - 1.5) * 0.14, 0, depth * (0.16 + row * 0.16));
  }

  // 价签条：宽同原挡板 0.55，高 0.06，厚 0.04（与层板等厚，见 buildRack 的 board）
  // 命中盒：占据该格商品应在的那块空气；高 0.46 而非 0.5，给上下两格留 0.04 空隙避免拾取歧义
  var TAG_GEO = null, HIT_GEO = null;
  function tagGeo() {
    if (!TAG_GEO) TAG_GEO = new THREE.BoxGeometry(0.55, 0.06, 0.04);
    return TAG_GEO;
  }
  function hitGeo() {
    if (!HIT_GEO) HIT_GEO = new THREE.BoxGeometry(0.55, 0.46, 0.5);
    return HIT_GEO;
  }

  // 价签贴图缓存：键为 (state|pid)，texture 跨格复用；材质仍逐格独立（见 CONTRACTS 职责裁定）。
  // 价格不入键：入键的话每改一次价就多留一张永不回收的贴图（C-T7 治漏）
  var TAG_TEX = {};
  var tagTexDisposed = 0;
  var TAG_BG = { stocked: null, out: '#E8B54C', empty: '#8C9AA6' };   // stocked 用类目色，运行时填

  function tagTexture(state, product, price) {
    var key = state + '|' + (product ? product.id : '-');
    var hit = TAG_TEX[key];
    // stocked 贴图上画了价格：同 pid 改价必须重绘。旧贴图当场 dispose 并删条目，不留在缓存里堆积。
    // 前提：改价路径必须把该 pid 的所有格位同步刷到新贴图（setPrice 与 load 后的全量重刷都做到了）。
    // 若某条路径漏刷，r128 不会渲染成黑——dispose() 只清 WebGLProperties，仍被引用的贴图下一帧会被
    // 静默重新上传，症状是显示旧价且显存又漏一份，比黑图更难发现。
    if (hit && state === 'stocked' && hit._price !== price) {
      hit.dispose();
      tagTexDisposed++;
      delete TAG_TEX[key];
      hit = null;
    }
    if (hit) return hit;

    var W = 256, H = 28;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');

    var bg = TAG_BG[state] || '#8C9AA6';
    if (state === 'stocked' && product) bg = '#' + ('000000' + (CAT_COLORS[product.cat] || 0x8C9AA6).toString(16)).slice(-6);
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    g.fillStyle = '#12161B';
    g.textBaseline = 'middle';
    if (state === 'empty') {
      g.font = '600 15px "Microsoft YaHei","PingFang SC",sans-serif';
      g.fillText('空', 8, H / 2);
    } else {
      g.font = '600 15px "Microsoft YaHei","PingFang SC",sans-serif';
      g.fillText(product ? product.name : '', 8, H / 2);
      var right = (state === 'out') ? '缺货' : ('¥' + price.toFixed(1));
      g.textAlign = 'right';
      g.fillText(right, W - 8, H / 2);
      g.textAlign = 'left';
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    tex._price = price;
    TAG_TEX[key] = tex;
    return tex;
  }

  function updateSlotTag(slot) {
    if (!slot || !slot.tagMesh) return;
    var product = slot.productId ? G.data.productById(slot.productId) : null;
    var state = !product ? 'empty' : (slot.count > 0 ? 'stocked' : 'out');
    var price = product ? ((G.state && G.state.prices && G.state.prices[product.id]) || product.market) : null;

    slot.tagState = state;
    slot.tagMesh.material.map = tagTexture(state, product, price);
    slot.tagMesh.material.color.setHex(0xFFFFFF);   // 贴图自带底色，材质色需为白，否则相乘变暗
    slot.tagMesh.material.needsUpdate = true;
  }

  // ---- 模块状态 ----
  var sceneRef = null;
  var allSlots = [];
  var interactables = [];
  var colliders = [];
  var registers = [];
  var shutterMeshes = [];
  var nav = { entry: null, exit: null, aisleSpots: [], registers: registers };

  // ---- C-T2 走廊节点图（从布局表推导；Dijkstra；门控 = node.enabled）----
  var navNodes = [];
  var NAV_INFLATE = 0.45;   // 线段-AABB 判定的膨胀半径（人身半径）

  function segBlocked(a, b) {
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      if (segHitsBox(a.x, a.z, b.x, b.z,
        c.minX - NAV_INFLATE, c.maxX + NAV_INFLATE, c.minZ - NAV_INFLATE, c.maxZ + NAV_INFLATE)) return true;
    }
    return false;
  }

  /* 2D 线段与 AABB 相交（slab 法，含端点在盒内的情形） */
  function segHitsBox(x1, z1, x2, z2, minX, maxX, minZ, maxZ) {
    var dx = x2 - x1, dz = z2 - z1;
    var t0 = 0, t1 = 1;
    var p = [-dx, dx, -dz, dz];
    var q = [x1 - minX, maxX - x1, z1 - minZ, maxZ - z1];
    for (var i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return false; continue; }
      var r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  }

  function addNavNode(x, z, zone) {
    var node = { p: new THREE.Vector3(x, 0, z), zone: zone, enabled: true, edges: [] };
    navNodes.push(node);
    return node;
  }

  function zoneOfPoint(x, z) {
    var keys = ['W', 'C', 'B', 'A'];   // core 兜底
    for (var i = 0; i < keys.length; i++) {
      var r = ZONE_RECTS[keys[i]];
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return keys[i];
    }
    return 'core';
  }

  function rebuildGraph() {
    navNodes.length = 0;
    // 1) 固定节点：entry/exit、主通道点、卷帘门内外点、收银台 front、走廊端点
    addNavNode(nav.entry.x, nav.entry.z, 'core');
    addNavNode(nav.exit.x, nav.exit.z, 'core');
    // 前厅横向走廊（z=5.3，贯穿 core）
    [-6, -2, 2, 6, 10, 14].forEach(function (x) { addNavNode(x, 5.3, 'core'); });
    // A/B 主过道（z=0）：区界两侧 + 各 rack aisleSpot 由下面统一加
    [1, 5, 9, 13].forEach(function (x) { addNavNode(x, 0, 'A'); });
    [-14, -10, -6, -2].forEach(function (x) { addNavNode(x, 0, 'B'); });
    // 前厅↔主过道竖向连接点（A 区开口 x=14 与 x=1.1 两条南北通路；x=1.1 订正：
    // 原 x=2 落在货架膨胀盒内，真实空隙在 x∈(0.65,1.55)，复核见 task-2-report.md）
    addNavNode(14, 2.6, 'A'); addNavNode(1.1, 2.6, 'A');
    // 修复：上面两个连接点缺 z=0 端点，与 A 主过道完全不连通（核对：无此两点时 entry→A区走廊 图论不可达）
    addNavNode(14, 0, 'A'); addNavNode(1.1, 0, 'A');
    // C 区走廊（z=-7）
    [-12, -6, 0, 6].forEach(function (x) { addNavNode(x, -7, 'C'); });
    // 卷帘门内外点。B 门列统一改 x=-4.2（原 x=-4 距冷藏膨胀边仅 0.05m，弃用）：
    // 门外(-4.2,4.9)—前厅接点(-4.2,5.3)—门内(-4.2,3.1)—B 内竖廊底(-4.2,0) 四点同列串联，
    // 复核余量：距翼墙膨胀边 0.35m+ / 距冷藏膨胀边 0.25m+
    addNavNode(-4.2, 5.3, 'core');
    addNavNode(-4.2, 4.9, 'core'); addNavNode(-4.2, 3.1, 'B');    // 门 B
    addNavNode(-4.2, 0, 'B');
    addNavNode(4, -3.1, 'A');   addNavNode(4, -4.9, 'C');     // 门 C
    addNavNode(5, -3.1, 'A');    // C 门 A 侧接入 A 主过道 x=5（(4,-3.1)-(5,-3.1)-(5,0) 两段无遮挡）
    addNavNode(4, -7, 'C');      // C 门 C 侧接入 C 走廊（原 brief 只接了 A 侧，C 侧仍孤立，补一点用 x=4 列打通）
    addNavNode(-7.1, 5.3, 'core');   // W 门前厅接点（原 (-7.1,7) 与前厅走廊无公共坐标，孤立）
    addNavNode(-7.1, 7, 'core'); addNavNode(-8.9, 7, 'W');    // 门 W
    // rack aisleSpot（已建的进 aisleSpots；未建区域的按表预置节点，enabled 随 zone）
    for (var si = 0; si < SHELF_TABLE.length; si++) {
      var st = SHELF_TABLE[si];
      addNavNode(st.x, st.aisleZ, st.zone);
    }
    for (var fi = 0; fi < FRIDGE_TABLE.length; fi++) {
      var ft = FRIDGE_TABLE[fi];
      addNavNode(ft.x, ft.aisleZ, ft.zone);
    }
    // 收银台队尾（core）：front（z=6.8）节点不建——三台收银台的 front 坐标都落在
    // 各自柜台膨胀盒内，任何方向的出边判定都会自阻塞，是永远零边的死节点；
    // 交给 nearestNode 的降级兜底去接最近的通路节点，最后一段直线短接（可接受）
    for (var ri = 0; ri < REGISTER_TABLE.length; ri++) {
      /* R1（zone 'core'，x=-2）跳过：z=+4 内墙铺到 x=0、门缺口只在 x∈[-5,-3]，
         它的队尾点 (-2,3.8) 落在该墙膨胀带内 0.45m 深，是全图唯一的零边死节点——
         既接不上前厅走廊，又给人「这里有通路」的假象（断言 nav.noDeadNodes 守）。
         R2/R3 处该墙不存在，节点有效。 */
      if (REGISTER_TABLE[ri].zone === 'core') continue;
      addNavNode(REGISTER_TABLE[ri].x, 3.8, 'core');
    }
    // 仓库内部两点 + 卸货区两点（西卸货点订正 z=5.5→7：西门缺口膨胀后可通行带 z∈(6.45,7.55)）
    addNavNode(-11.9, 7, 'W'); addNavNode(-14, 7, 'W');
    addNavNode(18, 7.7, 'core'); addNavNode(-18, 7, 'W');
    // 2) 启用态
    syncNavGates();
    // 3) 连边：轴对齐 + ≤10m + 无遮挡
    for (var i = 0; i < navNodes.length; i++) {
      for (var j = i + 1; j < navNodes.length; j++) {
        var a = navNodes[i], b = navNodes[j];
        var ax = Math.abs(a.p.x - b.p.x), az = Math.abs(a.p.z - b.p.z);
        if (ax > 0.05 && az > 0.05) continue;
        var d = a.p.distanceTo(b.p);
        if (d > 10 || d < 0.01) continue;
        if (segBlocked(a.p, b.p)) continue;
        a.edges.push({ idx: j, w: d });
        b.edges.push({ idx: i, w: d });
      }
    }
  }

  function syncNavGates() {
    var zones = (G.state && G.state.zones) || { A: true };
    for (var i = 0; i < navNodes.length; i++) {
      var n = navNodes[i];
      n.enabled = (n.zone === 'core') || !!zones[n.zone];
    }
  }

  function nearestNode(p) {
    var best = -1, bd = Infinity, bestAny = -1, bdAny = Infinity;
    for (var i = 0; i < navNodes.length; i++) {
      var n = navNodes[i];
      if (!n.enabled) continue;
      var d = n.p.distanceToSquared(p);
      if (d < bdAny) { bdAny = d; bestAny = i; }
      if (d < bd && !segBlocked(p, n.p)) { bd = d; best = i; }
    }
    return best >= 0 ? best : bestAny;
  }

  function findPath(from, to) {
    if (!navNodes.length) return [];
    // 修复：nearestNode 降级（I2）只忽略视线遮挡，不管门控——查询点落在未购区域时，
    // bestAny 会无视墙体直接抓一个"最近的已连通节点"当作 t，等于把锁区凿穿。
    // 目的地本身若在未购区域，直接判不可达，不进入降级逻辑。
    var toZone = zoneOfPoint(to.x, to.z);
    var gateZones = (G.state && G.state.zones) || { A: true };
    if (toZone !== 'core' && !gateZones[toZone]) return [];
    var s = nearestNode(from), t = nearestNode(to);
    if (s < 0 || t < 0) return [];
    // Dijkstra（N~70，线性扫描堆足够）
    var dist = [], prev = [], done = [];
    for (var i = 0; i < navNodes.length; i++) { dist[i] = Infinity; prev[i] = -1; done[i] = false; }
    dist[s] = 0;
    for (var iter = 0; iter < navNodes.length; iter++) {
      var u = -1, ud = Infinity;
      for (var k = 0; k < navNodes.length; k++) {
        if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; }
      }
      if (u < 0 || u === t) break;
      done[u] = true;
      var edges = navNodes[u].edges;
      for (var e = 0; e < edges.length; e++) {
        var v = edges[e].idx;
        if (!navNodes[v].enabled || done[v]) continue;
        var nd = dist[u] + edges[e].w;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
      }
    }
    if (dist[t] === Infinity) return [];
    var out = [];
    var cur = t;
    while (cur !== -1) { out.unshift(navNodes[cur].p.clone()); cur = prev[cur]; }
    out.push(new THREE.Vector3(to.x, 0, to.z));
    // 首节点若与起点视线通畅且距离近可省略——保持简单：不裁剪
    return out;
  }

  var cashierGroups = [];   // index → 站桩 Group（逐台惰性构造）

  function registerInteractable(obj3D, opts) {
    var entry = { mesh: obj3D, type: opts.type, data: opts.data || {}, prompt: opts.prompt || '' };
    interactables.push(entry);
    obj3D.traverse(function (o) { o.userData.interactable = entry; });
    return entry;
  }

  function retireInteractable(obj3D) {
    for (var i = interactables.length - 1; i >= 0; i--) {
      if (interactables[i].mesh === obj3D) interactables.splice(i, 1);
    }
  }

  function addMesh(mesh, cast, receive) {
    if (G.tex && G.tex.on) {
      mesh.castShadow = !!cast;
      mesh.receiveShadow = !!receive;
    }
    sceneRef.add(mesh);
    return mesh;
  }

  // 壳体（地板/天花板/墙/门框柱/卸货区地面）标记：几何启发式覆盖不到小跨度壳体（如东墙缺口段、门框柱），
  // 断言 shadow.shellNoCast 需要一个不依赖尺寸的兜底判据
  function addShell(m) { m.userData.shell = true; return addMesh(m, false, true); }

  function flatMat(color, opts) {
    var params = { color: color, flatShading: true };
    if (opts) { for (var k in opts) params[k] = opts[k]; }
    return new THREE.MeshLambertMaterial(params);
  }

  // ---------------------------------------------------------------
  // 静态建筑几何
  // ---------------------------------------------------------------
  /* 墙面材质：每段一份（wallWainscot 的 repeat 按段长/2 定，不同段不能共用） */
  function wallMat(segLen) {
    return flatMat(G.tex.on ? 0xFFFFFF : 0xEFE9DE,
      G.tex.on ? { map: G.tex.wallWainscot(segLen / 2, 1) } : null);
  }

  /* 一段沿 x 铺开的墙（z 为墙面中线）：mesh + 一条厚 ±0.2 的 collider。
     collider 的可选字段 h（米）：读者有两处——G.physics.syncStatics（建静态刚体）与
     player.boxFitsAt（D-T3 钳投掷出手点），且两者必须一律经 G.physics.heightOf(collider)
     取值，不得各抄一份「缺省 = WALL_H」（口径漂移会让钳位按错误高度放行，投掷穿墙缺陷重开）。
     寻路与玩家碰撞只读 minX/maxX/minZ/maxZ 四个 2D 字段，加 h 对它们零影响。 */
  function wallAlongX(x0, x1, z) {
    var len = x1 - x0;
    var m = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, WALL_T), wallMat(len));
    m.position.set((x0 + x1) / 2, WALL_H / 2, z);
    addShell(m);
    colliders.push({ minX: x0, maxX: x1, minZ: z - 0.2, maxZ: z + 0.2 });
  }

  /* 一段沿 z 铺开的墙（x 为墙面中线） */
  function wallAlongZ(x, z0, z1) {
    var len = z1 - z0;
    var m = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, len), wallMat(len));
    m.position.set(x, WALL_H / 2, (z0 + z1) / 2);
    addShell(m);
    colliders.push({ minX: x - 0.2, maxX: x + 0.2, minZ: z0, maxZ: z1 });
  }

  /* 卷帘门：关着时挡视线也挡人；buildZone 按 userData.shutter / collider.zoneGate 一并解除 */
  function buildShutters() {
    for (var i = 0; i < SHUTTERS.length; i++) {
      var s = SHUTTERS[i];
      var alongX = (s.minX != null);
      var w = alongX ? (s.maxX - s.minX) : (s.maxZ - s.minZ);
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, 3.0, 0.12),
        flatMat(0x9AA4AE, G.tex.on ? { map: G.tex.shelfMetal(2, 3) } : null));
      if (alongX) {
        m.position.set((s.minX + s.maxX) / 2, 1.5, s.z);
        colliders.push({ minX: s.minX, maxX: s.maxX, minZ: s.z - 0.2, maxZ: s.z + 0.2, zoneGate: s.zone, h: 3.0 });
      } else {
        m.position.set(s.x, 1.5, (s.minZ + s.maxZ) / 2);
        m.rotation.y = Math.PI / 2;
        colliders.push({ minX: s.x - 0.2, maxX: s.x + 0.2, minZ: s.minZ, maxZ: s.maxZ, zoneGate: s.zone, h: 3.0 });
      }
      m.userData.shutter = s.zone;
      addMesh(m, false, true);
      shutterMeshes.push(m);
      registerInteractable(m, {
        type: 'shutter',
        data: { zone: s.zone, label: s.label },
        prompt: ''   // 文案由 player.computePrompt 按条件生成（T3）
      });
    }
  }

  function buildRoom() {
    // 地板
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF_X * 2, ROOM_HALF_Z * 2),
      flatMat(G.tex.on ? 0xFFFFFF : 0xD8D2C6, G.tex.on ? { map: G.tex.floorWood(16, 10) } : null));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    addShell(floor);

    // 天花板
    var ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF_X * 2, ROOM_HALF_Z * 2),
      flatMat(G.tex.on ? 0xFFFFFF : 0xF5F2EC, G.tex.on ? { map: G.tex.ceilingPanel(26.7, 16.7) } : null));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, WALL_H, 0);
    addShell(ceiling);

    // 外墙 6 段：西墙留送货门缺口 z∈[6,8]，东墙留顾客门缺口 z∈[4.4,6.2]
    wallAlongZ(-ROOM_HALF_X, -ROOM_HALF_Z - 0.2, 6);
    wallAlongZ(-ROOM_HALF_X, 8, ROOM_HALF_Z + 0.2);
    wallAlongX(-ROOM_HALF_X - 0.2, ROOM_HALF_X + 0.2, -ROOM_HALF_Z);
    wallAlongX(-ROOM_HALF_X - 0.2, ROOM_HALF_X + 0.2, ROOM_HALF_Z);
    wallAlongZ(ROOM_HALF_X, -ROOM_HALF_Z - 0.2, 4.4);
    wallAlongZ(ROOM_HALF_X, 6.2, ROOM_HALF_Z + 0.2);

    // 内隔墙 7 段：z=-4（C 门缺口 x∈[3,5]）、z=+4 半宽（B 门缺口 x∈[-5,-3]）、x=-8 仓库东墙（W 门缺口 z∈[6,8]）
    wallAlongX(-ROOM_HALF_X, 3, -4);
    wallAlongX(5, ROOM_HALF_X, -4);
    wallAlongX(-ROOM_HALF_X, -5, 4);
    wallAlongX(-3, 0, 4);
    wallAlongZ(-8, 4, 6);
    wallAlongZ(-8, 8, ROOM_HALF_Z + 0.2);
    // A↔B 区界墙（无缺口）：B 区只经前厅的 B 卷帘门进入，分区商场动线
    wallAlongZ(0, -4, 4);

    buildShutters();

    // 门框（装饰立柱）：顾客门（东）+ 送货门（西）各两根
    var frameMat = flatMat(0x7A6A55);
    var postGeo = new THREE.BoxGeometry(0.15, WALL_H, 0.15);
    [[ROOM_HALF_X, 4.4], [ROOM_HALF_X, 6.2], [-ROOM_HALF_X, 6], [-ROOM_HALF_X, 8]].forEach(function (p, i) {
      var post = new THREE.Mesh(i === 0 ? postGeo : postGeo.clone(), frameMat);
      post.position.set(p[0], WALL_H / 2, p[1]);
      addShell(post);
    });

    // 卸货区地面：东西两侧各一整块混凝土，铺满各自围栏footprint（围栏中线即地面边界），
    // 否则玩家出门/绕行时踩虚空。东 x[16,20] z[2,10]；西 x[-20,-16] z[3.5,10.5]
    // （西侧原 z[4.1,7.3] 短于围栏 z[3.5,10.5]，且送货门缺口 z∈[6,8] 的北半 0.7m 门槛悬空）
    var yardE = new THREE.Mesh(new THREE.PlaneGeometry(4, 8),
      flatMat(G.tex.on ? 0xFFFFFF : 0xC7BEAF, G.tex.on ? { map: G.tex.yardConcrete(2, 4) } : null));
    yardE.rotation.x = -Math.PI / 2;
    yardE.position.set(18, 0.001, 6);
    addShell(yardE);
    var yardW = new THREE.Mesh(new THREE.PlaneGeometry(4, 7),
      flatMat(G.tex.on ? 0xFFFFFF : 0xC7BEAF, G.tex.on ? { map: G.tex.yardConcrete(2, 3.5) } : null));
    yardW.rotation.x = -Math.PI / 2;
    yardW.position.set(-18, 0.001, 7);
    addShell(yardW);

    // 世界边界围栏（东西两侧各三条）：收在混凝土地面范围内，玩家出门后不得踩虚空。
    // 东 z∈[2,10]（门 4.4-6.2 / 箱位 6.9-8.5 / nav.exit 5.3 均在内）；西 z∈[3.5,10.5]
    colliders.push({ minX: 20, maxX: 20.4, minZ: 1.8, maxZ: 10.2 });
    colliders.push({ minX: ROOM_HALF_X, maxX: 20.4, minZ: 1.8, maxZ: 2.2 });
    colliders.push({ minX: ROOM_HALF_X, maxX: 20.4, minZ: 9.8, maxZ: 10.2 });
    colliders.push({ minX: -20.4, maxX: -20, minZ: 3.3, maxZ: 10.7 });
    colliders.push({ minX: -20.4, maxX: -ROOM_HALF_X, minZ: 3.3, maxZ: 3.7 });
    colliders.push({ minX: -20.4, maxX: -ROOM_HALF_X, minZ: 10.3, maxZ: 10.7 });

    buildRegister(0);
    buildComputer();
    buildTrash();

    // 导航点
    nav.entry = new THREE.Vector3(15.2, 0, 5.3);
    // 出口在门外人行道（GDD §6.5 顾客「从 nav.exit 走出」），避开 YARD_EAST 的箱位
    nav.exit = new THREE.Vector3(18, 0, 5.3);
    nav.findPath = findPath;
    nav.rebuildGraph = rebuildGraph;
    nav._segBlocked = segBlocked;
    nav._nodes = navNodes;   // 自测钩子：死节点/连通性探针
  }

  function buildRegister(i) {
    var def = REGISTER_TABLE[i];
    var body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 1.2),
      flatMat(G.tex.on ? 0xFFFFFF : 0x6E7A88, G.tex.on ? { map: G.tex.counterLaminate(1.2, 2) } : null));
    body.position.set(def.x, 0.5, REGISTER_Z);
    addMesh(body, true, true);
    var belt = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.9),
      flatMat(0x4E5866, G.tex.on ? { map: G.tex.beltRubber(3, 5) } : null));
    belt.position.set(def.x, 1.04, REGISTER_Z);
    belt.userData.belt = true;
    belt.userData.registerId = i;
    addMesh(belt, true, true);
    // h = 传送带顶面 1.08（1.6×0.9 的传送带完全落在 2.0×1.2 的柜体足迹内），箱可以扔上台面
    colliders.push({ minX: def.x - 1.0, maxX: def.x + 1.0, minZ: REGISTER_Z - 0.6, maxZ: REGISTER_Z + 0.6, h: 1.08 });
    var front = new THREE.Vector3(def.x, 0, 6.8);
    var spots = [];
    QUEUE_ZS.forEach(function (z) { spots.push(new THREE.Vector3(def.x, 0, z)); });
    var reg = { index: i, mesh: body, beltMesh: belt, front: front, queueSpots: spots, zone: def.zone };
    // registers 与 nav.registers 是同一个数组（模块级同源同引用），只推一次
    registers.push(reg);
    if (G.state && G.state.registers && G.state.registers[i]) G.state.registers[i].owned = true;
    registerInteractable(body, { type: 'register', data: { register: reg }, prompt: '[E] 进入收银台' });
    return reg;
  }

  function registerAt(i) {
    for (var k = 0; k < registers.length; k++) { if (registers[k].index === i) return registers[k]; }
    return null;
  }

  function buildComputer() {
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.4), flatMat(0x3A424C));
    body.position.set(14, 0.45, 9.4);
    addMesh(body, true, true);
    // 屏幕在机身 -z 侧，即面朝店内
    var screen = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.03), flatMat(0x4C9BE8));
    screen.position.set(14, 0.85, 9.18);
    addMesh(screen, true, true);
    colliders.push({ minX: 13.75, maxX: 14.25, minZ: 9.2, maxZ: 9.6, h: 0.9 });
    registerInteractable(body, { type: 'computer', data: {}, prompt: '[E] 打开订货电脑' });
  }

  function buildTrash() {
    // 前厅（core）南墙边：全期一处，不随仓库开放而移动
    var bin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.25, 0.6, 8), flatMat(0x5A6B5E));
    bin.position.set(-7.4, 0.3, 9.4);
    addMesh(bin, true, true);
    // 已知瑕疵：桶是圆柱 mesh 但 collider 是 0.6×0.6 方盒，箱会以方形边界弹开（观感可接受）
    colliders.push({ minX: -7.7, maxX: -7.1, minZ: 9.1, maxZ: 9.7, h: 0.6 });
    registerInteractable(bin, { type: 'trash', data: {}, prompt: '[E] 丢弃纸箱' });
  }

  // ---------------------------------------------------------------
  // 仓库存储架（C-T4）：W 区开放后建 24 个地面位标记，玩家可暂存纸箱
  // ---------------------------------------------------------------
  var storageSlots = [];
  var STORAGE_MARKER_GEO = null;   // 24 个标记共用一套几何（材质必须逐个独立，否则高亮一个全亮）

  function buildStorage() {
    if (storageSlots.length) return;
    if (!STORAGE_MARKER_GEO) STORAGE_MARKER_GEO = new THREE.BoxGeometry(0.6, 0.02, 0.6);
    for (var i = 0; i < STORAGE_TABLE.length; i++) {
      var p = STORAGE_TABLE[i];
      var marker = new THREE.Mesh(STORAGE_MARKER_GEO,
        flatMat(G.tex.on ? 0xFFFFFF : 0x8C9AA6, G.tex.on ? { map: G.tex.shelfMetal(1, 1) } : null));
      marker.position.set(p.x, 0.01, p.z);
      addMesh(marker, false, true);
      var slot = { id: 'st' + i, pos: new THREE.Vector3(p.x, 0, p.z), marker: marker, box: null };
      storageSlots.push(slot);
      registerInteractable(marker, { type: 'storage', data: { slot: slot }, prompt: '' });
    }
  }

  function storeBox(slot, box) {
    if (!slot || slot.box || !box || !box.mesh) return false;
    releaseStorageOf(box);   // 同一箱可能已占别位（直调 API 的读档/测试路径）：先解绑，杜绝「一箱两位」
    slot.box = box;
    box.mesh.position.set(slot.pos.x, 0.225, slot.pos.z);
    box.mesh.rotation.set(0, 0, 0);
    // slotted 锁死为静态刚体：休眠动态体被撞醒会离开存储位而 slot.box 仍指着它
    if (G.physics) { G.physics.detach(box); G.physics.attachStatic(box); }
    // 重新注册为可交互箱（玩家举起时已被 removeInteractable；放回存储位即恢复）。
    // registerBoxInteractable 起手 retire 一次保证「一 mesh 一交互体」：玩家路径下是空转，
    // 直接调 API 存箱时防重复登记。
    registerBoxInteractable(box);
    return true;
  }

  function takeBox(slot) {
    if (!slot || !slot.box) return null;
    var box = slot.box;
    slot.box = null;
    if (G.physics) G.physics.detach(box);   // 调用方接手定位；不留静态刚体钉在原位
    return box;
  }

  /* 玩家直接对存储位上的箱按 E 搬起时（不走 takeBox），由 player.pickUpBox 调用清位 */
  function releaseStorageOf(box) {
    for (var i = 0; i < storageSlots.length; i++) {
      if (storageSlots[i].box === box) { storageSlots[i].box = null; return; }
    }
  }

  function serializeStorage() {
    var out = [];
    for (var i = 0; i < storageSlots.length; i++) {
      var s = storageSlots[i];
      if (s.box) out.push({ id: s.id, pid: s.box.productId, left: s.box.itemsLeft });
    }
    return out;
  }

  function restoreStorage(data) {
    if (!Array.isArray(data)) return;
    for (var i = 0; i < data.length; i++) {
      var d = data[i];
      var slot = null;
      for (var j = 0; j < storageSlots.length; j++) { if (storageSlots[j].id === d.id) { slot = storageSlots[j]; break; } }
      if (!slot || slot.box) continue;
      var box = spawnBox(d.pid, slot.pos);
      if (!box) continue;
      box.itemsLeft = d.left || 0;
      updateBoxVisual(box);
      storeBox(slot, box);
    }
  }

  /* 区域开放（幂等）：置位 + 视觉 + 物理的单一入口，调用方无需再关心先后次序 */
  function buildZone(zone) {
    var i;
    if (G.state && G.state.zones) G.state.zones[zone] = true;
    for (i = 0; i < shutterMeshes.length; i++) {
      if (shutterMeshes[i].userData.shutter !== zone) continue;
      shutterMeshes[i].visible = false;
      // r128 的 Raycaster 不看 visible：隐形卷帘门会截胡穿过门洞的准星射线
      // （门 collider 同时被移除，player.occluded() 也拦不住），交互体必须一并摘除
      retireInteractable(shutterMeshes[i]);
    }
    for (i = colliders.length - 1; i >= 0; i--) {
      if (colliders[i].zoneGate === zone) colliders.splice(i, 1);
    }
    syncLayout();
    if (zone === 'B' && !registerAt(1)) buildRegister(1);
    if (zone === 'C' && !registerAt(2)) buildRegister(2);
    if (zone === 'W') buildStorage();
    rebuildGraph();   // 该区货架建造新增 collider → 边失效，全量重建（微秒级）
    if (G.physics) G.physics.syncStatics();   // 静态刚体与 colliders 同源，绝不留第二份
  }

  // ---------------------------------------------------------------
  // 收银员站桩（GDD §9 / CONTRACTS.md setCashierVisible）
  // 复用顾客 9 件构造（G.customers.buildFigure），固定形象；站在本台柜台南侧的
  // 0.8m 员工通道内（躯干 0.234 / 鞋 0.22 / 短块发 0.29 的进深沿 z 轴），面朝 -z 的顾客方向。
  function buildCashierFigure(reg) {
    var body = G.customers.buildFigure({
      shirt: '#4C9BE8',   // CONTRACTS：制服固定色
      pants: '#2E3742',
      skin: '#D9A878',
      hair: '#2A2118',
      hairStyle: 0,       // 短块：深度 0.29 最浅（后长 0.34/平顶 0.31 更占通道）
      h: 1.0, w: 1.0
    });
    var group = body.group;
    group.position.set(reg.front.x, 0, 8.55);
    group.rotation.y = Math.PI;   // 面朝 -z：传送带 / 排队方向
    return group;
  }

  /* 幂等；index 指定收银台（未建造的台静默忽略） */
  function setCashierVisible(index, visible) {
    var i = index | 0;
    visible = !!visible;
    var group = cashierGroups[i] || null;
    if (visible === !!(group && group.parent)) return;
    if (visible) {
      var reg = registerAt(i);
      if (!reg) return;
      if (!group) { group = buildCashierFigure(reg); cashierGroups[i] = group; }
      if (sceneRef) sceneRef.add(group);
    } else if (group && group.parent) {
      group.parent.remove(group);
    }
  }

  // ---------------------------------------------------------------
  // 货架 / 冷藏柜
  // ---------------------------------------------------------------
  function buildRack(idPrefix, centerX, centerZ, isFridge, aisleZ) {
    var group = new THREE.Group();
    var facing = (aisleZ > centerZ) ? 1 : -1;   // 朝向本行的走廊
    var frontZ = centerZ + facing * (SHELF_D / 2);
    var backZ = centerZ - facing * (SHELF_D / 2 - 0.025);

    var frameColor = 0x8C9AA6;
    // 货架框架（buildRack 的 frameColor 材质，back/side/board 共用一份新建材质）
    var frameMat = flatMat(G.tex.on ? 0xFFFFFF : frameColor,
      G.tex.on ? { map: (isFridge ? G.tex.fridgeSteel(4, 4) : G.tex.shelfMetal(4, 4)) } : null);
    var back = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W, SHELF_H, 0.05), frameMat);
    back.position.set(centerX, SHELF_H / 2, backZ);
    back.castShadow = back.receiveShadow = !!(G.tex && G.tex.on);
    group.add(back);

    var sideGeo = new THREE.BoxGeometry(0.05, SHELF_H, SHELF_D);
    var sideL = new THREE.Mesh(sideGeo, frameMat);
    sideL.position.set(centerX - SHELF_W / 2, SHELF_H / 2, centerZ);
    sideL.castShadow = sideL.receiveShadow = !!(G.tex && G.tex.on);
    group.add(sideL);
    var sideR = new THREE.Mesh(sideGeo.clone(), frameMat);
    sideR.position.set(centerX + SHELF_W / 2, SHELF_H / 2, centerZ);
    sideR.castShadow = sideR.receiveShadow = !!(G.tex && G.tex.on);
    group.add(sideR);

    SLOT_HEIGHTS.forEach(function (y) {
      var board = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W, 0.04, SHELF_D), frameMat);
      board.position.set(centerX, y - 0.04, centerZ);
      board.castShadow = board.receiveShadow = !!(G.tex && G.tex.on);
      group.add(board);
    });

    if (isFridge) {
      var glass = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W, SHELF_H, 0.03),
        flatMat(0xBFE3EC, { transparent: true, opacity: 0.35 }));
      glass.position.set(centerX, SHELF_H / 2, frontZ);
      group.add(glass);
    }

    sceneRef.add(group);

    var aisleSpot = new THREE.Vector3(centerX, 0, aisleZ);
    var groupSlots = [];
    SLOT_HEIGHTS.forEach(function (y, rowIdx) {
      SLOT_LOCAL_X.forEach(function (lx, ci) {
        var id = idPrefix + '_' + rowIdx + '_' + ci;
        var pos = new THREE.Vector3(centerX + lx, y, frontZ);

        var holder = new THREE.Group();

        // 不可见命中盒：射线靶子。本构建 Raycaster 不检查 visible（已验证），
        // visible=false 让渲染器跳过它 → 省 60 个透明 pass draw call；opacity 0 保留兜底。
        var hit = new THREE.Mesh(hitGeo(), flatMat(0xFFFFFF, {
          transparent: true, opacity: 0, depthWrite: false
        }));
        hit.position.set(pos.x, y + 0.23, frontZ - facing * 0.25);
        hit.visible = false;
        holder.add(hit);

        // 可见价签：贴在该格下方层板（y-0.04）的前缘；同时是准星高亮的载体
        // 价签不得再加厚或前移：player.js occluded() 自碰撞容差余量仅 0.01m，超出即全部上架射线失效
        var tag = new THREE.Mesh(tagGeo(), flatMat(0x8C9AA6));
        tag.position.set(pos.x, y - 0.055, frontZ + facing * 0.02);
        holder.add(tag);

        sceneRef.add(holder);

        var itemGroup = new THREE.Group();
        itemGroup.position.copy(pos);
        sceneRef.add(itemGroup);

        var slot = {
          id: id, pos: pos, productId: null, count: 0, fridge: !!isFridge,
          marker: holder, tagMesh: tag, hitMesh: hit,
          itemGroup: itemGroup, aisleSpot: aisleSpot, faceZ: facing
        };
        groupSlots.push(slot);
        allSlots.push(slot);
        registerInteractable(holder, { type: 'shelfSlot', data: { slot: slot }, prompt: '' });
        updateSlotTag(slot);
      });
    });

    colliders.push({ minX: centerX - SHELF_W / 2, maxX: centerX + SHELF_W / 2, minZ: centerZ - SHELF_D / 2, maxZ: centerZ + SHELF_D / 2, h: SHELF_H });
    nav.aisleSpots.push(aisleSpot);

    return { group: group, slots: groupSlots, aisleSpot: aisleSpot };
  }

  /* 分区惰性建造（幂等）：已开放区域的整行货架一次补齐；建造去重靠行上的 _built 标记。
     建了货架就重建导航图：每组货架带一个 collider，既有边可能被它打断。当前表里的行
     恰好都不跨 z=0 主过道故实测无边受影响（C-终审复核：冷藏 collider 新增 4 个、
     192 条既有边无一被打断），但只要将来任何 SHELF_TABLE/FRIDGE_TABLE 行的 |z| < 0.75，
     或新增跨 z=0 的 collider，不重建就会静默留下穿墙边。rebuildGraph 是微秒级，不省。 */
  function syncLayout() {
    if (!sceneRef) return;
    var zones = (G.state && G.state.zones) || { A: true };
    var licenses = (G.state && G.state.licenses) || [];
    var fresh = licenses.indexOf('生鲜') !== -1;
    var built = 0;

    SHELF_TABLE.forEach(function (row, i) {
      if (row._built || !zones[row.zone]) return;
      buildRack('shelf' + i, row.x, row.z, false, row.aisleZ);
      row._built = true;
      built++;
    });

    // 冷藏柜：区域开放 × 生鲜许可证 双门槛
    FRIDGE_TABLE.forEach(function (row, i) {
      if (row._built || !zones[row.zone] || !fresh) return;
      buildRack('fridge' + i, row.x, row.z, true, row.aisleZ);
      row._built = true;
      built++;
    });

    if (built > 0 && nav.entry) {
      rebuildGraph();
      if (G.physics) G.physics.syncStatics();
    }
  }

  // ---------------------------------------------------------------
  // 格位可见商品堆
  // ---------------------------------------------------------------
  function updateSlotVisual(slot) {
    var old = slot._visPid;
    if (old !== slot.productId) {
      if (old) rebuildProduct(old);
      slot._visPid = slot.productId;
    }
    if (slot.productId) rebuildProduct(slot.productId);
  }

  /* DESIGN §6：商品自纸箱位置直线飞向目标格位，180ms ease-out。
     纯视觉，与逻辑解耦——addItem 返回时商品在逻辑上已在格内。自驱 rAF，不接主循环 dt。 */
  var flights = [];
  var flightRaf = false;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function flyItem(slot, product, fromPos, targetLocal, idx) {
    if (!sceneRef || typeof requestAnimationFrame !== 'function') return null;
    var mesh = new THREE.Mesh(itemGeoFor(product.id), itemMatFor(product.id));
    mesh.position.copy(fromPos);
    var psc = product.scale;
    if (psc) mesh.scale.set(psc[0], psc[1], psc[2]);
    sceneRef.add(mesh);

    var to = slot.itemGroup.position.clone().add(targetLocal);
    var f = { mesh: mesh, from: fromPos.clone(), to: to, t0: Date.now(), slot: slot, onDone: null, pid: product.id, idx: idx };
    flights.push(f);
    if (!flightRaf) { flightRaf = true; requestAnimationFrame(stepFlights); }
    return f;
  }

  function stepFlights() {
    var now = Date.now();
    for (var i = flights.length - 1; i >= 0; i--) {
      var f = flights[i];
      if (f.slot.productId !== f.pid || f.slot.count <= f.idx) {
        if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
        flights.splice(i, 1);
        rebuildProduct(f.pid);   // 中断销毁：不调 onDone，但需同步实例（count 已变）
        continue;   // 格位已被清空/换商品（spec §5.2）
      }
      var k = Math.min(1, (now - f.t0) / 180);
      f.mesh.position.lerpVectors(f.from, f.to, easeOutCubic(k));
      if (k >= 1) {
        if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
        flights.splice(i, 1);
        if (f.onDone) f.onDone();
      }
    }
    if (flights.length) requestAnimationFrame(stepFlights);
    else flightRaf = false;
  }

  // ---------------------------------------------------------------
  // 格位查找 / 存取
  // ---------------------------------------------------------------
  function findEmptyOrMatchingSlot(pid) {
    var product = G.data.productById(pid);
    if (!product) return null;
    var wantFridge = product.cat === '生鲜';
    for (var i = 0; i < allSlots.length; i++) {
      var slot = allSlots[i];
      if (slot.fridge !== wantFridge) continue;
      if (slot.productId === null) return slot;
      if (slot.count === 0) return slot;                              // 缺货格可改放任意商品
      if (slot.productId === pid && slot.count < product.slotCap) return slot;
    }
    return null;
  }

  function findSlotWithProduct(pid) {
    for (var i = 0; i < allSlots.length; i++) {
      var slot = allSlots[i];
      if (slot.productId === pid && slot.count > 0) return slot;
    }
    return null;
  }

  function addItem(slot, pid, fromPos) {
    if (!slot) return false;
    var product = G.data.productById(pid);
    if (!product) return false;
    if (slot.fridge && product.cat !== '生鲜') return false;
    if (!slot.fridge && product.cat === '生鲜') return false;
    if (slot.productId && slot.count > 0 && slot.productId !== pid) return false;
    if (slot.productId === pid && slot.count >= product.slotCap) return false;
    slot.productId = pid;
    slot.count += 1;
    var idx = slot.count - 1;
    updateSlotTag(slot);

    if (fromPos && idx < 16) {
      // 先飞，落位后才让正式方块出现；飞行期间格内少一个方块（180ms，肉眼等价于「正在放上去」）
      var local = itemLocalPos(idx, slot.faceZ);
      var f = flyItem(slot, product, fromPos, local, idx);
      if (f) {
        f.onDone = function () {
          updateSlotVisual(slot);
          startInstancePop(pid, slot, idx);
        };
        return true;
      }
    }

    updateSlotVisual(slot);
    if (idx < 16) startInstancePop(pid, slot, idx);
    return true;
  }

  function removeItem(slot) {
    if (!slot || !slot.productId || slot.count <= 0) return false;
    slot.count -= 1;
    // count 归零后保留 productId，价签才能显示「缺货」而非「空」；
    // findEmptyOrMatchingSlot 视 count===0 的格为可用（其 `if (slot.count === 0) return slot;` 分支）
    updateSlotVisual(slot);
    updateSlotTag(slot);
    return true;
  }

  function getStockCount(pid) {
    var total = 0;
    for (var i = 0; i < allSlots.length; i++) {
      if (allSlots[i].productId === pid) total += allSlots[i].count;
    }
    return total;
  }

  // ---------------------------------------------------------------
  // 纸箱
  // ---------------------------------------------------------------
  function updateBoxVisual(box) {
    if (!box) return;
    var empty = box.itemsLeft <= 0;
    box.body.material.color.set(empty ? 0x8A6538 : 0xC08B4E);
  }

  /* mesh 是否停在当前卸货区的某个箱位上（判据与 freeYardSlot 的占用检测一致）。
     订单容量校验用：仓库存储位与店内搬运中的箱都不算在卸货区 12 位里 */
  function isOnYard(mesh) {
    if (!mesh) return false;
    var yard = activeYardPositions();
    for (var i = 0; i < yard.length; i++) {
      if (Math.abs(mesh.position.x - yard[i].x) < 0.3 && Math.abs(mesh.position.z - yard[i].z) < 0.3) return true;
    }
    return false;
  }

  /* 找一个当前没有箱子占用的箱位：箱子被搬走/丢弃后数量不再等于占用情况，按数量取模会叠箱 */
  function freeYardSlot() {
    var yard = activeYardPositions();
    var used = {};
    for (var i = 0; i < interactables.length; i++) {
      var it = interactables[i];
      if (it.type !== 'box' || !it.mesh) continue;
      for (var j = 0; j < yard.length; j++) {
        var p = yard[j];
        if (Math.abs(it.mesh.position.x - p.x) < 0.3 && Math.abs(it.mesh.position.z - p.z) < 0.3) { used[j] = 1; break; }
      }
    }
    for (var k = 0; k < yard.length; k++) { if (!used[k]) return yard[k]; }
    return null;   // 满：调用方（shop 送达）改排队重试，绝不叠箱
  }

  /* 场上纸箱实体的总数硬上限：24（仓库位）+ 12（卸货位）+ 12（搬运中/地面囤积的余量）。
     地面箱脱离一切位数判据且跨天不清，是 perf 闸门唯一的无界项——达上限时配送车在门外
     等待（复用 shop.update 的延迟送达链路），见 GDD §3。 */
  var BOX_HARD_CAP = 48;

  /* 箱实体归属的单一枚举：交互体表里的箱 + 玩家手上那只（举箱时交互体被摘除）。
     总数上限、序列化、清场三处共用，避免各自在四处判据里打补丁 */
  function allBoxes() {
    var out = [];
    for (var i = 0; i < interactables.length; i++) {
      var it = interactables[i];
      if (it.type === 'box' && it.data && it.data.box) out.push(it.data.box);
    }
    var held = (G.player && G.player.carrying) || null;
    if (held && out.indexOf(held) === -1) out.push(held);
    return out;
  }

  function storageSlotOf(box) {
    for (var i = 0; i < storageSlots.length; i++) {
      if (storageSlots[i].box === box) return storageSlots[i];
    }
    return null;
  }

  /* 箱交互体的唯一登记入口：提示带当前剩余件数，并保证「一 mesh 一交互体」 */
  function registerBoxInteractable(box) {
    var prod = G.data.productById(box.productId);
    retireInteractable(box.mesh);
    registerInteractable(box.mesh, {
      type: 'box', data: { box: box },
      prompt: '[E] 搬起纸箱（' + (prod ? prod.name : box.productId) + ' ×' + box.itemsLeft + '）'
    });
  }

  /* 彻底销毁一只箱：交互体 + 场景挂载 + 自有几何/材质（贴图是共享缓存，不 dispose） */
  function destroyBox(box) {
    if (!box || !box.mesh) return;
    /* 刚体必须与 mesh 同生共死：restoreBoxes 起手清场是唯一的生产销毁路径，
       漏掉就在 cannon world 里留下永不清除、仍参与 broadphase 的孤儿刚体（实测 45 个）。
       注意 player.discardBox 不走这里（spec §11 #8 挂账），它丢的箱必为 held、rb 已 detach。 */
    if (G.physics) G.physics.detach(box);
    var slot = storageSlotOf(box);
    if (slot) slot.box = null;
    retireInteractable(box.mesh);
    if (box.mesh.parent) box.mesh.parent.remove(box.mesh);
    var parts = [box.body, box.label];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (parts[i].geometry) parts[i].geometry.dispose();
      if (parts[i].material) parts[i].material.dispose();
    }
    if (G.player && G.player.carrying === box) G.player.carrying = null;
  }

  /* atPos 指定落点（存档回填存储位）；不指定则找空箱位，卸货区已满返回 null */
  function spawnBox(pid, atPos) {
    var product = G.data.productById(pid);
    if (!product) return null;
    if (allBoxes().length >= BOX_HARD_CAP) return null;
    var slotPos = atPos || freeYardSlot();
    if (!slotPos) return null;

    // 子件用局部坐标（原点=箱心），整箱位置只由 group.position 决定，玩家举箱时才能整体跟随相机
    var group = new THREE.Group();
    group.position.set(slotPos.x, 0.225, slotPos.z);
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45),
      flatMat(0xC08B4E, G.tex.on ? { map: G.tex.cardboard(1, 1) } : null));
    body.castShadow = body.receiveShadow = !!(G.tex && G.tex.on);
    group.add(body);
    var label = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.12), flatMat(CAT_COLORS[product.cat] || 0xFFFFFF));
    label.position.set(-0.226, 0, 0);
    label.rotation.y = -Math.PI / 2;
    group.add(label);
    sceneRef.add(group);

    var box = { mesh: group, body: body, label: label, productId: pid, itemsLeft: product.boxSize, rb: null };
    registerBoxInteractable(box);
    // 一律建动态刚体；落到存储位的箱由随后的 storeBox 覆盖成静态（幂等，多一次 add/remove）
    if (G.physics) G.physics.attach(box);
    return box;
  }

  /* 全部箱实体的统一序列化（GDD §3「已付的钱不退、箱子不消失」）：
     仓库位 / 卸货区 / 店内地面 / 玩家手上四类都必须入档，只存仓库位会让玩家看到
     「仓库里的活下来了、地上的没了」这种更困惑的不一致。
     手上那只按「脚下位置的地面箱」存：读档后玩家从菜单重新进场，手上凭空多一只箱
     会与 carrying 的交互态（提示/放下/丢弃/上架）错位。 */
  function serializeBoxes() {
    var out = [], list = allBoxes();
    var held = (G.player && G.player.carrying) || null;
    var pose = (held && G.player.getPose) ? G.player.getPose() : null;
    var euler = new THREE.Euler();
    for (var i = 0; i < list.length; i++) {
      var box = list[i], slot = storageSlotOf(box);
      /* 所有箱一律按「落地平放」口径存档：y 恒 0.225 不入档、姿态只取偏航。
         俯仰与翻滚丢弃 → 任何存档状态都对应一个合法静止姿态，读档必不穿地、
         不需要额外字段，与 putDownBox / storeBox 现有的 rotation.set(0, yaw, 0) 同口径。
         飞行中的箱天然走同一条规则，不需要任何特判。 */
      var ry = euler.setFromQuaternion(box.mesh.quaternion, 'YXZ').y;
      if (slot) {
        out.push({ pid: box.productId, left: box.itemsLeft, where: 'storage', slotId: slot.id, ry: ry });
        continue;
      }
      var x = box.mesh.position.x, z = box.mesh.position.z;
      var where = isOnYard(box.mesh) ? 'yard' : 'floor';
      if (box === held) {
        where = 'floor';
        if (pose) { x = pose.x; z = pose.z; }
      }
      out.push({ pid: box.productId, left: box.itemsLeft, where: where, x: x, z: z, ry: ry });
    }
    return out;
  }

  /* 起手清场再按序重建：重复 load 不得产生重复箱或「一箱两位」。
     data 非数组（旧 v2 档无 boxes 字段）时只清场，由调用方回落 restoreStorage */
  function restoreBoxes(data) {
    var live = allBoxes();
    for (var i = 0; i < live.length; i++) destroyBox(live[i]);
    if (!Array.isArray(data)) return;
    for (var d = 0; d < data.length; d++) {
      var rec = data[d];
      if (!rec || !G.data.productById(rec.pid)) continue;
      var left = (typeof rec.left === 'number' && isFinite(rec.left)) ? rec.left : 0;
      var box = null;
      if (rec.where === 'storage') {
        var slot = null;
        for (var j = 0; j < storageSlots.length; j++) {
          if (storageSlots[j].id === rec.slotId) { slot = storageSlots[j]; break; }
        }
        if (!slot || slot.box) continue;
        box = spawnBox(rec.pid, slot.pos);
        if (!box) continue;
        box.itemsLeft = left;
        updateBoxVisual(box);
        storeBox(slot, box);   // 重新登记交互提示里的剩余件数
        continue;
      }
      var at = { x: (typeof rec.x === 'number') ? rec.x : 0, z: (typeof rec.z === 'number') ? rec.z : 0 };
      box = spawnBox(rec.pid, at);
      if (!box) continue;
      box.itemsLeft = left;
      updateBoxVisual(box);
      // 旧档无 ry → 0（与现状完全一致）；先摆姿态再重建刚体，否则刚体姿态与 mesh 不一致
      box.mesh.rotation.set(0, (typeof rec.ry === 'number' && isFinite(rec.ry)) ? rec.ry : 0, 0);
      if (G.physics) {
        G.physics.detach(box);
        G.physics.attach(box);
        if (box.rb) box.rb.sleep();   // 读完档满地箱不会同时醒着抢一帧
      }
      registerBoxInteractable(box);
    }
  }

  // ---------------------------------------------------------------
  // 存档
  // ---------------------------------------------------------------
  function serializeShelves() {
    return allSlots.map(function (s) { return { id: s.id, productId: s.productId, count: s.count }; });
  }

  function restoreShelves(data) {
    if (!Array.isArray(data)) return;
    data.forEach(function (d) {
      var slot = null;
      for (var i = 0; i < allSlots.length; i++) { if (allSlots[i].id === d.id) { slot = allSlots[i]; break; } }
      if (!slot) return;
      slot.productId = d.productId || null;
      slot.count = d.count || 0;
      updateSlotVisual(slot);
      updateSlotTag(slot);
    });
  }

  // ---------------------------------------------------------------
  function init(scene) {
    sceneRef = scene;
    buildRoom();
    syncLayout();
    rebuildGraph();
    if (G.physics) G.physics.syncStatics();
  }

  window.G = window.G || {};
  window.G.world = {
    init: init,
    slots: allSlots,
    findEmptyOrMatchingSlot: findEmptyOrMatchingSlot,
    findSlotWithProduct: findSlotWithProduct,
    addItem: addItem,
    removeItem: removeItem,
    getStockCount: getStockCount,
    spawnBox: spawnBox,
    updateBoxVisual: updateBoxVisual,
    registerInteractable: registerInteractable,
    updateSlotTag: updateSlotTag,
    interactables: interactables,
    colliders: colliders,
    registers: registers,
    nav: nav,
    buildZone: buildZone,
    zoneOf: zoneOf,
    storageSlots: storageSlots,
    isOnYard: isOnYard,
    storeBox: storeBox,
    takeBox: takeBox,
    releaseStorageOf: releaseStorageOf,
    serializeShelves: serializeShelves,
    restoreShelves: restoreShelves,
    serializeStorage: serializeStorage,
    restoreStorage: restoreStorage,
    allBoxes: allBoxes,
    destroyBox: destroyBox,
    registerBoxInteractable: registerBoxInteractable,
    serializeBoxes: serializeBoxes,
    restoreBoxes: restoreBoxes,
    WALL_H: WALL_H,
    syncLayout: syncLayout,
    setCashierVisible: setCashierVisible,
    itemGeoFor: itemGeoFor,
    itemMatFor: itemMatFor,
    _tagStats: function () { return { cache: TAG_TEX, disposed: tagTexDisposed }; },
    _instPools: instPools,
    _flights: flights
  };
})();
