import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'change-me-in-production';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Accept token from Authorization header OR ?token= query param (needed for EventSource/SSE)
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);

  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }

  try {
    jwt.verify(token, getJwtSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
