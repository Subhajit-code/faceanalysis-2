import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const auditRouter = Router();

auditRouter.get('/audit', requireAuth('admin'), asyncHandler(async (_req, res) => {
  const logs = await prisma.auditLog.findMany({
    include: { employee: { select: { name: true, employeeCode: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200
  });
  res.json({ logs });
}));
