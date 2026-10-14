#!/usr/bin/env node
// Runs before anything else loads, in syntax any Node can read, so an old
// Node gets a clear message instead of a syntax error from the real CLI.
'use strict';

var need = [20, 16];
var have = process.versions.node.split('.').map(Number);
if (have[0] < need[0] || (have[0] === need[0] && have[1] < need[1])) {
  console.error(
    'breakhound needs Node.js ' +
      need.join('.') +
      ' or newer, and this is ' +
      process.version +
      '.\n' +
      'Install the current LTS from https://nodejs.org (or run: nvm install --lts), then try again.',
  );
  process.exit(1);
}

var path = require('node:path');
var url = require('node:url');
// The CLI is an ES module. Wrapped in a function so old Nodes never parse import().
new Function('file', 'return import(file)')(
  url.pathToFileURL(path.join(__dirname, '..', 'dist', 'cli.js')).href,
);
