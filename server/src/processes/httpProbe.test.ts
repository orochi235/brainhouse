import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProbe } from './httpProbe.js';

let server: http.Server;
let port: number;

beforeEach(async () => {
  server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('HttpProbe.retainOnly', () => {
  it('caches a positive probe, then evicts it when the port drops out', async () => {
    const probe = new HttpProbe();
    expect(await probe.probe(port)).toBe(true);
    expect(probe.get(port)).toBe(true);

    probe.retainOnly(new Set([port]));
    expect(probe.get(port)).toBe(true); // still listening → kept

    probe.retainOnly(new Set()); // port gone from the sweep → evicted
    expect(probe.get(port)).toBeNull();
  });
});
