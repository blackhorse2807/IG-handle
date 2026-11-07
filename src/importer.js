// Contact import: turns an uploaded CSV or Excel (.xlsx) file into rows of strings, and phone
// numbers from those rows into the digits-only form used everywhere else (country code included).

const MAX_ROWS = 5000;

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

// Returns { phone } (digits, with country code) or { error } explaining why it can't be used.
// Numbers written without a country code get `countryCode`: 98765 43210 -> 919876543210.
function normalizePhone(raw, countryCode = "91") {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "empty" };
  // Excel shows long numbers as 9.19877E+11 when the column isn't formatted as text; the digits are lost.
  if (/\d[.,]?\d*e\+\d+/i.test(s)) return { error: "shortened by Excel (format the column as text)" };
  if (/[a-z]/i.test(s)) return { error: "not a phone number" };

  let digits = s.replace(/\D/g, "");
  const international = /^\s*\+/.test(s) || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);
  const cc = String(countryCode || "").replace(/\D/g, "");
  if (!international && cc) {
    if (digits.length === 11 && digits.startsWith("0")) digits = cc + digits.slice(1); // 098765 43210
    else if (digits.length === 10) digits = cc + digits;
  }
  if (digits.length < 10 || digits.length > 15) return { error: "wrong number of digits" };
  return { phone: digits };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

// RFC 4180 CSV with quoted fields; the delimiter (, ; or tab) is guessed from the first line.
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [",", ";", "\t"].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");

  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function parseXlsx(buffer) {
  const { readSheet } = require("read-excel-file/node");
  // parseNumber keeps numbers as the text Excel stored, so 919876543210 doesn't pass through a float.
  const sheet = await readSheet(buffer, { parseNumber: (s) => s, trim: true });
  return sheet.map((row) =>
    row.map((cell) => (cell == null ? "" : cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell)))
  );
}

// Returns { rows: string[][] } with empty rows dropped, or throws an Error with a message for the admin.
async function parseUpload(filename, buffer) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  let rows;
  if (ext === "csv" || ext === "txt") rows = parseCsv(buffer.toString("utf8"));
  else if (ext === "xlsx") {
    try {
      rows = await parseXlsx(buffer);
    } catch {
      throw new Error("Couldn't read this Excel file. Try saving it again as .xlsx or CSV.");
    }
  } else if (ext === "xls") throw new Error("Old .xls files aren't supported. In Excel, use File → Save As and pick .xlsx or CSV.");
  else throw new Error("Choose a .csv or .xlsx file.");

  rows = rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c));
  if (!rows.length) throw new Error("This file has no rows.");
  if (rows.length > MAX_ROWS + 1) throw new Error(`This file has ${rows.length} rows; import at most ${MAX_ROWS} at a time.`);
  return { rows };
}

module.exports = { normalizePhone, parseUpload, parseCsv, MAX_ROWS };
