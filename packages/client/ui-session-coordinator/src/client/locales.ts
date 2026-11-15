/** Copy owned by the Main Session task-card plugin. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Main Session navigation, task cards and action feedback. */
    'muse-coordination': CoordinationKey
  }
}
/** Translation namespace shared by navigation, cards and root feedback. */
export const NS = 'muse-coordination'
/** English task labels. */
export const en = {
  reportTitle: 'Task report', reportRevision: 'Revision {revision}', reportLive: 'Current status', reportHistorical: 'Recorded receipt',
  reportUnavailable: 'Live status is unavailable; showing the recorded receipt', reportEmpty: 'No tasks in this report',
  reportPartial: 'Showing {count} of {total} tasks', reportInspect: 'Inspect tool call',
  mainEntry: 'Muse Main Session', failedMain: 'Could not open Main Session',
  stopRequested: 'Task stop requested', tasks: 'Execution tasks', open: 'Open execution chat', stop: 'Stop task', stopping: 'Stopping',
  failedRead: 'Could not read task status', failedStop: 'Could not stop this task', failedOpen: 'Could not open this file',
  attention: 'Inspect the execution chat before continuing this task', details: 'Diagnostics', files: 'Files', dispatching: 'Waiting to start', reconciling: 'Preparing reconciliation', accepted: 'Delivered', running: 'Running', finishing: 'Finishing',
  'needs-report': 'Awaiting report', interrupted: 'Needs attention', stopped: 'Stopped', completed: 'Worker completed',
  blocked: 'Blocked', 'needs-input': 'Needs your input', failed: 'Failed', receipt: 'Worker report; awaiting your acceptance',
} as const
/** Chinese task labels. */
export const zh: Record<keyof typeof en, string> = {
  reportTitle: '任务汇报', reportRevision: '第 {revision} 次执行', reportLive: '当前状态', reportHistorical: '历史回执',
  reportUnavailable: '暂时无法更新状态，显示汇报时保存的回执', reportEmpty: '本次汇报没有任务',
  reportPartial: '显示 {count} 项，共 {total} 项任务', reportInspect: '查看工具调用',
  mainEntry: 'Muse 主会话', failedMain: '未能打开主会话',
  stopRequested: '已请求停止任务', tasks: '执行任务', open: '打开执行会话', stop: '停止任务', stopping: '正在停止',
  failedRead: '暂时无法读取任务状态', failedStop: '未能停止此任务', failedOpen: '未能打开此文件',
  attention: '请先检查执行会话，再决定如何续做', details: '诊断信息', files: '交付文件', dispatching: '等待开始', reconciling: '准备核对', accepted: '已送达', running: '执行中', finishing: '等待执行结束',
  'needs-report': '待执行会话汇报', interrupted: '需要跟进', stopped: '已停止', completed: '执行会话已完成',
  blocked: '遇到阻碍', 'needs-input': '需要补充信息', failed: '执行失败', receipt: '执行会话回执，等待你验收',
}
/** Japanese task labels. */
export const ja: Record<keyof typeof en, string> = {
  reportTitle: 'タスク報告', reportRevision: '第 {revision} 回の実行', reportLive: '現在の状態', reportHistorical: '記録済みの報告',
  reportUnavailable: '現在の状態を取得できないため、記録済みの報告を表示しています', reportEmpty: 'この報告にはタスクがありません',
  reportPartial: '{count} 件を表示（全 {total} 件）', reportInspect: 'ツール呼び出しを確認',
  mainEntry: 'Muse メインセッション', failedMain: 'メインセッションを開けませんでした',
  stopRequested: 'タスクの停止を要求しました', tasks: '実行タスク', open: '実行チャットを開く', stop: 'タスクを停止', stopping: '停止中',
  failedRead: 'タスクの状態を読み取れませんでした', failedStop: 'このタスクを停止できませんでした', failedOpen: 'このファイルを開けませんでした',
  attention: 'このタスクを続ける前に実行チャットを確認してください', details: '診断情報', files: 'ファイル', dispatching: '開始待ち', reconciling: '照合を準備中', accepted: '配信済み', running: '実行中', finishing: '終了処理中',
  'needs-report': '報告待ち', interrupted: '対応が必要', stopped: '停止済み', completed: '実行が完了しました',
  blocked: 'ブロック中', 'needs-input': '入力が必要です', failed: '失敗', receipt: '実行の報告。承認待ちです',
}
/** Spanish task labels. */
export const es: Record<keyof typeof en, string> = {
  reportTitle: 'Informe de tareas', reportRevision: 'Revisión {revision}', reportLive: 'Estado actual', reportHistorical: 'Recibo registrado',
  reportUnavailable: 'El estado en vivo no está disponible; se muestra el recibo registrado', reportEmpty: 'Este informe no tiene tareas',
  reportPartial: 'Mostrando {count} de {total} tareas', reportInspect: 'Inspeccionar la llamada a la herramienta',
  mainEntry: 'Sesión principal de Muse', failedMain: 'No se pudo abrir la sesión principal',
  stopRequested: 'Se solicitó detener la tarea', tasks: 'Tareas de ejecución', open: 'Abrir el chat de ejecución', stop: 'Detener tarea', stopping: 'Deteniendo',
  failedRead: 'No se pudo leer el estado de la tarea', failedStop: 'No se pudo detener esta tarea', failedOpen: 'No se pudo abrir este archivo',
  attention: 'Revisa el chat de ejecución antes de continuar con esta tarea', details: 'Diagnóstico', files: 'Archivos', dispatching: 'Esperando para empezar', reconciling: 'Preparando la conciliación', accepted: 'Entregado', running: 'En ejecución', finishing: 'Finalizando',
  'needs-report': 'Esperando el informe', interrupted: 'Requiere atención', stopped: 'Detenida', completed: 'Ejecución completada',
  blocked: 'Bloqueada', 'needs-input': 'Necesita tu información', failed: 'Falló', receipt: 'Informe de la ejecución; pendiente de tu aceptación',
}
/** French task labels. */
export const fr: Record<keyof typeof en, string> = {
  reportTitle: 'Rapport de tâches', reportRevision: 'Révision {revision}', reportLive: 'État actuel', reportHistorical: 'Reçu enregistré',
  reportUnavailable: 'L’état en direct est indisponible ; affichage du reçu enregistré', reportEmpty: 'Aucune tâche dans ce rapport',
  reportPartial: 'Affichage de {count} tâches sur {total}', reportInspect: 'Inspecter l’appel d’outil',
  mainEntry: 'Session principale Muse', failedMain: 'Impossible d’ouvrir la session principale',
  stopRequested: 'Arrêt de la tâche demandé', tasks: 'Tâches d’exécution', open: 'Ouvrir la conversation d’exécution', stop: 'Arrêter la tâche', stopping: 'Arrêt en cours',
  failedRead: 'Impossible de lire l’état de la tâche', failedStop: 'Impossible d’arrêter cette tâche', failedOpen: 'Impossible d’ouvrir ce fichier',
  attention: 'Consultez la conversation d’exécution avant de poursuivre cette tâche', details: 'Diagnostics', files: 'Fichiers', dispatching: 'En attente de démarrage', reconciling: 'Préparation du rapprochement', accepted: 'Livré', running: 'En cours', finishing: 'Finalisation',
  'needs-report': 'En attente du rapport', interrupted: 'Attention requise', stopped: 'Arrêtée', completed: 'Exécution terminée',
  blocked: 'Bloquée', 'needs-input': 'Votre saisie est requise', failed: 'Échec', receipt: 'Rapport d’exécution ; en attente de votre validation',
}
/** German task labels. */
export const de: Record<keyof typeof en, string> = {
  reportTitle: 'Aufgabenbericht', reportRevision: 'Revision {revision}', reportLive: 'Aktueller Status', reportHistorical: 'Gespeicherte Rückmeldung',
  reportUnavailable: 'Der aktuelle Status ist nicht verfügbar; die gespeicherte Rückmeldung wird angezeigt', reportEmpty: 'Dieser Bericht enthält keine Aufgaben',
  reportPartial: '{count} von {total} Aufgaben werden angezeigt', reportInspect: 'Toolaufruf ansehen',
  mainEntry: 'Muse-Hauptsitzung', failedMain: 'Die Hauptsitzung konnte nicht geöffnet werden',
  stopRequested: 'Stopp der Aufgabe angefordert', tasks: 'Ausführungsaufgaben', open: 'Ausführungschat öffnen', stop: 'Aufgabe stoppen', stopping: 'Wird gestoppt',
  failedRead: 'Der Aufgabenstatus konnte nicht gelesen werden', failedStop: 'Diese Aufgabe konnte nicht gestoppt werden', failedOpen: 'Diese Datei konnte nicht geöffnet werden',
  attention: 'Vor dem Fortsetzen dieser Aufgabe den Ausführungschat prüfen', details: 'Diagnose', files: 'Dateien', dispatching: 'Wartet auf den Start', reconciling: 'Abgleich wird vorbereitet', accepted: 'Zugestellt', running: 'Läuft', finishing: 'Wird abgeschlossen',
  'needs-report': 'Bericht ausstehend', interrupted: 'Benötigt Aufmerksamkeit', stopped: 'Gestoppt', completed: 'Ausführung abgeschlossen',
  blocked: 'Blockiert', 'needs-input': 'Eingabe erforderlich', failed: 'Fehlgeschlagen', receipt: 'Ausführungsbericht; wartet auf Abnahme',
}
/** Russian task labels. */
export const ru: Record<keyof typeof en, string> = {
  reportTitle: 'Отчёт о задачах', reportRevision: 'Ревизия {revision}', reportLive: 'Текущее состояние', reportHistorical: 'Сохранённый отчёт',
  reportUnavailable: 'Текущее состояние недоступно; показан сохранённый отчёт', reportEmpty: 'В этом отчёте нет задач',
  reportPartial: 'Показано {count} из {total} задач', reportInspect: 'Просмотреть вызов инструмента',
  mainEntry: 'Главная сессия Muse', failedMain: 'Не удалось открыть главную сессию',
  stopRequested: 'Запрошена остановка задачи', tasks: 'Задачи выполнения', open: 'Открыть чат выполнения', stop: 'Остановить задачу', stopping: 'Остановка',
  failedRead: 'Не удалось прочитать состояние задачи', failedStop: 'Не удалось остановить эту задачу', failedOpen: 'Не удалось открыть этот файл',
  attention: 'Проверьте чат выполнения, прежде чем продолжить эту задачу', details: 'Диагностика', files: 'Файлы', dispatching: 'Ожидает запуска', reconciling: 'Подготовка сверки', accepted: 'Доставлено', running: 'Выполняется', finishing: 'Завершается',
  'needs-report': 'Ожидает отчёта', interrupted: 'Требует внимания', stopped: 'Остановлено', completed: 'Выполнение завершено',
  blocked: 'Заблокировано', 'needs-input': 'Нужны ваши данные', failed: 'Ошибка', receipt: 'Отчёт о выполнении; ожидает вашей приёмки',
}
/** Portuguese task labels. */
export const pt: Record<keyof typeof en, string> = {
  reportTitle: 'Relatório de tarefas', reportRevision: 'Revisão {revision}', reportLive: 'Status atual', reportHistorical: 'Recibo registrado',
  reportUnavailable: 'O status ao vivo não está disponível; mostrando o recibo registrado', reportEmpty: 'Nenhuma tarefa neste relatório',
  reportPartial: 'Mostrando {count} de {total} tarefas', reportInspect: 'Inspecionar a chamada de ferramenta',
  mainEntry: 'Sessão principal do Muse', failedMain: 'Não foi possível abrir a sessão principal',
  stopRequested: 'Parada da tarefa solicitada', tasks: 'Tarefas de execução', open: 'Abrir o chat de execução', stop: 'Parar tarefa', stopping: 'Parando',
  failedRead: 'Não foi possível ler o status da tarefa', failedStop: 'Não foi possível parar esta tarefa', failedOpen: 'Não foi possível abrir este arquivo',
  attention: 'Verifique o chat de execução antes de continuar esta tarefa', details: 'Diagnóstico', files: 'Arquivos', dispatching: 'Aguardando início', reconciling: 'Preparando a conciliação', accepted: 'Entregue', running: 'Em execução', finishing: 'Finalizando',
  'needs-report': 'Aguardando relatório', interrupted: 'Precisa de atenção', stopped: 'Parada', completed: 'Execução concluída',
  blocked: 'Bloqueada', 'needs-input': 'Precisa da sua informação', failed: 'Falhou', receipt: 'Relatório da execução; aguardando sua aceitação',
}
/** Owned translation keys. */
export type CoordinationKey = keyof typeof en
