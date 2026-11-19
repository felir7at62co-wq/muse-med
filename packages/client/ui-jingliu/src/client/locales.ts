import { editorAgentCopy } from './locales/editor-agent.ts'
import { cutImportCopy } from './locales/cut-import.ts'

/** Localized guide labels and document titles for each workbench. */
export const en = { ...cutImportCopy.en, ...editorAgentCopy.en, editorTitle: 'Video editor', editorDescription: 'Multitrack editing and mixing', title: 'Jingliu', workbench: 'Production studio', workshopTitle: 'Script workshop', workshopDescription: 'Screenwriting and editing' }
/** Chinese studio labels. */
export const zh = { ...cutImportCopy.zh, ...editorAgentCopy.zh, editorTitle: '剪辑', editorDescription: '多轨剪辑与混音', title: '镜流', workbench: '短剧制作工作台', workshopTitle: '剧本工坊', workshopDescription: '剧本创作与编辑' }
/** Japanese studio labels. */
export const ja = { ...cutImportCopy.ja, ...editorAgentCopy.ja, editorTitle: '動画編集', editorDescription: 'マルチトラック編集とミキシング', title: 'Jingliu', workbench: '制作スタジオ', workshopTitle: '脚本工房', workshopDescription: '脚本の執筆と編集' }
/** Spanish studio labels. */
export const es = { ...cutImportCopy.es, ...editorAgentCopy.es, editorTitle: 'Editor de vídeo', editorDescription: 'Edición multipista y mezcla', title: 'Jingliu', workbench: 'Estudio de producción', workshopTitle: 'Taller de guion', workshopDescription: 'Escritura y edición de guiones' }
/** French studio labels. */
export const fr = { ...cutImportCopy.fr, ...editorAgentCopy.fr, editorTitle: 'Montage vidéo', editorDescription: 'Montage multipiste et mixage', title: 'Jingliu', workbench: 'Studio de production', workshopTitle: 'Atelier de scénario', workshopDescription: 'Écriture et révision de scénarios' }
/** German studio labels. */
export const de = { ...cutImportCopy.de, ...editorAgentCopy.de, editorTitle: 'Videoschnitt', editorDescription: 'Mehrspurschnitt und Tonmischung', title: 'Jingliu', workbench: 'Produktionsstudio', workshopTitle: 'Drehbuchwerkstatt', workshopDescription: 'Drehbücher schreiben und bearbeiten' }
/** Russian studio labels. */
export const ru = { ...cutImportCopy.ru, ...editorAgentCopy.ru, editorTitle: 'Видеомонтаж', editorDescription: 'Многодорожечный монтаж и микширование', title: 'Jingliu', workbench: 'Студия производства', workshopTitle: 'Сценарная мастерская', workshopDescription: 'Написание и редактирование сценариев' }
/** Portuguese studio labels. */
export const pt = { ...cutImportCopy.pt, ...editorAgentCopy.pt, editorTitle: 'Editor de vídeo', editorDescription: 'Edição multipista e mixagem', title: 'Jingliu', workbench: 'Estúdio de produção', workshopTitle: 'Oficina de roteiros', workshopDescription: 'Criação e edição de roteiros' }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jingliu studio entry and frame title. */
    jingliuStudio: keyof typeof en
  }
}
