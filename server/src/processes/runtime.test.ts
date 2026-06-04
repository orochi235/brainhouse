import { describe, it, expect } from 'vitest';
import { detectRuntimeFromPath, detectRuntimeFromArgv } from './runtime.js';

describe('detectRuntimeFromPath', () => {
  it('nvm', () => {
    expect(detectRuntimeFromPath('/Users/x/.nvm/versions/node/v22.5.0/bin/node'))
      .toEqual({ runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path' });
  });
  it('asdf python', () => {
    expect(detectRuntimeFromPath('/Users/x/.asdf/installs/python/3.12.4/bin/python3.12'))
      .toEqual({ runtime: 'python', runtime_version: '3.12.4', runtime_source: 'path' });
  });
  it('rbenv ruby', () => {
    expect(detectRuntimeFromPath('/Users/x/.rbenv/versions/3.3.0/bin/ruby'))
      .toEqual({ runtime: 'ruby', runtime_version: '3.3.0', runtime_source: 'path' });
  });
  it('volta', () => {
    expect(detectRuntimeFromPath('/Users/x/.volta/tools/image/node/20.10.0/bin/node'))
      .toEqual({ runtime: 'node', runtime_version: '20.10.0', runtime_source: 'path' });
  });
  it('homebrew Cellar python with version tag', () => {
    expect(detectRuntimeFromPath('/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python'))
      .toEqual({ runtime: 'python', runtime_version: '3.14.5', runtime_source: 'path' });
  });
  it('homebrew Cellar node@20', () => {
    expect(detectRuntimeFromPath('/opt/homebrew/Cellar/node@20/20.10.0/bin/node'))
      .toEqual({ runtime: 'node', runtime_version: '20.10.0', runtime_source: 'path' });
  });
  it('homebrew Cellar redis (no version tag)', () => {
    expect(detectRuntimeFromPath('/opt/homebrew/Cellar/redis/7.4.0/bin/redis-server'))
      .toEqual({ runtime: 'redis', runtime_version: '7.4.0', runtime_source: 'path' });
  });
  it('Intel-mac homebrew Cellar', () => {
    expect(detectRuntimeFromPath('/usr/local/Cellar/go/1.22.5/bin/go'))
      .toEqual({ runtime: 'go', runtime_version: '1.22.5', runtime_source: 'path' });
  });
  it('returns null when no match', () => {
    expect(detectRuntimeFromPath('/usr/bin/node')).toBeNull();
  });
});

describe('detectRuntimeFromArgv', () => {
  it('python3.12 from argv0', () => {
    expect(detectRuntimeFromArgv(['python3.12', '-m', 'http.server']))
      .toEqual({ runtime: 'python', runtime_version: '3.12', runtime_source: 'argv' });
  });
  it('node with no version', () => {
    expect(detectRuntimeFromArgv(['node', 'index.js']))
      .toEqual({ runtime: 'node', runtime_version: null, runtime_source: 'argv' });
  });
  it('postgres', () => {
    expect(detectRuntimeFromArgv(['/usr/local/bin/postgres', '-D', '/var/pg']))
      .toEqual({ runtime: 'postgres', runtime_version: null, runtime_source: 'argv' });
  });
  it('npm / npx / yarn / pnpm surface as node', () => {
    expect(detectRuntimeFromArgv(['npm', 'run', 'dev'])?.runtime).toBe('node');
    expect(detectRuntimeFromArgv(['npx', '@playwright/mcp'])?.runtime).toBe('node');
    expect(detectRuntimeFromArgv(['yarn', 'start'])?.runtime).toBe('node');
    expect(detectRuntimeFromArgv(['pnpm', 'dev'])?.runtime).toBe('node');
  });
  it('skips leading exec / shim tokens to find the real runtime', () => {
    // macOS ps sometimes emits "exec @playwr npm exec @playwright/mcp@latest"
    expect(detectRuntimeFromArgv(['exec', '@playwr', 'npm', 'exec'])?.runtime).toBe('node');
  });
});
