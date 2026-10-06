import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node:sqlite"],
  experimental: {
    // Attachments arrive through the request Server Action. Next caps action
    // bodies at 1MB by default, which would reject a legitimate spec sheet
    // before any of our own validation ran, so this is sized to clear
    // MAX_DOCUMENTS_PER_REQUEST files of MAX_DOCUMENT_BYTES plus form overhead.
    serverActions: {
      bodySizeLimit: "26mb",
    },
  },
};

export default nextConfig;
