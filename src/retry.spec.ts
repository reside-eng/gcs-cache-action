import {
  failOpenOnUncaught,
  isTransientError,
  messageOf,
  withRetries,
} from './retry';

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}));

const REQUEST_FAILED = 'request failed';

const ENVOY_503_BODY =
  'upstream connect error or disconnect/reset before headers. retried and ' +
  'the latest reset reason: remote connection failure, transport failure ' +
  'reason: delayed connect error: Connection refused';

describe('isTransientError', () => {
  it.each([
    ['Envoy 503 body from the GitHub OIDC endpoint', new Error(ENVOY_503_BODY)],
    [
      'gcloud-style subject token failure',
      new Error(
        "('Unable to retrieve Identity Pool subject token', 'upstream connect error')",
      ),
    ],
    [
      'ApiError with numeric HTTP code',
      Object.assign(new Error('Service Unavailable'), { code: 503 }),
    ],
    [
      'GaxiosError with response status',
      Object.assign(new Error(REQUEST_FAILED), { response: { status: 502 } }),
    ],
    [
      'gaxios string status code',
      Object.assign(new Error(REQUEST_FAILED), { code: '500' }),
    ],
    [
      'node system error',
      Object.assign(new Error('connect ECONNRESET 140.82.112.10:443'), {
        code: 'ECONNRESET',
      }),
    ],
    ['rate limiting', Object.assign(new Error('slow down'), { code: 429 })],
    ['Envoy upstream request timeout', new Error('upstream request timeout')],
    ['socket hang up', new Error('socket hang up')],
    [
      'attempt timeout',
      new Error('List cache candidates timed out after 60000ms'),
    ],
    [
      'nested aggregate errors',
      Object.assign(new Error('multiple errors'), {
        errors: [
          { message: 'backend error', reason: 'backendError', code: 503 },
        ],
      }),
    ],
    [
      'wrapped cause',
      Object.assign(new Error(REQUEST_FAILED), {
        cause: Object.assign(new Error('connect failure'), {
          code: 'ETIMEDOUT',
        }),
      }),
    ],
  ])('returns true for %s', (_label, err) => {
    expect(isTransientError(err)).toBe(true);
  });

  it.each([
    ['permission denied', Object.assign(new Error('Forbidden'), { code: 403 })],
    ['not found', Object.assign(new Error('No such object'), { code: 404 })],
    ['plain logic error', new Error('boom')],
    ['undefined', undefined],
    ['null', null],
  ])('returns false for %s', (_label, err) => {
    expect(isTransientError(err)).toBe(false);
  });
});

describe('messageOf', () => {
  it('extracts messages from errors, objects and primitives', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf({ message: 'nested' })).toBe('nested');
    expect(messageOf('plain string')).toBe('plain string');
  });
});

describe('failOpenOnUncaught', () => {
  type UncaughtHandler = (err: unknown) => void;
  let onSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let writeSpy: jest.SpyInstance;
  const previousExitCode = process.exitCode;

  beforeEach(() => {
    onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((_chunk, cb?: unknown) => {
        if (typeof cb === 'function') (cb as () => void)();
        return true;
      });
  });

  afterEach(() => {
    onSpy.mockRestore();
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    process.exitCode = previousExitCode;
  });

  function registeredHandler(event: string): UncaughtHandler {
    const calls = onSpy.mock.calls as [string, UncaughtHandler][];
    const call = calls.find(([name]) => name === event);
    if (!call) throw new Error(`no handler registered for ${event}`);
    return call[1];
  }

  it('registers handlers for uncaught exceptions and rejections', () => {
    failOpenOnUncaught('restore', () => false);

    expect(registeredHandler('uncaughtException')).toBeDefined();
    expect(registeredHandler('unhandledRejection')).toBeDefined();
  });

  it('exits 0 when fail-on-error is disabled', () => {
    failOpenOnUncaught('restore', () => false);

    registeredHandler('uncaughtException')(new Error('boom'));

    expect(process.exitCode).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when fail-on-error is enabled', () => {
    failOpenOnUncaught('save', () => true);

    registeredHandler('unhandledRejection')(new Error('boom'));

    expect(process.exitCode).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('withRetries', () => {
  const fastRetry = { baseDelayMs: 1, maxDelayMs: 2 };

  it('returns the result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(withRetries('op', fn, fastRetry)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors until success', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error(ENVOY_503_BODY))
      .mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), { code: 503 }),
      )
      .mockResolvedValue('ok');

    await expect(withRetries('op', fn, fastRetry)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent errors', async () => {
    const err = Object.assign(new Error('Forbidden'), { code: 403 });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetries('op', fn, fastRetry)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows after exhausting attempts', async () => {
    const err = new Error(ENVOY_503_BODY);
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetries('op', fn, { ...fastRetry, attempts: 3 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('times out hanging attempts and retries them', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 60000).unref();
          }),
      )
      .mockResolvedValue('ok');

    await expect(
      withRetries('op', fn, { ...fastRetry, attemptTimeoutMs: 50 }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
