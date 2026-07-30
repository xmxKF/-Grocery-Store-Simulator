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

  // ---- 常量（DESIGN.md §5 / §1.3） ----
  var ROOM_HALF_X = 8;   // 16m 宽
  var ROOM_HALF_Z = 6;   // 12m 深
  var WALL_H = 3.0;
  var WALL_T = 0.2;
  var SHELF_W = 2.0, SHELF_D = 0.8, SHELF_H = 1.8;
  var SLOT_LOCAL_X = [-0.6, 0, 0.6];
  var SLOT_HEIGHTS = [0.9, 1.4];

  // 格位商品方块：几何体与材质全局共享（每格最多 16 个 × 最多 48 格，绝不逐个 new）
  var ITEM_GEO = null;
  var ITEM_MATS = {};

  function itemGeo() {
    if (!ITEM_GEO) ITEM_GEO = new THREE.BoxGeometry(0.16, 0.22, 0.16);
    return ITEM_GEO;
  }

  function itemMat(color) {
    var k = String(color);
    if (!ITEM_MATS[k]) ITEM_MATS[k] = flatMat(color);
    return ITEM_MATS[k];
  }

  /* 每行 4 个、最多 4 行（DESIGN §5）：列距 0.14 使一格的堆宽 0.58 < 格间距 0.6；
     行沿格位深度向货架内侧排（层高只有 0.5m，竖着堆会穿过上层隔板） */
  function itemLocalPos(i, faceZ) {
    var col = i % 4, row = Math.floor(i / 4);
    var depth = -(faceZ || 1);
    return new THREE.Vector3((col - 1.5) * 0.14, 0.11, depth * (0.16 + row * 0.16));
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

  // 价签贴图缓存：键为 (state|pid|price)，texture 跨格复用；材质仍逐格独立（见 CONTRACTS 职责裁定）
  var TAG_TEX = {};
  var TAG_BG = { stocked: null, out: '#E8B54C', empty: '#8C9AA6' };   // stocked 用类目色，运行时填

  function tagTexture(state, product, price) {
    var key = state + '|' + (product ? product.id : '-') + '|' + (price == null ? '-' : price);
    if (TAG_TEX[key]) return TAG_TEX[key];

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

  // 货架/冷藏柜格位中心坐标（沿 z=0 中央主过道排布，前方 aisleSpot 均在同一条直线上）
  var SHELF_POSITIONS = [
    { x: -5.0, z: -1.5 }, { x: -2.5, z: -1.5 }, { x: 0.0, z: -1.5 }, { x: 2.5, z: -1.5 }, // Lv1 起 4 组
    { x: 5.0, z: -1.5 },  // Lv3 第5组
    { x: -5.0, z: 1.5 },  // Lv6 第6组
    { x: -2.5, z: 1.5 }, { x: 0.0, z: 1.5 } // Lv8 第7/8组
  ];
  var FRIDGE_POSITIONS = [
    { x: 2.5, z: 1.5 }, { x: 5.0, z: 1.5 }
  ];

  var YARD_XS = [8.6, 9.4, 10.2, 11.0];
  var YARD_ZS = [-1.6, 0, 1.6];
  var YARD_POSITIONS = [];
  YARD_ZS.forEach(function (z) {
    YARD_XS.forEach(function (x) { YARD_POSITIONS.push({ x: x, z: z }); });
  });

  // ---- 模块状态 ----
  var sceneRef = null;
  var allSlots = [];
  var interactables = [];
  var colliders = [];
  var nav = { entry: null, exit: null, aisleSpots: [], queueSpots: [], registerFront: null };
  var shelfCount = 0;
  var fridgeCount = 0;
  var cashierGroup = null;
  var cashierVisible = false;

  function registerInteractable(obj3D, opts) {
    var entry = { mesh: obj3D, type: opts.type, data: opts.data || {}, prompt: opts.prompt || '' };
    interactables.push(entry);
    obj3D.traverse(function (o) { o.userData.interactable = entry; });
    return entry;
  }

  function addMesh(mesh) {
    sceneRef.add(mesh);
    return mesh;
  }

  function flatMat(color, opts) {
    var params = { color: color, flatShading: true };
    if (opts) { for (var k in opts) params[k] = opts[k]; }
    return new THREE.MeshLambertMaterial(params);
  }

  // ---------------------------------------------------------------
  // 静态建筑几何
  // ---------------------------------------------------------------
  function buildRoom() {
    // 地板
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF_X * 2, ROOM_HALF_Z * 2), flatMat(0xD8D2C6));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    addMesh(floor);

    // 天花板
    var ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF_X * 2, ROOM_HALF_Z * 2), flatMat(0xF5F2EC));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, WALL_H, 0);
    addMesh(ceiling);

    var wallMat = flatMat(0xEFE9DE);
    // 西墙 x=-8
    var wWall = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, ROOM_HALF_Z * 2 + WALL_T), wallMat);
    wWall.position.set(-ROOM_HALF_X, WALL_H / 2, 0);
    addMesh(wWall);
    // 北墙 z=-6
    var nWall = new THREE.Mesh(new THREE.BoxGeometry(ROOM_HALF_X * 2 + WALL_T, WALL_H, WALL_T), wallMat);
    nWall.position.set(0, WALL_H / 2, -ROOM_HALF_Z);
    addMesh(nWall);
    // 南墙 z=6
    var sWall = new THREE.Mesh(new THREE.BoxGeometry(ROOM_HALF_X * 2 + WALL_T, WALL_H, WALL_T), wallMat);
    sWall.position.set(0, WALL_H / 2, ROOM_HALF_Z);
    addMesh(sWall);
    // 东墙（留门缺口 z∈[-1,1]）
    var eWallA = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, 5), wallMat);
    eWallA.position.set(ROOM_HALF_X, WALL_H / 2, -3.5);
    addMesh(eWallA);
    var eWallB = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, 5), wallMat);
    eWallB.position.set(ROOM_HALF_X, WALL_H / 2, 3.5);
    addMesh(eWallB);

    // 门框（装饰立柱）
    var frameMat = flatMat(0x7A6A55);
    var postGeo = new THREE.BoxGeometry(0.15, WALL_H, 0.15);
    var postA = new THREE.Mesh(postGeo, frameMat);
    postA.position.set(ROOM_HALF_X, WALL_H / 2, -1);
    addMesh(postA);
    var postB = new THREE.Mesh(postGeo.clone(), frameMat);
    postB.position.set(ROOM_HALF_X, WALL_H / 2, 1);
    addMesh(postB);

    // 卸货区地面
    var yardW = 3.5, yardD = 5;
    var yard = new THREE.Mesh(new THREE.PlaneGeometry(yardW, yardD), flatMat(0xC7BEAF));
    yard.rotation.x = -Math.PI / 2;
    yard.position.set(ROOM_HALF_X + yardW / 2, 0.001, 0);
    addMesh(yard);

    // 墙体碰撞体
    colliders.push({ minX: -ROOM_HALF_X - 0.2, maxX: -ROOM_HALF_X + 0.2, minZ: -ROOM_HALF_Z - 0.2, maxZ: ROOM_HALF_Z + 0.2 });
    colliders.push({ minX: -ROOM_HALF_X - 0.2, maxX: ROOM_HALF_X + 0.2, minZ: -ROOM_HALF_Z - 0.2, maxZ: -ROOM_HALF_Z + 0.2 });
    colliders.push({ minX: -ROOM_HALF_X - 0.2, maxX: ROOM_HALF_X + 0.2, minZ: ROOM_HALF_Z - 0.2, maxZ: ROOM_HALF_Z + 0.2 });
    colliders.push({ minX: ROOM_HALF_X - 0.2, maxX: ROOM_HALF_X + 0.2, minZ: -ROOM_HALF_Z - 0.2, maxZ: -1.0 });
    colliders.push({ minX: ROOM_HALF_X - 0.2, maxX: ROOM_HALF_X + 0.2, minZ: 1.0, maxZ: ROOM_HALF_Z + 0.2 });

    // 卸货区边界（否则出门后可以一直往外走，走出世界边缘悬空）
    colliders.push({ minX: ROOM_HALF_X + yardW, maxX: ROOM_HALF_X + yardW + 0.4, minZ: -yardD / 2 - 0.2, maxZ: yardD / 2 + 0.2 });
    colliders.push({ minX: ROOM_HALF_X - 0.2, maxX: ROOM_HALF_X + yardW + 0.4, minZ: -yardD / 2 - 0.2, maxZ: -yardD / 2 + 0.2 });
    colliders.push({ minX: ROOM_HALF_X - 0.2, maxX: ROOM_HALF_X + yardW + 0.4, minZ: yardD / 2 - 0.2, maxZ: yardD / 2 + 0.2 });

    buildCheckout();
    buildComputer();
    buildTrash();

    // 导航点
    nav.entry = new THREE.Vector3(7.3, 0, 0);
    // 出口在门外卸货区（GDD §6.5 顾客「从 nav.exit 走出」），避开 YARD_POSITIONS 的箱位
    nav.exit = new THREE.Vector3(9.0, 0, 0.8);
    nav.registerFront = new THREE.Vector3(-6.2, 0, 0);
    nav.queueSpots = [
      new THREE.Vector3(-5.6, 0, 0),
      new THREE.Vector3(-5.0, 0, 0),
      new THREE.Vector3(-4.4, 0, 0),
      new THREE.Vector3(-3.8, 0, 0),
      new THREE.Vector3(-3.2, 0, 0)
    ];
  }

  function buildCheckout() {
    var body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 2.0), flatMat(0x6E7A88));
    body.position.set(-7.0, 0.5, 0);
    addMesh(body);
    var belt = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 1.6), flatMat(0x4E5866));
    belt.position.set(-7.0, 1.04, 0);
    addMesh(belt);
    colliders.push({ minX: -7.6, maxX: -6.4, minZ: -1.0, maxZ: 1.0 });
    registerInteractable(body, { type: 'register', data: {}, prompt: '[E] 进入收银台' });
  }

  function buildComputer() {
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.4), flatMat(0x3A424C));
    body.position.set(-7.0, 0.45, -5.3);
    addMesh(body);
    var screen = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.03), flatMat(0x4C9BE8));
    screen.position.set(-7.0, 0.85, -5.08);
    addMesh(screen);
    colliders.push({ minX: -7.25, maxX: -6.75, minZ: -5.5, maxZ: -5.1 });
    registerInteractable(body, { type: 'computer', data: {}, prompt: '[E] 打开订货电脑' });
  }

  function buildTrash() {
    var bin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.25, 0.6, 8), flatMat(0x5A6B5E));
    bin.position.set(7.0, 0.3, -5.3);
    addMesh(bin);
    colliders.push({ minX: 6.7, maxX: 7.3, minZ: -5.6, maxZ: -5.0 });
    registerInteractable(bin, { type: 'trash', data: {}, prompt: '[E] 丢弃纸箱' });
  }

  // ---------------------------------------------------------------
  // 收银员站桩（GDD §9 / CONTRACTS.md setCashierVisible）
  // 体型同顾客规格：Box 身体 0.45×1.0×0.3 + Box 头 0.28³ + 两条 Box 腿。
  // 站在收银台（buildCheckout：body x∈[-7.6,-6.4] z∈[-1,1]）与西墙（x∈[-8.1,-7.9]）之间的 0.3m 空隙，
  // 朝 +x（registerFront/传送带/排队方向），躯干旋转 90° 后进深占 x 轴 0.3m，正好卡在空隙内不与柜台/传送带相交。
  function buildCashierFigure() {
    var uniformMat = flatMat(0x4C9BE8);   // CONTRACTS.md：制服固定 #4C9BE8
    var skinMat = flatMat(0xC08B4E);      // 复用纸箱(满)色作肤色，保持 DESIGN.md 色板内中性暖色
    var legMat = flatMat(0x3A424C);       // 复用仓储电脑机身色作裤子，DESIGN.md 已有的中性深色

    var group = new THREE.Group();
    var torso = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.0, 0.3), uniformMat);
    torso.position.y = 1.05;
    var head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), skinMat);
    head.position.y = 1.69;
    var legL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.16), legMat);
    legL.position.set(-0.11, 0.275, 0);
    var legR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.16), legMat);
    legR.position.set(0.11, 0.275, 0);
    group.add(torso, head, legL, legR);

    group.position.set(-7.75, 0, 0);
    group.rotation.y = Math.PI / 2;   // 面朝 +x：传送带 / 排队方向
    return group;
  }

  function setCashierVisible(visible) {
    visible = !!visible;
    if (visible === cashierVisible) return;
    if (visible) {
      if (!cashierGroup) cashierGroup = buildCashierFigure();
      if (sceneRef) sceneRef.add(cashierGroup);
    } else if (cashierGroup && cashierGroup.parent) {
      cashierGroup.parent.remove(cashierGroup);
    }
    cashierVisible = visible;
  }

  // ---------------------------------------------------------------
  // 货架 / 冷藏柜
  // ---------------------------------------------------------------
  function buildRack(idPrefix, centerX, centerZ, isFridge) {
    var group = new THREE.Group();
    var facing = centerZ <= 0 ? 1 : -1; // 朝向中央主过道（z=0）一侧
    var frontZ = centerZ + facing * (SHELF_D / 2);
    var backZ = centerZ - facing * (SHELF_D / 2 - 0.025);

    var frameColor = 0x8C9AA6;
    var back = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W, SHELF_H, 0.05), flatMat(frameColor));
    back.position.set(centerX, SHELF_H / 2, backZ);
    group.add(back);

    var sideGeo = new THREE.BoxGeometry(0.05, SHELF_H, SHELF_D);
    var sideL = new THREE.Mesh(sideGeo, flatMat(frameColor));
    sideL.position.set(centerX - SHELF_W / 2, SHELF_H / 2, centerZ);
    group.add(sideL);
    var sideR = new THREE.Mesh(sideGeo.clone(), flatMat(frameColor));
    sideR.position.set(centerX + SHELF_W / 2, SHELF_H / 2, centerZ);
    group.add(sideR);

    SLOT_HEIGHTS.forEach(function (y) {
      var board = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W, 0.04, SHELF_D), flatMat(frameColor));
      board.position.set(centerX, y - 0.04, centerZ);
      group.add(board);
    });

    if (isFridge) {
      var glass = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W, SHELF_H, 0.03),
        flatMat(0xBFE3EC, { transparent: true, opacity: 0.35 }));
      glass.position.set(centerX, SHELF_H / 2, frontZ);
      group.add(glass);
    }

    sceneRef.add(group);

    var aisleSpot = new THREE.Vector3(centerX, 0, 0);
    var groupSlots = [];
    SLOT_HEIGHTS.forEach(function (y, rowIdx) {
      SLOT_LOCAL_X.forEach(function (lx, ci) {
        var id = idPrefix + '_' + rowIdx + '_' + ci;
        var pos = new THREE.Vector3(centerX + lx, y, frontZ);

        var holder = new THREE.Group();

        // 不可见命中盒：射线靶子。用 opacity 0 而非 visible=false，确保必定可被 raycast 命中。
        var hit = new THREE.Mesh(hitGeo(), flatMat(0xFFFFFF, {
          transparent: true, opacity: 0, depthWrite: false
        }));
        hit.position.set(pos.x, y + 0.23, frontZ - facing * 0.25);
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

    colliders.push({ minX: centerX - SHELF_W / 2, maxX: centerX + SHELF_W / 2, minZ: centerZ - SHELF_D / 2, maxZ: centerZ + SHELF_D / 2 });
    nav.aisleSpots.push(aisleSpot);

    return { group: group, slots: groupSlots, aisleSpot: aisleSpot };
  }

  function syncLayout() {
    if (!sceneRef) return;
    var level = (G.state && G.state.level) || 1;
    var licenses = (G.state && G.state.licenses) || [];

    var targetShelves = level >= 8 ? 8 : (level >= 6 ? 6 : (level >= 3 ? 5 : 4));
    while (shelfCount < targetShelves && shelfCount < SHELF_POSITIONS.length) {
      var sp = SHELF_POSITIONS[shelfCount];
      buildRack('shelf' + shelfCount, sp.x, sp.z, false);
      shelfCount++;
    }

    var targetFridges = licenses.indexOf('生鲜') !== -1 ? 2 : 0;
    while (fridgeCount < targetFridges && fridgeCount < FRIDGE_POSITIONS.length) {
      var fp = FRIDGE_POSITIONS[fridgeCount];
      buildRack('fridge' + fridgeCount, fp.x, fp.z, true);
      fridgeCount++;
    }
  }

  // ---------------------------------------------------------------
  // 格位可见商品堆
  // ---------------------------------------------------------------
  function updateSlotVisual(slot) {
    var group = slot.itemGroup;
    var want = (!slot.productId || slot.count <= 0) ? 0 : Math.min(slot.count, 16);

    // 商品种类变了，整格重来；否则只增删末尾
    if (slot._visPid !== slot.productId) {
      while (group.children.length) group.remove(group.children[group.children.length - 1]);
      slot._visPid = slot.productId;
    }
    while (group.children.length > want) group.remove(group.children[group.children.length - 1]);
    if (want === 0) return;

    var product = G.data.productById(slot.productId);
    if (!product) return;
    while (group.children.length < want) {
      var i = group.children.length;
      var cube = new THREE.Mesh(itemGeo(), itemMat(product.color));
      cube.position.copy(itemLocalPos(i, slot.faceZ));
      group.add(cube);
    }
  }

  /* DESIGN §6：商品自纸箱位置直线飞向目标格位，180ms ease-out。
     纯视觉，与逻辑解耦——addItem 返回时商品在逻辑上已在格内。自驱 rAF，不接主循环 dt。 */
  var flights = [];
  var flightRaf = false;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function flyItem(slot, product, fromPos, targetLocal, idx) {
    if (!sceneRef || typeof requestAnimationFrame !== 'function') return null;
    var mesh = new THREE.Mesh(itemGeo(), itemMat(product.color));
    mesh.position.copy(fromPos);
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
        continue;   // 中断销毁：不调 onDone，格位已被清空/换商品（spec §5.2）
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

  /* DESIGN §6：上架成功，商品方块 90ms 内从 0.8 倍缩放到 1.0 倍出现 */
  function popInItem(mesh) {
    if (!mesh || typeof requestAnimationFrame !== 'function') return;
    var t0 = Date.now();
    mesh.scale.setScalar(0.8);
    (function step() {
      var k = Math.min(1, (Date.now() - t0) / 90);
      mesh.scale.setScalar(0.8 + 0.2 * k);
      if (k < 1) requestAnimationFrame(step);
    })();
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
          if (slot.count > idx && idx < slot.itemGroup.children.length) popInItem(slot.itemGroup.children[idx]);
        };
        return true;
      }
    }

    updateSlotVisual(slot);
    if (slot.count <= slot.itemGroup.children.length) popInItem(slot.itemGroup.children[slot.count - 1]);
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

  /* 找一个当前没有箱子占用的箱位：箱子被搬走/丢弃后数量不再等于占用情况，按数量取模会叠箱 */
  function freeYardSlot() {
    var used = {};
    for (var i = 0; i < interactables.length; i++) {
      var it = interactables[i];
      if (it.type !== 'box' || !it.mesh) continue;
      for (var j = 0; j < YARD_POSITIONS.length; j++) {
        var p = YARD_POSITIONS[j];
        if (Math.abs(it.mesh.position.x - p.x) < 0.3 && Math.abs(it.mesh.position.z - p.z) < 0.3) { used[j] = 1; break; }
      }
    }
    for (var k = 0; k < YARD_POSITIONS.length; k++) { if (!used[k]) return YARD_POSITIONS[k]; }
    return YARD_POSITIONS[0];
  }

  function spawnBox(pid) {
    var product = G.data.productById(pid);
    if (!product) return null;
    var slotPos = freeYardSlot();

    // 子件用局部坐标（原点=箱心），整箱位置只由 group.position 决定，玩家举箱时才能整体跟随相机
    var group = new THREE.Group();
    group.position.set(slotPos.x, 0.225, slotPos.z);
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), flatMat(0xC08B4E));
    group.add(body);
    var label = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.12), flatMat(CAT_COLORS[product.cat] || 0xFFFFFF));
    label.position.set(-0.226, 0, 0);
    label.rotation.y = -Math.PI / 2;
    group.add(label);
    sceneRef.add(group);

    var box = { mesh: group, body: body, label: label, productId: pid, itemsLeft: product.boxSize };
    registerInteractable(group, { type: 'box', data: { box: box }, prompt: '[E] 搬起纸箱（' + product.name + ' ×' + product.boxSize + '）' });
    return box;
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
    nav: nav,
    serializeShelves: serializeShelves,
    restoreShelves: restoreShelves,
    syncLayout: syncLayout,
    setCashierVisible: setCashierVisible,
    _flights: flights
  };
})();
