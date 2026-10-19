import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const attendanceRouter = Router();

attendanceRouter.post('/attendance/clock-out', requireAuth('employee'), asyncHandler(async (req, res) => {
  const employeeId = req.auth.sub;
  const today = new Date().toISOString().split('T')[0];
  const record = await prisma.attendanceRecord.findFirst({
    where: { employeeId, date: today, timeOut: null }
  });
  if (!record) return res.status(404).json({ error: 'No open shift to clock out of' });

  await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: { timeOut: new Date(), status: 'Completed Shift' }
  });
  res.json({ success: true });
}));

attendanceRouter.get('/attendance', requireAuth('admin'), asyncHandler(async (req, res) => {
  const records = await prisma.attendanceRecord.findMany({
    include: { employee: { select: { name: true, employeeCode: true, department: true } } },
    orderBy: { timeIn: 'desc' },
    take: 500
  });
  res.json({ records });
}));
