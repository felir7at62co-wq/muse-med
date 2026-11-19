/** Muse-only HTTP route tracking the editor visible in a conversation. */
export const editorAgentViewRoute = '/api/openchatcut/view'
/** Identifiers accepted by the OpenChatCut project store. */
export const editorProjectId = /^[A-Za-z0-9_-]{1,160}$/u

/** Public identity of the upstream browser currently editing an OpenChatCut project. */
export interface EditorOwner { id: string; epoch: number }
