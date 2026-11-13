import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readPeerRegistry } from './peerRegistry.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bh-peers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('readPeerRegistry', () => {
  it('reads the sessions/ registry beside a watched projects/ root', async () => {
    mkdirSync(path.join(tmp, 'projects'));
    mkdirSync(path.join(tmp, 'sessions'));
    writeFileSync(
      path.join(tmp, 'sessions', '28469.json'),
      JSON.stringify({ pid: 28469, sessionId: 's-emilia', name: 'emilia-93' }),
    );
    writeFileSync(path.join(tmp, 'sessions', '1.json'), '{"pid":');
    const peers = await readPeerRegistry([path.join(tmp, 'projects')]);
    expect([...peers]).toEqual([['s-emilia', { name: 'emilia-93', pid: 28469 }]]);
  });
});
