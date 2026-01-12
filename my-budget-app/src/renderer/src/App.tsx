import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import bgImage from './assets/background.jpg.png'
import ExcelJS from 'exceljs'
import { saveAs } from 'file-saver'

// --- Interfaces ---
interface CostItem {
  id?: number; description: string; category: string; unit: string; unit_cost: number;
  currency: string; year: number; source_file: string; donor: string; exchange_rate_used?: number;
  sector?: string; 
}
interface ProjectMetadata { 
  donor: string; country: string; currency: string; sector: string; duration: number;
  usdRate: number; eurRate: number;
}
interface BudgetLine {
  id: string; sectionId: string; parentId?: string;
  category: string; description: string;
  notes?: string;
  showNotes?: boolean;
  quantity: number; frequency: number; unit: string; unit_cost: number; total: number;
  selected: boolean;
}
interface BudgetSection { id: string; name: string; collapsed?: boolean; capType?: 'amount' | 'percent'; capValue?: number; }
interface ProjectFile { meta: ProjectMetadata; sections: BudgetSection[]; lines: BudgetLine[]; }
interface Snapshot { timestamp: string; data: string; }

// --- INTERFAZ MEMORIA ---
interface MemorySource {
  id: string; name: string; type: 'excel' | 'app'; date: string; tags: string[]; count: number; originalData?: any;
  meta?: Partial<ProjectMetadata> & { projectName?: string };
}

declare global {
  interface Window {
    budgetAPI: {
      searchCost: (query: string) => Promise<CostItem[]>
      importExcel: () => Promise<{ success: boolean; message: string; source?: MemorySource }>
      exportBudget: (data: any) => Promise<{ success: boolean; message: string }>
      saveProjectInternal: (data: any) => Promise<{ success: boolean; message: string }>
      getAllProjects: () => Promise<any[]>
      getMemorySources: () => Promise<MemorySource[]>
      importToEditor: () => Promise<any>
      importSmartBudget: () => Promise<{ success: boolean; data?: any[]; message?: string }>
      getMemoryItems: (sourceId: string) => Promise<any[]>
      deleteMemorySource: (sourceId: string) => Promise<{ success: boolean; message?: string }>
      renameMemorySource: (id: string, newName: string, type: string) => Promise<{ success: boolean; message?: string }>
      onImportProgress: (callback: (payload: { percent: number; message?: string }) => void) => () => void
    }
  }
}

const generateId = () => Math.random().toString(36).substr(2, 9);
const fmt = (num: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
const fmtPct = (part: number, total: number) => {
  if (!total || total === 0) return '0.0%';
  return ((part / total) * 100).toFixed(1) + '%';
};

// --- HELPER DE SEGURIDAD NUMÉRICA (NUEVO) ---
const safeVal = (val: any): number => {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (!val) return 0;
  // Limpia strings con comas o espacios antes de parsear
  const str = String(val).replace(/,/g, '').trim(); 
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : 0;
};

const normalizeNumberToken = (token: string): string => {
  let t = token;
  if (t.includes(',') && t.includes('.')) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (t.includes(',') && !t.includes('.')) {
    t = t.replace(/,/g, '.');
  }
  return t;
};

const normalizeNumericExpression = (raw: string): string => {
  let expr = raw.trim();
  if (expr.startsWith('=')) expr = expr.slice(1);
  expr = expr.replace(/\s+/g, '');
  if (!/^[0-9+\-*/().,%]+$/.test(expr)) return '';
  return expr.replace(/(\d[\d.,]*)(%?)/g, (_m, num, pct) => {
    const normalized = normalizeNumberToken(num);
    const parsed = parseFloat(normalized);
    if (!Number.isFinite(parsed)) return '0';
    const value = pct ? parsed / 100 : parsed;
    return String(value);
  });
};

const evaluateExpression = (expr: string): number => {
  let i = 0;

  const readNumber = (): number => {
    let start = i;
    let hasDot = false;
    if (expr[i] === '.') {
      hasDot = true;
      i += 1;
    }
    while (i < expr.length) {
      const ch = expr[i];
      if (ch >= '0' && ch <= '9') {
        i += 1;
        continue;
      }
      if (ch === '.') {
        if (hasDot) break;
        hasDot = true;
        i += 1;
        continue;
      }
      break;
    }
    const numStr = expr.slice(start, i);
    if (!numStr || numStr === '.') throw new Error('Invalid number');
    const num = Number(numStr);
    if (!Number.isFinite(num)) throw new Error('Invalid number');
    return num;
  };

  const parseFactor = (): number => {
    const ch = expr[i];
    if (ch === '+') {
      i += 1;
      return parseFactor();
    }
    if (ch === '-') {
      i += 1;
      return -parseFactor();
    }
    if (ch === '(') {
      i += 1;
      const value = parseExpression();
      if (expr[i] !== ')') throw new Error('Missing )');
      i += 1;
      return value;
    }
    return readNumber();
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (i < expr.length) {
      const ch = expr[i];
      if (ch === '*' || ch === '/') {
        i += 1;
        const rhs = parseFactor();
        value = ch === '*' ? value * rhs : value / rhs;
        continue;
      }
      break;
    }
    return value;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (i < expr.length) {
      const ch = expr[i];
      if (ch === '+' || ch === '-') {
        i += 1;
        const rhs = parseTerm();
        value = ch === '+' ? value + rhs : value - rhs;
        continue;
      }
      break;
    }
    return value;
  };

  const result = parseExpression();
  if (i !== expr.length) throw new Error('Unexpected input');
  return result;
};

const parseNumericInput = (raw: string): number => {
  if (!raw) return NaN;
  try {
    const expr = normalizeNumericExpression(raw);
    if (!expr) return NaN;
    const result = evaluateExpression(expr);
    return Number.isFinite(result) ? result : NaN;
  } catch {
    return NaN;
  }
};

const NumericCellInput = ({ id, value, onCommit, onFocus, onKeyDown, onPaste, style, disabled }: any) => {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);
  const commit = () => {
    const parsed = parseNumericInput(draft);
    if (Number.isFinite(parsed)) {
      onCommit(parsed);
    }
  };
  return (
    <input
      id={id}
      type="text"
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        const parsed = parseNumericInput(next);
        if (Number.isFinite(parsed)) onCommit(parsed);
      }}
      onBlur={commit}
      disabled={disabled}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } onKeyDown?.(e); }}
      onFocus={onFocus}
      onPaste={onPaste}
      style={style}
    />
  );
};

// --- FUNCIÓN DE EXPORTACIÓN A EXCEL (REUTILIZABLE) ---
const generateBudgetExcel = async (project: ProjectMetadata, sections: BudgetSection[], lines: BudgetLine[]) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Presupuesto Detallado');

  worksheet.columns = [
    { header: 'Categoría', key: 'category', width: 20 },
    { header: 'Descripción', key: 'description', width: 50 },
    { header: 'Justificación', key: 'notes', width: 35 },
    { header: 'Cant.', key: 'quantity', width: 10 },
    { header: 'Unidad', key: 'unit', width: 15 },
    { header: 'Frec.', key: 'frequency', width: 10 },
    { header: 'Costo Unit.', key: 'unit_cost', width: 15 },
    { header: 'Total', key: 'total', width: 18 },
  ];

  worksheet.insertRow(1, [project.donor || 'Sin Donante']);
  worksheet.insertRow(2, [`Proyecto: ${project.donor || 'Presupuesto'}`]);
  worksheet.insertRow(3, [`Moneda: ${project.currency} | Tasa USD: ${project.usdRate} | Tasa EUR: ${project.eurRate}`]);
  worksheet.insertRow(4, ['']); 

  worksheet.getRow(1).font = { size: 14, bold: true, color: { argb: '006673' } };
  worksheet.getRow(2).font = { size: 12, bold: true };

  const headerRow = worksheet.getRow(5);
  headerRow.values = ['Categoría', 'Descripción', 'Justificación', 'Cant.', 'Unidad', 'Frec.', 'Costo Unit.', 'Total'];
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '006673' } };
    cell.font = { name: 'Arial', color: { argb: 'FFFFFF' }, bold: true, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  let currentRowIndex = 6;
  const subtotalCells: string[] = []; 

  sections.forEach(section => {
    const sectionRow = worksheet.getRow(currentRowIndex);
    sectionRow.values = [section.name.toUpperCase(), '', '', '', '', '', '', ''];
    worksheet.mergeCells(`A${currentRowIndex}:H${currentRowIndex}`);
    sectionRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2F1' } };
    sectionRow.getCell(1).font = { name: 'Arial', color: { argb: '004D40' }, bold: true };
    
    currentRowIndex++;
    const startRow = currentRowIndex; 
  const sectionLines = lines.filter(l => l.sectionId === section.id && !l.parentId);
  const getChildren = (parentId: string) => lines.filter(l => l.parentId === parentId);

  const writeLineRow = (line: BudgetLine, depth: number) => {
        const row = worksheet.getRow(currentRowIndex);
        row.getCell(1).value = line.category;
        const prefix = depth > 1 ? `${'   '.repeat(depth - 1)}↳ ` : '';
        row.getCell(2).value = `${prefix}${line.description}`;
        row.getCell(3).value = line.notes || '';
        row.getCell(4).value = line.quantity; 
        row.getCell(5).value = line.unit;
        row.getCell(6).value = line.frequency; 
        row.getCell(7).value = line.unit_cost; 
        row.getCell(8).value = { formula: `D${currentRowIndex}*F${currentRowIndex}*G${currentRowIndex}`, result: line.total };

        if (depth > 1) {
            row.font = { color: { argb: '555555' }, size: 9 };
            row.getCell(2).font = { italic: true, color: { argb: '555555' } };
        }
        row.getCell(7).numFmt = '#,##0.00';
        row.getCell(8).numFmt = '#,##0.00';
        row.getCell(8).font = { bold: true };
        currentRowIndex++;
    };

    const writeLineTree = (line: BudgetLine, depth: number) => {
      writeLineRow(line, depth);
      getChildren(line.id).forEach(child => {
        if (depth < 3) writeLineTree(child, depth + 1);
      });
    };

    sectionLines.forEach(mainLine => writeLineTree(mainLine, 1));

    const endRow = currentRowIndex - 1; 
    const sectionFormula = startRow <= endRow ? `SUM(H${startRow}:H${endRow})` : '0';
    
    const subtotalRow = worksheet.getRow(currentRowIndex);
    subtotalRow.values = ['', 'SUBTOTAL ' + section.name, '', '', '', '', '', ''];
    subtotalRow.getCell(8).value = { formula: sectionFormula, result: 0 };
    subtotalCells.push(`H${currentRowIndex}`);
    subtotalRow.getCell(8).font = { bold: true };
    subtotalRow.getCell(8).numFmt = `"${project.currency}" #,##0.00`;
    subtotalRow.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F0F0F0' } };
    currentRowIndex += 2; 
  });

  const totalRow = worksheet.getRow(currentRowIndex);
  const grandTotalFormula = subtotalCells.length > 0 ? subtotalCells.join('+') : '0';
  totalRow.values = ['', '', '', '', '', '', 'TOTAL GENERAL', ''];
  totalRow.getCell(8).value = { formula: grandTotalFormula, result: 0 };
  totalRow.getCell(8).font = { size: 14, bold: true, color: { argb: 'FFFFFF' } };
  totalRow.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '006673' } };
  totalRow.getCell(8).numFmt = `"${project.currency}" #,##0.00`;

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `Presupuesto_${project.donor}_${new Date().toISOString().slice(0,10)}.xlsx`);
};

// --- COMPONENTE AUTO-HEIGHT ---
const AutoExpandingTextarea = ({ value, onChange, isSubline = false, indentLevel = 0, id, onKeyDown, onPaste, ...props }: any) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const adjustHeight = () => {
    const node = textareaRef.current;
    if (node) { node.style.height = '0px'; node.style.height = `${node.scrollHeight}px`; }
  };
  useEffect(() => { const timer = setTimeout(adjustHeight, 0); return () => clearTimeout(timer); }, [value]);
  const indent = indentLevel > 0 ? indentLevel : (isSubline ? 1 : 0);
  return (
    <textarea
      id={id} ref={textareaRef} value={value} onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown} onPaste={onPaste} {...props} rows={1}
      style={{ ...styles.excelTextarea, paddingLeft: `${8 + (indent * 16)}px`, paddingTop: '4px', paddingBottom: '4px' }}
    />
  );
};

// --- PANTALLA INICIO ---
const HomeScreen = ({ onNavigate, projects, onSelectProject }: any) => (
  <div className="home-shell">
    <div className="home-card">
      <div className="home-sidebar">
        <h1 className="home-title" style={{fontFamily: 'Aptos, sans-serif'}}>
          <span className="accent">BudgetCAT</span> 🐱
        </h1>
        <div className="home-actions">
          <button className="home-btn primary" onClick={() => onNavigate('create-project')} style={{fontFamily: 'Aptos, sans-serif'}}>📝 Nuevo Proyecto</button>
          <button className="home-btn secondary" onClick={() => onNavigate('memory-manager')} style={{fontFamily: 'Aptos, sans-serif'}}>🧠 Gestionar Memoria</button>
        </div>
      </div>
      <div className="home-main">
        <h3 className="home-section-title" style={{fontFamily: 'Aptos, sans-serif'}}>📂 Proyectos Recientes</h3>
        <div style={styles.projectList}>
          {projects.length === 0 ? <p style={{color:'var(--text-muted)', textAlign:'center', marginTop:50, fontFamily: 'Aptos, sans-serif'}}>No hay proyectos guardados.</p> :
            projects.map((p: any) => (
              <div key={p.id} className="home-project-card" onClick={() => onSelectProject(p)}>
                <div style={{display:'flex', justifyContent:'space-between', width: '100%', fontFamily: 'Aptos, sans-serif'}}>
                  <span style={{fontWeight:'bold'}}>{p.name}</span>
                  <span>ABRIR →</span>
                </div>
              </div>
            ))
          }
        </div>
      </div>
    </div>
  </div>
);

// --- PANTALLA GESTOR DE MEMORIA (ACTUALIZADA: LÁPIZ = EDITAR) ---
const MemoryManagerScreen = ({ onBack, appProjects = [], onDeleteProject, onOpenEditor, onUpdateProject }: any) => {
  const [importedSources, setImportedSources] = useState<MemorySource[]>([]);
  const [filterType, setFilterType] = useState<'all' | 'excel' | 'app'>('all');
  const [searchText, setSearchText] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editingInputRef = useRef<HTMLInputElement | null>(null);

  const normalizeSource = (s: Partial<MemorySource>): MemorySource => ({
    id: s.id || generateId(),
    name: s.name || 'Importación Excel',
    type: s.type === 'app' ? 'app' : 'excel',
    date: s.date ? new Date(s.date).toLocaleDateString() : new Date().toLocaleDateString(),
    tags: s.tags || ['Excel'],
    count: s.count || 0,
    originalData: s.originalData
  });

  const loadImportedSources = useCallback(async () => {
    try {
      const result = await window.budgetAPI.getMemorySources();
      setImportedSources(Array.isArray(result) ? result.map(r => normalizeSource(r)) : []);
      setIsEditing(false);
      setEditingSourceId(null);
      setEditingName('');
    } catch (error) { console.error(error); }
  }, []);

  useEffect(() => { loadImportedSources(); }, [loadImportedSources]);
  useEffect(() => { if (isEditing && editingSourceId && editingInputRef.current) editingInputRef.current.focus(); }, [editingSourceId, isEditing]);
  useEffect(() => { 
    // Al entrar en la pantalla, asegúrate de que no haya edición activa residual
    setIsEditing(false);
    setEditingSourceId(null); 
    setEditingName(''); 
  }, []);

  const startEditingName = (source: MemorySource) => {
    setIsEditing(true);
    setEditingSourceId(source.id);
    setEditingName(source.name);
  };

  const cancelEditing = () => { setIsEditing(false); setEditingSourceId(null); setEditingName(''); };

  const submitRename = async (source: MemorySource) => {
    const newName = editingName.trim();
    if (!newName || newName === source.name) { cancelEditing(); return; }
    try {
      const result = await window.budgetAPI.renameMemorySource(source.id, newName, source.type);
      if (result.success) {
        if (source.type === 'app') {
          onUpdateProject?.(source.id, { name: newName });
        } else {
          setImportedSources(prev => prev.map(s => s.id === source.id ? { ...s, name: newName } : s));
        }
      } else {
        alert(result.message || 'No se pudo renombrar.');
      }
    } catch (error) {
      console.error(error);
      alert('Error al renombrar.');
    } finally {
      cancelEditing();
    }
  };

  const appSources: MemorySource[] = appProjects.map((p: any) => ({
      id: p.id, name: p.name || 'Sin nombre', type: 'app', date: new Date().toLocaleDateString(),
      tags: [p.donor, p.sector].filter(Boolean), count: JSON.parse(p.data_json || '{}').lines?.length || 0, originalData: p
  }));
  const allSources = [...importedSources, ...appSources];
  const filteredSources = allSources.filter(s => {
      const matchesType = filterType === 'all' ? true : s.type === filterType;
      const term = searchText.toLowerCase();
      return matchesType && (s.name.toLowerCase().includes(term) || s.tags.some(t => t.toLowerCase().includes(term)));
  });

  const handleImport = async (e: React.MouseEvent) => {
      e.stopPropagation(); setIsAiLoading(true);
      try {
        const result = await window.budgetAPI.importSmartBudget();
        if (result && result.success) { await loadImportedSources(); alert(`✅ Importado correctamente.`); }
      } catch (err) { alert("Error IA"); } finally { setIsAiLoading(false); }
  };

  const handleDownload = (e: React.MouseEvent, source: MemorySource) => {
      e.stopPropagation();
      if (source.type === 'app' && source.originalData) {
          try {
              const data = JSON.parse(source.originalData.data_json);
              const metaWithRates = { ...data.meta, usdRate: data.meta?.usdRate || 3.75, eurRate: data.meta?.eurRate || 4.05 };
              generateBudgetExcel(metaWithRates, data.sections, data.lines);
          } catch(err) { alert("Error al generar Excel."); }
      } else { alert("Descarga de importados no disponible en esta versión."); }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, type: string) => {
      e.stopPropagation();
      if (window.confirm("¿Estás seguro de eliminar esta fuente permanentemente?")) {
          if (type === 'app') {
             // Si tienes lógica para borrar proyectos app, va aquí
             onDeleteProject(id); 
          } else {
             // Lógica para borrar IMPORTACIONES (Excel/IA) de la BD
             try {
                const result = await window.budgetAPI.deleteMemorySource(id);
                if (result.success) {
                    // Si la BD dice que se borró, entonces actualizamos la pantalla
                    setImportedSources(prev => prev.filter(s => s.id !== id));
                } else {
                    alert("No se pudo eliminar de la base de datos.");
                }
             } catch (error) {
                console.error(error);
                alert("Error de conexión al intentar eliminar.");
             }
          }
      }
  };

  return (
    <div className="memory-shell">
      <div className="memory-card" style={{ position: 'relative' }}>
        <div className="memory-header">
            <h2 className="memory-title" style={{fontFamily: 'Aptos, sans-serif'}}>🧠 Gestión de Memoria</h2>
            <button className="editor-close" onClick={onBack} style={{...styles.closeBtn, padding: '5px 15px', fontSize: '12px'}}>← Volver</button>
        </div>
        <div className="memory-toolbar">
            <button className="ribbon-btn editor-btn-primary" onClick={handleImport} style={{width: 'auto', fontSize: 13}}>📥 Importar Excel Nuevo</button>
            <input className="memory-search" placeholder="🔍 Buscar..." value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{...styles.input, marginBottom: 0, width: '300px'}} />
            {['all', 'excel', 'app'].map(t => (
              <button key={t} className={`memory-filter ${filterType === t ? 'is-active' : ''}`} onClick={() => setFilterType(t as any)} style={{textTransform: 'capitalize'}}>
                {t === 'all' ? 'Todos' : t === 'excel' ? 'Importados' : 'Apps'}
              </button>
            ))}
        </div>
        <div style={{flex: 1, padding: '20px 30px', overflowY: 'auto'}}>
            <table className="memory-table">
                <thead>
                  <tr style={{textAlign: 'left'}}>
                    <th style={{padding:10}}>Nombre</th>
                    <th style={{padding:10}}>Tipo</th>
                    <th style={{padding:10}}>Items</th>
                    <th style={{padding:10}}>Fecha</th>
                    <th style={{padding:10}}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                    {filteredSources.map(s => (
                        <tr key={s.id}>
                            <td style={{padding: 10, fontWeight: 'bold'}}>
                              {isEditing && editingSourceId === s.id ? (
                                <input
                                  ref={editingInputRef}
                                  value={editingName || s.name}
                                  onChange={(e) => setEditingName(e.target.value)}
                                  onBlur={() => submitRename(s)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') submitRename(s);
                                    if (e.key === 'Escape') cancelEditing();
                                  }}
                                  className="memory-search"
                                  style={{ width: '100%', padding: '4px', borderRadius: 6 }}
                                />
                              ) : (
                                <span style={{cursor: 'text'}} onDoubleClick={() => startEditingName(s)} title="Doble clic para renombrar">
                                  {s.name}
                                </span>
                              )}
                            </td>
                            <td style={{padding: 10}}>
                              <span className={`memory-pill ${s.type === 'excel' ? 'is-excel' : 'is-app'}`}>{s.type.toUpperCase()}</span>
                            </td>
                            <td style={{padding: 10, color: 'var(--text-muted)'}}>{s.count}</td>
                            <td style={{padding: 10, color: 'var(--text-muted)'}}>{s.date}</td>
                            <td className="memory-actions" style={{padding: 10, textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 8}}>
                                <button onClick={(e) => handleDownload(e, s)} title="Descargar">⬇️</button>
                                {/* 👇 AQUÍ ESTÁ EL CAMBIO IMPORTANTE: EL LÁPIZ AHORA EDITA */}
                                <button onClick={() => onOpenEditor(s)} title="Abrir en Editor">✏️</button>
                                <button onClick={(e) => handleDelete(e, s.id, s.type)} title="Eliminar">🗑️</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        {isAiLoading && (
          <div className="memory-overlay">
            <div className="editor-overlay-card">
              <div className="editor-overlay-emoji">🧠🐱</div>
              <h3 className="editor-overlay-title" style={{fontFamily: 'Aptos, sans-serif'}}>Leyendo...</h3>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const CreateProjectScreen = ({ onStart, onBack, onImportToEditor }: any) => {
  const [meta, setMeta] = useState<ProjectMetadata>({ donor: '', country: 'Perú', currency: 'PEN', sector: '', duration: 12, usdRate: 3.75, eurRate: 4.05 });
  return (
    <div style={styles.homeContainer} className="form-shell">
      <div className="form-card">
        <h2 className="form-title" style={{fontFamily: 'Aptos, sans-serif'}}>Configurar Proyecto</h2>
        <input className="form-field" placeholder="Donante" onChange={e => setMeta({...meta, donor: e.target.value})} />
        <input className="form-field" placeholder="Sector" onChange={e => setMeta({...meta, sector: e.target.value})} />
        <div style={{display:'flex', gap:10}}>
          <select className="form-field" value={meta.currency} onChange={e => setMeta({...meta, currency: e.target.value})}>
              <option value="PEN">PEN</option><option value="USD">USD</option><option value="EUR">EUR</option>
          </select>
          <input type="number" className="form-field" placeholder="Meses" onChange={e => setMeta({...meta, duration: parseInt(e.target.value)})} />
        </div>
        <div className="form-actions">
          <button className="form-btn primary" style={{fontFamily: 'Aptos, sans-serif'}} onClick={() => onStart(meta)}>Empezar</button>
          <button className="form-btn secondary" style={{fontFamily: 'Aptos, sans-serif'}} onClick={() => onImportToEditor(meta)} title="Importación asistida con IA">Importar Excel (IA)</button>
          <button className="form-btn ghost" style={{fontFamily: 'Aptos, sans-serif'}} onClick={onBack}>Atrás</button>
        </div>
      </div>
    </div>
  )
}

// --- EDITOR PRINCIPAL ---
const EditorScreen = ({ initialData, onBack }: { initialData: ProjectFile, onBack: () => void }) => {
  const [project, setProject] = useState(initialData.meta); 
  const [sections, setSections] = useState(initialData.sections);
  const [lines, setLines] = useState(initialData.lines);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CostItem[]>([]);
  const [focusRequest, setFocusRequest] = useState<{ id: string, field: string } | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [filterText, setFilterText] = useState('');
  const [draggedLineId, setDraggedLineId] = useState<string | null>(null);
  
  // ESTADO NUEVO: CARGA IA
  const [isAiLoading, setIsAiLoading] = useState(false);

  const columns = ['category', 'description', 'quantity', 'unit', 'frequency', 'unit_cost'];

  useEffect(() => {
    if (focusRequest) {
      const el = document.getElementById(`cell-${focusRequest.id}-${focusRequest.field}`);
      if (el) el.focus();
      setFocusRequest(null);
    }
  }, [focusRequest, lines]);

  const takeSnapshot = () => {
    const data = JSON.stringify({ sections, lines: computedLines });
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second:'2-digit' });
    setSnapshots(prev => [{ timestamp, data }, ...prev].slice(0, 4));
  };

  const restoreSnapshot = (snap: Snapshot) => {
      if(window.confirm(`¿Restaurar versión de las ${snap.timestamp}?`)) {
          try { const parsed = JSON.parse(snap.data); setSections(parsed.sections); setLines(parsed.lines); } catch(e) { alert("Error al restaurar"); }
      }
  };

  const triggerSearch = async (t: string) => {
    if (!t || t.trim().length === 0) { setSuggestions([]); return; }
    try { const r = await window.budgetAPI.searchCost(t); setSuggestions(Array.isArray(r) ? r : []); } catch (error) { setSuggestions([]); }
  }

  const handleCellFocus = (line: BudgetLine) => { setActiveRowId(line.id); triggerSearch(line.description || line.category || ''); };
  
  // --- FUNCIÓN DE CÁLCULO DE JERARQUÍA CORREGIDA ---
  const recalcHierarchy = (allLines: BudgetLine[]): BudgetLine[] => {
    // 1. Crear mapa de referencias
    const byId = new Map(allLines.map(l => [l.id, { ...l }]));
    const childrenMap = new Map<string, string[]>();

    // 2. Organizar relaciones padre-hijo
    allLines.forEach(l => {
        if (!l.parentId) return;
        if (!byId.has(l.parentId)) return; // Evitar huérfanos
        const list = childrenMap.get(l.parentId) || [];
        list.push(l.id);
        childrenMap.set(l.parentId, list);
    });

    // 3. Función recursiva de cálculo
    const computeTotal = (id: string): number => {
        const line = byId.get(id);
        if (!line) return 0;

        const childrenIds = childrenMap.get(id) || [];
        
        // Valores base sanitizados
        const qty = safeVal(line.quantity);
        const freq = safeVal(line.frequency);
        
        // CASO 1: Ítem final
        if (childrenIds.length === 0) {
            const uCost = safeVal(line.unit_cost);
            const baseTotal = qty * freq * uCost;
            byId.set(id, { ...line, quantity: qty, frequency: freq, unit_cost: uCost, total: baseTotal });
            return baseTotal;
        }

        // CASO 2: Padre (Suma de hijos)
        const sumChildren = childrenIds.reduce((acc, childId) => acc + computeTotal(childId), 0);
        const parentUnitCost = sumChildren; // Costo unitario es la suma de los hijos
        const total = qty * freq * parentUnitCost; // Total padre = Su Qty * Su Freq * SumaHijos

        byId.set(id, { ...line, quantity: qty, frequency: freq, unit_cost: parentUnitCost, total });
        return total;
    };

    allLines.forEach(l => {
        if (!l.parentId) computeTotal(l.id);
    });

    return allLines.map(l => byId.get(l.id) as BudgetLine);
  };

  const computedLines = useMemo(() => recalcHierarchy(lines), [lines]);
  const getChildren = (parentId: string) => computedLines.filter(l => l.parentId === parentId);
  const matchesFilter = (line: BudgetLine, term: string) => (
    line.description.toLowerCase().includes(term) || line.category.toLowerCase().includes(term)
  );
  const hasDescendantMatch = (lineId: string, term: string): boolean => {
    const children = getChildren(lineId);
    for (const child of children) {
      if (matchesFilter(child, term)) return true;
      if (hasDescendantMatch(child.id, term)) return true;
    }
    return false;
  };
  const hasAncestorMatch = (line: BudgetLine, term: string): boolean => {
    let current = line;
    while (current.parentId) {
      const parent = computedLines.find(p => p.id === current.parentId);
      if (!parent) break;
      if (matchesFilter(parent, term)) return true;
      current = parent;
    }
    return false;
  };
  const isLineVisible = (l: BudgetLine) => {
    if (!filterText) return true;
    const lower = filterText.toLowerCase();
    if (matchesFilter(l, lower)) return true;
    if (hasDescendantMatch(l.id, lower)) return true;
    if (hasAncestorMatch(l, lower)) return true;
    return false;
  };

  const updateLine = (id: string, field: keyof BudgetLine, value: any) => {
    setLines(prev => {
      let nextLines = prev.map(l => {
        if (l.id === id) {
          // Asegurar que si es campo numérico, se guarde como número
          let safeValue = value;
          if (['quantity', 'frequency', 'unit_cost'].includes(field)) {
             safeValue = safeVal(value); 
          }

          const u = { ...l, [field]: safeValue };
          // El cálculo de u.total real se hace en recalcHierarchy, pero actualizamos localmente
          if (['quantity', 'frequency', 'unit_cost'].includes(field)) {
             u.total = (u.quantity || 0) * (u.frequency || 0) * (u.unit_cost || 0);
          }
          if (field === 'description' || (field === 'category' && !u.description)) triggerSearch(String(value));
          return u;
        }
        return l;
      });
      nextLines = recalcHierarchy(nextLines);
      return nextLines;
    });
  }

  const toggleNotes = (id: string) => setLines(prev => prev.map(l => l.id === id ? { ...l, showNotes: !l.showNotes } : l));
  const applyMatch = (m: CostItem) => { if (!activeRowId) return; updateLine(activeRowId, 'description', m.description); updateLine(activeRowId, 'unit', m.unit); updateLine(activeRowId, 'category', m.category); updateLine(activeRowId, 'unit_cost', m.unit_cost); }
  
  const addNewLine = (sId: string, parentId?: string) => {
    const id = generateId();
    setLines(prev => [...prev, { id, sectionId: sId, parentId, category: '', description: '', quantity: 1, frequency: 1, unit: 'Unid', unit_cost: 0, total: 0, selected: false }]);
    setActiveRowId(id);
    setFocusRequest({ id, field: 'description' });
  }

  const getDescendantIds = (lineId: string, allLines: BudgetLine[]): string[] => {
    const ids: string[] = [];
    const stack = [lineId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const children = allLines.filter(l => l.parentId === current);
      children.forEach(child => {
        ids.push(child.id);
        stack.push(child.id);
      });
    }
    return ids;
  };

  const deleteLine = (lineId: string) => {
    setLines(prev => {
        const line = prev.find(l => l.id === lineId);
        if(!line) return prev;
        const descendants = getDescendantIds(lineId, prev);
        return prev.filter(l => l.id !== lineId && !descendants.includes(l.id));
    });
    setActiveRowId(null);
  };

  const duplicateLine = (lineId: string) => {
    setLines(prev => {
        const original = prev.find(l => l.id === lineId);
        if(!original) return prev;
        const subtree: BudgetLine[] = [];
        const build = (id: string) => {
          const line = prev.find(l => l.id === id);
          if (!line) return;
          subtree.push(line);
          prev.filter(l => l.parentId === id).forEach(child => build(child.id));
        };
        build(lineId);

        const idMap = new Map<string, string>();
        subtree.forEach(l => idMap.set(l.id, generateId()));
        const clones = subtree.map(l => ({
          ...l,
          id: idMap.get(l.id) as string,
          parentId: l.parentId ? (idMap.get(l.parentId) || l.parentId) : l.parentId
        }));

        const indices = subtree.map(l => prev.findIndex(p => p.id === l.id)).filter(i => i >= 0);
        const insertAt = (indices.length ? Math.max(...indices) : prev.findIndex(p => p.id === lineId)) + 1;
        const newLines = [...prev];
        newLines.splice(insertAt, 0, ...clones);
        return newLines;
    });
  };

  const toggleSection = (sectionId: string) => setSections(prev => prev.map(s => s.id === sectionId ? { ...s, collapsed: !s.collapsed } : s));
  const handleKeyDown = (e: React.KeyboardEvent, line: BudgetLine, field: string) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      moveFocusVertical(line, field, 1);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNewLine(line.sectionId, line.parentId); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); deleteLine(line.id); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); duplicateLine(line.id); return; }
    const isText = ['description', 'category', 'unit'].includes(field);
    const target = e.target as HTMLTextAreaElement | HTMLInputElement;
    if (e.key === 'ArrowUp') { if (isText && target.selectionStart && target.selectionStart > 0) return; e.preventDefault(); moveFocusVertical(line, field, -1); }
    if (e.key === 'ArrowDown') { if (isText && target.selectionStart !== null && target.value && target.selectionStart < target.value.length) return; e.preventDefault(); moveFocusVertical(line, field, 1); }
    if (e.key === 'ArrowRight' || e.key === 'Tab') { if (e.key === 'ArrowRight' && isText && target.selectionStart !== null && target.value && target.selectionStart < target.value.length) return; e.preventDefault(); moveFocusHorizontal(line, field, 1); }
    if (e.key === 'ArrowLeft') { if (isText && target.selectionStart && target.selectionStart > 0) return; e.preventDefault(); moveFocusHorizontal(line, field, -1); }
  };
  
  const getOrderedLinesForSection = (sectionId: string) => {
    const ordered: BudgetLine[] = [];
    const roots = computedLines.filter(l => l.sectionId === sectionId && !l.parentId);
    const add = (line: BudgetLine) => {
      if (!isLineVisible(line)) return;
      ordered.push(line);
      getChildren(line.id).forEach(child => add(child));
    };
    roots.forEach(root => add(root));
    return ordered;
  };

  const moveFocusVertical = (currentLine: BudgetLine, field: string, direction: number) => {
    const flatVisualList = sections.flatMap(s => s.collapsed ? [] : getOrderedLinesForSection(s.id));
    const idx = flatVisualList.findIndex(l => l.id === currentLine.id);
    const target = flatVisualList[idx + direction];
    if (target) document.getElementById(`cell-${target.id}-${field}`)?.focus();
  }
  const moveFocusHorizontal = (currentLine: BudgetLine, currentField: string, direction: number) => {
    const colIdx = columns.indexOf(currentField);
    if (colIdx === -1) return;
    const newColIdx = colIdx + direction;
    if (newColIdx >= 0 && newColIdx < columns.length) { document.getElementById(`cell-${currentLine.id}-${columns[newColIdx]}`)?.focus(); } else {
        const flatVisualList = sections.flatMap(s => s.collapsed ? [] : getOrderedLinesForSection(s.id));
        const rowIdx = flatVisualList.findIndex(l => l.id === currentLine.id) + (direction > 0 ? 1 : -1);
        const target = flatVisualList[rowIdx];
        const targetField = direction > 0 ? columns[0] : columns[columns.length - 1];
        if (target) document.getElementById(`cell-${target.id}-${targetField}`)?.focus();
    }
  }

  const handleDragStart = (e: React.DragEvent, lineId: string) => { setDraggedLineId(lineId); e.dataTransfer.effectAllowed = 'move'; };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDropOnSection = (e: React.DragEvent, sectionId: string) => {
    e.preventDefault();
    if (!draggedLineId) return;
    setLines(prevLines => {
      const draggedLine = prevLines.find(l => l.id === draggedLineId);
      if (!draggedLine) return prevLines;
      const descendantIds = getDescendantIds(draggedLine.id, prevLines);
      return prevLines.map(l => {
        if (l.id === draggedLineId) return { ...l, sectionId, parentId: undefined };
        if (descendantIds.includes(l.id)) return { ...l, sectionId };
        return l;
      });
    });
    setDraggedLineId(null);
  };

  const handlePaste = (e: React.ClipboardEvent, lineId: string, field: keyof BudgetLine) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n') && !text.includes('\r')) return;
    e.preventDefault();
    const rows = text.split(/\r\n|\n|\r/).filter(r => r.length > 0);
    setLines(prevLines => {
      const startIndex = prevLines.findIndex(l => l.id === lineId);
      if (startIndex === -1) return prevLines;
      const newLines = [...prevLines];
      rows.forEach((rowText, i) => {
        const targetIndex = startIndex + i;
        if (targetIndex < newLines.length) {
          const currentLine = newLines[targetIndex];
          let val: any = rowText.split('\t')[0]; 
          if (['quantity', 'frequency', 'unit_cost'].includes(field)) {
            const parsed = parseNumericInput(String(val));
            val = Number.isFinite(parsed) ? parsed : 0;
          }
          const u = { ...currentLine, [field]: val };
          if (['quantity', 'frequency', 'unit_cost'].includes(field)) { u.total = u.quantity * u.frequency * u.unit_cost; }
          newLines[targetIndex] = u;
        }
      });
      return newLines;
    });
  };

  // --- FUNCIÓN NUEVA PARA MANEJAR LA IMPORTACIÓN CON IA (CORREGIDA) ---
  const handleSmartImport = async () => {
    setIsAiLoading(true);
    try {
      const result = await window.budgetAPI.importSmartBudget();
      
      if (result.success && result.data && result.data.length > 0) {
        
        // Mapas para agrupar por categoría
        const newSectionsMap = new Map<string, string>(); // NombreCategoría -> IDSeccion
        const sectionsToAdd: BudgetSection[] = [];
        const linesToAdd: BudgetLine[] = [];

        result.data.forEach((item: any) => {
          // Detectar o crear sección basada en la categoría de la IA
          const categoryName = item.category || 'General';
          
          if (!newSectionsMap.has(categoryName)) {
            const newSectionId = generateId();
            newSectionsMap.set(categoryName, newSectionId);
            sectionsToAdd.push({ 
              id: newSectionId, 
              name: categoryName.toUpperCase(), 
              collapsed: false 
            });
          }

          const sectionId = newSectionsMap.get(categoryName)!;
          
          // Limpieza de números (Manejo de strings tipo "1,200.50")
          const rawCost = item.unit_cost ? String(item.unit_cost).replace(/,/g, '') : '0';
          const rawQty = item.quantity ? String(item.quantity).replace(/,/g, '') : '1';
          
          const unitCost = parseFloat(rawCost) || 0;
          const qty = parseFloat(rawQty) || 1;

          linesToAdd.push({
            id: generateId(),
            sectionId: sectionId,
            parentId: undefined, // Importados como items principales
            category: item.category || 'Varios',
            description: item.description || 'Ítem importado',
            unit: item.unit || 'Und',
            quantity: qty,
            frequency: 1,
            unit_cost: unitCost,
            total: qty * 1 * unitCost,
            selected: false,
            showNotes: false
          });
        });
  
        // Actualizar estado y recalcular jerarquía inmediatamente
        setSections(prev => [...prev, ...sectionsToAdd]);
        setLines(prev => {
            const merged = [...prev, ...linesToAdd];
            return recalcHierarchy(merged);
        });
        
        alert(`✅ Se importaron ${linesToAdd.length} líneas en ${sectionsToAdd.length} secciones nuevas.`);
      } else {
        if (result.message) console.log(result.message);
        alert("⚠️ La IA no devolvió datos válidos.");
      }
    } catch (error) {
      console.error(error);
      alert("❌ Error al procesar con IA. Revisa la consola.");
    } finally {
      setIsAiLoading(false);
    }
  };

  const grandTotal = computedLines.reduce((acc, curr) => acc + (curr.parentId ? 0 : curr.total), 0);
  const sectionTotals = sections.map(s => ({ name: s.name, total: computedLines.filter(l => l.sectionId === s.id && !l.parentId).reduce((sum, l) => sum + l.total, 0) }));
  const hasChildren = (lineId: string) => computedLines.some(l => l.parentId === lineId);

  const renderLineTree = (line: BudgetLine, depth: number, sectionId: string) => {
    if (!isLineVisible(line)) return null;
    const children = getChildren(line.id);
    const isSub = depth > 1;
    const canAddSub = depth < 3;
    const rowHasChildren = hasChildren(line.id);
    const indentLevel = depth - 1;
    const connectorLeft = 8 + (indentLevel * 16) - 10;

    return (
      <React.Fragment key={line.id}>
        <tr className={`editor-row ${isSub ? 'editor-subrow' : ''} ${activeRowId === line.id ? 'is-active' : ''}`} style={{cursor: 'pointer'}} onClick={() => setActiveRowId(line.id)} draggable onDragStart={(e) => handleDragStart(e, line.id)} onDragOver={handleDragOver} onDrop={(e) => handleDropOnSection(e, sectionId)}>
          <td style={{textAlign:'center', cursor: 'grab'}}>
            {depth === 1 ? (
              <div style={{display:'flex', alignItems:'center', justifyContent:'center'}}>
                <span style={{color:'var(--text-muted)', marginRight:4, fontSize:10}}>⠿</span>
                <input type="checkbox" checked={line.selected} onChange={() => setLines(lines.map(x => x.id === line.id ? {...x, selected: !x.selected} : x))} />
              </div>
            ) : (
              <span style={{color:'var(--text-muted)', fontSize:10}}>⠿</span>
            )}
          </td>
          <td>
            <AutoExpandingTextarea id={`cell-${line.id}-category`} onPaste={(e: any) => handlePaste(e, line.id, 'category')} onFocus={() => handleCellFocus(line)} onKeyDown={(e:any) => handleKeyDown(e, line, 'category')} value={line.category} onChange={(v:any) => updateLine(line.id, 'category', v)} />
          </td>
          <td>
              <div style={{display: 'flex', flexDirection: 'column', position: 'relative'}}>
                  {indentLevel > 0 && (
                    <>
                      <span style={{position: 'absolute', left: connectorLeft, top: 0, bottom: 0, width: 1, background: 'rgba(139, 92, 246, 0.6)', pointerEvents: 'none'}} />
                      <span style={{position: 'absolute', left: connectorLeft, top: '50%', width: 10, height: 1, background: 'rgba(139, 92, 246, 0.6)', pointerEvents: 'none'}} />
                      {indentLevel >= 2 && (
                        <span style={{position: 'absolute', left: connectorLeft, top: 'calc(50% + 6px)', width: 10, height: 1, background: 'rgba(139, 92, 246, 0.6)', pointerEvents: 'none'}} />
                      )}
                    </>
                  )}
                  <AutoExpandingTextarea id={`cell-${line.id}-description`} onPaste={(e: any) => handlePaste(e, line.id, 'description')} onFocus={() => handleCellFocus(line)} onKeyDown={(e:any) => handleKeyDown(e, line, 'description')} value={line.description} onChange={(v:any) => updateLine(line.id, 'description', v)} indentLevel={indentLevel} />
                  {line.showNotes && (<input placeholder="📝 Justificación técnica..." value={line.notes || ''} onChange={(e) => updateLine(line.id, 'notes', e.target.value)} style={{...styles.narrativeInput, paddingLeft: `${8 + (indentLevel * 16)}px`}} autoFocus />)}
              </div>
          </td>
          <td><NumericCellInput id={`cell-${line.id}-quantity`} onPaste={(e: any) => handlePaste(e, line.id, 'quantity')} onFocus={() => handleCellFocus(line)} onKeyDown={(e: any) => handleKeyDown(e, line, 'quantity')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} value={line.quantity} onCommit={(v: number) => updateLine(line.id, 'quantity', v)} /></td>
          <td><AutoExpandingTextarea id={`cell-${line.id}-unit`} onPaste={(e: any) => handlePaste(e, line.id, 'unit')} onFocus={() => handleCellFocus(line)} onKeyDown={(e:any) => handleKeyDown(e, line, 'unit')} value={line.unit} onChange={(v:any) => updateLine(line.id, 'unit', v)} /></td>
          <td><NumericCellInput id={`cell-${line.id}-frequency`} onPaste={(e: any) => handlePaste(e, line.id, 'frequency')} onFocus={() => handleCellFocus(line)} onKeyDown={(e: any) => handleKeyDown(e, line, 'frequency')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} value={line.frequency} onCommit={(v: number) => updateLine(line.id, 'frequency', v)} /></td>
          <td style={{background: rowHasChildren ? 'rgba(0,0,0,0.08)' : 'transparent'}}>
            <NumericCellInput id={`cell-${line.id}-unit_cost`} onPaste={(e: any) => handlePaste(e, line.id, 'unit_cost')} onFocus={() => handleCellFocus(line)} onKeyDown={(e: any) => handleKeyDown(e, line, 'unit_cost')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif', fontWeight: rowHasChildren ? 'bold' : 'normal'}} value={line.unit_cost} onCommit={(v: number) => updateLine(line.id, 'unit_cost', v)} disabled={rowHasChildren} />
          </td>
          <td style={{textAlign:'right', fontWeight: depth === 1 ? 'bold' : 'normal', paddingRight:10, fontSize: depth > 1 ? 11 : undefined}}>{fmt(line.total)}</td>
          <td></td>
          <td style={{textAlign:'center'}}>
            <button className="editor-icon-btn" onClick={(e) => { e.stopPropagation(); toggleNotes(line.id); }} style={{...styles.iconBtn, color: line.notes ? 'var(--primary)' : 'var(--text-muted)'}}>📝</button>
            {canAddSub && <button className="editor-sub-btn" onClick={(e) => { e.stopPropagation(); addNewLine(sectionId, line.id); }} style={styles.addSubBtn}>+ Sub</button>}
          </td>
        </tr>
        {children.map(child => renderLineTree(child, depth + 1, sectionId))}
      </React.Fragment>
    );
  };
  const updateSection = (id: string, patch: Partial<BudgetSection>) => setSections(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));

  return (
    <div className="editor-shell" style={{ overflow: 'hidden', fontFamily: 'Aptos, sans-serif' }}>
      <div className="editor-topbar" style={styles.topBar}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <span style={{fontFamily: 'Aptos, sans-serif'}}>🐱 <b>BudgetCAT</b></span>
          <input className="editor-field" style={styles.headerEditableInput} value={project.donor} onChange={e => setProject({...project, donor: e.target.value})} />
          <div style={styles.exchangeRateContainer}>
             <span>1 USD = S/</span> <input type="number" step="0.01" style={styles.rateInput} value={project.usdRate} onChange={e => setProject({...project, usdRate: parseFloat(e.target.value)})} />
             <span>1 EUR = S/</span> <input type="number" step="0.01" style={styles.rateInput} value={project.eurRate} onChange={e => setProject({...project, eurRate: parseFloat(e.target.value)})} />
          </div>
          <select className="editor-field editor-select" style={styles.headerSelect} value={project.currency} onChange={e => setProject({...project, currency: e.target.value})}>
            <option value="PEN">PEN</option><option value="USD">USD</option><option value="EUR">EUR</option>
          </select>
        </div>
        <button className="editor-close" onClick={onBack} style={{...styles.closeBtn, fontFamily: 'Aptos, sans-serif'}}>Cerrar</button>
      </div>
      <div className="ribbon editor-ribbon">
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif'}} onClick={() => { const id = generateId(); setSections([...sections, { id, name: 'Nueva Sección' }]); addNewLine(id); }}>📂 + Sección</button>
        {/* 👇 BOTÓN NUEVO DE IA */}
        <button className="ribbon-btn editor-btn-primary" style={{fontFamily: 'Aptos, sans-serif'}} onClick={handleSmartImport}>✨ Importar IA</button>
        
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif'}} onClick={async () => { await window.budgetAPI.saveProjectInternal({ name: `${project.donor}`, ...project, data_json: JSON.stringify({ sections, lines: computedLines }) }); alert("💾 Guardado"); }}>💾 Guardar</button>
        <button className="ribbon-btn editor-btn-warm" style={{fontFamily: 'Aptos, sans-serif'}} onClick={takeSnapshot}>📸 Foto</button>
        <div style={{display:'flex', alignItems:'center', marginLeft: 10}}>
             {snapshots.map((s, i) => <span key={i} onClick={() => restoreSnapshot(s)} style={styles.snapshotBadge}>v{snapshots.length - i}</span>)}
        </div>
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif'}} onClick={() => generateBudgetExcel(project, sections, computedLines)}>📤 Exportar</button>
        <div className="editor-search" style={styles.searchContainer}><span style={{fontSize: 12, marginRight: 5}}>🔍</span><input style={styles.searchInput} placeholder="Filtrar..." value={filterText} onChange={(e) => setFilterText(e.target.value)} /></div>
      </div>

      <div style={{flex:1, display:'flex', overflow:'hidden'}}>
        <div style={{flex:3, overflow:'auto'}}>
          <table className="editor-table" style={{fontFamily: 'Aptos, sans-serif'}}>
            <thead className="editor-table-head" style={{position: 'sticky', top: 0, zIndex: 10}}>
              <tr style={{fontSize: '12px', textAlign: 'left'}}>
                <th style={{width: '35px', padding: '10px'}}>✔</th>
                <th style={{width: '90px'}}>Cat.</th>
                <th style={{width: '420px'}}>Descripción</th>
                <th style={{width: '60px'}}>Cant</th>
                <th style={{width: '60px'}}>Unid</th>
                <th style={{width: '45px'}}>Freq</th>
                <th style={{width: '90px'}}>C*U</th>
                <th style={{width: '115px'}}>Total</th>
                <th style={{width: '45px', fontSize: '11px'}}>%</th>
                <th style={{width: '80px'}}>+Sub</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(s => {
                const sectionTotal = computedLines.filter(l => l.sectionId === s.id && !l.parentId).reduce((sum, l) => sum + l.total, 0);
                const capLimit = s.capType ? (s.capType === 'amount' ? (s.capValue || 0) : (grandTotal * ((s.capValue || 0) / 100))) : null;
                const isOverCap = capLimit !== null && sectionTotal > capLimit;
                return (
                  <React.Fragment key={s.id}>
                    <tr className={`editor-section-row ${isOverCap ? 'cap-warning' : ''}`} style={{position: 'sticky', top: '37px', zIndex: 9}} onDragOver={handleDragOver} onDrop={(e) => handleDropOnSection(e, s.id)}>
                      <td style={{padding:'5px', textAlign:'center'}}><button onClick={() => toggleSection(s.id)} style={{border:'none', background:'transparent', cursor:'pointer', fontWeight:'bold', fontSize:14, color:'var(--text-muted)'}}>{s.collapsed ? '▶' : '▼'}</button></td>
                      <td colSpan={5} style={{padding:'5px'}}>
                        <div className="cap-row">
                          <input style={{...styles.sectionInput, fontFamily: 'Aptos, sans-serif'}} value={s.name} onChange={(e) => updateSection(s.id, { name: e.target.value })} />
                          <div className="cap-control">
                            <span className="cap-label">Límite</span>
                            <select
                              className="cap-select"
                              value={s.capType || 'none'}
                              onChange={(e) => updateSection(s.id, { capType: e.target.value === 'none' ? undefined : (e.target.value as BudgetSection['capType']), capValue: e.target.value === 'none' ? undefined : (s.capValue || 0) })}
                            >
                              <option value="none">Sin</option>
                              <option value="amount">Monto</option>
                              <option value="percent">%</option>
                            </select>
                            {s.capType && (
                              <input
                                className="cap-input"
                                type="number"
                                min={0}
                                step={s.capType === 'percent' ? 1 : 0.01}
                                placeholder={s.capType === 'percent' ? '0-100' : project.currency}
                                value={s.capValue ?? ''}
                                onChange={(e) => updateSection(s.id, { capValue: parseFloat(e.target.value) || 0 })}
                              />
                            )}
                          </div>
                        </div>
                      </td>
                      <td colSpan={4} className={isOverCap ? 'cap-warning-text' : ''} style={{textAlign:'right', paddingRight:15, fontWeight:'bold', color:'var(--text-main)'}}>
                        {isOverCap && <span className="cap-warning-icon">⚠️</span>}
                        <span style={{fontSize: '11px', color: isOverCap ? '#f87171' : 'var(--text-muted)', marginRight: '10px', fontWeight: 'bold'}}>{fmtPct(sectionTotal, grandTotal)}</span>
                        Subtotal: {fmt(sectionTotal)}
                        {s.capType && (
                          <span className="cap-limit-note">
                            Límite: {s.capType === 'amount' ? `${project.currency} ${fmt(s.capValue || 0)}` : `${s.capValue || 0}% (${project.currency} ${fmt(capLimit || 0)})`}
                          </span>
                        )}
                      </td>
                    </tr>
                    {!s.collapsed && computedLines.filter(l => l.sectionId === s.id && !l.parentId && isLineVisible(l)).map(mainLine => renderLineTree(mainLine, 1, s.id))}
                    {!filterText && !s.collapsed && <tr onClick={() => addNewLine(s.id)} style={{cursor: 'pointer'}}><td colSpan={10} style={{padding: '8px', fontSize: '11px', color: 'var(--text-muted)'}}>+ Añadir línea a {s.name}</td></tr>}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="editor-sidebar" style={{flex:1, padding:10, overflowY:'auto', display: 'flex', flexDirection: 'column'}}>
          <div style={{flex: 1, overflowY: 'auto', marginBottom: 20, minHeight: '150px'}}>
            <div className="editor-panel-title" style={{fontWeight:'bold', fontSize:12, paddingBottom: 5, fontFamily: 'Aptos, sans-serif', marginBottom: 10}}>MEMORIA HISTÓRICA</div>
            {suggestions.length === 0 ? <p style={{fontSize: 11, textAlign:'center', color: 'var(--text-muted)', marginTop: 10}}>Selecciona una línea con descripción para buscar costos.</p> :
              suggestions.map((m, i) => (
                <div key={i} className="editor-mem-card" style={styles.memCard}>
                  <div style={{fontWeight:'bold', fontSize:11, fontFamily: 'Aptos, sans-serif', marginBottom: 4, color: 'var(--text-main)', lineHeight: '1.2'}}>{m.description}</div>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 4}}>
                      <div style={{fontSize: 10, color: 'var(--text-muted)', maxWidth:'55%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={m.category}>{m.category}</div>
                      <div style={{textAlign: 'right'}}><span style={styles.costHighlight}>{m.currency} {fmt(m.unit_cost)}</span><span style={{fontSize: 9, color: '#999', marginLeft: 3}}> / {m.unit}</span></div>
                  </div>
                  <div style={{display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8}}>
                      {m.year && <span style={styles.tagBadge}>📅 {m.year}</span>}{m.sector && <span style={styles.sectorBadge}>🏷 {m.sector}</span>}{m.donor && <span style={styles.donorBadge}>🏛 {m.donor}</span>}
                  </div>
                  <button onClick={() => applyMatch(m)} style={{...styles.applyBtn, width: '100%', padding: '4px', fontFamily: 'Aptos, sans-serif', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 5}}><span>Cargar</span><span style={{fontSize: 9, opacity: 0.8}}>↵</span></button>
                </div>
              ))}
          </div>
          <div style={{flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 10}}>
             <div className="editor-summary-title" style={{fontWeight:'bold', fontSize:12, marginBottom: 10, fontFamily: 'Aptos, sans-serif'}}>RESUMEN FINANCIERO</div>
             <div style={{maxHeight: '200px', overflowY: 'auto'}}>
               {sectionTotals.length === 0 ? <p style={{fontSize:11, color:'var(--text-muted)'}}>Vacío.</p> : sectionTotals.map((s, i) => (<div key={s.name + i} style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:5, borderBottom:'1px dashed rgba(255,255,255,0.08)', paddingBottom:2}}><span style={{fontWeight:'bold', color:'var(--text-main)', maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}} title={s.name}>{s.name}</span><span>{fmt(s.total)} <span style={{fontSize:9, color:'var(--text-muted)'}}>({fmtPct(s.total, grandTotal)})</span></span></div>))}
             </div>
             <div style={{marginTop:10, paddingTop:5, borderTop:'1px solid rgba(255,255,255,0.12)', fontWeight:'bold', fontSize:12, textAlign:'right', color: 'var(--text-main)'}}>TOTAL: {fmt(grandTotal)}</div>
          </div>
        </div>
      </div>
      
      {/* 👇 PANTALLA DE CARGA PARA LA IA */}
      {isAiLoading && (
        <div className="editor-overlay">
          <div className="editor-overlay-card">
            <div className="editor-overlay-emoji">🧠 🐱</div>
            <h3 className="editor-overlay-title" style={{fontFamily: 'Aptos, sans-serif'}}>La IA está leyendo el Excel...</h3>
            <p className="editor-overlay-sub">Esto puede tomar unos segundos mientras Ollama piensa.</p>
          </div>
        </div>
      )}

      <div style={styles.footerBar}><span style={{fontFamily: 'Aptos, sans-serif'}}>TOTAL PROYECTO: {project.currency} {fmt(grandTotal)}</span></div>
    </div>
  )
}

// --- APP PRINCIPAL ---
export default function App() {
  const [screen, setScreen] = useState('home');
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedData, setSelectedData] = useState<ProjectFile | null>(null);
  const [importProgress, setImportProgress] = useState<{ percent: number; message?: string } | null>(null);

  const load = async () => { try { const p = await window.budgetAPI.getAllProjects(); setProjects(Array.isArray(p) ? p : []); } catch(e) { console.error(e); } }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const unsubscribe = window.budgetAPI.onImportProgress?.((payload) => {
      if (!payload) return;
      setImportProgress(payload);
      if (payload.percent >= 100) {
        setTimeout(() => setImportProgress(null), 800);
      }
    });
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);

  const onSelect = (p: any) => {
    try {
        const data = JSON.parse(p.data_json);
        setSelectedData({ meta: { donor:p.donor, country:p.country, currency:p.currency, sector:p.sector, duration:p.duration, usdRate: p.usd_rate || 3.75, eurRate: p.eur_rate || 4.05 }, ...data });
        setScreen('editor');
    } catch(e) { console.error(e); }
  }

  // 👇 NUEVA FUNCIÓN: CARGAR FUENTE (APP O MEMORIA) AL EDITOR
  const handleLoadSourceToEditor = async (source: MemorySource) => {
    if (source.type === 'app' && source.originalData) {
      // Caso 1: Es un proyecto de la App
      onSelect(source.originalData);
    } else {
      // Caso 2: Es una importación (Excel/IA)
      try {
        // Pedimos al backend los items guardados
        const items = await window.budgetAPI.getMemoryItems(source.id);
        
        if (!items || items.length === 0) {
          alert("Esta fuente no tiene items guardados o no se pudieron leer.");
          return;
        }

        const sectionMap = new Map<string, BudgetSection>();
        const sectionOrder: string[] = [];
        const lines: BudgetLine[] = [];
        const lineIdByCode = new Map<string, string>();
        const lastMainBySection = new Map<string, string>();

        items.forEach((item: any) => {
          const sectionName = item.section || item.category || source.name || 'Importado';
          if (!sectionMap.has(sectionName)) {
            sectionMap.set(sectionName, { id: generateId(), name: sectionName, collapsed: false });
            sectionOrder.push(sectionName);
          }
          const sectionId = sectionMap.get(sectionName)!.id;
          const level = Number(item.level) || 2;
          const code = item.code || '';
          const parentCode = item.parent_code || '';
          let parentId: string | undefined;

          if (level >= 3) {
            parentId = parentCode && lineIdByCode.has(parentCode)
              ? lineIdByCode.get(parentCode)
              : lastMainBySection.get(sectionName);
          }

          const lineId = generateId();
          if (!parentId) {
            lastMainBySection.set(sectionName, lineId);
          }
          if (code) lineIdByCode.set(code, lineId);

          const quantity = Number.isFinite(item.quantity) ? Number(item.quantity) : 1;
          const frequency = Number.isFinite(item.frequency) ? Number(item.frequency) : 1;
          const unitCost = Number.isFinite(item.unit_cost) ? Number(item.unit_cost) : 0;

          lines.push({
            id: lineId,
            sectionId,
            parentId,
            category: item.category || sectionName,
            description: item.description,
            unit: item.unit || 'Und',
            quantity,
            frequency,
            unit_cost: unitCost,
            total: quantity * frequency * unitCost,
            selected: false,
            showNotes: false
          });
        });

        const inferredMeta = source.meta || {};
        const inferredName = inferredMeta.projectName || inferredMeta.donor || source.name || 'Importado';
        const projectData: ProjectFile = {
          meta: {
            donor: inferredName,
            country: inferredMeta.country || 'Perú',
            currency: inferredMeta.currency || 'PEN',
            sector: inferredMeta.sector || '',
            duration: inferredMeta.duration || 12,
            usdRate: inferredMeta.usdRate || 3.75,
            eurRate: inferredMeta.eurRate || 4.05
          },
          sections: sectionOrder.map(name => sectionMap.get(name)!),
          lines
        };

        setSelectedData(projectData);
        setScreen('editor');

      } catch (error) {
        console.error(error);
        alert("Error al cargar la fuente en el editor.");
      }
    }
  };

  const deleteProject = (id: string) => setProjects(prev => prev.filter(p => p.id !== id));
  const updateProject = (id: string, newData: any) => setProjects(prev => prev.map(p => p.id === id ? { ...p, ...newData } : p));

  return (
    <div style={{ fontFamily: 'Aptos, sans-serif' }}>
      {screen === 'home' && <HomeScreen onNavigate={setScreen} projects={projects} onSelectProject={onSelect} />}
      {screen === 'create-project' && <CreateProjectScreen onBack={() => setScreen('home')} onStart={(m:any) => { setSelectedData({meta:m, sections:[{id: generateId(), name: 'Personal'}], lines:[]}); setScreen('editor'); }} onImportToEditor={async (_m:any) => { const r = await window.budgetAPI.importSmartBudget(); if (r?.success) { alert('✅ Importado con IA a Memoria. Ve a Gestión de Memoria para abrirlo.'); setScreen('memory-manager'); } else { alert(r?.message || 'No se pudo importar con IA.'); } }} />}
      {screen === 'editor' && selectedData && <EditorScreen initialData={selectedData} onBack={() => { load(); setScreen('home'); }} />}
      
      {screen === 'memory-manager' && (
        <MemoryManagerScreen 
          onBack={() => setScreen('home')} 
          appProjects={projects} 
          onDeleteProject={deleteProject} 
          onUpdateProject={updateProject} 
          // Pasamos la nueva función aquí 👇
          onOpenEditor={handleLoadSourceToEditor} 
        />
      )}

      {importProgress && (
        <div className="memory-overlay">
          <div className="editor-overlay-card">
            <div className="editor-overlay-emoji">📊</div>
            <h3 className="editor-overlay-title" style={{fontFamily: 'Aptos, sans-serif'}}>
              {importProgress.message || 'Importando...'} {Math.min(100, Math.max(0, Math.round(importProgress.percent)))}%
            </h3>
            <div style={{width: 220, height: 6, background: 'rgba(255,255,255,0.15)', borderRadius: 6, marginTop: 8}}>
              <div style={{width: `${Math.min(100, Math.max(0, importProgress.percent))}%`, height: '100%', background: 'linear-gradient(90deg, #7C3AED, #22D3EE)', borderRadius: 6}} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: any = {
  homeContainer: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundImage: `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.7)), url(${bgImage})`, backgroundSize: 'cover' },
  dashboardCard: { display: 'flex', width: '900px', height: '550px', background: 'rgba(30,30,30,0.85)', backdropFilter: 'blur(10px)', borderRadius: 15, overflow: 'hidden' },
  dashSidebar: { flex: 1, padding: 40, borderRight: '1px solid rgba(255,255,255,0.1)' },
  dashMain: { flex: 1.5, padding: 40, overflowY: 'auto' },
  projectCard: { padding: 15, background: 'rgba(255,255,255,0.05)', borderRadius: 8, cursor: 'pointer', color:'#fff', marginBottom: 10 },
  title: { fontSize: '2.5rem', color: '#4ec9b0', margin: 0, fontFamily: 'Aptos, sans-serif' },
  formContainer: { width: 400, background: '#1e1e1e', padding: 30, borderRadius: 10, color: '#fff' },
  input: { width: '100%', padding: 8, marginBottom: 15, borderRadius: 4, border: '1px solid #333', background: '#2d2d2d', color: '#fff', fontFamily: 'Aptos, sans-serif' },
  topBar: { padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  headerEditableInput: { border: 'none', padding: '5px 10px', borderRadius: 6, width: '150px', fontWeight: 'bold', fontFamily: 'Aptos, sans-serif', outline: 'none' },
  headerSelect: { border: 'none', padding: '5px 10px', borderRadius: 6, outline: 'none', cursor: 'pointer' },
  closeBtn: { background: 'transparent', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' },
  footerBar: { background: 'rgba(2, 6, 23, 0.8)', color: 'var(--text-main)', borderTop: '1px solid var(--glass-border)', padding: '15px 30px', fontWeight: 'bold', display: 'flex', justifyContent: 'center' },
  excelTextarea: { width: '100%', border: 'none', resize: 'none', padding: '4px 8px', fontSize: '12px', outline: 'none', background: 'transparent', overflow: 'hidden', boxSizing: 'border-box', fontFamily: 'Aptos, sans-serif' },
  gridInput: { width: '100%', border: 'none', padding: '4px', fontSize: '12px', background: 'transparent', outline: 'none', boxSizing: 'border-box' },
  memCard: { padding: 10, borderRadius: 8, marginBottom: 10 },
  applyBtn: { background: 'var(--primary)', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 10, marginTop: 5 },
  sectionInput: { background: 'transparent', border: 'none', fontWeight: 'bold', color: 'var(--text-main)', width: '100%', outline: 'none' },
  addSubBtn: { background: 'var(--primary)', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: 6, fontSize: 10, cursor: 'pointer' },
  exchangeRateContainer: { display: 'flex', gap: 10, fontSize: 11, background: 'rgba(0,0,0,0.25)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--glass-border)' },
  rateInput: { width: '45px', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.4)', color: 'var(--text-main)', textAlign: 'center', outline: 'none', fontFamily: 'Aptos, sans-serif' },
  searchContainer: { borderRadius: 6, padding: '2px 8px', display: 'flex', alignItems: 'center' },
  searchInput: { background: 'transparent', border: 'none', color: 'var(--text-main)', fontSize: 12, outline: 'none', width: '120px', fontFamily: 'Aptos, sans-serif' },
  snapshotBadge: { fontSize: '10px', background: 'rgba(139, 92, 246, 0.15)', border: '1px solid rgba(139, 92, 246, 0.4)', borderRadius: '6px', padding: '2px 5px', cursor: 'pointer', marginRight: '5px', color: 'var(--text-main)' },
  iconBtn: { background: 'transparent', border: 'none', fontSize: '12px', cursor: 'pointer', marginRight: '5px', padding: 0 },
  narrativeInput: { width: '100%', border: 'none', fontSize: '10px', color: 'var(--text-muted)', background: 'transparent', fontStyle: 'italic', outline: 'none', marginTop: '2px', paddingLeft: '8px', borderTop: '1px dotted rgba(255,255,255,0.2)', fontFamily: 'Aptos, sans-serif' },
  
  // ESTILOS BADGES
  tagBadge: { 
    fontSize: '9px', padding: '1px 6px', borderRadius: '6px', 
    background: 'rgba(255,255,255,0.08)', color: 'var(--text-muted)', border: '1px solid var(--glass-border)',
    display: 'inline-block', fontWeight: 'bold'
  },
  sectorBadge: { 
    fontSize: '9px', padding: '1px 6px', borderRadius: '6px', 
    background: 'rgba(139, 92, 246, 0.15)', color: 'var(--text-main)', border: '1px solid rgba(139, 92, 246, 0.35)',
    display: 'inline-block', fontWeight: 'bold'
  },
  donorBadge: {
    fontSize: '9px', padding: '1px 6px', borderRadius: '6px', 
    background: 'rgba(14, 116, 144, 0.2)', color: 'var(--text-main)', border: '1px solid rgba(14, 116, 144, 0.35)',
    display: 'inline-block', fontWeight: 'bold'
  },
  costHighlight: {
    color: 'var(--primary)', fontWeight: 'bold', fontSize: '12px'
  }
};
