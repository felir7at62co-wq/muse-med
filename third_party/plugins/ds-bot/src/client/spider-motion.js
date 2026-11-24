// Muse: how the Muse spider moves when it is drawn in parts (the `rig` of muse-spider.js):
// a mark with data-rig, which is the avatar of a Bot's details page and a Main Bot's tile.
// The torso carries the eyes, and each leg turns about the point where it meets the body.
// Everything is a CSS transform chosen by the mark's data-state, and every loop starts and
// ends on the drawing at rest. A small mark keeps the whole drawing and moves as one piece.
//
// `--out` is the way a leg swings away from the body (1 clockwise, -1 the other way) and
// `--n` staggers the legs, so they never move together.
export const SPIDER_MOTION_CSS = `
.bt-mark[data-rig] .bt-torso{transform-origin:50px 77px}
.bt-mark[data-rig] .bt-leg{--out:1;--n:0}
.bt-mark[data-rig] .bt-leg[data-leg=far-lower]{--n:1}
.bt-mark[data-rig] .bt-leg[data-leg=near-left]{--n:2}
.bt-mark[data-rig] .bt-leg[data-leg=near-middle]{--out:-1;--n:3}
.bt-mark[data-rig] .bt-leg[data-leg=near-right]{--out:-1;--n:4}
.bt-mark[data-rig] .bt-leg[data-leg=far-right]{--out:-1;--n:5}
@keyframes bt-sp-breathe{0%,100%{transform:none}50%{transform:translateY(-.8px) scale(1.012,1.022)}}
@keyframes bt-sp-drift{0%,100%{transform:none}50%{transform:rotate(calc(var(--out) * 1.8deg))}}
@keyframes bt-sp-tap{0%,72%,100%{transform:none}78%{transform:translateY(-2.4px) rotate(calc(var(--out) * 7deg))}84%{transform:none}89%{transform:translateY(-1.5px) rotate(calc(var(--out) * 4deg))}94%{transform:none}}
@keyframes bt-sp-shuffle{0%,84%,100%{transform:none}89%{transform:translateY(-1.6px) rotate(calc(var(--out) * -5deg))}94%{transform:rotate(calc(var(--out) * 2deg))}}
@keyframes bt-sp-think-tap{0%,36%,66%,100%{transform:none}42%,54%{transform:translateY(-2.2px) rotate(calc(var(--out) * 8deg))}48%,60%{transform:none}}
@keyframes bt-sp-type{0%,44%,100%{transform:none}20%{transform:translateY(-2.8px) rotate(calc(var(--out) * 6deg))}}
@keyframes bt-sp-paddle{0%,100%{transform:none}50%{transform:rotate(calc(var(--out) * 4deg))}}
@keyframes bt-sp-bob{0%,100%{transform:none}25%{transform:translateY(-.7px) rotate(-.9deg)}75%{transform:translateY(.5px) rotate(.9deg)}}
@keyframes bt-sp-hop{0%,100%{transform:none}28%{transform:translateY(-11%) scale(.97,1.04)}58%{transform:translateY(0) scale(1.05,.95)}78%{transform:scale(.99,1.012)}}
@keyframes bt-sp-tuck{0%,100%{transform:none}28%{transform:translateY(-1px) rotate(calc(var(--out) * -7deg))}58%{transform:rotate(calc(var(--out) * 5deg))}}
@keyframes bt-sp-wave{0%,74%,100%{transform:none}14%,38%,62%{transform:translateY(-1.5px) rotate(calc(var(--out) * 48deg))}26%,50%{transform:translateY(-1.5px) rotate(calc(var(--out) * 34deg))}}
@keyframes bt-sp-sit{0%,100%{transform:none}14%,86%{transform:translateY(1.5px) scale(1.02,.975)}34%{transform:translateY(1.5px) scale(1.02,.975) rotate(-1.7deg)}66%{transform:translateY(1.5px) scale(1.02,.975) rotate(1.7deg)}}
@keyframes bt-sp-fold{0%,100%{transform:none}14%,86%{transform:translateY(-.6px) rotate(calc(var(--out) * -5deg))}}
@keyframes bt-sp-wait-eyes{0%,16%,84%,100%{transform:none}30%,42%{transform:translateX(-10%)}58%,70%{transform:translateX(10%)}}
@keyframes bt-sp-finish{0%,100%{transform:none}16%{transform:scale(1.05,.94)}40%{transform:translateY(-10%) scale(.98,1.04)}70%{transform:scale(1.04,.955)}88%{transform:scale(.99,1.012)}}
@keyframes bt-sp-spread{0%,100%{transform:none}16%{transform:rotate(calc(var(--out) * -5deg))}40%{transform:translateY(-1px) rotate(calc(var(--out) * 15deg))}70%{transform:rotate(calc(var(--out) * -4deg))}88%{transform:rotate(calc(var(--out) * 1.5deg))}}
@keyframes bt-sp-finish-open{0%,18%,74%,100%{opacity:1}28%,63%{opacity:0}}
@keyframes bt-sp-finish-smile{0%,18%,74%,100%{opacity:0}28%,63%{opacity:1}}
@keyframes bt-sp-think-body{0%,100%{transform:none}36%,65%{transform:translate(1%,-1.5%) rotate(-7deg) scale(.98,1.04)}}
@keyframes bt-sp-think-eyes{0%,100%{transform:none}24%,69%{transform:translate(12%,-6%) scaleY(.93)}}
@keyframes bt-sp-attend-eyes{0%{transform:translate(10%,-5%) scaleY(.93)}70%,100%{transform:scale(1.04)}}
@keyframes bt-sp-wiggle{0%,100%{transform:none}50%{transform:rotate(calc(var(--out) * 6deg))}}
/* At rest: the torso breathes, the far legs drift with it, and now and then a near leg taps
   or shifts. A Bot animation of Quiet leaves the spider still at rest. */
body:not([data-bt-motion=quiet]) .bt-mark[data-rig][data-state=idle] .bt-torso{animation:bt-sp-breathe 4.4s ease-in-out var(--bt-delay,0s) infinite}
body:not([data-bt-motion=quiet]) .bt-mark[data-rig][data-state=idle] .bt-leg:not([data-leg^=near]){animation:bt-sp-drift 4.4s ease-in-out calc(var(--bt-delay,0s) - var(--n) * .7s) infinite}
body:not([data-bt-motion=quiet]) .bt-mark[data-rig][data-state=idle] .bt-leg[data-leg=near-middle]{animation:bt-sp-tap 7.5s ease-in-out var(--bt-delay,0s) infinite}
body:not([data-bt-motion=quiet]) .bt-mark[data-rig][data-state=idle] .bt-leg:is([data-leg=near-left],[data-leg=near-right]){animation:bt-sp-shuffle 11s ease-in-out calc(var(--bt-delay,0s) - var(--n) * 1.9s) infinite}
body:not([data-bt-motion=quiet]) .bt-mark[data-rig][data-live][data-state=idle] .bt-eye{animation:bt-blink-idle 5s linear var(--bt-delay,0s) infinite}
/* Thinking: the figure leans and looks up, and a front leg taps while it does. */
.bt-mark[data-rig][data-state=thinking] .bt-b{animation:bt-sp-think-body 2.8s ease-in-out infinite}
.bt-mark[data-rig][data-state=thinking] .bt-eyes{animation:bt-sp-think-eyes 2.8s ease-in-out infinite}
.bt-mark[data-rig][data-state=thinking] .bt-leg[data-leg=near-right]{animation:bt-sp-think-tap 2.8s ease-in-out infinite}
/* Working, and the kinds of work a tile tells apart: the near legs type one after another,
   the far legs paddle, the torso bobs. */
.bt-mark[data-rig]:is([data-state=working],[data-state=searching],[data-state=sending],[data-state=orbit]) .bt-b{animation:none}
.bt-mark[data-rig]:is([data-state=working],[data-state=searching],[data-state=sending],[data-state=orbit]) .bt-torso{animation:bt-sp-bob 1.56s ease-in-out infinite}
.bt-mark[data-rig]:is([data-state=working],[data-state=searching],[data-state=sending],[data-state=orbit]) .bt-leg[data-leg^=near]{animation:bt-sp-type .78s ease-in-out calc(var(--n) * -.26s) infinite}
.bt-mark[data-rig]:is([data-state=working],[data-state=searching],[data-state=sending],[data-state=orbit]) .bt-leg:not([data-leg^=near]){animation:bt-sp-paddle 1.56s ease-in-out calc(var(--n) * -.5s) infinite}
.bt-mark[data-rig][data-state=working] .bt-eye{animation-duration:3.8s}
/* A question for you: one hop, then a front leg lifts and waves, the eyes on you. */
.bt-mark[data-rig][data-state=alert] .bt-b{animation:bt-sp-hop .9s cubic-bezier(.3,.7,.4,1) 1}
.bt-mark[data-rig][data-state=alert] .bt-leg{animation:bt-sp-tuck .9s ease-out calc(var(--n) * .02s) 1}
.bt-mark[data-rig][data-state=alert] .bt-leg[data-leg=near-right]{animation:bt-sp-tuck .9s ease-out 1,bt-sp-wave 3s ease-in-out .9s infinite}
.bt-mark[data-rig][data-state=alert] .bt-eyes{animation:bt-sp-attend-eyes .44s ease-out both}
.bt-mark[data-rig][data-state=alert] .bt-eye{animation:none}
/* Waiting for a teammate: it sits a little lower with its legs drawn in, sways and looks about. */
.bt-mark[data-rig][data-state=waiting] .bt-b{animation:none}
.bt-mark[data-rig][data-state=waiting] .bt-torso{animation:bt-sp-sit 6.4s ease-in-out infinite}
.bt-mark[data-rig][data-state=waiting] .bt-leg{animation:bt-sp-fold 6.4s ease-in-out infinite}
.bt-mark[data-rig][data-state=waiting] .bt-eyes{animation:bt-sp-wait-eyes 6.4s ease-in-out infinite}
/* Done: a jump with the legs spread, a soft landing, and the happy eyes. */
.bt-mark[data-rig][data-state=done] .bt-b{animation:bt-sp-finish .9s ease-out 1}
.bt-mark[data-rig][data-state=done] .bt-leg{animation:bt-sp-spread .9s ease-out calc(var(--n) * .015s) 1}
.bt-mark[data-rig][data-state=done] .bt-eye{animation:bt-sp-finish-open .9s linear 1}
.bt-mark[data-rig][data-state=done] .bt-eye-happy{animation:bt-sp-finish-smile .9s linear 1}
/* Petting and a poke keep the whole figure's response; the legs join in. */
body:not([data-bt-motion=quiet]) :is(.bt-row,.bt-tile)>:is(.bt-mark,.bt-cluster):hover .bt-mark[data-rig][data-live]:is([data-state=idle],[data-state=alert]):not(.bt-mark-poke) .bt-leg{animation:bt-sp-wiggle .52s ease-in-out calc(var(--n) * -.09s) infinite}
body:not([data-bt-motion=quiet]) .bt-mark-poke[data-rig] .bt-leg{animation:bt-sp-spread .8s ease-out 1}
/* Reduced interface motion holds the drawing still and only blinks; off, and the system's
   own setting (the base sheet), stop the blink too. */
body[data-bt-effects=reduced] .bt-mark[data-rig] :is(.bt-b,.bt-torso,.bt-leg,.bt-eyes,.bt-eye-happy){animation:none!important}
body[data-bt-effects=reduced] .bt-mark[data-rig][data-live] .bt-eye{animation:bt-blink-idle 6s linear var(--bt-delay,0s) infinite!important}
body[data-bt-effects=off] .bt-mark[data-rig] *{animation:none!important;transition:none!important}
`
