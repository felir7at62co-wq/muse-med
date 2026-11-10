/** Task guests detect only rendered sign-in or verification controls. */
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { DOUYIN_USER_ACTION_PROBE } from '../src/douyin-user-action.ts'

it('detects visible login controls while ignoring hidden or unrelated page content', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.abort())
    const cases = [
      ['phone', '<div class="douyin_login_new_class"><input type="tel"></div>', true],
      ['QR only', '<div class="douyin_login_new_class"><img aria-label="二维码" style="width:100px;height:100px"></div>', true],
      ['QR alt', '<div class="douyin_login_new_class"><img alt="二维码" style="width:100px;height:100px"></div>', true],
      ['hidden container', '<div class="douyin_login_new_class" style="display:none"><input type="tel"></div>', false],
      ['hidden QR', '<div class="douyin_login_new_class" style="width:100px;height:100px"><img aria-label="二维码" style="display:none;width:100px;height:100px"></div>', false],
      ['collapsed dialog', '<div role="dialog" class="login" style="visibility:collapse;width:100px;height:100px"></div>', false],
      ['multiple hidden dialogs', '<div role="dialog" class="login" style="visibility:hidden;width:100px;height:100px"></div><div role="dialog" class="login" style="visibility:hidden;width:100px;height:100px"></div>', false],
      ['multiple hidden phones', '<div class="douyin_login_new_class"><input type="tel" style="visibility:hidden"><input type="tel" style="visibility:hidden"></div>', false],
      ['visible phone overrides hidden login container', '<div class="douyin_login_new_class" style="visibility:hidden"><input type="tel" style="visibility:visible"></div>', true],
      ['visible login overrides hidden ancestor', '<div style="visibility:hidden"><div role="dialog" class="login-dialog" style="visibility:visible;width:100px;height:100px"></div></div>', true],
      ['transparent container', '<div class="douyin_login_new_class" style="opacity:0"><input type="tel"></div>', false],
      ['transparent ancestor', '<div style="opacity:0"><div class="douyin_login_new_class"><input type="tel"></div></div>', false],
      ['content-hidden ancestor', '<div style="content-visibility:hidden"><div class="douyin_login_new_class"><input type="tel"></div></div>', false],
      ['clipped phone ancestor', '<div style="width:0;height:0;overflow:hidden"><div class="douyin_login_new_class" style="width:100px;height:100px"><input type="tel"></div></div>', false],
      ['clipped QR ancestor', '<div style="width:0;height:0;overflow:hidden"><div class="douyin_login_new_class" style="width:100px;height:100px"><img aria-label="二维码" style="width:100px;height:100px"></div></div>', false],
      ['fixed dialog escapes ordinary clip', '<div style="width:0;height:0;overflow:hidden"><div class="douyin_login_new_class" style="position:fixed;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', true],
      ['absolute dialog escapes ordinary clip', '<div style="width:0;height:0;overflow:hidden"><div class="douyin_login_new_class" style="position:absolute;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', true],
      ['absolute dialog clipped by positioned containing block', '<div style="position:relative;width:0;height:0;overflow:hidden"><div class="douyin_login_new_class" style="position:absolute;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', false],
      ['fixed dialog clipped by transform containing block', '<div style="width:0;height:0;overflow:hidden;transform:translate(0)"><div class="douyin_login_new_class" style="position:fixed;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', false],
      ['fixed dialog clipped by individual translate', '<div style="width:0;height:0;overflow:hidden;translate:0px"><div class="douyin_login_new_class" style="position:fixed;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', false],
      ['fixed dialog clipped by will-change', '<div style="width:0;height:0;overflow:hidden;will-change:transform"><div class="douyin_login_new_class" style="position:fixed;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', false],
      ['fixed phone escapes ordinary clip', '<div class="douyin_login_new_class" style="width:100px;height:100px;overflow:hidden"><input type="tel" style="position:fixed;left:200px;top:10px"></div>', true],
      ['fixed dialog clipped by paint containment', '<div style="width:0;height:0;overflow:hidden;contain:paint"><div class="douyin_login_new_class" style="position:fixed;left:10px;top:10px;width:100px;height:100px"><input type="tel"></div></div>', false],
      ['partly clipped ancestor', '<div style="width:30px;height:30px;overflow:hidden"><div class="douyin_login_new_class" style="width:100px;height:100px"><input type="tel"></div></div>', true],
      ['zero dimensions', '<div class="douyin_login_new_class" style="width:0;height:0"><input type="tel"></div>', false],
      ['offscreen container', '<div class="douyin_login_new_class" style="position:fixed;left:-1000px;top:0;width:300px;height:200px"><input type="tel"></div>', false],
      ['offscreen phone', '<div class="douyin_login_new_class" style="width:300px;height:200px"><input type="tel" style="position:fixed;left:-1000px;top:0"></div>', false],
      ['offscreen QR', '<div class="douyin_login_new_class" style="width:300px;height:200px"><img aria-label="二维码" style="position:fixed;left:-1000px;top:0;width:100px;height:100px"></div>', false],
      ['partly visible dialog', '<div class="douyin_login_new_class" style="position:fixed;left:-30px;top:0;width:100px;height:100px"><input type="tel" style="width:100px"></div>', true],
      ['ordinary login', '<header><button>登录</button></header>', false],
      ['unrelated container', '<div class="douyin_login_new_class"><button>登录</button><img alt="logo" style="width:100px;height:100px"></div>', false],
      ['existing dialog', '<div role="dialog" class="login-dialog" style="width:100px;height:100px"></div>', true],
      ['existing challenge', '<div id="captcha_container" style="width:100px;height:100px"></div>', true],
    ] as const
    for (const [label, html, expected] of cases) {
      await page.setContent(html)
      expect.soft(await page.evaluate<boolean>(DOUYIN_USER_ACTION_PROBE), label).toBe(expected)
    }
  } finally {
    await browser.close()
  }
})
