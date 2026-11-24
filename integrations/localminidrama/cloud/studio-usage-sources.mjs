/** Read-only SQL projections for saved production operations and their linked resources. */

const sources=['native','tts','fal','libtv','libtv-cli'];
const normalized=expression=>`CASE ${expression} WHEN 'authorized' THEN 'authorized' WHEN 'reserved' THEN 'reserved' WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'preparation_failed' THEN 'failed' WHEN 'operator_confirmed' THEN 'operator-confirmed' WHEN 'operator-confirmed' THEN 'operator-confirmed' WHEN 'media_unverified' THEN 'awaiting-review' WHEN 'submission_incomplete' THEN 'awaiting-review' WHEN 'generating' THEN 'accepted' WHEN 'preparing' THEN 'accepted' WHEN 'sending' THEN 'accepted' WHEN 'submitted' THEN 'accepted' WHEN 'observing' THEN 'accepted' WHEN 'results_available' THEN 'accepted' WHEN 'accepted' THEN 'accepted' WHEN 'queued' THEN 'accepted' WHEN 'processing' THEN 'accepted' WHEN 'submitting' THEN 'accepted' WHEN 'assembling' THEN 'accepted' ELSE 'unknown' END`;

// Keep the same phase precedence as muse-postproduction.stateOf without initializing that service.
const falState=`CASE WHEN t.state='completed' THEN 'completed'
 WHEN EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.state='unknown') THEN 'unknown'
 WHEN t.state='media_unverified' AND t.error_code IS NOT NULL AND t.error_code<>'' THEN 'media_unverified'
 WHEN EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.state IN('pending','upload_failed')) THEN 'submission_incomplete'
 WHEN EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.state='media_unverified') THEN 'media_unverified'
 WHEN NOT EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.state<>'verified') THEN 'assembling'
 WHEN EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.state IN('uploading','submitting')) THEN 'submitting'
 WHEN EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.state='processing') THEN 'processing'
 ELSE 'queued' END`;
const falError="COALESCE(NULLIF(t.error_code,''),(SELECT s.error_code FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id AND s.error_code IS NOT NULL AND s.error_code<>'' ORDER BY s.segment_index LIMIT 1))";

/**
 * Select existing, supported metadata generations without installing or migrating them.
 * @param {object} db Read-only account SQLite connection.
 * @param {Function} fail Refuse corrupt or unsupported metadata without exposing database details.
 * @returns {object} SQL projections, installed source names and available budget/native records.
 */
export function studioUsageSources(db,fail){
 const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
 const operations=[],resources=[],covered=[];
 function installed(marker,tables,versions){
  const present=[marker,...tables].filter(name=>names.has(name));
  if(!present.length)return false;
  if(present.length!==tables.length+1)fail('studio_usage_corrupt');
  const rows=db.prepare(`SELECT version FROM ${marker}`).all();
  if(rows.length!==1||!versions.includes(rows[0].version))fail('studio_usage_unsupported_schema');
  return true;
 }
 const native=installed('muse_admission_schema',['muse_native_operations','muse_native_operation_resources','muse_native_supplier_usage'],[1]);
 const budget=installed('muse_budget_schema',['muse_budget_entries'],[1]);
 if(native){
  covered.push('native');
  operations.push("SELECT rowid AS sequence,'native' AS source,operation_id,kind,state AS raw_state,state,created_at,updated_at,http_status,error_code FROM muse_native_operations");
  resources.push("SELECT 'native' AS source,operation_id,kind,kind||':'||resource_id AS resource_id FROM muse_native_operation_resources");
 }
 const dedicated=[
  {source:'tts',marker:'muse_audio_schema',table:'muse_tts_generations',versions:[1,2],kind:"'tts'",updated:'COALESCE(completed_at,created_at)'},
  {source:'fal',marker:'muse_postproduction_schema',table:'muse_postproduction_tasks',extra:['muse_postproduction_segments'],versions:[1],kind:'kind',updated:'COALESCE(completed_at,created_at)'},
  {source:'libtv',marker:'muse_libtv_schema',table:'muse_libtv_tasks',extra:['muse_libtv_imports'],versions:[1,2,3],kind:'kind',updated:'updated_at'},
  {source:'libtv-cli',marker:'muse_libtv_cli_schema',table:'muse_libtv_cli_operations',extra:['muse_libtv_cli_imports'],versions:[1,2,3],kind:'service',updated:'updated_at'},
 ];
 for(const item of dedicated){
  const active=installed(item.marker,[item.table,...item.extra??[]],item.versions);
  if(active){
   covered.push(item.source);
   if(item.source==='fal'&&db.prepare('SELECT 1 FROM muse_postproduction_tasks t WHERE NOT EXISTS(SELECT 1 FROM muse_postproduction_segments s WHERE s.task_operation_id=t.operation_id) LIMIT 1').get())fail('studio_usage_corrupt');
   const raw=item.source==='fal'?falState:'t.state',error=item.source==='libtv-cli'?'NULL':item.source==='fal'?falError:'t.error_code';
   operations.push(`SELECT t.rowid AS sequence,'${item.source}' AS source,t.operation_id,${item.kind} AS kind,${raw} AS raw_state,${normalized(raw)} AS state,t.created_at,${item.updated} AS updated_at,NULL AS http_status,${error} AS error_code FROM ${item.table} t`);
   resources.push(`SELECT '${item.source}' AS source,operation_id,'task' AS kind,'${item.source}:'||operation_id AS resource_id FROM ${item.table}`);
   if(item.source==='tts')resources.push("SELECT 'tts' AS source,operation_id,'audio' AS kind,'tts:'||operation_id AS resource_id FROM muse_tts_generations WHERE state='completed'");
   if(item.source==='fal')resources.push("SELECT 'fal' AS source,operation_id,'video' AS kind,'video:'||generation_id AS resource_id FROM muse_postproduction_tasks WHERE state='completed' AND generation_id IS NOT NULL");
   if(item.source==='libtv')resources.push("SELECT 'libtv' AS source,task_id AS operation_id,COALESCE(json_extract(media_json,'$.native_kind'),t.kind) AS kind,COALESCE(json_extract(media_json,'$.native_kind'),t.kind)||':'||generation_id AS resource_id FROM muse_libtv_imports i JOIN muse_libtv_tasks t ON t.operation_id=i.task_id WHERE i.state='completed' AND i.generation_id IS NOT NULL");
   if(item.source==='libtv-cli')resources.push("SELECT 'libtv-cli' AS source,source_operation_id AS operation_id,kind,kind||':'||generation_id AS resource_id FROM muse_libtv_cli_imports");
  }
  if(budget){
   operations.push(`SELECT b.rowid AS sequence,'${item.source}' AS source,b.operation_id,'budget-reservation' AS kind,b.outcome AS raw_state,${normalized('b.outcome')} AS state,b.created_at,b.updated_at,NULL AS http_status,NULL AS error_code FROM muse_budget_entries b WHERE b.source='${item.source}'${active?` AND NOT EXISTS(SELECT 1 FROM ${item.table} t WHERE t.operation_id=b.operation_id)`:''}`);
   if(!active&&db.prepare('SELECT 1 FROM muse_budget_entries WHERE source=? LIMIT 1').get(item.source))covered.push(item.source);
  }
 }
 if(budget){
  const unknownSources=db.prepare(`SELECT 1 FROM muse_budget_entries WHERE source NOT IN (${sources.map(()=>'?').join(',')}) LIMIT 1`).get(...sources);
  if(unknownSources)fail('studio_usage_unsupported_schema');
  operations.push(`SELECT MIN(b.rowid) AS sequence,'native' AS source,COALESCE(b.parent_operation_id,b.operation_id) AS operation_id,'budget-reservation' AS kind,'missing-operation' AS raw_state,'unknown' AS state,MIN(b.created_at) AS created_at,MAX(b.updated_at) AS updated_at,NULL AS http_status,NULL AS error_code FROM muse_budget_entries b WHERE b.source='native'${native?' AND NOT EXISTS(SELECT 1 FROM muse_native_operations n WHERE n.operation_id=COALESCE(b.parent_operation_id,b.operation_id))':''} GROUP BY COALESCE(b.parent_operation_id,b.operation_id)`);
  if(!native&&db.prepare("SELECT 1 FROM muse_budget_entries WHERE source='native' LIMIT 1").get())covered.push('native');
 }
 return {native,budget,coveredSources:sources.filter(source=>covered.includes(source)),
  operationsSql:operations.length?operations.join(' UNION ALL '):null,
  resourcesSql:resources.length?resources.join(' UNION ALL '):"SELECT NULL AS source,NULL AS operation_id,NULL AS kind,NULL AS resource_id WHERE 0"};
}
