/** Route guards. Each redirects rather than 403s, so the UI stays friendly. */

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    req.flash('error', 'Sign in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.session.user) return requireLogin(req, res, next);
  if (req.session.user.role !== 'student') return res.redirect('/admin');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return requireLogin(req, res, next);
  if (req.session.user.role !== 'admin') {
    req.flash('error', 'That area is for property office staff.');
    return res.redirect('/dashboard');
  }
  next();
}

function redirectIfLoggedIn(req, res, next) {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/dashboard');
  }
  next();
}

module.exports = { requireLogin, requireStudent, requireAdmin, redirectIfLoggedIn };
