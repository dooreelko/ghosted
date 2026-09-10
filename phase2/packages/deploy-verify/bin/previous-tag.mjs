#!/usr/bin/env node
import { findPreviousTag } from '../src/previous-deployment.mjs';

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const tag = findPreviousTag(JSON.parse(input));
  if (!tag) {
    console.error('no previous deployment to roll back to');
    process.exit(3);
  }
  process.stdout.write(tag);
});
