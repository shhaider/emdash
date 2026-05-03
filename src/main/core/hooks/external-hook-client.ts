import http, { type RequestOptions } from 'node:http';
import https from 'node:https';
import type { BeforeProvisionContext, HookConfigEntry, HookEvent } from './types';

export type HookCallOutcome =
  | { kind: 'decision'; allowed: true }
  | { kind: 'decision'; allowed: false; reason: string; details?: string }
  | { kind: 'unreachable'; reason: string };

interface RawHttpResponse {
  statusCode: number;
  body: string;
}

interface ParsedDecision {
  allowed: boolean;
  reason?: string;
  details?: string;
}

function performRequest(url: string, payload: string, timeoutMs: number): Promise<RawHttpResponse> {
  return new Promise<RawHttpResponse>((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(new Error(`invalid hook url: ${String((error as Error)?.message ?? error)}`));
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    if (!isHttps && parsedUrl.protocol !== 'http:') {
      reject(new Error(`unsupported hook url protocol: ${parsedUrl.protocol}`));
      return;
    }

    const requestOptions: RequestOptions = {
      method: 'POST',
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
      },
    };

    const transport = isHttps ? https : http;
    let settled = false;

    const req = transport.request(requestOptions, (res) => {
      const statusCode = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`hook request timed out after ${timeoutMs}ms`));
      reject(new Error(`hook request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

function parseDecision(rawBody: string): ParsedDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.allowed !== 'boolean') return null;
  const result: ParsedDecision = { allowed: obj.allowed };
  if (typeof obj.reason === 'string') result.reason = obj.reason;
  if (typeof obj.details === 'string') result.details = obj.details;
  return result;
}

export async function callExternalHook(
  hook: HookConfigEntry,
  body: BeforeProvisionContext & { event: HookEvent }
): Promise<HookCallOutcome> {
  const payload = JSON.stringify(body);

  let response: RawHttpResponse;
  try {
    response = await performRequest(hook.url, payload, hook.timeout_ms);
  } catch (error) {
    return {
      kind: 'unreachable',
      reason: String((error as Error)?.message ?? error),
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      kind: 'unreachable',
      reason: `hook responded with HTTP ${response.statusCode}`,
    };
  }

  const decision = parseDecision(response.body);
  if (!decision) {
    return {
      kind: 'unreachable',
      reason: 'hook response was not valid JSON or missing required `allowed` field',
    };
  }

  if (decision.allowed) {
    return { kind: 'decision', allowed: true };
  }

  if (!decision.reason) {
    return {
      kind: 'unreachable',
      reason: 'hook returned `allowed: false` but no `reason` field',
    };
  }

  const denied: HookCallOutcome = {
    kind: 'decision',
    allowed: false,
    reason: decision.reason,
  };
  if (decision.details !== undefined) {
    denied.details = decision.details;
  }
  return denied;
}
