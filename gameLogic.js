const mapData = require('./data/mapData.json');

const PLAYER_COLORS = ['#00FFFF', '#FF4444', '#44FF44', '#FFFF00'];
const NEUTRAL_ID = 'neutral';
const CARD_TYPES = ['INFANTRY', 'CAVALRY', 'ARTILLERY'];
const WILD_TYPE = 'WILD';
const PLAYER_CALLSIGNS = [
  'General Alpha',
  'Commander Bravo',
  'Marshal Charlie',
  'Captain Delta',
  'Admiral Echo',
  'Colonel Foxtrot',
  'Sentinel Gamma',
  'Vanguard Helix',
];

class CardDeck {
  constructor(territories = []) {
    this.nextUid = 1;
    this.baseCards = this.buildBaseDeck(territories);
    this.drawPile = [];
    this.discardPile = [];
    this.reset();
  }

  buildBaseDeck(territories = []) {
    const deck = (territories || []).map((territory, index) => ({
      territoryId: territory.id,
      territoryName: territory.name || territory.id,
      type: CARD_TYPES[index % CARD_TYPES.length],
    }));

    // Two classic wild cards.
    deck.push({ territoryId: null, territoryName: 'Wild Card', type: WILD_TYPE });
    deck.push({ territoryId: null, territoryName: 'Wild Card', type: WILD_TYPE });
    return deck;
  }

  shuffle(cards) {
    const arr = Array.isArray(cards) ? [...cards] : [];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  reset() {
    this.drawPile = this.shuffle(this.baseCards);
    this.discardPile = [];
    this.nextUid = 1;
  }

  draw() {
    if (!this.drawPile.length && this.discardPile.length) {
      this.drawPile = this.shuffle(this.discardPile);
      this.discardPile = [];
    }
    if (!this.drawPile.length) return null;
    const card = this.drawPile.pop();
    return {
      ...card,
      uid: `card_${this.nextUid++}`,
    };
  }

  discard(cards = []) {
    cards.forEach((card) => {
      if (!card) return;
      this.discardPile.push({
        territoryId: card.territoryId || null,
        territoryName: card.territoryName || 'Unknown',
        type: card.type || WILD_TYPE,
      });
    });
  }
}

class RiskGame {
  constructor() {
    this.players = [];
    this.phase = 'LOBBY';
    this.isFirstRound = true;
    this.currentPlayerIndex = 0;
    this.lastAttack = null;
    this.lastAttackId = 0;
    this.winnerId = null;
    this.battleHistory = [];
    this.globalTradeInCount = 0;
    this.pendingCardEarned = null;
    this.deck = new CardDeck(mapData.territories || []);
    this.map = this.createFreshMap();
  }

  createFreshMap() {
    return (mapData.territories || []).map((territory) => ({
      ...JSON.parse(JSON.stringify(territory)),
      ownerId: null,
      troops: 0,
    }));
  }

  pushCapped(list, entry, cap = 50) {
    if (!Array.isArray(list)) return;
    list.push(entry);
    if (list.length > cap) {
      list.shift();
    }
  }

  getTradeInReward(tradeNumber) {
    const n = Math.max(1, Number(tradeNumber) || 1);
    if (n <= 5) return 2 * n + 2;
    return 15 + (n - 6) * 5;
  }

  isValidTradeSet(cards = []) {
    if (!Array.isArray(cards) || cards.length !== 3) return false;
    const wildCount = cards.filter((card) => card.type === WILD_TYPE).length;
    const nonWildTypes = cards
      .filter((card) => card.type && card.type !== WILD_TYPE)
      .map((card) => card.type);

    const sameType = nonWildTypes.length === 0 || new Set(nonWildTypes).size === 1;
    if (sameType) return true;

    const present = new Set(nonWildTypes);
    const missingCount = CARD_TYPES.filter((type) => !present.has(type)).length;
    return missingCount <= wildCount;
  }

  canTradeAnySet(cards = []) {
    if (!Array.isArray(cards) || cards.length < 3) return false;
    for (let i = 0; i < cards.length - 2; i += 1) {
      for (let j = i + 1; j < cards.length - 1; j += 1) {
        for (let k = j + 1; k < cards.length; k += 1) {
          if (this.isValidTradeSet([cards[i], cards[j], cards[k]])) {
            return true;
          }
        }
      }
    }
    return false;
  }

  getHandState(playerId) {
    const player = this.getPlayer(playerId);
    const hand = player && Array.isArray(player.hand) ? player.hand : [];
    const nextTradeValue = this.getTradeInReward(this.globalTradeInCount + 1);
    return {
      hand,
      handCount: hand.length,
      mustTrade: hand.length >= 5,
      canTradeAnySet: this.canTradeAnySet(hand),
      nextTradeValue,
      globalTradeInCount: this.globalTradeInCount,
    };
  }

  sanitizeDisplayName(rawName) {
    const fallback = this.getNextDisplayName();
    const safe = String(rawName || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12);
    return safe || fallback;
  }

  addPlayer(socketId, requestedName = '') {
    if (this.phase !== 'LOBBY') return false;
    if (this.players.length >= 4) return false;
    const playerId = String(socketId || '');
    if (!playerId) return false;
    if (this.players.some((player) => player.id === playerId)) return false;

    const color = PLAYER_COLORS[this.players.length % PLAYER_COLORS.length];
    const displayName = this.sanitizeDisplayName(requestedName);
    this.players.push({
      id: playerId,
      displayName,
      color,
      pool: 0,
      troops: 0,
      ready: false,
      hand: [],
      conqueredThisTurn: false,
    });
    return true;
  }

  getNextDisplayName() {
    const usedNames = new Set(this.players.map((player) => player.displayName).filter(Boolean));
    const available = PLAYER_CALLSIGNS.find((name) => !usedNames.has(name));
    if (available) return available;
    return `Commander ${this.players.length + 1}`;
  }

  removePlayer(socketId) {
    const index = this.players.findIndex((player) => player.id === socketId);
    if (index === -1) return false;
    const player = this.players[index];
    if (player && Array.isArray(player.hand) && player.hand.length) {
      this.deck.discard(player.hand);
    }

    if (this.phase !== 'LOBBY') {
      this.neutralizePlayerTerritories(socketId);
      this.players.splice(index, 1);
      if (this.players.length > 0) {
        if (index < this.currentPlayerIndex) {
          this.currentPlayerIndex -= 1;
        } else if (this.currentPlayerIndex >= this.players.length) {
          this.currentPlayerIndex = 0;
        }
      } else {
        this.currentPlayerIndex = 0;
      }
      return true;
    }

    this.players.splice(index, 1);
    return true;
  }

  neutralizePlayerTerritories(playerId) {
    this.map.forEach((territory) => {
      if (territory.ownerId === playerId) {
        territory.ownerId = NEUTRAL_ID;
      }
    });
  }

  setPlayerReady(socketId, readyValue) {
    if (this.phase !== 'LOBBY') return false;
    const player = this.getPlayer(socketId);
    if (!player) return false;
    player.ready = Boolean(readyValue);
    return true;
  }

  togglePlayerReady(socketId) {
    if (this.phase !== 'LOBBY') return false;
    const player = this.getPlayer(socketId);
    if (!player) return false;
    player.ready = !player.ready;
    return true;
  }

  areAllPlayersReady() {
    if (this.players.length < 2) return false;
    return this.players.every((player) => Boolean(player.ready));
  }

  canStartGame() {
    return this.phase === 'LOBBY' && this.areAllPlayersReady();
  }

  startGame() {
    if (!this.canStartGame()) return false;

    this.phase = 'SETUP';
    this.isFirstRound = true;
    this.winnerId = null;
    this.pendingCardEarned = null;

    const startingPool = this.getStartingPool(this.players.length);
    this.players.forEach((player) => {
      player.pool = startingPool;
      player.ready = false;
      player.conqueredThisTurn = false;
      player.hand = Array.isArray(player.hand) ? player.hand : [];
    });

    this.globalTradeInCount = 0;
    this.deck.reset();
    this.shuffleAndDistribute();
    this.currentPlayerIndex = 0;

    return true;
  }

  getStartingPool(playerCount) {
    if (playerCount === 2) return 30;
    if (playerCount === 3) return 25;
    return 20;
  }

  shuffleAndDistribute() {
    const shuffled = this.map
      .map((territory) => ({ territory, sortKey: Math.random() }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((entry) => entry.territory);

    const playerCount = this.players.length || 1;
    shuffled.forEach((territory, index) => {
      const ownerIndex = index % playerCount;
      const owner = this.players[ownerIndex];
      territory.ownerId = owner.id;
      territory.troops = 1;
    });

    this.players.forEach((player) => {
      const ownedCount = this.map.filter((t) => t.ownerId === player.id).length;
      player.pool = Math.max(0, player.pool - ownedCount);
    });
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  getPlayer(playerId) {
    return this.players.find((player) => player.id === playerId);
  }

  getTerritory(territoryId) {
    return this.map.find((territory) => territory.id === territoryId);
  }

  getContinentBonus(playerId) {
    const continents = mapData.continents || [];
    let totalBonus = 0;

    for (const continent of continents) {
      const territories = this.map.filter((t) => t.continent === continent.name);
      if (!territories.length) continue;
      const ownsAll = territories.every((t) => t.ownerId === playerId);
      if (ownsAll) totalBonus += continent.bonus || 0;
    }

    return totalBonus;
  }

  calculateReinforcements(playerId) {
    const owned = this.map.filter((t) => t.ownerId === playerId);
    let reinforcements = Math.floor(owned.length / 3);
    if (reinforcements < 3) reinforcements = 3;
    reinforcements += this.getContinentBonus(playerId);
    return reinforcements;
  }

  startNewRound() {
    this.players.forEach((player) => {
      const reinforcements = this.calculateReinforcements(player.id);
      player.pool = reinforcements;
      console.log(`Player ${player.id} receives ${reinforcements} troops`);
    });
    this.phase = 'GLOBAL_REINFORCE';
    this.currentPlayerIndex = 0;
    console.log('Starting Global Reinforcement Round');
  }

  areAllPoolsEmpty() {
    return this.players.every((player) => player.pool === 0);
  }

  deploy(playerId, territoryId, count) {
    if (this.winnerId) return false;
    const player = this.getPlayer(playerId);
    if (!player) {
      console.log('Error: Player not found for socket', playerId);
      return false;
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.id !== playerId) {
      console.log('Not your turn');
      return false;
    }

    const territory = this.getTerritory(territoryId);
    if (!territory || territory.ownerId !== playerId) {
      console.log('Not owner');
      return false;
    }

    const amount = Math.max(1, Number(count) || 0);
    if (amount > player.pool) {
      console.log('Not enough troops');
      return false;
    }

    territory.troops += amount;
    player.pool -= amount;
    console.log(`Deploy Success: Deployed ${amount} to ${territoryId}`);

    if (this.phase === 'SETUP') {
      const allPoolsEmpty = this.areAllPoolsEmpty();
      if (allPoolsEmpty) {
        this.currentPlayerIndex = 0;
        if (this.isFirstRound) {
          this.phase = 'TURN_ATTACK';
          console.log(
            'Setup Done. Starting Round 1. Phase: TURN_ATTACK (No reinforcements yet)'
          );
        } else {
          this.startNewRound();
        }
      } else if (player.pool === 0) {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
      }
      return true;
    }

    if (this.phase === 'GLOBAL_REINFORCE') {
      if (player.pool === 0) {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
        if (this.currentPlayerIndex === 0) {
          this.phase = 'TURN_ATTACK';
          this.currentPlayerIndex = 0;
          console.log('All players reinforced. Starting War Phase');
        }
      }
      return true;
    }

    return true;
  }

  nextPhase() {
    if (this.winnerId) return false;
    if (this.phase === 'GLOBAL_REINFORCE') {
      const currentPlayer = this.getCurrentPlayer();
      if (currentPlayer && currentPlayer.pool === 0) {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
        if (this.currentPlayerIndex === 0) {
          this.phase = 'TURN_ATTACK';
          console.log('All players reinforced. Starting War Phase');
        }
      } else {
        console.log('Must deploy all troops first');
      }
      return true;
    }

    if (this.phase === 'TURN_ATTACK') {
      this.phase = 'TURN_FORTIFY';
      return true;
    }

    if (this.phase === 'TURN_FORTIFY') {
      this.nextTurn();
      return true;
    }

    return true;
  }

  nextTurn() {
    if (!this.players.length) {
      this.currentPlayerIndex = 0;
      return;
    }

    this.pendingCardEarned = null;
    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer) {
      const earnedCard = this.grantTurnCardIfEligible(currentPlayer);
      if (earnedCard) {
        this.pendingCardEarned = {
          playerId: currentPlayer.id,
          card: earnedCard,
        };
      }
      currentPlayer.conqueredThisTurn = false;
    }

    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;

    if (this.currentPlayerIndex === 0) {
      if (this.isFirstRound) {
        this.isFirstRound = false;
      }
      this.startNewRound();
      return;
    }

    this.phase = 'TURN_ATTACK';
  }

  grantTurnCardIfEligible(player) {
    if (!player || !player.conqueredThisTurn) return null;
    const card = this.deck.draw();
    if (!card) return null;
    if (!Array.isArray(player.hand)) {
      player.hand = [];
    }
    player.hand.push(card);
    return card;
  }

  consumeCardEarned() {
    const reward = this.pendingCardEarned;
    this.pendingCardEarned = null;
    return reward;
  }

  tradeCards(playerId, selectedCardUids = []) {
    if (this.winnerId || this.phase === 'LOBBY') return null;
    const player = this.getPlayer(playerId);
    if (!player) return null;
    if (this.getCurrentPlayer()?.id !== playerId) return null;
    if (!Array.isArray(player.hand) || player.hand.length < 3) return null;

    const uniqueUids = [...new Set((selectedCardUids || []).map((uid) => String(uid || '')))]
      .filter(Boolean);
    if (uniqueUids.length !== 3) return null;

    const selectedCards = uniqueUids
      .map((uid) => player.hand.find((card) => card.uid === uid))
      .filter(Boolean);
    if (selectedCards.length !== 3) return null;
    if (!this.isValidTradeSet(selectedCards)) return null;

    const selectedUidSet = new Set(uniqueUids);
    player.hand = player.hand.filter((card) => !selectedUidSet.has(card.uid));
    this.deck.discard(selectedCards);

    this.globalTradeInCount += 1;
    const troopsAwarded = this.getTradeInReward(this.globalTradeInCount);
    player.pool += troopsAwarded;

    return {
      troopsAwarded,
      globalTradeInCount: this.globalTradeInCount,
      nextTradeValue: this.getTradeInReward(this.globalTradeInCount + 1),
    };
  }

  getPlayerTerritoryCount(playerId) {
    return this.map.reduce((count, territory) => count + (territory.ownerId === playerId ? 1 : 0), 0);
  }

  checkForWinner(playerId) {
    if (!playerId) return null;
    if (this.getPlayerTerritoryCount(playerId) >= this.map.length) {
      this.winnerId = playerId;
      return playerId;
    }
    return null;
  }

  attack(playerId, fromId, toId, attackTroopCount) {
    if (this.winnerId) {
      return null;
    }
    if (this.phase !== 'TURN_ATTACK') {
      return null;
    }
    if (this.getCurrentPlayer()?.id !== playerId) {
      return null;
    }

    const from = this.getTerritory(fromId);
    const to = this.getTerritory(toId);
    if (!from || !to) {
      return null;
    }

    const isNeutralTarget = to.ownerId === NEUTRAL_ID;
    const isEnemyPlayerTarget = Boolean(to.ownerId) && to.ownerId !== playerId;
    if (from.ownerId !== playerId || (!isNeutralTarget && !isEnemyPlayerTarget)) {
      return null;
    }

    if (!(from.neighbors || []).includes(toId)) {
      return null;
    }

    const maxAttackable = (from.troops || 0) - 1;
    if (maxAttackable < 1) {
      return null;
    }

    const requested = Number(attackTroopCount);
    if (!Number.isFinite(requested) || requested < 1) {
      return null;
    }

    if (requested > maxAttackable) {
      return null;
    }

    if (requested > 3) {
      return null;
    }

    const attackerDiceCount = requested;
    const defenderDiceCount = (to.troops || 0) >= 2 ? 2 : 1;

    const rollDice = (count) =>
      Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1).sort(
        (a, b) => b - a
      );

    const attackerDice = rollDice(attackerDiceCount);
    const defenderDice = rollDice(defenderDiceCount);

    let attackerLosses = 0;
    let defenderLosses = 0;

    const comparisons = Math.min(attackerDice.length, defenderDice.length);
    for (let i = 0; i < comparisons; i += 1) {
      if (attackerDice[i] > defenderDice[i]) {
        defenderLosses += 1;
      } else {
        attackerLosses += 1;
      }
    }

    from.troops -= attackerLosses;
    to.troops -= defenderLosses;

    let conquered = false;
    let winnerId = null;
    if (to.troops <= 0) {
      conquered = true;
      to.ownerId = playerId;
      const attackerPlayer = this.getPlayer(playerId);
      if (attackerPlayer) {
        attackerPlayer.conqueredThisTurn = true;
      }
      const survivors = Math.max(0, requested - attackerLosses);
      const moveCount = Math.max(1, survivors);
      from.troops -= moveCount;
      to.troops = moveCount;
      winnerId = this.checkForWinner(playerId);
      console.log('Conquered! Moved troops');
    } else {
      console.log(`Battle result: Attacker lost ${attackerLosses}, Defender lost ${defenderLosses}`);
    }

    this.lastAttackId += 1;
    this.lastAttack = {
      id: this.lastAttackId,
      attackerId: playerId,
      fromId,
      toId,
      attackTroopCount: attackerDiceCount,
      attackerDice,
      defenderDice,
      attackerLosses,
      defenderLosses,
      conquered,
      winnerId,
    };
    this.pushCapped(this.battleHistory, this.lastAttack, 50);

    return {
      attackerDice,
      defenderDice,
      attackTroopCount: attackerDiceCount,
      attackerLosses,
      defenderLosses,
      conquered,
      winnerId,
    };
  }

  isConnected(playerId, fromId, toId) {
    const ownedIds = new Set(
      this.map.filter((t) => t.ownerId === playerId).map((t) => t.id)
    );

    if (!ownedIds.has(fromId) || !ownedIds.has(toId)) return false;

    const queue = [fromId];
    const visited = new Set([fromId]);

    while (queue.length) {
      const currentId = queue.shift();
      if (currentId === toId) return true;

      const current = this.getTerritory(currentId);
      if (!current) continue;

      for (const neighborId of current.neighbors || []) {
        if (!ownedIds.has(neighborId) || visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    return false;
  }

  fortify(playerId, fromId, toId, count) {
    if (this.winnerId) return false;
    if (this.phase !== 'TURN_FORTIFY') return false;
    if (this.getCurrentPlayer()?.id !== playerId) return false;
    if (!fromId || !toId || fromId === toId) return false;

    const from = this.getTerritory(fromId);
    const to = this.getTerritory(toId);
    if (!from || !to) return false;
    if (from.ownerId !== playerId || to.ownerId !== playerId) return false;
    if (!this.isConnected(playerId, fromId, toId)) return false;

    const moveCount = Math.max(1, Number(count) || 1);
    if ((from.troops || 0) <= moveCount) return false;

    from.troops -= moveCount;
    to.troops += moveCount;

    this.nextTurn();
    return true;
  }

  resetGame() {
    const lobbyPlayers = this.players.map((player) => ({
      id: String(player.id || ''),
      displayName: player.displayName,
      color: player.color,
      pool: 0,
      troops: 0,
      ready: false,
      hand: [],
      conqueredThisTurn: false,
    }));

    this.phase = 'LOBBY';
    this.isFirstRound = true;
    this.currentPlayerIndex = 0;
    this.lastAttack = null;
    this.lastAttackId = 0;
    this.winnerId = null;
    this.battleHistory = [];
    this.globalTradeInCount = 0;
    this.pendingCardEarned = null;

    // Drop old references to help GC reclaim previous match state.
    this.map = [];
    this.players = [];

    this.deck.reset();
    this.map = this.createFreshMap();
    this.players = lobbyPlayers.filter((player) => Boolean(player.id));
  }

  getState() {
    const playerSnapshots = this.players.map((player) => {
      const troops = this.map.reduce(
        (total, territory) => total + (territory.ownerId === player.id ? territory.troops : 0),
        0
      );
      return {
        id: player.id,
        displayName: player.displayName,
        color: player.color,
        pool: player.pool,
        ready: player.ready,
        troops,
        handCount: Array.isArray(player.hand) ? player.hand.length : 0,
      };
    });

    return {
      map: this.map,
      players: playerSnapshots,
      phase: this.phase,
      currentPlayerId: this.getCurrentPlayer() ? this.getCurrentPlayer().id : null,
      lastAttack: this.lastAttack,
      winnerId: this.winnerId,
      winnerName: this.winnerId ? this.getPlayer(this.winnerId)?.displayName || null : null,
      allPlayersReady: this.areAllPlayersReady(),
      canStartGame: this.canStartGame(),
      neutralId: NEUTRAL_ID,
      nextTradeValue: this.getTradeInReward(this.globalTradeInCount + 1),
      globalTradeInCount: this.globalTradeInCount,
    };
  }
}

module.exports = RiskGame;
