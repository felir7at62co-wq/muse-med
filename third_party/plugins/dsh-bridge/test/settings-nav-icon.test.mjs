// 回归测试：设置页左侧导航栏图标定制 (替换默认小齿轮)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETTINGS_NAV_MARKER,
  getNavIconCss,
  registerSettingsNavIcon,
} from '../client/settings-nav-icon.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
const unescapedBundle = bundle.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);

test('getNavIconCss 生成正确的遮罩与样式规则', () => {
  const css = getNavIconCss();
  assert.match(css, new RegExp(SETTINGS_NAV_MARKER));
  assert.match(css, /display:\s*none\s*!important/);
  assert.match(css, /background-color:\s*currentColor/);
  assert.match(css, /mask:\s*url\("data:image\/svg\+xml/);
});

test('registerSettingsNavIcon 正确标记「远程访问」行并支持安全销毁', () => {
  const previousDocument = global.document;

  const headChildren = [];
  const styleElements = [];
  const buttons = [
    { textContent: ' 通用设置 ', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; } },
    { textContent: '远程访问', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; } },
    { textContent: '模型服务', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; } },
  ];

  global.document = {
    getElementById(id) {
      return styleElements.find((s) => s.id === id) || null;
    },
    createElement(tag) {
      const el = {
        tagName: tag,
        id: '',
        dataset: {},
        textContent: '',
        remove() {
          const idx = styleElements.indexOf(this);
          if (idx !== -1) styleElements.splice(idx, 1);
        },
      };
      if (tag === 'style') styleElements.push(el);
      return el;
    },
    head: {
      appendChild(node) {
        headChildren.push(node);
      },
    },
    querySelectorAll(selector) {
      if (selector.includes('nav button')) {
        return buttons;
      }
      if (selector.includes(SETTINGS_NAV_MARKER)) {
        return buttons.filter((b) => SETTINGS_NAV_MARKER in b.attrs);
      }
      return [];
    },
  };

  try {
    const cleanup = registerSettingsNavIcon(() => '远程访问');

    // 验证 style 标签是否注入
    assert.equal(styleElements.length, 1);
    assert.equal(styleElements[0].id, 'dsh-bridge-settings-nav-icon-style');

    // 验证按钮标记状态
    assert.equal(SETTINGS_NAV_MARKER in buttons[0].attrs, false, '通用设置不应被标记');
    assert.equal(SETTINGS_NAV_MARKER in buttons[1].attrs, true, '远程访问必须被标记专属属性');
    assert.equal(SETTINGS_NAV_MARKER in buttons[2].attrs, false, '模型服务不应被标记');

    // 验证清理函数
    cleanup();
    assert.equal(SETTINGS_NAV_MARKER in buttons[1].attrs, false, '清理后属性必须移除');
    assert.equal(styleElements.length, 0, '清理后 style 标签必须移除');
  } finally {
    global.document = previousDocument;
  }
});

test('client/client.js 必须同步包含专属图标与标记', () => {
  assert.match(unescapedBundle, new RegExp(SETTINGS_NAV_MARKER));
  assert.match(unescapedBundle, /dsh-bridge-settings-nav-icon-style/);
});
