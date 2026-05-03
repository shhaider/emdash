import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callExternalHook } from './external-hook-client';
import type { BeforeProvisionContext, HookConfigEntry, HookEvent } from './types';

interface ServerHandle {
  server: http.Server;
  port: number;
  lastBody: string | null;
  lastUrl: string | null;
  lastMethod: string | null;
  lastContentType: string | null;
}

type Responder = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function startServer(responder: Responder): Promise<ServerHandle> {
  const handle: ServerHandle = {
    server: undefined as unknown as http.Server,
    port: 0,
    lastBody: null,
    lastUrl: null,
    lastMethod: null,
    lastContentType: null,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handle.lastBody = Buffer.concat(chunks).toString('utf8');
      handle.lastUrl = req.url ?? null;
      handle.lastMethod = req.method ?? null;
      handle.lastContentType = (req.headers['content-type'] as string | undefined) ?? null;
      responder(req, res, handle.lastBody);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('failed to bind test server');
  }
  handle.server = server;
  handle.port = address.port;
  return handle;
}

async function stopServer(handle: ServerHandle | null): Promise<void> {
  if (!handle) return;
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
  });
}

const sampleContext: BeforeProvisionContext = {
  taskId: 't-1',
  projectId: 'p-1',
  taskName: 'Add hooks',
  sourceBranch: 'main',
  taskBranch: 'feature/hooks',
  linkedIssue: null,
  timestamp: '2026-05-03T00:00:00.000Z',
};

const sampleEvent: HookEvent = 'task.before_provision';

function makeHook(url: string, timeoutMs = 1000): HookConfigEntry {
  return {
    name: 'test-hook',
    event: sampleEvent,
    url,
    timeout_ms: timeoutMs,
    on_unreachable: 'block',
  };
}

describe('callExternalHook', () => {
  let handle: ServerHandle | null = null;

  beforeEach(() => {
    handle = null;
  });

  afterEach(async () => {
    await stopServer(handle);
    handle = null;
  });

  it('returns approve decision when server responds allowed:true', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome).toEqual({ kind: 'decision', allowed: true });
  });

  it('returns deny decision with reason when server responds allowed:false', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'Awaiting proof at S11' }));
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome).toEqual({
      kind: 'decision',
      allowed: false,
      reason: 'Awaiting proof at S11',
    });
  });

  it('propagates details field on deny decision', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ allowed: false, reason: 'No', details: 'See workflow log entry 42' })
      );
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome).toEqual({
      kind: 'decision',
      allowed: false,
      reason: 'No',
      details: 'See workflow log entry 42',
    });
  });

  it('treats non-2xx HTTP status as unreachable', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'boom' }));
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome.kind).toBe('unreachable');
    if (outcome.kind === 'unreachable') {
      expect(outcome.reason).toContain('500');
    }
  });

  it('treats malformed JSON body as unreachable', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{ not json');
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome.kind).toBe('unreachable');
  });

  it('treats response missing `allowed` field as unreachable', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome.kind).toBe('unreachable');
  });

  it('treats allowed:false without reason as unreachable', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false }));
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome.kind).toBe('unreachable');
  });

  it('treats slow server as unreachable when timeout fires (and cleans up timer)', async () => {
    // Server delays the response longer than the hook timeout.
    handle = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowed: true }));
      }, 500);
    });

    const start = Date.now();
    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`, 80), {
      event: sampleEvent,
      ...sampleContext,
    });
    const elapsed = Date.now() - start;
    expect(outcome.kind).toBe('unreachable');
    expect(elapsed).toBeLessThan(450);
  });

  it('treats connection refused as unreachable', async () => {
    // Port 1 is reserved and refuses connections; if not, the OS errors out anyway.
    const outcome = await callExternalHook(makeHook('http://127.0.0.1:1', 500), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome.kind).toBe('unreachable');
  });

  it('POSTs JSON body matching input including the event field', async () => {
    handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    });

    const outcome = await callExternalHook(makeHook(`http://127.0.0.1:${handle.port}`), {
      event: sampleEvent,
      ...sampleContext,
    });
    expect(outcome).toEqual({ kind: 'decision', allowed: true });

    expect(handle.lastMethod).toBe('POST');
    expect(handle.lastContentType).toBe('application/json');
    expect(handle.lastBody).not.toBeNull();
    const decoded = JSON.parse(handle.lastBody as string);
    expect(decoded).toEqual({ event: sampleEvent, ...sampleContext });
  });
});
