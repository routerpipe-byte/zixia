#!/usr/bin/env node

/**
 * ai-format.mjs
 *
 * Read a raw JSON (from importer) and return a formatted JSON with markdown.
 * Uses OpenAI-compatible Chat Completions.
 */

import fs from 'fs';
import { z } from 'zod';

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://newapi.houdao.com/v1';
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const OutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional().default(''),
  markdown: z.string().min(1),
});

async function chat({ system, user }) {
  if (!KEY) throw new Error('Missing OPENAI_API_KEY');
  const url = `${BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content || '').trim();
}

function extractJson(text) {
  // Best-effort: find first {...} block.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON object found in model output');
  return JSON.parse(m[0]);
}

export async function formatArticle({ title, markdownRaw }) {
  const system =
    'You are an editor. You will format an article into clean, readable Markdown. ' +
    'Preserve meaning. Do not add new facts. ' +
    'Keep code blocks, URLs, and image links unchanged. ' +
    'Keep tables as GitHub-Flavored Markdown tables when present. ' +
    'Use headings, lists, and blockquotes where appropriate. ' +
    'Output ONLY valid JSON with keys: title, summary, markdown.';

  const user = JSON.stringify(
    {
      instruction:
        'Format the article markdown to be clear and well-structured. Remove any remaining boilerplate such as author/time/location lines and "Read more" prompts if present.',
      title,
      markdown_raw: markdownRaw,
      output_schema: { title: 'string', summary: 'string', markdown: 'string' },
    },
    null,
    2,
  );

  const out = await chat({ system, user });
  const obj = extractJson(out);
  return OutputSchema.parse(obj);
}

async function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/ai-format.mjs <in.raw.json> <out.formatted.json>');
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const title = raw.title || raw.translationKey || 'Untitled';
  const markdownRaw = raw.markdown_raw || '';
  const formatted = await formatArticle({ title, markdownRaw });
  fs.writeFileSync(outPath, JSON.stringify(formatted, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
