// Writes prisma/schema.postgres.prisma from the SQLite schema by swapping the
// datasource block. Keeps one source of truth for the models.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const out = path.join(__dirname, '..', 'prisma', 'schema.postgres.prisma');
const schema = fs.readFileSync(src, 'utf8');
const swapped = schema.replace(/provider = "sqlite"/, 'provider = "postgresql"');
if (swapped === schema) {
  console.error('to-postgres: datasource provider not found — check prisma/schema.prisma');
  process.exit(1);
}
fs.writeFileSync(out, swapped);
console.log(`to-postgres: wrote ${path.relative(process.cwd(), out)}`);
