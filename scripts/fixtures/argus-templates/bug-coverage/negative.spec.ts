import { test } from '@playwright/test';

// test('comment declaration', { tag: '@bug:BUG-9001' }, async () => {});
/* test('block comment declaration', { tag: '@bug:BUG-9002' }, async () => {}); */

const stringDeclaration = "test('string declaration', { tag: '@bug:BUG-9003' }, async () => {})";
const templateDeclaration = `test('template declaration', { tag: '@bug:BUG-9004' }, async () => {})`;
void stringDeclaration;
void templateDeclaration;

test('comment inside details is ignored', {
  // tag: '@bug:BUG-9005',
  note: 'no provenance',
}, async () => {});

test('string inside details is ignored', {
  note: "tag: '@bug:BUG-9006'",
}, async () => {});

test('nested tag is ignored', {
  metadata: {
    tag: ['@bug:BUG-9007'],
  },
}, async () => {});

const variableDetails = { tag: ['@bug:BUG-9008'] };
test('variable details are ignored', variableDetails, async () => {});

test('unrelated metadata is ignored', {
  annotation: {
    type: 'tag',
    description: '@bug:BUG-9009',
  },
  metadata: '@bug:BUG-9010',
}, async () => {});
