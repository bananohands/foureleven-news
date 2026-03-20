#!/usr/bin/env node
// generate-news.mjs — Fetches RSS feeds, filters for Iran/Middle East conflict stories,
// summarizes them, writes news-data.json. Zero external dependencies (Node 18+).

import { parseArgs } from 'node:util';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, 'news-data.json');

// ── RSS Feeds ──
const FEEDS = [
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
  { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'AP News', url: 'https://feedx.net/rss/ap.xml' },
  { name: 'Reuters', url: 'https://feedx.net/rss/reuters.xml' },
  { name: 'The Guardian — Middle East', url: 'https://www.theguardian.com/world/middleeast/rss' },
  { name: 'CNN World', url: 'http://rss.cnn.com/rss/edition_meast.rss' },
];

// ── Keywords for filtering ──
const KEYWORDS = [
  'iran', 'tehran', 'persian gulf', 'strait of hormuz', 'irgc', 'revolutionary guard',
  'khamenei', 'pezeshkian', 'hezbollah', 'houthi', 'yemen', 'red sea',
  'iraq', 'syria', 'lebanon', 'beirut', 'gaza', 'israel', 'idf', 'hamas',
  'netanyahu', 'ceasefire', 'airstrike', 'missile', 'drone strike', 'nuclear',
  'enrichment', 'sanctions', 'centrifuge', 'natanz', 'fordow',
  'middle east', 'mideast', 'pentagon', 'centcom',
];

const KEYWORD_RX = new RegExp(KEYWORDS.join('|'), 'i');

// ── Parse XML (minimal, no deps) ──
function extractItems(xml) {
  const items = [];
  // Handle both <item> (RSS) and <entry> (Atom)
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extract(block, 'title');
    const link = extractLink(block);
    const desc = extract(block, 'description') || extract(block, 'summary') || extract(block, 'content');
    const pubDate = extract(block, 'pubDate') || extract(block, 'published') || extract(block, 'updated');
    if (title && link) {
      items.push({ title: cleanHtml(title), link, description: cleanHtml(desc || ''), pubDate });
    }
  }
  return items;
}

function extract(block, tag) {
  // Try CDATA first, then plain
  const cdataRx = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(cdataRx) || block.match(plainRx);
  return m ? m[1].trim() : null;
}

function extractLink(block) {
  // RSS <link>
  const linkTag = extract(block, 'link');
  if (linkTag && linkTag.startsWith('http')) return linkTag;
  // Atom <link href="..."/>
  const atomRx = /<link[^>]+href=["']([^"']+)["']/i;
  const m = block.match(atomRx);
  return m ? m[1] : linkTag;
}

function cleanHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Fetch all feeds ──
async function fetchFeeds() {
  const allItems = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'foureleven-news/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`  ✗ ${feed.name}: HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const items = extractItems(xml);
      console.log(`  ✓ ${feed.name}: ${items.length} items`);
      for (const item of items) {
        item.source = feed.name;
        allItems.push(item);
      }
    } catch (err) {
      console.error(`  ✗ ${feed.name}: ${err.message}`);
    }
  }
  return allItems;
}

// ── Filter for Iran/Middle East conflict ──
function filterRelevant(items) {
  return items.filter(item => {
    const text = `${item.title} ${item.description}`.toLowerCase();
    return KEYWORD_RX.test(text);
  });
}

// ── Deduplicate by similar titles ──
function dedup(items) {
  const seen = new Map();
  const result = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(item);
    }
  }
  return result;
}

// ── Sort by date (newest first) ──
function sortByDate(items) {
  return items.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });
}

// ── Resolve Anthropic API key ──
function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // Try OpenClaw auth profiles
  try {
    const profilePath = join(process.env.HOME || '', '.openclaw/agents/main/agent/auth-profiles.json');
    const profiles = JSON.parse(readFileSync(profilePath, 'utf8'));
    const anthro = profiles?.profiles?.['anthropic:default'];
    if (anthro?.key) return anthro.key;
  } catch {}
  return null;
}

// ── Summarize with Anthropic (optional, falls back to descriptions) ──
async function summarizeStories(stories) {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    console.log('  ℹ No ANTHROPIC_API_KEY — using raw descriptions');
    return stories.map(s => ({
      ...s,
      summary: s.description.slice(0, 300) || s.title,
    }));
  }

  // Build a batch prompt
  const storyBlock = stories.slice(0, 25).map((s, i) =>
    `[${i + 1}] ${s.title}\nSource: ${s.source}\n${s.description.slice(0, 500)}`
  ).join('\n\n');

  const prompt = `You are a sharp, no-bullshit news briefing writer. Your reader is smart, hates fluff, and wants to know what actually matters.

Here are today's stories about Iran, the Middle East conflict, and related geopolitics:

${storyBlock}

For each story, write a 1-2 sentence summary that:
- Leads with what happened, not background
- Includes specific details (names, numbers, locations)
- Has a dry, slightly sardonic edge — like a well-informed friend texting you
- Skips any story that's just opinion/analysis with no news

Return JSON array: [{"index": 1, "summary": "...", "importance": "high|medium|low"}, ...]
Only include stories worth reading. Drop the noise.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`  ✗ Anthropic API: HTTP ${res.status}`);
      return stories.map(s => ({ ...s, summary: s.description.slice(0, 300) || s.title, importance: 'medium' }));
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    
    // Extract JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('  ✗ Could not parse Anthropic response');
      return stories.map(s => ({ ...s, summary: s.description.slice(0, 300) || s.title, importance: 'medium' }));
    }

    const summaries = JSON.parse(jsonMatch[0]);
    console.log(`  ✓ Summarized ${summaries.length} stories`);

    return summaries.map(s => {
      const original = stories[s.index - 1];
      if (!original) return null;
      return {
        ...original,
        summary: s.summary,
        importance: s.importance || 'medium',
      };
    }).filter(Boolean);

  } catch (err) {
    console.error(`  ✗ Summary failed: ${err.message}`);
    return stories.map(s => ({ ...s, summary: s.description.slice(0, 300) || s.title, importance: 'medium' }));
  }
}

// ── Main ──
async function main() {
  console.log('📰 Fetching RSS feeds...');
  const allItems = await fetchFeeds();
  console.log(`\n📋 Total items: ${allItems.length}`);

  const relevant = filterRelevant(allItems);
  console.log(`🎯 Relevant (Iran/ME conflict): ${relevant.length}`);

  const unique = dedup(relevant);
  console.log(`🔄 After dedup: ${unique.length}`);

  const sorted = sortByDate(unique);
  const top = sorted.slice(0, 25);

  console.log(`\n🤖 Summarizing top ${top.length} stories...`);
  const summarized = await summarizeStories(top);

  const output = {
    generated: new Date().toISOString(),
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    storyCount: summarized.length,
    feedsChecked: FEEDS.length,
    feedsSucceeded: FEEDS.filter((_, i) => true).length, // rough
    stories: summarized.map(s => ({
      title: s.title,
      summary: s.summary,
      source: s.source,
      link: s.link,
      importance: s.importance || 'medium',
      pubDate: s.pubDate || null,
    })),
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Wrote ${OUT_FILE} (${summarized.length} stories)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
