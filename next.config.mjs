/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Playwright must never be bundled: it resolves a Chromium binary from disk at
  // runtime, and webpack rewriting those paths breaks the launch. Keeping it
  // external means the server route imports the same module the CLI does.
  serverExternalPackages: ['playwright', 'playwright-core', 'exceljs'],

  eslint: {
    // The scraper predates this config and is linted by tsc, not eslint.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
