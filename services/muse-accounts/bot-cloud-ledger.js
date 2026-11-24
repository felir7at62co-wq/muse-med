// Isolated pilot ledger. Bot Sessions remain owned by their original Host.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const nonempty = (value, label, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${label}`)
  return value.trim()
}
const SCHEMA_VERSION = 4

/** Durable task proposals for one isolated cloud pilot.
 * @param {string} file Private SQLite database path.
 * @param {() => number} now Millisecond clock.
 * @returns {object} Ledger operations.
 */
export function openCloudLedger(file, now = Date.now) {
  const db = new DatabaseSync(file)
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version
  if (schemaVersion > SCHEMA_VERSION) { db.close(); throw new Error('Cloud ledger was created by a newer version') }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id),
      issuer_id TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL, decision_note TEXT, claim_id TEXT, session_id TEXT, result TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS task_device_state ON tasks(device_id,state,created_at);`)
  if (schemaVersion < 2) {
    db.exec("BEGIN IMMEDIATE; ALTER TABLE tasks ADD COLUMN notification_state TEXT; PRAGMA user_version=2; COMMIT")
  }
  if (schemaVersion < 3) {
    db.exec("BEGIN IMMEDIATE; ALTER TABLE tasks ADD COLUMN alert_state TEXT; PRAGMA user_version=3; COMMIT")
  }
  if (schemaVersion < 4) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE devices ADD COLUMN main_bot_id TEXT;
      ALTER TABLE devices ADD COLUMN session_id TEXT;
      ALTER TABLE devices ADD COLUMN bot_name TEXT;
      ALTER TABLE devices ADD COLUMN bot_status TEXT;
      ALTER TABLE devices ADD COLUMN status_epoch TEXT;
      ALTER TABLE devices ADD COLUMN status_version INTEGER;
      ALTER TABLE devices ADD COLUMN reported_at INTEGER;
      ALTER TABLE tasks ADD COLUMN production_source TEXT;
      CREATE TABLE task_progress(task_id TEXT NOT NULL REFERENCES tasks(id),report_id TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,report_id));
      PRAGMA user_version=4;COMMIT;`)
  }
  const device = db.prepare('SELECT * FROM devices WHERE id=?')
  const byId = db.prepare('SELECT * FROM tasks WHERE id=?')
  const byRequest = db.prepare('SELECT * FROM tasks WHERE request_id=?')
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const requireDeviceTask = (deviceId, taskId) => {
    const row = byId.get(taskId)
    if (!row || row.device_id !== deviceId) throw new Error('Task not found for this device')
    return row
  }
  return {
    close: () => db.close(),
    registerDevice(id, ownerId, name) {
      id = nonempty(id, 'device id'); ownerId = nonempty(ownerId, 'owner id'); name = nonempty(name, 'device name')
      return transaction(() => {
        const old = device.get(id)
        if (old && old.owner_id !== ownerId) throw new Error('Device belongs to another owner')
        db.prepare('INSERT INTO devices(id,owner_id,name,last_seen) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen').run(id, ownerId, name, now())
        return device.get(id)
      })
    },
    reportDevice({ id, ownerId, name, mainBotId, sessionId, botName, status, epoch, version, register = false }) {
      id = nonempty(id, 'device id'); ownerId = nonempty(ownerId, 'owner id'); name = nonempty(name, 'device name')
      mainBotId = nonempty(mainBotId, 'main Bot id'); sessionId = nonempty(sessionId, 'Session id'); botName = nonempty(botName, 'Bot name', 200); epoch = nonempty(epoch, 'status epoch')
      if (!['idle','running','waiting','error'].includes(status) || !Number.isSafeInteger(version) || version < 1) throw new TypeError('Invalid Bot status report')
      return transaction(() => {
        const old = device.get(id)
        if (old && old.owner_id !== ownerId) throw new Error('Device belongs to another owner')
        if (old?.status_epoch && old.status_epoch !== epoch && !register) throw new Error('Register the current Bot runtime first')
        if (old?.status_epoch === epoch && old.status_version >= version) {
          if (old.status_version === version && old.main_bot_id === mainBotId && old.session_id === sessionId && old.bot_status === status && old.bot_name === botName) return old
          throw new Error('Stale or conflicting Bot status')
        }
        db.prepare(`INSERT INTO devices(id,owner_id,name,last_seen,main_bot_id,session_id,bot_name,bot_status,status_epoch,status_version,reported_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen,main_bot_id=excluded.main_bot_id,session_id=excluded.session_id,bot_name=excluded.bot_name,bot_status=excluded.bot_status,status_epoch=excluded.status_epoch,status_version=excluded.status_version,reported_at=excluded.reported_at`)
          .run(id,ownerId,name,now(),mainBotId,sessionId,botName,status,epoch,version,now())
        return device.get(id)
      })
    },
    devices() { return db.prepare('SELECT * FROM devices ORDER BY id').all() },
    device(id) { return device.get(nonempty(id, 'device id')) },
    tasks() { return db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all() },
    propose({ requestId, deviceId, issuerId, prompt, productionSource }) {
      requestId = nonempty(requestId, 'request id'); deviceId = nonempty(deviceId, 'device id'); issuerId = nonempty(issuerId, 'issuer id'); prompt = nonempty(prompt, 'prompt', 12000)
      const source = productionSource === undefined ? null : JSON.stringify(productionSource)
      return transaction(() => {
        const existing = byRequest.get(requestId)
        if (existing) {
          if (existing.device_id !== deviceId || existing.issuer_id !== issuerId || existing.prompt !== prompt || existing.production_source !== source) throw new Error('Request id conflicts with another proposal')
          return existing
        }
        if (!device.get(deviceId)) throw new Error('Unknown device')
        const id = randomUUID(); const time = now()
        db.prepare('INSERT INTO tasks(id,request_id,device_id,issuer_id,prompt,state,created_at,updated_at,production_source) VALUES(?,?,?,?,?,?,?,?,?)').run(id,requestId,deviceId,issuerId,prompt,'offered',time,time,source)
        return byId.get(id)
      })
    },
    task(id) { return byId.get(nonempty(id, 'task id')) },
    taskByRequest(id) { return byRequest.get(nonempty(id, 'request id')) },
    progress(id) { return db.prepare('SELECT value,created_at FROM task_progress WHERE task_id=? ORDER BY created_at,report_id').all(nonempty(id, 'task id')).map(row => ({ ...JSON.parse(row.value), reportedAt: new Date(row.created_at).toISOString(), verification: 'reported' })) },
    reportProgress(deviceId, taskId, claimId, reportId, value) {
      reportId = nonempty(reportId, 'progress report id'); const text = JSON.stringify(value)
      return transaction(() => {
        const task = requireDeviceTask(deviceId, taskId)
        if (task.state !== 'delivered' || task.claim_id !== claimId) throw new Error('Progress requires the delivered task claim')
        const old = db.prepare('SELECT value FROM task_progress WHERE task_id=? AND report_id=?').get(taskId,reportId)
        if (old) { if (old.value !== text) throw new Error('Conflicting progress report'); return }
        db.prepare('INSERT INTO task_progress VALUES(?,?,?,?)').run(taskId,reportId,text,now())
      })
    },
    tasksFor(deviceId) { return db.prepare('SELECT * FROM tasks WHERE device_id=? ORDER BY created_at,id').all(nonempty(deviceId, 'device id')) },
    recoverNotifications() {
      db.prepare("UPDATE tasks SET notification_state='unknown',updated_at=? WHERE notification_state='dispatching'").run(now())
      db.prepare("UPDATE tasks SET alert_state='unknown',updated_at=? WHERE alert_state='dispatching'").run(now())
    },
    claimAlert(deviceId) {
      return transaction(() => {
        const row = db.prepare("SELECT * FROM tasks WHERE device_id=? AND state='offered' AND alert_state IS NULL ORDER BY created_at,id LIMIT 1").get(deviceId)
        if (!row) return null
        db.prepare("UPDATE tasks SET alert_state='dispatching',updated_at=? WHERE id=?").run(now(),row.id)
        return byId.get(row.id)
      })
    },
    settleAlert(deviceId, id, state) {
      if (!['delivered','unknown','suppressed'].includes(state)) throw new TypeError('Invalid alert status')
      return transaction(() => {
        const row = requireDeviceTask(deviceId, id)
        if (row.alert_state !== 'dispatching') throw new Error('Alert was not claimed')
        db.prepare('UPDATE tasks SET alert_state=?,updated_at=? WHERE id=?').run(state,now(),id)
        return byId.get(id)
      })
    },
    claimNotification(issuerId) {
      return transaction(() => {
        const sql="SELECT * FROM tasks WHERE state IN ('completed','failed','unknown','declined') AND notification_state IS NULL";
        const row = issuerId === undefined ? db.prepare(sql+" ORDER BY updated_at,id LIMIT 1").get() : db.prepare(sql+" AND issuer_id=? ORDER BY updated_at,id LIMIT 1").get(issuerId)
        if (!row) return null
        db.prepare("UPDATE tasks SET notification_state='dispatching',updated_at=? WHERE id=?").run(now(),row.id)
        return byId.get(row.id)
      })
    },
    settleNotification(id, state) {
      if (!['delivered','unknown'].includes(state)) throw new TypeError('Invalid notification status')
      return transaction(() => {
        const row = byId.get(id)
        if (!row || row.notification_state !== 'dispatching') throw new Error('Notification was not claimed')
        db.prepare('UPDATE tasks SET notification_state=?,updated_at=? WHERE id=?').run(state,now(),id)
        return byId.get(id)
      })
    },
    decide(deviceId, taskId, accept, details = '') {
      if (typeof accept !== 'boolean') throw new TypeError('Invalid decision')
      if (typeof details !== 'string' || details.length > 4000) throw new TypeError('Invalid execution details')
      return transaction(() => {
        const row = requireDeviceTask(deviceId, taskId)
        const next = accept ? 'accepted' : 'declined'
        if (row.state === next) {
          if ((row.decision_note ?? '') !== details.trim()) throw new Error('Conflicting task decision')
          return row
        }
        if (row.state !== 'offered') throw new Error('Proposal already decided')
        db.prepare('UPDATE tasks SET state=?,decision_note=?,updated_at=? WHERE id=?').run(next,details.trim(),now(),taskId)
        return byId.get(taskId)
      })
    },
    claim(deviceId, { singleActive = false } = {}) {
      return transaction(() => {
        if (singleActive && db.prepare("SELECT id FROM tasks WHERE device_id=? AND state IN ('dispatching','delivered') LIMIT 1").get(deviceId)) return null
        const row = db.prepare("SELECT * FROM tasks WHERE device_id=? AND state='accepted' ORDER BY created_at,id LIMIT 1").get(deviceId)
        if (!row) return null
        const claim = randomUUID()
        db.prepare("UPDATE tasks SET state='dispatching',claim_id=?,updated_at=? WHERE id=?").run(claim,now(),row.id)
        return byId.get(row.id)
      })
    },
    settle(deviceId, taskId, claimId, state, value) {
      if (!['delivered','unknown','completed','failed'].includes(state)) throw new TypeError('Invalid task status')
      return transaction(() => {
        const row = requireDeviceTask(deviceId, taskId)
        if (row.claim_id !== claimId) throw new Error('Stale task claim')
        if (row.state === state) {
          const saved = state === 'delivered' ? row.session_id : row.result
          if (saved !== value) throw new Error('Conflicting task receipt')
          return row
        }
        if (!(row.state === 'dispatching' && ['delivered','unknown','failed'].includes(state)) && !(row.state === 'delivered' && ['completed','failed','unknown'].includes(state))) throw new Error('Invalid task transition')
        const field = state === 'delivered' ? 'session_id' : 'result'
        db.prepare(`UPDATE tasks SET state=?,${field}=?,updated_at=? WHERE id=?`).run(state,nonempty(value, 'receipt', 12000),now(),taskId)
        return byId.get(taskId)
      })
    },
  }
}
