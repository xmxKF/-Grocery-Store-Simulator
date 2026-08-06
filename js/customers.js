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

  var active = [];
  var spawnTimer = null;
  var sceneRef = null;
  var nextId = 1;

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
    if (this.hands.children.length) this.hands.remove(this.hands.children[0]);
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
      moveTo: function (v) {
        var path = (G.world.nav && G.world.nav.findPath)
          ? G.world.nav.findPath(this.mesh.position, v) : null;
        this.path = (path && path.length) ? path : [new THREE.Vector3(v.x, 0, v.z)];
      },
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

    for (var i = active.length - 1; i >= 0; i--) {
      var c = active[i];
      var hadPath = c.path.length > 0;
      stepMove(c, dt);
      applyGait(c, dt, hadPath);
      stepState(c, dt);
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
          baseY: body.baseY, shirtMat: body.shirtMat, dims: body.dims };
        return c;
      },
      gait: function (c, dt, moving) { applyGait(c, dt, moving); },
      remove: function (c) { if (c.mesh.parent) c.mesh.parent.remove(c.mesh); }
    }
  };
})();
