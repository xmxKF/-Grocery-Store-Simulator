// js/textures.js — 程序化纹理工厂（DESIGN §5.4）。双层缓存：canvas 按内容缓存，
// Texture 按 (内容, repeat) 缓存——repeat 属于 Texture 对象，共享实例会互相覆盖（对抗审查修订）。
(function () {
  'use strict';
  window.G = window.G || {};

  var on = true;
  try { on = localStorage.getItem('gss-lowfx') !== '1'; } catch (e) {}

  var canvases = {};   // contentKey -> canvas
  var textures = {};   // contentKey|rx|ry -> CanvasTexture
  var rendererRef = null;
  var maxAniso = 1;

  function cv(size, h) {
    var c = document.createElement('canvas');
    c.width = size; c.height = h || size;
    return c;
  }

  function makeTex(contentKey, rx, ry, aniso, draw) {
    if (!G.tex.on) return null;
    var tk = contentKey + '|' + rx + '|' + ry;
    if (textures[tk]) return textures[tk];
    if (!canvases[contentKey]) canvases[contentKey] = draw();
    var t = new THREE.CanvasTexture(canvases[contentKey]);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    if (aniso) t.anisotropy = Math.min(4, maxAniso);
    textures[tk] = t;
    return t;
  }

  /* 木地板 512²：横向板条 + 板缝 + 每条轻微明度抖动 */
  function drawFloorWood() {
    var c = cv(512), g = c.getContext('2d');
    g.fillStyle = '#C9B48E'; g.fillRect(0, 0, 512, 512);
    for (var row = 0; row < 8; row++) {
      var y = row * 64;
      var l = 0.92 + ((row * 37) % 17) / 100;
      g.fillStyle = 'rgba(160,130,90,' + (1.04 - l).toFixed(2) + ')';
      g.fillRect(0, y, 512, 64);
      g.fillStyle = '#A08258';
      g.fillRect(0, y, 512, 2);
      var off = (row * 197) % 512;
      g.fillRect(off, y, 2, 64);
      g.strokeStyle = 'rgba(150,120,85,0.25)';
      for (var v = 0; v < 6; v++) {
        g.beginPath();
        var yy = y + 8 + v * 9 + ((row + v) % 3);
        g.moveTo(0, yy); g.bezierCurveTo(128, yy + 2, 384, yy - 2, 512, yy + 1);
        g.stroke();
      }
    }
    return c;
  }

  /* 卸货区混凝土 256²：中灰底 + 噪点 + 伸缩缝 */
  function drawYardConcrete() {
    var c = cv(256), g = c.getContext('2d');
    g.fillStyle = '#B8B0A2'; g.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 900; i++) {
      var x = (i * 97) % 256, y = (i * 61) % 256;
      g.fillStyle = (i % 2) ? 'rgba(90,85,75,0.10)' : 'rgba(255,252,245,0.08)';
      g.fillRect(x, y, 2, 2);
    }
    g.fillStyle = 'rgba(90,85,75,0.5)';
    g.fillRect(0, 126, 256, 3); g.fillRect(126, 0, 3, 256);
    return c;
  }

  /* 墙面 256×512（V 对应整面墙高 3m）：上部米白灰泥、下部 0.9m 腔裙板、踢脚线 */
  function drawWallWainscot() {
    var c = cv(256, 512), g = c.getContext('2d');
    g.fillStyle = '#EFE9DE'; g.fillRect(0, 0, 256, 512);
    for (var i = 0; i < 400; i++) {
      g.fillStyle = 'rgba(200,190,175,0.07)';
      g.fillRect((i * 89) % 256, (i * 53) % 358, 3, 1);
    }
    /* 腔裙板占墙下部 0.9/3 = 30% → 512×0.30 ≈ 154px（注意 canvas 的 y 向下、UV 的 v 向上：
       Box 侧面 v=0 在几何底部、对应 canvas 底部行——腔裙板画在 canvas 底部）*/
    var wainH = 154, y0 = 512 - wainH;
    g.fillStyle = '#8C7A62'; g.fillRect(0, y0, 256, wainH);
    g.fillStyle = 'rgba(60,48,36,0.35)';
    for (var p = 0; p < 4; p++) g.fillRect(p * 64 + 30, y0 + 12, 4, wainH - 36);
    g.fillStyle = '#6E5A48'; g.fillRect(0, y0, 256, 6);
    /* 踢脚线 0.1m ≈ 17px */
    g.fillStyle = '#4E4238'; g.fillRect(0, 512 - 17, 256, 17);
    return c;
  }

  /* 天花板矿棉格 256²：米白 + 格线 */
  function drawCeilingPanel() {
    var c = cv(256), g = c.getContext('2d');
    g.fillStyle = '#F5F2EC'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(160,155,145,0.55)'; g.lineWidth = 3;
    g.strokeRect(1, 1, 254, 254);
    g.fillStyle = 'rgba(200,195,185,0.15)';
    for (var i = 0; i < 300; i++) g.fillRect((i * 83) % 256, (i * 47) % 256, 2, 1);
    return c;
  }

  function drawBrushedMetal(base, streak) {
    var c = cv(256), g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (var y = 0; y < 256; y += 2) {
      g.fillStyle = 'rgba(' + streak + ',' + (0.04 + ((y * 13) % 7) / 100).toFixed(2) + ')';
      g.fillRect(0, y, 256, 1);
    }
    return c;
  }
  function drawShelfMetal() { return drawBrushedMetal('#98A4B0', '255,255,255'); }
  function drawFridgeSteel() { return drawBrushedMetal('#C2CDD4', '235,245,250'); }

  /* 收银台贴面 256²：暖灰 + 细横纹 */
  function drawCounterLaminate() {
    var c = cv(256), g = c.getContext('2d');
    g.fillStyle = '#7A8694'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (var y = 0; y < 256; y += 8) g.fillRect(0, y, 256, 3);
    return c;
  }

  /* 传送带橡胶 256²：近灰度（材质色 0x4E5866 相乘染色——红线：不得动材质 color）*/
  function drawBeltRubber() {
    var c = cv(256), g = c.getContext('2d');
    g.fillStyle = '#E8E8E8'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(120,120,120,0.5)';
    for (var y = 0; y < 256; y += 32) g.fillRect(0, y, 256, 10);
    return c;
  }

  /* 纸箱瓦楞 256²：近灰度（材质色切满/空——红线：不得动材质 color）*/
  function drawCardboard() {
    var c = cv(256), g = c.getContext('2d');
    g.fillStyle = '#EDEDED'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(150,150,150,0.4)'; g.lineWidth = 1;
    for (var y = 4; y < 256; y += 8) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, 118, 256, 20);   /* 封箱带 */
    return c;
  }

  /* 商品标签带 64²：accent 底色横带 + 深色抽象字块（per shape+accent 缓存）*/
  function drawLabelBand(shape, accent) {
    var c = cv(64), g = c.getContext('2d');
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, 64, 64);
    var y0 = (shape === 'bottle' || shape === 'jug') ? 30 : 22;
    g.fillStyle = accent; g.fillRect(0, y0, 64, 20);
    g.fillStyle = 'rgba(20,22,27,0.75)';
    g.fillRect(6, y0 + 6, 16, 8); g.fillRect(26, y0 + 6, 10, 8); g.fillRect(40, y0 + 6, 18, 8);
    return c;
  }

  G.tex = {
    on: on,
    setRenderer: function (r) {
      rendererRef = r;
      maxAniso = (r && r.capabilities && r.capabilities.getMaxAnisotropy) ? r.capabilities.getMaxAnisotropy() : 1;
    },
    floorWood: function (rx, ry) { return makeTex('floorWood', rx, ry, true, drawFloorWood); },
    yardConcrete: function (rx, ry) { return makeTex('yardConcrete', rx, ry, true, drawYardConcrete); },
    wallWainscot: function (rx, ry) { return makeTex('wallWainscot', rx, ry, false, drawWallWainscot); },
    ceilingPanel: function (rx, ry) { return makeTex('ceilingPanel', rx, ry, false, drawCeilingPanel); },
    shelfMetal: function (rx, ry) { return makeTex('shelfMetal', rx, ry, false, drawShelfMetal); },
    fridgeSteel: function (rx, ry) { return makeTex('fridgeSteel', rx, ry, false, drawFridgeSteel); },
    counterLaminate: function (rx, ry) { return makeTex('counterLaminate', rx, ry, false, drawCounterLaminate); },
    beltRubber: function (rx, ry) { return makeTex('beltRubber', rx, ry, false, drawBeltRubber); },
    cardboard: function (rx, ry) { return makeTex('cardboard', rx, ry, false, drawCardboard); },
    labelBand: function (shape, accent) {
      var key = 'label|' + shape + '|' + accent;
      return makeTex(key, 1, 1, false, function () { return drawLabelBand(shape, accent); });
    },
    _cache: { canvases: canvases, textures: textures }
  };
})();
