const express = require('express');
const http = require('http');
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
});

const game = new RiskGame();
let pendingBattle = null;

const emitGameUpdateToAll = () => {
  io.emit('game_update', game.getState());
};

const isBattlePending = () => pendingBattle !== null;

io.on('connection', (socket) => {
  console.log('New player connected');

  socket.on('join_game', () => {
    const success = game.addPlayer(socket.id);
    if (success) {
      emitGameUpdateToAll();
    } else {
      socket.emit('error_message', 'Game already in progress');
    }
  });

  socket.on('leave_lobby', () => {
    const removed = game.removePlayer(socket.id);
    if (removed) {
      emitGameUpdateToAll();
    }
  });

  socket.on('start_game', () => {
    if (!game.players[0] || game.players[0].id !== socket.id) {
      socket.emit('error_message', 'Only the host can start the game');
      return;
    }

    game.startGame();
    emitGameUpdateToAll();
  });

  socket.on('deploy', ({ territoryId, count }) => {
    if (isBattlePending()) return;
    game.deploy(socket.id, territoryId, count);
    emitGameUpdateToAll();
  });

  socket.on('attack', ({ fromId, toId, dice }) => {
    if (isBattlePending()) return;

    const targetTerritory = game.getTerritory(toId);
    const defenderId = targetTerritory ? targetTerritory.ownerId : null;
    const result = game.attack(socket.id, fromId, toId, dice);
    if (!result) {
      return;
    }

    pendingBattle = {
      battleId: game.lastAttack ? game.lastAttack.id : null,
      attackerId: socket.id,
      defenderId,
      attackerDice: result.attackerDice,
      defenderDice: result.defenderDice,
      newMapState: game.getState().map,
      attackTroopCount: result.attackTroopCount,
      attackerLosses: result.attackerLosses,
      defenderLosses: result.defenderLosses,
      conquered: result.conquered,
    };

    const readyPayload = {
      battleId: pendingBattle.battleId,
      attackerId: pendingBattle.attackerId,
      defenderId: pendingBattle.defenderId,
      fromId,
      toId,
    };
    io.to(pendingBattle.attackerId).emit('battle_ready', readyPayload);
    if (pendingBattle.defenderId && pendingBattle.defenderId !== pendingBattle.attackerId) {
      io.to(pendingBattle.defenderId).emit('battle_ready', readyPayload);
    }
  });

  socket.on('fortify', ({ fromId, toId, count }) => {
    if (isBattlePending()) return;
    game.fortify(socket.id, fromId, toId, count);
    emitGameUpdateToAll();
  });

  socket.on('end_phase', () => {
    if (isBattlePending()) return;
    game.nextPhase();
    emitGameUpdateToAll();
  });

  socket.on('trigger_roll', ({ battleId }) => {
    if (!pendingBattle) return;
    if (socket.id !== pendingBattle.attackerId) return;
    if (battleId && pendingBattle.battleId && battleId !== pendingBattle.battleId) return;

    io.emit('battle_anim', {
      battleId: pendingBattle.battleId,
      attackerId: pendingBattle.attackerId,
      defenderId: pendingBattle.defenderId,
      attackerDice: pendingBattle.attackerDice,
      defenderDice: pendingBattle.defenderDice,
      newMapState: pendingBattle.newMapState,
      attackTroopCount: pendingBattle.attackTroopCount,
      attackerLosses: pendingBattle.attackerLosses,
      defenderLosses: pendingBattle.defenderLosses,
      conquered: pendingBattle.conquered,
    });

    pendingBattle = null;
    emitGameUpdateToAll();
  });

  socket.on('disconnect', () => {
    let clearedPendingBattle = false;
    if (pendingBattle && socket.id === pendingBattle.attackerId) {
      pendingBattle = null;
      clearedPendingBattle = true;
      io.emit('battle_cancelled');
    }
    const removed = game.removePlayer(socket.id);
    if (removed) {
      emitGameUpdateToAll();
      return;
    }
    if (clearedPendingBattle) {
      emitGameUpdateToAll();
    }
  });
});

server.listen(3000, () => {
  console.log('Server listening on port 3000');
});
