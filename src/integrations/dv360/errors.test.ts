import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dv360Error, classifyHttpError, type Dv360ErrorKind } from './errors.js';

const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';
const cases: readonly (readonly [Dv360ErrorKind, boolean, string])[] = [
  ['invalid_request', false, 'Google rejected the request.'],
  ['unauthenticated', false, 'The Google login is no longer accepted. Run the Google login command again, then retry.'],
  ['quota_project_denied', false, 'The Google account may not use the configured quota project. It needs the Service Usage Consumer role there.'],
  ['api_disabled', false, 'The Display & Video 360 API is not enabled in the configured quota project, or the project ID is wrong.'],
  ['scope_insufficient', false, 'The Google login lacks the Display & Video 360 scope. Run the Google login command again with the documented scopes.'],
  ['daily_limit', false, 'The daily Display & Video 360 request quota is used up. Try again tomorrow.'],
  ['rate_limited', true, 'Too many Display & Video 360 requests in the last minute. Wait a minute, then try again.'],
  ['access_denied', false, 'Access denied. The partner or advertiser ID may be wrong, or the Google account this server uses has no access to it.'],
  ['not_found', false, 'Not found, or not visible to the Google account this server uses.'],
  ['server_error', true, 'Display & Video 360 had a temporary problem. Try again shortly.'],
  ['timeout', true, 'Display & Video 360 did not respond in time. Try again shortly.'],
  ['network', true, 'Could not reach Display & Video 360. Try again shortly.'],
  ['unexpected_response', false, 'Display & Video 360 returned an unexpected response.'],
];

for (const [kind, retryable, message] of cases) {
  test(`${kind} has its exact default message and retryable flag`, () => {
    const error = new Dv360Error(kind);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'Dv360Error');
    assert.equal(error.kind, kind);
    assert.equal(error.message, message);
    assert.equal(error.retryable, retryable);
    assert.deepEqual(error.diagnostics, { reasons: [], legacyReasons: [] });
    assert.equal('cause' in error, false);
  });
}

for (const message of ['IDs must be numeric.', 'pageSize must be an integer from 1 to 100.', 'The filter is too long.']) {
  test(`constructor preserves local message: ${message}`, () => {
    const error = new Dv360Error('invalid_request', message);
    assert.equal(error.message, message);
    assert.equal(error.retryable, false);
  });
}

const reasonCases: readonly (readonly [string, Dv360ErrorKind])[] = [
  ['USER_PROJECT_DENIED', 'quota_project_denied'],
  ['SERVICE_DISABLED', 'api_disabled'],
  ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'scope_insufficient'],
  ['dailyLimitExceeded', 'daily_limit'],
  ['userRateLimitExceeded', 'rate_limited'],
];
for (const [reason, kind] of reasonCases) {
  for (const source of ['ErrorInfo', 'legacy'] as const) {
    test(`403 ${source} ${reason} maps to ${kind}`, () => {
      const payload = source === 'ErrorInfo'
        ? { details: [{ '@type': ERROR_INFO, reason, domain: 'usageLimits' }] }
        : { errors: [{ reason, domain: 'usageLimits' }] };
      const error = classifyHttpError(403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', ...payload } }));
      assert.equal(error.kind, kind);
      assert.equal(error.message, cases.find(entry => entry[0] === kind)![2]);
      assert.equal(error.retryable, kind === 'rate_limited');
      assert.deepEqual(error.diagnostics, {
        httpStatus: 403, code: 403, status: 'PERMISSION_DENIED',
        reasons: source === 'ErrorInfo' ? [{ reason, domain: 'usageLimits' }] : [],
        legacyReasons: source === 'legacy' ? [reason] : [],
      });
    });
  }
}

test('403 priority is independent of reason order and source', () => {
  for (let index = 0; index < reasonCases.length; index++) {
    const remaining = reasonCases.slice(index).reverse();
    for (const mixed of [false, true]) {
      const error = classifyHttpError(403, JSON.stringify({ error: {
        details: remaining.map(([reason]) => ({ '@type': ERROR_INFO, reason })),
        errors: mixed ? [{ reason: reasonCases[index][0] }] : [],
      } }));
      assert.equal(error.kind, reasonCases[index][1]);
    }
  }
  assert.equal(classifyHttpError(403, JSON.stringify({ error: {
    details: [{ '@type': ERROR_INFO, reason: 'dailyLimitExceeded' }], errors: [{ reason: 'SERVICE_DISABLED' }],
  } })).kind, 'api_disabled');
});

for (const reason of ['unknown', 'service_disabled', 'UNAUTHENTICATED']) {
  test(`403 unknown or case-mismatched reason ${reason} is access_denied`, () => {
    const error = classifyHttpError(403, JSON.stringify({ error: { details: [{ '@type': ERROR_INFO, reason, domain: 'example.test' }] } }));
    assert.equal(error.kind, 'access_denied');
    assert.deepEqual(error.diagnostics.reasons, [{ reason, domain: 'example.test' }]);
  });
}

const httpCases: readonly (readonly [number, Dv360ErrorKind])[] = [
  [400, 'invalid_request'], [401, 'unauthenticated'], [403, 'access_denied'], [404, 'not_found'],
  [429, 'rate_limited'], [500, 'server_error'], [503, 'server_error'], [504, 'server_error'],
  [599, 'server_error'], [418, 'unexpected_response'], [499, 'unexpected_response'], [600, 'unexpected_response'],
];
for (const [status, kind] of httpCases) {
  test(`HTTP ${status} maps to ${kind} with exact message and retryability`, () => {
    const error = classifyHttpError(status, JSON.stringify({ error: { code: 999, status: 'OTHER', details: [{ '@type': ERROR_INFO, reason: status === 403 ? 'unknown' : 'SERVICE_DISABLED' }] } }));
    const expected = cases.find(entry => entry[0] === kind)!;
    assert.equal(error.kind, kind);
    assert.equal(error.retryable, expected[1]);
    assert.equal(error.message, expected[2]);
    assert.equal(error.diagnostics.httpStatus, status);
  });
}

for (const [status, lead] of [[400, 'Google rejected the request']] as const) {
  test(`HTTP ${status} cleans controls and collapses whitespace in the Google message`, () => {
    const error = classifyHttpError(status, JSON.stringify({ error: { message: ' \u0000 bad\n field\t combination\u007f\u0085 \u009f ' } }));
    assert.equal(error.message, `${lead}: bad field combination`);
  });
  test(`HTTP ${status} caps the cleaned message at 500 plus ellipsis only when cut`, () => {
    for (const length of [499, 500, 501, 600]) {
      const error = classifyHttpError(status, JSON.stringify({ error: { message: ` \n${'x'.repeat(length)}\t ` } }));
      assert.equal(error.message, `${lead}: ${'x'.repeat(Math.min(length, 500))}${length > 500 ? '…' : ''}`);
    }
  });
  test(`HTTP ${status} uses the short form for missing, blank or non-string messages`, () => {
    for (const message of [undefined, '', '\n\u0000\t ', null, 42, {}]) {
      assert.equal(classifyHttpError(status, JSON.stringify({ error: { message } })).message, `${lead}.`);
    }
  });
}

test('other HTTP kinds never include the Google message', () => {
  for (const [status] of httpCases.filter(([status]) => status !== 400)) {
    assert.equal(classifyHttpError(status, JSON.stringify({ error: { message: 'secret-consumer-123' } })).message.includes('secret-consumer-123'), false);
  }
});

test('malformed bodies classify by HTTP status with only HTTP diagnostics', () => {
  for (const body of ['', 'not JSON', '{', 'null', '[]', 'true', '42', '{}', '{"error":null}', '{"error":[]}', '{"error":"bad"}']) {
    for (const [status, kind] of httpCases) {
      const error = classifyHttpError(status, body);
      assert.equal(error.kind, kind);
      assert.deepEqual(error.diagnostics, { httpStatus: status, reasons: [], legacyReasons: [] });
    }
  }
});

test('malformed diagnostic fields and non-ErrorInfo details are ignored', () => {
  const error = classifyHttpError(403, JSON.stringify({ error: {
    code: '403', status: 403,
    details: [null, [], 'bad', { '@type': ERROR_INFO, reason: 1 }, { '@type': 'other', reason: 'SERVICE_DISABLED' },
      { '@type': ERROR_INFO, reason: 'unknown', domain: 42 }],
    errors: [null, [], 'bad', { reason: 42 }, { reason: 'other' }],
  } }));
  assert.equal(error.kind, 'access_denied');
  assert.deepEqual(error.diagnostics, { httpStatus: 403, reasons: [{ reason: 'unknown' }], legacyReasons: ['other'] });
  assert.deepEqual(classifyHttpError(403, '{"error":{"details":{},"errors":{}}}').diagnostics,
    { httpStatus: 403, reasons: [], legacyReasons: [] });
});

test('hygiene excludes raw bodies, metadata, secrets, causes and copied stacks', () => {
  const secret = 'secret-consumer-123';
  const error = classifyHttpError(403, JSON.stringify({ error: {
    message: secret, cause: secret, stack: secret, url: secret, headers: { authorization: secret },
    details: [{ '@type': ERROR_INFO, reason: 'SERVICE_DISABLED', domain: 'googleapis.com', metadata: { consumer: secret } }],
    errors: [{ reason: 'other', message: secret, location: secret }],
  } }));
  for (const text of [error.message, String(error), JSON.stringify(error), error.stack ?? '']) assert.equal(text.includes(secret), false);
  for (const key of ['cause', 'body', 'response', 'url', 'headers']) assert.equal(key in error, false);
  assert.deepEqual(error.diagnostics, { httpStatus: 403, reasons: [{ reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }], legacyReasons: ['other'] });
});

test('diagnostic lists are capped at five and every diagnostic string at 100 characters', () => {
  const long = 'x'.repeat(150);
  const error = classifyHttpError(403, JSON.stringify({ error: {
    code: 403, status: long,
    details: Array.from({ length: 8 }, () => ({ '@type': ERROR_INFO, reason: long, domain: long })),
    errors: Array.from({ length: 8 }, () => ({ reason: long })),
  } }));
  assert.deepEqual(error.diagnostics, {
    httpStatus: 403, code: 403, status: 'x'.repeat(100),
    reasons: Array.from({ length: 5 }, () => ({ reason: 'x'.repeat(100), domain: 'x'.repeat(100) })),
    legacyReasons: Array.from({ length: 5 }, () => 'x'.repeat(100)),
  });
});

test('classification checks all exact reasons before diagnostic list and string caps', () => {
  for (const source of ['details', 'errors']) {
    const entries = [...Array.from({ length: 5 }, () => ({ '@type': ERROR_INFO, reason: 'unknown' })), { '@type': ERROR_INFO, reason: 'SERVICE_DISABLED' }];
    assert.equal(classifyHttpError(403, JSON.stringify({ error: { [source]: entries } })).kind, 'api_disabled');
  }
  assert.equal(classifyHttpError(403, JSON.stringify({ error: { errors: [{ reason: `SERVICE_DISABLED${' '.repeat(120)}` }] } })).kind, 'access_denied');
});

test('constructor copies allowlisted diagnostics without retaining extra fields or list references', () => {
  const reasons = [{ reason: 'unknown', domain: 'googleapis.com', metadata: { secret: 'secret-consumer-123' } }];
  const diagnostics = { httpStatus: 403, reasons, legacyReasons: ['other'], rawBody: 'secret-consumer-123' };
  const error = new Dv360Error('access_denied', undefined, diagnostics);
  reasons[0].reason = 'changed';
  diagnostics.legacyReasons.push('changed');
  assert.deepEqual(error.diagnostics, { httpStatus: 403, reasons: [{ reason: 'unknown', domain: 'googleapis.com' }], legacyReasons: ['other'] });
  assert.equal(JSON.stringify(error).includes('secret-consumer-123'), false);
});


test('404 never exposes a resource path from the Google message', () => {
  const error = classifyHttpError(404, JSON.stringify({ error: { message: 'advertisers/987654' } }));
  for (const text of [error.message, String(error), JSON.stringify(error)]) {
    assert.equal(text.includes('advertisers/987654'), false);
  }
  assert.equal('cause' in error, false);
});

test('429 uses the fixed per-minute message and never exposes Google text', () => {
  const error = classifyHttpError(429, JSON.stringify({ error: { message: 'secret-consumer-123' } }));
  assert.equal(error.kind, 'rate_limited');
  assert.equal(error.retryable, true);
  assert.equal(error.message, 'Too many Display & Video 360 requests in the last minute. Wait a minute, then try again.');
  assert.equal(JSON.stringify(error).includes('secret-consumer-123'), false);
});
