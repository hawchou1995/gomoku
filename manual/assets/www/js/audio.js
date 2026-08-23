/**
 * audio.js — Web Audio 合成音效（零外部文件）
 *
 * 首次用户交互时惰性创建 AudioContext（浏览器自动播放策略要求）。
 * 音效：落子（木质短促"嗒"）、胜利（上行琶音）、失败（下行滑音）、聊天（轻提示）。
 */
(function (global) {
  'use strict';

  var ctx = null;

  function ensureCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** 播放一个带包络的振荡器音。 */
  function tone(freq, dur, type, vol, delay) {
    if (!ctx) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** 落子音：短促低频木质感（两个快速衰减的谐波）。 */
  function place() {
    if (!ensureCtx()) return;
    tone(320, 0.12, 'triangle', 0.35);
    tone(640, 0.06, 'sine', 0.12);
  }

  /** 胜利：C 大调上行琶音。 */
  function win() {
    if (!ensureCtx()) return;
    var notes = [523.25, 659.25, 783.99, 1046.5];
    for (var i = 0; i < notes.length; i++) tone(notes[i], 0.22, 'triangle', 0.22, i * 0.09);
  }

  /** 失败：下行滑音（两音）。 */
  function lose() {
    if (!ensureCtx()) return;
    tone(392, 0.25, 'sine', 0.2);
    tone(261.63, 0.35, 'sine', 0.2, 0.15);
  }

  /** 聊天提示：轻快短音。 */
  function chat() {
    if (!ensureCtx()) return;
    tone(880, 0.08, 'sine', 0.08);
    tone(1320, 0.06, 'sine', 0.05, 0.05);
  }

  /** 悔棋/操作反馈：短促双音。 */
  function undo() {
    if (!ensureCtx()) return;
    tone(440, 0.08, 'sine', 0.15);
    tone(330, 0.1, 'sine', 0.15, 0.07);
  }

  /** 用户交互时调用一次，解锁音频。 */
  function unlock() { ensureCtx(); }

  global.GomokuAudio = { place: place, win: win, lose: lose, chat: chat, undo: undo, unlock: unlock };
})(typeof window !== 'undefined' ? window : globalThis);
