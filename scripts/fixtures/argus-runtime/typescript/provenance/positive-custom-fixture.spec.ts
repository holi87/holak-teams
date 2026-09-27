import { test as regression } from '../../../src/fixtures/fixtures';

regression('aliased custom fixture provenance is recognized', {
  tag: ['@regression', '@bug:ATA-004'],
}, async () => {});
