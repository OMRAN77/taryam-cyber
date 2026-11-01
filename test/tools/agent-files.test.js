'use strict';
// Unit tests for agent-files.js: parsing the assistant's file blocks, path safety,
// all-or-nothing application without mutating the input, preview inlining, and a
// zip that standard readers accept (checked by parsing it back and against zlib's CRC).
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const AF = require('../../agent-files.js');

const REPLY = [
  'سأضيف صفحة وتنسيقًا:',
  '<<<FILE path="index.html">>>',
  '<link rel="stylesheet" href="style.css"><h1>مرحبا</h1>',
  '<<<END>>>',
  '<<<FILE path="./style.css">>>',
  'h1 { color: red; }',
  '<<<END>>>',
  '<<<EDIT path="app.js">>>',
  '<<<SEARCH>>>',
  'const a = 1;',
  '<<<REPLACE>>>',
  'const a = 2;',
  '<<<SEARCH>>>',
  'log(a)',
  '<<<REPLACE>>>',
  'console.log(a)',
  '<<<END>>>',
  '<<<DELETE path="old.txt">>>',
  'تم.',
].join('\n');

test('parses FILE, EDIT (several pairs) and DELETE blocks and strips them from the text', () => {
  const { ops, text } = AF.parseOps(REPLY);
  assert.deepStrictEqual(ops.map((o) => [o.type, o.path]), [
    ['write', 'index.html'], ['write', 'style.css'], ['edit', 'app.js'], ['delete', 'old.txt'],
  ]);
  assert.strictEqual(ops[0].content, '<link rel="stylesheet" href="style.css"><h1>مرحبا</h1>');
  assert.deepStrictEqual(ops[2].edits, [
    { search: 'const a = 1;', replace: 'const a = 2;' },
    { search: 'log(a)', replace: 'console.log(a)' },
  ]);
  assert.strictEqual(text, 'سأضيف صفحة وتنسيقًا:\n\nتم.');
});

test('a reply without blocks yields no ops and the text unchanged', () => {
  const { ops, text } = AF.parseOps('مجرد شرح بدون ملفات.');
  assert.deepStrictEqual(ops, []);
  assert.strictEqual(text, 'مجرد شرح بدون ملفات.');
});

test('an unterminated block is not guessed at', () => {
  const { ops, text } = AF.parseOps('قبل\n<<<FILE path="a.txt">>>\nبدون نهاية');
  assert.deepStrictEqual(ops, []);
  assert.match(text, /بدون نهاية/);
});

test('unsafe paths are rejected', () => {
  for (const bad of ['/etc/passwd', '../secret', 'a/../../b', 'C:\\win.ini', 'a//b', '', 'a\u0000b', 'x'.repeat(201)]) {
    assert.strictEqual(AF.safePath(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(AF.safePath('./src\\app.js'), 'src/app.js');
  const { ops } = AF.parseOps('<<<FILE path="../../evil.js">>>\nx\n<<<END>>>');
  const r = AF.applyOps({}, ops);
  assert.strictEqual(r.results[0].ok, false);
  assert.strictEqual(r.results[0].error, 'invalid path');
  assert.deepStrictEqual(r.files, {});
});

test('applies ops in order to a copy and reports per-file stats', () => {
  const before = { 'app.js': 'const a = 1;\nlog(a)\n', 'old.txt': 'x\ny' };
  const frozen = JSON.stringify(before);
  const { ops } = AF.parseOps(REPLY);
  const { files, results } = AF.applyOps(before, ops);
  assert.strictEqual(JSON.stringify(before), frozen, 'input is not mutated');
  assert.deepStrictEqual(Object.keys(files).sort(), ['app.js', 'index.html', 'style.css']);
  assert.strictEqual(files['app.js'], 'const a = 2;\nconsole.log(a)\n');
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.strictEqual(results[0].created, true);
  assert.deepStrictEqual([results[2].added, results[2].removed], [2, 2]);
  assert.strictEqual(results[3].removed, 2);
});

test('an EDIT is all-or-nothing: a missing or ambiguous SEARCH leaves the file untouched', () => {
  const files = { 'a.js': 'x = 1;\nx = 1;\ny = 2;' };
  const missing = AF.applyOps(files, [{ type: 'edit', path: 'a.js', edits: [{ search: 'y = 2;', replace: 'y = 3;' }, { search: 'nope', replace: '' }] }]);
  assert.strictEqual(missing.results[0].error, 'search text not found');
  assert.strictEqual(missing.files['a.js'], files['a.js']);
  const ambiguous = AF.applyOps(files, [{ type: 'edit', path: 'a.js', edits: [{ search: 'x = 1;', replace: 'x = 9;' }] }]);
  assert.match(ambiguous.results[0].error, /matches 2 places/);
  assert.strictEqual(ambiguous.files['a.js'], files['a.js']);
});

test('a SEARCH that matches in two overlapping places is ambiguous too', () => {
  // '}\n}' starts at index 1 and again at index 3 of 'x}\n}\n}'.
  const { ops } = AF.parseOps('<<<EDIT path="a">>>\n<<<SEARCH>>>\n}\n}\n<<<REPLACE>>>\nZ\n<<<END>>>');
  const braces = AF.applyOps({ a: 'x}\n}\n}' }, ops);
  assert.strictEqual(braces.results[0].ok, false);
  assert.match(braces.results[0].error, /matches 2 places/);
  assert.strictEqual(braces.files.a, 'x}\n}\n}');
  const runs = AF.applyOps({ a: 'aaa' }, [{ type: 'edit', path: 'a', edits: [{ search: 'aa', replace: 'b' }] }]);
  assert.match(runs.results[0].error, /matches 2 places/);
  // A unique match is still applied.
  const unique = AF.applyOps({ a: 'f() {\n  g() {\n  }\n}\n' }, [{ type: 'edit', path: 'a', edits: [{ search: '  }\n}', replace: '  }\n};' }] }]);
  assert.strictEqual(unique.results[0].ok, true, unique.results[0].error);
  assert.strictEqual(unique.files.a, 'f() {\n  g() {\n  }\n};\n');
});

test('REPLACE text containing $& or $1 is inserted literally', () => {
  const r = AF.applyOps({ 'a.txt': 'price' }, [{ type: 'edit', path: 'a.txt', edits: [{ search: 'price', replace: 'cost $& $1' }] }]);
  assert.strictEqual(r.files['a.txt'], 'cost $& $1');
});

test('editing or deleting a missing file fails cleanly', () => {
  const r = AF.applyOps({}, [{ type: 'delete', path: 'x' }, { type: 'edit', path: 'y', edits: [{ search: 'a', replace: 'b' }] }]);
  assert.deepStrictEqual(r.results.map((x) => x.error), ['file not found', 'file not found']);
});

test('inlines local CSS/JS for the preview and leaves external URLs alone', () => {
  const files = { 'style.css': 'h1{color:red}', 'js/app.js': 'alert("</script>")' };
  const html = '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://cdn.example/x.css">'
    + '<script src="js/app.js"></script><script src="https://cdn.example/y.js"></script>';
  const out = AF.inlineAssets(html, files);
  assert.match(out, /<style data-src="style.css">\nh1\{color:red\}\n<\/style>/);
  assert.match(out, /href="https:\/\/cdn.example\/x.css"/);
  assert.match(out, /<script data-src="js\/app.js">\nalert\("<\\\/script>"\)\n<\/script>/);
  assert.match(out, /<script src="https:\/\/cdn.example\/y.js"><\/script>/);
  // Passing the root page's own path changes nothing.
  assert.strictEqual(AF.inlineAssets(html, files, 'index.html'), out);
});

test('refs resolve from the HTML file\'s folder, like a browser would', () => {
  const files = {
    'site/index.html': '',
    'site/style.css': 'body{margin:0}',
    'site/app.js': 'go()',
    'css/shared.css': 'h1{}',
    'lib/x.js': 'x()',
    'style.css': 'ROOT',
  };
  const html = '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="../css/shared.css">'
    + '<script src="./app.js"></script><script src="/lib/x.js"></script>';
  const page = AF.mainHtml(files);
  assert.strictEqual(page, 'site/index.html');
  const out = AF.inlineAssets(html, files, page);
  assert.match(out, /<style data-src="site\/style.css">\nbody\{margin:0\}\n<\/style>/);
  assert.doesNotMatch(out, /ROOT/, 'the root style.css is not the sibling one');
  assert.match(out, /<style data-src="css\/shared.css">\nh1\{\}\n<\/style>/);
  assert.match(out, /<script data-src="site\/app.js">\ngo\(\)\n<\/script>/);
  assert.match(out, /<script data-src="lib\/x.js">\nx\(\)\n<\/script>/, 'a leading / means the project root');
  // '..' past the project root is never resolved, even if a file of that name exists.
  const up = '<link rel="stylesheet" href="../../style.css"><script src="../app.js"></script>';
  assert.strictEqual(AF.inlineAssets(up, { 'pages/a.html': '', 'style.css': 'x', 'app.js': 'y' }, 'pages/a.html'),
    '<link rel="stylesheet" href="../../style.css"><script data-src="app.js">\ny\n</script>');
  assert.strictEqual(AF.inlineAssets('<script src="../app.js"></script>', { 'app.js': 'y' }),
    '<script src="../app.js"></script>');
});

test('mainHtml prefers index.html', () => {
  assert.strictEqual(AF.mainHtml({ 'b.html': '', 'index.html': '' }), 'index.html');
  assert.strictEqual(AF.mainHtml({ 'z.html': '', 'a.htm': '' }), 'a.htm');
  assert.strictEqual(AF.mainHtml({ 'main.py': '' }), null);
});

test('filesContext lists files and names the ones over budget', () => {
  const ctx = AF.filesContext({ 'a.txt': 'short', 'b.txt': 'x'.repeat(100) }, 50);
  assert.match(ctx, /--- a.txt ---\nshort/);
  assert.match(ctx, /not shown[\s\S]*b.txt \(100 chars\)/);
});

test('zip output parses back to the same files with correct CRCs', () => {
  const files = { 'index.html': '<h1>مرحبا</h1>', 'src/app.js': 'console.log(1)\n' };
  const buf = Buffer.from(AF.zip(files, new Date(2026, 10, 1, 12, 0, 0)));
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0);
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  assert.strictEqual(count, 2);
  const seen = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(cd), 0x02014b50);
    const crc = buf.readUInt32LE(cd + 16);
    const size = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.slice(cd + 46, cd + 46 + nameLen).toString('utf8');
    assert.strictEqual(buf.readUInt32LE(lho), 0x04034b50);
    const lnameLen = buf.readUInt16LE(lho + 26);
    const data = buf.slice(lho + 30 + lnameLen, lho + 30 + lnameLen + size);
    assert.strictEqual(zlib.crc32(data), crc, 'crc of ' + name);
    seen[name] = data.toString('utf8');
    cd += 46 + nameLen;
  }
  assert.deepStrictEqual(seen, files);
});
