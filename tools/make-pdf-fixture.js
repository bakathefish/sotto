'use strict';

// Prints a one-line page to test/fixtures/sample.pdf.
// Run: npx electron tools/make-pdf-fixture.js

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<p style="font:20px sans-serif">The battery limit is 4.2 V</p>');
  const out = path.join(__dirname, '..', 'test', 'fixtures', 'sample.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await win.webContents.printToPDF({ pageSize: 'A6' }));
  console.log(`wrote ${out}`);
  app.exit(0);
});
