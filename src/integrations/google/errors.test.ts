import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GoogleApiError, classifyGoogleHttpError,
  type GoogleApiErrorDiagnostics, type GoogleApiErrorKind, type GoogleErrorClassifier,
} from './errors.js';

class TestError extends GoogleApiError {
  constructor(
    readonly requestedKind: GoogleApiErrorKind, readonly requestedMessage?: string, diagnostics?: GoogleApiErrorDiagnostics,
  ) {
    super(requestedKind, requestedMessage ?? 'default', diagnostics);
    this.name = 'TestError';
  }
}

function classifier(kindFor429: GoogleApiErrorKind, prefixes: GoogleErrorClassifier<GoogleApiErrorKind, TestError>['googleMessagePrefixes'] = {}) {
  return {
    kindFor429,
    googleMessagePrefixes: prefixes,
    create: (kind, message, diagnostics) => new TestError(kind, message, diagnostics),
  } satisfies GoogleErrorClassifier<GoogleApiErrorKind, TestError>;
}

test('a subclass is an instance of both classes, keeps its name, and is retryable for exactly four kinds', () => {
  const kinds: GoogleApiErrorKind[] = [
    'invalid_request', 'unauthenticated', 'quota_project_denied', 'api_disabled', 'scope_insufficient',
    'daily_limit', 'rate_limited', 'access_denied', 'not_found', 'resource_exhausted', 'server_error',
    'timeout', 'network', 'unexpected_response',
  ];
  const retryable = kinds.filter(kind => new TestError(kind).retryable);
  assert.deepEqual(retryable, ['rate_limited', 'server_error', 'timeout', 'network']);
  const error = new TestError('not_found');
  assert.ok(error instanceof TestError);
  assert.ok(error instanceof GoogleApiError);
  assert.equal(error.name, 'TestError');
});

test('the classifier returns exactly what create returns, with kind, message, and diagnostics', () => {
  const created = new TestError('daily_limit');
  const calls: unknown[][] = [];
  const result = classifyGoogleHttpError<GoogleApiErrorKind, TestError>(400, JSON.stringify({ error: { message: 'bad', code: 400, status: 'INVALID_ARGUMENT' } }), {
    kindFor429: 'rate_limited',
    googleMessagePrefixes: { invalid_request: 'Prefix' },
    create: (kind, message, diagnostics) => { calls.push([kind, message, diagnostics]); return created; },
  });
  assert.equal(result, created);
  assert.deepEqual(calls, [[
    'invalid_request', 'Prefix: bad',
    { httpStatus: 400, code: 400, status: 'INVALID_ARGUMENT', reasons: [], legacyReasons: [] },
  ]]);
});

test('kindFor429 is honoured for both values', () => {
  assert.equal(classifyGoogleHttpError(429, '', classifier('rate_limited')).kind, 'rate_limited');
  assert.equal(classifyGoogleHttpError(429, '', classifier('resource_exhausted')).kind, 'resource_exhausted');
});

test('a kind without a prefix never receives the message from Google', () => {
  const body = JSON.stringify({ error: { message: 'secret detail' } });
  const result = classifyGoogleHttpError(404, body, classifier('rate_limited', { invalid_request: 'Prefix' }));
  assert.equal(result.requestedMessage, undefined);
  assert.equal(result.message, 'default');
});
