/** Session-authorized video presentation extension for declared file cards. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Replace a delivered video's player while retaining native file actions. */
    'deliverables.video': {
      kind: 'chain'
      scope: 'session'
      owner: {
        readonly sourceUrl: string
        readonly label: string
        readonly path: string
        readonly seq: number
        readonly index: number
      }
    }
  }
}
export {}
