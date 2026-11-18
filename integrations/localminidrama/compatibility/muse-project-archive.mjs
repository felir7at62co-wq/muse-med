/** Install native project checkpoint endpoints and restored generation-input reads. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
/**
 * Add project-owned archive modules without touching existing project or history rows.
 * @param root Pinned native checkout.
 * @param readSource Current source after preceding compatibility planners.
 * @returns Module, route and restored-input source writes.
 */
export function planMuseProjectArchive(root,readSource=path=>readFileSync(path,'utf8')){
 const pending=[];
 for(const[name,target]of [['muse-project-archive.cjs','services/museProjectArchive.js'],['muse-project-archive-content.cjs','services/museProjectArchiveContent.js'],['muse-project-archive-files.cjs','services/museProjectArchiveFiles.js'],['muse-project-archive-restore.cjs','services/museProjectArchiveRestore.js'],['muse-project-archive-routes.cjs','routes/museProjectArchiveRoutes.js']]){const path=resolve(root,'backend-node/src',target);if(existsSync(path))throw Error('Project archive module already installed: '+target);pending.push([path,readFileSync(new URL('../extensions/'+name,import.meta.url),'utf8').replaceAll('\r\n','\n')]);}
 const routes=resolve(root,'backend-node/src/routes/index.js'),source=readSource(routes),anchor="  require('./museStudioRoutes').register(r, db, cfg);";
 if(source.split(anchor).length!==2)throw Error('Project archive route anchor changed');pending.push([routes,source.replace(anchor,anchor+"\n  require('./museProjectArchiveRoutes').register(r, db, cfg);")]);
 const studio=resolve(root,'backend-node/src/services/museStudio.js'),studioSource=readSource(studio),entry='function generationInputs(db,cfg,kind,row){';
 if(studioSource.split(entry).length!==2)throw Error('Project archive history anchor changed');pending.push([studio,studioSource.replace(entry,entry+"\n const archived=require('./museProjectArchive').generationInputs(db,kind,row);if(archived)return archived;")]);return pending;
}
