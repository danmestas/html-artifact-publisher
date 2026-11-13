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
  design: '<path d="M4.5 19.5C4.5 11.6 9.6 6.5 17.5 6.5"/><circle cx="4.5" cy="19.5" r="2"/><circle cx="17.5" cy="6.5" r="2"/><path d="M17.5 6.5h4M4.5 19.5v3"/>',
  research: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5.5 5.5M7 12l2-3 2.5 2.5L14 8"/>',
  planning: '<path d="M3 18h5a3 3 0 0 0 3-3v-6a3 3 0 0 1 3-3h7"/><circle cx="3" cy="18" r="1.8"/><circle cx="11" cy="12" r="1.8"/><circle cx="21" cy="6" r="1.8"/>',
  architecture: '<path d="M4 21V9l8-5 8 5v12M2 21h20"/><path d="M9 21v-5h6v5M8 11h2.5m3 0H16M8 14h2.5m3 0H16"/>',
  security: '<path d="M12 3 4 6v6c0 4.4 3 7.6 8 9 5-1.4 8-4.6 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  finance: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4m12-4v4"/>',
  science: '<path d="M9 3h6M10 3v5.5L5.2 18a2.2 2.2 0 0 0 2 3.2h9.6a2.2 2.2 0 0 0 2-3.2L14 8.5V3"/><path d="M7.6 15h8.8"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.6a3 3 0 0 1 0 5.8M17 14.2c2.9.5 5 2.9 5 5.8"/>',
  education: '<path d="M12 4 2 9l10 5 10-5z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5M22 9v6"/>',
  health: '<path d="M12 20.5 4.7 13.4A5 5 0 0 1 12 6.6a5 5 0 0 1 7.3 6.8z"/><path d="M7.5 12h2.2l1.3-2.5 2.2 5 1.4-2.5h2.9"/>',
  travel: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v3m4-3v3"/>',
  music: '<path d="M9 18V6l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  game: '<rect x="2" y="7" width="20" height="10" rx="5"/><path d="M7 10v4m-2-2h4"/><circle cx="15.5" cy="11" r="1"/><circle cx="18" cy="14" r="1"/>',
  tool: '<rect x="8" y="3" width="8" height="6" rx="1.5"/><path d="M10 6h4M10.5 9v6h3V9"/><path d="m9.5 15 2.5 6 2.5-6"/>',
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

// Topic inference looks at the title only. It never reads page contents,
// file names or links, and the title is bounded before normalization so a
// hostile or enormous title cannot turn into expensive work.
const TITLE_LIMIT = 512;

// Terms are lowercase words with weights. Weight 4 marks a distinctive
// subject, 3 a clear subject word and 2 a supporting word. The rules are
// ordered by specificity; equal scores fall through to the earlier topic,
// which makes every result deterministic.
const TOPIC_RULES = Object.freeze([
  Object.freeze({ name: 'security', terms: Object.freeze([
    ['security', 4], ['secure', 3], ['threat', 3], ['threats', 3],
    ['threat model', 4], ['threat modeling', 4], ['threat modelling', 4],
    ['vulnerability', 4], ['vulnerabilities', 4], ['penetration test', 4],
    ['pen test', 4], ['pentest', 4], ['incident response', 4], ['zero trust', 4],
    ['access control', 3], ['encryption', 3], ['privacy', 3], ['authentication', 3],
    ['authorization', 3], ['auth', 2], ['cve', 4], ['csrf', 4], ['xss', 4],
    ['malware', 3], ['ransomware', 4], ['hardening', 3], ['audit', 2],
  ]) }),
  Object.freeze({ name: 'health', terms: Object.freeze([
    ['health', 4], ['healthy', 3], ['medical', 4], ['medicine', 3], ['clinical', 4],
    ['patient', 3], ['patients', 3], ['diagnosis', 4], ['diagnoses', 4],
    ['therapy', 4], ['therapist', 4], ['wellness', 3], ['fitness', 3],
    ['nutrition', 3], ['exercise', 2], ['sleep', 2], ['symptom', 3],
    ['symptoms', 3], ['hospital', 3], ['doctor', 2], ['nurse', 3], ['surgery', 4],
    ['mental health', 4], ['public health', 4], ['vaccine', 3], ['vaccination', 3],
    ['clinic', 3], ['dosage', 3],
  ]) }),
  Object.freeze({ name: 'finance', terms: Object.freeze([
    ['finance', 4], ['finances', 4], ['financial', 4], ['budget', 4], ['budgets', 4],
    ['invoice', 3], ['invoices', 3], ['revenue', 4], ['pricing', 3], ['payroll', 4],
    ['tax', 3], ['taxes', 3], ['accounting', 4], ['expense', 3], ['expenses', 3],
    ['forecast', 3], ['cash flow', 4], ['investment', 3], ['investments', 3],
    ['profit', 3], ['cost', 2], ['costs', 2], ['quarterly earnings', 4],
    ['financial audit', 4], ['loan', 3], ['loans', 3], ['interest rate', 3],
  ]) }),
  Object.freeze({ name: 'science', terms: Object.freeze([
    ['science', 4], ['scientific', 4], ['scientist', 3], ['physics', 4],
    ['chemistry', 4], ['biology', 4], ['geology', 4], ['astronomy', 4],
    ['genome', 4], ['gene', 3], ['genes', 3], ['molecule', 4], ['molecules', 4],
    ['laboratory', 4], ['lab', 3], ['experiment', 3], ['experiments', 3],
    ['climate', 3], ['quantum', 4], ['species', 3], ['hypothesis', 3],
    ['peer review', 3], ['dataset', 2], ['machine learning', 4],
    ['neuroscience', 4], ['ecology', 4],
  ]) }),
  Object.freeze({ name: 'architecture', terms: Object.freeze([
    ['architecture', 4], ['architectural', 4], ['architect', 3],
    ['system design', 4], ['systems design', 4], ['infrastructure', 3],
    ['topology', 4], ['microservices', 4], ['microservice', 4], ['adr', 3],
    ['architecture decision', 4], ['deployment diagram', 4], ['network diagram', 4],
    ['monolith', 3], ['distributed system', 4], ['schema', 2], ['floor plan', 4],
    ['blueprint', 3], ['wire protocol', 3],
  ]) }),
  Object.freeze({ name: 'education', terms: Object.freeze([
    ['education', 4], ['educational', 4], ['learning', 3], ['course', 4],
    ['courses', 4], ['lesson', 4], ['lessons', 4], ['curriculum', 4],
    ['teaching', 3], ['teacher', 3], ['tutorial', 3], ['tutorials', 3],
    ['training', 2], ['workshop', 3], ['workshops', 3], ['student', 3],
    ['students', 3], ['classroom', 4], ['syllabus', 4], ['textbook', 4],
    ['lecture', 3], ['homework', 4], ['study guide', 4], ['school', 2],
    ['university', 2], ['exam', 3], ['exams', 3],
  ]) }),
  Object.freeze({ name: 'travel', terms: Object.freeze([
    ['travel', 4], ['traveling', 4], ['travelling', 4], ['trip', 3], ['trips', 3],
    ['itinerary', 4], ['flight', 3], ['flights', 3], ['hotel', 3], ['hotels', 3],
    ['destination', 3], ['destinations', 3], ['tourism', 3], ['tourist', 3],
    ['vacation', 4], ['holiday', 2], ['journey', 3], ['backpacking', 4],
    ['airport', 3], ['transit', 2], ['city guide', 3], ['road trip', 4],
  ]) }),
  Object.freeze({ name: 'music', terms: Object.freeze([
    ['music', 4], ['musical', 3], ['musician', 4], ['song', 3], ['songs', 3],
    ['album', 3], ['albums', 3], ['playlist', 4], ['playlists', 4], ['audio', 2],
    ['sound', 2], ['soundtrack', 4], ['concert', 4], ['band', 3], ['guitar', 4],
    ['piano', 4], ['lyrics', 4], ['melody', 4], ['podcast', 3], ['podcasts', 3],
  ]) }),
  Object.freeze({ name: 'game', terms: Object.freeze([
    ['game', 3], ['games', 3], ['gaming', 4], ['gameplay', 4], ['game design', 4],
    ['player', 2], ['players', 2], ['level', 2], ['levels', 2], ['dungeon', 4],
    ['rpg', 4], ['board game', 4], ['board games', 4], ['puzzle', 3],
    ['puzzles', 3], ['esports', 4], ['quest', 3], ['boss fight', 4],
    ['video game', 4], ['video games', 4],
  ]) }),
  Object.freeze({ name: 'design', terms: Object.freeze([
    ['design', 3], ['designs', 3], ['designing', 3], ['designer', 3],
    ['designers', 3], ['redesign', 4], ['mockup', 4], ['mockups', 4],
    ['wireframe', 4], ['wireframes', 4], ['prototype', 3], ['prototypes', 3],
    ['ux', 3], ['ui', 3], ['user interface', 4], ['user experience', 4],
    ['branding', 3], ['logo', 3], ['typography', 3], ['style guide', 4],
    ['design system', 4], ['figma', 3], ['visual design', 4], ['layout', 2],
  ]) }),
  Object.freeze({ name: 'research', terms: Object.freeze([
    ['research', 4], ['researcher', 3], ['researchers', 3], ['study', 2],
    ['studies', 2], ['survey', 3], ['surveys', 3], ['findings', 2],
    ['interview', 2], ['interviews', 2], ['user interviews', 4],
    ['user research', 4], ['customer research', 4], ['literature review', 4],
    ['analysis', 2], ['analyses', 2], ['data collection', 3],
    ['questionnaire', 3], ['questionnaires', 3],
  ]) }),
  Object.freeze({ name: 'people', terms: Object.freeze([
    ['people', 4], ['person', 2], ['team', 2], ['teams', 2], ['stakeholder', 3],
    ['stakeholders', 3], ['hiring', 4], ['hire', 2], ['recruiting', 3],
    ['recruitment', 3], ['org chart', 4], ['organization', 2],
    ['organisation', 2], ['hr', 3], ['staff', 2], ['employees', 2],
    ['employee', 2], ['community', 2], ['cohort', 3], ['personnel', 3],
    ['team building', 4], ['onboarding', 2],
  ]) }),
  Object.freeze({ name: 'planning', terms: Object.freeze([
    ['plan', 2], ['plans', 2], ['planning', 3], ['planned', 3], ['roadmap', 4],
    ['roadmaps', 4], ['schedule', 3], ['schedules', 3], ['timeline', 3],
    ['milestone', 3], ['milestones', 3], ['strategy', 3], ['strategic', 3],
    ['backlog', 3], ['sprint', 3], ['sprints', 3], ['okr', 4], ['okrs', 4],
    ['goals', 2], ['quarterly', 2], ['project plan', 4], ['kickoff', 2],
    ['retrospective', 2], ['project overview', 3],
  ]) }),
  Object.freeze({ name: 'tool', terms: Object.freeze([
    ['tool', 3], ['tools', 3], ['toolkit', 4], ['tooling', 4], ['utility', 3],
    ['utilities', 3], ['cli', 3], ['command line', 3], ['automation', 3],
    ['automate', 3], ['plugin', 3], ['plugins', 3], ['extension', 2],
    ['extensions', 2], ['integration', 2], ['integrations', 2],
    ['workflow', 2], ['workflows', 2], ['bot', 2], ['bots', 2],
    ['setup guide', 3], ['configuration', 2], ['screwdriver', 3],
    ['hammer', 3], ['wrench', 3],
  ]) }),
  Object.freeze({ name: 'code', terms: Object.freeze([
    ['code', 4], ['programming', 4], ['javascript', 4], ['typescript', 4],
    ['python', 4], ['golang', 4], ['rust', 3], ['api', 3], ['sdk', 3],
    ['sql', 3], ['debugging', 3], ['source code', 4], ['algorithm', 3],
  ]) }),
  Object.freeze({ name: 'chart', terms: Object.freeze([
    ['chart', 4], ['charts', 4], ['dashboard', 4], ['analytics', 4], ['metrics', 3], ['data visualization', 4],
  ]) }),
  Object.freeze({ name: 'calendar', terms: Object.freeze([['calendar', 4], ['events', 2]]) }),
  Object.freeze({ name: 'slides', terms: Object.freeze([['slides', 4], ['presentation', 4], ['slide deck', 4]]) }),
  Object.freeze({ name: 'checklist', terms: Object.freeze([['checklist', 4], ['checklists', 4], ['todo', 3]]) }),
  Object.freeze({ name: 'notes', terms: Object.freeze([['notes', 1], ['minutes', 2], ['journal', 3]]) }),
  Object.freeze({ name: 'image', terms: Object.freeze([['photography', 4], ['photo', 3], ['gallery', 3], ['illustration', 3], ['portfolio', 2]]) }),
  Object.freeze({ name: 'map', terms: Object.freeze([['map', 3], ['maps', 3], ['geography', 4], ['trail map', 4]]) }),
  Object.freeze({ name: 'book', terms: Object.freeze([['book', 3], ['reading list', 4], ['bibliography', 4]]) }),
  Object.freeze({ name: 'calculator', terms: Object.freeze([['calculator', 4], ['converter', 3]]) }),
  Object.freeze({ name: 'recipe', terms: Object.freeze([['recipe', 4], ['recipes', 4], ['cooking', 4], ['meal', 3]]) }),
]);

function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  const bounded = title.slice(0, TITLE_LIMIT).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  const words = bounded.replace(/[^a-z0-9]+/g, ' ').trim();
  return words ? ` ${words} ` : '';
}

/** Pick the most specific bounded topic named by a title. Titles are the only input. */
export function inferIcon(title) {
  const text = normalizeTitle(title);
  if (!text) return 'document';
  let best = 'document';
  let bestScore = 0;
  for (const rule of TOPIC_RULES) {
    let score = 0;
    for (const [term, weight] of rule.terms) {
      if (weight > score && text.includes(` ${term} `)) score = weight;
    }
    if (score > bestScore) { bestScore = score; best = rule.name; }
  }
  return best;
}

/** Honor an explicit non-document icon, otherwise infer from the title. */
export function resolveIcon(name, title) {
  if (typeof name === 'string' && name !== 'document' && Object.hasOwn(paths, name)) return name;
  return inferIcon(title);
}
