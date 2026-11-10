/** Detect rendered Douyin sign-in and verification controls in a task guest. */
export const DOUYIN_USER_ACTION_PROBE = `(() => {
  const visible = (element,ignoreSelfVisibility=false) => { const box=element.getBoundingClientRect();
    if(box.width<=0||box.height<=0)return false;
    let left=Math.max(box.left,0),right=Math.min(box.right,window.innerWidth),top=Math.max(box.top,0),bottom=Math.min(box.bottom,window.innerHeight),positioned='';
    for(let current=element;current;current=current.parentElement){const style=getComputedStyle(current);
      if((current===element&&!ignoreSelfVisibility&&style.visibility!=='visible')||style.display==='none'||style.opacity==='0'||style.contentVisibility==='hidden')return false;
      const createsFixedBlock=[style.transform,style.translate,style.rotate,style.scale,style.perspective,style.filter,style.backdropFilter].some(value=>value&&value!=='none')
        || style.transformStyle==='preserve-3d'
        || /(^|\\s)(layout|paint|strict|content)(\\s|$)/.test(style.contain)
        || style.contentVisibility==='auto'
        || /(^|[ ,])(transform|translate|rotate|scale|transform-style|perspective|filter|backdrop-filter|contain)([ ,]|$)/.test(style.willChange);
      if(positioned&&(createsFixedBlock||(positioned==='absolute'&&style.position&&style.position!=='static')))positioned='';
      if(current!==element&&!positioned){const parentBox=current.getBoundingClientRect();
        if(['hidden','clip','scroll','auto'].includes(style.overflowX||style.overflow)){left=Math.max(left,parentBox.left);right=Math.min(right,parentBox.right);}
        if(['hidden','clip','scroll','auto'].includes(style.overflowY||style.overflow)){top=Math.max(top,parentBox.top);bottom=Math.min(bottom,parentBox.bottom);}}
      if(style.position==='fixed'||style.position==='absolute')positioned=style.position;}
    return right>left&&bottom>top; };
  const selectors=['[data-e2e="login-modal"]','[data-e2e="login-dialog"]','#captcha_container','.captcha_verify_container',
    '[role="dialog"][class*="login"]','[role="dialog"][class*="verify"]','[role="dialog"][class*="captcha"]'];
  return selectors.some(selector=>Array.from(document.querySelectorAll(selector)).some(element=>visible(element)))
    || Array.from(document.querySelectorAll('.douyin_login_new_class')).some(dialog => visible(dialog,true)
      && Array.from(dialog.querySelectorAll('input[type="tel"], img[aria-label="二维码"], img[alt="二维码"]')).some(element=>visible(element)));
})()`
