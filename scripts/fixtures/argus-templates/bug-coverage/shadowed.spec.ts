import { test as helperTest } from './helpers';
import { test as fakeFixtureTest } from './fixtures';

const test = (title: string, callback: () => void) => callback();
const it = test;

test('@regression @bug:BUG-9201 a local test helper is not Playwright provenance', () => {});
it('@regression @bug:BUG-9202 a local it helper is not Playwright provenance', () => {});
helperTest('@regression @bug:BUG-9203 an unapproved import is not fixture provenance', async () => {});
fakeFixtureTest('@regression @bug:BUG-9204 a fake local fixtures module is not canonical fixture provenance', async () => {});
