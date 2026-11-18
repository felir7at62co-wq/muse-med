/** Release source fixtures fail explicitly instead of relying on a server Git checkout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PINNED_SOURCE_REVISION,createPinnedSourceReader} from './pinned-source.mjs';

function fixture(t,files={'src/example.js':'first\r\nsecond\r\n'},revision=PINNED_SOURCE_REVISION){const home=mkdtempSync(join(tmpdir(),'muse-pinned-source-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const file=join(home,'pristine.json');writeFileSync(file,JSON.stringify({revision,files}));return {root:join(home,'checkout'),file};}
test('release fixture reads pinned text without Git and rejects missing or outside files',t=>{const f=fixture(t),read=createPinnedSourceReader(f.root,{fixturePath:f.file});assert.equal(read(join(f.root,'src/example.js')),'first\nsecond\n');assert.throws(()=>read(join(f.root,'missing.js')),/missing/);assert.throws(()=>read(join(f.root,'../outside.js')),/within/);assert.throws(()=>read('relative.js'),/within/);});
test('release fixture rejects a wrong revision or non-text and unsafe filenames',t=>{for(const[files,revision]of[[{'src/example.js':'text'},'wrong'],[{'src/example.js':4},PINNED_SOURCE_REVISION],[{'../outside.js':'text'},PINNED_SOURCE_REVISION],[{'C:/outside.js':'text'},PINNED_SOURCE_REVISION]]){const f=fixture(t,files,revision);assert.throws(()=>createPinnedSourceReader(f.root,{fixturePath:f.file}),/invalid/);}});
test('an explicitly missing or relative fixture does not fall back to local sources',t=>{const f=fixture(t);assert.throws(()=>createPinnedSourceReader(f.root,{fixturePath:join(f.root,'missing.json')}),{code:'ENOENT'});assert.throws(()=>createPinnedSourceReader(f.root,{fixturePath:'relative.json'}),/absolute/);});
