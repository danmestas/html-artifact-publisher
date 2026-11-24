import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readPaging, readLayout, pageRange, pageNumbers, pageForSize, validJump,
  listContext, resetPage, restoreListPage,
} from '../public/library-paging.js';

const params = value => new URLSearchParams(value);

test('numbered paging accepts whole positive pages and only the supported page sizes', () => {
  assert.deepEqual(readPaging(params('')), { page: 1, pageSize: 25 });
  for (const size of [10, 25, 50, 100]) assert.deepEqual(readPaging(params(`page=19&pageSize=${size}`)), { page: 19, pageSize: size });
  for (const bad of ['0', '-1', '1.5', '2cats', 'Infinity', '9007199254740992', '']) {
    assert.equal(readPaging(params(`page=${bad}`)).page, 1, bad);
  }
  for (const bad of ['12', '0', '25cats', '25.0', '1000']) assert.equal(readPaging(params(`pageSize=${bad}`)).pageSize, 25, bad);
  assert.equal(readPaging(params('n=480')).page, 1, 'old accumulation links do not become page numbers');
});

test('explicit page URLs open List without overriding an explicit layout or saved preference', () => {
  assert.equal(readLayout(params(''), 'grid'), 'grid');
  assert.equal(readLayout(params('page=3'), 'grid'), 'list');
  assert.equal(readLayout(params('pageSize=50'), 'grid'), 'list');
  assert.equal(readLayout(params('page=3&layout=grid'), 'list'), 'grid');
  assert.equal(readLayout(params('layout=list&n=24'), 'grid'), 'list');
  assert.equal(readLayout(params('n=24'), 'grid'), 'grid');
});

test('confirmed ranges clamp the final page, including empty and partial last pages', () => {
  assert.deepEqual(pageRange(8, 25, 187), { page: 8, pages: 8, first: 176, last: 187, total: 187 });
  assert.deepEqual(pageRange(99, 25, 13), { page: 1, pages: 1, first: 1, last: 13, total: 13 });
  assert.deepEqual(pageRange(99, 25, 0), { page: 1, pages: 1, first: 0, last: 0, total: 0 });
  assert.deepEqual(pageRange(2, 10, 20), { page: 2, pages: 2, first: 11, last: 20, total: 20 });
});

test('numbered links show edges and the current neighborhood with gaps only where needed', () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageNumbers(1, 20), [1, 2, 3, 'ellipsis', 20]);
  assert.deepEqual(pageNumbers(10, 20), [1, 'ellipsis', 9, 10, 11, 'ellipsis', 20]);
  assert.deepEqual(pageNumbers(20, 20), [1, 'ellipsis', 18, 19, 20]);
  assert.deepEqual(pageNumbers(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test('changing page size keeps the old first record in the new page', () => {
  assert.equal(pageForSize(8, 25, 50), 4);
  assert.equal(pageForSize(4, 50, 10), 16);
  assert.equal(pageForSize(1, 100, 25), 1);
});

test('jump input accepts only whole numbers within the confirmed range', () => {
  assert.equal(validJump('8', 8), 8);
  assert.equal(validJump(' 2 ', 8), 2);
  for (const bad of ['0', '9', '-1', '2.5', '2cats', '1e0', '']) assert.equal(validJump(bad, 8), null, bad);
});

const context = { view: 'all', q: 'river', sort: 'relevance', ownerId: '', status: 'all', expiry: 'all' };
test('query, scope, filters and ordering define List context; changing them resets paging', () => {
  const state = { ...context, page: 7, pageSize: 50, n: 36 };
  assert.deepEqual(resetPage(state), { ...state, page: 1 });
  assert.equal(listContext({ ...state, page: 2, n: 12 }), listContext(state));
  const saved = { context: listContext(state), page: 7, pageSize: 50 };
  assert.deepEqual(restoreListPage({ ...state, page: 1, pageSize: 25 }, saved), { page: 7, pageSize: 50 });
  for (const [key, value] of [['q', 'brook'], ['view', 'mine'], ['sort', 'name'], ['ownerId', 'someone'], ['status', 'archived'], ['expiry', 'soon']]) {
    const changed = { ...state, [key]: value };
    assert.notEqual(listContext(changed), listContext(state));
    assert.deepEqual(restoreListPage(changed, saved), { page: 1, pageSize: 50 });
  }
});
