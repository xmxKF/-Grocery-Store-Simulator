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
    scene.fog = new THREE.Fog(0xAECBE0, 45, 140);          // DESIGN §5

    var amb = new THREE.AmbientLight(0xFFFFFF, 0.12);      // DESIGN §5.5 保底不死黑
    scene.add(amb);
    var hemi = new THREE.HemisphereLight(0xAECBE0, 0xC7BEAF, 0.55);  // 天/地，暖色反弹主来源
    scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xFFF6E5, 0.85);
    sun.position.set(8, 14, 6);
    sun.target.position.set(0, 0, 0);
    if (G.tex && G.tex.on) {
      sun.castShadow = true;                                // DESIGN §5.5：唯一投影灯
      sun.shadow.mapSize.set(4096, 4096);
      sun.shadow.camera.left = -26; sun.shadow.camera.right = 26;
      sun.shadow.camera.top = 26; sun.shadow.camera.bottom = -26;
      /* near 才是阴影视锥的真实瓶颈（不是 ±26 正交框）：near=1 时最紧角点——东院围栏
         东北角 (20.4, 3.6, 10.2)——只剩 0.23m 余量，near=0.5 把余量翻到 0.7m 以上 */
      sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 60;
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
    camera.position.set(14, 1.65, 5.3);
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

    G.physics.init();          // 必须在 world.init 之前：world.init 会走到 rebuildGraph → syncStatics
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
    G.physics.update(dt);      // 在 player 之后：松手那一帧箱当帧就飞出去；在 customers 之前：顾客看到的是本帧最新箱位
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
    syncCashiers();
    G.ui.toast('备货阶段：Tab 开电脑订货，按 O 开门营业');
    if (G.state._migrated) {
      G.ui.toast('存档已升级：店铺按新布局重建，原货架库存 ' + G.fmt(G.state._migrated.refund) + ' 已按进价折现入余额', 'warn');
      G.state._migrated = null;
    }
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

  /* 新游戏 / 读档后按 G.state.registers[i].staffed 逐台同步一次站桩 */
  function syncCashiers() {
    var regs = G.state.registers || [];
    for (var i = 0; i < regs.length; i++) G.world.setCashierVisible(i, regs[i].staffed);
  }

  function onCashierChanged(payload) {
    G.world.setCashierVisible(payload.index | 0, payload.hired);
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

  /* 工资按 staffed 的收银台台数计（design §6） */
  function staffedWage() {
    var regs = G.state.registers || [];
    var n = 0;
    for (var i = 0; i < regs.length; i++) if (regs[i].staffed) n++;
    return n * G.data.CONFIG.cashierWage;
  }

  /* 日固定支出：基础房租 + 每个已开区域的租金 + 货架/冷藏柜水电 + 收银员工资（design §6） */
  function computeRent() {
    var cfg = G.data.CONFIG;
    var racks = countRacks();
    var rentZ = cfg.rentPerZone || {};
    var zones = G.state.zones || {};
    return round2(cfg.rentPerDay
      + (zones.W ? rentZ.W : 0) + (zones.B ? rentZ.B : 0) + (zones.C ? rentZ.C : 0)
      + racks.shelfGroups * cfg.utilPerShelf
      + racks.fridges * cfg.utilPerFridge
      + staffedWage());
  }

  function endDay() {
    if (phase !== 'closing') return;
    phase = 'summary';
    // 站在收银台打烊时必须退出收银模式，否则次日玩家被冻结且 #pos 一直挂在屏幕上
    if (G.checkout.exitRegister) G.checkout.exitRegister();

    var cfg = G.data.CONFIG;
    var rent = computeRent();

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

  /* 真实 draw call 天花板（主 pass + 阴影 pass 一帧合计）。与 perf.mainPassDrawables 的 760
     是两个口径：760 数的是主 pass 可见对象数（spec §8 原意），这里数的是渲染器实际提交数。
     C-终审满配实测 939（主 702 + 阴影 237，全场入镜机位）；天花板取 1050 =
     主 pass 天花板 760 + 阴影 pass 余量 290，与 760 同步扩容。 */
  var RENDER_CALL_CEILING = 1050;

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
    /* 自测会 resetSave / nextDay 存盘 / 写 v1 迁移样本——而玩家的真实存档就在同一个
       localStorage（同机 file:// 直接开 index.html 游玩，自测页与游戏页同域同源）。
       起手快照两个存档键，收尾（含异常路径，见 finally）无条件还原：原值为 null 则删键。 */
    var saveBackup = null;
    try {
      saveBackup = { 'gss-save-v1': localStorage.getItem('gss-save-v1'), 'gss-save-v2': localStorage.getItem('gss-save-v2') };
    } catch (e) {
      saveBackup = null;
    }
    function restoreSaveKeys() {
      if (!saveBackup) return;
      try {
        for (var k in saveBackup) {
          if (!saveBackup.hasOwnProperty(k)) continue;
          if (saveBackup[k] == null) localStorage.removeItem(k);
          else localStorage.setItem(k, saveBackup[k]);
        }
      } catch (e) {
        // 还原失败（存储被禁）不影响自测判定
      }
    }

    function currentTx() { return G.checkout._test.tx(0); }
    function serveTx() {
      var regs = G.checkout._test.registers();
      for (var i = 0; i < regs.length; i++) {
        var t = G.checkout._test.tx(i);
        if (!t || t.phase !== 'ready') continue;
        G.checkout._test.scanAll(i);
        withRandom(0.1, (function (k) {                              // 0.1 < 0.55 → 刷卡
          return function () { G.checkout._test.settle(k); };
        })(i));
        G.checkout._test.payCard(i);
      }
    }

    try {
      G.resetSave();
      startGame();

      ck('boot.scene', !!scene && !!camera && G.world.slots.length === 24, '格位 ' + G.world.slots.length);
      ck('boot.nav', !!G.world.nav.entry && G.world.nav.registers.length >= 1 &&
        G.world.nav.registers[0].queueSpots.length === 4 && G.world.nav.aisleSpots.length === 4,
        'aisle ' + G.world.nav.aisleSpots.length + ' / 收银台 ' + G.world.nav.registers.length);
      ck('boot.state', G.state.money === 800 && G.state.day === 1 && G.state.level === 1, G.fmt(G.state.money));

      /* --- C-T1 壳体与分区（新布局地基）--- */
      ck('world.shellSize', G.world.colliders.length >= 18, '大壳 collider 数 ' + G.world.colliders.length);
      var builtB = 0;
      for (var zi = 0; zi < G.world.slots.length; zi++) {
        var zs = G.world.slots[zi];
        if (zs.pos.x < -0.2 && zs.pos.z > -4 && zs.pos.z < 4) builtB++;   // B 区范围内的格位
      }
      ck('world.zoneGating', builtB === 0, '未购区域 B 不得有格位（现 ' + builtB + '）');
      ck('world.zoneState', G.state.zones && G.state.zones.A === true && G.state.zones.B === false,
        JSON.stringify(G.state.zones));
      var bWallOk = false;
      for (var bw = 0; bw < G.world.colliders.length; bw++) {
        var bc = G.world.colliders[bw];
        if (bc.minX <= 0 && bc.maxX >= 0 && bc.minX > -0.5 && bc.maxX < 0.5 && bc.minZ <= -3.5 && bc.maxZ >= 3.5) { bWallOk = true; break; }
      }
      ck('world.zoneBWall', bWallOk, 'x=0 区界墙 collider 必须存在（B 区物理封锁）');

      /* --- C-T2 寻路 --- */
      ck('nav.api', typeof G.world.nav.findPath === 'function', '缺 findPath');
      var p1 = G.world.nav.findPath(G.world.nav.entry, G.world.nav.aisleSpots[0]);
      ck('nav.pathFound', Array.isArray(p1) && p1.length >= 1, 'entry→A区走廊 路径点 ' + (p1 && p1.length));
      var pB = G.world.nav.findPath(G.world.nav.entry, new THREE.Vector3(-10, 0, 0));
      ck('nav.gateBlocks', Array.isArray(pB) && pB.length === 0, '未购区域 B 必须不可达（返回 []）');
      var clearOk = true;
      if (p1 && p1.length) {
        var prev = G.world.nav.entry;
        for (var pi = 0; pi < p1.length && clearOk; pi++) {
          if (G.world.nav._segBlocked(prev, p1[pi])) clearOk = false;
          prev = p1[pi];
        }
      }
      ck('nav.pathClear', clearOk, '路径各段不得穿 collider');

      /* --- C-T3 多收银台 ---
         checkout.perRegisterFrame / checkout.shortestQueue 需要三台同时在场，
         已移到本文件末尾的全开块（checkout.threeRegisters 之后） */
      var regs = G.checkout._test.registers();

      /* GDD §7「每台 5 位」：front + queueSpots×4。假顾客灌满一台后立即标记 removed 让 prune 清走，
         不能留在队里干扰后面的 customer.queued */
      var r0 = G.world.registers[0];
      var fakeQ = [], joinedN = 0;
      for (var qi = 0; qi < 6; qi++) {
        var fc = {
          state: 'queueing', removed: false, queueTarget: null,
          moveTo: function (t) { this.queueTarget = t; },
          atDestination: function () { return false; }
        };
        if (G.checkout.joinQueue(fc)) { fakeQ.push(fc); joinedN++; }
      }
      var qCapOk = joinedN === 5 && regs[0].queue.length === 5 &&
        fakeQ[0].queueTarget === r0.front && fakeQ[4].queueTarget === r0.queueSpots[3];
      var q5z = (fakeQ[4] && fakeQ[4].queueTarget) ? fakeQ[4].queueTarget.z : 'n/a';   // prune 会清掉 queueTarget，先取
      for (var qj = 0; qj < fakeQ.length; qj++) fakeQ[qj].removed = true;
      G.checkout.update(0.05);   // prune 清走假顾客
      ck('checkout.queueCap', qCapOk && regs[0].queue.length === 0,
        '单台应容 front + 4 队位 = 5 人（实入队 ' + joinedN + '，第 5 人目标 z=' + q5z +
        '，应 = queueSpots[3] 的 ' + r0.queueSpots[3].z + '；清理后残留 ' + regs[0].queue.length + '）');

      var shuttersAtBoot = G.world.interactables.filter(function (it) { return it.type === 'shutter'; }).length;
      var bzBefore = G.state.money;
      var bzLevelReject = G.shop.buyZone('B') === false && G.state.money === bzBefore;
      /* 「等级够、钱不够」分支此前从未被求值（spec §9 缺口）：临改 state 探一次，finally 还原 */
      var bzLvSnap = G.state.level, bzMoneySnap = G.state.money, bzPoorReject = false;
      try {
        G.state.level = G.data.CONFIG.zoneLevels.B;
        G.state.money = G.data.CONFIG.zonePrices.B - 1;
        bzPoorReject = G.shop.buyZone('B') === false && G.state.zones.B === false &&
          G.state.money === G.data.CONFIG.zonePrices.B - 1;
      } finally {
        G.state.level = bzLvSnap; G.state.money = bzMoneySnap;
      }
      ck('shop.buyZoneGates', bzLevelReject && bzPoorReject,
        'Lv1 等级门槛拒绝且不扣钱 ' + bzLevelReject + '；Lv' + G.data.CONFIG.zoneLevels.B +
        ' 但余额差 ¥1 时拒绝、不扣钱、不开区 ' + bzPoorReject);

      /* C-T7：卷帘门价格/等级单一真相在 CONFIG——提示文案若还读 SHUTTERS 表的副本，
         改 CONFIG 会「显示旧价、扣新价」。临时改 CONFIG 后提示必须跟着变 */
      var shEntry = null;
      for (var shi = 0; shi < G.world.interactables.length && !shEntry; shi++) {
        var shIt = G.world.interactables[shi];
        if (shIt.type === 'shutter' && shIt.data.zone === 'B') shEntry = shIt;
      }
      var zpB = G.data.CONFIG.zonePrices.B, zlB = G.data.CONFIG.zoneLevels.B;
      var lvSnap = G.state.level, moneySnap = G.state.money;
      var shLvTxt = '', shPriceTxt = '';
      G.data.CONFIG.zonePrices.B = 4242; G.data.CONFIG.zoneLevels.B = 9;
      try {
        G.state.level = 1;
        shLvTxt = shEntry ? String(G.player._test.prompt(shEntry)) : '(无卷帘门交互体)';
        // 等级分支会提前 return，价格分支必须单独探一次：过等级门槛、钱不够
        G.state.level = 9; G.state.money = 0;
        shPriceTxt = shEntry ? String(G.player._test.prompt(shEntry)) : '(无卷帘门交互体)';
      } finally {
        G.data.CONFIG.zonePrices.B = zpB; G.data.CONFIG.zoneLevels.B = zlB;
        G.state.level = lvSnap; G.state.money = moneySnap;
      }
      ck('shop.shutterPriceSingleSource',
        shLvTxt.indexOf('Lv9') !== -1 && shPriceTxt.indexOf(G.fmt(4242)) !== -1,
        '把 CONFIG 的 B 区门槛改成 Lv9/4242 后——等级分支「' + shLvTxt +
        '」；价格分支「' + shPriceTxt + '」（应含 ' + G.fmt(4242) + '）');

      /* --- 订货 --- */
      var m0 = G.state.money;
      var ordered = G.shop.orderBoxes([{ pid: 'f_noodle', qty: 1 }, { pid: 'd_water', qty: 1 }]);
      var expCost = (1.20 * 24 + 3) + (0.60 * 24 + 3);   // 31.8 + 17.4
      ck('shop.order', ordered === true, '返回 ' + ordered);
      ck('shop.charge', Math.abs((m0 - G.state.money) - expCost) < 0.01, '扣款 ' + round2(m0 - G.state.money) + ' / 预期 ' + expCost);
      ck('shop.lockedRejected', G.shop.orderBoxes([{ pid: 'p_apple', qty: 1 }]) === false, '未解锁商品应拒单');

      /* C-T7：订货容量判据必须单一真相——UI 只看院内箱数会漏掉在途队列，
         出现「按钮可点、下单静默失败」。现场：院内 0 箱 + 上面订的 2 箱在途 */
      var roomFn = G.shop.yardHasRoomFor;
      var roomHas = typeof roomFn === 'function';
      ck('shop.yardRoomSingleSource', roomHas && roomFn(10) === true && roomFn(11) === false,
        roomHas ? ('院内 0 + 在途 2：判据 10 箱→' + roomFn(10) + '、11 箱→' + roomFn(11) + '（应 true/false）')
                : 'G.shop.yardHasRoomFor 缺失：UI 与 orderBoxes 仍是两套判据');

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

      /* --- C-T4 仓库 ---
         位置在「强制送达」之后：本块开 W 区会把卸货区切到西侧并灌满，
         早于此处的 shop.order（卸货区容量校验）/ shop.delivery / world.boxShape /
         world.slotShape（W 区不含货架，但顺序上以既有断言为准）都不受影响；
         shuttersAtBoot 的开局计数也已在本块之前取样 */
      ck('world.storageApi', typeof G.world.storeBox === 'function' && typeof G.world.takeBox === 'function',
        '缺 storeBox/takeBox');
      // 直接开仓测试（绕过钱：手动置区+建造——T6 前 zones 尚不入存档，安全）
      G.state.zones.W = true;
      G.world.buildZone('W');
      ck('world.storageBuilt', (G.world.storageSlots || []).length === 24,
        '存储位 ' + (G.world.storageSlots || []).length + '（应 24）');
      var stBox = G.world.spawnBox('f_noodle');
      var stSlot = G.world.storageSlots[0];
      var stOk = G.world.storeBox(stSlot, stBox);
      ck('world.storageStore', stOk === true && stSlot.box === stBox &&
        Math.abs(stBox.mesh.position.x - stSlot.pos.x) < 0.01, '放箱入位');
      var back = G.world.takeBox(stSlot);
      ck('world.storageTake', back === stBox && stSlot.box === null && back.rb === null, '取箱出位');
      // 序列化往返
      G.world.storeBox(stSlot, stBox);
      var stData = G.world.serializeStorage();
      ck('world.storageRoundtrip', Array.isArray(stData) && stData.length === 1 &&
        stData[0].id === stSlot.id && stData[0].pid === 'f_noodle', JSON.stringify(stData));
      G.world.takeBox(stSlot);   // 清场；stBox 留在场上由后续断言消耗或无害
      /* C-T6：真往返——上一条只验了 serialize，restoreStorage 与 left 字段此前零覆盖。
         顺带钉死「一箱两位」：同一箱换位后旧位必须释放，否则 serializeStorage 出重复条目 */
      G.world.storeBox(stSlot, stBox);
      stBox.itemsLeft = 7;
      var stData2 = G.world.serializeStorage();
      G.world.takeBox(stSlot);
      G.world.restoreStorage(stData2);
      var rBox = stSlot.box;
      var rMoved = !!rBox && G.world.storeBox(G.world.storageSlots[3], rBox) === true;
      var rNoDup = G.world.serializeStorage().length === 1;
      G.world.takeBox(G.world.storageSlots[3]);
      ck('world.storageRestore', !!rBox && rBox !== stBox && rBox.productId === 'f_noodle' &&
        rBox.itemsLeft === 7 && rMoved && rNoDup,
        JSON.stringify({ pid: rBox && rBox.productId, left: rBox && rBox.itemsLeft, moved: rMoved, noDup: rNoDup }));
      // 卸货区满 → spawnBox 返回 null
      var spawned = 0, lastSpawn = true;
      for (var yb = 0; yb < 14 && lastSpawn; yb++) {
        lastSpawn = !!G.world.spawnBox('d_water');
        if (lastSpawn) spawned++;
      }
      ck('world.freeYardSlotNull', lastSpawn === false && spawned <= 12,
        '卸货区满后 spawnBox 必须返回 null（本轮成功 ' + spawned + ' 箱，含前序残留合计 ≤12 位）');

      /* --- C-T5 经济 --- */
      ck('level.tableV2', G.data.LEVELS.length === 10 &&
        G.data.CONFIG.zonePrices && G.data.CONFIG.zonePrices.B === 1500 &&
        G.data.CONFIG.rentPerZone && G.data.CONFIG.rentPerZone.C === 40,
        'LEVELS/zonePrices/rentPerZone 新表');

      /* 买仓库不得反锁死订货：订单容量只看卸货区 12 位，仓库 24 位不计入（spec §5）。
         现场即上一条留下的满院——把其中一箱挪进仓库位后订货必须重新放行 */
      var fullReject = G.shop.orderBoxes([{ pid: 'f_noodle', qty: 1 }]);
      var yardBox = null;
      for (var ybi = 0; ybi < G.world.interactables.length && !yardBox; ybi++) {
        var ybIt = G.world.interactables[ybi];
        if (ybIt.type === 'box' && G.world.isOnYard(ybIt.mesh)) yardBox = ybIt.data.box;
      }
      var ybStored = !!yardBox && G.world.storeBox(G.world.storageSlots[1], yardBox);
      var afterStore = G.shop.orderBoxes([{ pid: 'f_noodle', qty: 1 }]);
      ck('shop.orderRejectWhenFull', fullReject === false && ybStored === true && afterStore === true,
        '满院拒单 ' + fullReject + '，入仓一箱后放行 ' + afterStore);

      /* C-T6：卸货区满时送达必须延后而非丢箱（spec §8 钉死债务 #2）。
         承接上一条现场：院内 11 箱 + 上一条订的 1 箱在途——先把院填满 12 位。 */
      function yardBoxCount() {
        return G.world.interactables.filter(function (it) {
          return it.type === 'box' && G.world.isOnYard(it.mesh);
        }).length;
      }
      var deliverN = 0;
      function onDeliveryEvt() { deliverN++; }
      G.bus.on('delivery', onDeliveryEvt);
      var padBox = G.world.spawnBox('d_water');
      var yardFullN = yardBoxCount();
      G.shop.update(G.data.CONFIG.deliverySec + 2);   // 到点但无空位：条目必须留在队列里
      var deferOk = !!padBox && yardBoxCount() === yardFullN && deliverN === 0;
      var padStored = G.world.storeBox(G.world.storageSlots[2], padBox);   // 腾一位
      G.shop.update(3);
      var resumeOk = padStored === true && yardBoxCount() === yardFullN && deliverN === 1;
      G.bus.off('delivery', onDeliveryEvt);
      ck('shop.yardFullDefer', deferOk && resumeOk,
        '满院时挂起 ' + deferOk + '（院内 ' + yardFullN + ' 箱），腾位后送达 ' + resumeOk + '（delivery 事件 ' + deliverN + ' 次）');

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

      /* --- D-T1 物理引擎与静态刚体（spec §2/§3/§4）--- */
      ck('physics.engineLoaded',
        typeof CANNON !== 'undefined' && CANNON.version === '0.6.2' &&
        typeof CANNON.NaiveBroadphase === 'function' && !!G.physics && !!G.physics._test,
        'CANNON ' + (typeof CANNON !== 'undefined' ? CANNON.version : 'undefined') +
        '，G.physics ' + (G.physics ? 'ok' : '缺'));
      ck('physics.staticsMatchColliders',
        !!G.physics && G.physics._test.staticCount() === G.world.colliders.length + 2,
        '静态体 ' + (G.physics ? G.physics._test.staticCount() : -1) +
        ' / collider ' + G.world.colliders.length + ' + 2 plane');
      var chOk = true, chBad = '';
      for (var chi = 0; chi < G.world.colliders.length; chi++) {
        var chc = G.world.colliders[chi];
        var chH = (typeof chc.h === 'number') ? chc.h : (G.world.WALL_H || 3.6);
        var chW = round2(chc.maxX - chc.minX), chD = round2(chc.maxZ - chc.minZ);
        var want = null;
        if (chc.zoneGate) want = 3.0;
        else if (chW === 2 && chD === 0.8) want = 1.8;
        else if (chW === 2 && chD === 1.2) want = 1.08;
        else if (chW === 0.5 && chD === 0.4) want = 0.9;    // 订货电脑
        else if (chW === 0.6 && chD === 0.6) want = 0.6;    // 垃圾桶
        if (!(chH > 0 && chH <= (G.world.WALL_H || 3.6))) { chOk = false; chBad = '#' + chi + ' h=' + chH + ' 越界'; break; }
        if (want !== null && chH !== want) { chOk = false; chBad = '#' + chi + ' ' + chW + '×' + chD + ' h=' + chH + '，应 ' + want; break; }
      }
      ck('physics.colliderHeights', chOk, chBad || ('全部 ' + G.world.colliders.length + ' 条 collider 的 h 合规'));
      var ceil9 = G.physics ? G.physics._test.probeCeiling(9.0) : 99;
      var ceil12 = G.physics ? G.physics._test.probeCeiling(12.0) : 99;
      var wallH = G.world.WALL_H || 3.6;
      ck('physics.ceilingCaps', ceil9 <= wallH && ceil12 <= wallH,
        '12 只箱 ×300 步 aabb 顶最大：v0=9.0 → ' + round2(ceil9) + '，v0=12.0 → ' + round2(ceil12) +
        '（天花板 plane y=' + (G.physics ? G.physics.CEIL_Y : '?') + '，须 ≤ WALL_H ' + wallH + '）');
      var tunV = G.player._test.throwConsts ? G.player._test.throwConsts().vMax : 9.0;
      var tun = G.physics ? G.physics._test.probeTunnel(tunV) : { wallZ: 99, dropY: -1 };
      ck('physics.noTunneling', tun.wallZ < 2.8 && tun.dropY > 0,
        'v=' + tunV + ' 正对半厚 0.2 的墙（内面 z=2.8）120 步后 z=' + round2(tun.wallZ) +
        '；竖直下扔 120 步后 y=' + round2(tun.dropY));
      ck('physics.noInterpolatedQuaternion',
        !!G.physics && G.physics._test.src().indexOf('interpolatedQuaternion') === -1,
        'js/physics.js 整个模块（IIFE 全文）源码不得出现 interpolatedQuaternion（cannon 0.6.2 对醒着的动态体永不写入该字段，失效静默）');

      /* CEIL_Y 除 §9.2 阴影视锥外还承载「翻不过关着的卷帘门」：门洞处墙体断开，
         关闭的卷帘门静态体只到 h=3.0，其上到 WALL_H 的空当由天花板 plane 压住。
         空当 ≥ 箱边长 0.45 就能隔着关门往未购区域扔箱（CEIL_Y ≥ 3.45 即开洞）。当前
         WALL_H=3.6 下 ceilingCaps 恰好也在 3.45 跟着红，纯属巧合——WALL_H 一抬它就放宽，
         而本条不动（详见 js/physics.js CEIL_Y 注释）。0.45 = 纸箱 BoxGeometry 边长，
         physics 未导出 BOX_HALF，为这一处扩契约不值，故用字面量。 */
      /* 取【最矮】那扇门：空当 = CEIL_Y − 门顶，门越矮空当越大、exploit 越真，取 max
         是往宽松方向错。当前每扇门都被 colliderHeights 钉死在 3.0 故 min/max 同值，但
         本条断言的正确性不该隐式挂在另一条断言上。找不到门时回落 0，交给 gateH > 0
         的退化守卫（卷帘门 collider 全被误删 / h 被摘掉都必须红，不能静默通过）。 */
      var gateH = Infinity;
      for (var gi = 0; gi < G.world.colliders.length; gi++) {
        var gc = G.world.colliders[gi];
        if (gc.zoneGate && typeof gc.h === 'number' && gc.h < gateH) gateH = gc.h;
      }
      if (gateH === Infinity) gateH = 0;
      ck('physics.ceilingSealsZoneGates',
        !!G.physics && gateH > 0 && (G.physics.CEIL_Y - gateH) < 0.45,
        '门顶 ' + gateH + ' → 天花板 ' + (G.physics ? G.physics.CEIL_Y : '?') + '，空当 ' +
        round2((G.physics ? G.physics.CEIL_Y : 99) - gateH) + 'm，须 < 箱边长 0.45');

      /* --- D-T2 箱三态与刚体生命周期（spec §3.4 / §5）--- */
      var stSlotP = null;
      for (var spi = 0; spi < G.world.storageSlots.length; spi++) {
        if (!G.world.storageSlots[spi].box) { stSlotP = G.world.storageSlots[spi]; break; }
      }
      var pbox = G.world.spawnBox('f_noodle', { x: 6.0, z: 6.0 });
      var trail = [];
      if (pbox && stSlotP) {
        trail.push(G.physics._test.stateOf(pbox) + ':' + (pbox.rb ? pbox.rb.type : 'none'));
        G.player._test.pickUp(pbox);
        trail.push(G.physics._test.stateOf(pbox) + ':' + (pbox.rb ? pbox.rb.type : 'none'));
        G.player._test.putDown();
        trail.push(G.physics._test.stateOf(pbox) + ':' + (pbox.rb ? pbox.rb.type : 'none'));
        G.player._test.pickUp(pbox);
        G.player._test.storeInto(stSlotP);
        trail.push(G.physics._test.stateOf(pbox) + ':' + (pbox.rb ? pbox.rb.type : 'none'));
        G.player._test.pickUp(pbox);
        trail.push(G.physics._test.stateOf(pbox) + ':' + (pbox.rb ? pbox.rb.type : 'none'));
        G.player._test.putDown();
        trail.push(G.physics._test.stateOf(pbox) + ':' + (pbox.rb ? pbox.rb.type : 'none'));
      }
      ck('physics.boxStates',
        trail.join('|') === 'loose:' + CANNON.Body.DYNAMIC + '|held:none|loose:' + CANNON.Body.DYNAMIC +
        '|slotted:' + CANNON.Body.STATIC + '|held:none|loose:' + CANNON.Body.DYNAMIC,
        '拿起→放下→存入→取出→放下 全环：' + trail.join(' → '));

      var slotStaticOk = false, slotDrift = -1;
      if (pbox && stSlotP) {
        G.player._test.pickUp(pbox);
        G.player._test.storeInto(stSlotP);
        if (pbox.rb && pbox.rb.type === CANNON.Body.STATIC) {
          pbox.rb.applyImpulse(new CANNON.Vec3(50, 0, 0), new CANNON.Vec3(pbox.rb.position.x, pbox.rb.position.y, pbox.rb.position.z));
          for (var sst = 0; sst < 60; sst++) G.physics._test.stepOnce();
          slotDrift = Math.sqrt(
            Math.pow(pbox.mesh.position.x - stSlotP.pos.x, 2) +
            Math.pow(pbox.mesh.position.z - stSlotP.pos.z, 2));
          slotStaticOk = slotDrift < 1e-6;
        }
      }
      /* 鉴别力在 type === STATIC 那个分支守卫上：休眠动态体方案下 type 仍是 DYNAMIC，
         整段被跳过、slotDrift 停在 -1 而红。位移恒为 0 是结构性的（静态体不积分、
         applyImpulse 对 invMass=0 是空操作、stepOnce 不写 mesh），不是被验出来的。 */
      ck('physics.slottedIsStatic', slotStaticOk,
        'slotted 箱须为 STATIC（受冲量与 60 步积分后位移恒 0），实测位移 ' + slotDrift);

      var dBefore = G.physics._test.bodyCount();
      var dRb = pbox ? pbox.rb : null;
      if (pbox) G.world.destroyBox(pbox);
      var dAfter = G.physics._test.bodyCount();
      var dGone = !!dRb && !G.physics._test.hasBody(dRb) && pbox.rb === null;
      ck('physics.destroyRemovesBody', dAfter === dBefore - 1 && dGone,
        'destroyBox 后 body 数 ' + dBefore + ' → ' + dAfter +
        '，原 body 已不在 world.bodies 且 box.rb 已置空=' + dGone);

      var mfBox = G.world.spawnBox('d_water', { x: 6.0, z: 5.0 });
      var mfOk = false, mfDetail = '无箱';
      if (mfBox && mfBox.rb) {
        mfBox.rb.wakeUp();
        mfBox.rb.velocity.set(0.6, 2.0, 0.4);
        mfBox.rb.angularVelocity.set(2, 3, 1);
        for (var mfi = 0; mfi < 30; mfi++) G.physics.update(1 / 60);
        var mfDp = Math.sqrt(
          Math.pow(mfBox.mesh.position.x - mfBox.rb.interpolatedPosition.x, 2) +
          Math.pow(mfBox.mesh.position.y - mfBox.rb.interpolatedPosition.y, 2) +
          Math.pow(mfBox.mesh.position.z - mfBox.rb.interpolatedPosition.z, 2));
        var mfDq = Math.max(
          Math.abs(mfBox.mesh.quaternion.x - mfBox.rb.quaternion.x),
          Math.abs(mfBox.mesh.quaternion.y - mfBox.rb.quaternion.y),
          Math.abs(mfBox.mesh.quaternion.z - mfBox.rb.quaternion.z),
          Math.abs(mfBox.mesh.quaternion.w - mfBox.rb.quaternion.w));
        // 箱必须真的转过：否则「写回 quaternion」与「压根没写」在数值上无法区分（空断言）
        var mfSpun = Math.abs(mfBox.mesh.quaternion.w - 1) > 1e-3;
        mfOk = mfDp < 1e-6 && mfDq < 1e-6 && mfSpun;
        mfDetail = 'Δpos ' + mfDp + '，Δquat ' + mfDq + '，已转过（quat.w=' +
          round2(mfBox.mesh.quaternion.w) + '）=' + mfSpun;
      }
      ck('physics.meshFollowsBody', mfOk, '30 帧后 mesh 必须逐字跟随 body：' + mfDetail);
      if (mfBox) G.world.destroyBox(mfBox);

      ck('shadow.rendererState', !renderer ||
        (renderer.shadowMap.enabled === !!G.tex.on && (!G.tex.on || renderer.shadowMap.type === THREE.PCFSoftShadowMap)),
        'shadowMap enabled=' + (renderer && renderer.shadowMap.enabled) + ' type=' + (renderer && renderer.shadowMap.type));
      var sunRef = null;
      scene.traverse(function (o) { if (!sunRef && o.isDirectionalLight) sunRef = o; });
      var frusOk = true, frusDetail = '', frusSlack = Infinity, frusTight = '';
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
          /* 采样高度读 WALL_H：字面量 3 是 WALL_H=3.0 时代的残留，C 期墙高 3.6 后
             墙顶 3.0-3.6 段从未被验证在视锥内 */
          var xs = [col.minX, col.maxX], zs = [col.minZ, col.maxZ];
          var ys = [0, (G.world.WALL_H || 3.6)];
          for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var d = 0; d < 2; d++) {
            var pt = new THREE.Vector3(xs[a], ys[d], zs[b]).applyMatrix4(toLight);
            /* 六个面的最小余量：真实瓶颈是 near 而不是正交框，余量塌到 0 的那一刻
               表现是「东院方向抬高的物件影子突然消失」，无人会想到是视锥 */
            var slack = Math.min(pt.x - shCam.left, shCam.right - pt.x,
              pt.y - shCam.bottom, shCam.top - pt.y,
              (-pt.z) - shCam.near, shCam.far - (-pt.z));
            if (slack < frusSlack) {
              frusSlack = slack;
              frusTight = '#' + ci + '(' + round2(xs[a]) + ',' + ys[d] + ',' + round2(zs[b]) + ')';
            }
            if (pt.x < shCam.left || pt.x > shCam.right || pt.y < shCam.bottom || pt.y > shCam.top ||
                -pt.z < shCam.near || -pt.z > shCam.far) {
              frusOk = false;
              frusDetail = 'collider#' + ci + ' 角点越界 ' + JSON.stringify({ x: round2(pt.x), y: round2(pt.y), z: round2(pt.z) });
              break;
            }
          }
        }
      }
      ck('shadow.frustumCovers', frusOk, frusDetail || (G.tex.on
        ? ('全部 collider 角点在阴影视锥内（采样高度 y=0..WALL_H ' + (G.world.WALL_H || 3.6) +
           '，最小余量 ' + round2(frusSlack) + 'm @ collider' + frusTight + '）')
        : 'lowfx 跳过'));
      var shellOk = true;
      scene.traverse(function (o) {
        if (o.isMesh && o.castShadow) {
          if (o.userData.shell) shellOk = false;
          else if (o.geometry && o.geometry.parameters) {
            var pp = o.geometry.parameters;
            if ((pp.width >= 12 || pp.depth >= 12) && o.position.y >= 1) shellOk = false;  // 大跨度高位物 = 墙/天花板（第二道防线）
          }
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

      /* --- 顾客构造与步态（B-T6）--- */
      var ct = G.customers._test;
      ck('cust.testHook', !!ct && typeof ct.spawnOne === 'function' && typeof ct.gait === 'function',
        '缺 _test.spawnOne/gait');
      if (ct && ct.spawnOne) {
        var minTop = 99, maxTop = 0, partsOk = true, rootYOk = true, matSharedSeen = {};
        for (var si2 = 0; si2 < 50; si2++) {
          var cc = ct.spawnOne();
          var meshN = 0, top = 0;
          cc.mesh.traverse(function (o) {
            if (o.isMesh && o.parent !== cc.hands) meshN++;
          });
          cc.mesh.updateMatrixWorld(true);
          var bb2 = new THREE.Box3().setFromObject(cc.mesh);
          top = bb2.max.y;
          if (meshN !== 9) partsOk = false;
          if (top < minTop) minTop = top;
          if (top > maxTop) maxTop = top;
          if (cc.mesh.position.y !== 0) rootYOk = false;
          var shirtHex = cc.shirtMat.color.getHex();
          if (matSharedSeen[shirtHex] && matSharedSeen[shirtHex] !== cc.shirtMat) matSharedSeen[shirtHex] = 'DIFF';
          else if (!matSharedSeen[shirtHex]) matSharedSeen[shirtHex] = cc.shirtMat;
          ct.remove(cc);
        }
        ck('cust.parts', partsOk, '躯干+头+发+臂×2+腿×2+鞋×2 = 9 个 mesh（手持组除外）');
        ck('cust.height', minTop >= 1.55 && maxTop <= 1.92,
          '50 次头顶 y ∈ [' + minTop.toFixed(2) + ', ' + maxTop.toFixed(2) + ']，应在 [1.55,1.92]');
        /* 上界 1.92 而非 spec 的 1.90：基高 1.7655（蓬顶发型）× h 上限 1.08 = 1.907，
           spec §6 的 [1.55,1.90] 未计发型高度，按实际几何修正——T7 校准回写时同步 spec */
        var matOk = true;
        for (var mk in matSharedSeen) if (matSharedSeen[mk] === 'DIFF') matOk = false;
        ck('cust.matShared', matOk, '同色衣装必须共享材质实例');
        ck('cust.rootY', rootYOk, '50 次采样根节点 y 必须恒为 0');
        var gc = ct.spawnOne();
        var maxAmp = 0;
        for (var gt = 0; gt < 120; gt++) {
          ct.gait(gc, 1 / 60, true);
          var la = Math.abs(gc.legL.rotation.x);
          if (la > maxAmp) maxAmp = la;
        }
        /* 上界 0.4451：0.44×amp（amp≤1）的不可达上界 +1.16% 容差（0.44×1.0116≈0.4451）；有效防线是下界 0.2 */
        ck('cust.gaitAmp', maxAmp > 0.2 && maxAmp <= 0.4451,
          '腿摆峰值 ' + maxAmp.toFixed(3) + ' rad，应 ∈ (0.2, 0.4451]');
        for (var gt2 = 0; gt2 < 60; gt2++) ct.gait(gc, 1 / 60, false);
        ck('cust.gaitDecay', Math.abs(gc.legL.rotation.x) < 0.01 && gc.mesh.position.y === 0,
          '静止 1s 后腿角 ' + gc.legL.rotation.x.toFixed(4) + '，根 y=' + gc.mesh.position.y);
        ct.remove(gc);
      }

      /* --- D-T4 被砸倒地（spec §7）--- */
      function makeKnockBox(c, speed) {
        var p = c.mesh.position;
        var b = G.world.spawnBox('f_noodle', { x: p.x, z: p.z - 0.2 });
        if (!b) return null;
        b.mesh.position.set(p.x, 1.0, p.z - 0.2);
        if (b.rb) {
          b.rb.position.set(p.x, 1.0, p.z - 0.2);
          b.rb.wakeUp();
          b.rb.velocity.set(0, 0, speed);
        }
        return b;
      }
      var kc = G.customers._test.spawnOne();
      kc.mesh.position.set(6.0, 0, 0.0);
      kc.mesh.rotation.y = 0;                       // 正前方 = 局部 +Z
      var kbox = makeKnockBox(kc, 5.0);
      G.customers._test.stepOne(kc, 0.05);          // 触发帧：只置位，姿态从下一帧起推进
      var kTriggered = kc.ragdoll === true;
      var kOrder = kc.mesh.rotation.order;
      for (var kfi = 0; kfi < 5; kfi++) G.customers._test.stepOne(kc, 0.05);   // 累计 0.25s
      var kFallen = Math.abs(Math.abs(kc.mesh.rotation.x) - Math.PI / 2) < 0.01;
      ck('cust.knockdown', kTriggered && kOrder === 'YXZ' && kFallen,
        'ragdoll=' + kc.ragdoll + '，rotation.order=' + kOrder +
        '，0.25s 后 rotation.x=' + round2(kc.mesh.rotation.x) + '（应 ±' + round2(Math.PI / 2) + '）');
      if (kbox) G.world.destroyBox(kbox);

      var sc2 = G.customers._test.spawnOne();
      sc2.mesh.position.set(6.0, 0, 2.0);
      sc2.mesh.rotation.y = 0;
      var sbox = makeKnockBox(sc2, 1.0);            // < 2.5 m/s
      for (var sfi = 0; sfi < 10; sfi++) G.customers._test.stepOne(sc2, 0.05);
      ck('cust.slowBoxNoKnockdown', sc2.ragdoll !== true,
        '1.0 m/s 的箱不得触发倒地，实测 ragdoll=' + sc2.ragdoll);
      if (sbox) G.world.destroyBox(sbox);

      var kp0 = kc.mesh.position.clone();
      var kTorso0 = kc.torso.position.y;
      var kFrozen = true;
      /* 夹具必须先「有可动的初值」，否则这条断言完全空洞：_test.spawnOne() 的顾客
         path 为空、amp/phase 为 0，于是 stepMove 第一行 `if (!c.path.length) return;` 直接返回，
         applyGait 的 bob = −0.03×|sin(0)|×0 恒为 0——把 stepCustomer 的 `if (!c.ragdoll)`
         整个拆掉（连同 applyGait 开头那道 `if (c.ragdoll) return;`）也一帧不动，实测仍 158/158 全绿。
         给它一条走得动的 path 和非零 amp/phase，「漏冻结」才有可观测后果。
         D-T5 追加：path 必须给到 2 个点、且窗口内摆一只 loose 箱，否则 stepAvoid 的探测段
         （`c.path.length > 1 && loose.length`）恒不成立、target 恒 0、da 恒 0——把 stepAvoid
         写到 `if (!c.ragdoll)` 外面同样一帧不动，这条断言对「倒地期绕行」依旧空洞。 */
      kc.path = [new THREE.Vector3(6.0, 0, 5.0), new THREE.Vector3(6.0, 0, 8.0)];
      kc.amp = 1;
      kc.phase = 1;
      var kAvoidBox = G.world.spawnBox('d_water', { x: 6.0, z: 0.8 });   // 正前方 0.8m，速度 0 不会二次砸倒
      var kRecover = -1, kDownPos = kp0.clone();     // kDownPos = 最后一个「仍在倒地」帧的位置
      for (var kri = 0; kri < 53; kri++) {           // 已推进 0.25s，再推进 2.65s → 合计 2.90s ≥ 2.85
        G.customers._test.stepOne(kc, 0.05);
        /* 爬起当帧 stepKnockdown 先置 ragdoll=false，同一帧 stepMove 就恢复行走（实测 0.08m
           = 1.6×0.05，正是想要的行为，不该浪费一帧）。所以位移判据只能取「倒地窗口内」，
           拿爬起后的 mesh.position 去比 kp0 会把正常复走误判成被撞飞。 */
        if (!kc.ragdoll) { kRecover = kri + 1; break; }
        if (kc.torso.position.y !== kTorso0 || kc.mesh.position.distanceTo(kp0) > 1e-9) kFrozen = false;
        kDownPos.copy(kc.mesh.position);
      }
      if (kAvoidBox) G.world.destroyBox(kAvoidBox);
      ck('cust.knockdownRecovers',
        kc.ragdoll === false && kc.mesh.rotation.x === 0 && kDownPos.distanceTo(kp0) < 1e-6,
        '2.9s 后 ragdoll=' + kc.ragdoll + '，rotation.x=' + kc.mesh.rotation.x +
        '，倒地窗口内位移 ' + kDownPos.distanceTo(kp0) + '（爬起当帧恢复行走属正常，不计入）');
      ck('cust.ragdollFreezesGait', kFrozen,
        '倒地期间 torso.position.y 与 mesh.position 必须一帧不动（applyGait 与 stepMove 双冻结）；' +
        '夹具已置 path/amp/phase 使漏冻结可观测，爬起于本段第 ' + kRecover + ' 帧');

      var hc = G.customers._test.spawnOne();
      hc.mesh.position.set(6.0, 0, -2.0);
      hc.mesh.rotation.y = 0;
      G.customers._test.addHand(hc, 'f_noodle');
      G.customers._test.addHand(hc, 'd_water');
      var hHands0 = hc.hands.children.length;
      var hbox = makeKnockBox(hc, 5.0);
      for (var hfi = 0; hfi < 10; hfi++) G.customers._test.stepOne(hc, 0.05);
      ck('cust.knockdownKeepsHands',
        hc.ragdoll === true && hc.hands.children.length === hHands0 && hc.hands.parent === hc.mesh,
        '倒地中手持 ' + hc.hands.children.length + '/' + hHands0 + ' 件，hands.parent === mesh=' +
        (hc.hands.parent === hc.mesh));
      if (hbox) G.world.destroyBox(hbox);

      var pc2 = G.customers._test.spawnOne();
      pc2.mesh.position.set(6.0, 0, -4.0);
      pc2.mesh.rotation.y = 0;
      pc2.state = 'queueing';
      pc2.patience = 0;
      var pbox2 = makeKnockBox(pc2, 5.0);
      for (var pfi = 0; pfi < 57; pfi++) G.customers._test.stepOne(pc2, 0.05);   // 2.85s
      if (pbox2) G.world.destroyBox(pbox2);
      ck('cust.knockdownPatienceRuns', Math.abs(pc2.patience - 2.85) < 0.05,
        '倒地 2.85s 期间 patience 增量 ' + round2(pc2.patience) + '（应 ≈2.85，证明 stepState 照常推进）');

      /* --- D-T5 局部绕行（spec §8；侧移改为 carrier 式，见计划 Task 5 的偏离说明）--- */
      var dc = G.customers._test.spawnOne();
      dc.mesh.position.set(6.0, 0, -6.0);
      dc.mesh.rotation.y = 0;                                  // 正前方 = +Z
      dc.lane = 0;
      dc.path = [new THREE.Vector3(6.0, 0, 0.0), new THREE.Vector3(6.0, 0, 6.0)];
      var dBox = G.world.spawnBox('f_noodle', { x: 6.0, z: -5.0 });
      var dLat = 0, dSum = 0;
      if (dBox) {
        for (var ddi = 0; ddi < 60; ddi++) {
          // 障碍始终保持在顾客正前方 1.0m（测的是绕行响应，不是「走过箱子」的时序）
          dBox.mesh.position.set(dc.mesh.position.x, 0.225, dc.mesh.position.z + 1.0);
          if (dBox.rb) { dBox.rb.position.set(dBox.mesh.position.x, 0.225, dBox.mesh.position.z); dBox.rb.wakeUp(); dBox.rb.velocity.set(0, 0, 0); }
          G.customers._test.stepAvoid(dc, 1 / 60);
        }
        dLat = Math.abs(dc.mesh.position.x - 6.0);
        dSum = Math.abs(dc.lane + dc.avoid);
      }
      ck('cust.dodgeLooseBox', dLat >= 0.30 && dSum <= 0.80,
        '正前方 1.0m 的 loose 箱：1s 后侧移 ' + round2(dLat) + 'm（应 ≥0.30），|lane+avoid| = ' +
        round2(dSum) + '（应 ≤0.80），avoid=' + round2(dc.avoid));
      if (dBox) G.world.destroyBox(dBox);

      var dNav0 = G.world.nav._nodes.length, dCol0 = G.world.colliders.length;
      var dPathA = G.world.nav.findPath(G.world.nav.entry, G.world.nav.aisleSpots[0]);
      var dBox2 = G.world.spawnBox('d_water', { x: 6.0, z: -6.5 });
      for (var dni = 0; dni < 30; dni++) G.customers._test.stepAvoid(dc, 1 / 60);
      var dPathB = G.world.nav.findPath(G.world.nav.entry, G.world.nav.aisleSpots[0]);
      var dSame = dPathA.length === dPathB.length;
      for (var dpi = 0; dpi < dPathA.length && dSame; dpi++) {
        if (dPathA[dpi].distanceTo(dPathB[dpi]) > 1e-9) dSame = false;
      }
      ck('cust.dodgeNoNavChange',
        G.world.colliders.length === dCol0 && G.world.nav._nodes.length === dNav0 && dSame,
        'collider ' + dCol0 + '→' + G.world.colliders.length + '，nav 节点 ' + dNav0 + '→' +
        G.world.nav._nodes.length + '，findPath 逐点相同=' + dSame);
      if (dBox2) G.world.destroyBox(dBox2);
      G.customers._test.remove(dc);

      /* 上面两条都摸不到 stepCustomer：dodgeLooseBox 走 _test.stepAvoid 隔离单元，
         dodgeNoNavChange 是否定式，ragdollFreezesGait 只能证明「若被调用则须被 ragdoll 挡住」
         ——把 stepCustomer 里的 stepAvoid 调用整行删掉，三条照样全绿。本条堵这个洞：
         箱钉在世界坐标固定点，全程只走 _test.stepOne（含 stepMove 的回拽），
         阈值取 0.20 是因为真实路径下 stepMove 会把峰值从 0.6 压到 0.36–0.46（1.8× 余量）。 */
      var ic = G.customers._test.spawnOne();
      ic.mesh.position.set(6.0, 0, -6.0);
      ic.mesh.rotation.y = 0;
      ic.lane = 0;
      ic.path = [new THREE.Vector3(6.0, 0, 0.0), new THREE.Vector3(6.0, 0, 6.0)];
      var iBox = G.world.spawnBox('f_noodle', { x: 6.0, z: -4.0 });
      var iPeak = 0;
      if (iBox) {
        for (var ifi = 0; ifi < 90; ifi++) {              // 1.5s
          G.customers._test.stepOne(ic, 1 / 60);
          var iOff = Math.abs(ic.mesh.position.x - 6.0);
          if (iOff > iPeak) iPeak = iOff;
        }
      }
      ck('cust.dodgeInStepCustomer', iPeak >= 0.20,
        '走 stepCustomer 每帧主循环（非 _test.stepAvoid 隔离单元）：固定箱 z=-4.0，' +
        '1.5s 内侧移峰值 ' + round2(iPeak) + 'm（应 ≥0.20）');
      if (iBox) G.world.destroyBox(iBox);
      G.customers._test.remove(ic);



      G.customers._test.remove(kc);
      G.customers._test.remove(sc2);
      G.customers._test.remove(hc);
      G.customers._test.remove(pc2);

      /* --- 收银员站桩美术（小任务）--- */
      function findCashierGroup() {
        var found = null, n = 0;
        scene.traverse(function (o) {
          if (o.isGroup && o.position.x === -2 && Math.abs(o.position.z - 8.55) < 0.2) { found = o; n++; }
        });
        return { group: found, n: n };
      }
      G.world.setCashierVisible(0, true);
      var cf = findCashierGroup();
      var cfMeshes = 0, cfShirtOk = false;
      if (cf.group) cf.group.traverse(function (o) {
        if (!o.isMesh) return;
        cfMeshes++;
        if (o.material && o.material.color && o.material.color.getHex() === 0x4C9BE8) cfShirtOk = true;
      });
      ck('world.cashierFigure', cf.n === 1 && cfMeshes === 9 && cfShirtOk,
        '站桩组 ' + cf.n + ' 个，mesh ' + cfMeshes + '（应 9），制服色命中 ' + cfShirtOk);
      var cfBox = null;
      var cfGeomOk = false;
      if (cf.group) {
        cf.group.updateMatrixWorld(true);
        cfBox = new THREE.Box3().setFromObject(cf.group);
        cfGeomOk = (Math.abs(cf.group.rotation.y) < 1e-6 || Math.abs(cf.group.rotation.y - Math.PI) < 1e-6) &&
          cfBox.min.z >= 8.2 && cfBox.max.z <= 9.0;
      }
      ck('world.cashierFits', cfGeomOk,
        cf.group ? ('旋转与包络须卡进 0.8m 员工通道：z[' + cfBox.min.z.toFixed(3) + ',' + cfBox.max.z.toFixed(3) + ']') : '无站桩组');
      G.world.setCashierVisible(0, true);
      ck('world.cashierIdempotent', findCashierGroup().n === 1, '重复 setVisible(true) 不得复制');
      G.world.setCashierVisible(0, false);
      ck('world.cashierRemoved', findCashierGroup().n === 0, 'setVisible(false) 应移除');

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

      /* D-T4 #23：对真实排队顾客做同一测试——交易状态机与经济一律不动 */
      var ncCust = null, ncRegs = G.checkout._test.registers();
      for (var nci = 0; nci < ncRegs.length && !ncCust; nci++) {
        var ncQ = ncRegs[nci].queue;
        if (ncQ && ncQ.length) ncCust = ncQ[0];
      }
      var ncOk = false, ncDetail = '队列里没有顾客，无法测';
      if (ncCust) {
        var ncPhase0 = G.checkout._test.tx(0) ? G.checkout._test.tx(0).phase : null;
        var ncMoney0 = G.state.money, ncXp0 = G.state.xp, ncCogs0 = G.state.dayStats.cogs;
        var ncPos0 = ncCust.mesh.position.clone();
        var ncBox = G.world.spawnBox('f_noodle', { x: ncCust.mesh.position.x, z: ncCust.mesh.position.z - 0.2 });
        if (ncBox) {
          ncBox.mesh.position.set(ncCust.mesh.position.x, 1.0, ncCust.mesh.position.z - 0.2);
          if (ncBox.rb) { ncBox.rb.position.set(ncBox.mesh.position.x, 1.0, ncBox.mesh.position.z); ncBox.rb.wakeUp(); ncBox.rb.velocity.set(0, 0, 5.0); }
        }
        G.customers._test.stepOne(ncCust, 0.05);
        var ncRag = ncCust.ragdoll === true;
        if (ncBox) G.world.destroyBox(ncBox);
        /* 58 而非 57：触发帧只置位不累计，ragdollT 从下一帧才起步，57 帧的 0.05 累加
           实测落在 2.849999999999998（浮点漂移），比 RAGDOLL_END 差 2e-15 而爬不起来。
           爬起判定不加 epsilon 迁就——真实 dt 可变，恰好压线是测度零事件；
           这里与 cust.knockdownRecovers 一样刻意跨过边界（2.90s）再验收。 */
        for (var ncj = 0; ncj < 58; ncj++) G.customers._test.stepOne(ncCust, 0.05);
        var ncPhase1 = G.checkout._test.tx(0) ? G.checkout._test.tx(0).phase : null;
        ncOk = ncRag && ncPhase1 === ncPhase0 &&
          G.state.money === ncMoney0 && G.state.xp === ncXp0 && G.state.dayStats.cogs === ncCogs0 &&
          ncCust.mesh.position.distanceTo(ncPos0) < 1e-6 && ncCust.ragdoll === false;
        ncDetail = '被砸=' + ncRag + '，爬起后 ragdoll=' + ncCust.ragdoll + '，tx.phase ' + ncPhase0 + '→' + ncPhase1 +
          '，money ' + ncMoney0 + '→' + G.state.money + '，xp ' + ncXp0 + '→' + G.state.xp +
          '，cogs ' + ncCogs0 + '→' + G.state.dayStats.cogs + '，位移 ' + ncCust.mesh.position.distanceTo(ncPos0);
      }
      ck('cust.knockdownNoConsequence', ncOk, ncDetail);

      /* --- 收银台站位系统（Task 7）--- */
      ck('player.poseApi',
        typeof G.player.getPose === 'function' && typeof G.player.setPose === 'function' && !!G.player.camera,
        '缺 getPose/setPose/camera');

      /* --- D-T3 蓄力投掷（spec §6）--- */
      var tc = G.player._test.throwConsts ? G.player._test.throwConsts() : null;
      var curveOk = !!tc, curveTrace = [];
      if (tc) {
        [0, 0.4, 0.8, 1.5].forEach(function (ct) {
          G.player._test.charge(ct);
          var got = G.player._test.peekThrow().speed;
          var k = Math.min(ct / tc.chargeFull, 1);
          var want = tc.vMin + (tc.vMax - tc.vMin) * k;
          curveTrace.push('t=' + ct + '→' + round2(got) + '/' + round2(want));
          if (Math.abs(got - want) > 1e-6) curveOk = false;
        });
        G.player._test.charge(0);
        /* 数值本身也要守：curveTrace 的 want 是拿 throwConsts() 自己的 vMin/vMax 算的，
           只测形状不测数值，vMax 改成 20 照绿。THROW_V_MAX 的硬上界 12.0（cannon 0.6.2 无 CCD）
           与 25% 余量后的 9.0 是 spec §6.3 的绑定数值，调高必须先重跑 physics.noTunneling。 */
        if (!(tc.vMax <= 9.0 && tc.chargeFull === 0.8)) curveOk = false;
        curveTrace.push('vMax=' + tc.vMax + '（须 ≤9.0）chargeFull=' + tc.chargeFull + '（须 0.8）');
      }
      ck('player.chargeCurve', curveOk, curveTrace.join(' ') || '缺 _test.throwConsts');

      var toBox = G.world.spawnBox('h_tissue', { x: 6.0, z: 4.0 });
      var toOk = false, toDetail = '无箱';
      if (toBox && G.player._test.pickUp(toBox)) {
        var camDir = new THREE.Vector3();
        G.player.camera.getWorldDirection(camDir);
        var want = G.player.camera.position.clone().addScaledVector(camDir, 0.6);
        want.y -= 0.35;
        G.player._test.charge(0.4);
        withRandom(0.5, function () { G.player._test.throwNow(); });
        /* CONTRACTS：registerBoxInteractable 必须在松手当帧完成、不等落地。漏掉这一条，
           箱会变成捡不起来的幽灵，而坐标 / 刚体 / carrying 那三项仍然全绿。 */
        var toReg = false;
        for (var ti = 0; ti < G.world.interactables.length; ti++) {
          var tie = G.world.interactables[ti];
          if (tie.type === 'box' && tie.data && tie.data.box === toBox) { toReg = true; break; }
        }
        toOk = toBox.mesh.position.distanceTo(want) < 1e-6 && !!toBox.rb &&
          toBox.rb.type === CANNON.Body.DYNAMIC && G.player.carrying === null && toReg;
        toDetail = '箱心 ' + round2(toBox.mesh.position.x) + ',' + round2(toBox.mesh.position.y) + ',' +
          round2(toBox.mesh.position.z) + ' / 期望 ' + round2(want.x) + ',' + round2(want.y) + ',' + round2(want.z) +
          '，距差 ' + toBox.mesh.position.distanceTo(want) + '，松手当帧已登记交互体=' + toReg;
      }
      ck('player.throwOrigin', toOk, '出手起点须与 syncCarriedBox 同式：' + toDetail);
      if (toBox) G.world.destroyBox(toBox);

      /* 出手点不得越过任何静态 collider 的中面：玩家最近只能站到距中面 0.55m（PLAYER_RADIUS 0.35
         + 半厚 0.2），而出手点前伸 0.6×cos(pitch)，|pitch| < 23.6° 时箱心生成在墙的另一侧，
         求解器按最小穿透轴把它推到墙外再加初速飞走 —— 最轻的 1.5 m/s 也照穿，能把箱送进未购区，
         或穿实心外墙扔到店外永久失联（仍占 BOX_HARD_CAP、按 where:'floor' 进存档跨天存活）。
         与蓄力大小、天花板、隧穿全都无关，本 task 之前的 17 条断言无一能捕获。 */
      var wcWall = null;
      for (var wi = 0; wi < G.world.colliders.length; wi++) {
        var wcc = G.world.colliders[wi];
        if (Math.abs((wcc.minZ + wcc.maxZ) / 2 + 10) < 1e-6 && wcc.maxX - wcc.minX > 30) { wcWall = wcc; break; }
      }
      var wcPose = G.player.getPose();
      var wcOk = !!wcWall, wcTrace = [];
      if (wcWall) {
        var wcMid = (wcWall.minZ + wcWall.maxZ) / 2;      // 南外墙中面 z = -10
        /* 贴到不能再近：z = -9.45。注意 collider 半厚是 0.2（总厚 0.4），而墙 mesh 用
           WALL_T=0.2 是总厚（半厚 0.1）—— 按墙面几何反推会算成 -9.55，差 0.1m。 */
        var wcStand = wcWall.maxZ + 0.35;
        [0, 0.8].forEach(function (wct) {
          var wb = G.world.spawnBox('h_tissue', { x: 0, z: -8 });
          if (!wb || !G.player._test.pickUp(wb)) {
            wcOk = false; wcTrace.push('t=' + wct + ' 无箱');
            if (wb) G.world.destroyBox(wb);
            return;
          }
          G.player.setPose({ x: (wcWall.minX + wcWall.maxX) / 2, z: wcStand, yaw: 0, pitch: 0 });   // 平视朝 -z
          G.player._test.charge(wct);
          var wcV = G.player._test.peekThrow().speed;
          G.player._test.throwNow();
          var wcOrigin = wb.rb.position.z, wcMin = wcOrigin, ws;
          for (ws = 0; ws < 120; ws++) {
            G.physics.update(1 / 60);
            if (wb.rb.position.z < wcMin) wcMin = wb.rb.position.z;
          }
          if (wcMin <= wcMid) wcOk = false;
          wcTrace.push('v0=' + round2(wcV) + ' 出手z=' + round2(wcOrigin) +
            ' 全程最小z=' + round2(wcMin) + ' 末z=' + round2(wb.rb.position.z));
          G.world.destroyBox(wb);
        });
      }
      G.player.setPose(wcPose);
      ck('player.throwNoWallClip', wcOk,
        wcWall ? ('站位 z=' + round2(wcStand) + ' 平视扔向中面 z=' + wcMid +
          ' 的南外墙，箱心须全程留在己侧（z > ' + wcMid + '）：' +
          wcTrace.join(' | ')) : '找不到南外墙 collider');

      /* 蓄力仲裁：准星指向任何类型都不影响蓄力；左键既有行为不受影响、可与右键同时生效；
         中途失效（全屏界面）取消蓄力且箱仍在手上 */
      var arbBox = G.world.spawnBox('f_noodle', { x: 6.0, z: 3.0 });
      var arbOk = !!arbBox, arbDetail = '';
      if (arbBox && G.player._test.pickUp(arbBox)) {
        var arbTypes = ['shelfSlot', 'computer', 'register', 'shutter', 'storage', 'trash', null];
        for (var ai = 0; ai < arbTypes.length; ai++) {
          var ent = null;
          if (arbTypes[ai]) {
            for (var aj = 0; aj < G.world.interactables.length; aj++) {
              if (G.world.interactables[aj].type === arbTypes[ai]) { ent = G.world.interactables[aj]; break; }
            }
          }
          G.player._test.charge(0);
          G.player._test.setHover(ent);
          G.player._test.setRmb(true);
          G.player._test.stepCharge(0.4);
          if (Math.abs(G.player._test.chargeState().charge - 0.5) > 1e-6) {
            arbOk = false; arbDetail = '准星指 ' + arbTypes[ai] + ' 时蓄力 ' + G.player._test.chargeState().charge;
            break;
          }
        }
        // 左键连续上架与右键蓄力同时生效
        var arbSlotEnt = null;
        for (var ak = 0; ak < G.world.interactables.length; ak++) {
          var ake = G.world.interactables[ak];
          if (ake.type === 'shelfSlot' && ake.data.slot.fridge === false &&
              (ake.data.slot.productId === null || ake.data.slot.productId === 'f_noodle') &&
              ake.data.slot.count < 4) { arbSlotEnt = ake; break; }
        }
        if (arbSlotEnt) {
          var arbCount0 = arbSlotEnt.data.slot.count, arbLeft0 = arbBox.itemsLeft;
          G.player._test.charge(0);
          G.player._test.resetStockCooldown();   // 前序断言可能刚上过架，冷却未走完会让本条空转
          G.player._test.setHover(arbSlotEnt);
          G.player._test.setRmb(true);
          G.player._test.setMouseDown(true);
          G.player._test.doInteractions();
          G.player._test.stepCharge(0.4);
          var arbStocked = arbSlotEnt.data.slot.count === arbCount0 + 1 && arbBox.itemsLeft === arbLeft0 - 1;
          var arbCharged = Math.abs(G.player._test.chargeState().charge - 0.5) < 1e-6;
          if (!arbStocked || !arbCharged) {
            arbOk = false;
            arbDetail = '左键上架=' + arbStocked + '（' + arbCount0 + '→' + arbSlotEnt.data.slot.count +
              '），同帧右键蓄力=' + G.player._test.chargeState().charge;
          }
          G.player._test.setMouseDown(false);
        } else {
          arbOk = false; arbDetail = '找不到可上架的空格位';
        }
        /* 中途失效：全屏界面（'screen' 事件 → update 的 blocked 早退分支）必须取消蓄力、箱仍在手上。
           `inRegister` 走的是同一个 blocked 判据（blocked = screenIsOpen || registerActive），
           无头下失去指针锁定走的是第二个早退分支，两处都调 cancelCharge。 */
        G.player._test.setRmb(true);
        G.player._test.charge(0.4);
        G.bus.emit('screen', { name: 'computer' });
        G.player.update(0.05);
        var arbCancelled = G.player._test.chargeState().charge === 0 && G.player.carrying === arbBox;
        G.bus.emit('screen', { name: null });
        if (!arbCancelled) { arbOk = false; arbDetail = (arbDetail ? arbDetail + '；' : '') + '全屏界面未取消蓄力'; }
        G.player._test.setRmb(false);
        G.player._test.charge(0);
      } else {
        arbOk = false; arbDetail = '拿不起测试箱';
      }
      ck('player.chargeArbitration', arbOk, arbDetail || '任意准星目标均可蓄力；左键上架与右键蓄力互不影响；中途失效取消蓄力');

      var barEl = document.getElementById('charge');
      var barOk = !!barEl && !!barEl.firstChild;
      var barDetail = barEl ? '' : '缺 #charge 节点';
      if (barOk) {
        // 前一条断言末尾的 _test.charge(0) 已把 #charge 置成 block：不先归零，
        // 「setCharge 让它显示」这一半就是空断言（只剩宽度在守）
        barEl.style.display = 'none';
        G.ui.setCharge(0.5);
        var barShown = barEl.style.display, barW = barEl.firstChild.style.width;
        var barVis = barShown !== 'none' && barW === '60px';
        G.ui.setCharge(null);
        var barHid = barEl.style.display === 'none';
        barOk = barVis && barHid;
        barDetail = 'charge=0.5 时 display=' + barShown + ' 宽 ' + barW +
          '（应 60px）；setCharge(null) 后 display=' + barEl.style.display;
      }
      ck('ui.chargeBar', barOk, barDetail);

      var cmEvt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      var cmSuppressed = (canvasEl.dispatchEvent(cmEvt) === false);
      ck('player.contextMenuSuppressed', cmSuppressed,
        'canvas 上的 contextmenu 必须 preventDefault（dispatchEvent 返回 ' + !cmSuppressed + '）');
      if (arbBox) { if (G.player.carrying === arbBox) G.player.carrying = null; G.world.destroyBox(arbBox); }

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

      // 站位必须在柜台背侧（z > 柜台南缘 8.2），而非顾客侧
      ck('checkout.stanceBehind', !!st && st.pos.z > 8.2,
        '站位 z = ' + (st && round2(st.pos.z)) + '，应 > 8.2（柜台南侧员工通道）');

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
      // Lv1：基础房租 40 + 仓库 20（C-T4 块把 zones.W 打开了）+ 4 组普通货架水电 8；
      // 无冷藏柜（0）、无 staffed 收银员（0）→ 68
      var expRent = 40 + 20 + 4 * 2;
      ck('summary.rent', Math.abs(s.rent - expRent) < 0.01, '固定支出 ' + s.rent + ' / 预期 ' + expRent);
      ck('summary.profit', Math.abs(s.profit - (s.revenue - s.cogs - s.rent)) < 0.01, JSON.stringify(s));
      ck('summary.rentCharged', Math.abs(rentCharged - expRent) < 0.01, '实扣 ' + round2(rentCharged));
      ck('summary.sane', s.revenue >= 0 && s.cogs >= 0 && s.customers >= 1 && s.itemsSold >= 1, JSON.stringify(s));

      /* C-T6：多区房租实算（spec §9）——B/C 的 30/40 此前只作为常量被读到，从未验过叠加路径 */
      var zB0 = G.state.zones.B, zC0 = G.state.zones.C;
      G.state.zones.B = true; G.state.zones.C = true;
      var scaledRent = computeRent();
      G.state.zones.B = zB0; G.state.zones.C = zC0;
      var expScaled = 40 + 20 + 30 + 40 + 4 * 2 + staffedWage();   // 基础 + W/B/C + 4 组普通货架水电 + 工资
      ck('summary.rentScaled', Math.abs(scaledRent - expScaled) < 0.01 && G.state.zones.B === zB0,
        '三区全开房租 ' + scaledRent + ' / 预期 ' + expScaled + '（zones 已还原 B=' + G.state.zones.B + '）');

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

      /* --- C-T6 存档 v2 --- */
      ck('save.v2Key', !!localStorage.getItem('gss-save-v2'), 'nextDay 后应存在 v2 键');
      var v2raw = JSON.parse(localStorage.getItem('gss-save-v2') || '{}');
      ck('save.v2Shape', v2raw.v === 2 && v2raw.zones && Array.isArray(v2raw.registers) && Array.isArray(v2raw.shelves),
        'v2 结构字段');
      // v1 迁移：构造最小 v1 档 → 清 v2 → load → 折现与继承
      var fakeV1 = { money: 500, day: 3, xp: 200, level: 3, prices: G.state.prices,
        licenses: ['食品', '饮料'], cashier: true, negDays: 1,
        shelves: [{ id: 'shelf0_0_0', productId: 'f_noodle', count: 5 }] };
      localStorage.setItem('gss-save-v1', JSON.stringify(fakeV1));
      localStorage.removeItem('gss-save-v2');
      var migOk = G.load();
      var refund = 5 * 1.20;   // 5 × f_noodle.cost
      ck('save.migrateV1', migOk === true && G.state.day === 3 && G.state.level === 3 &&
        Math.abs(G.state.money - (500 + refund)) < 0.01 &&
        G.state.registers[0].staffed === true && G.state.zones.B === false &&
        !!localStorage.getItem('gss-save-v1'),
        '迁移：money=' + G.state.money + '（期 ' + (500 + refund) + '），v1 键保留');
      // spec §7「首次 save 写 v2」：v1 玩家若在首日日结前退出，不得下次启动再迁移一遍
      var v2AfterMig = localStorage.getItem('gss-save-v2');
      ck('save.migratePersist', !!v2AfterMig && JSON.parse(v2AfterMig).v === 2 && JSON.parse(v2AfterMig).day === 3,
        '迁移后应立即落盘 v2：' + (v2AfterMig ? JSON.parse(v2AfterMig).v + '/day' + JSON.parse(v2AfterMig).day : 'null'));
      // 损坏的 v2 不得吞掉 v1（否则静默开新档 → 日结覆写，v1 也失去意义）
      localStorage.setItem('gss-save-v2', '{"v":2,');
      localStorage.setItem('gss-save-v1', JSON.stringify(fakeV1));
      var fallbackOk = G.load() === true && G.state.day === 3 && G.state.level === 3;
      localStorage.setItem('gss-save-v2', '{"v":2,');
      localStorage.removeItem('gss-save-v1');
      var noneOk = G.load() === false;
      ck('save.corruptFallback', fallbackOk && noneOk,
        '坏 v2 + 好 v1 → 回落迁移 ' + fallbackOk + '；坏 v2 且无 v1 → 返回 false ' + noneOk);
      ck('save.roundtripZones', (function () {
        G.state.zones.W = true; G.save();
        var rr = JSON.parse(localStorage.getItem('gss-save-v2'));
        return rr.zones.W === true;
      })(), 'zones 入档往返');

      /* --- C-final：已付款库存必须入档（GDD §3「已付的钱不退、箱子不消失」）---
         此前 v2 只序列化 storageSlots，卸货区/店内地面/手上的箱与已扣款的在途订单
         刷新即永久丢失。三类箱各一只 + 一笔在途订单走真往返 */
      function boxCensus() {
        var out = { storage: [], yard: [], floor: [] };
        var list = G.world.allBoxes();
        for (var bi = 0; bi < list.length; bi++) {
          var b = list[bi], onSt = null;
          for (var sj = 0; sj < G.world.storageSlots.length; sj++) {
            if (G.world.storageSlots[sj].box === b) { onSt = G.world.storageSlots[sj]; break; }
          }
          if (onSt) out.storage.push(b);
          else if (G.world.isOnYard(b.mesh)) out.yard.push(b);
          else out.floor.push(b);
        }
        return out;
      }
      var bxSlot = G.world.storageSlots[5];
      var bxStore = G.world.spawnBox('f_noodle', bxSlot.pos);
      if (bxStore) { bxStore.itemsLeft = 9; G.world.storeBox(bxSlot, bxStore); }
      var bxYard = G.world.spawnBox('d_water');            // 无参 = 卸货区空位
      if (bxYard) { bxYard.itemsLeft = 5; G.world.updateBoxVisual(bxYard); }
      var bxFloor = G.world.spawnBox('h_tissue', { x: 6.5, z: 2.4 });   // 店内地面（按 Q 放下的那类）
      if (bxFloor) { bxFloor.itemsLeft = 3; G.world.updateBoxVisual(bxFloor); }
      var bxOrdered = G.shop.orderBoxes([{ pid: 'f_noodle', qty: 1 }]);   // 已扣款、在途
      var bxBefore = boxCensus(), dqBefore = G.shop.serializeDeliveries();
      G.save();
      var bxLoaded = G.load();
      var bxAfter = boxCensus(), dqAfter = G.shop.serializeDeliveries();
      var bxCounts = bxAfter.storage.length === 1 && bxAfter.yard.length === 1 && bxAfter.floor.length === 1;
      var bxOk = bxLoaded === true && bxOrdered === true && bxCounts &&
        bxAfter.storage[0].productId === 'f_noodle' && bxAfter.storage[0].itemsLeft === 9 &&
        bxSlot.box === bxAfter.storage[0] &&
        bxAfter.yard[0].productId === 'd_water' && bxAfter.yard[0].itemsLeft === 5 &&
        bxAfter.floor[0].productId === 'h_tissue' && bxAfter.floor[0].itemsLeft === 3 &&
        Math.abs(bxAfter.floor[0].mesh.position.x - 6.5) < 0.01 &&
        bxAfter.storage[0] !== bxBefore.storage[0] &&   // 真重建，不是原对象留在场上
        dqBefore.length === 1 && dqAfter.length === 1 && dqAfter[0].pid === 'f_noodle' &&
        Math.abs(dqAfter[0].remaining - dqBefore[0].remaining) < 0.01;
      ck('save.boxesRoundtrip', bxOk,
        '仓库/卸货/地面各 1 箱 + 在途 1 单往返：存 ' +
        JSON.stringify({ st: bxBefore.storage.length, yard: bxBefore.yard.length, floor: bxBefore.floor.length, dq: dqBefore.length }) +
        ' → 读 ' + JSON.stringify({ st: bxAfter.storage.length, yard: bxAfter.yard.length, floor: bxAfter.floor.length, dq: dqAfter.length }) +
        '，left ' + JSON.stringify(bxAfter.storage.concat(bxAfter.yard, bxAfter.floor).map(function (b) { return b.productId + ':' + b.itemsLeft; })));

      G.load(); G.load();   // 重复读档不得叠箱（restoreBoxes 起手清场）
      var bxDup = boxCensus(), dqDup = G.shop.serializeDeliveries();
      ck('save.boxesNoDup',
        bxDup.storage.length === 1 && bxDup.yard.length === 1 && bxDup.floor.length === 1 &&
        G.world.allBoxes().length === 3 && dqDup.length === 1,
        '连读 3 次后场上箱 ' + G.world.allBoxes().length + ' 只（应 3）' +
        JSON.stringify({ st: bxDup.storage.length, yard: bxDup.yard.length, floor: bxDup.floor.length }) +
        '，在途 ' + dqDup.length + ' 单');

      var orphanLoose = G.physics.looseBoxes().length;
      var orphanNonHeld = 0, orphanList = G.world.allBoxes();
      for (var obi = 0; obi < orphanList.length; obi++) {
        if (G.player.carrying !== orphanList[obi]) orphanNonHeld++;
      }
      ck('physics.noOrphanBodies',
        G.physics._test.bodyCount() === G.physics._test.staticCount() + orphanNonHeld,
        '连读 3 次后 body 总数 ' + G.physics._test.bodyCount() + ' = 静态 ' +
        G.physics._test.staticCount() + ' + 非 held 箱 ' + orphanNonHeld + '；其中 loose ' + orphanLoose);

      /* --- C-T7 治漏与上限 --- */
      for (var pi2 = 0; pi2 < 200; pi2++) G.shop.setPrice('f_noodle', 2.0 + (pi2 % 30) * 0.1);
      var ts = G.world._tagStats();
      var texCountAfter = 0, tk;
      for (tk in ts.cache) texCountAfter++;
      // 上界 = 'empty|-' 1 条 + 24 个 pid 的 stocked/out 各一条 = 49，与价格无关
      ck('world.tagTexNoLeak', texCountAfter <= 49 && ts.disposed > 0,
        '改价 200 次后缓存 ' + texCountAfter + '（≤49），disposed=' + ts.disposed);
      G.shop.setPrice('f_noodle', 2.2);
      var capC = G.customers._test.spawnOne();
      for (var hc = 0; hc < 12; hc++) {
        capC.items.push({ pid: 'f_noodle', price: 2.2 });
        G.customers._test.addHand(capC, 'f_noodle');
      }
      var handMeshes = capC.hands.children.length;
      ck('cust.handVisualCap', handMeshes === 6, '12 件手持只渲染 ' + handMeshes + '（应 6）');
      /* 清单上限 6 条 ×2 件 = 12 件，逻辑 items 会超过渲染封顶 6：popItem 必须守住
         hands.length === min(items.length, 6)，否则玩家会看到「空手还在往传送带放货」 */
      var popOk = true, popTrace = [];
      while (capC.items.length) {
        capC.popItem();
        popTrace.push(capC.items.length + '/' + capC.hands.children.length);
        if (capC.hands.children.length !== Math.min(capC.items.length, 6)) popOk = false;
      }
      ck('cust.handPopInvariant', popOk && capC.hands.children.length === 0,
        'items/hands 逐步轨迹 ' + popTrace.join(' '));
      G.customers._test.remove(capC);

      /* C-T7 修复轮：v1 迁移档的 shelves 恒为 null（state.js migrateV1），restoreShelves 整个不被调用，
         而 prices 已被 sanePrices 换过——价签必须全量重刷，否则格位仍指着 _price 为旧价的共享贴图，
         之后任意一次单格 addItem 都会把这张还在被引用的共享贴图 dispose 掉 */
      var staleSlot = G.world.findSlotWithProduct('f_noodle');
      localStorage.setItem('gss-save-v1', JSON.stringify({
        money: 500, day: 3, xp: 200, level: 3, prices: { f_noodle: 4.5 },
        licenses: ['食品', '饮料'], cashier: true, negDays: 0
      }));
      localStorage.removeItem('gss-save-v2');
      var staleLoaded = G.load() === true;
      var staleMap = staleSlot ? staleSlot.tagMesh.material.map : null;
      ck('save.tagRefreshWithoutShelves', staleLoaded && !!staleMap && staleMap._price === 4.5,
        '无 shelves 的档读档后，已有货格位的价签 _price=' + (staleMap ? staleMap._price : 'n/a') + '（应 4.5）');

      /* --- 性能总闸门（B-T7）：会脏化 state，必须放在存档往返之后 --- */
      function countDrawables(node) {
        if (node.visible === false) return 0;
        var n = (node.isMesh || node.isInstancedMesh) ? 1 : 0;
        for (var i = 0; i < node.children.length; i++) n += countDrawables(node.children[i]);
        return n;
      }
      /* 闸门场景起手清场：不在仓库位/卸货位上的散落箱是前序断言的残留，与被测负载无关，
         每只 2 drawable——留着会让将来增删断言时 drawable 无关漂移 */
      var strayCleared = 0;
      var strayList = G.world.allBoxes();
      for (var sbx = 0; sbx < strayList.length; sbx++) {
        var sBox = strayList[sbx], onSt = false;
        for (var ssj = 0; ssj < G.world.storageSlots.length; ssj++) {
          if (G.world.storageSlots[ssj].box === sBox) { onSt = true; break; }
        }
        if (onSt || G.world.isOnYard(sBox.mesh)) continue;
        G.world.destroyBox(sBox);
        strayCleared++;
      }

      G.state.level = 10;
      G.state.licenses = ['食品', '饮料', '日用品', '生鲜'];
      G.world.buildZone('B');
      G.world.buildZone('C');
      G.world.buildZone('W');
      G.world.syncLayout();

      ck('physics.staticsAfterZoneOpen',
        !!G.physics && G.physics._test.staticCount() === G.world.colliders.length + 2,
        '全开后静态体 ' + (G.physics ? G.physics._test.staticCount() : -1) +
        ' / collider ' + G.world.colliders.length + ' + 2 plane（buildZone 后必须已 syncStatics）');

      /* C-T2 修复轮：全开态关键点连通性（区域孤岛与死节点的回归防线） */
      var navAllOk = true, navBad = '';
      var navProbe = [G.world.nav.entry, G.world.nav.exit];
      for (var np = 0; np < G.world.nav.aisleSpots.length; np++) navProbe.push(G.world.nav.aisleSpots[np]);
      for (var nr = 0; nr < G.world.nav.registers.length; nr++) {
        navProbe.push(G.world.nav.registers[nr].front);
        navProbe.push(G.world.nav.registers[nr].queueSpots[0]);
      }
      for (var na = 1; na < navProbe.length && navAllOk; na++) {
        var pp2 = G.world.nav.findPath(navProbe[0], navProbe[na]);
        if (!pp2 || !pp2.length) { navAllOk = false; navBad = 'entry→#' + na + ' 不可达'; }
      }
      ck('nav.fullOpenConnected', navAllOk, navBad || '全开态 entry→全部关键点可寻路');

      /* C-final：零边节点是纯负担 + 假象——看着有节点，实际只能靠 nearestNode 降级走直线。
         节点坐标与 collider 的余量只有 0.05-0.15m 量级，静默退化必须有断言兜住 */
      var deadNodes = [];
      var navList = G.world.nav._nodes || [];
      for (var dn = 0; dn < navList.length; dn++) {
        if (navList[dn].enabled && navList[dn].edges.length === 0) {
          deadNodes.push('(' + round2(navList[dn].p.x) + ',' + round2(navList[dn].p.z) + ')');
        }
      }
      ck('nav.noDeadNodes', deadNodes.length === 0,
        '全开态 ' + navList.length + ' 个节点全部有出边；零边节点 ' + deadNodes.join(' '));

      /* C-T3：卷帘门开区后 mesh 只是 visible=false，交互体必须摘除，否则隐形门截胡门洞射线 */
      var shuttersLeft = G.world.interactables.filter(function (it) { return it.type === 'shutter'; }).length;
      ck('shop.shutterRetired', shuttersAtBoot === 3 && shuttersLeft === 0,
        '开局 shutter 交互体 ' + shuttersAtBoot + ' 个（应 3），B/C/W 全开后剩 ' + shuttersLeft + '（应 0）');

      /* C-T3：B/C 开区后 R2/R3 必须已建造并被 checkout 接管 */
      ck('checkout.threeRegisters',
        G.world.registers.length === 3 && G.checkout._test.registers().length === 3 &&
        G.state.registers[1].owned === true && G.state.registers[2].owned === true,
        '世界台 ' + G.world.registers.length + ' / checkout 台 ' + G.checkout._test.registers().length);

      /* C-final：以下四条 spec §9 明列，T3 写断言时脚本里只有一台，全是跨 task 盲区 */

      ck('world.rackTable', G.world.slots.length === 120 && G.world.nav.aisleSpots.length === 20,
        '全开态货架格位 ' + G.world.slots.length + '（16 组货架 + 4 台冷藏 = 20 组 × 6 格 = 120），走廊服务点 ' +
        G.world.nav.aisleSpots.length + '（应 20）');

      /* 传送带坐标系必须逐台缓存（spec 钉死债务 #1）：只验 frame(0) 的话，
         退回 B 期的 beltFrame 单例缓存照样绿 */
      var frames = [G.checkout._test.frame(0), G.checkout._test.frame(1), G.checkout._test.frame(2)];
      var frOk = !!frames[0] && !!frames[1] && !!frames[2] &&
        frames[0].origin.x !== frames[1].origin.x &&
        frames[1].origin.x !== frames[2].origin.x &&
        frames[0].origin.x !== frames[2].origin.x;
      var frDetail = [];
      for (var fri = 0; fri < 3; fri++) {
        var frI = frames[fri], frFront = G.world.registers[fri].front;
        if (!frI) { frOk = false; frDetail.push('#' + fri + ' 无 frame'); continue; }
        if (Math.abs(frI.origin.x - frFront.x) > 1.2 || Math.abs(frI.origin.z - 7.6) > 1.2) frOk = false;
        frDetail.push('#' + fri + ' origin.x=' + round2(frI.origin.x) + ' / front.x=' + frFront.x);
      }
      ck('checkout.perRegisterFrame', frOk,
        '三台 frame.origin 必须互异且各自落在自家柜台：' + frDetail.join('，'));

      /* CONTRACTS：joinQueue 在已建台中选 queue.length 最小者，并列取低 index。
         此前只验了「函数存在」，最短队语义零覆盖 */
      function fakeQueuer() {
        return {
          state: 'queueing', removed: false, queueTarget: null,
          moveTo: function (t) { this.queueTarget = t; },
          atDestination: function () { return false; }
        };
      }
      function regIndexOf(c) {
        var rl = G.checkout._test.registers();
        for (var i = 0; i < rl.length; i++) if (rl[i].queue.indexOf(c) !== -1) return i;
        return -1;
      }
      var sqTrace = [], sqCust = [];
      for (var sqi = 0; sqi < 8; sqi++) {
        var sqC = fakeQueuer();
        if (!G.checkout.joinQueue(sqC)) { sqTrace.push('拒'); continue; }
        sqCust.push(sqC);
        sqTrace.push(regIndexOf(sqC));
      }
      var sqOk = sqTrace.join(',') === '0,1,2,0,1,2,0,1';
      for (var sqj = 0; sqj < sqCust.length; sqj++) sqCust[sqj].removed = true;
      G.checkout.update(0.05);   // prune 清走假顾客
      var sqLeft = 0;
      for (var sqk = 0; sqk < G.checkout._test.registers().length; sqk++) sqLeft += G.checkout._test.registers()[sqk].queue.length;
      ck('checkout.shortestQueue', sqOk && sqLeft === 0,
        '连续 8 人入队的落台轨迹 [' + sqTrace.join(',') + ']（应 0,1,2,0,1,2,0,1：并列取低 index），清理后残留 ' + sqLeft);

      /* 同一时刻只能占一台（spec §9）：占着 R1 时 enter(R2) 必须被拒并提示 */
      var toastOrig = G.ui.toast, toastSeen = [];
      var mutexOk = false, mutexDetail = '';
      try {
        G.ui.toast = function (m) { toastSeen.push(String(m)); return toastOrig.apply(G.ui, arguments); };
        G.checkout.enterRegister(G.world.registers[0]);
        var mutexId1 = G.checkout.activeRegisterId;
        G.checkout.enterRegister(G.world.registers[1]);
        var mutexId2 = G.checkout.activeRegisterId;
        var mutexToast = false;
        for (var mti = 0; mti < toastSeen.length; mti++) {
          if (toastSeen[mti].indexOf('先退出当前收银台') !== -1) mutexToast = true;
        }
        mutexOk = mutexId1 === 0 && mutexId2 === 0 && mutexToast;
        mutexDetail = 'enter(R1) 后 activeRegisterId=' + mutexId1 + '，再 enter(R2) 后 ' + mutexId2 +
          '（应仍 0），提示 ' + JSON.stringify(toastSeen);
      } finally {
        G.ui.toast = toastOrig;
      }
      G.checkout.exitRegister();
      for (var mtj = 0; mtj < 20; mtj++) G.checkout.update(0.05);   // 回程过渡 300ms 走完才放开 inRegister
      ck('checkout.enterAnyMutex', mutexOk && G.checkout.activeRegisterId === null && G.checkout.inRegister === false,
        mutexDetail + '；退出后 activeRegisterId=' + G.checkout.activeRegisterId);

      /* 雇员台与玩家台同帧各自推进 tx（spec §9）：R2 雇人、玩家占 R1 */
      function fakePayer(n) {
        var pitems = [];
        for (var pi3 = 0; pi3 < n; pi3++) pitems.push({ pid: 'f_noodle', price: 2.2 });
        return {
          state: 'queueing', removed: false, queued: true, queueTarget: null, _items: pitems,
          moveTo: function (t) { this.queueTarget = t; },
          atDestination: function () { return true; },
          popItem: function () { return this._items.length ? this._items.pop() : null; },
          leaveStore: function () { this.state = 'leaving'; }
        };
      }
      var staffedSnap = G.state.registers[1].staffed;
      G.state.registers[1].staffed = true;
      G.checkout.enterRegister(G.world.registers[0]);
      var pcA = fakePayer(2), pcB = fakePayer(2);
      G.checkout.joinQueue(pcA);   // 队列全空 → 取低 index → R1（玩家台）
      G.checkout.joinQueue(pcB);   // → R2（雇员台）
      for (var pti2 = 0; pti2 < 12; pti2++) G.checkout.update(0.05);
      var txA = G.checkout._test.tx(0), txB = G.checkout._test.tx(1);
      var ptBoth = !!txA && !!txB && txA !== txB && txA.c === pcA && txB.c === pcB &&
        txA.items.length === 2 && txB.items.length === 2;
      var ptItemsA = txA ? txA.items.length : 'n/a', ptItemsB = txB ? txB.items.length : 'n/a';
      /* 雇员台 6 秒后自动成交；玩家台不自动，tx 必须原地不动 */
      for (var ptj = 0; ptj < 160; ptj++) G.checkout.update(0.05);
      var ptAuto = G.checkout._test.tx(1) === null && G.checkout._test.tx(0) === txA;
      ck('checkout.parallelTx', ptBoth && ptAuto,
        '同帧 0.6s 后：R1(玩家) 传送带 ' + ptItemsA + ' 件 / R2(雇员) ' + ptItemsB +
        ' 件；再 8 秒后 R2 自动成交=' + (G.checkout._test.tx(1) === null) +
        '，R1 仍在玩家手上=' + (G.checkout._test.tx(0) === txA));
      pcA.removed = true; pcB.removed = true;
      G.checkout.exitRegister();
      for (var ptk = 0; ptk < 20; ptk++) G.checkout.update(0.05);
      G.state.registers[1].staffed = staffedSnap;

      G.world.setCashierVisible(0, true);
      G.world.setCashierVisible(1, true);
      G.world.setCashierVisible(2, true);
      /* 轮转灌店：外层轮次、内层商品 → 逼出 ≤24 组实例池上限（顺序灌店只会建 2 组） */
      var fillGuard = 0, filled = true;
      while (filled && fillGuard < 20000) {
        filled = false;
        for (var fpi = 0; fpi < G.data.PRODUCTS.length; fpi++) {
          var fpid = G.data.PRODUCTS[fpi].id;
          var fSlot = G.world.findEmptyOrMatchingSlot(fpid);
          if (fSlot && G.world.addItem(fSlot, fpid)) { filled = true; fillGuard++; }
        }
      }
      /* 绝对最坏负载：仓库 24 位 + 卸货区 12 位全占 + 20 客 ×12 件手持（渲染封顶 6）。
         仓库位必须显式给落点——spawnBox 无参只认卸货区 12 位，前序断言已占掉一部分 */
      var stFilled = 0;
      for (var sbi = 0; sbi < G.world.storageSlots.length; sbi++) {
        var stS = G.world.storageSlots[sbi];
        if (!stS.box) {
          var sb = G.world.spawnBox(G.data.PRODUCTS[sbi % G.data.PRODUCTS.length].id, stS.pos);
          if (sb) stS.box = sb;
        }
        if (stS.box) stFilled++;
      }
      for (var pbi = 0; pbi < 12; pbi++) G.world.spawnBox(G.data.PRODUCTS[pbi % G.data.PRODUCTS.length].id);
      var yardTotal = 0;
      for (var yti = 0; yti < G.world.interactables.length; yti++) {
        var ytIt = G.world.interactables[yti];
        if (ytIt.type === 'box' && G.world.isOnYard(ytIt.mesh)) yardTotal++;
      }
      var handRendered = 0;
      for (var ci = 0; ci < 20; ci++) {
        var pc = G.customers._test.spawnOne();
        for (var hi = 0; hi < 12; hi++) G.customers._test.addHand(pc, G.data.PRODUCTS[hi % G.data.PRODUCTS.length].id);
        handRendered = pc.hands.children.length;
      }
      var slotsStocked = 0;
      for (var sfi = 0; sfi < G.world.slots.length; sfi++) if (G.world.slots[sfi].count > 0) slotsStocked++;
      var drawN = countDrawables(scene);
      /* 口径 = 主 pass 可见对象数（自身与全部祖先 visible !== false 的 Mesh/InstancedMesh），
         不含阴影 pass 的深度提交，也不等于 renderer 的真实 draw call 总数——
         总提交另由 perf.renderCalls 守（DESIGN §5.8） */
      ck('perf.mainPassDrawables', drawN < 760,
        '满配主 pass 可见对象 ' + drawN + '，天花板 760（不含阴影 pass 提交）｜货架 ' +
        slotsStocked + '/' + G.world.slots.length +
        ' 格有货、收银 3 台、仓库 ' + stFilled + ' 箱、卸货区 ' + yardTotal + ' 箱、起手清掉散落箱 ' +
        strayCleared + ' 只、测试顾客 20 名 + 在场 ' +
        G.customers.active.length + ' 名（每客塞 12 件手持，实渲染 ' + handRendered + '）');

      /* C-final：场上箱实体总数硬上限（GDD §3 的 48）。地面囤箱脱离 12 位判据且跨天不清，
         是闸门唯一的无界项——本条钉死 spawnBox 起手的总数校验。现场：仓库 24 + 卸货 12 */
      var capBoxes = [], capBefore = G.world.allBoxes().length;
      for (var cbi = 0; cbi < 20; cbi++) {
        var cb = G.world.spawnBox('f_noodle', { x: 6 + (cbi % 5) * 0.6, z: -2.6 - Math.floor(cbi / 5) * 0.6 });
        if (!cb) break;
        capBoxes.push(cb);
      }
      var capTotal = G.world.allBoxes().length;
      var capRejected = G.world.spawnBox('f_noodle', { x: 8, z: 2 });
      ck('world.boxHardCap', capBefore === 36 && capTotal === 48 && capRejected === null,
        '仓库 24 + 卸货 12 = ' + capBefore + ' 只，地面再塞 ' + capBoxes.length +
        ' 只到总数 ' + capTotal + '（上限 48）后 spawnBox 必须返回 null，实返回 ' +
        (capRejected === null ? 'null' : '箱'));
      for (var cbj = 0; cbj < capBoxes.length; cbj++) G.world.destroyBox(capBoxes[cbj]);

      /* --- 渲染（无头环境可能没有 WebGL）--- */
      if (renderer) {
        /* 真实提交数必须在「全场入镜」的机位下取：视锥剔除会让贴脸看墙的机位只提交
           一两百次，测出来的数字不代表负载。自测到此结束，机位不必还原 */
        camera.position.set(0, 34, 34);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        /* r128 的 render() 在 shadowMap.render() 之后才 info.reset()，默认 autoReset 下
           读到的 calls 只含主 pass。关掉 autoReset 自己 reset，才拿得到含阴影 pass 的总提交 */
        renderer.info.autoReset = false;
        renderer.info.reset();
        render();
        ck('render', true, 'WebGL 渲染成功');
        /* 真实提交数（主 pass + 阴影 pass）：countDrawables 只数主 pass 可见对象，
           DESIGN §5.8 的总提交口径必须自己有断言，否则无人守 */
        var rCalls = renderer.info.render.calls;
        renderer.info.autoReset = true;
        ck('perf.renderCalls', rCalls < RENDER_CALL_CEILING,
          '满配一帧真实 draw call ' + rCalls + '（主 pass + 阴影 pass），天花板 ' + RENDER_CALL_CEILING);
      } else {
        ck('render', true, '无 WebGL（' + rendererNote + '）：已跳过渲染，游戏逻辑在无渲染下完整运行');
        ck('perf.renderCalls', true, '无 WebGL：无法读 renderer.info.render.calls，跳过');
      }
    } catch (e) {
      runtimeErrors.push(String(e && e.stack || e));
      ck('selftest.exception', false, String(e && e.message || e));
    } finally {
      restoreSaveKeys();
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
