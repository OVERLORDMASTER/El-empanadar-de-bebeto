const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════
// DIRECTORIOS
// ═══════════════════════════════════════════════
const ROOT_DIR = __dirname;
const LOADS_DIR = path.join(ROOT_DIR, 'loadspro');

if (!fs.existsSync(LOADS_DIR)) {
    try {
        fs.mkdirSync(LOADS_DIR, { recursive: true });
        console.log('✅ Carpeta loadspro creada en:', LOADS_DIR);
    } catch (error) {
        console.error('❌ No se pudo crear la carpeta loadspro:', error.message);
        process.exit(1);
    }
}

try {
    fs.accessSync(LOADS_DIR, fs.constants.W_OK);
    const testFile = path.join(LOADS_DIR, '.test_write');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('✅ Permisos de escritura en loadspro correctos');
} catch (error) {
    console.error('❌ No se tienen permisos de escritura en', LOADS_DIR);
    console.error('Ejecutá el servidor con permisos adecuados o cambiá los permisos de la carpeta.');
    process.exit(1);
}

// ═══════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.static(ROOT_DIR));
app.use('/loadspro', express.static(LOADS_DIR));

// ═══════════════════════════════════════════════
// MULTER (SUBIDA DE IMÁGENES)
// ═══════════════════════════════════════════════
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
// BASE DE DATOS
// ═══════════════════════════════════════════════
const db = new Database(path.join(ROOT_DIR, 'productos.db'));
db.pragma('journal_mode = WAL');

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
app.get('/api/productos', (req, res) => {
    const productos = db.prepare(`
        SELECT p.*, c.nombre AS categoria_nombre, c.orden AS categoria_orden
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        ORDER BY c.orden ASC NULLS LAST, p.nombre ASC
    `).all();
    res.json(productos.map(p => ({
        ...p,
        imagen: p.imagen ? `/loadspro/${p.imagen}` : null
    })));
});

// Crear producto
app.post('/api/productos', uploadMiddleware, (req, res) => {
    const { nombre, precio_usd, caracteristica, categoria, tipo_entrega } = req.body;
    if (!nombre || !precio_usd || !caracteristica) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    const imagen = req.file ? req.file.filename : null;
    const catId = obtenerOCrearCategoria(categoria);
    const entrega = tipo_entrega || 'ambos';

    const stmt = db.prepare(`
        INSERT INTO productos (nombre, precio_usd, caracteristica, imagen, categoria_id, tipo_entrega)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(nombre, precio_usd, caracteristica, imagen, catId, entrega);
    res.status(201).json({ 
        id: result.lastInsertRowid, 
        nombre, 
        precio_usd, 
        caracteristica, 
        imagen, 
        categoria_id: catId,
        tipo_entrega: entrega
    });
});

// Actualizar producto
app.put('/api/productos/:id', uploadMiddleware, (req, res) => {
    const { id } = req.params;
    const { nombre, precio_usd, caracteristica, categoria, tipo_entrega } = req.body;
    const nuevaImagen = req.file ? req.file.filename : undefined;
    const catId = obtenerOCrearCategoria(categoria);
    const entrega = tipo_entrega || 'ambos';

    if (nuevaImagen) {
        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, imagen=?, categoria_id=?, tipo_entrega=?
            WHERE id=?
        `).run(nombre, precio_usd, caracteristica, nuevaImagen, catId, entrega, id);
    } else {
        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, categoria_id=?, tipo_entrega=?
            WHERE id=?
        `).run(nombre, precio_usd, caracteristica, catId, entrega, id);
    }
    res.json({ mensaje: 'Producto actualizado' });
});

// Eliminar producto
app.delete('/api/productos/:id', (req, res) => {
    db.prepare('DELETE FROM productos WHERE id=?').run(req.params.id);
    res.json({ mensaje: 'Producto eliminado' });
});

// ═══════════════════════════════════════════════
// API REST - CATEGORÍAS (con orden)
// ═══════════════════════════════════════════════

// Obtener categorías ordenadas por 'orden'
app.get('/api/categorias', (req, res) => {
    const categorias = db.prepare('SELECT * FROM categorias ORDER BY orden ASC, nombre ASC').all();
    res.json(categorias);
});

// Eliminar categoría (los productos quedan sin categoría)
app.delete('/api/categorias/:id', (req, res) => {
    const { id } = req.params;
    db.prepare('UPDATE productos SET categoria_id = NULL WHERE categoria_id = ?').run(id);
    db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
    res.json({ mensaje: 'Categoría eliminada' });
});

// Mover categoría (intercambiar orden con la anterior o siguiente)
app.put('/api/categorias/:id/mover', (req, res) => {
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
    console.log(`📁 Archivos estáticos: ${ROOT_DIR}`);
    console.log(`🖼️ Imágenes guardadas en: ${LOADS_DIR}`);
});