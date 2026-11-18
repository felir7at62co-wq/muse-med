/** Localized names for the Jingliu guide and its document. */
export const en = { title: 'Jingliu', workbench: 'Production studio' }
/** Chinese studio labels. */
export const zh = { title: '镜流', workbench: '短剧制作工作台' }
/** Japanese studio labels. */
export const ja = { title: 'Jingliu', workbench: '制作スタジオ' }
/** Spanish studio labels. */
export const es = { title: 'Jingliu', workbench: 'Estudio de producción' }
/** French studio labels. */
export const fr = { title: 'Jingliu', workbench: 'Studio de production' }
/** German studio labels. */
export const de = { title: 'Jingliu', workbench: 'Produktionsstudio' }
/** Russian studio labels. */
export const ru = { title: 'Jingliu', workbench: 'Студия производства' }
/** Portuguese studio labels. */
export const pt = { title: 'Jingliu', workbench: 'Estúdio de produção' }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jingliu studio entry and frame title. */
    jingliuStudio: keyof typeof en
  }
}
