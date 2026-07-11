import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('@regression @bug:ATA-001 origin alias selection sentinel', async () => {
  const marker = process.env.ARGUS_SELECTION_MARKER;
  const mode = process.env.ARGUS_SELECTION_EXPECT;
  if (!marker || !mode) throw new Error('selection smoke environment is missing');
  appendFileSync(marker, `${mode}\n`);

  if (mode === 'defect-evidence') {
    const events = process.env.ARGUS_OUTCOME_FILE;
    if (!events) throw new Error('defect-evidence smoke requires ARGUS_OUTCOME_FILE');
    appendFileSync(events, 'origin.selection\tproduct\tfail\ttrue\treproduced\tBUG-0001\texpected-red\n');
    expect('faulty-target').toBe('fixed-target');
  } else {
    expect(mode).toBe('candidate-regression');
  }
});
