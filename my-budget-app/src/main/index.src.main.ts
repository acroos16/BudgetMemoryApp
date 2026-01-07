import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as XLSX from 'xlsx'
import Database from 'better-sqlite3'
import { analyzeBudgetRows } from './aiService' 


// ---------------------------------------------------------
// 1. CONFIGURACIÓN BASE DE DATOS (SQLITE)
// ---------------------------------------------------------
const dbPath = join(app.getPath('userData'), 'budgetcat.db')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

// Inicialización de tablas 
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    donor TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_json TEXT
  );

  CREATE TABLE IF NOT EXISTS cost_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    category TEXT,
    unit TEXT,
    unit_cost REAL,
    currency TEXT,
    year INTEGER,
    sector TEXT,
    donor TEXT,
    source_project_id TEXT
  );

  CREATE TABLE IF NOT EXISTS memory_imports (
    id TEXT PRIMARY KEY,
    name TEXT,
    rows_imported INTEGER DEFAULT 0,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    tags TEXT
  );
`)

// ---------------------------------------------------------
// 2. FUNCIONES AUXILIARES
// ---------------------------------------------------------

async function getSunatRate(): Promise<number> {
  try {
    const response = await fetch('https://api.apis.net.pe/v1/tipo-cambio-sunat');
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();
    return parseFloat(data.venta);
  } catch (error) {
    return 3.75; 
  }
}

function guessCategory(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('coordin') || t.includes('jefe') || t.includes('especialista') || t.includes('asistente') || t.includes('consult') || t.includes('personal') || t.includes('gerente') || t.includes('director')) return 'Personal';
  if (t.includes('pasaje') || t.includes('vuelo') || t.includes('viatic') || t.includes('hospedaje') || t.includes('hotel') || t.includes('movilidad') || t.includes('traslado')) return 'Viajes';
  if (t.includes('laptop') || t.includes('comput') || t.includes('impresora') || t.includes('licencia') || t.includes('software') || t.includes('equipo')) return 'Equipos';
  if (t.includes('taller') || t.includes('reunion') || t.includes('evento') || t.includes('coffee') || t.includes('catering') || t.includes('sala') || t.includes('capacitacion')) return 'Talleres/Eventos';
  if (t.includes('alquiler') || t.includes('rent') || t.includes('luz') || t.includes('agua') || t.includes('mantenimiento')) return 'Operaciones/Oficina';
  return 'General';
}

// ---------------------------------------------------------
// 3. CONFIGURACIÓN DE VENTANA
// ---------------------------------------------------------
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => { mainWindow.show() })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------
// 4. HANDLERS IPC
// ---------------------------------------------------------
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.budgetcat')
  
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // HANDLER: GUARDAR PROYECTO
  ipcMain.handle('save-project', async (_event, projectData) => {
    try {
      const { id, name, donor, data_json } = projectData
      const transaction = db.transaction(() => {
        const stmtProject = db.prepare(`
          INSERT OR REPLACE INTO projects (id, name, donor, data_json, updated_at)
          VALUES (@id, @name, @donor, @data_json, datetime('now'))
        `)
        stmtProject.run({ id, name, donor, data_json })

        db.prepare('DELETE FROM cost_memory WHERE source_project_id = ?').run(id)
        const stmtMemory = db.prepare(`
          INSERT INTO cost_memory (description, category, unit, unit_cost, currency, year, sector, donor, source_project_id)
          VALUES (@description, @category, @unit, @unit_cost, @currency, @year, @sector, @donor, @source_project_id)
        `)

        const parsedData = JSON.parse(data_json)
        const lines = parsedData.lines || []
        const meta = parsedData.meta || {}
        
        lines.forEach((line: any) => {
          if (line.description && line.unit_cost > 0 && !line.parentId) {
            stmtMemory.run({
              description: line.description,
              category: line.category || 'General',
              unit: line.unit || 'Und',
              unit_cost: line.unit_cost,
              currency: meta.currency || 'PEN',
              year: new Date().getFullYear(),
              sector: meta.sector || '',
              donor: meta.donor || '',
              source_project_id: id
            })
          }
        })
      })
      transaction()
      return { success: true, message: 'Guardado correctamente en SQL' }
    } catch (error: any) {
      console.error('Error SQL:', error)
      return { success: false, message: error.message }
    }
  })

  // HANDLER: OBTENER PROYECTOS
  ipcMain.handle('get-projects', () => {
    try {
      return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
    } catch (error) {
      console.error(error)
      return []
    }
  })

  // HANDLER: BUSCAR COSTOS
  ipcMain.handle('search-cost', (_event, query) => {
    try {
      const stmt = db.prepare(`
        SELECT description, category, unit, unit_cost, currency, year, donor 
        FROM cost_memory 
        WHERE description LIKE ? OR category LIKE ? 
        ORDER BY year DESC LIMIT 10
      `)
      return stmt.all(`%${query}%`, `%${query}%`)
    } catch (error) {
      console.error(error)
      return []
    }
  })

  // HANDLER: IMPORTAR A EDITOR (LEGACY + IA)
  ipcMain.handle('import-to-editor', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    });

    if (canceled || !filePaths[0]) return null;

    try {
      const workbook = XLSX.readFile(filePaths[0]);
      const targetSheet = workbook.SheetNames.find(n => 
        n.toLowerCase().includes('presupuesto') || n.toLowerCase().includes('budget') || n.toLowerCase().includes('data')
      ) || workbook.SheetNames[0];
      
      const sheet = workbook.Sheets[targetSheet];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

      const descKeywords = ['descrip', 'activity', 'actividad', 'item', 'detalle'];
      const costKeywords = ['unitario', 'precio', 'monto', 'cost', 'unit cost'];
      const qtyKeywords = ['cant', 'freq', 'unidades', 'quantity'];

      let headerRow = -1;
      for (let i = 0; i < Math.min(60, rawData.length); i++) {
        const rowStr = JSON.stringify(rawData[i] || []).toLowerCase();
        if (descKeywords.some(k => rowStr.includes(k)) && costKeywords.some(k => rowStr.includes(k))) {
          headerRow = i; break;
        }
      }

      if (headerRow === -1) throw new Error("No se detectó estructura de presupuesto.");

      const headers = rawData[headerRow].map(h => String(h || '').toLowerCase());
      const idxDesc = headers.findIndex(h => descKeywords.some(k => h.includes(k)));
      const idxUnitCost = headers.findIndex(h => costKeywords.some(k => h.includes(k)));
      const idxQty = headers.findIndex(h => qtyKeywords.some(k => h.includes(k)));
      const idxUnit = headers.findIndex(h => h.includes('unidad') || h.includes('unit'));

      const importedLines: any[] = [];
      const sectionsMap = new Map();
      const defaultSecId = 'sec-imported';
      sectionsMap.set('Importado', { id: defaultSecId, name: 'Items Importados' });

      for (let i = headerRow + 1; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || !row[idxDesc]) continue;

        const rawCost = String(row[idxUnitCost] || '0').replace(/[^0-9.-]+/g, '');
        const unitCost = parseFloat(rawCost) || 0;
        const description = String(row[idxDesc]);

        if (description.trim().length > 2) {
          importedLines.push({
            id: `line-${Math.random().toString(36).substr(2, 9)}`,
            sectionId: defaultSecId,
            category: guessCategory(description),
            description: description,
            quantity: Number(row[idxQty]) || 1,
            frequency: 1,
            unit: idxUnit !== -1 ? String(row[idxUnit]) : 'Und',
            unit_cost: unitCost,
            total: unitCost * (Number(row[idxQty]) || 1),
            selected: false
          });
        }
      }

      return { 
        sections: Array.from(sectionsMap.values()), 
        lines: importedLines,
        meta: { currency: 'PEN', usdRate: 3.75, eurRate: 4.05 } 
      };

    } catch (e) {
      console.error(e);
      return null;
    }
  });

// ---------------------------------------------------------
  // HANDLER: IMPORTAR INTELIGENTE (IA) 🧠 -> A MEMORIA
  // ---------------------------------------------------------
  ipcMain.handle('import-smart-budget', async () => {
    // 1. Abrir selector de archivos
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls', 'csv'] }]
    })

    if (canceled || !filePaths[0]) return { success: false, message: 'Cancelado' }

    try {
      const fileName = basename(filePaths[0])
      
      // 2. Leer Excel
      const workbook = XLSX.readFile(filePaths[0])
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      
      // Tomamos una muestra de 50 filas para no saturar a la IA
      const cleanData = rawData.filter((r: any) => r.length > 0).slice(0, 50);

      // 3. 🤖 Llamada a la IA (Tu servicio nuevo)
      // Esperamos que analyzeBudgetRows devuelva un array de objetos:
      // [{ description: "...", category: "...", unit: "...", unit_cost: 100, ... }]
      const aiResult = await analyzeBudgetRows(cleanData); 

      if (!aiResult || aiResult.length === 0) {
        throw new Error("La IA no encontró items válidos.");
      }

      // 4. Guardar en Base de Datos (SQLite)
      const importId = `ai-${Date.now()}` // ID único para esta importación
      
      const stmt = db.prepare(`
        INSERT INTO cost_memory (description, category, unit, unit_cost, currency, year, donor, source_project_id)
        VALUES (@description, @category, @unit, @unit_cost, 'PEN', @year, 'Importado IA', @source_project_id)
      `)

      const transaction = db.transaction(() => {
        let inserted = 0
        
        aiResult.forEach((item: any) => {
          // Validamos que tenga descripción y costo
          if (item.description && (item.unit_cost > 0 || item.total > 0)) {
            stmt.run({
              description: item.description,
              category: item.category || 'General', // La IA ya nos dio la categoría
              unit: item.unit || 'Und',
              unit_cost: item.unit_cost || item.total, // Usamos lo que haya encontrado
              year: new Date().getFullYear(),
              source_project_id: importId
            })
            inserted++
          }
        })

        // Registramos la importación en la tabla resumen
        db.prepare(`
          INSERT OR REPLACE INTO memory_imports (id, name, rows_imported, imported_at, tags)
          VALUES (@id, @name, @rows_imported, datetime('now'), @tags)
        `).run({
          id: importId,
          name: `(IA) ${fileName}`, // Le ponemos (IA) al nombre para que lo distingas
          rows_imported: inserted,
          tags: JSON.stringify(['Excel', 'AI', 'Llama3'])
        })
      })

      transaction() // Ejecuta la transacción

      return { success: true, message: `IA procesó e importó correctamente.` }

    } catch (error: any) {
      console.error("Error en Importación IA:", error)
      return { success: false, message: error.message }
    }
  })

  // HANDLER: IMPORTAR A MEMORIA
  ipcMain.handle('import-excel', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    })
    
    if (canceled || !filePaths[0]) return { success: false, message: 'Cancelado' }

    try {
      const workbook = XLSX.readFile(filePaths[0])
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][]

      let exchangeRate = 0;
      const rateRow = rawData.find(row => JSON.stringify(row).toLowerCase().includes('tipo de cambio'));
      if (rateRow) {
         exchangeRate = parseFloat(String(rateRow.find(c => typeof c === 'number') || 0));
      }
      if (!exchangeRate || exchangeRate === 0) {
        exchangeRate = await getSunatRate();
      }

      const descKeywords = ['descrip', 'activity', 'actividad', 'detalle']
      const costKeywords = ['total', 'cost', 'monto', 'unitario']
      
      let headerRow = -1
      for (let i = 0; i < Math.min(50, rawData.length); i++) {
        const rowStr = (rawData[i] || []).map(c => String(c).toLowerCase()).join(' ')
        if (descKeywords.some(k => rowStr.includes(k)) && costKeywords.some(k => rowStr.includes(k))) {
          headerRow = i; break;
        }
      }

      if (headerRow === -1) return { success: false, message: 'No se encontraron encabezados válidos' }

      const importId = `excel-${Date.now()}`
      const fileName = basename(filePaths[0])
      const headers = rawData[headerRow].map(h => String(h || '').toLowerCase())
      const idxDesc = headers.findIndex(h => descKeywords.some(k => h.includes(k)))
      const idxCost = headers.findIndex(h => costKeywords.some(k => h.includes(k)))
      const idxUnit = headers.findIndex(h => h.includes('unidad') || h.includes('unit'))

      const stmt = db.prepare(`
        INSERT INTO cost_memory (description, category, unit, unit_cost, currency, year, donor, source_project_id)
        VALUES (@description, @category, @unit, @unit_cost, 'PEN', @year, 'Importado', @source_project_id)
      `)

      const transaction = db.transaction(() => {
        let inserted = 0
        for (let i = headerRow + 1; i < rawData.length; i++) {
          const row = rawData[i]
          if (!row || !row[idxDesc]) continue
          
          const desc = String(row[idxDesc])
          const rawCost = row[idxCost]
          let cost = typeof rawCost === 'number' ? rawCost : parseFloat(String(rawCost).replace(/[^0-9.-]+/g, ''))

          if (desc.length > 2 && cost > 0) {
            stmt.run({
              description: desc,
              category: guessCategory(desc),
              unit: idxUnit > -1 ? String(row[idxUnit]) : 'Und',
              unit_cost: cost,
              year: new Date().getFullYear(),
              source_project_id: importId
            })
            inserted++
          }
        }

        db.prepare(`
          INSERT OR REPLACE INTO memory_imports (id, name, rows_imported, imported_at, tags)
          VALUES (@id, @name, @rows_imported, datetime('now'), @tags)
        `).run({
          id: importId,
          name: fileName,
          rows_imported: inserted,
          tags: JSON.stringify(['Excel'])
        })
      })

      transaction()
      return { 
        success: true, 
        message: `Importado con T/C estimada: ${exchangeRate}`, 
        source: { id: importId, name: fileName, type: 'excel', date: new Date().toISOString(), tags: ['Excel'], count: db.prepare('SELECT COUNT(*) as c FROM cost_memory WHERE source_project_id = ?').get(importId).c }
      }

    } catch (error: any) {
      console.error(error)
      return { success: false, message: error.message }
    }
  })

  // HANDLER: LISTAR IMPORTACIONES DE MEMORIA
  ipcMain.handle('get-memory-sources', () => {
    try {
      const rows = db.prepare('SELECT id, name, rows_imported, imported_at, tags FROM memory_imports ORDER BY datetime(imported_at) DESC').all()
      return rows.map((r: any) => ({
        id: r.id,
        name: r.name || 'Importación Excel',
        type: 'excel',
        date: r.imported_at || new Date().toISOString(),
        tags: (() => { try { return r.tags ? JSON.parse(r.tags) : ['Excel'] } catch { return ['Excel'] } })(),
        count: r.rows_imported || 0
      }))
    } catch (error) {
      console.error(error)
      return []
    }
  })


// ---------------------------------------------------------
  // HANDLER: RECUPERAR ITEMS DE MEMORIA (¡PEGA ESTO!)
  // ---------------------------------------------------------
  ipcMain.handle('get-memory-items', (_event, sourceId) => {
    try {
      // 1. Validar ID
      if (!sourceId) return [];

      // 2. Buscar en la BD
      const rows = db.prepare(`
        SELECT * FROM cost_memory 
        WHERE source_project_id = ?
      `).all(sourceId);

      return rows;
    } catch (error: any) {
      console.error("❌ Error recuperando items:", error);
      return [];
    }
  })


  // ---------------------------------------------------------
  // HANDLER: ELIMINAR FUENTE DE MEMORIA (Borrado Real)
  // ---------------------------------------------------------
  ipcMain.handle('delete-memory-source', (_event, sourceId) => {
    try {
      // Usamos una transacción para asegurar que se borre todo o nada
      const transaction = db.transaction(() => {
        // 1. Borrar el registro de la importación
        const result = db.prepare('DELETE FROM memory_imports WHERE id = ?').run(sourceId);
        
        // 2. Borrar todos los items de costo asociados a esa importación
        db.prepare('DELETE FROM cost_memory WHERE source_project_id = ?').run(sourceId);
        
        return result.changes > 0; // Devuelve true si borró algo
      });

      const success = transaction();
      console.log(`🗑️ Fuente ${sourceId} eliminada: ${success}`);
      return { success };

    } catch (error: any) {
      console.error("❌ Error eliminando fuente:", error);
      return { success: false, message: error.message };
    }
  })

  // ---------------------------------------------------------
  // HANDLER: RENOMBRAR FUENTE DE MEMORIA / PROYECTO
  // ---------------------------------------------------------
  ipcMain.handle('rename-memory-source', (_event, payload) => {
    const { id, newName, type } = payload || {};
    if (!id || !newName) return { success: false, message: 'ID o nombre inválido' };

    try {
      let result;

      if (type === 'app') {
        result = db.prepare("UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?").run(newName, id);
      } else {
        result = db.prepare('UPDATE memory_imports SET name = ? WHERE id = ?').run(newName, id);
      }

      const success = result.changes > 0;
      if (!success) return { success: false, message: 'No se encontró el registro' };

      console.log(`✏️ Fuente ${id} renombrada a: ${newName}`);
      return { success: true };
    } catch (error: any) {
      console.error('❌ Error renombrando fuente:', error);
      return { success: false, message: error.message };
    }
  })


  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
