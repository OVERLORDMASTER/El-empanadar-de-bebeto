const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════
// DIRECTORIOS Y ALMACENAMIENTO PERSISTENTE (RENDER DISK /LOADSPRO)
// ═══════════════════════════════════════════════
const ROOT_DIR = __dirname;

// Determinar ruta del disco persistente:
// En Render / Linux se utiliza la ruta absoluta '/loadspro'.
// Si se define DATA_DIR en las variables de entorno, tendrá prioridad.
// En entornos locales donde no sea accesible /loadspro, se usa './loadspro' como fallback seguro.
function getPersistentDirectory() {
    if (process.env.DATA_DIR) {
        return process.env.DATA_DIR;
    }
    // En Linux / Render, apuntar siempre a la ruta absoluta /loadspro
    if (process.platform !== 'win32') {
        return '/loadspro';
    }
    // En Windows local, intentar usar C:\loadspro o fallback a ./loadspro
    try {
        const winPath = path.resolve('/loadspro');
        if (!fs.existsSync(winPath)) {
            fs.mkdirSync(winPath, { recursive: true });
        }
        fs.accessSync(winPath, fs.constants.W_OK);
        return winPath;
    } catch (e) {
        return path.join(ROOT_DIR, 'loadspro');
    }
}

const LOADS_DIR = getPersistentDirectory();

if (!fs.existsSync(LOADS_DIR)) {
    try {
        fs.mkdirSync(LOADS_DIR, { recursive: true });
        console.log('✅ Carpeta persistente /loadspro creada en:', LOADS_DIR);
    } catch (error) {
        console.error('❌ No se pudo crear la carpeta persistente:', error.message);
        process.exit(1);
    }
}

try {
    fs.accessSync(LOADS_DIR, fs.constants.W_OK);
    const testFile = path.join(LOADS_DIR, '.test_write');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('✅ Permisos de escritura en disco persistente (/loadspro) correctos:', LOADS_DIR);
} catch (error) {
    console.error('❌ No se tienen permisos de escritura en', LOADS_DIR);
    console.error('Verificá los permisos del disco persistente en Render.');
    process.exit(1);
}

// ═══════════════════════════════════════════════
// BASE DE DATOS PERSISTENTE (DENTRO DE /LOADSPRO)
// ═══════════════════════════════════════════════
const DB_PATH = path.join(LOADS_DIR, 'productos.db');
const OLD_ROOT_DB_PATH = path.join(ROOT_DIR, 'productos.db');
const OLD_LOCAL_LOADS_DB_PATH = path.join(ROOT_DIR, 'loadspro', 'productos.db');

// Migración automática de base de datos previa al disco persistente si no existe aún
if (!fs.existsSync(DB_PATH)) {
    const candidateDb = fs.existsSync(OLD_LOCAL_LOADS_DB_PATH)
        ? OLD_LOCAL_LOADS_DB_PATH
        : (fs.existsSync(OLD_ROOT_DB_PATH) ? OLD_ROOT_DB_PATH : null);

    if (candidateDb && path.resolve(candidateDb) !== path.resolve(DB_PATH)) {
        try {
            fs.copyFileSync(candidateDb, DB_PATH);
            console.log(`📦 Base de datos copiada exitosamente desde ${candidateDb} a ${DB_PATH}`);
            if (fs.existsSync(candidateDb + '-wal')) {
                try { fs.copyFileSync(candidateDb + '-wal', DB_PATH + '-wal'); } catch(e){}
            }
            if (fs.existsSync(candidateDb + '-shm')) {
                try { fs.copyFileSync(candidateDb + '-shm', DB_PATH + '-shm'); } catch(e){}
            }
        } catch (err) {
            console.error('⚠️ Error al migrar base de datos a /loadspro:', err.message);
        }
    }
}

// Migración de imágenes previas de la carpeta local al disco persistente si son carpetas distintas
const localLoadsDir = path.join(ROOT_DIR, 'loadspro');
if (path.resolve(localLoadsDir) !== path.resolve(LOADS_DIR) && fs.existsSync(localLoadsDir)) {
    try {
        const files = fs.readdirSync(localLoadsDir);
        for (const file of files) {
            if (file.endsWith('.db') || file.endsWith('.db-wal') || file.endsWith('.db-shm') || file.startsWith('.')) continue;
            const srcFile = path.join(localLoadsDir, file);
            const destFile = path.join(LOADS_DIR, file);
            if (!fs.existsSync(destFile) && fs.statSync(srcFile).isFile()) {
                fs.copyFileSync(srcFile, destFile);
                console.log(`🖼️ Imagen migrada a disco persistente (${LOADS_DIR}): ${file}`);
            }
        }
    } catch (e) {
        console.warn('⚠️ No se pudieron migrar imágenes locales al disco persistente:', e.message);
    }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const zlib = require('zlib');

// ═══════════════════════════════════════════════
// MIDDLEWARE Y SEGURIDAD
// ═══════════════════════════════════════════════
app.use(cors());
app.use(express.json());

// Compresión Gzip nativa para respuestas JSON y texto
app.use((req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes('gzip')) return next();

    const originalJson = res.json.bind(res);
    res.json = function (body) {
        const jsonStr = JSON.stringify(body);
        if (jsonStr.length < 512) {
            return originalJson(body);
        }
        zlib.gzip(Buffer.from(jsonStr, 'utf-8'), (err, buffer) => {
            if (err) return originalJson(body);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            res.send(buffer);
        });
    };
    next();
});

// Proteger archivos de base de datos, backups y sensibles contra descargas públicas
app.use((req, res, next) => {
    const cleanUrl = req.path.toLowerCase();
    const forbiddenExts = ['.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.sql', '.env', '.lock', '.log', '.test_write'];
    if (forbiddenExts.some(ext => cleanUrl.endsWith(ext)) || cleanUrl.includes('..') || cleanUrl.includes('/.')) {
        return res.status(403).json({ error: 'Acceso denegado a archivos protegidos' });
    }
    // Bloquear acceso a rutas /admin genéricas
    if (cleanUrl === '/admin' || cleanUrl === '/admin/' || cleanUrl === '/admin.html') {
        return res.status(404).send('Not Found');
    }
    next();
});

// Servir estáticos con políticas de caché optimizadas para velocidad
app.use(express.static(ROOT_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.match(/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i)) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    }
}));

app.use('/loadspro', express.static(LOADS_DIR, {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=604800');
    }
}));

// ─── Crear tablas si no existen ───
db.exec(`
    CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL UNIQUE,
        orden INTEGER DEFAULT 0
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        precio_usd REAL NOT NULL,
        caracteristica TEXT NOT NULL,
        imagen TEXT,
        categoria_id INTEGER,
        tipo_entrega TEXT DEFAULT 'ambos',
        FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
    )
`);

// ─── Agregar columna 'orden' si no existe en categorias ───
const tableInfoCats = db.prepare("PRAGMA table_info(categorias)").all();
if (!tableInfoCats.some(col => col.name === 'orden')) {
    db.exec('ALTER TABLE categorias ADD COLUMN orden INTEGER DEFAULT 0');
    console.log('✅ Columna "orden" agregada a categorias');
}

// ─── Agregar columna 'tipo_entrega' si no existe en productos ───
const tableInfoProds = db.prepare("PRAGMA table_info(productos)").all();
if (!tableInfoProds.some(col => col.name === 'tipo_entrega')) {
    db.exec('ALTER TABLE productos ADD COLUMN tipo_entrega TEXT DEFAULT "ambos"');
    console.log('✅ Columna "tipo_entrega" agregada a productos');
}

// ─── Agregar columna 'opciones_incluidas' si no existe en productos ───
if (!tableInfoProds.some(col => col.name === 'opciones_incluidas')) {
    db.exec('ALTER TABLE productos ADD COLUMN opciones_incluidas TEXT DEFAULT NULL');
    console.log('✅ Columna "opciones_incluidas" agregada a productos');
}

// ─── Asignar orden inicial a categorías existentes si todas tienen 0 ───
const categoriasSinOrden = db.prepare('SELECT id FROM categorias WHERE orden = 0').all();
if (categoriasSinOrden.length > 0) {
    // Asignar orden secuencial basado en el nombre actual
    const todas = db.prepare('SELECT id FROM categorias ORDER BY nombre').all();
    todas.forEach((cat, idx) => {
        db.prepare('UPDATE categorias SET orden = ? WHERE id = ?').run(idx + 1, cat.id);
    });
    console.log('✅ Órdenes iniciales asignadas a categorías');
}

// ─── Crear usuario admin inicial si no existe ───
const userCount = db.prepare('SELECT COUNT(id) as count FROM usuarios').get().count;
if (userCount === 0) {
    const defaultUser = 'admin';
    const tempPassword = crypto.randomBytes(8).toString('hex');
    const saltRounds = 10;
    bcrypt.hash(tempPassword, saltRounds, (err, hash) => {
        if (err) {
            console.error('❌ Error al hashear la contraseña inicial:', err);
        } else {
            db.prepare('INSERT INTO usuarios (username, password_hash) VALUES (?, ?)').run(defaultUser, hash);
            console.log('============================================================');
            console.log('      CREDENCIALES DE ADMINISTRADOR POR PRIMERA VEZ      ');
            console.log(`      Usuario: ${defaultUser}`);
            console.log(`      Contraseña: ${tempPassword}`);
            console.log('      Guardá esta contraseña y cambiala lo antes posible.');
            console.log('============================================================');
        }
    });
}

// ═══════════════════════════════════════════════
// MIDDLEWARES DE UTILIDAD Y CARGA DE ARCHIVOS
// ═══════════════════════════════════════════════

// Middleware para evitar caché en las respuestas de la API
const noCache = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
};

// Configuración de Multer para almacenar imágenes en la carpeta persistente LOADS_DIR
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const tipos = /jpeg|jpg|png|gif|webp/;
        const ext = tipos.test(path.extname(file.originalname).toLowerCase());
        const mime = tipos.test(file.mimetype);
        if (ext && mime) {
            cb(null, true);
        } else {
            cb(new Error('Formato no permitido. Solo: jpg, png, gif, webp'));
        }
    }
});

const uploadMiddleware = (req, res, next) => {
    upload.single('imagen')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
};

// ═══════════════════════════════════════════════
// FUNCIÓN AUXILIAR: obtener o crear categoría con orden
// ═══════════════════════════════════════════════
function obtenerOCrearCategoria(nombre) {
    if (!nombre || nombre.trim() === '') return null;
    const nombreLimpio = nombre.trim();
    // Buscar por nombre exacto
    let cat = db.prepare('SELECT id, orden FROM categorias WHERE nombre = ?').get(nombreLimpio);
    if (cat) return cat.id;
    // Crear nueva con orden = máximo + 1
    const maxOrden = db.prepare('SELECT MAX(orden) AS max FROM categorias').get().max || 0;
    const nuevoOrden = maxOrden + 1;
    const result = db.prepare('INSERT INTO categorias (nombre, orden) VALUES (?, ?)').run(nombreLimpio, nuevoOrden);
    return result.lastInsertRowid;
}

// ═══════════════════════════════════════════════
// API REST - PRODUCTOS
// ═══════════════════════════════════════════════

// Obtener productos con su categoría y ordenadas por categoría.orden
app.get('/api/productos', noCache, (req, res) => {
    const productos = db.prepare(`
        SELECT p.*, c.nombre AS categoria_nombre, c.orden AS categoria_orden
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        ORDER BY c.orden ASC NULLS LAST, p.nombre ASC
    `).all();
    res.json(productos.map(p => {
        let opciones = null;
        if (p.opciones_incluidas) {
            try {
                opciones = typeof p.opciones_incluidas === 'string' ? JSON.parse(p.opciones_incluidas) : p.opciones_incluidas;
            } catch (e) {
                opciones = p.opciones_incluidas;
            }
        }
        return {
            ...p,
            precio_usd: (p.precio_usd !== null && p.precio_usd !== undefined && p.precio_usd > 0) ? parseFloat(p.precio_usd) : 0,
            imagen: p.imagen ? `/loadspro/${p.imagen}` : null,
            opciones_incluidas: opciones
        };
    }));
});

function normalizarOpcionesStr(val) {
    if (!val) return null;
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed || trimmed === '[]' || trimmed === 'null') return null;
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.length === 0) return null;
            return JSON.stringify(parsed);
        } catch (e) {
            return trimmed;
        }
    }
    if (Array.isArray(val)) {
        return val.length > 0 ? JSON.stringify(val) : null;
    }
    return JSON.stringify(val);
}

// Crear producto
app.post('/api/productos', noCache, uploadMiddleware, (req, res) => {
    const { nombre, precio_usd, caracteristica, categoria, tipo_entrega, opciones_incluidas } = req.body;
    if (!nombre || !caracteristica) {
        return res.status(400).json({ error: 'El nombre y la característica son obligatorios' });
    }
    const precioNum = (precio_usd !== undefined && precio_usd !== '' && precio_usd !== null && !isNaN(parseFloat(precio_usd)))
        ? parseFloat(precio_usd)
        : 0;

    const imagen = req.file ? req.file.filename : null;
    const catId = obtenerOCrearCategoria(categoria);
    const entrega = tipo_entrega || 'ambos';
    const opcionesStr = normalizarOpcionesStr(opciones_incluidas);

    const stmt = db.prepare(`
        INSERT INTO productos (nombre, precio_usd, caracteristica, imagen, categoria_id, tipo_entrega, opciones_incluidas)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(nombre, precioNum, caracteristica, imagen, catId, entrega, opcionesStr);
    res.status(201).json({
        id: result.lastInsertRowid,
        nombre,
        precio_usd: precioNum,
        caracteristica,
        imagen,
        categoria_id: catId,
        tipo_entrega: entrega,
        opciones_incluidas: opcionesStr ? JSON.parse(opcionesStr) : null
    });
});

app.put('/api/productos/:id', noCache, uploadMiddleware, (req, res) => {
    const { id } = req.params;
    const { nombre, precio_usd, caracteristica, categoria, tipo_entrega, opciones_incluidas, eliminar_imagen } = req.body;
    if (!nombre || !caracteristica) {
        return res.status(400).json({ error: 'El nombre y la característica son obligatorios' });
    }
    const precioNum = (precio_usd !== undefined && precio_usd !== '' && precio_usd !== null && !isNaN(parseFloat(precio_usd)))
        ? parseFloat(precio_usd)
        : 0;

    const nuevaImagen = req.file ? req.file.filename : undefined;
    const catId = obtenerOCrearCategoria(categoria);
    const entrega = tipo_entrega || 'ambos';
    const opcionesStr = normalizarOpcionesStr(opciones_incluidas);
    const debeEliminarImagen = (eliminar_imagen === '1' || eliminar_imagen === 'true' || eliminar_imagen === true);

    if (nuevaImagen) {
        const prodAnterior = db.prepare('SELECT imagen FROM productos WHERE id=?').get(id);
        if (prodAnterior && prodAnterior.imagen) {
            const imgPath = path.join(LOADS_DIR, prodAnterior.imagen);
            if (fs.existsSync(imgPath)) {
                try { fs.unlinkSync(imgPath); } catch (e) { }
            }
        }

        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, imagen=?, categoria_id=?, tipo_entrega=?, opciones_incluidas=?
            WHERE id=?
        `).run(nombre, precioNum, caracteristica, nuevaImagen, catId, entrega, opcionesStr, id);
    } else if (debeEliminarImagen) {
        const prodAnterior = db.prepare('SELECT imagen FROM productos WHERE id=?').get(id);
        if (prodAnterior && prodAnterior.imagen) {
            const imgPath = path.join(LOADS_DIR, prodAnterior.imagen);
            if (fs.existsSync(imgPath)) {
                try { fs.unlinkSync(imgPath); } catch (e) { }
            }
        }

        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, imagen=NULL, categoria_id=?, tipo_entrega=?, opciones_incluidas=?
            WHERE id=?
        `).run(nombre, precioNum, caracteristica, catId, entrega, opcionesStr, id);
    } else {
        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, categoria_id=?, tipo_entrega=?, opciones_incluidas=?
            WHERE id=?
        `).run(nombre, precioNum, caracteristica, catId, entrega, opcionesStr, id);
    }
    res.json({ mensaje: 'Producto actualizado' });
});

// Eliminar producto
app.delete('/api/productos/:id', noCache, (req, res) => {
    const { id } = req.params;
    const prodAnterior = db.prepare('SELECT imagen FROM productos WHERE id=?').get(id);
    if (prodAnterior && prodAnterior.imagen) {
        const imgPath = path.join(LOADS_DIR, prodAnterior.imagen);
        if (fs.existsSync(imgPath)) {
            try { fs.unlinkSync(imgPath); } catch (e) { }
        }
    }
    db.prepare('DELETE FROM productos WHERE id=?').run(id);
    res.json({ mensaje: 'Producto eliminado' });
});

// ═══════════════════════════════════════════════
// API REST - CONFIGURACIÓN Y TASA
// ═══════════════════════════════════════════════

let cachedBcvRate = null;
let lastBcvFetchTime = 0;

async function obtenerTasaServidor() {
    const modoRow = db.prepare('SELECT value FROM configuracion WHERE key = ?').get('tasa_modo');
    const manualRow = db.prepare('SELECT value FROM configuracion WHERE key = ?').get('tasa_manual');
    const modo = modoRow ? modoRow.value : 'auto';
    const manualVal = manualRow && !isNaN(parseFloat(manualRow.value)) ? parseFloat(manualRow.value) : 700.00;

    if (modo === 'manual') {
        return { modo: 'manual', tasa: manualVal };
    }

    const now = Date.now();
    if (cachedBcvRate && (now - lastBcvFetchTime < 15 * 60 * 1000)) {
        return { modo: 'auto', tasa: cachedBcvRate };
    }

    try {
        const resp = await fetch('https://ve.dolarapi.com/v1/dolares/oficial', { signal: AbortSignal.timeout(4000) });
        const data = await resp.json();
        const tasa = data.promedio ?? data.tasa ?? data.rate ?? data.oficial?.precio ?? data.oficial?.promedio ?? null;
        if (typeof tasa === 'number' && tasa > 0) {
            cachedBcvRate = tasa;
            lastBcvFetchTime = now;
            return { modo: 'auto', tasa: cachedBcvRate };
        }
    } catch (e) {
        try {
            const resp2 = await fetch('https://api.bcv-api.xyz/v1/dolar', { signal: AbortSignal.timeout(4000) });
            const data2 = await resp2.json();
            const tasa2 = data2?.dolar?.promedio ?? data2?.promedio ?? data2?.tasa ?? null;
            if (typeof tasa2 === 'number' && tasa2 > 0) {
                cachedBcvRate = tasa2;
                lastBcvFetchTime = now;
                return { modo: 'auto', tasa: cachedBcvRate };
            }
        } catch (e2) { }
    }

    return { modo: 'auto', tasa: cachedBcvRate || manualVal || 775.00 };
}

// Endpoint unificado de tasa de cambio
app.get('/api/tasa', noCache, async (req, res) => {
    try {
        const resultado = await obtenerTasaServidor();
        res.json(resultado);
    } catch (e) {
        res.json({ modo: 'auto', tasa: 775.00 });
    }
});

// Obtener una configuración
app.get('/api/configuracion/:key', noCache, (req, res) => {
    const { key } = req.params;
    const row = db.prepare('SELECT value FROM configuracion WHERE key = ?').get(key);
    if (row) {
        res.json({ key, value: row.value });
    } else {
        // Devolver un valor predeterminado para 'estado_negocio' si no se encuentra
        if (key === 'estado_negocio') {
            res.json({ key, value: 'normal' });
        } else {
            res.status(404).json({ error: 'Clave de configuración no encontrada' });
        }
    }
});

// Actualizar una configuración (upsert)
app.put('/api/configuracion/:key', noCache, (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
        return res.status(400).json({ error: 'El valor es requerido' });
    }
    db.prepare('INSERT INTO configuracion (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    res.json({ success: true, message: `Configuración '${key}' actualizada a '${value}'` });
});

// ═══════════════════════════════════════════════
// API REST - CATEGORÍAS (con orden)
// ═══════════════════════════════════════════════

// Obtener categorías ordenadas por 'orden'
app.get('/api/categorias', noCache, (req, res) => {
    const categorias = db.prepare('SELECT * FROM categorias ORDER BY orden ASC, nombre ASC').all();
    res.json(categorias);
});

// Crear nueva categoría directamente
app.post('/api/categorias', noCache, (req, res) => {
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: 'El nombre de la categoría es requerido' });
    }
    const catId = obtenerOCrearCategoria(nombre.trim());
    const cat = db.prepare('SELECT * FROM categorias WHERE id = ?').get(catId);
    res.json(cat);
});

// Editar categoría (actualizar nombre)
app.put('/api/categorias/:id', noCache, (req, res) => {
    const { id } = req.params;
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: 'El nombre de la categoría es requerido' });
    }
    const nombreLimpio = nombre.trim();

    // Verificar si ya existe otra categoría con el mismo nombre
    const existente = db.prepare('SELECT id FROM categorias WHERE LOWER(nombre) = LOWER(?) AND id != ?').get(nombreLimpio, id);
    if (existente) {
        return res.status(400).json({ error: 'Ya existe otra categoría con ese nombre' });
    }

    const info = db.prepare('UPDATE categorias SET nombre = ? WHERE id = ?').run(nombreLimpio, id);
    if (info.changes === 0) {
        return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    const catActualizada = db.prepare('SELECT * FROM categorias WHERE id = ?').get(id);
    res.json(catActualizada);
});

// Eliminar categoría (los productos quedan sin categoría)
app.delete('/api/categorias/:id', noCache, (req, res) => {
    const { id } = req.params;
    db.prepare('UPDATE productos SET categoria_id = NULL WHERE categoria_id = ?').run(id);
    db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
    res.json({ mensaje: 'Categoría eliminada' });
});

// Mover categoría (intercambiar orden con la anterior o siguiente)
app.put('/api/categorias/:id/mover', noCache, (req, res) => {
    const { id } = req.params;
    const { direccion } = req.body; // 'up' o 'down'

    if (!['up', 'down'].includes(direccion)) {
        return res.status(400).json({ error: 'Dirección inválida. Use "up" o "down"' });
    }

    // Obtener la categoría actual
    const catActual = db.prepare('SELECT id, orden FROM categorias WHERE id = ?').get(id);
    if (!catActual) {
        return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    const ordenActual = catActual.orden;

    // Buscar la categoría vecina según dirección
    let vecino;
    if (direccion === 'up') {
        // Vecino con orden inmediatamente menor
        vecino = db.prepare('SELECT id, orden FROM categorias WHERE orden < ? ORDER BY orden DESC LIMIT 1').get(ordenActual);
    } else { // down
        // Vecino con orden inmediatamente mayor
        vecino = db.prepare('SELECT id, orden FROM categorias WHERE orden > ? ORDER BY orden ASC LIMIT 1').get(ordenActual);
    }

    if (!vecino) {
        return res.status(400).json({ error: 'No hay categoría para intercambiar en esa dirección' });
    }

    // Intercambiar órdenes
    const update1 = db.prepare('UPDATE categorias SET orden = ? WHERE id = ?');
    const update2 = db.prepare('UPDATE categorias SET orden = ? WHERE id = ?');

    // Usar transacción
    const trans = db.transaction(() => {
        update1.run(vecino.orden, catActual.id);
        update2.run(ordenActual, vecino.id);
    });
    trans();

    res.json({ mensaje: 'Orden actualizado correctamente' });
});

// ═══════════════════════════════════════════════
// API REST - AUTENTICACIÓN
// ═══════════════════════════════════════════════

// Login
app.post('/api/login', noCache, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña requeridos' });
    }

    const user = db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    }

    bcrypt.compare(password, user.password_hash, (err, result) => {
        if (result) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }
    });
});

// Cambiar contraseña
app.post('/api/user/change-password', noCache, (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    if (!username || !oldPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    }

    const user = db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username);
    if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    bcrypt.compare(oldPassword, user.password_hash, (err, result) => {
        if (result) {
            const saltRounds = 10;
            bcrypt.hash(newPassword, saltRounds, (err, hash) => {
                db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hash, user.id);
                res.json({ success: true, message: 'Contraseña actualizada correctamente' });
            });
        } else {
            res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta' });
        }
    });
});

// ═══════════════════════════════════════════════
// MANEJO DE ERRORES GLOBAL
// ═══════════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

// ═══════════════════════════════════════════════
// INICIO DEL SERVIDOR
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📁 Archivos estáticos web: ${ROOT_DIR}`);
    console.log(`💾 Base de datos SQLite guardada en: ${DB_PATH}`);
    console.log(`🖼️ Imágenes y archivos persistentes en: ${LOADS_DIR}`);
});