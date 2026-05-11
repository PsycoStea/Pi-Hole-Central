import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../src/lib/db/index.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(__dirname, '../drizzle/migrations')

migrate(db, { migrationsFolder })
console.log('✓ Database migrations complete')
