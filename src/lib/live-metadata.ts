import { load } from "cheerio";
import { assertSafePublicUrl } from "@/lib/ssrf";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;
const USER_AGENT =
  "DemoBro.video (live-page metadata; +https://demobro.video)";

export type LivePageMetadata = {
  title: string;
  description: string;
  badges: string[];
  finalUrl: string;
  source: "live";
};

function cleanText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function humanizeHostname(url: URL): string {
  const hostname = url.hostname.replace(/^www\./i, "");
  const firstLabel = hostname.split(".")[0] || "Project";
  return firstLabel
    .replace(/^(web|app)-production-[a-z0-9-]+$/i, "Project")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function conciseProductTitle(value: string): string {
  const cleaned = cleanText(value, 120);
  const parts = cleaned
    .split(/\s+(?:[|—–·]|-\s)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.split(/\s+/).length <= 6)
    .filter((part) => !/^(home|welcome|official site|web app)$/i.test(part));

  if (!parts.length) return cleanText(cleaned, 64);
  return cleanText(
    parts.reduce((best, part) =>
      part.split(/\s+/).length < best.split(/\s+/).length ? part : best,
    ),
    64,
  );
}

function metaContent(
  $: ReturnType<typeof load>,
  selectors: string[],
): string {
  for (const selector of selectors) {
    const value = $(selector).first().attr("content");
    if (value?.trim()) return value;
  }
  return "";
}

async function readLimitedHtml(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;

    const remaining = MAX_HTML_BYTES - total;
    const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.length;
    if (chunk.length < value.length) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  if (total >= MAX_HTML_BYTES) {
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(joined);
}

async function fetchPublicHtml(rawUrl: string): Promise<{
  html: string;
  finalUrl: URL;
}> {
  let current = rawUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const safe = await assertSafePublicUrl(current);
      if (!safe.ok) throw new Error(safe.error);

      const response = await fetch(safe.url, {
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": USER_AGENT,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("The live page returned an invalid redirect.");
        current = new URL(location, safe.url).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`The live page returned ${response.status}.`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new Error("The live URL did not return a web page.");
      }

      return {
        html: await readLimitedHtml(response),
        finalUrl: safe.url,
      };
    }
  } finally {
    clearTimeout(timer);
  }

  throw new Error("The live page redirected too many times.");
}

function metadataFromHtml(html: string, finalUrl: URL): LivePageMetadata {
  const $ = load(html);
  $("script, style, noscript, template, svg").remove();

  const title = conciseProductTitle(
    metaContent($, [
      'meta[name="application-name"]',
      'meta[property="og:site_name"]',
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ||
      $("title").first().text() ||
      $("h1").first().text() ||
      humanizeHostname(finalUrl),
  );

  const lead = $("main p, article p, body p")
    .toArray()
    .map((element) => cleanText($(element).text(), 220))
    .find((text) => text.length >= 35);
  const description = cleanText(
    metaContent($, [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ]) ||
      lead ||
      `A live web project from ${finalUrl.hostname.replace(/^www\./i, "")}.`,
    180,
  );

  return {
    title: title || humanizeHostname(finalUrl),
    description,
    badges: [],
    finalUrl: finalUrl.toString(),
    source: "live",
  };
}

/**
 * Infer product context from public page metadata without requiring source code.
 * A reachable page with sparse metadata still gets a stable domain-based fallback.
 */
export async function inferLivePageMetadata(
  liveUrl: string,
): Promise<LivePageMetadata> {
  const initial = await assertSafePublicUrl(liveUrl);
  if (!initial.ok) throw new Error(initial.error);

  try {
    const { html, finalUrl } = await fetchPublicHtml(initial.url.toString());
    return metadataFromHtml(html, finalUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[live-metadata] using hostname fallback: ${message}`);
    return {
      title: humanizeHostname(initial.url),
      description: `A live web project from ${initial.url.hostname.replace(/^www\./i, "")}.`,
      badges: [],
      finalUrl: initial.url.toString(),
      source: "live",
    };
  }
}
