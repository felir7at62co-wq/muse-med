// 移动端侧边栏抽屉行为验收：修复「点击汉堡后侧边栏空白」回归。
//
// 背景（v2.11.1 之后报障）：宿主按钮 aria-label 随界面语言切换 —— 中文「打开侧边栏」、
// 英文 "Open sidebar"（DSH 0.1.7 起按浏览器语言渲染 en）。插件若只按中文匹配展开按钮，
// 英文界面下会漏取：抽屉 (`body.dsh-drawer-open`) 滑出、但宿主侧边栏仍保持 collapsed，
// 会话列表不挂载 → 用户看到空侧边栏（「侧边栏点击后不显示了」）。
//
// 本套件断言真实行为而不依赖宿主语言：无论界面中英文，点击汉堡后都必须
//   1) 抽屉打开（body 带 dsh-drawer-open）且宿主侧边栏展开（root 不带 collapsed）；
//   2) 会话列表真实挂载（listArea 有子节点、有可见文本）；
//   3) 点击宿主「收起侧边栏」按钮后抽屉收起。
//
// 用法：node test/browser/mobile-sidebar-drawer.mjs（或由 run-all.mjs / verify:mobile-ui 调用）
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { launchOptions, shotsDir, connect } from './helpers.mjs';

const SHOTS = shotsDir('mobile-sidebar-drawer');
const CHROME = launchOptions().executablePath;
const { port: PORT, cookie: c, cookieName: cn } = connect();
const BASE_URL = `http://127.0.0.1:${PORT}`;

const out = [];
const say = (name, ok, detail) => {
  out.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

for (const vp of [{ name: '375x667', width: 375, height: 667 }, { name: '390x844', width: 390, height: 844 }]) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setCookie({ name: cn, value: c.slice(cn.length + 1), domain: '127.0.0.1', path: '/' });
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 5000));

  const lang = await page.evaluate(() => document.documentElement.lang || '');
  const headerReady = await page.evaluate(() => !!document.querySelector('.dsh-header-menu-btn'));
  say(`${vp.name} 顶栏汉堡按钮已注入 (lang=${lang})`, headerReady);

  // 点击汉堡：抽屉滑出 + 宿主侧边栏自动展开
  await page.evaluate(() => document.querySelector('.dsh-header-menu-btn')?.click());
  await new Promise((r) => setTimeout(r, 1000));

  const opened = await page.evaluate(() => {
    const body = document.body;
    const root = document.querySelector('div[class*="_sidebarCol"] div[class*="hHd-Xa_root"]');
    const listArea = document.querySelector('div[class*="_sidebarCol"] div[class*="listArea"]');
    return {
      drawerOpen: body.classList.contains('dsh-drawer-open'),
      sidebarRootCls: root ? String(root.className) : null,
      collapsed: root ? String(root.className).includes('collapsed') : null,
      listChildren: listArea ? listArea.children.length : -1,
      listText: listArea ? (listArea.innerText || '').trim().slice(0, 80) : '',
    };
  });
  say(`${vp.name} 抽屉已打开`, opened.drawerOpen);
  say(
    `${vp.name} 宿主侧边栏已展开（非 collapsed）`,
    opened.sidebarRootCls !== null && opened.collapsed === false,
    `root=${opened.sidebarRootCls}`,
  );
  say(
    `${vp.name} 会话列表已挂载且有内容`,
    opened.listChildren > 0 && opened.listText.length > 0,
    `children=${opened.listChildren} text=${JSON.stringify(opened.listText.slice(0, 40))}`,
  );

  // 顶栏标题与宿主当前会话同步（用户报障：0.1.7 后顶栏永远显示「新会话」，
  // 修复为读宿主会话层级面包屑）。点击列表里第一个非占位会话，顶栏应跟随其标题。
  const pickText = await page.evaluate(() => {
    const area = document.querySelector('div[class*="_sidebarCol"]');
    const items = [...area.querySelectorAll('[role="treeitem"]')];
    // 会话行（sessionRow），排除当前已选（selected）与占位「New Session」；
    // 行文本结构为 [可选状态行*] + 标题 + 时间 → 取「非状态、非子代理徽标、非时间」行作标题。
    const isStatusLine = (l) =>
      /^(Running|Idle|Stopped|进行中|空闲|已停止|subagent|子代理)$/i.test(l) ||
      /\d+\s*(subagent|子代理)|subagent|子代理/i.test(l) ||
      /^\d+\s*(min|h|d|h前|天前|分钟前|周前|个月前)$/i.test(l);
    const item = items.find((e) => {
      const cls = String(e.className);
      if (!/sessionRow/i.test(cls)) return false;
      if (/selected/i.test(cls)) return false;
      const lines = (e.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return false;
      const titleLine = lines.find((l) => !isStatusLine(l));
      return !!titleLine && !/^New Session$|^新会话$/.test(titleLine);
    });
    if (!item) return null;
    const lines = (item.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const title = lines.find((l) => !isStatusLine(l)).slice(0, 60);
    item.click();
    return title;
  });
  await new Promise((r) => setTimeout(r, 1800));
  const titleSync = await page.evaluate(() => {
    const t = document.querySelector('.dsh-mobile-header-title');
    return t ? t.innerText : '';
  });
  say(
    `${vp.name} 顶栏标题跟随当前会话（读宿主面包屑）`,
    pickText === null ? true : titleSync.length > 0 && titleSync === pickText,
    pickText === null ? '本视口无可选会话行，跳过（标题修复另由专测覆盖）' : `host=${JSON.stringify(pickText)} header=${JSON.stringify(titleSync)}`,
  );

  await page.screenshot({ path: path.join(SHOTS, `open-${vp.name.split('x')[0]}.png`) });

  // 点击宿主「收起侧边栏」按钮（中英文文案都试，宿主语言决定命中哪个）→ 抽屉应收起
  await page.evaluate(() => {
    const b = document.querySelector('button[aria-label*="收起侧边栏"], button[aria-label*="Collapse sidebar"], button[title*="收起侧边栏"], button[title*="Collapse sidebar"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const closed = await page.evaluate(() => document.body.classList.contains('dsh-drawer-open'));
  say(`${vp.name} 点击宿主收起按钮后抽屉收起`, closed === false);
  await page.close();
}

console.log(`\n==== 移动端侧边栏抽屉验收汇总：${out.filter((x) => x.ok).length}/${out.length} 通过 ====`);
const failed = out.filter((x) => !x.ok);
for (const f of failed) console.log(`FAIL  ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
await browser.close();
process.exitCode = failed.length ? 1 : 0;
