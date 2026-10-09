export const SITE_URL = "https://code.lmcs.tec.br";

export const GITHUB_REPOSITORY_URL = "https://github.com/leandroasilva/lmcs-agent";

export const DOWNLOAD_URL = "https://github.com/leandroasilva/lmcs-agent/releases/latest";

export const REPO_OWNER = "leandroasilva";
export const REPO_NAME = "lmcs-agent";

export async function fetchGitHubStars(): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return "0";
    const data = await res.json();
    const stars = data.stargazers_count as number;
    if (stars >= 1000) return `${(stars / 1000).toFixed(1).replace(".0", "")}k`;
    return String(stars);
  } catch {
    return "0";
  }
}
