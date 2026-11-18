// Parse generated JavaScript with the same maintained parser supplied by Vite.
import { pathToFileURL } from 'node:url';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { parser, files } = JSON.parse(input);
const { parseAst } = await import(pathToFileURL(parser).href);
const references = [];
const asset = /^(?:\.{1,2}\/|assets\/|\/[^?#]*assets\/)[^?#]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)(?:[?#].*)?$/;
for (const file of files) {
  const pending = [parseAst(file.source)];
  const seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    let value;
    let rootRelative = false;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) {
      value = node.source?.value;
      if (node.type === 'ImportExpression' && typeof value !== 'string') {
        throw new Error(`Unresolved dynamic import in ${file.name}`);
      }
    } else if (node.type === 'Literal' && typeof node.value === 'string' && asset.test(node.value)) {
      value = node.value;
      rootRelative = value.startsWith('assets/');
    }
    if (typeof value === 'string' && !seen.has(value)) {
      references.push({ source: file.name, value, rootRelative });
      seen.add(value);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child);
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
}
process.stdout.write(JSON.stringify(references));
