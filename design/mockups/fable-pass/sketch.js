// Sketch helpers: theme toggle and fake nav. No app logic.
(() => {
  const dark = localStorage.getItem('aac-sketch-dark') === '1' || location.search.includes('dark');
  if (dark) document.body.classList.add('dark');
  document.querySelectorAll('[data-toggle-theme]').forEach((button) => {
    button.textContent = document.body.classList.contains('dark') ? 'Light paper' : 'Bone Outline';
    button.onclick = () => {
      document.body.classList.toggle('dark');
      localStorage.setItem('aac-sketch-dark', document.body.classList.contains('dark') ? '1' : '0');
      button.textContent = document.body.classList.contains('dark') ? 'Light paper' : 'Bone Outline';
    };
  });
  document.querySelectorAll('.seg button, .chips button').forEach((button) => {
    button.onclick = () => {
      button.parentElement.querySelectorAll('button').forEach((sibling) => sibling.classList.remove('active'));
      button.classList.add('active');
      const target = button.dataset.show;
      if (target) {
        button.parentElement.parentElement.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== target; });
      }
    };
  });
})();
