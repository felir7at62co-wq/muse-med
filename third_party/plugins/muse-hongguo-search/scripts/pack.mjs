import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('dist', { recursive:true });
if (!process.env.npm_execpath) throw new Error('Use npm run package');
const result = spawnSync(process.execPath, [process.env.npm_execpath,'pack','--ignore-scripts','--pack-destination','dist'], {stdio:'inherit'});
process.exitCode = result.status ?? 1;
