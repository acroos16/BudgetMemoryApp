const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3001; // El servidor correrá en el puerto 3001

// Middlewares (Permisos)
app.use(cors());
app.use(express.json());

// --- 1. CONEXIÓN A BASE DE DATOS (Se creará sola) ---
const db = new sqlite3.Database('./budgetcat.db', (err) => {
  if (err) console.error('❌ Error DB:', err.message);
  else console.log('✅ Base de datos conectada (budgetcat.db)');
});

// --- 2. CREAR TABLA SI NO EXISTE ---
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      donor TEXT,
      data_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// --- 3. RUTAS (API) ---

// Prueba de vida
app.get('/', (req, res) => res.send('Backend BudgetCAT funcionando 🚀'));

// LEER PROYECTOS
app.get('/projects', (req, res) => {
  db.all("SELECT * FROM projects ORDER BY created_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GUARDAR PROYECTO
app.post('/projects', (req, res) => {
  const { id, name, donor, data_json } = req.body;
  const sql = `INSERT OR REPLACE INTO projects (id, name, donor, data_json) VALUES (?, ?, ?, ?)`;
  db.run(sql, [id, name, donor, data_json], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Guardado", id });
  });
});

// ELIMINAR PROYECTO
app.delete('/projects/:id', (req, res) => {
    db.run("DELETE FROM projects WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Eliminado" });
    });
});

// --- 4. ENCENDER ---
app.listen(port, () => {
  console.log(`✅ Servidor listo en http://localhost:${port}`);
});