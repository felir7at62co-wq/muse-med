/** Deterministic real Word container for the delivery reader, independent of exporter tooling. */
import { importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const { strToU8, zipSync } = await importSnapshotPackage('fflate', new URL('../../../package.json', import.meta.url))

/** @param {string} text - Main-body lines. @returns {Uint8Array} Word package with those exact paragraphs. */
export function manuscriptDocx(text) {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const body = text.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join('')
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`),
  }, { mtime: new Date(2000, 0, 1) })
}
