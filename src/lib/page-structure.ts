import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { assertSafePublicUrl } from "@/lib/ssrf";

export type PageElement = {
  tag: string;
  role?: string;
  text?: string;
  name?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  selectorHint: string;
};

export type PageStructure = {
  finalUrl: string;
  title: string;
  elements: PageElement[];
  landmarks: string[];
};

function cleanText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

function accessibleName(
  $: cheerio.CheerioAPI,
  el: Element,
): string | undefined {
  const node = $(el);
  return (
    cleanText(node.attr("aria-label")) ||
    cleanText(node.attr("title")) ||
    cleanText(node.attr("alt")) ||
    cleanText(node.attr("placeholder")) ||
    cleanText(node.text())
  );
}

function selectorHint(
  $: cheerio.CheerioAPI,
  el: Element,
  name?: string,
): string {
  const node = $(el);
  const testId = node.attr("data-testid");
  if (testId) return `[data-testid="${testId}"]`;

  const id = node.attr("id");
  if (id && /^[A-Za-z][\w:-]*$/.test(id)) return `#${id}`;

  const tag = el.tagName.toLowerCase();
  if (name) {
    return `${tag}:has-text("${name.slice(0, 60).replace(/"/g, '\\"')}")`;
  }

  const role = node.attr("role");
  if (role) return `[role="${role}"]`;

  const href = node.attr("href");
  if (href && href.startsWith("/") && href.length < 80) {
    return `a[href="${href}"]`;
  }

  return tag;
}

export async function fetchPageStructure(
  liveUrl: string,
): Promise<
  | { ok: true; structure: PageStructure }
  | { ok: false; error: string }
> {
  const safe = await assertSafePublicUrl(liveUrl);
  if (!safe.ok) return { ok: false, error: safe.error };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(safe.url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "DemoBro.video bot (page-structure; +https://demobro.video)",
      },
    });

    if (!res.ok) {
      return {
        ok: false,
        error: `Live URL returned ${res.status} — couldn’t read the page.`,
      };
    }

    // Re-check after redirects
    const finalUrl = res.url || safe.url.toString();
    const redirected = await assertSafePublicUrl(finalUrl);
    if (!redirected.ok) {
      return { ok: false, error: redirected.error };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return {
        ok: false,
        error: "Live URL didn’t return HTML.",
      };
    }

    const html = await res.text();
    if (!html.trim()) {
      return { ok: false, error: "Live URL returned an empty page." };
    }

    const $ = cheerio.load(html);
    $("script, style, noscript, svg title").remove();

    const elements: PageElement[] = [];
    const pushUnique = (item: PageElement) => {
      const key = `${item.tag}|${item.name ?? ""}|${item.selectorHint}`;
      if (elements.some((e) => `${e.tag}|${e.name ?? ""}|${e.selectorHint}` === key)) {
        return;
      }
      elements.push(item);
    };

    $("a[href], button, [role='button'], input, select, textarea, summary").each(
      (_, el) => {
        if (elements.length >= 80) return false;
        const node = $(el);
        const tag = el.tagName.toLowerCase();
        const name = accessibleName($, el);
        const type = cleanText(node.attr("type"));
        if (tag === "input" && (type === "hidden" || type === "file")) return;
        pushUnique({
          tag,
          role: cleanText(node.attr("role")),
          text: cleanText(node.text()),
          name,
          href: cleanText(node.attr("href")),
          type,
          placeholder: cleanText(node.attr("placeholder")),
          selectorHint: selectorHint($, el, name),
        });
      },
    );

    $("h1, h2, h3, [role='heading']").each((_, el) => {
      if (elements.length >= 100) return false;
      const name = accessibleName($, el);
      if (!name) return;
      pushUnique({
        tag: el.tagName.toLowerCase(),
        role: "heading",
        name,
        text: name,
        selectorHint: selectorHint($, el, name),
      });
    });

    const landmarks = $("main, nav, header, footer, [role='main'], [role='navigation']")
      .toArray()
      .slice(0, 12)
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const role = $(el).attr("role");
        const name = accessibleName($, el);
        return [tag, role, name].filter(Boolean).join(" ");
      });

    return {
      ok: true,
      structure: {
        finalUrl,
        title: cleanText($("title").first().text()) ?? "",
        elements,
        landmarks,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Timed out reaching the live URL." };
    }
    return { ok: false, error: "Couldn’t reach that live URL." };
  } finally {
    clearTimeout(timeout);
  }
}
