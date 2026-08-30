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

function updateCurrentGameLink() {
  const link = document.getElementById('current-game-link');
  if (!link) {
    return;
  }

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
      link.href = target ? `/games/${target.id}` : '/games';
    })
    .catch(() => {
      link.href = '/games';
    });
}

initMenu();
updateCurrentGameLink();
document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  updateCurrentGameLink();
});
