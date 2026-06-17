#!/usr/bin/env node
// audit.js — Wrapper around `npm audit` that filters out runtime-patched advisories.
// Reads .patched-advisories.json (written by postinstall.js) to know which GHSAs
// have been mitigated via source patches and should not show up as false positives.
//
// Usage: node audit.js   (run from the res/ directory)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load patched advisory list
const patchedFile = path.join(__dirname, '.patched-advisories.json');
let patchedGHSAs = [];
try {
  const data = JSON.parse(fs.readFileSync(patchedFile, 'utf-8'));
  patchedGHSAs = data.patched || [];
} catch (_) {
  // No patched advisories file — run raw audit
}

// Run npm audit --json
let auditJson;
try {
  const raw = execSync('npm audit --json', { cwd: __dirname, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  auditJson = JSON.parse(raw);
} catch (e) {
  // npm audit exits non-zero when vulnerabilities exist — that's expected
  try {
    auditJson = JSON.parse(e.stdout || '{}');
  } catch (_) {
    // If JSON parse fails, just run plain npm audit
    try {
      execSync('npm audit', { cwd: __dirname, stdio: 'inherit' });
    } catch (_) { }
    process.exit(1);
  }
}

const vulnerabilities = auditJson.vulnerabilities || {};
let realVulns = 0;
let silencedVulns = 0;

for (const [name, vuln] of Object.entries(vulnerabilities)) {
  // Check if ALL via entries for this vulnerability are patched
  const viaEntries = (vuln.via || []).filter(v => typeof v === 'object');
  const isFullyPatched = viaEntries.length > 0 && viaEntries.every(v => patchedGHSAs.includes(v.url?.split('/').pop()));

  // Also check indirect deps that only depend on patched packages
  const isDirect = viaEntries.length > 0;
  const isIndirectOfPatched = !isDirect && (vuln.via || []).every(v => {
    if (typeof v === 'string') {
      const parent = vulnerabilities[v];
      if (!parent) return false;
      const parentVias = (parent.via || []).filter(pv => typeof pv === 'object');
      return parentVias.length > 0 && parentVias.every(pv => patchedGHSAs.includes(pv.url?.split('/').pop()));
    }
    return false;
  });

  if (isFullyPatched || isIndirectOfPatched) {
    silencedVulns++;
  } else {
    realVulns++;
    const severity = vuln.severity || 'unknown';
    const title = viaEntries.map(v => v.title).filter(Boolean).join(', ') || vuln.via?.join(', ') || name;
    console.log(`  ${severity}  ${name}: ${title}`);
  }
}

if (realVulns === 0 && silencedVulns === 0) {
  console.log('found 0 vulnerabilities');
} else if (realVulns === 0) {
  console.log(`found 0 vulnerabilities (${silencedVulns} patched by postinstall, silenced)`);
} else {
  console.log(`\n${realVulns} unpatched vulnerabilit${realVulns === 1 ? 'y' : 'ies'} found`);
  if (silencedVulns > 0) {
    console.log(`(${silencedVulns} additional vulnerabilit${silencedVulns === 1 ? 'y' : 'ies'} patched by postinstall, silenced)`);
  }
  process.exit(1);
}
