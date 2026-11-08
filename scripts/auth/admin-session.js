function requireCurrentAdminSession(findUser) {
  return async (req, res, next) => {
    const userId = req.session?.user?.id;
    if (!/^[1-9]\d{0,19}$/.test(String(userId ?? ''))) {
      return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    }
    try {
      const user = await findUser(userId);
      if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
      if (user.must_change_password) {
        return res.status(428).json({ error: 'Cambia tu contraseña para continuar.' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { requireCurrentAdminSession };
