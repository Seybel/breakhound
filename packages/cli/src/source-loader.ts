import loader from '@breakhound/source/webpack-loader';

// Built only as CommonJS: webpack and Turbopack require() this file by path,
// and module.exports being the loader itself works with every loader runner.
module.exports = loader;
