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
    // owned = 该台已建造（world.buildRegister 置位）；staffed = 已雇收银员
    registers: [{ owned: false, staffed: false }, { owned: false, staffed: false }, { owned: false, staffed: false }],
    zones: { A: true, B: false, C: false, W: false },
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
  var SAVE_KEY = 'gss-save-v2';
  var SAVE_KEY_V1 = 'gss-save-v1';

  G.save = function () {
    try {
      var data = {
        v: 2,
        money: G.state.money,
        day: G.state.day,
        xp: G.state.xp,
        level: G.state.level,
        prices: G.state.prices,
        licenses: G.state.licenses,
        negDays: G.state.negDays,
        zones: G.state.zones,
        registers: G.state.registers,
        shelves: (G.world && G.world.serializeShelves) ? G.world.serializeShelves() : null,
        storage: (G.world && G.world.serializeStorage) ? G.world.serializeStorage() : []
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      // 忽略存档失败
    }
  };

  /* 字段级降级：坏字段回默认，绝不因单个字段丢掉整档 */
  function sanePrices(raw) {
    var prices = initialPrices();
    if (!raw || typeof raw !== 'object') return prices;
    G.data.PRODUCTS.forEach(function (p) {
      var v = raw[p.id];
      if (typeof v === 'number' && isFinite(v) && v > 0) prices[p.id] = v;
    });
    return prices;
  }

  function saneLicenses(raw) {
    var out = ['食品', '饮料'];   // 开局赠送，保底
    if (!Array.isArray(raw)) return out;
    raw.forEach(function (cat) {
      if (out.indexOf(cat) === -1 && typeof G.data.CONFIG.licensePrice[cat] === 'number') out.push(cat);
    });
    return out;
  }

  function saneRegisters(raw) {
    var out = [{ owned: false, staffed: false }, { owned: false, staffed: false }, { owned: false, staffed: false }];
    if (Array.isArray(raw)) {
      for (var i = 0; i < out.length && i < raw.length; i++) {
        var r = raw[i];
        if (!r || typeof r !== 'object') continue;
        out[i].owned = !!r.owned;
        out[i].staffed = !!r.staffed;
      }
    }
    out[0].owned = true;   // R1 随开局建造，恒存在
    return out;
  }

  /* v1 → v2：货架不继承（新布局重建），库存按进价全额折现入余额 */
  function migrateV1(v1) {
    var refund = 0;
    if (Array.isArray(v1.shelves)) {
      v1.shelves.forEach(function (s) {
        var p = s && s.productId ? G.data.productById(s.productId) : null;
        if (p && s.count > 0) refund += s.count * p.cost;
      });
    }
    refund = Math.round(refund * 10) / 10;   // MIGRATION_REFUND_RATE = 1.0（全额按进价）
    return {
      v: 2, money: (v1.money || 0) + refund, day: v1.day, xp: v1.xp, level: v1.level,
      prices: v1.prices, licenses: v1.licenses, negDays: v1.negDays,
      zones: { A: true, B: false, C: false, W: false },
      registers: [{ owned: true, staffed: !!v1.cashier }, { owned: false, staffed: false }, { owned: false, staffed: false }],
      shelves: null, storage: [], _refund: refund
    };
  }

  G.load = function () {
    try {
      var data = null, migrated = null;
      try {
        var raw = localStorage.getItem(SAVE_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        // 更高版本的档按不可读处理：宁可回落 v1 / 报损坏，也不按 v2 语义误读
        if (parsed && typeof parsed === 'object' && !(parsed.v > 2)) data = parsed;
      } catch (e) {
        data = null;   // v2 损坏不得吞掉玩家的 v1：落到下面的迁移路径
      }
      if (!data) {
        var v1raw = localStorage.getItem(SAVE_KEY_V1);
        if (!v1raw) return false;
        data = migrateV1(JSON.parse(v1raw));
        migrated = data._refund;
      }
      // 至此 parse/migrate 已成功；任何 G.state 赋值都不得早于这一行，否则坏档会把状态改成半截
      G.state.money = (typeof data.money === 'number') ? data.money : G.data.CONFIG.startMoney;
      G.state.day = (typeof data.day === 'number') ? data.day : 1;
      G.state.xp = (typeof data.xp === 'number') ? data.xp : 0;
      G.state.level = G.clamp((typeof data.level === 'number') ? data.level : 1, 1, 10);
      G.state.prices = sanePrices(data.prices);
      G.state.licenses = saneLicenses(data.licenses);
      G.state.negDays = (typeof data.negDays === 'number') ? data.negDays : 0;
      G.state.zones = data.zones && typeof data.zones === 'object'
        ? { A: true, B: !!data.zones.B, C: !!data.zones.C, W: !!data.zones.W }
        : { A: true, B: false, C: false, W: false };
      G.state.registers = saneRegisters(data.registers);
      if (migrated != null) G.state._migrated = { refund: migrated };
      // 顺序硬约束：先建区（W 的 storageSlots / B·C 的 R2R3 与货架）再恢复格位内容，
      // restoreShelves/restoreStorage 靠 id 匹配已存在的格位，早一步就静默丢数据
      if (G.world && G.world.syncLayout) {
        if (G.state.zones.W && G.world.buildZone) G.world.buildZone('W');
        if (G.state.zones.B && G.world.buildZone) G.world.buildZone('B');
        if (G.state.zones.C && G.world.buildZone) G.world.buildZone('C');
        G.world.syncLayout();
      }
      // owned 以世界实际建造为准（buildZone→buildRegister 会置位），杜绝坏档里的「有台无区」
      if (G.world && G.world.registers) {
        for (var i = 0; i < G.state.registers.length; i++) {
          var built = false;
          for (var j = 0; j < G.world.registers.length; j++) {
            if (G.world.registers[j].index === i) built = true;
          }
          if (!built) G.state.registers[i].owned = false;
        }
      }
      if (G.world && G.world.restoreShelves && data.shelves) G.world.restoreShelves(data.shelves);
      if (G.world && G.world.restoreStorage && data.storage) G.world.restoreStorage(data.storage);
      // prices 刚被 sanePrices 整体换过，而 shelves 可能整个缺席（v1 迁移档的 shelves 恒为 null）
      // 或只覆盖部分格位——价签必须无条件全量重刷，否则未刷到的格位仍指着旧价的共享贴图
      if (G.world && G.world.updateSlotTag) {
        var rslots = G.world.slots || [];
        for (var ri = 0; ri < rslots.length; ri++) G.world.updateSlotTag(rslots[ri]);
      }
      // prices 刚被 sanePrices 整体换过，而 shelves 可能整个缺席（v1 迁移档的 shelves 恒为 null）
      // 或只覆盖部分格位——价签必须无条件全量重刷，否则未刷到的格位仍指着旧价的共享贴图
      // spec §7「首次 save 写 v2」：立刻落盘，否则玩家在首个日结前退出会被重复迁移，期间消费全丢
      if (migrated != null) G.save();
      return true;
    } catch (e) {
      return false;
    }
  };

  G.resetSave = function () {
    try {
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem(SAVE_KEY_V1);
    } catch (e) {
      // 忽略
    }
  };
})();
