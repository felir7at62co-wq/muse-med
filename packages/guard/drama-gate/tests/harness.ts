import { join, resolve } from 'node:path'
import type { GateCall, GateReader, RuleSwitches } from '@deepseek-ai/dsh-guard-drama'

/**
 * Shared fixtures for the drama-gate suite: an in-memory reader, a literal
 * workspace layout, and a call builder. Everything the rules touch is injected,
 * so a case states exactly the files it wants the gate to see.
 */

/** A workspace root that is absolute on every host the suite runs on. */
export const WORKSPACE = resolve('/ws')
/** The default workshop directory below the workspace root. */
export const WORKSHOP = join(WORKSPACE, 'short-drama')
/** One project directory inside the workshop, as the pipeline lays it out. */
export const PROJECT = join(WORKSHOP, 'demo-drama')
/** The stored director-format shot script for episode 01. */
export const PROMPTS = join(PROJECT, 'prompts', '01.txt')
/** The matched JSON for episode 01. */
export const MATCHED = join(PROJECT, 'matches', '01.matched.json')
/** The reconcile evidence the paid-asset rule reads below a project root. */
export const RECONCILE = join(PROJECT, '_probe', 'asset-reconcile.json')
/** The Jubian project id `project_config.json` declares for {@link PROJECT}. */
export const SCRIPT_ID = 2708
/** The config that binds a project directory to its Jubian project. */
export const PROJECT_CONFIG = join(PROJECT, 'project_config.json')

/** That config's content, for a reader that must resolve a call naming {@link SCRIPT_ID}. */
export const PROJECT_CONFIG_TEXT = JSON.stringify({ jubian_script_id: SCRIPT_ID })

/** Every rule enabled, the shipped default. */
export const ALL_ON: RuleSwitches = {
  idempotencyKey: true,
  shotScript: true,
  officialAssets: true,
  reconcileFirst: true,
  museToolNames: true,
}

/** An injected reader over literal path maps; anything unlisted reads as absent. */
export function fakeReader(
  files: Readonly<Record<string, string>> = {},
  directories: Readonly<Record<string, readonly string[]>> = {},
): GateReader {
  return {
    readText: path => files[path],
    listDirectoryNames: path => directories[path] ?? [],
  }
}

/** One pending call; overrides name the behavior under test. */
export function call(overrides: Partial<GateCall>): GateCall {
  return {
    toolName: 'probe',
    arguments: {},
    reader: fakeReader(),
    switches: ALL_ON,
    sessionCwd: WORKSPACE,
    workshopDir: 'short-drama',
    registered: true,
    ...overrides,
  }
}

/**
 * The reader of a workshop whose only project is {@link PROJECT}, holding `files`
 * below that project plus the config that binds it to {@link SCRIPT_ID}. A call
 * naming that id therefore has exactly one project to be judged against.
 * @param files - Literal project-root-relative paths to their contents.
 * @returns The reader the rules resolve that one project through.
 */
export function projectReader(files: Readonly<Record<string, string>> = {}): GateReader {
  return fakeReader({ [PROJECT_CONFIG]: PROJECT_CONFIG_TEXT, ...files }, { [WORKSHOP]: ['demo-drama'] })
}

/** `count` Han characters, for exercising the effective-character rules. */
export function han(count: number): string {
  return '字'.repeat(count)
}

/** One director-format shot block; the caller supplies the duration and dialogue lines. */
export function block(number: number, duration: string, ...dialogue: string[]): string {
  return [
    `【镜头${number}】`,
    `时长：${duration}`,
    '发声类型：dialogue',
    ...dialogue.map(line => `台词：${line}`),
    '主体状态追踪：在场',
    '',
  ].join('\n')
}

/** A matched/package JSON document with one shot record. */
export function matchedJson(shot: Record<string, unknown>): string {
  return JSON.stringify({
    version: 4,
    episode: '01',
    production_mode: 'live_action',
    timing_source: 'integer_shot_script',
    shots: [{ shot: 1, segment: 1, ...shot }],
    video_tasks: [],
  }, undefined, 2)
}
