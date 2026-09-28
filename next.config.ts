import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";
const repoBasePath = "/QuetUnfollowIGSmallScale";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: isGitHubPages ? repoBasePath : "",
  assetPrefix: isGitHubPages ? `${repoBasePath}/` : undefined,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
