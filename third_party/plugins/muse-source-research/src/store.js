/** Provider-owned filesystem access, bounded complete reads and immutable content-addressed publication. */
import { createHash } from 'node:crypto';

/** @param value Bytes or text. @returns Lowercase SHA-256 digest of the exact input. */
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
/** @param value JSON data. @returns Stable indented JSON with one trailing newline. */
export function encode(value) { return JSON.stringify(value, null, 2) + '\n'; }
/** @param message Failure description. @param code Machine-readable failure. @returns An error with a stable code. */
export function failure(message, code = 'SOURCE_RESEARCH_INVALID') { return Object.assign(new Error(message), { code }); }

/** Project-relative storage; target keys are only compared by the filesystem provider. */
export class ResearchStore {
  /** @param fs Host filesystem service. @param config Resource limits. */
  constructor(fs, config) { this.fs = fs; this.config = config; }

  /** @param cwd Initiating Session directory. @param project Optional contained project. @param policy Per-call sandbox policy. @param signal Cancellation. @returns Resolved project execution context. */
  async context(cwd, project, policy, signal) {
    if (typeof cwd !== 'string' || !cwd) throw failure('Source research requires an initiating Session cwd');
    if (project !== undefined && (typeof project !== 'string' || !project.trim())) throw failure('project must be a non-empty path');
    const root = await this.fs.resolve(cwd, { signal });
    const target = await this.fs.resolve(project ?? '.', { cwd, signal });
    if (!this.fs.contains(root, target)) throw failure('project must remain within the initiating Session cwd', 'SOURCE_RESEARCH_OUTSIDE_PROJECT');
    return { root: target, cwd: this.fs.processPath(target), policy, signal };
  }

  /** @param context Project execution context. @returns Nothing; rejects read-only or disallowed workspace writes. */
  async writable(context) {
    context.signal?.throwIfAborted();
    if (context.policy?.mode === 'read-only') throw failure('Source research writes are denied by the current read-only policy; no collection was started', 'SOURCE_RESEARCH_READ_ONLY');
    if (context.policy?.mode === 'workspace-write') {
      const workspace = await this.fs.resolve(context.policy.workspaceRoot, { signal: context.signal });
      if (!this.fs.contains(workspace, context.root)) throw failure('Project is outside the current writable workspace', 'SOURCE_RESEARCH_OUTSIDE_PROJECT');
    }
  }

  /** @param context Project context. @param path Project-relative or absolute path. @returns Canonically contained target. */
  async target(context, path) {
    const target = await this.fs.resolve(path, { cwd: context.cwd, signal: context.signal });
    if (!this.fs.contains(context.root, target)) throw failure('Source research path escapes the selected project', 'SOURCE_RESEARCH_OUTSIDE_PROJECT');
    return target;
  }

  /** @param context Project context. @param target Contained target. @param maxBytes Inclusive full-file byte cap. @returns Exact bytes, text, hash and read version; rejects concurrent mutation. */
  async read(context, target, maxBytes = this.config.maxJsonBytes) {
    const before = await this.fs.stat(target, context.signal);
    if (!before || before.type !== 'file') throw failure('Research input is not an existing regular file', 'SOURCE_RESEARCH_NOT_FOUND');
    if (before.size !== undefined && before.size > maxBytes) throw failure(`Research input exceeds maxJsonBytes (${maxBytes})`, 'SOURCE_RESEARCH_LIMIT');
    const bytes = await this.fs.readBytes(target, context.signal, maxBytes);
    const after = await this.fs.stat(target, context.signal);
    if (!after || before.version !== after.version) throw failure('Research input changed during the read; retry with a stable file', 'SOURCE_RESEARCH_STALE_READ');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw failure(`Research input is not UTF-8 text: ${error.message}`); }
    return { text, sha256: sha256(bytes), version: after.version, path: target.displayPath };
  }

  /** @param context Project context. @param directory Relative directory. @returns Complete bounded directory entries, or an empty list for absence. */
  async entries(context, directory) {
    const target = await this.target(context, directory);
    const info = await this.fs.stat(target, context.signal);
    if (!info) return [];
    if (info.type !== 'directory') throw failure('Research storage path must be a directory');
    const entries = await this.fs.listDir(target, context.signal);
    if (entries.length > this.config.maxListEntries) throw failure('Research directory exceeds maxListEntries; no entries were silently omitted', 'SOURCE_RESEARCH_LIMIT');
    for (const entry of entries) if (!this.fs.contains(context.root, entry.target)) throw failure('Research directory contains a link outside the project', 'SOURCE_RESEARCH_OUTSIDE_PROJECT');
    return entries;
  }

  /** @param context Project context. @param kind Artifact category. @returns Nothing; rejects exhausted snapshot capacity before network activity. */
  async capacity(context, kind = 'snapshots') {
    const entries = await this.entries(context, `.muse/source-research/${kind}/v1`);
    if (entries.filter(entry => entry.name.endsWith('.json')).length >= this.config.maxSnapshots) throw failure(`Research ${kind} exceed maxSnapshots; archive to another project before collecting`, 'SOURCE_RESEARCH_LIMIT');
  }

  /** @param context Project context. @param path Contained output path. @param text Complete UTF-8 document. @param maxBytes Output byte cap. @returns Immutable publication receipt; an identical existing file is reused. */
  async publish(context, path, text, maxBytes = this.config.maxJsonBytes) {
    await this.writable(context);
    if (Buffer.byteLength(text) > maxBytes) throw failure('Research output exceeds the configured byte limit', 'SOURCE_RESEARCH_LIMIT');
    const target = await this.target(context, path);
    const hash = sha256(text);
    try {
      const written = await this.fs.writeText(target, text, { kind: 'createIfAbsent' }, context.signal, context.policy);
      return { path: target.displayPath, sha256: hash, version: written.version, reused: false };
    } catch (error) {
      if (error.code !== 'FS_NOT_OBSERVED') throw error;
      const existing = await this.read(context, target, maxBytes);
      if (existing.sha256 !== hash) throw failure('Immutable research artifact already exists with different content', 'SOURCE_RESEARCH_CONFLICT');
      return { path: target.displayPath, sha256: hash, version: existing.version, reused: true };
    }
  }
}
