import { expect, test } from '@playwright/test';

test('shows all three installed discovery connectors', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true }).click();
  const panel = page.getByTestId('discovery-panel');
  await expect(panel).toContainText('持续发现与扩库');
  await expect(panel.getByText('待接入入口', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '继续扩充红果短剧', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: '继续扩充番茄小说', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: '继续扩充七猫小说', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'artifacts/discovery-foundation-browser.png', fullPage: true });
});
