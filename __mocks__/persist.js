module.exports = {
  saveSession: () => Promise.resolve(),
  loadSession: () => Promise.resolve(null),
  hasSession: () => Promise.resolve(false),
  clearSession: () => Promise.resolve(),
};
