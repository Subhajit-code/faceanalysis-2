import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const employeesRouter = Router();

employeesRouter.get('/employees', requireAuth('admin'), asyncHandler(async (_req, res) => {
  const employees = await prisma.employee.findMany({
    select: {
      id: true, employeeCode: true, name: true, email: true, department: true,
      role: true, clearance: true, avatarUrl: true, active: true, createdAt: true,
      _count: { select: { embeddings: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json({ employees });
}));

employeesRouter.delete('/employees/:id', requireAuth('admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.employee.update({ where: { id }, data: { active: false } });
  await prisma.auditLog.create({
    data: { type: 'ADMIN_ACTION', employeeId: id, notes: `Employee ${id} deactivated by admin ${req.auth.email}.` }
  });
  res.json({ success: true });
}));

employeesRouter.get('/me', requireAuth('employee'), asyncHandler(async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.auth.sub } });
  if (!employee || !employee.active) return res.status(404).json({ error: 'Not found' });
  res.json({
    employee: {
      id: employee.id, employeeCode: employee.employeeCode, name: employee.name,
      department: employee.department, role: employee.role, clearance: employee.clearance,
      avatarUrl: employee.avatarUrl
    }
  });
}));
