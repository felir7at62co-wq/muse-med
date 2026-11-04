import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.js';

test('three scoped metadata tools register and dispose without network activity', async () => {
  const definitions = [], cleanup = [];
  apply({ tools: { register(definition) { definitions.push(definition); return () => { definitions.splice(definitions.indexOf(definition), 1); }; } },
    effect(factory) { cleanup.push(factory()); } });
  assert.deepEqual(definitions.map(value => value.name), ['qimao_rankings', 'qimao_search', 'qimao_detail']);
  const signal = new AbortController().signal;
  await assert.rejects(() => definitions[0].execute({ source: 'unknown' }, { signal }));
  await assert.rejects(() => definitions[1].execute({ query: '' }, { signal }));
  await assert.rejects(() => definitions[2].execute({ bookId: 101 }, { signal }));
  for (const definition of definitions) {
    assert.equal(definition.parameters.additionalProperties, false); assert.ok(definition.output.schema);
    assert.equal(definition.presentCall().card, 'generic');
  }
  for (const dispose of cleanup.reverse()) await dispose();
  assert.equal(definitions.length, 0);
});
