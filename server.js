const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const RiskGame = require('./gameLogic');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});

const game = new RiskGame();
let activeBattle = null;
let activeBattleTimeout = null;
const INACTIVITY_LIMIT = 300000;
const TURN_LIMIT = 60000;
const BATTLE_COMMIT_LIMIT = 15000;
let gameTimeout = null;
let turnTimeout = null;
let memoryMonitorInterval = null;
let selfPingInterval = null;
let turnTimerEndsAt = null;
let lastTurnTimerKey = null;
let isMassKicking = false;
const SERVER_EVENT_CAP = 50;
const SELF_PING_INTERVAL = 10 * 60 * 1000;
const serverEventHistory = [];

const pushCapped = (list, entry, cap = 50) => {
  if (!Array.isArray(list)) return;
  list.push(entry);
  if (list.length > cap) {
    list.shift();
  }
};

const emitHandsToPlayers = () => {
  game.players.forEach((player) => {
    io.to(player.id).emit('update_hand', game.getHandState(player.id));
  });
};

const emitCardEarnedIfAny = () => {
  const reward = typeof game.consumeCardEarned === 'function' ? game.consumeCardEarned() : null;
  if (!reward || !reward.playerId || !reward.card) return;
  io.to(reward.playerId).emit('card_earned', {
    uid: reward.card.uid,
    type: reward.card.type,
    territoryId: reward.card.territoryId || null,
    territoryName: reward.card.territoryName || 'Unknown Territory',
  });
};

const emitGameUpdateToAll = () => {
  pruneInactivePlayers();
  io.emit('game_update', {
    ...game.getState(),
    turnTimerEndsAt,
    turnTimerDurationMs: TURN_LIMIT,
    serverNowMs: Date.now(),
  });
  emitHandsToPlayers();
};

const isBattlePending = () => activeBattle !== null;

const clearActiveBattleTimeout = () => {
  if (activeBattleTimeout) {
    clearTimeout(activeBattleTimeout);
    activeBattleTimeout = null;
  }
};

const clearActiveBattle = () => {
  clearActiveBattleTimeout();
  activeBattle = null;
};

const isSocketConnected = (socketId) => Boolean(socketId) && io.sockets.sockets.has(socketId);

const emitCombatArenaOpened = () => {
  if (!activeBattle) return;
  io.emit('combat_arena_opened', {
    battleId: activeBattle.battleId,
    attackerId: activeBattle.attackerId,
    defenderId: activeBattle.defenderId,
    attackerName: game.getPlayer(activeBattle.attackerId)?.displayName || null,
    defenderName: game.getPlayer(activeBattle.defenderId)?.displayName || null,
    fromId: activeBattle.fromId,
    toId: activeBattle.toId,
    fromName: activeBattle.fromName,
    toName: activeBattle.toName,
    maxAttackerDice: activeBattle.maxAttackerDice,
    maxDefenderDice: activeBattle.maxDefenderDice,
    attackerRolled: activeBattle.attackerRolled,
    defenderRolled: activeBattle.defenderRolled,
    defenderAuto: activeBattle.defenderAuto,
  });
};

const emitCombatArenaUpdate = () => {
  if (!activeBattle) return;
  io.emit('combat_arena_update', {
    battleId: activeBattle.battleId,
    attackerRolled: activeBattle.attackerRolled,
    defenderRolled: activeBattle.defenderRolled,
  });
};

const resolveActiveBattle = ({ reason = 'both_committed' } = {}) => {
  if (!activeBattle) return;
  const battle = activeBattle;
  clearActiveBattle();

  const attackerDiceCount = battle.attackerDice || battle.maxAttackerDice;
  const defenderDiceCount = battle.defenderDice || battle.maxDefenderDice;
  const result = game.resolveAttack(
    battle.attackerId,
    battle.fromId,
    battle.toId,
    attackerDiceCount,
    defenderDiceCount
  );
  if (!result) {
    io.emit('battle_cancelled');
    refreshTurnTimer({ force: true });
    emitGameUpdateToAll();
    return;
  }

  const payload = {
    battleId: game.lastAttack ? game.lastAttack.id : battle.battleId,
    attackerId: battle.attackerId,
    defenderId: battle.defenderId,
    fromId: battle.fromId,
    toId: battle.toId,
    attackerDice: result.attackerDice,
    defenderDice: result.defenderDice,
    newMapState: game.getState().map,
    attackTroopCount: result.attackTroopCount,
    defendTroopCount: result.defendTroopCount,
    attackerLosses: result.attackerLosses,
    defenderLosses: result.defenderLosses,
    conquered: result.conquered,
    winnerId: result.winnerId || null,
    winnerName: result.winnerId ? game.getPlayer(result.winnerId)?.displayName || null : null,
    resolutionReason: reason,
  };
  pushCapped(
    serverEventHistory,
    {
      type: 'battle_resolved',
      at: Date.now(),
      battleId: payload.battleId,
      attackerId: payload.attackerId,
      defenderId: payload.defenderId,
      reason,
    },
    SERVER_EVENT_CAP
  );

  resetInactivityTimer();
  io.emit('battle_result', payload);

  const winnerPayload = payload.winnerId
    ? {
        winnerId: payload.winnerId,
        winnerName: payload.winnerName,
      }
    : null;

  refreshTurnTimer({ force: true });
  emitGameUpdateToAll();
  if (winnerPayload) {
    io.emit('game_over', winnerPayload);
  }
};

const maybeResolveActiveBattle = (reason) => {
  if (!activeBattle) return;
  if (!activeBattle.attackerRolled || !activeBattle.defenderRolled) return;
  resolveActiveBattle({ reason });
};

const pruneInactivePlayers = () => {
  const activeSockets = io.sockets.sockets;
  const staleIds = game.players
    .map((player) => player.id)
    .filter((playerId) => !activeSockets.has(playerId));

  if (!staleIds.length) return false;
  if (activeBattle) {
    if (staleIds.includes(activeBattle.attackerId)) {
      clearActiveBattle();
      io.emit('battle_cancelled');
    } else if (staleIds.includes(activeBattle.defenderId)) {
      activeBattle.defenderRolled = true;
      activeBattle.defenderDice = activeBattle.maxDefenderDice;
      activeBattle.defenderAuto = true;
      emitCombatArenaUpdate();
      maybeResolveActiveBattle('defender_disconnected');
    }
  }
  staleIds.forEach((playerId) => {
    game.removePlayer(playerId);
  });

  if (game.players.length === 0 && game.phase !== 'LOBBY') {
    clearActiveBattle();
    game.resetGame();
    clearAllTimers();
    return true;
  }

  if (game.phase !== 'LOBBY' && game.players.length === 1 && !game.winnerId) {
    const winner = game.players[0];
    clearActiveBattle();
    game.winnerId = winner.id;
    io.emit('game_over', {
      winnerId: winner.id,
      winnerName: winner.displayName,
      reason: 'last_player_standing',
    });
    clearAllTimers();
  }
  return true;
};
const shouldRunTurnTimer = () =>
  !isBattlePending() &&
  !game.winnerId &&
  game.players.length >= 2 &&
  (game.phase === 'TURN_ATTACK' || game.phase === 'TURN_FORTIFY');

const clearTurnTimer = () => {
  if (turnTimeout) {
    clearTimeout(turnTimeout);
    turnTimeout = null;
  }
};

const clearAllTimers = () => {
  clearTurnTimer();
  clearInactivityTimer();
  clearActiveBattleTimeout();
  turnTimerEndsAt = null;
  lastTurnTimerKey = null;
};

const getTurnTimerKey = () => `${game.phase}:${game.currentPlayerIndex}`;

const refreshTurnTimer = ({ force = false } = {}) => {
  pruneInactivePlayers();
  if (!shouldRunTurnTimer()) {
    clearTurnTimer();
    turnTimerEndsAt = null;
    lastTurnTimerKey = null;
    return;
  }

  const key = getTurnTimerKey();
  if (!force && turnTimeout && lastTurnTimerKey === key) {
    return;
  }

  clearTurnTimer();
  lastTurnTimerKey = key;
  turnTimerEndsAt = Date.now() + TURN_LIMIT;
  turnTimeout = setTimeout(() => {
    turnTimeout = null;
    turnTimerEndsAt = null;

    if (!shouldRunTurnTimer()) {
      refreshTurnTimer({ force: true });
      emitGameUpdateToAll();
      return;
    }

    const timedOutPlayerId = game.getCurrentPlayer() ? game.getCurrentPlayer().id : null;
    game.nextPhase();
    emitCardEarnedIfAny();
    io.emit('turn_skipped', { playerId: timedOutPlayerId });
    refreshTurnTimer({ force: true });
    emitGameUpdateToAll();
    resetInactivityTimer();
  }, TURN_LIMIT);
};

const clearInactivityTimer = () => {
  if (gameTimeout) {
    clearTimeout(gameTimeout);
    gameTimeout = null;
  }
};

const resetInactivityTimer = () => {
  clearInactivityTimer();
  gameTimeout = setTimeout(() => {
    isMassKicking = true;
    clearActiveBattle();
    pushCapped(serverEventHistory, { type: 'inactivity_kick', at: Date.now() }, SERVER_EVENT_CAP);
    io.emit('server_message', 'Kicked for inactivity');
    clearAllTimers();
    game.resetGame();
    io.disconnectSockets(true);
    game.players = [];
    emitGameUpdateToAll();
    isMassKicking = false;
  }, INACTIVITY_LIMIT);
};

io.on('connection', (socket) => {
  console.log('New player connected');
  const releaseSocketReferences = () => {
    socket.removeAllListeners();
    socket.data = {};
  };

  const handlePlayerExit = () => {
    if (socket.data.cleanedUp) return;
    socket.data.cleanedUp = true;

    if (isMassKicking) {
      game.removePlayer(socket.id);
      releaseSocketReferences();
      return;
    }

    let clearedPendingBattle = false;
    if (activeBattle && socket.id === activeBattle.attackerId) {
      clearActiveBattle();
      clearedPendingBattle = true;
      io.emit('battle_cancelled');
    } else if (activeBattle && socket.id === activeBattle.defenderId) {
      activeBattle.defenderRolled = true;
      activeBattle.defenderDice = activeBattle.maxDefenderDice;
      activeBattle.defenderAuto = true;
      emitCombatArenaUpdate();
      maybeResolveActiveBattle('defender_disconnected');
    }

    const removed = game.removePlayer(socket.id);

    if (!removed) {
      if (clearedPendingBattle) {
        refreshTurnTimer({ force: true });
        emitGameUpdateToAll();
      }
      releaseSocketReferences();
      return;
    }

    if (game.players.length === 0 || game.phase === 'LOBBY') {
      clearAllTimers();
      if (game.players.length === 0 && game.phase !== 'LOBBY') {
        clearActiveBattle();
        game.resetGame();
      }
    } else if (game.phase !== 'LOBBY' && game.players.length === 1 && !game.winnerId) {
      const winner = game.players[0];
      clearActiveBattle();
      game.winnerId = winner.id;
      io.emit('game_over', {
        winnerId: winner.id,
        winnerName: winner.displayName,
        reason: 'last_player_standing',
      });
      clearAllTimers();
    } else {
      resetInactivityTimer();
    }

    refreshTurnTimer({ force: true });
    emitGameUpdateToAll();
    releaseSocketReferences();
  };

  socket.on('join_game', ({ displayName } = {}) => {
    const success = game.addPlayer(socket.id, displayName);
    if (success) {
      refreshTurnTimer({ force: true });
      emitGameUpdateToAll();
    } else {
      socket.emit('error_message', 'Game already in progress');
    }
  });

  socket.on('leave_lobby', () => {
    const removed = game.removePlayer(socket.id);
    if (removed) {
      refreshTurnTimer({ force: true });
      emitGameUpdateToAll();
    }
  });

  socket.on('leave_game', () => {
    handlePlayerExit();
    socket.disconnect(true);
  });

  socket.on('toggle_ready', () => {
    const changed = game.togglePlayerReady(socket.id);
    if (!changed) return;
    refreshTurnTimer({ force: true });
    emitGameUpdateToAll();
  });

  socket.on('start_game', () => {
    if (!game.players[0] || game.players[0].id !== socket.id) {
      socket.emit('error_message', 'Only the host can start the game');
      return;
    }
    if (!game.canStartGame()) {
      socket.emit('error_message', 'All players must be ready (minimum 2 players)');
      return;
    }

    const started = game.startGame();
    if (!started) return;
    clearAllTimers();
    resetInactivityTimer();
    refreshTurnTimer({ force: true });
    emitGameUpdateToAll();
  });

  socket.on('deploy', ({ territoryId, count }) => {
    if (isBattlePending()) return;
    const deployed = game.deploy(socket.id, territoryId, count);
    if (deployed) {
      resetInactivityTimer();
    }
    refreshTurnTimer();
    emitGameUpdateToAll();
  });

  socket.on('initiate_attack', ({ fromId, toId } = {}) => {
    if (isBattlePending()) return;
    const prepared = game.prepareAttack(socket.id, fromId, toId);
    if (!prepared) return;

    activeBattle = {
      battleId: `battle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      attackerId: socket.id,
      defenderId: prepared.defenderId,
      fromId: prepared.fromId,
      toId: prepared.toId,
      fromName: prepared.fromTerritoryName,
      toName: prepared.toTerritoryName,
      maxAttackerDice: prepared.maxAttackerDice,
      maxDefenderDice: prepared.maxDefenderDice,
      attackerRolled: false,
      defenderRolled: false,
      attackerDice: 0,
      defenderDice: 0,
      defenderAuto: false,
    };

    pushCapped(
      serverEventHistory,
      {
        type: 'battle_opened',
        at: Date.now(),
        battleId: activeBattle.battleId,
        attackerId: activeBattle.attackerId,
        defenderId: activeBattle.defenderId,
      },
      SERVER_EVENT_CAP
    );

    const defenderPlayer = game.getPlayer(activeBattle.defenderId);
    const shouldAutoDefender =
      activeBattle.defenderId === 'neutral' ||
      !defenderPlayer ||
      !isSocketConnected(activeBattle.defenderId);
    if (shouldAutoDefender) {
      activeBattle.defenderRolled = true;
      activeBattle.defenderDice = activeBattle.maxDefenderDice;
      activeBattle.defenderAuto = true;
    }

    emitCombatArenaOpened();
    emitCombatArenaUpdate();
    refreshTurnTimer({ force: true });

    clearActiveBattleTimeout();
    activeBattleTimeout = setTimeout(() => {
      if (!activeBattle) return;
      if (!activeBattle.attackerRolled) {
        activeBattle.attackerRolled = true;
        activeBattle.attackerDice = activeBattle.maxAttackerDice;
      }
      if (!activeBattle.defenderRolled) {
        activeBattle.defenderRolled = true;
        activeBattle.defenderDice = activeBattle.maxDefenderDice;
        activeBattle.defenderAuto = true;
      }
      emitCombatArenaUpdate();
      resolveActiveBattle({ reason: 'timeout_autoroll' });
    }, BATTLE_COMMIT_LIMIT);
    if (typeof activeBattleTimeout.unref === 'function') {
      activeBattleTimeout.unref();
    }
    maybeResolveActiveBattle('defender_auto');
  });

  socket.on('fortify', ({ fromId, toId, count }) => {
    if (isBattlePending()) return;
    const fortified = game.fortify(socket.id, fromId, toId, count);
    if (fortified) {
      resetInactivityTimer();
      emitCardEarnedIfAny();
    }
    refreshTurnTimer();
    emitGameUpdateToAll();
  });

  socket.on('end_phase', () => {
    if (isBattlePending()) return;
    const advanced = game.nextPhase();
    if (advanced) {
      resetInactivityTimer();
      emitCardEarnedIfAny();
    }
    refreshTurnTimer();
    emitGameUpdateToAll();
  });

  socket.on('trade_cards', ({ cardUids } = {}) => {
    if (isBattlePending()) return;
    const trade = game.tradeCards(socket.id, cardUids);
    if (!trade) {
      socket.emit('error_message', 'Invalid card set. Select a valid set of 3 cards.');
      return;
    }

    resetInactivityTimer();
    io.emit('cards_traded', {
      playerId: socket.id,
      playerName: game.getPlayer(socket.id)?.displayName || null,
      troopsAwarded: trade.troopsAwarded,
      globalTradeInCount: trade.globalTradeInCount,
      nextTradeValue: trade.nextTradeValue,
    });
    refreshTurnTimer();
    emitGameUpdateToAll();
  });

  socket.on('commit_roll', ({ battleId, dice } = {}) => {
    if (!activeBattle) return;
    if (battleId && activeBattle.battleId && battleId !== activeBattle.battleId) return;
    const requestedDice = Number(dice);
    if (!Number.isFinite(requestedDice)) return;

    if (socket.id === activeBattle.attackerId) {
      const capped = Math.max(1, Math.min(activeBattle.maxAttackerDice, requestedDice));
      activeBattle.attackerDice = capped;
      activeBattle.attackerRolled = true;
    } else if (socket.id === activeBattle.defenderId && !activeBattle.defenderAuto) {
      const capped = Math.max(1, Math.min(activeBattle.maxDefenderDice, requestedDice));
      activeBattle.defenderDice = capped;
      activeBattle.defenderRolled = true;
    } else {
      return;
    }
    resetInactivityTimer();
    emitCombatArenaUpdate();
    maybeResolveActiveBattle('both_committed');
  });

  socket.on('return_to_lobby', () => {
    clearActiveBattle();
    clearAllTimers();
    game.resetGame();
    io.emit('game_reset', 'Partida reiniciada al lobby');
    refreshTurnTimer({ force: true });
    emitGameUpdateToAll();
  });

  socket.on('disconnect', () => {
    handlePlayerExit();
  });
});

const startMemoryMonitor = () => {
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
    memoryMonitorInterval = null;
  }
  memoryMonitorInterval = setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`The script uses approximately ${Math.round(used * 100) / 100} MB`);
  }, 10 * 60 * 1000);
  if (typeof memoryMonitorInterval.unref === 'function') {
    memoryMonitorInterval.unref();
  }
};

const getSelfPingUrl = () =>
  process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '';

const runSelfPing = () => {
  const rawUrl = getSelfPingUrl();
  if (!rawUrl) return;

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch (error) {
    console.warn(`[self-ping] Invalid URL: ${rawUrl}`);
    return;
  }

  const client = targetUrl.protocol === 'https:' ? https : http;
  const request = client.get(
    targetUrl,
    {
      timeout: 10000,
      headers: {
        'User-Agent': 'riskgame-self-ping/1.0',
      },
    },
    (response) => {
      response.resume();
    }
  );

  request.on('timeout', () => {
    request.destroy(new Error('timeout'));
  });

  request.on('error', (error) => {
    console.warn(`[self-ping] Request failed: ${error.message}`);
  });
};

const startSelfPing = () => {
  if (selfPingInterval) {
    clearInterval(selfPingInterval);
    selfPingInterval = null;
  }

  const targetUrl = getSelfPingUrl();
  if (!targetUrl) {
    console.log('[self-ping] Disabled (no SELF_PING_URL / RENDER_EXTERNAL_URL configured)');
    return;
  }

  runSelfPing();
  selfPingInterval = setInterval(runSelfPing, SELF_PING_INTERVAL);
  if (typeof selfPingInterval.unref === 'function') {
    selfPingInterval.unref();
  }
};

server.listen(3000, () => {
  console.log('Server listening on port 3000');
  startMemoryMonitor();
  startSelfPing();
});
