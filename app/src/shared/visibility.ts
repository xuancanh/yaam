// Background-polling guard. Timers keep firing while the window is hidden or
// minimized (webviews throttle but do not stop them), so periodic refreshes
// that only feed what is on screen skip their work while the page is hidden.
export function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}
