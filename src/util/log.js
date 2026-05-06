const noopLogger = { log: () => {}, warn: () => {} };

const consoleLogger = {
  log:  (fn, ...args) => console.log(`[${fn}]`,  ...args),
  warn: (fn, ...args) => console.warn(`[${fn}]`, ...args),
};

module.exports = { noopLogger, consoleLogger };