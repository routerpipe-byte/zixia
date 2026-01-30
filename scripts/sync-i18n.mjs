#!/usr/bin/env node

/**
 * sync-i18n.mjs (Phase 1)
 *
 * Current scope (per requirements):
 * - Traverse zh posts
 * - Ensure front matter is parsed safely
 * - Auto-generate zh slug (pinyin, lowercase, dash-separated; NO DIGITS)
 * - Auto-generate translationKey (stable; same across langs)
 * - Write back UTF-8 (no BOM)
 *
 * Later phases will generate en/es + translation + caching.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';
import { pinyin } from 'pinyin-pro';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function stripBom(s) {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function slugifyLatin(input) {
  // NFKD splits accents; strip diacritics.
  let s = String(input).normalize('NFKD').replace(/\p{M}+/gu, '');
  s = s.toLowerCase();
  // Keep a-z/0-9 for now; we will drop digits afterwards (policy: no digits in URL)
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s;
}

function toZhPinyinSlug(title) {
  const py = pinyin(String(title), {
    toneType: 'none',
    type: 'string',
    separator: '-',
    nonZh: 'consecutive',
  });
  // Remove digits entirely ("URL 不要数字")
  const noDigits = py.replace(/[0-9]+/g, ' ');
  const slug = slugifyLatin(noDigits).replace(/[0-9]+/g, '');
  return slug || 'post';
}

function stableTranslationKey(filePathRelToContentRoot) {
  // Stable across renames within the repo? Use relative path hash.
  const h = crypto.createHash('sha1').update(String(filePathRelToContentRoot)).digest('hex');
  return `t_${h.slice(0, 10)}`;
}

function ensureUniqueSlug(baseSlug, used) {
  let candidate = baseSlug;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${baseSlug}-${i}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function writeMarkdownWithFrontMatter(filePath, data, body) {
  const out = matter.stringify(body ?? '', data ?? {});
  fs.writeFileSync(filePath, out, { encoding: 'utf8' });
}

function loadExistingSlugs(zhPostsDir) {
  const used = new Set();
  for (const name of fs.readdirSync(zhPostsDir)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(zhPostsDir, name);
    const raw = stripBom(fs.readFileSync(full, 'utf8'));
    const parsed = matter(raw);
    const slug = parsed.data?.slug;
    if (slug) used.add(String(slug));
  }
  return used;
}

function walkZhPosts() {
  const zhPostsDir = path.join(__dirname, '..', 'content', 'zh', 'posts');
  if (!fs.existsSync(zhPostsDir)) {
    console.log(`No zh posts dir: ${zhPostsDir}`);
    return;
  }

  const usedSlugs = loadExistingSlugs(zhPostsDir);
  const contentRoot = path.join(__dirname, '..', 'content');

  for (const name of fs.readdirSync(zhPostsDir)) {
    if (!name.endsWith('.md')) continue;

    const full = path.join(zhPostsDir, name);
    const raw = stripBom(fs.readFileSync(full, 'utf8'));

    let parsed;
    try {
      parsed = matter(raw);
    } catch (e) {
      console.warn(`Skip (front matter parse error): ${full}`);
      console.warn(String(e));
      continue;
    }

    const data = { ...(parsed.data || {}) };
    const body = parsed.content || '';

    if (!data.title) {
      console.warn(`Skip (no title): ${full}`);
      continue;
    }

    // translationKey
    if (!data.translationKey) {
      // Prefer basename for compatibility with imported wechat-XXX across languages.
      const base = path.basename(full, path.extname(full));
      data.translationKey = base;
    }

    // slug
    if (!data.slug) {
      const baseSlug = toZhPinyinSlug(data.title);
      data.slug = ensureUniqueSlug(baseSlug, usedSlugs);
    } else {
      // If slug looks like a placeholder from importer (e.g. "hanzi-hanzi"), regenerate.
      const isPlaceholder = /^hanzi-hanzi(?:-[a-z]+)?$/i.test(String(data.slug));
      if (isPlaceholder) {
        const baseSlug = toZhPinyinSlug(data.title);
        data.slug = ensureUniqueSlug(baseSlug, usedSlugs);
      } else {
        // Enforce policy: no digits.
        const cleaned = slugifyLatin(String(data.slug)).replace(/[0-9]+/g, '');
        if (cleaned && cleaned !== data.slug) {
          data.slug = ensureUniqueSlug(cleaned, usedSlugs);
        }
      }
    }

    writeMarkdownWithFrontMatter(full, data, body);
    console.log(`OK: ${path.relative(process.cwd(), full)} slug=${data.slug} translationKey=${data.translationKey}`);
  }
}

walkZhPosts();
