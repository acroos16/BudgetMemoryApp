import React, { useState, useEffect, useRef, useCallback } from 'react'
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
interface BudgetSection { id: string; name: string; collapsed?: boolean; }
interface ProjectFile { meta: ProjectMetadata; sections: BudgetSection[]; lines: BudgetLine[]; }
interface Snapshot { timestamp: string; data: string; }

// --- INTERFAZ MEMORIA ---
interface MemorySource {
  id: string; name: string; type: 'excel' | 'app'; date: string; tags: string[]; count: number; originalData?: any;
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
      // 👇 ESTA ES LA LÍNEA NUEVA QUE FALTA
      getMemoryItems: (sourceId: string) => Promise<any[]>
      deleteMemorySource: (sourceId: string) => Promise<{ success: boolean; message?: string }>
      renameMemorySource: (id: string, newName: string, type: string) => Promise<{ success: boolean; message?: string }>
    }
  }
}

const generateId = () => Math.random().toString(36).substr(2, 9);
const fmt = (num: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
const fmtPct = (part: number, total: number) => {
  if (!total || total === 0) return '0.0%';
  return ((part / total) * 100).toFixed(1) + '%';
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

    const writeLineRow = (line: BudgetLine, indent: boolean) => {
        const row = worksheet.getRow(currentRowIndex);
        row.getCell(1).value = line.category;
        row.getCell(2).value = indent ? `   ↳ ${line.description}` : line.description;
        row.getCell(3).value = line.notes || '';
        row.getCell(4).value = line.quantity; 
        row.getCell(5).value = line.unit;
        row.getCell(6).value = line.frequency; 
        row.getCell(7).value = line.unit_cost; 
        row.getCell(8).value = { formula: `D${currentRowIndex}*F${currentRowIndex}*G${currentRowIndex}`, result: line.total };

        if (indent) {
            row.font = { color: { argb: '555555' }, size: 9 };
            row.getCell(2).font = { italic: true, color: { argb: '555555' } };
        }
        row.getCell(7).numFmt = '#,##0.00';
        row.getCell(8).numFmt = '#,##0.00';
        row.getCell(8).font = { bold: true };
        currentRowIndex++;
    };

    sectionLines.forEach(mainLine => {
      writeLineRow(mainLine, false);
      lines.filter(l => l.parentId === mainLine.id).forEach(sub => writeLineRow(sub, true));
    });

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
const AutoExpandingTextarea = ({ value, onChange, isSubline = false, id, onKeyDown, onPaste, ...props }: any) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const adjustHeight = () => {
    const node = textareaRef.current;
    if (node) { node.style.height = '0px'; node.style.height = `${node.scrollHeight}px`; }
  };
  useEffect(() => { const timer = setTimeout(adjustHeight, 0); return () => clearTimeout(timer); }, [value]);
  return (
    <textarea
      id={id} ref={textareaRef} value={value} onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown} onPaste={onPaste} {...props} rows={1}
      style={{ ...styles.excelTextarea, paddingLeft: isSubline ? '25px' : '8px', paddingTop: '4px', paddingBottom: '4px' }}
    />
  );
};

// --- PANTALLA INICIO ---
const HomeScreen = ({ onNavigate, projects, onSelectProject }: any) => (
  <div style={styles.homeContainer}>
    <div style={styles.dashboardCard}>
      <div style={styles.dashSidebar}>
        <h1 style={styles.title}>BudgetCAT 🐱</h1>
        <button className="menu-btn primary" onClick={() => onNavigate('create-project')} style={{width: '100%', marginBottom: 15, fontFamily: 'Aptos, sans-serif'}}>📝 Nuevo Proyecto</button>
        <button className="menu-btn secondary" onClick={() => onNavigate('memory-manager')} style={{width: '100%', fontFamily: 'Aptos, sans-serif'}}>🧠 Gestionar Memoria</button>
      </div>
      <div style={styles.dashMain}>
        <h3 style={{color: '#4ec9b0', marginBottom: 20, fontFamily: 'Aptos, sans-serif'}}>📂 Proyectos Recientes</h3>
        <div style={styles.projectList}>
          {projects.length === 0 ? <p style={{color:'#666', textAlign:'center', marginTop:50, fontFamily: 'Aptos, sans-serif'}}>No hay proyectos guardados.</p> :
            projects.map((p: any) => (
              <div key={p.id} style={styles.projectCard} onClick={() => onSelectProject(p)}>
                <div style={{display:'flex', justifyContent:'space-between', fontFamily: 'Aptos, sans-serif'}}><span style={{fontWeight:'bold', color:'#eee'}}>{p.name}</span><span>ABRIR →</span></div>
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
    <div style={styles.homeContainer}>
      <div style={{...styles.dashboardCard, width: '1000px', height: '650px', flexDirection: 'column', position: 'relative'}}>
        <div style={{padding: '20px 30px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <h2 style={{margin:0, color: '#4ec9b0', fontFamily: 'Aptos, sans-serif'}}>🧠 Gestión de Memoria</h2>
            <button onClick={onBack} style={{...styles.closeBtn, padding: '5px 15px', fontSize: '12px'}}>← Volver</button>
        </div>
        <div style={{padding: '20px 30px', display: 'flex', gap: 15, borderBottom: '1px solid rgba(255,255,255,0.05)'}}>
            <button className="menu-btn primary" onClick={handleImport} style={{width: 'auto', fontSize: 13}}>📥 Importar Excel Nuevo</button>
            <input placeholder="🔍 Buscar..." value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{...styles.input, marginBottom: 0, width: '300px', background: 'rgba(0,0,0,0.2)'}} />
            {['all', 'excel', 'app'].map(t => <button key={t} onClick={() => setFilterType(t as any)} style={{background: filterType === t ? '#4ec9b0' : 'transparent', color: filterType === t ? '#000' : '#aaa', border: '1px solid #4ec9b0', borderRadius: 20, padding: '4px 15px', fontSize: 12, textTransform: 'capitalize'}}>{t === 'all' ? 'Todos' : t === 'excel' ? 'Importados' : 'Apps'}</button>)}
        </div>
        <div style={{flex: 1, padding: '20px 30px', overflowY: 'auto'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', color: '#eee', fontSize: '13px'}}>
                <thead><tr style={{borderBottom: '2px solid #4ec9b0', textAlign: 'left', color: '#4ec9b0'}}><th style={{padding:10}}>Nombre</th><th style={{padding:10}}>Tipo</th><th style={{padding:10}}>Items</th><th style={{padding:10}}>Fecha</th><th style={{padding:10}}>Acciones</th></tr></thead>
                <tbody>
                    {filteredSources.map(s => (
                        <tr key={s.id} style={{borderBottom: '1px solid rgba(255,255,255,0.1)'}}>
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
                                  style={{ background: 'transparent', border: '1px solid #4ec9b0', color: '#fff', width: '100%', padding: '4px', borderRadius: 4 }}
                                />
                              ) : (
                                <span style={{cursor: 'text'}} onDoubleClick={() => startEditingName(s)} title="Doble clic para renombrar">
                                  {s.name}
                                </span>
                              )}
                            </td>
                            <td style={{padding: 10}}><span style={{background: s.type === 'excel' ? 'rgba(76,175,80,0.2)' : 'rgba(33,150,243,0.2)', color: s.type === 'excel' ? '#81c784' : '#64b5f6', padding: '2px 8px', borderRadius: 4, fontSize: 10}}>{s.type.toUpperCase()}</span></td>
                            <td style={{padding: 10, color: '#aaa'}}>{s.count}</td>
                            <td style={{padding: 10, color: '#aaa'}}>{s.date}</td>
                            <td style={{padding: 10, textAlign: 'right'}}>
                                <button onClick={(e) => handleDownload(e, s)} style={{background: 'transparent', border: 'none', cursor: 'pointer', marginRight: 10, fontSize: 16}} title="Descargar">⬇️</button>
                                {/* 👇 AQUÍ ESTÁ EL CAMBIO IMPORTANTE: EL LÁPIZ AHORA EDITA */}
                                <button onClick={() => onOpenEditor(s)} style={{background: 'transparent', border: 'none', cursor: 'pointer', marginRight: 10, fontSize: 16}} title="Abrir en Editor">✏️</button>
                                <button onClick={(e) => handleDelete(e, s.id, s.type)} style={{background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16}} title="Eliminar">🗑️</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        {isAiLoading && <div style={{position: 'absolute', inset: 0, background: 'rgba(30,30,30,0.95)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: 15, zIndex: 999}}><div style={{fontSize: 50}}>🧠🐱</div><h3 style={{color:'#4ec9b0'}}>Leyendo...</h3></div>}
      </div>
    </div>
  )
}

const CreateProjectScreen = ({ onStart, onBack, onImportToEditor }: any) => {
  const [meta, setMeta] = useState<ProjectMetadata>({ donor: '', country: 'Perú', currency: 'PEN', sector: '', duration: 12, usdRate: 3.75, eurRate: 4.05 });
  return (
    <div style={styles.homeContainer}><div style={styles.formContainer}>
      <h2 style={{fontFamily: 'Aptos, sans-serif'}}>Configurar Proyecto</h2>
      <input style={styles.input} placeholder="Donante" onChange={e => setMeta({...meta, donor: e.target.value})} />
      <input style={styles.input} placeholder="Sector" onChange={e => setMeta({...meta, sector: e.target.value})} />
      <div style={{display:'flex', gap:10}}>
        <select style={styles.input} value={meta.currency} onChange={e => setMeta({...meta, currency: e.target.value})}>
            <option value="PEN">PEN</option><option value="USD">USD</option><option value="EUR">EUR</option>
        </select>
        <input type="number" style={styles.input} placeholder="Meses" onChange={e => setMeta({...meta, duration: parseInt(e.target.value)})} />
      </div>
      <button className="menu-btn primary" style={{fontFamily: 'Aptos, sans-serif'}} onClick={() => onStart(meta)}>Empezar</button>
      <button className="menu-btn secondary" style={{fontFamily: 'Aptos, sans-serif', marginTop:10}} onClick={() => onImportToEditor(meta)} title="Importación asistida con IA">Importar Excel (IA)</button>
      <button className="menu-btn danger" style={{fontFamily: 'Aptos, sans-serif', marginTop:10}} onClick={onBack}>Atrás</button>
    </div></div>
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
    const data = JSON.stringify({ sections, lines });
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
  const isLineVisible = (l: BudgetLine) => {
    if (!filterText) return true;
    const lower = filterText.toLowerCase();
    const selfMatch = l.description.toLowerCase().includes(lower) || l.category.toLowerCase().includes(lower);
    if (selfMatch) return true;
    if (!l.parentId) return lines.some(child => child.parentId === l.id && (child.description.toLowerCase().includes(lower) || child.category.toLowerCase().includes(lower)));
    if (l.parentId) { const parent = lines.find(p => p.id === l.parentId); return parent ? (parent.description.toLowerCase().includes(lower) || parent.category.toLowerCase().includes(lower)) : false; }
    return false;
  };

  const recalculateLine = (allLines: BudgetLine[], lineId: string): BudgetLine[] => {
    const children = allLines.filter(l => l.parentId === lineId);
    if (children.length > 0) {
      const sumChildren = children.reduce((acc, curr) => acc + curr.total, 0);
      return allLines.map(l => l.id === lineId ? { ...l, unit_cost: sumChildren, total: l.quantity * l.frequency * sumChildren } : l);
    }
    return allLines;
  };

  const updateLine = (id: string, field: keyof BudgetLine, value: any) => {
    let nextLines = lines.map(l => {
      if (l.id === id) {
        const u = { ...l, [field]: value };
        if (['quantity', 'frequency', 'unit_cost'].includes(field)) u.total = u.quantity * u.frequency * u.unit_cost;
        if (field === 'description' || (field === 'category' && !u.description)) triggerSearch(String(value));
        return u;
      }
      return l;
    });
    const editedLine = nextLines.find(l => l.id === id);
    if (editedLine?.parentId) { nextLines = recalculateLine(nextLines, editedLine.parentId); }
    setLines(nextLines);
  }

  const toggleNotes = (id: string) => setLines(prev => prev.map(l => l.id === id ? { ...l, showNotes: !l.showNotes } : l));
  const applyMatch = (m: CostItem) => { if (!activeRowId) return; updateLine(activeRowId, 'description', m.description); updateLine(activeRowId, 'unit', m.unit); updateLine(activeRowId, 'category', m.category); updateLine(activeRowId, 'unit_cost', m.unit_cost); }
  
  const addNewLine = (sId: string, parentId?: string) => {
    const id = generateId();
    setLines(prev => [...prev, { id, sectionId: sId, parentId, category: '', description: '', quantity: 1, frequency: 1, unit: 'Unid', unit_cost: 0, total: 0, selected: false }]);
    setActiveRowId(id);
    setFocusRequest({ id, field: 'description' });
  }

  const deleteLine = (lineId: string) => {
    setLines(prev => {
        const line = prev.find(l => l.id === lineId);
        if(!line) return prev;
        if(!line.parentId) return prev.filter(l => l.id !== lineId && l.parentId !== lineId);
        return prev.filter(l => l.id !== lineId);
    });
    setActiveRowId(null);
  };

  const duplicateLine = (lineId: string) => {
    setLines(prev => {
        const original = prev.find(l => l.id === lineId);
        if(!original) return prev;
        const newId = generateId();
        const clone = { ...original, id: newId };
        let newLines = [...prev];
        const idx = newLines.findIndex(l => l.id === lineId);
        newLines.splice(idx + 1, 0, clone);
        if(!original.parentId) {
            const children = prev.filter(l => l.parentId === lineId);
            children.forEach((child, i) => newLines.splice(idx + 2 + i, 0, { ...child, id: generateId(), parentId: newId }));
        }
        return newLines;
    });
  };

  const toggleSection = (sectionId: string) => setSections(prev => prev.map(s => s.id === sectionId ? { ...s, collapsed: !s.collapsed } : s));
  const handleKeyDown = (e: React.KeyboardEvent, line: BudgetLine, field: string) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNewLine(line.sectionId, line.parentId); return; }
    if (e.key === 'Delete' && (e.ctrlKey || !['description', 'category', 'unit'].includes(field))) { if (e.ctrlKey) { e.preventDefault(); deleteLine(line.id); return; } }
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); duplicateLine(line.id); return; }
    const isText = ['description', 'category', 'unit'].includes(field);
    const target = e.target as HTMLTextAreaElement | HTMLInputElement;
    if (e.key === 'ArrowUp') { if (isText && target.selectionStart && target.selectionStart > 0) return; e.preventDefault(); moveFocusVertical(line, field, -1); }
    if (e.key === 'ArrowDown') { if (isText && target.selectionStart !== null && target.value && target.selectionStart < target.value.length) return; e.preventDefault(); moveFocusVertical(line, field, 1); }
    if (e.key === 'ArrowRight' || e.key === 'Tab') { if (e.key === 'ArrowRight' && isText && target.selectionStart !== null && target.value && target.selectionStart < target.value.length) return; e.preventDefault(); moveFocusHorizontal(line, field, 1); }
    if (e.key === 'ArrowLeft') { if (isText && target.selectionStart && target.selectionStart > 0) return; e.preventDefault(); moveFocusHorizontal(line, field, -1); }
  };
  
  const moveFocusVertical = (currentLine: BudgetLine, field: string, direction: number) => {
    const flatVisualList = sections.flatMap(s => s.collapsed ? [] : lines.filter(l => l.sectionId === s.id && isLineVisible(l)));
    const idx = flatVisualList.findIndex(l => l.id === currentLine.id);
    const target = flatVisualList[idx + direction];
    if (target) document.getElementById(`cell-${target.id}-${field}`)?.focus();
  }
  const moveFocusHorizontal = (currentLine: BudgetLine, currentField: string, direction: number) => {
    const colIdx = columns.indexOf(currentField);
    if (colIdx === -1) return;
    const newColIdx = colIdx + direction;
    if (newColIdx >= 0 && newColIdx < columns.length) { document.getElementById(`cell-${currentLine.id}-${columns[newColIdx]}`)?.focus(); } else {
        const flatVisualList = sections.flatMap(s => s.collapsed ? [] : lines.filter(l => l.sectionId === s.id && isLineVisible(l)));
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
      const childrenIds = prevLines.filter(l => l.parentId === draggedLine.id).map(l => l.id);
      return prevLines.map(l => { if (l.id === draggedLineId) return { ...l, sectionId, parentId: undefined }; if (childrenIds.includes(l.id)) return { ...l, sectionId }; return l; });
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
          if (['quantity', 'frequency', 'unit_cost'].includes(field)) { val = parseFloat(val.replace(/,/g, '').replace(/ /g, '')) || 0; }
          const u = { ...currentLine, [field]: val };
          if (['quantity', 'frequency', 'unit_cost'].includes(field)) { u.total = u.quantity * u.frequency * u.unit_cost; }
          newLines[targetIndex] = u;
        }
      });
      return newLines;
    });
  };

  // --- FUNCIÓN NUEVA PARA MANEJAR LA IMPORTACIÓN CON IA ---
  const handleSmartImport = async () => {
    setIsAiLoading(true);
    try {
      const result = await window.budgetAPI.importSmartBudget();
      
      if (result.success && result.data && result.data.length > 0) {
        // 1. Crear una nueva sección para lo importado
        const newSectionId = generateId();
        const newSection = { id: newSectionId, name: '✨ Importado con IA', collapsed: false };
        
        // 2. Mapear los datos de la IA a BudgetLine
        const newLines: BudgetLine[] = result.data.map((item: any) => ({
          id: generateId(),
          sectionId: newSectionId,
          parentId: undefined,
          category: item.category || 'Otros', // Categoría que adivinó la IA
          description: item.description || 'Ítem importado',
          unit: item.unit || 'Und',
          quantity: Number(item.quantity) || 1,
          frequency: 1, // Por defecto
          unit_cost: Number(item.unit_cost) || 0,
          total: (Number(item.quantity) || 1) * (Number(item.unit_cost) || 0),
          selected: false,
          showNotes: false
        }));
  
        // 3. Actualizar el estado
        setSections(prev => [...prev, newSection]);
        setLines(prev => [...prev, ...newLines]);
        
        alert(`✅ Se importaron ${newLines.length} líneas exitosamente.`);
      } else {
        if (result.message) console.log(result.message);
      }
    } catch (error) {
      console.error(error);
      alert("❌ Error al procesar con IA. Asegúrate de que Ollama esté corriendo.");
    } finally {
      setIsAiLoading(false);
    }
  };

  const grandTotal = lines.reduce((acc, curr) => acc + (curr.parentId ? 0 : curr.total), 0);
  const sectionTotals = sections.map(s => ({ name: s.name, total: lines.filter(l => l.sectionId === s.id && !l.parentId).reduce((sum, l) => sum + l.total, 0) }));

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden', fontFamily: 'Aptos, sans-serif' }}>
      <div style={styles.topBar}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <span style={{fontFamily: 'Aptos, sans-serif'}}>🐱 <b>BudgetCAT</b></span>
          <input style={styles.headerEditableInput} value={project.donor} onChange={e => setProject({...project, donor: e.target.value})} />
          <div style={styles.exchangeRateContainer}>
             <span>1 USD = S/</span> <input type="number" step="0.01" style={styles.rateInput} value={project.usdRate} onChange={e => setProject({...project, usdRate: parseFloat(e.target.value)})} />
             <span>1 EUR = S/</span> <input type="number" step="0.01" style={styles.rateInput} value={project.eurRate} onChange={e => setProject({...project, eurRate: parseFloat(e.target.value)})} />
          </div>
          <select style={styles.headerSelect} value={project.currency} onChange={e => setProject({...project, currency: e.target.value})}>
            <option value="PEN">PEN</option><option value="USD">USD</option><option value="EUR">EUR</option>
          </select>
        </div>
        <button onClick={onBack} style={{...styles.closeBtn, fontFamily: 'Aptos, sans-serif'}}>Cerrar</button>
      </div>
      <div className="ribbon">
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif'}} onClick={() => { const id = generateId(); setSections([...sections, { id, name: 'Nueva Sección' }]); addNewLine(id); }}>📂 + Sección</button>
        {/* 👇 BOTÓN NUEVO DE IA */}
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif', color: '#6a1b9a', background: '#f3e5f5', border: '1px solid #ce93d8'}} onClick={handleSmartImport}>✨ Importar IA</button>
        
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif'}} onClick={async () => { await window.budgetAPI.saveProjectInternal({ name: `${project.donor}`, ...project, data_json: JSON.stringify({ sections, lines }) }); alert("💾 Guardado"); }}>💾 Guardar</button>
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif', background: '#ff9800'}} onClick={takeSnapshot}>📸 Foto</button>
        <div style={{display:'flex', alignItems:'center', marginLeft: 10}}>
             {snapshots.map((s, i) => <span key={i} onClick={() => restoreSnapshot(s)} style={styles.snapshotBadge}>v{snapshots.length - i}</span>)}
        </div>
        <button className="ribbon-btn" style={{fontFamily: 'Aptos, sans-serif', marginLeft: 'auto', marginRight: 10}} onClick={() => generateBudgetExcel(project, sections, lines)}>📤 Exportar</button>
        <div style={styles.searchContainer}><span style={{fontSize: 12, marginRight: 5, color: '#333'}}>🔍</span><input style={styles.searchInput} placeholder="Filtrar..." value={filterText} onChange={(e) => setFilterText(e.target.value)} /></div>
      </div>

      <div style={{flex:1, display:'flex', overflow:'hidden'}}>
        <div style={{flex:3, overflow:'auto'}}>
          <table style={{width: '100%', tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'Aptos, sans-serif', border: '1px solid #ddd'}}>
            <thead style={{position: 'sticky', top: 0, zIndex: 10, background: '#fff'}}>
              <tr style={{fontSize: '12px', textAlign: 'left'}}>
                <th style={{width: '35px', padding: '10px', borderBottom: '1px solid #ddd'}}>✔</th>
                <th style={{width: '90px', borderBottom: '1px solid #ddd'}}>Cat.</th>
                <th style={{width: 'auto', minWidth: '400px', borderBottom: '1px solid #ddd'}}>Descripción</th>
                <th style={{width: '60px', borderBottom: '1px solid #ddd'}}>Cant</th>
                <th style={{width: '60px', borderBottom: '1px solid #ddd'}}>Unid</th>
                <th style={{width: '45px', borderBottom: '1px solid #ddd'}}>Freq</th>
                <th style={{width: '90px', borderBottom: '1px solid #ddd'}}>C*U</th>
                <th style={{width: '115px', borderBottom: '1px solid #ddd'}}>Total</th>
                <th style={{width: '45px', borderBottom: '1px solid #ddd', fontSize: '11px', color: '#666'}}>%</th>
                <th style={{width: '80px', borderBottom: '1px solid #ddd'}}>+Sub</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(s => {
                const sectionTotal = lines.filter(l => l.sectionId === s.id && !l.parentId).reduce((sum, l) => sum + l.total, 0);
                return (
                  <React.Fragment key={s.id}>
                    <tr style={{background: '#f8f9fa', position: 'sticky', top: '37px', zIndex: 9}} onDragOver={handleDragOver} onDrop={(e) => handleDropOnSection(e, s.id)}>
                      <td style={{padding:'5px', borderBottom: '1px solid #ddd', textAlign:'center'}}><button onClick={() => toggleSection(s.id)} style={{border:'none', background:'transparent', cursor:'pointer', fontWeight:'bold', fontSize:14, color:'#555'}}>{s.collapsed ? '▶' : '▼'}</button></td>
                      <td colSpan={5} style={{padding:'5px', borderBottom: '1px solid #ddd'}}><input style={{...styles.sectionInput, fontFamily: 'Aptos, sans-serif'}} value={s.name} onChange={(e) => setSections(sections.map(sec => sec.id === s.id ? {...sec, name: e.target.value} : sec))} /></td>
                      <td colSpan={4} style={{textAlign:'right', paddingRight:15, fontWeight:'bold', color:'#006673', borderBottom: '1px solid #ddd'}}><span style={{fontSize: '11px', color: '#666', marginRight: '10px', fontWeight: 'bold'}}>{fmtPct(sectionTotal, grandTotal)}</span>Subtotal: {fmt(sectionTotal)}</td>
                    </tr>
                    {!s.collapsed && lines.filter(l => l.sectionId === s.id && !l.parentId && isLineVisible(l)).map(mainLine => {
                      const hasChildren = lines.some(sub => sub.parentId === mainLine.id);
                      return (
                        <React.Fragment key={mainLine.id}>
                          <tr style={{background: activeRowId === mainLine.id ? '#e8f4f4' : '#fff', cursor: 'pointer'}} onClick={() => setActiveRowId(mainLine.id)} draggable onDragStart={(e) => handleDragStart(e, mainLine.id)} onDragOver={handleDragOver} onDrop={(e) => handleDropOnSection(e, s.id)}>
                            <td style={{textAlign:'center', borderBottom: '1px solid #eee', cursor: 'grab'}}><div style={{display:'flex', alignItems:'center', justifyContent:'center'}}><span style={{color:'#ccc', marginRight:4, fontSize:10}}>⠿</span><input type="checkbox" checked={mainLine.selected} onChange={() => setLines(lines.map(x => x.id === mainLine.id ? {...x, selected: !x.selected} : x))} /></div></td>
                            <td style={{borderBottom: '1px solid #eee'}}><AutoExpandingTextarea id={`cell-${mainLine.id}-category`} onPaste={(e: any) => handlePaste(e, mainLine.id, 'category')} onFocus={() => handleCellFocus(mainLine)} onKeyDown={(e:any) => handleKeyDown(e, mainLine, 'category')} value={mainLine.category} onChange={(v:any) => updateLine(mainLine.id, 'category', v)} /></td>
                            <td style={{borderBottom: '1px solid #eee'}}>
                                <div style={{display: 'flex', flexDirection: 'column'}}>
                                    <AutoExpandingTextarea id={`cell-${mainLine.id}-description`} onPaste={(e: any) => handlePaste(e, mainLine.id, 'description')} onFocus={() => handleCellFocus(mainLine)} onKeyDown={(e:any) => handleKeyDown(e, mainLine, 'description')} value={mainLine.description} onChange={(v:any) => updateLine(mainLine.id, 'description', v)} />
                                    {mainLine.showNotes && (<input placeholder="📝 Justificación técnica..." value={mainLine.notes || ''} onChange={(e) => updateLine(mainLine.id, 'notes', e.target.value)} style={styles.narrativeInput} autoFocus />)}
                                </div>
                            </td>
                            <td style={{borderBottom: '1px solid #eee'}}><input id={`cell-${mainLine.id}-quantity`} onPaste={(e: any) => handlePaste(e, mainLine.id, 'quantity')} onFocus={() => handleCellFocus(mainLine)} onKeyDown={(e) => handleKeyDown(e, mainLine, 'quantity')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} type="number" value={mainLine.quantity} onChange={e => updateLine(mainLine.id, 'quantity', parseFloat(e.target.value))} /></td>
                            <td style={{borderBottom: '1px solid #eee'}}><AutoExpandingTextarea id={`cell-${mainLine.id}-unit`} onPaste={(e: any) => handlePaste(e, mainLine.id, 'unit')} onFocus={() => handleCellFocus(mainLine)} onKeyDown={(e:any) => handleKeyDown(e, mainLine, 'unit')} value={mainLine.unit} onChange={(v:any) => updateLine(mainLine.id, 'unit', v)} /></td>
                            <td style={{borderBottom: '1px solid #eee'}}><input id={`cell-${mainLine.id}-frequency`} onPaste={(e: any) => handlePaste(e, mainLine.id, 'frequency')} onFocus={() => handleCellFocus(mainLine)} onKeyDown={(e) => handleKeyDown(e, mainLine, 'frequency')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} type="number" value={mainLine.frequency} onChange={e => updateLine(mainLine.id, 'frequency', parseFloat(e.target.value))} /></td>
                            <td style={{borderBottom: '1px solid #eee', background: hasChildren ? 'rgba(0,0,0,0.03)' : 'transparent'}}><input id={`cell-${mainLine.id}-unit_cost`} onPaste={(e: any) => handlePaste(e, mainLine.id, 'unit_cost')} onFocus={() => handleCellFocus(mainLine)} onKeyDown={(e) => handleKeyDown(e, mainLine, 'unit_cost')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif', fontWeight: hasChildren ? 'bold' : 'normal'}} type="number" value={mainLine.unit_cost} disabled={hasChildren} onChange={e => updateLine(mainLine.id, 'unit_cost', parseFloat(e.target.value))} /></td>
                            <td style={{textAlign:'right', fontWeight:'bold', paddingRight:10, borderBottom: '1px solid #eee'}}>{fmt(mainLine.total)}</td>
                            <td style={{borderBottom: '1px solid #eee'}}></td>
                            <td style={{textAlign:'center', borderBottom: '1px solid #eee'}}><button onClick={(e) => { e.stopPropagation(); toggleNotes(mainLine.id); }} style={{...styles.iconBtn, color: mainLine.notes ? '#4ec9b0' : '#aaa'}}>📝</button><button onClick={(e) => { e.stopPropagation(); addNewLine(s.id, mainLine.id); }} style={styles.addSubBtn}>+ Sub</button></td>
                          </tr>
                          {lines.filter(sub => sub.parentId === mainLine.id && isLineVisible(sub)).map(subLine => (
                            <tr key={subLine.id} style={{background: activeRowId === subLine.id ? '#e8f4f4' : '#fafafa', cursor: 'pointer'}} onClick={() => setActiveRowId(subLine.id)} draggable onDragStart={(e) => handleDragStart(e, subLine.id)} onDragOver={handleDragOver} onDrop={(e) => handleDropOnSection(e, s.id)}>
                              <td style={{borderBottom: '1px solid #eee', textAlign:'center', cursor: 'grab'}}><span style={{color:'#ccc', fontSize:10}}>⠿</span></td>
                              <td style={{borderLeft: '3px solid #4ec9b0', borderBottom: '1px solid #eee'}}><AutoExpandingTextarea id={`cell-${subLine.id}-category`} onPaste={(e: any) => handlePaste(e, subLine.id, 'category')} onFocus={() => handleCellFocus(subLine)} onKeyDown={(e:any) => handleKeyDown(e, subLine, 'category')} value={subLine.category} onChange={(v:any) => updateLine(subLine.id, 'category', v)} /></td>
                              <td style={{borderBottom: '1px solid #eee'}}>
                                  <div style={{display: 'flex', flexDirection: 'column'}}>
                                      <AutoExpandingTextarea id={`cell-${subLine.id}-description`} onPaste={(e: any) => handlePaste(e, subLine.id, 'description')} onFocus={() => handleCellFocus(subLine)} onKeyDown={(e:any) => handleKeyDown(e, subLine, 'description')} value={subLine.description} onChange={(v:any) => updateLine(subLine.id, 'description', v)} isSubline />
                                      {subLine.showNotes && (<input placeholder="📝 Justificación técnica..." value={subLine.notes || ''} onChange={(e) => updateLine(subLine.id, 'notes', e.target.value)} style={{...styles.narrativeInput, paddingLeft: '25px'}} autoFocus />)}
                                  </div>
                              </td>
                              <td style={{borderBottom: '1px solid #eee'}}><input id={`cell-${subLine.id}-quantity`} onPaste={(e: any) => handlePaste(e, subLine.id, 'quantity')} onFocus={() => handleCellFocus(subLine)} onKeyDown={(e) => handleKeyDown(e, subLine, 'quantity')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} type="number" value={subLine.quantity} onChange={e => updateLine(subLine.id, 'quantity', parseFloat(e.target.value))} /></td>
                              <td style={{borderBottom: '1px solid #eee'}}><AutoExpandingTextarea id={`cell-${subLine.id}-unit`} onPaste={(e: any) => handlePaste(e, subLine.id, 'unit')} onFocus={() => handleCellFocus(subLine)} onKeyDown={(e:any) => handleKeyDown(e, subLine, 'unit')} value={subLine.unit} onChange={(v:any) => updateLine(subLine.id, 'unit', v)} /></td>
                              <td style={{borderBottom: '1px solid #eee'}}><input id={`cell-${subLine.id}-frequency`} onPaste={(e: any) => handlePaste(e, subLine.id, 'frequency')} onFocus={() => handleCellFocus(subLine)} onKeyDown={(e) => handleKeyDown(e, subLine, 'frequency')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} type="number" value={subLine.frequency} onChange={e => updateLine(subLine.id, 'frequency', parseFloat(e.target.value))} /></td>
                              <td style={{borderBottom: '1px solid #eee'}}><input id={`cell-${subLine.id}-unit_cost`} onPaste={(e: any) => handlePaste(e, subLine.id, 'unit_cost')} onFocus={() => handleCellFocus(subLine)} onKeyDown={(e) => handleKeyDown(e, subLine, 'unit_cost')} style={{...styles.gridInput, fontFamily: 'Aptos, sans-serif'}} type="number" value={subLine.unit_cost} onChange={e => updateLine(subLine.id, 'unit_cost', parseFloat(e.target.value))} /></td>
                              <td style={{textAlign:'right', fontSize:11, paddingRight:10, borderBottom: '1px solid #eee'}}>{fmt(subLine.total)}</td>
                              <td style={{borderBottom: '1px solid #eee'}}></td>
                              <td style={{borderBottom: '1px solid #eee', textAlign: 'center'}}><button onClick={(e) => { e.stopPropagation(); toggleNotes(subLine.id); }} style={{...styles.iconBtn, color: subLine.notes ? '#4ec9b0' : '#aaa'}}>📝</button></td>
                            </tr>
                          ))}
                        </React.Fragment>
                      );
                    })}
                    {!filterText && !s.collapsed && <tr onClick={() => addNewLine(s.id)} style={{cursor: 'pointer'}}><td colSpan={10} style={{padding: '8px', fontSize: '11px', color: '#006673'}}>+ Añadir línea a {s.name}</td></tr>}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{flex:1, background:'#f9f9f9', borderLeft:'1px solid #ddd', padding:10, overflowY:'auto', display: 'flex', flexDirection: 'column'}}>
          <div style={{flex: 1, overflowY: 'auto', marginBottom: 20, minHeight: '150px'}}>
            <div style={{fontWeight:'bold', fontSize:12, color: '#666', borderBottom: '1px solid #ccc', paddingBottom: 5, fontFamily: 'Aptos, sans-serif', marginBottom: 10}}>MEMORIA HISTÓRICA</div>
            {suggestions.length === 0 ? <p style={{fontSize: 11, textAlign:'center', color: '#999', marginTop: 10}}>Selecciona una línea con descripción para buscar costos.</p> :
              suggestions.map((m, i) => (
                <div key={i} style={styles.memCard}>
                  <div style={{fontWeight:'bold', fontSize:11, fontFamily: 'Aptos, sans-serif', marginBottom: 4, color: '#2c3e50', lineHeight: '1.2'}}>{m.description}</div>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, borderBottom: '1px solid #f0f0f0', paddingBottom: 4}}>
                      <div style={{fontSize: 10, color: '#7f8c8d', maxWidth:'55%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={m.category}>{m.category}</div>
                      <div style={{textAlign: 'right'}}><span style={styles.costHighlight}>{m.currency} {fmt(m.unit_cost)}</span><span style={{fontSize: 9, color: '#999', marginLeft: 3}}> / {m.unit}</span></div>
                  </div>
                  <div style={{display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8}}>
                      {m.year && <span style={styles.tagBadge}>📅 {m.year}</span>}{m.sector && <span style={styles.sectorBadge}>🏷 {m.sector}</span>}{m.donor && <span style={styles.donorBadge}>🏛 {m.donor}</span>}
                  </div>
                  <button onClick={() => applyMatch(m)} style={{...styles.applyBtn, width: '100%', padding: '4px', fontFamily: 'Aptos, sans-serif', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 5}}><span>Cargar</span><span style={{fontSize: 9, opacity: 0.8}}>↵</span></button>
                </div>
              ))}
          </div>
          <div style={{flexShrink: 0, borderTop: '2px solid #ddd', paddingTop: 10, background: '#f9f9f9'}}>
             <div style={{fontWeight:'bold', fontSize:12, color: '#006673', marginBottom: 10, fontFamily: 'Aptos, sans-serif'}}>RESUMEN FINANCIERO</div>
             <div style={{maxHeight: '200px', overflowY: 'auto'}}>
               {sectionTotals.length === 0 ? <p style={{fontSize:11, color:'#999'}}>Vacío.</p> : sectionTotals.map((s, i) => (<div key={s.name + i} style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:5, borderBottom:'1px dashed #eee', paddingBottom:2}}><span style={{fontWeight:'bold', color:'#333', maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}} title={s.name}>{s.name}</span><span>{fmt(s.total)} <span style={{fontSize:9, color:'#888'}}>({fmtPct(s.total, grandTotal)})</span></span></div>))}
             </div>
             <div style={{marginTop:10, paddingTop:5, borderTop:'1px solid #ccc', fontWeight:'bold', fontSize:12, textAlign:'right', color: '#006673'}}>TOTAL: {fmt(grandTotal)}</div>
          </div>
        </div>
      </div>
      
      {/* 👇 PANTALLA DE CARGA PARA LA IA */}
      {isAiLoading && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, 
          background: 'rgba(255,255,255,0.8)', zIndex: 9999, 
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{fontSize: '40px', marginBottom: '20px'}}>🧠 🐱</div>
          <h3 style={{color: '#006673', fontFamily: 'Aptos, sans-serif'}}>La IA está leyendo el Excel...</h3>
          <p style={{color: '#666'}}>Esto puede tomar unos segundos mientras Ollama piensa.</p>
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

  const load = async () => { try { const p = await window.budgetAPI.getAllProjects(); setProjects(Array.isArray(p) ? p : []); } catch(e) { console.error(e); } }
  useEffect(() => { load(); }, []);

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

        // Convertimos las filas de la BD a líneas del Editor
        const newSectionId = generateId();
        const convertedLines: BudgetLine[] = items.map((item: any) => ({
          id: generateId(),
          sectionId: newSectionId,
          category: item.category || 'General',
          description: item.description,
          unit: item.unit || 'Und',
          quantity: 1, 
          frequency: 1,
          unit_cost: item.unit_cost,
          total: item.unit_cost,
          selected: false,
          showNotes: false
        }));

        const projectData: ProjectFile = {
          meta: { donor: 'Importado', country: 'Perú', currency: 'PEN', sector: '', duration: 12, usdRate: 3.75, eurRate: 4.05 },
          sections: [{ id: newSectionId, name: source.name, collapsed: false }],
          lines: convertedLines
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
    <div style={{fontFamily: 'Aptos, sans-serif'}}>
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
  topBar: { background: '#006673', color: '#fff', padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  headerEditableInput: { background: 'rgba(0,0,0,0.2)', border: 'none', color: '#fff', padding: '5px 10px', borderRadius: 4, width: '150px', fontWeight: 'bold', fontFamily: 'Aptos, sans-serif', outline: 'none' },
  headerSelect: { background: 'rgba(0,0,0,0.2)', border: 'none', color: '#fff', padding: '5px', borderRadius: 4, outline: 'none', cursor: 'pointer' },
  closeBtn: { background: 'transparent', border: '1px solid #fff', color: '#fff', padding: '2px 8px', borderRadius: 4, cursor: 'pointer' },
  footerBar: { background: '#006673', color: '#fff', padding: '15px 30px', fontWeight: 'bold', display: 'flex', justifyContent: 'center' },
  excelTextarea: { width: '100%', border: 'none', resize: 'none', padding: '4px 8px', fontSize: '12px', outline: 'none', background: 'transparent', overflow: 'hidden', boxSizing: 'border-box', fontFamily: 'Aptos, sans-serif' },
  gridInput: { width: '100%', border: 'none', padding: '4px', fontSize: '12px', background: 'transparent', outline: 'none', boxSizing: 'border-box' },
  memCard: { background: '#fff', padding: 10, borderRadius: 5, marginBottom: 10, border: '1px solid #ddd', color: '#333' },
  applyBtn: { background: '#006673', color: '#fff', border: 'none', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 10, marginTop: 5 },
  sectionInput: { background: 'transparent', border: 'none', fontWeight: 'bold', color: '#006673', width: '100%', outline: 'none' },
  addSubBtn: { background: '#4ec9b0', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: 4, fontSize: 10, cursor: 'pointer' },
  exchangeRateContainer: { display: 'flex', gap: 10, fontSize: 11, background: 'rgba(0,0,0,0.1)', padding: '4px 10px', borderRadius: 4 },
  rateInput: { width: '45px', background: 'transparent', border: 'none', borderBottom: '1px solid #fff', color: '#fff', textAlign: 'center', outline: 'none', fontFamily: 'Aptos, sans-serif' },
  searchContainer: { background: '#fff', borderRadius: 4, padding: '2px 8px', display: 'flex', alignItems: 'center', border: '1px solid #ccc' },
  searchInput: { background: 'transparent', border: 'none', color: '#333', fontSize: 12, outline: 'none', width: '120px', fontFamily: 'Aptos, sans-serif' },
  snapshotBadge: { fontSize: '10px', background: '#e8f4f4', border: '1px solid #4ec9b0', borderRadius: '4px', padding: '2px 5px', cursor: 'pointer', marginRight: '5px', color: '#006673' },
  iconBtn: { background: 'transparent', border: 'none', fontSize: '12px', cursor: 'pointer', marginRight: '5px', padding: 0 },
  narrativeInput: { width: '100%', border: 'none', fontSize: '10px', color: '#555', background: 'transparent', fontStyle: 'italic', outline: 'none', marginTop: '2px', paddingLeft: '8px', borderTop: '1px dotted #eee', fontFamily: 'Aptos, sans-serif' },
  
  // ESTILOS BADGES
  tagBadge: { 
    fontSize: '9px', padding: '1px 5px', borderRadius: '4px', 
    background: '#f5f5f5', color: '#666', border: '1px solid #ddd',
    display: 'inline-block', fontWeight: 'bold'
  },
  sectorBadge: { 
    fontSize: '9px', padding: '1px 5px', borderRadius: '4px', 
    background: '#f3e5f5', color: '#7b1fa2', border: '1px solid #e1bee7',
    display: 'inline-block', fontWeight: 'bold'
  },
  donorBadge: {
    fontSize: '9px', padding: '1px 5px', borderRadius: '4px', 
    background: '#e3f2fd', color: '#1565c0', border: '1px solid #bbdefb',
    display: 'inline-block', fontWeight: 'bold'
  },
  costHighlight: {
    color: '#006673', fontWeight: 'bold', fontSize: '12px'
  }
}
