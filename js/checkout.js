/* js/checkout.js — 收银系统（GDD §7）+ #pos 面板
   归属：customers agent。#pos 内部 DOM 全部在此构建，只使用 CONTRACTS.md 列出的共享类名。 */
(function () {
  'use strict';

  var G = (window.G = window.G || {});

  var BILLS = [100, 50, 20, 10, 5, 1];
  var CHANGE_BTNS = [0.1, 0.5, 1, 5, 10, 20, 50, 100];

  /* 每台收银台一份 {ref: G.world.registers[i], queue, tx, frame, stance}，与 G.world.registers 对齐 */
  var registers = [];
  var activeReg = null;    // 玩家当前占用台（对象引用），未进入时 null
  var txSeq = 0;           // 交易序号，商品 mesh 靠 (registerId, txId) 认领归属

  var inRegister = false;
  var sceneRef = null;
  var camRef = null;
  var scanCd = 0;
  var stance = null;
  var savedPose = null;
  var tween = null;
  var exiting = false;
  var posDom = null;
  var posDirty = true;
  var flashTotal = false;
  var ndc = new THREE.Vector2();
  var raycaster = new THREE.Raycaster();

  /* ---------- 小工具 ---------- */
  function cfg() { return (G.data && G.data.CONFIG) || {}; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  function meshOf(e) {
    if (!e) return null;
    if (e.isObject3D) return e;
    return e.mesh || e.obj || e.object || e.object3D || null;
  }

  /* 契约没有暴露 scene / camera 引用：先试模块字段，再沿 parent 链 / 场景遍历兜底。 */
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

  function camera() {
    if (camRef) return camRef;
    if (G.player && G.player.camera && G.player.camera.isCamera) { camRef = G.player.camera; return camRef; }
    var sc = scene();
    if (sc) sc.traverse(function (o) { if (!camRef && o.isCamera) camRef = o; });
    return camRef;
  }

  function priceOf(pid) {
    var p = G.data.productById(pid);
    var v = G.state.prices[pid];
    return (v > 0) ? v : p.market * num(cfg().defaultMarkup, 1.2);
  }

  /* ---------- 收银台台账 ---------- */
  /* G.world.registers 随区域解锁增长（buildZone 建 R2/R3），每帧对齐一次 */
  function ensureRegisters() {
    var wregs = (G.world && G.world.registers) || [];
    for (var i = registers.length; i < wregs.length; i++) {
      registers.push({ ref: wregs[i], queue: [], tx: null, frame: null, stance: null });
    }
    return registers;
  }

  /* 接受 checkout reg / G.world reg / 省略（默认首台），统一解析为本模块的 reg */
  function regOf(x) {
    ensureRegisters();
    if (!x) return registers[0] || null;
    for (var i = 0; i < registers.length; i++) {
      if (registers[i] === x || registers[i].ref === x) return registers[i];
    }
    return null;
  }

  function staffedOf(reg) {
    var list = (G.state && G.state.registers) || [];
    var s = reg ? list[reg.ref.index] : null;
    return !!(s && s.staffed);
  }

  /* 传送带坐标系：台面中心 / 朝向（顾客→台面）/ 半宽。逐台缓存于 reg.frame。 */
  function frameOf(reg) {
    if (!reg) return null;
    if (reg.frame) return reg.frame;
    var front = reg.ref.front;
    if (!front) return null;
    var center = null, topY = 0.95, size = null;

    var surf = reg.ref.beltMesh || reg.ref.mesh;
    if (surf) {
      var box = new THREE.Box3().setFromObject(surf);
      if (box.max.x >= box.min.x && isFinite(box.max.y)) {
        center = box.getCenter(new THREE.Vector3());
        size = box.getSize(new THREE.Vector3());
        topY = box.max.y;
      }
    }

    var dir = new THREE.Vector3();
    if (center) dir.set(center.x - front.x, 0, center.z - front.z);
    if (dir.lengthSq() < 1e-8) {
      var behind = (reg.ref.queueSpots && reg.ref.queueSpots[0]) || (G.world.nav && G.world.nav.entry);
      if (behind) dir.set(front.x - behind.x, 0, front.z - behind.z);
    }
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();
    if (!center) center = new THREE.Vector3(front.x, topY, front.z).addScaledVector(dir, 0.6);

    var side = new THREE.Vector3(-dir.z, 0, dir.x);
    var halfSide = 0.9;
    if (size) halfSide = Math.max(0.5, (Math.abs(size.x * side.x) + Math.abs(size.z * side.z)) / 2);

    reg.frame = {
      origin: new THREE.Vector3(center.x, topY, center.z).addScaledVector(dir, -0.18),
      dir: dir, side: side, halfSide: halfSide
    };
    return reg.frame;
  }

  function beltPos(reg, i) {
    var f = frameOf(reg);
    var cols = Math.max(3, Math.floor((f.halfSide * 1.3) / 0.18));
    return new THREE.Vector3(f.origin.x, f.origin.y + 0.002, f.origin.z)
      .addScaledVector(f.side, -f.halfSide + 0.18 + (i % cols) * 0.18)
      .addScaledVector(f.dir, Math.floor(i / cols) * 0.2);
  }

  function scannedPos(reg, k) {
    var f = frameOf(reg);
    return new THREE.Vector3(f.origin.x, f.origin.y + 0.002 + k * 0.06, f.origin.z)
      .addScaledVector(f.side, f.halfSide - 0.22)
      .addScaledVector(f.dir, 0.1);
  }

  /* ---------- 队列 ---------- */
  function queueCap(reg) {
    return (reg.ref.queueSpots && reg.ref.queueSpots.length) || 5;
  }

  /* CONTRACTS：在已建收银台中选 queue.length 最小者（并列取低 index），全部满则 false */
  function joinQueue(c) {
    ensureRegisters();
    var best = null;
    for (var i = 0; i < registers.length; i++) {
      var reg = registers[i];
      if (reg.queue.length >= queueCap(reg)) continue;
      if (!best || reg.queue.length < best.queue.length) best = reg;
    }
    if (!best) return false;
    best.queue.push(c);
    c._reg = best;
    retarget(best);
    return true;
  }

  function retarget(reg) {
    var spots = reg.ref.queueSpots || [];
    for (var i = 0; i < reg.queue.length; i++) {
      var c = reg.queue[i];
      /* 队首站 front，其后依次占 queueSpots，队伍连续不留空档 */
      var t = (i === 0) ? reg.ref.front : (spots[i - 1] || reg.ref.front);
      if (c.queueTarget !== t) { c.queueTarget = t; c.moveTo(t); }
    }
  }

  function prune(reg) {
    for (var i = reg.queue.length - 1; i >= 0; i--) {
      var c = reg.queue[i];
      if (!c.removed && c.state !== 'leaving') continue;
      reg.queue.splice(i, 1);
      c.queueTarget = null;
      c._reg = null;
      if (reg.tx && reg.tx.c === c) {
        beltGoodsToCogs(reg);   // 已放上传送带的商品同样计入损耗
        clearBelt(reg);
        reg.tx = null;
        posDirty = true;
      }
    }
  }

  /* ---------- 传送带 ---------- */
  /* price 由顾客在拿货时锁定（GDD §5），缺失时才退回当前售价 */
  function addBeltItem(reg, pid, price) {
    var p = G.data.productById(pid);
    var m = new THREE.Mesh(G.world.itemGeoFor(pid), G.world.itemMatFor(pid));
    var psc = p.scale;
    if (psc) m.scale.set(psc[0], psc[1], psc[2]);
    m.position.copy(beltPos(reg, reg.tx.items.length));
    // 多台并行时射线可能打到别台的商品：mesh 自带归属，扫码前核验
    m.userData.registerId = reg.ref.index;
    m.userData.txId = reg.tx.id;
    var sc = scene();
    if (sc) sc.add(m);
    reg.tx.items.push({ pid: pid, mesh: m, scanned: false, cost: p.cost, price: (price > 0) ? price : priceOf(pid), slide: null });
  }

  function clearBelt(reg) {
    if (!reg.tx) return;
    for (var i = 0; i < reg.tx.items.length; i++) {
      var m = reg.tx.items[i].mesh;
      if (m && m.parent) m.parent.remove(m);   // 几何体/材质为共享单例，不 dispose
    }
    reg.tx.items.length = 0;
  }

  function beltGoodsToCogs(reg) {
    if (!reg.tx) return;
    var sum = 0;
    for (var i = 0; i < reg.tx.items.length; i++) sum += reg.tx.items[i].cost;
    if (sum > 0 && G.state.dayStats) G.state.dayStats.cogs = round2(G.state.dayStats.cogs + sum);
  }

  function scannedCount(reg) {
    var n = 0;
    for (var i = 0; i < reg.tx.items.length; i++) if (reg.tx.items[i].scanned) n++;
    return n;
  }

  /* 扫码核心：玩家点击与自测钩子共用，冷却由调用方管理 */
  function scanItem(reg, it) {
    if (!reg || !reg.tx || !it || it.scanned) return false;
    it.scanned = true;
    reg.tx.total = round1(reg.tx.total + it.price);
    G.addXP(2);
    it.slide = { from: it.mesh.position.clone(), to: scannedPos(reg, scannedCount(reg) - 1), t: 0 };
    flashTotal = true;
    posDirty = true;
    return true;
  }

  function tryScan(mesh) {
    var reg = activeReg;
    if (!reg || !reg.tx || scanCd > 0) return;
    if (reg.tx.phase !== 'placing' && reg.tx.phase !== 'ready') return;
    var ud = mesh && mesh.userData;
    if (!ud || ud.registerId !== reg.ref.index || ud.txId !== reg.tx.id) return;
    for (var i = 0; i < reg.tx.items.length; i++) {
      var it = reg.tx.items[i];
      if (it.mesh !== mesh || it.scanned) continue;
      if (scanItem(reg, it)) scanCd = num(cfg().scanCooldown, 0.3);
      return;
    }
  }

  /* DESIGN §6：所有 3D 位移动画统一 ease-out（f(t) = 1 - (1-t)³） */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /* 滑动只发生在玩家扫码的那台 */
  function stepSlides(dt) {
    var reg = activeReg;
    if (!reg || !reg.tx) return;
    for (var i = 0; i < reg.tx.items.length; i++) {
      var s = reg.tx.items[i].slide;
      if (!s) continue;
      s.t = Math.min(1, s.t + dt / 0.15);
      reg.tx.items[i].mesh.position.lerpVectors(s.from, s.to, easeOutCubic(s.t));
      if (s.t >= 1) reg.tx.items[i].slide = null;
    }
  }

  /* ---------- 现金：顾客给出的面额 ---------- */
  function billCount(v) {
    var n = 0, rem = Math.round(v);
    for (var i = 0; i < BILLS.length; i++) { n += Math.floor(rem / BILLS[i]); rem %= BILLS[i]; }
    return n;
  }

  /* ≥ 总额、张数最少（同张数取最小面额和）的组合 */
  function tenderFor(total) {
    var need = Math.ceil(round2(total) - 1e-9);
    if (need <= 0) return 0;
    var best = need, bestN = billCount(need);
    for (var v = need + 1; v <= need + 100; v++) {
      var n = billCount(v);
      if (n < bestN) { bestN = n; best = v; }
    }
    return best;
  }

  function billBreakdown(v) {
    var rem = Math.round(v), parts = [];
    for (var i = 0; i < BILLS.length; i++) {
      var k = Math.floor(rem / BILLS[i]);
      if (k > 0) { parts.push('¥' + BILLS[i] + '×' + k); rem %= BILLS[i]; }
    }
    return parts.join(' + ');
  }

  /* ---------- 交易流程 ---------- */
  function stepTx(reg, dt) {
    var tx = reg.tx;
    if (tx.phase === 'placing') {
      tx.placeTimer -= dt;
      if (tx.placeTimer <= 0) {
        var item = tx.c.popItem();
        if (!item) { tx.phase = 'ready'; posDirty = true; }
        else { addBeltItem(reg, item.pid, item.price); tx.placeTimer = 0.2; posDirty = true; }
      }
      return;
    }

    if (tx.phase === 'ready' && staffedOf(reg) && activeReg !== reg) {
      tx.cashierTimer += dt;
      if (tx.cashierTimer >= 6) autoComplete(reg);
      return;
    }

    if (tx.phase === 'card' && tx.cardTimer > 0) {
      tx.cardTimer -= dt;
      if (tx.cardTimer <= 0) completeSale(reg, 'card', 5);
    }
  }

  function settleAt(reg) {
    if (!reg || !reg.tx || reg.tx.phase !== 'ready') return;
    var tx = reg.tx;
    var missCost = 0, missN = 0;
    for (var i = 0; i < tx.items.length; i++) {
      if (!tx.items[i].scanned) { missCost += tx.items[i].cost; missN++; }
    }
    if (missN > 0) {
      G.addMoney(-round2(missCost), 'miss_scan');
      G.addXP(-3);
      G.ui.toast('漏扫了！', 'danger');
    }
    if (Math.random() < 0.55) {
      tx.phase = 'card';
      tx.cardTimer = -1;
    } else {
      tx.phase = 'cash';
      tx.tendered = tenderFor(tx.total);
      tx.given = 0;
    }
    posDirty = true;
  }

  /* POS 面板只服务玩家占用的那台 */
  function onSettle() { settleAt(activeReg); }

  function onConfirmChange() {
    var reg = activeReg;
    if (!reg || !reg.tx || reg.tx.phase !== 'cash') return;
    var tx = reg.tx;
    var diff = round1(tx.given - round1(tx.tendered - tx.total));
    if (Math.abs(diff) < 0.005) {
      G.addXP(3);
      G.ui.toast('完美找零！');
    } else if (diff > 0) {
      G.addMoney(-diff, 'change_error');
      G.addXP(-3);
      G.ui.toast('找多了…', 'danger');
    } else {
      G.addXP(-5);
      G.ui.toast('顾客投诉找零不足', 'danger');
    }
    completeSale(reg, 'cash', 5);
  }

  /* 收银员：全价、无小游戏、XP 折半向下取整（玩家本可得 扫码 2/件 + 成交 5） */
  function autoComplete(reg) {
    var tx = reg.tx;
    var sum = 0;
    for (var i = 0; i < tx.items.length; i++) {
      tx.items[i].scanned = true;
      sum += tx.items[i].price;
    }
    tx.total = round1(sum);
    completeSale(reg, Math.random() < 0.55 ? 'card' : 'cash', Math.floor((2 * tx.items.length + 5) / 2));
  }

  function completeSale(reg, pay, xpGain) {
    var tx = reg.tx;
    if (!tx || tx.done) return;
    tx.done = true;
    var total = round1(tx.total);
    var cogs = 0, ids = [], sold = 0;
    for (var i = 0; i < tx.items.length; i++) {
      cogs += tx.items[i].cost;
      ids.push(tx.items[i].pid);
      if (tx.items[i].scanned) sold++;
    }
    G.addMoney(total, 'sale');
    G.addXP(xpGain);
    var ds = G.state.dayStats;
    ds.revenue = round2(ds.revenue + total);
    ds.cogs = round2(ds.cogs + cogs);
    ds.itemsSold += sold;
    ds.customers += 1;
    G.bus.emit('sale', { total: total, items: ids, pay: pay });

    var c = tx.c;
    clearBelt(reg);
    reg.tx = null;
    var idx = reg.queue.indexOf(c);
    if (idx >= 0) reg.queue.splice(idx, 1);
    c.queueTarget = null;
    c.queued = false;
    c._reg = null;
    c.leaveStore();
    retarget(reg);
    posDirty = true;
  }

  /* ---------- 收银模式 ---------- */
  function posEl() {
    if (!posDom) {
      posDom = document.getElementById('pos');
      if (posDom) posDom.style.display = 'none';
    }
    return posDom;
  }

  /* 站位由传送带几何反推，不硬编码坐标——每台自动各有各的站位。
     后退 0.93m 落在柜台背侧与南墙之间的空隙（即雇佣收银员站桩处）。 */
  var STANCE_BACK = 0.93;      // 沿 dir 后退距离（dir 由顾客侧指向柜台）
  var STANCE_EYE = 1.65;       // 与 player.js EYE_HEIGHT 一致
  // 相机向右偏航 → 画面内容左移，避开右侧 340px 的 #pos 面板。
  // 注意符号：增大 camera.rotation.y 会让物体在画面中右移，所以这里是「减」。
  var STANCE_YAW_BIAS = 0.18;

  function itemFieldCenter(reg) {
    var f = frameOf(reg);
    if (!f) return null;
    // 商品实际落点由 beltPos(i) 决定，取前 8 个位置的均值作为商品场中心，
    // 比 f.origin（柜台近侧边缘）准确得多——原 startCamLock 看向 f.origin 正是取景偏的成因之一。
    var c = new THREE.Vector3();
    for (var i = 0; i < 8; i++) c.add(beltPos(reg, i));
    return c.multiplyScalar(1 / 8);
  }

  function computeStance(reg) {
    var f = frameOf(reg);
    var target = itemFieldCenter(reg);
    if (!f || !target) return null;

    var p = f.origin.clone().addScaledVector(f.dir, STANCE_BACK);
    p.y = STANCE_EYE;

    // 相机在 YXZ 顺序下的前向为 (-sinYaw·cosPitch, sinPitch, -cosYaw·cosPitch)，
    // 故对准方向 d 时 yaw = atan2(-d.x, -d.z)。
    var d = target.clone().sub(p);
    var yaw = Math.atan2(-d.x, -d.z) - STANCE_YAW_BIAS;
    var pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z));
    return { pos: p, yaw: yaw, pitch: pitch };
  }

  function enterRegister(target) {
    var reg = regOf(target);
    if (!reg) return;
    if (activeReg) {
      if (activeReg !== reg && G.ui && G.ui.toast) G.ui.toast('先退出当前收银台', 'warn');
      return;
    }
    if (inRegister) return;
    var st = computeStance(reg);
    if (!st) return;

    savedPose = (G.player && G.player.getPose) ? G.player.getPose() : null;
    stance = st;
    reg.stance = st;
    activeReg = reg;
    G.checkout.stance = st;
    G.checkout.activeRegisterId = reg.ref.index;

    inRegister = true;
    G.checkout.inRegister = true;   // player.js 据此屏蔽移动/指针锁定
    G.bus.emit('screen', { name: 'pos' });
    var el = posEl();
    if (el) el.style.display = 'block';

    // 站位与本台收银员站桩重合，进入期间临时隐藏（退出时还原）
    if (staffedOf(reg) && G.world && G.world.setCashierVisible) {
      G.world.setCashierVisible(reg.ref.index, false);
      reg._cashierHidden = true;
    }

    startTween(st.pos, st.yaw, st.pitch);
    posDirty = true;
    renderPos();
  }

  /* 回程过渡走完之前不放开 inRegister：否则 player.update 会在这 300ms 里
     每帧执行 camera.position.set(pos.x, EYE_HEIGHT, pos.z)（player.js:200）与过渡争夺相机。 */
  function exitRegister() {
    if (!inRegister || exiting) return;
    exiting = true;
    var reg = activeReg;
    stance = null;
    if (reg) reg.stance = null;
    G.checkout.stance = null;

    var el = posEl();
    if (el) el.style.display = 'none';
    G.ui.prompt(null);
    /* 立刻发，不能等 finish()：endDay() 会在 exitRegister() 之后同步 showScreen('summary')，
       若延后 300ms 再发 {name:null}，会把 player 的 currentScreen 打回 null 而 ui.current 仍是
       'summary'，两边失联后玩家能用 Tab/Esc 关光全屏界面、phase 却卡在 'summary'。
       这 300ms 的输入屏蔽仍由 inRegister（此时未放开）经 registerActive 兜住，语义不变。 */
    G.bus.emit('screen', { name: null });

    var restore = savedPose;
    savedPose = null;

    function finish() {
      exiting = false;
      inRegister = false;
      G.checkout.inRegister = false;
      activeReg = null;
      G.checkout.activeRegisterId = null;
      // 站桩与站位相机重合：等回程过渡走完再显示，否则相机会从收银员身体里飞出去
      if (reg && reg._cashierHidden) {
        if (G.world && G.world.setCashierVisible) G.world.setCashierVisible(reg.ref.index, true);
        reg._cashierHidden = false;
      }
      if (restore && G.player && G.player.setPose) G.player.setPose(restore);
    }

    if (restore) {
      startTween(new THREE.Vector3(restore.x, STANCE_EYE, restore.z), restore.yaw, restore.pitch, finish);
    } else {
      tween = null;
      finish();
    }
  }

  /* 300ms ease-out 同时插值位置与朝向（DESIGN §6 的面板过渡档位） */
  function startTween(toPos, toYaw, toPitch, onDone) {
    var cam = camera();
    if (!cam) { if (onDone) onDone(); return; }
    cam.rotation.order = 'YXZ';
    /* player 的 yaw 是无界累加值（鼠标每转一圈就多 2π），直接标量 lerp 会让 300ms 内甩好几圈。
       把 toYaw 归一到相对当前朝向的最短弧上；退出腿末尾的 setPose 会把 yaw 精确写回。 */
    var dy = toYaw - cam.rotation.y;
    toYaw = cam.rotation.y + Math.atan2(Math.sin(dy), Math.cos(dy));
    tween = {
      fromPos: cam.position.clone(),
      fromYaw: cam.rotation.y, fromPitch: cam.rotation.x,
      toPos: toPos.clone(), toYaw: toYaw, toPitch: toPitch,
      t: 0, onDone: onDone || null
    };
  }

  function stepTween(dt) {
    if (!tween) return;
    var cam = camera();
    if (!cam) { tween = null; return; }
    tween.t = Math.min(1, tween.t + dt / 0.3);
    var k = easeOutCubic(tween.t);
    cam.position.lerpVectors(tween.fromPos, tween.toPos, k);
    cam.rotation.set(
      tween.fromPitch + (tween.toPitch - tween.fromPitch) * k,
      tween.fromYaw + (tween.toYaw - tween.fromYaw) * k,
      0
    );
    if (tween.t >= 1) {
      var done = tween.onDone;
      tween = null;
      if (done) done();
    }
  }

  /* ---------- #pos 面板 ---------- */
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function button(label, cls, onClick, disabled) {
    var b = el('button', cls, label);
    if (disabled) b.setAttribute('disabled', 'disabled');
    else b.addEventListener('click', onClick);
    return b;
  }

  function renderPos() {
    posDirty = false;
    var root = posEl();
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(el('div', 'panel-title', '收银台'));

    var tx = activeReg ? activeReg.tx : null;
    if (!tx) {
      root.appendChild(el('div', 'text-dim', '等待顾客…'));
      root.appendChild(el('div', 'text-dim', '[Esc] 退出收银台'));
      G.ui.prompt('[Esc] 退出收银台');
      return;
    }

    var list = el('div', 'pos-list');
    var pending = 0, i, it;
    for (i = 0; i < tx.items.length; i++) {
      it = tx.items[i];
      if (!it.scanned) { pending++; continue; }
      var row = el('div', 'pos-row');
      var dot = el('span', 'cat-dot');
      dot.style.background = G.data.productById(it.pid).color;
      row.appendChild(dot);
      row.appendChild(el('span', null, G.data.productById(it.pid).name));
      row.appendChild(el('span', null, G.fmt(it.price)));
      list.appendChild(row);
    }
    if (!list.childNodes.length) list.appendChild(el('div', 'pos-row text-dim', '尚未扫描商品'));
    root.appendChild(list);

    root.appendChild(el('div', 'text-dim', '待扫 ' + pending + ' 件'));
    var totalEl = el('div', 'pos-total', G.fmt(tx.total));
    root.appendChild(totalEl);

    if (tx.phase === 'placing') {
      root.appendChild(el('div', 'text-dim', '顾客正在放置商品…'));
      root.appendChild(button('结算', 'btn btn-primary', null, true));
    } else if (tx.phase === 'ready') {
      root.appendChild(button('结算', 'btn btn-primary', onSettle, false));
    } else if (tx.phase === 'card') {
      root.appendChild(el('div', 'text-accent', '顾客选择刷卡'));
      if (tx.cardTimer > 0) root.appendChild(button('读卡中…', 'btn btn-primary', null, true));
      else root.appendChild(button('刷卡', 'btn btn-primary', function () {
        var t = activeReg && activeReg.tx;
        if (t) { t.cardTimer = 1.0; posDirty = true; }
      }, false));
    } else if (tx.phase === 'cash') {
      root.appendChild(el('div', 'text-accent', '顾客付现 ' + G.fmt(tx.tendered)));
      root.appendChild(el('div', 'text-dim', billBreakdown(tx.tendered)));
      var grid = el('div', 'cash-grid');
      for (i = 0; i < CHANGE_BTNS.length; i++) {
        grid.appendChild(button('¥' + CHANGE_BTNS[i], 'cash-btn', (function (v) {
          return function () {
            var t = activeReg && activeReg.tx;
            if (t) { t.given = round1(t.given + v); posDirty = true; }
          };
        })(CHANGE_BTNS[i]), false));
      }
      root.appendChild(grid);
      root.appendChild(el('div', null, '已给出 ' + G.fmt(tx.given)));
      root.appendChild(button('清空', 'btn btn-secondary', function () {
        var t = activeReg && activeReg.tx;
        if (t) { t.given = 0; posDirty = true; }
      }, false));
      root.appendChild(button('确认找零', 'btn btn-primary', onConfirmChange, false));
    }

    root.appendChild(el('div', 'text-dim', '[Esc] 退出收银台'));
    G.ui.prompt(pending > 0 ? '[左键] 点击商品扫码 · [Esc] 退出收银台' : '[Esc] 退出收银台');

    if (flashTotal) {
      flashTotal = false;
      totalEl.style.filter = 'brightness(1.6)';
      window.setTimeout(function () {
        totalEl.style.transition = 'filter 180ms ease-out';
        totalEl.style.filter = '';
      }, 20);
    }
  }

  /* ---------- 输入 ---------- */
  window.addEventListener('keydown', function (e) {
    if (inRegister && (e.key === 'Escape' || e.code === 'Escape')) exitRegister();
  });

  window.addEventListener('mousedown', function (e) {
    var tx = activeReg ? activeReg.tx : null;
    if (!inRegister || !tx || e.button !== 0) return;
    if (!e.target || e.target.tagName !== 'CANVAS') return;
    var cam = camera();
    if (!cam) return;
    var rect = e.target.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, cam);
    var meshes = [];
    for (var i = 0; i < tx.items.length; i++) if (!tx.items[i].scanned) meshes.push(tx.items[i].mesh);
    var hits = raycaster.intersectObjects(meshes, false);
    if (hits.length) tryScan(hits[0].object);
  });

  /* ---------- 主循环 ---------- */
  function update(dt) {
    if (!(dt > 0) || !G.state || !G.world || !G.world.nav) return;
    posEl();
    ensureRegisters();

    for (var i = 0; i < registers.length; i++) {
      var reg = registers[i];
      prune(reg);
      retarget(reg);

      var head = reg.queue[0];
      if (head && !reg.tx && head.state !== 'leaving' && head.atDestination()) {
        head.state = 'paying';
        reg.tx = {
          id: ++txSeq, c: head, items: [], phase: 'placing', placeTimer: 0, total: 0,
          tendered: 0, given: 0, cardTimer: -1, cashierTimer: 0, done: false
        };
        posDirty = true;
      }

      if (reg.tx) stepTx(reg, dt);
    }

    stepSlides(dt);
    stepTween(dt);
    if (scanCd > 0) scanCd -= dt;
    if (posDirty && inRegister) renderPos();
  }

  G.checkout = {
    joinQueue: joinQueue,
    inRegister: false,
    stance: null,
    activeRegisterId: null,
    enterRegister: enterRegister,
    exitRegister: exitRegister,
    update: update,
    init: function (sc, cam) {
      if (sc && sc.isScene) sceneRef = sc;
      if (cam && cam.isCamera) camRef = cam;
    },
    /* 自测钩子：仅 main.js 的 ?selftest 脚本化场景调用，正常游戏流程不使用。i 缺省 0。 */
    _test: {
      ease: easeOutCubic,
      registers: function () { return ensureRegisters(); },
      frame: function (i) { return frameOf(ensureRegisters()[i || 0]); },
      tx: function (i) {
        var reg = ensureRegisters()[i || 0];
        return reg ? reg.tx : null;
      },
      scanAll: function (i) {
        var reg = ensureRegisters()[i || 0];
        if (!reg || !reg.tx) return 0;
        var n = 0;
        for (var k = 0; k < reg.tx.items.length; k++) {
          if (scanItem(reg, reg.tx.items[k])) n++;
        }
        scanCd = 0;
        return n;
      },
      settle: function (i) { settleAt(ensureRegisters()[i || 0]); },
      payCard: function (i) {
        var reg = ensureRegisters()[i || 0];
        if (reg && reg.tx && reg.tx.phase === 'card') { reg.tx.cardTimer = 1.0; posDirty = true; }
      }
    }
  };
})();
