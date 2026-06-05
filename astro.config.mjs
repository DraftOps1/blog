import { defineConfig } from "astro/config";

const site = process.env.SITE || "https://draftops1.github.io";
const base = normalizeBase(process.env.BASE_PATH || "/");

function normalizeBase(path) {
  const cleanPath = path.trim().replace(/^\/+|\/+$/g, "");
  return cleanPath ? `/${cleanPath}` : "/";
}

function withBasePath(path) {
  if (base === "/" || !path.startsWith("/") || path.startsWith("//")) {
    return path;
  }

  if (path === base || path.startsWith(`${base}/`)) {
    return path;
  }

  return `${base}${path}`;
}

function remarkBasePath() {
  return (tree) => {
    const stack = [tree];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") {
        continue;
      }

      if ((node.type === "image" || node.type === "link") && typeof node.url === "string") {
        node.url = withBasePath(node.url);
      }

      if (Array.isArray(node.children)) {
        stack.push(...node.children);
      }
    }
  };
}

export default defineConfig({
  site,
  base,
  output: "static",
  markdown: {
    remarkPlugins: [remarkBasePath],
  },
  devToolbar: {
    enabled: false
  }
});
