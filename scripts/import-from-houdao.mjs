#!/usr/bin/env node

/**
 * Import posts from Houdao RSS2API JSON and generate Hugo multilingual content.
 *
 * Usage:
 *   node scripts/import-from-houdao.mjs --url "https://rss2api.houdao.com/api/query?..." --out content
 *
 * Notes:
 * - Writes:
 *   content/zh/posts/wechat-XXX.md
 *   content/en/posts/wechat-XXX.md
 *   content/es/posts/wechat-XXX.md
 *   static/img/wechat-XXX/{cover.jpg,1.jpg,...}
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function slugifyLatin(s) {
  return stripBom(String(s))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/\d+/g, '')
    .replace(/-+/g, '-')
    || 'post';
}

// Placeholder zh pinyin slug: keep rule (no digits). Real pinyin can be added later.
function slugifyZh(title) {
  // For now, use latin slugifier after dropping non-latin; fallback to 'post'.
  const latin = slugifyLatin(title);
  return latin !== 'post' ? latin : 'hanzi-hanzi';
}

function frontMatter({ title, date, translationKey, slug }) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return `---\n` +
    `title: "${esc(title)}"\n` +
    `date: ${date}\n` +
    `draft: false\n` +
    `translationKey: "${esc(translationKey)}"\n` +
    `slug: "${esc(slug)}"\n` +
    `---\n`;
}

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { JSDOM } from 'jsdom';

function cleanWeChatBoilerplate(md) {
  let s = String(md || '');

  // Remove leading metadata line like: "原创 zixia 2026-01-15 00:29 西班牙" (allow extra spaces)
  s = s.replace(/^\s*原创\s+[^\n]+\n+/m, '');

  // Remove trailing prompts like: "阅读原文\n\n跳转微信打开" (and variations)
  s = s.replace(/\n+\s*阅读原文\s*(?:\n+\s*跳转微信打开\s*)?\n*$/m, '\n');

  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim() + '\n';
}

function htmlTableToGfm(node) {
  const rows = Array.from(node.querySelectorAll('tr'));
  if (!rows.length) return '';

  const grid = rows.map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((cell) =>
      // preserve basic inline styles inside cells via innerHTML -> turndown will handle, but we keep as text here
      (cell.textContent || '').replace(/\s+/g, ' ').trim(),
    ),
  );

  // normalize column count
  const cols = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < cols) r.push('');

  const header = grid[0];
  const body = grid.slice(1);

  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const line = (cells) => `| ${cells.map((c) => esc(c)).join(' | ')} |`;
  const sep = `| ${new Array(cols).fill('---').join(' | ')} |`;

  let out = line(header) + '\n' + sep + '\n';
  for (const r of body) out += line(r) + '\n';
  return out + '\n';
}

function htmlToMd(html) {
  const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
  });
  turndown.use(gfm);

  // Preserve inline styles (size/color) by keeping span tags as HTML.
  turndown.keep(['span', 'sub', 'sup', 'u']);
  turndown.keep(['blockquote']);
  turndown.keep(['font']);

  // Convert tables to GFM tables (WeChat often uses <table> heavily)
  turndown.addRule('tableToGfm', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => {
      try {
        return htmlTableToGfm(node);
      } catch {
        // Fallback: keep plain text to avoid losing content
        return `\n\n${(node.textContent || '').trim()}\n\n`;
      }
    },
  });

  // Turndown runs without a DOM; provide one so table conversion works reliably.
  const dom = new JSDOM(String(html || ''));
  const body = dom.window.document.body;
  const md = turndown.turndown(body.innerHTML);
  return cleanWeChatBoilerplate(md);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractImgUrls(html) {
  const urls = [];
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) urls.push(decodeHtmlEntities(m[1]));
  return urls;
}

function replaceImgsWithLocal(html, translationKey) {
  let idx = 1;
  return String(html).replace(/(<img[^>]+src=["'])([^"']+)(["'][^>]*>)/gi, (_m, a, _src, c) => {
    const local = `/img/${translationKey}/${idx}.jpg`;
    idx += 1;
    return `${a}${local}${c}`;
  });
}

async function main() {
  const url = arg('url');
  if (!url) {
    console.error('Missing --url');
    process.exit(2);
  }

  const resp = await fetchJson(url);
  const data = Array.isArray(resp) ? resp : resp?.data;
  if (!Array.isArray(data)) throw new Error('Expected JSON array at resp or resp.data');

  const repoRoot = path.join(__dirname, '..');
  const contentRoot = path.join(repoRoot, 'content');
  const staticImgRoot = path.join(repoRoot, 'static', 'img');

  ensureDir(contentRoot);
  ensureDir(staticImgRoot);

  let n = 0;
  for (const item of data) {
    const translationKey = `wechat-${String(n + 1).padStart(3, '0')}`;
    const created = item.created ? new Date(item.created) : new Date();
    const date = isNaN(created.getTime()) ? new Date().toISOString().slice(0, 10) : created.toISOString().slice(0, 10);

    const zhTitle = item.title || translationKey;
    const enTitle = zhTitle; // TODO: translate
    const esTitle = zhTitle; // TODO: translate

    const zhSlug = slugifyZh(zhTitle);
    const enSlug = slugifyLatin(enTitle);
    const esSlug = slugifyLatin(esTitle);

    const html = String(item.content || '');
    const htmlLocal = replaceImgsWithLocal(html, translationKey);
    const mdBody = htmlToMd(htmlLocal);

    // Raw artifact for AI formatting pass
    const rawDir = path.join(contentRoot, 'raw');
    ensureDir(rawDir);
    const rawPath = path.join(rawDir, `${translationKey}.raw.json`);
    fs.writeFileSync(
      rawPath,
      JSON.stringify({ translationKey, title: zhTitle, date, html: htmlLocal, markdown_raw: mdBody }, null, 2) + '\n',
      'utf8',
    );

    const zhPath = path.join(contentRoot, 'zh', 'posts', `${translationKey}.md`);
    const enPath = path.join(contentRoot, 'en', 'posts', `${translationKey}.md`);
    const esPath = path.join(contentRoot, 'es', 'posts', `${translationKey}.md`);

    ensureDir(path.dirname(zhPath));
    ensureDir(path.dirname(enPath));
    ensureDir(path.dirname(esPath));

    fs.writeFileSync(zhPath, frontMatter({ title: zhTitle, date, translationKey, slug: zhSlug }) + mdBody);
    fs.writeFileSync(enPath, frontMatter({ title: enTitle, date, translationKey, slug: enSlug }) + mdBody);
    fs.writeFileSync(esPath, frontMatter({ title: esTitle, date, translationKey, slug: esSlug }) + mdBody);

    const imgUrls = extractImgUrls(html);
    if (imgUrls.length) {
      const imgDir = path.join(staticImgRoot, translationKey);
      ensureDir(imgDir);
      let i = 1;
      for (const u of imgUrls) {
        const out = path.join(imgDir, `${i}.jpg`);
        await downloadFile(u, out);
        i += 1;
      }
    }

    n += 1;
  }

  console.log(`Imported ${n} post(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
