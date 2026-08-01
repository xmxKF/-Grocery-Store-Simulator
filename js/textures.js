// js/textures.js — 程序化纹理工厂（T4 全量实现；本文件先行提供 lowfx 开关与 API 骨架）
(function () {
  'use strict';
  window.G = window.G || {};
  var on = true;
  try { on = localStorage.getItem('gss-lowfx') !== '1'; } catch (e) {}
  G.tex = { on: on, setRenderer: function () {} };
})();
