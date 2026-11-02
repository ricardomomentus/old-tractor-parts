import initSqlJs from 'sql.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { dirname } from 'path';

let _db;
let _dbPath;

function save() {
  const data = _db.export();
  const tmp = `${_dbPath}.tmp`;
  writeFileSync(tmp, Buffer.from(data));
  renameSync(tmp, _dbPath);
}

export async function initDb(dbPath) {
  _dbPath = dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const buf = readFileSync(dbPath);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_brand TEXT,
      tractor_brand TEXT,
      tractor_model TEXT,
      part_type_es TEXT,
      part_type_en TEXT,
      part_number TEXT,
      oem_number TEXT,
      handwritten_numbers TEXT,
      measurement TEXT,
      quantity INTEGER,
      condition TEXT,
      confidence TEXT,
      all_visible_text TEXT,
      notes TEXT,
      weight_lbs REAL,
      box_length_in REAL,
      box_width_in REAL,
      box_height_in REAL,
      ship_weight_lbs REAL,
      ship_length_in REAL,
      ship_width_in REAL,
      ship_height_in REAL,
      location TEXT,
      price REAL,
      status TEXT DEFAULT 'pending',
      ebay_title TEXT,
      ebay_description TEXT,
      fb_title TEXT,
      fb_description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      posted_at TEXT,
      sold_at TEXT,
      ai_error TEXT,
      verification_match INTEGER,
      verification_diffs TEXT,
      vision_refs TEXT
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (part_id) REFERENCES parts(id)
    )
  `);

  save();

  return {
    prepare(sql) {
      return {
        run(...params) {
          _db.run(sql, params);
          const lastId = _db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0];
          save();
          return { lastInsertRowid: lastId };
        },
        get(...params) {
          const stmt = _db.prepare(sql);
          stmt.bind(params);
          let row = null;
          if (stmt.step()) {
            row = stmt.getAsObject();
          }
          stmt.free();
          return row || undefined;
        },
        all(...params) {
          const stmt = _db.prepare(sql);
          stmt.bind(params);
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          return rows;
        }
      };
    },
    exec(sql) {
      _db.run(sql);
      save();
    }
  };
}
