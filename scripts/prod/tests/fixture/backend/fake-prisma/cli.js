#!/usr/bin/env node

const fs = require('fs');
const command = process.argv.slice(2).join(' ');
if (command === 'migrate deploy' && fs.existsSync('FAIL_MIGRATION')) {
  console.error('fixture migration failure');
  process.exit(42);
}
if (command === 'migrate status') {
  console.log('Database schema is up to date!');
} else {
  console.log(`fixture prisma: ${command}`);
}
