// Trusted, bounded artwork shared by publisher clients and the outer viewer.
const paths = Object.freeze({
  document: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  chart: '<path d="M4 3v17h17M8 16v-5m5 5V7m5 9V4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M7 14h3m4 0h3m-10 4h3"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  slides: '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M12 17v4m-5 0 5-4 5 4M7 9h10m-10 4h6"/>',
  checklist: '<path d="m3 6 2 2 3-4m3 2h10M3 13l2 2 3-4m3 2h10M3 20l2 2 3-4m3 2h10"/>',
  notes: '<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 18 6-6 4 4 3-3 5 5"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16m6-14v16"/>',
  book: '<path d="M12 5C9 3 6 3 2 4v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1v15"/>',
  calculator: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 11h1m6 0h1m-8 4h1m6 0h1m-8 4h1m6 0h1"/>',
  recipe: '<path d="M7 14a5 5 0 0 1-2-9 5 5 0 0 1 8-2 5 5 0 0 1 6 8l-2 3v7H7zM7 17h10"/>',
});
export const ICON_NAMES = Object.freeze(Object.keys(paths));
export function validIcon(value) {
  return value === undefined || value === null || (typeof value === 'string' && Object.hasOwn(paths, value));
}
export function iconSvg(name, favicon = false) {
  const artwork = paths[typeof name === 'string' && Object.hasOwn(paths, name) ? name : 'document'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${favicon ? '#27313d' : 'currentColor'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${favicon ? '<style>@media(prefers-color-scheme:dark){svg{stroke:#e5e9ef}}</style>' : ''}${artwork}</svg>`;
}
export function setArtifactFavicon(name) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(iconSvg(name, true));
}
