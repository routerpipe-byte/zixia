#!/usr/bin/env node

/**
 * Clean existing imported markdown posts in-place.
 *
 * Removes WeChat boilerplate:
 * - Leading metadata line like: "原创 zixia 2026-01-15 00:29 西班牙"
 * - Trailing prompt like: "阅读原文\n\n跳转微信打开"
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

function stripBom(s) {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function cleanWeChatBoilerplate(md) {
  let s = String(md || '');

  // Remove leading metadata line (most common pattern)
  s = s.replace(/^\s*原创\s+[^\n]+\n+/m, '');

  // Remove trailing prompts
  s = s.replace(/\n+\s*阅读原文\s*(?:\n+\s*跳转微信打开\s*)?\n*$/m, '\n');

  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim() + '\n';
}

function cleanFile(filePath) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const parsed = matter(raw);
  const before = parsed.content;
  const after = cleanWeChatBoilerplate(before);
  if (after !== before) {
    const out = matter.stringify(after, parsed.data || {});
    fs.writeFileSync(filePath, out, 'utf8');
    return true;
  }
  return false;
}

function main() {
  const contentDir = process.argv[2] || 'content';
  const langs = ['zh', 'en', 'es'];
  let changed = 0;

  for (const lang of langs) {
    const dir = path.join(contentDir, lang, 'posts');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(dir, name);
      if (cleanFile(full)) changed += 1;
    }
  }

  console.log(`Cleaned ${changed} file(s).`);
}

main();
