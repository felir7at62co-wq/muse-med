/** Character library navigation, browse and preview copy. */
export const zh = {
  assetLibrary: '资产库', sharedLibrary: '共享素材', title: '人物库', description: '浏览古装与都市人物参考，Muse 可在生成人物素材时查阅',
  readOnly: '只读参考库', all: '全部', ancient: '古装', urban: '都市', collection: '人物分类',
  search: '搜索人物特征、风格或标签', searchAction: '搜索', refresh: '刷新',
  unavailable: '人物库暂未连接，请联系管理员开通访问',
  failed: '暂时无法读取人物库，请重试', empty: '没有找到符合条件的人物参考',
  retry: '重试', previous: '上一页', next: '下一页', close: '关闭',
  preview: '查看人物参考', previewFailed: '暂时无法查看此图片，请重试',
  imageFailed: '图片暂不可用',
  referenceOnly: '仅供创作参考，生成素材仍需按项目要求审核',
  count: '本页 {count} 项', loading: '正在读取人物库',
} as const
/** Typed keys shared by the character library dictionaries. */
export type CharacterLibraryKey = keyof typeof zh
/** English character library copy. */
export const en: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'Asset library', sharedLibrary: 'Shared assets', title: 'Character library', description: 'Browse ancient and urban character references for Muse character generation',
  readOnly: 'Read-only references', all: 'All', ancient: 'Ancient', urban: 'Urban', collection: 'Character collection',
  search: 'Search appearance, style or tags', searchAction: 'Search', refresh: 'Refresh',
  unavailable: 'The character library is not connected. Ask your administrator to enable access.',
  failed: 'The character library could not be read. Try again.', empty: 'No matching character references',
  retry: 'Retry', previous: 'Previous', next: 'Next', close: 'Close',
  preview: 'View character reference', previewFailed: 'This image could not be opened. Try again.',
  imageFailed: 'Image unavailable',
  referenceOnly: 'For creative reference. Generated assets still require project review.',
  count: '{count} items on this page', loading: 'Reading character library',
}
/** Japanese character library copy. */
export const ja: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'アセットライブラリ', sharedLibrary: '共有素材',
  title: '人物ライブラリ', description: 'Muse の人物素材生成に使う、時代劇・現代ものの人物参考を閲覧',
  readOnly: '閲覧専用の参考資料', all: 'すべて', ancient: '時代劇', urban: '現代もの', collection: '人物の分類',
  search: '外見、スタイル、タグで検索', searchAction: '検索', refresh: '更新',
  unavailable: '人物ライブラリに接続されていません。管理者にアクセスの有効化を依頼してください。',
  failed: '人物ライブラリを読み込めませんでした。もう一度お試しください。', empty: '条件に合う人物参考がありません',
  retry: '再試行', previous: '前へ', next: '次へ', close: '閉じる',
  preview: '人物参考を表示', previewFailed: '画像を開けませんでした。もう一度お試しください。',
  imageFailed: '画像を表示できません',
  referenceOnly: '創作の参考用です。生成素材はプロジェクトの基準に沿った確認が必要です。',
  count: 'このページは {count} 件', loading: '人物ライブラリを読み込み中',
}
/** Spanish character library copy. */
export const es: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'Biblioteca de recursos', sharedLibrary: 'Recursos compartidos',
  title: 'Biblioteca de personajes', description: 'Explora referencias de personajes históricos y urbanos para crear personajes con Muse',
  readOnly: 'Referencias de solo lectura', all: 'Todos', ancient: 'Históricos', urban: 'Urbanos', collection: 'Colección de personajes',
  search: 'Buscar por apariencia, estilo o etiquetas', searchAction: 'Buscar', refresh: 'Actualizar',
  unavailable: 'La biblioteca de personajes no está conectada. Pide al administrador que habilite el acceso.',
  failed: 'No se pudo leer la biblioteca de personajes. Inténtalo de nuevo.', empty: 'No se encontraron referencias de personajes que coincidan',
  retry: 'Reintentar', previous: 'Anterior', next: 'Siguiente', close: 'Cerrar',
  preview: 'Ver referencia del personaje', previewFailed: 'No se pudo abrir esta imagen. Inténtalo de nuevo.',
  imageFailed: 'Imagen no disponible',
  referenceOnly: 'Solo como referencia creativa. Los recursos generados deben revisarse según los requisitos del proyecto.',
  count: '{count} elementos en esta página', loading: 'Cargando la biblioteca de personajes',
}
/** French character library copy. */
export const fr: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'Bibliothèque de ressources', sharedLibrary: 'Ressources partagées',
  title: 'Bibliothèque de personnages', description: 'Parcourez des références de personnages historiques et contemporains pour créer des personnages avec Muse',
  readOnly: 'Références en lecture seule', all: 'Tous', ancient: 'Historiques', urban: 'Contemporains', collection: 'Collection de personnages',
  search: 'Rechercher par apparence, style ou étiquette', searchAction: 'Rechercher', refresh: 'Actualiser',
  unavailable: 'La bibliothèque de personnages n’est pas connectée. Demandez à votre administrateur d’activer l’accès.',
  failed: 'La bibliothèque de personnages n’a pas pu être chargée. Réessayez.', empty: 'Aucune référence de personnage ne correspond',
  retry: 'Réessayer', previous: 'Précédent', next: 'Suivant', close: 'Fermer',
  preview: 'Voir la référence du personnage', previewFailed: 'Cette image n’a pas pu être ouverte. Réessayez.',
  imageFailed: 'Image indisponible',
  referenceOnly: 'Pour référence créative uniquement. Les ressources générées doivent être vérifiées selon les exigences du projet.',
  count: '{count} éléments sur cette page', loading: 'Chargement de la bibliothèque de personnages',
}
/** German character library copy. */
export const de: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'Asset-Bibliothek', sharedLibrary: 'Geteilte Assets',
  title: 'Figurenbibliothek', description: 'Historische und moderne Figurenreferenzen für die Figurenerstellung mit Muse durchsuchen',
  readOnly: 'Referenzen nur zur Ansicht', all: 'Alle', ancient: 'Historisch', urban: 'Modern', collection: 'Figurensammlung',
  search: 'Nach Aussehen, Stil oder Tags suchen', searchAction: 'Suchen', refresh: 'Aktualisieren',
  unavailable: 'Die Figurenbibliothek ist nicht verbunden. Bitte die Administration um Freigabe des Zugriffs.',
  failed: 'Die Figurenbibliothek konnte nicht geladen werden. Versuche es erneut.', empty: 'Keine passenden Figurenreferenzen gefunden',
  retry: 'Erneut versuchen', previous: 'Zurück', next: 'Weiter', close: 'Schließen',
  preview: 'Figurenreferenz ansehen', previewFailed: 'Dieses Bild konnte nicht geöffnet werden. Versuche es erneut.',
  imageFailed: 'Bild nicht verfügbar',
  referenceOnly: 'Nur als kreative Referenz. Erstellte Assets müssen nach den Projektvorgaben geprüft werden.',
  count: '{count} Einträge auf dieser Seite', loading: 'Figurenbibliothek wird geladen',
}
/** Russian character library copy. */
export const ru: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'Библиотека ресурсов', sharedLibrary: 'Общие ресурсы',
  title: 'Библиотека персонажей', description: 'Референсы исторических и современных персонажей для создания персонажей в Muse',
  readOnly: 'Референсы только для просмотра', all: 'Все', ancient: 'Исторические', urban: 'Современные', collection: 'Коллекция персонажей',
  search: 'Поиск по внешности, стилю или тегам', searchAction: 'Найти', refresh: 'Обновить',
  unavailable: 'Библиотека персонажей не подключена. Попросите администратора открыть доступ.',
  failed: 'Не удалось загрузить библиотеку персонажей. Повторите попытку.', empty: 'Подходящие референсы персонажей не найдены',
  retry: 'Повторить', previous: 'Назад', next: 'Далее', close: 'Закрыть',
  preview: 'Посмотреть референс персонажа', previewFailed: 'Не удалось открыть изображение. Повторите попытку.',
  imageFailed: 'Изображение недоступно',
  referenceOnly: 'Только для творческой работы с референсами. Созданные материалы необходимо проверить по требованиям проекта.',
  count: 'На странице: {count}', loading: 'Загрузка библиотеки персонажей',
}
/** Portuguese character library copy. */
export const pt: Record<CharacterLibraryKey, string> = {
  assetLibrary: 'Biblioteca de recursos', sharedLibrary: 'Recursos compartilhados',
  title: 'Biblioteca de personagens', description: 'Explore referências de personagens históricos e urbanos para criar personagens com o Muse',
  readOnly: 'Referências somente para leitura', all: 'Todos', ancient: 'Históricos', urban: 'Urbanos', collection: 'Coleção de personagens',
  search: 'Pesquisar por aparência, estilo ou etiquetas', searchAction: 'Pesquisar', refresh: 'Atualizar',
  unavailable: 'A biblioteca de personagens não está conectada. Peça ao administrador para habilitar o acesso.',
  failed: 'Não foi possível carregar a biblioteca de personagens. Tente novamente.', empty: 'Nenhuma referência de personagem correspondente foi encontrada',
  retry: 'Tentar novamente', previous: 'Anterior', next: 'Próxima', close: 'Fechar',
  preview: 'Ver referência do personagem', previewFailed: 'Não foi possível abrir esta imagem. Tente novamente.',
  imageFailed: 'Imagem indisponível',
  referenceOnly: 'Apenas para referência criativa. Os recursos gerados devem ser revisados de acordo com os requisitos do projeto.',
  count: '{count} itens nesta página', loading: 'Carregando a biblioteca de personagens',
}
