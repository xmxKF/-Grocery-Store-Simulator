// player.js — 第一人称玩家控制器（移动 / 视角 / 碰撞 / 射线交互）
(function () {
  'use strict';
  window.G = window.G || {};

  // ---- 常量 ----
  var EYE_HEIGHT = 1.65;
  var PLAYER_RADIUS = 0.35; // 文档未规定，取合理值供 AABB 碰撞膨胀
  var MOUSE_SENS = 0.0022;  // 文档未规定，取常见指针锁定灵敏度
  var MAX_PITCH = 85 * Math.PI / 180;
  var HL_COLOR = 0xFFD666;
  var HL_INTENSITY = 0.35;

  function CONFIG() { return G.data.CONFIG; }

  // ---- 模块状态 ----
  var camera = null;
  var domElement = null;

  var pos = null;      // THREE.Vector3，玩家脚下位置（y 恒为 0，仅 x/z 有意义）
  var yaw = 0;
  var pitch = 0;

  var currentScreen = null; // 'screen' 事件里的 name
  var hovered = null;       // 当前命中的 interactable
  var lastPromptText = null;
  var stockCooldown = 0;
  var wasBlocked = false;
  var registerJustExited = false;

  var keys = {};
  var eJustPressed = false;
  var mouseJustPressed = false;
  var mouseDown = false;
  var qJustPressed = false;
  var tabJustPressed = false;
  var oJustPressed = false;

  var raycaster = new THREE.Raycaster();
  var _fwd = new THREE.Vector3();
  var _right = new THREE.Vector3();
  var _move = new THREE.Vector3();
  var _camDir = new THREE.Vector3();

  G.player = {
    init: init,
    update: update,
    carrying: null,
    camera: null,
    getPose: getPose,
    setPose: setPose,
    _test: { prompt: function (entry) { return computePrompt(entry); } }
  };

  // ---- 初始化 ----
  function init(cam, dom) {
    camera = cam;
    domElement = dom;
    camera.rotation.order = 'YXZ';

    pos = new THREE.Vector3(camera.position.x, EYE_HEIGHT, camera.position.z);
    yaw = camera.rotation.y || 0;
    pitch = 0;
    camera.position.set(pos.x, pos.y, pos.z);
    camera.rotation.set(pitch, yaw, 0);

    domElement.addEventListener('click', onCanvasClick);
    domElement.addEventListener('mousedown', onMouseDown);
    domElement.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    G.bus.on('screen', onScreenEvent);
    G.player.camera = camera;
  }

  /* 位姿快照（纯数值，非引用）。收银台进出时由 checkout 显式保存与还原。 */
  function getPose() {
    return { x: pos ? pos.x : 0, z: pos ? pos.z : 0, yaw: yaw, pitch: pitch };
  }

  function setPose(p) {
    registerJustExited = true;
    if (!p || !pos || !camera) return;
    if (isFinite(p.x)) pos.x = p.x;
    if (isFinite(p.z)) pos.z = p.z;
    if (isFinite(p.yaw)) yaw = p.yaw;
    if (isFinite(p.pitch)) pitch = G.clamp(p.pitch, -MAX_PITCH, MAX_PITCH);
    camera.position.set(pos.x, EYE_HEIGHT, pos.z);
    camera.rotation.set(pitch, yaw, 0);
  }

  function onScreenEvent(payload) {
    currentScreen = (payload && payload.name !== undefined) ? payload.name : null;
  }

  // ---- 输入监听 ----
  function isLocked() {
    return document.pointerLockElement === domElement;
  }

  function onCanvasClick() {
    if (isLocked()) return;
    if (currentScreen !== null) return;
    if (G.checkout && G.checkout.inRegister) return;
    domElement.requestPointerLock();
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (!isLocked()) return;
    mouseDown = true;
    mouseJustPressed = true;
  }

  function onMouseUp(e) {
    if (e.button !== 0) return;
    mouseDown = false;
  }

  function onMouseMove(e) {
    if (!isLocked()) return;
    if (currentScreen !== null) return;
    if (G.checkout && G.checkout.inRegister) return;
    yaw -= (e.movementX || 0) * MOUSE_SENS;
    pitch -= (e.movementY || 0) * MOUSE_SENS;
    pitch = G.clamp(pitch, -MAX_PITCH, MAX_PITCH);
  }

  function onKeyDown(e) {
    switch (e.code) {
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD':
      case 'ShiftLeft': case 'ShiftRight':
        keys[e.code] = true;
        break;
      case 'KeyE':
        if (!keys.KeyE) eJustPressed = true;
        keys.KeyE = true;
        break;
      case 'KeyQ':
        if (!e.repeat) qJustPressed = true;
        break;
      case 'Tab':
        e.preventDefault();
        if (!e.repeat) tabJustPressed = true;
        break;
      case 'KeyO':
        if (!e.repeat) oJustPressed = true;
        break;
    }
  }

  function onKeyUp(e) {
    switch (e.code) {
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD':
      case 'ShiftLeft': case 'ShiftRight':
        keys[e.code] = false;
        break;
      case 'KeyE':
        keys.KeyE = false;
        break;
    }
  }

  // ---- 每帧更新 ----
  function update(dt) {
    if (!camera) return;

    syncCarriedBox();

    var registerActive = !!(G.checkout && G.checkout.inRegister);

    if (tabJustPressed) {
      tabJustPressed = false;
      if (!registerActive) {
        if (currentScreen === 'computer') {
          if (G.ui) G.ui.showScreen(null);
        } else if (currentScreen === null) {
          if (G.ui) G.ui.showScreen('computer');
        }
      }
    }

    var screenIsOpen = currentScreen !== null;
    var blocked = screenIsOpen || registerActive;

    if (blocked) {
      if (isLocked()) document.exitPointerLock();
      clearHover();
      eJustPressed = false;
      mouseJustPressed = false;
      qJustPressed = false;
      oJustPressed = false;
      wasBlocked = true;
      return;
    }

    if (wasBlocked) {
      // 全屏界面不移动相机，但可能改了朝向，仍需同步；
      // 收银模式的位姿由 checkout.exitRegister() 经 setPose 显式还原，这里不得再从相机反推，
      // 否则会把站位坐标（柜台背侧）当成玩家位置写回去。
      if (!registerJustExited) {
        yaw = camera.rotation.y;
        pitch = G.clamp(camera.rotation.x, -MAX_PITCH, MAX_PITCH);
        pos.x = camera.position.x;
        pos.z = camera.position.z;
      }
      registerJustExited = false;
      wasBlocked = false;
    }

    if (oJustPressed) {
      oJustPressed = false;
      G.bus.emit('toggleOpen', {});
    }

    if (!isLocked()) {
      clearHover();
      eJustPressed = false;
      mouseJustPressed = false;
      qJustPressed = false;
      return;
    }

    doMovement(dt);

    camera.position.set(pos.x, EYE_HEIGHT, pos.z);
    camera.rotation.set(pitch, yaw, 0);

    updateHover();
    doInteractions();

    if (stockCooldown > 0) stockCooldown -= dt;
  }

  // ---- 移动与碰撞 ----
  function doMovement(dt) {
    var cfg = CONFIG();
    var sprint = keys.ShiftLeft || keys.ShiftRight;
    var speed = sprint ? cfg.sprintSpeed : cfg.walkSpeed;
    if (G.player.carrying) speed *= cfg.carrySpeedMult;

    var sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    _fwd.set(-sinY, 0, -cosY);
    _right.set(cosY, 0, -sinY);

    _move.set(0, 0, 0);
    if (keys.KeyW) _move.add(_fwd);
    if (keys.KeyS) _move.sub(_fwd);
    if (keys.KeyD) _move.add(_right);
    if (keys.KeyA) _move.sub(_right);
    if (_move.lengthSq() > 1e-8) _move.normalize();
    _move.multiplyScalar(speed * dt);

    moveWithCollision(_move.x, _move.z);
  }

  function moveWithCollision(dx, dz) {
    var colliders = (G.world && G.world.colliders) || [];
    var x = pos.x, z = pos.z;
    // 升级/买许可证会在玩家脚下新建货架碰撞体：此时逐轴判定会把所有方向都挡死，
    // 已陷在碰撞体内就放行移动，让玩家自己走出去
    var stuck = collidesAt(x, z, colliders);

    var nx = x + dx;
    if (stuck || !collidesAt(nx, z, colliders)) x = nx;

    var nz = z + dz;
    if (stuck || !collidesAt(x, nz, colliders)) z = nz;

    pos.x = x;
    pos.z = z;
  }

  function collidesAt(x, z, colliders) {
    var r = PLAYER_RADIUS;
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
    }
    return false;
  }

  // ---- 手持纸箱跟随 ----
  function syncCarriedBox() {
    var carrying = G.player.carrying;
    if (!carrying || !carrying.mesh || !camera) return;
    camera.getWorldDirection(_camDir);
    carrying.mesh.position.copy(camera.position).addScaledVector(_camDir, 0.6);
    carrying.mesh.position.y -= 0.35;
    carrying.mesh.rotation.set(0, yaw, 0);
  }

  // ---- 射线检测 / 高亮 / 提示 ----
  function updateHover() {
    var interactables = (G.world && G.world.interactables) || [];
    var targets = [];
    var byUuid = {};
    for (var i = 0; i < interactables.length; i++) {
      var ent = interactables[i];
      var obj = ent.mesh || ent.obj3D || ent.object3D;
      if (obj) {
        targets.push(obj);
        byUuid[obj.uuid] = ent;
      }
    }

    var newHover = null;
    if (targets.length) {
      camera.getWorldDirection(_camDir);
      raycaster.set(camera.position, _camDir);
      raycaster.far = CONFIG().interactRange;
      var hits = raycaster.intersectObjects(targets, true);
      if (hits.length) {
        var node = hits[0].object;
        while (node) {
          if (byUuid[node.uuid]) { newHover = byUuid[node.uuid]; break; }
          node = node.parent;
        }
        if (newHover && occluded(newHover, hits[0].point)) newHover = null;
      }
    }

    if (newHover !== hovered) {
      if (hovered) unhighlight(hovered);
      hovered = newHover;
      if (hovered) highlight(hovered);
    }

    var promptText = hovered ? computePrompt(hovered) : null;
    if (promptText !== lastPromptText) {
      lastPromptText = promptText;
      G.bus.emit('hover', { prompt: promptText });
    }
  }

  /* 射线只测 interactable，墙体/货架背板不在其中：用 collider 的 2D AABB 补一次视线遮挡判定，
     否则可以隔着墙搬箱、绕到货架背面上架。命中物自身所在的 collider 不算遮挡。 */
  function occluded(entry, point) {
    if (entry.type === 'shelfSlot') {
      var slot = entry.data && entry.data.slot;
      if (slot && slot.faceZ && (pos.z - slot.pos.z) * slot.faceZ <= 0) return true;   // 站在货架背面
    }
    var colliders = (G.world && G.world.colliders) || [];
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      if (point.x > c.minX - 0.05 && point.x < c.maxX + 0.05 &&
          point.z > c.minZ - 0.05 && point.z < c.maxZ + 0.05) continue;   // 命中点落在自身碰撞体上
      if (segmentHitsBox(pos.x, pos.z, point.x, point.z, c)) return true;
    }
    return false;
  }

  function segmentHitsBox(x0, z0, x1, z1, c) {
    var t0 = 0, t1 = 1;
    var dx = x1 - x0;
    if (Math.abs(dx) < 1e-6) {
      if (x0 <= c.minX || x0 >= c.maxX) return false;
    } else {
      var ax = (c.minX - x0) / dx, bx = (c.maxX - x0) / dx;
      if (ax > bx) { var tx = ax; ax = bx; bx = tx; }
      t0 = Math.max(t0, ax); t1 = Math.min(t1, bx);
      if (t0 > t1) return false;
    }
    var dz = z1 - z0;
    if (Math.abs(dz) < 1e-6) {
      if (z0 <= c.minZ || z0 >= c.maxZ) return false;
    } else {
      var az = (c.minZ - z0) / dz, bz = (c.maxZ - z0) / dz;
      if (az > bz) { var tz = az; az = bz; bz = tz; }
      t0 = Math.max(t0, az); t1 = Math.min(t1, bz);
    }
    return t0 <= t1;
  }

  function clearHover() {
    if (hovered) {
      unhighlight(hovered);
      hovered = null;
    }
    if (lastPromptText !== null) {
      lastPromptText = null;
      G.bus.emit('hover', { prompt: null });
    }
  }

  function forEachMaterial(obj3D, fn) {
    obj3D.traverse(function (node) {
      if (!node.isMesh || !node.material) return;
      if (Array.isArray(node.material)) {
        for (var i = 0; i < node.material.length; i++) fn(node.material[i]);
      } else {
        fn(node.material);
      }
    });
  }

  function highlight(entry) {
    var obj = entry.mesh || entry.obj3D || entry.object3D;
    if (!obj) return;
    var cache = [];
    forEachMaterial(obj, function (mat) {
      if (!mat.emissive) return;
      cache.push({ mat: mat, color: mat.emissive.clone(), intensity: mat.emissiveIntensity });
      mat.emissive.setHex(HL_COLOR);
      mat.emissiveIntensity = HL_INTENSITY;
    });
    entry._hlCache = cache;
  }

  function unhighlight(entry) {
    var cache = entry._hlCache;
    if (!cache) return;
    for (var i = 0; i < cache.length; i++) {
      cache[i].mat.emissive.copy(cache[i].color);
      cache[i].mat.emissiveIntensity = cache[i].intensity;
    }
    entry._hlCache = null;
  }

  // 提示文案格式见 DESIGN.md §6
  function computePrompt(entry) {
    var carrying = G.player.carrying;
    var type = entry.type;

    if (type === 'computer') return '[E] 打开订货电脑';
    if (type === 'register') return '[E] 进入收银台';

    if (type === 'shutter') {
      var sd = entry.data || {};
      if (G.state.zones && G.state.zones[sd.zone]) return null;   // 已开放
      // 价格/等级读 CONFIG（与 shop.buyZone 同源），否则改 CONFIG 会「显示旧价、扣新价」
      var sdLv = G.data.CONFIG.zoneLevels[sd.zone];
      var sdPrice = G.data.CONFIG.zonePrices[sd.zone];
      if (G.state.level < sdLv) return '需 Lv' + sdLv + ' 才能开放' + sd.label;
      if (G.state.money < sdPrice) return '资金不足：开放' + sd.label + ' 需 ' + G.fmt(sdPrice);
      return '[E] 开放' + sd.label + '（' + G.fmt(sdPrice) + ' · 需 Lv' + sdLv + '）';
    }

    if (type === 'box') {
      if (carrying) return null;
      var bx = entry.data && entry.data.box;
      if (!bx) return null;
      var bprod = G.data.productById(bx.productId);
      var bname = bprod ? bprod.name : (bx.productId || '');
      return '[E] 搬起纸箱（' + bname + ' ×' + bx.itemsLeft + '）';
    }

    // 空手时存储位不可交互：位上有箱时箱体自己是 box 交互，位空则无事可做
    if (type === 'storage') {
      if (!carrying) return null;
      var stSlot = entry.data && entry.data.slot;
      if (!stSlot) return null;
      if (stSlot.box) return '此位已占用';
      return '[E] 放入纸箱';
    }

    if (type === 'trash') {
      if (!carrying) return null;
      if (carrying.itemsLeft > 0) return '箱内还有商品，无法丢弃';
      return '[E] 丢弃空箱';
    }

    if (type === 'shelfSlot') {
      if (!carrying) return null;
      if (carrying.itemsLeft <= 0) return '纸箱已空，请到垃圾桶丢弃';
      var slot = entry.data && entry.data.slot;
      if (!slot) return null;
      var prod = G.data.productById(carrying.productId);
      if (!prod) return null;
      // GDD §4：生鲜只能放冷藏柜，其它类目不能放冷藏柜
      if (slot.fridge && prod.cat !== '生鲜') return '冷藏柜仅限生鲜';
      if (!slot.fridge && prod.cat === '生鲜') return '该商品需冷藏';
      if (slot.productId != null && slot.count > 0 && slot.productId !== carrying.productId) return '此格已被占用';
      if (slot.count >= prod.slotCap) return '此格已放满';
      return '[E] 上架 1 件 · ' + prod.name;
    }

    return null;
  }

  // ---- 交互动作 ----
  function doInteractions() {
    var actionEdge = eJustPressed || mouseJustPressed;
    eJustPressed = false;
    mouseJustPressed = false;
    var actionHeld = !!(keys.KeyE || mouseDown);
    var carrying = G.player.carrying;

    if (qJustPressed) {
      qJustPressed = false;
      if (carrying) { putDownBox(); return; }
    }

    if (!hovered) return;

    if (!carrying) {
      if (!actionEdge) return;
      if (hovered.type === 'box') pickUpBox(hovered);
      else if (hovered.type === 'computer') { if (G.ui) G.ui.showScreen('computer'); }
      else if (hovered.type === 'register') enterHoveredRegister(hovered);
      else if (hovered.type === 'shutter') tryBuyZone(hovered);
      return;
    }

    if (hovered.type === 'computer') {
      if (actionEdge && G.ui) G.ui.showScreen('computer');
    } else if (hovered.type === 'register') {
      if (actionEdge) enterHoveredRegister(hovered);
    } else if (hovered.type === 'shutter') {
      if (actionEdge) tryBuyZone(hovered);
    } else if (hovered.type === 'storage') {
      if (actionEdge) storeCarriedBox(hovered);
    } else if (hovered.type === 'trash') {
      if (actionEdge && carrying.itemsLeft <= 0) discardBox();
    } else if (hovered.type === 'shelfSlot') {
      if (actionHeld && stockCooldown <= 0 && carrying.itemsLeft > 0) {
        tryPlaceItem(hovered);
      }
    }
  }

  function enterHoveredRegister(entry) {
    if (!G.checkout) return;
    G.checkout.enterRegister(entry.data && entry.data.register);
  }

  function tryBuyZone(entry) {
    var d = entry.data || {};
    if (!G.shop || !G.shop.buyZone) return;
    if (G.shop.buyZone(d.zone)) {
      if (G.ui && G.ui.toast) G.ui.toast('已开放' + d.label, 'ok');
      clearHover();   // 卷帘门 mesh 随即隐藏，高亮缓存必须还原
    } else if (G.ui && G.ui.toast) {
      G.ui.toast(computePrompt(entry) || '暂时无法开放', 'danger');
    }
  }

  function removeInteractable(entry) {
    var list = G.world && G.world.interactables;
    if (!list) return;
    var idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
  }

  function storeCarriedBox(entry) {
    var slot = entry.data && entry.data.slot;
    var carrying = G.player.carrying;
    if (!slot || !carrying || !G.world || !G.world.storeBox) return;
    if (!G.world.storeBox(slot, carrying)) return;
    G.player.carrying = null;
    clearHover();   // 箱体随即盖住标记，必须还原标记的高亮缓存
  }

  function pickUpBox(entry) {
    var box = entry.data && entry.data.box;
    if (!box || !box.mesh) return;
    if (G.world && G.world.releaseStorageOf) G.world.releaseStorageOf(box);
    unhighlight(entry);
    removeInteractable(entry);
    G.player.carrying = box;   // {mesh, productId, itemsLeft, body, label}
    hovered = null;
    lastPromptText = null;
    G.bus.emit('hover', { prompt: null });
  }

  function putDownBox() {
    var carrying = G.player.carrying;
    if (!carrying) return;
    var mesh = carrying.mesh;
    mesh.position.set(pos.x, 0.225, pos.z);
    mesh.rotation.set(0, yaw, 0);

    if (G.world && G.world.registerInteractable) {
      var prod = G.data.productById(carrying.productId);
      var name = prod ? prod.name : carrying.productId;
      G.world.registerInteractable(mesh, {
        type: 'box',
        data: { box: carrying },
        prompt: '[E] 搬起纸箱（' + name + ' ×' + carrying.itemsLeft + '）'
      });
    }

    G.player.carrying = null;
  }

  function discardBox() {
    var carrying = G.player.carrying;
    if (!carrying) return;
    var mesh = carrying.mesh;
    if (mesh && mesh.parent) mesh.parent.remove(mesh);
    G.player.carrying = null;
    if (G.addXP) G.addXP(1);
    clearHover();   // 必须还原垃圾桶的高亮缓存，否则高亮色被当成原值烙死
  }

  function tryPlaceItem(entry) {
    stockCooldown = CONFIG().stockCooldown;
    var carrying = G.player.carrying;
    var slot = entry.data && entry.data.slot;
    if (!slot || !carrying) return;
    var pid = carrying.productId;
    var prod = G.data.productById(pid);
    if (slot.productId != null && slot.count > 0 && slot.productId !== pid) return; // 此格已被占用
    if (prod && slot.count >= prod.slotCap) return; // 此格已放满
    // 飞行起点取手持纸箱的世界坐标（syncCarriedBox 每帧更新它）
    var fromPos = (carrying.mesh && carrying.mesh.position) ? carrying.mesh.position.clone() : null;
    var ok = G.world.addItem(slot, pid, fromPos);
    if (ok) {
      carrying.itemsLeft -= 1;
      if (G.world.updateBoxVisual) G.world.updateBoxVisual(carrying); // 空箱材质变暗
      G.bus.emit('stocked', { productId: pid, slotId: slot.id });
    } else if (G.ui && G.ui.toast) {
      G.ui.toast(slot.fridge ? '冷藏柜仅限生鲜' : '该商品需冷藏', 'danger');
    }
  }
})();
