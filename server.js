const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const CONFIG = {
  minPlayers: 4,
  maxPlayers: 8,
  minHumanPlayersToStart: 1,
  totalHands: 5,
  handSize: 10,
  rowCount: 4,
};

const rooms = new Map();

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function isBlank(value) {
  return !String(value || "").trim();
}

function cleanName(name) {
  return String(name || "플레이어").trim().slice(0, 16) || "플레이어";
}

function cleanTitle(title) {
  return String(title || "젝스님트 방").trim().slice(0, 30) || "젝스님트 방";
}

function normalizeMaxPlayers(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 5;
  return Math.max(CONFIG.minPlayers, Math.min(CONFIG.maxPlayers, n));
}

function bullHeads(n) {
  if (n === 55) return 7;
  if (n % 11 === 0) return 5;
  if (n % 10 === 0) return 3;
  if (n % 5 === 0) return 2;
  return 1;
}

function rowBullTotal(row) {
  return row.reduce((sum, c) => sum + bullHeads(c), 0);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  return shuffle(Array.from({ length: 104 }, (_, i) => i + 1));
}

function createPlayer(socket, name) {
  return {
    id: socket.id,
    socketId: socket.id,
    name: cleanName(name),
    score: 0,
    hand: [],
    takenCards: [],
    connected: true,
    isAi: false,
    lastPlayedCard: null,
    lastAction: "입장",
  };
}

function createAiPlayer(index) {
  return {
    id: `AI_${Date.now()}_${index}_${Math.random().toString(16).slice(2, 6)}`,
    socketId: null,
    name: `🤖 컴퓨터 ${index}`,
    score: 0,
    hand: [],
    takenCards: [],
    connected: true,
    isAi: true,
    lastPlayedCard: null,
    lastAction: "AI 입장",
  };
}

function ensureAiPlayers(room) {
  let aiIndex = room.players.filter(p => p.isAi).length + 1;
  while (room.players.length < room.maxPlayers) {
    const ai = createAiPlayer(aiIndex++);
    room.players.push(ai);
    addLog(room, `${ai.name}가 빈 자리에 참여했습니다.`);
  }
}

function chooseBestRowToTakeForAi(room) {
  return room.rows
    .map((row, idx) => ({ idx, bulls: rowBullTotal(row), len: row.length }))
    .sort((a, b) => a.bulls - b.bulls || a.len - b.len)[0].idx;
}

function chooseAiCard(room, player) {
  const hand = [...player.hand].sort((a, b) => a - b);
  const scored = hand.map(card => {
    const candidates = room.rows
      .map((row, idx) => ({ idx, diff: card - row[row.length - 1] }))
      .filter(x => x.diff > 0)
      .sort((a, b) => a.diff - b.diff);

    if (!candidates.length) {
      const rowIndex = chooseBestRowToTakeForAi(room);
      return { card, risk: rowBullTotal(room.rows[rowIndex]) + 20 };
    }

    const target = candidates[0];
    const row = room.rows[target.idx];
    const risk = row.length === 5
      ? rowBullTotal(row) + 12
      : rowBullTotal(row) * 0.35 + target.diff * 0.04;
    return { card, risk };
  });

  scored.sort((a, b) => a.risk - b.risk || a.card - b.card);
  return scored[0]?.card ?? hand[0];
}

function submitAiCards(room) {
  if (!room || room.phase !== "playing") return;
  room.players.filter(p => p.isAi && p.hand.length > 0 && !room.submissions[p.id]).forEach(player => {
    const card = chooseAiCard(room, player);
    if (!card) return;
    player.hand.splice(player.hand.indexOf(card), 1);
    room.submissions[player.id] = card;
    player.lastAction = "AI 카드 제출 완료";
    addLog(room, `${player.name}가 카드를 냈습니다. (${Object.keys(room.submissions).length}/${room.players.length})`);
  });
}

function roomListItem(room) {
  const humanPlayers = room.players.filter(p => !p.isAi).length;
  return {
    code: room.code,
    title: room.title,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.length,
    humanPlayers,
    hostName: room.players.find(p => p.id === room.hostId)?.name || "방장",
    canJoin: room.phase === "lobby" && room.players.length < room.maxPlayers,
    message: room.message,
  };
}

function emitRoomList() {
  const list = [...rooms.values()]
    .filter(room => room.phase === "lobby")
    .map(roomListItem)
    .sort((a, b) => a.title.localeCompare(b.title, "ko"));
  io.emit("roomList", list);
}

function publicRoom(room) {
  const submissions = Object.keys(room.submissions || {}).length;
  const requiredSubmissions = room.players.length;
  return {
    code: room.code,
    title: room.title,
    hostId: room.hostId,
    phase: room.phase,
    message: room.message,
    currentHandNo: room.currentHandNo,
    currentTurnNo: room.currentTurnNo,
    totalHands: CONFIG.totalHands,
    handSize: CONFIG.handSize,
    rows: room.rows,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      handCount: p.hand.length,
      connected: p.connected,
      isAi: Boolean(p.isAi),
      submitted: Boolean(room.submissions?.[p.id]),
      lastPlayedCard: p.lastPlayedCard ?? null,
      lastAction: p.lastAction || "대기",
    })),
    turnCards: room.turnCards || [],
    submissions,
    requiredSubmissions,
    maxPlayers: room.maxPlayers,
    minPlayers: CONFIG.minPlayers,
    waitingPlayerId: room.waitingPlayerId || null,
    gameOver: room.gameOver,
  };
}

function emitRoom(room) {
  io.to(room.code).emit("roomState", publicRoom(room));
  room.players.forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit("privateState", {
        playerId: p.id,
        roomCode: room.code,
        hand: [...p.hand].sort((a, b) => a - b),
        canSubmit: !p.isAi && room.phase === "playing" && !room.submissions[p.id] && p.hand.length > 0,
        mustChooseRow: room.phase === "choosingRow" && room.waitingPlayerId === p.id,
      });
    }
  });
  emitRoomList();
}

function addLog(room, msg) {
  room.logs.unshift(`• ${msg}`);
  room.logs = room.logs.slice(0, 200);
  io.to(room.code).emit("logs", room.logs);
}


function addChat(room, sender, text) {
  const message = String(text || "").trim().slice(0, 300);
  if (!message) return null;
  const item = {
    sender: String(sender || "알림").slice(0, 20),
    text: message,
    time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
    system: sender === "알림",
  };
  room.chats = room.chats || [];
  room.chats.push(item);
  room.chats = room.chats.slice(-100);
  io.to(room.code).emit("chatHistory", room.chats);
  return item;
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function findPlacement(room, card) {
  return room.rows
    .map((row, idx) => ({ idx, last: row[row.length - 1], diff: card - row[row.length - 1] }))
    .filter(x => x.diff > 0)
    .sort((a, b) => a.diff - b.diff)[0] || null;
}

function startHand(room) {
  room.currentHandNo += 1;
  room.currentTurnNo = 1;
  room.deck = buildDeck();
  room.rows = [];
  room.submissions = {};
  room.turnCards = [];
  room.pendingPlays = [];
  room.waitingPlayerId = null;
  room.pendingCard = null;
  room.phase = "playing";
  room.message = "카드를 선택해서 내세요.";

  room.players.forEach(p => {
    p.hand = room.deck.splice(0, CONFIG.handSize).sort((a, b) => a - b);
    p.takenCards = [];
    p.lastPlayedCard = null;
    p.lastAction = p.isAi ? "AI 카드 선택 중" : "카드 선택 중";
  });
  for (let i = 0; i < CONFIG.rowCount; i++) room.rows.push([room.deck.shift()]);
  addLog(room, `${room.currentHandNo}번째 게임 시작. 시작 줄: ${room.rows.map(r => r[0]).join(", ")}`);
  submitAiCards(room);
  emitRoom(room);
  if (Object.keys(room.submissions).length >= room.players.length) startResolvingTurn(room);
}

function finishHand(room) {
  addLog(room, `${room.currentHandNo}번째 게임 종료.`);
  room.players.forEach(p => {
    p.hand = [];
    p.takenCards = [];
    p.lastPlayedCard = null;
    p.lastAction = `${room.currentHandNo}번째 게임 종료`;
  });
  if (room.currentHandNo >= CONFIG.totalHands) {
    room.phase = "finished";
    room.gameOver = true;
    const ranking = [...room.players].sort((a, b) => a.score - b.score);
    room.message = `최종 종료: ${ranking[0].name} 우승 (${ranking[0].score}점)`;
    addLog(room, "===== 최종 결과 =====");
    ranking.forEach((p, i) => addLog(room, `${i + 1}위 ${p.name} - ${p.score}점`));
    emitRoom(room);
  } else {
    room.phase = "betweenHands";
    room.message = "다음 게임을 준비합니다.";
    emitRoom(room);
    setTimeout(() => {
      if (rooms.has(room.code) && room.phase === "betweenHands") startHand(room);
    }, 1600);
  }
}

function processNextPlay(room) {
  if (!room.pendingPlays.length) {
    room.players.forEach(p => { p.lastPlayedCard = null; });
    room.currentTurnNo += 1;
    room.submissions = {};
    room.turnCards = [];
    if (room.currentTurnNo > CONFIG.handSize) finishHand(room);
    else {
      room.phase = "playing";
      room.message = "다음 턴 카드를 선택해서 내세요.";
      room.players.forEach(p => { p.lastAction = p.isAi ? "AI 카드 선택 중" : "카드 선택 중"; });
      submitAiCards(room);
      emitRoom(room);
      if (Object.keys(room.submissions).length >= room.players.length) startResolvingTurn(room);
    }
    return;
  }

  const play = room.pendingPlays.shift();
  const player = room.players.find(p => p.id === play.playerId);
  if (!player) {
    setTimeout(() => processNextPlay(room), 50);
    return;
  }
  const placement = findPlacement(room, play.card);

  if (!placement) {
    if (player.isAi) {
      const chosenRowIndex = chooseBestRowToTakeForAi(room);
      const taken = [...room.rows[chosenRowIndex]];
      const penalty = rowBullTotal(taken);
      player.score += penalty;
      player.takenCards.push(...taken);
      room.rows[chosenRowIndex] = [play.card];
      player.lastAction = `줄 ${chosenRowIndex + 1} 가져감 → +${penalty}점`;
      addLog(room, `${player.name}의 ${play.card}는 어느 줄에도 들어가지 않아 줄 ${chosenRowIndex + 1}을 가져가 ${penalty}점을 받았습니다.`);
      emitRoom(room);
      setTimeout(() => processNextPlay(room), 650);
      return;
    }
    room.phase = "choosingRow";
    room.waitingPlayerId = player.id;
    room.pendingCard = play.card;
    room.message = `${player.name}님이 가져갈 줄을 선택해야 합니다.`;
    player.lastAction = "줄 선택 대기";
    addLog(room, `${player.name}의 ${play.card}는 어느 줄에도 들어가지 않아 줄 선택이 필요합니다.`);
    emitRoom(room);
    return;
  }

  const row = room.rows[placement.idx];
  if (row.length === 5) {
    const taken = [...row];
    const penalty = rowBullTotal(taken);
    player.score += penalty;
    player.takenCards.push(...taken);
    room.rows[placement.idx] = [play.card];
    player.lastAction = `줄 ${placement.idx + 1}의 6번째 카드 → +${penalty}점`;
    addLog(room, `${player.name}의 ${play.card}가 줄 ${placement.idx + 1}의 6번째 카드가 되어 ${penalty}점을 받았습니다.`);
  } else {
    row.push(play.card);
    player.lastAction = `줄 ${placement.idx + 1}에 배치`;
  }
  emitRoom(room);
  setTimeout(() => processNextPlay(room), 650);
}

function startResolvingTurn(room) {
  if (!room || room.phase !== "playing") return;
  room.phase = "resolving";
  room.message = "카드를 낮은 숫자부터 처리 중입니다.";
  room.turnCards = Object.entries(room.submissions)
    .filter(([playerId]) => room.players.some(p => p.id === playerId))
    .map(([playerId, card]) => ({ playerId, card, name: room.players.find(p => p.id === playerId)?.name }))
    .sort((a, b) => a.card - b.card);
  room.pendingPlays = room.turnCards.map(x => ({ playerId: x.playerId, card: x.card }));
  room.players.forEach(p => {
    p.lastPlayedCard = room.submissions[p.id];
    p.lastAction = "공개됨";
  });
  addLog(room, `${room.currentTurnNo}턴 공개 카드: ${room.turnCards.map(x => `${x.name} ${x.card}`).join(", ")}`);
  emitRoom(room);
  setTimeout(() => processNextPlay(room), 700);
}


function removePlayerFromRoom(room, playerId, reason) {
  if (!room) return;
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;
  const player = room.players[idx];
  const name = player.name;

  delete room.submissions[playerId];
  room.pendingPlays = (room.pendingPlays || []).filter(play => play.playerId !== playerId);
  room.turnCards = (room.turnCards || []).filter(play => play.playerId !== playerId);

  const wasChoosingRow = room.waitingPlayerId === playerId;
  room.players.splice(idx, 1);
  addLog(room, `${name}님이 ${reason} 게임에서 제외되었습니다.`);
  addChat(room, "알림", `${name}님이 게임에서 제외되었습니다.`);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    emitRoomList();
    return;
  }

  if (room.hostId === playerId) {
    const nextHost = room.players.find(p => !p.isAi) || room.players[0];
    room.hostId = nextHost.id;
    addLog(room, `${nextHost.name}님이 새 방장이 되었습니다.`);
  }

  if (wasChoosingRow) {
    room.waitingPlayerId = null;
    room.pendingCard = null;
    room.phase = "resolving";
    room.message = "이탈한 플레이어를 제외하고 남은 카드를 처리합니다.";
    emitRoom(room);
    setTimeout(() => processNextPlay(room), 250);
    return;
  }

  submitAiCards(room);
  emitRoom(room);

  if (room.phase === "playing" && Object.keys(room.submissions).length >= room.players.length) {
    startResolvingTurn(room);
  }
}

function leaveCurrentRoom(socket, notifySelf = true) {
  const room = getRoom(socket);
  if (!room) return null;
  const code = room.code;

  if (room.phase === "lobby") {
    const player = room.players.find(p => p.id === socket.id);
    const name = player?.name || "플레이어";
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    socket.data.roomCode = null;
    if (notifySelf) socket.emit("leftRoom");

    if (room.players.length === 0) {
      rooms.delete(code);
      emitRoomList();
    } else {
      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      addLog(room, `${name}님이 로비에서 나갔습니다.`);
      addChat(room, "알림", `${name}님이 로비에서 나갔습니다.`);
      emitRoom(room);
    }
    return room;
  }

  socket.leave(code);
  socket.data.roomCode = null;
  if (notifySelf) socket.emit("leftRoom");
  removePlayerFromRoom(room, socket.id, "나가서");
  return room;
}

io.on("connection", socket => {
  socket.emit("roomList", [...rooms.values()].filter(room => room.phase === "lobby").map(roomListItem));

  socket.on("createRoom", ({ name, title, maxPlayers }, cb) => {
    if (isBlank(name)) return cb?.({ ok: false, error: "내 이름을 입력하세요." });
    if (isBlank(title)) return cb?.({ ok: false, error: "방 제목을 입력하세요." });
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = {
      code,
      title: cleanTitle(title),
      maxPlayers: normalizeMaxPlayers(maxPlayers),
      hostId: socket.id,
      phase: "lobby",
      message: "방장이 게임을 시작하면 빈 자리는 컴퓨터가 자동 참여합니다.",
      currentHandNo: 0,
      currentTurnNo: 0,
      deck: [],
      rows: [],
      players: [player],
      submissions: {},
      turnCards: [],
      pendingPlays: [],
      logs: [],
      chats: [],
      gameOver: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    addLog(room, `${player.name}님이 '${room.title}' 방을 만들었습니다. 최대 ${room.maxPlayers}명.`);
    addChat(room, "알림", `${player.name}님이 방을 만들었습니다.`);
    emitRoom(room);
    io.to(socket.id).emit("chatHistory", room.chats);
    cb?.({ ok: true, code, playerId: socket.id });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    if (isBlank(name)) return cb?.({ ok: false, error: "참여할 내 이름을 입력하세요." });
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "이미 시작된 방에는 새로 입장할 수 없습니다." });
    if (room.players.length >= room.maxPlayers) return cb?.({ ok: false, error: "방이 가득 찼습니다." });
    const player = createPlayer(socket, name);
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    addLog(room, `${player.name}님이 입장했습니다. (${room.players.length}/${room.maxPlayers})`);
    addChat(room, "알림", `${player.name}님이 입장했습니다.`);
    emitRoom(room);
    io.to(socket.id).emit("chatHistory", room.chats || []);
    cb?.({ ok: true, code, playerId: socket.id });
  });

  socket.on("startGame", (cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok: false, error: "방에 먼저 입장하세요." });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "방장만 시작할 수 있습니다." });
    const humanCount = room.players.filter(p => !p.isAi).length;
    if (humanCount < CONFIG.minHumanPlayersToStart) return cb?.({ ok: false, error: "최소 1명이 필요합니다. 빈 자리는 컴퓨터가 자동 참여합니다." });
    if (room.players.length > room.maxPlayers) return cb?.({ ok: false, error: "방 인원이 너무 많습니다." });
    ensureAiPlayers(room);
    room.players.forEach(p => { p.score = 0; p.takenCards = []; });
    room.currentHandNo = 0;
    room.gameOver = false;
    addLog(room, `${room.maxPlayers}인 실시간 게임을 시작합니다. 빈자리는 컴퓨터가 담당합니다.`);
    startHand(room);
    cb?.({ ok: true });
  });

  socket.on("submitCard", ({ card }, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "playing") return cb?.({ ok: false, error: "지금은 카드를 낼 수 없습니다." });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "플레이어를 찾을 수 없습니다." });
    card = Number(card);
    if (!player.hand.includes(card)) return cb?.({ ok: false, error: "손패에 없는 카드입니다." });
    if (room.submissions[player.id]) return cb?.({ ok: false, error: "이미 카드를 냈습니다." });
    player.hand.splice(player.hand.indexOf(card), 1);
    room.submissions[player.id] = card;
    player.lastAction = "카드 제출 완료";
    addLog(room, `${player.name}님이 카드를 냈습니다. (${Object.keys(room.submissions).length}/${room.players.length})`);
    submitAiCards(room);
    emitRoom(room);
    cb?.({ ok: true });
    if (Object.keys(room.submissions).length >= room.players.length) startResolvingTurn(room);
  });

  socket.on("chooseRow", ({ rowIndex }, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "choosingRow") return cb?.({ ok: false, error: "지금은 줄을 선택할 수 없습니다." });
    if (room.waitingPlayerId !== socket.id) return cb?.({ ok: false, error: "현재 줄 선택 차례가 아닙니다." });
    rowIndex = Number(rowIndex);
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= room.rows.length) return cb?.({ ok: false, error: "잘못된 줄입니다." });
    const player = room.players.find(p => p.id === socket.id);
    const taken = [...room.rows[rowIndex]];
    const penalty = rowBullTotal(taken);
    player.score += penalty;
    player.takenCards.push(...taken);
    room.rows[rowIndex] = [room.pendingCard];
    player.lastAction = `줄 ${rowIndex + 1} 가져감 → +${penalty}점`;
    addLog(room, `${player.name}님이 줄 ${rowIndex + 1}을 가져가 ${penalty}점을 받았습니다.`);
    room.waitingPlayerId = null;
    room.pendingCard = null;
    room.phase = "resolving";
    room.message = "남은 카드를 처리 중입니다.";
    emitRoom(room);
    cb?.({ ok: true });
    setTimeout(() => processNextPlay(room), 650);
  });

  socket.on("sendChat", ({ text }, cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok: false, error: "방에 입장한 뒤 채팅할 수 있습니다." });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "플레이어를 찾을 수 없습니다." });
    const item = addChat(room, player.name, text);
    if (!item) return cb?.({ ok: false, error: "메시지를 입력하세요." });
    cb?.({ ok: true });
  });

  socket.on("leaveRoom", (cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok: false, error: "현재 입장한 방이 없습니다." });
    leaveCurrentRoom(socket, true);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket);
    if (!room) return;
    if (room.phase === "lobby") {
      leaveCurrentRoom(socket, false);
      return;
    }
    removePlayerFromRoom(room, socket.id, "연결이 끊겨");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === "IPv4" && !x.internal).map(x => x.address);
  console.log(`젝스님트 멀티플레이 서버 실행: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`같은 와이파이/LAN 접속 주소: http://${ip}:${PORT}`));
});
