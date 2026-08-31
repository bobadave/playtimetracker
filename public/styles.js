function getStoredTeamId() {
  try {
    const stored = window.sessionStorage.getItem('currentTeamId');
    return stored ? Number(stored) : 1;
  } catch (error) {
    return 1;
  }
}

function setStoredTeamId(teamId) {
  try {
    window.sessionStorage.setItem('currentTeamId', String(teamId));
  } catch (error) {
    // Ignore storage failures in private browsing or restricted environments.
  }
}

function getCurrentTeamIdFromPath() {
  const match = window.location.pathname.match(/^\/t(\d+)(?:\/|$)/);
  if (match) {
    const teamId = Number(match[1]);
    setStoredTeamId(teamId);
    return teamId;
  }

  return getStoredTeamId();
}

async function getCurrentUserTeamIds() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) {
      return [];
    }

    const { user } = await response.json();
    return Array.isArray(user?.teamIds) ? user.teamIds.map((teamId) => Number(teamId)).filter((teamId) => Number.isFinite(teamId) && teamId > 0) : [];
  } catch (error) {
    return [];
  }
}

async function resolvePreferredTeamId() {
  const pathTeamId = getCurrentTeamIdFromPath();
  if (window.location.pathname.match(/^\/t\d+(?:\/|$)/)) {
    return pathTeamId;
  }

  const teamIds = await getCurrentUserTeamIds();
  if (teamIds.length === 0) {
    try {
      window.sessionStorage.removeItem('currentTeamId');
    } catch (error) {
      // Ignore storage failures in private browsing or restricted environments.
    }
    return null;
  }

  const preferredTeamId = teamIds[0] || 1;
  setStoredTeamId(preferredTeamId);
  return preferredTeamId;
}

function updateCurrentGameLink() {
  const link = document.getElementById('current-game-link');
  if (!link) {
    return;
  }

  const teamId = getCurrentTeamIdFromPath();
  fetch('/api/games')
    .then((response) => {
      if (!response.ok) {
        throw new Error('Unable to find current game.');
      }
      return response.json();
    })
    .then(({ games = [] }) => {
      const activeGames = games.filter((game) => Number(game.is_active) === 1);
      const activeLatest = activeGames.sort((a, b) => Number(b.id) - Number(a.id))[0];
      const fallbackLatest = [...games].sort((a, b) => Number(b.id) - Number(a.id))[0];
      const target = activeLatest || fallbackLatest;
      const targetTeamId = target && target.team_id ? Number(target.team_id) : teamId;
      link.href = target ? `/t${targetTeamId}/games/${target.id}` : `/t${teamId}/games`;
    })
    .catch(() => {
      link.href = `/t${teamId}/games`;
    });
}

function bindDisabledMenuLink(link) {
  if (!link || link.dataset.menuDisabledBound === 'true') {
    return;
  }

  link.dataset.menuDisabledBound = 'true';
  link.addEventListener('click', (event) => {
    if (link.dataset.disabled === 'true') {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function setMenuLinkDisabled(link, disabled, fallbackHref = '#') {
  if (!link) {
    return;
  }

  const originalHref = link.dataset.originalHref || link.getAttribute('href') || fallbackHref;
  if (!link.dataset.originalHref) {
    link.dataset.originalHref = originalHref;
  }

  bindDisabledMenuLink(link);

  link.classList.toggle('disabled-link', disabled);
  link.setAttribute('aria-disabled', String(disabled));
  link.dataset.disabled = disabled ? 'true' : 'false';

  if (disabled) {
    link.href = fallbackHref;
    link.style.pointerEvents = 'none';
    link.tabIndex = -1;
    return;
  }

  link.href = link.dataset.originalHref || fallbackHref;
  link.style.pointerEvents = '';
  link.removeAttribute('tabindex');
}

async function updateTeamScopedMenuLinks() {
  const rosterLink = document.getElementById('roster-link');
  const gamesLink = document.getElementById('games-link');
  const teamIds = await getCurrentUserTeamIds();

  if (teamIds.length === 0) {
    try {
      window.sessionStorage.removeItem('currentTeamId');
    } catch (error) {
      // Ignore storage failures in private browsing or restricted environments.
    }
    setMenuLinkDisabled(rosterLink, true);
    setMenuLinkDisabled(gamesLink, true);
    return;
  }

  const teamId = await resolvePreferredTeamId();
  setStoredTeamId(teamId);

  if (rosterLink) {
    rosterLink.href = `/t${teamId}/roster`;
    setMenuLinkDisabled(rosterLink, false, `/t${teamId}/roster`);
  }

  if (gamesLink) {
    gamesLink.href = `/t${teamId}/games`;
    setMenuLinkDisabled(gamesLink, false, `/t${teamId}/games`);
  }
}

function attachLogoutHandler() {
  const menu = document.getElementById('menu-panel');
  if (!menu) {
    return;
  }

  let logoutLink = document.getElementById('logout-link');
  if (!logoutLink) {
    logoutLink = document.createElement('a');
    logoutLink.id = 'logout-link';
    logoutLink.href = '#';
    logoutLink.textContent = 'Log Out';
    menu.appendChild(logoutLink);
  }

  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (error) {
      // Ignore logout API errors and continue to the login screen.
    }

    window.sessionStorage.removeItem('currentTeamId');
    window.location.href = '/login';
  });
}

function initMenu() {
  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('menu-panel');

  if (!toggle || !menu) {
    return;
  }

  if (toggle.dataset.menuBound === 'true') {
    return;
  }

  toggle.dataset.menuBound = 'true';

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  menu.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  document.addEventListener('click', (event) => {
    const clickInside = toggle.contains(event.target) || menu.contains(event.target);
    if (!clickInside) {
      menu.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

initMenu();
attachLogoutHandler();
updateTeamScopedMenuLinks().catch(() => undefined);
document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  attachLogoutHandler();
  updateTeamScopedMenuLinks().catch(() => undefined);
});
