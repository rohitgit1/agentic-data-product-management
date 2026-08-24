import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'exceljs', 'docx'],
  typedRoutes: false,
  eslint: {
    dirs: ['src', 'tests', 'scripts', 'prisma'],
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
}

export default nextConfig
