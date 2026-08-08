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
  /* 开发者测试入口 ?dev=1（CONTRACTS §开发者入口）：整套存档读写切到独立键 gss-save-dev，
     真实存档键（v2 / v1）一个字节都不碰——测试档若与真实档同键，开发模式下随便打烊一次
     就会把玩家进度覆写掉。dev 模式还必须【不回落 v1】：一次回落就会把玩家的旧档迁移掉。
     与 ?selftest 同时出现时 selftest 优先、dev 被忽略：自测断言按默认开局状态写死
     （boot.state 等），预置全开状态会让它们整片变红。 */
  var SAVE_KEY_V2 = 'gss-save-v2';
  var SAVE_KEY_V1 = 'gss-save-v1';
  var SAVE_KEY_DEV = 'gss-save-dev';

  function devFromSearch(search) {
    var s = String(search || '');
    return s.indexOf('dev=1') !== -1 && s.indexOf('selftest') === -1;
  }

  var DEV = devFromSearch(location.search);
  var SAVE_KEY = DEV ? SAVE_KEY_DEV : SAVE_KEY_V2;
  G.DEV = DEV;

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
        // boxes 是全部箱实体（仓库位/卸货区/店内地面/玩家手上）的单一真相，取代只存仓库位的
        // storage；旧 v2 档没有 boxes 字段，load 会回落到 restoreStorage
        boxes: (G.world && G.world.serializeBoxes) ? G.world.serializeBoxes() : [],
        deliveries: (G.shop && G.shop.serializeDeliveries) ? G.shop.serializeDeliveries() : []
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
        if (DEV) return false;   // dev 模式绝不回落 v1：读一次就会把玩家的旧档迁移掉
        var v1raw = localStorage.getItem(SAVE_KEY_V1);
        if (!v1raw) return false;
        data = migrateV1(JSON.parse(v1raw));
        migrated = data._refund;
      }
      // 至此 parse/migrate 已成功。以下的字段赋值一律在此行之后：坏档在 parse/migrate 阶段
      // 失败时 G.state 一字未改。注意这个性质只覆盖到 parse/migrate——下面的 buildZone /
      // restoreShelves / restoreBoxes / updateSlotTag / G.save 若抛异常，G.state 已是全量新档，
      // 此时返回 false 会让玩家留在菜单却带着新档状态（见本函数末尾的世界重建 try 分段）
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
      /* 世界重建段单独兜异常：此刻 G.state 已是全量新档，再返回 false 只会让玩家留在菜单
         却带着新档状态（点「新游戏」就带半截状态开局）。这里只提示、不改返回值 */
      try {
        // 顺序硬约束：先建区（W 的 storageSlots / B·C 的 R2R3 与货架）再恢复格位内容，
        // restoreShelves/restoreBoxes 靠 id 匹配已存在的格位，早一步就静默丢数据
        if (G.world && G.world.syncLayout) {
          if (G.state.zones.W && G.world.buildZone) G.world.buildZone('W');
          if (G.state.zones.B && G.world.buildZone) G.world.buildZone('B');
          if (G.state.zones.C && G.world.buildZone) G.world.buildZone('C');
          G.world.syncLayout();
        }
        // owned 以世界实际建造为准（buildZone→buildRegister 会置位），杜绝坏档里的「有台无区」；
        // staffed 必须一并清掉，否则坏档「有员工无台」每天扣 ¥60、收银员不可见，
        // 而解雇按钮只为 owned 的台出行，玩家无法自救
        if (G.world && G.world.registers) {
          for (var i = 0; i < G.state.registers.length; i++) {
            var built = false;
            for (var j = 0; j < G.world.registers.length; j++) {
              if (G.world.registers[j].index === i) built = true;
            }
            if (!built) { G.state.registers[i].owned = false; G.state.registers[i].staffed = false; }
          }
        }
        if (G.world && G.world.restoreShelves && data.shelves) G.world.restoreShelves(data.shelves);
        // 箱实体：起手清场（销毁现有全部箱）再按序重建，杜绝重复箱与一箱两位。
        // 旧 v2 档只有 storage 字段：清完场回落到仓库位恢复（地面/院内/手上的箱本就没存过）
        if (G.world && G.world.restoreBoxes) {
          G.world.restoreBoxes(Array.isArray(data.boxes) ? data.boxes : null);
          if (!Array.isArray(data.boxes) && G.world.restoreStorage && data.storage) {
            G.world.restoreStorage(data.storage);
          }
        }
        if (G.shop && G.shop.restoreDeliveries) G.shop.restoreDeliveries(data.deliveries);
        // prices 刚被 sanePrices 整体换过，而 shelves 可能整个缺席（v1 迁移档的 shelves 恒为 null）
        // 或只覆盖部分格位——价签必须无条件全量重刷，否则未刷到的格位仍指着旧价的共享贴图
        if (G.world && G.world.updateSlotTag) {
          var rslots = G.world.slots || [];
          for (var ri = 0; ri < rslots.length; ri++) G.world.updateSlotTag(rslots[ri]);
        }
      } catch (we) {
        if (G.ui && G.ui.toast) G.ui.toast('存档世界重建出错，部分内容可能缺失', 'danger');
      }
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
      if (!DEV) localStorage.removeItem(SAVE_KEY_V1);   // dev 模式一个真实键都不碰
    } catch (e) {
      // 忽略
    }
  };

  /* 自测钩子：dev 模式在模块初始化时按 URL 定死，而自测页永远不是 dev 模式（selftest 优先），
     故断言「dev 模式不写真实存档键」只能靠这个钩子切换存档键归属。仅 ?selftest 使用。 */
  G._test = {
    devFromSearch: devFromSearch,
    setDevMode: function (on) {
      DEV = !!on;
      SAVE_KEY = DEV ? SAVE_KEY_DEV : SAVE_KEY_V2;
    },
    saveKey: function () { return SAVE_KEY; }
  };
})();
