import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {importPackage} from './support.mjs';
const {ALL_PATCHES} = await importPackage('lib/patches/index.mjs');
const {applyReplacementsToText} = await importPackage('lib/core/verify.mjs');
const {applyHookDenyReverses} = await importPackage('lib/hooks-deny.js');

const patch = id => ALL_PATCHES.find(row => row.id === id);
const apply = (source, ids) => ids.reduce((text, id) => applyReplacementsToText(text, patch(id)).text, source);
const compileOnly = source => new Function(source.replace(/^import[^\n]+\n/gm, '').replace(/^export[^\n]+/gm, ''));

test('#92 adds one actual host argument and repeated apply is byte-identical', () => {
  const original = 'return ["--expose-internals", "entry.js", "runtime", "project"];';
  const once = applyReplacementsToText(original, patch(92));
  assert.equal(once.changed, true);
  assert.deepEqual(new Function(once.text)(), ['--expose-internals', '--max-http-header-size=262144', 'entry.js', 'runtime', 'project']);
  for (let i = 0; i < 4; ++i) {
    const again = applyReplacementsToText(once.text, patch(92));
    assert.equal(again.changed, false);
    assert.equal(again.text, once.text);
  }
  assert.equal(once.text.match(/--max-http-header-size=/g).length, 1);
});

test('#92 leaves an unknown flag and an existing owned expansion unchanged', () => {
  const unknown = 'return ["--expose-unknown-internals", "entry.js"];';
  assert.equal(applyReplacementsToText(unknown, patch(92)).text, unknown);
  const owned = 'return ["--expose-internals", /* [dsh-purge] raise-host-header-limit */ "--max-http-header-size=262144", "entry.js"];';
  assert.equal(applyReplacementsToText(owned, patch(92)).changed, false);
  // Each separate known invocation is patched once; one marker must not
  // prevent another invocation in the same file from receiving its flag.
  const mixed = owned + '\nreturn ["--expose-internals", "entry-2.js"];';
  const fixed = applyReplacementsToText(mixed, patch(92));
  assert.equal(fixed.changed, true);
  assert.equal(fixed.text.match(/--max-http-header-size=/g).length, 2);
  assert.equal(applyReplacementsToText(fixed.text, patch(92)).changed, false);
});

for (const [packageName, id] of [['dsh-hooks-claude-code', 30], ['dsh-hooks-codex', 31]]) {
  const original = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', packageName + '.mjs'), 'utf8');
  const family = [id, 64, 65];
  test(`#${id} first apply, family reapply, and exact reverse on the shipped ${packageName}`, () => {
    const once = apply(original, family);
    assert.notEqual(once, original);
    assert(once.includes('[dsh-purge] pre-step reject disabled'));
    assert(once.includes('[dsh-purge] Stop hook steer disabled'));
    assert(once.includes('if (merged.decision === "deny") { /* [dsh-purge] UserPromptSubmit deny→allow */ }'));
    for (let i = 0; i < 4; ++i) assert.equal(apply(once, family), once);
    compileOnly(once);
    assert.equal(applyHookDenyReverses(once).text, original, 'Owned changes must reverse to the exact original bytes');
  });

  test(`#${id} completes a partially applied file without rewriting the #65 empty branch`, () => {
    const first = patch(id).replacements[0];
    const rawNeedle = 'if (merged.decision === "deny")';
    const firstAt = original.indexOf(rawNeedle);
    assert(firstAt >= 0);
    const partial = original.slice(0, firstAt) + first.replace + original.slice(firstAt + rawNeedle.length);
    const target = apply(original, family);
    assert.equal(apply(partial, family), target, 'A marker in one location must not skip remaining real rejection bodies');
    const afterPrestep = apply(partial, [65]);
    assert(afterPrestep.includes('[dsh-purge] UserPromptSubmit deny→allow'));
    assert.equal(apply(afterPrestep, family), target);
    assert.equal(applyReplacementsToText(target, patch(id)).changed, false);
  });

  test(`#${id} keeps unknown denial code and decision-like strings intact`, () => {
    const unknown = '\t\tif (merged.decision === "deny") { customRejectHandler(); }';
    assert.equal(applyReplacementsToText(unknown, patch(id)).text, unknown);
    const nonCode = 'const message = \'if (merged.decision === "deny")\';';
    assert.equal(applyReplacementsToText(nonCode, patch(id)).text, nonCode);
  });

  test(`#${id} keeps CRLF files byte-identical after repeated family application`, () => {
    const crlf = original.replace(/\r?\n/g, '\r\n');
    const once = apply(crlf, family);
    assert(!/(?<!\r)\n/.test(once));
    assert.equal(apply(once, family), once);
    // The existing reverse function is LF based; format parity is checked by
    // comparing the normalized source instead of claiming byte-level CRLF undo.
    assert.equal(applyHookDenyReverses(once.replace(/\r\n/g, '\n')).text, original.replace(/\r\n/g, '\n'));
  });
}
