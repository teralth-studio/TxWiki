function requirePrimaryAdmin(findUser) {
  return async (req, res, next) => {
    try {
      const user = await findUser(req.session.user.id);
      if (!user || !user.is_primary_admin)
        return res.status(403).json({ error: 'Solo el administrador principal puede configurar SMTP.' });
      next();
    } catch (error) {
      next(error);
    }
  };
}

function resolveSmtpPassword(input, current) {
  if (input.password) return input.password;
  if (!input.user) return '';
  if (
    input.host !== current.host ||
    input.port !== current.port ||
    input.secure !== current.secure ||
    input.user !== current.user
  ) {
    if (current.password)
      throw Object.assign(new Error('Introduce la contraseña SMTP al cambiar el servidor, puerto, seguridad o usuario.'), { status: 400 });
    return '';
  }
  return current.password || '';
}

module.exports = { requirePrimaryAdmin, resolveSmtpPassword };
