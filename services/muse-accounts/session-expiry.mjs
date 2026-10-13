const MAX_TIMEOUT_MS=2147483647;

/** Schedule an absolute session expiry without overflowing Node's timeout range.
 * @param {number} expiry Absolute expiry in milliseconds.
 * @param {Function} expire Operation to run once the clock reaches the expiry.
 * @param {object} options Clock and timer overrides.
 * @returns {Function} Cancellation operation.
 */
export function scheduleSessionExpiry(expiry,expire,{now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let timer;
 const arm=(callback,delay)=>{timer=setTimer(callback,delay);timer.unref?.();};
 const schedule=()=>{const remaining=expiry-now();if(remaining<=0){expire();return;}arm(schedule,Math.min(MAX_TIMEOUT_MS,remaining));};
 const remaining=expiry-now();arm(remaining<=0?expire:schedule,remaining<=0?0:Math.min(MAX_TIMEOUT_MS,remaining));return()=>clearTimer(timer);
}
