(() => {
  if (!/^\/auth\/oauth\/(google|discord|github)\/callback$/.test(location.pathname)) return;
  const query = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  for (const key of ['code', 'state', 'error']) if (query.has(key)) params.set(key, query.get(key).slice(0, 4096));
  location.replace(location.pathname.replace(/callback$/, 'finish') + '?' + params);
})();
