// RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines
// (Epoch's "Selected Sources" column holds all three). Rows come back as
// records keyed by the header row.

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (quoted) throw new Error('unterminated quoted field')
  if (field !== '' || row.length > 0) rows.push([...row, field])
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '')
  if (!header) throw new Error('empty CSV')
  return body.map((r) => {
    if (r.length !== header.length) {
      throw new Error(`row has ${r.length} fields, header has ${header.length}`)
    }
    return Object.fromEntries(header.map((h, i) => [h, r[i]!]))
  })
}
