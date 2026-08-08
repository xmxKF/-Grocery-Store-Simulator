/* js/customers.js — 顾客 AI（GDD §6）
   归属：customers agent。只通过 CONTRACTS.md 中定义的 API 与其它模块通信。 */
(function () {
  'use strict';

  var G = (window.G = window.G || {});

  /* DESIGN §1.3 顾客四张色板；§5.7 顾客构造 */
  var SHIRTS = ['#E8574C', '#4C9BE8', '#4CC38A', '#E8B54C', '#9B6FE0', '#E88AB0', '#F0F0F0', '#5A6B7A'];
  var PANTS = ['#3A424C', '#4E5866', '#5A6B7A', '#6E5A48', '#2E3742'];
  var SKINS = ['#F0C9A0', '#D9A878', '#C08B4E', '#8A5A3B'];
  var HAIRS = ['#2A2118', '#4A3524', '#6E5A48', '#A8A29A'];
  var SHOE_HEX = '#2E3742';

  /* 几何体与材质是模块级共享单例：顾客销毁时只移出场景，不 dispose（共享资源，dispose 会破坏其它顾客）。 */
  var TORSO_GEO = new THREE.BoxGeometry(0.44, 0.68, 0.26);
  TORSO_GEO.translate(0, 0.34, 0);                      // 基点在髋部上沿
  var HEAD_GEO = new THREE.BoxGeometry(0.26, 0.26, 0.26);
  var LEG_GEO = new THREE.BoxGeometry(0.15, 0.64, 0.17);
  LEG_GEO.translate(0, -0.32, 0);                       // 枢轴在髋
  var ARM_GEO = new THREE.BoxGeometry(0.11, 0.58, 0.13);
  ARM_GEO.translate(0, -0.29, 0);                       // 枢轴在肩
  var SHOE_GEO = new THREE.BoxGeometry(0.16, 0.08, 0.22);
  var HAIR_GEOS = [
    new THREE.BoxGeometry(0.29, 0.11, 0.29),                       // 短块
    new THREE.BoxGeometry(0.29, 0.09, 0.34),                       // 后长
    new THREE.BoxGeometry(0.31, 0.07, 0.31),                       // 平顶
    new THREE.BoxGeometry(0.33, 0.13, 0.24)                        // 蓬顶
  ];
  var bodyMats = {};

  /* ---------- D-T4 被砸倒地（spec §7）---------- */
  var KNOCK_SPEED2 = 2.5 * 2.5;   // 触发阈值 2.5 m/s，比模长平方省一次开方
  var BOX_HIT_R = 0.30;           // 箱等效球半径（介于内切 0.225 与外接 0.39 之间）
  var RAGDOLL_FALL = 0.25;        // 倒下动作
  var RAGDOLL_HOLD = 2.50;        // 躺平结束（决策 4「倒地 2.5 秒」含倒下动作）
  var RAGDOLL_END = 2.85;         // 爬起结束

  /* ---------- D-T5 局部绕行（spec §8）---------- */
  var AVOID_RANGE = 1.2;      // 前向探测距离
  var AVOID_HALF_W = 0.55;    // 侧向关心带半宽
  var AVOID_STEP = 0.60;      // 让开量
  var AVOID_MAX = 0.80;       // 偏移总钳制（主通道净宽 2.4m 半宽 1.2m − 顾客半径 0.40）
  var AVOID_SMOOTH = 3;       // 平滑系数（峰值横移 1.8 m/s；spec 的 6 会到 3.6 m/s，像瞬移）

  var active = [];
  var spawnTimer = null;
  var sceneRef = null;
  var nextId = 1;
  var EMPTY_LOOSE = [];

  /* ---------- 小工具 ---------- */
  function cfg() { return (G.data && G.data.CONFIG) || {}; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function toast(t, kind) { if (G.ui && G.ui.toast) G.ui.toast(t, kind); }

  /* 当前售价（GDD §5：售价未设置时退回市场价 × defaultMarkup） */
  function priceOf(pid) {
    var p = G.data.productById(pid);
    var v = G.state.prices[pid];
    return (v > 0) ? v : p.market * num(cfg().defaultMarkup, 1.2);
  }

  function meshOf(e) {
    if (!e) return null;
    if (e.isObject3D) return e;
    return e.mesh || e.obj || e.object || e.object3D || null;
  }

  /* 契约没有暴露 scene 引用：优先用 G.world.scene，否则沿 interactable 的 parent 链找到 Scene。 */
  function scene() {
    if (sceneRef) return sceneRef;
    if (G.world && G.world.scene && G.world.scene.isScene) { sceneRef = G.world.scene; return sceneRef; }
    var list = (G.world && G.world.interactables) || [];
    for (var i = 0; i < list.length; i++) {
      var o = meshOf(list[i]);
      while (o) {
        if (o.isScene) { sceneRef = o; return sceneRef; }
        o = o.parent;
      }
    }
    return null;
  }

  function matFor(cache, hex) {
    var k = String(hex);
    if (!cache[k]) cache[k] = new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
    return cache[k];
  }

  /* ---------- 生成参数（design §6） ---------- */
  function zonesOpenCount() {
    var z = (G.state && G.state.zones) || {};
    return ((z.B ? 1 : 0) + (z.C ? 1 : 0));   // zonesOpen = 已开购物区数 − 1（A 恒开）
  }

  function spawnInterval() {
    var base = num(cfg().spawnIntervalBase, 20);
    var day = num(G.state && G.state.day, 1);
    var lv = num(G.state && G.state.level, 1);
    return G.clamp(base - 0.8 * (day - 1) - 1.2 * (lv - 1) - 2.0 * zonesOpenCount(), 3.0, 20) * G.rand(0.75, 1.25);
  }

  function concurrentCap() {
    var lv = num(G.state && G.state.level, 1);
    return G.clamp(4 + lv + 3 * zonesOpenCount(), 5, 20);
  }

  function hasStock() {
    var slots = (G.world && G.world.slots) || [];
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s && s.productId && s.count > 0) return true;
    }
    return false;
  }

  /* 「货架上有货 且 已解锁」的商品集合 */
  function shoppablePool() {
    var slots = (G.world && G.world.slots) || [];
    var seen = {}, out = [];
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (!s || !s.productId || !(s.count > 0) || seen[s.productId]) continue;
      seen[s.productId] = 1;
      if (G.shop.isUnlocked(s.productId)) out.push(s.productId);
    }
    return out;
  }

  /* 条数 randInt(1, clamp(2+floor(level/2),2,6))；每条 qty randInt(1,2)；商品不重复 */
  function makeList() {
    var pool = shoppablePool();
    var lv = num(G.state && G.state.level, 1);
    var n = G.randInt(1, G.clamp(2 + Math.floor(lv / 2), 2, 6));
    var list = [];
    for (var i = 0; i < n && pool.length > 0; i++) {
      var k = G.randInt(0, pool.length - 1);
      list.push({ productId: pool.splice(k, 1)[0], qty: G.randInt(1, 2), rush: false });
    }
    return list;
  }

  function nearestAisle(pos) {
    var pts = (G.world.nav && G.world.nav.aisleSpots) || [];
    if (!pts.length) return new THREE.Vector3(pos.x, 0, pos.z);
    var best = pts[0], bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = pts[i].distanceToSquared(pos);
      if (d < bd) { bd = d; best = pts[i]; }
    }
    return new THREE.Vector3(best.x, 0, best.z);
  }

  /* ---------- 顾客实体 ---------- */
  /* -> {pid, price}|null；price 是拿货时锁定的成交价 */
  function popItem() {
    if (!this.items.length) return null;
    var item = this.items.shift();
    // 手持渲染封顶 6：不变式 hands.length === min(items.length, 6)。手上还满着 6 件而
    // items 仍多于 6 时不能摘，否则会先空手、items 却还有剩（清单最多 6 条 ×2 件 = 12）
    if (this.hands.children.length > this.items.length) this.hands.remove(this.hands.children[0]);
    layoutHands(this);
    return item;
  }

  function layoutHands(c) {
    var ch = c.hands.children;
    for (var i = 0; i < ch.length; i++) {
      ch[i].position.set(-0.08 + Math.floor(i / 4) * 0.16, 1.02 + (i % 4) * 0.14, 0.24);
    }
  }

  function addHandCube(c, pid) {
    // 渲染上限：手上超过 6 件不再建 mesh（逻辑 items 由调用方维护，购物车总量不受影响）
    if (c.hands.children.length >= 6) { layoutHands(c); return; }
    var product = G.data.productById(pid);
    var psc = product && product.scale;
    var m = new THREE.Mesh(G.world.itemGeoFor(pid), G.world.itemMatFor(pid));
    var sx = psc ? psc[0] : 1, sy = psc ? psc[1] : 1, sz = psc ? psc[2] : 1;
    var hh = (c.dims && c.dims.h) ? c.dims.h : 1;
    m.scale.set(0.8 * sx, 0.8 * sy / hh, 0.8 * sz);
    c.hands.add(m);
    layoutHands(c);
  }

  /* GDD §6 / DESIGN §5.7 体型：9 部件（躯干/头/发/臂×2/腿×2/鞋×2），随机胖瘦高矮 + 四色板。
     几何体与材质是模块级共享单例：顾客销毁时只移出场景，不 dispose（共享资源，dispose 会破坏其它顾客）。
     参数化（收银员小任务）：opts 各项省略走随机；spawn()/_test 无参调用行为不变。 */
  function buildBody(opts) {
    opts = opts || {};
    var shirtMat = matFor(bodyMats, opts.shirt || SHIRTS[G.randInt(0, SHIRTS.length - 1)]);
    var pantsMat = matFor(bodyMats, opts.pants || PANTS[G.randInt(0, PANTS.length - 1)]);
    var skinMat = matFor(bodyMats, opts.skin || SKINS[G.randInt(0, SKINS.length - 1)]);
    var hairMat = matFor(bodyMats, opts.hair || HAIRS[G.randInt(0, HAIRS.length - 1)]);
    var shoeMat = matFor(bodyMats, SHOE_HEX);

    var g = new THREE.Group();
    /* 倒地必须绕「朝向之后的自身左右轴」转：默认 XYZ 下 rotation.x 绕世界 X 轴，
       顾客朝 ±z 时会歪着倒。rotation.x === 0 时两种 order 完全等价，对既有行为零影响。 */
    g.rotation.order = 'YXZ';
    var h = (opts.h > 0) ? opts.h : G.rand(0.90, 1.08);
    var w = (opts.w > 0) ? opts.w : G.rand(0.88, 1.22);

    var torso = new THREE.Mesh(TORSO_GEO, shirtMat);
    torso.position.y = 0.72;
    torso.scale.set(w, 1, w * 0.9);
    var head = new THREE.Mesh(HEAD_GEO, skinMat);
    head.position.y = 1.53;
    var hair = new THREE.Mesh(
      HAIR_GEOS[(opts.hairStyle >= 0 && opts.hairStyle < HAIR_GEOS.length) ? opts.hairStyle : G.randInt(0, HAIR_GEOS.length - 1)],
      hairMat);
    hair.position.y = 1.70;
    var legL = new THREE.Mesh(LEG_GEO, pantsMat);
    legL.position.set(-0.115 * w, 0.72, 0);
    var legR = new THREE.Mesh(LEG_GEO, pantsMat);
    legR.position.set(0.115 * w, 0.72, 0);
    var shoeL = new THREE.Mesh(SHOE_GEO, shoeMat);
    shoeL.position.set(0, -0.68, 0.02);
    legL.add(shoeL);
    var shoeR = new THREE.Mesh(SHOE_GEO, shoeMat);
    shoeR.position.set(0, -0.68, 0.02);
    legR.add(shoeR);
    var armL = new THREE.Mesh(ARM_GEO, shirtMat);
    armL.position.set(-(0.22 * w + 0.07), 1.34, 0);
    var armR = new THREE.Mesh(ARM_GEO, shirtMat);
    armR.position.set(0.22 * w + 0.07, 1.34, 0);

    var hands = new THREE.Group();
    g.add(torso); g.add(head); g.add(hair); g.add(legL); g.add(legR);
    g.add(armL); g.add(armR); g.add(hands);
    g.scale.y = h;
    if (G.tex && G.tex.on) {
      torso.castShadow = true; head.castShadow = true;
      legL.castShadow = true; legR.castShadow = true;
    }
    return {
      group: g, hands: hands, shirtMat: shirtMat,
      torso: torso, head: head, hair: hair,
      legL: legL, legR: legR, armL: armL, armR: armR,
      dims: { h: h, w: w },
      baseY: { torso: 0.72, head: 1.53, hair: 1.70 }
    };
  }

  /* spawn() 与 _test.spawnOne() 挂的是【同一个函数引用】，不得在两处各写一份：
     「换路清让位记账」这类逻辑一旦复制，就会在夹具里悄悄缺席，而断言又只能看到夹具
     ——cust.dodgeRerouteClears 此前够不着这条路径，正是因为 _test 的对象根本没有 moveTo。 */
  function moveToImpl(v) {
    var path = (G.world.nav && G.world.nav.findPath)
      ? G.world.nav.findPath(this.mesh.position, v) : null;
    this.path = (path && path.length) ? path : [new THREE.Vector3(v.x, 0, v.z)];
    // 换路 = 换车道法向，旧的让位记账在新法向上无意义，一并清零（不动已在位置上的横移）
    this.avoid = 0; this.avoidApplied = 0; this.avoidSide = 0; this.avoidBox = null;
  }

  function spawn() {
    var sc = scene();
    var nav = G.world.nav;
    if (!sc || !nav || !nav.entry) return;

    var body = buildBody();
    var g = body.group;
    var hands = body.hands;
    g.position.set(nav.entry.x, 0, nav.entry.z);
    sc.add(g);

    var c = {
      id: nextId++,
      mesh: g,
      hands: hands,
      state: 'entering',
      path: [],
      list: makeList(),
      items: [],          // 已拿到手的 {pid, price}（结账时由 checkout 逐件 popItem）
      li: 0,              // 当前处理的清单下标
      slot: null,
      sub: 'move',
      timer: 0,
      shopTime: 0,
      patience: 0,
      queued: false,
      queueTarget: null,
      removed: false,
      despawn: -1,
      phase: 0,
      amp: 0,
      legL: body.legL,
      legR: body.legR,
      armL: body.armL,
      armR: body.armR,
      torso: body.torso,
      head: body.head,
      hair: body.hair,
      baseY: body.baseY,
      shirtMat: body.shirtMat,
      dims: body.dims,
      lane: G.rand(-0.35, 0.35),
      avoid: 0,
      avoidApplied: 0,
      avoidSide: 0,
      avoidBox: null,
      ragdoll: false,
      ragdollT: 0,
      ragdollDir: 1,
      moveTo: moveToImpl,
      atDestination: function () { return this.path.length === 0; },
      popItem: popItem,
      leaveStore: function () { leave(this); }
    };
    active.push(c);

    var slot = pickTarget(c);
    if (!slot) { finishShopping(c); return; }
    c.moveTo(nearestAisle(slot.pos));
  }

  function destroy(c) {
    if (c.mesh.parent) c.mesh.parent.remove(c.mesh);
    c.removed = true;
  }

  /* ---------- 行走：waypoint 之间直线匀速，无碰撞 ---------- */
  function stepMove(c, dt) {
    if (!c.path.length) return;
    var t = c.path[0], p = c.mesh.position;
    var tx = t.x, tz = t.z;
    if (c.path.length > 1 && c.lane) {   // 中途节点沿行进法向偏移，终点/队列点不偏
      var ndx = t.x - p.x, ndz = t.z - p.z;
      var nl = Math.sqrt(ndx * ndx + ndz * ndz);
      // 距路点小于偏移量时不再偏移：否则方向向量随 p 逼近 t 而退化，
      // 每帧重算的法向会来回翻转，导致在路点附近原地摆动、永远到不了点
      if (nl > Math.abs(c.lane)) {
        tx += (-ndz / nl) * c.lane;
        tz += (ndx / nl) * c.lane;
      }
    }
    var dx = tx - p.x, dz = tz - p.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    var step = num(cfg().customerSpeed, 1.6) * dt;
    if (d <= step || d < 1e-4) {
      p.x = tx; p.z = tz;
      c.path.shift();
      /* snap 把位置硬置到路点，已施加的让位横移随之被抹掉——记账必须同步清零，
         否则 c.avoid 衰减回 0 时会把这笔已不存在的横移反向施加到另一侧（修前实测
         最坏反向横移 0.29m、转角跨轨误差 0.39m）。此处不会有跳变：snap 的前提是
         d ≤ 一帧步长（≈0.027m），残余横移本就已被 stepMove 拉回到该量级以内。
         顺带清 avoidSide：新一段的车道法向已换，让位方向应重新选。 */
      c.avoid = 0; c.avoidApplied = 0; c.avoidSide = 0; c.avoidBox = null;
    } else {
      p.x += dx / d * step;
      p.z += dz / d * step;
      c.mesh.rotation.y = Math.atan2(dx, dz);
    }
    p.y = 0;
  }

  /* 步态唯一写入点（DESIGN §5.7）：根节点 y 恒 0，浮沉只动上身部件；
     物理接管钩子已预留：c.ragdoll 为真时跳过步态 */
  function applyGait(c, dt, moving) {
    if (c.ragdoll) return;
    var target = moving ? 1 : 0;
    var k = Math.min(1, dt * 8);
    c.amp += (target - c.amp) * k;
    if (moving) c.phase += dt * num(cfg().customerSpeed, 1.6) * 3.4;
    var s = Math.sin(c.phase) * c.amp;
    c.legL.rotation.x = s * 0.44;
    c.legR.rotation.x = -s * 0.44;
    c.armL.rotation.x = -s * 0.30;
    c.armR.rotation.x = s * 0.30;
    var bob = -0.03 * Math.abs(Math.sin(c.phase)) * c.amp;
    c.torso.position.y = c.baseY.torso + bob;
    c.head.position.y = c.baseY.head + bob;
    c.hair.position.y = c.baseY.hair + bob;
  }

  /* ---------- 被砸判定与倒地姿态（spec §7）---------- */
  /* 顾客不参与物理：判定由 customers 自己做，G.physics 只提供 looseBoxes() 只读列表。
     每帧代价 active(≤20) × loose(≤48) ≤ 960 次平方距离比较，无分配；loose 为空整段跳过。 */
  function findKnockBox(c, loose) {
    if (!loose || !loose.length || !c.dims) return null;
    var p = c.mesh.position;
    var r = 0.22 * c.dims.w + 0.13 + BOX_HIT_R;    // 最宽处是手臂：半展 0.22w + 0.125，取 0.13
    var topY = 1.77 * c.dims.h + BOX_HIT_R;        // 最高处是头发：1.70 + 最厚发型半高 0.065，×h
    for (var i = 0; i < loose.length; i++) {
      var b = loose[i];
      if (!b.rb || !b.mesh) continue;
      var v = b.rb.velocity;
      if (v.x * v.x + v.y * v.y + v.z * v.z < KNOCK_SPEED2) continue;
      var bp = b.mesh.position;
      var dx = bp.x - p.x, dz = bp.z - p.z;
      if (dx * dx + dz * dz > r * r) continue;
      if (bp.y < -BOX_HIT_R || bp.y > topY) continue;
      return b;
    }
    return null;
  }

  function stepKnockdown(c, dt, loose) {
    if (!c.ragdoll) {
      var hit = findKnockBox(c, loose);
      if (!hit) return;
      // 朝向约定：mesh.rotation.y = atan2(dx, dz) → 自身正前方是局部 +Z。
      // YXZ 下绕局部 +X 正转把 +Y 推向 +Z：+π/2 = 前扑（脸朝下），−π/2 = 后仰。
      var fx = Math.sin(c.mesh.rotation.y), fz = Math.cos(c.mesh.rotation.y);
      var v = hit.rb.velocity;
      c.ragdollDir = (v.x * fx + v.z * fz > 0) ? 1 : -1;   // 从背后砸来 → 前扑
      c.ragdoll = true;
      c.ragdollT = 0;
      return;      // 触发帧只置位，姿态从下一帧起推进
    }
    // 倒地期间再次被砸：不重播倒下动作，只把躺平计时拉回
    if (findKnockBox(c, loose)) c.ragdollT = Math.min(c.ragdollT, RAGDOLL_FALL);
    c.ragdollT += dt;
    var t = c.ragdollT, a;
    if (t <= RAGDOLL_FALL) a = t / RAGDOLL_FALL;
    else if (t <= RAGDOLL_HOLD) a = 1;
    else if (t < RAGDOLL_END) a = 1 - (t - RAGDOLL_HOLD) / (RAGDOLL_END - RAGDOLL_HOLD);
    else a = 0;
    c.mesh.rotation.x = c.ragdollDir * a * Math.PI / 2;
    if (t >= RAGDOLL_END) {
      c.ragdoll = false;
      c.ragdollT = 0;
      c.mesh.rotation.x = 0;
    }
  }

  /* 纯观感的横向让位：箱不进 G.world.colliders、不重建导航图，绕行失败时顾客直接穿过箱子。
     c.avoid 是【已施加到位置上的横向位移量】，每帧沿行进法向补差值——
     spec 原案（把偏移叠进 c.lane、偏移数米外的路点）实测 1s 只挪 0.06–0.10m，等于没绕行。 */
  function stepAvoid(c, dt, loose) {
    var p = c.mesh.position;
    var fx, fz;
    if (c.path.length) {
      fx = c.path[0].x - p.x;
      fz = c.path[0].z - p.z;
      var fl = Math.sqrt(fx * fx + fz * fz);
      /* 与 stepMove 里那道 `nl > Math.abs(c.lane)` 的防退化保护同源，理由也同一条：距路点小于当前横向
         偏移量时，指向路点的方向向量被横向误差主导，法向每帧剧烈旋转（实测离路点
         0.17m 处法向已偏 47°，到点前转满 90°），此时施加 da 等于沿路径推。
         退化区内一律不更新、不施加，记账留给 snap 分支统一清零。

         【本段的实际份量，别再写错】
         · 归因：反向横移 0.29→0.10m、转角跨轨 0.39→0.00m 那两笔战果**不是本段的**，
           全部来自下面 stepMove 的 snap 清账。逐项撤销实测：只撤本段，两项指标一字不变。
         · 本段的作用在 snap 清账上线后**基本被吸收**——snap 同时硬置位置与清空记账，
           本段的影响越不过路点，只存活于进近段。12 组箱位扫描（x∈{5.7,6.0} ×
           z∈{-0.9..+0.2} 相对中途路点）：8 组逐位相同、3 组本段更好（最大 1.3×，
           0.26 vs 0.20）、1 组本段略负 0.03m（噪声级）。
         · 保留的理由是**与 stepMove 的 `nl > Math.abs(c.lane)` 保护保持对称**，不是因为当前
           实测下有可观收益；两处对称只剩一处，是这类退化保护最常见的死法。
         · **本段没有护栏**：撤掉它不会让任何断言变红（守它的断言按「余量不足 2×」
           规则叫停了，见 task-5-report 修复轮 3）。改动本段的人必须手动验证。 */
      if (fl < 1e-4 || fl <= Math.abs(c.lane) + Math.abs(c.avoid)) return;
      fx /= fl; fz /= fl;
    } else {
      fx = Math.sin(c.mesh.rotation.y);
      fz = Math.cos(c.mesh.rotation.y);
    }
    /* 车道法向：与 stepMove 里 c.lane 用的 (-ndz/nl, ndx/nl) 同一条 */
    var nx = -fz, nz = fx;
    var target = 0;
    if (c.path.length > 1 && loose && loose.length) {
      var bestD = Infinity, bestLat = 0, bestBox = null, lockSeen = false;
      for (var i = 0; i < loose.length; i++) {
        var b = loose[i];
        if (!b.mesh) continue;
        var dx = b.mesh.position.x - p.x, dz = b.mesh.position.z - p.z;
        var fp = dx * fx + dz * fz;
        if (!(fp > 0) || fp > AVOID_RANGE) continue;
        var lat = dx * nx + dz * nz;                  // 在车道法向上的投影
        if (Math.abs(lat) >= AVOID_HALF_W) continue;
        if (b === c.avoidBox) lockSeen = true;
        if (fp < bestD) { bestD = fp; bestLat = lat; bestBox = b; }
      }
      if (bestD < Infinity) {
        /* 让位方向锁在【锁住的那只箱】身上，它一离开探测窗口就重取（c.avoidBox）。
           作用是多箱穿插时稳住让位对象，避免每帧改换目标。
           两条经实验推翻的旧论断，别再写回来：
           ① 「不锁必自激振荡」是错的——修正符号后 p_new = p_old + n·avoid
              ⇒ lat_new = lat_old + s·AVOID_STEP，|lat| 单调远离 0 永不穿零，
              单箱去锁与加锁逐帧完全相同。
           ② 「窗口空了才解锁」（本条最初的写法）在箱距 < AVOID_RANGE 的密排下有害：
              锁跨箱延续，顾客躲开左边那只后一路撞进右边那只（复审 3430 组三箱布局：
              穿箱组 1305 → 995，最坏抖动 7 → 14，仍远低于完全去锁的 32）。
           箱正对准（|lat| < 0.05）时按 id 奇偶定侧，保证确定性。
           【护栏】`!lockSeen`（= 锁按箱释放）由 cust.dodgeRelocksPerBox 守：撤掉它，
           左右交错三箱夹具下顾客中心到最近箱心从 0.42m 掉到 0.07m（D-T7 变异实测）。 */
        if (!c.avoidSide || !lockSeen) {
          c.avoidSide = (Math.abs(bestLat) < 0.05) ? ((c.id % 2) ? 1 : -1) : (bestLat > 0 ? 1 : -1);
          c.avoidBox = bestBox;
        }
        target = -c.avoidSide * AVOID_STEP;
      } else {
        c.avoidSide = 0; c.avoidBox = null;
      }
    } else {
      c.avoidSide = 0; c.avoidBox = null;
    }
    c.avoid += (target - c.avoid) * Math.min(1, dt * AVOID_SMOOTH);
    var lo = -AVOID_MAX - c.lane, hi = AVOID_MAX - c.lane;   // 保证 |lane + avoid| ≤ 0.80
    if (c.avoid < lo) c.avoid = lo;
    if (c.avoid > hi) c.avoid = hi;
    var da = c.avoid - c.avoidApplied;
    if (da) {
      p.x += nx * da;
      p.z += nz * da;
      c.avoidApplied = c.avoid;
    }
  }

  /* 一名顾客的完整每帧流程。update() 的循环体与 _test.stepOne 同源同函数，
     不得在两处各写一份（否则自测测的与真实跑的会分叉）。 */
  function stepCustomer(c, dt, loose) {
    stepKnockdown(c, dt, loose);
    if (!c.ragdoll) {
      var hadPath = c.path.length > 0;
      stepAvoid(c, dt, loose);
      stepMove(c, dt);
      applyGait(c, dt, hadPath);
    }
    stepState(c, dt);      // 无论倒地与否照常：patience/shopTime 继续累计，杜绝「砸倒顾客拖延耐心」
  }

  /* ---------- 购物 ---------- */
  function pickTarget(c) {
    while (c.li < c.list.length) {
      var e = c.list[c.li];
      if (e.qty > 0) {
        var slot = G.world.findSlotWithProduct(e.productId);
        if (slot) { c.slot = slot; return slot; }
      }
      c.li++;
    }
    c.slot = null;
    return null;
  }

  /* GDD §5 容忍度公式，逐件判定 */
  function judgeItem(c) {
    var e = c.list[c.li];
    var p = G.data.productById(e.productId);
    var r = priceOf(e.productId) / p.market;
    var prob;
    if (r < 0.95) {
      prob = 1.00;
      if (!e.rush) { e.rush = true; e.qty += 1; }   // 抢购：需求 +1 件
    } else if (r <= 1.10) {
      prob = 1.00;
    } else if (r <= 1.40) {
      prob = 1.00 - (r - 1.10) / 0.30 * 0.50;
      if (Math.random() < 0.30) toast('有点贵啊…', 'warn');
    } else if (r <= 1.70) {
      prob = 0.50 - (r - 1.40) / 0.30 * 0.50;
      toast('有点贵啊…', 'warn');
      G.addXP(-2);
    } else {
      prob = 0.00;
      toast('太贵了，不买了', 'danger');
      G.addXP(-2);
    }
    return Math.random() < prob;
  }

  function afterJudge(c) {
    if (judgeItem(c)) { c.sub = 'grab'; c.timer = 0.4; }
    else { c.li++; c.sub = 'next'; }   // 不买：不扣货架，清单删除该项
  }

  function doGrab(c) {
    var e = c.list[c.li];
    var slot = G.world.findSlotWithProduct(e.productId);
    if (slot && G.world.removeItem(slot)) {
      // GDD §5：改价不影响顾客已拿到手的商品，成交价在拿货这一刻定死
      c.items.push({ pid: e.productId, price: priceOf(e.productId) });
      addHandCube(c, e.productId);
      e.qty -= 1;
    } else {
      e.qty = 0;   // 货架空了，本条作废
    }
    if (e.qty > 0) afterJudge(c);
    else { c.li++; c.sub = 'next'; }
  }

  function lostGoodsToCogs(c) {
    var sum = 0;
    for (var i = 0; i < c.items.length; i++) sum += G.data.productById(c.items[i].pid).cost;
    if (sum > 0 && G.state.dayStats) G.state.dayStats.cogs = round2(G.state.dayStats.cogs + sum);
  }

  function leave(c) {
    c.state = 'leaving';
    c.queued = false;
    c.despawn = -1;
    var nav = G.world.nav;
    c.moveTo(nav.exit || nav.entry);
  }

  function finishShopping(c) {
    if (c.items.length === 0) {
      G.addXP(-1);
      G.bus.emit('customerLeft', { angry: false, reason: 'no_stock' });
      leave(c);
      return;
    }
    c.state = 'queueing';
    c.patience = 0;
    if (G.checkout.joinQueue(c)) {
      c.queued = true;
    } else {
      G.addXP(-2);
      lostGoodsToCogs(c);
      G.bus.emit('customerLeft', { angry: true, reason: 'queue_full' });
      leave(c);
    }
  }

  /* ---------- 状态机 ---------- */
  function stepState(c, dt) {
    if (c.state === 'entering') {
      if (c.atDestination()) { c.state = 'shopping'; c.sub = 'stop'; c.timer = 1.2; }
      return;
    }

    if (c.state === 'shopping') {
      c.shopTime += dt;
      if (c.shopTime >= num(cfg().shopTimeoutSec, 45)) { finishShopping(c); return; }
      if (c.sub === 'move') {
        if (c.atDestination()) { c.sub = 'stop'; c.timer = 1.2; }
      } else if (c.sub === 'stop') {
        c.timer -= dt;
        if (c.timer <= 0) afterJudge(c);
      } else if (c.sub === 'grab') {
        c.timer -= dt;
        if (c.timer <= 0) doGrab(c);
      } else {
        var slot = pickTarget(c);
        if (!slot) { finishShopping(c); return; }
        c.moveTo(nearestAisle(slot.pos));
        c.sub = 'move';
      }
      return;
    }

    if (c.state === 'queueing' || c.state === 'paying') {
      c.patience += dt;
      if (c.patience >= num(cfg().patienceSec, 60)) {
        G.addXP(-3);
        lostGoodsToCogs(c);
        G.bus.emit('customerLeft', { angry: true, reason: 'impatient' });
        leave(c);   // checkout.update() 会据 state==='leaving' 清理队列与传送带
      }
      return;
    }

    if (c.state === 'leaving' && c.atDestination()) {
      if (c.despawn < 0) c.despawn = 2;
      else {
        c.despawn -= dt;
        if (c.despawn <= 0) destroy(c);
      }
    }
  }

  /* ---------- 对外 ---------- */
  function update(dt) {
    if (!(dt > 0) || !G.state || !G.world || !G.world.nav) return;
    if (spawnTimer === null) spawnTimer = spawnInterval();

    if (G.state.open) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnTimer = spawnInterval();
        if (hasStock() && active.length < concurrentCap()) spawn();
      }
    }

    var loose = (G.physics && G.physics.looseBoxes) ? G.physics.looseBoxes() : EMPTY_LOOSE;
    for (var i = active.length - 1; i >= 0; i--) {
      var c = active[i];
      stepCustomer(c, dt, loose);
      if (c.removed) active.splice(i, 1);
    }
  }

  function reset() {
    for (var i = 0; i < active.length; i++) {
      if (active[i].mesh.parent) active[i].mesh.parent.remove(active[i].mesh);
      active[i].removed = true;
    }
    active.length = 0;
    spawnTimer = null;
  }

  G.customers = {
    update: update,
    active: active,
    reset: reset,
    init: function (sc) { if (sc && sc.isScene) sceneRef = sc; },
    buildFigure: function (opts) { return buildBody(opts); },
    _test: {
      spawnOne: function () {
        var body = buildBody();
        var sc2 = scene();
        if (sc2) sc2.add(body.group);
        var c = { mesh: body.group, hands: body.hands, phase: 0, amp: 0,
          legL: body.legL, legR: body.legR, armL: body.armL, armR: body.armR,
          torso: body.torso, head: body.head, hair: body.hair,
          baseY: body.baseY, shirtMat: body.shirtMat, dims: body.dims,
          items: [], popItem: popItem,
          id: nextId++, path: [], lane: 0, avoid: 0, avoidApplied: 0, avoidSide: 0, avoidBox: null,
          moveTo: moveToImpl,
          ragdoll: false, ragdollT: 0, ragdollDir: 1 };
        return c;
      },
      gait: function (c, dt, moving) { applyGait(c, dt, moving); },
      addHand: function (c, pid) { addHandCube(c, pid); },
      remove: function (c) { if (c.mesh.parent) c.mesh.parent.remove(c.mesh); },
      stepOne: function (c, dt) {
        stepCustomer(c, dt, (G.physics && G.physics.looseBoxes) ? G.physics.looseBoxes() : EMPTY_LOOSE);
      },
      stepAvoid: function (c, dt) {
        stepAvoid(c, dt, (G.physics && G.physics.looseBoxes) ? G.physics.looseBoxes() : EMPTY_LOOSE);
      }
    }
  };
})();
