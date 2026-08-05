const GITHUB_REPO_RE =
  /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

export type FieldError = string | null;

export function validateLiveUrl(value: string): FieldError {
  const trimmed = value.trim();
  if (!trimmed) return "Enter the live URL of your deployed app.";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That doesn’t look like a valid URL.";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Use an http:// or https:// URL.";
  }

  if (!url.hostname.includes(".")) {
    return "That host doesn’t look like a public site.";
  }

  return null;
}

export function validateGithubUrl(value: string): FieldError {
  const trimmed = value.trim();
  if (!trimmed) return "Enter the GitHub repo URL.";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That doesn’t look like a valid URL.";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Use an http:// or https:// URL.";
  }

  if (!GITHUB_REPO_RE.test(trimmed.replace(/\.git$/, ""))) {
    return "Use a repo URL like https://github.com/owner/repo.";
  }

  return null;
}

export function isFormValid(liveUrl: string, githubUrl: string): boolean {
  return (
    validateLiveUrl(liveUrl) === null && validateGithubUrl(githubUrl) === null
  );
}
