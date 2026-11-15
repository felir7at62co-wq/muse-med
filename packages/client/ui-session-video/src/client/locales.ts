/** Copy owned by the conversation video shelf. */
/** Namespace for all Session video product copy. */
export const NS = 'sessionVideo'
/** Simplified Chinese source dictionary. */
export const zh = {
  settingTitle: '视频气泡与轨道',
  settingDescription: '启用 Muse 气泡、镜头轨道和视频收纳动效；关闭后立即恢复原有界面',
  settingError: '设置未能生效，请重试',
  brand: 'Muse', library: '会话视频', empty: '这个会话还没有视频', loading: '正在读取视频…',
  unavailable: '视频暂时无法播放', retry: '重试', play: '播放', pause: '暂停',
  zoomControls: '视频轨道缩放', zoomIn: '放大视频轨道', zoomOut: '缩小视频轨道', zoomValue: '轨道缩放 {percent}%',
  timeline: '视频镜头轨道', playhead: '播放位置', detecting: '正在识别镜头…',
  detectionFailed: '无法识别镜头，可重试', redo: '重做这个镜头',
  shot: '镜头 {index} · {start}–{end}', source: '切换视频：{name}',
  redoPrompt: '请重做这个镜头：{name}。源视频：{source}；镜头 ID：{id}；原视频范围：{start}–{end} 秒。保留前后镜头的剧情与人物连续性。具体调整：',
  selectShotToRedo: '先在下方轨道选择一个镜头',
  collected: '已收纳到 Muse，点击查看', incomplete: '部分视频暂未读取完整',
} as const
/** Typed keys for every dictionary registered by this plugin. */
export type VideoKey = keyof typeof zh
/** English fallback dictionary. */
export const en: Record<VideoKey, string> = {
  settingTitle: 'Video bubble and timeline',
  settingDescription: 'Enable the Muse bubble, shot timeline and video collection animation. Turn off to restore the original interface immediately.',
  settingError: 'The setting could not be applied. Please retry.',
  brand: 'Muse', library: 'Conversation videos', empty: 'No videos in this conversation yet', loading: 'Loading video…',
  unavailable: 'Video is unavailable', retry: 'Retry', play: 'Play', pause: 'Pause',
  zoomControls: 'Timeline zoom', zoomIn: 'Zoom in timeline', zoomOut: 'Zoom out timeline', zoomValue: 'Timeline zoom {percent}%',
  timeline: 'Video shots', playhead: 'Playback position', detecting: 'Detecting shots…',
  detectionFailed: 'Shot detection failed. You can retry.', redo: 'Regenerate this shot',
  shot: 'Shot {index} · {start}–{end}', source: 'Switch video: {name}',
  redoPrompt: 'Regenerate this shot: {name}. Source: {source}; shot ID: {id}; original range: {start}–{end} seconds. Preserve story and character continuity with adjacent shots. Changes: ',
  selectShotToRedo: 'Select a shot in the timeline first',
  collected: 'Stored in Muse. Click to view.', incomplete: 'Some videos could not be read completely',
}
/** Japanese conversation video copy. */
export const ja: Record<VideoKey, string> = {
  settingTitle: '動画バブルとタイムライン',
  settingDescription: 'Muse バブル、ショットのタイムライン、動画の収納アニメーションを有効にします。オフにすると元の画面にすぐに戻ります。',
  settingError: '設定を適用できませんでした。もう一度お試しください。',
  brand: 'Muse', library: '会話の動画', empty: 'この会話にはまだ動画がありません', loading: '動画を読み込み中…',
  unavailable: '動画を再生できません', retry: '再試行', play: '再生', pause: '一時停止',
  zoomControls: '動画タイムラインの拡大率', zoomIn: 'タイムラインを拡大', zoomOut: 'タイムラインを縮小', zoomValue: 'タイムラインの拡大率 {percent}%',
  timeline: '動画のショット', playhead: '再生位置', detecting: 'ショットを検出中…',
  detectionFailed: 'ショットを検出できませんでした。再試行できます。', redo: 'このショットを再生成',
  shot: 'ショット {index} · {start}–{end}', source: '動画を切り替え：{name}',
  redoPrompt: 'このショットを再生成してください：{name}。元の動画：{source}；ショット ID：{id}；元の動画の範囲：{start}–{end} 秒。前後のショットとの物語と人物の連続性を保ってください。変更内容：',
  selectShotToRedo: '先にタイムラインでショットを選択してください',
  collected: 'Muse に収納しました。クリックして表示します。', incomplete: '一部の動画を完全に読み込めませんでした',
}
/** Spanish conversation video copy. */
export const es: Record<VideoKey, string> = {
  settingTitle: 'Burbuja de vídeo y línea de tiempo',
  settingDescription: 'Activa la burbuja de Muse, la línea de tiempo de planos y la animación para guardar vídeos. Desactiva la opción para restaurar la interfaz original de inmediato.',
  settingError: 'No se pudo aplicar el ajuste. Inténtalo de nuevo.',
  brand: 'Muse', library: 'Vídeos de la conversación', empty: 'Todavía no hay vídeos en esta conversación', loading: 'Cargando vídeo…',
  unavailable: 'El vídeo no está disponible', retry: 'Reintentar', play: 'Reproducir', pause: 'Pausar',
  zoomControls: 'Zoom de la línea de tiempo', zoomIn: 'Ampliar la línea de tiempo', zoomOut: 'Reducir la línea de tiempo', zoomValue: 'Zoom de la línea de tiempo {percent}%',
  timeline: 'Planos del vídeo', playhead: 'Posición de reproducción', detecting: 'Detectando planos…',
  detectionFailed: 'No se pudieron detectar los planos. Puedes reintentarlo.', redo: 'Volver a generar este plano',
  shot: 'Plano {index} · {start}–{end}', source: 'Cambiar vídeo: {name}',
  redoPrompt: 'Vuelve a generar este plano: {name}. Vídeo de origen: {source}; ID del plano: {id}; intervalo original: {start}–{end} segundos. Mantén la continuidad de la historia y los personajes con los planos adyacentes. Cambios: ',
  selectShotToRedo: 'Selecciona primero un plano en la línea de tiempo',
  collected: 'Guardado en Muse. Haz clic para verlo.', incomplete: 'No se pudieron leer algunos vídeos por completo',
}
/** French conversation video copy. */
export const fr: Record<VideoKey, string> = {
  settingTitle: 'Bulle vidéo et chronologie',
  settingDescription: 'Active la bulle Muse, la chronologie des plans et l’animation de rangement des vidéos. Désactivez cette option pour rétablir immédiatement l’interface d’origine.',
  settingError: 'Le paramètre n’a pas pu être appliqué. Réessayez.',
  brand: 'Muse', library: 'Vidéos de la conversation', empty: 'Cette conversation ne contient pas encore de vidéo', loading: 'Chargement de la vidéo…',
  unavailable: 'La vidéo est indisponible', retry: 'Réessayer', play: 'Lire', pause: 'Mettre en pause',
  zoomControls: 'Zoom de la chronologie', zoomIn: 'Agrandir la chronologie', zoomOut: 'Réduire la chronologie', zoomValue: 'Zoom de la chronologie {percent}%',
  timeline: 'Plans de la vidéo', playhead: 'Position de lecture', detecting: 'Détection des plans…',
  detectionFailed: 'La détection des plans a échoué. Vous pouvez réessayer.', redo: 'Générer à nouveau ce plan',
  shot: 'Plan {index} · {start}–{end}', source: 'Changer de vidéo : {name}',
  redoPrompt: 'Générez à nouveau ce plan : {name}. Vidéo source : {source} ; ID du plan : {id} ; intervalle d’origine : {start}–{end} secondes. Préservez la continuité de l’histoire et des personnages avec les plans voisins. Modifications : ',
  selectShotToRedo: 'Sélectionnez d’abord un plan dans la chronologie',
  collected: 'Rangé dans Muse. Cliquez pour le consulter.', incomplete: 'Certaines vidéos n’ont pas pu être lues entièrement',
}
/** German conversation video copy. */
export const de: Record<VideoKey, string> = {
  settingTitle: 'Videoblase und Zeitleiste',
  settingDescription: 'Aktiviert die Muse-Blase, die Zeitleiste der Einstellungen und die Animation zum Einsammeln von Videos. Beim Ausschalten wird die ursprüngliche Oberfläche sofort wiederhergestellt.',
  settingError: 'Die Einstellung konnte nicht angewendet werden. Bitte erneut versuchen.',
  brand: 'Muse', library: 'Videos der Unterhaltung', empty: 'In dieser Unterhaltung gibt es noch keine Videos', loading: 'Video wird geladen…',
  unavailable: 'Das Video ist nicht verfügbar', retry: 'Erneut versuchen', play: 'Wiedergeben', pause: 'Pausieren',
  zoomControls: 'Zoom der Zeitleiste', zoomIn: 'Zeitleiste vergrößern', zoomOut: 'Zeitleiste verkleinern', zoomValue: 'Zoom der Zeitleiste {percent}%',
  timeline: 'Einstellungen des Videos', playhead: 'Wiedergabeposition', detecting: 'Einstellungen werden erkannt…',
  detectionFailed: 'Die Erkennung der Einstellungen ist fehlgeschlagen. Bitte erneut versuchen.', redo: 'Diese Einstellung neu generieren',
  shot: 'Einstellung {index} · {start}–{end}', source: 'Video wechseln: {name}',
  redoPrompt: 'Diese Einstellung neu generieren: {name}. Quellvideo: {source}; Einstellungs-ID: {id}; ursprünglicher Bereich: {start}–{end} Sekunden. Die Kontinuität der Handlung und der Figuren zu den angrenzenden Einstellungen beibehalten. Änderungen: ',
  selectShotToRedo: 'Zuerst eine Einstellung in der Zeitleiste auswählen',
  collected: 'In Muse gesammelt. Zum Anzeigen anklicken.', incomplete: 'Einige Videos konnten nicht vollständig gelesen werden',
}
/** Russian conversation video copy. */
export const ru: Record<VideoKey, string> = {
  settingTitle: 'Видеопузырь и временная шкала',
  settingDescription: 'Включает видеопузырь Muse, шкалу планов и анимацию сбора видео. Отключите, чтобы сразу восстановить исходный интерфейс.',
  settingError: 'Не удалось применить настройку. Повторите попытку.',
  brand: 'Muse', library: 'Видео беседы', empty: 'В этой беседе пока нет видео', loading: 'Загрузка видео…',
  unavailable: 'Видео недоступно', retry: 'Повторить', play: 'Воспроизвести', pause: 'Приостановить',
  zoomControls: 'Масштаб временной шкалы', zoomIn: 'Увеличить временную шкалу', zoomOut: 'Уменьшить временную шкалу', zoomValue: 'Масштаб временной шкалы {percent}%',
  timeline: 'Планы видео', playhead: 'Позиция воспроизведения', detecting: 'Распознавание планов…',
  detectionFailed: 'Не удалось распознать планы. Можно повторить попытку.', redo: 'Сгенерировать этот план заново',
  shot: 'План {index} · {start}–{end}', source: 'Переключить видео: {name}',
  redoPrompt: 'Сгенерируйте этот план заново: {name}. Исходное видео: {source}; ID плана: {id}; исходный диапазон: {start}–{end} секунд. Сохраните непрерывность сюжета и персонажей относительно соседних планов. Изменения: ',
  selectShotToRedo: 'Сначала выберите план на временной шкале',
  collected: 'Сохранено в Muse. Нажмите для просмотра.', incomplete: 'Некоторые видео не удалось прочитать полностью',
}
/** Portuguese conversation video copy. */
export const pt: Record<VideoKey, string> = {
  settingTitle: 'Balão de vídeo e linha do tempo',
  settingDescription: 'Ativa o balão do Muse, a linha do tempo de tomadas e a animação de recolhimento de vídeos. Desative para restaurar a interface original imediatamente.',
  settingError: 'Não foi possível aplicar a configuração. Tente novamente.',
  brand: 'Muse', library: 'Vídeos da conversa', empty: 'Ainda não há vídeos nesta conversa', loading: 'Carregando vídeo…',
  unavailable: 'O vídeo está indisponível', retry: 'Tentar novamente', play: 'Reproduzir', pause: 'Pausar',
  zoomControls: 'Zoom da linha do tempo', zoomIn: 'Ampliar a linha do tempo', zoomOut: 'Reduzir a linha do tempo', zoomValue: 'Zoom da linha do tempo {percent}%',
  timeline: 'Tomadas do vídeo', playhead: 'Posição de reprodução', detecting: 'Detectando tomadas…',
  detectionFailed: 'Não foi possível detectar as tomadas. Você pode tentar novamente.', redo: 'Gerar esta tomada novamente',
  shot: 'Tomada {index} · {start}–{end}', source: 'Trocar vídeo: {name}',
  redoPrompt: 'Gere esta tomada novamente: {name}. Vídeo de origem: {source}; ID da tomada: {id}; intervalo original: {start}–{end} segundos. Preserve a continuidade da história e dos personagens com as tomadas adjacentes. Alterações: ',
  selectShotToRedo: 'Selecione primeiro uma tomada na linha do tempo',
  collected: 'Recolhido no Muse. Clique para visualizar.', incomplete: 'Não foi possível ler alguns vídeos por completo',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Conversation video shelf copy. */ sessionVideo: VideoKey }
}
