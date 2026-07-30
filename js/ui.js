/* js/ui.js — 主菜单 / 仓储电脑（订货·定价·许可证）/ 日结算 / HUD / 提示 / Toast
   归属：ui agent。DOM 只用 CONTRACTS.md §共享 CSS 类名 列出的类；HUD 与其它自有部件
   一律用固定 DOM id + 标签/属性选择器 + 行内样式，不新增 class。 */
(function () {
  'use strict';

  var G = (window.G = window.G || {});

  /* DESIGN §1.2 类目色（data.js 未导出此表，本模块自持，world.js 亦是如此） */
  var CAT_COLORS = {
    '食品': '#E8A33D',
    '饮料': '#3D8FE8',
    '生鲜': '#4CB963',
    '日用品': '#9B6FE0'
  };

  /* 许可证等级门槛 / 顺序（与 shop.js buyLicense 内部一致，供展示用） */
  var LICENSE_ORDER = ['食品', '饮料', '生鲜', '日用品'];
  var LICENSE_GATE = { '食品': 1, '饮料': 1, '生鲜': 3, '日用品': 2 };

  var HELP_ROWS = [
    ['点击画面', '进入指针锁定（Pointer Lock）'],
    ['WASD', '移动；Shift 冲刺'],
    ['鼠标', '视角'],
    ['E / 左键', '交互：捡箱 / 上架 1 件 / 开电脑 / 进收银台 / 丢箱 / 扫码'],
    ['Q', '放下手中箱子到脚下'],
    ['Tab', '打开/关闭仓储电脑界面'],
    ['O', '开门营业 / 提前打烊'],
    ['Esc', '关闭当前界面 / 退出收银台 / 释放指针锁定']
  ];

  var SAVE_KEY = 'gss-save-v1'; // CONTRACTS.md 固定存档 key，仅用于「继续」按钮可用性判断

  /* ---------- 模块状态 ---------- */
  var screens = {};      // name -> #screen-* 元素
  var current = null;    // 当前打开的 screen 名
  var cart = {};         // 订货购物车：pid -> 箱数，跨刷新保留
  var activeTab = 'order';
  var toastQueue = [];
  var hoverPrompt = null;   // 最近一次 hover 交互提示
  var shownPrompt = null;   // #prompt 当前显示的文案
  var inPrep = false;       // 备货阶段（dayStart 起，按 O 开门后结束）

  var continueBtn = null;
  var summaryPanel = null;
  var orderBody = null, priceBody = null, licenseBody = null;
  var tabButtons = null;

  var moneyValEl, levelValEl, xpFillEl, hudDayEl, hudClockEl, promptEl, crosshairEl, toastEl;

  /* ---------- 小工具 ---------- */
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hasSave() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  function getMaxBoxesPerOrder() {
    var max = G.data.CONFIG.maxBoxesPerOrder;
    G.data.LEVELS.forEach(function (lv) {
      if (lv.level <= G.state.level && typeof lv.maxBoxesPerOrder === 'number') max = lv.maxBoxesPerOrder;
    });
    return max;
  }

  function cartTotalQty() {
    var sum = 0;
    Object.keys(cart).forEach(function (pid) { sum += cart[pid]; });
    return sum;
  }

  /* 卸货区（含已搬进店里的）现存箱数，与 shop.js 的上限判定口径一致 */
  function yardBoxCount() {
    var list = (G.world && G.world.interactables) || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) { if (list[i].type === 'box') n++; }
    return n;
  }

  /* ---------------------------------------------------------------
     #screen-menu
  --------------------------------------------------------------- */
  function buildMenu() {
    var screenEl = document.getElementById('screen-menu');
    screenEl.className = 'screen';
    var panel = el('div', 'panel');
    screenEl.appendChild(panel);
    screens.menu = screenEl;

    var title = el('div', 'panel-title', '小店经营者');
    title.style.fontSize = '32px';
    title.style.textAlign = 'center';
    panel.appendChild(title);

    var btnRow = el('div');
    btnRow.style.display = 'flex';
    btnRow.style.flexDirection = 'column';
    btnRow.style.gap = '12px';
    btnRow.style.maxWidth = '260px';
    btnRow.style.margin = '24px auto';

    var newBtn = el('button', 'btn btn-primary', '新游戏');
    newBtn.addEventListener('click', function () {
      G.bus.emit('newGame', {});
    });
    btnRow.appendChild(newBtn);

    continueBtn = el('button', 'btn btn-secondary', '继续');
    continueBtn.addEventListener('click', function () {
      if (continueBtn.hasAttribute('disabled')) return;
      G.load();
      G.bus.emit('continueGame', {});
      showScreen(null);
    });
    btnRow.appendChild(continueBtn);
    panel.appendChild(btnRow);

    var details = document.createElement('details');
    details.style.marginTop = '8px';
    var summaryEl = document.createElement('summary');
    summaryEl.textContent = '操作说明';
    summaryEl.style.cursor = 'pointer';
    summaryEl.style.color = 'var(--accent-2)';
    summaryEl.style.fontSize = '14px';
    details.appendChild(summaryEl);

    var table = document.createElement('table');
    table.style.width = '100%';
    table.style.marginTop = '12px';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '14px';
    HELP_ROWS.forEach(function (row) {
      var tr = document.createElement('tr');
      var tdKey = document.createElement('td');
      tdKey.style.padding = '6px 8px';
      tdKey.style.whiteSpace = 'nowrap';
      var kbdEl = document.createElement('kbd');
      kbdEl.textContent = row[0];
      tdKey.appendChild(kbdEl);
      var tdVal = document.createElement('td');
      tdVal.style.padding = '6px 8px';
      tdVal.style.color = 'var(--text-dim)';
      tdVal.textContent = row[1];
      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      table.appendChild(tr);
    });
    details.appendChild(table);
    panel.appendChild(details);

    updateContinueState();
  }

  function updateContinueState() {
    if (!continueBtn) return;
    if (hasSave()) continueBtn.removeAttribute('disabled');
    else continueBtn.setAttribute('disabled', 'disabled');
  }

  /* ---------------------------------------------------------------
     #screen-computer — 订货 / 定价 / 许可证
  --------------------------------------------------------------- */
  function buildComputer() {
    var screenEl = document.getElementById('screen-computer');
    screenEl.className = 'screen';
    var panel = el('div', 'panel');
    screenEl.appendChild(panel);
    screens.computer = screenEl;

    panel.appendChild(el('div', 'panel-title', '仓储电脑'));

    var tabs = el('div', 'tabs');
    var tabOrderBtn = el('button', 'tab', '订货');
    var tabPriceBtn = el('button', 'tab', '定价');
    var tabLicenseBtn = el('button', 'tab', '许可证');
    tabs.appendChild(tabOrderBtn);
    tabs.appendChild(tabPriceBtn);
    tabs.appendChild(tabLicenseBtn);
    panel.appendChild(tabs);
    tabButtons = { order: tabOrderBtn, price: tabPriceBtn, license: tabLicenseBtn };

    orderBody = el('div');
    priceBody = el('div');
    licenseBody = el('div');
    priceBody.style.display = 'none';
    licenseBody.style.display = 'none';
    panel.appendChild(orderBody);
    panel.appendChild(priceBody);
    panel.appendChild(licenseBody);

    tabOrderBtn.addEventListener('click', function () { setActiveTab('order'); });
    tabPriceBtn.addEventListener('click', function () { setActiveTab('price'); });
    tabLicenseBtn.addEventListener('click', function () { setActiveTab('license'); });

    setActiveTab('order');
  }

  function setActiveTab(tab) {
    activeTab = tab;
    tabButtons.order.className = 'tab' + (tab === 'order' ? ' active' : '');
    tabButtons.price.className = 'tab' + (tab === 'price' ? ' active' : '');
    tabButtons.license.className = 'tab' + (tab === 'license' ? ' active' : '');
    orderBody.style.display = tab === 'order' ? 'flex' : 'none';
    priceBody.style.display = tab === 'price' ? 'block' : 'none';
    licenseBody.style.display = tab === 'license' ? 'block' : 'none';
    renderActiveTab();
  }

  function renderActiveTab() {
    if (activeTab === 'order') renderOrderTab();
    else if (activeTab === 'price') renderPriceTab();
    else renderLicenseTab();
  }

  function refreshComputerIfOpen() {
    if (current === 'computer') renderActiveTab();
  }

  /* ---- 订货 ---- */
  function renderOrderTab() {
    orderBody.innerHTML = '';
    orderBody.style.display = 'flex';
    orderBody.style.gap = '24px';
    orderBody.style.alignItems = 'flex-start';

    var maxBoxes = getMaxBoxesPerOrder();
    var totalQty = cartTotalQty();

    var listWrap = el('div', 'list');
    listWrap.style.flex = '1';
    listWrap.style.minWidth = '0';

    G.data.PRODUCTS.forEach(function (p) {
      var row = el('div', 'list-row');
      var dot = el('span', 'cat-dot');
      dot.style.background = p.color;
      row.appendChild(dot);

      var name = el('span', null, p.name);
      name.style.flex = '1 1 auto';
      name.style.minWidth = '0';
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.style.whiteSpace = 'nowrap';
      row.appendChild(name);

      var costEl = el('span', 'text-dim', '进价 ' + G.fmt(p.cost));
      costEl.style.flex = 'none';
      costEl.style.width = '92px';
      row.appendChild(costEl);

      var boxPrice = p.cost * p.boxSize + G.data.CONFIG.deliveryFeePerBox;
      var boxEl = el('span', 'text-dim', '箱价 ' + G.fmt(boxPrice));
      boxEl.style.flex = 'none';
      boxEl.style.width = '100px';
      row.appendChild(boxEl);

      var perBoxEl = el('span', 'text-dim', p.boxSize + ' 件/箱');
      perBoxEl.style.flex = 'none';
      perBoxEl.style.width = '64px';
      row.appendChild(perBoxEl);

      var stockEl = el('span', 'text-dim', '库存 ' + G.world.getStockCount(p.id));
      stockEl.style.flex = 'none';
      stockEl.style.width = '64px';
      row.appendChild(stockEl);

      if (!G.shop.isUnlocked(p.id)) {
        var reason = G.state.level < p.unlockLevel ? ('需 Lv ' + p.unlockLevel) : '需许可证';
        var badge = el('span', 'badge badge-warn', reason);
        badge.style.marginLeft = 'auto';
        row.appendChild(badge);
      } else {
        var controls = el('div');
        controls.style.marginLeft = 'auto';
        controls.style.display = 'flex';
        controls.style.alignItems = 'center';
        controls.style.gap = '6px';

        var qty = cart[p.id] || 0;
        var minusBtn = el('button', 'step-btn', '−');
        if (qty <= 0) minusBtn.setAttribute('disabled', 'disabled');
        minusBtn.addEventListener('click', function () {
          if ((cart[p.id] || 0) > 0) {
            cart[p.id] -= 1;
            if (cart[p.id] <= 0) delete cart[p.id];
            renderOrderTab();
          }
        });
        controls.appendChild(minusBtn);

        var qtyEl = el('span', null, String(qty));
        qtyEl.style.display = 'inline-block';
        qtyEl.style.width = '20px';
        qtyEl.style.textAlign = 'center';
        controls.appendChild(qtyEl);

        var plusBtn = el('button', 'step-btn', '+');
        if (totalQty >= maxBoxes) plusBtn.setAttribute('disabled', 'disabled');
        plusBtn.addEventListener('click', function () {
          if (cartTotalQty() < getMaxBoxesPerOrder()) {
            cart[p.id] = (cart[p.id] || 0) + 1;
            renderOrderTab();
          }
        });
        controls.appendChild(plusBtn);

        row.appendChild(controls);
      }

      listWrap.appendChild(row);
    });

    orderBody.appendChild(listWrap);
    orderBody.appendChild(buildCartBox(maxBoxes, totalQty));
  }

  function buildCartBox(maxBoxes, totalQty) {
    var box = el('div');
    box.style.flex = 'none';
    box.style.width = '260px';
    box.style.background = 'var(--panel-2)';
    box.style.border = '1px solid var(--line)';
    box.style.borderRadius = '8px';
    box.style.padding = '16px';

    var title = el('div', null, '购物车');
    title.style.fontSize = '14px';
    title.style.fontWeight = '600';
    title.style.marginBottom = '12px';
    box.appendChild(title);

    var pids = Object.keys(cart).filter(function (pid) { return cart[pid] > 0; });
    var list = el('div', 'list');
    var totalCost = 0;
    if (!pids.length) {
      list.appendChild(el('div', 'text-dim', '购物车为空'));
    } else {
      pids.forEach(function (pid) {
        var p = G.data.productById(pid);
        var qty = cart[pid];
        var lineCost = (p.cost * p.boxSize + G.data.CONFIG.deliveryFeePerBox) * qty;
        totalCost += lineCost;
        var row = el('div', 'list-row');
        row.style.height = 'auto';
        row.style.padding = '6px 0';
        var name = el('span', null, p.name + ' ×' + qty);
        name.style.flex = '1';
        row.appendChild(name);
        row.appendChild(el('span', null, G.fmt(lineCost)));
        list.appendChild(row);
      });
    }
    box.appendChild(list);

    var totalLine = el('div');
    totalLine.style.display = 'flex';
    totalLine.style.justifyContent = 'space-between';
    totalLine.style.margin = '12px 0';
    totalLine.style.fontSize = '14px';
    totalLine.appendChild(el('span', 'text-dim', totalQty + ' / ' + maxBoxes + ' 箱'));
    totalLine.appendChild(el('span', null, G.fmt(totalCost)));
    box.appendChild(totalLine);

    var afford = totalCost <= G.state.money;
    var yardFull = yardBoxCount() + totalQty > G.data.CONFIG.maxBoxesInYard;   // GDD §3
    var confirmBtn = el('button', 'btn btn-primary', '确认下单');
    confirmBtn.style.width = '100%';
    if (!pids.length || !afford || yardFull) confirmBtn.setAttribute('disabled', 'disabled');
    confirmBtn.addEventListener('click', confirmOrder);
    box.appendChild(confirmBtn);

    if (pids.length && (!afford || yardFull)) {
      var reasonEl = el('div', 'text-danger', yardFull ? '卸货区已满' : '余额不足');
      reasonEl.style.marginTop = '8px';
      reasonEl.style.fontSize = '12px';
      box.appendChild(reasonEl);
    }

    return box;
  }

  function confirmOrder() {
    var entries = Object.keys(cart).filter(function (pid) { return cart[pid] > 0; })
      .map(function (pid) { return { pid: pid, qty: cart[pid] }; });
    if (!entries.length) return;
    var ok = G.shop.orderBoxes(entries);
    if (ok) {
      cart = {};
      toast('下单成功', 'ok');
    } else {
      toast('下单失败：卸货区已满或条件不满足', 'danger');
    }
    if (activeTab === 'order') renderOrderTab();
  }

  /* ---- 定价 ---- */
  function renderPriceTab() {
    priceBody.innerHTML = '';
    var list = el('div', 'list');

    G.data.PRODUCTS.forEach(function (p) {
      var row = el('div', 'list-row');
      var dot = el('span', 'cat-dot');
      dot.style.background = p.color;
      row.appendChild(dot);

      var name = el('span', null, p.name);
      name.style.flex = '1 1 auto';
      name.style.minWidth = '0';
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.style.whiteSpace = 'nowrap';
      row.appendChild(name);

      var marketEl = el('span', 'text-dim', '市场价 ' + G.fmt(p.market));
      marketEl.style.flex = 'none';
      marketEl.style.width = '110px';
      row.appendChild(marketEl);

      if (!G.shop.isUnlocked(p.id)) {
        var reason = G.state.level < p.unlockLevel ? ('需 Lv ' + p.unlockLevel) : '需许可证';
        var lockBadge = el('span', 'badge badge-warn', reason);
        lockBadge.style.marginLeft = 'auto';
        row.appendChild(lockBadge);
        list.appendChild(row);
        return;
      }

      var price = G.state.prices[p.id];

      var group = el('div');
      group.style.marginLeft = 'auto';
      group.style.display = 'flex';
      group.style.alignItems = 'center';
      group.style.gap = '6px';

      var minusBtn = el('button', 'step-btn', '−');
      if (price <= 0.1 + 1e-9) minusBtn.setAttribute('disabled', 'disabled');
      minusBtn.addEventListener('click', function () {
        G.shop.setPrice(p.id, G.state.prices[p.id] - 0.1);
        renderPriceTab();
      });
      group.appendChild(minusBtn);

      var input = el('input', 'num-input');
      input.type = 'number';
      input.step = '0.1';
      input.min = '0.1';
      input.max = String(p.market * 3);
      input.value = price.toFixed(1);
      input.addEventListener('change', function () {
        var v = parseFloat(input.value);
        if (isNaN(v)) v = price;
        G.shop.setPrice(p.id, v);
        renderPriceTab();
      });
      group.appendChild(input);

      var plusBtn = el('button', 'step-btn', '+');
      if (price >= p.market * 3 - 1e-9) plusBtn.setAttribute('disabled', 'disabled');
      plusBtn.addEventListener('click', function () {
        G.shop.setPrice(p.id, G.state.prices[p.id] + 0.1);
        renderPriceTab();
      });
      group.appendChild(plusBtn);

      row.appendChild(group);

      var ratio = price / p.market;
      var badgeCls = ratio <= 1.10 ? 'badge-ok' : (ratio <= 1.40 ? 'badge-warn' : 'badge-danger');
      var ratioBadge = el('span', 'badge ' + badgeCls, '×' + ratio.toFixed(2));
      ratioBadge.style.marginLeft = '8px';
      row.appendChild(ratioBadge);

      list.appendChild(row);
    });

    priceBody.appendChild(list);
  }

  /* ---- 许可证 ---- */
  function renderLicenseTab() {
    licenseBody.innerHTML = '';
    var list = el('div', 'list');

    LICENSE_ORDER.forEach(function (cat) {
      var row = el('div', 'list-row');
      var dot = el('span', 'cat-dot');
      dot.style.background = CAT_COLORS[cat];
      row.appendChild(dot);

      var name = el('span', null, cat);
      name.style.flex = '1';
      row.appendChild(name);

      var held = G.state.licenses.indexOf(cat) !== -1;
      if (held) {
        var okBadge = el('span', 'badge badge-ok', '已持有');
        okBadge.style.marginLeft = 'auto';
        row.appendChild(okBadge);
      } else {
        var gate = LICENSE_GATE[cat];
        var price = G.data.CONFIG.licensePrice[cat];
        if (G.state.level < gate) {
          var lockBadge = el('span', 'badge badge-warn', '需 Lv ' + gate);
          lockBadge.style.marginLeft = 'auto';
          row.appendChild(lockBadge);
        } else {
          var buyBtn = el('button', 'btn btn-primary', '购买 ' + G.fmt(price));
          buyBtn.style.marginLeft = 'auto';
          if (G.state.money < price) {
            buyBtn.setAttribute('disabled', 'disabled');
            buyBtn.title = '余额不足';
          }
          buyBtn.addEventListener('click', function () {
            if (G.shop.buyLicense(cat)) {
              toast('已购买【' + cat + '】许可证', 'ok');
              renderLicenseTab();
            }
          });
          row.appendChild(buyBtn);
        }
      }
      list.appendChild(row);
    });

    if (G.state.level >= 10) {
      var cRow = el('div', 'list-row');
      var cDot = el('span', 'cat-dot');
      cDot.style.background = 'var(--text-dim)';
      cRow.appendChild(cDot);
      var cName = el('span', null, '收银员');
      cName.style.flex = '1';
      cRow.appendChild(cName);

      if (G.state.cashier) {
        var fireBtn = el('button', 'btn btn-danger', '解雇');
        fireBtn.style.marginLeft = 'auto';
        fireBtn.addEventListener('click', function () {
          G.shop.fireCashier();
          renderLicenseTab();
        });
        cRow.appendChild(fireBtn);
      } else {
        var hireBtn = el('button', 'btn btn-primary',
          '雇佣 ' + G.fmt(G.data.CONFIG.cashierHireCost) + ' + ' + G.fmt(G.data.CONFIG.cashierWage) + '/天');
        hireBtn.style.marginLeft = 'auto';
        if (G.state.money < G.data.CONFIG.cashierHireCost) {
          hireBtn.setAttribute('disabled', 'disabled');
          hireBtn.title = '余额不足';
        }
        hireBtn.addEventListener('click', function () {
          if (G.shop.hireCashier()) {
            toast('已雇佣收银员', 'ok');
            renderLicenseTab();
          }
        });
        cRow.appendChild(hireBtn);
      }
      list.appendChild(cRow);
    }

    licenseBody.appendChild(list);
  }

  /* ---------------------------------------------------------------
     #screen-summary
  --------------------------------------------------------------- */
  function buildSummary() {
    var screenEl = document.getElementById('screen-summary');
    screenEl.className = 'screen';
    var panel = el('div', 'panel');
    screenEl.appendChild(panel);
    screens.summary = screenEl;
    summaryPanel = panel;
  }

  function summaryLine(label, value) {
    var row = el('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.padding = '6px 0';
    row.style.fontSize = '14px';
    row.appendChild(el('span', 'text-dim', label));
    row.appendChild(el('span', null, value));
    return row;
  }

  function renderSummary(summary) {
    summary = summary || { revenue: 0, cogs: 0, rent: 0, profit: 0, customers: 0, itemsSold: 0 };
    var panel = summaryPanel;
    panel.innerHTML = '';
    panel.appendChild(el('div', 'panel-title', '今日结算'));

    panel.appendChild(summaryLine('营业额', G.fmt(summary.revenue)));
    panel.appendChild(summaryLine('进货成本', G.fmt(summary.cogs)));
    panel.appendChild(summaryLine('固定支出', G.fmt(summary.rent)));

    var divider = el('div');
    divider.style.borderTop = '1px solid var(--line)';
    divider.style.margin = '12px 0';
    panel.appendChild(divider);

    var profitRow = el('div');
    profitRow.style.display = 'flex';
    profitRow.style.justifyContent = 'space-between';
    profitRow.style.alignItems = 'baseline';
    profitRow.style.margin = '0 0 16px';
    profitRow.appendChild(el('span', 'text-dim', '净利'));
    var profitVal = el('span', summary.profit >= 0 ? 'text-accent' : 'text-danger', G.fmt(summary.profit));
    profitVal.style.fontSize = '28px';
    profitVal.style.fontWeight = '700';
    profitRow.appendChild(profitVal);
    panel.appendChild(profitRow);

    panel.appendChild(summaryLine('顾客数', String(summary.customers)));
    panel.appendChild(summaryLine('售出件数', String(summary.itemsSold)));

    if (G.state.money < 0) {
      var warn = el('div', 'text-danger', '余额为负，请尽快恢复盈利！连续 3 天亏损将导致游戏结束。');
      warn.style.margin = '16px 0 0';
      warn.style.fontSize = '12px';
      panel.appendChild(warn);
    }

    var nextBtn = el('button', 'btn btn-primary', '进入第 ' + (G.state.day + 1) + ' 天');
    nextBtn.style.marginTop = '16px';
    nextBtn.addEventListener('click', function () {
      G.bus.emit('nextDay', {});
    });
    panel.appendChild(nextBtn);
  }

  /* ---------------------------------------------------------------
     screen 切换 / Esc
  --------------------------------------------------------------- */
  function showScreen(name) {
    current = name;
    Object.keys(screens).forEach(function (key) {
      if (key === name) screens[key].setAttribute('data-open', '1');
      else screens[key].removeAttribute('data-open');
    });
    if (name === 'computer') renderActiveTab();
    if (name === 'menu') updateContinueState();
    refreshPrompt();
    G.bus.emit('screen', { name: name });
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.code === 'Escape') {
      if (current === 'computer') showScreen(null);
    }
  }

  /* ---------------------------------------------------------------
     prompt / toast
  --------------------------------------------------------------- */
  function setPrompt(text) {
    shownPrompt = text || null;
    if (!text) {
      promptEl.style.display = 'none';
      promptEl.textContent = '';
      promptEl.style.color = '';
      return;
    }
    promptEl.style.display = 'block';
    promptEl.innerHTML = '';
    var m = /^\[([^\]]+)\]\s*(.*)$/.exec(text);
    if (m) {
      var kbdEl = document.createElement('kbd');
      kbdEl.textContent = m[1];
      promptEl.appendChild(kbdEl);
      promptEl.appendChild(document.createTextNode(' ' + m[2]));
      promptEl.style.color = '';
    } else {
      promptEl.textContent = text;
      promptEl.style.color = 'var(--danger)';
    }
  }

  /* GDD §8：备货阶段 HUD 常驻提示「按 O 开门营业」；有交互提示时让位给交互提示 */
  function prepHint() {
    if (!G.state) return null;
    if (G.state.open) { inPrep = false; return null; }   // 开门后到日结算之间不再提示
    if (!inPrep || current !== null) return null;
    return '[O] 开门营业';
  }

  function refreshPrompt() {
    if (G.checkout && G.checkout.inRegister) return;   // 收银模式下 #prompt 由 checkout.js 控制
    var text = hoverPrompt || prepHint();
    if (text !== shownPrompt) setPrompt(text);
  }

  function barColor(kind) {
    if (kind === 'warn') return 'var(--warn)';
    if (kind === 'danger') return 'var(--danger)';
    if (kind === 'info') return 'var(--accent-2)';
    return 'var(--accent)';
  }

  function toast(text, kind) {
    kind = kind || 'ok';
    if (toastQueue.length >= 3) {
      var oldest = toastQueue.shift();
      oldest.timers.forEach(function (t) { clearTimeout(t); });
      if (oldest.el.parentNode) oldest.el.parentNode.removeChild(oldest.el);
    }
    var div = document.createElement('div');
    div.textContent = text;
    div.style.borderLeftColor = barColor(kind);
    toastEl.appendChild(div);
    void div.offsetWidth;
    div.setAttribute('data-show', '1');

    var entry = { el: div, timers: [] };
    toastQueue.push(entry);
    entry.timers.push(setTimeout(function () {
      div.removeAttribute('data-show');
      div.setAttribute('data-hide', '1');
      entry.timers.push(setTimeout(function () {
        if (div.parentNode) div.parentNode.removeChild(div);
        var idx = toastQueue.indexOf(entry);
        if (idx !== -1) toastQueue.splice(idx, 1);
      }, 300));
    }, 2620));
  }

  /* ---------------------------------------------------------------
     HUD
  --------------------------------------------------------------- */
  function buildHud() {
    var hudMoney = document.getElementById('hud-money');
    moneyValEl = document.createElement('span');
    hudMoney.appendChild(moneyValEl);

    hudDayEl = document.getElementById('hud-day');
    hudClockEl = document.getElementById('hud-clock');

    var hudLevel = document.getElementById('hud-level');
    levelValEl = document.createElement('span');
    hudLevel.appendChild(levelValEl);
    var track = document.createElement('div');
    xpFillEl = document.createElement('div');
    track.appendChild(xpFillEl);
    hudLevel.appendChild(track);

    crosshairEl = document.getElementById('crosshair');
    promptEl = document.getElementById('prompt');
    toastEl = document.getElementById('toast');

    moneyValEl.textContent = G.fmt(G.state.money);
    renderLevel(G.state.level, G.state.xp);
    renderDay(G.state.day);
  }

  function levelProgress(level, xp) {
    var levels = G.data.LEVELS;
    var cur = null, next = null;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i].level === level) cur = levels[i];
      if (levels[i].level === level + 1) next = levels[i];
    }
    if (!next) return 1;
    var base = cur ? cur.xpNeeded : 0;
    var span = next.xpNeeded - base;
    if (span <= 0) return 1;
    return G.clamp((xp - base) / span, 0, 1);
  }

  function renderLevel(level, xp) {
    levelValEl.textContent = 'Lv ' + level;
    xpFillEl.style.width = (levelProgress(level, xp) * 100) + '%';
  }

  function renderDay(day) {
    hudDayEl.textContent = '第 ' + day + ' 天';
  }

  function renderClock() {
    if (!G.state) return;
    refreshPrompt();   // 备货提示随开门/打烊状态出现或消失
    if (!G.state.open) { hudClockEl.textContent = '准备中'; return; }
    var dayLen = G.data.CONFIG.dayLengthSec;
    var totalMin = 9 * 60 + G.state.clock * (12 * 60 / dayLen);
    totalMin = G.clamp(totalMin, 9 * 60, 21 * 60);
    var h = Math.floor(totalMin / 60), m = Math.floor(totalMin % 60);
    hudClockEl.textContent = pad2(h) + ':' + pad2(m);
  }

  function spawnMoneyDelta(delta) {
    var hudMoney = document.getElementById('hud-money');
    var d = document.createElement('div');
    d.style.color = delta >= 0 ? 'var(--accent)' : 'var(--danger)';
    d.textContent = (delta >= 0 ? '+' : '-') + G.fmt(Math.abs(delta));
    hudMoney.appendChild(d);
    void d.offsetWidth;
    d.setAttribute('data-rise', '1');
    setTimeout(function () {
      if (d.parentNode) d.parentNode.removeChild(d);
    }, 800);
  }

  function onMoney(p) {
    moneyValEl.textContent = G.fmt(p.money);
    moneyValEl.style.animation = 'none';
    void moneyValEl.offsetWidth;
    moneyValEl.style.animation = (p.delta < 0 ? 'hudMoneyDown' : 'hudMoneyUp') + ' 180ms ease-out';
    if (p.delta) spawnMoneyDelta(p.delta);
    refreshComputerIfOpen();
  }

  function onXp(p) {
    renderLevel(p.level, p.xp);
  }

  function onLevelup(p) {
    var lv = null;
    for (var i = 0; i < G.data.LEVELS.length; i++) {
      if (G.data.LEVELS[i].level === p.level) lv = G.data.LEVELS[i];
    }
    toast('等级提升！Lv ' + p.level + ' — 解锁：' + (lv ? lv.unlock : ''), 'info');
    refreshComputerIfOpen();
  }

  function onDayStart(p) {
    renderDay(p.day);
    inPrep = true;
    refreshPrompt();
  }

  function onDayEnd(p) {
    renderSummary(p && p.summary);
    showScreen('summary');
  }

  function onHover(p) {
    hoverPrompt = p.prompt;
    refreshPrompt();
    var hit = !!p.prompt;
    crosshairEl.style.width = hit ? '12px' : '8px';
    crosshairEl.style.height = hit ? '12px' : '8px';
    crosshairEl.style.background = hit ? 'var(--hl)' : 'rgba(255,255,255,.6)';
  }

  /* ---------------------------------------------------------------
     初始化
  --------------------------------------------------------------- */
  function init() {
    buildHud();
    buildMenu();
    buildComputer();
    buildSummary();

    document.addEventListener('keydown', onKeyDown);

    G.bus.on('money', onMoney);
    G.bus.on('xp', onXp);
    G.bus.on('levelup', onLevelup);
    G.bus.on('dayStart', onDayStart);
    G.bus.on('dayEnd', onDayEnd);
    G.bus.on('hover', onHover);
    G.bus.on('delivery', refreshComputerIfOpen);
    G.bus.on('license', refreshComputerIfOpen);

    setInterval(renderClock, 250);
    renderClock();
  }

  G.ui = {
    init: init,
    showScreen: showScreen,
    prompt: setPrompt,
    toast: toast
  };
})();
