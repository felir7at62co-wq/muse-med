import type { Page } from '@playwright/test';
import { PAGE_BOOTSTRAP_ELEMENT, type PageBootstrap } from '../../src/shared/types';

const EMBEDDED = new RegExp(`<script type="application/json" id="${PAGE_BOOTSTRAP_ELEMENT}">.*?</script>`, 's');

/**
 * Serves the built page with the test's own first-screen data, or none, instead of what the preview server embedded.
 * Tests that mock the API decide the account and boards themselves, so the preview server's own account must not reach the page.
 * @param page Browser page.
 * @param options `embed` returns data to embed at each page load; `edit` changes the page HTML.
 */
export async function servePage(page: Page, options: { embed?: () => PageBootstrap; edit?: (html: string) => string } = {}): Promise<void> {
  await page.route(url => url.pathname === '/', async route => {
    const response = await route.fetch();
    let html = (await response.text()).replace(EMBEDDED, '');
    if (options.embed) html = html.replace('</body>', `<script type="application/json" id="${PAGE_BOOTSTRAP_ELEMENT}">${JSON.stringify(options.embed()).replace(/</g, '\\u003c')}</script></body>`);
    if (options.edit) html = options.edit(html);
    await route.fulfill({ status: response.status(), contentType: 'text/html; charset=utf-8', body: html });
  });
}
