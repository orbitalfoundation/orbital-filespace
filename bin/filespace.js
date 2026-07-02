#!/usr/bin/env node
import { run } from '../src/cli.js';

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
