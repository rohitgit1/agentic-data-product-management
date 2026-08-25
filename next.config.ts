import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'exceljs', 'docx'],
  outputFileTracingIncludes: {
    '/**': ['./prisma/dev.db'],
  },
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
