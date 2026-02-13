#!/usr/bin/env node
/**
 * Schema Integrity Test
 * 
 * Purpose: Detect mismatches between DB schema (from migrations) and SQL in TypeScript source.
 * Run: node scripts/check-schema.mjs
 * 
 * What it does:
 * 1. Applies all migrations to an in-memory SQLite DB
 * 2. Extracts table schemas via PRAGMA table_info
 * 3. Parses SQL statements from .ts source files
 * 4. Compares column references against actual schema
 * 5. Reports missing columns, unknown tables
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve('migrations');
const SRC_DIR = path.resolve('src');
const SNAPSHOT_FILE = path.resolve('docs/db_snapshot_production_2026-02-13.sql');

// ============================================================
// Step 1: Build schema from production snapshot (preferred) or migrations (fallback)
// ============================================================

function buildSchema() {
  const db = new Database(':memory:');
  
  // Prefer production snapshot if available
  if (fs.existsSync(SNAPSHOT_FILE)) {
    console.log(`\n📸 Using production schema snapshot: ${path.basename(SNAPSHOT_FILE)}`);
    const snapshotSQL = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    // Split by semicolons and execute each CREATE TABLE
    const statements = snapshotSQL.split(';').filter(s => s.trim());
    let applied = 0;
    for (const stmt of statements) {
      try {
        db.exec(stmt + ';');
        applied++;
      } catch (e) {
        // Skip non-CREATE statements
      }
    }
    console.log(`   Applied ${applied} CREATE TABLE statements from snapshot`);
  } else {
    console.log(`\n📦 No snapshot found, building from migrations...`);
    // Fallback: apply migrations
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && /^\d{4}_/.test(f))
      .sort();
    
    let applied = 0;
    let errors = [];
    
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        db.exec(sql);
        applied++;
      } catch (e) {
        errors.push({ file, error: e.message });
      }
    }
    
    console.log(`   Applied ${applied}/${files.length} migrations`);
    if (errors.length > 0) {
      console.log(`   \u26a0\ufe0f ${errors.length} migration error(s) (non-fatal)`);
    }
  }
  
  // Extract schema
  const tables = {};
  const tableNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'"
  ).all().map(r => r.name);
  
  for (const table of tableNames) {
    const columns = db.prepare(`PRAGMA table_info('${table}')`).all();
    tables[table] = columns.map(c => c.name);
  }
  
  db.close();
  return tables;
}

// ============================================================
// Step 2: Extract SQL from TypeScript source
// ============================================================

function extractSQLFromSource() {
  const sqlStatements = [];
  
  function scanDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        
        // Match template literals with SQL
        // Pattern: .prepare(`...`) or .prepare("...") or .exec(`...`)
        const patterns = [
          /\.prepare\(\s*`([^`]+)`/g,
          /\.prepare\(\s*"([^"]+)"/g,
          /\.prepare\(\s*'([^']+)'/g,
          /\.exec\(\s*`([^`]+)`/g,
        ];
        
        for (const regex of patterns) {
          let match;
          while ((match = regex.exec(content)) !== null) {
            sqlStatements.push({
              file: path.relative('.', fullPath),
              sql: match[1],
              offset: match.index,
            });
          }
        }
      }
    }
  }
  
  scanDir(SRC_DIR);
  return sqlStatements;
}

// ============================================================
// Step 3: Parse SQL to find table/column references
// ============================================================

function parseSQLReferences(sql) {
  const refs = [];
  const cleanSQL = sql
    .replace(/\$\{[^}]+\}/g, 'PLACEHOLDER')  // Remove template expressions
    .replace(/--[^\n]*/g, '')                   // Remove comments
    .replace(/\s+/g, ' ')                       // Normalize whitespace
    .toUpperCase();
  
  // SELECT ... FROM table
  const fromPattern = /FROM\s+(\w+)/gi;
  let m;
  while ((m = fromPattern.exec(cleanSQL)) !== null) {
    const table = m[1].toLowerCase();
    if (table !== 'placeholder') refs.push({ table, type: 'FROM' });
  }
  
  // JOIN table
  const joinPattern = /JOIN\s+(\w+)/gi;
  while ((m = joinPattern.exec(cleanSQL)) !== null) {
    const table = m[1].toLowerCase();
    if (table !== 'placeholder') refs.push({ table, type: 'JOIN' });
  }
  
  // INSERT INTO table (col1, col2, ...)
  const insertPattern = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)/gi;
  while ((m = insertPattern.exec(cleanSQL)) !== null) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(',').map(c => c.trim().toLowerCase()).filter(c => c && c !== 'placeholder');
    for (const col of cols) {
      refs.push({ table, column: col, type: 'INSERT' });
    }
  }
  
  // UPDATE table SET col1 = ..., col2 = ...
  const updatePattern = /UPDATE\s+(\w+)\s+SET\s+([^WHERE]+)/gi;
  while ((m = updatePattern.exec(cleanSQL)) !== null) {
    const table = m[1].toLowerCase();
    const setClauses = m[2].split(',');
    for (const clause of setClauses) {
      const colMatch = clause.match(/^\s*(\w+)\s*=/);
      if (colMatch) {
        const col = colMatch[1].toLowerCase();
        if (col !== 'placeholder') refs.push({ table, column: col, type: 'UPDATE' });
      }
    }
  }
  
  // WHERE / AND / OR col = ... (with table alias handling)
  const wherePattern = /(?:WHERE|AND|OR|ON)\s+(?:(\w+)\.)?(\w+)\s*(?:=|<|>|IS|IN|LIKE|BETWEEN|NOT)/gi;
  while ((m = wherePattern.exec(cleanSQL)) !== null) {
    const col = m[2].toLowerCase();
    if (!['select', 'from', 'where', 'and', 'or', 'not', 'null', 'placeholder', 'case', 'when', 'then', 'else', 'end'].includes(col)) {
      refs.push({ column: col, type: 'WHERE', alias: m[1]?.toLowerCase() });
    }
  }
  
  return refs;
}

// ============================================================
// Step 4: Validate references against schema
// ============================================================

function validate(schema, sqlStatements) {
  const issues = [];
  const knownTables = Object.keys(schema);
  
  // Common SQL keywords to ignore
  const IGNORE_COLS = new Set([
    'current_timestamp', 'null', 'not', 'true', 'false', 'case', 'when', 'then', 'else', 'end',
    'select', 'from', 'where', 'and', 'or', 'as', 'on', 'join', 'left', 'inner', 'group', 'order',
    'by', 'having', 'limit', 'offset', 'union', 'all', 'distinct', 'count', 'sum', 'avg', 'min', 'max',
    'exists', 'in', 'between', 'like', 'is', 'asc', 'desc', 'insert', 'into', 'values', 'update', 'set',
    'delete', 'create', 'table', 'if', 'index', 'primary', 'key', 'autoincrement', 'integer', 'text',
    'real', 'blob', 'default', 'unique', 'check', 'foreign', 'references', 'cascade', 'datetime',
    'placeholder', 'now', 'coalesce', 'julianday', 'replace',
  ]);
  
  for (const stmt of sqlStatements) {
    const refs = parseSQLReferences(stmt.sql);
    
    for (const ref of refs) {
      // Check table exists
      if (ref.table && !knownTables.includes(ref.table) && ref.table !== 'placeholder') {
        // Skip if it looks like an alias or subquery
        if (!ref.table.match(/^[a-z]{1,3}$/) && ref.type !== 'WHERE') {
          issues.push({
            file: stmt.file,
            type: 'UNKNOWN_TABLE',
            table: ref.table,
            detail: `Table "${ref.table}" not found in schema (${ref.type})`,
          });
        }
      }
      
      // Check column exists in table
      if (ref.table && ref.column && schema[ref.table] && !IGNORE_COLS.has(ref.column)) {
        if (!schema[ref.table].includes(ref.column)) {
          issues.push({
            file: stmt.file,
            type: 'MISSING_COLUMN',
            table: ref.table,
            column: ref.column,
            detail: `Column "${ref.table}.${ref.column}" not found in schema. Available: ${schema[ref.table].join(', ')}`,
          });
        }
      }
    }
  }
  
  return issues;
}

// ============================================================
// Main
// ============================================================

console.log('🔍 Schema Integrity Check');
console.log('='.repeat(60));

const schema = buildSchema();
console.log(`\n📋 Tables found: ${Object.keys(schema).length}`);
for (const [table, cols] of Object.entries(schema)) {
  console.log(`   ${table}: ${cols.length} columns`);
}

const sqlStatements = extractSQLFromSource();
console.log(`\n📝 SQL statements found: ${sqlStatements.length}`);

const issues = validate(schema, sqlStatements);

console.log('\n' + '='.repeat(60));
if (issues.length === 0) {
  console.log('✅ No schema mismatches detected!');
  process.exit(0);
} else {
  console.log(`❌ Found ${issues.length} potential issue(s):\n`);
  
  const byFile = {};
  for (const issue of issues) {
    byFile[issue.file] = byFile[issue.file] || [];
    byFile[issue.file].push(issue);
  }
  
  for (const [file, fileIssues] of Object.entries(byFile)) {
    console.log(`📄 ${file}:`);
    for (const issue of fileIssues) {
      const icon = issue.type === 'MISSING_COLUMN' ? '🔴' : '🟡';
      console.log(`   ${icon} ${issue.detail}`);
    }
    console.log();
  }
  
  // Only fail on MISSING_COLUMN (real errors), not UNKNOWN_TABLE (may be aliases)
  const realErrors = issues.filter(i => i.type === 'MISSING_COLUMN');
  if (realErrors.length > 0) {
    console.log(`\n❌ ${realErrors.length} MISSING_COLUMN error(s) — these will cause runtime failures!`);
    process.exit(1);
  } else {
    console.log(`\n⚠️  ${issues.length} warning(s) only (no critical errors)`);
    process.exit(0);
  }
}
