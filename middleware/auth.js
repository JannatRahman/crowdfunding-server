const { getDB } = require('../config/db');
const { ObjectId } = require('mongodb');

async function authenticate(req, res, next) {
  try {
    const sessionCookie = req.headers.cookie?.split(';')
      .find(c => c.trim().startsWith('better-auth.session_token='));

    if (!sessionCookie) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = sessionCookie.split('=')[1]?.trim();
    if (!token) {
      return res.status(401).json({ error: 'Invalid session token' });
    }

    const db = getDB();
    const session = await db.collection('session').findOne({ token });

    if (!session || new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const user = await db.collection('user').findOne({ _id: new ObjectId(session.userId) });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role || 'supporter',
      image: user.image,
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

function optionalAuth(req, res, next) {
  const sessionCookie = req.headers.cookie?.split(';')
    .find(c => c.trim().startsWith('better-auth.session_token='));

  if (!sessionCookie) {
    req.user = null;
    return next();
  }

  return authenticate(req, res, next);
}

module.exports = { authenticate, optionalAuth };
