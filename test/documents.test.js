'use strict';

// The Word file is built here from scratch. The PDF is a small fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readKnowledgeFile } = require('../src/main/knowledge');
const { buildContext } = require('../src/core/retrieval');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sotto-doc-'));

// A minimal .docx: a zip with three XML parts. jszip ships with mammoth.
async function makeDocx(paragraphs) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('knowledge: reads the text of a PDF', async () => {
  // Made by tools/make-pdf-fixture.js.
  const file = path.join(__dirname, 'fixtures', 'sample.pdf');
  const result = await readKnowledgeFile(file);
  assert.equal(result.error, undefined);
  assert.match(result.text, /The battery limit is 4\.2 V/);
});

test('knowledge: reads the text of a Word file', async () => {
  const file = path.join(tmpDir(), 'notes.docx');
  fs.writeFileSync(file, await makeDocx(['Sample size is 151 sources.', 'Second paragraph.']));
  const result = await readKnowledgeFile(file);
  assert.equal(result.error, undefined);
  assert.match(result.text, /Sample size is 151 sources\./);
  assert.match(result.text, /Second paragraph\./);
});

test('knowledge: a broken PDF reports an error instead of throwing', async () => {
  const file = path.join(tmpDir(), 'broken.pdf');
  fs.writeFileSync(file, 'this is not a pdf');
  const result = await readKnowledgeFile(file);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.text, undefined);
});

test('knowledge: a set over the budget is searched and the matching passage is sent', async () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} talks about gardening, soil and watering schedules.`).join('\n\n');
  const files = [
    { name: 'garden.md', text: filler },
    { name: 'rocket.md', text: `${filler}\n\nThe igniter continuity threshold is 2.7 ohms.\n\n${filler}` },
  ];
  const context = buildContext(files, 'what is the igniter continuity threshold', 1500);
  assert.equal(context.mode, 'retrieved');
  assert.match(context.text, /igniter continuity threshold is 2\.7 ohms/);
  assert.ok(context.text.length < filler.length, 'only part of the files is sent');
});
