import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const budgetAPI = {
  // --- 1. CONEXIONES SQL ---
  searchCost: (query: string) => ipcRenderer.invoke('search-cost', query),
  saveProjectInternal: (data: any) => ipcRenderer.invoke('save-project', data),
  getAllProjects: () => ipcRenderer.invoke('get-projects'),
  getMemorySources: () => ipcRenderer.invoke('get-memory-sources'),

  getMemoryItems: (sourceId: string) => ipcRenderer.invoke('get-memory-items', sourceId),
  deleteMemorySource: (sourceId: string) => ipcRenderer.invoke('delete-memory-source', sourceId),
  renameMemorySource: (id: string, newName: string, type: string) => ipcRenderer.invoke('rename-memory-source', { id, newName, type }),

  // --- 2. IMPORTADORES ---
  importToEditor: () => ipcRenderer.invoke('import-to-editor'),
  importExcel: () => ipcRenderer.invoke('import-excel'),

  // 👇 ESTO ES LO QUE TE FALTABA: LA CONEXIÓN PARA LA IA
  importSmartBudget: () => ipcRenderer.invoke('import-smart-budget'),
  onImportProgress: (callback: (payload: { percent: number; message?: string }) => void) => {
    const handler = (_event: any, payload: { percent: number; message?: string }) => callback(payload);
    ipcRenderer.on('import-progress', handler);
    return () => ipcRenderer.removeListener('import-progress', handler);
  },

  // --- 3. FUNCIONES LEGACY ---
  addCost: (item: any) => ipcRenderer.invoke('add-cost', item),
  exportBudget: (data: any) => ipcRenderer.invoke('export-budget', data),
  saveProject: (data: any) => ipcRenderer.invoke('save-project', data),
  loadProject: () => ipcRenderer.invoke('load-project'),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('budgetAPI', budgetAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.budgetAPI = budgetAPI
}
