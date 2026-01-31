#!/usr/bin/env node

/**
 * sync-i18n.mjs
 *
 * Phase 1 (DONE): zh -> ensure slug + translationKey (UTF-8 no BOM writes)
 * Phase 2 (NOW): generate/update en/es files. If OPENAI_API_KEY is absent, keep
 *                placeholder copies but mark them and avoid pretending they're translated.
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
  let s = String(input).normalize('NFKD').replace(/\p{M}+/gu, '');
  s = s.toLowerCase();
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
  const noDigits = py.replace(/[0-9]+/g, ' ');
  const slug = slugifyLatin(noDigits).replace(/[0-9]+/g, '');
  return slug || 'post';
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

function loadExistingSlugs(postsDir) {
  const used = new Set();
  if (!fs.existsSync(postsDir)) return used;
  for (const name of fs.readdirSync(postsDir)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(postsDir, name);
    const raw = stripBom(fs.readFileSync(full, 'utf8'));
    const parsed = matter(raw);
    const slug = parsed.data?.slug;
    if (slug) used.add(String(slug));
  }
  return used;
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function readMd(filePath) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  return matter(raw);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isTranslatedPlaceholder(data) {
  return data?.translationStatus === 'placeholder';
}

async function maybeTranslate({ text, targetLang }) {
  if (!process.env.OPENAI_API_KEY) return null;
  const { translateText } = await import('./translate.mjs');
  return translateText({ text, targetLang });
}

async function upsertLangVersion({
  lang,
  targetLangName,
  zh,
  outPath,
  usedSlugs,
}) {
  const zhData = zh.data || {};
  const zhBody = zh.content || '';

  let data = {
    ...zhData,
    // Force language-specific fields
    title: zhData.title,
    slug: undefined,
    translationStatus: undefined,
    sourceHash: undefined,
  };

  // Slug policy: use latin slug for en/es, remove digits.
  const baseSlug = slugifyLatin(String(zhData.title)).replace(/[0-9]+/g, '') || 'post';
  data.slug = ensureUniqueSlug(baseSlug, usedSlugs);

  // Ensure translationKey exists (must match zh)
  if (!data.translationKey) {
    data.translationKey = path.basename(outPath, path.extname(outPath));
  }

  // Incremental: avoid re-translate if zh unchanged and target already translated.
  const currentSourceHash = sha1(zhBody);

  let bodyOut = zhBody;
  const prevExists = fs.existsSync(outPath);
  if (prevExists) {
    const prev = readMd(outPath);
    const prevData = prev.data || {};
    const prevBody = prev.content || '';

    // keep existing translated title/body if already translated and sourceHash matches
    if (prevData.sourceHash === currentSourceHash && !isTranslatedPlaceholder(prevData)) {
      // Keep previous content, but update meta fields like translationKey/date/draft
      bodyOut = prevBody;
      data.title = prevData.title || data.title;
      data.slug = prevData.slug || data.slug;
      data.translationStatus = prevData.translationStatus;
      data.sourceHash = prevData.sourceHash;
    }
  }

  if (!data.sourceHash) data.sourceHash = currentSourceHash;

  // Try translation if key present.
  if (process.env.OPENAI_API_KEY) {
    const translated = await maybeTranslate({ text: zhBody, targetLang: targetLangName });
    if (translated) {
      bodyOut = translated;
      const titleTranslated = await maybeTranslate({ text: String(zhData.title), targetLang: targetLangName });
      if (titleTranslated) data.title = titleTranslated;
      data.translationStatus = 'translated';
    }
  }

  if (!data.translationStatus) {
    // No key: mark placeholders so you can see they are NOT translated.
    data.translationStatus = 'placeholder';
  }

  ensureDir(path.dirname(outPath));
  writeMarkdownWithFrontMatter(outPath, data, bodyOut);
  console.log(`OK: ${lang} ${path.relative(process.cwd(), outPath)} status=${data.translationStatus}`);
}

async function main() {
  const contentRoot = path.join(__dirname, '..', 'content');
  const zhPostsDir = path.join(contentRoot, 'zh', 'posts');
  if (!fs.existsSync(zhPostsDir)) {
    console.log(`No zh posts dir: ${zhPostsDir}`);
    return;
  }

  const usedZhSlugs = loadExistingSlugs(zhPostsDir);
  const usedEnSlugs = loadExistingSlugs(path.join(contentRoot, 'en', 'posts'));
  const usedEsSlugs = loadExistingSlugs(path.join(contentRoot, 'es', 'posts'));

  for (const name of fs.readdirSync(zhPostsDir)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(zhPostsDir, name);

    let zh;
    try {
      zh = readMd(full);
    } catch (e) {
      console.warn(`Skip (front matter parse error): ${full}`);
      console.warn(String(e));
      continue;
    }

    const data = { ...(zh.data || {}) };
    const body = zh.content || '';
    if (!data.title) {
      console.warn(`Skip (no title): ${full}`);
      continue;
    }

    // translationKey - keep basename compatibility (wechat-XXX)
    if (!data.translationKey) {
      data.translationKey = path.basename(full, path.extname(full));
    }

    // zh slug
    if (!data.slug || /^hanzi-hanzi(?:-[a-z]+)?$/i.test(String(data.slug))) {
      const baseSlug = toZhPinyinSlug(data.title);
      data.slug = ensureUniqueSlug(baseSlug, usedZhSlugs);
    } else {
      const cleaned = slugifyLatin(String(data.slug)).replace(/[0-9]+/g, '');
      if (cleaned && cleaned !== data.slug) {
        data.slug = ensureUniqueSlug(cleaned, usedZhSlugs);
      }
    }

    // Write back zh if changed.
    const zhOut = matter.stringify(body, data);
    fs.writeFileSync(full, zhOut, { encoding: 'utf8' });

    // Generate en/es.
    const key = String(data.translationKey);
    const enPath = path.join(contentRoot, 'en', 'posts', `${key}.md`);
    const esPath = path.join(contentRoot, 'es', 'posts', `${key}.md`);

    await upsertLangVersion({
      lang: 'en',
      targetLangName: 'English',
      zh: { data, content: body },
      outPath: enPath,
      usedSlugs: usedEnSlugs,
    });
    await upsertLangVersion({
      lang: 'es',
      targetLangName: 'Spanish',
      zh: { data, content: body },
      outPath: esPath,
      usedSlugs: usedEsSlugs,
    });
  }
}

await main();
