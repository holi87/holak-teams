import { test as regression } from '../../src/fixtures/fixtures';

regression('aliased custom fixture provenance is recognized', {
  tag: ['@regression', '@bug:BUG-0004'],
}, async () => {});
