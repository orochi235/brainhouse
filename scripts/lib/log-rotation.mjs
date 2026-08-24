/**
 * Copy-truncate rotation for the service's launchd logs.
 *
 * launchd opens StandardOutPath/StandardErrorPath itself and holds those fds
 * open (O_APPEND) for the life of the job. Renaming the file would leave every
 * subsequent write landing in the renamed inode, so truncating in place is the
 * only rotation the service can perform on its own logs.
 */
import { promises as fsp } from 'node:fs';

/** Copy `filePath` over `${filePath}.1` and empty it when it exceeds
 * `maxBytes`. Returns the rotated byte count, or 0 when nothing was done
 * (file absent, or still under the limit). */
export async function rotateIfLarge(filePath, maxBytes) {
  let size;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    return 0;
  }
  if (size <= maxBytes) return 0;
  await fsp.copyFile(filePath, `${filePath}.1`);
  await fsp.truncate(filePath, 0);
  return size;
}
