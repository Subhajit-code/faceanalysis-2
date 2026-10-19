import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { authRouter } from './routes/auth.js';
import { verifyRouter } from './routes/verify.js';
import { enrollRouter } from './routes/enroll.js';
import { employeesRouter } from './routes/employees.js';
import { attendanceRouter } from './routes/attendance.js';
import { auditRouter } from './routes/audit.js';

const app = express();

app.use(helmet());

if (!process.env.ALLOWED_ORIGIN) {
  console.warn('ALLOWED_ORIGIN is not set — CORS will reject all cross-origin browser requests. Set it to your frontend URL.');
}
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false, credentials: true }));
app.use(express.json({ limit: '8mb' })); // frames as base64 JPEG can be a few MB
app.set('trust proxy', 1); // required for req.ip to be correct behind a reverse proxy

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRouter);
app.use('/api', verifyRouter);
app.use('/api', enrollRouter);
app.use('/api', employeesRouter);
app.use('/api', attendanceRouter);
app.use('/api', auditRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Sentinel API listening on :${port}`));
