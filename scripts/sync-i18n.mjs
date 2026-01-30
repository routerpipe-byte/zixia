#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TODO: replace with pinyin-pro; this is just a stub.
function toPinyinSlug(str) {
  // Drop digits entirely for zh slug; keep letters.
  let res = '';
  for (const ch of str.normalize('NFKD')) {
    if (/^[0-9]$/.test(ch)) continue; // no digits
    if (/^[a-zA-Z]$/.test(ch)) {
      res += ch.toLowerCase();
    } else if (/[\u4e00-\u9fff]/.test(ch)) {
      // Fallback: just "hanzi" placeholder; real impl will use pinyin-pro.
      res += 'hanzi-';
    } else if (/\s+/.test(ch)) {
      res += '-';
    } else {
      // other punctuation → separator
      res += '-';
    }
  }
  res = res.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return res || 'post';
}

function parseFrontMatter(content) {
  // Strip UTF-8 BOM if present.
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  // Accept both with/without trailing newline after body.
  const re = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
  const m = content.match(re) || (content.endsWith('\n') ? content.slice(0, -1).match(re) : null);
  if (!m) return null;
  const [, fm, body] = m;
  const data = {};
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body };
}

function stringifyFrontMatter(data) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    let lineVal = String(v);
    if (/[:#]/.test(lineVal) || /\s/.test(lineVal)) {
      lineVal = `"${lineVal.replace(/"/g, '\\"')}"`;
    }
    lines.push(`${k}: ${lineVal}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

function ensureSlugAndKeyForFile(filePath, existingSlugs) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontMatter(raw);
  if (!parsed) {
    console.warn(`Skip (no front matter): ${filePath}`);
    return;
  }
  const { data, body } = parsed;
  if (!data.title) {
    console.warn(`Skip (no title): ${filePath}`);
    return;
  }

  // translationKey = basename without extension, e.g. wechat-001
  if (!data.translationKey) {
    const base = path.basename(filePath, path.extname(filePath));
    data.translationKey = base;
  }

  if (!data.slug) {
    let slug = toPinyinSlug(data.title);
    let candidate = slug;
    let counter = 2;
    while (existingSlugs.has(candidate)) {
      candidate = `${slug}-${counter}`;
      counter += 1;
    }
    data.slug = candidate;
    existingSlugs.add(candidate);
    const fm = stringifyFrontMatter(data);
    const next = fm + body;
    fs.writeFileSync(filePath, next, { encoding: 'utf8' });
    console.log(`Added slug="${candidate}", translationKey="${data.translationKey}" to ${filePath}`);
  } else {
    console.log(`Slug exists for ${filePath}: ${data.slug}`);
  }
}

function walkZhPosts() {
  const base = path.join(__dirname, '..', 'content', 'zh', 'posts');
  if (!fs.existsSync(base)) return;
  const entries = fs.readdirSync(base).filter(n => n.endsWith('.md'));
  const existingSlugs = new Set();
  for (const name of entries) {
    const full = path.join(base, name);
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = parseFrontMatter(raw);
    if (parsed && parsed.data.slug) existingSlugs.add(parsed.data.slug);
  }
  for (const name of entries) {
    const full = path.join(base, name);
    ensureSlugAndKeyForFile(full, existingSlugs);
  }
}

walkZhPosts();
