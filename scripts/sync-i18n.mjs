#!/usr/bin/env node

/**
 * sync-i18n.mjs
 *
 * Phase 1: zh -> ensure slug + translationKey (UTF-8 no BOM writes)
 * Phase 2: generate/update en/es with translation when OPENAI_API_KEY is set.
 *
 * Notes:
 * - Uses chunked translation to avoid timeouts.
 * - Preserves Markdown structure (best-effort; code blocks/links are left intact by prompt).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';
import { pinyin } from 'pinyin-pro';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRANSLATE = !!process.env.OPENAI_API_KEY;
const CHUNK_CHARS = Number(process.env.TRANSLATE_CHUNK_CHARS || 1800);
const SLEEP_MS = Number(process.env.TRANSLATE_SLEEP_MS || 300);

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function splitIntoChunks(text, maxChars) {
  const s = String(text);
  if (s.length <= maxChars) return [s];

  const chunks = [];
  let i = 0;
  while (i < s.length) {
    const end = Math.min(s.length, i + maxChars);
    let cut = end;

    // Try to cut on paragraph boundary.
    const window = s.slice(i, end);
    const lastPara = window.lastIndexOf('\n\n');
    if (lastPara > 200) cut = i + lastPara + 2;

    // Fallback cut on newline.
    if (cut === end) {
      const lastNl = window.lastIndexOf('\n');
      if (lastNl > 200) cut = i + lastNl + 1;
    }

    chunks.push(s.slice(i, cut));
    i = cut;
  }
  return chunks;
}

async function translateMarkdown(text, targetLangName) {
  if (!TRANSLATE) return null;
  const { translateText } = await import('./translate.mjs');

  const parts = splitIntoChunks(text, CHUNK_CHARS);
  const outParts = [];
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    const translated = await translateText({ text: part, targetLang: targetLangName });
    outParts.push(translated);
    if (idx < parts.length - 1) await sleep(SLEEP_MS);
  }
  return outParts.join('');
}

async function upsertLangVersion({ lang, targetLangName, zh, outPath, usedSlugs }) {
  const zhData = zh.data || {};
  const zhBody = zh.content || '';

  let data = {
    ...zhData,
    title: zhData.title,
    slug: undefined,
    translationStatus: undefined,
    sourceHash: undefined,
  };

  // language slug: latinized from title (digits removed)
  const baseSlug = slugifyLatin(String(zhData.title)).replace(/[0-9]+/g, '') || 'post';
  data.slug = ensureUniqueSlug(baseSlug, usedSlugs);

  if (!data.translationKey) {
    data.translationKey = path.basename(outPath, path.extname(outPath));
  }

  const currentSourceHash = sha1(zhBody);

  // Keep existing if already translated and source unchanged
  if (fs.existsSync(outPath)) {
    const prev = readMd(outPath);
    const prevData = prev.data || {};
    const prevBody = prev.content || '';
    if (prevData.sourceHash === currentSourceHash && prevData.translationStatus === 'translated') {
      writeMarkdownWithFrontMatter(outPath, prevData, prevBody);
      console.log(`OK: ${lang} ${path.relative(process.cwd(), outPath)} status=translated (cached)`);
      return;
    }
  }

  data.sourceHash = currentSourceHash;

  if (TRANSLATE) {
    const titleTranslated = await translateMarkdown(String(zhData.title), targetLangName);
    if (titleTranslated) data.title = titleTranslated.trim();

    const bodyTranslated = await translateMarkdown(zhBody, targetLangName);
    if (bodyTranslated) {
      data.translationStatus = 'translated';
      writeMarkdownWithFrontMatter(outPath, data, bodyTranslated);
      console.log(`OK: ${lang} ${path.relative(process.cwd(), outPath)} status=translated`);
      return;
    }
  }

  // Fallback placeholder
  data.translationStatus = 'placeholder';
  writeMarkdownWithFrontMatter(outPath, data, zhBody);
  console.log(`OK: ${lang} ${path.relative(process.cwd(), outPath)} status=placeholder`);
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

    if (!data.translationKey) {
      data.translationKey = path.basename(full, path.extname(full));
    }

    if (!data.slug || /^hanzi-hanzi(?:-[a-z]+)?$/i.test(String(data.slug))) {
      const baseSlug = toZhPinyinSlug(data.title);
      data.slug = ensureUniqueSlug(baseSlug, usedZhSlugs);
    }

    fs.writeFileSync(full, matter.stringify(body, data), { encoding: 'utf8' });

    const key = String(data.translationKey);
    const enPath = path.join(contentRoot, 'en', 'posts', `${key}.md`);
    const esPath = path.join(contentRoot, 'es', 'posts', `${key}.md`);

    await upsertLangVersion({ lang: 'en', targetLangName: 'English', zh: { data, content: body }, outPath: enPath, usedSlugs: usedEnSlugs });
    await upsertLangVersion({ lang: 'es', targetLangName: 'Spanish', zh: { data, content: body }, outPath: esPath, usedSlugs: usedEsSlugs });
  }
}

await main();
