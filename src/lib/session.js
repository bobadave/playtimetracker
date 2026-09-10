function getSessionUserId(req) {
  const userId = Number(req.session?.userId);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function requireAuth(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  return next();
}

module.exports = {
  getSessionUserId,
  requireAuth
};
