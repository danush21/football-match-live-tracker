/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  headers: async () => [
    {
      // frames.bin is content-addressed by the converter run, not by URL, so keep
      // the browser cache short enough that a re-convert is picked up.
      source: "/data/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
    },
  ],
};

export default nextConfig;
