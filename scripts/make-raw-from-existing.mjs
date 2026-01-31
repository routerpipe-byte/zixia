#!/usr/bin/env node

/**
 * make-raw-from-existing.mjs
 *
 * Create content/raw/*.raw.json from existing zh posts.
 * This allows running the AI formatting pass without re-importing.
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

function stripBom(s) {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function main() {
  const contentRoot = process.argv[2] || 'content';
  const zhDir = path.join(contentRoot, 'zh', 'posts');
  const rawDir = path.join(contentRoot, 'raw');
  ensureDir(rawDir);

  const files = fs.readdirSync(zhDir).filter((f) => f.endsWith('.md'));
  let n = 0;
  for (const f of files) {
    const full = path.join(zhDir, f);
    const parsed = matter(stripBom(fs.readFileSync(full, 'utf8')));
    const key = String(parsed.data?.translationKey || path.basename(f, '.md'));
    const outPath = path.join(rawDir, `${key}.raw.json`);
    const raw = {
      translationKey: key,
      title: parsed.data?.title || key,
      date: parsed.data?.date || null,
      html: null,
      markdown_raw: parsed.content || '',
    };
    fs.writeFileSync(outPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    n += 1;
  }
  console.log(`Wrote ${n} raw file(s) to ${rawDir}`);
}

await main();
