/** Localized guide labels and document titles for each workbench. */
export const en = { title: 'Jingliu', workbench: 'Production studio', workshopTitle: 'Script workshop', workshopDescription: 'Screenwriting and editing' }
/** Chinese studio labels. */
export const zh = { title: '镜流', workbench: '短剧制作工作台', workshopTitle: '剧本工坊', workshopDescription: '剧本创作与编辑' }
/** Japanese studio labels. */
export const ja = { title: 'Jingliu', workbench: '制作スタジオ', workshopTitle: '脚本工房', workshopDescription: '脚本の執筆と編集' }
/** Spanish studio labels. */
export const es = { title: 'Jingliu', workbench: 'Estudio de producción', workshopTitle: 'Taller de guion', workshopDescription: 'Escritura y edición de guiones' }
/** French studio labels. */
export const fr = { title: 'Jingliu', workbench: 'Studio de production', workshopTitle: 'Atelier de scénario', workshopDescription: 'Écriture et révision de scénarios' }
/** German studio labels. */
export const de = { title: 'Jingliu', workbench: 'Produktionsstudio', workshopTitle: 'Drehbuchwerkstatt', workshopDescription: 'Drehbücher schreiben und bearbeiten' }
/** Russian studio labels. */
export const ru = { title: 'Jingliu', workbench: 'Студия производства', workshopTitle: 'Сценарная мастерская', workshopDescription: 'Написание и редактирование сценариев' }
/** Portuguese studio labels. */
export const pt = { title: 'Jingliu', workbench: 'Estúdio de produção', workshopTitle: 'Oficina de roteiros', workshopDescription: 'Criação e edição de roteiros' }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jingliu studio entry and frame title. */
    jingliuStudio: keyof typeof en
  }
}
