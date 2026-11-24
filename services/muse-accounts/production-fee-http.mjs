/** Account-only fee metadata reads; HTTP callers cannot enroll issuers or approve spending. */
/** Serve authenticated metadata without exposing an enrollment or decision write endpoint.
 * @param {object} req Account gateway request.
 * @param {object} res Gateway response.
 * @param {object} options Verified session, fee authority and bounded response dependencies.
 * @returns {Promise<boolean>} Whether this namespace handled the request.
 */
export async function productionFeeRoute(req,res,{path,session,fees,rate,reply}){
 if(!path.startsWith('/api/muse/production-fees/'))return false;
 const json=(status,value,headers={})=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8',...headers});
 if(req.method!=='GET'){json(405,{code:'production_fee_read_only'},{allow:'GET'});return true;}
 if(!rate()){json(429,{code:'production_fee_rate_limited'});return true;}
 if(!fees){json(503,{code:'production_fee_unavailable'});return true;}
 const match=/^\/api\/muse\/production-fees\/(issuers|challenges)\/([A-Za-z0-9_-]+)$/.exec(path);
 if(!match){json(404,{code:'production_fee_not_found'});return true;}
 try{json(200,match[1]==='issuers'?fees.issuerState(session.id,match[2]):fees.challenge(session.id,match[2]));}
 catch(error){const known=typeof error.code==='string'&&/^production_fee_[a-z_]+$/.test(error.code);json(known?error.status??409:503,{code:known?error.code:'production_fee_unavailable'});}
 return true;
}
