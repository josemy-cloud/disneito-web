// Carga útil INOFENSIVA: solo incrementa un contador en window. No toca red, cookies ni almacenamiento.
export const CANARIO = '<img src=x onerror="window.__CANARIO=(window.__CANARIO||0)+1">';
export const proyectoBase = () => ({
  nm: 'Proyecto de prueba', v: 2, id: 10,
  w: [{ id: 1, x1: 0, y1: 0, x2: 300, y2: 0, t: 10, h: 250 }, { id: 2, x1: 300, y1: 0, x2: 300, y2: 300, t: 10, h: 250 }],
  o: [{ id: 3, w: 1, p: 100, k: 'door', wd: 90, h: 210 }],
  i: [], cm: [], ms: [], rooms: [], rid: 1,
  rv: [{ w: 1, side: 1, x0: 0, x1: 300, y0: 0, y1: 250, pat: 'recta', tw: 30, th: 60, j: .3, jc: '#cccccc', base: '#e9e6df', fin: 'brillante' }],
});
