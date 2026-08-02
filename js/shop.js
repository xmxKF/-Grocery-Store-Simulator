// shop.js — 订货 / 定价 / 许可证 / 收银员雇佣
(function () {
  'use strict';
  window.G = window.G || {};

  // 待送达箱子队列：{pid, remaining}（remaining 单位秒，下单时按 deliverySec + 序号×0.4 排开）
  var deliveryQueue = [];
  // 卸货区满时的提示节流：一次订货只提示一次，下次成功下单时复位
  var yardFullToasted = false;

  function getMaxBoxesPerOrder() {
    var max = G.data.CONFIG.maxBoxesPerOrder;
    G.data.LEVELS.forEach(function (lv) {
      if (lv.level <= G.state.level && typeof lv.maxBoxesPerOrder === 'number') {
        max = lv.maxBoxesPerOrder;
      }
    });
    return max;
  }

  function countYardBoxes() {
    if (!G.world || !G.world.interactables) return 0;
    var count = 0;
    G.world.interactables.forEach(function (it) {
      if (it.type === 'box') count++;
    });
    return count;
  }

  function isUnlocked(pid) {
    var p = G.data.productById(pid);
    if (!p) return false;
    return G.state.level >= p.unlockLevel && G.state.licenses.indexOf(p.cat) !== -1;
  }

  function orderBoxes(cart) {
    if (!cart || !cart.length) return false;

    for (var i = 0; i < cart.length; i++) {
      if (!isUnlocked(cart[i].pid)) return false;
    }

    var totalBoxes = cart.reduce(function (sum, e) { return sum + e.qty; }, 0);
    if (totalBoxes <= 0) return false;
    if (totalBoxes > getMaxBoxesPerOrder()) return false;

    var yardCount = countYardBoxes();
    if (yardCount + deliveryQueue.length + totalBoxes > G.data.CONFIG.maxBoxesInYard) return false;

    var cost = 0;
    cart.forEach(function (e) {
      var p = G.data.productById(e.pid);
      cost += (p.cost * p.boxSize + G.data.CONFIG.deliveryFeePerBox) * e.qty;
    });
    if (cost > G.state.money) return false;

    G.addMoney(-cost, 'order');

    var idx = 0;
    cart.forEach(function (e) {
      for (var i = 0; i < e.qty; i++) {
        deliveryQueue.push({ pid: e.pid, remaining: G.data.CONFIG.deliverySec + idx * 0.4 });
        idx++;
      }
    });

    yardFullToasted = false;
    return true;
  }

  function update(dt) {
    if (!deliveryQueue.length) return;
    var remaining = [];
    deliveryQueue.forEach(function (entry) {
      entry.remaining -= dt;
      if (entry.remaining <= 0) {
        var box = G.world.spawnBox(entry.pid);
        if (box) {
          G.bus.emit('delivery', { productId: entry.pid });
        } else {
          entry.remaining = 2;   // 卸货区满：2 秒后重试
          if (!yardFullToasted) {
            if (G.ui && G.ui.toast) G.ui.toast('卸货区已满，配送车在门外等待', 'warn');
            yardFullToasted = true;
          }
          remaining.push(entry);
        }
      } else {
        remaining.push(entry);
      }
    });
    deliveryQueue = remaining;
  }

  function setPrice(pid, price) {
    var p = G.data.productById(pid);
    if (!p) return false;
    var clamped = G.clamp(price, 0.1, p.market * 3);
    G.state.prices[pid] = Math.round(clamped * 10) / 10;
    if (G.world && G.world.updateSlotTag) {
      var slots = G.world.slots || [];
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].productId === pid) G.world.updateSlotTag(slots[i]);
      }
    }
    return true;
  }

  function buyLicense(cat) {
    var price = G.data.CONFIG.licensePrice[cat];
    if (typeof price !== 'number') return false;
    if (G.state.licenses.indexOf(cat) !== -1) return false;
    var levelGate = cat === '日用品' ? 2 : cat === '生鲜' ? 3 : 1;
    if (G.state.level < levelGate) return false;
    if (G.state.money < price) return false;

    G.addMoney(-price, 'license');
    G.state.licenses.push(cat);
    G.bus.emit('license', { cat: cat });
    return true;
  }

  /* 区域扩建：卷帘门定义在 world.js（SHUTTERS），价格/等级门槛在此保一份，T5 迁入 CONFIG */
  var ZONE_PRICES = { B: 1500, C: 3200, W: 900 };
  var ZONE_LEVELS = { B: 5, C: 8, W: 3 };

  function buyZone(z) {
    if (!(z in ZONE_PRICES)) return false;
    if (G.state.zones[z]) return false;
    if (G.state.level < ZONE_LEVELS[z]) return false;
    if (G.state.money < ZONE_PRICES[z]) return false;

    G.addMoney(-ZONE_PRICES[z], 'zone');
    G.world.buildZone(z);   // 幂等：自置位 zones[z] + 开门 + 除 collider + 建造该区设施
    G.bus.emit('zone', { zone: z });
    return true;
  }

  function registerState(i) {
    var list = G.state.registers || [];
    return list[i | 0] || null;
  }

  function hireCashier(i) {
    var r = registerState(i);
    if (!r) return false;
    if (G.state.level < 10) return false;
    if (!r.owned) return false;
    if (r.staffed) return false;
    if (G.state.money < G.data.CONFIG.cashierHireCost) return false;

    G.addMoney(-G.data.CONFIG.cashierHireCost, 'cashier_hire');
    r.staffed = true;
    G.bus.emit('cashier', { hired: true, index: i | 0 });
    return true;
  }

  function fireCashier(i) {
    var r = registerState(i);
    if (!r) return;
    r.staffed = false;
    G.bus.emit('cashier', { hired: false, index: i | 0 });
  }

  G.shop = {
    orderBoxes: orderBoxes,
    update: update,
    setPrice: setPrice,
    buyLicense: buyLicense,
    buyZone: buyZone,
    hireCashier: hireCashier,
    fireCashier: fireCashier,
    isUnlocked: isUnlocked
  };
})();
