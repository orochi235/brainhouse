/** Whether a session's title is just a placeholder — an empty string, the
 * server's short-id stand-in (`id.slice(0,8)`, see session.ts:initialTitle),
 * or a bare hex/uuid fragment the auto-titler never replaced. The top
 * widget's sessions view renders these in the same muted color as the
 * invoking-command fallback, so a real prose title stands out from a session
 * still wearing its raw id.
 *
 * A hex run only counts when it carries a digit, so all-letter words that
 * happen to be valid hex ("decade", "facade", "cafe") read as real titles. */
export function isPlaceholderTitle(title: string, id: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t === id.slice(0, 8)) return true;
  if (!/^[0-9a-f]+(-[0-9a-f]+)*$/i.test(t)) return false;
  if (!/[0-9]/.test(t)) return false;
  return t.replace(/-/g, '').length >= 6;
}
