import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The dashboard URL that opens the search modal on `q`. */
export function searchUrl(base: string, q: string): string {
  return `${base}/?q=${encodeURIComponent(q)}`;
}

type Exec = (cmd: string, args: string[]) => Promise<unknown>;

/** Open the search in Chrome by bundle id, so a running Chrome is reused
 * rather than a second one launched; the default browser where there is no
 * Chrome. */
export async function openSearchInBrowser(
  base: string,
  q: string,
  exec: Exec = (cmd, args) => execFileAsync(cmd, args, { timeout: 10_000 }),
): Promise<void> {
  const url = searchUrl(base, q);
  try {
    await exec('open', ['-b', 'com.google.Chrome', url]);
  } catch {
    await exec('open', [url]);
  }
}
