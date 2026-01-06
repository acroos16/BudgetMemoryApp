BudgetCAT (Computer-Assisted Tool) V.0.3 es una herramienta de escritorio para la formulación de presupuestos que opera bajo una estructura de base de datos relacional. A diferencia de una hoja de cálculo convencional, utiliza un motor de búsqueda que vincula cada línea del presupuesto con una memoria histórica, sugiriendo costos unitarios y categorías en tiempo real basándose en la descripción ingresada por el usuario.
La arquitectura del editor permite una organización jerárquica en tres niveles: secciones, líneas principales y sublíneas. Estas últimas funcionan mediante un sistema de cálculo en cascada: el monto total de un grupo de sublíneas se consolida automáticamente como el C*U (Costo Unitario) de su línea principal, bloqueando la edición manual de esa celda para evitar errores de consistencia.
En la cabecera, la aplicación incluye un panel de control financiero para la gestión multimoneda. Permite definir tasas de cambio para USD y EUR respecto al sol peruano (PEN). Estos valores son transversales y se guardan como metadatos del proyecto, permitiendo la conversión instantánea del presupuesto total según la moneda base seleccionada.
Además, la interfaz mantiene paneles inmovilizados (headers y nombres de secciones) para facilitar la navegación en presupuestos de gran extensión.
Finalmente, el sistema permite la alimentación masiva de memoria mediante la importación de archivos Excel externos, extrayendo descripciones y costos para enriquecer las futuras sugerencias del asistente de búsqueda.

En esta versión V0.03: 

1. Núcleo de Ingeniería Presupuestaria

Lógica de Sublíneas (Parent-Child): Implementamos la capacidad de crear sub-ítems. El costo unitario de la línea principal se bloquea automáticamente y se convierte en la suma de sus sublíneas.

Recálculo en Cascada: Cualquier cambio en la cantidad, frecuencia o costo de una sublínea dispara una actualización instantánea en el total de la sublínea, el costo unitario de la madre y el total del proyecto.

Gestión de Secciones Rígidas: Capacidad de agrupar costos por categorías (Personal, Logística, etc.) con subtotales automáticos por sección.

2. Interfaz y Experiencia de Usuario (UX/UI)

Tipografía Corporativa: Migración total a la fuente Aptos, dándole un aspecto moderno y profesional de Microsoft Office.

Diseño de Tabla de Alto Rendimiento: Implementación de table-layout: fixed para evitar que las columnas se deformen, asegurando que la descripción siempre tenga espacio suficiente.

Componente Auto-Expanding: Las celdas de texto crecen verticalmente según el contenido, eliminando espacios vacíos innecesarios y permitiendo ver descripciones largas sin cortes.

Inmovilización de Paneles: Cabecera de tabla y nombres de secciones fijos al hacer scroll para no perder nunca el contexto de las columnas.

3. Inteligencia y Memoria (CAT - Computer Aided Tool)

Búsqueda en Tiempo Real: Mientras escribes en la descripción, el sistema consulta la base de datos histórica y muestra sugerencias en el panel lateral.

Carga con un Click: Función para "inyectar" datos históricos (Categoría, Unidad, Costo) directamente en la línea activa, ahorrando minutos de digitación.

Filtrado por Relevancia: El panel lateral de memoria solo muestra información útil basada en lo que estás presupuestando en ese momento.

4. Multidivisa y Finanzas

Gestión de Tasas de Cambio: Incorporación de campos editables en la cabecera para fijar el cambio de USD y EUR respecto al sol peruano (PEN).

Selector de Moneda Base: Capacidad de cambiar la moneda del proyecto en cualquier momento desde la barra de herramientas.

Formato Contable: Implementación de un formateador de números (fmt) que asegura que todos los montos muestren siempre dos decimales y separadores de miles.

5. Gestión de Archivos y Persistencia

Alimentación de Memoria: Botón dedicado para importar Excels antiguos y "enseñar" a la base de datos nuevos costos.

Dashboard de Proyectos: Pantalla de inicio con listado de proyectos recientes para una navegación rápida.

Persistencia JSON: Los proyectos se guardan con toda su estructura compleja (incluyendo la jerarquía de sublíneas) y metadatos del donante.

Exportación Limpia: Función para convertir el presupuesto dinámico en un formato listo para reportar o enviar.

6. Robustez del Sistema

Prevención de Errores: Bloqueo de celdas que dependen de fórmulas para evitar que el usuario sobrescriba cálculos automáticos.

Generación de IDs Únicos: Sistema de identificación por hash para asegurar que ninguna línea o sección se confunda con otra durante el guardado.

Estado Visual Dinámico: Resaltado de la fila activa (activeRowId) para que el usuario siempre sepa qué está editando.
