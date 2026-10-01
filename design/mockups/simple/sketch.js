// Reads ?theme=dark and ?s=custom,empty,settings,picker from the URL and turns them into body classes.
// The sketch bar buttons flip the same classes so a reviewer can click through without reloading.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'dark') document.body.classList.add('dark');
  (params.get('s') || '').split(',').filter(Boolean).forEach((state) => document.body.classList.add('s-' + state));
  document.querySelectorAll('[data-toggle-theme]').forEach((button) => {
    button.onclick = () => document.body.classList.toggle('dark');
  });
  document.querySelectorAll('[data-state]').forEach((button) => {
    button.onclick = () => document.body.classList.toggle('s-' + button.dataset.state);
  });
})();
