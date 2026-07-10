import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../../src/fixtures/fixtures';

// Accessibility smoke: axe scan on the critical pages, failing on serious/critical
// violations. WCAG is a citable oracle (unlike invented perf thresholds) — keep this
// in scope by default; scoping it out is a strategy decision to record.
// ADAPT-ME: list the app's critical pages once Kalchas's recon names them.

const CRITICAL_PAGES = ['/']; // ADAPT-ME: e.g. ['/', '/products', '/checkout']

for (const path of CRITICAL_PAGES) {
  test(`a11y smoke: ${path} has no serious/critical violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(
      serious,
      serious.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join('\n'),
    ).toEqual([]);
  });
}
