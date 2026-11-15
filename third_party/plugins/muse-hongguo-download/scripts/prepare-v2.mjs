/** Prepare a local, pinned v2 SDK with separately supplied interpreters and no downloads. */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
/** SHA256 of the supplied original 2.0.0 Windows installer, used only as a data archive. */
export const SETUP_SHA256 = '36bd3ffc0d10f7b08401d3ccec29d2120d4cd1c693a46a20f403b085f315a5bb';
/** Exact original SDK members; excludes user settings, queues, devices and licences. */
export const SOURCE_FILES = Object.freeze([
  {
    "member": "lib/app/BouncyCastle.Cryptography.dll",
    "path": "broker/BouncyCastle.Cryptography.dll",
    "bytes": 12259328,
    "sha256": "cbc63afffb8224c727db66e3af9a54cf2a579ea23da98ea2c66e222acda861b0"
  },
  {
    "member": "lib/app/Hongguo.Licensing.dll",
    "path": "broker/Hongguo.Licensing.dll",
    "bytes": 491520,
    "sha256": "ad266e4b66388f65ab5363d2a13f9163a585df3f2c666faf5330cbf176d47202"
  },
  {
    "member": "lib/app/System.Security.Cryptography.ProtectedData.dll",
    "path": "broker/System.Security.Cryptography.ProtectedData.dll",
    "bytes": 49152,
    "sha256": "48379b0473921cf1a0c257c11148f58e8b34e0af7278f99bd9dc2d57db8a075f"
  },
  {
    "member": "lib/app/engine/lib/annotations-23.0.0.jar",
    "path": "engine/lib/annotations-23.0.0.jar",
    "bytes": 29371,
    "sha256": "7b0f19724082cbfcbc66e5abea2b9bc92cf08a1ea11e191933ed43801eb3cd05"
  },
  {
    "member": "lib/app/engine/lib/engine.jar",
    "path": "engine/lib/engine.jar",
    "bytes": 738226,
    "sha256": "b13b89318ad2980270d0fbb4236e4f29bf2b266222a94e6c72b45c352da533d4"
  },
  {
    "member": "lib/app/engine/lib/helper.jar",
    "path": "engine/lib/helper.jar",
    "bytes": 324310,
    "sha256": "76e16b86c860bf6aa3bf2f7cca4498e22bb056c41fe1d06c7c18ee06e856c8f1"
  },
  {
    "member": "lib/app/engine/lib/jna-jpms-5.14.0.jar",
    "path": "engine/lib/jna-jpms-5.14.0.jar",
    "bytes": 1879108,
    "sha256": "204912ead5e0891f53aab7be346b75758abbe38bd9fb2d320bfa21bbca6905b7"
  },
  {
    "member": "lib/app/engine/lib/kaml-jvm-0.79.0.jar",
    "path": "engine/lib/kaml-jvm-0.79.0.jar",
    "bytes": 198522,
    "sha256": "2617129ac934b8c5152e6fc616222428809ede444fe7fa83231917bea141ea7f"
  },
  {
    "member": "lib/app/engine/lib/kotlin-stdlib-2.4.21.jar",
    "path": "engine/lib/kotlin-stdlib-2.4.21.jar",
    "bytes": 1853315,
    "sha256": "bd8250210584cb659847dce9cda660f8e9906e5def7fbebcea93dc6dcb6a88a3"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-coroutines-core-jvm-1.11.0.jar",
    "path": "engine/lib/kotlinx-coroutines-core-jvm-1.11.0.jar",
    "bytes": 1577052,
    "sha256": "d1d75aa01dffbb4d1c520e67e4c4e7f5f6174718e7cb4632412503f2f0e604fa"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-coroutines-slf4j-1.11.0.jar",
    "path": "engine/lib/kotlinx-coroutines-slf4j-1.11.0.jar",
    "bytes": 4446,
    "sha256": "1043471e7d5f99680df3a056cf766276e0fe339e48030dea503fc1c94c33743e"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-datetime-jvm-0.8.0-0.6.x-compat.jar",
    "path": "engine/lib/kotlinx-datetime-jvm-0.8.0-0.6.x-compat.jar",
    "bytes": 753869,
    "sha256": "c764cb4882bb30a5b4279e07324ef60ed4f82f23a7bb420ee62550266d0f6162"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-io-bytestring-jvm-0.9.1.jar",
    "path": "engine/lib/kotlinx-io-bytestring-jvm-0.9.1.jar",
    "bytes": 22776,
    "sha256": "8589de0b7c476bfdd02a24641685f609ade72f5e595cf2909c168acdba7e6ba4"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-io-core-jvm-0.9.1.jar",
    "path": "engine/lib/kotlinx-io-core-jvm-0.9.1.jar",
    "bytes": 153576,
    "sha256": "765d8851d8ca694706931331b92386844800867e041b720f1f193dbda874d370"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-serialization-core-jvm-1.12.0.jar",
    "path": "engine/lib/kotlinx-serialization-core-jvm-1.12.0.jar",
    "bytes": 416396,
    "sha256": "bcfddcac76159058ba0953af05938c17111d238cd41be7191874656454d62f1a"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-serialization-json-io-jvm-1.12.0.jar",
    "path": "engine/lib/kotlinx-serialization-json-io-jvm-1.12.0.jar",
    "bytes": 8685,
    "sha256": "01f605b17126f4e4f97f94234cd7c6bf6833bd1982ca120218d718678d1c62b4"
  },
  {
    "member": "lib/app/engine/lib/kotlinx-serialization-json-jvm-1.12.0.jar",
    "path": "engine/lib/kotlinx-serialization-json-jvm-1.12.0.jar",
    "bytes": 306230,
    "sha256": "879eb73e46cb63253ab0fa7cca4448f5c96bca1a16ff377abcb71ebab60e0631"
  },
  {
    "member": "lib/app/engine/lib/ktor-client-content-negotiation-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-client-content-negotiation-jvm-3.6.0.jar",
    "bytes": 32652,
    "sha256": "3498b42539eba4088360d9be2bec1bdcec0a86b066428b1d9efba53e9378a622"
  },
  {
    "member": "lib/app/engine/lib/ktor-client-core-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-client-core-jvm-3.6.0.jar",
    "bytes": 963192,
    "sha256": "7dc9a3c76bf43f672e8331aad1ecb06864f69f464ab1517c24ed8a38c86f812f"
  },
  {
    "member": "lib/app/engine/lib/ktor-client-okhttp-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-client-okhttp-jvm-3.6.0.jar",
    "bytes": 63998,
    "sha256": "40ee72166eaf2c3cf868fc87bd78e83d79da0b3d0d43d16b389e21f2cd2c56c3"
  },
  {
    "member": "lib/app/engine/lib/ktor-events-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-events-jvm-3.6.0.jar",
    "bytes": 6397,
    "sha256": "d3962f4a4244102d1ef8b84b21429ffc26be3512b5f1f96c607265ca1cec5c0b"
  },
  {
    "member": "lib/app/engine/lib/ktor-http-cio-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-http-cio-jvm-3.6.0.jar",
    "bytes": 134494,
    "sha256": "4cabe83cb367e0a807f849f2d4313b9de563cffcec0d262844a783d51a47738d"
  },
  {
    "member": "lib/app/engine/lib/ktor-http-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-http-jvm-3.6.0.jar",
    "bytes": 458908,
    "sha256": "2a14cb160436b134c10793727aeed3055ae7014ff170c79ffbcd90b26dd90de2"
  },
  {
    "member": "lib/app/engine/lib/ktor-io-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-io-jvm-3.6.0.jar",
    "bytes": 303591,
    "sha256": "7426ad1759833460507ee7065f17085410dc7b32081a1daee8c91cf6f40e257c"
  },
  {
    "member": "lib/app/engine/lib/ktor-network-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-network-jvm-3.6.0.jar",
    "bytes": 202163,
    "sha256": "746a751146d61865f51d6dd56b18e3e0fa68b36587561ee123ff7ce730d8c590"
  },
  {
    "member": "lib/app/engine/lib/ktor-openapi-schema-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-openapi-schema-jvm-3.6.0.jar",
    "bytes": 572250,
    "sha256": "b5a290b3e9ceb9a1b485bcb4813d1dacec28f7e88353f317080b9dddb2a9c9d1"
  },
  {
    "member": "lib/app/engine/lib/ktor-serialization-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-serialization-jvm-3.6.0.jar",
    "bytes": 23007,
    "sha256": "d67f46cf64f8c97a2e14d4d5c0c1a4be315c8bc128bcc58370c0716363c258db"
  },
  {
    "member": "lib/app/engine/lib/ktor-serialization-kotlinx-json-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-serialization-kotlinx-json-jvm-3.6.0.jar",
    "bytes": 26741,
    "sha256": "d93f7e1bf838dba0d5b2a1553f0e0b3579f9e28fa6f98c4a3340307699c3d96f"
  },
  {
    "member": "lib/app/engine/lib/ktor-serialization-kotlinx-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-serialization-kotlinx-jvm-3.6.0.jar",
    "bytes": 29084,
    "sha256": "bb5ca77c4a22ef9c606a4412e1d813a754c398b7bdbd543c5b9441f16e6bcdd7"
  },
  {
    "member": "lib/app/engine/lib/ktor-sse-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-sse-jvm-3.6.0.jar",
    "bytes": 8415,
    "sha256": "9fcb5074b74d14b9f18ace4ee9acd6263176ae01b4e8e5c8f72b6aa978c279ea"
  },
  {
    "member": "lib/app/engine/lib/ktor-utils-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-utils-jvm-3.6.0.jar",
    "bytes": 397498,
    "sha256": "05698e23c0539c7042676a98557e3358e77e19efa9fa4fc2145f20ad8721aefc"
  },
  {
    "member": "lib/app/engine/lib/ktor-websocket-serialization-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-websocket-serialization-jvm-3.6.0.jar",
    "bytes": 7268,
    "sha256": "c87fe370c17868dc8c101947452bf8a8622363cf4d83a342334666bb46fe627b"
  },
  {
    "member": "lib/app/engine/lib/ktor-websockets-jvm-3.6.0.jar",
    "path": "engine/lib/ktor-websockets-jvm-3.6.0.jar",
    "bytes": 192926,
    "sha256": "3ef8b5d544dc7f9bd041a245bb8c2ff6647d0fd1e111a65b7be54977476a5464"
  },
  {
    "member": "lib/app/engine/lib/okhttp-jvm-5.5.0.jar",
    "path": "engine/lib/okhttp-jvm-5.5.0.jar",
    "bytes": 961167,
    "sha256": "234194a04aac54858df0a750d243af7b2e39df5e4eb86e9912043ad33a9f9a52"
  },
  {
    "member": "lib/app/engine/lib/okio-jvm-3.18.2.jar",
    "path": "engine/lib/okio-jvm-3.18.2.jar",
    "bytes": 392462,
    "sha256": "681fed549d1d2c63710f42c9eab433d642c71af778babd67035c50f8c425aaff"
  },
  {
    "member": "lib/app/engine/lib/shared-jvm.jar",
    "path": "engine/lib/shared-jvm.jar",
    "bytes": 305083,
    "sha256": "175e7869810f9b4446a26d1d9420bc9304884a2775b7d59ff1f1359fd775ffbd"
  },
  {
    "member": "lib/app/engine/lib/slf4j-api-2.0.19.jar",
    "path": "engine/lib/slf4j-api-2.0.19.jar",
    "bytes": 70246,
    "sha256": "e91ff6d720609e7a194ffe758c3ed5c84e798617ae07b0a0f6a4fe229741b4bb"
  },
  {
    "member": "lib/app/engine/lib/slf4j-nop-2.0.19.jar",
    "path": "engine/lib/slf4j-nop-2.0.19.jar",
    "bytes": 4969,
    "sha256": "d0226062f9b3a2793f62002f892a8e624eb07f396130fc949e01b1d5f4888cba"
  },
  {
    "member": "lib/app/engine/lib/snakeyaml-engine-kmp-jvm-3.1.1.jar",
    "path": "engine/lib/snakeyaml-engine-kmp-jvm-3.1.1.jar",
    "bytes": 444908,
    "sha256": "733e1347e3ec909e8a7ee199e48a64d0180569461b3bc08c8a6bb1335f5ce1bd"
  },
  {
    "member": "lib/app/engine/lib/urlencoder-lib-jvm-1.6.0.jar",
    "path": "engine/lib/urlencoder-lib-jvm-1.6.0.jar",
    "bytes": 6512,
    "sha256": "8d0fd2aeb48d19dc49c563ebc00f274947e45f716c107535c12ead63decd688d"
  },
  {
    "member": "lib/app/engine/signer/classes.jar",
    "path": "engine/signer/classes.jar",
    "bytes": 3709987,
    "sha256": "83eb616eebfb385bcf1c5e10c545fb30dd8baef34f0632145d4e5741eb1eedef"
  },
  {
    "member": "lib/app/engine/signer/stubs.jar",
    "path": "engine/signer/stubs.jar",
    "bytes": 3986,
    "sha256": "91c628e810a5c71c41786b0314eb02db13dfa2d601c0bb1255e9c3eba6aca20f"
  }
].map(file => Object.freeze(file)));
const jnaFiles = {
  'darwin-arm64': { member: 'com/sun/jna/darwin-aarch64/libjnidispatch.jnilib', path: 'libjnidispatch.jnilib', bytes: 159800, sha256: '22139ef060538cccc0e654639ef36d53a96b4f5d8f0b5027116e430fed5e75df' },
  'darwin-x64': { member: 'com/sun/jna/darwin-x86-64/libjnidispatch.jnilib', path: 'libjnidispatch.jnilib', bytes: 107392, sha256: '12d88138ce3c0a20d4bb3cfbd091b7ccb1f6365a79ab07b2d786a52d104d418e' },
  'win32-x64': { member: 'com/sun/jna/win32-x86-64/jnidispatch.dll', path: 'jnidispatch.dll', bytes: 254464, sha256: '69c45175ecfd25af023f96ac0bb2c45e6a95e3ba8a5a50ee7969ccab14825c44' },
};

const extraction = String.raw`
import hashlib,json,os,pathlib,stat,sys,zipfile
s=json.load(sys.stdin); root=pathlib.Path(s['output']); root.mkdir(parents=True,exist_ok=True)
expected={f['member']:f for f in s['files']}; seen=set(); members={}
with zipfile.ZipFile(s['archive']) as z:
 for item in z.infolist():
  name=item.filename; key=name.rstrip('/'); parts=key.split('/')
  if not key or name.startswith('/') or '\\' in name or ':' in name or any(ord(c)<32 for c in name) or any(p in ('','.','..') for p in parts): raise ValueError('unsafe archive member')
  folded=key.casefold()
  if folded in seen: raise ValueError('duplicate archive member')
  seen.add(folded)
  mode=item.external_attr>>16
  if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)) or item.flag_bits&1: raise ValueError('special archive member')
  members[name]=item
 for member,f in expected.items():
  item=members.get(member)
  if item is None or item.is_dir() or item.file_size!=f['bytes']: raise ValueError('missing or changed member')
  target=root.joinpath(*f['path'].split('/')); target.parent.mkdir(parents=True,exist_ok=True)
  if not target.resolve().is_relative_to(root.resolve()): raise ValueError('escaping output member')
  current=target.parent
  while current!=root:
   if current.is_symlink(): raise ValueError('linked output directory')
   current=current.parent
  digest=hashlib.sha256(); size=0; created=False
  try:
   fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,'O_NOFOLLOW',0),0o600);created=True
   with os.fdopen(fd,'wb') as dst,z.open(item) as src:
    while True:
     block=src.read(1024*1024)
     if not block: break
     size+=len(block)
     if size>f['bytes']: raise ValueError('oversize archive member')
     digest.update(block);dst.write(block)
   if size!=f['bytes'] or digest.hexdigest()!=f['sha256']: raise ValueError('member checksum mismatch')
  except BaseException:
   if created: target.unlink(missing_ok=True)
   raise
print('EXTRACT_OK')
`;
const packageJar = String.raw`
import json,pathlib,stat,sys,zipfile
s=json.load(sys.stdin); root=pathlib.Path(s['classes']); files=sorted(root.rglob('*')); count=0
with zipfile.ZipFile(s['output'],'x',compression=zipfile.ZIP_DEFLATED) as z:
 for p in files:
  if p.is_symlink(): raise ValueError('linked class output')
  if p.is_dir(): continue
  if not p.is_file() or p.suffix!='.class': raise ValueError('unexpected class output')
  info=zipfile.ZipInfo(p.relative_to(root).as_posix(),(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(stat.S_IFREG|0o600)<<16
  z.writestr(info,p.read_bytes());count+=1
if count==0: raise ValueError('empty host JAR')
print('HOST_JAR_OK')
`;

function minimalEnvironment(extra = {}) {
  const allowed = /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|COMSPEC|PATHEXT|LANG)$/iu;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name))),
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_UI_LANGUAGE: 'en-US', ...extra };
}

function run(binary, args, { input, env = minimalEnvironment(), cwd, timeout = 180000, stage = 'native command' } = {}) {
  const result = spawnSync(binary, args, { input, env, cwd, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2, windowsHide: true });
  if (result.error || result.signal || result.status !== 0) {
    const error = new Error(`Hongguo v2 preparation failed: ${stage}`);
    if (/compilation|restore|build/u.test(stage)) error.diagnostic = result.stdout + result.stderr;
    throw error;
  }
  return result.stdout + result.stderr;
}

function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`Hongguo v2 requires an absolute ${name}`);
  return resolve(value);
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\u0000-\u001f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Hongguo v2 requires regular unlinked inputs');
  return info;
}

async function realDirectory(path, create = false) {
  const parent = dirname(path);
  if (parent !== path) await realDirectory(parent, create);
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Hongguo v2 refuses linked directories');
}

/** Derive the original Windows identity or the explicitly separated Mac identity from this physical host.
 * @param {string} platform Actual Node platform, restricted to darwin or win32.
 * @param {string} value Original OS UUID/GUID value; Windows case is significant.
 * @returns {string} Stable device identity without retaining the original OS identifier.
 */
export function physicalDeviceId(platform, value) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Hongguo v2 supports only local Mac and Windows preparation');
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new Error('Hongguo v2 could not read the physical device identity');
  const input = platform === 'darwin' ? 'muse-mac-physical-v1:' + value.toLowerCase() : 'mg:' + value;
  return 'd1:' + createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/** Select the original JNA resource for local Java and the required licence-runtime architecture.
 * @param {string} platform This process's operating system.
 * @param {string} javaArch Architecture reported by the supplied Java 17 runtime.
 * @param {string} dotnetArch Architecture reported by the supplied .NET 10 runtime.
 * @returns {object} Exact native member and whether the Mac x64 licence runtime requires Rosetta.
 */
export function nativeRuntimeTarget(platform, javaArch, dotnetArch) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Hongguo v2 supports only local Mac and Windows preparation');
  if (dotnetArch !== 'x64') throw new Error('Hongguo v2 requires the supplied .NET 10 x64 runtime');
  const jna = jnaFiles[`${platform}-${javaArch}`];
  if (!jna) throw new Error('Hongguo v2 unsupported local Java architecture');
  return { jna: { ...jna }, requiresRosetta: platform === 'darwin' };
}

function readPhysicalDevice(platform) {
  if (platform === 'darwin') {
    const output = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { stage: 'Mac physical identity' });
    return physicalDeviceId(platform, output.match(/"IOPlatformUUID"\s*=\s*"([0-9a-f-]+)"/iu)?.[1]);
  }
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) throw new Error('Hongguo v2 requires the Windows system directory');
  const output = run(join(root, 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { stage: 'Windows physical identity' });
  return physicalDeviceId(platform, output.match(/^\s*MachineGuid\s+REG_SZ\s+([0-9a-f-]+)\s*$/imu)?.[1]);
}

/** Save this machine's identity exclusively, or reject a changed/private record without rewriting it.
 * @param {string} directory Explicit private state directory.
 * @param {string} platform This process's supported platform.
 * @param {string} deviceId Identity derived from the current physical host.
 * @returns {Promise<string>} Absolute device.json path; existing licence data is untouched.
 */
export async function ensureDeviceFile(directory, platform, deviceId) {
  directory = absolute(directory, 'state-dir');
  if (!['darwin', 'win32'].includes(platform) || !/^d1:[0-9a-f]{32}$/u.test(deviceId)) throw new Error('Hongguo v2 invalid physical device record');
  await realDirectory(directory, true);
  if (platform !== 'win32' && ((await lstat(directory)).mode & 0o077) !== 0) throw new Error('Hongguo v2 state directory must be private');
  const path = join(directory, 'device.json');
  const expected = { version: 1, platform, deviceId };
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (handle) {
    try { await handle.writeFile(JSON.stringify(expected) + '\n'); await handle.sync(); } finally { await handle.close(); }
  }
  const info = await regularFile(path);
  if (platform !== 'win32' && (info.mode & 0o777) !== 0o600) throw new Error('Hongguo v2 device record must have mode 0600');
  if (info.size > 4096) throw new Error('Hongguo v2 invalid device record');
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); } catch (error) { throw new Error('Hongguo v2 invalid device record'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 3
    || record.version !== 1 || record.platform !== platform || record.deviceId !== deviceId) throw new Error('Hongguo v2 device record differs from this physical host; it was not replaced');
  return path;
}

/** Extract only hash-locked members after checking every ZIP name/type, including unselected members.
 * @param {string} archive Data ZIP or SFX path; callers separately verify its whole-file identity.
 * @param {string} output Empty owned extraction directory.
 * @param {string} python Explicit Python 3 executable.
 * @param {Array<object>} files Exact member/path/bytes/sha256 inventory.
 * @returns {Promise<void>} Resolves after all selected bytes match their inventory.
 */
export async function extractLockedMembers(archive, output, python, files) {
  if (!Array.isArray(files) || !files.length || new Set(files.map(file => file.member)).size !== files.length
    || new Set(files.map(file => file.path)).size !== files.length
    || files.some(file => !safeRelative(file.member) || !safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(file.sha256))) {
    throw new Error('Hongguo v2 invalid member inventory');
  }
  await realDirectory(output, true);
  run(python, ['-I', '-B', '-c', extraction], { input: JSON.stringify({ archive, output, files }), stage: 'locked archive extraction' });
}

/** Build into a private stage, exclusively create the destination, and publish its descriptor last.
 * @param {string} output New absolute runtime destination.
 * @param {Function} build Populates the owned stage; its returned descriptor is published last.
 * @returns {Promise<string>} Published absolute output path.
 */
export async function withFreshOutput(output, build) {
  output = absolute(output, 'output');
  await realDirectory(dirname(output), true);
  try { await lstat(output); throw new Error('Hongguo v2 output exists; select a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(join(dirname(output), '.hongguo-v2-'));
  const created = [];
  try {
    await build(stage);
    await mkdir(output, { mode: 0o700 });
    created.push({ path: output, directory: true, info: await lstat(output) });
    const files = (await inventory(stage)).sort((a, b) => Number(a.path === 'v2-runtime.json') - Number(b.path === 'v2-runtime.json'));
    for (const file of files) {
      const destination = join(output, file.path);
      const parents = relative(output, dirname(destination)).split(sep).filter(Boolean);
      let parent = output;
      for (const part of parents) {
        parent = join(parent, part);
        try { await mkdir(parent, { mode: 0o700 }); created.push({ path: parent, directory: true, info: await lstat(parent) }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await realDirectory(parent);
      }
      await copyFile(join(stage, file.path), destination, constants.COPYFILE_EXCL);
      created.push({ path: destination, directory: false, info: await lstat(destination) });
      if (await hashFile(destination) !== file.sha256) throw new Error('Hongguo v2 published file checksum mismatch');
    }
    return output;
  } catch (error) {
    for (const entry of created.reverse()) {
      try {
        const current = await lstat(entry.path);
        if (current.dev !== entry.info.dev || current.ino !== entry.info.ino) continue;
        if (entry.directory) await rmdir(entry.path); else await unlink(entry.path);
      } catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cleanupError.code)) throw cleanupError; }
    }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function inventory(root, directory = root) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Hongguo v2 refuses linked output files');
    if (info.isDirectory()) files.push(...await inventory(root, path));
    else if (info.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), bytes: info.size, sha256: await hashFile(path) });
    else throw new Error('Hongguo v2 refuses special output files');
  }
  return files;
}

async function copyBrokerSources(output) {
  const input = join(pluginRoot, 'native', 'license-broker');
  await mkdir(output);
  for (const name of await readdir(input)) {
    if (!/\.(?:cs|csproj)$/u.test(name) && name !== 'NuGet.Config') continue;
    await regularFile(join(input, name));
    await copyFile(join(input, name), join(output, name), constants.COPYFILE_EXCL);
  }
}

/** Prepare the unmodified v2 SDK and our local hosts; all tools and original inputs are supplied explicitly.
 * @param {object} options setupExe/java/dotnet/dotnetSdk/ecj/python/stateDir/output/ffmpeg absolute paths.
 * @returns {Promise<string>} New verified runtime directory, without starting either business host.
 */
export async function prepareV2Runtime(options) {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Hongguo v2 supports only local Mac and Windows preparation');
  const values = Object.fromEntries(['setupExe', 'java', 'dotnet', 'dotnetSdk', 'ecj', 'python', 'stateDir', 'output', 'ffmpeg']
    .map(name => [name, absolute(options[name], name)]));
  for (const name of ['setupExe', 'java', 'dotnet', 'dotnetSdk', 'ecj', 'python', 'ffmpeg']) await regularFile(values[name]);
  if (await hashFile(values.setupExe) !== SETUP_SHA256) throw new Error('Hongguo v2 original installer checksum mismatch');
  const javaInfo = run(values.java, ['-XshowSettings:properties', '-version'], { stage: 'Java 17 version' });
  if (!/version\s+"17\./u.test(javaInfo)) throw new Error('Hongguo v2 requires Java 17');
  const javaArch = /os\.arch\s*=\s*(?:aarch64|arm64)\b/u.test(javaInfo) ? 'arm64' : /os\.arch\s*=\s*(?:amd64|x86_64|x64)\b/u.test(javaInfo) ? 'x64' : '';
  const dotnetInfo = run(values.dotnet, ['--info'], { stage: '.NET 10 x64 runtime' });
  if (!/Version:\s*10\./u.test(dotnetInfo)) throw new Error('Hongguo v2 requires the supplied .NET 10 x64 runtime');
  const target = nativeRuntimeTarget(process.platform, javaArch, dotnetInfo.match(/Architecture:\s*(\S+)/u)?.[1]);
  const jna = target.jna;
  if (!/^10\./mu.test(run(values.dotnetSdk, ['--version'], { stage: '.NET 10 SDK version' }))) throw new Error('Hongguo v2 requires .NET SDK 10');
  const deviceId = readPhysicalDevice(process.platform);
  await ensureDeviceFile(values.stateDir, process.platform, deviceId);
  return withFreshOutput(values.output, async stage => {
    await extractLockedMembers(values.setupExe, stage, values.python, SOURCE_FILES);
    await extractLockedMembers(join(stage, 'engine/lib/jna-jpms-5.14.0.jar'), join(stage, 'engine/native'), values.python, [jna]);
    const build = join(stage, '.build');
    await mkdir(build);
    const classes = join(build, 'classes'), host = join(stage, 'host');
    await mkdir(classes); await mkdir(host);
    const classpath = SOURCE_FILES.filter(file => file.path.startsWith('engine/lib/')).map(file => join(stage, file.path)).join(delimiter);
    run(values.java, ['-jar', values.ecj, '-17', '-cp', classpath, '-d', classes, join(pluginRoot, 'native/host/PortableHost.java')], { stage: 'Java host compilation' });
    run(values.python, ['-I', '-B', '-c', packageJar], { input: JSON.stringify({ classes, output: join(host, 'muse-hongguo-v2-host.jar') }), stage: 'host JAR creation' });
    const project = join(build, 'broker-project');
    await copyBrokerSources(project);
    const nuget = join(project, 'NuGet.Config');
    await writeFile(nuget, '<configuration><packageSources><clear /></packageSources></configuration>\n');
    const temporary = join(build, 'tmp');
    await mkdir(temporary);
    const environment = minimalEnvironment({ DOTNET_CLI_HOME: join(build, 'dotnet-home'), NUGET_PACKAGES: join(build, 'nuget'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_MULTILEVEL_LOOKUP: '0', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', MSBuildEnableWorkloadResolver: 'false', MSBUILDDISABLENODEREUSE: '1' });
    const csproj = join(project, 'MuseHongguoLicenseBroker.csproj');
    const artifact = '-p:HongguoArtifactDir=' + join(stage, 'broker');
    run(values.dotnetSdk, ['restore', csproj, '--configfile', nuget, '--ignore-failed-sources', '-p:NuGetAudit=false', artifact], { env: environment, cwd: project, stage: 'offline broker restore' });
    const compiled = join(build, 'broker-output');
    run(values.dotnetSdk, ['build', csproj, '--no-restore', '-c', 'Release', '-o', compiled, '-p:UseAppHost=false', '-p:UseSharedCompilation=false', '-nr:false', artifact], { env: environment, cwd: project, stage: 'offline broker build' });
    for (const name of ['MuseHongguoLicenseBroker.dll', 'MuseHongguoLicenseBroker.deps.json', 'MuseHongguoLicenseBroker.runtimeconfig.json']) {
      await regularFile(join(compiled, name));
      await copyFile(join(compiled, name), join(stage, 'broker', name), constants.COPYFILE_EXCL);
    }
    for (const file of SOURCE_FILES) if (await hashFile(join(stage, file.path)) !== file.sha256) throw new Error('Hongguo v2 original SDK changed during compilation');
    await rm(build, { recursive: true });
    const executables = [];
    for (const [name, path] of [['java', values.java], ['dotnet', values.dotnet], ['ffmpeg', values.ffmpeg]]) {
      const info = await regularFile(path);
      executables.push({ name, path, bytes: info.size, sha256: await hashFile(path) });
    }
    const descriptor = { version: 1, engineVersion: 'hongguo-helper-0.3.14', build: 15,
      javaExecutable: values.java, dotnetExecutable: values.dotnet, hostJar: 'host/muse-hongguo-v2-host.jar',
      brokerDll: 'broker/MuseHongguoLicenseBroker.dll', engineLibDir: 'engine/lib', signerDir: 'engine/signer', jnaDir: 'engine/native',
      requiresRosetta: target.requiresRosetta, executables, files: await inventory(stage) };
    await writeFile(join(stage, 'v2-runtime.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['setup-exe', 'java', 'dotnet', 'dotnet-sdk', 'ecj', 'python', 'state-dir', 'output', 'ffmpeg'].map(name => [name, { type: 'string' }])) });
    const options = Object.fromEntries(Object.entries(values).map(([name, value]) => [name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase()), value]));
    const output = await prepareV2Runtime(options);
    process.stdout.write(JSON.stringify({ ok: true, output, deviceValuesDisclosed: false }) + '\n');
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Hongguo v2 preparation failed') + '\n'); process.exitCode = 1; }
}
