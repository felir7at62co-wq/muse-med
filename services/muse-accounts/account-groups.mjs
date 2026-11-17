/** Validated informational groups assigned by Muse administrators. */
import {createHash} from 'node:crypto';
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(value);

/** Validate informational Muse groups independently of account authorization.
 * @param {unknown} value Assigned groups from a durable record or administrator submission.
 * @returns {Array<object>} Fresh group records with stable IDs derived from their normalized names.
 */
export function accountGroups(value){
 if(!Array.isArray(value)||value.length>20)throw Error('Invalid account groups');
 const groups=value.map(group=>{
  if(!group||!text(group.name,80)||typeof group.description!=='string'||group.description.length>500||/[\x00-\x1f\x7f-\x9f]/.test(group.description))throw Error('Invalid account group');
  const name=group.name.normalize('NFKC').trim(),id='group-'+createHash('sha256').update(name).digest('hex').slice(0,16);
  if(group.id!==undefined&&group.id!==id)throw Error('Invalid account group ID');
  return {id,name,description:group.description.trim()};
 });
 if(new Set(groups.map(group=>group.id)).size!==groups.length)throw Error('Duplicate account group');
 return groups;
}
