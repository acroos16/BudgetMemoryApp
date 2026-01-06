import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';

const dbPath = path.join(app.getPath('userData'), 'budget_memory.db');
const db = new Database(dbPath);

// Tabla de Memoria (Costos históricos)
db.exec(`
  CREATE TABLE IF NOT EXISTS cost_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    category TEXT,
    unit TEXT,
    unit_cost REAL,
    currency TEXT,
    year INTEGER,
    source_file TEXT,
    donor TEXT,
    exchange_rate_used REAL
  );
`);

// NUEVA TABLA: Proyectos Guardados (Borradores de trabajo)
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    donor TEXT,
    currency TEXT,
    country TEXT,
    sector TEXT,
    duration INTEGER,
    data_json TEXT, 
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export function searchCost(query) {
  return db.prepare("SELECT * FROM cost_memory WHERE description LIKE ? ORDER BY year DESC LIMIT 20").all(`%${query}%`);
}

export function addCost(item) {
  const stmt = db.prepare(`INSERT INTO cost_memory (description, category, unit, unit_cost, currency, year, source_file, donor, exchange_rate_used) VALUES (@description, @category, @unit, @unit_cost, @currency, @year, @source_file, @donor, @exchange_rate_used)`);
  return stmt.run(item);
}

// Funciones para Proyectos
export function saveProjectDB(p) {
  return db.prepare(`INSERT INTO saved_projects (name, donor, currency, country, sector, duration, data_json) VALUES (@name, @donor, @currency, @country, @sector, @duration, @data_json)`).run(p);
}

// Asegúrate de que diga "export function"
export function getAllProjects() {
  try {
    const projects = db.prepare("SELECT * FROM saved_projects ORDER BY updated_at DESC").all();
    return projects;
  } catch (error) {
    console.error("Error al leer la tabla saved_projects:", error);
    return [];
  }
}

export default db;