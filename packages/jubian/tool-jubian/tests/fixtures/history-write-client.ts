import { JubianClient } from '@deepseek-ai/dsh-jubian'

/** Create a real history-policy owner whose credential and transport are never used. */
export function fixtureHistoryClient(): JubianClient {
  return new JubianClient({
    credential: async () => { throw new Error('Unexpected Jubian credential read') },
    fetch: async () => { throw new Error('Unexpected Jubian transport call') },
  })
}
