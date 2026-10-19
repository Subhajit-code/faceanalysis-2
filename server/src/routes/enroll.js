import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { encryptVector, decryptVector, cosineSimilarity } from '../lib/crypto.js';
import { extractFaceData } from '../lib/faceEngine.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const enrollRouter = Router();

const MATCH_THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD || '0.45');

const enrollLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20, // generous but bounded — enrollment is admin-only, this just stops runaway scripts
  standardHeaders: true,
  legacyHeaders: false
});

// Enrollment is admin-only: employees cannot self-register their own face,
// which prevents an attacker from enrolling a fake identity through the public UI.
enrollRouter.post('/enroll', enrollLimiter, requireAuth('admin'), asyncHandler(async (req, res) => {
  const { employeeCode, name, email, department, role, clearance, images } = req.body || {};

  if (!employeeCode || !name || !email || !department || !role) {
    return res.status(400).json({ error: 'employeeCode, name, email, department, role are required' });
  }
  if (!Array.isArray(images) || images.length < 1) {
    return res.status(400).json({ error: 'At least 1 face image is required (3 recommended)' });
  }

  const embeddings = [];
  let avatarUrl = null;

  for (const image of images) {
    let faceData;
    try {
      faceData = await extractFaceData(image);
    } catch (err) {
      return res.status(502).json({ error: 'Face engine unavailable', detail: err.message });
    }
    if (!faceData.success || !faceData.embedding) {
      return res.status(422).json({ error: faceData.error || 'No face detected in one of the submitted images' });
    }
    embeddings.push(Float32Array.from(faceData.embedding));
    if (!avatarUrl && faceData.avatarDataUrl) avatarUrl = faceData.avatarDataUrl;
  }

  // Duplicate-identity check: block enrolling a face that already belongs to someone else
  const existingEmployees = await prisma.employee.findMany({ include: { embeddings: true } });
  for (const emp of existingEmployees) {
    for (const storedEmb of emp.embeddings) {
      const storedVector = decryptVector(storedEmb.vector);
      for (const newVec of embeddings) {
        if (cosineSimilarity(newVec, storedVector) >= MATCH_THRESHOLD) {
          await prisma.auditLog.create({
            data: {
              type: 'ENROLLMENT_BLOCKED_DUPLICATE',
              employeeId: emp.id,
              notes: `Blocked enrollment of "${name}" (${employeeCode}) — face already matches existing employee ${emp.name} (${emp.employeeCode}).`
            }
          });
          return res.status(409).json({
            error: `This face is already enrolled as ${emp.name} (${emp.employeeCode}).`
          });
        }
      }
    }
  }

  const employee = await prisma.employee.create({
    data: {
      employeeCode,
      name,
      email,
      department,
      role,
      clearance: clearance || 'Level 1',
      avatarUrl,
      embeddings: {
        create: embeddings.map((vec) => ({ vector: encryptVector(vec), modelName: 'arcface-r100' }))
      }
    }
  });

  await prisma.auditLog.create({
    data: {
      type: 'ENROLLMENT_SUCCESS',
      employeeId: employee.id,
      notes: `Enrolled ${embeddings.length} face sample(s) for ${employee.name} (${employee.employeeCode}).`
    }
  });

  res.status(201).json({ employee: { id: employee.id, employeeCode, name, department, role } });
}));
