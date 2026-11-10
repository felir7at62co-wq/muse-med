import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {importPackage} from './support.mjs';

const {ALL_PATCHES} = await importPackage('lib/patches/index.mjs');
const {applyReplacementsToText} = await importPackage('lib/core/verify.mjs');
const sourcePath = new URL('./fixtures/muse-1.2.8-system-prompt.mjs', import.meta.url);
const original = fs.readFileSync(sourcePath, 'utf8');
const patch = ALL_PATCHES.find(row => row.id === 40);

test('shipped Muse prompt variant is recognized once and preserves line endings', () => {
  const first = applyReplacementsToText(original, patch);
  assert.equal(first.changed, true);
  assert.equal(first.text.includes('const requiredContexts ='), original.includes('const requiredContexts ='));
  assert.equal(applyReplacementsToText(first.text, patch).changed, false);
  assert.equal(applyReplacementsToText(first.text, patch).text, first.text);
  const crlf = original.replace(/\r?\n/g, '\r\n');
  const converted = applyReplacementsToText(crlf, patch);
  assert.equal(converted.changed, true);
  assert.equal(converted.text.replace(/\r\n/g, '\n'), first.text);
  assert.equal(/(?<!\r)\n/.test(converted.text), false);
  const unknown = original.replace('const transformed = await this.ctx.waterfall', 'const transformed = await this.ctx.changedWaterfall');
  assert.equal(applyReplacementsToText(unknown, patch).changed, false);
});

for (const [index, replacement] of patch.replacements.entries()) {
  test(`known prompt layout ${index + 1} remains repeatable`, () => {
    const first = applyReplacementsToText(replacement.pattern, patch);
    assert.equal(first.changed, true);
    assert.equal(first.text, replacement.replace);
    assert.equal(applyReplacementsToText(first.text, patch).changed, false);
  });
}
