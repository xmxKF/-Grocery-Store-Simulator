// state.js — 全局事件总线 / 游戏状态 / 存档 / 共享工具
(function () {
  'use strict';
  window.G = window.G || {};

  // ---- 共享工具 ----
  G.fmt = function (n) {
    var s = Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return '¥ ' + s;
  };
  G.rand = function (a, b) {
    return a + Math.random() * (b - a);
  };
  G.randInt = function (a, b) {
    return Math.floor(G.rand(a, b + 1));
  };
  G.clamp = function (v, a, b) {
    return Math.min(b, Math.max(a, v));
  };

  function roundTo1(v) {
    return Math.round(v * 10) / 10;
  }

  // ---- 事件总线 ----
  var handlers = {};
  G.bus = {
    on: function (evt, fn) {
      if (!handlers[evt]) handlers[evt] = [];
      handlers[evt].push(fn);
    },
    off: function (evt, fn) {
      if (!handlers[evt]) return;
      var idx = handlers[evt].indexOf(fn);
      if (idx !== -1) handlers[evt].splice(idx, 1);
    },
    emit: function (evt, payload) {
      if (!handlers[evt]) return;
      handlers[evt].slice().forEach(function (fn) {
        fn(payload);
      });
    }
  };

  // ---- 初始状态 ----
  function initialPrices() {
    var prices = {};
    G.data.PRODUCTS.forEach(function (p) {
      prices[p.id] = roundTo1(p.market * G.data.CONFIG.defaultMarkup);
    });
    return prices;
  }

  G.state = {
    money: G.data.CONFIG.startMoney,
    day: 1,
    xp: 0,
    level: 1,
    prices: initialPrices(),
    licenses: ['食品', '饮料'],
    clock: 0,
    open: false,
    cashier: false,
    negDays: 0,   // 连续日结算余额为负的天数（GDD §8 连续 3 天 → 游戏结束）
    dayStats: { revenue: 0, cogs: 0, customers: 0, itemsSold: 0 }
  };

  // ---- 金钱 / 经验 ----
  G.addMoney = function (delta, reason) {
    G.state.money += delta;
    G.bus.emit('money', { money: G.state.money, delta: delta, reason: reason });
  };

  G.addXP = function (n) {
    G.state.xp = G.clamp(G.state.xp + n, 0, Infinity);
    while (G.state.level < G.data.LEVELS.length && G.state.xp >= G.data.LEVELS[G.state.level].xpNeeded) {
      G.state.level++;
      G.bus.emit('levelup', { level: G.state.level });
    }
    G.bus.emit('xp', { xp: G.state.xp, level: G.state.level });
  };

  // ---- 存档 ----
  var SAVE_KEY = 'gss-save-v1';

  G.save = function () {
    try {
      var data = {
        money: G.state.money,
        day: G.state.day,
        xp: G.state.xp,
        level: G.state.level,
        prices: G.state.prices,
        licenses: G.state.licenses,
        cashier: G.state.cashier,
        negDays: G.state.negDays,
        shelves: (G.world && G.world.serializeShelves) ? G.world.serializeShelves() : null
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      // 忽略存档失败
    }
  };

  G.load = function () {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      G.state.money = data.money;
      G.state.day = data.day;
      G.state.xp = data.xp;
      G.state.level = data.level;
      G.state.prices = data.prices;
      G.state.licenses = data.licenses;
      G.state.cashier = data.cashier;
      G.state.negDays = data.negDays || 0;
      // 先按读回的 level/licenses 补齐货架，再恢复格位内容，否则高等级新增格位的存档会丢失
      if (G.world && G.world.syncLayout) G.world.syncLayout();
      if (G.world && G.world.restoreShelves && data.shelves) {
        G.world.restoreShelves(data.shelves);
      }
      return true;
    } catch (e) {
      return false;
    }
  };

  G.resetSave = function () {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (e) {
      // 忽略
    }
  };
})();
