/** Quote and demo requests: validation, spam trap, and forwarding to the central Nayaro inbox. */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';

const root = mkdtempSync(join(tmpdir(), 'nayaro-enquiries-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let checks = 0;

// A stand-in for the nayaro.tech inbox API.
const received: { key: string | undefined; body: Record<string, unknown> }[] = [];
let hubStatus = 201;
const hub = createServer((req: IncomingMessage, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
  req.on('end', () => {
    if (req.url === '/api/messages/inbound') {
      received.push({ key: req.headers['x-nayaro-product-key'] as string | undefined, body: JSON.parse(raw) as Record<string, unknown> });
    }
    res.writeHead(hubStatus, { 'Content-Type': 'application/json' }).end('{"id":1}');
  });
});
await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
const hubUrl = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}/api`;

async function post(baseUrl: string, body: unknown, status: number): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/enquiries`, {
    method: 'POST',
    headers: { Connection: 'close', 'Content-Type': 'application/json', 'User-Agent': 'verify-enquiries' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `POST /enquiries: ${text}`);
  checks++;
  return JSON.parse(text) as Record<string, unknown>;
}

const quote = {
  kind: 'quote',
  name: 'Kenji Sato',
  email: 'Kenji@Example.jp',
  phone: '+81 90 1234 5678',
  company: 'Sato Ramen',
  outlets: '3',
  page: '/#pricing',
};

let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let unconfigured: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
try {
  handle = await startNayaroServer({
    host: '127.0.0.1',
    port: 0,
    databaseFilePath: layout.databaseFilePath,
    silent: true,
    enquiryHub: { url: hubUrl, key: 'rms-test-key-0123456789abcdef' },
  });

  // Forwarded with this product's key; the browser never sees it.
  await post(handle.baseUrl, quote, 202);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.key, 'rms-test-key-0123456789abcdef');
  const body = received[0]!.body;
  assert.equal(body['kind'], 'quote');
  assert.equal(body['email'], 'kenji@example.jp', 'normalised');
  assert.equal(body['company'], 'Sato Ramen');
  assert.equal(body['topic'], 'Quote request — Nayaro RMS');
  assert.deepEqual(body['meta'], { Outlets: '3', Page: '/#pricing' });
  checks += 6;

  // A demo request needs no note.
  await post(handle.baseUrl, { kind: 'demo', name: 'Sita', email: 'sita@example.com' }, 202);

  // Spam trap: accepted quietly, never forwarded.
  const before = received.length;
  await post(handle.baseUrl, { ...quote, website: 'http://spam.example' }, 202);
  assert.equal(received.length, before, 'bots are not forwarded');
  checks++;

  // If the inbox fails, the visitor is told plainly, with a fallback address.
  hubStatus = 500;
  const failed = await post(handle.baseUrl, { kind: 'demo', name: 'Ram', email: 'ram@example.com' }, 502);
  assert.match(JSON.stringify(failed), /info@nayaro\.tech/);
  checks++;
  hubStatus = 201;

  // Fifth request is fine; the sixth from this network within 10 minutes is refused.
  await post(handle.baseUrl, quote, 202);
  const limited = await fetch(`${handle.baseUrl}/enquiries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quote),
  });
  assert.equal(limited.status, 429);
  checks++;

  // Not connected: a clear answer, not a silent drop. Also where invalid input
  // is checked (a fresh server has a fresh rate limit).
  unconfigured = await startNayaroServer({
    host: '127.0.0.1',
    port: 0,
    databaseFilePath: layout.databaseFilePath,
    silent: true,
  });
  // A plain enquiry needs a note; email and kind are validated.
  await post(unconfigured.baseUrl, { kind: 'contact', name: 'Sita', email: 'sita@example.com', message: 'hi' }, 400);
  await post(unconfigured.baseUrl, { kind: 'quote', name: 'Sita', email: 'not-an-email' }, 400);
  await post(unconfigured.baseUrl, { kind: 'nonsense', name: 'Sita', email: 'sita@example.com' }, 400);
  const off = await post(unconfigured.baseUrl, quote, 503);
  assert.match(JSON.stringify(off), /ENQUIRIES_NOT_CONFIGURED/);
  checks++;

  console.log(`PASS: ${String(checks)} checks - validation, spam trap, rate limit and forwarding to the Nayaro inbox.`);
} finally {
  if (handle) await stopNayaroServer(handle);
  if (unconfigured) await stopNayaroServer(unconfigured);
  hub.close();
  rmSync(root, { recursive: true, force: true });
}
