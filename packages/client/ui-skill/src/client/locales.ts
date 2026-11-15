/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '加载技能',
  'row.running': '正在加载 skill',
  'row.preparing': '准备加载技能',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.inspect': '查看',
  'menu.userOnly': '仅用户',
  'catalog.title': '查找技能',
  'catalog.running': '正在查询技能',
  'catalog.preparing': '准备查询技能',
  'catalog.failed': '查询失败，请重试',
  'catalog.stopped': '查询已中止',
  'catalog.count': '本页 {count} 项，共 {total} 项',
  'catalog.more': '还有更多结果',
  'catalog.stale': '目录已更新，请重新查询',
  'catalog.incomplete': '暂时无法完整读取目录，请稍后重试',
  'catalog.invalid': '分页参数无效，请重新查询',
  'catalog.done': '查询完成',
  'catalog.foreign': '此分页来自另一会话，请重新查询',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Skill',
  'row.running': 'Loading skill',
  'row.preparing': 'Preparing to load a skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspect',
  'menu.userOnly': 'user-only',
  'catalog.title': 'Find skills',
  'catalog.running': 'Searching skills',
  'catalog.preparing': 'Preparing skill query',
  'catalog.failed': 'Skill query failed; retry',
  'catalog.stopped': 'Skill query stopped',
  'catalog.count': '{count} of {total} matches',
  'catalog.more': 'More results available',
  'catalog.stale': 'The directory changed; start a new query',
  'catalog.incomplete': 'The full directory is unavailable; retry',
  'catalog.invalid': 'Invalid page; start a new query',
  'catalog.done': 'Query complete',
  'catalog.foreign': 'This page belongs to another chat; start a new query',
} satisfies Record<SkillKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'row.title': 'スキル',
  'row.running': 'スキルを読み込み中',
  'row.preparing': 'スキルの読み込みを準備中',
  'row.failed': 'スキルの読み込みに失敗しました',
  'row.stopped': 'スキルの読み込みが停止しました',
  'row.instructions': '手順',
  'row.inspect': '詳細を確認',
  'menu.userOnly': 'ユーザー専用',
  'catalog.title': 'スキルを検索',
  'catalog.running': 'スキルを検索中',
  'catalog.preparing': '検索を準備中',
  'catalog.failed': '検索に失敗しました。再試行してください',
  'catalog.stopped': '検索を中止しました',
  'catalog.count': '{total} 件中 {count} 件',
  'catalog.more': '続きがあります',
  'catalog.stale': '一覧が更新されました。再検索してください',
  'catalog.incomplete': '一覧を取得できません。再試行してください',
  'catalog.invalid': 'ページが無効です。再検索してください',
  'catalog.done': '検索が完了しました',
  'catalog.foreign': '別のチャットのページです。再検索してください',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'row.title': 'Habilidad',
  'row.running': 'Habilidad de carga',
  'row.preparing': 'Preparándose para cargar una habilidad',
  'row.failed': 'La carga de habilidades falló',
  'row.stopped': 'Carga de habilidades detenida',
  'row.instructions': 'Instrucciones',
  'row.inspect': 'inspeccionar',
  'menu.userOnly': 'solo usuario',
  'catalog.title': 'Buscar habilidades',
  'catalog.running': 'Buscando habilidades',
  'catalog.preparing': 'Preparando búsqueda',
  'catalog.failed': 'La búsqueda falló; reintentar',
  'catalog.stopped': 'Búsqueda detenida',
  'catalog.count': '{count} de {total} resultados',
  'catalog.more': 'Hay más resultados',
  'catalog.stale': 'El directorio cambió; iniciar otra búsqueda',
  'catalog.incomplete': 'El directorio no está disponible; reintentar',
  'catalog.invalid': 'Página no válida; iniciar otra búsqueda',
  'catalog.done': 'Búsqueda completa',
  'catalog.foreign': 'Esta página pertenece a otro chat; iniciar otra búsqueda',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'row.title': 'Compétence',
  'row.running': 'Compétence de chargement',
  'row.preparing': 'Préparation du chargement d’une compétence',
  'row.failed': 'Échec du chargement des compétences',
  'row.stopped': 'Chargement de compétences arrêté',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspecter',
  'menu.userOnly': 'utilisateur uniquement',
  'catalog.title': 'Rechercher des compétences',
  'catalog.running': 'Recherche en cours',
  'catalog.preparing': 'Préparation de la recherche',
  'catalog.failed': 'Échec de la recherche ; réessayez',
  'catalog.stopped': 'Recherche arrêtée',
  'catalog.count': '{count} résultats sur {total}',
  'catalog.more': 'Autres résultats disponibles',
  'catalog.stale': 'Le répertoire a changé ; relancez la recherche',
  'catalog.incomplete': 'Répertoire indisponible ; réessayez',
  'catalog.invalid': 'Page invalide ; relancez la recherche',
  'catalog.done': 'Recherche terminée',
  'catalog.foreign': 'Cette page appartient à une autre discussion ; relancez la recherche',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'row.title': 'Geschicklichkeit',
  'row.running': 'Ladefähigkeit',
  'row.preparing': 'Das Laden eines Skills wird vorbereitet',
  'row.failed': 'Das Laden des Skills ist fehlgeschlagen',
  'row.stopped': 'Das Laden der Fertigkeiten wurde gestoppt',
  'row.instructions': 'Anweisungen',
  'row.inspect': 'Inspizieren',
  'menu.userOnly': 'Nur für Benutzer',
  'catalog.title': 'Skills suchen',
  'catalog.running': 'Skills werden gesucht',
  'catalog.preparing': 'Suche wird vorbereitet',
  'catalog.failed': 'Suche fehlgeschlagen; erneut versuchen',
  'catalog.stopped': 'Suche beendet',
  'catalog.count': '{count} von {total} Treffern',
  'catalog.more': 'Weitere Ergebnisse verfügbar',
  'catalog.stale': 'Verzeichnis geändert; neue Suche starten',
  'catalog.incomplete': 'Verzeichnis nicht verfügbar; erneut versuchen',
  'catalog.invalid': 'Ungültige Seite; neue Suche starten',
  'catalog.done': 'Suche abgeschlossen',
  'catalog.foreign': 'Diese Seite gehört zu einem anderen Chat; neue Suche starten',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'row.title': 'Навык',
  'row.running': 'Навык загрузки',
  'row.preparing': 'Подготовка к загрузке навыка',
  'row.failed': 'Не удалось загрузить навык',
  'row.stopped': 'Загрузка навыков остановлена',
  'row.instructions': 'Инструкции',
  'row.inspect': 'Осмотреть',
  'menu.userOnly': 'только для пользователей',
  'catalog.title': 'Найти навыки',
  'catalog.running': 'Поиск навыков',
  'catalog.preparing': 'Подготовка поиска',
  'catalog.failed': 'Ошибка поиска; повторите попытку',
  'catalog.stopped': 'Поиск остановлен',
  'catalog.count': '{count} из {total} результатов',
  'catalog.more': 'Есть другие результаты',
  'catalog.stale': 'Каталог изменился; начните новый поиск',
  'catalog.incomplete': 'Каталог недоступен; повторите попытку',
  'catalog.invalid': 'Недопустимая страница; начните новый поиск',
  'catalog.done': 'Поиск завершён',
  'catalog.foreign': 'Страница из другого чата; начните новый поиск',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'row.title': 'Habilidade',
  'row.running': 'Habilidade de carregamento',
  'row.preparing': 'Preparando-se para carregar uma habilidade',
  'row.failed': 'Falha no carregamento da habilidade',
  'row.stopped': 'Carga de habilidade interrompida',
  'row.instructions': 'Instruções',
  'row.inspect': 'Inspecionar',
  'menu.userOnly': 'somente usuário',
  'catalog.title': 'Buscar habilidades',
  'catalog.running': 'Buscando habilidades',
  'catalog.preparing': 'Preparando busca',
  'catalog.failed': 'Falha na busca; tente novamente',
  'catalog.stopped': 'Busca interrompida',
  'catalog.count': '{count} de {total} resultados',
  'catalog.more': 'Há mais resultados',
  'catalog.stale': 'O diretório mudou; inicie outra busca',
  'catalog.incomplete': 'Diretório indisponível; tente novamente',
  'catalog.invalid': 'Página inválida; inicie outra busca',
  'catalog.done': 'Busca concluída',
  'catalog.foreign': 'Esta página pertence a outro chat; inicie outra busca',
} satisfies Record<keyof typeof en, string>
