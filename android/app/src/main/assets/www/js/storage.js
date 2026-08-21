/**
 * storage.js — 对局历史记录（localStorage）+ 回放数据管理
 *
 * 记录结构：
 * {
 *   id: 时间戳,
 *   mode: 'ai' | 'lan' | 'online',
 *   level: 段位（人机模式）,
 *   players: { black: '…', white: '…' },
 *   result: 'black' | 'white' | 'draw' | 'abort',
 *   winnerName: '…',
 *   moves: [{x,y,player}],
 *   createdAt: ISO 字符串,
 *   durationMs: 对局时长
 * }
 * 最多保留 50 局，超出滚动淘汰最旧。
 */
(function (global) {
  'use strict';

  var KEY = 'gomoku_history_v1';
  var MAX = 50;

  function loadAll() {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) { /* 存储满时静默失败 */ }
  }

  function add(record) {
    var list = loadAll();
    list.unshift(record);
    if (list.length > MAX) list = list.slice(0, MAX);
    saveAll(list);
    return record;
  }

  function remove(id) {
    var list = loadAll().filter(function (r) { return r.id !== id; });
    saveAll(list);
    return list;
  }

  function clear() {
    saveAll([]);
  }

  function get(id) {
    var list = loadAll();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  global.GomokuStorage = { loadAll: loadAll, add: add, remove: remove, clear: clear, get: get };
})(typeof window !== 'undefined' ? window : globalThis);
