/** Public JSON types shared by project-budget tools, Remote services and clients. */
/** The effective project authorization and unchanged append-only accounting. */
export interface ProjectBudget {
  script_id: number
  limit_cents: number | null
  unit: string
  source: 'project' | 'default' | 'unconfigured'
  settled_cents: number
  reserved_cents: number
  remaining_cents: number | null
  revision: string
  authorization_path: string
  note: string
  accounting_complete: boolean
}
//# sourceMappingURL=types.d.ts.map
