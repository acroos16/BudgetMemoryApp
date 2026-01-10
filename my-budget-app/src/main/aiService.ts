// src/main/aiService.ts

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL_NAME = "llama3.2"; 

const BUDGETCAT_CATEGORIES = [
  "Personal",
  "Equipos",
  "Viajes",
  "Servicios Externos",
  "Costos de Oficina",
  "Otros Costos Directos"
];

export async function analyzeBudgetRows(rows: any[]) {
  const dataString = JSON.stringify(rows);
  const prompt = `
    Analiza los siguientes datos crudos de un presupuesto (array de arrays u objetos).
    Tus tareas:
    1. Detecta filas que sean ITEMS DE COSTO (ignora cabeceras, títulos, subtotales y totales).
    2. Extrae: Descripción, Categoría, Unidad, Cantidad, Costo Unitario y Total.
    3. Si hay filas de sección (p. ej. "Personal", "Actividades", etc.), úsala como categoría para los ítems debajo.
    4. Asigna la categoría más apropiada de esta lista: ${BUDGETCAT_CATEGORIES.join(", ")}.
    
    Datos: ${dataString}

    Responde ÚNICAMENTE un JSON válido con este formato:
    { "items": [{ "description": "...", "category": "...", "unit": "...", "quantity": 1, "unit_cost": 100, "total": 100 }] }
  `;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        format: "json",
        stream: false
      })
    });

    if (!response.ok) throw new Error(response.statusText);
    const json: any = await response.json();
    return JSON.parse(json.message.content).items || [];
  } catch (error) {
    console.error("Error IA:", error);
    return []; 
  }
}
