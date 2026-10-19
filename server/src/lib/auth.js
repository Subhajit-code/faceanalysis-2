import jwt from 'jsonwebtoken';

export function signAdminToken(admin) {
  return jwt.sign({ sub: admin.id, email: admin.email, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '8h'
  });
}

export function signEmployeeSessionToken(employee) {
  return jwt.sign({ sub: employee.id, role: 'employee' }, process.env.JWT_SECRET, {
    expiresIn: '15m' // short-lived; dashboard activity should refresh it
  });
}

export function requireAuth(requiredRole) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing authorization token' });

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (requiredRole && payload.role !== requiredRole) {
        return res.status(403).json({ error: 'Insufficient privileges' });
      }
      req.auth = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
