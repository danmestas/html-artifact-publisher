export const PAGE_SIZES = [10, 25, 50, 100];
const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function readPaging(params) {
  const size = positiveInteger(params.get('pageSize'));
  return { page: positiveInteger(params.get('page')) || 1, pageSize: PAGE_SIZES.includes(size) ? size : 25 };
}

export function readLayout(params, preference) {
  if (['grid', 'list'].includes(params.get('layout'))) return params.get('layout');
  if (params.has('page') || params.has('pageSize')) return 'list';
  return preference === 'grid' ? 'grid' : 'list';
}

export function pageRange(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { page: current, pages, first: total ? (current - 1) * pageSize + 1 : 0, last: Math.min(current * pageSize, total), total };
}

export function pageNumbers(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const start = Math.max(2, Math.min(page - 1, pages - 2));
  const end = Math.min(pages - 1, Math.max(page + 1, 3));
  const numbers = [1];
  if (start > 3) numbers.push('ellipsis');
  else if (start === 3) numbers.push(2);
  for (let n = start; n <= end; n++) numbers.push(n);
  if (end < pages - 2) numbers.push('ellipsis');
  else if (end === pages - 2) numbers.push(pages - 1);
  numbers.push(pages);
  return numbers;
}

export function pageForSize(page, oldSize, newSize) {
  return Math.floor((page - 1) * oldSize / newSize) + 1;
}

export function validJump(value, pages) {
  const page = positiveInteger(String(value).trim());
  return page && page <= pages ? page : null;
}

export function listContext(state) {
  return JSON.stringify([state.view, state.q, state.sort, state.ownerId, state.status, state.expiry]);
}

export function resetPage(state) { return { ...state, page: 1 }; }

export function restoreListPage(state, saved) {
  return saved?.context === listContext(state) ? { page: saved.page, pageSize: saved.pageSize } : { page: 1, pageSize: state.pageSize };
}
