/**
 * Single source of truth for "is debug mode on".
 *
 * One switch, not two: the persisted `prefs.debug.enabled` pref is the
 * default, and the `?debug` query param *overrides* it for the current
 * page load — `?debug=1` forces debug on, `?debug=0` forces it off, and
 * an absent/other value falls back to the pref. Every debug affordance
 * (topbar cluster, uptime clock, DebugTile, per-panel debug palette)
 * reads through here so the param and the pref never govern different
 * things.
 *
 * The query string can't change without a reload, so it's read once.
 */
const debugParam = new URLSearchParams(window.location.search).get('debug');

export function debugEnabled(prefEnabled: boolean | undefined): boolean {
  if (debugParam === '1') return true;
  if (debugParam === '0') return false;
  return prefEnabled === true;
}
