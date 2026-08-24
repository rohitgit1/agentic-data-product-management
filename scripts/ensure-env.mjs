import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// In CI / cloud environments like Vercel or Netlify, do not create a fake SQLite .env if already provided
if (process.env.VERCEL || process.env.NETLIFY || process.env.CI) {
  process.exit(0)
}

const env = resolve(process.cwd(), '.env')
const example = resolve(process.cwd(), '.env.example')

if (existsSync(env)) {
  process.exit(0)
}
if (!existsSync(example)) {
  process.exit(0)
}

copyFileSync(example, env)
process.stdout.write('Created .env from .env.example.\n')
