/**
 * The Host inspect directory's ownership rule across standing mounts.
 *
 * The registry is one process-global directory, and the `cordis` preset's
 * toolset is its only producer. A second standing mount of that preset — a
 * roster change while the previous mount is still live, a resume after a
 * composition edit — registers the same provider ids again: refusing that used
 * to fail the whole preset mount, which surfaced to the Operator as
 * `resume failed` on every later session of that preset. What the directory
 * owes instead is one entry per id whose latest registration wins.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'

/** A requesting Agent stand-in: the fixture providers key nothing off it. */
const AGENT = { id: 'S-fixture' } as unknown as Agent

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const
const ANY_OUTPUT = { description: 'Fixture data owned by this inspect provider.' } as const
const SIGNAL = new AbortController().signal

/**
 * One provider whose single method reports the label of its own registration,
 * so a displaced registration is observable rather than inferred.
 * @param id - provider id, shared by the registrations a case compares.
 * @param label - value the method answers with.
 * @returns a valid registration for the shared fixture method.
 */
function provider(id: string, label: string): HostCordisInspectProviderRegistration {
  return {
    manifest: {
      id,
      description: `Fixture provider ${id}.`,
      methods: [{
        name: 'report',
        description: 'Report which registration answered.',
        inputSchema: EMPTY_INPUT,
        outputSchema: ANY_OUTPUT,
      }],
    },
    query: () => Promise.resolve({ label }),
  }
}

/**
 * One live directory on a bare root context, built the way the runner builds
 * its own: the service registers itself on construction.
 * @returns the registry a case registers against.
 */
function registry(): CordisInspectRegistryService {
  return new CordisInspectRegistryService(new Context())
}

const reported = (target: CordisInspectRegistryService): Promise<unknown> =>
  target.query('host', 'Service', 'report', undefined, AGENT, SIGNAL)

describe('Host Cordis inspect provider directory', () => {
  it('lets a later registration take over an id an earlier mount still holds', async () => {
    const directory = registry()
    const first = directory.register(provider('Service', 'first'))
    expect(() => directory.register(provider('Service', 'second'))).not.toThrow()

    // One entry per id: the directory is a directory, not a registry log.
    expect(directory.list().filter(view => view.id === 'Service')).toHaveLength(1)
    await expect(reported(directory)).resolves.toEqual({ label: 'second' })

    // The displaced registration's disposer must not delete its successor, which
    // is what an older mount unloading does after a newer one took the id.
    first()
    await expect(reported(directory)).resolves.toEqual({ label: 'second' })
  })

  it('removes the id when the registration that owns it disposes', async () => {
    const directory = registry()
    directory.register(provider('Service', 'first'))
    const current = directory.register(provider('Service', 'second'))
    current()
    await expect(reported(directory)).rejects.toThrow('is not registered')
  })
})
