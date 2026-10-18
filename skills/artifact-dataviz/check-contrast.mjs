#!/usr/bin/env node
// check-contrast.mjs - dependency-free palette checker for artifact charts.
//
//   node check-contrast.mjs                      # checks the documented default palette
//   node check-contrast.mjs --bg "#ffffff" --colors "#2563c9,#c4520c,..."   # one ad-hoc set
//   add --text to require 4.5:1 (text) instead of 3:1 (graphical marks)
//
// Per color: WCAG 2 contrast ratio against the background and OKLCH lightness.
// Per set: smallest colour distance between neighbouring slots (and across all pairs)
// in OKLab x100, for normal vision and simulated protanopia / deuteranopia
// (Machado et al. 2009, severity 1.0). Exit code 1 if any hard check fails.

const DEFAULT = {
  light: {
    bg: '#ffffff',
    categorical: ['#2563c9', '#4d7f12', '#c0307a', '#9a6b00', '#7a4fd6', '#0f8577', '#c4520c', '#5c6878'],
    sequential: ['#dbe7fb', '#a9c6f3', '#6f9fe6', '#3a76d2', '#1f55a8', '#163b75'],
    diverging: ['#b5431a', '#e0875e', '#f3c9b6', '#d9d9d9', '#b6cdf0', '#5f93dc', '#1f55a8'],
  },
  dark: {
    bg: '#15171a',
    categorical: ['#5b9bf0', '#86bd4b', '#ef6fae', '#d8a636', '#a98cf6', '#33bba8', '#f08a4b', '#9aa6b6'],
    sequential: ['#1c2f4f', '#22457a', '#2f62aa', '#4a83d6', '#7aa8ec', '#b3cdf6'],
    diverging: ['#f08a4b', '#b8603a', '#6b3f2c', '#36383c', '#2f4a73', '#3f74c0', '#7aa8ec'],
  },
};

// ---------- colour math ----------
const hexToRgb = (h) => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(f)) throw new Error('bad hex: ' + h);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
};
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (h) => hexToRgb(h).map(toLin);
const luminance = (h) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const linToOklab = ([r, g, b]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const CVD = {
  normal: null,
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const simulate = (rgb, M) => (M ? M.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))) : rgb);
const dE = (a, b, M) => {
  const p = linToOklab(simulate(lin(a), M)), q = linToOklab(simulate(lin(b), M));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
const oklchL = (h) => linToOklab(lin(h))[0];

// ---------- checks ----------
let failed = false;
const f1 = (n) => n.toFixed(1), f2 = (n) => n.toFixed(2);

function checkCategorical(name, bg, colors, minRatio) {
  console.log(`\n${name} categorical on ${bg}  (marks need >= ${minRatio}:1)`);
  colors.forEach((c, i) => {
    const r = contrast(c, bg); const ok = r >= minRatio; if (!ok) failed = true;
    console.log(`  ${i + 1}. ${c}  contrast ${f2(r).padStart(5)}  L ${f2(oklchL(c))}  ${ok ? 'ok' : 'FAIL'}`);
  });
  for (const [vision, M] of Object.entries(CVD)) {
    let adj = Infinity, adjPair = '', all = Infinity, allPair = '';
    for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
      const d = dE(colors[i], colors[j], M);
      if (j === i + 1 && d < adj) { adj = d; adjPair = `${i + 1}-${j + 1}`; }
      if (d < all) { all = d; allPair = `${i + 1}-${j + 1}`; }
    }
    // hard floors: neighbours >= 15 normal, >= 6 under CVD (8 is the target)
    const floor = vision === 'normal' ? 15 : 6; const ok = adj >= floor; if (!ok) failed = true;
    const note = vision === 'normal' ? '' : adj >= 8 ? '' : ' (below 8: add labels/markers)';
    console.log(`  ${vision.padEnd(6)} min neighbour dE ${f1(adj).padStart(5)} (${adjPair})  min any-pair dE ${f1(all).padStart(5)} (${allPair})  ${ok ? 'ok' : 'FAIL'}${note}`);
  }
}

function checkRamp(name, bg, ramp, kind) {
  const Ls = ramp.map(oklchL);
  let ok = true;
  if (kind === 'sequential') {
    // must be monotone in lightness, either direction (dark mode runs dark->light)
    const up = Ls.every((l, i) => i === 0 || l > Ls[i - 1]);
    const down = Ls.every((l, i) => i === 0 || l < Ls[i - 1]);
    ok = up || down;
  } else {
    // diverging: the middle step is the extreme of lightness in its mode, arms step away from it
    const mid = (ramp.length - 1) / 2;
    const towardMid = (i) => (i < mid ? Ls[i + 1] : Ls[i - 1]);
    const lighterMid = Ls[mid] > Ls[0];
    ok = Ls.every((l, i) => i === mid || (lighterMid ? l < towardMid(i) : l > towardMid(i)));
  }
  if (!ok) failed = true;
  const end = kind === 'sequential' ? Math.max(contrast(ramp[0], bg), contrast(ramp.at(-1), bg)) : Math.min(contrast(ramp[0], bg), contrast(ramp.at(-1), bg));
  console.log(`  ${name} ${kind.padEnd(10)} L: ${Ls.map(f2).join(' ')}  monotone ${ok ? 'ok' : 'FAIL'}  ` +
    (kind === 'sequential' ? `strong end contrast ${f2(end)}` : `pole contrast >= ${f2(end)}`));
}

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const minRatio = args.includes('--text') ? 4.5 : 3;

if (opt('--colors')) {
  checkCategorical('custom', opt('--bg') || '#ffffff', opt('--colors').split(',').map((s) => s.trim()), minRatio);
} else {
  for (const [mode, p] of Object.entries(DEFAULT)) {
    checkCategorical(mode, p.bg, p.categorical, minRatio);
    console.log(`\n${mode} ramps on ${p.bg}`);
    checkRamp(mode, p.bg, p.sequential, 'sequential');
    checkRamp(mode, p.bg, p.diverging, 'diverging');
  }
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: all checks pass');
process.exit(failed ? 1 : 0);
