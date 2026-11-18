import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareMatches, foldName, matchName, type MatchKind } from './names.js';

test('foldName ignores case', () => {
  assert.equal(foldName('Acme SPRING Sale'), 'acme spring sale');
});

test('foldName folds every Turkish i form, composed or decomposed, to plain i', () => {
  for (const text of ['İstanbul', 'istanbul', 'ISTANBUL', 'ıstanbul', 'İstanbul', 'i̇stanbul']) {
    assert.equal(foldName(text), 'istanbul', JSON.stringify(text));
  }
});

test('foldName keeps U+0307 after letters other than i', () => {
  assert.equal(foldName('ȧ'), 'ȧ'.normalize('NFKC'));
  assert.notEqual(foldName('ȧ'), 'a');
});

test('foldName applies NFKC: full-width letters, ligatures, decomposed accents', () => {
  assert.equal(foldName('ＡＣＭＥ'), 'acme');
  assert.equal(foldName('ﬁnance'), 'finance');
  assert.equal(foldName('café'), foldName('café'));
});

test('foldName collapses whitespace runs and trims', () => {
  assert.equal(foldName('  Acme \t Spring\n Sale  '), 'acme spring sale');
});

test('foldName keeps accents', () => {
  assert.notEqual(foldName('é'), foldName('e'));
  assert.notEqual(foldName('Müşteri'), foldName('Musteri'));
});

test('matchName gives exact, prefix, contains, or no match', () => {
  assert.equal(matchName('acme', 'ACME'), 'exact');
  assert.equal(matchName('acme', 'Acme Spring'), 'prefix');
  assert.equal(matchName('spring', 'Acme Spring'), 'contains');
  assert.equal(matchName('winter', 'Acme Spring'), undefined);
});

test('matchName never matches an empty query', () => {
  assert.equal(matchName('', 'Acme'), undefined);
  assert.equal(matchName('', ''), undefined);
});

const item = (kind: MatchKind, folded: string, id: string) => ({ kind, folded, id });
const order = (items: ReturnType<typeof item>[]) => [...items].sort(compareMatches).map(entry => entry.id);

test('compareMatches puts exact before prefix before contains', () => {
  assert.deepEqual(order([item('contains', 'a', '1'), item('prefix', 'b', '2'), item('exact', 'c', '3')]), ['3', '2', '1']);
});

test('compareMatches orders by folded name in code-unit order within a kind', () => {
  assert.deepEqual(order([item('contains', 'zeta', '1'), item('contains', 'alpha', '2'), item('contains', 'Ä', '3')]), ['2', '1', '3']);
});

test('compareMatches breaks ties by numeric ID', () => {
  assert.deepEqual(order([item('exact', 'acme', '10'), item('exact', 'acme', '9'), item('exact', 'acme', '11')]), ['9', '10', '11']);
  assert.equal(compareMatches(item('exact', 'a', '5'), item('exact', 'a', '5')), 0);
});
