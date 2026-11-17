import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {importPackage, packageFile, temporaryDirectory} from './support.mjs';

const home = path.join(temporaryDirectory, 'home');
const aiBase = path.join(temporaryDirectory, 'runtime', 'node_modules', '@deepseek-ai');
const presetFile = path.join(home, '.agent-presets', 'unrestricted', 'agent.cordis.yml');
fs.mkdirSync(path.dirname(presetFile), {recursive: true});
fs.mkdirSync(path.join(aiBase, 'dsh-agent-instructions', 'lib'), {recursive: true});
fs.writeFileSync(path.join(aiBase, 'dsh-agent-instructions', 'lib', 'index.js'), 'export {};\n');
for (const name of ['dsh-agent-instructions', 'dsh-agent-loop', 'dsh-system-prompt']) {
  fs.mkdirSync(path.join(aiBase, name), {recursive: true});
  fs.writeFileSync(path.join(aiBase, name, 'package.json'), JSON.stringify({name: '@deepseek-ai/' + name, version: '0.2.1-alpha.1'}));
}
process.env.DSH_HOME = home;
process.env.MUSE_HOME = home;
process.env.DSH_BASE = aiBase;
process.env.DSH_PROFILE = 'desktop';
process.env.DSH_SURFACE = 'desktop';
const {ALL_PATCHES} = await importPackage('lib/patches/index.mjs');
const {applyReplacementsToText} = await importPackage('lib/core/verify.mjs');
const {patchStatus, patchDrift} = await importPackage('lib/core.js');
const patch = ALL_PATCHES.find(row => row.id === 76);
const options = {dshHome: home, surface: 'desktop'};

async function assertNoop(source) {
  const result = applyReplacementsToText(source, patch, presetFile);
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
  fs.writeFileSync(presetFile, source);
  assert.equal((await patchStatus(aiBase, [patch], options))[76], 'skipped');
  const drift = await patchDrift(aiBase, [patch], options);
  assert.equal(drift.drifted.length, 0);
  assert.equal(drift.optionalDrift.length, 0);
  assert.equal(fs.readFileSync(presetFile, 'utf8'), source);
}

test('bundled unrestricted template is unchanged and does not report drift', async () => {
  await assertNoop(fs.readFileSync(packageFile('presets/unrestricted/agent.cordis.yml'), 'utf8'));
});

test('listed legacy identity strings are removed and reported as applied', async () => {
  for (const replacement of patch.replacements) {
    const source = '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n' + replacement.pattern + '\n';
    const result = applyReplacementsToText(source, patch, presetFile);
    assert.equal(result.changed, true);
    assert.equal(result.text, source.replace(replacement.pattern, replacement.replace));
    fs.writeFileSync(presetFile, result.text);
    assert.equal((await patchStatus(aiBase, [patch], options))[76], 'applied');
    assert.equal((await patchDrift(aiBase, [patch], options)).optionalDrift.length, 0);
  }
});

test('custom preset prefix is preserved byte for byte with skipped status', async () => {
  await assertNoop('- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: |\n      You are the production editor for our drama project.\n      Keep project-specific constraints and wording.\n');
});
