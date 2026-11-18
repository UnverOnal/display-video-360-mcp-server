import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolRunner, LOGGED_KINDS, runWithoutLogging, type ToolCallEvent } from './call.js';

const result = { content: [{ type: 'text', text: 'result' }] };

function fixture() {
  const events: ToolCallEvent[] = [];
  let time = 100;
  const run = createToolRunner({ log: event => events.push(event), now: () => time, newCallId: () => '0123456789abcdef' });
  return { events, run, setTime(value: number) { time = value; } };
}

test('runner returns the same result and logs one successful call with injected ID and rounded duration', async () => {
  const { run, events, setTime } = fixture();
  const returned = await run('health', async call => {
    assert.equal(call.callId, '0123456789abcdef');
    assert.deepEqual(events, []);
    setTime(112.6);
    return result;
  });
  assert.equal(returned, result);
  assert.deepEqual(events, [{ type: 'tool.call', tool: 'health', callId: '0123456789abcdef', outcome: 'ok', durationMs: 13 }]);
});

test('runner clamps negative durations to zero', async () => {
  const { run, events, setTime } = fixture();
  await run('health', async () => { setTime(90); return result; });
  assert.equal(events[0].durationMs, 0);
});

test('an isError result without a recorded error has no error class or kind', async () => {
  const { run, events } = fixture();
  const failure = { ...result, isError: true };
  assert.equal(await run('run_report', async () => failure), failure);
  assert.deepEqual(events, [{ type: 'tool.call', tool: 'run_report', callId: '0123456789abcdef', outcome: 'error', durationMs: 0 }]);
});

class BidManagerError extends Error {
  readonly kind = 'server_error';
}

for (const [label, error, details] of [
  ['named error with known kind', new BidManagerError('private message'), { errorClass: 'BidManagerError', kind: 'server_error' }],
  ['TypeError', new TypeError('private message'), { errorClass: 'TypeError' }],
  ['string', 'boom', { errorClass: 'string' }],
  ['undefined', undefined, { errorClass: 'undefined' }],
  ['null', null, { errorClass: 'object' }],
  ['number', 42, { errorClass: 'number' }],
  ['boolean', false, { errorClass: 'boolean' }],
  ['symbol', Symbol('private'), { errorClass: 'symbol' }],
  ['function', () => {}, { errorClass: 'function' }],
  ['missing constructor', Object.create(null), { errorClass: 'Object' }],
  ['invalid class name', { constructor: { name: 'private/secret' } }, { errorClass: 'Object' }],
  ['empty class name', { constructor: { name: '' } }, { errorClass: 'Object' }],
  ['class name starting with a digit', { constructor: { name: '1Secret' } }, { errorClass: 'Object' }],
  ['overlong class name', { constructor: { name: 'A'.repeat(65) } }, { errorClass: 'Object' }],
  ['non-string class name', { constructor: { name: 7 } }, { errorClass: 'Object' }],
  ['maximum-length class name', { constructor: { name: '$' + '_'.repeat(63) } }, { errorClass: '$' + '_'.repeat(63) }],
  ['unknown string kind', { kind: 'privateTokenABC123' }, { errorClass: 'Object', kind: 'other' }],
  ['non-string kind', { kind: 42 }, { errorClass: 'Object' }],
] as const) {
  test(`failed records ${label} without logging other error fields`, async () => {
    const { run, events } = fixture();
    assert.equal(await run('run_report', async call => { call.failed(error); return result; }), result);
    assert.deepEqual(events, [{
      type: 'tool.call', tool: 'run_report', callId: '0123456789abcdef', outcome: 'error', durationMs: 0, ...details,
    }]);
  });
}

test('error description reads only constructor.name and kind', async () => {
  const accessed: PropertyKey[] = [];
  const error = new Proxy({ kind: 'timeout' }, {
    get(target, key, receiver) {
      accessed.push(key);
      assert.ok(key === 'constructor' || key === 'kind', `unexpected property ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
  const { run, events } = fixture();
  await run('get_report', async call => { call.failed(error); return result; });
  assert.deepEqual(accessed, ['constructor', 'kind']);
  assert.equal(events[0].errorClass, 'Object');
  assert.equal(events[0].kind, 'timeout');
});

const throwing = () => { throw new Error('private getter failure'); };
const revoked = Proxy.revocable({}, {});
revoked.revoke();
for (const [label, error] of [
  ['constructor getter', { get constructor(): never { return throwing(); } }],
  ['constructor name getter', { constructor: { get name(): never { return throwing(); } } }],
  ['kind getter', { get kind(): never { return throwing(); } }],
  ['proxy', new Proxy({}, { get: throwing })],
  ['revoked proxy', revoked.proxy],
] as const) {
  test(`a throwing ${label} falls back to Object and preserves a returned result`, async () => {
    const { run, events } = fixture();
    assert.equal(await run('run_report', async call => { call.failed(error); return result; }), result);
    assert.deepEqual(events, [{
      type: 'tool.call', tool: 'run_report', callId: '0123456789abcdef', outcome: 'error', durationMs: 0, errorClass: 'Object',
    }]);
  });

  test(`a thrown error with throwing ${label} is logged and rethrown unchanged`, async () => {
    const { run, events } = fixture();
    const notThrown = Symbol('not thrown');
    let caught: unknown = notThrown;
    try {
      await run('run_report', async () => { throw error; });
    } catch (value) {
      caught = value;
    }
    assert.equal(caught, error);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'error');
    assert.equal(events[0].errorClass, 'Object');
    assert.equal(Object.hasOwn(events[0], 'kind'), false);
  });
}

test('LOGGED_KINDS has no duplicates and every listed kind is preserved', async () => {
  assert.equal(new Set(LOGGED_KINDS).size, LOGGED_KINDS.length);
  for (const kind of LOGGED_KINDS) {
    const { run, events } = fixture();
    await run('get_report', async call => { call.failed({ kind }); return result; });
    assert.equal(events[0].kind, kind);
  }
});

for (const [kind, expected] of [['too_large', 'too_large'], ['privateTokenABC123', 'other']] as const) {
  test(`note records ${expected} without changing a successful outcome`, async () => {
    const { run, events } = fixture();
    await run('get_report', async call => { call.note(kind); return result; });
    assert.deepEqual(events, [{
      type: 'tool.call', tool: 'get_report', callId: '0123456789abcdef', outcome: 'ok', durationMs: 0, kind: expected,
    }]);
  });
}

test('note preserves an isError outcome and the first note wins', async () => {
  const { run, events } = fixture();
  await run('get_report', async call => {
    call.note('download_failed'); call.note('too_large');
    return { ...result, isError: true };
  });
  assert.equal(events[0].outcome, 'error');
  assert.equal(events[0].kind, 'download_failed');
  assert.equal(Object.hasOwn(events[0], 'errorClass'), false);
});

for (const noteFirst of [true, false]) {
  test(`a failed error's kind wins over a note (note first: ${noteFirst})`, async () => {
    const { run, events } = fixture();
    await run('get_report', async call => {
      if (noteFirst) call.note('too_large');
      call.failed(new BidManagerError());
      if (!noteFirst) call.note('too_large');
      return result;
    });
    assert.equal(events[0].kind, 'server_error');
    assert.equal(events[0].outcome, 'error');
  });
}

test('a note supplies kind when a failed error has none', async () => {
  const { run, events } = fixture();
  await run('get_report', async call => { call.failed(new TypeError()); call.note('timeout'); return result; });
  assert.equal(events[0].errorClass, 'TypeError');
  assert.equal(events[0].kind, 'timeout');
});

test('the first failed call wins even when its value is undefined', async () => {
  for (const first of [new TypeError(), undefined]) {
    const { run, events } = fixture();
    await run('run_report', async call => { call.failed(first); call.failed(new BidManagerError()); return result; });
    assert.equal(events[0].outcome, 'error');
    assert.equal(events[0].errorClass, first === undefined ? 'undefined' : 'TypeError');
    assert.equal(Object.hasOwn(events[0], 'kind'), false);
  }
});

for (const error of [new BidManagerError('private'), 'boom', undefined]) {
  test(`a throwing body logs once and rethrows the same ${typeof error} value`, async () => {
    const { run, events, setTime } = fixture();
    // Capture directly so throwing undefined is also checked by identity.
    let caught = false;
    try {
      await run('run_report', async () => { setTime(104.4); throw error; });
    } catch (value) {
      caught = true;
      assert.equal(value, error);
    }
    assert.equal(caught, true);
    assert.deepEqual(events, [{
      type: 'tool.call', tool: 'run_report', callId: '0123456789abcdef', outcome: 'error', durationMs: 4,
      ...(error instanceof BidManagerError ? { errorClass: 'BidManagerError', kind: 'server_error' } : { errorClass: typeof error }),
    }]);
  });
}

test('default call IDs are distinct 16-character lowercase hex strings', async () => {
  const events: ToolCallEvent[] = [];
  const ids: string[] = [];
  const run = createToolRunner({ log: event => events.push(event) });
  for (let index = 0; index < 2; index++) {
    await run('health', async call => { ids.push(call.callId); return result; });
  }
  assert.equal(new Set(ids).size, 2);
  for (const [index, id] of ids.entries()) {
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(events[index].callId, id);
    assert.ok(Number.isInteger(events[index].durationMs));
    assert.ok(events[index].durationMs >= 0);
  }
});

test('runWithoutLogging supplies fresh IDs, ignores failed and note, and preserves results and throws', async () => {
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    assert.equal(await runWithoutLogging('health', async call => {
      ids.push(call.callId); call.failed(new Error()); call.note('privateTokenABC123'); return result;
    }), result);
  }
  ids.forEach(id => assert.match(id, /^[0-9a-f]{16}$/));
  assert.notEqual(ids[0], ids[1]);
  const error = new Error('private');
  await assert.rejects(runWithoutLogging('health', async () => { throw error; }), caught => caught === error);
});
