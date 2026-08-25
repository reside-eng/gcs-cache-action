import * as core from '@actions/core';

const TRANSIENT_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

// The GitHub OIDC token endpoint (hit on every Workload Identity token
// refresh) intermittently returns Envoy-formatted 503 bodies; google-auth
// surfaces them as plain error messages without an HTTP status.
const TRANSIENT_MESSAGE_PATTERNS = [
  'upstream connect error',
  'upstream request timeout',
  'unable to retrieve identity pool subject token',
  'premature close',
  'socket hang up',
  'network timeout',
  'connection refused',
  'connection reset',
  'connection timeout',
  'client network socket disconnected',
  'timed out',
];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return String(err);
}

function httpStatusOf(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;

  const candidates: unknown[] = [err.code, err.status];
  if (isRecord(err.response)) {
    candidates.push(err.response.status);
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) {
      return candidate;
    }
    if (typeof candidate === 'string' && /^[1-5]\d\d$/.test(candidate)) {
      return Number(candidate);
    }
  }

  return undefined;
}

function hasTransientErrorCode(err: unknown): boolean {
  return (
    isRecord(err) &&
    typeof err.code === 'string' &&
    TRANSIENT_ERROR_CODES.has(err.code)
  );
}

function hasTransientNestedError(err: unknown, depth: number): boolean {
  if (!isRecord(err)) return false;

  if (
    Array.isArray(err.errors) &&
    err.errors.some((nested) => isTransientError(nested, depth + 1))
  ) {
    return true;
  }

  return err.cause !== undefined && isTransientError(err.cause, depth + 1);
}

export function isTransientError(err: unknown, depth = 0): boolean {
  if (depth > 3 || err === null || err === undefined) return false;

  const status = httpStatusOf(err);
  if (status !== undefined && TRANSIENT_HTTP_STATUS.has(status)) return true;

  if (hasTransientErrorCode(err)) return true;

  const message = messageOf(err).toLowerCase();
  if (TRANSIENT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return true;
  }

  return hasTransientNestedError(err, depth);
}

// Stream/event-emitter errors (e.g. inside the storage SDK's download
// pipeline) escape every promise chain: catch them at the process level so
// a cache failure can never take the job down unless fail-on-error is set
export function failOpenOnUncaught(
  phase: string,
  shouldFailOnError: () => boolean,
): void {
  const handler = (err: unknown): void => {
    const code = shouldFailOnError() ? 1 : 0;
    if (code === 1) {
      core.error(`Cache ${phase} hit an uncaught error: ${messageOf(err)}`);
    } else {
      core.warning(
        `Cache ${phase} hit an uncaught error, continuing without cache: ${messageOf(
          err,
        )}`,
      );
    }
    process.exitCode = code;
    // Let stdout flush the annotation before exiting, with a hard fallback
    setTimeout(() => process.exit(code), 2000).unref();
    process.stdout.write('', () => process.exit(code));
  };
  process.on('uncaughtException', handler);
  process.on('unhandledRejection', handler);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  attemptTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number | undefined,
  promise: Promise<T>,
): Promise<T> {
  if (!timeoutMs) return promise;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const factor = options.factor ?? 3;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTimeout(label, options.attemptTimeoutMs, fn());
    } catch (err) {
      if (attempt >= attempts || !isTransientError(err)) throw err;

      const backoffMs = Math.min(
        maxDelayMs,
        baseDelayMs * factor ** (attempt - 1),
      );
      // Half-to-full jitter so parallel jobs don't retry in lockstep
      const delayMs = Math.round(
        backoffMs / 2 + Math.random() * (backoffMs / 2),
      );

      core.warning(
        `${label} failed with a transient error (attempt ${attempt}/${attempts}, retrying in ${Math.round(
          delayMs / 1000,
        )}s): ${messageOf(err)}`,
      );

      await sleep(delayMs);
    }
  }
}
