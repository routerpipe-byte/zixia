#!/usr/bin/env node

/**
 * apply-ai-format.mjs
 *
 * For each zh post, format markdown via AI based on raw markdown, then write back
 * the zh post body (front matter preserved).
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

import { formatArticle } from './ai-format.mjs';

function stripBom(s) {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readMd(p) {
  return matter(stripBom(fs.readFileSync(p, 'utf8')));
}

async function main() {
  const contentRoot = process.argv[2] || 'content';
  const zhDir = path.join(contentRoot, 'zh', 'posts');
  const rawDir = path.join(contentRoot, 'raw');

  if (!fs.existsSync(zhDir)) {
    console.error(`Missing ${zhDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(rawDir)) {
    console.error(`Missing ${rawDir} (run importer to generate raw artifacts)`);
    process.exit(1);
  }

  const files = fs.readdirSync(zhDir).filter((f) => f.endsWith('.md'));

  for (const f of files) {
    const key = path.basename(f, '.md');
    const rawPath = path.join(rawDir, `${key}.raw.json`);
    if (!fs.existsSync(rawPath)) {
      console.warn(`Skip (no raw): ${key}`);
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    const zhPath = path.join(zhDir, f);
    const zh = readMd(zhPath);

    const formatted = await formatArticle({ title: raw.title || zh.data?.title || key, markdownRaw: raw.markdown_raw || zh.content || '' });

    // Keep original front matter, but allow title update if AI cleaned it.
    const data = { ...(zh.data || {}) };
    if (formatted.title) data.title = formatted.title;
    data.aiFormatted = true;

    const out = matter.stringify(formatted.markdown, data);
    fs.writeFileSync(zhPath, out, 'utf8');
    console.log(`AI formatted: ${zhPath}`);
  }
}

await main();
