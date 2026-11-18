/** Authenticated tenant studio budget controls; no caller-supplied account selector is accepted. */
const budget=require('../services/museBudget');
function register(router,db,cfg){
 budget.installNative(db,cfg);
 const handle=fn=>(req,res)=>{try{if(Object.keys(req.query).some(key=>!['project_id','limit','before'].includes(key)))throw Object.assign(Error('budget_invalid_query'),{code:'budget_invalid_query',status:400});if(req.method!=='GET')budget.requireDatabase(db,cfg,req.body?.database_id);res.json({success:true,data:fn(req)});}catch(error){res.status(error.status??503).json({success:false,error:{code:error.code??'budget_unavailable',message:'预算操作未确认。请刷新预算与账目；未知结果的预占不会自动释放。'}});}};
 router.get('/muse/budget/catalog',handle(()=>budget.catalog(db,cfg)));
 router.put('/muse/budget/catalog/:id',handle(req=>{if(req.body?.id!==req.params.id)throw Object.assign(Error('budget_invalid_price'),{code:'budget_invalid_price',status:400});return budget.savePrice(db,cfg,req.body);}));
 router.get('/muse/budget/projects/:id',handle(req=>budget.readProject(db,cfg,req.params.id)));
 router.put('/muse/budget/projects/:id',handle(req=>budget.updateProject(db,cfg,req.params.id,req.body??{})));
 router.get('/muse/budget/projects/:id/entries',handle(req=>budget.ledger(db,cfg,req.params.id,req.query)));
 router.post('/muse/budget/quote',handle(req=>budget.quote(db,cfg,req.body??{})));
 router.post('/muse/budget/entries/:id/reconcile',handle(req=>budget.reconcile(db,cfg,req.params.id,req.body??{})));
}
module.exports={register};
