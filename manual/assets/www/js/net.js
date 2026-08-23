/**
 * net.js — 联机模块（PeerJS / WebRTC DataChannel）
 *
 * 架构：无服务器 P2P。房主 = host（权威节点，校验并广播所有落子），
 * 加入者 = client（白方或观战者），观战者只读订阅。
 *
 * 房间模型：
 *   - 房间码 4 位（如 K3FQ），host Peer ID = `gomoku-<房间码>`
 *   - client 用随机 Peer ID 连接 host；握手 `hello` 声明角色
 *   - 断线重连：client 断线后用相同身份重连，host 发 `state-sync` 恢复
 *
 * 消息协议（DataChannel 传输 JSON）：
 *   hello / welcome / state-sync / move / chat / undo-req / undo-ok / undo-no
 *   resign / restart-req / restart-ok / ping / pong / player-list
 *
 * PEER_CONFIG 可在 index.html 中覆盖（自托管信令场景）。
 */
(function (global) {
  'use strict';

  var PEER_CONFIG = global.PEER_CONFIG || {
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    debug: 0
  };

  /** 席位保留窗口：断线后 90 秒内重连可恢复对局。 */
  var RECONNECT_WINDOW = 90000;
  /** 心跳间隔 / 判死阈值。 */
  var HEARTBEAT_MS = 10000;
  var DEAD_MS = 30000;

  var ROOM_PREFIX = 'gomoku-';

  /**
   * Net 客户端。所有对外行为通过 callbacks 回调：
   *   onStatus(type, payload)  'host-ready' | 'client-open' | 'welcome' | 'peer-joined' | 'peer-left'
   *                             | 'message' | 'disconnected' | 'reconnected' | 'error'
   *   onMessage(msg)           业务消息（move/chat/undo/...）
   */
  function Net(callbacks) {
    this.cb = callbacks || {};
    this.peer = null;
    this.conn = null;            // client 端主连接
    this.conns = new Map();      // host 端：conn -> { seat, name, sid, lastSeen, timer }
    this.isHost = false;
    this.roomCode = null;
    this.mySeat = null;          // 'black' | 'white' | 'spectator'
    this.mySid = null;           // 本端身份（重连凭证）
    this._hb = null;             // 心跳定时器
    this._deadTimer = null;      // 判死定时器
    this._closed = false;
    this._pendingHello = null;   // 重连待发 hello
  }

  /** 生成 4 位房间码（排除易混淆字符）。 */
  Net.genRoomCode = function () {
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  };

  Net.prototype._emit = function (type, payload) {
    if (this.cb.onStatus) this.cb.onStatus(type, payload);
  };

  // ─────────────────────────── 建房（host） ───────────────────────────

  Net.prototype.createRoom = function (roomCode, myName) {
    this.isHost = true;
    this.roomCode = roomCode;
    this.mySeat = 'black';
    this.mySid = 'host-' + Math.random().toString(36).slice(2, 10);

    var self = this;
    this.peer = new Peer(ROOM_PREFIX + roomCode, PEER_CONFIG);

    this.peer.on('open', function (id) {
      self._emit('host-ready', { id: id, roomCode: roomCode });
      self._startHeartbeat();
    });

    this.peer.on('connection', function (conn) {
      conn.on('data', function (data) { self._onHostData(conn, data); });
      conn.on('close', function () { self._onHostConnClose(conn); });
      conn.on('error', function (e) { /* 单连接错误不致命，忽略 */ });
    });

    this.peer.on('error', function (err) {
      self._emit('error', { type: err.type, message: err.message });
    });
  };

  /** host 收到任何数据：首条必须是 hello 完成注册，之后按消息类型处理。 */
  Net.prototype._onHostData = function (conn, raw) {
    var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (msg.type === 'hello') {
      this._registerConn(conn, msg);
      return;
    }
    // 已注册连接的业务消息
    var meta = this.conns.get(conn);
    if (!meta) return;
    meta.lastSeen = Date.now();
    if (msg.type === 'pong') return;
    // 以 host 注册的权威席位覆盖消息携带的 seat（防止伪造）
    msg.seat = meta.seat;
    // 业务消息统一交给上层，并附带来源席位
    if (this.cb.onMessage) this.cb.onMessage(msg, meta.seat, meta);
  };

  Net.prototype._registerConn = function (conn, hello) {
    var self = this;
    var seats = this._seatMap();

    // 重连恢复：sid 匹配且席位仍在保留窗口
    var existing = null;
    this.conns.forEach(function (m) {
      if (m.sid === hello.sid && (m.timer || m.offline)) existing = m;
    });

    var meta;
    if (existing) {
      meta = existing;
      meta.conn = conn;
      meta.offline = false;
      if (meta.timer) { clearTimeout(meta.timer); meta.timer = null; }
      this.conns.set(conn, meta);
      if (meta.connOld) { this.conns.delete(meta.connOld); delete meta.connOld; }
      this._emit('reconnected', { seat: meta.seat, name: meta.name });
      this._sendTo(conn, {
        type: 'state-sync',
        seat: meta.seat,
        name: this.cb.getMyName ? this.cb.getMyName() : 'host',
        snapshot: this.cb.getSnapshot ? this.cb.getSnapshot() : null
      });
      return;
    }

    // 新连接：分配席位
    var seat = null;
    if (hello.role === 'player' && !seats.white) seat = 'white';
    else seat = 'spectator'; // 玩家位已满 → 自动转观战

    meta = { conn: conn, seat: seat, name: hello.name || '玩家', sid: hello.sid || '', lastSeen: Date.now(), offline: false };
    this.conns.set(conn, meta);

    this._sendTo(conn, {
      type: 'welcome',
      seat: seat,
      name: hello.name || '玩家',
      snapshot: this.cb.getSnapshot ? this.cb.getSnapshot() : null
    });
    this._emit('peer-joined', { seat: seat, name: meta.name });
    // 广播新玩家列表
    this._broadcastPlayerList();
  };

  Net.prototype._onHostConnClose = function (conn) {
    var meta = this.conns.get(conn);
    if (!meta) return;
    // 注意：meta 保留在 conns 中（key 为原 conn），仅标记离线，
    // 这样重连时 _registerConn 才能通过 sid 找到席位。
    meta.conn = null;
    meta.connOld = conn;
    meta.offline = true;

    var self = this;
    if (meta.seat === 'spectator') {
      this.conns.delete(conn);
      this._emit('peer-left', { seat: 'spectator', name: meta.name });
      this._broadcastPlayerList();
      return;
    }
    // 玩家断线：保留席位 90 秒
    this._emit('peer-left', { seat: meta.seat, name: meta.name, reconnecting: true });
    meta.timer = setTimeout(function () {
      // 超时未归 → 判负并清除席位
      self.conns.delete(meta.connOld || conn);
      self._emit('peer-timeout', { seat: meta.seat, name: meta.name });
      self._broadcastPlayerList();
    }, RECONNECT_WINDOW);
    this._broadcastPlayerList();
  };

  /** 当前已注册的座位表。 */
  Net.prototype._seatMap = function () {
    var seats = { white: null, spectator: [] };
    this.conns.forEach(function (m) {
      if (m.seat === 'white') seats.white = m;
      else if (m.seat === 'spectator') seats.spectator.push(m);
    });
    return seats;
  };

  Net.prototype._broadcastPlayerList = function () {
    var list = [{ seat: 'black', name: this.cb.getMyName ? this.cb.getMyName() : '房主', sid: this.mySid }];
    this.conns.forEach(function (m) {
      list.push({ seat: m.seat, name: m.name, sid: m.sid });
    });
    this.broadcast('player-list', { players: list });
  };

  // ─────────────────────────── 加入（client） ───────────────────────────

  /**
   * 加入房间。opts: { name, sid, reconnect }
   * reconnect=true 时携带上次 sid，host 优先恢复原席位。
   */
  Net.prototype.joinRoom = function (roomCode, opts) {
    this.isHost = false;
    this.roomCode = roomCode;
    this.myName = opts.name;
    this.mySid = opts.sid || 'c-' + Math.random().toString(36).slice(2, 12);

    var self = this;
    this._closed = false;
    // 重连场景：销毁旧的 peer（已断开），避免资源泄漏与事件残留
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) { /* ignore */ }
      this.peer = null;
    }

    var peer = new Peer(PEER_CONFIG); // 随机 ID
    this.peer = peer;

    peer.on('open', function () {
      var conn = peer.connect(ROOM_PREFIX + roomCode, { reliable: true });
      self.conn = conn;
      conn.on('open', function () {
        self._emit('client-open', {});
        self._sendHello();
        self._startHeartbeat();
      });
      conn.on('data', function (data) { self._onClientData(data); });
      conn.on('close', function () {
        self._emit('disconnected', {});
        self._scheduleReconnect();
      });
      conn.on('error', function () { /* 由 close 兜底 */ });
    });

    peer.on('error', function (err) {
      if (err.type === 'peer-unavailable') {
        self._emit('error', { type: 'room-not-found', message: '房间不存在或已关闭' });
      } else {
        self._emit('error', { type: err.type, message: err.message });
      }
    });
  };

  Net.prototype._sendHello = function () {
    if (!this.conn || !this.conn.open) return;
    this.conn.send({
      type: 'hello',
      role: 'player',
      name: this.myName,
      sid: this.mySid
    });
  };

  Net.prototype._onClientData = function (raw) {
    var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (msg.type === 'pong') return;
    if (msg.type === 'welcome') {
      this.mySeat = msg.seat;
      this._emit('welcome', msg);
      return;
    }
    if (msg.type === 'state-sync') {
      this.mySeat = msg.seat;
      this._emit('reconnected', msg);
      return;
    }
    if (this.cb.onMessage) this.cb.onMessage(msg, this.mySeat);
  };

  /** 断线重连：指数退避重试（2s → 4s → 8s → 16s 封顶），最多 45 秒。 */
  Net.prototype._scheduleReconnect = function () {
    if (this._closed || this._retryTimer) return;
    var self = this;
    var delay = Math.min(16000, 2000 * Math.pow(2, this._retryCount || 0));
    this._retryCount = (this._retryCount || 0) + 1;
    this._emit('reconnecting', { attempt: this._retryCount, delay: delay });
    this._retryTimer = setTimeout(function () {
      self._retryTimer = null;
      if (self._closed) return;
      self._emit('reconnect-attempt', { attempt: self._retryCount });
      self.joinRoom(self.roomCode, { name: self.myName, sid: self.mySid });
    }, delay);
  };

  // ─────────────────────────── 心跳 / 判死 ───────────────────────────

  Net.prototype._startHeartbeat = function () {
    var self = this;
    if (this._hb) clearInterval(this._hb);
    this._hb = setInterval(function () {
      var now = Date.now();
      if (self.isHost) {
        // host：检查各连接最近活跃时间
        self.conns.forEach(function (m, conn) {
          if (m.offline) return;
          if (now - (m.lastSeen || now) > DEAD_MS) {
            try { conn.close(); } catch (e) { /* ignore */ }
            self._onHostConnClose(conn);
          }
        });
      } else if (self.conn && self.conn.open) {
        self.conn.send({ type: 'ping', ts: now });
      }
    }, HEARTBEAT_MS);
  };

  // ─────────────────────────── 发送 ───────────────────────────

  /** 业务层发送（client 用）。消息自动携带本端席位，host 侧以其权威席位为准。 */
  Net.prototype.send = function (type, payload) {
    var msg = payload || {};
    msg.type = type;
    msg.seat = this.mySeat || null;
    if (this.isHost) {
      // host 直接处理本地逻辑，不走网络
      if (this.cb.onMessage) this.cb.onMessage(msg, this.mySeat);
    } else if (this.conn && this.conn.open) {
      this.conn.send(msg);
    }
  };

  /** host 广播给所有已注册连接（含观战）。except: 指定 conn 或 seat 不广播。 */
  Net.prototype.broadcast = function (type, payload, except) {
    var msg = payload || {};
    msg.type = type;
    msg.seat = this.mySeat || null;
    var self = this;
    this.conns.forEach(function (m, conn) {
      if (except && (conn === except || m.seat === except)) return;
      try { conn.send(msg); } catch (e) { /* ignore */ }
    });
  };

  /** host 定向发送给指定座位。 */
  Net.prototype.sendTo = function (seat, type, payload) {
    var msg = payload || {};
    msg.type = type;
    msg.seat = this.mySeat || null;
    var target = null;
    this.conns.forEach(function (m, conn) {
      if (m.seat === seat && !m.offline) target = conn;
    });
    if (target) this._sendTo(target, msg);
  };

  Net.prototype._sendTo = function (conn, msg) {
    try { conn.send(msg); } catch (e) { /* ignore */ }
  };

  // ─────────────────────────── 收尾 ───────────────────────────

  Net.prototype.close = function () {
    this._closed = true;
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } this.peer = null; }
    this.conn = null;
    this.conns.clear();
  };

  global.GomokuNet = Net;
  global.PEER_CONFIG = PEER_CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
