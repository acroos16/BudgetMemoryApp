import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const budgetAPI = {
  // --- 1. CONEXIONES SQL (LO NUEVO) ---
  
  // React: "searchCost" -> Backend: "search-cost" (Búsqueda inteligente)
  searchCost: (query: string) => ipcRenderer.invoke('search-cost', query),

  // React: "saveProjectInternal" -> Backend: "save-project" (Guardado SQL)
  // IMPORTANTE: Redirigimos la llamada interna al canal correcto de la DB
  saveProjectInternal: (data: any) => ipcRenderer.invoke('save-project', data),

  // React: "getAllProjects" -> Backend: "get-projects" (Lista de inicio)
  // IMPORTANTE: Redirigimos al canal que devuelve los datos de la DB
  getAllProjects: () => ipcRenderer.invoke('get-projects'),

  // Memoria: listado de importaciones Excel
  getMemorySources: () => ipcRenderer.invoke('get-memory-sources'),

  // --- 2. IMPORTADORES ---

  // Importar al Editor (Detectar presupuesto)
  importToEditor: () => ipcRenderer.invoke('import-to-editor'),
  
  // Importar a Memoria (Gestor de memoria)
  importExcel: () => ipcRenderer.invoke('import-excel'),

  // --- 3. FUNCIONES LEGACY / COMPATIBILIDAD (MANTENIDAS) ---
  // Las dejamos aquí tal como pediste para no romper lógica antigua o futura.
  
  addCost: (item: any) => ipcRenderer.invoke('add-cost', item),
  
  // Exportar (Tu App.tsx usa ExcelJS interno, pero mantenemos el puente por si acaso)
  exportBudget: (data: any) => ipcRenderer.invoke('export-budget', data),
  
  // Alias alternativo para guardar
  saveProject: (data: any) => ipcRenderer.invoke('save-project', data),
  
  loadProject: () => ipcRenderer.invoke('load-project'),
}

// --- EXPOSICIÓN AL NAVEGADOR ---
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('budgetAPI', budgetAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.budgetAPI = budgetAPI
}
