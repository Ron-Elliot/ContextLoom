import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoNul, buildArtifactId, toCanonicalUri } from './envelope';

test('stable ID across runs — same inputs produce same artifact_id', () => {
  const id1 = buildArtifactId('proj-1', 'git-repo', 'src/index.ts');
  const id2 = buildArtifactId('proj-1', 'git-repo', 'src/index.ts');
  assert.equal(id1, id2);
});

test('tuple-boundary collision resistance — NUL separator prevents adjacent-field collisions', () => {
  const idABC = buildArtifactId('a', 'b', 'c');
  const idAB_C = buildArtifactId('ab', '', 'c');
  const idA_BC = buildArtifactId('a', '', 'bc');
  assert.notEqual(idABC, idAB_C);
  assert.notEqual(idABC, idA_BC);
  assert.notEqual(idAB_C, idA_BC);
});

test('toCanonicalUri strips leading ./', () => {
  assert.equal(toCanonicalUri('./docs/foo.md'), 'docs/foo.md');
});

test('toCanonicalUri normalises Windows backslashes to forward slashes', () => {
  assert.equal(toCanonicalUri('docs\\foo.md'), 'docs/foo.md');
});

test('toCanonicalUri is a no-op for already-canonical paths', () => {
  assert.equal(toCanonicalUri('docs/foo.md'), 'docs/foo.md');
});

test('assertNoNul throws when component contains a NUL byte', () => {
  assert.throws(() => assertNoNul('bad\x00value', 'test_field'), /NUL/);
});

test('assertNoNul does not throw for normal strings', () => {
  assert.doesNotThrow(() => assertNoNul('normal-value', 'test_field'));
});
