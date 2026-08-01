/* js/customers.js — 顾客 AI（GDD §6）
   归属：customers agent。只通过 CONTRACTS.md 中定义的 API 与其它模块通信。 */
(function () {
  'use strict';

  var G = (window.G = window.G || {});

  /* DESIGN §1.3 顾客随机色板 */
  var PALETTE = ['#E8574C', '#4C9BE8', '#4CC38A', '#E8B54C', '#9B6FE0', '#E88AB0', '#F0F0F0', '#5A6B7A'];

  /* GDD §6 体型：Box 身体 0.45×1.0×0.3 + Box 头 0.28³ + 两条 Box 腿。
     几何体与材质是模块级共享单例：顾客销毁时只移出场景，不 dispose（共享资源，dispose 会破坏其它顾客）。 */
  var TORSO_GEO = new THREE.BoxGeometry(0.45, 1.0, 0.3);
  var HEAD_GEO = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  var LEG_GEO = new THREE.BoxGeometry(0.14, 0.55, 0.16);
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

  /* ---------- 生成参数（GDD §6） ---------- */
  function spawnInterval() {
    var base = num(cfg().spawnIntervalBase, 20);
    var day = num(G.state && G.state.day, 1);
    var lv = num(G.state && G.state.level, 1);
    return G.clamp(base - 0.8 * (day - 1) - 1.2 * (lv - 1), 5, 20) * G.rand(0.75, 1.25);
  }

  function concurrentCap() {
    var lv = num(G.state && G.state.level, 1);
    return Math.min(4 + lv, 12) + (lv >= 8 ? 2 : 0);
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
    m.scale.set(0.8 * (psc ? psc[0] : 1), 0.8 * (psc ? psc[1] : 1), 0.8 * (psc ? psc[2] : 1));
    c.hands.add(m);
    layoutHands(c);
  }

  function spawn() {
    var sc = scene();
    var nav = G.world.nav;
    if (!sc || !nav || !nav.entry) return;

    var mat = matFor(bodyMats, PALETTE[G.randInt(0, PALETTE.length - 1)]);
    var g = new THREE.Group();
    var torso = new THREE.Mesh(TORSO_GEO, mat); torso.position.y = 1.05;
    var head = new THREE.Mesh(HEAD_GEO, mat); head.position.y = 1.69;
    var legL = new THREE.Mesh(LEG_GEO, mat); legL.position.set(-0.11, 0.275, 0);
    var legR = new THREE.Mesh(LEG_GEO, mat); legR.position.set(0.11, 0.275, 0);
    var hands = new THREE.Group();
    g.add(torso); g.add(head); g.add(legL); g.add(legR); g.add(hands);
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
      moveTo: function (v) { this.path = [new THREE.Vector3(v.x, 0, v.z)]; },
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
    var dx = t.x - p.x, dz = t.z - p.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    var step = num(cfg().customerSpeed, 1.6) * dt;
    if (d <= step || d < 1e-4) {
      p.x = t.x; p.z = t.z;
      c.path.shift();
    } else {
      p.x += dx / d * step;
      p.z += dz / d * step;
      c.mesh.rotation.y = Math.atan2(dx, dz);
    }
    p.y = 0;
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
      stepMove(c, dt);
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
    init: function (sc) { if (sc && sc.isScene) sceneRef = sc; }
  };
})();
