/** Split a shell command at top-level `;` separators, keeping each `;`
 * (or `;;`) at the end of its segment. Quoted strings, backslash
 * escapes, backticks, and parenthesized groups (subshells, `$(...)`)
 * are opaque — a `;` inside them never splits. Whitespace following a
 * separator is dropped; the renderer decides how segments rejoin. */
export function splitCommandSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let i = 0;
  let quote: "'" | '"' | '`' | null = null;
  let depth = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote !== "'") {
        cur += cmd[i + 1] ?? '';
        i++;
      }
      i++;
      continue;
    }
    switch (c) {
      case '\\':
        cur += cmd.slice(i, i + 2);
        i += 2;
        continue;
      case "'":
      case '"':
      case '`':
        quote = c;
        break;
      case '(':
        depth++;
        break;
      case ')':
        depth = Math.max(0, depth - 1);
        break;
      case ';':
        if (depth === 0) {
          let j = i;
          while (cmd[j + 1] === ';') j++;
          segs.push(cur + cmd.slice(i, j + 1));
          cur = '';
          i = j + 1;
          while (i < cmd.length && /\s/.test(cmd[i] ?? '')) i++;
          continue;
        }
        break;
    }
    cur += c;
    i++;
  }
  if (cur.trim() !== '') segs.push(cur);
  return segs.length > 0 ? segs : [cmd];
}
