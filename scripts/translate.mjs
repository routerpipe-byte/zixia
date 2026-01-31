#!/usr/bin/env node

/**
 * Minimal translation helper using OpenAI-compatible Chat Completions API.
 *
 * Env:
 * - OPENAI_API_KEY (required)
 * - OPENAI_BASE_URL (optional; default https://api.openai.com/v1)
 * - OPENAI_MODEL (optional; default gpt-4o-mini)
 */

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const KEY = process.env.OPENAI_API_KEY;

export async function translateText({ text, targetLang }) {
  if (!KEY) throw new Error('Missing OPENAI_API_KEY');
  const url = `${BASE_URL.replace(/\/$/, '')}/chat/completions`;

  const sys =
    'You are a professional translator. Preserve Markdown structure exactly. ' +
    'Do not translate code blocks, inline code, URLs, file paths, or front matter keys. ' +
    'Keep line breaks. Output ONLY the translated text.';

  const user = `Translate to ${targetLang}.\n\nTEXT:\n${text}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      // Avoid provider-side buffering by requesting streaming off explicitly
      stream: false,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Translate failed HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const json = await res.json();
  const out = json?.choices?.[0]?.message?.content;
  if (!out) throw new Error('No translation output');
  return String(out).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || 'English';
  const input = await new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => resolve(s));
  });
  const out = await translateText({ text: input, targetLang: target });
  process.stdout.write(out);
}
