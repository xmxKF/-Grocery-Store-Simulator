// js/physics.js — cannon.js 刚体世界：静态体从 colliders 自动生成、纸箱刚体、每帧写回 mesh
// 归属：physics agent。只通过 CONTRACTS.md 中定义的 API 与其它模块通信。
//
// 【本文件不得出现 interpolatedQuaternion】：cannon 0.6.2 对醒着的动态体根本不写入该字段
// （只有 STATIC/SLEEPING 分支才 copy），失效是静默的——静止时看着完全正常、一扔就不转。
// 位置写回用 body.interpolatedPosition，旋转写回用 body.quaternion。
// 自测断言 physics.noInterpolatedQuaternion 扫描 _test.src()，而 src() 返回下面这个具名
// 函数表达式 physicsModule 的 toString()。
// 【扫描面】= 该 IIFE 的函数体全文——常量区、模块顶层代码、全部具名/匿名函数与它们
//   函数体内的注释都在内，新增函数无需登记任何名单。
// 【盲区】= IIFE 之外的一切，即本段文件头注释 + `})();` 之后的文件尾（任何加在 IIFE
//   之外的顶层代码或第二个 IIFE 都不被扫描）。本文件的全部逻辑必须写在这一个 IIFE 里，
//   被禁字段名也只能出现在这段头注释里。
(function physicsModule() {
  'use strict';

  var G = (window.G = window.G || {});

  /* ---- 数值（spec §5.1）：改这里必须同步回写 spec §6.3 数值表 ---- */
  var BOX_MASS = 1.2;
  var BOX_HALF = 0.225;          // mesh 是 BoxGeometry(0.45³)、落位 y=0.225，几何与物理零偏移
  var BOX_LIN_DAMP = 0.02;
  var BOX_ANG_DAMP = 0.15;       // 偏大：落地后很快停转，不会像陀螺一样转半天
  var BOX_FRICTION = 0.35;
  var BOX_RESTITUTION = 0.15;    // 纸箱：落地就停，几乎不弹
  var SLEEP_SPEED = 0.15;
  var SLEEP_TIME = 0.6;

  /* 天花板高度 = WALL_H(3.6) − 0.20。不得擅自调整——它同时被两条独立的约束钉住：
     1) 阴影视锥不用改（spec §9.2）：求解器允许的穿透 + 箱以角朝上撞击会让 aabb 顶比
        plane 高出约 0.17m，plane 放 3.55 时实测 aabb 顶冲到 3.7041 > WALL_H；3.40 实测 3.5115。
     2) 翻不过关着的卷帘门：门洞处墙体是断开的，关闭的卷帘门静态体只到 h=3.0，其上到
        WALL_H 的空当只由天花板 plane 压住。空当 ≥ 箱边长 0.45 就能隔着关门往未购区域
        扔箱，即 CEIL_Y ≥ 3.45 就开洞。
     (1) 与 (2) 在当前 WALL_H=3.6 下恰好同阈值（CEIL_Y=3.45 实测 v0=9.0 → 3.5682 尚绿、
     v0=12.0 → 3.6245 > 3.6 已红），但这是巧合：两者量的不是一回事，WALL_H 一抬 (1) 立刻
     放宽而 (2) 纹丝不动（WALL_H=4.0 时 (1) 可放行到 CEIL_Y=3.83（实测 3.9714 ✓，3.84 →
     4.0105 ✗），门顶空当已达 0.83 ≫ 0.45，exploit 大开）。
     断言 physics.ceilingSealsZoneGates 专守 (2)，不可靠 ceilingCaps 代劳。 */
  var CEIL_Y = 3.40;

  var FIXED_STEP = 1 / 60;
  var MAX_SUB_STEPS = 10;        // 主循环 dt 已钳到 0.1s，最坏 6 个子步，永不触发截断

  var world = null;
  var boxMat = null, staticMat = null;
  var staticBodies = [];         // 由 colliders 生成的静态体（不含 2 个 plane）
  var planeCount = 0;
  var looseScratch = [];         // looseBoxes() 复用的数组，零分配；调用方不得跨帧持有

  /* 世界的唯一建造式：init() 与 _test 的两个离线探针共用，保证探针测的就是真实配置 */
  function buildWorld() {
    var w = new CANNON.World();
    w.gravity.set(0, -9.82, 0);
    w.broadphase = new CANNON.NaiveBroadphase();
    w.solver.iterations = 10;
    w.allowSleep = true;

    var sm = new CANNON.Material('gssStatic');
    var bm = new CANNON.Material('gssBox');
    w.addContactMaterial(new CANNON.ContactMaterial(bm, sm,
      { friction: BOX_FRICTION, restitution: BOX_RESTITUTION }));
    w.addContactMaterial(new CANNON.ContactMaterial(bm, bm,
      { friction: BOX_FRICTION, restitution: BOX_RESTITUTION }));

    var ground = new CANNON.Body({ mass: 0, material: sm });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    w.addBody(ground);

    var ceil = new CANNON.Body({ mass: 0, material: sm });
    ceil.addShape(new CANNON.Plane());
    ceil.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
    ceil.position.set(0, CEIL_Y, 0);
    w.addBody(ceil);

    return { world: w, staticMat: sm, boxMat: bm, planes: 2 };
  }

  function init() {
    if (world || typeof CANNON === 'undefined') return;
    var W = buildWorld();
    world = W.world;
    staticMat = W.staticMat;
    boxMat = W.boxMat;
    planeCount = W.planes;
  }

  /* 【唯一真相源】一条 collider 的竖直高度（占 y ∈ 0..h）。省略 h 视为 WALL_H，
     必须在调用时现取、不能在模块顶层缓存成字面量：physics.js 先于 world.js 加载
     （顶层取不到 G.world），而存一份 3.6 的拷贝会在 WALL_H 改动时让全部墙/围栏的
     物理高度静默停在 3.6，且没有任何断言会报警。
     读者不止本模块：player.boxFitsAt 钳出手点时也必须按同一口径过滤（否则 collider
     高度规则一改而那份不改，投掷钳位会按错误高度放行，D-T3 的 C1 会在窄带内重开）。
     任何需要 collider 高度的代码一律调本函数，不得再抄一份「缺省 = WALL_H」。 */
  function heightOf(col) {
    if (col && typeof col.h === 'number' && col.h > 0) return col.h;
    return (G.world && G.world.WALL_H) || 3.6;
  }

  /* 全量重建：先清后建。地/天花板 plane 不参与。
     【唯一真相源】静态刚体只从 G.world.colliders 生成，绝不手写第二份几何表 */
  function syncStatics() {
    if (!world) return;
    var i;
    for (i = 0; i < staticBodies.length; i++) world.removeBody(staticBodies[i]);
    staticBodies.length = 0;
    var cols = (G.world && G.world.colliders) || [];
    for (i = 0; i < cols.length; i++) {
      var col = cols[i];
      var h = heightOf(col);
      var body = new CANNON.Body({ mass: 0, material: staticMat });
      body.addShape(new CANNON.Box(new CANNON.Vec3(
        (col.maxX - col.minX) / 2, h / 2, (col.maxZ - col.minZ) / 2)));
      body.position.set((col.minX + col.maxX) / 2, h / 2, (col.minZ + col.maxZ) / 2);
      world.addBody(body);
      staticBodies.push(body);
    }
  }

  function update(dt) {
    if (!world || !(dt > 0)) return;
    world.step(FIXED_STEP, dt, MAX_SUB_STEPS);
    var loose = looseBoxes();
    for (var i = 0; i < loose.length; i++) {
      var b = loose[i];
      b.mesh.position.copy(b.rb.interpolatedPosition);   // 平滑
      /* 旋转必须读 quaternion：cannon 0.6.2 变步长路径下对醒着的动态体不写插值四元数
         （永远是单位四元数），用它的后果是「箱不转」且不报错。见 spec §2.2 与文件头 */
      b.mesh.quaternion.copy(b.rb.quaternion);
    }
  }

  function makeBoxBody(box, mass) {
    var body = new CANNON.Body({
      mass: mass, material: boxMat,
      linearDamping: BOX_LIN_DAMP, angularDamping: BOX_ANG_DAMP
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(BOX_HALF, BOX_HALF, BOX_HALF)));
    var p = box.mesh.position, q = box.mesh.quaternion;
    body.position.set(p.x, p.y, p.z);
    body.quaternion.set(q.x, q.y, q.z, q.w);
    body.allowSleep = true;
    body.sleepSpeedLimit = SLEEP_SPEED;
    body.sleepTimeLimit = SLEEP_TIME;
    world.addBody(body);
    /* 字段名锁死 rb：box.body 已经是纸箱的纸板 mesh（world.js:1252），
       且 destroyBox 会对 box.body 调 geometry.dispose() */
    box.rb = body;
    return body;
  }

  function attach(box) {
    if (!world || !box || !box.mesh) return null;
    detach(box);
    return makeBoxBody(box, BOX_MASS);
  }

  function attachStatic(box) {
    if (!world || !box || !box.mesh) return null;
    detach(box);
    return makeBoxBody(box, 0);
  }

  function detach(box) {
    if (!world || !box || !box.rb) return;
    world.removeBody(box.rb);
    box.rb = null;
  }

  function throwBox(box, dir, speed, spin) {
    var body = attach(box);
    if (!body) return;
    body.wakeUp();
    body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed);
    body.angularVelocity.set(spin.x, spin.y, spin.z);
  }

  /* loose = 有动态刚体的箱。判据直接从 allBoxes() + rb.type 推导，不另存一份名单 */
  function looseBoxes() {
    looseScratch.length = 0;
    if (typeof CANNON === 'undefined') return looseScratch;
    var list = (G.world && G.world.allBoxes) ? G.world.allBoxes() : [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.rb && b.rb.type === CANNON.Body.DYNAMIC) looseScratch.push(b);
    }
    return looseScratch;
  }

  function stateOf(box) {
    if (G.player && G.player.carrying === box) return 'held';
    var slots = (G.world && G.world.storageSlots) || [];
    for (var i = 0; i < slots.length; i++) { if (slots[i].box === box) return 'slotted'; }
    return 'loose';
  }

  /* 离线探针：在一个与 init() 同配置的独立 world 里跑，绝不脏化游戏世界 */
  function probeCeiling(v0) {
    if (typeof CANNON === 'undefined') return 99;
    var W = buildWorld(), bodies = [], max = -Infinity, i, s;
    for (i = 0; i < 12; i++) {
      var b = new CANNON.Body({
        mass: BOX_MASS, material: W.boxMat,
        linearDamping: BOX_LIN_DAMP, angularDamping: BOX_ANG_DAMP
      });
      b.addShape(new CANNON.Box(new CANNON.Vec3(BOX_HALF, BOX_HALF, BOX_HALF)));
      b.position.set(i * 1.5 - 8, 1.9, (i % 3) * 1.2 - 1.2);
      b.velocity.set(0, v0, 0);
      b.angularVelocity.set((i % 5) - 2, (i % 7) - 3, (i % 3) - 1);
      W.world.addBody(b);
      bodies.push(b);
    }
    for (s = 0; s < 300; s++) {
      W.world.step(FIXED_STEP, 0.017, MAX_SUB_STEPS);
      for (i = 0; i < bodies.length; i++) {
        /* NaiveBroadphase 默认 useBoundingBoxes=false，body.aabb 全程不会被 step 更新。
           不显式 computeAABB() 这条断言会一直读到初始 aabb（0.225）而恒绿 —— 空断言。 */
        bodies[i].computeAABB();
        if (bodies[i].aabb.upperBound.y > max) max = bodies[i].aabb.upperBound.y;
      }
    }
    return max;
  }

  function probeTunnel(speed) {
    if (typeof CANNON === 'undefined') return { wallZ: 99, dropY: -1 };
    var W = buildWorld(), i;
    var wall = new CANNON.Body({ mass: 0, material: W.staticMat });
    wall.addShape(new CANNON.Box(new CANNON.Vec3(4, 1.8, 0.2)));   // 半厚 0.2 = 墙 collider
    wall.position.set(0, 1.8, 3);
    W.world.addBody(wall);

    var h = new CANNON.Body({
      mass: BOX_MASS, material: W.boxMat,
      linearDamping: BOX_LIN_DAMP, angularDamping: BOX_ANG_DAMP
    });
    h.addShape(new CANNON.Box(new CANNON.Vec3(BOX_HALF, BOX_HALF, BOX_HALF)));
    h.position.set(0, 1.3, 0);
    h.velocity.set(0, 0, speed);
    W.world.addBody(h);

    var d = new CANNON.Body({
      mass: BOX_MASS, material: W.boxMat,
      linearDamping: BOX_LIN_DAMP, angularDamping: BOX_ANG_DAMP
    });
    d.addShape(new CANNON.Box(new CANNON.Vec3(BOX_HALF, BOX_HALF, BOX_HALF)));
    d.position.set(-3, 1.9, 0);
    d.velocity.set(0, -speed, 0);
    W.world.addBody(d);

    for (i = 0; i < 120; i++) W.world.step(FIXED_STEP, 0.017, MAX_SUB_STEPS);
    return { wallZ: h.position.z, dropY: d.position.y };
  }

  G.physics = {
    init: init,
    syncStatics: syncStatics,
    update: update,
    attach: attach,
    attachStatic: attachStatic,
    detach: detach,
    throwBox: throwBox,
    looseBoxes: looseBoxes,
    heightOf: heightOf,
    CEIL_Y: CEIL_Y,
    BOX_HALF: BOX_HALF,   // player.releaseThrow 钳出手点要用；不得在别处再抄一份 0.225
    _test: {
      bodyCount: function () { return world ? world.bodies.length : 0; },
      staticCount: function () { return staticBodies.length + planeCount; },
      hasBody: function (body) { return !!world && !!body && world.bodies.indexOf(body) !== -1; },
      stateOf: stateOf,
      stepOnce: function () { if (world) world.step(FIXED_STEP, FIXED_STEP, MAX_SUB_STEPS); },
      probeCeiling: probeCeiling,
      probeTunnel: probeTunnel,
      /* 源码级自检面：返回本模块 IIFE 的全文（具名函数表达式的自引用 toString），
         覆盖常量区 + 顶层代码 + 全部函数与其函数体注释。无构建步骤，源码即所写；
         file:// 下不能用 XHR 读自身文件，故走这条路。扫描口径见文件头注释。 */
      src: function () { return physicsModule.toString(); }
    }
  };
})();
