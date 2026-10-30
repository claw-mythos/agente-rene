#!/usr/bin/env node
'use strict';
// audit-gate.js — falha (exit 1) se `npm audit --omit=dev` acusar vulnerabilidade
// high/critical FORA da allowlist de riscos aceitos. Usado no CI e no pre-push.
//
// Allowlist: cadeia do html-docx-js (jszip / lodash.merge) — sem fix upstream;
// vetor não aplicável ao nosso uso (só GERAMOS docx de HTML próprio, nunca
// carregamos zip não-confiável). Ver "Dependency policy" no RUNBOOK.md.
//
// body-parser / multer — transitivas do express; DoS de payload resolvido por
// nosso limite de body (1 MB) no gateway.
// puppeteer / puppeteer-core / chromium-bidi / zod — cadeia do puppeteer usado
// só em geração interna de PDF; não processa input externo não-confiável.

const { execSync } = require('child_process');

const ACCEPTED = new Set([
  'html-docx-js', 'jszip', 'lodash.merge',
  'body-parser', 'multer',
  'puppeteer', 'puppeteer-core', 'chromium-bidi', 'zod',
]);
const GATE = new Set(['high', 'critical']);

let out;
try {
  out = execSync('npm audit --omit=dev --json', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  // npm audit sai com código != 0 quando há vulns — o JSON vem no stdout mesmo assim
  out = e.stdout;
}

let report;
try {
  report = JSON.parse(out);
} catch (e) {
  console.error('audit-gate: não consegui parsear a saída do npm audit');
  process.exit(1);
}

const vulns = report.vulnerabilities || {};
const offenders = Object.entries(vulns)
  .filter(([name, v]) => GATE.has(v.severity) && !ACCEPTED.has(name));

if (offenders.length > 0) {
  console.error('❌ audit-gate: vulnerabilidades high/critical fora da allowlist:');
  for (const [name, v] of offenders) {
    console.error(`   - ${name} (${v.severity})`);
  }
  process.exit(1);
}

const accepted = Object.keys(vulns).filter(n => ACCEPTED.has(n));
console.log(`✅ audit-gate: ok (${Object.keys(vulns).length} vulns conhecidas, ${accepted.length} na allowlist: ${accepted.join(', ') || 'nenhuma'})`);
