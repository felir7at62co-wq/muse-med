import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PANEL_MANIFEST, SkillsViewerGateway } from "./lib/index.js";
import { collectSkillEntries } from "./lib/skill-files.js";

const temporary = await mkdtemp(join(tmpdir(), "dsh-skill-undo-"));
const home = join(temporary, "home");
const project = join(temporary, "project");
const globalRoot = join(home, "skills");
const projectRoot = join(project, ".dsh", "skills");
const savedEnv = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
const contexts = [];
let passed = 0;
let physicalGlobalRoot;
const waitFor = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned filesystem barrier was not reached")), 10000); })]); }
  finally { clearTimeout(timer); }
};
const md = (name) => "---\nname: " + name + "\ndescription: undo fixture\n---\n\nKeep these exact bytes.\r\n";
const entries = () => collectSkillEntries([
  { path: globalRoot, source: "user-dsh" },
  { path: projectRoot, source: "project-dsh", projectRoot: project }
]);
const gateway = async () => {
  const ctx = new Context();
  ctx.provide("sessions", { list: () => [{ id: "undo-test", header: { cwd: project } }], get: () => undefined });
  ctx.provide("skills", {
    list: async () => [],
    get: async () => undefined
  });
  let value;
  const fork = ctx.plugin((child) => { value = new SkillsViewerGateway(child); });
  contexts.push(fork);
  await fork.await();
  return value;
};
const exists = async (path) => access(path).then(() => true, () => false);
const makeBundle = async (path, name, disabled = false) => {
  await mkdir(join(path, "scripts"), { recursive: true });
  await mkdir(join(path, ".private"), { recursive: true });
  await writeFile(join(path, disabled ? "SKILL.md.disabled" : "SKILL.md"), md(name));
  await writeFile(join(path, "scripts", "run.sh"), "#!/bin/sh\nprintf 'fixture'\n");
  await chmod(join(path, "scripts", "run.sh"), 0o755);
  await writeFile(join(path, ".private", "image.bin"), Buffer.from([0, 255, 10, 128]));
};
const checkBundle = async (path, name, disabled = false) => {
  assert.equal(await readFile(join(path, disabled ? "SKILL.md.disabled" : "SKILL.md"), "utf8"), md(name));
  assert.equal(await readFile(join(path, "scripts", "run.sh"), "utf8"), "#!/bin/sh\nprintf 'fixture'\n");
  assert.deepEqual(await readFile(join(path, ".private", "image.bin")), Buffer.from([0, 255, 10, 128]));
  if (process.platform !== "win32") assert.equal((await stat(join(path, "scripts", "run.sh"))).mode & 0o777, 0o755);
};
const makeWritable = async (path) => {
  const entry = await lstat(path);
  if (!entry.isDirectory()) return;
  await chmod(path, 0o755);
  for (const child of await readdir(path)) await makeWritable(join(path, child));
};
const test = async (label, fn) => {
  await fn();
  passed += 1;
  console.log("PASS  " + label);
};

process.env.DSH_HOME = home;
process.env.DSH_AGENTS_HOME = join(temporary, "agents");
try {
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(globalRoot, { recursive: true });
  physicalGlobalRoot = await realpath(globalRoot);
  const host = await gateway();
  assert.equal(host.homes().dshHome, home, "the real home must never be used");

  await test("real scanner bundle deletion and Undo restore every resource", async () => {
    const path = join(globalRoot, "alpha");
    await makeBundle(path, "alpha");
    assert.equal((await entries()).find((row) => row.name === "alpha").rel, "alpha");
    assert.ok((await host.list()).skills.some((row) => row.name === "alpha"));
    const receipt = await host.trashSkill("alpha", undefined, "global");
    assert.equal(await exists(path), false);
    assert.equal((await entries()).some((row) => row.name === "alpha"), false);
    assert.equal((await host.list()).skills.some((row) => row.name === "alpha"), false);
    assert.deepEqual(await host.restoreSkill(receipt.undoToken), { name: "alpha", recoveryRetained: false });
    await checkBundle(path, "alpha");
    assert.equal((await entries()).find((row) => row.name === "alpha").enabled, true);
    assert.equal((await readdir(globalRoot)).some((name) => name.startsWith(".dsh-skill-deleted-")), false);
  });

  await test("nested disabled workspace bundle restores exact path and state without touching global twin", async () => {
    const path = join(projectRoot, "category", "renamed-folder");
    await makeBundle(path, "beta", true);
    await makeBundle(join(globalRoot, "beta"), "beta");
    const before = (await entries()).find((row) => row.name === "beta" && row.projectRoot === project);
    assert.equal(before.rel, "category/renamed-folder");
    const receipt = await host.trashSkill("beta", undefined, project);
    assert.equal(await exists(path), false);
    await checkBundle(join(globalRoot, "beta"), "beta");
    await host.restoreSkill(receipt.undoToken);
    await checkBundle(path, "beta", true);
    assert.equal(await exists(join(path, "SKILL.md")), false);
    const restored = (await entries()).find((row) => row.name === "beta" && row.projectRoot === project);
    assert.equal(restored.rel, before.rel);
    assert.equal(restored.enabled, false);
  });

  await test("disabled flat file keeps original filename and exact bytes", async () => {
    const path = join(globalRoot, "different-name.md.disabled");
    await writeFile(path, md("flat"));
    const receipt = await host.trashSkill("flat", undefined, "global");
    assert.equal(await exists(path), false);
    await host.restoreSkill(receipt.undoToken);
    assert.equal(await readFile(path, "utf8"), md("flat"));
    assert.equal((await entries()).find((row) => row.name === "flat").enabled, false);
  });

  await test("target conflict retains both new data and the receipt for a later retry", async () => {
    const path = join(globalRoot, "conflict.md");
    await writeFile(path, md("conflict"));
    const receipt = await host.trashSkill("conflict", undefined, "global");
    await writeFile(path, "new user data");
    await assert.rejects(() => host.restoreSkill(receipt.undoToken), { code: "skill/restore-conflict" });
    assert.equal(await readFile(path, "utf8"), "new user data");
    await rm(path);
    await host.restoreSkill(receipt.undoToken);
    assert.equal(await readFile(path, "utf8"), md("conflict"));
    await assert.rejects(() => host.restoreSkill(receipt.undoToken), { code: "skill/restore-unavailable" });
  });

  await test("directory conflicts never merge or overwrite another bundle", async () => {
    const path = join(globalRoot, "directory-conflict");
    await makeBundle(path, "directory-conflict");
    const receipt = await host.trashSkill("directory-conflict", undefined, "global");
    await mkdir(path);
    await writeFile(join(path, "new.txt"), "new user data");
    await assert.rejects(() => host.restoreSkill(receipt.undoToken), { code: "skill/restore-conflict" });
    assert.equal(await readFile(join(path, "new.txt"), "utf8"), "new user data");
    await rm(path, { recursive: true });
    await host.restoreSkill(receipt.undoToken);
    await checkBundle(path, "directory-conflict");
  });

  await test("concurrent Undo admits one restoration and cannot consume another receipt", async () => {
    const path = join(globalRoot, "concurrent.md");
    await writeFile(path, md("concurrent"));
    const receipt = await host.trashSkill("concurrent", undefined, "global");
    const results = await Promise.allSettled([host.restoreSkill(receipt.undoToken), host.restoreSkill(receipt.undoToken)]);
    assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(results.filter((row) => row.status === "rejected").length, 1);
    assert.equal(await readFile(path, "utf8"), md("concurrent"));
  });

  await test("a concurrent delete cannot remove a newly recreated skill while the first receipt is pending", async () => {
    const path = join(globalRoot, "delete-race.md");
    await writeFile(path, md("delete-race"));
    const rename = fs.promises.rename;
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    fs.promises.rename = async (from, to) => {
      await rename(from, to);
      if (from === join(physicalGlobalRoot, "delete-race.md")) { entered(); await resume; }
    };
    syncBuiltinESMExports();
    let first;
    try {
      first = host.trashSkill("delete-race", undefined, "global");
      first.catch(() => {});
      await waitFor(paused);
      await writeFile(path, "newly recreated skill");
      await assert.rejects(() => host.trashSkill("delete-race", undefined, "global"), { code: "skill/delete-busy" });
      assert.equal(await readFile(path, "utf8"), "newly recreated skill");
    } finally {
      release();
      if (first !== undefined) await Promise.allSettled([first]);
      fs.promises.rename = rename;
      syncBuiltinESMExports();
    }
    const receipt = await first;
    await rm(path);
    await host.restoreSkill(receipt.undoToken);
    assert.equal(await readFile(path, "utf8"), md("delete-race"));
  });

  await test("exclusive flat publication refuses a file created after restoration starts", async () => {
    const path = join(globalRoot, "publish-race.md");
    await writeFile(path, md("publish-race"));
    const receipt = await host.trashSkill("publish-race", undefined, "global");
    const copyFile = fs.promises.copyFile;
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    fs.promises.copyFile = async (from, to, mode) => {
      if (to === join(physicalGlobalRoot, "publish-race.md")) { entered(); await resume; }
      return copyFile(from, to, mode);
    };
    syncBuiltinESMExports();
    let restore;
    try {
      restore = host.restoreSkill(receipt.undoToken);
      restore.catch(() => {});
      await waitFor(paused);
      await writeFile(path, "concurrent user bytes");
      release();
      await assert.rejects(() => restore, { code: "skill/restore-conflict" });
      assert.equal(await readFile(path, "utf8"), "concurrent user bytes");
    } finally {
      release();
      if (restore !== undefined) await Promise.allSettled([restore]);
      fs.promises.copyFile = copyFile;
      syncBuiltinESMExports();
    }
    await rm(path);
    await host.restoreSkill(receipt.undoToken);
    assert.equal(await readFile(path, "utf8"), md("publish-race"));
  });

  await test("partial bundle copies do not expose embedded skills, and retain complete originals on failure", async () => {
    const path = join(globalRoot, "partial");
    await makeBundle(path, "partial");
    await mkdir(join(path, "modules", "embedded"), { recursive: true });
    await writeFile(join(path, "modules", "embedded", "SKILL.md"), md("embedded"));
    const receipt = await host.trashSkill("partial", undefined, "global");
    const copyFile = fs.promises.copyFile;
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    fs.promises.copyFile = async (from, to, mode) => {
      if (to === join(physicalGlobalRoot, "partial", "scripts", "run.sh")) {
        entered();
        await resume;
        throw Object.assign(new Error("fixture owned copy failure"), { code: "EIO" });
      }
      return copyFile(from, to, mode);
    };
    syncBuiltinESMExports();
    let restore;
    try {
      restore = host.restoreSkill(receipt.undoToken);
      restore.catch(() => {});
      await waitFor(paused);
      assert.equal(await exists(join(path, "modules", "embedded", "SKILL.md")), true);
      assert.equal((await entries()).some((row) => row.name === "embedded"), false);
      assert.equal((await entries()).find((row) => row.name === "partial").enabled, false);
      release();
      await assert.rejects(() => restore, { code: "skill/restore-incomplete" });
      assert.equal(await exists(join(path, "SKILL.md")), false);
      await assert.rejects(() => host.restoreSkill(receipt.undoToken), { code: "skill/restore-conflict" });
      const backup = (await readdir(globalRoot)).filter((name) => name.startsWith(".dsh-skill-deleted-"));
      let original;
      for (const directory of backup) {
        const metadata = JSON.parse(await readFile(join(globalRoot, directory, "original.json"), "utf8"));
        if (metadata.name === "partial") original = join(globalRoot, directory, "entry");
      }
      assert.ok(original);
      await checkBundle(original, "partial");
    } finally {
      release();
      if (restore !== undefined) await Promise.allSettled([restore]);
      fs.promises.copyFile = copyFile;
      syncBuiltinESMExports();
    }
    await rm(path, { recursive: true });
    await host.restoreSkill(receipt.undoToken);
    await checkBundle(path, "partial");
    assert.equal(await exists(join(path, "SKILL.md.disabled")), false);
  });

  await test("receipts cannot cross Host instances or accept caller-controlled paths", async () => {
    const path = join(globalRoot, "owner.md");
    await writeFile(path, md("owner"));
    const receipt = await host.trashSkill("owner", undefined, "global");
    const other = await gateway();
    await assert.rejects(() => other.restoreSkill(receipt.undoToken), { code: "skill/restore-unavailable" });
    await assert.rejects(() => host.restoreSkill("../../protected"), { code: "skill/restore-unavailable" });
    await host.restoreSkill(receipt.undoToken);
    assert.equal(await readFile(path, "utf8"), md("owner"));
  });

  await test("missing scoped delete leaves the other scope untouched", async () => {
    await assert.rejects(() => host.trashSkill("alpha", undefined, project));
    await checkBundle(join(globalRoot, "alpha"), "alpha");
  });

  await test("strict wire codecs reject a path in place of an opaque receipt", async () => {
    const invocation = PANEL_MANIFEST.invocations.find((row) => row.method === "restoreSkill");
    assert.ok(invocation);
    assert.throws(() => invocation.parameters[0].codec.create().parse("../../protected"));
    const trash = PANEL_MANIFEST.invocations.find((row) => row.method === "trashSkill");
    assert.ok(trash);
    assert.throws(() => trash.result.create().parse({ name: "alpha" }));
    const path = join(globalRoot, "codec.md");
    await writeFile(path, md("codec"));
    const receipt = await host.trashSkill("codec", undefined, "global");
    assert.doesNotThrow(() => trash.result.create().parse(receipt));
    const restored = await host.restoreSkill(receipt.undoToken);
    assert.doesNotThrow(() => invocation.result.create().parse(restored));
  });

  if (process.platform !== "win32") {
    await test("manifest and resource symlinks retain their original link text", async () => {
      const path = join(globalRoot, "linked");
      await makeBundle(path, "linked");
      await writeFile(join(path, "manifest.md"), md("linked"));
      await rm(join(path, "SKILL.md"));
      await symlink("manifest.md", join(path, "SKILL.md"));
      await symlink("scripts/run.sh", join(path, "run-link"));
      const receipt = await host.trashSkill("linked", undefined, "global");
      await host.restoreSkill(receipt.undoToken);
      assert.equal((await lstat(join(path, "SKILL.md"))).isSymbolicLink(), true);
      assert.equal(await fs.promises.readlink(join(path, "SKILL.md")), "manifest.md");
      assert.equal(await fs.promises.readlink(join(path, "run-link")), "scripts/run.sh");
      await checkBundle(path, "linked");
    });

    await test("an external relative directory link keeps its link type after backup relocation", async () => {
      const path = join(globalRoot, "external-links");
      await makeBundle(path, "external-links");
      await mkdir(join(globalRoot, "shared-assets"));
      await writeFile(join(globalRoot, "shared-assets", "payload.txt"), "external directory payload");
      await symlink("../shared-assets", join(path, "external"), "dir");
      const receipt = await host.trashSkill("external-links", undefined, "global");
      let retainedLink;
      for (const directory of await readdir(globalRoot)) {
        if (!directory.startsWith(".dsh-skill-deleted-")) continue;
        const metadata = JSON.parse(await readFile(join(globalRoot, directory, "original.json"), "utf8"));
        if (metadata.name === "external-links") retainedLink = join(globalRoot, directory, "entry", "external");
      }
      assert.ok(retainedLink);
      assert.equal((await lstat(retainedLink)).isSymbolicLink(), true);
      await assert.rejects(() => stat(retainedLink), { code: "ENOENT" });
      const createLink = fs.promises.symlink;
      let publishedType;
      fs.promises.symlink = async (value, destination, type) => {
        if (destination === join(physicalGlobalRoot, "external-links", "external")) publishedType = type;
        return createLink(value, destination, type);
      };
      syncBuiltinESMExports();
      try {
        await host.restoreSkill(receipt.undoToken);
      } finally {
        fs.promises.symlink = createLink;
        syncBuiltinESMExports();
      }
      assert.equal(publishedType, "dir", "Windows requires the directory type at the symlink creation call");
      assert.equal(await fs.promises.readlink(join(path, "external")), "../shared-assets");
      assert.equal((await stat(join(path, "external"))).isDirectory(), true);
      assert.equal(await readFile(join(path, "external", "payload.txt"), "utf8"), "external directory payload");
    });

    await test("a read-only recovery bundle regains its mode after complete publication", async () => {
      const path = join(globalRoot, "read-only");
      await makeBundle(path, "read-only");
      const receipt = await host.trashSkill("read-only", undefined, "global");
      for (const directory of await readdir(globalRoot)) {
        if (!directory.startsWith(".dsh-skill-deleted-")) continue;
        const metadata = JSON.parse(await readFile(join(globalRoot, directory, "original.json"), "utf8"));
        if (metadata.name === "read-only") await chmod(join(globalRoot, directory, "entry"), 0o555);
      }
      const result = await host.restoreSkill(receipt.undoToken);
      assert.equal(result.name, "read-only");
      assert.equal((await stat(path)).mode & 0o777, 0o555);
      await checkBundle(path, "read-only");
      assert.equal(await exists(join(path, "SKILL.md.disabled")), false);
      await chmod(path, 0o755);
      for (const directory of await readdir(globalRoot)) {
        if (!directory.startsWith(".dsh-skill-deleted-")) continue;
        const entry = join(globalRoot, directory, "entry");
        if (await exists(entry)) await chmod(entry, 0o755);
      }
    });

    await test("dangling symlink conflicts are not overwritten", async () => {
      const path = join(globalRoot, "symlink-conflict.md");
      await writeFile(path, md("symlink-conflict"));
      const receipt = await host.trashSkill("symlink-conflict", undefined, "global");
      await symlink("missing-target", path);
      await assert.rejects(() => host.restoreSkill(receipt.undoToken), { code: "skill/restore-conflict" });
      assert.equal((await lstat(path)).isSymbolicLink(), true);
      await rm(path);
      await host.restoreSkill(receipt.undoToken);
      assert.equal(await readFile(path, "utf8"), md("symlink-conflict"));
    });
  }
} finally {
  for (const ctx of contexts.reverse()) await ctx.dispose();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await makeWritable(temporary);
  await rm(temporary, { recursive: true, force: true });
}
console.log("\n" + passed + " passed, 0 failed");
