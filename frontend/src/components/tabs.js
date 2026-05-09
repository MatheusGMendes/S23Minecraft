// Tab switching. Calls onTabChange(target) after the panel toggle so
// the orchestrator can lazy-refresh content (e.g. logs) when a tab
// becomes active.

export function initTabs(onTabChange) {
  const buttons = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      panels.forEach(p => { p.hidden = p.dataset.tab !== target; });
      if (typeof onTabChange === 'function') onTabChange(target);
    });
  });
}
