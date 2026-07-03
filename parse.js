// Phân tích file tải lên. Chạy hoàn toàn server-side (không CDN/thư viện ngoài trình duyệt).
//  - Bảng (.xlsx/.csv): mỗi dòng -> 1 bản ghi linh hoạt, cột = tên trường (không đóng cứng).
//  - Văn bản (.pdf/.docx/.txt/.md): trích text để đưa vào kho tri thức.
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse'); // pdf-parse v2: dùng class PDFParse

const SPREADSHEET = ['xlsx', 'xlsm', 'csv'];
const TEXTFILE = ['pdf', 'docx', 'txt', 'md'];

function extOf(filename) {
  return (filename.split('.').pop() || '').toLowerCase();
}
function fileKind(filename) {
  const e = extOf(filename);
  if (SPREADSHEET.includes(e)) return 'spreadsheet';
  if (TEXTFILE.includes(e)) return 'text';
  return null;
}

// ================= BẢNG (Excel/CSV) =================
async function parseSpreadsheet(filename, buffer) {
  const e = extOf(filename);
  if (e === 'csv') return parseCsv(buffer.toString('utf8'));
  return await parseXlsx(buffer);
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('File Excel không có sheet nào.');
  const colCount = ws.columnCount;
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      arr.push(cell && cell.text != null ? String(cell.text).trim() : '');
    }
    rows.push(arr);
  });
  return { sheetName: ws.name, ...splitHeader(rows) };
}

function parseCsv(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const first = clean.split('\n')[0] || '';
  const delim = (first.split(';').length > first.split(',').length) ? ';' : ',';
  const rows = clean.split('\n').map((line) => parseCsvLine(line, delim));
  return { sheetName: '', ...splitHeader(rows) };
}

function parseCsvLine(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function splitHeader(rows) {
  const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));
  if (!nonEmpty.length) throw new Error('File rỗng.');
  return { headers: nonEmpty[0], rows: nonEmpty.slice(1) };
}

// Mỗi dòng -> { collection, data: { <tên cột>: <giá trị>, ... } }. Không đóng cứng trường nào.
function rowsToRecords(headers, rows, collection) {
  const keys = headers.map((h, i) => (h || '').trim() || 'cột_' + (i + 1));
  const records = [];
  for (const row of rows) {
    const data = {};
    let hasValue = false;
    for (let i = 0; i < keys.length; i++) {
      const val = (row[i] || '').trim();
      if (val) { data[keys[i]] = val; hasValue = true; }
    }
    if (hasValue) records.push({ collection: collection || 'chung', data });
  }
  return records;
}

// ================= VĂN BẢN (PDF/Word/TXT) =================
async function extractText(filename, buffer) {
  const stripNull = (s) => (s || '').split(String.fromCharCode(0)).join(''); // Postgres không lưu 0x00
  const e = extOf(filename);
  if (e === 'txt' || e === 'md') return stripNull(buffer.toString('utf8'));
  if (e === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return stripNull(value);
  }
  if (e === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      // bỏ dấu phân trang thư viện tự chèn: "-- 1 of 3 --"
      return stripNull((result.text || '').replace(/[ \t]*--\s*\d+\s+of\s+\d+\s*--[ \t]*/g, '\n'));
    } finally {
      await parser.destroy();
    }
  }
  throw new Error('Định dạng văn bản không hỗ trợ: .' + e);
}

module.exports = { fileKind, parseSpreadsheet, rowsToRecords, extractText };
