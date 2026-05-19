const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const ZONA = 'America/Argentina/Buenos_Aires';

function ahoraBA() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: ZONA }));
}

function fechaHoy() {
  const d = ahoraBA();
  return d.toISOString().slice(0, 10);
}

function getLunesDeSemana(fecha) {
  const d = new Date(fecha);
  const dia = d.getDay();
  const diff = dia === 0 ? -6 : 1 - dia;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ── Endpoints existentes ───────────────────────────────────

async function getEstado() {
  const hoy = fechaHoy();
  const ahora = ahoraBA();

  const snap = await db.collection('presencias')
    .where('fecha', '==', hoy)
    .where('activo', '==', true)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  let abierto = false;
  let horaCierre = null;

  if (!snap.empty) {
    const doc = snap.docs[0].data();
    const [hh, mm] = doc.hora_salida.split(':').map(Number);
    const salida = new Date(ahora);
    salida.setHours(hh, mm, 0, 0);
    abierto = salida > ahora;
    if (abierto) horaCierre = doc.hora_salida;
  }

  const schedule = await getScheduleHoy();
  return { abierto, horaCierre, schedule };
}

async function getScheduleHoy() {
  const ahora = ahoraBA();
  const lunes = getLunesDeSemana(ahora);
  const diaHoy = ahora.getDay();

  const snap = await db.collection('schedule')
    .where('semana', '==', lunes)
    .where('dia', '==', diaHoy)
    .where('activo', '==', true)
    .get();

  return snap.docs.map(d => d.data().franja);
}

async function registrar(params) {
  if (!params.hora_salida) return { ok: false, error: 'Falta hora de salida' };
  const ahora = ahoraBA();
  const hoy = fechaHoy();

  await db.collection('presencias').add({
    timestamp: ahora.toISOString(),
    nombre: params.nombre || 'Custodio',
    hora_salida: params.hora_salida,
    activo: true,
    fecha: hoy,
  });

  return { ok: true, mensaje: 'Presencia registrada hasta las ' + params.hora_salida };
}

async function modificar(params) {
  if (!params.hora_salida) return { ok: false, error: 'Falta hora de salida' };
  const hoy = fechaHoy();

  const snap = await db.collection('presencias')
    .where('fecha', '==', hoy)
    .where('activo', '==', true)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (snap.empty) return { ok: false, error: 'No se encontró registro para modificar' };

  await snap.docs[0].ref.update({ hora_salida: params.hora_salida });
  return { ok: true, mensaje: 'Horario modificado a las ' + params.hora_salida };
}

async function getSchedule(params) {
  const semana = params.semana || getLunesDeSemana(ahoraBA());
  const snap = await db.collection('schedule').where('semana', '==', semana).get();

  const grilla = {};
  for (let d = 0; d <= 6; d++) grilla[d] = {};

  snap.forEach(doc => {
    const data = doc.data();
    grilla[data.dia][data.franja] = data.activo;
  });

  return { ok: true, semana, grilla };
}

async function saveSchedule(params) {
  let grilla, semana;
  try {
    grilla = JSON.parse(params.grilla);
    semana = params.semana;
  } catch (e) {
    return { ok: false, error: 'Datos inválidos' };
  }

  const snap = await db.collection('schedule').where('semana', '==', semana).get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  const batch2 = db.batch();
  for (let dia = 0; dia <= 6; dia++) {
    const franjas = grilla[dia] || {};
    for (const franja in franjas) {
      if (franjas[franja]) {
        const ref = db.collection('schedule').doc();
        batch2.set(ref, { dia: parseInt(dia), franja, activo: true, semana });
      }
    }
  }
  await batch2.commit();
  return { ok: true, mensaje: 'Schedule guardado' };
}

// ── Endpoints nuevos: Misas semanales ─────────────────────

async function getMisasSemanal(params) {
  const semana = params.semana || getLunesDeSemana(ahoraBA());
  const snap = await db.collection('misas_semanal').where('semana', '==', semana).get();

  const grilla = {};
  for (let d = 0; d <= 6; d++) grilla[d] = {};

  snap.forEach(doc => {
    const data = doc.data();
    if (!grilla[data.dia]) grilla[data.dia] = {};
    grilla[data.dia][data.franja] = true;
  });

  return { ok: true, semana, grilla };
}

async function saveMisasSemanal(params) {
  let grilla, semana;
  try {
    grilla = JSON.parse(params.grilla);
    semana = params.semana;
  } catch (e) {
    return { ok: false, error: 'Datos inválidos' };
  }

  // Borrar semana existente
  const snap = await db.collection('misas_semanal').where('semana', '==', semana).get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  // Guardar nuevas franjas
  const batch2 = db.batch();
  for (let dia = 0; dia <= 6; dia++) {
    const franjas = grilla[dia] || {};
    for (const franja in franjas) {
      if (franjas[franja]) {
        const ref = db.collection('misas_semanal').doc();
        batch2.set(ref, { dia: parseInt(dia), franja, semana });
      }
    }
  }
  await batch2.commit();
  return { ok: true, mensaje: 'Misas semanales guardadas' };
}

// ── Endpoints nuevos: Misas mensuales ─────────────────────

async function getMisasMensual(params) {
  // params.mes formato 'aaaa-mm'
  const mes = params.mes;
  if (!mes) return { ok: false, error: 'Falta parámetro mes' };

  const snap = await db.collection('misas_mensual').where('mes', '==', mes).get();

  const grilla = {};
  for (let d = 1; d <= 31; d++) grilla[d] = {};

  snap.forEach(doc => {
    const data = doc.data();
    if (!grilla[data.dia]) grilla[data.dia] = {};
    grilla[data.dia][data.franja] = true;
  });

  return { ok: true, mes, grilla };
}

async function saveMisasMensual(params) {
  let grilla, mes;
  try {
    grilla = JSON.parse(params.grilla);
    mes = params.mes; // 'aaaa-mm'
  } catch (e) {
    return { ok: false, error: 'Datos inválidos' };
  }

  if (!mes) return { ok: false, error: 'Falta parámetro mes' };

  // Borrar mes existente
  const snap = await db.collection('misas_mensual').where('mes', '==', mes).get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  // Guardar nuevas franjas (solo días que existen en ese mes)
  const [anio, mesNum] = mes.split('-').map(Number);
  const maxDias = new Date(anio, mesNum, 0).getDate();

  const batch2 = db.batch();
  for (let dia = 1; dia <= 31; dia++) {
    if (dia > maxDias) continue; // omitir días inexistentes
    const franjas = grilla[dia] || {};
    for (const franja in franjas) {
      if (franjas[franja]) {
        const ref = db.collection('misas_mensual').doc();
        batch2.set(ref, { dia: parseInt(dia), franja, mes });
      }
    }
  }
  await batch2.commit();
  return { ok: true, mensaje: 'Misas mensuales guardadas' };
}

// ── Router ─────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  let result;

  try {
    if      (action === 'estado')            result = await getEstado();
    else if (action === 'registrar')         result = await registrar(req.query);
    else if (action === 'modificar')         result = await modificar(req.query);
    else if (action === 'getSchedule')       result = await getSchedule(req.query);
    else if (action === 'saveSchedule')      result = await saveSchedule(req.query);
    else if (action === 'getMisasSemanal')   result = await getMisasSemanal(req.query);
    else if (action === 'saveMisasSemanal')  result = await saveMisasSemanal(req.query);
    else if (action === 'getMisasMensual')   result = await getMisasMensual(req.query);
    else if (action === 'saveMisasMensual')  result = await saveMisasMensual(req.query);
    else result = { error: 'Acción no reconocida' };
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  res.status(200).json(result);
};
