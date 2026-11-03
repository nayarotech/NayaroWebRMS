/** Public /api routes, authentication and WebSocket upgrades on a disposable DB. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import { applyPendingMigrations } from '@nayaro/database';
import {
  createNayaroServer,
  startNayaroServer,
  stopNayaroServer,
  type NayaroServerHandle,
} from '../src/server';
import { serverOptionsFromEnvironment, resolveDatabaseLocation } from './env';
import type { HealthResponse } from '@nayaro/shared';

const root = mkdtempSync(join(tmpdir(), 'nayaro-services-'));
const databaseFilePath = join(root, 'test.db');
let handle: NayaroServerHandle | undefined;
let socket: Socket | undefined;

try {
  const saved = { ...process.env };
  try {
    process.env['VERCEL'] = '1';
    process.env['VERCEL_ENV'] = 'preview';
    delete process.env['DATABASE_URL'];
    assert.throws(resolveDatabaseLocation, /managed libSQL/);
    process.env['DATABASE_URL'] = 'file:/tmp/not-durable.db';
    assert.throws(resolveDatabaseLocation, /managed libSQL/);
    process.env['DATABASE_URL'] = 'libsql://database.example.com';
    assert.equal(resolveDatabaseLocation(), 'libsql://database.example.com');
    process.env['VERCEL_URL'] = 'preview.example.com';
    process.env['NODE_ENV'] = 'production';
    delete process.env['WEB_ORIGINS'];
    delete process.env['TRUST_PROXY'];
    const config = serverOptionsFromEnvironment();
    assert.ok(config.webOrigins?.includes('https://preview.example.com'));
    assert.equal(config.trustProxy, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }

  await applyPendingMigrations({ databaseFilePath });
  const options = {
    allowDirectRegistration: true,
    databaseFilePath,
    host: '127.0.0.1',
    port: 0,
    silent: true,
    apiBasePath: '/api',
    applyMigrations: false,
  } as const;
  handle = await createNayaroServer(options);
  assert.equal(handle.httpServer.listening, false, 'factory leaves the listener to the host');
  await stopNayaroServer(handle);
  handle = await startNayaroServer(options);
  const base = handle.baseUrl;
  const request = (path: string, body: unknown) =>
    fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const health = await fetch(`${base}/api/health?probe=services`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as HealthResponse).status, 'ok');
  assert.equal((await fetch(`${base}/health`)).status, 404, 'unprefixed API is not exposed');
  assert.equal(
    (await fetch(`${base}/api/floor`)).status,
    401,
    'prefix keeps the authentication wall',
  );
  assert.equal(
    (
      await request('/tenants/register', {
        restaurant: { slug: 'services-test', name: 'Services Test' },
        owner: { name: 'Owner', username: 'owner', password: 'Services-test-password' },
      })
    ).status,
    201,
  );
  const login = await request('/auth/login', {
    workspace: 'services-test',
    username: 'owner',
    password: 'Services-test-password',
  });
  assert.equal(login.status, 200);
  const { token } = (await login.json()) as { token: string };
  assert.equal(
    (await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status,
    200,
  );

  socket = io(base, {
    path: '/api/socket.io',
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    autoConnect: false,
  });
  const connected = new Promise<void>((resolve, reject) => {
    socket!.once('connect', resolve);
    socket!.once('connect_error', reject);
  });
  socket.connect();
  await Promise.race([
    connected,
    delay(5000).then(() => {
      throw new Error('WebSocket connection timed out');
    }),
  ]);
  assert.equal(socket.io.engine.transport.name, 'websocket');
  socket.disconnect();
  const unauthenticated = new Promise<Error>((resolve) => socket!.once('connect_error', resolve));
  socket.auth = { token: 'invalid' };
  socket.connect();
  const refusal = await Promise.race([
    unauthenticated,
    delay(5000).then(() => {
      throw new Error('WebSocket authentication timed out');
    }),
  ]);
  assert.match(refusal.message, /UNAUTHENTICATED/);
  console.log(
    'PASS services: public prefix, authentication, WebSockets, hosted environment and listener lifecycle.',
  );
} finally {
  socket?.disconnect();
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
