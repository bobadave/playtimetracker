const playerListEl = document.getElementById('player-list');
const stageEl = document.getElementById('stage');
const gameIdDisplayEl = document.getElementById('game-id-display');
const gameNameDisplayEl = document.getElementById('game-name-display');
const gameMetaDisplayEl = document.getElementById('game-meta-display');
const gameToggleBtn = document.getElementById('game-toggle-btn');
const gameFormEl = document.getElementById('game-form');
let isGameActive = true;

function getCurrentGameId() {
  const match = window.location.pathname.match(/\/games\/(\d+)/);
  return match ? Number(match[1]) : 1;
}

async function fetchCurrentGame() {
  const gameId = getCurrentGameId();
  const response = await fetch(`/api/game/${gameId}`);
  if (!response.ok) {
    throw new Error('Unable to load current game.');
  }

  return response.json();
}

async function fetchPlayers() {
  const gameId = getCurrentGameId();
  const response = await fetch(`/api/players/${gameId}`);
  if (!response.ok) {
    throw new Error('Unable to load players.');
  }

  return response.json();
}

function formatMinutes(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getSharePercentage(playerSeconds, totalSeconds) {
  if (!Number.isFinite(Number(playerSeconds)) || !Number.isFinite(Number(totalSeconds)) || Number(totalSeconds) <= 0) {
    return 0;
  }

  return (Number(playerSeconds) / Number(totalSeconds)) * 100;
}

function getRelativePlayLevel(playerSeconds, players) {
  const values = players.map((player) => Number(player.totalSeconds) || 0);
  if (!values.length) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return 0;
  }

  return (Number(playerSeconds) - mean) / stdDev;
}

function getPlayHighlightClass(playerSeconds, players) {
  const zScore = getRelativePlayLevel(playerSeconds, players);

  if (zScore <= -1.25) {
    return 'play-low';
  }

  if (zScore <= -0.5) {
    return 'play-medium';
  }

  return '';
}

function formatPercent(playerSeconds, totalSeconds) {
  return `${getSharePercentage(playerSeconds, totalSeconds).toFixed(1)}%`;
}

function attachDragHandlers(element, playerId) {
  element.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', String(playerId));
    event.dataTransfer.effectAllowed = 'move';
  });
}

function renderGameHeader(game) {
  const gameId = game && game.id ? game.id : '--';
  const gameName = game && game.name ? game.name : 'Untitled Game';
  const location = game && game.location ? game.location : 'TBD';
  const date = game && game.date ? game.date : 'TBD';

  gameNameDisplayEl.textContent = `Game: ${gameName}`;
  gameIdDisplayEl.textContent = `Game ID: ${gameId}`;
  gameMetaDisplayEl.textContent = `Location: ${location} • ${date}`;
  isGameActive = !!(game && Number(game.is_active) !== 0);
  gameToggleBtn.textContent = isGameActive ? 'Game End' : 'Game Resume';
  gameToggleBtn.classList.toggle('resume', !isGameActive);
  gameToggleBtn.setAttribute('aria-pressed', String(!isGameActive));
  stageEl.classList.toggle('disabled', !isGameActive);
  stageEl.setAttribute('aria-disabled', String(!isGameActive));
}

function renderPlayers(players) {
  const activePlayers = players.filter((player) => player.inStage);
  const orderedPlayers = [...players].sort((a, b) => {
    if (Number(a.inStage) !== Number(b.inStage)) {
      return Number(a.inStage) - Number(b.inStage);
    }

    if (!a.inStage && !b.inStage) {
      return (Number(a.totalSeconds) || 0) - (Number(b.totalSeconds) || 0);
    }

    return 0;
  });
  const totalGameSeconds = players.reduce((sum, player) => sum + (Number(player.totalSeconds) || 0), 0);

  stageEl.innerHTML = '';

  if (activePlayers.length === 0) {
    stageEl.classList.add('is-empty');
    stageEl.innerHTML = '<div class="empty-state">Drop players on to field to track play time.</div>';
  } else {
    stageEl.classList.remove('is-empty');

    activePlayers.forEach((player) => {
      const stagePlayer = document.createElement('div');
      const uiClass = getPlayHighlightClass(player.totalSeconds, players);
      stagePlayer.className = 'stage-player';
      if (uiClass) {
        stagePlayer.classList.add(uiClass);
      }
      stagePlayer.draggable = true;
      stagePlayer.innerHTML = `
        <div class="player-meta">
          <span class="player-name">${player.fullName}</span>
          <span class="status-pill active">On field</span>
        </div>
        <div class="time-box">
          <div class="metric-group">
            <span class="time-label">Share</span>
            <span class="time-value">${formatPercent(player.totalSeconds, totalGameSeconds)}</span>
          </div>
          <div class="metric-group">
            <span class="time-label">Time</span>
            <span class="time-value">${formatMinutes(player.totalSeconds)}</span>
          </div>
        </div>
      `;
      attachDragHandlers(stagePlayer, player.id);
      stageEl.appendChild(stagePlayer);
    });
  }

  playerListEl.innerHTML = '';

  orderedPlayers.forEach((player) => {
    const playerCard = document.createElement('div');
    const uiClass = getPlayHighlightClass(player.totalSeconds, players);
    playerCard.className = `player-card ${player.inStage ? 'active' : ''}`;
    if (uiClass) {
      playerCard.classList.add(uiClass);
    }
    playerCard.draggable = true;
    playerCard.innerHTML = `
      <div class="player-meta">
        <span class="player-name">${player.fullName}</span>
        <span class="status-pill ${player.inStage ? 'active' : 'inactive'}">${player.inStage ? 'On field' : 'Bench'}</span>
      </div>
      <div class="time-box">
        <div class="metric-group">
          <span class="time-label">Share</span>
          <span class="time-value">${formatPercent(player.totalSeconds, totalGameSeconds)}</span>
        </div>
        <div class="metric-group">
          <span class="time-label">Time</span>
          <span class="time-value">${formatMinutes(player.totalSeconds)}</span>
        </div>
      </div>
    `;
    attachDragHandlers(playerCard, player.id);
    playerListEl.appendChild(playerCard);
  });
}

async function logPlayerActivity(playerId, inPlay) {
  if (!isGameActive && inPlay) {
    return;
  }

  const gameId = getCurrentGameId();
  const response = await fetch('/api/segments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ playerId, inPlay, gameId })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to update player activity.');
    return;
  }

  const updatedPlayers = await fetchPlayers();
  renderPlayers(updatedPlayers);
}

async function toggleGameStatus() {
  const nextState = !isGameActive;
  const gameId = getCurrentGameId();

  const response = await fetch(`/api/game/${gameId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ isActive: nextState, gameId })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to update the game status.');
    return;
  }

  const gameData = await response.json();
  renderGameHeader(gameData.game);

  const players = await fetchPlayers();
  renderPlayers(players);
}

async function createGame(event) {
  event.preventDefault();

  const formData = new FormData(gameFormEl);
  const payload = {
    location: formData.get('location')?.trim(),
    month: formData.get('month'),
    day: formData.get('day'),
    year: formData.get('year')
  };

  if (!payload.location || !payload.month || !payload.day || !payload.year) {
    alert('Please enter a location and select a month, day, and year for the game.');
    return;
  }

  const response = await fetch('/api/games', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to create the game.');
    return;
  }

  const gameData = await response.json();
  renderGameHeader(gameData.game);
  gameFormEl.reset();
}

function setupDropZones() {
  const dragOver = (event) => {
    if (!isGameActive) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  stageEl.addEventListener('dragover', dragOver);
  playerListEl.addEventListener('dragover', (event) => {
    if (!isGameActive) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  stageEl.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!isGameActive) {
      return;
    }
    const playerId = Number(event.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(playerId)) {
      logPlayerActivity(playerId, true);
    }
  });

  playerListEl.addEventListener('drop', (event) => {
    event.preventDefault();
    const playerId = Number(event.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(playerId)) {
      logPlayerActivity(playerId, false);
    }
  });

  gameToggleBtn.addEventListener('click', toggleGameStatus);
  if (gameFormEl) {
    gameFormEl.addEventListener('submit', createGame);
  }
}

async function initializeApp() {
  setupDropZones();

  try {
    const gameData = await fetchCurrentGame();
    renderGameHeader(gameData.game);

    const players = await fetchPlayers();
    renderPlayers(players);
  } catch (error) {
    gameIdDisplayEl.textContent = 'Game ID: --';
    playerListEl.innerHTML = '<p>Unable to load player data.</p>';
    console.error(error);
  }

  setInterval(async () => {
    try {
      const [gameData, players] = await Promise.all([
        fetchCurrentGame(),
        fetchPlayers()
      ]);

      renderGameHeader(gameData.game);
      renderPlayers(players);
    } catch (error) {
      console.error('Error refreshing player data:', error);
    }
  }, 2000);
}

initializeApp();
