/**
 * One-off script to create the first admin account.
 * Usage: node src/seedAdmin.js admin@company.com "StrongPassw0rd!"
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from './lib/prisma.js';

const [, , email, password] = process.argv;

if (!email || !password || password.length < 10) {
  console.error('Usage: node src/seedAdmin.js <email> <password (min 10 chars)>');
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);
const admin = await prisma.admin.upsert({
  where: { email },
  update: { passwordHash },
  create: { email, passwordHash }
});

console.log(`Admin ready: ${admin.email}`);
await prisma.$disconnect();
