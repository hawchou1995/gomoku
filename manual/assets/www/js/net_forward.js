/**
 * ResNet 策略-价值网络 JS 前向推理（与 ai/net.py 结构一一对应）
 * 输入 8x15x15（4 当前方历史 + 4 对手方历史）→ policy[225] + value
 * 权重加载自 model/best_net.json（ai/export_json 导出）
 * 同时支持 Node (require) 与浏览器 (<script>)。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.NetForward = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 15;
  var EPS = 1e-5;

  function NetForward() {
    this.weights = null; // {board_size, in_planes, filters, res_blocks, weights:{...}}
    this.loaded = false;
  }

  /** Node: 从 JSON 文件加载；浏览器：从 URL fetch */
  NetForward.prototype.load = function (src, cb) {
    var self = this;
    var done = function (err) {
      if (err) { if (cb) cb(err); return; }
      try { self._flatten(); self.loaded = true; if (cb) cb(null); }
      catch (e) { if (cb) cb(e); }
    };
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      var fs = require('fs');
      try { self.weights = JSON.parse(fs.readFileSync(src, 'utf8')); done(null); }
      catch (e) { done(e); }
      return;
    }
    fetch(src).then(function (r) { return r.json(); }).then(function (j) {
      self.weights = j; done(null);
    }).catch(done);
  };

  /** 把嵌套数组权重全部摊平为一维（Python tolist 导出的是嵌套 list） */
  NetForward.prototype._flatten = function () {
    var W = this.weights.weights;
    function flat(a) {
      if (typeof a[0] === 'number') return a;
      var out = [];
      (function rec(arr) {
        for (var i = 0; i < arr.length; i++) {
          if (typeof arr[i] === 'number') out.push(arr[i]);
          else rec(arr[i]);
        }
      })(a);
      return out;
    }
    for (var k in W) W[k] = flat(W[k]);
  };

  // ---------- 基础算子（channel-last 风格的简单实现，15x15 足够快） ----------

  /** 2D 卷积：input[C,H,W] → output[O,H,W]，kernel[O,C,kh,kw]，pad=1，stride=1 */
  function conv2d(input, w, b, inC, outC, kh, kw, H, W, pad) {
    pad = pad === undefined ? 1 : pad;
    var out = new Float64Array(outC * H * W);
    var oh, ow, o, c, i, j;
    for (o = 0; o < outC; o++) {
      for (oh = 0; oh < H; oh++) {
        for (ow = 0; ow < W; ow++) {
          var acc = b ? b[o] : 0;
          for (c = 0; c < inC; c++) {
            for (i = 0; i < kh; i++) {
              var ih = oh + i - pad;
              if (ih < 0 || ih >= H) continue;
              for (j = 0; j < kw; j++) {
                var iw = ow + j - pad;
                if (iw < 0 || iw >= W) continue;
                acc += input[(c * H + ih) * W + iw] * w[((o * inC + c) * kh + i) * kw + j];
              }
            }
          }
          out[(o * H + oh) * W + ow] = acc;
        }
      }
    }
    return out;
  }

  /** BatchNorm（推理模式） */
  function bn(input, gamma, beta, mean, var_, C, H, W) {
    var out = new Float64Array(C * H * W);
    for (var c = 0; c < C; c++) {
      var inv = gamma[c] / Math.sqrt(var_[c] + EPS);
      var off = beta[c] - mean[c] * inv;
      for (var i = 0; i < H * W; i++) out[c * H * W + i] = input[c * H * W + i] * inv + off;
    }
    return out;
  }

  function relu(input) {
    for (var i = 0; i < input.length; i++) if (input[i] < 0) input[i] = 0;
    return input;
  }

  function add(a, b) {
    for (var i = 0; i < a.length; i++) a[i] += b[i];
    return a;
  }

  function fc(input, w, b, inN, outN) {
    var out = new Float64Array(outN);
    for (var o = 0; o < outN; o++) {
      var acc = b ? b[o] : 0;
      for (var i = 0; i < inN; i++) acc += input[i] * w[o * inN + i];
      out[o] = acc;
    }
    return out;
  }

  function softmax(logits) {
    var maxv = -Infinity;
    for (var i = 0; i < logits.length; i++) if (logits[i] > maxv) maxv = logits[i];
    var sum = 0;
    var out = new Float64Array(logits.length);
    for (var j = 0; j < logits.length; j++) { out[j] = Math.exp(logits[j] - maxv); sum += out[j]; }
    for (var k = 0; k < out.length; k++) out[k] /= sum;
    return out;
  }

  /** 前向：planes 为长度为 8*15*15 的数组（C,H,W 布局） */
  NetForward.prototype.forward = function (planes) {
    var W = this.weights.weights;
    var F = this.weights.filters;
    var blocks = this.weights.res_blocks;
    var H = SIZE, WW = SIZE;

    // conv1 + bn1 + relu
    var x = conv2d(planes, W['conv1.weight'], W['conv1.bias'], 8, F, 3, 3, H, WW, 1);
    x = bn(x, W['bn1.weight'], W['bn1.bias'], W['bn1.running_mean'], W['bn1.running_var'], F, H, WW);
    x = relu(x);

    // 残差块
    for (var b = 0; b < blocks; b++) {
      var pre = x;
      x = conv2d(x, W['blocks.' + b + '.conv1.weight'], W['blocks.' + b + '.conv1.bias'], F, F, 3, 3, H, WW, 1);
      x = bn(x, W['blocks.' + b + '.bn1.weight'], W['blocks.' + b + '.bn1.bias'],
             W['blocks.' + b + '.bn1.running_mean'], W['blocks.' + b + '.bn1.running_var'], F, H, WW);
      x = relu(x);
      x = conv2d(x, W['blocks.' + b + '.conv2.weight'], W['blocks.' + b + '.conv2.bias'], F, F, 3, 3, H, WW, 1);
      x = bn(x, W['blocks.' + b + '.bn2.weight'], W['blocks.' + b + '.bn2.bias'],
             W['blocks.' + b + '.bn2.running_mean'], W['blocks.' + b + '.bn2.running_var'], F, H, WW);
      x = add(x, pre);
      x = relu(x);
    }

    // policy head
    var p = conv2d(x, W['p_conv.weight'], W['p_conv.bias'], F, 2, 1, 1, H, WW, 0);
    p = bn(p, W['p_bn.weight'], W['p_bn.bias'], W['p_bn.running_mean'], W['p_bn.running_var'], 2, H, WW);
    p = relu(p);
    var pFlat = [];
    for (var c = 0; c < 2; c++) for (var i = 0; i < H * WW; i++) pFlat.push(p[c * H * WW + i]);
    var pLogits = fc(pFlat, W['p_fc.weight'], W['p_fc.bias'], 2 * H * WW, H * WW);
    var policy = softmax(pLogits);

    // value head
    var v = conv2d(x, W['v_conv.weight'], W['v_conv.bias'], F, 1, 1, 1, H, WW, 0);
    v = bn(v, W['v_bn.weight'], W['v_bn.bias'], W['v_bn.running_mean'], W['v_bn.running_var'], 1, H, WW);
    v = relu(v);
    var vFlat = [];
    for (var vi = 0; vi < H * WW; vi++) vFlat.push(v[vi]);
    var v1 = fc(vFlat, W['v_fc1.weight'], W['v_fc1.bias'], H * WW, 256);
    for (var ri = 0; ri < 256; ri++) if (v1[ri] < 0) v1[ri] = 0;
    var v2 = fc(v1, W['v_fc2.weight'], W['v_fc2.bias'], 256, 1);
    var value = Math.tanh(v2[0]);

    return { policy: policy, value: value };
  };

  return NetForward;
});
