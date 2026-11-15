/** Complete file-entity recovery for the panel's short-lived Undo receipts. */
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, realpath, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Opaque Host-issued deletion receipt; callers cannot provide restoration paths. */
export const undoTokenSchema = z.uuid().brand<"SkillUndoToken">();
type UndoToken = z.infer<typeof undoTokenSchema>;
type RecoveryRecord = { name: string; target: string; backup: string; entrypoint: string; restoring: boolean; directoryLink: boolean };
type RecoveryCode = "skill/delete-busy" | "skill/restore-unavailable" | "skill/restore-busy" | "skill/restore-conflict" | "skill/restore-incomplete";

/** A recoverable operation failure whose original payload remains on disk. */
class RecoveryError extends Error {
  constructor(readonly code: RecoveryCode, message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** Copy an entity with exclusive destination creation, including symbolic links. */
async function copyExclusive(source: string, target: string): Promise<void> {
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) {
    const link = await readlink(source);
    const linked = await stat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      // Moving a bundle changes links to siblings outside the bundle until restoration.
      return stat(resolve(dirname(target), link)).catch((reason: NodeJS.ErrnoException) => {
        if (reason.code === "ENOENT") return undefined;
        throw reason;
      });
    });
    await symlink(link, target, linked?.isDirectory() ? "dir" : "file");
  } else if (entry.isDirectory()) {
    await mkdir(target);
    for (const child of await readdir(source)) await copyExclusive(join(source, child), join(target, child));
    await chmod(target, entry.mode);
  } else {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

/**
 * Instance-owned receipts for same-filesystem deletion backups.
 * Backups are durable user data and intentionally outlive this instance.
 */
export class SkillDeletionRecovery {
  private readonly records = new Map<UndoToken, RecoveryRecord>();
  private readonly deleting = new Set<string>();

  /**
   * Move a selected entity to a hidden sibling backup without reading its payload.
   * @param name - Display name of the selected skill.
   * @param file - Exact managed skill manifest or flat file.
   * @param dirBundle - Whether the complete containing directory belongs to the skill.
   * @returns A Host-only receipt for restoring this exact entity.
   */
  async trash(name: string, file: string, dirBundle: boolean) {
    const source = dirBundle ? dirname(file) : file;
    const parent = await realpath(dirname(source));
    const target = join(parent, basename(source));
    if (this.deleting.has(target)) throw new RecoveryError("skill/delete-busy", "该技能正在删除，请等待操作完成");
    this.deleting.add(target);
    let backup: string | undefined;
    try {
      const entity = await lstat(target);
      const directoryLink = entity.isSymbolicLink() && dirBundle;
      backup = await mkdtemp(join(parent, ".dsh-skill-deleted-"));
      await writeFile(join(backup, "original.json"), JSON.stringify({ name, originalName: basename(target) }) + "\n", { flag: "wx" });
      await rename(target, join(backup, "entry"));
      const undoToken = undoTokenSchema.parse(randomUUID());
      this.records.set(undoToken, { name, target, backup, entrypoint: basename(file), restoring: false, directoryLink });
      return { name, undoToken };
    } catch (error) {
      if (backup !== undefined) {
        // A failed rename leaves the source in place; never remove a moved payload.
        const moved = await lstat(join(backup, "entry")).then(() => true, (reason: NodeJS.ErrnoException) => {
          if (reason.code === "ENOENT") return false;
          throw reason;
        });
        if (!moved) await rm(backup, { recursive: true, force: true });
      }
      throw error;
    } finally {
      this.deleting.delete(target);
    }
  }

  /**
   * Restore an issued receipt without replacing any existing destination.
   * @param undoToken - Receipt returned by this instance's successful trash operation.
   * @returns Restored name and whether recovery-file cleanup remains pending.
   * @throws A structured failure; the complete backup and receipt remain available.
   */
  async restore(undoToken: UndoToken) {
    const record = this.records.get(undoToken);
    if (record === undefined) throw new RecoveryError("skill/restore-unavailable", "撤销记录已不可用，请检查原位置及技能目录旁的恢复文件夹");
    if (record.restoring) throw new RecoveryError("skill/restore-busy", "该技能正在还原，请等待操作完成");
    record.restoring = true;
    const source = join(record.backup, "entry");
    let reserved = false;
    let temporaryDisabled = false;
    try {
      const entity = await lstat(source);
      if (entity.isSymbolicLink()) {
        await symlink(await readlink(source), record.target, record.directoryLink ? "dir" : "file");
      } else if (entity.isDirectory()) {
        await mkdir(record.target);
        reserved = true;
        const children = await readdir(source);
        const disabled = "SKILL.md.disabled";
        temporaryDisabled = !children.includes(disabled);
        if (temporaryDisabled) await writeFile(join(record.target, disabled), "", { flag: "wx" });
        else await copyExclusive(join(source, disabled), join(record.target, disabled));
        // The disabled manifest prevents recursive discovery of partially copied child skills.
        for (const child of children) {
          if (child === disabled || child === record.entrypoint) continue;
          await copyExclusive(join(source, child), join(record.target, child));
        }
        if (record.entrypoint !== disabled) await copyExclusive(join(source, record.entrypoint), join(record.target, record.entrypoint));
        if (temporaryDisabled) await rm(join(record.target, disabled));
        await chmod(record.target, entity.mode);

      } else {
        await copyFile(source, record.target, constants.COPYFILE_EXCL);
      }
    } catch (error) {
      record.restoring = false;
      if (!reserved && error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new RecoveryError("skill/restore-conflict", "原位置已存在文件，未覆盖；请检查该位置后重试，完整原件仍保留在恢复文件夹中", error);
      }
      throw new RecoveryError("skill/restore-incomplete", "还原未完成；请检查原位置的文件，完整原件仍保留在恢复文件夹中", error);
    }
    this.records.delete(undoToken);
    let recoveryRetained = false;
    try {
      await rm(record.backup, { recursive: true });
    } catch (error) {
      // Publication succeeded; cleanup failure must not invite a second restoration.
      recoveryRetained = true;
    }
    return { name: record.name, recoveryRetained };
  }
}
