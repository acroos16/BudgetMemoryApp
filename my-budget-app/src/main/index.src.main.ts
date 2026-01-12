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
    section TEXT,
    level INTEGER,
    parent_code TEXT,
    code TEXT,
    quantity REAL,
    frequency REAL,
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
    tags TEXT,
    meta_json TEXT
  );
`)

try {
  db.exec('ALTER TABLE memory_imports ADD COLUMN meta_json TEXT');
} catch {}
try {
  db.exec('ALTER TABLE cost_memory ADD COLUMN section TEXT');
} catch {}
try {
  db.exec('ALTER TABLE cost_memory ADD COLUMN level INTEGER');
} catch {}
try {
  db.exec('ALTER TABLE cost_memory ADD COLUMN parent_code TEXT');
} catch {}
try {
  db.exec('ALTER TABLE cost_memory ADD COLUMN code TEXT');
} catch {}
try {
  db.exec('ALTER TABLE cost_memory ADD COLUMN quantity REAL');
} catch {}
try {
  db.exec('ALTER TABLE cost_memory ADD COLUMN frequency REAL');
} catch {}

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

function sendImportProgress(event: Electron.IpcMainInvokeEvent, percent: number, message?: string) {
  event.sender.send('import-progress', { percent, message });
}

function normalizeHeader(value: any): string {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function parseNumber(value: any): number {
  if (typeof value === 'number') return value;
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  let s = raw.replace(/\s+/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  s = s.replace(/[^0-9.-]/g, '');
  return parseFloat(s);
}

function isMetaDescriptor(text: string): boolean {
  const t = text.toLowerCase().trim();
  return (
    /^proyecto(\s*:|$)/.test(t) ||
    /^donante(\s*:|$)/.test(t) ||
    /^duraci[oó]n(\s*:|$)/.test(t) ||
    /^monto(\s*:|$)/.test(t) ||
    /^t\/c(\s*:|$)/.test(t) ||
    /^tipo de cambio(\s*:|$)/.test(t)
  );
}

function extractProjectMeta(rawData: any[][]) {
  const headerInfo = findHeaderRow(rawData);
  const limit = headerInfo ? headerInfo.index : Math.min(25, rawData.length);
  let projectName = '';
  let donor = '';
  let duration: number | undefined;
  let currency = '';

  for (let i = 0; i < limit; i++) {
    const row = rawData[i] || [];
    for (let j = 0; j < row.length; j++) {
      const cellRaw = row[j];
      const cell = String(cellRaw || '').trim();
      if (!cell) continue;
      const lower = cell.toLowerCase();
      const next = row[j + 1];

      const extractValue = () => {
        const parts = cell.split(':');
        const after = parts.length > 1 ? parts.slice(1).join(':').trim() : '';
        if (after) return after;
        return String(next || '').trim();
      };

      if (!projectName && lower.includes('proyecto')) {
        projectName = extractValue();
      }
      if (!donor && lower.includes('donante')) {
        donor = extractValue();
      }
      if (!currency && lower.includes('moneda')) {
        currency = extractValue();
      }
      if (duration === undefined && (lower.includes('duracion') || lower.includes('duración'))) {
        const value = extractValue() || cell;
        const parsed = parseNumber(value);
        if (Number.isFinite(parsed)) duration = parsed;
      }
      if (duration === undefined && lower.includes('mes')) {
        const parsed = parseNumber(cell);
        if (Number.isFinite(parsed)) duration = parsed;
      }
    }
  }

  return {
    projectName: projectName || undefined,
    donor: donor || undefined,
    duration,
    currency: currency || undefined
  };
}

function findHeaderRow(rawData: any[][]) {
  const descKeywords = ['descrip', 'descripción', 'descripcion', 'detalle', 'concepto', 'actividad', 'rubro'];
  const costKeywords = ['total', 'monto', 'importe', 'unitario', 'costo'];
  const limit = Math.min(60, rawData.length);
  for (let i = 0; i < limit; i++) {
    const headers = (rawData[i] || []).map(normalizeHeader);
    const rowStr = headers.join(' ');
    if (descKeywords.some(k => rowStr.includes(k)) && costKeywords.some(k => rowStr.includes(k))) {
      return { index: i, headers };
    }
  }
  return null;
}

function parseBudgetItems(rawData: any[][], formulaMap?: Record<string, string>) {
  const headerInfo = findHeaderRow(rawData);
  if (!headerInfo) return [];

  const headers = headerInfo.headers;
  const findIndex = (keywords: string[]) => headers.findIndex(h => keywords.some(k => h.includes(k)));
  const getNumberNear = (row: any[], idx: number) => {
    for (let offset = 0; offset <= 2; offset++) {
      const pos = idx + offset;
      if (pos >= 0 && pos < row.length) {
        const parsed = parseNumber(row[pos]);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return NaN;
  };
  const idxDesc = findIndex(['descrip', 'descripción', 'descripcion', 'detalle', 'concepto', 'actividad', 'rubro']);
  if (idxDesc === -1) return [];

  const idxUnit = findIndex(['unidad', 'u.m', 'um', 'unit']);
  const idxQty = findIndex(['cantidad', 'cant', 'qty', 'numero']);
  const idxFreq = findIndex(['frecuencia', 'freq']);
  const idxCode = findIndex(['cod', 'código', 'codigo', 'code']);
  const idxGroup = findIndex(['rubro', 'rubros', 'rubro general', 'rubros generales']);
  const idxUnitCost = findIndex(['p/unitario', 'p unitario', 'unitario', 'precio unit', 'costo unit', 'tarifa']);
  const idxTotal = findIndex(['total', 'monto', 'importe', 'costo total']);

  let currentSection = '';
  let currentLineCode = '';
  let currentSubCode = '';
  let currentHeaderCode = '';
  let autoLineId = 0;
  let lastHeaderWasLine = false;
  const items: any[] = [];
  const rowToIndex = new Map<number, number>();

  const getFormulaRangeRows = (rowIdx: number) => {
    if (!formulaMap || idxTotal < 0) return [];
    const colLetter = String.fromCharCode(65 + idxTotal);
    const key = `${colLetter}${rowIdx + 1}`;
    const formula = formulaMap[key];
    if (!formula) return [];
    const match = formula.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i);
    if (!match) return [];
    const startRow = parseInt(match[2], 10);
    const endRow = parseInt(match[4], 10);
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) return [];
    const rows: number[] = [];
    for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
      rows.push(r - 1);
    }
    return rows;
  };

  for (let i = headerInfo.index + 1; i < rawData.length; i++) {
    const row = rawData[i] || [];
    const desc = String(row[idxDesc] || '').trim();
    if (!desc) continue;

    const descLower = desc.toLowerCase();
    const codeRaw = idxCode >= 0 ? String(row[idxCode] || '').trim() : '';
    const normalizedCode = codeRaw.replace(/[^\d.]/g, '').replace(/^\./, '').replace(/\.$/, '');
    const codeParts = normalizedCode ? normalizedCode.split('.').filter(Boolean).map(p => parseInt(p, 10)) : [];
    const codeIsSection = codeParts.length === 1;
    const codeIsItem = codeParts.length >= 2;
    const groupRaw = idxGroup >= 0 ? String(row[idxGroup] || '').trim() : '';
    const groupName = groupRaw
      ? groupRaw.replace(/^\d+[\.\)]\s*/g, '').trim()
      : '';
    const unit = idxUnit >= 0 ? String(row[idxUnit] || '').trim() : '';
    const quantityRaw = idxQty >= 0 ? row[idxQty] : null;
    const freqRaw = idxFreq >= 0 ? row[idxFreq] : null;
    const quantity = parseNumber(quantityRaw);
    let frequency = parseNumber(freqRaw);
    const freqStr = String(freqRaw || '');
    if (freqStr.includes('%') && Number.isFinite(frequency)) frequency = frequency / 100;
    if (typeof freqRaw === 'number' && Number.isFinite(frequency) && frequency > 1 && frequency <= 100) frequency = frequency / 100;
    const total = idxTotal >= 0 ? getNumberNear(row, idxTotal) : NaN;
    let unitCost = idxUnitCost >= 0 ? getNumberNear(row, idxUnitCost) : NaN;
    const rowHasNumbers = (Number.isFinite(unitCost) && unitCost > 0) || (Number.isFinite(total) && total > 0);

    const hasUnitOrQty = unit !== '' || Number.isFinite(quantity) || Number.isFinite(frequency);
    const isSubtotal = descLower.includes('subtotal') || descLower.includes('total');
    const descIsNumberedSection = /^\d+\s+/.test(desc);
    const looksLikeSection = codeIsSection || (!codeRaw && !rowHasNumbers && desc.length > 2);
    if ((descIsNumberedSection && rowHasNumbers && !hasUnitOrQty) || (looksLikeSection && !isSubtotal)) {
      currentSection = desc.replace(/^\d+\s+/, '').trim();
      currentHeaderCode = '';
      lastHeaderWasLine = false;
      currentLineCode = '';
      currentSubCode = '';
      continue;
    }
    if (isSubtotal && !rowHasNumbers) continue;

    if (!Number.isFinite(unitCost) || unitCost <= 0) {
      if (Number.isFinite(total) && total > 0) {
        unitCost = Number.isFinite(quantity) && quantity > 0 ? total / quantity : total;
      }
    }
    if (!Number.isFinite(unitCost) || unitCost <= 0) continue;

    const sectionName = currentSection || groupName || guessCategory(desc);
    let level = codeParts.length || 0;
    let code = normalizedCode || '';
    let parentCode = '';

    if (level === 0) {
      if (rowHasNumbers && !hasUnitOrQty) {
        level = currentHeaderCode ? 3 : 2;
        parentCode = currentHeaderCode || '';
        code = `auto-${++autoLineId}`;
        if (level === 2) {
          currentLineCode = code;
        } else {
          currentSubCode = code;
        }
        currentHeaderCode = code;
        lastHeaderWasLine = true;
      } else if (rowHasNumbers && hasUnitOrQty) {
        if (currentHeaderCode) {
          level = 3;
          parentCode = currentHeaderCode;
        } else if (currentSubCode) {
          level = 4;
          parentCode = currentSubCode;
        } else if (lastHeaderWasLine && currentLineCode) {
          level = 3;
          parentCode = currentLineCode;
        } else {
          level = 2;
          code = `auto-${++autoLineId}`;
          currentLineCode = code;
          currentSubCode = '';
          currentHeaderCode = code;
        }
        lastHeaderWasLine = false;
      } else {
        continue;
      }
    } else if (level === 1) {
      currentSection = desc;
      lastHeaderWasLine = false;
      currentHeaderCode = '';
      continue;
    } else if (level >= 2) {
      if (level === 2) {
        currentLineCode = code;
        currentSubCode = '';
        currentHeaderCode = code;
        lastHeaderWasLine = false;
      } else {
        parentCode = codeParts.slice(0, -1).join('.');
        if (level === 3) currentSubCode = code;
        lastHeaderWasLine = false;
      }
    }

    const item = {
      description: desc,
      category: sectionName,
      section: sectionName,
      unit: unit || 'Und',
      quantity: Number.isFinite(quantity) ? quantity : undefined,
      frequency: Number.isFinite(frequency) ? frequency : undefined,
      unit_cost: unitCost,
      total: Number.isFinite(total) ? total : undefined,
      level,
      code: code || undefined,
      parent_code: parentCode || undefined,
      rowIndex: i
    };
    items.push(item);
    rowToIndex.set(i, items.length - 1);
  }

  if (formulaMap) {
    for (const item of items) {
      if (!item || item.rowIndex === undefined) continue;
      const formulaRows = getFormulaRangeRows(item.rowIndex);
      if (formulaRows.length === 0) continue;
      const parentCode = item.code || `auto-parent-${item.rowIndex + 1}`;
      item.code = parentCode;
      item.level = 2;
      formulaRows.forEach(r => {
        const idx = rowToIndex.get(r);
        if (idx === undefined) return;
        const child = items[idx];
        if (!child || child.section !== item.section) return;
        if (child.level && child.level <= item.level) return;
        child.parent_code = parentCode;
        child.level = 3;
      });
    }
  }

  return items.map(({ rowIndex, ...rest }) => rest);
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
          INSERT INTO cost_memory (description, category, unit, unit_cost, quantity, frequency, currency, year, sector, donor, source_project_id)
          VALUES (@description, @category, @unit, @unit_cost, @quantity, @frequency, @currency, @year, @sector, @donor, @source_project_id)
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
              quantity: line.quantity || 1,
              frequency: line.frequency || 1,
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
  ipcMain.handle('import-smart-budget', async (event) => {
    // 1. Abrir selector de archivos
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls', 'csv'] }]
    })

    if (canceled || !filePaths[0]) return { success: false, message: 'Cancelado' }

    try {
      sendImportProgress(event, 5, 'Abriendo archivo');
      const fileName = basename(filePaths[0])
      
      // 2. Leer Excel
      const workbook = XLSX.readFile(filePaths[0])
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][]
      sendImportProgress(event, 20, 'Leyendo encabezados');
      const metaFromSheet = extractProjectMeta(rawData);
      const formulaMap: Record<string, string> = {};
      Object.keys(sheet).forEach((addr) => {
        const cell: any = (sheet as any)[addr];
        if (cell && typeof cell.f === 'string') {
          formulaMap[addr] = String(cell.f);
        }
      });
      
      // 3. 🧩 Intento determinista primero (mejor para tablas largas)
      sendImportProgress(event, 35, 'Detectando estructura');
      let itemsToImport = parseBudgetItems(rawData, formulaMap);
      let importTags = ['Excel', 'Parser'];
      let importLabel = '(Auto)';

      // 4. 🤖 Fallback a IA si no se pudo detectar nada
      if (!itemsToImport || itemsToImport.length === 0) {
        const headerInfo = findHeaderRow(rawData);
        let aiInput: any[] = [];
        if (headerInfo) {
          const headers = headerInfo.headers;
          // AQUÍ AUMENTÉ EL LÍMITE DE 200 A 1000
          const rows = rawData.slice(headerInfo.index + 1, headerInfo.index + 1 + 1000);
          aiInput = rows.map(r => {
            const obj: Record<string, any> = {};
            headers.forEach((h, idx) => { if (h) obj[h] = r[idx]; });
            return obj;
          });
        } else {
          // AQUÍ AUMENTÉ EL LÍMITE DE 200 A 1000
          aiInput = rawData.filter((r: any) => r.length > 0).slice(0, 1000);
        }

        // Esperamos que analyzeBudgetRows devuelva un array de objetos:
        // [{ description: "...", category: "...", unit: "...", unit_cost: 100, ... }]
        sendImportProgress(event, 55, 'Analizando con IA');
        itemsToImport = await analyzeBudgetRows(aiInput);
        importTags = ['Excel', 'AI', 'Llama3'];
        importLabel = '(IA)';
      }

      if (!itemsToImport || itemsToImport.length === 0) {
        throw new Error("No se encontraron items válidos para importar.");
      }

      sendImportProgress(event, 75, 'Filtrando filas');
      itemsToImport = itemsToImport.filter((item: any) => {
        const desc = String(item.description || '').trim();
        if (!desc) return false;
        return !isMetaDescriptor(desc);
      });
      if (itemsToImport.length === 0) {
        throw new Error("No se encontraron items válidos para importar.");
      }

      // 4. Guardar en Base de Datos (SQLite)
      sendImportProgress(event, 85, 'Guardando en memoria');
      const importId = `ai-${Date.now()}` // ID único para esta importación
      
      const stmt = db.prepare(`
        INSERT INTO cost_memory (description, category, section, level, parent_code, code, unit, unit_cost, quantity, frequency, currency, year, donor, source_project_id)
        VALUES (@description, @category, @section, @level, @parent_code, @code, @unit, @unit_cost, @quantity, @frequency, 'PEN', @year, 'Importado IA', @source_project_id)
      `)

      const transaction = db.transaction(() => {
        let inserted = 0
        
        itemsToImport.forEach((item: any) => {
          // Validamos que tenga descripción y costo
          if (item.description && (item.unit_cost > 0 || item.total > 0)) {
            const sectionName = item.section || item.category || guessCategory(item.description);
            stmt.run({
              description: item.description,
              category: item.category || sectionName,
              section: sectionName,
              level: Number.isFinite(item.level) ? item.level : 2,
              parent_code: item.parent_code || null,
              code: item.code || null,
              unit: item.unit || 'Und',
              unit_cost: item.unit_cost || item.total, // Usamos lo que haya encontrado
              quantity: Number.isFinite(item.quantity) ? item.quantity : 1,
              frequency: Number.isFinite(item.frequency) ? item.frequency : 1,
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
          name: metaFromSheet.projectName || metaFromSheet.donor || `${importLabel} ${fileName}`,
          rows_imported: inserted,
          tags: JSON.stringify(importTags),
          meta_json: JSON.stringify({
            projectName: metaFromSheet.projectName,
            donor: metaFromSheet.donor,
            duration: metaFromSheet.duration,
            currency: metaFromSheet.currency
          })
        })
      })

      transaction() // Ejecuta la transacción

      sendImportProgress(event, 100, 'Importación completa');
      
      // ✅ CORRECCIÓN FINAL: Devolver los datos para que el Editor los vea inmediatamente
      return { success: true, data: itemsToImport, message: `IA procesó e importó correctamente.` }

    } catch (error: any) {
      console.error("Error en Importación IA:", error)
      try { sendImportProgress(event, 100, 'Error en importación'); } catch {}
      return { success: false, message: error.message }
    }
  })

  // HANDLER: IMPORTAR A MEMORIA
  ipcMain.handle('import-excel', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    })
    
    if (canceled || !filePaths[0]) return { success: false, message: 'Cancelado' }

    try {
      sendImportProgress(event, 5, 'Abriendo archivo');
      const workbook = XLSX.readFile(filePaths[0])
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][]
      sendImportProgress(event, 20, 'Detectando encabezados');

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

      if (headerRow === -1) {
        try { sendImportProgress(event, 100, 'No se encontraron encabezados válidos'); } catch {}
        return { success: false, message: 'No se encontraron encabezados válidos' }
      }

      const importId = `excel-${Date.now()}`
      const fileName = basename(filePaths[0])
      const headers = rawData[headerRow].map(h => String(h || '').toLowerCase())
      const idxDesc = headers.findIndex(h => descKeywords.some(k => h.includes(k)))
      const idxCost = headers.findIndex(h => costKeywords.some(k => h.includes(k)))
      const idxUnit = headers.findIndex(h => h.includes('unidad') || h.includes('unit'))

      const stmt = db.prepare(`
        INSERT INTO cost_memory (description, category, section, level, parent_code, code, unit, unit_cost, quantity, frequency, currency, year, donor, source_project_id)
        VALUES (@description, @category, @section, @level, @parent_code, @code, @unit, @unit_cost, @quantity, @frequency, 'PEN', @year, 'Importado', @source_project_id)
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
            const sectionName = guessCategory(desc);
            stmt.run({
              description: desc,
              category: sectionName,
              section: sectionName,
              level: 2,
              parent_code: null,
              code: null,
              unit: idxUnit > -1 ? String(row[idxUnit]) : 'Und',
              unit_cost: cost,
              quantity: 1,
              frequency: 1,
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

      sendImportProgress(event, 85, 'Guardando en memoria');
      transaction()
      sendImportProgress(event, 100, 'Importación completa');
      return { 
        success: true, 
        message: `Importado con T/C estimada: ${exchangeRate}`, 
        source: { id: importId, name: fileName, type: 'excel', date: new Date().toISOString(), tags: ['Excel'], count: db.prepare('SELECT COUNT(*) as c FROM cost_memory WHERE source_project_id = ?').get(importId).c }
      }

    } catch (error: any) {
      console.error(error)
      try { sendImportProgress(event, 100, 'Error en importación'); } catch {}
      return { success: false, message: error.message }
    }
  })

  // HANDLER: LISTAR IMPORTACIONES DE MEMORIA
  ipcMain.handle('get-memory-sources', () => {
    try {
      const rows = db.prepare('SELECT id, name, rows_imported, imported_at, tags, meta_json FROM memory_imports ORDER BY datetime(imported_at) DESC').all()
      return rows.map((r: any) => ({
        id: r.id,
        name: r.name || 'Importación Excel',
        type: 'excel',
        date: r.imported_at || new Date().toISOString(),
        tags: (() => { try { return r.tags ? JSON.parse(r.tags) : ['Excel'] } catch { return ['Excel'] } })(),
        count: r.rows_imported || 0,
        meta: (() => { try { return r.meta_json ? JSON.parse(r.meta_json) : undefined } catch { return undefined } })()
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
        ORDER BY id ASC
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
