import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { signAdminToken } from '../lib/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10, // 10 attempts per 10 min per IP — brute-force throttling on admin login
  standardHeaders: true,
  legacyHeaders: false
});

authRouter.post('/admin/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const admin = await prisma.admin.findUnique({ where: { email } });
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signAdminToken(admin);
  res.json({ token, admin: { id: admin.id, email: admin.email } });
}));
