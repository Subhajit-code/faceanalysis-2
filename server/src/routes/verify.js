import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { decryptVector, cosineSimilarity } from '../lib/crypto.js';
import { extractFaceData } from '../lib/faceEngine.js';
import { signEmployeeSessionToken } from '../lib/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const verifyRouter = Router();

// Minimum ArcFace cosine similarity to accept a match (1.0 = identical).
// 0.45 is intentionally stricter than the ~0.35-0.4 typically cited as a
// research benchmark operating point for buffalo_l, because a false accept
// here means real building/system access, not just a labeling error.
const MATCH_THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD || '0.45');
const LIVENESS_MIN_SCORE = parseFloat(process.env.LIVENESS_MIN_SCORE || '0.85');
const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_WINDOW_MS = 30_000;

// Per-IP rate limit at the transport layer, on top of the DB-backed lockout below
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

async function isLockedOut(ipAddress) {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
  const count = await prisma.failedAttempt.count({
    where: { ipAddress, createdAt: { gte: since } }
  });
  return count >= MAX_ATTEMPTS_PER_WINDOW;
}

async function recordFailedAttempt(ipAddress) {
  await prisma.failedAttempt.create({ data: { ipAddress } });
}

verifyRouter.post('/verify', verifyLimiter, asyncHandler(async (req, res) => {
  const ipAddress = req.ip;
  const { images } = req.body || {};

  if (!Array.isArray(images) || images.length < 2) {
    return res.status(400).json({ error: 'images (array of >=2 base64 JPEG frames) is required' });
  }

  // Reject a burst made of byte-identical frames — a static photo re-submitted
  // as if it were live video. A genuine webcam feed always varies slightly.
  const uniqueFrames = new Set(images);
  if (uniqueFrames.size < 2) {
    await recordFailedAttempt(ipAddress);
    await prisma.auditLog.create({
      data: {
        type: 'ACCESS_DENIED',
        notes: 'Rejected: submitted frames were byte-identical (static image replay suspected).',
        ipAddress
      }
    });
    return res.status(403).json({ error: 'Liveness verification failed' });
  }

  if (await isLockedOut(ipAddress)) {
    await prisma.auditLog.create({
      data: {
        type: 'SCANNER_LOCKOUT',
        notes: `Verification blocked — ${MAX_ATTEMPTS_PER_WINDOW}+ failed attempts from this source within ${LOCKOUT_WINDOW_MS / 1000}s.`,
        ipAddress
      }
    });
    return res.status(429).json({ error: 'Too many failed attempts. Try again shortly.' });
  }

  // Run every frame in the burst through the face engine. All must contain a
  // face, pass the passive liveness threshold, and resolve to the SAME
  // identity (tight embedding distance between frames) — this stops an
  // attacker from flashing one person's photo then another's mid-attempt.
  const frameResults = [];
  for (const img of images) {
    let faceData;
    try {
      faceData = await extractFaceData(img);
    } catch (err) {
      return res.status(502).json({ error: 'Face engine unavailable', detail: err.message });
    }
    if (!faceData.success || !faceData.embedding) {
      return res.status(422).json({ error: faceData.error || 'No face detected in every frame of the burst' });
    }
    frameResults.push(faceData);
  }

  const avgLiveness = frameResults.reduce((sum, f) => sum + (f.liveness?.score || 0), 0) / frameResults.length;
  if (avgLiveness < LIVENESS_MIN_SCORE) {
    await recordFailedAttempt(ipAddress);
    await prisma.auditLog.create({
      data: {
        type: 'ACCESS_DENIED',
        notes: `Liveness check failed (avg score ${avgLiveness.toFixed(2)} < ${LIVENESS_MIN_SCORE}). Possible spoof attempt.`,
        ipAddress
      }
    });
    return res.status(403).json({ error: 'Liveness verification failed' });
  }

  const vectors = frameResults.map((f) => Float32Array.from(f.embedding));
  // Same-person frames a few hundred ms apart should be near-identical —
  // require much higher similarity than the cross-person match threshold.
  const MIN_INTRA_BURST_SIMILARITY = 0.8;
  for (let i = 1; i < vectors.length; i++) {
    if (cosineSimilarity(vectors[0], vectors[i]) < MIN_INTRA_BURST_SIMILARITY) {
      await recordFailedAttempt(ipAddress);
      await prisma.auditLog.create({
        data: {
          type: 'ACCESS_DENIED',
          notes: 'Rejected: face identity was inconsistent across the verification burst (possible photo-swap attempt).',
          ipAddress
        }
      });
      return res.status(403).json({ error: 'Liveness verification failed' });
    }
  }

  const queryVector = vectors[0];

  const employees = await prisma.employee.findMany({
    where: { active: true },
    include: { embeddings: true }
  });

  let best = null;
  let bestSimilarity = -1;

  for (const employee of employees) {
    for (const emb of employee.embeddings) {
      const storedVector = decryptVector(emb.vector);
      const sim = cosineSimilarity(queryVector, storedVector);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        best = employee;
      }
    }
  }

  const matched = best && bestSimilarity >= MATCH_THRESHOLD;

  if (!matched) {
    await recordFailedAttempt(ipAddress);
    await prisma.auditLog.create({
      data: {
        type: 'ACCESS_DENIED',
        notes: `No match within threshold (best similarity ${bestSimilarity.toFixed(4)} < ${MATCH_THRESHOLD}).`,
        ipAddress
      }
    });
    return res.status(401).json({ error: 'Face not recognized' });
  }

  // Confidence is scaled so the acceptance threshold itself reads as 0%, not
  // a misleadingly comfortable number — a match that just barely clears the
  // bar should visibly look marginal, not "47.7% confident and granted".
  const confidence = Math.max(0, Math.min(100, Math.round(((bestSimilarity - MATCH_THRESHOLD) / (1 - MATCH_THRESHOLD)) * 1000) / 10));
  const token = signEmployeeSessionToken(best);

  const today = new Date().toISOString().split('T')[0];
  const openRecord = await prisma.attendanceRecord.findFirst({
    where: { employeeId: best.id, date: today, timeOut: null }
  });
  if (!openRecord) {
    await prisma.attendanceRecord.create({
      data: { employeeId: best.id, date: today, timeIn: new Date(), confidence }
    });
  }

  await prisma.auditLog.create({
    data: {
      type: 'ACCESS_GRANTED',
      employeeId: best.id,
      confidence,
      notes: `Verified via face match (similarity ${bestSimilarity.toFixed(4)}) + liveness (avg score ${avgLiveness.toFixed(2)}).`,
      ipAddress
    }
  });

  res.json({
    token,
    employee: {
      id: best.id,
      employeeCode: best.employeeCode,
      name: best.name,
      department: best.department,
      role: best.role,
      clearance: best.clearance,
      avatarUrl: best.avatarUrl
    },
    confidence
  });
}));
