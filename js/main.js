/* js/main.js — 启动 / 主循环 / 昼夜与日结算 / 自测模式
   归属：integrator。只通过 CONTRACTS.md 的 API 与事件驱动其它模块。 */
(function () {
  'use strict';

  var G = (window.G = window.G || {});

  var SELFTEST = String(location.search || '').indexOf('selftest') !== -1;

  /* ---------- 模块状态 ---------- */
  var renderer = null, scene = null, camera = null, canvasEl = null;
  var rendererNote = '';
  var phase = 'menu';        // 'menu' | 'prep' | 'open' | 'closing' | 'summary'
  var started = false;       // 本次页面加载内是否已开始过一局
  var lastT = 0;             // 连续亏损天数存在 G.state.negDays（随存档持久化）

  var runtimeErrors = [];
  var selftestChecks = null;

  window.onerror = function (msg, src, line) {
    runtimeErrors.push(String(msg) + ' @ ' + String(src) + ':' + line);
    if (SELFTEST) writeVerdict();
    return false;
  };

  /* ---------------------------------------------------------------
     启动
  --------------------------------------------------------------- */
  function buildScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xAECBE0);          // DESIGN §1.3
    scene.fog = new THREE.Fog(0xAECBE0, 30, 90);           // DESIGN §5

    var amb = new THREE.AmbientLight(0xFFFFFF, 0.12);      // DESIGN §5.5 保底不死黑
    scene.add(amb);
    var hemi = new THREE.HemisphereLight(0xAECBE0, 0xC7BEAF, 0.55);  // 天/地，暖色反弹主来源
    scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xFFF6E5, 0.85);
    sun.position.set(8, 14, 6);
    sun.target.position.set(0, 0, 0);
    if (G.tex && G.tex.on) {
      sun.castShadow = true;                                // DESIGN §5.5：唯一投影灯
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -13; sun.shadow.camera.right = 13;
      sun.shadow.camera.top = 13; sun.shadow.camera.bottom = -13;
      sun.shadow.camera.near = 1; sun.shadow.camera.far = 40;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.03;
    } else {
      sun.castShadow = false;
    }
    scene.add(sun);
    scene.add(sun.target);

    var aspect = (window.innerWidth || 1280) / (window.innerHeight || 720);
    camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 200);   // DESIGN §5 比例
    camera.rotation.order = 'YXZ';
    camera.position.set(6.5, 1.65, 3.0);
    camera.rotation.set(0, Math.PI / 2, 0);                // 进门后面朝店内（-x）
  }

  function buildRenderer() {
    var app = document.getElementById('app');
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      canvasEl = renderer.domElement;
      app.appendChild(canvasEl);
      if (G.tex && G.tex.setRenderer) G.tex.setRenderer(renderer);
      if (G.tex && G.tex.on) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    } catch (e) {
      // 无头环境可能没有 WebGL：游戏逻辑必须照常运行，只是不渲染
      renderer = null;
      rendererNote = String(e && e.message || e);
      canvasEl = document.createElement('canvas');
      app.appendChild(canvasEl);
      if (G.tex && G.tex.setRenderer) G.tex.setRenderer(null);
    }
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    if (camera) {
      camera.aspect = w / (h || 1);
      camera.updateProjectionMatrix();
    }
    if (renderer) renderer.setSize(w, h);
  }

  function render() {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
  }

  function boot() {
    buildScene();
    buildRenderer();

    G.world.init(scene);
    G.world.syncLayout();
    G.player.init(camera, canvasEl);
    G.ui.init();
    G.checkout.init(scene, camera);
    G.customers.init(scene);

    G.bus.on('toggleOpen', onToggleOpen);
    G.bus.on('nextDay', onNextDay);
    G.bus.on('levelup', onLayoutChanged);
    G.bus.on('license', onLayoutChanged);
    G.bus.on('newGame', onNewGame);
    G.bus.on('continueGame', onContinueGame);
    G.bus.on('cashier', onCashierChanged);

    if (SELFTEST) {
      runSelftest();
      return;
    }
    G.ui.showScreen('menu');
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------
     主循环
  --------------------------------------------------------------- */
  function frame(t) {
    requestAnimationFrame(frame);
    var now = t / 1000;
    var dt = lastT ? now - lastT : 0;
    lastT = now;
    if (dt > 0) tick(Math.min(dt, 0.1));
    render();
  }

  function tick(dt) {
    if (!(dt > 0)) return;

    G.player.update(dt);
    G.customers.update(dt);
    G.checkout.update(dt);
    G.shop.update(dt);

    if (G.state.open) {
      G.state.clock += dt;
      if (G.state.clock >= G.data.CONFIG.dayLengthSec) {
        G.state.clock = G.data.CONFIG.dayLengthSec;
        closeStore();
      }
    }

    if (phase === 'closing' && G.customers.active.length === 0) endDay();
  }

  /* ---------------------------------------------------------------
     菜单 / 开局
  --------------------------------------------------------------- */
  function resetDayStats() {
    G.state.dayStats = { revenue: 0, cogs: 0, customers: 0, itemsSold: 0 };
  }

  function refreshHud() {
    G.bus.emit('money', { money: G.state.money, delta: 0, reason: 'init' });
    G.bus.emit('xp', { xp: G.state.xp, level: G.state.level });
    G.bus.emit('dayStart', { day: G.state.day });
  }

  function startGame() {
    started = true;
    phase = 'prep';
    G.state.open = false;
    G.state.clock = 0;
    resetDayStats();
    G.customers.reset();
    G.ui.showScreen(null);
    refreshHud();
    G.world.setCashierVisible(G.state.cashier);
    G.ui.toast('备货阶段：Tab 开电脑订货，按 O 开门营业');
  }

  function onNewGame() {
    G.resetSave();
    // 已经玩过一局，模块内部（配送队列/队列/顾客）有残留私有状态，重载页面拿到干净起点
    if (started) { location.reload(); return; }
    startGame();
  }

  function onContinueGame() {
    // ui.js 的「继续」已调用过 G.load()（内部会先 syncLayout 再恢复格位）
    G.world.syncLayout();
    startGame();
  }

  function onLayoutChanged() {
    G.world.syncLayout();
  }

  function onCashierChanged(payload) {
    G.world.setCashierVisible(payload.hired);
  }

  /* ---------------------------------------------------------------
     昼夜循环（GDD §8）
  --------------------------------------------------------------- */
  function onToggleOpen() {
    if (!started) return;
    if (phase === 'prep') {
      G.state.open = true;
      G.state.clock = 0;
      phase = 'open';
      G.ui.toast('开门营业！');
    } else if (phase === 'open') {
      closeStore();
      G.ui.toast('提前打烊，等待场内顾客离店…', 'warn');
    }
  }

  function closeStore() {
    if (phase !== 'open') return;
    G.state.open = false;
    phase = 'closing';
  }

  /* 水电按实际货架/冷藏柜数量计（每组 6 格） */
  function countRacks() {
    var slots = (G.world && G.world.slots) || [];
    var shelfSlots = 0, fridgeSlots = 0;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].fridge) fridgeSlots++; else shelfSlots++;
    }
    return { shelfGroups: Math.round(shelfSlots / 6), fridges: Math.round(fridgeSlots / 6) };
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function endDay() {
    if (phase !== 'closing') return;
    phase = 'summary';
    // 站在收银台打烊时必须退出收银模式，否则次日玩家被冻结且 #pos 一直挂在屏幕上
    if (G.checkout.exitRegister) G.checkout.exitRegister();

    var cfg = G.data.CONFIG;
    var racks = countRacks();
    var rent = (G.state.level >= 8 ? 80 : cfg.rentPerDay)          // Lv8 扩建后房租翻倍
      + racks.shelfGroups * cfg.utilPerShelf
      + racks.fridges * cfg.utilPerFridge
      + (G.state.cashier ? cfg.cashierWage : 0);
    rent = round2(rent);

    var ds = G.state.dayStats;
    var summary = {
      revenue: round2(ds.revenue),
      cogs: round2(ds.cogs),
      rent: rent,
      profit: round2(ds.revenue - ds.cogs - rent),
      customers: ds.customers,
      itemsSold: ds.itemsSold
    };

    G.addMoney(-rent, 'fixed_cost');

    G.state.negDays = G.state.money < 0 ? G.state.negDays + 1 : 0;
    if (G.state.negDays >= cfg.bankruptDays) {
      G.save();
      G.ui.toast('连续 ' + cfg.bankruptDays + ' 天资不抵债，小店倒闭了。存档已保留，可从主菜单继续。', 'danger');
      returnToMenu();
      return;
    }

    G.bus.emit('dayEnd', { summary: summary });   // ui.js 据此渲染并打开 #screen-summary
  }

  function onNextDay() {
    if (phase !== 'summary') return;
    G.state.day += 1;
    G.state.clock = 0;
    G.state.open = false;
    resetDayStats();
    G.customers.reset();
    phase = 'prep';
    G.save();
    G.ui.showScreen(null);
    G.bus.emit('dayStart', { day: G.state.day });
  }

  function returnToMenu() {
    phase = 'menu';
    G.state.open = false;
    G.state.clock = 0;
    G.customers.reset();
    G.ui.showScreen('menu');
  }

  /* ---------------------------------------------------------------
     自测模式（CONTRACTS.md §main.js）
  --------------------------------------------------------------- */
  function writeVerdict() {
    var checks = selftestChecks || [];
    var pass = checks.length > 0 && runtimeErrors.length === 0;
    for (var i = 0; i < checks.length; i++) if (!checks[i].ok) pass = false;
    var verdict = { pass: pass, checks: checks, errors: runtimeErrors };
    var el = document.getElementById('selftest');
    if (el) el.textContent = JSON.stringify(verdict, null, 2);
    document.title = pass ? 'SELFTEST:PASS' : 'SELFTEST:FAIL';
  }

  function withRandom(v, fn) {
    var orig = Math.random;
    Math.random = function () { return v; };
    try { return fn(); } finally { Math.random = orig; }
  }

  function runSelftest() {
    var checks = selftestChecks = [];
    function ck(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    }

    var sales = [], summaries = [], rentCharged = 0;
    G.bus.on('sale', function (p) { sales.push(p); });
    G.bus.on('dayEnd', function (p) { summaries.push(p.summary); });
    G.bus.on('money', function (p) { if (p.reason === 'fixed_cost') rentCharged += -p.delta; });

    /* 固定 dt 的紧循环推进，不依赖 wall-clock */
    function pump(maxSteps, done, onStep) {
      for (var i = 0; i < maxSteps; i++) {
        tick(0.05);
        if (onStep) onStep();
        if (done && done()) return true;
      }
      return done ? done() : true;
    }
    function currentTx() { return G.checkout._test.tx(); }
    function serveTx() {
      var t = currentTx();
      if (!t || t.phase !== 'ready') return;
      G.checkout._test.scanAll();
      withRandom(0.1, function () { G.checkout._test.settle(); });   // 0.1 < 0.55 → 刷卡
      G.checkout._test.payCard();
    }

    try {
      G.resetSave();
      startGame();

      ck('boot.scene', !!scene && !!camera && G.world.slots.length === 24, '格位 ' + G.world.slots.length);
      ck('boot.nav', !!G.world.nav.entry && G.world.nav.queueSpots.length === 5 && G.world.nav.aisleSpots.length === 4,
        'aisle ' + G.world.nav.aisleSpots.length + ' / queue ' + G.world.nav.queueSpots.length);
      ck('boot.state', G.state.money === 800 && G.state.day === 1 && G.state.level === 1, G.fmt(G.state.money));

      /* --- 订货 --- */
      var m0 = G.state.money;
      var ordered = G.shop.orderBoxes([{ pid: 'f_noodle', qty: 1 }, { pid: 'd_water', qty: 1 }]);
      var expCost = (1.20 * 24 + 3) + (0.60 * 24 + 3);   // 31.8 + 17.4
      ck('shop.order', ordered === true, '返回 ' + ordered);
      ck('shop.charge', Math.abs((m0 - G.state.money) - expCost) < 0.01, '扣款 ' + round2(m0 - G.state.money) + ' / 预期 ' + expCost);
      ck('shop.lockedRejected', G.shop.orderBoxes([{ pid: 'p_apple', qty: 1 }]) === false, '未解锁商品应拒单');

      /* --- 强制送达 --- */
      G.shop.update(G.data.CONFIG.deliverySec + 2);
      var boxes = G.world.interactables.filter(function (it) { return it.type === 'box'; });
      ck('shop.delivery', boxes.length === 2, '卸货区箱数 ' + boxes.length);
      ck('world.boxShape', boxes.length === 2 && !!boxes[0].data.box && boxes[0].data.box.itemsLeft > 0,
        boxes.length ? JSON.stringify({ pid: boxes[0].data.box.productId, n: boxes[0].data.box.itemsLeft }) : 'no box');
      // player.js 靠 data.slot / data.box 读取交互对象，形状必须与 world.js 注册的一致
      var slotEntries = G.world.interactables.filter(function (it) { return it.type === 'shelfSlot'; });
      ck('world.slotShape', slotEntries.length === 24 && G.world.slots.indexOf(slotEntries[0].data.slot) !== -1,
        'shelfSlot 交互体 ' + slotEntries.length + ' 个');

      /* --- 价签与命中盒（Task 3）--- */
      var tagOk = true, hitOk = true, tagDetail = '';
      for (var si = 0; si < G.world.slots.length; si++) {
        var sl = G.world.slots[si];
        if (!sl.tagMesh || !sl.tagMesh.isMesh) { tagOk = false; tagDetail = sl.id + ' 缺价签'; break; }
        if (!sl.hitMesh || !sl.hitMesh.isMesh) { hitOk = false; tagDetail = sl.id + ' 缺命中盒'; break; }
        if (sl.hitMesh.material.opacity !== 0) { hitOk = false; tagDetail = sl.id + ' 命中盒必须 opacity 0'; break; }
        if (sl.tagMesh.material === sl.hitMesh.material) { tagOk = false; tagDetail = sl.id + ' 价签与命中盒不得共用材质'; break; }
      }
      ck('world.slotTagMesh', tagOk, tagDetail || '全部格位均有独立价签');
      ck('world.slotHitBox', hitOk, tagDetail || '全部格位均有 opacity 0 命中盒');
      // 价签材质必须逐格独立，否则高亮一个会让同类全亮
      var tagMatShared = G.world.slots.length > 1 &&
        G.world.slots[0].tagMesh.material === G.world.slots[1].tagMesh.material;
      ck('world.slotTagMatUnique', !tagMatShared, '相邻两格价签共用了材质' );

      /* --- 上架（world API）--- */
      for (var b = 0; b < boxes.length; b++) {
        var box = boxes[b].data.box;
        var guard = 0;
        while (box.itemsLeft > 0 && guard++ < 200) {
          var slot = G.world.findEmptyOrMatchingSlot(box.productId);
          if (!slot || !G.world.addItem(slot, box.productId)) break;
          box.itemsLeft -= 1;
          G.world.updateBoxVisual(box);
        }
      }
      ck('world.stock', G.world.getStockCount('f_noodle') === 24 && G.world.getStockCount('d_water') === 24,
        '方便面 ' + G.world.getStockCount('f_noodle') + ' / 矿泉水 ' + G.world.getStockCount('d_water'));
      ck('world.emptyBox', boxes[0].data.box.itemsLeft === 0, '剩余 ' + boxes[0].data.box.itemsLeft);

      /* --- 商品实例池（B-T2，取代 A 的 children 断言）--- */
      function instCountOf(pid) {
        var pool = G.world._instPools && G.world._instPools[pid];
        return pool && pool.mesh ? pool.mesh.count : 0;
      }
      function slotVisSum(pid) {
        var n = 0;
        for (var i = 0; i < G.world.slots.length; i++) {
          var s = G.world.slots[i];
          if (s.productId === pid) n += Math.min(s.count, 16);
        }
        return n;
      }
      var incSlot = G.world.findSlotWithProduct('f_noodle');
      var incBefore = instCountOf('f_noodle');
      if (incSlot) { G.world.removeItem(incSlot); G.world.removeItem(incSlot); }
      var incAfter = instCountOf('f_noodle');
      if (incSlot) { G.world.addItem(incSlot, 'f_noodle'); G.world.addItem(incSlot, 'f_noodle'); }
      ck('world.instCount', incBefore > 2 && incAfter === incBefore - 2 &&
        instCountOf('f_noodle') === incBefore && instCountOf('f_noodle') === slotVisSum('f_noodle'),
        '实例数 ' + incBefore + ' → 删2后 ' + incAfter + ' → 补2后 ' + instCountOf('f_noodle'));
      var poolOk = true, poolDetail = '';
      var poolN = 0;
      for (var pk in G.world._instPools) {
        var pl = G.world._instPools[pk];
        poolN++;
        if (!pl.mesh || !pl.mesh.isInstancedMesh) { poolOk = false; poolDetail = pk + ' 非 InstancedMesh'; break; }
        if (pl.mesh.frustumCulled !== false) { poolOk = false; poolDetail = pk + ' 未关 frustumCulled'; break; }
        if (pl.mesh.castShadow !== false) { poolOk = false; poolDetail = pk + ' 不得 castShadow'; break; }
      }
      ck('world.instGrouping', poolOk && poolN >= 2 && poolN <= 24,
        poolDetail || ('实例池 ' + poolN + ' 组'));
      var hitVisOk = true, hitRayOk = false;
      for (var hi = 0; hi < G.world.slots.length; hi++) {
        var hs = G.world.slots[hi];
        if (hs.hitMesh.visible !== false || hs.hitMesh.material.opacity !== 0) { hitVisOk = false; break; }
      }
      ck('world.hitInvisible', hitVisOk, '全部命中盒须 visible=false 且 opacity=0');
      var rayS = G.world.slots[0];
      var rayOrigin = new THREE.Vector3(rayS.pos.x, rayS.pos.y + 0.23, rayS.pos.z + rayS.faceZ * 2);
      var rayDir = new THREE.Vector3(0, 0, -rayS.faceZ);
      scene.updateMatrixWorld(true);   // 自测此前从未渲染，矩阵仍是单位阵（同 stanceFraming 的先例）
      var rc = new THREE.Raycaster(rayOrigin, rayDir, 0.01, 5);
      hitRayOk = rc.intersectObject(rayS.marker, true).length > 0;
      ck('world.hitRaycastable', hitRayOk, 'visible=false 的命中盒必须仍可被射线命中');

      /* --- 价签三状态（Task 4）--- */
      var stockedSlot = G.world.findSlotWithProduct('f_noodle');
      var emptySlot = null;
      for (var ei = 0; ei < G.world.slots.length; ei++) {
        if (G.world.slots[ei].productId === null) { emptySlot = G.world.slots[ei]; break; }
      }
      ck('world.tagStateStocked', !!stockedSlot && stockedSlot.tagState === 'stocked',
        '有货格 tagState = ' + (stockedSlot && stockedSlot.tagState));
      ck('world.tagStateEmpty', !!emptySlot && emptySlot.tagState === 'empty',
        '空格 tagState = ' + (emptySlot && emptySlot.tagState));

      // 取空一格 → 应变 'out'（缺货）；再补回去 → 变回 'stocked'
      var outSlot = G.world.findSlotWithProduct('d_water');
      var outGuard = 0;
      while (outSlot && outSlot.count > 0 && outGuard++ < 40) G.world.removeItem(outSlot);
      ck('world.tagStateOut', !!outSlot && outSlot.tagState === 'out',
        '取空后 tagState = ' + (outSlot && outSlot.tagState));
      if (outSlot) G.world.addItem(outSlot, 'd_water');
      ck('world.tagStateBack', !!outSlot && outSlot.tagState === 'stocked',
        '补货后 tagState = ' + (outSlot && outSlot.tagState));

      // 缺货格可改放异种商品（Task 4 语义：count===0 时不视为占用）
      var crossSlot = G.world.findSlotWithProduct('d_water');
      var crossGuard = 0;
      while (crossSlot && crossSlot.count > 0 && crossGuard++ < 40) G.world.removeItem(crossSlot);
      var crossOk = crossSlot ? G.world.addItem(crossSlot, 'f_noodle') : false;
      ck('world.restockCrossProduct', crossOk === true, '缺货格改放异种商品返回 ' + crossOk);
      // 还原：撤掉这件方便面，重新放回矿泉水，避免扰动后续断言
      if (crossOk) { G.world.removeItem(crossSlot); crossSlot.productId = null; crossSlot.count = 0; G.world.addItem(crossSlot, 'd_water'); }

      // 改价必须刷新价签贴图（换了 texture 实例即视为已刷新）
      var texBefore = stockedSlot ? stockedSlot.tagMesh.material.map : null;
      G.shop.setPrice('f_noodle', 3.7);
      ck('world.tagPriceRefresh', !!texBefore && stockedSlot.tagMesh.material.map !== texBefore,
        '改价后价签贴图未刷新');
      G.shop.setPrice('f_noodle', 2.2);   // 还原，后续断言依赖 r=1.0 必买

      /* --- 品类基础几何（B-T3）--- */
      var shapeOk = true, shapeDetail = '';
      var SHAPES = ['bottle', 'can', 'carton', 'bag', 'tub', 'jug', 'tray', 'produce'];
      for (var spi = 0; spi < G.data.PRODUCTS.length; spi++) {
        var sp = G.data.PRODUCTS[spi];
        if (SHAPES.indexOf(sp.shape) === -1) { shapeOk = false; shapeDetail = sp.id + ' shape=' + sp.shape; break; }
      }
      ck('data.shapeComplete', shapeOk, shapeDetail || '24 商品 shape 全合法');
      var envOk = true, envDetail = '';
      var geoSeen = {};
      for (var gpi = 0; gpi < G.data.PRODUCTS.length; gpi++) {
        var gp = G.data.PRODUCTS[gpi];
        var geo = G.world.itemGeoFor(gp.id);
        geoSeen[geo.uuid] = 1;
        geo.computeBoundingBox();
        var bb = geo.boundingBox;
        var sx = (gp.scale && gp.scale[0]) || 1, sz = (gp.scale && gp.scale[2]) || 1;
        var w = (bb.max.x - bb.min.x) * sx, d = (bb.max.z - bb.min.z) * sz;
        var cap = (gp.shape === 'tray') ? 0.175 : 0.165;
        if (w > cap || d > cap) { envOk = false; envDetail = gp.id + ' 包络 ' + w.toFixed(3) + '×' + d.toFixed(3); break; }
        if (Math.abs(bb.min.y) > 0.001) { envOk = false; envDetail = gp.id + ' 几何基面必须恰在 y=0'; break; }
      }
      ck('world.geoEnvelope', envOk, envDetail || '全部包络合规且基面落地');
      var geoCount = 0;
      for (var gk in geoSeen) geoCount++;
      ck('world.geoShared', geoCount <= 8, '基础几何 ' + geoCount + ' 套（≤8）');

      /* --- 程序化纹理（B-T4）--- */
      // lowfx（G.tex.on=false）下全部生成器返回 null，这些断言天然不适用——跳过而非硬中断，
      // 否则 lowfx 是受支持模式却会在此处 TypeError 打断整条验收链（tex.beltColorLocked / tex.lowfxNull 不受影响，留在守卫外）。
      if (G.tex.on) {
        var GENS = ['floorWood', 'yardConcrete', 'wallWainscot', 'ceilingPanel', 'shelfMetal',
                    'fridgeSteel', 'counterLaminate', 'beltRubber', 'cardboard'];
        var genOk = true, genDetail = '';
        for (var gi = 0; gi < GENS.length; gi++) {
          var fn = G.tex[GENS[gi]];
          if (typeof fn !== 'function') { genOk = false; genDetail = GENS[gi] + ' 缺失'; break; }
          var t = fn.call(G.tex, 2, 2);
          if (!t || !t.isTexture) { genOk = false; genDetail = GENS[gi] + ' 未返回 Texture'; break; }
          var w = t.image.width, h = t.image.height;
          if ((w & (w - 1)) !== 0 || (h & (h - 1)) !== 0) { genOk = false; genDetail = GENS[gi] + ' 非 POT'; break; }
        }
        ck('tex.generators', genOk, genDetail || '9 个生成器全部返回 POT CanvasTexture');
        var lb = G.tex.labelBand('carton', '#F6EBD8');
        ck('tex.labelBand', !!lb && lb.isTexture && lb.image.width === 64, 'labelBand 64² 纹理');
        var tA = G.tex.wallWainscot(8.1, 1);
        var tB = G.tex.wallWainscot(2.5, 1);
        var tA2 = G.tex.wallWainscot(8.1, 1);
        ck('tex.cacheStable', tA === tA2, '同 (生成器, repeat) 必须同引用');
        ck('tex.repeatIsolation',
          tA !== tB && tA.repeat.x === 8.1 && tB.repeat.x === 2.5 && tA.image === tB.image,
          '不同 repeat 必须不同实例（A.rx=' + tA.repeat.x + ' B.rx=' + tB.repeat.x + '），且共享底层 canvas');
        ck('tex.noRendererCrash', (function () {
          try { G.tex.setRenderer(null); G.tex.floorWood(8, 6); return true; } catch (e) { return false; }
        })(), 'renderer 为 null 时不得抛异常');
      }
      var beltFound = false;
      scene.traverse(function (o) {
        if (!beltFound && o.isMesh && o.material && o.material.color && o.material.color.getHex() === 0x4E5866) beltFound = true;
      });
      ck('tex.beltColorLocked', beltFound, '场景必须仍存在 color=0x4E5866 的传送带 mesh');
      var onSave = G.tex.on;
      G.tex.on = false;
      ck('tex.lowfxNull', G.tex.floorWood(8, 6) === null && G.tex.labelBand('can', '#FFF') === null,
        'on=false 时生成器必须返回 null');
      G.tex.on = onSave;

      /* --- 灯光与阴影（B-T5）--- */
      var lights = { amb: 0, hemi: 0, dir: 0, castDir: 0, other: 0 };
      scene.traverse(function (o) {
        if (o.isAmbientLight) lights.amb++;
        else if (o.isHemisphereLight) lights.hemi++;
        else if (o.isDirectionalLight) { lights.dir++; if (o.castShadow) lights.castDir++; }
        else if (o.isLight) lights.other++;
      });
      ck('light.count', lights.amb === 1 && lights.hemi === 1 && lights.dir === 1 && lights.other === 0 &&
        (G.tex.on ? lights.castDir === 1 : lights.castDir === 0),
        JSON.stringify(lights) + ' on=' + G.tex.on);
      var sunRef = null;
      scene.traverse(function (o) { if (!sunRef && o.isDirectionalLight) sunRef = o; });
      var frusOk = true, frusDetail = '';
      if (G.tex.on && sunRef) {
        /* 无头环境从不渲染，shadow camera 的矩阵不会被渲染器更新——手动摆位后再取逆矩阵 */
        var shCam = sunRef.shadow.camera;
        shCam.position.copy(sunRef.position);
        shCam.lookAt(sunRef.target.position);
        shCam.updateProjectionMatrix();
        shCam.updateMatrixWorld(true);
        shCam.matrixWorldInverse.copy(shCam.matrixWorld).invert();
        var toLight = new THREE.Matrix4().copy(shCam.matrixWorldInverse);
        for (var ci = 0; ci < G.world.colliders.length && frusOk; ci++) {
          var col = G.world.colliders[ci];
          var xs = [col.minX, col.maxX], zs = [col.minZ, col.maxZ], ys = [0, 3];
          for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var d = 0; d < 2; d++) {
            var pt = new THREE.Vector3(xs[a], ys[d], zs[b]).applyMatrix4(toLight);
            if (pt.x < shCam.left || pt.x > shCam.right || pt.y < shCam.bottom || pt.y > shCam.top ||
                -pt.z < shCam.near || -pt.z > shCam.far) {
              frusOk = false;
              frusDetail = 'collider#' + ci + ' 角点越界 ' + JSON.stringify({ x: round2(pt.x), y: round2(pt.y), z: round2(pt.z) });
              break;
            }
          }
        }
      }
      ck('shadow.frustumCovers', frusOk, frusDetail || (G.tex.on ? '全部 collider 角点在阴影视锥内' : 'lowfx 跳过'));
      var shellOk = true;
      scene.traverse(function (o) {
        if (o.isMesh && o.castShadow && o.geometry && o.geometry.parameters) {
          var pp = o.geometry.parameters;
          if ((pp.width >= 12 || pp.depth >= 12) && o.position.y >= 1) shellOk = false;  // 大跨度高位物 = 墙/天花板
        }
      });
      ck('shadow.shellNoCast', shellOk, '墙/天花板类大件不得 castShadow');
      var instCastOk = true;
      for (var ip in G.world._instPools) {
        if (G.world._instPools[ip].mesh.castShadow) { instCastOk = false; break; }
      }
      ck('shadow.itemsNoCast', instCastOk, '商品实例不得 castShadow');
      ck('shadow.lowfx', G.tex.on ? true : !(renderer && renderer.shadowMap && renderer.shadowMap.enabled),
        'lowfx 下 shadowMap 必须关闭');

      /* --- 上架飞行动画（Task 5）--- */
      var flySlot = G.world.findSlotWithProduct('f_noodle');
      // 上架已把该格填满到 slotCap，先腾 2 件容量；下面两次 addItem 正好补回，净库存不变
      if (flySlot) { G.world.removeItem(flySlot); G.world.removeItem(flySlot); }
      var flyFrom = new THREE.Vector3(flySlot.pos.x + 1.5, 1.2, flySlot.pos.z + 1.5);
      var flyOk = G.world.addItem(flySlot, 'f_noodle', flyFrom);
      ck('world.flightAccepted', flyOk === true, 'addItem 带 fromPos 应正常返回 true');
      // 实例数暂比应显数少 1（在飞行项落位后补齐）
      var flying = (G.world._flights || []).filter(function (f) { return f.slot === flySlot; }).length;
      ck('world.flightCount', instCountOf('f_noodle') + flying === slotVisSum('f_noodle'),
        '实例 ' + instCountOf('f_noodle') + ' + 飞行中 ' + flying + ' 应等于应显 ' + slotVisSum('f_noodle'));
      ck('world.flightNotInGroup',
        (G.world._flights || []).every(function (f) { return f.mesh.isInstancedMesh !== true; }),
        '飞行 mesh 必须是独立 Mesh 而非实例');
      // 省略 fromPos 时不应产生飞行（自测与顾客取货都走这条路径）
      var noFlyBefore = (G.world._flights || []).length;
      G.world.addItem(flySlot, 'f_noodle');
      ck('world.flightOptional', (G.world._flights || []).length === noFlyBefore,
        '不传 fromPos 不应产生飞行');

      /* --- 定价到市场价（r=1.0，必买）--- */
      G.shop.setPrice('f_noodle', 2.2);
      G.shop.setPrice('d_water', 1.2);
      ck('shop.price', G.state.prices.f_noodle === 2.2 && G.state.prices.d_water === 1.2,
        JSON.stringify([G.state.prices.f_noodle, G.state.prices.d_water]));

      /* --- 开门营业 --- */
      G.bus.emit('toggleOpen', {});
      ck('day.open', G.state.open === true && phase === 'open', 'phase=' + phase);

      /* --- 等顾客进店、取货、排队、把商品放上传送带 --- */
      var ready = pump(6000, function () {
        var t = currentTx();
        return !!t && t.phase === 'ready';
      });
      ck('customer.queued', ready, ready ? '模拟 ' + round2(G.state.clock) + 's 后队首就绪' : '超时：无顾客到达收银台');

      /* --- 收银台站位系统（Task 7）--- */
      ck('player.poseApi',
        typeof G.player.getPose === 'function' && typeof G.player.setPose === 'function' && !!G.player.camera,
        '缺 getPose/setPose/camera');

      var poseBefore = G.player.getPose ? G.player.getPose() : null;
      G.checkout.enterRegister();
      var st = G.checkout.stance;
      ck('checkout.stanceComputed', !!st && !!st.pos && isFinite(st.yaw) && isFinite(st.pitch),
        'stance = ' + JSON.stringify(st && { x: round2(st.pos.x), z: round2(st.pos.z), yaw: round2(st.yaw), pitch: round2(st.pitch) }));

      pump(20, function () { return false; });   // 推进 1.0s，让 300ms 过渡走完
      ck('checkout.stanceReached',
        !!st && camera.position.distanceTo(st.pos) < 0.02,
        '相机 ' + JSON.stringify({ x: round2(camera.position.x), y: round2(camera.position.y), z: round2(camera.position.z) }) +
        ' 应到达 ' + JSON.stringify({ x: round2(st.pos.x), y: round2(st.pos.y), z: round2(st.pos.z) }));

      // 站位必须在柜台背侧（x < 柜台中心 -7.0），而非顾客侧
      ck('checkout.stanceBehind', !!st && st.pos.x < -7.0,
        '站位 x = ' + (st && round2(st.pos.x)) + '，应 < -7.0（柜台背侧）');

      // 看得到就点得到：从站位朝 stance 朝向，传送带上每一件商品都须在画面内，
      // 且落在右侧 340px 的 #pos 面板左边——被面板盖住的商品点不到
      var txAim = currentTx();
      var realCam = G.player.camera;
      var asp = (realCam && realCam.aspect) ? realCam.aspect : 16 / 9;
      var aimCam = new THREE.PerspectiveCamera(70, asp, 0.1, 200);
      aimCam.position.copy(st.pos);
      aimCam.rotation.order = 'YXZ';
      aimCam.rotation.set(st.pitch, st.yaw, 0);
      aimCam.updateMatrixWorld(true);
      var visN = 0, totN = txAim ? txAim.items.length : 0;
      var vw = window.innerWidth || 1280;
      for (var ai = 0; ai < totN; ai++) {
        var pnt = txAim.items[ai].mesh.position.clone().project(aimCam);
        var pxX = (pnt.x + 1) / 2 * vw;
        if (pnt.z < 1 && Math.abs(pnt.x) <= 1 && Math.abs(pnt.y) <= 1 && pxX < vw - 340) visN++;
      }
      ck('checkout.stanceFraming', totN > 0 && visN === totN,
        '传送带 ' + totN + ' 件中 ' + visN + ' 件在 #pos 面板左侧的可见区内（视口宽 ' + vw + '）');

      G.checkout.exitRegister();
      pump(20, function () { return false; });
      var poseAfter = G.player.getPose ? G.player.getPose() : null;
      ck('checkout.poseRestored',
        !!poseBefore && !!poseAfter &&
        Math.abs(poseAfter.x - poseBefore.x) < 0.02 &&
        Math.abs(poseAfter.z - poseBefore.z) < 0.02 &&
        Math.abs(poseAfter.yaw - poseBefore.yaw) < 0.02 &&
        Math.abs(poseAfter.pitch - poseBefore.pitch) < 0.02,
        JSON.stringify({ before: poseBefore, after: poseAfter }));
      ck('checkout.stanceCleared', G.checkout.stance === null, '退出后 stance 应置空');

      /* --- 扫码 + 刷卡结算 --- */
      var tx = currentTx();
      var nItems = tx ? tx.items.length : 0;
      var mBefore = G.state.money, xpBefore = G.state.xp;
      var scanned = tx ? G.checkout._test.scanAll() : 0;
      ck('checkout.scan', nItems > 0 && scanned === nItems, '扫码 ' + scanned + ' / ' + nItems + ' 件');
      /* --- 扫码滑动缓动（Task 6）--- */
      var easeFn = G.checkout._test && G.checkout._test.ease;
      ck('checkout.easeExists', typeof easeFn === 'function', '未暴露缓动函数');
      ck('checkout.easeOut',
        typeof easeFn === 'function' &&
        Math.abs(easeFn(0) - 0) < 1e-9 &&
        Math.abs(easeFn(1) - 1) < 1e-9 &&
        Math.abs(easeFn(0.5) - 0.875) < 1e-9,
        typeof easeFn === 'function' ? 'ease(0.5)=' + easeFn(0.5) + '，应为 0.875（1-(1-t)³）' : 'n/a');
      var total = tx ? tx.total : 0;
      if (tx) withRandom(0.1, function () { G.checkout._test.settle(); });
      ck('checkout.settle', !!tx && tx.phase === 'card', '付款方式 ' + (tx && tx.phase));
      if (tx) G.checkout._test.payCard();
      pump(200, function () { return currentTx() === null; });

      ck('checkout.sale', sales.length >= 1 && Math.abs(sales[0].total - total) < 0.01,
        'sale 事件 ' + sales.length + ' 次，总额 ' + total);
      ck('checkout.money', Math.abs((G.state.money - mBefore) - total) < 0.01,
        '余额变化 ' + round2(G.state.money - mBefore) + ' / 预期 ' + total);
      ck('checkout.xp', G.state.xp > xpBefore, 'XP ' + xpBefore + ' → ' + G.state.xp);
      ck('checkout.dayStats',
        G.state.dayStats.revenue > 0 && G.state.dayStats.cogs > 0 &&
        G.state.dayStats.itemsSold === nItems && G.state.dayStats.customers >= 1,
        JSON.stringify(G.state.dayStats));

      /* --- 提前打烊 → 场内顾客走完 → 日结算 --- */
      G.bus.emit('toggleOpen', {});
      ck('day.close', phase === 'closing' && G.state.open === false, 'phase=' + phase);
      var ended = pump(20000, function () { return phase === 'summary' || phase === 'menu'; }, serveTx);
      ck('day.end', ended && summaries.length === 1, 'phase=' + phase + '，summary ' + summaries.length + ' 次');

      var s = summaries[0] || {};
      var expRent = 40 + 4 * 2;   // Lv1：房租 40 + 4 组普通货架水电 8，无冷藏柜、无收银员
      ck('summary.rent', Math.abs(s.rent - expRent) < 0.01, '固定支出 ' + s.rent + ' / 预期 ' + expRent);
      ck('summary.profit', Math.abs(s.profit - (s.revenue - s.cogs - s.rent)) < 0.01, JSON.stringify(s));
      ck('summary.rentCharged', Math.abs(rentCharged - expRent) < 0.01, '实扣 ' + round2(rentCharged));
      ck('summary.sane', s.revenue >= 0 && s.cogs >= 0 && s.customers >= 1 && s.itemsSold >= 1, JSON.stringify(s));

      /* --- 次日 --- */
      G.bus.emit('nextDay', {});
      ck('day.next', G.state.day === 2 && G.state.clock === 0 && phase === 'prep' &&
        G.state.dayStats.revenue === 0 && G.state.dayStats.customers === 0,
        '第 ' + G.state.day + ' 天，phase=' + phase);

      /* --- 存档往返（nextDay 已自动 save）--- */
      var snap = {
        money: G.state.money, day: G.state.day, xp: G.state.xp,
        level: G.state.level, stock: G.world.getStockCount('f_noodle')
      };
      G.state.money = -99999; G.state.day = 99; G.state.xp = 0; G.state.level = 1;
      var slotToWipe = G.world.findSlotWithProduct('f_noodle');
      if (slotToWipe) { slotToWipe.productId = null; slotToWipe.count = 0; }
      var loaded = G.load();
      ck('save.load', loaded === true, '返回 ' + loaded);
      ck('save.fields', Math.abs(G.state.money - snap.money) < 0.01 && G.state.day === snap.day &&
        G.state.xp === snap.xp && G.state.level === snap.level,
        JSON.stringify({ money: round2(G.state.money), day: G.state.day, xp: G.state.xp, level: G.state.level }));
      ck('save.shelves', G.world.getStockCount('f_noodle') === snap.stock,
        '方便面 ' + G.world.getStockCount('f_noodle') + ' / 预期 ' + snap.stock);

      /* --- 渲染（无头环境可能没有 WebGL）--- */
      if (renderer) {
        render();
        ck('render', true, 'WebGL 渲染成功');
      } else {
        ck('render', true, '无 WebGL（' + rendererNote + '）：已跳过渲染，游戏逻辑在无渲染下完整运行');
      }
    } catch (e) {
      runtimeErrors.push(String(e && e.stack || e));
      ck('selftest.exception', false, String(e && e.message || e));
    }

    ck('runtime.noError', runtimeErrors.length === 0, runtimeErrors.join(' | '));
    writeVerdict();
  }

  /* ---------------------------------------------------------------
     入口
  --------------------------------------------------------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
