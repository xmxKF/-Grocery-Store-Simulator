// data.js — 静态数据表（商品目录 / 经济参数 / 等级表）
(function () {
  'use strict';
  window.G = window.G || {};

  // GDD.md §10 商品目录（24 项，原样抄录）
  var PRODUCTS = [
    { id: 'f_noodle',  name: '好味方便面',       cat: '食品',   cost: 1.20, market: 2.20,  boxSize: 24, slotCap: 12, unlockLevel: 1, color: '#E8A33D', shape: 'tub',    accent: '#F2E3C8' },
    { id: 'f_cookie',  name: '麦香饼干',         cat: '食品',   cost: 1.80, market: 3.20,  boxSize: 20, slotCap: 10, unlockLevel: 1, color: '#D9913A', shape: 'carton', accent: '#F6EBD8' },
    { id: 'f_chips',   name: '脆脆薯片',         cat: '食品',   cost: 2.20, market: 4.00,  boxSize: 24, slotCap: 12, unlockLevel: 1, color: '#F0B455', shape: 'bag',    scale: [1, 1.05, 1],       accent: '#FFF0C8' },
    { id: 'f_rice',    name: '金穗大米5kg',      cat: '食品',   cost: 8.00, market: 13.50, boxSize: 8,  slotCap: 4,  unlockLevel: 2, color: '#C8A16B', shape: 'bag',    scale: [1, 0.85, 1],       accent: '#EFE3CE' },
    { id: 'f_choco',   name: '可可脆巧克力',     cat: '食品',   cost: 3.00, market: 5.50,  boxSize: 30, slotCap: 15, unlockLevel: 4, color: '#8A5A2B', shape: 'carton', scale: [0.9, 0.8, 1],      accent: '#5C3A1E' },
    { id: 'f_tuna',    name: '海之鲜金枪鱼罐头', cat: '食品',   cost: 4.50, market: 7.80,  boxSize: 16, slotCap: 8,  unlockLevel: 6, color: '#B0763C', shape: 'can',    scale: [1.15, 0.62, 1.15], accent: '#D8E8F0' },
    { id: 'd_water',   name: '清源矿泉水',       cat: '饮料',   cost: 0.60, market: 1.20,  boxSize: 24, slotCap: 12, unlockLevel: 1, color: '#7EC8F0', shape: 'bottle', accent: '#E8F4FC' },
    { id: 'd_cola',    name: '冰爽可乐',         cat: '饮料',   cost: 1.50, market: 2.80,  boxSize: 24, slotCap: 12, unlockLevel: 1, color: '#3D6FE8', shape: 'can',    accent: '#E8574C' },
    { id: 'd_juice',   name: '果日鲜橙汁',       cat: '饮料',   cost: 2.60, market: 4.60,  boxSize: 12, slotCap: 8,  unlockLevel: 3, color: '#48B0D8', shape: 'carton', scale: [0.85, 1.05, 0.85], accent: '#F0A83D' },
    { id: 'd_tea',     name: '竹叶青茶饮',       cat: '饮料',   cost: 1.80, market: 3.30,  boxSize: 24, slotCap: 12, unlockLevel: 4, color: '#4FA8C4', shape: 'bottle', scale: [0.95, 0.92, 0.95], accent: '#CFE8D8' },
    { id: 'd_coffee',  name: '醒神罐装咖啡',     cat: '饮料',   cost: 3.20, market: 5.80,  boxSize: 24, slotCap: 12, unlockLevel: 5, color: '#2F6FA8', shape: 'can',    scale: [0.9, 0.95, 0.9],   accent: '#8A5A3B' },
    { id: 'd_energy',  name: '雷动能量饮',       cat: '饮料',   cost: 3.80, market: 7.00,  boxSize: 24, slotCap: 12, unlockLevel: 7, color: '#2E5FD0', shape: 'can',    scale: [0.85, 1.1, 0.85],  accent: '#F0D040' },
    { id: 'p_apple',   name: '红运苹果袋装',     cat: '生鲜',   cost: 2.00, market: 3.60,  boxSize: 20, slotCap: 10, unlockLevel: 3, color: '#6FCB6F', shape: 'produce', accent: '#E85C50' },
    { id: 'p_banana',  name: '金弯香蕉',         cat: '生鲜',   cost: 1.60, market: 3.00,  boxSize: 20, slotCap: 10, unlockLevel: 3, color: '#9BD463', shape: 'produce', scale: [1.1, 0.75, 0.9],   accent: '#F0D040' },
    { id: 'p_egg',     name: '农家鲜鸡蛋10枚',   cat: '生鲜',   cost: 3.40, market: 5.80,  boxSize: 12, slotCap: 6,  unlockLevel: 4, color: '#58B87A', shape: 'tray',    accent: '#F2E8D0' },
    { id: 'p_milk',    name: '晨牧鲜牛奶',       cat: '生鲜',   cost: 2.40, market: 4.20,  boxSize: 16, slotCap: 8,  unlockLevel: 5, color: '#7FD1A8', shape: 'carton', scale: [0.95, 1.1, 0.95],  accent: '#FFFFFF' },
    { id: 'p_bread',   name: '暖炉吐司',         cat: '生鲜',   cost: 2.80, market: 5.00,  boxSize: 12, slotCap: 6,  unlockLevel: 6, color: '#4CB963', shape: 'bag',     scale: [1, 0.9, 0.85],     accent: '#F6E3B8' },
    { id: 'p_lettuce', name: '翠田生菜',         cat: '生鲜',   cost: 1.40, market: 2.60,  boxSize: 20, slotCap: 10, unlockLevel: 8, color: '#3FA85A', shape: 'produce', scale: [1.05, 0.9, 1.05],  accent: '#8FD48A' },
    { id: 'h_tissue',  name: '柔云抽纸',         cat: '日用品', cost: 2.20, market: 4.00,  boxSize: 18, slotCap: 9,  unlockLevel: 2, color: '#B79BE8', shape: 'carton', scale: [1.05, 0.7, 1],     accent: '#FFFFFF' },
    { id: 'h_soap',    name: '净手洗手液',       cat: '日用品', cost: 3.00, market: 5.40,  boxSize: 16, slotCap: 8,  unlockLevel: 2, color: '#9B6FE0', shape: 'jug',    accent: '#D8F0E8' },
    { id: 'h_powder',  name: '白洁洗衣粉',       cat: '日用品', cost: 4.20, market: 7.50,  boxSize: 8,  slotCap: 4,  unlockLevel: 5, color: '#8A7FD8', shape: 'bag',    scale: [1, 1, 0.9],        accent: '#E8F0FF' },
    { id: 'h_brush',   name: '皓齿牙刷',         cat: '日用品', cost: 1.80, market: 3.50,  boxSize: 24, slotCap: 12, unlockLevel: 6, color: '#C08CE0', shape: 'carton', scale: [0.45, 1.05, 0.55], accent: '#F0F8FF' },
    { id: 'h_bag',     name: '家家垃圾袋',       cat: '日用品', cost: 2.60, market: 4.80,  boxSize: 20, slotCap: 10, unlockLevel: 7, color: '#7E6BC8', shape: 'tub',    scale: [0.95, 0.8, 0.95],  accent: '#C8D8C8' },
    { id: 'h_battery', name: '恒力电池4节',      cat: '日用品', cost: 3.60, market: 6.60,  boxSize: 24, slotCap: 12, unlockLevel: 9, color: '#6F5FB8', shape: 'carton', scale: [0.7, 0.62, 0.75],  accent: '#F0C040' }
  ];

  function productById(id) {
    for (var i = 0; i < PRODUCTS.length; i++) {
      if (PRODUCTS[i].id === id) return PRODUCTS[i];
    }
    return null;
  }

  // GDD.md §11 经济数值（原样抄录，键名按注释语义命名）
  var CONFIG = {
    startMoney: 800,
    dayLengthSec: 300,
    deliverySec: 25,
    deliveryFeePerBox: 3,
    maxBoxesPerOrder: 8,       // Lv9 起 12（见 G.data.LEVELS）
    maxBoxesInYard: 12,
    rentPerDay: 40,            // Lv8 扩建后 80（见 G.data.LEVELS）
    utilPerShelf: 2,
    utilPerFridge: 4,
    cashierHireCost: 200,
    cashierWage: 60,
    spawnIntervalBase: 20,
    patienceSec: 60,
    shopTimeoutSec: 45,
    scanCooldown: 0.3,
    stockCooldown: 0.25,
    walkSpeed: 3.2,            // 玩家
    sprintSpeed: 5.0,          // Shift 冲刺
    carrySpeedMult: 0.8,       // 举箱时移速倍率
    customerSpeed: 1.6,
    interactRange: 3.0,
    defaultMarkup: 1.20,
    licensePrice: { '日用品': 120, '生鲜': 350 }, // 食品/饮料开局赠送
    bankruptDays: 3
  };

  // GDD.md §9 等级表（xpNeeded 为累计值），附加机器可读字段供 world.js / shop.js 使用
  var LEVELS = [
    { level: 1,  xpNeeded: 0,    shelfGroups: 4, unlock: '开局持有【食品】【饮料】许可证；4 组货架（24 格）' },
    { level: 2,  xpNeeded: 60,   unlock: '可购买【日用品】许可证（¥120）；金穗大米' },
    { level: 3,  xpNeeded: 160,  shelfGroups: 5, unlock: '+1 组货架（30 格）；可购买【生鲜】许可证（¥350，附赠 2 台冷藏柜）；橙汁 / 苹果 / 香蕉' },
    { level: 4,  xpNeeded: 320,  unlock: '巧克力 / 茶饮 / 鸡蛋' },
    { level: 5,  xpNeeded: 550,  unlock: '咖啡 / 牛奶 / 洗衣粉' },
    { level: 6,  xpNeeded: 850,  shelfGroups: 6, unlock: '+1 组货架（36 格）；金枪鱼罐头 / 吐司 / 牙刷' },
    { level: 7,  xpNeeded: 1250, unlock: '能量饮 / 垃圾袋' },
    { level: 8,  xpNeeded: 1750, shelfGroups: 8, expansion: true, unlock: '店铺扩建：+2 组货架（48 格），房租 ¥40→¥80，同屏顾客上限 +2' },
    { level: 9,  xpNeeded: 2400, maxBoxesPerOrder: 12, unlock: '电池；单次订货上限 8→12 箱' },
    { level: 10, xpNeeded: 3200, cashierAvailable: true, unlock: '可雇佣收银员（一次性 ¥200 + ¥60/天）' }
  ];

  G.data = {
    PRODUCTS: PRODUCTS,
    CONFIG: CONFIG,
    LEVELS: LEVELS,
    productById: productById
  };
})();
